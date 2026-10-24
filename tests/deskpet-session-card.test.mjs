import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createSessionCard } from '../DeskPetmodules/sessionCard.js';
import { dockHitArea, containsPoint } from '../DeskPetmodules/dockHitArea.js';
import { createDockVisibility, createCursorHitGate } from '../DeskPetmodules/dockVisibility.js';
import { bindPointer } from '../DeskPetmodules/pointerGestures.js';
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
    const card = element(), panel = element(), toggle = element(), divider = element(), badge = element(), next = element(), previous = element(), navigation = element(), position = element(), stop = element();
    const title = {}, status = {};
    let onStream, opened, interrupted;
    const view = createSessionCard({ card, panel, toggle, divider, badge, next, previous, navigation, position, stop, title, status, api: {
        onStream: fn => { onStream = fn; }, openTopic: id => { opened = id; }, interrupt: id => { interrupted = id; },
    } });
    view.initialize({ name: 'Nova' });
    assert.equal(panel.hidden, true);
    assert.equal(badge.hidden, true);
    assert.equal(toggle.hidden, true, 'idle has only the first two controls');
    assert.equal(divider.hidden, true);
    const a = { messageId:'a', topicId:'one', title:'文档', status:'thinking' };
    const b = { messageId:'b', topicId:'two', title:'模型', status:'responding' };
    onStream({ type:'start', messageId:'a', session:{ ...a, sessions:[a] } });
    onStream({ type:'start', messageId:'b', session:{ ...b, sessions:[b,a] } });
    assert.equal(badge.textContent, '2');
    assert.equal(toggle.hidden, false);
    assert.equal(divider.hidden, false);
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
    assert.equal(toggle.hidden, true, 'finished and acknowledged conversations release the third control');
    assert.equal(divider.hidden, true);
});

test('removing the expanded conversation releases the pin and session subscriptions dispose once', () => {
    let stream, missing, pin = false, unsubscribed = 0;
    const el = () => ({ dataset: {}, addEventListener() {}, removeEventListener() {}, setAttribute() {} });
    const toggle = el(), panel = el();
    const view = createSessionCard({ card: el(), panel, toggle, title: {}, status: {}, onToggle: value => { pin = value; }, api: {
        onStream: fn => { stream = fn; return () => { unsubscribed++; }; },
        onTopicMissing: fn => { missing = fn; return () => { unsubscribed++; }; },
    } });
    view.initialize({ name: 'Nova' });
    view.setExpanded(true); assert.equal(pin, false, 'an empty card cannot expand');
    stream({ type: 'start', messageId: 'a', session: { messageId: 'a', topicId: 'one', status: 'thinking' } });
    view.setExpanded(true); assert.equal(pin, true);
    stream({ type: 'session', session: { sessions: [] } });
    assert.equal(pin, false); assert.equal(panel.hidden, true); assert.equal(toggle.hidden, true);
    view.dispose(); view.dispose(); assert.equal(unsubscribed, 2);
    stream({ type: 'start', messageId: 'late', session: { messageId: 'late', status: 'thinking' } });
    assert.equal(toggle.hidden, true);
});

test('forgotten or cleared session stores reject late title lookups', async () => {
    let release; const published = [];
    const store = createSessionActivity({ titleOf: () => new Promise(resolve => { release = resolve; }), publish: (...args) => published.push(args) });
    for (const action of ['forget', 'clear']) {
        store.start('a', { agentId: 'Nova', topicId: 'one' }); await Promise.resolve();
        store[action]('Nova'); release('old private title'); await new Promise(resolve => setImmediate(resolve));
        assert.equal(store.get('Nova'), null); assert.equal(published.length, 0);
    }
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

function dockFixture() {
    let mode = 'hidden', suppressed = false, now = 0, seq = 0;
    const timers = new Map();
    const controller = createDockVisibility({
        getMode: () => mode,
        setMode: value => { mode = value; controller.modeChanged(); },
        suppress: value => { suppressed = value; },
        schedule: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
        cancel: id => timers.delete(id),
    });
    return { controller, get mode() { return mode; }, get suppressed() { return suppressed; },
        setMode(value) { mode = value; controller.modeChanged(); },
        tick(ms) {
            const end = now + ms;
            while (true) {
                const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a,b) => a[1].at-b[1].at)[0];
                if (!next) break;
                now = next[1].at; timers.delete(next[0]); next[1].fn();
            }
            now = end;
        },
    };
}

