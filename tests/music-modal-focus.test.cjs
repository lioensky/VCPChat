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

test('eq-preset dialog blocks single-key shortcuts on buttons and cleans up on beforeunload; channels deduplicate no-op sets', async () => {
    const dom = new JSDOM('<!doctype html><body><select id="eq-preset-select"></select></body>', {
        runScripts: 'outside-only',
        url: 'http://localhost/'
    });
    try {
        const { window } = dom;
        const doc = window.document;
        let leakedKeys = 0;
        doc.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'm') leakedKeys += 1; });
        let channelCalls = 0;
        const app = {
            eqBands: { 32: 0 },
            eqPresets: { balance: { 32: 0 } },
            eqPresetSelect: doc.getElementById('eq-preset-select'),
            populateEqPresets() {},
            applyEqPreset() {},
            syncEqPresetSelect() {},
            updateUIWithState() {},
            api: {
                setMusicChannels: async (payload) => {
                    channelCalls += 1;
                    return { status: 'success', channels: payload };
                }
            }
        };
        window.eval(fs.readFileSync('Musicmodules/music-app-hooks.js', 'utf8'));
        window.eval(fs.readFileSync('Musicmodules/music-eq-presets.js', 'utf8'));
        window.eval(fs.readFileSync('Musicmodules/music-channels.js', 'utf8'));
        window.MusicEqPresets.setupMusicEqPresets(app);
        window.MusicChannels.setupMusicChannels(app);

        app.eqUserPresets.promptSave();
        const saveBtn = doc.querySelector('.music-eq-name button');
        assert.ok(saveBtn, 'EQ preset dialog button exists');
        saveBtn.focus();
        saveBtn.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
        saveBtn.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true }));
        assert.equal(leakedKeys, 0, 'single-key shortcuts on dialog buttons do not leak to document');

        await app.channels.set({ swap: true });
        await app.channels.set({ swap: true });
        assert.equal(channelCalls, 1, 'identical channel state after engine sync does not resend IPC');

        app.channels.open();
        assert.ok(doc.querySelector('.mchan'), 'channels dialog opened');
        window.dispatchEvent(new window.Event('beforeunload'));
        assert.equal(doc.querySelector('.music-eq-name'), null, 'EQ preset dialog removed immediately on beforeunload');
        assert.equal(doc.querySelector('.mchan'), null, 'channels dialog removed immediately on beforeunload');
    } finally {
        dom.window.close();
    }
});

