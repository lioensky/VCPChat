'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');
const EventEmitter = require('events');

const { ChatDataServiceClient, ChatDataServiceError } = require('./client');

const PROTOCOL_VERSION = 2;
const SCHEMA_VERSION = 1;

class ChatDataServiceLifecycle extends EventEmitter {
    constructor(options = {}) {
        super();
        this.appDataPath = options.appDataPath;
        this.binaryPath = options.binaryPath || resolveDefaultBinaryPath();
        this.enabled = options.enabled !== false;
        this.notifyEnabled = options.notifyEnabled !== false;
        this.tantivyEnabled = options.tantivyEnabled !== false;
        this.startupTimeoutMs = options.startupTimeoutMs || 30_000;
        this.maxRestarts = options.maxRestarts || 5;
        this.logger = options.logger || console;

        this.process = null;
        this.client = null;
        this.handshake = null;
        this.startPromise = null;
        this.stopPromise = null;
        this.restartTimer = null;
        this.stabilityTimer = null;
        this.restartAttempts = 0;
        this.stopping = false;
        this.circuitOpen = false;
    }

    get isReady() {
        return Boolean(this.client && this.process && !this.process.killed);
    }

    async start() {
        if (!this.enabled) return null;
        if (this.client) return this.client;
        if (this.startPromise) return this.startPromise;
        if (this.circuitOpen) {
            throw new ChatDataServiceError('VCP-CDS restart circuit is open.', {
                code: 'CIRCUIT_OPEN',
                retryable: false
            });
        }
        if (!this.appDataPath) {
            throw new ChatDataServiceError('Missing AppData path for VCP-CDS.', {
                code: 'INVALID_CONFIGURATION'
            });
        }
        if (!fs.existsSync(this.binaryPath)) {
            throw new ChatDataServiceError(
                `VCP-CDS binary was not found at ${this.binaryPath}.`,
                { code: 'BINARY_NOT_FOUND', retryable: false }
            );
        }

        this.stopping = false;
        this.startPromise = this._spawnAndWaitForReady();
        try {
            this.client = await this.startPromise;
            this._scheduleStabilityReset();
            this.emit('ready', this.handshake);
            return this.client;
        } finally {
            this.startPromise = null;
        }
    }

    async _spawnAndWaitForReady() {
        return new Promise((resolve, reject) => {
            let settled = false;
            let handshakeReceived = false;
            const args = [
                '--app-data', this.appDataPath,
                '--port', '0',
                '--notify-enabled', String(this.notifyEnabled),
                '--tantivy-enabled', String(this.tantivyEnabled)
            ];

            const child = spawn(this.binaryPath, args, {
                cwd: path.dirname(this.binaryPath),
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
            this.process = child;

            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                child.kill();
                reject(new ChatDataServiceError('VCP-CDS startup timed out.', {
                    code: 'STARTUP_TIMEOUT',
                    retryable: true
                }));
            }, this.startupTimeoutMs);

            const stdout = readline.createInterface({ input: child.stdout });
            stdout.on('line', async line => {
                if (handshakeReceived || settled || !line.trim()) return;
                let handshake;
                try {
                    handshake = JSON.parse(line);
                } catch (error) {
                    settled = true;
                    clearTimeout(timeout);
                    child.kill();
                    reject(new ChatDataServiceError('VCP-CDS emitted an invalid handshake.', {
                        code: 'INVALID_HANDSHAKE',
                        retryable: true,
                        cause: error
                    }));
                    return;
                }

                try {
                    validateHandshake(handshake);
                    const client = new ChatDataServiceClient({
                        port: handshake.port,
                        authToken: handshake.authToken,
                        protocolVersion: PROTOCOL_VERSION
                    });
                    await client.health();
                    handshakeReceived = true;
                    this.handshake = handshake;
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        resolve(client);
                    }
                } catch (error) {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        child.kill();
                        reject(error);
                    }
                }
            });

            child.stderr.on('data', data => {
                const line = data.toString().trim();
                if (line) this.logger.info?.(`[VCP-CDS] ${line}`);
            });

            child.once('error', error => {
                clearTimeout(timeout);
                if (!settled) {
                    settled = true;
                    reject(new ChatDataServiceError('Failed to launch VCP-CDS.', {
                        code: 'SPAWN_FAILED',
                        retryable: true,
                        cause: error
                    }));
                }
            });

            child.once('exit', (code, signal) => {
                clearTimeout(timeout);
                if (this.stabilityTimer) {
                    clearTimeout(this.stabilityTimer);
                    this.stabilityTimer = null;
                }
                stdout.close();
                const wasReady = handshakeReceived;
                this.process = null;
                this.client = null;
                this.handshake = null;

                if (!settled) {
                    settled = true;
                    reject(new ChatDataServiceError(
                        `VCP-CDS exited before ready (code=${code}, signal=${signal}).`,
                        { code: 'EARLY_EXIT', retryable: true }
                    ));
                }

                this.emit('exit', { code, signal, wasReady, stopping: this.stopping });
                if (!this.stopping && this.enabled) {
                    this._scheduleRestart();
                }
            });
        });
    }

    _scheduleStabilityReset() {
        if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
        this.stabilityTimer = setTimeout(() => {
            this.stabilityTimer = null;
            if (this.isReady) {
                this.restartAttempts = 0;
            }
        }, 60_000);
    }

    _scheduleRestart() {
        if (this.restartTimer || this.circuitOpen) return;
        this.restartAttempts += 1;
        if (this.restartAttempts > this.maxRestarts) {
            this.circuitOpen = true;
            this.emit('circuit-open', { attempts: this.restartAttempts - 1 });
            this.logger.error?.('[VCP-CDS] Restart limit reached; shadow service disabled for this session.');
            return;
        }

        const delayMs = Math.min(30_000, 1000 * (2 ** (this.restartAttempts - 1)));
        this.emit('restart-scheduled', { attempt: this.restartAttempts, delayMs });
        this.restartTimer = setTimeout(async () => {
            this.restartTimer = null;
            try {
                await this.start();
            } catch (error) {
                this.logger.error?.('[VCP-CDS] Restart failed:', error);
                this._scheduleRestart();
            }
        }, delayMs);
    }

    async stop() {
        this.stopping = true;
        this.enabled = false;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.stabilityTimer) {
            clearTimeout(this.stabilityTimer);
            this.stabilityTimer = null;
        }
        if (this.stopPromise) return this.stopPromise;

        this.stopPromise = (async () => {
            const child = this.process;
            if (!child) return;

            if (this.client) {
                try {
                    await this.client.shutdown();
                } catch (error) {
                    this.logger.warn?.('[VCP-CDS] Graceful shutdown request failed:', error.message);
                }
            }

            await Promise.race([
                new Promise(resolve => child.once('exit', resolve)),
                new Promise(resolve => setTimeout(resolve, 3500))
            ]);

            if (this.process === child && !child.killed) {
                child.kill();
            }
            this.process = null;
            this.client = null;
            this.handshake = null;
        })();

        try {
            await this.stopPromise;
        } finally {
            this.stopPromise = null;
        }
    }

    resetCircuit() {
        this.circuitOpen = false;
        this.restartAttempts = 0;
        this.enabled = true;
    }
}

