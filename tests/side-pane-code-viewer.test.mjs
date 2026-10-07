import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createCodeViewerSideProvider } from '../modules/ui-system/side-pane/codeViewerSideProvider.js';
import * as SidePaneState from '../modules/ui-system/side-pane/side-pane-state.js';
import { DIFF_PAGE_ROWS } from '../modules/ui-system/side-pane/code-viewer/diff-view.js';
import { installMainComposer } from './helpers/main-composer.mjs';
import { waitFor } from './helpers/wait-for.mjs';

test('openViewer opens a workspace-wide tab that becomes active even while a conversation is the parent', async () => {
    const dom = new JSDOM('<div></div>');
    const opened = [];
    const provider = createCodeViewerSideProvider({
        document: dom.window.document,
        api: null,
        uiHelper: null,
        sidePaneController: { openTab: async (tab) => { opened.push(tab); return tab; } }
    });

    await provider.openViewer({ filePath: 'C:/proj/src/app.js' });
    assert.equal(opened.length, 1);
    assert.equal(opened[0].scopeMode, 'global');
    assert.equal(opened[0].title, 'app.js');

    let state = SidePaneState.createInitialSidePaneState();
    state = SidePaneState.setParent(state, { itemType: 'agent', itemId: 'a1', topicId: 't1' });
    state = SidePaneState.openTab(state, opened[0]);
    assert.equal(state.activeTabId, 'code-viewer:C:/proj/src/app.js');
    assert.equal(state.visible, true);
});

test('mounted viewer preserves code insertion, wrap state and paged diff mode switching', async () => {
    const dom = new JSDOM('<textarea id="messageInput">existing</textarea><section id="view"></section>');
    const doc = dom.window.document;
    const composer = installMainComposer(dom.window);
    const provider = createCodeViewerSideProvider({ document: doc, api: null, uiHelper: null });
    const view = doc.getElementById('view');
    const current = 'const value = 2;\nexport { value };\n';
    const before = Array.from({length: 600}, (_, i) => `line ${i}`).join('\n');
    const after = before + '\nnew line';
    const handle = await provider.mountTab({ title: 'example.js', payload: { code: current, mode: 'diff', oldCode: before, newCode: after } }, view);
    try {
        assert.equal(handle.getMode(), 'diff');
        assert.equal(view.querySelectorAll('.side-diff-row').length, DIFF_PAGE_ROWS);
        const more = view.querySelector('[data-action="diff-more"]');
        more.click();
        assert.equal(view.querySelectorAll('.side-diff-row').length, 601);
        assert.equal(more.hidden, true);
        view.querySelector('[data-action="toggle-wrap"]').click();
        assert.equal(view.querySelector('.side-diff-shell').classList.contains('is-wrapped'), true);
        view.querySelector('.side-code-mode-toggle').click();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(handle.getMode(), 'view');
        assert.equal(view.querySelectorAll('.side-code-line-number').length, 2);
        assert.equal(view.querySelector('.side-code-editor-shell').classList.contains('is-wrapped'), true);
        let inputs = 0;
        doc.getElementById('messageInput').addEventListener('input', () => inputs++);
        view.querySelector('[data-action="insert-chat"]').click();
        assert.equal(doc.getElementById('messageInput').value, `existing\n\`\`\`javascript\n${current}\n\`\`\`\n`);
        assert.equal(inputs, 1);
        assert.equal(handle.getCode(), current);

        // 主输入框不在了（命令已注销）：按钮什么也不做，不报错
        await composer.dispose();
        view.querySelector('[data-action="insert-chat"]').click();
        assert.equal(inputs, 1);
    } finally {
        handle.dispose();
        assert.equal(view.children.length, 0);
        dom.window.close();
    }
});

