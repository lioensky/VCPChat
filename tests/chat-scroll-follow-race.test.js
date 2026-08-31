import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

test('a pending agent-bubble scroll survives the previous user-bubble cleanup frame', () => {
    const dom = new JSDOM(
        '<!doctype html><div class="chat-messages-container"></div>',
        { runScripts: 'outside-only', url: 'https://vcpchat.local/' }
    );
    const { window } = dom;
    const frames = new Map();
    let nextFrameId = 1;

    window.requestAnimationFrame = callback => {
        const id = nextFrameId++;
        frames.set(id, callback);
        return id;
    };
    window.cancelAnimationFrame = id => frames.delete(id);

    const flushNextFrame = () => {
        const entry = frames.entries().next().value;
        assert.ok(entry, 'expected a queued animation frame');
        const [id, callback] = entry;
        frames.delete(id);
        callback(window.performance.now());
    };

    const container = window.document.querySelector('.chat-messages-container');
    let scrollHeight = 300;
    Object.defineProperties(container, {
        clientHeight: { configurable: true, get: () => 100 },
        scrollHeight: { configurable: true, get: () => scrollHeight },
        scrollTop: { configurable: true, writable: true, value: 100 },
    });

    window.eval(fs.readFileSync('modules/ui-helpers.js', 'utf8'));
    const ui = window.uiHelperFunctions;

    // 用户主动发送：即使此前离底部较远，也重新开启跟随并预约滚动。
    assert.equal(ui.scrollToBottom({ force: true }), true);
    flushNextFrame();
    assert.equal(container.scrollTop, 200);

    // 用户滚动的收尾帧尚未运行时，异步创建的 agent 气泡增高 DOM，
    // 并发出普通跟随请求。旧收尾帧不得把这个新请求判定为用户离底。
    scrollHeight = 360;
    assert.equal(ui.scrollToBottom(), true);
    flushNextFrame();
    flushNextFrame();

    assert.equal(container.scrollTop, 260);
    assert.equal(ui.captureChatScrollFollow().followBottom, true);

    flushNextFrame();
    dom.window.close();
});