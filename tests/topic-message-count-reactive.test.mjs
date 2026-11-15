import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createChatRepository } from '../modules/chat/chatRepository.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'modules/topicListManager.js'), 'utf8');

function setupTestEnvironment({ topics = [], activeTopicId = 'topic-1' } = {}) {
    const dom = new JSDOM(`<!doctype html><html><body>
        <section id="tabContentTopics">
            <div class="topics-header"><input type="text" id="topicSearchInput"></div>
            <ul id="topicList" class="topic-list"></ul>
        </section>
    </body></html>`, { url: 'https://vcpchat.local/main.html', runScripts: 'outside-only' });
    const { window } = dom;
    window.requestAnimationFrame = callback => setTimeout(callback, 0);
    window.IntersectionObserver = class {
        constructor(callback) {
            this.callback = callback;
        }
        observe(el) {
            // Immediately simulate intersection for testing
            setTimeout(() => {
                this.callback([{ target: el, isIntersecting: true }]);
            }, 0);
        }
        unobserve() {}
        disconnect() {}
    };

    window.eval(source);

    const savedHistories = new Map();
    const chatAPI = {
        getAgentConfig: async () => ({ topics }),
        getChatHistory: async (_id, topicId) => savedHistories.get(topicId) || [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }],
        saveChatHistory: async (_id, topicId, history) => {
            savedHistories.set(topicId, history);
            return { success: true };
        }
    };
    const chatRepository = createChatRepository(chatAPI);
    let currentTopicId = activeTopicId;
    const currentItem = { id: 'agent-1', type: 'agent', name: 'Nova' };

    window.topicListManager.init({
        elements: { topicListContainer: window.document.getElementById('tabContentTopics') },
        electronAPI: chatAPI,
        chatRepository,
        refs: {
            currentSelectedItemRef: { get: () => currentItem },
            currentTopicIdRef: { get: () => currentTopicId }
        },
        uiHelper: {},
        mainRendererFunctions: {
            selectTopic: id => { currentTopicId = id; },
            updateCurrentItemConfig: () => {}
        },
        topicSelectionReadiness: { isReady: () => true, defer() {} }
    });

    return {
        dom,
        window,
        chatRepository,
        list: window.document.getElementById('topicList'),
        cleanup: () => {
            window.topicListManager.dispose();
            dom.window.close();
        }
    };
}

test('updateTopicMessageCount 实时更新侧边栏话题消息数 DOM 与缓存', async () => {
    const env = setupTestEnvironment({
        topics: [
            { id: 'topic-1', name: '关于 "测试话题" (备用)' },
            { id: 'topic-2', name: '另一个话题' }
        ],
        activeTopicId: 'topic-1'
    });

    try {
        await env.window.topicListManager.loadTopicList();
        // 等待初始 IntersectionObserver 回调填充消息数（4条）
        await new Promise(resolve => setTimeout(resolve, 50));

        const item1 = env.list.querySelector('.topic-item[data-topic-id="topic-1"]');
        assert.ok(item1, 'topic-1 item must exist');
        const badge1 = item1.querySelector('.message-count');
        assert.equal(badge1.textContent, '4', '初始消息数应为4');

        // 测试直接调用 updateTopicMessageCount
        env.window.topicListManager.updateTopicMessageCount('topic-1', 5);
        assert.equal(badge1.textContent, '5', '调用 updateTopicMessageCount 后 DOM 徽标应立即变为 5');

        env.window.topicListManager.updateTopicMessageCount('topic-1', 12);
        assert.equal(badge1.textContent, '12', '调用 updateTopicMessageCount 后 DOM 徽标应立即变为 12');
    } finally {
        env.cleanup();
    }
});

test('chatRepository.saveHistory 触发 onDidSaveHistory 时自动响应式更新话题消息数', async () => {
    const env = setupTestEnvironment({
        topics: [
            { id: 'topic-1', name: '关于 "测试话题" (备用)' }
        ],
        activeTopicId: 'topic-1'
    });

    try {
        await env.window.topicListManager.loadTopicList();
        await new Promise(resolve => setTimeout(resolve, 50));

        const item1 = env.list.querySelector('.topic-item[data-topic-id="topic-1"]');
        const badge1 = item1.querySelector('.message-count');
        assert.equal(badge1.textContent, '4');

        // 模拟追加新消息并保存到 chatRepository
        const newHistory = [
            { id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' },
            { id: 'm5' }, { id: 'm6' }, { id: 'm7' }
        ];
        await env.chatRepository.saveHistory('agent-1', 'agent', 'topic-1', newHistory);

        // 验证 DOM 徽标无需重新加载话题列表即自动响应式更新
        assert.equal(badge1.textContent, '7', 'chatRepository 保存后应自动更新侧边栏话题消息数至 7');
    } finally {
        env.cleanup();
    }
});
