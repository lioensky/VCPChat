import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createContextCompactionService } from '../modules/chat/contextCompactionService.js';
import { createChatHistoryMutationAuthority } from '../modules/chat/chatHistoryMutationAuthority.js';
import { effectiveContextHistory } from '../modules/chat/contextCompactionState.js';
import { createImageHandler } from '../modules/renderer/imageHandler.js';

test('压缩只截取发送上下文，预览收集已渲染历史，重新打开才刷新列表', async t => {
    const picture = id => ({ id, role: 'user', content: `<img src="/${id}.png">` });
    let saved = [picture('before')];
    const authority = createChatHistoryMutationAuthority({ repository: {
        getHistory: async () => structuredClone(saved),
        saveHistory: async (_id, _type, _topic, history) => {
            saved = structuredClone(history);
            return { success: true };
        }
    } });
    const service = createContextCompactionService({
        historyMutationAuthority: authority,
        request: async () => '<context_checkpoint>\n图片已讨论\n</context_checkpoint>'
    });
    t.after(() => service.dispose());
    await service.compact({
        scope: { itemId: 'agent', itemType: 'agent', topicId: 'topic' },
        settings: { enableContextCompaction: true, contextCompactionModel: 'fixture' },
        history: structuredClone(saved)
    });
    saved.push(picture('after'));
    assert.equal(saved[0].id, 'before');
    assert.equal(effectiveContextHistory(saved).some(m => m.id === 'before'), false);
    assert.equal(effectiveContextHistory(saved).at(-1).id, 'after');

    function panel() {
        const dom = new JSDOM('<main></main>', { url: 'https://example.test/' });
        const root = dom.window.document.querySelector('main');
        const handler = createImageHandler();
        let payload;
        handler.initialize({ chatMessagesDiv: root, electronAPI: { openImageViewer: p => { payload = p; } } });
        t.after(() => { handler.dispose(); dom.window.close(); });
        return {
            render(message, prepend = false) {
                const row = root.ownerDocument.createElement('article');
                row.className = 'message-item';
                row.innerHTML = '<div class="md-content"></div>';
                if (prepend) root.prepend(row); else root.append(row);
                handler.setContentAndProcessImages(row.firstChild, message.content, message.id);
                for (const image of row.querySelectorAll('img')) {
                    Object.defineProperties(image, { naturalWidth: { value: 200 }, naturalHeight: { value: 160 } });
                }
            },
            open() {
                root.querySelector('img[src="/after.png"]').click();
                return payload;
            }
        };
    }
    const first = panel();
    saved.forEach(message => first.render(message));
    const titles = p => p.gallery.map(item => item.title);
    assert.deepEqual(titles(first.open()), ['before.png', 'after.png']);
    const reopened = panel();
    reopened.render(saved.at(-1));
    const single = reopened.open();
    assert.equal(single.gallery, undefined);
    reopened.render(saved[0], true);
    assert.deepEqual(titles(reopened.open()), ['before.png', 'after.png']);
    assert.equal(single.gallery, undefined);
});