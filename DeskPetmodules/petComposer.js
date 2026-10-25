// 脚边的小胶囊和输入条：收起 / 胶囊 / 打字 / 录音四种样子（样式在 dock.css），
// 打字发言经主窗口按正常流程走，说话用本机 SenseVoice 识别成文字放进输入条（dictation.js）。
// 悬停展开、延时收起的规则统一在 dockVisibility.js 里。
import { createDictation } from 'vcp-deskpet://pet/app/dictation.js';
import { createDockVisibility } from 'vcp-deskpet://pet/app/dockVisibility.js';

export function createPetComposer(ctx) {
    const { api, $ } = ctx;

    // fresh：输入条左边的「+」按下了，这一句开个新话题再发；queuedFresh：排着的那几句要不要开新话题
    const composer = { open: false, sending: false, queued: null, queuedFresh: false, fresh: false, lastSentAt: 0, ownReplyEndedAt: 0, files: [] };

    // 脚边的小胶囊（样式在 dock.css）：hidden 收起、pill 小胶囊、bar 输入条、rec 录音。
    // 平时只留横条；悬停展开，离开延时收起。输入、录音和主动打开的会话面板保留。
    const dock = { mode: 'hidden', hover: false, dragging: false, voice: null, autoSend: false };
    const dockVisibility = createDockVisibility({ getMode: () => dock.mode, setMode: setDock,
        suppress: value => { $('dock').hidden = value; } });

    function syncDockLayers() {
        for (const layer of $('dock').querySelectorAll('.dock-layer')) {
            const active = layer.classList.contains(`dock-${dock.mode}`);
            layer.inert = !active;
            layer.setAttribute('aria-hidden', String(!active));
        }
        $('dockReveal').hidden = dock.mode !== 'hidden';
    }

    function setDock(mode) {
        if (dock.mode === mode) return;
        const previous = dock.mode;
        dock.mode = mode;
        $('dock').dataset.mode = mode;
        syncDockLayers();
        composer.open = mode === 'bar';
        if (previous === 'rec' && mode !== 'rec') api.manualVoiceCapture?.(false);
        // 只看不点时光标压着角色会变淡：打字、录音时得看得见
        if (mode === 'bar' || mode === 'rec') document.body.classList.remove('is-ghost-hover');
        // 打字、录音的时候别打瞌睡
        ctx.life?.hold('composer', mode === 'bar' || mode === 'rec');
        // 输入条要打字、录音时要能按 Esc 取消：整窗可点、可聚焦；其余时候回到按像素穿透
        const focused = (m) => m === 'bar' || m === 'rec';
        if (focused(mode) !== focused(previous)) {
            api.setInteractive(focused(mode));
            // 收起后主进程回到穿透：下一次命中不管和上次一样不一样都要报上去
            if (!focused(mode)) ctx.forgetHit();
        }
        if (mode === 'bar') {
            fitComposerInput();
            setTimeout(() => $('composerInput').focus(), 60);
        }
        dockVisibility.modeChanged();
    }

    function dockHover(on) {
        if (on === dock.hover) return;
        dock.hover = on;
        dockVisibility.update({ hover: on });
    }

    function restingDock() {
        return dockVisibility.restingMode();
    }

    function openComposer() {
        dock.voice?.cancel();
        setDock('bar');
    }

    function closeComposer() {
        dock.voice?.cancel();
        // 收起就不带这些文件了：不然条收了、📎 还挂在头顶，下一句语音快捷键会把它们一起发出去
        if (composer.files.length) ctx.setFiles([]);
        setDock(restingDock());
    }

    // 输入条里有没有要发的东西（字或文件）
    function hasDraft() {
        return Boolean($('composerInput').value.trim() || composer.files.length);
    }

    // 正在把录音识别成字：这时收起会把识别出的话丢掉
    function transcribing() {
        return $('recStop').classList.contains('is-busy');
    }

    // 输入条跟着字数长高（最多 4 行），外框的高度一起动
    function fitComposerInput() {
        const input = $('composerInput');
        input.style.height = 'auto';
        const height = Math.min(96, Math.max(28, input.scrollHeight));
        input.style.height = `${height}px`;
        $('dock').style.setProperty('--dock-bar-h', `${height + 10}px`);
        $('composerSend').classList.toggle('is-empty', !input.value.trim() && !composer.files.length);
    }

    // ---- 说话：本地语音识别成文字，放进输入条，看一眼再发 ----

    async function startVoice({ autoSend = false } = {}) {
        const voice = dock.voice;
        if (!voice || voice.active || voice.starting || $('recStop').classList.contains('is-busy')) return;
        const from = dock.mode;
        // 开口就是插话：TA 正在念的先停下，也免得麦克风把 TA 的声音录进去
        ctx.speech.stop();
        dock.autoSend = autoSend;
        setDock('rec');
        try {
            await api.manualVoiceCapture?.(true);
            if (dock.mode !== 'rec') { api.manualVoiceCapture?.(false); return; }
            await voice.start();
            voice.onLimit(() => finishVoice());
        } catch (error) {
            api.manualVoiceCapture?.(false);
            if (error.code === 'cancelled') return; // 打开麦克风前就被收起：界面已经是别的状态了
            ctx.notice(error.message, { error: true, ms: error.code === 'no-model' ? 8000 : 5000 });
            setDock(from === 'bar' ? 'bar' : restingDock());
        }
    }

    async function finishVoice() {
        const voice = dock.voice;
        const stop = $('recStop');
        // 麦克风还没打开就点了停：当作取消
        if (voice?.starting) {
            voice.cancel();
            setDock($('composerInput').value.trim() ? 'bar' : restingDock());
            return;
        }
        if (!voice?.active || stop.classList.contains('is-busy')) return;
        stop.classList.add('is-busy');
        let text = '';
        try {
            text = await voice.stop();
        } catch (error) {
            ctx.notice(error.message, { error: true, ms: 5000 });
        } finally {
            stop.classList.remove('is-busy');
        }
        const input = $('composerInput');
        const autoSend = dock.autoSend;
        dock.autoSend = false;
        if (dock.mode !== 'rec') {
            // 识别期间输入条换了状态（点了打字、桌宠被藏起来）：识别出的话放进输入框，不能丢
            if (text) {
                input.value = input.value.trim() ? `${input.value.trimEnd()} ${text}` : text;
                fitComposerInput();
                if (autoSend && !composer.files.length) submitComposer();
                else if (dock.mode !== 'bar') ctx.notice('听到的话放在输入框里了', { ms: 3000 });
            }
            return;
        }
        if (text) {
            input.value = input.value.trim() ? `${input.value.trimEnd()} ${text}` : text;
            setDock('bar');
            fitComposerInput();
            // 语音快捷键录的：不用再看一眼，直接发（TA 还在说就排到说完再发）；
            // 录之前输入条里已经放了文件就不自动发，让人看一眼带的是什么
            if (autoSend && !composer.files.length) submitComposer();
        } else {
            if (!input.value.trim()) ctx.notice('没听到说话', { ms: 3000 });
            setDock(input.value.trim() ? 'bar' : restingDock());
        }
    }

    // 输入条左边的「+」：下一句开个新话题再发（和主窗口的「新话题」一样），再按一下取消
    let petName = 'TA';
    let chatRoute = { mode: 'main', ready: false };
    let routeReceived = false;
    function setChatRoute(route) {
        const previous = chatRoute.mode;
        chatRoute = route?.mode === 'voice' ? { mode: 'voice', ready: route.ready === true } : { mode: 'main', ready: false };
        const voice = chatRoute.mode === 'voice';
        $('dock').dataset.chatRoute = chatRoute.mode;
        $('composerNew').disabled = voice;
        setFresh(voice ? false : composer.fresh);
        if (previous !== chatRoute.mode && composer.queued) {
            const input = $('composerInput');
            input.value = input.value.trim() ? `${composer.queued}\n${input.value}` : composer.queued;
            composer.queued = null;
            composer.queuedFresh = false;
            fitComposerInput();
            ctx.renderBubble();
            ctx.notice('会话已切换，待发送内容已放回输入框，请确认后发送', { ms: 5000 });
        }
    }
    const offRoute = api.onChatRoute?.(route => { routeReceived = true; setChatRoute(route); });
    window.addEventListener('pagehide', () => offRoute?.(), { once: true });
    function initializeChatRoute(route) {
        if (!routeReceived) setChatRoute(route);
    }
    function setFresh(on) {
        composer.fresh = on;
        const button = $('composerNew');
        button.setAttribute('aria-pressed', String(on));
        const voice = chatRoute.mode === 'voice';
        button.title = voice ? '语音会话中不能新建普通话题' : on ? '取消，接着原来的话题说' : '开新话题';
        $('composerInput').placeholder = voice
            ? (chatRoute.ready ? '发送到语音会话…' : '语音会话尚未就绪…')
            : on ? '开始新聊天' : `和 ${petName} 说点什么…`;
        $('composerInput').title = voice
            ? '当前发送到同助手的语音会话；暂不支持附件和新话题'
            : 'Enter 发送，Shift+Enter 换行，Esc 收起';
        $('composerSend').title = voice ? '发送到语音会话' : '发送';
    }

    // 占位只写一句：窄窗口里也不折行；按键提示放在悬停说明里
    function setPetName(name) {
        petName = name;
        setFresh(composer.fresh);
    }

    async function sendText(text, { fresh = false, files = [] } = {}) {
        if (chatRoute.mode === 'voice' && (fresh || files.length || !chatRoute.ready)) {
            ctx.notice(!chatRoute.ready ? '语音会话尚未就绪，请稍后再试'
                : files.length ? '语音会话暂不支持附件，请关闭语音窗口后发送'
                : '语音会话中不能新建普通话题', { error: true });
            return false;
        }
        composer.sending = true;
        $('composerSend').disabled = true;
        fitComposerInput();
        // 先记下发出时间：回复流的开头可能比发送结果先到
        const previousSentAt = composer.lastSentAt;
        composer.lastSentAt = Date.now();
        try {
            const result = await api.send(text, { files, newTopic: fresh });
            if (result?.success) return true;
            composer.lastSentAt = previousSentAt;
            ctx.notice(`没发出去：${result?.error || '未知原因'}`, { error: true });
        } catch (error) {
            composer.lastSentAt = previousSentAt;
            ctx.notice(`没发出去：${error.message}`, { error: true });
        } finally {
            composer.sending = false;
            $('composerSend').disabled = false;
            // 发的时候又排进来一句，而这条的回复已经结束（或根本没开始）：别让它一直排着
            if (composer.queued && !ctx.bubble.replyId) setTimeout(flushQueued, 400);
        }
        return false;
    }

    async function submitComposer() {
        const input = $('composerInput');
        const text = input.value.trim();
        const files = composer.files;
        if ((!text && !files.length) || composer.sending) return;
        if (chatRoute.mode === 'voice' && (files.length || !chatRoute.ready || ctx.bubble.replyId)) {
            ctx.notice(files.length ? '语音会话暂不支持附件，请关闭语音窗口后发送'
                : !chatRoute.ready ? '语音会话尚未就绪，请稍后再试'
                : 'TA 还在回复，文字已保留，请稍后发送', { ms: 4000 });
            return;
        }
        // 带着文件的等 TA 说完再发（排队的那句只记文字）
        if (ctx.bubble.replyId && files.length) {
            ctx.notice('TA 说完再发带文件的这条', { ms: 3000 });
            return;
        }
        // TA 还在说话：先记下来，这条说完再发，不打断也不报错
        if (ctx.bubble.replyId) {
            // 连着说了几句就攒在一起，说完一次发出去
            composer.queued = composer.queued ? `${composer.queued}\n${text}` : text;
            composer.queuedFresh ||= composer.fresh;
            setFresh(false);
            input.value = '';
            fitComposerInput();
            closeComposer();
            ctx.renderBubble();
            return;
        }
        if (await sendText(text, { fresh: composer.fresh, files })) {
            input.value = '';
            ctx.setFiles([]);
            setFresh(false);
            fitComposerInput();
            closeComposer();
        }
    }

    // 回复结束后把排队的那句发出去；发不出去就放回输入框
    async function flushQueued() {
        const text = composer.queued;
        if (!text || ctx.bubble.replyId || composer.sending) return;
        const fresh = composer.queuedFresh;
        composer.queued = null;
        composer.queuedFresh = false;
        ctx.renderBubble();
        if (await sendText(text, { fresh })) return;
        const input = $('composerInput');
        input.value = input.value.trim() ? `${text}\n${input.value}` : text;
        setFresh(fresh || composer.fresh);
        fitComposerInput();
        // 正在录音就别打断，放回输入框的话录完一起看到
        if (dock.mode !== 'rec') openComposer();
    }

    function bindComposer() {
        const input = $('composerInput');
        const offWakeStatus = api.onWakeStatus?.(text => ctx.notice(text, { ms: 5000 }));
        const offWakeText = api.onWakeText?.(async ({ text, autoSend } = {}) => {
            if (typeof text !== 'string' || !text.trim()) return;
            // 唤醒输入是独立请求，不读取已有草稿、附件或“新话题”开关。
            if (autoSend && !composer.sending && !ctx.bubble.replyId) {
                if (await sendText(text)) return;
            }
            input.value = input.value.trim() ? `${input.value.trimEnd()}\n${text}` : text;
            fitComposerInput();
            openComposer();
            ctx.notice('听到的话已放入输入条，请确认后发送', { ms: 5000 });
        });
        window.addEventListener('pagehide', () => { offWakeStatus?.(); offWakeText?.(); }, { once: true });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                submitComposer();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeComposer();
            }
        });
        input.addEventListener('input', fitComposerInput);
        $('composer').addEventListener('submit', (e) => { e.preventDefault(); submitComposer(); });
        $('composerSend').addEventListener('click', submitComposer);
        $('dockEdit').addEventListener('click', openComposer);
        $('recEdit').addEventListener('click', openComposer);
        $('dockVoice').addEventListener('click', startVoice);
        $('composerNew').addEventListener('click', () => { setFresh(!composer.fresh); input.focus(); });
        $('recStop').addEventListener('click', finishVoice);
        dock.voice = createDictation({
            status: () => api.sttStatus(),
            transcribe: (wav, language) => api.transcribe(wav, language),
            onLevel: (level) => $('recStop').style.setProperty('--level', level.toFixed(2)),
        });
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && dock.mode === 'rec') {
                e.preventDefault();
                dock.voice.cancel();
                setDock(restingDock());
            }
        });
        fitComposerInput();
        // 快捷键再按一次是收起（输入框里还有字时不收，免得误按丢了）；设置页预览里打的字直接发出去
        api.onOpenInput(({ toggle, submit, voice, newTopic } = {}) => {
            if (voice) {
                // 语音快捷键：没在录就开始录，正在录就停下发出去
                if (dock.mode === 'rec') {
                    // 用麦克风键开始录的也一样：快捷键这一下就是「停下发出去」
                    dock.autoSend = true;
                    finishVoice();
                } else startVoice({ autoSend: true });
                return;
            }
            if (submit) {
                // 不展开输入条、不抢焦点（人还在主窗口的设置页里），也不动桌宠输入条里已经打的字；
                // TA 正在回或上一句还在发：排到这条说完再发，连着来的几句不会互相顶掉
                if (composer.sending || ctx.bubble.replyId) {
                    composer.queued = composer.queued ? `${composer.queued}\n${submit}` : submit;
                    composer.queuedFresh ||= newTopic === true;
                    ctx.renderBubble();
                } else sendText(submit, { fresh: newTopic === true });
            } else if (toggle && composer.open && !input.value.trim()) closeComposer();
            else openComposer();
        });
        // 失焦（点到别的程序）且没写东西时自动收起，回到穿透状态。
        window.addEventListener('blur', () => {
            // 录音中切到别的程序：麦克风别一直开着（Esc 也按不到这里了）
            if (dock.mode === 'rec') {
                if (!transcribing()) closeComposer();
            } else if (composer.open && !hasDraft()) closeComposer();
        });
    }

    return {
        composer, dock, dockVisibility, syncDockLayers, setDock, dockHover, restingDock,
        openComposer, closeComposer, hasDraft, transcribing, fitComposerInput, setFresh, setPetName, initializeChatRoute,
        startVoice, finishVoice, sendText, submitComposer, flushQueued, bindComposer,
    };
}