test('workspace picker ignores stale reads and detaches its controls on dispose', async () => {
    const dom = new JSDOM('<section id="view"></section>', {url:'https://vcpchat.local/'});
    const doc = dom.window.document;
    const pending = new Map();
    const provider = createCodeViewerSideProvider({ document: doc, uiHelper: null, api: {
        async gitListWorkspaces() { return {success:true,data:{workspaces:[{id:'w',path:'/repo'}],activeWorkspaceId:'w'}}; },
        async sourceListFiles() { return {success:true,data:{files:['old.js','new.ts']}}; },
        sourceReadFile(_workspace, path) { return new Promise(resolve => pending.set(path, resolve)); }
    }});
    const view = doc.getElementById('view');
    const handle = await provider.mountTab({title:'代码',payload:{}}, view);
    try {
        view.querySelector('[data-path="old.js"]').click();
        view.querySelector('[data-path="new.ts"]').click();
        pending.get('new.ts')({success:true,data:{text:'const newest: number = 2;\n'}});
        await new Promise(resolve => setImmediate(resolve));
        pending.get('old.js')({success:true,data:{text:'stale'}});
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(handle.getCode(), 'const newest: number = 2;\n');
        assert.equal(view.querySelector('.side-code-title').textContent, 'new.ts');
        assert.equal(view.querySelector('[data-lang]').dataset.lang, 'typescript');
        const picker = view.querySelector('.side-code-picker');
        const toggle = view.querySelector('[data-action="toggle-picker"]');
        const collapsed = picker.classList.contains('is-collapsed');
        handle.dispose();
        toggle.click();
        assert.equal(picker.classList.contains('is-collapsed'), collapsed);
        assert.equal(view.children.length, 0);
    } finally {
        handle.dispose();
        dom.window.close();
    }
});

for (const staleSettlement of ['resolve', 'reject']) {
    test(`workspace picker rejects a stale ${staleSettlement} after returning to the same file`, async () => {
        const dom = new JSDOM('<section id="view"></section>', { url: 'https://vcpchat.local/' });
        const requests = [];
        const provider = createCodeViewerSideProvider({ document: dom.window.document, uiHelper: null, api: {
            async gitListWorkspaces() { return { success: true, data: { workspaces: [{ id: 'w', path: '/repo' }], activeWorkspaceId: 'w' } }; },
            async sourceListFiles() { return { success: true, data: { files: ['a.js', 'b.js'] } }; },
            sourceReadFile(_workspace, path) {
                const request = Promise.withResolvers();
                requests.push({ path, ...request });
                return request.promise;
            }
        } });
        const view = dom.window.document.getElementById('view');
        const handle = await provider.mountTab({ title: '代码', payload: {} }, view);
        try {
            for (const path of ['a.js', 'b.js', 'a.js']) view.querySelector(`[data-path="${path}"]`).click();
            requests[2].resolve({ success: true, data: { text: 'const newest = 3;' } });
            await new Promise(resolve => setImmediate(resolve));
            if (staleSettlement === 'resolve') requests[0].resolve({ success: true, data: { text: 'const stale = 1;' } });
            else requests[0].reject(new Error('old request failed'));
            requests[1].reject(new Error('other file failed'));
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(handle.getCode(), 'const newest = 3;');
            assert.match(view.querySelector('.side-code-body').textContent, /const newest = 3/);
            assert.doesNotMatch(view.querySelector('.side-code-body').textContent, /failed|stale/);
            assert.equal(view.querySelector('.side-code-title').textContent, 'a.js');
        } finally {
            handle.dispose();
            dom.window.close();
        }
    });
}

test('replaced picker rows no longer trigger reads after filtering', async () => {
    const dom = new JSDOM('<section id="view"></section>', { url: 'https://vcpchat.local/' });
    const reads = [];
    const provider = createCodeViewerSideProvider({ document: dom.window.document, uiHelper: null, api: {
        async gitListWorkspaces() { return { success: true, data: { workspaces: [{ id: 'w', path: '/repo' }], activeWorkspaceId: 'w' } }; },
        async sourceListFiles() { return { success: true, data: { files: ['a.js', 'b.js'] } }; },
        async sourceReadFile(_workspace, path) { reads.push(path); return { success: true, data: { text: path } }; }
    } });
    const view = dom.window.document.getElementById('view');
    const handle = await provider.mountTab({ title: '代码', payload: {} }, view);
    try {
        const retiredRow = view.querySelector('[data-path="a.js"]');
        const filter = view.querySelector('.side-code-picker-filter');
        filter.value = 'b';
        filter.dispatchEvent(new dom.window.Event('input'));
        assert.equal(retiredRow.isConnected, false);
        retiredRow.click();
        assert.deepEqual(reads, []);
        view.querySelector('[data-path="b.js"] .side-code-picker-name').click();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(reads, ['b.js']);
        assert.equal(handle.getCode(), 'b.js');
    } finally {
        handle.dispose();
        dom.window.close();
    }
});

