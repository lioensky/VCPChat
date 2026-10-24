// modules/deskpet/edgeSnap.js
// 贴边：拖到屏幕左右边或任务栏附近松手时，角色本身（不是透明窗口）贴齐那条边，脚底落在任务栏上。
// 拖出去一大截（四成以上在屏幕外）松手：收进边里只露一小条，鼠标过来、有话要说时探出来（tuckPosition）。
// 按住 Alt 松手都不管。
// 纯函数，主进程和测试共用；坐标都是 DIP。

'use strict';

const SNAP_DIP = 24;

function isRect(r) {
    return r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
}

/**
 * win：窗口在屏幕上的位置和大小；figure：角色在窗口里的包围盒（页面量的）；area：这块屏的工作区。
 * 返回窗口该去的位置和贴上的边（没贴就是 null）。
 */
function snapPosition(win, figure, area, threshold = SNAP_DIP) {
    if (!isRect(win) || !isRect(figure) || !isRect(area)) return null;
    const left = win.x + figure.x;
    const right = left + figure.width;
    const bottom = win.y + figure.y + figure.height;
    const areaRight = area.x + area.width;
    const areaBottom = area.y + area.height;
    let dx = 0;
    let dy = 0;
    const edges = [];
    if (Math.abs(left - area.x) <= threshold) {
        dx = area.x - left;
        edges.push('left');
    } else if (Math.abs(areaRight - right) <= threshold) {
        dx = areaRight - right;
        edges.push('right');
    }
    if (Math.abs(areaBottom - bottom) <= threshold) {
        dy = areaBottom - bottom;
        edges.push('bottom');
    }
    if (!edges.length) return null;
    return { x: Math.round(win.x + dx), y: Math.round(win.y + dy), edges };
}

const TUCK_FROM = 0.4;  // 角色有这么多在屏幕外才算想藏起来
const TUCK_SHOW = 0.3;  // 藏好以后露出来的部分

/**
 * 拖出屏幕左边或右边一大截：收进去。返回 { side, tucked, out }：tucked 是藏好的窗口位置（露 TUCK_SHOW），
 * out 是整只出来、贴着那条边的位置。那条边外面还有别的显示器（扩展屏中间的边）就不藏，返回 null。
 * isOuterEdge(side, y)：那条边的外面是不是没有屏幕了。
 */
function tuckPosition(win, figure, area, isOuterEdge = () => true) {
    if (!isRect(win) || !isRect(figure) || !isRect(area)) return null;
    const left = win.x + figure.x;
    const right = left + figure.width;
    const areaRight = area.x + area.width;
    let side = null;
    if (area.x - left >= figure.width * TUCK_FROM) side = 'left';
    else if (right - areaRight >= figure.width * TUCK_FROM) side = 'right';
    if (!side) return null;
    // 上下不能出工作区：头别顶出屏幕，脚别掉到任务栏下面
    const top = win.y + figure.y;
    const minY = area.y - figure.y;
    const maxY = area.y + area.height - figure.y - figure.height;
    const y = Math.round(Math.max(minY, Math.min(maxY, win.y)));
    if (!isOuterEdge(side, top + figure.height / 2)) return null;
    const hidden = Math.round(figure.width * (1 - TUCK_SHOW));
    const tuckedLeft = side === 'left' ? area.x - hidden : areaRight - figure.width + hidden;
    const outLeft = side === 'left' ? area.x : areaRight - figure.width;
    return {
        side,
        tucked: { x: Math.round(tuckedLeft - figure.x), y },
        out: { x: Math.round(outLeft - figure.x), y },
    };
}

/** 从 from 滑到 to 的几帧（先快后慢），最后一帧正好是 to。 */
function snapFrames(from, to, count = 6) {
    const frames = [];
    for (let i = 1; i <= count; i += 1) {
        const t = 1 - (1 - i / count) ** 3;
        frames.push({ x: Math.round(from.x + (to.x - from.x) * t), y: Math.round(from.y + (to.y - from.y) * t) });
    }
    return frames;
}

module.exports = { SNAP_DIP, snapPosition, snapFrames, tuckPosition };
