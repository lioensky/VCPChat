import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { serializeLayout } from '../modules/ui-system/side-pane/side-pane-persistence.js';

function fixture({ pendingB = false, restored = false } = {}) {
    const dom = new JSDOM('<input id="mainInput"><aside><div class="side-pane-tabs"></div><div class="side-pane-content-container"></div></aside>');
    const doc = dom.window.document, root = doc.querySelector('aside');
    const entered = Promise.withResolvers(), authorization = Promise.withResolvers(), mountB = Promise.withResolvers();
    const disposed = [], closed = [], focused = [], requested = [];
    const tab = (id, version = 'original') => ({ id, kind: 'probe', title: id, payload: { version } });
    const storage = restored ? {
        getItem: () => JSON.stringify(serializeLayout({ tabs: [tab('a'), tab('b')], activeTabId: 'a', visible: false,
            activeByParent: new Map(), collapsedByParent: new Map() }, () => true)),
        setItem() {}
    } : null;
    const controller = createSidePaneController({ root, tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container'), persistence: storage ? { storage } : null,
        tabTypes: [{ kind: 'probe', label: 'Probe', onClosed(tab) { closed.push({ id: tab.id, title: tab.title }); },
            provider: { mountTab(tab, view) {
                const input = doc.createElement('input'); view.append(input);
                const handle = {
                    version: tab.payload?.version,
                    focus() { focused.push(tab.id); input.focus(); },
                    requestClose() {
                        requested.push(tab.id);
                        if (tab.id === 'a') { entered.resolve(); return authorization.promise; }
                        return { closed: true };
                    },
                    dispose() { disposed.push(`${tab.id}:${tab.payload?.version}`); }
                };
                return pendingB && tab.id === 'b' ? mountB.promise.then(() => handle) : handle;
            } }
        }]
    });
    return { controller, doc, entered, authorization, mountB, disposed, closed, focused, requested, tab,
        async cleanup() {
            authorization.resolve({ closed: true }); mountB.resolve();
            await controller.dispose(); dom.window.close();
        } };
}

for (const method of ['closeAllTabs', 'closeOtherTabs']) {
    test(`${method} cannot retire a later occurrence with an originally captured id`, async () => {
        const h = fixture(), ctrl = h.controller;
        try {
            if (method === 'closeOtherTabs') await ctrl.openTab(h.tab('keep'));
            await ctrl.openTab(h.tab('a')); await ctrl.openTab(h.tab('b'));
            const closing = ctrl[method]('keep'); await h.entered.promise;
            await ctrl.closeTab('b');
            const reopened = await ctrl.openTab(h.tab('b', 'new'));
            h.authorization.resolve({ closed: true }); await closing;
            assert.equal(ctrl.getTabHandle('b'), reopened);
            assert.ok(ctrl.getSnapshot().tabs.some(tab => tab.id === 'b'));
            assert.deepEqual(h.disposed, ['b:original', 'a:original']);
            assert.equal(ctrl.getSnapshot().activeTabId, 'b');
        } finally { await h.cleanup(); }
    });
}

test('metadata changes do not detach a captured lifetime from its batch', async () => {
    const h = fixture(), ctrl = h.controller;
    try {
        await ctrl.openTab(h.tab('a')); await ctrl.openTab(h.tab('b'));
        const closing = ctrl.closeAllTabs(); await h.entered.promise;
        ctrl.updateTab('b', { title: 'Updated while closing' });
        h.authorization.resolve({ closed: true }); await closing;
        assert.deepEqual(h.disposed, ['a:original', 'b:original']);
        assert.deepEqual(h.closed.find(tab => tab.id === 'b'), { id: 'b', title: 'Updated while closing' });
        assert.equal(ctrl.getTabHandle('b'), null);
    } finally { await h.cleanup(); }
});

test('a captured pending mount can finish before its turn and is still closed once', async () => {
    const h = fixture({ pendingB: true }), ctrl = h.controller;
    try {
        await ctrl.openTab(h.tab('a'));
        const openingB = ctrl.openTab(h.tab('b'));
        const closing = ctrl.closeAllTabs(); await h.entered.promise;
        h.mountB.resolve(); await openingB;
        h.authorization.resolve({ closed: true }); await closing;
        assert.deepEqual(h.disposed, ['a:original', 'b:original']);
        assert.equal(ctrl.getSnapshot().tabs.some(tab => tab.id === 'b'), false);
    } finally { await h.cleanup(); }
});

test('mounting a restored lazy tab does not turn it into a new batch lifetime', async () => {
    const h = fixture({ restored: true }), ctrl = h.controller;
    try {
        assert.equal(ctrl.restoreLayout(), true);
        assert.equal(ctrl.getTabHandle('b'), null);
        await ctrl.openTab(h.tab('a'));
        const closing = ctrl.closeAllTabs(); await h.entered.promise;
        await ctrl.openTab(h.tab('b'));
        h.authorization.resolve({ closed: true }); await closing;
        assert.deepEqual(h.disposed, ['a:original', 'b:original']);
        assert.equal(ctrl.getSnapshot().tabs.some(tab => tab.id === 'b'), false);
    } finally { await h.cleanup(); }
});

