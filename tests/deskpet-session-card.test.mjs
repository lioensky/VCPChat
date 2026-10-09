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

test('bell badge counts conversations, expands on demand and preserves selection while streams update', () => {
    const element = () => ({ hidden: false, dataset: {}, listeners: {}, attrs: {}, addEventListener(k, fn) { this.listeners[k] = fn; }, setAttribute(k,v) { this.attrs[k] = v; }, focus() {} });
    const card = element(), panel = element(), toggle = element(), badge = element(), next = element(), previous = element(), navigation = element(), position = element(), stop = element();
    const title = {}, status = {};
    let onStream, opened, interrupted;
    const view = createSessionCard({ card, panel, toggle, badge, next, previous, navigation, position, stop, title, status, api: {
        onStream: fn => { onStream = fn; }, openTopic: id => { opened = id; }, interrupt: id => { interrupted = id; },
    } });
    view.initialize({ name: 'Nova' });
    assert.equal(panel.hidden, true);
    assert.equal(badge.hidden, true);
    const a = { messageId:'a', topicId:'one', title:'文档', status:'thinking' };
    const b = { messageId:'b', topicId:'two', title:'模型', status:'responding' };
    onStream({ type:'start', messageId:'a', session:{ ...a, sessions:[a] } });
    onStream({ type:'start', messageId:'b', session:{ ...b, sessions:[b,a] } });
    assert.equal(badge.textContent, '2');
    assert.equal(panel.hidden, true, '新消息只更新铃铛，不自动抢占头顶');
    toggle.listeners.click();
    assert.equal(panel.hidden, false);
    assert.equal(toggle.attrs['aria-expanded'], 'true');
    assert.equal(title.textContent, '模型');
    next.listeners.click();
    assert.equal(title.textContent, '文档');
    onStream({ type:'data', messageId:'b', text:'继续回复', session:{ ...b, sessions:[b,a] } });
    assert.equal(title.textContent, '文档');
    card.listeners.click(); assert.equal(opened, 'one');
    stop.listeners.click(); assert.equal(interrupted, 'a');
    toggle.listeners.click();
    assert.equal(panel.hidden, true);
    assert.equal(toggle.attrs['aria-expanded'], 'false');
    assert.equal(badge.textContent, '2', '已查看但仍运行的会话继续显示数量');
    const endedA = { ...a, status:'complete' }, endedB = { ...b, status:'complete' };
    onStream({ type:'end', messageId:'a', session:{ ...b, sessions:[b,endedA] } });
    onStream({ type:'end', messageId:'b', session:{ ...endedB, sessions:[endedB,endedA] } });
    assert.equal(badge.textContent, '2', '收起时完成的会话保留未读通知');
    toggle.listeners.click(); next.listeners.click(); toggle.listeners.click();
    assert.equal(badge.hidden, true, '已逐条查看且全部完成后清除角标');
});

test('multiple requests in one topic count as one conversation', () => {
    let onStream;
    const el = () => ({ dataset:{}, addEventListener(){}, setAttribute(){} });
    const badge = {};
    const view = createSessionCard({ card:el(), panel:el(), title:{}, status:{}, badge, api:{ onStream:fn => { onStream = fn; } } });
    view.initialize({name:'Nova'});
    const a = {messageId:'a', topicId:'same', title:'同一会话', status:'thinking'};
    const b = {...a, messageId:'b'};
    onStream({ type:'start', messageId:'b', session:{...b, sessions:[b,a]} });
    assert.equal(badge.textContent, '1');
});
