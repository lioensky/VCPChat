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
    assert.equal(tab.getAttribute('aria-selected'), 'true');
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
    tabs[1].focus();
    tabs[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(document.activeElement, tabs[2]);
    tabs[2].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(document.activeElement, tabs[0]);
    tabs[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.equal(document.activeElement, tabs[2]);
    tabs[2].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.equal(document.activeElement, tabs[0]);
    host.dispose();
});
