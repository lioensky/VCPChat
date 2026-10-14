const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const puppeteer = require('puppeteer');
test('portrait capsule follows sidebar width with equal gutters and safe title layout', async t => {
    const source = new JSDOM(fs.readFileSync('main.html', 'utf8'));
    const capsule = source.window.document.querySelector('.music-capsule');
    assert.equal(capsule.parentElement.className, 'side-pane-open-tab-shell');
    const markup = capsule.outerHTML;
    source.window.close();
    const browser = await puppeteer.launch({
        headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const css = fs.readFileSync('styles/ui-system/side-pane-launcher.css', 'utf8')
        + fs.readFileSync('styles/ui-system/music-capsule.css', 'utf8');
    await page.setContent(`<style>${css}</style><div class="vcp-ui-scope" style="width:400px">
        <div class="side-pane-open-tab-shell" style="height:300px">${markup}</div></div>`);
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    for (const theme of ['dark', 'light']) {
        for (const width of [180, 220, 280, 400, 640]) {
            await page.evaluate(({ theme, width }) => {
                document.body.dataset.vcpTheme = theme;
                document.querySelector('.vcp-ui-scope').style.width = `${width}px`;
                const root = document.querySelector('.music-capsule');
                root.hidden = false;
                root.classList.add('is-expanded');
                root.querySelector('.music-capsule-title').textContent = '超长曲名'.repeat(40);
            }, { theme, width });
            const result = await page.evaluate(() => {
                const shell = document.querySelector('.side-pane-open-tab-shell');
                const surface = document.querySelector('.music-capsule-surface');
                const title = document.querySelector('.music-capsule-title');
                const s = shell.getBoundingClientRect(), r = surface.getBoundingClientRect();
                const buttons = [...surface.querySelectorAll('button')].map(b => {
                    const box = b.getBoundingClientRect();
                    return { width: box.width, left: box.left, right: box.right };
                });
                return {
                    left: r.left - s.left, right: s.right - r.right,
                    top: r.top - s.top, buttons, surfaceRight: r.right,
                    titleWidth: title.clientWidth, overflow: title.scrollWidth > title.clientWidth,
                    ellipsis: getComputedStyle(title).textOverflow,
                    blur: getComputedStyle(surface).backdropFilter,
                    scroll: shell.scrollWidth <= shell.clientWidth
                };
            });
            const label = JSON.stringify({ theme, width, result });
            assert.ok(Math.abs(result.left - 12) < 1 && Math.abs(result.right - 12) < 1, label);
            assert.equal(result.top, 12, label);
            assert.ok(result.buttons.every(b => b.width === 32 && b.right <= result.surfaceRight), label);
            assert.ok(result.titleWidth > 0 && result.overflow && result.ellipsis === 'ellipsis', label);
            assert.ok(result.scroll && result.blur.includes('blur'), label);
            await page.evaluate(() => document.querySelector('.music-capsule').classList.remove('is-expanded'));
            const collapsed = await page.$eval('.music-capsule-surface', el => {
                const r = el.getBoundingClientRect();
                return { width: r.width, hit: el.contains(document.elementFromPoint(r.right - 16, r.top + 16)) };
            });
            assert.equal(collapsed.width, 34, label);
            assert.equal(collapsed.hit, true, label);
        }
    }
});