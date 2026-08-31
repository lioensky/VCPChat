import assert from 'node:assert/strict';
import test from 'node:test';

const { createSettingsUiService } = await import('../modules/uiux/adapters/settings.ts');

test('typed SettingsUiService publishes only committed patches and releases external updates', async () => {
    let state = { currentThemeMode: 'light', density: 'comfortable' };
    let fail = true;
    const external = new Set();
    const service = createSettingsUiService({
        get: () => state,
        save: async patch => {
            if (fail) return { success: false, error: 'denied' };
            state = { ...state, ...patch };
            return { success: true };
        },
        subscribe: listener => {
            external.add(listener);
            return () => external.delete(listener);
        },
    });
    const revisions = [];
    const release = service.state.subscribe((_value, snapshot) => revisions.push(snapshot.revision));
    assert.deepEqual(revisions, [0]);
    const denied = await service.save.execute({ density: 'compact' });
    assert.deepEqual(denied, { success: false, error: 'denied' });
    assert.equal(service.state.get().density, 'comfortable');
    assert.deepEqual(revisions, [0]);
    fail = false;
    const saved = await service.save.execute({ density: 'compact' });
    assert.deepEqual(saved, { success: true });
    assert.equal(service.state.get().density, 'compact');
    assert.deepEqual(revisions, [0, 1]);
    external.forEach(listener => listener({ currentThemeMode: 'dark' }));
    assert.equal(service.state.get().currentThemeMode, 'dark');
    assert.equal(service.state.get().density, 'compact', 'partial external patch preserves unrelated settings');
    assert.deepEqual(revisions, [0, 1, 2]);
    external.forEach(listener => listener({ currentThemeMode: 'dark' }));
    assert.deepEqual(revisions, [0, 1, 2], 'identical external snapshot is deduplicated');
    release();
    await service.dispose?.();
    assert.equal(external.size, 0);
});

test('typed SettingsUiService rejects stale save publication and silences late results after dispose', async () => {
    let state = { density: 'comfortable' };
    const pending = [];
    const external = new Set();
    const service = createSettingsUiService({
        get: () => state,
        save: patch => new Promise(resolve => pending.push({ patch, resolve })),
        subscribe: listener => {
            external.add(listener);
            return () => external.delete(listener);
        },
    });
    const snapshots = [];
    service.state.subscribe((_value, snapshot) => snapshots.push(snapshot));

    const first = service.save.execute({ density: 'compact' });
    const second = service.save.execute({ density: 'spacious' });
    assert.equal(pending.length, 2);
    pending[1].resolve({ success: true });
    await second;
    pending[0].resolve({ success: true });
    await first;
    assert.equal(service.state.get().density, 'spacious');
    assert.deepEqual(snapshots.map(snapshot => snapshot.revision), [0, 1]);

    await service.dispose?.();
    external.forEach(listener => listener({ density: 'late-external' }));
    assert.equal(service.state.get().density, 'spacious');
    assert.deepEqual(snapshots.map(snapshot => snapshot.revision), [0, 1]);
});

test('typed SettingsUiService invalidates a timed-out save without disposing the service', async () => {
    let resolveSave;
    let cancelled = false;
    const service = createSettingsUiService({
        get: () => ({ density: 'comfortable' }),
        save: () => new Promise(resolve => { resolveSave = resolve; }),
        cancelPendingSaves: () => { cancelled = true; },
    });
    const revisions = [];
    service.state.subscribe((_value, snapshot) => revisions.push(snapshot.revision));
    const pending = service.save.execute({ density: 'compact' });
    service.cancelPendingSaves?.();
    assert.equal(cancelled, true, 'service cancellation reaches the adapter owner');
    resolveSave({ success: true });
    assert.deepEqual(await pending, { success: true });
    assert.equal(service.state.get().density, 'comfortable');
    assert.deepEqual(revisions, [0], 'late completion cannot publish after timeout invalidation');
    await service.dispose?.();
});

test('typed SettingsUiService rolls back failed immediate subscriptions and isolates publish failures', () => {
    let state = { density: 'comfortable' };
    const external = new Set();
    const service = createSettingsUiService({
        get: () => state,
        save: patch => {
            state = { ...state, ...patch };
            return { success: true };
        },
        subscribe: listener => {
            external.add(listener);
            return () => external.delete(listener);
        },
    });
    let failedCalls = 0;
    assert.throws(() => service.state.subscribe(() => {
        failedCalls += 1;
        throw new Error('immediate consumer failed');
    }));
    let healthyCalls = 0;
    service.state.subscribe(() => { healthyCalls += 1; }, { immediate: false });
    external.forEach(listener => listener({ density: 'compact' }));
    assert.equal(failedCalls, 1, 'failed immediate subscriber is retracted');
    assert.equal(healthyCalls, 1, 'healthy subscriber still receives external snapshot');
});
