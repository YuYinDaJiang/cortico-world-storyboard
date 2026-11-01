/**
 * V2 引擎适配层（上游 feature/high-performance 分支，storyboard 0.3.0）。
 *
 * 只调它的算法层：`runStoryboard()` = analyzeVideo → planStoryboard → renderStoryboard，
 * 外壳（World、工具 schema、落点、blobs）仍然是我们的。
 *
 * 和 V1 的隔离：
 *   - 代码在 src/vendor/storyboard-v2/，不与 V1 共用任何模块；
 *   - 缓存/临时/下载缓存在 <dataDir>/v2/{cache,tmp,media}；
 *   - V1 的 CACHE_VERSION 与 V2 的不是一回事，绝不能共用目录。
 *
 * V2 只吃本地文件，取流这一步由这里代劳（yt-dlp 下到 v2 自己的 media 目录）。
 */
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { formatManifest, runStoryboard } from '../vendor/storyboard-v2/pipeline.js';
import { setV2Paths } from '../vendor/storyboard-v2/world-paths.js';
// 只借它「pip 落点」这一条发现逻辑，不碰 V1 的算法
import { findPipScript } from '../vendor/storyboard/ytdlp.js';

const TEXT_MAX = 22000;

export function prepareV2Dirs(dataDir) {
  const root = join(dataDir, 'v2');
  const dirs = {
    root,
    cache: join(root, 'cache'),
    temp: join(root, 'tmp'),
    media: join(root, 'media'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  setV2Paths(dirs);
  return dirs;
}

/** V2 的工具参数：只取它自己认的那几个，V1 的档位名不往里塞。 */
function v2Options(args, { dirs, cfg }) {
  const cells = Number(args.maxFrames) > 0 ? Math.min(64, Math.round(Number(args.maxFrames))) : 0;
  return {
    input: args.input,
    from: Number(args.from) || 0,
    ...(Number(args.to) > 0 ? { to: Number(args.to) } : {}),
    ...(Number.isFinite(Number(args.threshold)) ? { threshold: Number(args.threshold) } : {}),
    ...(args.pick ? { pick: args.pick } : {}),
    ...(args.burn ? { burn: args.burn } : {}),
    ...(Number(args.budget) > 0 ? { budget: Math.min(640_000, Number(args.budget)) } : {}),
    ...(cells ? { cells } : {}),
    ...(Number(args.maxSheets) > 0 ? { sheets: Math.min(64, Math.round(Number(args.maxSheets))) } : {}),
    ...(cfg?.ffmpegPath ? { ffmpegPath: cfg.ffmpegPath } : {}),
    ...(cfg?.ffprobePath ? { ffprobePath: cfg.ffprobePath } : {}),
  };
}

/**
 * @returns {Promise<{text: string, blobs?: object[], failed?: true}>}
 */
export async function runV2(args, { dataDir, cfg }) {
  if (!args?.input) return { text: '参数不合法：input 是必填的。', failed: true };

  const dirs = prepareV2Dirs(dataDir);
  let input = String(args.input);
  let fetched = null;
  try {
    if (/^https?:\/\//i.test(input)) {
      fetched = await fetchToV2(input, { dirs, ytdlpPath: cfg?.ytdlpPath });
      input = fetched.path;
    }

    const options = v2Options({ ...args, input }, { dirs, cfg });
    const result = await runStoryboard(options);
    const text = formatManifest(result, { maxChars: TEXT_MAX });
    const blobs = (result.sheets ?? []).map((sheet) => ({
      bytes: sheet.png,
      mime: 'image/png',
      name: `storyboard-v2-${sheet.sheet}.png`,
      fallbackText: `[分镜图 V2 ${sheet.sheet}：${sheet.cells?.length ?? 0} 格]`,
    }));
    const notes = [
      'engine=v2（上游 feature/high-performance / storyboard 0.3.0）',
      fetched ? `输入是从链接取到本地的：${fetched.note}` : null,
      args.transcriptFile ? '注意：V2 引擎没有 transcriptFile 这条（0.3.0 不支持），这次没有用它。' : null,
    ].filter(Boolean);
    return { text: `${notes.join('\n')}\n\n${text}`, blobs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `V2 引擎没跑完：${message}`, failed: true };
  }
}

/**
 * V2 只认本地文件。链接先落成 v2/media/<key>/video.mp4，键按 URL + 目标高度算。
 * 全程没有 shell；yt-dlp 的 TEMP 指到 v2 自己的 tmp。
 */
async function fetchToV2(url, { dirs, ytdlpPath }) {
  const key = createHash('sha1').update(`${url}|scan`).digest('hex').slice(0, 16);
  const dir = join(dirs.media, key);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'video.mp4');
  // 发现顺序：管理页填的路径 → pip 的落点（%APPDATA%\Python\*\Scripts）→ PATH
  let bin = (ytdlpPath ?? '').trim();
  if (!bin) bin = (await findPipScript(process.env).catch(() => null)) || 'yt-dlp';
  const args = [
    '--no-playlist', '--no-warnings', '--no-progress',
    '-f', 'bv*[height<=480]+ba/b[height<=480]/b',
    '--merge-output-format', 'mp4',
    '-o', out,
    url,
  ];
  const started = Date.now();
  await new Promise((resolve, reject) => {
    execFile(bin, args, {
      timeout: 15 * 60 * 1000,
      maxBuffer: 8 << 20,
      windowsHide: true,
      env: { ...process.env, TMP: dirs.temp, TEMP: dirs.temp },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`yt-dlp 取流失败：${(stderr || error.message).trim().split('\n').slice(-3).join(' ')}`));
      else resolve();
    });
  });
  return { path: out, note: `${((Date.now() - started) / 1000).toFixed(1)} s，480p 档，存到 v2 media` };
}
