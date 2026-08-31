// audit-settings-layout — standing layout probe for the unified settings
// surface (固化自 Phase-3 会话的 tmp-probe 模式).
//
// Boots the real app, opens the global settings modal, walks every section
// and enforces the canonical row contract from
// docs/global-settings-debt-repayment-plan.md §3.3/§4-阶段3:
//   1. flat sections: every visible .vcp-harness-general-row is a DIRECT
//      child of its .settings-section and no row nests inside another row;
//   2. divider probe: the top-border model is global now -- the first
//      visible row starts clean and every later visible row carries exactly
//      one hairline above it (the JS tail marker is deleted);
//   3. alignment probe: every visible row starts at the same content x
//      (single-column rhythm) within a 2px tolerance;
//   4. no <hr> survives the canonical pass.
//
// All eight sections are flattened (Phase 3 complete); FLAT_SECTIONS keeps
// enforcing the flat row contract on every run.
//
// Usage: node scripts/audit-settings-layout.mjs [--shots]

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

// Phase 3 progress: sections whose rows are direct children of the section.
const FLAT_SECTIONS = new Set(['quick-actions', 'advanced-features', 'render-settings', 'server-connection', 'voice-settings', 'selection-assistant', 'user-identity', 'appearance-settings']);

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
    // A closed port keeps the audit offline: no server round-trip can hang it.
    vcpServerUrl: 'http://127.0.0.1:1',
    vcpApiKey: 'layout-audit-key',
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
    console.error('[audit] connected; finding page...');
    let page = null;
    while (Date.now() < deadline) {
        page = (await browser.pages()).find(candidate => candidate.url().includes('main.html')) || null;
        if (page) break;
        await sleep(100);
    }
    assert.ok(page, `Electron main renderer did not appear: ${stderr.value}`);
    console.error('[audit] page found; waiting for renderer ready...');
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    await page.waitForFunction(() => document.documentElement.dataset.uiMode === 'next', { timeout: timeoutMs });
    console.error('[audit] renderer ready; opening settings modal...');
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    console.error('[audit] modal opened; waiting for typed revision...');
    await page.waitForFunction(() => {
        const revision = document.getElementById('globalSettingsModal')?.dataset?.vcpSettingsRevision;
        return Boolean(document.getElementById('globalSettingsForm') && Number.isInteger(Number(revision)));
    }, { timeout: timeoutMs });

    console.error('[audit] typed consumer ready; enumerating sections...');
    const sectionKeys = await page.evaluate(() =>
        [...document.querySelectorAll('#globalSettingsForm .settings-section')]
            .map(section => section.dataset.settingsSectionKey || section.id.replace(/^section-/, '')));

    const violations = [];
    const report = [];
    console.error('[audit] sections:', sectionKeys.join(', '));
    for (const key of sectionKeys) {
        await page.evaluate(sectionKey => {
            document.querySelector(`.vcp-harness-settings-nav-cell[data-section="${sectionKey}"]`)
                ?.click();
        }, key);
        await page.waitForFunction(sectionKey => document
            .querySelector(`#globalSettingsForm #section-${sectionKey}.active`), { timeout: timeoutMs }, key);
        await sleep(120);

        const audit = await page.evaluate((sectionKey) => {
            const section = document.querySelector(`#globalSettingsForm #section-${sectionKey}`);
            const rowOf = node => node?.closest?.('.vcp-harness-general-row') || null;
            const rows = [...section.querySelectorAll('.vcp-harness-general-row')]
                .filter(row => !row.parentElement.closest('.vcp-harness-general-row'));
            const visibleRows = rows.filter((row) => {
                for (let node = row; node && node !== section; node = node.parentElement) {
                    if (getComputedStyle(node).display === 'none') return false;
                }
                return true;
            });
            const borders = visibleRows.map(row => parseFloat(getComputedStyle(row).borderBottomWidth));
            const topBorders = visibleRows.map(row => parseFloat(getComputedStyle(row).borderTopWidth));
            const lefts = visibleRows.map(row => row.getBoundingClientRect().left);
            // Nested row primitives (stepper/language/font-size) inject their
            // own bottom hairline for standalone hosts; inside a canonical row
            // the row boundary is the only divider. The top-level checks above
            // cannot see these — they were the blind spot behind the partial
            // double hairlines under the two-column stepper row.
            const nestedPrimitiveBorders = [...section.querySelectorAll(
                '.vcp-harness-general-row .vcp-harness-language-row, .vcp-harness-general-row .vcp-harness-numeric-stepper-row, .vcp-harness-general-row .vcp-harness-font-size-row')]
                .map(node => parseFloat(getComputedStyle(node).borderBottomWidth));
            // Adjacent-sibling run: the canonical rows must form one contiguous
            // run among the section's element children (title first is fine).
            const children = [...section.children];
            const rowSet = new Set(rows);
            const rowFlags = children.map(child => rowSet.has(child));
            const firstRowIndex = rowFlags.indexOf(true);
            const lastRowIndex = rowFlags.lastIndexOf(true);
            const contiguous = firstRowIndex >= 0 && rowFlags.slice(firstRowIndex, lastRowIndex + 1).every(Boolean);
            return {
                rowCount: rows.length,
                visibleCount: visibleRows.length,
                nestingViolations: rows
                    .filter(row => row.parentElement !== section)
                    .map(row => `${row.dataset.settingKey || row.id || row.className} > parent ${row.parentElement.className || row.parentElement.tagName}`),
                adjacencyBreaks: contiguous ? [] : ['canonical rows are not a contiguous sibling run'],
                hrCount: section.querySelectorAll('hr').length,
                borders,
                topBorders,
                nestedPrimitiveBorders,
                leftSpread: lefts.length ? Math.max(...lefts) - Math.min(...lefts) : 0,
            };
        }, key);
        report.push({ key, ...audit });

        const flat = FLAT_SECTIONS.has(key);
        if (flat) {
            for (const violation of [...audit.nestingViolations, ...audit.adjacencyBreaks]) {
                violations.push(`[${key}] flattened row contract broken: ${violation}`);
            }
            if (audit.leftSpread > 2) violations.push(`[${key}] row content x spread ${audit.leftSpread.toFixed(1)}px exceeds 2px`);
            // Top-border divider model: no row draws a bottom hairline, the
            // first visible row starts clean and every later visible row
            // carries exactly one hairline above it.
            if (audit.borders.some(width => width !== 0)) {
                violations.push(`[${key}] flat section must use the top-border divider model (bottom widths: ${audit.borders.join(', ')})`);
            }
            if (audit.nestedPrimitiveBorders.some(width => width !== 0)) {
                violations.push(`[${key}] nested row primitives must not draw their own hairline inside a canonical row (bottom widths: ${audit.nestedPrimitiveBorders.join(', ')})`);
            }
            if (audit.topBorders[0] !== 0) violations.push(`[${key}] first visible row must start without a divider (${audit.topBorders[0]})`);
            for (let index = 1; index < audit.topBorders.length; index += 1) {
                if (audit.topBorders[index] !== 1) {
                    violations.push(`[${key}] visible row ${index} misses its top hairline (${audit.topBorders[index]})`);
                    break;
                }
            }
        }
        if (audit.hrCount) violations.push(`[${key}] ${audit.hrCount} <hr> survived the canonical pass`);

        if (wantShots) {
            await fs.mkdir(screenshotsDir, { recursive: true });
            await page.screenshot({ path: path.join(screenshotsDir, `settings-audit-${key}.png`) });
        }
    }

    console.table(report.map(({ key, rowCount, visibleCount, hrCount, topBorders, leftSpread }) => (
        { section: key, rows: rowCount, visible: visibleCount, hr: hrCount, firstTop: topBorders[0] ?? null, leftSpread: Number(leftSpread.toFixed(1)) })));
    if (violations.length) {
        console.error(`Layout audit failed with ${violations.length} violation(s):`);
        for (const violation of violations) console.error(`  - ${violation}`);
        process.exitCode = 1;
    } else {
        console.log(`Layout audit passed across ${sectionKeys.length} sections (flat: ${[...FLAT_SECTIONS].join(', ') || 'none'}).`);
    }
} finally {
    await browser?.close().catch(() => {});
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    await fs.rm(appData, { recursive: true, force: true }).catch(() => {});
}
