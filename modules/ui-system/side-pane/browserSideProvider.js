/**
 * modules/ui-system/side-pane/browserSideProvider.js
 * VCPChat Universal Sub-screen - Browser Provider
 *
 * A built-in browser tab: back / forward / reload, an address bar, a "more" menu (open in the default browser,
 * DevTools, clear browsing data), an empty state, load-error and crashed-page recovery. Pages run in an
 * isolated <webview> (fixed persistent partition, no preload, sandboxed) that the main process locks down in
 * modules/ipc/browserHandlers.js. Every tab is its own browser; window.open / target=_blank opens a new tab.
 */

'use strict';

export const BROWSER_PARTITION = 'persist:vcp-side-browser';
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'about:']);
const BLOCKED_ERROR_CODES = new Set([-3]); // ERR_ABORTED: a navigation replaced by another one
const INVALID_URL_MESSAGE = '仅支持 http、https、file、about 地址';
// 网页弹窗最多把浏览器标签开到这么多，再多就只提示不开
export const MAX_POPUP_BROWSER_TABS = 12;

/**
 * Turns whatever the user typed into an address the browser can open.
 * @returns {{ url: string } | { error: string } | null} null for empty input
 */
export function normalizeBrowserInput(input) {
    const text = String(input ?? '').trim();
    if (!text) return null;

    const hasPort = /^[^\s/@]+:\d+(?:[/?#]|$)/.test(text);
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !hasPort) {
        try {
            const url = new URL(text);
            return ALLOWED_PROTOCOLS.has(url.protocol) ? { url: url.href } : { error: INVALID_URL_MESSAGE };
        } catch (_error) {
            return { error: INVALID_URL_MESSAGE };
        }
    }
    if (/\s/.test(text)) return { error: INVALID_URL_MESSAGE };

    const host = text.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const isLocal = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1'
        || /^(?:127|10)\.\d+\.\d+\.\d+$/.test(host)
        || /^192\.168\.\d+\.\d+$/.test(host)
        || /^172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);
    if (!isLocal && !host.includes('.')) return { error: INVALID_URL_MESSAGE };
    try {
        return { url: new URL(`${isLocal ? 'http' : 'https'}://${text}`).href };
    } catch (_error) {
        return { error: INVALID_URL_MESSAGE };
    }
}

const SEARCH_URL = 'https://www.bing.com/search?q=';

/**
 * Like normalizeBrowserInput, but text that is not an address becomes a web search.
 * An unsupported scheme (javascript:, chrome:, ...) is still an error rather than a search.
 * @returns {{ url: string } | { error: string } | null} null for empty input
 */
