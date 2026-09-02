import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { claimSaveCoordinator } from '../modules/ui-system/settings/save-coordinator.js';

test('settings Electron-facing contract drains close and exposes conflict recovery actions', async () => {
    const dom = new JSDOM('<form id="globalSettingsForm"></form>', { url: 'http://localhost/' });
    const form = dom.window.document.querySelector('form');
    const coordinator = claimSaveCoordinator(form);
    let pending = true;
    let release;
    coordinator.registerClient({ id: 'typed-settings-field-owner', hasWork: () => pending, flush: () => new Promise(resolve => { release = () => { pending = false; resolve(); }; }) });
    coordinator.reportState('conflict', { owner: 'typed-settings-field-owner' });
    assert.equal(coordinator.getSnapshot().status, 'conflict');
    const closing = coordinator.dispose();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(form.dataset.vcpAutosaveState, 'conflict');
    release();
    const result = await closing;
    assert.equal(result.status, 'conflict');
});

test('reloadExternal publishes the latest snapshot on the window event channel', async () => {
    const dom = new JSDOM('<form id="globalSettingsForm"></form>', { url: 'http://localhost/' });
    const form = dom.window.document.querySelector('form');
    const coordinator = claimSaveCoordinator(form);
    let received;
    dom.window.addEventListener('global-settings-updated', event => { received = event.detail; });
    dom.window.chatAPI = { loadSettings: async () => ({ userName: 'External', __vcpSettingsRevision: 'r2' }) };
    await coordinator.reloadExternal();
    assert.equal(received.settings.userName, 'External');
    assert.equal(received.revision, 'r2');
    await coordinator.dispose();
});
