import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSideChatPersistence } from '../modules/renderer/side-chat/persistence.js';

function fixture(loadHistory) {
    const dom = new JSDOM('<textarea disabled></textarea><span id="status"></span><button id="badge" hidden></button>');
    const doc = dom.window.document, status = doc.getElementById('status');
    const descriptor = { id: 'side', parent: { itemId: 'agent', topicId: 'p' }, child: { itemId: 'agent', topicId: 'c' }, references: [] };
    const store = { currentDescriptor: descriptor, references: [], isHistoryLoaded: false, isDisposed: false };
    const emptyCalls = [];
    const owner = createSideChatPersistence({ store, descriptor, doc, textarea: doc.querySelector('textarea'), statusText: status,
        persistenceBadge: doc.getElementById('badge'), repository: {}, getConversation: () => null,
        getSurface: () => ({ loadHistory }), saveDraft: () => ({ success: true }),
        updateStatus(text, type) { status.textContent = type === 'error' ? text : ''; },
        updateComposerState() {}, updateEmptyState: (options) => emptyCalls.push(options || {}),
        chatCapabilities: { uiHelper: { showToastNotification() {} } } });
    return { dom, status, store, owner, emptyCalls };
}

test('the side chat intro stays hidden while history loads, and a failed load can be retried from the keyboard', async () => {
    let attempts = 0;
    const f = fixture(async () => { attempts++; if (attempts === 1) throw new Error('disk busy'); return { success: true }; });
    try {
        await f.owner.loadHistoryFn().catch(() => {});
        assert.deepEqual(f.emptyCalls[0], { historyPending: true }, 'the intro is hidden as soon as loading starts');
        assert.match(f.status.textContent, /加载历史失败/);
        assert.equal(f.status.getAttribute('role'), 'button');
        assert.equal(f.status.tabIndex, 0);

        f.status.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        for (let i = 0; i < 20 && !f.store.isHistoryLoaded; i++) await new Promise(r => setTimeout(r, 5));
        assert.equal(attempts, 2);
        assert.equal(f.store.isHistoryLoaded, true);
        assert.equal(f.status.hasAttribute('role'), false);
    } finally { f.owner.dispose(); f.dom.window.close(); }
});