test('dock panel and archive list/lyrics CSS enforce low-power blur cutoffs and prefers-reduced-motion parity', () => {
    const panelCss = fs.readFileSync('Musicmodules/music-dock/music-dock-panel.css', 'utf8');
    assert.match(panelCss, /body\.music-fl-low \.mtst,\s*#music-dock-root\.md-fl-low \.md-pnl\s*\{[^}]*backdrop-filter:\s*none/);
    assert.match(panelCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.mtst-progress \.mtst-ic svg/);

    const listCss = fs.readFileSync('Musicmodules/music-archive/archive-list.css', 'utf8');
    assert.match(listCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.archive-list-row\.playing \.eq i/);

    const lyricsCss = fs.readFileSync('Musicmodules/music-archive/archive-lyrics.css', 'utf8');
    assert.match(lyricsCss, /body\.music-fl-low \.archive-list\.has-drop \.archive-list-letter\[data-md-dist="4"\] > span\s*\{\s*filter:\s*none;/);
    assert.match(lyricsCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.archive-lyrics-track/);
});

test('music-sidebar syncs archiveView and music-like-change when adding/toggling liked playlist tracks', () => {
    const dom = new JSDOM(`<!doctype html><body>
        <span id="all-count">0</span>
        <div id="playlist-edit-modal"><input id="modal-search-input" /><span id="modal-playlist-title"></span><div id="modal-song-list"></div><span id="modal-count"></span></div>
    </body>`, { runScripts: 'outside-only', url: 'http://localhost/' });
    try {
        const { window } = dom;
        const doc = window.document;
        const likeEvents = [];
        let archiveRefreshes = 0;
        doc.addEventListener('music-like-change', (e) => likeEvents.push(e.detail));
        const t1 = { path: 'D:\\Music\\a.flac', title: 'Alpha.flac', artist: 'A' };
        const t2 = { path: 'D:\\Music\\b.flac', title: 'Beta.flac', artist: 'B' };
        const app = {
            playlist: [t1, t2],
            customPlaylists: [{ id: 'liked', name: '喜欢的歌曲', tracks: [] }],
            contextMenuTrackIndex: 0,
            currentSidebarView: 'all',
            stripAudioExtension: (s) => s.replace(/\.[^.]+$/, ''),
            saveCustomPlaylists() {},
            archiveView: { refresh() { archiveRefreshes += 1; } },
            playlistEditModal: doc.getElementById('playlist-edit-modal'),
            modalSearchInput: doc.getElementById('modal-search-input'),
            modalPlaylistTitle: doc.getElementById('modal-playlist-title'),
            modalSongList: doc.getElementById('modal-song-list'),
            modalCount: doc.getElementById('modal-count')
        };
        window.eval(fs.readFileSync('Musicmodules/music-sidebar.js', 'utf8'));
        window.setupSidebar(app);

        app.addSelectedTracksToPlaylist('liked');
        assert.equal(archiveRefreshes, 1, 'addSelectedTracksToPlaylist refreshes archiveView');
        assert.equal(likeEvents.length, 1, 'adding to liked playlist dispatches music-like-change');
        assert.equal(likeEvents[0].liked, true);

        app.openPlaylistEditModal('liked');
        const rows = doc.querySelectorAll('.music-modal-song-item');
        rows[0].click(); // remove t1 from liked
        assert.equal(archiveRefreshes, 2, 'playlist edit modal toggle refreshes archiveView');
        assert.equal(likeEvents.length, 2, 'toggling liked track in edit modal dispatches music-like-change');
        assert.equal(likeEvents[1].liked, false);
    } finally {
        dom.window.close();
    }
});

test('EQ preset & channels dialogs trap navigation keys and cancel stale open rAF on quick close', () => {
    const dom = new JSDOM('<!doctype html><body><select id="eq-preset-select"></select></body>', {
        runScripts: 'outside-only',
        url: 'http://localhost/'
    });
    try {
        const { window } = dom;
        const doc = window.document;
        let rafSeq = 0;
        const cancelled = [];
        window.requestAnimationFrame = () => ++rafSeq;
        window.cancelAnimationFrame = (id) => cancelled.push(id);
        let navLeaked = 0;
        doc.addEventListener('keydown', (e) => {
            if (e.key.startsWith('Arrow') || e.key === 'PageDown' || e.key === 'Home') navLeaked += 1;
        });
        const app = {
            eqBands: { 32: 0 },
            eqPresets: { flat: { 32: 0 } },
            eqPresetSelect: doc.getElementById('eq-preset-select'),
            populateEqPresets() {}, applyEqPreset() {}, syncEqPresetSelect() {}, updateUIWithState() {},
            api: { setMusicChannels: async (p) => ({ status: 'success', channels: p }) }
        };
        window.eval(fs.readFileSync('Musicmodules/music-app-hooks.js', 'utf8'));
        window.eval(fs.readFileSync('Musicmodules/music-eq-presets.js', 'utf8'));
        window.eval(fs.readFileSync('Musicmodules/music-channels.js', 'utf8'));
        window.MusicEqPresets.setupMusicEqPresets(app);
        window.MusicChannels.setupMusicChannels(app);

        app.eqUserPresets.promptSave();
        const eqRaf = rafSeq;
        const eqCancel = doc.querySelector('.music-eq-name .cancel');
        eqCancel.focus();
        eqCancel.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        eqCancel.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }));
        assert.equal(navLeaked, 0, 'EQ preset dialog blocks navigation keys on buttons');
        eqCancel.click();
        assert.ok(cancelled.includes(eqRaf), 'closing EQ preset dialog cancels pending open rAF');

        app.channels.open();
        const chRaf = rafSeq;
        const slider = doc.querySelector('.mchan-slider');
        slider.focus();
        slider.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
        slider.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
        assert.equal(navLeaked, 0, 'channels dialog stops navigation keys from leaking to archive/stage');
        doc.querySelector('.mchan .mstats-close').click();
        assert.ok(cancelled.includes(chRaf), 'closing channels dialog cancels pending open rAF');
    } finally {
        dom.window.close();
    }
});

