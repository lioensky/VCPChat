'use strict';

((root, factory) => {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.ScriptoriumAsync = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    function createLatestTokenRegistry() {
        const revisions = new Map();

        function begin(channel = 'default') {
            const key = String(channel);
            const revision = (revisions.get(key) || 0) + 1;
            revisions.set(key, revision);
            return Object.freeze({
                channel: key,
                revision,
                isCurrent() {
                    return revisions.get(key) === revision;
                },
            });
        }

        function invalidate(channel = 'default') {
            const key = String(channel);
            revisions.set(key, (revisions.get(key) || 0) + 1);
        }

        function isCurrent(token) {
            return Boolean(
                token
                && revisions.get(String(token.channel)) === token.revision
            );
        }

        return Object.freeze({
            begin,
            invalidate,
            isCurrent,
        });
    }

    function createSerialQueue() {
        let tail = Promise.resolve();

        function enqueue(task) {
            if (typeof task !== 'function') {
                return Promise.reject(new TypeError('串行队列任务必须是函数。'));
            }
            const result = tail.then(task, task);
            tail = result.then(() => undefined, () => undefined);
            return result;
        }

        function whenIdle() {
            return tail;
        }

        return Object.freeze({
            enqueue,
            whenIdle,
        });
    }

    function createCoordinator(options = {}) {
        const latest = createLatestTokenRegistry();
        const queues = new Map();
        const getGeneration = typeof options.getGeneration === 'function'
            ? options.getGeneration
            : () => null;
        const getDocumentId = typeof options.getDocumentId === 'function'
            ? options.getDocumentId
            : () => null;
        const getRevision = typeof options.getRevision === 'function'
            ? options.getRevision
            : () => null;

        function captureContext(extra = {}) {
            return Object.freeze({
                generation: getGeneration(),
                documentId: getDocumentId(),
                revision: getRevision(),
                ...extra,
            });
        }

        function isContextCurrent(context, checks = {}) {
            if (!context) return false;
            if (context.generation !== getGeneration()) return false;
            if (checks.document !== false && context.documentId !== getDocumentId()) {
                return false;
            }
            if (checks.revision === true && context.revision !== getRevision()) {
                return false;
            }
            return true;
        }

        function queue(channel = 'default') {
            const key = String(channel);
            if (!queues.has(key)) queues.set(key, createSerialQueue());
            return queues.get(key);
        }

        return Object.freeze({
            beginLatest: latest.begin,
            invalidateLatest: latest.invalidate,
            isLatest: latest.isCurrent,
            captureContext,
            isContextCurrent,
            enqueue(channel, task) {
                return queue(channel).enqueue(task);
            },
            whenIdle(channel = 'default') {
                return queue(channel).whenIdle();
            },
        });
    }

    return Object.freeze({
        createCoordinator,
        createLatestTokenRegistry,
        createSerialQueue,
    });
});