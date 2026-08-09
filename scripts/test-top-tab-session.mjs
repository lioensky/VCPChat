import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await fs.readFile(new URL('../modules/topTabManager.js', import.meta.url), 'utf8');

function createWindow(savedSession = null) {
    const dom = new JSDOM(`<!doctype html><html><body>
        <header id="nextUiTopbar"><div id="nextUiDynamicTabs"></div></header>
        <button id="nextUiHomeTab"></button><button id="nextUiAddTabBtn"></button>
        <section id="nextUiLaunchpad"><div id="nextUiAppGrid"></div></section>
        <main class="container"></main>
    </body></html>`, { url: 'https://vcpchat.local/main.html', runScripts: 'dangerously' });
    const { window } = dom;
    if (savedSession) window.sessionStorage.setItem('vcpchat.nextUi.openTabs.v1', savedSession);
    const apps = new Map([
        ['alpha', { id: 'alpha', title: 'Alpha', icon: 'draft', mount: () => null }],
        ['beta', { id: 'beta', title: 'Beta', icon: 'folder', mount: () => null }],
    ]);
    window.nextUiApps = { get: id => apps.get(id), list: () => [...apps.values()] };
    window.trayManager = { getApps: () => [], getIcon: () => '' };
    window.VCPUI = { feedback: { cancelAll() {} } };
    window.chatAPI = {};
    window.eval(source);
    return { dom, window };
}

const first = createWindow();
first.window.topTabManager.init();
first.window.topTabManager.openInternalApp('alpha');
first.window.topTabManager.openInternalApp('beta');
const savedSession = first.window.sessionStorage.getItem('vcpchat.nextUi.openTabs.v1');
assert.ok(savedSession, 'open tabs must be recorded in page session storage');
first.dom.window.close();

const second = createWindow(savedSession);
second.window.topTabManager.init();
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(
    [...second.window.document.querySelectorAll('#nextUiDynamicTabs > .next-ui-tab')].map(tab => tab.dataset.viewId),
    ['app:alpha', 'app:beta'],
    'renderer reload must restore open internal application tabs in order',
);
assert.equal(
    second.window.document.querySelector('#nextUiDynamicTabs > .next-ui-tab.active')?.dataset.viewId,
    'app:beta',
    'renderer reload must restore the active application tab',
);
second.dom.window.close();

console.log('Top tab renderer-reload session restoration tests passed.');
