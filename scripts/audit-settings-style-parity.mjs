// Settings sidebar computed-style parity audit + visual baseline capture.
//
// Boots the real app in Electron via Puppeteer/CDP, opens the Agent and Group
// settings surfaces, dumps computed styles, and (with --shots) archives
// collapsed/expanded screenshots.
//
// Usage:
//   node scripts/audit-settings-style-parity.mjs --out screenshots/refactor-baseline/baseline.json --shots
//   node scripts/audit-settings-style-parity.mjs --out after.json --diff screenshots/refactor-baseline/baseline.json

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronBinary = process.platform === 'darwin'
    ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(repoRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

const args = process.argv.slice(2);
function argValue(name) {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
}
const outFile = path.resolve(argValue('--out') || path.join(repoRoot, 'screenshots', 'refactor-baseline', 'baseline.json'));
const diffAgainst = argValue('--diff');
const wantShots = args.includes('--shots');
const shotsDir = path.resolve(argValue('--shots-dir') || path.join(repoRoot, 'screenshots', 'refactor-baseline'));
const timeoutMs = Number(process.env.VCPCHAT_SETTINGS_TIMEOUT_MS || 90_000);

const OBSERVED_PROPERTIES = [
    'display', 'position', 'visibility', 'opacity', 'pointerEvents',
    'boxSizing', 'width', 'height', 'minHeight', 'maxHeight',
    'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderRadius', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'borderStyle',
    'backgroundColor', 'backgroundImage',
    'color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'whiteSpace',
    'alignItems', 'justifyContent', 'flexDirection', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'justifySelf',
    'gridTemplateColumns', 'gridTemplateRows', 'gridArea', 'gap', 'rowGap', 'columnGap',
    // 'transform' is deliberately NOT observed: the collapse toggles render an
    // animated svg.toggle-icon whose rotation is sampled at a random point in
    // time, so its matrix differs between two runs of identical code.  Keeping
    // it here produced ~18 phantom regressions per run and made the gate useless.
    'overflow', 'overflowX', 'overflowY', 'zIndex', 'boxShadow', 'backdropFilter',
    'textOverflow', 'textTransform', 'verticalAlign', 'objectFit', 'resize', 'cursor',
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

function collectSurfaceStylesInPage(surfaceSelector, props) {
    const root = document.querySelector(surfaceSelector);
    if (!root || !root.isConnected) return { error: `surface not found: ${surfaceSelector}` };
    const entries = [];
    const walk = (element, depth) => {
        const computed = getComputedStyle(element);
        const styles = {};
        for (const prop of props) styles[prop] = computed[prop];
        const parent = element.parentElement;
        const siblings = parent ? [...parent.children].filter(child => child.tagName === element.tagName) : [];
        const index = siblings.indexOf(element);
        entries.push({
            path: `${depth}>${element.tagName.toLowerCase()}${element.id ? '#' + element.id : ''}${index > 0 ? ':' + (index + 1) : ''}`,
            tag: element.tagName.toLowerCase(),
            id: element.id || undefined,
            cls: (element.getAttribute('class') || '').split(/\s+/).filter(Boolean).join(' ') || undefined,
            text: element.children.length === 0 ? (element.textContent || '').trim().slice(0, 40) || undefined : undefined,
            styles,
        });
        for (const child of element.children) walk(child, depth + 1);
    };
    walk(root, 0);
    return { count: entries.length, entries };
}

async function waitForRenderer(page) {
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    await page.waitForFunction(() => document.documentElement.dataset.uiMode === 'next', { timeout: timeoutMs });
    await page.waitForFunction(() => Boolean(window.VCPSettingsSidebar && window.settingsManager), { timeout: timeoutMs });
}

async function applyTheme(page, theme) {
    await page.evaluate(nextTheme => {
        window.uiManager?.applyTheme?.(nextTheme);
        document.body.classList.toggle('light-theme', nextTheme === 'light');
        document.body.classList.toggle('dark-theme', nextTheme === 'dark');
        document.body.dataset.vcpTheme = nextTheme;
    }, theme);
    await sleep(200);
}

async function openSettingsTab(page) {
    await page.evaluate(() => {
        window.uiManager?.switchToTab?.('settings');
        window.VCPSettingsSidebar?.setPanelActive?.(true);
        document.getElementById('tabContentSettings')?.classList.add('active');
        document.getElementById('tabContentSettings')?.setAttribute('aria-hidden', 'false');
    });
    await page.waitForFunction(() => {
        const tab = document.getElementById('tabContentSettings');
        return Boolean(tab?.classList.contains('active'));
    }, { timeout: timeoutMs });
}

async function showSurface(page, kind) {
    const selector = kind === 'agent' ? '#agentSettingsContainer' : '#groupSettingsContainer';
    await page.evaluate(nextKind => {
        const tab = document.getElementById('tabContentSettings');
        const api = window.VCPSettingsSidebar;
        if (nextKind === 'group') {
            window.VCPGroupSettingsSlots?.ensureSettingsSurface?.({ document, settingsTab: tab });
        }
        api?.setPanelActive?.(true);
        api?.show?.(nextKind, { id: 'parity-audit' });
    }, kind);
    await page.waitForFunction(sel => {
        const node = document.querySelector(sel);
        return Boolean(node && node.isConnected && node.offsetParent !== null);
    }, { timeout: timeoutMs }, selector);
    await sleep(250);
}

async function setAllSections(page, formSelector, collapsed) {
    return page.evaluate((sel, nextCollapsed) => {
        const form = document.querySelector(sel);
        if (!form) return { error: `form not found: ${sel}` };
        const sections = [...form.querySelectorAll('[data-section-key]')];
        for (const section of sections) {
            section.classList.toggle('collapsed', nextCollapsed);
            const expanded = !nextCollapsed;
            section.querySelector(':scope > [class*="section-header"]')?.setAttribute('aria-expanded', String(expanded));
            section.querySelector(':scope > [class*="section-header"] [class*="toggle-btn"], :scope > [class*="toggle-btn"]')
                ?.setAttribute('aria-expanded', String(expanded));
        }
        return { count: sections.length, keys: sections.map(section => section.dataset.sectionKey) };
    }, formSelector, collapsed);
}

async function setSection(page, formSelector, key, collapsed) {
    return page.evaluate((sel, sectionKey, nextCollapsed) => {
        const form = document.querySelector(sel);
        const section = form?.querySelector(`[data-section-key="${sectionKey}"]`);
        if (!section) return { error: `section not found: ${sectionKey}` };
        section.classList.toggle('collapsed', nextCollapsed);
        const expanded = !nextCollapsed;
        section.querySelector(':scope > [class*="section-header"]')?.setAttribute('aria-expanded', String(expanded));
        section.querySelector('[class*="toggle-btn"]')?.setAttribute('aria-expanded', String(expanded));
        return { key: sectionKey, collapsed: section.classList.contains('collapsed') };
    }, formSelector, key, collapsed);
}

async function screenshotSurface(page, name) {
    if (!wantShots) return;
    mkdirSync(shotsDir, { recursive: true });
    const handle = await page.$('#tabContentSettings');
    if (!handle) throw new Error('tabContentSettings not found for screenshot ' + name);
    const file = path.join(shotsDir, `${name}.png`);
    await handle.screenshot({ path: file });
    console.log(`[style-parity] shot ${file}`);
}

// The settings surface animates: the sticky action bar toggles
// `scrolled-to-bottom` and the delete container eases its height/opacity.
// Sampling mid-animation produced ~8 phantom regressions per run and made two
// consecutive runs of identical code disagree.  Wait until the surface reports
// the same geometry twice before dumping.
async function settleSurface(page, selector, timeoutMs = 5000) {
    // Pin every scrollable ancestor to the top first.  The sticky action bar
    // derives `scrolled-to-bottom` from the scroll offset, so two runs that
    // happen to rest at different offsets stabilise into *different* geometries
    // (delete container expanded vs collapsed, and an 11px scrollbar delta that
    // shifts every width in the surface).  Without this the gate is a coin flip.
    await page.evaluate(() => {
        const roots = document.querySelectorAll('#tabContentSettings, #tabContentSettings *');
        roots.forEach((element) => {
            if (element.scrollHeight > element.clientHeight + 1) element.scrollTop = 0;
        });
    });
    const deadline = Date.now() + timeoutMs;
    let previous = null;
    let stablePolls = 0;
    while (Date.now() < deadline) {
        const snapshot = await page.evaluate((sel) => {
            const root = document.querySelector(sel);
            if (!root) return 'missing';
            const actions = root.querySelector('.form-actions');
            const rect = actions?.getBoundingClientRect();
            return [root.scrollHeight, actions?.className || '', rect ? rect.height.toFixed(2) : ''].join('|');
        }, selector);
        if (snapshot === previous) {
            stablePolls += 1;
            if (stablePolls >= 2) return;
        } else {
            stablePolls = 0;
        }
        previous = snapshot;
        await sleep(120);
    }
    console.warn(`[style-parity] surface ${selector} did not settle within ${timeoutMs}ms`);
}

async function collectStyles(page, selector) {
    await settleSurface(page, selector);
    return page.evaluate(collectSurfaceStylesInPage, selector, OBSERVED_PROPERTIES);
}

function diffDumps(baseline, dump) {
    let diffs = 0;
    let structural = 0;
    const lines = [];
    for (const key of Object.keys(baseline)) {
        const before = baseline[key];
        const after = dump[key];
        if (before?.error || after?.error) {
            if (before?.error !== after?.error) {
                diffs += 1;
                lines.push(`[style-parity] DIFF ${key}: ${before?.error || 'ok'} -> ${after?.error || 'ok'}`);
            }
            continue;
        }
        const beforeEntries = before?.entries || [];
        const afterEntries = after?.entries || [];
        if (beforeEntries.length !== afterEntries.length) {
            diffs += 1;
            lines.push(`[style-parity] DIFF ${key}: element count ${beforeEntries.length} -> ${afterEntries.length}`);
            continue;
        }
        for (let i = 0; i < beforeEntries.length; i++) {
            const a = beforeEntries[i];
            const b = afterEntries[i];
            const label = `${key}[${i}] ${a.tag}${a.id ? '#' + a.id : ''}`;
            if (a.path !== b.path || a.id !== b.id) {
                // A DOM path change alone is a structural note, not a visual
                // regression: a tag swap (e.g. div -> section) keeps every
                // observed computed style identical.  Keep comparing styles so a
                // real change behind the swap still fails the gate.
                structural += 1;
                lines.push(`[style-parity] STRUCT ${label}: path ${a.path} -> ${b.path} (${a.tag} -> ${b.tag})`);
            }
            for (const prop of OBSERVED_PROPERTIES) {
                if (a.styles[prop] !== b.styles[prop]) {
                    diffs += 1;
                    lines.push(`[style-parity] DIFF ${label}: ${prop} ${a.styles[prop]} -> ${b.styles[prop]}`);
                }
            }
        }
    }
    return { diffs, structural, lines };
}

async function main() {
    if (diffAgainst && !existsSync(diffAgainst)) throw new Error(`--diff file not found: ${diffAgainst}`);

    const profileDir = await mkdtemp(path.join(os.tmpdir(), 'vcpchat-style-parity-'));
    await writeFile(path.join(profileDir, 'settings.json'), JSON.stringify({
        uiMode: 'next',
        enableDistributedServer: false,
        vcpServerUrl: 'http://127.0.0.1:1',
        vcpApiKey: 'style-parity-key',
        userName: '初始用户',
        currentThemeMode: 'dark',
    }), 'utf8');

    const port = await freePort();
    const stderr = { value: '' };
    const child = spawn(electronBinary, [
        '.', '--allow-multiple-instances',
        `--user-data-dir=${path.join(profileDir, 'ElectronProfile')}`,
        `--remote-debugging-port=${port}`,
    ], {
        cwd: repoRoot,
        env: {
            ...process.env,
            VCPCHAT_APP_DATA_DIR: profileDir,
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

        browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
        let page = null;
        while (Date.now() < deadline) {
            page = (await browser.pages()).find(candidate => {
                try { return candidate.url().includes('main.html'); } catch { return false; }
            }) || null;
            if (page) break;
            await sleep(100);
        }
        if (!page) throw new Error(`Electron main renderer did not appear: ${stderr.value}`);

        await waitForRenderer(page);
        await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
        await openSettingsTab(page);

        const dump = {};
        for (const theme of ['dark', 'light']) {
            await applyTheme(page, theme);

            await showSurface(page, 'agent');
            await setAllSections(page, '#agentSettingsForm', true);
            await screenshotSurface(page, `agent-${theme}-collapsed`);
            await setSection(page, '#agentSettingsForm', 'identity', false);
            await screenshotSurface(page, `agent-${theme}-identity`);
            await setAllSections(page, '#agentSettingsForm', true);
            const regexState = await setSection(page, '#agentSettingsForm', 'regex', false);
            if (regexState?.error) console.warn(`[style-parity] ${theme} ${regexState.error}`);
            await screenshotSurface(page, `agent-${theme}-regex`);
            await setAllSections(page, '#agentSettingsForm', false);
            dump[`agent:${theme}`] = await collectStyles(page, '#agentSettingsContainer');

            await showSurface(page, 'group');
            await setAllSections(page, '#groupSettingsForm', true);
            await screenshotSurface(page, `group-${theme}-collapsed`);
            await setAllSections(page, '#groupSettingsForm', false);
            await screenshotSurface(page, `group-${theme}-expanded`);
            dump[`group:${theme}`] = await collectStyles(page, '#groupSettingsContainer');
        }

        mkdirSync(path.dirname(outFile), { recursive: true });
        writeFileSync(outFile, JSON.stringify(dump, null, 2));
        const summary = Object.entries(dump).map(([key, value]) => `${key}=${value.error || value.count}`).join(', ');
        console.log(`[style-parity] wrote ${summary} entries to ${outFile}`);
        if (Object.values(dump).some(value => value.error)) {
            throw new Error(`parity dump contained errors: ${summary}`);
        }

        if (diffAgainst) {
            const baseline = JSON.parse(readFileSync(diffAgainst, 'utf8'));
            const { diffs, structural, lines } = diffDumps(baseline, dump);
            for (const line of lines.slice(0, 80)) console.error(line);
            if (lines.length > 80) console.error(`[style-parity] … ${lines.length - 80} more diffs`);
            if (diffs > 0) {
                console.error(`[style-parity] FAILED: ${diffs} visual regressions detected.`);
                process.exitCode = 1;
            } else {
                console.log(`[style-parity] PASSED: computed styles identical to baseline${structural > 0 ? ` (${structural} structural-only path notes)` : ''}.`);
            }
        }
    } finally {
        try { await browser?.close(); } catch (_) {}
        try { child.kill('SIGKILL'); } catch (_) {}
    }
}

main().catch(error => {
    console.error('[style-parity] fatal:', error);
    process.exit(1);
});
