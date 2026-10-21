import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createFlowlockEnvironment() {
    const notifications = [];
    const window = {
        VCPMainChatState: {
            snapshot: () => ({ selectedItem: { id: 'agent-test', name: 'TestAgent' }, topicId: 'topic-test' })
        },
        uiHelperFunctions: {
            showToastNotification: (msg, type) => {
                notifications.push({ msg, type });
            }
        }
    };
    const document = {
        getElementById: () => null,
        querySelector: () => null
    };

    const context = vm.createContext({
        console,
        window,
        document,
        setTimeout,
        clearTimeout,
        Date,
        Math,
        Promise,
        CSS: { escape: s => s }
    });

    const protocolSrc = fs.readFileSync(path.join(__dirname, '../Flowlockmodules/flowlock-protocol.js'), 'utf8');
    vm.runInContext(protocolSrc, context, { filename: 'flowlock-protocol.js' });

    const managerSrc = fs.readFileSync(path.join(__dirname, '../Flowlockmodules/flowlock.js'), 'utf8');
    vm.runInContext(managerSrc, context, { filename: 'flowlock.js' });

    const chatAPI = {
        getAgentConfig: async () => ({ name: 'TestAgent' })
    };

    context.window.flowlockManager.initialize({
        electronAPI: chatAPI,
        uiHelper: context.window.uiHelperFunctions,
        continueWritingForContext: async () => {}
    });

    return {
        window: context.window,
        notifications,
        protocol: context.window.flowlockProtocol,
        manager: context.window.flowlockManager
    };
}

test('flowlock-protocol detects upstream error replies and suppresses commands and rendering', () => {
    const { protocol } = createFlowlockEnvironment();

    const errorMsg = '[ERROR]代理服务器在连接上游API时失败，可能已达到重试上限或网络错误：Fetch failedafterall retries.';
    const parsed = protocol.parse(errorMsg);
    assert.equal(parsed.isUpstreamError, true);
    assert.equal(parsed.shouldStart, false);
    assert.equal(parsed.hasCommands, false);
    assert.equal(protocol.transformForRender(errorMsg), errorMsg);

    // 带有空格或者换行的 [ERROR]
    const errorWithSpaces = '  \n [ERROR] 上游API连接超时';
    const parsedSpaces = protocol.parse(errorWithSpaces);
    assert.equal(parsedSpaces.isUpstreamError, true);
    assert.equal(parsedSpaces.shouldStart, false);

    // 即使错误消息中包含 [[Flowlock::Start]] 也绝不应启动或渲染气泡
    const sneakyError = '[ERROR] 连接失败 [[Flowlock::Start]] [[Flowlock::NextHeartbeat::5]]';
    const parsedSneaky = protocol.parse(sneakyError);
    assert.equal(parsedSneaky.isUpstreamError, true);
    assert.equal(parsedSneaky.shouldStart, false);
    assert.equal(parsedSneaky.hasCommands, false);
    assert.equal(protocol.transformForRender(sneakyError), sneakyError);

    // 正常文本中偶尔提到 error 词汇不应被误判为 upstream error
    const normalMsg = '任务中处理了一个 error 代码：\n[[Flowlock::Start]]';
    const parsedNormal = protocol.parse(normalMsg);
    assert.equal(parsedNormal.isUpstreamError, false);
    assert.equal(parsedNormal.shouldStart, true);
});

test('flowlock automatically stops when receiving upstream error reply with [ERROR] header', async () => {
    const env = createFlowlockEnvironment();
    const { manager, notifications } = env;

    // 启动心流锁
    const startResult = await manager.start('agent-test', 'topic-test', { startImmediately: false });
    assert.equal(startResult.success, true);
    assert.equal(manager.isAgentLocked('agent-test'), true);

    const session = manager.sessions.get('agent-test');
    assert.ok(session);
    session.activeMessageId = 'msg-123';

    const upstreamErrorContent = '[ERROR]代理服务器在连接上游API时失败，可能已达到重试上限或网络错误：Fetch failedafterall retries.';

    // 收到消息完成事件（上游返回 200，type 为 end，finishReason 为 stop）
    await manager.handleFinalizedMessage({
        type: 'end',
        messageId: 'msg-123',
        context: {
            agentId: 'agent-test',
            topicId: 'topic-test',
            isGroupMessage: false
        },
        content: upstreamErrorContent,
        finishReason: 'stop'
    });

    // 心流锁应已自动中断
    assert.equal(manager.isAgentLocked('agent-test'), false);
    assert.equal(session.status, 'stopped');
    assert.equal(session.completionReason, 'upstream_error');
    assert.equal(session.lastError, upstreamErrorContent);

    // 验证弹出了错误提示
    const errorToast = notifications.find(n => n.type === 'error' && n.msg.includes('收到上游回复报错，心流锁已自动中断'));
    assert.ok(errorToast, '应当弹出错误级别的中断通知');
});

