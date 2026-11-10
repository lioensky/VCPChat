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

test('TopicSponsor discovery lists canonical identities and five newest topics without history reads', async t => {
    const { service, agentConfigManager } = await fixture(t);
    const topics = Array.from({ length: 8 }, (_, i) => ({
        id: `topic_${i}`, name: `标题${i}`, createdAt: i, locked: true, unread: false,
    }));
    await agentConfigManager.writeAgentConfig('cat-id', { name: '猫娘小克', systemPrompt: 'secret', topics });
    const groupRoot = path.join(service.appDataRoot, 'AgentGroups');
    await fs.outputJson(path.join(groupRoot, 'group-id', 'config.json'),
        { name: 'Nova讨论群', secret: 'hidden', topics: [...topics].reverse() });
    const call = args => service.processTopicCommand(args);
    const agents = await call({ command: 'ListAgents', maid: 'irrelevant' });
    assert.ok(agents.agents.some(a => a.id === 'cat-id' && a.name === '猫娘小克'));
    assert.equal(JSON.stringify(agents).includes('secret'), false);
    const groups = await call({ command: 'ListGroups' });
    assert.deepEqual(groups.groups, [{ id: 'group-id', name: 'Nova讨论群', type: 'group' }]);
    for (const query of ['小克', 'cat-id', '猫娘小克']) {
        const result = await call({ command: 'ListRecentTopics', query });
        assert.equal(result.owner.id, 'cat-id');
        assert.equal(result.total, 8);
        assert.deepEqual(result.topics.map(topic => topic.topic_id), ['topic_7', 'topic_6', 'topic_5', 'topic_4', 'topic_3']);
        assert.equal(result.topics[0].title, '标题7');
    }
    assert.equal((await call({ command: 'ListRecentTopics', query: 'nOvA' })).owner.type, 'group');
    await agentConfigManager.writeAgentConfig('cat-test', { name: '小克测试版', topics: [] });
    await assert.rejects(call({ command: 'ListRecentTopics', query: '小克' }),
        error => ['猫娘小克', 'cat-id', '小克测试版', 'cat-test'].every(s => error.message.includes(s)));
    await assert.rejects(call({ command: 'ListRecentTopics', query: 'unknown' }), /未找到/);
    await assert.rejects(call({ command: 'ListRecentTopics', query: '../escape' }), /非法/);
    assert.deepEqual((await call({ command: 'ListRecentTopics', query: 'cat-test' })).topics, []);
    await fs.outputJson(path.join(groupRoot, 'same-name', 'config.json'), { name: '猫娘小克', topics: [] });
    await assert.rejects(call({ command: 'ListRecentTopics', query: '猫娘小克' }), /不唯一/);
    assert.equal((await call({ command: 'ListRecentTopics', query: '小克', target_type: 'group' })).owner.id, 'same-name');
});

