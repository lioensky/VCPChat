'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { ChartService, _test } = require('../modules/services/chartService');

async function run() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-chart-service-'));
    const events = [];
    const windowCalls = [];
    const service = new ChartService({
        appDataRoot: root,
        logger: { warn() {} },
        windowAdapter: {
            isOpen: chartId => chartId === 'cpu-monitor',
            async open(chartId, options) {
                windowCalls.push(['open', chartId, options]);
            },
            async close(chartId) {
                windowCalls.push(['close', chartId]);
            },
            async observe(chartId, options) {
                windowCalls.push(['observe', chartId, options]);
                return {
                    content: [
                        { type: 'text', text: '观察完成' },
                        { type: 'image_url', image_url: { url: 'data:image/png;base64,aQ==' } },
                    ],
                    details: { chartId, stable: true },
                };
            },
            async getRuntimeStatus(chartId) {
                return { chartId, status: 'stable' };
            },
        },
    });
    service.on('change', event => events.push(event));
    await service.initialize();

    const created = await service.createChart({
        manifest: {
            id: 'cpu-monitor',
            name: 'CPU Monitor',
            description: '测试图表',
            libraries: ['anime', 'three'],
            window: { width: 800, height: 500 },
        },
        template: '<main id="dashboard"><strong id="cpu">0</strong></main>',
        style: 'body {\r\n  color: white;\r\n}',
        runtime: [
            'return {',
            '  mount(context) { context.root.dataset.ready = "true"; },',
            '  update(change, context) { context.root.dataset.revision = change.dataRevision; },',
            '  resize() {},',
            '  destroy() {}',
            '};',
        ].join('\r\n'),
        initialData: {
            metrics: { cpu: 10, memory: 20 },
            series: { cpu: [] },
            status: { active: true },
            counters: { samples: 0 },
        },
        open: true,
    }, {
        vcpContext: { agentId: 'agent-nova', topicId: 'topic-1' },
    });

    assert.strictEqual(created.manifest.id, 'cpu-monitor');
    assert.strictEqual(created.manifest.owner.agentId, 'agent-nova');
    assert.strictEqual(created.opened, true);
    assert.deepStrictEqual(windowCalls[0].slice(0, 2), ['open', 'cpu-monitor']);

    const listed = await service.listCharts();
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].opened, true);
    assert.strictEqual((await service.listCharts({ query: '测试' })).length, 1);
    assert.strictEqual((await service.listCharts({ query: 'missing' })).length, 0);

    const patched = await service.applyDataOperations('cpu-monitor', [
        { op: 'replace', path: '/metrics/cpu', value: 63.5 },
        { op: 'append', path: '/series/cpu', value: { t: 1, y: 63.5 }, maxItems: 2 },
        { op: 'increment', path: '/counters/samples', value: 1 },
        { op: 'toggle', path: '/status/active' },
        { op: 'merge', path: '/metrics', value: { temperature: 77 } },
    ], {
        expectedDataRevision: 1,
        operationId: 'sample-1',
    });

    assert.strictEqual(patched.dataRevision, 2);
    assert.deepStrictEqual(patched.changedPaths, [
        '/metrics/cpu',
        '/series/cpu',
        '/counters/samples',
        '/status/active',
        '/metrics',
    ]);
    const data = await service.readData('cpu-monitor');
    assert.strictEqual(data.metrics.cpu, 63.5);
    assert.strictEqual(data.metrics.temperature, 77);
    assert.strictEqual(data.counters.samples, 1);
    assert.strictEqual(data.status.active, false);
    assert.deepStrictEqual(data.series.cpu, [{ t: 1, y: 63.5 }]);

    const duplicateReceipt = await service.applyDataOperations('cpu-monitor', [
        { op: 'increment', path: '/counters/samples', value: 999 },
    ], {
        operationId: 'sample-1',
    });
    assert.deepStrictEqual(duplicateReceipt, patched);
    assert.strictEqual((await service.readData('cpu-monitor')).counters.samples, 1);

    await assert.rejects(
        service.applyDataOperations('cpu-monitor', [
            { op: 'replace', path: '/metrics/cpu', value: 70 },
        ], {
            expectedDataRevision: 1,
        }),
        error => error.code === 'CHART_REVISION_CONFLICT'
            && error.expected === 1
            && error.actual === 2
    );

    const sourceRange = await service.getSource('cpu-monitor', 'runtime.js', {
        lines: '2-3',
    });
    assert.strictEqual(sourceRange.lines.actualStart, 2);
    assert.strictEqual(sourceRange.lines.actualEnd, 3);
    assert(sourceRange.content.includes('mount(context)'));
    assert(!sourceRange.content.includes('destroy()'));

    const edited = await service.editSource('cpu-monitor', {
        file: 'runtime.js',
        expectedCodeRevision: 1,
        target: 'context.root.dataset.ready = "true";',
        replace: 'context.root.dataset.ready = "stable";',
    });
    assert.strictEqual(edited.matchCount, 1);
    assert.strictEqual(edited.lineEnding, 'CRLF');
    assert.strictEqual(edited.codeRevision, 2);
    const runtimeAfterEdit = (await service.readSources('cpu-monitor')).runtime;
    assert(runtimeAfterEdit.includes('dataset.ready = "stable"'));
    assert(runtimeAfterEdit.includes('\r\n'));

    await assert.rejects(
        service.editSource('cpu-monitor', {
            file: 'runtime.js',
            target: 'context.root',
            replace: 'context.host',
        }),
        error => error.code === 'CHART_EDIT_AMBIGUOUS_TARGET'
            && error.matchCount === 2
    );

    await assert.rejects(
        service.editSource('cpu-monitor', {
            file: 'runtime.js',
            content: 'return { mount( };',
        }),
        error => error.code === 'CHART_RUNTIME_SYNTAX_ERROR'
    );

    const observed = await service.observeChart('cpu-monitor', {
        width: 640,
        height: 360,
        mode: 'preview',
    });
    assert.strictEqual(observed.content[1].type, 'image_url');
    assert.deepStrictEqual(windowCalls.at(-1), [
        'observe',
        'cpu-monitor',
        { width: 640, height: 360, mode: 'preview' },
    ]);

    const status = await service.getRuntimeStatus('cpu-monitor');
    assert.strictEqual(status.status, 'stable');
    assert.strictEqual(status.codeRevision, 2);
    assert.strictEqual(status.dataRevision, 2);

    const deleted = await service.deleteChart('cpu-monitor', {
        expectedRevision: 3,
    });
    assert.strictEqual(deleted.recoverable, true);
    assert.strictEqual(await service.exists('cpu-monitor'), false);
    assert.strictEqual((await service.listDeletedCharts()).length, 1);

    const restored = await service.restoreChart(deleted.trashId);
    assert.strictEqual(restored.chartId, 'cpu-monitor');
    assert.strictEqual(await service.exists('cpu-monitor'), true);

    assert(events.some(event => event.type === 'created'));
    assert(events.some(event => event.type === 'data-patched'));
    assert(events.some(event => event.type === 'source-changed'));
    assert(events.some(event => event.type === 'deleted'));
    assert(events.some(event => event.type === 'restored'));

    assert.strictEqual(_test.countOccurrences('abc abc', 'abc'), 2);
    assert.strictEqual(_test.detectLineEnding('a\r\nb\r\n'), '\r\n');
    assert.deepStrictEqual(
        _test.applyDataOperation({ values: [1] }, {
            op: 'append',
            path: '/values',
            value: 2,
        }),
        { values: [1, 2] }
    );

    await service.shutdown();
    await fs.rm(root, { recursive: true, force: true });
    console.log('chart-service.test.js: all assertions passed');
}

run().catch(async error => {
    console.error(error);
    process.exitCode = 1;
});