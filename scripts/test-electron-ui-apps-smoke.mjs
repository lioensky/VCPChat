// test-electron-ui-apps-smoke — real Electron verification of the active
// design-system surfaces and the generic embedded-app host.
//
//   - boot: Web Awesome is NOT registered nor fetched at app boot,
//   - the UI 组件库 internal app lazy-registers wa-* elements,
//   - global settings modal (next): enhanced controls, save bar dirty state,
//     injected search, focus/Escape keyboard flow; classic teardown,
//   - every child business application opens through the generic host but
//     stays on
//     their byte-identical upstream Classic pages,
//   - switching the whole application to Classic leaves every business page
//     on its original DOM with no VCPUI/Web Awesome surface mounted.
//
// Usage: node scripts/test-electron-ui-apps-smoke.mjs
// Screenshots are written under <repo>/screenshots/.

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
// Generous wait for embedded page boot: the main renderer can block on a
// model-fetch when the configured vcpServerUrl is unreachable (a normal dev
// or smoke environment), which delays topTabManager readiness and therefore
// the embedded-page open flow. 45s was flaky under concurrent Electron
// instances on the same machine.
const timeoutMs = 90_000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const captureDir = path.join(root, 'screenshots');

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        }).on('error', reject);
    });
}

async function capture(page, name) {
    await fs.mkdir(captureDir, { recursive: true });
    const filePath = path.join(captureDir, name);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
}

// ── Embedded page manifest ────────────────────────────────────────────────
// Every entry exercises host integration only; its page source and
// presentation remain upstream Classic.
const EMBEDDED_APPS = [
    {
        id: 'open-note-mini-window', action: 'open-note-mini-window', name: '便签', key: 'notemini.html',
        shellTitle: 'VCP 便签', integrated: true, minWa: { 'wa-input': 1 }, minHeaderRects: 0, minNativeEnhanced: 0,
        legacySelector: '#mini-title-bar', bodyFocus: '.vcp-ui-page-shell-content input',
    },
    {
        id: 'open-translator-window', action: 'open-translator-window', name: '翻译', key: 'translator.html',
        shellTitle: '翻译助手', integrated: true, minWa: { 'wa-tooltip': 1, 'wa-select': 2 }, minHeaderRects: 0, minNativeEnhanced: 2,
        legacySelector: '.translator-container', bodyFocus: '.vcp-ui-page-shell-content textarea',
    },
    {
        id: 'open-log-window', action: 'open-log-window', name: '日志', key: 'log.html',
        shellTitle: 'VCP日志中心', integrated: true, minWa: { 'wa-tooltip': 1, 'wa-select': 1 }, minHeaderRects: 0, minNativeEnhanced: 1,
        legacySelector: '.log-app', bodyFocus: '.vcp-ui-page-shell-content input',
    },
    {
        id: 'open-plugin-manager-window', action: 'open-plugin-manager-window', name: '插件', key: 'plugin-manager.html',
        shellTitle: '插件管理器', integrated: true, minWa: { 'wa-tooltip': 1, 'wa-select': 2 }, minHeaderRects: 0, minNativeEnhanced: 2,
        legacySelector: '.app-container', bodyFocus: '.vcp-ui-page-shell-content input',
    },
    {
        id: 'open-task-window', action: 'open-task-window', name: '任务', key: 'task.html',
        shellTitle: '任务助手', integrated: true, minWa: { 'wa-tooltip': 1 }, minHeaderRects: 0, minNativeEnhanced: 0,
        legacySelector: '.app-container', bodyFocus: null,
    },
    {
        id: 'open-notes-window', action: 'open-notes-window', name: '笔记', key: 'notes.html',
        shellTitle: '我的笔记', integrated: true, minWa: { 'wa-tooltip': 1 }, minHeaderRects: 0, minNativeEnhanced: 1,
        legacySelector: '.container', bodyFocus: '.vcp-ui-page-shell-content input',
    },
    {
        id: 'open-memo-window', action: 'open-memo-window', name: '记忆', key: 'memo.html',
        shellTitle: '记忆工作台', integrated: true, minWa: { 'wa-tooltip': 1, 'wa-select': 1 }, minHeaderRects: 0, minNativeEnhanced: 1,
        legacySelector: 'main.main-content', bodyFocus: null,
    },
    {
        id: 'open-forum-window', action: 'open-forum-window', name: '论坛', key: 'forum.html',
        shellTitle: 'VCP 论坛', integrated: true, minWa: { 'wa-tooltip': 1, 'wa-select': 1 }, minHeaderRects: 0, minNativeEnhanced: 1,
        legacySelector: '.app-container', bodyFocus: '.vcp-ui-page-shell-content input',
    },
];

// ── Next-mode audit of a child page (embedded view or standalone window) ──
// Returns structured observations; assertions happen in Node so a single page
// cannot abort the whole run before its observations are recorded.
const NEXT_AUDIT_SCRIPT = () => {
    const visibleRect = (el) => {
        const r = el.getBoundingClientRect();
        return {
            left: r.left, top: r.top, right: r.right, bottom: r.bottom,
            width: r.width, height: r.height,
            visible: r.width > 0 && r.height > 0,
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            disabled: el.disabled === true,
        };
    };
    const headerControls = [...document.querySelectorAll(
        '.vcp-ui-page-shell-header :is(button, select, input, wa-button, wa-select, wa-input), .vcp-ui-window-controls button'
    )].filter(el => el.getClientRects().length && getComputedStyle(el).display !== 'none');
    const rects = headerControls.map(visibleRect);
    const windowControlButtons = [...document.querySelectorAll('.vcp-ui-window-controls :is(button, wa-button)')];
    const focusable = [...document.querySelectorAll('.vcp-ui-page-shell-content :is(input, textarea, select, wa-input, wa-select), .vcp-ui-page-shell-header :is(button, wa-button)')]
        .filter(el => !el.disabled && el.getClientRects().length && getComputedStyle(el).display !== 'none');
    return {
        uiMode: document.documentElement.dataset.uiMode,
        controllerMode: window.VCPUiModeController?.getCurrentMode?.() || null,
        hasShell: Boolean(document.querySelector('.vcp-ui-page-shell')),
        bodyScope: document.body.classList.contains('vcp-ui-scope'),
        waRuntime: window.VCPWebAwesome?.getRuntimeState?.() || null,
        waScope: document.body.dataset.waScope || '',
        waThemeOwners: Number(document.querySelector('link[data-webawesome-runtime-theme]')?.dataset.ownerCount || 0),
        hasSelectObserver: Boolean(window.VCPUISelectObserver),
        shellTitle: document.querySelector('.vcp-ui-page-shell-title')?.textContent?.trim() || '',
        shellEmbedded: document.querySelector('.vcp-ui-page-shell')?.dataset.embedded || '',
        integratedShell: document.querySelector('.vcp-ui-page-shell')?.classList.contains('vcp-ui-integrated-shell') || false,
        shellHeaderDisplay: getComputedStyle(document.querySelector('.vcp-ui-page-shell-header')).display,
        integratedMain: (() => {
            const main = document.querySelector('.vcp-ui-integrated-main');
            if (!main) return null;
            const style = getComputedStyle(main);
            return { radius: style.borderTopLeftRadius, borderTop: style.borderTopStyle, visible: visibleRect(main).visible };
        })(),
        vcpEmbeddedFlag: document.documentElement.dataset.vcpEmbeddedApp || '',
        wa: {
            'wa-button': document.querySelectorAll('wa-button').length,
            'wa-input': document.querySelectorAll('wa-input').length,
            'wa-select': document.querySelectorAll('wa-select').length,
            'wa-card': document.querySelectorAll('wa-card').length,
            'wa-tooltip': document.querySelectorAll('wa-tooltip').length,
        },
        lucideIcons: document.querySelectorAll('[data-lucide]').length,
        vcpIcons: document.querySelectorAll('.vcp-ui-icon').length,
        nativeEnhanced: document.querySelectorAll('.vcp-ui-native-input, .vcp-ui-native-select, .vcp-ui-native-textarea').length,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        overflowY: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
        headerRects: rects,
        windowControls: {
            count: windowControlButtons.length,
            allNoDrag: windowControlButtons.every(element => getComputedStyle(element).webkitAppRegion === 'no-drag'),
        },
        headerOverlap: rects.some((a, i) => rects.some((b, j) => i < j && a.visible && b.visible
            && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)),
        allHeaderVisible: rects.length > 0 && rects.every(r => r.visible),
        focusables: focusable.length,
        bodyTextLength: (document.querySelector('.vcp-ui-page-shell-content')?.textContent || '').trim().length,
        bodyBackgroundColor: getComputedStyle(document.body).backgroundColor,
    };
};

// Run inside a page: focus the first visible input/select (textarea is skipped
// because Tab inserts a tab character in a textarea instead of moving focus).
const FOCUS_FIRST_SCRIPT = () => {
    const candidates = [...document.querySelectorAll('.vcp-ui-page-shell-content input, .vcp-ui-page-shell-content select')]
        .filter(el => !el.disabled && el.getClientRects().length && getComputedStyle(el).display !== 'none');
    if (!candidates.length) return null;
    candidates[0].focus();
    return candidates[0].tagName.toLowerCase() + (candidates[0].id ? '#' + candidates[0].id : '');
};

