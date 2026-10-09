// VCPChat 桌宠页面。
//   形象：Live2D（agent 的 deskpet/ 里有 .model3.json，且用户放了 5.x 的 Cubism Core）
//        → 网格立绘（deskpet/ 里有 .puppet.json，一张图切块做的可动角色，不需要 Core）
//        → 差分立绘（portrait.<情绪>.png，与侧栏首页立绘同一套约定）→ 头像加情绪色环。
//   表情：主进程把这个 agent 的回复流原样转过来，交给与侧栏立绘共用的情绪导演
//        （modules/emotion），导演给出 { state, emotion, intensity } 帧。
//   对话：光标停在角色上时脚边冒出小胶囊（打字 / 说话），双击角色或右键「和 TA 说话」直接展开输入条；
//        话经主窗口按正常流程发送，回复显示在气泡里。说话用本地 SenseVoice 识别成文字放进输入条。
//   预览：?preview=1 时只画角色，量好位置报给主进程截图（设置页卡片用），不接回复流、不出声。
import { createEmotionDirector } from 'vcp-deskpet://pet/emotion/emotionDirector.js';
import { createEmotionTagScanner } from 'vcp-deskpet://pet/emotion/emotionTags.js';
import { toBubbleText } from 'vcp-deskpet://pet/app/bubbleText.js';
import { createSpeech } from 'vcp-deskpet://pet/app/voice.js';
import { createToolCard } from 'vcp-deskpet://pet/app/toolCard.js';
import { createMoodOrder } from 'vcp-deskpet://pet/app/moodOrder.js';
import { createPetLife } from 'vcp-deskpet://pet/app/petLife.js';
import { createDictation } from 'vcp-deskpet://pet/app/dictation.js';
import { createApprovalQueue } from 'vcp-deskpet://pet/app/approvals.js';
import { isMissed } from 'vcp-deskpet://pet/app/missedReply.js';
import { addFiles, describeFiles, pastedName, MAX_FILES, MAX_PASTE_BYTES } from 'vcp-deskpet://pet/app/attachments.js';
import { gestureOf, dueGestures } from 'vcp-deskpet://pet/app/gestures.js';
import { EMOTION_LABEL, EMOTION_EMOJI } from 'vcp-deskpet://pet/app/emotionLook.js';
import { TOP_RESERVE, CONTEXT_LOSS_LIMIT, recentContextLosses } from 'vcp-deskpet://pet/app/petStage.js';
import { createLive2DBackend, live2DFailureText } from 'vcp-deskpet://pet/app/live2dBackend.js';
import { createPuppetBackend } from 'vcp-deskpet://pet/app/puppetBackend.js';
import { createImageBackend } from 'vcp-deskpet://pet/app/imageBackend.js';
import { createLifeFx } from 'vcp-deskpet://pet/app/lifeFx.js';

const api = window.deskPetAPI;
const PREVIEW = new URLSearchParams(location.search).has('preview');
// 有回复、刚被碰过时形象按 active 档帧率画，空闲这么久降到 idle，睡着了再降到 sleep（档位在 petStage.js）
const IDLE_AFTER_MS = 30000;
// 溜达（设置里打开）：这么久没人理、站在任务栏上才走；走过一次以后隔一阵再走
const WANDER_AFTER_MS = 60000;
const WANDER_GAP_MS = [40000, 100000];
// 回复结束后气泡停留多久：按字数给时间读完，鼠标停在气泡上时不收
const REPLY_HOLD_MIN_MS = 8000;
const REPLY_HOLD_MAX_MS = 30000;
const REPLY_HOLD_PER_CHAR_MS = 60;
const REPLY_HOLD_AFTER_HOVER_MS = 4000;
const BUBBLE_MAX_CHARS = 600;  // 气泡只留最后这么多字，完整内容在主窗口
const DOUBLE_TAP_MS = 300;     // 这么短内的第二下算双击；单击的反应等这段时间过了再做
const DOCK_BOTTOM = 6;         // 小胶囊离窗口底边（与 #dock 的 bottom 一致）
const DOCK_SHOW_MS = 220;      // 光标在角色上停这么久，脚边的小胶囊冒出来
const DOCK_HIDE_MS = 1400;     // 光标离开这么久，小胶囊收回去

const STATE_LABEL = { thinking: '思考中…', tool: '调用工具中…', error: '出错了' };
// 被碰到才有的反应：回到高帧率；其余闲时小动作按当前帧率演
const USER_REACTIONS = new Set(['poke', 'headTap', 'pat', 'annoyed', 'dizzy', 'startle', 'wake', 'landed']);
// 反应期间临时换的情绪（立绘换差分、Live2D 换表情），演完换回来
const REACTION_EMOTION = { headTap: 'shy', pat: 'affectionate', annoyed: 'angry', dizzy: 'surprised', startle: 'surprised' };
const LIFE_ANNOYED_AT = 3; // 与 petLife 的 annoyedAt 一致：连点到这一下就不再打开输入框

const $ = (id) => document.getElementById(id);
let backend = null;
let frame = { state: null, emotion: 'neutral', intensity: 0, source: 'idle' };
let lastActivity = Date.now();
let life = null; // petLife：闲时小动作、困了睡、被吵醒、连点和摸头（start 里创建）

// 主进程给的设置：大小、免打扰。别的模块（声音、待机反应）读 window.deskPetPrefs 或听 'deskpet:prefs' 事件。
let prefs = { scale: 1, doNotDisturb: false, clickThrough: false };
let prefsLoaded = false;
// 免打扰时只有「在回桌宠上说的话」的回复还显示气泡：发出后这么久内开始的回复，
// 以及紧接着这种回复（工具调用后的续写）开始的回复
const OWN_REPLY_WINDOW_MS = 30000;
const OWN_FOLLOW_UP_MS = 5000;

// ---- 气泡：状态、回复文字、提示 ----------------------------------------------

const bubble = {
    reply: '',          // 当前回复里可见的文字（还带着 Markdown 记号，显示前再整理）
    replyId: null,      // 正在流式的回复
    region: null,       // 回复正读到哪种区域（thought / tool / code），null 是正文
    notice: null,       // { text, error }，临时提示，优先显示
    own: false,         // 这条回复是不是在回桌宠上说的话
    proactive: null,    // 角色主动说的话（新话题、闹钟）：{ kind, title, topicId }，正文放在 reply 里
    tags: [],           // 回复里的情绪标记 { at, emotion, intensity }，at 是它在 reply 里的位置（朗读时按句换表情）
    hovered: false,
    startedAt: 0,       // 这条回复（主动说的话）开始的时候
    endedAt: 0,         // 说完的时候
    heardAt: 0,         // 最近一次真的念出声的时候：念出来过就算听到了
    hideTimer: 0,
    noticeTimer: 0,
    renderQueued: false,
};

// ---- 出声：回复按句交给 TTS，气泡和表情跟着念到的那一句走（见 voice.js） ----------------

let director = null;
const speech = createSpeech({
    api,
    onChange: () => {
        // 念着的时候不打哈欠、不睡着
        life?.hold('speak', speech.active());
        renderBubble();
        // 回复早就结束、刚念完：现在才开始算气泡停留时间
        // 闹钟、新话题按它们自己的停留时间算（念完不能把 60 秒的闹钟缩成几秒）
        if (!bubble.replyId && !speech.active() && bubble.reply) scheduleReplyHide(Math.max(replyHoldMs(), PROACTIVE_HOLD_MS[bubble.proactive?.kind] || 0));
    },
    onFrame: (next) => applyFrame(next),
    onRelease: () => { if (director) applyFrame(director.frame); },
    onLevel: (open) => {
        document.body.style.setProperty('--voice', open.toFixed(3));
        backend?.setMouth?.(open);
        if (open) lastActivity = bubble.heardAt = Date.now();
    },
    onError: (error) => console.warn('[DeskPet] 播放朗读音频失败：', error?.message || error),
});

