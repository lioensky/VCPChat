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

test('Batch 87: classic animateLyrics reuses cached _wbywBox.children without querySelectorAll across line switches and backward seeks', () => {
    const dom = new JSDOM('<!doctype html><body><div id="c"><ul id="lyrics-list"></ul></div></body>', { runScripts: 'outside-only' });
    const { window } = dom;
    try {
        const container = window.document.getElementById('c');
        const list = window.document.getElementById('lyrics-list');
        Object.defineProperty(container, 'clientWidth', { configurable: true, get: () => 400 });
        Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => 300 });
        const app = {
            lyricsContainer: container,
            lyricsList: list,
            isPlaying: true,
            isTrackLoading: false,
            lastKnownCurrentTime: 0,
            lastStateUpdateTime: Date.now(),
            currentLyricIndex: -1,
            currentLyrics: [
                { time: 1, endTime: 4, original: 'AB', isWordByWord: true, words: [{ text: 'A', startTime: 1, endTime: 2.5 }, { text: 'B', startTime: 2.5, endTime: 4 }] },
                { time: 5, endTime: 8, original: 'CD', isWordByWord: true, words: [{ text: 'C', startTime: 5, endTime: 6.5 }, { text: 'D', startTime: 6.5, endTime: 8 }] }
            ]
        };
        window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-lyrics.js'), 'utf8'));
        window.setupLyrics(app);
        app.renderLyrics();
        let qsaCalls = 0;
        for (const li of list.children) {
            const origQsa = li.querySelectorAll.bind(li);
            li.querySelectorAll = (...args) => { qsaCalls += 1; return origQsa(...args); };
        }
        app.lastKnownCurrentTime = 2;
        app.lastStateUpdateTime = Date.now();
        app.animateLyrics(true);
        app.lastKnownCurrentTime = 6;
        app.lastStateUpdateTime = Date.now();
        app.animateLyrics(true);
        assert.equal(qsaCalls, 0, 'forward line transition updates finished words via _wbywBox.children without querySelectorAll');
        assert.equal(list.children[0]._wbywBox.children[0].classList.contains('finished'), true);
        assert.equal(list.children[0]._wbywBox.children[1].classList.contains('finished'), true);

        app.lastKnownCurrentTime = 2;
        app.lastStateUpdateTime = Date.now();
        app.animateLyrics(true);
        assert.equal(qsaCalls, 0, 'backward seek resets pending words via _wbywBox.children without querySelectorAll');
        assert.equal(list.children[1]._wbywBox.children[0].classList.contains('finished'), false);
    } finally {
        window.close();
    }
});