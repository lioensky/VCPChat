import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMiddleClickHandler } from '../modules/renderer/middleClickHandler.js';

test('middle-click owner removes document capture listeners during dispose', () => {
    const dom = new JSDOM('<main id="chat"><article id="message" class="message-item"></article></main>');
    const previous = { window: globalThis.window, document: globalThis.document };
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    const documentListeners = new Map();
    const originalAdd = dom.window.document.addEventListener.bind(dom.window.document);
    const originalRemove = dom.window.document.removeEventListener.bind(dom.window.document);
    dom.window.document.addEventListener = (type, listener, options) => {
        if (type === 'mouseup' || type === 'mouseleave' || type === 'mousemove') {
            if (!documentListeners.has(type)) documentListeners.set(type, new Set());
            documentListeners.get(type).add(listener);
        }
        return originalAdd(type, listener, options);
    };
    dom.window.document.removeEventListener = (type, listener, options) => {
        documentListeners.get(type)?.delete(listener);
        return originalRemove(type, listener, options);
    };
    try {
        const chatMessagesDiv = dom.window.document.getElementById('chat');
        const messageItem = dom.window.document.getElementById('message');
        const owner = createMiddleClickHandler();
        owner.initialize({ chatMessagesDiv, uiHelper: {} }, {});
        owner.startAdvancedMiddleClickTimer(
            { clientX: 0, clientY: 0 },
            messageItem,
            { id: 'message-1', content: 'done', isThinking: false },
            { middleClickAdvancedDelay: 10_000 },
        );
        assert.equal(documentListeners.get('mouseup')?.size, 1);
        assert.equal(documentListeners.get('mouseleave')?.size, 1);

        owner.dispose();

        assert.equal(documentListeners.get('mouseup')?.size, 0);
        assert.equal(documentListeners.get('mouseleave')?.size, 0);
        assert.equal(documentListeners.get('mousemove')?.size || 0, 0);
        assert.deepEqual(owner.getMiddleClickState(), {
            activeTimers: 0,
            gridVisible: false,
            currentSelection: '',
            advancedModeActive: false,
            isDeletingMessage: false,
            freezeGridCancellation: false,
            toastFunctionModified: false,
        });
    } finally {
        globalThis.window = previous.window;
        globalThis.document = previous.document;
        dom.window.close();
    }
});
