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
    const module = { exports: {} };
    const sandbox = {
        module, exports: module.exports, console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, AbortController, TextDecoder, URL,
        fetch: async (_url, options) => {
            requests.push(JSON.parse(options.body));
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
            if (name === '../modules/ipc/tavernHandlers') return { getActiveRules: () => [] };
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
        rules: async () => ({ rules: [] }),
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
    return { api, groupId, topicId, invoke, requests, trajectories };
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