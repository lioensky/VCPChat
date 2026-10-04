import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { matchesToggleSidePane, matchesCycleTab } from '../modules/ui-system/side-pane/side-pane-shortcuts.js';

const key = (init) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...init });

test('toggle shortcut is Ctrl+Alt+B (Cmd+Alt+B on macOS) and ignores AltGr and repeats', () => {
    assert.equal(matchesToggleSidePane(key({ ctrlKey: true, altKey: true, code: 'KeyB' })), true);
    assert.equal(matchesToggleSidePane(key({ metaKey: true, altKey: true, code: 'KeyB' }), { mac: true }), true);
    assert.equal(matchesToggleSidePane(key({ metaKey: true, altKey: true, code: 'KeyB' })), false);
    assert.equal(matchesToggleSidePane(key({ ctrlKey: true, code: 'KeyB' })), false);
    assert.equal(matchesToggleSidePane(key({ ctrlKey: true, altKey: true, shiftKey: true, code: 'KeyB' })), false);
    assert.equal(matchesToggleSidePane(key({ ctrlKey: true, altKey: true, code: 'KeyB', repeat: true })), false);
    assert.equal(matchesToggleSidePane(key({
        ctrlKey: true, altKey: true, code: 'KeyB', getModifierState: name => name === 'AltGraph'
    })), false);
});

test('cycle shortcut is Ctrl+PageUp / Ctrl+PageDown', () => {
    assert.equal(matchesCycleTab(key({ ctrlKey: true, key: 'PageDown' })), 1);
    assert.equal(matchesCycleTab(key({ ctrlKey: true, key: 'PageUp' })), -1);
    assert.equal(matchesCycleTab(key({ key: 'PageUp' })), 0);
    assert.equal(matchesCycleTab(key({ ctrlKey: true, shiftKey: true, key: 'PageUp' })), 0);
});

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
                    view.appendChild(input);
                    return { focus: () => input.focus(), dispose() {} };
                }
            }
        }]
    });
    const press = (target, init) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    return { dom, doc, root, controller, press };
}

const notesTab = id => ({ id, kind: 'notes', title: id, closable: true, scopeMode: 'global' });

test('Ctrl+Alt+B collapses the pane and expands it back onto the last tab', async () => {
    const { dom, doc, controller, press } = setup();
    controller.setParent({ itemType: 'agent', itemId: 'agent-1', topicId: 'topic-1' });
    await controller.openTab(notesTab('n1'));
    await controller.openTab(notesTab('n2'));
    controller.activateTab('n1');
    const input = doc.getElementById('messageInput');
    input.focus();

    const event = press(input, { ctrlKey: true, altKey: true, code: 'KeyB', key: 'b' });
    assert.equal(event, false, 'the shortcut is consumed');
    assert.equal(controller.getSnapshot().visible, false);
    assert.equal(doc.activeElement, input, 'collapsing from the keyboard keeps the caret');

    press(input, { ctrlKey: true, altKey: true, code: 'KeyB', key: 'b' });
    assert.equal(controller.getSnapshot().visible, true);
    assert.equal(controller.getSnapshot().activeTabId, 'n1');

    await controller.dispose();
    press(input, { ctrlKey: true, altKey: true, code: 'KeyB', key: 'b' });
    assert.equal(controller.getSnapshot().visible, true, 'disposed controller no longer listens');
    dom.window.close();
});

test('Ctrl+PageDown cycles tabs only while focus is inside the pane', async () => {
    const { dom, doc, root, controller, press } = setup();
    await controller.openTab(notesTab('n1'));
    await controller.openTab(notesTab('n2'));
    const tabs = () => controller.getSnapshot().activeTabId;

    const input = doc.getElementById('messageInput');
    input.focus();
    press(input, { ctrlKey: true, key: 'PageDown' });
    assert.equal(tabs(), 'n2', 'focus outside the pane: no change');

    const inside = root.querySelector('.side-pane-view[data-tab-id="n2"] input');
    inside.focus();
    press(inside, { ctrlKey: true, key: 'PageDown' });
    assert.equal(tabs(), 'notifications', 'wraps around to the first strip tab');
    press(doc.activeElement, { ctrlKey: true, key: 'PageUp' });
    assert.equal(tabs(), 'n2');

    await controller.dispose();
    dom.window.close();
});
