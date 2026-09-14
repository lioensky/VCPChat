'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const puppeteer = require('puppeteer');

(async () => {
    const executablePath = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
    ].find(candidate => candidate && fs.existsSync(candidate));
    const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-webgl'] });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        page.on('console', message => {
            if (message.type() === 'error') errors.push(message.text());
        });
        await page.setContent('<style>body{margin:0;background:#171a1d}.music-stage-mode{position:absolute;inset:0}.diorama-canvas{width:100%;height:100%}[hidden]{display:none!important}.diorama-vector-decor{display:none}</style><main id="stage"></main>');
        for (const file of [
            'vendor/three.min.js',
            'Musicmodules/music-stage/music-stage-runtime.js',
            'Musicmodules/music-stage/music-stage-config.js',
            'Musicmodules/music-stage/modes/stage-mode-utils.js',
            'Musicmodules/music-stage/modes/diorama-stations.js',
            'Musicmodules/music-stage/modes/diorama-manager.js'
        ]) await page.addScriptTag({ path: path.resolve(file) });
        await page.evaluate(async () => {
            const palette = { background: '#171a1d', ink: '#f2f0e9', accent: '#f2a900',
                secondary: '#76bfae', accentRgb: { r: 242, g: 169, b: 0 } };
            window.config = MusicStageConfig.get();
            window.lines = MusicStageRuntime.normalizeLines(Array.from({ length: 40 }, (_, i) => ({
                time: i * 6, endTime: i * 6 + 6, fullText: '在未知的深处 再次相遇',
                words: [{ text: '在未知的深处 再次相遇', startTime: i * 6, endTime: i * 6 + 3 }]
            })));
            window.manager = MusicStageDioramaManager.create(document.getElementById('stage'), {
                app: { stagePalette: palette }, config
            });
            window.frameAt = (time, playing = true) => ({
                now: time * 1000, playbackTime: time, isPlaying: playing,
                lines, currentLineIndex: Math.min(lines.length - 1, Math.floor(time / 6)),
                activeLine: lines[Math.min(lines.length - 1, Math.floor(time / 6))],
                track: { path: 'smoke-track' }, audio: { bass: 0.3, vocal: 0.2, treble: 0.15 }
            });
            await new Promise(resolve => setTimeout(resolve, 100));
            manager.updateFrame(frameAt(1));
        });
        const snapshots = [];
        fs.mkdirSync('artifacts/diorama', { recursive: true });
        for (const [label, time] of [['helix', 8], ['platform', 32], ['memory', 56], ['water', 80], ['echo', 104]]) {
            const snapshot = await page.evaluate(time => {
                manager.updateFrame(frameAt(time));
                return manager.getDebugSnapshot();
            }, time);
            assert.equal(snapshot.initialized, true);
            assert.equal(snapshot.fallbackMode, false);
            assert.ok(snapshot.liveStations <= 4);
            if (label === 'water') assert.equal(snapshot.waterVisible, true);
            snapshots.push({ label, ...snapshot });
            await page.screenshot({ path: `artifacts/diorama/${label}.png` });
        }
        const checks = await page.evaluate(() => {
            manager.updateFrame(frameAt(8));
            const first = manager.getDebugSnapshot().camera;
            manager.updateFrame(frameAt(8, false));
            manager.updateFrame({ ...frameAt(8, false), now: 90000 });
            const paused = manager.getDebugSnapshot().camera;
            manager.updateFrame(frameAt(80));
            manager.updateFrame(frameAt(8));
            const sought = manager.getDebugSnapshot().camera;
            manager.updateFrame(frameAt(3));
            const gapStart = manager.getDebugSnapshot().camera;
            for (let time = 3.02; time < 5.95; time += 0.02) manager.updateFrame(frameAt(time));
            const gapEnd = manager.getDebugSnapshot().camera;
            const off = structuredClone(config);
            off.modes.diorama.narrativeStations = false;
            manager.updateConfig(off);
            manager.updateFrame(frameAt(80));
            const disabled = manager.getDebugSnapshot();
            manager.updateConfig(config);
            manager.updateFrame(frameAt(80));
            manager.updateTheme();
            manager.updateFrame({ ...frameAt(0), lines: [], activeLine: null, currentLineIndex: -1 });
            const empty = manager.getDebugSnapshot();
            manager.destroy();
            return { first, paused, sought, gapStart, gapEnd, disabled, empty,
                canvasCount: document.querySelectorAll('canvas').length, revision: THREE.REVISION };
        });
        assert.deepEqual(checks.first, checks.paused, 'Pause must freeze the camera');
        assert.deepEqual(checks.first, checks.sought, 'Backward seek must snap to the same target');
        assert.ok(Math.hypot(...checks.gapEnd.map((v, i) => v - checks.gapStart[i])) > 1, 'Gap must advance');
        assert.equal(checks.disabled.liveStations, 0);
        assert.equal(checks.disabled.waterVisible, false);
        assert.equal(checks.empty.liveStations, 0);
        assert.equal(checks.canvasCount, 0);
        assert.deepEqual(errors, [], 'No browser or shader errors');
        console.log(JSON.stringify({ snapshots, checks, errors }, null, 2));
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });