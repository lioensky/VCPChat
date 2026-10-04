const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');

const AgentConfigManager = require('../modules/utils/agentConfigManager');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');
const {
    PluginAgentOperationService,
} = require('../modules/services/pluginAgentOperationService');

async function fixture(t) {
    const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-plugin-agent-'));
    const agentDir = path.join(appDataRoot, 'Agents');
    const userDataDir = path.join(appDataRoot, 'UserData');
    await fs.ensureDir(agentDir);
    await fs.ensureDir(userDataDir);

    const agentConfigManager = new AgentConfigManager(agentDir);
    const historyMutationQueue = new HistoryMutationQueue({ userDataDir });
    const service = new PluginAgentOperationService({
        agentDir,
        userDataDir,
        appDataRoot,
        agentConfigManager,
        historyMutationQueue,
    });

    const agentId = 'agent-a';
    await agentConfigManager.writeAgentConfig(agentId, {
        name: '小娜',
        model: 'model-a',
        promptMode: 'original',
        originalSystemPrompt: 'old prompt',
        systemPrompt: 'old prompt',
        topics: [{ id: 'existing-topic', name: '已有话题', createdAt: 1, locked: false, unread: false }],
        unrelated: { keep: true },
    });
    await historyMutationQueue.replace(
        { itemId: agentId, itemType: 'agent', topicId: 'existing-topic' },
        [{ id: 'existing-message', role: 'user', content: 'hello' }]
    );

    t.after(async () => {
        await historyMutationQueue.dispose();
        await fs.remove(appDataRoot);
    });

    return {
        service,
        agentId,
        agentConfigManager,
        historyMutationQueue,
    };
}

test('PromptSponsor 委托只修改拥有字段并保留话题与无关配置', async t => {
    const { service, agentId, agentConfigManager } = await fixture(t);

    const result = await service.processPromptCommand({
        command: 'SetOriginalPrompt',
        agentId,
        content: '',
    }, { requestId: 'prompt-1' });

    assert.equal(result.length, 0);
    const config = await agentConfigManager.readAgentConfig(agentId);
    assert.equal(config.originalSystemPrompt, '');
    assert.equal(config.systemPrompt, '');
    assert.equal(config.model, 'model-a');
    assert.equal(config.unrelated.keep, true);
    assert.deepEqual(config.topics.map(topic => topic.id), ['existing-topic']);
});

test('TopicSponsor 创建话题不覆盖 Prompt 配置，重复 requestId 幂等', async t => {
    const { service, agentId, agentConfigManager, historyMutationQueue } = await fixture(t);
    const args = {
        command: 'CreateTopic',
        maid: '小娜',
        topic_name: '插件话题',
        initial_message: '第一句话',
    };

    const first = await service.processTopicCommand(args, { requestId: 'topic-create-1' });
    const repeated = await service.processTopicCommand(args, { requestId: 'topic-create-1' });

    assert.equal(repeated.topic_id, first.topic_id);
    const config = await agentConfigManager.readAgentConfig(agentId);
    assert.equal(config.originalSystemPrompt, 'old prompt');
    assert.equal(config.model, 'model-a');
    assert.equal(config.topics.filter(topic => topic.id === first.topic_id).length, 1);

    const history = await historyMutationQueue.read({
        itemId: agentId,
        itemType: 'agent',
        topicId: first.topic_id,
    });
    assert.equal(history.length, 1);
    assert.equal(history[0].content, '第一句话');
});

test('TopicSponsor 并发回复通过历史队列保留全部消息', async t => {
    const { service, agentId, historyMutationQueue } = await fixture(t);

    await Promise.all(Array.from({ length: 20 }, (_, index) =>
        service.processTopicCommand({
            command: 'ReplyToTopic',
            maid: '小娜',
            topic_id: 'existing-topic',
            message: `reply-${index}`,
            sender_name: '小娜',
        }, { requestId: `reply-${index}` })
    ));

    const history = await historyMutationQueue.read({
        itemId: agentId,
        itemType: 'agent',
        topicId: 'existing-topic',
    });
    assert.equal(history.length, 21);
    assert.equal(new Set(history.slice(1).map(message => message.content)).size, 20);
});

test('提示词与话题并发委托保留双方字段', async t => {
    const { service, agentId, agentConfigManager } = await fixture(t);

    await Promise.all([
        service.processPromptCommand({
            command: 'SetPromptMode',
            agentId,
            mode: 'preset',
        }, { requestId: 'set-mode-concurrent' }),
        service.processTopicCommand({
            command: 'CreateFlowlockTopic',
            maid: '小娜',
            topic_name: '并发话题',
            initial_message: '并发消息',
            flowlock_heartbeat: 8,
        }, { requestId: 'create-flowlock-concurrent' }),
    ]);

    const config = await agentConfigManager.readAgentConfig(agentId);
    assert.equal(config.promptMode, 'preset');
    assert.equal(config.systemPrompt, '');
    assert.equal(config.topics.length, 2);
    assert.equal(config.topics[0].flowlockRequest.requestId, 'create-flowlock-concurrent');
});

