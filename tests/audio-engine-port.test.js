'use strict';

// 音频引擎端口：默认端口被占用或被系统预留时要换端口，且主进程、WebDAV、音乐窗口用同一个端口。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const endpoint = require('../modules/services/audioEngineEndpoint');
const { launchAudioEngine, READY_SIGNAL } = require('../modules/services/audioEngineLauncher');

const ROOT = path.join(__dirname, '..');

function listen(port) {
    return new Promise((resolve, reject) => {
        const server = net.createServer((socket) => socket.destroy());
        server.once('error', reject);
        server.listen({ port, host: '127.0.0.1' }, () => resolve(server));
    });
}

function close(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}

// 按引擎的样子应答 GET /state。
function listenAsEngine(port) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'success', state: {} }));
        });
        server.once('error', reject);
        server.listen({ port, host: '127.0.0.1' }, () => resolve(server));
    });
}

// 模拟 audio_server：按 --port 监听；mode 为 'crash-after-ready' 时模仿旧版二进制，
// 先打印就绪信号、再绑定失败退出。
function createFakeEngine(modes) {
    const spawned = [];
    const spawnProcess = (_binary, args) => {
        const port = Number(args[args.indexOf('--port') + 1]);
        const mode = modes[spawned.length] || 'ok';
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.killed = false;
        child.server = null;
        child.kill = () => {
            child.killed = true;
            const done = () => child.emit('close', null, 'SIGTERM');
            if (child.server) child.server.close(done); else setImmediate(done);
        };
        spawned.push({ port, mode, child });
        setImmediate(async () => {
            if (mode === 'crash-after-ready') {
                child.stdout.emit('data', Buffer.from(`${READY_SIGNAL}\n`));
                setTimeout(() => child.emit('close', 3221226505, null), 5);
                return;
            }
            if (mode === 'never-ready') return;
            try {
                child.server = await listenAsEngine(port);
                child.stdout.emit('data', Buffer.from(`${READY_SIGNAL}\n`));
            } catch (error) {
                child.emit('close', 1, null);
            }
        });
        return child;
    };
    return { spawnProcess, spawned };
}

const quietLog = { warn() {}, log() {} };

test.beforeEach(() => endpoint.resetForTests());

test('默认端口被占用时探测到备用端口', async () => {
    const blocker = await listen(endpoint.DEFAULT_AUDIO_ENGINE_PORT).catch(() => null);
    try {
        const { port, skipped } = await endpoint.findAvailablePort();
        assert.notEqual(port, endpoint.DEFAULT_AUDIO_ENGINE_PORT);
        assert.equal(skipped[0].port, endpoint.DEFAULT_AUDIO_ENGINE_PORT);
        assert.equal((await endpoint.probePort(port)).ok, true);
    } finally {
        if (blocker) await close(blocker);
    }
});

test('被系统预留（EACCES）的端口同样跳过，备用端口在动态端口范围之下', async () => {
    const probe = async (port) => (port === endpoint.DEFAULT_AUDIO_ENGINE_PORT
        ? { ok: false, port, code: 'EACCES' }
        : { ok: true, port });
    const { port, skipped } = await endpoint.findAvailablePort({ probe });
    assert.equal(port, endpoint.FALLBACK_AUDIO_ENGINE_PORTS[0]);
    assert.deepEqual(skipped, [{ port: endpoint.DEFAULT_AUDIO_ENGINE_PORT, code: 'EACCES' }]);
    for (const fallback of endpoint.FALLBACK_AUDIO_ENGINE_PORTS) assert.ok(fallback < 49152);
});

test('候选端口全部不可用时交给系统分配', async () => {
    const probe = async (port) => (port === 0 ? { ok: true, port: 51234 } : { ok: false, port, code: 'EADDRINUSE' });
    const { port } = await endpoint.findAvailablePort({ probe });
    assert.equal(port, 51234);
});

