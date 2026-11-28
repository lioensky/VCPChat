// 歌词目录里自己放的 .lrc：GBK、带 BOM 的 UTF-8、UTF-16（记事本「Unicode」）都要读成正确的文字。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function lyricHandler(dir) {
    const handlers = new Map();
    const electron = {
        ipcMain: { on() {}, handle: (n, fn) => handlers.set(n, fn), removeListener() {} },
        BrowserWindow: function () {}, app: { getPath: () => dir }, dialog: {}, shell: {}, nativeTheme: {}
    };
    const original = Module._load;
    Module._load = function (request, ...rest) { return request === 'electron' ? electron : original.call(this, request, ...rest); };
    try {
        const file = require.resolve('../modules/ipc/musicHandlers.js');
        delete require.cache[file];
        require(file).initialize({ mainWindow: null, openChildWindows: [], startAudioEngine() {}, stopAudioEngine() {}, APP_DATA_ROOT_IN_PROJECT: dir });
    } finally {
        Module._load = original;
    }
    return handlers.get('music-get-lyrics');
}

const LRC = '[00:01.00]你好世界\n[00:02.00]さよなら';
const gbk = Buffer.from([0x5b, 0x30, 0x30, 0x3a, 0x30, 0x31, 0x2e, 0x30, 0x30, 0x5d, 0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7]); // [00:01.00]你好世界

test('local .lrc files in GBK, UTF-8 with BOM and UTF-16 are decoded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-lrc-'));
    const lyric = path.join(dir, 'lyric');
    fs.mkdirSync(lyric);
    fs.writeFileSync(path.join(lyric, '甲 - gbk.lrc'), gbk);
    fs.writeFileSync(path.join(lyric, '甲 - bom.lrc'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(LRC)]));
    fs.writeFileSync(path.join(lyric, '甲 - u16.lrc'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(LRC, 'utf16le')]));
    fs.writeFileSync(path.join(lyric, '甲 - plain.lrc'), LRC);
    const get = lyricHandler(dir);
    assert.equal(await get({}, { artist: '甲', title: 'gbk' }), '[00:01.00]你好世界');
    assert.equal(await get({}, { artist: '甲', title: 'bom' }), LRC);
    assert.equal(await get({}, { artist: '甲', title: 'u16' }), LRC);
    assert.equal(await get({}, { artist: '甲', title: 'plain' }), LRC);
});

test('parserCore aligns translations with binary search, tie-breaks to first entry and respects 1.2s tolerance', () => {
    const { parseLRC, parseYRC, parseKRC, parseTTML } = require('../modules/lyrics/parserCore');
    const { stringSimilarity } = require('../modules/lyrics/matchScore');

    const trans = [
        '[00:01.00]第一条重复',
        '[00:01.00]第二条重复',
        '[00:04.00]左侧等距',
        '[00:06.00]右侧等距',
        '[00:10.00]刚好在容差内',
        '[00:20.00]超出容差'
    ].join('\n');

    const lrc = [
        '[00:01.00]第一句',
        '[00:05.00]中间句',
        '[00:11.19]容差内句',
        '[00:21.25]容差外句'
    ].join('\n');

    const parsed = parseLRC(lrc, trans);
    assert.equal(parsed.lines[0].translation, '第一条重复');
    assert.equal(parsed.lines[1].translation, '左侧等距');
    assert.equal(parsed.lines[2].translation, '刚好在容差内');
    assert.equal(parsed.lines[3].translation, undefined);

    const yrc = '[1000,2000](1000,1000,0)你(2000,1000,0)好\n[5000,2000](5000,2000,0)世界';
    const yrcParsed = parseYRC(yrc, trans);
    assert.equal(yrcParsed.lines[0].translation, '第一条重复');
    assert.equal(yrcParsed.lines[1].translation, '左侧等距');

    const krc = '[1000,2000]<0,1000,0>你<1000,1000,0>好\n[5000,2000]<0,2000,0>世界';
    const krcParsed = parseKRC(krc, trans);
    assert.equal(krcParsed.lines[0].translation, '第一条重复');
    assert.equal(krcParsed.lines[1].translation, '左侧等距');

    const ttml = '<tt><body><div><p begin="00:01.000" end="00:04.000"><span begin="00:01.000" end="00:02.000">Hello</span> <span begin="00:02.000" end="00:03.000">world</span><span ttm:role="x-bg"><span begin="00:03.000" end="00:04.000">oh</span></span><span ttm:role="x-translation">你好世界</span></p></div></body></tt>';
    const ttmlParsed = parseTTML(ttml);
    assert.equal(ttmlParsed.lines.length, 1);
    assert.equal(ttmlParsed.lines[0].fullText, 'Hello world (oh)');
    assert.equal(ttmlParsed.lines[0].translation, '你好世界');

    assert.equal(stringSimilarity('abc', 'abc'), 1);
    assert.equal(stringSimilarity('abc', 'abx'), 2 / 4);
    assert.equal(stringSimilarity('ab', 'abcd'), 0.5);
});

test('convertToLrcString clamps negative and NaN timestamps safely to [00:00.00]', () => {
    const { convertToLrcString } = require('../modules/lyrics/parserCore');
    const out = convertToLrcString({
        lines: [
            { startTime: -5.2, fullText: '负时间' },
            { startTime: NaN, fullText: '无效时间' },
            { startTime: 65.5, fullText: '正常时间', translation: 'Normal' }
        ]
    });
    assert.equal(out, '[00:00.00]负时间\n[00:00.00]无效时间\n[01:05.50]正常时间\n[01:05.50]Normal');
});

test('parseLRC expands multi-timestamp chorus lines, parses 1-digit minutes, and aligns multi-timestamp translations', () => {
    const { parseLRC } = require('../modules/lyrics/parserCore');
    const lrc = [
        '[0:05.50]开场',
        '[00:10.00][01:20.50]反复副歌',
        '[00:30.00]主歌'
    ].join('\n');
    const trans = '[00:10.00][01:20.50]Repeated Chorus\n[0:05.50]Opening';
    const parsed = parseLRC(lrc, trans);
    assert.deepEqual(
        parsed.lines.map((l) => [l.startTime, l.fullText, l.translation]),
        [
            [5.5, '开场', 'Opening'],
            [10, '反复副歌', 'Repeated Chorus'],
            [30, '主歌', undefined],
            [80.5, '反复副歌', 'Repeated Chorus']
        ]
    );
});

test('music-get-lyrics and music-fetch-lyrics handle missing payload safely without throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-lrc-empty-'));
    const handlers = new Map();
    const { registerMusicLyricsHandlers } = require('../modules/ipc/musicLyricsHandlers');
    registerMusicLyricsHandlers({
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
        lyricFetcher: { fetchAndSaveLyrics: async () => 'should-not-run' },
        getLyricDir: () => dir
    });
    assert.equal(await handlers.get('music-get-lyrics')({}, undefined), null);
    assert.equal(await handlers.get('music-fetch-lyrics')({}, undefined), null);
});
