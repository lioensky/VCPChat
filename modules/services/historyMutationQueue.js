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

// Windows 上别的程序开着 history.json 且不允许删除共享（杀毒、索引、编辑器、
// PowerShell Get-Content 等）时，用临时文件覆盖改名会报 EPERM/EACCES/EBUSY，
// 这次保存（例如一整条回复）就丢了。fs-extra 的 graceful-fs 只在目标不存在时重试，
// 覆盖已有文件不管，所以这里按退避再试约 21 秒。目标是文件夹或只读文件这类
// 等多久都不会好的情况立即报错。
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS = [100, 200, 400, 800, 1600, 3200, 5000, 5000, 5000];

async function renameBlockedForGood(target) {
    try {
        if ((await fs.stat(target)).isDirectory()) return true;
    } catch {
        return false;
    }
    try {
        await fs.access(target, fs.constants.W_OK);
        return false;
    } catch {
        return true;
    }
}

async function renameWithRetry(from, to, {
    delays = RENAME_RETRY_DELAYS,
    onRetry = null,
    platform = process.platform,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            await fs.rename(from, to);
            return;
        } catch (error) {
            if (platform !== 'win32' || !RENAME_RETRY_CODES.has(error.code)
                || attempt >= delays.length
                || (attempt === 0 && await renameBlockedForGood(to))) {
                throw error;
            }
            await sleep(delays[attempt]);
            onRetry?.();
        }
    }
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
        this.ownerBarriers = new Map();
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
        const owner = this.ownerKey(descriptor.itemId);
        const barrier = this.ownerBarriers.get(owner) || Promise.resolve();
        const current = Promise.all([previous.catch(() => {}), barrier.catch(() => {})]).then(operation);
        this.queues.set(key, current);
        current.finally(() => {
            if (this.queues.get(key) === current) this.queues.delete(key);
        }).catch(() => {});
        return current;
    }

    ownerKey(itemId) {
        const owner = path.resolve(this.userDataDir, validateSegment(itemId));
        return process.platform === 'win32' ? owner.toLowerCase() : owner;
    }

    runOwner(itemId, operation) {
        if (this.disposed) return Promise.reject(new Error('HistoryMutationQueue is disposed'));
        if (typeof operation !== 'function') throw new TypeError('Owner operation required');
        const owner = this.ownerKey(itemId);
        const previous = this.ownerBarriers.get(owner) || Promise.resolve();
        const prefix = owner + path.sep;
        const pending = [...this.queues].filter(([key]) => key.startsWith(prefix)).map(([, task]) => task);
        // Snapshot prior writes before publishing the barrier: later topic writes
        // wait for us, never become dependencies of this owner operation.
        const current = Promise.all([previous, ...pending].map(task => task.catch(() => {}))).then(operation);
        this.ownerBarriers.set(owner, current);
        current.finally(() => {
            if (this.ownerBarriers.get(owner) === current) this.ownerBarriers.delete(owner);
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

    async write(descriptor, history, { requireExisting = false } = {}) {
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
        if (requireExisting) {
            if (!await fs.pathExists(historyPath)) throw new Error('HISTORY_DELETED');
        } else {
            await fs.ensureDir(path.dirname(historyPath));
        }
        if (this.fileWatcher) this.fileWatcher.signalInternalSave?.();
        try {
            await fs.writeJson(tempPath, clone(history), { spaces: 2 });
            // 每次重试前重新标记内部保存，免得文件监视器把这次写入当成外部改动。
            await renameWithRetry(tempPath, historyPath, {
                onRetry: () => this.fileWatcher?.signalInternalSave?.(),
            });
        } catch (error) {
            await fs.remove(tempPath).catch(() => {});
            throw error;
        }
        return { success: true };
    }

    replace(descriptor, history, { requireExisting = false, expectedHistory } = {}) {
        descriptor = { ...descriptor };
        if (!Array.isArray(history)) throw new TypeError('History must be an array');
        const snapshot = clone(history);
        if (expectedHistory !== undefined && !Array.isArray(expectedHistory)) {
            throw new TypeError('Expected history must be an array');
        }
        const baseline = expectedHistory === undefined ? undefined : clone(expectedHistory);
        return this.run(descriptor, async () => {
            if (baseline !== undefined) {
                if (requireExisting && !await fs.pathExists(this.getHistoryPath(descriptor.itemId, descriptor.topicId))) {
                    throw new Error('HISTORY_DELETED');
                }
                const current = await this.read(descriptor);
                if (JSON.stringify(current) !== JSON.stringify(baseline)) {
                    throw Object.assign(new Error('历史已被其他操作修改，请刷新后重试'), { code: 'HISTORY_CONFLICT' });
                }
            }
            const result = await this.write(descriptor, snapshot, { requireExisting });
            return { ...result, history: snapshot };
        });
    }

    mutate(descriptor, transform, { requireExisting = false } = {}) {
        descriptor = { ...descriptor };
        if (typeof transform !== 'function') {
            throw new TypeError('History mutation requires a transform');
        }
        return this.run(descriptor, async () => {
            if (requireExisting && !await fs.pathExists(this.getHistoryPath(descriptor.itemId, descriptor.topicId))) {
                throw new Error('HISTORY_DELETED');
            }
            const current = await this.read(descriptor);
            const next = await transform(clone(current));
            const snapshot = clone(next);
            const result = await this.write(descriptor, snapshot, { requireExisting });
            return { ...result, history: snapshot };
        });
    }

    diagnostics() {
        return { disposed: this.disposed, pendingConversations: this.queues.size };
    }

    async dispose() {
        if (this.disposed) return;
        this.disposed = true;
        await Promise.allSettled([...this.queues.values(), ...this.ownerBarriers.values()]);
        this.queues.clear();
        this.ownerBarriers.clear();
    }
}

module.exports = { HistoryMutationQueue, conversationKey, renameWithRetry };