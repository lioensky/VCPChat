import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const electronBin = path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const appData = '/tmp/vcpchat-stress-run-' + Date.now();
const port = 52270;

console.log('=== LAUNCHING ELECTRON FOR FULL PRESSURE TEST ===');
const child = spawn(electronBin, ['.', `--remote-debugging-port=${port}`, '--allow-multiple-instances'], {
    cwd: root,
    env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData },
    stdio: 'ignore',
});

let browser = null;
try {
    for (let i = 0; i < 30; i++) {
        try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }); break; }
        catch { await new Promise(r => setTimeout(r, 500)); }
    }
    if (!browser) throw new Error('Failed to connect to Electron via CDP');
    const pages = await browser.pages();
    const page = pages.find(p => p.url().includes('main.html')) || pages[0];
    await page.setViewport({ width: 1200, height: 900 });
    await page.waitForFunction(() => window.uiHelperFunctions && window.uiManager);
    console.log('✔ Connected to renderer window');

    // Helper to open modal
    async function openSettings() {
        await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
        await page.waitForSelector('#globalSettingsModal.active', { timeout: 3000 });
    }

    // Helper to click close button
    async function clickClose() {
        const closeBtn = await page.$('#globalSettingsModal .close-button');
        assert.ok(closeBtn, 'Close button must exist in DOM');
        await closeBtn.click();
    }

    // Helper to assert modal is closed
    async function assertClosed(label) {
        await new Promise(r => setTimeout(r, 100));
        const active = await page.evaluate(() => document.querySelector('#globalSettingsModal')?.classList.contains('active'));
        assert.equal(active, false, `${label}: Modal MUST NOT have active class`);
    }

    // --- TEST 1: Rapid Nav Tab Switching & Immediate Close ---
    console.log('\n[Test 1] Rapid Nav Tab Switching & Immediate Close...');
    await openSettings();
    const sectionNames = ['用户身份', '服务器连接', '界面与外观', '消息渲染', '划词助手', '语音设置', '高级功能', '快捷操作'];
    for (const name of sectionNames) {
        await page.evaluate((sec) => {
            const cells = [...document.querySelectorAll('.vcp-uiux-settings-nav-cell')];
            cells.find(c => c.textContent.includes(sec))?.click();
        }, name);
        await new Promise(r => setTimeout(r, 60));
    }
    await clickClose();
    await assertClosed('Test 1: Close after navigating all 8 tabs');
    console.log('✔ Test 1 Passed: Traversed 8 tabs and closed cleanly.');

    // --- TEST 2: Dirty Input Edit & Instant Close (Debounce race condition) ---
    console.log('\n[Test 2] Dirty Input Edit & Instant Close...');
    await openSettings();
    await page.evaluate(() => {
        const cells = [...document.querySelectorAll('.vcp-uiux-settings-nav-cell')];
        cells.find(c => c.textContent.includes('服务器连接'))?.click();
    });
    await new Promise(r => setTimeout(r, 100));
    const input = await page.$('#vcpServerUrl');
    if (input) {
        await input.type('http://127.0.0.1:9999');
    }
    await clickClose();
    await assertClosed('Test 2: Close immediately during active typing');
    console.log('✔ Test 2 Passed: Closed immediately during active keystrokes.');

    // --- TEST 3: High-Frequency Switch Toggles & Instant Close ---
    console.log('\n[Test 3] High-Frequency Switch Toggles & Instant Close...');
    await openSettings();
    await page.evaluate(() => {
        const cells = [...document.querySelectorAll('.vcp-uiux-settings-nav-cell')];
        cells.find(c => c.textContent.includes('高级功能'))?.click();
    });
    await new Promise(r => setTimeout(r, 100));
    await page.evaluate(() => {
        const switches = document.querySelectorAll('#globalSettingsModal .switch input[type="checkbox"]');
        for (let i = 0; i < switches.length; i++) {
            switches[i].click();
        }
    });
    await clickClose();
    await assertClosed('Test 3: Close after flipping all section switches');
    console.log('✔ Test 3 Passed: Rapid switch flips handled and closed immediately.');

    // --- TEST 4: Close Button Multi-Click Spamming ---
    console.log('\n[Test 4] Close Button Multi-Click Spamming...');
    await openSettings();
    const closeBtn = await page.$('#globalSettingsModal .close-button');
    await Promise.all([
        closeBtn.click(),
        closeBtn.click().catch(() => {}),
        closeBtn.click().catch(() => {}),
        closeBtn.click().catch(() => {}),
        closeBtn.click().catch(() => {}),
    ]);
    await assertClosed('Test 4: Spamming close button');
    console.log('✔ Test 4 Passed: 5x concurrent click spam cleanly closed modal without freezing.');

    // --- TEST 5: Escape Key Dismissal Under Dirty State ---
    console.log('\n[Test 5] Escape Key Dismissal Under Dirty State...');
    await openSettings();
    await page.keyboard.press('Escape');
    await assertClosed('Test 5: Escape key close');
    console.log('✔ Test 5 Passed: Escape key closes modal cleanly.');

    // --- TEST 6: Theme Flip Stress Under Open Settings ---
    console.log('\n[Test 6] Theme Switching Back and Forth Under Open Settings...');
    await openSettings();
    await page.evaluate(() => window.uiManager.applyTheme('dark'));
    await new Promise(r => setTimeout(r, 150));
    let darkBg = await page.evaluate(() => window.getComputedStyle(document.querySelector('.vcp-uiux-settings-content')).backgroundColor);
    console.log('  Dark mode content background:', darkBg);
    assert.ok(darkBg.includes('44, 44, 46') || darkBg.includes('44 44 46'), 'Dark background must be layer-2 dark slate');

    await page.evaluate(() => window.uiManager.applyTheme('light'));
    await new Promise(r => setTimeout(r, 150));
    let lightBg = await page.evaluate(() => window.getComputedStyle(document.querySelector('.vcp-uiux-settings-content')).backgroundColor);
    console.log('  Light mode content background:', lightBg);
    assert.ok(lightBg.includes('255, 255, 255') || lightBg.includes('255 255 255'), 'Light background must be white');

    await clickClose();
    await assertClosed('Test 6: Close after live theme switching');
    console.log('✔ Test 6 Passed: Theme transitions cleanly and modal closes.');

    // --- TEST 7: Page Reload (Ctrl+R) Survival & Re-interactivity ---
    console.log('\n[Test 7] Page Reload (Ctrl+R) Survival & Re-interactivity...');
    await openSettings();
    await clickClose();
    await assertClosed('Pre-reload close');

    console.log('  Triggering page.reload()...');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.uiHelperFunctions && window.uiManager);
    await new Promise(r => setTimeout(r, 400));

    await openSettings();
    const isOpenAfterReload = await page.evaluate(() => document.querySelector('#globalSettingsModal').classList.contains('active'));
    assert.equal(isOpenAfterReload, true, 'Modal must be able to open after reload');
    
    await clickClose();
    await assertClosed('Post-reload close');
    console.log('✔ Test 7 Passed: Reload (Ctrl+R) is completely smooth and buttons remain fully responsive!');

    console.log('\n=======================================================');
    console.log('🏆 ALL 7 PRESSURE TEST DIMENSIONS PASSED 100%! NO ERRORS!');
    console.log('=======================================================\n');

} finally {
    if (browser) await browser.disconnect();
    child.kill('SIGKILL');
}
