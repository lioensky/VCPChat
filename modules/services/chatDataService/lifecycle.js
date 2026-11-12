'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');
const EventEmitter = require('events');

const { ChatDataServiceClient, ChatDataServiceError } = require('./client');

const PROTOCOL_VERSION = 3;
const SCHEMA_VERSION = 3;

class ChatDataServiceLifecycle extends EventEmitter {
    constructor(options = {}) {
        super();
        this.appDataPath = options.appDataPath;
        this.binaryPath = options.binaryPath || resolveDefaultBinaryPath();
        this.enabled = options.enabled !== false;
        this.notifyEnabled = options.notifyEnabled !== false;
        this.tantivyEnabled = options.tantivyEnabled !== false;
        this.startupTimeoutMs = options.startupTimeoutMs || 30_000;
        this.recoveryTimeoutMs = options.recoveryTimeoutMs || 180_000;
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
        // 最近一次 start() 的失败原因；用于区分瞬态故障（重启有意义）与
        // 确定性失败（retryable=false，如版本不匹配——重启必然复现）。
        this.lastStartError = null;
    }

    get isReady() {
        return Boolean(this.client && this.process && !this.process.killed);
    }

    async start() {
        if (!this.enabled) return null;
        if (this.client) return this.client;
        if (this.startPromise) return this.startPromise;
        if (this.circuitOpen) {
            const error = new ChatDataServiceError('VCP-CDS restart circuit is open.', {
                code: 'CIRCUIT_OPEN',
                retryable: false
            });
            if (!this.lastStartError) this.lastStartError = error;
            throw error;
        }
        if (!this.appDataPath) {
            const error = new ChatDataServiceError('Missing AppData path for VCP-CDS.', {
                code: 'INVALID_CONFIGURATION'
            });
            this.lastStartError = error;
            throw error;
        }
        if (!fs.existsSync(this.binaryPath)) {
            const error = new ChatDataServiceError(
                `VCP-CDS binary was not found at ${this.binaryPath}.`,
                { code: 'BINARY_NOT_FOUND', retryable: false }
            );
            this.lastStartError = error;
            throw error;
        }

        this.stopping = false;
        this.startPromise = this._spawnAndWaitForReady();
        try {
            this.client = await this.startPromise;
            this.lastStartError = null;
            this._scheduleStabilityReset();
            this.emit('ready', this.handshake);
            return this.client;
        } catch (error) {
            this.lastStartError = error;
            throw error;
        } finally {
            this.startPromise = null;
        }
    }

