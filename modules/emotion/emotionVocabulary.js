/* Shared emotion vocabulary: the 12 emotion keys, the 3 state keys, aliases and VAD positions.
 * Pure data and functions with no DOM or Electron dependency, so the side pane portrait and a
 * future desk pet window read the same words. */

/** 情绪键：差分立绘 portrait.<key>.<ext>、回复里的 <!--emo:key--> 标签都用这组词 */
export const EMOTIONS = Object.freeze([
    'neutral', 'calm', 'happy', 'excited', 'shy', 'affectionate',
    'curious', 'surprised', 'concerned', 'sad', 'tired', 'angry',
]);

/** 状态键：思考、调用工具、出错时优先于情绪显示（没有对应图就继续显示当前情绪） */
export const STATES = Object.freeze(['thinking', 'tool', 'error']);

/** 主题后缀：portrait.light.<ext>、portrait.happy-light.<ext> */
export const LIGHT_SUFFIX = 'light';

const EMOTION_SET = new Set(EMOTIONS);
const STATE_SET = new Set(STATES);

// 情绪在 valence / arousal / dominance 三轴上的位置（-1..1），缺图时按距离找最像的一张
export const EMOTION_VAD = Object.freeze({
    neutral: Object.freeze({ valence: 0, arousal: 0, dominance: 0 }),
    calm: Object.freeze({ valence: 0.2, arousal: -0.35, dominance: 0.1 }),
    happy: Object.freeze({ valence: 0.8, arousal: 0.45, dominance: 0.3 }),
    excited: Object.freeze({ valence: 0.75, arousal: 0.85, dominance: 0.4 }),
    shy: Object.freeze({ valence: 0.35, arousal: 0.3, dominance: -0.45 }),
    affectionate: Object.freeze({ valence: 0.7, arousal: 0.15, dominance: 0 }),
    curious: Object.freeze({ valence: 0.3, arousal: 0.45, dominance: 0.1 }),
    surprised: Object.freeze({ valence: 0.15, arousal: 0.85, dominance: -0.15 }),
    concerned: Object.freeze({ valence: -0.35, arousal: 0.3, dominance: -0.2 }),
    sad: Object.freeze({ valence: -0.7, arousal: -0.35, dominance: -0.45 }),
    tired: Object.freeze({ valence: -0.15, arousal: -0.75, dominance: -0.3 }),
    angry: Object.freeze({ valence: -0.6, arousal: 0.7, dominance: 0.5 }),
});

