// modules/deskpet/petPreviews.js
// 设置页「我的桌宠」卡片和大预览用的形象快照。
//
// 在一个看不见的离屏窗口里按某套形象打开桌宠页面（?preview=1：只画角色，不弹气泡、不接回复流、不出声），
// 页面量好角色的位置后报上来，这里截下角色那一块存成 PNG。快照按形象主文件的大小和修改时间记着，
// 文件没变就直接用旧的；同一时间只渲染一套，排队来，空闲一会儿后关掉离屏窗口。
//
// 快照放在 AppData/deskpet/previews/<agentId>/<形象 id 的摘要>.png，旁边的 .json 记着指纹。

'use strict';

const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const { pathToFileURL } = require('url');

const RENDER_TIMEOUT_MS = 15000;
const IDLE_CLOSE_MS = 15000;
const MAX_HEIGHT = 480;
const PAD = 6;
// 页面报「画好了」时离屏帧可能还没合成出来（机器忙、高缩放时常见），截到的是全透明；隔一会儿再截
const BLANK_RETRIES = 6;
const BLANK_RETRY_MS = 250;

// 截图里有没有一个不透明的像素（按行跳着看，几百个点就够）
function hasPixels(image) {
    const bitmap = image.toBitmap?.();
    if (!bitmap || !bitmap.length) return !image.isEmpty();
    const step = Math.max(4, Math.floor(bitmap.length / 4 / 4000) * 4);
    for (let i = 3; i < bitmap.length; i += step) if (bitmap[i] > 0) return true;
    return false;
}

function keyOf(outfitId) {
    return crypto.createHash('sha1').update(String(outfitId)).digest('hex').slice(0, 16);
}

async function statKey(file) {
    if (!file) return '';
    try {
        const stat = await fs.stat(file);
        return `${file}:${stat.size}:${Math.round(stat.mtimeMs)}`;
    } catch {
        return `${file}:missing`;
    }
}

// 模型文件夹里最近一次改动（换了贴图、动作、表情也要重画）；只往下看两层、最多几百个文件
async function newestIn(dir, depth = 0, budget = { files: 400 }) {
    if (!dir || depth > 2 || budget.files <= 0) return 0;
    let newest = 0;
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (budget.files <= 0) break;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) newest = Math.max(newest, await newestIn(full, depth + 1, budget));
        else if (entry.isFile()) {
            budget.files -= 1;
            newest = Math.max(newest, (await fs.stat(full).catch(() => null))?.mtimeMs || 0);
        }
    }
    return newest;
}

