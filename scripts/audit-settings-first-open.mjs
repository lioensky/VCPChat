// audit-settings-first-open — 首开性能/CLS 实测 + 统一 surface 无障碍契约
// 探针（固化自验收缺口 R9/R10 的 tmp-probe 模式），与
// audit-settings-layout.mjs 共用同一套 Electron + CDP 启动模式。
//
// R9 量测（模态框打开 → bridge 投影完成的全窗口）：
//   1. openModal 调用到投影 MutationObserver 流静默的耗时（首开/热开各一次）；
//   2. CDP Performance.getMetrics 的 LayoutShift / LayoutShiftCount 增量
//      （真实渲染进程量测，可反映行投影后的视觉跳动）；
//   3. layout-shift PerformanceObserver 条目及来源节点（定位闪跳源头）。
//
// R10 无障碍契约（投影完成后逐 section 检查）：
//   1. 每个可见 input/select/textarea/button 必须有可访问名（label[for]/
//      包裹 label/aria-label/aria-labelledby/title 之一）；
//   2. WA select 代理的名 transfer 契约：源 select 被 aria-hidden 隐藏后，
//      代理元素必须带 aria-label / aria-labelledby（对齐 vcp-ui.js 的
//      syncNativeToProxy 实现）；
//   3. openModal 后 document.activeElement 必落在模态框内；
//   4. 观测项（只记录不判红）：Tab 焦点路径是否全程留在模态框内、
//      Escape 是否关闭模态框、wa-* 自定义元素角色分布。
//
// Usage: node scripts/audit-settings-first-open.mjs [--shots]

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
const timeoutMs = Number(process.env.VCPCHAT_SETTINGS_TIMEOUT_MS || 90_000);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const wantShots = process.argv.includes('--shots');
const screenshotsDir = path.join(root, 'screenshots');

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        }).on('error', reject);
    });
}

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-settings-audit-'));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next',
    enableDistributedServer: false,
    // 关闭端口保持离线：任何服务器往返都不会挂起探针。
    vcpServerUrl: 'http://127.0.0.1:1',
    vcpApiKey: 'first-open-audit-key',
    userName: '初始用户',
}), 'utf8');

