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
import { normalizePowerShellReadlineRedraw } from './terminalDataTransform.js';
import { createSidePaneRootScope } from './side-pane-occurrence.js';

const GO_OPTION_VALUE = '';
const SINGLETON_TAB_ID = 'terminal:main';
const XTERM_SCRIPT = 'vendor/xterm/xterm.js';
const XTERM_FIT_SCRIPT = 'vendor/xterm/xterm-addon-fit.js';
const XTERM_STYLE = 'vendor/xterm/xterm.css';
// 容器尺寸变化后多久重新排版：平时 30ms；拖侧栏分隔条期间等停下 300ms
const FIT_DEBOUNCE_MS = 30;
const FIT_WHILE_RESIZING_MS = 300;
// 连接建立前最多替用户攒这么多输入（敲键盘够用，大段粘贴不攒）
const PENDING_INPUT_LIMIT = 4096;
// 主进程一次最多收这么多字符（terminalHandlers MAX_WRITE_CHARS），再大的粘贴整段被拒；提示停留多久
const WRITE_LIMIT_CHARS = 1024 * 1024;
const WRITE_REJECTED_NOTICE_MS = 4000;

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

// 休眠时终端画面（xterm 的宿主节点）先收进这里，会话和回滚记录不动；重新挂载时移回去
function stashFor(doc) {
    let stash = doc.querySelector('[data-side-terminal-stash]');
    if (!stash && doc.body) {
        stash = doc.createElement('div');
        stash.hidden = true;
        stash.setAttribute('data-side-terminal-stash', '');
        stash.setAttribute('aria-hidden', 'true');
        doc.body.appendChild(stash);
    }
    return stash;
}

/** 把终端画面从暂存处移到 parent；暂存处空了就一起拿掉 */
function placeScreen(screen, parent) {
    const previous = screen.parentElement;
    if (parent) parent.append(screen);
    else screen.remove();
    if (previous !== parent && previous?.hasAttribute?.('data-side-terminal-stash') && !previous.firstChild) previous.remove();
}

