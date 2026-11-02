'use strict';
// 文坊把 .html 当网页打开。
//
// 显示：uttu-page://<令牌>/<相对路径>。令牌对应这份网页所在的 Git 仓库（不在仓库里就是它所在的文件夹），网页里
// ../../chat/assets/... 这样的相对地址照常能用，但出不了这个范围。只供静态网页文件（下面 TYPES 里的扩展名）；
// 点开头的文件和文件夹（.git、.env）、别的扩展名一律 404，所以 config.env、settings.json 这类东西读不到。
// 每个回应带自己的 CSP：不能连网取数据（connect-src 'none'），图片、字体、脚本只从本协议和 data/blob 来，
// 另外放行 Google Fonts 的样式和字体；nosniff 让扩展名不对的文件也不能当脚本、样式用。
// 文坊把它放进 sandbox="allow-scripts" 的 iframe（ScriptoriumModules/uttu-scriptorium-page.js）：来源是不透明的，
// 碰不到文坊页面、它的接口和存储。
//
// 源码：uttu-scriptorium:page 读、存（只认 .html / .htm），文件在外面改了告诉页面（uttu-scriptorium:page-changed）。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { protocol } = require('electron');
// main.js 启动时就加载这个文件：markdownFiles 带着 jszip、fs-extra，textEncoding 带着 iconv-lite，用到时才取。
const rootOf = (...args) => require('../markdownFiles').rootOf(...args);
const decodeText = (...args) => require('../textEncoding').decodeText(...args);
const encodeText = (...args) => require('../textEncoding').encodeText(...args);

const SCHEME = 'uttu-page';
// 在 app ready 之前登记（chat/main.js）。
const PRIVILEGE = Object.freeze({ scheme: SCHEME, privileges: { standard: true, secure: true, corsEnabled: true, stream: true } });
const PAGE_EXTENSIONS = new Set(['.html', '.htm']);
const TYPES = Object.freeze({
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
});
const TEXT = new Set(['text/html', 'text/css', 'text/javascript', 'image/svg+xml']);
const FONTS = new Set(['.woff', '.woff2', '.ttf', '.otf']);
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const CSP = [
    "default-src 'none'",
    `script-src ${SCHEME}: blob: 'unsafe-inline' 'unsafe-eval'`,
    `style-src ${SCHEME}: 'unsafe-inline' https://fonts.googleapis.com`,
    `img-src ${SCHEME}: data: blob:`,
    `font-src ${SCHEME}: data: https://fonts.gstatic.com`,
    `media-src ${SCHEME}: data: blob:`,
    `frame-src ${SCHEME}: data: blob:`,
    `worker-src ${SCHEME}: blob:`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
].join('; ');

const handles = (file) => typeof file === 'string' && PAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
const key = (dir) => path.resolve(dir).toLowerCase();
const inside = (target, root) => {
    const t = key(target);
    const r = key(root);
    return t === r || t.startsWith(r.endsWith(path.sep) ? r : `${r}${path.sep}`);
};

// 令牌 → 范围（真实路径）。同一个范围一直用同一个令牌，网页里的相对链接、刷新都不会换地址。
const grants = new Map();
const tokens = new Map();
async function grant(file) {
    const root = await fs.promises.realpath(await rootOf(path.dirname(path.resolve(file))));
    let token = tokens.get(key(root));
    if (!token) {
        token = crypto.randomBytes(12).toString('hex');
        tokens.set(key(root), token);
        grants.set(token, root);
    }
    const real = await fs.promises.realpath(file);
    if (!inside(real, root)) throw new Error('网页不在它所在的文件夹里。');
    const relative = path.relative(root, real).split(path.sep).map(encodeURIComponent).join('/');
    return { root, url: `${SCHEME}://${token}/${relative}` };
}

function respond(status, body, type, extra = {}) {
    return new Response(body, {
        status,
        headers: {
            'content-type': TEXT.has(type) ? `${type}; charset=utf-8` : type,
            'content-security-policy': CSP,
            'x-content-type-options': 'nosniff',
            'cache-control': 'no-store',
            ...extra,
        },
    });
}

// 响应头写着 charset=utf-8，盖过页面里的 meta：老网页是 GBK、UTF-16 的，转好再发。
function utf8Of(body) {
    try {
        const { text, encoding } = decodeText(body);
        return encoding === 'utf-8' ? body : Buffer.from(text);
    } catch (_) {
        return body;
    }
}

