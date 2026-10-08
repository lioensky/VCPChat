'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

/** Make a standalone Electron test participate in node --test without loading app in Node. */
function runFromNode(entry) {
    if (process.versions.electron) {
        const data = process.env.VCP_ELECTRON_TEST_DATA;
        const { app } = require('electron');
        assert.ok(data && path.resolve(app.getPath('userData')) === path.resolve(data),
            'Launch this test through node --test so its Electron profile is isolated');
        return false;
    }
    const test = require('node:test');
    test(`${path.basename(entry)} in an isolated Electron window`, { timeout: 110000 }, async t => {
        const data = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-electron-test-'));
        const env = { ...process.env, VCP_ELECTRON_TEST_DATA: data, VCP_ELECTRON_TEST_ENTRY: entry };
        delete env.ELECTRON_RUN_AS_NODE;
        let child;
        const stop = () => {
            if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
            if (process.platform === 'win32') {
                spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            } else child.kill('SIGKILL');
        };
        let timer;
        try {
            let output = '';
            let timedOut = false;
            const result = await new Promise((resolve, reject) => {
                child = spawn(require('electron'), [path.join(__dirname, 'electron-test-main.cjs')], {
                    cwd: path.resolve(__dirname, '../..'), env, windowsHide: true,
                });
                const collect = chunk => { output = (output + chunk).slice(-100000); };
                child.stdout.on('data', collect);
                child.stderr.on('data', collect);
                timer = setTimeout(() => { timedOut = true; stop(); }, 100000);
                t.signal.addEventListener('abort', stop, { once: true });
                child.once('error', reject);
                child.once('close', (code, signal) => resolve({ code, signal }));
            });
            assert.equal(timedOut, false, 'Electron test exceeded its deadline');
            assert.equal(result.signal, null, 'Electron test was terminated');
            assert.equal(result.code, 0, `Electron test failed:\n${output}`);
        } finally {
            clearTimeout(timer);
            t.signal.removeEventListener('abort', stop);
            stop();
            // The only recursive deletion is the fresh directory created by this test.
            const relative = path.relative(os.tmpdir(), data);
            assert.ok(relative.startsWith('vcp-electron-test-') && !relative.includes(path.sep));
            fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });
    return true;
}

async function captureWindow(windowRef, entry) {
    const output = process.env.VCP_ELECTRON_TEST_OUTPUT;
    if (!output) return;
    fs.mkdirSync(output, { recursive: true });
    const image = await windowRef.webContents.capturePage();
    fs.writeFileSync(path.join(output, path.basename(entry) + '.png'), image.toPNG());
}

module.exports = { runFromNode, captureWindow };
