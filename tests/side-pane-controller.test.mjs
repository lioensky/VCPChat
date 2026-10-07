import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { defineChatTabType } from '../modules/ui-system/side-pane/tab-types/chat.js';

test('SidePaneController initializes and renders tabs into tabListElement', () => {
    const dom = new JSDOM(`
        <div class="main-content"></div>
        <div class="resizer" id="resizerRight"></div>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar">
                <div class="side-pane-tabs"></div>
            </header>
            <div class="side-pane-content-container">
                <section class="side-pane-view active" id="sidePaneViewNotifications"></section>
            </div>
        </aside>
    `);

    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const tabListElement = root.querySelector('.side-pane-tabs');
    const contentContainer = root.querySelector('.side-pane-content-container');
    const resizerHandle = doc.getElementById('resizerRight');

    const controller = createSidePaneController({
        root,
        resizerHandle,
        tabListElement,
        contentContainer,
    });

    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.visible, false);
    assert.equal(snapshot.activeTabId, 'notifications');
    assert.equal(tabListElement.children.length, 1);
    assert.equal(tabListElement.children[0].getAttribute('data-tab-id'), 'notifications');

    controller.dispose();
});

test('SidePaneController showNotifications and openChat mount views and sync visibility', async () => {
    const dom = new JSDOM(`
        <div class="main-content"></div>
        <div class="resizer" id="resizerRight"></div>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar">
                <div class="side-pane-tabs"></div>
            </header>
            <div class="side-pane-content-container">
                <section class="side-pane-view active" id="sidePaneViewNotifications"></section>
            </div>
        </aside>
    `);

    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const tabListElement = root.querySelector('.side-pane-tabs');
    const contentContainer = root.querySelector('.side-pane-content-container');
    const resizerHandle = doc.getElementById('resizerRight');

    let mountedDescriptor = null;
    let focused = false;
    let disposed = false;

    const mockChatProvider = {
        async mountTab(descriptor, viewElement) {
            mountedDescriptor = descriptor;
            viewElement.innerHTML = '<div class="chat-surface">Chat Ready</div>';
            return {
                focus() { focused = true; },
                async requestClose() { return { closed: true }; },
                async dispose() { disposed = true; },
            };
        },
    };

    const controller = createSidePaneController({
        root,
        resizerHandle,
        tabListElement,
        contentContainer,
        tabTypes: [defineChatTabType({ provider: mockChatProvider })],
    });

    controller.showNotifications();
    assert.equal(controller.getSnapshot().visible, true);
    assert.equal(root.classList.contains('active'), true);

    const desc = {
        id: 'side-chat-test',
        parent: { itemType: 'agent', itemId: 'agent-1', topicId: 'p-1' },
        child: { itemType: 'agent', itemId: 'agent-1', topicId: 'c-1' },
        title: '测试侧聊',
    };

    controller.setParent(desc.parent);
    await controller.openTab({ kind: 'chat', descriptor: desc });
    assert.equal(controller.getSnapshot().activeTabId, 'side-chat-test');
    assert.equal(tabListElement.children.length, 2);
    assert.ok(mountedDescriptor);
    assert.equal(focused, true);

    // View for chat is active, notifications view is inactive
    const notifView = doc.getElementById('sidePaneViewNotifications');
    const chatView = contentContainer.querySelector('[data-tab-id="side-chat-test"]');
    assert.equal(notifView.classList.contains('active'), false);
    assert.equal(chatView.classList.contains('active'), true);

    // Close tab
    await controller.closeTab('side-chat-test');
    assert.equal(disposed, true);
    assert.equal(controller.getSnapshot().activeTabId, 'notifications');
    assert.equal(controller.getSnapshot().visible, false, '最后一个可关的标签关掉后面板收起');
    assert.equal(tabListElement.children.length, 1);
    assert.equal(notifView.classList.contains('active'), true);
    assert.equal(contentContainer.querySelector('[data-tab-id="side-chat-test"]'), null);

    controller.dispose();
});

function createPaneDom() {
    const dom = new JSDOM(`
        <div class="main-content"></div>
        <div class="resizer" id="resizerRight"></div>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar"><div class="side-pane-tabs"></div></header>
            <div class="side-pane-content-container"></div>
        </aside>
    `);
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    return {
        dom,
        root,
        options: {
            root,
            resizerHandle: doc.getElementById('resizerRight'),
            tabListElement: root.querySelector('.side-pane-tabs'),
            contentContainer: root.querySelector('.side-pane-content-container')
        }
    };
}

