'use strict';
// 从资源管理器拖进文坊的文件、文件夹交给谁。
// 预加载（preloads/desktop.js、preloads/docx.js）只管接住、取真实路径，送到 uttu-drop:open；这里按类型分派：
//   文件夹 → 加进文坊的工作区（左栏资源管理器）；.md / .markdown → 文坊原地打开；.vdocx / .vpptx → 文坊；
//   .txt / .html / .htm / .docx / .pptx / .rtf → 文坊导入成新工程（.txt 还不能原地编辑）；别的 → 回一句“打不开”，由预加载显示。
// 拖进文坊（独立窗口或 Chat 右栏里的）就在那个文坊里开；别处交来的开在文坊自己的窗口。
// 一次拖进好几个：开第一个。接入：main.js 一行。
const fs = require('fs');
const path = require('path');

const MARKDOWN = new Set(['.md', '.markdown']);
const PROJECT = new Set(['.vdocx', '.vpptx']);
const IMPORT = new Set(['.docx', '.pptx', '.rtf']);
const { isOverlay } = require('./scriptoriumTypes');

async function classify(target) {
    const stat = await fs.promises.stat(target).catch(() => null);
    if (!stat) return { kind: 'missing' };
    if (stat.isDirectory()) return { kind: 'folder' };
    const ext = path.extname(target).toLowerCase();
    if (MARKDOWN.has(ext)) return { kind: 'markdown' };
    if (PROJECT.has(ext)) return { kind: 'project' };
    if (IMPORT.has(ext)) return { kind: 'import' };
    if (isOverlay(target)) return { kind: 'overlay' }; // PDF、表格（文坊当视图开）
    if (await require('./viewFiles').looksLikeText(target)) return { kind: 'overlay' }; // 没登记的文本
    return { kind: 'other', ext };
}

async function dispatch(payload = {}, deps = {}, sender = null) {
    const paths = (Array.isArray(payload.paths) ? payload.paths : []).filter((item) => typeof item === 'string' && path.isAbsolute(item));
    if (!paths.length) return { ok: false, message: '没拿到拖进来的文件。' };
    const target = path.resolve(paths[0]);
    const { kind, ext } = await classify(target);
    if (kind === 'missing') return { ok: false, message: `找不到这个文件：${target}` };
    if (kind === 'other') return { ok: false, message: `这个文件 VCP 打不开（${ext || '没有扩展名'}）。` };
    // 拖进来的文件夹就是加一个工作区：主进程先加，页面只负责打开它。
    if (kind === 'folder') await require('./scriptoriumFiles').addRoot(target).catch(() => {});
    else require('./scriptoriumFiles').grant(target); // 拖进来的文件文坊能读（PDF 的读先过 allowed）
    if (payload.from === 'scriptorium' && sender && !sender.isDestroyed()) {
        sender.send(kind === 'folder' ? 'uttu-scriptorium:open-folder' : 'docx:open-path-request', target);
    } else {
        await deps.openScriptorium({ ...(kind === 'folder' ? { folder: target } : { filePath: target }), window: true, reveal: true });
    }
    return { ok: true, kind, message: paths.length > 1 ? '一次开一份，开了第一个。' : '' };
}

function register(ipcMain, deps = {}) {
    ipcMain.removeHandler('uttu-drop:open');
    ipcMain.handle('uttu-drop:open', (event, payload) => dispatch(payload, deps, event.sender));
}

module.exports = { register, dispatch, classify };