/** 形象有没有变：主文件（模型、网格立绘、默认立绘）的路径、大小、修改时间，模型所在文件夹里最新的改动，加上实际会用的种类。 */
async function fingerprintOf(outfit) {
    const modelDir = outfit.live2d || outfit.puppet ? path.dirname(outfit.live2d || outfit.puppet) : null;
    const parts = [outfit.kind || '', await statKey(outfit.live2d), await statKey(outfit.puppet), await statKey(outfit.portraits?.default),
        Math.round(await newestIn(modelDir))];
    return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

function createPetPreviews({ BrowserWindow, cacheRoot, pageUrl, preload, windowSize }) {
    const queue = [];
    const inflight = new Map(); // `${agentId}\n${outfitId}` -> Promise
    let current = null; // { agentId, outfitId, resolve, timer }
    let win = null;
    let idleTimer = null;
    let disposed = false;
    let jobSeq = 0;

    const dirOf = (agentId) => path.join(cacheRoot, agentId);
    const fileOf = (agentId, outfitId) => path.join(dirOf(agentId), `${keyOf(outfitId)}.png`);
    const urlOf = (file, fingerprint) => `${pathToFileURL(file).href}?v=${fingerprint}`;

    /** 文件没变时的现成快照（file:// 地址，带指纹防缓存）；没有或过期返回 null。 */
    async function cached(agentId, outfit) {
        const file = fileOf(agentId, outfit.id);
        try {
            const meta = await fs.readJson(`${file.slice(0, -4)}.json`);
            const fingerprint = await fingerprintOf(outfit);
            if (meta?.fingerprint === fingerprint && await fs.pathExists(file)) return urlOf(file, fingerprint);
        } catch { /* 没有快照 */ }
        return null;
    }

    function ensureWindow(size) {
        clearTimeout(idleTimer);
        if (win && !win.isDestroyed()) {
            win.setContentSize?.(size.width, size.height);
            return win;
        }
        win = new BrowserWindow({
            ...size,
            show: false,
            frame: false,
            transparent: true,
            backgroundColor: '#00000000',
            skipTaskbar: true,
            focusable: false,
            webPreferences: {
                preload,
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
                // 不显示的窗口靠离屏渲染出帧，截图才不是空白
                offscreen: true,
                backgroundThrottling: false,
            },
        });
        win.webContents.setFrameRate?.(30);
        win.on('closed', () => {
            win = null;
            if (current) finish(null);
        });
        return win;
    }

    function scheduleIdleClose() {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (!current && win && !win.isDestroyed()) win.destroy();
        }, IDLE_CLOSE_MS);
    }

    function finish(result) {
        const job = current;
        if (!job) return;
        current = null;
        clearTimeout(job.timer);
        job.resolve(result);
        // 不让上一套的页面在后台接着跑
        if (win && !win.isDestroyed()) win.webContents.loadURL('about:blank').catch(() => {});
        pump();
    }

    function pump() {
        if (current || disposed) return;
        const next = queue.shift();
        if (!next) {
            scheduleIdleClose();
            return;
        }
        current = next;
        next.id = String(++jobSeq);
        try {
            const target = ensureWindow(windowSize(next.aspect));
            next.timer = setTimeout(() => finish(null), RENDER_TIMEOUT_MS);
            target.webContents.loadURL(`${pageUrl(next.agentId, next.outfit.id)}&job=${next.id}`).catch(() => {});
        } catch (error) {
            console.warn('[DeskPet] preview window failed:', error.message);
            finish(null);
        }
    }

    /** 渲染一套形象的快照；同一套排着队时合并成一次。返回 file:// 地址，失败返回 null。 */
    function render(agentId, outfit, { aspect = null } = {}) {
        const key = `${agentId}\n${outfit.id}`;
        if (inflight.has(key)) return inflight.get(key);
        const promise = new Promise((resolve) => {
            queue.push({ agentId, outfit, aspect, resolve });
            pump();
        }).finally(() => inflight.delete(key));
        inflight.set(key, promise);
        return promise;
    }

    /** 离屏页面问「我该画谁」：只回答当前正在渲染的那一个窗口。 */
    function jobFor(sender) {
        if (!current || !win || win.isDestroyed() || sender !== win.webContents) return null;
        return { agentId: current.agentId, outfitId: current.outfit.id };
    }

    /** 页面画好了，报上角色的包围盒（窗口内 CSS 像素）。 */
    async function ready(sender, report) {
        const job = current;
        if (!job || !win || win.isDestroyed() || sender !== win.webContents || String(report?.job) !== job.id) return;
        try {
            const [width, height] = win.getContentSize();
            const b = report?.bounds;
            const valid = b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 4 && b.height > 4;
            const x = valid ? Math.max(0, Math.floor(b.x - PAD)) : 0;
            const y = valid ? Math.max(0, Math.floor(b.y - PAD)) : 0;
            const rect = valid
                ? { x, y, width: Math.min(width - x, Math.ceil(b.width + PAD * 2)), height: Math.min(height - y, Math.ceil(b.height + PAD * 2)) }
                : { x: 0, y: 0, width, height };
            let image = await win.webContents.capturePage(rect);
            for (let tries = 0; current === job && !image.isEmpty() && !hasPixels(image) && tries < BLANK_RETRIES; tries++) {
                await new Promise((resolve) => setTimeout(resolve, BLANK_RETRY_MS));
                if (current !== job || !win || win.isDestroyed()) return;
                image = await win.webContents.capturePage(rect);
            }
            if (current !== job) return;
            // 空白的不存：存下来指纹不变，卡片就一直是空的
            if (image.isEmpty() || !hasPixels(image)) {
                finish(null);
                return;
            }
            if (image.getSize().height > MAX_HEIGHT) image = image.resize({ height: MAX_HEIGHT, quality: 'best' });
            const file = fileOf(job.agentId, job.outfit.id);
            const fingerprint = await fingerprintOf(job.outfit);
            await fs.outputFile(file, image.toPNG());
            await fs.outputJson(`${file.slice(0, -4)}.json`, { fingerprint, outfit: job.outfit.id, aspect: report?.aspect ?? null });
            if (current === job) finish(urlOf(file, fingerprint));
        } catch (error) {
            console.warn('[DeskPet] preview capture failed:', error.message);
            if (current === job) finish(null);
        }
    }

    /** 助手被删、形象被删以后清掉不再用的快照。 */
    async function prune(agentId, keepIds) {
        const keep = new Set(keepIds.map(keyOf));
        const files = await fs.readdir(dirOf(agentId)).catch(() => []);
        await Promise.all(files.filter((name) => !keep.has(name.replace(/\.(png|json)$/, ''))).map((name) => fs.remove(path.join(dirOf(agentId), name)).catch(() => {})));
    }

    /** 助手被删掉：整个快照文件夹一起删。 */
    async function forget(agentId) {
        await fs.remove(dirOf(agentId)).catch(() => {});
    }

    function dispose() {
        disposed = true;
        clearTimeout(idleTimer);
        for (const job of queue.splice(0)) job.resolve(null);
        if (current) finish(null);
        if (win && !win.isDestroyed()) win.destroy();
    }

    return { cached, render, jobFor, ready, prune, forget, dispose, isPreviewSender: (sender) => Boolean(win && !win.isDestroyed() && sender === win.webContents) };
}

module.exports = { createPetPreviews, fingerprintOf };
