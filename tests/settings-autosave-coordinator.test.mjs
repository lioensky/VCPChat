import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { claimSaveCoordinator } = await import('../modules/ui-system/settings/save-coordinator.js');
const SettingsManager = (await import('../modules/utils/appSettingsManager.js')).default;

class FakeForm extends EventTarget {
    constructor() {
        super();
        this.dataset = {};
        this.noValidate = false;
        this.submits = 0;
    }

    requestSubmit() {
        this.submits += 1;
    }
}

test('settings coordinator aggregates owner state and waits for an async flush barrier', async () => {
    const form = new FakeForm();
    const coordinator = claimSaveCoordinator(form);
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    coordinator.registerClient({ id: 'typed', flush: () => barrier });
    coordinator.registerClient({ id: 'legacy', isDefault: true });
    coordinator.reportState('dirty', { owner: 'typed' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(form.dataset.vcpAutosaveState, 'dirty');
    assert.equal(form.dataset.vcpSettingsDirty, 'true');
    let settled = false;
    const pending = coordinator.flush().then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(settled, false);
    release();
    await pending;
    await coordinator.dispose();
    assert.equal(form.dataset.vcpSettingsOperationId, undefined);
});

test('settings manager uses content revisions, deep patches, and exclusive locks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-settings-coordinator-'));
    const filename = path.join(dir, 'settings.json');
    const manager = new SettingsManager(filename);
    try {
        const initial = await manager.readSettings();
        const revision = manager.getRevision(initial);
        const first = await manager.updateSettings({ userName: 'Alice', appearanceProfile: { density: 'compact' } }, { expectedRevision: revision, operationId: 'a' });
        assert.equal(first.success, true);
        assert.equal(first.status, 'success');
        assert.equal(first.operationId, 'a');
        const second = await manager.updateSettings({ appearanceProfile: { fontScale: 'large' } }, { expectedRevision: revision, operationId: 'b' });
        assert.equal(second.success, false);
        assert.equal(second.status, 'conflict');
        assert.equal(second.code, 'SETTINGS_CONFLICT');
        const current = await manager.readSettings();
        assert.equal(current.userName, 'Alice');
        assert.equal(current.appearanceProfile.density, 'compact');
        const next = await manager.updateSettings({ appearanceProfile: { fontScale: 'large' } }, { expectedRevision: first.currentRevision, operationId: 'c' });
        assert.equal(next.success, true);
        const merged = await manager.readSettings();
        assert.equal(merged.appearanceProfile.density, 'compact');
        assert.equal(merged.appearanceProfile.fontScale, 'large');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
