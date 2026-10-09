import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

test('portrait render height does not move launcher components or grow their scroll area', async t => {
    const css = await readFile(new URL('../styles/ui-system/side-pane-launcher.css', import.meta.url), 'utf8');

    // ── 第一层：CSS 静态契约（无需浏览器，任何环境都验证）──
    // 立绘高度变量存在，且立绘容器高度由该变量驱动（带 fallback 也算）
    assert.match(css, /--side-pane-portrait-height/);
    assert.match(css, /height:\s*var\(--side-pane-portrait-height/);

    // ── 第二层：浏览器渲染验证（Chrome 可用时才跑）──
    // CI 工作流设置了 PUPPETEER_SKIP_DOWNLOAD 且未安装 Chrome，
    // 此处探测可用性：不可用则跳过渲染断言（本地开发环境完整执行）
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true,
            timeout: 15000,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
        });
    } catch (error) {
        t.skip(`Chrome 不可用，跳过浏览器渲染验证（${error.message.split('\n')[0]}）`);
        return;
    }
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