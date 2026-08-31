import assert from 'node:assert/strict';
import test from 'node:test';

const { createRustAssistantUiService } = await import('../modules/uiux/adapters/rust-assistant.ts');

test('Rust Assistant UI adapter refreshes and saves through capability without durable duplicate state', async () => {
    let state = { useRustAssistant: true, debugMode: false, runtimeThresholds: { minDistance: 0 } };
    const pending = [];
    const service = createRustAssistantUiService({
        get: async () => state,
        save: patch => new Promise(resolve => pending.push({ patch, resolve })),
    });
    const revisions = [];
    service.state.subscribe((_value, snapshot) => revisions.push(snapshot.revision));
    await service.refresh.execute();
    assert.equal(service.state.get().debugMode, false);
    const saving = service.save.execute({ debugMode: true });
    assert.equal(pending.length, 1);
    pending[0].resolve({ success: true });
    await saving;
    assert.equal(service.state.get().debugMode, true);
    assert.deepEqual(revisions, [0, 1, 2]);
    await service.dispose();
    assert.deepEqual(await service.save.execute({ debugMode: false }), { success: false, error: 'Rust Assistant UI service disposed' });
});

test('Rust Assistant UI adapter silences late refresh after dispose', async () => {
    let resolveRefresh;
    const service = createRustAssistantUiService({
        get: () => new Promise(resolve => { resolveRefresh = resolve; }),
        save: async () => ({ success: true }),
    });
    const revisions = [];
    service.state.subscribe((_value, snapshot) => revisions.push(snapshot.revision));
    const refresh = service.refresh.execute();
    await service.dispose();
    resolveRefresh({ debugMode: true });
    await refresh;
    assert.deepEqual(revisions, [0]);
    assert.deepEqual(service.state.get(), {});
});

test('Rust Assistant UI adapter keeps failed saves out of the snapshot and supports retry', async () => {
    let fail = true;
    let state = { debugMode: false };
    const service = createRustAssistantUiService({
        get: () => state,
        save: async patch => {
            if (fail) return { success: false, error: 'denied' };
            state = { ...state, ...patch };
            return { success: true };
        },
    });
    const revisions = [];
    service.state.subscribe((_value, snapshot) => revisions.push(snapshot.revision));
    await service.refresh.execute();
    assert.deepEqual(await service.save.execute({ debugMode: true }), { success: false, error: 'denied' });
    assert.equal(service.state.get().debugMode, false);
    assert.deepEqual(revisions, [0, 1]);
    fail = false;
    assert.deepEqual(await service.save.execute({ debugMode: true }), { success: true });
    assert.equal(service.state.get().debugMode, true);
    assert.deepEqual(revisions, [0, 1, 2]);
    await service.dispose();
});
