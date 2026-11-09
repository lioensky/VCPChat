import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import puppeteer from 'puppeteer';

const read = name => fs.readFileSync(new URL(`../ProjectForgemodules/${name}`, import.meta.url), 'utf8');
test('ProjectForge real DOM/CSS splitter: drag, bounds, storage, keyboard, cleanup', { timeout: 45000 }, async t => {
    // 保留真实页面结构与全量页面CSS；隔离依赖Electron IPC的业务模块。
    const html = read('projectforge.html')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<link\b[^>]*>/gi, '')
        .replace('</head>', `<style>${read('projectforge.css')}</style></head>`)
        .replace('</body>', `<script>${read('projectforge-layout.js')}</script></body>`);
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const browser = await puppeteer.launch({
        headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const width = () => page.$eval('#project-sidebar', el => el.getBoundingClientRect().width);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const drag = async x => {
        const r = await page.$eval('#project-sidebar-resizer', el => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + 60 };
        });
        await page.mouse.move(r.x, r.y);
        await page.mouse.down();
        await page.mouse.move(x, r.y, { steps: 8 });
        await page.mouse.up();
        await settle();
    };
    assert.equal(await width(), 300);
    await drag(465);
    assert.equal(await width(), 450);
    await page.reload();
    assert.equal(await width(), 450);
    await drag(1190);
    assert.equal(await width(), 850); // 1200 - padding20 - handle10 - main320
    await drag(0);
    assert.equal(await width(), 200);
    await page.focus('#project-sidebar-resizer');
    await page.keyboard.press('ArrowRight');
    assert.equal(await width(), 210);
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.up('Shift');
    assert.equal(await width(), 250);
    await page.keyboard.press('End');
    assert.equal(await width(), 850);
    await page.setViewport({ width: 480, height: 400 });
    await settle();
    assert.equal(await width(), 225);
    const mainRight = await page.$eval('#main-panel', el => el.getBoundingClientRect().right);
    assert.ok(mainRight <= 470.1);
    await page.setViewport({ width: 1200, height: 800 });
    await settle();
    assert.equal(await width(), 850); // 自动钳制不破坏宽屏偏好
    const handle = await page.$('#project-sidebar-resizer');
    await handle.evaluate(el => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    assert.equal(await width(), 300);
    // 拖出窗口焦点，确保退出拖动态和释放捕获。
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + 5, box.y + 60);
    await page.mouse.down();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    assert.equal(await page.$eval('.layout', el => el.classList.contains('pf-resizing')), false);
    await page.evaluate(() => localStorage.setItem('vcp-projectforge-sidebar-width', 'broken'));
    await page.reload();
    assert.equal(await width(), 300);
    assert.deepEqual(errors, []);
});