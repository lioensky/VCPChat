const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createFlowlockRuntime(electronAPI, overrides = {}) {
    const flowlockCode = fs.readFileSync(
        path.resolve(__dirname, '../Flowlockmodules/flowlock.js'),
        'utf8'
    );
    const timers = [];
    const toasts = [];
    const window = {
        electronAPI,
        flowlockProtocol: {
            parse: content => ({
                shouldStart: /\[\[Flowlock::Start\]\]/.test(String(content || '')),
                shouldStop: false,
                shouldComplete: false,
                shouldFail: false,
                nextHeartbeat: null,
                nextPrompt: null,
            }),
        },
        VCPMainChatState: {
            snapshot: () => overrides.selectedSnapshot || ({
                selectedItem: { id: 'group-collab-1', type: 'group' },
                topicId: 'topic-group-1',
            }),
        },
        topicListManager: {
            loadTopicList: () => {
                if (typeof overrides.onReloadTopicList === 'function') {
                    overrides.onReloadTopicList();
                }
            },
        },
        document: {
            querySelector: () => null,
            querySelectorAll: () => [],
            getElementById: () => null,
        },
    };
    const sandbox = {
        window,
        document: window.document,
        console,
        Date,
        Map,
        Set,
        Promise,
        Math,
        Number,
        String,
        Boolean,
        Object,
        Array,
        Error,
        RegExp,
        setTimeout: (fn, delay) => {
            const handle = { fn, delay, cleared: false };
            timers.push(handle);
            return handle;
        },
        clearTimeout: handle => {
            if (handle) handle.cleared = true;
        },
        setInterval: () => ({}),
        clearInterval: () => {},
    };
    vm.createContext(sandbox);
    vm.runInContext(flowlockCode, sandbox, { filename: 'Flowlockmodules/flowlock.js' });
    const manager = window.flowlockManager;
    manager.initialize({
        electronAPI,
        uiHelper: {
            showToastNotification: (msg, type) => {
                toasts.push({ msg, type });
            },
        },
        globalSettingsRef: { get: () => ({}) },
        continueWritingForContext: async () => {},
    });
    return { manager, window, timers, toasts };
}

test('群聊流式回复完结时可跨主体认领后台单聊心流话题，且绝不将群聊自身锁入Session', async () => {
    const claimedCalls = [];
    const pendingRequests = [
        {
            agentId: '_Agent_1700000000001_Alpha',
            topicId: 'topic_workshop_1',
            topicName: '小克的独立工坊',
            requestId: 'flreq_group_to_alpha_1',
            createdAt: 1700000000000,
            heartbeatSeconds: 45,
            prompt: '请开始第一阶段架构整理',
        },
    ];

    const electronAPI = {
        listPendingFlowlockTopics: async () => ({
            success: true,
            requests: [...pendingRequests],
        }),
        claimPendingFlowlockTopic: async (agentId, constraints = {}) => {
            claimedCalls.push({ agentId, constraints });
            const idx = pendingRequests.findIndex(r => r.agentId === agentId);
            if (idx === -1) return { success: false, code: 'NOT_FOUND' };
            const [req] = pendingRequests.splice(idx, 1);
            return {
                success: true,
                claim: { ...req },
            };
        },
    };

    const { manager, timers } = createFlowlockRuntime(electronAPI);

    // 模拟在多智能体协作讨论组群聊中某位成员发言结束
    await manager.handleFinalizedMessage({
        type: 'end',
        messageId: 'msg_group_speaker_1',
        context: {
            groupId: '________1700000000009',
            topicId: 'topic_group_main',
            agentId: '_Agent_Nova',
            agentName: '小娜',
            isGroupMessage: true,
        },
        content: '我已为小克创建好后台心流工坊话题！[[Flowlock::Start]]',
        finishReason: 'completed',
    });

    // 1. 小克 的后台单聊话题已被成功认领并激活
    assert.equal(claimedCalls.length, 1);
    assert.equal(claimedCalls[0].agentId, '_Agent_1700000000001_Alpha');
    assert.equal(manager.isAgentLocked('_Agent_1700000000001_Alpha'), true);
    assert.equal(
        manager.getLockedTopicId('_Agent_1700000000001_Alpha'),
        'topic_workshop_1'
    );
    assert.equal(timers.some(t => !t.cleared && t.delay === 45000), true);

    // 2. 即使群聊发言末尾带有 [[Flowlock::Start]]，群聊发言者与群聊话题也绝不会被误锁！
    assert.equal(manager.isAgentLocked('_Agent_Nova'), false);
    assert.equal(manager.isAgentLocked('________1700000000009'), false);
});

