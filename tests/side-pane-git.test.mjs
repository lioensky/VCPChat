import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createGitSideProvider } from '../modules/ui-system/side-pane/gitSideProvider.js';

test('GitSideProvider: mirrors the ZCode GitPane — source select, flat change cards, expandable diff, context menu', async () => {
    const dom = new JSDOM(`
        <div id="sideGitHost"></div>
    `, { pretendToBeVisual: true });
    const doc = dom.window.document;
    const viewElement = doc.getElementById('sideGitHost');

    const stagedChanges = [{ path: 'src/staged.js', status: 'M' }];
    const unstagedChanges = [{ path: 'src/unstaged.js', status: 'M' }, { path: 'notes.txt', status: 'U' }, { path: 'old.js', status: 'D' }];
    const copied = [];
    const revealed = [];
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (text) => { copied.push(text); } } });
    const toasts = [];

    const mockAPI = {
        async gitListWorkspaces() {
            return { success: true, data: { workspaces: [{ id: 'ws-demo', alias: 'VCPChat-Core', path: '/code/vcpchat' }], activeWorkspaceId: 'ws-demo' } };
        },
        async gitStatus() {
            return { success: true, data: { isRepo: true, branch: { head: 'main' }, remotes: [], staged: [...stagedChanges], changes: [...unstagedChanges], conflicts: [] } };
        },
        async gitDiff(wsId, relPath, { staged }) {
            return {
                success: true,
                data: {
                    path: relPath,
                    staged: Boolean(staged),
                    before: { exists: true, binary: false, text: ['function hello() {}', ''].join('\n'), size: 20, truncated: false },
                    after: { exists: true, binary: false, text: ['function hello() {', '    return 42;', '}', ''].join('\n'), size: 38, truncated: false }
                }
            };
        },
        async gitRevealPath(wsId, relPath) {
            revealed.push([wsId, relPath]);
            return { success: true, data: { revealed: true } };
        }
    };

    const provider = createGitSideProvider({
        electronAPI: mockAPI,
        uiHelper: { showToastNotification(msg, type) { toasts.push({ msg, type }); } }
    });

    const handle = await provider.mountTab({ id: 'side-pane-git', kind: 'git', title: 'Git 变更' }, viewElement);
    assert.ok(handle);

    // header: one source select + one refresh button, nothing else (single workspace => no workspace picker)
    assert.deepEqual([...viewElement.querySelectorAll('.side-git-source-select option')].map(o => o.value), ['unstaged', 'staged']);
    assert.equal(viewElement.querySelector('.side-git-ws-select').hidden, true);
    assert.match(viewElement.querySelector('.side-git-refresh-btn').textContent, /刷新/);
    for (const gone of ['.side-git-branch-badge', '.side-git-sync-badge', '.side-git-commit-input', '.side-git-group', '.side-git-row-action-btn', '.side-git-graph-btn']) {
        assert.equal(viewElement.querySelector(gone), null, gone + ' must not exist');
    }

    // flat list, default source = unstaged
    const cards = () => [...viewElement.querySelectorAll('.side-git-card')];
    assert.deepEqual(cards().map(c => c.dataset.path), ['src/unstaged.js', 'notes.txt', 'old.js']);
    assert.equal(cards()[0].querySelector('.side-git-file-name').textContent, 'unstaged.js');
    assert.equal(cards()[0].querySelector('.side-git-file-dir').textContent, 'src');

    // +N -N are filled in without expanding
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(cards()[0].querySelector('.text-diff-added').textContent, '+3');
    assert.equal(cards()[0].querySelector('.text-diff-removed').textContent, '-1');

    // expand
    const row = cards()[0].querySelector('.side-git-row');
    assert.equal(row.getAttribute('aria-expanded'), 'false');
    row.click();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(row.getAttribute('aria-expanded'), 'true');
    assert.equal(cards()[0].querySelector('.side-git-diff').hidden, false);
    assert.ok(cards()[0].querySelector('.side-git-diff-table'));
    // only one file is open at a time: opening another closes the first
    cards()[1].querySelector('.side-git-row').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(row.getAttribute('aria-expanded'), 'false');
    assert.equal(cards()[0].querySelector('.side-git-diff').hidden, true);
    assert.equal(cards()[1].querySelector('.side-git-row').getAttribute('aria-expanded'), 'true');
    cards()[1].querySelector('.side-git-row').click();
    assert.equal(cards()[1].querySelector('.side-git-diff').hidden, true);

    // a deleted file cannot be revealed in the file manager
    cards()[2].querySelector('.side-git-row').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    assert.equal(doc.querySelector('.side-git-context-item').disabled, true);
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));

    // staged source
    const select = viewElement.querySelector('.side-git-source-select');
    select.value = 'staged';
    select.dispatchEvent(new dom.window.Event('change'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(cards().map(c => c.dataset.path), ['src/staged.js']);

    // context menu: reveal / copy absolute / copy relative
    cards()[0].querySelector('.side-git-row').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    const items = [...doc.querySelectorAll('.side-git-context-item')];
    assert.deepEqual(items.map(i => i.querySelector('.side-git-context-label').textContent), ['在文件管理器中打开', '复制绝对路径', '复制相对路径']);
    items[2].click();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(copied, ['src/staged.js']);
    assert.equal(doc.querySelector('.side-git-context-menu'), null, 'menu closes after choosing');

    cards()[0].querySelector('.side-git-row').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    [...doc.querySelectorAll('.side-git-context-item')][1].click();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(copied[1], '/code/vcpchat/src/staged.js');

    cards()[0].querySelector('.side-git-row').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    [...doc.querySelectorAll('.side-git-context-item')][0].click();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(revealed, [['ws-demo', 'src/staged.js']]);

    await handle.dispose();
});


