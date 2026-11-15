import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = process.env.VCPCHAT_BROWSER_EXECUTABLE
    || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const server = http.createServer(async (request, response) => {
    try {
        const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/+/, '');
        if (!/^(modules\/|node_modules\/|Flowlockmodules\/|tests\/support\/render-window\.html$)/.test(relative)) throw new Error('Forbidden fixture path');
        const resolved = path.resolve(root, relative);
        if (!resolved.startsWith(root + path.sep)) throw new Error('Invalid path');
        const data = await fs.readFile(resolved);
        response.setHeader('content-type', /\.html$/.test(resolved) ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8');
        response.end(data);
    } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await puppeteer.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 800 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/tests/support/render-window.html`);
    await page.waitForFunction(() => typeof window.runRenderWindowSmoke === 'function');
    const result = await page.evaluate(() => window.runRenderWindowSmoke());
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ browser: await browser.version(), ...result }, null, 2));
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}