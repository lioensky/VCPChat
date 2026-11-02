'use strict';
// 文坊里的 PDF。
// 页面用 pdf.js 画（vendor/pdfjs），改动在页面里攒着；这里负责读、写（edit.js 用 pdf-lib）、签名的存取。一个通道 uttu-pdf:act。
// - read：读这份 PDF（字节、指纹、表单字段、有没有中文字体）。先过 scriptoriumFiles.allowed（工作区、文库、笔记、最近打开，和主进程自己交给文坊的）。
//   读过的路径记在这个页面名下，之后只许往这些路径存（页面递来的陌生路径不写）。
// - save：按页面送来的计划写。存回原文件前先比指纹（打开后磁盘上被别处改过就不写，回 conflict: true）；原样先留一份在 AppData/Scriptorium/uttu-pdf-backup
//   （每份文件最近 10 版）；写的时候先写临时文件再一步替换（atomicReplace）。saveAs：弹另存为，写新文件，原文件不动。
// - pick：选一个或几个 PDF 并进来（对话框选的才认），回字节给页面画缩略图。
// - split：拆成几份：选一个文件夹，按页面送来的几份计划各写一个新 PDF（重名就加序号，不覆盖），原文件不动。
// - draft：给“交给 Agent 重建”用：页面从 PDF 里抽出的 Markdown 初稿，弹另存为写成 .md，扫描页的图写进旁边的 assets/。
// - stat：修改时间和大小（切回窗口时比一比，外面改了就重新读）。
// - signatures / signature-save / signature-delete：手写签名存成 PNG 放 AppData/Scriptorium/uttu-signatures，以后直接用。
// 接入：docxHandlers 一行 register；preloads/docx.js 的 scriptorium.pdf。
const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
const { withWarmModules } = require('../../services/moduleFilePrefetch');
// pdf-lib 和 fontkit 共 1.3 MB，只有开 PDF 才用，文坊第一次打开不加载（冷的时候要等约 1.4 秒）。
let editModule = null;
const loadEdit = async () => editModule ??= await withWarmModules('pdf-lib', () => require('./edit'));

let deps = null;
const opened = new Map(); // contents.id → Set(可以写的路径)
const keyOf = (file) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));
const fingerprint = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const isPdf = (file) => /\.pdf$/i.test(String(file || ''));
const MAX_BYTES = 200 * 1024 * 1024;
// 页面读过的原样（按指纹）：磁盘上的文件后来被别处改了，另存为时照页面打开的那一版改，不拿改过的去套页面的计划。只留最近几份。
const readCopies = new Map();
function keepCopy(hash, bytes) {
    readCopies.delete(hash);
    readCopies.set(hash, bytes);
    while (readCopies.size > 6) readCopies.delete(readCopies.keys().next().value);
}

function allow(sender, file) {
    if (!opened.has(sender.id)) {
        opened.set(sender.id, new Set());
        sender.once?.('destroyed', () => opened.delete(sender.id));
    }
    opened.get(sender.id).add(keyOf(file));
}
const allowed = (sender, file) => Boolean(opened.get(sender.id)?.has(keyOf(file)));

async function read(sender, file) {
    if (!isPdf(file) || !path.isAbsolute(String(file))) throw new Error('不是 PDF 文件。');
    const resolved = path.resolve(file);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isFile()) throw new Error(`找不到这份 PDF：${resolved}`);
    if (stat.size > MAX_BYTES) throw new Error('PDF 超过 200 MB，文坊不打开；可以用默认程序打开。');
    // 主进程只认工作区、文库、笔记、最近打开里的路径，和主进程自己交给文坊的（打开对话框、拖进来、Agent 要开的，scriptoriumFiles.grant）。
    if (!(await require('../scriptoriumFiles').allowed(resolved))) throw new Error('这份 PDF 不在工作区、文库、笔记或最近打开里，文坊不打开。');
    const bytes = await fs.readFile(resolved);
    allow(sender, resolved);
    keepCopy(fingerprint(bytes), bytes);
    await Promise.resolve(deps?.rememberRecentFile?.(resolved)).catch(() => {});
    return {
        success: true, filePath: resolved, name: path.basename(resolved), bytes: new Uint8Array(bytes), fingerprint: fingerprint(bytes),
        size: stat.size, mtime: stat.mtimeMs, fields: await (await loadEdit()).fieldsOf(bytes), cjkFont: Boolean(require('./fonts').cjkFont()),
    };
}

