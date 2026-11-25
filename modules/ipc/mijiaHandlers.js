'use strict';

const { app, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const capabilities = require('../../Mijiamodules/capabilities.json');

const failure = code => ({ success: false, code });
const MAX_OUTPUT = 4 * 1024 * 1024;
const LOGIN_TIMEOUT = 90_000;
let registered = false;
let listing = null;
let attempt = null;
const deviceQueues = new Map();
let queuedOperations = 0;

function isAllowedSender(event) {
    try {
        const frame = event.senderFrame;
        if (!frame || frame !== event.sender.mainFrame || event.sender.isDestroyed()) return false;
        const url = new URL(frame.url);
        if (url.protocol !== 'file:') return false;
        const relative = path.relative(app.getAppPath(), fileURLToPath(url));
        return relative === 'main.html' || relative === path.join('Mijiamodules', 'mijia.html');
    } catch {
        return false;
    }
}

function runBridge(command, timeout, onProgress = () => {}, input = null) {
    const root = app.getAppPath();
    const pythonRoot = root.endsWith('.asar') ? `${root}.unpacked` : root;
    const script = path.join(pythonRoot, 'Mijiamodules', 'mijia_bridge.py');
    let child;
    let lines;
    let timer;
    let result;
    let settled = false;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const finish = (response, kill = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lines?.close();
        if (kill) child?.kill();
        resolve(response);
    };

    try {
        child = spawn('python', ['-X', 'utf8', '-u', script, command], {
            shell: false,
            windowsHide: true,
            stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'ignore'],
        });
        timer = setTimeout(() => finish(failure('timeout'), true), timeout);
        let bytes = 0;
        child.stdout.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > MAX_OUTPUT) finish(failure('invalid_bridge_response'), true);
        });
        lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        lines.on('line', line => {
            if (settled) return;
            let message;
            try { message = JSON.parse(line); } catch {
                finish(failure('invalid_bridge_response'), true);
                return;
            }
            if (message?.event === 'devices' && Array.isArray(message.devices)) {
                result = {
                    success: true,
                    devices: message.devices.map(device => ({
                        ...device,
                        properties: Object.hasOwn(capabilities, device.model) ? capabilities[device.model].properties : [],
                    })),
                };
            } else if (message?.event === 'properties' && command === 'read'
                && typeof message.model === 'string' && isRecord(message.values)) {
                result = { success: true, model: message.model, values: message.values };
            } else if (message?.event === 'properties' && command === 'write' && isRecord(message.results)) {
                result = { success: true, results: message.results };
            } else if (message?.event === 'error' && typeof message.code === 'string') {
                result = failure(message.code);
            } else if (command === 'login' && message?.event === 'qr'
                && typeof message.png === 'string' && message.png.length <= 256_000
                && /^[A-Za-z0-9+/]+={0,2}$/.test(message.png)) {
                onProgress({ phase: 'qr', png: message.png });
            } else if (command === 'login' && message?.event === 'verifying') {
                onProgress({ phase: 'verifying' });
            } else {
                finish(failure('invalid_bridge_response'), true);
            }
        });
        child.once('error', error => finish(failure(error.code === 'ENOENT' ? 'python_missing' : 'bridge_failed')));
        child.once('close', code => finish(code === 0 && result ? result : failure('bridge_failed')));
        if (input !== null) {
            child.stdin.on('error', () => finish(failure('bridge_failed'), true));
            child.stdin.end(JSON.stringify(input), 'utf8');
        }
    } catch {
        finish(failure('bridge_failed'), true);
    }
    return { promise, cancel: () => finish(failure('cancelled'), true) };
}

function clearAttempt(job) {
    if (attempt !== job) return;
    attempt = null;
    clearTimeout(job.cleanupTimer);
    job.sender.removeListener('destroyed', job.abort);
    job.sender.removeListener('render-process-gone', job.abort);
}

function startLogin(sender) {
    if (attempt && !attempt.result) {
        if (attempt.sender !== sender) return failure('login_busy');
        return { success: true, attemptId: attempt.id };
    }
    if (attempt) clearAttempt(attempt);
    const job = { id: randomUUID(), sender, progress: { phase: 'starting' } };
    attempt = job;
    job.bridge = runBridge('login', LOGIN_TIMEOUT, progress => { job.progress = progress; });
    job.abort = () => {
        job.bridge.cancel();
        clearAttempt(job);
    };
    sender.once('destroyed', job.abort);
    sender.once('render-process-gone', job.abort);
    void job.bridge.promise.then(result => {
        if (attempt !== job) return;
        job.result = result;
        job.progress = null;
        job.cleanupTimer = setTimeout(() => clearAttempt(job), 60_000);
        job.cleanupTimer.unref();
    });
    return { success: true, attemptId: job.id };
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isDeviceId = id => typeof id === 'string' && id.length > 0 && id.length <= 256;

function enqueueDeviceOperation(command, input) {
    if (queuedOperations >= 16) return failure('device_busy');
    const previous = deviceQueues.get(input.id) || Promise.resolve();
    queuedOperations++;
    const job = previous.then(async () => {
        const response = await runBridge(command, 20_000, undefined, input).promise;
        if (command === 'write' && !response.success
            && ['timeout', 'bridge_failed', 'invalid_bridge_response'].includes(response.code)) {
            return failure('write_unconfirmed');
        }
        return response;
    }).finally(() => {
        queuedOperations--;
        if (deviceQueues.get(input.id) === job) deviceQueues.delete(input.id);
    });
    deviceQueues.set(input.id, job);
    return job;
}

function initialize() {
    if (registered) return;
    registered = true;
    const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => (
        isAllowedSender(event) ? callback(event.sender, ...args) : failure('forbidden')
    ));
    const ownsAttempt = (sender, id) => attempt?.sender === sender && attempt.id === id;

    handle('mijia:list', () => {
        if (!listing) {
            const bridge = runBridge('list', 20_000);
            listing = bridge.promise.finally(() => { listing = null; });
        }
        return listing;
    });
    handle('mijia:properties-read', (_sender, id) => (
        isDeviceId(id) ? enqueueDeviceOperation('read', { id }) : failure('invalid_request')
    ));
    handle('mijia:properties-write', (_sender, id, mode, changes) => {
        if (!isDeviceId(id) || !['immediate', 'apply'].includes(mode) || !isRecord(changes)) {
            return failure('invalid_request');
        }
        const entries = Object.entries(changes);
        if (entries.length < 1 || entries.length > 8 || entries.some(([key, value]) =>
            !/^[a-z][a-zA-Z0-9]{0,39}$/.test(key)
            || (typeof value !== 'boolean' && !Number.isSafeInteger(value)))) {
            return failure('invalid_request');
        }
        return enqueueDeviceOperation('write', { id, mode, changes: Object.fromEntries(entries) });
    });
    handle('mijia:login-start', startLogin);
    handle('mijia:login-state', (sender, id) => {
        if (!ownsAttempt(sender, id)) return failure('login_attempt_missing');
        return attempt.result
            ? { phase: 'done', ...attempt.result }
            : { success: true, ...attempt.progress };
    });
    handle('mijia:login-cancel', (sender, id) => {
        if (!ownsAttempt(sender, id)) return failure('login_attempt_missing');
        attempt.abort();
        return { success: true };
    });
    app.once('before-quit', () => attempt?.abort());
}

module.exports = { initialize };