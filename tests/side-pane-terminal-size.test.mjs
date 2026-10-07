import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTerminalSideProvider } from '../modules/ui-system/side-pane/terminalSideProvider.js';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { waitFor } from './helpers/wait-for.mjs';

// 共享 PTY 只有一个尺寸（终端窗口、侧栏标签、AI 命令共用）：只有拿着焦点的视图改它，
// 其余视图跟着 PTY 的真实尺寸画（同 DSH 的可写 / 只读视图）
function fixture(t, { pty = { cols: 120, rows: 30 } } = {}) {
    const dom = new JSDOM('<input id="mainInput"><aside><div class="side-pane-tabs"></div><div class="side-pane-content-container"></div></aside>');
    const win = dom.window, doc = win.document, root = doc.querySelector('aside');
    // jsdom 没有布局：给画面一个 45 列宽的容器
    Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 360; } });
    Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 400; } });
    const controller = createSidePaneController({ root, tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container') });
    const resizes = [], listeners = new Map();
    let term = null;
    class Terminal {
        constructor() { this.cols = 80; this.rows = 24; this.resizeHandlers = []; term = this; }
        open(screen) { this.input = doc.createElement('textarea'); screen.append(this.input); }
        onData() {}
        onResize(handler) { this.resizeHandlers.push(handler); }
        loadAddon(addon) { addon.term = this; }
        attachCustomKeyEventHandler() {}
        resize(cols, rows) {
            if (cols === this.cols && rows === this.rows) return;
            this.cols = cols; this.rows = rows;
            this.resizeHandlers.forEach(handler => handler({ cols, rows }));
        }
        focus() { this.input.focus(); }
        write() {} clear() {} reset() {}
        dispose() { this.input.remove(); }
    }
    // fit 按容器排成 45×20
    class FitAddon { fit() { this.term.resize(45, 20); } }
    const subscribe = name => fn => { listeners.set(name, fn); return () => listeners.delete(name); };
    const api = {
        gitListWorkspaces: async () => ({ success: true, data: { workspaces: [] } }),
        terminalCreate: async () => ({ success: true, data: { id: 'view:1', pid: 42, ...pty } }),
        terminalResize: async (id, cols, rows) => { resizes.push([cols, rows]); return { success: true }; },
        terminalKill: async () => ({ success: true }),
        onTerminalData: subscribe('data'), onTerminalClear: subscribe('clear'), onTerminalExit: subscribe('exit'),
        onTerminalResized: subscribe('resized')
    };
    const provider = createTerminalSideProvider({ document: doc, api, sidePaneController: controller,
        xtermLoader: async () => ({ Terminal, FitAddon }) });
    controller.registerProvider('terminal', provider);
    t.after(async () => { await controller.dispose(); win.close(); });
    return { doc, controller, provider, resizes, listeners, term: () => term,
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
