# cookie 处理与「不落盘」评估

本文记录 issue #1（Phantivia 安全审查）相关的 cookie 处理方式，以及为什么没有改成完全不落盘。
以后有人再问「能不能不写文件」时，先看这里。

## 现在的链路

1. `browser-time.js` 的 `readBrowserCookies()` 通过 CDP 的 `Storage.getCookies` 取 cookie
   —— 这个接口是**浏览器级**的，会带回所有站点。
   → **只保留 `bilibili.com`（含子域）**，其余在返回前就丢弃。
2. `writeBrowserCookiesFile()` 把结果写成 Netscape 格式，落在
   `<dataDir>/tmp/bili-cookies-from-browser.txt`（<dataDir> 由 World 注入，实际是
   `…\Coopanion\data\home\companion\data\storyboard\tmp`），**不再写 `~/.dsh`**。
3. `subtitles.js` 的「自愈」分支用它重试一次取字幕，**写入 → 使用 → 删除整段包在
   `try/finally` 里**：异常、提前 return、`fetchOnce` 抛错都会删。
4. World 每次启动会检查两处残骸并删除：
   - `~/.dsh/bili-cookies-from-browser.txt`（旧版遗留）
   - `<dataDir>/tmp/bili-cookies-from-browser.txt`（进程被杀留下的）

文件在磁盘上的窗口 ≈ 一次 yt-dlp 取字幕的时间（实测通常 1–10 秒），内容只含 B 站 cookie。

## 为什么没有改成「完全不落盘」

目标是让 yt-dlp 拿到 cookie。它的接口只接受**文件路径**（`--cookies FILE`）或
`--cookies-from-browser BROWSER`，**没有 stdin 通道**。现实可选项只有三个：

| 方案 | 可行性 | 结论 |
|---|---|---|
| 写临时文件 + finally 删除（当前） | ✅ 已验证可用 | 采用；窗口 1–10 秒，且启动会扫残骸 |
| `--add-header "Cookie: …"` | yt-dlp 支持 | **不采用**：cookie 会进入进程命令行，`tasklist /v`、WMI、部分 EDR 日志都能读到，同机其他用户也可读；暴露面比数据目录下的临时文件**更大** |
| `--cookies-from-browser` 直读浏览器库 | 理论可行 | **不采用**：我们用的是 CDP 端口方案（浏览器可能正在运行、cookie 库被锁），且 B 站字幕接口对该路径未做验证；属于功能重写，风险高于收益 |

另外命名管道（named pipe）在 Windows 上不是 yt-dlp 认可的 cookie 路径，也无法作为 `--cookies` 的输入。

## 如果将来要彻底不落盘

需要满足其一：

1. yt-dlp 支持从 stdin / 文件描述符读 cookies（上游能力，非本仓库可控）
2. 改用 `--cookies-from-browser` 且验证 B 站字幕接口在此模式下可用
3. 自己实现字幕请求（不走 yt-dlp），在内存里带 Cookie 头 —— 相当于重写取字幕那一段

在此之前，**「临时文件 + finally 删除 + 启动扫残骸」是当前约束下最稳的组合**。

## 卸载 Coopanion 时会怎样

查证结果（2026-11-03，本机）：

- 注册表卸载项：`UninstallString = "C:\Users\…\Programs\Coopanion\Uninstall Coopanion.exe" /currentuser`
  → electron-builder 的 NSIS 卸载器
- 用户数据全部在**安装目录内部**：`…\Programs\Coopanion\data`（本机 16.45 GB），
  不存在 `%APPDATA%\Coopanion` 这一路
- 卸载器本体只有 0.15 MB（NSIS 脚本压缩存储），直接扫二进制拿不到 `RMDir /r $INSTDIR` 之类的证据

**结论**：数据目录位于 `$INSTDIR` 内，而 electron-builder 的 NSIS 卸载器默认删除安装目录，
所以**卸载大概率会连 `data` 一起删掉**（包括本扩展的 `tmp`）。这一条**没有实测过真实卸载**
（不会为了验证去卸载一次），按“高概率”记录，不当作已证实的结论。

**兜底（已实现，不依赖卸载器）：**

- World `stop()` 时删除自己的 `<dataDir>/tmp/bili-cookies-from-browser.txt`
- World `start()` 时再扫一遍 `~/.dsh` 与 `<dataDir>/tmp` 两处残骸
- 若卸载后数据目录被保留（例如手工删程序没删 `data`），请顺手删掉 `<dataDir>\tmp`

