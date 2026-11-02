'use strict';
// 文坊的工作区和最近打开。
// 打开的文件夹就是工作区，可以开多个（像 VS Code 的多根工作区）。工作区存在 AppData/Scriptorium/uttu-workspace.json，
// 右栏和独立窗口看到同一份；最近打开的文件夹还是 markdownFiles 那份（uttu-recent-folders.json），最近打开的文件是上游的 recent.json。
// 安全：工作区只能经主进程加进来——选文件夹的对话框、拖进来的文件夹（dropOpen）、主进程交来的文件夹（openScriptorium）、
// 或者最近打开过的文件夹（它们当初也是这么来的）。页面递来的任意路径不认。allowed() 给文件夹列表和以后的文件操作用：
// 只认工作区、文库、笔记、样张目录里的，和最近打开的文件本身。
// 接入：docxHandlers 一行 register；markdownFiles 的 choose / open / list 经 deps 调这里。
const path = require('path');
const fs = require('fs-extra');
const launch = require('./launch');

let deps = null;
const norm = (target) => {
    const resolved = path.resolve(String(target || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const sameOrInside = (target, root) => {
    const t = norm(target);
    const r = norm(root);
    return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};
const nameOf = (folder) => path.basename(folder) || folder;

const workspaceFile = () => path.join(deps.dataDir(), 'uttu-workspace.json');
let cache = null;
async function readRoots() {
    if (cache) return cache;
    const saved = deps?.dataDir ? await fs.readJson(workspaceFile()).catch(() => null) : null;
    cache = (Array.isArray(saved?.roots) ? saved.roots : []).filter((item) => typeof item === 'string' && path.isAbsolute(item));
    return cache;
}
async function writeRoots(roots) {
    cache = roots;
    if (!deps?.dataDir) return;
    await fs.ensureDir(path.dirname(workspaceFile()));
    await fs.writeJson(workspaceFile(), { roots }, { spaces: 2 });
}

// 每个工作区文件夹在不在（被删、U 盘拔了的照样列出来，标“找不到”，可以移出去）。
async function workspace() {
    const roots = await readRoots();
    const list = [];
    for (const root of roots) {
        const stat = await fs.stat(root).catch(() => null);
        list.push({ path: root, name: nameOf(root), missing: !stat?.isDirectory() });
    }
    return { roots: list };
}

// 主进程自己加（对话框选的、拖进来的、主进程交来的）：一定认。加在最后；已经有了不重复。
async function addRoot(folder) {
    const resolved = path.resolve(String(folder || ''));
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`不是文件夹，或者已经不在了：${resolved}`);
    // 笔记有自己的一块（资源管理器“笔记”），不进工作区。
    const notes = await Promise.resolve(deps?.notesDir?.()).catch(() => null);
    if (notes && norm(notes) === norm(resolved)) return { path: resolved, name: nameOf(resolved), notes: true };
    const roots = await readRoots();
    if (!roots.some((root) => norm(root) === norm(resolved))) await writeRoots([...roots, resolved]);
    await deps.rememberFolder?.(resolved)?.catch?.(() => {});
    return { path: resolved, name: nameOf(resolved) };
}

// 页面要加的：只认最近打开过的文件夹、笔记、已经在工作区里的。
async function addKnownRoot(folder) {
    const resolved = path.resolve(String(folder || ''));
    const recent = (await deps.recentFolders?.().catch?.(() => [])) || [];
    const known = recent.some((item) => norm(item.path) === norm(resolved))
        || [...await readRoots(), ...await fixedRoots()].some((root) => norm(root) === norm(resolved));
    if (!known) throw new Error('这个文件夹没打开过。用“打开文件夹”选一次。');
    return addRoot(resolved);
}

async function removeRoot(folder) {
    const roots = await readRoots();
    await writeRoots(roots.filter((root) => norm(root) !== norm(folder)));
    return { ok: true };
}

// 挪顺序（拖动工作区的根）：to 是挪到的位置。
async function moveRoot(folder, to) {
    const roots = [...await readRoots()];
    const from = roots.findIndex((root) => norm(root) === norm(folder));
    if (from < 0) return { ok: false };
    const [item] = roots.splice(from, 1);
    roots.splice(Math.max(0, Math.min(roots.length, Number(to) || 0)), 0, item);
    await writeRoots(roots);
    return { ok: true };
}

async function fixedRoots() {
    const notes = await Promise.resolve(deps?.notesDir?.()).catch(() => null);
    return [notes, ...(deps?.libraryRoots?.() || [])].filter(Boolean);
}

// 能列的文件夹根：工作区、笔记、样张、文库。
async function isRoot(folder) {
    if (!folder) return false;
    const roots = [...await readRoots(), ...await fixedRoots()];
    return roots.some((root) => norm(root) === norm(folder));
}

// 文件操作能碰的：工作区、笔记、样张、文库里面的，和最近打开的文件本身（开着的文档读的时候已经记进最近打开）。
// 主进程自己交给文坊的文件（打开对话框选的、拖进来的、Agent 要开的）：这次运行里也认（PDF 起：
// PDF 的读要先过 allowed，这些文件读之前还没进最近打开）。
const granted = new Set();
const grant = (target) => { if (target && path.isAbsolute(String(target))) granted.add(norm(path.resolve(target))); };
async function allowed(target) {
    if (!target || !path.isAbsolute(String(target))) return false;
    if (granted.has(norm(path.resolve(target)))) return true;
    const roots = [...await readRoots(), ...await fixedRoots()];
    if (roots.some((root) => sameOrInside(target, root))) return true;
    const recent = (await deps?.recentFiles?.().catch?.(() => [])) || [];
    return recent.some((item) => item?.path && norm(item.path) === norm(target));
}

// 最近打开的文件：上游 recent.json（docxHandlers 的 readRecentFiles / rememberRecentFile），这里只加去掉一条、清空。
async function forgetRecent(file) {
    const target = deps.recentFilePath?.();
    if (!target) return { ok: false };
    const list = await fs.readJson(target).catch(() => []);
    const next = (Array.isArray(list) ? list : []).filter((item) => !file || norm(item?.path) !== norm(file));
    await fs.writeJson(target, next, { spaces: 2 });
    return { ok: true };
}

// ---------- 文件操作：右键菜单里的事 ----------
// 可以运行的文件不交给默认程序（双击 .bat 就是运行它），只在资源管理器里显示（和 .md 里的链接同一条规矩，markdownFiles openLink）。
const RUNNABLE = new Set(['.bat', '.cmd', '.exe', '.com', '.ps1', '.psm1', '.psd1', '.lnk', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
    '.msi', '.msp', '.scr', '.pif', '.hta', '.cpl', '.msc', '.jar', '.reg', '.url', '.appref-ms', '.sh', '.py', '.pyw', '.application', '.gadget']);
const runnable = (file) => RUNNABLE.has(path.extname(String(file || '')).toLowerCase());
// Windows 文件名不能有的字符；也不能是 . 和 ..，不能以空格或点结尾。
function cleanName(name) {
    const value = String(name ?? '').trim();
    if (!value || value === '.' || value === '..') throw new Error('名字不能是空的。');
    if (/[\\/:*?"<>|\u0000-\u001f]/.test(value)) throw new Error('名字里不能有 \\ / : * ? " < > | 这些字符。');
    if (/[. ]$/.test(value)) throw new Error('名字不能以点或空格结尾。');
    return value;
}
async function mustAllow(target, what = '这个文件') {
    if (!(await allowed(target))) throw new Error(`${what}不在工作区、文库、笔记或最近打开里，文坊不动它。`);
    return path.resolve(target);
}
async function freeName(dir, base, ext) {
    for (let index = 0; index < 1000; index += 1) {
        const name = index ? `${base} ${index + 1}${ext}` : `${base}${ext}`;
        const candidate = path.join(dir, name);
        if (!(await fs.pathExists(candidate))) return candidate;
    }
    throw new Error('同名的太多了。');
}
// 相对路径：相对它所在的工作区文件夹；不在工作区就相对 Git 仓库根；都没有就只给文件名。斜杠一律用 /（Markdown 里能直接用）。
async function relativeOf(target) {
    const roots = [...await readRoots(), ...await fixedRoots()].filter((root) => sameOrInside(target, root))
        .sort((a, b) => b.length - a.length);
    const base = roots[0] || await deps.rootOf?.(path.dirname(target)).catch?.(() => null) || path.dirname(target);
    return path.relative(base, target).split(path.sep).join('/') || path.basename(target);
}
const isDir = async (target) => Boolean((await fs.stat(target).catch(() => null))?.isDirectory());

async function fileAct(command, payload) {
    switch (command) {
        case 'reveal': {
            const target = await mustAllow(payload.path);
            deps.shell.showItemInFolder(target);
            return { ok: true };
        }
        case 'open-vscode': {
            const target = await mustAllow(payload.path);
            const where = payload.folder && !(await isDir(target)) ? path.dirname(target) : target;
            return launch.openInVsCode(where);
        }
        case 'open-terminal': {
            const target = await mustAllow(payload.path);
            return launch.openTerminal((await isDir(target)) ? target : path.dirname(target));
        }
        case 'open-default': {
            const target = await mustAllow(payload.path);
            if (runnable(target)) {
                deps.shell.showItemInFolder(target);
                return { ok: true, revealed: true };
            }
            const error = await deps.shell.openPath(target);
            if (error) throw new Error(`系统没打开它：${error}`);
            return { ok: true };
        }
        case 'copy-path': {
            const target = await mustAllow(payload.path);
            const text = payload.kind === 'relative' ? await relativeOf(target) : payload.kind === 'name' ? path.basename(target) : target;
            require('electron').clipboard?.writeText(text);
            return { ok: true, text };
        }
        case 'rename': {
            const target = await mustAllow(payload.path);
            if (await isRoot(target)) throw new Error('工作区的根文件夹不在这里改名（在资源管理器里改，再重新打开）。');
            const name = cleanName(payload.name);
            const next = path.join(path.dirname(target), name);
            if (next === target) return { ok: true, path: target };
            const caseOnly = norm(next) === norm(target);
            if (!caseOnly && await fs.pathExists(next)) throw new Error(`这里已经有一个“${name}”了。`);
            await fs.rename(target, next);
            return { ok: true, path: next, from: target };
        }
        case 'duplicate': {
            const target = await mustAllow(payload.path);
            const ext = (await isDir(target)) ? '' : path.extname(target);
            const copy = await freeName(path.dirname(target), `${path.basename(target, ext)} 副本`, ext);
            await fs.copy(target, copy, { overwrite: false, errorOnExist: true });
            return { ok: true, path: copy };
        }
        case 'new-file':
        case 'new-folder': {
            const dir = await mustAllow(payload.dir, '这个文件夹');
            if (!(await isDir(dir))) throw new Error('不是文件夹。');
            let name = cleanName(payload.name);
            if (command === 'new-file' && !path.extname(name)) name += '.md';
            const target = path.join(dir, name);
            if (await fs.pathExists(target)) throw new Error(`这里已经有一个“${name}”了。`);
            if (command === 'new-folder') await fs.ensureDir(target);
            else await fs.writeFile(target, /\.(md|markdown)$/i.test(name) ? `# ${path.basename(name, path.extname(name))}\n\n` : '', { flag: 'wx' });
            return { ok: true, path: target };
        }
        case 'trash': {
            const target = await mustAllow(payload.path);
            if (await isRoot(target)) throw new Error('工作区的根文件夹不能从这里删；要不看了就“移出工作区”。');
            await deps.shell.trashItem(target);
            return { ok: true, path: target };
        }
        case 'move': {
            const target = await mustAllow(payload.path);
            const dir = await mustAllow(payload.to, '要挪去的文件夹');
            if (await isRoot(target)) throw new Error('工作区的根文件夹不能挪。');
            if (!(await isDir(dir))) throw new Error('只能挪进文件夹里。');
            if (sameOrInside(dir, target)) throw new Error('不能挪进它自己里面。');
            const next = path.join(dir, path.basename(target));
            if (norm(next) === norm(target)) return { ok: true, path: target };
            if (await fs.pathExists(next)) throw new Error(`那里已经有一个“${path.basename(target)}”了。`);
            await fs.rename(target, next).catch(async (error) => {
                if (error.code !== 'EXDEV') throw error;
                await fs.move(target, next, { overwrite: false }); // 跨盘
            });
            return { ok: true, path: next, from: target };
        }
        case 'add-asset': {
            // 往 .md 里粘贴、拖进图片：存到这份 .md 旁边的 assets/（没有就建），回相对路径，页面插 ![](assets/名字)。
            // 来源是拖进来的文件（source，只认图片、50 MB 以内），或者粘贴板里的图片字节（bytes）。原名留着，重名加数字。
            const doc = await mustAllow(payload.doc, '这份文档');
            if (!/\.(md|markdown)$/i.test(doc)) throw new Error('只有 .md 能这样插图片；文稿工程用插入菜单里的图片。');
            const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
            let bytes = null;
            let name = '';
            if (payload.source) {
                const source = path.resolve(String(payload.source));
                if (!IMAGE.test(source)) throw new Error('只能插图片（png、jpg、gif、webp、svg、bmp、avif）。');
                const stat = await fs.stat(source).catch(() => null);
                if (!stat?.isFile()) throw new Error('找不到这张图。');
                if (stat.size > 50 * 1024 * 1024) throw new Error('图片超过 50 MB，没插。');
                name = path.basename(source);
                // 已经在这份 .md 能读到的地方（同一个文件夹或下面）：不复制，直接用相对路径。
                if (sameOrInside(source, path.dirname(doc))) {
                    return { ok: true, rel: path.relative(path.dirname(doc), source).split(path.sep).join('/'), copied: false };
                }
                bytes = await fs.readFile(source);
            } else {
                bytes = Buffer.from(payload.bytes || []);
                if (!bytes.length) throw new Error('粘贴板里没有图片。');
                if (bytes.length > 50 * 1024 * 1024) throw new Error('图片超过 50 MB，没插。');
                const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[payload.type] || '.png';
                const stamp = new Date();
                const pad = (value) => String(value).padStart(2, '0');
                name = `粘贴 ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}${ext}`;
            }
            const assets = path.join(path.dirname(doc), 'assets');
            await fs.ensureDir(assets);
            const ext = path.extname(name);
            let base = path.basename(name, ext).replace(/[\\/:*?"<>|]/g, '_').trim() || '图片';
            const target = await freeName(assets, base, ext);
            await fs.writeFile(target, bytes, { flag: 'wx' });
            base = path.basename(target);
            return { ok: true, rel: `assets/${base}`, copied: true, path: target };
        }
        case 'collect': {
            // 收进文库：复制一份到文库目录，原文件不动。
            const target = await mustAllow(payload.path);
            const library = deps.libraryDir?.();
            if (!library) throw new Error('文库目录还没准备好。');
            if (sameOrInside(target, library)) throw new Error('它已经在文库里了。');
            if (await isDir(target)) throw new Error('文件夹不能收进文库。');
            await fs.ensureDir(library);
            const ext = path.extname(target);
            const copy = await freeName(library, path.basename(target, ext), ext);
            await fs.copy(target, copy, { overwrite: false, errorOnExist: true });
            return { ok: true, path: copy };
        }
        default:
            return null;
    }
}

async function act(event, payload = {}) {
    const done = await fileAct(payload.command, payload);
    if (done) return done;
    switch (payload.command) {
        case 'workspace': return workspace();
        case 'add-root': {
            if (payload.path) return addKnownRoot(payload.path);
            const result = await deps.dialog.showOpenDialog(deps.ownerOf?.(event), {
                title: '打开文件夹（加进工作区）', properties: ['openDirectory', 'multiSelections'],
            });
            if (result.canceled || !result.filePaths?.length) return { canceled: true };
            const added = [];
            for (const folder of result.filePaths) added.push(await addRoot(folder));
            return { ...added[added.length - 1], added: added.map((item) => item.path) };
        }
        case 'choose-images': {
            const result = await deps.dialog.showOpenDialog(deps.ownerOf?.(event), {
                title: '插入图片', properties: ['openFile', 'multiSelections'],
                filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] }],
            });
            return result.canceled ? { paths: [] } : { paths: result.filePaths || [] };
        }
        case 'remove-root': return removeRoot(payload.path);
        case 'move-root': return moveRoot(payload.path, payload.to);
        // 标签指向的文件还在不在（重开文坊时去掉已经不在的）。只回在不在，最多 50 个。
        case 'exists': {
            const paths = (Array.isArray(payload.paths) ? payload.paths : []).slice(0, 50);
            return { exists: await Promise.all(paths.map((file) => (typeof file === 'string' && path.isAbsolute(file) ? fs.pathExists(file) : false))) };
        }
        case 'recent-files': return { files: (await deps.recentFiles?.().catch?.(() => [])) || [] };
        case 'forget-recent': return forgetRecent(payload.path);
        case 'clear-recent': return forgetRecent(null);
        default: throw new Error(`不认识的文件操作：${payload.command}`);
    }
}

function configure(value) {
    deps = value;
    cache = null;
}

function register(ipcMain, value) {
    configure(value);
    ipcMain.removeHandler('uttu-files:act');
    ipcMain.handle('uttu-files:act', (event, payload) => act(event, payload));
}

module.exports = { register, configure, addRoot, removeRoot, workspace, isRoot, allowed, grant, sameOrInside, runnable, cleanName, launch, _reset: () => { cache = null; } };
