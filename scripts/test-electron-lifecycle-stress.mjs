// Targeted Electron lifecycle stress test.
//
// This intentionally does not duplicate the functional UI parity suite. It
// exercises the failure-prone sequences that previously caused blank panels,
// cascading window closes, retained WebContents and steadily growing renderer
// state. Run with:
//
//   npm run test:electron-lifecycle-stress
//   VCPCHAT_STRESS_CYCLES=40 npm run test:electron-lifecycle-stress

import assert from 'node:assert/strict';
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
const timeoutMs = 90_000;
const cycles = positiveInteger(process.env.VCPCHAT_STRESS_CYCLES, 20);
const warmupCycles = positiveInteger(process.env.VCPCHAT_STRESS_WARMUP, 3);
const checkpointEvery = Math.max(2, positiveInteger(process.env.VCPCHAT_STRESS_CHECKPOINT_EVERY, 5));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        }).on('error', reject);
    });
}

async function waitForPage(browser, predicate, label, deadline = Date.now() + timeoutMs) {
    while (Date.now() < deadline) {
        const found = (await browser.pages()).find(candidate => !candidate.isClosed() && predicate(candidate));
        if (found) return found;
        await sleep(100);
    }
    throw new Error(`${label} did not appear`);
}

async function waitForPageGone(browser, predicate, label, deadline = Date.now() + timeoutMs) {
    while (Date.now() < deadline) {
        const found = (await browser.pages()).find(candidate => !candidate.isClosed() && predicate(candidate));
        if (!found) return;
        await sleep(100);
    }
    throw new Error(`${label} did not close`);
}

async function pressEscapeAllowingTargetClose(page) {
    try {
        await page.keyboard.press('Escape');
    } catch (error) {
        if (!/TargetCloseError|Target closed/i.test(`${error?.name || ''} ${error?.message || ''}`)) throw error;
    }
}

