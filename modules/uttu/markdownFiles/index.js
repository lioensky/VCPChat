'use strict';
/* 文坊打开、保存 Markdown 文件。
   原来打开 .md 是“导入”：原文放进一份新的 .vdocx 工程，保存只写工程，.md 本身不变。现在：
   - 打开：把原文包成一份只在内存里的工程交给文坊（文坊照常显示、编辑），工程的路径就是这份 .md；
   - 保存：从工程里取出正文，按打开时的换行（CRLF / LF / CR）和 BOM 还原，先写旁边的临时文件再替换原文件；
     打开后磁盘上的文件被别处改过就不覆盖，报错让人先另存。
   文坊的换行在内存里一律是 \n（源码面的 CodeMirror 5 也会这样统一），所以原来的换行记在工程的 manifest.uttu.markdownFile 里。
   原文件旁边不放任何东西（锁文件、缓存都没有）。
   接入点：docxHandlers.js 里的 docx:read-path、选择打开、保存三处（VCP: 注释）。“导入”仍走原来的路，建新工程。 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
const JSZip = require('jszip');
const { decodeText, encodeText } = require('../textEncoding');
const { kindOf, opensInPlace } = require('../scriptoriumTypes');
const docThemes = require('../../../ScriptoriumModules/uttu-doc-themes.js');

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

// 每份文件最后一次读到或写下的内容指纹：保存前和磁盘比，不一样就是别处改过。
// 按页面分开记：原来只有一张全局表，谁读都更新它。
// 右栏和独立窗口开着同一份，一边存了，另一边的监视器拿磁盘指纹和表一比“一样”，当成自己刚存的，不吭声；
// 外面改了之后别处（Ctrl P、切标签、另一个文坊）读一次，正在看的那份也就再收不到通知。现在每个页面只和自己读到、存下的那一版比；
// 没有页面的调用（测试、Agent 转工程）还用全局这张。
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
    const { text, encoding, bom } = decodeText(bytes); // GBK、UTF-16 也认，存回原来的编码
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

// 相对图片能读到多远：文件在 Git 仓库里就是整个仓库（文档常写 ../assets/x.png），否则只是它自己的文件夹。
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

async function pack(filePath, decoded, stat, sidecar = { checkpoints: '[]', comments: [] }) {
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
            // 长页：阅读用，不分纸张。
            scene: { kind: 'flow-document', pagination: { mode: 'continuous' } },
            import: null,
            uttu: {
                markdownFile: { bom: decoded.bom, encoding: decoded.encoding, lineEnding: decoded.lineEnding, mixed: decoded.mixed, dir, root: await rootOf(dir) },
                comments: sidecar.comments, // 批注（旁存）
            },
        },
        source: { format: 'markdown-hybrid', content: null, documentCss: null, lineEnding: 'lf', deckCss: '', slides: [] },
        checkpoints: null,
    };
    const zip = new JSZip();
    zip.file(CONTAINER.manifestEntry, JSON.stringify(model, null, 2));
    zip.file(CONTAINER.sourceEntry, decoded.text);
    zip.file(CONTAINER.styleEntry, docThemes.cssFor('uttu-ink'));
    zip.file(CONTAINER.checkpointsEntry, sidecar.checkpoints);
    zip.file('mimetype', CONTAINER.format, { compression: 'STORE' });
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 1 } });
}

// 大文件先画第一屏：整篇排一份大 .md 要几秒，页面先用 marked 把开头这一段排出来
// 盖在阅读区上（uttu-scriptorium-markdown.js firstPaint），整篇排好再撤。切在空行处，不切进代码块里。
const FIRST_PAINT_FROM = 120 * 1024;
const FIRST_PAINT_CHARS = 48 * 1024;
function openingOf(text) {
    let cut = text.lastIndexOf('\n\n', FIRST_PAINT_CHARS);
    if (cut < FIRST_PAINT_CHARS / 2) cut = FIRST_PAINT_CHARS;
    const head = text.slice(0, cut);
    // An odd number of fence lines means the cut is inside a code block: stop before the last one.
    const fence = /^ {0,3}(?:`{3,}|~{3,})/gm;
    let count = 0;
    let last = -1;
    for (let match = fence.exec(head); match; match = fence.exec(head)) {
        count += 1;
        last = match.index;
    }
    return count % 2 && last > 0 ? head.slice(0, last) : head;
}

// 旁存：.md 文件里只存正文。文坊的修改历史（文脉：每次合入 Agent 的修改、手动建的保存点，各带一份
// 快照）和批注存回原文件时另存在 AppData/Scriptorium/uttu-md-sidecar/<路径 sha1>.json，下次打开同一份带回来：可以看改动、回到那一版，
// 批注还在原处（按引文找）。文脉只留最近 LINEAGE_LIMIT 条、LINEAGE_BYTES 以内（每条快照都是整篇）。文件挪了位置就接不上。
const LINEAGE_LIMIT = 30;
const LINEAGE_BYTES = 20 * 1024 * 1024;
const sidecarFile = (filePath, deps) => path.join(deps.dataDir(), 'uttu-md-sidecar',
    `${crypto.createHash('sha1').update(keyOf(path.resolve(filePath))).digest('hex')}.json`);
async function loadSidecar(filePath, deps = {}) {
    const saved = deps.dataDir ? await fs.readJson(sidecarFile(filePath, deps)).catch(() => null) : null;
    return {
        checkpoints: Array.isArray(saved?.checkpoints) ? JSON.stringify(saved.checkpoints) : '[]',
        comments: Array.isArray(saved?.comments) ? saved.comments : [],
    };
}
async function keepSidecar(filePath, { checkpointsText, comments } = {}, deps = {}) {
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
    const notes = Array.isArray(comments) ? comments : [];
    const file = sidecarFile(filePath, deps);
    if (!kept.length && !notes.length) {
        await fs.remove(file).catch(() => {});
        return;
    }
    await fs.ensureDir(path.dirname(file));
    await fs.writeJson(file, { path: path.resolve(filePath), savedAt: Date.now(), checkpoints: kept, comments: notes });
}

// 打开一份 .md：回给文坊的和打开 .vdocx 一样（kind 'vdocx'），只是路径和名字是这份 .md。
async function read(filePath, deps = {}) {
    if (!handles(filePath)) throw new Error('不是 Markdown 文件。');
    const resolved = path.resolve(filePath);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error('目标不是有效文件。');
    if (stat.size > MAX_BYTES) throw new Error('Markdown 文件超过 20 MB，文坊不原地打开；可以用“导入”。');
    const bytes = await fs.readFile(resolved);
    const decoded = decode(bytes);
    remember(deps.sender, keyOf(resolved), fingerprint(bytes));
    await deps.rememberRecentFile?.(resolved)?.catch?.(() => {});
    const dir = path.dirname(resolved);
    const preview = decoded.text.length > FIRST_PAINT_FROM ? { text: openingOf(decoded.text), dir, root: await rootOf(dir) } : null;
    return {
        preview,
        success: true,
        filePath: resolved,
        name: path.basename(resolved),
        kind: 'vdocx',
        markdownFile: true,
        bytes: await pack(resolved, decoded, stat, await loadSidecar(resolved, deps)),
        size: stat.size,
        modifiedAt: stat.mtimeMs,
    };
}

async function sourceOf(projectBytes) {
    const zip = await JSZip.loadAsync(Buffer.from(projectBytes || []));
    const manifest = JSON.parse(await zip.file(CONTAINER.manifestEntry).async('string'));
    if (manifest.manifest?.scene?.kind === 'slide-deck') throw new Error('演示不能存成 Markdown。');
    const source = zip.file(CONTAINER.sourceEntry);
    if (!source) throw new Error('工程里没有正文。');
    const checkpoints = await zip.file(CONTAINER.checkpointsEntry)?.async('string');
    return { text: await source.async('string'), markdownFile: manifest.manifest?.uttu?.markdownFile || null, checkpoints,
        comments: manifest.manifest?.uttu?.comments || [] };
}

// 先写到同一个文件夹里的临时文件，写完再一步替换（atomicReplace.js：不用 fs-extra 的 move，它覆盖时先删原文件再改名，
// 还会删掉只读文件；D7 冒烟查出），中途断电不会留下半份文件；替换后临时文件就没了。
const nativeFs = require('node:fs');
const { replaceWith } = require('../atomicReplace');
async function replaceFile(target, bytes) {
    await fs.ensureDir(path.dirname(target));
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.uttu-saving-${process.pid}-${Date.now()}`);
    try {
        await nativeFs.promises.writeFile(temporary, bytes);
        await replaceWith(temporary, target);
    } finally {
        await nativeFs.promises.rm(temporary, { force: true }).catch(() => {});
    }
}

// 保存一份从 .md 打开的文档。另存为时可以选 .md（还是 Markdown）或 .vdocx（转成文稿工程，走原来的保存）。
async function save(event, payload = {}, deps = {}) {
    let target = payload.filePath ? path.resolve(payload.filePath) : '';
    let saveAs = Boolean(payload.saveAs);
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
    const { text, markdownFile, checkpoints, comments } = await sourceOf(payload.bytes);
    if (/vdoc-resource:\/\//i.test(text)) {
        throw new Error('这份 Markdown 里插入了图片或字体，.md 文件存不下它们。可以另存为文稿工程（.vdocx）。');
    }
    const bytes = encode(text, markdownFile || {});
    const key = keyOf(target);
    const sender = event?.sender;
    if (!saveAs && seenBy(sender, key)) {
        const onDisk = await fs.readFile(target).catch(() => null);
        if (onDisk && fingerprint(onDisk) !== seenBy(sender, key)) {
            // 页面顶上出二选一（用磁盘上的 / 保留我的），这一次不覆盖。
            notify(event?.sender, { type: 'file-changed', path: target, fromSave: true });
            throw new Error('磁盘上的这份文件在打开后被别处改过了，没有覆盖。在顶上那条提示里选用哪一边。');
        }
    }
    await replaceFile(target, bytes);
    remember(sender, key, fingerprint(bytes)); // 只记在自己名下：别的页面开着同一份时，它们的监视器会看到“变了”
    await keepSidecar(target, { checkpointsText: checkpoints, comments }, deps).catch(() => {});
    if (deps.dataDir) await dropRecovery(target, deps);
    await deps.rememberRecentFile?.(target)?.catch?.(() => {});
    const stat = await fs.stat(target);
    return { success: true, filePath: target, name: path.basename(target), size: stat.size, modifiedAt: stat.mtimeMs };
}

// 点 .md 里的链接：网页、邮件交给系统；相对路径的 .md 回给页面在文坊里打开；相对路径的 .html / .htm 回给页面
// 当网页开（和“文件 → 打开”一样，uttu-scriptorium-page.js）；
// 别的文件只在资源管理器里显示，不直接运行（链接可能指向 .bat、.exe）。
async function openLink(payload = {}, deps = {}) {
    const href = String(payload.href || '').trim();
    if (/^(https?:|mailto:)/i.test(href)) {
        await deps.shell.openExternal(href);
        return { kind: 'external' };
    }
    const dir = typeof payload.dir === 'string' && path.isAbsolute(payload.dir) ? payload.dir : '';
    if (!dir || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return { kind: 'ignored' };
    let relative = href.split('#')[0].split('?')[0];
    try { relative = decodeURIComponent(relative); } catch { /* 原样用 */ }
    const target = path.resolve(dir, relative);
    if (!(await fs.pathExists(target))) return { kind: 'missing', path: target };
    const hash = href.includes('#') ? href.slice(href.indexOf('#') + 1) : '';
    if (handles(target)) return { kind: 'markdown', path: target, hash };
    if (/\.html?$/i.test(target) && (await fs.stat(target)).isFile()) return { kind: 'web-page', path: target, hash };
    deps.shell.showItemInFolder(target);
    return { kind: 'revealed', path: target };
}

