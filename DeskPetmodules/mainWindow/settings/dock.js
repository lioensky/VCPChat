// 大预览脚边的小胶囊：和桌面上一样的三态（胶囊 / 输入条 / 录音条）。
// 结构和 DeskPetmodules/dock.css 同一份样式，在这里打的字由桌宠发出去。

import { el, button, icon } from './dom.js';

// 和桌宠页面同样的小胶囊结构（样式见 DeskPetmodules/dock.css）
export function buildDock(doc) {
    const dock = el(doc, 'div', 'pet-dock dps-dock');
    dock.dataset.mode = 'pill';
    const pill = el(doc, 'div', 'dock-layer dock-pill');
    const edit = button(doc, 'dock-btn', undefined, { title: '打字和 TA 说', 'aria-label': '打字' });
    edit.append(icon(doc, 'edit'));
    const voice = button(doc, 'dock-btn', undefined, { title: '说话（本地语音识别）', 'aria-label': '说话' });
    voice.append(icon(doc, 'voice'));
    // 预览里多一个收起钮：点了收成脚边的小横条，光标再进来又撑开（桌面上光标离开就自己收）
    const collapse = button(doc, 'dock-btn', undefined, { title: '收起', 'aria-label': '收起' });
    collapse.append(icon(doc, 'collapse'));
    pill.append(edit, el(doc, 'i', 'dock-sep'), voice, el(doc, 'i', 'dock-sep'), collapse);
    const bar = el(doc, 'form', 'dock-layer dock-bar');
    const fresh = button(doc, 'dock-btn dock-round', undefined, { title: '开新话题', 'aria-label': '开新话题', 'aria-pressed': 'false' });
    fresh.append(icon(doc, 'plus'));
    const input = el(doc, 'textarea', 'dock-input');
    input.rows = 1;
    input.maxLength = 8000;
    input.setAttribute('aria-label', '和桌宠说的话');
    const send = button(doc, 'dock-send is-empty', undefined, { title: '发送（Enter）', 'aria-label': '发送' });
    send.append(icon(doc, 'send'));
    bar.append(fresh, input, send);
    const rec = el(doc, 'div', 'dock-layer dock-rec');
    const recEdit = button(doc, 'dock-btn', undefined, { title: '改成打字', 'aria-label': '打字' });
    recEdit.append(icon(doc, 'edit'));
    const stop = button(doc, 'rec-stop', undefined, { title: '说完了（Esc 取消）', 'aria-label': '说完了' });
    stop.append(el(doc, 'span', 'rec-dot'));
    rec.append(recEdit, stop);
    dock.append(pill, bar, rec);
    return { dock, edit, voice, collapse, bar, fresh, input, send, recEdit, stop };
}

