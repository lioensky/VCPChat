import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountGitView } from '../modules/ui-system/side-pane/git/git-view.js';
import { getGitChangesSource } from '../modules/ui-system/sources/git-changes.js';

test('the Git page reads on pushes only while it is shown, catches up when shown again, and keeps no timer', async t => {
    const dom = new JSDOM('<aside class="vcp-side-pane" aria-hidden="false"><section id="view"></section></aside>', { pretendToBeVisual: true });
    t.after(() => dom.window.close());
    const originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = () => assert.fail('the Git page must not poll');
    t.after(() => { globalThis.setInterval = originalSetInterval; });
    const doc = dom.window.document;
    const pane = doc.querySelector('aside');
    const host = doc.getElementById('view');
    let reads = 0;
    const listeners = new Set();
    const api = {
        async gitListWorkspaces() {
            return { success: true, data: { workspaces: [{ id: 'fixture', path: '/fixture' }] } };
        },
        async gitStatus() {
            reads++;
            return { success: true, data: { isRepo: true, staged: [], changes: [], conflicts: [] } };
        },
        onGitChanged(cb) { listeners.add(cb); return () => listeners.delete(cb); },
        async subscribeMainState() { return { success: true }; },
        async unsubscribeMainState() { return { success: true }; },
    };
    getGitChangesSource(api, 'fixture', { graceMs: 0 });
    const handle = mountGitView(host, { api });
    t.after(() => handle.dispose());
    // JSDOM has no layout. Native evidence verifies that a zero-width folded
    // pane still has an offsetParent; an inactive page has none.
    Object.defineProperty(handle.element, 'offsetParent', { get: () => host.hidden ? null : doc.body });
    await handle.ready;
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const push = async () => { listeners.forEach(cb => cb({ workspaceId: 'fixture', reason: 'files' })); await settle(); };
    assert.equal(reads, 1);
    await push();
    assert.equal(reads, 2, 'a visible Git page re-reads on a push');

    pane.setAttribute('aria-hidden', 'true');
    await push();
    await push();
    assert.equal(reads, 2, 'a folded pane does not read Git');
    pane.setAttribute('aria-hidden', 'false');
    handle.refreshIfStale();
    await settle();
    assert.equal(reads, 3, 'unfolding catches up once for all missed pushes');

    host.hidden = true;
    await push();
    assert.equal(reads, 3, 'another page of the tab does not read Git either');
    host.hidden = false;
    handle.element.dispatchEvent(new dom.window.Event('pointerenter'));
    await settle();
    assert.equal(reads, 4, 'pointing at the page again catches up');

    await handle.dispose();
    assert.equal(listeners.size, 0, 'closing stops listening for pushes');
    await push();
    assert.equal(reads, 4);
});

test('the Git page catches up when it gets a size again after the whole chat was covered by another app tab', async t => {
    const dom = new JSDOM('<section id="view"></section>', { pretendToBeVisual: true });
    t.after(() => dom.window.close());
    // JSDOM has no ResizeObserver; this stand-in lets the test fire the callback the way layout would
    const observers = [];
    dom.window.ResizeObserver = class {
        constructor(cb) { this.cb = cb; this.targets = new Set(); observers.push(this); }
        observe(target) { this.targets.add(target); }
        disconnect() { this.targets.clear(); }
        fire() { if (this.targets.size) this.cb([...this.targets].map(target => ({ target }))); }
    };
    const doc = dom.window.document;
    const host = doc.getElementById('view');
    let reads = 0;
    const listeners = new Set();
    const api = {
        async gitListWorkspaces() {
            return { success: true, data: { workspaces: [{ id: 'covered', path: '/covered' }] } };
        },
        async gitStatus() {
            reads++;
            return { success: true, data: { isRepo: true, staged: [], changes: [], conflicts: [] } };
        },
        onGitChanged(cb) { listeners.add(cb); return () => listeners.delete(cb); },
        async subscribeMainState() { return { success: true }; },
        async unsubscribeMainState() { return { success: true }; },
    };
    getGitChangesSource(api, 'covered', { graceMs: 0 });
    const handle = mountGitView(host, { api });
    t.after(() => handle.dispose());
    let covered = false;
    Object.defineProperty(handle.element, 'offsetParent', { get: () => covered ? null : doc.body });
    await handle.ready;
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const push = async () => { listeners.forEach(cb => cb({ workspaceId: 'covered', reason: 'files' })); await settle(); };
    const resized = async () => { observers.forEach(o => o.fire()); await settle(); };
    assert.equal(observers.length, 1);
    assert.equal(reads, 1);

    await resized();
    assert.equal(reads, 1, 'a resize with nothing missed does not read Git');

    covered = true;
    await push();
    await resized();
    assert.equal(reads, 1, 'a covered page neither reads on the push nor when it collapses to zero size');
    covered = false;
    await resized();
    assert.equal(reads, 2, 'getting a size again catches up without a pointer or window focus');
    await resized();
    assert.equal(reads, 2, 'it catches up only once');

    await handle.dispose();
    assert.equal(observers[0].targets.size, 0, 'closing disconnects the observer');
});
