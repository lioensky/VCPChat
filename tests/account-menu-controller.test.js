const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { AccountMenuController } = require('../modules/ui-system/next-shell/account-menu-controller.js');

function fixture() {
    const dom = new JSDOM(`<!doctype html><body class="dark-theme">
      <div class="next-ui-account-dock"><button id="nextUiAccountMenuTrigger"></button><img id="nextUiAccountAvatar"><span id="nextUiAccountName"></span></div>
      <div id="nextUiAccountMenu" role="menu" hidden><button id="nextUiAccountSettingsBtn"></button><button id="nextUiAccountAppearanceStudioBtn" role="menuitem"></button><button id="nextUiAccountThemeStoreBtn" role="menuitem"></button><button id="nextUiAccountThemeToggleBtn" role="menuitem"><span id="nextUiAccountThemeIcon"></span><span id="nextUiAccountThemeLabel"></span></button></div>
      <button id="nextUiThemeBtn"><span class="vcp-ui-icon"></span></button>
    </body>`, { url: 'http://vcpchat.local/' });
    const calls = [];
    const controller = new AccountMenuController({
        window: dom.window,
        document: dom.window.document,
        getSettings: () => ({ userName: 'Nova', userAvatarUrl: 'nova.png' }),
        openSettings: () => calls.push('settings'),
        openAppearance: () => calls.push('appearance'),
        openThemes: () => calls.push('themes'),
        setThemeMode: mode => { calls.push(`theme:${mode}`); return true; },
        setIcon: (element, icon) => { element.textContent = icon; },
    });
    return { dom, calls, controller };
}

test('account menu synchronizes identity/theme and owns dismissal behavior', () => {
    const { dom, calls, controller } = fixture();
    assert.equal(controller.mount(), true);
    const document = dom.window.document;
    document.getElementById('nextUiAccountMenuTrigger').click();
    assert.equal(document.getElementById('nextUiAccountMenu').hidden, false);
    assert.equal(document.activeElement.id, 'nextUiAccountAppearanceStudioBtn');
    document.getElementById('nextUiAccountMenu').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(document.activeElement.id, 'nextUiAccountThemeStoreBtn');
    document.getElementById('nextUiAccountMenu').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.equal(document.activeElement.id, 'nextUiAccountThemeToggleBtn');
    assert.equal(document.getElementById('nextUiAccountName').textContent, 'Nova');
    assert.equal(document.getElementById('nextUiAccountThemeLabel').textContent, '切换为浅色模式');
    document.getElementById('nextUiAccountThemeToggleBtn').click();
    assert.deepEqual(calls, ['theme:light']);
    controller.open();
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(document.getElementById('nextUiAccountMenu').hidden, true);
    controller.open();
    document.dispatchEvent(new dom.window.CustomEvent('next-ui-overlay-changed', { detail: { active: true } }));
    assert.equal(document.getElementById('nextUiAccountMenu').hidden, true);
    controller.dispose();
    document.getElementById('nextUiAccountMenuTrigger').click();
    assert.equal(document.getElementById('nextUiAccountMenu').hidden, true);
});
