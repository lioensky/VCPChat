// VCP (): 选中对话里的一段路径或网址（代码块里的也行），右键弹“打开方式”，代替上游的消息右键菜单。
// 选中的不像路径或网址时不管，照旧是上游菜单。文件链接（fileLinks.js）的右键用同一个菜单。
// 主进程 modules/uttu/openWith.js 重新认一遍、检查存在再开；这里只按文字决定列哪些项。样式是 uttu-file-links.css 的 .uttu-file-menu。
const menus = new WeakMap();

const IMPORTED = new Set(['docx', 'pptx', 'rtf']); // 导入成文稿；能就地打开的看文件类型登记表（scriptoriumTypes.js，main.html 载入）
const BROWSER = new Set(['html', 'htm', 'xhtml', 'svg', 'pdf', 'xml']);
const WRAP = /^[\s`'"“”‘’<(（「【]+|[\s`'"“”‘’>)）」】]+$/g;

// 选中的文字 → { kind: 'url' } 或 { kind: 'path', ext, folder }；不像就返回 null。主进程另有一份完整的认法。
export function classifySelection(text) {
    const value = String(text || '').replace(WRAP, '');
    if (!value || value.length > 1024 || /[\r\n]/.test(value)) return null;
    if (/^https?:\/\/\S+$/i.test(value)) return { kind: 'url', value };
    const plain = value.replace(/^file:\/\/\/?/i, '').replace(/[.,;:，。；：、]+$/, '')
        .replace(/(?::[1-9]\d*(?::[1-9]\d*)?|#L[1-9]\d*)$/, '');
    const absolute = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])/.test(plain);
    // 相对路径要带斜杠或扩展名，且不含空格，免得一句普通的话被当成路径。
    if (!absolute && (/\s/.test(plain) || !/[\\/]|\.[A-Za-z0-9_+-]+$/.test(plain))) return null;
    if (/[<>"|?*]/.test(plain.replace(/^[A-Za-z]:/, ''))) return null;
    const name = plain.split(/[\\/]/).filter(Boolean).pop() || '';
    const ext = /\.([A-Za-z0-9_+-]+)$/.exec(name)?.[1]?.toLowerCase() || '';
    // Dockerfile、LICENSE 这种没有扩展名的文件登记在 scriptoriumTypes 里，不当文件夹。
    const named = !ext && Boolean(globalThis.UTTUScriptoriumTypes?.opensInPlace?.(name));
    return { kind: 'path', value, ext, folder: !ext && !named, ...(named ? { named } : {}) };
}

function actionsFor(info, win, api) {
    const run = target => api.openWith({ text: info.value, target });
    if (info.kind === 'url') {
        return [
            ['browser', 'i-globe', '用内置浏览器打开', () => {
                if (!win.UTTUSidePane?.openUrl) throw new Error('内置浏览器还没准备好。');
                return win.UTTUSidePane.openUrl(info.value);
            }],
            ['system-browser', 'i-external', '用系统默认浏览器打开', () => run('system-browser')],
            null,
            ['copy', 'i-copy', '复制网址', () => win.navigator.clipboard.writeText(info.value)],
        ];
    }
    return [
        (info.folder || info.named || IMPORTED.has(info.ext) || win.UTTUScriptoriumTypes?.opensInPlace(`x.${info.ext}`)) && ['scriptorium', 'i-file', '用文坊打开', () => run('scriptorium')],
        BROWSER.has(info.ext) && ['system-browser', 'i-globe', '用系统默认浏览器打开', () => run('system-browser')],
        ['editor', 'i-code', '用 VS Code 打开', () => run('editor')],
        ['explorer', 'i-folder', info.folder ? '在资源管理器中打开' : '在资源管理器中显示', () => run('explorer')],
        !info.folder && ['default-app', 'i-external', '用系统默认程序打开', () => run('default-app')],
        null,
        ['copy', 'i-copy', '复制路径', () => win.navigator.clipboard.writeText(info.value.replace(WRAP, ''))],
    ].filter(item => item !== false);
}

function report(win, error) {
    const text = error?.message || String(error);
    if (win.uiHelper?.showToastNotification) win.uiHelper.showToastNotification(text, 'error');
    else console.warn('[VCP Open With]', text);
}

export function closeOpenWithMenu(doc) {
    menus.get(doc)?.();
}

// 在鼠标处弹菜单；text 是要打开的路径或网址。认不出返回 false（调用方照旧走自己的菜单）。
export function showOpenWithMenu(event, text, win, api = win.chatAPI || win.electronAPI) {
    const info = classifySelection(text);
    if (!info || typeof api?.openWith !== 'function') return false;
    const doc = win.document;
    closeOpenWithMenu(doc);
    doc.getElementById('chatContextMenu')?.remove();
    const menu = doc.createElement('div');
    menu.className = 'uttu-file-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '打开方式');
    const cleanup = () => {
        menu.remove();
        doc.removeEventListener('click', outside, true);
        doc.removeEventListener('contextmenu', outside, true);
        doc.removeEventListener('keydown', escape);
        win.removeEventListener('scroll', cleanup, true);
        win.removeEventListener('blur', cleanup);
        menus.delete(doc);
    };
    const outside = e => { if (!menu.contains(e.target)) cleanup(); };
    const escape = e => { if (e.key === 'Escape') cleanup(); };
    for (const item of actionsFor(info, win, api)) {
        if (!item) { menu.append(doc.createElement('hr')); continue; }
        const [action, icon, label, run] = item;
        const button = doc.createElement('button');
        button.type = 'button';
        button.dataset.action = action;
        button.setAttribute('role', 'menuitem');
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('aria-hidden', 'true');
        const use = doc.createElementNS(svg.namespaceURI, 'use');
        use.setAttribute('href', `assets/uttu/icons/uttu-icons.svg#${icon}`);
        svg.append(use);
        button.append(svg, doc.createTextNode(label));
        button.addEventListener('click', async () => {
            cleanup();
            try {
                const result = await run();
                if (result?.success === false || result?.error) throw new Error(result.error);
            } catch (error) { report(win, error); }
        });
        menu.append(button);
    }
    doc.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(event.clientX, win.innerWidth - rect.width))}px`;
    menu.style.top = `${Math.max(0, Math.min(event.clientY, win.innerHeight - rect.height))}px`;
    // 等这次右键事件走完再挂“点外面关掉”，不然它自己就把菜单关了。
    win.setTimeout(() => {
        if (!menu.isConnected) return;
        doc.addEventListener('click', outside, true);
        doc.addEventListener('contextmenu', outside, true);
    }, 0);
    doc.addEventListener('keydown', escape);
    win.addEventListener('scroll', cleanup, true);
    win.addEventListener('blur', cleanup);
    menus.set(doc, cleanup);
    return true;
}

// 消息里超链接的地址：file: 换成路径，页内锚点和 mailto: 这类不算。
export function linkTarget(href) {
    const value = String(href || '').trim();
    if (!value || value.startsWith('#')) return '';
    if (/^(?!https?:|file:|[A-Za-z]:[\\/])[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return '';
    try { return decodeURI(value); } catch (_) { return value; }
}

// 挂在 #chatMessages 上（捕获阶段，抢在上游消息菜单前面）：超链接，或选区在同一条消息里、像路径或网址才接手。
export function createOpenWithMenu({ root }) {
    if (!root) return Object.freeze({ dispose() {} });
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    const onContextMenu = (event) => {
        const link = event.target.closest?.('.message-item a[href]');
        const linked = link && root.contains(link) ? linkTarget(link.getAttribute('href')) : '';
        if (linked && showOpenWithMenu(event, linked, win)) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        const selection = win.getSelection?.();
        if (!selection || selection.isCollapsed || !selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        const message = event.target.closest?.('.message-item');
        if (!message || !root.contains(message) || !message.contains(range.commonAncestorContainer)) return;
        if (message.querySelector('.message-edit-textarea')) return; // 编辑中用上游的剪切、粘贴
        if (!showOpenWithMenu(event, selection.toString().trim(), win)) return;
        event.preventDefault();
        event.stopPropagation();
    };
    root.addEventListener('contextmenu', onContextMenu, true);
    win.UTTUOpenWithMenu = Object.freeze({ show: showOpenWithMenu, close: closeOpenWithMenu }); // fileLinks.js 的右键
    return Object.freeze({
        dispose() {
            root.removeEventListener('contextmenu', onContextMenu, true);
            closeOpenWithMenu(doc);
            delete win.UTTUOpenWithMenu;
        },
    });
}
