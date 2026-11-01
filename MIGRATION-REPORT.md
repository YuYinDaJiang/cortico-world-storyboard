# 扩展目录迁移报告（方案 B）

- 执行时间：2026-11-02 00:47（app 退出后立即执行）
- 结果：**成功**
- 旧工作区目录：`D:\deepflash\worlds\cortico-world-storyboard` → 已改名为 `…\cortico-world-storyboard.bak-20261102`（保留作回滚，未删）
- 新工作区目录：`D:\deepflash\worlds\coopanion-video-storyboard`（含 `.git`，提交历史原样）
- 旧扩展目录：`…\data\extensions\node_modules\cortico-world-storyboard`（**保留，未删**）
- 新扩展目录：`…\data\extensions\node_modules\coopanion-video-storyboard`（99 个文件，无 `.git`）
- 备份：`…\data\extensions\package.json.bak-20261102`（2,045 B）

## 做了什么

| # | 动作 | 结果 |
|---|---|---|
| 1 | 轮询 `Coopanion` 进程直到全部退出 | 0 秒即退出（7 个进程已由本人关掉） |
| 2 | 备份 `extensions\package.json` | `package.json.bak-20261102` |
| 3 | `robocopy` 复制源目录到新目录（含 `.git`） | 252 个文件 |
| 4 | 校验新目录 git | `commits=4`、`head=fe87bae`、log 里能找到 `fe87bae` |
| 5 | 改 `extensions\package.json` 依赖键 | `"coopanion-video-storyboard": "link:D:/deepflash/worlds/coopanion-video-storyboard"` |
| 6 | 复制新目录 → `node_modules\coopanion-video-storyboard`（排除 `.git`） | 99 个文件 |
| 7 | 改 `scripts/sync-to-extension.ps1` 默认 Target + 注释示例（带 BOM） | 已提交 `9f6fc8c` |
| 8 | 旧工作区目录改名 `.bak-20261102` | 保留回滚 |

## 验证结果

```
package.json 有效   name=coopanion-video-storyboard  main=./src/index.js
loader 目标文件     …\node_modules\coopanion-video-storyboard\src\index.js  存在
git（新目录）       commits=6  head=b444caa  status=clean
scripts/check.mjs   全部通过（ok 14，warn 0）
依赖键              "coopanion-video-storyboard": "link:D:/deepflash/worlds/coopanion-video-storyboard"
```

新目录比原历史多两个提交：`9f6fc8c`（同步脚本默认 Target 改名）和本报告。它们都是迁移本身需要的，不动历史。

## 过程中出过的一次失败（已修复）

脚本最后一步用 PowerShell 5.1 的 `Get-Content -Raw | ConvertFrom-Json` 读 `package.json` 时报
`Invalid object passed in, ':' or '}' expected`。原因是 PS 5.1 把**无 BOM 的 UTF-8 当 ANSI 读**，
中文变乱码后 JSON 解析失败；**文件本身没有问题**。改用 `node -e require(...)` 复核：
`name`/`main` 正确、loader 目标存在。脚本因此提前 `exit 1` 并把报告标成“失败”，本文件已按实际结果更正。

## 重启后要做

1. 启动 Coopanion → 设置窗口 → World：「分镜」能打开，即说明依赖键与目录名对上了。
2. 验证通过后再清理旧东西（**现在都还留着**）：
   ```powershell
   Remove-Item "C:\Users\Administrator\AppData\Local\Programs\Coopanion\data\extensions\node_modules\cortico-world-storyboard" -Recurse -Force
   Remove-Item "D:\deepflash\worlds\cortico-world-storyboard.bak-20261102" -Recurse -Force
   ```
3. 同步命令默认写到新目录：
   ```powershell
   cd D:\deepflash\worlds\coopanion-video-storyboard
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync-to-extension.ps1 -DryRun
   ```

## 回滚（30 秒）

```powershell
Copy-Item "C:\Users\Administrator\AppData\Local\Programs\Coopanion\data\extensions\package.json.bak-20261102" `
          "C:\Users\Administrator\AppData\Local\Programs\Coopanion\data\extensions\package.json" -Force
Remove-Item "C:\Users\Administrator\AppData\Local\Programs\Coopanion\data\extensions\node_modules\coopanion-video-storyboard" -Recurse -Force
# 旧 node_modules 与旧源目录（.bak-20261102）都还在，改名回去即可
```

## 不受影响的东西

- World id 仍是 `storyboard`：`worlds.storyboard` 配置、`state.json`、数据目录 `…\data\storyboard` 全部不变
- git 远端仍是 `https://github.com/YuYinDaJiang/coopanion-video-storyboard.git`，不需要 reinit
- `D:\deepflash\ocr-venv`（旧 OCR venv）未动；新 venv 在数据目录 `…\data\storyboard\ocr\venv`

## 必须重启才生效

- 依赖键 + 目录名：app 只在启动时解析 `extensions/package.json`
- 同步脚本的默认 Target：只影响下一次 `npm run sync`，重启非必须（但迁移后第一次同步要用新目录跑）
