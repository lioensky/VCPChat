import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { claimSaveCoordinator, getSaveCoordinator } from '../modules/ui-system/settings/save-coordinator.js';

function setup() {
    const dom = new JSDOM('<!doctype html><body><div id="globalSettingsModal" class="active" tabindex="-1"><form id="globalSettingsForm"><input value="Draft"></form></div></body>', { runScripts: 'outside-only' });
    const { window } = dom;
    window.eval(fs.readFileSync('modules/ui-helpers.js', 'utf8'));
    const form = window.document.getElementById('globalSettingsForm');
    const coordinator = claimSaveCoordinator(form);
    coordinator.setDurableBase({ userName: 'Initial' }, 'r1');
    let saving = Promise.resolve();
    coordinator.registerClient({ id: 'field', flush: () => saving });
    window.VCPUISettingsBridge = { flush: () => coordinator.flush() };
    const patch = { userName: 'Draft' };
    const ops = [{ op: 'set', path: ['userName'], value: 'Draft' }];
    function save(request) {
        coordinator.recordDraft(patch, ops);
        coordinator.reportState('dirty', { owner: 'field' });
        saving = coordinator.savePatch(patch, { owner: 'field', transport: () => request.promise }).then(result => {
            coordinator.recordCommit(result, patch, ops);
            coordinator.reportState(result.success ? 'saved' : 'error', { owner: 'field', dirty: !result.success });
            return result;
        });
        return saving;
    }
    return { dom, window, form, coordinator, save, helpers: window.uiHelperFunctions };
}

test('a hidden settings form receives the failed terminal result and retains its draft for a successful retry', async () => {
    const { dom, helpers, form, coordinator, save } = setup();
    const first = Promise.withResolvers(), retry = Promise.withResolvers();
    try {
        const failed = save(first);
        assert.equal(helpers.closeModal('globalSettingsModal'), true);
        assert.equal(getSaveCoordinator(form), coordinator);
        first.resolve({ success: false, status: 'failed', error: 'temporary write failure' });
        await failed;
        const state = await coordinator.flush();
        assert.equal(state.status, 'error');
        assert.equal(state.durableBase.userName, 'Initial');
        assert.equal(state.draft.userName, 'Draft');
        assert.equal(state.pendingOps.length, 1);
        assert.equal(form.dataset.vcpSettingsDirty, 'true');
        helpers.openModal('globalSettingsModal');
        const saved = save(retry);
        assert.equal(helpers.closeModal('globalSettingsModal'), true);
        retry.resolve({ success: true, status: 'success', settings: { userName: 'Draft' }, currentRevision: 'r2' });
        await saved;
        const durable = await coordinator.flush();
        assert.equal(durable.status, 'saved');
        assert.equal(durable.durableBase.userName, 'Draft');
        assert.equal(durable.durableRevision, 'r2');
        assert.equal(durable.pendingOps.length, 0);
        assert.equal(form.dataset.vcpSettingsDirty, undefined);
        assert.equal(form.isConnected, true);
    } finally {
        first.resolve({ success: true, status: 'success' });
        retry.resolve({ success: true, status: 'success' });
        await coordinator.dispose();
        dom.window.close();
    }
});

test('owner teardown of a hidden settings form waits for its real terminal result before releasing the coordinator', async () => {
    const { dom, helpers, form, coordinator, save } = setup();
    const request = Promise.withResolvers();
    try {
        const saving = save(request);
        helpers.closeModal('globalSettingsModal');
        let disposed = false;
        const teardown = coordinator.dispose().then(() => { disposed = true; });
        await Promise.resolve();
        assert.equal(disposed, false);
        assert.equal(getSaveCoordinator(form), coordinator);
        request.resolve({ success: true, status: 'success', settings: { userName: 'Draft' }, currentRevision: 'r2' });
        await Promise.all([saving, teardown]);
        assert.equal(disposed, true);
        assert.equal(getSaveCoordinator(form), null);
        assert.equal(form.dataset.vcpSettingsOperationId, undefined);
        assert.equal(coordinator.getSnapshot().durableBase.userName, 'Draft');
    } finally {
        request.resolve({ success: true, status: 'success' });
        await coordinator.dispose();
        dom.window.close();
    }
});
