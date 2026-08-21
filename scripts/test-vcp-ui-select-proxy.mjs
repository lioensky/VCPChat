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
const electron = path.join(
    root,
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32'
        ? 'electron.exe'
        : process.platform === 'darwin'
            ? 'Electron.app/Contents/MacOS/Electron'
            : 'electron'
);

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        }).on('error', reject);
    });
}

const mime = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
]);

const html = `<!doctype html>
<html data-ui-mode="next">
<head><meta charset="utf-8"><style>body{padding:40px}wa-select{width:320px}</style></head>
<body>
<script type="module">
import '/modules/ui-system/webawesome-adapter.js';
await window.VCPWebAwesome.loadComponents(['select', 'option']);
const { default: VCPUI } = await import('/modules/ui-system/vcp-ui.js');
const select = document.createElement('select');
select.setAttribute('aria-label', '本地工具审批');
for (const [value, label] of [['ask', '每次确认'], ['always-approve', 'YOLO']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
}
select.value = 'ask';
window.nativeChanges = 0;
window.nativeInputs = 0;
select.addEventListener('input', () => { window.nativeInputs += 1; });
select.addEventListener('change', () => { window.nativeChanges += 1; });
document.body.append(select);
VCPUI.enhance('Select', select);
await customElements.whenDefined('wa-select');
await document.querySelector('wa-select').updateComplete;
window.selectTestReady = true;
</script>
</body>
</html>`;

const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname === '/select-test.html') {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(html);
            return;
        }
        const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const target = path.resolve(root, relative);
        if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('path escape');
        const body = await fs.readFile(target);
        response.writeHead(200, { 'content-type': mime.get(path.extname(target)) || 'application/octet-stream' });
        response.end(body);
    } catch (error) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(String(error?.message || error));
    }
});

await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
const webPort = server.address().port;
const debugPort = await freePort();
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-select-proxy-'));
const mainPath = path.join(tempRoot, 'main.cjs');
await fs.writeFile(mainPath, `
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  await win.loadURL(${JSON.stringify(`http://127.0.0.1:${webPort}/select-test.html`)});
});
app.on('window-all-closed', () => app.quit());
`, 'utf8');

const child = spawn(electron, [mainPath, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${tempRoot}`], {
    cwd: root,
    env: { ...process.env },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
});
let stderr = '';
child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000); });

let browser;
try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Electron exited early: ${stderr}`);
        try { await requestJson(`http://127.0.0.1:${debugPort}/json/version`); break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` });
    let page;
    while (Date.now() < deadline) {
        page = (await browser.pages()).find(candidate => candidate.url().includes('/select-test.html'));
        if (page) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(page, `select test page did not open: ${stderr}`);
    await page.waitForFunction(() => window.selectTestReady === true);

    await page.click('wa-select');
    await page.waitForFunction(() => document.querySelector('wa-select')?.open === true);
    await page.click('wa-option[value="always-approve"]');
    await page.waitForFunction(() => document.querySelector('wa-select')?.open === false);
    await new Promise(resolve => setTimeout(resolve, 100));

    const state = await page.evaluate(() => ({
        nativeValue: document.querySelector('select')?.value,
        proxyValue: document.querySelector('wa-select')?.value,
        nativeInputs: window.nativeInputs,
        nativeChanges: window.nativeChanges,
    }));
    assert.deepEqual(state, {
        nativeValue: 'always-approve',
        proxyValue: 'always-approve',
        nativeInputs: 1,
        nativeChanges: 1,
    });
    console.log('VCPUI visible Web Awesome Select proxy interaction passed.');
} finally {
    browser?.disconnect();
    child.kill();
    server.close();
    if (child.exitCode === null) {
        await Promise.race([
            new Promise(resolve => child.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 2_000)),
        ]);
    }
    if (child.exitCode === null) child.kill('SIGKILL');
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
