/* Pick which portrait file shows a given emotion frame.
 * portraits is what get-agent-portraits returns: { default, light?, <key>?: url } where a key is an
 * emotion (happy), a state (thinking) or either with the light suffix (happy-light).
 * Order: state image -> the emotion -> the nearest emotion that has an image -> neutral -> default.
 * In the light theme every step tries <key>-light first. */
import { EMOTIONS, STATES, LIGHT_SUFFIX, emotionFallbacks, isState } from './emotionVocabulary.js';

const VARIANT_KEYS = new Set([...EMOTIONS, ...STATES]);

function baseKey(key) {
    return key.endsWith(`-${LIGHT_SUFFIX}`) ? key.slice(0, -LIGHT_SUFFIX.length - 1) : key;
}

/** 这个角色有没有任何差分（情绪或状态立绘）；只有 default / light 时返回 false */
export function hasPortraitVariants(portraits) {
    if (!portraits || typeof portraits !== 'object') return false;
    return Object.keys(portraits).some(key => VARIANT_KEYS.has(baseKey(key)) && typeof portraits[key] === 'string');
}

/** 列出有图的情绪 / 状态键（不含主题后缀），设置页和调试用 */
export function listPortraitVariants(portraits) {
    if (!portraits || typeof portraits !== 'object') return [];
    const keys = new Set();
    for (const key of Object.keys(portraits)) {
        const base = baseKey(key);
        if (VARIANT_KEYS.has(base) && typeof portraits[key] === 'string') keys.add(base);
    }
    return [...keys];
}

/**
 * 返回 { key, url }；连默认立绘都没有时返回 null。
 * theme 为 'light' 时优先用 -light 版本，没有就用同一个键的普通版本。
 */
export function resolvePortrait(portraits, { state = null, emotion = 'neutral', theme = 'dark' } = {}) {
    if (!portraits || typeof portraits.default !== 'string' || !portraits.default) return null;
    const light = theme === 'light';
    const pick = (key) => {
        if (light && typeof portraits[`${key}-${LIGHT_SUFFIX}`] === 'string') return { key: `${key}-${LIGHT_SUFFIX}`, url: portraits[`${key}-${LIGHT_SUFFIX}`] };
        if (typeof portraits[key] === 'string') return { key, url: portraits[key] };
        return null;
    };
    if (state && isState(state)) {
        const found = pick(state);
        if (found) return found;
    }
    for (const candidate of [...emotionFallbacks(emotion), 'neutral']) {
        const found = pick(candidate);
        if (found) return found;
    }
    if (light && typeof portraits.light === 'string') return { key: LIGHT_SUFFIX, url: portraits.light };
    return { key: 'default', url: portraits.default };
}