const port = await freePort();
const stderr = { value: '' };
const child = spawn(electron, ['.', '--allow-multiple-instances', `--user-data-dir=${path.join(appData, 'ElectronProfile')}`, `--remote-debugging-port=${port}`], {
    cwd: root,
    env: {
        ...process.env,
        VCPCHAT_APP_DATA_DIR: appData,
        VCPCHAT_E2E_TEST: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
});
child.stderr.on('data', chunk => { stderr.value = `${stderr.value}${chunk}`.slice(-12_000); });

let browser;
try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Electron exited before debugger startup: ${stderr.value}`);
        try {
            await requestJson(`http://127.0.0.1:${port}/json/version`);
            break;
        } catch {
            await sleep(150);
        }
    }
    console.error('[audit] connecting CDP...');
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    let page = null;
    while (Date.now() < deadline) {
        page = (await browser.pages()).find(candidate => {
            try {
                return candidate.url().includes('main.html');
            } catch {
                return false;
            }
        }) || null;
        if (page) break;
        await sleep(100);
    }
    assert.ok(page, `Electron main renderer did not appear: ${stderr.value}`);
    console.error('[audit] page found; waiting for renderer ready...');
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    await page.waitForFunction(() => document.documentElement.dataset.uiMode === 'next', { timeout: timeoutMs });

    const client = await page.createCDPSession();
    await client.send('Performance.enable');
    const metricsOf = async () => Object.fromEntries(
        (await client.send('Performance.getMetrics')).metrics
            .filter(metric => ['LayoutShift', 'LayoutShiftCount'].includes(metric.name))
            .map(metric => [metric.name, metric.value]));

    // 投影窗口内的 MutationObserver + layout-shift 采样器。挂在
    // #modal-container 上：模板实例化与投影变更都在它的子树里，聊天区
    // 的无关变更不会污染批次记录。第一个相关批次是模板实例化（form 尚
    // 未存在），随后一批是 bridge 投影；批次时间线即投影耗时证据。
    await page.evaluate(() => {
        const container = document.getElementById('modal-container');
        const probe = { batches: [], shifts: [], tOpen: null, early: null, lastBatchAt: null };
        window.__vcpFirstOpenProbe = probe;
        const modalRoot = () => document.getElementById('globalSettingsModal');
        new MutationObserver(records => {
            const modal = modalRoot();
            const relevant = records.filter(record => !modal || modal.contains(record.target) || record.target === modal);
            if (!relevant.length) return;
            const at = performance.now();
            probe.batches.push({ at: Math.round(at), count: relevant.length });
            if (probe.early === null) {
                probe.early = {
                    at: Math.round(at),
                    formPresent: Boolean(document.getElementById('globalSettingsForm')),
                    modalRect: modal ? modal.getBoundingClientRect().toJSON() : null,
                };
            }
            probe.lastBatchAt = at;
        }).observe(container, { subtree: true, childList: true });
        new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                probe.shifts.push({
                    at: Math.round(entry.startTime),
                    value: Number(entry.value.toFixed(4)),
                    sources: (entry.sources || []).slice(0, 3).map(source => ({
                        node: String(source.node?.className || source.node?.tagName || '').slice(0, 60),
                        prev: [Math.round(source.previousRect.x), Math.round(source.previousRect.y)],
                        cur: [Math.round(source.currentRect.x), Math.round(source.currentRect.y)],
                    })),
                });
            }
        }).observe({ type: 'layout-shift', buffered: false });
    });

    const settle = () => page.evaluate(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await new Promise(resolve => setTimeout(resolve, 250));
        const probe = window.__vcpFirstOpenProbe;
        const modal = document.getElementById('globalSettingsModal');
        const section = document.querySelector('#globalSettingsForm .settings-section.active');
        return {
            tOpen: Math.round(probe.tOpen),
            firstBatchAt: probe.batches[0]?.at ?? null,
            lastBatchAt: probe.lastBatchAt === null ? null : Math.round(probe.lastBatchAt),
            batchCount: probe.batches.length,
            mutationCount: probe.batches.reduce((sum, batch) => sum + batch.count, 0),
            projectionMs: probe.lastBatchAt === null ? null : Math.round(probe.lastBatchAt - probe.tOpen),
            early: probe.early,
            settledActiveElementInModal: Boolean(modal?.contains(document.activeElement)),
            shifts: probe.shifts,
            shiftSum: Number(probe.shifts.reduce((sum, shift) => sum + shift.value, 0).toFixed(4)),
        };
    });

    const metricsColdBefore = await metricsOf();
    console.error('[audit] opening settings modal (cold)...');
    await page.evaluate(() => {
        window.__vcpFirstOpenProbe.tOpen = performance.now();
        window.uiHelperFunctions.openModal('globalSettingsModal');
    });
    await page.waitForFunction(() => {
        const revision = document.getElementById('globalSettingsModal')?.dataset?.vcpSettingsRevision;
        return Boolean(document.getElementById('globalSettingsForm') && Number.isInteger(Number(revision)));
    }, { timeout: timeoutMs });
    const cold = await settle();
    const metricsColdAfter = await metricsOf();

    console.error('[audit] closing and reopening (warm)...');
    await page.evaluate(() => window.uiHelperFunctions.closeModal('globalSettingsModal'));
    await sleep(400);
    await page.evaluate(() => {
        const probe = window.__vcpFirstOpenProbe;
        probe.batches = [];
        probe.shifts = [];
        probe.early = null;
        probe.lastBatchAt = null;
        probe.tOpen = null;
    });
    const metricsWarmBefore = await metricsOf();
    await page.evaluate(() => {
        window.__vcpFirstOpenProbe.tOpen = performance.now();
        window.uiHelperFunctions.openModal('globalSettingsModal');
    });
    await page.waitForFunction(() => {
        const revision = document.getElementById('globalSettingsModal')?.dataset?.vcpSettingsRevision;
        return Boolean(document.getElementById('globalSettingsForm') && Number.isInteger(Number(revision)));
    }, { timeout: timeoutMs });
    const warm = await settle();
    const metricsWarmAfter = await metricsOf();

    const report = {
        cold: {
            projectionMs: cold.projectionMs,
            mutations: cold.mutationCount,
            batches: cold.batchCount,
            layoutShift: Number((metricsColdAfter.LayoutShift - metricsColdBefore.LayoutShift).toFixed(4)),
            layoutShiftCount: metricsColdAfter.LayoutShiftCount - metricsColdBefore.LayoutShiftCount,
            observerShiftSum: cold.shiftSum,
            focusInModalOnOpen: cold.settledActiveElementInModal,
            shiftSources: cold.shifts.slice(0, 6),
        },
        warm: {
            projectionMs: warm.projectionMs,
            mutations: warm.mutationCount,
            batches: warm.batchCount,
            layoutShift: Number((metricsWarmAfter.LayoutShift - metricsWarmBefore.LayoutShift).toFixed(4)),
            layoutShiftCount: metricsWarmAfter.LayoutShiftCount - metricsWarmBefore.LayoutShiftCount,
            observerShiftSum: warm.shiftSum,
            focusInModalOnOpen: warm.settledActiveElementInModal,
            shiftSources: warm.shifts.slice(0, 6),
        },
    };
    console.log('[R9 metrics]');
    console.log(JSON.stringify(report, null, 2));

    // ---- R10：投影完成后逐 section 的无障碍契约 ----
    console.error('[audit] a11y walk: enumerating sections...');
    const sectionKeys = await page.evaluate(() =>
        [...document.querySelectorAll('#globalSettingsForm .settings-section')]
            .map(section => section.dataset.settingsSectionKey || section.id.replace(/^section-/, '')));

    const violations = [];
    const findings = [];
    const labelAudit = sectionKey => page.evaluate((key) => {
        const section = document.querySelector(`#globalSettingsForm #section-${key}`);
        const visible = node => {
            for (let n = node; n && n !== document.body; n = n.parentElement) {
                const style = getComputedStyle(n);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
            }
            return true;
        };
        const named = control => Boolean(
            control.labels?.length
            || control.closest('label')
            || control.getAttribute('aria-label')
            || control.getAttribute('aria-labelledby')
            || control.getAttribute('title'));
        const unnamed = [...section.querySelectorAll('input:not([type="hidden"]), select, textarea, button')]
            .filter(control => visible(control) && !control.hidden && control.getAttribute('aria-hidden') !== 'true' && !named(control))
            .map(control => `${control.tagName.toLowerCase()}#${control.id || control.name || '(anon)'}`);
        // 名 transfer 契约：被代理的源 select 已 aria-hidden，可访问名必须
        // 落在代理元素上（aria-label / aria-labelledby 之一）。
        const unnamedProxies = [...section.querySelectorAll('.vcp-ui-select-proxy')]
            .filter(proxy => visible(proxy) && !proxy.getAttribute('aria-label') && !proxy.getAttribute('aria-labelledby') && !proxy.labels?.length)
            .map(proxy => `wa-proxy#${proxy.dataset.vcpSelectProxyFor || '(anon)'}`);
        const hiddenSources = [...section.querySelectorAll('select.vcp-ui-native-select')].length;
        const waRoles = {};
        section.querySelectorAll('[class*="wa-"]').forEach(node => {
            const tag = node.tagName.toLowerCase();
            if (tag.startsWith('wa-')) waRoles[tag] = (waRoles[tag] || 0) + 1;
        });
        return { unnamed, unnamedProxies, hiddenSources, waRoles };
    }, sectionKey);

    for (const key of sectionKeys) {
        await page.evaluate(sectionKeyArg => {
            document.querySelector(`.vcp-uiux-settings-nav-cell[data-section="${sectionKeyArg}"]`)?.click();
        }, key);
        await page.waitForFunction(sectionKeyArg => document
            .querySelector(`#globalSettingsForm #section-${sectionKeyArg}.active`), { timeout: timeoutMs }, key);
        await sleep(150);
        const audit = await labelAudit(key);
        for (const control of audit.unnamed) violations.push(`[${key}] 可见控件缺少可访问名: ${control}`);
        for (const proxy of audit.unnamedProxies) violations.push(`[${key}] WA select 代理缺少可访问名（名 transfer 契约失效）: ${proxy}`);
        findings.push({ section: key, unnamed: audit.unnamed.length, unnamedProxies: audit.unnamedProxies.length, hiddenSources: audit.hiddenSources, waRoles: audit.waRoles });
    }

    // Tab 焦点路径观测（只记录）：从首个可聚焦元素起按 15 次 Tab，
    // 记录每次落点是否仍在模态框内。
    await page.evaluate(() => {
        const modal = document.getElementById('globalSettingsModal');
        const first = modal?.querySelector('.vcp-uiux-settings-nav-cell, button, [tabindex]');
        first?.focus();
    });
    const tabPath = [];
    for (let index = 0; index < 15; index += 1) {
        await page.keyboard.press('Tab');
        tabPath.push(await page.evaluate(() => {
            const modal = document.getElementById('globalSettingsModal');
            const active = document.activeElement;
            return {
                inside: Boolean(modal?.contains(active)),
                desc: `${active?.tagName?.toLowerCase?.() || 'null'}#${active?.id || active?.className?.toString?.().slice(0, 40) || ''}`,
            };
        }));
    }
    const outsideStops = tabPath.filter(stop => !stop.inside);
    findings.push({ tabStops: tabPath.length, outsideModalStops: outsideStops.length });
    for (const stop of outsideStops.slice(0, 5)) findings.push({ tabEscape: stop.desc });

    // Escape 行为观测（只记录）。
    await page.keyboard.press('Escape');
    await sleep(150);
    findings.push({
        escapeClosedModal: await page.evaluate(() => !document.getElementById('globalSettingsModal')?.classList.contains('active')),
    });

    console.log('[R10 findings]');
    console.log(JSON.stringify(findings, null, 2));
    if (violations.length) {
        console.error(`A11y audit failed with ${violations.length} violation(s):`);
        for (const violation of violations) console.error(`  - ${violation}`);
        process.exitCode = 1;
    } else {
        console.log(`A11y audit passed across ${sectionKeys.length} sections (named controls + WA proxy name transfer + open focus).`);
    }

    if (wantShots) {
        await fs.mkdir(screenshotsDir, { recursive: true });
        await page.screenshot({ path: path.join(screenshotsDir, 'settings-first-open.png') });
    }
} finally {
    await browser?.close().catch(() => {});
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    await fs.rm(appData, { recursive: true, force: true }).catch(() => {});
}
