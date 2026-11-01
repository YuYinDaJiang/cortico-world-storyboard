/**
 * ocr-install.js — OCR 侧的「有什么 / 缺什么」，以及一键安装的分项计划。
 *
 * 本轮只做**检测与文案**：
 *   - Python 判据是**下限**（>= 3.11），不写死 3.11；
 *   - 不给下载、不给安装步骤、不给链接（这是产品决定：用户自己决定装不装）；
 *   - wheel 缓存 / 离线 pip 安装只报状态，真正的下载下一版实现。
 *
 * 为什么要单独一个模块：whisper（AsrService）和 OCR（Python 生态）是两套完全不同的
 * 安装动作，混进一个类只会互相拖累。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { wheelsFor } from './wheel-manifest.js';

import { pythonCandidates } from '../vendor/storyboard/python.js';
import { ocrPython } from '../vendor/storyboard/ocr.js';

const run = promisify(execFile);

/**
 * Python 支持区间：**3.11 – 3.13**。
 * 下限来自 onnxruntime 首次提供 cp311 wheel；上限来自清华源实测——
 * onnxruntime / numpy / pillow / shapely 都只有 cp311/cp312/cp313 的 win_amd64 wheel，
 * cp314/cp315 一个都没有（装了也跑不起来）。所以判据是区间，不是单纯的"下限"。
 */
export const PYTHON_MIN = 3.11;
export const PYTHON_MAX = 3.13;
const MIN_MINOR = 11;   // 3.11
const MAX_MINOR = 13;   // 3.13（别拿 3.13 当 minor 比较——那是浮点数）

/** 纯函数，便于单测：3.11 ≤ v ≤ 3.13 才算可用。 */
export function pythonSupported({ major, minor }) {
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return { ok: false, reason: 'unknown' };
  if (major < 3 || (major === 3 && minor < MIN_MINOR)) return { ok: false, reason: 'too-old' };
  if (major > 3 || (major === 3 && minor > MAX_MINOR)) return { ok: false, reason: 'too-new' };
  return { ok: true, reason: null };
}

const pyEnv = () => ({ ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });

async function versionOf(cmd) {
  try {
    const { stdout } = await run(cmd, ['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'],
      { timeout: 8000, windowsHide: true, env: pyEnv() });
    const [maj, min] = String(stdout).trim().split('.').map(Number);
    return Number.isFinite(maj) && Number.isFinite(min) ? { major: maj, minor: min, raw: String(stdout).trim() } : null;
  } catch {
    return null;
  }
}

/**
 * 找一个 >= 3.11 的 Python。
 * 顺序：显式配置（video.json / 环境变量）→ ASR 用过的 → uv 装的 → PATH。
 * @returns {Promise<{ok:boolean, path:string|null, version:string|null, reason:string|null, seen:{cmd:string,version:string|null}[]}>}
 */
export async function findPython311({ env = process.env, dataDir = null } = {}) {
  const seen = [];
  // 0) World 自己装的那套优先（<dataDir>/ocr/venv），不需要任何配置文件
  if (dataDir) {
    const mine = join(dataDir, 'ocr', 'venv', 'Scripts', 'python.exe');
    if (existsSync(mine)) {
      const v = await versionOf(mine);
      if (v) {
        seen.push({ cmd: mine, version: v.raw });
        if (pythonSupported(v).ok) return { ok: true, path: mine, version: v.raw, reason: null, seen };
      }
    }
  }
  for (const cmd of pythonCandidates({ env })) {
    const v = await versionOf(cmd);          // 不存在/不是 python 就跳过
    if (!v) { seen.push({ cmd, version: null }); continue; }
    seen.push({ cmd, version: v.raw });
    const verdict = pythonSupported(v);
    if (verdict.ok) return { ok: true, path: cmd, version: v.raw, reason: null, seen };
  }
  // 没有任何一个落在 [3.11, 3.13]：区分"太低""太高（还没有 wheel）""根本没有"
  const versions = seen.filter((s) => s.version).map((s) => s.version);
  const newest = versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ?? null;
  let reason = 'none';
  if (newest) {
    const [maj, min] = newest.split('.').map(Number);
    reason = pythonSupported({ major: maj, minor: min }).reason ?? 'unsupported';
  }
  return { ok: false, path: null, version: newest, reason, seen };
}

