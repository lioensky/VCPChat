// test-settings-wa-electron — real Electron verification + screenshots for the
// global settings modal in Next UI (R5.1 SettingsShell).
//
// Verifies against the real app:
//   - the modal is rebuilt into the SettingsShell layout (VCPUI List category
//     nav + VCPUI search + fixed save bar) only in next mode,
//   - switching categories keeps unsaved values in the DOM,
//   - the search locates and activates the matching category,
//   - a real save persists through IPC to settings.json, the modal closes, and
//     a page reload (reopen) restores the saved value from disk,
//   - captures 700×500 light/dark screenshots under screenshots/.
//
// Usage: node scripts/test-settings-wa-electron.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const screenshotsDir = path.join(root, 'screenshots');
const darkShot = path.join(screenshotsDir, 'settings-wa-dark-700x500.png');
const lightShot = path.join(screenshotsDir, 'settings-wa-light-700x500.png');

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

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-settings-wa-electron-'));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next',
    enableDistributedServer: false,
    vcpServerUrl: 'http://127.0.0.1:1',
    vcpApiKey: 'smoke-test-key',
    continueWritingPrompt: '请继续',
    userName: '初始用户',
}), 'utf8');
await fs.mkdir(screenshotsDir, { recursive: true });
const port = await freePort();
const stderr = { value: '' };
const rendererErrors = [];
const child = spawn(electron, ['.', '--allow-multiple-instances', `--remote-debugging-port=${port}`], {
    cwd: root,
    env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
});
child.stderr.on('data', (chunk) => { stderr.value = `${stderr.value}${chunk}`.slice(-12_000); });

async function resizeWindow(page, browser, width, height) {
    // Resize the OS window so a 700×500 screenshot covers the whole modal.
    // Browser.* CDP commands require the browser-level target session.
    try {
        const browserTarget = browser.targets().find((target) => target.type() === 'browser');
        const session = await browserTarget.createCDPSession();
        const { windowId } = await session.send('Browser.getWindowForTarget', { targetId: page.target()._targetId });
        await session.send('Browser.setWindowBounds', { windowId, bounds: { width, height } });
        await session.detach();
    } catch (error) {
        console.warn(`[test-settings-wa-electron] window resize skipped: ${error?.message}`);
    }
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
}

