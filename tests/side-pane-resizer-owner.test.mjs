import test from 'node:test';
import assert from 'node:assert/strict';
import { createSidePaneResizerOwner } from '../modules/ui-system/side-pane/side-pane-resizer-owner.js';

test('createSidePaneResizerOwner notifies width commit and binds lifecycle scope', () => {
    let appliedWidth = 0;
    let committedWidth = 0;
    let ownedDisposer = null;

    const fakeHandle = {
        classList: { toggle() {} },
        ownerDocument: {
            body: { style: {}, classList: { toggle() {} } },
        },
    };
    const fakePane = {
        style: { width: '360px' },
        getBoundingClientRect: () => ({ width: 360 }),
    };

    let factoryOptions = null;
    const mockFactory = (options) => {
        factoryOptions = options;
        return {
            refresh() {},
            dispose() { factoryOptions = null; },
        };
    };

    const mockScope = {
        own(resource) {
            ownedDisposer = resource;
            return resource;
        },
    };

    const owner = createSidePaneResizerOwner({
        handle: fakeHandle,
        paneElement: fakePane,
        resizerFactory: mockFactory,
        scope: mockScope,
        onWidthChange: (w) => { appliedWidth = w; },
        onWidthCommit: (w) => { committedWidth = w; },
    });

    assert.ok(ownedDisposer);
    factoryOptions.applyValue(400);
    assert.equal(appliedWidth, 400);
    assert.equal(fakePane.style.width, '400px');

    factoryOptions.onCommit(400);
    assert.equal(committedWidth, 400);

    owner.dispose();
    assert.equal(factoryOptions, null, 'disposing the owner disposes the resizer');
});

test('one arrow key press moves the side pane once and commits once', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../modules/ui-system/sidebar-resizer.js', import.meta.url), 'utf8');
    const win = { requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout };
    new Function('window', source)(win);

    const listeners = {};
    const handle = {
        setAttribute() {},
        classList: { toggle() {} },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        removeEventListener() {},
        ownerDocument: { body: { style: {}, classList: { toggle() {} } } },
    };
    let width = 400;
    const pane = {
        style: {},
        getBoundingClientRect: () => ({ width }),
    };
    const commits = [];
    createSidePaneResizerOwner({
        handle,
        paneElement: pane,
        resizerFactory: win.VCPSidebarResizer.create,
        documentRef: { querySelector: () => null, addEventListener() {}, removeEventListener() {} },
        windowRef: { innerWidth: 1200 },
        onWidthChange: w => { width = w; },
        onWidthCommit: w => commits.push(w),
    });

    const press = key => listeners.keydown.forEach(fn => fn({ key, preventDefault() {} }));
    press('ArrowLeft');
    assert.equal(width, 420);
    assert.deepEqual(commits, [420]);
    press('ArrowRight');
    assert.equal(width, 400);
    // 1200 宽的窗口：上限 780，下限 240
    press('End');
    assert.equal(width, 780);
    press('Home');
    assert.equal(width, 240);
    assert.deepEqual(commits, [420, 400, 780, 240]);
});

test('holding an arrow key resizes on every press but saves the width once, after the keys stop', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../modules/ui-system/sidebar-resizer.js', import.meta.url), 'utf8');
    const win = { requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout };
    new Function('window', source)(win);

    const listeners = {};
    const handle = {
        setAttribute() {},
        classList: { toggle() {} },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        removeEventListener() {},
        ownerDocument: { body: { style: {}, classList: { toggle() {} } } },
    };
    let width = 400;
    const pane = { style: {}, getBoundingClientRect: () => ({ width }) };
    const commits = [];
    let pending = null;
    const owner = createSidePaneResizerOwner({
        handle,
        paneElement: pane,
        resizerFactory: win.VCPSidebarResizer.create,
        documentRef: { querySelector: () => null, addEventListener() {}, removeEventListener() {} },
        // 手动调度保存的计时器：不用真的等
        windowRef: { innerWidth: 1200, setTimeout: (fn) => { pending = fn; return 1; }, clearTimeout: () => { pending = null; } },
        keyboardCommitDelayMs: 30,
        onWidthChange: w => { width = w; },
        onWidthCommit: w => commits.push(w),
    });

    const press = key => listeners.keydown.forEach(fn => fn({ type: 'keydown', key, preventDefault() {} }));
    for (let i = 0; i < 5; i++) press('ArrowLeft');
    assert.equal(width, 500, 'every press resizes right away');
    assert.deepEqual(commits, [], 'nothing is saved while keys are still coming');
    assert.ok(pending, 'a save is scheduled');
    pending();
    assert.deepEqual(commits, [500]);

    press('End');
    assert.equal(width, 780);
    listeners.blur.forEach(fn => fn());
    assert.deepEqual(commits, [500, 780], 'leaving the handle saves at once');

    press('ArrowRight');
    owner.dispose();
    assert.deepEqual(commits, [500, 780, 760], 'disposing saves what is pending');
});
