import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createSessionCard } from '../DeskPetmodules/sessionCard.js';
import { dockHitArea, containsPoint } from '../DeskPetmodules/dockHitArea.js';
const { createSessionActivity } = createRequire(import.meta.url)('../modules/deskpet/sessionActivity.js');

test('collapsed bar and expanded controls share a stable CSS-pixel hover target', () => {
    for (const [width, height] of [[360, 580], [252, 690], [540, 870]]) {
        const area = dockHitArea(width, height);
        // 小横条停在 bottom 38，展开后 bottom 6；动画中光标不应掉到透明区域。
        for (const bottom of [6, 14, 28, 38, 46]) assert.ok(containsPoint(area, width / 2, height - bottom));
        assert.ok(containsPoint(area, width / 2 - 62, height - 24));
        assert.equal(containsPoint(area, 4, height - 24), false);
        assert.equal(containsPoint(area, width / 2, height - 60), false);
    }
});

test('concurrent requests retain real topic ownership and fall back to the remaining running request', async () => {
    const titles = new Map();
    const store = createSessionActivity({ titleOf: (_agent, topic) => new Promise(resolve => titles.set(topic, resolve)) });
    store.start('a', { agentId: 'Nova', topicId: 'topic-a' });
    store.start('b', { agentId: 'Nova', topicId: 'topic-b' });
    await Promise.resolve();
    titles.get('topic-b')('制作 Nova 看板娘');
    titles.get('topic-a')('更新交接文档');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.get('Nova').title, '制作 Nova 看板娘');
    assert.equal(store.get('Nova').runningCount, 2);
    store.update('Nova', { type: 'end', messageId: 'b' });
    assert.equal(store.get('Nova').topicId, 'topic-a');
    assert.equal(store.get('Nova').status, 'thinking');
    store.update('Nova', { type: 'end', messageId: 'a', aborted: true });
    assert.equal(store.get('Nova').messageId, 'b', '完成后保留最新发起的会话');
    assert.equal(store.get('Nova').status, 'complete');
    store.start('c', { agentId: 'Other', topicId: 'other' });
    assert.equal(store.get('Nova').topicId, 'topic-b');
    assert.equal(store.get('Other').topicId, 'other');
});

test('cancel and error status remain distinct; late chunks cannot revive a completed request', () => {
    const store = createSessionActivity();
    store.start('a', { agentId: 'Nova', topicId: 'one' });
    store.update('Nova', { type: 'end', messageId: 'a', aborted: true });
    store.update('Nova', { type: 'data', messageId: 'a' });
    assert.equal(store.get('Nova').status, 'stopped');
    store.start('b', { agentId: 'Nova', topicId: 'two' });
    store.update('Nova', { type: 'error', messageId: 'b' });
    assert.equal(store.get('Nova').status, 'error');
});

test('slow title lookups cannot relabel a replaced request', async () => {
    const resolves = [];
    const store = createSessionActivity({ titleOf: () => new Promise(resolve => resolves.push(resolve)) });
    store.start('same', { agentId: 'Nova', topicId: 'old' });
    store.start('same', { agentId: 'Nova', topicId: 'new' });
    await Promise.resolve();
    resolves[1]('新会话'); resolves[0]('旧会话');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.get('Nova').title, '新会话');
});

test('card follows the actual topic, preserves early events, and uses text rather than HTML', () => {
    let onStream, click, opened;
    const card = { addEventListener: (_name, fn) => { click = fn; } };
    const title = {}, status = {};
    const view = createSessionCard({ card, title, status, api: {
        onStream: fn => { onStream = fn; },
        openTopic: id => { opened = id; }, openMainWindow: () => {},
    } });
    const session = { messageId: 'b', topicId: 'topic-b', title: '<b>当前会话</b>', status: 'thinking', runningCount: 1 };
    onStream({ type: 'start', messageId: 'b', session });
    view.initialize({ name: 'Nova', session: { title: '过期的快照' } });
    assert.equal(title.textContent, '<b>当前会话</b>');
    assert.equal(status.textContent, '正在思考…');
    click(); assert.equal(opened, 'topic-b');
    onStream({ type: 'end', messageId: 'b', session: { ...session, status: 'stopped' } });
    assert.equal(status.textContent, '已停止回复');
});