test('SidePaneController mounts a tab once when it is opened twice concurrently', async () => {
    const { dom, root, options } = createPaneDom();
    let mounts = 0;
    let disposes = 0;
    const controller = createSidePaneController({
        ...options,
        providers: {
            git: {
                async mountTab() {
                    mounts++;
                    await new Promise(resolve => setTimeout(resolve, 10));
                    return { dispose() { disposes++; } };
                }
            }
        }
    });
    const tab = { id: 'git', kind: 'git', title: 'Git', closable: true, scopeMode: 'global' };

    const [first, second] = await Promise.all([controller.openTab(tab), controller.openTab(tab)]);
    assert.equal(mounts, 1);
    assert.equal(first, second);
    assert.equal(root.querySelectorAll('.side-pane-view[data-tab-id="git"]').length, 1);

    await controller.closeTab('git');
    assert.equal(disposes, 1);

    await controller.dispose();
    dom.window.close();
});

test('closing and reopening a pending tab creates a fresh mount even with the same id', async () => {
    const { dom, root, options } = createPaneDom();
    const mounts = [];
    const disposed = [];
    const controller = createSidePaneController({ ...options, providers: {
        probe: { mountTab(tab, view) {
            const pending = Promise.withResolvers();
            view.textContent = tab.payload.version;
            mounts.push({ version: tab.payload.version, view, ...pending });
            return pending.promise;
        } }
    } });
    const tab = { id: 'probe', kind: 'probe', title: 'Probe', closable: true, scopeMode: 'global' };
    const first = controller.openTab({ ...tab, payload: { version: 'old' } });
    try {
        await controller.closeTab(tab.id);
        const reopened = controller.openTab({ ...tab, payload: { version: 'new' } });
        assert.equal(mounts.length, 2);
        mounts[0].resolve({ dispose() { disposed.push('old'); } });
        assert.equal(await first, null);
        assert.deepEqual(disposed, ['old']);
        const concurrent = controller.openTab({ ...tab, payload: { version: 'new' } });
        assert.equal(mounts.length, 2, 'retiring the old occurrence must not remove the new pending mount');
        const newest = { dispose() { disposed.push('new'); } };
        mounts[1].resolve(newest);
        assert.equal(await reopened, newest);
        assert.equal(await concurrent, newest);
        assert.equal(controller.getTabHandle(tab.id), newest);
        assert.equal(root.querySelectorAll('[data-tab-id="probe"].side-pane-view').length, 1);
        assert.equal(root.querySelector('[data-tab-id="probe"].side-pane-view').textContent, 'new');
        await controller.closeTab(tab.id);
        assert.deepEqual(disposed, ['old', 'new']);
    } finally {
        mounts.forEach(mount => mount.resolve({ dispose() {} }));
        await first;
        await controller.dispose();
        dom.window.close();
    }
});

test('opening a background conversation mounts its own tab without replacing the foreground handle', async () => {
    const { dom, root, options } = createPaneDom();
    const mounted = [];
    const focused = [];
    const handles = new Map();
    const controller = createSidePaneController({ ...options, providers: {
        probe: { async mountTab(tab, view) {
            mounted.push(tab.id);
            view.textContent = tab.title;
            const handle = { focus() { focused.push(tab.id); }, dispose() {} };
            handles.set(tab.id, handle);
            return handle;
        } }
    } });
    const a = { itemType: 'agent', itemId: 'nova', topicId: 'a' };
    const b = { ...a, topicId: 'b' };
    const tab = { kind: 'probe', closable: true, scopeMode: 'topic' };
    try {
        controller.setParent(a);
        const foreground = await controller.openTab({ ...tab, id: 'a', title: 'A', parent: a });
        const background = await controller.openTab({ ...tab, id: 'b', title: 'B', parent: b });
        assert.deepEqual(mounted, ['a', 'b']);
        assert.equal(background, handles.get('b'));
        assert.notEqual(background, foreground);
        assert.equal(controller.getTabHandle('a'), foreground);
        assert.equal(controller.getSnapshot().activeTabId, 'a');
        assert.deepEqual(focused, ['a']);
        controller.activateTab('b');
        assert.equal(controller.getSnapshot().activeTabId, 'a', 'a hidden conversation tab cannot be activated');
        assert.equal(root.querySelector('.side-pane-view[data-tab-id="a"]').classList.contains('active'), true);
        assert.equal(root.querySelector('.side-pane-view[data-tab-id="b"]').classList.contains('active'), false);
        controller.setParent(b);
        assert.equal(controller.getSnapshot().activeTabId, 'b');
        assert.equal(root.querySelector('.side-pane-view[data-tab-id="b"]').classList.contains('active'), true);
        assert.deepEqual(mounted, ['a', 'b'], 'switching to the owning conversation reuses its handle');
    } finally {
        await controller.dispose();
        dom.window.close();
    }
});

