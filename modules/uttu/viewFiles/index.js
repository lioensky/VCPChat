'use strict';
// 文坊里的文本、代码和图片。一个通道 uttu-view:act。
// 页面：uttu-scriptorium-text.js、uttu-scriptorium-image.js。都先过 scriptoriumFiles.allowed（工作区、文库、笔记、最近打开，和主进程自己交给文坊的）。
// - read：文本原样读（UTF-8、UTF-16、GB18030，textEncoding.js），带 NUL 的不开（当成二进制），32 MB 以内。换行统一成 \n，原来的写法、编码和 BOM 记下，存回时还原。
//   扩展名没登记的也试着当文本读（looksLikeText）。
//   白板（.excalidraw，uttu-scriptorium-board.js）也是文本，走同样的 read、save；里面能嵌图片，上限放宽。
// - save：先写临时文件再一步换过去；修改时间对不上回 conflict，页面问用哪份，force 时照存。
// - image、media：图片、音视频的大小、修改时间，和同一文件夹里的同类文件（上一个、下一个用）。
// - watch / check：盯正在看的那份（文件夹通知加 2 秒轮询），外面改了发 uttu-view:changed。
// - picks-read / picks-write：网页、图片、PDF、表格、文本的批注，存在 AppData/Scriptorium/uttu-picks，文件本身不动。crop 截批注用的图片片段。
// - history-add / history-list / history-restore：外面改了文本、网页时记一笔改之前和改之后（每份 20 笔），能看、能退回。
// - board-new：在文档目录里建一块空白板。board-png：白板导出的图存在白板旁边。board-library-read / -write：白板的素材库，各块白板共用。
// - design-new：在文档目录里建一份空设计（.design，uttu-scriptorium-design.js）。它也是文本，走同样的 read、save。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { kindOf } = require('../scriptoriumTypes');
const { replaceWith } = require('../atomicReplace');
const { allowed } = require('../scriptoriumFiles');
const { decodeText, encodeText } = require('../textEncoding');

const MAX_BYTES = { text: 32 * 1024 * 1024, board: 40 * 1024 * 1024, notebook: 64 * 1024 * 1024 };
let deps = null;

async function mustAllow(file, what) {
    const resolved = path.resolve(String(file || ''));
    if (!(await allowed(resolved))) throw new Error(`这个${what}不在工作区、文库、笔记或最近打开里，文坊不打开。`);
    return resolved;
}

// 扩展名没登记的文件打开时问这里：内容是文本就当文本开。
async function looksLikeText(file) {
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_BYTES.text) return false;
    try {
        decodeText(await fs.promises.readFile(file));
        return true;
    } catch (_) {
        return false;
    }
}

async function readText(file) {
    const resolved = await mustAllow(file, '文件');
    const limit = MAX_BYTES[kindOf(resolved)] || MAX_BYTES.text; // 没登记的扩展名：页面先问过 looksLikeText
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile()) throw new Error('找不到这个文件。');
    if (stat.size > limit) throw new Error(`文件太大（超过 ${limit / 1048576} MB），文坊不打开。`);
    const { text, encoding, bom } = decodeText(await fs.promises.readFile(resolved));
    await Promise.resolve(deps?.rememberRecentFile?.(resolved)).catch(() => {});
    return { success: true, filePath: resolved, name: path.basename(resolved), text: text.replace(/\r\n/g, '\n'),
        eol: /\r\n/.test(text) ? 'crlf' : 'lf', encoding, bom, mtime: stat.mtimeMs, size: stat.size };
}

async function writeAtomically(target, data) {
    const temporary = `${target}.uttu-writing-${process.pid}-${Date.now()}`;
    try {
        await fs.promises.writeFile(temporary, data);
        await replaceWith(temporary, target);
    } finally {
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
    }
}

async function saveText(payload, senderId) {
    const resolved = await mustAllow(payload?.file, '文件');
    const stat = await fs.promises.stat(resolved).catch(() => null);
    if (stat && !payload.force && Number.isFinite(payload.mtime) && Math.abs(stat.mtimeMs - payload.mtime) > 1) {
        return { success: false, conflict: true, mtime: stat.mtimeMs };
    }
    let text = String(payload.text ?? '');
    if (payload.eol === 'crlf') text = text.replace(/\r?\n/g, '\r\n');
    await writeAtomically(resolved, encodeText(text, { encoding: payload.encoding, bom: payload.bom }));
    const after = await fs.promises.stat(resolved);
    watchers.get(senderId)?.saved(after.mtimeMs);
    return { success: true, mtime: after.mtimeMs };
}

