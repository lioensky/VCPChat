'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PluginAgentOperationService } = require('../modules/services/pluginAgentOperationService');
const plugin = require('../VCPDistributedServer/Plugin/TopicSponsor/topicsponsor-service');

test('direct plugin routes bare-topic replies through admission with trusted policy and request idempotency', async () => {
    const calls = [];
    const service = new PluginAgentOperationService({
        agentDir: 'unused', userDataDir: 'unused',
        agentConfigManager: {}, historyMutationQueue: {},
        topicDelivery: async (args, context) => {
            calls.push({ args, context });
            await new Promise(resolve => setImmediate(resolve));
            return { success: true, queued: true, entryId: 'entry' };
        },
    });
    await plugin.initialize({
        services: { pluginAgentOperationService: service },
        config: { REPLY_ADVANCE_ENABLED: false, REPLY_INVITE_PROMPT: 'configured invite' },
    });
    const args = { command: 'ReplyToTopic', topic_id: 'topic', sender_name: 'Kerr', message: 'hello',
        REPLY_ADVANCE_ENABLED: true };
    const context = { requestId: 'same-request', topicSponsorReplyPolicy: { enabled: true } };
    const results = await Promise.all([
        plugin.processToolCall(args, context),
        plugin.processToolCall(args, context),
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].context.requestId, 'same-request');
    assert.equal(calls[0].context.topicSponsorReplyPolicy.enabled, false);
    assert.equal(calls[0].context.topicSponsorReplyPolicy.prompt, 'configured invite');
    assert.equal(results[0].entryId, results[1].entryId);
    assert.equal(args.maid, undefined); // Must route before the legacy findAgent(args.maid).
});

test('plugin default is disabled; explicit typed host config enables reply progression', async () => {
    const contexts = [];
    const service = { processToolCall: async (_tool, _args, context) => { contexts.push(context); } };
    await plugin.initialize({ services: { pluginAgentOperationService: service } });
    await plugin.processToolCall({});
    assert.equal(contexts[0].topicSponsorReplyPolicy.enabled, false);
    await plugin.initialize({
        services: { pluginAgentOperationService: service },
        config: { REPLY_ADVANCE_ENABLED: true },
    });
    await plugin.processToolCall({});
    assert.equal(contexts[1].topicSponsorReplyPolicy.enabled, true);
});
test('real distributed plugin config parser supplies typed policy to direct service', async () => {
    const manager = require('../VCPDistributedServer/Plugin');
    const manifest = require('../VCPDistributedServer/Plugin/TopicSponsor/plugin-manifest.json');
    for (const [raw, expected] of [['true', true], ['false', false], ['1', false]]) {
        const config = manager._getPluginConfig({
            ...manifest, pluginSpecificEnvConfig: {
                REPLY_ADVANCE_ENABLED: raw, REPLY_INVITE_PROMPT: '  configured  ',
            },
        });
        assert.equal(config.REPLY_ADVANCE_ENABLED, expected);
        let received;
        await plugin.initialize({
            config,
            services: { pluginAgentOperationService: {
                processToolCall: async (_name, _args, context) => { received = context; },
            } },
        });
        await plugin.processToolCall({ REPLY_ADVANCE_ENABLED: !expected });
        assert.equal(received.topicSponsorReplyPolicy.enabled, expected);
        assert.equal(received.topicSponsorReplyPolicy.prompt, 'configured');
    }
});