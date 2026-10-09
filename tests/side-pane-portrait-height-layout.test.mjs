import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

test('portrait render height does not move launcher components or grow their scroll area', async () => {
    const css = await readFile(new URL('../styles/ui-system/side-pane-launcher.css', import.meta.url), 'utf8');
    const browser = await puppeteer.launch({
        headless: true,
        timeout: 15000,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    });
    try {
        const page = await browser.newPage();
        await page.setContent(`
            <style>
                body { margin: 0; }
                #sidePaneViewLauncher { display: flex; width: 360px; height: 420px; }
                .side-pane-open-tab-shell { flex-shrink: 0; }
                .side-pane-launcher-section { height: 190px; flex-shrink: 0; }
                * { transition: none !important; }
            </style>
            <div class="vcp-ui-scope" id="sidePaneViewLauncher" data-launcher-portrait="single">
                <div class="side-pane-open-tab-shell">
                    <div class="side-pane-launcher-portrait">
                        <img class="side-pane-launcher-portrait-image" data-portrait-theme="default">
                    </div>
                    <div class="side-pane-open-tab-content">
                        <div class="side-pane-launcher-profile"></div>
                        <div class="side-pane-launcher-tabs"><button class="side-pane-launcher-tab">工具</button></div>
                        <section class="side-pane-launcher-section"></section>
                    </div>
                </div>
            </div>
        `);
        await page.addStyleTag({ content: css });
        const results = [];
        for (const height of [180, 200, 248, 320, 360]) {
            results.push(await page.evaluate(height => {
                const view = document.getElementById('sidePaneViewLauncher');
                view.style.setProperty('--side-pane-portrait-height', `${height}px`);
                const shell = view.querySelector('.side-pane-open-tab-shell');
                return {
                    portraitHeight: view.querySelector('.side-pane-launcher-portrait').getBoundingClientRect().height,
                    profileHeight: view.querySelector('.side-pane-launcher-profile').getBoundingClientRect().height,
                    tabsTop: view.querySelector('.side-pane-launcher-tabs').getBoundingClientRect().top,
                    toolsTop: view.querySelector('.side-pane-launcher-section').getBoundingClientRect().top,
                    scrollHeight: shell.scrollHeight,
                    clientHeight: shell.clientHeight
                };
            }, height));
        }
        for (const [index, result] of results.entries()) {
            assert.equal(result.portraitHeight, [180, 200, 248, 320, 360][index]);
            assert.equal(result.profileHeight, 124);
            assert.equal(result.tabsTop, results[0].tabsTop);
            assert.equal(result.toolsTop, results[0].toolsTop);
            assert.equal(result.scrollHeight, results[0].scrollHeight);
            assert.ok(result.scrollHeight <= result.clientHeight, '立绘增高不应产生额外滚动条');
        }
        await page.evaluate(() => { document.getElementById('sidePaneViewLauncher').dataset.launcherSegment = 'notifications'; });
        assert.equal(await page.$eval('.side-pane-launcher-profile', element => element.getBoundingClientRect().height), 0);
    } finally {
        await browser.close();
    }
});