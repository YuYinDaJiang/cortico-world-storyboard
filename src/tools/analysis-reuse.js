/**
 * V1 的两处「从 V2 拿过来的点子」，都放在 World 层，不动 v1 的编排：
 *
 * 1. **分析资产复用**：v1 本来就把 scan / transcript 按 (文件, 窗口, 阈值) 缓存；缺的是音频分析
 *    （每次重跑 ~0.9 s）。音频缓存补在 vendored 的 pipeline 里（`[World 改动]` 标注），
 *    这里只负责在清单前面如实报告这一轮哪些分析是复用的。
 * 2. **seen before**：v1 的 memory.js 一直在写 `seen.jsonl`，但清单从来不读它；V2 会打印
 *    "seen before: N window(s) analysed before…"。这里在开跑之前读一次并附在正文前面。
 *
 * 两件事都只读，失败就静默跳过——记忆是锦上添花，不该让主流程挂掉。
 */
import { describeMemory, memoryPath } from '../vendor/storyboard/memory.js';

/** 开跑之前调用：这一部片子之前看过哪些窗口。 */
export async function seenBefore(input) {
  if (!input) return null;
  try {
    const line = await describeMemory({ path: String(input) });
    return typeof line === 'string' && line.trim() ? line.trim() : null;
  } catch {
    return null;
  }
}

/** 跑完之后调用：把这一轮的复用情况写成一行给人看的消息。 */
export function reuseLine(result) {
  const hits = [];
  if (result?.cached) hits.push('scan');
  if (result?.audioCached) hits.push('audio');
  if (result?.transcript?.asrCached) hits.push('transcript');
  if (!hits.length) return null;
  return `reused from the analysis cache: ${hits.join(', ')}（换格数/档位/预算不会重扫）`;
}

export { memoryPath };
