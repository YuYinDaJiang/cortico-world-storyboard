/**
 * 「分镜 · 服务」页。
 *
 * 浏览器端产物：不 import 任何东西（宿主动态 import 这个文件），只用 ctx.ui 原语建 DOM。
 * 面板 id 必须与 World 的 webUi().panels[].id 一致：service。
 */
const panel = {
  async mount(ctx) {
    const { ui } = ctx;
    const msg = ui.msgline();
    let state = null;
    let lastModelSignature = null;

    const call = async (method, args = []) => {
      msg.textContent = '';
      msg.classList.remove('bad');
      try {
        const next = await ctx.invoke(method, args);
        if (next && next.state) state = next.state;
        if (next && typeof next.text === 'string') {
          msg.textContent = next.text;
          msg.classList.toggle('bad', next.failed === true);
        }
        if (!next || !next.text) await refresh();
        else if (state) render();
      } catch (error) {
        msg.textContent = error instanceof Error ? error.message : String(error);
        msg.classList.add('bad');
      }
    };

    /* ------------------------------------------------------------- 状态卡 */
    const statusSheet = ui.sheet({ title: '服务状态', desc: '这个 World 此刻在不在，数据落在哪。' });
    const statusBody = ui.kv([
      { k: '状态', v: ui.pill('待读取', 'plain') },
      { k: '版本', v: '—' },
      { k: '数据目录', v: '—' },
      { k: '上次保存', v: '—' },
    ]);
    statusSheet.body.append(statusBody);
    ctx.root.append(statusSheet.el);

    /* ------------------------------------------------------------- 体检卡 */
    const healthSheet = ui.sheet({
      title: '体检',
      desc: '这几个外部程序在不在、是哪一版。ffmpeg / ffprobe / yt-dlp 需要你自己装（本页不代装）；'
        + '本地 ASR 用下面「语音识别」那张卡装。OCR 需要 Python 3.11–3.13，这个 Python 只为装 rapidocr 用；'
        + '可以自己装，也可以用别的方式装 rapidocr。',
    });
    const healthTable = ui.table({ head: ['程序', '状态', '版本 / 档位', '路径 / 原话'] });
    // 宿主的表格可能是 fixed 布局：只给单元格加 nowrap 还不够，列宽仍会被压住。
    // 给表格本身挂个类，用 td 选择器把第 2 列（状态）撑开、第 4 列（路径）限宽。
    healthTable.el.classList.add('sb-health');
    // 动作区挪到体检表下面：装/起/停/重启/卸载 都挨着"状态"看
    // 重新体检 = ffmpeg/ffprobe/yt-dlp + OCR（Python / rapidocr）一起查
    const recheck = ui.button('重新体检', { size: 'sm', onClick: async () => {
      await call('check');
      await call('ocrCheck');
    } });
    const btnInstallSmall = ui.button('一键安装（small）', { variant: 'primary', size: 'sm', onClick: () => void call('asrInstallTier', ['ggml-small-q5_1.bin']) });
    const btnInstallMedium = ui.button('安装 medium', { size: 'sm', onClick: () => void call('asrInstallTier', ['ggml-medium-q5_0.bin']) });
    const btnStart = ui.button('启动', { size: 'sm', onClick: () => void call('asrStart') });
    const btnStop = ui.button('停止', { size: 'sm', onClick: () => void call('asrStop') });
    const btnRestart = ui.button('重启', { size: 'sm', onClick: () => void call('asrRestart') });
    const btnRemove = ui.button('卸载', { variant: 'danger', size: 'sm', onClick: async () => {
      const yes = await ui.confirm({ title: '删掉本地 ASR？', body: '运行时与模型都会被删除，下次要重新下载。', danger: true });
      if (yes) await call('asrRemove');
    } });
    const sep = () => ui.h('span', 'sb-sep');
    const healthFoot = ui.actions();
    healthFoot.append(
      btnInstallSmall, btnInstallMedium, sep(),
      btnStart, btnStop, btnRestart, sep(),
      recheck, btnRemove,
    );
    healthSheet.body.append(healthTable.el, healthFoot);
    ctx.root.append(healthSheet.el);

    /* ------------------------------------------------------------- 转写卡 */
    const asrSheet = ui.sheet({
      title: '转写',
      desc: '取台词的优先级：显式 transcriptFile > 站点 CC 字幕 > 内嵌字幕轨 > 本地 ASR。',
    });
    const priority = ui.h('div', 'sb-note', '字幕文件只认 SRT、通用 JSON 数组、B 站 JSON；.ass 不支持，先用 ffmpeg -i x.ass x.srt 转一道。');
    const baseUrl = ui.input({ placeholder: 'http://127.0.0.1:8000/v1', onInput: () => {} });
    const model = ui.input({ placeholder: 'whisper-1（留空用服务端默认）', onInput: () => {} });
    const keyInput = ui.input({ type: 'password', placeholder: '留空表示沿用已保存的密钥', onInput: () => {} });
    const cookies = ui.checkbox('读取浏览器 cookies（默认关；关着走匿名）', { checked: false, onChange: () => {} });
    const cookiesPath = ui.input({ placeholder: '用户自己导出的 cookies.txt 路径', onInput: () => {} });

    const ytdlp = ui.input({ placeholder: '留空 = 从 PATH 找；填绝对路径则优先用它', onInput: () => {} });
    const saveAsr = ui.button('保存转写设置', { variant: 'primary', size: 'sm', onClick: () => void call('save', [{
      asrBaseUrl: baseUrl.value,
      asrModel: model.value,
      readCookies: cookies.checked,
      cookiesPath: cookiesPath.value,
      ytdlpPath: ytdlp.value,
    }]) });
    const saveKeyBtn = ui.button('写入密钥', { size: 'sm', onClick: () => void call('saveKey', [keyInput.value]) });
    const asrActions = ui.actions();
    asrActions.append(saveAsr, saveKeyBtn);
    asrSheet.body.append(
      priority,
      ui.field('ASR baseUrl', baseUrl),
      ui.field('模型名', model),
      ui.field('密钥（写进部署 .env，不进 config.json）', keyInput),
      cookies.el,
      ui.field('cookies 文件', cookiesPath),
      ui.field('yt-dlp 路径（贴链接时才需要）', ytdlp),
      asrActions,
    );
    ctx.root.append(asrSheet.el);

    /* ----------------------------------------------------------- 语音识别卡 */
    const voiceSheet = ui.sheet({
      title: '语音识别（本地）',
      desc: '「安装依赖」只装 whisper.cpp 运行时与模型（约 200 MB），装在 World 自己的目录里，不写 PATH。ffmpeg / ffprobe / yt-dlp 不在这步里，需要你自己装。',
    });
    const voiceBody = ui.kv([
      { k: '运行时', v: '—' },
      { k: '模型', v: '—' },
      { k: '服务', v: '—' },
      { k: '端口', v: '—' },
    ]);
    // 选项来自后端扫 models 目录的结果，不在这里写死
    const modelSelect = ui.select({
      options: [],
      onChange: (value) => {
        if (!value) return;
        voiceProgress.textContent = `正在切换到 ${value} …（whisper-server 会重启，模型要重新加载）`;
        void call('asrModel', [value]);
      },
    });
    const voiceProgress = ui.h('div', 'sb-note', '');
    // whisper 的 initial prompt：唯一能"喂词"的口子（专名、简繁都靠它）
    const promptInput = ui.textarea({ rows: 2, placeholder: '普通话简体字幕。把常出现的专有名词写进来。', onInput: () => {} });
    const savePrompt = ui.button('保存提示词', { size: 'sm', onClick: () => void call('save', [{ asrPrompt: promptInput.value }]) });
    const resetPrompt = ui.button('恢复默认', { size: 'sm', onClick: async () => {
      const yes = await ui.confirm({ title: '恢复默认提示词？', body: '会丢掉你自定义的那一行，并把本地 ASR 按默认提示词重启。' });
      if (yes) await call('asrPromptReset');
    } });
    const promptSource = ui.pill('默认', 'plain');
    const promptRow = ui.actions();
    promptRow.append(savePrompt, resetPrompt, promptSource);
    // 模型与提示词并排
    const modelField = ui.field('模型（扫 models 目录）', modelSelect);
    const promptField = ui.field('识别提示词（专名靠它；保存后会重启本地服务）', promptInput);
    const sideBySide = ui.h('div', 'sb-two');
    sideBySide.append(modelField, promptField);
    voiceSheet.body.append(
      voiceBody,
      sideBySide,
      voiceProgress,
      promptRow,
    );
    ctx.root.append(voiceSheet.el);

    // 安装期间每 3 秒拉一次状态（进度条靠它），装完自动停
    ctx.interval(() => {
      if (state?.asr?.installing || state?.asr?.switching) void refresh();
    }, 3000);

    /* ------------------------------------------------------------- 缓存卡 */
    const cacheSheet = ui.sheet({ title: '缓存', desc: '扫描结果与取帧缓存都在这里，可以整个清掉。' });
    const cacheBody = ui.kv([
      { k: '占用', v: '—' },
      { k: '目录', v: '—' },
    ]);
    const cacheFoot = ui.actions();
    const clearBtn = ui.button('清空缓存', { variant: 'danger', size: 'sm', onClick: async () => {
      const yes = await ui.confirm({ title: '清空缓存？', body: '目录里的东西会被删掉，下次出分镜要重新扫描。', danger: true });
      if (yes) await call('clearCache');
    } });
    cacheFoot.append(clearBtn);
    cacheSheet.body.append(cacheBody, cacheFoot);
    ctx.root.append(cacheSheet.el);

    /* ------------------------------------------------------------- 笔记卡（写回验证） */
    const noteSheet = ui.sheet({ title: '备注', desc: '随便写一句，保存后刷新页面还在 —— 这就是「能读能写」的那一格。' });
    const note = ui.input({ placeholder: '比如：这台机器上 ffmpeg 在 D:\\tools\\ffmpeg\\bin', onInput: () => {} });
    const saveNote = ui.button('保存备注', { size: 'sm', onClick: () => void call('save', [{ note: note.value }]) });
    const noteFoot = ui.actions();
    noteFoot.append(saveNote);
    noteSheet.body.append(ui.field('备注', note), noteFoot);
    ctx.root.append(noteSheet.el);

    ctx.root.append(msg);

    /* ----------------------------------------------------------------- 渲染 */

    const setKv = (table, rows) => {
      const cells = table.rows;
      rows.forEach((row, i) => {
        const tr = cells[i];
        if (!tr) return;
        const key = tr.cells[0];
        const val = tr.cells[1];
        if (key) key.textContent = row.k;
        if (val) val.replaceChildren();
        if (val && row.node) val.append(row.node);
        else if (val) val.textContent = String(row.v ?? '—');
      });
    };

    // 状态列：nowrap + 最小宽度，避免「运行中」被折成两行
    const statusCell = (node) => { const el = ui.h('span', 'sb-nowrap'); el.append(node); return el; };
    // 路径列：中间省略、单行、title 给全路径、点一下复制
    const pathCell = (text) => {
      const full = String(text ?? '');
      const short = full.length > 52 ? `${full.slice(0, 22)}…${full.slice(-26)}` : full;
      const el = ui.h('span', 'sb-path', short);
      el.title = full;
      el.addEventListener('click', () => {
        try {
          void navigator.clipboard?.writeText(full);
          el.classList.add('copied');
          ui.toast?.('已复制');
          setTimeout(() => el.classList.remove('copied'), 800);
        } catch { /* 剪贴板不可用就算了，title 还在 */ }
      });
      return el;
    };

    const render = () => {
      if (!state) return;

      // 状态
      const pill = ui.pill(state.started ? '运行中' : '未运行', state.started ? 'on' : 'off');
      setKv(statusBody, [
        { k: '状态', node: pill },
        { k: '版本', v: state.version },
        { k: '数据目录', v: state.dataDir },
        { k: '上次保存', v: state.lastSaved ?? '—' },
      ]);

      // 体检
      healthTable.clear(state.health ? '' : '还没体检，点下面的按钮。');
      if (state.health) {
        for (const [name, item] of [['ffmpeg', state.health.ffmpeg], ['ffprobe', state.health.ffprobe], ['yt-dlp', state.health.ytdlp]]) {
          healthTable.addRow([
            name,
            statusCell(ui.pill(item.ok ? '可用' : '缺失', item.ok ? 'on' : 'off')),
            item.version ?? '—',
            item.ok
              ? pathCell(item.resolved ?? (item.path && /[\\/]/.test(item.path) ? item.path : `${item.bin ?? name}（来自 PATH，未解析到绝对路径）`))
              : (item.error ?? '—'),
          ]);
        }
        // ASR 两行：装了没装、起没起，各说各的。三种状态别退化成同一句：
        //   未装 → asr=未装 / 服务=—（n/a）
        //   装了没起 → asr=已装 / 服务=未启动（error 色）
        //   运行中 → asr=已装 / 服务=运行中 + 前后端端口
        const asr = state.asr ?? state.health.asr;
        if (asr) {
          const external = Boolean(asr.external) || Boolean(state.config?.asrBaseUrl);
          // 每个可装档位一行：medium 有没有装，在这里一眼能看到
          for (const m of asr.catalog ?? []) {
            healthTable.addRow([
              `模型 ${m.id}`,
              statusCell(ui.pill(m.installed ? '已装' : '缺失', m.installed ? 'on' : 'off')),
              `${Math.round(m.bytes / 1048576)} MB`,
              m.installed
                ? pathCell(`${state.dataDir}\\asr\\models\\${m.file}`)
                : `点上方「${m.id.includes('small') ? '一键安装（small）' : '安装 medium'}」下载`,
            ]);
          }
          healthTable.addRow([
            'asr 运行时',
            statusCell(ui.pill(external ? '外部端点' : asr.runtimeVersion ? '已装' : '未装', external || asr.runtimeVersion ? 'on' : 'off')),
            external ? '外部端点' : (asr.runtimeVersion ?? '—'),
            external
              ? pathCell(state.config.asrBaseUrl ?? '—')
              : asr.runtimeVersion
                ? pathCell(asr.binPath ?? '—')
                : `没找到；找的是 ${state.dataDir}\\asr\\bin`,
          ]);
          healthTable.addRow([
            'asr 服务',
            statusCell(external
              ? ui.pill('外部', 'plain')
              : ui.pill(asr.running ? '运行中' : asr.runtimeVersion ? '未启动' : '—', asr.running ? 'on' : asr.runtimeVersion ? 'warn' : 'off')),
            external || !asr.runtimeVersion ? '—' : (asr.modelLabel ?? '—'),
            asr.error
              ? String(asr.error)
              : external
                ? '转写走外部端点'
                : asr.running
                  ? pathCell(`${asr.baseUrl}（前端 :${asr.port} → whisper :${asr.backendPort ?? asr.port + 1}）`)
                  : asr.runtimeVersion ? '已装，点「启动」' : '先装依赖',
          ]);
        }

        // Python 与 OCR 两行：判据 3.11–3.13，只说用途与可选项，不教怎么装
        const o = state.ocr;
        const venvDir = `${state.dataDir}\\ocr\\venv`;
        if (!o) {
          healthTable.addRow(['Python', statusCell(ui.pill('未检查', 'plain')), '—', '点「重新体检」']);
          healthTable.addRow(['OCR', statusCell(ui.pill('未检查', 'plain')), '—', '点「重新体检」']);
        } else {
          const reason = String(o.reason ?? '');
          // 有 pythonVersion 不代表可用：3.15 也有版本号但超区间
          const pyOk = Boolean(o.pythonVersion) && !['python-too-new', 'python-too-old', 'python-missing'].includes(reason);
          const pyPill = pyOk
            ? ui.pill('可用', 'on')
            : reason === 'python-too-new' ? ui.pill('版本过高', 'warn')
              : reason === 'python-too-old' ? ui.pill('版本过低', 'warn')
                : ui.pill('未找到', 'off');
          const pyWhy = pyOk ? '' : (reason === 'python-too-new'
            ? '高于 3.13，该版本暂无可用 wheel'
            : reason === 'python-too-old' ? '低于 3.11'
              : '未找到 3.11–3.13');
          healthTable.addRow([
            'Python',
            statusCell(pyPill),
            o.pythonVersion ?? '—',
            pyOk ? pathCell(o.python ?? '—') : `${pyWhy}（OCR 需要 Python 3.11–3.13）`,
          ]);

          const v = o.versions ?? {};
          const ocrPill = o.ok ? ui.pill('可用', 'on')
            : o.pythonVersion ? ui.pill('引擎未就绪', 'warn') : ui.pill('不可用', 'off');
          healthTable.addRow([
            'OCR',
            statusCell(ocrPill),
            o.ok ? `rapidocr ${v.rapidocr ?? '?'} · onnxruntime ${v.onnxruntime ?? '?'}` : '—',
            o.ok ? pathCell(venvDir)
              : (o.pythonVersion
                ? (String(o.error ?? '缺 rapidocr / onnxruntime').replace(/^OCR[：:]?\s*引擎未就绪\s*——\s*/, ''))
                : '安装 OCR 需要 Python 3.11–3.13；可自行安装，或用别的方式装 rapidocr'),
          ]);
        }
      }

      // 语音识别
      const asr = state.asr ?? {};
      setKv(voiceBody, [
        { k: '运行时', node: ui.pill(asr.installed ? '已装' : '未装', asr.installed ? 'on' : 'off') },
        { k: '模型', v: asr.modelLabel ?? '—' },
        {
          k: '服务',
          node: ui.pill(
            asr.switching ? '正在重启…' : (asr.running ? '运行中' : '未启动'),
            asr.switching ? 'warn' : (asr.running ? 'on' : 'off'),
          ),
        },
        { k: '端口', v: asr.running ? `:${asr.port} → :${asr.backendPort ?? asr.port + 1}` : (asr.switching ? `:${asr.port}` : '—') },
      ]);
      // 下拉选项跟着目录走：只有列表变了才重建，避免打断正在选的人
      const models = asr.models ?? [];
      const signature = models.map((m) => `${m.id}:${m.bytes}`).join('|');
      if (signature !== lastModelSignature) {
        lastModelSignature = signature;
        modelSelect.replaceChildren();
        for (const m of models) {
          const option = document.createElement('option');
          option.value = m.file;
          option.textContent = m.label;
          modelSelect.append(option);
        }
        if (!models.length) {
          const option = document.createElement('option');
          option.value = '';
          option.textContent = '（models 目录还是空的）';
          modelSelect.append(option);
        }
      }
      if (asr.model) modelSelect.value = asr.model;
      if (asr.switching) modelSelect.disabled = true;
      else modelSelect.disabled = false;
      // 框里显示**有效值**：默认时就是包里那行，用户不用猜"空的代表什么"
      if (document.activeElement !== promptInput) {
        promptInput.value = state.config.asrPromptEffective ?? state.config.asrPrompt ?? '';
      }
      const custom = state.config.asrPromptSource === 'custom';
      promptSource.textContent = custom ? '已自定义' : '默认';
      promptSource.classList.toggle('on', custom);
      if (asr.installing) {
        const { phase, done, total } = asr.installing;
        const mb = (n) => (n / 1048576).toFixed(0);
        voiceProgress.textContent = `正在下载${phase === 'model' ? '模型' : '运行时'}：${mb(done)} / ${total ? mb(total) : '?'} MB`;
      } else if (asr.switching) {
        voiceProgress.textContent = `正在重启 whisper-server，换到 ${asr.switching.to} …`;
      } else if (asr.lastInstall) {
        // 逐项对账的回执：新装了什么、跳过了什么
        const li = asr.lastInstall;
        const parts = [];
        if (li.installed?.length) parts.push(`新装：${li.installed.join('、')}`);
        if (li.skipped?.length) parts.push(`已有：${li.skipped.join('、')}`);
        if (li.error) parts.push(`失败：${li.error}`);
        voiceProgress.textContent = parts.join('；');
      } else {
        voiceProgress.textContent = asr.error ? String(asr.error) : '';
      }

      // 转写
      baseUrl.value = state.config.asrBaseUrl;
      model.value = state.config.asrModel;
      cookies.setChecked(state.config.readCookies === true);
      cookiesPath.value = state.config.cookiesPath;
      ytdlp.value = state.config.ytdlpPath ?? '';
      keyInput.placeholder = state.hasAsrKey ? '已保存密钥；留空则不改' : '还没有密钥';

      // 缓存
      setKv(cacheBody, [
        { k: '占用', v: `${ui.fmt.bytes(state.cache.bytes)} · ${state.cache.files} 个文件${state.cache.truncated ? '（只数了一部分）' : ''}` },
        { k: '目录', v: state.cache.dir },
      ]);

      // 备注
      note.value = state.config.note ?? '';
    };

    const refresh = async () => {
      try {
        state = await ctx.invoke('state');
        render();
      } catch (error) {
        msg.textContent = error instanceof Error ? error.message : String(error);
        msg.classList.add('bad');
      }
    };

    await refresh();

    // 打开面板就自动体检一次：不能只读缓存，否则「上次是就绪、这次实际跑不动」会看不到。
    // 先画一帧缓存状态（避免空白），随后并行刷新媒体工具 + OCR，最后再拉一次完整 state。
    void (async () => {
      try {
        await call('check');
        await call('ocrCheck');
        await refresh();
      } catch { /* 打开时体检失败不该让面板报错 */ }
    })();
  },
};

export default { panels: { service: panel } };
