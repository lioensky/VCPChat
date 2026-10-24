const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { formatCurrentLyrics } = require('../modules/lyrics/lyricsMarkdown');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('歌词指令不需要歌名，原点歌与演出参数保持兼容', () => {
    const invoke = args => {
        const result = spawnSync(process.execPath, [
            path.join(root, 'VCPDistributedServer/Plugin/MusicController/music-controller.js')
        ], { input: JSON.stringify(args), encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
    };
    for (const command of ['getCurrentLyrics', 'getLyrics', 'get_current_lyrics']) {
        assert.deepEqual(invoke({ command }), { command: 'getCurrentLyrics' });
    }
    assert.deepEqual(invoke({ songname: '歌曲', stageMode: '星诞' }), {
        command: 'play', target: '歌曲', stageMode: 'starborn'
    });
    const manifest = JSON.parse(read('VCPDistributedServer/Plugin/MusicController/plugin-manifest.json'));
    assert.ok(manifest.capabilities.invocationCommands.some(item => item.command === 'getCurrentLyrics'));
});

test('Markdown 保留多语言正文，忽略计时数据，明确提示无歌词', () => {
    assert.match(formatCurrentLyrics(null), /未加载歌曲，没有歌词/);
    assert.match(formatCurrentLyrics({ track: { title: '歌曲' }, lines: [] }), /当前歌曲暂无歌词/);
    const text = formatCurrentLyrics({
        track: { title: '# 歌曲', artist: '歌手', album: '专辑' },
        lines: [{ original: '原文', translation: '翻译', romanization: 'roma', words: [{ secret: true }] }]
    });
    assert.match(text, /### 当前歌词/);
    assert.match(text, /原文  \n/);
    assert.match(text, /译文.*翻译/);
    assert.match(text, /罗马音.*roma/);
    assert.ok(!text.includes('secret'));
    assert.ok(text.includes('\\# 歌曲'));
    assert.ok(formatCurrentLyrics({
        track: { title: '<script>' }, lines: []
    }).includes('<script>'));
});

function rendererHarness() {
    let listener;
    const sent = [];
    const app = {
        api: {
            onMusicCurrentLyricsRequest(callback) { listener = callback; return () => {}; },
            sendMusicCurrentLyricsResponse(payload) { sent.push(payload); }
        },
        stripAudioExtension: value => value.replace(/\.flac$/, ''),
        pendingTrackPath: '/b',
        playlist: [
            { path: '/a', title: '旧歌曲' },
            { path: '/b', title: '当前歌曲.flac', artist: '歌手', password: 'secret' }
        ],
        currentTrackIndex: 0,
        currentLyrics: [{ original: '原文', translation: '译文', romanization: 'roma', words: [] }]
    };
    const context = { app };
    vm.runInNewContext(read('Musicmodules/music-lyrics.js') + '\nsetupLyrics(app);', context);
    return { app, sent, query: () => listener({ requestId: 'request' }) };
}

test('渲染端按当前路径读取，暂停可读，不泄露音源路径及凭据', () => {
    const harness = rendererHarness();
    harness.query();
    const snapshot = harness.sent[0].snapshot;
    assert.equal(snapshot.track.title, '当前歌曲');
    assert.equal(snapshot.lines[0].original, '原文');
    assert.ok(!JSON.stringify(snapshot).includes('secret'));
    assert.equal(snapshot.track.path, undefined);
    harness.app.currentLyrics = [];
    harness.query();
    assert.equal(harness.sent[1].snapshot.lines.length, 0);
    harness.app.pendingTrackPath = null;
    harness.query();
    assert.equal(harness.sent[2].snapshot.track, null);
});

function mainHarness() {
    const ipcMain = new EventEmitter();
    const win = new EventEmitter();
    win.isDestroyed = () => false;
    win.webContents = { send() {} };
    const context = {
        module: { exports: {} }, console, setTimeout, clearTimeout,
        __dirname: path.join(root, 'modules/ipc'),
        require(name) {
            if (name === 'electron') return { ipcMain };
            if (name === '../lyrics/lyricsMarkdown') return { formatCurrentLyrics };
            if (['path', 'crypto', 'worker_threads'].includes(name)) return require(name);
            return {};
        }
    };
    vm.createContext(context);
    vm.runInContext(read('modules/ipc/musicHandlers.js'), context);
    return {
        ipcMain, win,
        control: context.module.exports.handleMusicControl,
        attach() { context.testWindow = win; vm.runInContext('musicWindow = testWindow;', context); }
    };
}

test('主进程无窗口返回标准 text；并发请求校验发送者与请求标识并清理监听', async () => {
    const harness = mainHarness();
    const empty = await harness.control({ command: 'getCurrentLyrics' });
    assert.equal(empty.status, 'success');
    assert.equal(empty.result.content[0].type, 'text');
    assert.match(empty.result.content[0].text, /没有歌词/);
    harness.attach();
    const requests = [];
    harness.win.webContents.send = (channel, payload) => requests.push(payload);
    const first = harness.control({ command: 'getCurrentLyrics' });
    const second = harness.control({ command: 'getCurrentLyrics' });
    const respond = (request, title, sender = harness.win.webContents) => {
        harness.ipcMain.emit('music-current-lyrics-response', { sender }, {
            requestId: request.requestId,
            snapshot: { track: { title }, lines: [{ original: title }] }
        });
    };
    respond(requests[0], '伪造', {});
    respond(requests[1], '第二首');
    respond(requests[0], '第一首');
    assert.match((await first).result.content[0].text, /第一首/);
    assert.match((await second).result.content[0].text, /第二首/);
    assert.equal(harness.ipcMain.listenerCount('music-current-lyrics-response'), 0);
    assert.equal(harness.win.listenerCount('closed'), 0);
    const closing = harness.control({ command: 'getCurrentLyrics' });
    harness.win.emit('closed');
    assert.match((await closing).result.content[0].text, /没有歌词/);
    assert.equal(harness.ipcMain.listenerCount('music-current-lyrics-response'), 0);
});

test('分布式服务透传歌词标准 content，不替换为执行成功提示', async () => {
    const lyrics = { content: [{ type: 'text', text: '### 当前歌词\n\n测试正文' }] };
    const context = {
        module: { exports: {} }, console,
        __dirname: path.join(root, 'VCPDistributedServer'),
        require(name) {
            if (name === 'path') return path;
            if (name === './Plugin.js') return {
                processToolCall: async () => JSON.stringify({ command: 'getCurrentLyrics' })
            };
            return {};
        }
    };
    vm.runInNewContext(read('VCPDistributedServer/VCPDistributedServer.js'), context);
    let response;
    await context.module.exports.prototype.handleToolExecutionRequest.call({
        handleMusicControl: async () => ({ status: 'success', result: lyrics }),
        sendMessage: payload => { response = payload; }
    }, { requestId: 'test', toolName: 'MusicController', toolArgs: {} });
    assert.equal(response.data.status, 'success');
    assert.equal(response.data.result, lyrics);
});