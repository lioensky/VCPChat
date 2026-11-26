const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// 歌词解析：空时间戳行算「这句到这里结束」；间奏判断；当前句二分查找。
function setup() {
    const context = vm.createContext({ console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, window: {}, document: {} });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-lyrics.js'), 'utf8'), context);
    const app = { lyricSpeedFactor: 1, lyricOffset: 0, api: {}, currentLyrics: [] };
    context.setupLyrics(app);
    return app;
}

const LRC = [
    '[ar:Someone]',
    '[00:08.00]第一句',
    '[00:11.50]第二句',
    '[00:14.00]',
    '[00:30.00]第三句',
    '[00:33.0]第四句',
    '[00:40.00][00:50.00]重复句',
    '[01:02]第五句（无毫秒）'
].join('\n');

test('blank timestamps end the previous line; multiple stamps and stamps without ms parse', () => {
    const app = setup();
    const lines = app.parseLrc(LRC);
    assert.deepEqual(Array.from(lines, (l) => l.original), ['第一句', '第二句', '第三句', '第四句', '重复句', '重复句', '第五句（无毫秒）']);
    assert.equal(lines[1].endTime, 14);
    assert.equal(lines[0].endTime, 11.5);
    assert.equal(lines[6].time, 62);
});

test('interlude only for gaps of 5 seconds or more, including the intro', () => {
    const app = setup();
    app.currentLyrics = app.parseLrc(LRC);
    const intro = app.lyricInterlude(4);
    assert.equal(intro.index, 0);
    assert.equal(intro.start, 0);
    assert.ok(Math.abs(intro.progress - 0.5) < 1e-9);
    assert.equal(app.lyricInterlude(9), null);           // 在唱第一句
    assert.equal(app.lyricInterlude(13), null);          // 第二句还没结束
    const mid = app.lyricInterlude(22);                  // 14 → 30 的间奏
    assert.equal(mid.index, 2);
    assert.equal(mid.start, 14);
    assert.equal(mid.end, 30);
    assert.equal(app.lyricInterlude(36), null);          // 33 → 40 只有 7 秒但第四句延续到 40：没有空白
});

test('lyricIndexAt is a binary search matching the old linear scan', () => {
    const app = setup();
    const lines = app.parseLrc(LRC);
    for (let t = -1; t < 70; t += 0.25) {
        let linear = -1;
        for (let i = 0; i < lines.length && t >= lines[i].time; i++) linear = i;
        assert.equal(app.lyricIndexAt(t, lines), linear, `t=${t}`);
    }
});

test('two lines in the same script close together stay two lines; a translation is still paired', () => {
    const app = setup();
    const lines = app.parseLrc([
        '[00:10.00]我们走吧',
        '[00:10.60]不要回头',
        '[00:20.00]君の名は',
        '[00:20.30]你的名字',
        '[00:30.00]Hello there',
        '[00:30.00]你好',
        '[00:40.00]run run',
        '[00:40.50]run again'
    ].join('\n'));
    assert.deepEqual(Array.from(lines, (l) => [l.original, l.translation]), [
        ['我们走吧', ''], ['不要回头', ''],
        ['君の名は', '你的名字'],
        ['Hello there', '你好'],
        ['run run', ''], ['run again', '']
    ]);
});

test('the [offset:] tag shifts every timestamp, positive means earlier', () => {
    const app = setup();
    const lines = app.parseLrc('[offset:+500]\n[00:10.00]一\n[00:20.00]二');
    assert.deepEqual(Array.from(lines, (l) => l.time), [9.5, 19.5]);
    const later = app.parseLrc('[offset:-1000]\n[00:10.00]一');
    assert.equal(later[0].time, 11);
});
