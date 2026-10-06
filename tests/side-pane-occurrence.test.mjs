import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { createSidePaneRootScope, createTabOccurrence, pollWhileVisible } from '../modules/ui-system/side-pane/side-pane-occurrence.js';
import { createLazyProvider } from '../modules/ui-system/side-pane/tab-types/lazy-provider.js';

const { diagnostics } = globalThis.VCPLifecycle;

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
        doc,
        root,
        options: {
            root,
            resizerHandle: doc.getElementById('resizerRight'),
            tabListElement: root.querySelector('.side-pane-tabs'),
            contentContainer: root.querySelector('.side-pane-content-container')
        }
    };
}

const tabOf = (id, kind = 'probe') => ({ id, kind, title: id, closable: true, scopeMode: 'global' });

// 记录每次挂载拿到的 scope / occurrence，资源全部挂在 scope 上，不提供 dispose
function createScopedProvider(target) {
    return {
        mountTab(payload, view, context) {
            const record = { payload, view, ...context, visibleLog: [], suspends: 0, resumes: 0, listenerCalls: 0 };
            target.push(record);
            context.scope.listen(view.ownerDocument, 'probe', () => { record.listenerCalls++; });
            context.scope.subscribe(() => context.occurrence.visible.subscribe(value => record.visibleLog.push(value)), 'probe-visible');
            return {
                suspend() { record.suspends++; },
                resume() { record.resumes++; }
            };
        }
    };
}

test('a tab gets an occurrence scope and a view scope, both released when it closes', async () => {
    const { dom, doc, options } = createPaneDom();
    const baseline = diagnostics.summary().activeScopes;
    const mounts = [];
    const controller = createSidePaneController({ ...options, providers: { probe: createScopedProvider(mounts) } });
    await controller.openTab(tabOf('probe:1'));
    controller.setVisible(true);

    const [mount] = mounts;
    assert.equal(mount.scope.active, true);
    assert.equal(mount.scope.parent.label, 'tab:probe:1');
    assert.equal(mount.occurrence.id, 'probe:1');
    assert.equal(mount.occurrence.signal.aborted, false);
    doc.dispatchEvent(new dom.window.Event('probe'));
    assert.equal(mount.listenerCalls, 1);

    await controller.closeTab('probe:1');
    assert.equal(mount.scope.disposed, true);
    assert.equal(mount.scope.parent.disposed, true);
    assert.equal(mount.occurrence.signal.aborted, true);
    doc.dispatchEvent(new dom.window.Event('probe'));
    assert.equal(mount.listenerCalls, 1, 'listeners registered on the view scope are gone after close');

    await controller.dispose();
    assert.equal(diagnostics.summary().activeScopes, baseline);
    dom.window.close();
});

test('visibility is published by the container and drives suspend/resume', async () => {
    const { dom, doc, options } = createPaneDom();
    const mounts = [];
    const controller = createSidePaneController({ ...options, providers: { probe: createScopedProvider(mounts) } });
    controller.setVisible(true);
    await controller.openTab(tabOf('probe:a'));
    const [a] = mounts;
    assert.equal(a.occurrence.isVisible(), true);

    await controller.openTab(tabOf('probe:b'));
    const b = mounts[1];
    assert.equal(a.occurrence.isVisible(), false, 'switching tabs hides the previous one');
    assert.equal(b.occurrence.isVisible(), true);
    assert.equal(a.suspends, 1);

    controller.setVisible(false);
    assert.equal(b.occurrence.isVisible(), false, 'collapsing the pane hides the active tab');
    assert.equal(b.suspends, 1);

    controller.setVisible(true);
    assert.equal(b.occurrence.isVisible(), true);
    assert.equal(b.resumes, 1);

    Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
    doc.dispatchEvent(new dom.window.Event('visibilitychange'));
    assert.equal(b.occurrence.isVisible(), false, 'a hidden window counts as not visible');
    Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'visible' });
    doc.dispatchEvent(new dom.window.Event('visibilitychange'));
    assert.equal(b.occurrence.isVisible(), true);

    controller.activateTab('probe:a');
    assert.equal(a.resumes, 1);
    assert.deepEqual(a.visibleLog, [true, false, true]);

    await controller.dispose();
    dom.window.close();
});

test('closing a tab while it is still mounting aborts its signal and releases the view scope', async () => {
    const { dom, options } = createPaneDom();
    let release;
    let context = null;
    const controller = createSidePaneController({
        ...options,
        providers: {
            probe: {
                async mountTab(_payload, _view, ctx) {
                    context = ctx;
                    await new Promise(resolve => { release = resolve; });
                    return { dispose() {} };
                }
            }
        }
    });
    const opening = controller.openTab(tabOf('probe:slow'));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(context);
    await controller.closeTab('probe:slow');
    assert.equal(context.occurrence.signal.aborted, true);
    release();
    assert.equal(await opening, null);
    assert.equal(context.scope.disposed, true);
    await controller.dispose();
    dom.window.close();
});

