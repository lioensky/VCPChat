'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const engine = require('../Flowlockmodules/flowlock-jev');

function harness(settings = {}, overrides = {}) {
    const timers = new Map(), calls = [], notices = [];
    let nextTimer = 0;
    const window = { VCPMainChatState: { snapshot: () => ({ selectedItem: null }) } };
    const sandbox = vm.createContext({ window, document: { getElementById: () => null }, console: { log() {}, warn() {}, error() {} }, setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id), Date, Math });
    for (const file of ['flowlock-protocol.js', 'flowlock-jev-prompts.js', 'flowlock-jev.js', 'flowlock-jev-controller.js', 'flowlock.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../Flowlockmodules', file), 'utf8'), sandbox, { filename: file });
    }
    const manager = window.flowlockManager;
    for (const key of ['updateSidebarIndicator', 'updateCurrentHeaderIndicator', 'triggerSidebarHeartbeat', 'triggerCurrentHeaderHeartbeat']) manager[key] = () => {};
    const config = { jevEnabled: true, ...settings };
    const api = { getAgentConfig: async () => ({ name: 'Nova' }), getChatHistory: async () => [{ role: 'user', content: '修复问题并验证测试' }], decideWithJev: async (state, questions) => { calls.push({ state, questions }); return { success: true, result: answerFor(questions) }; }, ...overrides };
    const dispatched = [];
    manager.initialize({ electronAPI: api, uiHelper: { showToastNotification: (...args) => notices.push(args) }, globalSettingsRef: { get: () => config }, continueWritingForContext: async args => { dispatched.push(args); } });
    let message = 0;
    const reply = (content, extra = {}) => manager.handleFinalizedMessage({ type: 'end', finishReason: 'completed', messageId: manager.sessions.get('a')?.activeMessageId || `reply-${++message}`, context: { agentId: 'a', topicId: 't' }, content, ...extra });
    return { manager, protocol: window.flowlockProtocol, timers, calls, notices, dispatched, config, api, reply };
}
function answerFor(questions, { lifecycle = 'continue', action = 'action_1', confidence = 0.95, evidence = 0.97, allowed = 0.96, progress = 0.96 } = {}) {
    const answers = {};
    for (const [key, question] of Object.entries(questions)) {
        if (question.type === 'choice') {
            const choice = key === 'lifecycle' ? lifecycle : action;
            answers[key] = { type: 'choice', choice, confidence, probabilities: Object.fromEntries(Object.keys(question.criteria).map(k => [k, k === choice ? 1 : 0])) };
        } else answers[key] = { type: 'noul', noul: key === 'completion_supported' ? evidence : key.endsWith('_allowed') ? allowed : progress };
    }
    return { answers };
}
function proposal(candidates = [{ id: 'verify', action: '运行针对性测试', reason: '验证修复', delaySeconds: 2 }]) {
    return '[[Flowlock::Candidates]]' + JSON.stringify({ summary: '修复已写入，等待验证', candidates }) + '[[/Flowlock::Candidates]]';
}
function requestFor(candidates) {
    const h = harness();
    return engine.buildRequest({ session: { agentId: 'a', topicId: 't', round: 1 }, plan: engine.parseCandidates(proposal(candidates), h.protocol), history: [{ role: 'user', content: '修复并验证' }], content: '修复已写入' });
}
test('candidate parser ignores fenced, tool-result and thought proposals', () => {
    const { protocol } = harness();
    for (const text of ['```json\n' + proposal() + '\n```', '[[VCP调用结果信息汇总:' + proposal() + 'VCP调用结果结束]]', '<think>\n' + proposal() + '\n</think>']) assert.equal(engine.parseCandidates(text, protocol), null);
    assert.equal(engine.parseCandidates(proposal(), protocol).candidates[0].id, 'verify');
});
test('candidate parser rejects invalid JSON, duplicate IDs, oversized actions and invalid delays', () => {
    const { protocol } = harness();
    for (const text of ['[[Flowlock::Candidates]]{}', '[[Flowlock::Candidates]]no[[/Flowlock::Candidates]]', proposal([{ id: 'x', action: 'a' }, { id: 'x', action: 'b' }]), proposal([{ id: 'x', action: 'a', delaySeconds: -1 }]), proposal([{ id: 'x', action: 'x'.repeat(2001) }]), proposal([{ id: 'x', action: '[[Flowlock::Stop]]' }]), proposal() + proposal()]) assert.throws(() => engine.parseCandidates(text, protocol));
});
test('proposal contents cannot inject control commands and rendering escapes HTML', () => {
    const { protocol } = harness();
    const text = '[[Flowlock::Candidates]]\n{"candidates":[]}\n[[Flowlock::Stop]]\n[[/Flowlock::Candidates]]';
    assert.equal(protocol.parse(text).terminalType, null);
    const html = protocol.transformForRender(proposal([{ id: 'x', action: '<img src=x onerror=alert(1)>' }]));
    assert.match(html, /等待 JEV/);
    assert.ok(!html.includes('<img'));
});
test('one request separates lifecycle, completion, routing, authorization and progress', () => {
    const request = requestFor();
    assert.deepEqual(Object.keys(request.questions), ['lifecycle', 'completion_supported', 'action_1_allowed', 'action_1_progress', 'next_action']);
    assert.ok(request.questions.lifecycle.instructions.length > 1200);
    assert.ok(request.questions.next_action.instructions.includes('假设'));
    assert.ok(request.questions.next_action.criteria.none);
    assert.equal(request.state.goal, '修复并验证');
});
test('only the known JEV-selected candidate is returned', () => {
    const request = requestFor([{ id: 'read', action: '读错误日志' }, { id: 'verify', action: '运行测试' }]);
    const decision = engine.parseDecision(answerFor(request.questions, { action: 'action_2' }), request);
    assert.equal(decision.type, 'execute');
    assert.equal(decision.candidate.id, 'verify');
});
test('completion requires evidence, but unused branch uncertainty is ignored', () => {
    const request = requestFor();
    const result = answerFor(request.questions, { lifecycle: 'complete', evidence: 0.99 });
    delete result.answers.next_action; delete result.answers.action_1_allowed;
    assert.equal(engine.parseDecision(result, request).type, 'complete');
    result.answers.completion_supported.noul = 0.5;
    assert.equal(engine.parseDecision(result, request).reason, 'completion_unverified');
});
test('uncertainty and authorization fail closed; no-match requests bounded replanning', () => {
    const request = requestFor();
    for (const options of [{ confidence: 0.5 }, { allowed: 0.5 }]) assert.equal(engine.parseDecision(answerFor(request.questions, options), request).type, 'stop');
    for (const options of [{ action: 'none' }, { progress: 0.2 }]) assert.equal(engine.parseDecision(answerFor(request.questions, options), request).type, 'replan');
    assert.throws(() => engine.parseDecision(answerFor(request.questions, { action: 'invented' }), request));
    const bad = answerFor(request.questions); bad.answers.lifecycle.probabilities.continue = NaN;
    assert.throws(() => engine.parseDecision(bad, request));
});
test('empty candidates still allow independently verified completion', () => {
    const request = requestFor([]);
    assert.equal(request.questions.next_action, undefined);
    assert.equal(engine.parseDecision(answerFor(request.questions, { lifecycle: 'complete' }), request).type, 'complete');
    assert.equal(engine.parseDecision(answerFor(request.questions), request).type, 'replan');
});
test('first heartbeat plans, JEV selects, then exactly one action executes', async () => {
    const h = harness(); await h.manager.start('a', 't');
    await h.manager.triggerRound('a');
    assert.match(h.dispatched[0].prompt, /候选规划轮/);
    await h.reply(proposal());
    assert.equal(h.calls.length, 1);
    assert.equal(h.manager.getSession('a').jev.phase, 'ready');
    assert.equal(h.timers.get(h.manager.sessions.get('a').pendingTimer).ms, 2000);
    await h.manager.triggerRound('a');
    assert.match(h.dispatched[1].prompt, /JEV 已选择以下唯一动作/);
    assert.match(h.dispatched[1].prompt, /运行针对性测试/);
    await h.manager.triggerRound('a');
    assert.equal(h.dispatched.length, 2);
});
test('Agent terminal markers are only proposals when JEV is enabled', async () => {
    const h = harness(); await h.manager.start('a', 't');
    await h.reply('[[Flowlock::Complete]]\n' + proposal());
    assert.equal(h.manager.getSession('a').jev.lastDecision.type, 'execute');
});
test('JEV completion stops session and clears all pending timers', async () => {
    const h = harness({}, { decideWithJev: async (_state, questions) => ({ success: true, result: answerFor(questions, { lifecycle: 'complete' }) }) });
    await h.manager.start('a', 't'); const session = h.manager.sessions.get('a');
    await h.reply(proposal([]));
    assert.equal(h.manager.getSession('a'), null);
    assert.equal(session.completionReason, 'jev_complete');
    assert.equal(h.timers.size, 0);
});
test('missing or malformed candidates replan at most three times', async () => {
    const h = harness(); await h.manager.start('a', 't'); const session = h.manager.sessions.get('a');
    await h.reply('请继续'); await h.reply('我正在考虑'); await h.reply('继续');
    assert.equal(h.calls.length, 0);
    assert.equal(h.manager.getSession('a'), null);
    assert.equal(session.completionReason, 'jev_invalid_candidates');
});
test('duplicate finalization is adjudicated once', async () => {
    const h = harness(); await h.manager.start('a', 't');
    await Promise.all([h.reply(proposal(), { messageId: 'same' }), h.reply(proposal(), { messageId: 'same' })]);
    assert.equal(h.calls.length, 1);
});
test('manual stop during JEV request prevents stale action and restart', async () => {
    let release; const entered = [];
    const h = harness({}, { decideWithJev: async (_state, questions) => { entered.push(questions); return new Promise(resolve => { release = () => resolve({ success: true, result: answerFor(questions) }); }); } });
    await h.manager.start('a', 't');
    const pending = h.reply(proposal());
    for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
    assert.equal(entered.length, 1);
    assert.equal(h.manager.getSession('a').jev.pending, true);
    await h.manager.triggerRound('a'); assert.equal(h.dispatched.length, 0);
    await h.manager.stop('a');
    await h.manager.start('a', 'new-topic');
    release(); await pending;
    assert.equal(h.manager.getSession('a').topicId, 'new-topic');
    assert.equal(h.manager.getSession('a').jev.lastDecision, null);
    assert.equal(h.timers.size, 0);
});
test('late stopped heartbeat containing Start cannot reactivate the lock', async () => {
    const h = harness(); await h.manager.start('a', 't'); await h.manager.triggerRound('a');
    const id = h.dispatched[0].messageId;
    assert.equal(h.dispatched[0].isSessionCurrent(), true);
    await h.manager.stop('a');
    assert.equal(h.dispatched[0].isSessionCurrent(), false);
    await h.reply('[[Flowlock::Start]]\n' + proposal(), { messageId: id });
    assert.equal(h.manager.getSession('a'), null);
});
test('service rejection, malformed response and unreadable history stop without fallback', async () => {
    for (const overrides of [
        { decideWithJev: async () => ({ success: false, error: 'service unavailable' }) },
        { decideWithJev: async () => ({ success: true, result: {} }) },
        { getChatHistory: async () => ({ error: 'unavailable' }) }
    ]) {
        const h = harness({}, overrides); await h.manager.start('a', 't'); const session = h.manager.sessions.get('a');
        await h.reply(proposal());
        assert.equal(session.completionReason, 'jev_error');
        assert.equal(h.manager.getSession('a'), null);
        assert.equal(h.dispatched.length, 0);
        assert.equal(h.timers.size, 0);
    }
});
test('round budget and disabling JEV halt execution without legacy fallback', async () => {
    const h = harness({ flowlockJevMaxRounds: 1 }); await h.manager.start('a', 't'); await h.manager.triggerRound('a');
    await h.reply(proposal());
    assert.equal(h.manager.getSession('a'), null);
    const other = harness(); await other.manager.start('a', 't'); other.config.jevEnabled = false;
    await other.manager.triggerRound('a');
    assert.equal(other.manager.getSession('a'), null);
    assert.equal(other.dispatched.length, 0);
});
test('legacy mode remains available with JEV disabled or per-feature opt-out', async () => {
    for (const settings of [{ jevEnabled: false }, { flowlockJevEnabled: false }]) {
        const h = harness(settings); await h.manager.start('a', 't');
        assert.equal(h.manager.getSession('a').jev, null);
        await h.reply('[[Flowlock::Complete]]');
        assert.equal(h.manager.getSession('a'), null); assert.equal(h.calls.length, 0);
    }
});
test('two agents keep independent decision state and timers', async () => {
    const h = harness(); await h.manager.start('a', 't'); await h.manager.start('b', 'other');
    await h.reply(proposal());
    await h.manager.handleFinalizedMessage({ type: 'end', messageId: 'b-final', context: { agentId: 'b', topicId: 'other' }, content: proposal() });
    await h.manager.stop('a');
    assert.equal(h.manager.getSession('b').jev.lastDecision.type, 'execute');
    assert.equal(h.manager.getSession('b').topicId, 'other');
});

