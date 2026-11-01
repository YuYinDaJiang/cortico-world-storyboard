/**
 * 骨架自检：不启动 Coopanion，按 World 契约把该断言的东西全断一遍。
 * 跑法：node scripts/check.mjs
 *
 * 检查项与 Coopanion 的 dryMountWorld 对齐（面板 id 形状、工具形状、create 纯净、webUi 声明），
 * 另外多查两条这一步最在意的：panel id 有没有 service、浏览器产物是不是真导出它。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const oks = [];
const warnings = [];

const ok = (line) => oks.push(line);
const fail = (line) => failures.push(line);
const warn = (line) => warnings.push(line);

/* ------------------------------------------------------------------ manifest */

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
if (pkg.type !== 'module') fail('package.json: type 必须是 module');
const m = pkg.cortico ?? {};
if (m.kind !== 'world') fail(`cortico.kind 必须是 world，现在是 ${JSON.stringify(m.kind)}`);
if (m.api !== 6) fail(`cortico.api 必须是 6，现在是 ${JSON.stringify(m.api)}`);
if (!m.displayName) warn('cortico.displayName 为空，市场卡片会用包名');
if (!(pkg.keywords ?? []).includes('cortico-world')) fail('keywords 缺少 cortico-world（扩展页按它发现包）');
const safe = (p) => typeof p === 'string' && p && !p.includes('\\') && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split('/').some((s) => s === '..' || s === '');
for (const [field, pattern] of [['webUiClient', /\.m?js$/], ['webUiStyle', /\.css$/], ['describe', /\.json$/]]) {
  const value = m[field];
  if (value === undefined) { warn(`cortico.${field} 没声明`); continue; }
  if (!safe(value) || !pattern.test(value)) fail(`cortico.${field} 路径不合法：${value}`);
  else if (!existsSync(join(pkgDir, value))) fail(`cortico.${field} 指向的文件不存在：${value}`);
}
if (m.webUiStyle !== undefined && m.webUiClient === undefined) fail('webUiStyle 需要 webUiClient');
ok(`manifest: world api=${m.api}，displayName=${m.displayName ?? '(无)'}`);

/* ------------------------------------------------------------------- 入口 */

const mod = await import(pathToFileURL(join(pkgDir, pkg.main ?? 'src/index.js')).href);
const def = mod.default;
if (!def) fail('默认导出为空');
if (!def || typeof def.id !== 'string' || typeof def.label !== 'string') fail('定义缺 id 或 label');
if (typeof def.defaults !== 'function' || typeof def.create !== 'function') fail('定义缺 defaults() 或 create()');

let defaults;
try { defaults = def.defaults(); } catch (error) { fail(`defaults() 抛错：${error.message}`); }
if (defaults && defaults.enabled !== false) fail('defaults().enabled 必须是 false');
if (defaults && typeof defaults !== 'object') fail('defaults() 必须返回对象');

/* ---------------------------------------------------------------- create 纯净 */

const scratch = mkdtempSync(join(tmpdir(), 'storyboard-check-'));
const dataDir = join(scratch, 'data');
const created = [];
function createdAnything() {
  try { return readdirSync(dataDir).length > 0; } catch { return false; }
}
const fakeCtx = {
  id: def.id,
  cfg: structuredClone(defaults),
  timezone: 'Asia/Shanghai',
  botName: '小肥鱼',
  botDir: join(scratch, 'deployment'),
  packageDir: pkgDir,
  dataDir,
  repoRoot: pkgDir,
  secret: () => '',
  storeSecret: () => {},
  persist: (patch) => Object.assign(fakeCtx.cfg, patch),
  restart: async () => {},
};

let world;
try {
  world = def.create(fakeCtx);
  if (createdAnything()) fail('create() 建了文件/目录：装配层会给所有定义跑它，必须纯');
  else ok('create() 是纯的：没落盘');
} catch (error) {
  fail(`create() 抛错：${error.message}`);
}
if (world && world.id !== def.id) fail(`实例 id（${world.id}）与定义 id（${def.id}）不一致`);
else if (world) ok(`实例 id = ${world.id}`);

/* -------------------------------------------------------------------- 工具 */