test('TopicSponsor ReadTopicContent 与审阅命令支持群聊、无 _Agent_ 前缀目录及免/误填 maid 按 topic_id 自动穿透', async t => {
    const { service, agentConfigManager, historyMutationQueue } = await fixture(t);

    // 1. 模拟无 _Agent_ 前缀的中文 Agent 目录（如 ____1792051189604）
    const customAgentId = '____1792051189604';
    await agentConfigManager.writeAgentConfig(customAgentId, {
        name: '迪欧尼亚',
        topics: [{ id: 'topic_dionia_1', name: '日常讨论', createdAt: Date.now(), locked: false, unread: true }],
    });
    await historyMutationQueue.replace(
        { itemId: customAgentId, itemType: 'agent', topicId: 'topic_dionia_1' },
        [
            { id: 'm1', role: 'user', name: 'User', content: '早安', timestamp: 1000 },
            { id: 'm2', role: 'assistant', name: '迪欧尼亚', content: '早安[[VCP调用结果信息汇总: hidden VCP调用结果结束]]', timestamp: 2000 },
        ]
    );

    // 2. 模拟群聊目录（如 ________1773831250136）
    const groupId = '________1773831250136';
    const groupRoot = path.join(service.appDataRoot, 'AgentGroups');
    await fs.outputJson(path.join(groupRoot, groupId, 'config.json'), {
        id: groupId,
        name: '开发讨论组',
        mode: 'sequential',
        topics: [{ id: 'topic_group_1', name: '架构联调讨论', createdAt: Date.now() }],
    });
    await historyMutationQueue.replace(
        { itemId: groupId, itemType: 'group', topicId: 'topic_group_1' },
        [
            { id: 'gm1', role: 'user', name: 'User', content: '大家来看看群聊穿透问题', timestamp: 3000 },
            { id: 'gm2', role: 'assistant', speakerName: '小克', content: '[小克的发言]:\n收到，马上排查！', timestamp: 4000 },
            { id: 'gm3', role: 'assistant', _metadata: { speaker_name: '小娜' }, content: '[小娜的发言]:\n单测已就绪。', timestamp: 5000 },
        ]
    );

    // 用例 A：免填 maid，仅凭群聊 topic_id 直接读取群聊历史（Markdown & JSON）
    const groupMd = await service.processTopicCommand({
        command: 'ReadTopicContent',
        topic_id: 'topic_group_1',
    });
    assert.equal(groupMd.owner_type, 'group');
    assert.equal(groupMd.agent_name, '开发讨论组');
    assert.equal(groupMd.group_id, groupId);
    assert.equal(groupMd.message_count, 3);
    assert.match(groupMd.content, /Agent: 小克/);
    assert.match(groupMd.content, /Agent: 小娜/);

    const groupJson = await service.processTopicCommand({
        command: 'ReadTopicContent',
        maid: '讨论组',
        topic_id: 'topic_group_1',
        format: 'json',
    });
    assert.equal(groupJson.owner_type, 'group');
    assert.deepEqual(groupJson.messages.map(m => m.name), ['User', '小克', '小娜']);

    // 用例 B：调用方误将自身署名填作 maid（如 maid: '小娜'），但传入了群聊或其他 Agent 的唯一 topic_id -> 智能纠偏定位
    const fallbackGroup = await service.processTopicCommand({
        command: 'ReadTopicContent',
        maid: '小娜',
        topic_id: 'topic_group_1',
    });
    assert.equal(fallbackGroup.agent_id, groupId);
    assert.equal(fallbackGroup.owner_type, 'group');

    const customAgentRead = await service.processTopicCommand({
        command: 'ReadTopicContent',
        topic_id: 'topic_dionia_1',
    });
    assert.equal(customAgentRead.agent_id, customAgentId);
    assert.equal(customAgentRead.agent_name, '迪欧尼亚');
    assert.equal(customAgentRead.content.includes('VCP调用结果信息汇总'), false, '必须隐去工具回执汇总块');

    // 用例 C：群聊支持 ListUnlockedTopics / CheckNewTopics / CheckTopicOwnership
    const groupUnlocked = await service.processTopicCommand({
        command: 'ListUnlockedTopics',
        maid: '开发讨论组',
    });
    assert.equal(groupUnlocked.owner_type, 'group');
    assert.equal(groupUnlocked.unlocked_topics_count, 1);
    assert.equal(groupUnlocked.topics[0].topic_id, 'topic_group_1');

    const groupOwnership = await service.processTopicCommand({
        command: 'CheckTopicOwnership',
        topic_id: 'topic_group_1',
        caller_name: 'User',
    });
    assert.equal(groupOwnership.is_owner, true);
    assert.equal(groupOwnership.owner_type, 'group');

    // 用例 D：当调用方署名 maid 存在前缀歧义（如 '汉娜' 同时前缀匹配 '汉娜一号' 与 '汉娜二号'），但传入了唯一 topic_id -> 凭唯一 topic_id 精准定位
    await agentConfigManager.writeAgentConfig('hanna-1', { name: '汉娜一号', topics: [] });
    await agentConfigManager.writeAgentConfig('hanna-2', { name: '汉娜二号', topics: [] });
    const ambiguousMaidWithUniqueTopic = await service.processTopicCommand({
        command: 'ReadTopicContent',
        maid: '汉娜',
        topic_id: 'topic_group_1',
    });
    assert.equal(ambiguousMaidWithUniqueTopic.agent_id, groupId);
    assert.equal(ambiguousMaidWithUniqueTopic.owner_type, 'group');
});