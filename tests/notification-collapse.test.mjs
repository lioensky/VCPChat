import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createDomListenerOwner } from '../modules/renderer/domListenerOwner.js';

function setup(t, settings = {}) {
    const dom = new JSDOM(`<div id="floating-toast-notifications-container"></div>
        <aside id="notificationsSidebar"></aside><ul id="notificationsList"></ul>
        <input type="checkbox" id="collapseFloatingNotifications">
        <input type="checkbox" id="collapsePanelNotifications">`, { runScripts: 'outside-only' });
    const win = dom.window;
    win.chatAPI = { sendVCPLogMessage() {} };
    win.CSS = { escape: String };
    win.eval(fs.readFileSync('modules/notificationRenderer.js', 'utf8'));
    const owner = createDomListenerOwner();
    win.notificationRenderer.configureCapabilities({
        filterManager: { getNotificationCollapseSettings: () => settings },
        listenerOwner: owner,
    });
    t.after(() => { owner.dispose(); win.close(); });
    const render = (data = { type: 'vcp_log', data: { tool_name: 'X', status: 'success', content: 'original body' } }) => {
        win.notificationRenderer.renderVCPLogNotification(data, null, win.document.getElementById('notificationsList'));
        return {
            item: win.document.querySelector('.notification-item'),
            toast: win.document.querySelector('.floating-toast-notification'),
        };
    };
    return { win, settings, render, owner };
}

for (const floating of [false, true]) for (const panel of [false, true]) {
    test(`independent surfaces floating=${floating} panel=${panel}`, t => {
        const { render } = setup(t, { collapseFloatingNotifications: floating, collapsePanelNotifications: panel });
        const { item, toast } = render();
        assert.equal(item.classList.contains('is-body-collapsed'), panel);
        assert.equal(toast.classList.contains('is-body-collapsed'), floating);
        assert.equal(item.querySelector('.notification-content').hidden, panel);
        assert.match(item.textContent, /original body/);
    });
}

test('missing settings keep legacy expanded presentation', t => {
    const { render } = setup(t);
    const { item, toast } = render();
    assert.equal(item.classList.contains('is-body-collapsed'), false);
    assert.equal(toast.classList.contains('is-body-collapsed'), false);
});

test('system messages and approval controls remain fully visible', t => {
    const { render } = setup(t, { collapseFloatingNotifications: true, collapsePanelNotifications: true });
    for (const data of [
        { type: 'connection_ack', message: 'connected' },
        { type: 'vcp_log', data: { source: 'DistPluginManager', content: 'started' } },
        { type: 'tool_approval_request', data: { requestId: 'r1', toolName: 'X', args: {}, timestamp: 'now' } },
    ]) {
        const { item, toast } = render(data);
        for (const card of [item, toast]) {
            assert.equal(card.classList.contains('is-body-collapsed'), false);
            assert.equal(card.querySelector('.notification-content').hidden, false);
        }
    }
});

test('right click expands only selected panel item; refresh preserves its override', t => {
    const { win, render, settings, owner } = setup(t, { collapseFloatingNotifications: true, collapsePanelNotifications: true });
    const first = render();
    const second = render();
    first.item.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    const menu = win.document.querySelector('.notification-collapse-menu');
    assert.equal(menu.textContent, '展开通知');
    menu.querySelector('button').click();
    assert.equal(first.item.querySelector('.notification-content').hidden, false);
    assert.equal(second.item.querySelector('.notification-content').hidden, true);
    assert.equal(first.toast.querySelector('.notification-content').hidden, true);
    settings.collapsePanelNotifications = false;
    win.notificationRenderer.refreshNotificationCollapse();
    assert.equal(second.item.querySelector('.notification-content').hidden, false);
    settings.collapsePanelNotifications = true;
    win.notificationRenderer.refreshNotificationCollapse();
    assert.equal(second.item.querySelector('.notification-content').hidden, true);
    assert.equal(first.item.querySelector('.notification-content').hidden, false);
    second.item.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    owner.dispose();
    assert.equal(win.document.querySelector('.notification-collapse-menu'), null);
});

test('settings save only one key, rebind once, roll back failures', async t => {
    const { win } = setup(t);
    win.eval(fs.readFileSync('modules/filterManager.js', 'utf8'));
    let current = { filterRules: [], unrelated: 123 };
    const patches = [];
    let success = true;
    const errors = [];
    win.filterManager.init({
        electronAPI: { saveSettings: async patch => { patches.push(patch); return { success, error: 'disk failed' }; } },
        uiHelper: { showToastNotification: text => errors.push(text) },
        refs: { globalSettingsRef: { get: () => current, set: value => { current = value; } } },
    });
    const ready = () => win.document.dispatchEvent(new win.CustomEvent('modal-ready', { detail: { modalId: 'filterRulesModal' } }));
    ready(); ready();
    const checkbox = win.document.getElementById('collapsePanelNotifications');
    checkbox.checked = true;
    checkbox.dispatchEvent(new win.Event('change'));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(patches.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(patches[0])), {
        __vcpSettingsOps: [{ op: 'set', path: ['collapsePanelNotifications'], value: true }],
    });
    assert.equal(current.collapsePanelNotifications, true);
    assert.equal(current.unrelated, 123);
    success = false;
    checkbox.checked = false;
    checkbox.dispatchEvent(new win.Event('change'));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(checkbox.checked, true);
    assert.equal(checkbox.disabled, false);
    assert.equal(current.collapsePanelNotifications, true);
    assert.match(errors[0], /disk failed/);
});