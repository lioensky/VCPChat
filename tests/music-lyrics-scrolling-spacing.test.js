const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { JSDOM } = require('jsdom');

// 用 jsdom 跑真正的 renderLyrics：新版歌词行里还有间奏、翻译等节点，手写的假 DOM 跟不上。
function render(original, texts) {
    const words = texts.map((text, i) => ({ text, startTime: i, endTime: i + 1 }));
    const dom = new JSDOM('<!doctype html><ul id="lyrics-list"></ul>', { runScripts: 'outside-only' });
    const { window } = dom;
    const app = { currentLyrics: [{ original, words, isWordByWord: true }], lyricsList: window.document.getElementById('lyrics-list') };
    const source = fs.readFileSync(path.join(__dirname, '../Musicmodules/music-lyrics.js'), 'utf8');
    window.eval(source);
    window.setupLyrics(app);
    app.renderLyrics();
    const spans = [...app.lyricsList.querySelectorAll('.lyric-word')];
    assert.deepEqual(spans.map(span => ({ ...span.dataset })), words.map(({ startTime, endTime }, wordIndex) => ({
        wordIndex: String(wordIndex), start: String(startTime), end: String(endTime)
    })));
    assert.deepEqual(words.map(word => word.text), texts);
    return spans.map(span => span.textContent);
}

test('scrolling lyrics keep whitespace carried by timed tokens', () => {
    assert.deepEqual(render('Blocking my view', ['Blocking ', 'my', ' view']), ['Blocking ', 'my', ' view']);
});

test('scrolling lyrics restore source word boundaries without splitting syllables', () => {
    assert.deepEqual(render('Blocking my view', ['Block', 'ing', 'my', 'view']), ['Block', 'ing ', 'my ', 'view']);
    assert.deepEqual(render('挡住 my 视野', ['挡', '住', 'my', '视', '野']), ['挡', '住 ', 'my ', '视', '野']);
});

test('scrolling lyrics do not guess spaces for CJK or mismatched text', () => {
    assert.deepEqual(render('挡住视野', ['挡', '住', '视', '野']), ['挡', '住', '视', '野']);
    assert.deepEqual(render('Blocking my view!', ['Blocking', 'my', 'view']), ['Blocking', 'my', 'view']);
});