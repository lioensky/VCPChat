'use strict';
const { normalizeOverrides, resolveOverrides } = require('./conversationOverrides');
let runtime = null;
const queues = new Map();

function normalizeOwner(owner) {
    if (owner == null) return null;
    if (!['agent', 'group'].includes(owner.type) || typeof owner.id !== 'string' ||
        !owner.id || /[\\/:]/.test(owner.id) || owner.id === '.' || owner.id === '..') {
        throw new Error('无效的会话归属');
    }
    return { type: owner.type, id: owner.id };
}

function initialize(context) { runtime = context; }

async function resolve(owner) {
    owner = normalizeOwner(owner);
    if (!runtime) throw new Error('Conversation context 未初始化');
    const config = owner ? await runtime.load(owner) : {};
    if (!config || config.error) throw new Error(config?.error || '会话配置不存在');
    const workspace = runtime.workspace();
    const store = await runtime.rules();
    const effective = resolveOverrides({
        overrides: owner ? config.conversationOverrides : { workspaceId: workspace.activeWorkspaceId },
        rules: store.rules,
        workspaces: workspace.workspaces,
        activeWorkspaceId: workspace.activeWorkspaceId,
    });
    return { success: true, owner, ...workspace, ...effective };
}

async function update(owner, patch) {
    owner = normalizeOwner(owner);
    if (!owner) throw new Error('局部覆盖必须指定会话');
    const key = `${owner.type}:${owner.id}`;
    const previous = queues.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
        if (!patch || !['workspace', 'rule'].includes(patch.kind)) throw new Error('无效的覆盖操作');
        if (patch.kind === 'workspace' && patch.value !== null) {
            const workspace = runtime.workspace();
            if (!workspace.workspaces.some(ws => ws.enabled !== false && ws.id === patch.value)) {
                throw new Error('工作区不存在或已停用');
            }
        }
        if (patch.kind === 'rule') {
            const store = await runtime.rules();
            if (!store.rules.some(rule => `${rule.source}:${rule.id}` === patch.key) ||
                ![true, false, null].includes(patch.value)) throw new Error('无效的规则覆盖');
        }
        const result = await runtime.update(owner, current => {
            const next = normalizeOverrides(current.conversationOverrides);
            if (patch.kind === 'workspace') {
                next.workspaceId = patch.value;
            } else {
                if (patch.value === null) delete next.rules[patch.key];
                else Object.defineProperty(next.rules, patch.key, {
                    value: patch.value, enumerable: true, writable: true, configurable: true,
                });
            }
            return { ...current, conversationOverrides: next };
        });
        if (result?.success === false || result?.error) throw new Error(result.error || '保存失败');
        return resolve(owner);
    });
    queues.set(key, task);
    try { return await task; }
    finally { if (queues.get(key) === task) queues.delete(key); }
}

module.exports = { initialize, resolve, update, normalizeOwner };