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
const electron = process.platform === 'darwin'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const requestJson = url => new Promise((resolve, reject) => {
    http.get(url, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    }).on('error', reject);
});
const freePort = async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
};
const waitFor = async (label, predicate, timeout = 45_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await sleep(150);
    }
    throw new Error(`Timed out waiting for ${label}`);
};

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-avatar-probe-'));
await fs.mkdir(path.join(appData, 'UserData'), { recursive: true });
await fs.copyFile(path.join(root, 'assets', 'default_user_avatar.png'), path.join(appData, 'UserData', 'user_avatar.png'));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next', userName: '头像探针', enableDistributedServer: false,
}), 'utf8');

const port = await freePort();
const child = spawn(electron, ['.', '--allow-multiple-instances', `--remote-debugging-port=${port}`], {
    cwd: root,
    env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
});
let stderr = '';
child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-10_000); });
let browser;
try {
    console.log(`[avatar-probe] waiting for CDP on ${port}`);
    await waitFor('Electron CDP', async () => {
        if (child.exitCode !== null) throw new Error(`Electron exited: ${stderr}`);
        try { await requestJson(`http://127.0.0.1:${port}/json/version`); return true; } catch { return false; }
    });
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    let page;
    await waitFor('main renderer', async () => {
        page = (await browser.pages()).find(candidate => candidate.url().includes('main.html'));
        return Boolean(page);
    });
    console.log('[avatar-probe] main renderer connected');
    await waitFor('renderer ready', () => page.evaluate(() => document.documentElement.dataset.vcpRendererReady === 'true'));
    const loaded = await page.evaluate(async () => window.chatAPI.loadSettings());
    assert.match(String(loaded.userAvatarUrl), /user_avatar\.png/);
    console.log('[avatar-probe] loadSettings returned persisted avatar URL');

    const avatarBytes = [...await fs.readFile(path.join(root, 'assets', 'default_user_avatar.png'))];
    const saved = await page.evaluate(async bytes => window.chatAPI.saveUserAvatar({
        name: 'avatar-probe.png', type: 'image/png', buffer: new Uint8Array(bytes).buffer,
    }), avatarBytes);
    assert.equal(saved?.success, true, saved?.error || 'saveUserAvatar failed');
    assert.match(String(saved.avatarUrl), /user_avatar\.png/);
    console.log('[avatar-probe] saveUserAvatar wrote persisted avatar');

    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await waitFor('settings preview', () => page.evaluate(() => {
        const preview = document.getElementById('userAvatarPreview');
        return Boolean(preview && preview.src.includes('user_avatar.png') && preview.style.display !== 'none' && preview.complete && preview.naturalWidth > 0);
    }));
    console.log('[avatar-probe] first open preview decoded');

    await page.evaluate(() => window.uiHelperFunctions.closeModal('globalSettingsModal'));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitFor('renderer ready after reload', () => page.evaluate(() => document.documentElement.dataset.vcpRendererReady === 'true'));
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await waitFor('reopened preview', () => page.evaluate(() => {
        const preview = document.getElementById('userAvatarPreview');
        return Boolean(preview && preview.src.includes('user_avatar.png') && preview.style.display !== 'none' && preview.complete && preview.naturalWidth > 0);
    }));
    const state = await page.evaluate(() => {
        const preview = document.getElementById('userAvatarPreview');
        return { src: preview?.getAttribute('src'), display: preview && getComputedStyle(preview).display, naturalWidth: preview?.naturalWidth };
    });
    console.log('[avatar-probe] reload preview decoded', JSON.stringify(state));
} finally {
    // Disconnect without waiting for Electron's browser shutdown handshake;
    // the child is an isolated test process and is terminated explicitly.
    browser?.disconnect();
    if (child.exitCode === null) child.kill('SIGKILL');
    await fs.rm(appData, { recursive: true, force: true });
}