let tools = [];
try { tools = world.tools(); } catch (error) { fail(`tools() 抛错：${error.message}`); }
if (!Array.isArray(tools)) fail('tools() 没有返回数组');
else {
  const names = new Set();
  for (const tool of tools) {
    if (!tool?.name) { fail('有工具没有名字'); continue; }
    if (names.has(tool.name)) fail(`工具重名：${tool.name}`);
    names.add(tool.name);
    if (!tool.parameters || typeof tool.parameters !== 'object') fail(`工具 ${tool.name} 缺 parameters`);
    if (typeof tool.handler !== 'function') fail(`工具 ${tool.name} 缺 handler`);
    if (!Array.isArray(tool.tags)) fail(`工具 ${tool.name} 缺 tags`);
    if (!/^[a-z0-9]+_/.test(tool.name)) warn(`工具 ${tool.name} 没有前缀`);
  }
  ok(`tools(): ${[...names].join(', ') || '(无)'}`);
  for (const want of ['video_storyboard', 'video_probe', 'video_locate', 'video_zoom']) {
    if (!names.has(want)) fail(`缺工具 ${want}`);
    const tool = tools.find((t) => t.name === want);
    if (tool && tool.parameters?.type !== 'object') fail(`${want} 的 parameters 不是 JSON Schema 对象`);
    if (tool && typeof tool.handler !== 'function') fail(`${want} 没有 handler`);
  }
  if (['video_storyboard', 'video_probe', 'video_locate', 'video_zoom'].every((n) => names.has(n))) {
    ok('四个视频工具都在（storyboard / probe / locate / zoom）');
  }

  // 分镜工具的 schema 与字幕护栏（不碰 ffmpeg，纯本地判断）
  const storyboard = tools.find((t) => t.name === 'video_storyboard');
  if (!storyboard) fail('没有 video_storyboard 工具');
  else {
    if (storyboard.parameters?.type !== 'object') fail('video_storyboard 的 parameters 不是标准 JSON Schema 对象');
    if (!Array.isArray(storyboard.parameters?.required) || !storyboard.parameters.required.includes('input')) {
      fail('video_storyboard 的 required 里没有 input（上游紧凑写法没转成 JSON Schema）');
    }
    const props = Object.keys(storyboard.parameters?.properties ?? {});
    if (props.length < 10) fail(`video_storyboard 的 properties 只有 ${props.length} 个，schema 大概没转全`);
    else ok(`video_storyboard: ${props.length} 个参数，required=["input"]`);

    const engine = storyboard.parameters?.properties?.engine;
    if (!engine || JSON.stringify(engine.enum) !== JSON.stringify(['v1', 'v2'])) {
      fail('video_storyboard 的 engine 参数不是 enum ["v1","v2"]');
    } else ok('engine: v1 | v2 已声明');

    const ass = await storyboard.handler({ input: 'x.mp4', transcriptFile: 'x.ass' });
    if (ass?.failed !== true) fail('.ass 没有被拒绝：应当明确要求先转成 srt');
    else if (!/ffmpeg -i/.test(ass.text)) fail('.ass 被拒绝了，但没说怎么转');
    else ok('.ass 被拒绝并给出 ffmpeg 转法');

    const missing = await storyboard.handler({ input: 'x.mp4', transcriptFile: 'no-such-file.srt' });
    if (missing?.failed !== true) fail('transcriptFile 不存在时没有报错');
    else ok('transcriptFile 不存在时报错');
  }
}

/* ---------------------------------------------------------------- 环境变量 */

try {
  const vars = await world.envPromptVars();
  if (vars !== null && (typeof vars !== 'object' || Array.isArray(vars))) fail('envPromptVars() 只能返回对象或 null');
  else ok(`envPromptVars(): ${vars === null ? 'null（本阶段不加前缀）' : `${Object.keys(vars).length} 个占位符`}`);
} catch (error) {
  fail(`envPromptVars() 抛错：${error.message}`);
}

/* ------------------------------------------------------------------ WebUI */

let decl;
try { decl = world.webUi('zh'); } catch (error) { fail(`webUi() 抛错：${error.message}`); }
if (decl) {
  const panels = decl.panels ?? [];
  const ids = new Set();
  for (const p of panels) {
    if (!/^[a-z0-9-]+$/.test(p.id)) fail(`面板 id 形状不对：${p.id}`);
    if (ids.has(p.id)) fail(`面板 id 重复：${p.id}`);
    ids.add(p.id);
    if (!p.title) fail(`面板 ${p.id} 缺 title`);
  }
  if (!ids.has('service')) fail('webUi() 没声明 service 面板：管理页不会出现在导航里');
  else ok(`webUi(): 面板 ${[...ids].join(', ')}，服务页标题「${panels.find((p) => p.id === 'service').title}」`);
  if (!Array.isArray(decl.lamps) || !decl.lamps.length) warn('webUi() 没有 lamps：导航里不显示状态灯');
  if (typeof decl.invoke !== 'function') fail('webUi() 没给 invoke：面板打开后没有数据面');
}

/* ------------------------------------------------- 浏览器产物是否真的导出该面板 */

try {
  const bundle = (await import(pathToFileURL(join(pkgDir, m.webUiClient)).href)).default;
  const keys = Object.keys(bundle?.panels ?? {});
  if (!keys.length) fail('webui 产物没有 panels');
  for (const p of decl?.panels ?? []) {
    if (!keys.includes(p.id)) fail(`webui 产物缺面板 ${p.id}（声明了但没实现，页面会报错）`);
    else if (typeof bundle.panels[p.id].mount !== 'function') fail(`webui 面板 ${p.id} 没有 mount()`);
  }
  ok(`浏览器产物导出了 ${keys.join(', ')}`);
} catch (error) {
  fail(`导入 ${m.webUiClient} 失败：${error.message}`);
}

/* ------------------------------------------------------------ invoke 读写回路 */