// Run inside a page: inject long text and check for clipping / overflow.
const LONG_TEXT_SCRIPT = () => {
    const target = [...document.querySelectorAll('.vcp-ui-page-shell-content textarea, .vcp-ui-page-shell-content input')]
        .find(el => el.getClientRects().length);
    if (!target) return { applied: false };
    const long = '长文本'.repeat(500);
    if (target instanceof HTMLTextAreaElement) {
        target.value = long;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        return {
            applied: true,
            scrollable: target.scrollHeight > target.clientHeight + 1,
            clipped: target.scrollWidth > target.clientWidth + 1,
            overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        };
    }
    target.value = long.slice(0, 200);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    return {
        applied: true,
        scrollable: true,
        clipped: false,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
};

async function waitForChildPage(browser, key, deadline, label) {
    while (Date.now() < deadline) {
        // Do not enumerate browser.pages() while WebContentsView targets are
        // being created/destroyed: Puppeteer eagerly initializes every target
        // and can race Network.enable against a target that is already
        // closing. Select the matching target first, then attach only to it.
        const target = browser.targets().find(candidate => candidate.url().includes(key));
        if (target) {
            const found = await target.page();
            if (found && !found.isClosed()) return found;
        }
        await sleep(150);
    }
    throw new Error(`${label} page (${key}) did not appear`);
}

async function ensureChildPageClosed(browser, key, deadline, label) {
    while (Date.now() < deadline) {
        const leftover = browser.targets().find(candidate => candidate.url().includes(key));
        if (!leftover) return;
        await sleep(120);
    }
    throw new Error(`${label} page (${key}) never closed before reopen`);
}

async function pressEscapeAndAllowTargetClose(page) {
    try {
        await page.keyboard.press('Escape');
    } catch (error) {
        // Closing an embedded WebContents can destroy its CDP target before
        // Input.dispatchKeyEvent receives an acknowledgement.
        if (!/TargetCloseError|Target closed/i.test(`${error?.name || ''} ${error?.message || ''}`)) throw error;
    }
}

// Known-benign console noise: the legacy pages load some Font Awesome SVG via
// data: URLs which the app's CSP (connect-src without data:) rejects. This is
// pre-existing main-renderer/legacy behaviour, reported separately; it is not
// a next-UI rebuild failure.
function isBenignConsoleNoise(text) {
    return /Content Security Policy|Refused to connect|Fetch API cannot load data:image/i.test(text);
}

function collectRealErrors(label) {
    const pageErrorsList = pageErrors.get(label) || [];
    const consoleErrorsList = (consoleErrors.get(label) || []).filter(message => !isBenignConsoleNoise(message));
    return [...pageErrorsList, ...consoleErrorsList];
}

async function auditNextPage(page, app, captureName, { expectEmbedded = true } = {}) {
    await page.waitForFunction(() => document.querySelector('.vcp-ui-page-shell'), { timeout: timeoutMs });
    await sleep(500); // let WA tooltips/layout settle
    const state = await page.evaluate(NEXT_AUDIT_SCRIPT);
    assert.equal(state.uiMode, 'next', `${app.name} must be next mode: ${JSON.stringify(state)}`);
    assert.equal(state.controllerMode, 'next', `${app.name} controller must agree on next mode`);
    assert.ok(state.hasShell, `${app.name} AppPageShell missing`);
    assert.equal(state.shellEmbedded, expectEmbedded ? 'true' : 'false', `${app.name} embedded flag wrong: ${JSON.stringify(state)}`);
    assert.equal(state.bodyScope, true, `${app.name} body not vcp-ui-scope`);
    assert.equal(state.waRuntime?.state, 'ready', `${app.name} WA runtime is not ready: ${JSON.stringify(state)}`);
    assert.equal(state.waRuntime?.locale, 'zh-CN', `${app.name} WA locale is not zh-CN: ${JSON.stringify(state)}`);
    assert.equal(state.waScope, 'true', `${app.name} WA token scope is not mounted: ${JSON.stringify(state)}`);
    assert.equal(state.waThemeOwners, 1, `${app.name} WA theme ownership leaked or duplicated: ${JSON.stringify(state)}`);
    assert.equal(state.hasSelectObserver, false, `${app.name} mounted a document-wide Select observer: ${JSON.stringify(state)}`);
    if (expectEmbedded && app.integrated) {
        assert.equal(state.integratedShell, true, `${app.name} must use the shared integrated shell: ${JSON.stringify(state)}`);
        assert.equal(state.shellHeaderDisplay, 'none', `${app.name} embedded duplicate header must be hidden: ${JSON.stringify(state)}`);
        assert.ok(state.integratedMain?.visible, `${app.name} integrated main surface must be visible: ${JSON.stringify(state)}`);
        assert.notEqual(state.integratedMain?.radius, '0px', `${app.name} integrated main surface needs the shared top-left radius: ${JSON.stringify(state)}`);
    }
    if (app.shellTitle) assert.equal(state.shellTitle, app.shellTitle, `${app.name} shell title wrong: ${JSON.stringify(state)}`);
    for (const [tag, count] of Object.entries(app.minWa || {})) {
        assert.ok(state.wa[tag] >= count, `${app.name} needs >= ${count} <${tag}> but found ${state.wa[tag]}: ${JSON.stringify(state)}`);
    }
    if ((app.minNativeEnhanced || 0) > 0) {
        assert.ok(state.nativeEnhanced >= app.minNativeEnhanced, `${app.name} needs >= ${app.minNativeEnhanced} VCPUI-enhanced native controls but found ${state.nativeEnhanced}: ${JSON.stringify(state)}`);
    }
    assert.equal(state.overflowX, false, `${app.name} horizontal overflow: ${JSON.stringify(state)}`);
    if (app.requireOpaqueBody) {
        assert.notEqual(state.bodyBackgroundColor, 'rgba(0, 0, 0, 0)', `${app.name} root background must not expose Electron's black backing surface: ${JSON.stringify(state)}`);
    }
    assert.ok(state.headerRects.length >= (app.minHeaderRects || 0), `${app.name} expected >= ${app.minHeaderRects || 0} header controls but found ${state.headerRects.length}: ${JSON.stringify(state)}`);
    if (!expectEmbedded) {
        assert.equal(state.windowControls.count, 3, `${app.name} must expose exactly three window controls: ${JSON.stringify(state)}`);
        assert.equal(state.windowControls.allNoDrag, true, `${app.name} window controls are inside the draggable title region: ${JSON.stringify(state)}`);
    }
    if (state.headerRects.length) {
        assert.ok(state.allHeaderVisible, `${app.name} header controls not all visible: ${JSON.stringify(state)}`);
        assert.equal(state.headerOverlap, false, `${app.name} header controls overlap: ${JSON.stringify(state)}`);
    }
    if (app.bodyFocus) {
        const focusOk = await page.evaluate(() => {
            // WA-backed controls (wa-input/wa-textarea/wa-select) hold their
            // native input in shadow DOM; include them so a next-mode page
            // whose controls were upgraded by the Web Awesome adapter still
            // passes the focus check.
            const candidates = [...document.querySelectorAll(
                '.vcp-ui-page-shell-content input, .vcp-ui-page-shell-content textarea, .vcp-ui-page-shell-content select, ' +
                '.vcp-ui-page-shell-content wa-input, .vcp-ui-page-shell-content wa-textarea, .vcp-ui-page-shell-content wa-select'
            )].filter(el => !el.disabled && el.getClientRects().length && getComputedStyle(el).display !== 'none');
            if (!candidates.length) return { focused: false, reason: 'no visible control' };
            candidates[0].focus();
            const active = document.activeElement;
            const landed = active === candidates[0]
                || candidates[0].contains(active)
                || (candidates[0].shadowRoot && candidates[0].shadowRoot.contains(active));
            return { focused: landed, active: active?.tagName || '' };
        });
        assert.ok(focusOk.focused, `${app.name} focus did not land on a body control: ${JSON.stringify(focusOk)}`);
    }
    if (state.focusables >= 2) {
        const focused = await page.evaluate(FOCUS_FIRST_SCRIPT);
        if (focused) {
            await page.keyboard.press('Tab');
            const afterTab = await page.evaluate(() => {
                const active = document.activeElement;
                return { tag: active?.tagName?.toLowerCase() || '', id: active?.id || '' };
            });
            const moved = `${afterTab.tag}${afterTab.id ? '#' + afterTab.id : ''}` !== focused;
            assert.ok(moved, `${app.name} Tab did not move focus (still ${focused})`);
        }
    }
    await capture(page, captureName);

    // Narrow viewport regression.
    await page.setViewport({ width: 480, height: 720, deviceScaleFactor: 1 });
    await sleep(300);
    const narrow = await page.evaluate(() => ({
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    }));
    assert.equal(narrow.overflowX, false, `${app.name} overflows at 480px: ${JSON.stringify(narrow)}`);
    await capture(page, captureName.replace('.png', '-narrow.png'));

    // Long text / clipping check when a textarea or input exists.
    const longText = await page.evaluate(LONG_TEXT_SCRIPT);
    if (longText.applied) {
        assert.equal(longText.overflowX, false, `${app.name} page overflows after long text: ${JSON.stringify(longText)}`);
    }
    return { state, longText };
}

async function auditUpstreamClassicPage(page, app, captureName) {
    await page.waitForFunction((selector) => document.querySelector(selector), { timeout: timeoutMs }, app.legacySelector || app.legacy);
    await sleep(300);
    const state = await page.evaluate(async ({ legacySelector, action }) => {
        const utilityApi = window.utilityAPI;
        let pluginListProbe = null;
        if (action === 'open-plugin-manager-window' && typeof utilityApi?.pluginManagerListPlugins === 'function') {
            pluginListProbe = await utilityApi.pluginManagerListPlugins();
        }
        return {
            uiMode: document.documentElement.dataset.uiMode || 'classic',
            hasShell: Boolean(document.querySelector('.vcp-ui-page-shell')),
            waCount: document.querySelectorAll('wa-button, wa-input, wa-select, wa-card, wa-tooltip').length,
            bodyScope: document.body.classList.contains('vcp-ui-scope'),
            legacyPresent: Boolean(document.querySelector(legacySelector)),
            embeddedFlag: document.documentElement.dataset.vcpEmbeddedApp || '',
            hasUtilityApi: Boolean(utilityApi),
            hasLoadSettings: typeof utilityApi?.loadSettings === 'function',
            hasPluginManagerApi: typeof utilityApi?.pluginManagerListPlugins === 'function',
            pluginListProbe,
        };
    }, { legacySelector: app.legacySelector || app.legacy, action: app.action });
    assert.equal(state.uiMode, 'classic', `${app.name} upstream Classic surface must resolve to classic: ${JSON.stringify(state)}`);
    assert.equal(state.hasShell, false, `${app.name} upstream Classic surface must not mount AppPageShell: ${JSON.stringify(state)}`);
    assert.equal(state.waCount, 0, `${app.name} upstream Classic surface must not register WA: ${JSON.stringify(state)}`);
    assert.equal(state.bodyScope, false, `${app.name} upstream Classic surface must not enter next scope: ${JSON.stringify(state)}`);
    assert.ok(state.legacyPresent, `${app.name} upstream Classic DOM missing: ${JSON.stringify(state)}`);
    assert.equal(state.embeddedFlag, 'true', `${app.name} embedded preload contract missing: ${JSON.stringify(state)}`);
    assert.equal(state.hasUtilityApi, true, `${app.name} utility preload did not expose its role API: ${JSON.stringify(state)}`);
    assert.equal(state.hasLoadSettings, true, `${app.name} shared utility IPC is unavailable: ${JSON.stringify(state)}`);
    if (app.action === 'open-plugin-manager-window') {
        assert.equal(state.hasPluginManagerApi, true, `插件管理 IPC 未注入: ${JSON.stringify(state)}`);
        assert.equal(state.pluginListProbe?.success, true, `插件目录读取失败: ${JSON.stringify(state)}`);
        assert.ok(Array.isArray(state.pluginListProbe?.plugins), `插件目录返回值无效: ${JSON.stringify(state)}`);
        await page.waitForFunction(
            () => !document.getElementById('plugin-groups')?.textContent?.includes('IPC 尚未注入'),
            { timeout: timeoutMs }
        );
    }
    await capture(page, captureName);
}

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-ui-apps-electron-'));
const nextSettings = {
    uiMode: 'next',
    enableDistributedServer: false,
    // First-run coverage: the canonical shell, settings and embedded IPC must
    // be usable before the user configures a VCP server.
    vcpServerUrl: '',
    vcpApiKey: '',
};
// Translator's unchanged upstream Classic page uses a blocking alert when its
// server fields are empty. Keep the main-window first-run phase blank, then
// use inert non-empty values for child-host coverage so the upstream alert
// cannot freeze CDP before Puppeteer has attached to that WebContentsView.
const embeddedNextSettings = {
    ...nextSettings,
    vcpServerUrl: 'http://127.0.0.1:1/v1/chat/completions',
    vcpApiKey: 'electron-smoke-placeholder',
};
const classicSettings = { ...embeddedNextSettings, uiMode: 'classic' };
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify(nextSettings), 'utf8');
const smokeAgentDir = path.join(appData, 'Agents', 'SmokeAgent');
await fs.mkdir(smokeAgentDir, { recursive: true });
await fs.writeFile(path.join(smokeAgentDir, 'config.json'), JSON.stringify({
    name: 'Smoke Agent',
    model: 'smoke-model',
    promptMode: 'original',
    originalSystemPrompt: 'Smoke prompt',
    systemPrompt: 'Smoke prompt',
    stripRegexes: [],
}), 'utf8');

// Keep the project-root mirror for older packaged/runtime paths while the
// primary hermetic authority remains VCPCHAT_APP_DATA_DIR.
const projectAppDataDir = path.join(root, 'AppData');
await fs.mkdir(projectAppDataDir, { recursive: true });
const projectSettingsFile = path.join(projectAppDataDir, 'settings.json');
async function writeProjectUiMode(uiMode) {
    let settings = {};
    try { settings = JSON.parse(await fs.readFile(projectSettingsFile, 'utf8')); } catch { /* first write */ }
    settings.uiMode = uiMode;
    await fs.writeFile(projectSettingsFile, JSON.stringify(settings), 'utf8');
}
await writeProjectUiMode('next');

const port = await freePort();
const stderr = { value: '' };
const rendererErrors = [];
const pageErrors = new Map();
const consoleErrors = new Map();
const webAwesomeRuntimeRequests = [];
const child = spawn(electron, ['.', '--allow-multiple-instances', `--remote-debugging-port=${port}`], {
    cwd: root,
    env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
});
child.stderr.on('data', (chunk) => { stderr.value = `${stderr.value}${chunk}`.slice(-12_000); });

function instrument(page, label) {
    page.on('pageerror', (error) => {
        (pageErrors.get(label) || pageErrors.set(label, []).get(label)).push(error?.stack || String(error));
    });
    page.on('console', (message) => {
        if (message.type() === 'error') (consoleErrors.get(label) || consoleErrors.set(label, []).get(label)).push(message.text());
    });
}