test('stats, dupes, folders, track-file and spectrum modals trap navigation keys and cancel stale open rAF', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    try {
        const { window } = dom;
        const doc = window.document;
        let rafSeq = 0;
        const cancelled = [];
        window.requestAnimationFrame = () => ++rafSeq;
        window.cancelAnimationFrame = (id) => cancelled.push(id);
        let navLeaked = 0;
        doc.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'Home') navLeaked += 1;
        });
        const t1 = { path: 'D:\\Music\\a.flac', title: 'Alpha.flac', artist: 'A', duration: 180 };
        const t2 = { path: 'D:\\Music\\a.mp3', title: 'Alpha.mp3', artist: 'A', duration: 180 };
        const app = {
            playlist: [t1, t2],
            currentTrackIndex: 0,
            musicStats: { summary: () => ({ seconds: 0, plays: 0, activeDays: 0, hours: new Array(24).fill(0), tracks: [], daily: {} }), get: () => null },
            api: {
                musicLibraryFolders: async () => ({ ok: true, folders: [] }),
                showMusicInFolder: async () => ({ ok: true }),
                readMusicAudioFile: () => new Promise(() => {})
            }
        };
        for (const f of ['music-radio.js', 'music-stats-view.js', 'music-dupes.js', 'music-folders.js', 'music-track-file.js', 'music-spectrum.js']) {
            window.eval(fs.readFileSync(`Musicmodules/${f}`, 'utf8'));
        }
        window.MusicStatsView.setupMusicStatsView(app);
        window.MusicDupes.setupMusicDupes(app);
        window.MusicFolders.setupMusicFolders(app);
        window.MusicTrackFile.setupMusicTrackFile(app);
        window.MusicSpectrum.setupMusicSpectrum(app);

        const checkModal = (openFn, closeSel) => {
            openFn();
            const id = rafSeq;
            doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
            doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }));
            doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
            doc.querySelector(closeSel).click();
            assert.ok(cancelled.includes(id), `closing ${closeSel} cancels pending open rAF`);
        };
        checkModal(() => app.openStatsView(), '.mstats .mstats-close');
        checkModal(() => app.openDupesView(), '.mdupes .mstats-close');
        checkModal(() => app.openLibraryFolders(), '.mfold .mstats-close');
        checkModal(() => app.openTrackInfo(0), '.minfo:not(.mfold) .mstats-close');
        checkModal(() => { app.openSpectrum(0); }, '.mspec .mstats-close');
        assert.equal(navLeaked, 0, 'none of the 5 modals leak navigation keys to document');
    } finally {
        dom.window.close();
    }
});

