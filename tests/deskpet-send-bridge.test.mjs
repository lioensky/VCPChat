import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeskPetSendBridge } from '../modules/renderer/deskPetSendBridge.js';

// 模拟主窗口的选中事务：选中的 Agent 先变，话题要等列表读回来才定下来。
function fakeMainWindow({ selectDelayMs = 30 } = {}) {
    const state = { selected: { id: 'Bob', type: 'agent' }, topicId: 'topic_bob', busy: false, newTopics: 0, failTopic: false };
    const sent = [];
    const bridge = createDeskPetSendBridge({
        getSelectedItem: () => state.selected,
        getTopicId: () => state.topicId,
        findAgent: (id) => (id === 'Alice' || id === 'Bob' ? { id, type: 'agent', name: id } : null),
        selectItem: async (item) => {
            state.selected = { id: item.id, type: item.type };
            state.topicId = null;
            await new Promise((resolve) => setTimeout(resolve, selectDelayMs));
            state.topicId = `topic_${item.id.toLowerCase()}`;
        },
        sendMessage: async (request) => {
            if (!state.topicId) throw new Error('请先选择一个项目和话题。');
            sent.push({ agentId: state.selected.id, topicId: state.topicId, request });
        },
        startTopic: async (item) => {
            if (state.failTopic) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
            state.topicId = `topic_${item.id.toLowerCase()}_new${++state.newTopics}`;
        },
        isBusy: () => state.busy,
        acceptMs: 50,
    });
    return { state, sent, bridge };
}

test('a pet message for another agent waits until that agent has a topic', async () => {
    const { bridge, sent } = fakeMainWindow({ selectDelayMs: 120 });
    const result = await bridge({ agentId: 'Alice', text: '你好' });
    assert.deepEqual(result, { success: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].agentId, 'Alice');
    assert.equal(sent[0].topicId, 'topic_alice');
});

test('a pet message never carries the main input draft or its attachments', async () => {
    const { bridge, sent } = fakeMainWindow();
    await bridge({ agentId: 'Bob', text: '桌宠说的话' });
    assert.deepEqual(sent[0].request, { content: '桌宠说的话', attachments: [], propagateError: true });
});

test('a send that fails before it is saved is reported, not claimed as sent', async () => {
    const bridgeThatThrows = (error) => createDeskPetSendBridge({
        getSelectedItem: () => ({ id: 'Alice', type: 'agent' }),
        getTopicId: () => 'topic_alice',
        findAgent: () => null,
        selectItem: async () => {},
        sendMessage: async () => { throw error; },
        isBusy: () => false,
        acceptMs: 50,
    });
    assert.deepEqual(await bridgeThatThrows(new Error('保存聊天记录失败'))({ agentId: 'Alice', text: 'x' }),
        { success: false, error: '保存聊天记录失败' });
    // 话已经存下、只是回复报错：桌宠不能让用户再发一遍。
    const replyFailed = Object.assign(new Error('VCP 500'), { shownInChat: true });
    assert.deepEqual(await bridgeThatThrows(replyFailed)({ agentId: 'Alice', text: 'x' }), { success: true });
});

test('busy main chat, unknown agent and empty text are refused', async () => {
    const { bridge, state, sent } = fakeMainWindow();
    state.busy = true;
    assert.equal((await bridge({ agentId: 'Bob', text: 'hi' })).success, false);
    state.busy = false;
    assert.deepEqual(await bridge({ agentId: 'Nobody', text: 'hi' }), { success: false, error: '助手列表里找不到这个 Agent' });
    assert.deepEqual(await bridge({ agentId: 'Bob', text: '   ' }), { success: false, error: '没有内容' });
    assert.equal(sent.length, 0);
});

