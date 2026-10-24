'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, protocol, net } = require('electron');
const { registerChartEmbedScheme, installChartEmbedProtocol } = require('../modules/services/chartEmbedProtocol');

registerChartEmbedScheme(protocol);
const projectRoot = path.resolve(__dirname, '..');
app.on('window-all-closed', () => {});
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });

app.whenReady().then(async () => {
    await installChartEmbedProtocol({ protocol, net, projectRoot });
    const file = path.join(projectRoot, `temp-chart-embed-${process.pid}.html`);
    const runtime = `
let mounts = 0;
let ticks = 0;
return {
 async mount(context) {
   mounts++;
   const result = await context.dataSources.readJson('probe-source');
   context.emit('mounted', { mounts, source: result.data });
   context.resources.setInterval(() => { ticks++; }, 20);
 },
 update(change, context) {
   context.emit('updated', { mounts, ticks, value: context.data.value });
 },
 pause(context) { context.emit('paused', { mounts, ticks }); },
 resume(context) { context.emit('resumed', { mounts, ticks }); }
};`;
    fs.writeFileSync(file, `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src vcp-chart:;">
<link rel="stylesheet" href="styles/messageRenderer.css">
</head><body><div id="root"></div>
<script type="module">
import { createChartEmbedHost } from './modules/renderer/chartEmbedHost.js';
import { transformChartReferences } from './modules/chat/chartEmbedTransform.js';
window.events = [];
window.loads = 0;
window.acquires = 0;
window.releases = 0;
window.sourceReads = 0;
window.revision = 1;
const root = document.getElementById('root');
const reference = ${JSON.stringify('```vcp-chart\nid: probe-chart\nheight: 360\n```')};
const snapshot = () => ({
 manifest: { id: 'probe-chart', libraries: ['anime'], codeRevision: 1, dataRevision: window.revision },
 template: '<div>Chart embed integration test</div>', style: '', data: { value: window.revision },
 runtime: ${JSON.stringify(runtime)}
});
let changed;
const api = {
 chartEmbedAcquire: async () => { window.acquires++; return { token: 'test-token', snapshot: snapshot() }; },
 chartEmbedRelease: async () => { window.releases++; },
 chartEmbedSnapshot: async () => snapshot(),
 chartEmbedReadDataSource: async () => { window.sourceReads++; return { data: 'source-ok' }; },
 onChartEmbedChanged: callback => { changed = callback; return () => { changed = null; }; }
};
window.host = createChartEmbedHost({ root, api });
root.innerHTML = transformChartReferences(reference) + transformChartReferences(reference);
window.host.scan(root);
window.addEventListener('message', event => {
 if (event.data?.source === 'vcp-chart-sandbox') window.events.push(event.data);
});
window.captureFrame = () => {
 window.originalFrame = root.querySelector('iframe');
 window.originalFrame.addEventListener('load', () => window.loads++);
 return !!window.originalFrame;
};
window.transfer = () => {
 window.beforeHeights = [...root.children].map(node => node.getBoundingClientRect().height);
 root.children[0].querySelector('button').click();
 return root.children[0].querySelector('iframe') === window.originalFrame;
};
window.replace = () => {
 window.host.beforeReplace(root);
 const parked = document.querySelector('[data-chart-embed-parking] iframe') === window.originalFrame;
 root.innerHTML = transformChartReferences(reference);
 window.host.scan(root);
 return parked;
};
window.update = () => { window.revision++; changed({ chartId: 'probe-chart', type: 'data-replaced' }); };
window.check = () => ({
 acquires: window.acquires, releases: window.releases, sourceReads: window.sourceReads,
 sameFrame: root.querySelector('iframe') === window.originalFrame,
 frames: document.querySelectorAll('iframe').length,
 readyCount: window.events.filter(event => event.type === 'sandbox-ready').length,
 events: window.events.filter(event => event.type === 'runtime-event').map(event => ({ name: event.name, ...event.payload })),
 errors: window.events.filter(event => event.type === 'error').map(event => event.message),
 heights: [...root.children].map(node => node.getBoundingClientRect().height),
});
window.testReady = true;
</script></body></html>`, 'utf8');
    const win = new BrowserWindow({
        show: false, width: 900, height: 900,
        webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    const logs = [];
    win.webContents.on('console-message', (_event, _level, message) => logs.push(message));
    const evaluate = code => win.webContents.executeJavaScript(code, true);
    async function until(code) {
        for (let attempt = 0; attempt < 120; attempt++) {
            if (await evaluate(code)) return;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`Timed out: ${code}; ${JSON.stringify(await evaluate('window.check?.()'))}; ${logs.join('\n')}`);
    }
    try {
        await win.loadFile(file);
        // The window must be shown for real IntersectionObserver/frame scheduling.
        win.showInactive();
        await until('window.testReady && window.captureFrame()');
        await until('window.events.some(event => event.name === "mounted")');
        assert.equal(await evaluate('window.transfer()'), true);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(await evaluate('window.replace()'), true);
        await until('window.check().sameFrame');
        await new Promise(resolve => setTimeout(resolve, 200));
        await evaluate('window.update()');
        await until('window.events.some(event => event.name === "updated")');
        const result = await evaluate('window.check()');
        assert.equal(result.acquires, 1);
        assert.equal(result.sourceReads, 1);
        assert.equal(result.readyCount, 1);
        assert.equal(result.sameFrame, true);
        assert.equal(result.frames, 1);
        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.heights, [360]);
        const update = result.events.find(event => event.name === 'updated');
        assert.equal(update.mounts, 1);
        assert.equal(update.value, 2);
        assert.ok(result.events.some(event => event.name === 'paused'));
        await evaluate('window.host.dispose()');
        await until('window.releases === 1');
        console.log('CHART_EMBED_ELECTRON_PASS', JSON.stringify(result, null, 2));
    } finally {
        win.destroy();
        fs.rmSync(file, { force: true });
    }
    app.quit();
}).catch(error => {
    console.error('CHART_EMBED_ELECTRON_FAILED', error);
    app.exit(1);
});