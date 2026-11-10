'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTopicSponsorDelivery } = require('../modules/services/topicSponsorDelivery');

function fixture(policy = {}, type = 'agent') {
    const calls = [];
    const scope = { itemType: type, itemId: 'nova', topicId: 'topic_target' };
    const deliver = createTopicSponsorDelivery({
        admission: { submit: async request => { calls.push(request); return { success: true, queued: true }; } },
        resolver: { resolve: async query => {
            if (query.topicId === '../bad') throw new Error('invalid');
            return { scope: query.topicId === 'source' ? { ...scope, topicId: 'source' } : scope, topic: { locked: false } };
        } },
        findAgent: async query => {
            if (query === 'unknown') throw new Error('未找到');
            return { id: query === 'Nova' ? 'nova' : 'kerr', name: query, avatarUrl: 'file:///avatar.webp' };
        },
        getPolicy: () => policy,
    });
    return { deliver, calls };
}

test('source footer is text and sender is independent of target; default is silent delivery', async () => {
    const { deliver, calls } = fixture();
    const result = await deliver({ sender_name: 'Kerr', topic_id: 'topic_target', source_topic_id: 'source', message: 'hello' }, { requestId: 'req' });
    assert.equal(result.queued, true);
    assert.equal(calls[0].message.content, '[Kerr的发言]:\nhello\n\n[该发言发送自source话题]');
    assert.equal(calls[0].message.agentId, 'kerr');
    assert.equal(calls[0].scope.itemId, 'nova');
    assert.equal(calls[0].message.avatarUrl, 'file:///avatar.webp');
    assert.equal(calls[0].triggerPolicy, 'none');
    assert.equal(calls[0].requestId, 'req');
    assert.equal(calls[0].message.sourceConversation, undefined);
});

test('group target advances only when configured and carries group rendering identity', async () => {
    const { deliver, calls } = fixture({ enabled: true, prompt: 'invite' }, 'group');
    await deliver({ sender_name: 'Kerr', topic_id: 'topic_target', target_type: 'group', message: 'hello' });
    assert.equal(calls[0].triggerPolicy, 'reply');
    assert.equal(calls[0].invitePrompt, 'invite');
    assert.equal(calls[0].message.isGroupMessage, true);
    assert.equal(calls[0].message.groupId, 'nova');
});

test('self-post with matching return address never automatically advances itself', async () => {
    const { deliver, calls } = fixture({ enabled: true });
    await deliver({ sender_name: 'Nova', topic_id: 'topic_target', source_topic_id: 'topic_target', message: 'note' });
    assert.equal(calls[0].triggerPolicy, 'none');
});

test('unknown sender and invalid source reject before queue submission', async () => {
    const { deliver, calls } = fixture();
    await assert.rejects(deliver({ sender_name: 'unknown', topic_id: 'topic_target', message: 'x' }), /未找到/);
    await assert.rejects(deliver({ sender_name: 'Kerr', topic_id: 'topic_target', source_topic_id: '../bad', message: 'x' }), /invalid/);
    assert.equal(calls.length, 0);
});
test('sender_name accepts case-insensitive includes and persists canonical identity; sender_id stays exact', async () => {
    const submitted = [];
    const deliver = createTopicSponsorDelivery({
        admission: { submit: async request => { submitted.push(request); return { success: true }; } },
        resolver: { resolve: async () => ({ scope: {}, topic: {} }) },
        findAgent: async () => ({ id: 'agent_kerr', name: 'Geek Kerr' }),
    });
    for (const sender_name of ['Ker', 'kErR', ' Geek Kerr ']) {
        const result = await deliver({ sender_name, topic_id: 't', message: 'x' });
        assert.equal(result.sender, 'Geek Kerr');
        assert.equal(result.sender_id, 'agent_kerr');
        assert.equal(submitted.at(-1).message.name, 'Geek Kerr');
        assert.match(submitted.at(-1).message.content, /^\[Geek Kerr的发言\]/);
    }
    await assert.rejects(deliver({ sender_id: 'Ker', topic_id: 't', message: 'x' }), /完整 Agent ID/);
    await assert.rejects(deliver({ sender_name: 'Kerr Extra', topic_id: 't', message: 'x' }), /包含匹配/);
    assert.equal(submitted.length, 3);
});

