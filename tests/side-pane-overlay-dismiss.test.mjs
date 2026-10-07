import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { waitFor } from './helpers/wait-for.mjs';

// 窗口窄到面板浮在对话上时，点对话区收起面板（像抽屉）；点的东西自己打开了标签就不收
function setup(t, { narrow }) {
    const dom = new JSDOM('<main class="main-content"><p id="chat">message</p><button id="openSide">副屏</button><textarea id="mainInput"></textarea></main>'
        + '<aside id="pane"><div id="tabs"></div><div id="content"><section class="side-pane-view" id="sidePaneViewNotifications"></section></div></aside>');
    const win = dom.window, doc = win.document;
    win.matchMedia = query => ({ matches: narrow && query === '(max-width: 960px)', media: query });
    // 每个标签里有一个按钮和一个输入框
    const provider = { mountTab: async (_tab, container) => {
        container.insertAdjacentHTML('beforeend', '<button class="tab-button">run</button><input class="tab-input">');
        return { dispose: async () => {}, focus() { container.querySelector('.tab-button').focus(); } };
    } };
    const controller = createSidePaneController({
        root: doc.getElementById('pane'), tabListElement: doc.getElementById('tabs'), contentContainer: doc.getElementById('content'),
        tabTypes: [{ kind: 'note', label: 'note', icon: 'x', provider }]
    });
    doc.getElementById('openSide').addEventListener('click', () => {
        void controller.openTab({ id: 'code', kind: 'note', title: 'Code', closable: true, scopeMode: 'global' });
    });
    t.after(async () => { await controller.dispose(); win.close(); });
    // 点击之后的收起排在这次点击处理完之后
    const afterClick = () => new Promise(resolve => setTimeout(resolve, 0));
    const escape = target => target.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return { doc, controller, afterClick, escape };
}

const note = id => ({ id, kind: 'note', title: id, closable: true, scopeMode: 'global' });

test('in the narrow overlay layout, clicking the conversation collapses the pane', async t => {
    const env = setup(t, { narrow: true });
    await env.controller.openTab(note('a'));
    assert.equal(env.controller.getSnapshot().visible, true);
    env.doc.getElementById('chat').click();
    await waitFor(() => env.controller.getSnapshot().visible === false, { message: 'the overlay stayed over the conversation' });
});

test('clicking something in the conversation that opens a side tab keeps the pane open on it', async t => {
    const env = setup(t, { narrow: true });
    await env.controller.openTab(note('a'));
    env.doc.getElementById('openSide').click();
    await env.afterClick();
    await env.afterClick();
    assert.equal(env.controller.getSnapshot().visible, true);
    assert.equal(env.controller.getSnapshot().activeTabId, 'code');
});

test('when the pane sits beside the conversation, clicking the conversation leaves it open', async t => {
    const env = setup(t, { narrow: false });
    await env.controller.openTab(note('a'));
    env.doc.getElementById('chat').click();
    await env.afterClick();
    await env.afterClick();
    assert.equal(env.controller.getSnapshot().visible, true);
});

test('in the narrow overlay layout, Escape collapses the pane and focus goes back where it was', async t => {
    const env = setup(t, { narrow: true });
    const mainInput = env.doc.getElementById('mainInput');
    mainInput.focus();
    await env.controller.openTab(note('a'), { focus: true });
    const button = env.doc.querySelector('.tab-button');
    button.focus();
    env.escape(button);
    assert.equal(env.controller.getSnapshot().visible, false);
    assert.equal(env.doc.activeElement, mainInput);
});

test('Escape meant for a field, or already handled inside the pane, leaves the overlay open', async t => {
    const env = setup(t, { narrow: true });
    await env.controller.openTab(note('a'));
    env.escape(env.doc.querySelector('.tab-input'));
    env.escape(env.doc.getElementById('mainInput'));
    env.doc.querySelector('.tab-button').addEventListener('keydown', event => event.preventDefault());
    env.escape(env.doc.querySelector('.tab-button'));
    assert.equal(env.controller.getSnapshot().visible, true);
});

test('when the pane sits beside the conversation, Escape leaves it open', async t => {
    const env = setup(t, { narrow: false });
    await env.controller.openTab(note('a'));
    env.escape(env.doc.querySelector('.tab-button'));
    assert.equal(env.controller.getSnapshot().visible, true);
});
