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
const debugDetached = ['1', 'verbose'].includes(process.env.VCPCHAT_STRESS_DEBUG_DETACHED);
const verboseDetached = process.env.VCPCHAT_STRESS_DEBUG_DETACHED === 'verbose';
const skipDestructivePreflight = process.env.VCPCHAT_STRESS_SKIP_PREFLIGHT === '1';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function rememberRendererNode(page, label, selector) {
    if (!debugDetached) return;
    await page.evaluate(({ probeLabel, probeSelector }) => {
        const node = document.querySelector(probeSelector);
        if (!node || typeof WeakRef !== 'function') return;
        window.__vcpStressWeakNodes ||= [];
        window.__vcpStressWeakNodes.push({
            label: probeLabel,
            cycle: Number(window.__vcpStressCycle || 0),
            ref: new WeakRef(node),
        });
    }, { probeLabel: label, probeSelector: selector });
}

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
            dynamicTabs: document.querySelectorAll('#nextUiDynamicTabs > .next-ui-tab').length,
            internalViews: document.querySelectorAll('#nextUiInternalAppHost > .next-ui-internal-app-view').length,
            globalSettingsActive: document.getElementById('globalSettingsModal')?.classList.contains('active') === true,
            transientLifecycleScopes: (window.VCPLifecycle?.diagnostics?.snapshot?.() || [])
                .filter(scope => /next:(?:ask-nova-modal|appearance-studio-open|create-item-modal|internal-app|embedded-app)(?=$|:)/.test(scope.label))
                .map(scope => scope.label),
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
    assert.equal(state.dynamicTabs, 0, `${label}: closed Next tabs remained connected: ${JSON.stringify(state)}`);
    assert.equal(state.internalViews, 0, `${label}: closed Next app views remained connected: ${JSON.stringify(state)}`);
    assert.equal(state.globalSettingsActive, false, `${label}: settings modal remained active: ${JSON.stringify(state)}`);
    assert.deepEqual(state.transientLifecycleScopes, [], `${label}: transient Next lifecycle owners survived close: ${JSON.stringify(state)}`);
    assert.ok(state.bodyText > 20, `${label}: renderer became visually empty: ${JSON.stringify(state)}`);
}

