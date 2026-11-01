/**
 * 本地 ASR 服务：whisper.cpp 的 whisper-server + 一层自己写的 OpenAI 兼容代理。
 *
 * 为什么要有代理：whisper-server 自己的端点在 1.7.6 上不保证是 OpenAI 形状（实测只有
 * /inference，返回 verbose_json 但路径不同）。代理对外给 /v1/audio/transcriptions，
 * 对内转发 /inference，这样 vendored 的 asr.js 一行不用改；顺便提供 /health 给体检用。
 *
 * 所有东西都在 <dataDir>/asr 下：bin / models / tmp / logs。
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const RUNTIME_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-blas-bin-x64.zip';
const MODEL_BASE = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main';
/**
 * 只有"能从网上下"的档位才写在这里（给「安装依赖」用）。
 * 能选哪些模型**不看这张表**——看 models 目录里实际有哪些 .bin，
 * 所以以后加档位只要把文件丢进去，它就会出现在下拉里。
 */
const DOWNLOADABLE = {
  small: { file: 'ggml-small-q5_1.bin', bytes: 190_000_000 },
  medium: { file: 'ggml-medium-q5_0.bin', bytes: 540_000_000 },
};
/** 老配置里存的是 small / medium 这种短名，映射到文件名。 */
const ALIASES = { small: 'ggml-small-q5_1.bin', medium: 'ggml-medium-q5_0.bin' };

export const DEFAULT_MODEL = 'ggml-small-q5_1.bin';

/**
 * 默认识别提示词。写成**词表**而不是句子：whisper 把 prompt 当上文续写，
 * 长句容易被"念"进结果。开头半句压简繁与标点，后面按出现频率排专名。
 * 约 60 字，落在 224 token 的 prompt 预算里很宽裕。
 */
export const DEFAULT_ASR_PROMPT =
  '以下是普通话简体中文字幕。大肥鱼，B站，分镜，插件，转写，字幕，切点，格子，视频，音频，显存，DeepSeek，ffmpeg。';

/** 运行时版本：写进 install.json，体检的「版本」列用它。 */
export const RUNTIME_VERSION = 'whisper.cpp v1.7.6 (blas x64)';

export class AsrService {
  constructor({ dataDir, port = 18760, model = DEFAULT_MODEL, log = null }) {
    this.dataDir = dataDir;
    this.port = port;
    this.backendPort = port + 1;
    /** 存的是**文件名**（ggml-*.bin），不是档位枚举。 */
    this.model = ALIASES[model] ?? model ?? DEFAULT_MODEL;
    this.log = log;
    this.server = null;      // whisper-server 子进程
    this.proxy = null;       // 我们的 http 服务
    this.installing = null;  // {phase, done, total}
    this.switching = null;   // {to}：正在换模型 / 重启
    this.lastInstall = null; // {at, installed[], skipped[], error?}：上一次安装的对账结果
  }

  paths() {
    const root = join(this.dataDir, 'asr');
    return {
      root,
      bin: join(root, 'bin'),
      models: join(root, 'models'),
      tmp: join(root, 'tmp'),
      logs: join(root, 'logs'),
      manifest: join(root, 'install.json'),
    };
  }

  /** 目录里实际有哪些模型。下拉与体检都读它。 */
  listModels() {
    const dir = this.paths().models;
    let files = [];
    try { files = readdirSync(dir).filter((f) => /\.bin$/i.test(f)); } catch { return []; }
    return files
      .map((file) => {
        let bytes = 0;
        try { bytes = statSync(join(dir, file)).size; } catch { /* 刚被删掉 */ }
        const id = file.replace(/\.bin$/i, '');
        return { id, file, bytes, label: `${id} (${Math.round(bytes / 1048576)} MB)` };
      })
      .sort((a, b) => a.bytes - b.bytes);
  }

  /** 当前选中的模型文件；选中的不在盘上时退到目录里的第一个。 */
  currentModel() {
    const models = this.listModels();
    return models.find((m) => m.file === this.model) ?? models[0] ?? null;
  }

  installed() {
    return {
      runtime: Boolean(this.binPath()),
      model: Boolean(this.currentModel()),
      manifest: this.readManifest(),
    };
  }

