/**
 * storyboard_help —— 按主题取 README 的某一小节（工具的长解释都搬去 README 了，这里按需取回）。
 *
 * 为什么不是把整份 README 塞回去：README 是给人读的，几万字；模型只需要一小节。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const README = fileURLToPath(new URL('../../README.md', import.meta.url));
const SB = '工具细节：video_storyboard';

/** 主题别名 → README 小节标题里的关键词。 */
const ALIAS = {
  storyboard: SB,
  story: SB,
  board: SB,
  engine: SB,
  v2: SB,
  transcript: SB,
  subtitles: SB,
  ocr: SB,
  detect: SB,
  precomputed: SB,
  integral: SB,
  tier: SB,
  probe: '工具细节：video_probe',
  locate: '工具细节：video_locate',
  zoom: '工具细节：video_zoom',
  status: '工具细节：storyboard_status',
  choose: '工具选择',
  which: '工具选择',
};

let cache = null;

function sections() {
  if (cache) return cache;
  const text = readFileSync(README, 'utf8');
  const parts = text.split(/\r?\n## /).slice(1);
  cache = parts.map((chunk) => {
    const nl = chunk.indexOf('\n');
    return { title: (nl < 0 ? chunk : chunk.slice(0, nl)).trim(), body: (nl < 0 ? '' : chunk.slice(nl + 1)).trim() };
  });
  return cache;
}

export function helpTool() {
  return {
    name: 'storyboard_help',
    description: 'Read one section of this World\'s documentation (tool details moved out of the tool descriptions). '
      + 'Param: topic — storyboard | probe | locate | zoom | engine | transcript | subtitles | detect | precomputed | '
      + 'integral | tier | choose | status. Returns that section only. Use it when a tool\'s short description is not '
      + 'enough to decide parameters.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topic: {
          type: 'string',
          description: 'Section to read, e.g. "storyboard", "choose", "transcript".',
        },
      },
      required: ['topic'],
    },
    handler: async (args) => {
      const raw = String(args?.topic ?? '').trim().toLowerCase();
      if (!raw) return { text: `给一个 topic：${Object.keys(ALIAS).join(' / ')}` };
      const want = ALIAS[raw] ?? raw;
      const list = sections();
      const hit = list.find((s) => s.title.includes(want));
      if (!hit) {
        return {
          text: `没有这个主题：${raw}。可用：${Object.keys(ALIAS).join(' / ')}；\n`
            + `README 小节：${list.map((s) => s.title).join(' | ')}`,
        };
      }
      const body = hit.body.length > 4000 ? `${hit.body.slice(0, 4000)}\n…（截断，请看 README）` : hit.body;
      return { text: `## ${hit.title}\n\n${body}` };
    },
  };
}
