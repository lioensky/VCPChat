'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { durableJson } = require('./durableJson');
const { identity, canonicalMessage, messageKey, messageHash, tombstoneHash, descriptor, wireTopic, fail } = require('./protocol');

function validatePullPage(result, cursor, limit) {
    if (!result || !Array.isArray(result.events) || result.events.length > limit ||
        !Number.isSafeInteger(result.headSeq) || !Number.isSafeInteger(result.nextSeq) ||
        result.headSeq < cursor || result.nextSeq < cursor || result.nextSeq > result.headSeq ||
        typeof result.hasMore !== 'boolean' || result.hasMore !== (result.nextSeq < result.headSeq)) throw fail('INVALID_PULL_CURSOR');
    if (result.hasMore && result.nextSeq === cursor) throw fail('PAGINATION_STALLED');
    let previous = cursor;
    for (const event of result.events) {
        if (!Number.isSafeInteger(event?.seq) || event.seq <= previous) throw fail('CURSOR_REWIND');
        if (event.seq > result.nextSeq) throw fail('INVALID_PULL_CURSOR');
        previous = event.seq;
    }
}

// State locks never wait for Queue or network. Queue -> short state transaction is
// the only nested lock order; HTTP is always outside both locks.
class NativeSyncAdapter {
    static async open(options) {
        const adapter = new NativeSyncAdapter(options);
        try { adapter.state = JSON.parse(await fs.readFile(adapter.statePath, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (adapter.state.deviceId !== adapter.deviceId || adapter.state.version !== 1 || !Array.isArray(adapter.state.outbox) || !Number.isSafeInteger(adapter.state.cursor) || adapter.state.cursor < 0 || !adapter.state.acked) throw fail('INVALID_SYNC_STATE');
        if (JSON.stringify(adapter.state.topics) !== JSON.stringify(adapter.topics)) throw fail('OWNER_BINDING_CHANGED');
        adapter.queue.configureSync(adapter, event => adapter.observe(event));
        try { await adapter.recover(); }
        catch (error) { await adapter.recordDegradation(error); }
        return adapter;
    }

    constructor({ queue, statePath, deviceId, url, token, topics, notify = () => {}, persist = durableJson, request = null }) {
        const endpoint = new URL(url);
        if (!(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1')) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw fail('PROTECTED_SYNC_ENDPOINT_REQUIRED');
        if (!queue || !deviceId || !statePath || !token || !Array.isArray(topics) || !topics.length) throw fail('INVALID_SYNC_OPTIONS');
        this.queue = queue; this.statePath = statePath; this.deviceId = deviceId;
        this.url = endpoint.origin; this.token = token; this.notify = notify; this.persist = persist;
        this.requestOverride = request; this.tail = Promise.resolve(); this.busy = false;
        this.degraded = null; this.notificationPending = new Map();
        this.topics = topics.map(d => ({ itemId: d.itemId, itemType: d.itemType || 'agent', topicId: d.topicId }));
        this.bindings = new Map();
        for (const d of this.topics) {
            identity({ ...wireTopic(d), msgId: '_binding' });
            const file = this.queue.getHistoryPath(d.itemId, d.topicId);
            const key = process.platform === 'win32' ? file.toLowerCase() : file;
            if (this.bindings.has(key)) throw fail('OWNER_PATH_CONFLICT');
            this.bindings.set(key, JSON.stringify(wireTopic(d)));
        }
        this.state = { version: 1, deviceId, topics: this.topics, cursor: 0, acked: {}, outbox: [], pending: null };
    }

    isEnabled(d) {
        return this.topics.some(t => t.itemId === d.itemId && t.itemType === (d.itemType || 'agent') && t.topicId === d.topicId);
    }
    deletedMessageIds(d) {
        const deleted = new Set();
        for (const [key, value] of Object.entries(this.state.acked)) {
            const [type, owner, topic, msg] = JSON.parse(key);
            if (type === d.itemType && owner === d.itemId && topic === d.topicId && value.deleted) deleted.add(msg);
        }
        for (const op of this.state.outbox) {
            if (op.ownerType === d.itemType && op.ownerId === d.itemId && op.topicId === d.topicId) {
                if (op.action === 'delete') deleted.add(op.msgId); else deleted.delete(op.msgId);
            }
        }
        return [...deleted];
    }
    assertTopic(d) {
        if (!this.isEnabled(d)) throw fail('OWNER_BINDING_MISMATCH');
        const file = this.queue.getHistoryPath(d.itemId, d.topicId);
        const key = process.platform === 'win32' ? file.toLowerCase() : file;
        if (this.bindings.get(key) !== JSON.stringify(wireTopic(d))) throw fail('OWNER_PATH_CONFLICT');
    }
    async assertPhysicalPath(d) {
        const root = path.resolve(this.queue.userDataDir);
        const file = this.queue.getHistoryPath(d.itemId, d.topicId);
        const segments = path.relative(root, file).split(path.sep);
        let current = root;
        for (const segment of ['', ...segments]) {
            if (segment) current = path.join(current, segment);
            try {
                const info = await fs.lstat(current);
                if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw fail('OWNER_PATH_ALIAS');
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
    async beforeRead(d) {
        if (this.isEnabled(d)) { this.assertTopic(d); await this.assertPhysicalPath(d); }
    }
    async beforeWrite(d) {
        if (this.isEnabled(d)) {
            this.assertTopic(d);
            await this.assertPhysicalPath(d);
            if (this.state.pending && d.syncSource !== 'remote') throw fail('SYNC_RECOVERY_REQUIRED');
        } else {
            const file = this.queue.getHistoryPath(d.itemId, d.topicId);
            const key = process.platform === 'win32' ? file.toLowerCase() : file;
            if (this.bindings.has(key)) throw fail('OWNER_PATH_CONFLICT');
        }
    }
    transaction(fn) {
        const current = this.tail.catch(() => {}).then(async () => {
            const next = structuredClone(this.state);
            const result = await fn(next);
            await this.persist(this.statePath, next);
            this.state = next;
            return result;
        });
        this.tail = current;
        return current;
    }
    async recordDegradation(error) {
        this.degraded = error.code || 'SYNC_CAPTURE_FAILED';
        await durableJson(`${this.statePath}.degraded`, { code: this.degraded, recoverable: true }).catch(() => {});
    }
    async observe({ descriptor: d, history, revision }) {
        this.assertTopic(d);
        try {
            if (d.syncSource === 'remote') {
                const event = d.syncEvent;
                await this.transaction(next => {
                    const key = messageKey(event);
                    if (!next.acked[key] || next.acked[key].seq < event.seq) next.acked[key] = { hash: event.hash, deleted: event.action === 'delete', seq: event.seq };
                    next.cursor = Math.max(next.cursor, event.seq);
                    next.pending = null;
                });
                const change = { agentId: d.itemId, ownerId: d.itemId, ownerType: d.itemType, topicId: d.topicId, revision, source: 'native-sync', seq: event.seq };
                this.notificationPending.set(JSON.stringify(wireTopic(d)), change);
                // Notification failure cannot undo an already durable cursor. Retain
                // dirty notification and retry independently, including at recovery.
                this.retryNotifications();
            } else {
                await this.capture(d, history);
            }
        } catch (error) {
            // Even if the main state disk is unavailable, attempt a separate,
            // low-disclosure recovery marker. Startup always rescans the allowlist.
            await this.recordDegradation(error);
            throw error;
        }
    }
    capture(d, history) {
        this.assertTopic(d);
        return this.transaction(next => {
            const actual = new Map();
            for (const raw of history) {
                const msg = canonicalMessage(raw, d.topicId);
                const id = identity({ ...wireTopic(d), msgId: msg.id });
                const key = messageKey(id);
                if (actual.has(key)) throw fail('DUPLICATE_MSG_ID');
                actual.set(key, { id, message: msg, hash: messageHash(msg) });
            }
            const belongs = key => { const [type, owner, topic] = JSON.parse(key); return type === d.itemType && owner === d.itemId && topic === d.topicId; };
            const latestOutbox = new Map();
            for (const op of next.outbox) latestOutbox.set(messageKey(op), op);
            const keys = new Set([...actual.keys(), ...Object.keys(next.acked).filter(belongs), ...[...latestOutbox.keys()].filter(belongs)]);
            for (const key of keys) {
                const present = actual.get(key);
                const pending = latestOutbox.get(key);
                const base = pending ? { hash: pending.action === 'delete' ? tombstoneHash(pending) : messageHash(pending.message), deleted: pending.action === 'delete' } : next.acked[key];
                if (present && base && !base.deleted && base.hash === present.hash) continue;
                if (!present && (!base || base.deleted)) continue;
                const [ownerType, ownerId, topicId, msgId] = JSON.parse(key);
                const op = { ownerType, ownerId, topicId, msgId, deviceId: this.deviceId, opId: randomUUID(), action: present ? 'upsert' : 'delete', baseHash: base?.hash ?? null, message: present?.message ?? null };
                next.outbox.push(op); latestOutbox.set(key, op);
            }
        });
    }
    async recover() {
        if (this.state.pending) await this.applyRemote(this.state.pending.event, true);
        for (const d of this.topics) {
            await this.queue.run(d, async () => this.capture(d, await this.queue.read(d)));
            this.notificationPending.set(JSON.stringify(wireTopic(d)), { agentId: d.itemId, ownerId: d.itemId, ownerType: d.itemType, topicId: d.topicId, source: 'native-sync', recovered: true });
        }
        this.degraded = null;
        await fs.rm(`${this.statePath}.degraded`, { force: true });
        this.retryNotifications();
    }
    retryNotifications() {
        for (const [key, event] of this.notificationPending) {
            try { if (this.notify(event) !== false) this.notificationPending.delete(key); }
            catch { /* dirty until the next retry or allowlisted startup refresh */ }
        }
    }
    async request(route, options = {}) {
        if (this.requestOverride) return this.requestOverride(route, options);
        let response;
        try {
            response = await fetch(this.url + route, { method: options.body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: options.body ? JSON.stringify(options.body) : undefined, redirect: 'error', signal: AbortSignal.timeout(2000) });
        } catch { throw fail('NETWORK_UNAVAILABLE'); }
        const result = await response.json();
        if (!response.ok) throw fail(result.error?.code || 'SYNC_HTTP_ERROR');
        return result;
    }
    async flush() {
        if (this.busy) throw fail('BUSY');
        this.busy = true;
        try {
            if (this.degraded || this.state.pending) await this.recover();
            while (this.state.outbox.length) {
                const op = structuredClone(this.state.outbox[0]);
                const result = await this.request('/api/v1/sync/push', { body: op });
                if (result.hash !== (op.action === 'delete' ? tombstoneHash(op) : messageHash(op.message)) || !Number.isSafeInteger(result.seq) || result.seq < 1 || result.deleted !== (op.action === 'delete')) throw fail('CORRUPT_ACK');
                await this.transaction(next => {
                    if (next.outbox[0]?.opId !== op.opId) throw fail('OUTBOX_CHANGED');
                    next.acked[messageKey(op)] = { hash: result.hash, deleted: result.deleted, seq: result.seq };
                    next.outbox.shift();
                });
            }
        } finally { this.busy = false; }
    }
    async applyRemote(event, recovering = false) {
        const id = identity(event), d = descriptor(id);
        this.assertTopic(d);
        if (!Number.isSafeInteger(event.seq) || event.seq < 1 || !['upsert', 'delete'].includes(event.action)) throw fail('CORRUPT_EVENT');
        if (event.hash !== (event.action === 'delete' ? tombstoneHash(id) : messageHash(event.message)) || (event.action === 'upsert' && event.message.id !== id.msgId)) throw fail('CORRUPT_EVENT');
        const result = await this.queue.mutate({ ...d, syncSource: 'remote', syncEvent: event }, async history => {
            const beforeRevision = this.queue.revision(history);
            const key = messageKey(id), prior = this.state.acked[key];
            if (prior?.seq >= event.seq) return history;
            if (this.state.outbox.some(op => messageKey(op) === key)) throw fail('UNSYNCED_LOCAL_CONFLICT');
            const index = history.findIndex(m => m.id === id.msgId);
            const actual = index < 0 ? null : messageHash(history[index]);
            const expected = prior && !prior.deleted ? prior.hash : null;
            const alreadyApplied = event.action === 'delete' ? actual === null : actual === event.hash;
            if (actual !== expected && !alreadyApplied) throw fail('LOCAL_CONTENT_CONFLICT');
            if (recovering && this.state.pending && this.queue.revision(history) !== this.state.pending.beforeRevision && this.queue.revision(history) !== this.state.pending.afterRevision) throw fail('RECOVERY_HISTORY_CONFLICT');
            if (event.action === 'delete') { if (index >= 0) history.splice(index, 1); }
            else if (index >= 0) history[index] = { ...history[index], ...canonicalMessage(event.message, d.topicId) };
            else history.push(canonicalMessage(event.message, d.topicId));
            const afterRevision = this.queue.revision(history);
            await this.transaction(next => {
                if (next.pending && next.pending.event.seq !== event.seq) throw fail('SYNC_RECOVERY_REQUIRED');
                next.pending = { event, afterRevision, beforeRevision: next.pending?.beforeRevision ?? beforeRevision };
            });
            return history;
        });
        if (result.sync?.state !== 'captured') throw fail('SYNC_STATE_NOT_DURABLE');
        return result;
    }
    async pull({ limit = 100 } = {}) {
        if (this.busy) throw fail('BUSY');
        this.busy = true;
        try {
            if (this.degraded || this.state.pending) await this.recover();
            for (let page = 0; page < 10000; page++) {
                const result = await this.request(`/api/v1/sync/pull?after_seq=${this.state.cursor}&limit=${limit}`);
                validatePullPage(result, this.state.cursor, limit);
                for (const event of result.events) {
                    if (event.seq <= this.state.cursor) throw fail('CURSOR_REWIND');
                    await this.applyRemote(event);
                }
                if (this.state.cursor < result.nextSeq) await this.transaction(next => {
                    if (next.pending) throw fail('SYNC_STATE_NOT_DURABLE');
                    if (next.cursor > result.nextSeq) throw fail('CURSOR_REWIND');
                    next.cursor = result.nextSeq;
                });
                if (!result.hasMore) { this.retryNotifications(); return; }
            }
            throw fail('PAGINATION_STALLED');
        } finally { this.busy = false; }
    }
    async synchronize() { await this.flush(); await this.pull(); }
    diagnostics() { return { degraded: this.degraded, cursor: this.state.cursor, pending: Boolean(this.state.pending), outboxSize: this.state.outbox.length }; }
    async close() { await this.tail.catch(() => {}); this.queue.configureSync(); }
}
module.exports = { NativeSyncAdapter, validatePullPage };
