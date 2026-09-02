'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');
const fs = require('fs-extra');
const { EventEmitter } = require('node:events');

function loadCanvasHandlers() {
    const originalLoad = Module._load;
    const listeners = new Map();
    const handlers = new Map();
    const windows = [];

    class FakeWebContents extends EventEmitter {
        constructor() {
            super();
            this.id = 9000 + windows.length;
            this.sent = [];
            this.destroyed = false;
        }

        send(channel, payload) {
            this.sent.push({ channel, payload });
        }

        isDestroyed() {
            return this.destroyed;
        }
    }

    class FakeBrowserWindow extends EventEmitter {
        constructor() {
            super();
            this.webContents = new FakeWebContents();
            this.destroyed = false;
            this.visible = false;
            this.minimized = false;
            windows.push(this);
        }

        async loadFile() {}

        isDestroyed() {
            return this.destroyed;
        }

        isVisible() {
            return this.visible;
        }

        isMinimized() {
            return this.minimized;
        }

        show() {
            this.visible = true;
        }

        focus() {}

        restore() {
            this.minimized = false;
        }
    }

    const ipcMain = {
        on(channel, listener) {
            listeners.set(channel, listener);
        },
        handle(channel, handler) {
            handlers.set(channel, handler);
        },
    };

    const modulePath = require.resolve('../modules/ipc/canvasHandlers');
    delete require.cache[modulePath];

    Module._load = function mockLoad(request, parent, isMain) {
        if (request === 'electron') {
            return {
                ipcMain,
                BrowserWindow: FakeBrowserWindow,
                app: { isQuitting: false },
            };
        }
        if (request === '../services/windowService'
            && parent?.filename?.endsWith(path.join('ipc', 'canvasHandlers.js'))) {
            return { attachWindow() {} };
        }
        if (request === '../services/windowAppIds'
            && parent?.filename?.endsWith(path.join('ipc', 'canvasHandlers.js'))) {
            return { CANVAS: 'canvas' };
        }
        if (request === '../services/preloadPaths'
            && parent?.filename?.endsWith(path.join('ipc', 'canvasHandlers.js'))) {
            return {
                PRELOAD_ROLES: { UTILITY: 'utility' },
                resolveProjectPreload: () => 'fake-preload.js',
            };
        }
        return originalLoad(request, parent, isMain);
    };

    try {
        return {
            canvasHandlers: require(modulePath),
            listeners,
            handlers,
            windows,
            cleanup() {
                delete require.cache[modulePath];
                Module._load = originalLoad;
            },
        };
    } catch (error) {
        delete require.cache[modulePath];
        Module._load = originalLoad;
        throw error;
    }
}

async function createFixture(t, content) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-canvas-edit-'));
    const filePath = path.join(root, 'active.txt');
    await fs.writeFile(filePath, content, 'utf8');
    t.after(() => fs.remove(root));
    return { root, filePath };
}

async function setupCanvas(t, content) {
    const fixture = await createFixture(t, content);
    const loaded = loadCanvasHandlers();
    t.after(loaded.cleanup);

    const openChildWindows = [];
    loaded.canvasHandlers.initialize({
        mainWindow: null,
        openChildWindows,
        CANVAS_CACHE_DIR: fixture.root,
    });
    await loaded.canvasHandlers.createCanvasWindow({
        filePath: fixture.filePath,
        rootDir: fixture.root,
        context: 'canvas',
    });

    const win = loaded.windows[0];
    await loaded.listeners.get('canvas-ready')({ sender: win.webContents });
    return { ...fixture, ...loaded, win };
}

test('Canvas edit rejection returns the human reason and leaves the file unchanged', async (t) => {
    const scenario = await setupCanvas(t, 'alpha beta alpha');
    const resultPromise = scenario.canvasHandlers.requestCanvasEdit({
        target: 'alpha',
        replace: 'omega',
    });

    const proposalEvent = scenario.win.webContents.sent.find(
        (entry) => entry.channel === 'canvas-edit-proposal'
    );
    assert.ok(proposalEvent, 'renderer must receive an explicit edit proposal');
    assert.equal(proposalEvent.payload.originalContent, 'alpha beta alpha');
    assert.equal(proposalEvent.payload.modifiedContent, 'omega beta alpha');

    scenario.listeners.get('canvas-edit-decision')(
        { sender: scenario.win.webContents },
        {
            requestId: proposalEvent.payload.requestId,
            approved: false,
            reason: '请保留第一个 alpha，改第二个。',
        }
    );

    const result = await resultPromise;
    assert.equal(result.success, false);
    assert.equal(result.approved, false);
    assert.equal(result.code, 'CANVAS_EDIT_REJECTED');
    assert.equal(result.reason, '请保留第一个 alpha，改第二个。');
    assert.equal(await fs.readFile(scenario.filePath, 'utf8'), 'alpha beta alpha');
});

test('Canvas edit approval atomically applies only the first target match', async (t) => {
    const scenario = await setupCanvas(t, 'alpha beta alpha');
    const resultPromise = scenario.canvasHandlers.requestCanvasEdit({
        target: 'alpha',
        replace: 'omega',
    });

    const proposalEvent = scenario.win.webContents.sent.find(
        (entry) => entry.channel === 'canvas-edit-proposal'
    );
    scenario.listeners.get('canvas-edit-decision')(
        { sender: scenario.win.webContents },
        {
            requestId: proposalEvent.payload.requestId,
            approved: true,
            reason: '已核对差异，可以应用。',
        }
    );

    const result = await resultPromise;
    assert.equal(result.success, true);
    assert.equal(result.approved, true);
    assert.equal(result.reason, '已核对差异，可以应用。');
    assert.equal(await fs.readFile(scenario.filePath, 'utf8'), 'omega beta alpha');

    const refreshEvent = scenario.win.webContents.sent.find(
        (entry) => entry.channel === 'canvas-file-changed'
    );
    assert.deepEqual(refreshEvent.payload, {
        path: scenario.filePath,
        content: 'omega beta alpha',
    });
});

test('Canvas edit rejects a stale approval when content drifts during review', async (t) => {
    const scenario = await setupCanvas(t, 'alpha beta');
    const resultPromise = scenario.canvasHandlers.requestCanvasEdit({
        target: 'alpha',
        replace: 'omega',
    });

    const proposalEvent = scenario.win.webContents.sent.find(
        (entry) => entry.channel === 'canvas-edit-proposal'
    );
    await fs.writeFile(scenario.filePath, 'human changed content', 'utf8');

    scenario.listeners.get('canvas-edit-decision')(
        { sender: scenario.win.webContents },
        {
            requestId: proposalEvent.payload.requestId,
            approved: true,
            reason: '允许',
        }
    );

    const result = await resultPromise;
    assert.equal(result.success, false);
    assert.equal(result.approved, true);
    assert.equal(result.code, 'CANVAS_CONTENT_CONFLICT');
    assert.equal(await fs.readFile(scenario.filePath, 'utf8'), 'human changed content');
});