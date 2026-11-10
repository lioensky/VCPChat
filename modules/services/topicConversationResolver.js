'use strict';

const fs = require('fs-extra');
const path = require('path');
const { conversationKey } = require('./historyMutationQueue');

function createTopicConversationResolver({ agentDir, groupDir, userDataDir }) {
    const roots = { agent: agentDir, group: groupDir };

    async function validate(scope) {
        conversationKey(scope);
        const config = await fs.readJson(path.join(roots[scope.itemType], scope.itemId, 'config.json'));
        const topic = config.topics?.find(item => item.id === scope.topicId);
        if (!topic) throw new Error('目标话题不存在');
        if (scope.itemType === 'group' && config.mode === 'game') {
            throw new Error('游戏话题必须通过游戏专属入口操作');
        }
        const history = path.join(userDataDir, scope.itemId, 'topics', scope.topicId, 'history.json');
        if (!await fs.pathExists(history)) throw new Error('目标话题历史不存在');
        return { scope: structuredClone(scope), config, topic };
    }

    async function resolve({ topicId, itemId, itemType } = {}) {
        // Reuse path validation even when ownership has not yet been resolved.
        conversationKey({ itemId: itemId || 'lookup', itemType: itemType || 'agent', topicId });
        if (itemId) {
            if (!itemType) throw new TypeError('指定归属ID时必须提供itemType');
            return validate({ itemId, itemType, topicId });
        }
        const matches = [];
        for (const type of itemType ? [itemType] : ['agent', 'group']) {
            let folders;
            try { folders = await fs.readdir(roots[type], { withFileTypes: true }); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            for (const folder of folders) {
                if (!folder.isDirectory()) continue;
                let config;
                try { config = await fs.readJson(path.join(roots[type], folder.name, 'config.json')); }
                catch (error) { if (error.code === 'ENOENT') continue; throw error; }
                if (config.topics?.some(topic => topic.id === topicId)) {
                    matches.push({ itemId: folder.name, itemType: type, topicId });
                }
            }
        }
        if (!matches.length) throw new Error(`未找到话题: ${topicId}`);
        if (matches.length !== 1) throw new Error(`话题ID归属不唯一: ${topicId}；请指定目标类型和归属ID`);
        return validate(matches[0]);
    }

    return { validate, resolve };
}

module.exports = { createTopicConversationResolver };