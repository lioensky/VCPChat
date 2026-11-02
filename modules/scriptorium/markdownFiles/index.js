'use strict';
/* 文坊原位打开、保存 Markdown 文件。
   - 打开：把原文包成一份只在内存里的文稿工程交给文坊，工程的路径就是这份 .md，文坊照常显示和编辑；
   - 保存：从工程里取出正文，按打开时的编码、换行（CRLF / LF / CR）和 BOM 还原，先写同一文件夹里的临时文件再替换原文件；
     打开后磁盘上的文件被别处改过时不覆盖，提示用户选择保留哪一边。
   文坊在内存里的换行一律是 \n，原来的编码和换行记在工程的 manifest.markdownFile 里。原文件旁边不放任何文件。
   “导入”仍按原来的流程新建工程。 */
const crypto = require('crypto');
const path = require('path');
const vm = require('vm');
const nativeFs = require('node:fs');
const fs = require('fs-extra');
const JSZip = require('jszip');
const { decodeText, encodeText } = require('../textEncoding');
const { replaceWith } = require('../atomicReplace');

const EXTENSIONS = new Set(['.md', '.markdown']);
const MAX_BYTES = 20 * 1024 * 1024;
const CONTAINER = Object.freeze({
    format: 'vcp-vdoc-container',
    version: 2,
    manifestEntry: 'manifest.json',
    sourceEntry: 'source/document.md',
    styleEntry: 'source/document.css',
    checkpointsEntry: 'lineage/checkpoints.json',
});

// 文稿的默认样式取自页面使用的 vdoc-core.js，和新建文稿、导入 Markdown 时一致。
let defaultCss = null;
function documentCss() {
    if (defaultCss !== null) return defaultCss;
    const sandbox = { console };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(nativeFs.readFileSync(path.join(__dirname, '..', '..', '..', 'ScriptoriumModules', 'vdoc-core.js'), 'utf8'), sandbox);
    defaultCss = String(sandbox.VDocCore.createDocument().source.documentCss || '');
    return defaultCss;
}

// 每份文件最后一次读到或写下的内容指纹，按页面分开记录：保存前与磁盘比对，不同即为别处修改过。
// 没有页面的调用（测试、转工程）使用全局记录。
const known = new Map();
const seen = new Map(); // contents.id → Map(文件 → 指纹)
const keyOf = (filePath) => (process.platform === 'win32' ? filePath.toLowerCase() : filePath);
const fingerprint = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function remember(sender, key, print) {
    known.set(key, print);
    if (!sender || typeof sender.id !== 'number') return;
    if (!seen.has(sender.id)) {
        seen.set(sender.id, new Map());
        sender.once?.('destroyed', () => seen.delete(sender.id));
    }
    seen.get(sender.id).set(key, print);
}
const seenBy = (sender, key) => (sender && seen.get(sender.id)?.has(key) ? seen.get(sender.id).get(key) : known.get(key));

function handles(filePath) {
    return typeof filePath === 'string' && EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function decode(bytes) {
    const { text, encoding, bom } = decodeText(bytes);
    const crlf = (text.match(/\r\n/g) || []).length;
    const cr = (text.match(/\r(?!\n)/g) || []).length;
    const lf = (text.match(/\n/g) || []).length - crlf;
    const lineEnding = crlf && crlf >= lf && crlf >= cr ? 'crlf' : cr > lf ? 'cr' : 'lf';
    return { bom, encoding, lineEnding, mixed: [crlf, lf, cr].filter(Boolean).length > 1, text: text.replace(/\r\n?/g, '\n') };
}

function encode(text, { bom = false, encoding = 'utf-8', lineEnding = 'lf' } = {}) {
    const lf = String(text).replace(/\r\n?/g, '\n');
    const body = lineEnding === 'crlf' ? lf.replace(/\n/g, '\r\n') : lineEnding === 'cr' ? lf.replace(/\n/g, '\r') : lf;
    return encodeText(body, { bom, encoding });
}

// 相对路径的图片可读取的范围：文件在 Git 仓库内时为整个仓库，否则为文件所在的文件夹。
async function rootOf(dir) {
    let current = dir;
    for (let depth = 0; depth < 40; depth += 1) {
        if (await fs.pathExists(path.join(current, '.git'))) return current;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return dir;
}

async function pack(filePath, decoded, stat, checkpoints = '[]') {
    const dir = path.dirname(filePath);
    const now = new Date().toISOString();
    const model = {
        format: 'vcp-vdocx',
        version: 2,
        container: CONTAINER,
        manifest: {
            id: `document-${crypto.randomUUID()}`,
            title: path.basename(filePath).replace(/\.[^.]+$/, ''),
            language: 'zh-CN',
            sourceFormat: 'markdown-hybrid',
            createdAt: stat.birthtime ? new Date(stat.birthtime).toISOString() : now,
            modifiedAt: new Date(stat.mtimeMs || Date.now()).toISOString(),
            generator: 'VCP Scriptorium',
            fonts: [],
            resources: [],
            styleDependencies: [],
            embeddedStyles: [],
            programmableDependencies: [],
            scene: { kind: 'flow-document' },
            import: null,
            markdownFile: { bom: decoded.bom, encoding: decoded.encoding, lineEnding: decoded.lineEnding, mixed: decoded.mixed, dir, root: await rootOf(dir) },
        },
        source: { format: 'markdown-hybrid', content: null, documentCss: null, lineEnding: 'lf', deckCss: '', slides: [] },
        checkpoints: null,
    };
    const zip = new JSZip();
    zip.file(CONTAINER.manifestEntry, JSON.stringify(model, null, 2));
    zip.file(CONTAINER.sourceEntry, decoded.text);
    zip.file(CONTAINER.styleEntry, documentCss());
    zip.file(CONTAINER.checkpointsEntry, checkpoints);
    zip.file('mimetype', CONTAINER.format, { compression: 'STORE' });
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 1 } });
}

