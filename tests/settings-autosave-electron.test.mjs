import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { claimSaveCoordinator } from '../modules/ui-system/settings/save-coordinator.js';
import { createMainChatSettingsOwner } from '../modules/renderer/mainChatSettingsOwner.js';

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

test('retryDraft clears coordinator conflict only after the owner rebases safely', async () => {
    const dom = new JSDOM('<form id="globalSettingsForm"></form>', { url: 'http://localhost/' });
    const form = dom.window.document.querySelector('form');
    const coordinator = claimSaveCoordinator(form);
    let flushed = 0;
    coordinator.registerClient({ id: 'typed', flush: async () => { flushed += 1; } });
    coordinator.reportState('conflict', { owner: 'typed' });
    form.dataset.vcpSettingsConflict = 'true';
    dom.window.addEventListener('settings-retry-draft', () => {
        // Simulate the typed owner proving that its patch has no overlap.
        delete form.dataset.vcpSettingsConflict;
        coordinator.reportState('dirty', { owner: 'typed', dirty: true });
    }, { once: true });
    const snapshot = await coordinator.retryDraft();
    assert.equal(flushed, 1);
    assert.equal(snapshot.status, 'dirty');
    await coordinator.dispose();
});

test('clearConflict keeps aggregate dirty state without allowing an owner to hide overlap', async () => {
    const dom = new JSDOM('<form id="globalSettingsForm"></form>', { url: 'http://localhost/' });
    const form = dom.window.document.querySelector('form');
    const coordinator = claimSaveCoordinator(form);
    coordinator.registerClient({ id: 'typed' });
    coordinator.reportState('conflict', { owner: 'typed' });
    assert.equal(coordinator.getSnapshot().status, 'conflict');
    form.dataset.vcpSettingsDirty = 'true';
    const cleared = coordinator.clearConflict();
    assert.equal(cleared.status, 'conflict', 'owner status remains authoritative while it still reports conflict');
    coordinator.reportState('dirty', { owner: 'typed', dirty: true });
    assert.equal(coordinator.getSnapshot().status, 'dirty');
    await coordinator.dispose();
});
test('mainChatSettingsOwner.merge safely hot-reloads committed patches and deep-merges nested objects without touching derived fields', async () => {
    const published = [];
    const settingsOwner = createMainChatSettingsOwner({
        initial: {
            enableContextCompaction: false,
            contextCompactionModel: '',
            userAvatarUrl: 'assets/runtime-avatar.png',
            appearanceProfile: { theme: 'dark', customRadius: 8 },
        },
        publish: snapshot => published.push(snapshot),
    });

    // 1. 模拟 Gen-1 持久化落盘了上下文压缩开关与模型，并带有 appearanceProfile 局部增量
    settingsOwner.merge({
        enableContextCompaction: true,
        contextCompactionModel: 'deepseek-chat',
        appearanceProfile: { sidebarRowHeight: 42 },
    });

    const afterEnable = settingsOwner.get();
    assert.equal(afterEnable.enableContextCompaction, true, '上下文压缩开关应即时热重载为 true');
    assert.equal(afterEnable.contextCompactionModel, 'deepseek-chat', '上下文压缩模型应即时更新');
    assert.equal(afterEnable.userAvatarUrl, 'assets/runtime-avatar.png', '未持久化的衍生头像字段应完好保留');
    assert.equal(afterEnable.appearanceProfile.customRadius, 8, '原有的外观圆角衍生配置应完好保留');
    assert.equal(afterEnable.appearanceProfile.sidebarRowHeight, 42, '新增的外观行高应正确合入');
    assert.equal(published.length, 1);

    // 2. 模拟热关闭上下文压缩开关
    settingsOwner.merge({ enableContextCompaction: false });
    assert.equal(settingsOwner.get().enableContextCompaction, false, '上下文压缩开关应即时热关闭为 false');
    assert.equal(settingsOwner.get().contextCompactionModel, 'deepseek-chat', '未触碰的同级字段应保持不变');
});
