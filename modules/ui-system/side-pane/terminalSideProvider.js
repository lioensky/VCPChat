/**
 * modules/ui-system/side-pane/terminalSideProvider.js
 * VCPChat Universal Sub-screen - Terminal Provider
 *
 * A side pane view of VCPChat's own terminal (the PowerShellExecutor PTY session shared by the tray
 * "终端" window and the AI tool). Output is mirrored here through xterm; input and resizing go to the
 * same session. Workspaces are offered as "jump to directory" shortcuts.
 */

'use strict';

import { getHttpLinksForTerminalBufferLine } from './terminalLinks.js';
import { buildTerminalTheme } from './terminalTheme.js';

const GO_OPTION_VALUE = '';
const SINGLETON_TAB_ID = 'terminal:main';
const XTERM_SCRIPT = 'vendor/xterm/xterm.js';
const XTERM_FIT_SCRIPT = 'vendor/xterm/xterm-addon-fit.js';
const XTERM_STYLE = 'vendor/xterm/xterm.css';

function loadScript(doc, src) {
    return new Promise((resolve, reject) => {
        const script = doc.createElement('script');
        script.src = new URL(src, doc.baseURI).href;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`无法加载 ${src}`));
        doc.head.appendChild(script);
    });
}

/**
 * Loads xterm + fit addon into the page once and returns their constructors.
 */
export async function loadXterm(doc) {
    const win = doc.defaultView;
    if (!win.Terminal) await loadScript(doc, XTERM_SCRIPT);
    if (!win.FitAddon) await loadScript(doc, XTERM_FIT_SCRIPT);
    if (!doc.querySelector('link[data-vcp-xterm-style]')) {
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL(XTERM_STYLE, doc.baseURI).href;
        link.setAttribute('data-vcp-xterm-style', '');
        doc.head.appendChild(link);
    }
    return { Terminal: win.Terminal, FitAddon: win.FitAddon?.FitAddon };
}

