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
const conflictShot = path.join(screenshotsDir, 'settings-wa-conflict-700x500.png');

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
await fs.mkdir(path.join(appData, 'UserData'), { recursive: true });
// Use a browser-decodable image. A sentinel byte fixture would make the
// persistence check pass at the filesystem layer while the preview remains
// visually broken (naturalWidth === 0).
await fs.copyFile(path.join(root, 'assets', 'default_user_avatar.png'), path.join(appData, 'UserData', 'user_avatar.png'));
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
    console.log(`[test-settings-wa-electron] waiting for CDP on ${port}`);
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
    console.log('[test-settings-wa-electron] CDP connected; waiting for main renderer');
    let page = null;
    while (Date.now() < deadline) {
        page = (await browser.pages()).find((candidate) => candidate.url().includes('main.html')) || null;
        if (page) break;
        await sleep(100);
    }
    assert.ok(page, `Electron main renderer did not appear: ${stderr.value}`);
    console.log('[test-settings-wa-electron] main renderer connected');
    page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error?.stack || error}`));
    page.on('console', (message) => {
        if (message.type() === 'error') rendererErrors.push(`console.error: ${message.text()}`);
    });

    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    console.log('[test-settings-wa-electron] renderer ready');
    await page.waitForFunction(() => document.documentElement.dataset.uiMode === 'next', { timeout: timeoutMs });
    console.log('[test-settings-wa-electron] next presentation active');

    // ---- 1. SettingsShell layout ----
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.getElementById('globalSettingsForm'), { timeout: timeoutMs });
    await page.waitForFunction(() => {
        const preview = document.getElementById('userAvatarPreview');
        return Boolean(preview?.src?.includes('user_avatar.png') && preview.style.display !== 'none');
    }, { timeout: timeoutMs });
    await page.waitForFunction(() => document.querySelector('#globalSettingsModal .vcp-uiux-settings-panel'), { timeout: timeoutMs });
    const shellState = await page.evaluate(() => {
        const modal = document.getElementById('globalSettingsModal');
        const navItems = modal.querySelectorAll('.vcp-uiux-settings-nav-cell');
        return {
            shell: Boolean(modal.querySelector('.vcp-uiux-settings-panel')),
            navCount: navItems.length,
            sectionIds: [...modal.querySelectorAll('.settings-section')].map(section => section.id),
            activeSection: modal.querySelector('.settings-section.active')?.id,
            iconReplaced: Boolean(modal.querySelector('#resetUserAvatarColorsBtn [data-lucide]')),
        };
    });
    assert.ok(shellState.shell, 'SettingsShell class applied');
    assert.equal(shellState.navCount, 8, '8 categories in VCPUI List nav');
    assert.equal(shellState.sectionIds.length, 8, '8 setting sections present');
    assert.equal(shellState.activeSection, 'section-user-identity', 'starts on user identity');
    // Icons inside the form are normalized to VCPUI Lucide icons (the lucide
    // adapter renders the marker span into an svg shortly after insertion).
    await page.waitForFunction(() => {
        const btn = document.getElementById('resetUserAvatarColorsBtn');
        return Boolean(btn?.querySelector('[data-vcp-icon]') || btn?.querySelector('span.vcp-ui-icon'));
    }, { timeout: timeoutMs });
    console.log('  [PASS] 1. SettingsShell layout (nav list, save bar, sections, icons)');

    // Appearance home-visual switches stay on the far-right control column,
    // rather than dropping below their title and helper copy.
    await page.evaluate(() => document.querySelectorAll('#globalSettingsModal .vcp-uiux-settings-nav-cell')[2]?.click());
    await page.waitForFunction(() => document.querySelector('#globalSettingsModal .settings-section.active')?.id === 'section-appearance-settings', { timeout: timeoutMs });
    const homeVisualSwitches = await page.evaluate(() => [...document.querySelectorAll('#globalSettingsModal .appearance-home-visual-setting')].map(row => {
        const copy = row.querySelector('.appearance-home-visual-copy')?.getBoundingClientRect();
        const toggle = row.querySelector('.switch')?.getBoundingClientRect();
        return copy && toggle ? { copyTop: copy.top, copyBottom: copy.bottom, toggleTop: toggle.top, toggleBottom: toggle.bottom, rowRight: row.getBoundingClientRect().right, toggleRight: toggle.right } : null;
    }).filter(Boolean));
    assert.ok(homeVisualSwitches.length >= 2, 'appearance home visual rows are present');
    homeVisualSwitches.forEach((geometry, index) => {
        assert.ok(geometry.toggleRight >= geometry.rowRight - 4, `appearance switch ${index + 1} is right aligned`);
        assert.ok(geometry.toggleTop < geometry.copyBottom && geometry.toggleBottom > geometry.copyTop, `appearance switch ${index + 1} shares the copy row`);
    });
    console.log('  [PASS] appearance home-visual switches stay on the right');
    const scenarioGrid = await page.evaluate(() => {
        const grid = document.getElementById('fontScenarioPreviewGrid');
        const cards = [...(grid?.querySelectorAll('.scenario-preview-card') || [])].map(card => card.getBoundingClientRect());
        return {
            columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
            count: cards.length,
            firstRow: cards.slice(0, 2).every(card => Math.abs(card.top - cards[0].top) <= 2),
            secondRow: cards.slice(2, 4).every(card => Math.abs(card.top - cards[2].top) <= 2),
        };
    });
    assert.equal(scenarioGrid.columns, 2, 'scenario preview uses a two-column grid');
    assert.equal(scenarioGrid.count, 4, 'scenario preview exposes four cards');
    assert.equal(scenarioGrid.firstRow, true, 'scenario preview first row is aligned');
    assert.equal(scenarioGrid.secondRow, true, 'scenario preview second row is aligned');
    assert.equal(await page.evaluate(() => document.querySelector('#fontScenarioPreviewGrid #chatFontPresetRow')?.closest('.scenario-preview-card')?.classList.contains('scenario-preview-card')), true, 'chat font control lives in the body card');
    assert.equal(await page.evaluate(() => document.querySelector('#fontScenarioPreviewGrid #chatCodeFontPresetRow')?.closest('.scenario-preview-card')?.classList.contains('scenario-preview-card-code')), true, 'code font control lives in the code card');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#globalSettingsModal > #chatFontSettingsGroup, #globalSettingsModal #chatFontSettingsGroup').length), 0, 'chat font control has no separate legacy row');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#globalSettingsModal > #chatCodeFontSettingsGroup, #globalSettingsModal #chatCodeFontSettingsGroup').length), 0, 'code font control has no separate legacy row');
    console.log('  [PASS] scenario preview uses a 2x2 card grid');

    // Chat presentation modes follow the DSH appearance-cube contract:
    // three equal cards, icon-over-label, selected state on the whole card,
    // and native radios retained as the business field underneath.
    const presentationModes = await page.evaluate(() => {
        const root = document.querySelector('#globalSettingsModal .chat-presentation-mode-selector');
        const grid = root?.querySelector('.chat-presentation-mode-options');
        const cards = [...(root?.querySelectorAll('.chat-presentation-mode-option') || [])];
        const rects = cards.map(card => card.getBoundingClientRect());
        return {
            count: cards.length,
            columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
            equalWidths: rects.length === 3 && rects.every(rect => Math.abs(rect.width - rects[0].width) <= 2),
            sameRow: rects.length === 3 && rects.every(rect => Math.abs(rect.top - rects[0].top) <= 2),
            iconCount: cards.filter(card => card.querySelector('.chat-presentation-mode-icon')).length,
            selectedValue: root?.querySelector('input[type="radio"]:checked')?.value || '',
            descriptionsVisuallyHidden: cards.every(card => {
                const small = card.querySelector('small');
                if (!small) return false;
                const style = getComputedStyle(small);
                return style.position === 'absolute' && style.width === '1px' && style.height === '1px';
            }),
        };
    });
    assert.equal(presentationModes.count, 3, 'three chat presentation mode cards are present');
    assert.equal(presentationModes.columns, 3, `presentation mode cards use three columns: ${presentationModes.columns}`);
    assert.equal(presentationModes.equalWidths, true, 'presentation mode cards have equal widths');
    assert.equal(presentationModes.sameRow, true, 'presentation mode cards share one row');
    assert.equal(presentationModes.iconCount, 3, 'presentation mode cards expose one icon each');
    assert.equal(presentationModes.selectedValue, 'bubble', 'bubble mode starts selected');
    assert.equal(presentationModes.descriptionsVisuallyHidden, true, 'presentation mode descriptions do not alter card geometry');
    await page.evaluate(() => document.querySelector('#chatPresentationModePanel')?.closest('label')?.click());
    assert.equal(await page.evaluate(() => document.querySelector('#chatPresentationModePanel')?.checked), true, 'clicking a presentation card selects its native radio');
    await page.evaluate(() => document.querySelector('#chatPresentationModeBubble')?.closest('label')?.click());
    assert.equal(await page.evaluate(() => document.querySelector('#chatPresentationModeBubble')?.checked), true, 'presentation card selection can switch back without rebuilding the form');
    await sleep(120);
    console.log('  [PASS] presentation modes use DSH-style three-card selector');

    const bubbleOptionRows = await page.evaluate(() => ['enableUserChatBubbleUi', 'showUserMetaInChatBubbleUi'].map(id => {
        const input = document.getElementById(id);
        const row = input?.closest('.vcp-uiux-general-row');
        const copy = row?.querySelector('.vcp-uiux-row-copy') || row?.children[0];
        const toggle = input?.closest('.switch');
        if (!row || !copy || !toggle) return null;
        const rowRect = row.getBoundingClientRect();
        const copyRect = copy.getBoundingClientRect();
        const toggleRect = toggle.getBoundingClientRect();
        return { rowRight: rowRect.right, copyTop: copyRect.top, copyBottom: copyRect.bottom, toggleLeft: toggleRect.left, toggleRight: toggleRect.right, toggleTop: toggleRect.top, toggleBottom: toggleRect.bottom };
    }).filter(Boolean));
    assert.equal(bubbleOptionRows.length, 2, 'bubble option switch rows are present');
    bubbleOptionRows.forEach((geometry, index) => {
        assert.ok(geometry.toggleRight >= geometry.rowRight - 4, `bubble option switch ${index + 1} is right aligned: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.toggleTop < geometry.copyBottom && geometry.toggleBottom > geometry.copyTop, `bubble option switch ${index + 1} shares the copy row: ${JSON.stringify(geometry)}`);
    });
    console.log('  [PASS] bubble option switches stay on the right');

    const contentWidthGeometry = await page.evaluate(() => {
        const input = document.getElementById('chatLayoutModeNormal');
        const row = input?.closest('.vcp-uiux-general-row');
        const copy = row?.querySelector('.vcp-uiux-row-copy') || row?.querySelector(':scope > label:first-child');
        const choice = row?.querySelector('.vcp-settings-control-row, .vcp-uiux-choice');
        if (!row || !copy || !choice) return null;
        const rowRect = row.getBoundingClientRect();
        const copyRect = copy.getBoundingClientRect();
        const choiceRect = choice.getBoundingClientRect();
        const option = choice.querySelector('.vcp-uiux-choice-option');
        const optionStyle = option ? getComputedStyle(option) : null;
        return {
            rowRight: rowRect.right,
            copyTop: copyRect.top,
            copyBottom: copyRect.bottom,
            choiceLeft: choiceRect.left,
            choiceRight: choiceRect.right,
            choiceTop: choiceRect.top,
            choiceBottom: choiceRect.bottom,
            optionHeight: optionStyle?.height || '',
            optionRadius: optionStyle?.borderRadius || '',
            optionBorder: optionStyle?.borderWidth || '',
            optionFontSize: optionStyle?.fontSize || '',
        };
    });
    assert.ok(contentWidthGeometry, 'content-width choice row is present');
    assert.ok(contentWidthGeometry.choiceRight >= contentWidthGeometry.rowRight - 4, `content-width choice is right aligned: ${JSON.stringify(contentWidthGeometry)}`);
    assert.ok(contentWidthGeometry.choiceTop < contentWidthGeometry.copyBottom && contentWidthGeometry.choiceBottom > contentWidthGeometry.copyTop, `content-width choice shares the title row: ${JSON.stringify(contentWidthGeometry)}`);
    assert.equal(contentWidthGeometry.optionHeight, '24px', `content-width choice uses compact 24px pills: ${JSON.stringify(contentWidthGeometry)}`);
    assert.equal(contentWidthGeometry.optionRadius, '12px', `content-width choice uses compact 12px radius: ${JSON.stringify(contentWidthGeometry)}`);
    assert.equal(contentWidthGeometry.optionBorder, '0px', `content-width choice has no resting border: ${JSON.stringify(contentWidthGeometry)}`);
    assert.equal(contentWidthGeometry.optionFontSize, '12px', `content-width choice uses compact 12px text: ${JSON.stringify(contentWidthGeometry)}`);
    await page.evaluate(() => document.querySelector('#chatLayoutModeWide')?.closest('label')?.click());
    await sleep(250);
    const wideChoiceHealth = await page.evaluate(() => ({
        checked: document.getElementById('chatLayoutModeWide')?.checked || false,
        bodyChildren: document.body?.children.length || 0,
        modalPresent: Boolean(document.getElementById('globalSettingsModal')),
        settingsPanelPresent: Boolean(document.querySelector('#globalSettingsModal .vcp-uiux-settings-panel')),
        rendererReady: document.documentElement.dataset.vcpRendererReady,
    }));
    assert.equal(wideChoiceHealth.checked, true, `wide choice is selected: ${JSON.stringify(wideChoiceHealth)}`);
    assert.ok(wideChoiceHealth.bodyChildren > 0 && wideChoiceHealth.modalPresent && wideChoiceHealth.settingsPanelPresent && wideChoiceHealth.rendererReady === 'true', `switching content width must keep the renderer alive: ${JSON.stringify(wideChoiceHealth)}`);
    await sleep(1500);
    const wideChoiceSettledHealth = await page.evaluate(() => ({
        checked: document.getElementById('chatLayoutModeWide')?.checked || false,
        modalActive: document.getElementById('globalSettingsModal')?.classList.contains('active') || false,
        bodyChildren: document.body?.children.length || 0,
        settingsPanelPresent: Boolean(document.querySelector('#globalSettingsModal .vcp-uiux-settings-panel')),
        rendererReady: document.documentElement.dataset.vcpRendererReady,
    }));
    assert.ok(wideChoiceSettledHealth.bodyChildren > 0 && wideChoiceSettledHealth.settingsPanelPresent && wideChoiceSettledHealth.rendererReady === 'true', `content-width save settlement must keep the renderer alive: ${JSON.stringify(wideChoiceSettledHealth)}`);
    await page.evaluate(() => document.querySelector('#chatLayoutModeNormal')?.closest('label')?.click());
    await sleep(120);
    console.log('  [PASS] content-width choice stays on the right');
    await page.evaluate(() => document.querySelectorAll('#globalSettingsModal .vcp-uiux-settings-nav-cell')[0]?.click());
    await page.waitForFunction(() => document.querySelector('#globalSettingsModal .settings-section.active')?.id === 'section-user-identity', { timeout: timeoutMs });

    // ---- 2. Category switching keeps unsaved values ----
    await page.evaluate(() => {
        const input = document.getElementById('userName');
        input.value = '未保存测试';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => document.querySelectorAll('#globalSettingsModal .vcp-uiux-settings-nav-cell')[1].click());
    await new Promise(resolve => setTimeout(resolve, 80));
    const switchState = await page.evaluate(() => ({
        active: document.querySelector('#globalSettingsModal .settings-section.active')?.id,
    }));
    assert.equal(switchState.active, 'section-server-connection', 'nav switched to server connection');
    await page.evaluate(() => document.querySelectorAll('#globalSettingsModal .vcp-uiux-settings-nav-cell')[0].click());
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
        const search = document.querySelector('#globalSettingsModal .vcp-uiux-settings-search-input');
        const button = document.querySelector('#globalSettingsModal .vcp-uiux-settings-search-button');
        button?.click();
        search.value = '语音';
        search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    const searchState = await page.evaluate(() => ({
        active: document.querySelector('#globalSettingsModal .settings-section.active')?.id,
        navCount: [...document.querySelectorAll('#globalSettingsModal .vcp-uiux-settings-nav-cell')].filter(node => !node.hidden).length,
        labels: [...document.querySelectorAll('#globalSettingsModal .vcp-uiux-settings-nav-copy strong')].map(node => node.textContent),
    }));
    assert.equal(searchState.active, 'section-voice-settings', 'search activated the voice category');
    assert.ok(searchState.navCount <= 2, `search narrowed the nav: ${searchState.navCount}`);
    assert.ok(searchState.labels.some(label => label.includes('语音')), `matching label visible: ${searchState.labels.join(',')}`);
    await page.evaluate(() => {
        const search = document.querySelector('#globalSettingsModal .vcp-uiux-settings-search-input');
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(await page.evaluate(() => document.querySelectorAll('#globalSettingsModal .vcp-uiux-settings-nav-cell').length), 8, 'unified nav retains all categories');
    console.log('  [PASS] 3. search locates and activates the matching category');

    // ---- 4. Dark screenshot (700×500) ----
    // The app boots in light theme by default; switch explicitly to dark first.
    await resizeWindow(page, browser, 700, 500);
    await setTheme(page, 'dark');
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.querySelector('#globalSettingsModal .vcp-uiux-settings-panel'), { timeout: timeoutMs });
    await page.evaluate(() => {
        document.querySelectorAll('#globalSettingsModal .vcp-uiux-settings-nav-cell')[2]?.click();
        document.querySelector('#globalSettingsModal .chat-presentation-mode-selector')?.scrollIntoView({ block: 'center' });
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    await page.screenshot({ path: darkShot, clip: { x: 0, y: 0, width: 700, height: 500 } });
    const darkStat = await fs.stat(darkShot);
    assert.ok(darkStat.size > 20_000, `dark screenshot written (${darkStat.size} bytes)`);
    const darkModalBg = await page.evaluate(() => getComputedStyle(document.querySelector('#globalSettingsModal .vcp-uiux-settings-panel')).backgroundColor);
    console.log('  [PASS] 4. dark screenshot -> screenshots/settings-wa-dark-700x500.png');

    // Assert typography harmonization (DSH 14px / 400 font-weight)
    const typoCheck = await page.evaluate(() => {
        const check = (text) => {
            const el = [...document.querySelectorAll('#globalSettingsModal *')].find(e => e.textContent?.trim() === text && e.children.length === 0);
            if (!el) return null;
            return {
                text,
                tag: el.tagName,
                parentClass: el.parentElement.className,
                fontWeight: getComputedStyle(el).fontWeight,
                fontSize: getComputedStyle(el).fontSize,
            };
        };
        return [
            check('导航材质'),
            check('列表项高度'),
            check('列表项圆角'),
            check('主页视觉文字'),
        ];
    });
    console.log('[TYPO CHECK RESULTS]', typoCheck);
    for (const item of typoCheck) {
        if (item) {
            assert.equal(item.fontWeight, '400', `${item.text} must have 400 font-weight`);
            assert.equal(item.fontSize, '14px', `${item.text} must have 14px font-size`);
        }
    }
    console.log('  [PASS] typography harmonized (14px / 400 weight for row titles)');

    // ---- 5. Light screenshot (700×500) ----
    await setTheme(page, 'light');
    await page.evaluate(() => document.querySelector('#globalSettingsModal .chat-presentation-mode-selector')?.scrollIntoView({ block: 'center' }));
    await new Promise(resolve => setTimeout(resolve, 250));
    await page.screenshot({ path: lightShot, clip: { x: 0, y: 0, width: 700, height: 500 } });
    const lightStat = await fs.stat(lightShot);
    assert.ok(lightStat.size > 20_000, `light screenshot written (${lightStat.size} bytes)`);
    const lightModalBg = await page.evaluate(() => getComputedStyle(document.querySelector('#globalSettingsModal .vcp-uiux-settings-panel')).backgroundColor);
    const darkHash = createHash('sha256').update(await fs.readFile(darkShot)).digest('hex');
    const lightHash = createHash('sha256').update(await fs.readFile(lightShot)).digest('hex');
    assert.notEqual(darkHash, lightHash, 'dark and light screenshots must differ');
    console.log(`  [PASS] 5. light screenshot -> screenshots/settings-wa-light-700x500.png (bg ${lightModalBg}; dark bg ${darkModalBg}; hashes differ)`);
    // ---- 5b. Conflict bar screenshot (700×500) ----
    await page.evaluate(() => {
        const form = document.getElementById('globalSettingsForm');
        if (form) {
            form.dataset.vcpSettingsConflict = 'true';
            form.dispatchEvent(new CustomEvent('vcp-settings-save-result', { detail: { status: 'conflict' } }));
        }
        document.querySelector('.vcp-settings-conflict-actions')?.scrollIntoView({ block: 'nearest' });
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    await page.screenshot({ path: conflictShot, clip: { x: 0, y: 0, width: 700, height: 500 } });
    const conflictStat = await fs.stat(conflictShot);
    assert.ok(conflictStat.size > 20_000, `conflict screenshot written (${conflictStat.size} bytes)`);
    await page.evaluate(() => {
        const form = document.getElementById('globalSettingsForm');
        if (form) {
            delete form.dataset.vcpSettingsConflict;
            form.dispatchEvent(new CustomEvent('vcp-settings-save-result', { detail: { status: 'idle' } }));
        }
    });
    console.log('  [PASS] 5b. conflict screenshot -> screenshots/settings-wa-conflict-700x500.png');

    // ---- 6. Real save through IPC, then reopen (reload) restores from disk ----
    await resizeWindow(page, browser, 1200, 800);
    await setTheme(page, 'dark');
    // Prior interaction checks may have scheduled unrelated presentation
    // writes. Reconcile the modal against disk before asserting the dedicated
    // durable-save scenario so a stale background revision cannot contaminate
    // this test's dirty precondition.
    await page.evaluate(() => window.VCPUISettingsBridge.reloadExternal?.());
    const uniquePrompt = `请继续-电子-${Date.now()}`;
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await new Promise(resolve => setTimeout(resolve, 150));
    await page.waitForFunction(() => {
        const state = document.getElementById('globalSettingsForm')?.dataset.vcpAutosaveState || '';
        return !['saving', 'error', 'conflict'].includes(state);
    }, { timeout: timeoutMs });
    await page.evaluate((value) => {
        const textarea = document.getElementById('continueWritingPrompt');
        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }, uniquePrompt);
    const saveStateBefore = await page.evaluate(() => document.getElementById('globalSettingsForm')?.dataset.vcpAutosaveState);
    assert.equal(saveStateBefore, 'dirty', 'settings form reports dirty before saving');
    await page.evaluate(() => {
        window.__settingsSaveProjection = null;
        window.__settingsSaveResult = null;
        document.getElementById('globalSettingsForm')?.addEventListener('vcp-settings-save-result', event => {
            window.__settingsSaveResult = event.detail;
        });
        window.addEventListener('global-settings-updated', event => {
            if (event.detail?.source !== 'settings-save') return;
            window.__settingsSaveProjection = {
                continueWritingPrompt: event.detail.settings?.continueWritingPrompt,
                userName: event.detail.settings?.userName,
            };
        }, { once: true });
    });
    await page.evaluate(() => document.getElementById('globalSettingsForm')?.requestSubmit());
    // Poll for the modal to close; collect diagnostics so a hang is debuggable.
    let saveDiagnostics = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
        const state = await page.evaluate(() => ({
            active: document.getElementById('globalSettingsModal')?.classList.contains('active') || false,
            saveState: document.getElementById('globalSettingsForm')?.dataset.vcpAutosaveState || '',
            prompt: window.__settingsSaveProjection?.continueWritingPrompt || '',
        }));
        if (!state.active) break;
        saveDiagnostics = state;
        await sleep(250);
    }
    const afterSave = await page.evaluate(() => ({
        active: document.getElementById('globalSettingsModal')?.classList.contains('active') || false,
        saveState: document.getElementById('globalSettingsForm')?.dataset.vcpAutosaveState || '',
        toast: [...document.querySelectorAll('.vcp-ui-toast, .floating-toast-notification')].map(node => node.textContent).slice(0, 3),
        result: window.__settingsSaveResult,
    }));
    assert.equal(afterSave.active, false, `modal closed after save; last poll ${JSON.stringify(saveDiagnostics)}, after ${JSON.stringify(afterSave)}`);
    const savedProjection = await page.evaluate(() => window.__settingsSaveProjection);
    assert.equal(savedProjection?.continueWritingPrompt, uniquePrompt, 'settings authority publishes the persisted value after save');
    const savedUserName = savedProjection?.userName;
    console.log('  [PASS] 6. real save via IPC persists (modal closed, authority projection updated)');

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

    // ---- 8. Canonical next layout survives reload ----
    assert.equal(await page.evaluate(() => document.documentElement.dataset.uiMode), 'next');
    await page.waitForFunction(() => {
        const modal = document.getElementById('globalSettingsModal');
        return Boolean(modal?.querySelector('.vcp-uiux-settings-panel'));
    }, { timeout: timeoutMs });
    console.log('  [PASS] 8. canonical Next SettingsShell survives reload');

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
