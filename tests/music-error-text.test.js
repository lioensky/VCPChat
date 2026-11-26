// 出错信息整理成给人看的一句话
const { test } = require('node:test');
const assert = require('node:assert/strict');
const errorText = require('../Musicmodules/music-error-text.js');

test('strips the remote-method prefix and keeps a Chinese explanation', () => {
    const err = new Error("Error invoking remote method 'music-lyrics-search': Error: 没有找到这首歌的歌词");
    assert.equal(errorText(err, '歌词搜索失败'), '没有找到这首歌的歌词');
});

test('maps common network errors to Chinese after the fallback', () => {
    assert.equal(errorText(new Error("Error invoking remote method 'x': Error: connect ECONNREFUSED 127.0.0.1:443"), '歌词搜索失败'), '歌词搜索失败：连不上服务');
    assert.equal(errorText('TypeError: fetch failed', '歌词搜索失败'), '歌词搜索失败：网络连接出错');
    assert.equal(errorText('ENOENT: no such file or directory', '加载失败'), '加载失败：找不到这个文件');
});

test('hides English-only technical messages behind the fallback', () => {
    assert.equal(errorText(new TypeError("Cannot read properties of undefined (reading 'x')"), '覆盖歌词失败'), '覆盖歌词失败');
    assert.equal(errorText(undefined, '加载失败'), '加载失败');
    assert.equal(errorText('', '加载失败'), '加载失败');
});
