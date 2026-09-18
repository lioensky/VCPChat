'use strict';

const assert = require('assert');
const controller = require('../VCPDistributedServer/Plugin/ChartController/ChartControllerService');
const manifest = require('../VCPDistributedServer/Plugin/ChartController/plugin-manifest.json');

function createFakeService() {
    const calls = [];
    const chart = {
        id: 'cpu-monitor',
        name: 'CPU Monitor',
        description: 'CPU 状态',
        revision: 3,
        codeRevision: 2,
        dataRevision: 4,
        libraries: ['anime'],
        window: { width: 800, height: 500 },
        opened: true,
    };
    return {
        calls,
        async listCharts(options) {
            calls.push(['listCharts', options]);
            return [chart];
        },
        async readManifest(chartId) {
            calls.push(['readManifest', chartId]);
            return { ...chart, id: chartId };
        },
        async readData(chartId) {
            calls.push(['readData', chartId]);
            return {
                metrics: { cpu: 63.5 },
                series: { cpu: [{ t: 1, y: 63.5 }] },
            };
        },
        async getSource(chartId, file, options) {
            calls.push(['getSource', chartId, file, options]);
            return {
                chartId,
                file,
                content: 'return { mount() {}, update() {}, destroy() {} };',
                lines: { actualStart: 1, actualEnd: 1, totalLines: 1 },
                totalBytes: 51,
                hash: 'abc',
                codeRevision: 2,
                dataRevision: 4,
            };
        },
        async createChart(input, context) {
            calls.push(['createChart', input, context]);
            return {
                manifest: { ...chart, id: input.manifest.id, name: input.manifest.name },
                diagnostics: [],
                opened: input.open,
            };
        },
        async openChart(chartId, options) {
            calls.push(['openChart', chartId, options]);
            return { chartId, opened: true };
        },
        async closeChart(chartId) {
            calls.push(['closeChart', chartId]);
            return { chartId, closed: true };
        },
        async deleteChart(chartId, options, context) {
            calls.push(['deleteChart', chartId, options, context]);
            return {
                chartId,
                trashId: `${chartId}-1`,
                deletedAt: '2026-09-18T00:00:00.000Z',
                recoverable: true,
            };
        },
        async listDeletedCharts() {
            return [{
                chartId: 'old-chart',
                name: '旧图表',
                trashId: 'old-chart-1',
                deletedAt: '2026-09-18T00:00:00.000Z',
            }];
        },
        async restoreChart(trashId) {
            calls.push(['restoreChart', trashId]);
            return { chartId: 'old-chart', trashId };
        },
        async purgeChart(trashId) {
            calls.push(['purgeChart', trashId]);
            return { trashId, purged: true };
        },
        async applyDataOperations(chartId, operations, options, context) {
            calls.push(['applyDataOperations', chartId, operations, options, context]);
            return {
                chartId,
                revision: 4,
                oldDataRevision: 4,
                dataRevision: 5,
                operations,
                changedPaths: operations.map(operation => operation.path),
            };
        },
        async replaceData(chartId, data, options, context) {
            calls.push(['replaceData', chartId, data, options, context]);
            return { chartId, revision: 4, dataRevision: 5 };
        },
        async editSource(chartId, edit, context) {
            calls.push(['editSource', chartId, edit, context]);
            return {
                chartId,
                file: edit.file,
                oldCodeRevision: 2,
                codeRevision: 3,
                revision: 4,
                matchCount: edit.content === undefined ? 1 : null,
                lineEnding: 'LF',
                hash: 'def',
                diagnostics: [],
            };
        },
        async rollbackSource(chartId, file, revision, context) {
            calls.push(['rollbackSource', chartId, file, revision, context]);
            return { chartId, file, codeRevision: 4 };
        },
        async observeChart(chartId, options) {
            calls.push(['observeChart', chartId, options]);
            return {
                content: [
                    { type: 'text', text: '图表观察完成' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,aQ==' } },
                ],
                details: {
                    command: 'ObserveChart',
                    chartId,
                    stable: true,
                    warnings: [],
                },
            };
        },
        async getRuntimeStatus(chartId) {
            calls.push(['getRuntimeStatus', chartId]);
            return {
                chartId,
                status: 'stable',
                codeRevision: 2,
                dataRevision: 4,
            };
        },
    };
}

function assertResult(result) {
    assert(result);
    assert(Array.isArray(result.content));
    assert(result.content.length >= 1);
    assert.strictEqual(result.content[0].type, 'text');
    assert(result.details && typeof result.details === 'object');
}

async function run() {
    const commands = manifest.capabilities.invocationCommands.map(item => item.command);
    for (const command of [
        'ListCharts',
        'CreateChart',
        'SetData',
        'PatchData',
        'EditChartSource',
        'ObserveChart',
    ]) {
        assert(commands.includes(command), `Manifest 缺少 ${command}`);
    }

    controller._test.resetForTests();
    const service = createFakeService();
    controller.initialize({
        services: { chartService: service },
        logger: console,
    });

    const listed = await controller.processToolCall({ command: 'ListCharts' });
    assertResult(listed);
    assert.strictEqual(listed.details.count, 1);
    assert(listed.content[0].text.includes('cpu-monitor'));

    const chartData = await controller.processToolCall({
        command: 'GetChartData',
        chartId: 'cpu-monitor',
        path: '/metrics/cpu',
    });
    assertResult(chartData);
    assert.strictEqual(chartData.details.data, 63.5);

    const source = await controller.processToolCall({
        command: 'GetChartSource',
        chartId: 'cpu-monitor',
        file: 'runtime.js',
        lines: '1',
    });
    assertResult(source);
    assert(source.content[0].text.includes('```javascript'));
    assert.strictEqual(source.details.hash, 'abc');

    const trustedContext = {
        requestId: 'chart-create-1',
        vcpContext: { agentId: 'agent-nova', topicId: 'topic-1' },
    };
    const created = await controller.processToolCall({
        command: 'CreateChart',
        manifest: '{"id":"new-chart","name":"新图表","libraries":["anime"]}',
        template: '<main></main>',
        style: 'main{}',
        runtime: 'return { mount(){}, update(){}, destroy(){} };',
        initialData: '{"value":1}',
    }, trustedContext);
    assertResult(created);
    const createCall = service.calls.find(call => call[0] === 'createChart');
    assert.strictEqual(createCall[1].manifest.id, 'new-chart');
    assert.strictEqual(createCall[1].open, true);
    assert.strictEqual(createCall[2], trustedContext);

    const set = await controller.processToolCall({
        command: 'SetData',
        chartId: 'cpu-monitor',
        path: '/metrics/cpu',
        value: '72.5',
        expectedDataRevision: '4',
    }, trustedContext);
    assertResult(set);
    const setCall = service.calls.filter(call => call[0] === 'applyDataOperations').at(-1);
    assert.deepStrictEqual(setCall[2], [{
        op: 'replace',
        path: '/metrics/cpu',
        value: 72.5,
    }]);
    assert.strictEqual(setCall[3].expectedDataRevision, '4');

    const numbered = await controller.processToolCall({
        command: 'MutateData',
        chartId: 'cpu-monitor',
        op1: 'replace',
        path1: '/metrics/cpu',
        value1: '80',
        op2: 'append',
        path2: '/series/cpu',
        value2: '{"t":2,"y":80}',
        maxItems2: '120',
    });
    assertResult(numbered);
    const numberedCall = service.calls.filter(call => call[0] === 'applyDataOperations').at(-1);
    assert.strictEqual(numberedCall[2].length, 2);
    assert.deepStrictEqual(numberedCall[2][1].value, { t: 2, y: 80 });
    assert.strictEqual(numberedCall[2][1].maxItems, '120');

    const edited = await controller.processToolCall({
        command: 'EditChartSource',
        chartId: 'cpu-monitor',
        file: 'style.css',
        target: 'color:red',
        replace: 'color:blue',
        expectedCodeRevision: '2',
    });
    assertResult(edited);
    const editCall = service.calls.find(call => call[0] === 'editSource');
    assert.strictEqual(editCall[2].target, 'color:red');
    assert.strictEqual(editCall[2].replace, 'color:blue');

    const observed = await controller.processToolCall({
        command: 'ObserveChart',
        chartId: 'cpu-monitor',
        mode: 'preview',
        width: '800',
        height: '500',
    });
    assert.strictEqual(observed.content[1].type, 'image_url');
    assert(observed.content[1].image_url.url.startsWith('data:image/png;base64,'));
    const observeCall = service.calls.find(call => call[0] === 'observeChart');
    assert.strictEqual(observeCall[2].width, 800);

    await assert.rejects(
        controller.processToolCall({
            command: 'PurgeChart',
            trashId: 'old-chart-1',
        }),
        /confirm=true/
    );

    const purged = await controller.processToolCall({
        command: 'PurgeChart',
        trashId: 'old-chart-1',
        confirm: 'true',
    });
    assertResult(purged);

    const runtimeStatus = await controller.processToolCall({
        command: 'GetChartRuntimeStatus',
        chartId: 'cpu-monitor',
    });
    assertResult(runtimeStatus);
    assert.strictEqual(runtimeStatus.details.status, 'stable');

    await assert.rejects(
        controller.processToolCall({ command: 'OpenChart' }),
        /缺少必需参数 chartId/
    );
    await assert.rejects(
        controller.processToolCall({ command: 'Unknown' }),
        /不支持的 command/
    );

    controller._test.resetForTests();
    await assert.rejects(
        controller.processToolCall({ command: 'ListCharts' }),
        /图表服务当前不可用/
    );

    console.log('chart-controller.test.js: all assertions passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});