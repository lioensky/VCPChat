'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const contract = require('../modules/loom/webcore/adapter-contract');
const {
    CAPABILITIES,
    createElectronWebAgentAdapter,
} = require('../modules/loom/webcore/electron-adapter');

class FakeDebugger extends EventEmitter {
    constructor() {
        super();
        this.attached = false;
        this.commands = [];
    }

    isAttached() {
        return this.attached;
    }

    attach(version) {
        this.attached = true;
        this.version = version;
    }

    detach() {
        this.attached = false;
        this.emit('detach', {}, 'target closed');
    }

    async sendCommand(method, params = {}) {
        this.commands.push([method, params]);
        return { method, params, ok: true };
    }
}

function createFakeWebContents() {
    const events = new EventEmitter();
    const debuggerApi = new FakeDebugger();
    return Object.assign(events, {
        id: 42,
        debugger: debuggerApi,
        destroyed: false,
        url: 'https://example.com/',
        title: 'Example',
        loading: false,
        mainScripts: [],
        isolatedScripts: [],
        isDestroyed() {
            return this.destroyed;
        },
        getURL() {
            return this.url;
        },
        getTitle() {
            return this.title;
        },
        isLoading() {
            return this.loading;
        },
        async executeJavaScript(code) {
            this.mainScripts.push(code);
            return { world: 'MAIN', deep: true };
        },
        async executeJavaScriptInIsolatedWorld(worldId, scripts) {
            this.isolatedScripts.push([worldId, scripts]);
            return { world: 'ISOLATED', deep: true };
        },
        async capturePage() {
            return {
                toPNG: () => Buffer.from('png-image'),
                toJPEG: () => Buffer.from('jpeg-image'),
            };
        },
        async loadURL(url) {
            this.url = url;
        },
        reload() {
            this.loading = true;
        },
        navigationHistory: {
            canGoBack: () => true,
            canGoForward: () => true,
            goBack() {},
            goForward() {},
        },
    });
}

async function run() {
    const webContents = createFakeWebContents();
    const pageCalls = [];
    const adapter = createElectronWebAgentAdapter(webContents, {
        appId: 'test-app',
        worldId: 999,
        executePageOperation: async (operation, payload, request) => {
            pageCalls.push([operation, payload, request]);
            return {
                status: 'success',
                code: 'ACTION_VERIFIED',
                message: '页面动作完成',
                result: {
                    runtimeInstanceId: 'page-runtime-1',
                    documentGeneration: 2,
                    snapshotId: 3,
                    verified: true,
                },
            };
        },
    });

    contract.validateAdapter(adapter);
    const negotiated = await contract.negotiateCapabilities(adapter);
    assert(negotiated.supportedCommands.includes('runtime_execute_script'));
    assert(negotiated.supportedCommands.includes('dom_get_document'));
    assert(negotiated.supportedCommands.includes('native_mouse'));
    assert.deepStrictEqual(await adapter.getCapabilities(), [...CAPABILITIES]);

    const identity = await adapter.getTargetIdentity();
    assert.strictEqual(identity.appId, 'test-app');
    assert.strictEqual(identity.targetId, 42);

    const pageResult = await adapter.executePageOperation(
        'page_click',
        { target: 'vcp-button-1' },
        { requestId: 'req-1', targetContext: { appId: 'test-app' } }
    );
    assert.strictEqual(pageResult.result.verified, true);
    assert.strictEqual(pageCalls[0][0], 'page_click');
    assert.deepStrictEqual(await adapter.getDocumentState(), {
        documentGeneration: 2,
        snapshotId: 3,
    });

    const mainScript = await adapter.executeScript({
        code: 'return { deep: true };',
        executionWorld: 'MAIN',
    });
    assert.strictEqual(mainScript.code, 'SCRIPT_RESULT_RETURNED');
    assert.strictEqual(mainScript.result.world, 'MAIN');
    assert.strictEqual(webContents.mainScripts.length, 1);

    const isolatedScript = await adapter.executeScript({
        code: 'return [...document.querySelectorAll("*")].length;',
        executionWorld: 'ISOLATED',
    });
    assert.strictEqual(isolatedScript.result.world, 'ISOLATED');
    assert.strictEqual(webContents.isolatedScripts[0][0], 999);

    const debuggerResult = await adapter.sendDebuggerCommand(
        'DOM.getDocument',
        { depth: -1, pierce: true }
    );
    assert.strictEqual(debuggerResult.result.method, 'DOM.getDocument');
    assert.strictEqual(webContents.debugger.isAttached(), true);
    assert(webContents.debugger.commands.some(([method]) => method === 'DOM.getDocument'));

    webContents.debugger.emit('message', {}, 'Network.requestWillBeSent', {
        requestId: 'network-1',
        request: { url: 'https://example.com/api/data' },
        timestamp: 1,
        type: 'Fetch',
    });
    webContents.debugger.emit('message', {}, 'Network.responseReceived', {
        requestId: 'network-1',
        response: { status: 200 },
    });
    const network = await adapter.executePageOperation('network_query', {
        urlIncludes: '/api/',
    });
    assert.strictEqual(network.result.length, 1);
    assert.strictEqual(network.result[0].response.status, 200);

    await adapter.dispatchNativeInput({
        type: 'insert-text',
        text: 'VCP Loom',
    });
    assert(webContents.debugger.commands.some(([method, params]) =>
        method === 'Input.insertText' && params.text === 'VCP Loom'
    ));

    const screenshot = await adapter.captureScreenshot({ format: 'png' });
    assert.strictEqual(screenshot.result.mimeType, 'image/png');
    assert(screenshot.result.dataUrl.startsWith('data:image/png;base64,'));

    const targets = await adapter.listTargets();
    assert.strictEqual(targets.result.count, 1);
    assert.strictEqual(targets.result.targets[0].appId, 'test-app');

    adapter.invalidateDocument();
    assert.strictEqual((await adapter.getDocumentState()).documentGeneration, 3);
    assert.strictEqual((await adapter.getDocumentState()).snapshotId, null);

    await adapter.dispose();
    assert.strictEqual(webContents.debugger.isAttached(), false);

    console.log('loom-electron-adapter.test.js: all assertions passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});