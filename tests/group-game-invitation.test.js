'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function fixture(t, mode, stream) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vgame-invite-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const filename = path.resolve(__dirname, '../Groupmodules/groupchat.js');
    const localRequire = createRequire(filename);
    const requests = [], trajectories = [];
    let requestHook = null;
    let activeRules = [];
    const module = { exports: {} };
    const sandbox = {
        module, exports: module.exports, console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, AbortController, TextDecoder, URL,
        fetch: async (_url, options) => {
            requests.push(JSON.parse(options.body));
            await requestHook?.(requests.length);
            if (!stream) return new Response(JSON.stringify({
                choices: [{ message: { content: 'RAW_PRIVATE_RESPONSE' } }],
            }), { headers: { 'Content-Type': 'application/json' } });
            const data = 'data: ' + JSON.stringify({
                choices: [{ delta: { content: 'RAW_PRIVATE_RESPONSE' } }],
            }) + '\n\ndata: [DONE]\n\n';
            return new Response(data, { headers: { 'Content-Type': 'text/event-stream' } });
        },
        require: name => {
            if (name === 'electron') return { ipcMain: {} };
            if (name === '../modules/modelTrajectory') return {
                beginTrajectoryCall: details => {
                    trajectories.push(details);
                    return { chunk() {}, finish() {} };
                },
                sessionKeyFromContext: () => 'session',
                sourceFromContext: value => value,
            };
            if (name === '../modules/contextSanitizer') return {
                stripThoughtChains: value => value, sanitizeMessages: value => value,
            };
            if (name === '../modules/ipc/tavernHandlers') return { getActiveRules: () => activeRules };
            if (name === '../modules/tavernRulesEngine') return localRequire(name);
            if (name === './topicTitleManager') return { triggerSummarizationIfNeeded: async () => {} };
            if (name === './jevGroupSessionOrchestrator') return localRequire(name);
            if (['../modules/fileManager', '../modules/ipc/canvasHandlers',
                '../modules/tavernRulesEngine', './topicTitleManager',
                './jevGroupSessionOrchestrator'].includes(name)) return {};
            return localRequire(name);
        },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    const api = module.exports;
    localRequire('../modules/services/conversationContext').initialize({
        load: owner => {
            assert.equal(owner.type, 'group');
            return api.getAgentGroupConfig(owner.id);
        },
        update: (owner, mutate) => api.mutateGroupConfig(owner.id, mutate),
        workspace: () => ({ workspaces: [], activeWorkspaceId: null }),
        rules: async () => ({ rules: activeRules }),
    });
    const settingsFile = path.join(root, 'settings.json');
    await fsp.writeFile(settingsFile, JSON.stringify({
        vcpServerUrl: 'http://localhost:1234/v1/chat/completions', vcpApiKey: 'test',
    }));
    api.initializePaths({
        APP_DATA_ROOT_IN_PROJECT: root, USER_DATA_DIR: path.join(root, 'users'),
        AGENT_DIR: path.join(root, 'agents'), SETTINGS_FILE: settingsFile,
    });
    const created = await api.createAgentGroup('table', {
        mode, members: ['a'], groupPrompt: 'GAME_RULES_WITHOUT_WATCHER',
        modeSettings: { game: { gameTypeId: 'doudizhu' } },
        enableContextMessageWindow: true, contextMessageWindowSize: 1,
    });
    assert.equal(created.success, true);
    const groupId = created.agentGroup.id, topicId = created.agentGroup.topics[0].id;
    await api.appendGroupHistoryMessage(groupId, topicId, {
        id: 'old', role: 'user', name: '玩家', content: 'OLD_PUBLIC',
    });
    await api.appendGroupHistoryMessage(groupId, topicId, {
        id: 'latest', role: 'user', name: '玩家', content: 'LATEST_PUBLIC',
    });
    const invoke = options => api.handleInviteAgentToSpeak(
        groupId, topicId, 'a', undefined,
        async () => ({ id: 'a', name: 'Agent A', model: 'test', systemPrompt: 'PERSONA', streamOutput: stream }),
        { skipSummary: true, ...options },
    );
    return { api, root, groupId, topicId, invoke, requests, trajectories,
        setRequestHook(hook) { requestHook = hook; },
        setRules(rules) { activeRules = rules; } };
}
for (const stream of [false, true]) {
    test(`game ${stream ? '流式' : '非流式'}：私有invite仅在本次请求，原始回复不入公共历史或轨迹`, async t => {
        const f = await fixture(t, 'game', stream);
        await f.invoke({ invitePrompt: 'PRIVATE_HAND_S3_H4' });
        const body = JSON.stringify(f.requests[0]);
        assert.match(body, /PRIVATE_HAND_S3_H4/);
        assert.match(body, /GAME_RULES_WITHOUT_WATCHER/);
        assert.match(body, /LATEST_PUBLIC/);
        assert.doesNotMatch(body, /OLD_PUBLIC/);
        const history = await f.api.getGroupChatHistory(f.groupId, f.topicId);
        assert.equal(history.length, 2);
        assert.doesNotMatch(JSON.stringify(history), /PRIVATE_HAND|RAW_PRIVATE_RESPONSE/);
        assert.equal(f.trajectories.length, 0);
    });
}
test('普通邀请仍保存回复及轨迹，不含watcher的groupPrompt正常注入', async t => {
    const f = await fixture(t, 'invite_only', false);
    await f.invoke();
    const history = await f.api.getGroupChatHistory(f.groupId, f.topicId);
    assert.equal(history.length, 3);
    assert.equal(history[2].content, 'RAW_PRIVATE_RESPONSE');
    assert.equal(f.trajectories.length, 1);
    assert.match(JSON.stringify(f.requests[0]), /GAME_RULES_WITHOUT_WATCHER/);
});
test('game没有运行时私有邀请时拒绝请求', async t => {
    const f = await fixture(t, 'game', false);
    await assert.rejects(f.invoke(), /对局运行时/);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.api.getGroupChatHistory(f.groupId, f.topicId)).length, 2);
});
test('game规则注入system，普通发送与redo不能修改公开事件历史', async t => {
    const f = await fixture(t, 'game', false);
    await f.invoke({ invitePrompt: 'PRIVATE' });
    const system = f.requests[0].messages.find(message => message.role === 'system').content;
    assert.match(system, /正式动作以及给其他玩家说的话/);
    assert.match(system, /三人斗地主/);
    await assert.rejects(f.api.handleGroupChatMessage(
        f.groupId, f.topicId, { id: 'bypass', content: { text: '伪造事件' } },
        undefined, async () => ({ id: 'a' }),
    ), /游戏界面/);
    await assert.rejects(f.api.redoGroupChatMessage(
        f.groupId, f.topicId, 'latest', 'a', undefined, async () => ({ id: 'a' }),
    ), /不能通过聊天redo/);
    assert.equal((await f.api.getGroupChatHistory(f.groupId, f.topicId)).length, 2);
});
for (const stream of [false, true]) {
    test(`普通邀请中央租约 ${stream ? '流式' : '非流式'}：暂挂先入场、终稿保存后释放`, async t => {
        const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');
        const f = await fixture(t, 'invite_only', stream);
        const scope = { itemType: 'group', itemId: f.groupId, topicId: f.topicId };
        let disk = [];
        const admission = new TopicMessageAdmission({
            store: {
                load: async () => disk,
                save: async entries => { disk = structuredClone(entries); },
            },
            validate: async () => {},
            commit: async (_scope, message) => {
                await f.api.appendGroupHistoryMessage(f.groupId, f.topicId, message);
            },
        });
        await admission.initialize();
        t.after(() => admission.dispose());
        let releasedAfterSave = false;
        const release = admission.release.bind(admission);
        admission.release = async (target, token, outcome) => {
            if (token !== 'previous') {
                const history = await f.api.getGroupChatHistory(f.groupId, f.topicId);
                assert.equal(history.at(-1).content, 'RAW_PRIVATE_RESPONSE');
                assert.equal(history.at(-1).admissionToken, token);
                assert.equal(history.at(-1).admissionTerminal, true);
                releasedAfterSave = true;
            }
            return release(target, token, outcome);
        };
        f.api.initializeRuntimeServices({ topicAdmission: admission });
        await admission.acquire(scope, 'previous');
        await admission.submit({
            scope, message: { id: 'visitor', role: 'assistant', name: 'Kerr', content: 'PENDING_VISITOR' },
        });
        const invocation = f.invoke();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.requests.length, 0);
        await admission.release(scope, 'previous');
        await invocation;
        assert.equal(f.requests.length, 1);
        assert.match(JSON.stringify(f.requests[0]), /PENDING_VISITOR/);
        assert.equal(releasedAfterSave, true);
        assert.equal(admission.leases.size, 0);
    });
}