/** 这台机器上 OCR 两个关键包的版本（装了才返回）。 */
export async function ocrVersions(python) {
  const cmd = python || (await ocrPython().catch(() => null));
  if (!cmd) return { python: null, rapidocr: null, onnxruntime: null, pillow: null, pypinyin: null, zhconv: null };
  const code = 'import json\n'
    + 'from importlib.metadata import version, PackageNotFoundError\n'
    + 'def v(n):\n'
    + '    try:\n'
    + '        return version(n)\n'
    + '    except Exception:\n'
    + '        return None\n'
    + 'print(json.dumps({k: v(n) for k, n in '
    + '[("rapidocr","rapidocr"),("onnxruntime","onnxruntime"),("pillow","pillow"),'
    + '("pypinyin","pypinyin"),("zhconv","zhconv")]}))\n';
  try {
    const { stdout } = await run(cmd, ['-c', code], { timeout: 20000, windowsHide: true, env: pyEnv() });
    const got = JSON.parse(String(stdout).trim() || '{}');
    return { python: cmd, ...got };
  } catch {
    return { python: cmd, rapidocr: null, onnxruntime: null, pillow: null, pypinyin: null, zhconv: null };
  }
}

/** wheel 缓存现状：只数文件，不校验 sha（校验留给下载器那一版）。 */
export function wheelCacheState(dir) {
  try {
    const files = readdirSync(dir).filter((n) => n.endsWith('.whl'));
    return { dir, count: files.length, present: files.length > 0 };
  } catch {
    return { dir, count: 0, present: false };
  }
}

/**
 * 一键安装的五项计划。whisper 的两项由调用方（World）从 AsrService 拿，这里只管后三项。
 * state: 'skip' | 'install' | 'blocked' | 'pending'
 */
export async function ocrInstallPlan({ dataDir, env = process.env } = {}) {
  const py = await findPython311({ env });
  const versions = py.ok ? await ocrVersions(py.path) : { rapidocr: null, onnxruntime: null };
  const wheels = wheelCacheState(join(dataDir, 'ocr', 'wheels'));

  const pythonItem = py.ok
    ? { state: 'skip', note: `已找到 Python ${py.version}`, path: py.path, version: py.version }
    : {
      state: 'blocked',
      note: py.reason === 'too-old'
        ? `Python ${py.version} 低于 ${PYTHON_MIN}（OCR 需要 ${PYTHON_MIN}–${PYTHON_MAX}；可自行安装或用别的方式装 rapidocr）`
        : py.reason === 'too-new'
          ? `Python ${py.version} 高于 ${PYTHON_MAX}，该版本暂无可用 wheel（OCR 需要 ${PYTHON_MIN}–${PYTHON_MAX}）`
          : `未找到 Python ${PYTHON_MIN}–${PYTHON_MAX}（安装 OCR 需要这个区间；可自行安装或用别的方式装 rapidocr）`,
      path: null,
      version: py.version,
    };

  const ready = Boolean(py.ok && versions.rapidocr && versions.onnxruntime);
  const pipItem = ready
    ? { state: 'skip', note: `已装 rapidocr ${versions.rapidocr} · onnxruntime ${versions.onnxruntime}` }
    : { state: 'pending', note: py.ok ? 'OCR 引擎未装（下一版实现离线安装）' : '缺 Python，暂不可装' };

  const wheelsItem = {
    state: wheels.present ? 'skip' : 'pending',
    note: wheels.present
      ? `缓存 ${wheels.count} 个 wheel（${wheels.dir}）`
      : 'wheel 缓存为空（下一版实现下载）',
  };

  return {
    python: pythonItem,
    wheels: wheelsItem,
    pip: pipItem,
    ready,
    versions,
    candidates: py.seen,
  };
}