async function assertClassicSurface(page, browser, label) {
    assert.equal(page.isClosed(), false, `${label}: main renderer was closed`);
    const mainPages = (await browser.pages()).filter(candidate => !candidate.isClosed() && candidate.url().includes('main.html'));
    assert.equal(mainPages.length, 1, `${label}: expected exactly one main renderer, found ${mainPages.length}`);
    const state = await page.evaluate(() => {
        const visible = selector => {
            const element = document.querySelector(selector);
            if (!element?.isConnected) return false;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 40 && rect.height > 30 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        return {
            mode: document.documentElement.dataset.uiMode,
            mounted: window.topTabManager?.isMounted?.() === true,
            container: visible('.container'),
            chat: visible('.main-content'),
            classicHeader: visible('.chat-header'),
            nextTopbar: visible('#nextUiTopbar'),
            dynamicTabs: document.querySelectorAll('#nextUiDynamicTabs > .next-ui-tab').length,
            dynamicLifecycleScopes: (window.VCPLifecycle?.diagnostics?.snapshot?.() || [])
                .filter(scope => /next:(?:tab-host|main-ui-runtime|settings-presentation|ask-nova-modal|appearance-studio-open|create-item-modal|internal-app|embedded-app)(?=$|:)/.test(scope.label))
                .map(scope => scope.label),
            bodyText: document.body?.innerText?.length || 0,
        };
    });
    assert.equal(state.mode, 'classic', `${label}: Classic mode did not apply: ${JSON.stringify(state)}`);
    assert.equal(state.mounted, false, `${label}: Next tab host remained mounted: ${JSON.stringify(state)}`);
    assert.equal(state.container, true, `${label}: application container disappeared: ${JSON.stringify(state)}`);
    assert.equal(state.chat, true, `${label}: Classic chat surface disappeared: ${JSON.stringify(state)}`);
    assert.equal(state.classicHeader, true, `${label}: Classic chat header disappeared: ${JSON.stringify(state)}`);
    assert.equal(state.nextTopbar, false, `${label}: Next top bar remained visible: ${JSON.stringify(state)}`);
    assert.equal(state.dynamicTabs, 0, `${label}: Next tabs survived teardown: ${JSON.stringify(state)}`);
    assert.deepEqual(state.dynamicLifecycleScopes, [], `${label}: dynamic Next lifecycle owners survived Classic teardown: ${JSON.stringify(state)}`);
    assert.ok(state.bodyText > 20, `${label}: renderer became visually empty: ${JSON.stringify(state)}`);
}

async function collectRendererSnapshot(page, cdp, browserCdp, browser, label) {
    // Release any Puppeteer JSHandle wrappers whose promises were intentionally
    // ignored by the scenario before measuring the renderer graph.
    global.gc?.();
    // Chromium releases cross-realm DOM wrappers and custom-element/shadow
    // finalizers over more than one task. A single forced GC can therefore
    // report already-unreachable nodes as a linear leak when several UI
    // cycles run between checkpoints. Settle repeatedly; thresholds below
    // remain unchanged, so genuinely retained nodes still fail the gate.
    for (let pass = 0; pass < 3; pass += 1) {
        await cdp.send('HeapProfiler.collectGarbage');
        // CDP runs in a different realm. A Node-side sleep does not advance
        // renderer microtasks/native DOM finalizers, so explicitly yield one
        // renderer task between collections.
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
        await sleep(25);
    }
    const [heap, dom, detachedResult, metricsResult, processResult, rendererState, pages] = await Promise.all([
        cdp.send('Runtime.getHeapUsage'),
        cdp.send('Memory.getDOMCounters'),
        // Chromium's experimental detached-node inspection command itself
        // retains native DOM wrappers in some releases. Keep it opt-in for
        // diagnosis; normal leak gates rely on heap/DOM slopes and explicit
        // lifecycle ownership instead of perturbing the graph being measured.
        debugDetached
            ? cdp.send('DOM.getDetachedDomNodes').catch(() => ({ detachedNodes: [] }))
            : Promise.resolve({ detachedNodes: [] }),
        page.metrics(),
        browserCdp.send('SystemInfo.getProcessInfo'),
        page.evaluate(() => ({
            enhancedSettingsControls: window.VCPUISettingsBridge?.enhancedCount || 0,
            promptNodes: document.querySelectorAll('#systemPromptContainer *').length,
            lifecycle: window.VCPLifecycle?.diagnostics?.summary?.() || null,
            transientLifecycleScopes: (window.VCPLifecycle?.diagnostics?.snapshot?.() || [])
                .filter(scope => /next:(?:ask-nova-modal|appearance-studio-open|create-item-modal|internal-app|embedded-app)(?=$|:)/.test(scope.label))
                .map(scope => scope.label),
            staleWeakNodes: (window.__vcpStressWeakNodes || [])
                .filter(entry => Number(entry.cycle || 0) <= Number(window.__vcpStressCycle || 0) - 2)
                .filter(entry => Boolean(entry.ref.deref()))
                .map(entry => `${entry.cycle}:${entry.label}`),
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
        detachedVcpIcons: detachedSignatures.filter(signature => signature === 'SPAN.vcp-ui-icon').length,
        detachedOptions: detachedSignatures.filter(signature => signature === 'OPTION').length,
        detachedSignatures: detachedSignatures.slice(0, 12),
        detachedKinds,
        lifecycleActiveScopes: rendererState.lifecycle?.activeScopes ?? 0,
        lifecycleActiveResources: rendererState.lifecycle?.activeResources ?? 0,
        lifecycleResourcesByType: rendererState.lifecycle?.resourcesByType || {},
        ...rendererState,
    };
}

async function collectDetachedDiagnostic(cdp, label, page = null) {
    if (!debugDetached || !cdp) return;
    await cdp.send('HeapProfiler.collectGarbage');
    await sleep(50);
    const [result, counters] = await Promise.all([
        cdp.send('DOM.getDetachedDomNodes').catch(() => ({ detachedNodes: [] })),
        cdp.send('Memory.getDOMCounters').catch(() => null),
    ]);
    const entries = (result.detachedNodes || []).map(entry => {
        const node = entry.treeNode || entry.node || {};
        const attributes = Object.fromEntries(Array.from({ length: Math.floor((node.attributes || []).length / 2) }, (_unused, index) => [
            node.attributes[index * 2], node.attributes[index * 2 + 1]
        ]));
        return {
            nodeName: node.nodeName,
            backendNodeId: node.backendNodeId,
            id: attributes.id,
            class: attributes.class,
            retainedNodeIds: entry.retainedNodeIds || [],
        };
    });
    const groups = Object.entries(entries.reduce((counts, entry) => {
        const key = `${entry.nodeName || 'unknown'}${entry.id ? `#${entry.id}` : ''}${entry.class ? `.${entry.class}` : ''}`;
        counts[key] = (counts[key] || 0) + 1;
        return counts;
    }, {})).sort((left, right) => right[1] - left[1]);
    const ownership = verboseDetached && page
        ? await page.evaluate(async () => ({
            renderer: window.VCPLifecycleInspector?.snapshot?.() || null,
            main: await window.VCPLifecycleInspector?.snapshotMain?.().catch?.(() => null),
            weakNodes: (window.__vcpStressWeakNodes || []).map(entry => ({
                label: entry.label,
                alive: Boolean(entry.ref.deref()),
            })),
        })).catch(() => null)
        : null;
    console.log(`Detached diagnostic: ${JSON.stringify({
        label,
        count: entries.length,
        counters,
        groups,
        ...(verboseDetached ? { entries, ownership } : {})
    })}`);
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
    const listenerAllowance = Math.max(40, baseline.listeners * 0.08);

    assert.ok(final.heapUsed <= baseline.heapUsed + heapAllowance,
        `renderer heap retained too much memory: ${formatBytes(baseline.heapUsed)} -> ${formatBytes(final.heapUsed)}`);
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
    assert.ok(final.detachedVcpIcons <= baseline.detachedVcpIcons,
        `detached VCP icon hosts accumulated: ${baseline.detachedVcpIcons} -> ${final.detachedVcpIcons}`);
    assert.ok(final.detachedOptions <= baseline.detachedOptions,
        `detached Select options accumulated: ${baseline.detachedOptions} -> ${final.detachedOptions}`);
    assert.equal(final.lifecycleActiveScopes, baseline.lifecycleActiveScopes,
        `owned lifecycle scopes accumulated: ${baseline.lifecycleActiveScopes} -> ${final.lifecycleActiveScopes}`);
    assert.equal(final.lifecycleActiveResources, baseline.lifecycleActiveResources,
        `owned lifecycle resources accumulated: ${baseline.lifecycleActiveResources} -> ${final.lifecycleActiveResources}`);
    assert.deepEqual(final.transientLifecycleScopes, [],
        `transient Next scopes survived their surface: ${JSON.stringify(final.transientLifecycleScopes)}`);

    // Absolute ceilings catch large one-off retention. Positive slopes catch a
    // smaller leak that grows at every checkpoint but still fits the ceiling.
    const heapSlope = regressionSlope(checkpoints.map(point => point.heapUsed));
    const listenerSlope = regressionSlope(checkpoints.map(point => point.listeners));
    assert.ok(heapSlope < 3 * 1024 * 1024,
        `renderer heap shows sustained checkpoint growth (${formatBytes(heapSlope)} per checkpoint)`);
    assert.ok(listenerSlope < 12, `listeners show sustained checkpoint growth (${listenerSlope.toFixed(0)} per checkpoint)`);
}

async function cycleAskNova(page, target, label) {
    await page.evaluate(async targetId => {
        await window.askNovaController.open(targetId);
        return true;
    }, target);
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
    await rememberRendererNode(page, 'ask-nova', '.ask-nova-modal-host');
    await page.evaluate(() => {
        const root = document.querySelector('.ask-nova-modal-host');
        const target = root?.contains(document.activeElement) ? document.activeElement : root;
        target?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
        }));
    });
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

async function cycleAgentSettings(page, label, { expectEnhanced = true } = {}) {
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
    if (expectEnhanced) {
        // MutationObserver -> queueMicrotask is the bridge's documented
        // enhancement boundary. Yield once, then report the complete kernel
        // distribution in the assertion below instead of hiding a mismatch
        // behind a long generic wait timeout.
        await sleep(100);
    }
    const state = await page.evaluate(() => ({
        promptNodes: document.querySelectorAll('#systemPromptContainer *').length,
        enhanced: window.VCPUISettingsBridge?.enhancedCount || 0,
        settingsPresentation: document.getElementById('tabContentSettings')?.dataset.settingsPresentation || 'next',
        settingsSelects: document.querySelectorAll('#agentSettingsForm select').length,
        controlledSettingsSelects: [...document.querySelectorAll('#agentSettingsForm select')]
            .filter(select => Boolean(window.VCPUI?.getController?.(select))).length,
        nativeSettingsSelects: [...document.querySelectorAll('#agentSettingsForm select')]
            .filter(select => window.VCPUI?.getController?.(select)?.kernel === 'native').length,
        settingsSelectProxies: document.querySelectorAll('#agentSettingsForm .vcp-ui-select-proxy').length,
    }));
    assert.ok(state.promptNodes > 0, `${label}: agent settings prompt editor disappeared: ${JSON.stringify(state)}`);
    if (expectEnhanced) {
        assert.ok(state.enhanced > 0, `${label}: agent settings adapters disappeared: ${JSON.stringify(state)}`);
        if (state.settingsPresentation === 'classic') {
            assert.equal(state.controlledSettingsSelects, 0,
                `${label}: VCPUI crossed the Classic settings presentation boundary: ${JSON.stringify(state)}`);
        } else {
            assert.equal(state.nativeSettingsSelects, state.settingsSelects,
                `${label}: document-wide Select observer captured a settings control: ${JSON.stringify(state)}`);
        }
        assert.equal(state.settingsSelectProxies, 0,
            `${label}: settings form retained Web Awesome Select proxies: ${JSON.stringify(state)}`);
    } else {
        assert.equal(state.enhanced, 0, `${label}: Next settings adapters leaked into Classic: ${JSON.stringify(state)}`);
    }
    await page.evaluate(() => window.uiManager.switchToTab('agents'));
    assert.equal(page.isClosed(), false, `${label}: agent settings transition closed the main renderer`);
}

async function cycleEmbeddedEscape(page, browser, app, label) {
    await page.evaluate(appDefinition => window.topTabManager.openEmbeddedApp(appDefinition), app);
    const childPage = await waitForPage(browser, candidate => candidate.url().includes(app.key), `${label}: ${app.name}`);
    await childPage.waitForFunction(() => document.readyState === 'complete', { timeout: timeoutMs });
    await rememberRendererNode(page, `embedded-tab:${app.id}`, `[data-view-id="app:${app.id}"]`);
    await rememberRendererNode(page, `embedded-view:${app.id}`, `[data-app-id="${app.id}"]`);
    await pressEscapeAllowingTargetClose(childPage);
    await waitForPageGone(browser, candidate => candidate.url().includes(app.key), `${label}: ${app.name}`);
    await page.waitForFunction(viewId => !document.querySelector(`[data-view-id="${viewId}"]`), { timeout: timeoutMs }, `app:${app.id}`);
    assert.equal(page.isClosed(), false, `${label}: embedded Escape cascaded into the main renderer`);
}

async function cycleAskNovaOverEmbedded(page, browser, app, target, label) {
    await page.evaluate(appDefinition => window.topTabManager.openEmbeddedApp(appDefinition), app);
    const childPage = await waitForPage(browser, candidate => candidate.url().includes(app.key), `${label}: embedded ${app.name}`);
    await childPage.waitForFunction(() => document.readyState === 'complete', { timeout: timeoutMs });
    await page.evaluate(async targetId => {
        await window.askNovaController.open(targetId);
        return true;
    }, target);
    await page.waitForFunction(() => {
        const host = document.querySelector('.ask-nova-modal-host');
        const rect = host?.getBoundingClientRect();
        return rect?.width >= window.innerWidth * 0.9 && rect?.height >= window.innerHeight * 0.9;
    }, { timeout: timeoutMs });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.ask-nova-modal-host'), { timeout: timeoutMs });
    assert.equal(childPage.isClosed(), false, `${label}: closing Ask Nova destroyed the covered embedded app`);
    await rememberRendererNode(page, `covered-tab:${app.id}`, `[data-view-id="app:${app.id}"]`);
    await rememberRendererNode(page, `covered-view:${app.id}`, `[data-app-id="${app.id}"]`);
    await page.evaluate(viewId => window.topTabManager.closeView(viewId), `app:${app.id}`);
    await waitForPageGone(browser, candidate => candidate.url().includes(app.key), `${label}: embedded ${app.name}`);
    await page.evaluate(() => window.topTabManager.setView('home'));
}

async function waitForEmbeddedActivation(page, expectedAction, label) {
    await page.waitForFunction(async expected => {
        const state = await window.chatAPI?.desktopListEmbeddedVchatApps?.();
        return state?.activeAction === expected;
    }, { timeout: timeoutMs }, expectedAction);
    const state = await page.evaluate(() => window.chatAPI.desktopListEmbeddedVchatApps());
    assert.equal(state.activeAction, expectedAction, `${label}: unexpected native overlay state: ${JSON.stringify(state)}`);
}

async function cycleOverlayOwnership(page, browser, app, label) {
    const catalogApp = await page.evaluate(action => (
        window.trayManager?.getApps?.().find(candidate => candidate.action === action) || null
    ), app.action);
    assert.ok(catalogApp?.id, `${label}: ${app.name} is missing from the shared App Catalog`);
    const isEmbedded = candidate => {
        if (!candidate.url().includes(app.key)) return false;
        try { return new URL(candidate.url()).searchParams.get('vcpEmbedded') === '1'; } catch { return false; }
    };

    await page.evaluate(appDefinition => window.topTabManager.openEmbeddedApp(appDefinition), catalogApp);
    await waitForPage(browser, isEmbedded, `${label}: overlay fixture ${app.name}`);
    await waitForEmbeddedActivation(page, app.action, `${label}: initial embedded app`);

    await page.evaluate(() => document.getElementById('appTraySettingsBtn')?.click());
    await page.waitForFunction(() => document.getElementById('appTraySettingsModal')?.classList.contains('active'), { timeout: timeoutMs });
    await waitForEmbeddedActivation(page, null, `${label}: app tray settings overlay`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('appTraySettingsModal'), { timeout: timeoutMs });
    await waitForEmbeddedActivation(page, app.action, `${label}: app tray settings close`);

    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout: timeoutMs });
    await waitForEmbeddedActivation(page, null, `${label}: global settings overlay`);
    await page.evaluate(() => window.uiHelperFunctions.closeModal('globalSettingsModal'));
    await page.waitForFunction(() => !document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout: timeoutMs });
    await waitForEmbeddedActivation(page, app.action, `${label}: global settings close`);

    await page.evaluate(() => document.getElementById('nextUiNotificationMenuBtn').click());
    await page.waitForFunction(() => !document.getElementById('nextUiNotificationMenu')?.hidden, { timeout: timeoutMs });
    await page.evaluate(() => window.topTabManager.openAccountMenu());
    await page.waitForFunction(() => !document.getElementById('nextUiAccountMenu')?.hidden, { timeout: timeoutMs });
    await page.evaluate(() => window.VCPAppearanceStudio.open());
    await page.waitForFunction(() => window.VCPAppearanceStudio.isOpen(), { timeout: timeoutMs });
    const transientMenus = await page.evaluate(() => ({
        notificationsHidden: document.getElementById('nextUiNotificationMenu')?.hidden,
        accountHidden: document.getElementById('nextUiAccountMenu')?.hidden,
    }));
    assert.deepEqual(transientMenus, { notificationsHidden: true, accountHidden: true },
        `${label}: opening an overlay retained a lower transient menu`);
    await waitForEmbeddedActivation(page, null, `${label}: Appearance Studio overlay`);
    await page.evaluate(() => {
        const range = document.querySelector('.vcp-appearance-studio-overlay input[data-appearance-key="sidebarRowHeight"]');
        range.value = String(Math.min(Number(range.max), Number(range.value) + 1));
        range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => {
        const root = document.querySelector('.vcp-appearance-studio-overlay');
        const target = root?.contains(document.activeElement) ? document.activeElement : root;
        target?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
        }));
    });
    await page.waitForFunction(() => {
        const prompt = document.querySelector('.vcp-appearance-unsaved-backdrop');
        return window.VCPAppearanceStudio.isOpen() && prompt && !prompt.hidden;
    }, { timeout: timeoutMs });
    await waitForEmbeddedActivation(page, null, `${label}: Appearance unsaved prompt`);
    await page.click('[data-unsaved-action="discard"]');
    await page.waitForFunction(() => !window.VCPAppearanceStudio.isOpen(), { timeout: timeoutMs });
    await waitForEmbeddedActivation(page, app.action, `${label}: Appearance Studio close`);

    await page.evaluate(viewId => window.topTabManager.closeView(viewId), `app:${catalogApp.id}`);
    await waitForPageGone(browser, isEmbedded, `${label}: overlay fixture ${app.name}`);
    await page.evaluate(() => window.topTabManager.setView('home'));
}