test('单聊跨伙伴派发、话题列表刷新与目标伙伴忙碌礼让守卫（AGENT_BUSY_DEFERRED）', async () => {
    let topicListReloadCount = 0;
    const pendingRequests = [
        {
            agentId: 'agent-alpha',
            topicId: 'topic_alpha_2',
            topicName: '跨伙伴委托工坊',
            requestId: 'flreq_nova_to_alpha_2',
            createdAt: 1700000010000,
            heartbeatSeconds: 30,
            prompt: '执行源码审计',
        },
    ];

    const electronAPI = {
        getAgentConfig: async id => ({ id, name: id === 'agent-alpha' ? '小克' : '汉娜' }),
        listPendingFlowlockTopics: async () => ({
            success: true,
            requests: [...pendingRequests],
        }),
        claimPendingFlowlockTopic: async (agentId, constraints = {}) => {
            const idx = pendingRequests.findIndex(r => r.agentId === agentId && (!constraints.topicId || r.topicId === constraints.topicId));
            if (idx === -1) return { success: false, code: 'NOT_FOUND' };
            const [req] = pendingRequests.splice(idx, 1);
            return { success: true, claim: { ...req } };
        },
    };

    const { manager, toasts } = createFlowlockRuntime(electronAPI, {
        selectedSnapshot: {
            selectedItem: { id: 'agent-alpha', type: 'agent', name: '小克' },
            topicId: 'topic_old',
        },
        onReloadTopicList: () => {
            topicListReloadCount++;
        },
    });

    // 先启动小克在旧话题上的 Session，并模拟它正在流式生成中（activeMessageId 存在）
    await manager.start('agent-alpha', 'topic_alpha_old', { startImmediately: false, agentName: '小克' });
    const alphaSession = manager.sessions.get('agent-alpha');
    alphaSession.activeMessageId = 'msg_alpha_inflight_99';

    // 此时小娜单聊回复结束，尝试扫描全城 pending；因为小克正在生成 msg_alpha_inflight_99，必须触发忙碌礼让！
    await manager.handleFinalizedMessage({
        type: 'end',
        messageId: 'msg_nova_1',
        context: {
            agentId: 'agent-nova',
            topicId: 'topic_nova_main',
            isGroupMessage: false,
        },
        content: '已经帮小克建好心流工坊啦。',
        finishReason: 'completed',
    });

    // 验证：小克仍在旧话题，pending 请求未被提前消费截胡！
    assert.equal(manager.getLockedTopicId('agent-alpha'), 'topic_alpha_old');
    assert.equal(pendingRequests.length, 1);

    // 现在小克自己的 msg_alpha_inflight_99 完成了！应当立即认领并平滑交接到新话题 topic_alpha_2
    await manager.handleFinalizedMessage({
        type: 'end',
        messageId: 'msg_alpha_inflight_99',
        context: {
            agentId: 'agent-alpha',
            topicId: 'topic_alpha_old',
            isGroupMessage: false,
        },
        content: '旧话题本轮完毕。',
        finishReason: 'completed',
    });

    assert.equal(manager.isTopicLocked('agent-alpha', 'topic_alpha_2'), true);
    assert.equal(topicListReloadCount, 1);
    assert.equal(toasts.some(t => t.msg.includes('小克') && t.msg.includes('已交接到新话题')), true);

    // 测试手动切换话题时的 Lazy Claim 幂等与按 topicId 精准认领
    pendingRequests.push({
        agentId: 'agent-hanna',
        topicId: 'topic_hanna_lazy',
        topicName: '汉娜茶寮筹备',
        requestId: 'flreq_hanna_lazy_1',
        createdAt: 1700000020000,
        heartbeatSeconds: 60,
        prompt: '准备茶点',
    });
    const lazyResult = await manager.claimPendingTopicForSelection('agent-hanna', 'topic_hanna_lazy');
    assert.equal(lazyResult.success, true);
    assert.equal(manager.isTopicLocked('agent-hanna', 'topic_hanna_lazy'), true);

    const repeatResult = await manager.claimPendingTopicForSelection('agent-hanna', 'topic_hanna_lazy');
    assert.equal(repeatResult.success, true);
    assert.equal(repeatResult.alreadyLocked, true);
});

