import assert from 'node:assert/strict';
import test from 'node:test';

import { createUiScope } from '../modules/uiux/runtime/scope.ts';
import { createUiServiceRegistry } from '../modules/uiux/runtime/service-registry.ts';

async function makeScope(label = 'registry-test') {
    const module = await import('../modules/ui-system/lifecycle-scope.js');
    const { LifecycleScope } = module.default || module;
    return createUiScope(new LifecycleScope(label));
}

test('service registry assembles, exposes, and retracts a scoped service', async () => {
    const scope = await makeScope();
    const registry = createUiServiceRegistry(scope);
    let disposed = 0;
    const definition = {
        id: 'example',
        provide: () => ({ dispose: () => { disposed += 1; } }),
    };
    const service = registry.install(definition);
    assert.equal(registry.get('example'), service);
    await registry.release('example');
    assert.equal(registry.get('example'), undefined);
    assert.equal(disposed, 1);
    await registry.dispose();
    await scope.dispose('test-end');
});

test('service registry rejects duplicate ids and unwinds in reverse order', async () => {
    const scope = await makeScope('registry-order');
    const registry = createUiServiceRegistry(scope);
    const order = [];
    const make = id => ({ id, provide: () => ({ dispose: () => order.push(id) }) });
    registry.install(make('first'));
    registry.install(make('second'));
    assert.throws(() => registry.install(make('first')), /already installed/);
    await registry.dispose('surface-close');
    assert.deepEqual(order, ['second', 'first']);
    assert.equal(scope.active, true, 'parent scope remains owned by its caller');
    await scope.dispose('test-end');
});

test('failed provider leaves no registration', async () => {
    const scope = await makeScope('registry-failure');
    const registry = createUiServiceRegistry(scope);
    assert.throws(() => registry.install({ id: 'broken', provide: () => { throw new Error('boom'); } }), /boom/);
    assert.equal(registry.get('broken'), undefined);
    await registry.dispose();
    await scope.dispose('test-end');
});

test('parent scope teardown invalidates the registry view', async () => {
    const scope = await makeScope('registry-parent-teardown');
    const registry = createUiServiceRegistry(scope);
    registry.install({ id: 'owned', provide: () => ({ dispose() {} }) });
    assert.ok(registry.get('owned'));
    await scope.dispose('window-destroyed');
    assert.equal(registry.get('owned'), undefined);
    assert.throws(() => registry.install({ id: 'late', provide: () => ({}) }), /disposed/);
});

test('service release waits for async disposer quiescence', async () => {
    const scope = await makeScope('registry-async-release');
    const registry = createUiServiceRegistry(scope);
    let resolveDispose;
    let disposed = false;
    registry.install({
        id: 'async-service',
        provide: () => ({
            dispose: () => new Promise(resolve => {
                resolveDispose = () => { disposed = true; resolve(); };
            }),
        }),
    });
    const releasing = registry.release('async-service');
    let settled = false;
    releasing.finally(() => { settled = true; }).catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(disposed, false);
    resolveDispose();
    await releasing;
    assert.equal(settled, true);
    assert.equal(disposed, true);
    assert.equal(registry.get('async-service'), undefined);
    await registry.dispose();
    await scope.dispose('test-end');
});
