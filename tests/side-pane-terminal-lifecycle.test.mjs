import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTerminalSideProvider } from '../modules/ui-system/side-pane/terminalSideProvider.js';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';

async function until(predicate) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, 'terminal operation did not settle');
        await new Promise(resolve => setImmediate(resolve));
    }
}

function fixture({ create = async () => ({ success: true, data: { id: 'view:1', pid: 42 } }), restart } = {}) {
    const dom = new JSDOM('<input id="mainInput"><aside><div class="side-pane-tabs"></div><div class="side-pane-content-container"></div></aside>');
    const doc = dom.window.document, root = doc.querySelector('aside');
    const controller = createSidePaneController({ root, tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container') });
    const terminals = [], killed = [], creates = [], restarts = [], listeners = new Map();
    let unsubscriptions = 0, confirmations = 0;
    dom.window.confirm = () => { confirmations++; return true; };
    class Terminal {
        constructor(options) { this.options = options; this.cols = 80; this.rows = 24; this.output = []; this.disposals = 0; terminals.push(this); }
        open(screen) { this.input = doc.createElement('textarea'); screen.append(this.input); }
        onData() {} onResize() {} loadAddon() {}
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
        xtermLoader: async () => ({ Terminal, FitAddon: null }) });
    controller.registerProvider('terminal', provider);
    return { controller, provider, doc, terminals, killed, creates, restarts, listeners,
        get unsubscriptions() { return unsubscriptions; }, get confirmations() { return confirmations; },
        status: () => root.querySelector('.side-terminal-status'),
        retry: () => root.querySelector('[aria-label="重新启动终端"]'),
        async cleanup() { await controller.dispose(); dom.window.close(); } };
}

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
        assert.equal(h.unsubscriptions, 3);
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
        assert.equal(h.unsubscriptions, 3);
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
