import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountGitView } from '../modules/ui-system/side-pane/git/git-view.js';

test('Git polling stops in a folded side pane and resumes when the Git page is visible', async t => {
    const dom = new JSDOM('<aside class="vcp-side-pane" aria-hidden="false"><section id="view"></section></aside>', { pretendToBeVisual: true });
    t.after(() => dom.window.close());
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let poll;
    let cleared = false;
    const timer = {};
    globalThis.setInterval = (callback, delay) => {
        assert.equal(delay, 8000);
        poll = callback;
        return timer;
    };
    globalThis.clearInterval = id => {
        if (id === timer) cleared = true;
        else originalClearInterval(id);
    };
    t.after(() => {
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
    });
    const doc = dom.window.document;
    const pane = doc.querySelector('aside');
    const host = doc.getElementById('view');
    let reads = 0;
    const handle = mountGitView(host, { api: {
        async gitListWorkspaces() {
            return { success: true, data: { workspaces: [{ id: 'fixture', path: '/fixture' }] } };
        },
        async gitStatus() {
            reads++;
            return { success: true, data: { isRepo: true, staged: [], changes: [], conflicts: [] } };
        },
    } });
    t.after(() => handle.dispose());
    // JSDOM has no layout. Native evidence verifies that a zero-width folded
    // pane still has an offsetParent; an inactive page has none.
    Object.defineProperty(handle.element, 'offsetParent', { get: () => host.hidden ? null : doc.body });
    await handle.ready;
    const tick = async () => { poll(); await new Promise(resolve => setImmediate(resolve)); };
    assert.equal(reads, 1);
    await tick();
    assert.equal(reads, 2, 'visible Git page polls');
    pane.setAttribute('aria-hidden', 'true');
    await tick();
    await tick();
    assert.equal(reads, 2, 'folding the pane stops background Git reads');
    pane.setAttribute('aria-hidden', 'false');
    host.hidden = true;
    await tick();
    assert.equal(reads, 2, 'switching to a different tab also stops polling');
    host.hidden = false;
    await tick();
    assert.equal(reads, 3, 'showing the Git page resumes polling');
    handle.dispose();
    assert.equal(cleared, true);
    await tick();
    assert.equal(reads, 3, 'a stale timer callback after close cannot read Git');
});
