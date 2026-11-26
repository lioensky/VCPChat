// 经典列表的表头（标题／歌手／时长排序钮）和每一行要用同一套列，表头只在最前面多一格行号。
// 以前行里有一格 22px 的「喜欢」、表头没有，表头的标题、歌手两栏比行里宽，「歌手」落在歌手名右边 22px。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const css = fs.readFileSync('Musicmodules/music-theme/music-skin.css', 'utf8');
const rule = (selector) => {
    const at = css.indexOf(selector + ' {');
    assert.ok(at >= 0, selector);
    return css.slice(at, css.indexOf('}', at));
};
const columns = (block) => block.match(/grid-template-columns:\s*([^;]+);/)[1].trim().split(/\s+(?![^(]*\))/);

test('the header has the row columns plus the leading number column', () => {
    const head = columns(rule('.music-list-head'));
    const row = columns(rule('.sidebar-playlist li[data-cols="1"]'));
    assert.equal(head[0], '24px');
    assert.deepEqual(head.slice(1), row);
});

test('the duration sort button sits in the last column, over the durations', () => {
    const head = columns(rule('.music-list-head'));
    const m = css.match(/\.music-list-sort\.is-duration\s*\{[^}]*grid-column:\s*(\d+)/);
    assert.equal(Number(m[1]), head.length);
});