test('游戏私有邀请不获取公共话题租约', async t => {
    const f = await fixture(t, 'game', false);
    f.api.initializeRuntimeServices({
        topicAdmission: {
            acquire() { throw new Error('game must not acquire public lease'); },
            acquireWhenIdle() { throw new Error('game must not wait on public lease'); },
            release() { throw new Error('game must not release public lease'); },
        },
    });
    await f.invoke({ invitePrompt: 'PRIVATE' });
    assert.equal(f.requests.length, 1);
    assert.equal((await f.api.getGroupChatHistory(f.groupId, f.topicId)).length, 2);
});
for (const stream of [false, true]) {
    test(`普通群聊逐成员交接 ${stream ? '流式' : '非流式'}：下一位读取暂挂留言`, async t => {
        const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');
        const f = await fixture(t, 'sequential', stream);
        const config = await f.api.getAgentGroupConfig(f.groupId);
        const updated = await f.api.saveAgentGroupConfig(f.groupId, {
            ...config, members: ['a', 'b'], sequentialSpeakerOrder: ['a', 'b'],
            modeSettings: { ...config.modeSettings, sequential: { speakerOrder: ['a', 'b'] } },
        });
        assert.equal(updated.success, true);
        const scope = { itemType: 'group', itemId: f.groupId, topicId: f.topicId };
        const order = [];
        const admission = new TopicMessageAdmission({
            store: { load: async () => [], save: async () => {} },
            validate: async () => {},
            commit: async (_scope, message) => {
                const history = await f.api.getGroupChatHistory(f.groupId, f.topicId);
                assert.equal(history.at(-1).agentId, 'a');
                assert.equal(history.at(-1).content, 'RAW_PRIVATE_RESPONSE');
                order.push('visitor-committed');
                await f.api.appendGroupHistoryMessage(f.groupId, f.topicId, message);
            },
        });
        await admission.initialize();
        t.after(() => admission.dispose());
        f.api.initializeRuntimeServices({ topicAdmission: admission });
        const releasedTokens = [];
        const release = admission.release.bind(admission);
        admission.release = async (target, token, outcome) => {
            const terminal = (await f.api.getGroupChatHistory(f.groupId, f.topicId))
                .find(message => message.admissionToken === token && message.admissionTerminal === true);
            assert.ok(terminal, 'each speaker must persist its exact lease before release');
            assert.equal(terminal.content, 'RAW_PRIVATE_RESPONSE');
            releasedTokens.push(token);
            return release(target, token, outcome);
        };
        f.setRequestHook(async count => {
            order.push(`request-${count}`);
            if (count === 1) {
                await admission.submit({
                    scope,
                    message: { id: 'visitor', role: 'assistant', name: 'Kerr', content: 'BETWEEN_SPEAKERS' },
                });
                assert.equal((await f.api.getGroupChatHistory(f.groupId, f.topicId))
                    .some(message => message.id === 'visitor'), false);
            }
        });
        await f.api.handleGroupChatMessage(
            f.groupId, f.topicId,
            { id: 'human', originalUserText: 'hello', content: { text: 'hello' } },
            undefined,
            async id => ({ id, name: `Agent ${id}`, model: 'test', streamOutput: stream }),
        );
        assert.equal(f.requests.length, 2);
        assert.doesNotMatch(JSON.stringify(f.requests[0]), /BETWEEN_SPEAKERS/);
        assert.match(JSON.stringify(f.requests[1]), /BETWEEN_SPEAKERS/);
        assert.deepEqual(order, ['request-1', 'visitor-committed', 'request-2']);
        assert.equal(releasedTokens.length, 2);
        assert.equal(new Set(releasedTokens).size, 2);
        assert.equal(admission.leases.size, 0);
    });
}
test('等待租约期间停止群聊，解锁后邀请不得复活', async t => {
    const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');
    const f = await fixture(t, 'invite_only', false);
    const admission = new TopicMessageAdmission({
        store: { load: async () => [], save: async () => {} },
        validate: async () => {},
        commit: async () => {},
    });
    await admission.initialize();
    t.after(() => admission.dispose());
    f.api.initializeRuntimeServices({ topicAdmission: admission });
    const scope = { itemType: 'group', itemId: f.groupId, topicId: f.topicId };
    await admission.acquire(scope, 'previous');
    const invocation = f.invoke();
    const deadline = Date.now() + 2000;
    while (admission.waiters.size === 0) {
        assert.ok(Date.now() < deadline, 'invitation must reach lease wait');
        await new Promise(resolve => setImmediate(resolve));
    }
    await f.api.interruptGroupChatQueue(f.groupId, f.topicId);
    await admission.release(scope, 'previous');
    await invocation;
    assert.equal(f.requests.length, 0);
    assert.equal(admission.leases.size, 0);
    assert.equal(admission.waiters.size, 0);
});
test('中央已提交Agent留言保留assistant身份，邀请模式不擅自选人', async t => {
    const f = await fixture(t, 'invite_only', false);
    const message = { id: 'external', role: 'assistant', name: 'Kerr', agentId: 'kerr', content: 'VISITOR' };
    await f.api.appendGroupHistoryMessage(f.groupId, f.topicId, message);
    await f.api.handleGroupChatMessage(
        f.groupId, f.topicId,
        { id: message.id, name: message.name, content: { text: message.content } },
        undefined, async id => ({ id, name: 'Agent', model: 'test' }),
        { committedMessageId: message.id },
    );
    const history = await f.api.getGroupChatHistory(f.groupId, f.topicId);
    assert.equal(history.length, 3);
    assert.equal(history.filter(entry => entry.id === message.id).length, 1);
    assert.equal(history.at(-1).role, 'assistant');
    assert.equal(history.at(-1).agentId, 'kerr');
    assert.equal(f.requests.length, 0);
});

