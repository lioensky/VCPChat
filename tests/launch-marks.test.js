'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLaunchMarks } = require('../modules/launchMarks');

const projectRoot = path.resolve(__dirname, '..');

function clockFrom(startMs) {
    let nowMs = startMs;
    return { now: () => nowMs, tick: ms => { nowMs += ms; } };
}

test('marks are relative to process start and only the first occurrence of a name counts', () => {
    const start = Date.parse('2026-10-11T08:00:00Z');
    const clock = clockFrom(start + 40);
    const marks = createLaunchMarks({ now: clock.now, processStartedAt: start });

    assert.deepEqual(marks.mark('process-started'), { name: 'process-started', atMs: 40 });
    clock.tick(360);
    assert.deepEqual(marks.mark('electron-ready'), { name: 'electron-ready', atMs: 400 });
    clock.tick(1_100);
    assert.deepEqual(marks.mark('main-window-loaded'), { name: 'main-window-loaded', atMs: 1_500 });
    clock.tick(700);
    assert.deepEqual(marks.mark('renderer-ready'), { name: 'renderer-ready', atMs: 2_200 });
    clock.tick(5_000);
    assert.equal(marks.mark('renderer-ready'), null, 'a repeat (renderer recovery) does not move the mark');
    assert.equal(marks.mark(''), null);
    assert.equal(marks.mark(undefined), null);

    assert.equal(marks.has('renderer-ready'), true);
    assert.equal(marks.has('workspace-ready'), false);
    assert.equal(marks.atMs('electron-ready'), 400);
    assert.equal(marks.atMs('nope'), null);

    const snapshot = marks.snapshot();
    assert.equal(snapshot.processStartedAt, '2026-10-11T08:00:00.000Z');
    assert.equal(snapshot.rendererReadyMs, 2_200);
    assert.equal(snapshot.elapsedMs, 7_200);
    assert.deepEqual(snapshot.marks, [
        { name: 'process-started', atMs: 40, repeats: 0 },
        { name: 'electron-ready', atMs: 400, repeats: 0 },
        { name: 'main-window-loaded', atMs: 1_500, repeats: 0 },
        { name: 'renderer-ready', atMs: 2_200, repeats: 1 },
    ]);

    assert.deepEqual(marks.summary(), {
        rendererReadyMs: 2_200,
        timeline: { 'process-started': 40, 'electron-ready': 400, 'main-window-loaded': 1_500, 'renderer-ready': 2_200 },
    });
});

test('without a process start time the origin is the moment the marks were created', () => {
    const clock = clockFrom(1_000);
    const marks = createLaunchMarks({ now: clock.now });
    clock.tick(25);
    assert.equal(marks.mark('electron-ready').atMs, 25);
    assert.equal(marks.snapshot().rendererReadyMs, null);
    assert.equal(marks.summary().rendererReadyMs, null);
});

test('main.js marks every launcher stage regardless of the launcher protocol and marks the main window load', () => {
    const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
    const fnStart = mainSource.indexOf('function reportLauncherProgress(stage, progress, message) {');
    assert.ok(fnStart >= 0);
    const body = mainSource.slice(fnStart, mainSource.indexOf('\n}\n', fnStart));
    const markIndex = body.indexOf('launchMarks.mark(stage)');
    const protocolIndex = body.indexOf("VCP_LAUNCHER_PROTOCOL !== '1'");
    assert.ok(markIndex >= 0 && protocolIndex > markIndex, 'the mark must be taken before the launcher-protocol early return');

    const loadStart = mainSource.indexOf('function loadMainWindow');
    assert.ok(loadStart >= 0);
    const loadBlock = mainSource.slice(loadStart, loadStart + 2000);
    assert.match(loadBlock, /once\('did-finish-load',\s*\(\)\s*=>\s*\{\s*launchMarks\.mark\('main-window-loaded'\)/);

    assert.match(mainSource, /createLaunchMarks\(\{\s*processStartedAt:\s*Date\.now\(\)\s*-\s*Math\.round\(process\.uptime\(\)\s*\*\s*1000\)/, 'the origin is the real process start, not the moment main.js was evaluated');
});