/* ------------------------------------------------------------------ 安装 */

const LOG_LINES = [];
function logLine(text) {
  LOG_LINES.push(`${new Date().toISOString()}  ${text}`);
}

function appendLog(file, text) {
  try { appendFileSync(file, `${text}\n`, 'utf8'); } catch { /* 日志写不了不影响安装 */ }
}

function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** 缓存现状（按文件名+大小比对；sha 留给安装时再核）。 */
export function wheelsStateFor(dataDir, minor = 11) {
  const dir = join(dataDir, 'ocr', 'wheels');
  const need = wheelsFor(minor);
  let present = 0; let bytes = 0;
  const missing = [];
  for (const e of need) {
    try {
      const st = statSync(join(dir, e.file));
      if (st.size === e.bytes) { present += 1; bytes += st.size; } else missing.push(e.file);
    } catch { missing.push(e.file); }
  }
  return { dir, total: need.length, present, bytes, missing };
}

/**
 * 下载缺的 wheel：文件名 + 大小 + sha256 三重比对；对不上只重下那一个文件。
 * 每个文件最多 2 次。
 */
export async function ensureWheels({ dataDir, minor = 11, onProgress = () => {}, logPath = null } = {}) {
  const dir = join(dataDir, 'ocr', 'wheels');
  mkdirSync(dir, { recursive: true });
  const need = wheelsFor(minor);
  const result = { total: need.length, downloaded: 0, skipped: 0, bytes: 0, failed: [] };

  for (const [i, e] of need.entries()) {
    const target = join(dir, e.file);
    try {
      const st = statSync(target);
      if (st.size === e.bytes && sha256Of(target) === e.sha256) {
        result.skipped += 1;
        logLine(`skip ${e.file}（已缓存且 sha 一致）`);
        onProgress({ phase: 'wheels', done: i + 1, total: need.length, file: e.file, state: 'skip' });
        continue;
      }
      rmSync(target, { force: true });
      logLine(`redownload ${e.file}（大小或 sha 不符）`);
    } catch { /* 没有就下 */ }

    let ok = false;
    for (let attempt = 1; attempt <= 2 && !ok; attempt += 1) {
      try {
        const res = await fetch(e.url, { headers: { 'user-agent': 'node' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length !== e.bytes) throw new Error(`大小不符：期望 ${e.bytes}，收到 ${buf.length}`);
        const got = createHash('sha256').update(buf).digest('hex');
        if (got !== e.sha256) throw new Error(`sha256 不符：期望 ${e.sha256.slice(0, 12)}…，收到 ${got.slice(0, 12)}…`);
        const part = `${target}.part`;
        writeFileSync(part, buf);
        renameSync(part, target);
        result.downloaded += 1;
        result.bytes += buf.length;
        ok = true;
        logLine(`download ${e.file}（${(buf.length / 1048576).toFixed(1)} MB）`);
        onProgress({ phase: 'wheels', done: i + 1, total: need.length, file: e.file, state: 'download', bytes: buf.length });
      } catch (error) {
        logLine(`fail ${e.file} 第 ${attempt} 次：${String(error?.message ?? error)}`);
        if (attempt < 2) await new Promise((r) => { setTimeout(r, 200); });
      }
    }
    if (!ok) result.failed.push(e.file);
  }

  if (logPath) appendLog(logPath, LOG_LINES.splice(0).join('\n'));
  return result;
}

/** 建 venv + 离线 pip 装（日志落 <dataDir>/ocr/install.log）。 */
export async function ensureVenv({ dataDir, python, onProgress = () => {} } = {}) {
  if (!python) throw new Error('没有可用的 Python 3.11–3.13，无法创建 venv');
  const root = join(dataDir, 'ocr');
  mkdirSync(root, { recursive: true });
  const logPath = join(root, 'install.log');
  const venv = join(root, 'venv');
  const py = join(venv, 'Scripts', 'python.exe');
  const out = { created: false, installed: false, skipped: false, versions: null, logPath };

  const probe = async () => {
    try {
      const { stdout } = await run(py, ['-c', 'import json,importlib.metadata as m;'
        + 'print(json.dumps({"rapidocr":m.version("rapidocr"),"onnxruntime":m.version("onnxruntime"),"pypinyin":m.version("pypinyin")}))'],
      { timeout: 30000, env: pyEnv(), windowsHide: true });
      return JSON.parse(String(stdout).trim());
    } catch { return null; }
  };

  const existing = await probe();
  if (existing?.rapidocr && existing?.onnxruntime && existing?.pypinyin) {
    out.skipped = true;
    out.versions = existing;
    appendLog(logPath, `${new Date().toISOString()}  skip venv（已能 import rapidocr ${existing.rapidocr} / onnxruntime ${existing.onnxruntime}）`);
    return out;
  }

  if (!existsSync(py)) {
    onProgress({ phase: 'venv', state: 'create' });
    appendLog(logPath, `${new Date().toISOString()}  venv create：${python} -> ${venv}`);
    const r = await run(python, ['-m', 'venv', venv], { timeout: 120000, env: pyEnv(), windowsHide: true })
      .catch((e) => ({ stderr: String(e?.message ?? e), stdout: '' }));
    if (!existsSync(py)) throw new Error(`venv 创建失败：${String(r?.stderr ?? '').slice(0, 300)}`);
    out.created = true;
  }

  onProgress({ phase: 'pip', state: 'start' });
  const args = ['-m', 'pip', 'install', '--no-index', '--find-links', join(dataDir, 'ocr', 'wheels'),
    'rapidocr', 'onnxruntime', 'pillow', 'pypinyin', 'zhconv'];
  appendLog(logPath, `${new Date().toISOString()}  pip ${args.join(' ')}`);
  let pipOut = '';
  try {
    const r = await run(py, args, { timeout: 300000, env: pyEnv(), windowsHide: true, maxBuffer: 16 << 20 });
    pipOut = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  } catch (error) {
    pipOut = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim() || String(error?.message ?? error);
  }
  appendLog(logPath, pipOut || '(pip 无输出 —— 视为失败)');
  if (!pipOut) throw new Error('pip 无输出（疑似空转），已按失败处理');

  const after = await probe();
  if (!after?.rapidocr || !after?.onnxruntime) {
    throw new Error(`pip 结束后仍无法 import rapidocr/onnxruntime（见 ${logPath}）`);
  }
  out.installed = true;
  out.versions = after;
  appendLog(logPath, `${new Date().toISOString()}  ok rapidocr ${after.rapidocr} · onnxruntime ${after.onnxruntime}`);
  return out;
}

/** 一步到位：找 Python → 下 wheel → 建 venv → 离线装。 */
export async function installOcr({ dataDir, onProgress = () => {}, minorHint = null } = {}) {
  const py = await findPython311({ dataDir });
  if (!py.ok) return { ok: false, reason: py.reason ?? 'no-python', python: null };
  const minor = minorHint ?? Number(py.version.split('.')[1]);
  const wheels = await ensureWheels({ dataDir, minor, onProgress, logPath: join(dataDir, 'ocr', 'install.log') });
  if (wheels.failed.length) return { ok: false, reason: 'wheel-download-failed', failed: wheels.failed, python: py.path };
  let venv;
  try {
    venv = await ensureVenv({ dataDir, python: py.path, onProgress });
  } catch (error) {
    return { ok: false, reason: 'venv-install-failed', error: String(error?.message ?? error), python: py.path, wheels };
  }
  return { ok: true, python: py.path, minor, wheels, venv };
}

export default { findPython311, ocrVersions, wheelCacheState, ocrInstallPlan, PYTHON_MIN, installOcr };
void existsSync;