test('music-modal-focus isolates navigation and single-key shortcuts inside open overlays and cancels pending focus rAF', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <button id="opener">open</button>
        <div id="webdav-modal" class="music-modal-overlay">
            <button class="music-modal-close-btn">close</button>
            <input id="dav-input" type="text">
        </div>
    </body>`, { runScripts: 'outside-only', url: 'http://localhost/' });
    try {
        const { window } = dom;
        const doc = window.document;
        let rafSeq = 0;
        const cancelled = [];
        window.requestAnimationFrame = () => ++rafSeq;
        window.cancelAnimationFrame = (id) => cancelled.push(id);
        let leaked = 0;
        doc.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'm') leaked += 1;
        });
        window.eval(fs.readFileSync('Musicmodules/music-modal-focus.js', 'utf8'));
        const modal = doc.getElementById('webdav-modal');
        const closeBtn = modal.querySelector('.music-modal-close-btn');
        closeBtn.getClientRects = () => [{ width: 20, height: 20 }];
        const input = doc.getElementById('dav-input');
        input.getClientRects = () => [{ width: 80, height: 20 }];

        modal.classList.add('active');
        await new Promise((r) => setTimeout(r, 0));
        const pendingRaf = rafSeq;
        assert.ok(pendingRaf > 0);

        closeBtn.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        closeBtn.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }));
        closeBtn.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true }));
        assert.equal(leaked, 0, 'open modal overlay blocks navigation and single-key shortcuts from leaking to document');

        modal.classList.remove('active');
        await new Promise((r) => setTimeout(r, 0));
        assert.ok(cancelled.includes(pendingRaf), 'closing overlay cancels pending focusInside rAF');
        window.dispatchEvent(new window.Event('beforeunload'));
    } finally {
        dom.window.close();
    }
});

test('music-eq-presets caches EQ sliders and music-channels deduplicates unchanged DOM writes in syncDialog', async () => {
    const dom = new JSDOM('<!doctype html><body><select id="eq-preset-select"></select><input id="eq-32" value="0"><input id="eq-1k" value="0"></body>', {
        runScripts: 'outside-only',
        url: 'http://localhost/'
    });
    try {
        const { window } = dom;
        const doc = window.document;
        let eqLookups = 0;
        const origGetById = doc.getElementById.bind(doc);
        doc.getElementById = (id) => {
            if (String(id).startsWith('eq-') && id !== 'eq-preset-select') eqLookups += 1;
            return origGetById(id);
        };
        const app = {
            eqBands: { 32: 0, '1k': 0 },
            eqPresets: { balance: { 32: 0, '1k': 0 } },
            eqPresetSelect: origGetById('eq-preset-select'),
            populateEqPresets() {},
            applyEqPreset() {},
            syncEqPresetSelect() {},
            updateUIWithState() {},
            api: { setMusicChannels: async (p) => ({ status: 'success', channels: p }) }
        };
        window.eval(fs.readFileSync('Musicmodules/music-app-hooks.js', 'utf8'));
        window.eval(fs.readFileSync('Musicmodules/music-eq-presets.js', 'utf8'));
        window.eval(fs.readFileSync('Musicmodules/music-channels.js', 'utf8'));
        window.MusicEqPresets.setupMusicEqPresets(app);
        window.MusicChannels.setupMusicChannels(app);

        assert.equal(app.eqUserPresets.isCustom(), false);
        const firstLookups = eqLookups;
        assert.equal(firstLookups, 2, 'initial currentBands queries each band slider once');
        origGetById('eq-32').value = '3';
        assert.equal(app.eqUserPresets.isCustom(), true);
        app.eqUserPresets.save('Warm');
        assert.equal(eqLookups, firstLookups, 'cached sliders avoid repeated getElementById calls');

        origGetById('eq-32').remove();
        const repl = doc.createElement('input');
        repl.id = 'eq-32';
        repl.value = '-2';
        doc.body.appendChild(repl);
        app.eqUserPresets.save('Cool');
        assert.equal(eqLookups, firstLookups + 1, 'detached slider re-queries DOM');
        assert.equal(app.eqUserPresets.list().find((p) => p.name === 'Cool').bands['32'], -2);

        app.channels.open();
        const toggles = [...doc.querySelectorAll('.mchan-toggle')];
        assert.equal(toggles.length, 2);
        let ariaWrites = 0;
        for (const btn of toggles) {
            const origSet = btn.setAttribute.bind(btn);
            btn.setAttribute = (name, val) => {
                if (name === 'aria-pressed') ariaWrites += 1;
                return origSet(name, val);
            };
        }
        await app.channels.set({ balance: 0.25 });
        await app.channels.set({ balance: -0.5 });
        assert.equal(ariaWrites, 0, 'balance-only drags skip redundant aria-pressed writes on toggle buttons');
        await app.channels.set({ mono: true });
        assert.equal(ariaWrites, 1, 'toggling mono writes only the changed button aria-pressed');
        window.dispatchEvent(new window.Event('beforeunload'));
    } finally {
        dom.window.close();
    }
});

test('Batch 66: modal-focus skips overlay DOM queries on non-Tab/non-Nav keys, dupes reuses rendered groups, and pinButton cancels rAF on dispose', async () => {
    // 1. music-modal-focus: normal keystrokes do 0 overlay querySelectorAll calls
    const dom = new JSDOM(`<!doctype html><body>
        <input id="search">
        <div id="m1" class="music-modal-overlay"><button id="b1">OK</button></div>
    </body>`, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    try {
        const { window } = dom;
        const doc = window.document;
        window.eval(fs.readFileSync('Musicmodules/music-modal-focus.js', 'utf8'));
        await tick(window);
        let qsaCalls = 0;
        const origQsa = doc.querySelectorAll.bind(doc);
        doc.querySelectorAll = (sel) => {
            if (String(sel).includes('modal-overlay')) qsaCalls += 1;
            return origQsa(sel);
        };
        const input = doc.getElementById('search');
        for (const key of ['a', 'b', '1', 'Enter', ' ']) {
            input.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        }
        assert.equal(qsaCalls, 0, 'non-Tab/non-Nav keys perform zero overlay querySelectorAll calls');
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        assert.equal(qsaCalls, 1, 'Tab checks open overlays directly');
        window.dispatchEvent(new window.Event('beforeunload'));
    } finally {
        dom.window.close();
    }

    // 2. music-dupes: clicking remove reuses cached groups computed during render() when playlist is unchanged
    const dupDom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    try {
        const { window } = dupDom;
        const doc = window.document;
        let rankCalls = 0;
        window.MusicRadioUtils = {
            recordingKey: (t) => `${t.title}|${t.artist}`,
            versionRank: (t) => { rankCalls += 1; return t.lossless ? 10 : 1; }
        };
        const app = {
            playlist: [
                { path: '/a.flac', title: 'Alpha', artist: 'A', lossless: true },
                { path: '/a.mp3', title: 'Alpha', artist: 'A', lossless: false }
            ],
            currentTrackIndex: -1,
            customPlaylists: [],
            saveLibrary() {}, renderPlaylist() {}, renderSidebarContent() {}, refreshPreload() {}
        };
        window.eval(fs.readFileSync('Musicmodules/music-dupes.js', 'utf8'));
        window.MusicDupes.setupMusicDupes(app);
        app.openDupesView();
        const callsAfterRender = rankCalls;
        assert.ok(callsAfterRender > 0);
        doc.querySelector('.mdupes-remove').click();
        assert.equal(rankCalls, callsAfterRender, 'confirming remove reuses cached duplicate groups without rescanning');
        assert.equal(app.playlist.length, 1);
    } finally {
        dupDom.window.close();
    }

    // 3. pinButton.js: beforeunload cancels pending scheduleMount rAF and skips late tryMount
    if (process.platform === 'win32') {
        const pinDom = new JSDOM('<!doctype html><body><div class="window-controls"><button id="minimize-music-btn"></button></div></body>', {
            runScripts: 'outside-only',
            pretendToBeVisual: true,
            url: 'http://localhost/music.html'
        });
        await tick(pinDom.window);
        const prevWin = global.window, prevDoc = global.document, prevRaf = global.requestAnimationFrame, prevCaf = global.cancelAnimationFrame, prevMO = global.MutationObserver;
        const queued = [];
        const cancelled = [];
        let rid = 1;
        try {
            global.window = pinDom.window;
            global.document = pinDom.window.document;
            global.MutationObserver = pinDom.window.MutationObserver;
            global.requestAnimationFrame = (cb) => { const id = rid++; queued.push({ id, cb }); return id; };
            global.cancelAnimationFrame = (id) => { cancelled.push(id); };
            const { installPinButton } = require('../preloads/behaviors/pinButton.js');
            let unsubbed = 0;
            installPinButton({}, {
                togglePinWindow: async () => {},
                isWindowPinned: async () => false,
                onWindowPinnedChanged: () => () => { unsubbed += 1; }
            });
            assert.equal(queued.length, 1, 'initial scheduleMount queued 1 rAF');
            pinDom.window.dispatchEvent(new pinDom.window.Event('beforeunload'));
            assert.equal(unsubbed, 1);
            assert.ok(cancelled.includes(queued[0].id), 'dispose cancels pending mountRafId');
            // Even if a stale rAF callback fires anyway, disposed guard prevents mounting
            queued[0].cb(16);
            assert.equal(pinDom.window.document.querySelector('.vcp-universal-pin-btn'), null, 'disposed guard blocks late mount');
        } finally {
            global.window = prevWin;
            global.document = prevDoc;
            global.requestAnimationFrame = prevRaf;
            global.cancelAnimationFrame = prevCaf;
            global.MutationObserver = prevMO;
            pinDom.window.close();
        }
    }
});

test('Batch 70: close button click restores focus with animation, rapid reopen flushes exiting overlay, and closing confirm dialog does not block Escape', async () => {
    const dom = new JSDOM('<!doctype html><body><button id="opener">open</button><select id="eq-preset-select"></select></body>', {
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        url: 'http://localhost/'
    });
    try {
        const { window } = dom;
        const doc = window.document;
        const opener = doc.getElementById('opener');
        const t1 = { path: 'D:\\Music\\a.flac', title: 'Alpha.flac', artist: 'A', duration: 180 };
        const t2 = { path: 'D:\\Music\\a.mp3', title: 'Alpha.mp3', artist: 'A', duration: 180 };
        const app = {
            playlist: [t1, t2],
            currentTrackIndex: 0,
            eqBands: { 32: 0 },
            eqPresets: { flat: { 32: 0 } },
            eqPresetSelect: doc.getElementById('eq-preset-select'),
            populateEqPresets() {}, applyEqPreset() {}, syncEqPresetSelect() {}, updateUIWithState() {},
            musicStats: { summary: () => ({ seconds: 0, plays: 0, activeDays: 0, hours: new Array(24).fill(0), tracks: [], daily: {} }), get: () => null },
            api: {
                musicLibraryFolders: async () => ({ ok: true, folders: [] }),
                showMusicInFolder: async () => ({ ok: true }),
                readMusicAudioFile: () => new Promise(() => {}),
                setMusicChannels: async (p) => ({ status: 'success', channels: p })
            }
        };
        for (const f of ['music-app-hooks.js', 'music-radio.js', 'music-stats-view.js', 'music-dupes.js', 'music-folders.js', 'music-track-file.js', 'music-spectrum.js', 'music-channels.js', 'music-eq-presets.js']) {
            window.eval(fs.readFileSync(`Musicmodules/${f}`, 'utf8'));
        }
        window.MusicStatsView.setupMusicStatsView(app);
        window.MusicDupes.setupMusicDupes(app);
        window.MusicFolders.setupMusicFolders(app);
        window.MusicTrackFile.setupMusicTrackFile(app);
        window.MusicSpectrum.setupMusicSpectrum(app);
        window.MusicChannels.setupMusicChannels(app);
        window.MusicEqPresets.setupMusicEqPresets(app);

        const cases = [
            ['dupes', () => app.openDupesView(), '.mdupes .mstats-close', '.mdupes'],
            ['stats', () => app.openStatsView(), '.mstats:not(.mdupes):not(.mfold):not(.minfo):not(.mspec):not(.mchan) .mstats-close', '.mstats:not(.mdupes):not(.mfold):not(.minfo):not(.mspec):not(.mchan)'],
            ['track-file', () => app.openTrackInfo(0), '.minfo:not(.mfold):not(.mchan) .mstats-close', '.minfo:not(.mfold):not(.mchan)'],
            ['spectrum', () => { app.openSpectrum(0); }, '.mspec .mstats-close', '.mspec'],
            ['channels', () => app.channels.open(), '.mchan .mstats-close', '.mchan'],
            ['folders', () => app.openLibraryFolders(), '.mfold .mstats-close', '.mfold']
        ];

        for (const [name, openFn, closeSel, dialogSel] of cases) {
            opener.focus();
            openFn();
            const firstOverlay = doc.querySelector(dialogSel).closest('.dialog-overlay');
            doc.querySelector(closeSel).click();
            assert.equal(doc.activeElement, opener, `${name}: clicking close button restores focus (MouseEvent not treated as immediate)`);
            assert.equal(firstOverlay.isConnected, true, `${name}: clicking close button preserves exit animation before 320ms removal`);
            openFn();
            assert.equal(firstOverlay.isConnected, false, `${name}: rapid reopen flushes exiting overlay immediately`);
            assert.equal(doc.querySelectorAll(dialogSel).length, 1, `${name}: no duplicate dialog nodes on rapid reopen`);
            doc.querySelector(closeSel).click();
        }

        // Dismissed EQ preset dialog marks data-closing="1" so underlying dialogs still handle Escape immediately
        app.channels.open();
        app.eqUserPresets.promptSave();
        doc.querySelector('.music-eq-name .cancel').click();
        const fadingEq = doc.querySelector('.music-eq-name');
        assert.ok(fadingEq && fadingEq.dataset.closing === '1', 'fading EQ preset dialog carries data-closing=1');
        window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        assert.equal(doc.querySelector('.mchan')?.closest('.dialog-overlay')?.classList.contains('visible'), false, 'channels dialog handles Escape immediately while confirm overlay fades out');

        // beforeunload flushes all pending exit timers and removes fading overlays immediately
        window.dispatchEvent(new window.Event('beforeunload'));
        assert.equal(doc.querySelectorAll('.dialog-overlay').length, 0, 'beforeunload removes all fading overlays immediately');
    } finally {
        dom.window.close();
    }
});

test('Batch 79: eq-presets dedupes syncDelete writes & hoists isCustom slider reads, modal-focus guards inert writes, and archive-wall.css drops duplicate selector', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <select id="eq-preset-select"><option value="flat">平坦</option><option value="custom">自定义</option></select>
        <input id="eq-60Hz" value="2"><input id="eq-1kHz" value="-1">
        <div id="m1" class="music-modal-overlay"><button type="button">ok</button></div>
    </body>`, { runScripts: 'outside-only', url: 'http://localhost/' });
    try {
        const { window } = dom;
        const doc = window.document;
        const sel = doc.getElementById('eq-preset-select');
        const s60 = doc.getElementById('eq-60Hz');
        let valueReads = 0;
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        Object.defineProperty(s60, 'value', {
            configurable: true,
            get() { valueReads += 1; return desc.get.call(this); },
            set(v) { return desc.set.call(this, v); }
        });
        const app = {
            eqPresetSelect: sel,
            eqBands: { '60Hz': 0, '1kHz': 0 },
            eqPresets: {
                flat: { '60Hz': 0, '1kHz': 0 },
                bass: { '60Hz': 5, '1kHz': 0 },
                vocal: { '60Hz': -2, '1kHz': 4 },
                rock: { '60Hz': 3, '1kHz': -1 }
            },
            applyEqPreset() {},
            populateEqPresets() {},
            syncEqPresetSelect() {}
        };
        window.eval(fs.readFileSync('Musicmodules/music-app-hooks.js', 'utf8'));
        window.eval(fs.readFileSync('Musicmodules/music-eq-presets.js', 'utf8'));
        window.MusicEqPresets.setupMusicEqPresets(app, { storage: { getItem: () => '[]', setItem() {} } });

        const delOpt = sel.querySelector('option[value="__eq-delete"]');
        assert.ok(delOpt, 'delete option appended');
        let delMutations = 0;
        const mo = new window.MutationObserver((recs) => { delMutations += recs.length; });
        mo.observe(delOpt, { attributes: true, childList: true, characterData: true, subtree: true });
        sel.value = 'custom';
        app.syncEqPresetSelect();
        app.syncEqPresetSelect();
        app.syncEqPresetSelect();
        await tick(window);
        assert.equal(delMutations, 0, 'repeated syncEqPresetSelect on unchanged non-user preset triggers zero DOM mutations on delOpt');
        mo.disconnect();

        valueReads = 0;
        assert.equal(app.eqUserPresets.isCustom(), true);
        assert.equal(valueReads, 1, 'isCustom reads each EQ slider once instead of once per preset');

        // music-modal-focus guards redundant inert writes on unrelated class mutations
        const overlay = doc.getElementById('m1');
        let inertWrites = 0;
        let inertVal = undefined;
        Object.defineProperty(overlay, 'inert', {
            configurable: true,
            get() { return inertVal; },
            set(v) { inertWrites += 1; inertVal = v; }
        });
        window.eval(fs.readFileSync('Musicmodules/music-modal-focus.js', 'utf8'));
        assert.equal(inertVal, true);
        assert.equal(inertWrites, 1, 'initial sync sets inert once');
        overlay.classList.add('unrelated-a');
        await tick(window);
        overlay.classList.remove('unrelated-a');
        await tick(window);
        assert.equal(inertWrites, 1, 'unrelated class toggles on closed overlay skip redundant inert writes');
        overlay.classList.add('visible');
        await tick(window);
        assert.equal(inertVal, false);
        assert.equal(inertWrites, 2, 'opening overlay clears inert once');

        // archive-wall.css no duplicate .aw-panel-acts button in music-fl-low blur cutoff rule
        const css = fs.readFileSync('Musicmodules/music-archive/archive-wall.css', 'utf8');
        const rule = css.match(/body\.music-fl-low\s+#music-archive-view\s+\.aw-locate[^{]*\{[^}]*\}/)?.[0] || '';
        assert.ok(rule, 'music-fl-low aw-locate rule exists');
        assert.equal((rule.match(/\.aw-panel-acts\s+button/g) || []).length, 1, 'no duplicate .aw-panel-acts button selector');
    } finally {
        dom.window.close();
    }
});