async function assertMainSurface(page, browser, label) {
    assert.equal(page.isClosed(), false, `${label}: main renderer was closed`);
    const mainPages = (await browser.pages()).filter(candidate => !candidate.isClosed() && candidate.url().includes('main.html'));
    assert.equal(mainPages.length, 1, `${label}: expected exactly one main renderer, found ${mainPages.length}`);
    const state = await page.evaluate(() => {
        const visible = selector => {
            const element = document.querySelector(selector);
            if (!element?.isConnected) return false;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 80 && rect.height > 40 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        return {
            ready: document.documentElement.dataset.vcpRendererReady,
            mode: document.documentElement.dataset.uiMode,
            mounted: window.topTabManager?.isMounted?.() === true,
            container: visible('.container'),
            panel: visible('#nextUiMainPanel'),
            chat: visible('.main-content'),
            topbar: visible('#nextUiTopbar'),
            askNovaHosts: document.querySelectorAll('.ask-nova-modal-host').length,
            globalSettingsActive: document.getElementById('globalSettingsModal')?.classList.contains('active') === true,
            bodyText: document.body?.innerText?.length || 0,
        };
    });
    assert.equal(state.ready, 'true', `${label}: renderer readiness marker disappeared: ${JSON.stringify(state)}`);
    assert.equal(state.mode, 'next', `${label}: UI mode changed unexpectedly: ${JSON.stringify(state)}`);
    assert.equal(state.mounted, true, `${label}: Next tab host was unmounted: ${JSON.stringify(state)}`);
    assert.equal(state.container, true, `${label}: application container disappeared: ${JSON.stringify(state)}`);
    assert.equal(state.panel, true, `${label}: main panel disappeared: ${JSON.stringify(state)}`);
    assert.equal(state.chat, true, `${label}: chat surface disappeared: ${JSON.stringify(state)}`);
    assert.equal(state.topbar, true, `${label}: Next top bar disappeared: ${JSON.stringify(state)}`);
    assert.equal(state.askNovaHosts, 0, `${label}: Ask Nova overlay was retained: ${JSON.stringify(state)}`);
    assert.equal(state.globalSettingsActive, false, `${label}: settings modal remained active: ${JSON.stringify(state)}`);
    assert.ok(state.bodyText > 20, `${label}: renderer became visually empty: ${JSON.stringify(state)}`);
}

async function collectRendererSnapshot(page, cdp, browserCdp, browser, label) {
    await cdp.send('HeapProfiler.collectGarbage');
    await sleep(100);
    const [heap, dom, detachedResult, metricsResult, processResult, rendererState, pages] = await Promise.all([
        cdp.send('Runtime.getHeapUsage'),
        cdp.send('Memory.getDOMCounters'),
        cdp.send('DOM.getDetachedDomNodes').catch(() => ({ detachedNodes: [] })),
        page.metrics(),
        browserCdp.send('SystemInfo.getProcessInfo'),
        page.evaluate(() => ({
            enhancedSettingsControls: window.VCPUISettingsBridge?.enhancedCount || 0,
            promptNodes: document.querySelectorAll('#systemPromptContainer *').length,
        })),
        browser.pages(),
    ]);
    const processes = processResult.processInfo || [];
    const rendererProcesses = processes.filter(processInfo => /renderer/i.test(processInfo.type || ''));
    const detachedSignatures = (detachedResult.detachedNodes || []).map(entry => {
        const node = entry.treeNode || entry.node || {};
        const attributes = Object.fromEntries(Array.from({ length: Math.floor((node.attributes || []).length / 2) }, (_unused, index) => [
            node.attributes[index * 2], node.attributes[index * 2 + 1]
        ]));
        return `${node.nodeName || 'unknown'}${attributes.id ? `#${attributes.id}` : ''}${attributes.class ? `.${attributes.class}` : ''}`;
    });
    const detachedKinds = Object.fromEntries(Object.entries(detachedSignatures.reduce((counts, signature) => {
        const kind = signature.split(/[.#]/, 1)[0];
        counts[kind] = (counts[kind] || 0) + 1;
        return counts;
    }, {})).sort((left, right) => right[1] - left[1]).slice(0, 8));
    return {
        label,
        heapUsed: heap.usedSize,
        jsHeapUsed: metricsResult.JSHeapUsedSize,
        documents: dom.documents,
        nodes: dom.nodes,
        listeners: dom.jsEventListeners,
        pages: pages.filter(candidate => !candidate.isClosed()).length,
        processes: processes.length,
        rendererProcesses: rendererProcesses.length,
        detachedRoots: detachedSignatures.length,
        detachedSignatures: detachedSignatures.slice(0, 12),
        detachedKinds,
        ...rendererState,
    };
}

function formatBytes(value) {
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function regressionSlope(values) {
    if (values.length < 2) return 0;
    const xMean = (values.length - 1) / 2;
    const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
    let numerator = 0;
    let denominator = 0;
    values.forEach((value, index) => {
        numerator += (index - xMean) * (value - yMean);
        denominator += (index - xMean) ** 2;
    });
    return denominator ? numerator / denominator : 0;
}

async function waitForChildExit(child, timeout = 3_000) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.off('exit', onExit);
            resolve(value);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeout);
        child.once('exit', onExit);
    });
}

