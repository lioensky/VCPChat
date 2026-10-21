import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 工具气泡的 infinite 流光以气泡本身为单位做视口门控：不在滚动容器可视区内的气泡被加上
// 暂停 class，回到可视区移除；流式渲染新插入的气泡也要被观察到，被替换掉的气泡要被释放。

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createDom() {
    const dom = new JSDOM(`<!doctype html>
        <div class="chat-messages-container" id="scroll">
            <div class="chat-messages" id="chat">
                <div class="message-item" id="m1"><div class="md-content"><div class="vcp-tool-use-bubble" id="b1"></div></div></div>
                <div class="message-item" id="m2"><div class="md-content"><div class="vcp-tool-use-bubble" id="b2"></div><span class="user-clicked-button-bubble" id="u1"></span></div></div>
            </div>
        </div>`);
    const { window } = dom;
    const observers = [];
    window.IntersectionObserver = class {
        constructor(callback, options) {
            this.callback = callback;
            this.options = options;
            this.targets = new Set();
            this.disconnected = false;
            observers.push(this);
        }
        observe(target) { this.targets.add(target); }
        unobserve(target) { this.targets.delete(target); }
        disconnect() { this.targets.clear(); this.disconnected = true; }
        emit(pairs) {
            this.callback(pairs.map(([target, isIntersecting]) => ({ target, isIntersecting })), this);
        }
    };
    return { dom, window, observers };
}

// MutationObserver 回调走微任务，释放走 setTimeout(0)；留出两个宏任务的余量，避免冷启动时抖动。
const flush = async () => {
    for (let i = 0; i < 2; i += 1) await new Promise(resolve => setTimeout(resolve, 20));
};

async function loadGate() {
    const module = await import('../modules/renderer/decorativeAnimationGate.js');
    return module.createDecorativeAnimationGate;
}

test('existing bubbles are observed at attach and toggled by intersection reports', async () => {
    const createDecorativeAnimationGate = await loadGate();
    const { dom, window, observers } = createDom();
    try {
        const gate = createDecorativeAnimationGate();
        const scroll = window.document.getElementById('scroll');
        assert.equal(gate.attach(scroll), true);
        assert.equal(observers.length, 1);
        const io = observers[0];
        assert.equal(io.options.root, scroll);
        assert.equal(io.options.rootMargin, '0px');
        assert.equal(io.targets.size, 3, 'two tool bubbles and one clicked-button bubble');
        assert.equal(gate.snapshot().tracked, 3);
        assert.equal(gate.snapshot().offscreen, 0, 'nothing is paused before the observer reports');

        const b1 = window.document.getElementById('b1');
        const b2 = window.document.getElementById('b2');
        io.emit([[b1, true], [b2, false]]);
        assert.equal(b1.classList.contains('vcp-anim-offscreen'), false);
        assert.equal(b2.classList.contains('vcp-anim-offscreen'), true);
        assert.equal(gate.snapshot().offscreen, 1);

        io.emit([[b2, true]]);
        assert.equal(b2.classList.contains('vcp-anim-offscreen'), false, 'scrolling back into view resumes the flow');
    } finally {
        dom.window.close();
    }
});

test('bubbles inserted by streaming re-renders are picked up and replaced ones are released', async () => {
    const createDecorativeAnimationGate = await loadGate();
    const { dom, window, observers } = createDom();
    try {
        const gate = createDecorativeAnimationGate();
        const scroll = window.document.getElementById('scroll');
        gate.attach(scroll);
        const io = observers[0];
        const m2Content = window.document.querySelector('#m2 .md-content');
        const oldBubble = window.document.getElementById('b2');
        io.emit([[oldBubble, false]]);
        assert.equal(oldBubble.classList.contains('vcp-anim-offscreen'), true);

        m2Content.innerHTML = '<p>text</p><div class="vcp-tool-use-bubble" id="b3"></div><div class="vcp-tool-use-bubble" id="b4"></div>';
        await flush();
        const b3 = window.document.getElementById('b3');
        const b4 = window.document.getElementById('b4');
        assert.ok(io.targets.has(b3) && io.targets.has(b4), 'new bubbles are observed');
        assert.equal(io.targets.has(oldBubble), false, 'the replaced bubble is no longer observed');
        assert.equal(oldBubble.classList.contains('vcp-anim-offscreen'), false, 'release clears the pause class');
        assert.equal(gate.snapshot().tracked, 3, 'b1 + b3 + b4');

        gate.detach();
        assert.equal(io.disconnected, true);
        assert.equal(gate.snapshot().attached, false);
        assert.equal(gate.snapshot().tracked, 0);
    } finally {
        dom.window.close();
    }
});

