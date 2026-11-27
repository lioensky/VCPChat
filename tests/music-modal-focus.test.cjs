// 弹窗的焦点管理：关着的弹窗设 inert（不进 Tab 顺序），开着的才能点。
// WebDAV 的两个弹窗用 active 类打开，以前只认 visible，WebDAV 弹窗一开就是 inert：看得见，点什么都没反应，连关闭钮都点不了。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function setup() {
    const html = fs.readFileSync('Musicmodules/music.html', 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    window.Element.prototype.getClientRects = function () { return [{}]; };
    window.eval(fs.readFileSync('Musicmodules/music-modal-focus.js', 'utf8'));
    return { dom, window, doc: window.document };
}
const tick = (w) => new Promise((r) => w.setTimeout(r, 0));

for (const [id, cls] of [['webdav-modal', 'active'], ['webdav-server-dialog', 'active'], ['playlist-edit-modal', 'visible'], ['lyrics-fetch-modal', 'visible'], ['playlist-dialog', 'visible']]) {
    test(`#${id} opened with .${cls} can be used, and goes inert again when closed`, async () => {
        const { dom, window, doc } = setup();
        await tick(window);
        const o = doc.getElementById(id);
        assert.equal(o.inert, true, 'closed: out of the tab order');
        o.classList.add(cls);
        await tick(window);
        assert.equal(o.inert, false, 'open: clickable and focusable');
        assert.ok(o.contains(doc.activeElement), 'focus moves into the dialog');
        o.classList.remove(cls);
        await tick(window);
        assert.equal(o.inert, true);
        dom.window.close();
    });
}

test('Esc closes the top dialog through its own close or cancel button', async () => {
    const { dom, window, doc } = setup();
    await tick(window);
    const list = doc.getElementById('webdav-modal');
    const add = doc.getElementById('webdav-server-dialog');
    const clicks = [];
    doc.getElementById('webdav-modal-close').addEventListener('click', () => { clicks.push('list'); list.classList.remove('active'); });
    doc.getElementById('webdav-dialog-cancel').addEventListener('click', () => { clicks.push('add'); add.classList.remove('active'); });
    list.classList.add('active');
    add.classList.add('active');
    await tick(window);
    const esc = () => doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    esc();
    assert.deepEqual(clicks, ['add'], 'only the dialog on top closes');
    await tick(window);
    esc();
    assert.deepEqual(clicks, ['add', 'list']);
    const composing = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true });
    list.classList.add('active'); await tick(window);
    doc.activeElement.dispatchEvent(composing);
    assert.deepEqual(clicks, ['add', 'list'], 'Esc for the input method does not close');
    dom.window.close();
});

test('closing the playlist editor re-renders the list, and focus still lands on that playlist\'s edit button', async () => {
    const { dom, window, doc } = setup();
    await tick(window);
    const view = doc.getElementById('sidebar-category-view');
    const render = () => { view.innerHTML = ['a', 'b', 'c'].map((n) => `<div class="category-item"><button class="edit-btn">${n}</button></div>`).join(''); };
    render();
    const modal = doc.getElementById('playlist-edit-modal');
    view.querySelectorAll('.edit-btn')[1].focus();
    modal.classList.add('visible');
    await tick(window);
    assert.ok(modal.contains(doc.activeElement));
    modal.classList.remove('visible');
    render(); // music.js 关弹窗时会重画侧栏歌单列表
    await tick(window);
    assert.equal(doc.activeElement, view.querySelectorAll('.edit-btn')[1], 'focus returns to the rebuilt button for the same playlist');
    dom.window.close();
});

