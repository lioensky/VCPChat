'use strict';

const { createHash, randomUUID } = require('crypto');
const { formatTopicRiverQuote } = require('./topicRiverQuote');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dispatchResult = (receipt, scope, messageId, flowlock) => ({
    success: receipt.success, accepted: receipt.accepted, queued: receipt.queued,
    replayed: receipt.replayed === true, entryId: receipt.entryId,
    topic_id: scope.topicId, target_id: scope.itemId, target_type: scope.itemType,
    message_id: messageId,
    ...(flowlock ? { flowlock_requested: true } : {}),
});

const DEFAULT_INVITE = '[系统提示:] 话题中有新的伙伴留言，现在请结合上下文回应。需要回信时可自行调用 TopicSponsor；无需回信时正常回复即可。';

/**
 * Source topic is only an optional textual return address, not an authenticated
 * provenance assertion. No OneRing/AA protocol is introduced here.
 */
function createTopicSponsorDelivery({ admission, resolver, findAgent, prepareDispatchTopic, getPolicy = () => ({}) }) {
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
        const isDispatch = args.mode === 'new_topic';
        const riverQuote = await formatTopicRiverQuote(args.river_context);
        const body = riverQuote ? `${args.message.trimEnd()}\n\n${riverQuote}` : args.message;
        if (args.flowlock !== undefined && ![true, false, 'true', 'false'].includes(args.flowlock)) {
            throw new TypeError('flowlock 必须为 true 或 false');
        }
        const flowlock = args.flowlock === true || args.flowlock === 'true';
        if (flowlock && !isDispatch) throw new TypeError('flowlock 只适用于 new_topic');
        if (args.mode !== undefined && !isDispatch) throw new TypeError('mode 只支持 new_topic，回复已有话题时请省略');
        const requestId = executionContext.requestId || executionContext.vcpContext?.requestId;
        const sourceId = args.source_topic_id;
        let dispatch = null;
        let title;
        if (isDispatch) {
            if (typeof prepareDispatchTopic !== 'function' || typeof admission.getDispatchReceipt !== 'function') {
                throw new Error('当前宿主未接通新话题派工');
            }
            if (args.topic_id !== undefined) throw new TypeError('new_topic 不接受目的 topic_id');
            if (typeof sourceId !== 'string' || !sourceId.trim()) throw new TypeError('new_topic 需要当前 source_topic_id');
            if (typeof args.target_agent !== 'string' || !args.target_agent.trim()) throw new TypeError('new_topic 需要 target_agent');
            if (args.topic_name !== undefined && (typeof args.topic_name !== 'string' || !args.topic_name.trim())) {
                throw new TypeError('topic_name 不能为空');
            }
            if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('新话题派工需要宿主请求 ID');
            title = args.topic_name?.trim();
            dispatch = {
                key: hash(['TopicSponsor.new_topic', requestId]),
                fingerprint: hash([sourceId, args.target_agent.trim(), Boolean(args.sender_id), senderQuery.trim(), title, body, flowlock]),
            };
            const accepted = admission.getDispatchReceipt(dispatch.key, dispatch.fingerprint);
            if (accepted) return dispatchResult(accepted, accepted.scope, accepted.messageId, flowlock);
        }

        // Unknown or ambiguous names must not silently impersonate the host.
        const speaker = await resolveRegisteredAgent(senderQuery, Boolean(args.sender_id));
        let target;
        if (isDispatch) {
            await resolver.resolve({ topicId: sourceId });
            const agent = await findAgent(args.target_agent.trim(), { dispatchTarget: true });
            target = await prepareDispatchTopic({
                agent, speaker, sourceId, title: title || `来自 ${speaker.name} 的任务`, flowlock, ...dispatch,
            });
        } else {
            // Legacy owner/type fields and tracing signatures never constrain the destination lookup.
            target = await resolver.resolve({ topicId: args.topic_id });
            if (sourceId !== undefined && (typeof sourceId !== 'string' || !sourceId.trim())) {
                throw new TypeError('source_topic_id 无效');
            }
            if (sourceId) await resolver.resolve({ topicId: sourceId });
        }
        const prefix = `[${speaker.name}的发言]`;
        let content = body.startsWith(prefix) ? body : `${prefix}:\n${body}`;
        if (sourceId) content += `\n\n[该发言发送自${sourceId}话题]`;
        const policy = executionContext.topicSponsorReplyPolicy || getPolicy() || {};
        // A self-post in its own source topic may persist but never self-wake.
        const selfPost = sourceId === target.scope.topicId && target.scope.itemType === 'agent'
            && target.scope.itemId === speaker.id;
        const message = {
            id: `msg_${dispatch ? dispatch.key.slice(0, 32) : randomUUID()}`, role: 'assistant', name: speaker.name, agentId: speaker.id,
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
            requestId,
            triggerPolicy: isDispatch || (policy.enabled === true && !selfPost) ? 'reply' : 'none',
            invitePrompt: isDispatch
                ? '[系统提示:] 这是从另一个话题派来的独立任务。请按首条留言推进；需要回报时，使用 TopicSponsor 回复来源话题。'
                : policy.prompt || DEFAULT_INVITE,
        }, dispatch);
        if (isDispatch) return dispatchResult(accepted, accepted.scope || target.scope, accepted.messageId || message.id, flowlock);
        return {
            ...accepted, topic_id: target.scope.topicId,
            target_id: target.scope.itemId, target_type: target.scope.itemType,
            message_id: message.id, sender: speaker.name, sender_id: speaker.id,
        };
    };
}

module.exports = { createTopicSponsorDelivery, DEFAULT_INVITE };