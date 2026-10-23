'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Rust CDS/MobileSync and the JS Queue do not share a process lock. Do not
// pretend that two independent history writers are serialized. Keep MobileSync
// read-capable, but refuse its writes to NativeSync-owned physical histories.
function createSyncWriterBoundary(queue) {
    const normalize = p => process.platform === 'win32' ? p.toLowerCase() : p;
    const topics = () => queue?.syncPolicy?.topics || [];
    return {
        active: () => topics().length > 0,
        assertWrite(target) {
            if (!queue || target.ownerType === 'user') return;
            if (topics().length) {
                const owner = path.resolve(queue.userDataDir, target.ownerId);
                const paths = target.topicId == null ? [owner] : [owner, path.join(owner, 'topics'), path.join(owner, 'topics', target.topicId), queue.getHistoryPath(target.ownerId, target.topicId)];
                for (const file of paths) {
                    try { if (fs.lstatSync(file).isSymbolicLink()) throw Object.assign(new Error('MobileSync path alias is excluded while NativeSync is active.'), {code:'SYNC_WRITER_EXCLUDED',retryable:false,status:409}); }
                    catch (e) { if (e.code !== 'ENOENT') throw e; }
                }
            }
            const root = normalize(path.resolve(queue.userDataDir, target.ownerId));
            const file = target.topicId == null ? null : normalize(queue.getHistoryPath(target.ownerId, target.topicId));
            const protectedPath = topics().some(t => file
                ? normalize(queue.getHistoryPath(t.itemId, t.topicId)) === file
                : normalize(path.resolve(queue.userDataDir, t.itemId)) === root);
            if (protectedPath) throw Object.assign(new Error('NativeSync owns this history. MobileSync is read-only for this topic/owner; disable NativeSync for it and restart before changing writers.'), {
                code: 'SYNC_WRITER_EXCLUDED', retryable: false, status: 409
            });
        }
    };
}
module.exports = { createSyncWriterBoundary };
