/**
 * V2 引擎的根目录，由 World 注入，和 V1 完全分开。
 *
 * V1 用 <dataDir>/{cache,tmp,media}；V2 用 <dataDir>/v2/{cache,tmp,media}。
 * 两个引擎各有自己的 cache 版本与键空间（V1 CACHE_VERSION=25，V2 =2），
 * 混在一起不是"命中率低"那么简单——同名文件会被对方的版本号判废。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let roots = { cache: null, temp: null, media: null };

export function setV2Paths(next = {}) {
  for (const key of ['cache', 'temp', 'media']) {
    if (typeof next[key] === 'string' && next[key]) roots[key] = next[key];
  }
}

export function currentV2Roots() {
  return { ...roots };
}

export function v2CacheDir() {
  return roots.cache ?? join(tmpdir(), 'dsh-video-storyboard-v2');
}

export function v2TempRoot() {
  return roots.temp ?? join(tmpdir(), 'dsh-video-storyboard-v2');
}

export function v2MediaDir() {
  return roots.media ?? join(v2TempRoot(), 'media');
}
