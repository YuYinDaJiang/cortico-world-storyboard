# Changelog

## 0.9.0 — 2026-11-03

- 改名：coopanion-video-storyboard → cortico-world-storyboard（coopanion- 是应用前缀，扩展按 cortico-world-* 约定）。功能与 0.8.12 相同，无行为变更。
- 旧包 coopanion-video-storyboard 已 deprecate，改用本包。

## 0.8.12 — 2026-11-03

- 安全：清理旧版遗留的 cookies 文件（旧版曾把**全域名** cookie 明文写到 ~/.dsh/bili-cookies-from-browser.txt，新版启动时自动删除）。
- **升级提示（0.8.11 及更早）**：旧版会把**全域名** cookie 明文写到 %USERPROFILE%\.dsh\bili-cookies-from-browser.txt。升级后新版启动会自动删除。**旧版每次取字幕/调试都会重新写一次**，所以手动删只算临时措施、删了还会再有——建议直接升级。
- 安全：浏览器 cookie 只取 bilibili.com 域，且写入扩展数据目录、用完即删（不再写 ~/.dsh）。
- 安全：whisper 运行时 zip 下载后校验 sha256（与 OCR wheel 同一模式）。
- 移除未使用的 launchBrowser（会注册 Windows 计划任务）。
- cortico.tags 改为词表内的 ideo / external-setup / high-cost（isual 不在词表里）。
- README 明确「包本身不自动安装可执行文件；一键安装才会按需下载并校验」。

## 0.8.11 — 2026-11-02

- 修复：prefetch 下载没带 cookies，登录片会退化成匿名请求（对齐上游 PR #56）。

## 0.8.10 — 2026-11-02

### 硬字幕 OCR：能用了

- **自适应对齐**：新增 `detectAlignMode()`。转写是中文时走拼音对齐（原逻辑）；日语/英语/音乐等
  非中文转写降级为**时间对齐**，不再因为拼音对不上把 OCR 结果整批丢掉。回执标注 `align=pinyin|time`。
- **`subtitles:"ocr"`（默认）**：只 OCR 本次分镜实际取到的帧（含积分取样帧），零额外扫描。
- **`subtitles:"ocr-dense"` + `ocrStep`**：按 step 秒（0.25–5，默认 1）独立扫描字幕带，整集出台词用。
- 两种模式输出统一为 `{from, to, text, conf}`；回执写明模式、帧数、读到行数、合并句数。
- **格子去重**：OCR 抽出的每句只归到"中点所在"的那一格，跨界句给重叠最大的格子，其他格不再重复列。
- **截断句二次归并**：同一句被截成两段（一帧只读到半句）且时间相邻 ≤1.5s 时合并成较长的那句。
- **长窗口可用**：抽帧改成分批（每批 40 张）调用 OCR，避免一次上千张把 python 撑爆/超时；超上限记 capped 并提示截断。
- 抽取失败不再只打 ?：回执写明 status / eason / 扫到多少帧，并说明**台词回退到了 ASR**（不是 ocr-subs）。
- 统计新增 `multiline`（同帧读到多行字幕的帧数）、`merged`（二次归并次数）、`sparse`（读到字幕的帧不足一半 → 回执提示需要更密采样）。

### 修复

- `checked` 状态不再被渲染成「OCR 未就绪」；回执带上 `crops / usable` 诊断，区分「没引擎」与「对不上 ASR」。
- OCR 对 `transcriptFile` 也生效（原来只在 ASR 转写时跑）。
- `subtitles:"ocr"` 抽取块改用 `built.segs` 并包 `try/catch`，杜绝 TDZ 崩整个分镜。

### 界面

- 打开「服务」面板时**自动体检**一次（媒体工具 + OCR），不再只显示上次缓存的结果。
- 体检表新增 `Python` / `OCR` 两行，判据 Python 3.11–3.13，缺什么写什么。

## 0.8.9

- 服务面板打开时自动体检（见上）。

## 0.8.8

- npm 首次发布版本（与 0.8.9 同源，OCR 相关改动之前）。
