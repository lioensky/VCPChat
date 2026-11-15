'use strict';
// Authority client: unlike IndexerClient, never silently returns null or retries a mutation.
// Not connected to ProjectForgeService until all legacy store callers are migrated.
const path = require('path');
const { spawn } = require('child_process');
const { resolveDefaultBinaryPath } = require('./indexerClient');

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_PENDING = 32;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;
const MUTATIONS = new Set([
    'store.createProject', 'store.recordBatch', 'store.updateProject', 'store.addTodos',
    'store.updateTodo', 'store.removeTodo', 'store.softDeleteProjects',
    'store.restoreProjects', 'store.purgeProjects', 'edit.execute', 'edit.resolve', 'file.execute',
]);

class ServiceError extends Error {
    constructor(message, code, operationId = null) {
        super(message);
        this.name = 'ProjectServiceError';
        this.code = code;
        this.operationId = operationId;
    }
}

class ProjectServiceClient {
    constructor({ dbPath, configPath = null, binaryPath = resolveDefaultBinaryPath(), timeoutMs = 15_000, startupMs = 10_000, spawnProcess = spawn } = {}) {
        if (!dbPath || !path.isAbsolute(dbPath)) throw new ServiceError('Absolute dbPath required', 'INVALID_PATH');
        for (const value of [timeoutMs, startupMs]) {
            if (!Number.isSafeInteger(value) || value < 1) throw new ServiceError('Positive integer timeout required', 'INVALID_TIMEOUT');
        }
        this.spawnProcess = spawnProcess;
        if (configPath !== null && (typeof configPath !== 'string' || !path.isAbsolute(configPath))) {
            throw new ServiceError('Absolute configPath required', 'INVALID_PATH');
        }
        this.configPath = configPath;
        this.dbPath = dbPath;
        this.binaryPath = binaryPath;
        this.timeoutMs = timeoutMs;
        this.startupMs = startupMs;
        this.child = null;
        this.startPromise = null;
        this.pending = new Map();
        this.admitted = 0;
        this.admittedBytes = 0;
        this.nextId = 1;
        this.blocked = false;
        this.closed = false;
        this.ready = false;
        this.capabilities = [];
    }

