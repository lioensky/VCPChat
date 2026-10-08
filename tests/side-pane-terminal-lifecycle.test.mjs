import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTerminalSideProvider } from '../modules/ui-system/side-pane/terminalSideProvider.js';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';

import { waitFor } from './helpers/wait-for.mjs';

const until = predicate => waitFor(predicate, { message: 'terminal operation did not settle' });
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture({ create = async () => ({ success: true, data: { id: 'view:1', pid: 42 } }), restart, dormancy, onOpenUrl = null, failXtermLoads = 0, uiHelper = null } = {}) {
    const dom = new JSDOM('<input id="mainInput"><aside><div class="side-pane-tabs"></div><div class="side-pane-content-container"></div></aside>');
    const doc = dom.window.document, root = doc.querySelector('aside');
    // 休眠时间走注入的时钟，配合 mock.timers 推进，不用真睡
    let clock = 0;
    const controller = createSidePaneController({ root, tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container'),
        dormancy: dormancy && { ...dormancy, now: () => clock } });
    const terminals = [], killed = [], creates = [], restarts = [], listeners = new Map();
    let unsubscriptions = 0, confirmations = 0, xtermLoads = 0;
    dom.window.confirm = () => { confirmations++; return true; };
    class Terminal {
        constructor(options) { this.options = options; this.cols = 80; this.rows = 24; this.output = []; this.disposals = 0; terminals.push(this); }
        open(screen) { this.input = doc.createElement('textarea'); screen.append(this.input); }
        onData() {} onResize() {} loadAddon() {}
        attachCustomKeyEventHandler(handler) { this.keyHandler = handler; }
        hasSelection() { return Boolean(this.selection); }
        getSelection() { return this.selection || ''; }
        focus() { this.input.focus(); }
        write(data) { this.output.push(data); }
        clear() {} reset() {}
        dispose() { this.disposals++; this.input.remove(); }
    }
    const subscribe = name => fn => {
        listeners.set(name, fn);
        return () => { unsubscriptions++; if (listeners.get(name) === fn) listeners.delete(name); };
    };
    const api = {
        gitListWorkspaces: async () => ({ success: true, data: { workspaces: [] } }),
        terminalCreate(options) { creates.push(options); return create(options); },
        terminalRestart(id) { restarts.push(id); return restart?.(id) ?? Promise.resolve({ success: true }); },
        terminalKill(id) { killed.push(id); return Promise.resolve({ success: true }); },
        onTerminalData: subscribe('data'), onTerminalClear: subscribe('clear'), onTerminalExit: subscribe('exit')
    };
    const provider = createTerminalSideProvider({ document: doc, api, sidePaneController: controller,
        xtermLoader: async () => {
            xtermLoads++;
            if (xtermLoads <= failXtermLoads) throw new Error('无法加载 xterm.js');
            return { Terminal, FitAddon: null };
        }, onOpenUrl, uiHelper });
    controller.registerProvider('terminal', provider);
    return { dom, controller, provider, doc, api, terminals, killed, creates, restarts, listeners,
        get unsubscriptions() { return unsubscriptions; }, get xtermLoads() { return xtermLoads; }, get confirmations() { return confirmations; },
        status: () => root.querySelector('.side-terminal-status'),
        retry: () => root.querySelector('[data-action="restart"]'),
        screen: () => doc.querySelector('.side-terminal-screen'),
        stash: () => doc.querySelector('[data-side-terminal-stash]'),
        // 切到别的标签让终端隐藏 ms 毫秒；面板收起时当前标签不休眠
        async hideFor(ms) {
            mock.timers.enable({ apis: ['setTimeout'] });
            try {
                controller.showNotifications();
                clock += ms;
                mock.timers.tick(ms);
                await settle();
            } finally { mock.timers.reset(); }
        },
        async cleanup() { await controller.dispose(); dom.window.close(); } };
}