// ctx：{ doc, win, api, state, stage, note, loadDictation }
export function wireDock(ctx, parts) {
    const { doc, win, api, state, stage } = ctx;

    function setDock(mode) {
        parts.dock.dataset.mode = mode;
        stage.dataset.dock = mode;
        if (mode === 'bar') {
            fitInput();
            setTimeout(() => parts.input.focus({ preventScroll: true }), 80);
        }
    }

    // 输入条左边的「+」：这一句开个新话题再发
    function setFresh(on) {
        state.fresh = on;
        parts.fresh.setAttribute('aria-pressed', String(on));
        parts.fresh.title = on ? '取消，接着原来的话题说' : '开新话题';
        parts.input.placeholder = on ? '开始新聊天' : state.placeholder || '';
    }

    function fitInput() {
        const input = parts.input;
        input.style.height = 'auto';
        const height = Math.min(96, Math.max(40, input.scrollHeight || 40));
        input.style.height = `${height}px`;
        parts.dock.style.setProperty('--dock-bar-h', `${height + 12}px`);
        parts.send.classList.toggle('is-empty', !input.value.trim());
    }

    // 大预览换了助手：输入框里的提示语跟着换（正在开新话题时不盖掉「开始新聊天」）
    function setPlaceholder(text) {
        state.placeholder = text;
        if (!state.fresh) parts.input.placeholder = text;
    }

    async function sendFromStage() {
        const text = parts.input.value.trim();
        if (!text || !state.catalog?.agentId) return;
        parts.send.disabled = true;
        try {
            const result = await api.talkToDeskPet(state.catalog.agentId, text, { newTopic: state.fresh });
            if (result?.success) {
                parts.input.value = '';
                setFresh(false);
                fitInput();
                setDock('pill');
                ctx.note(`发给桌面上的 ${state.catalog.name} 了，回复显示在 TA 头上`);
            } else {
                ctx.note(`没发出去：${result?.error || '未知原因'}`, { error: true });
            }
        } finally {
            parts.send.disabled = false;
        }
    }

    async function voice() {
        if (!state.voice) {
            const { createDictation } = await ctx.loadDictation();
            state.voice = createDictation({
                status: () => api.getLocalSttStatus(),
                transcribe: (wav, language) => api.transcribeLocalStt({ wav, language }),
                onLevel: (level) => parts.stop.style.setProperty('--level', level.toFixed(2)),
            });
        }
        return state.voice;
    }

    async function startVoice() {
        const dictation = await voice().catch(() => null);
        if (!dictation || dictation.active || dictation.starting || parts.stop.classList.contains('is-busy')) return;
        const from = parts.dock.dataset.mode;
        setDock('rec');
        try {
            await dictation.start();
            dictation.onLimit(() => finishVoice());
        } catch (error) {
            if (error.code === 'cancelled') return; // 打开麦克风前就被收起：界面已经是别的状态了
            ctx.note(error.message, { error: true, ms: 6000 });
            setDock(from === 'bar' ? 'bar' : 'pill');
        }
    }

    async function finishVoice() {
        const dictation = state.voice;
        // 麦克风还没打开就点了停：当作取消
        if (dictation?.starting) {
            dictation.cancel();
            setDock(parts.input.value.trim() ? 'bar' : 'pill');
            return;
        }
        if (!dictation?.active || parts.stop.classList.contains('is-busy')) return;
        parts.stop.classList.add('is-busy');
        let text = '';
        try {
            text = await dictation.stop();
        } catch (error) {
            ctx.note(error.message, { error: true });
        } finally {
            parts.stop.classList.remove('is-busy');
        }
        if (parts.dock.dataset.mode !== 'rec') return;
        const input = parts.input;
        if (text) input.value = input.value.trim() ? `${input.value.trimEnd()} ${text}` : text;
        else if (!input.value.trim()) ctx.note('没听到说话');
        setDock(input.value.trim() ? 'bar' : 'pill');
    }

    function cancelVoice() {
        state.voice?.cancel();
    }

    parts.edit.addEventListener('click', () => setDock('bar'));
    parts.recEdit.addEventListener('click', () => { cancelVoice(); setDock('bar'); });
    parts.voice.addEventListener('click', startVoice);
    parts.fresh.addEventListener('click', () => { setFresh(!state.fresh); parts.input.focus({ preventScroll: true }); });
    parts.collapse.addEventListener('click', () => setDock('hidden'));
    // 收起后光标回到预览里：停一下再撑开，和桌面上一样
    let reopenTimer = 0;
    stage.addEventListener('pointerenter', () => {
        clearTimeout(reopenTimer);
        if (parts.dock.dataset.mode === 'hidden') reopenTimer = setTimeout(() => { if (parts.dock.dataset.mode === 'hidden') setDock('pill'); }, 220);
    });
    stage.addEventListener('pointerleave', () => clearTimeout(reopenTimer));
    parts.stop.addEventListener('click', finishVoice);
    parts.send.addEventListener('click', sendFromStage);
    parts.bar.addEventListener('submit', (e) => { e.preventDefault(); sendFromStage(); });
    parts.input.addEventListener('input', fitInput);
    parts.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            sendFromStage();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation(); // 别把整个设置关了
            setDock('pill');
        }
    });
    parts.dock.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && parts.dock.dataset.mode === 'rec') {
            e.preventDefault();
            e.stopPropagation();
            cancelVoice();
            setDock('pill');
        }
    });
    // 设置页的 Esc 在 document 捕获阶段就把整个设置关了；输入条 / 录音条展开时，
    // 先在 window 捕获阶段标记掉，Esc 只收回胶囊（上面两个 keydown 照常处理）
    win?.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || parts.dock.dataset.mode === 'pill' || !parts.dock.contains(e.target)) return;
        e.preventDefault();
    }, true);
    // 点到预览外面、输入条是空的：收回小胶囊
    doc.addEventListener('pointerdown', (e) => {
        if (parts.dock.dataset.mode === 'bar' && !parts.input.value.trim() && !parts.dock.contains(e.target)) setDock('pill');
    });

    return {
        setDock,
        cancelVoice,
        setPlaceholder,
        mode: () => parts.dock.dataset.mode,
        hasText: () => Boolean(parts.input.value.trim()),
    };
}