const summary = [];
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
        page = (await browser.pages()).find((candidate) => candidate.url().includes('main.html')) || null;
        if (page) break;
        await sleep(100);
    }
    assert.ok(page, `Electron main renderer did not appear: ${stderr.value}`);
    instrument(page, 'main');
    page.on('request', (request) => {
        if (/vendor\/webawesome-runtime\/dist-cdn/i.test(request.url())) webAwesomeRuntimeRequests.push(request.url());
    });

    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });

    const initialThemeState = await page.evaluate(() => ({
        pending: document.body.getAttribute('data-theme-pending'),
        hasLight: document.body.classList.contains('light-theme'),
        hasDark: document.body.classList.contains('dark-theme'),
        visibility: getComputedStyle(document.body).visibility,
        startupStatusHidden: document.getElementById('startupInitializationStatus')?.hidden ?? true,
    }));
    assert.equal(initialThemeState.pending, null, `startup theme gate was not released: ${JSON.stringify(initialThemeState)}`);
    assert.equal(initialThemeState.hasLight || initialThemeState.hasDark, true, `startup theme class missing: ${JSON.stringify(initialThemeState)}`);
    assert.equal(initialThemeState.visibility, 'visible', `startup body remains hidden after renderer readiness: ${JSON.stringify(initialThemeState)}`);
    assert.equal(initialThemeState.startupStatusHidden, true, `startup initialization error status is visible on a healthy boot: ${JSON.stringify(initialThemeState)}`);

    // A4 platform-independent evidence: exercise the real renderer at the
    // common Windows scale factors and reduced-motion preference. The page
    // must remain visible, the canonical shell must retain a usable width,
    // and no interaction may depend on an animation-end callback.
    for (const deviceScaleFactor of [1, 1.25, 1.5]) {
        await page.setViewport({ width: 1280, height: 820, deviceScaleFactor });
        const scaleState = await page.evaluate(() => {
            const shell = document.getElementById('nextUiMainPanel');
            const body = document.body;
            const rect = shell?.getBoundingClientRect();
            return {
                dpr: window.devicePixelRatio,
                visible: getComputedStyle(body).visibility === 'visible',
                shellWidth: rect?.width || 0,
                overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            };
        });
        assert.equal(scaleState.visible, true, `body hidden at deviceScaleFactor ${deviceScaleFactor}: ${JSON.stringify(scaleState)}`);
        assert.ok(scaleState.shellWidth > 500, `canonical shell collapsed at deviceScaleFactor ${deviceScaleFactor}: ${JSON.stringify(scaleState)}`);
        assert.equal(scaleState.overflowX, false, `horizontal overflow at deviceScaleFactor ${deviceScaleFactor}: ${JSON.stringify(scaleState)}`);
    }
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const reducedMotionState = await page.evaluate(() => ({
        media: matchMedia('(prefers-reduced-motion: reduce)').matches,
        launchpad: getComputedStyle(document.getElementById('nextUiLaunchpad')).animationDuration,
        bodyVisible: getComputedStyle(document.body).visibility === 'visible',
    }));
    assert.equal(reducedMotionState.media, true, `reduced-motion preference was not applied: ${JSON.stringify(reducedMotionState)}`);
    assert.equal(reducedMotionState.bodyVisible, true, `reduced-motion boot is not visible: ${JSON.stringify(reducedMotionState)}`);
    await page.emulateMediaFeatures([]);
    await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1 });

    // 1. Web Awesome runtime must not be fetched nor registered at boot.
    const bootWaState = await page.evaluate(() => ({
        waButton: typeof customElements !== 'undefined' ? customElements.get('wa-button') : null,
        themeLink: Boolean(document.querySelector('link[data-webawesome-showcase-theme], link[data-webawesome-runtime-theme]')),
    }));
    assert.ok(!bootWaState.waButton, 'wa-button must not be registered at boot');
    assert.equal(bootWaState.themeLink, false, 'Web Awesome theme must not load at boot');
    assert.equal(webAwesomeRuntimeRequests.length, 0, `Web Awesome runtime fetched at boot: ${webAwesomeRuntimeRequests.join(', ')}`);
    const brandAssets = await page.evaluate(async () => {
        const loadedFaces = await document.fonts.load('900 112px "VCP Orbitron"', 'VCPCHAT');
        const brand = document.querySelector('.next-ui-empty-brand-text');
        const image = new Image();
        image.src = new URL('assets/nova_button.png', document.baseURI).href;
        await image.decode();
        return {
            fontLoaded: loadedFaces.length > 0 && document.fonts.check('900 112px "VCP Orbitron"', 'VCPCHAT'),
            computedFamily: brand ? getComputedStyle(brand).fontFamily : '',
            novaWidth: image.naturalWidth,
            novaHeight: image.naturalHeight,
        };
    });
    assert.equal(brandAssets.fontLoaded, true, `VCPChat Orbitron wordmark font failed to load: ${JSON.stringify(brandAssets)}`);
    assert.match(brandAssets.computedFamily, /VCP Orbitron/, `VCPChat wordmark resolved to the wrong family: ${JSON.stringify(brandAssets)}`);
    assert.ok(brandAssets.novaWidth > 0 && brandAssets.novaHeight > 0, `Nova launch asset failed to decode: ${JSON.stringify(brandAssets)}`);
    // Renderer readiness does not imply that the asynchronous frontend-plugin
    // IPC scan has completed. Audit the plugin after its own readiness
    // contract instead of racing it under a busy CI/Electron host.
    await page.waitForFunction(
        () => Boolean(window.VCPFrontendPlugins?.get?.('vchat-dynamic-wallpaper')),
        { timeout: timeoutMs }
    );
    const nextWallpaperIntegration = await page.evaluate(() => ({
        titlePanelPresent: Boolean(document.querySelector('.chat-header #vchat-dynamic-wallpaper-panel')),
        titleGroupPresent: Boolean(document.querySelector('.chat-header #vchat-wallpaper-title-group')),
        nextMenuPresent: Boolean(document.getElementById('vchatDynamicWallpaperMenuButton')),
        studioActionPresent: Boolean(document.querySelector('[data-studio-action="wallpaper"]')),
    }));
    assert.equal(nextWallpaperIntegration.titlePanelPresent, true, `Next must use the upstream Classic wallpaper title control: ${JSON.stringify(nextWallpaperIntegration)}`);
    assert.equal(nextWallpaperIntegration.titleGroupPresent, true, `Wallpaper title group is missing from the shared chat header: ${JSON.stringify(nextWallpaperIntegration)}`);
    assert.equal(nextWallpaperIntegration.nextMenuPresent, false, `Next-only wallpaper account entry must not be injected: ${JSON.stringify(nextWallpaperIntegration)}`);
    assert.equal(nextWallpaperIntegration.studioActionPresent, false, `Appearance Studio must not expose a plugin-specific wallpaper action: ${JSON.stringify(nextWallpaperIntegration)}`);
    const messageSemantics = await page.evaluate(() => {
        const originalMode = document.documentElement.dataset.uiMode || 'next';
        const host = document.createElement('div');
        host.className = 'vcp-ui-scope chat-messages-container';
        host.style.position = 'fixed';
        host.style.left = '-10000px';
        host.style.top = '0';
        host.style.width = '720px';
        host.innerHTML = `
            <div class="chat-messages">
                <article class="message-item assistant">
                    <img class="chat-avatar" alt="">
                    <div class="details-and-bubble-wrapper">
                        <div class="sender-name">Nova</div>
                        <div class="md-content">
                            <blockquote>upstream quote</blockquote>
                            <pre><code>const value = 1;</code><button class="vcp-code-copy-button" type="button">Copy</button></pre>
                            <div class="vcp-tool-result-bubble"><div class="vcp-tool-result-header">Result</div></div>
                            <div class="vcp-thought-chain-bubble"><div class="vcp-thought-chain-header">Thought</div></div>
                            <div class="maid-diary-update-bubble">
                                <div class="diary-update-side diary-update-before">Before</div>
                                <div class="diary-update-side diary-update-after">After</div>
                            </div>
                            <table><tbody><tr><td>Cell</td></tr></tbody></table>
                            <img class="semantic-media" alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
                        </div>
                    </div>
                </article>
            </div>`;
        document.body.append(host);

        const read = (selector, properties) => {
            const style = getComputedStyle(host.querySelector(selector));
            return Object.fromEntries(properties.map(property => [property, style[property]]));
        };
        const snapshot = () => ({
            outerBubble: read('.md-content', ['borderRadius', 'backgroundColor', 'paddingTop']),
            quote: read('blockquote', ['borderLeftWidth', 'borderLeftStyle', 'borderRadius']),
            code: read('pre', ['borderRadius', 'borderLeftWidth', 'borderLeftStyle', 'maxHeight']),
            tool: read('.vcp-tool-result-bubble', ['maxWidth', 'borderRadius', 'backgroundColor', 'fontFamily']),
            thought: read('.vcp-thought-chain-bubble', ['maxWidth', 'borderRadius', 'fontFamily', 'animationName']),
            diary: read('.maid-diary-update-bubble', ['borderRadius', 'backgroundColor', 'fontFamily']),
            before: read('.diary-update-before', ['borderLeftWidth', 'borderLeftColor', 'backgroundColor']),
            after: read('.diary-update-after', ['borderLeftWidth', 'borderLeftColor', 'backgroundColor']),
            table: read('table', ['display', 'borderRadius']),
            media: read('.semantic-media', ['borderRadius', 'maxHeight']),
            copy: read('.vcp-code-copy-button', ['borderRadius', 'backgroundColor']),
        });

        document.documentElement.dataset.uiMode = 'classic';
        const classic = snapshot();
        document.documentElement.dataset.uiMode = 'next';
        const next = snapshot();
        document.documentElement.dataset.uiMode = originalMode;
        host.remove();
        return { classic, next };
    });
    assert.deepEqual(
        messageSemantics.next,
        messageSemantics.classic,
        `Next must preserve the complete Classic message presentation: ${JSON.stringify(messageSemantics)}`
    );
    assert.notEqual(messageSemantics.next.before.borderLeftColor, messageSemantics.next.after.borderLeftColor, 'Diary before/after emphasis colors must remain distinct');
    const bootLucide = await page.evaluate(() => ({
        lucideIcons: document.querySelectorAll('[data-lucide]').length,
        lucideGlobal: Boolean(window.lucide),
    }));
    assert.ok(bootLucide.lucideGlobal, 'lucide library must be present in the main renderer');
    await page.waitForFunction(
        () => document.querySelectorAll('#appTrayPinnedApps > button').length > 0,
        { timeout: timeoutMs }
    );
    const appTrayState = await page.evaluate(async () => {
        const tray = document.getElementById('vchatAppTray');
        const moreButton = document.getElementById('appTrayMoreBtn');
        const drawer = document.getElementById('appTrayDrawer');
        const pinnedCount = document.querySelectorAll('#appTrayPinnedApps > button').length;
        const drawerItemCount = document.querySelectorAll('#appTrayDrawerGrid > button').length;
        const trayDisplay = tray ? getComputedStyle(tray).display : 'missing';
        moreButton?.click();
        await new Promise(resolve => setTimeout(resolve, 360));
        const firstDrawerItem = document.querySelector('#appTrayDrawerGrid > .app-tray-drawer-item');
        const firstDrawerLabel = firstDrawerItem?.querySelector('.notes-button-label');
        const firstDrawerIcon = firstDrawerItem?.querySelector('svg');
        const settingsButton = document.getElementById('appTraySettingsBtn');
        const firstDrawerRect = firstDrawerItem?.getBoundingClientRect();
        const firstDrawerIconRect = firstDrawerIcon?.getBoundingClientRect();
        const settingsRect = settingsButton?.getBoundingClientRect();
        const drawerRect = drawer?.getBoundingClientRect();
        const drawerGeometry = {
            drawerWidth: drawerRect?.width || 0,
            drawerBounds: drawerRect ? { left: drawerRect.left, right: drawerRect.right } : null,
            viewportWidth: window.innerWidth,
            itemHeight: firstDrawerRect?.height || 0,
            labelFontSize: Number.parseFloat(getComputedStyle(firstDrawerLabel).fontSize) || 0,
            iconWidth: firstDrawerIconRect?.width || 0,
            iconHeight: firstDrawerIconRect?.height || 0,
            settingsWidth: settingsRect?.width || 0,
            settingsHeight: settingsRect?.height || 0,
            clippedLabels: [...document.querySelectorAll('#appTrayDrawerGrid .notes-button-label')]
                .filter(label => label.scrollWidth > label.clientWidth + 1)
                .map(label => label.textContent?.trim()),
            insideViewport: Boolean(drawerRect)
                && drawerRect.left >= 0
                && drawerRect.right <= window.innerWidth,
            occludedItems: [...document.querySelectorAll('#appTrayDrawerGrid > .app-tray-drawer-item')]
                .filter(item => {
                    const rect = item.getBoundingClientRect();
                    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                    return !hit || (hit !== item && !item.contains(hit));
                })
                .map(item => item.textContent?.trim()),
            overflowingItems: [...document.querySelectorAll('#appTrayDrawerGrid > .app-tray-drawer-item')]
                .filter(item => {
                    const itemRect = item.getBoundingClientRect();
                    return [...item.children].some(child => {
                        const childRect = child.getBoundingClientRect();
                        return childRect.left < itemRect.left - 1 || childRect.right > itemRect.right + 1;
                    });
                })
                .map(item => item.textContent?.trim()),
        };
        const opened = drawer?.classList.contains('active') === true
            && getComputedStyle(drawer).visibility === 'visible'
            && drawer.getAttribute('aria-hidden') === 'false'
            && moreButton.getAttribute('aria-expanded') === 'true';
        moreButton?.click();
        const closing = drawer?.classList.contains('is-closing') === true
            && drawer?.classList.contains('active') === false
            && getComputedStyle(drawer).visibility === 'visible'
            && getComputedStyle(drawer.closest('.notifications-sidebar')).overflow === 'visible';
        const closed = drawer?.getAttribute('aria-hidden') === 'true'
            && moreButton?.getAttribute('aria-expanded') === 'false';
        await new Promise(resolve => setTimeout(resolve, 360));
        const exitSettled = drawer?.classList.contains('is-closing') === false
            && getComputedStyle(drawer).visibility === 'hidden';
        moreButton?.click();
        await new Promise(resolve => setTimeout(resolve, 40));
        moreButton?.click();
        await new Promise(resolve => setTimeout(resolve, 40));
        moreButton?.click();
        await new Promise(resolve => setTimeout(resolve, 360));
        const rapidReopenStable = drawer?.classList.contains('active') === true
            && drawer?.classList.contains('is-closing') === false
            && drawer?.getAttribute('aria-hidden') === 'false'
            && moreButton?.getAttribute('aria-expanded') === 'true'
            && getComputedStyle(drawer).visibility === 'visible';
        moreButton?.click();
        await new Promise(resolve => setTimeout(resolve, 360));
        return { trayDisplay, pinnedCount, drawerItemCount, opened, closing, closed, exitSettled, rapidReopenStable, drawerGeometry };
    });
    assert.equal(appTrayState.trayDisplay, 'flex', `Next app tray is not visible: ${JSON.stringify(appTrayState)}`);
    assert.ok(appTrayState.pinnedCount > 0, `Next app tray has no pinned shortcuts: ${JSON.stringify(appTrayState)}`);
    assert.ok(appTrayState.drawerItemCount > 0, `Next app tray drawer has no applications: ${JSON.stringify(appTrayState)}`);
    assert.equal(appTrayState.opened, true, `Next app tray drawer did not open: ${JSON.stringify(appTrayState)}`);
    assert.equal(appTrayState.closing, true, `Next app tray drawer is clipped during its exit transition: ${JSON.stringify(appTrayState)}`);
    assert.equal(appTrayState.closed, true, `Next app tray drawer state did not close: ${JSON.stringify(appTrayState)}`);
    assert.equal(appTrayState.exitSettled, true, `Next app tray drawer did not settle after its exit transition: ${JSON.stringify(appTrayState)}`);
    assert.equal(appTrayState.rapidReopenStable, true, `Next app tray drawer loses ownership when reopened during exit: ${JSON.stringify(appTrayState)}`);
    assert.ok(appTrayState.drawerGeometry.drawerWidth >= 280 && appTrayState.drawerGeometry.drawerWidth <= 300, `Next app drawer does not follow the compact upstream rail width: ${JSON.stringify(appTrayState)}`);
    assert.ok(appTrayState.drawerGeometry.itemHeight >= 31 && appTrayState.drawerGeometry.itemHeight <= 34, `Next app drawer hit target diverges from the upstream compact size: ${JSON.stringify(appTrayState)}`);
    assert.ok(appTrayState.drawerGeometry.labelFontSize >= 14, `Next app drawer label is smaller than upstream: ${JSON.stringify(appTrayState)}`);
    assert.ok(appTrayState.drawerGeometry.iconWidth >= 17 && appTrayState.drawerGeometry.iconWidth <= 19 && appTrayState.drawerGeometry.iconHeight >= 17 && appTrayState.drawerGeometry.iconHeight <= 19, `Next app drawer icon diverges from upstream: ${JSON.stringify(appTrayState)}`);
    assert.ok(appTrayState.drawerGeometry.settingsWidth >= 27 && appTrayState.drawerGeometry.settingsWidth <= 29 && appTrayState.drawerGeometry.settingsHeight >= 27 && appTrayState.drawerGeometry.settingsHeight <= 29, `Next app drawer settings target diverges from upstream: ${JSON.stringify(appTrayState)}`);
    assert.deepEqual(appTrayState.drawerGeometry.clippedLabels, [], `Next app drawer clips application labels: ${JSON.stringify(appTrayState)}`);
    assert.equal(appTrayState.drawerGeometry.insideViewport, true, `Next app drawer leaves the viewport: ${JSON.stringify(appTrayState)}`);
    assert.deepEqual(appTrayState.drawerGeometry.occludedItems, [], `Next app drawer is clipped or covered by its rail: ${JSON.stringify(appTrayState)}`);
    assert.deepEqual(appTrayState.drawerGeometry.overflowingItems, [], `Next app drawer content overflows its item: ${JSON.stringify(appTrayState)}`);
    const parityControls = await page.evaluate(async () => {
        const originalCommands = window.MainChatCommands;
        const calls = [];
        const tick = () => new Promise(resolve => setTimeout(resolve, 0));
        window.MainChatCommands = {
            ...originalCommands,
            toggleTheme: () => calls.push('theme'),
            minimizeToTray: () => calls.push('minimize-to-tray'),
            openForum: () => calls.push('forum'),
            openMemo: () => calls.push('memo'),
            toggleNotificationFilter: () => calls.push('filter-toggle'),
            openNotificationFilterSettings: () => calls.push('filter-settings'),
            clearNotifications: () => calls.push('clear'),
        };

        const display = id => getComputedStyle(document.getElementById(id)).display;
        const presentationButton = document.getElementById('nextUiPresentationBtn');
        const presentationSwitcher = document.getElementById('nextUiChatPresentationSwitcher');
        presentationButton?.click();
        const presentationOpened = presentationSwitcher?.classList.contains('is-open') === true
            && presentationButton?.getAttribute('aria-expanded') === 'true';
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true
        }));
        const presentationClosedByEscape = presentationSwitcher?.classList.contains('is-open') === false
            && presentationButton?.getAttribute('aria-expanded') === 'false'
            && document.activeElement === presentationButton;

        const originalTheme = document.body.classList.contains('dark-theme') ? 'dark' : 'light';
        window.uiManager.applyTheme('dark');
        await tick();
        const darkThemeActionLabel = document.getElementById('nextUiThemeBtn')?.getAttribute('aria-label');
        window.uiManager.applyTheme('light');
        await tick();
        const lightThemeActionLabel = document.getElementById('nextUiThemeBtn')?.getAttribute('aria-label');
        window.uiManager.applyTheme(originalTheme);
        await tick();

        document.getElementById('nextUiThemeBtn')?.click();
        document.getElementById('nextUiMinimizeToTrayBtn')?.click();

        const menuButton = document.getElementById('nextUiNotificationMenuBtn');
        const menu = document.getElementById('nextUiNotificationMenu');
        const forum = document.getElementById('nextUiNotificationForum');
        const memo = document.getElementById('nextUiNotificationMemo');
        const filter = document.getElementById('nextUiNotificationFilterToggle');
        const clear = document.getElementById('nextUiNotificationClear');
        menu.hidden = true;
        menuButton.setAttribute('aria-expanded', 'false');
        const openMenu = async () => {
            if (menu.hidden) menuButton.click();
            await tick();
        };

        await openMenu();
        const firstFocus = document.activeElement?.id;
        forum.click();
        await tick();
        await openMenu();
        memo.click();
        await tick();
        await openMenu();
        filter.click();
        await tick();
        await openMenu();
        filter.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
        await tick();
        await openMenu();
        clear.click();
        await tick();
        await openMenu();
        forum.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        const arrowFocus = document.activeElement?.id;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        const closedByEscape = menu.hidden && menuButton.getAttribute('aria-expanded') === 'false';

        window.MainChatCommands = {
            ...originalCommands,
            openForum: async () => { throw new Error('expected menu action failure'); },
        };
        await openMenu();
        forum.click();
        await tick();
        await tick();
        const rejectedActionClosed = menu.hidden && menuButton.getAttribute('aria-expanded') === 'false';

        window.MainChatCommands = originalCommands;
        const notifications = document.getElementById('notificationsList');
        const disposable = document.createElement('li');
        disposable.className = 'notification-item parity-disposable';
        const protectedItem = document.createElement('li');
        protectedItem.className = 'notification-item parity-protected';
        protectedItem.dataset.protectedNotification = 'tool-approval';
        notifications.append(disposable, protectedItem);
        const clearResult = originalCommands.clearNotifications();
        const clearProtection = {
            disposableRemoved: !notifications.querySelector('.parity-disposable'),
            protectedPreserved: Boolean(notifications.querySelector('.parity-protected')),
            removed: clearResult.removed,
        };
        protectedItem.remove();

        return {
            display: {
                presentation: display('nextUiPresentationBtn'),
                themeStore: display('nextUiThemeStoreBtn'),
                theme: display('nextUiThemeBtn'),
                minimizeToTray: display('nextUiMinimizeToTrayBtn'),
            },
            calls,
            presentationOpened,
            presentationClosedByEscape,
            darkThemeActionLabel,
            lightThemeActionLabel,
            firstFocus,
            arrowFocus,
            closedByEscape,
            rejectedActionClosed,
            clearProtection,
        };
    });
    Object.entries(parityControls.display).forEach(([control, display]) => {
        assert.notEqual(display, 'none', `Next ${control} shortcut is hidden: ${JSON.stringify(parityControls)}`);
    });
    assert.deepEqual(parityControls.calls, [
        'theme',
        'minimize-to-tray',
        'forum',
        'memo',
        'filter-toggle',
        'filter-settings',
        'clear',
    ], `Next parity controls routed to the wrong commands: ${JSON.stringify(parityControls)}`);
    assert.equal(parityControls.presentationOpened, true, `presentation popup did not open explicitly: ${JSON.stringify(parityControls)}`);
    assert.equal(parityControls.presentationClosedByEscape, true, `presentation popup did not close on Escape: ${JSON.stringify(parityControls)}`);
    assert.equal(parityControls.darkThemeActionLabel, '切换为浅色模式', `dark theme action state is stale: ${JSON.stringify(parityControls)}`);
    assert.equal(parityControls.lightThemeActionLabel, '切换为深色模式', `light theme action state is stale: ${JSON.stringify(parityControls)}`);
    assert.equal(parityControls.firstFocus, 'nextUiNotificationForum', `notification menu initial focus is wrong: ${JSON.stringify(parityControls)}`);
    assert.equal(parityControls.arrowFocus, 'nextUiNotificationMemo', `notification menu arrow navigation is wrong: ${JSON.stringify(parityControls)}`);
    assert.equal(parityControls.closedByEscape, true, `notification menu did not close on Escape: ${JSON.stringify(parityControls)}`);
    assert.equal(parityControls.rejectedActionClosed, true, `notification menu stayed open after command rejection: ${JSON.stringify(parityControls)}`);
    assert.deepEqual(parityControls.clearProtection, {
        disposableRemoved: true,
        protectedPreserved: true,
        removed: 1,
    }, `notification clear must preserve tool approvals: ${JSON.stringify(parityControls)}`);
    const narrowDock = await page.evaluate(async () => {
        const sidebar = document.getElementById('notificationsSidebar');
        const previousWidth = sidebar.style.width;
        sidebar.classList.add('active');
        sidebar.style.width = '240px';
        await new Promise(resolve => setTimeout(resolve, 420));
        const buttons = [...document.querySelectorAll('#appTrayPinnedApps > .capsule-button')];
        const state = {
            labelsHidden: buttons.every(button => getComputedStyle(button.querySelector('.notes-button-label')).display === 'none'),
            accessibleNames: buttons.map(button => button.getAttribute('aria-label')),
            tooltipLabels: buttons.map(button => button.dataset.tooltip),
            iconsVisible: buttons.every(button => {
                const icon = button.querySelector('svg');
                const rect = icon?.getBoundingClientRect();
                return rect?.width >= 17 && rect?.height >= 17;
            }),
            buttonOverflow: buttons.some(button => {
                const buttonRect = button.getBoundingClientRect();
                return [...button.children].some(child => {
                    if (getComputedStyle(child).display === 'none') return false;
                    const childRect = child.getBoundingClientRect();
                    return childRect.left < buttonRect.left - 1 || childRect.right > buttonRect.right + 1;
                });
            }),
            geometry: buttons.map(button => ({
                clientWidth: button.clientWidth,
                scrollWidth: button.scrollWidth,
                width: getComputedStyle(button).width,
                padding: getComputedStyle(button).padding,
                gap: getComputedStyle(button).gap,
            })),
        };
        sidebar.style.width = previousWidth;
        return state;
    });
    assert.equal(narrowDock.labelsHidden, true, `narrow notification dock labels are visible: ${JSON.stringify(narrowDock)}`);
    assert.ok(narrowDock.accessibleNames.every(Boolean), `narrow notification dock buttons have no accessible names: ${JSON.stringify(narrowDock)}`);
    assert.deepEqual(narrowDock.tooltipLabels, narrowDock.accessibleNames, `narrow notification dock hints do not match their accessible names: ${JSON.stringify(narrowDock)}`);
    assert.equal(narrowDock.iconsVisible, true, `narrow notification dock icons are clipped: ${JSON.stringify(narrowDock)}`);
    assert.equal(narrowDock.buttonOverflow, false, `narrow notification dock buttons overflow: ${JSON.stringify(narrowDock)}`);
    await page.$eval('#appTrayPinnedApps > .capsule-button', button => button.focus());
    // Programmatic focus is intentionally not :focus-visible in Chromium.
    // Move away and back with real keyboard input so this assertion exercises
    // the shipped keyboard modality rather than forcing a pseudo-state.
    await page.keyboard.press('Tab');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    await new Promise(resolve => setTimeout(resolve, 220));
    const dockTooltip = await page.$eval('#appTrayPinnedApps > .capsule-button', button => ({
        label: button.getAttribute('aria-label'),
        focused: button.matches(':focus-visible'),
        content: getComputedStyle(button, '::before').content,
        opacity: getComputedStyle(button, '::before').opacity,
        visibility: getComputedStyle(button, '::before').visibility,
    }));
    assert.equal(dockTooltip.focused, true, `app tray keyboard hint trigger is not focused: ${JSON.stringify(dockTooltip)}`);
    assert.equal(dockTooltip.content, `"${dockTooltip.label}"`, `app tray hint has the wrong content: ${JSON.stringify(dockTooltip)}`);
    assert.ok(Number(dockTooltip.opacity) > 0.5, `app tray hint is not visibly transitioning in: ${JSON.stringify(dockTooltip)}`);
    assert.equal(dockTooltip.visibility, 'visible', `app tray hint remains hidden: ${JSON.stringify(dockTooltip)}`);
    await page.waitForFunction(() => Boolean(window.askNovaController), { timeout: timeoutMs });
    const askNovaEntryState = await page.evaluate(() => ({
        buttons: document.querySelectorAll('button[data-ask-nova-target]').length,
        externalAnchors: document.querySelectorAll('a[data-ask-nova-target]').length,
    }));
    assert.equal(askNovaEntryState.buttons, 3, `Ask Nova must expose three modal buttons: ${JSON.stringify(askNovaEntryState)}`);
    assert.equal(askNovaEntryState.externalAnchors, 0, `Ask Nova entries must not navigate directly: ${JSON.stringify(askNovaEntryState)}`);
    await page.evaluate(() => window.topTabManager.openLaunchpad());
    await page.waitForFunction(() => {
        const button = document.querySelector('button[data-ask-nova-target="frontend"]');
        const rect = button?.getBoundingClientRect();
        return document.body.classList.contains('next-ui-launchpad-open')
            && rect?.width > 0
            && rect?.height > 0
            && getComputedStyle(button).visibility !== 'hidden';
    }, { timeout: timeoutMs });
    await page.click('button[data-ask-nova-target="frontend"]');
    await page.waitForFunction(() => Boolean(document.querySelector('.ask-nova-modal-host .ask-nova-dialog')), { timeout: timeoutMs });
    await page.waitForFunction(() => {
        const modal = document.querySelector('.ask-nova-modal-host');
        return modal?.contains(document.activeElement) === true;
    }, { timeout: timeoutMs });
    const askNovaModalState = await page.evaluate(() => {
        const host = document.querySelector('.ask-nova-modal-host');
        const rect = host?.getBoundingClientRect();
        return {
            activeTarget: document.querySelector('.ask-nova-target-tab.active')?.dataset.target || '',
            promptCount: document.querySelectorAll('.ask-nova-prompts button').length,
            hasComposer: Boolean(document.querySelector('.ask-nova-composer textarea')),
            isDialog: document.querySelector('.ask-nova-modal-host [role="dialog"]')?.getAttribute('aria-modal') === 'true'
                || host?.localName === 'wa-dialog',
            visibleOverlay: getComputedStyle(host).position === 'fixed'
                && rect?.width >= window.innerWidth * 0.9
                && rect?.height >= window.innerHeight * 0.9,
        };
    });
    assert.equal(askNovaModalState.activeTarget, 'frontend', `Ask Nova opened the wrong target: ${JSON.stringify(askNovaModalState)}`);
    assert.ok(askNovaModalState.promptCount > 0, `Ask Nova quick prompts missing: ${JSON.stringify(askNovaModalState)}`);
    assert.equal(askNovaModalState.hasComposer, true, `Ask Nova composer missing: ${JSON.stringify(askNovaModalState)}`);
    assert.equal(askNovaModalState.isDialog, true, `Ask Nova modal semantics missing: ${JSON.stringify(askNovaModalState)}`);
    assert.equal(askNovaModalState.visibleOverlay, true, `Ask Nova modal is mounted but not visibly covering the window: ${JSON.stringify(askNovaModalState)}`);
    await capture(page, 'main-ask-nova.png');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.ask-nova-modal-host'), { timeout: timeoutMs });
    await page.click('button[data-ask-nova-target="backend"]');
    await page.waitForFunction(() => {
        const hosts = document.querySelectorAll('.ask-nova-modal-host');
        return hosts.length === 1
            && document.querySelector('.ask-nova-target-tab.active')?.dataset.target === 'backend';
    }, { timeout: timeoutMs });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.ask-nova-modal-host'), { timeout: timeoutMs });
    summary.push({ surface: '主界面 shell', mode: 'next', pass: true, lucide: bootLucide.lucideIcons, note: 'boot: WA 零请求/零注册，Orbitron/Nova/lucide 已载入，上游消息组件语义保留，应用托盘与 Ask Nova 可用' });

    // 2. Open the UI 组件库 internal app; WA must register lazily.
    await page.click('#nextUiAddTabBtn');
    await page.waitForFunction(() => window.topTabManager, { timeout: timeoutMs });
    const showcaseHandle = await page.evaluateHandle(() =>
        [...document.querySelectorAll('.next-ui-internal-app-item')].find(item => item.getAttribute('title') === 'UI 组件库')
    );
    if (await showcaseHandle.evaluate(el => !el)) {
        await page.evaluate(() => window.topTabManager.openInternalApp('ui-component-library'));
    } else {
        await showcaseHandle.asElement().click();
    }
    await page.waitForFunction(() => document.querySelector('.vcp-ui-showcase-root'), { timeout: timeoutMs });
    let waDefined = false;
    while (Date.now() < deadline) {
        waDefined = await page.evaluate(() => Boolean(customElements.get('wa-button')));
        if (waDefined) break;
        await sleep(120);
    }
    assert.ok(waDefined, 'wa-button must register after the showcase opens (lazy load)');
    await page.waitForFunction(
        () => document.querySelector('.vcp-ui-wa-comparison')?.dataset.ready === 'true',
        { timeout: timeoutMs }
    );
    assert.ok(webAwesomeRuntimeRequests.some(url => url.includes('vendor/webawesome-runtime/dist-cdn/components/button')), 'lazy load fetched the generated button runtime');
    await capture(page, 'main-showcase.png');

    // A component-library surface owns only the feedback it creates. Closing
    // it must retract its toast/loading/queued dialog without touching feedback
    // already owned by the main surface.
    const feedbackIsolation = await page.evaluate(async () => {
        window.__p1MainToast = window.VCPUI.feedback.toast('P1 main owner toast', { duration: 0 });
        window.VCPUI.feedback.setLoading(true, 'P1 main owner loading');
        window.__p1MainDialog = window.VCPUI.feedback.confirm({ title: 'P1 main owner dialog', message: 'Must survive showcase close' });
        await new Promise(resolve => setTimeout(resolve, 0));
        const showcase = document.querySelector('.vcp-ui-showcase-root');
        const clickByText = text => {
            const button = [...showcase.querySelectorAll('button')].find(candidate => candidate.textContent.trim() === text);
            button?.click();
            return Boolean(button);
        };
        const clickedToast = clickByText('info');
        const clickedDialog = clickByText('删除项目');
        const clickedLoading = clickByText('模拟加载 1.2 秒');
        await new Promise(resolve => setTimeout(resolve, 0));
        await window.topTabManager.closeView('app:ui-component-library');
        await new Promise(resolve => setTimeout(resolve, 0));
        return {
            clickedToast,
            clickedDialog,
            clickedLoading,
            showcaseClosed: !document.querySelector('.vcp-ui-showcase-root'),
            mainToastPresent: [...document.querySelectorAll('.vcp-ui-toast')].some(item => item.textContent.includes('P1 main owner toast')),
            showcaseToastPresent: [...document.querySelectorAll('.vcp-ui-toast')].some(item => item.textContent.includes('info 通知已触发')),
            dialogTitle: document.querySelector('.vcp-ui-modal h2, wa-dialog')?.getAttribute('label')
                || document.querySelector('.vcp-ui-modal h2')?.textContent
                || '',
            loadingLabel: document.querySelector('.vcp-ui-loading-label')?.textContent || '',
            showcaseScopePresent: window.VCPLifecycle.diagnostics.snapshot().some(item => item.label === 'next:component-showcase'),
        };
    });
    assert.deepEqual(
        { toast: feedbackIsolation.clickedToast, dialog: feedbackIsolation.clickedDialog, loading: feedbackIsolation.clickedLoading },
        { toast: true, dialog: true, loading: true },
        `showcase feedback controls missing: ${JSON.stringify(feedbackIsolation)}`
    );
    assert.equal(feedbackIsolation.showcaseClosed, true, `showcase did not close: ${JSON.stringify(feedbackIsolation)}`);
    assert.equal(feedbackIsolation.mainToastPresent, true, `main toast was removed by showcase: ${JSON.stringify(feedbackIsolation)}`);
    assert.equal(feedbackIsolation.showcaseToastPresent, false, `showcase toast leaked: ${JSON.stringify(feedbackIsolation)}`);
    assert.match(feedbackIsolation.dialogTitle, /P1 main owner dialog/, `main dialog was replaced: ${JSON.stringify(feedbackIsolation)}`);
    assert.equal(feedbackIsolation.loadingLabel, 'P1 main owner loading', `main loading state was replaced: ${JSON.stringify(feedbackIsolation)}`);
    assert.equal(feedbackIsolation.showcaseScopePresent, false, `showcase scope leaked: ${JSON.stringify(feedbackIsolation)}`);
    await page.evaluate(async () => {
        document.querySelector('.vcp-ui-modal footer .vcp-ui-button')?.click();
        await window.__p1MainDialog;
        window.__p1MainToast?.destroy();
        window.VCPUI.feedback.setLoading(false);
        delete window.__p1MainDialog;
        delete window.__p1MainToast;
        window.topTabManager.openInternalApp('ui-component-library');
    });
    await page.waitForFunction(() => document.querySelector('.vcp-ui-showcase-root'), { timeout: timeoutMs });
    summary.push({ surface: 'UI 组件库', mode: 'next', pass: true, lucide: 0, note: 'lazy-registers WA；feedback owner 关闭后不影响主 Surface' });

    // Production WA Modal dismissal must release the creation surface, while
    // the durable create commit point blocks Escape/header/backdrop dismissal.
    // Exercise the real cold path: creation itself owns kernel readiness and
    // must not depend on a prior settings visit to select Web Awesome.
    const preCreationKernel = await page.evaluate(() => window.VCPWebAwesome?.getRuntimeState?.().state || 'missing');
    assert.equal(preCreationKernel, 'idle', `creation test was not a cold WA start: ${preCreationKernel}`);
    const createEntryState = await page.evaluate(async () => {
        window.__nextDeltaOriginalCommands = window.MainChatCommands;
        window.MainChatCommands = {
            ...window.MainChatCommands,
            createAgent: () => new Promise(resolve => { window.__nextDeltaResolveCreate = resolve; }),
        };
        const button = document.getElementById('nextUiCreateItemBtn');
        button?.click();
        await new Promise(resolve => setTimeout(resolve, 250));
        return {
            buttonPresent: Boolean(button),
            controllerMounted: window.VCPNextShellController?.isMounted?.() === true,
            hostPresent: Boolean(document.querySelector('.next-ui-create-dialog-host')),
            dialogTag: document.querySelector('.next-ui-create-dialog-host')?.firstElementChild?.localName || '',
            diagnostics: window.VCPNextShellController?.getDiagnostics?.() || null,
        };
    });
    assert.equal(createEntryState.hostPresent, true,
        `creation entry did not mount a host: ${JSON.stringify(createEntryState)}`);
    assert.equal(createEntryState.dialogTag, 'wa-dialog',
        `creation entry did not select the Web Awesome dialog kernel: ${JSON.stringify(createEntryState)}`);
    await page.waitForFunction(() => Boolean(document.querySelector('.next-ui-create-dialog-host wa-dialog')), { timeout: timeoutMs });
    const creationVisualContract = await page.evaluate(() => {
        const modal = document.querySelector('.next-ui-create-dialog-host wa-dialog');
        const dialog = modal?.shadowRoot?.querySelector('[part~="dialog"]');
        const header = modal?.shadowRoot?.querySelector('[part~="header"]');
        const body = modal?.shadowRoot?.querySelector('[part~="body"]');
        const footer = modal?.shadowRoot?.querySelector('[part~="footer"]');
        const buttons = [...(modal?.querySelectorAll('wa-button') || [])];
        const primary = buttons.find(button => button.dataset.variant === 'primary');
        const cancel = buttons.find(button => button.dataset.variant === 'ghost');
        const rect = dialog?.getBoundingClientRect();
        const primaryBase = primary?.shadowRoot?.querySelector('[part~="base"]');
        const cancelBase = cancel?.shadowRoot?.querySelector('[part~="base"]');
        const input = modal?.querySelector('wa-input');
        const select = modal?.querySelector('wa-select');
        const inputRect = input?.shadowRoot?.querySelector('[part~="input-wrapper"]')?.getBoundingClientRect();
        const selectRect = select?.shadowRoot?.querySelector('[part~="combobox"]')?.getBoundingClientRect();
        const inputInternalLabel = input?.shadowRoot?.querySelector('[part~="form-control-label"]');
        return {
            size: modal?.dataset.size,
            width: rect?.width || 0,
            viewportWidth: innerWidth,
            centerOffset: rect ? Math.abs((rect.left + rect.width / 2) - innerWidth / 2) : Infinity,
            headerDivider: header ? getComputedStyle(header).borderBottomWidth : '0px',
            footerDivider: footer ? getComputedStyle(footer).borderTopWidth : '0px',
            bodyOverflow: body ? getComputedStyle(body).overflowY : '',
            primaryBackground: primaryBase ? getComputedStyle(primaryBase).backgroundColor : '',
            cancelBackground: cancelBase ? getComputedStyle(cancelBase).backgroundColor : '',
            inputLeft: inputRect?.left || 0,
            inputWidth: inputRect?.width || 0,
            selectLeft: selectRect?.left || 0,
            selectWidth: selectRect?.width || 0,
            inputInternalLabelDisplay: inputInternalLabel ? getComputedStyle(inputInternalLabel).display : '',
            inputAutofocus: input?.hasAttribute('autofocus') === true,
            activeTag: document.activeElement?.localName || '',
        };
    });
    assert.equal(creationVisualContract.size, 'sm', `creation size contract was lost: ${JSON.stringify(creationVisualContract)}`);
    assert.ok(creationVisualContract.width > 300 && creationVisualContract.width <= 410,
        `creation dialog leaked the Web Awesome default width: ${JSON.stringify(creationVisualContract)}`);
    assert.ok(creationVisualContract.centerOffset <= 2,
        `creation dialog is not centered: ${JSON.stringify(creationVisualContract)}`);
    assert.notEqual(creationVisualContract.headerDivider, '0px',
        `creation header divider is missing: ${JSON.stringify(creationVisualContract)}`);
    assert.notEqual(creationVisualContract.footerDivider, '0px',
        `creation footer divider is missing: ${JSON.stringify(creationVisualContract)}`);
    assert.notEqual(creationVisualContract.primaryBackground, creationVisualContract.cancelBackground,
        `creation primary action lost its accent treatment: ${JSON.stringify(creationVisualContract)}`);
    assert.ok(Math.abs(creationVisualContract.inputLeft - creationVisualContract.selectLeft) <= 1
        && Math.abs(creationVisualContract.inputWidth - creationVisualContract.selectWidth) <= 1,
    `creation Input and Select are not aligned: ${JSON.stringify(creationVisualContract)}`);
    assert.equal(creationVisualContract.inputInternalLabelDisplay, 'none',
        `Field-owned WA Input exposed a duplicate required marker: ${JSON.stringify(creationVisualContract)}`);
    assert.equal(creationVisualContract.inputAutofocus, true,
        `creation input does not own initial focus: ${JSON.stringify(creationVisualContract)}`);
    assert.equal(creationVisualContract.activeTag, 'wa-input',
        `creation focus moved after opening: ${JSON.stringify(creationVisualContract)}`);
    await page.evaluate(() => window.uiManager?.applyTheme?.('dark'));
    await page.waitForFunction(() => document.querySelector('.next-ui-create-dialog-host')?.classList.contains('wa-dark'), { timeout: timeoutMs });
    const readCreationTheme = () => page.evaluate(() => {
        const host = document.querySelector('.next-ui-create-dialog-host');
        const probe = document.createElement('div');
        probe.style.background = 'var(--wa-color-surface-raised)';
        probe.style.color = 'var(--wa-color-text-normal)';
        host?.append(probe);
        const style = getComputedStyle(probe);
        const result = {
            background: style.backgroundColor,
            color: style.color,
            light: host?.classList.contains('wa-light') === true,
            dark: host?.classList.contains('wa-dark') === true,
        };
        probe.remove();
        return result;
    });
    const channel = value => Number(value.match(/[\d.]+/g)?.[0] || 0);
    const darkCreationTheme = await readCreationTheme();
    assert.equal(darkCreationTheme.dark, true, `dark creation theme class missing: ${JSON.stringify(darkCreationTheme)}`);
    assert.ok(channel(darkCreationTheme.background) < 100,
        `dark creation surface resolved to a light background: ${JSON.stringify(darkCreationTheme)}`);
    await page.evaluate(() => window.uiManager?.applyTheme?.('light'));
    await page.waitForFunction(() => document.querySelector('.next-ui-create-dialog-host')?.classList.contains('wa-light'), { timeout: timeoutMs });
    const lightCreationTheme = await readCreationTheme();
    assert.equal(lightCreationTheme.light, true, `light creation theme class missing: ${JSON.stringify(lightCreationTheme)}`);
    assert.ok(channel(lightCreationTheme.background) > 180,
        `light creation surface did not resolve to a light background: ${JSON.stringify(lightCreationTheme)}`);
    await page.evaluate(() => window.uiManager?.applyTheme?.('dark'));
    await page.waitForFunction(() => document.querySelector('.next-ui-create-dialog-host')?.classList.contains('wa-dark'), { timeout: timeoutMs });
    const creationSelectPoint = await page.evaluate(async () => {
        const modal = document.querySelector('.next-ui-create-dialog-host wa-dialog');
        const select = modal?.querySelector('wa-select');
        select.disabled = false;
        const option = document.createElement('wa-option');
        option.value = 'dismiss-regression-model';
        option.textContent = 'Dismiss regression model';
        select.append(option);
        await select.updateComplete;
        await select.show();
        const rect = option.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(creationSelectPoint.x, creationSelectPoint.y);
    await new Promise(resolve => setTimeout(resolve, 100));
    const creationSelectionState = await page.evaluate(() => {
        const host = document.querySelector('.next-ui-create-dialog-host');
        return { connected: Boolean(host), value: host?.querySelector('wa-select')?.value || '' };
    });
    assert.equal(creationSelectionState.connected, true,
        `selecting a WA option dismissed the creation modal: ${JSON.stringify(creationSelectionState)}`);
    assert.equal(creationSelectionState.value, 'dismiss-regression-model',
        `selecting a WA option dismissed the creation modal: ${JSON.stringify(creationSelectionState)}`);
    const creationDismissPoints = await page.evaluate(() => {
        const modal = document.querySelector('.next-ui-create-dialog-host wa-dialog');
        const dialog = modal?.shadowRoot?.querySelector('[part~="dialog"]')?.getBoundingClientRect();
        const body = modal?.shadowRoot?.querySelector('[part~="body"]')?.getBoundingClientRect();
        return {
            inside: { x: (body?.right || 0) - 4, y: (body?.top || 0) + 4 },
            outside: { x: Math.max(2, (dialog?.left || 30) - 16), y: (dialog?.top || 0) + (dialog?.height || 0) / 2 },
        };
    });
    await page.mouse.click(creationDismissPoints.inside.x, creationDismissPoints.inside.y);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('.next-ui-create-dialog-host'))), true,
        'clicking dialog whitespace after opening Select must not dismiss the creation modal');
    await page.mouse.click(creationDismissPoints.outside.x, creationDismissPoints.outside.y);
    await page.waitForFunction(() => !document.querySelector('.next-ui-create-dialog-host'), { timeout: timeoutMs });

    await page.evaluate(() => document.getElementById('nextUiCreateItemBtn')?.click());
    await page.waitForFunction(() => Boolean(document.querySelector('.next-ui-create-dialog-host wa-dialog')), { timeout: timeoutMs });
    const lockedCreateDismissal = await page.evaluate(async () => {
        const host = document.querySelector('.next-ui-create-dialog-host');
        const form = host?.querySelector('.next-ui-create-dialog-form');
        const name = form?.querySelector('wa-input, input');
        if (name) {
            name.value = 'Delta Contract Agent';
            name.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        }
        form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        const dialog = host?.querySelector('wa-dialog');
        const hide = new CustomEvent('wa-hide', { bubbles: true, cancelable: true });
        dialog?.dispatchEvent(hide);
        return {
            blocked: hide.defaultPrevented,
            connected: Boolean(host?.isConnected),
        };
    });
    assert.deepEqual(lockedCreateDismissal, { blocked: true, connected: true },
        `durable creation did not lock WA dismissal: ${JSON.stringify(lockedCreateDismissal)}`);
    await page.evaluate(() => window.__nextDeltaResolveCreate?.({ success: false, error: 'controlled creation failure' }));
    await page.waitForFunction(() => {
        const host = document.querySelector('.next-ui-create-dialog-host');
        return host?.textContent?.includes('controlled creation failure');
    }, { timeout: timeoutMs });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.next-ui-create-dialog-host'), { timeout: timeoutMs });
    await page.evaluate(() => {
        window.MainChatCommands = {
            ...window.MainChatCommands,
            createAgent: async () => ({ success: true, navigationSuccess: true }),
        };
        document.getElementById('nextUiCreateItemBtn')?.click();
    });
    await page.waitForFunction(() => Boolean(document.querySelector('.next-ui-create-dialog-host wa-dialog')), { timeout: timeoutMs });
    await page.evaluate(() => {
        const host = document.querySelector('.next-ui-create-dialog-host');
        const input = host?.querySelector('wa-input, input');
        if (input) {
            input.value = 'Successful Delta Agent';
            input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        }
        host?.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => !document.querySelector('.next-ui-create-dialog-host'), { timeout: timeoutMs });
    await page.evaluate(() => {
        window.MainChatCommands = window.__nextDeltaOriginalCommands;
        delete window.__nextDeltaOriginalCommands;
        delete window.__nextDeltaResolveCreate;
    });
    // A terminal component-load failure must keep the same creation task
    // usable through the native kernel; it must not create a second form.
    await page.evaluate(() => {
        window.__nextDeltaOriginalWebAwesome = window.VCPWebAwesome;
        window.VCPWebAwesome = Object.freeze({
            ...window.VCPWebAwesome,
            loadComponents: async () => { throw new Error('controlled WA load failure'); },
            getRuntimeState: () => ({ state: 'failed', components: [], error: 'controlled WA load failure' }),
            isDefined: () => false,
            isLoaded: () => false,
        });
        document.getElementById('nextUiCreateItemBtn')?.click();
    });
    await page.waitForFunction(() => Boolean(document.querySelector('.next-ui-create-dialog-host')), { timeout: timeoutMs });
    const fallbackCreation = await page.evaluate(() => ({
        host: Boolean(document.querySelector('.next-ui-create-dialog-host')),
        nativeInputs: document.querySelectorAll('.next-ui-create-dialog-host input, .next-ui-create-dialog-host select, .next-ui-create-dialog-host textarea').length,
        webAwesomeInputs: document.querySelectorAll('.next-ui-create-dialog-host wa-input, .next-ui-create-dialog-host wa-select').length,
        formCount: document.querySelectorAll('.next-ui-create-dialog-host form').length,
    }));
    assert.equal(fallbackCreation.host, true, `failed WA creation did not retain a surface: ${JSON.stringify(fallbackCreation)}`);
    assert.equal(fallbackCreation.formCount, 1, `fallback creation created duplicate forms: ${JSON.stringify(fallbackCreation)}`);
    assert.ok(fallbackCreation.nativeInputs > 0, `fallback creation did not use native controls: ${JSON.stringify(fallbackCreation)}`);
    assert.equal(fallbackCreation.webAwesomeInputs, 0, `fallback creation mounted Web Awesome controls: ${JSON.stringify(fallbackCreation)}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.next-ui-create-dialog-host'), { timeout: timeoutMs });
    await page.evaluate(() => {
        window.VCPWebAwesome = window.__nextDeltaOriginalWebAwesome;
        delete window.__nextDeltaOriginalWebAwesome;
    });
    summary.push({ surface: '创建助手 Modal', mode: 'next', pass: true, lucide: 0, note: 'WA 单一实现覆盖冷启动/主题/故障提示，提交和关闭生命周期可控' });

    // 3. Global settings modal is enhanced in next mode + keyboard flow.
    await page.waitForFunction(() => document.documentElement.dataset.uiMode === 'next', { timeout: timeoutMs });
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.getElementById('globalSettingsForm'), { timeout: timeoutMs });
    await page.waitForFunction(() => {
        const footer = document.getElementById('globalSettingsModal')?.querySelector('.global-settings-footer');
        return footer?.classList.contains('vcp-ui-settings-action-bar');
    }, { timeout: timeoutMs });
    await page.waitForFunction(
        () => document.querySelectorAll('#globalSettingsModal wa-select.vcp-ui-select-proxy').length > 0,
        { timeout: timeoutMs }
    );
    const settingsState = await page.evaluate(() => {
        const form = document.getElementById('globalSettingsForm');
        const footer = form.closest('#globalSettingsModal')?.querySelector('.global-settings-footer');
        const userName = document.getElementById('userName');
        const state = { inputClass: userName?.className || '', footerClass: footer?.className || '', hasSearch: Boolean(document.querySelector('.vcp-ui-settings-search')) };
        userName?.dispatchEvent(new Event('input', { bubbles: true }));
        return new Promise(resolve => {
            setTimeout(() => resolve({ ...state, footerState: footer?.dataset.state || '' }), 50);
        });
    });
    assert.ok(settingsState.inputClass.includes('vcp-ui-native-input'), `global settings input not enhanced: ${settingsState.inputClass}`);
    assert.ok(settingsState.footerClass.includes('vcp-ui-settings-action-bar'), `save bar not enhanced: ${settingsState.footerClass}`);
    assert.ok(settingsState.hasSearch, 'settings search not injected');
    assert.equal(settingsState.footerState, 'dirty', `save bar should be dirty after input: ${settingsState.footerState}`);
    const settingsSelectState = await page.evaluate(() => {
        const modal = document.getElementById('globalSettingsModal');
        return {
            native: modal?.querySelectorAll('select.vcp-ui-select-source').length || 0,
            proxies: modal?.querySelectorAll('wa-select.vcp-ui-select-proxy').length || 0,
            visibleNative: [...(modal?.querySelectorAll('select.vcp-ui-select-source') || [])]
                .filter(select => !select.hidden && getComputedStyle(select).display !== 'none').length,
        };
    });
    assert.ok(settingsSelectState.native > 0, `global settings Select sources missing: ${JSON.stringify(settingsSelectState)}`);
    assert.equal(settingsSelectState.proxies, settingsSelectState.native, `global settings Select proxies mismatch: ${JSON.stringify(settingsSelectState)}`);
    assert.equal(settingsSelectState.visibleNative, 0, `global settings native Select is still visible: ${JSON.stringify(settingsSelectState)}`);
    await capture(page, 'main-settings-next.png');
    // Focus lands on the first field inside the open modal.
    const settingsFocus = await page.evaluate(() => {
        const modal = document.getElementById('globalSettingsModal');
        const input = modal?.querySelector('input:not([type="hidden"])');
        if (!input) return { focused: false };
        input.focus();
        return { focused: document.activeElement === input, active: document.activeElement?.id || '' };
    });
    assert.ok(settingsFocus.focused, `global settings did not take focus: ${JSON.stringify(settingsFocus)}`);
    await page.evaluate(() => window.uiHelperFunctions.closeModal('globalSettingsModal'));
    summary.push({ surface: '全局设置', mode: 'next', pass: true, lucide: 0, note: '增强输入/保存栏 dirty 态/搜索注入/焦点' });

    // Agent settings are a renderer-owned surface and must not create child
    // WebContents or accumulate VCPUI adapters when repeatedly revisited.
    await page.evaluate(() => window.topTabManager.setView('home'));
    await page.waitForSelector('#agentList [data-item-id="SmokeAgent"]', { timeout: timeoutMs });
    await page.click('#agentList [data-item-id="SmokeAgent"]');
    await page.evaluate(() => window.uiManager.switchToTab('settings'));
    await page.waitForFunction(() => document.getElementById('editingAgentId')?.value === 'SmokeAgent', { timeout: timeoutMs });
    const settingsProcessBaseline = (await browser.pages()).length;
    const settingsDomBaseline = await page.evaluate(() => ({
        enhanced: window.VCPUISettingsBridge?.enhancedCount || 0,
        promptNodes: document.querySelectorAll('#systemPromptContainer *').length,
    }));
    for (let cycle = 0; cycle < 20; cycle += 1) {
        await page.evaluate(() => {
            window.uiManager.switchToTab('agents');
            window.uiManager.switchToTab('settings');
            return window.settingsManager.displaySettingsForItem();
        });
    }
    await sleep(250);
    const settingsDomAfter = await page.evaluate(() => ({
        enhanced: window.VCPUISettingsBridge?.enhancedCount || 0,
        promptNodes: document.querySelectorAll('#systemPromptContainer *').length,
    }));
    assert.equal((await browser.pages()).length, settingsProcessBaseline, 'agent settings visits leaked renderer/WebContents processes');
    assert.equal(settingsDomAfter.enhanced, settingsDomBaseline.enhanced, `agent settings adapters accumulated: ${JSON.stringify({ settingsDomBaseline, settingsDomAfter })}`);
    assert.ok(settingsDomAfter.promptNodes <= settingsDomBaseline.promptNodes + 4, `agent prompt DOM accumulated: ${JSON.stringify({ settingsDomBaseline, settingsDomAfter })}`);
    summary.push({ surface: 'Agent 设置生命周期', mode: 'next', pass: true, lucide: 0, note: '20 次往返不增加 WebContents、VCPUI adapter 或提示词 DOM' });

    // 4. Active child presentations plus upstream-Classic host integration.
    await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify(embeddedNextSettings), 'utf8');
    for (const app of EMBEDDED_APPS) {
        console.log(`[electron-ui-apps] opening ${app.name}`);
        const label = `next:${app.name}`;
        await page.evaluate((appDefinition) => window.topTabManager.openEmbeddedApp(appDefinition), {
            id: app.id, action: app.action, name: app.name,
        });
        const childPage = await waitForChildPage(browser, app.key, Date.now() + timeoutMs, app.name);
        instrument(childPage, label);
        if (app.nextEnabled) {
            await auditNextPage(childPage, app, `next-${app.name}.png`);
        } else {
            await auditUpstreamClassicPage(childPage, app, `upstream-classic-${app.name}.png`);
        }
        const errors = collectRealErrors(label);
        assert.equal(errors.length, 0, `${app.name} renderer errors:\n${errors.slice(0, 8).join('\n')}`);
        summary.push(app.nextEnabled
            ? { surface: app.name, mode: 'next', pass: true, lucide: 0, note: `shell + ${Object.entries(app.minWa || {}).map(([t, n]) => `${n}+<${t}>`).join(', ')}，native增强>=${app.minNativeEnhanced || 0}，无溢出/重叠/报错` }
            : { surface: app.name, mode: 'upstream-classic', pass: true, lucide: 0, note: '通用宿主打开上游经典页面，未携带实验性 Next 实现' });
        if (app.action === 'open-note-mini-window') {
            // The upstream sticky-note page maps Escape to closeWindow(). In
            // an embedded WebContentsView that must dispose only its tab,
            // never the owning VCPChat BrowserWindow. Repeat the path to catch
            // delayed renderer destruction/process accumulation.
            await pressEscapeAndAllowTargetClose(childPage);
            await ensureChildPageClosed(browser, app.key, Date.now() + timeoutMs, app.name);
            await page.waitForFunction(
                viewId => !document.querySelector(`[data-view-id="${viewId}"]`),
                { timeout: timeoutMs },
                `app:${app.id}`
            );
            assert.equal(page.isClosed(), false, 'embedded Escape cascaded into the main window');
            for (let cycle = 0; cycle < 4; cycle += 1) {
                console.log(`[electron-ui-apps] reopening ${app.name} cycle ${cycle + 1}`);
                await page.evaluate((appDefinition) => window.topTabManager.openEmbeddedApp(appDefinition), {
                    id: app.id, action: app.action, name: app.name,
                });
                const reopened = await waitForChildPage(browser, app.key, Date.now() + timeoutMs, `${app.name} cycle ${cycle + 1}`);
                await pressEscapeAndAllowTargetClose(reopened);
                await ensureChildPageClosed(browser, app.key, Date.now() + timeoutMs, `${app.name} cycle ${cycle + 1}`);
                assert.equal(page.isClosed(), false, `embedded Escape closed main window in cycle ${cycle + 1}`);
            }
            continue;
        }
        await page.evaluate((appDefinition) => window.topTabManager.closeView(`app:${appDefinition.id}`), { id: app.id });
        await ensureChildPageClosed(browser, app.key, Date.now() + timeoutMs, app.name);
    }

    // 5. Classic mode: embedded pages must keep the legacy DOM and never mount
    //    the next surface. Flip the project AppData settings the same way a
    //    user switching mode does, then walk a representative subset.
    await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify(classicSettings), 'utf8');
    await writeProjectUiMode('classic');
    for (const app of EMBEDDED_APPS) {
        const label = `classic:${app.name}`;
        await page.evaluate((appDefinition) => window.topTabManager.openEmbeddedApp(appDefinition), {
            id: app.id, action: app.action, name: app.name,
        });
        const childPage = await waitForChildPage(browser, app.key, Date.now() + timeoutMs, app.name);
        instrument(childPage, label);
        await childPage.waitForFunction((selector) => document.querySelector(selector), { timeout: timeoutMs }, app.legacySelector);
        await sleep(300);
        const classicState = await childPage.evaluate((legacySelector) => ({
            uiMode: document.documentElement.dataset.uiMode || 'classic',
            hasShell: Boolean(document.querySelector('.vcp-ui-page-shell')),
            waCount: document.querySelectorAll('wa-button, wa-input, wa-select, wa-card, wa-tooltip').length,
            bodyScope: document.body.classList.contains('vcp-ui-scope'),
            legacyPresent: Boolean(document.querySelector(legacySelector)),
        }), app.legacySelector);
        assert.equal(classicState.uiMode, 'classic', `${app.name} classic mode wrong: ${JSON.stringify(classicState)}`);
        assert.equal(classicState.hasShell, false, `${app.name} must not mount AppPageShell in classic: ${JSON.stringify(classicState)}`);
        assert.equal(classicState.waCount, 0, `${app.name} must not register WA in classic: ${JSON.stringify(classicState)}`);
        assert.equal(classicState.bodyScope, false, `${app.name} body must not be vcp-ui-scope in classic: ${JSON.stringify(classicState)}`);
        assert.ok(classicState.legacyPresent, `${app.name} legacy DOM missing in classic: ${JSON.stringify(classicState)}`);
        await capture(childPage, `classic-${app.name}.png`);
        summary.push({ surface: app.name, mode: 'classic', pass: true, lucide: 0, note: '旧 DOM 保留，next 表面未挂载，无 WA' });
        await page.evaluate((appDefinition) => window.topTabManager.closeView(`app:${appDefinition.id}`), { id: app.id });
        await ensureChildPageClosed(browser, app.key, Date.now() + timeoutMs, app.name);
    }
    await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify(nextSettings), 'utf8');
    await writeProjectUiMode('next');

    // 6. Main renderer: a legacy Classic request stays on the canonical layout.
    assert.equal(await page.evaluate(() => document.documentElement.dataset.uiMode), 'next');
    await page.waitForFunction(() => {
        const input = document.getElementById('globalSettingsForm')?.querySelector('input[id]');
        return !input || !input.className.includes('vcp-ui-native-input');
    }, { timeout: timeoutMs });
    const classicMainStyle = await page.evaluate(() => ({
        fontSize: getComputedStyle(document.body).fontSize,
        materialOpticsPresent: Boolean(document.getElementById('vcpMaterialOptics')),
        classicTitlebarPresent: Boolean(document.querySelector('.title-bar')),
        nextTopbarHidden: getComputedStyle(document.getElementById('nextUiTopbar')).display === 'none',
        nextSettingsShellPresent: Boolean(document.querySelector('#globalSettingsModal .vcp-ui-settings-shell')),
        webAwesomeElementCount: document.querySelectorAll('wa-button, wa-input, wa-textarea, wa-select, wa-switch, wa-checkbox').length,
        composerButtons: ['quickNewTopicBtn', 'attachFileBtn', 'emoticonTriggerBtn', 'sendMessageBtn'].map(id => {
            const button = document.getElementById(id);
            const style = getComputedStyle(button);
            return {
                id,
                hasSvg: Boolean(button?.querySelector('svg')),
                leakedText: [...button?.childNodes || []]
                    .filter(node => node.nodeType === Node.TEXT_NODE)
                    .map(node => node.textContent.trim())
                    .filter(Boolean),
                width: style.width,
                height: style.height,
            };
        }),
        classicNotificationControls: ['openForumBtn', 'doNotDisturbBtn', 'clearNotificationsBtn']
            .map(id => ({ id, present: Boolean(document.getElementById(id)) })),
        wallpaperControlPresent: Boolean(document.getElementById('vchat-dynamic-wallpaper-panel')),
        wallpaperControlHasSvg: Boolean(document.querySelector('#vchat-dynamic-wallpaper-panel .vchat-wallpaper-toggle svg')),
        wallpaperControlLeakedText: [...document.querySelector('#vchat-dynamic-wallpaper-panel .vchat-wallpaper-toggle')?.childNodes || []]
            .filter(node => node.nodeType === Node.TEXT_NODE)
            .map(node => node.textContent.trim())
            .filter(Boolean),
    }));
    assert.equal(classicMainStyle.fontSize, '16px', `legacy mode request changed canonical typography: ${JSON.stringify(classicMainStyle)}`);
    assert.equal(classicMainStyle.materialOpticsPresent, true, `legacy mode request tore down canonical material state: ${JSON.stringify(classicMainStyle)}`);
    assert.equal(classicMainStyle.classicTitlebarPresent, false, `retired title bar remains in the DOM: ${JSON.stringify(classicMainStyle)}`);
    assert.equal(classicMainStyle.nextTopbarHidden, false, `canonical top bar disappeared: ${JSON.stringify(classicMainStyle)}`);
    assert.equal(classicMainStyle.nextSettingsShellPresent, true, `canonical SettingsShell disappeared: ${JSON.stringify(classicMainStyle)}`);
    assert.ok(classicMainStyle.webAwesomeElementCount > 0, `canonical controls disappeared: ${JSON.stringify(classicMainStyle)}`);
    classicMainStyle.composerButtons.forEach(button => {
        assert.equal(button.hasSvg, true, `shared composer button lost its SVG icon: ${JSON.stringify(button)}`);
        assert.deepEqual(button.leakedText, [], `shared composer button exposed icon text: ${JSON.stringify(button)}`);
        assert.notEqual(button.width, 'auto', `shared composer button has unstable width: ${JSON.stringify(button)}`);
        assert.notEqual(button.height, 'auto', `shared composer button has unstable height: ${JSON.stringify(button)}`);
    });
    classicMainStyle.classicNotificationControls.forEach(control => {
        assert.equal(control.present, false, `retired notification proxy remains hidden in the DOM: ${JSON.stringify(control)}`);
    });
    assert.equal(classicMainStyle.wallpaperControlPresent, true, `Classic video wallpaper control is missing: ${JSON.stringify(classicMainStyle)}`);
    assert.equal(classicMainStyle.wallpaperControlHasSvg, true, `Classic video wallpaper control lost its SVG icon: ${JSON.stringify(classicMainStyle)}`);
    assert.deepEqual(classicMainStyle.wallpaperControlLeakedText, [], `Classic video wallpaper control exposed icon text: ${JSON.stringify(classicMainStyle)}`);

    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout: timeoutMs });
    const classicSettingsNavigation = await page.evaluate(async () => {
        const modal = document.getElementById('globalSettingsModal');
        const navItems = [...modal.querySelectorAll('.vcp-ui-list-item')];
        const target = navItems[1];
        target?.click();
        await new Promise(resolve => setTimeout(resolve, 220));
        return {
            navCount: navItems.length,
            activeSection: modal.querySelector('.settings-section.active')?.id || '',
            nextShell: Boolean(modal.querySelector('.vcp-ui-settings-shell')),
        };
    });
    assert.equal(classicSettingsNavigation.navCount, 8, `Classic settings category count changed: ${JSON.stringify(classicSettingsNavigation)}`);
    assert.equal(classicSettingsNavigation.activeSection, 'section-server-connection', `Classic settings content did not follow navigation: ${JSON.stringify(classicSettingsNavigation)}`);
    assert.equal(classicSettingsNavigation.nextShell, true, `canonical SettingsShell was not retained: ${JSON.stringify(classicSettingsNavigation)}`);
    const classicAppearanceSettings = await page.evaluate(async () => {
        const modal = document.getElementById('globalSettingsModal');
        const appearanceNav = [...modal.querySelectorAll('.vcp-ui-list-item')][2];
        appearanceNav?.click();
        await new Promise(resolve => setTimeout(resolve, 220));
        const workbench = modal.querySelector('.appearance-workbench-card');
        const layoutSelector = modal.querySelector('.appearance-layout-selector');
        const layoutOption = modal.querySelector('.appearance-layout-option');
        const homeVisual = modal.querySelector('.appearance-home-visual-setting');
        return {
            activeSection: modal.querySelector('.settings-section.active')?.id || '',
            workbenchDisplay: workbench ? getComputedStyle(workbench).display : '',
            workbenchColumns: workbench ? getComputedStyle(workbench).gridTemplateColumns : '',
            layoutBorder: layoutSelector ? getComputedStyle(layoutSelector).borderTopStyle : '',
            layoutRadius: layoutOption ? getComputedStyle(layoutOption).borderTopLeftRadius : '',
            homeVisualDisplay: homeVisual ? getComputedStyle(homeVisual).display : '',
        };
    });
    assert.equal(classicAppearanceSettings.activeSection, 'section-appearance-settings', `Classic appearance section did not open: ${JSON.stringify(classicAppearanceSettings)}`);
    assert.equal(classicAppearanceSettings.workbenchDisplay, 'grid', `Classic appearance workbench fell back to unstyled flow: ${JSON.stringify(classicAppearanceSettings)}`);
    assert.notEqual(classicAppearanceSettings.workbenchColumns, 'none', `Classic appearance workbench columns are missing: ${JSON.stringify(classicAppearanceSettings)}`);
    assert.equal(classicAppearanceSettings.layoutBorder, '', `retired layout selector remains visible: ${JSON.stringify(classicAppearanceSettings)}`);
    assert.equal(classicAppearanceSettings.layoutRadius, '', `retired layout option remains visible: ${JSON.stringify(classicAppearanceSettings)}`);
    assert.equal(classicAppearanceSettings.homeVisualDisplay, 'flex', `Classic home visual controls are not aligned: ${JSON.stringify(classicAppearanceSettings)}`);
    await capture(page, 'main-settings-classic.png');
    await page.evaluate(() => window.uiHelperFunctions.closeModal('globalSettingsModal'));
    summary.push({ surface: '主窗口与全局设置', mode: 'canonical', pass: true, lucide: 0, note: '旧 Classic 配置无法拆卸唯一布局，共享输入、通知、壁纸与设置保持可用' });

    console.log('Electron UI apps smoke passed (canonical main layout plus upstream-Classic child host integration).');
} catch (error) {
    console.error(`Electron UI apps smoke failed:\n${error?.stack || error}`);
    for (const [label, errors] of [...pageErrors, ...consoleErrors]) {
        if (errors.length) console.error(`\n${label} errors:\n${errors.slice(0, 12).map(line => `- ${line}`).join('\n')}`);
    }
    process.exitCode = 1;
} finally {
    child.kill();
    browser?.disconnect();
    await new Promise(resolve => setTimeout(resolve, 300));
    child.kill('SIGKILL');
}

// ── Report ────────────────────────────────────────────────────────────────
const pass = summary.filter(item => item.pass).length;
console.log(`\nUI apps audit summary (${pass}/${summary.length} passed):`);
for (const item of summary) {
    console.log(`  [${item.mode}] ${item.surface}: ${item.pass ? 'PASS' : 'FAIL'} — ${item.note}`);
}
if (process.exitCode) process.exitCode = 1;
