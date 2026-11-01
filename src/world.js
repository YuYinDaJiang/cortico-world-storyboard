/**
 * 分镜 · World 实例。
 *
 * 骨架阶段只做四件事：挂载/卸载、一个只读状态工具、管理页的声明与数据面、
 * 以及把管理页上的读写真的落到盘上（配置进 worlds.storyboard，笔记进 state.json）。
 * 视频分镜的算法在这一步刻意不搬：先证明「页能注册出来、状态能读能写」。
 */
import { rm, readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkMediaTools, checkOcr, defaultCacheDir } from './health.js';
import { ocrInstallPlan } from './asr/ocr-install.js';
import { loadState, saveState, statePath } from './state.js';
import { videoStoryboardTool } from './tools/video-storyboard.js';
import { extraTools } from './tools/video-extra.js';
import { AsrService, DEFAULT_ASR_PROMPT } from './asr/service.js';

/** 读本包 package.json 的版本号；读不到就报 'unknown'（不影响任何功能）。 */
function readOwnVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg.version ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

export const STORYBOARD_ID = 'storyboard';
export const LABEL = '分镜';
/** ASR 的密钥不落 config.json，走部署的 .env。 */
export const ASR_KEY_ENV = 'STORYBOARD_ASR_KEY';

const CACHE_COUNT_LIMIT = 20000;

/** 管理页可以写回的配置键；其余一律忽略。 */
const EDITABLE = ['ffmpegPath', 'ffprobePath', 'ytdlpPath', 'asrBaseUrl', 'readCookies', 'cookiesPath', 'cacheDir', 'note', 'asrPrompt', 'whisperModel'];

export class StoryboardWorld {
  constructor(opts) {
    this.id = STORYBOARD_ID;
    /** worlds.storyboard 的活引用：热改的键现读即生效。 */
    this.cfg = opts.cfg;
    this.dataDir = opts.dataDir;
    this.persist = opts.persist;
    this.secret = opts.secret;
    this.storeSecret = opts.storeSecret;
    this.host = null;
    this.started = false;
    /**
     * 这个实例是被哪个版本的代码构造出来的。**World 的 JS 是进程启动时加载的，
     * 改磁盘上的文件不会热更**；有了这两行，工具回执第一句就能看出"跑的是哪版"，
     * 不用再靠文案猜。
     */
    this.buildVersion = readOwnVersion();
    this.loadedAt = new Date().toISOString();
    /** 上一次体检的结果，随进程内存；重启后由第一次打开管理页再算。 */
    this.health = null;
    this.lastState = null;
    /** whisper.cpp 服务；装/起/停都走它，端口与模型来自配置。 */
    this.asr = new AsrService({
      dataDir: this.dataDir,
      port: Number(opts.cfg?.whisperPort) || 18760,
      model: opts.cfg?.whisperModel === 'medium' ? 'medium' : 'small',
    });
    /** 安装是后台跑的（要几分钟），错误留在这里给页面看。 */
    this.asrError = null;
  }

  /* ---------------------------------------------------------------- 生命周期 */

