import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('VCPUI Toast closes when clicking anywhere on the toast body without needing close button', async () => {
    const dom = new JSDOM('<!doctype html><html><body class="vcp-ui-scope"></body></html>', {
        url: 'https://vcpchat.local/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });

    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousCustomEvent = globalThis.CustomEvent;
    const previousEvent = globalThis.Event;

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.Event = dom.window.Event;

    try {
        const { default: VCPUI } = await import(`../modules/ui-system/vcp-ui.js?test=${Date.now()}`);

        const toastController = VCPUI.feedback.toast('可点击任意区域关闭的通知', {
            duration: 0,
            variant: 'info',
        });

        const toastElement = dom.window.document.querySelector('.vcp-ui-toast');
        assert.ok(toastElement, 'Toast 应该已挂载到 DOM 中');
        assert.equal(toastController.destroyed, false);

        const messageSpan = toastElement.querySelector('span:nth-child(2)');
        assert.ok(messageSpan, '应该存在消息内容文本节点');

        // 直接点击通知主体内部的消息文本，不点击关闭按钮
        messageSpan.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

        assert.equal(toastController.destroyed, true, '点击通知内部文字后，Toast 控制器应进入 destroyed 状态');
        assert.equal(dom.window.document.querySelector('.vcp-ui-toast'), null, '点击后通知应从 DOM 中移除');
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        globalThis.CustomEvent = previousCustomEvent;
        globalThis.Event = previousEvent;
        dom.window.close();
    }
});