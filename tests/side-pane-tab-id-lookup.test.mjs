import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { findByTabId } from '../modules/ui-system/side-pane/side-pane-tab-utils.js';

// 代码查看器的标签 id 是 code-viewer:<文件路径>，Windows 路径带反斜杠，类 Unix 路径可以带引号
const WINDOWS_ID = 'code-viewer:C:\\Users\\roxy\\proj\\a.js';
const QUOTED_ID = 'code-viewer:/tmp/we"ird.js';

function createPaneDom() {
    const dom = new JSDOM(`
        <div class="main-content"></div>
        <div class="resizer" id="resizerRight"></div>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar"><div class="side-pane-tabs"></div></header>
            <div class="side-pane-content-container"></div>
        </aside>
    `, { pretendToBeVisual: true });
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    return {
        dom,
        doc,
        root,
        options: {
            root,
            resizerHandle: doc.getElementById('resizerRight'),
            tabListElement: root.querySelector('.side-pane-tabs'),
            contentContainer: root.querySelector('.side-pane-content-container')
        }
    };
}

test('findByTabId matches ids with backslashes and quotes literally', () => {
    const { dom, doc } = createPaneDom();
    for (const id of [WINDOWS_ID, QUOTED_ID]) {
        const el = doc.createElement('button');
        el.setAttribute('data-tab-id', id);
        doc.body.append(el);
        assert.equal(findByTabId(doc.body, id), el);
    }
    assert.equal(findByTabId(doc.body, 'code-viewer:C:Usersroxyproja.js'), null);
    dom.window.close();
});

for (const id of [WINDOWS_ID, QUOTED_ID]) {
    test(`a tab whose id is ${JSON.stringify(id)} mounts and takes keyboard focus when cycled to`, async () => {
        const { dom, doc, root, options } = createPaneDom();
        const controller = createSidePaneController({
            ...options,
            providers: {
                probe: { mountTab(tab, view) { view.textContent = tab.title; return { focus() {}, dispose() {} }; } }
            }
        });
        try {
            await controller.openTab({ id: 'other', kind: 'probe', title: 'Other', closable: true, scopeMode: 'global' });
            await controller.openTab({ id, kind: 'probe', title: 'a.js', closable: true, scopeMode: 'global' });
            assert.equal(findByTabId(root.querySelector('.side-pane-content-container'), id)?.textContent, 'a.js');

            controller.activateTab('other');
            controller.cycleTab(1);
            assert.equal(controller.getSnapshot().activeTabId, id);
            assert.equal(doc.activeElement?.getAttribute('data-tab-id'), id, 'focus lands on the tab, not on <body>');
        } finally {
            await controller.dispose();
            dom.window.close();
        }
    });
}