test('MobileSync 与后台 TopicSponsor 并发时通过中央配置桥保留双方更新', async t => {
    const { service, agentId, agentConfigManager } = await fixture(t);

    const [, , backgroundTopic] = await Promise.all([
        service.applySyncedAgentOwner(agentId, {
            name: '同步后的名称',
            model: 'model-synced',
            topics: [{ id: 'must-not-replace', name: '越权话题' }],
            unrelated: { keep: false },
        }),
        service.applySyncedAgentTopics(agentId, [{
            id: 'synced-topic',
            ownerId: agentId,
            name: '手机同步话题',
            createdAt: 20,
            locked: true,
            unread: false,
        }]),
        service.processTopicCommand({
            command: 'CreateTopic',
            maid: '小娜',
            topic_name: '后台汇报话题',
            initial_message: '后台工作已经完成。',
        }, { requestId: 'background-report-concurrent' }),
    ]);

    const config = await agentConfigManager.readAgentConfig(agentId);
    const topicIds = new Set(config.topics.map(topic => topic.id));
    assert.equal(config.name, '同步后的名称');
    assert.equal(config.model, 'model-synced');
    assert.equal(config.unrelated.keep, true, '同步不得覆盖 Owner 白名单外字段');
    assert.equal(topicIds.has('existing-topic'), true);
    assert.equal(topicIds.has('synced-topic'), true);
    assert.equal(topicIds.has(backgroundTopic.topic_id), true);
    assert.equal(topicIds.has('must-not-replace'), false);
});

test('未知命令和非法目标在写入前被拒绝', async t => {
    const { service, agentConfigManager } = await fixture(t);

    await assert.rejects(
        service.processPromptCommand({ command: 'WriteAnyFile', agentId: 'agent-a' }),
        /白名单/
    );
    await assert.rejects(
        service.processTopicCommand({ command: 'ReadTopicContent', maid: '..', topic_id: 'x' }),
        /非法/
    );

});

for (const [tier, names, query] of [
    ['exact', ['小娜', '小娜'], '小娜'],
    ['prefix', ['小娜一号', '小娜二号'], '小娜'],
    ['contains', ['甲小娜', '乙小娜'], '小娜'],
]) {
    test(`equal ${tier} name matches reject a topic write without mutating either agent`, async t => {
        const { service, agentConfigManager } = await fixture(t);
        await agentConfigManager.updateAgentConfig('agent-a', config => ({ ...config, name: names[0] }));
        await agentConfigManager.writeAgentConfig('agent-b', { name: names[1], topics: [] });
        const before = await Promise.all(['agent-a', 'agent-b'].map(id => agentConfigManager.readAgentConfig(id)));
        await assert.rejects(service.processTopicCommand({
            command: 'CreateTopic', maid: query, topic_name: 'must not exist', initial_message: 'must not be written',
        }, { requestId: `ambiguous-${tier}` }), /不唯一/);
        const after = await Promise.all(['agent-a', 'agent-b'].map(id => agentConfigManager.readAgentConfig(id)));
        assert.deepEqual(after, before);
    });
}

test('unique exact name outranks fuzzy matches and an explicit ID disambiguates duplicate names', async t => {
    const { service, agentConfigManager } = await fixture(t);
    await agentConfigManager.writeAgentConfig('agent-b', { name: '小娜副本', topics: [] });
    const created = await service.processTopicCommand({
        command: 'CreateTopic', maid: '小娜', topic_name: 'exact match', initial_message: 'hello',
    }, { requestId: 'exact-priority' });
    assert.equal((await agentConfigManager.readAgentConfig('agent-a')).topics.some(topic => topic.id === created.topic_id), true);
    assert.deepEqual((await agentConfigManager.readAgentConfig('agent-b')).topics, []);
    await agentConfigManager.updateAgentConfig('agent-b', config => ({ ...config, name: '小娜' }));
    const byId = await service.processTopicCommand({
        command: 'CreateTopic', maid: 'agent-b', topic_name: 'explicit ID', initial_message: 'hello',
    }, { requestId: 'id-priority' });
    assert.deepEqual((await agentConfigManager.readAgentConfig('agent-b')).topics.map(topic => topic.id), [byId.topic_id]);
    assert.equal((await agentConfigManager.readAgentConfig('agent-a')).topics.length, 2);
});