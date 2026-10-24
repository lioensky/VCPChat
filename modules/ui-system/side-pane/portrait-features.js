/* Which parts of the side pane portrait are switched on.
 * Expression variants (a different portrait per reply emotion, uploaded per emotion in the agent
 * settings) are off for now: the settings only offer the default and light portraits, the header
 * never swaps by emotion, and requests do not ask the agent for emotion tags. The code stays so the
 * feature can come back by flipping this flag. The desk pet reads emotions on its own and is not
 * affected. */
'use strict';

export const PORTRAIT_EXPRESSIONS_ENABLED = false;

// 关掉差分时侧栏只用这两张
const BASE_KEYS = ['default', 'light'];

/** 差分关掉时把磁盘上读到的立绘收成 { default, light? }；打开时原样返回 */
export function visiblePortraits(portraits) {
    if (!portraits || PORTRAIT_EXPRESSIONS_ENABLED) return portraits || null;
    const kept = Object.fromEntries(BASE_KEYS.filter(key => typeof portraits[key] === 'string' && portraits[key]).map(key => [key, portraits[key]]));
    return kept.default ? kept : null;
}
