import test from 'node:test';
import assert from 'node:assert/strict';

import '../modules/ui-system/contribution-registry.js';
import { registerSidePaneCommands } from '../modules/renderer/sidePaneCommands.js';
import { NOTIFICATIONS_TAB_ID } from '../modules/ui-system/side-pane/side-pane-state.js';

function fakeController(snapshot = { visible: false, activeTabId: null }) {
    const calls = [];
    return {
        calls,
        snapshot,
        getSnapshot: () => snapshot,
        openTab: tab => { calls.push(['openTab', tab]); return tab; },
        setVisible: visible => calls.push(['setVisible', visible]),
        showNotifications: () => calls.push(['showNotifications'])
    };
}

function fakeWindow({ apps = [], shell = null } = {}) {
    const storage = new Map();
    const launched = [];
    return {
        storage,
        launched,
        localStorage: { setItem: (key, value) => storage.set(key, value), getItem: key => storage.get(key) ?? null },
        trayManager: { getApps: () => apps, launchApp: app => launched.push(app.action) },
        VCPNextShellController: shell
    };
}

function setup({ win = fakeWindow(), controller = fakeController(), chatAPI = {}, trajectory = [] } = {}) {
    const commands = new globalThis.VCPContributions.CommandRegistry();
    const registration = registerSidePaneCommands({
        win, chatAPI, controller, commands,
        openModelTrajectory: options => trajectory.push(options)
    });
    return { commands, registration, win, controller, trajectory };
}

test('side pane actions are registered as commands owned by the side pane', async () => {
    const { commands, registration } = setup();
    const ids = commands.list().map(entry => entry.id).sort();
    assert.deepEqual(ids, ['notifications.toggle', 'projectforge.open', 'sidepane.open-tab', 'sidepane.open-trajectory']);
    assert.ok(commands.list().every(entry => entry.ownerId === 'side-pane'));

    await registration.dispose();
    assert.deepEqual(commands.list(), []);
});

test('open-tab and open-trajectory forward to the side pane', () => {
    const { commands, controller, trajectory } = setup();
    const tab = { id: 'code-viewer:x', kind: 'code-viewer' };
    assert.equal(commands.execute('sidepane.open-tab', tab), tab);
    assert.deepEqual(controller.calls, [['openTab', tab]]);
    commands.execute('sidepane.open-trajectory', { requestId: 'm1' });
    assert.deepEqual(trajectory, [{ requestId: 'm1' }]);
});

test('notifications.toggle opens the notifications, or closes the pane when they are already showing', () => {
    const controller = fakeController({ visible: false, activeTabId: 'chat-1' });
    const { commands } = setup({ controller });
    commands.execute('notifications.toggle');
    controller.snapshot.visible = true;
    commands.execute('notifications.toggle');
    controller.snapshot.activeTabId = NOTIFICATIONS_TAB_ID;
    commands.execute('notifications.toggle');
    assert.deepEqual(controller.calls, [['showNotifications'], ['showNotifications'], ['setVisible', false]]);
});

test('projectforge.open remembers the project to focus and opens the app the way the launcher does', () => {
    const app = { action: 'open-project-forge-window', embed: true };
    const embedded = [];
    const win = fakeWindow({ apps: [app], shell: { openEmbeddedApp: target => embedded.push(target) } });
    const { commands } = setup({ win });
    commands.execute('projectforge.open', { projectId: 'p1' });
    assert.deepEqual(embedded, [app]);
    assert.equal(JSON.parse(win.storage.get('vcp-projectforge-focus')).id, 'p1');

    // 不能嵌入：独立窗口
    const standalone = fakeWindow({ apps: [{ action: 'open-project-forge-window', embed: false }] });
    setup({ win: standalone }).commands.execute('projectforge.open');
    assert.deepEqual(standalone.launched, ['open-project-forge-window']);
    assert.equal(standalone.storage.has('vcp-projectforge-focus'), false, '没带工程就不写定位');

    // 应用列表里没有：直接让主进程开
    const opened = [];
    setup({ win: fakeWindow(), chatAPI: { desktopCreateEmbeddedVchatApp: action => opened.push(action) } })
        .commands.execute('projectforge.open', { projectId: 'p2' });
    assert.deepEqual(opened, ['open-project-forge-window']);
});

test('a command id that is already taken is left alone instead of failing the side pane', async () => {
    const commands = new globalThis.VCPContributions.CommandRegistry();
    const existing = () => 'existing';
    commands.register({ id: 'sidepane.open-tab', title: 'existing', handler: existing });
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = message => warnings.push(message);
    try {
        const registration = registerSidePaneCommands({ win: fakeWindow(), controller: fakeController(), commands, openModelTrajectory() {} });
        assert.equal(commands.execute('sidepane.open-tab'), 'existing');
        assert.equal(warnings.length, 1);
        await registration.dispose();
        assert.equal(commands.get('sidepane.open-tab').handler, existing, '卸载侧栏不注销别人的命令');
    } finally {
        console.warn = originalWarn;
    }
});
