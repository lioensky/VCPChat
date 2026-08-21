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
        async getWebAgentPageInfo(appId) {
            calls.push(['getWebAgentPageInfo', appId]);
            return {
                appId,
                title: 'Agent Page',
                url: app.startUrl,
                markdown: '# Agent Page\n\n【搜索框 A1｜vcp-searchbox-1｜vcp-h-1-1-1-abcd1234】',
                elementCount: 1,
                runtimeInstanceId: 'loom-test-runtime',
                documentGeneration: 1,
                snapshotId: 1,
                pageGraph: { elements: [{ handleId: 'vcp-searchbox-1' }] },
            };
        },
        async executeWebAgentAction(appId, actionId, params, options) {
            calls.push(['executeWebAgentAction', appId, actionId, params, options]);
            if (actionId === 'page_get_image') {
                return {
                    appId,
                    actionId,
                    executedAt: '2026-08-06T00:00:00.000Z',
                    response: {
                        status: 'success',
                        code: 'COMMAND_COMPLETED',
                        result: {
                            code: 'PAGE_IMAGE_CAPTURED',
                            result: {
                                imageId: params.imageId,
                                resolvedImageId: 'vcp-img-1-1-1-abcd1234',
                                kind: 'content-image',
                                caption: '测试正文图片',
                                format: params.format || 'jpeg',
                                outputSize: { width: 800, height: 450 },
                                byteLength: 12,
                                dataUrl: 'data:image/jpeg;base64,dGVzdC1pbWFnZQ==',
                            },
                        },
                    },
                };
            }
            return {
                appId,
                actionId: actionId.startsWith('page_') ? actionId : `page_${actionId}`,
                executedAt: '2026-08-06T00:00:00.000Z',
                response: {
                    status: 'success',
                    code: 'ACTION_VERIFIED',
                    message: '输入动作已验证',
                    result: { verified: true },
                },
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

    const pageInfo = await loomController.processToolCall({
        command: 'GetPageInfo',
        appId: 'test-app',
    });
    assertContentResult(pageInfo);
    assert(pageInfo.content[0].text.includes('vcp-searchbox-1'));
    assert.strictEqual(pageInfo.details.pageInfo.snapshotId, 1);
    assert(manager.calls.some((call) =>
        call[0] === 'getWebAgentPageInfo' && call[1] === 'test-app'
    ));

    const pageImage = await loomController.processToolCall({
        command: 'GetPageImage',
        appId: 'test-app',
        imageId: 'IMG1',
        format: 'jpeg',
        quality: '85',
        maxWidth: '1600',
        snapshotId: '1',
        documentGeneration: '1',
        runtimeInstanceId: 'loom-test-runtime',
        strict: 'true',
    });
    assert.strictEqual(pageImage.content.length, 2);
    assert.strictEqual(pageImage.content[0].type, 'text');
    assert(pageImage.content[0].text.includes('测试正文图片'));
    assert.strictEqual(pageImage.content[1].type, 'image_url');
    assert(pageImage.content[1].image_url.url.startsWith('data:image/jpeg;base64,'));
    assert.strictEqual(pageImage.details.appId, 'test-app');
    assert.strictEqual(pageImage.details.image.dataUrl, undefined);
    const imageCall = manager.calls.find((call) =>
        call[0] === 'executeWebAgentAction' && call[2] === 'page_get_image'
    );
    assert.strictEqual(imageCall[1], 'test-app');
    assert.strictEqual(imageCall[3].imageId, 'IMG1');
    assert.strictEqual(imageCall[3].snapshotId, '1');
    assert.strictEqual(imageCall[3].quality, '85');
    assert.deepStrictEqual(imageCall[4], { strict: true });

    const action = await loomController.processToolCall({
        command: 'ExecuteAction',
        app_id: 'test-app',
        action_id: 'type',
        params: '{"target":"vcp-searchbox-1","text":"VCP Agent"}',
        options: '{"strict":true}',
    });
    assertContentResult(action);
    assert.strictEqual(action.details.actionId, 'page_type');
    assert.strictEqual(action.details.response.result.verified, true);
    const actionCall = manager.calls.find((call) =>
        call[0] === 'executeWebAgentAction' && call[2] === 'type'
    );
    assert.strictEqual(actionCall[1], 'test-app');
    assert.strictEqual(actionCall[2], 'type');
    assert.strictEqual(actionCall[3].target, 'vcp-searchbox-1');
    assert.deepStrictEqual(actionCall[4], { strict: true });

    const serialStartedAt = Date.now();
    const serial = await loomController.processToolCall({
        appId: 'test-app',
        command1: 'click',
        target1: 'vcp-h-1-12-187-1pia4ka',
        snapshotId1: '12',
        strict1: 'true',
        command2: 'wait',
        waitMs2: '5',
        command3: 'get_page_info',
    });
    assertContentResult(serial);
    assert.strictEqual(serial.details.command, 'SerialExecute');
    assert.strictEqual(serial.details.count, 3);
    assert.strictEqual(serial.details.steps[1].waitMs, 5);
    assert(Date.now() - serialStartedAt >= 4);
    assert(serial.content.some((part) => part.text.includes('vcp-searchbox-1')));
    const serialActionCall = manager.calls.filter((call) =>
        call[0] === 'executeWebAgentAction'
    ).at(-1);
    assert.strictEqual(serialActionCall[1], 'test-app');
    assert.strictEqual(serialActionCall[2], 'click');
    assert.strictEqual(serialActionCall[3].target, 'vcp-h-1-12-187-1pia4ka');
    assert.strictEqual(serialActionCall[3].snapshotId, '12');
    assert.deepStrictEqual(serialActionCall[4], { strict: true });

    const callsBeforeFailure = manager.calls.length;
    const originalExecuteAction = manager.executeWebAgentAction;
    manager.executeWebAgentAction = async () => {
        throw new Error('模拟动作失败');
    };
    await assert.rejects(
        () => loomController.processToolCall({
            appId: 'test-app',
            command1: 'click',
            target1: 'vcp-button-1',
            command2: 'get_page_info',
        }),
        /串行步骤 1 \(click\) 失败，后续步骤已停止/
    );
    manager.executeWebAgentAction = originalExecuteAction;
    assert.strictEqual(
        manager.calls.slice(callsBeforeFailure).some((call) =>
            call[0] === 'getWebAgentPageInfo'
        ),
        false
    );

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
            command: 'GetPageImage',
            appId: 'test-app',
        }),
        /缺少必需参数 imageId/
    );
    await assert.rejects(
        () => loomController.processToolCall({
            command: 'ExecuteAction',
            appId: 'test-app',
        }),
        /缺少必需参数 actionId/
    );
    await assert.rejects(
        () => loomController.processToolCall({
            command: 'ExecuteAction',
            appId: 'test-app',
            actionId: 'click',
            params: '[]',
        }),
        /params 不是有效的 JSON 对象/
    );
    await assert.rejects(
        () => loomController.processToolCall({
            appId: 'test-app',
            command1: 'wait',
            waitMs1: '-1',
        }),
        /wait 时长必须是非负数/
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