import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-dedicated-preload-'));
const env = { ...process.env, VCP_ELECTRON_TEST_DATA: data,
    VCP_ELECTRON_TEST_ENTRY: path.join(root, 'tests/helpers/dedicated-preload-electron.cjs') };
delete env.ELECTRON_RUN_AS_NODE;
let log = '';
const child = spawn(electron, [path.join(root, 'tests/helpers/electron-test-main.cjs')], { cwd: root, env, windowsHide: true });
child.stdout.on('data', chunk => { log += chunk; process.stdout.write(chunk); });
child.stderr.on('data', chunk => { log += chunk; process.stderr.write(chunk); });
let timedOut = false;
const stop = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill();
};
const timer = setTimeout(() => { timedOut = true; stop(); }, 60000);
try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    fs.writeFileSync(path.join(data, 'electron.log'), log);
    assert.equal(timedOut, false, 'isolated Electron verification timed out');
    assert.equal(code, 0, 'isolated Electron process failed; evidence: ' + data);
    const result = JSON.parse(fs.readFileSync(path.join(data, 'verification.json'), 'utf8'));
    assert.equal(result.results.length, 3);
    assert.ok(result.results.every(item => item.exposure && item.invoke && item.payload && item.independentUnsubscribe && item.lateDeliveryRevoked));
    console.log('Evidence: ' + data);
} finally {
    clearTimeout(timer);
    stop();
}