async function cycleDetachedApp(page, browser, app, label) {
    const isEmbedded = candidate => {
        if (!candidate.url().includes(app.key)) return false;
        try { return new URL(candidate.url()).searchParams.get('vcpEmbedded') === '1'; } catch { return false; }
    };
    const isStandalone = candidate => candidate.url().includes(app.key) && !isEmbedded(candidate);

    await page.evaluate(appDefinition => window.topTabManager.openEmbeddedApp(appDefinition), app);
    const embeddedPage = await waitForPage(browser, isEmbedded, `${label}: embedded ${app.name}`);
    await embeddedPage.waitForFunction(() => document.readyState === 'complete', { timeout: timeoutMs });
    await rememberRendererNode(page, `detached-tab:${app.id}`, `[data-view-id="app:${app.id}"]`);
    await rememberRendererNode(page, `detached-view:${app.id}`, `[data-app-id="${app.id}"]`);
    const dragPoints = await page.evaluate(viewId => {
        const tab = document.querySelector(`[data-view-id="${viewId}"]`);
        const strip = document.querySelector('.next-ui-tab-strip');
        if (!tab || !strip) return null;
        const tabRect = tab.getBoundingClientRect();
        const stripRect = strip.getBoundingClientRect();
        return {
            startX: tabRect.left + Math.min(24, tabRect.width / 2),
            startY: tabRect.top + tabRect.height / 2,
            endY: stripRect.bottom + 72,
        };
    }, `app:${app.id}`);
    assert.ok(dragPoints, `${label}: could not resolve detach drag target`);
    await page.mouse.move(dragPoints.startX, dragPoints.startY);
    await page.mouse.down();
    await page.mouse.move(dragPoints.startX, dragPoints.endY, { steps: 4 });
    await page.mouse.up();

    const standalonePage = await waitForPage(browser, isStandalone, `${label}: detached ${app.name}`);
    await standalonePage.waitForFunction(() => document.readyState === 'complete', { timeout: timeoutMs });
    await waitForPageGone(browser, isEmbedded, `${label}: old embedded ${app.name}`);
    await page.waitForFunction(viewId => !document.querySelector(`[data-view-id="${viewId}"]`), { timeout: timeoutMs }, `app:${app.id}`);
    await pressEscapeAllowingTargetClose(standalonePage);
    await waitForPageGone(browser, isStandalone, `${label}: detached ${app.name}`);
    assert.equal(page.isClosed(), false, `${label}: detached app Escape closed the main renderer`);

    await page.evaluate(appDefinition => window.topTabManager.openEmbeddedApp(appDefinition), app);
    await waitForPage(browser, isEmbedded, `${label}: reopened ${app.name}`);
    await page.evaluate(viewId => window.topTabManager.closeView(viewId), `app:${app.id}`);
    await waitForPageGone(browser, isEmbedded, `${label}: reopened ${app.name}`);
    await page.evaluate(() => window.topTabManager.setView('home'));
}

