/**
 * 另外三个工具：video_probe / video_locate / video_zoom。
 *
 * 逻辑照上游 src/tools/*.js，只换掉宿主胶水（附件、schema、落点）：
 *   - probe  只读容器头，不出图、不下载（链接走 probeUrl，本地走 probeVideo）
 *   - locate 纯文本定位，靠 locate.js 的转写缓存；没有就补跑一次 textOnly 的管线
 *   - zoom   按 cellId 或 from/to 重看一段，出图；链接会尽力拿高清直链
 */
import { boardOptions } from '../vendor/storyboard/board.js';
import { lookupCell } from '../vendor/storyboard/cells.js';
import { resolveInput, probeUrl } from '../vendor/storyboard/fetch.js';
import { formatMatches, matchSegments, recallSegments } from '../vendor/storyboard/locate.js';
import { runStoryboard } from '../vendor/storyboard/pipeline.js';
import { formatForDetail, formatProbe, formatRemoteProbe } from '../vendor/storyboard/format.js';
import { probeVideo } from '../vendor/storyboard/probe.js';
import { resolveDirectUrl } from '../vendor/storyboard/direct-url.js';
import { isHttpUrl } from '../vendor/storyboard/url.js';
import {
  locateToolSpec, probeToolSpec, validateZoomArgs, zoomToolSpec,
} from '../vendor/storyboard/tool-spec.js';
import { toJsonSchema } from '../tool-schema.js';
import { prepareStoryboardDirs } from './video-storyboard.js';

const tagsOf = { probe: ['read'], locate: ['read'], zoom: ['read', 'snapshot'] };

/** 自描述用（describe.json）：同一份 spec 转出来，不另写一遍。 */
export function extraDescribe() {
  const summary = {
    video_probe: {
      zh: '只读容器头：时长、分辨率、音轨、字幕轨，不出图、不下载。',
      en: 'Container header only: duration, resolution, tracks. No images, no download.',
    },
    video_locate: {
      zh: '纯文本定位：这句话在第几分钟。不读图。',
      en: 'Find when a line was said; text only.',
    },
    video_zoom: {
      zh: '按格号或时间窗重看一段：格子少、每格大。',
      en: 'Look again at one stretch by cell id or time window; fewer, bigger cells.',
    },
  };
  return [
    ['probe', probeToolSpec()],
    ['locate', locateToolSpec()],
    ['zoom', zoomToolSpec()],
  ].map(([kind, spec]) => ({
    name: spec.name,
    description: spec.description,
    tags: tagsOf[kind],
    parameters: toJsonSchema(spec.parameters),
    summary: summary[spec.name],
  }));
}

export function extraTools({ dataDir, cfg, asrStatus = null }) {
  return [
    makeTool(probeToolSpec(), 'probe', (args) => runProbe(args, cfg)),
    makeTool(locateToolSpec(), 'locate', (args) => runLocate(args, { dataDir, cfg, asrStatus })),
    makeTool(zoomToolSpec(), 'zoom', (args) => runZoom(args, { dataDir, cfg })),
  ];
}

/** 把 Node 的原始错误翻译成"下一步该干嘛"。 */
function explain(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/yt-dlp not found|YTDLP_MISSING/i.test(message)) {
    return '缺 yt-dlp。服务页体检里那一行是红的，就说明需要先装它（pip 落点或 PATH 都行）。';
  }
  if (/cannot be empty|ENOENT/i.test(message)) {
    return `${message}（通常是命令路径是空串，而不是文件不存在）`;
  }
  return message;
}

/** ASR 到底能不能转：装了、而且（本地服务起着 或 配了外部端点）。 */
function asrUsable(asr) {
  if (!asr) return false;
  if (asr.external) return true;           // 配了外部端点就当可用，失败再报
  return Boolean(asr.installed && asr.running);
}

/** 把转写失败的原因翻成人话：连接被拒 = 服务没起；401/needs key = 没配密钥。 */
function explainTranscriptError(err, asr) {
  const text = String(err ?? '');
  if (/ECONNREFUSED/i.test(text)) {
    return `连不上本地 ASR 服务（127.0.0.1:${asr?.port ?? 18760} 拒绝连接）——服务没启动，到「语音识别」卡点一下「启动」。`;
  }
  if (/401|403|needs a key|api key|unauthor/i.test(text)) {
    return 'ASR 端点要密钥，而这里没配。要么在服务页填 baseUrl 指向本地服务（本地服务不需要 key），要么填密钥。';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) {
    return `ASR 端点的域名解析不了：${text}`;
  }
  return text;
}