    start() {
        if (this.closed) return Promise.reject(new ServiceError('Client closed', 'CLOSED'));
        if (this.ready) return Promise.resolve();
        if (this.startPromise) return this.startPromise;
        this.startPromise = new Promise((resolve, reject) => {
            const args = ['--storage-service', '--db', this.dbPath];
            if (this.configPath !== null) args.push('--config', this.configPath);
            const child = this.spawnProcess(this.binaryPath, args, {
                windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
            });
            this.child = child;
            let settled = false;
            let chunks = [];
            let bytes = 0;
            let stderr = '';
            const timer = setTimeout(() => fail(new ServiceError('Storage startup timeout', 'STARTUP_TIMEOUT')), this.startupMs);
            const fail = error => {
                if (!settled) { settled = true; clearTimeout(timer); reject(error); }
                this.ready = false;
                this.closed = true; // fail closed; reconnection must be an explicit new client
                for (const waiter of this.pending.values()) {
                    clearTimeout(waiter.timer);
                    waiter.reject(this._lost(waiter, error.message));
                }
                this.pending.clear();
                chunks = [];
                bytes = 0;
                child.kill();
            };
            const onFrame = frame => {
                let message;
                try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); }
                catch { fail(new ServiceError('Invalid service JSON/UTF-8', 'INVALID_FRAME')); return; }
                if (!message || typeof message !== 'object' || Array.isArray(message)) {
                    fail(new ServiceError('Invalid service envelope', 'INVALID_FRAME'));
                    return;
                }
                if (!settled) {
                    if (message.type !== 'ready' || message.service !== 'projectforge-storage' ||
                        message.protocolVersion !== 1 || message.maxFrameBytes !== MAX_FRAME_BYTES ||
                        !message.capabilities?.includes('operationStatus')) {
                        fail(new ServiceError('Storage protocol mismatch', 'PROTOCOL_MISMATCH'));
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    this.ready = true;
                    this.capabilities = Array.isArray(message.capabilities) ? [...message.capabilities] : [];
                    resolve();
                    return;
                }
                const waiter = this.pending.get(message.id);
                if (!waiter) return; // late timeout response; persistent operation status is authoritative
                this.pending.delete(message.id);
                clearTimeout(waiter.timer);
                if (message.ok === true) waiter.resolve(message.result);
                else waiter.reject(new ServiceError(message.error?.message || 'Storage failure',
                    message.error?.code || 'SERVICE_ERROR', waiter.operationId));
            };
            child.stdout.on('data', data => {
                if (this.closed) return;
                let offset = 0;
                while (offset < data.length) {
                    const end = data.indexOf(10, offset);
                    const stop = end < 0 ? data.length : end;
                    const slice = data.subarray(offset, stop);
                    if (bytes + slice.length > MAX_FRAME_BYTES) {
                        fail(new ServiceError('Storage frame too large', 'FRAME_TOO_LARGE'));
                        return;
                    }
                    chunks.push(slice);
                    bytes += slice.length;
                    if (end < 0) break;
                    const frame = Buffer.concat(chunks, bytes);
                    chunks = [];
                    bytes = 0;
                    if (frame.length) onFrame(frame);
                    if (this.closed) return;
                    offset = end + 1;
                }
            });
            child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4096); });
            child.stdin.on('drain', () => { this.blocked = false; });
            child.stdin.on('error', error => fail(new ServiceError(error.message, 'PIPE_ERROR')));
            child.once('error', error => fail(new ServiceError(error.message, 'SPAWN_ERROR')));
            child.once('exit', (code, signal) => {
                fail(new ServiceError(`Storage exited (${code}/${signal}): ${stderr}`, 'EXITED'));
                this.child = null;
            });
        });
        return this.startPromise;
    }

    _lost(waiter, reason) {
        return new ServiceError(reason, waiter.operationId ? 'OUTCOME_UNKNOWN' : 'CONNECTION_LOST', waiter.operationId);
    }

    async request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new ServiceError('Invalid timeout', 'INVALID_TIMEOUT');
        const mutation = MUTATIONS.has(method);
        const operationId = mutation ? params.operationId : null;
        if (mutation && (typeof operationId !== 'string' || !operationId || Buffer.byteLength(operationId) > 128)) {
            throw new ServiceError('Mutation requires a bounded operationId', 'INVALID_OPERATION_ID');
        }
        // Reserve before async startup, not only after the child is ready.
        if (this.blocked || this.admitted >= MAX_PENDING) throw new ServiceError('Storage RPC busy', 'BUSY');
        this.admitted++;
        let frameBytes = 0;
        try {
            if (!Number.isSafeInteger(this.nextId)) throw new ServiceError('RPC id exhausted', 'ID_EXHAUSTED');
            const id = this.nextId++;
            const frame = `${JSON.stringify({ id, method, params })}\n`;
            const size = Buffer.byteLength(frame);
            if (size - 1 > MAX_FRAME_BYTES) throw new ServiceError('Request too large', 'FRAME_TOO_LARGE');
            if (size > MAX_PENDING_BYTES - this.admittedBytes) throw new ServiceError('RPC byte budget exhausted', 'BUSY');
            frameBytes = size;
            this.admittedBytes += size;
            await this.start();
            if (this.closed || !this.ready) throw new ServiceError('Service unavailable', 'CLOSED');
            if (this.blocked) throw new ServiceError('Storage pipe busy', 'BUSY');
            return await new Promise((resolve, reject) => {
                const waiter = { resolve, reject, operationId, timer: null };
                waiter.timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new ServiceError(`${method} timed out; service was not killed`,
                        mutation ? 'OUTCOME_UNKNOWN' : 'TIMEOUT', operationId));
                }, timeoutMs);
                this.pending.set(id, waiter);
                try {
                    this.blocked = !this.child.stdin.write(frame, error => {
                        if (!error || !this.pending.has(id)) return;
                        clearTimeout(waiter.timer);
                        this.pending.delete(id);
                        reject(this._lost(waiter, error.message));
                    });
                } catch (error) {
                    clearTimeout(waiter.timer);
                    this.pending.delete(id);
                    reject(this._lost(waiter, error.message));
                }
            });
        } finally {
            this.admitted--;
            this.admittedBytes -= frameBytes;
        }
    }

    operationStatus(operationId) { return this.request('operation.status', { operationId }); }

    async close() {
        if (this.closed) return;
        // Never kill an in-flight mutation merely to clear UI state.
        if (this.admitted) throw new ServiceError('RPC calls still pending', 'BUSY');
        if (!this.child) { this.closed = true; return; }
        const child = this.child;
        const exited = new Promise(resolve => child.once('exit', resolve));
        await this.request('shutdown');
        child.stdin.end();
        await exited;
    }
}

module.exports = { ProjectServiceClient, ServiceError, MAX_FRAME_BYTES, MAX_PENDING, MAX_PENDING_BYTES };