  async start(host) {
    this.host = host;
    this.started = true;
    this.lastState = await loadState(this.dataDir);
    this.asr.log = host?.log ?? null;
    this.asr.prompt = this.asrPromptValue();
    // OCR 用的 Python：优先 World 自己装的 venv（<dataDir>/ocr/venv），这样不需要任何
    // 用户配置文件。已经显式设过环境变量的不覆盖。
    try {
      const mine = join(this.dataDir, 'ocr', 'venv', 'Scripts', 'python.exe');
      if (!process.env.DSH_OCR_PYTHON && existsSync(mine)) process.env.DSH_OCR_PYTHON = mine;
    } catch { /* 探测失败不影响挂载 */ }
    host?.log?.info?.(`${LABEL}: 管理页与工具已就绪（${this.cacheDir()}）`);
    // 装了就把 ASR 起起来。**必须等它起完再算挂载成功**：否则第一个工具调用可能抢在
    // 代理 listen 之前跑，转写会静默退化成 "no-key"（实测踩到过）。
    // 起不来不阻塞挂载，只记错误给页面看。
    // ASR 端点的口径（很重要）：配置里填了 baseUrl 就用它；否则一律指向本地服务，
    // **哪怕服务还没起**。指向本地时失败会读成 "ECONNREFUSED :18760"（= 没启动），
    // 而不是上游默认的远端分支那句 "needs a key" —— 后者会把人带偏。
    const externalBaseUrl = String(this.cfg.asrBaseUrl ?? '').trim();
    process.env.DSH_ASR_BASE_URL = externalBaseUrl || `http://127.0.0.1:${this.asr.port}/v1`;
    process.env.DSH_ASR_LANG = 'zh';
    // 清单里会打印 model=…：别让它在服务没起时显示成上游的默认模型名
    process.env.DSH_ASR_MODEL = `whisper-${this.asr.currentModel()?.id ?? 'small'}`;

    const has = this.asr.installed();
    if (!externalBaseUrl && this.cfg.autoStartAsr !== false && has.runtime && has.model) {
      let timer = null;
      try {
        await Promise.race([
          this.asr.start(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('ASR 启动超过 30 秒')), 30000);
            timer.unref?.();   // 别让这个定时器把进程钉住 30 秒
          }),
        ]);
        host?.log?.info?.(`${LABEL}: 本地 ASR 已启动`);
      } catch (error) {
        this.asrError = String(error?.message ?? error);
        host?.log?.warn?.(`${LABEL}: 本地 ASR 没起来 —— ${this.asrError}`);
        await this.asr.stop().catch(() => {});
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  async stop() {
    this.started = false;
    this.host = null;
    await this.asr.stop().catch(() => {});
  }

  envPromptVars() {
    // 骨架阶段不往系统前缀里加东西；等搬运算法时再补环境提示词。
    return null;
  }

  /* -------------------------------------------------------------------- 工具 */

  tools() {
    // 工具定义只建一次：schema 转换不便宜，而 cfg 是活引用、dataDir 不变。
    this.toolDefs ??= [
      {
        name: 'storyboard_status',
        description: 'Report what the storyboard World can do right now: whether ffmpeg and ffprobe are reachable, where the cache is and how big it is, and whether an ASR endpoint is configured. Read-only. Use it when the person asks why a video cannot be turned into a storyboard yet.',
        tags: ['read'],
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        handler: async () => this.statusText(),
      },
      videoStoryboardTool({ dataDir: this.dataDir, cfg: this.cfg }),
      ...extraTools({
        dataDir: this.dataDir,
        cfg: this.cfg,
        // 工具需要知道"走的是外部端点还是本地服务"，所以把 external 一起带上
        asrStatus: () => ({
          ...this.asr.status(),
          external: Boolean(String(this.cfg.asrBaseUrl ?? '').trim()),
          baseUrl: String(this.cfg.asrBaseUrl ?? '').trim() || `http://127.0.0.1:${this.asr.port}/v1`,
        }),
      }),
    ];
    return this.toolDefs;
  }

  async statusText() {
    const health = await this.checkHealth();
    const cache = await this.cacheUsage();
    const lines = [
      `分镜 v${this.buildVersion}（本进程加载于 ${this.loadedAt}；磁盘上的版本见扩展目录 package.json）`,
      health.summary,
      health.ytdlp?.ok
        ? '贴链接（B 站 / yt-dlp 支持的站点）这条路是通的。'
        : '贴链接这条路走不通：缺 yt-dlp，本地文件不受影响。',
      `缓存：${cache.dir}（${formatBytes(cache.bytes)}，${cache.files} 个文件）`,
      this.asrLine(),
      this.ocrLine(),
      `读取浏览器 cookies：${this.cfg.readCookies ? '开' : '关（默认，匿名取流）'}`,
    ];
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ 管理页 */

  webUi(language = 'zh') {
    const zh = language === 'zh' || language === 'zh-Hant';
    const t = zh ? TEXT.zh : TEXT.en;
    const health = this.health;
    const lamp = {
      label: t.lamp,
      state: !this.started ? 'offline' : health === null ? 'loading' : health.ok ? 'online' : 'error',
      hint: health === null ? t.lampUnchecked : health.summary,
    };
    // 语音识别单独一盏灯：「没装」（offline）和「装了没起」（error）颜色不一样，
    // 不看面板也能在导航上分辨。
    const asr = this.asr.status();
    const external = String(this.cfg.asrBaseUrl ?? '').trim();
    const asrLamp = external
      ? { label: t.lampAsr, state: 'online', hint: `外部端点 ${external}` }
      : {
        label: t.lampAsr,
        state: !asr.installed ? 'offline' : asr.running ? 'online' : 'error',
        hint: !asr.installed
          ? `未安装（找 ${join(this.dataDir, 'asr', 'models')}）`
          : asr.running
            ? `运行中 · 前端 :${asr.port} → whisper :${asr.backendPort} · ${asr.modelLabel}`
            : `已装 ${asr.modelLabel}，服务未启动（:${asr.port} 无监听）`,
      };
    return {
      label: LABEL,
      lamps: [lamp, asrLamp],
      panels: [
        { id: 'service', title: t.panel, description: t.panelHint },
      ],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
    };
  }

  /**
   * 管理页的数据面。所有方法返回 JSON 可序列化的对象；错误用 `{ text, failed: true }` 表示，
   * 让页面能把原话显示出来，而不是一句「请求失败」。
   */
  async invoke(panel, method, args = []) {
    if (panel !== 'service') return { text: `未知面板：${panel}`, failed: true };
    switch (method) {
      case 'state': return this.panelState();
      case 'check': await this.checkHealth(true); return this.panelState();
      case 'save': return this.saveConfig(args[0]);
      case 'saveKey': return this.saveKey(args[0]);
      case 'clearCache': return this.clearCache();
      case 'asrInstall': return this.asrInstall();
      case 'asrInstallTier': return this.asrInstallTier(args[0]);
      case 'ocrDoctor': return this.ocrDoctor();
      case 'ocrCheck': return this.ocrCheck();
      case 'asrStart': return this.asrAction('start', '本地 ASR 已启动');
      case 'asrStop': return this.asrAction('stop', '本地 ASR 已停止');
      case 'asrRestart': return this.asrAction('restart', '本地 ASR 已重启');
      case 'asrRemove': return this.asrRemove();
      case 'asrModel': return this.asrSetModel(args[0]);
      case 'asrPromptReset': return this.asrPromptReset();
      default: return { text: `未知方法：${method}`, failed: true };
    }
  }

  async panelState() {
    const cache = await this.cacheUsage();
    return {
      started: this.started,
      version: this.buildVersion,
      loadedAt: this.loadedAt,
      dataDir: this.dataDir,
      statePath: statePath(this.dataDir),
      health: this.health,
      cache,
      config: {
        ffmpegPath: this.cfg.ffmpegPath ?? '',
        ffprobePath: this.cfg.ffprobePath ?? '',
        ytdlpPath: this.cfg.ytdlpPath ?? '',
        asrBaseUrl: this.cfg.asrBaseUrl ?? '',
        asrModel: this.cfg.asrModel ?? '',
        readCookies: this.cfg.readCookies === true,
        cookiesPath: this.cfg.cookiesPath ?? '',
        cacheDir: this.cfg.cacheDir ?? '',
        note: this.cfg.note ?? '',
        whisperModel: this.cfg.whisperModel ?? 'small',
        whisperPort: Number(this.cfg.whisperPort) || 18760,
        ...this.asrPromptInfo(),
      },
      asr: { ...this.asr.status(), error: this.asrError },
      ocr: this.ocrHealth ?? null,
      hasAsrKey: Boolean(this.secret?.(ASR_KEY_ENV)),
      lastSaved: this.lastState?.lastSaved ?? null,
    };
  }

  asrLine() {
    const s = this.asr.status();
    const where = join(this.dataDir, 'asr', 'models');
    const external = String(this.cfg.asrBaseUrl ?? '').trim();
    if (external) return `ASR：走外部端点 ${external}（服务页里填的 baseUrl）`;
    if (!s.installed) {
      return `本地 ASR：未安装（找的是 ${where}\\*.bin；服务页可一键装 whisper.cpp + 模型，约 200 MB）`;
    }
    if (!s.running) {
      return `本地 ASR：已装 ${s.modelLabel}，服务未启动（前端 :${s.port} 无监听；转写会报 ECONNREFUSED，不是"没有台词"）`;
    }
    return `本地 ASR：运行中 · 前端 :${s.port} → whisper :${s.backendPort} · 当前模型 ${s.modelLabel}`;
  }

  /**
   * 装指定档位（两颗按钮分别对应 small / medium）。
   * 只下载、不改变当前选中的档位；装的就是选中的那个时才顺手把服务起起来。
   */
  async asrInstallTier(file) {
    if (this.asr.installing) return { text: '安装已经在进行中。', asr: this.asr.status() };
    const target = String(file ?? '').trim();
    if (!target) return { text: '没指定要装哪个档位。', failed: true };
    if (this.asr.modelReady(target)) {
      return {
        text: `模型 ${target} 已经有了，不需要下载。`,
        asr: this.asr.status(),
        state: await this.panelState(),
      };
    }
    const bytes = this.asr.expectedModelBytes(target);
    this.asrError = null;
    this.asr.install((progress) => { this.asrProgress = progress; }, { model: target })
      .then(async () => {
        if (target === this.asr.model) await this.asr.start();
      })
      .then(() => this.host?.log?.info?.(`${LABEL}: 模型 ${target} 装好了`))
      .catch((error) => {
        this.asrError = String(error?.message ?? error);
        this.host?.log?.warn?.(`${LABEL}: 安装 ${target} 失败 —— ${this.asrError}`);
      });
    // 五项逐条打印（与 asrInstall 同一份计划）：whisper 运行时 / 模型 / Python / wheel / pip
    const ocrPlan = await ocrInstallPlan({ dataDir: this.dataDir }).catch(() => null);
    const rtReady = Boolean(this.asr.binPath());
    const planText = [
      `  ${rtReady ? '跳过' : '待装'}  whisper 运行时（约 15 MB）`,
      `  ${this.asr.modelReady(target) ? '跳过' : '待装'}  whisper 模型 ${target}${bytes ? `（约 ${Math.round(bytes / 1048576)} MB）` : ''}`,
      `  ${ocrPlan?.python?.state === 'skip' ? '跳过' : '不可用'}  Python 3.11+：${ocrPlan?.python?.note ?? '未检测'}`,
      `  ${ocrPlan?.wheels?.state === 'skip' ? '跳过' : '待实现'}  wheel 缓存：${ocrPlan?.wheels?.note ?? ''}`,
      `  ${ocrPlan?.pip?.state === 'skip' ? '跳过' : '待实现'}  OCR 引擎（离线 pip）：${ocrPlan?.pip?.note ?? ''}`,
    ].join('\n');
    return {
      text: `开始安装：模型 ${target}${bytes ? `（约 ${Math.round(bytes / 1048576)} MB）` : ''}。`
        + `运行时如果已有会跳过；断点会接着上次的进度继续。\n五项计划：\n${planText}`,
      asr: this.asr.status(),
    };
  }

  /** 安装是几分钟的事，放后台跑；页面轮询 state 看进度。 */
  async asrInstall() {
    if (this.asr.installing) return { text: '安装已经在进行中。', asr: this.asr.status() };
    const plan = this.asr.status().plan;
    const need = [];
    if (plan.runtime === 'install') need.push('运行时 whisper.cpp（约 15 MB）');
    if (plan.model === 'install') {
      const bytes = this.asr.expectedModelBytes(this.asr.model);
      need.push(`模型 ${this.asr.model}${bytes ? `（约 ${Math.round(bytes / 1048576)} MB）` : ''}`);
    }
    // OCR 三项只报状态：Python 检测、wheel 缓存、离线 pip（后两项本轮不实现下载）
    const ocrPlan = await ocrInstallPlan({ dataDir: this.dataDir }).catch(() => null);
    const planText = [
      `  ${plan.runtime === 'install' ? '待装' : '跳过'}  whisper 运行时（约 15 MB）`,
      `  ${plan.model === 'install' ? '待装' : '跳过'}  whisper 模型 ${this.asr.model}`,
      `  ${ocrPlan?.python?.state === 'skip' ? '跳过' : '不可用'}  Python 3.11+：${ocrPlan?.python?.note ?? '未检测'}`,
      `  ${ocrPlan?.wheels?.state === 'skip' ? '跳过' : '待实现'}  wheel 缓存：${ocrPlan?.wheels?.note ?? ''}`,
      `  ${ocrPlan?.pip?.state === 'skip' ? '跳过' : '待实现'}  OCR 引擎（离线 pip）：${ocrPlan?.pip?.note ?? ''}`,
    ].join('\n');

    if (!need.length) {
      // 都齐了：不重复下载，直接确保服务起着
      this.asrError = null;
      await this.asr.start().catch((error) => { this.asrError = String(error?.message ?? error); });
      return {
        text: `whisper 侧已就绪，不重复下载。\n五项计划：\n${planText}`,
        asr: this.asr.status(),
        state: await this.panelState(),
      };
    }
    this.asrError = null;
    this.asr.install((progress) => { this.asrProgress = progress; })
      .then(() => this.asr.start())
      .then(() => this.host?.log?.info?.(`${LABEL}: ASR 装好并已启动`))
      .catch((error) => {
        this.asrError = String(error?.message ?? error);
        this.host?.log?.warn?.(`${LABEL}: ASR 安装失败 —— ${this.asrError}`);
      });
    const skipped = [];
    if (plan.runtime === 'skip') skipped.push('运行时 whisper.cpp');
    if (plan.model === 'skip') skipped.push(`模型 ${this.asr.model}`);
    return {
      text: `开始安装：${need.join('、')}。`
        + (skipped.length ? `已有、跳过：${skipped.join('、')}。` : '')
        + `装完会自动启动。断点会接着上次的进度继续。\n五项计划：\n${planText}`,
      asr: this.asr.status(),
    };
  }

  /**
   * 提示词的有效值：配置里空着/没有 → 用包里的默认（这样升级后新默认会自动生效）。
   * 框架没有"删除配置键"的接口，所以"恢复默认"写的是空串——语义与删键等价，
   * 而且下次升级仍然会吃到新的 DEFAULT_ASR_PROMPT。
   */
  asrPromptValue() {
    return String(this.cfg.asrPrompt ?? '').trim();
  }

  asrPromptInfo() {
    const raw = this.asrPromptValue();
    // 配置里"没有 / 空串 / 正好等于内置默认"都算默认——新装部署的 config.json 会把
    // defaults() 写进去，那时键是存在的，不这样判就会把默认值显示成"已自定义"。
    const isDefault = !raw || raw === DEFAULT_ASR_PROMPT;
    return {
      asrPrompt: raw,                                 // 配置里的原值
      asrPromptEffective: raw || DEFAULT_ASR_PROMPT,  // 实际传给 whisper 的
      asrPromptSource: isDefault ? 'default' : 'custom',
    };
  }

  /** 恢复默认：把配置写成空串，并按需重启服务。 */
  async asrPromptReset() {
    const was = this.asrPromptValue();
    this.persist({ asrPrompt: '' });
    this.asr.prompt = '';
    let note = '';
    if (was && this.asr.status().running) {
      try {
        const t = Date.now();
        await this.asr.restart();
        note = `；本地 ASR 已按默认识别提示词重启（${((Date.now() - t) / 1000).toFixed(1)} s）`;
      } catch (error) {
        this.asrError = error instanceof Error ? error.message : String(error);
        note = `；但 ASR 重启失败：${this.asrError}`;
      }
    } else if (!was) {
      note = '；本来就是默认值';
    }
    return { text: `已恢复默认识别提示词${note}`, state: await this.panelState() };
  }

  async asrAction(action, okText) {
    try {
      this.asr.prompt = this.asrPromptValue();
      if (action === 'stop') await this.asr.stop();
      else if (action === 'restart') await this.asr.restart();
      else await this.asr.start();
      this.asrError = null;
      await this.checkHealth(true);
      return { text: okText, asr: this.asr.status(), state: await this.panelState() };
    } catch (error) {
      this.asrError = String(error?.message ?? error);
      return { text: `ASR ${action} 失败：${this.asrError}`, failed: true, asr: this.asr.status() };
    }
  }

  async asrSetModel(model) {
    // 存的是 models 目录里的文件名（ggml-*.bin）。下拉里有什么由目录扫出来决定，
    // 所以这里不做枚举校验，只拒绝空值。
    const next = String(model ?? '').trim();
    if (!next) return { text: '没选模型。', failed: true };
    this.persist({ whisperModel: next });
    this.asr.prompt = this.asrPromptValue();
    try {
      // 没装运行时的话 start() 会抛；那时候只保存选择，不报错
      if (!this.asr.binPath()) {
        this.asrError = '运行时还没装：先点「安装依赖」。选择已保存。';
        return { text: `已选 ${next}（等安装依赖后生效）。`, asr: this.asr.status(), state: await this.panelState() };
      }
      await this.asr.switchModel(next);
      this.asrError = null;
      await this.checkHealth(true);
      return { text: `模型已切到 ${next}（whisper-server 已重启）。`, asr: this.asr.status(), state: await this.panelState() };
    } catch (error) {
      this.asrError = String(error?.message ?? error);
      return { text: `切换失败：${this.asrError}`, failed: true, asr: this.asr.status(), state: await this.panelState() };
    }
  }

  async asrRemove() {
    try {
      await this.asr.stop();
      await rm(join(this.dataDir, 'asr'), { recursive: true, force: true });
      this.asrError = null;
      await this.checkHealth(true);
      return { text: '已删除本地 ASR（运行时与模型）。', state: await this.panelState() };
    } catch (error) {
      return { text: `删除失败：${error instanceof Error ? error.message : String(error)}`, failed: true };
    }
  }

  /** OCR 一行：没体检过就如实说"还没查"。 */
  ocrLine() {
    const o = this.ocrHealth;
    if (!o) return 'OCR（硬字幕校正）：还没检查（打开服务页会自动查一次）';
    if (!o.ok) {
      // 讲清"为什么要 Python"，但不教怎么装（产品决定：装不装、怎么装由用户自己定）
      if (o.reason === 'python-too-old') {
        return `Python：${o.pythonVersion ?? '?'} ✗（低于 3.11）\n`
          + 'OCR：不可用 —— 安装 OCR 需要 Python 3.11 或更新；可自行安装，或用别的方式装 rapidocr';
      }
      if (o.reason === 'python-too-new') {
        return `Python：${o.pythonVersion ?? '?'} ✗（高于 3.13，该版本暂无可用 wheel）\n`
          + 'OCR：不可用 —— 安装 OCR 需要 Python 3.11–3.13；可自行安装，或用别的方式装 rapidocr';
      }
      if (o.reason === 'python-missing') {
        return 'Python：未找到 3.11–3.13 ✗（OCR 需要）\n'
          + 'OCR：不可用 —— 安装 OCR 需要 Python 3.11–3.13；可自行安装，或用别的方式装 rapidocr';
      }
      // 有 Python、但引擎没装（或 import 失败）
      if (o.pythonVersion) {
        const detail = String(o.error ?? '缺 rapidocr / onnxruntime')
          .replace(/^OCR[：:]?\s*引擎未就绪\s*——\s*/, '');
        return `Python：${o.pythonVersion} ✓（OCR 需要）\n`
          + `OCR：引擎未就绪 —— ${detail}`;
      }
      return `OCR：不可用 —— ${o.error}`;
    }
    const v = o.versions ?? {};
    return `OCR：rapidocr ${v.rapidocr ?? o.version ?? '?'} · onnxruntime ${v.onnxruntime ?? '?'}`
      + ` · venv 就绪 · Python ${o.pythonVersion ?? '?'}`;
  }

  /** OCR 浅检：只 import 一次（≈0.3 s），页面打开时调一次就够。 */
  async ocrCheck() {
    try {
      this.ocrHealth = await checkOcr({ deep: false });
      return { text: this.ocrLine(), ocr: this.ocrHealth, state: await this.panelState() };
    } catch (error) {
      return { text: `OCR 检查失败：${error instanceof Error ? error.message : String(error)}`, failed: true };
    }
  }

  /** OCR 深检：真跑一张图（3–5 s），结果缓存到本进程。 */
  async ocrDoctor() {
    try {
      this.ocrHealth = await checkOcr({ deep: true });
      return {
        text: this.ocrHealth.ok
          ? `OCR 可以跑：rapidocr ${this.ocrHealth.version} @ ${this.ocrHealth.python}（已实际识别一张测试图）`
          : `OCR 不可用：${this.ocrHealth.error}`,
        ocr: this.ocrHealth,
        state: await this.panelState(),
      };
    } catch (error) {
      return { text: `OCR 检查失败：${error instanceof Error ? error.message : String(error)}`, failed: true };
    }
  }

  async checkHealth(force = false) {
    if (this.health && !force) return this.health;
    // yt-dlp 需要一个可写的临时目录才能启动（PyInstaller 自解压），先把它建出来
    const tempDir = join(this.dataDir, 'tmp');
    try { await mkdir(tempDir, { recursive: true }); } catch { /* 建不出来就让探测自己报错 */ }
    this.health = {
      ...(await checkMediaTools({
        ffmpeg: this.cfg.ffmpegPath,
        ffprobe: this.cfg.ffprobePath,
        ytdlp: this.cfg.ytdlpPath,
        tempDir,
      })),
      // 装了没装、起没起：两件事分开报，页面各占一行
      asr: this.asr.status(),
      // OCR（硬字幕校正）：**不在体检里起 python**（体检要保持无子进程、可离线跑）。
      // 页面打开后调一次 ocrCheck（浅检 ≈0.3 s），"真跑一张图"由按钮触发。
      ocr: this.ocrHealth ?? null,
    };
    return this.health;
  }

  async saveConfig(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { text: '没有要保存的内容。', failed: true };
    const next = {};
    for (const key of EDITABLE) {
      if (!(key in patch)) continue;
      next[key] = key === 'readCookies' ? patch[key] === true : String(patch[key] ?? '').trim();
    }
    if (!Object.keys(next).length) return { text: '没有要保存的内容。', failed: true };

    // 用户在框里原样提交默认文本 = 仍然用默认（不然"没改过"也会被标成已自定义）
    if ('asrPrompt' in next && next.asrPrompt === DEFAULT_ASR_PROMPT) next.asrPrompt = '';

    // 提示词是随 whisper-server 启动传下去的：改了就必须重启服务，否则用户会以为没生效。
    // 比的是**有效值**：'' 与"内置默认文本"是同一件事，不该因此重启。
    const before = this.asrPromptValue() || DEFAULT_ASR_PROMPT;
    const promptChanged = 'asrPrompt' in next && (next.asrPrompt || DEFAULT_ASR_PROMPT) !== before;

    this.persist(next);
    this.lastState = { ...(this.lastState ?? {}), lastSaved: new Date().toISOString() };
    await saveState(this.dataDir, this.lastState);
    // 路径改了就重新体检，页面不用再点一次
    await this.checkHealth(true);

    let note = '';
    if (promptChanged) {
      this.asr.prompt = next.asrPrompt;
      if (this.asr.status().running) {
        try {
          const t = Date.now();
          await this.asr.restart();
          note = `；本地 ASR 已用新提示词重启（${((Date.now() - t) / 1000).toFixed(1)} s）`;
        } catch (error) {
          note = `；但 ASR 重启失败：${error instanceof Error ? error.message : String(error)}`;
          this.asrError = String(error instanceof Error ? error.message : error);
        }
      } else {
        note = '；ASR 当前没在运行，下次启动时生效';
      }
    }
    return { text: `已保存：${Object.keys(next).join('、')}${note}`, saved: next, state: await this.panelState() };
  }

  async saveKey(key) {
    const value = String(key ?? '').trim();
    if (!value) return { text: '密钥是空的，没有写入。', failed: true };
    try {
      this.storeSecret(ASR_KEY_ENV, value);
    } catch (error) {
      return { text: `写入密钥失败：${error instanceof Error ? error.message : String(error)}`, failed: true };
    }
    return { text: `已写入 ${ASR_KEY_ENV}（存在部署的 .env 里，不写进 config.json）。` };
  }

  /* -------------------------------------------------------------------- 缓存 */

  cacheDir() {
    return (this.cfg.cacheDir ?? '').trim() || defaultCacheDir(this.dataDir);
  }

  async cacheUsage() {
    const dir = this.cacheDir();
    let bytes = 0;
    let files = 0;
    let seen = 0;
    const walk = async (current) => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (seen >= CACHE_COUNT_LIMIT) return;
        seen += 1;
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          try {
            const info = await stat(full);
            bytes += info.size;
            files += 1;
          } catch {
            /* 刚被删掉 */
          }
        }
      }
    };
    await walk(dir);
    return { dir, bytes, files, truncated: seen >= CACHE_COUNT_LIMIT };
  }

  async clearCache() {
    const dir = this.cacheDir();
    try {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
    } catch (error) {
      return { text: `清空失败：${error instanceof Error ? error.message : String(error)}`, failed: true };
    }
    return { text: `已清空 ${dir}`, state: await this.panelState() };
  }
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

const TEXT = {
  zh: {
    lamp: '媒体工具',
    lampAsr: '语音识别',
    lampUnchecked: '还没体检',
    panel: '服务',
    panelHint: '服务状态、ffmpeg/ffprobe 体检、ASR 端点、缓存占用与清空。',
  },
  en: {
    lamp: 'Media tools',
    lampAsr: 'Speech',
    lampUnchecked: 'Not checked yet',
    panel: 'Service',
    panelHint: 'Service state, ffmpeg/ffprobe health, the ASR endpoint, and cache usage or clearing.',
  },
};
