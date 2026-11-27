const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

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

test('music-device-sound caches connected EQ sliders and refreshes when detached', () => {
    const dom = new JSDOM('<!doctype html><body><input id="eq-60Hz" value="0"><input id="eq-1kHz" value="0"></body>', {
        runScripts: 'outside-only',
        url: 'http://localhost/'
    });
    try {
        const { window } = dom;
        const doc = window.document;
        let lookups = 0;
        const origGetById = doc.getElementById.bind(doc);
        doc.getElementById = (id) => { lookups += 1; return origGetById(id); };
        window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-app-hooks.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-device-sound.js'), 'utf8'));
        const store = new Map();
        const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
        const app = {
            eqBands: { '60Hz': 0, '1kHz': 0 },
            eqEnabled: true,
            updateUIWithState() {},
            sendEqSettings() { return Promise.resolve({ status: 'success' }); }
        };
        window.MusicDeviceSound.setupMusicDeviceSound(app, { storage });
        app.updateUIWithState({ output_device: 'Headphones' });
        const afterFirst = lookups;
        assert.equal(afterFirst, 2, 'initial lookup queries each band slider once');

        const s60 = origGetById('eq-60Hz');
        s60.value = '4';
        app.sendEqSettings();
        s60.value = '6';
        app.sendEqSettings();
        assert.equal(lookups, afterFirst, 'subsequent slider drags hit sliderCache without getElementById');
        app.deviceSound.flush();
        assert.equal(app.deviceSound.profiles().Headphones.bands['60Hz'], 6);

        // 替换 DOM 节点后自动失效重建缓存
        s60.remove();
        const fresh = doc.createElement('input');
        fresh.id = 'eq-60Hz';
        fresh.value = '-3';
        doc.body.appendChild(fresh);
        app.sendEqSettings();
        assert.equal(lookups, afterFirst + 1, 'detached slider refreshes cache');
        app.deviceSound.flush();
        assert.equal(app.deviceSound.profiles().Headphones.bands['60Hz'], -3);
    } finally {
        dom.window.close();
    }
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

test('music-lyrics-ai promotes in-flight auto translation when translateNow is clicked instead of firing a second IPC', async () => {
    const { setupMusicLyricsAi } = require(path.join(__dirname, '../Musicmodules/music-lyrics-ai.js'));
    let calls = 0;
    let resolveReq;
    const toasts = [];
    const origToast = globalThis.MusicToast;
    globalThis.MusicToast = { show: (o) => toasts.push(o) };
    try {
        const lines = [
            { time: 1, original: 'Morning coffee steam' },
            { time: 4, original: 'Quiet winter street' }
        ];
        const app = {
            playlist: [{ path: '/b.flac', title: 'Steam.flac', artist: 'B' }],
            currentTrackIndex: 0,
            currentLyrics: lines,
            lyricsRequestToken: 3,
            fetchAndDisplayLyrics: async () => {},
            renderLyrics() {},
            api: {
                translateMusicLyrics: () => {
                    calls += 1;
                    return new Promise((r) => { resolveReq = r; });
                }
            }
        };
        setupMusicLyricsAi(app, { storage: { getItem: () => '1', setItem() {} } });
        // 自动翻译先启动
        const autoP = app.fetchAndDisplayLyrics();
        await Promise.resolve();
        // 自动翻译进行中，用户手动点击翻译：复用同一请求并升级为手动提示
        const manualP = app.lyricsAi.translateNow();
        assert.equal(calls, 1, 'manual click during in-flight auto translation sends no duplicate IPC');
        resolveReq({ status: 'success', translations: ['晨间咖啡热气', '安静冬日街巷'] });
        await Promise.all([autoP, manualP]);
        assert.equal(app.currentLyrics[0].translation, '晨间咖啡热气');
        assert.ok(toasts.some((t) => t.message === '歌词翻译好了'), 'promoted in-flight request still emits manual completion toast');
    } finally {
        globalThis.MusicToast = origToast;
    }
});

test('long lyrics (>240 lines) pad translations to full length and apply first 240 translated lines instead of discarding', async () => {
    const { createLyricsTranslator } = require(path.join(__dirname, '../modules/musicLyricsTranslate.js'));
    const { setupMusicLyricsAi } = require(path.join(__dirname, '../Musicmodules/music-lyrics-ai.js'));
    const totalLines = 250;
    const lyrics = Array.from({ length: totalLines }, (_, i) => ({
        time: i + 1,
        original: `English lyric line number ${i + 1}`
    }));
    const translator = createLyricsTranslator({
        getSettings: async () => ({ vcpServerUrl: 'http://127.0.0.1:6005', vcpApiKey: 'k', musicLyricsTranslateModel: 'test-model' }),
        getCacheDir: () => null,
        fetchImpl: async () => ({
            ok: true,
            json: async () => ({
                choices: [{
                    message: {
                        content: JSON.stringify(Array.from({ length: 240 }, (_, i) => `第${i + 1}句译文`))
                    }
                }]
            })
        })
    });
    const translated = await translator.translate({ lines: lyrics.map((l) => l.original) });
    assert.equal(translated.status, 'success');
    assert.equal(translated.translations.length, totalLines, 'translator pads truncated MAX_LINES output to input length');
    assert.equal(translated.translations[0], '第1句译文');
    assert.equal(translated.translations[239], '第240句译文');
    assert.equal(translated.translations[240], '');

    const app = {
        playlist: [{ path: '/long.flac', title: 'Long.flac', artist: 'A' }],
        currentTrackIndex: 0,
        currentLyrics: lyrics,
        lyricsRequestToken: 9,
        fetchAndDisplayLyrics: async () => {},
        renderLyrics() {},
        api: { translateMusicLyrics: async () => translated }
    };
    setupMusicLyricsAi(app, { storage: { getItem: () => null, setItem() {} } });
    await app.lyricsAi.translateNow();
    assert.equal(app.currentLyrics[0].translation, '第1句译文');
    assert.equal(app.currentLyrics[239].translation, '第240句译文');
    assert.equal(app.currentLyrics[240].translation, undefined);
});

test('music-folders ignores stale overlapping list responses and cleans up on beforeunload', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    const { window } = dom;
    try {
        window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-folders.js'), 'utf8'));
        const resolvers = [];
        let cleared = 0;
        const origClearInterval = window.clearInterval.bind(window);
        window.clearInterval = (id) => { cleared += 1; return origClearInterval(id); };
        const app = {
            playlist: [{ path: 'C:\\Music\\A\\s1.flac' }, { path: 'C:\\Music\\B\\s2.flac' }],
            api: {
                addMusicFolder: async () => {},
                musicLibraryFolders: (payload) => {
                    if (payload.op === 'list') return new Promise((resolve) => resolvers.push(resolve));
                    return Promise.resolve({ ok: true });
                }
            }
        };
        window.MusicFolders.setupMusicFolders(app);
        app.openLibraryFolders();
        assert.equal(resolvers.length, 1);
        // 点击添加文件夹触发第二次 list 请求，制造乱序返回（第二次先回，第一次后回）
        const addBtn = [...window.document.querySelectorAll('button')].find((b) => b.textContent === '添加文件夹');
        addBtn.click();
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(resolvers.length, 2);
        resolvers[1]({ ok: true, folders: [{ path: 'C:\\Music\\B', exists: true }] });
        await new Promise((r) => setTimeout(r, 0));
        resolvers[0]({ ok: true, folders: [{ path: 'C:\\Music\\A', exists: true }] });
        await new Promise((r) => setTimeout(r, 0));
        const firstPath = window.document.querySelector('.mfold-path')?.textContent;
        assert.equal(firstPath, 'C:\\Music\\B', 'stale first list response does not overwrite newer list');
        window.dispatchEvent(new window.Event('beforeunload'));
        assert.ok(cleared >= 1, 'beforeunload clears folder watch timer');
    } finally {
        window.close();
    }
});

test('music-utils fast-paths stripAudioExtension/searchTracks and shows toast on shareCurrentTrack failure', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    const { window } = dom;
    try {
        const toasts = [];
        window.MusicToast = { show: (opts) => toasts.push(opts) };
        window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-utils.js'), 'utf8'));
        const app = {
            pendingTrackPath: 'C:\\a.flac',
            api: { shareMusicTrack: async () => { throw new Error('disk offline'); } }
        };
        window.setupUtils(app);
        assert.equal(app.stripAudioExtension('PlainTitle'), 'PlainTitle');
        assert.equal(app.stripAudioExtension('Song.FLAC'), 'Song');
        const tracks = [
            { title: 'Alpha.mp3', artist: 'Beta', album: 'Gamma' },
            { title: 'ＡＢＣ.flac', artist: '歌手', album: '专辑' }
        ];
        assert.equal(app.searchTracks(tracks, 'alpha beta').length, 1);
        assert.equal(app.searchTracks(tracks, 'abc').length, 1, 'NFKC full-width Latin still matches');
        await app.shareCurrentTrack();
        assert.equal(toasts.length, 1);
        assert.equal(toasts[0].kind, 'error');
    } finally {
        window.close();
    }
});

