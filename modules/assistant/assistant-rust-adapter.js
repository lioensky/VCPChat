const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const http = require('http');

class RustAssistantAdapter {
    constructor(options = {}) {
        this.logger = options.logger || console;
        this.projectRoot = options.projectRoot || process.cwd();
        this.port = options.port || 63791;
        this.debugMode = !!options.debugMode;
        this.process = null;
        this.pending = false;
        this.active = false;
        this.lifecycleState = 'stopped';
        this.selectionCallback = null;
        this.readyTimeout = null;
        this.lastDebugReason = null;
        this.lastDebugTimestamp = 0;
        this.forwardedEventCount = 0;
    }

    async initialize() {
        return;
    }

    setDebugMode(enabled) {
        this.debugMode = !!enabled;
    }

    setLifecycleState(nextState, reason = null) {
        this.lifecycleState = nextState;
        if (reason) {
            this.lastDebugReason = reason;
            this.lastDebugTimestamp = Date.now();
        }
    }

    getDiagnostics() {
        return {
            debugMode: this.debugMode,
            lastDebugReason: this.lastDebugReason,
            lastDebugTimestamp: this.lastDebugTimestamp,
            forwardedEventCount: this.forwardedEventCount,
            lifecycleState: this.lifecycleState,
            pending: this.pending,
            processAlive: !!(this.process && !this.process.killed),
            processPid: this.process?.pid || null
        };
    }

    processLogLines(lines) {
        for (const line of lines) {
            if (line.includes('Detected selection')) {
                this.lastDebugReason = '已捕获到选区文本';
                this.lastDebugTimestamp = Date.now();
            } else if (line.includes('Mouse released but no selected text captured')) {
                this.lastDebugReason = '鼠标释放后未捕获到选中文本';
                this.lastDebugTimestamp = Date.now();
            } else if (line.includes('Mouse button state unavailable in device_query')) {
                this.lastDebugReason = 'device_query 未提供鼠标按键状态，已切换 WinAPI 兜底';
                this.lastDebugTimestamp = Date.now();
            } else if (line.includes('Skipped by guard rules')) {
                this.lastDebugReason = '被 guard 规则过滤';
                this.lastDebugTimestamp = Date.now();
            } else if (line.includes('Skipped by displacement threshold')) {
                this.lastDebugReason = '被位移阈值过滤';
                this.lastDebugTimestamp = Date.now();
            } else if (line.includes('Skipped: mouse released on assistant window')) {
                this.lastDebugReason = '鼠标释放在助手自身窗口上，已过滤';
                this.lastDebugTimestamp = Date.now();
            } else if (line.toLowerCase().includes('panic') || line.includes('panicked at')) {
                this.setLifecycleState('degraded', 'Rust 监听线程发生 panic');
            }

            if (line.includes('RUST_ASSISTANT_READY')) {
                this.active = true;
                this.pending = false;
                this.setLifecycleState('ready', 'Rust sidecar 已就绪');
                if (this.readyTimeout) {
                    clearTimeout(this.readyTimeout);
                    this.readyTimeout = null;
                }
                this.logger.log('[Assistant][RustAdapter] Rust sidecar is ready.');
                continue;
            }

            if (line.startsWith('ASSISTANT_EVENT ')) {
                this.lastDebugReason = '已收到ASSISTANT_EVENT并回调前端';
                this.lastDebugTimestamp = Date.now();

                const payload = line.substring('ASSISTANT_EVENT '.length);
                try {
                    const event = JSON.parse(payload);
                    if (event && typeof event.mouse_x === 'number' && typeof event.mouse_y === 'number') {
                        event.mousePosEnd = { x: event.mouse_x, y: event.mouse_y };
                        event.endBottom = { x: event.mouse_x, y: event.mouse_y };
                    }
                    if (this.selectionCallback && event && typeof event.text === 'string') {
                        this.forwardedEventCount += 1;
                        this.selectionCallback(event);
                    }
                } catch (error) {
                    this.lastDebugReason = 'ASSISTANT_EVENT 解析失败';
                    this.lastDebugTimestamp = Date.now();
                    this.logger.error('[Assistant][RustAdapter] Failed to parse ASSISTANT_EVENT:', error);
                }
            }
        }
    }

