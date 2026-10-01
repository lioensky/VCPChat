import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createModelTrajectorySideProvider, trajectoryKeyFor, EXPANSION_KINDS } from '../modules/ui-system/side-pane/modelTrajectorySideProvider.js';

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

function makeEnv({ conversation = { item: { id: 'agent1', name: '小助手' }, topicId: 't1' }, recs = records(), result } = {}) {
    const dom = new JSDOM('<div id="view"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const state = { lists: [], opened: [], toasts: [], watch: 0, copied: [], cleared: [], recs, conversation };
    let changed = null;
    let unsubscribed = false;
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async text => { state.copied.push(text); } } });
    dom.window.confirm = () => true;
    const api = {
        modelTrajectoryList: async (key, opts) => { state.lists.push([key, opts]); return result || { success: true, data: { records: state.recs, truncated: false, total: state.recs.length } }; },
        modelTrajectoryClear: async key => { state.cleared.push(key); state.recs = []; return { success: true }; },
        modelTrajectoryOpenDirectory: async () => ({ success: true }),
        modelTrajectoryWatch: async () => { state.watch += 1; return { success: true }; },
        onModelTrajectoryChanged: cb => { changed = cb; return () => { unsubscribed = true; }; }
    };
    const sidePaneController = { openTab: async tab => { state.opened.push(tab); return { focus() {} }; }, setVisible() {} };
    const provider = createModelTrajectorySideProvider({
        document: doc, api, sidePaneController, uiHelper: { showToastNotification: m => state.toasts.push(m) },
        getConversation: () => state.conversation
    });
    return { dom, doc, provider, state, view: doc.getElementById('view'), fire: c => changed?.(c), wasUnsubscribed: () => unsubscribed };
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
    handle.dispose();
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

    env = makeEnv();
    await env.provider.mountTab({ id: 'x' }, env.view);
    env.view.querySelector('[aria-label="清空这个话题的调用轨迹"]').click();
    await wait();
    assert.deepEqual(env.state.cleared, ['agent1__t1']);
});

test('truncated notice and dispose cleanup', async () => {
    const { provider, view, wasUnsubscribed } = makeEnv({ result: { success: true, data: { records: records(), truncated: true, total: 500 } } });
    const handle = await provider.mountTab({ id: 'x' }, view);
    assert.equal(view.querySelector('.side-traj-truncated').hidden, false);
    handle.dispose();
    assert.ok(wasUnsubscribed());
    assert.equal(view.innerHTML, '');
});
