/**
 * 这份 vendored 代码的「根目录」由 World 注入。
 *
 * 上游 `dsh-video-storyboard` 把缓存放在 LOCALAPPDATA、临时文件放在系统 temp；
 * 装进 World 之后，这两样都必须落在 World 自己的目录里（管理页要能看到、能一键清空）。
 * 所以只改四个落点，其余代码原样保留：
 *   - cache.js 的 cacheDir()
 *   - subtitles.js / ocr-subs.js 的 mkdtemp()
 *   - media-store.js 的 mediaDir() 与磁盘余量检查
 *
 * 其它模块（cells.js / memory.js / transcript-cache.js）都经 cacheDir()，自动跟着走。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let roots = { cache: null, temp: null, media: null };

/** 由 World 在每次跑工具前调用；只接受绝对路径，缺省项保持原样。 */
export function setStoryboardPaths(next = {}) {
  for (const key of ['cache', 'temp', 'media']) {
    if (typeof next[key] === 'string' && next[key]) roots[key] = next[key];
  }
}

export function storyboardCacheDir() {
  return roots.cache ?? join(tmpdir(), 'dsh-video-storyboard');
}

export function storyboardTempRoot() {
  return roots.temp ?? join(tmpdir(), 'dsh-video-storyboard');
}

export function storyboardMediaDir() {
  return roots.media ?? join(storyboardTempRoot(), 'media');
}

export function currentRoots() {
  return { ...roots };
}
