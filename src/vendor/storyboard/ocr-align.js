/**
 * ocr-align.js — 用画面硬字幕改正 ASR 里的同音错字（自适应行框 + 多帧投票）。
 *
 * 和旧实现（ocr-subs.js 里的应该替换整句）的区别：
 *   旧：整句比对，命中就整句换成 OCR —— 门槛糊、容易引入来源不明的句子；
 *   新：只改「拼音相同、汉字不同」的字，且必须多帧一致：
 *     ① 宽带上取 4 帧，bridge lines 模式拿每帧所有文字行的 bbox
 *     ② 每帧挑拼音最像该句 ASR 的那一行（排除台标/大字：只看画面下半部、行高 ≤16%）
 *     ③ 按行框裁出来（上下各留 0.15 行高）放大 2×，再识别一次
 *     ④ 逐字投票：≥2 票、conf ≥0.75 才采纳
 *     ⑤ 闸门：连续 ≥2 字，或单字但 conf ≥0.85；简繁/异体先归一化（zhconv）
 *
 * 依赖（都通过 python，缺失时**优雅退化**，不抛错）：
 *   rapidocr（必需，没有就 no-ocr-engine）、pypinyin（必需，没有就 no-pinyin）、zhconv（可选，没有就不做简繁归一）
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { OCR_BRIDGE, ocrPython } from './ocr.js';
import { storyboardTempRoot } from './world-paths.js';

const execFileP = promisify(execFile);

const CJK = /[\u4e00-\u9fa5]/;
const charsOf = (s) => [...String(s ?? '')].filter((c) => CJK.test(c));
const FRACS = [0.15, 0.4, 0.65, 0.9];
const MIN_CONF = 0.75;

function py(code, args, timeout = 180000) {
  return execFileP(process.env.DSH_OCR_PYTHON || 'python', ['-c', code, ...args], {
    timeout, maxBuffer: 32 << 20,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  }).then((r) => r.stdout);
}

/** 一次探测：bridge 在不在、rapidocr / pypinyin / zhconv 能不能 import。 */
export async function ocrCapabilities() {
  const python = await ocrPython().catch(() => null);
  if (!python) return { python: null, rapidocr: false, pypinyin: false, zhconv: false, bridge: existsSync(OCR_BRIDGE) };
  const code = 'import json\n'
    + 'out={}\n'
    + 'for m in ("rapidocr","pypinyin","zhconv"):\n'
    + '    try:\n'
    + '        __import__(m); out[m]=True\n'
    + '    except Exception:\n'
    + '        out[m]=False\n'
    + 'print(json.dumps(out))\n';
  try {
    const raw = await execFileP(python, ['-c', code], {
      timeout: 60000, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    const caps = JSON.parse(String(raw.stdout).trim() || '{}');
    return { python, rapidocr: caps.rapidocr === true, pypinyin: caps.pypinyin === true, zhconv: caps.zhconv === true, bridge: existsSync(OCR_BRIDGE) };
  } catch {
    return { python, rapidocr: false, pypinyin: false, zhconv: false, bridge: existsSync(OCR_BRIDGE) };
  }
}

async function runBridge(python, mode, images) {
  const code = `import json,runpy,sys,io,contextlib
mod = runpy.run_path(sys.argv[1])
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    mod['${mode}'](sys.argv[2:])
print(buf.getvalue())`;
  const { stdout } = await execFileP(python, ['-c', code, OCR_BRIDGE, ...images], {
    timeout: 240000, maxBuffer: 32 << 20,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  return JSON.parse(String(stdout).trim() || '{}');
}

/** 批量：简体归一 + 拼音。zhconv 缺失时只是不归一。 */
async function convert(python, list, withZhconv) {
  const f = join(storyboardTempRoot(), `ocr-conv-${process.pid}.json`);
  writeFileSync(f, JSON.stringify(list), 'utf8');
  const code = 'import json,sys\n'
    + 'from pypinyin import lazy_pinyin\n'
    + `try:\n    import zhconv\nexcept Exception:\n    zhconv=None\n`
    + 'data=json.load(open(sys.argv[1],encoding="utf-8"))\n'
    + 'clean=["".join(x) if isinstance(x,list) else (x if isinstance(x,str) else "") for x in data]\n'
    + `simp=[zhconv.convert(s,"zh-cn") if (${withZhconv ? 'True' : 'False'} and zhconv) else s for s in clean]\n`
    + 'print(json.dumps({"simp":simp,"py":[lazy_pinyin(s,style=0) for s in simp]}, ensure_ascii=False))\n';
  const { stdout } = await execFileP(python, ['-c', code, f], {
    timeout: 120000, maxBuffer: 32 << 20,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  rmSync(f, { force: true });
  return JSON.parse(String(stdout));
}

function lcs(a, b) {
  const m = a.length; const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i += 1) for (let j = 1; j <= n; j += 1) {
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  }
  const out = []; let i = m; let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { out.push([i - 1, j - 1]); i -= 1; j -= 1; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i -= 1; else j -= 1;
  }
  return out.reverse();
}
const sim = (a, b) => (a.length && b.length ? lcs(a, b).length / Math.max(a.length, b.length) : 0);

/**
 * 逐字对账：把 OCR 读到的字投到 ASR 句子上，返回替换后的字符数组。
 *
 * [World 修复] 旧实现只用 pinyin LCS 的匹配对投票——**拼音不同的字永远进不了投票**。
 * 「审判敌人节」(pan) vs 「神探狄仁杰」(tan) 里「判/探」拼音不同 → 这一列没有票 →
 * 保留 ASR 的「判」，于是输出「神判」这种**两个源都没有**的混血句子（bug）。
 *
 * 修法：在相邻两个 LCS 锚点之间，如果**两侧缺口等长**，就把缺口里逐位配对投票；
 * 缺口长度不等（ASR 多字/少字）时**不投票**，避免整体串位。
 */
export function reconcileLine({ baseChars, basePy, ocr = [] }) {
  const votes = new Map();
  const add = (i, ch, conf) => {
    if (!votes.has(i)) votes.set(i, []);
    votes.get(i).push({ ch, conf });
  };
  for (const u of ocr) {
    const chars = [...u.text];
    const pairs = lcs(basePy, u.py);
    for (const [i, j] of pairs) {
      const oc = chars[j]; const ac = baseChars[i];
      if (!oc || oc === ac) continue;
      add(i, oc, u.conf);
    }
    // 缺口补票：锚点之间的"拼音不同、长度相同"区域
    const anchors = [[-1, -1], ...pairs, [baseChars.length, chars.length]];
    for (let n = 0; n < anchors.length - 1; n += 1) {
      const [i1, j1] = anchors[n]; const [i2, j2] = anchors[n + 1];
      const gi = i2 - i1 - 1; const gj = j2 - j1 - 1;
      if (gi <= 0 || gi !== gj) continue;
      for (let d = 1; d <= gi; d += 1) {
        const i = i1 + d; const j = j1 + d;
        const oc = chars[j]; const ac = baseChars[i];
        if (!oc || oc === ac) continue;
        add(i, oc, u.conf);
      }
    }
  }

  const chosen = new Map();
  for (const [pos, arr] of votes) {
    const tally = new Map();
    for (const v of arr) tally.set(v.ch, (tally.get(v.ch) ?? 0) + 1);
    const [ch, count] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (count >= 2) chosen.set(pos, { ch, conf: Math.max(...arr.filter((v) => v.ch === ch).map((v) => v.conf)) });
  }

  const next = [...baseChars];
  let rs = null; let prev = null;
  const applyRun = () => {
    if (rs === null) return;
    const len = prev - rs + 1;
    if (len >= 2) {
      for (let q = rs; q <= prev; q += 1) next[q] = chosen.get(q).ch;
    } else if ((chosen.get(rs).conf ?? 0) >= 0.85 && rs >= 0 && rs + 1 <= baseChars.length) {
      next[rs] = chosen.get(rs).ch;
    }
    rs = null;
  };
  for (const q of [...chosen.keys()].sort((a, b) => a - b)) {
    if (prev !== null && q === prev + 1) { prev = q; continue; }
    applyRun(); rs = q; prev = q;
  }
  applyRun();

  const diffs = [];
  for (let i = 0; i < baseChars.length; i += 1) {
    if (baseChars[i] !== next[i]) diffs.push({ i, was: baseChars[i], now: next[i], py: basePy[i] });
  }
  return { next, diffs };
}

function grab(ffmpegPath, input, at, out, vf) {
  const args = ['-hide_banner', '-v', 'error', '-y', '-ss', String(Math.max(0, at)), '-i', input, '-frames:v', '1'];
  if (vf) args.push('-vf', vf);
  args.push('-q:v', '2', out);
  return execFileP(ffmpegPath, args, { timeout: 60000 });
}

/**
 * 主入口。
 * @returns {Promise<{status:string, engine?:string, checked:number, fixed:number, chars:number,
 *                    summary?:string, changes?:Array, a2?:Array, segments?:Array}>}
 * 永远不抛：任何环境问题都返回一个带 status 的对象，由调用方写进清单。
 */
export async function alignTranscript({
  input, ffmpegPath = 'ffmpeg', segments = [], winStart = 0, winDur = Infinity, maxItems = 16,
} = {}) {
  const list = Array.isArray(segments) ? segments : [];
  if (!list.length) return { status: 'skipped', reason: 'no-transcript', checked: 0, fixed: 0, chars: 0 };

  const caps = await ocrCapabilities();
  if (!caps.bridge) return { status: 'skipped', reason: 'bridge-missing', checked: 0, fixed: 0, chars: 0 };
  if (!caps.python || !caps.rapidocr) return { status: 'skipped', reason: 'no-ocr-engine', checked: 0, fixed: 0, chars: 0 };
  if (!caps.pypinyin) return { status: 'skipped', reason: 'no-pinyin', checked: 0, fixed: 0, chars: 0 };

  const n = Math.min(Math.max(1, maxItems), list.length);
  const step = list.length / n;
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const idx = Math.floor(i * step);
    const seg = list[idx];
    if (!Number.isFinite(seg?.from) || !Number.isFinite(seg?.to)) continue;
    samples.push({ idx, seg });
  }
  if (!samples.length) return { status: 'skipped', reason: 'no-samples', checked: 0, fixed: 0, chars: 0 };

  // 父目录不一定存在（World 首次跑、或脚本直接调）——先建出来再 mkdtemp
  mkdirSync(storyboardTempRoot(), { recursive: true });
  const dir = mkdtempSync(join(storyboardTempRoot(), 'ocr-align-'));
  try {
    const frames = [];
    for (const [k, s] of samples.entries()) {
      const dur = Math.max(0.2, s.seg.to - s.seg.from);
      for (const [j, frac] of FRACS.entries()) {
        const at = s.seg.from + dur * frac;
        const file = join(dir, `f${k}-${j}.jpg`);
        await grab(ffmpegPath, input, at, file, null);
        frames.push({ k, at, file });
      }
    }

    const det = await runBridge(caps.python, 'lines', frames.map((f) => f.file));
    if (!det.ok) return { status: 'failed', reason: 'lines-failed', checked: 0, fixed: 0, chars: 0 };

    const asrRaw = samples.map((s) => charsOf(s.seg.text).join(''));
    const lineTexts = [];
    const entries = [];
    for (const [i, it] of (det.items ?? []).entries()) {
      const fh = it.size?.[1] ?? 720;
      for (const ln of it.lines ?? []) {
        const h = ln.y1 - ln.y0;
        if (h <= 0 || h > fh * 0.16) continue;
        if ((ln.y0 + ln.y1) / 2 < fh * 0.55) continue;
        const t = charsOf(ln.text).join('');
        if (t.length < 2 || t.length > 40) continue;
        lineTexts.push(t);
        entries.push({ k: frames[i].k, at: frames[i].at, ln, ci: lineTexts.length - 1, fh });
      }
    }
    const conv = await convert(caps.python, [...asrRaw, ...lineTexts], caps.zhconv);
    const asrSimp = conv.simp.slice(0, asrRaw.length);
    const asrPy = conv.py.slice(0, asrRaw.length);
    const lineSimp = conv.simp.slice(asrRaw.length);
    const linePy = conv.py.slice(asrRaw.length);

    const picks = samples.map(() => []);
    for (const e of entries) {
      const s = sim(asrPy[e.k], linePy[e.ci]);
      const score = s * 2 + (e.ln.conf >= MIN_CONF ? 0.5 : 0) + (lineSimp[e.ci].length >= 2 ? 0.3 : 0);
      picks[e.k].push({ ...e, s, score, text: lineSimp[e.ci] });
    }

    const crops = [];
    for (const [k, list2] of picks.entries()) {
      list2.sort((a, b) => b.score - a.score);
      for (const [j, p] of list2.slice(0, FRACS.length).entries()) {
        const h = p.ln.y1 - p.ln.y0;
        const pad = h * 0.15;
        const y0 = Math.max(0, p.ln.y0 - pad);
        const y1 = Math.min(p.fh ?? 720, p.ln.y1 + pad);
        if (y1 - y0 < 6) continue;
        const file = join(dir, `c${k}-${j}.jpg`);
        await grab(ffmpegPath, input, p.at, file,
          `crop=iw:${Math.round(y1 - y0)}:0:${Math.round(y0)},scale=iw*2:-2:flags=lanczos`);
        crops.push({ k, at: p.at, file });
      }
    }
    if (!crops.length) return { status: 'skipped', reason: 'no-subtitle-band', checked: samples.length, fixed: 0, chars: 0 };

    const read = await runBridge(caps.python, 'read', crops.map((c) => c.file));
    const conv2 = await convert(caps.python, (read.items ?? []).map((it) => charsOf(it.text).join('')), caps.zhconv);

    const out = list.map((x) => ({ ...x }));
    const changes = [];
    const a2 = [];
    let correctedLines = 0; let correctedChars = 0;

    for (const [k, s] of samples.entries()) {
      const mine = crops.map((c, i) => (c.k === k
        ? { ...c, text: conv2.simp[i], py: conv2.py[i], conf: read.items[i]?.conf ?? 0 }
        : null)).filter(Boolean);
      const usable = mine.filter((c) => c.conf >= MIN_CONF && sim(asrPy[k], c.py) >= 0.5);
      const base = [...asrSimp[k]];

      // A2：OCR 明显更完整（conf 高、字数多）→ 只标记，不改句
      const best = mine.slice().sort((a, b) => b.conf - a.conf)[0];
      if (best && best.conf >= 0.9 && [...best.text].length >= base.length * 1.3) {
        a2.push({ from: s.seg.from, was: base.join(''), ocr: best.text, conf: best.conf });
        void usable;
        continue;
      }
      if (!usable.length) continue;

      const { next, diffs } = reconcileLine({
        baseChars: base,
        basePy: asrPy[k],
        ocr: usable.map((u) => ({ text: u.text, py: u.py, conf: u.conf })),
      });
      const was = base.join('');
      const now = next.join('');
      if (now !== was) {
        correctedLines += 1;
        correctedChars += diffs.length;
        changes.push({ from: s.seg.from, was, now, conf: Math.round(Math.max(...usable.map((u) => u.conf)) * 1000) / 1000, diffs });
        // 回写：保留原句的分句标点，只替换汉字位置
        const orig = s.seg.text;
        const origChars = charsOf(orig);
        let ci2 = 0;
        const rebuilt = [...orig].map((ch) => (CJK.test(ch) ? (next[ci2++] ?? ch) : ch)).join('');
        out[s.idx] = { ...s.seg, text: rebuilt, ocrFixed: diffs.length };
      }
    }

    const summary = `ocr: corrected ${correctedLines} lines / ${correctedChars} chars `
      + `(engine=rapidocr, conf≥0.85)`;
    return {
      status: correctedLines ? 'applied' : 'checked',
      engine: 'rapidocr',
      checked: samples.length,
      fixed: correctedLines,
      chars: correctedChars,
      summary,
      changes: changes.slice(0, 5),
      a2: a2.slice(0, 3),
      segments: out,
      basedOn: 'source',
    };
  } catch (error) {
    return { status: 'failed', reason: String(error?.message ?? error).slice(0, 200), checked: 0, fixed: 0, chars: 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default { alignTranscript, ocrCapabilities };
