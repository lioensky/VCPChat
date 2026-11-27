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
    vm.runInContext(fs.readFileSync('Musicmodules/music-app-hooks.js', 'utf8'), context);
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
    // 引擎切进了曲库里没有的歌：不发布它，交给「下一首」接上
    let advanced = 0;
    app.nextTrack = () => { advanced++; };
    app.syncTrackIndexByPath('missing');
    assert.equal(sent.length, 2);
    assert.equal(advanced, 1);
});
test('sidebar mode toast removed and capsule IPC validates publishers and commands', () => {
    assert.doesNotMatch(fs.readFileSync('modules/event-listeners.js', 'utf8'), /侧栏已切换|侧栏已恢复/);
    const handlers = fs.readFileSync('modules/ipc/musicHandlers.js', 'utf8');
    assert.match(handlers, /event.sender !== musicWindow.webContents/);
    assert.match(handlers, /event.sender !== mainWindow.webContents/);
    assert.match(handlers, /\['previous', 'next', 'play', 'pause'\]\.includes\(command\)/);
});

test('ResizeObserver watches capsule parent instead of root itself', () => {
    const source = new JSDOM(html);
    const markup = source.window.document.querySelector('.music-capsule').outerHTML;
    source.window.close();
    const dom = new JSDOM(`<div id="slot">${markup}</div>`, { runScripts: 'outside-only' });
    const observed = [];
    dom.window.ResizeObserver = class {
        observe(el) { observed.push(el); }
        disconnect() {}
    };
    dom.window.electronAPI = {
        onMusicCapsuleState: () => () => {},
        getMusicCapsuleState: () => Promise.resolve({ open: false }),
        sendMusicCapsuleCommand: () => {}
    };
    dom.window.eval(script);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    const root = dom.window.document.querySelector('.music-capsule');
    assert.equal(observed.length, 1);
    assert.notEqual(observed[0], root, 'must not observe root itself during width transitions');
    assert.equal(observed[0], dom.window.document.getElementById('slot'));
    dom.window.close();
});

test('capsule ignores Escape while IME is composing', () => {
    const f = fixture();
    f.push({ open: true, title: 'Song', trackKey: 'k1', playing: true });
    assert.equal(f.root.classList.contains('is-expanded'), true);
    f.root.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }));
    assert.equal(f.root.classList.contains('is-expanded'), true, 'composing Escape must not collapse capsule');
    f.root.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', isComposing: false, bubbles: true }));
    assert.equal(f.root.classList.contains('is-expanded'), false);
    f.dom.window.close();
});