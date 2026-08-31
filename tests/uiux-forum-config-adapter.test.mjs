import assert from 'node:assert/strict';
import test from 'node:test';

const { createForumConfigUiService } = await import('../modules/uiux/adapters/forum-config.ts');

test('Forum config UI adapter refreshes and publishes only successful saves', async () => {
    let state = { username: 'admin', password: 'secret' };
    let fail = true;
    const service = createForumConfigUiService({
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
    assert.equal(service.state.get().username, 'admin');
    assert.deepEqual(await service.save.execute({ username: 'next-admin' }), { success: false, error: 'denied' });
    assert.equal(service.state.get().username, 'admin');
    fail = false;
    assert.deepEqual(await service.save.execute({ username: 'next-admin' }), { success: true });
    assert.equal(service.state.get().username, 'next-admin');
    assert.deepEqual(revisions, [0, 1, 2]);
    await service.dispose();
});

test('Forum config UI adapter silences late refresh after dispose', async () => {
    let resolveRefresh;
    const service = createForumConfigUiService({
        get: () => new Promise(resolve => { resolveRefresh = resolve; }),
        save: async () => ({ success: true }),
    });
    const refresh = service.refresh.execute();
    await service.dispose();
    resolveRefresh({ username: 'late' });
    await refresh;
    assert.deepEqual(service.state.get(), {});
});

test('Forum config UI adapter turns hung saves into retryable timeout failures', async () => {
    const service = createForumConfigUiService({
        get: () => ({ username: 'admin' }),
        timeoutMs: 5,
        save: () => new Promise(() => {}),
    });
    const result = await service.save.execute({ username: 'hung' });
    assert.equal(result.success, false);
    assert.match(result.error || '', /timed out/);
    assert.equal(service.state.get().username, undefined);
    await service.dispose();
});