for (const action of ['select another tab', 'hide the pane', 'focus the main input', 'switch conversation']) {
    test(`a late open does not steal focus after ${action}`, async () => {
        const { dom, root, options } = createPaneDom();
        const doc = dom.window.document;
        const input = doc.createElement('input');
        doc.body.append(input);
        const pending = Promise.withResolvers();
        let focused = 0;
        const handle = { focus() { focused++; }, dispose() {} };
        const controller = createSidePaneController({ ...options, providers: {
            probe: { mountTab(tab, view) { view.textContent = tab.title; return pending.promise; } }
        } });
        const parent = { itemType: 'agent', itemId: 'nova', topicId: 'a' };
        controller.setParent(parent);
        const opened = controller.openTab({ id: 'slow', kind: 'probe', title: 'Slow', scopeMode: 'topic', parent });
        try {
            if (action === 'select another tab') controller.showNotifications();
            else if (action === 'hide the pane') controller.setVisible(false);
            else if (action === 'focus the main input') input.focus();
            else controller.setParent({ ...parent, topicId: 'b' });
            const before = controller.getSnapshot();
            pending.resolve(handle);
            assert.equal(await opened, handle, 'the caller still receives its own mounted handle');
            assert.equal(focused, 0);
            assert.equal(controller.getSnapshot().activeTabId, before.activeTabId);
            assert.equal(controller.getSnapshot().visible, before.visible);
            if (action === 'focus the main input') assert.equal(doc.activeElement, input);
            if (action === 'hide the pane') assert.equal(root.classList.contains('active'), false);
            else if (action !== 'focus the main input') assert.equal(root.querySelector('.side-pane-view[data-tab-id="slow"]').classList.contains('active'), false);
        } finally {
            pending.resolve(handle);
            await opened;
            await controller.dispose();
            dom.window.close();
        }
    });
}

test('a failed mount shows an error with a retry instead of a blank pane', async () => {
    const { dom, root, options } = createPaneDom();
    let attempts = 0;
    const controller = createSidePaneController({
        ...options,
        providers: {
            flaky: {
                async mountTab(tab, view) {
                    attempts++;
                    view.textContent = 'half drawn';
                    if (attempts === 1) throw new Error('mount failed');
                    view.textContent = 'ready';
                    return { focus() {}, dispose() {} };
                }
            }
        }
    });
    const originalError = console.error;
    console.error = () => {};
    try {
        await assert.rejects(controller.openTab({ id: 'flaky', kind: 'flaky', title: 'Flaky', closable: true, scopeMode: 'global' }), /mount failed/);
        const views = root.querySelectorAll('.side-pane-view[data-tab-id="flaky"]');
        assert.equal(views.length, 1);
        assert.equal(views[0].hidden, false, 'the failed tab stays the visible one');
        assert.equal(views[0].querySelector('[role="alert"]').textContent.includes('mount failed'), true);
        assert.equal(views[0].textContent.includes('half drawn'), false, 'what the provider half drew is cleared');
        assert.equal(root.ownerDocument.activeElement, views[0].querySelector('.side-pane-mount-error-retry'),
            'focus lands on the retry button like it would on a tab that opened');

        views[0].querySelector('.side-pane-mount-error-retry').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(attempts, 2);
        const mounted = root.querySelectorAll('.side-pane-view[data-tab-id="flaky"]');
        assert.equal(mounted.length, 1);
        assert.equal(mounted[0].textContent, 'ready');
        assert.equal(mounted[0].hidden, false);
        assert.ok(controller.getTabHandle('flaky'));
    } finally {
        console.error = originalError;
    }

    await controller.dispose();
    dom.window.close();
});

