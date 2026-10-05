import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createSidePaneResizerOwner } from '../modules/ui-system/side-pane/side-pane-resizer-owner.js';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';

const source = fs.readFileSync(new URL('../modules/ui-system/sidebar-resizer.js', import.meta.url), 'utf8');
const managerSource = fs.readFileSync(new URL('../modules/uiManager.js', import.meta.url), 'utf8');
const pointerEvents = { down: 'pointerdown', move: 'pointermove', up: 'pointerup', cancel: 'pointercancel' };

function fixture(options = {}) {
    const dom = new JSDOM('<!doctype html><body><aside id="pane"></aside><div id="handle" tabindex="0"></div></body>', { runScripts: 'outside-only' });
    const win = dom.window, doc = win.document;
    const handle = doc.getElementById('handle'), pane = doc.getElementById('pane');
    const frames = new Map(), scheduled = [], applied = [], committed = [], active = [];
    let nextFrame = 0, capture = null, width = 300;
    win.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); scheduled.push(callback); return nextFrame; };
    win.cancelAnimationFrame = id => frames.delete(id);
    handle.setPointerCapture = id => { capture = id; };
    handle.hasPointerCapture = id => capture === id;
    handle.releasePointerCapture = id => { if (capture === id) capture = null; };
    pane.getBoundingClientRect = () => ({ width });
    win.eval(source);
    const config = {
        handle, document: doc, eventNames: pointerEvents,
        getValue: () => width, getBounds: () => ({ min: 100, max: 800 }),
        applyValue: value => { width = value; applied.push(value); },
        onCommit: value => committed.push(value), onActiveChange: value => active.push(value),
        ...options,
    };
    const resizer = win.VCPSidebarResizer.create(config);
    const emit = (target, type, clientX = 0, pointerId = 1, button = 0) => {
        const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX, button });
        if (type.startsWith('pointer') || type === 'lostpointercapture') {
            Object.defineProperty(event, 'pointerId', { value: pointerId });
        }
        target.dispatchEvent(event);
    };
    return { dom, win, doc, handle, pane, frames, scheduled, applied, committed, active, resizer, emit,
        width: () => width, capture: () => capture,
        flush() { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } },
        close() { resizer.dispose(); dom.window.close(); },
    };
}

async function initManager(f, saveSettings) {
    f.resizer.dispose();
    if (!f.win.uiManager) f.win.eval(managerSource);
    f.pane.style.minWidth = '100px'; f.pane.style.maxWidth = '800px';
    const options = { electronAPI: {
        onThemeUpdated() { return () => {}; }, getCurrentTheme: async () => 'light', saveSettings,
    }, refs: { globalSettingsRef: { get: () => ({ currentThemeMode: 'light' }), set() {} } },
    listenerOwner: { capture: () => () => {}, timeout: () => null },
    elements: { leftSidebar: f.pane, resizerLeft: f.handle, resizerRight: null,
        rightNotificationsSidebar: null, digitalClockElement: null, dateDisplayElement: null,
        notificationTitleElement: null, sidebarTabButtons: [], sidebarTabContents: [] } };
    await f.win.uiManager.init(options);
    return options;
}

test('pointerup commits its final coordinate once and retires queued movement', () => {
    const f = fixture();
    try {
        f.emit(f.handle, 'pointerdown', 100);
        f.emit(f.doc, 'pointermove', 120);
        f.emit(f.doc, 'pointerup', 180);
        assert.equal(f.width(), 380);
        assert.deepEqual(f.applied, [380]);
        assert.deepEqual(f.committed, [380]);
        assert.equal(f.frames.size, 0);
        assert.equal(f.capture(), null);
        f.scheduled.forEach(callback => callback());
        assert.deepEqual(f.applied, [380], 'late RAF delivery cannot apply a retired gesture');
    } finally { f.close(); }
});

test('foreign pointer motion, completion, cancellation and repeated down cannot take over a gesture', () => {
    const f = fixture();
    try {
        f.emit(f.handle, 'pointerdown', 100);
        f.emit(f.handle, 'pointerdown', 700, 2);
        f.emit(f.doc, 'pointermove', 700, 2);
        f.emit(f.doc, 'pointerup', 700, 2);
        f.emit(f.doc, 'pointercancel', 700, 2);
        f.flush();
        assert.equal(f.width(), 300);
        assert.deepEqual(f.committed, []);
        assert.equal(f.capture(), 1);
        assert.deepEqual(f.active, [true]);
        f.emit(f.doc, 'pointerup', 140);
        assert.deepEqual(f.committed, [340]);
    } finally { f.close(); }
});

