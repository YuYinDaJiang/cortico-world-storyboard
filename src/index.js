/** 包入口：默认导出 WorldDefinition，加载器按 `cortico.kind === 'world'` 认它。 */
import { join } from 'node:path';
import { StoryboardWorld, STORYBOARD_ID, LABEL } from './world.js';
import { videoStoryboardDescribe } from './tools/video-storyboard.js';
import { extraDescribe } from './tools/video-extra.js';
import { DEFAULT_ASR_PROMPT } from './asr/service.js';

export const STORYBOARD = {
  id: STORYBOARD_ID,
  label: LABEL,
  // create() 会被装配层给所有可用定义各跑一遍，必须纯：不建目录、不发请求、不读密钥。
  defaults: () => ({
    enabled: false,
    ffmpegPath: '',
    ffprobePath: '',
    ytdlpPath: '',
    asrBaseUrl: '',
    asrModel: '',
    readCookies: false,
    cookiesPath: '',
    cacheDir: '',
    note: '',
    // 默认档位 = models 目录里的默认文件；首次运行写进 worlds.storyboard 后以配置为准
    whisperModel: 'ggml-small-q5_1.bin',
    whisperPort: 18760,
    autoStartAsr: true,
    asrPrompt: DEFAULT_ASR_PROMPT,
  }),
  create: (ctx) => new StoryboardWorld({
    cfg: ctx.cfg,
    dataDir: join(ctx.dataDir, 'storyboard'),
    persist: (patch) => ctx.persist(patch),
    secret: (name) => ctx.secret(name),
    storeSecret: (name, value) => ctx.storeSecret(name, value),
  }),
  // 自描述与 describe.json 保持一致；管理页/市场读的是 describe.json。
  describe: {
    tools: [{
      name: 'storyboard_status',
      description: 'Report what the storyboard World can do right now: whether ffmpeg and ffprobe are reachable, where the cache is and how big it is, and whether an ASR endpoint is configured. Read-only; use it when the person asks why a video cannot be turned into a storyboard yet.',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      summary: {
        zh: '报告分镜当前能不能用：ffmpeg/ffprobe、缓存与 ASR 配置。',
        en: 'Reports whether the storyboard is usable right now: ffmpeg/ffprobe, cache and ASR.',
      },
    }, videoStoryboardDescribe(), ...extraDescribe()],
    events: [],
  },
};

export default STORYBOARD;
export { StoryboardWorld, STORYBOARD_ID };
