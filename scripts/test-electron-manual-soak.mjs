// Interactive manual-soak harness for vD7 evidence.
// This tool observes a real Electron renderer but never marks the product as
// passed: an operator must record the checklist result after the session.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.platform === 'darwin'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const minutes = positiveNumber(process.env.VCPCHAT_MANUAL_SOAK_MINUTES, 30);
const intervalMs = positiveNumber(process.env.VCPCHAT_MANUAL_SOAK_INTERVAL_SECONDS, 60) * 1000;
const timeoutMs = 90_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function removeTempDir(directory) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
            await fs.rm(directory, { recursive: true, force: true });
            return;
        } catch (error) {
            if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || attempt === 7) return;
            await sleep(250 * (attempt + 1));
        }
    }
}

function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

function requestJson(url) {
    return new Promise((resolve, reject) => http.get(url, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    }).on('error', reject));
}

async function waitForPage(browser) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const page = (await browser.pages()).find(candidate => !candidate.isClosed() && candidate.url().includes('main.html'));
        if (page) return page;
        await sleep(150);
    }
    throw new Error('main renderer did not appear');
}

async function waitForChildExit(child, waitMs = 3_000) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise(resolve => {
        const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, waitMs);
        const onExit = () => { clearTimeout(timer); resolve(true); };
        child.once('exit', onExit);
    });
}

async function terminateChildTree(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
        await new Promise(resolve => {
            const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true, stdio: 'ignore',
            });
            killer.once('error', resolve);
            killer.once('exit', resolve);
        });
        await waitForChildExit(child);
        return;
    }
    child.kill('SIGTERM');
    if (!await waitForChildExit(child)) {
        child.kill('SIGKILL');
        await waitForChildExit(child);
    }
}

async function snapshot(page, browserCdp, label, errors) {
    const [state, metrics, processes] = await Promise.all([
        page.evaluate(() => {
            const lifecycle = window.VCPLifecycle?.diagnostics?.summary?.() || {};
            return {
                ready: document.documentElement.dataset.vcpRendererReady || null,
                uiMode: document.documentElement.dataset.uiMode || null,
                connectedElements: document.querySelectorAll('*').length,
                listeners: lifecycle.activeListeners ?? null,
                lifecycleActiveResources: lifecycle.activeResources ?? null,
                lifecycleActiveScopes: lifecycle.activeScopes ?? null,
                detachedRoots: document.querySelectorAll('[data-vcp-detached="true"]').length,
                bodyText: document.body?.innerText?.length || 0,
            };
        }),
        page.metrics().catch(() => ({})),
        browserCdp.send('SystemInfo.getProcessInfo').catch(() => ({ processInfo: [] })),
    ]);
    return {
        label,
        at: new Date().toISOString(),
        state,
        heapUsed: metrics.JSHeapUsedSize ?? null,
        heapTotal: metrics.JSHeapTotalSize ?? null,
        rendererProcesses: (processes.processInfo || []).filter(item => /renderer/i.test(item.type || '')).length,
        errors: errors.slice(-20),
    };
}

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-manual-soak-'));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next', enableDistributedServer: false, vcpServerUrl: 'http://127.0.0.1:1', vcpApiKey: 'manual-soak-key',
}), 'utf8');
const port = await freePort();
const stderr = [];
const child = spawn(electron, ['.', '--allow-multiple-instances', `--remote-debugging-port=${port}`], {
    cwd: root, env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
});
child.stderr.on('data', chunk => { stderr.push(String(chunk)); while (stderr.join('').length > 16_000) stderr.shift(); });
let browser;
const errors = [];
const checkpoints = [];
let stopReason = 'duration_elapsed';
let stopRequested = false;
const startedAt = new Date().toISOString();

try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Electron exited during startup (code ${child.exitCode})`);
        try { await requestJson(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(150); }
    }
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    const page = await waitForPage(browser);
    page.on('pageerror', error => errors.push(error?.stack || String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    const browserCdp = await browser.target().createCDPSession();
    checkpoints.push(await snapshot(page, browserCdp, 'baseline', errors));
    console.log(`Manual soak started for ${minutes} minute(s). Type finish, fail, or abort and press Enter.`);
    console.log('Checklist: send/stream/cancel/retry; history/topic switch; attachments; theme; notifications/desktop push; VoiceChat; Rust Assistant; reload/crash recovery; Classic pages/plugin protocol.');
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', input => {
        const command = input.trim().toLowerCase();
        if (['finish', 'fail', 'abort'].includes(command)) { stopRequested = true; stopReason = command; }
    });
    const endAt = Date.now() + minutes * 60_000;
    let sample = 0;
    while (!stopRequested && Date.now() < endAt) {
        await sleep(Math.min(intervalMs, Math.max(100, endAt - Date.now())));
        if (stopRequested) break;
        sample += 1;
        checkpoints.push(await snapshot(page, browserCdp, `sample-${sample}`, errors));
        console.log(`Manual soak sample ${sample}: ${JSON.stringify(checkpoints.at(-1))}`);
    }
    if (!stopRequested) stopReason = 'duration_elapsed';
    checkpoints.push(await snapshot(page, browserCdp, 'final', errors));
    await browserCdp.detach().catch(() => {});
} catch (error) {
    stopReason = 'harness_error';
    errors.push(error?.stack || String(error));
    console.error(error?.stack || error);
} finally {
    try { browser?.disconnect(); } catch { /* Electron may already be gone. */ }
    await terminateChildTree(child);
    await removeTempDir(appData);
}

const artifact = {
    schemaVersion: 1,
    status: 'manual_observation_required',
    startedAt,
    endedAt: new Date().toISOString(),
    requestedMinutes: minutes,
    intervalSeconds: intervalMs / 1000,
    stopReason,
    host: { platform: process.platform, arch: process.arch, hostname: os.hostname(), node: process.version },
    checklist: [
        'main chat send/stream/cancel/retry', 'history and topic switching', 'attachments', 'theme',
        'notifications and desktop push', 'VoiceChat', 'Rust Assistant', 'renderer reload/crash recovery',
        'Classic child pages and plugin protocol', 'observe detached roots/listeners/heap/errors throughout the session',
    ].map(item => ({ item, observed: null, notes: '' })),
    checkpoints,
    electronStderrTail: stderr.join('').slice(-16_000),
    errors,
    operatorNote: 'This artifact is an observation log, not a pass result. A human must review every checklist item and record pass/fail separately.',
};
const artifactDir = path.join(root, 'artifacts', 'manual-soak');
await fs.mkdir(artifactDir, { recursive: true });
const artifactPath = path.join(artifactDir, `${startedAt.replace(/[:.]/g, '-')}.json`);
await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`Manual soak observation written to ${artifactPath}`);
console.log('No automatic pass is emitted; review and complete the checklist manually.');
