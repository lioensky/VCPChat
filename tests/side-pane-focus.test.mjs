import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';

function setup() {
    const dom = new JSDOM(`
        <div class="main-content"><textarea id="messageInput"></textarea><button id="expand">展开</button></div>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar"><div class="side-pane-tabs"></div></header>
            <div class="side-pane-content-container"></div>
        </aside>
    `);
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const controller = createSidePaneController({
        root,
        tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container'),
        expandButton: doc.getElementById('expand'),
        tabTypes: [{
            kind: 'notes',
            label: '笔记',
            provider: {
                mountTab(payload, view) {
                    const input = doc.createElement('input');
                    input.className = 'notes-input';
                    view.appendChild(input);
                    return { focus: () => input.focus(), dispose() {} };
                }
            }
        }]
    });
    const input = doc.getElementById('messageInput');
    return { dom, doc, root, controller, input };
}

const notesTab = id => ({ id, kind: 'notes', title: id, closable: true, scopeMode: 'global' });

test('hiding the pane leaves focus alone when it is outside the pane', async () => {
    const { dom, doc, controller, input } = setup();
    await controller.openTab(notesTab('n1'));
    input.focus();

    controller.setVisible(false);
    assert.equal(doc.activeElement, input);

    await controller.dispose();
    dom.window.close();
});

test('hiding the pane from inside returns focus to where it was before the pane opened', async () => {
    const { dom, doc, root, controller, input } = setup();
    input.focus();
    await controller.openTab(notesTab('n1'));
    assert.ok(root.contains(doc.activeElement), 'opening a tab focuses its view');

    controller.setVisible(false);
    assert.equal(doc.activeElement, input);

    await controller.dispose();
    dom.window.close();
});

test('falls back to the expand button when the origin element is gone', async () => {
    const { dom, doc, controller, input } = setup();
    input.focus();
    await controller.openTab(notesTab('n1'));
    input.remove();

    controller.setVisible(false);
    assert.equal(doc.activeElement, doc.getElementById('expand'));

    await controller.dispose();
    dom.window.close();
});

test('closing a tab only moves focus to the tab strip when focus was in the pane', async () => {
    const { dom, doc, root, controller, input } = setup();
    await controller.openTab(notesTab('n1'));
    await controller.openTab(notesTab('n2'));

    input.focus();
    await controller.closeTab('n2');
    assert.equal(doc.activeElement, input, 'background close keeps the caret in the main input');

    await controller.openTab(notesTab('n3'));
    assert.ok(root.contains(doc.activeElement));
    await controller.closeTab('n3');
    assert.ok(root.contains(doc.activeElement), 'focus stays in the pane on the next tab');

    await controller.dispose();
    dom.window.close();
});

test('closing the last tab collapses the pane and returns focus to its origin', async () => {
    const { dom, doc, controller, input } = setup();
    input.focus();
    await controller.openTab(notesTab('n1'));

    await controller.closeTab('n1');
    assert.equal(controller.getSnapshot().visible, false);
    assert.equal(doc.activeElement, input);

    await controller.dispose();
    dom.window.close();
});
