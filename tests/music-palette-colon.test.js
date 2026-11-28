// 命令面板的过滤写法：「歌手:名字」和 --歌手 名字 一样
const test = require('node:test');
const assert = require('node:assert');
global.window = global;
require('../Musicmodules/music-dock/music-dock-palette.js');
const { parseQuery } = global.MusicDockPaletteQuery;

test('冒号写法（中英文冒号、冒号后空一格）', () => {
    assert.strictEqual(parseQuery('歌手:周杰伦').artist, '周杰伦');
    const q = parseQuery('夜 专辑： 叶惠美');
    assert.strictEqual(q.text, '夜');
    assert.strictEqual(q.album, '叶惠美');
    assert.strictEqual(parseQuery('artist:Aki').artist, 'Aki');
    // 不是过滤名的冒号照常当检索词
    assert.strictEqual(parseQuery('Re:Zero').text, 'Re:Zero');
    // 旧写法照旧
    assert.strictEqual(parseQuery('--歌手 远舟').artist, '远舟');
    // 大小写混合的 --Artist / --Album / --Title 不应误判为未完成过滤符
    assert.strictEqual(parseQuery('--Artist').pendingFlag, null);
    assert.strictEqual(parseQuery('--Album').pendingFlag, null);
    assert.strictEqual(parseQuery('--Title').pendingFlag, null);
    assert.strictEqual(parseQuery('--Art').pendingFlag, 'Art');
});
