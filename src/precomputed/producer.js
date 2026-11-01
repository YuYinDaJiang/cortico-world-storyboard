/**
 * precomputed 生产者 v0。
 *
 * 目标：把**一次真实扫描**的结果，整理成 `runStoryboard({ precomputed })` 能吃下的对象，
 * 落盘后可以反复复用（换格数、换档位、换预算都不用重扫）。
 *
 * 产出的对象与 pipeline 的契约（`src/vendor/storyboard/pipeline.js` 的 buildPrecomputedScan）：
 *
 *   cuts      Array<{t, score, raw?}>   已排序、去重、按 minGap 抑制
 *   stats     Array<{t, score, raw?, gain?}>  归一化那一份，长度 = frames - 1
 *   means     number[]                  逐帧 V 均值，长度 = frames
 *   prints    Uint8Array[]              逐帧 16×9 = 144 字节，长度 = frames
 *   frames    number                    解码帧数
 *   degraded  'motion' | undefined      这段可能全是运动/低对比
 *   summary   {p50,p90,p95,p99,max,frames}
 *   threshold number                    本片自适应阈值
 *
 * 与上游 `scanShots()` 的关系：**原样取它的返回值**，只做三件整理——
 *   1) cuts 按窗口裁、排序、去重、可选抑制；
 *   2) 数值截断（时间 3 位小数、分数 2 位、means 3 位），减小落盘体积；
 *   3) 形状自检（prints/means/stats 长度对不上就直接报错，不产半成品）。
 */

import { scanShots, suppressClose, FP_W, FP_H } from '../vendor/storyboard/scan.js';
import { probeVideo } from '../vendor/storyboard/probe.js';
import { DETECT_VERSION, detectCuts, summarize } from './detect.js';

/** 生产者格式版本：改了字段含义就 +1，旧文件自然作废。 */
export const PRODUCER_VERSION = 1;

/** 每一帧亮度指纹的字节数（16×9）。 */
export const PRINTS_COLS = FP_W * FP_H;

const round = (n, d = 2) => {
  const v = Number(n);
  return Number.isFinite(v) ? +v.toFixed(d) : 0;
};

/**
 * 切点整理：裁窗口 → 升序 → 去重 → 可选最小间隔抑制。
 * @param {Array<{t:number}>} cuts
 */
export function normalizeCuts(cuts, { start = 0, end = Infinity, minGap = 0 } = {}) {
  const inWindow = (Array.isArray(cuts) ? cuts : [])
    .filter((c) => Number.isFinite(c?.t) && c.t >= start && c.t < end)
    .map((c) => ({
      t: round(c.t, 3),
      score: round(c.score),
      ...(Number.isFinite(c.raw) ? { raw: round(c.raw) } : {}),
    }))
    .sort((a, b) => a.t - b.t);

  const deduped = [];
  for (const c of inWindow) {
    if (deduped.length && Math.abs(c.t - deduped[deduped.length - 1].t) < 1e-6) continue;
    deduped.push(c);
  }
  // suppressClose 只按 t 间距裁；minGap<=0 时原样返回（scanShots 已经做过一轮）
  return Number(minGap) > 0 ? suppressClose(deduped, Number(minGap)) : deduped;
}

/** 逐帧指纹自检：条数、单条长度都要对得上。 */
export function assertPrints(prints, frames) {
  if (!Array.isArray(prints) || prints.length === 0) {
    throw new Error('扫描没有产出 prints：无法生成可复用的分析资产');
  }
  prints.forEach((p, i) => {
    const len = p?.length;
    if (len !== PRINTS_COLS) {
      throw new Error(`prints[${i}] 长度 ${len}，应为 ${PRINTS_COLS}（${FP_W}×${FP_H}）`);
    }
  });
  if (Number.isFinite(frames) && Math.abs(prints.length - frames) > 1) {
    throw new Error(`prints 有 ${prints.length} 条，与 frames=${frames} 对不上（应相差不超过 1）`);
  }
}

/**
 * 跑一次真实扫描，产出可落盘的 precomputed 对象。
 *
 * @param {object} opts
 * @param {string} opts.input          本地文件路径（URL 请先自己取流）
 * @param {number} [opts.from=0]       窗口起点（秒）
 * @param {number|null} [opts.to=null] 窗口终点（秒），null = 到片尾
 * @param {number|'auto'} [opts.threshold='auto']
 * @param {number} [opts.minGap=0]     切点最小间隔；0 = 沿用 scanShots 的默认抑制
 * @param {string} [opts.ffmpegPath]
 * @param {string} [opts.ffprobePath]
 * @param {(p:object)=>void} [opts.onProgress]
 * @returns {Promise<object>} 可直接交给 store.save() 的纯数据对象
 */
