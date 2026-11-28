'use strict';

// 音频引擎（rust_audio_engine/audio_server）的本地端口与运行状态。
//
// 引擎以前固定监听 63789。Windows 开机时会为 Hyper-V/WinNAT 随机预留一段 TCP 端口，
// 这段端口恰好盖住 63789 时引擎绑定失败，音乐窗口里所有请求都失败，表现为时长 0:00、无法播放。
// 现在由主进程在启动引擎前探测一个能绑定的端口，记在这里；主进程、WebDAV、音乐窗口的
// 可视化 WebSocket 都从这里取同一个地址，不再各自写死。

const net = require('net');
const http = require('http');
const { EventEmitter } = require('events');

const AUDIO_ENGINE_HOST = '127.0.0.1';
const DEFAULT_AUDIO_ENGINE_PORT = 63789;
// 备用端口放在动态端口范围（49152 起）之下，系统预留端口段通常落在动态范围里。
const FALLBACK_AUDIO_ENGINE_PORTS = Object.freeze([
    43789, 43790, 43791, 43792, 43793, 43794, 43795, 43796, 43797, 43798,
]);
const AUDIO_ENGINE_PORT_CANDIDATES = Object.freeze([
    DEFAULT_AUDIO_ENGINE_PORT,
    ...FALLBACK_AUDIO_ENGINE_PORTS,
]);

const events = new EventEmitter();
let currentPort = DEFAULT_AUDIO_ENGINE_PORT;
let status = { state: 'idle', port: DEFAULT_AUDIO_ENGINE_PORT, message: '' };

// 能否在 host:port 上监听。端口被占（EADDRINUSE）和被系统预留（Windows 上是 EACCES）都算不可用。
function probePort(port, host = AUDIO_ENGINE_HOST) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.unref();
        server.once('error', (error) => resolve({ ok: false, port, code: error?.code || 'UNKNOWN' }));
        server.listen({ port, host, exclusive: true }, () => {
            const actualPort = server.address()?.port ?? port;
            server.close(() => resolve({ ok: true, port: actualPort }));
        });
    });
}

// 按候选顺序找第一个能绑定的端口；全部不可用时交给系统分配一个空闲端口（port 0）。
async function findAvailablePort({
    candidates = AUDIO_ENGINE_PORT_CANDIDATES,
    exclude = [],
    host = AUDIO_ENGINE_HOST,
    probe = probePort,
    allowSystemAssigned = true,
} = {}) {
    const skipped = [];
    const excluded = new Set(exclude.map(Number));
    for (const candidate of candidates) {
        if (excluded.has(candidate)) continue;
        const result = await probe(candidate, host);
        if (result.ok) return { port: result.port, skipped };
        skipped.push({ port: candidate, code: result.code });
    }
    if (allowSystemAssigned) {
        const result = await probe(0, host);
        if (result.ok && !excluded.has(result.port)) return { port: result.port, skipped };
    }
    const error = new Error(`没有可用的本地端口（试过 ${skipped.map(item => item.port).join(', ')}）`);
    error.code = 'AUDIO_ENGINE_NO_PORT';
    error.skipped = skipped;
    throw error;
}

// 确认这个端口上应答的是音频引擎本身：GET /state 返回带 status 字段的 JSON。
// 旧版引擎在绑定端口之前就打印就绪信号，端口上也可能是别的程序，所以不能只看能否连上。
function checkEngineResponds(port, { host = AUDIO_ENGINE_HOST, timeoutMs = 1000 } = {}) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (ok) => {
            if (settled) return;
            settled = true;
            resolve(ok);
        };
        const request = http.get({ host, port, path: '/state', timeout: timeoutMs }, (response) => {
            if (response.statusCode !== 200) {
                response.resume();
                done(false);
                return;
            }
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                if (body.length + chunk.length > 65536) {
                    request.destroy();
                    done(false);
                    return;
                }
                body += chunk;
            });
            response.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    done(Boolean(parsed && typeof parsed.status === 'string'));
                } catch (_) {
                    done(false);
                }
            });
            response.on('error', () => done(false));
        });
        request.on('timeout', () => request.destroy(new Error('timeout')));
        request.on('error', () => done(false));
    });
}

async function waitForEngineResponding(port, { host = AUDIO_ENGINE_HOST, timeoutMs = 3000, intervalMs = 100, isAborted = () => false, check = checkEngineResponds } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (!isAborted()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        if (await check(port, { host, timeoutMs: Math.min(1000, remaining) })) return !isAborted();
        const waitMs = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
        if (waitMs <= 0) return false;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    return false;
}

function getPort() {
    return currentPort;
}

function getBaseUrl() {
    return `http://${AUDIO_ENGINE_HOST}:${currentPort}`;
}

function getWebSocketUrl() {
    return `ws://${AUDIO_ENGINE_HOST}:${currentPort}/ws`;
}

function getStatus() {
    return { ...status };
}

function getEndpoint() {
    return {
        host: AUDIO_ENGINE_HOST,
        port: currentPort,
        baseUrl: getBaseUrl(),
        wsUrl: getWebSocketUrl(),
        ...getStatus(),
    };
}

function setStatus(next) {
    status = { ...status, ...next, port: currentPort };
    events.emit('status', getEndpoint());
}

function markStarting(port) {
    currentPort = port;
    setStatus({ state: 'starting', message: '' });
}

function markReady(port) {
    currentPort = port;
    setStatus({ state: 'ready', message: '' });
}

function markFailed(message) {
    setStatus({ state: 'failed', message: String(message || '音频引擎没有启动') });
}

function markStopped() {
    setStatus({ state: 'stopped', message: '' });
}

function onStatus(listener) {
    events.on('status', listener);
    return () => events.off('status', listener);
}

// 仅供测试复位。
function resetForTests() {
    currentPort = DEFAULT_AUDIO_ENGINE_PORT;
    status = { state: 'idle', port: DEFAULT_AUDIO_ENGINE_PORT, message: '' };
    events.removeAllListeners();
}

module.exports = {
    AUDIO_ENGINE_HOST,
    DEFAULT_AUDIO_ENGINE_PORT,
    FALLBACK_AUDIO_ENGINE_PORTS,
    AUDIO_ENGINE_PORT_CANDIDATES,
    probePort,
    findAvailablePort,
    checkEngineResponds,
    waitForEngineResponding,
    getPort,
    getBaseUrl,
    getWebSocketUrl,
    getStatus,
    getEndpoint,
    markStarting,
    markReady,
    markFailed,
    markStopped,
    onStatus,
    resetForTests,
};
