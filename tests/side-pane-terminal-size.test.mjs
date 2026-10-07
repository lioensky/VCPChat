import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTerminalSideProvider } from '../modules/ui-system/side-pane/terminalSideProvider.js';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { waitFor } from './helpers/wait-for.mjs';

// 侧栏终端和共享 PTY 的配合。尺寸：PTY 只有一个尺寸（终端窗口、侧栏标签、AI 命令共用），只有拿着焦点的视图改它，
// 其余视图跟着 PTY 的真实尺寸画。输入：连上之前敲的字连上后补发。
function fixture(t, { pty = { cols: 120, rows: 30 }, create = null } = {}) {
    const dom = new JSDOM('<input id="mainInput"><aside><div class="side-pane-tabs"></div><div class="side-pane-content-container"></div></aside>');
    const win = dom.window, doc = win.document, root = doc.querySelector('aside');
    // jsdom 没有布局：给画面一个 45 列宽的容器
    Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 360; } });
    Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 400; } });
    const controller = createSidePaneController({ root, tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container') });
    const resizes = [], writes = [], listeners = new Map(), ptyCalls = [];
    let observed = null, fits = 0;
    win.ResizeObserver = class { constructor(callback) { observed = callback; } observe() {} unobserve() {} disconnect() {} };
    let term = null;
    class Terminal {
        constructor() { this.cols = 80; this.rows = 24; this.resizeHandlers = []; term = this; }
        open(screen) { this.input = doc.createElement('textarea'); screen.append(this.input); }
        onData(handler) { this.type = handler; }
        onResize(handler) { this.resizeHandlers.push(handler); }
        loadAddon(addon) { addon.term = this; }
        attachCustomKeyEventHandler() {}
        resize(cols, rows) {
            if (cols === this.cols && rows === this.rows) return;
            this.cols = cols; this.rows = rows;
            this.resizeHandlers.forEach(handler => handler({ cols, rows }));
        }
        focus() { this.input.focus(); }
        write() {} reset() {}
        clear() { this.cleared = (this.cleared || 0) + 1; }
        dispose() { this.input.remove(); }
    }
    // fit 按容器排成 45×20
    class FitAddon { fit() { fits++; this.term.resize(45, 20); } }
    const subscribe = name => fn => { listeners.set(name, fn); return () => listeners.delete(name); };
    const api = {
        gitListWorkspaces: async () => ({ success: true, data: { workspaces: [] } }),
        terminalCreate: create || (async () => ({ success: true, data: { id: 'view:1', pid: 42, ...pty } })),
        terminalWrite: async (id, data) => { writes.push([id, data]); return { success: true }; },
        terminalResize: async (id, cols, rows) => { resizes.push([cols, rows]); ptyCalls.push('resize'); return { success: true }; },
        terminalClearScreen: async id => { ptyCalls.push(`clear-screen:${id}`); return { success: true, data: { shellCleared: true } }; },
        terminalKill: async () => ({ success: true }),
        onTerminalData: subscribe('data'), onTerminalClear: subscribe('clear'), onTerminalExit: subscribe('exit'),
        onTerminalResized: subscribe('resized')
    };
    const provider = createTerminalSideProvider({ document: doc, api, sidePaneController: controller,
        xtermLoader: async () => ({ Terminal, FitAddon }) });
    controller.registerProvider('terminal', provider);
    t.after(async () => { await controller.dispose(); win.close(); });
    return { doc, controller, provider, resizes, writes, listeners, ptyCalls, term: () => term,
        containerResized: () => observed?.([]), get fits() { return fits; },
        mountInBackground: async () => {
            // 打开后、挂好之前用户已经回到主输入框打字：标签挂上了但没拿焦点
            const opening = provider.openTerminalTab();
            doc.getElementById('mainInput').focus();
            await opening;
            assert.equal(doc.activeElement, doc.getElementById('mainInput'));
        } };
}

test('a terminal tab mounted without focus leaves the running PTY alone and draws at its size', async t => {
    const h = fixture(t);
    await h.mountInBackground();
    assert.deepEqual(h.resizes, [], 'the terminal window keeps its 120 columns');
    assert.deepEqual([h.term().cols, h.term().rows], [120, 30]);
});

test('a terminal tab without focus follows resizes made elsewhere; the focused one keeps its own size', async t => {
    const h = fixture(t);
    await h.mountInBackground();
    h.listeners.get('resized')({ id: 'view:1', cols: 100, rows: 28 });
    assert.deepEqual([h.term().cols, h.term().rows], [100, 28]);
    h.listeners.get('resized')({ id: 'other-view', cols: 60, rows: 10 });
    assert.deepEqual([h.term().cols, h.term().rows], [100, 28], 'notices for another view are ignored');
    assert.deepEqual(h.resizes, []);

    h.term().focus();
    assert.deepEqual([h.term().cols, h.term().rows], [45, 20], 'clicking in fits the tab to its own width');
    assert.deepEqual(h.resizes, [[45, 20]], 'and only then does it take over the PTY size');
    h.listeners.get('resized')({ id: 'view:1', cols: 45, rows: 20 });
    h.term().input.blur();
    h.term().focus();
    assert.deepEqual(h.resizes, [[45, 20]], 'focusing again at the same size sends nothing');
});

// 打开终端标签就开始敲：连接建立之前的字先攒着，连上后补发，不丢
test('keys typed while the terminal is still connecting reach the shell once it connects', async t => {
    const connected = Promise.withResolvers();
    const h = fixture(t, { create: () => connected.promise });
    const opening = h.provider.openTerminalTab();
    await waitFor(() => h.term()?.type);
    h.term().type('git st');
    h.term().type('atus\r');
    assert.deepEqual(h.writes, []);
    connected.resolve({ success: true, data: { id: 'view:1', pid: 42, cols: 120, rows: 30 } });
    await opening;
    assert.deepEqual(h.writes, [['view:1', 'git status\r']]);
    h.term().type('ls\r');
    assert.deepEqual(h.writes.at(-1), ['view:1', 'ls\r']);
});

test('keys typed before a failed connection are not sent to a later one', async t => {
    let attempt = 0;
    const first = Promise.withResolvers();
    const h = fixture(t, { create: () => (++attempt === 1 ? first.promise
        : Promise.resolve({ success: true, data: { id: 'view:2', pid: 43, cols: 120, rows: 30 } })) });
    const opening = h.provider.openTerminalTab();
    await waitFor(() => h.term()?.type);
    h.term().type('rm -rf build\r');
    first.resolve({ success: false, error: 'PTY 启动失败' });
    await opening;
    h.doc.querySelector('[data-action="restart"]').click();
    await waitFor(() => attempt === 2);
    await waitFor(() => h.listeners.has('resized'));
    assert.deepEqual(h.writes, [], 'a command typed for a terminal that never started is not replayed later');
});

// 拖侧栏分隔条时，终端不跟着每次停顿重排（有焦点时每次重排都会改共享 PTY 的尺寸），停下 300ms 再排
test('while the pane resizer is dragged the terminal refits only once the drag pauses', async t => {
    const h = fixture(t);
    await h.provider.openTerminalTab();
    mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => mock.timers.reset());
    // 每次尺寸变化是单独一个任务：上一次排的 fit 在下一次变化前已经撤掉
    const resized = async () => { h.containerResized(); for (let i = 0; i < 3; i++) await Promise.resolve(); };
    const before = h.fits;
    h.doc.body.classList.add('vcp-sidebar-resizing');
    for (let i = 0; i < 5; i++) {
        await resized();
        mock.timers.tick(100);
    }
    assert.equal(h.fits, before, 'no refit for each pause shorter than 300ms');
    mock.timers.tick(200);
    assert.equal(h.fits, before + 1, 'one refit when the drag stops');

    h.doc.body.classList.remove('vcp-sidebar-resizing');
    await resized();
    mock.timers.tick(30);
    assert.equal(h.fits, before + 2, 'outside a drag a window resize still refits quickly');
});

