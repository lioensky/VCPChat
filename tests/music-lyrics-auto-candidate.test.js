const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'Musicmodules', 'music-lyrics.js'),
    'utf8'
);

test('automatic lyric loading reuses the manual 90-point candidate pipeline', async () => {
    const calls = {
        cache: [],
        search: [],
        apply: [],
        render: 0
    };
    const lyricsList = { innerHTML: '', style: {} };
    const context = vm.createContext({
        console,
        setTimeout,
        clearTimeout,
        document: {
            createDocumentFragment() {
                return { appendChild() {} };
            },
            createElement() {
                return {
                    appendChild() {},
                    classList: { add() {}, remove() {} },
                    dataset: {},
                    style: {}
                };
            }
        }
    });
    vm.runInContext(source, context, { filename: 'Musicmodules/music-lyrics.js' });

    const returnedLyrics = {
        isWordByWord: true,
        lines: [{
            startTime: 0,
            endTime: 2,
            fullText: '自动歌词',
            translation: '',
            romanization: '',
            words: [{ text: '自动歌词', startTime: 0, endTime: 2 }]
        }]
    };
    const app = {
        lyricsRequestToken: 0,
        currentLyrics: [],
        currentLyricIndex: -1,
        lyricSpeedFactor: 1,
        lyricOffset: 0,
        lyricsList,
        lyricsContainer: null,
        lastKnownDuration: 180,
        stripAudioExtension(value) {
            return String(value).replace(/\.[^.]+$/, '');
        },
        api: {
            async getMusicLyrics(options) {
                calls.cache.push(options);
                return null;
            },
            async searchMusicLyricsCandidates(options) {
                calls.search.push(options);
                return {
                    success: true,
                    candidates: [{
                        candidateKey: 'candidate-90',
                        source: 'qq',
                        sourceLabel: 'QQ 音乐',
                        matchScore: 90,
                        isWordByWord: true
                    }]
                };
            },
            async applyMusicLyricsCandidate(options) {
                calls.apply.push(options);
                return {
                    success: true,
                    lyrics: returnedLyrics
                };
            }
        }
    };

    context.setupLyrics(app);
    app.renderLyrics = () => {
        calls.render += 1;
    };

    await app.fetchAndDisplayLyrics('测试歌手', '测试歌曲.FLAC', {
        duration: 180,
        album: '测试专辑'
    });

    assert.equal(calls.search.length, 1);
    assert.deepEqual(
        JSON.parse(JSON.stringify(calls.search[0])),
        {
            artist: '测试歌手',
            title: '测试歌曲',
            durationMs: 180000,
            album: '测试专辑'
        }
    );
    assert.equal(calls.apply.length, 1);
    assert.deepEqual(
        JSON.parse(JSON.stringify(calls.apply[0])),
        {
            candidateKey: 'candidate-90',
            artist: '测试歌手',
            title: '测试歌曲'
        }
    );
    assert.strictEqual(app.currentLyricsData, returnedLyrics);
    assert.equal(app.currentLyrics.length, 1);
    assert.equal(app.currentLyrics[0].original, '自动歌词');
    assert.equal(app.currentLyrics[0].isWordByWord, true);
    assert.equal(calls.render, 1);
});

test('automatic lyric loading does not use the legacy one-shot endpoint when candidate APIs exist', async () => {
    let legacyCalls = 0;
    const context = vm.createContext({
        console,
        setTimeout,
        clearTimeout,
        document: {}
    });
    vm.runInContext(source, context, { filename: 'Musicmodules/music-lyrics.js' });

    const app = {
        lyricsRequestToken: 0,
        currentLyrics: [],
        lyricsList: { innerHTML: '', style: {} },
        lyricsContainer: null,
        lastKnownDuration: 0,
        lyricSpeedFactor: 1,
        lyricOffset: 0,
        stripAudioExtension: value => value,
        api: {
            getMusicLyrics: async () => null,
            searchMusicLyricsCandidates: async () => ({ success: true, candidates: [] }),
            applyMusicLyricsCandidate: async () => ({ success: false }),
            fetchMusicLyrics: async () => {
                legacyCalls += 1;
                return null;
            }
        }
    };

    context.setupLyrics(app);
    await app.fetchAndDisplayLyrics('', '无候选歌曲');

    assert.equal(legacyCalls, 0);
    assert.match(app.lyricsList.innerHTML, /暂无歌词/);
});
test('a lyric search that failed (offline) is not remembered as "no lyrics"', async () => {
    const context = vm.createContext({ console: { log() {}, error() {}, warn() {} }, setTimeout, clearTimeout, document: {} });
    vm.runInContext(source, context, { filename: 'Musicmodules/music-lyrics.js' });
    let online = false;
    let searches = 0;
    const app = {
        lyricsRequestToken: 0, currentLyrics: [], lyricsList: { innerHTML: '', style: {} }, lyricsContainer: null,
        lyricSpeedFactor: 1, lyricOffset: 0, lastKnownDuration: 180,
        stripAudioExtension: (v) => String(v).replace(/\.[^.]+$/, ''),
        api: {
            async getMusicLyrics() { return null; },
            async searchMusicLyricsCandidates() {
                searches += 1;
                return online
                    ? { success: true, candidates: [{ candidateKey: 'k', matchScore: 95 }] }
                    : { success: false, message: 'getaddrinfo ENOTFOUND', candidates: [] };
            },
            async applyMusicLyricsCandidate() {
                return { success: true, lyrics: { lines: [{ startTime: 0, endTime: 1, fullText: '回来了', words: [] }] } };
            }
        }
    };
    context.setupLyrics(app);
    app.renderLyrics = () => {};
    await app.fetchAndDisplayLyrics('歌手', '歌.flac', { duration: 180 });
    assert.match(app.lyricsList.innerHTML, /获取失败/);
    online = true;
    await app.fetchAndDisplayLyrics('歌手', '歌.flac', { duration: 180 });
    assert.equal(searches, 2, 'searched again once the network is back');
    assert.equal(app.currentLyrics[0]?.original, '回来了');
});

