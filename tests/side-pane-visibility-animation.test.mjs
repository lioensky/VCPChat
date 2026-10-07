import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneVisibility } from '../modules/ui-system/side-pane/side-pane-visibility.js';

function setup() {
    const dom = new JSDOM('<div id="host"><aside id="pane"></aside></div>', { pretendToBeVisual: true });
    const root = dom.window.document.getElementById('pane');
    const synced = [];
    const visibility = createSidePaneVisibility({ root, initialRatio: 0.45, onSync: v => synced.push(v) });
    const transitionEnd = () => {
        const event = new dom.window.Event('transitionend');
        event.propertyName = 'width';
        root.dispatchEvent(event);
    };
    const frame = () => new Promise(resolve => dom.window.requestAnimationFrame(() => resolve()));
    return { dom, root, visibility, transitionEnd, frame, synced };
}

test('reopening while the close animation runs ends expanded, not collapsed', async () => {
    const { root, visibility, transitionEnd, frame } = setup();
    visibility.sync(true, { animate: false });

    visibility.sync(false);
    await frame();
    visibility.sync(true);
    await frame();
    transitionEnd();

    assert.ok(root.classList.contains('active'));
    assert.ok(!root.classList.contains('collapsed'));
    assert.equal(root.getAttribute('aria-hidden'), null);
    assert.equal(visibility.isAnimating(), false);
    visibility.dispose();
});

test('a second open request during the open animation does not restart from zero width', async () => {
    const { root, visibility, frame } = setup();
    visibility.sync(false, { animate: false });

    visibility.sync(true);
    await frame();
    const midWidth = root.style.width;
    visibility.sync(true);

    assert.equal(root.style.width, midWidth);
    assert.notEqual(root.style.width, '0%');
    visibility.dispose();
});

test('closing while the open animation runs ends collapsed', async () => {
    const { root, visibility, transitionEnd, frame } = setup();
    visibility.sync(false, { animate: false });

    visibility.sync(true);
    await frame();
    visibility.sync(false);
    await frame();
    transitionEnd();

    assert.ok(root.classList.contains('collapsed'));
    assert.ok(!root.classList.contains('active'));
    assert.equal(root.getAttribute('aria-hidden'), 'true');
    visibility.dispose();
});