test('closing a tab whose mount failed removes its error view', async () => {
    const { dom, root, options } = createPaneDom();
    const controller = createSidePaneController({
        ...options,
        providers: { broken: { async mountTab() { throw new Error('mount failed'); } } }
    });
    const originalError = console.error;
    console.error = () => {};
    try {
        await controller.openTab({ id: 'broken', kind: 'broken', title: 'Broken', closable: true, scopeMode: 'global' }).catch(() => {});
        assert.ok(root.querySelector('.side-pane-view[data-tab-id="broken"]'));
        await controller.closeTab('broken');
        assert.equal(root.querySelector('.side-pane-view[data-tab-id="broken"]'), null);
    } finally {
        console.error = originalError;
    }
    await controller.dispose();
    dom.window.close();
});

test('SidePaneController still closes a tab whose dispose throws', async () => {
    const { dom, root, options } = createPaneDom();
    const controller = createSidePaneController({
        ...options,
        providers: {
            broken: {
                async mountTab() {
                    return { dispose() { throw new Error('dispose failed'); } };
                }
            }
        }
    });
    const originalError = console.error;
    console.error = () => {};
    try {
        await controller.openTab({ id: 'broken', kind: 'broken', title: 'Broken', closable: true, scopeMode: 'global' });
        await controller.closeTab('broken');
    } finally {
        console.error = originalError;
    }

    assert.equal(controller.getSnapshot().tabs.some(tab => tab.id === 'broken'), false);
    assert.equal(root.querySelector('.side-pane-view[data-tab-id="broken"]'), null);

    await controller.dispose();
    dom.window.close();
});

for (const admitted of [true, false]) {
    test(`concurrent closes share authorization and cleanup, including refusal=${!admitted}`, async () => {
        const { dom, options } = createPaneDom();
        const barrier = Promise.withResolvers();
        let requests = 0, disposes = 0, closed = 0;
        const controller = createSidePaneController({ ...options, tabTypes: [{
            kind: 'probe', label: 'Probe', onClosed() { closed++; },
            provider: { mountTab() { return {
                requestClose() { requests++; return requests === 1 ? barrier.promise : { closed: true }; },
                dispose() { disposes++; }
            }; } }
        }] });
        try {
            await controller.openTab({ id: 'probe', kind: 'probe' });
            const first = controller.closeTab('probe');
            const second = controller.closeTab('probe');
            assert.equal(requests, 1);
            barrier.resolve({ closed: admitted });
            await Promise.all([first, second]);
            assert.equal(disposes, admitted ? 1 : 0);
            assert.equal(closed, admitted ? 1 : 0);
            assert.equal(controller.getSnapshot().tabs.some(tab => tab.id === 'probe'), !admitted);
            if (!admitted) {
                await controller.closeTab('probe');
                assert.equal(requests, 2, 'refusal releases the operation so a later close can retry');
                assert.equal(disposes, 1);
                assert.equal(closed, 1);
            }
        } finally {
            barrier.resolve({ closed: true });
            await controller.dispose();
            dom.window.close();
        }
    });
}

test('reopening during the old onClosed hook retains the new tab and handle', async () => {
    const { dom, root, options } = createPaneDom();
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const closed = [], disposed = [];
    const controller = createSidePaneController({ ...options, tabTypes: [{
        kind: 'probe', label: 'Probe',
        async onClosed(tab) { closed.push(tab.payload.version); entered.resolve(); await release.promise; },
        provider: { mountTab(tab, view) {
            view.textContent = tab.payload.version;
            return { version: tab.payload.version, dispose() { disposed.push(tab.payload.version); } };
        } }
    }] });
    const tab = { id: 'probe', kind: 'probe', scopeMode: 'global' };
    try {
        await controller.openTab({ ...tab, payload: { version: 'old' } });
        const closing = controller.closeTab('probe');
        await entered.promise;
        const newest = await controller.openTab({ ...tab, payload: { version: 'new' } });
        release.resolve();
        await closing;
        assert.equal(newest.version, 'new');
        assert.equal(controller.getTabHandle('probe'), newest);
        assert.equal(controller.getSnapshot().tabs.find(tab => tab.id === 'probe')?.payload.version, 'new');
        assert.equal(root.querySelector('.side-pane-view[data-tab-id="probe"]').textContent, 'new');
        assert.deepEqual(closed, ['old']);
        assert.deepEqual(disposed, ['old']);
        await controller.closeTab('probe');
        assert.deepEqual(closed, ['old', 'new']);
        assert.deepEqual(disposed, ['old', 'new']);
    } finally {
        release.resolve();
        await controller.dispose();
        dom.window.close();
    }
});

