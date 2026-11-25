const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
    return {
        children: [],
        dataset: {},
        classList: { add() {} },
        appendChild(child) { this.children.push(child); }
    };
}

function render(original, texts) {
    const words = texts.map((text, i) => ({ text, startTime: i, endTime: i + 1 }));
    const app = { currentLyrics: [{ original, words, isWordByWord: true }], lyricsList: element() };
    const source = fs.readFileSync(path.join(__dirname, '../Musicmodules/music-lyrics.js'), 'utf8');
    const context = vm.createContext({ document: { createElement: element, createDocumentFragment: element } });
    vm.runInContext(source, context);
    context.setupLyrics(app);
    app.renderLyrics();
    const [line] = app.lyricsList.children[0].children;
    const spans = line.children[0].children;
    assert.deepEqual(spans.map(span => span.dataset), words.map(({ startTime, endTime }, wordIndex) => ({
        wordIndex, start: startTime, end: endTime
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