test('two quick sends from the pet run one after the other', async () => {
    const original = { selected: { id: 'Bob', type: 'agent' }, topicId: 'topic_Bob' };
    const sent = [];
    let active = 0;
    let overlap = false;
    const queued = createDeskPetSendBridge({
        getSelectedItem: () => original.selected,
        getTopicId: () => original.topicId,
        findAgent: (id) => ({ id, type: 'agent', name: id }),
        selectItem: async (item) => {
            active += 1;
            if (active > 1) overlap = true;
            original.selected = { id: item.id, type: 'agent' };
            original.topicId = null;
            await new Promise((resolve) => setTimeout(resolve, 60));
            original.topicId = `topic_${item.id}`;
            active -= 1;
        },
        sendMessage: async () => { sent.push(original.selected.id); },
        isBusy: () => false,
        acceptMs: 20,
    });
    const results = await Promise.all([queued({ agentId: 'Alice', text: '1' }), queued({ agentId: 'Carol', text: '2' })]);
    assert.deepEqual(results, [{ success: true }, { success: true }]);
    assert.equal(overlap, false, '第二次发送要等第一次的切换做完');
    assert.deepEqual(sent, ['Alice', 'Carol']);
});

test('a pet message whose request already timed out on the pet side is not sent late', async () => {
    const { bridge, sent } = fakeMainWindow({ selectDelayMs: 80 });
    const result = await bridge({ agentId: 'Alice', text: '你好', deadline: Date.now() + 20 });
    assert.deepEqual(result, { success: false, error: '主窗口没有响应' });
    assert.equal(sent.length, 0);
    const fresh = await bridge({ agentId: 'Alice', text: '你好', deadline: Date.now() + 5000 });
    assert.equal(fresh.success, true);
    assert.equal(sent.length, 1);
});

test('files from the pet are stored in the target topic and sent with the message', async () => {
    const stored = [];
    const sent = [];
    const state = { selected: { id: 'Bob', type: 'agent' }, topicId: 'topic_bob' };
    const bridge = createDeskPetSendBridge({
        getSelectedItem: () => state.selected,
        getTopicId: () => state.topicId,
        findAgent: (id) => ({ id, type: 'agent', name: id }),
        selectItem: async (item) => { state.selected = { id: item.id, type: 'agent' }; state.topicId = `topic_${item.id}`; },
        sendMessage: async (request) => sent.push(request),
        isBusy: () => false,
        storeFiles: async (agentId, topicId, files) => {
            stored.push({ agentId, topicId, names: files.map((f) => f.name) });
            return files.map((f) => (f.name === 'bad.bin'
                ? { name: f.name, error: '读不了' }
                : { success: true, attachment: { name: f.name, type: 'image/png', size: 3, internalPath: `file:///att/${f.name}` } }));
        },
        acceptMs: 30,
    });
    // 只有文件、没有字也能发
    const result = await bridge({ agentId: 'Alice', text: '', files: [{ path: '/a.png', name: 'a.png' }, { path: '/bad.bin', name: 'bad.bin' }] });
    assert.deepEqual(result, { success: true });
    assert.deepEqual(stored, [{ agentId: 'Alice', topicId: 'topic_Alice', names: ['a.png', 'bad.bin'] }]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, '');
    assert.deepEqual(sent[0].attachments.map((a) => [a.originalName, a.localPath]), [['a.png', 'file:///att/a.png']]);
    // 一个都没存上：不发，告诉桌宠为什么
    const failed = await bridge({ agentId: 'Alice', text: '看看', files: [{ path: '/bad.bin', name: 'bad.bin' }] });
    assert.deepEqual(failed, { success: false, error: '文件没存上：读不了' });
    assert.equal(sent.length, 1);
    // 没字也没文件
    assert.equal((await bridge({ agentId: 'Alice', text: '  ', files: [] })).success, false);
});

test('the pet\'s + opens a new topic first and sends into it', async () => {
    const { bridge, sent } = fakeMainWindow();
    assert.deepEqual(await bridge({ agentId: 'Alice', text: '换个话题', newTopic: true }), { success: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].topicId, 'topic_alice_new1');
    assert.deepEqual(await bridge({ agentId: 'Alice', text: '接着说' }), { success: true });
    assert.equal(sent[1].topicId, 'topic_alice_new1', '不按 + 就留在刚开的话题里');
});

test('when the new topic cannot be opened, nothing is sent into the old one', async () => {
    const { bridge, sent, state } = fakeMainWindow();
    state.failTopic = true;
    const result = await bridge({ agentId: 'Bob', text: '换个话题', newTopic: true });
    assert.equal(result.success, false);
    assert.equal(sent.length, 0);
});
