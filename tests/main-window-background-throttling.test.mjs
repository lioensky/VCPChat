import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 主进程不得再用全局 Chromium 开关关闭后台节流 / 挂起监视器。隐藏页面里的流式推进由
// streamManager 自己负责（见 tests/stream-hidden-document-frames.test.mjs）。

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');

test('main.js does not disable background throttling or the hang monitor for the whole app', () => {
    for (const flag of [
        'disable-hang-monitor',
        'disable-background-timer-throttling',
        'disable-renderer-backgrounding',
        'disable-backgrounding-occluded-windows',
    ]) {
        assert.doesNotMatch(mainSource, new RegExp(`appendSwitch\\(\\s*['"]${flag}['"]`), `${flag} must not be switched on globally`);
    }
});

test('the main chat window keeps the default background throttling', () => {
    const start = mainSource.indexOf('function createWindow');
    assert.ok(start >= 0, 'createWindow must exist');
    const end = mainSource.indexOf('browserHandlers.attachToWindow(mainWindow)', start);
    assert.ok(end > start, 'the main window construction block must be followed by browserHandlers.attachToWindow');
    const block = mainSource.slice(start, end);
    assert.doesNotMatch(block, /backgroundThrottling\s*:\s*false/, 'the main window must not opt out of background throttling');
});

test('renderer unresponsiveness is recorded instead of silently swallowed', () => {
    assert.match(mainSource, /mainWindow\.on\('unresponsive',\s*\(\)\s*=>\s*recordMainWindowResponsiveness\(false/);
    assert.match(mainSource, /mainWindow\.webContents\.on\('unresponsive',\s*\(\)\s*=>\s*recordMainWindowResponsiveness\(false/);
    assert.match(mainSource, /mainWindow\.on\('responsive',\s*\(\)\s*=>\s*recordMainWindowResponsiveness\(true/);
    const snapshotStart = mainSource.indexOf('const buildMainLifecycleSnapshot = () => {');
    assert.ok(snapshotStart >= 0, 'the lifecycle snapshot must be built by a reusable function');
    const snapshotBlock = mainSource.slice(snapshotStart, snapshotStart + 2500);
    assert.match(snapshotBlock, /mainWindowResponsiveness:\s*\{\s*\.\.\.mainWindowResponsiveness\s*\}/, 'the lifecycle snapshot must expose the responsiveness record');
});
