import { el, button, buildSwitchRow } from './dom.js';

const PHASES = {
    off: '未监听', loading: '正在加载', listening: '正在等待唤醒',
    responding: '正在回应，请稍后说话', recording: '正在听',
    transcribing: '正在识别', cooldown: '即将恢复监听',
    failed: '监听失败', unprepared: '资源未就绪',
    checking: '正在校验', downloading: '正在下载', extracting: '正在解压', ready: '已安装',
};

export function buildWake(doc) {
    const root = el(doc, 'section', 'dps-wake');
    const title = el(doc, 'h4', 'dps-subtitle', '语音唤醒');
    const enabled = buildSwitchRow(doc, '为这个助手开启语音唤醒', '共用本机麦克风；仅可见且就绪的桌宠响应。免打扰、锁屏和系统睡眠时暂停。');
    const autoSend = buildSwitchRow(doc, '识别完成后自动发送', '关闭后放入桌宠输入条确认，不会自动携带已有草稿或附件。');
    function field(label, placeholder, maxLength) {
        const row = el(doc, 'label', 'dps-wake-field');
        const input = el(doc, 'input');
        input.type = 'text';
        input.placeholder = placeholder;
        input.maxLength = maxLength;
        row.append(el(doc, 'span', 'dps-row-title', label), input);
        return { row, input };
    }
    const phrases = field('唤醒词（多个别名用 | 分隔）', '小克小克 | xiao3 ke4 xiao3 ke4', 300);
    const response = field('回应语音文案', '嗯，我在，你说。', 100);
    const save = button(doc, 'dps-btn', '保存唤醒设置');
    const generate = button(doc, 'dps-btn', '生成语音');
    const preview = button(doc, 'dps-btn', '试听语音');
    const install = button(doc, 'dps-btn', '下载唤醒模型');
    const importModel = button(doc, 'dps-btn', '导入本地模型');
    const cancel = button(doc, 'dps-btn', '取消下载');
    const retry = button(doc, 'dps-btn', '重新启动监听');
    const audioActions = el(doc, 'div', 'dps-wake-actions');
    audioActions.append(generate, preview);
    const modelActions = el(doc, 'div', 'dps-wake-actions');
    modelActions.append(install, importModel, cancel, retry);
    const status = el(doc, 'p', 'dps-row-hint');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const pronunciation = el(doc, 'p', 'dps-row-hint');
    root.append(title, enabled.row, phrases.row, pronunciation, response.row, audioActions,
        autoSend.row, save, modelActions, status,
        el(doc, 'p', 'dps-row-hint', '支持中文和中文拼音（不是英语）。nuowa 按 nuo wa 解析；建议四音节并填写声调，如 nuo4 wa2 nuo4 wa2。请先安装全局语音设置中的 SenseVoice 资源包。首版请在回应结束后说话，静音约 1.2 秒后完成输入。'));
    return { root, enabled: enabled.input, autoSend: autoSend.input, phrases: phrases.input,
        response: response.input, save, generate, preview, install, importModel, cancel, retry, status, pronunciation };
}

