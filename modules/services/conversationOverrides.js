'use strict';

// An absent/null workspaceId selects all workspaces for search and no default tree.
// Rule keys are qualified by source to avoid official/user ID collisions.
function normalizeOverrides(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const result = { rules: {} };
    if (Object.prototype.hasOwnProperty.call(source, 'workspaceId')) {
        if (source.workspaceId === null || typeof source.workspaceId === 'string' && source.workspaceId) {
            result.workspaceId = source.workspaceId;
        }
    }
    if (source.rules && typeof source.rules === 'object' && !Array.isArray(source.rules)) {
        for (const [key, enabled] of Object.entries(source.rules)) {
            if (typeof enabled === 'boolean') {
                Object.defineProperty(result.rules, key, { value: enabled, enumerable: true, configurable: true, writable: true });
            }
        }
    }
    return result;
}

function ruleKey(rule) {
    return `${rule.source === 'official' ? 'official' : 'user'}:${rule.id}`;
}

function resolveOverrides({ overrides, rules = [], workspaces = [], activeWorkspaceId = null } = {}) {
    const normalized = normalizeOverrides(overrides);
    const selected = normalized.workspaceId || null;
    const valid = selected && workspaces.some(ws => ws.id === selected && ws.enabled !== false);
    return {
        overrides: normalized,

        workspaceInvalid: Boolean(selected && !valid),
        activeWorkspaceId: valid ? selected : null,
        rules: rules.map(rule => {
            const key = ruleKey(rule);
            const overridden = Object.prototype.hasOwnProperty.call(normalized.rules, key);
            return {
                ...rule,
                globalEnabled: rule.enabled !== false,
                enabled: overridden ? normalized.rules[key] : rule.enabled !== false,
                overrideEnabled: overridden ? normalized.rules[key] : null,
                overrideKey: key,
            };
        }),
    };
}

module.exports = { normalizeOverrides, ruleKey, resolveOverrides };