// modules/musicWindowBounds.js
//
// 音乐窗口下次打开时回到上次的位置和大小。没有 electron 依赖，主进程和测试都能直接用。
// 上次所在的那块屏可能已经拔掉、分辨率变了、或者窗口被拖到了屏幕外面：
// 这时不能照原样放回去，要么挪回某块屏里，要么干脆用默认位置。

const fs = require('fs');
const path = require('path');

const MIN_VISIBLE = 120; // 窗口至少要有这么宽、这么高的一块落在某块屏的工作区里，否则当作找不到
let tmpSeq = 0;

const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);

function overlap(a, b) {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? { w, h } : { w: 0, h: 0 };
}

/**
 * @param {object} saved  上次存下的 {x, y, width, height, maximized}
 * @param {{x,y,width,height}[]} workAreas  现在每块屏的工作区
 * @param {{minWidth:number, minHeight:number}} limits
 * @returns {{x,y,width,height,maximized:boolean}|null}  null 表示用默认位置
 */
function restoreBounds(saved, workAreas, { minWidth = 0, minHeight = 0 } = {}) {
    if (!saved || typeof saved !== 'object' || !Array.isArray(workAreas) || !workAreas.length) return null;
    const x = num(saved.x), y = num(saved.y), width = num(saved.width), height = num(saved.height);
    if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null;
    const rect = { x, y, width, height };
    let best = null, bestArea = 0;
    for (const area of workAreas) {
        if (!area || !(area.width > 0) || !(area.height > 0)) continue;
        const o = overlap(rect, area);
        if (o.w >= Math.min(MIN_VISIBLE, width) && o.h >= Math.min(MIN_VISIBLE, height) && o.w * o.h > bestArea) {
            best = area;
            bestArea = o.w * o.h;
        }
    }
    if (!best) return null;
    // 屏变小了：缩到装得下，再整个挪进这块屏，标题栏（在页面顶部）一定能点到
    const w = Math.max(Math.min(width, best.width), Math.min(minWidth, best.width));
    const h = Math.max(Math.min(height, best.height), Math.min(minHeight, best.height));
    const cx = Math.min(Math.max(x, best.x), best.x + best.width - w);
    const cy = Math.min(Math.max(y, best.y), best.y + best.height - h);
    return { x: cx, y: cy, width: w, height: h, maximized: saved.maximized === true };
}

function readSavedBounds(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        return null;
    }
}

function writeSavedBounds(file, win) {
    let tmp = null;
    try {
        if (!win || win.isDestroyed()) return;
        // getNormalBounds 在最小化、最大化、全屏时给的都是还原后的大小
        const b = typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : win.getBounds();
        if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !(b.width > 0) || !(b.height > 0)) return;
        const data = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: Boolean(win.isMaximized?.()) };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, file);
        tmp = null;
    } catch (error) {
        if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} }
        console.error('[Music] Failed to save window bounds:', error.message);
    }
}

module.exports = { restoreBounds, readSavedBounds, writeSavedBounds };
