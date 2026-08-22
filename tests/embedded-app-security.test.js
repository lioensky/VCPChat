const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const {
    MAX_DETACH_COORDINATE,
    normalizeEmbeddedAction,
    normalizeDetachPoint,
} = require('../modules/services/embeddedAppSessionManager.js');

test('embedded actions are restricted to the local application allowlist', () => {
    assert.equal(normalizeEmbeddedAction('open-notes-window'), 'open-notes-window');
    assert.equal(normalizeEmbeddedAction(null, { optional: true }), null);
    assert.throws(() => normalizeEmbeddedAction('open-arbitrary-window'), /无效/);
    assert.throws(() => normalizeEmbeddedAction({ action: 'open-notes-window' }), /无效/);
});

test('detach coordinates are finite, rounded and bounded', () => {
    assert.deepEqual(normalizeDetachPoint({ x: 10.4, y: -20.6 }), { x: 10, y: -21 });
    assert.equal(normalizeDetachPoint({ x: Infinity, y: 0 }), null);
    assert.equal(normalizeDetachPoint({ x: MAX_DETACH_COORDINATE + 1, y: 0 }), null);
    assert.equal(normalizeDetachPoint(null), null);
});

test('embedded sessions keep child presentation policy independent from main settings', () => {
    const source = fs.readFileSync(require.resolve('../modules/services/embeddedAppSessionManager.js'), 'utf8');
    assert.doesNotMatch(source, /settings-updated|ui-mode-updated/,
        'canonical main settings must not change the presentation of existing child sessions');
    assert.match(source, /const uiMode = 'classic'/,
        'unmigrated embedded business pages must keep their explicit Classic policy');
});

test('embedded session manager enforces a bounded native view pool', async () => {
    const originalLoad = Module._load;
    class FakeWebContents extends EventEmitter {
        constructor() { super(); this.destroyed = false; }
        isDestroyed() { return this.destroyed; }
        isCrashed() { return false; }
        setWindowOpenHandler() {}
        async loadURL() {}
        send() {}
        close() { this.destroyed = true; queueMicrotask(() => this.emit('destroyed')); }
        stop() {}
    }
    class FakeView {
        static instances = [];
        constructor() { this.webContents = new FakeWebContents(); this.visible = false; FakeView.instances.push(this); }
        setBackgroundColor() {}
        setVisible(value) { this.visible = value; }
        setBounds() {}
    }
    Module._load = function loadWithElectronMock(request, parent, isMain) {
        if (request === 'electron') return {
            WebContentsView: FakeView,
            app: { getAppPath: () => process.cwd() },
            shell: { openExternal: async () => {} },
            screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }) },
        };
        return originalLoad.call(this, request, parent, isMain);
    };
    const modulePath = require.resolve('../modules/services/embeddedAppSessionManager.js');
    delete require.cache[modulePath];
    let manager;
    let mainWindow;
    try {
        mainWindow = new EventEmitter();
        mainWindow.isDestroyed = () => false;
        mainWindow.getContentBounds = () => ({ width: 1200, height: 900 });
        mainWindow.webContents = new FakeWebContents();
        mainWindow.contentView = { addChildView() {}, removeChildView() {} };
        const { createEmbeddedAppSessionManager, MAX_EMBEDDED_SESSIONS } = require(modulePath);
        const powerMonitor = new EventEmitter();
        manager = createEmbeddedAppSessionManager({
            mainWindow,
            powerMonitor,
            launchStandalone: async () => ({ success: true }),
        });
        const actions = [
            'open-notes-window', 'open-note-mini-window', 'open-translator-window',
            'open-memo-window', 'open-forum-window', 'open-log-window',
            'open-themes-window',
        ];
        for (const action of actions.slice(0, MAX_EMBEDDED_SESSIONS)) {
            assert.equal((await manager.create(action)).success, true);
        }
        const overflow = await manager.create(actions[MAX_EMBEDDED_SESSIONS]);
        assert.equal(overflow.success, false);
        assert.match(overflow.error, /最多同时打开/);
        assert.equal((await manager.create(actions[0])).reused, true);
        assert.equal(manager.activate(actions[0]).success, true);
        assert.equal(FakeView.instances[0].visible, true);
        powerMonitor.emit('suspend');
        assert.equal(FakeView.instances[0].visible, false);
        powerMonitor.emit('resume');
        assert.equal(FakeView.instances[0].visible, true);
    } finally {
        mainWindow?.emit('closed');
        await manager?.closeAll();
        Module._load = originalLoad;
        delete require.cache[modulePath];
    }
});
