import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { mountGitView } from '../modules/ui-system/side-pane/git/git-view.js';
import { waitFor } from './helpers/wait-for.mjs';

// 文件一改主进程就推送，Git 列表静默重绘；键盘用户正停在某一行时焦点不能掉到 body
test('a quiet refresh that redraws the list keeps focus on the same file row', async () => {
    const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const host = doc.getElementById('host');
    // JSDOM 不做布局，offsetParent 总是 null；这里当作挂在文档里就看得见
    Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return this.isConnected ? this.parentNode : null; } });
    let changes = [{ path: 'a.js', status: 'M' }, { path: 'b.js', status: 'M' }];
    const api = {
        async gitListWorkspaces() { return { success: true, data: { workspaces: [{ id: 'w', alias: 'w', path: '/w' }], activeWorkspaceId: 'w' } }; },
        async gitStatus() { return { success: true, data: { isRepo: true, branch: { head: 'main' }, remotes: [], staged: [], changes: [...changes], conflicts: [] } }; },
        async gitDiff() { return { success: false, error: 'n/a' }; }
    };
    const handle = mountGitView(host, { api, uiHelper: null });
    await handle.ready;
    const row = path => host.querySelector(`.side-git-card[data-path="${path}"] .side-git-row`);
    try {
        row('b.js').focus();
        assert.equal(doc.activeElement, row('b.js'));

        // 新增一个文件：整张列表重建，焦点仍在 b.js
        changes = [{ path: 'new.js', status: 'U' }, ...changes];
        dom.window.dispatchEvent(new dom.window.Event('focus'));
        await waitFor(() => host.querySelector('.side-git-card[data-path="new.js"]'), { message: 'list was never redrawn' });
        assert.equal(doc.activeElement, row('b.js'));

        // 聚焦的文件被提交掉了：焦点给同一位置的行，不掉到 body
        changes = changes.filter(item => item.path !== 'b.js');
        dom.window.dispatchEvent(new dom.window.Event('focus'));
        await waitFor(() => row('b.js') === null, { message: 'committed file never left the list' });
        assert.ok(host.contains(doc.activeElement) && doc.activeElement.isConnected, 'focus stays in the list');
        assert.equal(doc.activeElement.classList.contains('side-git-row'), true);
    } finally {
        handle.dispose?.();
        dom.window.close();
    }
});
