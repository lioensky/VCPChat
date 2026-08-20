const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { AppTabHost } = require('../modules/ui-system/next-shell/app-tab-host.js');
global.VCPSettlement = require('../modules/ui-system/settlement.js');

function fixture() {
    const dom = new JSDOM(`<!doctype html><body>
      <button id="nextUiHomeTab"></button><button id="nextUiAddTabBtn"></button>
      <div id="nextUiDynamicTabs"></div><div id="nextUiLaunchpad"></div>
      <main id="nextUiInternalAppHost"></main>
    </body>`, { url: 'http://vcpchat.local/' });
    const activations = [];
    const closes = [];
    const host = new AppTabHost({
        document: dom.window.document,
        storage: dom.window.sessionStorage,
        onActivate: id => activations.push(id),
        onCloseRequested: id => closes.push(id),
    });
    host.mount();
    return { dom, host, activations, closes };
}

test('tab host owns registration, activation, accessibility and persistence', () => {
    const { dom, host, activations } = fixture();
    const container = dom.window.document.createElement('section');
    dom.window.document.getElementById('nextUiInternalAppHost').append(container);
    const tab = host.createTab({ id: 'app:notes', title: '笔记' });
    host.register('app:notes', { kind: 'internal', app: { id: 'notes' }, tab, container });
    host.setView('app:notes');
    assert.equal(host.activeViewId, 'app:notes');
    assert.equal(tab.querySelector('[role="tab"]')?.getAttribute('aria-selected'), 'true');
    assert.equal(tab.querySelector('[role="tab"]')?.getAttribute('aria-controls'), container.id);
    assert.equal(container.getAttribute('role'), 'tabpanel');
    assert.equal(container.hidden, false);
    assert.equal(activations.at(-1), 'app:notes');
    assert.deepEqual(host.readSession(), {
        activeViewId: 'app:notes',
        tabs: [{ kind: 'internal', id: 'notes' }],
    });
    host.unregister('app:notes');
    assert.equal(host.activeViewId, 'home');
    assert.equal(tab.isConnected, false);
    host.dispose();
});

test('close control requests closure without mutating the registry', () => {
    const { dom, host, closes } = fixture();
    const container = dom.window.document.createElement('section');
    dom.window.document.getElementById('nextUiInternalAppHost').append(container);
    const tab = host.createTab({ id: 'app:translator', title: '翻译' });
    host.register('app:translator', { kind: 'embedded', app: { id: 'translator' }, tab, container });
    tab.querySelector('.next-ui-tab-close').click();
    assert.deepEqual(closes, ['app:translator']);
    assert.equal(host.views.has('app:translator'), true, 'business owner decides when cleanup has completed');
    host.dispose();
});

test('tab host settlement observes a requested mutation revision without timers', async () => {
    const { host } = fixture();
    const boundary = host.getSnapshot().revision + 1;
    const pending = host.whenSettled({ afterRevision: boundary });
    host.setView('launchpad');
    const snapshot = await pending;
    assert.equal(snapshot.revision, boundary);
    assert.equal(snapshot.activeViewId, 'launchpad');
});

test('dynamic tabs support directional, Home and End keyboard focus', () => {
    const { dom, host } = fixture();
    const document = dom.window.document;
    const tabs = ['notes', 'translator', 'forum'].map(id => {
        const container = document.createElement('section');
        document.getElementById('nextUiInternalAppHost').append(container);
        const tab = host.createTab({ id: `app:${id}`, title: id });
        host.register(`app:${id}`, { kind: 'internal', app: { id }, tab, container });
        return tab;
    });
    const buttons = tabs.map(tab => tab.querySelector('[role="tab"]'));
    buttons[1].focus();
    buttons[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(document.activeElement, buttons[2]);
    buttons[2].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(document.activeElement, buttons[0]);
    buttons[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.equal(document.activeElement, buttons[2]);
    buttons[2].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.equal(document.activeElement, buttons[0]);
    host.dispose();
});

test('launchpad is inert while closed so dynamic app buttons cannot receive focus', () => {
    const dom = new JSDOM('<!doctype html><body><button id="nextUiHomeTab"></button><button id="nextUiAddTabBtn"></button><section id="nextUiLaunchpad"><div id="nextUiLaunchpadInner"></div></section><div id="nextUiInternalAppHost"></div><div id="nextUiDynamicTabs"></div></body>', { url: 'http://vcpchat.local/' });
    const host = new AppTabHost({ document: dom.window.document, storage: dom.window.sessionStorage });
    host.mount();
    host.setView('home');
    assert.equal(dom.window.document.getElementById('nextUiLaunchpad').inert, true);
    host.setView('launchpad');
    assert.equal(dom.window.document.getElementById('nextUiLaunchpad').inert, false);
    host.dispose();
});

test('closing the active tab restores focus to the adjacent tab or home', () => {
    const dom = new JSDOM('<!doctype html><body><button id="nextUiHomeTab"></button><button id="nextUiAddTabBtn"></button><section id="nextUiLaunchpad"></section><div id="nextUiInternalAppHost"></div><div id="nextUiDynamicTabs"></div></body>', { url: 'http://vcpchat.local/' });
    const host = new AppTabHost({ document: dom.window.document, storage: dom.window.sessionStorage });
    host.mount();
    const container = dom.window.document.createElement('section');
    const tab = host.createTab({ id: 'app:notes', title: '笔记', scope: null });
    host.register('app:notes', { app: { id: 'notes' }, tab, container });
    host.setView('app:notes');
    tab.querySelector('[role="tab"]').focus();
    host.unregister('app:notes');
    assert.equal(dom.window.document.activeElement.id, 'nextUiHomeTab');
    host.dispose();
});