test('Batch 84: modal-focus blocks out-of-modal single-key leaks, closing dialogs mark data-closing=1, folders delegates actions, and band comparisons match', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <button id="bg-btn">bg</button>
        <div id="m1" class="music-modal-overlay"><button id="m1-ok">OK</button></div>
        <select id="eq-preset-select"><option value="flat">平坦</option></select>
        <input id="eq-32" value="0"><input id="eq-64" value="0">
    </body>`, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    try {
        const { window } = dom;
        const doc = window.document;
        window.eval(fs.readFileSync('Musicmodules/music-modal-focus.js', 'utf8'));
        await tick(window);

        // 1. Open static overlay blocks single-key shortcut dispatched outside modal from reaching document listeners
        const leaked = [];
        doc.addEventListener('keydown', (e) => { if (!e.defaultPrevented) leaked.push(e.key); });
        const bg = doc.getElementById('bg-btn');
        bg.focus();
        bg.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
        assert.deepEqual(leaked, [' '], 'single-key reaches document when no modal is open');

        leaked.length = 0;
        const m1 = doc.getElementById('m1');
        m1.classList.add('visible');
        await tick(window);
        bg.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
        bg.dispatchEvent(new window.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
        assert.deepEqual(leaked, [], 'open static modal blocks single-key shortcuts dispatched outside modal');
        m1.classList.remove('visible');
        await tick(window);

        // 2. Dialog close marks data-closing=1 and music-folders delegates row button clicks
        const folderCalls = [];
        const t1 = { path: 'D:\\Music\\a.flac', title: 'Alpha.flac', artist: 'A', duration: 180 };
        const t2 = { path: 'D:\\Music\\a.mp3', title: 'Alpha.mp3', artist: 'A', duration: 180 };
        const app = {
            playlist: [t1, t2],
            currentTrackIndex: 0,
            eqBands: { 32: 0, 64: 0 },
            eqPresets: { flat: { 32: 0, 64: 0 }, zeroExtra: { 32: 0, 64: 0, 125: 0 }, bump: { 32: 0, 64: 0, 125: 3 } },
            eqPresetSelect: doc.getElementById('eq-preset-select'),
            populateEqPresets() {}, applyEqPreset() {}, syncEqPresetSelect() {}, updateUIWithState() {},
            api: {
                musicLibraryFolders: async (req) => {
                    folderCalls.push(req);
                    if (req.op === 'list') return { ok: true, folders: [{ path: 'D:\\Music', exists: true, count: 2 }] };
                    return { ok: true };
                },
                showMusicInFolder: async () => ({ ok: true }),
                setMusicChannels: async (p) => ({ status: 'success', channels: p })
            }
        };
        for (const f of ['music-app-hooks.js', 'music-radio.js', 'music-dupes.js', 'music-folders.js', 'music-track-file.js', 'music-channels.js', 'music-eq-presets.js']) {
            window.eval(fs.readFileSync(`Musicmodules/${f}`, 'utf8'));
        }
        window.MusicDupes.setupMusicDupes(app);
        window.MusicFolders.setupMusicFolders(app);
        window.MusicTrackFile.setupMusicTrackFile(app);
        window.MusicChannels.setupMusicChannels(app);
        window.MusicEqPresets.setupMusicEqPresets(app, { storage: { getItem: () => '[]', setItem() {} } });

        // Closing dupes / track-file / channels marks data-closing="1"
        for (const [openFn, sel] of [
            [() => app.openDupesView(), '.mdupes'],
            [() => app.openTrackInfo(0), '.minfo'],
            [() => app.channels.open(), '.mchan']
        ]) {
            openFn();
            const overlay = doc.querySelector(sel).closest('.dialog-overlay');
            overlay.querySelector('.mstats-close').click();
            assert.equal(overlay.dataset.closing, '1', `${sel} marks data-closing=1 on close`);
        }

        // Folders delegated click invokes open action and marks data-closing=1 on close
        app.openLibraryFolders();
        await tick(window);
        await tick(window);
        const foldOverlay = doc.querySelector('.mfold').closest('.dialog-overlay');
        const openBtn = foldOverlay.querySelector('button[data-mfold-act="open"]');
        assert.ok(openBtn, 'folders renders delegated open button');
        openBtn.click();
        await tick(window);
        assert.ok(folderCalls.some((c) => c && c.op === 'open' && c.path === 'D:\\Music'), 'delegated open click invokes musicLibraryFolders open');
        foldOverlay.querySelector('.mstats-close').click();
        assert.equal(foldOverlay.dataset.closing, '1', '.mfold marks data-closing=1 on close');

        // Zero-allocation bandsEqual: matches asymmetric zero keys and rejects asymmetric non-zero keys
        assert.equal(app.eqUserPresets.isCustom(), false, 'matches flat/zeroExtra preset with extra 0 key');
        app.eqPresets = { bump: { 32: 0, 64: 0, 125: 3 } };
        assert.equal(app.eqUserPresets.isCustom(), true, 'rejects preset with extra non-zero key');

        window.dispatchEvent(new window.Event('beforeunload'));
    } finally {
        dom.window.close();
    }
});