// 失效链接：阅读面里的相对链接指向的文件在不在。只回在不在，最多 300 个；带协议的、#锚点不看。
async function checkLinks({ dir, hrefs } = {}) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return { missing: [] };
    const list = (Array.isArray(hrefs) ? hrefs : []).filter((href) => typeof href === 'string').slice(0, 300);
    const missing = [];
    for (const href of list) {
        if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
        let relative = href.split('#')[0].split('?')[0];
        if (!relative) continue;
        try { relative = decodeURIComponent(relative); } catch { /* 原样用 */ }
        if (!(await fs.pathExists(path.resolve(dir, relative)))) missing.push(href);
    }
    return { missing };
}

// ---------- 文件夹：只列 Markdown 和子文件夹；子文件夹点开才读，几千个文件也不卡 ----------
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', '.venv', 'dist', 'build', 'out', 'coverage']);
const MAX_LIST = 3000;
const sameOrInside = (target, root) => {
    const t = path.resolve(target).toLowerCase();
    const r = path.resolve(root).toLowerCase();
    return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};
const skipDir = (name) => name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase());
const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
// 文件夹页、按名字找也列 .html：文坊当网页开（modules/uttu/webPages）。
// PDF、表格也列（文坊当盖在文稿上的视图开，第二轮 E4）。
// 文坊能开的都列，原来 .txt、.js、.json、白板、笔记本在树里看不见。
const listed = (name) => handles(name) || opensInPlace(name) || /\.(docx|pptx|rtf)$/i.test(name);
// 全文查找看得懂字的文件：Markdown、网页、文本和代码。
const searchable = (name) => handles(name) || ['text', 'web-page'].includes(kindOf(name));
// 树里还列图片（点了用默认程序看），all 时列全部文件。
const IMAGES = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const inTree = (name, all) => all ? !name.startsWith('.') : listed(name) || IMAGES.test(name);