async function cycleRendererReload(page, browser, app, label) {
    const catalogApp = await page.evaluate(action => (
        window.trayManager?.getApps?.().find(candidate => candidate.action === action) || null
    ), app.action);
    assert.ok(catalogApp?.id, `${label}: ${app.name} is missing from the shared App Catalog`);
    const isEmbedded = candidate => {
        if (!candidate.url().includes(app.key)) return false;
        try { return new URL(candidate.url()).searchParams.get('vcpEmbedded') === '1'; } catch { return false; }
    };
    await page.evaluate(appDefinition => window.topTabManager.openEmbeddedApp(appDefinition), catalogApp);
    const childPage = await waitForPage(browser, isEmbedded, `${label}: reload fixture ${app.name}`);
    await childPage.waitForFunction(() => document.readyState === 'complete', { timeout: timeoutMs });
    const storedBeforeReload = await page.evaluate(() => sessionStorage.getItem('vcpchat.nextUi.openTabs.v1'));
    assert.match(storedBeforeReload || '', new RegExp(catalogApp.id), `${label}: open tab was not persisted before renderer reload`);

    await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    await page.waitForFunction(() => window.topTabManager?.isMounted?.() && window.askNovaController, { timeout: timeoutMs });
    // The renderer readiness marker precedes asynchronous reconciliation with
    // Main's native WebContentsView registry. Give that one bounded turn, then
    // inspect the final DOM atomically rather than observing an intermediate
    // tab strip across execution-context replacement.
    await sleep(5_000);
    let restoredTabs = await page.evaluate(() => (
        [...document.querySelectorAll('#nextUiDynamicTabs > .next-ui-tab')]
            .map(tab => tab.dataset.viewId)
    ));
    if (!restoredTabs.includes(`app:${catalogApp.id}`)) {
        // CDP's first main-world task after an Electron reload can run before
        // the queued renderer reconciliation task. Observe once more after
        // yielding instead of treating that intermediate DOM as final.
        await sleep(100);
        restoredTabs = await page.evaluate(() => (
            [...document.querySelectorAll('#nextUiDynamicTabs > .next-ui-tab')]
                .map(tab => tab.dataset.viewId)
        ));
    }
    let restored = restoredTabs.includes(`app:${catalogApp.id}`);
    if (!restored) {
        const restoreState = await page.evaluate(() => ({
            stored: sessionStorage.getItem('vcpchat.nextUi.openTabs.v1'),
            apps: window.trayManager?.getApps?.().map(candidate => ({ id: candidate.id, embed: candidate.embed })),
            tabs: [...document.querySelectorAll('#nextUiDynamicTabs > .next-ui-tab')].map(tab => tab.dataset.viewId),
        }));
        restored = restoreState.tabs.includes(`app:${catalogApp.id}`);
        if (!restored) {
            restoreState.pages = (await browser.pages()).filter(candidate => !candidate.isClosed()).map(candidate => candidate.url());
            restoreState.errors = rendererErrors.slice(-8);
            throw new Error(`${label}: renderer reload did not restore the tab session: ${JSON.stringify(restoreState)}`);
        }
    }
    const embeddedPages = (await browser.pages()).filter(candidate => !candidate.isClosed() && isEmbedded(candidate));
    assert.equal(embeddedPages.length, 1, `${label}: renderer reload duplicated embedded WebContents (${embeddedPages.length})`);
    const restoredSurface = await page.evaluate(() => {
        const host = document.getElementById('nextUiInternalAppHost');
        const topbar = document.getElementById('nextUiTopbar');
        return {
            activeAppId: host?.dataset.activeAppId,
            hostVisible: Boolean(host && !host.hidden && host.getBoundingClientRect().width > 80),
            topbarVisible: Boolean(topbar && getComputedStyle(topbar).display !== 'none'),
        };
    });
    assert.equal(restoredSurface.activeAppId, catalogApp.id, `${label}: renderer reload restored the wrong app: ${JSON.stringify(restoredSurface)}`);
    assert.equal(restoredSurface.hostVisible, true, `${label}: renderer reload left the embedded host hidden: ${JSON.stringify(restoredSurface)}`);
    assert.equal(restoredSurface.topbarVisible, true, `${label}: renderer reload hid the Next top bar: ${JSON.stringify(restoredSurface)}`);

    await page.evaluate(viewId => window.topTabManager.closeView(viewId), `app:${catalogApp.id}`);
    await waitForPageGone(browser, isEmbedded, `${label}: reload fixture ${app.name}`);
    await page.evaluate(() => window.topTabManager.setView('home'));
    await assertMainSurface(page, browser, `${label}: renderer reload cleanup`);
}

