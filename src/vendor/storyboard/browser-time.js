/**
 * browser-time.js — 直接从浏览器里读 `video.currentTime`，毫秒级准。
 *
 * 为什么需要：Windows 的 SMTC 只在**事件时**刷新（起播/暂停/拖动/切集），
 * 连续播放期间能几分钟不动。实测两次刷新隔过 143 s、216 s —— 那段时间里
 * "用户看到第几秒"只能靠墙钟外推，暂停/缓冲一插进来就错。
 *
 * 浏览器里那个 `<video>` 元素的 `currentTime` 是**真的**，只要浏览器开了调试端口：
 *
 *   msedge.exe --remote-debugging-port=9222
 *
 * 然后走 CDP（Chrome DevTools Protocol）：
 *   GET  http://127.0.0.1:9222/json        → 找到页面目标
 *   WS   Runtime.evaluate                  → 读 currentTime / paused / duration / location.href
 *
 * 顺带的好处：**拿得到当前网页地址**，源解析不用再靠标题猜。
 *
 * 没有调试端口就返回 null，调用方退回 SMTC。不报错、不打扰。
 */

// 默认 9333 而不是 9222：9222 是 Chrome DevTools 的惯例端口，容易被别的 Electron 应用占掉
// （实测这台机器上 WorkBuddy 自己就占着 9222，盲连会读到它的界面）。
const DEFAULT_PORT = 9333;

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { storyboardTempRoot } from './world-paths.js';

/**
 * 从 `~/.dsh/video.json` 读端口配置。
 *
 * 为什么要文件而不是只认环境变量：DSH 桌面版的宿主进程 env 由启动器决定，
 * 用户 `setx` 之后插件仍然读不到（这个坑今天已经踩过一次）。文件不依赖 env 传播。
 *
 *   { "browserPort": 9333 }
 */

export function configuredPort(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  try {
    const cfg = JSON.parse(readFileSync(join(home, 'video.json'), 'utf8'));
    const n = Number(cfg?.browserPort);
    if (Number.isFinite(n) && n > 0) return n;
    if (cfg?.browserPort === false || cfg?.browser === false) return null;
  } catch { /* 没有配置文件就是没开 */ }
  const fromEnv = Number(env.DSH_BROWSER_DEBUG_PORT);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : null;
}

/**
 * 这个地址像不像"某个视频的页面"？
 *
 * 为什么需要：C站**首页**上就挂着自动播放的推荐视频，`document.querySelector('video')` 也有值。
 * 但 `https://www.bilibili.com/` 不是任何一条视频，拿去喂 yt-dlp 只会得到
 * "this site is not supported"。判定要卡在地址上，而不是"页面上有没有 <video>"。
 */
export function looksLikeVideoUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('file://')) return true;
  if (/^https?:\/\//i.test(url)) {
    if (/bilibili\.com\/video\/(BV|av)/i.test(url)) return true;
    if (/bilibili\.com\/bangumi\/play\//i.test(url)) return true;
    if (/youtube\.com\/watch|youtu\.be\//i.test(url)) return true;
    if (/\.(mp4|m3u8|webm|mkv)(\?|$)/i.test(url)) return true;
  }
  return false;
}

/**
 * `file:///D:/a%20b.mp4` → `D:/a b.mp4`
 * 本地视频用浏览器打开时，页面地址就是这个视频的路径 —— 正好当 input 用，不必再问用户。
 */
export function fileUrlToPath(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return null;
  try {
    const p = new URL(url).pathname;
    const decoded = decodeURIComponent(p);
    // Windows: /D:/x → D:/x
    return /^\/[a-z]:/i.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return null;
  }
}

/** 列出调试端口暴露的页面目标 */
export async function listTargets({ port = DEFAULT_PORT, timeoutMs = 1200 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ac.signal });
    if (!res.ok) return null;
    const list = await res.json();
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 挑一个"正在放视频"的页面：优先 C站，其次任何带 video 的页面 */
export function pickVideoTarget(targets) {
  const pages = (targets ?? []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (pages.length === 0) return null;
  const scored = pages.map((t) => {
    let n = 0;
    if (/bilibili\.com/i.test(t.url ?? '')) n += 3;
    if (/\/video\//i.test(t.url ?? '')) n += 2;
    if (/\.(mp4|mkv|webm|m3u8)/i.test(t.url ?? '')) n += 2;
    return { t, n };
  }).sort((a, b) => b.n - a.n);
  return scored[0].n > 0 ? scored[0].t : pages[0];
}

/** 在某个页面里求值一次（一条 CDP 往返，约 10–30 ms） */
export function evaluate(wsUrl, expression, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let ws;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { ws?.close(); } catch { /* 已关 */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      clearTimeout(timer);
      return resolve(null);
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: false },
      }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id !== 1) return;
        clearTimeout(timer);
        finish(msg.result?.result?.value ?? null);
      } catch {
        clearTimeout(timer);
        finish(null);
      }
    };
    ws.onerror = () => { clearTimeout(timer); finish(null); };
    ws.onclose = () => { clearTimeout(timer); finish(null); };
  });
}