for (const reason of ['pointercancel', 'lostpointercapture', 'blur']) {
    test(`${reason} abandons pending movement without a persistence commit`, () => {
        const f = fixture();
        try {
            f.emit(f.handle, 'pointerdown', 100);
            f.emit(f.doc, 'pointermove', 120);
            f.flush();
            f.emit(f.doc, 'pointermove', 180);
            if (reason === 'blur') f.win.dispatchEvent(new f.win.Event('blur'));
            else f.emit(reason === 'lostpointercapture' ? f.handle : f.doc, reason, 180);
            f.scheduled.forEach(callback => callback());
            assert.equal(f.width(), 320, 'retain the last rendered width, without applying cancelled queued motion');
            assert.deepEqual(f.committed, []);
            assert.equal(f.frames.size, 0);
            assert.equal(f.capture(), null);
            assert.deepEqual(f.active, [true, false]);
            f.emit(f.doc, 'pointermove', 250);
            f.emit(f.doc, 'pointerup', 250);
            assert.equal(f.width(), 320);
        } finally { f.close(); }
    });
}

test('dispose cancels the gesture, releases capture and disables all later entry points', () => {
    const f = fixture();
    try {
        f.emit(f.handle, 'pointerdown', 100);
        f.emit(f.doc, 'pointermove', 160);
        f.resizer.dispose(); f.resizer.dispose();
        f.scheduled.forEach(callback => callback());
        f.emit(f.handle, 'pointerdown', 100);
        f.emit(f.doc, 'pointermove', 250);
        f.emit(f.doc, 'pointerup', 250);
        f.handle.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
        f.resizer.refresh();
        assert.equal(f.width(), 300);
        assert.deepEqual(f.applied, []);
        assert.deepEqual(f.committed, []);
        assert.deepEqual(f.active, [true, false]);
        assert.equal(f.capture(), null);
        assert.equal(f.frames.size, 0);
    } finally { f.close(); }
});

test('a delayed beforeBegin continuation cannot restart a disposed resizer', () => {
    let resume;
    const f = fixture({ beforeBegin(_event, continuation) { resume = continuation; return false; } });
    try {
        f.emit(f.handle, 'pointerdown', 100);
        assert.equal(typeof resume, 'function');
        f.resizer.dispose(); resume();
        f.emit(f.doc, 'pointermove', 180);
        f.flush();
        assert.deepEqual(f.active, []);
        assert.deepEqual(f.applied, []);
        assert.equal(f.capture(), null);
    } finally { f.close(); }
});

test('releasing before a deferred begin prevents a ghost drag, but a later gesture can start', () => {
    let resume;
    const f = fixture({ beforeBegin(_event, continuation) { resume = continuation; return false; } });
    try {
        f.emit(f.handle, 'pointerdown', 100);
        const cancelledResume = resume;
        f.emit(f.doc, 'pointerup', 120);
        cancelledResume();
        assert.deepEqual(f.active, []);
        assert.equal(f.capture(), null);
        f.emit(f.handle, 'pointerdown', 140);
        cancelledResume();
        assert.deepEqual(f.active, [], 'an old continuation cannot start the new pending gesture');
        resume();
        f.emit(f.doc, 'pointerup', 160);
        assert.deepEqual(f.committed, [320]);
    } finally { f.close(); }
});

test('RAF coalesces to the latest coordinate against a stable drag origin', () => {
    const f = fixture();
    try {
        f.emit(f.handle, 'pointerdown', 100);
        f.emit(f.doc, 'pointermove', 120); f.emit(f.doc, 'pointermove', 160);
        assert.equal(f.frames.size, 1);
        f.flush();
        f.emit(f.doc, 'pointermove', 180); f.flush();
        f.emit(f.doc, 'pointerup', 190);
        assert.deepEqual(f.applied, [360, 380, 390]);
        assert.deepEqual(f.committed, [390]);
    } finally { f.close(); }
});

test('cancel retires a deferred start without disabling the next gesture', () => {
    let resume;
    const f = fixture({ beforeBegin(_event, continuation) { resume = continuation; return false; } });
    try {
        f.emit(f.handle, 'pointerdown', 100);
        const oldResume = resume;
        f.resizer.cancel(); oldResume();
        assert.deepEqual(f.active, []);
        f.emit(f.handle, 'pointerdown', 140); resume();
        f.emit(f.doc, 'pointerup', 160);
        assert.deepEqual(f.committed, [320]);
    } finally { f.close(); }
});