async function listFolder({ dir, root, all = false } = {}) {
    if (!path.isAbsolute(String(dir || '')) || !path.isAbsolute(String(root || '')) || !sameOrInside(dir, root)) {
        throw new Error('只能列打开的文件夹里面。');
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const dirs = [];
    const files = [];
    for (const entry of entries.slice(0, MAX_LIST)) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (!skipDir(entry.name)) dirs.push({ name: entry.name, path: full }); }
        else if (entry.isFile() && inTree(entry.name, all)) files.push({ name: entry.name, path: full });
    }
    return { dir, dirs: dirs.sort(byName), files: files.sort(byName), truncated: entries.length > MAX_LIST };
}

// 按文件名在整个文件夹里找：最多看 60000 个条目、1.5 秒，找到 200 个就停。
async function findFiles({ root, query } = {}) {
    if (!path.isAbsolute(String(root || ''))) throw new Error('没有打开的文件夹。');
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return { files: [], truncated: false };
    const started = Date.now();
    const queue = [root];
    const files = [];
    let seen = 0;
    let truncated = false;
    while (queue.length) {
        if (seen > 60000 || Date.now() - started > 1500 || files.length >= 200) { truncated = true; break; }
        const dir = queue.shift();
        let entries = [];
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            seen += 1;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { if (!skipDir(entry.name)) queue.push(full); continue; }
            if (!entry.isFile() || !listed(entry.name)) continue;
            const rel = path.relative(root, full);
            if (rel.toLowerCase().includes(needle)) files.push({ name: entry.name, path: full, rel: rel.split(path.sep).join('/') });
        }
    }
    return { files: files.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-CN', { numeric: true })), truncated };
}

