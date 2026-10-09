import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = fileURLToPath(new URL('../', import.meta.url));
const main = fs.readFileSync(path.join(root, 'main.html'), 'utf8');
const sidebar = main.match(/<aside class="sidebar active vcp-ui-scope">[\s\S]*?<\/aside>/)[0];

test('compact topic drawer stays beside the unchanged agent rail and inside the shell', { timeout: 45000 }, async t => {
    const server = http.createServer((req, res) => {
        if (req.url === '/') {
            res.setHeader('Content-Type', 'text/html');
            res.end(`<!doctype html><html><head><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/styles/compact-sidebar.css"></head><body class="dark-theme"><div class="container">${sidebar}<main style="flex:1"></main></div></body></html>`);
            return;
        }
        const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
        if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.writeHead(404).end();
            return;
        }
        if (file.endsWith('.css')) res.setHeader('Content-Type', 'text/css');
        fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const browser = await puppeteer.launch({
        headless: true, timeout: 15000,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
        const rail = document.querySelector('.sidebar');
        rail.classList.add('avatar-only');
        document.querySelector('#agentList').innerHTML = Array.from({ length: 30 }, (_, i) =>
            `<li><div class="avatar-wrapper"><img class="avatar" alt="Agent ${i}"></div></li>`).join('');
        document.querySelector('#topicList').innerHTML = Array.from({ length: 50 }, (_, i) =>
            `<li class="topic-item"><span>${i} ${'长话题名称'.repeat(8)}</span></li>`).join('');
    });
    for (const [width, height] of [[1280, 900], [900, 600], [480, 400]]) {
        await page.setViewport({ width, height });
        for (const globalWallpaper of [false, true]) {
            await page.evaluate(globalWallpaper => {
                document.documentElement.dataset.vcpWallpaperScope = globalWallpaper ? 'global' : 'chat';
            }, globalWallpaper);
            for (const light of [false, true]) {
                await page.evaluate(light => {
                    document.body.classList.toggle('light-theme', light);
                    document.body.classList.toggle('dark-theme', !light);
                }, light);
                await new Promise(resolve => setTimeout(resolve, 350));
                const before = await page.$eval('#tabContentAgents', el => {
                    const r = el.getBoundingClientRect();
                    return { top: r.top, bottom: r.bottom, height: r.height };
                });
                await page.evaluate(() => {
                    document.querySelector('.sidebar').classList.add('compact-topics-open');
                    document.querySelector('#tabContentTopics').classList.add('compact-drawer-open');
                });
                await new Promise(resolve => setTimeout(resolve, 350));
                const state = await page.evaluate(() => {
                    const rail = document.querySelector('.sidebar').getBoundingClientRect();
                    const panel = document.querySelector('#tabContentTopics');
                    const box = panel.getBoundingClientRect();
                    const agents = document.querySelector('#tabContentAgents').getBoundingClientRect();
                    const scroll = panel.querySelector('.sidebar-list-scroll');
                    const scrollBox = scroll.getBoundingClientRect();
                    return {
                        position: getComputedStyle(panel).position,
                        left: box.left, right: box.right, top: box.top, bottom: box.bottom,
                        railRight: rail.right, railTop: rail.top, railBottom: rail.bottom,
                        agents: { top: agents.top, bottom: agents.bottom, height: agents.height },
                        scrollBottom: scrollBox.bottom, scrollHeight: scroll.clientHeight,
                        overflowing: scroll.scrollHeight > scroll.clientHeight,
                        hit: panel.contains(document.elementFromPoint(box.left + 20, box.top + 20))
                    };
                });
                const label = JSON.stringify({ width, height, globalWallpaper, light, state });
                assert.equal(state.position, 'absolute', label);
                assert.ok(state.left >= state.railRight + 7, label);
                assert.ok(state.right <= width, label);
                assert.ok(state.top >= state.railTop && state.top <= state.railTop + 13, label);
                assert.ok(state.bottom <= Math.min(height, state.railBottom) && state.bottom > state.top + 100, label);
                assert.deepEqual(state.agents, before, `drawer must not shrink/move agents: ${label}`);
                assert.ok(state.scrollHeight > 0 && state.overflowing, label);
                assert.ok(state.scrollBottom <= state.bottom + 1, label);
                assert.ok(state.hit, `drawer must not be clipped/covered: ${label}`);
                await page.evaluate(() => {
                    document.querySelector('.sidebar').classList.remove('compact-topics-open');
                    document.querySelector('#tabContentTopics').classList.remove('compact-drawer-open');
                });
                await new Promise(resolve => setTimeout(resolve, 350));
            }
        }
    }
    await page.evaluate(() => {
        document.querySelector('.sidebar').classList.remove('avatar-only');
        document.querySelector('#tabContentTopics').classList.add('active');
        document.querySelector('#tabContentAgents').classList.remove('active');
    });
    assert.equal(await page.$eval('#tabContentTopics', el => getComputedStyle(el).position), 'relative',
        'normal topic tab keeps its manage-panel positioning context');
});