test('hiding the pane cancels capture, late movement and persistence but reopening can resize', async () => {
    const f = fixture(), writes = [];
    const previous = { window: globalThis.window, document: globalThis.document };
    let controller;
    try {
        f.resizer.dispose();
        globalThis.window = f.win; globalThis.document = f.doc;
        f.win.PointerEvent = f.win.MouseEvent;
        f.pane.classList.add('vcp-side-pane', 'active');
        f.pane.innerHTML = '<div class="side-pane-tabs"></div><div class="side-pane-content-container"><section id="sidePaneViewNotifications"></section></div>';
        f.doc.body.style.userSelect = 'text';
        controller = createSidePaneController({ root: f.pane, resizerHandle: f.handle,
            tabListElement: f.pane.querySelector('.side-pane-tabs'), contentContainer: f.pane.querySelector('.side-pane-content-container'),
            electronAPI: { saveSettings: async patch => { writes.push(patch); return { success: true }; } } });
        controller.setVisible(true, { animate: false });
        f.emit(f.handle, 'pointerdown', 900);
        f.emit(f.doc, 'pointermove', 850);
        controller.setVisible(false, { animate: false });
        assert.equal(controller.getSnapshot().visible, false);
        assert.equal(f.capture(), null);
        assert.equal(f.doc.body.style.userSelect, 'text');
        f.scheduled.forEach(callback => callback());
        f.emit(f.doc, 'pointerup', 800);
        assert.equal(f.pane.style.width, '');
        assert.equal(writes.length, 0);
        controller.setVisible(true, { animate: false });
        f.emit(f.handle, 'pointerdown', 900);
        f.emit(f.doc, 'pointerup', 880);
        assert.equal(writes.length, 1);
        assert.equal(controller.getSnapshot().preferredWidth, 320);
    } finally {
        await controller?.dispose(); f.close();
        for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[name]; else globalThis[name] = value; }
    }
});

test('mouse fallback commits the last release coordinate and cancels on leaving the document', () => {
    const f = fixture({ eventNames: { down: 'mousedown', move: 'mousemove', up: 'mouseup', cancel: 'mouseleave' } });
    try {
        f.emit(f.handle, 'mousedown', 100, undefined);
        f.emit(f.doc, 'mousemove', 120, undefined);
        f.emit(f.doc, 'mouseup', 180, undefined);
        assert.deepEqual(f.committed, [380]);
        f.emit(f.handle, 'mousedown', 180, undefined);
        f.emit(f.doc, 'mousemove', 240, undefined);
        f.emit(f.doc, 'mouseleave', 240, undefined);
        f.flush();
        assert.equal(f.width(), 380);
        assert.deepEqual(f.committed, [380]);
    } finally { f.close(); }
});

test('side pane disposal restores its previous inline drag styles', () => {
    const f = fixture();
    let owner;
    try {
        f.resizer.dispose();
        f.win.PointerEvent = f.win.MouseEvent;
        f.doc.body.style.setProperty('cursor', 'crosshair', 'important');
        f.doc.body.style.setProperty('user-select', 'text', 'important');
        f.pane.style.setProperty('transition', 'opacity 120ms', 'important');
        owner = createSidePaneResizerOwner({ handle: f.handle, paneElement: f.pane,
            documentRef: f.doc, windowRef: f.win, resizerFactory: f.win.VCPSidebarResizer.create });
        f.emit(f.handle, 'pointerdown', 100);
        assert.equal(f.doc.body.style.userSelect, 'none');
        f.emit(f.doc, 'pointermove', 60);
        owner.dispose(); owner.dispose();
        assert.equal(f.doc.body.style.cursor, 'crosshair');
        assert.equal(f.doc.body.style.userSelect, 'text');
        assert.equal(f.pane.style.transition, 'opacity 120ms');
        assert.equal(f.doc.body.classList.contains('vcp-sidebar-resizing'), false);
        assert.equal(f.handle.classList.contains('active'), false);
        assert.equal(f.capture(), null);
    } finally { owner?.dispose(); f.close(); }
});

