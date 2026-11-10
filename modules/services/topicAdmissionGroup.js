'use strict';

function createTopicAdmissionGroup({ readHistory, loadGroupConfig, runGroup, reportUncertain = null, logger = console }) {
    for (const dependency of [readHistory, loadGroupConfig, runGroup]) {
        if (typeof dependency !== 'function') throw new TypeError('Group admission dependencies missing');
    }
    return async function advanceGroup(request) {
        const { scope, token, messageId } = structuredClone(request || {});
        if (scope?.itemType !== 'group' || !scope.itemId || !scope.topicId || !token || !messageId) {
            throw new TypeError('Invalid group admission request');
        }
        const config = await loadGroupConfig(scope.itemId);
        if (!config || config.error || config.mode === 'game'
            || !Array.isArray(config.topics)
            || !config.topics.some(topic => topic.id === scope.topicId)) {
            throw new Error('目标群聊话题不存在或不允许公共推进');
        }
        const history = await readHistory(scope);
        const message = history.find(item => item.id === messageId);
        if (!message || !['user', 'assistant'].includes(message.role)) {
            throw new Error('中央提交的群聊消息不存在或角色无效');
        }
        const payload = {
            id: message.id,
            name: message.name,
            content: { text: message.role === 'user' && typeof message._metadata?.groupRequestText === 'string'
                ? message._metadata.groupRequestText
                : typeof message.content === 'string' ? message.content : message.content?.text || '' },
            originalUserText: typeof message.content === 'string' ? message.content : message.content?.text || '',
            attachments: structuredClone(message.attachments || []),
        };
        // Accept scheduling, not generation completion. The engine owns persistence
        // and lease lifecycle; an arbitrary rejection cannot prove safe release.
        queueMicrotask(() => {
            Promise.resolve().then(() => runGroup(scope.itemId, scope.topicId, payload, {
                committedMessageId: messageId,
                admissionToken: token,
            })).catch(async error => {
                logger.error?.('[Admission] group execution failed; inspect retained lease/history', {
                    scope, token, messageId, error,
                });
                if (typeof reportUncertain === 'function') {
                    await reportUncertain(scope, token, error);
                }
            }).catch(error => {
                logger.error?.('[Admission] cannot journal uncertain group execution', {
                    scope, token, messageId, error,
                });
            });
        });
        return { success: true, accepted: true, token };
    };
}

module.exports = { createTopicAdmissionGroup };