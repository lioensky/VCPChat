/* Long-lived mood of one assistant: a point in VAD space that replies and the user's messages
 * push around a little, and that eases back to neutral over hours (faster across a new day).
 * The emotion director shows a reply's emotion on top of it and settles back to it afterwards.
 * Pure data and functions with no DOM, Electron or file access: the main process owns the
 * stored copy (Agents/<id>/mood.json), the side pane portrait and the desk pet only read it.
 * The user-message part (empathy map and comfort/still-upset phrases) follows TsukuMate's
 * chat-emotion layer (Roxy's own project); the VAD easing follows soullink-emotion-sdk. */
import { classifyReplyText } from './emotionRules.js';
import { EMOTIONS, EMOTION_VAD, normalizeEmotion, clampIntensity } from './emotionVocabulary.js';
import { createEmotionTagScanner } from './emotionTags.js';

export const MOOD_VERSION = 1;

export const MOOD_DEFAULTS = Object.freeze({
    // 偏离平静的部分每过这么久减半
    halfLifeMs: 4 * 60 * 60 * 1000,
    // 睡过一夜（跨过本地早上 5 点、且中间至少隔了两小时）再额外只留下这一部分：第二天醒来基本回到平静
    newDayKeep: 0.35,
    // 低于这个强度就当作平静，立绘不跟着换
    showThreshold: 0.22,
});

// 能成为心情的情绪：惊讶、好奇是一瞬间的反应，不会持续半天
const MOOD_EMOTIONS = new Set(['calm', 'happy', 'excited', 'shy', 'affectionate', 'concerned', 'sad', 'tired', 'angry']);

// 每次事件把心情往目标拉多少（再乘事件自身的强度）
const PULL = Object.freeze({ tag: 0.35, rule: 0.2, user: 0.3 });
const ORIGIN = Object.freeze({ valence: 0, arousal: 0, dominance: 0 });
const AXES = ['valence', 'arousal', 'dominance'];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const norm = vad => Math.hypot(vad.valence, vad.arousal, vad.dominance);
const mix = (from, to, amount) => Object.fromEntries(AXES.map(axis => [axis, from[axis] + (to[axis] - from[axis]) * amount]));
const scale = (vad, factor) => Object.fromEntries(AXES.map(axis => [axis, vad[axis] * factor]));

// 一天从本地早上 5 点算起：半夜接着聊不算第二天
const DAY_STARTS_AT_HOUR = 5;
// 中间至少隔这么久才算睡过一觉；一直聊着跨过 5 点不额外回落
const NIGHT_GAP_MS = 2 * 60 * 60 * 1000;