async function siblingInfo(file, kind) {
    const what = kind === 'image' ? '图片' : '音视频';
    const resolved = await mustAllow(file, what);
    if (kindOf(resolved) !== kind) throw new Error(`这个文件不是${what}。`);
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile()) throw new Error(`找不到这个${what}。`);
    const dir = path.dirname(resolved);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    const siblings = entries.filter((entry) => entry.isFile() && kindOf(entry.name) === kind)
        .map((entry) => path.join(dir, entry.name))
        .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
    await Promise.resolve(deps?.rememberRecentFile?.(resolved)).catch(() => {});
    return { success: true, filePath: resolved, name: path.basename(resolved), size: stat.size, mtime: stat.mtimeMs, siblings };
}

// 每个文坊页面看一份：文件变了（不是自己刚存的）告诉它。编辑器存盘常常是“写临时文件再改名”，所以盯文件夹、按名字过滤。
const watchers = new Map();
function watch(sender, file) {
    const id = sender.id;
    watchers.get(id)?.close();
    watchers.delete(id);
    if (!file) return { success: true };
    const resolved = path.resolve(String(file));
    let own = 0;
    let timer = null;
    let watcher = null;
    const check = async () => {
        const stat = await fs.promises.stat(resolved).catch(() => null);
        if (!stat || Math.abs(stat.mtimeMs - own) <= 1 || sender.isDestroyed()) return;
        own = stat.mtimeMs;
        sender.send('uttu-view:changed', { file: resolved, mtime: stat.mtimeMs });
    };
    try {
        watcher = fs.watch(path.dirname(resolved), (_type, name) => {
            if (name && String(name).toLowerCase() !== path.basename(resolved).toLowerCase()) return;
            clearTimeout(timer);
            timer = setTimeout(() => { void check(); }, 200);
        });
        watcher.on('error', () => {}); // 文件夹被删、改名时不让主进程报错，轮询照常
    } catch (_) {
        watcher = null; // 盯不了：靠下面的轮询
    }
    void fs.promises.stat(resolved).then((stat) => { own = stat.mtimeMs; }).catch(() => {});
    const poll = setInterval(() => { void check(); }, 2000);
    const entry = {
        check,
        saved(mtime) { own = mtime; },
        close() {
            clearTimeout(timer);
            clearInterval(poll);
            try { watcher?.close(); } catch (_) { /* 已关 */ }
        },
    };
    watchers.set(id, entry);
    sender.once('destroyed', () => {
        if (watchers.get(id) === entry) {
            entry.close();
            watchers.delete(id);
        }
    });
    return { success: true };
}

const fileKey = (file) => crypto.createHash('sha1').update(path.resolve(String(file)).toLowerCase()).digest('hex');
const picksDir = () => path.join(deps.dataDir(), 'uttu-picks');
const historyDir = () => path.join(deps.dataDir(), 'uttu-file-history');
const boardLibraryFile = () => path.join(deps.dataDir(), 'uttu-board-library.json');
const readJson = (file) => fs.promises.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
async function writeJson(file, value) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await writeAtomically(file, Buffer.from(JSON.stringify(value), 'utf8'));
}

async function readPicks(file) {
    const saved = await readJson(path.join(picksDir(), `${fileKey(file)}.json`));
    return { success: true, list: Array.isArray(saved?.list) ? saved.list : [] };
}
async function writePicks(file, list) {
    await writeJson(path.join(picksDir(), `${fileKey(file)}.json`), { file: path.resolve(String(file)), list: Array.isArray(list) ? list : [] });
    return { success: true };
}
const EMPTY_BOARD = `${JSON.stringify({ type: 'excalidraw', version: 2, source: 'uttu-scriptorium', elements: [], appState: {}, files: {} }, null, 2)}\n`;
function freePath(dir, base, extension) {
    for (let index = 0; index < 1000; index += 1) {
        const candidate = path.join(dir, `${base}${index ? ` (${index})` : ''}${extension}`);
        if (!fs.existsSync(candidate)) return candidate;
    }
    throw new Error('没能分配文件名。');
}
async function newBoard() {
    const dir = path.join(deps.libraryDir(), 'Boards');
    await fs.promises.mkdir(dir, { recursive: true });
    const file = freePath(dir, '未命名白板', '.excalidraw');
    await writeAtomically(file, Buffer.from(EMPTY_BOARD, 'utf8'));
    await Promise.resolve(deps?.rememberRecentFile?.(file)).catch(() => {});
    return { success: true, filePath: file };
}
async function newDesign() {
    const dir = path.join(deps.libraryDir(), 'Designs');
    await fs.promises.mkdir(dir, { recursive: true });
    const file = freePath(dir, '未命名设计', '.design');
    await writeAtomically(file, Buffer.from(`${JSON.stringify({ version: 1, frames: [] }, null, 2)}\n`, 'utf8'));
    await Promise.resolve(deps?.rememberRecentFile?.(file)).catch(() => {});
    return { success: true, filePath: file };
}
async function boardPng({ file, base64 }) {
    const resolved = await mustAllow(file, '文件');
    if (kindOf(resolved) !== 'board') throw new Error('这个文件不是白板。');
    const target = freePath(path.dirname(resolved), path.basename(resolved, path.extname(resolved)), '.png');
    await writeAtomically(target, Buffer.from(String(base64 || ''), 'base64'));
    return { success: true, filePath: target };
}

