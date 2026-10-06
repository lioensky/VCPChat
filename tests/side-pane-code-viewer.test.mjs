import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createCodeViewerSideProvider } from '../modules/ui-system/side-pane/codeViewerSideProvider.js';
import * as SidePaneState from '../modules/ui-system/side-pane/side-pane-state.js';
import { installMainComposer } from './helpers/main-composer.mjs';

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
        assert.equal(view.querySelectorAll('.side-diff-row').length, 500);
        const more = [...view.querySelectorAll('button')].find(button => button.textContent.includes('显示更多行'));
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
        assert.equal(view.querySelector('.side-code-lang-tag').textContent, 'TS');
        const picker = view.querySelector('.side-code-picker');
        const toggle = view.querySelector('[aria-label="选择文件"]');
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