try {
  await world.start({ log: { info() {}, warn() {} }, pushEvent: async () => {}, store: {} });
  const before = await decl.invoke('service', 'state', []);
  if (!before || before.started !== true) fail('state 没报告已启动');
  const saved = await decl.invoke('service', 'save', [{ note: '自检写入', asrBaseUrl: 'http://127.0.0.1:8000/v1' }]);
  if (saved?.failed) fail(`save 失败：${saved.text}`);
  if (fakeCtx.cfg.note !== '自检写入') fail('save 没有写回配置（persist 没被调用或键名不对）');
  const after = await decl.invoke('service', 'state', []);
  if (after.config.note !== '自检写入') fail('保存后 state 读不到 note');
  if (after.config.asrBaseUrl !== 'http://127.0.0.1:8000/v1') fail('保存后 state 读不到 asrBaseUrl');
  await new Promise((r) => setTimeout(r, 50));
  if (!existsSync(join(dataDir, 'storyboard', 'state.json'))) fail('state.json 没有落盘（管理页的「上次保存」会一直是空的）');
  else ok('invoke: state → save → state 回路通，且 state.json 落盘');
  const cleared = await decl.invoke('service', 'clearCache', []);
  if (cleared?.failed) fail(`clearCache 失败：${cleared.text}`);
  else ok('invoke: clearCache 可用');
  await world.stop();
} catch (error) {
  fail(`invoke 回路抛错：${error.message}`);
}

/* ------------------------------------------- integral:false 的逃生口（可选） */
// 需要 ffmpeg + 一支本地视频：DSH_CHECK_VIDEO=<path> npm run check
// 断言：关掉积分取帧后 sampleMarks 必须是 0，且所有帧的 via 只能是 cut / start，不许有 mark。
if (!process.env.DSH_CHECK_VIDEO) {
  warn('integral:false 断言跳过（设 DSH_CHECK_VIDEO=<本地视频> 可跑；需要 ffmpeg）');
} else if (!existsSync(process.env.DSH_CHECK_VIDEO)) {
  fail(`DSH_CHECK_VIDEO 指向的文件不存在：${process.env.DSH_CHECK_VIDEO}`);
} else {
  let integralScratch = null;
  try {
    const { runStoryboard } = await import(pathToFileURL(join(pkgDir, 'src/vendor/storyboard/pipeline.js')).href);
    const { setStoryboardPaths } = await import(pathToFileURL(join(pkgDir, 'src/vendor/storyboard/world-paths.js')).href);
    integralScratch = mkdtempSync(join(tmpdir(), 'sb-check-integral-'));
    const dirs = {
      cache: join(integralScratch, 'cache'),
      temp: join(integralScratch, 'temp'),
      media: join(integralScratch, 'media'),
    };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    setStoryboardPaths(dirs);

    const r = await runStoryboard({
      input: process.env.DSH_CHECK_VIDEO, from: 0, to: 60,
      integral: false, encode: false, cache: false, transcript: 'off',
    });
    const marks = r.plan?.sampleMarks;
    const cuts = r.cuts?.length ?? 0;
    const frames = r.plan?.frames ?? 0;
    const cells = (r.sheets ?? []).flatMap((s) => s.cells ?? []);
    const vias = [...new Set(cells.map((c) => c.via).filter(Boolean))].sort();
    const markCells = cells.filter((c) => c.via === 'mark').length;

    if (marks !== 0) {
      fail(`integral:false 之后 plan.sampleMarks 应为 0，实际 ${marks}`
        + '（伪切点没关掉：确认 boardOptions 把 integral 透传到了 pipeline）');
    } else if (frames > cuts + 1) {
      // 边界只可能来自切点：帧数最多 cuts+1（更少是正常的——贴边/过短的切点会被并掉）
      fail(`integral:false 之后帧数 ${frames} 多于「切点+1」= ${cuts + 1}`
        + '——多出的边界只可能是伪切点，说明没清干净');
    } else if (markCells > 0) {
      fail(`integral:false 之后仍有 ${markCells} 格 via='mark'`
        + `（共 ${cells.length} 格，via=${vias.join('/')}）—— 伪段没有清干净`);
    } else {
      ok(`integral:false 逃生口：sampleMarks=0，${frames} 帧 = ${cuts} 个真切点 + 1`
        + `，via=${vias.join('/') || '未暴露（按帧数校验）'}`);
    }
  } catch (error) {
    fail(`integral:false 断言抛错：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (integralScratch) rmSync(integralScratch, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------- 汇总 */

rmSync(scratch, { recursive: true, force: true });

console.log(`\n目录：${pkgDir}`);
for (const line of oks) console.log(`  ok   ${line}`);
for (const line of warnings) console.log(`  warn ${line}`);
for (const line of failures) console.log(`  FAIL ${line}`);
console.log(`\n${failures.length ? `失败 ${failures.length} 项` : '全部通过'}（ok ${oks.length}，warn ${warnings.length}）\n`);
process.exit(failures.length ? 1 : 0);