export function createTerminalSideProvider({
    document: doc = document,
    api = (typeof window !== 'undefined' ? window.electronAPI : null),
    sidePaneController = null,
    xtermLoader = loadXterm,
    onOpenUrl = null, // 点击终端里的 http(s) 链接：交给自带浏览器标签打开
    uiHelper = null
} = {}) {
    // 用应用自己的确认框（和其他标签一致）；原生 confirm 会弹系统模态框卡住整个窗口，只在没有应用确认框时退回
    const confirmAction = async (message, title, confirmText) => (typeof uiHelper?.showConfirmDialog === 'function'
        ? uiHelper.showConfirmDialog(message, title, confirmText, '取消', true)
        : doc.defaultView.confirm(message));
    const kind = 'terminal';
    // 标签打开期间的终端会话：xterm、对共享终端的连接、输出订阅都在这里，视图休眠不动它们，关标签才释放
    const sessions = new WeakMap(); // occurrence -> session

    /**
     * @param {AbortSignal | null} signal 标签关掉时 abort；没有时（旧的两参数挂载）由视图的 dispose 一起释放
     */
    function createSession(xterm, signal) {
        const screen = doc.createElement('div');
        screen.className = 'side-terminal-screen';

        const session = {
            screen,
            term: null,
            fitAddon: null,
            sessionId: null,
            exited: false,
            disposed: false,
            generation: 0, // guards against a late create result after dispose / re-attach
            connectionOperation: null,
            status: { text: '连接中...', state: 'pending', title: '' },
            view: null, // 当前挂着的视图：{ render() }
            dispose: null
        };

        const initialTheme = buildTerminalTheme(doc, screen);
        const term = new xterm.Terminal({
            // 光标不闪：xterm 的闪烁动画让侧栏里一个空闲终端每秒重算样式约 55 次（约 2.5% 单核），用 xterm 默认的不闪烁光标。
            cursorBlink: false,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: 13,
            scrollback: 5000,
            allowProposedApi: false,
            theme: initialTheme,
            // OSC 8 超链接：不走 xterm 默认的 confirm + window.open（会在主窗口外开一个默认 session 的窗口），
            // 和普通链接一样只开 http(s)，交给侧栏浏览器
            linkHandler: {
                allowNonHttpProtocols: false,
                activate(event, text) {
                    event?.preventDefault?.();
                    if (!onOpenUrl || !/^https?:\/\//i.test(String(text || ''))) return;
                    onOpenUrl(text);
                }
            }
        });
        session.term = term;
        // 有选区时 Ctrl/Cmd+C 复制选区，不给共享 PTY 发 ^C（会打断 AI 正在跑的命令）；
        // 副屏自己的快捷键（Ctrl/Cmd+Alt+B、Ctrl+PageUp/PageDown）不写进 shell
        term.attachCustomKeyEventHandler?.((event) => {
            if (event.type !== 'keydown') return true;
            const mod = event.ctrlKey || event.metaKey;
            if (!mod) return true;
            const key = String(event.key || '').toLowerCase();
            if (key === 'c' && !event.altKey && !event.shiftKey && term.hasSelection?.()) {
                const text = term.getSelection();
                const clipboard = doc.defaultView?.navigator?.clipboard;
                clipboard?.writeText?.(text)?.catch?.(error => console.warn('[SideTerminal] Copy failed:', error));
                return false;
            }
            if (event.altKey && key === 'b') return false;
            if (event.ctrlKey && (event.key === 'PageUp' || event.key === 'PageDown')) return false;
            return true;
        });
        // 外框底色由 CSS 给出，xterm 从外框读取同一颜色，明暗主题切换时跟着换调色板。
        // 只有画面挂在侧栏里时 CSS 才算得出来（新建的节点和暂存区都读到回退色），所以挂上之后再算；
        // 收着的时候只记一笔，下次挂上时重算。颜色没变就不赋值：每次赋值 xterm 都整屏重绘
        // （拖动分隔条时 body 的 class 也会变）
        let appliedTheme = JSON.stringify(initialTheme);
        let themeStale = false;
        const applyTheme = () => {
            if (!term?.options) return;
            if (!screen.isConnected || screen.closest?.('[data-side-terminal-stash]')) { themeStale = true; return; }
            themeStale = false;
            const theme = buildTerminalTheme(doc, screen);
            const serialized = JSON.stringify(theme);
            if (serialized === appliedTheme) return;
            appliedTheme = serialized;
            term.options.theme = theme;
        };
        session.applyTheme = applyTheme;
        const ThemeObserver = doc.defaultView?.MutationObserver;
        const themeObserver = ThemeObserver && doc.body ? new ThemeObserver(applyTheme) : null;
        themeObserver?.observe(doc.body, { attributes: true, attributeFilter: ['class', 'data-vcp-theme'] });
        if (xterm.FitAddon) {
            session.fitAddon = new xterm.FitAddon();
            term.loadAddon(session.fitAddon);
        }

        const setStatus = (text, state = 'pending', title = '') => {
            session.status = { text, state, title };
            session.view?.render();
        };
        session.setStatus = setStatus;

        session.fit = () => {
            if (session.disposed || !session.fitAddon || !screen.offsetWidth || !screen.offsetHeight) return;
            // 不持有尺寸的视图跟着 PTY 的真实尺寸画，不按自己的容器排
            if (session.ptySize && !hasFocus()) {
                followPtySize();
                return;
            }
            try {
                session.fitAddon.fit();
            } catch (_error) {
                // hidden or zero-size container
            }
        };

        // 连接建立之前敲的字先攒着，连上后按顺序补发（打开标签就开始敲，不该丢字）；连不上就丢掉
        let pendingInput = '';
        // 超过上限的粘贴主进程会整段拒收，以前悄无声息；在状态栏说一声，过几秒恢复原来的状态
        const noticeRejectedWrite = () => {
            const previous = session.status;
            const notice = { text: '粘贴的内容超过 1MB，没有发送到终端', state: 'error', title: previous?.title || '' };
            session.status = notice;
            session.view?.render();
            setTimeout(() => {
                if (session.disposed || session.status !== notice) return;
                session.status = previous;
                session.view?.render();
            }, WRITE_REJECTED_NOTICE_MS);
        };
        term.onData((data) => {
            if (data.length > WRITE_LIMIT_CHARS) noticeRejectedWrite();
            else if (session.sessionId) api.terminalWrite?.(session.sessionId, data);
            else if (session.connectionOperation && pendingInput.length + data.length <= PENDING_INPUT_LIMIT) pendingInput += data;
        });
        session.flushPendingInput = () => {
            const data = pendingInput;
            pendingInput = '';
            if (data && session.sessionId) api.terminalWrite?.(session.sessionId, data);
        };
        session.dropPendingInput = () => { pendingInput = ''; };
        // The PTY has a single size shared by every view of it (this tab and the terminal window), so a view
        // only pushes its size while it has focus, and claims it again whenever it gets focus.
        // session.ptySize is the PTY's real size, from create and from resize notices; a view that does not
        // hold the size draws at that size instead of its own fit.
        function hasFocus() { return screen.contains(doc.activeElement); }
        function followPtySize() {
            const size = session.ptySize;
            if (size && (term.cols !== size.cols || term.rows !== size.rows)) term.resize?.(size.cols, size.rows);
        }
        session.claimSize = () => {
            if (!session.sessionId || session.disposed) return;
            const size = session.ptySize;
            if (size && size.cols === term.cols && size.rows === term.rows) return;
            session.ptySize = { cols: term.cols, rows: term.rows };
            api.terminalResize?.(session.sessionId, term.cols, term.rows);
        };
        term.onResize(() => {
            if (hasFocus()) session.claimSize();
        });
        screen.addEventListener('focusin', () => {
            session.fit();
            session.claimSize();
        });

        const unsubscribeData = api.onTerminalData?.((payload) => {
            if (payload?.id === session.sessionId && typeof payload.data === 'string') {
                term.write(normalizePowerShellReadlineRedraw(payload.data, session.powershell));
            }
        });
        // 主进程只在起了新 PTY 时清屏（AI 跑命令或托盘终端重启了共享会话）：这时已经活过来了，别再显示已退出
        const unsubscribeClear = api.onTerminalClear?.((payload) => {
            if (payload?.id !== session.sessionId) return;
            term.reset();
            if (session.exited) {
                session.exited = false;
                setStatus('已连接终端', 'connected');
            }
        });
        // 别的视图（终端窗口、另一个侧栏标签）改了 PTY 尺寸：没焦点就跟过去
        const unsubscribeResized = api.onTerminalResized?.((payload) => {
            if (payload?.id !== session.sessionId || !Number.isInteger(payload.cols) || !Number.isInteger(payload.rows)) return;
            session.ptySize = { cols: payload.cols, rows: payload.rows };
            if (!hasFocus()) followPtySize();
        });
        const unsubscribeExit = api.onTerminalExit?.((payload) => {
            if (payload?.id !== session.sessionId) return;
            session.exited = true;
            term.write(`\r\n\x1b[2m[进程已退出，代码 ${payload.exitCode ?? '?'}，点击右上角刷新按钮重新启动]\x1b[0m\r\n`);
            setStatus('终端已退出', 'exited');
        });

        // One admitted create/restart at a time; transport rejection remains retryable.
        function runConnection(action) {
            if (session.disposed) return Promise.resolve();
            if (session.connectionOperation) return session.connectionOperation;
            session.connectionOperation = Promise.resolve().then(() => {
                if (!session.disposed) return action();
            }).catch(error => {
                session.dropPendingInput();
                if (session.disposed) return;
                const message = error?.message || String(error);
                setStatus(message, 'error');
                term.write(`\x1b[31m${message}\x1b[0m\r\n`);
            }).finally(() => { session.connectionOperation = null; });
            return session.connectionOperation;
        }

        // Attaches this view to the shared terminal session (starting it when none is running).
        session.attach = () => runConnection(async () => {
            const myGeneration = ++session.generation;
            session.fit();
            setStatus('连接中...');
            // 在屏上打开时带上自己的尺寸，让新会话一开始就按这个宽度排版
            const res = await api.terminalCreate(screen.offsetWidth ? { cols: term.cols, rows: term.rows } : {});
            if (session.disposed || myGeneration !== session.generation) {
                if (res?.success) api.terminalKill?.(res.data.id);
                return;
            }
            if (!res?.success) {
                session.dropPendingInput();
                setStatus(res?.error || '终端启动失败', 'error');
                term.write(`\x1b[31m${res?.error || '终端启动失败'}\x1b[0m\r\n`);
                return;
            }
            session.sessionId = res.data.id;
            session.flushPendingInput();
            session.exited = false;
            if (res.data.windowsPty && typeof res.data.windowsPty === 'object') term.options.windowsPty = res.data.windowsPty;
            // 共享终端在 Windows 上起的是 pwsh / powershell，其余平台是 bash
            session.powershell = Boolean(res.data.windowsPty);
            setStatus('已连接终端', 'connected',
                `已连接终端 · 与终端窗口 / AI 命令共用同一个会话${res.data.pid ? ` · PID ${res.data.pid}` : ''}`);
            if (Number.isInteger(res.data.cols) && Number.isInteger(res.data.rows)) session.ptySize = { cols: res.data.cols, rows: res.data.rows };
            // 只有拿着焦点的视图改 PTY 尺寸；后台挂上的视图跟着 PTY 画（用户点进来时 focusin 再接管）
            if (hasFocus()) session.claimSize();
            else followPtySize();
        });

        session.restart = () => {
            if (session.disposed) return Promise.resolve();
            if (session.connectionOperation) return session.connectionOperation;
            // 确认框开着时再点重启：等同一个确认，不叠第二个框
            if (session.restartConfirm) return session.restartConfirm;
            // shell 已经退出时没有可中止的命令，直接重启，不再问
            if (session.sessionId && !session.exited) {
                session.restartConfirm = confirmAction('重新启动共享终端？AI 工具、终端窗口和所有侧栏视图的当前命令都会中止。', '重启终端', '重启')
                    .then(confirmed => {
                        session.restartConfirm = null;
                        // 确认框开着时标签关了，或者别处已经开始重连
                        if (!confirmed || session.disposed) return undefined;
                        return session.connectionOperation || restartNow();
                    }, error => { session.restartConfirm = null; console.error('[TerminalSideProvider] Restart confirm failed:', error); });
                return session.restartConfirm;
            }
            return restartNow();
        };
        const restartNow = () => {
            if (!session.sessionId) return session.attach();
            return runConnection(async () => {
                setStatus('重启中...');
                const res = await api.terminalRestart(session.sessionId);
                if (session.disposed) return;
                if (!res?.success) {
                    setStatus(res?.error || '终端重启失败', 'error');
                    return;
                }
                session.exited = false;
                setStatus('已连接终端', 'connected');
                session.claimSize();
            });
        };

        session.dispose = () => {
            if (session.disposed) return;
            session.disposed = true;
            session.generation += 1;
            session.view = null;
            themeObserver?.disconnect();
            unsubscribeData?.();
            unsubscribeClear?.();
            unsubscribeResized?.();
            unsubscribeExit?.();
            // Only closes this view; the terminal session belongs to VCPChat's terminal.
            if (session.sessionId) api.terminalKill?.(session.sessionId);
            session.sessionId = null;
            try {
                term.dispose();
            } catch (_error) {
                // already disposed
            }
            placeScreen(screen, null);
        };
        signal?.addEventListener('abort', session.dispose, { once: true });

        return session;
    }

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

        async mountTab(tab, viewElement, { scope: viewScope = null, occurrence = null } = {}) {
            if (!viewElement) return null;
            viewElement.innerHTML = '';
            viewElement.classList.add('side-terminal-view');

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
            restartBtn.dataset.action = 'restart';
            restartBtn.title = '重新启动终端（终端窗口和 AI 共用同一个会话，会一并重置）';
            restartBtn.setAttribute('aria-label', '重新启动终端');
            restartBtn.innerHTML = '<span class="vcp-ui-icon" aria-hidden="true">refresh</span>';

            const clearBtn = doc.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'side-terminal-btn';
            clearBtn.dataset.action = 'clear';
            clearBtn.title = '清屏';
            clearBtn.setAttribute('aria-label', '清屏');
            clearBtn.innerHTML = '<span class="vcp-ui-icon" aria-hidden="true">delete_sweep</span>';

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
            container.append(toolbar);
            viewElement.appendChild(container);

            // state: connected | pending | exited | error
            const renderStatus = ({ text, state = 'pending', title = '' }) => {
                statusEl.textContent = state === 'connected' ? '' : text;
                statusEl.dataset.state = state;
                statusEl.classList.toggle('is-error', state === 'error');
                statusDot.dataset.state = state;
                wsSelect.title = title || `${text} · 选择工作区，在终端里切到它的根目录`;
            };

            if (typeof api?.terminalCreate !== 'function') {
                renderStatus({ text: '当前窗口不支持终端', state: 'error' });
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

            // 休眠后重新挂载：接回同一个会话，画面和回滚记录都还在
            let session = occurrence ? sessions.get(occurrence) : null;
            if (session?.disposed) session = null;
            const resumed = Boolean(session);
            if (!session) {
                let xterm;
                try {
                    xterm = await xtermLoader(doc);
                } catch (err) {
                    // 交给侧栏的出错页：带重试按钮，重试会重新加载 xterm，不用关掉标签再开
                    throw new Error(`终端组件加载失败：${err?.message || err}`, { cause: err });
                }
                if (occurrence?.signal?.aborted) return null;
                session = createSession(xterm, occurrence?.signal || null);
                if (occurrence) sessions.set(occurrence, session);
            }
            const { term, screen } = session;
            placeScreen(screen, container);
            session.applyTheme();

            let viewReleased = false;
            // 这一次挂载的按钮监听、尺寸观察和防抖定时器都挂在视图 scope 下，休眠或关标签时一起拆；
            // 会话本身跟着 occurrence 走，不放进来
            const own = createSidePaneRootScope(viewScope, 'terminal');
            let cancelFit = null;
            const view = { render: () => renderStatus(session.status) };
            session.view = view;
            view.render();

            if (!resumed) {
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
            }

            own.listen(wsSelect, 'change', async () => {
                const workspaceId = wsSelect.value;
                wsSelect.value = GO_OPTION_VALUE;
                if (!workspaceId || !session.sessionId) return;
                if (session.exited) {
                    session.setStatus('终端已退出，请先重新启动', 'error');
                    return;
                }
                const res = await api.terminalChangeDirectory(session.sessionId, workspaceId);
                if (session.disposed) return;
                if (!res?.success) {
                    session.setStatus(res?.error || '切换目录失败', 'error');
                    return;
                }
                session.setStatus('已连接终端', 'connected', session.status.title);
                term.focus();
            });
            own.listen(restartBtn, 'click', () => {
                // 先把焦点交给终端再重启：要确认时确认框接过焦点、关掉后还回终端。
                // 反过来的话终端会从确认框手里抢回焦点，按 Esc 关框时 Esc 也进了 shell，吃掉下一个字符
                term.focus();
                session.restart();
            });
            own.listen(clearBtn, 'click', () => {
                term.clear();
                // Windows 的 ConPTY 自己也记着整屏内容，改尺寸时会整屏重绘；只清 xterm 的话，
                // 下面 focus 拿回尺寸（侧栏宽度变过）引起的重绘会把旧内容原样画回来。先让 shell 也清掉，再 focus
                if (session.sessionId && !session.exited) void api.terminalClearScreen?.(session.sessionId);
                term.focus();
            });

            if (typeof doc.defaultView.ResizeObserver === 'function') {
                own.observe(new doc.defaultView.ResizeObserver(() => {
                    // 释放是异步逐条进行的，这期间画面挪进暂存区引起的尺寸变化不再排 fit
                    if (!own.active) return;
                    cancelFit?.();
                    // 拖侧栏分隔条时停顿超过 30ms 就会重排一次、有焦点时还会改共享 PTY 的尺寸（ConPTY 每次都重排历史行）；
                    // 拖动中等停下 300ms 再排
                    const resizing = doc.body?.classList.contains('vcp-sidebar-resizing');
                    cancelFit = own.timeout(session.fit, resizing ? FIT_WHILE_RESIZING_MS : FIT_DEBOUNCE_MS, 'fit-debounce');
                }), screen, undefined, 'screen-resize');
            }

            session.fit();
            if (!resumed) await session.attach();

            const releaseView = () => {
                if (viewReleased) return;
                viewReleased = true;
                void own.dispose('terminal-view-released');
                if (session.view === view) session.view = null;
                if (!session.disposed && occurrence && !occurrence.signal?.aborted) {
                    stashFor(doc)?.appendChild(screen);
                } else {
                    session.dispose();
                }
                viewElement.innerHTML = '';
            };

            return {
                focus() {
                    session.fit();
                    term?.focus();
                    session.claimSize();
                },
                getSessionId() {
                    return session.sessionId;
                },
                // 视图释放（休眠或关标签）：画面收进暂存区；标签关掉时 occurrence 的 signal 再把会话释放
                dispose: releaseView
            };
        }
    };
}