// 说话时嘴张多大：朗读时跟着声音走；没有朗读时，回复流出来的那段时间假装在说（fake 给出假口型）。
function talkLevel(fake) {
    const voiced = speech.mouth();
    if (voiced != null) return voiced;
    return bubble.replyId && !frame.state ? fake() : 0;
}

// 状态写在回复下方的小字里：思考只在真的读到思维链时提示（刚开口那一下导演还停在「思考」上）
function replyStateLabel() {
    if (!frame.state) return '';
    if (frame.state === 'thinking') return bubble.replyId && bubble.region === 'thought' ? STATE_LABEL.thinking : '';
    if (frame.state === 'tool' && toolCard?.visible) return ''; // 小卡片已经说了在做什么
    return STATE_LABEL[frame.state] || '';
}

function renderBubble() {
    bubble.renderQueued = false;
    const el = $('bubble');
    const text = $('bubbleText');
    let content = '';
    let mode = '';
    // 免打扰：主窗口里聊天的回复不在桌宠头上冒出来，只有在桌宠上说的话才回气泡
    const muted = isQuiet() && !bubble.own;
    // 朗读时只显示到正在念的这一句；还没开口时显示省略号
    const revealEnd = speech.revealEnd();
    const source = revealEnd == null ? bubble.reply : bubble.reply.slice(0, revealEnd);
    const waiting = revealEnd != null && !source.trim() && speech.active();
    const reply = muted ? '' : source.trim() ? toBubbleText(source) : (waiting ? '…' : '');
    // 回复里写了动作：显示（念）到那句时演出来；免打扰下不冒气泡的回复也不动
    if (!muted && life) for (const gesture of dueGestures(bubble.tags, revealEnd)) life.perform(gesture);
    if (bubble.notice) {
        content = bubble.notice.text;
        mode = bubble.notice.error ? 'is-error' : 'is-notice';
    } else if (reply) {
        content = reply;
        mode = 'is-reply';
    } else if (!muted && frame.state && STATE_LABEL[frame.state] && !(frame.state === 'tool' && toolCard?.visible)) {
        content = STATE_LABEL[frame.state];
        mode = 'is-state';
    }
    el.hidden = !content;
    el.className = `pet-ui ${mode}`;
    el.classList.toggle('is-streaming', mode === 'is-reply' && (Boolean(bubble.replyId) || speech.active()));
    const shown = content.length > BUBBLE_MAX_CHARS ? `…${content.slice(-BUBBLE_MAX_CHARS)}` : content;
    if (text.textContent !== shown) {
        text.textContent = shown;
        // 只有用户没往上翻时才跟到底部
        if (!bubble.hovered) text.scrollTop = text.scrollHeight;
    }
    // 排队等发的话写在小字里，不盖住正在说的回复
    const queued = composer.queued ? `说完就发：「${shorten(composer.queued)}」` : '';
    $('bubbleState').textContent = mode === 'is-reply' || mode === 'is-state'
        ? [mode === 'is-reply' ? replyStateLabel() || proactiveLabel() : '', queued].filter(Boolean).join(' · ')
        : '';
    el.classList.toggle('is-alarm', mode === 'is-reply' && bubble.proactive?.kind === 'alarm');
    // 还在回（或还在念）：右上角能叫停
    $('bubbleStop').hidden = !((mode === 'is-reply' || mode === 'is-state') && (bubble.replyId || speech.active()));
    if (content) aimBubble(aimedHeadX);
}

// 流式片段很密，攒到下一帧一起画
function queueRenderBubble() {
    if (bubble.renderQueued) return;
    bubble.renderQueued = true;
    requestAnimationFrame(renderBubble);
}

function replyHoldMs() {
    const length = toBubbleText(bubble.reply).length;
    return Math.min(REPLY_HOLD_MAX_MS, Math.max(REPLY_HOLD_MIN_MS, length * REPLY_HOLD_PER_CHAR_MS));
}

function scheduleReplyHide(ms) {
    clearTimeout(bubble.hideTimer);
    bubble.hideTimer = setTimeout(() => {
        // 还在念就等念完（念完时会重新计时）
        if (bubble.replyId || bubble.hovered || speech.active()) return;
        keepIfMissed();
        bubble.reply = '';
        bubble.proactive = null;
        renderBubble();
    }, ms);
}

// ---- 没看到的回复 -------------------------------------------------------------------
// 气泡到点就收起；收起时桌宠藏着、或者人一直没碰键盘鼠标（走开了），这段话就留着，
// 头边一个 💬，点一下把它再摆出来。来了新回复就换成新的。

const missed = { reply: '', proactive: null };

function keepIfMissed() {
    const muted = isQuiet() && !bubble.own;
    if (!bubble.reply.trim() || muted || bubble.notice) return;
    const saved = { reply: bubble.reply, proactive: bubble.proactive };
    const times = { startedAt: bubble.startedAt, endedAt: bubble.endedAt, heardAt: bubble.heardAt };
    const hidden = document.body.classList.contains('is-paused');
    if (!hidden && times.heardAt > times.startedAt) return;
    const idle = hidden ? Promise.resolve(0) : Promise.resolve(api.idleSeconds?.()).then((s) => Number(s) * 1000, () => 0);
    idle.then((idleMs) => {
        if (!isMissed({ hidden, idleMs, now: Date.now(), ...times })) return;
        if (bubble.replyId || bubble.reply) return; // 已经在说新的了
        Object.assign(missed, saved);
        $('missedBadge').hidden = false;
    });
}

function clearMissed() {
    missed.reply = '';
    missed.proactive = null;
    $('missedBadge').hidden = true;
}

function replayMissed() {
    if (!missed.reply || bubble.replyId) return;
    bubble.reply = missed.reply;
    bubble.proactive = missed.proactive;
    bubble.tags = [];
    bubble.endedAt = Date.now();
    clearMissed();
    renderBubble();
    scheduleReplyHide(replyHoldMs());
}

function proactiveLabel() {
    const p = bubble.proactive;
    if (!p) return '';
    if (p.kind === 'alarm') return '⏰ 闹钟';
    return p.title ? `💬 新话题「${shorten(p.title)}」· 点我去看` : '💬 新话题 · 点我去看';
}

// 角色主动说话（AI 开了新话题、闹钟到点）。正在回复时先记着，回复说完再说。
const PROACTIVE_HOLD_MS = { topic: 20000, alarm: 60000 };
let pendingProactive = [];
let toolCard = null; // 「正在做什么」小卡片（bindStream 里建）
let proactiveDirector = null;

function speakProactive(payload) {
    if (!payload?.text && !payload?.title) return;
    if (bubble.replyId || speech.active()) {
        pendingProactive = [...pendingProactive, payload].slice(-3);
        // 上一条已经回复完、只是还在念：念完再说
        if (!bubble.replyId) setTimeout(flushProactive, 1500);
        return;
    }
    const kind = payload.kind === 'alarm' ? 'alarm' : 'topic';
    // 免打扰：自己开新话题这种不说；闹钟是用户自己定的，照常叫
    if (kind !== 'alarm' && isQuiet()) return;
    bubble.proactive = { kind, title: payload.title || '', topicId: payload.topicId || '' };
    bubble.own = kind === 'alarm';
    bubble.reply = payload.text || payload.title;
    bubble.startedAt = bubble.endedAt = Date.now();
    clearMissed();
    lastActivity = Date.now();
    life?.wake({ startle: true });
    // 闲时搭话带着自己写的情绪；别的按种类给个默认
    const emotion = typeof payload.emotion === 'string' && payload.emotion ? payload.emotion : (kind === 'alarm' ? 'excited' : 'happy');
    proactiveDirector?.nudge({ emotion, intensity: Number.isFinite(payload.intensity) ? payload.intensity : 0.7, source: 'proactive' });
    backend?.tap?.();
    // 主动说的话也念出来（助手设了音色、没在菜单里关掉朗读时）
    speech.begin(`deskpet-proactive-${Date.now()}`, { silent: isQuiet() && !bubble.own });
    speech.finish(bubble.reply, proactiveDirector?.frame);
    renderBubble();
    scheduleReplyHide(PROACTIVE_HOLD_MS[kind]);
}