async function setTheme(page, theme) {
    await page.evaluate((name) => {
        document.body.classList.remove('light-theme', 'dark-theme');
        document.body.classList.add(`${name}-theme`);
    }, theme);
    await new Promise(resolve => setTimeout(resolve, 250));
}

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
    page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error?.stack || error}`));
    page.on('console', (message) => {
        if (message.type() === 'error') rendererErrors.push(`console.error: ${message.text()}`);
    });

    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    await page.waitForFunction(() => document.documentElement.dataset.uiMode === 'next', { timeout: timeoutMs });

    // ---- 1. SettingsShell layout ----
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.getElementById('globalSettingsForm'), { timeout: timeoutMs });
    await page.waitForFunction(() => document.querySelector('#globalSettingsModal .vcp-ui-settings-shell'), { timeout: timeoutMs });
    const shellState = await page.evaluate(() => {
        const modal = document.getElementById('globalSettingsModal');
        const navItems = modal.querySelectorAll('.vcp-ui-list-item');
        const search = modal.querySelector('.vcp-ui-settings-search input[type="search"]');
        const footer = modal.querySelector('.global-settings-footer');
        return {
            shell: Boolean(modal.querySelector('.vcp-ui-settings-shell')),
            navCount: navItems.length,
            searchInNav: Boolean(modal.querySelector('.global-settings-nav .vcp-ui-settings-search')),
            searchEnhanced: search?.classList.contains('vcp-ui-native-input') || false,
            footerEnhanced: footer?.classList.contains('vcp-ui-settings-action-bar') || false,
            sectionIds: [...modal.querySelectorAll('.settings-section')].map(section => section.id),
            activeSection: modal.querySelector('.settings-section.active')?.id,
            iconReplaced: Boolean(modal.querySelector('#resetUserAvatarColorsBtn [data-lucide]')),
        };
    });
    assert.ok(shellState.shell, 'SettingsShell class applied');
    assert.equal(shellState.navCount, 8, '8 categories in VCPUI List nav');
    assert.ok(shellState.searchInNav, 'search field pinned in the left rail');
    assert.ok(shellState.searchEnhanced, 'search input is VCPUI-enhanced');
    assert.ok(shellState.footerEnhanced, 'save bar is SettingsActionBar-enhanced');
    assert.equal(shellState.sectionIds.length, 8, '8 setting sections present');
    assert.equal(shellState.activeSection, 'section-user-identity', 'starts on user identity');
    // Icons inside the form are normalized to VCPUI Lucide icons (the lucide
    // adapter renders the marker span into an svg shortly after insertion).
    await page.waitForFunction(() => {
        const btn = document.getElementById('resetUserAvatarColorsBtn');
        return Boolean(btn?.querySelector('[data-vcp-icon]') || btn?.querySelector('span.vcp-ui-icon'));
    }, { timeout: timeoutMs });
    console.log('  [PASS] 1. SettingsShell layout (nav list, search, save bar, sections, icons)');

    // ---- 2. Category switching keeps unsaved values ----
    await page.evaluate(() => {
        const input = document.getElementById('userName');
        input.value = '未保存测试';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => document.querySelectorAll('#globalSettingsModal .vcp-ui-list-item')[1].click());
    await new Promise(resolve => setTimeout(resolve, 80));
    const switchState = await page.evaluate(() => ({
        active: document.querySelector('#globalSettingsModal .settings-section.active')?.id,
    }));
    assert.equal(switchState.active, 'section-server-connection', 'nav switched to server connection');
    await page.evaluate(() => document.querySelectorAll('#globalSettingsModal .vcp-ui-list-item')[0].click());
    await new Promise(resolve => setTimeout(resolve, 80));
    const backState = await page.evaluate(() => ({
        active: document.querySelector('#globalSettingsModal .settings-section.active')?.id,
        userName: document.getElementById('userName')?.value,
    }));
    assert.equal(backState.active, 'section-user-identity', 'nav switched back');
    assert.equal(backState.userName, '未保存测试', 'unsaved value survived the category round-trip');
    console.log('  [PASS] 2. category switching keeps unsaved values');

    // ---- 3. Search locates the matching category ----
    await page.evaluate(() => {
        const search = document.querySelector('#globalSettingsModal .vcp-ui-settings-search input');
        search.value = '语音';
        search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    const searchState = await page.evaluate(() => ({
        active: document.querySelector('#globalSettingsModal .settings-section.active')?.id,
        navCount: document.querySelectorAll('#globalSettingsModal .vcp-ui-list-item').length,
        labels: [...document.querySelectorAll('#globalSettingsModal .vcp-ui-list-copy strong')].map(node => node.textContent),
    }));
    assert.equal(searchState.active, 'section-voice-settings', 'search activated the voice category');
    assert.ok(searchState.navCount <= 2, `search narrowed the nav: ${searchState.navCount}`);
    assert.ok(searchState.labels.some(label => label.includes('语音')), `matching label visible: ${searchState.labels.join(',')}`);
    await page.evaluate(() => {
        const search = document.querySelector('#globalSettingsModal .vcp-ui-settings-search input');
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(await page.evaluate(() => document.querySelectorAll('#globalSettingsModal .vcp-ui-list-item').length), 8, 'clearing search restores the full nav');
    console.log('  [PASS] 3. search locates and activates the matching category');

    // ---- 4. Dark screenshot (700×500) ----
    // The app boots in light theme by default; switch explicitly to dark first.
    await resizeWindow(page, browser, 700, 500);
    await setTheme(page, 'dark');
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.querySelector('#globalSettingsModal .vcp-ui-settings-shell'), { timeout: timeoutMs });
    await new Promise(resolve => setTimeout(resolve, 250));
    await page.screenshot({ path: darkShot, clip: { x: 0, y: 0, width: 700, height: 500 } });
    const darkStat = await fs.stat(darkShot);
    assert.ok(darkStat.size > 20_000, `dark screenshot written (${darkStat.size} bytes)`);
    const darkModalBg = await page.evaluate(() => getComputedStyle(document.querySelector('#globalSettingsModal .global-settings-modal-content')).backgroundColor);
    console.log('  [PASS] 4. dark screenshot -> screenshots/settings-wa-dark-700x500.png');

    // ---- 5. Light screenshot (700×500) ----
    await setTheme(page, 'light');
    await new Promise(resolve => setTimeout(resolve, 250));
    await page.screenshot({ path: lightShot, clip: { x: 0, y: 0, width: 700, height: 500 } });
    const lightStat = await fs.stat(lightShot);
    assert.ok(lightStat.size > 20_000, `light screenshot written (${lightStat.size} bytes)`);
    const lightModalBg = await page.evaluate(() => getComputedStyle(document.querySelector('#globalSettingsModal .global-settings-modal-content')).backgroundColor);
    assert.notEqual(darkModalBg, lightModalBg, `dark and light modal backgrounds differ (${darkModalBg} vs ${lightModalBg})`);
    const darkHash = createHash('sha256').update(await fs.readFile(darkShot)).digest('hex');
    const lightHash = createHash('sha256').update(await fs.readFile(lightShot)).digest('hex');
    assert.notEqual(darkHash, lightHash, 'dark and light screenshots must differ');
    console.log(`  [PASS] 5. light screenshot -> screenshots/settings-wa-light-700x500.png (bg ${lightModalBg})`);

    // ---- 6. Real save through IPC, then reopen (reload) restores from disk ----
    await resizeWindow(page, browser, 1200, 800);
    await setTheme(page, 'dark');
    const uniquePrompt = `请继续-电子-${Date.now()}`;
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await new Promise(resolve => setTimeout(resolve, 150));
    await page.evaluate((value) => {
        const textarea = document.getElementById('continueWritingPrompt');
        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }, uniquePrompt);
    const footerStateBefore = await page.evaluate(() => document.querySelector('.global-settings-footer')?.dataset.state);
    assert.equal(footerStateBefore, 'dirty', 'save bar reports dirty before saving');
    await page.evaluate(() => document.querySelector('.global-settings-footer button[type="submit"]').click());
    // Poll for the modal to close; collect diagnostics so a hang is debuggable.
    let saveDiagnostics = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
        const state = await page.evaluate(() => ({
            active: document.getElementById('globalSettingsModal')?.classList.contains('active') || false,
            footerState: document.querySelector('.global-settings-footer')?.dataset.state || '',
            prompt: window.globalSettings?.continueWritingPrompt || '',
        }));
        if (!state.active) break;
        saveDiagnostics = state;
        await sleep(250);
    }
    const afterSave = await page.evaluate(() => ({
        active: document.getElementById('globalSettingsModal')?.classList.contains('active') || false,
        footerState: document.querySelector('.global-settings-footer')?.dataset.state || '',
        toast: [...document.querySelectorAll('.vcp-ui-toast, .floating-toast-notification')].map(node => node.textContent).slice(0, 3),
    }));
    assert.equal(afterSave.active, false, `modal closed after save; last poll ${JSON.stringify(saveDiagnostics)}, after ${JSON.stringify(afterSave)}`);
    const savedInMemory = await page.evaluate(() => window.globalSettings?.continueWritingPrompt);
    assert.equal(savedInMemory, uniquePrompt, 'globalSettings reflects the persisted value after save');
    const savedUserName = await page.evaluate(() => window.globalSettings?.userName);
    console.log('  [PASS] 6. real save via IPC persists (modal closed, in-memory settings updated)');

    // Reopen after a full reload: the form must be re-populated from settings.json.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    await page.waitForFunction(() => document.documentElement.dataset.uiMode === 'next', { timeout: timeoutMs });
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.getElementById('globalSettingsForm'), { timeout: timeoutMs });
    await new Promise(resolve => setTimeout(resolve, 250));
    const restored = await page.evaluate(() => ({
        prompt: document.getElementById('continueWritingPrompt')?.value,
        userName: document.getElementById('userName')?.value,
        active: document.querySelector('#globalSettingsModal .settings-section.active')?.id,
    }));
    assert.equal(restored.prompt, uniquePrompt, 'reopened form restored the persisted continueWritingPrompt');
    assert.equal(restored.userName, savedUserName, 'reopened form restored the persisted userName from disk');
    assert.equal(restored.active, 'section-user-identity', 'reopened modal starts on the first category');
    console.log('  [PASS] 7. reopen after reload restores persisted values from settings.json');

    // ---- 8. Classic teardown keeps next-mode surfaces clean ----
    assert.equal(await page.evaluate(() => document.documentElement.dataset.uiMode), 'next');
    await page.waitForFunction(() => {
        const modal = document.getElementById('globalSettingsModal');
        return !modal?.querySelector('.vcp-ui-settings-shell') && !modal?.querySelector('.vcp-ui-settings-search');
    }, { timeout: timeoutMs });
    console.log('  [PASS] 8. switching to classic tears the SettingsShell down');

    console.log('\nSettings WA Electron gate passed (shell layout, nav/search, real save + reload restore, screenshots).');
} catch (error) {
    console.error(`Settings WA Electron gate failed:\n${error?.stack || error}`);
    if (rendererErrors.length) {
        console.error('\nRenderer errors:\n' + rendererErrors.slice(0, 12).map(line => `- ${line}`).join('\n'));
    }
    process.exitCode = 1;
} finally {
    child.kill();
    browser?.disconnect();
    await new Promise(resolve => setTimeout(resolve, 300));
    child.kill('SIGKILL');
}