test('workspace picker is keyboard usable and returns focus to its toggle after opening a file', async () => {
    const dom = new JSDOM('<section id="view"></section>', { url: 'https://vcpchat.local/' });
    const doc = dom.window.document;
    const provider = createCodeViewerSideProvider({ document: doc, uiHelper: null, api: {
        async gitListWorkspaces() { return { success: true, data: { workspaces: [{ id: 'w', path: '/repo' }], activeWorkspaceId: 'w' } }; },
        async sourceListFiles() { return { success: true, data: { files: ['a.js', 'b.js'] } }; },
        async sourceReadFile(_workspace, path) { return { success: true, data: { text: path } }; }
    } });
    const view = doc.getElementById('view');
    doc.body.appendChild(view);
    const handle = await provider.mountTab({ title: '代码', payload: {} }, view);
    try {
        const filter = view.querySelector('.side-code-picker-filter');
        const list = view.querySelector('.side-code-picker-list');
        const toggle = view.querySelector('[data-action="toggle-picker"]');
        assert.ok(toggle.getAttribute('aria-label'), 'the icon-only toggle has an accessible name');
        assert.ok(filter.getAttribute('aria-label'), 'the filter has an accessible name');
        assert.notEqual(list.getAttribute('role'), 'listbox', 'rows are buttons, not options');
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');

        const key = (target, k) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        filter.focus();
        key(filter, 'ArrowDown');
        assert.equal(doc.activeElement?.dataset.path, 'a.js');
        key(doc.activeElement, 'ArrowDown');
        assert.equal(doc.activeElement?.dataset.path, 'b.js');
        key(doc.activeElement, 'Home');
        key(doc.activeElement, 'ArrowUp');
        assert.equal(doc.activeElement, filter);

        key(filter, 'ArrowDown');
        doc.activeElement.click();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(handle.getCode(), 'a.js');
        assert.equal(view.querySelector('.side-code-picker').classList.contains('is-collapsed'), true);
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');
        assert.equal(doc.activeElement, toggle, 'focus does not fall to body when the picker collapses');
        assert.equal(view.querySelector('[data-path="a.js"]').getAttribute('aria-current'), 'true');
    } finally {
        handle.dispose();
        dom.window.close();
    }
});

function fileTab(filePath) {
    return { id: `code-viewer:${filePath}`, title: filePath.split('/').pop(), payload: { filePath } };
}

test('a failed file read shows an error instead of an empty file, and a real empty file still renders', async () => {
    const dom = new JSDOM('<section id="missing"></section><section id="empty"></section>');
    const doc = dom.window.document;
    const files = { 'C:/proj/empty.txt': '' };
    // 附件读取对不存在的文件返回 { text: null }
    const provider = createCodeViewerSideProvider({ document: doc, uiHelper: null, api: {
        async getTextContent(filePath) { return { text: files[filePath] ?? null }; }
    } });
    const missing = await provider.mountTab(fileTab('C:/proj/gone.js'), doc.getElementById('missing'));
    const empty = await provider.mountTab(fileTab('C:/proj/empty.txt'), doc.getElementById('empty'));
    try {
        const missingView = doc.getElementById('missing');
        assert.ok(missingView.querySelector('.side-code-error')?.textContent.trim(), 'the failure is shown as an error');
        assert.equal(missingView.querySelector('.side-code-editor-shell'), null);
        assert.equal(missing.getCode(), '');

        const emptyView = doc.getElementById('empty');
        assert.equal(emptyView.querySelector('.side-code-error'), null);
        assert.equal(emptyView.querySelectorAll('.side-code-line-number').length, 1);
    } finally {
        missing.dispose();
        empty.dispose();
        dom.window.close();
    }
});