export async function buildPrecomputed({
  input,
  from = 0,
  to = null,
  threshold = 'auto',
  minGap = 0,
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
  onProgress,
  detect = 'upstream',
  detectOptions = {},
} = {}) {
  if (!input) throw new Error('input is required');

  const info = await probeVideo(input, { ffprobePath });
  const winStart = Math.max(0, Math.min(Number(from) || 0, Math.max(0, info.duration - 0.2)));
  const winEnd = Math.min(info.duration, Number(to) > 0 ? Number(to) : info.duration);
  const winDur = Math.max(0.2, winEnd - winStart);

  // 自有检测：同一套输出形状，只是切点由 detect.js 算（裁字幕带 + 直方图 + 三点一致性）。
  if (detect === 'own') {
    const got = await detectCuts({
      input, ffmpegPath, start: winStart, end: winEnd, fps: info.fps, options: detectOptions,
    });
    const cuts = normalizeCuts(got.cuts, { start: winStart, end: winEnd, minGap });
    const stats = got.stats.map((s) => ({ t: round(s.t, 3), score: round(s.score) }));
    const means = got.means.map((m) => round(m, 3));
    if (stats.length && Math.abs(stats.length - (got.frames - 1)) > 1) {
      throw new Error(`own 检测：stats 长度 ${stats.length}，与 frames-1=${got.frames - 1} 对不上`);
    }
    if (means.length !== got.frames) {
      throw new Error(`own 检测：means 长度 ${means.length}，与 frames=${got.frames} 对不上`);
    }
    return {
      producerVersion: PRODUCER_VERSION,
      detector: { id: 'own', version: DETECT_VERSION, options: got.detector.options },
      source: { path: input, fps: round(info.fps, 3), duration: round(info.duration, 3) },
      window: { from: round(winStart, 3), to: round(winEnd, 3) },
      threshold: round(got.threshold),
      minGap: Number(minGap) || 0,
      frames: got.frames,
      degraded: null,
      summary: summarize(stats),
      cuts,
      stats,
      means,
      prints: got.prints, // 自有检测顺手产 16×9 指纹，tagCuts 才能打标签
    };
  }

  const raw = await scanShots({
    input,
    fps: info.fps,
    threshold,
    start: winStart,
    end: winEnd,
    minGap,
    ffmpegPath,
    hwaccel: null,
    onProgress,
  });

  assertPrints(raw.prints, raw.frames);

  const cuts = normalizeCuts(raw.cuts, { start: winStart, end: winEnd, minGap });
  const stats = (Array.isArray(raw.stats) ? raw.stats : []).map((s) => ({
    t: round(s.t, 3),
    score: round(s.score),
    ...(Number.isFinite(s.raw) ? { raw: round(s.raw) } : {}),
    ...(Number.isFinite(s.gain) ? { gain: round(s.gain) } : {}),
  }));
  const means = (Array.isArray(raw.means) ? raw.means : []).map((m) => round(m, 3));

  // 形状自检：钩子那边 stats 缺失会静默关掉积分补帧，这里提前拦住
  if (stats.length && Math.abs(stats.length - (raw.frames - 1)) > 1) {
    throw new Error(`stats 长度 ${stats.length}，与 frames-1=${raw.frames - 1} 对不上`);
  }
  if (means.length && Math.abs(means.length - raw.frames) > 1) {
    throw new Error(`means 长度 ${means.length}，与 frames=${raw.frames} 对不上`);
  }

  return {
    producerVersion: PRODUCER_VERSION,
    source: {
      path: input,
      fps: round(info.fps, 3),
      duration: round(info.duration, 3),
    },
    window: { from: round(winStart, 3), to: round(winEnd, 3) },
    threshold: round(raw.threshold),
    minGap: Number(minGap) || 0,
    frames: raw.frames,
    degraded: raw.degraded ?? null,
    summary: raw.summary,
    cuts,
    stats,
    means,
    prints: raw.prints, // Uint8Array[]，落盘时由 store 编码
  };
}

/** 把生产结果变成 `runStoryboard({ precomputed })` 要的形状（去掉我们自己的元数据）。 */
export function toPrecomputedOption(pre) {
  if (!pre) throw new Error('没有 precomputed 数据');
  return {
    cuts: pre.cuts,
    summary: pre.summary,
    threshold: pre.threshold,
    // 空数组不要传：钩子那边只判 Array.isArray，空数组会把 stats 变成 []，
    // 看起来"有"，实际 sampleMarks 仍然是 0（比不传更容易误判）
    ...(Array.isArray(pre.stats) && pre.stats.length ? { stats: pre.stats } : {}),
    ...(Array.isArray(pre.means) && pre.means.length ? { means: pre.means } : {}),
    ...(Number.isFinite(pre.frames) ? { frames: pre.frames } : {}),
    ...(pre.degraded ? { degraded: pre.degraded } : {}),
    prints: pre.prints,
  };
}
