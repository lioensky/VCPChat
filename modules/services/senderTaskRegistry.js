'use strict';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9:._-]{1,128}$/;
const OPERATION_PATTERN = /^[a-z0-9:._-]{1,64}$/;

class SenderTaskRegistry {
    constructor(options = {}) {
        this.label = String(options.label || 'ipc-tasks');
        this.owners = new Map();
        this.disposed = false;
    }

    _owner(sender) {
        if (!sender || !Number.isFinite(sender.id)) throw new TypeError(`${this.label} requires an IPC sender.`);
        let owner = this.owners.get(sender.id);
        if (owner) {
            if (owner.sender !== sender) throw new Error(`${this.label} sender identity changed.`);
            return owner;
        }
        const onDestroyed = () => this.cancelSender(sender, 'sender-destroyed', { releaseOwner: true });
        const onDidStartLoading = () => this.cancelSender(
            sender,
            'sender-navigation',
            { predicate: entry => entry.cancelOnNavigation === true }
        );
        const onRenderProcessGone = () => this.cancelSender(
            sender,
            'sender-render-process-gone',
            { predicate: entry => entry.cancelOnNavigation === true }
        );
        owner = { sender, tasks: new Map(), onDestroyed, onDidStartLoading, onRenderProcessGone, navigationBound: false };
        this.owners.set(sender.id, owner);
        sender.once?.('destroyed', onDestroyed);
        return owner;
    }

    begin(sender, requestIdValue, operationValue, options = {}) {
        if (this.disposed) throw new Error(`${this.label} is disposed.`);
        const requestId = String(requestIdValue || '');
        const operation = String(operationValue || '');
        if (!REQUEST_ID_PATTERN.test(requestId)) throw new TypeError('Invalid IPC task requestId.');
        if (!OPERATION_PATTERN.test(operation)) throw new TypeError('Invalid IPC task operation.');
        const owner = this._owner(sender);
        if (owner.tasks.has(requestId)) throw new Error(`Duplicate IPC task requestId: ${requestId}`);
        const controller = new AbortController();
        const entry = {
            requestId,
            operation,
            controller,
            startedAt: Date.now(),
            state: 'running',
            cancelOnNavigation: options.cancelOnNavigation === true,
        };
        owner.tasks.set(requestId, entry);
        if (entry.cancelOnNavigation && !owner.navigationBound) {
            sender.on?.('did-start-loading', owner.onDidStartLoading);
            sender.on?.('render-process-gone', owner.onRenderProcessGone);
            owner.navigationBound = true;
        }
        return entry;
    }

    finish(sender, requestIdValue) {
        const owner = this.owners.get(sender?.id);
        if (!owner || owner.sender !== sender) return false;
        const requestId = String(requestIdValue || '');
        const entry = owner.tasks.get(requestId);
        if (!entry) return false;
        entry.state = entry.controller.signal.aborted ? 'cancelled' : 'settled';
        owner.tasks.delete(requestId);
        if (!owner.tasks.size) {
            sender.removeListener?.('destroyed', owner.onDestroyed);
            if (owner.navigationBound) {
                sender.removeListener?.('did-start-loading', owner.onDidStartLoading);
                sender.removeListener?.('render-process-gone', owner.onRenderProcessGone);
            }
            this.owners.delete(sender.id);
        }
        return true;
    }

    async run(sender, requestId, operation, execute, options = {}) {
        if (typeof execute !== 'function') throw new TypeError('IPC task execute must be a function.');
        const entry = this.begin(sender, requestId, operation, options);
        try {
            return await execute(entry.controller.signal, entry);
        } finally {
            this.finish(sender, requestId);
        }
    }

    cancel(sender, requestIdValue, reason = 'cancelled') {
        const owner = this.owners.get(sender?.id);
        if (!owner || owner.sender !== sender) return false;
        const entry = owner.tasks.get(String(requestIdValue || ''));
        if (!entry) return false;
        if (!entry.controller.signal.aborted) entry.controller.abort(reason);
        entry.state = 'cancelling';
        return true;
    }

    cancelSender(sender, reason = 'sender-disposed', options = {}) {
        const owner = this.owners.get(sender?.id);
        if (!owner || owner.sender !== sender) return 0;
        let count = 0;
        owner.tasks.forEach(entry => {
            if (options.predicate && !options.predicate(entry)) return;
            if (!entry.controller.signal.aborted) {
                entry.controller.abort(reason);
                count += 1;
            }
            entry.state = 'cancelling';
        });
        if (options.releaseOwner === true) {
            sender.removeListener?.('destroyed', owner.onDestroyed);
            if (owner.navigationBound) {
                sender.removeListener?.('did-start-loading', owner.onDidStartLoading);
                sender.removeListener?.('render-process-gone', owner.onRenderProcessGone);
            }
            this.owners.delete(sender.id);
        }
        return count;
    }

    snapshot() {
        return [...this.owners.values()].flatMap(owner => [...owner.tasks.values()].map(entry => ({
            senderId: owner.sender.id,
            requestId: entry.requestId,
            operation: entry.operation,
            state: entry.state,
            cancelOnNavigation: entry.cancelOnNavigation,
            ageMs: Math.max(0, Date.now() - entry.startedAt),
        })));
    }

    dispose(reason = 'registry-disposed') {
        if (this.disposed) return;
        this.disposed = true;
        this.owners.forEach(owner => {
            this.cancelSender(owner.sender, reason);
            owner.sender.removeListener?.('destroyed', owner.onDestroyed);
            if (owner.navigationBound) {
                owner.sender.removeListener?.('did-start-loading', owner.onDidStartLoading);
                owner.sender.removeListener?.('render-process-gone', owner.onRenderProcessGone);
            }
        });
        this.owners.clear();
    }
}

module.exports = { SenderTaskRegistry, REQUEST_ID_PATTERN };
