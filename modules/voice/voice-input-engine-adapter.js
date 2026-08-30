'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_READY_TIMEOUT_MS = 10000;

class VoiceInputEngineAdapter {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot || process.cwd();
        this.logger = options.logger || console;
        this.process = null;
        this.lineReader = null;
        this.ready = false;
        this.startPromise = null;
        this.readyWaiter = null;
        this.pendingRequests = new Map();
        this.requestSequence = 0;
        this.lastError = null;
        this.lastEvent = null;
        this.lifecycleState = 'stopped';
        this.eventListeners = new Set();
    }

    getRuntimeTarget() {
        return {
            directoryName: `${process.platform}-${process.arch}`,
            executableName: process.platform === 'win32'
                ? 'vcp_voice_input_engine.exe'
                : 'vcp_voice_input_engine',
        };
    }

    resolveExecutablePath() {
        const target = this.getRuntimeTarget();
        const packagedRoot = process.resourcesPath
            ? path.join(
                process.resourcesPath,
                'app.asar.unpacked',
                'rust_voice_input_engine',
            )
            : null;
        const roots = [
            path.join(this.projectRoot, 'rust_voice_input_engine'),
            packagedRoot,
        ].filter(Boolean);

        const candidates = roots.flatMap(root => [
            path.join(root, 'runtime', target.directoryName, target.executableName),
            path.join(root, 'target', 'release', target.executableName),
            path.join(root, 'target', 'debug', target.executableName),
        ]);

        return candidates.find(candidate => fs.existsSync(candidate)) || null;
    }

    getStatus() {
        return {
            lifecycleState: this.lifecycleState,
            ready: this.ready,
            processAlive: !!(this.process && !this.process.killed),
            processPid: this.process?.pid || null,
            pendingRequestCount: this.pendingRequests.size,
            lastError: this.lastError,
            lastEvent: this.lastEvent,
        };
    }

    createRequestId() {
        this.requestSequence += 1;
        return `voice-input-${Date.now()}-${this.requestSequence}`;
    }

    async start() {
        if (this.ready && this.process && !this.process.killed) {
            return this.getStatus();
        }
        if (this.startPromise) {
            return this.startPromise;
        }

        this.startPromise = this.startProcess();
        try {
            return await this.startPromise;
        } finally {
            this.startPromise = null;
        }
    }

    startProcess() {
        return new Promise((resolve, reject) => {
            const executablePath = this.resolveExecutablePath();
            if (!executablePath) {
                const error = new Error(
                    'Voice input engine binary not found. Run node rust_voice_input_engine/build-runtime.js first.',
                );
                this.lastError = error.message;
                this.lifecycleState = 'unavailable';
                reject(error);
                return;
            }

            this.lifecycleState = 'starting';
            this.ready = false;
            this.lastError = null;

            const child = spawn(executablePath, [], {
                cwd: path.dirname(executablePath),
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            this.process = child;

            const readyTimeout = setTimeout(() => {
                if (this.ready || this.process !== child) return;
                const error = new Error(
                    `Voice input engine did not become ready within ${DEFAULT_READY_TIMEOUT_MS}ms.`,
                );
                this.lastError = error.message;
                this.lifecycleState = 'degraded';
                this.readyWaiter = null;
                reject(error);
                this.forceTerminate(child);
            }, DEFAULT_READY_TIMEOUT_MS);

            this.readyWaiter = {
                child,
                resolve: () => {
                    clearTimeout(readyTimeout);
                    this.readyWaiter = null;
                    resolve(this.getStatus());
                },
                reject: error => {
                    clearTimeout(readyTimeout);
                    this.readyWaiter = null;
                    reject(error);
                },
            };

            this.lineReader = readline.createInterface({
                input: child.stdout,
                crlfDelay: Infinity,
            });
            this.lineReader.on('line', line => this.handleStdoutLine(child, line));

            child.stderr.on('data', data => {
                const message = data.toString().trim();
                if (message) {
                    this.logger.warn(`[VoiceInputEngine][stderr] ${message}`);
                }
            });

            child.once('error', error => {
                if (this.process !== child) return;
                this.lastError = error.message;
                this.lifecycleState = 'degraded';
                this.ready = false;
                this.readyWaiter?.reject(error);
                this.rejectAllPending(error);
            });

            child.once('close', (code, signal) => {
                if (this.process !== child) return;
                const wasStopping = this.lifecycleState === 'stopping';
                const error = new Error(
                    `Voice input engine exited (code=${code}, signal=${signal || 'none'}).`,
                );
                this.process = null;
                this.ready = false;
                this.lineReader = null;
                this.lifecycleState = wasStopping ? 'stopped' : 'degraded';
                if (!wasStopping) this.lastError = error.message;
                this.readyWaiter?.reject(error);
                this.rejectAllPending(error);
            });
        });
    }

    onEvent(listener) {
        if (typeof listener !== 'function') {
            throw new TypeError('Voice input engine event listener must be a function.');
        }
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    }

    emitEvent(event) {
        for (const listener of this.eventListeners) {
            try {
                listener(event);
            } catch (error) {
                this.logger.error('[VoiceInputEngine] Event listener failed:', error);
            }
        }
    }

    handleStdoutLine(child, line) {
        if (this.process !== child || !line.trim()) return;

        let event;
        try {
            event = JSON.parse(line);
        } catch (error) {
            this.logger.warn('[VoiceInputEngine] Ignored malformed stdout line:', line);
            return;
        }

        this.lastEvent = event;
        if (event.event === 'ready' && event.success === true) {
            this.ready = true;
            this.lifecycleState = 'ready';
            this.readyWaiter?.resolve();
            return;
        }

        const requestId = event.request_id;
        if (!requestId) {
            this.emitEvent(event);
            return;
        }
        const pending = this.pendingRequests.get(requestId);
        if (!pending) return;

        clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestId);
        if (event.success === false || event.event === 'error') {
            const error = new Error(event.error || `Voice input command failed: ${pending.command}`);
            this.lastError = error.message;
            pending.reject(error);
            return;
        }
        pending.resolve(event);
    }

    async request(command, payload = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
        await this.start();
        const child = this.process;
        if (!child || child.killed || !this.ready || !child.stdin?.writable) {
            throw new Error('Voice input engine is not ready.');
        }

        const requestId = this.createRequestId();
        const message = {
            command,
            request_id: requestId,
            ...payload,
        };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                const error = new Error(
                    `Voice input engine command timed out: ${command}`,
                );
                this.lastError = error.message;
                reject(error);
            }, timeoutMs);

            this.pendingRequests.set(requestId, {
                command,
                timeout,
                resolve,
                reject,
            });

            child.stdin.write(`${JSON.stringify(message)}\n`, error => {
                if (!error) return;
                const pending = this.pendingRequests.get(requestId);
                if (!pending) return;
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(requestId);
                this.lastError = error.message;
                reject(error);
            });
        });
    }

    configureHotkey({ shortcut, mode }) {
        return this.request('configure_hotkey', {
            shortcut: String(shortcut),
            mode: String(mode),
        });
    }

    focusReady({ targetWindowHandle }) {
        return this.request('focus_ready', {
            target_window_handle: String(targetWindowHandle),
        });
    }

    stopSession() {
        return this.request('stop_session');
    }

    restoreFocus() {
        return this.request('restore_focus');
    }

    cancel() {
        return this.request('cancel');
    }

    releaseAll() {
        return this.request('release_all');
    }

    async shutdown() {
        const child = this.process;
        if (!child || child.killed) {
            this.resetStoppedState();
            return;
        }

        this.lifecycleState = 'stopping';
        try {
            await this.request('shutdown', {}, 2000);
        } catch (error) {
            this.logger.warn('[VoiceInputEngine] Graceful shutdown failed:', error.message);
        }

        if (this.process === child && !child.killed) {
            this.forceTerminate(child);
        }
        this.resetStoppedState();
    }

    forceTerminate(child = this.process) {
        if (!child || child.killed) return;
        try {
            child.kill();
        } catch (error) {
            this.logger.warn('[VoiceInputEngine] Failed to terminate sidecar:', error.message);
        }
    }

    rejectAllPending(error) {
        for (const pending of this.pendingRequests.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pendingRequests.clear();
    }

    resetStoppedState() {
        this.lineReader?.close();
        this.lineReader = null;
        this.process = null;
        this.ready = false;
        this.readyWaiter = null;
        this.lifecycleState = 'stopped';
    }
}

module.exports = {
    DEFAULT_REQUEST_TIMEOUT_MS,
    DEFAULT_READY_TIMEOUT_MS,
    VoiceInputEngineAdapter,
};