async function cycleRendererCrash(page, browser, app, label) {
    const catalogApp = await page.evaluate(action => (
        window.trayManager?.getApps?.().find(candidate => candidate.action === action) || null
    ), app.action);
    assert.ok(catalogApp?.id, `${label}: ${app.name} is missing from the shared App Catalog`);
    const isEmbedded = candidate => {
        if (!candidate.url().includes(app.key)) return false;
        try { return new URL(candidate.url()).searchParams.get('vcpEmbedded') === '1'; } catch { return false; }
    };
    await page.evaluate(appDefinition => window.topTabManager.openEmbeddedApp(appDefinition), catalogApp);
    await waitForPage(browser, isEmbedded, `${label}: crash fixture ${app.name}`);
    await waitForEmbeddedActivation(page, app.action, `${label}: crash fixture activation`);

    const crashSession = await page.createCDPSession();
    try {
        await crashSession.send('Page.crash');
    } catch (error) {
        if (!/Target closed|Session closed|crash/i.test(String(error?.message || error))) throw error;
    }
    try { await crashSession.detach(); } catch { /* the crashed target may already be detached */ }

    const recoveredPage = await waitForPage(browser, candidate => candidate.url().includes('main.html'), `${label}: recovered main renderer`);
    await recoveredPage.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    await recoveredPage.waitForFunction(() => window.topTabManager?.isMounted?.() && window.askNovaController, { timeout: timeoutMs });
    await recoveredPage.waitForFunction(expectedId => (
        document.querySelector(`[data-view-id="app:${expectedId}"]`)
        && document.getElementById('nextUiInternalAppHost')?.dataset.activeAppId === expectedId
    ), { timeout: timeoutMs }, catalogApp.id);
    await waitForEmbeddedActivation(recoveredPage, app.action, `${label}: recovered embedded app`);
    const embeddedPages = (await browser.pages()).filter(candidate => !candidate.isClosed() && isEmbedded(candidate));
    assert.equal(embeddedPages.length, 1, `${label}: crash recovery duplicated embedded WebContents (${embeddedPages.length})`);

    await recoveredPage.evaluate(viewId => window.topTabManager.closeView(viewId), `app:${catalogApp.id}`);
    await waitForPageGone(browser, isEmbedded, `${label}: crash fixture ${app.name}`);
    await recoveredPage.evaluate(() => window.topTabManager.setView('home'));
    await assertMainSurface(recoveredPage, browser, `${label}: crash recovery cleanup`);
    return recoveredPage;
}

