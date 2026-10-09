/* Emotion director: turns one assistant's streamed replies into a calm sequence of emotion frames.
 *   - lifecycle states (thinking, tool, error) win over the reply's emotion while they last;
 *   - inline <!--emo:...--> tags are the main signal; replies without tags fall back to local rules;
 *   - a shown frame stays at least minDwellMs, newer requests in that window collapse into the
 *     latest one, and an unchanged emotion never re-emits, so a streaming reply cannot flicker;
 *   - after a reply ends its last emotion holds for settleHoldMs, then eases back to the baseline:
 *     the assistant's long-lived mood (moodState.js) when the caller sets one, neutral otherwise.
 * Frames are plain data ({ seq, messageId, state, emotion, intensity, source }) so the side pane
 * portrait, a desk pet window or a Live2D backend can all consume them. No DOM or Electron use. */
import { createEmotionTagScanner } from './emotionTags.js';
import { classifyReplyText } from './emotionRules.js';
import { normalizeEmotion, isState, clampIntensity } from './emotionVocabulary.js';

const NEUTRAL = Object.freeze({ state: null, emotion: 'neutral', intensity: 0, source: 'idle' });

export function createEmotionDirector({
    onFrame = () => {},
    now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = handle => clearTimeout(handle),
    minDwellMs = 1500,
    ruleProbeChars = 60,
    settleHoldMs = 120_000,
    errorHoldMs = 4000,
} = {}) {
    let seq = 0;
    let shown = { ...NEUTRAL, seq: 0, messageId: null };
    let shownAt = -Infinity;
    let pending = null;
    let dwellTimer = null;
    let settleTimer = null;
    let errorTimer = null;
    let disposed = false;
    // 当前这条回复的读取状态；同一时间只跟一条，新回复开始时旧的作废
    let reply = null;
    // 已经结束或被新回复顶替的回复：之后再来的片段不能把它重新当成一条新回复。
    // 同一个助手同时有两路回复（主聊天和侧聊一起在流）时只跟最新开始的那条，不然两路片段交替到达，
    // 每来一块就重开一次，立绘在「思考中」和情绪之间来回闪
    const finishedIds = new Set();
    const retire = (messageId) => {
        finishedIds.add(messageId);
        if (finishedIds.size > 64) finishedIds.delete(finishedIds.values().next().value);
    };
    // 不带状态时显示的情绪：上一条回复留下的情绪在下一条回复给出新情绪前保持不变
    let mood = { emotion: 'neutral', intensity: 0, source: 'idle' };
    // 回复的情绪过去以后回到的底色：助手的长期心情（setBaseline），没给就是 neutral
    let baseline = { emotion: 'neutral', intensity: 0, source: 'idle' };
    // 当前显示的是不是底色本身（没有回复留下的情绪在等回落）
    let onBaseline = true;

    const sameLook = (a, b) => a.state === b.state && a.emotion === b.emotion;

    function cancel(handle) {
        if (handle) clearTimer(handle);
        return null;
    }

    function emit(target) {
        dwellTimer = cancel(dwellTimer);
        pending = null;
        shown = Object.freeze({ ...target, seq: ++seq });
        shownAt = now();
        try {
            onFrame(shown);
        } catch (error) {
            console.warn('[EmotionDirector] Frame consumer failed:', error);
        }
    }

    // 所有画面变化都从这里过：相同画面只更新强度，最短停留期内只留最新的一个请求
    function request(target, { immediate = false } = {}) {
        if (disposed) return;
        const next = { messageId: reply?.messageId ?? shown.messageId ?? null, ...target };
        if (!immediate && sameLook(next, pending || shown)) {
            if (pending) pending = { ...pending, intensity: next.intensity };
            return;
        }
        if (!immediate && sameLook(next, shown)) {
            // 等待中的请求被撤回到当前画面：不用再切
            pending = null;
            dwellTimer = cancel(dwellTimer);
            return;
        }
        const wait = immediate ? 0 : shownAt + minDwellMs - now();
        if (wait <= 0) {
            emit(next);
            return;
        }
        pending = next;
        if (!dwellTimer) {
            dwellTimer = setTimer(() => {
                dwellTimer = null;
                if (pending && !disposed) emit(pending);
            }, wait);
        }
    }

    function currentState() {
        if (!reply) return null;
        if (reply.error) return 'error';
        if (reply.region === 'tool') return 'tool';
        if (reply.region === 'thought' || !reply.sawText) return 'thinking';
        return null;
    }

    function refresh(source) {
        request({ state: currentState(), emotion: mood.emotion, intensity: mood.intensity, source: source || mood.source });
    }

    function setMood(emotion, intensity, source) {
        const key = normalizeEmotion(emotion);
        if (!key) return;
        mood = { emotion: key, intensity: clampIntensity(intensity, 0.7), source };
        onBaseline = false;
    }

    function backToBaseline(source) {
        mood = { ...baseline };
        onBaseline = true;
        refresh(source);
    }

    function scheduleSettle() {
        settleTimer = cancel(settleTimer);
        if (onBaseline || !(settleHoldMs > 0)) return;
        if (mood.emotion === baseline.emotion) {
            // 回复的情绪就是底色：不用等，直接算回到了底色
            mood = { ...baseline };
            onBaseline = true;
            return;
        }
        settleTimer = setTimer(() => {
            settleTimer = null;
            if (reply || disposed) return;
            backToBaseline(baseline.emotion === 'neutral' ? 'settle' : baseline.source);
        }, settleHoldMs);
    }

    function probeRules({ final = false } = {}) {
        if (!reply || reply.tagged) return;
        if (!final && (reply.probed || reply.visible.length < ruleProbeChars)) return;
        reply.probed = true;
        const result = classifyReplyText(reply.visible);
        if (result) setMood(result.emotion, result.intensity, 'rule');
    }

    function handleEvents(events) {
        for (const event of events) {
            if (event.type === 'tag') {
                reply.tagged = true;
                setMood(event.emotion, event.intensity, 'tag');
            } else if (event.type === 'text') {
                if (event.text.trim()) reply.sawText = true;
                if (!reply.tagged) reply.visible = (reply.visible + event.text).slice(-2000);
                // 第一句说完、或者攒够一小段还没有标签，就先用规则给个情绪
                if (!reply.tagged && !reply.probed && /[。！？!?\n]/.test(event.text) && reply.visible.trim().length >= 8) probeRules({ final: true });
            } else if (event.type === 'enter') {
                reply.region = event.region;
            } else if (event.type === 'exit') {
                reply.region = null;
            }
        }
        probeRules();
    }

    function begin(messageId) {
        if (disposed || !messageId) return;
        // 同一条回复不重新开始；已经结束的回复也不会被迟到的事件重新打开
        if (reply?.messageId === messageId || finishedIds.has(messageId)) return;
        if (reply) retire(reply.messageId);
        settleTimer = cancel(settleTimer);
        errorTimer = cancel(errorTimer);
        reply = {
            messageId,
            scanner: createEmotionTagScanner(),
            region: null,
            sawText: false,
            tagged: false,
            probed: false,
            visible: '',
            error: false,
        };
        refresh('state');
    }

    function append(messageId, delta) {
        if (disposed || !messageId || typeof delta !== 'string' || !delta) return;
        if (!reply || reply.messageId !== messageId) {
            // 收到的是旧回复的迟到片段就不理；新消息没先 begin 就当它开始了
            if (finishedIds.has(messageId)) return;
            begin(messageId);
            if (!reply) return;
        }
        handleEvents(reply.scanner.push(delta));
        refresh();
    }

    function finish(messageId, { failed = false } = {}) {
        if (disposed || !reply || reply.messageId !== messageId) return;
        handleEvents(reply.scanner.finish());
        probeRules({ final: true });
        retire(messageId);
        if (failed) {
            reply.error = true;
            refresh('state');
            reply = null;
            errorTimer = cancel(errorTimer);
            errorTimer = setTimer(() => {
                errorTimer = null;
                if (reply || disposed) return;
                refresh();
                scheduleSettle();
            }, errorHoldMs);
            return;
        }
        reply = null;
        refresh();
        scheduleSettle();
    }

    return Object.freeze({
        begin,
        append,
        end(messageId) { finish(messageId); },
        fail(messageId) { finish(messageId, { failed: true }); },
        /** 外部直接指定情绪或状态（例如以后桌宠被点击时的反应） */
        nudge({ emotion, state = null, intensity = 0.7, source = 'external' } = {}) {
            if (state && !isState(state)) return;
            if (emotion) setMood(emotion, intensity, source);
            if (state) request({ state, emotion: mood.emotion, intensity: mood.intensity, source });
            else refresh(source);
            // 回复之外的反应（点一下桌宠）过一会儿也回到底色
            if (emotion && !reply) scheduleSettle();
        },
        /**
         * 长期心情变了：{ emotion, intensity }，null 表示没有心情（neutral）。
         * 正显示着底色时马上换过去；回复的情绪还在停留时不打断，回落时回到新的底色
         */
        setBaseline(next, { source = 'mood' } = {}) {
            if (disposed) return;
            const key = normalizeEmotion(next?.emotion) || 'neutral';
            baseline = key === 'neutral'
                ? { emotion: 'neutral', intensity: 0, source: 'idle' }
                : { emotion: key, intensity: clampIntensity(next.intensity, 0.5), source };
            if (onBaseline) {
                mood = { ...baseline };
                if (!reply) refresh(baseline.source);
            }
        },
        get baseline() { return { emotion: baseline.emotion, intensity: baseline.intensity }; },
        /** 换了角色：丢掉一切（包括底色），立刻回到默认 */
        reset() {
            if (disposed) return;
            reply = null;
            settleTimer = cancel(settleTimer);
            errorTimer = cancel(errorTimer);
            mood = { emotion: 'neutral', intensity: 0, source: 'idle' };
            baseline = { ...mood };
            onBaseline = true;
            request({ ...NEUTRAL, messageId: null }, { immediate: true });
        },
        get frame() { return shown; },
        get activeMessageId() { return reply?.messageId ?? null; },
        dispose() {
            disposed = true;
            reply = null;
            dwellTimer = cancel(dwellTimer);
            settleTimer = cancel(settleTimer);
            errorTimer = cancel(errorTimer);
        },
    });
}