test('群聊非流式 full_response 消费器自动桥接 Flowlock 完结钩子', async () => {
    const { createNonStreamingEventConsumer } = await import('../modules/renderer/nonStreamingEventConsumer.js');
    const finalizedEvents = [];
    const projectedCalls = [];

    const prevWindow = globalThis.window;
    globalThis.window = {
        flowlockManager: {
            handleFinalizedMessage: async event => {
                finalizedEvents.push(event);
            },
        },
    };

    try {
        const consumer = createNonStreamingEventConsumer({
            renderTarget: { root: {}, removeMessage: async () => {} },
            messageRenderer: {
                renderFullMessageProjection: async (...args) => {
                    projectedCalls.push(args);
                },
            },
            viewAuthority: { isCurrent: () => true },
        });

        const handled = await consumer.consume({
            type: 'full_response',
            messageId: 'msg_nonstream_group_1',
            fullResponse: '非流式群聊成员已完成派单',
            context: {
                groupId: 'group_1',
                topicId: 'topic_g1',
                agentId: 'agent_amy',
                agentName: '艾米',
                isGroupMessage: true,
            },
        });

        assert.equal(handled, true);
        assert.equal(projectedCalls.length, 1);
        assert.equal(finalizedEvents.length, 1);
        assert.equal(finalizedEvents[0].messageId, 'msg_nonstream_group_1');
        assert.equal(finalizedEvents[0].content, '非流式群聊成员已完成派单');
        assert.equal(finalizedEvents[0].context.isGroupMessage, true);
    } finally {
        globalThis.window = prevWindow;
    }
});

