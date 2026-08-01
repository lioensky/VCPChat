'use strict';

const assert = require('assert');
const loomController = require('../VCPDistributedServer/Plugin/LoomController/LoomControllerService');

function createFakeManager() {
    const calls = [];
    const app = {
        id: 'test-app',
        name: '测试应用',
        startUrl: 'https://example.com/',
        enabled: true,
        running: false,
    };

    return {
        calls,
        listApps() {
            calls.push(['listApps']);
            return [app];
        },
        listOpenApps() {
            calls.push(['listOpenApps']);
            return [{
                appId: app.id,
                name: app.name,
                running: true,
                url: app.startUrl,
                loading: false,
                error: null,
            }];
        },
        async createApp(payload) {
            calls.push(['createApp', payload]);
            return { ...app, ...payload.manifest };
        },
        async openApp(appId) {
            calls.push(['openApp', appId]);
            return { ...app, id: appId, running: true };
        },
        async closeApp(appId) {
            calls.push(['closeApp', appId]);
            return { success: true };
        },
        async readSources(appId) {
            calls.push(['readSources', appId]);
            return {
                manifest: { ...app, id: appId },
                css: 'body { color: red; }',
                js: 'console.log("ready");',
            };
        },
        async readRuntimeSource(appId) {
            calls.push(['readRuntimeSource', appId]);
            return {
                appId,
                title: 'Runtime',
                url: app.startUrl,
                source: '<html><body>Runtime</body></html>',
                originalByteLength: 33,
                truncated: false,
                capturedAt: '2026-08-01T00:00:00.000Z',
            };
        },
        async readRenderedText(appId, options) {
            calls.push(['readRenderedText', appId, options]);
            return {
                appId,
                title: 'Rendered',
                url: app.startUrl,
                text: '已渲染文本',
                originalByteLength: 18,
                truncated: false,
                capturedAt: '2026-08-01T00:00:00.000Z',
            };
        },
        async editAppSources(appId, payload) {
            calls.push(['editAppSources', appId, payload]);
            return { ...app, id: appId, name: payload.manifest?.name || app.name, running: true };
        },
    };
}

function assertContentResult(result) {
    assert(result && Array.isArray(result.content), 'result.content 应为数组');
    assert.strictEqual(result.content[0].type, 'text');
    assert.strictEqual(typeof result.content[0].text, 'string');
    assert(result.details && typeof result.details === 'object');
}

async function run() {
    loomController._test.resetForTests();
    const manager = createFakeManager();
    loomController.initialize({
        services: { loomManager: manager },
        logger: console,
    });

    const listed = await loomController.processToolCall({ command: 'ListApps' });
    assertContentResult(listed);
    assert.strictEqual(listed.details.count, 1);
    assert(listed.content[0].text.includes('test-app'));

    const openListed = await loomController.processToolCall({ action: 'ListOpenApps' });
    assertContentResult(openListed);
    assert.strictEqual(openListed.details.apps[0].running, true);

    const created = await loomController.processToolCall({
        command: 'CreateApp',
        manifest: JSON.stringify({
            id: 'created-app',
            name: '创建应用',
            startUrl: 'https://example.org/',
        }),
        css: 'body {}',
        js: 'console.log("created");',
    });
    assertContentResult(created);
    const createCall = manager.calls.find((call) => call[0] === 'createApp');
    assert.strictEqual(createCall[1].manifest.id, 'created-app');
    assert.strictEqual(createCall[1].css, 'body {}');

    const opened = await loomController.processToolCall({
        commandIdentifier: 'OpenApp',
        app_id: 'test-app',
    });
    assertContentResult(opened);
    assert(manager.calls.some((call) => call[0] === 'openApp' && call[1] === 'test-app'));

    const closed = await loomController.processToolCall({
        command: 'CloseApp',
        id: 'test-app',
    });
    assertContentResult(closed);

    const sources = await loomController.processToolCall({
        command: 'GetAppSources',
        appId: 'test-app',
    });
    assertContentResult(sources);
    assert(sources.content[0].text.includes('inject.css'));
    assert(sources.content[0].text.includes('console.log'));

    const runtimeSource = await loomController.processToolCall({
        command: 'GetRuntimeSource',
        appId: 'test-app',
    });
    assertContentResult(runtimeSource);
    assert(runtimeSource.content[0].text.includes('<html>'));

    const rendered = await loomController.processToolCall({
        command: 'GetRenderedText',
        appId: 'test-app',
        refresh: 'false',
    });
    assertContentResult(rendered);
    const renderCall = manager.calls.find((call) => call[0] === 'readRenderedText');
    assert.deepStrictEqual(renderCall[2], { refresh: false });
    assert(rendered.content[0].text.includes('已渲染文本'));

    const edited = await loomController.processToolCall({
        command: 'EditAppSources',
        appId: 'test-app',
        manifest: '{"name":"新名称","viewport":{"width":430}}',
        js: '',
    });
    assertContentResult(edited);
    const editCall = manager.calls.find((call) => call[0] === 'editAppSources');
    assert.strictEqual(editCall[2].manifest.viewport.width, 430);
    assert.strictEqual(editCall[2].css, undefined);
    assert.strictEqual(editCall[2].js, '');

    await assert.rejects(
        () => loomController.processToolCall({ command: 'OpenApp' }),
        /缺少必需参数 appId/
    );
    await assert.rejects(
        () => loomController.processToolCall({
            command: 'CreateApp',
            manifest: '[]',
        }),
        /manifest 不是有效的 JSON 对象/
    );
    await assert.rejects(
        () => loomController.processToolCall({ command: 'Unknown' }),
        /不支持的 command/
    );
    await assert.rejects(
        () => loomController.processToolCall({
            command: 'EditAppSources',
            appId: 'test-app',
        }),
        /至少需要 manifest、css 或 js/
    );

    console.log('loom-controller.test.js: all assertions passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});