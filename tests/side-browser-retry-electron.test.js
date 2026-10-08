'use strict';

const { runFromNode } = require('./helpers/electron-test-entry.cjs');

if (!runFromNode(__filename)) {
    const { app, BrowserWindow } = require('electron');
    // This hidden integration fixture does not need the workstation's GPU compositor.
    app.disableHardwareAcceleration();
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const http = require('node:http');
    const path = require('node:path');
    const { pathToFileURL } = require('node:url');
    const repo = path.resolve(__dirname, '..');
    const out = path.join(app.getPath('userData'), 'browser-retry');
    fs.mkdirSync(out, { recursive: true });
    const events = [], requests = [], results = [];
    let server, windowRef, guestDestroyed, currentGuest, currentGuestExit;
    let failing = true, title = 'Initial fixture';
    let slowResponding = false, currentGuestReady = false;
    const cancelledRequests = [];
    const finish = () => { windowRef?.destroy(); server?.close(); };
    const deadline = setTimeout(() => {
        console.error('Browser retry test exceeded its deadline');
        finish(); app.exit(1);
    }, 45000);

    async function poll(condition) {
        const until = Date.now() + 10000;
        while (Date.now() < until) {
            if (await windowRef.webContents.executeJavaScript(condition)) return;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error(`Browser condition not reached: ${condition}`);
    }

    async function capture(label) {
        const output = process.env.VCP_ELECTRON_TEST_OUTPUT;
        if (!output) return;
        fs.mkdirSync(output, { recursive: true });
        const image = await windowRef.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        assert.equal(image.isEmpty(), false, 'the isolated browser window must render');
        fs.writeFileSync(path.join(output, `browser-retry-${label}.png`), image.toPNG());
    }

    app.whenReady().then(async () => {
        server = http.createServer((req, res) => {
            requests.push(req.url);
            res.on('close', () => { if (!res.writableEnded) cancelledRequests.push(req.url); });
            if (req.url.startsWith('/slow-') && !slowResponding) return;
            if (req.url.includes('failure') && failing) { req.socket.destroy(); return; }
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(`<title>${title}</title><h1>Recovered ${req.url}</h1>`);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const file = path.join(out, 'fixture.html');
        fs.writeFileSync(file, '<!doctype html><html><head><style>webview{display:flex;width:100%;height:340px}</style></head><body><div id="view" style="height:420px"></div></body></html>');
        windowRef = new BrowserWindow({ show: false, width: 850, height: 620,
            webPreferences: { contextIsolation: true, sandbox: false, webviewTag: true } });
        // Use the shipped guest policy; the host is a minimal isolated test document.
        require('../modules/ipc/browserHandlers.js').attachToWindow(windowRef);
        windowRef.webContents.on('did-attach-webview', (_event, guest) => {
            currentGuest = guest;
            currentGuestReady = false;
            currentGuestExit = null;
            guest.once('dom-ready', () => { currentGuestReady = true; });
            guest.once('render-process-gone', (_event, details) => { currentGuestExit = details; });
            guestDestroyed = new Promise(resolve => guest.once('destroyed', resolve));
            guest.on('did-fail-load', (_e, code, description, url) => {
                events.push({ event: 'failure', code, description, url, current: guest.getURL() });
            });
            guest.on('did-finish-load', () => events.push({ event: 'finish', url: guest.getURL() }));
            guest.once('destroyed', () => events.push({ event: 'destroyed' }));
        });
        await windowRef.loadFile(file);
        const moduleUrl = pathToFileURL(path.join(repo, 'modules/ui-system/side-pane/browserSideProvider.js')).href;
        for (const previousSuccess of [false, true]) {
            failing = true;
            const initial = base + (previousSuccess ? '/good' : '/failure-initial');
            await windowRef.webContents.executeJavaScript(`(async () => {
                const { createBrowserSideProvider } = await import(${JSON.stringify(moduleUrl)});
                window.__handle = await createBrowserSideProvider({ document, api: null }).mountTab({
                    id: 'browser:probe', payload: { url: ${JSON.stringify(initial)} }
                }, document.getElementById('view'));
            })()`);
            if (previousSuccess) {
                // Main-process observation avoids calling tag methods before dom-ready.
                const until = Date.now() + 10000;
                while (!events.some(event => event.event === 'finish' && event.url === initial)) {
                    assert.ok(Date.now() < until, 'the initial good document must finish loading');
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
                await windowRef.webContents.executeJavaScript(`__handle.navigate(${JSON.stringify(base + '/failure-after-good')})`);
            }
            await poll('!document.querySelector(".side-browser-notice").hidden');
            const before = await windowRef.webContents.executeJavaScript(`({
                current: document.querySelector('webview').getURL(), remembered: __handle.getUrl(),
                detail: document.querySelector('.side-browser-notice-detail').textContent
            })`);
            failing = false;
            title = `Recovered-${previousSuccess ? 'after-good' : 'initial'}`;
            const requestStart = requests.length;
            await windowRef.webContents.executeJavaScript('document.querySelector(".side-browser-notice-retry").click()');
            // A unique title proves the new response committed, even if a prior page was successful.
            await poll(`!document.querySelector('webview').isLoading() && document.querySelector('webview').getTitle() === ${JSON.stringify(title)}`);
            const after = await windowRef.webContents.executeJavaScript(`({
                current: document.querySelector('webview').getURL(),
                noticeHidden: document.querySelector('.side-browser-notice').hidden
            })`);
            const failedPath = previousSuccess ? '/failure-after-good' : '/failure-initial';
            assert.equal(after.noticeHidden, true);
            assert.equal(after.current, base + failedPath);
            assert.ok(requests.slice(requestStart).includes(failedPath), 'retry must request the failed address again');
            results.push({ previousSuccess, before, after, retryRequests: requests.slice(requestStart) });
            await capture(previousSuccess ? 'after-good' : 'initial');
            await windowRef.webContents.executeJavaScript('__handle.dispose()');
            await guestDestroyed;
            assert.equal(currentGuest.isDestroyed(), true, 'removing the view must destroy its real guest');
        }
        for (const action of ['stop-reload', 'replace']) {
            slowResponding = false;
            const slowPath = '/slow-' + action;
            const slowUrl = base + slowPath;
            await windowRef.webContents.executeJavaScript(`(async () => {
                const { createBrowserSideProvider } = await import(${JSON.stringify(moduleUrl)});
                window.__handle = await createBrowserSideProvider({ document, api: null }).mountTab({
                    id: 'browser:slow', payload: { url: ${JSON.stringify(slowUrl)} }
                }, document.getElementById('view'));
            })()`);
            await poll('document.querySelector(".side-browser-nav button:last-child").getAttribute("aria-label") === "停止加载"');
            const until = Date.now() + 10000;
            while (!requests.includes(slowPath)) {
                assert.ok(Date.now() < until, 'the initial slow request must reach the server');
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            assert.equal(currentGuestReady, false, 'no document is ready while the server has not responded');
            let target;
            title = `Recovered-${action}`;
            if (action === 'stop-reload') {
                await windowRef.webContents.executeJavaScript('document.querySelector(".side-browser-nav button:last-child").click()');
                await poll('document.querySelector(".side-browser-nav button:last-child").getAttribute("aria-label") === "刷新"');
                assert.equal(await windowRef.webContents.executeJavaScript('document.querySelector(".side-browser-address").value'), slowUrl,
                    'cancelling before the first commit retains the requested address');
                const requestStart = requests.length;
                slowResponding = true;
                await windowRef.webContents.executeJavaScript('document.querySelector(".side-browser-nav button:last-child").click()');
                target = slowUrl;
                await poll(`document.querySelector('webview').getTitle() === ${JSON.stringify(title)}`);
                assert.ok(requests.slice(requestStart).includes(slowPath), 'refresh must request the cancelled target again');
            } else {
                target = base + '/replacement';
                await windowRef.webContents.executeJavaScript(`__handle.navigate(${JSON.stringify(target)})`);
                await poll(`document.querySelector('webview').getTitle() === ${JSON.stringify(title)}`);
            }
            const cancelUntil = Date.now() + 10000;
            while (!cancelledRequests.includes(slowPath)) {
                assert.ok(Date.now() < cancelUntil, 'stop or replacement must cancel the initial HTTP request');
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            const after = await windowRef.webContents.executeJavaScript(`({ current: document.querySelector('webview').getURL(),
                address: document.querySelector('.side-browser-address').value, noticeHidden: document.querySelector('.side-browser-notice').hidden })`);
            assert.equal(after.current, target);
            assert.equal(after.address, target);
            assert.equal(after.noticeHidden, true, 'intentional cancellation is not a page failure');
            results.push({ action, after });
            await capture(action);
            await windowRef.webContents.executeJavaScript('__handle.dispose()');
            await guestDestroyed;
            assert.equal(currentGuest.isDestroyed(), true);
        }
        const crashUrl = base + '/crash-fixture';
        title = 'Before guest crash';
        await windowRef.webContents.executeJavaScript(`(async () => {
            const { createBrowserSideProvider } = await import(${JSON.stringify(moduleUrl)});
            window.__handle = await createBrowserSideProvider({ document, api: null }).mountTab({
                id: 'browser:crash', payload: { url: ${JSON.stringify(crashUrl)} }
            }, document.getElementById('view'));
        })()`);
        await poll(`document.querySelector('webview').getTitle() === ${JSON.stringify(title)}`);
        const crashedGuest = currentGuest, crashedGuestDestroyed = guestDestroyed;
        crashedGuest.forcefullyCrashRenderer();
        await poll('!document.querySelector(".side-browser-notice").hidden');
        assert.ok(currentGuestExit, 'a real guest exit must reach the main process');
        const crashDetail = await windowRef.webContents.executeJavaScript('document.querySelector(".side-browser-notice-detail").textContent');
        assert.ok(crashDetail.includes(currentGuestExit.reason), 'the notice must report the actual exit reason');
        assert.ok(crashDetail.includes(`退出码 ${currentGuestExit.exitCode}`), 'the notice must report the actual exit code');
        await capture('guest-crash');
        title = 'Recovered guest crash';
        await windowRef.webContents.executeJavaScript('document.querySelector(".side-browser-notice-retry").click()');
        await poll(`document.querySelector('webview').getTitle() === ${JSON.stringify(title)} && document.querySelector('.side-browser-notice').hidden`);
        assert.notEqual(currentGuest.id, crashedGuest.id, 'crash retry must replace the failed guest');
        await crashedGuestDestroyed;
        assert.equal(crashedGuest.isDestroyed(), true);
        assert.equal(await windowRef.webContents.executeJavaScript('document.querySelector("webview").getURL()'), crashUrl);
        results.push({ action: 'crash-retry', crashDetail, recoveredUrl: crashUrl });
        await capture('guest-crash-recovered');
        await windowRef.webContents.executeJavaScript('__handle.dispose()');
        await guestDestroyed;
        assert.equal(currentGuest.isDestroyed(), true);
        assert.equal(events.filter(event => event.event === 'destroyed').length, 6);
        if (process.env.VCP_ELECTRON_TEST_OUTPUT) {
            fs.writeFileSync(path.join(process.env.VCP_ELECTRON_TEST_OUTPUT, 'browser-retry-verification.json'),
                JSON.stringify({ electron: process.versions.electron, results, events, requests }, null, 2));
        }
        clearTimeout(deadline); finish(); app.exit(0);
    }).catch(async error => {
        console.error(error);
        console.error(JSON.stringify({ requests, events, title,
            current: currentGuest && !currentGuest.isDestroyed() ? currentGuest.getURL() : null,
            currentTitle: currentGuest && !currentGuest.isDestroyed() ? currentGuest.getTitle() : null }));
        try {
            if (windowRef && !windowRef.isDestroyed()) await capture('failure');
        } catch (captureError) {
            console.error('Failure screenshot unavailable:', captureError);
        } finally {
            clearTimeout(deadline); finish(); app.exit(1);
        }
    });
}
