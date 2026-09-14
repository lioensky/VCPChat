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