// 文脉：.md 文件里只存正文，文坊的修改历史（每条带一份快照）另存在 AppData，下次打开同一份时带回。
// 只保留最近 LINEAGE_LIMIT 条、合计 LINEAGE_BYTES 以内。文件移动位置后不再关联。
const LINEAGE_LIMIT = 30;
const LINEAGE_BYTES = 20 * 1024 * 1024;
const lineageFile = (filePath, deps) => path.join(deps.dataDir(), 'scriptorium-markdown-lineage',
    `${crypto.createHash('sha1').update(keyOf(path.resolve(filePath))).digest('hex')}.json`);
async function loadLineage(filePath, deps = {}) {
    const saved = deps.dataDir ? await fs.readJson(lineageFile(filePath, deps)).catch(() => null) : null;
    return Array.isArray(saved?.checkpoints) ? JSON.stringify(saved.checkpoints) : '[]';
}
async function keepLineage(filePath, checkpointsText, deps = {}) {
    if (!deps.dataDir) return;
    let list = [];
    try { list = JSON.parse(typeof checkpointsText === 'string' ? checkpointsText : '[]'); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    list.sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0));
    const kept = [];
    let size = 0;
    for (const record of list) {
        const bytes = Buffer.byteLength(JSON.stringify(record));
        if (kept.length >= LINEAGE_LIMIT || size + bytes > LINEAGE_BYTES) break;
        kept.push(record);
        size += bytes;
    }
    const file = lineageFile(filePath, deps);
    if (!kept.length) {
        await fs.remove(file).catch(() => {});
        return;
    }
    await fs.ensureDir(path.dirname(file));
    await fs.writeJson(file, { path: path.resolve(filePath), savedAt: Date.now(), checkpoints: kept });
}

// 打开一份 .md：返回值与打开 .vdocx 相同（kind 'vdocx'），路径和名称是这份 .md。
async function read(filePath, deps = {}) {
    if (!handles(filePath)) throw new Error('不是 Markdown 文件。');
    const resolved = path.resolve(filePath);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error('目标不是有效文件。');
    if (stat.size > MAX_BYTES) throw new Error('Markdown 文件超过 20 MB，不原位打开；可以使用“导入”。');
    const bytes = await fs.readFile(resolved);
    const decoded = decode(bytes);
    remember(deps.sender, keyOf(resolved), fingerprint(bytes));
    await deps.rememberRecentFile?.(resolved)?.catch?.(() => {});
    return {
        success: true,
        filePath: resolved,
        name: path.basename(resolved),
        kind: 'vdocx',
        markdownFile: true,
        bytes: await pack(resolved, decoded, stat, await loadLineage(resolved, deps)),
        size: stat.size,
        modifiedAt: stat.mtimeMs,
    };
}

async function sourceOf(projectBytes) {
    const zip = await JSZip.loadAsync(Buffer.from(projectBytes || []));
    const manifest = JSON.parse(await zip.file(CONTAINER.manifestEntry).async('string'));
    if (manifest.manifest?.scene?.kind === 'slide-deck') throw new Error('演示不能保存为 Markdown。');
    const source = zip.file(CONTAINER.sourceEntry);
    if (!source) throw new Error('工程里没有正文。');
    const checkpoints = await zip.file(CONTAINER.checkpointsEntry)?.async('string');
    return { text: await source.async('string'), markdownFile: manifest.manifest?.markdownFile || null, checkpoints };
}

