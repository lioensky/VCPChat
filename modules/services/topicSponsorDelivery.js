'use strict';

const { randomUUID } = require('crypto');

const DEFAULT_INVITE = '[系统提示:] 话题中有新的伙伴留言，现在请结合上下文回应。需要回信时可自行调用 TopicSponsor；无需回信时正常回复即可。';

/**
 * Source topic is only an optional textual return address, not an authenticated
 * provenance assertion. No OneRing/AA protocol is introduced here.
 */
function createTopicSponsorDelivery({ admission, resolver, findAgent, getPolicy = () => ({}) }) {
    if (!admission?.submit || !resolver?.resolve || typeof findAgent !== 'function') {
        throw new TypeError('TopicSponsor delivery dependencies missing');
    }
    const resolveRegisteredAgent = async (query, byId = false) => {
        const requested = query.trim();
        const agent = await findAgent(requested);
        const matches = byId
            ? agent?.id === requested
            : (agent?.id === requested
                || String(agent?.name || '').toLowerCase().includes(requested.toLowerCase()));
        if (!agent?.id || !matches) {
            throw new Error(byId
                ? 'sender_id 必须使用完整 Agent ID'
                : 'sender_name 必须匹配注册 Agent 名称（忽略大小写，支持包含匹配）');
        }
        return agent;
    };
    return async function deliver(args, executionContext = {}) {
        if (typeof args.message !== 'string' || !args.message.trim()) throw new TypeError('message 不能为空');
        const senderQuery = args.sender_id || args.sender_name;
        if (typeof senderQuery !== 'string' || !senderQuery.trim()) throw new TypeError('sender_id 或 sender_name 必需');
        // Unknown or ambiguous names must not silently impersonate the host.
        const speaker = await resolveRegisteredAgent(senderQuery, Boolean(args.sender_id));
        // Reply destinations are addressed solely by topic ID across agents and groups.
        // Legacy owner/type fields and tracing signatures must never constrain lookup.
        const target = await resolver.resolve({ topicId: args.topic_id });
        // Topic locks do not reject incoming replies; admission owns busy-topic deferral.
        const sourceId = args.source_topic_id;
        if (sourceId !== undefined && (typeof sourceId !== 'string' || !sourceId.trim())) {
            throw new TypeError('source_topic_id 无效');
        }
        if (sourceId) await resolver.resolve({ topicId: sourceId });
        const prefix = `[${speaker.name}的发言]`;
        let content = args.message.startsWith(prefix) ? args.message : `${prefix}:\n${args.message}`;
        if (sourceId) content += `\n\n[该发言发送自${sourceId}话题]`;
        const policy = executionContext.topicSponsorReplyPolicy || getPolicy() || {};
        // A self-post in its own source topic may persist but never self-wake.
        const selfPost = sourceId === target.scope.topicId && target.scope.itemType === 'agent'
            && target.scope.itemId === speaker.id;
        const message = {
            id: `msg_${randomUUID()}`, role: 'assistant', name: speaker.name, agentId: speaker.id,
            avatarUrl: speaker.avatarUrl || null,
            avatarColor: speaker.avatarColor || 'rgb(96,106,116)',
            content, timestamp: Date.now(), isThinking: false, finishReason: 'completed',
            isGroupMessage: target.scope.itemType === 'group',
            ...(target.scope.itemType === 'group' ? { groupId: target.scope.itemId, topicId: target.scope.topicId } : {}),
            _metadata: { createdBy: 'plugin', isPluginReply: true,
                speaker_agent_id: speaker.id, speaker_name: speaker.name },
        };
        const accepted = await admission.submit({
            scope: target.scope, message,
            requestId: executionContext.requestId || executionContext.vcpContext?.requestId,
            triggerPolicy: policy.enabled === true && !selfPost ? 'reply' : 'none',
            invitePrompt: policy.prompt || DEFAULT_INVITE,
        });
        return {
            ...accepted, topic_id: target.scope.topicId,
            target_id: target.scope.itemId, target_type: target.scope.itemType,
            message_id: message.id, sender: speaker.name, sender_id: speaker.id,
        };
    };
}

module.exports = { createTopicSponsorDelivery, DEFAULT_INVITE };