function assertNoSustainedLeak(baseline, checkpoints) {
    const final = checkpoints.at(-1);
    const heapAllowance = Math.max(10 * 1024 * 1024, baseline.heapUsed * 0.4);
    const nodeAllowance = Math.max(800, baseline.nodes * 0.12);
    const listenerAllowance = Math.max(40, baseline.listeners * 0.08);

    assert.ok(final.heapUsed <= baseline.heapUsed + heapAllowance,
        `renderer heap retained too much memory: ${formatBytes(baseline.heapUsed)} -> ${formatBytes(final.heapUsed)}`);
    assert.ok(final.nodes <= baseline.nodes + nodeAllowance,
        `DOM nodes accumulated: ${baseline.nodes} -> ${final.nodes}`);
    assert.ok(final.listeners <= baseline.listeners + listenerAllowance,
        `event listeners accumulated: ${baseline.listeners} -> ${final.listeners}`);
    assert.ok(final.pages <= baseline.pages, `WebContents/pages leaked: ${baseline.pages} -> ${final.pages}`);
    assert.ok(final.processes <= baseline.processes, `Electron processes leaked: ${baseline.processes} -> ${final.processes}`);
    assert.ok(final.rendererProcesses <= baseline.rendererProcesses,
        `renderer processes leaked: ${baseline.rendererProcesses} -> ${final.rendererProcesses}`);
    assert.equal(final.enhancedSettingsControls, baseline.enhancedSettingsControls,
        `VCPUI settings controllers accumulated: ${baseline.enhancedSettingsControls} -> ${final.enhancedSettingsControls}`);
    assert.equal(final.promptNodes, baseline.promptNodes,
        `prompt editor DOM accumulated: ${baseline.promptNodes} -> ${final.promptNodes}`);

    // Absolute ceilings catch large one-off retention. Positive slopes catch a
    // smaller leak that grows at every checkpoint but still fits the ceiling.
    const heapSlope = regressionSlope(checkpoints.map(point => point.heapUsed));
    const nodeSlope = regressionSlope(checkpoints.map(point => point.nodes));
    const listenerSlope = regressionSlope(checkpoints.map(point => point.listeners));
    assert.ok(heapSlope < 3 * 1024 * 1024,
        `renderer heap shows sustained checkpoint growth (${formatBytes(heapSlope)} per checkpoint)`);
    assert.ok(nodeSlope < 250, `DOM nodes show sustained checkpoint growth (${nodeSlope.toFixed(0)} per checkpoint)`);
    assert.ok(listenerSlope < 12, `listeners show sustained checkpoint growth (${listenerSlope.toFixed(0)} per checkpoint)`);
}

async function cycleAskNova(page, target, label) {
    await page.evaluate(targetId => window.askNovaController.open(targetId), target);
    await page.waitForFunction(targetId => {
        const host = document.querySelector('.ask-nova-modal-host');
        const rect = host?.getBoundingClientRect();
        return document.querySelector('.ask-nova-target-tab.active')?.dataset.target === targetId
            && rect?.width >= window.innerWidth * 0.9
            && rect?.height >= window.innerHeight * 0.9;
    }, { timeout: timeoutMs }, target);
    const requestStarted = await page.evaluate(targetId => {
        const textarea = document.querySelector('.ask-nova-composer textarea');
        const form = document.querySelector('.ask-nova-composer');
        if (!textarea || !form) return false;
        textarea.value = `lifecycle cancellation probe for ${targetId}`;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        form.requestSubmit();
        return Boolean(document.querySelector('.ask-nova-thinking'));
    }, target);
    assert.equal(requestStarted, true, `${label}: Ask Nova did not enter its in-flight state`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.ask-nova-modal-host'), { timeout: timeoutMs });
    await page.evaluate(() => window.topTabManager.setView('home'));
    assert.equal(page.isClosed(), false, `${label}: Ask Nova Escape closed the main renderer`);
}

async function cycleSettings(page, label) {
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout: timeoutMs });
    await page.keyboard.press('Escape');
    try {
        await page.waitForFunction(() => !document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout: 2_000 });
    } catch {
        // Some upstream settings flows intentionally reserve Escape. Use the
        // public close path, then still assert that the panel is fully gone.
        await page.evaluate(() => window.uiHelperFunctions.closeModal('globalSettingsModal'));
        await page.waitForFunction(() => !document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout: timeoutMs });
    }
    assert.equal(page.isClosed(), false, `${label}: settings Escape closed the main renderer`);
}

async function cycleAgentSettings(page, label) {
    await page.evaluate(async () => {
        window.topTabManager.setView('home');
        window.uiManager.switchToTab('agents');
        document.querySelector('#agentList [data-item-id="StressAgent"]')?.click();
        window.uiManager.switchToTab('settings');
        await window.settingsManager.displaySettingsForItem();
    });
    await page.waitForFunction(() => {
        const panel = document.getElementById('tabContentSettings');
        return document.getElementById('editingAgentId')?.value === 'StressAgent'
            && panel?.classList.contains('active')
            && panel.getBoundingClientRect().height > 40;
    }, { timeout: timeoutMs });
    const state = await page.evaluate(() => ({
        promptNodes: document.querySelectorAll('#systemPromptContainer *').length,
        enhanced: window.VCPUISettingsBridge?.enhancedCount || 0,
    }));
    assert.ok(state.promptNodes > 0, `${label}: agent settings prompt editor disappeared: ${JSON.stringify(state)}`);
    assert.ok(state.enhanced > 0, `${label}: agent settings adapters disappeared: ${JSON.stringify(state)}`);
    await page.evaluate(() => window.uiManager.switchToTab('agents'));
    assert.equal(page.isClosed(), false, `${label}: agent settings transition closed the main renderer`);
}

