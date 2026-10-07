import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createModelTrajectorySideProvider, trajectoryKeyFor, EXPANSION_KINDS } from '../modules/ui-system/side-pane/modelTrajectorySideProvider.js';
import { createSidePaneRootScope } from '../modules/ui-system/side-pane/side-pane-occurrence.js';
import { waitFor } from './helpers/wait-for.mjs';

// 只冲掉 IPC stub 的 promise；setImmediate 不被 mock.timers 接管
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };
// 重读（80ms）和搜索（120ms）的防抖都走 lifecycle scope 的全局 setTimeout：挂载前接管，用 tick 推进
const RELOAD_MS = 80;
const SEARCH_MS = 120;
const fakeTimers = (t) => {
    mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => mock.timers.reset());
};
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

function makeEnv({ conversation = { item: { id: 'agent1', name: '小助手' }, topicId: 't1' }, recs = records(), result, showConfirmDialog } = {}) {
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
        document: doc, api, sidePaneController, uiHelper: { showToastNotification: m => state.toasts.push(m), ...(showConfirmDialog ? { showConfirmDialog } : {}) },
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
    const summary = view.querySelector('.side-traj-summary');
    assert.equal(summary.dataset.callCount, '2');
    assert.match(summary.textContent, /1,?280/);
    assert.match(summary.textContent, /deepseek-v4/);
    const cards = view.querySelectorAll('.side-traj-call');
    assert.equal(cards.length, 2);
    const meta = cards[0].querySelector('.side-traj-call-meta').textContent;
    assert.match(cards[0].textContent, /01/);
    assert.match(meta, /1,?200/);
    assert.match(meta, /\b80\b/);
    assert.match(meta, /1\.50?\D/);
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
    const expanded = role => view.querySelector(`.side-traj-row[data-trajectory-role="${role}"] .side-traj-row-head`).getAttribute('aria-expanded');
    assert.equal(expanded('user'), 'true');
    view.querySelector('.side-traj-row[data-trajectory-role="user"] .side-traj-row-head').click();
    assert.equal(expanded('user'), 'false');
    view.querySelector('[data-action="expansion-menu"]').click();
    assert.equal(view.querySelectorAll('[role="menuitemcheckbox"]').length, EXPANSION_KINDS.length);
    view.querySelector('[data-trajectory-expansion-kind="system"]').click();
    assert.equal(expanded('system'), 'false');
    view.querySelector('[data-action="toggle-all"]').click();
    assert.equal(expanded('system'), 'true');
    assert.equal(expanded('user'), 'true');
    doc.body.click();
    assert.equal(view.querySelector('.side-traj-menu').hidden, true);
});