function validateHandshake(handshake) {
    if (!handshake || handshake.type !== 'ready') {
        throw new ChatDataServiceError('Unexpected VCP-CDS handshake type.', {
            code: 'INVALID_HANDSHAKE'
        });
    }
    if (handshake.protocolVersion !== PROTOCOL_VERSION) {
        throw new ChatDataServiceError(
            `VCP-CDS protocol mismatch: expected ${PROTOCOL_VERSION}, received ${handshake.protocolVersion}.`,
            { code: 'PROTOCOL_MISMATCH', retryable: false }
        );
    }
    if (handshake.schemaVersion !== SCHEMA_VERSION) {
        throw new ChatDataServiceError(
            `VCP-CDS schema mismatch: expected ${SCHEMA_VERSION}, received ${handshake.schemaVersion}.`,
            { code: 'SCHEMA_MISMATCH', retryable: false }
        );
    }
    if (!Number.isInteger(handshake.port) || !handshake.authToken || !handshake.instanceId) {
        throw new ChatDataServiceError('VCP-CDS handshake is incomplete.', {
            code: 'INVALID_HANDSHAKE'
        });
    }
}

function resolveRuntimeTarget(platform = process.platform, architecture = process.arch) {
    const supportedPlatforms = new Set(['win32', 'darwin', 'linux']);
    const supportedArchitectures = new Set(['x64', 'arm64']);
    if (!supportedPlatforms.has(platform)) {
        throw new ChatDataServiceError(
            `VCP-CDS does not provide a runtime for platform '${platform}'.`,
            { code: 'UNSUPPORTED_PLATFORM', retryable: false }
        );
    }
    if (!supportedArchitectures.has(architecture)) {
        throw new ChatDataServiceError(
            `VCP-CDS does not provide a runtime for architecture '${architecture}'.`,
            { code: 'UNSUPPORTED_ARCHITECTURE', retryable: false }
        );
    }

    return {
        directoryName: `${platform}-${architecture}`,
        binaryName: platform === 'win32'
            ? 'vcp_chat_data_service.exe'
            : 'vcp_chat_data_service'
    };
}

function resolveDefaultBinaryPath(platform = process.platform, architecture = process.arch) {
    const target = resolveRuntimeTarget(platform, architecture);
    const relativeParts = [
        'modules',
        'services',
        'chatDataService',
        'bin',
        target.directoryName,
        target.binaryName
    ];

    const asarMarker = `${path.sep}app.asar${path.sep}`;
    const markerIndex = __dirname.indexOf(asarMarker);
    if (markerIndex !== -1) {
        const resourcesPath = __dirname.slice(0, markerIndex);
        return path.join(resourcesPath, 'app.asar.unpacked', ...relativeParts);
    }

    return path.join(__dirname, 'bin', target.directoryName, target.binaryName);
}

module.exports = {
    ChatDataServiceLifecycle,
    PROTOCOL_VERSION,
    SCHEMA_VERSION,
    validateHandshake,
    resolveRuntimeTarget,
    resolveDefaultBinaryPath
};
