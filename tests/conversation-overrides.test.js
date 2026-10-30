'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOverrides, resolveOverrides } = require('../modules/services/conversationOverrides');

const workspaces = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }];
const rules = [{ id: 'x', source: 'official', enabled: false }, { id: 'x', source: 'user', enabled: true }];
test('absent/null workspace selects all, explicit binding is independent of global selection', () => {
    const base = { workspaces, activeWorkspaceId: 'a' };
    assert.equal(resolveOverrides(base).activeWorkspaceId, null);
    assert.equal(resolveOverrides({ ...base, overrides: { workspaceId: null } }).activeWorkspaceId, null);
    assert.equal(resolveOverrides({ ...base, overrides: { workspaceId: 'b' } }).activeWorkspaceId, 'b');
    const invalid = resolveOverrides({ ...base, overrides: { workspaceId: 'deleted' } });
    assert.equal(invalid.activeWorkspaceId, null);
    assert.equal(invalid.workspaceInvalid, true);
});
test('rule overrides are source qualified, immutable and isolated', () => {
    const a = resolveOverrides({ rules, overrides: { rules: { 'official:x': true, 'user:x': false } } });
    assert.deepEqual(a.rules.map(r => r.enabled), [true, false]);
    assert.deepEqual(resolveOverrides({ rules }).rules.map(r => r.enabled), [false, true]);
    assert.deepEqual(rules.map(r => r.enabled), [false, true]);
    a.rules[0].enabled = false;
    assert.equal(rules[0].enabled, false);
});
test('normalization discards malformed overrides and retains false', () => {
    assert.deepEqual(normalizeOverrides({ workspaceId: 2, rules: { a: false, b: 'true' } }), { rules: { a: false } });
});