const SNAPSHOT_EXPR = `(() => {
  const v = document.querySelector('video');
  if (!v) return null;
  return {
    pos: v.currentTime,
    dur: Number.isFinite(v.duration) ? v.duration : null,
    paused: v.paused,
    ended: v.ended,
    readyState: v.readyState,
    url: location.href,
    title: document.title,
  };
})()`;

/**
 * 读浏览器里的真实播放位置。
 * @returns {Promise<null | {pos:number, dur:number|null, paused:boolean, url:string, title:string, port:number}>}
 */
export async function readBrowserPosition({ port = DEFAULT_PORT, timeoutMs = 1500, maxPages = 8 } = {}) {
  const targets = await listTargets({ port, timeoutMs });
  if (!targets) return null;
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    // **跳过 Electron 宿主自己的页面**：WorkBuddy / VSCode 这类应用也会开调试端口，
    // 页面里还有 <video>（实测 WorkBuddy 的 9222 上就有一个 5 秒的 video）。
    // 不排除的话会读到宿主自己的界面元素，而不是用户在看的那支片子。
    .filter((t) => {
      const u = t.url ?? '';
      return !u.includes('app.asar') && !u.startsWith('devtools:') && !u.includes('vscode');
    });
  if (pages.length === 0) return null;

  // **挨个问 "你这儿有 video 吗"**，而不是靠 URL 猜。
  // 实测踩过：同一台浏览器开着 7 个页面，靠 URL 打分选中了没有视频的那个，
  // 于是永远读到 -1 —— 而 C站页面好好的。URL 只能用来排序，不能用来判断。
  const ordered = [
    ...pages.filter((t) => /bilibili\.com|\/video\//i.test(t.url ?? '')),
    ...pages.filter((t) => !/bilibili\.com|\/video\//i.test(t.url ?? '')),
  ].slice(0, maxPages);

  let best = null;
  for (const t of ordered) {
    const snap = await evaluate(t.webSocketDebuggerUrl, SNAPSHOT_EXPR, { timeoutMs });
    if (!snap || typeof snap.pos !== 'number') continue;
    const cand = { ...snap, port };
    // 正在播的优先；暂停的也能用，但排在后面
    if (!snap.paused && !snap.ended) { best = cand; break; }
    if (!best) best = cand;
  }
  if (!best) return null;

  /*
   * **`paused` 会误报**，这是实测出来的：用户坚称在播，接口一路回 `paused`，
   * 而且 66 秒挂钟时间里 currentTime 只走了 8.6 秒（慢 3 倍多），之后又突然跳到 01:24。
   * 单看 `v.paused` 会把"其实在播"判成"暂停"，上层就反复让用户"按一下播放"——观感极差。
   *
   * 所以这里三路互证：
   *   ① `v.paused` 为 false            → 一定在播
   *   ② currentTime 相对上次读数确实前进了 → 即使 paused 说是暂停，也判在播
   *   ③ 两次读数完全没动               → 记成 stale，让上层能区分"真暂停"和"读不到"
   */
  const now = Date.now();
  const prev = lastSnapByPort.get(port);
  let playing = !best.paused && !best.ended;
  let staleMs = 0;
  if (prev && prev.url === best.url) {
    const dt = (now - prev.t) / 1000;
    const dp = best.pos - prev.pos;
    if (!playing && dt >= 0.8 && dt <= 15 && dp > 0.15 * dt) playing = true;
    if (dp === 0) staleMs = now - prev.t;
  }
  lastSnapByPort.set(port, { t: now, pos: best.pos, url: best.url });

  return {
    ...best,
    // 覆盖掉 DOM 那个会误报的 paused；原始值留档，排查时能对照
    paused: !playing,
    rawPaused: best.paused,
    playing,
    staleMs,
    confidence: playing ? 'playing' : (staleMs > 5000 ? 'stale' : 'paused'),
  };
}

/** 每个端口最近一次读数：用来判断 currentTime 有没有真的在走 */
const lastSnapByPort = new Map();

/**
 * 「浏览器到底在不在」—— 一次调用同时回答三件事：端口开没开 / 有没有标签页挂着 <video> /
 * 视频在播还是暂停。
 *
 * ## 为什么必须有这个函数
 *
 * `readBrowserPosition()` 读不到时返回 `null`，而调用方一律写成
 * `.catch(() => null)`（watch-run 里有 7 处）。于是**"浏览器没开"和"浏览器开着但没视频"
 * 在上层看起来一模一样**——都是"没有位置"。模型只能拿"有没有位置"去倒推"浏览器在不在"，
 * 而这两件事根本不是一回事：SMTC 那条路是系统级的，VLC、电影和电视、另一个没开调试端口的
 * Edge 窗口都能给它一个位置。结果就是"有位置" ≠ "你在看的那只浏览器开着"，
 * 模型对着空气写台词，还以为一切正常。
 *
 * 这里把状态说死，不给上层猜的空间：
 *   unconfigured  没配调试端口（只可能走 SMTC）
 *   closed        端口不通 → 浏览器没开 / 没带调试参数启动
 *   no-video      端口通、标签页也有，但没有一个页面挂着 <video>
 *   watching      读到了具体进度（带 url / title / playing / pos）
 *   error         探测本身抛了，连"开没开"都不知道
 *
 * @returns {Promise<{state:'unconfigured'|'closed'|'no-video'|'watching'|'error', port:number|null,
 *   url?:string, title?:string, pos?:number, dur?:number|null, paused?:boolean, playing?:boolean,
 *   pages?:number, urls?:string[]}>}
 */
export async function probeBrowser({ port = DEFAULT_PORT, timeoutMs = 1200 } = {}) {
  if (!port) return { state: 'unconfigured', port: null };
  const targets = await listTargets({ port, timeoutMs });
  if (!targets) return { state: 'closed', port };
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  let snap = null;
  try {
    snap = await readBrowserPosition({ port, timeoutMs, maxPages: 6 });
  } catch {
    return { state: 'error', port, pages: pages.length };
  }
  if (!snap) {
    return {
      state: 'no-video',
      port,
      pages: pages.length,
      urls: pages.slice(0, 3).map((t) => String(t.url ?? '').slice(0, 100)),
    };
  }
  return {
    state: 'watching',
    port,
    pages: pages.length,
    url: snap.url,
    title: snap.title,
    pos: snap.pos,
    dur: snap.dur ?? null,
    paused: snap.paused,
    playing: snap.playing === true,
    confidence: snap.confidence,
  };
}

export async function waitForPort(port, { timeoutMs = 8000, stepMs = 400 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    if ((await listTargets({ port, timeoutMs: 600 })) !== null) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

/** 调试端口开没开（用于给用户一句明确的提示，而不是让功能悄悄退化） */
export async function hasDebugPort({ port = DEFAULT_PORT } = {}) {
  return (await listTargets({ port })) !== null;
}

/**
 * 从浏览器里直接读 cookie，转成 Netscape 格式给 yt-dlp 用。
 *
 * 为什么比"手动导出"好：用户要做的只有一件事——**在带端口的那个窗口里登录一次**。
 * 之后插件自己去要 cookie，不需要他找扩展、找文件、找路径。
 *
 * 走的是 CDP 的浏览器级端点（/json/version → Storage.getCookies），能拿到全部 cookie，
 * 不受当前页面域限制。
 */
export async function readBrowserCookies({ port = DEFAULT_PORT, timeoutMs = 4000 } = {}) {
  let wsUrl;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const v = await res.json();
    wsUrl = v?.webSocketDebuggerUrl;
  } catch {
    return null;
  }
  if (!wsUrl) return null;

  const cookies = await new Promise((resolve) => {
    let ws;
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { ws?.close(); } catch { /* 已关 */ } resolve(v); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try { ws = new WebSocket(wsUrl); } catch { clearTimeout(timer); return resolve(null); }
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' }));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id !== 1) return;
        clearTimeout(timer);
        finish(msg.result?.cookies ?? null);
      } catch { clearTimeout(timer); finish(null); }
    };
    ws.onerror = () => { clearTimeout(timer); finish(null); };
    ws.onclose = () => { clearTimeout(timer); finish(null); };
  });
  if (!Array.isArray(cookies)) return null;
  // [安全 / issue #1] CDP 的 Storage.getCookies 是**浏览器级**的，会带出所有站点的 cookie。
  // 只保留 bilibili.com（含子域），其余一律丢弃 —— 这些只给 yt-dlp 下 B 站片用。
  return cookies.filter((c) => {
    const d = String(c?.domain ?? '').replace(/^\./, '').toLowerCase();
    return d === 'bilibili.com' || d.endsWith('.bilibili.com');
  });
}

/** cookie 数组 → Netscape cookies.txt 文本（yt-dlp 认这个格式） */
export function cookiesToNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# generated from the debug-port browser', ''];
  for (const c of cookies ?? []) {
    if (!c?.name || !c?.domain) continue;
    const domain = c.domain.startsWith('.') ? c.domain : c.domain;
    const includeSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expires = Number.isFinite(c.expires) && c.expires > 0 ? Math.floor(c.expires) : 0;
    const secure = c.secure ? 'TRUE' : 'FALSE';
    lines.push([domain, includeSub, c.path ?? '/', secure, expires, c.name, c.value ?? ''].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

/** 把浏览器 cookie 落盘，返回文件路径（失败返回 null） */
export async function writeBrowserCookiesFile({ port = DEFAULT_PORT, dir = null } = {}) {
  const cookies = await readBrowserCookies({ port });
  if (!cookies || cookies.length === 0) return null;
  // [安全] 不再写 ~/.dsh（那是宿主全局目录）；落到本扩展自己的数据目录，调用方用完即删
  const target = dir ?? join(storyboardTempRoot(), 'bili-cookies-from-browser.txt');
  try {
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, cookiesToNetscape(cookies), 'utf8');
    return target;
  } catch {
    return null;
  }
}
