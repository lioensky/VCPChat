import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createModelTrajectorySideProvider, trajectoryKeyFor, EXPANSION_KINDS } from '../modules/ui-system/side-pane/modelTrajectorySideProvider.js';
import { createSidePaneRootScope } from '../modules/ui-system/side-pane/side-pane-occurrence.js';

const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const msg = (role, text) => ({ role, parts: [{ kind: 'text', text }] });
const TOOL_REQ = '<<<[TOOL_REQUEST]>>>\ntool_name:「始」FileOperator「末」,\ncommand:「始」ReadFile「末」\n<<<[END_TOOL_REQUEST]>>>';

function records() {
    return [
        {
            id: 'call_a', requestId: 'm1', startedAt: 1700000000000, endedAt: 1700000001500, durationMs: 1500, status: 'completed',
            source: { kind: 'main', agentName: '小助手' }, model: { modelId: 'deepseek-v4' },
            request: { messages: [msg('system', 'You are helpful.\nSecond line'), msg('user', '帮我读一下文件')] },
            response: { text: `好的\n${TOOL_REQ}`, reasoningText: '先想一想', finishReason: 'stop', usage: { inputTokens: 1200, outputTokens: 80, totalTokens: 1280 } }
        },
        {
            id: 'call_b', requestId: 'm1', startedAt: 1700000002000, endedAt: 1700000003000, durationMs: 1000, status: 'error',
            source: { kind: 'main', agentName: '小助手' }, model: { modelId: 'deepseek-v4' },
            request: { messages: [msg('system', 'You are helpful.\nSecond line'), msg('user', '帮我读一下文件'), msg('assistant', `好的\n${TOOL_REQ}`), msg('user', '[[VCP调用结果信息汇总:- 工具名称: FileOperator\n- 执行状态: SUCCESS\n- 返回内容: hello worldVCP调用结果结束]]')] },
            response: null, error: { name: 'Error', message: 'upstream 500' }
        }
    ];
}

// 提供者带一个跟随会话的轮询定时器；不关掉 JSDOM 窗口，测试跑完进程也退不出去。
const openWindows = [];
after(() => { openWindows.forEach(win => win.close()); });

function makeEnv({ conversation = { item: { id: 'agent1', name: '小助手' }, topicId: 't1' }, recs = records(), result } = {}) {
    const dom = new JSDOM('<div id="view"></div>', { pretendToBeVisual: true });
    openWindows.push(dom.window);
    const doc = dom.window.document;
    const state = { lists: [], opened: [], toasts: [], watch: 0, unwatch: 0, copied: [], cleared: [], recs, conversation, conversationListeners: [], conversationUnsubscribed: false };
    let changed = null;
    let unsubscribed = false;
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async text => { state.copied.push(text); } } });
    dom.window.confirm = () => true;
    const api = {
        modelTrajectoryList: async (key, opts) => { state.lists.push([key, opts]); return result || { success: true, data: { records: state.recs, truncated: false, total: state.recs.length } }; },
        modelTrajectoryClear: async key => { state.cleared.push(key); state.recs = []; return { success: true }; },
        modelTrajectoryOpenDirectory: async () => ({ success: true }),
        modelTrajectoryWatch: async () => { state.watch += 1; return { success: true }; },
        modelTrajectoryUnwatch: async () => { state.unwatch += 1; return { success: true }; },
        onModelTrajectoryChanged: cb => { changed = cb; return () => { unsubscribed = true; }; }
    };
    const sidePaneController = { openTab: async tab => { state.opened.push(tab); return { focus() {} }; }, setVisible() {} };
    const provider = createModelTrajectorySideProvider({
        document: doc, api, sidePaneController, uiHelper: { showToastNotification: m => state.toasts.push(m) },
        getConversation: () => state.conversation,
        onConversationChange: callback => { state.conversationListeners.push(callback); return () => { state.conversationUnsubscribed = true; }; }
    });
    return { dom, doc, api, provider, state, view: doc.getElementById('view'), fire: c => changed?.(c), wasUnsubscribed: () => unsubscribed };
}

const typeInto = (input, value) => {
    input.value = value;
    input.dispatchEvent(new input.ownerDocument.defaultView.Event('input'));
};

