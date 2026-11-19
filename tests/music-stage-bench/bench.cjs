/*
 * Frame-time benchmark for the lyric stage on a real GPU.
 *
 *   npx electron tests/music-stage-bench/bench.cjs [--root=<repo>] [--gpu=high|low]
 *       [--seconds=8] [--only=diorama,tunnel] [--size=1280x700|max] [--capped]
 *       [--scale=0.5] [--out=<file.json>] [--shots=<dir>]
 *
 * It serves the music window's stage scripts from --root with a fake player
 * (harness.js), plays a fixed song in each scenario and reports how long frames
 * take. By default the frame rate is not limited, so the numbers are the cost
 * of a frame rather than the display's refresh interval. Nothing is written to
 * the application's own data: the profile lives in a temporary directory.
 */
const { app, BrowserWindow, screen } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [key, value = '1'] = a.slice(2).split('=');
    return [key, value];
}));
const ROOT = path.resolve(args.root || path.join(__dirname, '..', '..'));
const SECONDS = Math.max(2, Number(args.seconds) || 8);
const CAPPED = Boolean(args.capped);

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'music-stage-bench-')));
if (!CAPPED) {
    app.commandLine.appendSwitch('disable-frame-rate-limit');
    app.commandLine.appendSwitch('disable-gpu-vsync');
}
if (args.gpu === 'high') app.commandLine.appendSwitch('force_high_performance_gpu');
if (args.gpu === 'low') app.commandLine.appendSwitch('force_low_power_gpu');
if (args.scale) app.commandLine.appendSwitch('force-device-scale-factor', String(args.scale));

