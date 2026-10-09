/* 视线：把「光标相对头的位置」或待机游走的方向换成头和眼睛真正转多少。纯函数，页面和测试共用。
 *
 * 桌宠几乎总是待在屏幕下方，光标和屏幕大部分区域都在它上面。以前只取方向、不管远近
 * （Live2D 自带的 focus 也是这样，转到最大 30°），结果一直仰着头往上看。现在：
 *   - 光标离头很近（死区内）就平视，不跟着抖；
 *   - 离得越远转得越多，到一定距离封顶；
 *   - 往上最多只转一小点，往下、往两边可以多一些。
 * 返回值 x、y 都在 -1..1，y 向上为正；Live2D 的 ParamAngleY 是 30 × y。 */

export const GAZE_LIMITS = Object.freeze({
    deadZone: 0.12, // 相对距离（按窗口尺寸归一化）在这以内当作正对着
    reach: 1.2,     // 到这个距离转到封顶
    maxX: 0.8,
    maxUp: 0.25,    // Live2D 上约 7°
    maxDown: 0.5,
});

/** dx、dy：光标相对头的位置，已按窗口尺寸归一化（dy 向上为正，不限范围）。 */
export function shapeGaze(dx, dy, limits = GAZE_LIMITS) {
    const x = Number(dx) || 0;
    const y = Number(dy) || 0;
    const dist = Math.hypot(x, y);
    if (dist <= limits.deadZone) return { x: 0, y: 0 };
    const t = Math.min(1, (dist - limits.deadZone) / (limits.reach - limits.deadZone));
    // 起步缓一点：刚出死区时不会一下子转过去
    const mag = t * t * (3 - 2 * t);
    const ux = x / dist;
    const uy = y / dist;
    return {
        x: round3(ux * mag * limits.maxX),
        y: round3(uy * mag * (uy > 0 ? limits.maxUp : limits.maxDown)),
    };
}

/** 待机游走、犯困给的方向（-1..1，y 向上为正）：同样按上下的上限收一下。 */
export function limitGaze(g, limits = GAZE_LIMITS) {
    const x = Math.max(-1, Math.min(1, Number(g?.x) || 0));
    const y = Math.max(-1, Math.min(1, Number(g?.y) || 0));
    return { x: round3(x * limits.maxX), y: round3(y * (y > 0 ? limits.maxUp : limits.maxDown)) };
}

function round3(v) {
    return Math.round(v * 1000) / 1000 || 0;
}
