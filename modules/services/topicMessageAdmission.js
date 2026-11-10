'use strict';

const { randomUUID } = require('crypto');
const { conversationKey } = require('./historyMutationQueue');

const copy = value => structuredClone(value);

/**
 * Admission controls WHEN an external message enters history.
 * commit must append/upsert by message.id against latest history, never replace
 * a renderer snapshot. advance must return after accepting the request, NOT
 * after generation; the generation owner releases its lease after durable save.
 * store.save is an atomic durable replacement; store.load returns an array.
 */
class TopicMessageAdmission {
    constructor({ commit, advance, validate, store, publish = () => {}, logger = console,
        maxAutoRounds = 8, verifyTerminal = null } = {}) {
        if (typeof commit !== 'function' || typeof validate !== 'function'
            || !store?.load || !store?.save) {
            throw new TypeError('Admission requires commit, validate and durable store');
        }
        this.commit = commit;
        this.advance = advance;
        this.verifyTerminal = verifyTerminal;
        this.validate = validate;
        this.store = store;
        this.publish = publish;
        this.logger = logger;
        this.maxAutoRounds = Math.max(1, Number(maxAutoRounds) || 8);
        this.entries = [];
        this.standaloneLeases = [];
        this.leases = new Map();
        this.waiters = new Set();
        this.rounds = new Map();
        this.relayAttempts = new Map();
        this.tail = Promise.resolve();
        this.ready = false;
        this.closed = false;
    }

    run(operation) {
        if (this.closed) return Promise.reject(new Error('Admission disposed'));
        const task = this.tail.catch(() => {}).then(operation);
        this.tail = task;
        return task;
    }

    async initialize() {
        return this.run(async () => {
            if (this.ready) return;
            const state = typeof this.store.loadState === 'function'
                ? await this.store.loadState()
                : { entries: await this.store.load(), standaloneLeases: [] };
            const saved = state?.entries;
            if (!Array.isArray(saved) || !Array.isArray(state.standaloneLeases)) {
                throw new TypeError('Invalid admission store');
            }
            const leaseKeys = new Set();
            for (const lease of state.standaloneLeases) {
                const key = conversationKey(lease?.scope || {});
                if (typeof lease.token !== 'string' || !lease.token || leaseKeys.has(key)) {
                    throw new TypeError('Invalid or duplicate standalone lease');
                }
                leaseKeys.add(key);
            }
            const seen = new Set();
            this.entries = saved.map(entry => {
                conversationKey(entry.scope);
                if (!entry.entryId || !entry.message?.id || seen.has(entry.entryId)) {
                    throw new TypeError('Invalid admission entry');
                }
                seen.add(entry.entryId);
                // Crash during append is safe only because commit is idempotent.
                // A crash after dispatch may leave a saved terminal or executed tools.
                // Neither a lost in-memory lease nor missing ACK proves safe regeneration.
                const unconfirmed = ['advancing', 'uncertain'].includes(entry.state);
                return {
                    ...copy(entry),
                    state: unconfirmed ? 'uncertain' : 'recovered',
                    error: unconfirmed
                        ? entry.error || '上次推进期间进程退出，终稿与工具执行结果待核实'
                        : null,
                };
            });
            // Residual ownership is evidence of an interrupted run, not execution permission.
            // Move it into journal-only diagnostics before any subsequent state publication.
            for (const lease of state.standaloneLeases) {
                const key = conversationKey(lease.scope);
                if (this.entries.some(entry => conversationKey(entry.scope) === key
                    && entry.leaseToken === lease.token && entry.state === 'uncertain')) continue;
                this.entries.push({
                    entryId: randomUUID(), kind: 'lease-diagnostic', scope: copy(lease.scope),
                    message: { id: randomUUID(), role: 'assistant', name: '生成状态',
                        content: '上次独立生成期间进程退出，终稿状态待核实' },
                    triggerPolicy: 'none', enqueuedAt: lease.acquiredAt || Date.now(),
                    state: 'uncertain', error: '独立租约未确认收尾，禁止直接重新生成',
                    leaseToken: lease.token, committed: true, commitStarted: true,
                });
            }
            if (state.standaloneLeases.length) {
                await this.store.save(copy(this.entries), []);
            }
            this.ready = true;
            this.notify();
        });
    }

