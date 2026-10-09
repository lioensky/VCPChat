/* 回复收起时，用户算不算没看到（没听到）：
 * 桌宠藏着（全屏让开、被藏起来）就是没看到；
 * 念出声了，人不看屏幕也听到了；
 * 否则看系统多久没碰键盘鼠标：从回复说完起一直没碰、并且至少 idleMs 了，人多半走开了。 */
export const MISSED_IDLE_MS = 20000;

export function isMissed({ hidden, idleMs, now, startedAt = 0, endedAt = 0, heardAt = 0, minIdleMs = MISSED_IDLE_MS }) {
    if (hidden) return true;
    if (heardAt > startedAt) return false;
    const sinceEnd = endedAt > 0 ? now - endedAt : 0;
    return Number(idleMs) >= Math.max(minIdleMs, sinceEnd);
}