test('controller disposal during close authorization releases the handle only once and skips onClosed', async () => {
    const { dom, options } = createPaneDom();
    const barrier = Promise.withResolvers();
    let disposes = 0, closed = 0;
    const controller = createSidePaneController({ ...options, tabTypes: [{
        kind: 'probe', label: 'Probe', onClosed() { closed++; },
        provider: { mountTab() { return {
            requestClose: () => barrier.promise, dispose() { disposes++; }
        }; } }
    }] });
    try {
        await controller.openTab({ id: 'probe', kind: 'probe' });
        const closing = controller.closeTab('probe');
        await controller.dispose();
        assert.equal(disposes, 1);
        barrier.resolve({ closed: true });
        await closing;
        assert.equal(disposes, 1);
        assert.equal(closed, 0, 'shutdown alone does not delete the business resource');
    } finally {
        barrier.resolve({ closed: true });
        await controller.dispose();
        dom.window.close();
    }
});

test('a nonclosable tab cannot run provider disposal or business cleanup', async () => {
    const { dom, options } = createPaneDom();
    let disposes = 0, closed = 0;
    const controller = createSidePaneController({ ...options, tabTypes: [{
        kind: 'probe', label: 'Probe', onClosed() { closed++; },
        provider: { mountTab() { return { dispose() { disposes++; } }; } }
    }] });
    try {
        const handle = await controller.openTab({ id: 'fixed', kind: 'probe', closable: false });
        await controller.closeTab('fixed');
        assert.equal(disposes, 0);
        assert.equal(closed, 0);
        assert.equal(controller.getTabHandle('fixed'), handle);
        assert.ok(controller.getSnapshot().tabs.some(tab => tab.id === 'fixed'));
    } finally {
        await controller.dispose();
        dom.window.close();
    }
});

test('mounted tabs retain their cleanup definition through replacement and unregistration', async () => {
    const { dom, options } = createPaneDom();
    const closed = [], disposed = [];
    const controller = createSidePaneController(options);
    const definition = version => ({
        kind: 'probe', label: version,
        onClosed(tab) { closed.push(`${version}:${tab.id}`); },
        provider: { mountTab(tab) { return { version, dispose() { disposed.push(`${version}:${tab.id}`); } }; } }
    });
    try {
        controller.registerTabType(definition('old'));
        const oldHandle = await controller.openTab({ id: 'old', kind: 'probe' });
        const unregister = controller.registerTabType(definition('new'));
        const newHandle = await controller.openTab({ id: 'new', kind: 'probe' });
        assert.equal(oldHandle.version, 'old');
        assert.equal(newHandle.version, 'new');
        await controller.closeTab('old');
        assert.deepEqual(closed, ['old:old']);
        unregister();
        await controller.closeTab('new');
        assert.deepEqual(closed, ['old:old', 'new:new']);
        assert.deepEqual(disposed, ['old:old', 'new:new']);
    } finally {
        await controller.dispose();
        dom.window.close();
    }
});

test('a canceled pending mount keeps its original business cleanup after type replacement', async () => {
    const { dom, options } = createPaneDom();
    const mounting = Promise.withResolvers();
    const closed = [];
    let disposes = 0;
    const controller = createSidePaneController(options);
    try {
        controller.registerTabType({ kind: 'probe', label: 'Old', onClosed() { closed.push('old'); },
            provider: { mountTab() { return mounting.promise; } } });
        const opening = controller.openTab({ id: 'pending', kind: 'probe' });
        controller.registerTabType({ kind: 'probe', label: 'New', onClosed() { closed.push('new'); } });
        await controller.closeTab('pending');
        mounting.resolve({ dispose() { disposes++; } });
        assert.equal(await opening, null);
        assert.deepEqual(closed, ['old']);
        assert.equal(disposes, 1);
        assert.equal(controller.getSnapshot().tabs.some(tab => tab.id === 'pending'), false);
    } finally {
        mounting.resolve(null);
        await controller.dispose();
        dom.window.close();
    }
});
