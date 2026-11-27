'use strict';

// 消息图片（应用功能模块，见 feature.json 和 docs/app-features.md）的主进程入口。
// 主窗口把选中的消息逐条画成 PNG 交过来（renderer/index.js），这里竖着拼成一张，复制到剪贴板或存成文件。
// 删掉整个 modules/messageImage 目录，或在插件管理器里停用，Chat 照常运行。

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ClipboardItem, clipboard, dialog, ipcMain, nativeImage } = require('electron');
const { stitchBitmaps, MAX_PIXELS } = require('./stitch');

const { pathToFileURL } = require('node:url');
const MAX_PARTS = 2000; // 500 条消息，长消息还会分段

function readOptions(options) {
    const number = (value, fallback, max) => {
        const parsed = Math.round(Number(value));
        return Number.isFinite(parsed) ? Math.max(0, Math.min(max, parsed)) : fallback;
    };
    const background = Array.isArray(options?.background) ? options.background.slice(0, 3) : [0, 0, 0];
    const gaps = Array.isArray(options?.gaps) ? options.gaps.slice(0, MAX_PARTS).map((value) => number(value, 0, 200)) : null;
    return { gap: number(options?.gap, 0, 200), gaps, pad: number(options?.pad, 0, 200), background };
}

// Inspect dimensions before allocating any decoded bitmaps.
function pngInfo(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 33 || bytes.length > 340_000_000) throw new Error('Invalid PNG size.');
    const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (png.readBigUInt64BE(0) !== 0x89504e470d0a1a0an || png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG header.');
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    if (!width || !height || width * height > MAX_PIXELS) throw new Error('PNG exceeds the image limit.');
    return { png, width, height };
}

function toImage(parts, options) {
    if (!Array.isArray(parts) || !parts.length) throw new Error('没有选中消息。');
    if (parts.length > MAX_PARTS) throw new Error(`一次最多 ${MAX_PARTS} 条。`);
    const opts = readOptions(options);
    const inputs = parts.map(pngInfo);
    const width = Math.max(...inputs.map(part => part.width)) + 2 * opts.pad;
    const height = inputs.reduce((h, part, i) => h + part.height + (i ? opts.gaps?.[i-1] ?? opts.gap : 0), 2 * opts.pad);
    if (width * height > MAX_PIXELS) throw new Error('Combined image exceeds the image limit.');
    const bitmaps = inputs.map(({png}) => {
        const image = nativeImage.createFromBuffer(png);
        if (image.isEmpty()) throw new Error('有一条消息没画出来。');
        const { width, height } = image.getSize();
        return { width, height, data: image.toBitmap() };
    });
    const stitched = stitchBitmaps(bitmaps, opts);
    return nativeImage.createFromBitmap(stitched.data, { width: stitched.width, height: stitched.height });
}

function stamp(date = new Date()) {
    const two = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

// 预览只生成 PNG，不写剪贴板、不弹保存框。完成后直接交付用户看到的字节。
function prepare(event, parts, options) {
    return toImage(parts, options).toPNG();
}

async function output(event, action, bytes) {
    try {
        const { png, width, height } = pngInfo(bytes);
        if (action === 'copy') {
            await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
            return { ok: true, width, height };
        }
        if (action !== 'save') throw new Error('未知图片操作。');
        const owner = BrowserWindow.fromWebContents(event.sender) || undefined;
        const { canceled, filePath } = await dialog.showSaveDialog(owner, {
            title: '保存为图片', defaultPath: path.join(app.getPath('pictures'), `对话 ${stamp()}.png`),
            filters: [{ name: 'PNG 图片', extensions: ['png'] }],
        });
        if (canceled || !filePath) return { ok: false, canceled: true };
        await fs.promises.writeFile(filePath, png);
        return { ok: true, filePath, width, height };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

function register({ projectRoot }) {
    const page = pathToFileURL(path.join(projectRoot, 'main.html')).href;
    const fromChat = handler => (event, ...args) => {
        if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url.split(/[?#]/)[0] !== page) {
            throw new Error('This action is only available in the main chat.');
        }
        return handler(event, ...args);
    };
    ipcMain.handle('message-image:prepare', fromChat(prepare));
    ipcMain.handle('message-image:output', fromChat(output));
    return {
        dispose() {
            ipcMain.removeHandler('message-image:prepare');
            ipcMain.removeHandler('message-image:output');
        },
    };
}

module.exports = { register };
