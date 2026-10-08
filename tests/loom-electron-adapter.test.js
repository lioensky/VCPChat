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

    // Electron WebContents (including side-browser guests) has no getSize().
    assert.strictEqual(webContents.getSize, undefined);
    let viewportSize = { width: 320, height: 240 };
    const captureRects = [];
    const resizeCalls = [];
    webContents.executeJavaScriptInIsolatedWorld = async (worldId, scripts) => {
        assert.strictEqual(worldId, 999);
        assert(scripts[0].code.includes('window.innerWidth'));
        assert(scripts[0].code.includes('window.innerHeight'));
        return viewportSize;
    };
    webContents.capturePage = async rect => {
        captureRects.push(rect);
        const image = {
            getSize: () => ({ width: rect.width * 2, height: rect.height * 2 }),
            toPNG: () => Buffer.from('png-image'),
            toJPEG: () => Buffer.from('jpeg-image'),
            resize(options) {
                resizeCalls.push(options);
                return {
                    ...image,
                    getSize: () => ({
                        width: options.width,
                        height: Math.round(rect.height / rect.width * options.width),
                    }),
                };
            },
        };
        return image;
    };
    let imageRect = { x: -20, y: -10, width: 400, height: 300 };
    adapter.executePageOperationHandler = async () => ({
        status: 'success',
        code: 'PAGE_IMAGE_RESOLVED',
        result: { imageId: 'IMG1', viewportRect: imageRect },
    });
    const pageImage = await adapter.executePageOperation('page_get_image', {
        format: 'png', maxWidth: 200,
    });
    assert.strictEqual(pageImage.code, 'PAGE_IMAGE_CAPTURED');
    assert.strictEqual(pageImage.backendUsed, 'electron-capture-page');
    assert.strictEqual(pageImage.result.mimeType, 'image/png');
    assert(pageImage.result.dataUrl.startsWith('data:image/png;base64,'));
    assert.deepStrictEqual(captureRects[0], { x: 0, y: 0, width: 320, height: 240 });
    assert.deepStrictEqual(pageImage.result.capturedSize, { width: 640, height: 480 });
    assert.deepStrictEqual(pageImage.result.outputSize, { width: 200, height: 150 });
    assert.deepStrictEqual(resizeCalls, [{ width: 200, quality: 'best' }]);

    imageRect = { x: 300, y: 220, width: 100, height: 100 };
    const clippedImage = await adapter.executePageOperation('page_get_image');
    assert.strictEqual(clippedImage.result.format, 'jpeg');
    assert.deepStrictEqual(captureRects[1], { x: 300, y: 220, width: 20, height: 20 });

    imageRect = { x: 400, y: 0, width: 100, height: 100 };
    await assert.rejects(adapter.executePageOperation('page_get_image'), /可视区域之外/);
    assert.strictEqual(captureRects.length, 2);

    imageRect = { x: 0, y: 0, width: 0, height: 100 };
    await assert.rejects(adapter.executePageOperation('page_get_image'), /有效视口区域/);
    imageRect = { x: 0, y: 0, width: 100, height: 100 };
    for (const invalidSize of [{ width: 0, height: 240 }, { width: NaN, height: 240 }, null]) {
        viewportSize = invalidSize;
        await assert.rejects(adapter.executePageOperation('page_get_image'), /有效视口尺寸/);
    }
    assert.strictEqual(captureRects.length, 2);

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