    async _spawnAndWaitForReady() {
        return new Promise((resolve, reject) => {
            let settled = false;
            let handshakeReceived = false;
            let healthPending = false;
            let recoveryStarted = false;
            let stage = 'spawn';
            const startedAt = Date.now();
            const args = [
                '--app-data', this.appDataPath,
                '--port', '0',
                '--notify-enabled', String(this.notifyEnabled),
                '--tantivy-enabled', String(this.tantivyEnabled)
            ];
            const child = spawn(this.binaryPath, args, {
                cwd: path.dirname(this.binaryPath),
                windowsHide: true,
                env: { ...process.env, VCP_CDS_STARTUP_PROGRESS: '1' },
                stdio: ['ignore', 'pipe', 'pipe']
            });
            this.process = child;
            let timeout;
            const fail = (error, kill = true) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                // Persist before kill: exit may run before start()'s catch.
                this.lastStartError = error;
                if (kill) child.kill();
                reject(error);
            };
            const armTimeout = (duration, recovering) => {
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    fail(new ChatDataServiceError(
                        `VCP-CDS ${recovering ? 'recovery' : 'startup'} timed out at ${stage} after ${Date.now() - startedAt}ms.`,
                        {
                            code: recovering ? 'RECOVERY_TIMEOUT' : 'STARTUP_TIMEOUT',
                            retryable: !recovering
                        }
                    ));
                }, duration);
            };
            armTimeout(this.startupTimeoutMs, false);
            const stages = new Set([
                'database_open', 'integrity_check', 'integrity_complete',
                'database_ready', 'watcher_start', 'watcher_ready'
            ]);
            const stdout = readline.createInterface({ input: child.stdout });
            stdout.on('line', async line => {
                if (settled || healthPending || !line.trim()) return;
                try {
                    const frame = JSON.parse(line);
                    if (frame?.type === 'startup_progress') {
                        if (frame.protocolVersion !== PROTOCOL_VERSION || !stages.has(frame.stage)) {
                            throw new ChatDataServiceError('Invalid VCP-CDS startup progress.', {
                                code: 'INVALID_HANDSHAKE', retryable: false
                            });
                        }
                        // Only the first database_open grants a recovery budget.
                        // Repeated progress cannot extend this absolute deadline.
                        if (!recoveryStarted && frame.stage !== 'database_open') {
                            throw new ChatDataServiceError('VCP-CDS startup progress is out of order.', {
                                code: 'INVALID_HANDSHAKE', retryable: false
                            });
                        }
                        if (!recoveryStarted) {
                            recoveryStarted = true;
                            armTimeout(this.recoveryTimeoutMs, true);
                        }
                        stage = frame.stage;
                        const progress = { stage, elapsedMs: Date.now() - startedAt };
                        this.logger.info?.(`[VCP-CDS] startup stage=${stage} elapsedMs=${progress.elapsedMs}`);
                        this.emit('startup-progress', progress);
                        return;
                    }
                    validateHandshake(frame);
                    healthPending = true;
                    stage = 'health';
                    const client = new ChatDataServiceClient({
                        port: frame.port,
                        authToken: frame.authToken,
                        protocolVersion: PROTOCOL_VERSION
                    });
                    await client.health();
                    if (settled || this.stopping || this.process !== child) return;
                    handshakeReceived = true;
                    this.handshake = frame;
                    settled = true;
                    clearTimeout(timeout);
                    resolve(client);
                } catch (error) {
                    fail(error instanceof ChatDataServiceError ? error : new ChatDataServiceError(
                        'VCP-CDS emitted an invalid handshake.',
                        { code: 'INVALID_HANDSHAKE', retryable: true, cause: error }
                    ));
                }
            });
            child.stderr.on('data', data => {
                const line = data.toString().trim();
                if (line) this.logger.info?.(`[VCP-CDS] ${line}`);
            });
            child.once('error', error => {
                fail(new ChatDataServiceError('Failed to launch VCP-CDS.', {
                    code: 'SPAWN_FAILED', retryable: true, cause: error
                }), false);
            });
            child.once('exit', (code, signal) => {
                clearTimeout(timeout);
                stdout.close();
                const wasReady = handshakeReceived;
                if (this.process === child) {
                    if (this.stabilityTimer) {
                        clearTimeout(this.stabilityTimer);
                        this.stabilityTimer = null;
                    }
                    this.process = null;
                    this.client = null;
                    this.handshake = null;
                }
                if (!settled) {
                    fail(new ChatDataServiceError(
                        `VCP-CDS exited before ready at ${stage} (code=${code}, signal=${signal}).`,
                        { code: 'EARLY_EXIT', retryable: true }
                    ), false);
                }
                this.emit('exit', { code, signal, wasReady, stopping: this.stopping });
                if (!this.stopping && this.enabled) {
                    if (this._blockNonRetryableRestart(this.lastStartError)) return;
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

    _blockNonRetryableRestart(error) {
        if (!error || error.retryable !== false) return false;
        this.circuitOpen = true;
        const code = error.code || 'UNKNOWN';
        const hint = code === 'PROTOCOL_MISMATCH' || code === 'SCHEMA_MISMATCH'
            ? 'CDS 二进制与插件协议版本不匹配——请重建（cargo build --release）并替换 bin 目录内的 CDS 可执行文件。'
            : code === 'RECOVERY_TIMEOUT'
                ? '数据库恢复超出预算；保留数据库和 WAL，检查磁盘 I/O 与完整性检查耗时后再手动重试，避免重复终止恢复。'
                : '请修复上述启动错误后重启应用。';
        this.logger.error?.(`[VCP-CDS] 启动失败且不可重试（${code}），本会话不再自动重启。${hint}`);
        this.emit('circuit-open', { attempts: this.restartAttempts, reason: code });
        return true;
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
                // start() 在 spawn 之前抛出的确定性失败（如 BINARY_NOT_FOUND）
                // 没有进程、不会触发 exit 事件，必须在这里同样熔断。
                if (this._blockNonRetryableRestart(error)) return;
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