test('中央已提交消息缺失时拒绝群聊消费，不追加伪造消息', async t => {
    const f = await fixture(t, 'sequential', false);
    await assert.rejects(f.api.handleGroupChatMessage(
        f.groupId, f.topicId, { id: 'missing', content: { text: 'fake' } },
        undefined, async id => ({ id, name: 'Agent', model: 'test' }),
        { committedMessageId: 'missing' },
    ), /中央提交的群聊消息不存在/);
    assert.equal((await f.api.getGroupChatHistory(f.groupId, f.topicId)).length, 2);
    assert.equal(f.requests.length, 0);
});
test('空闲群聊首位成员接管中央推进租约，终稿保存后才清除批次', async t => {
    const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');
    const f = await fixture(t, 'sequential', false);
    const scope = { itemType: 'group', itemId: f.groupId, topicId: f.topicId };
    let request;
    const admission = new TopicMessageAdmission({
        store: { load: async () => [], save: async () => {} },
        validate: async () => {},
        commit: async (_scope, message) => {
            await f.api.appendGroupHistoryMessage(f.groupId, f.topicId, message);
        },
        advance: async value => { request = value; },
    });
    await admission.initialize();
    t.after(() => admission.dispose());
    f.api.initializeRuntimeServices({ topicAdmission: admission });
    await admission.submit({
        scope, message: { id: 'visitor-batch', role: 'assistant', name: 'Kerr', content: 'CENTRAL_BATCH' },
        triggerPolicy: 'reply',
    });
    const deadline = Date.now() + 2000;
    while (!request) {
        assert.ok(Date.now() < deadline);
        await new Promise(resolve => setImmediate(resolve));
    }
    f.setRequestHook(async () => {
        assert.equal(admission.leases.get('group:' + f.groupId + '/topic:' + f.topicId), request.token);
        assert.equal(admission.snapshot(scope)[0].state, 'advancing');
        assert.equal(admission.snapshot(scope)[0].committed, true);
    });
    await f.api.handleGroupChatMessage(
        f.groupId, f.topicId,
        { id: 'visitor-batch', content: { text: 'CENTRAL_BATCH' } },
        undefined, async id => ({ id, name: 'Agent', model: 'test', streamOutput: false }),
        { committedMessageId: 'visitor-batch', admissionToken: request.token },
    );
    assert.equal(f.requests.length, 1);
    const history = await f.api.getGroupChatHistory(f.groupId, f.topicId);
    assert.equal(history.filter(message => message.id === 'visitor-batch').length, 1);
    assert.equal(history.at(-1).content, 'RAW_PRIVATE_RESPONSE');
    assert.deepEqual(admission.snapshot(scope), []);
    assert.equal(admission.leases.size, 0);
});
for (const noMembers of [false, true]) {
    test(`中央群聊无人发言释放租约：${noMembers ? '无可用成员' : 'invite_only'}`, async t => {
        const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');
        const f = await fixture(t, noMembers ? 'sequential' : 'invite_only', false);
        const admission = new TopicMessageAdmission({
            store: { load: async () => [], save: async () => {} },
            validate: async () => {}, commit: async () => {},
        });
        await admission.initialize();
        t.after(() => admission.dispose());
        f.api.initializeRuntimeServices({ topicAdmission: admission });
        const scope = { itemType: 'group', itemId: f.groupId, topicId: f.topicId };
        await admission.acquire(scope, 'unused');
        await f.api.handleGroupChatMessage(
            f.groupId, f.topicId, { id: 'latest', content: { text: 'LATEST_PUBLIC' } },
            undefined,
            async id => noMembers ? { error: 'missing member' } : { id, name: 'Agent', model: 'test' },
            { committedMessageId: 'latest', admissionToken: 'unused' },
        );
        assert.equal(f.requests.length, 0);
        assert.equal(admission.leases.size, 0);
        assert.equal((await f.api.getGroupChatHistory(f.groupId, f.topicId)).length, 2);
    });
}
for (const shouldSpeak of [false, true]) {
    test(`真实JEV中央批次交接：${shouldSpeak ? '选出首位并落盘' : '仲裁收敛不发言'}`, async t => {
        const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');
        const f = await fixture(t, 'jev', false);
        const scope = { itemType: 'group', itemId: f.groupId, topicId: f.topicId };
        let request;
        let decisions = 0;
        const admission = new TopicMessageAdmission({
            store: { load: async () => [], save: async () => {} },
            validate: async () => {},
            commit: async (_scope, message) => {
                await f.api.appendGroupHistoryMessage(f.groupId, f.topicId, message);
            },
            advance: async value => { request = value; },
        });
        await admission.initialize();
        t.after(() => admission.dispose());
        f.api.initializeRuntimeServices({
            topicAdmission: admission,
            getAgentConfigById: async id => ({
                id, name: 'Agent', model: 'test', streamOutput: false,
            }),
            jevService: {
                decide: async () => {
                    const speak = shouldSpeak && decisions++ === 0;
                    return { answers: {
                        speaker_routing: { probabilities: {
                            agent_0: speak ? 0.95 : 0, end_conversation: speak ? 0.05 : 1,
                        } },
                        continue_discussion: { noul: speak ? 0.95 : 0 },
                    } };
                },
            },
        });
        await admission.submit({
            scope,
            message: { id: 'jev-visitor', role: 'assistant', name: 'Kerr', content: 'JEV_CENTRAL_BATCH' },
            triggerPolicy: 'reply',
        });
        const deadline = Date.now() + 2000;
        while (!request) {
            assert.ok(Date.now() < deadline);
            await new Promise(resolve => setImmediate(resolve));
        }
        f.setRequestHook(async () => {
            assert.equal(admission.snapshot(scope)[0].leaseToken, request.token);
            assert.equal(admission.snapshot(scope)[0].state, 'advancing');
        });
        await f.api.handleGroupChatMessage(
            f.groupId, f.topicId,
            { id: 'jev-visitor', content: { text: 'JEV_CENTRAL_BATCH' } },
            undefined, async id => ({ id, name: 'Agent', model: 'test' }),
            { committedMessageId: 'jev-visitor', admissionToken: request.token },
        );
        assert.equal(f.requests.length, shouldSpeak ? 1 : 0);
        assert.equal(admission.leases.size, 0);
        assert.deepEqual(admission.snapshot(scope), []);
        const history = await f.api.getGroupChatHistory(f.groupId, f.topicId);
        assert.equal(history.filter(message => message.id === 'jev-visitor').length, 1);
        assert.equal(history.find(message => message.id === 'jev-visitor').role, 'assistant');
        if (shouldSpeak) assert.equal(history.at(-1).content, 'RAW_PRIVATE_RESPONSE');
    });
}
for (const mode of ['jev', 'sequential']) {
test(`真实活跃${mode}合并中央留言，下一位读取且不额外开场`, { timeout: 5000 }, async t => {
    const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');
    const f = await fixture(t, mode, false);
    const config = await f.api.getAgentGroupConfig(f.groupId);
    assert.equal((await f.api.saveAgentGroupConfig(f.groupId, {
        ...config, members: ['a', 'b'],
    })).success, true);
    const scope = { itemType: 'group', itemId: f.groupId, topicId: f.topicId };
    const loadAgent = async id => ({ id, name: `Agent ${id}`, model: 'test', streamOutput: false });
    let decisionCount = 0;
    let advanceCount = 0;
    let handoffFinished;
    const handoffDone = new Promise(resolve => { handoffFinished = resolve; });
    const admission = new TopicMessageAdmission({
        store: { load: async () => [], save: async () => {} },
        validate: async () => {},
        commit: async (_scope, message) => {
            await f.api.appendGroupHistoryMessage(f.groupId, f.topicId, message);
        },
        advance: async request => {
            advanceCount++;
            try {
                await f.api.handleGroupChatMessage(
                    f.groupId, f.topicId,
                    { id: request.messageId, content: { text: 'ACTIVE_VISITOR' } },
                    undefined, loadAgent,
                    { committedMessageId: request.messageId, admissionToken: request.token },
                );
                handoffFinished({ success: true });
            } catch (error) {
                handoffFinished({ error });
                throw error;
            }
        },
    });
    await admission.initialize();
    t.after(() => admission.dispose());
    f.api.initializeRuntimeServices({
        topicAdmission: admission,
        getAgentConfigById: loadAgent,
        jevService: {
            decide: async () => {
                const first = decisionCount++ === 0;
                return { answers: {
                    speaker_routing: { probabilities: {
                        agent_0: first ? 0.6 : 0,
                        agent_1: first ? 0.3 : 0,
                        end_conversation: first ? 0.1 : 1,
                    } },
                    continue_discussion: { noul: first ? 0.95 : 0 },
                } };
            },
        },
    });
    f.setRequestHook(async count => {
        if (count === 1) {
            await admission.submit({
                scope,
                message: { id: 'active-visitor', role: 'assistant', name: 'Kerr', content: 'ACTIVE_VISITOR' },
                triggerPolicy: 'reply',
            });
        }
    });
    await f.api.handleGroupChatMessage(
        f.groupId, f.topicId,
        { id: 'human-active', originalUserText: 'hello', content: { text: 'hello' } },
        undefined, loadAgent,
    );
    const outcome = await handoffDone;
    if (outcome.error) throw outcome.error;
    assert.equal(advanceCount, 1);
    assert.equal(f.requests.length, 2);
    assert.doesNotMatch(JSON.stringify(f.requests[0]), /ACTIVE_VISITOR/);
    assert.match(JSON.stringify(f.requests[1]), /ACTIVE_VISITOR/);
    assert.equal(admission.leases.size, 0);
    assert.deepEqual(admission.snapshot(scope), []);
    assert.equal(f.api.getJevGroupChatState(f.groupId, f.topicId).running, false);
});
}
for (const stream of [false, true]) {
    for (const stop of [false, true]) {
        test(`redo中央占用 ${stream ? '流式' : '非流式'} ${stop ? '等待停止不复活' : '最新历史删除不丢留言'}`, async t => {
            const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');
            const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');
            const f = await fixture(t, 'invite_only', stream);
            const scope = { itemType: 'group', itemId: f.groupId, topicId: f.topicId };
            const queue = new HistoryMutationQueue({ userDataDir: path.join(f.root, 'users') });
            const admission = new TopicMessageAdmission({
                store: { load: async () => [], save: async () => {} },
                validate: async () => {},
                commit: async (target, message) => queue.mutate(target, history => [...history, message]),
            });
            await admission.initialize();
            t.after(async () => { await admission.dispose(); await queue.dispose(); });
            f.api.initializeRuntimeServices({ historyMutationQueue: queue, topicAdmission: admission });
            const release = admission.release.bind(admission);
            let verifiedTerminal = false;
            admission.release = async (target, token, outcome) => {
                if (token !== 'busy' && !stop) {
                    const terminal = (await queue.read(scope)).find(message =>
                        message.admissionToken === token && message.admissionTerminal === true);
                    assert.ok(terminal, 'redo must persist its exact acquired lease before release');
                    assert.equal(terminal.role, 'assistant');
                    assert.equal(terminal.content, 'RAW_PRIVATE_RESPONSE');
                    verifiedTerminal = true;
                }
                return release(target, token, outcome);
            };
            await f.api.appendGroupHistoryMessage(f.groupId, f.topicId, {
                id: 'redo-target', role: 'assistant', agentId: 'a', name: 'Agent A', content: 'OLD RESPONSE',
            });
            await admission.acquire(scope, 'busy');
            const pending = f.api.redoGroupChatMessage(
                f.groupId, f.topicId, 'redo-target', 'a', undefined,
                async () => ({ id: 'a', name: 'Agent A', model: 'test', streamOutput: stream }),
            );
            // Wait for the actual central waiter, not an arbitrary number of turns.
            const deadline = Date.now() + 3000;
            while (!admission.waiters.size && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            assert.equal(admission.waiters.size, 1);
            assert.ok((await queue.read(scope)).some(message => message.id === 'redo-target'));
            assert.equal(f.requests.length, 0);
            await queue.mutate(scope, history => [...history, {
                id: 'concurrent', role: 'user', content: 'CONCURRENT MESSAGE',
            }]);
            if (stop) await f.api.interruptGroupChatQueue(f.groupId, f.topicId);
            await admission.release(scope, 'busy');
            await pending;
            const history = await queue.read(scope);
            assert.ok(history.some(message => message.id === 'concurrent'));
            assert.equal(history.some(message => message.id === 'redo-target'), stop);
            assert.equal(f.requests.length, stop ? 0 : 1);
            assert.equal(verifiedTerminal, !stop);
            assert.equal(admission.leases.size, 0);
        });
    }
}
test('committed role gates human-only suffix and leaves persisted content unchanged', async t => {
    for (const role of ['user', 'assistant']) {
        const f = await fixture(t, 'invite_only', false);
        f.setRules([{ id: 'suffix', type: 'user_suffix', scope: 'group',
            enabled: true, wrap: false, content: 'HUMAN_ONLY_SUFFIX' }]);
        await f.api.appendGroupHistoryMessage(f.groupId, f.topicId, {
            id: 'committed-role', role, name: 'Guest', content: 'RAW MESSAGE',
        });
        const payload = { id: 'committed-role', name: 'Guest',
            originalUserText: 'RAW MESSAGE', content: { text: 'EXPANDED REQUEST' } };
        await f.api.handleGroupChatMessage(f.groupId, f.topicId, payload, undefined,
            async () => ({ id: 'a', name: 'Agent A', model: 'test' }),
            { committedMessageId: 'committed-role' });
        assert.equal(payload.content.text.includes('HUMAN_ONLY_SUFFIX'), role === 'user');
        const saved = (await f.api.getGroupChatHistory(f.groupId, f.topicId))
            .find(message => message.id === 'committed-role');
        assert.equal(saved.role, role);
        assert.equal(saved.content, 'RAW MESSAGE');
        assert.equal(f.requests.length, 0);
    }
});
test('deleted group history is not recreated by send or invitation entry', async t => {
    const f = await fixture(t, 'invite_only', false);
    const directory = path.join(f.root, 'users', f.groupId, 'topics', f.topicId);
    await fsp.rm(directory, { recursive: true, force: true });
    await assert.rejects(f.invoke(), /话题或历史已不存在/);
    await assert.rejects(f.api.handleGroupChatMessage(
        f.groupId, f.topicId, { id: 'late', name: 'Ryan', content: { text: 'late' } },
        undefined, async () => ({ id: 'a', name: 'Agent A', model: 'test' }),
    ), /话题或历史已不存在/);
    assert.equal(fs.existsSync(directory), false);
    assert.equal(f.requests.length, 0);
});