export function wireWake(ctx, parts) {
    let agentId = null;
    let sequence = 0;
    let dirty = false;
    let audio = null;
    let audioUrl = null;
    let busy = false;
    let playbackGeneration = 0;
    function stopAudio() {
        playbackGeneration++;
        audio?.pause();
        audio = null;
        if (audioUrl) ctx.win.URL.revokeObjectURL(audioUrl);
        audioUrl = null;
    }
    function setStatus(value) { parts.status.textContent = value; }
    function renderState(value) {
        const model = value?.model || {};
        const progress = Number.isFinite(model.completedBytes)
            ? ` ${(model.completedBytes / 1048576).toFixed(1)}${model.totalBytes ? ` / ${(model.totalBytes / 1048576).toFixed(1)}` : ''} MB` : '';
        setStatus(`${PHASES[value?.phase] || value?.phase || '未监听'}；唤醒模型：${PHASES[model.phase] || model.phase || '未安装'}${progress}${value?.error ? `；${value.error}` : ''}${model.error ? `；${model.error}` : ''}`);
    }
    async function refresh(id = ctx.state.agentId) {
        if (!id || !ctx.api.getDeskPetWakeStatus) return;
        const token = ++sequence;
        const switched = id !== agentId;
        if (switched) { stopAudio(); dirty = false; }
        agentId = id;
        try {
            const result = await ctx.api.getDeskPetWakeStatus(id);
            if (token !== sequence || id !== ctx.state.agentId) return;
            if (!result?.success) throw new Error(result?.error || '无法读取唤醒配置');
            if (!dirty) {
                parts.enabled.checked = result.config.enabled;
                parts.autoSend.checked = result.config.autoSend;
                parts.phrases.value = result.config.phrases;
                parts.response.value = result.config.responseText;
            }
            parts.preview.disabled = !result.audio.ready;
            parts.pronunciation.textContent = (result.preview || []).map(item =>
                `${item.alias} → ${item.pronunciation}（${item.candidates} 个读音候选）`).join('；');
            renderState({ ...result.state, model: result.model });
            if (result.audio.stale) parts.pronunciation.textContent += '；回应配置已变更，请重新生成语音';
        } catch (error) { if (token === sequence) setStatus(error.message); }
    }
    function values() {
        return { enabled: parts.enabled.checked, autoSend: parts.autoSend.checked,
            phrases: parts.phrases.value, responseText: parts.response.value };
    }
    async function save(id) {
        const result = await ctx.api.updateDeskPetWake(id, values());
        if (!result?.success) throw new Error(result?.error || '保存失败');
        if (id === agentId) dirty = false;
    }
    async function action(work) {
        if (busy || !agentId) return;
        const id = agentId;
        busy = true;
        for (const control of [parts.save, parts.generate, parts.install, parts.importModel, parts.retry]) control.disabled = true;
        try { await work(id); }
        catch (error) { setStatus(error.message); ctx.note(error.message, { error: true }); }
        finally {
            busy = false;
            for (const control of [parts.save, parts.generate, parts.install, parts.importModel, parts.retry]) control.disabled = false;
        }
    }
    for (const input of [parts.enabled, parts.autoSend, parts.phrases, parts.response]) {
        input.addEventListener('input', () => {
            dirty = true;
            if (input === parts.response) { parts.preview.disabled = true; stopAudio(); }
        });
    }
    parts.save.addEventListener('click', () => action(async id => { await save(id); await refresh(); }));
    parts.generate.addEventListener('click', () => action(async id => {
        await save(id);
        setStatus('正在生成回应语音…');
        const result = await ctx.api.generateDeskPetWakeAudio(id);
        if (!result?.success) throw new Error(result?.error || '语音生成失败');
        await refresh();
    }));
    parts.preview.addEventListener('click', () => action(async id => {
        stopAudio();
        const owner = playbackGeneration;
        const result = await ctx.api.getDeskPetWakeAudio(id);
        if (id !== agentId || owner !== playbackGeneration) return;
        if (!result?.audio) throw new Error('没有当前配置对应的回应音频，请先生成');
        const bytes = Uint8Array.from(ctx.win.atob(result.audio.audioData), char => char.charCodeAt(0));
        audioUrl = ctx.win.URL.createObjectURL(new ctx.win.Blob([bytes]));
        audio = new ctx.win.Audio(audioUrl);
        audio.playbackRate = result.audio.playbackRate || 1;
        audio.onended = stopAudio;
        await audio.play();
    }));
    for (const [control, method] of [[parts.install, 'installDeskPetWakeModel'], [parts.importModel, 'importDeskPetWakeModel'], [parts.retry, 'restartDeskPetWake']]) {
        control.addEventListener('click', () => action(async () => {
            const result = await ctx.api[method]();
            if (result?.success === false && !result.cancelled) throw new Error(result.error || '操作未完成');
            await refresh();
        }));
    }
    parts.cancel.addEventListener('click', () => ctx.api.cancelDeskPetWakeInstall?.().catch(error => setStatus(error.message)));
    const off = ctx.api.onDeskPetWakeState?.(value => { if (parts.root.isConnected) renderState(value); });
    return { refresh, hide: stopAudio, dispose() { sequence++; stopAudio(); off?.(); } };
}