// 全文查找：打开的文件夹里所有 Markdown 的正文，按字面找、不分大小写。每份最多 HITS_PER_FILE 处，
// 一共 HITS_TOTAL 处、看 GREP_ENTRIES 个条目、GREP_MS 毫秒；大于 2 MB 的不看。每处给行号、在这份里是第几处（文坊里跳过去用）、一行摘要。
const HITS_PER_FILE = 5;
const HITS_TOTAL = 300;
const GREP_ENTRIES = 20000;
const GREP_MS = 3000;
const GREP_FILE_BYTES = 2 * 1024 * 1024;
async function grepFiles({ root, query } = {}) {
    if (!path.isAbsolute(String(root || ''))) throw new Error('没有打开的文件夹。');
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return { files: [], hits: 0, truncated: false };
    const started = Date.now();
    const queue = [root];
    const files = [];
    let seen = 0;
    let hits = 0;
    let truncated = false;
    walk: while (queue.length) {
        const dir = queue.shift();
        let entries = [];
        try { entries = (await fs.readdir(dir, { withFileTypes: true })).sort(byName); } catch { continue; }
        for (const entry of entries) {
            seen += 1;
            if (seen > GREP_ENTRIES || Date.now() - started > GREP_MS || hits >= HITS_TOTAL) { truncated = true; break walk; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { if (!skipDir(entry.name)) queue.push(full); continue; }
            if (!entry.isFile() || !searchable(entry.name)) continue;
            const stat = await fs.stat(full).catch(() => null);
            if (!stat || stat.size > GREP_FILE_BYTES) continue;
            const bytes = await fs.readFile(full).catch(() => null);
            const text = bytes ? decodeText(bytes).text : ''; // GBK、UTF-16 也找得到
            const lower = text.toLowerCase();
            if (lower.length !== text.length) continue; // lower-casing changed the length: positions would not line up
            let at = lower.indexOf(needle);
            if (at < 0) continue;
            const found = [];
            let total = 0;
            let line = 1;
            let counted = 0;
            while (at >= 0) {
                if (found.length < HITS_PER_FILE) {
                    for (let k = counted; k < at; k += 1) if (text.charCodeAt(k) === 10) line += 1;
                    counted = at;
                    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
                    const lineEnd = text.indexOf('\n', at);
                    const end = at + needle.length;
                    found.push({
                        line, occurrence: total,
                        before: text.slice(Math.max(lineStart, at - 30), at).replace(/\r/g, ''),
                        match: text.slice(at, end),
                        after: text.slice(end, Math.min(lineEnd < 0 ? text.length : lineEnd, end + 40)).replace(/\r/g, ''),
                    });
                }
                total += 1;
                at = lower.indexOf(needle, at + needle.length);
            }
            hits += found.length;
            files.push({ name: entry.name, path: full, rel: path.relative(root, full).split(path.sep).join('/'), hits: found, total });
        }
    }
    return { files, hits, truncated };
}

// 工作区里全文替换：在全文查找找到的那几份里，把每一处（按字面、不分大小写，和查找一样）换成 replacement，
// 每份照常原子存回（换行、BOM 原样）。页面先问过用户。正开着、有没存改动的那份由页面放进 skip，不动它。
async function replaceInFiles({ root, query, replacement, paths } = {}, deps = {}) {
    if (!path.isAbsolute(String(root || ''))) throw new Error('没有打开的文件夹。');
    if (deps.isRoot && !(await deps.isRoot(root))) throw new Error('这个文件夹不在工作区里。');
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) throw new Error('要换的字是空的。');
    const next = String(replacement ?? '');
    const changed = [];
    const skipped = [];
    for (const file of (Array.isArray(paths) ? paths : []).slice(0, 500)) {
        const target = path.resolve(String(file || ''));
        if (!sameOrInside(target, root) || !searchable(path.basename(target))) { skipped.push({ path: target, reason: '不在这个文件夹里' }); continue; }
        const bytes = await fs.readFile(target).catch(() => null);
        if (!bytes || bytes.length > GREP_FILE_BYTES) { skipped.push({ path: target, reason: '读不到或太大' }); continue; }
        const { text, encoding, bom } = decodeText(bytes);
        const lower = text.toLowerCase();
        if (lower.length !== text.length) { skipped.push({ path: target, reason: '有大小写转换后长度会变的字，没动' }); continue; }
        let out = '';
        let cursor = 0;
        let count = 0;
        for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
            out += text.slice(cursor, at) + next;
            cursor = at + needle.length;
            count += 1;
        }
        if (!count) continue;
        out += text.slice(cursor);
        const written = encodeText(out, { encoding, bom }); // 原来的编码存回
        await replaceFile(target, written);
        changed.push({ path: target, count });
    }
    return { changed, skipped };
}