test('idle dock stays collapsed, opens on intentional hover and tolerates the gap to its buttons', () => {
    const d = dockFixture();
    d.tick(2000); assert.equal(d.mode, 'hidden');
    d.controller.update({ hover: true }); d.tick(80);
    assert.equal(d.mode, 'hidden', 'passing over must not immediately open it');
    d.tick(40); assert.equal(d.mode, 'pill');
    d.controller.update({ hover: false }); d.tick(500);
    assert.equal(d.mode, 'pill', 'crossing transparent space toward the buttons keeps it open');
    d.controller.update({ hover: true }); d.tick(400);
    assert.equal(d.mode, 'pill', 'the old hide timer was cancelled');
    d.controller.update({ hover: false }); d.tick(800);
    assert.equal(d.mode, 'hidden');
    const cue = dockHitArea(360, 480, { collapsed: true });
    assert.ok(containsPoint(cue, 180, 438));
    // 胶囊收起后光标直接落到打字、说话按钮的位置（离横条约 20px），也要算命中，胶囊才会重新冒出来
    for (const x of [145, 161, 200, 215]) assert.ok(containsPoint(cue, x, 457), `button spot ${x}`);
    assert.equal(containsPoint(cue, 120, 460), false, 'collapsed controls do not capture the wider session area');
});

test('input, recording and explicitly expanded sessions pin the dock; drag and click-through suppress it', () => {
    const d = dockFixture();
    for (const mode of ['bar', 'rec']) {
        d.setMode(mode); d.controller.update({ hover: false }); d.tick(3000);
        assert.equal(d.mode, mode);
    }
    d.setMode('pill'); d.controller.update({ pinned: true }); d.tick(3000);
    assert.equal(d.mode, 'pill');
    d.controller.update({ pinned: false }); d.tick(800); assert.equal(d.mode, 'hidden');
    d.controller.update({ hover: true }); d.tick(120);
    d.controller.update({ dragging: true }); assert.equal(d.suppressed, true); assert.equal(d.mode, 'hidden');
    d.controller.update({ dragging: false, hover: false }); d.tick(1000);
    assert.equal(d.mode, 'hidden', 'dropping never forces a persistent pill');
    d.controller.update({ through: true, hover: true }); d.tick(1000); assert.equal(d.suppressed, true);
    d.setMode('bar'); assert.equal(d.suppressed, false, 'explicit keyboard input still works in click-through mode');
    d.setMode('hidden'); assert.equal(d.suppressed, true);
});

test('hiding a window cancels hover timers without losing a draft mode', () => {
    const d = dockFixture();
    d.controller.update({ hover: true }); d.tick(50);
    d.controller.update({ visible: false, hover: false }); d.tick(1000);
    d.controller.update({ visible: true }); assert.equal(d.mode, 'hidden');
    d.setMode('bar'); d.controller.update({ visible: false }); d.tick(2000);
    assert.equal(d.mode, 'bar'); assert.equal(d.suppressed, true);
    d.controller.update({ visible: true }); assert.equal(d.suppressed, false); assert.equal(d.mode, 'bar');
    d.setMode('hidden'); d.controller.update({ hover: true }); d.controller.dispose(); d.tick(2000);
    assert.equal(d.mode, 'hidden');
});

test('a late alpha result cannot revive an outside hover or cancel a current UI hover', () => {
    const hit = createCursorHitGate();
    hit.cursor({ outside: false, ui: false }); assert.equal(hit.resolve(true), true);
    hit.cursor({ outside: true }); assert.equal(hit.resolve(true), false, 'an old rendered hit arrived after leaving');
    hit.cursor({ outside: false, ui: true }); assert.equal(hit.resolve(false), true, 'an old transparent pixel arrived after reaching a button');
    hit.cursor({ outside: false, ui: false }); assert.equal(hit.resolve(false), false);
});

test('pointer gestures release lost captures and remove all hooks and delayed taps on disposal', async () => {
    const listeners = new Map();
    const target = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
    let starts = [], ends = 0, taps = 0;
    const options = { target, api: { touched() {}, dragStart: origin => starts.push(origin), dragEnd: () => { ends++; } },
        onTap: () => { taps++; }, onDoubleTap() {}, onTapDown() {}, onDrag() {}, afterDrag() {}, figureBounds: () => null };
    const control = bindPointer(options);
    const down = { button: 0, screenX: 900, screenY: 500, clientX: 40, clientY: 60, pointerId: 1, target: { setPointerCapture() {} } };
    listeners.get('pointerdown')(down);
    listeners.get('pointermove')({ ...down, screenX: 904 });
    assert.deepEqual(starts, [{ x: 900, y: 500, local: { x: 40, y: 60 } }]);
    listeners.get('lostpointercapture')(); assert.equal(ends, 1);
    control.dispose(); control.dispose(); assert.equal(listeners.size, 0);
    const click = bindPointer(options);
    listeners.get('pointerdown')(down); listeners.get('pointerup')(down);
    click.dispose(); await new Promise(resolve => setTimeout(resolve, 320));
    assert.equal(taps, 0); assert.equal(listeners.size, 0);
});