const backupDir = () => path.join(deps.dataDir(), 'uttu-pdf-backup');
async function backup(file, bytes) {
    const dir = backupDir();
    await fs.ensureDir(dir);
    const tag = crypto.createHash('sha1').update(keyOf(file)).digest('hex').slice(0, 12);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, `${tag}-${stamp}-${path.basename(file)}`);
    await fs.writeFile(target, bytes);
    const mine = (await fs.readdir(dir)).filter((name) => name.startsWith(`${tag}-`)).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - 10))) await fs.remove(path.join(dir, old)).catch(() => {});
    return target;
}

async function writeAtomically(target, bytes) {
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.uttu-saving-${process.pid}-${Date.now()}`);
    try {
        await fs.writeFile(temporary, bytes);
        await require('../atomicReplace').replaceWith(temporary, target);
    } finally {
        await fs.remove(temporary).catch(() => {});
    }
}

async function save(event, payload = {}) {
    const sender = event.sender;
    const file = path.resolve(String(payload.path || ''));
    if (!isPdf(file) || !allowed(sender, file)) throw new Error('只能存这个页面打开过的 PDF。');
    const current = await fs.readFile(file).catch(() => null);
    if (!current) throw new Error('磁盘上找不到这份 PDF 了（被删了或挪走了），用“另存为”存一份。');
    const changed = Boolean(payload.fingerprint) && fingerprint(current) !== payload.fingerprint;
    if (!payload.saveAs && !payload.force && changed) {
        // 不抛错：页面要分得清“冲突”和别的失败（抛出去的错过了 IPC 只剩一句话）。
        return { success: false, conflict: true, error: '这份 PDF 打开后在别处被改过了，没有覆盖。要么重新载入，要么另存为一份。' };
    }
    const readSource = async (source) => {
        if (!allowed(sender, source)) throw new Error('并进来的 PDF 没经过选文件，不认。');
        return fs.readFile(source);
    };
    const base = changed ? await baseOf(file, payload.fingerprint) : current;
    const out = Buffer.from(await (await loadEdit()).apply(base, payload.plan || {}, { readSource }));
    let target = file;
    if (payload.saveAs) {
        const result = await deps.dialog.showSaveDialog(deps.ownerOf?.(event), {
            title: '另存为', defaultPath: payload.defaultPath || file.replace(/\.pdf$/i, ' 改.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
        if (result.canceled || !result.filePath) return { success: false, canceled: true };
        target = isPdf(result.filePath) ? path.resolve(result.filePath) : `${path.resolve(result.filePath)}.pdf`;
    } else {
        await backup(file, current);
    }
    await writeAtomically(target, out);
    allow(sender, target);
    const stat = await fs.stat(target);
    return { success: true, filePath: target, fingerprint: fingerprint(out), mtime: stat.mtimeMs, size: stat.size };
}

// 计划是照页面打开的那一版排的：磁盘上的变了就用那一版的原样（另存为、拆分都一样）。
async function baseOf(file, hash) {
    const current = await fs.readFile(file).catch(() => null);
    if (current && (!hash || fingerprint(current) === hash)) return current;
    const copy = hash && readCopies.get(hash);
    if (!copy) throw new Error('打开时的那一版已经不在了，重新载入后再改。');
    return copy;
}
async function freeName(dir, name) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let k = 0; k < 1000; k += 1) {
        const candidate = path.join(dir, k ? `${stem} (${k + 1})${ext}` : name);
        if (!(await fs.pathExists(candidate))) return candidate;
    }
    throw new Error('同名的太多了。');
}
const cleanName = (name, fallback) => String(name || fallback).replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 120) || fallback;

async function split(event, payload = {}) {
    const sender = event.sender;
    const file = path.resolve(String(payload.path || ''));
    if (!isPdf(file) || !allowed(sender, file)) throw new Error('只能拆这个页面打开过的 PDF。');
    const parts = Array.isArray(payload.parts) ? payload.parts.slice(0, 500) : [];
    if (!parts.length) throw new Error('没有要拆出来的页。');
    const result = await deps.dialog.showOpenDialog(deps.ownerOf?.(event), {
        title: `拆成 ${parts.length} 份，放到哪个文件夹`, defaultPath: path.dirname(file), properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.length) return { success: false, canceled: true };
    const folder = path.resolve(result.filePaths[0]);
    const base = await baseOf(file, payload.fingerprint);
    const readSource = async (source) => {
        if (!allowed(sender, source)) throw new Error('并进来的 PDF 没经过选文件，不认。');
        return fs.readFile(source);
    };
    const files = [];
    for (const part of parts) {
        const out = Buffer.from(await (await loadEdit()).apply(base, part.plan || {}, { readSource }));
        const name = cleanName(part.name, `${path.basename(file, '.pdf')} 第${files.length + 1}份`).replace(/(\.pdf)?$/i, '.pdf');
        const target = await freeName(folder, name);
        await writeAtomically(target, out);
        allow(sender, target);
        files.push(target);
    }
    return { success: true, folder, files };
}

async function draft(event, payload = {}) {
    const text = String(payload.text || '');
    if (!text.trim()) throw new Error('这份 PDF 里没抽出字。');
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('抽出来的字太多了（超过 8 MB）。');
    const result = await deps.dialog.showSaveDialog(deps.ownerOf?.(event), {
        title: '重建成 Markdown：先存一份初稿', defaultPath: payload.defaultPath, filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    const target = /\.(md|markdown)$/i.test(result.filePath) ? path.resolve(result.filePath) : `${path.resolve(result.filePath)}.md`;
    const images = Array.isArray(payload.images) ? payload.images.slice(0, 300) : [];
    if (images.length) {
        const dir = path.join(path.dirname(target), 'assets');
        await fs.ensureDir(dir);
        for (const image of images) {
            const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(image.data || ''));
            const name = cleanName(image.name, 'page.png');
            if (!match || path.basename(name) !== name || !/\.(png|jpe?g)$/i.test(name)) continue;
            await fs.writeFile(path.join(dir, name), Buffer.from(match[2], 'base64'));
        }
    }
    await writeAtomically(target, Buffer.from(text, 'utf8'));
    require('../scriptoriumFiles').grant(target);
    await Promise.resolve(deps?.rememberRecentFile?.(target)).catch(() => {});
    return { success: true, filePath: target };
}

async function pick(event) {
    const result = await deps.dialog.showOpenDialog(deps.ownerOf?.(event), {
        title: '选要并进来的 PDF', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePaths?.length) return { files: [] };
    const files = [];
    for (const file of result.filePaths) {
        const bytes = await fs.readFile(file);
        allow(event.sender, file);
        files.push({ path: path.resolve(file), name: path.basename(file), bytes: new Uint8Array(bytes) });
    }
    return { files };
}

const signDir = () => path.join(deps.dataDir(), 'uttu-signatures');
async function signatures() {
    const dir = signDir();
    const names = (await fs.readdir(dir).catch(() => [])).filter((name) => /\.png$/i.test(name)).sort().reverse();
    const list = [];
    for (const name of names.slice(0, 12)) list.push({ id: name, data: `data:image/png;base64,${(await fs.readFile(path.join(dir, name))).toString('base64')}` });
    return { signatures: list };
}
async function saveSignature({ data } = {}) {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
    if (!match) throw new Error('签名不是图片。');
    const bytes = Buffer.from(match[1], 'base64');
    if (bytes.length > 2 * 1024 * 1024) throw new Error('签名图太大了。');
    await fs.ensureDir(signDir());
    const id = `${Date.now()}.png`;
    await fs.writeFile(path.join(signDir(), id), bytes);
    return { id };
}
async function deleteSignature({ id } = {}) {
    if (!/^\d+\.png$/.test(String(id || ''))) throw new Error('不认识的签名。');
    await fs.remove(path.join(signDir(), id));
    return { ok: true };
}

async function act(event, payload = {}) {
    switch (payload.command) {
        case 'read': return read(event.sender, payload.path);
        case 'save': return save(event, payload);
        case 'pick': return pick(event);
        case 'split': return split(event, payload);
        case 'draft': return draft(event, payload);
        case 'stat': {
            const stat = await fs.stat(path.resolve(String(payload.path || ''))).catch(() => null);
            return stat ? { mtime: stat.mtimeMs, size: stat.size } : { missing: true };
        }
        case 'signatures': return signatures();
        case 'signature-save': return saveSignature(payload);
        case 'signature-delete': return deleteSignature(payload);
        default: throw new Error(`不认识的 PDF 操作：${payload.command}`);
    }
}

function register(ipcMain, value) {
    deps = value;
    ipcMain.removeHandler('uttu-pdf:act');
    ipcMain.handle('uttu-pdf:act', (event, payload) => act(event, payload));
}

module.exports = { register, isPdf, _act: act };