// 找到这个地址对应的文件；不在范围里、不是静态网页文件就回 null。
async function resolveRequest(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch (_) {
        return null;
    }
    const root = grants.get(url.host);
    if (!root) return null;
    let segments;
    try {
        segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch (_) {
        return null;
    }
    if (!segments.length || segments.some((segment) => segment.startsWith('.') || /[\\/:*?"<>|\0]/.test(segment))) return null;
    const full = path.join(root, ...segments);
    const extension = path.extname(full).toLowerCase();
    if (!TYPES[extension] || !inside(full, root)) return null;
    try {
        const real = await fs.promises.realpath(full); // 链接、联接点指到范围外面的不算
        if (!inside(real, root)) return null;
        const stat = await fs.promises.stat(real);
        if (!stat.isFile() || stat.size > MAX_BYTES) return null;
        return { file: real, extension, type: TYPES[extension] };
    } catch (_) {
        return null;
    }
}

// 默认会话上装（文坊窗口和它在右栏的那份都用默认会话）。
function installProtocol(protocolApi = protocol, appApi = require('electron').app) {
    if (appApi) guardFrames(appApi);
    protocolApi.handle(SCHEME, async (request) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') return respond(405, '', 'text/plain');
        const found = await resolveRequest(request.url);
        if (!found) return respond(404, '', 'text/plain');
        try {
            const body = request.method === 'HEAD' ? null : await fs.promises.readFile(found.file);
            if (body && TEXT.has(found.type)) return respond(200, utf8Of(body), found.type);
            // 不透明来源的网页取字体要过 CORS。
            return respond(200, body, found.type, FONTS.has(found.extension) ? { 'access-control-allow-origin': '*' } : {});
        } catch (_) {
            return respond(404, '', 'text/plain');
        }
    });
}

// 预览框里的网页只在自己的范围里跳（同一个令牌）。文坊页面的 CSP 只许框里是 uttu-page，往外网跳先被它拦下，
// 框里换成错误页：认出是网页框（iframe 的 name，uttu-scriptorium-page.js），告诉文坊页面，它把网页刷回来、问要不要用浏览器打开。
// 跳到别的 uttu-page 范围（CSP 放行）在这里拦。只管子框架；右栏网页标签（主框架）是浏览器，不在这里管。
const FRAME_NAME = 'uttu-page-frame';
const BLOCKED_BY_CSP = -30;
function guardFrames(appApi, frames = require('electron').webFrameMain) {
    appApi.on('web-contents-created', (_event, contents) => {
        const tell = (url) => {
            if (/^https?:\/\//i.test(url) && !contents.isDestroyed()) contents.send('uttu-scriptorium:page-blocked', { url });
        };
        contents.on('will-frame-navigate', (details) => {
            if (details.isMainFrame) return;
            const from = String(details.frame?.url || '');
            const to = String(details.url || '');
            if (!from.startsWith(`${SCHEME}://`) || !to.startsWith(`${SCHEME}:`)) return;
            try {
                if (new URL(to).host === new URL(from).host) return;
            } catch (_) { /* 地址不对，拦下 */ }
            details.preventDefault();
        });
        contents.on('did-fail-load', (_failEvent, code, _description, url, isMainFrame, processId, routingId) => {
            if (isMainFrame || code !== BLOCKED_BY_CSP) return;
            let frame = null;
            try { frame = frames?.fromId(processId, routingId); } catch (_) { frame = null; }
            if (frame?.name === FRAME_NAME) tell(String(url || ''));
        });
    });
}

// docx:read-path、打开对话框遇到 .html：告诉文坊这是网页，交给网页视图（不再导入）。
function describe(file) {
    const resolved = path.resolve(file);
    return { success: true, kind: 'web-page', filePath: resolved, name: path.basename(resolved) };
}

async function readPage(file) {
    const resolved = path.resolve(String(file || ''));
    if (!handles(resolved)) throw new Error('只能打开 .html / .htm 网页。');
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile()) throw new Error('找不到这份网页。');
    if (stat.size > MAX_PAGE_BYTES) throw new Error('网页太大（超过 16 MB），文坊不打开。');
    const { text, encoding, bom } = decodeText(await fs.promises.readFile(resolved)); // 老网页常是 GBK，源码面也要读对、存回原编码
    const { url, root } = await grant(resolved);
    return {
        success: true, filePath: resolved, name: path.basename(resolved), url, root,
        text: text.replace(/\r\n/g, '\n'), eol: /\r\n/.test(text) ? 'crlf' : 'lf', encoding, bom, mtime: stat.mtimeMs, size: stat.size,
    };
}

// 先写到旁边的临时文件，再一步换过去（modules/uttu/atomicReplace.js），写到一半断了原文件也还在。
async function writeAtomically(target, data) {
    const temporary = `${target}.uttu-writing-${process.pid}-${Date.now()}`;
    try {
        await fs.promises.writeFile(temporary, data);
        await require('../atomicReplace').replaceWith(temporary, target);
    } finally {
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
    }
}

// 存回原文件。别处改过（修改时间对不上）就先不存，交给页面问；force 时照存。
async function savePage(payload) {
    const resolved = path.resolve(String(payload?.file || ''));
    if (!handles(resolved)) throw new Error('只能存 .html / .htm 网页。');
    const stat = await fs.promises.stat(resolved).catch(() => null);
    if (stat && !payload.force && Number.isFinite(payload.mtime) && Math.abs(stat.mtimeMs - payload.mtime) > 1) {
        return { success: false, conflict: true, mtime: stat.mtimeMs };
    }
    let text = String(payload.text ?? '');
    if (payload.eol === 'crlf') text = text.replace(/\r?\n/g, '\r\n');
    await writeAtomically(resolved, encodeText(text, { encoding: payload.encoding, bom: payload.bom }));
    const after = await fs.promises.stat(resolved);
    watchers.get(payload.senderId)?.saved(after.mtimeMs);
    return { success: true, mtime: after.mtimeMs };
}

// 每个文坊页面看一份网页：文件变了（不是自己刚存的）告诉它。
const watchers = new Map();
function watchPage(sender, file) {
    const id = sender.id;
    watchers.get(id)?.close();
    watchers.delete(id);
    if (!file) return { success: true };
    const resolved = path.resolve(String(file));
    if (!handles(resolved)) throw new Error('只能看 .html / .htm 网页。');
    let own = 0;
    let timer = null;
    let watcher = null;
    const check = async () => {
        const stat = await fs.promises.stat(resolved).catch(() => null);
        if (!stat || Math.abs(stat.mtimeMs - own) <= 1 || sender.isDestroyed()) return;
        own = stat.mtimeMs;
        sender.send('uttu-scriptorium:page-changed', { file: resolved, mtime: stat.mtimeMs });
    };
    try {
        // 编辑器存盘常常是“写临时文件再改名”，看文件夹，按名字过滤。
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
    // 通知之外每 2 秒看一眼修改时间：文件夹被改名、网络盘不发通知时监视器就没声音了。
    // check 也给页面拿回焦点时立刻核一次用。
    const poll = setInterval(() => { void check(); }, 2000);
    const entry = {
        check,
        saved(mtime) { own = mtime; },
        close() { clearTimeout(timer); clearInterval(poll); try { watcher?.close(); } catch (_) { /* 已关 */ } },
    };
    watchers.set(id, entry);
    sender.once('destroyed', () => {
        if (watchers.get(id) === entry) { entry.close(); watchers.delete(id); }
    });
    return { success: true };
}

function register(ipcMain, deps) {
    ipcMain.handle('uttu-scriptorium:page', async (event, payload = {}) => {
        try {
            switch (payload.command) {
                case 'read': {
                    const result = await readPage(payload.file);
                    // 进“最近打开”。
                    if (result?.success) await Promise.resolve(deps.rememberRecentFile?.(result.filePath)).catch(() => {});
                    return result;
                }
                case 'save': return await savePage({ ...payload, senderId: event.sender.id });
                case 'watch': return watchPage(event.sender, payload.file);
                case 'check': await watchers.get(event.sender.id)?.check(); return { success: true };
                case 'pick-bridge': { // 批注模式打开时注入（./pick.js）
                    const frame = event.sender.mainFrame.framesInSubtree.find((item) => item.name === FRAME_NAME);
                    if (!frame) return { success: false, error: '网页还没显示出来。' };
                    return { success: await frame.executeJavaScript(require('./pick').BRIDGE) === true };
                }
                case 'locate': return { success: true, source: await require('./pick').locate(path.resolve(payload.file), payload.picked).catch(() => null) };
                case 'element-patch': return require('./edit').patch(String(payload.text ?? ''), payload.picked || {}, payload.change); // 网页元素直接改（./edit.js）
                case 'design-frames': return await require('./design').frames(payload, { grant, handles }); // 设计画布（./design.js）
                case 'design-frame-new': return await require('./design').newFrame(payload);
                case 'design-frame-copy': return await require('./design').copyFrame(payload, { handles });
                case 'frame-text': { // 给 Agent：网页框里排出来的字，脚本生成的也算
                    const frame = event.sender.mainFrame.framesInSubtree.find((item) => item.name === FRAME_NAME);
                    if (!frame) return { success: false, error: '网页还没显示出来。' };
                    return { success: true, text: await frame.executeJavaScript('document.body ? document.body.innerText : ""') };
                }
                case 'find': { // 网页里查找（./find.js）
                    const frame = event.sender.mainFrame.framesInSubtree.find((item) => item.name === FRAME_NAME);
                    if (!frame) return { success: false, error: '网页还没显示出来。' };
                    return { success: true, ...await frame.executeJavaScript(require('./find').script(payload.query, payload.index)) };
                }
                case 'reveal': {
                    if (!handles(payload.file)) return { success: false, error: '只能显示 .html / .htm 网页。' };
                    deps.shell.showItemInFolder(path.resolve(payload.file));
                    return { success: true };
                }
                default: return { success: false, error: '不认识的网页操作。' };
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = { SCHEME, PRIVILEGE, CSP, TYPES, handles, grant, resolveRequest, installProtocol, guardFrames, describe, readPage, savePage, register };
