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
            'Musicmodules/music-stage/modes/diorama-director.js',
            'Musicmodules/music-stage/modes/diorama-camera.js',
            'Musicmodules/music-stage/modes/diorama-world.js',
            'Musicmodules/music-stage/modes/diorama-lyrics.js',
            'Musicmodules/music-stage/modes/diorama-optics.js',
            'Musicmodules/music-stage/modes/diorama-events.js',
            'Musicmodules/music-stage/modes/diorama-manager.js'
        ]) await page.addScriptTag({ path: path.resolve(file) });
        await page.evaluate(async () => {
            const palette = { background: '#171a1d', ink: '#f2f0e9', accent: '#f2a900',
                secondary: '#76bfae', accentRgb: { r: 242, g: 169, b: 0 } };
            window.config = MusicStageConfig.get();
            window.lines = MusicStageRuntime.normalizeLines(Array.from({ length: 40 }, (_, i) => ({
                time: i * 6, endTime: i * 6 + 6, fullText: `在未知的深处 ${i} 再次相遇`,
                isChorus: i >= 12 && i < 20 || i >= 28 && i < 36,
                translation: '在下一站等待星光',
                romanization: 'Waiting for starlight',
                words: [{ text: '在未知的深处 再次相遇', startTime: i * 6, endTime: i * 6 + 3 }]
            })));
            window.stageApp = { stagePalette: palette };
            window.manager = MusicStageDioramaManager.create(document.getElementById('stage'), {
                app: stageApp, config
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
        for (const [label, time] of [['opening', 0], ['verse', 8], ['platform', 32], ['pre', 68], ['chorus', 80], ['return', 170]]) {
            const snapshot = await page.evaluate(time => {
                manager.updateFrame(frameAt(time));
                return manager.getDebugSnapshot();
            }, time);
            assert.equal(snapshot.initialized, true);
            assert.equal(snapshot.fallbackMode, false);
            assert.ok(snapshot.liveStations <= 4);
            assert.equal(snapshot.waterVisible, true);
            assert.ok(snapshot.lyricNodes <= 6);
            assert.ok(snapshot.architecturalInstances > 0, 'Station architecture must remain present');
            assert.ok(snapshot.stationTypes.length > 0);
            snapshots.push({ label, ...snapshot });
            await page.screenshot({ path: `artifacts/diorama/${label}.png` });
        }
        const readingChecks = await page.evaluate(() => {
            const failures = [];
            let samples = 0;
            for (let time = 0.2; time < 216; time += 0.8) {
                manager.updateFrame(frameAt(time));
                const snapshot = manager.getDebugSnapshot();
                const addresses = snapshot.visibleSignPages.map(page => page.encounterId);
                if (new Set(addresses).size !== addresses.length)
                    failures.push({ time, duplicatePages: snapshot.visibleSignPages });
                for (const bounds of snapshot.readingBounds) {
                    samples++;
                    if (!bounds.inside || !bounds.attached || !bounds.fitsCarrier
                        || !bounds.animatedVertices || bounds.anchorError > 0.2)
                        failures.push({ time, ...bounds });
                }
            }
            return { samples, failures };
        });
        assert.ok(readingChecks.samples > 0);
        assert.deepEqual(readingChecks.failures, [],
            'Singing phrases must remain visible and physically attached to their carrier');
        const encounterSides = snapshots[0].encounterSides;
        assert.ok(encounterSides.length >= 2);
        encounterSides.forEach((side, index) => {
            assert.equal(side, index % 2 ? -1 : 1, 'Roadside signs must alternate sides');
        });
        for (const quality of ['energy-saving', 'standard', 'ultimate']) {
            await page.setViewport({ width: 560, height: 800 });
            const result = await page.evaluate(quality => {
                const next = structuredClone(config);
                next.quality = quality;
                manager.updateConfig(next);
                manager.resize();
                manager.updateFrame(frameAt(80));
                return manager.getDebugSnapshot();
            }, quality);
            assert.ok(result.readingBounds.every(b => b.inside), `Narrow viewport: ${quality}`);
        }
        await page.setViewport({ width: 1280, height: 800 });
        await page.evaluate(() => { manager.updateConfig(config); manager.resize(); });
        const variants = [];
        for (const variant of ['light', 'reflection-off', 'motion-off', 'instrumental']) {
            const result = await page.evaluate(variant => {
                const next = structuredClone(config);
                stageApp.stagePalette = variant === 'light'
                    ? { background: '#f2efe7', ink: '#1b211f', accent: '#b94832', secondary: '#21675c', light: true }
                    : { background: '#171a1d', ink: '#f2f0e9', accent: '#f2a900', secondary: '#76bfae' };
                if (variant === 'reflection-off') next.modes.diorama.waterReflection = false;
                if (variant === 'motion-off') next.modes.diorama.motionAmount = 0;
                manager.updateConfig(next);
                manager.updateTheme();
                manager.updateFrame(variant === 'instrumental'
                    ? { ...frameAt(15), lines: [], duration: 120, activeLine: null, currentLineIndex: -1 }
                    : frameAt(80));
                return { variant, ...manager.getDebugSnapshot() };
            }, variant);
            assert.equal(result.fallbackMode, false);
            assert.ok(result.readingBounds.every(b => b.inside), variant);
            if (variant === 'reflection-off') assert.equal(result.reflectionEnabled, false);
            if (variant === 'instrumental') assert.equal(result.lyricNodes, 0);
            variants.push(result);
            await page.screenshot({ path: `artifacts/diorama/${variant}.png` });
        }
        await page.evaluate(() => {
            manager.updateConfig(config);
            manager.updateFrame(frameAt(80, false));
        });
        const pausedImage = await page.screenshot();
        await page.evaluate(() => manager.updateFrame({
            ...frameAt(80, false), now: 999999,
            audio: { bass: 1, vocal: 1, power: 1, spectrum: Array(48).fill(1) }
        }));
        const repeatedPausedImage = await page.screenshot();
        if (!Buffer.from(repeatedPausedImage).equals(Buffer.from(pausedImage))) {
            fs.writeFileSync('artifacts/diorama/pause-first.png', pausedImage);
            fs.writeFileSync('artifacts/diorama/pause-repeat.png', repeatedPausedImage);
            const sharp = require('sharp');
            const a = await sharp(pausedImage).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            const b = await sharp(repeatedPausedImage).ensureAlpha().raw().toBuffer();
            let changed = 0, maxDelta = 0, left = a.info.width, right = 0, top = a.info.height, bottom = 0;
            for (let i = 0; i < b.length; i += 4) {
                const delta = Math.max(...[0, 1, 2].map(c => Math.abs(a.data[i + c] - b[i + c])));
                if (!delta) continue;
                changed++;
                maxDelta = Math.max(maxDelta, delta);
                const x = i / 4 % a.info.width, y = Math.floor(i / 4 / a.info.width);
                left = Math.min(left, x); right = Math.max(right, x);
                top = Math.min(top, y); bottom = Math.max(bottom, y);
            }
            const tolerance = Math.max(1, Math.floor(a.info.width * a.info.height / 100000));
            assert.ok(maxDelta <= 1 && changed <= tolerance,
                `Pause image changed: ${JSON.stringify({ changed, maxDelta, left, right, top, bottom, tolerance })}`);
        }
        const spectrumChecks = await page.evaluate(() => {
            manager.updateFrame({ ...frameAt(8), audio: { spectrum: Array(128).fill(0.05) } });
            const weak = manager.getDebugSnapshot().signSpectrum;
            manager.updateFrame({ ...frameAt(8, false), audio: { spectrum: Array(128).fill(1) } });
            const paused = manager.getDebugSnapshot().signSpectrum;
            manager.updateFrame({ ...frameAt(7), audio: { spectrum: Array(128).fill(0) } });
            const silent = manager.getDebugSnapshot().signSpectrum;
            manager.updateFrame({ ...frameAt(6), audio: {
                spectrum: Array.from({ length: 128 }, (_, i) => i < 16 ? 0.08 : 0.015)
            } });
            return { weak, paused, silent, varied: manager.getDebugSnapshot().signSpectrum };
        });
        assert.ok(spectrumChecks.weak.every(v => v > 0.2 && v < 0.5));
        assert.deepEqual(spectrumChecks.paused, spectrumChecks.weak);
        assert.ok(spectrumChecks.silent.every(v => v === 0));
        assert.ok(Math.max(...spectrumChecks.varied) - Math.min(...spectrumChecks.varied) > 0.15);
        const eventShots = [];
        for (const kind of ['meteor', 'rabbit', 'pigeons', 'whale']) {
            const result = await page.evaluate(kind => {
                const customLines = kind === 'whale' ? [] : kind === 'pigeons'
                    ? MusicStageRuntime.normalizeLines([
                        { startTime: 0, endTime: 90, fullText: '持续的人声' },
                        { startTime: 80, endTime: 180, fullText: '重叠的人声' }
                    ]) : lines;
                const frame = time => ({ ...frameAt(time), lines: customLines,
                    duration: kind === 'pigeons' ? 181 : 240, track: { path: 'events-test' } });
                manager.updateConfig(config);
                manager.updateFrame(frame(0));
                const event = manager.getDebugSnapshot().eventPlan.find(e => e.kind === kind);
                if (!event) return { kind, missing: true };
                const time = event.start + (kind === 'whale' ? 4.5 : kind === 'rabbit' ? 2 : 1.4);
                manager.updateFrame(frame(time));
                const middle = manager.getDebugSnapshot();
                manager.updateFrame(frame(event.end - 0.2));
                manager.updateFrame(frame(time));
                const sought = manager.getDebugSnapshot();
                let after = null;
                if (kind === 'whale') {
                    manager.updateFrame(frame(event.start + 9));
                    after = manager.getDebugSnapshot();
                    manager.updateFrame(frame(time));
                }
                return { kind, middle, sought, after };
            }, kind);
            assert.ok(!result.missing, `No ${kind} event in fixture`);
            assert.ok(result.middle.eventVertices > 0, kind);
            if (kind === 'rabbit' || kind === 'pigeons') {
                assert.equal(result.middle.eventPoints, 0, 'Vector animals must not retain particle bodies');
                assert.ok(result.middle.eventLineVertices > 0);
            }
            assert.ok(result.middle.eventInView > result.middle.eventVertices * 0.5,
                `${kind}: only ${result.middle.eventInView}/${result.middle.eventVertices} vertices in view`);
            assert.deepEqual(result.middle.activeEvent, result.sought.activeEvent);
            assert.deepEqual(result.middle.quaternion, result.sought.quaternion);
            if (kind === 'whale') {
                assert.equal(result.after.eventPoints, 0);
                assert.ok(result.after.eventRipples > 0);
            }
            eventShots.push(result);
            await page.screenshot({ path: `artifacts/diorama/event-${kind}.png` });
        }
        // Real CSS palettes: dark/light extraction and live WebGL theme changes.
        const themeChecks = [];
        for (const name of ['themesEva', 'themes纸墨与机芯', 'themes酸性玄武']) {
            const css = fs.readFileSync(`styles/themes/${name}.css`, 'utf8');
            // Wallpaper assets are irrelevant to the procedural scene.
            const style = await page.addStyleTag({ content: css.replace(/url\([^)]*\)/g, 'none') });
            for (const light of [false, true]) {
                const result = await page.evaluate(light => {
                    document.body.classList.toggle('light-theme', light);
                    const stage = document.getElementById('stage');
                    stage.classList.add('music-stage');
                    stageApp.currentTheme = light ? 'light' : 'dark';
                    const palette = MusicStageModeUtils.refreshTheme(stageApp, stage);
                    const next = structuredClone(config);
                    next.modes.diorama.aurora = true;
                    manager.updateConfig(next);
                    manager.updateTheme();
                    manager.updateFrame(frameAt(0, false));
                    return { palette, snapshot: manager.getDebugSnapshot() };
                }, light);
                assert.equal(result.palette.light, light);
                assert.ok(result.palette.emission && result.palette.material && result.palette.border);
                assert.equal(result.snapshot.fallbackMode, false);
                assert.equal(result.snapshot.auroraVisible, true);
                if (name === 'themes酸性玄武' && light) {
                    assert.equal(result.palette.accent, '#709600');
                    assert.equal(result.palette.emission, '#ccff00');
                }
                const on = await page.screenshot({
                    path: `artifacts/diorama/${name}-${light ? 'light' : 'dark'}.png`
                });
                const offState = await page.evaluate(() => {
                    const next = structuredClone(config);
                    next.modes.diorama.aurora = false;
                    manager.updateConfig(next);
                    return manager.getDebugSnapshot();
                });
                assert.equal(offState.auroraVisible, false);
                assert.equal(offState.instanceRebuilds, result.snapshot.instanceRebuilds,
                    'Aurora toggle must not rebuild track/scenery');
                const off = await page.screenshot();
                const sharp = require('sharp');
                const a = await sharp(on).removeAlpha().raw().toBuffer({ resolveWithObject: true });
                const b = await sharp(off).removeAlpha().raw().toBuffer();
                let skyChanged = 0, waterChanged = 0;
                for (let y = 0; y < a.info.height; y++) {
                    for (let x = 0; x < a.info.width; x++) {
                        const i = (y * a.info.width + x) * 3;
                        const delta = Math.max(...[0, 1, 2].map(c => Math.abs(a.data[i + c] - b[i + c])));
                        if (delta < 5) continue;
                        if (y < a.info.height * 0.45 && x < a.info.width * 0.55) skyChanged++;
                        if (y > a.info.height * 0.55) waterChanged++;
                    }
                }
                assert.ok(skyChanged > 500, `${name}/${light}: aurora must be visible in upper-left sky`);
                assert.ok(waterChanged > 100, `${name}/${light}: aurora must appear in reflection`);
                themeChecks.push({ name, light, palette: result.palette, skyChanged, waterChanged });
            }
            await style.dispose();
            await page.evaluate(() => {
                // dispose() releases the handle, not the style element.
                document.querySelectorAll('style').forEach(s => {
                    if (s.textContent.includes('--primary-bg')) s.remove();
                });
            });
        }
        await page.evaluate(() => {
            document.body.classList.remove('light-theme');
            stageApp.currentTheme = 'dark';
            stageApp.stagePalette = { background: '#171a1d', ink: '#f2f0e9',
                accent: '#f2a900', secondary: '#76bfae' };
            manager.updateConfig(config);
            manager.updateTheme();
        });
        // Include theme checks in the single JSON report below.
        const finaleChecks = await page.evaluate(() => {
            const english = MusicStageRuntime.normalizeLines([{
                startTime: 0, endTime: 8,
                fullText: 'Walking through the night we find our way home together',
                isChorus: true
            }]);
            const next = structuredClone(config);
            next.modes.diorama.lyricCarrier = 'constellation';
            manager.updateConfig(next);
            const frame = t => ({ ...frameAt(t, false), lines: english,
                duration: 20, activeLine: english[0], track: { path: 'english-finale' } });
            manager.updateFrame(frame(2));
            const reading = manager.getDebugSnapshot();
            const opacities = [8, 12, 16, 20].map(t => {
                manager.updateFrame(frame(t));
                return manager.getDebugSnapshot().starOpacity;
            });
            const final = manager.getDebugSnapshot();
            manager.updateFrame(frame(2));
            return { reading, opacities, final };
        });
        assert.ok(finaleChecks.reading.readingBounds.length > 0);
        assert.ok(finaleChecks.reading.readingBounds.every(b => b.inside));
        assert.ok(finaleChecks.reading.readingBounds.some(b => b.animatedVertices > 96),
            'English page must render more than the old 24 glyph limit');
        finaleChecks.opacities.forEach((value, i, values) => {
            if (i) assert.ok(value <= values[i - 1]);
        });
        assert.equal(finaleChecks.opacities.at(-1), 0);
        assert.equal(finaleChecks.final.moonRadius, 20);
        await page.screenshot({ path: 'artifacts/diorama/english-phrase.png' });
        await page.evaluate(() => {
            manager.updateFrame({ ...frameAt(20, false), lines: MusicStageRuntime.normalizeLines([{
                startTime: 0, endTime: 8, fullText: 'The last song', isChorus: true
            }]), duration: 20, track: { path: 'finale-shot' } });
        });
        await page.screenshot({ path: 'artifacts/diorama/finale-moon.png' });
        await page.evaluate(() => manager.updateConfig(config));
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
        assert.equal(checks.disabled.waterVisible, true, 'Water belongs to the world, not the scenery toggle');
        assert.equal(checks.empty.lyricNodes, 0);
        assert.equal(checks.canvasCount, 0);
        assert.deepEqual(errors, [], 'No browser or shader errors');
        console.log(JSON.stringify({ snapshots, readingChecks, spectrumChecks, eventShots, variants,
            themeChecks, finaleChecks, checks, errors }, null, 2));
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });