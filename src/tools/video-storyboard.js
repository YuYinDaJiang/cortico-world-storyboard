/**
 * video_storyboard —— 把一段视频变成「可引用的宫格图 + 一份时间轴清单」。
 *
 * 算法一律来自 vendored 的上游实现（src/vendor/storyboard/），这个文件只做四件事：
 *   1. 参数 schema：上游 spec → JSON Schema（语言无关的转换在 tool-schema.js）；
 *   2. 落点：缓存 / 临时 / 下载缓存统一指向 World 自己的目录；
 *   3. 字幕：只认显式 transcriptFile（.srt / JSON），.ass 明确拒绝并给出 ffmpeg 转法；
 *   4. 收尾：PNG 走 blobs、清单走文本。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { boardOptions } from '../vendor/storyboard/board.js';
import { formatForDetail } from '../vendor/storyboard/format.js';
import { runStoryboard } from '../vendor/storyboard/pipeline.js';
import { storyboardToolSpec, validateToolArgs } from '../vendor/storyboard/tool-spec.js';
import { setStoryboardPaths } from '../vendor/storyboard/world-paths.js';
import { toJsonSchema } from '../tool-schema.js';
import { reuseLine, seenBefore } from './analysis-reuse.js';

const INTERRUPTED = '分镜没有跑完。';

/** 字幕文件：只认自己解析得了的两种。.ass 不解析，让用户先转一道。 */
function checkTranscriptFile(path) {
  const file = String(path ?? '').trim();
  if (!file) return { error: 'transcriptFile 是空的。' };
  if (/\.ass$/i.test(file)) {
    return {
      error: '不支持 .ass 字幕：本工具只读 SRT 和 JSON。先用 ffmpeg 转一道，再把转好的 .srt 传进来：\n'
        + `  ffmpeg -i "${file}" "${file.replace(/\.ass$/i, '.srt')}"\n`
        + '（不会自动去同目录找同名字幕，必须显式传 transcriptFile。）',
    };
  }
  if (!existsSync(file)) return { error: `transcriptFile 指的文件不存在：${file}` };
  return { file };
}