    assertReady() {
        if (!this.ready) throw new Error('Admission not initialized');
    }

    notify() {
        for (const wake of [...this.waiters]) wake();
        try { this.publish(this.snapshot()); }
        catch (error) { this.logger.warn?.('[Admission] publish failed', error); }
    }

    snapshot(scope) {
        const key = scope ? conversationKey(scope) : null;
        return copy(this.entries.filter(entry => !key || conversationKey(entry.scope) === key));
    }

    async save(next, standaloneLeases = this.standaloneLeases) {
        await this.store.save(copy(next), copy(standaloneLeases));
        this.entries = next;
        this.standaloneLeases = standaloneLeases;
        this.notify();
    }

    async acquireNow(scope, token) {
        this.assertReady();
        if (typeof token !== 'string' || !token) throw new TypeError('Lease token required');
        const key = conversationKey(scope);
        const existing = this.leases.get(key);
        if (existing && existing !== token) return { success: false, code: 'TOPIC_BUSY' };
        if (!existing && this.entries.some(entry => conversationKey(entry.scope) === key)) {
            return { success: false, code: 'MESSAGES_PENDING' };
        }
        if (!existing) {
            const lease = { scope: copy(scope), token, acquiredAt: Date.now() };
            try {
                await this.save(this.entries, [...this.standaloneLeases, lease]);
            } catch (error) {
                // A rejected write may still have reached disk. Never grant execution
                // or allow a later save to silently erase the uncertain acquisition.
                this.standaloneLeases = [...this.standaloneLeases, lease];
                this.entries = [...this.entries, {
                    entryId: randomUUID(), kind: 'lease-diagnostic', scope: copy(scope),
                    message: { id: randomUUID(), role: 'assistant', name: '生成状态',
                        content: '租约获取日志保存待核实，未允许生成' },
                    triggerPolicy: 'none', state: 'uncertain', error: error.message || String(error),
                    leaseToken: token, committed: true, commitStarted: true,
                }];
                this.notify();
                throw error;
            }
        }
        this.leases.set(key, token);
        return { success: true, token };
    }

    acquire(scope, token) {
        return this.run(() => this.acquireNow(scope, token));
    }

