'use strict';
// 文坊把 .html / .htm 作为网页原样打开，页面脚本照常执行；原来是导入为文稿，脚本和样式都会丢失。
//
// 显示：scriptorium-page://<令牌>/<相对路径>。令牌对应网页所在的 Git 仓库（不在仓库中时为其所在文件夹），
// 网页中的相对地址照常可用，但不能超出这个范围。只提供静态网页文件（下面 TYPES 中的扩展名）；
// 以点开头的文件和文件夹（.git、.env）及其他扩展名一律返回 404，因此 config.env、settings.json 之类无法读取。
// 每个响应带有自己的 CSP：禁止网络请求（connect-src 'none'），图片、字体、脚本只能来自本协议和 data/blob，
// 另外允许 Google Fonts 的样式和字体；nosniff 防止扩展名不符的文件被当作脚本或样式使用。
// 文坊把网页放进 sandbox="allow-scripts" 的 iframe（ScriptoriumModules/scriptorium-web-page.js）：来源不透明，
// 无法访问文坊页面及其接口和存储。
//
// 源码：scriptorium:page 读取、保存（只限 .html / .htm，并须在 fileAccess 允许的范围内），文件被外部修改时通知页面。
// frame-text：网页框中排版后的文字，供 Agent 读取（ScriptoriumModules/scriptorium-file-agent.js）。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { protocol } = require('electron');
// main.js 启动时就会加载本文件：以下模块依赖 jszip、fs-extra、iconv-lite，用到时才加载。
const rootOf = (...args) => require('../markdownFiles').rootOf(...args);
const decodeText = (...args) => require('../textEncoding').decodeText(...args);
const encodeText = (...args) => require('../textEncoding').encodeText(...args);
const allowed = (...args) => require('../fileAccess').allowed(...args);

const SCHEME = 'scriptorium-page';
// 在 app ready 之前登记（main.js）。
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

// 令牌 → 范围（真实路径）。同一范围始终使用同一令牌，网页内的相对链接和刷新不会改变地址。
const inlinePages = new Map();
const inlineOwners = new WeakSet();
function createInlinePage(sender, html) {
    const token = crypto.randomBytes(24).toString('hex');
    inlinePages.set(token, { senderId: sender.id, html: String(html) });
    if (!inlineOwners.has(sender)) {
        inlineOwners.add(sender);
        sender.once('destroyed', () => {
            for (const [key, value] of inlinePages) if (value.senderId === sender.id) inlinePages.delete(key);
        });
    }
    return `${SCHEME}://board-${token}/index.html`;
}
function removeInlinePage(sender, url) {
    const token = new URL(url).host.replace(/^board-/, '');
    if (inlinePages.get(token)?.senderId === sender.id) inlinePages.delete(token);
}
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
    if (!inside(real, root)) throw new Error('网页不在其所在的文件夹范围内。');
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

// 响应头声明 charset=utf-8，优先于页面中的 meta：GBK、UTF-16 的旧网页先转换再发送。
function utf8Of(body) {
    try {
        const { text, encoding } = decodeText(body);
        return encoding === 'utf-8' ? body : Buffer.from(text);
    } catch (_) {
        return body;
    }
}

// 找到地址对应的文件；不在范围内或不是静态网页文件时返回 null。
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
        const real = await fs.promises.realpath(full); // 链接、联接点指向范围外的不予提供
        if (!inside(real, root)) return null;
        const stat = await fs.promises.stat(real);
        if (!stat.isFile() || stat.size > MAX_BYTES) return null;
        return { file: real, extension, type: TYPES[extension] };
    } catch (_) {
        return null;
    }
}

// 安装在默认会话上（文坊独立窗口和主窗口标签页都使用默认会话）。
function installProtocol(protocolApi = protocol, appApi = require('electron').app) {
    if (appApi) guardFrames(appApi);
    protocolApi.handle(SCHEME, async (request) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') return respond(405, '', 'text/plain');
        const requested = new URL(request.url);
        if (requested.host.startsWith('board-')) {
            const page = inlinePages.get(requested.host.slice(6));
            if (!page || requested.pathname !== '/index.html') return respond(404, '', 'text/plain');
            const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
            return respond(200, page.html, 'text/html', { 'content-security-policy': policy });
        }
        const found = await resolveRequest(request.url);
        if (!found) return respond(404, '', 'text/plain');
        try {
            const body = request.method === 'HEAD' ? null : await fs.promises.readFile(found.file);
            if (body && TEXT.has(found.type)) return respond(200, utf8Of(body), found.type);
            // 来源不透明的网页读取字体需要通过 CORS。
            return respond(200, body, found.type, FONTS.has(found.extension) ? { 'access-control-allow-origin': '*' } : {});
        } catch (_) {
            return respond(404, '', 'text/plain');
        }
    });
}