// Ctrl P 快速打开用：打开的文件夹里所有 Markdown（最多 5000 份、2 秒）。
async function allFiles({ root } = {}) {
    if (!path.isAbsolute(String(root || ''))) return { files: [], truncated: false };
    const started = Date.now();
    const queue = [root];
    const files = [];
    let truncated = false;
    while (queue.length) {
        if (files.length >= 5000 || Date.now() - started > 2000) { truncated = true; break; }
        const dir = queue.shift();
        let entries = [];
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { if (!skipDir(entry.name)) queue.push(full); continue; }
            if (entry.isFile() && listed(entry.name)) files.push({ name: entry.name, path: full, rel: path.relative(root, full).split(path.sep).join('/') });
        }
    }
    return { files: files.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-CN', { numeric: true })), truncated };
}

// 最近打开的文件夹（存在 AppData 里，不在文件夹旁边放东西）。
const recentFile = (deps) => path.join(deps.dataDir(), 'uttu-recent-folders.json');
async function recentFolders(deps) {
    const list = await fs.readJson(recentFile(deps)).catch(() => []);
    const kept = [];
    for (const item of Array.isArray(list) ? list : []) if (item?.path && await fs.pathExists(item.path)) kept.push(item);
    return kept.slice(0, 8);
}
async function rememberFolder(folder, deps) {
    const list = (await recentFolders(deps)).filter((item) => path.resolve(item.path).toLowerCase() !== path.resolve(folder).toLowerCase());
    const next = [{ path: path.resolve(folder), name: path.basename(folder) || folder, openedAt: Date.now() }, ...list].slice(0, 8);
    await fs.ensureDir(path.dirname(recentFile(deps)));
    await fs.writeJson(recentFile(deps), next, { spaces: 2 });
    return next;
}

