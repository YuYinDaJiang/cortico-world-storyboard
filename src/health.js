/**
 * 外部二进制的体检：只回答「在不在、是哪一版、原话是什么」，不做任何下载或安装。
 * 找不到时把要装什么、装完要做什么写清楚——原仓库的 doctor 就是按这个标准写的。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverYtdlp } from './vendor/storyboard/ytdlp.js';
import { setStoryboardPaths } from './vendor/storyboard/world-paths.js';

const TIMEOUT_MS = 8000;

/**
 * 跑一次 `-version`。回调式执行器，不用 promisify：要同时拿到 stdout 与 stderr。
 * @returns {Promise<{ ok: boolean, bin: string, path: string | null, version: string | null, error: string | null }>}
 */
export function probeVersion(bin, {
  timeoutMs = TIMEOUT_MS,
  argv = ['-version'],
  env = process.env,
  notFound = '找不到这个程序（PATH 里没有，或路径不对）',
} = {}) {
  return new Promise((resolve) => {
    if (!bin) {
      resolve({ ok: false, bin, path: null, version: null, error: '未填写路径' });
      return;
    }
    const settle = (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr ?? '').trim() || error.message;
        resolve({ ok: false, bin, path: null, version: null, error: error.code === 'ENOENT' ? notFound : detail });
        return;
      }
      const text = `${stdout ?? ''}\n${stderr ?? ''}`;
      // ffmpeg/ffprobe 打 `ffmpeg version 7.1`；yt-dlp 只打一行版本号（`2026.10.26`）
      const version = /(?:version\s+)?(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?|\d+\.\d+(?:\.\d+)*)/m.exec(text)?.[1] ?? null;
      resolve({ ok: true, bin, path: bin, version, error: null });
    };
    try {
      execFile(bin, argv, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20, env }, settle);
    } catch (error) {
      // 沙箱或权限不允许起子进程时，spawn 会同步抛出：如实报告，不要让管理页白屏
      resolve({ ok: false, bin, path: null, version: null, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** 允许配置里只写目录，或写 `ffmpeg` 这样的裸命令。 */
export function resolveBinary(configured, fallback) {
  const value = (configured ?? '').trim();
  if (!value) return fallback;
  if (existsSync(value) && !/\.exe$/i.test(value)) {
    // 给的是目录：补上可执行文件名
    try {
      const name = fallback.split(/[\\/]/).pop();
      const candidate = join(value, name);
      if (existsSync(candidate)) return candidate;
    } catch {
      /* 目录读不了就按原样试 */
    }
  }
  return value;
}

/**
 * OCR 体检：有没有 rapidocr、在哪个解释器、以及（deep 时）真跑一张图。
 *
 * shallow ≈ 0.3 s（只 import），deep ≈ 3–5 s（加载 onnx 模型 + 识别一张白底图）。
 * 体检默认只做 shallow，deep 留给"一键测一张图"。
 */
export async function checkOcr({ python = null, deep = false, timeoutMs = 120000 } = {}) {
  const { ocrPython } = await import('./vendor/storyboard/ocr.js');
  const configured = String(python ?? '').trim();
  const cmd = configured || await ocrPython();
  if (!cmd) {
    // 区分"没有 Python"和"有 Python 但没有 rapidocr"，体检行要能看出缺哪一样
    let pyInfo = null;
    try { pyInfo = await (await import('./asr/ocr-install.js')).findPython311(); } catch { /* 探测失败不影响结论 */ }
    // 找到 Python 但引擎没装：不是"没 Python"，要分开报
    if (pyInfo?.ok) {
      return {
        ok: false, python: pyInfo.path, engine: null, deep: false,
        pythonVersion: pyInfo.version,
        reason: 'engine-missing',
        error: 'OCR 引擎未就绪 —— 缺 rapidocr / onnxruntime',
      };
    }
    const tooOld = pyInfo && pyInfo.reason === 'too-old';
    const tooNew = pyInfo && pyInfo.reason === 'too-new';
    return {
      ok: false, python: null, engine: null, deep: false,
      pythonVersion: pyInfo?.version ?? null,
      reason: tooOld ? 'python-too-old' : tooNew ? 'python-too-new' : 'python-missing',
      error: tooOld
        ? `Python ${pyInfo.version} 低于 3.11（OCR 需要 3.11–3.13）`
        : tooNew
          ? `Python ${pyInfo.version} 暂无可用 wheel（OCR 需要 3.11–3.13）`
          : '未找到 Python 3.11–3.13（安装 OCR 需要该区间；可自行安装，或用别的方式装 rapidocr）',
    };
  }
  const run = (args, timeout) => new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
  });

  const probe = await run(['-c', 'import json,sys;import rapidocr;print(json.dumps({"v":getattr(rapidocr,"__version__","?")}))'], timeoutMs);
  if (probe.err) {
    return { ok: false, python: cmd, engine: null, deep: false, error: String(probe.err.message ?? probe.err).slice(0, 160) };
  }
  let version = '?';
  try { version = JSON.parse(probe.stdout.trim()).v ?? '?'; } catch { /* 版本号拿不到不算失败 */ }

  // [World 改动] 版本号以 importlib.metadata 为准（rapidocr 没有 __version__），并把 onnxruntime 一起报
  let versions = { rapidocr: version === '?' ? null : version, onnxruntime: null };
  try {
    const { ocrVersions } = await import('./asr/ocr-install.js');
    const v2 = await ocrVersions(cmd);
    if (v2?.rapidocr || v2?.onnxruntime) versions = { rapidocr: v2.rapidocr, onnxruntime: v2.onnxruntime };
  } catch { /* 拿不到就保留上面那个 */ }

  if (!deep) {
    let pythonVersion = null;
    try { pythonVersion = (await (await import('./asr/ocr-install.js')).findPython311())?.version ?? null; } catch { /* 忽略 */ }
    return {
      ok: true, python: cmd, engine: 'rapidocr', version: versions.rapidocr ?? version,
      pythonVersion, versions, deep: false, error: null,
    };
  }

  // 真跑一张图：白底 + 一行字，能跑通说明模型/依赖齐全（识别结果对不对不重要）
  const code = 'import json,sys\n'
    + 'from PIL import Image, ImageDraw\n'
    + 'from rapidocr import RapidOCR\n'
    + 'im = Image.new("RGB", (240, 80), "white")\n'
    + 'ImageDraw.Draw(im).text((10, 30), "OCR 123", fill="black")\n'
    + 'im.save(sys.argv[1])\n'
    + 'RapidOCR()(sys.argv[1])\n'
    + 'print(json.dumps({"ok": True}))\n';
  const img = join(osTmp(), `ocr-doctor-${Date.now()}.png`);
  const deepRun = await run(['-c', code, img], timeoutMs);
  try { const { rmSync } = await import('node:fs'); rmSync(img, { force: true }); } catch { /* 忽略 */ }
  if (deepRun.err) {
    const msg = `${String(deepRun.err.message ?? deepRun.err)}${deepRun.stderr ? ` | ${deepRun.stderr.trim().slice(0, 160)}` : ''}`;
    return { ok: false, python: cmd, engine: 'rapidocr', version, deep: true, error: msg.slice(0, 300) };
  }
  return { ok: true, python: cmd, engine: 'rapidocr', version, deep: true, error: null };
}

function osTmp() {
  return process.env.TEMP || process.env.TMP || join(homedir(), 'AppData', 'Local', 'Temp');
}

/**
 * 把裸命令名解析成 PATH 上的绝对路径；给的是路径就原样返回，找不到返回 null。
 * 只为了在体检表里显示"它到底在哪"，不影响执行（执行仍用原来的 bin）。
 */
export function resolveOnPath(bin) {
  const value = String(bin ?? '').trim();
  if (!value) return null;
  if (/[\\/]/.test(value)) return existsSync(value) ? value : null;
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean).map((e) => e.trim());
  for (const dir of (process.env.PATH || '').split(';').filter(Boolean)) {
    for (const ext of ['', ...exts]) {
      const candidate = join(dir, `${value}${ext}`);
      if (ext && !ext.startsWith('.')) continue;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 体检 ffmpeg 与 ffprobe。
 * @returns ffmpeg / ffprobe 两项结果，以及一句给人和模型看的总结。
 */
export async function checkMediaTools({ ffmpeg, ffprobe, ytdlp, tempDir } = {}) {
  const ffmpegBin = resolveBinary(ffmpeg, 'ffmpeg');
  const ffprobeBin = resolveBinary(ffprobe, 'ffprobe');
  const [a, b, c] = await Promise.all([
    probeVersion(ffmpegBin),
    probeVersion(ffprobeBin),
    probeYtdlp({ configured: ytdlp, tempDir }),
  ]);
  return {
    // 顺带给出真实路径：只写 "ffmpeg" 时用户看不出它到底从哪儿来的
    ffmpeg: { ...a, resolved: resolveOnPath(a.bin) },
    ffprobe: { ...b, resolved: resolveOnPath(b.bin) },
    ytdlp: { ...c, resolved: resolveOnPath(c.bin) },
    ok: a.ok && b.ok && c.ok,
    summary: summarize(a, b, c),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * yt-dlp 的体检。它只会 `--version`，而且必须在**可写的临时目录**下跑：
 * PyInstaller 单文件包启动时先把自己解压出去，继承来的 TEMP 在有些机器上是 8.3 短路径，
 * 它建不了目录就直接死在 "Could not create temporary directory"（实测）。
 */
export async function probeYtdlp({ configured = '', tempDir = null } = {}) {
  const explicit = (configured ?? '').trim();
  const env = { ...process.env };
  if (tempDir) {
    env.TMP = tempDir;
    env.TEMP = tempDir;
    // runProcess（yt-dlp 那一路）从注入的根取 TEMP，这里跟着设一次，探测与实际调用走同一套
    setStoryboardPaths({ temp: tempDir });
  }
  if (explicit) {
    const result = await probeVersion(explicit, { argv: ['--version'], env, notFound: '填写的 yt-dlp 路径不对' });
    return { ...result, via: 'config' };
  }
  // 没填就走上游同一套发现顺序：PATH → %APPDATA%\Python\*\Scripts（pip 的位置）
  try {
    const found = await discoverYtdlp({ env });
    return { ok: true, bin: found.bin, path: found.bin, version: found.version, error: null, via: 'auto' };
  } catch (error) {
    return {
      ok: false, bin: 'yt-dlp', path: null, version: null, via: 'auto',
      error: error?.code === 'YTDLP_MISSING' ? '没找到 yt-dlp（PATH 里没有，管理页也没填路径）' : String(error?.message ?? error),
    };
  }
}

function summarize(ffmpeg, ffprobe, ytdlp) {
  const missing = [];
  if (!ffmpeg.ok) missing.push('ffmpeg');
  if (!ffprobe.ok) missing.push('ffprobe');
  if (!ytdlp.ok) missing.push('yt-dlp');
  if (!missing.length) {
    return `ffmpeg ${ffmpeg.version ?? ''}、ffprobe ${ffprobe.version ?? ''}、yt-dlp ${ytdlp.version ?? ''}，都可以用。`;
  }
  const onlyNetwork = missing.length === 1 && missing[0] === 'yt-dlp';
  return `${onlyNetwork ? '本地文件能跑，但贴链接不行' : '缺少可用的 ' + missing.join('、')}：`
    + `缺 ${missing.join('、')}。装好之后把所在目录加进 PATH（或在管理页填绝对路径），回到这里点「重新体检」。不会自动下载任何程序。`;
}

/** 缓存默认落在本 World 的数据目录里，跟 DSH 那边的全局缓存分开。 */
export function defaultCacheDir(dataDir) {
  const env = process.env.DSH_VIDEO_CACHE_DIR;
  if (env) return env;
  return join(dataDir, 'cache');
}

/** cookies 文件只作为「用户自己导出的一串路径」看待，不在这里生成或改写。 */
export function defaultCookiesHint() {
  return join(homedir(), 'cookies', 'bili-cookies.txt');
}
