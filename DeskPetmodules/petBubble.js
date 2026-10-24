// 桌宠头顶的气泡：状态和回复文字、临时提示、头顶的情绪小牌子，
// 还有没看到的回复（收起时留一个 💬）和角色主动说的话（新话题、闹钟）。
// 气泡只显示正文，完整回复在主窗口；文字整理交给 bubbleText.js。
import { toBubbleText } from 'vcp-deskpet://pet/app/bubbleText.js';
import { isMissed } from 'vcp-deskpet://pet/app/missedReply.js';
import { dueGestures } from 'vcp-deskpet://pet/app/gestures.js';
import { EMOTION_LABEL, EMOTION_EMOJI } from 'vcp-deskpet://pet/app/emotionLook.js';

// 回复结束后气泡停留多久：按字数给时间读完，鼠标停在气泡上时不收
const REPLY_HOLD_MIN_MS = 8000;
const REPLY_HOLD_MAX_MS = 30000;
const REPLY_HOLD_PER_CHAR_MS = 60;
export const REPLY_HOLD_AFTER_HOVER_MS = 4000;
const BUBBLE_MAX_CHARS = 600;  // 气泡只留最后这么多字，完整内容在主窗口

const STATE_LABEL = { thinking: '思考中…', tool: '调用工具中…', error: '出错了' };
// 角色主动说话（AI 开了新话题、闹钟到点）各自的停留时间
export const PROACTIVE_HOLD_MS = { topic: 20000, alarm: 60000 };