test('manual lyrics translation with force=true bypasses failure cooldown while auto translation still respects it', async () => {
    const { createLyricsTranslator } = require('../modules/musicLyricsTranslate');
    let attempts = 0;
    let clock = 1000;
    const translator = createLyricsTranslator({
        getSettings: async () => ({ vcpServerUrl: 'http://127.0.0.1:6005/v1/chatvcp/completions', topicSummaryModel: 'test-model' }),
        getCacheDir: () => null,
        now: () => clock,
        fetchImpl: async () => {
            attempts += 1;
            if (attempts === 1) return { ok: false, status: 503 };
            return {
                ok: true,
                status: 200,
                json: async () => ({ choices: [{ message: { content: '["你好世界"]' } }] })
            };
        }
    });
    const first = await translator.translate({ lines: ['Hello world'], title: 'T', artist: 'A' });
    assert.equal(first.status, 'error');
    assert.equal(attempts, 1);

    clock += 1000;
    const autoRetry = await translator.translate({ lines: ['Hello world'], title: 'T', artist: 'A', force: false });
    assert.equal(autoRetry.status, 'error');
    assert.match(autoRetry.message, /稍后再试/);
    assert.equal(attempts, 1, 'auto translate respects cooldown');

    const manualRetry = await translator.translate({ lines: ['Hello world'], title: 'T', artist: 'A', force: true });
    assert.equal(manualRetry.status, 'success');
    assert.deepEqual(manualRetry.translations, ['你好世界']);
    assert.equal(attempts, 2, 'manual force=true bypasses cooldown');
});

test('Batch 74: lyricFetcher getBestMatch scores 1-character artist names accurately (matchDistance >= 0)', () => {
    const fetcherSrc = fs.readFileSync(path.join(__dirname, '..', 'modules', 'lyricFetcher.js'), 'utf8');
    const fnStart = fetcherSrc.indexOf('function getBestMatch(');
    const fnEnd = fetcherSrc.indexOf('async function fetchAndSaveLyrics(');
    assert.ok(fnStart >= 0 && fnEnd > fnStart);
    const ctx = vm.createContext({});
    vm.runInContext(fetcherSrc.slice(fnStart, fnEnd), ctx);
    const picked = ctx.getBestMatch([
        { id: 1, artists: [{ name: 'B' }] },
        { id: 2, artists: [{ name: 'A' }] }
    ], 'A');
    assert.equal(picked?.id, 2, 'exact 1-char artist match outscores non-matching 1-char candidate');
});

test('Batch 87: musicLyricsTranslate caches ensureDir per cache directory across saves', async () => {
    const os = require('node:os');
    const fsExtra = require('fs-extra');
    const { createLyricsTranslator } = require('../modules/musicLyricsTranslate');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltrans-b87-'));
    const cacheDir = path.join(tmpDir, 'translations');
    const origEnsureDir = fsExtra.ensureDir;
    let ensureCalls = 0;
    fsExtra.ensureDir = async (dir, ...args) => {
        if (String(dir).startsWith(tmpDir)) ensureCalls += 1;
        return origEnsureDir.call(fsExtra, dir, ...args);
    };
    try {
        const translator = createLyricsTranslator({
            getSettings: async () => ({ vcpServerUrl: 'http://127.0.0.1:6005/v1/chatvcp/completions', topicSummaryModel: 'm' }),
            getCacheDir: () => cacheDir,
            fetchImpl: async () => ({
                ok: true,
                status: 200,
                json: async () => ({ choices: [{ message: { content: '["译文"]' } }] })
            })
        });
        const r1 = await translator.translate({ lines: ['Song 1 line'], title: 'S1', artist: 'A1' });
        const r2 = await translator.translate({ lines: ['Song 2 line'], title: 'S2', artist: 'A2' });
        assert.equal(r1.status, 'success');
        assert.equal(r2.status, 'success');
        assert.equal(ensureCalls, 1, 'ensureDir runs once per cache directory across multiple translation saves');
    } finally {
        fsExtra.ensureDir = origEnsureDir;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
