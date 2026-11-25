'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const AgentConfigManager = require('../modules/utils/agentConfigManager');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');
const { createTopicConversationResolver } = require('../modules/services/topicConversationResolver');
const { createTopicMessageAdmissionStore } = require('../modules/services/topicMessageAdmissionStore');
const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');
const { PluginAgentOperationService } = require('../modules/services/pluginAgentOperationService');
const { createTopicSponsorDelivery } = require('../modules/services/topicSponsorDelivery');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-task-dispatch-'));
    const agentDir = path.join(root, 'Agents');
    const groupDir = path.join(root, 'AgentGroups');
    const userDataDir = path.join(root, 'UserData');
    const manager = new AgentConfigManager(agentDir);
    const history = new HistoryMutationQueue({ userDataDir });
    const resolver = createTopicConversationResolver({ agentDir, groupDir, userDataDir });
    const store = createTopicMessageAdmissionStore(path.join(root, 'queue.json'));
    const scopes = [
        { itemType: 'agent', itemId: 'sender', topicId: 'topic_single' },
        { itemType: 'group', itemId: 'team', topicId: 'topic_group' },
        { itemType: 'agent', itemId: 'cat', topicId: 'topic_cat_current' },
    ];
    await manager.writeAgentConfig('sender', { name: 'Kerr', topics: [{ id: scopes[0].topicId }] });
    await manager.writeAgentConfig('cat', {
        name: '猫娘小克', current_topic_id: scopes[2].topicId, topics: [{ id: scopes[2].topicId }],
    });
    await fs.outputJson(path.join(groupDir, 'team', 'config.json'), { topics: [{ id: scopes[1].topicId }] });
    for (const scope of scopes) await history.replace(scope, []);
    const advances = [];
    let admission;
    async function start({ beforeSubmit } = {}) {
        admission = new TopicMessageAdmission({
            store, validate: resolver.validate,
            commit: (scope, message) => history.mutate(scope, messages =>
                messages.some(item => item.id === message.id) ? messages : [...messages, message],
            { requireExisting: true }),
            advance: async request => { advances.push(request); },
        });
        await admission.initialize();
        let service;
        const delivery = createTopicSponsorDelivery({
            admission: {
                getDispatchReceipt: (...args) => admission.getDispatchReceipt(...args),
                submit: async (...args) => {
                    await beforeSubmit?.();
                    return admission.submit(...args);
                },
            },
            resolver,
            findAgent: (...args) => service.findAgent(...args),
            prepareDispatchTopic: request => service.prepareDispatchTopic(request),
        });
        service = new PluginAgentOperationService({
            agentDir, userDataDir, appDataRoot: root, agentConfigManager: manager,
            historyMutationQueue: history, topicDelivery: delivery, topicResolver: resolver,
        });
        return service;
    }
    t.after(async () => {
        await admission?.dispose();
        await history.dispose();
        await fs.remove(root);
    });
    return { manager, history, store, start, advances, get admission() { return admission; } };
}

const createArgs = source => ({
    command: 'ReplyToTopic', mode: 'new_topic', source_topic_id: source,
    target_agent: '小克', sender_name: 'kerr', message: '请核对任务结果',
});
async function until(predicate) {
    const expires = Date.now() + 5000;
    while (!predicate()) {
        if (Date.now() >= expires) assert.fail('timeout waiting for admission advance');
        await delay(10);
    }
}