test('a pre that becomes a tool bubble after insertion is observed, and one that stops matching is released', async () => {
    // 真实渲染流程里 <pre> 先入树，稍后的 prettify 才补上 vcp-tool-use-bubble；门控必须靠 class 变化发现它。
    const createDecorativeAnimationGate = await loadGate();
    const { dom, window, observers } = createDom();
    try {
        const gate = createDecorativeAnimationGate();
        const scroll = window.document.getElementById('scroll');
        gate.attach(scroll);
        const io = observers[0];
        const m1Content = window.document.querySelector('#m1 .md-content');
        const pre = window.document.createElement('pre');
        pre.id = 'late';
        pre.textContent = '<<<[TOOL_REQUEST]>>>';
        m1Content.appendChild(pre);
        await flush();
        assert.equal(io.targets.has(pre), false, 'a plain pre is not a bubble');

        pre.classList.add('vcp-tool-use-bubble');
        await flush();
        assert.equal(io.targets.has(pre), true, 'the late class promotes the pre into the gate');
        assert.equal(gate.snapshot().tracked, 4);

        io.emit([[pre, false]]);
        assert.equal(pre.classList.contains('vcp-anim-offscreen'), true);
        await flush();
        assert.equal(io.targets.has(pre), true, 'the gate toggling its own class does not untrack or re-track');
        assert.equal(gate.snapshot().tracked, 4);

        pre.classList.remove('vcp-tool-use-bubble');
        await flush();
        assert.equal(io.targets.has(pre), false, 'no longer a bubble: released');
        assert.equal(pre.classList.contains('vcp-anim-offscreen'), false, 'release clears the pause class');
        assert.equal(gate.snapshot().tracked, 3);
    } finally {
        dom.window.close();
    }
});

test('attach is idempotent and tolerates environments without IntersectionObserver', async () => {
    const createDecorativeAnimationGate = await loadGate();
    const { dom, window, observers } = createDom();
    try {
        const gate = createDecorativeAnimationGate();
        const scroll = window.document.getElementById('scroll');
        gate.attach(scroll);
        gate.attach(scroll);
        assert.equal(observers.length, 2);
        assert.equal(observers[0].disconnected, true, 're-attach releases the previous observer');
        assert.equal(observers[1].targets.size, 3);
        gate.detach();

        delete window.IntersectionObserver;
        assert.equal(gate.attach(scroll), false);
        assert.equal(gate.snapshot().attached, false);
    } finally {
        dom.window.close();
    }
});

test('the stylesheet carries the pause barrier and the renderer wires the gate', () => {
    const css = fs.readFileSync(path.join(repoRoot, 'styles/messageRenderer.css'), 'utf8');
    const barrier = css.indexOf('.vcp-anim-offscreen *::after {');
    assert.ok(barrier > 0, 'barrier selector present');
    assert.match(css.slice(barrier, barrier + 200), /animation-play-state:\s*paused\s*!important/);
    assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*\.vcp-tool-use-bubble,/, 'decorative flows are disabled under reduced motion');

    // 默认（full）保留上游原版：四条流光与用户消息里的按钮气泡都是 infinite 常驻
    assert.match(css, /animation: vcp-bubble-background-flow-kf 2s ease-in-out infinite;/);
    assert.match(css, /animation: vcp-bubble-border-flow-kf 2s linear infinite;/);
    assert.match(css, /animation: vcp-toolname-color-flow-kf 2s linear infinite;/);
    assert.match(css, /animation: vcp-icon-rotate 2s linear infinite;/);
    assert.match(css, /animation: vcp-bubble-background-flow-kf 10s ease-in-out infinite;/, 'clicked-button bubbles in user messages keep the original flow');
    assert.equal((css.match(/data-vcp-tool-bubble-motion="full"/g) || []).length, 0, 'full is the plain stylesheet, not an extra rule');
    // the Appearance Studio switch opts out: once = one cycle on finished content (streaming keeps flowing), steady = infinite at 10 fps
    assert.match(css, /html\[data-vcp-tool-bubble-motion="once"\] \.user-clicked-button-bubble \{\s*animation-iteration-count: 1;\s*\}/);
    assert.match(css, /html\[data-vcp-tool-bubble-motion="once"\] \.message-item:is\(\.streaming, \.thinking\) \.vcp-tool-use-bubble \.vcp-tool-name-highlight \{\s*animation-iteration-count: infinite;\s*\}/, 'streaming messages keep flowing in play-once mode');
    assert.match(css, /html\[data-vcp-tool-bubble-motion="steady"\] \.vcp-tool-use-bubble \.vcp-tool-name-highlight \{\s*animation-timing-function: steps\(20\);\s*\}/);

    const renderer = fs.readFileSync(path.join(repoRoot, 'modules/messageRenderer.js'), 'utf8');
    assert.match(renderer, /import \{ createDecorativeAnimationGate \} from '\.\/renderer\/decorativeAnimationGate\.js';/);
    assert.match(renderer, /decorativeAnimationGate\.attach\(scrollContainer \|\| mainRendererReferences\.chatMessagesDiv\)/);
    assert.match(renderer, /decorativeAnimationGate\.detach\?\.\(\)/);
});
