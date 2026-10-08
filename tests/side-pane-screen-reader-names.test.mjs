import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { mountGitView } from '../modules/ui-system/side-pane/git/git-view.js';
import { createSidePaneTabStrip } from '../modules/ui-system/side-pane/side-pane-tab-strip.js';

// Side pane icons are Material Symbols ligatures: the icon is literal text
// such as "expand_more". Unless it is aria-hidden, a screen reader reads
// that word as part of the control's name.

// The text a screen reader takes from an element's content: everything
// except aria-hidden subtrees.
function spokenText(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
}

test('Git rows and the refresh button do not read icon ligature names', async () => {
    const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true });
    const host = dom.window.document.getElementById('host');
    Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return this.isConnected ? this.parentNode : null; } });
    const api = {
        async gitListWorkspaces() { return { success: true, data: { workspaces: [{ id: 'w', alias: 'w', path: '/w' }], activeWorkspaceId: 'w' } }; },
        async gitStatus() { return { success: true, data: { isRepo: true, branch: { head: 'main' }, remotes: [], staged: [], changes: [{ path: 'src/app.js', status: 'M' }], conflicts: [] } }; },
        async gitDiff() { return { success: false, error: 'n/a' }; }
    };
    const handle = mountGitView(host, { api, uiHelper: null });
    await handle.ready;
    try {
        const row = host.querySelector('.side-git-row');
        assert.ok(row);
        assert.doesNotMatch(spokenText(row), /expand_more/);
        assert.match(spokenText(row), /app\.js/);
        const refreshName = spokenText(host.querySelector('.side-git-refresh-btn'));
        assert.ok(refreshName, 'the refresh button has a spoken name');
        assert.doesNotMatch(refreshName, /refresh|sync/);
    } finally {
        handle.dispose?.();
        dom.window.close();
    }
});

test('Shift+F10 on a side pane tab opens its menu next to the tab, not at the window corner', () => {
    const dom = new JSDOM('<div class="side-pane-tabs"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const tabList = doc.querySelector('.side-pane-tabs');
    const tabs = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
    const menus = [];
    const strip = createSidePaneTabStrip({
        tabListElement: tabList,
        getTabs: () => tabs,
        getActiveTabId: () => 'a',
        isClosable: () => true,
        onActivate() {},
        onClose() {},
        onReorder() {},
        onContextMenu: (tabId, x, y) => menus.push({ tabId, x, y })
    });
    try {
        strip.render();
        const item = tabList.querySelector('.side-pane-tab-item[data-tab-id="b"]');
        item.getBoundingClientRect = () => ({ left: 120, top: 10, right: 200, bottom: 40, width: 80, height: 30 });
        item.querySelector('[role="tab"]').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
        assert.deepEqual(menus, [{ tabId: 'b', x: 128, y: 44 }]);
        item.querySelector('[role="tab"]').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 150, clientY: 25 }));
        assert.deepEqual(menus[1], { tabId: 'b', x: 150, y: 25 }, 'a pointer right-click still opens at the pointer');
        assert.equal(spokenText(item.querySelector('.side-pane-tab-close')), '', 'the close button is named by its label alone');
    } finally {
        strip.dispose();
        dom.window.close();
    }
});