const TYPES = {
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json',
    '.woff2': 'font/woff2', '.svg': 'image/svg+xml'
};
const serve = () => new Promise((resolve) => {
    const server = http.createServer((req, res) => {
        const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (url === '/blank.html') {
            res.writeHead(200, { 'content-type': TYPES['.html'] });
            return res.end('<!doctype html><title>bench</title>');
        }
        if (url === '/Musicmodules/harness.html') {
            // The music window's markup and stage scripts, with the player replaced.
            let html = fs.readFileSync(path.join(ROOT, 'Musicmodules/music.html'), 'utf8');
            const cut = html.indexOf('<script src="music-utils.js">');
            const end = html.indexOf('</body>');
            html = `${html.slice(0, cut)}<script src="/__bench/harness.js"></script>\n${html.slice(end)}`;
            res.writeHead(200, { 'content-type': TYPES['.html'] });
            return res.end(html);
        }
        let file;
        if (url.startsWith('/__bench/')) file = path.join(__dirname, url.slice(9));
        else if (url === '/node_modules/pixi.js/dist/pixi.min.js') file = path.join(ROOT, 'vendor/pixi.min.js');
        else file = path.join(ROOT, url);
        fs.readFile(file, (error, body) => {
            if (error) { res.writeHead(404); return res.end('not found'); }
            res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
            res.end(body);
        });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
});

const tunnelBare = { showPlanets: false, showRings: false, showShips: false, showStations: false };
const SCENARIOS = [
    { name: 'stage off (player UI only)', mode: 'diorama', t: 30, stage: false },
    { name: 'fume (2D reference)', mode: 'fume', t: 30 },
    { name: 'diorama verse', mode: 'diorama', t: 30 },
    { name: 'diorama chorus', mode: 'diorama', t: 56 },
    { name: 'diorama chorus, energy-saving', mode: 'diorama', t: 56, config: { quality: 'energy-saving' } },
    { name: 'diorama chorus, ultimate', mode: 'diorama', t: 56, config: { quality: 'ultimate' } },
    { name: 'diorama chorus, no water reflection', mode: 'diorama', t: 56, config: { modes: { diorama: { waterReflection: false } } } },
    { name: 'diorama chorus, no post-processing', mode: 'diorama', t: 56, config: { modes: { diorama: { postProcess: false } } } },
    { name: 'diorama chorus, no aurora', mode: 'diorama', t: 56, config: { modes: { diorama: { aurora: false } } } },
    { name: 'tunnel planet', mode: 'tunnel', t: 35 },
    { name: 'tunnel rings', mode: 'tunnel', t: 46 },
    { name: 'tunnel rings, energy-saving', mode: 'tunnel', t: 46, config: { quality: 'energy-saving' } },
    { name: 'tunnel rings, no bodies', mode: 'tunnel', t: 46, config: { modes: { tunnel: tunnelBare } } }
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0;
const round = (value) => Math.round(value * 100) / 100;

const measure = async (win, origin, scenario) => {
    await win.loadURL(`${origin}/blank.html`);
    await win.webContents.executeJavaScript(`
        localStorage.clear();
        localStorage.setItem('musicStageMode', ${JSON.stringify(scenario.mode)});
        ${scenario.config ? `localStorage.setItem('musicStageConfig', ${JSON.stringify(JSON.stringify(scenario.config))});` : ''}
        true;
    `);
    await win.loadURL(`${origin}/Musicmodules/harness.html?lyrics=song&duration=215&t=${scenario.t}`);
    await wait(500);
    if (scenario.stage !== false) await win.webContents.executeJavaScript('__h.app.stageHost.enter(); true;');
    await wait(3500);
    await win.webContents.executeJavaScript(`__h.seek(${scenario.t}); __h.frameTimes.length = 0; true;`);
    await wait(SECONDS * 1000);
    const raw = await win.webContents.executeJavaScript(`(() => {
        const canvas = document.querySelector('.music-stage-mode-root canvas');
        const probe = document.createElement('canvas').getContext('webgl2');
        const info = probe && probe.getExtension('WEBGL_debug_renderer_info');
        let snapshot = null;
        try { snapshot = __h.snap(); } catch (error) { snapshot = { error: String(error) }; }
        const stage = snapshot && snapshot.mode || {};
        return {
            frames: __h.frameTimes.slice(),
            errors: __h.errors.slice(0, 5),
            canvas: canvas ? [canvas.width, canvas.height] : null,
            viewport: [innerWidth, innerHeight],
            dpr: devicePixelRatio,
            gl: info ? probe.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
            stage: Object.fromEntries(Object.entries(stage).filter(([, v]) => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'))
        };
    })()`);
    if (args.shots) {
        // What the real GPU drew, for looking at rather than timing.
        fs.mkdirSync(path.resolve(args.shots), { recursive: true });
        const image = await win.webContents.capturePage();
        const file = `${scenario.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
        fs.writeFileSync(path.join(path.resolve(args.shots), file), image.toPNG());
    }
    const intervals = raw.frames.map(([interval]) => interval).sort((a, b) => a - b);
    const script = raw.frames.map(([, cost]) => cost).sort((a, b) => a - b);
    const total = intervals.reduce((sum, value) => sum + value, 0);
    return {
        scenario: scenario.name,
        fps: round(intervals.length / (total / 1000 || 1)),
        frameMs: { p50: quantile(intervals, 0.5), p95: quantile(intervals, 0.95), p99: quantile(intervals, 0.99), max: intervals.at(-1) || 0 },
        over33ms: intervals.filter((value) => value > 33.4).length,
        scriptMs: { p50: quantile(script, 0.5), p95: quantile(script, 0.95), max: script.at(-1) || 0 },
        frames: intervals.length,
        canvas: raw.canvas, viewport: raw.viewport, dpr: raw.dpr, gl: raw.gl, stage: raw.stage, errors: raw.errors
    };
};

app.whenReady().then(async () => {
    const server = await serve();
    const origin = `http://127.0.0.1:${server.address().port}`;
    const display = screen.getPrimaryDisplay();
    const [width, height] = /^\d+x\d+$/.test(args.size || '') ? args.size.split('x').map(Number) : [1280, 700];
    const win = new BrowserWindow({ width, height, show: true, title: 'music stage bench', webPreferences: { backgroundThrottling: false } });
    win.setMenu(null);
    if (args.size === 'max') win.maximize();
    const only = args.only ? args.only.split(',') : null;
    const results = [];
    for (const scenario of SCENARIOS) {
        if (only && !only.some((key) => scenario.name.includes(key))) continue;
        try { results.push(await measure(win, origin, scenario)); }
        catch (error) { results.push({ scenario: scenario.name, failed: String(error && error.stack || error) }); }
        console.log(JSON.stringify(results.at(-1)));
    }
    let gpu = null;
    try { gpu = await app.getGPUInfo('basic'); } catch (error) { gpu = { error: String(error) }; }
    const report = {
        capped: CAPPED,
        gpuSwitch: args.gpu || 'default',
        display: { size: display.size, scaleFactor: display.scaleFactor, hz: display.displayFrequency },
        gpuDevices: (gpu.gpuDevice || []).map((device) => ({ vendorId: device.vendorId, deviceId: device.deviceId, active: device.active, driver: device.driverVersion })),
        features: app.getGPUFeatureStatus(),
        electron: process.versions.electron,
        results
    };
    if (args.out) fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2));
    console.log(`REPORT ${JSON.stringify(report)}`);
    server.close();
    app.quit();
});
