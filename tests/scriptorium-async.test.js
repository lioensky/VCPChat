'use strict';

const assert = require('assert');
const {
    createCoordinator,
    createLatestTokenRegistry,
    createSerialQueue,
} = require('../ScriptoriumModules/scriptorium-async');

async function testLatestTokenRegistry() {
    const registry = createLatestTokenRegistry();
    const first = registry.begin('open');
    const second = registry.begin('open');

    assert.strictEqual(first.isCurrent(), false, '较早的打开意图必须失效');
    assert.strictEqual(second.isCurrent(), true, '最后的打开意图必须保持有效');
    assert.strictEqual(registry.isCurrent(second), true);

    registry.invalidate('open');
    assert.strictEqual(second.isCurrent(), false, '显式失效必须终止当前意图');

    const unrelated = registry.begin('export');
    assert.strictEqual(unrelated.isCurrent(), true, '不同通道不得互相干扰');
}

async function testSerialQueue() {
    const queue = createSerialQueue();
    const order = [];

    const first = queue.enqueue(async () => {
        order.push('first:start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('first:end');
        return 1;
    });
    const failed = queue.enqueue(async () => {
        order.push('failed');
        throw new Error('expected');
    });
    const third = queue.enqueue(async () => {
        order.push('third');
        return 3;
    });

    assert.strictEqual(await first, 1);
    await assert.rejects(failed, /expected/);
    assert.strictEqual(await third, 3);
    await queue.whenIdle();
    assert.deepStrictEqual(order, [
        'first:start',
        'first:end',
        'failed',
        'third',
    ], '队列必须严格串行，且失败不能毒化后续任务');
}

async function testCoordinatorContext() {
    const state = {
        generation: 4,
        documentId: 'document-a',
        revision: 7,
    };
    const coordinator = createCoordinator({
        getGeneration: () => state.generation,
        getDocumentId: () => state.documentId,
        getRevision: () => state.revision,
    });
    const context = coordinator.captureContext({ operation: 'save' });

    assert.strictEqual(context.operation, 'save');
    assert.strictEqual(coordinator.isContextCurrent(context), true);

    state.revision += 1;
    assert.strictEqual(
        coordinator.isContextCurrent(context),
        true,
        '默认上下文检查允许同一文档在异步保存期间继续编辑'
    );
    assert.strictEqual(
        coordinator.isContextCurrent(context, { revision: true }),
        false,
        '需要稳定快照的操作必须能检查修订变化'
    );

    state.documentId = 'document-b';
    assert.strictEqual(
        coordinator.isContextCurrent(context),
        false,
        '文档身份改变后旧异步结果必须失效'
    );

    state.documentId = 'document-a';
    state.generation += 1;
    assert.strictEqual(
        coordinator.isContextCurrent(context, { document: false }),
        false,
        '即使忽略文档 ID，窗口文档代次变化也必须使上下文失效'
    );
}

async function testNamedCoordinatorQueues() {
    const coordinator = createCoordinator();
    const order = [];

    const slowSave = coordinator.enqueue('save', async () => {
        order.push('save:start');
        await new Promise((resolve) => setTimeout(resolve, 15));
        order.push('save:end');
    });
    const checkpoint = coordinator.enqueue('save', async () => {
        order.push('checkpoint');
    });
    const independentExport = coordinator.enqueue('export', async () => {
        order.push('export');
    });

    await Promise.all([slowSave, checkpoint, independentExport]);
    assert.ok(
        order.indexOf('checkpoint') > order.indexOf('save:end'),
        '同名通道必须串行'
    );
    assert.ok(order.includes('export'), '独立通道必须正常执行');
}

async function run() {
    await testLatestTokenRegistry();
    await testSerialQueue();
    await testCoordinatorContext();
    await testNamedCoordinatorQueues();
    console.log('[ScriptoriumAsync] PASSED');
}

run().catch((error) => {
    console.error('[ScriptoriumAsync] FAILED', error);
    process.exitCode = 1;
});