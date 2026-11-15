import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createVisibilityOptimizer } from '../modules/renderer/visibilityOptimizer.js';

async function fixture(source) {
    const dom = new JSDOM('<main><article class="message-item"><div class="md-content"></div></article></main>', {
        runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://vcpchat.local/',
    });
    const keys = ['window', 'document', 'Node', 'MutationObserver', 'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const previous = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
    Object.assign(globalThis, {
        window: dom.window, document: dom.window.document, Node: dom.window.Node,
        MutationObserver: dom.window.MutationObserver,
        IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    });
    const root = dom.window.document.querySelector('main');
    const item = root.querySelector('article');
    item.getAnimations = () => [];
    root.getBoundingClientRect = () => ({ top: 0, bottom: 500 });
    item.getBoundingClientRect = () => ({ top: 0, bottom: 100 });
    const optimizer = createVisibilityOptimizer();
    optimizer.initializeVisibilityOptimizer(root);
    const animation = await import('../modules/renderer/animation.js');
    const content = item.querySelector('.md-content');
    content.innerHTML = source;
    return { dom, root, item, content, optimizer, ...animation, close() {
        animation.cleanupAnimationsInContent(content);
        optimizer.destroyVisibilityOptimizer();
        dom.window.close();
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
    } };
}

test('body cleanup destroys the underlying Pixi application exactly once', async () => {
    const f = await fixture('<script>window.app = new PIXI.Application();</script>');
    let destroys = 0;
    f.dom.window.PIXI = { Application: class {
        constructor() { this.canvas = f.dom.window.document.createElement('canvas'); }
        start() {} stop() {}
        destroy() { destroys++; }
    } };
    try {
        f.processAnimationsInContent(f.content, f.optimizer);
        f.cleanupAnimationsInContent(f.content);
        f.cleanupAnimationsInContent(f.content);
        assert.equal(f.item.isConnected, true);
        assert.equal(destroys, 1);
    } finally { f.close(); }
});

test('body cleanup cancels old timers while the shell stays connected', async () => {
    const f = await fixture('<script>setTimeout(() => { window.oldWrites = (window.oldWrites || 0) + 1; }, 10);</script>');
    try {
        f.processAnimationsInContent(f.content, f.optimizer);
        f.cleanupAnimationsInContent(f.content);
        f.content.textContent = 'replacement';
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(f.item.isConnected, true);
        assert.equal(f.dom.window.oldWrites || 0, 0);
    } finally { f.close(); }
});

test('paused frames and timers have paired virtual cancellation and no polling', async () => {
    const f = await fixture('');
    try {
        f.optimizer.pauseMessageAnimations(f.item);
        const mount = f.processAnimationsInContent(f.content, f.optimizer);
        let writes = 0;
        const frame = mount.api.requestAnimationFrame(() => writes++);
        const timer = mount.api.setTimeout(() => writes++, 1);
        assert.notEqual(frame, timer);
        mount.api.cancelAnimationFrame(frame);
        mount.api.clearInterval(timer);
        assert.equal(mount.getStats().tasks, 0);
        f.optimizer.resumeMessageAnimations(f.item);
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(writes, 0);
        f.optimizer.pauseMessageAnimations(f.item);
        mount.api.requestAnimationFrame(() => writes++);
        assert.equal(mount.getStats().tasks, 1);
        f.cleanupAnimationsInContent(f.content);
        f.optimizer.resumeMessageAnimations(f.item);
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(writes, 0);
        assert.deepEqual(mount.getStats(), { state: 'revoked', tasks: 0, resources: 0 });
    } finally { f.close(); }
});

test('repeat processing retains a live controller and revision replacement revokes it', async () => {
    const f = await fixture('');
    try {
        const first = f.processAnimationsInContent(f.content, f.optimizer);
        assert.equal(f.processAnimationsInContent(f.content, f.optimizer), first);
        let releases = 0;
        first.own(() => { throw new Error('controlled release failure'); });
        first.own(() => releases++);
        first.api.setTimeout(() => { throw new Error('old callback'); }, 10);
        f.content._vcpRenderRevision = 2;
        const second = f.processAnimationsInContent(f.content, f.optimizer);
        assert.notEqual(second, first);
        assert.equal(first.state, 'revoked');
        assert.equal(releases, 1);
        first.revoke();
        assert.equal(releases, 1);
        assert.equal(first.api.requestAnimationFrame(() => {}), 0);
    } finally { f.close(); }
});

test('canceled native frames cannot write after resume or body revocation', async () => {
    const f = await fixture('');
    const frames = [];
    const optimizer = { createPausableRAF: () => callback => { frames.push(callback); return frames.length; } };
    try {
        const mount = f.processAnimationsInContent(f.content, optimizer);
        let writes = 0;
        mount.api.requestAnimationFrame(() => writes++);
        mount.pause();
        mount.resume();
        frames[0](16);
        assert.equal(writes, 0);
        frames[1](32);
        assert.equal(writes, 1);
        mount.api.requestAnimationFrame(() => writes++);
        f.cleanupAnimationsInContent(f.content);
        frames[2](48);
        assert.equal(writes, 1);
    } finally { f.close(); }
});

test('async Pixi init completing after cleanup destroys without registering again', async () => {
    const f = await fixture('<script>window.app = new PIXI.Application(); window.init = app.init();</script>');
    let finish;
    let destroys = 0;
    let starts = 0;
    f.dom.window.PIXI = { Application: class {
        init() { return new Promise(resolve => { finish = resolve; }); }
        start() { starts++; } stop() {}
        destroy() { destroys++; }
    } };
    try {
        f.processAnimationsInContent(f.content, f.optimizer);
        f.cleanupAnimationsInContent(f.content);
        f.content._vcpRenderRevision = 2;
        f.content.textContent = 'new body';
        const fresh = f.processAnimationsInContent(f.content, f.optimizer);
        finish();
        await f.dom.window.init;
        f.optimizer.resumeMessageAnimations(f.item);
        assert.equal(destroys, 1);
        assert.equal(starts, 0);
        assert.equal(fresh.state, 'running');
    } finally { f.close(); }
});

test('dependency subscribers wait for one real load and revoked subscribers stay inert', async () => {
    const f = await fixture('<script src="vendor/three.min.js"></script><script>container.dataset.ready = "yes";</script>');
    try {
        f.processAnimationsInContent(f.content, f.optimizer);
        const other = f.content.cloneNode(false);
        other.innerHTML = '<script src="vendor/three.min.js"></script><script>container.dataset.ready = "yes";</script>';
        f.item.append(other);
        const second = f.processAnimationsInContent(other, f.optimizer);
        const scripts = f.dom.window.document.head.querySelectorAll('script[src]');
        assert.equal(scripts.length, 1);
        assert.equal(other.dataset.ready, undefined);
        f.cleanupAnimationsInContent(f.content);
        f.dom.window.THREE = {};
        scripts[0].dispatchEvent(new f.dom.window.Event('load'));
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(f.content.dataset.ready, undefined);
        assert.equal(other.dataset.ready, 'yes');
        second.revoke();
    } finally { f.close(); }
});

test('failed and unknown dependencies stop execution and failed loads may retry', async () => {
    const f = await fixture('<script src="vendor/three.min.js"></script><script>window.badRun = true;</script>');
    try {
        f.processAnimationsInContent(f.content, f.optimizer);
        f.dom.window.document.head.querySelector('script[src]').dispatchEvent(new f.dom.window.Event('error'));
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(f.dom.window.badRun, undefined);
        f.cleanupAnimationsInContent(f.content);
        f.content.innerHTML = '<script src="https://example.invalid/arbitrary.js"></script><script>window.badRun = true;</script>';
        f.processAnimationsInContent(f.content, f.optimizer);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(f.dom.window.document.head.querySelectorAll('script[src]').length, 0);
        assert.equal(f.dom.window.badRun, undefined);
        f.cleanupAnimationsInContent(f.content);
        f.content.innerHTML = '<script src="vendor/three.min.js"></script>';
        f.processAnimationsInContent(f.content, f.optimizer);
        assert.equal(f.dom.window.document.head.querySelectorAll('script[src]').length, 1);
        f.dom.window.document.head.querySelector('script[src]').dispatchEvent(new f.dom.window.Event('error'));
        await Promise.resolve();
    } finally { f.close(); }
});

test('window and document listeners, observers and microtasks retire with their body', async () => {
    const f = await fixture(`<script>
        window.calls = 0;
        function hit() { window.calls++; }
        addEventListener('probe', hit);
        document.addEventListener('probe', hit);
        window.observer = new MutationObserver(hit);
        observer.observe(container, { childList: true });
        queueMicrotask(hit);
    </script>`);
    try {
        f.processAnimationsInContent(f.content, f.optimizer);
        f.cleanupAnimationsInContent(f.content);
        f.dom.window.dispatchEvent(new f.dom.window.Event('probe'));
        f.dom.window.document.dispatchEvent(new f.dom.window.Event('probe'));
        f.content.textContent = 'new';
        await Promise.resolve();
        assert.equal(f.dom.window.calls, 0);
    } finally { f.close(); }
});

test('Three cleanup covers multiple scenes even after explicit renderer disposal', async () => {
    const f = await fixture('<script>window.renderer = new THREE.WebGLRenderer(); window.target = new THREE.WebGLRenderTarget();</script>');
    let rendererDisposals = 0;
    let targetDisposals = 0;
    let resourceDisposals = 0;
    f.dom.window.THREE = {
        WebGLRenderer: class {
            render() {} setAnimationLoop() {}
            dispose() { rendererDisposals++; }
        },
        WebGLRenderTarget: class { dispose() { targetDisposals++; } },
    };
    const resource = () => ({ dispose() { resourceDisposals++; } });
    const texture = { ...resource(), isTexture: true };
    try {
        f.processAnimationsInContent(f.content, f.optimizer);
        const renderer = f.dom.window.renderer;
        for (let index = 0; index < 2; index++) {
            const object = { geometry: resource(), material: { ...resource(), map: texture } };
            renderer.render({ traverse: callback => callback(object) }, {});
        }
        renderer.dispose();
        f.cleanupAnimationsInContent(f.content);
        assert.equal(rendererDisposals, 1);
        assert.equal(targetDisposals, 1);
        assert.equal(resourceDisposals, 5);
    } finally { f.close(); }
});

test('optimizer teardown revokes mounted resources even when DOM remains connected', async () => {
    const f = await fixture('<script>setInterval(() => { window.oldWrites = true; }, 5);</script>');
    try {
        const mount = f.processAnimationsInContent(f.content, f.optimizer);
        f.optimizer.destroyVisibilityOptimizer();
        assert.equal(f.content.isConnected, true);
        assert.deepEqual(mount.getStats(), { state: 'revoked', tasks: 0, resources: 0 });
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(f.dom.window.oldWrites, undefined);
    } finally { f.close(); }
});

test('classic script scope, metadata and explicit globals survive without document mutation', async () => {
    const f = await fixture(`<span></span><script id="first">
        var privateValue = 7;
        window.sharedValue = privateValue;
        window.metadata = document.currentScript.id;
        window.writeUnchanged = document.write === window.originalWrite;
        document.write('blocked');
        throw new Error('controlled inline error');
    </script><script>
        window.secondValue = window.sharedValue + 1;
        window.localValue = typeof privateValue;
    </script><script type="module">window.moduleRan = true;</script>`);
    const originalWrite = f.dom.window.document.write;
    f.dom.window.originalWrite = originalWrite;
    try {
        f.processAnimationsInContent(f.content, f.optimizer);
        assert.equal(f.dom.window.metadata, 'first');
        assert.equal(f.dom.window.secondValue, 8);
        assert.equal(f.dom.window.localValue, 'undefined');
        assert.equal(f.dom.window.moduleRan, undefined);
        assert.equal(f.dom.window.document.write, originalWrite);
        assert.equal(Object.keys(f.dom.window).some(key => /^_vcp_container_/.test(key)), false);
    } finally { f.close(); }
});

test('independent body roots with the same message ID revoke independently', async () => {
    const f = await fixture('');
    try {
        const item = f.item.cloneNode(true);
        f.item.dataset.messageId = item.dataset.messageId = 'same';
        f.root.append(item);
        f.optimizer.observeMessage(item);
        item.getAnimations = () => [];
        const other = item.querySelector('.md-content');
        const first = f.processAnimationsInContent(f.content, f.optimizer);
        const second = f.processAnimationsInContent(other, f.optimizer);
        let firstCalls = 0;
        let secondCalls = 0;
        first.api.setTimeout(() => firstCalls++, 1);
        second.api.setTimeout(() => secondCalls++, 1);
        f.cleanupAnimationsInContent(f.content);
        await new Promise(resolve => setTimeout(resolve, 15));
        assert.equal(firstCalls, 0);
        assert.equal(secondCalls, 1);
        assert.equal(second.state, 'running');
        second.revoke();
    } finally { f.close(); }
});

test('dependency timeout settles all subscribers and late load cannot run them', async () => {
    const f = await fixture('<script src="vendor/three.min.js"></script><script>window.timeoutRun = true;</script>');
    const nativeTimeout = f.dom.window.setTimeout;
    let timeout;
    f.dom.window.setTimeout = (callback, delay, ...args) => {
        if (delay === 15000) { timeout = callback; return 900001; }
        return nativeTimeout.call(f.dom.window, callback, delay, ...args);
    };
    try {
        f.processAnimationsInContent(f.content, f.optimizer);
        const script = f.dom.window.document.head.querySelector('script[src]');
        timeout();
        f.dom.window.THREE = {};
        script.dispatchEvent(new f.dom.window.Event('load'));
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(f.dom.window.timeoutRun, undefined);
        assert.equal(script.isConnected, false);
    } finally { f.dom.window.setTimeout = nativeTimeout; f.close(); }
});

test('managed requests, URLs and workers release independently despite a throwing disposer', async () => {
    const f = await fixture('');
    const realm = f.dom.window;
    let signal;
    let finish;
    let terminated = 0;
    const revoked = [];
    realm.fetch = (_input, options) => {
        signal = options.signal;
        return new Promise(resolve => { finish = resolve; });
    };
    realm.URL.createObjectURL = () => 'blob:managed';
    realm.URL.revokeObjectURL = url => revoked.push(url);
    realm.Worker = class { terminate() { terminated++; } };
    try {
        const mount = f.processAnimationsInContent(f.content, f.optimizer);
        const request = mount.api.fetch('/sample');
        mount.api.URL.createObjectURL({});
        new mount.api.Worker('worker.js');
        mount.own(() => { throw new Error('controlled disposer'); });
        f.cleanupAnimationsInContent(f.content);
        assert.equal(signal.aborted, true);
        assert.deepEqual(revoked, ['blob:managed']);
        assert.equal(terminated, 1);
        finish({});
        await request;
        assert.equal(mount.getStats().resources, 0);
    } finally { f.close(); }
});

test('different Surface schedulers sharing one realm destroy only their own mount', async () => {
    const f = await fixture('');
    const root = f.dom.window.document.createElement('section');
    root.innerHTML = '<article class="message-item" data-message-id="same"><div class="md-content"></div></article>';
    f.dom.window.document.body.append(root);
    const otherOwner = createVisibilityOptimizer();
    otherOwner.initializeVisibilityOptimizer(root);
    const otherItem = root.querySelector('article');
    otherItem.getAnimations = () => [];
    try {
        const first = f.processAnimationsInContent(f.content, f.optimizer);
        const second = f.processAnimationsInContent(otherItem.querySelector('.md-content'), otherOwner);
        let writes = 0;
        second.api.setTimeout(() => writes++, 1);
        f.optimizer.destroyVisibilityOptimizer();
        assert.equal(first.state, 'revoked');
        await new Promise(resolve => setTimeout(resolve, 15));
        assert.equal(writes, 1);
        assert.equal(second.state, 'running');
    } finally { otherOwner.destroyVisibilityOptimizer(); f.close(); }
});

test('interval resume restarts a single delay rather than replaying missed ticks', async () => {
    const f = await fixture('');
    try {
        const mount = f.processAnimationsInContent(f.content, f.optimizer);
        mount.pause();
        let ticks = 0;
        mount.api.setInterval(() => ticks++, 20);
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(ticks, 0);
        mount.resume();
        assert.equal(ticks, 0, 'resume must not synchronously replay paused ticks');
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(ticks, 1);
        mount.revoke();
    } finally { f.close(); }
});

test('scheduler frame cancellation removes paused entries and never revives an old registration', async () => {
    const f = await fixture('');
    try {
        f.optimizer.pauseMessageAnimations(f.item);
        const raf = f.optimizer.createPausableRAF(f.item);
        let calls = 0;
        const id = raf(() => calls++);
        raf.cancel(id);
        f.optimizer.resumeMessageAnimations(f.item);
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(calls, 0);
        const oldRAF = f.optimizer.createPausableRAF(f.item);
        f.optimizer.unobserveMessage(f.item);
        f.optimizer.observeMessage(f.item);
        assert.equal(oldRAF(() => calls++), 0);
    } finally { f.close(); }
});