export function createPetBubble(ctx) {
    const { api, $ } = ctx;

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

    // 状态写在回复下方的小字里：思考只在真的读到思维链时提示（刚开口那一下导演还停在「思考」上）
    function replyStateLabel() {
        if (!ctx.frame.state) return '';
        if (ctx.frame.state === 'thinking') return bubble.replyId && bubble.region === 'thought' ? STATE_LABEL.thinking : '';
        if (ctx.frame.state === 'tool') return ''; // 工具状态统一交给会话动态。
        return STATE_LABEL[ctx.frame.state] || '';
    }

    function renderBubble() {
        bubble.renderQueued = false;
        const el = $('bubble');
        const text = $('bubbleText');
        const speech = ctx.speech;
        let content = '';
        let mode = '';
        // 免打扰：主窗口里聊天的回复不在桌宠头上冒出来，只有在桌宠上说的话才回气泡
        const muted = ctx.isQuiet() && !bubble.own;
        // 朗读时只显示到正在念的这一句；还没开口时显示省略号
        const revealEnd = speech.revealEnd();
        const source = revealEnd == null ? bubble.reply : bubble.reply.slice(0, revealEnd);
        const waiting = revealEnd != null && !source.trim() && speech.active();
        const reply = muted ? '' : source.trim() ? toBubbleText(source) : (waiting ? '…' : '');
        // 回复里写了动作：显示（念）到那句时演出来；免打扰下不冒气泡的回复也不动
        if (!muted && ctx.life) for (const gesture of dueGestures(bubble.tags, revealEnd)) ctx.life.perform(gesture);
        if (bubble.notice) {
            content = bubble.notice.text;
            mode = bubble.notice.error ? 'is-error' : 'is-notice';
        } else if (reply) {
            content = reply;
            mode = 'is-reply';
        } else if (!muted && ctx.frame.state && STATE_LABEL[ctx.frame.state]) {
            content = STATE_LABEL[ctx.frame.state];
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
        const queued = ctx.composer.queued ? `说完就发：「${shorten(ctx.composer.queued)}」` : '';
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
            if (bubble.replyId || bubble.hovered || ctx.speech.active()) return;
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
        const muted = ctx.isQuiet() && !bubble.own;
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
    let pendingProactive = [];

    function speakProactive(payload) {
        if (!payload?.text && !payload?.title) return;
        if (bubble.replyId || ctx.speech.active()) {
            pendingProactive = [...pendingProactive, payload].slice(-3);
            // 上一条已经回复完、只是还在念：念完再说
            if (!bubble.replyId) setTimeout(flushProactive, 1500);
            return;
        }
        const kind = payload.kind === 'alarm' ? 'alarm' : 'topic';
        // 免打扰：自己开新话题这种不说；闹钟是用户自己定的，照常叫
        if (kind !== 'alarm' && ctx.isQuiet()) return;
        bubble.proactive = { kind, title: payload.title || '', topicId: payload.topicId || '' };
        bubble.own = kind === 'alarm';
        bubble.reply = payload.text || payload.title;
        bubble.startedAt = bubble.endedAt = Date.now();
        clearMissed();
        ctx.lastActivity = Date.now();
        ctx.life?.wake({ startle: true });
        // 闲时搭话带着自己写的情绪；别的按种类给个默认
        const emotion = typeof payload.emotion === 'string' && payload.emotion ? payload.emotion : (kind === 'alarm' ? 'excited' : 'happy');
        ctx.proactiveDirector?.nudge({ emotion, intensity: Number.isFinite(payload.intensity) ? payload.intensity : 0.7, source: 'proactive' });
        ctx.backend?.tap?.();
        // 主动说的话也念出来（助手设了音色、没在菜单里关掉朗读时）
        ctx.speech.begin(`deskpet-proactive-${Date.now()}`, { silent: ctx.isQuiet() && !bubble.own });
        ctx.speech.finish(bubble.reply, ctx.proactiveDirector?.frame);
        renderBubble();
        scheduleReplyHide(PROACTIVE_HOLD_MS[kind]);
    }

    function flushProactive() {
        const next = pendingProactive.shift();
        if (next) speakProactive(next);
    }

    function hasPendingProactive() {
        return pendingProactive.length > 0;
    }

    function notice(text, { error = false, ms = 6000 } = {}) {
        bubble.notice = text ? { text, error } : null;
        clearTimeout(bubble.noticeTimer);
        if (text) bubble.noticeTimer = setTimeout(() => { bubble.notice = null; renderBubble(); }, ms);
        renderBubble();
    }

    let badgeTimer = 0;
    function flashEmotionBadge(emotion, source) {
        if (ctx.isQuiet()) return;
        const el = $('emotionBadge');
        const suffix = source === 'rule' ? '（推测）' : source === 'mood' ? '（心情）' : '';
        el.textContent = `${EMOTION_EMOJI[emotion] || ''} ${EMOTION_LABEL[emotion] || emotion}${suffix}`;
        el.hidden = false;
        el.classList.remove('is-fading');
        clearTimeout(badgeTimer);
        badgeTimer = setTimeout(() => el.classList.add('is-fading'), 2500);
    }

    function shorten(text, max = 16) {
        const flat = text.replace(/\s+/g, ' ');
        return flat.length > max ? `${flat.slice(0, max)}…` : flat;
    }

    // 气泡挪到头的正上方（窗口比气泡宽时），小尾巴指着头
    let aimedHeadX = null;
    function aimBubble(headX) {
        aimedHeadX = headX;
        if (headX === null) return;
        const stack = $('uiStack');
        const room = stack.clientWidth;
        const left = stack.getBoundingClientRect().left;
        for (const el of [$('sessionPanel'), $('bubble'), $('approvalCard')]) {
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

    // 哪张卡片开合以后重新对一次（头的位置没变）
    function reaimBubble() {
        aimBubble(aimedHeadX);
    }

    // 点气泡打开主窗口看完整回复；鼠标停在气泡上时先不收起，方便读完或往上翻。
    function bindBubble() {
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
            ctx.speech.stop();
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
    }

    function disposeBubble() {
        clearTimeout(bubble.hideTimer);
        clearTimeout(bubble.noticeTimer);
    }

    return {
        bubble, renderBubble, queueRenderBubble, replyHoldMs, scheduleReplyHide,
        keepIfMissed, clearMissed, replayMissed, speakProactive, flushProactive, hasPendingProactive,
        notice, flashEmotionBadge, aimBubble, reaimBubble, bindBubble, disposeBubble,
    };
}
