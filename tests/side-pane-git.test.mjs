import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { mountGitView } from '../modules/ui-system/side-pane/git/git-view.js';
import { waitFor } from './helpers/wait-for.mjs';

test('the Git view has source select, flat change cards, expandable diff, context menu', async () => {
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

    const handle = mountGitView(viewElement, {
        api: mockAPI,
        uiHelper: { showToastNotification(msg, type) { toasts.push({ msg, type }); } }
    });
    await handle.ready;
    assert.ok(handle);

    // header: one source select + one refresh button, nothing else (single workspace => no workspace picker)
    assert.deepEqual([...viewElement.querySelectorAll('.side-git-source-select option')].map(o => o.value), ['unstaged', 'staged']);
    assert.equal(viewElement.querySelector('.side-git-ws-select').hidden, true);
    const headerControls = [...viewElement.querySelector('.side-git-header').querySelectorAll('select, button, input, textarea')].filter(el => !el.hidden);
    assert.deepEqual(headerControls.map(el => el.tagName), ['SELECT', 'BUTTON']);

    // flat list, default source = unstaged
    const cards = () => [...viewElement.querySelectorAll('.side-git-card')];
    assert.deepEqual(cards().map(c => c.dataset.path), ['src/unstaged.js', 'notes.txt', 'old.js']);
    assert.equal(cards()[0].querySelector('.side-git-file-name').textContent, 'unstaged.js');
    assert.equal(cards()[0].querySelector('.side-git-file-dir').textContent, 'src');

    // +N -N are filled in without expanding (no counts in the status => computed from the fetched diff)
    await waitFor(() => cards()[0].querySelector('.text-diff-added'), { message: 'diff-stat counts never painted' });
    assert.equal(cards()[0].querySelector('.text-diff-added').textContent, '+3');
    assert.equal(cards()[0].querySelector('.text-diff-removed').textContent, '-1');

    // expand
    const row = cards()[0].querySelector('.side-git-row');
    assert.equal(row.getAttribute('aria-expanded'), 'false');
    row.click();
    await waitFor(() => cards()[0].querySelector('.side-git-diff-table'), { message: 'expanded diff never rendered' });
    assert.equal(row.getAttribute('aria-expanded'), 'true');
    assert.equal(cards()[0].querySelector('.side-git-diff').hidden, false);
    // only one file is open at a time: opening another closes the first
    cards()[1].querySelector('.side-git-row').click();
    await waitFor(() => cards()[1].querySelector('.side-git-row').getAttribute('aria-expanded') === 'true', { message: 'second file never opened' });
    assert.equal(row.getAttribute('aria-expanded'), 'false');
    assert.equal(cards()[0].querySelector('.side-git-diff').hidden, true);
    assert.equal(cards()[1].querySelector('.side-git-row').getAttribute('aria-expanded'), 'true');
    cards()[1].querySelector('.side-git-row').click();
    assert.equal(cards()[1].querySelector('.side-git-diff').hidden, true);

    // a deleted file cannot be revealed in the file manager
    cards()[2].querySelector('.side-git-row').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    assert.equal(doc.querySelector('[data-action="reveal"]').disabled, true);
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));

    // staged source
    const select = viewElement.querySelector('.side-git-source-select');
    select.value = 'staged';
    select.dispatchEvent(new dom.window.Event('change'));
    await waitFor(() => cards().map(c => c.dataset.path).join() === 'src/staged.js', { message: 'staged source never listed' });

    // keyboard: Shift+F10 on a row opens the menu with focus inside, arrows move, Escape returns focus to the row
    const kbRow = cards()[0].querySelector('.side-git-row');
    kbRow.focus();
    kbRow.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const menuItems = () => [...doc.querySelectorAll('.side-git-context-item')];
    assert.equal(doc.activeElement, menuItems()[0], 'focus moves into the menu');
    assert.equal(menuItems()[0].querySelector('.vcp-ui-icon').getAttribute('aria-hidden'), 'true');
    doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(doc.activeElement, menuItems()[1]);
    doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    assert.equal(doc.activeElement, menuItems()[2], 'arrows wrap around');
    doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(doc.querySelector('.side-git-context-menu'), null);
    assert.equal(doc.activeElement, kbRow, 'Escape hands focus back to the row');

    // context menu: reveal / copy absolute / copy relative
    cards()[0].querySelector('.side-git-row').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    const items = [...doc.querySelectorAll('[role="menuitem"]')];
    assert.deepEqual(items.map(i => i.dataset.action), ['reveal', 'copy-abs', 'copy-rel']);
    assert.ok(items.every(i => i.textContent.trim()), 'every menu item has a visible name');
    doc.querySelector('[data-action="copy-rel"]').click();
    await waitFor(() => copied.length === 1, { message: 'relative path never copied' });
    assert.deepEqual(copied, ['src/staged.js']);
    assert.equal(doc.querySelector('.side-git-context-menu'), null, 'menu closes after choosing');

    cards()[0].querySelector('.side-git-row').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    doc.querySelector('[data-action="copy-abs"]').click();
    await waitFor(() => copied.length === 2, { message: 'absolute path never copied' });
    assert.equal(copied[1], '/code/vcpchat/src/staged.js');

    cards()[0].querySelector('.side-git-row').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    doc.querySelector('[data-action="reveal"]').click();
    await waitFor(() => revealed.length === 1, { message: 'reveal never requested' });
    assert.deepEqual(revealed, [['ws-demo', 'src/staged.js']]);

    await handle.dispose();
});