/** 没有转写时，把"为什么没有"说清楚：没装 ASR / 装了没起 / 起了但没听到话，是三件事。 */
function noTranscriptText(args, asrStatus) {
  const asr = asrStatus?.() ?? null;
  const where = asr?.installed
    ? (asr.running ? `本地 ASR 运行中（:${asr.port}，${asr.modelLabel}）` : `本地 ASR 已装（${asr.modelLabel}）但服务没启动`)
    : '本地 ASR 未安装';
  return [
    `没有可用来定位的转写。`,
    `ASR 状态：${where}。`,
    '三条路任选：',
    '  1) 先跑一次 video_storyboard（它会把台词落进 locate 的缓存）；',
    '  2) 显式传 transcriptFile（SRT / JSON）；',
    asr?.installed && !asr.running
      ? '  3) 到服务页点「启动」，再试一次。'
      : '  3) 到服务页「语音识别」装本地 ASR，装完会自动启动。',
  ].join('\n');
}

/** 只在确实有值时传，空串会把上游的默认值（ffmpeg）覆盖成一个空命令。 */
function mediaPaths(cfg) {
  return {
    ...(cfg?.ffmpegPath ? { ffmpegPath: cfg.ffmpegPath } : {}),
    ...(cfg?.ffprobePath ? { ffprobePath: cfg.ffprobePath } : {}),
  };
}

function makeTool(spec, kind, handler) {
  return {
    name: spec.name,
    description: spec.description,
    tags: tagsOf[kind],
    parameters: toJsonSchema(spec.parameters),
    handler,
  };
}

/* ------------------------------------------------------------------ probe */

async function runProbe(args, cfg) {
  if (!args?.input) return { text: 'input 是必填的。', failed: true };
  try {
    if (isHttpUrl(args.input)) {
      const remote = await probeUrl(args.input, { cookies: args.cookies, allowAnonymous: args.allowAnonymous === true, ...mediaPaths(cfg) });
      return { text: formatRemoteProbe(remote) };
    }
    const info = { ...(await probeVideo(args.input, mediaPaths(cfg))), path: args.input };
    return { text: await formatProbe(info) };
  } catch (error) {
    return { text: `探测失败：${error instanceof Error ? error.message : String(error)}`, failed: true };
  }
}

/* ----------------------------------------------------------------- locate */

