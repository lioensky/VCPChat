let operationService = null;
let replyPolicy = Object.freeze({ enabled: false, prompt: '' });

async function initialize({ services = {}, config = {} } = {}) {
    const candidate = services.pluginAgentOperationService;
    if (!candidate || typeof candidate.processToolCall !== 'function') {
        throw new Error('TopicSponsor 缺少 pluginAgentOperationService。');
    }
    operationService = candidate;
    replyPolicy = Object.freeze({
        enabled: config.REPLY_ADVANCE_ENABLED === true,
        prompt: typeof config.REPLY_INVITE_PROMPT === 'string' ? config.REPLY_INVITE_PROMPT.trim() : '',
    });
}

async function processToolCall(args = {}, executionContext = {}) {
    if (!operationService) {
        throw new Error('TopicSponsor 尚未初始化。');
    }
    return operationService.processToolCall('TopicSponsor', args, {
        ...executionContext,
        topicSponsorReplyPolicy: replyPolicy,
    });
}

module.exports = {
    initialize,
    processToolCall,
};