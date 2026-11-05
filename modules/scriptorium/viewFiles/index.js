'use strict';
// 文坊中的文本、代码、图片和白板。通信名 scriptorium:view，所有命令先经过 fileAccess.allowed。
// - read：按原样读取文本（UTF-8、UTF-16、GB18030，见 textEncoding.js），含 NUL 的视为二进制不打开，上限 32 MB。
//   白板（.excalidraw，ScriptoriumModules/scriptorium-board.js）同样是文本，走同样的 read、save；其中可嵌入图片，上限 40 MB。
//   换行统一为 \n，原来的换行、编码和 BOM 记录下来，保存时还原。扩展名未登记的文件也会尝试按文本读取（looksLikeText）。
// - save：先写临时文件再一步替换；修改时间不一致时返回 conflict，由页面询问保留哪一边，force 时照常保存。
// - image：图片的大小和修改时间，以及同一文件夹内的其他图片（用于上一张、下一张）。
// - watch / check：监视正在显示的那份（文件夹通知加 2 秒轮询），外部修改后发送 scriptorium:view-changed。
// - board-new：在文库的 Boards 文件夹中新建一个空白板。board-library-read / -write：白板的素材库，保存在 AppData/Scriptorium。
const fs = require('fs');
const path = require('path');
const { kindOf } = require('../fileTypes');
const { replaceWith } = require('../atomicReplace');
const { allowed } = require('../fileAccess');
const { decodeText, encodeText } = require('../textEncoding');

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_BOARD_BYTES = 40 * 1024 * 1024;
let deps = null;

async function mustAllow(file, what) {
    const resolved = path.resolve(String(file || ''));
    if (!(await allowed(resolved))) throw new Error(`这个${what}不在文库或最近打开的文件中，文坊不打开。`);
    return resolved;
}

// 扩展名未登记的文件：内容是文本时按文本打开。
async function looksLikeText(file) {
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_BYTES) return false;
    try {
        decodeText(await fs.promises.readFile(file));
        return true;
    } catch (_) {
        return false;
    }
}

async function readText(file) {
    const resolved = await mustAllow(file, '文件');
    const limit = kindOf(resolved) === 'board' ? MAX_BOARD_BYTES : MAX_BYTES;
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile()) throw new Error('找不到这个文件。');
    if (stat.size > limit) throw new Error(`文件超过 ${limit / 1048576} MB，文坊不打开。`);
    const { text, encoding, bom } = decodeText(await fs.promises.readFile(resolved));
    await Promise.resolve(deps?.rememberRecentFile?.(resolved)).catch(() => {});
    return { success: true, filePath: resolved, name: path.basename(resolved), text: text.replace(/\r\n/g, '\n'),
        eol: /\r\n/.test(text) ? 'crlf' : 'lf', encoding, bom, mtime: stat.mtimeMs, size: stat.size };
}

async function writeAtomically(target, data) {
    const temporary = `${target}.scriptorium-writing-${process.pid}-${Date.now()}`;
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
    const bytes = encodeText(text, { encoding: payload.encoding, bom: payload.bom });
    if (kindOf(resolved) === 'board') {
        boardBytes(text);
        if (bytes.length > MAX_BOARD_BYTES) throw new Error('白板及文脉超过 40 MB，未覆盖原文件。');
    }
    await writeAtomically(resolved, bytes);
    const after = await fs.promises.stat(resolved);
    watchers.get(senderId)?.saved(after.mtimeMs);
    return { success: true, mtime: after.mtimeMs };
}