function flushProactive() {
    const next = pendingProactive.shift();
    if (next) speakProactive(next);
}

function notice(text, { error = false, ms = 6000 } = {}) {
    bubble.notice = text ? { text, error } : null;
    clearTimeout(bubble.noticeTimer);
    if (text) bubble.noticeTimer = setTimeout(() => { bubble.notice = null; renderBubble(); }, ms);
    renderBubble();
}

let badgeTimer = 0;
function flashEmotionBadge(emotion, source) {
    if (isQuiet()) return;
    const el = $('emotionBadge');
    const suffix = source === 'rule' ? '（推测）' : source === 'mood' ? '（心情）' : '';
    el.textContent = `${EMOTION_EMOJI[emotion] || ''} ${EMOTION_LABEL[emotion] || emotion}${suffix}`;
    el.hidden = false;
    el.classList.remove('is-fading');
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => el.classList.add('is-fading'), 2500);
}

// ---- 输入框 ---------------------------------------------------------------------

// fresh：输入条左边的「+」按下了，这一句开个新话题再发；queuedFresh：排着的那几句要不要开新话题
const composer = { open: false, sending: false, queued: null, queuedFresh: false, fresh: false, lastSentAt: 0, ownReplyEndedAt: 0, files: [] };

// 脚边的小胶囊（样式在 dock.css）：hidden 收起、pill 小胶囊、bar 输入条、rec 录音。
// tucked：点了胶囊上的「收起」，光标离开之前不再冒出来
const dock = { mode: 'hidden', hover: false, dragging: false, tucked: false, showTimer: 0, hideTimer: 0, voice: null, autoSend: false };

function setDock(mode) {
    if (dock.mode === mode) return;
    const previous = dock.mode;
    dock.mode = mode;
    $('dock').dataset.mode = mode;
    composer.open = mode === 'bar';
    // 只看不点时光标压着角色会变淡：打字、录音时得看得见
    if (mode === 'bar' || mode === 'rec') document.body.classList.remove('is-ghost-hover');
    // 打字、录音的时候别打瞌睡
    life?.hold('composer', mode === 'bar' || mode === 'rec');
    // 输入条要打字、录音时要能按 Esc 取消：整窗可点、可聚焦；其余时候回到按像素穿透
    const focused = (m) => m === 'bar' || m === 'rec';
    if (focused(mode) !== focused(previous)) {
        api.setInteractive(focused(mode));
        // 收起后主进程回到穿透：下一次命中不管和上次一样不一样都要报上去
        if (!focused(mode)) lastHit = null;
    }
    if (mode === 'bar') {
        fitComposerInput();
        setTimeout(() => $('composerInput').focus(), 60);
    }
}

// 光标进出角色（或小胶囊本身）：停一下才冒出来，离开一会儿才收回去；输入条、录音时不跟着收
function dockHover(on) {
    if (on === dock.hover) return;
    dock.hover = on;
    clearTimeout(dock.showTimer);
    clearTimeout(dock.hideTimer);
    if (!on) dock.tucked = false;
    if (dock.mode === 'bar' || dock.mode === 'rec') return;
    if (on && dock.mode === 'hidden' && !dock.tucked) {
        dock.showTimer = setTimeout(() => { if (dock.hover && !dock.dragging) setDock('pill'); }, DOCK_SHOW_MS);
    } else if (!on && dock.mode === 'pill') {
        dock.hideTimer = setTimeout(() => { if (!dock.hover) setDock('hidden'); }, DOCK_HIDE_MS);
    }
}

function restingDock() {
    return dock.hover && !dock.dragging && !dock.tucked ? 'pill' : 'hidden';
}

function openComposer() {
    dock.voice?.cancel();
    setDock('bar');
}

function closeComposer() {
    dock.voice?.cancel();
    // 收起就不带这些文件了：不然条收了、📎 还挂在头顶，下一句语音快捷键会把它们一起发出去
    if (composer.files.length) setFiles([]);
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
    const height = Math.min(96, Math.max(40, input.scrollHeight));
    input.style.height = `${height}px`;
    $('dock').style.setProperty('--dock-bar-h', `${height + 12}px`);
    $('composerSend').classList.toggle('is-empty', !input.value.trim() && !composer.files.length);
}

// ---- 说话：本地语音识别成文字，放进输入条，看一眼再发 ----

async function startVoice({ autoSend = false } = {}) {
    const voice = dock.voice;
    if (!voice || voice.active || voice.starting || $('recStop').classList.contains('is-busy')) return;
    const from = dock.mode;
    // 开口就是插话：TA 正在念的先停下，也免得麦克风把 TA 的声音录进去
    speech.stop();
    dock.autoSend = autoSend;
    setDock('rec');
    try {
        await voice.start();
        voice.onLimit(() => finishVoice());
    } catch (error) {
        if (error.code === 'cancelled') return; // 打开麦克风前就被收起：界面已经是别的状态了
        notice(error.message, { error: true, ms: error.code === 'no-model' ? 8000 : 5000 });
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
        notice(error.message, { error: true, ms: 5000 });
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
            else if (dock.mode !== 'bar') notice('听到的话放在输入框里了', { ms: 3000 });
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
        if (!input.value.trim()) notice('没听到说话', { ms: 3000 });
        setDock(input.value.trim() ? 'bar' : restingDock());
    }
}

function shorten(text, max = 16) {
    const flat = text.replace(/\s+/g, ' ');
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// 输入条左边的「+」：下一句开个新话题再发（和主窗口的「新话题」一样），再按一下取消
let petName = 'TA';
function setFresh(on) {
    composer.fresh = on;
    const button = $('composerNew');
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? '取消，接着原来的话题说' : '开新话题';
    $('composerInput').placeholder = on ? '开始新聊天' : `和 ${petName} 说点什么…`;
}

async function sendText(text, { fresh = false, files = [] } = {}) {
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
        notice(`没发出去：${result?.error || '未知原因'}`, { error: true });
    } catch (error) {
        composer.lastSentAt = previousSentAt;
        notice(`没发出去：${error.message}`, { error: true });
    } finally {
        composer.sending = false;
        $('composerSend').disabled = false;
        // 发的时候又排进来一句，而这条的回复已经结束（或根本没开始）：别让它一直排着
        if (composer.queued && !bubble.replyId) setTimeout(flushQueued, 400);
    }
    return false;
}

async function submitComposer() {
    const input = $('composerInput');
    const text = input.value.trim();
    const files = composer.files;
    if ((!text && !files.length) || composer.sending) return;
    // 带着文件的等 TA 说完再发（排队的那句只记文字）
    if (bubble.replyId && files.length) {
        notice('TA 说完再发带文件的这条', { ms: 3000 });
        return;
    }
    // TA 还在说话：先记下来，这条说完再发，不打断也不报错
    if (bubble.replyId) {
        // 连着说了几句就攒在一起，说完一次发出去
        composer.queued = composer.queued ? `${composer.queued}\n${text}` : text;
        composer.queuedFresh ||= composer.fresh;
        setFresh(false);
        input.value = '';
        fitComposerInput();
        closeComposer();
        renderBubble();
        return;
    }
    if (await sendText(text, { fresh: composer.fresh, files })) {
        input.value = '';
        setFiles([]);
        setFresh(false);
        fitComposerInput();
        closeComposer();
    }
}

