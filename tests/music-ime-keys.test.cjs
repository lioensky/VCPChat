const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 中文输入法选词时按回车是把拼音上屏、按 Esc 是取消选词（keydown 带 isComposing）。
// 音乐窗口的文字框不能把这两下当成「确定」「关闭」：以前新建歌单打「通勤」，回车上屏时歌单就建成了「tongqin」。
const src = fs.readFileSync(path.join(__dirname, '../Musicmodules/music.js'), 'utf8');
const handler = (start) => {
    const at = src.indexOf(start);
    assert.ok(at >= 0, `missing ${start}`);
    return src.slice(at, src.indexOf('};', at));
};

for (const start of [
    'app.playlistNameInput.onkeydown =',
    'app.lyricsFetchTitle.onkeydown = app.lyricsFetchArtist.onkeydown =',
    'app.searchInput.onkeydown =',
]) {
    test(`${start.split('.onkeydown')[0]}: Enter while the IME is composing is not a confirm`, () => {
        assert.match(handler(start), /isComposing/);
    });
}

test('Esc that cancels an IME candidate does not close the lyrics search dialog', () => {
    const line = src.split('\n').find((l) => l.includes("e.key === 'Escape'") && l.includes('closeLyricsFetchModal'));
    assert.ok(line);
    assert.match(line, /isComposing/);
});

test('the playlist name box still confirms on a plain Enter and cancels on Esc', () => {
    const body = handler('app.playlistNameInput.onkeydown =').replace(/^app\.playlistNameInput\.onkeydown =/, '');
    const fn = new Function('app', `return ${body}};`);
    const calls = [];
    const app = { dialogConfirm: { click: () => calls.push('ok') }, dialogCancel: { click: () => calls.push('cancel') } };
    const onkeydown = fn(app);
    onkeydown({ key: 'Enter', isComposing: true });
    onkeydown({ key: 'Escape', isComposing: true });
    assert.deepEqual(calls, []);
    onkeydown({ key: 'Enter', isComposing: false });
    onkeydown({ key: 'Escape', isComposing: false });
    assert.deepEqual(calls, ['ok', 'cancel']);
});
