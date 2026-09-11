let operationService = null;

async function initialize({ services = {} } = {}) {
    const candidate = services.pluginAgentOperationService;
    if (!candidate || typeof candidate.processToolCall !== 'function') {
        throw new Error('TopicSponsor 缺少 pluginAgentOperationService。');
    }
    operationService = candidate;
}

async function processToolCall(args = {}, executionContext = {}) {
    if (!operationService) {
        throw new Error('TopicSponsor 尚未初始化。');
    }
    return operationService.processToolCall('TopicSponsor', args, executionContext);
}

module.exports = {
    initialize,
    processToolCall,
};