<#
把工程目录同步到 Coopanion 的扩展目录。

只同步四样：src/、dist/、describe.json、package.json。
node_modules / data / README / scripts 一概不碰（也不会删它们）。
src 与 dist 是**镜像**语义：目标里多出来的文件会被删掉，并在结尾报数量。

用法（项目根）：
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync-to-extension.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync-to-extension.ps1 -Target "D:\somewhere\cortico-world-storyboard"
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync-to-extension.ps1 -DryRun

退出码：0 = 同步后逐文件 SHA-256 一致；2 = 仍有差异；1 = 前置条件不满足。
#>
[CmdletBinding()]
param(
  [string]$Source = '',
  [string]$Target = (Join-Path $env:LOCALAPPDATA 'Programs\Coopanion\data\extensions\node_modules\cortico-world-storyboard'),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# PS 5.1 在 param 默认值里拿不到 $PSScriptRoot，所以进函数体之后再补
if (-not $Source) { $Source = Split-Path -Parent $PSScriptRoot }
$ITEM_DIRS = @('src', 'dist')
$ITEM_FILES = @('describe.json', 'package.json')

function Fail([string]$message) {
  Write-Host "FAIL  $message" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path -LiteralPath $Source)) { Fail "源目录不存在：$Source" }
$sourceItem = Get-Item -LiteralPath $Source
Write-Host "source: $($sourceItem.FullName)"
Write-Host "target: $Target"
if ($DryRun) { Write-Host "mode  : dry run（只比较，不写）" -ForegroundColor Yellow }

if (-not (Test-Path -LiteralPath $Target)) {
  Fail "目标目录不存在：$Target`n（先装一次扩展，或用 -Target 指到正确位置）"
}
$targetItem = Get-Item -LiteralPath $Target
if ($targetItem.LinkType -eq 'Junction' -or $targetItem.LinkType -eq 'SymbolicLink') {
  Fail "目标是个 $($targetItem.LinkType)，指向 $($targetItem.Target -join ',')。`n向链接里写等于写回源目录；先把链接换成实体目录再同步。"
}

# ---- 收集源端文件（相对路径）
$wanted = New-Object System.Collections.Generic.List[string]
foreach ($dir in $ITEM_DIRS) {
  $full = Join-Path $Source $dir
  if (-not (Test-Path -LiteralPath $full)) { Fail "源里没有 $dir/" }
  Get-ChildItem -LiteralPath $full -Recurse -File | ForEach-Object {
    $wanted.Add($_.FullName.Substring($Source.Length + 1))
  }
}
foreach ($file in $ITEM_FILES) {
  if (-not (Test-Path -LiteralPath (Join-Path $Source $file))) { Fail "源里没有 $file" }
  $wanted.Add($file)
}

function HashOf([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
}

# ---- 复制 / 更新
$copied = 0; $updated = 0; $added = 0; $same = 0
foreach ($rel in $wanted) {
  $from = Join-Path $Source $rel
  $to = Join-Path $Target $rel
  $srcHash = HashOf $from
  $dstHash = HashOf $to
  if ($dstHash -eq $srcHash) { $same++; continue }
  if ($dstHash -ne $null) { $updated++ } else { $added++ }
  $copied++
  if ($DryRun) { continue }
  $parent = Split-Path -Parent $to
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Copy-Item -LiteralPath $from -Destination $to -Force
}

# ---- 删除目标里多出来的（只在这四样的范围内）
$wantSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($rel in $wanted) { [void]$wantSet.Add($rel) }
$removed = New-Object System.Collections.Generic.List[string]
foreach ($dir in $ITEM_DIRS) {
  $full = Join-Path $Target $dir
  if (-not (Test-Path -LiteralPath $full)) { continue }
  Get-ChildItem -LiteralPath $full -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($Target.Length + 1)
    if (-not $wantSet.Contains($rel)) {
      $removed.Add($rel)
      if (-not $DryRun) { Remove-Item -LiteralPath $_.FullName -Force }
    }
  }
}
if (-not $DryRun) {
  # 顺手清掉因删除而空掉的目录（只往下两层，src/dist 本身留着）
  foreach ($dir in $ITEM_DIRS) {
    Get-ChildItem -LiteralPath (Join-Path $Target $dir) -Recurse -Directory -ErrorAction SilentlyContinue |
      Sort-Object { $_.FullName.Length } -Descending |
      ForEach-Object {
        if (-not (Get-ChildItem -LiteralPath $_.FullName -Force | Select-Object -First 1)) {
          Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
        }
      }
  }
}

Write-Host ''
Write-Host "copied : $copied 个（新增 $added / 更新 $updated / 未变 $same）"
Write-Host "deleted: $($removed.Count) 个"
foreach ($rel in $removed) { Write-Host "         - $rel" -ForegroundColor DarkYellow }

# ---- 全量 SHA-256 比对
$diffs = New-Object System.Collections.Generic.List[string]
foreach ($rel in $wanted) {
  $a = HashOf (Join-Path $Source $rel)
  $b = HashOf (Join-Path $Target $rel)
  if ($a -ne $b) { $diffs.Add($rel) }
}
$checked = $wanted.Count
Write-Host ''
Write-Host "verify : 源与目标逐文件 SHA-256 全比对，$checked 个文件，$($diffs.Count) 处不同"
foreach ($rel in $diffs) { Write-Host "         ! $rel" -ForegroundColor Red }

if ($diffs.Count -gt 0) { exit 2 }
if ($DryRun) { Write-Host 'dry run：没有写入任何文件。' -ForegroundColor Yellow }
exit 0
