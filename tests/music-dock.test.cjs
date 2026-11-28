const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function setup(patch) {
    const dom = new JSDOM(`<!doctype html><body>
        <div class="main-content"><div class="settings-container" id="dsp"></div></div>
        <div class="track-title">未选择歌曲</div><div class="track-artist"></div><div class="album-art"></div>
        <span class="current-time">0:00</span><span class="duration">0:00</span>
        <button id="mode-btn" title="列表循环"></button>
        <input id="volume-slider" type="range" min="0" max="1" step="0.01" value="0.5">
        <ul id="playlist"></ul>
        <div id="music-dock-root"></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const { window } = dom;
    window.MusicStageConfig = { modes: [{ id: 'luminous', label: '流光' }, { id: 'partita', label: '云阶' }] };
    window.eval(read('Musicmodules/music-dock/music-dock-icons.js'));
    window.eval(read('Musicmodules/music-dock/music-dock-palette.js'));
    window.eval(read('Musicmodules/music-dock/music-dock-fluid.js'));
    window.eval(read('Musicmodules/music-dock/music-dock-queue.js'));
    window.eval(read('Musicmodules/music-dock/music-dock-stage-settings.js'));
    window.eval(read('Musicmodules/music-dock/music-dock.js'));
    const doc = window.document;
    const calls = [];
    const playlist = [
        { path: 'C:/a.flac', title: 'Alpha.flac', artist: 'A', albumArt: null },
        { path: 'C:/b.flac', title: 'Beta.flac', artist: 'B', albumArt: null }
    ];
    const app = {
        playlist,
        currentTrackIndex: 0,
        isPlaying: false,
        lastKnownCurrentTime: 0,
        lastKnownDuration: 200,
        lastStateUpdateTime: Date.now(),
        playModes: ['repeat', 'repeat-one', 'shuffle'],
        currentPlayMode: 0,
        currentLyrics: [{ time: 3, text: '第一句' }, { time: 9, text: '第二句' }],
        currentLyricIndex: 0,
        trackTitle: doc.querySelector('.track-title'),
        trackArtist: doc.querySelector('.track-artist'),
        albumArt: doc.querySelector('.album-art'),
        currentTimeEl: doc.querySelector('.current-time'),
        durationEl: doc.querySelector('.duration'),
        modeBtn: doc.getElementById('mode-btn'),
        volumeSlider: doc.getElementById('volume-slider'),
        playlistEl: doc.getElementById('playlist'),
        stripAudioExtension: (t) => t.replace(/\.flac$/, ''),
        playTrack() { calls.push('play'); },
        pauseTrack() { calls.push('pause'); },
        prevTrack() { calls.push('prev'); },
        nextTrack() { calls.push('next'); },
        seekTo(t) { calls.push(['seek', t]); },
        loadTrack(i) { calls.push(['load', i]); },
        setPlayMode(i) {
            app.currentPlayMode = i % 3;
            app.modeBtn.title = ['列表循环', '单曲循环', '随机播放'][app.currentPlayMode];
        },
        stageHost: { toggle() { calls.push('stage'); }, enter() { calls.push('enter'); }, modeId: 'luminous', setMode(id) { calls.push(['mode', id]); } }
    };
    app.volumeSlider.addEventListener('input', () => calls.push(['volume', app.volumeSlider.value]));
    if (patch) patch(app, window);
    const dock = window.initMusicDock(app);
    return { dom, window, doc, app, dock, calls };
}

test('dock drives the existing player methods and keeps the old slider as the volume path', async () => {
    const { window, doc, app, dock, calls } = setup();
    try {
        assert.equal(doc.body.style.getPropertyValue('--music-dock-safe-bottom'), '96px');
        assert.ok(doc.body.classList.contains('music-dock-on'));

        doc.querySelector('[data-md="play"]').click();
        assert.deepEqual(calls.pop(), 'play');
        app.isPlaying = true;
        doc.body.classList.add('music-playing');
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        assert.equal(doc.querySelector('[data-md="play"]').getAttribute('aria-label'), '暂停');
        doc.querySelector('[data-md="play"]').click();
        assert.equal(calls.pop(), 'pause');

        doc.querySelector('[data-md="next"]').click();
        assert.equal(calls.pop(), 'next');
        doc.querySelector('[data-md="mode"]').click();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        assert.equal(doc.querySelector('[data-md="mode"]').getAttribute('aria-label'), '单曲循环');

        app.trackTitle.textContent = 'Beta';
        app.currentTrackIndex = 1;
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        assert.equal(doc.querySelector('[data-md="title"]').textContent, 'Beta');

        dock.openPanel('控制');
        assert.ok(doc.querySelector('.md-pnl').classList.contains('md-open'));
        assert.equal(doc.querySelector('.md-pct').textContent, '50%');
        doc.querySelector('[data-act="mute"]').click();
        assert.deepEqual(calls.pop(), ['volume', '0']);
        doc.querySelector('[data-act="mute"]').click();
        assert.deepEqual(calls.pop(), ['volume', '0.5']);

        // 舞台那一行只在舞台里出现
        assert.equal(doc.querySelector('[data-act="scene-step"]'), null);
        app.isStageActive = true;
        dock.openPanel('控制');
        doc.querySelector('[data-act="scene-step"][data-d="1"]').click();
        assert.deepEqual(calls.pop(), ['mode', 'partita']);
        app.isStageActive = false;

        window.MusicIntro = { replay() { calls.push('intro'); } };
        dock.openPanel('控制');
        doc.querySelector('[data-act="intro"]').click();
        assert.equal(calls.pop(), 'intro');
        assert.equal(dock.panelOpen, false);

        dock.openPanel('歌词');
        const lines = doc.querySelectorAll('.md-lyrl p');
        assert.equal(lines.length, 2);
        lines[1].click();
        assert.deepEqual(calls.pop(), ['seek', 9]);

        dock.openPanel('播放列表');
        assert.equal(doc.querySelector('.md-qh span').textContent, '1', 'upcoming count leaves out the playing track');

        // 音效设置不再是子页：它就是「声音」页，卡片搬进这一页，离开这一页或关掉面板就放回原处。
        dock.openSheet();
        assert.equal(dock.tab, '声音');
        assert.equal(doc.getElementById('dsp').parentElement.dataset.md, 'fx-scroll', 'sound settings sit in the sound tab');
        assert.equal(doc.querySelector('[data-md="fx-scroll"]').hidden, false);
        assert.equal(dock.soundSettingsOpen, true);
        assert.equal(doc.querySelector('[data-act="fx"]'), null, 'no second entry that leads to another page');
        dock.openPanel('播放列表');
        assert.equal(doc.getElementById('dsp').parentElement.className, 'main-content', 'leaving the tab returns the card');
        assert.equal(doc.querySelector('[data-md="fx-scroll"]').hidden, true);
        app.openMusicControls('sound');
        assert.equal(dock.tab, '声音');
        assert.equal(doc.getElementById('dsp').parentElement.dataset.md, 'fx-scroll');

        doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(dock.panelOpen, false);

        doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
        const palette = doc.querySelector('.md-cmd');
        assert.equal(palette.hidden, false);
        const input = palette.querySelector('.md-cmd-in');
        input.value = 'beta';
        input.dispatchEvent(new window.Event('input'));
        assert.equal(palette.querySelector('.md-cmd-row .md-cmd-title').textContent, 'Beta');
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        assert.deepEqual(calls.pop(), ['load', 1]);
        assert.ok(!palette.classList.contains('md-open'));
        assert.notEqual(doc.activeElement, input);
        // 回车放歌后焦点不能卡在已关闭的输入框里，再按 Ctrl+K 要能重新打开
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
        assert.ok(doc.body.classList.contains('music-dock-cmd-open'));
        assert.equal(palette.querySelector('.md-cmd-row .md-cmd-grp').textContent, '最近');
        input.value = '音量 30';
        input.dispatchEvent(new window.Event('input'));
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        assert.deepEqual(calls.pop(), ['volume', '0.3']);
    } finally {
        dock.destroy();
        assert.equal(doc.getElementById('music-dock-root').innerHTML, '');
        assert.ok(!doc.body.classList.contains('music-dock-on'));
        window.close();
    }
});

test('music.html loads the dock after music.js and music.js starts it once', () => {
    const html = read('Musicmodules/music.html');
    const block = html.slice(html.indexOf('<!-- music-dock -->'), html.indexOf('<!-- /music-dock -->'));
    assert.ok(block.includes('music-dock/music-dock.css'));
    assert.ok(block.includes('id="music-dock-root"'));
    assert.ok(html.indexOf('music-dock/music-dock.js') > html.indexOf('src="music.js"'));
    const js = read('Musicmodules/music.js');
    assert.equal(js.split('initMusicDock(app)').length - 1, 1);
});

test('command palette parses --filters and ranks title hits above artist hits', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(read('Musicmodules/music-dock/music-dock-palette.js'));
    const { parseQuery, scoreTrack } = dom.window.MusicDockPaletteQuery;
    const q = parseQuery('夜 --歌手 远 舟 --al Demo');
    assert.equal(q.text, '夜');
    assert.equal(q.artist, '远 舟');
    assert.equal(q.album, 'Demo');
    const english = parseQuery('rain --artist tidal');
    assert.equal(english.artist, 'tidal');
    const track = { title: '夜航.flac', artist: '远舟', album: 'Demo' };
    const strip = (t) => t.replace(/\.flac$/, '');
    assert.ok(scoreTrack(track, parseQuery('夜航'), strip) > scoreTrack(track, parseQuery('远舟'), strip));
    assert.equal(scoreTrack(track, parseQuery('--歌手 别人'), strip), -1);
    assert.equal(scoreTrack(track, parseQuery('不存在'), strip), -1);
    dom.window.close();
});

test('Tab stays inside the open panel: from the tabs it wraps to the close button and back into the panel', async () => {
    const { window, doc, dock } = setup((app, win) => { win.Element.prototype.getClientRects = function () { return [{}]; }; });
    try {
        dock.openPanel('控制');
        const tab = doc.querySelector('[data-md="tabs"] [aria-selected="true"]');
        assert.equal(doc.activeElement, tab, 'opening focuses the current tab');
        const press = (shiftKey = false) => {
            const event = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
            doc.activeElement.dispatchEvent(event);
            return event.defaultPrevented;
        };
        assert.equal(press(), true);
        assert.equal(doc.activeElement.getAttribute('aria-label'), '关闭面板', 'after the tabs comes the close button, not the page behind');
        press();
        const pnl = doc.getElementById('music-dock-panel');
        assert.ok(pnl.contains(doc.activeElement), 'then back to the top of the panel');
        press(true);
        assert.equal(doc.activeElement.getAttribute('aria-label'), '关闭面板');
        dock.closePanel?.();
    } finally {
        dock.destroy?.();
    }
});

test('queue heading uses the playing playlist\'s current name after it is renamed', async () => {
    const { doc, app, dock } = setup();
    try {
        const [, b] = app.playlist;
        app.getUpNext = () => ({ manual: [], context: [b] });
        app.currentFilteredTracks = [b];
        app.filteredPlaylistSource = { type: 'playlist', id: '7', name: '通勤' };
        app.customPlaylists = [{ id: '7', name: '早上通勤', tracks: [b.path] }];
        app.playbackSourceName = () => app.customPlaylists.find((p) => p.id === app.filteredPlaylistSource.id)?.name || app.filteredPlaylistSource.name;
        dock.openPanel('播放列表');
        assert.equal(doc.querySelector('.md-qhd span:first-child').textContent, '接着播放 · 早上通勤');
    } finally {
        dock.destroy?.();
    }
});

test('queue page shows now playing, the manual layer and the real upcoming order, and edits the manual layer', async () => {
    const { window, doc, app, dock, calls } = setup();
    try {
        const [a, b] = app.playlist;
        const c = { path: 'C:/c.flac', title: 'Gamma.flac', artist: 'C' };
        app.playlist.push(c);
        app.manualQueue = [c, b];
        app.getUpNext = () => ({ manual: app.manualQueue.slice(), context: [b, c] });
        app.queueRemove = (i) => { calls.push(['qremove', i]); app.manualQueue.splice(i, 1); doc.dispatchEvent(new window.Event('music-queue-change')); };
        app.queueMove = (f, t) => { calls.push(['qmove', f, t]); };
        app.queueClear = () => { calls.push('qclear'); };
        app.queuePlayNext = (t) => { calls.push(['qnext', t.path]); return t; };
        dock.openPanel('播放列表');
        const titles = () => [...doc.querySelectorAll('.md-ql .md-qi b')].map((n) => n.textContent);
        assert.deepEqual(titles(), ['Alpha', 'Gamma', 'Beta', 'Beta', 'Gamma']);
        assert.deepEqual([...doc.querySelectorAll('.md-qhd span:first-child')].map((n) => n.textContent), ['接下来播放', '接着播放 · 全部曲目']);
        assert.equal(doc.querySelector('.md-qh span').textContent, '4');

        doc.querySelectorAll('.md-man [data-qact="remove"]')[1].click();
        assert.deepEqual(calls.pop(), ['qremove', 1]);
        assert.deepEqual(titles(), ['Alpha', 'Gamma', 'Beta', 'Gamma'], 'repaints on music-queue-change');

        doc.querySelector('.md-qi:not(.md-man):not(.md-now) [data-qact="next"]').click();
        assert.deepEqual(calls.pop(), ['qnext', 'C:/b.flac']);

        doc.querySelector('.md-man [data-qact="play"]').click();
        assert.deepEqual(calls.pop(), ['load', 2]);
        assert.deepEqual(calls.pop(), ['qremove', 0]);

        app.manualQueue = [b, c];
        doc.dispatchEvent(new window.Event('music-queue-change'));
        const row = doc.querySelector('.md-man');
        const fire = (type, y, target = row) => target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientY: y, button: 0 }));
        fire('pointerdown', 100);
        fire('pointermove', 102, doc);
        assert.ok(!row.classList.contains('md-qdrag'), 'under 4px is still a click');
        fire('pointermove', 150, doc);
        assert.ok(row.classList.contains('md-qdrag'));
        fire('pointerup', 150, doc);
        assert.deepEqual(calls.pop(), ['qmove', 0, 1]);
        await new Promise((resolve) => window.setTimeout(resolve, 0));

        doc.querySelector('[data-qact="clear"]').click();
        assert.equal(calls.pop(), 'qclear');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('palette groups songs, playlists and commands; shift/ctrl+enter queue; pinyin search uses the archive index', () => {
    const { window, doc, app, dock, calls } = setup();
    try {
        window.eval(read('Musicmodules/music-archive/archive-index.js'));
        const PY = { 夜: 'ye', 航: 'hang' };
        window.pinyinPro = { pinyin: (c) => PY[c] || '' };
        app.playlist.push({ path: 'C:/y.flac', title: '夜航.flac', artist: '远舟', album: 'Demo' });
        app.customPlaylists = [{ id: 'p1', name: 'Beta Mix', tracks: ['C:/b.flac', 'C:/y.flac'] }];
        app.queuePlayNext = (t) => { calls.push(['qnext', t.path]); return t; };
        app.queueAdd = (t) => { calls.push(['qadd', t.path]); return t; };
        app.renderPlaylist = () => {};
        const seen = [];
        doc.addEventListener('keydown', (e) => seen.push(e.key));

        dock.openPalette();
        const palette = doc.querySelector('.md-cmd');
        const input = palette.querySelector('.md-cmd-in');
        const type = (text) => { input.value = text; input.dispatchEvent(new window.Event('input')); };
        const key = (k, extra = {}) => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));

        type('yh');
        assert.equal(palette.querySelector('.md-cmd-row .md-cmd-title').textContent, '夜航', 'initials find the Chinese title');
        type('beta');
        assert.deepEqual([...palette.querySelectorAll('.md-cmd-sec')].map((n) => n.textContent), ['歌曲', '歌单']);
        assert.equal(palette.querySelector('.md-cmd-foot').hidden, false);
        key('Enter', { shiftKey: true });
        assert.deepEqual(calls.pop(), ['qnext', 'C:/b.flac']);
        assert.ok(palette.classList.contains('md-open') || !palette.hidden, 'stays open after queueing');
        key('Enter', { ctrlKey: true });
        assert.deepEqual(calls.pop(), ['qadd', 'C:/b.flac']);

        // 歌单那一行：Ctrl+回车整单入队，回车把歌单设成当前列表并播放
        const rows = [...palette.querySelectorAll('.md-cmd-row')];
        const plRow = rows.find((r) => r.querySelector('.md-cmd-title').textContent === 'Beta Mix');
        plRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
        assert.deepEqual(calls.splice(-2), [['qadd', 'C:/b.flac'], ['qadd', 'C:/y.flac']]);
        plRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        assert.deepEqual(calls.pop(), ['load', 1]);
        assert.equal(app.filteredPlaylistSource.id, 'p1');
        assert.equal(app.currentFilteredTracks.length, 2);

        dock.openPalette();
        type('下一');
        assert.equal(palette.querySelector('.md-cmd-sec').textContent, '命令');
        assert.equal(palette.querySelector('.md-cmd-foot').hidden, true);
        key('k');
        assert.ok(!seen.includes('k'), 'single keys typed in the palette do not reach window shortcuts');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('capsule volume slot: wheel adjusts, click and M mute and restore', () => {
    const { window, doc, app, dock, calls } = setup();
    try {
        const slot = doc.querySelector('[data-md="vol"]');
        assert.ok(slot);
        const wheel = (deltaY) => slot.dispatchEvent(new window.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
        wheel(-100);
        assert.deepEqual(calls.pop(), ['volume', '0.55']);
        wheel(40); wheel(40);
        assert.equal(calls.filter((c) => c[0] === 'volume').length, 0, 'small trackpad deltas accumulate first');
        wheel(40);
        assert.deepEqual(calls.pop(), ['volume', '0.5']);
        slot.click();
        assert.deepEqual(calls.pop(), ['volume', '0']);
        assert.equal(slot.getAttribute('aria-label'), '取消静音');
        doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'm', bubbles: true }));
        assert.deepEqual(calls.pop(), ['volume', '0.5'], 'M restores the volume from before muting');
        const field = doc.createElement('input');
        doc.body.appendChild(field);
        field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'm', bubbles: true }));
        assert.equal(calls.filter((c) => c[0] === 'volume').length, 0, 'typing m in a text field does nothing');
        assert.equal(app.volumeSlider.value, '0.5');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('controls tab offers the window-wide reduce-motion setting and follows outside changes', () => {
    const { window, doc, dock } = setup();
    try {
        const sets = [];
        let pref = 'system';
        window.MusicMotion = {
            PREFERENCES: [{ value: 'system', label: '跟随系统' }, { value: 'on', label: '开' }, { value: 'off', label: '关' }],
            get preference() { return pref; },
            set(v) { sets.push(v); pref = v; },
            reduced: () => pref === 'on'
        };
        dock.openPanel('控制');
        const seg = () => doc.querySelector('.md-seg[data-act="motion"]');
        assert.equal(seg().querySelector('button.md-on').textContent, '跟随系统');
        seg().querySelectorAll('button')[1].click();
        assert.deepEqual(sets, ['on']);
        assert.equal(seg().querySelector('button.md-on').textContent, '开');
        pref = 'off';
        window.dispatchEvent(new window.Event('music-motion-change'));
        assert.equal(seg().querySelector('button.md-on').textContent, '关');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('window keymap: space without repeat, seek, track and volume keys, help, input and archive guards', () => {
    const { window, doc, app, dock, calls } = setup();
    try {
        const key = (k, extra = {}, target = doc.body) => {
            const e = new window.KeyboardEvent('keydown', { key: k, code: extra.code || (k === ' ' ? 'Space' : ''), bubbles: true, cancelable: true, ...extra });
            target.dispatchEvent(e);
            return e.defaultPrevented;
        };
        const later = [];
        doc.addEventListener('keydown', (e) => later.push(e.key)); // 档案页这种在冒泡阶段的监听

        assert.equal(key(' '), true);
        assert.equal(calls.pop(), 'play');
        key(' ', { repeat: true });
        key(' ');
        assert.equal(calls.length, 0, 'holding space does not toggle again');
        doc.dispatchEvent(new window.KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
        key(' ');
        assert.equal(calls.pop(), 'play');
        assert.ok(!later.includes(' '), 'handled keys do not reach later listeners');

        app.lastKnownCurrentTime = 50; app.lastStateUpdateTime = Date.now();
        key('ArrowRight');
        assert.deepEqual(calls.pop(), ['seek', 55]);
        key('ArrowLeft', { shiftKey: true });
        assert.equal(calls.pop(), 'prev');
        key('ArrowUp', { ctrlKey: true });
        assert.deepEqual(calls.pop(), ['volume', '0.55']);

        app.archiveView = { mode: 'archive' };
        later.length = 0;
        key('ArrowRight');
        assert.equal(calls.length, 0, 'archive keeps the arrow keys for picking songs');
        assert.deepEqual(later, ['ArrowRight']);
        key('ArrowRight', { shiftKey: true });
        assert.equal(calls.pop(), 'next', 'shift+arrow still switches tracks on the archive page');
        later.length = 0;
        assert.equal(key('m'), false); assert.equal(key('?'), false);
        assert.equal(calls.length, 0, 'typing on the archive page goes to its search, not mute or help');
        assert.deepEqual(later, ['m', '?']);
        assert.equal(doc.querySelector('.md-keys'), null);
        app.archiveView = { mode: 'classic' };

        const field = doc.createElement('input');
        doc.body.appendChild(field);
        key(' ', {}, field); key('m', {}, field); key('?', {}, field);
        assert.equal(calls.length, 0, 'single keys in a text field are left for typing');

        key('?');
        const help = doc.querySelector('.md-keys');
        assert.ok(help && !help.hidden);
        assert.ok(help.textContent.includes('按住不会连续切换'));
        key('Escape');
        assert.ok(help.hidden);
    } finally {
        dock.destroy();
        window.close();
    }
});

test('the bar body is not a stage button: clicking blank space does nothing, the stage slot enters, search only opens with Ctrl+K', () => {
    const { window, doc, app, dock, calls } = setup();
    try {
        const cap = doc.querySelector('.md-cap');
        cap.click();
        assert.ok(!calls.includes('enter'), 'blank space no longer enters the stage');
        assert.equal(cap.getAttribute('title'), null, 'no "click to enter the stage" hint left on the bar');
        doc.querySelector('[data-md="stage"]').click();
        assert.equal(calls.pop(), 'stage', 'the stage slot is the way in');
        assert.ok(!doc.body.classList.contains('music-dock-cmd-open'), 'no accidental search popup');
        assert.equal(doc.querySelector('[data-q="panel"]'), null, 'quick row has no search button');
        doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
        assert.ok(doc.body.classList.contains('music-dock-cmd-open'));
        assert.equal(doc.querySelectorAll('.md-cmd-row').length, 0, 'empty search lists no player commands');
    } finally {
        dock.destroy();
    }
});

test('hovering the title edges keeps the title; prev / next are plain buttons with honest tooltips', () => {
    const { window, doc, app, dock, calls } = setup();
    try {
        const title = doc.querySelector('[data-md="title"]').textContent;
        doc.querySelector('.md-zone.md-l').dispatchEvent(new window.Event('pointerenter'));
        doc.querySelector('.md-zone.md-r').dispatchEvent(new window.Event('pointerenter'));
        assert.ok(!doc.querySelector('.md-tnav').classList.contains('md-previewing'), 'no title swap on hover');
        assert.equal(doc.querySelector('[data-md="title"]').textContent, title);
        const prev = doc.querySelector('[data-md="prev"]');
        app.prevRestarts = () => true;
        prev.dispatchEvent(new window.Event('pointerenter'));
        assert.match(prev.title, /回到本曲开头/);
        app.prevRestarts = () => false;
        prev.dispatchEvent(new window.Event('pointerenter'));
        assert.equal(prev.title, '上一首');
        doc.querySelector('[data-md="next"]').click();
        assert.equal(calls.pop(), 'next');
    } finally {
        dock.destroy();
    }
});

test('panel closed: the ring is the playhead; panel open: the ring is the close button and the progress strip seeks', () => {
    const { window, doc, app, dock, calls } = setup();
    try {
        const cap = doc.querySelector('.md-cap');
        const trk = doc.querySelector('.md-trk');
        const rect = (left, width, top = 0, height = 64) => () => ({ left, width, right: left + width, top, height, bottom: top + height, x: left, y: top });
        cap.getBoundingClientRect = rect(0, 1000);
        trk.getBoundingClientRect = rect(0, 1000, 47, 14);
        cap.querySelector('.md-txt').getBoundingClientRect = rect(100, 300, 12, 22);
        cap.querySelector('.md-slots').getBoundingClientRect = rect(814, 170, 15, 34);
        app.lastKnownDuration = 200;
        app.lastKnownCurrentTime = 20;
        app.lastStateUpdateTime = Date.now();
        const popSeek = () => { const c = calls.pop(); return Array.isArray(c) ? [c[0], Math.round(c[1])] : c; };
        const ptr = (type, x) => trk.dispatchEvent(new window.MouseEvent(type, { clientX: x, button: 0, bubbles: true, cancelable: true }));
        // 面板关着：白环是播放头，细轨藏着
        const handle = doc.querySelector('[data-md="handle"]');
        const root = doc.getElementById('music-dock-root');
        assert.equal(dock.ringMode, 'playhead');
        assert.equal(handle.getAttribute('aria-describedby'), 'music-dock-playhead-tip');
        assert.ok(!root.classList.contains('md-panel-open'));
        doc.querySelector('[data-md="panel"]').click();
        assert.ok(root.classList.contains('md-panel-open'), 'the strip shows only while the panel is open');
        // 0% 在歌名左缘（100px），100% 在按钮组前 14px（800px）
        ptr('pointerdown', 450);
        ptr('pointerup', 450);
        assert.deepEqual(popSeek(), ['seek', 100], 'a plain press jumps to that point');
        ptr('pointerdown', 100);
        ptr('pointermove', 800);
        assert.equal(doc.querySelector('[data-md="seek-tip"]').textContent, '03:20');
        ptr('pointerup', 800);
        assert.deepEqual(popSeek(), ['seek', 200]);
        assert.ok(!calls.includes('enter') && !calls.includes('stage'), 'seeking never opens the stage');

        // 面板开着细轨能拖，不影响面板
        assert.equal(dock.panelOpen, true);
        assert.equal(doc.querySelector('[data-md="panel"]').getAttribute('aria-expanded'), 'true');
        ptr('pointerdown', 275);
        ptr('pointerup', 275);
        assert.deepEqual(popSeek(), ['seek', 50]);
        assert.equal(dock.panelOpen, true, 'seeking leaves the panel alone');

        // 面板开着时白环是关闭键
        assert.equal(handle.hasAttribute('aria-describedby'), false);
        handle.click();
        assert.equal(dock.panelOpen, false);
        assert.equal(doc.querySelector('[data-md="panel"]').getAttribute('aria-expanded'), 'false');

        // 键盘：进度细轨本身是 slider，方向键 ±5 秒
        trk.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        assert.deepEqual(popSeek(), ['seek', 25]);
    } finally {
        dock.destroy();
    }
});

test('lyrics tab: translation toggle and ±0.5 s offset buttons drive the player', () => {
    const { doc, app, dock } = setup();
    try {
        app.currentLyrics = [{ time: 3, text: '第一句', translation: 'first' }, { time: 9, text: '第二句' }];
        app.lyricsTranslation = true;
        app.lyricOffset = 0;
        const seen = [];
        app.setLyricsTranslation = (on) => { seen.push(['tr', on]); app.lyricsTranslation = on; };
        app.shiftLyrics = (d) => { seen.push(['shift', d]); app.lyricOffset += d; };
        app.setLyricOffset = (v) => { seen.push(['set', v]); app.lyricOffset = v; };
        dock.openPanel('歌词');
        assert.equal(doc.querySelector('.md-lyrl .md-tr').textContent, 'first');
        const tr = doc.querySelector('[data-act="lyr-tr"]');
        assert.equal(tr.getAttribute('aria-pressed'), 'true');
        tr.click();
        assert.deepEqual(seen.pop(), ['tr', false]);
        assert.equal(doc.querySelector('[data-act="lyr-tr"]').getAttribute('aria-pressed'), 'false');

        doc.querySelector('[data-act="lyr-off"][data-d="0.5"]').click();
        assert.deepEqual(seen.pop(), ['shift', 0.5]);
        assert.equal(doc.querySelector('[data-act="lyr-off0"]').textContent, '+0.5 秒');
        doc.querySelector('[data-act="lyr-off"][data-d="-0.5"]').click();
        doc.querySelector('[data-act="lyr-off"][data-d="-0.5"]').click();
        assert.equal(doc.querySelector('[data-act="lyr-off0"]').textContent, '−0.5 秒');
        doc.querySelector('[data-act="lyr-off0"]').click();
        assert.deepEqual(seen.pop(), ['set', 0]);
        assert.equal(doc.querySelector('[data-act="lyr-off0"]').textContent, '0.0 秒');

        app.currentLyrics = [{ time: 1, text: '没有翻译' }];
        dock.openPanel('歌词');
        assert.ok(doc.querySelector('[data-act="lyr-tr"]').disabled, 'no translation in this song: the toggle is greyed out');
    } finally { dock.destroy(); }
});

test('fluid bar: no up-next titles on the bar, volume drop rail, ring docking and the energy-saving fallback', () => {
    const { window, doc, app, dock, calls } = setup();
    try {
        const root = doc.getElementById('music-dock-root');
        assert.ok(root.classList.contains('md-fl-on'), 'fluid layer is on by default');
        assert.ok(doc.querySelector('.md-fluid'), 'svg layer mounted');
        assert.equal(dock.ringMode, 'playhead', 'the ring is the playhead while the panel is closed');
        assert.equal(doc.querySelector('.md-nx, [data-md="nx1"], [data-md="nx2"]'), null, 'next / after-next titles are gone');
        const slots = [...doc.querySelectorAll('.md-slots > button:not([hidden])')].map((b) => b.dataset.md);
        assert.deepEqual(slots, ['mode', 'stage', 'more', 'panel'], 'play order, stage, more and panel sit on the bar');

        // 音量：滚轮直接分裂出水滴和竖条；单击仍然是静音
        const slot = doc.querySelector('[data-md="vol"]');
        slot.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
        assert.ok(root.classList.contains('md-vopen'));
        assert.equal(doc.querySelector('.md-vrail').getAttribute('aria-hidden'), 'false');
        assert.equal(doc.querySelector('.md-vrail').getAttribute('aria-valuenow'), '55');
        doc.querySelector('.md-vrail').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        assert.equal(app.volumeSlider.value, '0.5');

        // 节能档：不跑流体层，退成不透明的实色
        let notify = null;
        window.MusicStageConfig.get = () => ({ quality: 'energy-saving' });
        window.MusicStageConfig.subscribe = (fn) => { notify = fn; return () => {}; };
        dock.destroy();
        const again = window.initMusicDock(app);
        assert.ok(root.classList.contains('md-fl-low'));
        assert.equal(doc.querySelector('.md-fluid'), null);
        window.MusicStageConfig.get = () => ({ quality: 'standard' });
        notify();
        assert.ok(root.classList.contains('md-fl-on'));
        assert.ok(doc.querySelector('.md-fluid'));
        again.openPanel('控制');
        assert.equal(app.musicDock.panelOpen, true);
        again.destroy();
        assert.equal(doc.querySelector('.md-fluid'), null, 'destroy removes the svg layer');
    } finally { dock.destroy(); }
});

test('stage settings sit on the control page itself: each part is moved in, common ones first, no subpage, and moved back on destroy', () => {
    const { window, doc, app, dock, calls } = setup();
    dock.destroy();
    const stage = doc.createElement('div');
    stage.id = 'music-stage';
    const row = (key, label, control) => `<label class="music-stage-tuning-row"><span class="music-stage-tuning-label">${label}</span><span class="music-stage-tuning-value"></span>${control.replace('>', ` data-stage-config-key="${key}">`)}</label>`;
    const keys = [['vectorDecor', '矢量装饰'], ['rain', '雨（节能档减量）'], ['a', '甲'], ['b', '乙'], ['c', '丙'], ['d', '丁'], ['fontScale', '文字比例'], ['showTranslation', '翻译／罗马音'], ['glow', '辉光强度']];
    stage.innerHTML = `<aside class="music-stage-settings"><button class="music-stage-settings-toggle"></button>
        <section class="music-stage-settings-card" hidden><div class="music-stage-settings-body">
        <section class="music-stage-settings-section"><div class="music-stage-mode-options"><input type="checkbox" data-stage-config-mode="partita"></div></section>
        <section class="music-stage-settings-section"><div class="music-stage-tuning-controls">${keys.map(([k, l]) => row(k, l, '<input type="checkbox">')).join('')}</div></section>
        <section class="music-stage-settings-section"><div class="music-stage-common-controls"></div></section></div>
        <div class="music-stage-settings-footer"><button class="music-stage-settings-reset">恢复出厂编排</button></div></section></aside>`;
    doc.body.appendChild(stage);
    const body = stage.querySelector('.music-stage-settings-body');
    const tuning = stage.querySelector('.music-stage-tuning-controls');
    let changes = 0;
    stage.querySelector('.music-stage-mode-options').addEventListener('change', () => { changes += 1; });
    const again = window.initMusicDock(app);
    try {
        assert.ok(doc.querySelector('[data-md="tune-slot"] .music-stage-tuning-controls') === tuning, 'moved, not rebuilt');
        assert.ok(doc.querySelector('[data-md="common-slot"] .music-stage-common-controls'));
        assert.ok(doc.querySelector('[data-md="array-slot"] .music-stage-mode-options'));
        assert.ok(doc.querySelector('[data-md="adv-acts"] .music-stage-settings-reset'));
        assert.ok(doc.body.classList.contains('music-dock-stage-settings'), 'old drawer is hidden by css');

        // 舞台专属设置直接在控制页里：没有子页，演出时面板一开就看得见。
        app.isStageActive = true;
        again.openPanel('控制');
        assert.equal(doc.querySelector('[data-md="ext"]').hidden, false);
        assert.equal(doc.querySelector('.md-pnl').classList.contains('md-sub'), false);
        assert.equal(doc.querySelector('[data-md="tune-title"]').textContent, '流光设置');
        assert.equal(again.stageSettingsOpen, true);
        // 长名字拆成名字加一行说明；常用项排前面，其余收在「全部 N 项」里
        const rows = [...tuning.children];
        assert.equal(rows.length, 9);
        assert.equal(rows[0].querySelector('[data-stage-config-key]').dataset.stageConfigKey, 'fontScale', 'common ones first');
        const noted = tuning.querySelector('.md-tune-note');
        assert.equal(noted.textContent, '节能档减量');
        assert.equal(noted.parentElement.firstChild.textContent, '雨');
        assert.equal(tuning.querySelectorAll('.md-tune-rest').length, 9 - 3);
        const more = doc.querySelector('[data-md="tune-more"]');
        assert.equal(more.hidden, false);
        assert.match(more.textContent, /全部 9 项/);
        assert.equal(doc.querySelector('[data-md="tune-slot"]').classList.contains('md-tune-all'), false);
        more.click();
        assert.equal(doc.querySelector('[data-md="tune-slot"]').classList.contains('md-tune-all'), true);
        assert.equal(more.getAttribute('aria-expanded'), 'true');

        // 舞台一行点开是原地的舞台格子
        doc.querySelector('[data-act="scene-pick"]').click();
        assert.equal(doc.querySelector('[data-act="scene-pick"]').getAttribute('aria-expanded'), 'true');
        doc.querySelector('.md-scn [data-mode="partita"]').click();
        assert.deepEqual(calls.pop(), ['mode', 'partita']);
        doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(doc.querySelector('.md-scn'), null, 'Esc folds the stage grid first');
        assert.equal(again.panelOpen, true);

        // 搬进来的控件上原有的事件还在
        doc.querySelector('[data-md="array-slot"] input').dispatchEvent(new window.Event('change', { bubbles: true }));
        assert.equal(changes, 1);

        // 「更多」默认收起
        const adv = doc.querySelector('[data-md="adv-body"]');
        assert.equal(adv.hidden, true);
        doc.querySelector('[data-md="adv-toggle"]').click();
        assert.equal(adv.hidden, false);

        again.openPanel('播放列表');
        assert.equal(doc.querySelector('[data-md="ext"]').hidden, true, 'the stage part only shows on the control tab');
        assert.equal(again.stageSettingsOpen, false);
        app.openMusicControls('stage');
        assert.equal(again.tab, '控制');
    } finally {
        again.destroy();
    }
    assert.ok(body.querySelector('.music-stage-tuning-controls') === tuning, 'moved back home');
    assert.ok(body.querySelector('.music-stage-mode-options'));
    assert.ok(stage.querySelector('.music-stage-settings-card > .music-stage-settings-footer'));
    assert.equal(app.openMusicControls, undefined);
    assert.ok(!doc.body.classList.contains('music-dock-stage-settings'));
});

test('fluid colours follow the theme accent, keep scene colours on themed stages and fall back for grey accents', async () => {
    const { window, doc, app, dock } = setup();
    try {
        const hue = (hex) => {
            const n = parseInt(hex.slice(1), 16);
            const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (max === min) return null;
            const d = max - min;
            const h = max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
            return ((h * 60) + 360) % 360;
        };
        doc.documentElement.style.setProperty('--highlight-text', '#2f6fd0');
        const blue = dock.glowColors;
        assert.ok(Math.abs(hue(blue[0]) - 216) < 6, `blue theme gives a blue glow (${blue[0]})`);
        doc.body.classList.add('light-theme');
        const blueLight = dock.glowColors;
        assert.equal(blueLight[2], '#ffffff', 'light glow fades to white');
        assert.ok(Math.abs(hue(blueLight[0]) - 216) < 6);

        doc.documentElement.style.setProperty('--highlight-text', '#808080');
        assert.ok(Math.abs(hue(dock.glowColors[0]) - 22) < 6, 'grey accent falls back to the warm default');

        // 有自己色调的舞台用自己的颜色
        doc.body.classList.add('music-stage-active');
        app.isStageActive = true;
        app.stageHost = { ...(app.stageHost || {}), modeId: 'tunnel' };
        assert.equal(dock.glowColors[0], '#4fa597');
        doc.body.classList.remove('light-theme');
        app.stageHost.modeId = 'kowloon';
        assert.equal(dock.glowColors[0], '#d24a8d');

        // 节能档的实色进度底也跟着强调色
        await new Promise((r) => setTimeout(r, 0));
        assert.ok(doc.getElementById('music-dock-root').style.getPropertyValue('--md-fl-low-fill'), 'low tier fill is tinted');
    } finally { dock.destroy(); }
});

test('fluid layer schedules no animation frames once it is at rest, when hidden, or when the window is unfocused', () => {
    const dom = new JSDOM('<!doctype html><body><div id="host"><div class="md-dock"><div class="md-cap" id="bar"></div></div><div id="ring"></div></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    window.eval(read('Musicmodules/music-dock/music-dock-fluid.js'));
    // 模拟时钟：rAF 只进队列，由测试一帧一帧推；数一共排了多少帧。
    let now = 1000;
    let queue = [];
    let scheduled = 0;
    window.performance.now = () => now;
    window.requestAnimationFrame = (cb) => { scheduled += 1; queue.push(cb); return scheduled; };
    window.cancelAnimationFrame = () => { queue = []; };
    const run = (ms) => {
        for (let t = 0; t < ms; t += 16) {
            now += 16;
            const batch = queue; queue = [];
            for (const cb of batch) cb(now);
        }
    };
    const bar = window.document.getElementById('bar');
    bar.getBoundingClientRect = () => ({ left: 300, right: 900, top: 620, bottom: 684, width: 600, height: 64 });
    const fluid = window.createMusicDockFluid({ host: window.document.getElementById('host'), bar, ring: window.document.getElementById('ring') });
    try {
        fluid.layout();
        fluid.setRingMode('playhead');
        fluid.setPlaying(true);
        fluid.setSolid(true);
        fluid.pointer(500);
        run(300);
        assert.ok(scheduled > 0, 'a state change does animate');
        // 指针离开、暂停：动画收尾以后就该彻底停下。
        fluid.pointer(null);
        fluid.setPlaying(false);
        fluid.setSolid(false);
        run(4000);
        assert.equal(queue.length, 0, 'the loop has ended');
        assert.equal(fluid.animating, false);
        const settled = scheduled;
        run(2000);
        assert.equal(scheduled, settled, 'no frames in 2 s of rest');

        // 播放中：进度没走满一个像素不动；走满了也只是直接落位，不起动画帧。
        fluid.setPlaying(true);
        fluid.setSolid(true);
        run(4000);
        const playing = scheduled;
        const mask = () => window.document.querySelector('linearGradient stop:nth-child(2)').getAttribute('offset');
        fluid.setProgress(0.5);           // 大跳（相当于拖动）：走动画
        run(4000);
        assert.equal(fluid.animating, false);
        const before = mask();
        const afterJump = scheduled;
        fluid.setProgress(0.5 + 0.4 / 600);   // 不到一个像素
        assert.equal(mask(), before, 'sub-pixel progress leaves the mask alone');
        fluid.setProgress(0.5 + 2.5 / 528);   // 两个多像素（进度区间宽 600 × 0.88）
        assert.notEqual(mask(), before, 'a whole pixel moves the mask');
        run(2000);
        assert.equal(scheduled, afterJump, 'steady playback needs no animation frames');
        assert.ok(playing >= settled);

        // 页面帧率很低（3D 页面占着主线程，两帧隔 3 秒）：切到暂停再播放，动画也在十几帧内收尾，
        // 之后进度照常推进（每帧之间走了好几个像素）不再排帧。
        const slow = (frames) => { for (let i = 0; i < frames; i += 1) { now += 3000; fluid.setProgress(Math.min(1, fluid.debug().progress + 22 / 528)); const batch = queue; queue = []; for (const cb of batch) cb(now); } };
        fluid.setPlaying(false); fluid.setSolid(false);
        slow(30);
        fluid.setPlaying(true); fluid.setSolid(true);
        slow(30);
        assert.equal(fluid.animating, false, 'settles within a few slow frames');
        const slowSteady = scheduled;
        slow(10);
        assert.equal(scheduled, slowSteady, 'slow steady playback schedules nothing');
        fluid.setProgress(0.5);
        run(4000);

        // 失焦：状态变化直接落位，不排帧。
        fluid.setSuspended(true);
        const suspended = scheduled;
        fluid.pointer(520); fluid.setVolumeOpen(true); fluid.setSolid(false);
        run(2000);
        assert.equal(scheduled, suspended, 'no frames while the window is unfocused');
        assert.equal(fluid.volumeOpen, true);
        fluid.setSuspended(false);

        // 不可见：什么都不画，回来时一次到位。
        fluid.setHidden(true);
        const hiddenMask = mask();
        fluid.setProgress(0.9); fluid.setVolumeOpen(false); fluid.split();
        run(2000);
        assert.equal(scheduled, suspended, 'no frames while hidden');
        assert.equal(mask(), hiddenMask, 'nothing is repainted while hidden');
        fluid.setHidden(false);
        assert.notEqual(mask(), hiddenMask, 'coming back paints the current progress once');
        run(2000);
        assert.equal(scheduled, suspended, 'and returning needs no animation either');
    } finally { fluid.destroy(); }
});

test('keyboard: focus enters and leaves the drawer, tabs rove with arrow keys, the progress strip seeks', () => {
    const { window, doc, app, dock, calls } = setup();
    try {
        const handle = doc.querySelector('[data-md="handle"]');
        const key = (node, k, extra = {}) => node.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));

        // 进度细轨：方向键跳转（白环不再当播放头）
        const trk = doc.querySelector('.md-trk');
        app.lastKnownCurrentTime = 50;
        app.lastStateUpdateTime = Date.now();
        trk.focus();
        key(trk, 'ArrowRight');
        assert.deepEqual(calls.pop(), ['seek', 55]);
        key(trk, 'ArrowLeft');
        assert.deepEqual(calls.pop(), ['seek', 45]);

        // 打开：焦点进抽屉，落在选中的页签上；页签是 tablist，只有选中的那个能 Tab 到
        const play = doc.querySelector('[data-md="play"]');
        play.focus();
        dock.openPanel('控制');
        const tabs = () => [...doc.querySelectorAll('[data-md="tabs"] [role="tab"]')];
        assert.equal(doc.querySelector('[data-md="tabs"]').getAttribute('aria-label'), '面板页签');
        assert.equal(doc.activeElement.textContent, '控制');
        assert.deepEqual(tabs().map((t) => t.tabIndex), [-1, -1, 0, -1, -1]);
        key(doc.activeElement, 'ArrowRight');
        assert.equal(doc.activeElement.textContent, '播放列表');
        assert.equal(doc.activeElement.getAttribute('aria-selected'), 'true');
        key(doc.activeElement, 'Home');
        assert.equal(doc.activeElement.textContent, '封面');
        key(doc.activeElement, 'ArrowLeft');
        assert.equal(doc.activeElement.textContent, '声音', 'wraps around');
        assert.equal(doc.getElementById('music-dock-panel-body').getAttribute('role'), 'tabpanel');

        // 没有子页了：演出时直达舞台设置，焦点落在舞台那一行上，页面里也没有返回按钮
        app.isStageActive = true;
        dock.openStageSettings();
        assert.equal(doc.activeElement.dataset.act, 'scene-pick');
        assert.equal(doc.activeElement.getAttribute('aria-expanded'), 'false');
        assert.equal(doc.querySelector('[data-md="fx-back"], [data-md="sp-back"]'), null);
        app.isStageActive = false;

        // 关闭：焦点回到打开前的地方
        dock.closePanel();
        assert.equal(doc.activeElement, play);
        // 焦点不在抽屉里时关闭不抢焦点
        handle.focus();
        dock.openPanel();
        app.volumeSlider.focus();
        dock.closePanel();
        assert.equal(doc.activeElement, app.volumeSlider);
    } finally { dock.destroy(); }
});

test('the bar keeps play order, stage, more and panel on the right; the quick row above "more" holds queue, effects and volume', () => {
    const { window, doc, dock } = setup();
    try {
        const bar = doc.querySelector('.md-cap');
        const more = doc.querySelector('[data-md="more"]');
        const quick = doc.querySelector('.md-quick');
        // 播放顺序、舞台、更多、面板常驻条上；喜欢的接口不在时心形不出现
        assert.deepEqual([...bar.querySelectorAll('.md-slots button')].filter((b) => !b.hidden).map((b) => b.dataset.md), ['mode', 'stage', 'more', 'panel']);
        assert.deepEqual([...quick.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.dataset.md || b.dataset.q), ['queue', 'fx', 'vol']);
        assert.equal(more.getAttribute('aria-expanded'), 'false');

        more.click();
        assert.ok(quick.classList.contains('md-show'));
        assert.equal(more.getAttribute('aria-expanded'), 'true');
        // 点过算钉住：指针离开底栏也不收
        doc.querySelector('.md-dock-in').dispatchEvent(new window.Event('pointerleave'));
        assert.ok(quick.classList.contains('md-show'), 'pinned by the click');
        bar.querySelector('[data-md="mode"]').click();
        assert.ok(quick.classList.contains('md-show'), 'changing the mode keeps the row open');
        more.click();
        assert.ok(!quick.classList.contains('md-show'), 'a second click closes it');

        more.click();
        quick.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.ok(!quick.classList.contains('md-show'), 'Esc closes it');

        more.click();
        doc.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
        assert.ok(!quick.classList.contains('md-show'), 'a press elsewhere closes it');

        more.click();
        quick.querySelector('[data-q="queue"]').click();
        assert.ok(!quick.classList.contains('md-show'), 'opening the queue puts the row away');
        assert.ok(doc.querySelector('.md-pnl').classList.contains('md-open'));
    } finally {
        dock.destroy();
        window.close();
    }
});

test('the heart on the bar follows the like API: click toggles, outside changes resync, only lighting up swells', () => {
    const liked = new Set();
    const { window, doc, app, dock } = setup((a, w) => {
        a.isLiked = (t) => Boolean(t && liked.has(t.path));
        a.toggleLike = (t) => {
            const on = !liked.has(t.path);
            if (on) liked.add(t.path); else liked.delete(t.path);
            w.document.dispatchEvent(new w.CustomEvent('music-like-change', { detail: { tracks: [t], liked: on } }));
        };
    });
    try {
        const heart = doc.querySelector('[data-md="like"]');
        assert.equal(heart.hidden, false);
        // 心形挪进了悬停时展开的快捷行；右侧槽位是播放模式、舞台、更多、面板
        assert.equal(heart.closest('.md-slots'), null);
        assert.deepEqual([...doc.querySelectorAll('.md-slots button')].filter((b) => !b.hidden).map((b) => b.dataset.md), ['mode', 'stage', 'more', 'panel']);
        assert.equal(heart.getAttribute('aria-pressed'), 'false');
        heart.click();
        assert.ok(liked.has('C:/a.flac'));
        assert.equal(heart.getAttribute('aria-pressed'), 'true');
        assert.equal(heart.getAttribute('aria-label'), '取消喜欢');
        assert.ok(heart.classList.contains('md-like-pop'), 'lighting up plays the swell');
        // 别处（档案菜单）取消了喜欢，心形跟着变
        liked.delete('C:/a.flac');
        doc.dispatchEvent(new window.CustomEvent('music-like-change', { detail: { tracks: [app.playlist[0]], liked: false } }));
        assert.equal(heart.getAttribute('aria-pressed'), 'false');
        // 取消喜欢不播放鼓起的动作
        heart.classList.remove('md-like-pop');
        liked.add('C:/a.flac');
        heart.click();
        assert.equal(heart.getAttribute('aria-pressed'), 'false');
        assert.ok(!heart.classList.contains('md-like-pop'));
    } finally {
        dock?.destroy?.();
        window.close();
    }
});

test('sleep timer entry: a tile on the control page (third in the stage), choices call the timer, the bar shows time left', () => {
    let st = { mode: 'off', endsAt: 0, remaining: 0 };
    const calls = [];
    const { window, doc, app, dock } = setup((a, w) => {
        const announce = () => w.document.dispatchEvent(new w.CustomEvent('music-sleep-change', { detail: st }));
        a.sleepTimer = {
            state: () => st,
            set: (m) => { calls.push(['set', m]); st = { mode: 'time', endsAt: 1, remaining: m * 60 }; announce(); },
            setTrackEnd: () => { calls.push('track'); st = { mode: 'track', endsAt: 0, remaining: 0 }; announce(); },
            cancel: () => { calls.push('cancel'); st = { mode: 'off', endsAt: 0, remaining: 0 }; announce(); }
        };
    });
    try {
        const badge = doc.querySelector('[data-md="sleep"]');
        assert.equal(badge.hidden, true, 'nothing on the bar while off');
        dock.openPanel('控制');
        assert.ok(doc.querySelector('[data-act="sleep-pick"]'), 'tile present when the timer exists');
        assert.ok(doc.querySelector('.md-tiles').classList.contains('md-tiles-2'), 'play mode + sleep outside the stage');
        app.isStageActive = true;
        dock.openPanel('控制');
        assert.ok(doc.querySelector('.md-tiles').classList.contains('md-tiles-3'), 'the stage tile joins in the stage');
        app.isStageActive = false;
        dock.openPanel('控制');
        const tile = doc.querySelector('[data-act="sleep-pick"]');
        tile.click();
        const chips = [...doc.querySelectorAll('.md-slp [data-v]')].map((b) => b.dataset.v);
        assert.deepEqual(chips, ['off', '15', '30', '45', '60', '90', 'track']);
        doc.querySelector('.md-slp [data-v="30"]').click();
        assert.deepEqual(calls.pop(), ['set', 30]);
        assert.equal(doc.querySelector('.md-slp'), null, 'choices fold back after picking');
        assert.equal(badge.hidden, false);
        assert.equal(doc.querySelector('[data-md="sleep-t"]').textContent, '30:00');
        assert.ok(doc.querySelector('[data-act="sleep-pick"]').classList.contains('md-lit'));
        // 倒计时只改文字
        st = { mode: 'time', endsAt: 1, remaining: 59 };
        doc.dispatchEvent(new window.CustomEvent('music-sleep-change', { detail: st }));
        assert.equal(doc.querySelector('[data-md="sleep-t"]').textContent, '0:59');
        assert.equal(doc.querySelector('.md-slp-v').textContent, '0:59 后停');
        doc.querySelector('[data-act="sleep-pick"]').click();
        doc.querySelector('.md-slp [data-v="track"]').click();
        assert.equal(calls.pop(), 'track');
        assert.equal(doc.querySelector('[data-md="sleep-t"]').textContent, '本曲');
        doc.querySelector('[data-act="sleep-pick"]').click();
        doc.querySelector('.md-slp [data-v="off"]').click();
        assert.equal(calls.pop(), 'cancel');
        assert.equal(badge.hidden, true);
    } finally {
        dock?.destroy?.();
        window.close();
    }
});

test('without a sleep timer the control page has no sleep tile (one tile, two in the stage) and the bar has no badge', () => {
    const { window, doc, app, dock } = setup();
    try {
        dock.openPanel('控制');
        assert.equal(doc.querySelector('[data-act="sleep-pick"]'), null);
        assert.ok(doc.querySelector('.md-tiles').classList.contains('md-tiles-1'));
        app.isStageActive = true;
        dock.openPanel('控制');
        assert.ok(doc.querySelector('.md-tiles').classList.contains('md-tiles-2'));
        app.isStageActive = false;
        assert.equal(doc.querySelector('[data-md="sleep"]').hidden, true);
    } finally {
        dock?.destroy?.();
        window.close();
    }
});

test('non-sound switches live on the control page: autoplay in 播放, desktop lyrics and the old-UI switch in 显示; they go back to the sound card when the page closes', () => {
    const rows = ['autoplay-switch', 'desktop-lyrics-switch', 'legacy-ui-switch'];
    const { window, doc, dock } = setup((app, win) => {
        const dsp = win.document.getElementById('dsp');
        dsp.innerHTML = '<div class="settings-block"><div class="setting-item"><label for="exclusive-switch">独占模式</label><input type="checkbox" id="exclusive-switch"></div>'
            + rows.map((id) => `<div class="setting-item toggle-item"><label for="${id}">${id}</label><label class="switch compact"><input type="checkbox" id="${id}"><span class="slider round"></span></label></div>`).join('')
            + '</div>';
    });
    try {
        const legacy = doc.getElementById('legacy-ui-switch');
        let toggled = 0;
        legacy.addEventListener('change', () => { toggled++; });
        dock.openPanel('控制');
        const ext = doc.querySelector('#music-dock-root [data-md="ext"]');
        assert.ok(ext.contains(legacy), 'the old-UI switch is on the control page');
        assert.ok(doc.querySelector('#music-dock-root [data-md="disp-slot"]').contains(legacy));
        assert.ok(doc.querySelector('#music-dock-root [data-md="play-slot"]').contains(doc.getElementById('autoplay-switch')));
        assert.equal(doc.querySelector('#music-dock-root [data-md="play-sec"]').hidden, false);
        legacy.click();
        assert.equal(legacy.checked, true);
        assert.equal(toggled, 1, 'same node, same listeners');
        dock.openPanel('声音');
        const dsp = doc.getElementById('dsp');
        for (const id of rows) assert.ok(dsp.contains(doc.getElementById(id)), `${id} back in the sound card`);
        assert.ok(dsp.contains(doc.getElementById('exclusive-switch')));
        dock.openPanel('控制');
        dock.closePanel();
        for (const id of rows) assert.ok(dsp.contains(doc.getElementById(id)), `${id} back after closing`);
        assert.equal(legacy.checked, true, 'state survives the moves');
    } finally { dock.destroy(); }
});

test('queue prebuild cancels pending requestIdleCallback on destroy', () => {
    let idleId = 0;
    const cancelledIdle = [];
    const timers = [];
    const { window, doc, dock } = setup((_app, win) => {
        win.setTimeout = (fn) => { timers.push(fn); return timers.length; };
        win.clearTimeout = () => {};
        win.requestIdleCallback = () => ++idleId;
        win.cancelIdleCallback = (id) => { cancelledIdle.push(id); };
    });
    doc.querySelector('[data-md="more"]').click();
    timers.splice(0).forEach((fn) => fn());
    assert.ok(idleId > 0, 'scheduled idle prebuild');
    dock.destroy();
    assert.ok(cancelledIdle.includes(idleId), 'destroy cancels queued requestIdleCallback');
    window.close();
});

test('palette guards stale open rAF, ignores IME Escape, low-power drawer CSS drops backdrop-filter, and fluid shiftX skips idle getComputedStyle', () => {
    const rafs = [];
    const { window, doc, dock } = setup((_app, win) => {
        win.requestAnimationFrame = (fn) => { rafs.push(fn); return rafs.length; };
        win.cancelAnimationFrame = (id) => { rafs[id - 1] = null; };
    });
    try {
        const palette = doc.querySelector('.md-cmd');
        const input = palette.querySelector('.md-cmd-in');

        // 打开后在首帧 rAF 前立即关闭，后续 rAF 不应把 md-open 加回已关闭的面板
        dock.openPalette('alpha');
        assert.equal(palette.hidden, false);
        dock.closePalette();
        rafs.splice(0).forEach((fn) => fn && fn());
        assert.ok(!palette.classList.contains('md-open'), 'stale open rAF must not re-open closed palette');

        // 输入法组字中按 Escape 不应清空输入或关闭面板
        dock.openPalette('beta');
        const imeEsc = new window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true });
        input.dispatchEvent(imeEsc);
        assert.equal(input.value, 'beta', 'IME Escape keeps search query intact');
        assert.equal(palette.hidden, false, 'IME Escape keeps palette open');

        // 流体层在 --md-shift 未设置时跳过 getComputedStyle(dockEl)，抽屉平移时才查询
        const dockEl = doc.querySelector('.md-dock');
        const host = doc.getElementById('music-dock-root');
        let dockStyleReads = 0;
        const origGetCS = window.getComputedStyle.bind(window);
        window.getComputedStyle = (node, ...rest) => {
            if (node === dockEl) dockStyleReads += 1;
            return origGetCS(node, ...rest);
        };
        const bar = doc.querySelector('.md-cap');
        const hdl = doc.querySelector('.md-hdl');
        const fl = window.createMusicDockFluid({ host, bar, ring: hdl });
        fl.layout();
        assert.equal(dockStyleReads, 0, 'idle shiftX skips getComputedStyle when --md-shift is unset');
        host.style.setProperty('--md-shift', '-120px');
        fl.layout();
        assert.ok(dockStyleReads > 0, 'active --md-shift queries computed translate');
        fl.destroy();

        const drawerCss = read('Musicmodules/music-dock/music-dock-drawer.css');
        assert.match(drawerCss, /#music-dock-root\.md-fl-low \.md-cmd-scrim/);
        assert.match(drawerCss, /#music-dock-root\.md-fl-low \.md-hdl-tip/);
    } finally {
        dock.destroy();
        window.close();
    }
});

test('MusicStageConfig strips undefined keys and returns independent clones on get()', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    dom.window.eval(read('Musicmodules/music-stage/music-stage-config.js'));
    const cfg1 = dom.window.MusicStageConfig.get();
    const cfg2 = dom.window.MusicStageConfig.get();
    assert.notEqual(cfg1, cfg2);
    assert.notEqual(cfg1.modes.luminous, cfg2.modes.luminous);
    for (const [modeId, modeCfg] of Object.entries(cfg1.modes)) {
        for (const [k, v] of Object.entries(modeCfg)) {
            assert.notEqual(v, undefined, `${modeId}.${k} should not contain undefined`);
        }
    }
    cfg1.modes.luminous.glow = 99;
    assert.notEqual(dom.window.MusicStageConfig.get().modes.luminous.glow, 99);
    dom.window.close();
});

test('queue drag runs auto-scroll rAF only inside 32px edges and isolates events by pointerId', () => {
    let rafId = 0;
    let rafCalls = 0;
    let cancelCalls = 0;
    const { window, doc, app, dock } = setup((_app, win) => {
        win.requestAnimationFrame = () => { rafCalls += 1; return ++rafId; };
        win.cancelAnimationFrame = () => { cancelCalls += 1; };
    });
    try {
        const [, b] = app.playlist;
        const c = { path: 'C:/c.flac', title: 'Gamma.flac', artist: 'C' };
        app.playlist.push(c);
        app.manualQueue = [b, c];
        app.getUpNext = () => ({ manual: app.manualQueue.slice(), context: [] });
        app.queueMove = () => {};
        dock.openPanel('播放列表');
        const scroller = doc.querySelector('.md-ql');
        scroller.getBoundingClientRect = () => ({ top: 100, bottom: 400, left: 0, right: 300, width: 300, height: 300 });
        const row = doc.querySelector('.md-man');
        const firePtr = (type, y, pointerId, target = doc) => {
            const ev = new window.MouseEvent(type, { bubbles: true, clientY: y, button: 0 });
            Object.defineProperty(ev, 'pointerId', { value: pointerId });
            target.dispatchEvent(ev);
        };
        rafCalls = 0;
        cancelCalls = 0;
        firePtr('pointerdown', 200, 1, row);
        firePtr('pointermove', 250, 1);
        assert.ok(row.classList.contains('md-qdrag'), 'drag activated in middle zone');
        assert.equal(rafCalls, 0, 'middle-zone drag schedules zero auto-scroll rAF');

        // 另一个 pointerId 不应触发边缘滚屏或打断当前拖动
        firePtr('pointermove', 110, 2);
        assert.equal(rafCalls, 0, 'unrelated pointerId ignored');
        firePtr('pointerup', 250, 2);
        assert.ok(scroller.classList.contains('md-qdragging'), 'unrelated pointerup does not end drag');

        // 拖入顶部 32px 边缘：启动自动滚屏 rAF；移回中间：立即取消 rAF
        firePtr('pointermove', 110, 1);
        assert.equal(rafCalls, 1, 'entering top 32px edge schedules auto-scroll rAF');
        firePtr('pointermove', 250, 1);
        assert.equal(cancelCalls, 1, 'leaving edge zone cancels auto-scroll rAF immediately');

        firePtr('pointerup', 250, 1);
        assert.ok(!scroller.classList.contains('md-qdragging'), 'matching pointerup ends drag');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('dock destroy unsubscribes scan IPC listeners, cancels pending warm idle callbacks, and batches placeMarks without throwing', () => {
    let scanStartOff = 0, scanProgOff = 0, scanDoneOff = 0;
    let idleScheduled = 0, idleCancelled = 0;
    const slid = [];
    const { window, doc, dock } = setup((a, win) => {
        a.api = {
            onMusicScanStart: () => () => { scanStartOff += 1; },
            onMusicScanProgress: () => () => { scanProgOff += 1; },
            onMusicScanComplete: () => () => { scanDoneOff += 1; }
        };
        win.eval(read('Musicmodules/music-app-hooks.js'));
        win.MusicToast = { show() {}, dismiss() {}, clear() {} };
        win.requestIdleCallback = () => ++idleScheduled;
        win.cancelIdleCallback = () => { idleCancelled += 1; };
        win.MusicFluid = { slide: (el, to, opts) => slid.push({ el, to, key: opts?.key }) };
    });
    try {
        // 打开控制页触发多个 .md-seg 的 placeMarks 批量读写
        dock.openPanel('控制');
        const marks = doc.querySelectorAll('.md-body .md-seg .md-mk');
        assert.ok(marks.length >= 1, 'control panel renders segmented controls with markers');
        assert.ok(slid.length >= 1 || [...marks].every((m) => m.style.left !== '' && m.style.width !== ''), 'placeMarks positions every segment marker in control body');
    } finally {
        dock.destroy();
        window.close();
    }
    assert.equal(scanStartOff, 1, 'onMusicScanStart disposer called on destroy');
    assert.equal(scanProgOff, 1, 'onMusicScanProgress disposer called on destroy');
    assert.equal(scanDoneOff, 1, 'onMusicScanComplete disposer called on destroy');
    assert.equal(idleCancelled, idleScheduled, 'any scheduled warm idle callbacks are cancelled on destroy');
});

test('palette reuses stable pinyin wrapper, filters artist-only queries via index, and sets data-md-dist inline', () => {
    const seenPinyinFns = new Set();
    const indexKinds = [];
    const { window, doc, app, dock } = setup((a, win) => {
        win.pinyinPro = { pinyin: (c) => (c === '周' ? 'zhou' : '') };
        win.MusicArchiveIndex = {
            createIndex: (tracks, opts) => {
                if (opts?.pinyin) seenPinyinFns.add(opts.pinyin);
                return {
                    size: tracks.length,
                    query: (q, o) => {
                        indexKinds.push(o?.kind || 'all');
                        return tracks.map((_, i) => i).filter((i) => String(tracks[i].artist || '').includes(q) || String(tracks[i].title || '').includes(q));
                    }
                };
            },
            romanize: (name, py) => {
                if (py) seenPinyinFns.add(py);
                return { py: name.includes('周') ? 'zhou' : name.toLowerCase(), ini: name.includes('周') ? 'z' : name.slice(0, 1).toLowerCase() };
            }
        };
        a.customPlaylists = [{ id: 'pl1', name: '周杰伦合集', tracks: [a.playlist[0].path] }];
    });
    try {
        dock.openPalette();
        const input = doc.querySelector('.md-cmd-in');
        input.value = 'zhou';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        input.value = 'z';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(seenPinyinFns.size, 1, 'palette keeps a single stable pinyin wrapper identity for WeakMap caches');

        indexKinds.length = 0;
        input.value = '歌手:A';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.deepEqual(indexKinds, ['artist'], 'artist-only filter queries artist index directly without full-library scan');
        const rows = doc.querySelectorAll('.md-cmd-row');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].dataset.mdDist, '0');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('queue drag clears row classes and inline transforms on window blur abort and keeps manual rows ordered', () => {
    const { window, doc, app, dock } = setup();
    try {
        const extra = Array.from({ length: 40 }, (_, i) => ({ path: `C:/t${i}.flac`, title: `Track ${i}.flac`, artist: 'A' }));
        app.playlist.push(...extra);
        app.manualQueue = [extra[0], extra[1], extra[2]];
        app.getUpNext = () => ({ manual: app.manualQueue.slice(), context: extra.slice(3) });
        dock.openPanel('播放列表');
        const scroller = doc.querySelector('.md-ql');
        scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 300, width: 300, height: 300 });
        Object.defineProperty(scroller, 'clientHeight', { value: 220, configurable: true });
        // 滚到下面使手动队列离开当前视口，校验有序合并无重复
        scroller.scrollTop = 900;
        scroller.dispatchEvent(new window.Event('scroll'));
        const renderedKeys = [...scroller.querySelectorAll('[data-k]')].map((n) => Number(n.dataset.k));
        assert.ok(renderedKeys.length > 3);
        for (let i = 1; i < renderedKeys.length; i++) {
            assert.ok(renderedKeys[i] > renderedKeys[i - 1], 'merged manual + viewport rows remain strictly ascending without duplicates');
        }

        // 启动拖动后触发 window blur：md-qdrag 和所有内联 transform 都必须清空
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new window.Event('scroll'));
        const rows = [...scroller.querySelectorAll('.md-man')];
        const firePtr = (type, y, target = doc) => {
            const ev = new window.MouseEvent(type, { bubbles: true, clientY: y, button: 0 });
            Object.defineProperty(ev, 'pointerId', { value: 7 });
            target.dispatchEvent(ev);
        };
        firePtr('pointerdown', 100, rows[0]);
        firePtr('pointermove', 160);
        assert.ok(rows[0].classList.contains('md-qdrag'));
        assert.ok(rows[0].style.transform.includes('translateY'));
        window.dispatchEvent(new window.Event('blur'));
        assert.ok(!scroller.classList.contains('md-qdragging'), 'blur removes md-qdragging');
        assert.ok(!rows[0].classList.contains('md-qdrag'), 'blur removes md-qdrag from dragged row');
        assert.ok(rows.every((r) => r.style.transform === ''), 'blur clears inline transform on all manual rows');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 52: stage settings dedupes body2 rebuilds and fluid layer caches SVG attributes, fitFilters, and glow rAF', () => {
    const { window, doc, app, dock } = setup();
    try {
        // 1. music-dock-stage-settings: repeated openPanel('控制') with unchanged theme/motion preserves body2 DOM nodes
        dock.openPanel('控制');
        const themeBtnBefore = doc.querySelector('.md-ext [data-act="theme"] button');
        assert.ok(themeBtnBefore, 'theme segmented button rendered in body2');
        dock.openPanel('控制');
        const themeBtnAfter = doc.querySelector('.md-ext [data-act="theme"] button');
        assert.equal(themeBtnAfter, themeBtnBefore, 'unchanged theme/motion reuses existing body2 DOM without dropping focus');
        doc.body.classList.add('light-theme');
        dock.openPanel('控制');
        const themeBtnAfterSwitch = doc.querySelector('.md-ext [data-act="theme"] button');
        assert.notEqual(themeBtnAfterSwitch, themeBtnBefore, 'theme change rebuilds body2 segmented buttons');

        // 2. music-dock-fluid: setAttr WeakMap cache avoids getAttribute calls and setEnabled(false) cancels glow rAF
        const host = doc.createElement('div');
        const bar = doc.createElement('div');
        bar.getBoundingClientRect = () => ({ left: 100, right: 500, top: 600, bottom: 664, width: 400, height: 64 });
        host.appendChild(bar);
        doc.body.appendChild(host);
        let rafSeq = 0;
        const cancelled = [];
        const origRaf = window.requestAnimationFrame;
        const origCancel = window.cancelAnimationFrame;
        window.requestAnimationFrame = () => ++rafSeq;
        window.cancelAnimationFrame = (id) => cancelled.push(id);
        let getAttrCalls = 0;
        const origGetAttr = window.SVGElement.prototype.getAttribute;
        window.SVGElement.prototype.getAttribute = function (...args) {
            getAttrCalls += 1;
            return origGetAttr.apply(this, args);
        };
        const fluid = window.createMusicDockFluid({ host, bar });
        try {
            fluid.layout();
            getAttrCalls = 0;
            fluid.setProgress(0.25);
            fluid.setProgress(0.5);
            assert.equal(getAttrCalls, 0, 'cached SVG setAttr performs zero DOM getAttribute lookups on progress updates');

            // Initial setGlow paints synchronously, identical second setGlow starts no rAF, different setGlow starts rAF
            fluid.setGlow(['#112233', '#445566', '#778899']);
            const beforeSame = rafSeq;
            fluid.setGlow(['#112233', '#445566', '#778899']);
            assert.equal(rafSeq, beforeSame, 'identical glow colors do not start a redundant 600ms rAF');
            fluid.setGlow(['#223344', '#556677', '#8899aa']);
            assert.equal(rafSeq, beforeSame + 1, 'changed glow colors start transition rAF');
            const glowRafId = rafSeq;
            fluid.setEnabled(false);
            assert.ok(cancelled.includes(glowRafId), 'setEnabled(false) cancels active glow rAF');
        } finally {
            fluid.destroy();
            host.remove();
            window.SVGElement.prototype.getAttribute = origGetAttr;
            window.requestAnimationFrame = origRaf;
            window.cancelAnimationFrame = origCancel;
        }
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 55: palette skips playlist scan on empty recent, resolves song/playlist recents via single map, and queue open skips body2 marks', () => {
    const { window, doc, app, dock } = setup();
    try {
        // 1. Opening palette with empty recent commands must not scan app.playlist
        let playlistReads = 0;
        const backing = app.playlist;
        Object.defineProperty(app, 'playlist', {
            configurable: true,
            get() { playlistReads += 1; return backing; }
        });
        window.localStorage.removeItem('musicDockRecentCommands');
        dock.openPalette();
        assert.equal(playlistReads, 0, 'opening palette with empty recent history does not build track path map');
        dock.closePalette?.();
        doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        // 2. With a saved song + playlist recent entry, both resolve via single byPath cache
        app.customPlaylists = [{ id: 'fav', name: '收藏', tracks: [backing[0].path] }];
        window.localStorage.setItem('musicDockRecentCommands', JSON.stringify([`song:${backing[1].path}`, 'playlist:fav']));
        dock.openPalette();
        const titles = [...doc.querySelectorAll('.md-cmd-title')].map((n) => n.textContent);
        assert.ok(titles.some((t) => t.includes('Beta')), 'song recent item resolved from single byPath map');
        assert.ok(titles.includes('收藏'), 'playlist recent item resolved from single byPath map');
        doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        // 3. Opening 播放列表 tab must not query hidden body2 for .md-seg marks
        dock.openPanel('控制');
        const body2 = doc.querySelector('[data-md="body2"]');
        assert.ok(body2);
        let body2MarkQueries = 0;
        const origQsa = body2.querySelectorAll.bind(body2);
        body2.querySelectorAll = (sel) => {
            if (sel === '.md-seg') body2MarkQueries += 1;
            return origQsa(sel);
        };
        dock.openPanel('播放列表');
        assert.equal(body2MarkQueries, 0, 'queue tab skips placeMarks(el.body2) on hidden control panel');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 59: closePanel and palette close restore focus cleanly and playlist search caches romanization accurately', () => {
    const { window, doc, app, dock } = setup();
    try {
        // 1. Focus restored before panel class teardown, without losing activeElement
        const play = doc.querySelector('[data-md="play"]');
        play.focus();
        dock.openPanel('控制');
        assert.notEqual(doc.activeElement, play);
        dock.closePanel();
        assert.equal(doc.activeElement, play, 'closePanel synchronously returns focus to trigger element');
        assert.equal(doc.body.classList.contains('music-drawer-open'), false);

        // 2. Palette focus restore + cached pinyin matching for playlists
        if (!window.MusicArchiveIndex) window.eval(read('Musicmodules/music-archive/archive-index.js'));
        let pinyinCalls = 0;
        window.pinyinPro = {
            pinyin: (ch) => {
                pinyinCalls += 1;
                return ({ '夜': 'ye', '曲': 'qu', '收': 'shou', '藏': 'cang' })[ch] || '';
            }
        };
        app.customPlaylists = [{ id: 'p1', name: '夜曲收藏', tracks: [app.playlist[0].path] }];
        play.focus();
        dock.openPalette();
        const input = doc.querySelector('.md-cmd-in');
        assert.equal(doc.activeElement, input);
        input.value = 'yq';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        let titles = [...doc.querySelectorAll('.md-cmd-title')].map((n) => n.textContent);
        assert.ok(titles.includes('夜曲收藏'), 'pinyin initials match custom playlist');
        const callsAfterFirst = pinyinCalls;
        input.value = 'yqsc';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        titles = [...doc.querySelectorAll('.md-cmd-title')].map((n) => n.textContent);
        assert.ok(titles.includes('夜曲收藏'), 'repeated query reuses cached playlist romanization');
        assert.equal(pinyinCalls, callsAfterFirst, 'playlist romanization cache avoids recomputing pinyin on every keystroke');

        // First Escape clears input, second Escape closes palette and synchronously restores focus
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(input.value, '');
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(doc.activeElement, play, 'palette Escape synchronously restores focus');
        assert.equal(doc.body.classList.contains('music-dock-cmd-open'), false);
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 61: palette pools row DOM nodes, dock gates stage config fluid sync, and progress/volume drags cache bounding rects', () => {
    const subs = [];
    let stageCfg = { quality: 'high', themeMode: 'auto', themeFile: '', themeVariant: '', modes: { luminous: { glow: 0.5 } } };
    const { window, doc, app, dock } = setup((_app, win) => {
        win.MusicStageConfig = {
            get: () => stageCfg,
            subscribe: (fn) => { subs.push(fn); return () => {}; }
        };
    });
    try {
        // 1. Palette DOM pooling: consecutive queries reuse button elements and preserve .md-cmd-drop
        dock.openPalette();
        const input = doc.querySelector('.md-cmd-in');
        const list = doc.querySelector('.md-cmd-list');
        input.value = 'a';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        const firstRow = list.querySelector('.md-cmd-row[data-i="0"]');
        assert.ok(firstRow, 'initial palette query renders row 0');
        const drop = doc.createElement('i');
        drop.className = 'md-cmd-drop';
        list.appendChild(drop);

        input.value = 'b';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        const secondRow = list.querySelector('.md-cmd-row[data-i="0"]');
        assert.equal(secondRow, firstRow, 'subsequent palette query reuses pooled .md-cmd-row node');
        assert.equal(list.querySelector(':scope > .md-cmd-drop'), drop, 'palette render preserves .md-cmd-drop indicator');
        dock.closePalette();

        // 2. MusicStageConfig subscription ignores unrelated mode slider edits and fires on quality/theme change
        const bar = doc.querySelector('.md-cap');
        let barRectReads = 0;
        const origBarRect = bar.getBoundingClientRect.bind(bar);
        bar.getBoundingClientRect = () => { barRectReads += 1; return origBarRect(); };
        assert.ok(subs.length > 0, 'dock subscribed to MusicStageConfig');
        const beforeReads = barRectReads;
        stageCfg = { ...stageCfg, modes: { luminous: { glow: 0.9 } } };
        subs.forEach((fn) => fn(stageCfg));
        assert.equal(barRectReads, beforeReads, 'non-material stage slider update skips fluid relayout');
        stageCfg = { ...stageCfg, quality: 'energy-saving' };
        subs.forEach((fn) => fn(stageCfg));
        assert.ok(doc.getElementById('music-dock-root').classList.contains('md-fl-low'), 'quality change updates fluid tier');

        // 3. Progress strip pointermove reads trk.getBoundingClientRect() at most once per move
        const trk = doc.querySelector('.md-trk');
        app.lastKnownDuration = 200;
        let trkRectReads = 0;
        trk.getBoundingClientRect = () => { trkRectReads += 1; return { left: 100, right: 300, top: 600, bottom: 612, width: 200, height: 12 }; };
        trk.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: 150 }));
        assert.equal(trkRectReads, 1, 'progress hover reads bounding rect once');
        trkRectReads = 0;
        trk.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 160 }));
        assert.equal(trkRectReads, 1, 'progress pointerdown reads bounding rect once');
        trkRectReads = 0;
        trk.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: 200 }));
        assert.equal(trkRectReads, 1, 'progress drag pointermove reads bounding rect once');
        trk.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: 200 }));

        // 4. Drawer volume slider drag caches rect on pointerdown (0 extra rect reads during pointermove)
        dock.openPanel('控制');
        const volWrap = doc.querySelector('[data-md="body"] .md-sld');
        assert.ok(volWrap, 'control panel renders drawer volume slider');
        let volRectReads = 0;
        volWrap.getBoundingClientRect = () => { volRectReads += 1; return { left: 20, right: 220, top: 300, bottom: 320, width: 200, height: 20 }; };
        volWrap.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 120 }));
        assert.equal(volRectReads, 1, 'volume pointerdown reads bounding rect once');
        window.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: 140 }));
        window.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: 180 }));
        assert.equal(volRectReads, 1, 'volume drag pointermove reuses cached bounding rect');
        window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: 180 }));
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 62: dock fluid skips redundant layout writes when geometry is unchanged and guards setGlow target/invalid hex', () => {
    const dom = new JSDOM('<!doctype html><body><div id="host"><div class="md-dock"><div id="bar"></div><div id="ring"></div></div></div></body>', { runScripts: 'outside-only' });
    const { window } = dom;
    window.eval(read('Musicmodules/music-dock/music-dock-fluid.js'));
    let now = 1000;
    let rafCalls = 0;
    let cancelCalls = 0;
    const frames = [];
    window.performance.now = () => now;
    window.requestAnimationFrame = (cb) => { rafCalls += 1; frames.push(cb); return rafCalls; };
    window.cancelAnimationFrame = () => { cancelCalls += 1; frames.length = 0; };
    const bar = window.document.getElementById('bar');
    bar.getBoundingClientRect = () => ({ left: 200, right: 800, top: 600, bottom: 664, width: 600, height: 64 });
    const fluid = window.createMusicDockFluid({ host: window.document.getElementById('host'), bar, ring: window.document.getElementById('ring') });
    try {
        assert.equal(fluid.layout(), true);
        const holePath = fluid.svg.querySelector('clipPath path');
        let holeAttrWrites = 0;
        let svgAttrWrites = 0;
        const origHoleSet = holePath.setAttribute.bind(holePath);
        holePath.setAttribute = (...a) => { holeAttrWrites += 1; return origHoleSet(...a); };
        const origSvgSet = fluid.svg.setAttribute.bind(fluid.svg);
        fluid.svg.setAttribute = (...a) => { svgAttrWrites += 1; return origSvgSet(...a); };

        // Unchanged geometry skips rewriting SVG viewBox/filters/holePath
        assert.equal(fluid.layout(), true);
        assert.equal(holeAttrWrites, 0, 'unchanged layout skips resetting holePath');
        assert.equal(svgAttrWrites, 0, 'unchanged layout skips rewriting svg dimensions');

        // Invalid first-call hex does not throw
        assert.doesNotThrow(() => fluid.setGlow(['not-a-color', null, '']));
        fluid.setGlow(['#112233', '#223344', '#334455']);
        const rafBefore = rafCalls;
        const cancelBefore = cancelCalls;
        fluid.setGlow(['#445566', '#556677', '#667788']);
        assert.equal(rafCalls, rafBefore + 1, 'new glow colors start smooth transition');
        // Calling setGlow with identical target mid-flight must not cancel & restart the animation
        fluid.setGlow(['#445566', '#556677', '#667788']);
        assert.equal(rafCalls, rafBefore + 1, 'same in-flight glow target does not schedule extra rAF');
        assert.equal(cancelCalls, cancelBefore, 'same in-flight glow target does not cancel active animation');
    } finally {
        fluid.destroy();
        window.close();
    }
});

test('Batch 64: opening queue drawer renders window before setting scrollTop after focus (single layout)', () => {
    const { window, doc, app, dock } = setup();
    try {
        const extra = Array.from({ length: 50 }, (_, i) => ({ path: `C:/t${i}.flac`, title: `Track ${i}.flac`, artist: 'A' }));
        app.playlist.push(...extra);
        app.getHistory = () => extra.slice(0, 6);
        app.manualQueue = [extra[6], extra[7]];
        app.getUpNext = () => ({ manual: app.manualQueue.slice(), context: extra.slice(8) });

        const ops = [];
        const origFocus = window.HTMLElement.prototype.focus;
        window.HTMLElement.prototype.focus = function (...args) {
            ops.push('focus');
            return origFocus.apply(this, args);
        };
        const scrollerProto = window.HTMLDivElement.prototype;
        const origScrollDesc = Object.getOwnPropertyDescriptor(scrollerProto, 'scrollTop')
            || Object.getOwnPropertyDescriptor(window.Element.prototype, 'scrollTop');
        Object.defineProperty(window.Element.prototype, 'scrollTop', {
            configurable: true,
            get() { return origScrollDesc ? origScrollDesc.get.call(this) : (this._st || 0); },
            set(v) {
                if (this.classList?.contains('md-ql')) {
                    const rowCount = this.querySelectorAll('[data-k]').length;
                    ops.push(`scrollTop:${v}:rows=${rowCount}`);
                }
                if (origScrollDesc) origScrollDesc.set.call(this, v); else this._st = v;
            }
        });
        try {
            dock.openPanel('播放列表');
        } finally {
            window.HTMLElement.prototype.focus = origFocus;
            if (origScrollDesc) Object.defineProperty(window.Element.prototype, 'scrollTop', origScrollDesc);
        }
        const scrollOps = ops.filter((o) => o.startsWith('scrollTop:'));
        assert.equal(scrollOps.length, 1, `queue open sets scrollTop once (got ${ops.join(', ')})`);
        const scrollIdx = ops.indexOf(scrollOps[0]);
        const focusIdx = ops.indexOf('focus');
        assert.ok(focusIdx >= 0 && scrollIdx > focusIdx, `scrollTop runs after focus (${ops.join(', ')})`);
        assert.ok(!scrollOps[0].endsWith('rows=0'), `queue rows are rendered before scrollTop assignment (${scrollOps[0]})`);
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 66: palette patches list children in-place without removing reused rows and mounts .md-cmd-drop before flushSlide reads layout', () => {
    const rafs = [];
    const slides = [];
    const { window, doc, app, dock } = setup((_app, w) => {
        w.requestAnimationFrame = (cb) => { rafs.push(cb); return rafs.length; };
        w.cancelAnimationFrame = () => {};
        w.MusicFluid = {
            slide: (el, box) => slides.push({ el, box }),
            bud() {}
        };
    });
    try {
        for (let i = 0; i < 12; i += 1) {
            app.playlist.push({ path: `C:/a${i}.flac`, title: `Alpha Song ${i}.flac`, artist: 'Artist A', album: 'Alb' });
        }
        dock.openPalette();
        const input = doc.querySelector('.md-cmd-in');
        const list = doc.querySelector('.md-cmd-list');
        input.value = 'Alpha Song';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        const rowsBefore = [...list.querySelectorAll('.md-cmd-row')];
        assert.ok(rowsBefore.length >= 6);
        const dropMounted = list.querySelector(':scope > .md-cmd-drop');
        assert.ok(dropMounted, 'render() mounts .md-cmd-drop ahead of flushSlide');

        // Flush rAF: flushSlide must NOT appendChild before reading offsetTop
        let listAppendsDuringSlide = 0;
        const origAppend = list.appendChild.bind(list);
        list.appendChild = (...args) => { listAppendsDuringSlide += 1; return origAppend(...args); };
        while (rafs.length) rafs.splice(0).forEach((cb) => cb(16));
        assert.equal(listAppendsDuringSlide, 0, 'flushSlide does not mutate DOM before reading row geometry');
        assert.ok(slides.length > 0 && slides.at(-1).el === dropMounted);
        list.appendChild = origAppend;

        // Refining query with same row count must keep existing .md-cmd-row buttons in-place (zero detach/re-insert)
        const removed = [];
        const origInsert = list.insertBefore.bind(list);
        let movedRows = 0;
        list.insertBefore = (node, ref) => {
            if (rowsBefore.includes(node)) movedRows += 1;
            return origInsert(node, ref);
        };
        const obs = new window.MutationObserver((recs) => {
            for (const r of recs) for (const n of r.removedNodes) if (rowsBefore.includes(n)) removed.push(n);
        });
        obs.observe(list, { childList: true });
        input.value = 'Alpha Song ';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        const rowsAfter = [...list.querySelectorAll('.md-cmd-row')];
        assert.equal(rowsAfter.length, rowsBefore.length);
        assert.equal(rowsAfter[0], rowsBefore[0]);
        assert.equal(movedRows, 0, 'unchanged slot positions stay in-place without insertBefore churn');
        assert.equal(removed.length, 0, 'reused palette rows are never detached');
        obs.disconnect();
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 67: queue drawer reads precomputed rows.upcoming count without filtering the full queue array', () => {
    const { window, doc, app, dock } = setup((a) => {
        for (let i = 0; i < 40; i += 1) {
            a.playlist.push({ path: `C:/q${i}.flac`, title: `Queue Track ${i}`, artist: 'Art' });
        }
        a.getUpNext = () => ({ manual: [a.playlist[1], a.playlist[2]], context: a.playlist.slice(3, 18) });
    });
    try {
        dock.openPanel('播放列表');
        const countEl = doc.querySelector('.md-qh > span');
        assert.equal(countEl?.textContent, '17', 'header displays manual (2) + context (15) upcoming count');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 68: openPanel skips body placeMarks on queue tab and closePanel cancels pending openMarksRaf', () => {
    const rafs = new Map();
    let nextRaf = 1;
    const cancelled = [];
    const slides = [];
    const { window, doc, dock } = setup((_app, w) => {
        w.requestAnimationFrame = (cb) => { const id = nextRaf++; rafs.set(id, cb); return id; };
        w.cancelAnimationFrame = (id) => { cancelled.push(id); rafs.delete(id); };
        w.MusicFluid = { slide: (el, to, opts) => slides.push({ el, to, key: opts?.key }), bud() {}, melt() {}, snapshot: () => null };
    });
    try {
        let bodySegQueries = 0;
        const body = doc.querySelector('.md-body');
        const origQsa = body.querySelectorAll.bind(body);
        body.querySelectorAll = (sel) => {
            if (sel === '.md-seg') bodySegQueries += 1;
            return origQsa(sel);
        };
        dock.openPanel('播放列表');
        assert.equal(bodySegQueries, 0, 'queue tab skips placeMarks(el.body) query');
        const beforeClose = cancelled.length;
        dock.closePanel();
        assert.ok(cancelled.length > beforeClose, 'closePanel cancels pending openMarksRaf');
        for (const cb of [...rafs.values()]) cb(16);
        assert.equal(slides.length, 0, 'cancelled openMarksRaf does not place marks after panel closed');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 69: dock scopes --md-shift/--md-bar-w/--md-vgrow off #music-dock-root and palette caches commands across keystrokes', () => {
    const { window, doc, app, dock } = setup((_app, w) => {
        Object.defineProperty(w, 'innerWidth', { value: 1200, configurable: true });
        Object.defineProperty(w, 'innerHeight', { value: 800, configurable: true });
    });
    try {
        const root = doc.getElementById('music-dock-root');
        const dockEl = root.querySelector('.md-dock');
        const hdl = root.querySelector('.md-hdl');
        const vrail = root.querySelector('.md-vrail');
        const svg = root.querySelector('.md-fluid');
        const mist = root.querySelector('.md-mist');

        // Open drawer so syncShift computes a negative shift
        dock.openPanel('控制');
        assert.equal(root.style.getPropertyValue('--md-shift'), '', '--md-shift is NOT written onto #music-dock-root');
        assert.equal(root.style.getPropertyValue('--md-bar-w'), '', '--md-bar-w is NOT written onto #music-dock-root');
        assert.equal(root.style.getPropertyValue('--md-mist-pad'), '', '--md-mist-pad is NOT written onto #music-dock-root');
        assert.notEqual(dockEl.style.getPropertyValue('--md-shift'), '', '--md-shift is written directly onto .md-dock');
        assert.equal(hdl.style.getPropertyValue('--md-shift'), dockEl.style.getPropertyValue('--md-shift'));
        if (svg) assert.equal(svg.style.getPropertyValue('--md-shift'), dockEl.style.getPropertyValue('--md-shift'));
        if (mist) assert.equal(mist.style.getPropertyValue('--md-shift'), dockEl.style.getPropertyValue('--md-shift'));

        // Close drawer clears --md-shift from target elements without touching #music-dock-root
        dock.closePanel();
        assert.equal(dockEl.style.getPropertyValue('--md-shift'), '', 'closing drawer removes --md-shift from .md-dock');
        assert.equal(root.style.getPropertyValue('--md-shift'), '');

        // Volume grow variable writes onto .md-vrail rather than #music-dock-root
        if (svg) {
            const cap = root.querySelector('.md-cap');
            cap.getBoundingClientRect = () => ({ left: 280, right: 920, top: 710, bottom: 774, width: 640, height: 64 });
            window.dispatchEvent(new window.Event('resize'));
            assert.equal(root.style.getPropertyValue('--md-vgrow'), '', '--md-vgrow is NOT written onto #music-dock-root');
            assert.notEqual(vrail.style.getPropertyValue('--md-vgrow'), '', '--md-vgrow is written directly onto .md-vrail');
        }

        // Palette caches command list across consecutive text keystrokes when state is unchanged
        let m3uCalls = 0;
        app.m3u = { commands: () => { m3uCalls += 1; return []; } };
        dock.openPalette();
        const input = root.querySelector('.md-cmd-in');
        for (const text of ['a', 'ar', 'art']) {
            input.value = text;
            input.dispatchEvent(new window.Event('input', { bubbles: true }));
        }
        assert.equal(m3uCalls, 1, 'commands() built once across consecutive keystrokes under unchanged state');
        app.isPlaying = !app.isPlaying;
        input.value = 'arti';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(m3uCalls, 2, 'commands() invalidates immediately when player state changes');
        dock.closePalette();
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 71: queue drawer pools rows in-place, skips closed scroll, batches palette playlist queueing, and short-circuits followWidth on reduced motion', () => {
    const rafs = [];
    const { window, doc, app, dock, calls } = setup((a, w) => {
        w.requestAnimationFrame = (cb) => { rafs.push(cb); return rafs.length; };
        w.cancelAnimationFrame = () => {};
        for (let i = 0; i < 80; i += 1) {
            a.playlist.push({ path: `C:/pool${i}.flac`, title: `Pool Song ${i}.flac`, artist: `Art ${i}`, duration: 180 });
        }
        a.manualQueue = [a.playlist[2], a.playlist[3]];
        a.getUpNext = () => ({ manual: a.manualQueue.slice(), context: a.playlist.slice(4) });
        a.customPlaylists = [{ id: 'pl-batch', name: 'Batch Mix', tracks: [a.playlist[5].path, a.playlist[6].path, a.playlist[7].path] }];
        a.queueAdd = (t) => { calls.push(['qadd', t.path]); return t; };
        a.queuePlayNext = (t) => { calls.push(['qnext', t.path]); return t; };
        let batchCalls = 0;
        a.queueBatch = (fn) => { batchCalls += 1; return fn(); };
        a._getBatchCalls = () => batchCalls;
    });
    try {
        dock.openPanel('播放列表');
        const scroller = doc.querySelector('.md-ql');
        const sizer = scroller.firstElementChild;
        let clientHeightReads = 0;
        Object.defineProperty(scroller, 'clientHeight', { configurable: true, get() { clientHeightReads += 1; return 280; } });

        // 1. In-place rerenderQueue keeps the same .md-ql scroller & reuses existing row elements
        const initialTrackNode = sizer.querySelector('.md-qi:not(.md-now):not(.md-man)');
        assert.ok(initialTrackNode);
        app.manualQueue.push(app.playlist[10]);
        doc.dispatchEvent(new window.Event('music-queue-change'));
        assert.equal(doc.querySelector('.md-ql'), scroller, 'rerenderQueue patches in-place without rebuilding .md-ql');
        assert.equal(doc.querySelector('.md-qh > span').textContent, String(app.manualQueue.length + app.playlist.length - 4));

        // 2. Disjoint scroll reuses pooled track DOM nodes instead of re-allocating via innerHTML
        const beforeTrackNodes = new Set([...sizer.querySelectorAll('.md-qi:not(.md-now):not(.md-man)')]);
        scroller.scrollTop = 1800;
        scroller.dispatchEvent(new window.Event('scroll'));
        const afterTrackNodes = [...sizer.querySelectorAll('.md-qi:not(.md-now):not(.md-man)')];
        const reused = afterTrackNodes.filter((n) => beforeTrackNodes.has(n)).length;
        assert.ok(reused > 0, `disjoint scroll reuses pooled row DOM nodes (reused=${reused}/${afterTrackNodes.length})`);

        // 3. Closed drawer ignores delayed scroll events without reading clientHeight
        dock.closePanel();
        clientHeightReads = 0;
        scroller.scrollTop = 2200;
        scroller.dispatchEvent(new window.Event('scroll'));
        assert.equal(clientHeightReads, 0, 'closed queue scroller ignores scroll events without layout reads');

        // 4. Palette multi-track playlist queueing routes through app.queueBatch
        dock.openPalette();
        const input = doc.querySelector('.md-cmd-in');
        input.value = 'Batch Mix';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        const plRow = [...doc.querySelectorAll('.md-cmd-row')].find((r) => r.querySelector('.md-cmd-title')?.textContent === 'Batch Mix');
        assert.ok(plRow);
        plRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
        assert.equal(app._getBatchCalls(), 1, 'palette multi-track queue wraps loop in app.queueBatch');
        assert.deepEqual(calls.slice(-3), [['qadd', 'C:/pool3.flac'], ['qadd', 'C:/pool4.flac'], ['qadd', 'C:/pool5.flac']]);
        dock.closePalette();

        // 5. Reduced-motion followWidth settles in 1 rAF instead of 560ms polling
        doc.body.classList.add('music-reduce-motion');
        rafs.length = 0;
        dock.openPanel('控制');
        const pendingCount = rafs.length;
        const batch = rafs.splice(0);
        for (const cb of batch) cb(16);
        assert.equal(rafs.length, 0, `reduced-motion followWidth does not chain polling rAFs (initial=${pendingCount})`);
        dock.closePanel();
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 72: palette scopes .md-cmd-open onto #music-dock-root and CSS isolates .md-cmd without body.music-dock-cmd-open rules', () => {
    const { window, doc, dock } = setup();
    try {
        const root = doc.getElementById('music-dock-root');
        dock.openPalette();
        assert.equal(root.classList.contains('md-cmd-open'), true, '#music-dock-root receives .md-cmd-open');
        assert.equal(doc.body.classList.contains('music-dock-cmd-open'), true, 'body keeps compatibility class');
        dock.closePalette();
        assert.equal(root.classList.contains('md-cmd-open'), false, '#music-dock-root clears .md-cmd-open on close');
        assert.equal(doc.body.classList.contains('music-dock-cmd-open'), false);

        const panelCss = read('Musicmodules/music-dock/music-dock-panel.css');
        const drawerCss = read('Musicmodules/music-dock/music-dock-drawer.css');
        assert.match(panelCss, /\.md-cmd\s*\{[^}]*contain:\s*layout style/, '.md-cmd applies layout/style containment');
        assert.equal(panelCss.includes('body.music-dock-cmd-open'), false, 'panel CSS no longer matches body.music-dock-cmd-open');
        assert.equal(drawerCss.includes('body.music-dock-cmd-open'), false, 'drawer CSS no longer matches body.music-dock-cmd-open');
        assert.match(panelCss, /#music-dock-root\.md-cmd-open \.md-hdl/);
        assert.match(drawerCss, /#music-dock-root\.md-cmd-open \.md-dock/);
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 75: palette focuses input before body.music-dock-cmd-open and coalesces openRaf + slide into one frame', () => {
    const rafs = [];
    let rafSeq = 0;
    const order = [];
    const { window, doc, dock } = setup((_app, w) => {
        w.requestAnimationFrame = (cb) => { const id = ++rafSeq; rafs.push({ id, cb }); return id; };
        w.cancelAnimationFrame = (id) => { const i = rafs.findIndex((r) => r.id === id); if (i !== -1) rafs.splice(i, 1); };
        w.MusicFluid = {
            bud: () => { order.push('bud'); },
            slide: () => { order.push('slide'); }
        };
    });
    try {
        const cap = doc.querySelector('.md-cap');
        cap.getBoundingClientRect = () => ({ left: 100, right: 500, top: 600, bottom: 650, width: 400, height: 50 });
        const input = doc.querySelector('.md-cmd-in');
        const cmdRoot = doc.querySelector('.md-cmd');
        const origFocus = input.focus.bind(input);
        input.focus = (...a) => { order.push('focus'); return origFocus(...a); };
        const origBodyAdd = doc.body.classList.add.bind(doc.body.classList);
        doc.body.classList.add = (...cls) => { if (cls.includes('music-dock-cmd-open')) order.push('body-class'); return origBodyAdd(...cls); };
        const origCmdAdd = cmdRoot.classList.add.bind(cmdRoot.classList);
        cmdRoot.classList.add = (...cls) => { if (cls.includes('md-open')) order.push('md-open'); return origCmdAdd(...cls); };

        rafs.length = 0;
        order.length = 0;
        dock.openPalette('a');
        assert.ok(order.indexOf('focus') >= 0 && order.indexOf('body-class') > order.indexOf('focus'),
            `input.focus runs before body.music-dock-cmd-open (${JSON.stringify(order)})`);
        assert.equal(rafs.length, 1, 'initial open coalesces slideRaf into single openRaf');
        rafs.splice(0).forEach((r) => r.cb(16));
        assert.ok(order.indexOf('bud') >= 0 && order.indexOf('md-open') > order.indexOf('bud') && order.indexOf('slide') > order.indexOf('md-open'),
            `openRaf runs bud before md-open and slide (${JSON.stringify(order)})`);
        dock.closePalette();
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 77: openPanel focuses active tab before body.music-drawer-open/renderBody and skips zero scrollTop write', () => {
    const { window, doc, app, dock } = setup((a) => {
        for (let i = 0; i < 20; i += 1) {
            a.playlist.push({ path: `C:/q${i}.flac`, title: `Queue ${i}`, artist: `Art ${i}`, duration: 180 });
        }
        a.getUpNext = () => ({ manual: [], context: a.playlist.slice(1) });
        a.getHistory = () => [];
    });
    try {
        const tabs = doc.querySelector('[role="tablist"]');
        const body = doc.querySelector('.md-body');
        assert.ok(tabs && body);
        let focusCount = 0;
        let drawerOpenAtFocus = null;
        let queueRenderedAtFocus = null;
        const origFocus = window.HTMLElement.prototype.focus;
        window.HTMLElement.prototype.focus = function (...args) {
            if (tabs.contains(this)) {
                focusCount += 1;
                drawerOpenAtFocus = doc.body.classList.contains('music-drawer-open');
                queueRenderedAtFocus = Boolean(body.querySelector('.md-ql'));
            }
            return origFocus.apply(this, args);
        };
        let zeroScrollWrites = 0;
        const origScrollDesc = Object.getOwnPropertyDescriptor(window.Element.prototype, 'scrollTop');
        Object.defineProperty(window.Element.prototype, 'scrollTop', {
            configurable: true,
            get() { return origScrollDesc.get.call(this); },
            set(v) {
                if (this.classList?.contains('md-ql') && Number(v) === 0) zeroScrollWrites += 1;
                return origScrollDesc.set.call(this, v);
            }
        });
        try {
            dock.openPanel('播放列表');
            assert.equal(focusCount, 1, 'openPanel focuses active tab once');
            assert.equal(drawerOpenAtFocus, false, 'tab focus runs before body.music-drawer-open is set');
            assert.equal(queueRenderedAtFocus, false, 'tab focus runs before renderBody builds queue DOM');
            assert.equal(doc.body.classList.contains('music-drawer-open'), true, 'drawer open class applied after tab focus');
            assert.ok(body.querySelector('.md-ql'), 'queue list rendered after tab focus');
            assert.equal(zeroScrollWrites, 0, 'queue opening at top=0 skips redundant scroller.scrollTop=0 write');
            dock.closePanel();
        } finally {
            window.HTMLElement.prototype.focus = origFocus;
            Object.defineProperty(window.Element.prototype, 'scrollTop', origScrollDesc);
        }
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 81: palette normalizes Windows paths & deduplicates hints/meta, queue drag skips unchanged sibling shifts, and dock deduplicates steady DOM writes', async () => {
    const { window, doc, app, dock, calls } = setup((a) => {
        const c = { path: 'C:/c.flac', title: 'Gamma.flac', artist: 'C', duration: 180 };
        a.playlist.push(c);
        a.manualQueue = [a.playlist[0], a.playlist[1], c];
        a.getUpNext = () => ({ manual: a.manualQueue.slice(), context: [] });
        a.queueMove = () => {};
        a.queueAdd = (t) => { calls.push(['qadd', t.path]); return t; };
        // Playlist stores backslash + lowercase Windows path that should match C:/a.flac via normalized fallback
        a.customPlaylists = [{ id: 'win-pl', name: 'WinPath Mix', tracks: ['c:\\a.flac', 'C:\\B.FLAC'] }];
    });
    try {
        // 1. Palette normalized Windows path fallback + deduplicated hints/foot writes
        dock.openPalette();
        const input = doc.querySelector('.md-cmd-in');
        const hints = doc.querySelector('.md-cmd-hints');
        const foot = doc.querySelector('.md-cmd-foot');

        let hintsHtmlWrites = 0;
        const innerDesc = Object.getOwnPropertyDescriptor(window.Element.prototype, 'innerHTML');
        Object.defineProperty(hints, 'innerHTML', {
            configurable: true,
            get() { return innerDesc.get.call(this); },
            set(v) { hintsHtmlWrites += 1; return innerDesc.set.call(this, v); }
        });
        let footHiddenWrites = 0;
        const hiddenDesc = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'hidden');
        Object.defineProperty(foot, 'hidden', {
            configurable: true,
            get() { return hiddenDesc.get.call(this); },
            set(v) { footHiddenWrites += 1; return hiddenDesc.set.call(this, v); }
        });

        for (const q of ['a', 'al', 'alp']) {
            input.value = q;
            input.dispatchEvent(new window.Event('input', { bubbles: true }));
        }
        assert.equal(hintsHtmlWrites, 0, 'normal typing skips redundant hints.innerHTML clears');

        input.value = '--';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(hintsHtmlWrites, 1, 'entering -- renders flag hints once');
        input.value = '--ar';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(hintsHtmlWrites, 2, 'narrowing --ar updates flag hints');
        input.value = 'WinPath';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(hintsHtmlWrites, 3, 'leaving flag mode clears hints once');
        input.value = 'WinPath Mix';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(hintsHtmlWrites, 3, 'subsequent non-flag typing does not clear hints again');

        const plRow = [...doc.querySelectorAll('.md-cmd-row')].find((r) => r.querySelector('.md-cmd-title')?.textContent === 'WinPath Mix');
        assert.ok(plRow, 'playlist with Windows backslash/case paths resolves track count and appears');
        plRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
        assert.deepEqual(calls.slice(-2), [['qadd', 'C:/a.flac'], ['qadd', 'C:/b.flac']], 'Windows path normalization resolves both playlist tracks');

        // Active-row navigation across two queueable songs does not rewrite foot.hidden
        input.value = '';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        const beforeNavFootWrites = footHiddenWrites;
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        assert.equal(footHiddenWrites, beforeNavFootWrites, 'moving between queueable rows skips redundant foot.hidden write');
        dock.closePalette();

        // 2. Queue drag skips sibling loop while nextTo === lastTo between row thresholds
        dock.openPanel('播放列表');
        const scroller = doc.querySelector('.md-ql');
        scroller.getBoundingClientRect = () => ({ top: 100, bottom: 500, left: 0, right: 300, width: 300, height: 400 });
        const rows = [...doc.querySelectorAll('.md-man')];
        assert.equal(rows.length, 3);
        let siblingQiReads = 0;
        const origDataset = rows[1].dataset;
        Object.defineProperty(rows[1], 'dataset', {
            configurable: true,
            get() { siblingQiReads += 1; return origDataset; }
        });
        const firePtr = (type, y, target = doc) => {
            const ev = new window.MouseEvent(type, { bubbles: true, clientY: y, button: 0 });
            Object.defineProperty(ev, 'pointerId', { value: 7 });
            target.dispatchEvent(ev);
        };
        firePtr('pointerdown', 200, rows[0]);
        siblingQiReads = 0;
        firePtr('pointermove', 208);
        firePtr('pointermove', 214);
        firePtr('pointermove', 218);
        assert.equal(rows[0].style.transform, 'translateY(18px)', 'dragged row still follows pointer');
        assert.equal(siblingQiReads, 0, 'sub-threshold drag moves do not re-read sibling dataset.qi');
        assert.equal(rows[1].style.transform, '', 'sibling stays unshifted below threshold');
        firePtr('pointermove', 252);
        assert.equal(rows[1].style.transform, 'translateY(-48px)', 'crossing row threshold shifts sibling cleanly');
        assert.equal(siblingQiReads, 0, 'threshold crossing uses precomputed manualIndices without DOM dataset reads');
        firePtr('pointerup', 252);
        dock.closePanel();

        // 3. Dock steady sync skips redundant play/mode/cover/handle/volume DOM writes
        const playBtn = doc.querySelector('[data-md="play"]');
        const modeBtn = doc.querySelector('[data-md="mode"]');
        const pCover = doc.querySelector('.md-hd-cv');
        const handle = doc.querySelector('[data-md="handle"]');
        const vrail = doc.querySelector('.md-vrail');
        let playWrites = 0;
        let modeWrites = 0;
        let coverWrites = 0;
        let handleAttrWrites = 0;
        let vrailAttrWrites = 0;
        const spyInner = (el, onWrite) => Object.defineProperty(el, 'innerHTML', {
            configurable: true,
            get() { return innerDesc.get.call(this); },
            set(v) { onWrite(); return innerDesc.set.call(this, v); }
        });
        spyInner(playBtn, () => { playWrites += 1; });
        spyInner(modeBtn, () => { modeWrites += 1; });
        spyInner(pCover, () => { coverWrites += 1; });
        const origHandleSet = handle.setAttribute.bind(handle);
        handle.setAttribute = (...a) => { handleAttrWrites += 1; return origHandleSet(...a); };
        const origVrailSet = vrail.setAttribute.bind(vrail);
        vrail.setAttribute = (...a) => { vrailAttrWrites += 1; return origVrailSet(...a); };

        // Steady observer/event triggers with unchanged state skip redundant DOM writes
        app.trackTitle.textContent = 'Alpha.flac';
        app.modeBtn.setAttribute('title', '列表循环');
        app.volumeSlider.dispatchEvent(new window.Event('input'));
        app.volumeSlider.dispatchEvent(new window.Event('input'));
        doc.querySelector('.md-dock-in').dispatchEvent(new window.Event('pointerenter'));
        doc.querySelector('.md-dock-in').dispatchEvent(new window.Event('pointerleave'));
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(playWrites, 0, 'steady observers skip play button innerHTML rewrite');
        assert.equal(modeWrites, 0, 'unchanged mode title mutation skips mode button innerHTML rewrite');
        assert.equal(coverWrites, 0, 'unchanged track mutation skips cover innerHTML rewrite');
        assert.equal(handleAttrWrites, 0, 'steady hover/leave skips handle aria-describedby rewrite');
        assert.equal(vrailAttrWrites, 0, 'unchanged volume input skips volume rail aria rewrite');

        // Real state changes still update immediately
        app.isPlaying = true;
        doc.body.classList.add('music-playing');
        app.currentPlayMode = 2;
        app.modeBtn.setAttribute('title', '随机播放');
        app.volumeSlider.value = '0.4';
        app.volumeSlider.dispatchEvent(new window.Event('input'));
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(playWrites, 1, 'play state transition updates play button icon once');
        assert.equal(modeWrites, 1, 'play mode transition updates mode button icon once');
        assert.ok(vrailAttrWrites > 0, 'volume change updates volume rail aria attributes');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 83: palette hydrateRowSlot caches button attributes to avoid per-keystroke DOM reads and reuses filtered queue Set', () => {
    const { window, doc, app, dock } = setup((a) => {
        a.playlist = Array.from({ length: 40 }, (_, i) => ({
            path: `/m/${i}.flac`,
            title: `Track ${i}.flac`,
            artist: i % 2 === 0 ? 'Alpha' : 'Beta',
            album: 'Alb'
        }));
        a.currentFilteredTracks = a.playlist.slice(0, 10);
    });
    try {
        dock.openPalette();
        const input = doc.querySelector('.md-cmd-in');
        const list = doc.querySelector('.md-cmd-list');
        input.value = 'Track';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        const row0 = list.querySelector('.md-cmd-row[data-i="0"]');
        assert.ok(row0, 'row 0 rendered');
        assert.equal(row0.querySelector('.md-cmd-grp').textContent, '队列', 'filtered queue track ranks in 队列 group');

        let attrReads = 0;
        let classReads = 0;
        const origGetAttr = row0.getAttribute.bind(row0);
        row0.getAttribute = (k) => { attrReads += 1; return origGetAttr(k); };
        const clsDesc = Object.getOwnPropertyDescriptor(window.Element.prototype, 'className');
        Object.defineProperty(row0, 'className', {
            configurable: true,
            get() { classReads += 1; return clsDesc.get.call(this); },
            set(v) { return clsDesc.set.call(this, v); }
        });

        // Re-typing a narrowed query keeps row0 at index 0 active with zero DOM attribute/className reads
        input.value = 'Track 0';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(attrReads, 0, 'steady slot index skips getAttribute(aria-selected) reads');
        assert.equal(classReads, 0, 'steady slot class skips row.className reads');
        assert.equal(row0.querySelector('.md-cmd-grp').textContent, '队列', 'cached filtered queue Set preserves 队列 grouping');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 89: dock caches drawer volume row refs and avoids offsetWidth reflow on like pop', () => {
    const liked = new Set();
    const { window, doc, app, dock } = setup((a) => {
        a.isLiked = (t) => Boolean(t && liked.has(t.path));
        a.toggleLike = (t) => { if (!t) return; if (liked.has(t.path)) liked.delete(t.path); else liked.add(t.path); };
    });
    try {
        // 1. Like pop triggers synchronously on first click with 0 offsetWidth reflows
        const likeBtn = doc.querySelector('[data-md="like"]');
        let offsetReads = 0;
        Object.defineProperty(likeBtn, 'offsetWidth', { configurable: true, get() { offsetReads += 1; return 32; } });
        likeBtn.click();
        assert.equal(likeBtn.classList.contains('md-like-pop'), true, 'first like click adds md-like-pop immediately');
        assert.equal(offsetReads, 0, 'like pop performs zero synchronous offsetWidth forced reflows');

        // 2. Repeated volume drag updates reuse cached .md-vol elements with 0 body/row querySelector calls
        dock.openPanel('控制');
        const body = doc.querySelector('[data-md="body"]');
        const volRow = body.querySelector('.md-vol');
        assert.ok(volRow, 'control panel has .md-vol row');
        app.volumeSlider.value = '0.7';
        app.volumeSlider.dispatchEvent(new window.Event('input'));

        let bodyQueries = 0;
        let rowQueries = 0;
        const origBodyQ = body.querySelector.bind(body);
        body.querySelector = (sel) => { if (sel === '.md-vol') bodyQueries += 1; return origBodyQ(sel); };
        const origRowQ = volRow.querySelector.bind(volRow);
        volRow.querySelector = (sel) => { rowQueries += 1; return origRowQ(sel); };

        for (const v of ['0.6', '0.5', '0.4', '0.3']) {
            app.volumeSlider.value = v;
            app.volumeSlider.dispatchEvent(new window.Event('input'));
        }
        assert.equal(bodyQueries, 0, 'cached volRef avoids querying el.body for .md-vol on every drag event');
        assert.equal(rowQueries, 0, 'cached volRef avoids 5 sub-queries inside .md-vol on every drag event');
        assert.equal(volRow.querySelector('.md-pct').textContent, '30%');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 91: palette open focuses input before toggling md-cmd-open/body class and clones prebuilt rowProto with default music icon', () => {
    const { window, doc, dock } = setup((a) => {
        for (let i = 0; i < 12; i += 1) {
            a.playlist.push({ path: `C:/p${i}.flac`, title: `Proto Track ${i}`, artist: 'Art', album: 'Alb' });
        }
    });
    try {
        const host = doc.getElementById('music-dock-root');
        const input = doc.querySelector('.md-cmd-in');
        const origFocus = input.focus.bind(input);
        let focusSawHostClass = null;
        let focusSawBodyClass = null;
        let focusSawHidden = null;
        input.focus = (...args) => {
            focusSawHidden = doc.querySelector('.md-cmd').hidden;
            focusSawHostClass = host.classList.contains('md-cmd-open');
            focusSawBodyClass = doc.body.classList.contains('music-dock-cmd-open');
            return origFocus(...args);
        };
        dock.openPalette();
        assert.equal(focusSawHidden, false, '.md-cmd is unhidden before focus');
        assert.equal(focusSawHostClass, false, 'input.focus runs before md-cmd-open dirties #music-dock-root');
        assert.equal(focusSawBodyClass, false, 'input.focus runs before music-dock-cmd-open dirties body');
        assert.equal(host.classList.contains('md-cmd-open'), true, 'md-cmd-open is applied after focus');
        assert.equal(doc.body.classList.contains('music-dock-cmd-open'), true, 'music-dock-cmd-open is applied after focus');

        // Typing song query creates rows with pre-populated music icon + corner-down-left icon
        input.value = 'Proto Track';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        const rows = doc.querySelectorAll('.md-cmd-row');
        assert.equal(rows.length, 12);
        assert.ok(rows[1].querySelector('.md-cmd-ri svg'), 'song row receives music SVG from rowProto');
        assert.ok(rows[1].querySelector('.md-cmd-run svg'), 'song row receives enter SVG from rowProto');
        assert.equal(rows[1].querySelector('.md-cmd-chip'), null, 'song row without hint skips unused kbd chip');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 97: dock ignores non-theme head/body mutations for syncGlow, palette avoids body refocus reflow on close, and batches initial mount', async () => {
    const { window, doc, dock } = setup((a) => {
        for (let i = 0; i < 15; i += 1) {
            a.playlist.push({ path: `C:/b97_${i}.flac`, title: `Glow Track ${i}`, artist: 'Art', album: 'Alb' });
        }
    });
    try {
        let rootStyleCalls = 0;
        const origCS = window.getComputedStyle.bind(window);
        window.getComputedStyle = (el, ...rest) => {
            if (el === doc.documentElement) rootStyleCalls += 1;
            return origCS(el, ...rest);
        };

        // 1. Unrelated body class (openPalette) & head <script> / <style data-md> edits skip syncGlow
        const bodyFocusCalls = [];
        const origBodyFocus = doc.body.focus.bind(doc.body);
        doc.body.focus = (...args) => { bodyFocusCalls.push(doc.body.classList.contains('music-dock-cmd-open')); return origBodyFocus(...args); };

        const list = doc.querySelector('.md-cmd-list');
        let insertBeforeCalls = 0;
        const origInsertBefore = list.insertBefore.bind(list);
        list.insertBefore = (...args) => { insertBeforeCalls += 1; return origInsertBefore(...args); };

        dock.openPalette();
        const input = doc.querySelector('.md-cmd-in');
        insertBeforeCalls = 0;
        input.value = 'Glow Track';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(doc.querySelectorAll('.md-cmd-row').length, 15, 'all 15 matching rows rendered');
        assert.equal(insertBeforeCalls, 0, 'initial empty-to-results palette mount batches via DocumentFragment replaceChildren');

        const scr = doc.createElement('script');
        doc.head.appendChild(scr);
        const helperStyle = doc.createElement('style');
        helperStyle.dataset.md = 'toast-pos';
        doc.head.appendChild(helperStyle);
        helperStyle.textContent = '.mtst-layer{--md-toast-x:100px}';

        dock.closePalette();
        assert.equal(bodyFocusCalls.length, 0, 'closing palette when prior focus was body blurs input without calling body.focus()');
        assert.notEqual(doc.activeElement, input, 'palette input is blurred on close');

        await new Promise((r) => setTimeout(r, 90));
        assert.equal(rootStyleCalls, 0, 'unrelated body class and head script/toast-pos style trigger zero syncGlow getComputedStyle calls');

        // Real stylesheet <link> addition in <head> still schedules syncGlow
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'theme.css';
        doc.head.appendChild(link);
        await new Promise((r) => setTimeout(r, 90));
        assert.ok(rootStyleCalls >= 1, 'real stylesheet <link> in <head> still triggers syncGlow');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 101: queue caches window key on scroller._qWinKey (not DOM dataset) and batch-mounts initial rows via DocumentFragment', () => {
    const { window, doc, app, dock } = setup((a) => {
        for (let i = 0; i < 20; i += 1) {
            a.playlist.push({ path: `C:/q101_${i}.flac`, title: `Q101 Track ${i}`, artist: 'Art' });
        }
        a.getUpNext = () => ({ manual: a.playlist.slice(0, 12), context: a.playlist.slice(12) });
    });
    try {
        dock.openPanel('播放列表');
        const scroller = doc.querySelector('.md-ql');
        assert.ok(scroller, 'queue scroller rendered');
        assert.equal(scroller.dataset.window, undefined, 'queue window key is stored on JS property instead of DOM dataset attribute');
        assert.equal(typeof scroller._qWinKey, 'string', 'queue window key cached on scroller._qWinKey');
        assert.ok(scroller.querySelectorAll('.md-qi').length > 0, 'queue rows mounted');

        // Re-render into empty sizer uses a single DocumentFragment appendChild (not N per-row appends)
        const sizer = scroller.querySelector('.md-ql-sizer');
        let directAppends = 0;
        const origAppend = sizer.appendChild.bind(sizer);
        sizer.appendChild = (...args) => { directAppends += 1; return origAppend(...args); };
        sizer.replaceChildren();
        scroller._qWinKey = '';
        doc.dispatchEvent(new window.CustomEvent('music-queue-change'));
        assert.equal(directAppends, 1, 'empty-sizer initial queue mount batches via a single DocumentFragment appendChild');
        assert.ok(sizer.querySelectorAll('.md-qi').length > 0, 'queue rows re-mounted cleanly');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 102: palette mirrors .md-has-drop on .md-cmd-list without CSS :has() and clears it when empty', () => {
    const { window, doc, dock } = setup((_app, win) => {
        win.MusicFluid = { slide() {}, bud() {} };
    });
    try {
        dock.openPalette();
        const list = doc.querySelector('.md-cmd-list');
        const input = doc.querySelector('.md-cmd-in');
        input.value = 'Alpha';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(list.classList.contains('md-has-drop'), true, 'non-empty results with fluid drop set .md-has-drop');
        input.value = 'zzzz-no-match-102';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(list.classList.contains('md-has-drop'), false, 'empty results remove .md-has-drop');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 103: palette CSS applies content-visibility to .md-cmd-row, pre-pools .md-cmd-desc via hidden toggle, and drops tuning :has()', () => {
    const panelCss = read('Musicmodules/music-dock/music-dock-panel.css');
    assert.match(panelCss, /\.md-cmd-row\s*\{[^}]*content-visibility:\s*auto;/, '.md-cmd-row uses content-visibility: auto');
    assert.match(panelCss, /\.md-cmd-desc\[hidden\]\s*\{\s*display:\s*none;\s*\}/, '.md-cmd-desc[hidden] hides pooled description element');
    assert.doesNotMatch(panelCss, /\.music-stage-tuning-row:has\(/, 'stage tuning :has() selectors removed from music-dock-panel.css');

    const { window, doc, dock } = setup();
    try {
        dock.openPalette();
        const input = doc.querySelector('.md-cmd-in');
        // Song with artist -> shows pre-pooled .md-cmd-desc
        input.value = 'Alpha';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        const row0 = doc.querySelector('.md-cmd-row');
        const desc0 = row0.querySelector('.md-cmd-desc');
        assert.ok(desc0, 'rowProto pre-includes .md-cmd-desc');
        assert.equal(desc0.hidden, false, 'song row with artist unhides .md-cmd-desc');

        // Command without desc -> hides same .md-cmd-desc node in-place (no remove/recreate)
        input.value = '下一首';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(row0.querySelector('.md-cmd-desc'), desc0, 'same .md-cmd-desc node reused without DOM removal');
        assert.equal(desc0.hidden, true, 'command without desc hides .md-cmd-desc');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 109: drawer reuses tab buttons in-place, scrolls queue before body.music-drawer-open, and palette executes bindless song items', () => {
    const { window, doc, app, dock } = setup();
    try {
        const extra = Array.from({ length: 20 }, (_, i) => ({ path: `C:/b109_${i}.flac`, title: `Song ${i}.flac`, artist: 'Artist X', album: 'Alb' }));
        app.playlist.push(...extra);
        app.getHistory = () => extra.slice(0, 5);
        app.getUpNext = () => ({ manual: [], context: extra.slice(5) });

        // Track order of scrollTop vs body.music-drawer-open during openPanel('播放列表')
        let bodyDirtyAtScroll = null;
        const origScrollDesc = Object.getOwnPropertyDescriptor(window.HTMLDivElement.prototype, 'scrollTop')
            || Object.getOwnPropertyDescriptor(window.Element.prototype, 'scrollTop');
        Object.defineProperty(window.Element.prototype, 'scrollTop', {
            configurable: true,
            get() { return origScrollDesc ? origScrollDesc.get.call(this) : (this._st || 0); },
            set(v) {
                if (this.classList?.contains('md-ql') && v > 0) {
                    bodyDirtyAtScroll = doc.body.classList.contains('music-drawer-open');
                }
                if (origScrollDesc) origScrollDesc.set.call(this, v); else this._st = v;
            }
        });
        try {
            dock.openPanel('播放列表');
        } finally {
            if (origScrollDesc) Object.defineProperty(window.Element.prototype, 'scrollTop', origScrollDesc);
        }
        assert.equal(bodyDirtyAtScroll, false, 'queue scrollTop runs before body.music-drawer-open dirties document layout');
        assert.equal(doc.body.classList.contains('music-drawer-open'), true, 'body.music-drawer-open is set by end of openPanel');

        // Tab buttons are reused in-place across tab switches and close/reopen
        const firstTabButtons = [...doc.querySelectorAll('.md-dockrow .md-seg button[data-i]')];
        assert.equal(firstTabButtons.length, 5);
        dock.openPanel('控制');
        dock.closePanel();
        dock.openPanel('歌词');
        const laterTabButtons = [...doc.querySelectorAll('.md-dockrow .md-seg button[data-i]')];
        for (let i = 0; i < firstTabButtons.length; i += 1) {
            assert.equal(laterTabButtons[i], firstTabButtons[i], `tab button ${i} reused without innerHTML teardown`);
        }

        // Palette bindless song items still play, playNext, and queueAdd cleanly
        const loaded = [];
        const queued = [];
        const nexted = [];
        app.loadTrack = (idx) => loaded.push(idx);
        app.queueAdd = (tr) => queued.push(tr);
        app.queuePlayNext = (tr) => nexted.push(tr);
        dock.openPalette();
        const input = doc.querySelector('.md-cmd-in');
        input.value = 'Song 3';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
        assert.equal(nexted.length, 1);
        assert.equal(nexted[0].title, 'Song 3.flac');
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
        assert.equal(queued.length, 1);
        assert.equal(queued[0].title, 'Song 3.flac');
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        assert.equal(loaded.length, 1);
        assert.equal(app.playlist[loaded[0]].title, 'Song 3.flac');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 110: palette pre-bakes rowProto defaults & bindless cached playlists, fluid-select snapshots before trigger writes, and dock-fluid retargets in-place', async () => {
    const { window, doc, app, dock } = setup((a) => {
        a.customPlaylists = [
            { id: 'pl-1', name: '夜间通勤', tracks: [a.playlist[0].path, a.playlist[1].path] },
            { id: 'pl-empty', name: '空单测试', tracks: [] }
        ];
    });
    try {
        // 1. Palette bindless playlist item: play / playNext / queueAdd + cache invalidation on reopen
        const loaded = [];
        const queued = [];
        const nexted = [];
        app.loadTrack = (idx) => loaded.push(idx);
        app.queueAdd = (tr) => queued.push(tr);
        app.queuePlayNext = (tr) => nexted.push(tr);
        dock.openPalette();
        const input = doc.querySelector('.md-cmd-in');
        input.value = '夜间通勤';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        const plRow = doc.querySelector('.md-cmd-row');
        assert.ok(plRow, 'playlist row rendered');
        assert.equal(plRow.querySelector('.md-cmd-title').textContent, '夜间通勤');
        assert.equal(plRow.querySelector('.md-cmd-desc').textContent, '2 首');
        assert.equal(plRow.getAttribute('aria-selected'), 'true');
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
        assert.equal(nexted.length, 2, 'Shift+Enter queues playlist next');
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
        assert.equal(queued.length, 2, 'Ctrl+Enter appends playlist to queue');
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        assert.equal(loaded.length, 1, 'Enter plays playlist from first track');
        assert.equal(app.filteredPlaylistSource?.id, 'pl-1');

        // Reopen invalidates playlist cache so updated tracks reflect immediately
        app.customPlaylists[0].tracks.pop();
        dock.openPalette();
        input.value = '夜间通勤';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(doc.querySelector('.md-cmd-row .md-cmd-desc').textContent, '1 首', 'reopening palette refreshes cached playlist track count');
        dock.closePalette();

        // 2. music-fluid-select: open paints aria-selected/mfs-on directly, close snapshots BEFORE mutating trigger, bodyObs skips .md-qi/.md-cmd-row
        window.CSS = window.CSS || { escape: (s) => String(s) };
        const sel = doc.createElement('select');
        sel.innerHTML = '<option value="a">A</option><option value="b" selected>B</option>';
        doc.body.appendChild(sel);
        const snapOrder = [];
        window.MusicFluid = {
            enabled: () => true,
            bud() {},
            snapshot: (menu) => {
                snapOrder.push(`snap:open=${trigger.classList.contains('mfs-open')}:exp=${trigger.getAttribute('aria-expanded')}`);
                return { menu };
            },
            melt: () => { snapOrder.push('melt'); }
        };
        window.eval(read('Musicmodules/music-dock/music-fluid-select.js'));
        await new Promise((r) => setTimeout(r, 0));
        const trigger = sel.nextElementSibling;
        assert.ok(trigger && trigger.classList.contains('mfs-trigger'), 'select dressed with fluid trigger');
        // bodyObs fast-skips .md-qi / .md-cmd-row insertions without calling closest() on target
        let closestCalls = 0;
        const wrap = doc.createElement('div');
        doc.body.appendChild(wrap);
        await new Promise((r) => setTimeout(r, 0));
        const origClosest = wrap.closest.bind(wrap);
        wrap.closest = (...args) => { closestCalls += 1; return origClosest(...args); };
        const qi = doc.createElement('div');
        qi.className = 'md-qi';
        qi.innerHTML = '<span>row</span>';
        const crow = doc.createElement('button');
        crow.className = 'md-cmd-row';
        crow.innerHTML = '<span>cmd</span>';
        wrap.append(qi, crow);
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(closestCalls, 0, 'bodyObs O(1) class fast-skip avoids tgt.closest() for .md-qi and .md-cmd-row');
        trigger.click();
        const opts = [...doc.querySelectorAll('.mfs-menu .mfs-item')];
        assert.equal(opts.length, 2);
        assert.equal(opts[0].classList.contains('mfs-on'), false);
        assert.equal(opts[0].getAttribute('aria-selected'), 'false');
        assert.equal(opts[1].classList.contains('mfs-on'), true);
        assert.equal(opts[1].getAttribute('aria-selected'), 'true');
        trigger.click(); // close
        assert.equal(snapOrder[0], 'snap:open=true:exp=true', 'fluid-select captures snapshot BEFORE removing mfs-open / aria-expanded');
        assert.equal(snapOrder[1], 'melt');
        assert.equal(trigger.classList.contains('mfs-open'), false);
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');

        // 3. music-dock-fluid: retargetRing updates tx/ty in-place for playhead, drop, fixed, and corner modes
        const fHost = doc.createElement('div');
        const fBar = doc.createElement('div');
        fBar.getBoundingClientRect = () => ({ left: 100, right: 500, top: 600, bottom: 656, width: 400, height: 56 });
        fHost.appendChild(fBar);
        doc.body.appendChild(fHost);
        const fl = window.createMusicDockFluid({ host: fHost, bar: fBar, reduced: () => true });
        assert.ok(fl.layout());
        fl.setRingMode('playhead');
        fl.setProgress(0.5);
        const dbg1 = fl.debug();
        assert.ok(Number.isFinite(dbg1.ring.tx) && Number.isFinite(dbg1.ring.ty));
        fl.setRingDocked(false);
        const dbg2 = fl.debug();
        assert.notEqual(dbg2.ring.tx, dbg1.ring.tx, 'undocking ring retargets to corner coordinates');
        fl.destroy();
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 112: containment CSS, pre-baked queue .md-qdur hidden toggle & cachedQueueH, and fluid barSig short-circuit', () => {
    // 1. CSS containment & .md-qdur[hidden]
    const skinCss = read('Musicmodules/music-theme/music-skin.css');
    const dockCss = read('Musicmodules/music-dock/music-dock.css');
    const panelCss = read('Musicmodules/music-dock/music-dock-panel.css');
    assert.match(skinCss, /\.sidebar-list-container\s*\{[^}]*contain:\s*layout paint style/);
    assert.match(skinCss, /\.sidebar-playlist\s*\{[^}]*contain:\s*layout paint style/);
    assert.match(dockCss, /\.md-dock\s*\{[^}]*contain:\s*layout style/);
    assert.match(panelCss, /#music-dock-root\s+\.md-qdur\[hidden\]\s*\{\s*display:\s*none;/);

    // 2. Queue pre-baked .md-qdur toggle (zero createElement/remove), duration formatting (<1h & >=1h), and cachedQueueH
    const { window, doc, app, dock } = setup((a) => {
        a.playlist.splice(0, a.playlist.length,
            { path: 'C:/q0.flac', title: 'Now', artist: 'A', duration: 65 },
            { path: 'C:/q1.flac', title: 'Long', artist: 'B', duration: 3661 },
            { path: 'C:/q2.flac', title: 'NoDur', artist: 'C', duration: 0 },
            ...Array.from({ length: 40 }, (_, i) => ({
                path: `C:/q${i + 3}.flac`,
                title: `Track ${i + 3}`,
                artist: 'Art',
                duration: i % 2 === 0 ? 125 : 0
            }))
        );
        a.manualQueue = [a.playlist[1], a.playlist[2]];
        a.getUpNext = () => ({ manual: a.manualQueue.slice(), context: a.playlist.slice(3) });
        a.getHistory = () => [];
    });
    try {
        dock.openPanel('播放列表');
        const scroller = doc.querySelector('.md-ql');
        assert.ok(scroller);
        const manRows = [...scroller.querySelectorAll('.md-man')];
        assert.equal(manRows.length, 2);
        const longDur = manRows[0].querySelector('.md-qdur');
        const emptyDur = manRows[1].querySelector('.md-qdur');
        assert.equal(longDur.textContent, '1:01:01', 'formats >=3600s duration without padStart');
        assert.equal(longDur.hidden, false);
        assert.equal(emptyDur.hidden, true, 'zero-duration row hides pre-baked .md-qdur in-place');

        let viewH = 260;
        let chReads = 0;
        Object.defineProperty(scroller, 'clientHeight', {
            configurable: true,
            get() { chReads += 1; return viewH; }
        });
        // Scroll reads clientHeight once to populate cachedQueueH, then reuses cache across subsequent scrolls
        let spanCreates = 0;
        const origCreate = doc.createElement.bind(doc);
        doc.createElement = (tag, ...rest) => {
            if (String(tag).toLowerCase() === 'span') spanCreates += 1;
            return origCreate(tag, ...rest);
        };
        scroller.scrollTop = 480;
        scroller.dispatchEvent(new window.Event('scroll'));
        assert.equal(chReads, 1, 'first scroll caches scroller.clientHeight');
        scroller.scrollTop = 960;
        scroller.dispatchEvent(new window.Event('scroll'));
        scroller.scrollTop = 1440;
        scroller.dispatchEvent(new window.Event('scroll'));
        assert.equal(chReads, 1, 'subsequent scrolls reuse cachedQueueH without layout reads');
        assert.equal(spanCreates, 0, 'scrolling between timed and untimed rows toggles .md-qdur.hidden without creating spans');
        doc.createElement = origCreate;

        // Resize invalidates cachedQueueH
        viewH = 380;
        window.dispatchEvent(new window.Event('resize'));
        scroller.scrollTop = 1600;
        scroller.dispatchEvent(new window.Event('scroll'));
        assert.equal(chReads, 2, 'window resize invalidates cachedQueueH');
        dock.closePanel();

        // 3. music-dock-fluid: unchanged barSig short-circuits before playBtn/volBtn getBoundingClientRect
        const fHost = doc.createElement('div');
        const fBar = doc.createElement('div');
        const playBtn = doc.createElement('button');
        const volBtn = doc.createElement('button');
        playBtn.setAttribute('data-md', 'play');
        volBtn.setAttribute('data-md', 'vol');
        fBar.append(playBtn, volBtn);
        fHost.appendChild(fBar);
        doc.body.appendChild(fHost);
        let playRectReads = 0;
        let volRectReads = 0;
        fBar.getBoundingClientRect = () => ({ left: 100, right: 500, top: 600, bottom: 656, width: 400, height: 56 });
        playBtn.getBoundingClientRect = () => { playRectReads += 1; return { left: 120, right: 152, top: 612, bottom: 644, width: 32, height: 32 }; };
        volBtn.getBoundingClientRect = () => { volRectReads += 1; return { left: 440, right: 472, top: 612, bottom: 644, width: 32, height: 32 }; };
        const fl = window.createMusicDockFluid({ host: fHost, bar: fBar, reduced: () => true });
        assert.equal(fl.layout(), true);
        assert.equal(playRectReads, 1);
        assert.equal(volRectReads, 1);
        assert.equal(fl.layout(), true);
        assert.equal(playRectReads, 1, 'unchanged barSig skips playBtn getBoundingClientRect');
        assert.equal(volRectReads, 1, 'unchanged barSig skips volBtn getBoundingClientRect');
        fHost.classList.add('md-squeeze');
        assert.equal(fl.layout(), true);
        assert.equal(playRectReads, 2, 'md-squeeze class change busts barSig');
        fl.destroy();
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 118: segmented arrow keys do not trigger dock seek, palette --Artist hides hints, queue remove skips playlist.indexOf, and virtual scrollers disable scroll anchoring', () => {
    const skinCss = read('Musicmodules/music-theme/music-skin.css');
    const panelCss = read('Musicmodules/music-dock/music-dock-panel.css');
    assert.match(skinCss, /\.sidebar-playlist\s*\{[^}]*overflow-anchor:\s*none;/, 'classic virtual playlist sets overflow-anchor: none');
    assert.match(panelCss, /\.md-ql\s*\{[^}]*overflow-anchor:\s*none;/, 'queue virtual scroller sets overflow-anchor: none');

    const { window, doc, app, dock } = setup((a) => {
        a.isStageActive = true;
        a.lastKnownDuration = 200;
        a.lastKnownCurrentTime = 50;
        a.seekCalls = [];
        a.seekTo = (t) => a.seekCalls.push(t);
        a.playlist.splice(0, a.playlist.length,
            { path: 'C:/s0.flac', title: 'Now', artist: 'A', duration: 200 },
            { path: 'C:/s1.flac', title: 'Manual 1', artist: 'B', duration: 180 }
        );
        a.manualQueue = [a.playlist[1]];
        a.getUpNext = () => ({ manual: a.manualQueue.slice(), context: [] });
        a.getHistory = () => [];
        a.queueRemove = (idx) => { a.removedIdx = idx; a.manualQueue.splice(idx, 1); };
    });
    try {
        // 1. Segmented control inside stage settings: ArrowRight switches option without invoking dock seekTo
        const seg = doc.createElement('div');
        seg.className = 'music-skin-segmented';
        const b1 = doc.createElement('button');
        b1.type = 'button';
        const b2 = doc.createElement('button');
        b2.type = 'button';
        seg.append(b1, b2);
        doc.body.appendChild(seg);
        b1.focus();
        const ev = new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
        b1.dispatchEvent(ev);
        assert.equal(app.seekCalls.length, 0, 'ArrowRight inside .music-skin-segmented does not seek playback');
        assert.equal(ev.defaultPrevented, false, 'dock capture handler leaves ArrowRight un-prevented for segmented control');

        // 2. Palette uppercase --Artist flag closes hint list cleanly
        dock.openPalette();
        const input = doc.querySelector('.md-cmd-in');
        const hints = doc.querySelector('.md-cmd-hints');
        input.value = '--Art';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(hints.hidden, false, 'partial --Art shows filter hints');
        input.value = '--Artist';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(hints.hidden, true, 'completed case-insensitive --Artist hides filter hints');
        dock.closePalette();

        // 3. Queue remove button does not scan app.playlist.indexOf
        dock.openPanel('播放列表');
        const origIndexOf = app.playlist.indexOf.bind(app.playlist);
        let indexOfCalls = 0;
        app.playlist.indexOf = (...args) => { indexOfCalls += 1; return origIndexOf(...args); };
        const removeBtn = doc.querySelector('.md-man [data-qact="remove"]');
        assert.ok(removeBtn, 'manual queue row exposes remove button');
        removeBtn.click();
        assert.equal(app.removedIdx, 0, 'remove button invokes queueRemove(0)');
        assert.equal(indexOfCalls, 0, 'remove action does not scan app.playlist.indexOf');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 121: fluid-kit skips input focusin & checks trail container before :focus-visible, palette cancels bud on close & filters compound queries via only, and drawer CSS disables low-tier blur', () => {
    const { window, doc, app, dock } = setup((a) => {
        a.playlist.splice(0, a.playlist.length,
            { path: 'C:/a1.flac', title: 'Live Alpha', artist: 'Jay', album: 'One', duration: 200 },
            { path: 'C:/a2.flac', title: 'Live Beta', artist: 'Eason', album: 'Two', duration: 210 },
            { path: 'C:/a3.flac', title: 'Studio Gamma', artist: 'Jay', album: 'Three', duration: 220 }
        );
    });
    try {
        window.eval(read('Musicmodules/music-dock/music-fluid-kit.js'));
        window.eval(read('Musicmodules/music-archive/archive-index.js'));

        // 1. Focusing an <input> or a non-trail button must not call matches(':focus-visible')
        const outsideBtn = doc.createElement('button');
        outsideBtn.type = 'button';
        const plainInput = doc.createElement('input');
        doc.body.append(outsideBtn, plainInput);
        let fvCalls = 0;
        for (const node of [outsideBtn, plainInput]) {
            const origMatches = node.matches.bind(node);
            node.matches = (sel) => {
                if (sel === ':focus-visible') fvCalls += 1;
                return origMatches(sel);
            };
        }
        plainInput.focus();
        outsideBtn.focus();
        assert.equal(fvCalls, 0, 'focusin on input or non-trail button skips :focus-visible style check');

        // 2. Palette close cancels active MusicFluid.bud(box) and compound filter passes only: order
        let cancelledNode = null;
        const origFluid = window.MusicFluid;
        window.MusicFluid = { ...origFluid, cancel: (node) => { cancelledNode = node; return origFluid.cancel?.(node); } };
        dock.openPalette();
        const input = doc.querySelector('.md-cmd-in');
        input.value = 'Live --artist Jay';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        const titles = [...doc.querySelectorAll('.md-cmd-row .md-cmd-title')].map((n) => n.textContent);
        assert.deepEqual(titles, ['Live Alpha'], 'compound text + --artist filter preserves exact match');
        dock.closePalette();
        assert.equal(cancelledNode, doc.querySelector('.md-cmd-box'), 'closePalette cancels any running bud animation on .md-cmd-box');

        // 3. Energy-saving drawer CSS disables backdrop-filter on .md-drbg and .md-hdl-tip
        const drawerCss = read('Musicmodules/music-dock/music-dock-drawer.css');
        assert.match(drawerCss, /body\.music-fl-low \.md-drbg[\s\S]*?backdrop-filter:\s*none;/);
        assert.match(drawerCss, /body\.music-fl-low \.md-hdl-tip[\s\S]*?backdrop-filter:\s*none;/);
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 126: dock filters non-empty archive-view and non-edge HUD class mutations, and palette flushSlide scrolls before sliding', async () => {
    let hudRectReads = 0;
    const rafs = [];
    const { window, doc, dock } = setup((a, w) => {
        Object.defineProperty(w, 'innerWidth', { configurable: true, value: 1280 });
        a.archiveView = { mode: 'archive' };
        w.requestAnimationFrame = (cb) => { rafs.push(cb); return rafs.length; };
        w.cancelAnimationFrame = () => {};
        const view = w.document.createElement('div');
        view.id = 'music-archive-view';
        const hud = w.document.createElement('div');
        hud.className = 'archive-hud list-open';
        Object.defineProperty(hud, 'offsetWidth', { configurable: true, value: 1280 });
        hud.getBoundingClientRect = () => { hudRectReads += 1; return { left: 0, right: 1280, width: 1280, height: 800 }; };
        const list = w.document.createElement('div');
        list.className = 'archive-list';
        Object.defineProperty(list, 'offsetLeft', { configurable: true, value: 20 });
        Object.defineProperty(list, 'offsetWidth', { configurable: true, value: 300 });
        hud.appendChild(list);
        view.appendChild(hud);
        w.document.body.appendChild(view);
        w.document.body.classList.add('music-archive-on');
    });
    try {
        while (rafs.length) rafs.shift()(16);
        assert.ok(hudRectReads >= 1, 'initial syncShift measures archiveEdges and hooks hudObserver');
        const view = doc.getElementById('music-archive-view');
        const hud = view.querySelector('.archive-hud');

        // Layout-switch classes on #music-archive-view and unrelated classes on .archive-hud must not re-measure archiveEdges
        hudRectReads = 0;
        view.classList.add('layout-wall', 'layout-flat', 'archive-post-atmos');
        view.classList.remove('layout-wall');
        view.classList.add('layout-table');
        hud.classList.add('unrelated-flag');
        await new Promise((r) => window.setTimeout(r, 0));
        while (rafs.length) rafs.shift()(16);
        assert.equal(hudRectReads, 0, 'non-empty archive-view and non-edge HUD class toggles skip archiveEdges reflow');

        // Relevant edge class (list-open) and is-empty still trigger re-measurement
        hud.classList.remove('list-open');
        await new Promise((r) => window.setTimeout(r, 0));
        while (rafs.length) rafs.shift()(16);
        assert.equal(hudRectReads, 1, 'list-open edge class mutation triggers archiveEdges measurement');

        hudRectReads = 0;
        view.classList.add('is-empty');
        await new Promise((r) => window.setTimeout(r, 0));
        while (rafs.length) rafs.shift()(16);
        assert.equal(hudRectReads, 1, 'is-empty mutation on #music-archive-view triggers archiveEdges measurement');

        // Palette flushSlide runs scrollIntoView BEFORE MusicFluid.slide writes drop style
        const order = [];
        window.MusicFluid = {
            enabled: () => false,
            slide: () => { order.push('slide'); }
        };
        dock.openPalette('a');
        while (rafs.length) rafs.shift()(16);
        const rows = [...doc.querySelectorAll('.md-cmd-row')];
        assert.ok(rows.length >= 2, 'palette renders multiple rows');
        for (const r of rows) r.scrollIntoView = () => { order.push('scroll'); };
        order.length = 0;
        const input = doc.querySelector('.md-cmd-in');
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        while (rafs.length) rafs.shift()(16);
        assert.deepEqual(order, ['scroll', 'slide'], 'flushSlide scrolls active row into view before MusicFluid.slide writes drop style');
        dock.closePalette();
    } finally {
        dock.destroy();
        window.close();
    }
});

test('Batch 128: initMusicDock defers initial capsule getBoundingClientRect measurement to boot rAF', () => {
    let capRectReads = 0;
    const rafs = [];
    const { window, doc, dock } = setup((a, w) => {
        w.requestAnimationFrame = (cb) => { rafs.push(cb); return rafs.length; };
        w.cancelAnimationFrame = () => {};
        const origRect = w.HTMLElement.prototype.getBoundingClientRect;
        w.HTMLElement.prototype.getBoundingClientRect = function () {
            if (this.classList?.contains('md-cap')) capRectReads += 1;
            return origRect.call(this);
        };
    });
    try {
        assert.equal(capRectReads, 0, 'initMusicDock avoids synchronous .md-cap getBoundingClientRect during DOMContentLoaded');
        while (rafs.length) rafs.shift()(16);
        assert.ok(capRectReads >= 1, 'boot rAF performs capsule measurement once layout is ready');
        assert.ok(doc.querySelector('.md-trk').style.getPropertyValue('--md-a'), 'progress range custom properties are set');
    } finally {
        dock.destroy();
        window.close();
    }
});