async function cycleEmbeddedEscape(page, browser, app, label) {
    await page.evaluate(appDefinition => window.topTabManager.openEmbeddedApp(appDefinition), app);
    const childPage = await waitForPage(browser, candidate => candidate.url().includes(app.key), `${label}: ${app.name}`);
    await childPage.waitForFunction(() => document.readyState === 'complete', { timeout: timeoutMs });
    await pressEscapeAllowingTargetClose(childPage);
    await waitForPageGone(browser, candidate => candidate.url().includes(app.key), `${label}: ${app.name}`);
    await page.waitForFunction(viewId => !document.querySelector(`[data-view-id="${viewId}"]`), { timeout: timeoutMs }, `app:${app.id}`);
    assert.equal(page.isClosed(), false, `${label}: embedded Escape cascaded into the main renderer`);
}

async function cycleAskNovaOverEmbedded(page, browser, app, target, label) {
    await page.evaluate(appDefinition => window.topTabManager.openEmbeddedApp(appDefinition), app);
    const childPage = await waitForPage(browser, candidate => candidate.url().includes(app.key), `${label}: embedded ${app.name}`);
    await childPage.waitForFunction(() => document.readyState === 'complete', { timeout: timeoutMs });
    await page.evaluate(targetId => window.askNovaController.open(targetId), target);
    await page.waitForFunction(() => {
        const host = document.querySelector('.ask-nova-modal-host');
        const rect = host?.getBoundingClientRect();
        return rect?.width >= window.innerWidth * 0.9 && rect?.height >= window.innerHeight * 0.9;
    }, { timeout: timeoutMs });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.ask-nova-modal-host'), { timeout: timeoutMs });
    assert.equal(childPage.isClosed(), false, `${label}: closing Ask Nova destroyed the covered embedded app`);
    await page.evaluate(viewId => window.topTabManager.closeView(viewId), `app:${app.id}`);
    await waitForPageGone(browser, candidate => candidate.url().includes(app.key), `${label}: embedded ${app.name}`);
    await page.evaluate(() => window.topTabManager.setView('home'));
}

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-lifecycle-stress-'));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next',
    enableDistributedServer: false,
    vcpServerUrl: 'http://127.0.0.1:1',
    vcpApiKey: 'lifecycle-stress-key',
}), 'utf8');
const agentDir = path.join(appData, 'Agents', 'StressAgent');
await fs.mkdir(agentDir, { recursive: true });
await fs.writeFile(path.join(agentDir, 'config.json'), JSON.stringify({
    name: 'Stress Agent',
    model: 'stress-model',
    promptMode: 'original',
    originalSystemPrompt: 'Lifecycle stress prompt',
    systemPrompt: 'Lifecycle stress prompt',
    stripRegexes: [],
}), 'utf8');

const noteApp = { id: 'open-note-mini-window', action: 'open-note-mini-window', name: '便签', key: 'notemini.html' };
const pluginApp = { id: 'open-plugin-manager-window', action: 'open-plugin-manager-window', name: '插件管理器', key: 'plugin-manager.html' };
const targets = ['frontend', 'backend', 'fullstack'];
const port = await freePort();
const stderr = { value: '' };
const child = spawn(electron, ['.', '--allow-multiple-instances', `--remote-debugging-port=${port}`], {
    cwd: root,
    env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
});
child.stderr.on('data', chunk => { stderr.value = `${stderr.value}${chunk}`.slice(-16_000); });

