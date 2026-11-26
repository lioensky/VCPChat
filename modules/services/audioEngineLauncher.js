'use strict';

// 启动音频引擎进程：先探测一个能绑定的端口，再带 --port 启动，等到引擎打印就绪信号
// 并且端口上真的是引擎在应答才算启动成功。某个端口启动失败（被抢占、被预留、进程提前退出）
// 就换下一个端口重试，最终把实际端口写进 audioEngineEndpoint，供各处共用。

const endpointModule = require('./audioEngineEndpoint');

const READY_SIGNAL = 'RUST_AUDIO_ENGINE_READY';

function describeExit(code, signal) {
    if (signal) return `进程被信号 ${signal} 结束`;
    if (code === 0xc0000409 || code === -1073740791) return '进程崩溃（0xC0000409，多半是端口绑定失败）';
    return `进程退出，退出码 ${code}`;
}

// 启动一次：等就绪信号、进程退出或超时三者之一，再确认端口上应答的是这个引擎。
function runAttempt({ child, port, endpoint, readyTimeoutMs, verifyTimeoutMs, onStdout }) {
    return new Promise((resolve) => {
        let settled = false;
        let exited = false;
        let stdoutBuffer = '';
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.stdout?.off?.('data', handleStdout);
            child.off?.('close', handleClose);
            child.off?.('error', handleError);
            resolve(result);
        };
        const handleClose = (code, signal) => {
            exited = true;
            finish({ ok: false, exited: true, reason: describeExit(code, signal) });
        };
        const handleError = (error) => {
            exited = true;
            finish({ ok: false, exited: true, fatal: true, reason: error?.message || String(error) });
        };
        const handleStdout = (data) => {
            const text = data.toString();
            onStdout?.(text);
            stdoutBuffer = (stdoutBuffer + text).slice(-256);
            if (!stdoutBuffer.includes(READY_SIGNAL)) return;
            child.stdout?.off?.('data', handleStdout);
            clearTimeout(timer);
            endpoint.waitForEngineResponding(port, { timeoutMs: verifyTimeoutMs, isAborted: () => exited || settled })
                .then((listening) => {
                    if (listening) finish({ ok: true });
                    else finish({ ok: false, exited, reason: exited ? '报告就绪后立即退出' : `端口 ${port} 上没有引擎应答` });
                });
        };
        const timer = setTimeout(() => finish({ ok: false, exited: false, reason: `${Math.round(readyTimeoutMs / 1000)} 秒内没有就绪` }), readyTimeoutMs);
        child.stdout?.on('data', handleStdout);
        child.once('close', handleClose);
        child.once('error', handleError);
    });
}

async function launchAudioEngine({
    binaryPath,
    spawnProcess,
    endpoint = endpointModule,
    maxAttempts = 3,
    readyTimeoutMs = 10000,
    verifyTimeoutMs = 3000,
    onProcess = () => {},
    onStdout,
    log = console,
} = {}) {
    if (typeof spawnProcess !== 'function') throw new TypeError('spawnProcess is required');
    const failedPorts = [];
    const reasons = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let port;
        try {
            const found = await endpoint.findAvailablePort({ exclude: failedPorts });
            port = found.port;
            if (found.skipped.length > 0) {
                log.warn?.(`[AudioEngine] 端口 ${found.skipped.map(item => `${item.port}(${item.code})`).join(', ')} 不可用，改用 ${port}`);
            }
        } catch (error) {
            reasons.push(error.message);
            break;
        }

        endpoint.markStarting(port);
        const child = spawnProcess(binaryPath, ['--port', String(port)]);
        onProcess(child, port);

        const result = await runAttempt({ child, port, endpoint, readyTimeoutMs, verifyTimeoutMs, onStdout });
        if (result.ok) {
            endpoint.markReady(port);
            return { child, port, attempts: attempt };
        }

        reasons.push(`端口 ${port}：${result.reason}`);
        log.warn?.(`[AudioEngine] 第 ${attempt} 次启动失败，端口 ${port}：${result.reason}`);
        failedPorts.push(port);
        if (!result.exited) {
            try { child.kill(); } catch (_) { /* 已退出 */ }
        }
        if (result.fatal) break; // 可执行文件本身起不来，换端口也没用
    }

    const message = `音频引擎没有启动成功（${reasons.join("；")}）。关掉音乐窗口再打开会重试一次。`;
    endpoint.markFailed(message);
    const error = new Error(message);
    error.code = 'AUDIO_ENGINE_START_FAILED';
    throw error;
}

module.exports = {
    READY_SIGNAL,
    launchAudioEngine,
    describeExit,
};
