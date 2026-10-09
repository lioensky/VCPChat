// modules/deskpet/wander.js
// 溜达（默认关）：桌宠站在任务栏上闲了一阵，会沿着任务栏慢慢走一小段。
// 只在脚踩着任务栏时走，离左右边留点空，走不开就不走。纯函数，主进程和测试共用；坐标都是 DIP。

'use strict';

const WANDER = Object.freeze({
    minStep: 80,
    maxStep: 220,
    speed: 60, // 每秒走多远
    floorSlack: 8, // 脚底离任务栏这么近才算站在上面
    wallGap: 12,
});

function isRect(r) {
    return r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
}

/**
 * win：窗口位置和大小；figure：角色在窗口里的包围盒；area：这块屏的工作区。
 * 返回窗口要走到的位置和方向；不在任务栏上、两边都没地方走时是 null。
 */
function wanderTarget(win, figure, area, rand = Math.random) {
    if (!isRect(win) || !isRect(figure) || !isRect(area)) return null;
    const bottom = win.y + figure.y + figure.height;
    if (Math.abs(area.y + area.height - bottom) > WANDER.floorSlack) return null;
    const left = win.x + figure.x;
    const room = {
        left: left - (area.x + WANDER.wallGap),
        right: area.x + area.width - WANDER.wallGap - (left + figure.width),
    };
    let dir = rand() < 0.5 ? 'left' : 'right';
    if (room[dir] < WANDER.minStep) dir = dir === 'left' ? 'right' : 'left';
    if (room[dir] < WANDER.minStep) return null;
    const step = Math.min(room[dir], WANDER.minStep + rand() * (WANDER.maxStep - WANDER.minStep));
    return { x: Math.round(win.x + (dir === 'left' ? -step : step)), y: win.y, dir };
}

/** 从 from 匀速走到 to 的每一帧（tickMs 一帧），最后一帧正好是 to。 */
function walkFrames(from, to, tickMs, speed = WANDER.speed) {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const count = Math.max(1, Math.ceil(distance / (speed * tickMs / 1000)));
    const frames = [];
    for (let i = 1; i <= count; i += 1) {
        frames.push({ x: Math.round(from.x + (to.x - from.x) * i / count), y: Math.round(from.y + (to.y - from.y) * i / count) });
    }
    return frames;
}

module.exports = { WANDER, wanderTarget, walkFrames };