test('inactive flowlock does not start on upstream error even if message contains start directive', async () => {
    const env = createFlowlockEnvironment();
    const { manager } = env;

    assert.equal(manager.isAgentLocked('agent-test'), false);

    await manager.handleFinalizedMessage({
        type: 'end',
        messageId: 'msg-456',
        context: {
            agentId: 'agent-test',
            topicId: 'topic-test',
            isGroupMessage: false
        },
        content: '[ERROR] 代理失败 [[Flowlock::Start]]',
        finishReason: 'stop'
    });

    assert.equal(manager.isAgentLocked('agent-test'), false);
});

test('compaction suspends heartbeat without releasing lock and resumes exactly once', async () => {
    const { manager } = createFlowlockEnvironment();
    try {
        await manager.start('agent-test', 'topic-test');
        manager.setCustomPrompt('agent-test', '保留下一轮提示词');
        manager.setNextHeartbeat('agent-test', 17);
        manager.scheduleNextRound('agent-test', 60000);
        const lease = manager.suspendForContextCompaction('agent-test', 'topic-test');
        assert.ok(lease);
        assert.equal(manager.isAgentLocked('agent-test'), true);
        assert.equal(manager.getSession('agent-test').contextCompactionSuspended, true);
        assert.equal(manager.sessions.get('agent-test').pendingTimer, null);
        manager.scheduleNextRound('agent-test', 1);
        await manager.triggerRound('agent-test');
        assert.equal(manager.getSession('agent-test').round, 0);
        assert.equal(manager.resumeAfterContextCompaction(lease), true);
        const timer = manager.sessions.get('agent-test').pendingTimer;
        assert.ok(timer);
        assert.equal(manager.getSession('agent-test').hasCustomPrompt, true);
        assert.equal(manager.getSession('agent-test').nextDelaySeconds, 17);
        assert.equal(manager.resumeAfterContextCompaction(lease), false);
        assert.equal(manager.sessions.get('agent-test').pendingTimer, timer);
    } finally { manager.cleanup(); }
});

test('stopping and restarting flowlock invalidates an older compaction lease', async () => {
    const { manager } = createFlowlockEnvironment();
    try {
        await manager.start('agent-test', 'topic-test');
        const lease = manager.suspendForContextCompaction('agent-test', 'topic-test');
        await manager.stop('agent-test');
        await manager.start('agent-test', 'topic-test');
        assert.equal(manager.resumeAfterContextCompaction(lease), false);
        assert.equal(manager.sessions.get('agent-test').pendingTimer, null);
        assert.equal(manager.getSession('agent-test').contextCompactionSuspended, false);
    } finally { manager.cleanup(); }
});

test('an old failed heartbeat cannot schedule or stop a restarted session', async () => {
    const { manager } = createFlowlockEnvironment();
    let reject;
    manager.continueWritingForContext = () => new Promise((_, fail) => { reject = fail; });
    try {
        await manager.start('agent-test', 'topic-test');
        const pending = manager.triggerRound('agent-test');
        await manager.stop('agent-test');
        await manager.start('agent-test', 'topic-test');
        reject(new Error('late old failure'));
        await pending;
        assert.equal(manager.getSession('agent-test').retryCount, 0);
        assert.equal(manager.sessions.get('agent-test').pendingTimer, null);
    } finally { manager.cleanup(); }
});

test('suspended compaction terminal clears active round without executing flowlock directives', async () => {
    const { manager } = createFlowlockEnvironment();
    try {
        await manager.start('agent-test', 'topic-test');
        const session = manager.sessions.get('agent-test');
        session.activeMessageId = 'interrupted-round';
        const lease = manager.suspendForContextCompaction('agent-test', 'topic-test');
        await manager.handleFinalizedMessage({
            type: 'end',
            messageId: 'interrupted-round',
            context: { agentId: 'agent-test', topicId: 'topic-test', isGroupMessage: false },
            content: '[[Flowlock::Stop]] [[Flowlock::NextHeartbeat::1]]',
            finishReason: 'cancelled'
        });
        assert.equal(manager.isAgentLocked('agent-test'), true);
        assert.equal(session.activeMessageId, null);
        assert.equal(session.pendingTimer, null);
        assert.equal(manager.getSession('agent-test').contextCompactionSuspended, true);
        assert.equal(manager.resumeAfterContextCompaction(lease), true);
        assert.ok(session.pendingTimer);
    } finally { manager.cleanup(); }
});