test('workspace files are read through the source service and report binary, too-large and missing files', async () => {
    const dom = new JSDOM('<section id="view"></section>');
    const doc = dom.window.document;
    const results = {
        'bin.dat': { success: true, data: { binary: true } },
        'big.log': { success: true, data: { tooLarge: true, size: 6 * 1024 * 1024 } },
        'gone.js': { success: false, error: '文件不存在（可能已被移动或删除）: gone.js' },
        'ok.js': { success: true, data: { text: 'const ok = 1;\n' } }
    };
    const reads = [];
    const provider = createCodeViewerSideProvider({ document: doc, uiHelper: null, api: {
        async gitListWorkspaces() { return { success: true, data: { workspaces: [{ id: 'w', path: 'C:\\repo' }] } }; },
        async sourceReadFile(workspaceId, relPath) { reads.push([workspaceId, relPath]); return results[relPath.slice('src/'.length)]; },
        async getTextContent() { throw new Error('workspace files must not use the attachment reader'); }
    } });
    const view = doc.getElementById('view');
    const expectations = [
        ['bin.dat', '.side-code-empty[data-reason="binary"]', null],
        ['big.log', '.side-code-empty[data-reason="too-large"]', /6144/],
        // 后端给的错误原样显示
        ['gone.js', '.side-code-error', /gone\.js/],
        ['ok.js', '.side-code-pre', /const ok = 1;/]
    ];
    for (const [name, selector, pattern] of expectations) {
        const handle = await provider.mountTab(fileTab(`C:/repo/src/${name}`), view);
        try {
            const shown = view.querySelector(selector);
            assert.ok(shown, name);
            if (pattern) assert.match(shown.textContent, pattern, name);
            if (name !== 'ok.js') assert.equal(handle.getCode(), '', name);
        } finally {
            handle.dispose();
        }
    }
    assert.deepEqual(reads.map(([, relPath]) => relPath), ['src/bin.dat', 'src/big.log', 'src/gone.js', 'src/ok.js']);
    assert.ok(reads.every(([workspaceId]) => workspaceId === 'w'));
    dom.window.close();
});

test('reopening an already open file re-reads it from disk, while snippets keep their snapshot', async () => {
    const dom = new JSDOM('<section id="view"></section>');
    const doc = dom.window.document;
    let disk = 'version 1';
    let reads = 0;
    const handles = new Map();
    const view = doc.getElementById('view');
    let provider;
    // 和真实控制器一样：已挂载的标签再次 openTab 只切换过去，返回同一个句柄
    const controller = {
        getTabHandle: (id) => handles.get(id) || null,
        async openTab(tab) {
            if (!handles.has(tab.id)) handles.set(tab.id, await provider.mountTab(tab, view));
            return handles.get(tab.id);
        }
    };
    provider = createCodeViewerSideProvider({ document: doc, uiHelper: null, sidePaneController: controller, api: {
        async getTextContent() { reads++; return { text: disk }; }
    } });
    try {
        const first = await provider.openViewer({ filePath: 'C:/proj/notes.txt' });
        assert.equal(first.getCode(), 'version 1');
        disk = 'version 2';
        const second = await provider.openViewer({ filePath: 'C:/proj/notes.txt' });
        assert.equal(second, first);
        assert.equal(second.getCode(), 'version 2');
        assert.match(view.querySelector('.side-code-pre').textContent, /version 2/);
        assert.equal(reads, 2);

        disk = 'version 3';
        view.querySelector('[data-action="reload-file"]').click();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(first.getCode(), 'version 3');
        assert.equal(reads, 3);

        // 删除后重新读取：显示错误，不再保留旧内容
        disk = null;
        await first.reload();
        assert.ok(view.querySelector('.side-code-error'));
        assert.equal(view.querySelector('.side-code-pre'), null, 'the old content is gone');
        assert.equal(first.getCode(), '');

        const snippetView = doc.createElement('section');
        const snippet = await provider.mountTab({ title: 'a.js', payload: { filePath: 'C:/proj/a.js', code: 'snapshot' } }, snippetView);
        assert.equal(snippetView.querySelector('[data-action="reload-file"]'), null);
        await snippet.reload();
        assert.equal(snippet.getCode(), 'snapshot');
        assert.equal(reads, 4);
        snippet.dispose();
    } finally {
        for (const handle of handles.values()) handle.dispose();
        dom.window.close();
    }
});

test('large files only render the first preview chunk, cut at a line end', async () => {
    const { PREVIEW_CHAR_LIMIT } = await import('../modules/ui-system/side-pane/code-viewer/editor.js');
    const dom = new JSDOM('<section id="view"></section>');
    const doc = dom.window.document;
    const line = 'x'.repeat(99);
    const text = Array.from({ length: 20000 }, () => line).join('\n');
    const provider = createCodeViewerSideProvider({ document: doc, uiHelper: null, api: {
        async getTextContent() { return { text }; }
    } });
    const view = doc.getElementById('view');
    const handle = await provider.mountTab(fileTab('C:/proj/big.txt'), view);
    try {
        const shownLines = view.querySelectorAll('.side-code-line-number').length;
        assert.equal(shownLines, Math.floor(PREVIEW_CHAR_LIMIT / (line.length + 1)));
        assert.ok(view.querySelector('.side-code-pre').textContent.split('\n').every(row => row === line));
        const note = view.querySelector('.side-code-truncated-note').textContent;
        assert.ok(note.includes(String(20000)) && note.includes(String(shownLines)), 'the note gives the total and the previewed line count');
        // 复制和插入用的仍是完整内容
        assert.equal(handle.getCode(), text);
    } finally {
        handle.dispose();
        dom.window.close();
    }
});