// 先写同一文件夹里的临时文件，再一步替换原文件（atomicReplace.js），中途断电不会留下半份文件。
async function replaceFile(target, bytes) {
    await fs.ensureDir(path.dirname(target));
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.scriptorium-saving-${process.pid}-${Date.now()}`);
    try {
        await nativeFs.promises.writeFile(temporary, bytes);
        await replaceWith(temporary, target);
    } finally {
        await nativeFs.promises.rm(temporary, { force: true }).catch(() => {});
    }
}

// 保存一份从 .md 打开的文稿。另存为时可以选择 .md 或 .vdocx（转为文稿工程，按原有流程保存）。
async function save(event, payload = {}, deps = {}) {
    let target = payload.filePath ? path.resolve(payload.filePath) : '';
    const saveAs = Boolean(payload.saveAs);
    if (saveAs) {
        const result = await deps.dialog.showSaveDialog(deps.ownerOf?.(event), {
            title: '另存为',
            defaultPath: target || payload.suggestedName || '未命名.md',
            filters: [
                { name: 'Markdown', extensions: ['md', 'markdown'] },
                { name: '文稿工程（VDOCX）', extensions: ['vdocx'] },
            ],
        });
        if (result.canceled || !result.filePath) return { success: false, canceled: true };
        target = path.resolve(result.filePath);
        if (path.extname(target).toLowerCase() === '.vdocx') return deps.atomicWrite(target, payload.bytes);
        if (!handles(target)) target = `${target}.md`;
    }
    if (!handles(target)) throw new Error('不是 Markdown 文件。');
    const { text, markdownFile, checkpoints } = await sourceOf(payload.bytes);
    if (/vdoc-resource:\/\//i.test(text)) {
        throw new Error('这份 Markdown 中插入了图片或字体，.md 文件无法保存它们。可以另存为文稿工程（.vdocx）。');
    }
    const bytes = encode(text, markdownFile || {});
    const key = keyOf(target);
    const sender = event?.sender;
    if (!saveAs && seenBy(sender, key)) {
        const onDisk = await fs.readFile(target).catch(() => null);
        if (onDisk && fingerprint(onDisk) !== seenBy(sender, key)) {
            notify(sender, { type: 'file-changed', path: target, fromSave: true });
            throw new Error('磁盘上的这份文件在打开后被别处修改过，未覆盖。请在页面顶部的提示中选择保留哪一边。');
        }
    }
    await replaceFile(target, bytes);
    remember(sender, key, fingerprint(bytes)); // 只记在本页面名下：其他页面打开同一份时，它们的监视器会提示已变化
    await keepLineage(target, checkpoints, deps).catch(() => {});
    await deps.rememberRecentFile?.(target)?.catch?.(() => {});
    const stat = await fs.stat(target);
    return { success: true, filePath: target, name: path.basename(target), size: stat.size, modifiedAt: stat.mtimeMs };
}

// 点击 .md 中的链接：网页、邮件交给系统；相对路径的 .md 和 .html / .htm 返回给页面在文坊中打开；
// 其他文件只在资源管理器中显示，不直接运行。
async function openLink(payload = {}, deps = {}) {
    const href = String(payload.href || '').trim();
    if (/^(https?:|mailto:)/i.test(href)) {
        await deps.shell.openExternal(href);
        return { kind: 'external' };
    }
    const dir = typeof payload.dir === 'string' && path.isAbsolute(payload.dir) ? payload.dir : '';
    if (!dir || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return { kind: 'ignored' };
    let relative = href.split('#')[0].split('?')[0];
    try { relative = decodeURIComponent(relative); } catch { /* 按原样使用 */ }
    const target = path.resolve(dir, relative);
    if (!(await fs.pathExists(target))) return { kind: 'missing', path: target };
    const hash = href.includes('#') ? href.slice(href.indexOf('#') + 1) : '';
    // 链接目标由主进程按当前文档的位置算出，加入本次运行允许读写的范围。
    if (handles(target)) {
        require('../fileAccess').grant(target);
        return { kind: 'markdown', path: target, hash };
    }
    if (/\.html?$/i.test(target) && (await fs.stat(target)).isFile()) {
        require('../fileAccess').grant(target);
        return { kind: 'web-page', path: target, hash };
    }
    deps.shell.showItemInFolder(target);
    return { kind: 'revealed', path: target };
}

// ---------- 外部修改 ----------
// 每个文坊页面监视正在显示的那份文件。监视所在的文件夹（编辑器常先写临时文件再改名，直接监视文件会丢失事件），
// 并比对内容指纹：与最后一次读到或写下的一致时不提示。
const watches = new Map();
function notify(contents, payload) {
    if (contents && !contents.isDestroyed?.()) contents.send('scriptorium:markdown-event', payload);
}
function slotOf(contents) {
    if (!watches.has(contents.id)) {
        watches.set(contents.id, {});
        contents.once('destroyed', () => {
            watches.get(contents.id)?.file?.close?.();
            watches.delete(contents.id);
        });
    }
    return watches.get(contents.id);
}
// 除 fs.watch 外，每 POLL_MS 检查一次修改时间和大小：文件夹改名、网络盘和 WSL 路径不发通知时仍能发现变化。
// 页面重新获得焦点、重新可见时还会请求立即检查（check-file）。文件被删除只提示一次。
const POLL_MS = 2000;
function watchFile(contents, filePath) {
    const slot = slotOf(contents);
    slot.file?.close();
    slot.file = null;
    if (!filePath || !handles(filePath)) return { watching: false };
    const target = path.resolve(filePath);
    const key = keyOf(target);
    const base = path.basename(target).toLowerCase();
    let timer = 0;
    let missing = false;
    let stamp = '';
    if (!seen.get(contents.id)?.has(key) && known.has(key)) remember(contents, key, known.get(key));
    const stampOf = (stat) => (stat ? `${stat.mtimeMs}:${stat.size}` : 'missing');
    void fs.stat(target).then((stat) => { stamp = stampOf(stat); }).catch(() => { stamp = 'missing'; });
    const check = async () => {
        const bytes = await fs.readFile(target).catch(() => null);
        if (slot.file?.path !== target) return { state: 'closed' };
        if (!bytes) {
            if (!missing) notify(contents, { type: 'file-deleted', path: target });
            missing = true;
            return { state: 'missing' };
        }
        missing = false;
        const print = fingerprint(bytes);
        if (!seenBy(contents, key)) remember(contents, key, print);
        if (print === seenBy(contents, key)) return { state: 'same' };
        notify(contents, { type: 'file-changed', path: target });
        return { state: 'changed' };
    };
    let watcher = null;
    try {
        watcher = fs.watch(path.dirname(target), { persistent: false }, (_event, name) => {
            if (name && String(name).toLowerCase() !== base) return;
            clearTimeout(timer);
            timer = setTimeout(check, 250);
        });
        watcher.on('error', () => {});
    } catch (_) {
        watcher = null; // 无法监视（文件夹不存在、无权限）时依靠轮询
    }
    const poll = setInterval(async () => {
        const next = stampOf(await fs.stat(target).catch(() => null));
        if (next === stamp) return;
        stamp = next;
        clearTimeout(timer);
        void check();
    }, POLL_MS);
    slot.file = {
        path: target,
        check,
        close() { clearTimeout(timer); clearInterval(poll); try { watcher?.close(); } catch (_) { /* 已关闭 */ } },
    };
    return { watching: true, notifications: Boolean(watcher) };
}

// “保留我的”：把磁盘上的当前版本视为已读，下次保存照常覆盖。
async function acceptDisk(filePath, sender = null) {
    const target = path.resolve(String(filePath || ''));
    const bytes = await fs.readFile(target).catch(() => null);
    if (bytes) remember(sender, keyOf(target), fingerprint(bytes));
    else { known.delete(keyOf(target)); seen.get(sender?.id)?.delete(keyOf(target)); }
    return { ok: true };
}
async function checkFile(contents, filePath) {
    const file = watches.get(contents.id)?.file;
    if (!file || keyOf(file.path) !== keyOf(path.resolve(String(filePath || file.path)))) return { state: 'not-watching' };
    return file.check();
}


async function fileCommand(event, payload = {}, deps = {}) {
    switch (payload.command) {
        case 'watch-file': return watchFile(event.sender, payload.path);
        case 'accept-disk': return acceptDisk(payload.path, event.sender);
        case 'check-file': return checkFile(event.sender, payload.path);
        default: throw new Error(`未知的 Markdown 文件命令：${payload.command}`);
    }
}

function register(ipcMain, deps = {}) {
    ipcMain.removeHandler('scriptorium:markdown-link');
    ipcMain.handle('scriptorium:markdown-link', (_event, payload) => openLink(payload, deps));
    ipcMain.removeHandler('scriptorium:markdown-file');
    ipcMain.handle('scriptorium:markdown-file', (event, payload) => fileCommand(event, payload, deps));
}

module.exports = { handles, read, save, openLink, register, decode, encode, rootOf, documentCss };