test('主进程 claim-pending-flowlock-topic 支持多 Pending 自动选最新并归档旧残留为 superseded，且支持按 topicId 精准认领', async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'vcp-flowlock-claim-'));
    const agentDir = path.join(tmpRoot, 'Agents');
    const userDataDir = path.join(tmpRoot, 'UserData');
    const agentId = '_Agent_Test_Alpha';

    try {
        await fsp.mkdir(path.join(agentDir, agentId), { recursive: true });
        await fsp.mkdir(path.join(userDataDir, agentId, 'topics', 'topic_old_1'), { recursive: true });
        await fsp.mkdir(path.join(userDataDir, agentId, 'topics', 'topic_new_2'), { recursive: true });
        await fsp.mkdir(path.join(userDataDir, agentId, 'topics', 'topic_specific_3'), { recursive: true });

        await fsp.writeFile(path.join(userDataDir, agentId, 'topics', 'topic_old_1', 'history.json'), '[]');
        await fsp.writeFile(path.join(userDataDir, agentId, 'topics', 'topic_new_2', 'history.json'), '[]');
        await fsp.writeFile(path.join(userDataDir, agentId, 'topics', 'topic_specific_3', 'history.json'), '[]');
        // 放入一个非目录干扰文件，验证 list-pending-flowlock-topics 的 withFileTypes 过滤
        await fsp.writeFile(path.join(agentDir, '.DS_Store'), 'ignore');

        const initialConfig = {
            id: agentId,
            name: '小克',
            topics: [
                {
                    id: 'topic_old_1',
                    name: '旧遗留待认领1',
                    createdAt: 1000,
                    flowlockRequest: {
                        requestId: 'req_old_1',
                        requestedByAgentId: agentId,
                        createdAt: 1000,
                        heartbeatSeconds: 60,
                        prompt: 'old prompt',
                        status: 'pending',
                    },
                },
                {
                    id: 'topic_new_2',
                    name: '最新待认领2',
                    createdAt: 2000,
                    flowlockRequest: {
                        requestId: 'req_new_2',
                        requestedByAgentId: agentId,
                        createdAt: 2000,
                        heartbeatSeconds: 25,
                        prompt: 'new prompt',
                        status: 'pending',
                    },
                },
                {
                    id: 'topic_specific_3',
                    name: '指定话题待认领3',
                    createdAt: 1500,
                    flowlockRequest: {
                        requestId: 'req_specific_3',
                        requestedByAgentId: agentId,
                        createdAt: 1500,
                        heartbeatSeconds: 40,
                        prompt: 'specific prompt',
                        status: 'pending',
                    },
                },
            ],
        };
        await fsp.writeFile(
            path.join(agentDir, agentId, 'config.json'),
            JSON.stringify(initialConfig, null, 2)
        );

        const AgentConfigManager = require('../modules/utils/agentConfigManager');
        const agentConfigManager = new AgentConfigManager(agentDir);

        const handlers = new Map();
        const electron = require('electron');
        const origHandle = electron.ipcMain?.handle;
        const fakeIpcMain = {
            handle: (channel, fn) => handlers.set(channel, fn),
            on: () => {},
            removeHandler: () => {},
        };

        const Module = require('node:module');
        const origLoad = Module._load;
        Module._load = function (request, parent, isMain) {
            if (request === 'electron') {
                return { ipcMain: fakeIpcMain, app: { getPath: () => tmpRoot } };
            }
            return origLoad.call(this, request, parent, isMain);
        };

        try {
            delete require.cache[require.resolve('../modules/ipc/chatHandlers')];
            const chatHandlers = require('../modules/ipc/chatHandlers');
            chatHandlers.initialize(
                { isDestroyed: () => false, webContents: { send: () => {}, isDestroyed: () => false } },
                {
                    AGENT_DIR: agentDir,
                    USER_DATA_DIR: userDataDir,
                    APP_DATA_ROOT_IN_PROJECT: tmpRoot,
                    agentConfigManager,
                }
            );
        } finally {
            Module._load = origLoad;
            if (origHandle && electron.ipcMain) electron.ipcMain.handle = origHandle;
        }

        const listHandler = handlers.get('list-pending-flowlock-topics');
        const listed = await listHandler();
        assert.equal(listed.success, true);
        assert.equal(listed.requests.length, 3);

        const claimHandler = handlers.get('claim-pending-flowlock-topic');
        assert.equal(typeof claimHandler, 'function');

        // 1. 先测试按 topicId 精准认领 topic_specific_3（不影响其他 pending）
        const byTopicRes = await claimHandler({}, agentId, { topicId: 'topic_specific_3' });
        assert.equal(byTopicRes.success, true);
        assert.equal(byTopicRes.claim.topicId, 'topic_specific_3');
        assert.equal(byTopicRes.claim.requestId, 'req_specific_3');

        // 2. 若显式传 strictConflict: true，剩余 2 个 pending 返回 CONFLICT
        const strictRes = await claimHandler({}, agentId, { strictConflict: true });
        assert.equal(strictRes.success, false);
        assert.equal(strictRes.code, 'CONFLICT');

        // 3. 默认模式下自动认领最新创建的 req_new_2 (createdAt: 2000)，并将旧残留 req_old_1 标记为 superseded！
        const autoLatestRes = await claimHandler({}, agentId, {});
        assert.equal(autoLatestRes.success, true);
        assert.equal(autoLatestRes.claim.topicId, 'topic_new_2');
        assert.equal(autoLatestRes.claim.requestId, 'req_new_2');

        const finalConfig = await agentConfigManager.readAgentConfig(agentId);
        const byId = new Map(finalConfig.topics.map(t => [t.id, t.flowlockRequest]));
        assert.equal(byId.get('topic_specific_3').status, 'consumed');
        assert.equal(byId.get('topic_new_2').status, 'consumed');
        assert.equal(byId.get('topic_old_1').status, 'superseded');
        assert.equal(byId.get('topic_old_1').supersededByRequestId, 'req_new_2');

        // 4. 再次认领应返回 NOT_FOUND，证明无任何残留死锁
        const emptyRes = await claimHandler({}, agentId, {});
        assert.equal(emptyRes.success, false);
        assert.equal(emptyRes.code, 'NOT_FOUND');
    } finally {
        await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
});