test('a failed xterm load shows the pane retry page and retrying loads it again', async () => {
    const h = fixture({ failXtermLoads: 1 });
    await assert.rejects(h.provider.openTerminalTab(), /终端组件加载失败/);
    const retry = h.doc.querySelector('.side-pane-mount-error-retry');
    assert.ok(retry, 'the tab stays open on the retry page instead of a dead status line');
    assert.equal(h.creates.length, 0);
    retry.click();
    await until(() => h.creates.length === 1 && !h.doc.querySelector('.side-pane-mount-error-retry'));
    assert.equal(h.xtermLoads, 2);
    await h.cleanup();
});

test('rejected terminal creation leaves a retryable mounted view and releases its resources', async () => {
    let calls = 0;
    const h = fixture({ create: async () => {
        if (++calls === 1) throw new Error('IPC unavailable');
        return { success: true, data: { id: 'view:recovered' } };
    } });
    try {
        const handle = await h.provider.openTerminalTab();
        assert.ok(handle);
        assert.equal(h.status().dataset.state, 'error');
        assert.match(h.status().textContent, /IPC unavailable/);
        h.retry().click();
        await until(() => handle.getSessionId() === 'view:recovered');
        assert.equal(h.status().dataset.state, 'connected');
        await h.controller.closeTab('terminal:main');
        assert.deepEqual(h.killed, ['view:recovered']);
        assert.equal(h.listeners.size, 0);
        assert.equal(h.terminals[0].disposals, 1);
    } finally { await h.cleanup(); }
});

test('repeated retry shares one in-flight view creation', async () => {
    const pending = Promise.withResolvers();
    let calls = 0;
    const h = fixture({ create: () => ++calls === 1
        ? Promise.resolve({ success: false, error: 'not ready' }) : pending.promise });
    try {
        const handle = await h.provider.openTerminalTab();
        h.retry().click(); h.retry().click();
        await until(() => h.creates.length >= 2);
        assert.equal(h.creates.length, 2, 'initial failure and one admitted retry');
        pending.resolve({ success: true, data: { id: 'view:retry' } });
        await until(() => handle.getSessionId() === 'view:retry');
    } finally {
        pending.resolve({ success: true, data: { id: 'view:retry' } });
        await h.cleanup();
    }
});

test('repeated restart shares one destructive request and recovers from a rejected RPC', async () => {
    const pending = Promise.withResolvers();
    let attempts = 0;
    const h = fixture({ restart: () => ++attempts === 1 ? pending.promise : Promise.resolve({ success: true }) });
    try {
        await h.provider.openTerminalTab();
        h.retry().click(); h.retry().click();
        await until(() => h.restarts.length > 0);
        assert.deepEqual(h.restarts, ['view:1']);
        assert.equal(h.confirmations, 1);
        pending.reject(new Error('restart unavailable'));
        await until(() => h.status().dataset.state === 'error');
        assert.match(h.status().textContent, /restart unavailable/);
        h.retry().click();
        await until(() => h.status().dataset.state === 'connected');
        assert.deepEqual(h.restarts, ['view:1', 'view:1']);
    } finally { pending.resolve({ success: true }); await h.cleanup(); }
});

test('restart asks with the app confirm dialog when there is one, and a second click waits on the same dialog', async () => {
    const answer = Promise.withResolvers();
    const asked = [];
    const g = fixture({ uiHelper: { showConfirmDialog: (message, title) => { asked.push(title); return answer.promise; } } });
    try {
        await g.provider.openTerminalTab();
        await until(() => g.status().dataset.state === 'connected');
        g.retry().click(); g.retry().click();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(asked, ['重启终端'], 'one app dialog, no native confirm');
        assert.equal(g.confirmations, 0);
        answer.resolve(true);
        await until(() => g.restarts.length === 1);
    } finally { answer.resolve(false); await g.cleanup(); }
});

