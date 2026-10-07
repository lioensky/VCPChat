const fs = require('fs-extra');
const path = require('path');
const { randomUUID } = require('crypto');

// 同 sideChatHandlers.js 的 CHILD_ID_PATTERN
const SIDE_CHAT_CHILD_ID = /^sidechat_\d+_[0-9a-f]+$/;

function validateSegment(value) {
    if (typeof value !== 'string' || !value ||
        /[<>:"/\\|?*\x00-\x1f]/.test(value) ||
        value === '.' || value === '..' || /[. ]$/.test(value) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
        throw new TypeError('Invalid history path identifier');
    }
    return value;
}

function conversationKey({ itemId, itemType = 'agent', topicId }) {
    validateSegment(itemId);
    validateSegment(topicId);
    if (!['agent', 'group'].includes(itemType)) {
        throw new TypeError('Invalid history item type');
    }
    return `${itemType}:${itemId}/topic:${topicId}`;
}

function clone(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

/**
 * 主进程侧话题历史写入权威。
 *
 * 同一个 item/topic 的所有操作按队列串行执行；mutate 会在队列内部
 * 重新读取磁盘上的最新历史，避免多个 mutate 操作之间丢失更新。
 * replace 保留完整替换语义：旧快照仍可能覆盖并发消息，调用方必须
 * 另行提供版本校验或基于最新历史的变更意图。此队列不提供跨进程锁。
 */
class HistoryMutationQueue {
    constructor({ userDataDir, fileWatcher = null, logger = console } = {}) {
        if (!userDataDir) throw new TypeError('HistoryMutationQueue requires userDataDir');
        this.userDataDir = userDataDir;
        this.fileWatcher = fileWatcher;
        this.logger = logger;
        this.queues = new Map();
        this.disposed = false;
    }

    getHistoryPath(itemId, topicId) {
        return path.resolve(this.userDataDir, validateSegment(itemId), 'topics', validateSegment(topicId), 'history.json');
    }

    run(descriptor, operation) {
        if (this.disposed) return Promise.reject(new Error('HistoryMutationQueue is disposed'));
        conversationKey(descriptor);
        // Agent/Group 的存储路径没有类型层级，必须按真实文件串行。
        const historyPath = this.getHistoryPath(descriptor.itemId, descriptor.topicId);
        const key = process.platform === 'win32' ? historyPath.toLowerCase() : historyPath;
        const previous = this.queues.get(key) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        this.queues.set(key, current);
        current.finally(() => {
            if (this.queues.get(key) === current) this.queues.delete(key);
        }).catch(() => {});
        return current;
    }

    async read(descriptor) {
        conversationKey(descriptor);
        const historyPath = this.getHistoryPath(descriptor.itemId, descriptor.topicId);
        if (!await fs.pathExists(historyPath)) return [];
        const history = await fs.readJson(historyPath);
        if (!Array.isArray(history)) throw new Error(`历史记录不是数组: ${historyPath}`);
        return history;
    }

    async write(descriptor, history) {
        if (!Array.isArray(history)) throw new TypeError('History must be an array');
        conversationKey(descriptor);
        const historyPath = this.getHistoryPath(descriptor.itemId, descriptor.topicId);
        const tempPath = `${historyPath}.${process.pid}.${randomUUID()}.tmp`;
        // 辅助对话的子话题目录只由 side-chat:create-child 建（带标记文件）。目录没了说明它已被删除
        // （父话题或助手被删时，流式回复被取消后还会存一次）；这时不能顺手把目录建回来，
        // 否则会留下没有标记、谁也删不掉也列不出来的孤儿目录
        if (SIDE_CHAT_CHILD_ID.test(descriptor.topicId) && !await fs.pathExists(path.dirname(historyPath))) {
            throw new Error('SIDE_CHAT_CHILD_DELETED');
        }
        await fs.ensureDir(path.dirname(historyPath));
        if (this.fileWatcher) this.fileWatcher.signalInternalSave?.();
        try {
            await fs.writeJson(tempPath, clone(history), { spaces: 2 });
            await fs.rename(tempPath, historyPath);
        } catch (error) {
            await fs.remove(tempPath).catch(() => {});
            throw error;
        }
        return { success: true };
    }

    replace(descriptor, history) {
        descriptor = { ...descriptor };
        if (!Array.isArray(history)) throw new TypeError('History must be an array');
        const snapshot = clone(history);
        return this.run(descriptor, async () => {
            const result = await this.write(descriptor, snapshot);
            return { ...result, history: snapshot };
        });
    }

    mutate(descriptor, transform) {
        descriptor = { ...descriptor };
        if (typeof transform !== 'function') {
            throw new TypeError('History mutation requires a transform');
        }
        return this.run(descriptor, async () => {
            const current = await this.read(descriptor);
            const next = await transform(clone(current));
            const snapshot = clone(next);
            const result = await this.write(descriptor, snapshot);
            return { ...result, history: snapshot };
        });
    }

    diagnostics() {
        return { disposed: this.disposed, pendingConversations: this.queues.size };
    }

    async dispose() {
        if (this.disposed) return;
        this.disposed = true;
        await Promise.allSettled([...this.queues.values()]);
        this.queues.clear();
    }
}

module.exports = { HistoryMutationQueue, conversationKey };