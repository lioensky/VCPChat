const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

test('desktop adapter preserves custom icons and releases removed artwork', async () => {
    const dom = new JSDOM('<body><div id="desktop-canvas"></div><div id="desktop-dock-items"></div><div id="desktop-dock-drawer"></div></body>', { runScripts: 'outside-only' });
    const w = dom.window;
    const owners = [];
    let frozen = false;
    w.VCPDesktop = { visibilityFreezer: { isFrozen: () => frozen } };
    w.VCPNextShell = { LaunchpadIcons: class {
        constructor() { this.detached = []; owners.push(this); }
        attach(button, host) { host.append(w.document.createElement('canvas')); return true; }
        detach(host) { this.detached.push(host); }
        setActive(value) { this.active = value; }
        dispose() { this.disposed = true; }
    } };
    w.eval(fs.readFileSync('Desktopmodules/ui/livingIcons.js', 'utf8'));
    const api = w.VCPDesktop.livingIcons;
    const item = { type: 'vchat-app', appAction: 'open-notes-window', icon: '../assets/iconset/VChatOfficial/人类笔记.png' };
    assert.equal(api.keyFor(item), 'notes');
    for (const patch of [{ icon: 'data:image/png;base64,abc' }, { icon: 'file:///custom.png' }, { htmlIcon: '<b>custom</b>' }, { type: 'shortcut' }, { animatedIcon: 'custom.gif' }]) {
        assert.equal(api.keyFor({ ...item, ...patch }), null);
    }
    const button = w.document.createElement('div');
    button.innerHTML = '<img>';
    w.document.getElementById('desktop-dock-items').append(button);
    assert.equal(api.attach(button, item, 'dock', 'desktop-dock-icon-svg'), true);
    assert.equal(button.querySelector('img'), null);
    assert.equal(owners[0].active, true);
    frozen = true;
    api.sync();
    assert.equal(owners[0].active, false);
    frozen = false;
    const card = w.document.createElement('div');
    card.innerHTML = '<img>';
    w.document.getElementById('desktop-dock-drawer').append(card);
    api.attach(card, item, 'drawer', 'desktop-dock-drawer-item-svg');
    assert.equal(owners[1].active, false);
    w.document.getElementById('desktop-dock-drawer').classList.add('open');
    await Promise.resolve();
    assert.equal(owners[1].active, true);
    const host = button.firstElementChild;
    button.remove();
    await Promise.resolve();
    assert.deepEqual(owners[0].detached, [host]);
    api.release(card);
    assert.equal(card.children.length, 0);
    api.dispose();
    assert.ok(owners.every(owner => owner.disposed));
    dom.window.close();
});