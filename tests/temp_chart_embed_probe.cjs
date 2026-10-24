'use strict';

// 临时探针：验证主窗口内嵌图表沙箱的运行时前提（自定义协议 vcp-chart://）。
// 运行：set ELECTRON_RUN_AS_NODE=&& npx electron tests/temp_chart_embed_probe.cjs
const { app, BrowserWindow, protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PROJECT_ROOT = path.join(__dirname, '..');
const ALLOWED = new Map([
    ['/Chartmodules/chart-sandbox.html', 'Chartmodules/chart-sandbox.html'],
    ['/Chartmodules/chart-sandbox.js', 'Chartmodules/chart-sandbox.js'],
    ['/vendor/anime.min.js', 'vendor/anime.min.js'],
    ['/vendor/three.min.js', 'vendor/three.min.js'],
    ['/vendor/pixi.min.js', 'vendor/pixi.min.js'],
    ['/vendor/pixi-unsafe-eval.min.js', 'vendor/pixi-unsafe-eval.min.js'],
]);

protocol.registerSchemesAsPrivileged([{
    scheme: 'vcp-chart',
    privileges: { standard: true, secure: true },
}]);

const sandboxUrl = 'vcp-chart://app/Chartmodules/chart-sandbox.html';

function hostHtml() {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' data:; script-src 'self' 'unsafe-inline'; frame-src 'self' vcp-chart:;">
</head><body>
<div id="a"></div><div id="b"></div>
<script>
window.__probe = new Promise(resolve => {
  const result = { hasMoveBefore: typeof Element.prototype.moveBefore === 'function', readyCount: 0, statuses: [], errors: [], loads: 0 };
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.style.width = '400px'; iframe.style.height = '300px';
  iframe.addEventListener('load', () => { result.loads += 1; });
  iframe.src = ${JSON.stringify(sandboxUrl)};
  window.addEventListener('message', event => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data || {};
    if (msg.type === 'sandbox-ready') {
      result.readyCount += 1;
      result.origin = event.origin;
      if (result.readyCount === 1) {
        iframe.contentWindow.postMessage({ source: 'vcp-chart-shell', type: 'initialize', snapshot: {
          generation: 1,
          manifest: { id: 'probe', libraries: ['anime'] },
          template: '<div id="x">hi</div>', style: '', data: { n: 1 },
          runtime: 'let count = 0; return { mount(ctx){ count = 1; }, update(change, ctx){ count += 1; ctx.emit("count", { count, hasAnime: typeof anime }); } };'
        } }, '*');
      }
    }
    if (msg.type === 'status') result.statuses.push(msg.status);
    if (msg.type === 'error') result.errors.push(String(msg.message).slice(0, 300));
    if (msg.type === 'ready' && !result.moved) {
      result.moved = true;
      try { document.getElementById('b').moveBefore(iframe, null); }
      catch (error) { result.errors.push('move: ' + error.message); }
      setTimeout(() => {
        iframe.contentWindow.postMessage({ source: 'vcp-chart-shell', type: 'data-change', chartId: 'probe', change: { type: 'data-patched', operations: [] } }, '*');
      }, 600);
    }
    if (msg.type === 'runtime-event' && msg.name === 'count') {
      result.afterMove = msg.payload;
      result.loadsAfterMove = result.loads;
      resolve(result);
    }
  });
  setTimeout(() => resolve({ ...result, timeout: true }), 6000);
  document.getElementById('a').appendChild(iframe);
});
</script></body></html>`;
}

app.whenReady().then(async () => {
    const requested = [];
    protocol.handle('vcp-chart', request => {
        const url = new URL(request.url);
        requested.push(url.pathname);
        const relative = url.host === 'app' ? ALLOWED.get(url.pathname) : null;
        if (!relative) return new Response('Not Found', { status: 404 });
        return net.fetch(pathToFileURL(path.join(PROJECT_ROOT, relative)).href);
    });

    const hostFile = path.join(PROJECT_ROOT, 'temp_chart_embed_host.html');
    fs.writeFileSync(hostFile, hostHtml(), 'utf8');
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    const consoleLines = [];
    win.webContents.on('console-message', (...args) => {
        const details = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : { message: args[2] };
        const text = String(details.message);
        if (!text.includes('Electron Security Warning')) consoleLines.push(text.slice(0, 300));
    });
    let result;
    try {
        await win.loadFile(hostFile);
        result = await win.webContents.executeJavaScript('window.__probe', true);
    } catch (error) {
        result = { failed: error.message };
    } finally {
        win.destroy();
        fs.rmSync(hostFile, { force: true });
    }
    console.log('PROBE_RESULT', JSON.stringify({
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        ...result,
        requested,
        console: consoleLines,
    }, null, 2));
    app.quit();
});