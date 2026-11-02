'use strict';
// 文坊中的 PDF。页面用 pdf.js 绘制（vendor/pdfjs），修改先在页面中累积；这里负责读取、写入（edit.js 使用 pdf-lib）和签名的存取。
// 通信名 scriptorium:pdf，命令如下：
// - read：读取 PDF（字节、指纹、表单字段、是否有中文字体），先经过 fileAccess.allowed。
//   读过的路径记在该页面名下，之后只允许保存到这些路径（页面传来的其他路径不写）。
// - save：按页面送来的计划写入。保存回原文件前先比对指纹（打开后磁盘上被别处修改过则不写，返回 conflict: true）；
//   原文件先备份到 AppData/Scriptorium/scriptorium-pdf-backup（每份文件保留最近 10 版）；先写临时文件再一步替换。
//   saveAs：弹出另存为，写入新文件，原文件不变。
// - pick：选择一个或多个 PDF 合并进来（只认对话框选中的），返回字节供页面绘制缩略图。
// - split：拆分为多份：选择文件夹，按页面送来的计划各写一个新 PDF（重名时加序号，不覆盖），原文件不变。
// - draft：将页面从 PDF 中提取的 Markdown 初稿另存为 .md，扫描页的图片写入旁边的 assets/。
// - stat：修改时间和大小（窗口重新获得焦点时比对，外部修改后重新读取）。
// - signatures / signature-save / signature-delete：手写签名保存为 PNG，放在 AppData/Scriptorium/scriptorium-signatures 供以后使用。
const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
// pdf-lib 和 fontkit 共 1.3 MB，只在打开 PDF 时加载。
let editModule = null;
const loadEdit = async () => editModule ??= require('./edit');

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
    if (stat.size > MAX_BYTES) throw new Error('PDF 超过 200 MB，文坊不打开，请使用默认程序打开。');
    // 只认 fileAccess 允许的路径：文库、最近打开，以及主进程交给文坊的文件（打开对话框、拖放、Agent 请求）。
    if (!(await require('../fileAccess').allowed(resolved))) throw new Error('这份 PDF 不在文库或最近打开的文件中，文坊不打开。');
    const bytes = await fs.readFile(resolved);
    allow(sender, resolved);
    keepCopy(fingerprint(bytes), bytes);
    await Promise.resolve(deps?.rememberRecentFile?.(resolved)).catch(() => {});
    return {
        success: true, filePath: resolved, name: path.basename(resolved), bytes: new Uint8Array(bytes), fingerprint: fingerprint(bytes),
        size: stat.size, mtime: stat.mtimeMs, fields: await (await loadEdit()).fieldsOf(bytes), cjkFont: Boolean(require('./fonts').cjkFont()),
    };
}

const backupDir = () => path.join(deps.dataDir(), 'scriptorium-pdf-backup');
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
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.scriptorium-saving-${process.pid}-${Date.now()}`);
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
    if (!isPdf(file) || !allowed(sender, file)) throw new Error('只能保存本页面打开的 PDF。');
    const current = await fs.readFile(file).catch(() => null);
    if (!current) throw new Error('磁盘上已找不到这份 PDF（已被删除或移走），请使用“另存为”保存。');
    const changed = Boolean(payload.fingerprint) && fingerprint(current) !== payload.fingerprint;
    if (!payload.saveAs && !payload.force && changed) {
        // 不抛错：页面要分得清“冲突”和别的失败（抛出去的错过了 IPC 只剩一句话）。
        return { success: false, conflict: true, error: '这份 PDF 在打开后已被别处修改，未覆盖。请重新载入，或另存为新文件。' };
    }
    const readSource = async (source) => {
        if (!allowed(sender, source)) throw new Error('要合并的 PDF 未经文件选择对话框选择，不予处理。');
        return fs.readFile(source);
    };
    const base = changed ? await baseOf(file, payload.fingerprint) : current;
    const out = Buffer.from(await (await loadEdit()).apply(base, payload.plan || {}, { readSource }));
    let target = file;
    if (payload.saveAs) {
        const result = await deps.dialog.showSaveDialog(deps.ownerOf?.(event), {
            title: '另存为', defaultPath: payload.defaultPath || file.replace(/\.pdf$/i, '（修改）.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }],
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
    if (!copy) throw new Error('打开时的版本已不存在，请重新载入后再修改。');
    return copy;
}
async function freeName(dir, name) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let k = 0; k < 1000; k += 1) {
        const candidate = path.join(dir, k ? `${stem} (${k + 1})${ext}` : name);
        if (!(await fs.pathExists(candidate))) return candidate;
    }
    throw new Error('同名文件过多。');
}
const cleanName = (name, fallback) => String(name || fallback).replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 120) || fallback;

async function split(event, payload = {}) {
    const sender = event.sender;
    const file = path.resolve(String(payload.path || ''));
    if (!isPdf(file) || !allowed(sender, file)) throw new Error('只能拆分本页面打开的 PDF。');
    const parts = Array.isArray(payload.parts) ? payload.parts.slice(0, 500) : [];
    if (!parts.length) throw new Error('没有需要拆分的页面。');
    const result = await deps.dialog.showOpenDialog(deps.ownerOf?.(event), {
        title: `拆成 ${parts.length} 份，选择保存位置`, defaultPath: path.dirname(file), properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.length) return { success: false, canceled: true };
    const folder = path.resolve(result.filePaths[0]);
    const base = await baseOf(file, payload.fingerprint);
    const readSource = async (source) => {
        if (!allowed(sender, source)) throw new Error('要合并的 PDF 未经文件选择对话框选择，不予处理。');
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
    if (!text.trim()) throw new Error('未能从这份 PDF 中提取文字。');
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('提取的文字过多（超过 8 MB）。');
    const result = await deps.dialog.showSaveDialog(deps.ownerOf?.(event), {
        title: '导出为 Markdown 初稿', defaultPath: payload.defaultPath, filters: [{ name: 'Markdown', extensions: ['md'] }],
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
    require('../fileAccess').grant(target);
    await Promise.resolve(deps?.rememberRecentFile?.(target)).catch(() => {});
    return { success: true, filePath: target };
}

async function pick(event) {
    const result = await deps.dialog.showOpenDialog(deps.ownerOf?.(event), {
        title: '选择要合并的 PDF', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }],
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

const signDir = () => path.join(deps.dataDir(), 'scriptorium-signatures');
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
    if (bytes.length > 2 * 1024 * 1024) throw new Error('签名图片过大。');
    await fs.ensureDir(signDir());
    const id = `${Date.now()}.png`;
    await fs.writeFile(path.join(signDir(), id), bytes);
    return { id };
}
async function deleteSignature({ id } = {}) {
    if (!/^\d+\.png$/.test(String(id || ''))) throw new Error('无法识别的签名。');
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
        default: throw new Error(`未知的 PDF 操作：${payload.command}`);
    }
}

function register(ipcMain, value) {
    deps = value;
    ipcMain.removeHandler('scriptorium:pdf');
    ipcMain.handle('scriptorium:pdf', (event, payload) => act(event, payload));
}

module.exports = { register, isPdf, _act: act };