async function runLocate(args, { dataDir, cfg, asrStatus = null }) {
  if (!args?.input) return { text: 'input 是必填的。', failed: true };
  if (!args?.query) return { text: 'query 是必填的。', failed: true };
  prepareStoryboardDirs(dataDir);
  const max = Math.min(20, Math.max(1, Number(args.max) || 5));
  let resolved;
  try {
    // **取流参数必须和 video_storyboard 一致**：它按画布预算选 scanHeight（默认 720），
    // 这里如果沿用默认 360，就会下载成另一份文件 —— 媒体缓存的 key 含清晰度，
    // 于是同一部片子有两条本地文件、两套转写，台词自然对不上（实测 26 秒处
    // 一边"大肥鱼"一边"大肺鱼"）。用 boardOptions 拿到同一份 fetchOptions。
    const fetchOptions = boardOptions({ ...args, input: args.input }, { kind: 'board' }).fetchOptions;
    resolved = await resolveInput(args.input, {
      ...fetchOptions, cookies: args.cookies, allowAnonymous: args.allowAnonymous === true, ...mediaPaths(cfg),
    });
  } catch (error) {
    return { text: `取不到这个输入：${explain(error)}`, failed: true };
  }
  if (!resolved?.path) {
    return { text: `取不到本地文件（输入 ${args.input} 解析出来是空的）。贴链接时先确认 yt-dlp 可用。`, failed: true };
  }
  let segments = recallSegments(resolved.path);
  // 没有缓存、也没有显式字幕时，先看 ASR 到底能不能用——不可用就直接说人话，
  // 不要等到 fetch 失败再把 ECONNREFUSED 甩给用户。
  const asr = asrStatus?.() ?? null;
  if (!segments && !args.transcriptFile && !asrUsable(asr)) {
    return { text: noTranscriptText(args, asrStatus), failed: false };
  }
  try {
    if (!segments) {
      // **和 video_storyboard 走同一条转写路径**：textOnly 的管线。
      // 之前这里直连 resolveTranscript，切片依据（静音点）和分块边界与 storyboard 不同，
      // 同一句话会被切成两块音频、各认一遍（实测 00:26 一边"大肥鱼"、一边"大肺鱼"）。
      // 走管线之后两边共用同一次转写与同一份缓存，台词必然一致。
      // 代价是 locate 也要过一遍 probe + 扫描（扫描有缓存，通常 1–2 秒）。
      let failure = null;
      try {
        await runStoryboard({
          input: resolved.path,
          ...(Number(args.from) > 0 ? { from: Number(args.from) } : {}),
          ...(Number(args.to) > 0 ? { to: Number(args.to) } : {}),
          textOnly: true,
          transcriptFile: args.transcriptFile ?? null,
          ...mediaPaths(cfg),
          cache: true,
        });
      } catch (error) {
        failure = error;
      }
      segments = recallSegments(resolved.path);
      if (!segments) {
        // 管线不往 locate 的 cells 缓存里写；转写本身在按片缓存里，这里取一次（命中缓存，很快）
        const info = { ...(await probeVideo(resolved.path, mediaPaths(cfg))), path: resolved.path };
        const winStart = Math.max(0, Number(args.from) || 0);
        const winDur = Number(args.to) > 0
          ? Math.max(0.2, Number(args.to) - winStart)
          : Math.max(0.2, info.duration - winStart);
        const { resolveTranscript } = await import('../vendor/storyboard/transcript-pass.js');
        const got = await resolveTranscript({
          input: resolved.path, info, transcript: 'auto',
          transcriptFile: args.transcriptFile ?? null,
          winStart, winDur, silences: [],
          ...mediaPaths(cfg), asrKey: undefined, asrMaxChunk: 45, cache: true,
        });
        segments = got?.transcriptInfo?.segments ?? null;
        const err = got?.transcriptInfo?.error;
        if ((!segments || !segments.length) && err) {
          return { text: `转写没成功：${explainTranscriptError(err, asr)}\n\n${noTranscriptText(args, asrStatus)}`, failed: true };
        }
      }
      if (!segments && failure) throw failure;
    }
    if (!segments || segments.length === 0) {
      return { text: noTranscriptText(args, asrStatus) };
    }
    const lo = Number.isFinite(args.from) ? Number(args.from) : 0;
    const hi = Number.isFinite(args.to) ? Number(args.to) : Infinity;
    const inWindow = segments.filter((x) => x.to >= lo && x.from <= hi);
    const matches = matchSegments(inWindow, args.query, { max });
    return { text: formatMatches(args.query, matches, { total: inWindow.length }) };
  } catch (error) {
    return { text: `定位失败：${error instanceof Error ? error.message : String(error)}`, failed: true };
  }
}

/* ------------------------------------------------------------------- zoom */

async function runZoom(args, { dataDir, cfg }) {
  const problems = validateZoomArgs(args);
  if (problems.length) return { text: `参数不合法：${problems.join('；')}`, failed: true };
  prepareStoryboardDirs(dataDir);

  let from = args.from;
  let to = args.to;
  try {
    if (args.cellId !== undefined && args.cellId !== null) {
      const hit = await lookupCell(args.input, args.cellId);
      if (!hit) {
        return {
          text: `这个输入没有记下格子表（cellId ${args.cellId}）。先跑一次 video_storyboard，或者直接给 from/to。`,
          failed: true,
        };
      }
      from = hit.from;
      to = hit.to;
    }
    const opts = boardOptions({ ...args, from, to }, { kind: 'zoom' });
    if (cfg?.ffmpegPath) opts.ffmpegPath = cfg.ffmpegPath;
    if (cfg?.ffprobePath) opts.ffprobePath = cfg.ffprobePath;

    let frameSource = null;
    if (isHttpUrl(args.input)) {
      try {
        // 空串会把上游默认的 ffmpeg 覆盖成空命令（就是 "file cannot be empty" 那个错）
        const resolved = await resolveInput(args.input, { ...opts.fetchOptions, ...mediaPaths(cfg) });
        frameSource = resolved.frameSource
          ?? await resolveDirectUrl(args.input, { ...opts.fetchOptions, ...mediaPaths(cfg) });
      } catch {
        /* 直链拿不到就退回本地低清：糊一点，但整次调用不该失败 */
      }
    }
    const result = await runStoryboard({ ...opts, frameSource });
    const text = formatForDetail(result, { detail: args.detail ?? 'med' });
    const blobs = (result.sheets ?? []).map((sheet) => ({
      bytes: sheet.png,
      mime: 'image/png',
      name: `zoom-${sheet.sheet}.png`,
      fallbackText: `[放大图 ${sheet.sheet}：${sheet.cells?.length ?? 0} 格]`,
    }));
    return { text, blobs };
  } catch (error) {
    return { text: `放大失败：${error instanceof Error ? error.message : String(error)}`, failed: true };
  }
}