test('uiManager owns its resizer beyond initialization listener capture and releases an active drag', async () => {
    const f = fixture();
    try {
        f.resizer.dispose();
        f.win.eval(managerSource);
        const manager = f.win.uiManager;
        const saved = [];
        const settings = { get: () => ({ currentThemeMode: 'light' }), set() {} };
        f.pane.style.minWidth = '100px'; f.pane.style.maxWidth = '800px';
        await manager.init({ electronAPI: {
            onThemeUpdated() { return () => {}; }, getCurrentTheme: async () => 'light',
            saveSettings: async patch => { saved.push(patch); return { success: true }; },
        }, refs: { globalSettingsRef: settings }, listenerOwner: { capture: () => () => {}, timeout: () => null },
        elements: { leftSidebar: f.pane, resizerLeft: f.handle, resizerRight: null,
            rightNotificationsSidebar: null, digitalClockElement: null, dateDisplayElement: null,
            notificationTitleElement: null, sidebarTabButtons: [], sidebarTabContents: [] } });
        const initialSaves = saved.length;
        f.emit(f.handle, 'mousedown', 100, undefined);
        f.emit(f.doc, 'mousemove', 180, undefined);
        await manager.dispose();
        f.flush();
        f.emit(f.doc, 'mouseup', 180, undefined);
        assert.equal(saved.length, initialSaves, 'disposing cannot save an unfinished drag');
        assert.equal(f.pane.style.width, '');
        assert.equal(f.doc.body.style.userSelect, '');
        assert.equal(f.frames.size, 0);
        f.emit(f.handle, 'mousedown', 100, undefined);
        f.emit(f.doc, 'mousemove', 250, undefined); f.flush();
        assert.equal(f.pane.style.width, '');
    } finally { await f.win.uiManager?.dispose(); f.close(); }
});

test('uiManager disposal waits for an already committed width write', async () => {
    const f = fixture();
    let resolveWrite;
    try {
        await initManager(f, () => new Promise(resolve => { resolveWrite = resolve; }));
        f.emit(f.handle, 'mousedown', 100);
        f.emit(f.doc, 'mouseup', 160);
        assert.equal(typeof resolveWrite, 'function');
        let finished = false;
        const disposal = f.win.uiManager.dispose().then(() => { finished = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(finished, false, 'the committed settings write belongs to the manager lifecycle');
        assert.equal(f.doc.body.style.userSelect, '', 'drag cleanup must not wait for persistence');
        resolveWrite({ success: true });
        await disposal;
    } finally { resolveWrite?.({ success: true }); await f.win.uiManager?.dispose(); f.close(); }
});

test('uiManager restores pre-existing styles and class state on drag completion and disposal', async () => {
    const f = fixture();
    try {
        await initManager(f, async () => ({ success: true }));
        f.doc.body.style.cursor = 'crosshair';
        f.doc.body.style.userSelect = 'text';
        f.pane.style.transition = 'opacity 120ms';
        f.doc.body.classList.add('vcp-sidebar-resizing');
        f.emit(f.handle, 'mousedown', 100);
        f.emit(f.doc, 'mouseup', 140);
        assert.equal(f.doc.body.style.cursor, 'crosshair');
        assert.equal(f.doc.body.style.userSelect, 'text');
        assert.equal(f.pane.style.transition, 'opacity 120ms');
        assert.equal(f.doc.body.classList.contains('vcp-sidebar-resizing'), true);
        f.emit(f.handle, 'mousedown', 140);
        await f.win.uiManager.dispose();
        assert.equal(f.doc.body.style.cursor, 'crosshair');
        assert.equal(f.doc.body.style.userSelect, 'text');
        assert.equal(f.pane.style.transition, 'opacity 120ms');
        assert.equal(f.doc.body.classList.contains('vcp-sidebar-resizing'), true);
    } finally { await f.win.uiManager?.dispose(); f.close(); }
});

test('reinitializing uiManager replaces the old resizer instead of duplicating keyboard writes', async () => {
    const f = fixture();
    try {
        f.pane.getBoundingClientRect = () => ({ width: parseFloat(f.pane.style.width) || 300 });
        const saved = [];
        const options = await initManager(f, async patch => { saved.push(patch); return { success: true }; });
        await f.win.uiManager.init(options);
        const initialSaves = saved.length;
        f.handle.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
        await Promise.resolve();
        assert.equal(f.pane.style.width, '301px');
        assert.equal(saved.length - initialSaves, 1);
    } finally { await f.win.uiManager?.dispose(); f.close(); }
});