// ---------- 跟上外部改动 ----------
// 每个文坊页面一份：正在看的那份文件、打开的文件夹。文件盯它所在的文件夹（编辑器常先写临时文件再改名，直接盯文件会丢），
// 比内容指纹：和最后一次读到或写下的一样（多半是我们自己刚存的）就不吭声。文件夹整个盯着，有增删就告诉页面哪几层要重读。
const watches = new Map();
function notify(contents, payload) {
    if (contents && !contents.isDestroyed?.()) contents.send('uttu-md:event', payload);
}
function slotOf(contents) {
    if (!watches.has(contents.id)) {
        watches.set(contents.id, {});
        contents.once('destroyed', () => {
            const slot = watches.get(contents.id);
            slot?.file?.close?.();
            slot?.folder?.watcher?.close();
            Object.values(slot?.dirs || {}).forEach((entry) => entry.close());
            watches.delete(contents.id);
        });
    }
    return watches.get(contents.id);
}
// fs.watch 之外每 POLL_MS 看一眼修改时间和大小：文件夹被改名、网络盘和 WSL 路径不发通知时监视器就没声音了，也不会重来。
// 页面拿回焦点、重新可见时还会要一次 check-file（立刻核一次）。删掉只报一次，回来了再照常比。
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
    // 这个页面自己没读过这份（打开时没带页面）：从现在全局记着的那一版算起，之后只和自己的比。
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
        watcher = null; // 盯不了（文件夹没了、权限）：靠下面的轮询
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
        close() { clearTimeout(timer); clearInterval(poll); try { watcher?.close(); } catch (_) { /* 已关 */ } },
    };
    return { watching: true, notifications: Boolean(watcher) };
}
// 工作区可以有几个文件夹：folder 可以是一个路径，也可以是一组。
function watchFolder(contents, folder) {
    const slot = slotOf(contents);
    slot.folder?.watcher?.close();
    slot.folder = null;
    const folders = (Array.isArray(folder) ? folder : [folder]).filter((item) => typeof item === 'string' && item);
    if (!folders.length) return { watching: false };
    const watchers = [];
    for (const each of folders) {
        const root = path.resolve(each);
        const dirs = new Set();
        let timer = 0;
        try {
            const watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, name) => {
                if (!name) return;
                const rel = String(name);
                if (rel.split(/[\\/]/).some(skipDir)) return; // .git、node_modules 这类，还有我们自己存盘时的 .xxx.uttu-saving 临时文件
                dirs.add(path.dirname(path.join(root, rel)));
                clearTimeout(timer);
                timer = setTimeout(() => {
                    notify(contents, { type: 'folder-changed', root, dirs: [...dirs] });
                    dirs.clear();
                }, 300);
            });
            watcher.on('error', () => {});
            watchers.push({ close() { clearTimeout(timer); watcher.close(); } });
        } catch (_) { /* 这个文件夹盯不了：切回窗口时整棵重读 */ }
    }
    slot.folder = { path: folders[0], watcher: { close() { watchers.forEach((entry) => entry.close()); } } };
    return { watching: watchers.length > 0 };
}
// 文库、样张这些列表的目录：原来只在打开那一页时读一次，Agent 新建的文档要手点刷新。现在盯着，变了说一声 dirs-changed，
// 页面自己重读。一个页面一个名字一组；目录不在就跳过（文库的临时、演示目录可能还没建）。
function watchDirs(contents, name, dirs) {
    const slot = slotOf(contents);
    slot.dirs = slot.dirs || {};
    slot.dirs[name]?.close();
    delete slot.dirs[name];
    const list = (dirs || []).filter((dir) => typeof dir === 'string' && path.isAbsolute(dir));
    if (!list.length) return { watching: false };
    let timer = 0;
    const watchers = [];
    for (const dir of list) {
        try {
            const watcher = fs.watch(dir, { recursive: true, persistent: false }, (_event, file) => {
                if (file && String(file).split(/[\\/]/).some((part) => part.startsWith('.'))) return; // 临时文件、隐藏的
                clearTimeout(timer);
                timer = setTimeout(() => notify(contents, { type: 'dirs-changed', name }), 400);
            });
            watcher.on('error', () => {});
            watchers.push(watcher);
        } catch (_) { /* 目录还没有 */ }
    }
    slot.dirs[name] = { close() { clearTimeout(timer); watchers.forEach((watcher) => { try { watcher.close(); } catch (_) { /* 已关 */ } }); } };
    return { watching: watchers.length > 0 };
}

