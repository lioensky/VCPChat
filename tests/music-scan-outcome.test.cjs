// 扫描结束时底部提示要说实话：扫描失败时以前也说「扫描完成，没有找到音乐文件」，像是文件夹空了；
// 有文件读不出来也一声不吭地少了几首。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function dockWithScan() {
    const dom = new JSDOM(`<!doctype html><body><div class="main-content"><div class="settings-container" id="dsp"></div></div>
        <div class="track-title"></div><div class="track-artist"></div><div class="album-art"></div>
        <span class="current-time">0:00</span><span class="duration">0:00</span><button id="mode-btn"></button>
        <input id="volume-slider" type="range" min="0" max="1" step="0.01" value="0.5"><ul id="playlist"></ul>
        <div id="music-dock-root"></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const { window } = dom;
    window.MusicStageConfig = { modes: [] };
    const shown = [];
    window.MusicToast = { show: (o) => { shown.push(o); return {}; }, dismiss() {} };
    window.eval(read('Musicmodules/music-error-text.js'));
    window.eval(read('Musicmodules/music-app-hooks.js'));
    for (const f of ['music-dock-icons.js', 'music-dock-palette.js', 'music-dock-fluid.js', 'music-dock-queue.js', 'music-dock-stage-settings.js', 'music-dock.js']) window.eval(read('Musicmodules/music-dock/' + f));
    let complete = null;
    const app = {
        playlist: [], currentTrackIndex: 0, isPlaying: false, playModes: ['repeat'], currentPlayMode: 0,
        volumeSlider: window.document.getElementById('volume-slider'),
        api: { onMusicScanStart() {}, onMusicScanProgress() {}, onMusicScanComplete: (fn) => { complete = fn; } }
    };
    window.initMusicDock(app);
    return { shown, complete: (data) => complete(data) };
}

test('a scan that failed says so and that the library was left alone', () => {
    const { shown, complete } = dockWithScan();
    complete({ tracks: [], folderPath: 'D:/Music', failed: true, error: 'EACCES: permission denied, scandir' });
    const last = shown[shown.length - 1];
    assert.equal(last.kind, 'error');
    assert.match(last.message, /扫描没有完成（没有权限读写这个文件）/);
    assert.match(last.message, /曲库保持原样/);
    assert.doesNotMatch(last.message, /没有找到音乐文件/);
});

test('files that could not be read are counted in the message', () => {
    const { shown, complete } = dockWithScan();
    complete({ tracks: [{ path: 'a' }, { path: 'b' }], folderPath: 'D:/Music', stats: { total: 5, failed: 3 } });
    assert.match(shown[shown.length - 1].message, /有 2 首，另有 3 个文件读不出来/);
});

test('an ordinary scan reads as before', () => {
    const { shown, complete } = dockWithScan();
    complete({ tracks: [{ path: 'a' }], folderPath: 'D:/Music' });
    assert.equal(shown[shown.length - 1].message, '扫描完成，这个文件夹里有 1 首');
    complete({ tracks: [], folderPath: 'D:/Music', stats: { total: 0, failed: 0 } });
    assert.equal(shown[shown.length - 1].message, '扫描完成，没有找到音乐文件');
});

test('the main process sends the failure reason and the unread count', () => {
    const handlers = read('modules/ipc/musicHandlers.js');
    assert.match(handlers, /failed: true, error: err\?\.message/);
    assert.match(handlers, /stats: \{ total: scanned\.stats\.total, failed: scanned\.stats\.failed \}/);
});