export function createTerminalSideProvider({
    document: doc = document,
    api = (typeof window !== 'undefined' ? window.electronAPI : null),
    sidePaneController = null,
    xtermLoader = loadXterm,
    onOpenUrl = null // 点击终端里的 http(s) 链接：交给自带浏览器标签打开
} = {}) {
    const kind = 'terminal';

    return {
        kind,

        /**
         * Opens (or focuses) the terminal tab. There is a single shared session, so there is a single tab.
         */
        async openTerminalTab(options = {}) {
            if (!sidePaneController) return null;
            return sidePaneController.openTab({
                id: SINGLETON_TAB_ID,
                kind,
                title: '终端',
                icon: 'terminal',
                closable: true,
                scopeMode: 'global',
                ...options
            });
        },

        async mountTab(tab, viewElement) {
            if (!viewElement) return null;
            viewElement.innerHTML = '';
            viewElement.classList.add('side-terminal-view');

            let isDisposed = false;
            let term = null;
            let fitAddon = null;
            let sessionId = null;
            let generation = 0; // guards against a late create result after dispose / re-attach
            let connectionOperation = null;
            let exited = false;
            let unsubscribeData = null;
            let unsubscribeClear = null;
            let unsubscribeExit = null;
            let resizeObserver = null;
            let resizeTimer = null;

            const container = doc.createElement('div');
            container.className = 'side-terminal-container';

            const toolbar = doc.createElement('div');
            toolbar.className = 'side-terminal-toolbar';

            const wsSelect = doc.createElement('select');
            wsSelect.className = 'side-terminal-ws-select';
            wsSelect.setAttribute('aria-label', '跳转到工作区目录');
            wsSelect.title = '在终端里切换到所选工作区的根目录';
            const goOption = doc.createElement('option');
            goOption.value = GO_OPTION_VALUE;
            goOption.textContent = '跳转到工作区…';
            wsSelect.appendChild(goOption);

            const statusEl = doc.createElement('span');
            statusEl.className = 'side-terminal-status';

            const restartBtn = doc.createElement('button');
            restartBtn.type = 'button';
            restartBtn.className = 'side-terminal-btn';
            restartBtn.title = '重新启动终端（终端窗口和 AI 共用同一个会话，会一并重置）';
            restartBtn.setAttribute('aria-label', '重新启动终端');
            restartBtn.innerHTML = '<span class="vcp-ui-icon">refresh</span>';

            const clearBtn = doc.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'side-terminal-btn';
            clearBtn.title = '清屏';
            clearBtn.setAttribute('aria-label', '清屏');
            clearBtn.innerHTML = '<span class="vcp-ui-icon">delete_sweep</span>';

            // 和浏览器 / Git 顶栏同一套胶囊：工作区下拉一个胶囊，清屏 + 重启合成一个胶囊
            const wsPill = doc.createElement('span');
            wsPill.className = 'side-terminal-select-pill';
            const chevron = doc.createElement('span');
            chevron.className = 'vcp-ui-icon side-terminal-select-chevron';
            chevron.setAttribute('aria-hidden', 'true');
            chevron.textContent = 'expand_more';
            // 连接状态只用胶囊左侧一个小圆点表示，文字留给悬停提示；出错或过渡中才在旁边显示文字
            const statusDot = doc.createElement('span');
            statusDot.className = 'side-terminal-status-dot';
            statusDot.setAttribute('aria-hidden', 'true');
            wsPill.append(statusDot, wsSelect, chevron);

            const actions = doc.createElement('div');
            actions.className = 'side-terminal-actions';
            const divider = doc.createElement('span');
            divider.className = 'side-terminal-actions-divider';
            divider.setAttribute('aria-hidden', 'true');
            actions.append(clearBtn, divider, restartBtn);

            toolbar.append(wsPill, statusEl, actions);

            const screen = doc.createElement('div');
            screen.className = 'side-terminal-screen';

            container.append(toolbar, screen);
            viewElement.appendChild(container);

            // state: connected | pending | exited | error
            const setStatus = (text, state = 'pending') => {
                statusEl.textContent = state === 'connected' ? '' : text;
                statusEl.dataset.state = state;
                statusEl.classList.toggle('is-error', state === 'error');
                statusDot.dataset.state = state;
                wsSelect.title = `${text} · 选择工作区，在终端里切到它的根目录`;
            };

            if (typeof api?.terminalCreate !== 'function') {
                setStatus('当前窗口不支持终端', 'error');
                return { focus() {}, dispose() { viewElement.innerHTML = ''; } };
            }

            // Workspaces (shared with the Git tab / V工程) as "jump to directory" shortcuts
            try {
                const res = await api.gitListWorkspaces?.();
                const workspaces = res?.data?.workspaces || [];
                for (const ws of workspaces) {
                    const opt = doc.createElement('option');
                    opt.value = ws.id;
                    opt.textContent = ws.alias || ws.path;
                    opt.title = ws.path;
                    wsSelect.appendChild(opt);
                }
            } catch (_error) {
                // no shortcuts
            }
            wsSelect.disabled = wsSelect.options.length <= 1;

            let xterm;
            try {
                xterm = await xtermLoader(doc);
            } catch (err) {
                setStatus(`终端组件加载失败: ${err?.message || err}`, 'error');
                return { focus() {}, dispose() { viewElement.innerHTML = ''; } };
            }
            if (isDisposed) return null;

            const initialTheme = buildTerminalTheme(doc, screen);
            term = new xterm.Terminal({
                cursorBlink: true,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                fontSize: 13,
                scrollback: 5000,
                allowProposedApi: false,
                theme: initialTheme
            });
            // 外框底色由 CSS 给出，xterm 从外框读取同一颜色，明暗主题切换时跟着换调色板。
            const applyTheme = () => {
                const theme = buildTerminalTheme(doc, screen);
                if (term?.options) term.options.theme = theme;
            };
            const ThemeObserver = doc.defaultView?.MutationObserver;
            const themeObserver = ThemeObserver && doc.body ? new ThemeObserver(applyTheme) : null;
            themeObserver?.observe(doc.body, { attributes: true, attributeFilter: ['class', 'data-vcp-theme'] });
            if (xterm.FitAddon) {
                fitAddon = new xterm.FitAddon();
                term.loadAddon(fitAddon);
            }
            term.open(screen);

            if (onOpenUrl && typeof term.registerLinkProvider === 'function') {
                term.registerLinkProvider({
                    provideLinks(bufferLineNumber, callback) {
                        const links = getHttpLinksForTerminalBufferLine(term.buffer.active, bufferLineNumber, term.cols);
                        callback(links?.map(link => ({
                            ...link,
                            activate(event, text) {
                                event?.preventDefault?.();
                                onOpenUrl(text);
                            }
                        })));
                    }
                });
            }

            const fit = () => {
                if (isDisposed || !fitAddon || !screen.offsetWidth || !screen.offsetHeight) return;
                try {
                    fitAddon.fit();
                } catch (_error) {
                    // hidden or zero-size container
                }
            };

            term.onData((data) => {
                if (sessionId) api.terminalWrite?.(sessionId, data);
            });
            // The PTY has a single size shared by every view of it (this tab and the terminal window), so a view
            // only pushes its size while it has focus, and claims it again whenever it gets focus.
            const hasFocus = () => screen.contains(doc.activeElement);
            const claimSize = () => {
                if (sessionId && !isDisposed) api.terminalResize?.(sessionId, term.cols, term.rows);
            };
            term.onResize(() => {
                if (hasFocus()) claimSize();
            });
            screen.addEventListener('focusin', claimSize);

            unsubscribeData = api.onTerminalData?.((payload) => {
                if (payload?.id === sessionId && typeof payload.data === 'string') term.write(payload.data);
            });
            unsubscribeClear = api.onTerminalClear?.((payload) => {
                if (payload?.id === sessionId) term.reset();
            });
            unsubscribeExit = api.onTerminalExit?.((payload) => {
                if (payload?.id !== sessionId) return;
                exited = true;
                term.write(`\r\n\x1b[2m[进程已退出，代码 ${payload.exitCode ?? '?'}，点击右上角刷新按钮重新启动]\x1b[0m\r\n`);
                setStatus('终端已退出', 'exited');
            });

            // One admitted create/restart at a time; transport rejection remains retryable.
            function runConnection(action) {
                if (isDisposed) return Promise.resolve();
                if (connectionOperation) return connectionOperation;
                connectionOperation = Promise.resolve().then(() => {
                    if (!isDisposed) return action();
                }).catch(error => {
                    if (isDisposed) return;
                    const message = error?.message || String(error);
                    setStatus(message, 'error');
                    term.write(`\x1b[31m${message}\x1b[0m\r\n`);
                }).finally(() => { connectionOperation = null; });
                return connectionOperation;
            }

            // Attaches this view to the shared terminal session (starting it when none is running).
            function attachSession() {
                return runConnection(async () => {
                    const myGeneration = ++generation;
                    fit();
                    setStatus('连接中...');
                    // 在屏上打开时带上自己的尺寸，让新会话一开始就按这个宽度排版
                    const res = await api.terminalCreate(screen.offsetWidth ? { cols: term.cols, rows: term.rows } : {});
                    if (isDisposed || myGeneration !== generation) {
                        if (res?.success) api.terminalKill?.(res.data.id);
                        return;
                    }
                    if (!res?.success) {
                        setStatus(res?.error || '终端启动失败', 'error');
                        term.write(`\x1b[31m${res?.error || '终端启动失败'}\x1b[0m\r\n`);
                        return;
                    }
                    sessionId = res.data.id;
                    exited = false;
                    setStatus('已连接终端', 'connected');
                    wsSelect.title = `已连接终端 · 与终端窗口 / AI 命令共用同一个会话${res.data.pid ? ` · PID ${res.data.pid}` : ''}`;
                    if (screen.offsetWidth) claimSize(); // opened on screen: take over the size
                });
            }

            function restartSession() {
                if (isDisposed) return Promise.resolve();
                if (connectionOperation) return connectionOperation;
                if (sessionId && !doc.defaultView.confirm('重新启动共享终端？AI 工具、终端窗口和所有侧栏视图的当前命令都会中止。')) return;
                if (!sessionId) return attachSession();
                return runConnection(async () => {
                    setStatus('重启中...');
                    const res = await api.terminalRestart(sessionId);
                    if (isDisposed) return;
                    if (!res?.success) {
                        setStatus(res?.error || '终端重启失败', 'error');
                        return;
                    }
                    exited = false;
                    setStatus('已连接终端', 'connected');
                    claimSize();
                });
            }

            wsSelect.addEventListener('change', async () => {
                const workspaceId = wsSelect.value;
                wsSelect.value = GO_OPTION_VALUE;
                if (!workspaceId || !sessionId) return;
                if (exited) {
                    setStatus('终端已退出，请先重新启动', 'error');
                    return;
                }
                const res = await api.terminalChangeDirectory(sessionId, workspaceId);
                if (isDisposed) return;
                if (!res?.success) {
                    setStatus(res?.error || '切换目录失败', 'error');
                    return;
                }
                setStatus('已连接终端', 'connected');
                term.focus();
            });
            restartBtn.addEventListener('click', () => {
                restartSession();
                term.focus();
            });
            clearBtn.addEventListener('click', () => {
                term.clear();
                term.focus();
            });

            if (typeof doc.defaultView.ResizeObserver === 'function') {
                resizeObserver = new doc.defaultView.ResizeObserver(() => {
                    clearTimeout(resizeTimer);
                    resizeTimer = setTimeout(fit, 30);
                });
                resizeObserver.observe(screen);
            }

            fit();
            await attachSession();

            return {
                focus() {
                    fit();
                    term?.focus();
                    claimSize();
                },
                getSessionId() {
                    return sessionId;
                },
                dispose() {
                    if (isDisposed) return;
                    isDisposed = true;
                    generation += 1;
                    clearTimeout(resizeTimer);
                    resizeObserver?.disconnect();
                    themeObserver?.disconnect();
                    unsubscribeData?.();
                    unsubscribeClear?.();
                    unsubscribeExit?.();
                    // Only closes this view; the terminal session belongs to VCPChat's terminal.
                    if (sessionId) api.terminalKill?.(sessionId);
                    sessionId = null;
                    try {
                        term?.dispose();
                    } catch (_error) {
                        // already disposed
                    }
                    viewElement.innerHTML = '';
                }
            };
        }
    };
}
