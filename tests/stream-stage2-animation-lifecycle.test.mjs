import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

test('inline animation APIs survive deferred frames and remain content-owned', async () => {
    const dom = new JSDOM('<body></body>', { runScripts: 'dangerously', pretendToBeVisual: true });
    const previous = Object.fromEntries(['window', 'document', 'Node'].map(key => [key, globalThis[key]]));
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
    const frames = [];
    const registrations = [];
    const threeRegistrations = [];
    const instances = [];
    const originalAnime = options => {
        const instance = { animatables: [{ target: options.targets }], pause() { this.paused = true; } };
        instances.push(instance);
        return instance;
    };
    originalAnime.remove = () => {};
    dom.window.anime = originalAnime;
    dom.window.THREE = {
        WebGLRenderer: class {
            constructor() { this.domElement = dom.window.document.createElement('canvas'); }
            render() { this.renderCalls = (this.renderCalls || 0) + 1; }
            setAnimationLoop(callback) { this.nativeLoop = callback; }
            dispose() { this.disposed = true; }
        },
    };
    const optimizer = {
        createPausableRAF: item => callback => { frames.push({ item, callback }); return frames.length; },
        registerAnimeInstance: (item, instance) => registrations.push({ item, instance }),
        registerThreeContext: (item, context) => threeRegistrations.push({ item, context }),
    };
    try {
        const { processAnimationsInContent, cleanupAnimationsInContent } = await import('../modules/renderer/animation.js');
        const contents = [];
        for (const id of ['a', 'b']) {
            const item = dom.window.document.createElement('article');
            item.className = 'message-item';
            item.id = id;
            item.innerHTML = `<div class="md-content"><span></span><script>
                const node = container.querySelector('span');
                window.requestAnimationFrame(function frame() {
                    node.dataset.frames = String(Number(node.dataset.frames || 0) + 1);
                    if (Number(node.dataset.frames) < 2) globalThis.requestAnimationFrame(frame);
                    window.anime({ targets: node });
                });
                const renderer = new window.THREE.WebGLRenderer();
            </script></div>`.replace('<', '<');
            dom.window.document.body.append(item);
            const content = item.querySelector('.md-content');
            contents.push(content);
            processAnimationsInContent(content, optimizer);
        }
        await new Promise(resolve => dom.window.setTimeout(resolve, 15));
        assert.equal(Object.keys(dom.window).some(key => /^_vcp_(raf|timer|doc|container|pixi)_/.test(key)), false);
        while (frames.length) frames.shift().callback(16);
        assert.deepEqual(contents.map(content => content.querySelector('span').dataset.frames), ['2', '2']);
        assert.deepEqual(registrations.map(value => value.item.id), ['a', 'b', 'a', 'b']);
        assert.equal(dom.window.anime, originalAnime, 'the global anime function must remain untouched');
        assert.equal(threeRegistrations.length, 2);
        assert.equal(threeRegistrations.some(value => value.context.renderer._vcpMutationObserver), false);
        const three = threeRegistrations[0].context;
        let firstCalls = 0;
        let laterCalls = 0;
        const firstLoop = () => { firstCalls++; };
        const laterLoop = () => { laterCalls++; };
        three.renderer.setAnimationLoop(firstLoop);
        three.renderer.nativeLoop();
        assert.equal(firstCalls, 1);
        three.isPaused = true;
        three.pause();
        assert.equal(three.renderer.nativeLoop, null);
        three.renderer.setAnimationLoop(laterLoop);
        assert.equal(three.renderer.nativeLoop, null);
        three.isPaused = false;
        three.resume();
        const capturedLoop = three.renderer.nativeLoop;
        capturedLoop();
        assert.equal(laterCalls, 1);
        three.renderer.render({ traverse() {} }, {});
        assert.equal(three.renderer.renderCalls, 1, 'offscreen canvas belongs to its connected content root');
        cleanupAnimationsInContent(contents[0]);
        capturedLoop();
        assert.equal(laterCalls, 1, 'a captured native loop must be inert after mount revocation');
        assert.equal(instances[0].paused, true);
        assert.equal(instances[1].paused, undefined);
        assert.equal(threeRegistrations[0].context.renderer.disposed, true);
        assert.equal(threeRegistrations[0].context.renderer.nativeLoop, null);
        assert.equal(threeRegistrations[1].context.renderer.disposed, undefined);
        cleanupAnimationsInContent(contents[1]);
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
        dom.window.close();
    }
});