test('the restart confirm dialog keeps focus while it is open, so Esc closes it without reaching the shell', async () => {
    const answer = Promise.withResolvers();
    let dialogButton = null;
    const g = fixture({ uiHelper: { showConfirmDialog: () => {
        // stand-in for the app dialog: it focuses its own button
        dialogButton = g.doc.createElement('button');
        g.doc.body.append(dialogButton);
        dialogButton.focus();
        return answer.promise;
    } } });
    try {
        await g.provider.openTerminalTab();
        await until(() => g.status().dataset.state === 'connected');
        g.retry().click();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(g.doc.activeElement, dialogButton, 'the terminal must not take focus back from the open dialog');
        answer.resolve(false);
    } finally { answer.resolve(false); await g.cleanup(); }
});

test('restarting a shell that already exited does not ask about aborting commands', async () => {
    const h = fixture();
    try {
        await h.provider.openTerminalTab();
        await until(() => h.status().dataset.state === 'connected');
        h.listeners.get('exit')({ id: 'view:1', exitCode: 0 });
        h.retry().click();
        await until(() => h.restarts.length === 1);
        assert.equal(h.confirmations, 0);
    } finally { await h.cleanup(); }
});

test('a late retry result releases only its own view after the tab closes', async () => {
    const pending = Promise.withResolvers();
    let calls = 0;
    const h = fixture({ create: () => ++calls === 1 ? Promise.resolve({ success: false }) : pending.promise });
    try {
        await h.provider.openTerminalTab();
        h.retry().click(); await until(() => h.creates.length === 2);
        await h.controller.closeTab('terminal:main');
        pending.resolve({ success: true, data: { id: 'view:late' } });
        await until(() => h.killed.length === 1);
        assert.deepEqual(h.killed, ['view:late']);
        assert.equal(h.listeners.size, 0);
        assert.equal(h.terminals[0].disposals, 1);
    } finally { pending.resolve({ success: true, data: { id: 'view:late' } }); await h.cleanup(); }
});

test('terminal handle disposal is idempotent and ignores queued output afterwards', async () => {
    const h = fixture();
    try {
        const handle = await h.provider.openTerminalTab();
        const emit = h.listeners.get('data');
        await h.controller.closeTab('terminal:main');
        const output = [...h.terminals[0].output];
        handle.dispose(); emit({ id: 'view:1', data: 'late output' });
        assert.equal(h.terminals[0].disposals, 1);
        assert.equal(h.listeners.size, 0);
        assert.deepEqual(h.terminals[0].output, output);
        assert.deepEqual(h.killed, ['view:1']);
    } finally { await h.cleanup(); }
});

for (const reuse of [false, true]) {
    test(`terminal launcher preserves a later collapse and input focus (reuse=${reuse})`, async () => {
        const h = fixture();
        try {
            if (reuse) await h.provider.openTerminalTab();
            const opening = h.provider.openTerminalTab();
            h.controller.setVisible(false);
            const input = h.doc.getElementById('mainInput'); input.focus();
            assert.ok(await opening);
            assert.equal(h.controller.getSnapshot().visible, false);
            assert.equal(h.doc.activeElement, input);
        } finally { await h.cleanup(); }
    });
}

test('a sleeping terminal keeps its shell: the screen waits in the stash and comes back to the same session', async () => {
    const h = fixture({ dormancy: { hiddenMs: 20 } });
    try {
        const handle = await h.provider.openTerminalTab();
        await until(() => handle.getSessionId() === 'view:1');
        await h.hideFor(20);
        await until(() => h.controller.getViewResidency().dormant.length === 1);

        assert.equal(h.stash()?.contains(h.screen()), true, 'the screen is parked, not destroyed');
        assert.deepEqual(h.killed, []);
        assert.equal(h.terminals[0].disposals, 0);
        assert.equal(h.unsubscriptions, 0, 'output keeps flowing into the parked terminal');
        h.listeners.get('data')?.({ id: 'view:1', data: 'while asleep' });

        h.controller.activateTab('terminal:main');
        await until(() => h.controller.getViewResidency().live.includes('terminal:main'));
        const view = h.controller.getTabHandle('terminal:main');
        assert.equal(view.getSessionId(), 'view:1');
        assert.equal(h.terminals.length, 1, 'no second xterm');
        assert.equal(h.creates.length, 1, 'no second shell');
        assert.equal(h.stash(), null, 'the empty stash is removed');
        assert.ok(h.terminals[0].output.includes('while asleep'));
        assert.equal(h.screen().closest('.side-pane-content-container') !== null, true);

        await h.controller.closeTab('terminal:main');
        assert.deepEqual(h.killed, ['view:1']);
        assert.equal(h.terminals[0].disposals, 1);
        assert.equal(h.listeners.size, 0);
    } finally { await h.cleanup(); }
});