// ---- 给桌宠文件：拖到桌宠上、往输入框里粘贴图片 ---------------------------------------

function setFiles(list) {
    composer.files = list;
    $('attachText').textContent = describeFiles(list);
    $('attachText').title = list.map((f) => f.name).join('\n');
    $('attachTray').hidden = !list.length;
    $('composerSend').classList.toggle('is-empty', !$('composerInput').value.trim() && !list.length);
}

function takeFiles(files) {
    const { list, dropped } = addFiles(composer.files, files);
    setFiles(list);
    if (dropped) notice(`一次最多带 ${MAX_FILES} 个文件，有 ${dropped} 个没加上`, { ms: 3500 });
    // 正在录音：文件先挂上，录完进输入条时一起看到；不打断录音
    if (dock.mode === 'rec') return;
    if (list.length) {
        openComposer();
        requestAnimationFrame(() => $('composerInput').focus());
    }
}

function bindFileDrop() {
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    let depth = 0;
    const leave = () => { depth = 0; document.body.classList.remove('is-drop-target'); };
    // 不拦的话，文件掉进来窗口会直接打开这个文件
    window.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth += 1;
        document.body.classList.add('is-drop-target');
    });
    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = hasFiles(e) ? 'copy' : 'none';
    });
    window.addEventListener('dragleave', () => { if (--depth <= 0) leave(); });
    window.addEventListener('drop', (e) => {
        e.preventDefault();
        leave();
        const files = [...(e.dataTransfer?.files || [])].map((file) => ({
            path: api.filePath?.(file) || '',
            name: file.name,
            type: file.type,
            size: file.size,
        })).filter((f) => f.path);
        if (files.length) takeFiles(files);
    });
    $('composerInput').addEventListener('paste', async (e) => {
        const images = [...(e.clipboardData?.items || [])].filter((item) => item.kind === 'file' && item.type.startsWith('image/'));
        if (!images.length) return;
        e.preventDefault();
        const files = [];
        for (const item of images) {
            const file = item.getAsFile();
            if (!file) continue;
            if (file.size > MAX_PASTE_BYTES) {
                notice('图片太大了（超过 20 MB），拖文件进来试试', { error: true, ms: 3500 });
                continue;
            }
            const data = new Uint8Array(await file.arrayBuffer());
            files.push({ data, name: pastedName(file.type), type: file.type, size: data.length });
        }
        if (files.length) takeFiles(files);
    });
    $('attachClear').addEventListener('click', (e) => {
        e.stopPropagation();
        setFiles([]);
    });
}

