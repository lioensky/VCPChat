import { assertChatRepositorySuccess, normalizeChatRepositoryError } from './chatRepository.js';

let authoritySequence = 0;

const conversationKey = ({ itemId, itemType = 'agent', topicId }) => {
    if (typeof itemId !== 'string' || !itemId || typeof topicId !== 'string' || !topicId) {
        throw new TypeError('历史事务需要 itemId 和 topicId');
    }
    if (!['agent', 'group'].includes(itemType)) throw new TypeError('历史事务会话类型无效');
    return JSON.stringify([itemType, itemId, topicId]);
};

// 历史/提交协议只接收普通数据。冻结 Map/Date 等对象并不能撤销其内部写能力。
const freezeData = (value, seen = new WeakSet()) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('历史事务只接受普通数据对象和数组');
    }
    seen.add(value);
    for (const child of Object.values(value)) freezeData(child, seen);
    return Object.freeze(value);
};
const snapshotData = value => freezeData(structuredClone(value));
const snapshotDescriptor = descriptor => {
    const snapshot = snapshotData({ ...descriptor, itemType: descriptor?.itemType || 'agent' });
    conversationKey(snapshot);
    return snapshot;
};
const snapshotHistory = history => {
    if (!Array.isArray(history)) throw new TypeError('历史事务需要历史数组');
    return snapshotData(history);
};

/**
 * 非流式历史事务权威；队列和版本均仅属于本实例，不是跨窗口锁或磁盘修订。
 *
 * mutate：队列内读基线，回调只调用一次，以 expectedHistory 做 CAS。
 * replace：可信生命周期调用方的显式整表替换能力（创建后填充、导入、确认替换）。
 * 普通追加/编辑/删除应使用 mutate；replace 不代表创建目录，不绕过宿主删除屏障。
 * 为兼容既有调用，replace 不强制新增授权字段；可用第三参数 expectedHistory 保护确认基线。
 */
export function createChatHistoryMutationAuthority({ repository } = {}) {
    if (!repository || typeof repository.getHistory !== 'function' || typeof repository.saveHistory !== 'function') {
        throw new TypeError('历史事务权威需要聊天仓储');
    }
    const queues = new Map();
    const subscriptions = new Map();
    const authorityId = `history-authority-${++authoritySequence}`;
    let localCommitVersion = 0;
    let subscriberErrors = 0;
    let receiptErrors = 0;
    let disposed = false;
    let disposal;

    const revoked = () => Object.assign(new Error('ChatHistoryMutationAuthority is disposed'), {
        code: 'HISTORY_AUTHORITY_DISPOSED',
    });
    const run = (descriptor, operation) => {
        if (disposed) return Promise.reject(revoked());
        const key = conversationKey(descriptor);
        const previous = queues.get(key) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        queues.set(key, current);
        current.finally(() => {
            if (queues.get(key) === current) queues.delete(key);
        }).catch(() => {});
        return current;
    };

    const publish = commit => {
        const listeners = subscriptions.get(conversationKey(commit.scope));
        for (const entry of [...(listeners || [])]) {
            if (!entry.active) continue;
            try {
                // 观察者不参与事务；不等待它，以免观察者反向等待队列导致死锁。
                Promise.resolve(entry.listener(commit)).catch(() => { subscriberErrors++; });
            } catch {
                subscriberErrors++;
            }
        }
    };

    const commit = async (descriptor, history, expectedHistory, operation) => {
        // 在保存前验证、隔离并深冻结，不能在成功保存后因历史不可冻结而报事务失败。
        const snapshot = snapshotHistory(history);
        let result;
        try {
            result = assertChatRepositorySuccess(await repository.saveHistory(
                descriptor.itemId,
                descriptor.itemType,
                descriptor.topicId,
                structuredClone(snapshot),
                expectedHistory === undefined ? undefined : { expectedHistory: structuredClone(expectedHistory) }
            ), '历史事务保存失败');
        } catch (error) {
            throw normalizeChatRepositoryError(error, '历史事务保存失败');
        }
        let receipt;
        try {
            receipt = snapshotData(result);
        } catch {
            // 保存已经成功，不可因不合规的适配器回执否定它，也不暴露可变回执。
            receiptErrors++;
            receipt = Object.freeze({ success: true, receiptUnavailable: true });
        }
        const scope = Object.freeze({
            itemId: descriptor.itemId, itemType: descriptor.itemType, topicId: descriptor.topicId,
        });
        const outcome = Object.freeze({
            category: descriptor.category || operation,
            ...scope,
            scope,
            operation,
            concurrency: expectedHistory === undefined ? 'controlled-replace' : 'compare-and-swap',
            authorityId,
            localCommitVersion: ++localCommitVersion,
            history: snapshot,
            result: receipt,
        });
        publish(outcome);
        return outcome;
    };

    return Object.freeze({
        replace(descriptor, history, options = {}) {
            if (disposed) return Promise.reject(revoked());
            const target = snapshotDescriptor(descriptor);
            const snapshot = snapshotHistory(history);
            const baseline = options.expectedHistory === undefined
                ? undefined : snapshotHistory(options.expectedHistory);
            return run(target, () => commit(target, snapshot, baseline, 'replace'));
        },
        mutate(descriptor, transform) {
            if (disposed) return Promise.reject(revoked());
            if (typeof transform !== 'function') throw new TypeError('历史事务需要变更回调');
            const target = snapshotDescriptor(descriptor);
            return run(target, async () => {
                let current;
                try {
                    current = assertChatRepositorySuccess(await repository.getHistory(
                        target.itemId, target.itemType, target.topicId
                    ), '历史事务读取失败');
                } catch (error) {
                    throw normalizeChatRepositoryError(error, '历史事务读取失败');
                }
                const baseline = snapshotHistory(current);
                // 任意异步回调可能有副作用；冲突必须交给调用方，不重放、不降级替换。
                const next = await transform(structuredClone(baseline));
                return commit(target, next, baseline, 'mutate');
            });
        },
        /**
         * 仅订阅本实例此 scope 的未来成功提交，不回放、不覆盖外部文件变更通知。
         * 返回幂等撤销函数；同一回调可独立订阅多次。事件与操作返回值是同一只读对象。
         */
        subscribe(scope, listener) {
            if (disposed) throw revoked();
            if (typeof listener !== 'function') throw new TypeError('提交订阅需要回调');
            const key = conversationKey(snapshotDescriptor(scope));
            const listeners = subscriptions.get(key) || new Set();
            const entry = { listener, active: true };
            listeners.add(entry);
            subscriptions.set(key, listeners);
            return () => {
                entry.active = false;
                listeners.delete(entry);
                if (!listeners.size && subscriptions.get(key) === listeners) subscriptions.delete(key);
            };
        },
        // 读取开始前捕获此水位，可用于识别本实例提交之后迟到的读取；不是磁盘 revision。
        getLocalCommitVersion() {
            return localCommitVersion;
        },
        diagnostics() {
            return Object.freeze({
                disposed, pendingConversations: queues.size, subscribedScopes: subscriptions.size,
                authorityId, localCommitVersion, subscriberErrors, receiptErrors,
            });
        },
        dispose() {
            if (disposal) return disposal;
            disposed = true;
            // 撤销新写入，已接受写入继续保存并通知；重复 dispose 等待同一次排水。
            disposal = Promise.allSettled([...queues.values()]).then(() => {
                queues.clear();
                subscriptions.clear();
            });
            return disposal;
        },
    });
}