test('Batch 79: music-goto paint skips redundant display and title writes on repeated context menu opens', () => {
    const dom = new JSDOM('<!doctype html><body><div id="menu"><div data-action="toggle-like"></div></div></body>', { runScripts: 'outside-only' });
    const { window } = dom;
    try {
        const doc = window.document;
        const menu = doc.getElementById('menu');
        const app = {
            contextMenu: menu,
            contextMenuTrackIndex: 0,
            playlist: [
                { title: 'Song A', artist: 'Artist One', album: 'Album One' },
                { title: 'Song B', artist: 'Artist Two', album: '' }
            ],
            archiveView: { mode: 'archive', list: { goToGroup: () => true } },
            showContextMenu() {}
        };
        window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-app-hooks.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-goto.js'), 'utf8'));
        window.setupMusicGoto(app);

        const artistItem = menu.querySelector('[data-action="goto-artist"]');
        const albumItem = menu.querySelector('[data-action="goto-album"]');
        assert.ok(artistItem && albumItem);

        let titleWrites = 0;
        let displayWrites = 0;
        const titleDesc = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'title');
        const dispDesc = Object.getOwnPropertyDescriptor(window.CSSStyleDeclaration.prototype, 'display');
        Object.defineProperty(artistItem, 'title', {
            configurable: true,
            get() { return titleDesc.get.call(this); },
            set(v) { titleWrites += 1; return titleDesc.set.call(this, v); }
        });
        Object.defineProperty(albumItem.style, 'display', {
            configurable: true,
            get() { return dispDesc.get.call(this); },
            set(v) { displayWrites += 1; return dispDesc.set.call(this, v); }
        });

        app.showContextMenu();
        app.showContextMenu();
        app.showContextMenu();
        assert.equal(titleWrites, 1, 'repeated menu opens on same track write title once');
        assert.equal(displayWrites, 0, 'already-visible album item skips redundant empty display write');

        app.contextMenuTrackIndex = 1;
        app.showContextMenu();
        app.showContextMenu();
        assert.equal(titleWrites, 2, 'switching artist writes title once');
        assert.equal(displayWrites, 1, 'hiding missing album writes display="none" once');
    } finally {
        window.close();
    }
});
