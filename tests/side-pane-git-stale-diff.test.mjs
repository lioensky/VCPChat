// Git 页：已修改的文件被再次编辑（状态码不变）时，行数和展开的 diff 要跟着变；作废前发出的 diff 请求不能写回缓存
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountGitView } from '../modules/ui-system/side-pane/git/git-view.js';
import { getGitChangesSource } from '../modules/ui-system/sources/git-changes.js';

import { waitFor } from './helpers/wait-for.mjs';

function fixture() {
    const dom = new JSDOM('<section id="view"></section>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const listeners = new Set();
    const state = { after: 'a\n', added: 1, diffs: 0, toplevel: '/repo' };
    const api = {
        async gitListWorkspaces() { return { success: true, data: { workspaces: [{ id: 'w', path: '/repo/pkg' }] } }; },
        async gitStatus() {
            return { success: true, data: { isRepo: true, toplevel: state.toplevel, prefix: 'pkg', staged: [], conflicts: [],
                changes: [{ path: 'pkg/x.js', status: 'M', added: state.added, removed: 0 }] } };
        },
        async gitDiff() { state.diffs += 1; return { success: true, data: { before: { text: '' }, after: { text: state.after } } }; },
        onGitChanged(cb) { listeners.add(cb); return () => listeners.delete(cb); },
        async subscribeMainState() { return {}; },
        async unsubscribeMainState() { return {}; }
    };
    getGitChangesSource(api, 'w', { graceMs: 0 });
    const view = mountGitView(doc.getElementById('view'), { api });
    Object.defineProperty(view.element, 'offsetParent', { get: () => doc.body });
    return {
        dom, doc, view, state,
        counts: () => view.element.querySelector('.side-git-counts').textContent,
        push: () => listeners.forEach(cb => cb({ workspaceId: 'w', reason: 'files' })),
        cleanup() { view.dispose(); dom.window.close(); }
    };
}

test('line counts and the expanded diff follow a second edit of a modified file', async () => {
    const f = fixture();
    try {
        await f.view.ready;
        await waitFor(() => f.counts() === '+1-0', { message: 'status counts never painted' });
        assert.equal(f.state.diffs, 0, 'counts come with the status, not from one diff per file');

        f.view.element.querySelector('.side-git-row').click();
        await waitFor(() => f.view.element.querySelectorAll('.side-git-diff-table .diff-line.add').length === 1, { message: 'expanded diff never rendered' });

        f.state.after = 'a\nb\nc\nd\n';
        f.state.added = 4;
        f.push();
        await waitFor(() => f.counts() === '+4-0', { message: 'push never refreshed the counts' });
        assert.equal(f.view.element.querySelector('.side-git-row').getAttribute('aria-expanded'), 'true', 'the open file stays open');
        await waitFor(() => f.view.element.querySelectorAll('.side-git-diff-table .diff-line.add').length === 4, { message: 'open diff kept the stale text' });
    } finally { f.cleanup(); }
});

test('copying the absolute path of a file in a subdirectory workspace uses the repository root', async () => {
    const f = fixture();
    const copied = [];
    Object.defineProperty(f.dom.window.navigator, 'clipboard', { configurable: true,
        value: { writeText: async text => { copied.push(text); } } });
    try {
        await f.view.ready;
        await waitFor(() => f.view.element.querySelector('.side-git-row'), { message: 'row never rendered' });
        const row = f.view.element.querySelector('.side-git-row');
        row.dispatchEvent(new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
        const item = f.doc.querySelector('[role="menuitem"][data-action="copy-abs"]');
        assert.ok(item, 'the context menu offers the absolute path');
        item.click();
        await waitFor(() => copied.length === 1, { message: 'absolute path never copied' });
        assert.deepEqual(copied, ['/repo/pkg/x.js']);
    } finally { f.cleanup(); }
});