// 别名：模型写中文、日文或别的常见英文词时也认得出来。左边统一小写、去掉空白和下划线
const ALIASES = new Map(Object.entries({
    neutral: 'neutral', normal: 'neutral', default: 'neutral', serious: 'neutral', focused: 'neutral', focus: 'neutral',
    平静: 'calm', 平靜: 'calm', 冷静: 'calm', 冷靜: 'calm', 淡定: 'calm', relaxed: 'calm', peaceful: 'calm',
    普通: 'neutral', 正常: 'neutral', 默认: 'neutral', 认真: 'neutral', 認真: 'neutral', 严肃: 'neutral', 嚴肅: 'neutral', 专注: 'neutral', 專注: 'neutral',
    happy: 'happy', joy: 'happy', joyful: 'happy', glad: 'happy', cheerful: 'happy', smile: 'happy', smiling: 'happy',
    开心: 'happy', 開心: 'happy', 高兴: 'happy', 高興: 'happy', 快乐: 'happy', 快樂: 'happy', 微笑: 'happy', 笑: 'happy', 嬉しい: 'happy',
    excited: 'excited', excite: 'excited', thrilled: 'excited', starry: 'excited', delighted: 'excited',
    兴奋: 'excited', 興奮: 'excited', 激动: 'excited', 激動: 'excited', 雀跃: 'excited', 雀躍: 'excited', 期待: 'excited',
    shy: 'shy', embarrassed: 'shy', bashful: 'shy', blush: 'shy', flustered: 'shy',
    害羞: 'shy', 羞涩: 'shy', 羞澀: 'shy', 脸红: 'shy', 臉紅: 'shy', 不好意思: 'shy', 照れ: 'shy',
    affectionate: 'affectionate', affection: 'affectionate', love: 'affectionate', loving: 'affectionate', tender: 'affectionate', gentle: 'affectionate', warm: 'affectionate',
    温柔: 'affectionate', 溫柔: 'affectionate', 喜欢: 'affectionate', 喜歡: 'affectionate', 爱: 'affectionate', 愛: 'affectionate', 亲昵: 'affectionate', 親暱: 'affectionate', 撒娇: 'affectionate', 撒嬌: 'affectionate',
    curious: 'curious', curiosity: 'curious', interested: 'curious', confused: 'curious', puzzled: 'curious', thinking: 'curious',
    好奇: 'curious', 疑惑: 'curious', 困惑: 'curious', 感兴趣: 'curious', 感興趣: 'curious', 思考: 'curious',
    surprised: 'surprised', surprise: 'surprised', shocked: 'surprised', astonished: 'surprised', frightened: 'surprised', scared: 'surprised',
    惊讶: 'surprised', 驚訝: 'surprised', 吃惊: 'surprised', 吃驚: 'surprised', 惊喜: 'surprised', 驚喜: 'surprised', 惊吓: 'surprised', 驚嚇: 'surprised', 驚き: 'surprised',
    concerned: 'concerned', worried: 'concerned', worry: 'concerned', anxious: 'concerned', nervous: 'concerned', apologetic: 'concerned', sorry: 'concerned', exasperated: 'concerned',
    担心: 'concerned', 擔心: 'concerned', 担忧: 'concerned', 擔憂: 'concerned', 不安: 'concerned', 紧张: 'concerned', 緊張: 'concerned', 焦虑: 'concerned', 焦慮: 'concerned', 抱歉: 'concerned', 无奈: 'concerned', 無奈: 'concerned',
    sad: 'sad', sadness: 'sad', upset: 'sad', unhappy: 'sad', crying: 'sad', disappointed: 'sad', lonely: 'sad',
    难过: 'sad', 難過: 'sad', 伤心: 'sad', 傷心: 'sad', 委屈: 'sad', 失落: 'sad', 悲伤: 'sad', 悲傷: 'sad', 哭: 'sad', 悲しい: 'sad',
    tired: 'tired', sleepy: 'tired', exhausted: 'tired', weary: 'tired', bored: 'tired',
    疲惫: 'tired', 疲憊: 'tired', 累: 'tired', 困: 'tired', 困倦: 'tired', 犯困: 'tired', 无聊: 'tired', 無聊: 'tired', 眠い: 'tired',
    angry: 'angry', anger: 'angry', annoyed: 'angry', mad: 'angry', irritated: 'angry', pouting: 'angry', grumpy: 'angry',
    生气: 'angry', 生氣: 'angry', 愤怒: 'angry', 憤怒: 'angry', 不满: 'angry', 不滿: 'angry', 恼火: 'angry', 惱火: 'angry', 哼: 'angry', 怒り: 'angry',
}));

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 把任意写法（Happy、开心、sleepy…）归一成 12 个情绪键之一；认不出返回 null */
export function normalizeEmotion(value) {
    const token = String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '');
    if (!token) return null;
    if (EMOTION_SET.has(token)) return token;
    return ALIASES.get(token) || null;
}

export function isEmotion(value) {
    return EMOTION_SET.has(value);
}

export function isState(value) {
    return STATE_SET.has(value);
}

export function clampIntensity(value, fallback = 0.7) {
    const number = Number(value);
    return Number.isFinite(number) ? clamp(number, 0, 1) : fallback;
}

function vadDistance(a, b) {
    return Math.hypot(a.valence - b.valence, a.arousal - b.arousal, a.dominance - b.dominance);
}

// 正负情绪不互相代替：sad 缺图时宁可回到默认立绘，也不显示一张笑脸
function sameValenceSide(a, b) {
    if (Math.abs(a.valence) < 0.3 || Math.abs(b.valence) < 0.3) return true;
    return Math.sign(a.valence) === Math.sign(b.valence);
}

/**
 * 按情绪相近程度给出候选：先是自己，再是 VAD 距离不超过 maxDistance、正负一致的其他情绪（近的在前）。
 * neutral 不在候选里，调用方最后自己退回默认立绘。
 */
export function emotionFallbacks(emotion, { maxDistance = 0.75 } = {}) {
    const key = normalizeEmotion(emotion);
    if (!key || key === 'neutral') return [];
    const origin = EMOTION_VAD[key];
    const others = EMOTIONS
        .filter(other => other !== key && other !== 'neutral')
        .map(other => ({ other, distance: vadDistance(origin, EMOTION_VAD[other]) }))
        .filter(({ other, distance }) => distance <= maxDistance && sameValenceSide(origin, EMOTION_VAD[other]))
        .sort((a, b) => a.distance - b.distance)
        .map(({ other }) => other);
    return [key, ...others];
}