// 回复结束后把排队的那句发出去；发不出去就放回输入框
async function flushQueued() {
    const text = composer.queued;
    if (!text || bubble.replyId || composer.sending) return;
    const fresh = composer.queuedFresh;
    composer.queued = null;
    composer.queuedFresh = false;
    renderBubble();
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
    $('dockHide').addEventListener('click', () => {
        dock.tucked = true;
        setDock('hidden');
    });
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
    // 点气泡打开主窗口看完整回复；鼠标停在气泡上时先不收起，方便读完或往上翻。
    const bubbleEl = $('bubble');
    bubbleEl.addEventListener('click', () => {
        // 主动开的新话题：直接切到那个话题
        if (bubble.proactive?.topicId && !bubble.replyId) api.openTopic(bubble.proactive.topicId);
        else api.openMainWindow();
    });
    // 停止键：回复还在流就让主窗口中止那条请求（和主窗口的停止键一样），在念的也不念了
    $('bubbleStop').addEventListener('click', (e) => {
        e.stopPropagation();
        if (bubble.replyId) api.interrupt?.(bubble.replyId);
        speech.stop();
        queueRenderBubble();
    });
    $('missedBadge').addEventListener('click', (e) => {
        e.stopPropagation();
        replayMissed();
    });
    bubbleEl.addEventListener('mouseenter', () => {
        bubble.hovered = true;
        clearTimeout(bubble.hideTimer);
    });
    bubbleEl.addEventListener('mouseleave', () => {
        bubble.hovered = false;
        if (bubble.reply && !bubble.replyId) scheduleReplyHide(REPLY_HOLD_AFTER_HOVER_MS);
    });
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
            if (composer.sending || bubble.replyId) {
                composer.queued = composer.queued ? `${composer.queued}\n${submit}` : submit;
                composer.queuedFresh ||= newTopic === true;
                renderBubble();
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

// 气泡、输入框这些界面元素也要能点到（按像素穿透只看角色本身）。
function uiAt(x, y) {
    return Boolean(document.elementFromPoint(x, y)?.closest('.pet-ui'));
}

function union(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

// 正在显示的气泡、输入条这些；withIdleDock：连收起时脚边那道小横条也算上
// （只给 Linux 的窗口形状用，不算就画不出来；闲逛、贴边探头只看真正打开的界面）
// withBadge：头边那个「没看到的回复」小气泡算不算（溜达不看它，不然它挂着就永远不走）
function uiBounds({ withIdleDock = false, withBadge = true } = {}) {
    let rect = null;
    for (const el of document.querySelectorAll('.pet-ui')) {
        if (el.hidden || (el.dataset.mode === 'hidden' && !withIdleDock)) continue;
        if (!withBadge && el.id === 'missedBadge') continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        rect = rect ? union(rect, r) : { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return rect;
}

// 气泡挪到头的正上方（窗口比气泡宽时），小尾巴指着头
let aimedHeadX = null;
function aimBubble(headX) {
    aimedHeadX = headX;
    if (headX === null) return;
    const stack = $('uiStack');
    const room = stack.clientWidth;
    const left = stack.getBoundingClientRect().left;
    for (const el of [$('bubble'), $('toolCard'), $('approvalCard')]) {
        if (el.hidden) continue;
        const width = el.offsetWidth;
        const slack = Math.max(0, (room - width) / 2);
        const shift = Math.round(Math.max(-slack, Math.min(slack, headX - left - room / 2)));
        el.style.translate = shift ? `${shift}px 0` : '';
        if (el.id === 'bubble') {
            const bubbleLeft = left + (room - width) / 2 + shift;
            el.style.setProperty('--tail-x', `${Math.round(Math.max(16, Math.min(width - 16, headX - bubbleLeft)))}px`);
        }
    }
}

// ---- 工具审批 ---------------------------------------------------------------------
// 回复里要调的工具得有人点头时，主窗口除了自己的通知卡，也把它转给这个助手的桌宠。
// 这里点了允许/拒绝交回主窗口去应答；任何一边答完、过期，主进程都会叫这里收起。

function bindApprovals(director) {
    const queue = createApprovalQueue();
    const card = $('approvalCard');
    let expiryTimer = 0;
    let answering = '';
    const render = () => {
        const item = queue.current;
        const wasHidden = card.hidden;
        card.hidden = !item;
        clearTimeout(expiryTimer);
        if (item) {
            $('approvalTitle').textContent = `要用「${item.toolName}」吗？`;
            $('approvalTitle').title = item.toolName;
            $('approvalCommand').textContent = item.command;
            $('approvalCommand').title = item.command;
            const more = queue.size - 1;
            $('approvalMore').textContent = more > 0 ? `还有 ${more} 个` : '';
            for (const id of ['approvalAllow', 'approvalReject']) $(id).disabled = answering === item.requestId;
            if (item.expiresAt) expiryTimer = setTimeout(render, Math.max(0, item.expiresAt - Date.now()) + 50);
        }
        if (wasHidden && item) {
            // 有事要问：露出担心的样子，从睡着/待机里醒过来
            lastActivity = Date.now();
            director.nudge({ emotion: 'concerned', intensity: 0.7, source: 'approval' });
        }
        if (wasHidden !== card.hidden) aimBubble(aimedHeadX);
    };
    const answer = (approved) => {
        const item = queue.current;
        if (!item || answering === item.requestId) return;
        answering = item.requestId;
        api.answerApproval(item.requestId, approved);
        render();
    };
    $('approvalAllow').addEventListener('click', (e) => { e.stopPropagation(); answer(true); });
    $('approvalReject').addEventListener('click', (e) => { e.stopPropagation(); answer(false); });
    $('approvalDetail').addEventListener('click', (e) => { e.stopPropagation(); api.openMainWindow(); });
    api.onApproval?.((payload) => {
        if (queue.add(payload)) render();
    });
    api.onApprovalClear?.((requestId) => {
        if (!queue.remove(String(requestId))) return;
        if (answering === String(requestId)) answering = '';
        render();
    });
}

// ---- 拖动、点击、双击、右键 -------------------------------------------------------

// 角色在窗口里的包围盒（贴边用）；后端还没起来时没有
// 往下算到小胶囊的底：贴任务栏时是胶囊落在任务栏上，悬停冒出来的胶囊不会被任务栏挡住
function figureBounds() {
    try {
        const b = window.__deskPetBounds?.();
        if (!b) return null;
        return { ...b, height: Math.max(b.height, window.innerHeight - DOCK_BOTTOM - b.y) };
    } catch {
        return null;
    }
}

// 放下时：光标还压在角色上是拖动留下的，不当成「鼠标停在上面」；探头状态重新报一次
function afterDrag() {
    hitFromDrag = true;
    lastWantOut = null;
}

function bindPointer({ onTap, onDoubleTap, onTapDown, onDrag }) {
    let down = null;
    let lastTap = 0;
    let lastUp = 0;
    let pairGap = Infinity; // 双击第一下离再前一下有多久：隔了一会儿才双击，是真想打开输入框，不是在连点
    let tapTimer = 0;
    window.addEventListener('pointerdown', (e) => {
        api.touched?.();
        if (e.button !== 0 || e.target?.closest?.('.pet-ui')) return;
        // 上一次按下没收到 pointerup（被菜单、切窗口打断）时，先把它的拖动收尾（窗口和被拎着的姿势都放下）。
        if (down?.dragging) {
            afterDrag();
            api.dragEnd();
            onDrag('end');
        }
        down = { x: e.screenX, y: e.screenY, dragging: false, cx: e.clientX, cy: e.clientY };
        // 捕获指针：窗口跟着光标移动时 pointerup 也一定回到这里。
        try { e.target?.setPointerCapture?.(e.pointerId); } catch { /* 指针已经没了 */ }
    });
    window.addEventListener('pointermove', (e) => {
        lastActivity = Date.now();
        if (!down) return;
        if (down.dragging) {
            onDrag('move', e);
            return;
        }
        if (Math.hypot(e.screenX - down.x, e.screenY - down.y) > 4) {
            down.dragging = true;
            api.dragStart({ x: down.x, y: down.y });
            onDrag('start', e);
        }
    });
    window.addEventListener('pointerup', (e) => {
        if (!down) return;
        const at = { x: down.cx, y: down.cy };
        if (down.dragging) {
            // 松手的地方离屏幕边、任务栏很近时主进程会贴过去；按着 Alt 不贴
            afterDrag();
            api.dragEnd({ figure: figureBounds(), free: e.altKey });
            onDrag('end');
            down = null;
            return;
        }
        // 每一下都先报去数连点，再分单击、双击
        onTapDown(at);
        const upAt = Date.now();
        const gap = upAt - lastUp;
        lastUp = upAt;
        if (upAt - lastTap < DOUBLE_TAP_MS) {
            // 双击只打开输入框，不先做一遍单击的开心动作
            clearTimeout(tapTimer);
            lastTap = 0;
            onDoubleTap({ afterPause: pairGap >= DOUBLE_TAP_MS });
        } else {
            pairGap = gap;
            lastTap = upAt;
            clearTimeout(tapTimer);
            tapTimer = setTimeout(() => onTap(at), DOUBLE_TAP_MS);
        }
        down = null;
    });
    // 触屏手势被系统接管（pointercancel）、拖到一半切走窗口时收不到 pointerup，拖动必须在这里结束。
    const abort = () => {
        if (down?.dragging) {
            afterDrag();
            api.dragEnd();
            onDrag('end');
        }
        down = null;
    };
    window.addEventListener('pointercancel', abort);
    window.addEventListener('blur', abort);
    // Ctrl（macOS 上 Cmd）+ 滚轮调大小；气泡上的滚轮留给翻看回复
    window.addEventListener('wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.target?.closest?.('.pet-ui')) return;
        e.preventDefault();
        const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
        api.wheelResize?.(px);
    }, { passive: false });
    window.addEventListener('contextmenu', (e) => {
        if (e.target?.closest?.('#composer')) return; // 输入框里保留系统的复制粘贴菜单
        e.preventDefault();
        abort(); // 菜单会拿走指针，拖到一半右键也要先停下
        api.openContextMenu();
    });
}

// ---- 命中：光标在不在角色上（各个后端读完像素报到这里） -----------------------------

let lastHit = false;
// null：下一次一定报上去（页面刚加载、刚拖完放下时，主进程那边的探头状态可能和这里对不上）
let lastWantOut = null;
// 拖动时光标一直压在角色上；放下（可能刚收进边里）后在光标真正移开或移上来之前，不算「鼠标在角色上」，
// 免得刚藏进去就又探出来，也免得一直报着拖动时的旧值、该探头时不探
let hitFromDrag = false;
function reportHit(hit) {
    // 只看不点：鼠标穿过去，悬停胶囊也不冒；光标压在角色上时角色变得很淡，看得清后面的东西
    document.body.classList.toggle('is-ghost-hover', Boolean(prefs.clickThrough && hit));
    if (prefs.clickThrough) hit = false;
    if (hit !== lastHit) {
        lastHit = hit;
        hitFromDrag = false;
        api.setHit(hit);
        dockHover(hit);
    }
}

// ---- 回复流 → 导演与气泡 ----------------------------------------------------------

function applyFrame(next) {
    const changed = next.emotion !== frame.emotion || next.state !== frame.state;
    const emotionChanged = next.emotion !== frame.emotion;
    frame = next;
    lastActivity = Date.now();
    backend?.setActive(true);
    backend?.apply(shownFrame(frame), { changed });
    if (emotionChanged && (next.source === 'tag' || next.source === 'rule' || next.source === 'mood')) flashEmotionBadge(next.emotion, next.source);
    renderBubble();
}

// 朗读时一句话的表情：这句里（或之前）最后一个情绪标记；没有标记就用导演当前的情绪。
// 不直接用导演的帧：回复流得比念得快，导演为了不闪会压着切换，切句时它可能还停在「思考」上。
function sentenceFrame(sentence) {
    const tag = [...(bubble.tags || [])].reverse().find((t) => t.at < sentence.end);
    const base = director?.frame || frame;
    if (!tag) return { ...base, state: null };
    return { ...base, state: null, emotion: tag.emotion, intensity: tag.intensity ?? base.intensity, source: 'tag' };
}

// 睡着时（又没在思考、调工具）换成疲惫的表情或差分；醒来恢复原来的情绪
function shownFrame(f) {
    if (life?.phase !== 'asleep' || f.state) return f;
    // 立绘没画「疲惫」时不换（不然会退到「难过」之类不搭的差分），靠闭眼歪头和 z 表现睡着
    if (backend?.canShow && !backend.canShow('tired')) return f;
    return { ...f, emotion: 'tired', intensity: Math.max(0.7, f.intensity || 0) };
}

function bindStream(director) {
    let scanner = null;
    toolCard = createToolCard({ el: $('toolCard'), onChange: queueRenderBubble, isMuted: () => isQuiet() && !bubble.own });
    $('toolCard').addEventListener('click', () => api.openMainWindow());
    const startReply = (messageId) => {
        clearTimeout(bubble.hideTimer);
        bubble.own = Date.now() - composer.lastSentAt < OWN_REPLY_WINDOW_MS
            || (composer.ownReplyEndedAt > 0 && Date.now() - composer.ownReplyEndedAt < OWN_FOLLOW_UP_MS);
        bubble.replyId = messageId;
        bubble.reply = '';
        bubble.region = null;
        bubble.proactive = null;
        bubble.tags = [];
        bubble.startedAt = Date.now();
        clearMissed();
        scanner = createEmotionTagScanner();
        // 免打扰时主窗口里聊天的回复不念；在桌宠上说的话照常念
        speech.begin(messageId, { silent: isQuiet() && !bubble.own });
        toolCard.start();
    };
    api.onStream((event) => {
        if (!event?.messageId) return;
        lastActivity = Date.now();
        if (event.type === 'start') {
            life?.hold('reply', true);
            director.begin(event.messageId);
            startReply(event.messageId);
        } else if (event.type === 'data') {
            // 同一个助手同时有两条在流（另一个话题、主窗口和桌宠撞在一起）：气泡只跟当前这条，别的不来回抢
            if (bubble.replyId && bubble.replyId !== event.messageId) return;
            if (!bubble.replyId) startReply(event.messageId);
            life?.hold('reply', true);
            director.append(event.messageId, event.text);
            toolCard.push(event.text);
            // 气泡只显示正文：情绪标签、思维链、工具调用和结果都不显示，代码块写成 [代码]。
            for (const item of scanner.push(event.text)) {
                if (item.type === 'text') bubble.reply += item.text;
                else if (item.type === 'enter' && item.region === 'code') bubble.reply += '\n[代码]\n';
                else if (item.type === 'tag') bubble.tags.push({ at: bubble.reply.length, emotion: item.emotion, intensity: item.intensity, gesture: gestureOf(item.variant) });
            }
            bubble.region = scanner.region;
            speech.update(bubble.reply, sentenceFrame);
            queueRenderBubble();
            return;
        } else if (event.type === 'end' || event.type === 'error') {
            if (event.type === 'end') director.end(event.messageId);
            else director.fail(event.messageId);
            // 别的那条结束了：不动正在显示的这条
            if (bubble.replyId && bubble.replyId !== event.messageId) return;
            if (scanner && bubble.replyId === event.messageId) {
                for (const item of scanner.finish()) if (item.type === 'text') bubble.reply += item.text;
                if (event.type === 'end') speech.finish(bubble.reply, sentenceFrame);
                else speech.fail();
            }
            // 没回上来（断网、超时、服务器报错）：把原因说出来，免打扰时只说在桌宠上问的那条
            if (event.type === 'error' && (!isQuiet() || bubble.own)) {
                let reason = typeof event.error === 'string' ? event.error : '';
                if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(reason)) reason = '连不上 VCP 服务器，看看服务器开着没有、地址对不对';
                const lead = bubble.reply.trim() ? '没说完就断了' : '没回上来';
                notice(reason ? `${lead}：${reason}` : `${lead}，可以再说一次试试`, { error: true, ms: 9000 });
            }
            scanner = null;
            bubble.replyId = null;
            life?.hold('reply', false);
            bubble.region = null;
            composer.ownReplyEndedAt = bubble.own ? Date.now() : 0;
            bubble.endedAt = Date.now();
            scheduleReplyHide(replyHoldMs());
            toolCard.end();
            if (pendingProactive.length) setTimeout(flushProactive, Math.min(replyHoldMs(), 6000));
            // 排队的话等气泡画完这一帧再发，免得和刚结束的回复挤在一起
            if (composer.queued) setTimeout(flushQueued, 400);
        }
        renderBubble();
    });
}

// ---- 溜达 ----------------------------------------------------------------------
// 主进程挪窗口，页面只决定什么时候想走、走的时候一颠一颠；有了任何动静就停下（主进程那边也会停）。

let walking = null; // 'left' | 'right' | null
let nextWanderAt = 0;

function wanderGap() {
    return WANDER_GAP_MS[0] + Math.random() * (WANDER_GAP_MS[1] - WANDER_GAP_MS[0]);
}

function wanderTick(ui) {
    const now = Date.now();
    const busy = !!ui || !!frame.state || life.phase !== 'awake' || now - lastActivity < WANDER_AFTER_MS;
    if (walking) {
        if (busy) api.wander?.({ stop: true });
        return;
    }
    if (prefs.wander !== true || busy || now < nextWanderAt) return;
    nextWanderAt = now + wanderGap();
    const figure = figureBounds();
    if (figure) api.wander?.({ figure });
}

function bindWalk() {
    api.onWalk?.(({ dir }) => {
        walking = dir;
        if (dir) document.body.dataset.walk = dir;
        else delete document.body.dataset.walk;
    });
}

// ---- 设置：大小、免打扰 -------------------------------------------------------------

function isQuiet() {
    return prefs.doNotDisturb === true;
}

function applyPrefs(next) {
    if (!next || typeof next !== 'object') return;
    const previous = prefs;
    prefs = { ...prefs, ...next };
    window.deskPetPrefs = Object.freeze({ ...prefs });
    document.documentElement.style.setProperty('--pet-scale', String(prefs.scale || 1));
    document.documentElement.style.setProperty('--pet-opacity', String(prefs.opacity ?? 1));
    document.body.classList.toggle('is-dnd', isQuiet());
    $('dndBadge').hidden = !isQuiet();
    if (isQuiet() && !previous.doNotDisturb) $('emotionBadge').hidden = true;
    $('throughBadge').hidden = !prefs.clickThrough;
    if (prefs.clickThrough && !previous.clickThrough) {
        reportHit(false);
        // 第一次载入就是穿透的（上次没关）不提示，只有刚打开时说一声怎么关
        if (prefsLoaded) {
            const how = prefs.clickThroughKey ? `托盘菜单或 ${prefs.clickThroughKey} ` : '托盘菜单';
            notice(`鼠标现在会直接穿过我。想再点到我，从${how}关掉「只看不点」。`, { ms: 8000 });
        }
    }
    // 刚开了免打扰：正在念的主窗口回复停下
    if (isQuiet() && !previous.doNotDisturb && !bubble.own) speech.stop();
    toolCard?.refresh();
    renderBubble();
    window.dispatchEvent(new CustomEvent('deskpet:prefs', { detail: window.deskPetPrefs }));
    prefsLoaded = true;
}

// ---- 持续心情 ----------------------------------------------------------------
// 助手的持续心情（主进程记着，和侧栏立绘同一份）是待机时的表情：回复的情绪过去以后回到它。
// 心情一变，角色就换成新的待机表情，头顶的小牌子提示一下（「😊 开心（心情）」）；右键菜单第一行也写着现在的心情。

function bindMood(director, agentId) {
    // 先发的查询晚到时不能盖掉已经推过来的新心情；按主进程的广播序号比（系统时间可能被往回调）
    const accept = createMoodOrder(agentId);
    const apply = (mood) => {
        if (accept(mood)) director.setBaseline(mood);
    };
    api.onMood?.(apply);
    Promise.resolve(api.getMood?.()).then(apply).catch((error) => console.warn('[DeskPet] 读取心情失败：', error));
}

// ---- 启动 --------------------------------------------------------------------

// Live2D、网格立绘后端从页面拿的东西：画在哪、嘴张多大、元音口形、命中报到哪、显卡渲染中断时怎么告诉人
function pixiEnv() {
    return {
        canvas: $('live2dCanvas'),
        talkLevel,
        vowels: () => speech.vowels(),
        onHit: reportHit,
        onContextLost: () => notice('显卡渲染中断，正在重新载入桌宠…', { ms: 4000 }),
    };
}

async function start() {
    const assets = await api.getAssets();
    if (!assets) return;
    applyPrefs(await api.getPrefs?.().catch(() => null));
    api.onPrefs?.(applyPrefs);
    bindWalk();
    document.title = `${assets.name} · 桌宠`;
    // 占位只写一句：窄窗口里也不折行；按键提示放在悬停说明里
    petName = assets.name;
    $('composerInput').placeholder = `和 ${petName} 说点什么…`;
    $('composerInput').title = 'Enter 发送，Shift+Enter 换行，Esc 收起';

    if (assets.live2d && assets.coreUrl && recentContextLosses().length >= CONTEXT_LOSS_LIMIT) {
        notice('显卡渲染反复中断，这次先用立绘代替 Live2D。重新打开桌宠会再试。', { error: true, ms: 10000 });
    } else if (assets.live2d && assets.coreUrl) {
        try {
            backend = await createLive2DBackend(assets, pixiEnv());
        } catch (error) {
            console.error('[DeskPet] Live2D 加载失败，改用立绘：', error);
            $('live2dCanvas').hidden = true;
            notice(error.userFacing ? error.message : live2DFailureText(error), { error: true, ms: 8000 });
        }
    } else if (assets.live2d && !assets.coreUrl && !assets.puppet && !assets.outfit?.builtIn) {
        // 内置 Nova 自带立绘：不每次打开都弹红字，设置页卡片和「Live2D 支持」上写着
        notice('这套是 Live2D 模型，还缺 Cubism Core，先用立绘代替。右键「桌宠设置…」里的「Live2D 支持」可以一键装好。', { error: true, ms: 12000 });
    }
    if (!backend && assets.puppet && recentContextLosses().length >= CONTEXT_LOSS_LIMIT) {
        notice('显卡渲染反复中断，这次先用普通立绘。重新打开桌宠会再试。', { error: true, ms: 10000 });
    } else if (!backend && assets.puppet) {
        try {
            backend = await createPuppetBackend(assets, pixiEnv());
        } catch (error) {
            console.error('[DeskPet] 网格立绘加载失败，改用立绘：', error);
            $('live2dCanvas').hidden = true;
            notice(error.userFacing ? error.message : `网格立绘加载失败：${error.message}`, { error: true, ms: 8000 });
        }
    }
    if (!backend) backend = createImageBackend(assets, { onHit: reportHit, frame });
    document.body.dataset.backend = backend.kind;
    if (PREVIEW) {
        await renderPreview(assets);
        return;
    }

    // 朗读时表情跟着念到的句子换（见 speech），导演的新帧先不上脸
    director = createEmotionDirector({ onFrame: (next) => { if (!speech.holdsFrames()) applyFrame(next); } });
    const lifeFx = createLifeFx();
    let flashTimer = 0;
    let tapTimer = 0;
    // 互动反应时临时换个表情（不改导演的心情，演完换回来）
    const flashEmotion = (emotion, ms) => {
        // 立绘没画这个情绪就不换，免得退回默认立绘闪一下
        if (backend.canShow && !backend.canShow(emotion)) return;
        clearTimeout(flashTimer);
        clearTimeout(tapTimer);
        backend.apply({ ...frame, emotion, intensity: 0.8 }, { changed: true });
        flashTimer = setTimeout(() => backend.apply(shownFrame(frame), { changed: true, motion: false }), ms);
    };
    // 点头、点身体绑定的表情演一会儿（至少 2 秒，点身体的反应本身很短）再换回当前情绪
    const playTap = (zone, ms) => {
        const bound = backend.playTap?.(zone);
        if (bound?.expression) {
            clearTimeout(flashTimer);
            clearTimeout(tapTimer);
            tapTimer = setTimeout(() => backend.apply(shownFrame(frame), { changed: true, motion: false }), Math.max(ms, 2000));
        }
        return bound || null;
    };
    // 设置页「表情映射」：换上新映射；emotion 给了就当场演一下这个情绪，tap 给了就演一下点这个区域
    api.onProfile?.(({ profile, emotion, tap } = {}) => {
        backend.setProfile?.(profile);
        if (tap) {
            if (!playTap(tap, 3500)) {
                // 这个区域没绑：演默认反应给你看
                if (tap === 'head') flashEmotion(REACTION_EMOTION.headTap, 3500);
                else backend.tap();
            }
        } else if (emotion) flashEmotion(emotion, 3500);
        else backend.apply(shownFrame(frame), { changed: true, motion: false });
    });
    life = createPetLife({
        onPhase(phase) {
            document.body.dataset.lifePhase = phase;
            backend.life?.phase(phase);
            lifeFx.phase(phase);
            backend.apply(shownFrame(frame), { changed: true, motion: false });
            if (phase === 'asleep' && !frame.state) backend.setActive('sleep');
        },
        onAction({ name, ms }) {
            backend.life?.act(name, ms);
            if (!life.quiet || USER_REACTIONS.has(name)) lifeFx.act(name, ms);
            if (USER_REACTIONS.has(name)) {
                // 被碰到的反应要流畅：回到高帧率
                lastActivity = Date.now();
                backend.setActive(true);
            }
            // 点头、点身体：绑了的部分照绑定演，没绑的部分照原来的反应
            const bound = name === 'poke' ? playTap('body', ms) : name === 'headTap' ? playTap('head', ms) : null;
            if (name === 'poke') {
                if (!bound?.motion) backend.tap();
                if (!bound?.expression) director.nudge({ emotion: 'happy', intensity: 0.6, source: 'tap' });
            } else if (REACTION_EMOTION[name] && !frame.state && !bound?.expression) {
                flashEmotion(REACTION_EMOTION[name], ms);
            }
        },
        onGaze(g) { if (g) backend.life?.gaze(g); },
    });
    // 免打扰（桌宠设置里开）：不自己做小动作、不冒小符号
    const syncQuiet = () => {
        life.setQuiet(isQuiet());
        life.setFollowCursor(prefs.followCursor !== false);
    };
    syncQuiet();
    window.addEventListener('deskpet:prefs', syncQuiet);
    bindStream(director);
    api.onPlayTtsAudio?.((payload) => speech.play(payload));
    // 别的窗口开始朗读、在菜单里关了朗读：这条不念了，字全部显示出来
    api.onStopTtsAudio?.(() => speech.stop());
    bindMood(director, assets.agentId);
    proactiveDirector = director;
    api.onProactive?.(speakProactive);
    api.onTopicMissing?.(() => {
        if (bubble.proactive?.kind === 'topic') {
            bubble.reply = '';
            bubble.proactive = null;
        }
        notice('这个话题已经不在了（可能被删掉了）', { ms: 4000 });
    });
    bindComposer();
    bindApprovals(director);
    bindFileDrop();
    // 头那一块（摸头、点头用）：从头顶往下大约一个头高、头宽以内。
    // 量不出头时退回包围盒上方四分之一、中间六成宽。
    const onHead = (x, y) => {
        const zone = backend.zone?.(x, y);
        if (zone !== undefined) return zone === 'head';
        const h = backend.head?.();
        if (h) return y >= h.y && y <= h.y + h.width * 0.9 && Math.abs(x - h.x) <= h.width / 2;
        const b = backend.bounds();
        if (!b) return false;
        return y >= b.y && y <= b.y + b.height * 0.25 && Math.abs(x - (b.x + b.width / 2)) <= b.width * 0.3;
    };
    // Linux 上主进程不轮询光标（窗口输入区按内容裁过，指针直接进页面）：用页面自己收到的指针判断停在哪
    if (/Linux/.test(navigator.platform)) {
        window.addEventListener('pointermove', (e) => {
            if (e.buttons) return;
            if (uiAt(e.clientX, e.clientY)) reportHit(true);
            else backend.probe(e.clientX, e.clientY);
        });
        document.documentElement.addEventListener('pointerleave', () => reportHit(false));
    }
    api.onCursor(({ x, y, outside }) => {
        if (!outside) {
            if (uiAt(x, y)) reportHit(true);
            else backend.probe(x, y);
        } else reportHit(false); // 出了窗口也算离开：下次直接落在角色身上时胶囊照样冒出来
        life.cursor({ x, y, inside: !outside, onHead: !outside && onHead(x, y) });
        // 光标停着时视线归 petLife 管（游走、犯困低头），动起来再跟光标
        if (!life.gaze && prefs.followCursor !== false) backend.focus(x, y);
    });
    let streak = 0;
    let drag = null;
    bindPointer({
        onTap: (at) => {
            // 正在念的时候点一下：别念了
            if (speech.active() || speech.speaking()) {
                speech.stop();
                return;
            }
            life.tap({ onHead: onHead(at.x, at.y) });
        },
        onTapDown: () => {
            streak = life.tapDown();
            // 连点时第二下打开的输入框没写东西就收回去，别让它跟着一开一关
            if (streak >= LIFE_ANNOYED_AT && composer.open && !$('composerInput').value.trim()) closeComposer();
        },
        // 连点没断时双击不打开；停了一下再双击（比如第一次双击慢了，马上补一次）照常打开
        onDoubleTap: ({ afterPause } = {}) => { if (streak < LIFE_ANNOYED_AT || afterPause) openComposer(); },
        onDrag: (kind, e) => {
            if (kind === 'start') {
                drag = { x: e.screenX, at: performance.now(), vx: 0 };
                dock.dragging = true;
                if (dock.mode === 'pill') setDock('hidden');
                life.hold('drag', true);
                backend.life?.held(true);
                lifeFx.held(true);
            } else if (kind === 'move' && drag) {
                const at = performance.now();
                const dt = Math.max(1, at - drag.at);
                // 速度做个平滑，免得一顿一顿地甩
                drag.vx = drag.vx * 0.7 + (((e.screenX - drag.x) / dt) * 1000) * 0.3;
                drag.x = e.screenX;
                drag.at = at;
                backend.life?.dragVelocity(drag.vx);
            } else if (kind === 'end' && drag) {
                drag = null;
                dock.dragging = false;
                backend.life?.held(false);
                lifeFx.held(false);
                life.hold('drag', false);
                life.dragEnd();
            }
        },
    });
    // 甩出去落到任务栏上：再演一次落地
    api.onLanded?.(() => life.perform('landed'));
    // 窗口隐藏时停掉渲染和呼吸动画，显示回来再继续。
    let paused = false;
    api.onVisibility?.((visible) => {
        paused = !visible;
        // 藏起来就不出声了，录着的音也停掉（不然麦克风开着、整窗挡着点击）
        if (paused) {
            speech.stop();
            if ((dock.mode === 'rec' && !transcribing()) || (composer.open && !hasDraft())) closeComposer();
        }
        // 光标停在气泡上时被藏起来收不到 mouseleave：别让旧回复从此一直挂着
        if (bubble.hovered) {
            bubble.hovered = false;
            if (!paused && bubble.reply && !bubble.replyId) scheduleReplyHide(REPLY_HOLD_AFTER_HOVER_MS);
        }
        document.body.classList.toggle('is-paused', paused);
        backend.setPaused(paused);
        lifeFx.setPaused(paused);
        life.hold('hidden', paused);
        if (!paused) lastActivity = Date.now();
    });
    // 定期看一眼角色占在哪里：气泡和输入框贴在头顶上方（小头像、矮立绘不会离得老远）；
    // Linux 用输入区代替整窗穿透（见主进程注释），把角色和界面的包围盒报上去。
    let headY = null; // 第一次量到头就摆上去，之后差得多才挪
    let headX = null;
    let headWidth = null;
    // 气泡、角标、小符号都跟着头走：全身像的头在窗口上部，Q 版的大头矮矮的在中间，头歪在一边时气泡也挪过去
    const followHead = () => {
        const h = backend.head?.();
        const b = h ? null : backend.bounds();
        const head = h || (b && { x: b.x + b.width / 2, y: b.y, width: b.width * 0.5 });
        if (!head) return;
        const root = document.documentElement.style;
        // 动作会让头顶上下晃，差得不多就不挪，免得气泡跟着抖
        const y = Math.round(Math.max(TOP_RESERVE, Math.min(window.innerHeight - 40, head.y)));
        if (headY === null || Math.abs(y - headY) > 16) {
            headY = y;
            root.setProperty('--pet-head', `${y}px`);
        }
        const x = Math.round(Math.max(0, Math.min(window.innerWidth, head.x)));
        const w = Math.round(Math.max(24, Math.min(window.innerWidth, head.width)));
        if (headX === null || Math.abs(x - headX) > 8 || Math.abs(w - headWidth) > 8) {
            headX = x;
            headWidth = w;
            root.setProperty('--pet-head-x', `${x}px`);
            root.setProperty('--pet-head-w', `${w}px`);
        }
        aimBubble(headX);
    };
    setInterval(() => {
        if (paused) return;
        followHead();
        const b = backend.bounds();
        const ui = uiBounds();
        const drawn = uiBounds({ withIdleDock: true });
        const rect = b && drawn ? union(b, drawn) : (b || drawn);
        if (rect) api.setContentBounds({ x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height });
        // 藏在屏幕边里时，主进程按这个决定探不探出来：鼠标在角色上，或者头顶有气泡、输入框
        const wantOut = (lastHit && !hitFromDrag) || Boolean(ui);
        if (wantOut !== lastWantOut) {
            lastWantOut = wantOut;
            api.wantOut?.(wantOut);
        }
        life.setMood(director.baseline);
        life.tick();
        wanderTick(uiBounds({ withBadge: false }));
        if (Date.now() - lastActivity > IDLE_AFTER_MS && !frame.state) backend.setActive(life.phase === 'asleep' ? 'sleep' : 'idle');
    }, 250);

    applyFrame(director.frame);
    document.body.dataset.lifePhase = life.phase;
    backend.life?.phase(life.phase);
    window.__deskPetReady = { backend: backend.kind, info: backend.info || null };
    // 调试和录屏：__deskPetLife.force('asleep') 直接睡着，__deskPetLife.perform('yawn') 演一个动作
    window.__deskPetLife = life;
    window.__deskPetBounds = () => backend.bounds();
    window.__deskPetHead = () => backend.head?.() || null;
    // 量出形象的长宽比后告诉主进程，窗口按比例改（全身像高、Q 版矮），脚底不动
    Promise.resolve(backend.figureReady).then((aspect) => {
        window.__deskPetFigure = { outfit: assets.outfit?.id || null, aspect };
        if (aspect && assets.outfit) api.reportFigure?.({ outfit: assets.outfit.id, aspect });
        followHead();
    }).catch(() => {});
    console.log('[DeskPet] ready', JSON.stringify(window.__deskPetReady));
    api.pageReady?.();
}

// 设置页卡片的快照：摆好默认表情，等形象量完、物理和待机动作稳下来，把角色的包围盒报给主进程截图
async function renderPreview(assets) {
    document.body.classList.add('is-preview');
    backend.apply({ state: null, emotion: 'neutral', intensity: 0, source: 'idle' }, { changed: true, motion: false });
    const aspect = await Promise.race([
        Promise.resolve(backend.figureReady).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 6000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const bounds = backend.bounds();
    window.__deskPetPreview = { outfit: assets.outfit?.id || null, bounds, aspect };
    api.previewReady?.({ bounds, aspect });
}

start().catch((error) => {
    console.error('[DeskPet] 启动失败', error);
    // 告诉主进程别再等这个页面了：等着交给桌宠的话按失败退回去
    api.pageFailed?.(String(error?.message || error));
    notice(`桌宠启动失败：${error.message}`, { error: true, ms: 60000 });
});