function localDay(time) {
    const date = new Date(time);
    date.setHours(date.getHours() - DAY_STARTS_AT_HOUR);
    return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/** 一份全新的平静心情 */
export function createMood(at = Date.now()) {
    return { version: MOOD_VERSION, vad: { ...ORIGIN }, updatedAt: at, last: null };
}

/** 从磁盘读来的任意内容整理成合法心情；读不懂就当平静 */
export function normalizeMood(value, at = Date.now()) {
    if (!value || typeof value !== 'object' || !value.vad || typeof value.vad !== 'object') return createMood(at);
    const vad = Object.fromEntries(AXES.map(axis => [axis, clamp(finite(value.vad[axis]), -1, 1)]));
    const updatedAt = Number.isFinite(value.updatedAt) && value.updatedAt <= at ? value.updatedAt : at;
    const last = value.last && normalizeEmotion(value.last.emotion)
        ? { emotion: normalizeEmotion(value.last.emotion), source: String(value.last.source || ''), at: finite(value.last.at, updatedAt) }
        : null;
    return { version: MOOD_VERSION, vad, updatedAt, last };
}

/** 把心情推进到 at：按半衰期回落，睡过一夜再额外回落一截 */
export function decayMood(mood, at = Date.now(), { halfLifeMs = MOOD_DEFAULTS.halfLifeMs, newDayKeep = MOOD_DEFAULTS.newDayKeep } = {}) {
    const elapsed = at - mood.updatedAt;
    if (elapsed === 0 || !Number.isFinite(elapsed)) return mood;
    // 系统时间被往回调了：心情不动，但从现在重新计时，否则要等时钟追回原来的时间才会再回落
    if (elapsed < 0) return { ...mood, updatedAt: at };
    let keep = halfLifeMs > 0 ? Math.pow(0.5, elapsed / halfLifeMs) : 0;
    if (elapsed >= NIGHT_GAP_MS && localDay(at) !== localDay(mood.updatedAt)) keep *= newDayKeep;
    const vad = norm(mood.vad) * keep < 0.01 ? { ...ORIGIN } : scale(mood.vad, keep);
    return { ...mood, vad, updatedAt: at };
}

/**
 * 记一次情绪事件。event: { emotion, intensity, source: 'tag' | 'rule' | 'user', at, settle? }
 * settle 是用户说「好多了」这类话：按比例拉回平静，不再朝某个情绪推。
 */
export function applyMoodEvent(mood, event = {}, options = {}) {
    const at = Number.isFinite(event.at) ? event.at : Date.now();
    const current = decayMood(mood, at, options);
    if (event.settle > 0) {
        return { ...current, vad: scale(current.vad, 1 - clamp(event.settle, 0, 1)), last: { emotion: 'calm', source: event.source || 'user', at } };
    }
    const emotion = normalizeEmotion(event.emotion);
    // 惊讶、好奇是一瞬间的反应：立绘照样换表情，但不改心情
    if (!emotion || !MOOD_EMOTIONS.has(emotion)) return current;
    const pull = (PULL[event.source] ?? PULL.rule) * clampIntensity(event.intensity, 0.7);
    if (!(pull > 0)) return current;
    return { ...current, vad: mix(current.vad, EMOTION_VAD[emotion], pull), last: { emotion, source: event.source || 'rule', at } };
}

/**
 * 心情在立绘上显示成哪个情绪：方向最接近的情绪键，强度按离平静多远算；太弱就是 neutral。
 * 返回 { emotion, intensity }，可以直接交给情绪导演的 setBaseline。
 */
export function moodEmotion(mood, { showThreshold = MOOD_DEFAULTS.showThreshold } = {}) {
    const length = norm(mood?.vad || ORIGIN);
    if (length < 0.05) return { emotion: 'neutral', intensity: 0 };
    let best = null;
    for (const emotion of EMOTIONS) {
        if (!MOOD_EMOTIONS.has(emotion)) continue;
        const anchor = EMOTION_VAD[emotion];
        const cosine = AXES.reduce((sum, axis) => sum + mood.vad[axis] * anchor[axis], 0) / (length * norm(anchor));
        if (!best || cosine > best.cosine) best = { emotion, cosine, anchor };
    }
    // 强度只算朝这个情绪方向的那一段：开心过后又听到坏消息，剩下的多是「还有点激动」，算不上兴奋
    const intensity = clamp((length * best.cosine) / norm(best.anchor), 0, 1);
    if (intensity < showThreshold || best.cosine < 0.7) return { emotion: 'neutral', intensity: 0 };
    return { emotion: best.emotion, intensity: Math.round(intensity * 100) / 100 };
}

/** 给渲染端的快照：时间推进到 at 后的显示情绪，加上原始 VAD 和最近一次是什么推动的 */
export function moodSnapshot(mood, at = Date.now(), options = {}) {
    const current = decayMood(mood, at, options);
    const shown = moodEmotion(current, options);
    return {
        emotion: shown.emotion,
        intensity: shown.intensity,
        vad: { ...current.vad },
        updatedAt: current.updatedAt,
        last: current.last ? { ...current.last } : null,
    };
}

// 用户的情绪传到助手身上是什么样子：用户难过、生气、累，助手是担心；开心、兴奋就跟着开心
const EMPATHY = Object.freeze({
    happy: 'happy',
    excited: 'excited',
    affectionate: 'shy',
    shy: 'affectionate',
    curious: 'curious',
    surprised: 'curious',
    calm: 'calm',
    concerned: 'concerned',
    sad: 'concerned',
    angry: 'concerned',
    tired: 'concerned',
});

// 「还没好」「还是难过」：保持现状，不再往哪边推
const STILL_UPSET = /(?:还|仍然|依然|并|並)?(?:没|沒有|没有|未)(?:有)?(?:好|恢复|恢復|释怀|釋懷|缓解|緩解)|并没有好|並沒有好|not\s+(?:okay|better|fine)|still\s+(?:sad|upset|angry|tired)|まだ(?:だめ|辛い|悲しい|怒って)/i;
// 「没事了」「好多了」：心情回到平静
const RESOLVED = /(?:已经|已經)?(?:没事了|沒事了|好多了|恢复了|恢復了|释怀了|釋懷了)|谢谢你安慰我|謝謝你安慰我|被你安慰好了|i(?:'m| am)\s+(?:okay|fine|better)\s+now|i\s+feel\s+better\s+now|もう大丈夫|元気になった/i;
// 「好一点了」：回落一半
const EASED = /(?:稍微|有点|有點|一点|一點)(?:好|舒服|轻松|輕鬆)(?:一点|一點)?|好一点了|好一點了|缓解了一些|緩解了一些|a\s+(?:little|bit)\s+better|少し(?:楽|良く)なった/i;
// 「好多了」「恢复了」也常说的是程序、服务：只有紧挨着说到自己，或者整句就是这一声时才当成心情
const ABOUT_SELF = /我|心情|感觉|感覺|心里|心裡|\bi(?:'m| am| feel)?\b|気持ち|私/i;
const FILLER = /[\s\p{P}\p{S}]|嗯|啊|呀|啦|吧|呢|哦|噢|唔|了|谢谢|謝謝|你|已经|已經|现在|現在|真的|其实|其實|总算|總算|终于|終於/gu;
// 用户贴来的长段文字多是材料，不是心情
const MAX_FEELING_LENGTH = 600;

function aboutSelf(text, pattern) {
    const match = pattern.exec(text);
    if (!match) return false;
    if (/安慰|i(?:'m| am)\s|i\s+feel|もう大丈夫|元気/i.test(match[0])) return true;
    const rest = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).replace(FILLER, '');
    return !rest || ABOUT_SELF.test(text.slice(Math.max(0, match.index - 4), match.index));
}

/**
 * 用户消息里真正是这个人说的话：附加文件的内容、代码块、行内代码、引用（> 开头的行）和链接都不算。
 * 附加文件是追加在消息末尾的（singleChatRequestOrchestrator），从第一个标记处截断
 */
export function ownWords(input) {
    let text = String(input ?? '');
    const attachment = text.indexOf('[附加文件:');
    if (attachment >= 0) text = text.slice(0, attachment);
    return text
        .replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)/g, '$1')
        .replace(/`[^`\n]*`/g, ' ')
        .replace(/^[ \t]*>.*$/gm, '')
        .replace(/https?:\/\/\S+/g, ' ')
        .trim();
}

/** 用户说的一句话对助手心情的影响；没有明显情绪时返回 null */
export function userMessageMoodEvent(input, at = Date.now()) {
    const text = ownWords(input);
    if (!text || text.length > MAX_FEELING_LENGTH) return null;
    if (STILL_UPSET.test(text)) return null;
    if (aboutSelf(text, RESOLVED)) return { settle: 0.6, source: 'user', at };
    if (aboutSelf(text, EASED)) return { settle: 0.35, source: 'user', at };
    const result = classifyReplyText(text);
    const emotion = result && EMPATHY[result.emotion];
    return emotion ? { emotion, intensity: result.intensity, source: 'user', at } : null;
}

/**
 * 一整条助手回复对心情的影响：有标签取最后一个标签（回复的落点），没有就用规则判断正文。
 * 思考、工具调用和代码块里的字不算。没有明显情绪时返回 null。
 */
export function replyMoodEvent(input, at = Date.now()) {
    const scanner = createEmotionTagScanner();
    let region = null;
    let lastTag = null;
    let visible = '';
    for (const event of [...scanner.push(String(input ?? '')), ...scanner.finish()]) {
        if (event.type === 'tag') lastTag = event;
        else if (event.type === 'enter') region = event.region;
        else if (event.type === 'exit') region = null;
        else if (event.type === 'text' && !region) visible = (visible + event.text).slice(-2000);
    }
    if (lastTag) return { emotion: lastTag.emotion, intensity: lastTag.intensity, source: 'tag', at };
    const result = classifyReplyText(visible);
    return result ? { emotion: result.emotion, intensity: result.intensity, source: 'rule', at } : null;
}
