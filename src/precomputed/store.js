/**
 * precomputed 的落盘与读回。
 *
 * 位置：`<baseDir>/precomputed/<key>.json`
 *   - `baseDir` 由调用方给（World 里就是 `<dataDir>/storyboard`）
 *   - 同一个视频、同一个窗口、同一组扫描参数 → 同一个 key，写一次反复用
 *   - key 里含文件大小与 mtime：文件一改（重新下载/转码）自然作废
 *
 * 体积参考（103 秒、720p、25fps）：
 *   prints ≈ 2570 帧 × 144 B ≈ 370 KB（base64 后 ≈ 493 KB）
 *   stats  ≈ 2570 条 × ~40 B ≈ 100 KB
 *   means  ≈ 2570 × ~6 B ≈ 15 KB
 * 合计 ~0.6 MB/片；比重新解码快两个数量级。
 *
 * 编码：prints 是一条长 base64（所有帧首尾相接），靠 `printCols` 切回来——
 * 不逐条 base64，省 2570 个 JSON 键。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PRINTS_COLS, PRODUCER_VERSION } from './producer.js';

/** 落盘格式版本：字段含义变了就 +1。 */
export const STORE_VERSION = 1;

/** 默认目录：`<baseDir>/precomputed`。 */
export function precomputedDir(baseDir) {
  return join(String(baseDir ?? ''), 'precomputed');
}

/** 文件身份：路径 + 字节数 + mtime（毫秒取整）。文件不在返回 null。 */
export async function fileIdentity(input) {
  try {
    const st = await stat(input);
    return { path: input, bytes: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch {
    return null;
  }
}

/**
 * 一个 precomputed 的唯一键：身份 + 窗口 + 扫描参数。
 *
 * `detect === 'upstream'`（默认）时**不加**任何后缀 —— 老缓存继续命中。
 * 自有检测把检测器 id、版本、参数指纹都算进 key，改任何参数自动作废。
 */
export function storeKey({
  identity, from = 0, to = null, threshold = 'auto', minGap = 0,
  detect = 'upstream', detectorVersion = null, paramsHash = null,
} = {}) {
  if (!identity?.path) throw new Error('identity is required');
  const parts = [
    'pre', STORE_VERSION, identity.path, identity.bytes, identity.mtimeMs,
    Number(from) || 0, to ?? 'eof', String(threshold), Number(minGap) || 0,
  ];
  if (detect && detect !== 'upstream') {
    parts.push(detect, `v${detectorVersion ?? 1}`, String(paramsHash ?? ''));
  }
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** 参数指纹：把检测器参数对象压成 8 位 hex，进 key 用。 */
export function paramsFingerprint(params) {
  return createHash('sha1').update(JSON.stringify(params ?? {})).digest('hex').slice(0, 8);
}

/** 是否存在。 */
export async function hasPrecomputed(dir, key) {
  try {
    const st = await stat(join(dir, `${key}.json`));
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * 落盘。prints 的 Uint8Array[] 会被拼成一条 base64。
 * @returns {Promise<string>} 写入的文件路径
 */
export async function savePrecomputed(dir, key, pre) {
  if (!pre) throw new Error('savePrecomputed: 没有数据');
  // prints 可缺省（例如将来某些检测器不出指纹）；有就必须合规。
  const prints = Array.isArray(pre.prints) ? pre.prints : [];
  const cols = prints.length ? prints[0].length : PRINTS_COLS;
  if (prints.length) {
    if (cols !== PRINTS_COLS) throw new Error(`savePrecomputed: prints 单条应 ${PRINTS_COLS} 字节，收到 ${cols}`);
    for (const p of prints) {
      if (p.length !== cols) throw new Error('savePrecomputed: prints 各条长度不一致');
    }
  }

  const buf = Buffer.alloc(prints.length * cols);
  prints.forEach((p, i) => buf.set(p, i * cols));

  const payload = {
    v: STORE_VERSION,
    producerVersion: pre.producerVersion ?? PRODUCER_VERSION,
    at: new Date().toISOString(),
    source: pre.source ?? null,
    window: pre.window ?? null,
    threshold: pre.threshold ?? null,
    minGap: pre.minGap ?? 0,
    frames: pre.frames ?? null,
    degraded: pre.degraded ?? null,
    summary: pre.summary ?? null,
    cuts: pre.cuts ?? [],
    stats: pre.stats ?? [],
    means: pre.means ?? [],
    detector: pre.detector ?? null,
    prints: { count: prints.length, cols, data: buf.toString('base64') },
  };

  await mkdir(dir, { recursive: true });
  const file = join(dir, `${key}.json`);
  await writeFile(file, `${JSON.stringify(payload)}\n`, 'utf8');
  return file;
}

/**
 * 读回，并把 prints 还原成 Uint8Array[]。
 * @returns {Promise<object|null>} 不存在/损坏/版本不符 → null（调用方回落到重新扫描）
 */
export async function loadPrecomputed(dir, key) {
  let payload;
  try {
    payload = JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8'));
  } catch {
    return null;
  }
  if (payload?.v !== STORE_VERSION) return null;
  const count = payload.prints?.count ?? 0;
  const cols = payload.prints?.cols ?? PRINTS_COLS;
  if (!Number.isInteger(count) || count < 0) return null;
  if (count > 0 && cols !== PRINTS_COLS) return null;

  const raw = Buffer.from(String(payload.prints?.data ?? ''), 'base64');
  if (raw.length !== count * cols) return null;

  const prints = new Array(count);
  for (let i = 0; i < count; i += 1) {
    prints[i] = new Uint8Array(raw.subarray(i * cols, (i + 1) * cols));
  }

  return {
    producerVersion: payload.producerVersion ?? null,
    at: payload.at ?? null,
    source: payload.source ?? null,
    window: payload.window ?? null,
    threshold: payload.threshold ?? null,
    minGap: payload.minGap ?? 0,
    frames: payload.frames ?? null,
    degraded: payload.degraded ?? null,
    summary: payload.summary ?? null,
    cuts: payload.cuts ?? [],
    stats: payload.stats ?? [],
    means: payload.means ?? [],
    detector: payload.detector ?? null,
    prints,
  };
}

/** 列出目录里现有的 precomputed（体积、时间、来源）。 */
export async function listPrecomputed(dir) {
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const st = await stat(join(dir, name));
      const head = JSON.parse(await readFile(join(dir, name), 'utf8'));
      out.push({
        key: name.replace(/\.json$/, ''),
        bytes: st.size,
        at: head.at ?? null,
        source: head.source?.path ?? null,
        window: head.window ?? null,
        frames: head.frames ?? null,
      });
    } catch { /* 坏文件跳过 */ }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** 删一份。 */
export async function dropPrecomputed(dir, key) {
  try {
    await unlink(join(dir, `${key}.json`));
    return true;
  } catch {
    return false;
  }
}
