// 同时在扫两个文件夹（连着拖进来、或扫描途中又加了一个）：先扫完的那个以前就把「正在扫描」藏掉了，
// 另一个还在读，界面却像已经扫完。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '../Musicmodules/music.js'), 'utf8');
const start = src.indexOf('    const setupElectronHandlers = () => {');
const end = src.indexOf('\n    };\n', start);
assert.ok(start > 0 && end > start, 'setupElectronHandlers not found in music.js');

test('the scanning indicator stays up until every running scan has finished', () => {
    const fns = {};
    const style = () => ({ display: '' });
    const app = {
        playlist: [], currentTrackIndex: 0, currentSidebarView: 'all',
        loadingIndicator: { style: style() }, scanProgressContainer: { style: style() },
        scanProgressBar: { style: style() }, scanProgressLabel: {},
        normalizePathForCompare: (p) => String(p || '').replace(/\\/g, '/').toLowerCase(),
        renderPlaylist() {}, renderSidebarContent() {}, saveLibrary() {}, applyTheme() {},
        api: {
            onMusicScanStart: (fn) => { fns.start = fn; }, onMusicScanProgress: (fn) => { fns.progress = fn; },
            onMusicScanComplete: (fn) => { fns.complete = fn; }, onMusicScanBatch: (fn) => { fns.batch = fn; },
            onMusicControl() {}, onMusicSetTrack() {}
        }
    };
    const context = vm.createContext({ app, console, setTimeout, clearTimeout });
    vm.runInContext(`${src.slice(start, end + 7)}\nsetupElectronHandlers();`, context);
    fns.start({ total: 3, folderPath: 'D:/A' });
    fns.start({ total: 5, folderPath: 'D:/B' });
    assert.equal(app.loadingIndicator.style.display, 'flex');
    fns.complete({ tracks: [{ path: 'D:/A/1.mp3' }], folderPath: 'D:/A' });
    assert.equal(app.loadingIndicator.style.display, 'flex', 'D:/B is still being scanned');
    fns.complete({ tracks: [{ path: 'D:/B/1.mp3' }], folderPath: 'D:/B' });
    assert.equal(app.loadingIndicator.style.display, 'none');
    // 没有 start 的 complete（扫描一开始就失败）不会把计数弄成负数
    fns.complete({ tracks: [], folderPath: 'D:/C', failed: true });
    fns.start({ total: 1, folderPath: 'D:/D' });
    fns.complete({ tracks: [], folderPath: 'D:/D' });
    assert.equal(app.loadingIndicator.style.display, 'none');
});