test('music-skin settingsBody observer ignores text-node updates and only rescans on element additions', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <div id="music-stage"></div>
        <div id="music-stage-settings-card"><div class="music-stage-settings-body"><span id="val">1.0</span></div></div>
    </body>`, { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    const doc = window.document;
    const body = doc.querySelector('.music-stage-settings-body');
    let selectQueries = 0;
    const origQsa = body.querySelectorAll.bind(body);
    body.querySelectorAll = (sel) => {
        if (String(sel).includes('select')) selectQueries += 1;
        return origQsa(sel);
    };
    window.eval(fs.readFileSync('Musicmodules/music-app-hooks.js', 'utf8'));
    window.eval(fs.readFileSync('Musicmodules/music-theme/music-skin.js', 'utf8'));
    window.setupMusicSkin({ playlist: [], loadTrack() {}, updateMediaMetadata() {}, updateTrackInfo() {} });
    await tick(window);
    const initialQueries = selectQueries;
    doc.getElementById('val').textContent = '1.5';
    doc.getElementById('val').textContent = '2.0';
    await tick(window);
    assert.equal(selectQueries, initialQueries, 'textContent updates during slider drags do not rescan selects');
    const wrap = doc.createElement('div');
    wrap.innerHTML = '<select><option value="a">A</option><option value="b">B</option></select>';
    body.appendChild(wrap);
    await tick(window);
    assert.ok(selectQueries > initialQueries, 'element addition triggers select enhancement scan');
    dom.window.close();
});

test('track-info and eq-preset modals trap Tab/Shift+Tab inside the dialog', async () => {
    const dom = new JSDOM('<!doctype html><body><button id="outside">out</button><select id="eq-preset-select"></select></body>', {
        runScripts: 'outside-only',
        url: 'http://localhost/'
    });
    const { window } = dom;
    const doc = window.document;
    const app = {
        playlist: [{ path: 'C:\\Music\\a.flac', title: 'Alpha.flac', artist: 'A', album: 'B', duration: 120 }],
        currentTrackIndex: 0,
        eqBands: { 32: 0 },
        eqPresets: { balance: { 32: 0 } },
        eqPresetSelect: doc.getElementById('eq-preset-select'),
        populateEqPresets() {},
        applyEqPreset() {},
        syncEqPresetSelect() {},
        api: { showMusicInFolder: async () => ({ ok: true }) }
    };
    window.eval(fs.readFileSync('Musicmodules/music-app-hooks.js', 'utf8'));
    window.eval(fs.readFileSync('Musicmodules/music-track-file.js', 'utf8'));
    window.eval(fs.readFileSync('Musicmodules/music-eq-presets.js', 'utf8'));
    window.MusicTrackFile.setupMusicTrackFile(app);
    window.MusicEqPresets.setupMusicEqPresets(app);

    app.openTrackInfo(0);
    const infoButtons = [...doc.querySelectorAll('.minfo button')];
    assert.ok(infoButtons.length >= 2);
    infoButtons[infoButtons.length - 1].focus();
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(doc.activeElement, infoButtons[0], 'Tab wraps from last to first in track info modal');
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(doc.activeElement, infoButtons[infoButtons.length - 1], 'Shift+Tab wraps from first to last in track info modal');
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    app.eqUserPresets.promptSave();
    const eqFocusables = [...doc.querySelectorAll('.music-eq-name input, .music-eq-name button:not([disabled])')];
    assert.ok(eqFocusables.length >= 2);
    eqFocusables[eqFocusables.length - 1].focus();
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(doc.activeElement, eqFocusables[0], 'Tab wraps inside EQ preset save dialog');
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(doc.activeElement, eqFocusables[eqFocusables.length - 1], 'Shift+Tab wraps inside EQ preset save dialog');
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    dom.window.close();
});

test('removing a folder clears duplicate occurrences of its tracks from manualQueue', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    const tKeep = { path: 'D:\\Keep\\k.flac', title: 'Keep' };
    const tDrop = { path: 'D:\\Drop\\a.flac', title: 'Drop' };
    const app = {
        playlist: [tKeep, tDrop],
        currentTrackIndex: 0,
        manualQueue: [tDrop, tKeep, tDrop, tDrop],
        queueRemove(idx) { this.manualQueue.splice(idx, 1); },
        saveLibrary: async () => {},
        renderPlaylist() {},
        api: {
            musicLibraryFolders: async (arg) => arg.op === 'list'
                ? { ok: true, folders: [{ path: 'D:\\Drop', exists: true }] }
                : { ok: true }
        }
    };
    window.MusicDialog = { confirm: async () => true };
    window.eval(fs.readFileSync('Musicmodules/music-folders.js', 'utf8'));
    window.MusicFolders.setupMusicFolders(app);
    app.openLibraryFolders();
    await tick(window);
    const removeBtn = window.document.querySelector('.mfold-remove');
    assert.ok(removeBtn, 'folder remove button rendered');
    removeBtn.click();
    await tick(window);
    await tick(window);
    assert.deepEqual(app.manualQueue, [tKeep], 'all duplicate copies of removed folder tracks cleared from manualQueue');
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    dom.window.close();
});

test('music-skin skips forced reflow during stage mode and window-visibility unsubscribes on beforeunload', async () => {
    const dom = new JSDOM(`<!doctype html><body class="music-stage-active">
        <div class="track-file-number"></div>
        <div id="track-title">Song A</div>
        <div id="track-bitrate">320 kbps</div>
    </body>`, { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    const doc = window.document;
    let reflowReads = 0;
    const roller = doc.querySelector('.track-file-number');
    Object.defineProperty(roller, 'offsetWidth', { get() { reflowReads += 1; return 100; } });
    const app = {
        playlist: [
            { path: 'C:\\a.flac', title: 'Song A', album: 'Alb' },
            { path: 'C:\\b.flac', title: 'Song B', album: 'Alb' }
        ],
        currentTrackIndex: 0,
        trackTitle: doc.getElementById('track-title'),
        trackBitrate: doc.getElementById('track-bitrate')
    };
    let unsubCalled = 0;
    window.utilityAPI = { onMusicWindowVisibility: () => () => { unsubCalled += 1; } };
    window.eval(fs.readFileSync('Musicmodules/music-app-hooks.js', 'utf8'));
    window.eval(fs.readFileSync('Musicmodules/music-theme/music-skin.js', 'utf8'));
    window.eval(fs.readFileSync('Musicmodules/music-window-visibility.js', 'utf8'));
    window.setupMusicSkin(app);
    app.currentTrackIndex = 1;
    app.trackTitle.textContent = 'Song B';
    await tick(window);
    assert.equal(reflowReads, 0, 'stage mode skips hidden .track-file-number forced reflow');
    window.dispatchEvent(new window.Event('beforeunload'));
    assert.equal(unsubCalled, 1, 'window-visibility unsubscribes on beforeunload');
    dom.window.close();
});

test('music-dupes remaps manualQueue, emits music-like-change on liked updates and restores on undo', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const { window } = dom;
    const doc = window.document;
    const keep = { path: 'D:\\Music\\a.flac', title: 'Alpha', artist: 'Artist', lossless: true, bitsPerSample: 24, sampleRate: 96000 };
    const extra = { path: 'D:\\Music\\a.mp3', title: 'Alpha', artist: 'Artist', bitrate: 320000 };
    const other = { path: 'D:\\Music\\b.flac', title: 'Beta', artist: 'Other' };
    let toastAction = null;
    window.MusicToast = { show: ({ action }) => { toastAction = action; } };
    const likeEvents = [];
    doc.addEventListener('music-like-change', (e) => likeEvents.push(e.detail));
    const app = {
        playlist: [other, extra, keep],
        currentTrackIndex: 0,
        manualQueue: [extra, keep, other, extra],
        customPlaylists: [{ id: 'liked', name: '我喜欢的音乐', tracks: [extra.path] }],
        saveLibrary() {},
        saveCustomPlaylists() {},
        renderPlaylist() {},
        renderSidebarContent() {},
        refreshPreload() {}
    };
    window.eval(fs.readFileSync('Musicmodules/music-radio.js', 'utf8'));
    window.eval(fs.readFileSync('Musicmodules/music-dupes.js', 'utf8'));
    window.MusicDupes.setupMusicDupes(app);
    app.openDupesView();
    const removeBtn = doc.querySelector('.mdupes-remove');
    assert.ok(removeBtn && !removeBtn.hidden);
    removeBtn.click();
    assert.deepEqual(app.playlist, [other, keep], 'extra duplicate removed from library');
    assert.deepEqual(app.manualQueue, [keep, other], 'manualQueue remapped to kept track and deduplicated');
    assert.deepEqual([...app.customPlaylists[0].tracks], [keep.path], 'liked playlist remapped to kept path');
    assert.equal(likeEvents.length, 1, 'music-like-change dispatched when liked playlist updated');
    assert.ok(toastAction && typeof toastAction.run === 'function', 'undo action offered via toast');
    toastAction.run();
    assert.equal(app.playlist.length, 3, 'undo restores library');
    assert.deepEqual(app.manualQueue, [extra, keep, other, extra], 'undo restores original manualQueue');
    assert.deepEqual([...app.customPlaylists[0].tracks], [extra.path], 'undo restores liked playlist');
    assert.equal(likeEvents.length, 2, 'undo dispatches music-like-change again');
    dom.window.close();
});

test('music-spectrum traps Tab, ignores composing Escape and blocks single-key shortcuts', async () => {
    const dom = new JSDOM('<!doctype html><body><button id="out">out</button></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    const doc = window.document;
    let leaked = 0;
    doc.addEventListener('keydown', (e) => { if (e.key === ' ') leaked += 1; });
    const app = {
        playlist: [{ path: 'D:\\Music\\a.flac', title: 'Alpha', artist: 'Artist' }],
        currentTrackIndex: 0,
        api: { readMusicAudioFile: () => new Promise(() => {}) }
    };
    window.eval(fs.readFileSync('Musicmodules/music-spectrum.js', 'utf8'));
    window.MusicSpectrum.setupMusicSpectrum(app);
    app.openSpectrum(0);
    const closeBtn = doc.querySelector('.mspec .mstats-close');
    assert.ok(closeBtn);
    doc.getElementById('out').focus();
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(doc.activeElement, closeBtn, 'Tab moves focus back into spectrum dialog');
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    assert.equal(leaked, 0, 'single-key shortcut is blocked while spectrum modal is open');
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
    assert.ok(doc.querySelector('.mspec'), 'composing Escape does not close spectrum modal');
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    dom.window.close();
});

test('archive-wall.css uses compositor-only aw-breathe, no duplicate height and disables blur on music-fl-low', () => {
    const css = fs.readFileSync('Musicmodules/music-archive/archive-wall.css', 'utf8');
    const breatheRule = css.match(/@keyframes\s+aw-breathe\s*\{[^}]*\}/)?.[0] || '';
    assert.ok(breatheRule, 'aw-breathe keyframe exists');
    assert.doesNotMatch(breatheRule, /box-shadow/, 'aw-breathe must not animate main-thread box-shadow');
    assert.match(breatheRule, /transform:\s*scale\(/, 'aw-breathe uses compositor transform');
    const stickyRule = css.match(/\.ag-sticky\s*\{[^}]*\}/)?.[0] || '';
    assert.equal((stickyRule.match(/\bheight\s*:/g) || []).length, 1, '.ag-sticky defines height once');
    assert.match(css, /body\.music-fl-low\s+\.archive-wall\.aw-table::after\s*\{\s*display:\s*none;/);
    assert.match(css, /body\.music-fl-low\s+#music-archive-view\s+\.aw-panel-acts\s+button[\s\S]*?backdrop-filter:\s*none;/);
});