test('引擎带探测到的端口启动，各处地址都指向这个端口', async () => {
    const blocker = await listen(endpoint.DEFAULT_AUDIO_ENGINE_PORT).catch(() => null);
    const fake = createFakeEngine(['ok']);
    try {
        const { port, child } = await launchAudioEngine({ binaryPath: 'audio_server', spawnProcess: fake.spawnProcess, log: quietLog });
        assert.equal(fake.spawned.length, 1);
        assert.equal(fake.spawned[0].port, port);
        if (blocker) assert.notEqual(port, endpoint.DEFAULT_AUDIO_ENGINE_PORT);
        assert.equal(endpoint.getPort(), port);
        assert.equal(endpoint.getBaseUrl(), `http://127.0.0.1:${port}`);
        assert.equal(endpoint.getWebSocketUrl(), `ws://127.0.0.1:${port}/ws`);
        assert.equal(endpoint.getEndpoint().state, 'ready');
        child.kill();
    } finally {
        if (blocker) await close(blocker);
    }
});

test('旧版引擎先报就绪再崩溃时，不当作启动成功，换端口重试', async () => {
    const fake = createFakeEngine(['crash-after-ready', 'ok']);
    const statuses = [];
    endpoint.onStatus((value) => statuses.push(value.state));
    const { port, child, attempts } = await launchAudioEngine({ binaryPath: 'audio_server', spawnProcess: fake.spawnProcess, log: quietLog });
    assert.equal(attempts, 2);
    assert.notEqual(fake.spawned[0].port, fake.spawned[1].port);
    assert.equal(port, fake.spawned[1].port);
    assert.equal(endpoint.getBaseUrl(), `http://127.0.0.1:${port}`);
    assert.deepEqual(statuses, ['starting', 'starting', 'ready']);
    child.kill();
});

test('始终起不来时标记失败并给出可读原因', async () => {
    const fake = createFakeEngine(['crash-after-ready', 'crash-after-ready']);
    await assert.rejects(
        launchAudioEngine({ binaryPath: 'audio_server', spawnProcess: fake.spawnProcess, maxAttempts: 2, log: quietLog }),
        /音频引擎没有启动成功/,
    );
    const status = endpoint.getEndpoint();
    assert.equal(status.state, 'failed');
    assert.match(status.message, /0xC0000409/);
});

test('超时没就绪的进程会被结束，再换端口', async () => {
    const fake = createFakeEngine(['never-ready', 'ok']);
    const { child } = await launchAudioEngine({
        binaryPath: 'audio_server',
        spawnProcess: fake.spawnProcess,
        readyTimeoutMs: 50,
        log: quietLog,
    });
    assert.equal(fake.spawned[0].child.killed, true);
    child.kill();
});