test('candidate blocks embedded inside NextPrompt are not executable proposals', () => {
    const { protocol } = harness();
    assert.equal(engine.parseCandidates('[[Flowlock::NextPrompt]]' + proposal() + '[[/Flowlock::NextPrompt]]', protocol), null);
});
test('new user input during JEV adjudication invalidates the result', async () => {
    let reads = 0;
    const h = harness({}, { getChatHistory: async () => [{ role: 'user', content: ++reads === 1 ? '修复问题' : '停下，换个任务' }] });
    await h.manager.start('a', 't'); const session = h.manager.sessions.get('a');
    await h.reply(proposal());
    assert.equal(session.completionReason, 'jev_error');
    assert.equal(h.manager.getSession('a'), null);
    assert.equal(h.dispatched.length, 0);
});
test('JEV timeout stops safely even when the IPC reply never arrives', async () => {
    const h = harness({}, { decideWithJev: async () => new Promise(() => {}) });
    await h.manager.start('a', 't'); const session = h.manager.sessions.get('a');
    const pending = h.reply(proposal());
    for (let i = 0; i < 10 && ![...h.timers.values()].some(t => t.ms === 120000); i++) await Promise.resolve();
    const timer = [...h.timers.values()].find(t => t.ms === 120000);
    assert.ok(timer); timer.fn(); await pending;
    assert.equal(session.completionReason, 'jev_error');
    assert.equal(h.manager.getSession('a'), null);
});
