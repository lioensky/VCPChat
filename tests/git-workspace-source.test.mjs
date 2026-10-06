// 「当前工作区」：同一窗口里走状态通道，别的窗口改了存储时由 storage 事件带过来
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    GIT_WORKSPACE_STORAGE_KEY, readSelectedGitWorkspace, selectGitWorkspace, watchSelectedGitWorkspace
} from '../modules/ui-system/sources/git-workspace.js';

test('a selection made in another window reaches watchers here, once, with its own origin', () => {
    const dom = new JSDOM('<body></body>', { url: 'http://localhost/' });
    const win = dom.window;
    try {
        const seen = [];
        const off = watchSelectedGitWorkspace(win, value => seen.push({ ...value }));
        selectGitWorkspace(win, 'ws1', { origin: 'git-tab' });

        const fromOtherWindow = (newValue, key = GIT_WORKSPACE_STORAGE_KEY) => {
            if (key === GIT_WORKSPACE_STORAGE_KEY && newValue) win.localStorage.setItem(key, newValue);
            win.dispatchEvent(new win.StorageEvent('storage', { key, newValue }));
        };
        fromOtherWindow('ws2');
        fromOtherWindow('ws2'); // 同一个值不重复通知
        fromOtherWindow('x', 'unrelated');
        fromOtherWindow(null); // 存储被清掉：保持当前选择
        assert.deepEqual(seen, [{ id: 'ws1', origin: 'git-tab' }, { id: 'ws2', origin: 'other-window' }]);
        assert.equal(readSelectedGitWorkspace(win), 'ws2');

        off();
        fromOtherWindow('ws3');
        assert.equal(seen.length, 2, 'an unsubscribed watcher hears nothing');
    } finally {
        win.close();
    }
});