test('closing a terminal tab while it sleeps ends the parked session', async () => {
    const h = fixture({ dormancy: { hiddenMs: 20 } });
    try {
        await h.provider.openTerminalTab();
        await until(() => h.status().dataset.state === 'connected');
        await h.hideFor(20);
        await until(() => h.stash()?.contains(h.screen()) === true);
        await h.controller.closeTab('terminal:main');
        await until(() => h.killed.length === 1);
        assert.equal(h.terminals[0].disposals, 1);
        assert.equal(h.stash(), null);
        assert.equal(h.screen(), null);
    } finally { await h.cleanup(); }
});

test('a live terminal view holds its buttons and size observer through the view scope and drops them when it sleeps', async () => {
    const h = fixture({ dormancy: { hiddenMs: 20 } });
    // JSDOM 没有 ResizeObserver，这里记下谁还在观察
    const observers = [];
    h.doc.defaultView.ResizeObserver = class {
        constructor(cb) { this.cb = cb; this.targets = new Set(); observers.push(this); }
        observe(target) { this.targets.add(target); }
        disconnect() { this.targets.clear(); }
    };
    const terminalTab = () => h.controller.getDiagnostics().tabs.find(tab => tab.id === 'terminal:main');
    try {
        const handle = await h.provider.openTerminalTab();
        await until(() => handle.getSessionId() === 'view:1');
        const live = terminalTab().resources;
        assert.equal(live.byType.listener, 3, 'workspace jump, clear and restart listen through the view scope');
        assert.equal(live.byType.observer, 1);
        assert.equal(observers[0].targets.size, 1);

        await h.hideFor(20);
        await until(() => terminalTab().view === 'dormant');
        assert.equal(terminalTab().resources, null);
        assert.equal(observers[0].targets.size, 0, 'the parked screen is no longer observed');
        assert.deepEqual(h.killed, [], 'the shell itself keeps running');
    } finally { await h.cleanup(); }
});

test('a shared shell restarted elsewhere brings the exited tab back to connected', async () => {
    const h = fixture();
    try {
        await h.provider.openTerminalTab();
        await until(() => h.status().dataset.state === 'connected');
        h.listeners.get('exit')({ id: 'view:1', exitCode: 0 });
        assert.equal(h.status().dataset.state, 'exited');
        // AI 跑命令或托盘终端重启：主进程起了新 PTY，只推一次清屏
        h.listeners.get('clear')({ id: 'view:1' });
        assert.equal(h.status().dataset.state, 'connected');
        h.listeners.get('clear')({ id: 'view:other' });
        assert.equal(h.status().dataset.state, 'connected');
    } finally { await h.cleanup(); }
});

test('OSC 8 hyperlinks open http(s) in the side browser and nothing else', async () => {
    const opened = [];
    const h = fixture({ onOpenUrl: url => opened.push(url) });
    try {
        await h.provider.openTerminalTab();
        const { linkHandler } = h.terminals[0].options;
        assert.equal(linkHandler.allowNonHttpProtocols, false);
        const event = { prevented: false, preventDefault() { this.prevented = true; } };
        linkHandler.activate(event, 'https://example.com/a');
        linkHandler.activate(event, 'file:///etc/passwd');
        linkHandler.activate(event, 'javascript:alert(1)');
        assert.deepEqual(opened, ['https://example.com/a']);
        assert.equal(event.prevented, true, 'xterm\'s confirm + window.open default never runs');
    } finally { await h.cleanup(); }
});

