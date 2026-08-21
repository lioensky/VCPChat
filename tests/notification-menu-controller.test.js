const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { NotificationMenuController } = require('../modules/ui-system/next-shell/notification-menu-controller.js');

function fixture() {
    const dom = new JSDOM(`<!doctype html><body>
      <button id="nextUiNotificationMenuBtn" aria-expanded="false"></button>
      <div id="nextUiNotificationMenu" role="menu" hidden>
        <button id="nextUiNotificationForum" role="menuitem"></button>
        <button id="nextUiNotificationMemo" role="menuitem"></button>
        <button id="nextUiNotificationFilterToggle" role="menuitemcheckbox" aria-checked="false"><span id="nextUiNotificationFilterState"></span></button>
        <button id="nextUiNotificationClear" role="menuitem"></button>
      </div>
    </body>`, { pretendToBeVisual: true, url: 'file:///notification.html' });
    return dom;
}

test('notification menu owns keyboard focus, commands and Escape cleanup', async () => {
    const dom = fixture();
    const calls = [];
    let enabled = false;
    const dispatcher = {
        register(entry) { this.entry = entry; return () => { this.entry = null; }; }
    };
    const controller = new NotificationMenuController({
        window: dom.window,
        document: dom.window.document,
        commands: () => ({
            openForum: () => calls.push('forum'),
            openMemo: () => calls.push('memo'),
            toggleNotificationFilter: () => { calls.push('toggle'); enabled = !enabled; },
            openNotificationFilterSettings: () => calls.push('filter-settings'),
            clearNotifications: () => calls.push('clear'),
        }),
        filterManager: { isFilterEnabled: () => enabled },
        escapeDispatcher: dispatcher,
    });
    assert.equal(controller.mount(), true);
    const trigger = dom.window.document.getElementById('nextUiNotificationMenuBtn');
    controller.open();
    assert.equal(dom.window.document.activeElement.id, 'nextUiNotificationForum');
    dom.window.document.getElementById('nextUiNotificationForum').click();
    await Promise.resolve();
    assert.deepEqual(calls, ['forum']);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    trigger.click();
    const filter = dom.window.document.getElementById('nextUiNotificationFilterToggle');
    filter.focus();
    filter.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
    await Promise.resolve();
    assert.equal(calls.at(-1), 'filter-settings', 'keyboard context-menu gesture must invoke filter settings safely');
    trigger.click();
    assert.equal(dispatcher.entry.close(), true);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    controller.dispose();
    dom.window.close();
});
