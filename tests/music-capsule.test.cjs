const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync('main.html', 'utf8');
const script = fs.readFileSync('modules/ui-system/music-capsule.js', 'utf8');
function fixture() {
    const source = new JSDOM(html);
    const markup = source.window.document.querySelector('.music-capsule').outerHTML;
    source.window.close();
    const dom = new JSDOM(markup, { runScripts: 'outside-only' });
    let listener, resolve;
    const commands = [], timers = new Map();
    let id = 0, unsubscribed = false;
    dom.window.setTimeout = callback => { timers.set(++id, callback); return id; };
    dom.window.clearTimeout = key => timers.delete(key);
    dom.window.electronAPI = {
        onMusicCapsuleState(callback) { listener = callback; return () => { unsubscribed = true; }; },
        getMusicCapsuleState() { return new Promise(r => { resolve = r; }); },
        sendMusicCapsuleCommand(command) { commands.push(command); }
    };
    dom.window.eval(script);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    return {
        dom, root: dom.window.document.querySelector('.music-capsule'), commands, timers,
        push: state => listener(state), resolve: state => resolve(state),
        get unsubscribed() { return unsubscribed; }
    };
}
test('window lifecycle, safe title, hover, controls and cleanup', async () => {
    const f = fixture();
    f.resolve({ open: false });
    await Promise.resolve();
    assert.equal(f.root.hidden, true);
    f.push({ open: true, title: '<img src=x>', trackKey: 'a', playing: true });
    assert.equal(f.root.hidden, false);
    assert.equal(f.root.querySelector('.music-capsule-title').textContent, '<img src=x>');
    assert.equal(f.root.querySelector('img'), null);
    assert.equal(f.root.classList.contains('is-expanded'), true);
    f.root.querySelector('[data-music-command="toggle"]').click();
    f.root.querySelector('[data-music-command="previous"]').click();
    f.root.querySelector('[data-music-command="next"]').click();
    assert.deepEqual(f.commands, ['pause', 'previous', 'next']);
    f.root.querySelector('.music-capsule-surface').dispatchEvent(new f.dom.window.Event('mouseenter'));
    [...f.timers.values()].forEach(fn => fn());
    assert.equal(f.root.classList.contains('is-expanded'), true);
    f.root.querySelector('.music-capsule-surface').dispatchEvent(new f.dom.window.Event('mouseleave'));
    assert.equal(f.root.classList.contains('is-expanded'), false);
    f.push({ open: true, title: 'b', trackKey: 'b', playing: false });
    assert.equal(f.root.classList.contains('is-expanded'), true);
    f.push({ open: false });
    assert.equal(f.root.hidden, true);
    assert.equal(f.timers.size, 0);
    f.dom.window.dispatchEvent(new f.dom.window.Event('beforeunload'));
    assert.equal(f.unsubscribed, true);
    f.dom.window.close();
});
test('late initial snapshot cannot overwrite live push', async () => {
    const f = fixture();
    f.push({ open: true, title: 'fresh', trackKey: 'fresh', playing: true });
    f.resolve({ open: false });
    await Promise.resolve();
    assert.equal(f.root.hidden, false);
    assert.equal(f.root.querySelector('.music-capsule-title').textContent, 'fresh');
    f.dom.window.close();
});
test('player snapshot deduplicates state and gapless path publishes', () => {
    const context = { console, setInterval, clearInterval };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync('Musicmodules/music-player.js', 'utf8'), context);
    const sent = [];
    const app = {
        playlist: [{ path: 'a', title: 'A' }], currentTrackIndex: 0, isPlaying: true,
        stripAudioExtension: s => s, normalizePathForCompare: s => s,
        api: { publishMusicCapsuleState: state => sent.push(state) }
    };
    context.setupPlayer(app);
    app.publishCapsuleState();
    app.publishCapsuleState();
    assert.equal(sent.length, 1);
    app.isPlaying = false;
    app.publishCapsuleState();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].playing, false);
    app.syncTrackIndexByPath('missing');
    assert.equal(sent.length, 2);
});
test('sidebar mode toast removed and capsule IPC validates publishers and commands', () => {
    assert.doesNotMatch(fs.readFileSync('modules/event-listeners.js', 'utf8'), /侧栏已切换|侧栏已恢复/);
    const handlers = fs.readFileSync('modules/ipc/musicHandlers.js', 'utf8');
    assert.match(handlers, /event.sender !== musicWindow.webContents/);
    assert.match(handlers, /event.sender !== mainWindow.webContents/);
    assert.match(handlers, /\['previous', 'next', 'play', 'pause'\]\.includes\(command\)/);
});