for (const laterAction of ['openTab', 'showNotifications', 'showLauncher', 'setVisible']) {
    test(`closeOtherTabs cannot override a later ${laterAction} intent`, async () => {
        const h = fixture(), ctrl = h.controller;
        try {
            await ctrl.openTab(h.tab('keep')); await ctrl.openTab(h.tab('a'));
            const closing = ctrl.closeOtherTabs('keep'); await h.entered.promise;
            if (laterAction === 'openTab') await ctrl.openTab(h.tab('new'));
            else if (laterAction === 'setVisible') ctrl.setVisible(false);
            else ctrl[laterAction]();
            const expected = ctrl.getSnapshot();
            const expectedFocusCalls = [...h.focused];
            h.authorization.resolve({ closed: true }); await closing;
            if (laterAction === 'setVisible') assert.deepEqual(h.focused, expectedFocusCalls, 'a collapsed pane must not receive late focus');
            else assert.equal(ctrl.getSnapshot().activeTabId, expected.activeTabId);
            assert.equal(ctrl.getSnapshot().visible, expected.visible);
        } finally { await h.cleanup(); }
    });
}

test('closeOtherTabs leaves focus in the main input after the user moves there', async () => {
    const h = fixture(), ctrl = h.controller;
    try {
        await ctrl.openTab(h.tab('keep')); await ctrl.openTab(h.tab('a'));
        const closing = ctrl.closeOtherTabs('keep'); await h.entered.promise;
        h.doc.getElementById('mainInput').focus();
        h.authorization.resolve({ closed: true }); await closing;
        assert.equal(h.doc.activeElement, h.doc.getElementById('mainInput'));
        assert.equal(ctrl.getSnapshot().activeTabId, 'keep');
    } finally { await h.cleanup(); }
});

for (const laterAction of ['activateTab', 'setParent']) {
    test(`closeOtherTabs respects a later ${laterAction} with surviving global pages`, async () => {
        const h = fixture(), ctrl = h.controller;
        try {
            await ctrl.openTab(h.tab('keep'));
            await ctrl.openTab({ ...h.tab('fixed'), closable: false });
            await ctrl.openTab(h.tab('a'));
            const closing = ctrl.closeOtherTabs('keep'); await h.entered.promise;
            if (laterAction === 'activateTab') ctrl.activateTab('fixed');
            else ctrl.setParent({ itemType: 'agent', itemId: 'agent', topicId: 'new-topic' });
            h.authorization.resolve({ closed: true }); await closing;
            assert.equal(ctrl.getSnapshot().activeTabId, 'fixed');
            if (laterAction === 'setParent') assert.equal(ctrl.getSnapshot().parent.topicId, 'new-topic');
        } finally { await h.cleanup(); }
    });
}

test('normal close-other completion selects the kept tab and respects a veto', async () => {
    const h = fixture(), ctrl = h.controller;
    try {
        await ctrl.openTab(h.tab('keep')); await ctrl.openTab(h.tab('a')); await ctrl.openTab(h.tab('b'));
        const closing = ctrl.closeOtherTabs('keep'); await h.entered.promise;
        ctrl.setParent(null); // Repeated host synchronization is not a new navigation intent.
        h.authorization.resolve({ closed: false }); await closing;
        assert.deepEqual(h.disposed, ['b:original']);
        assert.equal(ctrl.getSnapshot().activeTabId, 'keep');
        assert.ok(ctrl.getSnapshot().tabs.some(tab => tab.id === 'a'));
        assert.equal(h.focused.at(-1), 'keep', 'ordinary completion still focuses the kept page');
    } finally { await h.cleanup(); }
});

test('a tab made nonclosable while authorization waits keeps its view and resource', async () => {
    const h = fixture(), ctrl = h.controller;
    try {
        const handle = await ctrl.openTab(h.tab('a'));
        const closing = ctrl.closeTab('a'); await h.entered.promise;
        await ctrl.openTab({ ...h.tab('a'), closable: false });
        h.authorization.resolve({ closed: true }); await closing;
        assert.equal(ctrl.getTabHandle('a'), handle);
        assert.equal(h.doc.querySelector('[data-tab-id="a"].side-pane-view')?.isConnected, true);
        assert.deepEqual(h.disposed, []);
        assert.deepEqual(h.closed, []);
    } finally { await h.cleanup(); }
});

test('overlapping close-other intents share authorization and focus the kept page once', async () => {
    const h = fixture(), ctrl = h.controller;
    try {
        await ctrl.openTab(h.tab('keep')); await ctrl.openTab(h.tab('a'));
        const first = ctrl.closeOtherTabs('keep'); await h.entered.promise;
        const second = ctrl.closeOtherTabs('keep');
        h.authorization.resolve({ closed: true }); await Promise.all([first, second]);
        assert.deepEqual(h.requested, ['a']);
        assert.deepEqual(h.disposed, ['a:original']);
        assert.equal(h.focused.at(-1), 'keep');
        assert.equal(h.focused.filter(id => id === 'keep').length, 2, 'initial opening plus one completion focus');
    } finally { await h.cleanup(); }
});