export function resolveBrowserAddress(input) {
    const result = normalizeBrowserInput(input);
    if (!result?.error) return result;
    const text = String(input).trim();
    const hasPort = /^[^\s/@]+:\d+(?:[/?#]|$)/.test(text);
    if (/^[a-z][a-z0-9+.-]*:\S/i.test(text) && !hasPort) return result;
    return { url: `${SEARCH_URL}${encodeURIComponent(text)}` };
}

// Chromium net error codes -200..-299 are certificate problems
const isCertificateError = (code) => code <= -200 && code > -300;

export function createBrowserSideProvider({
    document: doc = document,
    api = (typeof window !== 'undefined' ? window.electronAPI : null),
    sidePaneController = null,
    notify = null
} = {}) {
    const kind = 'browser';
    let sequence = 0;
    /** @type {Map<string, { isBlank: () => boolean }>} */
    const mounted = new Map();

    const toast = (message, type = 'info') => {
        const fn = notify
            || doc.defaultView?.uiHelperFunctions?.showToastNotification
            || globalThis.uiHelperFunctions?.showToastNotification;
        fn?.(message, type);
    };

    async function openBrowserTab({ url = null, forceNew = false } = {}) {
        if (!sidePaneController) return null;
        // Reuse a tab that has not been used yet instead of piling up empty ones
        if (!url && !forceNew) {
            for (const [id, entry] of mounted) {
                if (entry.isBlank()) {
                    const handle = await sidePaneController.openTab({ id, kind, title: '浏览器', icon: 'public', closable: true, scopeMode: 'global' });
                    sidePaneController.setVisible?.(true);
                    handle?.focus?.();
                    return handle;
                }
            }
        }
        // 重启后恢复的浏览器标签也占着 browser:N，跳过已有的编号
        const openIds = new Set(sidePaneController.getSnapshot?.().tabs.map(tab => tab.id) || []);
        let id;
        do { id = `browser:${++sequence}`; } while (openIds.has(id));
        const handle = await sidePaneController.openTab({
            id,
            kind,
            title: '浏览器',
            icon: 'public',
            closable: true,
            scopeMode: 'global',
            payload: url ? { url } : {}
        });
        sidePaneController.setVisible?.(true);
        handle?.focus?.();
        return handle;
    }

    let unsubscribeOpenTab = null;
    const subscribeOpenTab = () => {
        if (unsubscribeOpenTab || typeof api?.onBrowserOpenTab !== 'function') return;
        unsubscribeOpenTab = api.onBrowserOpenTab((payload) => {
            if (!payload || typeof payload.url !== 'string') return;
            const result = normalizeBrowserInput(payload.url);
            if (!result?.url) return;
            const browserTabs = sidePaneController?.getSnapshot?.().tabs.filter(tab => tab.kind === kind).length || 0;
            if (browserTabs >= MAX_POPUP_BROWSER_TABS) {
                toast(`浏览器标签已有 ${browserTabs} 个，网页新开的窗口没有打开`, 'warning');
                return;
            }
            openBrowserTab({ url: result.url, forceNew: true });
        });
    };

    return {
        kind,
        openBrowserTab,

        async mountTab(tab, viewElement) {
            if (!viewElement) return null;
            subscribeOpenTab();
            viewElement.innerHTML = '';
            viewElement.classList.add('side-browser-view');

            let isDisposed = false;
            let webview = null;
            let domReady = false;
            let currentUrl = '';
            let loading = false;
            let lastFailure = null;
            let pendingUrl = '';

            const el = (tag, className, attrs = {}) => {
                const node = doc.createElement(tag);
                if (className) node.className = className;
                for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
                return node;
            };
            const iconButton = (icon, label) => {
                const btn = el('button', 'side-browser-btn', { type: 'button', 'aria-label': label, title: label });
                btn.innerHTML = `<span class="vcp-ui-icon">${icon}</span>`;
                return btn;
            };

            const container = el('div', 'side-browser-container');
            const toolbar = el('div', 'side-browser-toolbar');
            const backBtn = iconButton('arrow_back', '后退');
            const forwardBtn = iconButton('arrow_forward', '前进');
            const reloadBtn = iconButton('refresh', '刷新');
            const address = el('input', 'side-browser-address', {
                type: 'text',
                spellcheck: 'false',
                autocomplete: 'off',
                placeholder: '搜索或输入网址',
                'aria-label': '地址栏'
            });
            const moreBtn = iconButton('more_horiz', '更多浏览器操作');
            const menu = el('div', 'side-browser-menu', { role: 'menu' });
            menu.hidden = true;
            const menuItem = (icon, label, action) => {
                const item = el('button', 'side-browser-menu-item', { type: 'button', role: 'menuitem', 'data-action': action });
                item.innerHTML = `<span class="vcp-ui-icon">${icon}</span><span></span>`;
                item.lastElementChild.textContent = label;
                return item;
            };
            const openExternalItem = menuItem('open_in_new', '在默认浏览器中打开', 'open-external');
            const devtoolsItem = menuItem('bug_report', '打开调试工具', 'devtools');
            const clearDataItem = menuItem('delete', '清除浏览数据', 'clear-data');
            menu.append(openExternalItem, devtoolsItem, clearDataItem);
            toolbar.append(backBtn, forwardBtn, reloadBtn, address, moreBtn);

            const body = el('div', 'side-browser-body');
            const empty = el('div', 'side-browser-empty');
            empty.innerHTML = '<span class="vcp-ui-icon">public</span><span class="side-browser-empty-text"></span>';
            empty.querySelector('.side-browser-empty-text').textContent = '粘贴或输入 URL 以打开网页。';
            const notice = el('div', 'side-browser-notice');
            notice.hidden = true;
            const noticeTitle = el('div', 'side-browser-notice-title');
            const noticeDetail = el('div', 'side-browser-notice-detail');
            const noticeHint = el('div', 'side-browser-notice-hint');
            const noticeRetry = el('button', 'side-browser-notice-retry', { type: 'button' });
            notice.append(noticeTitle, noticeDetail, noticeHint, noticeRetry);
            body.append(empty, notice);

            container.append(toolbar, body, menu);
            viewElement.appendChild(container);

            const hasPage = () => Boolean(webview);
            const canUseGuest = () => Boolean(webview && domReady && !isDisposed);

            const hideNotice = () => {
                notice.hidden = true;
                lastFailure = null;
            };
            const showNotice = ({ title, detail = '', hint = '', retryLabel = '重新加载', onRetry }) => {
                noticeTitle.textContent = title;
                noticeDetail.textContent = detail;
                noticeHint.textContent = hint;
                noticeHint.hidden = !hint;
                noticeRetry.textContent = retryLabel;
                noticeRetry.onclick = onRetry;
                notice.hidden = false;
            };

            const syncControls = () => {
                let canBack = false;
                let canForward = false;
                if (canUseGuest()) {
                    try {
                        canBack = webview.canGoBack();
                        canForward = webview.canGoForward();
                    } catch (_error) {
                        // guest is being torn down
                    }
                }
                backBtn.disabled = !canBack;
                forwardBtn.disabled = !canForward;
                const icon = reloadBtn.querySelector('.vcp-ui-icon');
                icon.textContent = loading ? 'close' : 'refresh';
                reloadBtn.title = loading ? '停止加载' : '刷新';
                reloadBtn.setAttribute('aria-label', reloadBtn.title);
                reloadBtn.disabled = !hasPage() && !pendingUrl;
                const hasUrl = /^https?:/i.test(currentUrl);
                openExternalItem.disabled = !hasUrl;
                devtoolsItem.disabled = !canUseGuest();
                empty.hidden = hasPage();
                if (webview) webview.hidden = Boolean(lastFailure);
            };

            const setAddress = (url) => {
                const changed = Boolean(url) && url !== currentUrl;
                currentUrl = url || '';
                // 关掉后从「最近关闭」重新打开时回到最后看的页面
                if (changed && /^https?:|^file:/i.test(currentUrl)) sidePaneController?.updateTab?.(tab.id, { payload: { url: currentUrl } });
                if (doc.activeElement !== address) address.value = currentUrl === 'about:blank' ? '' : currentUrl;
                address.title = currentUrl;
            };

            // The first page is the guest's initial navigation (no about:blank entry in its history).
            const ensureWebview = (initialUrl) => {
                if (webview) return webview;
                webview = doc.createElement('webview');
                webview.className = 'side-browser-webview';
                webview.setAttribute('partition', BROWSER_PARTITION);
                // popups are always denied by the main process and re-routed into a new side-pane tab
                webview.setAttribute('allowpopups', '');
                webview.setAttribute('src', initialUrl);
                body.insertBefore(webview, notice);
                wireWebview(webview);
                return webview;
            };

            function wireWebview(guest) {
                const on = (name, handler) => guest.addEventListener(name, (event) => {
                    if (!isDisposed && guest === webview) handler(event);
                });
                on('dom-ready', () => {
                    domReady = true;
                    if (pendingUrl) {
                        const target = pendingUrl;
                        pendingUrl = '';
                        guest.loadURL(target).catch(() => { /* reported through did-fail-load */ });
                    }
                    syncControls();
                });
                on('did-start-loading', () => {
                    loading = true;
                    hideNotice();
                    syncControls();
                });
                on('did-stop-loading', () => {
                    loading = false;
                    try {
                        setAddress(guest.getURL());
                    } catch (_error) {
                        // not attached yet
                    }
                    syncControls();
                });
                on('did-navigate', (event) => {
                    setAddress(event.url);
                    syncControls();
                });
                on('did-navigate-in-page', (event) => {
                    if (event.isMainFrame !== false) setAddress(event.url);
                    syncControls();
                });
                on('page-title-updated', (event) => {
                    address.setAttribute('aria-description', event.title || '');
                    // 标签标题跟着页面标题走（ZCode 同样以页面标题作为浏览器标签名）
                    sidePaneController?.updateTab?.(tab.id, { title: event.title || '浏览器' });
                });
                on('did-fail-load', (event) => {
                    if (event.isMainFrame === false || BLOCKED_ERROR_CODES.has(event.errorCode)) return;
                    lastFailure = event;
                    const cert = isCertificateError(event.errorCode);
                    showNotice({
                        title: cert ? '该站点的 HTTPS 证书不受信任' : '无法打开该页面',
                        detail: `${event.validatedURL || currentUrl}\n${event.errorDescription || ''}${event.errorCode ? `（${event.errorCode}）` : ''}`.trim(),
                        hint: cert ? '如果确认该地址可信，可以在「更多」菜单里选择「在默认浏览器中打开」。' : '',
                        onRetry: () => reload()
                    });
                    syncControls();
                });
                on('render-process-gone', (event) => {
                    loading = false;
                    lastFailure = { crashed: true };
                    showNotice({
                        title: '页面已停止响应',
                        detail: `页面进程已退出：${event.reason || 'unknown'}（退出码 ${event.exitCode ?? '?'}）`,
                        hint: '',
                        retryLabel: '重试浏览器',
                        onRetry: () => {
                            const target = currentUrl;
                            resetWebview();
                            if (target) navigate(target);
                        }
                    });
                    syncControls();
                });
            }

            function resetWebview() {
                if (webview) {
                    const old = webview;
                    webview = null;
                    domReady = false;
                    loading = false;
                    old.remove();
                }
                hideNotice();
                syncControls();
            }

            function navigate(url) {
                hideNotice();
                const created = !webview;
                const guest = ensureWebview(url);
                setAddress(url);
                if (!created) {
                    if (domReady) {
                        guest.loadURL(url).catch(() => { /* reported through did-fail-load */ });
                    } else {
                        pendingUrl = url;
                    }
                }
                syncControls();
            }

            function reload() {
                if (lastFailure?.crashed) {
                    const target = currentUrl;
                    resetWebview();
                    if (target) navigate(target);
                    return;
                }
                if (!canUseGuest()) {
                    if (pendingUrl) navigate(pendingUrl);
                    return;
                }
                hideNotice();
                if (lastFailure?.validatedURL) {
                    webview.loadURL(lastFailure.validatedURL).catch(() => { /* reported through did-fail-load */ });
                } else {
                    webview.reload();
                }
            }

            const submitAddress = () => {
                const result = resolveBrowserAddress(address.value);
                if (!result) return;
                if (result.error) {
                    toast(result.error, 'warning');
                    return;
                }
                navigate(result.url);
                webview?.focus?.();
            };

            const closeMenu = () => { menu.hidden = true; };
            const onDocumentPointerDown = (event) => {
                if (!menu.hidden && !menu.contains(event.target) && !moreBtn.contains(event.target)) closeMenu();
            };
            doc.addEventListener('pointerdown', onDocumentPointerDown, true);

            address.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    submitAddress();
                } else if (event.key === 'Escape') {
                    address.value = currentUrl === 'about:blank' ? '' : currentUrl;
                    address.blur();
                }
            });
            address.addEventListener('focus', () => address.select());
            backBtn.addEventListener('click', () => { if (canUseGuest() && webview.canGoBack()) webview.goBack(); });
            forwardBtn.addEventListener('click', () => { if (canUseGuest() && webview.canGoForward()) webview.goForward(); });
            reloadBtn.addEventListener('click', () => {
                if (loading && canUseGuest()) webview.stop();
                else reload();
            });
            moreBtn.addEventListener('click', () => {
                syncControls();
                menu.hidden = !menu.hidden;
            });
            menu.addEventListener('click', async (event) => {
                const item = event.target.closest('[data-action]');
                if (!item || item.disabled) return;
                closeMenu();
                const action = item.getAttribute('data-action');
                if (action === 'open-external') {
                    const res = await api?.browserOpenExternal?.(currentUrl);
                    if (res && !res.success) toast(res.error || '无法在默认浏览器中打开', 'warning');
                } else if (action === 'devtools') {
                    if (canUseGuest()) webview.openDevTools();
                } else if (action === 'clear-data') {
                    const res = await api?.browserClearData?.();
                    toast(res?.success ? '已清除浏览数据' : (res?.error || '清除浏览数据失败'), res?.success ? 'success' : 'warning');
                }
            });

            if (typeof doc.createElement('webview').loadURL !== 'function') {
                // <webview> not available in this window (e.g. not the main window): show an explanation instead
                empty.querySelector('.side-browser-empty-text').textContent = '当前窗口不支持内置浏览器。';
            }

            const initialUrl = tab?.payload?.url;
            syncControls();
            if (initialUrl) {
                const result = normalizeBrowserInput(initialUrl);
                if (result?.url) navigate(result.url);
            }

            const entry = { isBlank: () => !hasPage() && !pendingUrl };
            mounted.set(tab.id, entry);

            return {
                focus() {
                    if (!hasPage()) address.focus();
                },
                getUrl() {
                    return currentUrl;
                },
                navigate(input) {
                    const result = normalizeBrowserInput(input);
                    if (result?.url) navigate(result.url);
                    return result;
                },
                dispose() {
                    isDisposed = true;
                    mounted.delete(tab.id);
                    doc.removeEventListener('pointerdown', onDocumentPointerDown, true);
                    if (webview) {
                        webview.remove();
                        webview = null;
                    }
                    viewElement.innerHTML = '';
                    if (mounted.size === 0) {
                        unsubscribeOpenTab?.();
                        unsubscribeOpenTab = null;
                    }
                }
            };
        }
    };
}