test('a long change list mounts in batches and still mounts the file being focused', async () => {
    const dom = new JSDOM('<div id="sideGitHost"></div>', { pretendToBeVisual: true });
    const win = dom.window;
    const observers = [];
    win.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
        observe(target) { this.targets.add(target); }
        unobserve(target) { this.targets.delete(target); }
        disconnect() { this.targets.clear(); }
        fire() { this.callback([...this.targets].map(target => ({ target, isIntersecting: true }))); }
    };
    const changes = Array.from({ length: 300 }, (_, i) => ({ path: `src/file_${i}.js`, status: 'M' }));
    const api = {
        async gitListWorkspaces() { return { success: true, data: { workspaces: [{ id: 'ws', alias: 'ws', path: '/code/ws' }], activeWorkspaceId: 'ws' } }; },
        async gitStatus() { return { success: true, data: { isRepo: true, staged: [], changes, conflicts: [] } }; },
        async gitDiff(wsId, relPath) {
            return { success: true, data: { path: relPath, before: { exists: true, binary: false, text: 'a\n' }, after: { exists: true, binary: false, text: 'b\n' } } };
        }
    };
    const host = win.document.getElementById('sideGitHost');
    const handle = mountGitView(host, { api });
    await handle.ready;
    const paths = () => [...host.querySelectorAll('.side-git-card')].map(card => card.dataset.path);

    assert.equal(paths().length, 120, 'only the first batch is mounted');
    assert.deepEqual(paths().slice(0, 2), ['src/file_0.js', 'src/file_1.js']);

    const more = observers.find(observer => observer.targets.size);
    more.fire();
    assert.equal(paths().length, 240);
    assert.equal(paths()[239], 'src/file_239.js', 'batches keep the status order');

    await handle.focusPath('src/file_290.js');
    const card = [...host.querySelectorAll('.side-git-card')].find(el => el.dataset.path === 'src/file_290.js');
    assert.ok(card, 'the focused file is mounted even past the loaded batches');
    assert.equal(card.querySelector('.side-git-row').getAttribute('aria-expanded'), 'true');
    assert.equal(new Set(paths()).size, paths().length, 'no card is mounted twice');

    more.fire();
    assert.equal(paths().length, 300);
    handle.dispose();
});

test('a status push while reading deep in a long list keeps the mounted cards and the scroll position', async () => {
    const dom = new JSDOM('<div id="sideGitHost"></div>', { pretendToBeVisual: true });
    const win = dom.window;
    const observers = [];
    win.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
        observe(target) { this.targets.add(target); }
        unobserve(target) { this.targets.delete(target); }
        disconnect() { this.targets.clear(); }
        fire() { this.callback([...this.targets].map(target => ({ target, isIntersecting: true }))); }
    };
    let edits = 0;
    const api = {
        async gitListWorkspaces() { return { success: true, data: { workspaces: [{ id: 'ws', alias: 'ws', path: '/code/ws' }], activeWorkspaceId: 'ws' } }; },
        // agent 每改一次文件，行数统计就变一次
        async gitStatus() { return { success: true, data: { isRepo: true, staged: [], conflicts: [],
            changes: Array.from({ length: 300 }, (_, i) => ({ path: `src/file_${i}.js`, status: 'M', added: i === 0 ? edits : 1, removed: 0 })) } }; },
        async gitDiff(wsId, relPath) {
            return { success: true, data: { path: relPath, before: { exists: true, binary: false, text: 'a\n' }, after: { exists: true, binary: false, text: 'b\n' } } };
        }
    };
    const host = win.document.getElementById('sideGitHost');
    const handle = mountGitView(host, { api });
    await handle.ready;
    const cards = () => host.querySelectorAll('.side-git-card').length;
    observers.find(observer => observer.targets.size).fire();
    assert.equal(cards(), 240);
    const body = host.querySelector('.side-git-body');
    body.scrollTop = 5000;

    edits += 1;
    await handle.refresh();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cards(), 240, 'the re-render mounts as many cards as were there');
    assert.equal(body.scrollTop, 5000, 'and stays where the reader was');
    handle.dispose();
});
