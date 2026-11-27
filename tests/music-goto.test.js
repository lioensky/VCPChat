const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 右键「转到歌手 / 转到专辑」：只在档案页可用，曲目缺这项信息时不给跳。
const { setupMusicGoto } = require(path.join(__dirname, '../Musicmodules/music-goto.js'));

function setup({ mode = 'archive', stage = false } = {}) {
    const calls = [];
    globalThis.document = { body: { classList: { contains: (c) => stage && c === 'music-stage-active' } } };
    const app = {
        playlist: [{ path: 'a', title: 'a', artist: 'Ren', album: '窗边' }, { path: 'b', title: 'b', artist: '', album: 'X' }],
        archiveView: {
            mode,
            setListOpen: (open) => calls.push('open:' + open),
            list: { goToGroup: (i, kind) => { calls.push(`go:${i}:${kind}`); return true; } }
        }
    };
    setupMusicGoto(app);
    return { app, calls };
}

test('goes to the artist group in the archive directory', () => {
    const { app, calls } = setup();
    assert.equal(app.goToGroup(0, 'artist'), true);
    assert.deepEqual(calls, ['open:true', 'go:0:artist']);
});

test('refuses when the track has no artist, or the archive page is not showing', () => {
    assert.equal(setup().app.goToGroup(1, 'artist'), false);
    assert.equal(setup().app.goToGroup(1, 'album'), true);
    assert.equal(setup({ mode: 'classic' }).app.goToGroup(0, 'artist'), false);
    assert.equal(setup({ stage: true }).app.goToGroup(0, 'album'), false);
});

test('copy text is "title - artist" without the file extension', () => {
    const { copyText } = require(path.join(__dirname, '../Musicmodules/music-goto.js'));
    const app = { stripAudioExtension: (s) => s.replace(/\.flac$/, '') };
    assert.equal(copyText(app, { title: '晴天.flac', artist: 'Ren' }), '晴天 - Ren');
    assert.equal(copyText({}, { title: 'Night Train.mp3', artist: '' }), 'Night Train');
    assert.equal(copyText(app, null), '');
});

test('copy-title menu item does not report false success when clipboard is unavailable or rejects', async () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><div id="menu"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    const toasts = [];
    window.MusicToast = { show: (opts) => toasts.push(opts) };
    window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-app-hooks.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-goto.js'), 'utf8'));
    const menu = window.document.getElementById('menu');
    const app = {
        playlist: [{ path: '/a.flac', title: 'Song.flac', artist: 'Ren', album: 'Alb' }],
        contextMenu: menu,
        contextMenuTrackIndex: 0,
        showContextMenu() {},
        stripAudioExtension: (s) => s.replace(/\.flac$/, '')
    };
    window.setupMusicGoto(app);
    const copyBtn = menu.querySelector('[data-action="copy-title"]');
    assert.ok(copyBtn);

    // 剪贴板不可用时应报失败而非“已复制”
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined });
    copyBtn.click();
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].kind, 'error');

    // writeText 拒绝时也应报失败
    Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('denied')) }
    });
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(toasts.length, 2);
    assert.equal(toasts[1].kind, 'error');

    // writeText 成功时提示已复制
    Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.resolve() }
    });
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(toasts.length, 3);
    assert.match(toasts[2].message, /已复制「Song - Ren」/);
    window.close();
});

test('music-device-sound debounces rapid EQ slider saves and flushes on demand/beforeunload', () => {
    const { setupMusicDeviceSound } = require(path.join(__dirname, '../Musicmodules/music-device-sound.js'));
    const store = new Map();
    let writes = 0;
    const storage = {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => { if (k === 'musicDeviceSound') writes += 1; store.set(k, v); }
    };
    const app = {
        eqBands: { '60Hz': 0, '1kHz': 0 },
        eqEnabled: true,
        updateUIWithState() {},
        sendEqSettings() { return Promise.resolve({ status: 'success' }); }
    };
    setupMusicDeviceSound(app, { storage });
    app.updateUIWithState({ output_device: 'Headphones' });
    assert.equal(writes, 1, 'initial unseen device persists immediately');

    // 连续调整 EQ：未 flush 前走防抖，不会每次调用同步写 localStorage
    for (let g = 1; g <= 5; g++) {
        app.eqBands['60Hz'] = g;
        app.sendEqSettings();
    }
    assert.equal(writes, 1, 'rapid slider drags coalesce into a single debounced write');
    app.deviceSound.flush();
    assert.equal(writes, 2, 'flush persists latest profile once');
    assert.equal(app.deviceSound.profiles().Headphones.bands['60Hz'], 5);
    // 无变化再次调用不重复写盘
    app.sendEqSettings();
    app.deviceSound.flush();
    assert.equal(writes, 2, 'unchanged profile skips redundant write');
});

test('music-lyrics-ai deduplicates concurrent translation requests for the same lyric snapshot', async () => {
    const { setupMusicLyricsAi } = require(path.join(__dirname, '../Musicmodules/music-lyrics-ai.js'));
    let calls = 0;
    let resolveReq;
    const lines = [
        { time: 1, original: 'Hello morning sunlight' },
        { time: 5, original: 'Walking through the rain' }
    ];
    const app = {
        playlist: [{ path: '/a.flac', title: 'Rain.flac', artist: 'A' }],
        currentTrackIndex: 0,
        currentLyrics: lines,
        lyricsRequestToken: 7,
        fetchAndDisplayLyrics: async () => {},
        renderLyrics() {},
        api: {
            translateMusicLyrics: () => {
                calls += 1;
                return new Promise((r) => { resolveReq = r; });
            }
        }
    };
    setupMusicLyricsAi(app, { storage: { getItem: () => null, setItem() {} } });
    const p1 = app.lyricsAi.translateNow();
    const p2 = app.lyricsAi.translateNow();
    assert.equal(calls, 1, 'second concurrent translateNow does not fire duplicate LLM call');
    resolveReq({ status: 'success', translations: ['你好晨光', '漫步雨中'] });
    await Promise.all([p1, p2]);
    assert.equal(app.currentLyrics[0].translation, '你好晨光');
    assert.equal(app.currentLyrics[1].translation, '漫步雨中');
});