for (const source of ['topic_single', 'topic_group']) {
    test(`从 ${source} 派工只建一个新话题，并可回到来源`, async t => {
        const f = await fixture(t);
        const service = await f.start();
        const args = createArgs(source);
        const execution = { requestId: `dispatch:${source}` };
        const [first, duplicate] = await Promise.all([
            service.processTopicCommand(args, execution), service.processTopicCommand(args, execution),
        ]);
        assert.equal(first.accepted, true);
        assert.equal(duplicate.topic_id, first.topic_id);
        assert.equal(duplicate.message_id, first.message_id);
        assert.equal(first.target_id, 'cat');
        await assert.rejects(service.processTopicCommand({ ...args, message: '不同任务' }, execution), /不同的任务/);
        await until(() => f.advances.length === 1);
        const [{ scope, token }] = f.advances;
        assert.equal(scope.topicId, first.topic_id);
        const config = await f.manager.readAgentConfig('cat');
        assert.equal(config.current_topic_id, 'topic_cat_current');
        assert.equal(config.topics.length, 2);
        assert.equal(config.topics[0].flowlockRequest, undefined);
        const messages = await f.history.read(scope);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].id, first.message_id);
        assert.match(messages[0].content, new RegExp(source));
        const back = await service.processTopicCommand({
            command: 'ReplyToTopic', sender_name: '小克', topic_id: source,
            source_topic_id: first.topic_id, message: '完工',
        }, { requestId: 'reply' });
        assert.equal(back.topic_id, source);
        assert.equal(back.target_type, source === 'topic_group' ? 'group' : 'agent');

        await f.admission.release(scope, token, { saved: true });
        await f.admission.dispose();
        const restarted = await f.start();
        const replay = await restarted.processTopicCommand(args, execution);
        assert.equal(replay.replayed, true);
        assert.equal(replay.queued, false);
        assert.equal(replay.topic_id, first.topic_id);
        assert.equal(f.admission.snapshot(scope).length, 0);
        assert.equal(f.advances.length, 1);
    });
}

test('建题后未入场可恢复，不覆盖现有话题，也不重写首条任务', async t => {
    const f = await fixture(t);
    let fail = true;
    const service = await f.start({ beforeSubmit: () => {
        if (fail) throw new Error('入场前断开');
    } });
    const args = createArgs('topic_single');
    const execution = { requestId: 'retry-before-submit' };
    await assert.rejects(service.processTopicCommand(args, execution), /入场前断开/);
    const original = (await f.manager.readAgentConfig('cat')).topics[0].id;
    fail = false;
    const received = await service.processTopicCommand(args, execution);
    assert.equal(received.topic_id, original);
    await until(() => f.advances.length === 1);
    assert.equal((await f.history.read(f.advances[0].scope)).length, 1);
});

test('无效来源、混合目的和歧义简称都不建题', async t => {
    const f = await fixture(t);
    await f.manager.writeAgentConfig('cat2', { name: '小克实验室', topics: [] });
    const service = await f.start();
    const args = createArgs('topic_single');
    await assert.rejects(service.processTopicCommand(args, { requestId: 'ambiguous' }), /猫娘小克.*\n.*小克实验室/s);
    await assert.rejects(service.processTopicCommand({ ...args, topic_id: 'topic_cat_current' },
        { requestId: 'mixed' }), /不接受目的/);
    await assert.rejects(service.processTopicCommand({ ...args, source_topic_id: 'topic_missing' },
        { requestId: 'missing' }), /未找到话题/);
    assert.equal((await f.manager.readAgentConfig('cat')).topics.length, 1);
    assert.equal((await f.manager.readAgentConfig('cat2')).topics.length, 0);
    assert.equal(f.admission.snapshot().length, 0);
});

test('explicit flowlock dispatch records an idle-only request tied to the task message', async t => {
    const f = await fixture(t);
    const service = await f.start();
    const args = { ...createArgs('topic_group'), flowlock: 'true' };
    const execution = { requestId: 'dispatch-flowlock' };
    const result = await service.processTopicCommand(args, execution);
    assert.equal(result.flowlock_requested, true);
    const config = await f.manager.readAgentConfig('cat');
    const request = config.topics.find(topic => topic.id === result.topic_id).flowlockRequest;
    assert.equal(request.status, 'pending');
    assert.equal(request.idleOnly, true);
    assert.equal(request.initialMessageId, result.message_id);
    await assert.rejects(service.processTopicCommand({ ...args, flowlock: false }, execution), /不同的任务/);
    assert.equal((await service.processTopicCommand(args, execution)).replayed, true);
    await until(() => f.advances.length === 1);
});