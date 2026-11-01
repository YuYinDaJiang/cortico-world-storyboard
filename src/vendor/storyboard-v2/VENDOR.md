# vendored: feature/high-performance（V2 引擎）

上游 <https://github.com/SAOS-3624/dsh-video-storyboard> 的 `feature/high-performance` 分支，
storyboard **0.3.0**，检出点 `010b7f8`（Merge pull request #6 from canyueY/feat/v2-0.3.0）。Apache-2.0。

**它比 main 落后约 267 个提交**，所以只搬算法层，外壳一律用我们自己的：

- 搬：`analyzeVideo` / `planStoryboard` / `renderStoryboard` 及其依赖（25 个文件，含 `enrichment/`）
- 不搬：上游的 `src/index.js`（DSH 插件入口）、`src/tool-spec.js`（schema）、CLI

## 与 V1 的隔离

| | V1（main 0.6.0） | V2（本目录） |
|---|---|---|
| 代码 | `src/vendor/storyboard/` | `src/vendor/storyboard-v2/` |
| 缓存 | `<dataDir>/cache` | `<dataDir>/v2/cache` |
| 临时 | `<dataDir>/tmp` | `<dataDir>/v2/tmp` |
| 下载 | `<dataDir>/media` | `<dataDir>/v2/media` |
| 缓存版本 | `CACHE_VERSION = 25` | `CACHE_VERSION = 2` |

两个引擎**不共用任何模块**。`CACHE_VERSION` 不同这一点很关键：目录混用会把对方的条目判成过期，
看起来像"缓存永远不命中"。

## 改动

两处：

1. `cache.js` 的 `cacheDir()` 优先用注入的根（`world-paths.js`）；
2. `sheet.js` 的 `layoutCanvas()` 把最长边夹回 800：按面积算会得到 829×738，
   超过视觉输入的边长上限，模型那头会再缩一次、清单里的 `cell=` 就成了假数。
   实测夹完是 796×704。
V2 没有临时目录/下载层的代码，取流由 World 适配层代劳（yt-dlp 下到 `v2/media`）。

## 已知差异（对比时别当成 bug）

- V2 的切点检测是旧版：同一张 103 秒片，V1 检出 63 个切点，V2 检出 14 个。
- V2 没有 `transcriptFile`，也没有 `strategy` 档位（只有 `coverage` / `density`）。
- V2 的清单里 `transcript="asr"` 是按它的旧逻辑写的；没有配 ASR 时它并不会真的转写。