// 网页框只能在自己的范围（同一令牌）内跳转。文坊页面的 CSP 只允许框内为本协议，跳往外网时先被其拦截，
// 框内变为错误页：按 iframe 的 name 认出网页框，通知文坊页面，由它把网页刷新回来，并询问是否用浏览器打开。
// 跳往其他 scriptorium-page 范围（CSP 允许）在这里拦截。只处理子框架。
const FRAME_NAME = 'scriptorium-page-frame';
const BLOCKED_BY_CSP = -30;
function guardFrames(appApi, frames = require('electron').webFrameMain) {
    appApi.on('web-contents-created', (_event, contents) => {
        const tell = (url) => {
            if (/^https?:\/\//i.test(url) && !contents.isDestroyed()) contents.send('scriptorium:page-blocked', { url });
        };
        contents.on('will-frame-navigate', (details) => {
            if (details.isMainFrame) return;
            const from = String(details.frame?.url || '');
            const to = String(details.url || '');
            if (!from.startsWith(`${SCHEME}://`) || !to.startsWith(`${SCHEME}:`)) return;
            try {
                if (new URL(to).host === new URL(from).host) return;
            } catch (_) { /* 地址无效，拦截 */ }
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

// 读取路径、“打开”对话框遇到 .html 时：告知页面这是网页，交给网页视图打开（不导入）。
function describe(file) {
    const resolved = path.resolve(file);
    return { success: true, kind: 'web-page', filePath: resolved, name: path.basename(resolved) };
}

async function pageFile(file, what) {
    const resolved = path.resolve(String(file || ''));
    if (!handles(resolved)) throw new Error(`只能${what} .html / .htm 网页。`);
    if (!(await allowed(resolved))) throw new Error('这份网页不在文库或最近打开的文件中，文坊不对它进行操作。');
    return resolved;
}

async function readPage(file) {
    const resolved = await pageFile(file, '打开');
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile()) throw new Error('找不到这份网页。');
    if (stat.size > MAX_PAGE_BYTES) throw new Error('网页超过 16 MB，文坊不打开。');
    const { text, encoding, bom } = decodeText(await fs.promises.readFile(resolved)); // 旧网页常为 GBK，源码也要正确读取并按原编码保存
    const { url, root } = await grant(resolved);
    return {
        success: true, filePath: resolved, name: path.basename(resolved), url, root,
        text: text.replace(/\r\n/g, '\n'), eol: /\r\n/.test(text) ? 'crlf' : 'lf', encoding, bom, mtime: stat.mtimeMs, size: stat.size,
    };
}

// 先写同一文件夹里的临时文件，再一步替换（atomicReplace.js），写入中断时原文件仍完好。
async function writeAtomically(target, data) {
    const temporary = `${target}.scriptorium-writing-${process.pid}-${Date.now()}`;
    try {
        await fs.promises.writeFile(temporary, data);
        await require('../atomicReplace').replaceWith(temporary, target);
    } finally {
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
    }
}

// 保存回原文件。文件被别处修改过（修改时间不一致）时不保存，交由页面询问；force 时照常保存。
async function savePage(payload) {
    const resolved = await pageFile(payload?.file, '保存');
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

// 每个文坊页面监视一份网页：文件变化（并非本页面刚保存的）时通知它。
const watchers = new Map();
async function watchPage(sender, file) {
    const id = sender.id;
    watchers.get(id)?.close();
    watchers.delete(id);
    if (!file) return { success: true };
    const resolved = await pageFile(file, '监视');
    let own = 0;
    let timer = null;
    let watcher = null;
    const check = async () => {
        const stat = await fs.promises.stat(resolved).catch(() => null);
        if (!stat || Math.abs(stat.mtimeMs - own) <= 1 || sender.isDestroyed()) return;
        own = stat.mtimeMs;
        sender.send('scriptorium:page-changed', { file: resolved, mtime: stat.mtimeMs });
    };
    try {
        // 编辑器保存时常先写临时文件再改名：监视所在文件夹，按文件名过滤。
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
    // 每 2 秒检查一次修改时间：文件夹改名、网络盘不发通知时仍能发现变化。页面重新获得焦点时也会立即检查。
    const poll = setInterval(() => { void check(); }, 2000);
    const entry = {
        check,
        saved(mtime) { own = mtime; },
        close() { clearTimeout(timer); clearInterval(poll); try { watcher?.close(); } catch (_) { /* 已关闭 */ } },
    };
    watchers.set(id, entry);
    sender.once('destroyed', () => {
        if (watchers.get(id) === entry) { entry.close(); watchers.delete(id); }
    });
    return { success: true };
}

function pageFrame(sender) {
    const frame = sender.mainFrame.framesInSubtree.find((item) => item.name === FRAME_NAME);
    if (!frame) throw new Error('网页尚未显示。');
    return frame;
}

function register(ipcMain, deps) {
    ipcMain.removeHandler('scriptorium:page');
    ipcMain.handle('scriptorium:page', async (event, payload = {}) => {
        try {
            switch (payload.command) {
                case 'read': {
                    const result = await readPage(payload.file);
                    if (result?.success) await Promise.resolve(deps.rememberRecentFile?.(result.filePath)).catch(() => {});
                    return result;
                }
                case 'save': return await savePage({ ...payload, senderId: event.sender.id });
                case 'watch': return await watchPage(event.sender, payload.file);
                case 'check': await watchers.get(event.sender.id)?.check(); return { success: true };
                // 网页框中排版后的文字，包括脚本生成的内容（供 Agent 读取）。
                case 'frame-text': return { success: true, text: await pageFrame(event.sender).executeJavaScript('document.body ? document.body.innerText : ""') };
                default: return { success: false, error: '未知的网页操作。' };
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = { createInlinePage, removeInlinePage, SCHEME, PRIVILEGE, CSP, TYPES, FRAME_NAME, handles, grant, resolveRequest, installProtocol, guardFrames, describe, readPage, savePage, register };
