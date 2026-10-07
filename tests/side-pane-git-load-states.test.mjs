import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { mountGitView } from '../modules/ui-system/side-pane/git/git-view.js';

function mount(api) {
    const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true });
    const view = dom.window.document.getElementById('host');
    const handle = mountGitView(view, { api, uiHelper: { showToastNotification() {} } });
    const empty = () => view.querySelector('.side-git-empty');
    return { dom, view, handle, title: () => empty()?.querySelector('.side-git-empty-title')?.textContent, button: () => empty()?.querySelector('button') };
}

const workspace = { id: 'ws', alias: 'demo', path: '/code/demo' };
const status = { isRepo: true, branch: { head: 'main' }, remotes: [], staged: [], changes: [{ path: 'a.js', status: 'M' }], conflicts: [] };

test('before the workspace list arrives the Git view says it is loading, not that there are no workspaces', async () => {
    const list = Promise.withResolvers();
    const { title, handle, dom } = mount({ gitListWorkspaces: () => list.promise, gitStatus: async () => ({ success: true, data: status }) });
    assert.equal(title(), '加载中');
    list.resolve({ success: true, data: { workspaces: [workspace], activeWorkspaceId: 'ws' } });
    await handle.ready;
    dom.window.close();
});

test('a failed workspace list shows the error with a retry, and retrying loads the changes', async () => {
    let calls = 0;
    const { title, button, handle, view, dom } = mount({
        gitListWorkspaces: async () => (++calls === 1 ? { success: false, error: 'IPC down' } : { success: true, data: { workspaces: [workspace], activeWorkspaceId: 'ws' } }),
        gitStatus: async () => ({ success: true, data: status }),
        gitDiff: async () => ({ success: false })
    });
    await handle.ready;
    assert.equal(title(), '无法加载 Git 改动', 'not "还没有工作区"');
    assert.equal(button()?.textContent, '重试');
    button().click();
    for (let i = 0; i < 20 && !view.querySelector('.side-git-card'); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(calls, 2);
    assert.ok(view.querySelector('.side-git-card'));
    dom.window.close();
});
