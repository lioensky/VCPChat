/* Agent-owned draft and persistence queue. No DOM or ambient IPC dependencies. */
(function exposeAgentEditSession(root) {
    'use strict';

    const clone = value => structuredClone(value);
    const freeze = value => {
        if (value && typeof value === 'object' && !Object.isFrozen(value)) {
            Object.values(value).forEach(freeze);
            Object.freeze(value);
        }
        return value;
    };

    class AgentEditSession {
        constructor({ agentId, config, revision, transport, onState = () => {} }) {
            if (!agentId || typeof transport !== 'function') {
                throw new TypeError('Agent edit session requires an identity and transport');
            }
            Object.defineProperty(this, 'agentId', { value: agentId, enumerable: true });
            this.base = freeze(clone(config || {}));
            this.draft = freeze(clone(config || {}));
            this.revision = revision;
            this.transport = transport;
            this.onState = onState;
            this.pending = new Map();
            this.acknowledged = new Map();
            this.sequence = 0;
            this.tail = Promise.resolve();
            this.failure = null;
            this.closed = false;
        }

        get dirty() {
            return this.pending.size > 0;
        }

        notify() {
            try {
                this.onState({
                    agentId: this.agentId,
                    dirty: this.dirty,
                    failure: this.failure,
                    revision: this.revision,
                });
            } catch (error) {
                console.error('Agent edit session state notification failed:', error);
            }
        }

        edit(patch) {
            if (this.closed) throw new Error('Agent edit session is closed');
            const next = { ...this.draft };
            for (const [key, value] of Object.entries(patch || {})) {
                if (JSON.stringify(next[key]) === JSON.stringify(value)) continue;
                next[key] = clone(value);
                this.pending.set(key, ++this.sequence);
            }
            this.draft = freeze(next);
            this.notify();
        }

        flush() {
            if (this.closed) return Promise.resolve({ success: false, error: 'session-closed' });
            // Capture now, not when the queue eventually runs.
            const entries = [...this.pending].map(([key, sequence]) => ({
                key, sequence, value: clone(this.draft[key]),
            }));
            const operationId = `agent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const run = async () => {
                // A prior queued commit may already have acknowledged this batch.
                const remaining = entries.filter(entry =>
                    entry.sequence > (this.acknowledged.get(entry.key) || 0));
                if (!remaining.length) return { success: true, skipped: true };
                // Conflicts require explicit resolution, never blind automatic retry.
                if (this.failure?.status === 'conflict') return this.failure;
                const patch = freeze(Object.fromEntries(remaining.map(entry => [entry.key, entry.value])));
                let result;
                try {
                    result = await this.transport(this.agentId, {
                        patch,
                        expectedRevision: this.revision,
                        operationId,
                    });
                } catch (error) {
                    result = { success: false, status: 'failed', error: error?.message || String(error) };
                }
                if (!result || result.success !== true || result.error) {
                    this.failure = result || { success: false, error: 'missing-save-result' };
                    this.notify();
                    return this.failure;
                }
                this.base = freeze({ ...this.base, ...clone(patch) });
                this.revision = result.currentRevision ?? this.revision;
                for (const entry of remaining) {
                    this.acknowledged.set(entry.key, entry.sequence);
                    if (this.pending.get(entry.key) === entry.sequence) this.pending.delete(entry.key);
                }
                this.failure = null;
                this.notify();
                return result;
            };
            const operation = this.tail.catch(() => {}).then(run);
            this.tail = operation;
            return operation;
        }

        async close() {
            const result = await this.flush();
            if (result.success === true && !this.dirty) this.closed = true;
            return result;
        }
    }

    root.VCPAgentEditSession = AgentEditSession;
    if (typeof module !== 'undefined' && module.exports) module.exports = AgentEditSession;
})(typeof window !== 'undefined' ? window : globalThis);