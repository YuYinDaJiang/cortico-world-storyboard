/**
 * precomputed 分析资产的入口：产、存、取。
 *
 * 典型用法（Node 侧脚本，不需要 World）：
 *
 *   import { ensurePrecomputed, toPrecomputedOption } from './src/precomputed/index.js';
 *
 *   const { precomputed, reused, file } = await ensurePrecomputed({
 *     baseDir: 'D:/data/storyboard',       // 落盘在 <baseDir>/precomputed/<key>.json
 *     input: 'D:/media/foo.mp4',
 *     from: 0, to: null, threshold: 'auto',
 *   });
 *   const result = await runStoryboard({ input, precomputed: toPrecomputedOption(precomputed), ... });
 *
 * 第二次同样的调用会直接命中磁盘（reused: true），跳过整段解码。
 */

export {
  PRODUCER_VERSION,
  PRINTS_COLS,
  buildPrecomputed,
  normalizeCuts,
  assertPrints,
  toPrecomputedOption,
} from './producer.js';

export {
  STORE_VERSION,
  precomputedDir,
  fileIdentity,
  storeKey,
  paramsFingerprint,
  hasPrecomputed,
  savePrecomputed,
  loadPrecomputed,
  listPrecomputed,
  dropPrecomputed,
} from './store.js';

export { DETECT_VERSION, DETECT_DEFAULTS, detectCuts, mergeShortShots } from './detect.js';

import { DETECT_DEFAULTS, DETECT_VERSION } from './detect.js';
import { buildPrecomputed } from './producer.js';
import {
  fileIdentity, loadPrecomputed, paramsFingerprint, precomputedDir, savePrecomputed, storeKey,
} from './store.js';
import { join } from 'node:path';

/**
 * 有就用磁盘上的，没有就现扫一次并落盘。
 *
 * @param {object} opts 见 buildPrecomputed，外加：
 * @param {string} opts.baseDir  数据目录（World 里是 `<dataDir>/storyboard`）
 * @param {boolean} [opts.refresh=false] 忽略已有文件，强制重扫
 * @returns {Promise<{precomputed:object, key:string, file:string, reused:boolean}>}
 */
export async function ensurePrecomputed({
  baseDir, input, from = 0, to = null, threshold = 'auto', minGap = 0,
  ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', onProgress, refresh = false,
  detect = 'upstream', detectOptions = {},
} = {}) {
  const dir = precomputedDir(baseDir);
  const identity = await fileIdentity(input);
  if (!identity) throw new Error(`找不到文件：${input}`);
  // 0 与 null 都是"到片尾"：归一化，否则同一个窗口会算出两个 key
  const toNorm = Number(to) > 0 ? Number(to) : null;
  // 自有检测：把生效后的参数（默认值 + 覆盖）一起算进 key
  const detectorVersion = detect === 'own' ? DETECT_VERSION : null;
  const paramsHash = detect === 'own' ? paramsFingerprint({ ...DETECT_DEFAULTS, ...(detectOptions ?? {}) }) : null;
  const key = storeKey({
    identity, from, to: toNorm, threshold, minGap, detect, detectorVersion, paramsHash,
  });

  if (!refresh) {
    const hit = await loadPrecomputed(dir, key);
    if (hit) return { precomputed: hit, key, file: join(dir, `${key}.json`), reused: true };
  }

  const built = await buildPrecomputed({
    input, from, to: toNorm, threshold, minGap, ffmpegPath, ffprobePath, onProgress,
    detect, detectOptions,
  });
  const file = await savePrecomputed(dir, key, built);
  return { precomputed: built, key, file, reused: false };
}