test('ambiguous sender candidate names and IDs reach the caller without submission', async () => {
    const detail = 'Agent 名称匹配不唯一: 小克；候选：\\n- 猫娘小克（ID: cat_1）\\n- 小克测试版（ID: cat_2）';
    const deliver = createTopicSponsorDelivery({
        admission: { submit: async () => assert.fail('ambiguous sender must not submit') },
        resolver: { resolve: async () => assert.fail('sender resolves first') },
        findAgent: async () => { throw new Error(detail); },
    });
    await assert.rejects(deliver({ sender_name: '小克', topic_id: 't', message: 'x' }),
        error => error.message === detail);
});

for (const signature of [{ maid: 'Nova' }, { valet: 'Nova' }, { maid: 'Ker' }]) {
    test(`ReplyToTopic tracing signature does not constrain destination: ${JSON.stringify(signature)}`, async () => {
        const queries = [];
        const destination = { itemType: 'agent', itemId: 'kerr', topicId: 'topic_kerr' };
        const deliver = createTopicSponsorDelivery({
            findAgent: async query => {
                assert.equal(query, 'Nova', 'only declared speaker is resolved as an agent');
                return { id: 'nova', name: 'Nova' };
            },
            resolver: { resolve: async query => {
                queries.push(query);
                assert.equal(query.itemId, undefined, 'signature must not become target owner');
                return { scope: destination, topic: {} };
            } },
            admission: { submit: async request => {
                assert.equal(request.scope.itemId, 'kerr');
                assert.equal(request.message.agentId, 'nova');
                return { success: true };
            } },
        });
        const result = await deliver({ ...signature, sender_name: 'Nova', topic_id: 'topic_kerr', message: 'hello' });
        assert.equal(result.target_id, 'kerr');
        assert.equal(queries.length, 1);
    });
}

test('topic ID alone routes to groups regardless of legacy owner fields or signature', async () => {
    const deliver = createTopicSponsorDelivery({
        findAgent: async () => ({ id: 'nova', name: 'Nova' }),
        resolver: { resolve: async query => {
            assert.deepEqual(query, { topicId: 'topic_group' });
            return {
                scope: { itemType: 'group', itemId: 'group_real', topicId: 'topic_group' },
                topic: {},
            };
        } },
        admission: { submit: async request => {
            assert.equal(request.scope.itemType, 'group');
            assert.equal(request.scope.itemId, 'group_real');
            assert.equal(request.message.groupId, 'group_real');
            assert.equal(request.message.agentId, 'nova');
            return { success: true, queued: true };
        } },
    });
    const result = await deliver({
        maid: 'Nova', sender_name: 'Nova', topic_id: 'topic_group',
        target_type: 'agent', target_id: 'irrelevant', message: 'hello',
    });
    assert.equal(result.target_type, 'group');
    assert.equal(result.target_id, 'group_real');
});

test('ambiguous topic still rejects even when tracing signature names an owner', async () => {
    const deliver = createTopicSponsorDelivery({
        findAgent: async () => ({ id: 'nova', name: 'Nova' }),
        resolver: { resolve: async query => {
            assert.equal(query.itemId, undefined);
            throw new Error('话题ID归属不唯一');
        } },
        admission: { submit: async () => assert.fail('must not guess a destination') },
    });
    await assert.rejects(deliver({
        maid: 'Nova', sender_name: 'Nova', topic_id: 'shared', message: 'hello',
    }), /归属不唯一/);
});

for (const itemType of ['agent', 'group']) {
    for (const locked of [false, true]) {
        for (const unread of [false, true]) {
            test(`reply admission ignores topic flags: ${itemType} locked=${locked} unread=${unread}`, async () => {
                let submitted = false;
                const scope = { itemType, itemId: 'destination', topicId: 'topic_destination' };
                const deliver = createTopicSponsorDelivery({
                    findAgent: async () => ({ id: 'nova', name: 'Nova' }),
                    resolver: { resolve: async query => {
                        assert.deepEqual(query, { topicId: scope.topicId });
                        return { scope, topic: { locked, unread } };
                    } },
                    admission: { submit: async request => {
                        submitted = true;
                        assert.deepEqual(request.scope, scope);
                        return { success: true, queued: true };
                    } },
                });
                const result = await deliver({
                    maid: 'Nova', sender_name: 'Nova', topic_id: scope.topicId, message: 'hello',
                });
                assert.equal(submitted, true);
                assert.equal(result.queued, true);
            });
        }
    }
}