async function cycleUiMode(page, browser, label) {
    const before = await page.evaluate(() => {
        window.__vcpCanonicalHost = document.getElementById('nextUiInternalAppHost');
        return {
            scopes: window.VCPLifecycle?.diagnostics?.snapshot?.().length || 0,
            tabs: document.querySelectorAll('#nextUiDynamicTabs > .next-ui-tab').length,
        };
    });
    await page.evaluate(() => window.uiModeManager.applyAsync('classic', { cache: false }));
    await page.waitForFunction(() => (
        document.documentElement.dataset.uiMode === 'next'
        && window.topTabManager?.isMounted?.() === true
    ), { timeout: timeoutMs });
    await page.evaluate(() => window.uiModeManager.applyAsync('next', { cache: false }));
    const after = await page.evaluate(() => {
        const result = {
            sameHost: window.__vcpCanonicalHost === document.getElementById('nextUiInternalAppHost'),
            scopes: window.VCPLifecycle?.diagnostics?.snapshot?.().length || 0,
            tabs: document.querySelectorAll('#nextUiDynamicTabs > .next-ui-tab').length,
        };
        delete window.__vcpCanonicalHost;
        return result;
    });
    assert.equal(after.sameHost, true, `${label}: legacy mode request replaced the canonical host`);
    assert.deepEqual({ scopes: after.scopes, tabs: after.tabs }, before, `${label}: legacy mode request changed owned resources`);
    await assertMainSurface(page, browser, `${label}: canonical mode compatibility`);
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
    let page = await waitForPage(browser, candidate => candidate.url().includes('main.html'), 'main renderer');
    const trackRendererPage = rendererPage => {
        rendererPage.on('pageerror', error => rendererErrors.push(error?.stack || String(error)));
        rendererPage.on('console', message => {
        // Legacy pages may reference optional local assets that are absent in
        // the hermetic test profile. They are network diagnostics, not a
        // renderer exception or a lifecycle failure.
            if (message.type() === 'error'
                && !/Content Security Policy|Fetch API cannot load data:image|Failed to load resource: net::ERR_FILE_NOT_FOUND/i.test(message.text())) {
                rendererErrors.push(message.text());
            }
        });
    };
    trackRendererPage(page);
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    await page.waitForFunction(() => window.topTabManager?.isMounted?.() && window.askNovaController, { timeout: timeoutMs });
    const runCycle = async (cycle, phase) => {
        const label = `${phase} cycle ${cycle + 1}`;
        await page.evaluate(() => {
            window.__vcpStressCycle = Number(window.__vcpStressCycle || 0) + 1;
        });
        await cycleAskNova(page, targets[cycle % targets.length], label);
        await collectDetachedDiagnostic(cdp, `${label}: Ask Nova`, page);
        await cycleSettings(page, label);
        await collectDetachedDiagnostic(cdp, `${label}: global settings`, page);
        await cycleAgentSettings(page, label);
        await collectDetachedDiagnostic(cdp, `${label}: Agent settings`, page);
        if (cycle % 2 === 0) await cycleEmbeddedEscape(page, browser, noteApp, label);
        else await cycleAskNovaOverEmbedded(page, browser, pluginApp, targets[(cycle + 1) % targets.length], label);
        await collectDetachedDiagnostic(cdp, `${label}: embedded overlay`, page);
        if (cycle % 4 === 0) await cycleDetachedApp(page, browser, noteApp, label);
        await collectDetachedDiagnostic(cdp, `${label}: detached app`, page);
        await cycleUiMode(page, browser, label);
        await collectDetachedDiagnostic(cdp, `${label}: mode round-trip`, page);
        await assertMainSurface(page, browser, label);
    };

    if (!skipDestructivePreflight) {
        await cycleRendererReload(page, browser, pluginApp, 'reload preflight');
        await cycleOverlayOwnership(page, browser, pluginApp, 'overlay preflight');
        const pageBeforeCrash = page;
        page = await cycleRendererCrash(page, browser, pluginApp, 'crash preflight');
        if (page !== pageBeforeCrash) trackRendererPage(page);
    }
    cdp = await page.createCDPSession();
    browserCdp = await browser.target().createCDPSession();
    await cdp.send('HeapProfiler.enable');
    await collectDetachedDiagnostic(cdp, 'diagnostic no-op A', page);
    await collectDetachedDiagnostic(cdp, 'diagnostic no-op B', page);
    if (debugDetached) {
        await collectDetachedDiagnostic(cdp, 'Canonical Agent baseline', page);
        for (let diagnosticCycle = 0; diagnosticCycle < 3; diagnosticCycle += 1) {
            await cycleAgentSettings(page, `Canonical Agent diagnostic ${diagnosticCycle + 1}`);
            await collectDetachedDiagnostic(cdp, `Canonical Agent cycle ${diagnosticCycle + 1}`, page);
        }
        await assertMainSurface(page, browser, 'Canonical Agent diagnostic cleanup');
    }
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
        detachedIcons: point.detachedVcpIcons,
        detachedOptions: point.detachedOptions,
        lifecycleScopes: point.lifecycleActiveScopes,
        lifecycleResources: point.lifecycleActiveResources,
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