// “保留我的”：把磁盘上现在这一版当成已经看过，下次保存照常覆盖。
async function acceptDisk(filePath, sender = null) {
    const target = path.resolve(String(filePath || ''));
    const bytes = await fs.readFile(target).catch(() => null);
    if (bytes) remember(sender, keyOf(target), fingerprint(bytes));
    else { known.delete(keyOf(target)); seen.get(sender?.id)?.delete(keyOf(target)); }
    return { ok: true };
}
// 立刻核一次正在看的这份（页面拿回焦点、重新可见、按 F5 之前）。
async function checkFile(contents, filePath) {
    const file = watches.get(contents.id)?.file;
    if (!file || keyOf(file.path) !== keyOf(path.resolve(String(filePath || file.path)))) return { state: 'not-watching' };
    return file.check();
}

// 恢复副本：有没保存的改动时页面每隔几秒送一份正文来，存在 AppData（不在原文件旁边）；存回原文件后删掉。
const recoveryFile = (filePath, deps) => path.join(deps.dataDir(), 'uttu-md-recovery',
    `${crypto.createHash('sha1').update(keyOf(path.resolve(filePath))).digest('hex')}.json`);
async function saveRecovery({ path: filePath, text } = {}, deps = {}) {
    if (!handles(filePath) || typeof text !== 'string') return { ok: false };
    const file = recoveryFile(filePath, deps);
    await fs.ensureDir(path.dirname(file));
    await fs.writeJson(file, { path: path.resolve(filePath), text, savedAt: Date.now() });
    return { ok: true };
}
async function getRecovery({ path: filePath } = {}, deps = {}) {
    if (!handles(filePath)) return null;
    const saved = await fs.readJson(recoveryFile(filePath, deps)).catch(() => null);
    if (!saved?.text) return null;
    const onDisk = await fs.readFile(path.resolve(filePath)).catch(() => null);
    // 副本和磁盘上的一样：没有要恢复的，删掉。
    if (onDisk) {
        try {
            if (decode(onDisk).text === saved.text.replace(/\r\n?/g, '\n')) { await dropRecovery(filePath, deps); return null; }
        } catch { /* 磁盘上的读不成 UTF-8，照样给副本 */ }
    }
    return { text: saved.text, savedAt: saved.savedAt };
}
async function dropRecovery(filePath, deps = {}) {
    await fs.remove(recoveryFile(filePath, deps)).catch(() => {});
    return { ok: true };
}

// 文坊右边一栏只读地摆另一份：只给正文，不记“最近打开”、不看外部改动。
const SIDE_TEXT = /\.(md|markdown|txt)$/i;
const SIDE_MAX_BYTES = 5 * 1024 * 1024;
async function sideText(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    if (!SIDE_TEXT.test(resolved)) throw new Error('右边一栏只摆 Markdown 和纯文本。');
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error('目标不是有效文件。');
    if (stat.size > SIDE_MAX_BYTES) throw new Error('文件超过 5 MB，右边一栏不摆。');
    return { text: decode(await fs.readFile(resolved)).text, name: path.basename(resolved), dir: path.dirname(resolved), filePath: resolved };
}

