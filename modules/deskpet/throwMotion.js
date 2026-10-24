// modules/deskpet/throwMotion.js
// 甩出去：松手时光标还在快速移动，桌宠带着这股速度滑出去，横向慢慢减速，同时往下掉，
// 撞到屏幕左右边停住，最后落在任务栏（工作区底边）上。慢慢放下的不算甩，照旧原地放下。
// 纯函数，主进程和测试共用；坐标都是 DIP，速度是 DIP/秒。

'use strict';

const THROW_MIN_SPEED = 900;  // 松手前这么快才算甩
const SAMPLE_MS = 100;        // 按松手前这段时间的位移算速度
const STILL_MS = 60;          // 松手前这么久光标没动过：是停稳了再放的
const FRICTION = 3.2;         // 横向每秒按 e^(-k) 减速
const GRAVITY = 2600;
const MAX_SPEED = 4000;
const MAX_MS = 2500;

/** samples：[{ t, x, y }]（光标位置，时间毫秒），返回松手那一刻的速度 { vx, vy }。 */
function releaseVelocity(samples, now) {
    if (!Array.isArray(samples) || samples.length < 2) return { vx: 0, vy: 0 };
    const last = samples[samples.length - 1];
    if (now - last.t > STILL_MS) return { vx: 0, vy: 0 };
    let first = last;
    for (let i = samples.length - 2; i >= 0 && last.t - samples[i].t <= SAMPLE_MS; i -= 1) first = samples[i];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return { vx: 0, vy: 0 };
    const clamp = (v) => Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v));
    return { vx: clamp((last.x - first.x) / dt), vy: clamp((last.y - first.y) / dt) };
}

function isRect(r) {
    return r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
}

/**
 * 甩出去的轨迹。win：窗口位置；figure：角色在窗口里的包围盒；area：工作区；v：松手速度；tickMs：每帧间隔。
 * 不算甩（太慢、没量到角色）返回 null；否则返回每帧的窗口位置，最后一帧落在工作区底边上。
 */
function throwPath(win, figure, area, v, tickMs = 16) {
    if (!isRect(win) || !isRect(figure) || !isRect(area) || !v) return null;
    if (Math.hypot(v.vx, v.vy) < THROW_MIN_SPEED) return null;
    const minX = area.x - figure.x;
    const maxX = area.x + area.width - figure.x - figure.width;
    const minY = area.y - figure.y;
    const floorY = area.y + area.height - figure.y - figure.height;
    if (minX > maxX || minY > floorY) return null;
    let x = Math.max(minX, Math.min(maxX, win.x));
    let y = Math.max(minY, Math.min(floorY, win.y));
    let { vx, vy } = v;
    const dt = tickMs / 1000;
    const frames = [];
    for (let t = 0; t < MAX_MS; t += tickMs) {
        vx *= Math.exp(-FRICTION * dt);
        vy += GRAVITY * dt;
        x += vx * dt;
        y += vy * dt;
        if (x <= minX) { x = minX; vx = 0; }
        if (x >= maxX) { x = maxX; vx = 0; }
        if (y <= minY) { y = minY; vy = Math.max(0, vy); }
        const landed = y >= floorY;
        if (landed) y = floorY;
        frames.push({ x: Math.round(x), y: Math.round(y) });
        if (landed) break;
    }
    if (frames.length) frames[frames.length - 1] = { x: frames[frames.length - 1].x, y: Math.round(floorY) };
    return frames;
}

module.exports = { THROW_MIN_SPEED, releaseVelocity, throwPath };