test('the file button reveals a workspace file in the file manager and never opens it by association', async () => {
    const dom = new JSDOM('<section id="view"></section>');
    const doc = dom.window.document;
    const revealed = [];
    const toasts = [];
    const opened = [];
    const api = {
        gitListWorkspaces: async () => ({ success: true, data: { workspaces: [{ id: 'ws1', path: 'C:\\proj' }] } }),
        sourceReadFile: async () => ({ success: true, data: { content: 'x', encoding: 'utf8' } }),
        gitRevealPath: async (wsId, rel) => { revealed.push([wsId, rel]); return { success: true }; },
        openPythonAttachmentInTextEditor: (p) => opened.push(p),
        sendOpenExternalLink: (p) => opened.push(p)
    };
    const provider = createCodeViewerSideProvider({ document: doc, api, uiHelper: { showToastNotification: (m, t) => toasts.push([m, t]) } });
    const click = async (filePath) => {
        const view = doc.createElement('section');
        doc.body.append(view);
        const handle = await provider.mountTab({ title: 'f', payload: { filePath } }, view);
        const before = revealed.length + toasts.length;
        view.querySelector('[data-action="open-external"]').click();
        await waitFor(() => revealed.length + toasts.length > before, { message: 'the file button did nothing' });
        await handle?.dispose?.();
    };
    await click('C:\\proj\\src\\a.js');
    assert.deepEqual(revealed, [['ws1', 'src/a.js']]);
    await click('C:\\Users\\me\\payload.bat');
    assert.deepEqual(revealed.length, 1, 'a file outside the workspaces is not revealed');
    assert.equal(toasts.at(-1)[0].includes('payload.bat'), true, 'its path is shown instead');
    assert.deepEqual(opened, [], 'nothing is opened through a file association');
    dom.window.close();
});

test('a path outside every workspace is only read after the user asks for it', async () => {
    const dom = new JSDOM('<section id="view"></section>');
    const doc = dom.window.document;
    const reads = [];
    const provider = createCodeViewerSideProvider({ document: doc, uiHelper: null, api: {
        gitListWorkspaces: async () => ({ success: true, data: { workspaces: [{ id: 'ws1', path: 'C:\\proj' }] } }),
        sourceReadFile: async () => ({ success: true, data: { text: 'in workspace' } }),
        async getTextContent(filePath) { reads.push(filePath); return { text: 'PRIVATE KEY' }; }
    } });
    const view = doc.getElementById('view');
    const handle = await provider.mountTab({ title: 'id_rsa', payload: { filePath: 'C:\\Users\\me\\.ssh\\id_rsa' } }, view);
    try {
        assert.deepEqual(reads, [], 'nothing is read before the user agrees');
        assert.equal(handle.getCode(), '');
        assert.match(view.textContent, /\.ssh/);
        const consent = view.querySelector('[data-action="consent-read"]');
        assert.ok(consent?.textContent.trim(), 'it asks with a named button');
        consent.click();
        await waitFor(() => handle.getCode() === 'PRIVATE KEY', { message: 'consent never read the file' });
        assert.deepEqual(reads, ['C:\\Users\\me\\.ssh\\id_rsa']);

        // 工作区里的文件照常直接读
        const inside = doc.createElement('section');
        doc.body.append(inside);
        const insideHandle = await provider.mountTab({ title: 'a.js', payload: { filePath: 'C:\\proj\\a.js' } }, inside);
        assert.equal(insideHandle.getCode(), 'in workspace');
        insideHandle.dispose();
    } finally {
        handle.dispose();
        dom.window.close();
    }
});

test('code is rendered in chunks whose text and line numbers stay continuous', async () => {
    const { CODE_CHUNK_LINES } = await import('../modules/ui-system/side-pane/code-viewer/editor.js');
    const dom = new JSDOM('<section id="view"></section>');
    const doc = dom.window.document;
    const lineCount = CODE_CHUNK_LINES * 2 + 50;
    const code = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join('\n');
    const provider = createCodeViewerSideProvider({ document: doc, uiHelper: null, api: null });
    const view = doc.getElementById('view');
    const handle = await provider.mountTab({ title: 'chunks.txt', payload: { code, language: 'plaintext' } }, view);
    try {
        assert.equal(view.querySelector('.side-code-pre').textContent, code);
        assert.equal(view.querySelectorAll('.side-code-line-number').length, lineCount);
        assert.equal([...view.querySelectorAll('.side-code-line-number')].at(-1).textContent, String(lineCount));
    } finally {
        handle.dispose();
        dom.window.close();
    }
});