async function folderCommand(event, payload = {}, deps = {}) {
    switch (payload.command) {
        case 'side-text': return sideText(payload.path);
        case 'watch-file': return watchFile(event.sender, payload.path);
        case 'watch-folder': return watchFolder(event.sender, payload.path);
        case 'accept-disk': return acceptDisk(payload.path, event.sender);
        case 'check-file': return checkFile(event.sender, payload.path);
        case 'link-check': return checkLinks(payload);
        // 两边都改了时“看两边差在哪”：只给这个页面正在看的那份的磁盘原文（换行统一成 \n）。
        case 'disk-text': {
            const file = watches.get(event.sender.id)?.file;
            if (!file || keyOf(file.path) !== keyOf(path.resolve(String(payload.path || '')))) throw new Error('只能看正开着的这份。');
            const bytes = await fs.readFile(file.path).catch(() => null);
            if (!bytes) throw new Error('磁盘上读不到这份了。');
            return { text: decode(bytes).text };
        }
        case 'watch-library': return watchDirs(event.sender, 'library', deps.libraryRoots?.() || []);
        case 'recovery-save': return saveRecovery(payload, deps);
        case 'recovery-get': return getRecovery(payload, deps);
        case 'recovery-drop': return dropRecovery(payload.path, deps);
        case 'choose': {
            const result = await deps.dialog.showOpenDialog(deps.ownerOf?.(event), { title: '打开文件夹', properties: ['openDirectory'] });
            if (result.canceled || !result.filePaths?.length) return { canceled: true };
            const folder = path.resolve(result.filePaths[0]);
            await rememberFolder(folder, deps);
            await deps.addRoot?.(folder); // 选的文件夹加进工作区
            return { path: folder, name: path.basename(folder) || folder };
        }
        case 'open': {
            const folder = path.resolve(String(payload.path || ''));
            const stat = await fs.stat(folder).catch(() => null);
            if (!stat?.isDirectory()) return { missing: true, path: folder };
            await rememberFolder(folder, deps);
            return { path: folder, name: path.basename(folder) || folder };
        }
        case 'list': {
            // 只列工作区、笔记、样张、文库这些根里面（scriptoriumFiles.isRoot）；页面递来的任意根不认。
            if (deps.isRoot && !(await deps.isRoot(payload.root))) throw new Error('这个文件夹不在工作区里。');
            return listFolder(payload);
        }
        case 'find': return findFiles(payload);
        case 'grep': return grepFiles(payload); // 全文查找
        case 'replace': return replaceInFiles(payload, deps); // 全文替换
        case 'tags': return require('./tags').scan(payload, deps); // 标签（第二轮 E2）
        case 'notes': return { path: await require('../notesInScriptorium').notesDir().catch(() => null) }; // 笔记文件夹；没配置（冒烟里）时没有
        case 'new-note': return require('../notesInScriptorium').newNote();
        case 'all': return allFiles(payload); // Ctrl P
        case 'wiki-resolve': return require('./wikiLinks').resolve(payload, { allFiles, rootOf }); // [[双链]]
        case 'wiki-create': return require('./wikiLinks').create(payload);
        case 'links': return require('./wikiLinks').backlinks(payload, { allFiles, rootOf }); // 链出和反向链接
        case 'convert': return require('./toProject').toProject(event, payload, deps); // 转成文稿工程
        case 'recent': return { folders: await recentFolders(deps) };
        default: throw new Error(`不认识的文件夹命令：${payload.command}`);
    }
}

function register(ipcMain, deps = {}) {
    ipcMain.removeHandler('uttu-md:open-link');
    ipcMain.handle('uttu-md:open-link', (_event, payload) => openLink(payload, deps));
    ipcMain.removeHandler('uttu-md:folder');
    ipcMain.handle('uttu-md:folder', (event, payload) => folderCommand(event, payload, deps));
}

// 选择打开的对话框：第一项同时列工程和 Markdown。
function openFilters(original = []) {
    const extensions = [...new Set([...original.flatMap((filter) => filter.extensions || []), 'md', 'markdown'])];
    // PDF、表格也能从这里开（文坊当盖在文稿上的视图开）。
    return [{ name: '文稿工程、Markdown、PDF 和表格', extensions: [...extensions, 'pdf', 'csv', 'tsv', 'xlsx'] }, ...original,
        { name: 'Markdown', extensions: ['md', 'markdown'] }, { name: 'PDF', extensions: ['pdf'] }, { name: '表格', extensions: ['csv', 'tsv', 'xlsx'] }];
}

module.exports = { handles, read, save, openFilters, openLink, register, decode, encode, rootOf, listFolder, findFiles, recentFolders, rememberFolder };
