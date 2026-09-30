// schema/local-stt-panel — 本地 SenseVoice 资源包安装面板（自包含 DOM + 行为）。
// 通过 electronAPI 与主进程 local-stt:* 通道通信；面板从设置页移除后自动取消订阅。

const PHASE_TEXT = {
    unprepared: '未安装 · 磁盘约 250MB · 识别时内存约 400MB · 首次下载需数分钟，完成后完全离线',
    checking: '正在检查下载源…',
    downloading: '下载中',
    ready: '已安装。在上方“语音输入模式”中选择“本地 SenseVoice 转写”即可使用',
    cancelled: '已取消',
    failed: '安装失败',
    unsupported: '当前系统暂不支持本地语音识别',
};

const RESOURCE_TEXT = { model: '识别模型', tokens: '词表', vad: '语音检测模型' };

// 失败时给出可执行的建议
const FAIL_ADVICE = {
    network: '请检查网络或代理后重试；已下载的部分会保留并续传。',
    dns: '域名无法解析，请检查网络、DNS 或代理设置后重试。',
    timeout: '连接长时间无响应，请稍后重试；已下载的部分会保留并续传。',
    certificate: '请检查系统时间、代理或安全软件是否拦截了 HTTPS 连接。',
    http: '下载源暂时不可用，请稍后重试（会自动切换到备用源）。',
    integrity: '文件校验未通过，已清除损坏的文件，请重试。',
    storage: '请确认磁盘剩余空间充足、目录可写，且没有安全软件占用模型文件。',
    unsupported: '目前仅提供 Windows / macOS / Linux 的 64 位版本。',
};

const FAIL_TEXT = {
    network: '网络连接失败',
    dns: '域名解析失败',
    timeout: '连接超时',
    certificate: '证书校验失败',
    http: '下载源返回错误',
    integrity: '文件校验未通过',
    storage: '磁盘空间不足、无写入权限或文件被占用',
    unsupported: '当前系统暂不支持',
};

// 按钮样式类自带 display，会盖掉 hidden 属性，这里直接控制 display
function show(el, visible, display = '') {
    el.style.display = visible ? display : 'none';
}

function formatMb(bytes) {
    return `${(Number(bytes || 0) / 1048576).toFixed(1)} MB`;
}

export function buildLocalSttPanel(doc) {
    // 复用语言行（vcp-uiux-language-row）视觉：左侧标题/描述，右侧胶囊按钮
    const row = doc.createElement('div');
    row.className = 'vcp-uiux-language-row';
    row.id = 'localSttPanel';

    const text = doc.createElement('div');
    text.className = 'vcp-uiux-language-row-text';
    const title = doc.createElement('div');
    title.className = 'vcp-uiux-language-row-title';
    title.textContent = '本地语音资源包';
    const status = doc.createElement('div');
    status.className = 'vcp-uiux-language-row-description';
    status.id = 'localSttStatus';
    const progress = doc.createElement('progress');
    progress.id = 'localSttProgress';
    progress.max = 100;
    progress.value = 0;
    progress.style.display = 'none';
    progress.style.cssText = 'width:100%;height:4px;margin-top:6px;accent-color:var(--accent, #2563eb);';
    text.append(title, status, progress);

    const actions = doc.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;align-items:center;flex-shrink:0;';
    const mkBtn = (id, label) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.id = id;
        b.textContent = label;
        b.className = 'vcp-uiux-language-row-selector';
        return b;
    };
    const installBtn = mkBtn('localSttInstallBtn', '下载安装');
    const cancelBtn = mkBtn('localSttCancelBtn', '取消');
    const removeBtn = mkBtn('localSttRemoveBtn', '卸载');
    actions.append(installBtn, cancelBtn, removeBtn);
    row.append(text, actions);

    const api = doc.defaultView?.electronAPI;
    if (!api?.getLocalSttStatus) {
        status.textContent = '当前环境不支持本地语音识别';
        installBtn.disabled = cancelBtn.disabled = removeBtn.disabled = true;
        return row;
    }

    const render = (state = {}) => {
        let phase = state.phase || 'unprepared';
        if (state.supported === false && phase !== 'ready') phase = 'unsupported';
        let text = PHASE_TEXT[phase] || phase;
        show(progress, phase === 'downloading', 'block');
        if (phase === 'downloading') {
            const pct = state.totalBytes ? Math.min(100, (state.completedBytes / state.totalBytes) * 100) : 0;
            progress.value = pct;
            text = `下载中${RESOURCE_TEXT[state.resource] ? `（${RESOURCE_TEXT[state.resource]}）` : ''}：${formatMb(state.completedBytes)} / ${formatMb(state.totalBytes)}（${pct.toFixed(0)}%）`;
        } else if (phase === 'failed') {
            text = `安装失败：${FAIL_TEXT[state.reason] || state.message || '未知错误'}。${FAIL_ADVICE[state.reason] || ''}`;
        }
        status.textContent = text;
        const busy = phase === 'downloading' || phase === 'checking';
        show(installBtn, !busy && phase !== 'ready' && phase !== 'unsupported');
        installBtn.disabled = busy;
        installBtn.textContent = phase === 'failed' || phase === 'cancelled' ? '重试' : '下载安装';
        show(cancelBtn, busy);
        show(removeBtn, phase === 'ready');
    };

    installBtn.addEventListener('click', () => {
        api.prepareLocalStt({ source: 'auto' }).then(render).catch((e) => render({ phase: 'failed', message: e?.message }));
    });
    cancelBtn.addEventListener('click', () => { api.cancelLocalSttPrepare().then(render).catch(() => {}); });
    removeBtn.addEventListener('click', () => {
        if (!doc.defaultView.confirm('确定卸载本地语音资源包吗？之后需要重新下载。')) return;
        api.removeLocalStt().then(render).catch((e) => render({ phase: 'failed', reason: 'storage', message: e?.message }));
    });

    const unsubscribe = api.onLocalSttState?.((state) => {
        if (!row.isConnected) { unsubscribe?.(); return; }
        render(state);
    });
    render({ phase: 'unprepared' });
    api.getLocalSttStatus().then(render).catch(() => {});
    return row;
}