  binPath() {
    const p = this.paths().bin;
    if (!existsSync(p)) return null;
    const stack = [p];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.toLowerCase() === 'whisper-server.exe') return full;
      }
    }
    return null;
  }

  readManifest() {
    try { return JSON.parse(readFileSync(this.paths().manifest, 'utf8')); } catch { return null; }
  }

  status() {
    const installed = this.installed();
    const current = this.currentModel();
    return {
      installed: installed.runtime && installed.model,
      runtime: installed.runtime,
      modelFile: installed.model,
      model: current?.file ?? null,
      modelLabel: current?.label ?? '（models 目录里没有 .bin）',
      modelPath: current ? join(this.paths().models, current.file) : null,
      models: this.listModels(),
      port: this.port,
      backendPort: this.backendPort,
      running: Boolean(this.server && this.server.exitCode === null),
      proxy: Boolean(this.proxy),
      baseUrl: `http://127.0.0.1:${this.port}/v1`,
      installing: this.installing,
      switching: this.switching,
      manifest: installed.manifest,
      // 体检「版本」列用：装了才有值
      runtimeVersion: installed.manifest?.runtime ?? (installed.runtime ? RUNTIME_VERSION : null),
      binPath: this.binPath(),
      // 逐项对账用：现在点「安装依赖」会做什么
      plan: {
        runtime: installed.runtime ? 'skip' : 'install',
        model: this.modelReady(this.model) ? 'skip' : 'install',
      },
      // 可安装的档位清单：体检里的"模型"几行、以及两颗安装按钮都读它
      catalog: Object.values(DOWNLOADABLE).map((d) => ({
        file: d.file,
        id: d.file.replace(/\.bin$/, ''),
        label: `${d.file.replace(/\.bin$/, '')} (${Math.round(d.bytes / 1048576)} MB)`,
        bytes: d.bytes,
        installed: this.modelReady(d.file),
        selected: d.file === this.model,
      })),
      lastInstall: this.lastInstall ?? null,
    };
  }

  /* ------------------------------------------------------------- 安装 */

  /**
   * 逐项对账、只补缺的：
   *   - 运行时：`whisper-server.exe` 在 → 跳过整个 zip 下载
   *   - 模型：目标 .bin 在且大小合理 → 跳过；否则从断点续传
   * 回执分「已有 / 新装」两栏，写进 lastInstall。
   */
  async install(onProgress = () => {}, { model = this.model } = {}) {
    if (this.installing) throw new Error('已经有一个安装在进行中');
    const p = this.paths();
    for (const dir of [p.root, p.bin, p.models, p.tmp, p.logs]) mkdirSync(dir, { recursive: true });
    const target = ALIASES[model] ?? model;

    const needRuntime = !this.binPath();
    const needModel = !this.modelReady(target);
    const skipped = [];
    if (!needRuntime) skipped.push('运行时 whisper.cpp');
    if (!needModel) skipped.push(`模型 ${target}`);

    this.installing = { phase: needRuntime ? 'runtime' : 'model', done: 0, total: 0 };
    const installed = [];
    try {
      // 1) 运行时
      if (needRuntime) {
        const zip = join(p.bin, 'whisper-blas-bin-x64.zip');
        await this.download(RUNTIME_URL, zip, (done, total) => onProgress(this.installing = { phase: 'runtime', done, total }));
        await this.extract(zip, p.bin);
        try { rmSync(zip, { force: true }); } catch { /* 留着也不影响 */ }
        if (!this.binPath()) throw new Error('解压后没找到 whisper-server.exe');
        installed.push('运行时 whisper.cpp');
      }

      // 2) 模型：只下缺的那一个档位（target 可能不是当前选中的那个）
      const modelFile = join(p.models, target);
      if (needModel) {
        const known = Object.values(DOWNLOADABLE).find((d) => d.file === target);
        if (!known) {
          throw new Error(`models 目录里没有 ${target}，它也不是内置可下载档位。`
            + `把对应的 ggml-*.bin 放进 ${p.models} 再试。`);
        }
        await this.download(`${MODEL_BASE}/${target}`, modelFile,
          (done, total) => onProgress(this.installing = { phase: 'model', done, total }));
        if (!this.modelReady(target)) throw new Error('下载完成但文件大小不对，可能不完整；再点一次会接着补。');
        installed.push(`模型 ${target}`);
      }

      // 3) 记账
      writeFileSync(p.manifest, `${JSON.stringify({
        runtime: RUNTIME_VERSION,
        model: this.model,
        file: this.model,
        bytes: existsSync(modelFile) ? statSync(modelFile).size : 0,
        installedAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');

      this.lastInstall = { at: new Date().toISOString(), installed, skipped };
      return this.status();
    } catch (error) {
      this.lastInstall = { at: new Date().toISOString(), installed, skipped, error: String(error?.message ?? error) };
      throw error;
    } finally {
      this.installing = null;
    }
  }

  /**
   * 某个模型文件算不算"已就绪"：
   *   - 内置档位：大小 ≥ 期望值的 90%（半截文件不算）
   *   - 自定义丢进来的：只要存在且 ≥ 1 MB
   * 没有校验和（上游也没发），所以这只能挡住"明显没下完"。
   */
  /** 内置档位的期望字节数（不在表里返回 null）。 */
  expectedModelBytes(file) {
    return Object.values(DOWNLOADABLE).find((d) => d.file === file)?.bytes ?? null;
  }

  modelReady(file) {
    const target = join(this.paths().models, file);
    if (!existsSync(target)) return false;
    let size = 0;
    try { size = statSync(target).size; } catch { return false; }
    const known = Object.values(DOWNLOADABLE).find((d) => d.file === file);
    return known ? size >= known.bytes * 0.9 : size >= 1024 * 1024;
  }

  /** 断点续传：这台机器上 hf-mirror 会中途 ECONNRESET，190 MB 不该从头再来。 */
  async download(url, file, onProgress = () => {}) {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      let have = existsSync(file) ? statSync(file).size : 0;
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          headers: { 'user-agent': 'Mozilla/5.0', ...(have > 0 ? { range: `bytes=${have}-` } : {}) },
        });
        if (res.status === 416) return statSync(file).size;
        if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
        if (have > 0 && res.status === 200) have = 0;
        const total = Number(res.headers.get('content-length') || 0) + have;
        let done = have;
        const body = Readable.fromWeb(res.body);
        body.on('data', (chunk) => { done += chunk.length; onProgress(done, total); });
        await pipeline(body, createWriteStream(file, { flags: have > 0 ? 'a' : 'w' }));
        return done;
      } catch (error) {
        this.log?.warn?.(`ASR 下载重试 ${attempt}/6：${error.message}`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    throw new Error(`下载失败：${url}`);
  }

  /** 解压 zip。Windows 自带 bsdtar，不需要额外依赖。 */
  extract(zip, dir) {
    return new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xf', zip, '-C', dir], { windowsHide: true });
      let err = '';
      child.stderr.on('data', (b) => { err += b.toString(); });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败：${err.trim() || code}`))));
    });
  }

  /* ------------------------------------------------------------- 运行 */

  async start() {
    if (this.server || this.proxy) return this.status();
    const p = this.paths();
    const bin = this.binPath();
    if (!bin) throw new Error('whisper-server 还没装：先在服务页点「安装依赖」');
    // **不要悄悄退回别的档位**：选了 medium 但没下载时，应该明确报"还没装"，
    // 让人去点安装；偷偷换回 small 会让体检显示 skip、用户以为一切正常。
    const modelFile = join(p.models, this.model);
    if (!this.modelReady(this.model)) {
      throw new Error(`选中的模型 ${this.model} 还没下载完整：先在服务页点「安装依赖」（只会补这一个档位）。`);
    }

    const threads = Math.max(4, Math.min(12, (Number(process.env.NUMBER_OF_PROCESSORS) || 8) - 4));
    this.server = spawn(bin, [
      '-m', modelFile, '-t', String(threads), '-l', 'zh',
      '--host', '127.0.0.1', '--port', String(this.backendPort),
    ], {
      cwd: join(bin, '..'),
      windowsHide: true,
      env: { ...process.env, TMP: p.tmp, TEMP: p.tmp },
    });
    this.server.stderr.on('data', (b) => this.log?.info?.(`whisper-server: ${String(b).trim().slice(0, 200)}`));
    this.server.on('exit', (code) => { this.log?.warn?.(`whisper-server 退出：${code}`); this.server = null; });

    await this.waitPort(this.backendPort, 180000);
    this.proxy = this.createProxy(p);
    try {
      await new Promise((resolve, reject) => {
        this.proxy.once('error', reject);
        this.proxy.listen(this.port, '127.0.0.1', resolve);
      });
    } catch (error) {
      // 端口被占：把刚起的后端也收掉，别留一个没人调用的 whisper-server
      this.proxy = null;
      this.server?.kill();
      this.server = null;
      throw new Error(`代理端口 ${this.port} 起不来：${error.message}`);
    }

    // BASE_URL / LANG 由 World 统一管（它才知道有没有配外部端点），这里只设模型相关的。
    process.env.DSH_ASR_MODEL = `whisper-${this.model}`;
    // 普通话 + 简体 + 常见专名的提示。对 whisper 来说这是唯一能"喂词"的口子。
    process.env.DSH_ASR_PROMPT = this.prompt || DEFAULT_ASR_PROMPT;
    return this.status();
  }

  async stop() {
    // 只清模型相关的；BASE_URL 留着（World 会把它指回本地或外部端点），
    // 这样"服务停了"在转写清单里会读成 ECONNREFUSED，而不是"needs a key"。
    delete process.env.DSH_ASR_MODEL;
    delete process.env.DSH_ASR_PROMPT;
    if (this.proxy) {
      const proxy = this.proxy;
      this.proxy = null;
      proxy.closeAllConnections?.();
      await new Promise((resolve) => proxy.close(resolve));
    }
    // **必须等进程真的退出**：不然换模型时新进程会撞上还没释放的 18761，
    // 起来就死，而 waitPort 探测到的其实是上一个还没咽气的进程（实测踩到）。
    const child = this.server;
    this.server = null;
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8000).unref?.())]);
    }
    return this.status();
  }

  async restart() { await this.stop(); return this.start(); }

  /**
   * 换模型 = 换一个进程。whisper.cpp 的模型是在 `-m` 启动参数里加载的，
   * 没有"运行时换模型"的接口，所以只能停掉再起（这也是为什么切换会有几秒空窗）。
   */
  async switchModel(file) {
    const next = ALIASES[file] ?? file;
    if (next === this.model && this.server) return this.status();
    this.switching = { to: next };
    try {
      this.model = next;
      await this.stop();
      return await this.start();
    } finally {
      this.switching = null;
    }
  }

  waitPort(port, ms) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const tick = async () => {
        try {
          await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
          resolve();
        } catch {
          if (Date.now() - t0 > ms) reject(new Error(`whisper-server 在 ${ms / 1000}s 内没起来`));
          else setTimeout(tick, 400);
        }
      };
      tick();
    });
  }

  /** 对外：/v1/audio/transcriptions（OpenAI 形状）+ /health。对内：原样转给 /inference。 */
  createProxy(paths) {
    return createServer(async (req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: Boolean(this.server), model: this.model, port: this.port,
          backend: this.backendPort, uptime: process.uptime(),
        }));
        return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/v1/audio/transcriptions')) {
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          const started = Date.now();
          const upstream = await fetch(`http://127.0.0.1:${this.backendPort}/inference`, {
            method: 'POST',
            headers: { 'content-type': req.headers['content-type'] ?? 'application/octet-stream' },
            body,
            signal: AbortSignal.timeout(15 * 60 * 1000),
          });
          const text = await upstream.text();
          let json;
          try { json = JSON.parse(text); } catch { json = null; }
          if (!json) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `backend returned non-JSON: ${text.slice(0, 200)}` }));
            return;
          }
          // 没有 segments 时退化成整段一句（asr.js 也这么兜底，这里先兜一层更稳）
          if (!Array.isArray(json.segments) || json.segments.length === 0) {
            if (json.text) json.segments = [{ start: 0, end: Number(json.duration) || 0, text: String(json.text) }];
            else json.segments = [];
          }
          json.model = `whisper-${this.model}`;
          json.elapsed_seconds = +((Date.now() - started) / 1000).toFixed(2);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(json));
        } catch (error) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(error?.message ?? error) }));
        }
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  }
}
