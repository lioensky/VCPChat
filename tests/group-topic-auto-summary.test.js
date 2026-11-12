'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const topicTitleManager = require('../Groupmodules/topicTitleManager');

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function createGroupChatHarness(t, { fetchImpl } = {}) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vcp-group-topic-summary-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));

    const filename = path.resolve(__dirname, '../Groupmodules/groupchat.js');
    const localRequire = createRequire(filename);
    const topicNotifications = [];
    const streamEvents = [];
    const fetchBodies = [];

    const mockFetch = async (url, options = {}) => {
        const parsedBody = options.body ? JSON.parse(options.body) : null;
        fetchBodies.push({ url, body: parsedBody });
        if (fetchImpl) return fetchImpl(url, options, parsedBody);
        return new Response(JSON.stringify({
            choices: [{ message: { content: '默认AI总结标题' } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const prevGlobalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    t.after(() => {
        globalThis.fetch = prevGlobalFetch;
    });

    const moduleObj = { exports: {} };
    const sandbox = {
        module: moduleObj,
        exports: moduleObj.exports,
        console: { log() {}, warn() {}, error() {} },
        setTimeout,
        clearTimeout,
        AbortController,
        TextDecoder,
        URL,
        fetch: mockFetch,
        require: name => {
            if (name === 'electron') return { ipcMain: {} };
            if (name === '../modules/modelTrajectory') {
                return {
                    beginTrajectoryCall: () => ({ chunk() {}, finish() {} }),
                    sessionKeyFromContext: () => 'session',
                    sourceFromContext: value => value,
                };
            }
            if (name === '../modules/contextSanitizer') {
                return { stripThoughtChains: v => v, sanitizeMessages: v => v };
            }
            if (name === '../modules/ipc/tavernHandlers') {
                return { getActiveRules: () => [] };
            }
            if (['../modules/fileManager', '../modules/ipc/canvasHandlers'].includes(name)) {
                return {};
            }
            return localRequire(name);
        }
    };

    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    const api = moduleObj.exports;

    localRequire('../modules/services/conversationContext').initialize({
        load: owner => api.getAgentGroupConfig(owner.id),
        update: (owner, mutate) => api.mutateGroupConfig(owner.id, mutate),
        workspace: () => ({ workspaces: [], activeWorkspaceId: null }),
        rules: async () => ({ rules: [] }),
    });

    const settingsFile = path.join(root, 'settings.json');
    await fsp.writeFile(settingsFile, JSON.stringify({
        vcpServerUrl: 'http://127.0.0.1:16005/v1/chat/completions',
        vcpApiKey: 'test-key',
        userName: '测试用户',
        topicSummaryModel: 'test-summary-model'
    }));

    const agentsDir = path.join(root, 'Agents');
    await fsp.mkdir(path.join(agentsDir, 'agent_a'), { recursive: true });
    await fsp.writeFile(path.join(agentsDir, 'agent_a', 'config.json'), JSON.stringify({
        id: 'agent_a',
        name: 'Agent A',
        model: 'test-agent-model',
        systemPrompt: '你是测试助手。',
        streamOutput: false
    }));

    api.initializePaths({
        APP_DATA_ROOT_IN_PROJECT: root,
        USER_DATA_DIR: path.join(root, 'UserData'),
        AGENT_DIR: agentsDir,
        SETTINGS_FILE: settingsFile,
    });

    const getAgentConfigById = async id => {
        const cfgPath = path.join(agentsDir, id, 'config.json');
        return fs.existsSync(cfgPath) ? JSON.parse(await fsp.readFile(cfgPath, 'utf8')) : { error: 'not found' };
    };

    return {
        api,
        root,
        settingsFile,
        topicNotifications,
        streamEvents,
        fetchBodies,
        getAgentConfigById,
        sendStream: evt => streamEvents.push(evt),
        notifyTopicUpdated: payload => topicNotifications.push(payload),
    };
}

test('过滤 system 与 isThinking 后不足 4 条有效消息不触发总结', async () => {
    let called = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        called = true;
        throw new Error('should not fetch');
    };
    try {
        const groupConfig = {
            id: 'g1',
            mode: 'sequential',
            topics: [{ id: 't1', name: '新话题 22:00:00' }]
        };
        const history = [
            { role: 'system', content: '系统公告' },
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '你好呀' },
            { role: 'user', content: '第二句' },
            { role: 'assistant', isThinking: true, content: '思考中...' }
        ];
        let saved = false;
        await topicTitleManager.triggerSummarizationIfNeeded(
            'g1',
            't1',
            history,
            { vcpUrl: 'http://127.0.0.1:1/v1/chat/completions', vcpApiKey: 'k' },
            groupConfig,
            () => {},
            async () => { saved = true; return { success: true, topics: [] }; }
        );
        assert.equal(called, false);
        assert.equal(saved, false);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('满 4 条有效消息时 AI 成功总结清洗标题并触发专用通知回调', async () => {
    const realFetch = globalThis.fetch;
    let capturedBody = null;
    globalThis.fetch = async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({
            choices: [{ message: { content: '1. 标题：“群聊命名链路贯通！”\n多余说明' } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
        const topics = [{ id: 't1', name: '新话题 22:01:00' }];
        const notifications = [];
        const history = [
            { role: 'user', content: '排查群聊话题生成' },
            { role: 'assistant', name: 'Agent B', content: '正在追踪调用链路' },
            { role: 'user', content: { text: '找到根因了吗？' } },
            { role: 'assistant', name: 'Agent B', content: '已定位触发与通知分支' }
        ];
        await topicTitleManager.triggerSummarizationIfNeeded(
            'g1',
            't1',
            history,
            { vcpUrl: 'http://127.0.0.1:1/v1/chat/completions', vcpApiKey: 'k', topicSummaryModel: 'test-summary-model' },
            { id: 'g1', mode: 'jev', topics },
            payload => notifications.push(payload),
            async (_gid, tid, newTitle) => {
                topics[0] = { ...topics[0], id: tid, name: newTitle };
                return { success: true, topics };
            }
        );

        assert.equal(typeof capturedBody.messages[0].content, 'string');
        assert.equal(topics[0].name, '群聊命名链路贯通');
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].newTitle, '群聊命名链路贯通');
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('AI 请求失败、返回空或无 URL 时自动降级为 关于 "第二个user块..." (备用)，且附件消息不出现 [object Object]', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('Bad Gateway', { status: 502 });
    try {
        const topics = [{ id: 't1', name: '新话题 22:05:00' }];
        const notifications = [];
        const history = [
            { role: 'user', content: '第一句开场白' },
            { role: 'assistant', content: '第一句回复' },
            { role: 'user', content: { text: '第二个用户消息块用来生成超过十五个字符的备用标题测试' } },
            { role: 'assistant', content: '第二句回复' }
        ];
        await topicTitleManager.triggerSummarizationIfNeeded(
            'g1',
            't1',
            history,
            { vcpUrl: 'http://127.0.0.1:1/v1/chat/completions', vcpApiKey: 'k' },
            { id: 'g1', mode: 'sequential', topics },
            payload => notifications.push(payload),
            async (_gid, _tid, newTitle) => {
                topics[0].name = newTitle;
                return { success: true, topics };
            }
        );
        assert.equal(topics[0].name, '关于 "第二个用户消息块用来生成超过十..." (备用)');
        assert.equal(notifications.length, 1);

        // 纯附件无文本边界
        const attachmentFallback = topicTitleManager.buildFallbackTopicTitle([
            { role: 'user', content: { text: '   ' }, attachments: [{ name: '架构拓扑图.png' }] }
        ]);
        assert.equal(attachmentFallback, '关于 "架构拓扑图.png" (备用)');
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('inFlight 并发锁阻止重复 AI 请求，且 saveGroupTopicTitle 原子锁不吞并发新建的话题', async t => {
    const slowAi = createDeferred();
    let titleCallCount = 0;
    const h = await createGroupChatHarness(t, {
        fetchImpl: async (_url, _opts, body) => {
            if (body?.stream === false && String(body?.messages?.[0]?.content || '').includes('仅返回一个简洁的话题标题')) {
                titleCallCount += 1;
                await slowAi.promise;
                return new Response(JSON.stringify({
                    choices: [{ message: { content: '并发安全测试标题' } }]
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response(JSON.stringify({
                choices: [{ message: { content: '成员回复' } }]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
    });

    h.api.initializeRuntimeServices({
        getAgentConfigById: h.getAgentConfigById,
        notifyTopicUpdated: h.notifyTopicUpdated,
    });

    const created = await h.api.createAgentGroup('并发测试群', { mode: 'sequential', members: ['agent_a'] });
    const groupId = created.agentGroup.id;
    const topicId = created.agentGroup.topics[0].id;

    for (let i = 1; i <= 4; i += 1) {
        await h.api.appendGroupHistoryMessage(groupId, topicId, {
            id: `m${i}`,
            role: i % 2 === 1 ? 'user' : 'assistant',
            content: `消息内容 ${i}`
        });
    }

    const groupConfig = await h.api.getAgentGroupConfig(groupId);
    const history = await h.api.getGroupChatHistory(groupId, topicId);
    const settings = { vcpUrl: 'http://127.0.0.1:16005/v1/chat/completions', vcpApiKey: 'k' };

    const p1 = topicTitleManager.triggerSummarizationIfNeeded(
        groupId, topicId, history, settings, groupConfig, h.notifyTopicUpdated, h.api.saveGroupTopicTitle
    );
    const p2 = topicTitleManager.triggerSummarizationIfNeeded(
        groupId, topicId, history, settings, groupConfig, h.notifyTopicUpdated, h.api.saveGroupTopicTitle
    );

    // 在 AI 总结尚未返回期间，并发新建第二个话题
    const secondTopic = await h.api.createNewTopicForGroup(groupId, '新话题 并发新建');
    assert.equal(secondTopic.success, true);

    slowAi.resolve();
    await Promise.all([p1, p2]);

    assert.equal(titleCallCount, 1, '同一话题并发触发只应请求一次 AI');
    const updatedConfig = await h.api.getAgentGroupConfig(groupId);
    assert.equal(updatedConfig.topics.length, 2, '并发新建的话题绝不能被标题保存覆盖丢失');
    assert.equal(updatedConfig.topics.find(item => item.id === topicId)?.name, '并发安全测试标题');
    assert.equal(updatedConfig.topics.find(item => item.id === secondTopic.topicId)?.name, '新话题 并发新建');
    assert.equal(h.topicNotifications.length, 1);
});

test('JEV 群聊模式下成员回复满 4 条后自动触发话题总结并推送更新事件', async t => {
    const h = await createGroupChatHarness(t, {
        fetchImpl: async (_url, _opts, body) => {
            const firstMsg = String(body?.messages?.[0]?.content || '');
            if (body?.stream === false && firstMsg.includes('仅返回一个简洁的话题标题')) {
                return new Response(JSON.stringify({
                    choices: [{ message: { content: 'JEV智能研讨闭环' } }]
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response(JSON.stringify({
                choices: [{ message: { content: '助手收到并完成核验' } }]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
    });

    let round = 0;
    const jevService = {
        async decide() {
            round += 1;
            if (round === 1) {
                return {
                    answers: {
                        speaker_routing: { probabilities: { agent_0: 0.9, end_conversation: 0.05 } },
                        continue_discussion: { noul: 0.8 }
                    }
                };
            }
            return {
                answers: {
                    speaker_routing: { probabilities: { agent_0: 0.02, end_conversation: 0.95 } },
                    continue_discussion: { noul: 0.05 }
                }
            };
        }
    };

    h.api.initializeRuntimeServices({
        jevService,
        getAgentConfigById: h.getAgentConfigById,
        notifyTopicUpdated: h.notifyTopicUpdated,
    });

    const created = await h.api.createAgentGroup('JEV测试群', { mode: 'jev', members: ['agent_a'] });
    const groupId = created.agentGroup.id;
    const newTopic = await h.api.createNewTopicForGroup(groupId, '新话题 22:10:00');
    const topicId = newTopic.topicId;

    // 预置 2 条历史（user1 + assistant1），随后发送第 2 条用户消息触发 JEV 成员回复凑满 4 条
    await h.api.appendGroupHistoryMessage(groupId, topicId, { id: 'u1', role: 'user', name: '测试用户', content: '开启JEV测试' });
    await h.api.appendGroupHistoryMessage(groupId, topicId, { id: 'a1', role: 'assistant', agentId: 'agent_a', name: 'Agent A', content: '第一轮回复' });

    await h.api.handleGroupChatMessage(
        groupId,
        topicId,
        { id: 'u2', role: 'user', name: '测试用户', content: { text: '请继续推进第二轮测试' } },
        h.sendStream,
        h.getAgentConfigById
    );

    // 等待异步非阻塞的总结钩子落盘完成
    for (let attempt = 0; attempt < 20 && h.topicNotifications.length === 0; attempt += 1) {
        await new Promise(r => setTimeout(r, 25));
    }

    const finalConfig = await h.api.getAgentGroupConfig(groupId);
    const targetTopic = finalConfig.topics.find(item => item.id === topicId);
    assert.equal(targetTopic?.name, 'JEV智能研讨闭环');
    assert.equal(h.topicNotifications.length, 1);
    assert.equal(h.topicNotifications[0].groupId, groupId);
    assert.equal(h.topicNotifications[0].topicId, topicId);
    assert.equal(h.topicNotifications[0].newTitle, 'JEV智能研讨闭环');
    // 确保不再向 vcp-stream-event 发送无 messageId 的野 topic_updated 事件
    assert.equal(h.streamEvents.some(e => e?.type === 'topic_updated'), false);
});

test('IPC 与渲染端契约：groupChatHandlers 发射 vcp-group-topic-updated 且与 preload 通道严密对齐', () => {
    const root = path.resolve(__dirname, '..');
    const handlers = fs.readFileSync(path.join(root, 'modules/ipc/groupChatHandlers.js'), 'utf8');
    const preloadGroup = fs.readFileSync(path.join(root, 'preloads/api/groupChat.js'), 'utf8');
    const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

    assert.match(handlers, /webContents\.send\('vcp-group-topic-updated',\s*payload\)/);
    assert.match(handlers, /notifyTopicUpdated:\s*notifyGroupTopicUpdated/);
    assert.match(preloadGroup, /onVCPGroupTopicUpdated:\s*on\('vcp-group-topic-updated'\)/);
    assert.match(renderer, /consumeGroupTopicUpdate:/);
});