// 引擎的英文报错要换成看得懂、能照着做的中文；认不出的原样保留。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync('Musicmodules/music-player.js', 'utf8'), context);
const describe = (raw) => context.describeEngineError(raw);

test('common engine errors read as plain Chinese', () => {
    const cases = [
        ['File not found or inaccessible: D:\\Music\\a.flac', /不在原来的位置/],
        ['Failed to open file: 系统找不到指定的路径。 (os error 3)', /不在原来的位置/],
        ['Failed to open file: Access is denied. (os error 5)', /没有权限/],
        ["URL host '192.168.1.20' is not allowed (private/internal address)", /内网/],
        ['HTTP error: Server returned 401 Unauthorized (expected 206 Partial Content)', /账号或密码/],
        ['HTTP error: Server returned 404 Not Found (expected 206 Partial Content)', /找不到这首歌/],
        ['HTTP error: error sending request for url (http://nas/a.flac): operation timed out', /连不上服务器/],
        ['Unsupported format', /不支持/],
        ['Probe error: unsupported feature: core (probe): no suitable format reader found', /不支持/],
        ['Decoded track is empty', /没有可播放的声音/],
        ['Decoder error: malformed stream: invalid sync word', /损坏/],
    ];
    for (const [raw, expected] of cases) {
        const text = describe(raw);
        assert.match(text, expected, raw);
        assert.doesNotMatch(text.replace(/WebDAV/g, ''), /[A-Za-z]{4,}/, `still English: ${text}`);
    }
});

test('an error it does not know is shown as is', () => {
    assert.equal(describe('文件不存在'), '文件不存在');
    assert.equal(describe('something new'), 'something new');
});

test('the failure notice uses the plain text', () => {
    const src = fs.readFileSync('Musicmodules/music-player.js', 'utf8');
    assert.match(src, /describeEngineError\(raw\.slice\(5\)\)/);
});

test('an engine that has exited, and the main process\'s own messages, read as plain Chinese too', () => {
    assert.match(describe('fetch failed'), /连不上音频引擎/);
    assert.match(describe('No song loaded to play.'), /还没有加载歌曲/);
    assert.equal(describe('音频引擎 8 秒内没有响应（/play）'), '音频引擎 8 秒内没有响应', 'the endpoint path is not shown');
    assert.match(describe('HTTP error: error sending request for url (http://nas/a.flac): connection refused'), /连不上服务器/, 'a NAS that refuses is still the server, not the engine');
});

test('a failed play or pause shows the plain reason, not the raw message', () => {
    const src = fs.readFileSync('Musicmodules/music-player.js', 'utf8');
    assert.doesNotMatch(src, /showPlaybackNotice\(`(播放|暂停)失败：\$\{result\?\.message \|\|/);
    assert.match(src, /播放失败：\$\{result\?\.message \? describeEngineError\(result\.message\)/);
});