    async acquireWhenIdle(scope, token, { signal, timeoutMs = 120000, handoffOwner = null } = {}) {
        if (handoffOwner !== null && (typeof handoffOwner !== 'string' || !handoffOwner)) {
            throw new TypeError('Handoff owner must be a nonempty string');
        }
        const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 120000);
        for (;;) {
            // Register the wakeup in the same serial turn as the failed acquire.
            // Return a wrapper: never await the wakeup under the serial lock.
            const attempt = await this.run(async () => {
                if (signal?.aborted) throw Object.assign(new Error('Generation wait aborted'), { code: 'ABORT_ERR' });
                const remaining = deadline - Date.now();
                if (remaining <= 0) throw Object.assign(new Error('Generation wait timed out'), { code: 'ADMISSION_TIMEOUT' });
                const alreadyOwned = this.leases.get(conversationKey(scope)) === token;
                const result = await this.acquireNow(scope, token);
                if (result.success) {
                    if (signal?.aborted || Date.now() >= deadline) {
                        if (alreadyOwned) {
                            throw Object.assign(new Error(signal?.aborted
                                ? 'Generation wait aborted' : 'Generation wait timed out'),
                                { code: signal?.aborted ? 'ABORT_ERR' : 'ADMISSION_TIMEOUT' });
                        }
                        const key = conversationKey(scope);
                        // Still inside the serial turn: do not call release(), which
                        // would enqueue behind this operation and deadlock.
                        await this.save(this.entries.filter(entry =>
                            !(conversationKey(entry.scope) === key && entry.leaseToken === token)),
                            this.standaloneLeases.filter(lease =>
                                !(conversationKey(lease.scope) === key && lease.token === token)));
                        this.leases.delete(key);
                        this.notify();
                        this.schedule(scope);
                        throw Object.assign(new Error(signal?.aborted
                            ? 'Generation wait aborted' : 'Generation wait timed out'),
                            { code: signal?.aborted ? 'ABORT_ERR' : 'ADMISSION_TIMEOUT' });
                    }
                    return { result };
                }
                const key = conversationKey(scope);
                if (this.entries.some(entry => conversationKey(entry.scope) === key
                    && ['recovered', 'failed', 'uncertain'].includes(entry.state))) {
                    throw Object.assign(new Error('话题暂挂队列已暂停，请明确继续'), { code: 'ADMISSION_PAUSED' });
                }
                let wake;
                const wait = new Promise((resolve, reject) => {
                    let timer;
                    const cleanup = () => {
                        clearTimeout(timer);
                        this.waiters.delete(wake);
                        signal?.removeEventListener('abort', aborted);
                    };
                    const aborted = () => {
                        cleanup();
                        reject(Object.assign(new Error('Generation wait aborted'), { code: 'ABORT_ERR' }));
                    };
                    wake = error => {
                        cleanup();
                        if (error) reject(error);
                        else resolve();
                    };
                    wake.admissionWait = {
                        key, token, handoffOwner, signal, deadline,
                    };
                    this.waiters.add(wake);
                    signal?.addEventListener('abort', aborted, { once: true });
                    timer = setTimeout(() => wake(Object.assign(
                        new Error('Generation wait timed out'), { code: 'ADMISSION_TIMEOUT' })), remaining);
                });
                return { wait };
            });
            if (attempt.result) return attempt.result;
            await attempt.wait;
        }
    }

    findWaitingHandoff(scope, handoffOwner) {
        this.assertReady();
        const key = conversationKey(scope);
        if (typeof handoffOwner !== 'string' || !handoffOwner) {
            throw new TypeError('Handoff owner required');
        }
        for (const wake of this.waiters) {
            const wait = wake.admissionWait;
            if (wait?.key === key && wait.handoffOwner === handoffOwner
                && !wait.signal?.aborted && wait.deadline > Date.now()) {
                // A candidate is not a reservation. Transfer must revalidate it.
                return { token: wait.token };
            }
        }
        return null;
    }
    submit({ scope, message, requestId, triggerPolicy = 'none', invitePrompt = '' }) {
        return this.run(async () => {
            this.assertReady();
            conversationKey(scope);
            if (!message?.id || !['user', 'assistant'].includes(message.role)) {
                throw new TypeError('Message id and role required');
            }
            if (!['none', 'reply'].includes(triggerPolicy)) throw new TypeError('Invalid trigger policy');
            const existing = this.entries.find(entry =>
                conversationKey(entry.scope) === conversationKey(scope)
                && (entry.message.id === message.id || (requestId && entry.requestId === requestId)));
            if (existing) return { success: true, queued: true, entryId: existing.entryId };
            await this.validate(copy(scope));
            const activeSelfPost = scope.itemType === 'agent'
                && message.role === 'assistant' && message.agentId === scope.itemId
                && this.leases.has(conversationKey(scope));
            const entry = {
                entryId: randomUUID(), scope: copy(scope), message: copy(message),
                requestId: requestId || null,
                triggerPolicy: activeSelfPost ? 'none' : triggerPolicy, invitePrompt,
                enqueuedAt: Date.now(), state: 'queued', error: null,
                // Durable acceptance is not necessarily a user-visible wait.
                deferred: this.leases.has(conversationKey(scope))
                    || this.entries.some(item => conversationKey(item.scope) === conversationKey(scope)),
            };
            await this.save([...this.entries, entry]);
            this.schedule(scope);
            return { success: true, queued: true, entryId: entry.entryId };
        });
    }

    withdraw(scope, entryId) {
        return this.run(async () => {
            this.assertReady();
            const key = conversationKey(scope);
            const entry = this.entries.find(item =>
                item.entryId === entryId && conversationKey(item.scope) === key);
            if (!entry) return { success: false, code: 'NOT_PENDING' };
            if (entry.committed || entry.commitStarted) return { success: false, code: 'ALREADY_COMMITTED' };
            // Draining and withdrawal use the same serial authority.
            await this.save(this.entries.filter(item => item !== entry));
            this.schedule(scope);
            return { success: true };
        });
    }

    resume(scope) {
        return this.run(async () => {
            this.assertReady();
            const key = conversationKey(scope);
            if (this.leases.has(key)) return { success: false, code: 'TOPIC_BUSY' };
            if (this.entries.some(entry => conversationKey(entry.scope) === key && entry.state === 'uncertain')) {
                return { success: false, code: 'TERMINAL_UNCONFIRMED', error: '上一轮终稿保存状态待核实，不能直接重新生成' };
            }
            await this.validate(copy(scope));
            await this.save(this.entries.map(entry => conversationKey(entry.scope) === key
                ? { ...entry, state: 'queued', error: null } : entry));
            // Explicit human permission starts a fresh local automation budget.
            this.rounds.set(key, 0);
            this.schedule(scope);
            return { success: true };
        });
    }

    reconcile(scope, entryId) {
        return this.run(async () => {
            this.assertReady();
            const key = conversationKey(scope);
            if (this.leases.has(key)) return { success: false, code: 'TOPIC_BUSY' };
            const entry = this.entries.find(item => item.entryId === entryId
                && conversationKey(item.scope) === key);
            if (!entry || entry.state !== 'uncertain' || !entry.leaseToken) {
                return { success: false, code: 'NOT_UNCONFIRMED' };
            }
            if (typeof this.verifyTerminal !== 'function') {
                return { success: false, code: 'VERIFICATION_UNAVAILABLE' };
            }
            const evidence = await this.verifyTerminal(copy(scope), entry.leaseToken);
            if (!evidence?.verified || !evidence.messageId) {
                return { success: false, code: 'TERMINAL_UNCONFIRMED', error: '未找到匹配本轮租约的已保存终稿，保持暂停' };
            }
            await this.save(this.entries.filter(item =>
                !(conversationKey(item.scope) === key && item.leaseToken === entry.leaseToken))
                .map(item => conversationKey(item.scope) === key && item.state === 'queued'
                    ? { ...item, state: 'recovered' } : item),
                this.standaloneLeases.filter(lease =>
                    !(conversationKey(lease.scope) === key && lease.token === entry.leaseToken)));
            // Verification is not permission to generate. Remaining entries stay paused.
            return { success: true, reconciled: true, messageId: evidence.messageId };
        });
    }

    reportUncertain(scope, token, error) {
        return this.run(async () => {
            this.assertReady();
            const key = conversationKey(scope);
            if (this.leases.get(key) !== token) return { success: false, code: 'STALE_LEASE' };
            const detail = String(error?.message || error || '终稿保存状态未确认');
            let matched = false;
            const next = this.entries.map(entry => {
                if (conversationKey(entry.scope) !== key || entry.leaseToken !== token) return entry;
                matched = true;
                return { ...entry, state: 'uncertain', error: detail };
            });
            if (!matched) {
                // Journal-only diagnostic: never enqueue or append this as a chat message.
                next.push({
                    entryId: randomUUID(), kind: 'lease-diagnostic', scope: copy(scope),
                    message: { id: randomUUID(), role: 'assistant', name: '生成状态', content: '独立生成的终稿保存状态待核实' },
                    triggerPolicy: 'none', enqueuedAt: Date.now(),
                    state: 'uncertain', error: detail, leaseToken: token,
                    committed: true, commitStarted: true,
                });
            }
            await this.save(next);
            // Diagnostics are not proof that execution stopped or saving failed.
            // Keep ownership; explicit resume remains blocked while this lease exists.
            return { success: true, retained: true };
        });
    }
    fail(scope, token, error) {
        return this.run(async () => {
            const key = conversationKey(scope);
            if (this.leases.get(key) !== token) return { success: false, code: 'STALE_LEASE' };
            await this.save(this.entries.map(entry =>
                conversationKey(entry.scope) === key && entry.leaseToken === token
                    ? { ...entry, state: 'failed', error: String(error || '推进失败') } : entry),
                this.standaloneLeases.filter(lease =>
                    !(conversationKey(lease.scope) === key && lease.token === token)));
            this.leases.delete(key);
            this.notify();
            return { success: true };
        });
    }
    transferToWaiting(scope, token, handoffOwner) {
        return this.run(async () => {
            this.assertReady();
            const key = conversationKey(scope);
            if (this.leases.get(key) !== token) return { success: false, code: 'STALE_LEASE' };
            const candidate = this.findWaitingHandoff(scope, handoffOwner);
            if (!candidate) return { success: false, code: 'NO_WAITING_SPEAKER' };
            const previous = this.entries;
            const previousLeases = this.standaloneLeases;
            const nextLeases = previousLeases.map(lease =>
                conversationKey(lease.scope) === key && lease.token === token
                    ? { ...lease, token: candidate.token } : lease);
            const next = previous.map(entry =>
                conversationKey(entry.scope) === key && entry.leaseToken === token
                    ? { ...entry, leaseToken: candidate.token } : entry);
            // Do not publish/wake during the tentative journal write.
            await this.store.save(copy(next), copy(nextLeases));
            const current = this.findWaitingHandoff(scope, handoffOwner);
            if (!current || current.token !== candidate.token) {
                // Recovery is paused on restart even if this restoration itself fails.
                await this.store.save(copy(previous), copy(previousLeases));
                return { success: false, code: 'HANDOFF_CANCELLED' };
            }
            this.entries = next;
            this.standaloneLeases = nextLeases;
            this.leases.set(key, candidate.token);
            this.notify();
            return { success: true, token: candidate.token };
        });
    }
    transfer(scope, token, nextToken) {
        return this.run(async () => {
            this.assertReady();
            if (typeof nextToken !== 'string' || !nextToken) throw new TypeError('Lease token required');
            const key = conversationKey(scope);
            if (this.leases.get(key) !== token) return { success: false, code: 'STALE_LEASE' };
            if (token === nextToken) return { success: true, token };
            // Persist ownership before waking the receiver; failure keeps the old lease.
            await this.save(this.entries.map(entry =>
                conversationKey(entry.scope) === key && entry.leaseToken === token
                    ? { ...entry, leaseToken: nextToken } : entry),
                this.standaloneLeases.map(lease =>
                    conversationKey(lease.scope) === key && lease.token === token
                        ? { ...lease, token: nextToken } : lease));
            this.leases.set(key, nextToken);
            this.notify();
            return { success: true, token: nextToken };
        });
    }
    cancelRelay(scope, token) {
        this.assertReady();
        const attempt = this.relayAttempts.get(conversationKey(scope));
        if (!attempt || attempt.token !== token) return { success: false, code: 'STALE_RELAY' };
        if (attempt.dispatched) return { success: false, code: 'RELAY_ALREADY_DISPATCHED' };
        // Signal only: journal/lease mutation remains under run(). Never queue
        // this signal behind the very disk write it must be able to cancel.
        attempt.cancelled = true;
        return { success: true, accepted: true };
    }

    async pauseCancelledRelay(scope) {
        const key = conversationKey(scope);
        const paused = this.entries.map(entry => conversationKey(entry.scope) === key
            ? { ...entry, state: 'recovered', error: '用户取消中继，等待明确继续' } : entry);
        try { await this.save(paused); }
        catch (error) {
            // A rejected write may have reached disk. Never let a later submit
            // turn the still-queued in-memory snapshot into automatic execution.
            this.entries = paused;
            this.notify();
            throw error;
        }
        this.leases.delete(key);
        this.notify();
    }

    relay(scope, token, { saved = false, cancelled = false, continuePrompt = '[系统提示:] 请结合最新上下文继续刚才的任务。' } = {}) {
        const key = conversationKey(scope);
        if (this.relayAttempts.has(key)) return Promise.resolve({ success: false, code: 'RELAY_BUSY' });
        const attempt = { token, cancelled: Boolean(cancelled), dispatched: false };
        this.relayAttempts.set(key, attempt);
        return this.run(async () => {
            this.assertReady();
            if (scope.itemType !== 'agent') return { success: false, code: 'SINGLE_CHAT_ONLY' };
            const key = conversationKey(scope);
            if (this.leases.get(key) !== token) return { success: false, code: 'STALE_LEASE' };
            if (!saved) return { success: false, code: 'UNSAVED_TERMINAL' };
            let reachedHumanBoundary = false;
            const remaining = this.entries.filter(entry =>
                !(conversationKey(entry.scope) === key && entry.leaseToken === token))
                .map(entry => {
                    if (conversationKey(entry.scope) !== key || reachedHumanBoundary) return entry;
                    if (entry.message.role === 'user') reachedHumanBoundary = true;
                    return { ...entry, relayFrom: token };
                });
            if (remaining.some(entry => conversationKey(entry.scope) === key
                && entry.state !== 'queued')) {
                return { success: false, code: 'ADMISSION_PAUSED' };
            }
            await this.validate(copy(scope));
            const pending = remaining.filter(entry => conversationKey(entry.scope) === key);
            const budgetBlocked = !pending.some(entry => entry.message.role === 'user')
                && pending.some(entry => entry.triggerPolicy === 'reply' && entry.kind !== 'relay-continuation')
                && (this.rounds.get(key) || 0) >= this.maxAutoRounds;
            if (attempt.cancelled || budgetBlocked) {
                const reason = attempt.cancelled ? '用户取消中继，等待明确继续' : '自动推进预算已耗尽，等待人类确认继续';
                await this.save(remaining.map(entry => conversationKey(entry.scope) === key
                    ? { ...entry, state: 'recovered', error: reason } : entry),
                    this.standaloneLeases.filter(lease =>
                        !(conversationKey(lease.scope) === key && lease.token === token)));
                this.leases.delete(key);
                this.notify();
                return { success: true, cancelled: attempt.cancelled, paused: true,
                    code: budgetBlocked && !attempt.cancelled ? 'AUTO_BUDGET_EXHAUSTED' : 'RELAY_CANCELLED' };
            }
            // Existing human/reply requests already own the next round. A silent
            // letter (or withdrawal during Stop) must not lose the interrupted task.
            if (!pending.some(entry => entry.message.role === 'user' || entry.triggerPolicy === 'reply')) {
                remaining.push({
                    entryId: randomUUID(), kind: 'relay-continuation', scope: copy(scope),
                    relayFrom: token,
                    message: { id: randomUUID(), role: 'assistant', name: '任务接续',
                        content: '工具返回中继后的原任务接续' },
                    triggerPolicy: 'reply', invitePrompt: String(continuePrompt),
                    enqueuedAt: Date.now(), state: 'queued', error: null,
                    committed: true, commitStarted: true,
                });
            }
            // Persist the old ownership removal and continuation together. A crash
            // before dispatch recovers paused; a crash after dispatch is uncertain.
            await this.save(remaining, this.standaloneLeases.filter(lease =>
                !(conversationKey(lease.scope) === key && lease.token === token)));
            this.leases.delete(key);
            // Keep drain in this serial turn so a separate acquire cannot steal
            // the handover; advance itself remains outside the lock.
            await this.drain(copy(scope), { relayFrom: token, relayAttempt: attempt });
            this.notify();
            return attempt.cancelled && !attempt.dispatched
                ? { success: true, cancelled: true, paused: true, code: 'RELAY_CANCELLED' }
                : { success: true, relayed: true };
        }).finally(() => {
            if (this.relayAttempts.get(key) === attempt) this.relayAttempts.delete(key);
        });
    }

    release(scope, token, { saved = true } = {}) {
            return this.run(async () => {
                const key = conversationKey(scope);
                if (this.leases.get(key) !== token) return { success: false, code: 'STALE_LEASE' };
                if (!saved) return { success: false, code: 'UNSAVED_TERMINAL' };
                await this.save(this.entries.filter(entry =>
                    !(conversationKey(entry.scope) === key && entry.leaseToken === token)),
                    this.standaloneLeases.filter(lease =>
                        !(conversationKey(lease.scope) === key && lease.token === token)));
                this.leases.delete(key);
                this.notify();
                this.schedule(scope);
                return { success: true };
            });
        }

        schedule(scope) {
        // Deliberately do not await this from submit/release.
        this.run(() => this.drain(copy(scope))).catch(error =>
            this.logger.error?.('[Admission] drain failed', error));
    }

    async drain(scope, { relayFrom = null, relayAttempt = null } = {}) {
            const key = conversationKey(scope);
            const stopIfCancelled = async () => {
                if (!relayAttempt?.cancelled) return false;
                await this.pauseCancelledRelay(scope);
                return true;
            };
            if (this.leases.has(key)) return;
            if (await stopIfCancelled()) return;
            // A standalone diagnostic may follow queued messages. It blocks the
            // whole conversation, not merely traversal past its own FIFO position.
            if (this.entries.some(entry => conversationKey(entry.scope) === key && entry.state === 'uncertain')) return;
            const batch = [];
            let requested = null;
            for (const candidate of this.entries.filter(item => conversationKey(item.scope) === key)) {
                if (candidate.state !== 'queued') break;
                let entry = candidate;
                try {
                    await this.validate(copy(scope));
                    if (await stopIfCancelled()) return;
                    if (!entry.committed) {
                        entry = { ...entry, commitStarted: true };
                        await this.save(this.entries.map(item => item.entryId === candidate.entryId ? entry : item));
                        if (await stopIfCancelled()) return;
                        await this.commit(copy(scope), copy(entry.message));
                        entry = { ...entry, committed: true };
                        await this.save(this.entries.map(item => item.entryId === candidate.entryId ? entry : item));
                    }
                    if (await stopIfCancelled()) return;
                    batch.push(entry);
                } catch (error) {
                    const failed = this.entries.map(item => item.entryId === candidate.entryId
                        ? { ...item, state: 'failed', error: error.message || String(error) } : item);
                    try { await this.save(failed); }
                    catch (storeError) { this.logger.error?.('[Admission] cannot persist failure', storeError); }
                    return;
                }
                if (entry.message.role === 'user') {
                    this.rounds.set(key, 0);
                    requested = entry;
                    break;
                }
                if (entry.triggerPolicy === 'reply') requested = entry;
            }
            if (!batch.length) return;
            const automatic = requested?.message.role !== 'user';
            const continuation = requested?.kind === 'relay-continuation';
            const count = this.rounds.get(key) || 0;
            if (!requested || typeof this.advance !== 'function'
                || (automatic && !continuation && count >= this.maxAutoRounds)) {
                const ids = new Set(batch.map(entry => entry.entryId));
                await this.save(this.entries.filter(entry => !ids.has(entry.entryId)));
                return;
            }
            const persistedRelayTokens = new Set(batch.map(entry => entry.relayFrom).filter(Boolean));
            if (persistedRelayTokens.size > 1
                || (relayFrom && persistedRelayTokens.size && !persistedRelayTokens.has(relayFrom))) {
                const ids = new Set(batch.map(entry => entry.entryId));
                await this.save(this.entries.map(entry => ids.has(entry.entryId)
                    ? { ...entry, state: 'failed', error: '中继批次存在冲突的交接归属，保持暂停' }
                    : entry));
                return;
            }
            const handoverFrom = relayFrom || [...persistedRelayTokens][0] || null;
            const token = randomUUID();
            const ids = new Set(batch.map(entry => entry.entryId));
            await this.save(this.entries.map(entry => ids.has(entry.entryId)
                ? { ...entry, state: 'advancing', leaseToken: token } : entry));
            if (relayAttempt?.cancelled) {
                await this.pauseCancelledRelay(scope);
                return;
            }
            // No await between this final decision and dispatch reservation.
            // A later cancellation must not pretend already-dispatched work stopped.
            if (relayAttempt) relayAttempt.dispatched = true;
            if (automatic && !continuation) this.rounds.set(key, count + 1);
            this.leases.set(key, token);
            // No generation/tool loop is executed under the admission lock.
            queueMicrotask(() => {
                Promise.resolve().then(() => this.advance({
                    scope: copy(scope), token, automatic,
                    messageId: requested.message.id, invitePrompt: requested.invitePrompt,
                    continuation: requested.kind === 'relay-continuation',
                    relayFrom: handoverFrom,
                })).catch(error => {
                    this.run(async () => {
                        if (this.leases.get(key) !== token) return;
                        await this.save(this.entries.map(entry => entry.leaseToken === token
                            ? { ...entry, state: 'failed', error: error.message || String(error) } : entry));
                        // Explicit resume is allowed after rejection, but never auto-retry.
                        if (this.leases.get(key) === token) this.leases.delete(key);
                        this.notify();
                    }).catch(storeError => this.logger.error?.('[Admission] advance failure journal', storeError));
                });
            });
        }

        async dispose() {
        this.closed = true;
        for (const wake of [...this.waiters]) wake(new Error('Admission disposed'));
        await this.tail.catch(() => {});
    }
}

module.exports = { TopicMessageAdmission };