test('two-argument providers keep working and still have their occurrence released', async () => {
    const { dom, options } = createPaneDom();
    const baseline = diagnostics.summary().activeScopes;
    let disposed = 0;
    const controller = createSidePaneController({
        ...options,
        providers: { legacy: { mountTab(_payload, view) { view.textContent = 'legacy'; return { dispose() { disposed++; } }; } } }
    });
    for (let i = 0; i < 20; i++) {
        await controller.openTab(tabOf(`legacy:${i}`, 'legacy'));
        await controller.closeTab(`legacy:${i}`);
    }
    assert.equal(disposed, 20);
    await controller.dispose();
    assert.equal(diagnostics.summary().activeScopes, baseline);
    dom.window.close();
});

test('provider dispose failures do not leak the tab scope', async () => {
    const { dom, options } = createPaneDom();
    const mounts = [];
    const scoped = createScopedProvider(mounts);
    const controller = createSidePaneController({
        ...options,
        providers: { probe: { mountTab: (...args) => ({ ...scoped.mountTab(...args), dispose() { throw new Error('boom'); } }) } }
    });
    const originalError = console.error;
    console.error = () => {};
    try {
        await controller.openTab(tabOf('probe:x'));
        await controller.closeTab('probe:x');
    } finally {
        console.error = originalError;
    }
    assert.equal(mounts[0].scope.disposed, true);
    await controller.dispose();
    dom.window.close();
});

test('pollWhileVisible runs no timers while hidden and catches up when shown again', async () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
    const root = createSidePaneRootScope();
    try {
        const tab = createTabOccurrence(root, { tabId: 't', kind: 'k' });
        const view = tab.openView();
        let calls = 0;
        pollWhileVisible(view, tab.occurrence.visible, () => { calls++; }, 1000);

        mock.timers.tick(10 * 60_000);
        assert.equal(calls, 0, 'never visible, never polled');
        assert.equal(view.snapshot().resources.some(r => r.type === 'child-scope'), false);

        tab.setVisible(true);
        assert.equal(calls, 1, 'first show after a long hidden period catches up once');
        mock.timers.tick(3000);
        assert.equal(calls, 4);

        tab.setVisible(false);
        mock.timers.tick(10 * 60_000);
        assert.equal(calls, 4, 'hidden: no polling');

        tab.setVisible(true);
        assert.equal(calls, 5);
        mock.timers.tick(500);
        tab.setVisible(false);
        tab.setVisible(true);
        assert.equal(calls, 5, 'a quick hide/show inside one interval does not refetch');

        await tab.closeView();
        mock.timers.tick(10_000);
        assert.equal(calls, 5, 'releasing the view scope stops the poll');
    } finally {
        await root.dispose();
        mock.timers.reset();
    }
});

test('pollWhileVisible does not stack slow async ticks', async () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
    const root = createSidePaneRootScope();
    try {
        const tab = createTabOccurrence(root, { tabId: 't' });
        const view = tab.openView();
        let started = 0;
        let finish;
        pollWhileVisible(view, tab.occurrence.visible, () => {
            started++;
            return new Promise(resolve => { finish = resolve; });
        }, 100, { leading: true });
        tab.setVisible(true);
        mock.timers.tick(1000);
        assert.equal(started, 1);
        finish();
        await new Promise(resolve => setImmediate(resolve));
        mock.timers.tick(100);
        assert.equal(started, 2);
    } finally {
        await root.dispose();
        mock.timers.reset();
    }
});

test('lazy providers load once on first use and retry after a failed load', async () => {
    let loads = 0;
    let fail = true;
    const provider = createLazyProvider(async () => {
        loads++;
        if (fail) throw new Error('offline');
        return { mountTab: () => ({ mounted: true }), openThing: async value => `opened:${value}` };
    }, ['openThing']);
    assert.equal(provider.isLoaded(), false);
    await assert.rejects(provider.openThing('a'), /offline/);
    fail = false;
    assert.equal(await provider.openThing('b'), 'opened:b');
    assert.deepEqual(await provider.mountTab(), { mounted: true });
    assert.equal(loads, 2);
    assert.equal(provider.isLoaded(), true);
});

test('tab types can declare load() instead of an eager provider', async () => {
    const { dom, options } = createPaneDom();
    let loads = 0;
    const controller = createSidePaneController(options);
    controller.registerTabType({
        kind: 'deferred', label: 'Deferred',
        load: async () => { loads++; return { mountTab: (_p, view) => { view.textContent = 'ready'; return null; } }; }
    });
    assert.equal(loads, 0, 'registration alone does not load the implementation');
    await controller.openTab(tabOf('deferred:1', 'deferred'));
    assert.equal(loads, 1);
    assert.equal(options.contentContainer.querySelector('[data-tab-id="deferred:1"]').textContent, 'ready');
    await controller.dispose();
    dom.window.close();
});
