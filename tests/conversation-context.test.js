'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../modules/services/conversationContext');

test('target context isolates agent/group, serializes patches, and never mutates global rules', async () => {
    const configs = new Map([
        ['agent:a', { name: 'A' }], ['agent:b', { name: 'B' }], ['group:a', { name: 'Group A' }],
    ]);
    const rules = [{ id: 'r', source: 'official', enabled: false, content: 'rule' }];
    let activeWorkspaceId = 'one';
    service.initialize({
        load: async owner => structuredClone(configs.get(`${owner.type}:${owner.id}`)),
        update: async (owner, mutate) => {
            await new Promise(resolve => setTimeout(resolve, 2));
            const key = `${owner.type}:${owner.id}`;
            configs.set(key, mutate(structuredClone(configs.get(key))));
            return { success: true };
        },
        workspace: () => ({
            workspaces: [{ id: 'one', enabled: true }, { id: 'two', enabled: true }],
            activeWorkspaceId,
        }),
        rules: async () => ({ rules }),
    });
    await Promise.all([
        service.update({ type: 'agent', id: 'a' }, { kind: 'workspace', value: 'two' }),
        service.update({ type: 'agent', id: 'a' }, { kind: 'rule', key: 'official:r', value: true }),
        service.update({ type: 'group', id: 'a' }, { kind: 'workspace', value: null }),
    ]);
    const a = await service.resolve({ type: 'agent', id: 'a' });
    assert.equal(a.activeWorkspaceId, 'two');
    assert.equal(a.rules[0].enabled, true);
    assert.equal((await service.resolve({ type: 'group', id: 'a' })).activeWorkspaceId, null);
    assert.equal((await service.resolve({ type: 'agent', id: 'b' })).activeWorkspaceId, null);
    assert.equal((await service.resolve(null)).activeWorkspaceId, 'one');
    activeWorkspaceId = 'two';
    assert.equal(a.rules[0].enabled, true);
    assert.equal(rules[0].enabled, false);
    await service.update({ type: 'agent', id: 'a' }, { kind: 'rule', key: 'official:r', value: null });
    assert.equal((await service.resolve({ type: 'agent', id: 'a' })).rules[0].enabled, false);
    await assert.rejects(service.resolve({ type: 'agent', id: '../bad' }), /归属/);
    await assert.rejects(service.update({ type: 'agent', id: 'a' }, { kind: 'workspace', value: 'missing' }), /工作区/);
    await assert.rejects(service.update({ type: 'agent', id: 'a' }, { kind: 'rule', key: 'missing', value: true }), /规则/);
});