test('a Windows PTY backend reported by the main process is handed to xterm so resizes do not reflow twice', async () => {
    const h = fixture({ create: async () => ({ success: true, data: { id: 'view:win', windowsPty: { backend: 'conpty', buildNumber: 22631 } } }) });
    try {
        const handle = await h.provider.openTerminalTab();
        await until(() => handle.getSessionId() === 'view:win');
        assert.deepEqual(h.terminals[0].options.windowsPty, { backend: 'conpty', buildNumber: 22631 });
    } finally { await h.cleanup(); }
});

test('Ctrl+C with a selection copies instead of interrupting the shared shell; pane shortcuts stay out of the shell', async () => {
    const h = fixture();
    const copied = [];
    Object.defineProperty(h.dom.window.navigator, 'clipboard', { configurable: true,
        value: { writeText: async text => { copied.push(text); } } });
    try {
        await h.provider.openTerminalTab();
        const term = h.terminals[0];
        const key = (fields) => term.keyHandler({ type: 'keydown', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...fields });

        assert.equal(key({ key: 'c', ctrlKey: true }), true, 'without a selection Ctrl+C still reaches the shell');
        term.selection = 'npm test';
        assert.equal(key({ key: 'c', ctrlKey: true }), false);
        assert.deepEqual(copied, ['npm test']);
        assert.equal(key({ key: 'b', ctrlKey: true, altKey: true }), false);
        assert.equal(key({ key: 'PageDown', ctrlKey: true }), false);
        assert.equal(key({ key: 'a' }), true);
    } finally { await h.cleanup(); }
});


test('AI sidebar requests query the selected xterm and await paste input acknowledgement', async () => {
    const h = fixture();
    try {
        const handle = await h.provider.openTerminalTab();
        const term = h.terminals[0];
        term.write = (_data, callback) => callback?.();
        term.buffer = { active: { length: 3, getLine: index => ({ translateToString: () => ['first', '', 'last'][index] }) } };
        assert.equal(await handle.handleTerminalRequest({ action: 'query', maxLines: 2 }), 'last');
        assert.equal(await handle.handleTerminalRequest({ action: 'query' }), 'first\n\nlast');
        let pasted = null;
        term.paste = text => { pasted = text; };
        await handle.handleTerminalRequest({ action: 'paste', text: 'hello' });
        assert.equal(pasted, 'hello');
        await assert.rejects(handle.handleTerminalRequest({ action: 'unknown' }), /未知/);
        await h.controller.closeTab('terminal:main');
        await assert.rejects(handle.handleTerminalRequest({ action: 'query' }), /关闭/);
    } finally { await h.cleanup(); }
});
test('workspace shortcut retains accepted selection, restores on rejection and clears on session reset', async () => {
    const h = fixture();
    h.api.gitListWorkspaces = async () => ({ data: { workspaces: [
        { id: 'chat', alias: 'vcpchat', path: 'H:/chat' },
        { id: 'box', alias: 'toolbox', path: 'H:/box' }
    ] } });
    h.api.terminalChangeDirectory = async () => ({ success: true, data: { cwd: 'H:/chat' } });
    try {
        await h.provider.openTerminalTab();
        const select = h.doc.querySelector('.side-terminal-ws-select');
        select.value = 'chat';
        select.dispatchEvent(new h.dom.window.Event('change'));
        await settle();
        assert.equal(select.value, 'chat');
        assert.equal(select.disabled, false);
        h.api.terminalChangeDirectory = async () => { throw new Error('IPC rejected'); };
        select.value = 'box';
        select.dispatchEvent(new h.dom.window.Event('change'));
        await settle();
        assert.equal(select.value, 'chat');
        assert.match(h.status().textContent, /IPC rejected/);
        h.listeners.get('clear')({ id: 'view:1' });
        assert.equal(select.value, '');
    } finally { await h.cleanup(); }
});
