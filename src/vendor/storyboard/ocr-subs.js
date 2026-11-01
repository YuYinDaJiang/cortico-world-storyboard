/**
 * ocr-subs.js — 用画面硬字幕校正 ASR 文本（只在 detail=high 或显式 ocr:true 时开）。
 *
 * [World 改动] 实现已换成 ocr-align.js 的「自适应行框 + 多帧投票 + 同音闸门」：
 *   - 不再整句替换（旧 shouldReplace 会把"读清的别的句子"整句塞进来）；
 *   - 只改「拼音相同、汉字不同」的字，且要 4 帧里 ≥2 票、conf ≥0.75；
 *   - 简繁/异体先归一化，時→时 这类不算改动；
 *   - A2（OCR 完整、ASR 漏字）只标记不改句；
 *   - 没有 python / rapidocr / pypinyin 时返回 skipped + reason，不抛错、不拖慢主流程。
 *
 * 老的 planOcrSamples / applyOcrSamples / shouldReplace 仍导出（别的模块/测试在用），
 * 但主路径已经不走它们了。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { storyboardTempRoot } from './world-paths.js';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { detectAndRead, OCR_MAX_ITEMS, ocrPython, shouldReplace } from './ocr.js';
import { alignTranscript } from './ocr-align.js';

const runFile = promisify(execFile);

/** 均匀抽样若干条台词（老接口，保留给测试与旧调用方）。 */
export function planOcrSamples(segments, { winStart = 0, winDur = Infinity, max = OCR_MAX_ITEMS } = {}) {
  const list = Array.isArray(segments) ? segments : [];
  const n = Math.min(Math.max(0, Math.round(Number(max) || 0)), list.length);
  if (n === 0) return [];
  const step = list.length / n;
  const limit = Number.isFinite(winDur) ? Math.max(0, winStart + winDur) : Infinity;
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const idx = Math.floor(i * step);
    const from = Number(list[idx]?.from);
    const to = Number(list[idx]?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const mid = (from + to) / 2;
    samples.push({ idx, at: Math.min(Math.max(0, mid), limit) });
  }
  return samples;
}

/** 老接口：按 shouldReplace 逐条替换（新路径不再使用）。 */
export function applyOcrSamples(segments, samples, items) {
  const out = segments.map((x) => ({ ...x }));
  const changes = [];
  for (const [k, sample] of samples.entries()) {
    const seg = segments[sample.idx];
    const ocrText = (items[k]?.text ?? '').replace(/\s+/g, '');
    const verdict = shouldReplace({ asr: seg.text, ocr: ocrText, conf: items[k]?.conf ?? 0 });
    if (verdict.replace) {
      const fixedText = verdict.text ?? ocrText;
      changes.push({ from: seg.from, was: seg.text, now: fixedText, cover: verdict.cover });
      out[sample.idx] = { ...seg, text: fixedText };
    }
  }
  return { segments: out, changes };
}

/**
 * 主入口：自适应行框 + 多帧投票。
 * 返回形状与旧版兼容（status/fixed/checked/changes/segments），并多出 engine/chars/summary/a2。
 */
export async function correctByOnScreenSubs({
  input, ffmpegPath = 'ffmpeg', segments, winStart = 0, winDur = Infinity, maxItems = OCR_MAX_ITEMS,
} = {}) {
  return alignTranscript({ input, ffmpegPath, segments, winStart, winDur, maxItems });
}

/** 老接口保留（有调用方直接测它）。 */
export { detectAndRead, ocrPython, shouldReplace };
export { storyboardTempRoot, mkdtemp, rm, join, runFile };
