/**
 * 自有切点检测（v1）。经 `precomputed` 钩子喂给 runStoryboard，**不碰 vendor 一行**。
 *
 * 为什么自己做：上游的切点检测拿"整帧像素差"算分，底部硬字幕每换一行就判一刀
 * （24 分钟长片实测 953 格 / 113 图，见 partner/storyboard-longvideo-test-20261101.md）。
 * 这套检测把画面下部整块排除，再用直方图距离 + 三点一致性，只认"前后都静、中间突变"的点。
 *
 * 四步：裁字幕带 → 直方图差 → 三点一致性 → 短镜头合并。
 * 输出形状与 producer 走上游时一致：{ cuts, stats, means, threshold, frames }，
 * 另外附 `prints`（16×9 亮度指纹），让 precomputed 里的 tagCuts 还能打 flash/black/white 标签。
 */

import { spawn } from 'node:child_process';
import { FP_H, FP_W, scanSummary } from '../vendor/storyboard/scan.js';

/**
 * 检测器版本：算法或分数含义变了就 +1（进缓存 key）。
 * v2：修 mergeShortShots 的时间基准 bug（旧版会把切点级联删光，落盘 cuts=0）。
 * 改算法忘了 bump 的后果：旧 dump 会被当成新结果复用（踩过一次）。
 */
export const DETECT_VERSION = 2;

/**
 * 所有可调常量都在这里。改任意一项都会改变缓存 key（见 store.js），旧结果自动作废。
 *
 * 单位说明：score 是直方图 L1 距离 ×100，理论范围 0–100。
 * 完全相同时 0；"一半像素从黑变白"这种极端换场接近 100。
 */
export const DETECT_DEFAULTS = Object.freeze({
  // ---- 步骤 1：遮底部字幕带 ----
  // 只取画面**上** bottomCrop 这一块。0.78 = 丢掉下面 22%。
  // 调大：字幕/角标/水印更干净，但真实画面下部的动作（手部、球）也会被切掉。
  // 调小：漏遮，硬字幕每刷一行都会重新混进分数（上游 953 格的根因）。
  bottomCrop: 0.78,

  // ---- 解码几何 ----
  // 与上游 scanShots 一致（64×36）。调大更细但更慢；调小更快但细节丢。
  scanW: 64,
  scanH: 36,

  // ---- 步骤 2：直方图差 ----
  // 亮度分箱数。调大：对细微变化更敏感；调小：更稳，但亮度分布接近的换场会漏。
  bins: 32,

  // ---- 步骤 3：三点一致性 ----
  // 候选的绝对下限。调大：刀更少更保守；调小：抖动/噪点也会成为候选。
  floorDelta: 8,
  // d(i-1,i) 至少是 d(i,i+1) 的多少倍。调大：要求"后面更静"，运镜排除更狠；调小：运镜里开始出假刀。
  ratioPrev: 2.2,
  // d(i-1,i) 至少是 d(i-2,i-1) 的多少倍。调大：缓慢推拉/淡入排除更多；调小：这类镜头会被误判。
  ratioBefore: 2.0,
  // 前后帧被判"静"的绝对上限。调大：噪音素材也能出刀；调小：只认非常干净的切点。
  quietBelow: 6,

  // ---- 步骤 4：聚格 ----
  // 短于这个时长的镜头并进前一个。调大：合得更狠、格子更少；调小：保留更多碎切。
  minShotSec: 1.5,
  // 安全阀：每分钟最多这么多刀（0 = 不设）。防止长片再次失控。
  maxCutsPerMin: 30,
});

const clip01 = (v) => Math.min(1, Math.max(0, v));

/** 一帧 RGB → 归一化亮度直方图（和为 1）+ 16×9 指纹 + 亮度均值。 */
export function frameFeatures(rgb, width, height, { bins, fpW, fpH }) {
  const hist = new Float64Array(bins);
  const fp = new Uint8Array(fpW * fpH);
  const acc = new Float64Array(fpW * fpH);
  const cnt = new Uint32Array(fpW * fpH);
  let sum = 0;

  for (let y = 0; y < height; y += 1) {
    const fy = Math.min(fpH - 1, Math.floor((y * fpH) / height));
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      const v = 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
      sum += v;
      hist[Math.min(bins - 1, Math.floor((v / 256) * bins))] += 1;
      const fx = Math.min(fpW - 1, Math.floor((x * fpW) / width));
      const cell = fy * fpW + fx;
      acc[cell] += v;
      cnt[cell] += 1;
    }
  }
  const n = width * height;
  for (let i = 0; i < hist.length; i += 1) hist[i] /= n;
  for (let i = 0; i < fp.length; i += 1) fp[i] = Math.round(acc[i] / (cnt[i] || 1));
  return { hist, fp, mean: sum / n };
}

/** 两条归一化直方图的 L1 距离，折算到 0–100（完全一样 0，一半像素翻转约 100）。 */
export function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]);
  return (s / 2) * 100;
}