test('trajectoryKeyFor matches the recorder key', () => {
    assert.equal(trajectoryKeyFor({ item: { id: 'a' }, topicId: 't' }), 'a__t');
    assert.equal(trajectoryKeyFor({ item: { id: 'a' }, topicId: null }), null);
    assert.equal(trajectoryKeyFor(null), null);
});

test('openModelTrajectoryTab opens the singleton tab', async () => {
    const { provider, state } = makeEnv();
    await provider.openModelTrajectoryTab();
    assert.equal(state.opened[0].id, 'model-trajectory:main');
    assert.equal(state.opened[0].kind, 'model-trajectory');
});

test('mountTab renders summary, call cards, deltas, and error block', async () => {
    const { provider, state, view } = makeEnv();
    const handle = await provider.mountTab({ id: 'model-trajectory:main' }, view);
    assert.equal(state.watch, 1);
    assert.equal(state.lists[0][0], 'agent1__t1');
    const summary = view.querySelector('.side-traj-summary').textContent;
    assert.match(summary, /2 次调用/);
    assert.match(summary, /1,280 tok/);
    assert.match(summary, /deepseek-v4/);
    const cards = view.querySelectorAll('.side-traj-call');
    assert.equal(cards.length, 2);
    assert.match(cards[0].textContent, /01/);
    assert.match(cards[0].textContent, /IN 1,200/);
    assert.match(cards[0].textContent, /OUT 80/);
    assert.match(cards[0].textContent, /1\.50s/);
    assert.equal(cards[0].querySelectorAll('.side-traj-section-input .side-traj-row').length, 2);
    const secondInputs = cards[1].querySelectorAll('.side-traj-section-input .side-traj-row');
    assert.equal(secondInputs.length, 1);
    assert.equal(secondInputs[0].dataset.trajectoryRole, 'tool-result');
    const outRoles = [...cards[0].querySelectorAll('.side-traj-section-output .side-traj-row')].map(row => row.dataset.trajectoryRole);
    assert.deepEqual(outRoles, ['reasoning', 'assistant', 'tool-call']);
    assert.match(cards[1].querySelector('.side-traj-error').textContent, /upstream 500/);
    await handle.dispose();
});

test('rows toggle, expand-all and per-kind menu switches follow the command versions', async () => {
    const { provider, view, doc } = makeEnv();
    await provider.mountTab({ id: 'model-trajectory:main' }, view);
    const userRow = view.querySelector('.side-traj-row[data-trajectory-role="user"]');
    assert.ok(userRow.classList.contains('open'));
    userRow.querySelector('.side-traj-row-head').click();
    assert.ok(!userRow.classList.contains('open'));
    view.querySelector('[aria-label="自定义展开"]').click();
    assert.equal(view.querySelectorAll('.side-traj-menu-item').length, EXPANSION_KINDS.length);
    view.querySelector('[data-trajectory-expansion-kind="system"]').click();
    const systemRow = view.querySelector('.side-traj-row[data-trajectory-role="system"]');
    assert.ok(!systemRow.classList.contains('open'));
    view.querySelector('[aria-label="全部展开"]').click();
    assert.ok(systemRow.classList.contains('open'));
    assert.ok(userRow.classList.contains('open'));
    doc.body.click();
    assert.equal(view.querySelector('.side-traj-menu').hidden, true);
});