    request(method, endpoint, body = null, timeoutMs = 3000) {
        return new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : null;
            const options = {
                hostname: '127.0.0.1',
                port: this.port,
                path: endpoint,
                method,
                timeout: timeoutMs,
                headers: {
                    'Connection': 'close',
                    'Content-Type': 'application/json'
                }
            };

            if (payload) {
                options.headers['Content-Length'] = Buffer.byteLength(payload);
            }

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    try {
                        const parsed = data ? JSON.parse(data) : null;
                        resolve({ status: res.statusCode, data: parsed });
                    } catch {
                        resolve({ status: res.statusCode, data });
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Request timeout: ${method} ${endpoint}`));
            });

            req.on('error', (error) => {
                reject(error);
            });

            if (payload) {
                req.write(payload);
            }
            req.end();
        });
    }

    async waitUntilReady(timeoutMs = 10000) {
        if (this.active) {
            return true;
        }

        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (this.active) {
                return true;
            }
            if (!this.process || this.process.killed) {
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return this.active;
    }

    async getStatus() {
        return this.request('GET', '/status');
    }

    async suspend(durationMs) {
        return this.request('POST', '/listener/suspend', {
            duration_ms: Math.max(0, Number(durationMs) || 0)
        });
    }

    async setGuardRules(rules = {}) {
        const payload = {
            whitelist: Array.isArray(rules.whitelist) ? rules.whitelist : [],
            blacklist: Array.isArray(rules.blacklist) ? rules.blacklist : [],
            screenshot_apps: Array.isArray(rules.screenshot_apps) ? rules.screenshot_apps : [],
            min_event_interval_ms: Math.max(0, Number(rules.min_event_interval_ms) || 80),
            min_distance: Math.max(0, Number(rules.min_distance) || 8),
            screenshot_suspend_ms: Math.max(0, Number(rules.screenshot_suspend_ms) || 3000),
            clipboard_conflict_suspend_ms: Math.max(0, Number(rules.clipboard_conflict_suspend_ms) || 1000),
            clipboard_check_interval_ms: Math.max(50, Number(rules.clipboard_check_interval_ms) || 500),
            own_window_handles: Array.isArray(rules.own_window_handles)
                ? rules.own_window_handles.map(value => String(value)).filter(Boolean)
                : [],
            own_process_ids: Array.isArray(rules.own_process_ids)
                ? rules.own_process_ids
                    .map(value => Number(value))
                    .filter(value => Number.isInteger(value) && value > 0)
                : []
        };
        return this.request('POST', '/guard/rules', payload);
    }

    async getGuardRules() {
        return this.request('GET', '/guard/rules');
    }

    onSelection(callback) {
        this.selectionCallback = callback;
    }

    isActive() {
        return this.active;
    }

    resolveExecutablePath() {
        const binaryName = process.platform === 'win32' ? 'assistant_core_server.exe' : 'assistant_core_server';
        const candidates = [
            path.join(this.projectRoot, 'assistant_engine', binaryName),
            path.join(this.projectRoot, 'rust_assistant_engine', 'target', 'release', binaryName),
            path.join(this.projectRoot, 'rust_assistant_engine', 'target', 'debug', binaryName)
        ];

        return candidates.find(candidate => fs.existsSync(candidate)) || null;
    }

    handleStdout(data) {
        const output = data.toString();
        if (this.debugMode) {
            this.logger.log(`[AssistantRust STDOUT]: ${output.trim()}`);
        }

        const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        this.processLogLines(lines);
    }

    start() {
        if (this.process && !this.process.killed) {
            return true;
        }

        const executablePath = this.resolveExecutablePath();
        if (!executablePath) {
            throw new Error('Rust assistant binary not found. Expected assistant_core_server in assistant_engine/ or rust_assistant_engine/target/*');
        }

        this.pending = true;
        this.active = false;
        this.setLifecycleState('starting', 'Rust sidecar 启动中');

        this.process = spawn(executablePath, ['--port', String(this.port)]);

        this.readyTimeout = setTimeout(() => {
            if (!this.active) {
                this.logger.error('[Assistant][RustAdapter] Rust sidecar failed to report READY within 10s.');
                this.setLifecycleState('degraded', 'Rust sidecar READY 超时');
            }
        }, 10000);

        this.process.stdout.on('data', (data) => this.handleStdout(data));

        this.process.stderr.on('data', (data) => {
            const logLine = data.toString().trim();
            const lines = logLine.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            this.processLogLines(lines);
            if (logLine && this.debugMode) {
                this.logger.error(`[AssistantRust STDERR]: ${logLine}`);
            }
        });

        this.process.on('close', (code) => {
            this.logger.log(`[Assistant][RustAdapter] Sidecar exited with code ${code}`);
            this.setLifecycleState('stopped', `Rust sidecar 已退出 (code=${code})`);
            this.process = null;
            this.pending = false;
            this.active = false;
            if (this.readyTimeout) {
                clearTimeout(this.readyTimeout);
                this.readyTimeout = null;
            }
        });

        this.process.on('error', (error) => {
            this.logger.error('[Assistant][RustAdapter] Failed to start sidecar:', error);
            this.setLifecycleState('degraded', `Rust sidecar 启动失败: ${error.message || error}`);
            this.pending = false;
            this.active = false;
            if (this.readyTimeout) {
                clearTimeout(this.readyTimeout);
                this.readyTimeout = null;
            }
        });

        return true;
    }

    stop() {
        if (this.readyTimeout) {
            clearTimeout(this.readyTimeout);
            this.readyTimeout = null;
        }

        if (this.process && !this.process.killed) {
            this.process.kill();
        }

        this.process = null;
        this.pending = false;
        this.active = false;
        this.setLifecycleState('stopped', 'Rust sidecar 已停止');
    }
}

function createRustAssistantAdapter(options) {
    return new RustAssistantAdapter(options);
}

module.exports = {
    createRustAssistantAdapter,
    RustAssistantAdapter
};