async function imageInfo(file) {
    const kind = 'image';
    const what = '图片';
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

// 每个文坊页面监视一份文件：文件变化（并非本页面刚保存的）时通知它。编辑器保存时常先写临时文件再改名，所以监视所在文件夹、按文件名过滤。
const watchers = new Map();
async function watch(sender, file) {
    const id = sender.id;
    watchers.get(id)?.close();
    watchers.delete(id);
    if (!file) return { success: true };
    const resolved = await mustAllow(file, '文件');
    let own = 0;
    let timer = null;
    let watcher = null;
    const check = async () => {
        const stat = await fs.promises.stat(resolved).catch(() => null);
        if (!stat || Math.abs(stat.mtimeMs - own) <= 1 || sender.isDestroyed()) return;
        own = stat.mtimeMs;
        sender.send('scriptorium:view-changed', { file: resolved, mtime: stat.mtimeMs });
    };
    try {
        watcher = fs.watch(path.dirname(resolved), (_type, name) => {
            if (name && String(name).toLowerCase() !== path.basename(resolved).toLowerCase()) return;
            clearTimeout(timer);
            timer = setTimeout(() => { void check(); }, 200);
        });
        watcher.on('error', () => {}); // 文件夹被删除、改名时不报错，轮询照常进行
    } catch (_) {
        watcher = null; // 无法监视时依靠轮询
    }
    void fs.promises.stat(resolved).then((stat) => { own = stat.mtimeMs; }).catch(() => {});
    const poll = setInterval(() => { void check(); }, 2000);
    const entry = {
        check,
        saved(mtime) { own = mtime; },
        close() {
            clearTimeout(timer);
            clearInterval(poll);
            try { watcher?.close(); } catch (_) { /* 已关闭 */ }
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

const boardLibraryFile = () => path.join(deps.dataDir(), 'scriptorium-board-library.json');
const readJson = (file) => fs.promises.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
async function writeJson(file, value) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await writeAtomically(file, Buffer.from(JSON.stringify(value), 'utf8'));
}
const EMPTY_BOARD = `${JSON.stringify({ type: 'excalidraw', version: 2, source: 'vcp-scriptorium', elements: [], appState: {}, files: {} }, null, 2)}\n`;
function freePath(dir, base, extension) {
    for (let index = 0; index < 1000; index += 1) {
        const candidate = path.join(dir, `${base}${index ? ` (${index})` : ''}${extension}`);
        if (!fs.existsSync(candidate)) return candidate;
    }
    throw new Error('未能分配文件名。');
}
function boardBytes(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const data = JSON.parse(text);
    if (data?.type !== 'excalidraw' || !Array.isArray(data.elements)) throw new Error('不是有效的 Excalidraw 白板。');
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_BOARD_BYTES) throw new Error('白板超过 40 MB。');
    return bytes;
}
function boardName(value) {
    const base = String(value || '未命名白板').replace(/\.excalidraw$/i, '').trim();
    if (!base || /[<>:"/\\|?*\u0000-\u001f]/.test(base) || /[. ]$/.test(base)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) throw new Error('白板名称包含无效字符。');
    return base;
}
async function newBoard(payload = {}) {
    const bytes = boardBytes(payload.scene ?? EMPTY_BOARD);
    const base = boardName(payload.name || payload.title);
    const dir = path.join(deps.libraryDir(), 'Boards');
    await fs.promises.mkdir(dir, { recursive: true });
    // 独占创建避免并发新建覆盖同名文件。
    for (let index = 0; index < 1000; index += 1) {
        const file = path.join(dir, `${base}${index ? ` (${index})` : ''}.excalidraw`);
        try {
            await fs.promises.writeFile(file, bytes, { flag: 'wx' });
        } catch (error) {
            if (error.code === 'EEXIST') continue;
            throw error;
        }
        await Promise.resolve(deps?.rememberRecentFile?.(file)).catch(() => {});
        const stat = await fs.promises.stat(file);
        return { success: true, filePath: file, name: path.basename(file), mtime: stat.mtimeMs };
    }
    throw new Error('未能分配白板名称。');
}
async function saveBoardAs(payload, event) {
    const source = await mustAllow(payload.file, '白板');
    if (kindOf(source) !== 'board') throw new Error('只能另存白板。');
    const bytes = boardBytes(payload.text);
    const result = await deps.dialog.showSaveDialog(deps.ownerOf(event), {
        title: '白板另存为',
        defaultPath: source,
        filters: [{ name: 'Excalidraw 白板', extensions: ['excalidraw'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    const target = /\.excalidraw$/i.test(result.filePath) ? result.filePath : `${result.filePath}.excalidraw`;
    await writeAtomically(target, bytes);
    await deps.rememberRecentFile(target);
    const stat = await fs.promises.stat(target);
    return { success: true, filePath: target, name: path.basename(target), mtime: stat.mtimeMs };
}

function register(ipcMain, value) {
    deps = value;
    ipcMain.removeHandler('scriptorium:view');
    ipcMain.handle('scriptorium:view', async (event, payload = {}) => {
        try {
            switch (payload.command) {
                case 'read': return await readText(payload.file);
                case 'save': return await saveText(payload, event.sender.id);
                case 'image': return await imageInfo(payload.file);
                case 'watch': return await watch(event.sender, payload.file);
                case 'check': await watchers.get(event.sender.id)?.check(); return { success: true };
                case 'board-html-page': {
                    const html = String(payload.html || '');
                    if (Buffer.byteLength(html) > 600 * 1024) throw new Error('节点页面过大。');
                    return { success: true, url: require('../webPages').createInlinePage(event.sender, html) };
                }
                case 'board-html-release':
                    require('../webPages').removeInlinePage(event.sender, payload.url);
                    return { success: true };
                case 'board-new': return await newBoard(payload);
                case 'board-save-as': return await saveBoardAs(payload, event);
                case 'board-rename': {
                    const source = await mustAllow(payload.file, '白板');
                    if (kindOf(source) !== 'board') throw new Error('只能重命名白板。');
                    const target = path.join(path.dirname(source), `${boardName(payload.name)}.excalidraw`);
                    if (target === source) return { success: true, filePath: source, name: path.basename(source) };
                    const stat = await fs.promises.stat(source);
                    if (Math.abs(stat.mtimeMs - Number(payload.mtime)) > 1) throw new Error('文件已在别处修改，请重新读取后改名。');
                    await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
                    try { await fs.promises.unlink(source); }
                    catch (error) { await fs.promises.rm(target, { force: true }).catch(() => {}); throw error; }
                    await deps.rememberRecentFile(target);
                    return { success: true, filePath: target, name: path.basename(target), mtime: (await fs.promises.stat(target)).mtimeMs };
                }
                case 'board-reveal': {
                    const target = await mustAllow(payload.file, '白板');
                    deps.shell.showItemInFolder(target);
                    return { success: true };
                }
                case 'board-library-read': return { success: true, items: (await readJson(boardLibraryFile()))?.items || [] };
                case 'board-library-write': await writeJson(boardLibraryFile(), { items: Array.isArray(payload.items) ? payload.items : [] }); return { success: true };
                default: return { success: false, error: '未知的操作。' };
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = { register, looksLikeText };