// 窗口里的一块存成 PNG。最宽 1600：够模型看清，也不让对话附件太大。
async function crop(sender, rect) {
    const area = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
    let image = await sender.capturePage(area);
    const size = image.getSize();
    if (size.width > 1600) image = image.resize({ width: 1600 });
    const file = path.join(picksDir(), 'crops', `${crypto.randomUUID()}.png`);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, image.toPNG());
    return { success: true, path: file, ...image.getSize() };
}

const MAX_HISTORY = 20;
const MAX_HISTORY_CHARS = 2 * 1024 * 1024;
const historyFile = (file) => path.join(historyDir(), `${fileKey(file)}.json`);
async function historyList(file) {
    const saved = await readJson(historyFile(file));
    return { success: true, list: Array.isArray(saved?.list) ? saved.list : [] };
}
async function historyAdd({ file, before, after }) {
    if (typeof before !== 'string' || typeof after !== 'string' || before === after) return { success: true };
    if (before.length + after.length > MAX_HISTORY_CHARS) return { success: true };
    const { list } = await historyList(file);
    list.unshift({ id: crypto.randomUUID(), at: Date.now(), before, after });
    await writeJson(historyFile(file), { file: path.resolve(String(file)), list: list.slice(0, MAX_HISTORY) });
    return { success: true };
}
async function historyRestore({ file, id }) {
    const resolved = await mustAllow(file, '文件');
    const { list } = await historyList(resolved);
    const entry = list.find((item) => item.id === id);
    if (!entry) throw new Error('这一笔记录已经没有了。');
    const current = await fs.promises.readFile(resolved).catch(() => Buffer.alloc(0));
    const crlf = current.includes('\r\n');
    const format = (() => { try { return decodeText(current); } catch (_) { return { encoding: 'utf-8', bom: false }; } })();
    await writeAtomically(resolved, encodeText(crlf ? entry.before.replace(/\r?\n/g, '\r\n') : entry.before, format));
    return { success: true };
}

function register(ipcMain, value) {
    deps = value;
    ipcMain.handle('uttu-view:act', async (event, payload = {}) => {
        try {
            switch (payload.command) {
                case 'read': return await readText(payload.file);
                case 'save': return await saveText(payload, event.sender.id);
                case 'image': return await siblingInfo(payload.file, 'image');
                case 'media': return await siblingInfo(payload.file, 'media');
                case 'watch': return watch(event.sender, payload.file);
                case 'check': await watchers.get(event.sender.id)?.check(); return { success: true };
                case 'picks-read': return await readPicks(payload.file);
                case 'picks-write': return await writePicks(payload.file, payload.list);
                case 'crop': return await crop(event.sender, payload.rect);
                case 'board-new': return await newBoard();
                case 'design-new': return await newDesign();
                case 'board-png': return await boardPng(payload);
                case 'board-library-read': return { success: true, items: (await readJson(boardLibraryFile()))?.items || [] };
                case 'board-library-write': await writeJson(boardLibraryFile(), { items: Array.isArray(payload.items) ? payload.items : [] }); return { success: true };
                case 'history-add': return await historyAdd(payload);
                case 'history-list': return await historyList(payload.file);
                case 'history-restore': return await historyRestore(payload);
                default: return { success: false, error: '不认识的操作。' };
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = { register, looksLikeText };