/** 解码：一次顺序解码，先裁字幕带再缩，输出 rgb24 原始帧。 */
function decodeFrames({ input, ffmpegPath, start, end, width, height, bottomCrop, onFrame }) {
  return new Promise((resolve, reject) => {
    const dur = Number.isFinite(end) ? Math.max(0.1, end - start) : null;
    const cropH = `trunc(ih*${clip01(bottomCrop).toFixed(4)})`;
    const args = [
      '-v', 'error', '-nostdin',
      ...(start > 0 ? ['-ss', String(start)] : []),
      ...(dur ? ['-t', String(dur)] : []),
      '-i', input,
      '-an', '-sn',
      '-vf', `crop=iw:${cropH}:0:0,scale=${width}:${height}:flags=area,format=rgb24`,
      '-f', 'rawvideo', '-',
    ];
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const frameBytes = width * height * 3;
    let pending = Buffer.alloc(0);
    let stderr = '';
    let frames = 0;

    child.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        const slice = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        onFrame(slice, frames);
        frames += 1;
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
        return;
      }
      resolve({ frames, stderr });
    });
  });
}

/**
 * 短镜头合并：段长 < minShotSec 的，把它**开头那个切点**丢掉（并入前一段）。
 * 从后往前删，删完重算，直到没有短段。
 */
export function mergeShortShots(cuts, endAbs, minShotSec) {
  let list = [...cuts].sort((a, b) => a.t - b.t);
  for (let guard = 0; guard < 1000; guard += 1) {
    let changed = false;
    for (let i = 0; i < list.length; i += 1) {
      const nextT = i + 1 < list.length ? list[i + 1].t : endAbs;
      if (nextT - list[i].t < minShotSec) {
        list = list.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return list;
}

/**
 * 主入口：本地文件 + 窗口 → 切点与逐帧特征。
 *
 * @param {object} opts
 * @param {string} opts.input
 * @param {string} [opts.ffmpegPath='ffmpeg']
 * @param {number} [opts.start=0]      窗口起点（秒）
 * @param {number} [opts.end]          窗口终点（秒），不给 = 到片尾
 * @param {number} opts.fps            调用方 probe 出来的帧率
 * @param {object} [opts.options]      覆盖 DETECT_DEFAULTS 的任意项
 * @returns {Promise<{cuts:Array, stats:Array, means:number[], prints:Uint8Array[],
 *                    threshold:number, frames:number, duration:number}>}
 */
export async function detectCuts({
  input, ffmpegPath = 'ffmpeg', start = 0, end, fps, options = {},
} = {}) {
  if (!input) throw new Error('input is required');
  const cfg = { ...DETECT_DEFAULTS, ...(options ?? {}) };
  const rate = Number(fps) > 0 ? Number(fps) : 25;

  const hists = [];
  const means = [];
  const prints = [];

  await decodeFrames({
    input, ffmpegPath, start, end,
    width: cfg.scanW, height: cfg.scanH, bottomCrop: cfg.bottomCrop,
    onFrame: (buf, idx) => {
      const f = frameFeatures(buf, cfg.scanW, cfg.scanH, {
        bins: cfg.bins, fpW: FP_W, fpH: FP_H,
      });
      hists.push(f.hist);
      means.push(+f.mean.toFixed(3));
      prints.push(f.fp);
      void idx;
    },
  });

  const frames = hists.length;
  if (frames < 2) {
    return { cuts: [], stats: [], means, prints, threshold: cfg.floorDelta, frames, duration: 0 };
  }

  // 逐帧差：d[i] = dist(i-1, i)，t 取后一帧的时间（与上游 stats 的 t 对齐）
  const d = new Array(frames).fill(0);
  const stats = [];
  for (let i = 1; i < frames; i += 1) {
    d[i] = distance(hists[i - 1], hists[i]);
    stats.push({ t: +(start + i / rate).toFixed(3), score: +d[i].toFixed(2) });
  }

  // 三点一致性：前后都要"静"，且本刀明显高于两侧
  const quiet = (v) => (Number.isFinite(v) ? v : 0) <= cfg.quietBelow;
  const cuts = [];
  for (let i = 1; i < frames; i += 1) {
    const cur = d[i];
    if (cur < cfg.floorDelta) continue;
    const prev = i - 1 >= 1 ? d[i - 1] : 0;
    const next = i + 1 < frames ? d[i + 1] : 0;
    if (cur < cfg.ratioPrev * next) continue;
    if (cur < cfg.ratioBefore * prev) continue;
    if (!quiet(prev) || !quiet(next)) continue;
    cuts.push({ t: +(start + i / rate).toFixed(3), score: +cur.toFixed(2) });
  }

  const duration = frames / rate;
  // 注意：cut 的 t 是**整片绝对时间**（start + i/rate），所以这里的结束边界也必须是
  // 绝对时间；早先传 duration（相对长度）会让"最后一段"恒为负，逐个把切点吃光。
  const endAbs = start + duration;
  let kept = mergeShortShots(cuts, endAbs, cfg.minShotSec);

  // 安全阀：每分钟最多 maxCutsPerMin 刀，超了按分数的从低到高丢
  if (cfg.maxCutsPerMin > 0) {
    const budget = Math.max(1, Math.round((duration / 60) * cfg.maxCutsPerMin));
    if (kept.length > budget) {
      kept = [...kept].sort((a, b) => b.score - a.score).slice(0, budget).sort((a, b) => a.t - b.t);
    }
  }

  return {
    cuts: kept,
    stats,
    means,
    prints,
    threshold: cfg.floorDelta,
    frames,
    duration,
    // 供 producer 记账：这一份结果是用哪版检测器、哪组参数算出来的
    detector: { version: DETECT_VERSION, options: cfg },
  };
}

/** 汇总成与上游 scanSummary 同形状（producer 写盘时用）。 */
export function summarize(stats) {
  return scanSummary((stats ?? []).map((s) => s.score));
}