test('使用引擎的地方不再写死 63789', () => {
    const consumers = [
        'main.js',
        'modules/ipc/musicHandlers.js',
        'modules/webdavManager.js',
        'Musicmodules/music-visualizer.js',
    ];
    for (const file of consumers) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const hardcoded = source.split('\n').filter((line) => line.includes('63789') && !line.includes('app.audioEngineWsUrl ||'));
        assert.deepEqual(hardcoded, [], `${file} 里还有写死的 63789`);
    }
    const handlers = fs.readFileSync(path.join(ROOT, 'modules/ipc/musicHandlers.js'), 'utf8');
    const webdav = fs.readFileSync(path.join(ROOT, 'modules/webdavManager.js'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const visualizer = fs.readFileSync(path.join(ROOT, 'Musicmodules/music-visualizer.js'), 'utf8');
    assert.match(handlers, /audioEngineEndpoint\.getBaseUrl\(\)/);
    assert.match(webdav, /audioEngineEndpoint\.getBaseUrl\(\)/);
    assert.match(main, /audioEngineEndpoint\.getBaseUrl\(\)}\/shutdown/);
    assert.match(main, /launchAudioEngine\(/);
    assert.match(visualizer, /new WebSocket\(app\.audioEngineWsUrl/);
});

test('引擎源码在绑定端口之后才打印就绪信号', () => {
    const source = fs.readFileSync(path.join(ROOT, 'rust_audio_engine/src/server.rs'), 'utf8');
    const bindAt = source.indexOf('server.bind(("127.0.0.1", port))');
    const readyAt = source.indexOf('println!("RUST_AUDIO_ENGINE_READY")');
    assert.ok(bindAt > 0 && readyAt > bindAt);
});

test('探测之后端口被别的程序抢走：别的程序在应答也不算引擎就绪', async () => {
    const intruder = await listen(0);
    const stolenPort = intruder.address().port;
    let first = true;
    const stubEndpoint = {
        ...endpoint,
        findAvailablePort: async (options) => {
            if (first) {
                first = false;
                return { port: stolenPort, skipped: [] };
            }
            return endpoint.findAvailablePort(options);
        },
    };
    const fake = createFakeEngine(['crash-after-ready', 'ok']);
    try {
        const { port, child, attempts } = await launchAudioEngine({
            binaryPath: 'audio_server',
            endpoint: stubEndpoint,
            spawnProcess: fake.spawnProcess,
            log: quietLog,
        });
        assert.equal(attempts, 2);
        assert.equal(fake.spawned[0].port, stolenPort);
        assert.notEqual(port, stolenPort);
        assert.equal(endpoint.getBaseUrl(), `http://127.0.0.1:${port}`);
        child.kill();
    } finally {
        await close(intruder);
    }
});

test('waitForEngineResponding 抛错时不会挂起启动重试，超大非引擎响应流立即中止', async () => {
    // 1. 非引擎端口持续吐出超过 64KB 数据时 checkEngineResponds 应立即销毁连接并返回 false
    const flood = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('x'.repeat(70000));
    });
    await new Promise((resolve, reject) => {
        flood.once('error', reject);
        flood.listen({ port: 0, host: '127.0.0.1' }, resolve);
    });
    try {
        const start = Date.now();
        const ok = await endpoint.checkEngineResponds(flood.address().port, { timeoutMs: 2500 });
        assert.equal(ok, false);
        assert.ok(Date.now() - start < 1000, 'oversized non-engine stream aborts promptly instead of waiting for timeout');
    } finally {
        await close(flood);
    }

    // 2. waitForEngineResponding 拒绝时 runAttempt 应捕获并重试，而不是永久挂起
    let verifyCalls = 0;
    const stubEndpoint = {
        ...endpoint,
        waitForEngineResponding: async (...args) => {
            verifyCalls += 1;
            if (verifyCalls === 1) throw new Error('synthetic verify boom');
            return endpoint.waitForEngineResponding(...args);
        },
    };
    const fake = createFakeEngine(['ok', 'ok']);
    const { port, child, attempts } = await launchAudioEngine({
        binaryPath: 'audio_server',
        endpoint: stubEndpoint,
        spawnProcess: fake.spawnProcess,
        log: quietLog,
    });
    assert.equal(attempts, 2);
    assert.equal(verifyCalls, 2);
    assert.equal(endpoint.getPort(), port);
    child.kill();
});

test('checkEngineResponds drains non-200 responses promptly and returns false without hanging', async () => {
    const bad = http.createServer((_req, res) => {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('service unavailable');
    });
    await new Promise((resolve, reject) => {
        bad.once('error', reject);
        bad.listen({ port: 0, host: '127.0.0.1' }, resolve);
    });
    try {
        const start = Date.now();
        const ok = await endpoint.checkEngineResponds(bad.address().port, { timeoutMs: 2500 });
        assert.equal(ok, false);
        assert.ok(Date.now() - start < 1000, 'non-200 response settles immediately');
    } finally {
        await close(bad);
    }
});
