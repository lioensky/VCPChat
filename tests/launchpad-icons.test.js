const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { LaunchpadIcons, LAUNCHPAD_ICON_ACCENTS } = require('../modules/ui-system/next-shell/launchpad-icons.js');
const { paintLaunchpadIcon } = require('../modules/ui-system/next-shell/launchpad-icon-art.js');
const { LaunchpadController } = require('../modules/ui-system/next-shell/launchpad-controller.js');

function fixture() {
    const dom = new JSDOM('<body><div id="nextUiAppGrid"></div><button><span></span></button>', { pretendToBeVisual: true });
    const w = dom.window;
    const frames = new Map();
    let id = 0;
    w.requestAnimationFrame = fn => { frames.set(++id, fn); return id; };
    w.cancelAnimationFrame = key => frames.delete(key);
    const motion = new w.EventTarget();
    motion.matches = false;
    w.matchMedia = () => motion;
    const context = new Proxy({
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} })
    }, { get: (target, key) => target[key] || (() => {}) });
    w.HTMLCanvasElement.prototype.getContext = () => context;
    const icons = new LaunchpadIcons({ document: w.document, paint: paintLaunchpadIcon });
    const button = w.document.querySelector('button');
    const host = button.firstChild;
    let now = 0;
    const step = () => {
        now += 16;
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach(fn => fn(now));
    };
    return { dom, w, frames, motion, icons, button, host, step, context };
}

test('all built-in artwork paints static and animated frames; unknown icons retain fallback', () => {
    const f = fixture();
    for (const key of Object.keys(LAUNCHPAD_ICON_ACCENTS)) {
        const canvas = f.w.document.createElement('canvas');
        for (const time of [0, 0.5, 10]) {
            assert.doesNotThrow(() => paintLaunchpadIcon({
                canvas, c: f.context, data: [key, '', '', LAUNCHPAD_ICON_ACCENTS[key]],
                size: 224, energy: time ? 1 : 0, x: 0.5, y: -0.5, kick: 0.5
            }, time), key);
        }
    }
    f.host.textContent = 'fallback';
    assert.equal(f.icons.attach(f.button, f.host, 'unknown'), false);
    assert.equal(f.host.textContent, 'fallback');
    f.w.HTMLCanvasElement.prototype.getContext = () => null;
    assert.equal(f.icons.attach(f.button, f.host, 'notes'), false);
    assert.equal(f.host.textContent, 'fallback');
    f.icons.dispose();
    f.dom.window.close();
});

test('one scheduler idles, animates on focus, respects reduced motion and stops on deactivate/dispose', () => {
    const f = fixture();
    assert.equal(f.icons.attach(f.button, f.host, 'rag'), true);
    assert.equal(f.host.firstChild.getAttribute('aria-hidden'), 'true');
    assert.equal(f.frames.size, 0);
    f.icons.setActive(true);
    f.step();
    assert.equal(f.frames.size, 0, 'static desktop must idle');
    f.button.focus();
    f.step();
    assert.equal(f.frames.size, 1);
    f.button.dispatchEvent(new f.w.Event('pointerenter'));
    f.button.dispatchEvent(new f.w.Event('pointerleave'));
    f.step();
    assert.equal(f.frames.size, 1, 'pointer leave must not cancel keyboard focus');
    f.motion.matches = true;
    f.motion.dispatchEvent(new f.w.Event('change'));
    f.step();
    assert.equal(f.frames.size, 0);
    f.motion.matches = false;
    f.motion.dispatchEvent(new f.w.Event('change'));
    f.step();
    assert.equal(f.frames.size, 1);
    f.icons.setActive(false);
    assert.equal(f.frames.size, 0);
    f.icons.setActive(true);
    f.step();
    assert.equal(f.frames.size, 0);
    f.button.dispatchEvent(new f.w.Event('pointerenter'));
    f.step();
    f.icons.dispose();
    assert.equal(f.frames.size, 0);
    f.button.dispatchEvent(new f.w.Event('pointerenter'));
    assert.equal(f.frames.size, 0);
    f.dom.window.close();
});

test('controller disposes previous artwork synchronously and preserves activation during rerender', () => {
    const f = fixture();
    const owners = [];
    const controller = new LaunchpadController({
        document: f.w.document,
        getExternalApps: () => [{ id: 'notes', name: '<笔记>', icon: 'notes' }],
        createIcons: () => {
            const owner = { active: false, disposed: false, attach() {}, setActive(v) { this.active = v; }, dispose() { this.disposed = true; } };
            owners.push(owner);
            return owner;
        }
    });
    controller.mount();
    controller.setActive(true);
    controller.render();
    assert.equal(owners[0].disposed, true);
    assert.equal(owners[1].active, true);
    assert.equal(f.w.document.querySelector('#nextUiAppGrid button').textContent, '<笔记>');
    controller.dispose();
    assert.equal(owners[1].disposed, true);
    f.icons.dispose();
    f.dom.window.close();
});