let browser;
let cdp;
let browserCdp;
const rendererErrors = [];
const checkpoints = [];
try {
    const startupDeadline = Date.now() + timeoutMs;
    while (Date.now() < startupDeadline) {
        if (child.exitCode !== null) throw new Error(`Electron exited during startup: ${stderr.value}`);
        try {
            await requestJson(`http://127.0.0.1:${port}/json/version`);
            break;
        } catch {
            await sleep(150);
        }
    }
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    const page = await waitForPage(browser, candidate => candidate.url().includes('main.html'), 'main renderer');
    page.on('pageerror', error => rendererErrors.push(error?.stack || String(error)));
    page.on('console', message => {
        // Legacy pages may reference optional local assets that are absent in
        // the hermetic test profile. They are network diagnostics, not a
        // renderer exception or a lifecycle failure.
        if (message.type() === 'error'
            && !/Content Security Policy|Fetch API cannot load data:image|Failed to load resource: net::ERR_FILE_NOT_FOUND/i.test(message.text())) {
            rendererErrors.push(message.text());
        }
    });
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    await page.waitForFunction(() => window.topTabManager?.isMounted?.() && window.askNovaController, { timeout: timeoutMs });
    cdp = await page.createCDPSession();
    browserCdp = await browser.target().createCDPSession();
    await cdp.send('HeapProfiler.enable');

    const runCycle = async (cycle, phase) => {
        const label = `${phase} cycle ${cycle + 1}`;
        await cycleAskNova(page, targets[cycle % targets.length], label);
        await cycleSettings(page, label);
        await cycleAgentSettings(page, label);
        if (cycle % 2 === 0) await cycleEmbeddedEscape(page, browser, noteApp, label);
        else await cycleAskNovaOverEmbedded(page, browser, pluginApp, targets[(cycle + 1) % targets.length], label);
        await assertMainSurface(page, browser, label);
    };

    for (let cycle = 0; cycle < warmupCycles; cycle += 1) await runCycle(cycle, 'warmup');
    const baseline = await collectRendererSnapshot(page, cdp, browserCdp, browser, 'baseline');
    checkpoints.push(baseline);
    console.log(`Lifecycle stress baseline: ${JSON.stringify(baseline)}`);

    for (let cycle = 0; cycle < cycles; cycle += 1) {
        await runCycle(cycle, 'measured');
        if ((cycle + 1) % checkpointEvery === 0 || cycle === cycles - 1) {
            const checkpoint = await collectRendererSnapshot(page, cdp, browserCdp, browser, `cycle-${cycle + 1}`);
            checkpoints.push(checkpoint);
            console.log(`Lifecycle stress checkpoint: ${JSON.stringify(checkpoint)}`);
        }
    }

    await assertMainSurface(page, browser, 'final');
    assertNoSustainedLeak(baseline, checkpoints);
    assert.equal(rendererErrors.length, 0, `renderer errors observed:\n${rendererErrors.slice(0, 12).join('\n')}`);
    console.log(`Electron lifecycle stress passed (${warmupCycles} warmup + ${cycles} measured cycles).`);
    console.table(checkpoints.map(point => ({
        checkpoint: point.label,
        heap: formatBytes(point.heapUsed),
        nodes: point.nodes,
        listeners: point.listeners,
        pages: point.pages,
        processes: point.processes,
        enhanced: point.enhancedSettingsControls,
        promptNodes: point.promptNodes,
        detachedRoots: point.detachedRoots,
    })));
} catch (error) {
    console.error(error?.stack || error);
    if (stderr.value) console.error(`Electron stderr tail:\n${stderr.value}`);
    process.exitCode = 1;
} finally {
    try { await cdp?.detach(); } catch { /* target may already be gone */ }
    try { await browserCdp?.detach(); } catch { /* browser may already be gone */ }
    // Puppeteer Browser.close() maps to closing Electron windows. On macOS the
    // app intentionally remains alive after its last window closes, so using
    // it here would hang the test runner and retain the isolated process tree.
    try { browser?.disconnect(); } catch { /* debugger may already be gone */ }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (!await waitForChildExit(child)) {
        child.kill('SIGKILL');
        await waitForChildExit(child);
    }
    await fs.rm(appData, { recursive: true, force: true });
}
