import assert from 'node:assert/strict';
import test from 'node:test';

const { createAssistantRuntimeUiService } = await import('../modules/uiux/adapters/assistant-runtime.ts');

test('Assistant runtime UI adapter refreshes diagnostics and isolates late results', async () => {
    let resolveRefresh;
    const service = createAssistantRuntimeUiService({
        get: () => new Promise(resolve => { resolveRefresh = resolve; }),
    });
    const revisions = [];
    service.state.subscribe((_value, snapshot) => revisions.push(snapshot.revision));
    const refresh = service.refresh.execute();
    await service.dispose();
    resolveRefresh({ mode: 'rust', active: true });
    await refresh;
    assert.deepEqual(revisions, [0]);
    assert.deepEqual(await service.refresh.execute(), { success: false, error: 'Assistant runtime UI service disposed' });
});

test('Assistant runtime UI adapter publishes successful refresh only', async () => {
    let state = { mode: 'disabled', active: false };
    const service = createAssistantRuntimeUiService({ get: () => state });
    await service.refresh.execute();
    assert.equal(service.state.get().mode, 'disabled');
    state = { mode: 'rust', active: true };
    await service.refresh.execute();
    assert.equal(service.state.get().mode, 'rust');
    assert.equal(service.state.get().active, true);
    await service.dispose();
});