test('search counts matches, handles no-match, and Escape closes', async (t) => {
    fakeTimers(t);
    const { provider, view } = makeEnv();
    await provider.mountTab({ id: 'model-trajectory:main' }, view);
    view.querySelector('[data-action="search"]').click();
    const input = view.querySelector('.side-traj-search-input');
    const count = view.querySelector('.side-traj-search-count');
    typeInto(input, 'hello');
    mock.timers.tick(SEARCH_MS - 1);
    assert.equal(count.textContent, '0/0', 'debounced');
    mock.timers.tick(1);
    assert.equal(count.textContent, '1/1');
    typeInto(input, 'zzz-nothing');
    mock.timers.tick(SEARCH_MS);
    assert.equal(count.textContent, '0/0');
    typeInto(input, 'FileOperator');
    mock.timers.tick(SEARCH_MS);
    assert.match(count.textContent, /^1\/\d+$/);
    assert.notEqual(count.textContent, '1/1');
    view.querySelector('[data-action="search-next"]').click();
    assert.match(count.textContent, /^2\//);
    input.dispatchEvent(new input.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(view.querySelector('.side-traj-search').hidden, true);
});

test('a collapsed row containing the active match is revealed', async (t) => {
    fakeTimers(t);
    const { provider, view } = makeEnv();
    await provider.mountTab({ id: 'model-trajectory:main' }, view);
    const head = view.querySelector('.side-traj-row[data-trajectory-role="tool-result"] .side-traj-row-head');
    head.click();
    assert.equal(head.getAttribute('aria-expanded'), 'false');
    view.querySelector('[data-action="search"]').click();
    typeInto(view.querySelector('.side-traj-search-input'), 'hello world');
    mock.timers.tick(SEARCH_MS);
    assert.equal(head.getAttribute('aria-expanded'), 'true');
});

test('copy button copies the message content', async () => {
    const { provider, view, state } = makeEnv();
    await provider.mountTab({ id: 'model-trajectory:main' }, view);
    view.querySelector('.side-traj-row[data-trajectory-role="user"] .side-traj-row-copy').click();
    await waitFor(() => state.copied.length === 1, { message: 'nothing copied' });
    assert.deepEqual(state.copied, ['帮我读一下文件']);
});

test('change events reload only for the current session', async (t) => {
    fakeTimers(t);
    const { provider, view, state, fire } = makeEnv();
    await provider.mountTab({ id: 'model-trajectory:main' }, view);
    const before = state.lists.length;
    fire({ sessionKey: 'other__x', id: 'z', status: 'completed' });
    mock.timers.tick(RELOAD_MS * 2);
    await settle();
    assert.equal(state.lists.length, before);
    state.recs = [...state.recs, { ...records()[0], id: 'call_c', startedAt: 1700000009000 }];
    fire({ sessionKey: 'agent1__t1', id: 'call_c', status: 'completed' });
    fire({ sessionKey: 'agent1__t1', id: 'call_c', status: 'completed' });
    mock.timers.tick(RELOAD_MS);
    await settle();
    assert.equal(state.lists.length, before + 1, 'a burst of changes is read once');
    assert.equal(view.querySelectorAll('.side-traj-call').length, 3);
});

test('empty and no-conversation states, list errors, clear', async (t) => {
    let env = makeEnv({ conversation: { item: null, topicId: null } });
    await env.provider.mountTab({ id: 'x' }, env.view);
    assert.equal(env.view.querySelector('.side-traj-state').hidden, false);
    assert.equal(env.view.querySelector('.side-traj-state').dataset.state, 'no-conversation');
    assert.equal(env.state.lists.length, 0);

    env = makeEnv({ recs: [] });
    await env.provider.mountTab({ id: 'x' }, env.view);
    assert.equal(env.view.querySelector('.side-traj-state').dataset.state, 'empty');
    assert.equal(env.view.querySelector('[data-action="search"]').hidden, true);

    env = makeEnv({ result: { success: false, error: 'boom' } });
    await env.provider.mountTab({ id: 'x' }, env.view);
    assert.equal(env.view.querySelector('.side-traj-state').dataset.state, 'error');
    assert.match(env.view.querySelector('.side-traj-state').textContent, /boom/);

    // 主进程还是旧的（没注册这组接口）：invoke 抛错，页面要留着并提示重启，而不是让 mountTab 抛出
    env = makeEnv();
    const missingHandler = new Error("Error invoking remote method 'model-trajectory:list': Error: No handler registered for 'model-trajectory:list'");
    const failing = createModelTrajectorySideProvider({
        document: env.doc, api: { modelTrajectoryList: async () => { throw missingHandler; } }, sidePaneController: {},
        getConversation: () => env.state.conversation
    });
    const handle = await failing.mountTab({ id: 'x' }, env.view);
    // 没有切换通知时它会轮询兜底：断言失败也要拆掉，否则定时器让进程退不出去
    t.after(() => handle.dispose());
    assert.equal(env.view.querySelector('.side-traj-state').hidden, false);
    assert.equal(env.view.querySelector('.side-traj-state').dataset.state, 'service-missing');
    await handle.dispose();

    env = makeEnv();
    await env.provider.mountTab({ id: 'x' }, env.view);
    assert.equal(env.view.querySelector('.side-traj-state').dataset.state, undefined, 'no state panel over a populated timeline');
    env.view.querySelector('[data-action="clear"]').click();
    await waitFor(() => env.state.cleared.length === 1, { message: 'clear did not run' });
    assert.deepEqual(env.state.cleared, ['agent1__t1']);
});

test('switching conversation reloads through the selection subscription, and dispose unsubscribes', async () => {
    const { provider, view, state } = makeEnv();
    const handle = await provider.mountTab({ id: 'x' }, view);
    assert.equal(state.conversationListeners.length, 1);
    state.conversation = { item: { id: 'agent2', name: '另一个' }, topicId: 't9' };
    state.conversationListeners[0]();
    await waitFor(() => state.lists.at(-1)[0] === 'agent2__t9', { message: 'did not reload the new conversation' });
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

test('cards are built lazily: the newest ones at once, the rest when scrolled near, searched or focused', async (t) => {
    fakeTimers(t);
    const env = makeEnv({ recs: manyRecords(8) });
    const observers = installObserver(env.dom.window);
    const handle = await env.provider.mountTab({ id: 'x' }, env.view);
    const cards = [...env.view.querySelectorAll('.side-traj-call')];
    assert.equal(cards.length, 8);
    // 未构建的卡片没有消息行；按卡片序号（最旧在前）记
    const pending = () => cards.flatMap((card, index) => (card.querySelector('.side-traj-row') ? [] : [index]));
    assert.deepEqual(pending(), [0, 1, 2, 3, 4]);
    assert.equal(cards[0].querySelector('.side-traj-row'), null, 'an unbuilt card has no message rows');
    assert.equal(observers[0].targets.size, 5);

    observers[0].reveal(cards[3]);
    assert.ok(cards[3].querySelector('.side-traj-row'));
    assert.equal(observers[0].targets.has(cards[3]), false);

    // 搜索命中的卡片（call_1）会先构建出来
    env.view.querySelector('[data-action="search"]').click();
    typeInto(env.view.querySelector('.side-traj-search-input'), '独有词');
    mock.timers.tick(SEARCH_MS);
    assert.equal(env.view.querySelector('.side-traj-search-count').textContent, '1/1');
    assert.equal(pending().includes(1), false);

    // 消息右键「查看调用轨迹」：定位到 m0，卡片构建并闪烁
    await env.provider.openModelTrajectoryTab({ requestId: 'm0' });
    assert.equal(pending().includes(0), false);
    assert.ok(cards[0].classList.contains('flash'));
    await handle.dispose();
});

test('focusing a reply without a recorded call says so once; cached tokens and omitted context are shown', async (t) => {
    fakeTimers(t);
    const recs = manyRecords(2);
    recs[1].response.usage = { inputTokens: 900, outputTokens: 50, totalTokens: 950, cachedInputTokens: 640, reasoningTokens: 30 };
    recs[1].request.omittedMessages = 7;
    const env = makeEnv({ recs });
    const handle = await env.provider.mountTab({ id: 'x' }, env.view);
    const card = env.view.querySelectorAll('.side-traj-call')[1];
    assert.match(card.querySelector('.side-traj-call-meta').textContent, /\b640\b/);
    // 思考 token 数挂在输出 token 那一段的 title 上
    assert.match([...card.querySelectorAll('.side-traj-call-meta span')].find(el => /\b50\b/.test(el.textContent)).title, /\b30\b/);
    assert.match(card.querySelector('.side-traj-call-note').textContent, /\b7\b/);

    const toasts = env.state.toasts.length;
    await env.provider.openModelTrajectoryTab({ requestId: 'no-such-message' });
    assert.equal(env.state.toasts.length, toasts + 1);
    env.fire({ sessionKey: 'agent1__t1', id: 'call_1', status: 'completed' });
    const reads = env.state.lists.length;
    mock.timers.tick(RELOAD_MS);
    await settle();
    assert.equal(env.state.lists.length, reads + 1);
    assert.equal(env.state.toasts.length, toasts + 1, 'a later reload does not repeat the notice');
    await handle.dispose();
});

test('a hidden tab defers change events and conversation switches until it is shown again', async (t) => {
    fakeTimers(t);
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
    // 取消定时器的 clearTimeout 在 scope 的微任务里执行：先冲掉再推进时间
    await settle();
    mock.timers.tick(RELOAD_MS * 2);
    await settle();
    assert.equal(state.lists.length, mounted);

    visible = true;
    handle.resume();
    await settle();
    mock.timers.tick(RELOAD_MS * 2);
    await settle();
    assert.equal(state.lists.length, mounted + 1);
    assert.equal(view.querySelectorAll('.side-traj-call').length, 3);

    // 藏着时切换话题：显示时读新话题
    visible = false;
    handle.suspend();
    state.conversation = { item: { id: 'agent2', name: '另一个' }, topicId: 't9' };
    state.conversationListeners[0]();
    mock.timers.tick(RELOAD_MS * 2);
    await settle();
    assert.equal(state.lists.length, mounted + 1);
    visible = true;
    handle.resume();
    await settle();
    assert.equal(state.lists.at(-1)[0], 'agent2__t9');

    // 期间没有变化就不重读
    const settled = state.lists.length;
    visible = false;
    handle.suspend();
    visible = true;
    handle.resume();
    mock.timers.tick(RELOAD_MS * 2);
    await settle();
    assert.equal(state.lists.length, settled);
    await handle.dispose();
});

test('releasing only the view scope tears down every listener, timer and subscription of the trajectory tab', async () => {
    const env = makeEnv();
    const view = createSidePaneRootScope(null, 'test-view');
    await env.provider.mountTab({ id: 'x' }, env.view, { scope: view });
    const { diagnostics } = globalThis.VCPLifecycle;
    const owned = diagnostics.snapshot().find(scope => scope.parentId === view.id);
    assert.ok(owned, 'the tab scope hangs off the view scope');

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
    await waitFor(() => finishWatch, { message: 'watch was not requested' });
    await view.dispose('mount-canceled');
    finishWatch({ success: true });
    assert.equal(await mounting, null);
    assert.equal(env.state.unwatch, 1, 'the main-process watch count is returned');
    assert.equal(subscribed, 0);
    assert.equal(env.state.conversationListeners.length, 0);
    assert.equal(env.state.lists.length, 0);
    assert.equal(env.view.innerHTML, '');
});

test('opening from a side chat reads the child topic and finds its reply; a main chat switch goes back to following', async () => {
    const env = makeEnv({ recs: manyRecords(2) });
    const handle = await env.provider.mountTab({ id: 'x' }, env.view);
    assert.equal(env.state.lists.at(-1)[0], 'agent1__t1');

    const child = { item: { id: 'agent1', name: '辅助对话 1' }, topicId: 'sidechat_1' };
    const lastKey = () => env.state.lists.at(-1)[0];
    const toasts = env.state.toasts.length;
    await env.provider.openModelTrajectoryTab({ requestId: 'm1', conversation: child });
    await waitFor(() => lastKey() === 'agent1__sidechat_1', { message: 'child topic not read' });
    await waitFor(() => env.view.querySelectorAll('.side-traj-call')[1]?.classList.contains('flash'), { message: 'reply not focused' });
    assert.equal(env.state.toasts.length, toasts, 'no "not found" notice for a reply that exists');

    env.state.conversation = { item: { id: 'agent2', name: '另一个' }, topicId: 't9' };
    env.state.conversationListeners[0]();
    await waitFor(() => lastKey() === 'agent2__t9', { message: 'main chat switch not followed' });

    await env.provider.openModelTrajectoryTab({ requestId: 'm0', conversation: child });
    await waitFor(() => lastKey() === 'agent1__sidechat_1');
    await env.provider.openModelTrajectoryTab();
    await waitFor(() => lastKey() === 'agent2__t9', { message: 'opening from the main chat follows the main chat again' });
    await handle.dispose();
});

test('rebuilding cards on every change does not pile up listener records on the view scope', async (t) => {
    fakeTimers(t);
    const env = makeEnv({ recs: manyRecords(3) });
    const view = createSidePaneRootScope(null, 'test-view');
    const handle = await env.provider.mountTab({ id: 'x' }, env.view, { scope: view });
    const { diagnostics } = globalThis.VCPLifecycle;
    const owned = () => diagnostics.snapshot().find(scope => scope.parentId === view.id).resources.length;
    const before = owned();
    for (let i = 0; i < 10; i++) {
        env.state.recs = env.state.recs.map(record => ({ ...record, endedAt: record.endedAt + 1 }));
        env.fire({ sessionKey: 'agent1__t1' });
        mock.timers.tick(RELOAD_MS);
        await settle();
    }
    assert.ok(env.state.lists.length > 10, 'the cards were rebuilt on each change');
    assert.equal(owned(), before);
    // 行内的复制按钮仍然能用
    env.view.querySelector('.side-traj-row-copy:not([disabled])').click();
    await settle();
    assert.equal(env.state.copied.length, 1);
    await handle.dispose();
    await view.dispose('test');
});

test('a reader parked at the top of the trajectory stays there while new calls arrive', async (t) => {
    fakeTimers(t);
    const env = makeEnv({ recs: manyRecords(4) });
    const handle = await env.provider.mountTab({ id: 'x' }, env.view);
    const scroller = env.view.querySelector('.side-traj-scroll');
    // jsdom 没有布局：给出一个比视口高的内容
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 5000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 400 });
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new env.dom.window.Event('scroll'));
    env.state.recs = [...env.state.recs, ...manyRecords(6).slice(4)];
    env.fire({ sessionKey: 'agent1__t1' });
    mock.timers.tick(RELOAD_MS);
    await settle();
    assert.equal(env.view.querySelectorAll('.side-traj-call').length, 6);
    assert.equal(scroller.scrollTop, 0);
    await handle.dispose();
});

test('the expansion menu works from the keyboard and keeps focus on the switch being toggled', async () => {
    const { provider, view, doc, dom } = makeEnv();
    await provider.mountTab({ id: 'model-trajectory:main' }, view);
    const menuBtn = view.querySelector('[data-action="expansion-menu"]');
    const menu = view.querySelector('.side-traj-menu');
    const key = (target, name) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    assert.equal(menuBtn.getAttribute('aria-haspopup'), 'menu');
    menuBtn.focus();
    menuBtn.click();
    assert.equal(menuBtn.getAttribute('aria-expanded'), 'true');
    const items = () => [...menu.querySelectorAll('[role="menuitemcheckbox"]')];
    assert.equal(doc.activeElement, items()[0], 'opening moves focus into the menu');
    key(doc.activeElement, 'ArrowDown');
    assert.equal(doc.activeElement, items()[1]);
    const kind = doc.activeElement.dataset.trajectoryExpansionKind;
    doc.activeElement.click();
    assert.equal(doc.activeElement?.dataset.trajectoryExpansionKind, kind, 'toggling a switch keeps focus on it');
    assert.equal(doc.activeElement.getAttribute('aria-checked'), 'false');
    key(doc.activeElement, 'Escape');
    assert.equal(menu.hidden, true);
    assert.equal(menuBtn.getAttribute('aria-expanded'), 'false');
    assert.equal(doc.activeElement, menuBtn, 'Escape returns focus to the menu button');
});

test('clearing asks through the app dialog, not window.confirm, and clears the conversation it was asked for', async () => {
    let answer;
    const asked = [];
    const env = makeEnv({ showConfirmDialog: (...args) => { asked.push(args); return new Promise(resolve => { answer = resolve; }); } });
    env.dom.window.confirm = () => { throw new Error('native confirm must not be used'); };
    await env.provider.mountTab({ id: 'x' }, env.view);
    env.view.querySelector('[data-action="clear"]').click();
    await waitFor(() => asked.length === 1, { message: 'the app confirm dialog is shown' });
    assert.equal(asked[0][4], true, 'it is marked as a destructive action');
    // The user switches conversation while the dialog is open, then confirms
    env.state.conversation = { item: { id: 'agent2', name: '另一个' }, topicId: 't9' };
    env.state.conversationListeners.forEach(listener => listener());
    await waitFor(() => env.state.lists.at(-1)[0] === 'agent2__t9');
    answer(true);
    await waitFor(() => env.state.cleared.length > 0, { message: 'nothing cleared' });
    assert.deepEqual(env.state.cleared, ['agent1__t1'], 'only the conversation shown when Clear was clicked is cleared');
});