test('search counts matches, handles no-match, and Escape closes', async () => {
    const { provider, view } = makeEnv();
    await provider.mountTab({ id: 'model-trajectory:main' }, view);
    view.querySelector('[aria-label="搜索调用轨迹"]').click();
    const input = view.querySelector('.side-traj-search-input');
    const count = view.querySelector('.side-traj-search-count');
    typeInto(input, 'hello');
    await wait(200);
    assert.equal(count.textContent, '1/1');
    typeInto(input, 'zzz-nothing');
    await wait(200);
    assert.equal(count.textContent, '0/0');
    typeInto(input, 'FileOperator');
    await wait(200);
    assert.match(count.textContent, /^1\/\d+$/);
    assert.notEqual(count.textContent, '1/1');
    view.querySelector('[aria-label="下一个匹配项"]').click();
    assert.match(count.textContent, /^2\//);
    input.dispatchEvent(new input.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(view.querySelector('.side-traj-search').hidden, true);
});

test('a collapsed row containing the active match is revealed', async () => {
    const { provider, view } = makeEnv();
    await provider.mountTab({ id: 'model-trajectory:main' }, view);
    const toolResultRow = view.querySelector('.side-traj-row[data-trajectory-role="tool-result"]');
    toolResultRow.querySelector('.side-traj-row-head').click();
    assert.ok(!toolResultRow.classList.contains('open'));
    view.querySelector('[aria-label="搜索调用轨迹"]').click();
    typeInto(view.querySelector('.side-traj-search-input'), 'hello world');
    await wait(200);
    assert.ok(toolResultRow.classList.contains('open'));
    assert.ok(toolResultRow.classList.contains('revealed'));
});

test('copy button copies the message content', async () => {
    const { provider, view, state } = makeEnv();
    await provider.mountTab({ id: 'model-trajectory:main' }, view);
    view.querySelector('.side-traj-row[data-trajectory-role="user"] .side-traj-row-copy').click();
    await wait();
    assert.deepEqual(state.copied, ['帮我读一下文件']);
});

test('change events reload only for the current session', async () => {
    const { provider, view, state, fire } = makeEnv();
    await provider.mountTab({ id: 'model-trajectory:main' }, view);
    const before = state.lists.length;
    fire({ sessionKey: 'other__x', id: 'z', status: 'completed' });
    await wait(150);
    assert.equal(state.lists.length, before);
    state.recs = [...state.recs, { ...records()[0], id: 'call_c', startedAt: 1700000009000 }];
    fire({ sessionKey: 'agent1__t1', id: 'call_c', status: 'completed' });
    await wait(150);
    assert.equal(view.querySelectorAll('.side-traj-call').length, 3);
});

test('empty and no-conversation states, list errors, clear', async () => {
    let env = makeEnv({ conversation: { item: null, topicId: null } });
    await env.provider.mountTab({ id: 'x' }, env.view);
    assert.match(env.view.querySelector('.side-traj-state').textContent, /请先在主聊天里选择/);
    assert.equal(env.state.lists.length, 0);

    env = makeEnv({ recs: [] });
    await env.provider.mountTab({ id: 'x' }, env.view);
    assert.match(env.view.querySelector('.side-traj-state').textContent, /还没有模型调用记录/);
    assert.equal(env.view.querySelector('[aria-label="搜索调用轨迹"]').hidden, true);

    env = makeEnv({ result: { success: false, error: 'boom' } });
    await env.provider.mountTab({ id: 'x' }, env.view);
    assert.match(env.view.querySelector('.side-traj-state').textContent, /boom/);

    // 主进程还是旧的（没注册这组接口）：invoke 抛错，页面要留着并提示重启，而不是让 mountTab 抛出
    env = makeEnv();
    const missingHandler = new Error("Error invoking remote method 'model-trajectory:list': Error: No handler registered for 'model-trajectory:list'");
    const failing = createModelTrajectorySideProvider({
        document: env.doc, api: { modelTrajectoryList: async () => { throw missingHandler; } }, sidePaneController: {},
        getConversation: () => env.state.conversation
    });
    const handle = await failing.mountTab({ id: 'x' }, env.view);
    assert.match(env.view.querySelector('.side-traj-state').textContent, /完全退出并重新打开/);
    await handle.dispose();

    env = makeEnv();
    await env.provider.mountTab({ id: 'x' }, env.view);
    env.view.querySelector('[aria-label="清空这个话题的调用轨迹"]').click();
    await wait();
    assert.deepEqual(env.state.cleared, ['agent1__t1']);
});

test('switching conversation reloads through the selection subscription, and dispose unsubscribes', async () => {
    const { provider, view, state } = makeEnv();
    const handle = await provider.mountTab({ id: 'x' }, view);
    assert.equal(state.conversationListeners.length, 1);
    state.conversation = { item: { id: 'agent2', name: '另一个' }, topicId: 't9' };
    state.conversationListeners[0]();
    await wait(80);
    assert.equal(state.lists.at(-1)[0], 'agent2__t9');
    await handle.dispose();
    assert.ok(state.conversationUnsubscribed);
});

test('truncated notice and dispose cleanup', async () => {
    const { provider, view, wasUnsubscribed } = makeEnv({ result: { success: true, data: { records: records(), truncated: true, total: 500 } } });
    const handle = await provider.mountTab({ id: 'x' }, view);
    assert.equal(view.querySelector('.side-traj-truncated').hidden, false);
    await handle.dispose();
    assert.ok(wasUnsubscribed());
    assert.equal(view.innerHTML, '');
});

function manyRecords(count) {
    return Array.from({ length: count }, (_, i) => ({
        id: `call_${i}`, requestId: `m${i}`, startedAt: 1700000000000 + i * 1000, endedAt: 1700000000500 + i * 1000, durationMs: 500, status: 'completed',
        source: { kind: 'main' }, model: { modelId: 'm' },
        request: { messages: [msg('system', 'sys'), msg('user', `问题 ${i}`)] },
        response: { text: `回答 ${i}${i === 1 ? ' 独有词' : ''}`, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
    }));
}

/** 记下被观察的卡片，测试里手动触发「进入可视区」。 */
function installObserver(win) {
    const observers = [];
    win.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
        observe(el) { this.targets.add(el); }
        unobserve(el) { this.targets.delete(el); }
        disconnect() { this.targets.clear(); }
        reveal(el) { this.callback([{ target: el, isIntersecting: true }]); }
    };
    return observers;
}

test('cards are built lazily: the newest ones at once, the rest when scrolled near, searched or focused', async () => {
    const env = makeEnv({ recs: manyRecords(8) });
    const observers = installObserver(env.dom.window);
    const handle = await env.provider.mountTab({ id: 'x' }, env.view);
    const cards = [...env.view.querySelectorAll('.side-traj-call')];
    assert.equal(cards.length, 8);
    const pending = () => cards.filter(card => card.querySelector('.side-traj-call-body.pending')).map(card => card.dataset.trajectoryCall.split(':')[0]);
    assert.deepEqual(pending(), ['call_0', 'call_1', 'call_2', 'call_3', 'call_4']);
    assert.equal(cards[0].querySelector('.side-traj-row'), null, 'an unbuilt card has no message rows');
    assert.equal(observers[0].targets.size, 5);

    observers[0].reveal(cards[3]);
    assert.ok(cards[3].querySelector('.side-traj-row'));
    assert.equal(observers[0].targets.has(cards[3]), false);

    // 搜索命中的卡片（call_1）会先构建出来
    env.view.querySelector('.side-traj-icon-btn[title="搜索调用轨迹"]').click();
    typeInto(env.view.querySelector('.side-traj-search-input'), '独有词');
    await wait(200);
    assert.equal(env.view.querySelector('.side-traj-search-count').textContent, '1/1');
    assert.equal(pending().includes('call_1'), false);

    // 消息右键「查看调用轨迹」：定位到 m0，卡片构建并闪烁
    await env.provider.openModelTrajectoryTab({ requestId: 'm0' });
    assert.equal(pending().includes('call_0'), false);
    assert.ok(cards[0].classList.contains('flash'));
    await handle.dispose();
});

test('focusing a reply without a recorded call says so once; cached tokens and omitted context are shown', async () => {
    const recs = manyRecords(2);
    recs[1].response.usage = { inputTokens: 900, outputTokens: 50, totalTokens: 950, cachedInputTokens: 640, reasoningTokens: 30 };
    recs[1].request.omittedMessages = 7;
    const env = makeEnv({ recs });
    const handle = await env.provider.mountTab({ id: 'x' }, env.view);
    const card = env.view.querySelectorAll('.side-traj-call')[1];
    assert.match(card.querySelector('.side-traj-call-meta').textContent, /缓存 640/);
    assert.match([...card.querySelectorAll('.side-traj-call-meta span')].find(el => /OUT/.test(el.textContent)).title, /思考 30/);
    assert.match(card.querySelector('.side-traj-call-note').textContent, /更早的 7 条/);

    await env.provider.openModelTrajectoryTab({ requestId: 'no-such-message' });
    assert.equal(env.state.toasts.filter(text => /没有对应的调用记录/.test(text)).length, 1);
    env.fire({ sessionKey: 'agent1__t1', id: 'call_1', status: 'completed' });
    await wait(150);
    assert.equal(env.state.toasts.filter(text => /没有对应的调用记录/.test(text)).length, 1, 'a later reload does not repeat the notice');
    await handle.dispose();
});

test('a hidden tab defers change events and conversation switches until it is shown again', async () => {
    const { provider, view, state, fire } = makeEnv();
    let visible = true;
    const handle = await provider.mountTab({ id: 'x' }, view, { occurrence: { isVisible: () => visible } });
    const mounted = state.lists.length;

    // 已经排上的重读在藏起来时取消，留到重新显示
    fire({ sessionKey: 'agent1__t1', id: 'call_a', status: 'completed' });
    visible = false;
    handle.suspend();
    state.recs = [...state.recs, { ...records()[0], id: 'call_c', startedAt: 1700000009000 }];
    fire({ sessionKey: 'agent1__t1', id: 'call_c', status: 'completed' });
    fire({ sessionKey: 'agent1__t1', id: 'call_c', status: 'completed' });
    await wait(150);
    assert.equal(state.lists.length, mounted);

    visible = true;
    handle.resume();
    await wait(80);
    assert.equal(state.lists.length, mounted + 1);
    assert.equal(view.querySelectorAll('.side-traj-call').length, 3);

    // 藏着时切换话题：显示时读新话题
    visible = false;
    handle.suspend();
    state.conversation = { item: { id: 'agent2', name: '另一个' }, topicId: 't9' };
    state.conversationListeners[0]();
    await wait(80);
    assert.equal(state.lists.length, mounted + 1);
    visible = true;
    handle.resume();
    await wait(80);
    assert.equal(state.lists.at(-1)[0], 'agent2__t9');

    // 期间没有变化就不重读
    const settled = state.lists.length;
    visible = false;
    handle.suspend();
    visible = true;
    handle.resume();
    await wait(80);
    assert.equal(state.lists.length, settled);
    await handle.dispose();
});

test('releasing only the view scope tears down every listener, timer and subscription of the trajectory tab', async () => {
    const env = makeEnv();
    const view = createSidePaneRootScope(null, 'test-view');
    await env.provider.mountTab({ id: 'x' }, env.view, { scope: view });
    const { diagnostics } = globalThis.VCPLifecycle;
    const owned = diagnostics.snapshot().find(scope => scope.parentId === view.id);
    const types = new Set(owned.resources.map(resource => resource.type));
    assert.ok(types.has('listener') && types.has('subscription'), 'resources are held by the view scope');

    // 控制器让标签休眠时只释放 view scope，不一定先调 handle.dispose
    await view.dispose('dormant');
    assert.equal(env.wasUnsubscribed(), true);
    assert.equal(env.state.unwatch, 1);
    assert.equal(env.state.conversationUnsubscribed, true);
    assert.equal(diagnostics.snapshot().some(scope => scope.id === owned.id), false);
});

test('closing the trajectory tab while the push registration is pending leaves no subscription behind', async () => {
    const env = makeEnv();
    let finishWatch;
    let subscribed = 0;
    env.api.modelTrajectoryWatch = () => new Promise(resolve => { finishWatch = resolve; });
    env.api.onModelTrajectoryChanged = () => { subscribed += 1; return () => {}; };
    const view = createSidePaneRootScope(null, 'test-view');
    const mounting = env.provider.mountTab({ id: 'x' }, env.view, { scope: view });
    await wait(5);
    await view.dispose('mount-canceled');
    finishWatch({ success: true });
    assert.equal(await mounting, null);
    assert.equal(env.state.unwatch, 1, 'the main-process watch count is returned');
    assert.equal(subscribed, 0);
    assert.equal(env.state.conversationListeners.length, 0);
    assert.equal(env.state.lists.length, 0);
    assert.equal(env.view.innerHTML, '');
});
