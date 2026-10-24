// 回复流接到情绪导演和气泡：主进程把这个 agent 的回复流原样转过来，
// 情绪标记、思维链和工具调用在这里挑出去（气泡只显示正文），导演给出的帧上脸。
// 还有助手的持续心情：待机时的表情，和侧栏立绘同一份。
import { createEmotionTagScanner } from 'vcp-deskpet://pet/emotion/emotionTags.js';
import { createMoodOrder } from 'vcp-deskpet://pet/app/moodOrder.js';
import { gestureOf } from 'vcp-deskpet://pet/app/gestures.js';
import { createStableSpeechStream } from 'vcp-deskpet://pet/renderer/streamSpeech.js';

// 免打扰时只有「在回桌宠上说的话」的回复还显示气泡：发出后这么久内开始的回复，
// 以及紧接着这种回复（工具调用后的续写）开始的回复
const OWN_REPLY_WINDOW_MS = 30000;
const OWN_FOLLOW_UP_MS = 5000;

export function createPetStream(ctx) {
    const { api } = ctx;

    function applyFrame(next) {
        const changed = next.emotion !== ctx.frame.emotion || next.state !== ctx.frame.state;
        const emotionChanged = next.emotion !== ctx.frame.emotion;
        ctx.frame = next;
        ctx.lastActivity = Date.now();
        ctx.backend?.setActive(true);
        ctx.backend?.apply(shownFrame(ctx.frame), { changed });
        if (emotionChanged && (next.source === 'tag' || next.source === 'rule' || next.source === 'mood')) ctx.flashEmotionBadge(next.emotion, next.source);
        ctx.renderBubble();
    }

    // 朗读时一句话的表情：这句里（或之前）最后一个情绪标记；没有标记就用导演当前的情绪。
    // 不直接用导演的帧：回复流得比念得快，导演为了不闪会压着切换，切句时它可能还停在「思考」上。
    function sentenceFrame(sentence) {
        const tag = [...(ctx.bubble.tags || [])].reverse().find((t) => t.at < sentence.end);
        const base = ctx.director?.frame || ctx.frame;
        if (!tag) return { ...base, state: null };
        return { ...base, state: null, emotion: tag.emotion, intensity: tag.intensity ?? base.intensity, source: 'tag' };
    }

    // 睡着时（又没在思考、调工具）换成疲惫的表情或差分；醒来恢复原来的情绪
    function shownFrame(f) {
        if (ctx.life?.phase !== 'asleep' || f.state) return f;
        // 立绘没画「疲惫」时不换（不然会退到「难过」之类不搭的差分），靠闭眼歪头和 z 表现睡着
        if (ctx.backend?.canShow && !ctx.backend.canShow('tired')) return f;
        return { ...f, emotion: 'tired', intensity: Math.max(0.7, f.intensity || 0) };
    }

    function bindStream() {
        const director = ctx.director;
        const bubble = ctx.bubble;
        const composer = ctx.composer;
        let scanner = null;
        let stableSpeech = null;
        const consumeStable = (blocks) => {
            for (const block of blocks) {
                for (const item of scanner.push(block.source)) {
                    if (item.type === 'text') bubble.reply += item.text;
                    else if (item.type === 'tag') bubble.tags.push({ at: bubble.reply.length, emotion: item.emotion, intensity: item.intensity, variant: item.variant, gesture: gestureOf(item.variant) });
                }
            }
        };
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
            ctx.clearMissed();
            scanner = createEmotionTagScanner();
            stableSpeech?.cancel();
            stableSpeech = createStableSpeechStream({ document });
            // 免打扰时主窗口里聊天的回复不念；在桌宠上说的话照常念
            ctx.speech.begin(messageId, { silent: ctx.isQuiet() && !bubble.own });
        };
        api.onStream((event) => {
            if (!event?.messageId) return;
            ctx.lastActivity = Date.now();
            if (event.type === 'start') {
                ctx.life?.hold('reply', true);
                director.begin(event.messageId);
                startReply(event.messageId);
            } else if (event.type === 'data') {
                // 同一个助手同时有两条在流（另一个话题、主窗口和桌宠撞在一起）：气泡只跟当前这条，别的不来回抢
                if (bubble.replyId && bubble.replyId !== event.messageId) return;
                if (!bubble.replyId) startReply(event.messageId);
                ctx.life?.hold('reply', true);
                director.append(event.messageId, event.text);
                // 完整稳定块先净化，再进入气泡和语音；两者共用同一坐标系。
                consumeStable(stableSpeech.push(event.text));
                bubble.region = scanner.region;
                ctx.speech.update(bubble.reply, sentenceFrame);
                ctx.queueRenderBubble();
                return;
            } else if (event.type === 'end' || event.type === 'error') {
                if (event.type === 'end') director.end(event.messageId);
                else director.fail(event.messageId);
                // 别的那条结束了：不动正在显示的这条
                if (bubble.replyId && bubble.replyId !== event.messageId) return;
                if (scanner && bubble.replyId === event.messageId) {
                    if (event.type === 'end' && !event.aborted) consumeStable(stableSpeech.finish());
                    else stableSpeech.cancel();
                    for (const item of scanner.finish()) if (item.type === 'text') bubble.reply += item.text;
                    if (event.type === 'end' && !event.aborted) ctx.speech.finish(bubble.reply, sentenceFrame);
                    else ctx.speech.fail();
                }
                // 没回上来（断网、超时、服务器报错）：把原因说出来，免打扰时只说在桌宠上问的那条
                if (event.type === 'error' && (!ctx.isQuiet() || bubble.own)) {
                    let reason = typeof event.error === 'string' ? event.error : '';
                    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(reason)) reason = '连不上 VCP 服务器，看看服务器开着没有、地址对不对';
                    const lead = bubble.reply.trim() ? '没说完就断了' : '没回上来';
                    ctx.notice(reason ? `${lead}：${reason}` : `${lead}，可以再说一次试试`, { error: true, ms: 9000 });
                }
                scanner = null;
                bubble.replyId = null;
                ctx.life?.hold('reply', false);
                bubble.region = null;
                composer.ownReplyEndedAt = bubble.own ? Date.now() : 0;
                bubble.endedAt = Date.now();
                ctx.scheduleReplyHide(ctx.replyHoldMs());
                if (ctx.hasPendingProactive()) setTimeout(ctx.flushProactive, Math.min(ctx.replyHoldMs(), 6000));
                // 排队的话等气泡画完这一帧再发，免得和刚结束的回复挤在一起
                if (composer.queued) setTimeout(ctx.flushQueued, 400);
            }
            ctx.renderBubble();
        });
    }

    // ---- 持续心情 ----------------------------------------------------------------
    // 助手的持续心情（主进程记着，和侧栏立绘同一份）是待机时的表情：回复的情绪过去以后回到它。
    // 心情一变，角色就换成新的待机表情，头顶的小牌子提示一下（「😊 开心（心情）」）；右键菜单第一行也写着现在的心情。

    function bindMood(agentId) {
        // 先发的查询晚到时不能盖掉已经推过来的新心情；按主进程的广播序号比（系统时间可能被往回调）
        const accept = createMoodOrder(agentId);
        const apply = (mood) => {
            if (accept(mood)) ctx.director.setBaseline(mood);
        };
        api.onMood?.(apply);
        Promise.resolve(api.getMood?.()).then(apply).catch((error) => console.warn('[DeskPet] 读取心情失败：', error));
    }

    return { applyFrame, sentenceFrame, shownFrame, bindStream, bindMood };
}
