/**
 * 本 World 自己的小状态：只放「管理页要记着」的东西，配置本身在 worlds.storyboard 里。
 * 读写都容错：文件坏了就当没有，绝不让管理页因为一个 JSON 打不开而白屏。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const FILE = 'state.json';

export function statePath(dataDir) {
  return join(dataDir, FILE);
}

export async function loadState(dataDir) {
  try {
    const raw = await readFile(statePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* 没有或坏了：用空状态 */
  }
  return {};
}

/** 先写临时文件再改名，避免半个 JSON 留在盘上。 */
export async function saveState(dataDir, state) {
  const file = statePath(dataDir);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}
