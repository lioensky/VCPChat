'use strict';
// 从资源管理器拖进文坊窗口的文件。预加载（preloads/docx.js）接收拖放、取得真实路径，发送 scriptorium:drop；这里按类型处理：
// 文稿工程、可导入的格式（.docx、.pptx、.rtf 等）、Markdown，以及文件类型登记表中的其他类型（网页、PDF、表格、文本等）
// 都交给这个文坊页面按路径打开（读取路径时再分派）；其他文件返回一句无法打开的说明，由预加载显示。一次拖入多个时打开第一个。
const fs = require('fs');
const path = require('path');
const { opensInPlace } = require('./fileTypes');

async function classify(target, importable) {
    const stat = await fs.promises.stat(target).catch(() => null);
    if (!stat) return 'missing';
    if (!stat.isFile()) return 'other';
    if (importable(target) || opensInPlace(target)) return 'file';
    if (await require('./viewFiles').looksLikeText(target)) return 'file'; // 扩展名未登记的文本
    return 'other';
}

async function dispatch(payload = {}, deps = {}, sender = null) {
    const paths = (Array.isArray(payload.paths) ? payload.paths : []).filter((item) => typeof item === 'string' && path.isAbsolute(item));
    if (!paths.length) return { ok: false, message: '未取得拖入的文件。' };
    const target = path.resolve(paths[0]);
    const kind = await classify(target, deps.importable || (() => false));
    if (kind === 'missing') return { ok: false, message: `找不到这个文件：${target}` };
    if (kind === 'other') return { ok: false, message: `文坊无法打开这个文件（${path.extname(target) || '没有扩展名'}）。` };
    require('./fileAccess').grant(target);
    if (sender && !sender.isDestroyed()) sender.send('docx:open-path-request', target);
    return { ok: true, message: paths.length > 1 ? '一次只打开一个文件，已打开第一个。' : '' };
}

function register(ipcMain, deps = {}) {
    ipcMain.removeHandler('scriptorium:drop');
    ipcMain.handle('scriptorium:drop', (event, payload) => dispatch(payload, deps, event.sender));
}

module.exports = { register, dispatch, classify };