/** 落点：全部在 World 的数据目录里，跑之前先保证目录在。 */
export function prepareStoryboardDirs(dataDir) {
  const dirs = {
    cache: join(dataDir, 'cache'),
    temp: join(dataDir, 'tmp'),
    media: join(dataDir, 'media'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  setStoryboardPaths(dirs);
  return dirs;
}

/**
 * @param {{dataDir: string, cfg: object}} env  World 的数据目录与当前配置
 * @returns {import('cortico').ToolDef | object} 带 handler 的工具定义
 */
export function videoStoryboardTool(env) {
  return {
    ...videoStoryboardDescribe(),
    handler: (args) => runStoryboardTool(args, env),
  };
}

/** 自描述用的那一半（describe.json 与运行时用同一份，避免两处漂移）。 */
export function videoStoryboardDescribe() {
  const spec = storyboardToolSpec();
  const parameters = toJsonSchema(spec.parameters);
  parameters.properties.engine = {
    type: 'string',
    enum: ['v1', 'v2'],
    description: 'v1 (default) = cut-driven tiers; v2 = older coverage engine (separate cache, one scan per switch). '
      + 'storyboard_help({topic:"engine"}) for details.',
  };
  parameters.properties.subtitles = {
    type: 'string',
    enum: ['off', 'ocr', 'ocr-dense'],
    description: 'off (default) | ocr = read burned-in subtitles from the storyboard frames | ocr-dense = scan every '
      + 'ocrStep seconds. Both are for foreign-language audio with hard subs. storyboard_help({topic:"subtitles"}).',
  };
  parameters.properties.detect = {
    type: 'string',
    enum: ['upstream', 'own'],
    description: 'upstream (default) | own = bottom-band histogram + three-point consistency, merges shots <1.5 s. '
      + 'Only with precomputed:"auto" on local files. storyboard_help({topic:"detect"}).',
  };
  parameters.properties.precomputed = {
    type: 'string',
    enum: ['off', 'auto'],
    description: 'off (default) | auto = reuse a dumped scan for the same file+window, skipping the decode. '
      + 'The receipt names the path: off / hit(<key>) / miss→built(<key>). storyboard_help({topic:"precomputed"}).',
  };
  return {
    name: spec.name,
    description: 'Storyboard a video window: grid images plus a timestamped manifest. Params: input; from/to (seconds, '
      + 'default whole file, ~15 min max per call); maxFrames (cap; 6 to skim, 12 when you must quote lines); detail '
      + 'low|med|high; tier/tierMap; integral+integralSeconds (extra frames inside long shots; set integral:false for '
      + 'slides/lectures); precomputed off|auto; detect upstream|own; subtitles off|ocr|ocr-dense; transcriptFile '
      + '(SRT/JSON, never auto-discovered); engine v1|v2. Run video_probe first on unknown files. storyboard_help({topic:"storyboard"}) '
      + 'for the long version.',
    tags: ['read', 'snapshot'],
    parameters,
    summary: {
      zh: '把视频变成可引用的分镜宫格图，附一份带时间码的清单。',
      en: 'Turn a video into citable storyboard sheets plus a timestamped manifest.',
    },
  };
}

export async function runStoryboardTool(args, { dataDir, cfg }) {
  // 两个引擎互不干扰：v2 的代码、缓存、临时目录、下载缓存都在自己的树下。
  if (args?.engine === 'v2') {
    const { runV2 } = await import('./video-storyboard-v2.js');
    return runV2(args, { dataDir, cfg });
  }

  // 先读记忆：这部片子之前看过哪些窗口（V2 的 seen-before，v1 一直在写、只是没读过）
  const seen = await seenBefore(args?.input).catch(() => null);
  const transcript = args?.transcriptFile === undefined ? null : checkTranscriptFile(args.transcriptFile);
  if (transcript?.error) return { text: transcript.error, failed: true };

  let options;
  try {
    options = boardOptions(args, { kind: 'board' });
  if (args.subtitles === 'ocr' || args.subtitles === 'ocr-dense') options.subtitles = args.subtitles;
  if (Number.isFinite(Number(args.ocrStep))) options.ocrStep = Math.max(0.25, Math.min(5, Number(args.ocrStep)));
    if (cfg?.ffmpegPath) options.ffmpegPath = cfg.ffmpegPath;
    if (cfg?.ffprobePath) options.ffprobePath = cfg.ffprobePath;
    if (transcript?.file) options.transcriptFile = transcript.file;
  } catch (error) {
    return { text: `参数无法使用：${error instanceof Error ? error.message : String(error)}`, failed: true };
  }

  const problems = validateToolArgs(args);
  if (problems.length) return { text: `参数不合法：${problems.join('；')}`, failed: true };

  try {
    prepareStoryboardDirs(dataDir);
    // yt-dlp 的发现顺序是 DSH_YTDLP_PATH → PATH → pip 脚本；管理页填的路径走第一条。
    // 空字符串表示没填，清掉环境变量让上游自己按 PATH 找。
    const configured = String(cfg?.ytdlpPath ?? '').trim();
    if (configured) process.env.DSH_YTDLP_PATH = configured;
    else delete process.env.DSH_YTDLP_PATH;

    // 分析资产复用：默认 off，一行开关打开；本地文件才走，链接会在后面取流成文件，这里不接。
    // detect 只在 auto 时才有意义：upstream = 上游 scanShots；own = 我们自己的检测（裁字幕带 + 直方图 + 三点一致性）。
    // 不选 own 时**不 import** detect.js，代码路径与之前完全一致。
    const detectMode = String(args?.detect ?? 'upstream').toLowerCase() === 'own' ? 'own' : 'upstream';
    let precomputedNote = detectMode === 'own'
      ? 'off（detect=own 只在 precomputed:"auto" 时生效）'
      : 'off';
    if (String(args?.precomputed ?? 'off').toLowerCase() === 'auto') {
      if (!existsSync(String(args.input))) {
        precomputedNote = 'off（输入不是本地文件，本次按原路径扫描）';
      } else {
        try {
          const { ensurePrecomputed, toPrecomputedOption } = await import('../precomputed/index.js');
          const got = await ensurePrecomputed({
            baseDir: dataDir,
            input: String(args.input),
            from: options.from ?? 0,
            to: Number(options.to) > 0 ? Number(options.to) : null,
            threshold: options.threshold ?? 'auto',
            ffmpegPath: options.ffmpegPath,
            ffprobePath: options.ffprobePath,
            detect: detectMode,
          });
          options.precomputed = toPrecomputedOption(got.precomputed);
          precomputedNote = `${got.reused ? 'hit' : 'miss→built'}(${got.key.slice(0, 5)}…, ${detectMode})`;
        } catch (error) {
          // 生产者失败不该让分镜失败：退回原路径，把原因写在回执里
          precomputedNote = `off（生成失败，已回退原路径：${String(error?.message ?? error).slice(0, 80)}）`;
        }
      }
    }

    const result = await runStoryboard(options);
    const manifest = formatForDetail(result, { detail: options.detail, cellRange: args.cellRange ?? null });
    // 两条「从 V2 拿来的」信息，放在清单前面：看没看过、这一轮复用了哪些分析资产
    const preamble = [
      seen ? `seen before: ${seen}` : null,
      reuseLine(result),
      `precomputed: ${precomputedNote}`,
    ].filter(Boolean).join('\n');
    const text = preamble ? `${preamble}\n\n${manifest}` : manifest;
    const blobs = (result.sheets ?? []).map((sheet) => ({
      bytes: sheet.png,
      mime: 'image/png',
      name: `storyboard-${sheet.sheet}.png`,
      fallbackText: `[分镜图 ${sheet.sheet}：${sheet.cells?.length ?? 0} 格，`
        + `${fmt(sheet.cells?.[0]?.t_start)}–${fmt(sheet.cells?.[sheet.cells.length - 1]?.t_end)}]`,
    }));
    return { text, blobs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT|not found|找不到/i.test(message)) {
      return {
        text: `跑不起来：${message}\n\n先到「服务」页点一次「重新体检」，确认 ffmpeg / ffprobe 的路径。`,
        failed: true,
      };
    }
    return { text: `${INTERRUPTED}${message}`, failed: true };
  }
}

function fmt(seconds) {
  if (!Number.isFinite(seconds)) return '?';
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${rest}`;
}
