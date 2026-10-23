'use strict';
const { fail } = require('./protocol');
function mergeTerminal(current, projected, tombstones = []) {
    if (!projected || !Array.isArray(projected.history) || typeof projected.messageId !== 'string' || !projected.messageId) throw fail('INVALID_TERMINAL');
    const removed = new Set(tombstones);
    if (!projected.history.some(m => m?.id === projected.messageId && !m.isThinking && !m.isPendingStream)) throw fail('INVALID_TERMINAL');
    if (removed.has(projected.messageId)) throw fail('TERMINAL_MESSAGE_DELETED');
    const result = new Map(current.map(m => [m.id, m]));
    for (const candidate of projected.history) {
        if (!candidate?.id || candidate.isThinking || candidate.isPendingStream || removed.has(candidate.id)) continue;
        const previous = result.get(candidate.id);
        if (candidate.id === projected.messageId) {
            const value = previous ? { ...previous } : { ...candidate };
            for (const field of ['content', 'finishReason', 'isThinking', 'isPendingStream', 'streamOperationId']) {
                if (Object.hasOwn(candidate, field)) value[field] = candidate[field];
            }
            result.set(candidate.id, value);
        } else if (!previous) result.set(candidate.id, { ...candidate });
    }
    return [...result.values()].sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
}
module.exports = { mergeTerminal };
