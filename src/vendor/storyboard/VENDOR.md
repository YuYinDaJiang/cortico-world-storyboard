# vendored: dsh-video-storyboard

这里是从 <https://github.com/SAOS-3624/dsh-video-storyboard>（Apache-2.0）原样搬进来的算法层。
`LICENSE` / `NOTICE` 随包保留。

- 上游版本：0.6.0（`src/storyboard/` 的 36 个文件，按 `pipeline.js` 的 import 闭包挑选）
- 搬进来的原因：World 要求零运行时依赖，不能把上游包写成 `dependencies`
- 没有搬：`src/tools/`（那是 DSH 的 defineTool 胶水）、`src/ocr_bridge.py`、CLI

## 唯一的改动：落点

上游把缓存放 `%LOCALAPPDATA%`、临时文件放系统 temp。装进 World 之后这两样都必须落在 World 自己的
数据目录里（管理页要能看见、能清空），所以只改了四处：

| 文件 | 改动 |
|---|---|
| `world-paths.js` | 新增：注入 cache / temp / media 三个根 |
| `cache.js` | `cacheDir()` 先看注入的根 |
| `subtitles.js` / `ocr-subs.js` | `mkdtemp(join(tmpdir(), …))` → `mkdtemp(join(storyboardTempRoot(), …))` |
| `media-store.js` | `mediaDir()` 与磁盘余量检查改用注入的根 |
| `ytdlp.js` | `runProcess()` 给子进程设 `TMP`/`TEMP` 指向注入的根 |
| `pipeline.js` | 音频分析按 (文件, 窗口) 走缓存；命中记在 `result.audioCached` |

最后一条是踩出来的：yt-dlp 是 PyInstaller 单文件包，启动时把自己解压到 `%TEMP%`；
这台机器的 `%TEMP%` 下它建不出目录，直接报 `Could not create temporary directory`。
指到 World 自己的 tmp 之后正常（顺带满足「临时文件不外散」）。

其余模块（`cells.js`、`memory.js`、`transcript-cache.js`、`storage.js`）都走 `cacheDir()`，自动跟随。
改动处都带 `[World 改动]` 注释，`git`/`diff` 时一眼能找出来。

## 升级上游时

1. 重新按 `pipeline.js` 的 import 闭包复制文件；
2. 重做上表四处改动（`grep -rn "tmpdir\|LOCALAPPDATA"` 应只剩注释）；
3. 跑 `node scripts/check.mjs` 与 `node tools/e2e-storyboard.mjs`（在 DSH 工作区里）。