test('highlighted html is split per line with spans that cross lines closed and reopened', async () => {
    const { splitHighlightedLines } = await import('../modules/ui-system/side-pane/code-viewer/editor.js');
    const html = '<span class="hljs-comment">/* a\nb */</span> x\n<span class="hljs-string">`c\n<span class="hljs-subst">${d}\ne</span>`</span>';
    assert.deepEqual(splitHighlightedLines(html), [
        '<span class="hljs-comment">/* a</span>',
        '<span class="hljs-comment">b */</span> x',
        '<span class="hljs-string">`c</span>',
        '<span class="hljs-string"><span class="hljs-subst">${d}</span></span>',
        '<span class="hljs-string"><span class="hljs-subst">e</span>`</span>'
    ]);
    assert.deepEqual(splitHighlightedLines(''), ['']);
});

test('a file tab keeps its place on reload and its wrap, mode and consent after sleeping', async () => {
    const dom = new JSDOM('<section id="view"></section>');
    const doc = dom.window.document;
    const view = doc.getElementById('view');
    const text = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
    const provider = createCodeViewerSideProvider({ document: doc, uiHelper: null, api: {
        async gitListWorkspaces() { return { success: true, data: { workspaces: [{ id: 'w', path: 'C:/proj' }] } }; },
        async sourceReadFile() { return { success: false, error: 'unused' }; },
        async getTextContent() { return { text }; }
    } });
    const tab = { id: 'code-viewer:D:/logs/app.log', title: 'app.log', payload: { filePath: 'D:/logs/app.log' } };
    let handle = await provider.mountTab(tab, view);
    const body = () => view.querySelector('.side-code-body');
    assert.equal(handle.getCode(), '', 'outside the workspace it asks first');
    view.querySelector('[data-action="consent-read"]').click();
    await waitFor(() => handle.getCode() === text, { message: 'consent never read the file' });

    let shown = true;
    Object.defineProperty(body(), 'clientHeight', { configurable: true, get: () => (shown ? 400 : 0) });
    body().scrollTop = 1200;
    body().dispatchEvent(new dom.window.Event('scroll'));
    await handle.reload();
    assert.equal(body().scrollTop, 1200, 'reloading the same file stays at the same line');

    view.querySelector('[data-action="toggle-wrap"]').click();
    // 休眠时标签是隐藏的：display:none 的 body 读出来滚动是 0
    shown = false;
    body().scrollTop = 0;
    const saved = handle.captureState();
    await handle.dispose();
    handle = await provider.mountTab(tab, view, { restoredState: saved });
    try {
        assert.equal(handle.getCode(), text, 'the consent given before sleeping still holds');
        assert.equal(view.querySelector('[data-action="toggle-wrap"]').classList.contains('active'), true);
        assert.equal(view.querySelector('.side-code-editor-shell').classList.contains('is-wrapped'), true);
        assert.equal(body().scrollTop, 1200);
    } finally {
        await handle.dispose();
        dom.window.close();
    }
});

test('reloading a file that is on screen keeps it visible until the new text arrives', async () => {
    const dom = new JSDOM('<section id="view"></section>');
    const doc = dom.window.document;
    const view = doc.getElementById('view');
    let gate = null;
    const provider = createCodeViewerSideProvider({ document: doc, uiHelper: null, sidePaneController: null, api: {
        async getTextContent() { if (gate) await gate; return { text: 'line one' }; }
    } });
    const handle = await provider.mountTab({ title: 'notes.txt', payload: { filePath: 'C:/proj/notes.txt' } }, view);
    try {
        assert.match(view.querySelector('.side-code-pre').textContent, /line one/);
        const pending = Promise.withResolvers();
        gate = pending.promise;
        const reloading = handle.reload();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(view.querySelector('.side-code-loading'), null, 'no one-line loading row in place of the file');
        assert.ok(view.querySelector('.side-code-pre'), 'the file stays up while it is re-read');
        pending.resolve();
        await reloading;
        assert.match(view.querySelector('.side-code-pre').textContent, /line one/);
    } finally {
        handle.dispose();
        dom.window.close();
    }
});
