import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';

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
        assert.equal(second.settings.userName, 'Alice');
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

test('settings manager applies path set and unset operations without replacing siblings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-settings-path-'));
    const filename = path.join(dir, 'settings.json');
    const manager = new SettingsManager(filename);
    try {
        const initial = await manager.readSettings();
        const result = await manager.updateSettings({ __vcpSettingsOps: [
            { op: 'set', path: ['appearanceProfile', 'density'], value: 'compact' },
            { op: 'set', path: ['appearanceProfile', 'fontScale'], value: 'large' },
            { op: 'unset', path: ['vcpApiKey'] },
        ] }, { expectedRevision: manager.getRevision(initial), operationId: 'path-op' });
        assert.equal(result.success, true);
        const saved = await manager.readSettings({ fresh: true });
        assert.equal(saved.appearanceProfile.density, 'compact');
        assert.equal(saved.appearanceProfile.fontScale, 'large');
        assert.equal(saved.appearanceProfile.radius, initial.appearanceProfile.radius);
        assert.equal(saved.vcpApiKey, '');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('settings manager returns the persisted normalized revision for consecutive Next UI appearance saves', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-settings-normalized-revision-'));
    const filename = path.join(dir, 'settings.json');
    const manager = new SettingsManager(filename);
    try {
        const initial = await manager.readSettings();
        const first = await manager.updateSettings({
            __vcpSettingsOps: [
                { op: 'set', path: ['appearanceProfile', 'sidebarRowHeight'], value: 100 },
            ],
        }, {
            expectedRevision: manager.getRevision(initial),
            operationId: 'normalized-first',
        });

        assert.equal(first.success, true);
        assert.equal(first.settings.appearanceProfile.sidebarRowHeight, 64);
        const persisted = await manager.readSettings({ fresh: true });
        assert.equal(persisted.appearanceProfile.sidebarRowHeight, 64);
        assert.equal(first.currentRevision, manager.getRevision(persisted),
            'save response revision must identify the normalized settings.json bytes');

        const second = await manager.updateSettings({
            __vcpSettingsOps: [
                { op: 'set', path: ['appearanceProfile', 'density'], value: 'compact' },
            ],
        }, {
            expectedRevision: first.currentRevision,
            operationId: 'normalized-second',
        });
        assert.equal(second.success, true, 'the next appearance edit must not report a false CAS conflict');
        assert.equal(second.settings.appearanceProfile.density, 'compact');
        assert.equal(second.settings.appearanceProfile.sidebarRowHeight, 64);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('coordinator exposes explicit retry and external reload actions', async () => {
    const form = new FakeForm();
    const coordinator = claimSaveCoordinator(form);
    let flushed = false;
    coordinator.registerClient({ id: 'owner', flush: async () => { flushed = true; } });
    await coordinator.retryDraft();
    assert.equal(flushed, true);
    await coordinator.dispose();
});

test('coordinator keeps durable base, draft, and pending path operations independent', async () => {
    const form = new FakeForm();
    const coordinator = claimSaveCoordinator(form);
    coordinator.setDurableBase({ userName: 'Initial', appearanceProfile: { density: 'comfortable' } }, 'r1');
    coordinator.recordDraft({ userName: 'Draft' }, [{ op: 'set', path: ['userName'], value: 'Draft' }]);
    let state = coordinator.getSnapshot();
    assert.equal(state.durableRevision, 'r1');
    assert.equal(state.durableBase.userName, 'Initial');
    assert.equal(state.draft.userName, 'Draft');
    assert.equal(state.pendingOps.length, 1);
    coordinator.recordDraft({ appearanceProfile: { fontScale: 'large' } }, []);
    state = coordinator.getSnapshot();
    assert.equal(state.draft.appearanceProfile.density, 'comfortable');
    assert.equal(state.draft.appearanceProfile.fontScale, 'large');
    assert.equal(Object.isFrozen(state.draft.appearanceProfile), true);
    coordinator.reportState('conflict');
    coordinator.recordCommit({ status: 'conflict', code: 'SETTINGS_CONFLICT', currentRevision: 'r2' });
    state = coordinator.getSnapshot();
    assert.equal(state.status, 'conflict');
    assert.equal(state.draft.userName, 'Draft');
    await coordinator.dispose();
});

test('coordinator adopts the normalized durable response and reapplies only pending operations', async () => {
    const form = new FakeForm();
    const coordinator = claimSaveCoordinator(form);
    coordinator.setDurableBase({ appearanceProfile: { sidebarRowHeight: 46, density: 'comfortable' } }, 'r1');
    const committed = { op: 'set', path: ['appearanceProfile', 'sidebarRowHeight'], value: 100 };
    const pending = { op: 'set', path: ['appearanceProfile', 'density'], value: 'compact' };
    coordinator.recordDraft({ appearanceProfile: { sidebarRowHeight: 100 } }, [committed]);
    coordinator.recordDraft({ appearanceProfile: { density: 'compact' } }, [pending]);
    coordinator.recordCommit({
        success: true,
        status: 'success',
        currentRevision: 'r2',
        settings: { appearanceProfile: { sidebarRowHeight: 64, density: 'comfortable' } },
    }, { appearanceProfile: { sidebarRowHeight: 100 } }, [committed]);
    const state = coordinator.getSnapshot();
    assert.equal(state.durableRevision, 'r2');
    assert.equal(state.durableBase.appearanceProfile.sidebarRowHeight, 64);
    assert.equal(state.draft.appearanceProfile.sidebarRowHeight, 64);
    assert.equal(state.draft.appearanceProfile.density, 'compact');
    assert.deepEqual(state.pendingOps, [pending]);
    await coordinator.dispose();
});

test('client registration release removes remounted owner without affecting others', async () => {
    const form = new FakeForm();
    const coordinator = claimSaveCoordinator(form);
    const releaseTyped = coordinator.registerClient({ id: 'typed' });
    coordinator.registerClient({ id: 'legacy', isDefault: true });
    assert.equal(coordinator.hasClient('typed'), true);
    releaseTyped();
    assert.equal(coordinator.hasClient('typed'), false);
    assert.equal(coordinator.hasClient('legacy'), true);
    await coordinator.dispose();
});

test('coordinator savePatch is the operation-aware typed transport', async () => {
    const form = new FakeForm();
    const coordinator = claimSaveCoordinator(form);
    const calls = [];
    const result = await coordinator.savePatch({ appearanceProfile: { density: 'compact' } }, {
        owner: 'typed',
        expectedRevision: 'r1',
        transport: async payload => { calls.push(payload); return { success: true, currentRevision: 'r2' }; },
    });
    assert.equal(result.status, 'success');
    assert.equal(result.operationId.startsWith('settings-'), true);
    assert.deepEqual(calls[0].__vcpSettingsOps, [{ op: 'set', path: ['appearanceProfile', 'density'], value: 'compact' }]);
    assert.equal(calls[0].expectedRevision, 'r1');
    assert.equal(coordinator.getSnapshot().status, 'idle');
    await coordinator.dispose();
});

test('typed rapid edits advance the durable revision before stale publication', async () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousCustomEvent = globalThis.CustomEvent;
    const dom = new JSDOM('<!doctype html><form id="globalSettingsForm"></form>', { url: 'http://localhost' });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.CustomEvent = dom.window.CustomEvent;
    const adapter = await import('../modules/uiux/generated/adapters/settings.js');
    const pending = [];
    window.VCPUIUX = { createSettingsUiService: adapter.createSettingsUiService };
    window.chatAPI = {
        saveSettings(payload) {
            const request = { payload, resolve: null };
            pending.push(request);
            return new Promise(resolve => { request.resolve = resolve; });
        },
        onSettingsExternalUpdated() { return () => {}; },
    };
    const form = document.getElementById('globalSettingsForm');
    claimSaveCoordinator(form);
    const owners = await import(`../modules/ui-system/typed-field-owners.js?rapid=${Date.now()}`);
    const service = owners.ensureTypedSettingsService();
    try {
        const first = service.save.execute({ userName: 'A' });
        const second = service.save.execute({ continueWritingPrompt: 'B' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(pending.length, 1, 'first typed write starts before the second queued edit');
        pending[0].resolve({ success: true, status: 'success', currentRevision: 'r1', settings: { userName: 'A' } });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(pending.length, 2, 'second typed write is scheduled after the first settles');
        assert.equal(pending[1].payload.expectedRevision, 'r1', 'queued edit uses the first durable revision');
        pending[1].resolve({ success: true, status: 'success', currentRevision: 'r2', settings: { userName: 'A', continueWritingPrompt: 'B' } });
        assert.equal((await first).status, 'stale', 'superseded caller is stale but its durable commit is retained');
        assert.equal((await second).status, 'success');
        const snapshot = claimSaveCoordinator(form).getSnapshot();
        assert.equal(snapshot.durableRevision, 'r2');
        assert.equal(snapshot.pendingOps.length, 0, 'both durable operations leave no stranded pending patch');
    } finally {
        await service.dispose?.();
        dom.window.close();
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        globalThis.CustomEvent = previousCustomEvent;
    }
});

test('coordinator operation resolves only from its matching terminal result', async () => {
    const form = new FakeForm();
    const coordinator = claimSaveCoordinator(form);
    const operationId = coordinator.createOperation('owner');
    let settled = false;
    const tracked = coordinator.track(operationId, new Promise(() => {}));
    tracked.then(() => { settled = true; });
    form.dispatchEvent(new CustomEvent('vcp-settings-save-result', { detail: { operationId: 'other', status: 'success', success: true } }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(settled, false);
    form.dispatchEvent(new CustomEvent('vcp-settings-save-result', { detail: { operationId, status: 'failed', success: false } }));
    const result = await tracked;
    assert.equal(result.status, 'failed');
    await coordinator.dispose();
});

test('two manager instances serialize writes and report a revision conflict', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-settings-race-'));
    const filename = path.join(dir, 'settings.json');
    const first = new SettingsManager(filename);
    const second = new SettingsManager(filename);
    try {
        const base = await first.readSettings();
        const revision = first.getRevision(base);
        const [a, b] = await Promise.all([
            first.updateSettings({ userName: 'First' }, { expectedRevision: revision, operationId: 'first' }),
            second.updateSettings({ userName: 'Second' }, { expectedRevision: revision, operationId: 'second' }),
        ]);
        assert.equal([a.status, b.status].filter(status => status === 'success').length, 1);
        assert.equal([a.status, b.status].filter(status => status === 'conflict').length, 1);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('lock timeout reports busy and does not delete an unknown owner lock', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-settings-lock-busy-'));
    const filename = path.join(dir, 'settings.json');
    const manager = new SettingsManager(filename);
    const token = 'foreign-owner-lock';
    try {
        await fs.writeFile(filename, JSON.stringify(await manager.readSettings()));
        await fs.writeFile(`${filename}.lock`, token);
        await assert.rejects(() => manager.acquireLock(20), error => error?.code === 'SETTINGS_LOCK_BUSY');
        assert.equal(await fs.readFile(`${filename}.lock`, 'utf8'), token);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('settings manager emits an external update after a file edit', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-settings-watch-'));
    const filename = path.join(dir, 'settings.json');
    const manager = new SettingsManager(filename);
    try {
        await manager.writeSettings(await manager.readSettings());
        let resolveReceived;
        const received = new Promise(resolve => { resolveReceived = resolve; });
        manager.once('settings-external-updated', resolveReceived);
        manager.startExternalWatcher();
        const current = await manager.readSettings({ fresh: true });
        await fs.writeFile(filename, JSON.stringify({ ...current, userName: 'External' }));
        const payload = await Promise.race([received, new Promise(resolve => setTimeout(() => resolve(null), 2000))]);
        assert.equal(payload?.settings?.userName, 'External');
    } finally {
        manager.stopExternalWatcher();
        await fs.rm(dir, { recursive: true, force: true });
    }
});