// 超过 1MB 的粘贴主进程整段拒收：不发，状态栏说一声，过一会儿回到「已连接」
test('a paste too large for the terminal is not sent and the status says so for a moment', async t => {
    const h = fixture(t);
    await h.provider.openTerminalTab();
    mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => mock.timers.reset());
    const status = h.doc.querySelector('.side-terminal-status');
    assert.equal(status.dataset.state, 'connected');
    h.term().type('x'.repeat(1024 * 1024 + 1));
    assert.deepEqual(h.writes, [], 'nothing reaches the shell');
    assert.equal(status.dataset.state, 'error');
    assert.notEqual(status.textContent, '');
    h.term().type('ls\r');
    assert.deepEqual(h.writes, [['view:1', 'ls\r']], 'normal typing still goes through');
    mock.timers.tick(4000);
    assert.equal(status.dataset.state, 'connected');
});

// Windows 的 ConPTY 自己也记着整屏内容，PTY 一改尺寸就整屏重绘。清屏按钮要先让 shell 也清掉，
// 再让终端拿焦点（拿焦点时侧栏宽度变过的话会改 PTY 尺寸），不然清掉的内容马上被重绘回来
test('clear has the shell clear its screen before focusing the terminal can resize the PTY', async t => {
    const h = fixture(t);
    await h.mountInBackground();
    assert.deepEqual([h.term().cols, h.term().rows], [120, 30], 'drawn at the PTY size, not its own width');
    h.doc.querySelector('[data-action="clear"]').click();
    assert.equal(h.term().cleared, 1);
    assert.deepEqual(h.ptyCalls, ['clear-screen:view:1', 'resize'], 'the shell is asked first, then the tab takes over the PTY size');
    assert.equal(h.doc.activeElement, h.term().input);
});
