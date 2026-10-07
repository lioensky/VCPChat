// 副屏端到端冒烟：启动真实 Electron，用 CDP 驱动每类标签的打开、使用、休眠、唤醒、关闭，
// 加上切话题、切助手、重启恢复和辅助对话流式回复。断言：没有控制台错误和未处理的 rejection，
// 关掉所有标签后 DOM 节点、JS 监听、scope、资源、guest 页面、主进程推送订阅都回到起点。
//
// 用法：node scripts/smoke-side-pane-e2e.mjs [--keep]
//   Linux 无显示环境用 xvfb-run -a 包一层。--keep 保留临时数据目录和 Electron 日志。
//   SIDE_PANE_SMOKE_ROUNDS 控制开关轮数（默认 3）。结果写到数据目录下的 smoke-report.json 和 electron.log，
//   成功且没有 --keep 时删掉数据目录。
// 自带：模拟的 OpenAI 兼容流式模型服务、测试网页服务、带改动的 Git 工作区、独立的 userData。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electron = require('electron');
const puppeteer = require('puppeteer');
const WebSocket = require('ws');

const KEEP = process.argv.includes('--keep');
const ROUNDS = Number(process.env.SIDE_PANE_SMOKE_ROUNDS || 3);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// SIDE_PANE_SMOKE_DIR 指定证据目录（CI 失败时上传），否则用临时目录
const data = process.env.SIDE_PANE_SMOKE_DIR
    ? fs.mkdtempSync(path.join(fs.mkdirSync(process.env.SIDE_PANE_SMOKE_DIR, { recursive: true }) || process.env.SIDE_PANE_SMOKE_DIR, 'run-'))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-side-pane-smoke-'));
const appData = path.join(data, 'appdata');
const workspace = path.join(data, 'workspace');
fs.mkdirSync(appData);

// 与副屏无关、只因测试环境没有配置而出现的报错（没有 VCP 主服务、没有音频设备等）
const IGNORED_ERRORS = [
    /Failed to load resource/i,
    /ERR_CONNECTION_REFUSED|ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/,
    /mainServerUrl or vcpKey is not configured/,
    /VCPLog|WebSocket connection to/i,
    /dbus/i,
    // uiManager 在没有新版时钟/通知标题元素的布局里每次启动都会报，和副屏无关
    /Digital clock, notification title, or date display element not found/,
];
// 类型声明 persist: false 的标签不跨重启恢复（辅助对话、终端、命令输出），见 tab-types/*.js
const NOT_PERSISTED = /^(sidechat-|terminal:|tool-output:)/;

const report = { startedAt: new Date().toISOString(), data, rounds: ROUNDS, phases: [], errors: [], counters: {} };
const errors = report.errors;
let phase = 'startup';
const recordError = (source, text) => {
    const line = String(text).slice(0, 600);
    if (IGNORED_ERRORS.some(re => re.test(line))) return;
    errors.push({ phase, source, text: line });
};

// ---- 本地服务 ----
function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function freePort() {
    return new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
let replies = 0;
const mockModel = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'smoke-model', object: 'model' }] }));
    }
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
        let stream = true;
        try { stream = JSON.parse(raw).stream !== false; } catch { /* 非 JSON 请求按流式处理 */ }
        const n = ++replies;
        const text = `SMOKE_REPLY_${n}\n\n- 第一项\n- 第二项 **加粗**\n\n\`\`\`js\nconst x = ${n};\n\`\`\`\n\n` + '段落 '.repeat(60);
        if (!stream) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ id: 'c' + n, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        for (const part of text.match(/[\s\S]{1,40}/g)) {
            res.write(`data: ${JSON.stringify({ id: 'c' + n, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`);
            await wait(10);
        }
        res.write(`data: ${JSON.stringify({ id: 'c' + n, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
});
const pageServer = http.createServer((req, res) => {
    const id = new URL(req.url, 'http://x').searchParams.get('p') || '0';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>smoke page ${id}</title><body><h1 id="h">page ${id}</h1><script>let n=0;setInterval(()=>{document.getElementById('h').dataset.n=++n},200)</script>`);
});

// ---- Git 工作区：一次提交 + 几处改动，计划 / Git 页有内容可显示 ----
function seedWorkspace() {
    fs.mkdirSync(workspace);
    const git = (...args) => execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', ...args], { cwd: workspace, stdio: 'ignore' });
    git('init', '-q');
    for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(workspace, `f${i}.txt`), Array.from({ length: 40 }, (_, j) => `file ${i} line ${j}`).join('\n') + '\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    fs.appendFileSync(path.join(workspace, 'f1.txt'), 'changed line\n');
    fs.writeFileSync(path.join(workspace, 'new.txt'), 'SMOKE_CODE_VIEWER\n');
}

// ---- Electron 进程 ----
let child = null;
let mainWs = null;
let mainSeq = 0;
const mainPending = new Map();
let cdpPort = 0;
let inspectPort = 0;

async function launch() {
    cdpPort = await freePort();
    inspectPort = await freePort();
    const env = { ...process.env, VCPCHAT_APP_DATA_DIR: appData };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = ['.', `--remote-debugging-port=${cdpPort}`, `--inspect=${inspectPort}`];
    if (process.platform === 'linux') args.push('--no-sandbox');
    child = spawn(electron, args, { cwd: root, env, windowsHide: true });
    const logFile = fs.createWriteStream(path.join(data, 'electron.log'), { flags: 'a' });
    const onOutput = chunk => {
        logFile.write(chunk);
        for (const line of String(chunk).split('\n')) {
            if (/Unhandled(Promise)?Rejection|unhandledRejection|Uncaught Exception|uncaughtException/i.test(line)) recordError('main', line);
        }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    for (let i = 0; i < 120; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json();
            if (list[0]?.webSocketDebuggerUrl) {
                mainWs = new WebSocket(list[0].webSocketDebuggerUrl);
                await new Promise((resolve, reject) => { mainWs.once('open', resolve); mainWs.once('error', reject); });
                mainWs.on('message', raw => { const m = JSON.parse(raw); if (mainPending.has(m.id)) { mainPending.get(m.id)(m); mainPending.delete(m.id); } });
                // 应用退出时连接会被重置，不能让它变成本脚本的未捕获异常
                mainWs.on('error', () => {});
                mainWs.on('close', () => { for (const resolve of mainPending.values()) resolve({}); mainPending.clear(); });
                break;
            }
        } catch { /* 还没起来 */ }
        await wait(500);
    }
    assert.ok(mainWs, 'main process inspector did not come up');
    await mainSend('Runtime.enable');
    // 主进程里的未处理 rejection 和异常
    mainWs.on('message', raw => {
        const m = JSON.parse(raw);
        if (m.method === 'Runtime.exceptionThrown') recordError('main', m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    });
    let browser = null;
    for (let i = 0; i < 120 && !browser; i++) {
        try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}`, defaultViewport: null }); } catch { await wait(500); }
    }
    assert.ok(browser, 'renderer DevTools endpoint did not come up');
    let page = null;
    for (let i = 0; i < 120 && !page; i++) {
        page = (await browser.pages()).find(p => p.url().endsWith('/main.html')) || null;
        if (!page) await wait(500);
    }
    assert.ok(page, 'main.html window did not open');
    const client = await page.createCDPSession();
    await client.send('Runtime.enable');
    client.on('Runtime.exceptionThrown', e => recordError('renderer', e.exceptionDetails?.exception?.description || e.exceptionDetails?.text));
    page.on('console', msg => { if (msg.type() === 'error') recordError('console', msg.text()); });
    await page.waitForFunction(() => !!window.VCPContributions?.commands && !!window.VCPLifecycleInspector, { timeout: 60000 });
    await wait(3000);
    return { browser, page, client };
}

function mainSend(method, params = {}) {
    const id = ++mainSeq;
    mainWs.send(JSON.stringify({ id, method, params }));
    return new Promise(resolve => mainPending.set(id, resolve));
}
async function mainEval(expression) {
    const r = await mainSend('Runtime.evaluate', { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value;
}

async function quit(session) {
    await session.browser.disconnect().catch(() => {});
    await mainEval(`process.mainModule.require('electron').app.quit()`).catch(() => {});
    const closed = await Promise.race([new Promise(resolve => child.once('close', () => resolve(true))), wait(20000).then(() => false)]);
    if (!closed) stopChild();
    mainWs?.close();
    mainWs = null;
}
function stopChild() {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
}

// ---- 测量 ----
async function measure({ page, client, browser }) {
    await client.send('HeapProfiler.collectGarbage');
    await mainSend('HeapProfiler.collectGarbage').catch(() => {});
    const dom = await client.send('Memory.getDOMCounters');
    const r = await page.evaluate(async () => {
        const s = window.VCPLifecycleInspector.snapshot();
        const m = await window.VCPLifecycleInspector.snapshotMain();
        return {
            scopes: s.scopeSummary.activeScopes,
            resources: s.scopeSummary.activeResources,
            channelSubs: s.states.reduce((n, c) => n + (c.subscribers || 0), 0),
            sourceHolders: s.sources.reduce((n, c) => n + (c.holders || 0), 0),
            tabs: s.sidePane?.tabs?.map(t => ({ id: t.id, kind: t.kind, view: t.view, resources: t.resources?.resources ?? null })) || [],
            mainSubs: m.subscriptions?.length ?? 0,
            gitWatchers: m.gitWatchers?.length ?? 0,
        };
    });
    const guests = (await browser.targets()).filter(t => t.type() === 'webview').length;
    const main = JSON.parse(await mainEval(`(() => { const { ipcMain } = process.mainModule.require('electron'); let n = 0; for (const e of ipcMain.eventNames()) n += ipcMain.listenerCount(e); return JSON.stringify({ ipcListeners: n, handles: process._getActiveHandles().length }); })()`));
    return { domNodes: dom.nodes, jsListeners: dom.jsEventListeners, ...r, guests, ...main };
}
const FLAT_KEYS = ['domNodes', 'jsListeners', 'scopes', 'resources', 'channelSubs', 'sourceHolders', 'guests', 'mainSubs', 'gitWatchers', 'ipcListeners'];
function assertFlat(label, base, now, tolerance = {}) {
    const deltas = Object.fromEntries(FLAT_KEYS.map(k => [k, (now[k] ?? 0) - (base[k] ?? 0)]));
    report.counters[label] = { base: pick(base), now: pick(now), deltas };
    for (const key of FLAT_KEYS) {
        const allowed = tolerance[key] ?? 0;
        assert.ok(deltas[key] <= allowed, `${label}: ${key} grew by ${deltas[key]} (allowed ${allowed}); base ${base[key]}, now ${now[key]}`);
    }
}
const pick = m => Object.fromEntries(FLAT_KEYS.map(k => [k, m[k]]));

// ---- 驱动 ----
const cmd = (page, tab) => page.evaluate(t => window.VCPContributions.commands.execute('sidepane.open-tab', t), tab);
async function entry(page, id) {
    await page.evaluate(() => document.querySelector('.side-pane-home-btn')?.click());
    await wait(200);
    const ok = await page.evaluate(id => { const b = document.querySelector(`[data-open-tab-entry="${id}"]`); b?.click(); return !!b; }, id);
    assert.ok(ok, `launcher entry ${id} missing`);
}
const activeView = page => page.evaluate(() => {
    const v = document.querySelector('.side-pane-view.active');
    return v ? { text: v.textContent.slice(0, 4000), nodes: v.getElementsByTagName('*').length } : null;
});
async function waitIn(page, fn, arg, label, timeout = 20000) {
    try { await page.waitForFunction(fn, { timeout, polling: 200 }, arg); }
    catch { throw new Error(`timed out: ${label}`); }
}
async function closeAll(page) {
    for (let i = 0; i < 40; i++) {
        const left = await page.evaluate(() => { const b = document.querySelector('.side-pane-tab-item .side-pane-tab-close'); b?.click(); return !!b; });
        if (!left) return;
        await wait(250);
        // 有记录的辅助对话关闭前要确认
        const confirmed = await page.evaluate(() => { const b = [...document.querySelectorAll('.confirm-dialog button')].find(x => x.textContent.includes('关闭并删除')); b?.click(); return !!b; });
        if (confirmed) await wait(400);
    }
    throw new Error('tabs did not close');
}
async function sendSideChat(page, text) {
    await page.evaluate(() => document.querySelector('.side-pane-view.active .side-chat-textarea')?.focus());
    await page.keyboard.type(text);
    const before = replies;
    await page.evaluate(() => document.querySelector('.side-pane-view.active .side-chat-send-btn')?.click());
    for (let i = 0; i < 150 && replies === before; i++) await wait(100);
    assert.ok(replies > before, 'side chat send never reached the model');
    const marker = `SMOKE_REPLY_${replies}`;
    await waitIn(page, m => {
        const v = document.querySelector('.side-pane-view.active');
        return !!v && v.textContent.includes(m) && !v.querySelector('.message-item.streaming, .thinking');
    }, marker, `streamed reply ${marker}`);
}
const chatItems = page => page.evaluate(() => document.querySelectorAll('.side-pane-view.active .message-item').length);
// 唤醒后记录按批次渲染，忙的时候半秒内可能还没渲染完：最多等 4 秒到预期条数，少了照样算失败
async function settledChatItems(page, expected) {
    let n = await chatItems(page);
    for (let i = 0; i < 20 && n < expected; i++) { await wait(200); n = await chatItems(page); }
    return n;
}
const activeTabId = page => page.evaluate(() => document.querySelector('.side-pane-tab.active, .side-pane-tab[aria-selected="true"]')?.dataset.tabId || null);
async function activate(page, id) {
    await page.evaluate(id => document.querySelector(`.side-pane-tab[data-tab-id="${CSS.escape(id)}"]`)?.click(), id);
    await wait(id.startsWith('browser') ? 1200 : 500);
}

function kinds(pageUrl) {
    const codeFile = path.join(workspace, 'new.txt');
    return {
        chat: {
            open: page => entry(page, 'selection-side-conversation'),
            use: async page => { await sendSideChat(page, '冒烟问题'); },
        },
        terminal: {
            open: page => entry(page, 'terminal'),
            use: async page => {
                const marker = 'SMOKE_TERM_' + Date.now();
                await waitIn(page, () => !!document.querySelector('.side-pane-view.active .xterm-helper-textarea'), null, 'terminal mounted');
                await page.evaluate(() => document.querySelector('.side-pane-view.active .xterm-helper-textarea')?.focus());
                await page.keyboard.type(`echo ${marker}\n`);
                await waitIn(page, m => (document.querySelector('.side-pane-view.active .xterm-rows, .side-pane-view.active .xterm-accessibility-tree')?.textContent || '').split(m).length > 2, marker, 'terminal echo');
            },
        },
        browser: {
            open: page => cmd(page, { id: 'browser:smoke', kind: 'browser', title: '浏览器', closable: true, scopeMode: 'global', payload: { url: pageUrl + '?p=1' } }),
            use: async (page, { browser }) => {
                const guestAt = async p => { for (let i = 0; i < 80; i++) { if ((await browser.targets()).some(t => t.type() === 'webview' && t.url().includes('p=' + p))) return true; await wait(150); } return false; };
                assert.ok(await guestAt(1), 'browser guest did not load page 1');
                await page.evaluate(u => { const a = document.querySelector('.side-pane-view.active .side-browser-address'); a.focus(); a.value = u; a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, pageUrl + '?p=2');
                assert.ok(await guestAt(2), 'browser guest did not navigate to page 2');
            },
        },
        'plan-git': {
            open: page => cmd(page, { id: 'plan-detail:none', kind: 'plan-detail', title: '计划详情', closable: true, scopeMode: 'global', payload: {} }),
            use: async page => {
                await wait(600);
                await page.evaluate(() => [...document.querySelectorAll('.side-pane-view.active button, .side-pane-view.active [role=tab]')].find(b => b.textContent.trim() === 'Git')?.click());
                await waitIn(page, () => document.querySelectorAll('.side-pane-view.active .side-git-row').length > 0, null, 'git rows');
            },
        },
        'code-viewer': {
            open: page => cmd(page, { id: 'code-viewer:' + codeFile, kind: 'code-viewer', title: 'new.txt', closable: true, scopeMode: 'global', payload: { filePath: codeFile, mode: 'view', language: 'plaintext' } }),
            use: page => waitIn(page, () => document.querySelector('.side-pane-view.active')?.textContent.includes('SMOKE_CODE_VIEWER'), null, 'code viewer content'),
        },
        trajectory: {
            open: page => entry(page, 'model-trajectory'),
            use: page => waitIn(page, () => (document.querySelector('.side-pane-view.active')?.getElementsByTagName('*').length || 0) > 5, null, 'trajectory mounted'),
        },
        'tool-output': {
            open: page => cmd(page, { id: 'tool-output:main', kind: 'tool-output', title: '命令输出', closable: true, scopeMode: 'global' }),
            use: page => waitIn(page, () => (document.querySelector('.side-pane-view.active')?.getElementsByTagName('*').length || 0) > 3, null, 'tool output mounted'),
        },
    };
}

async function step(name, fn) {
    phase = name;
    const t0 = Date.now();
    process.stdout.write(`[smoke] ${name} ... `);
    try {
        const out = await fn();
        report.phases.push({ name, ms: Date.now() - t0, ok: true, ...(out ? { detail: out } : {}) });
        console.log(`ok (${Date.now() - t0} ms)`);
        return out;
    } catch (error) {
        report.phases.push({ name, ms: Date.now() - t0, ok: false, error: String(error.stack || error) });
        console.log('FAILED');
        throw error;
    }
}

async function selectAgent(page, name) {
    await waitIn(page, n => [...document.querySelectorAll('li[data-item-id]')].some(li => li.textContent.includes(n)), name, `agent ${name} listed`);
    await page.evaluate(n => [...document.querySelectorAll('li[data-item-id]')].find(li => li.textContent.includes(n)).click(), name);
    await wait(1200);
}
const topicIds = page => page.evaluate(() => [...document.querySelectorAll('#topicList li[data-topic-id]')].map(li => li.dataset.topicId));
async function pickTopic(page, id) {
    await page.evaluate(id => document.querySelector(`#topicList li[data-topic-id="${id}"]`)?.click(), id);
    await wait(900);
}

// ---- 主流程 ----
let session = null;
let exitCode = 1;
try {
    seedWorkspace();
    const modelPort = await listen(mockModel);
    const pagePort = await listen(pageServer);
    const pageUrl = `http://127.0.0.1:${pagePort}/page.html`;
    const K = kinds(pageUrl);

    session = await step('launch', () => launch());
    await step('seed agents, workspace and model endpoint', async () => {
        const { page } = session;
        await page.evaluate(async ({ ws, url }) => {
            const api = window.chatAPI || window.electronAPI;
            await api.createAgent('SmokeAgent');
            await api.createAgent('SmokeAgentB');
            await api.addWorkspace(ws);
            const settings = await api.loadSettings();
            await api.saveSettings({ ...settings, vcpServerUrl: url, vcpApiKey: 'smoke' });
        }, { ws: workspace, url: `http://127.0.0.1:${modelPort}/v1/chat/completions` });
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => !!window.VCPContributions?.commands, { timeout: 60000 });
        await wait(3000);
        await selectAgent(page, 'SmokeAgentB');
        await selectAgent(page, 'SmokeAgent');
        if ((await topicIds(page)).length < 2) {
            await page.evaluate(() => document.getElementById('currentAgentSettingsBtn')?.click());
            await wait(1500);
        }
        const topics = await topicIds(page);
        assert.ok(topics.length >= 2, `need two topics, have ${topics.length}`);
        return { topics: topics.length };
    });

    // 每类走一遍，热身：第一次挂载会加载模块、编译代码，不算增长
    await step('warm up every tab kind', async () => {
        for (const [name, k] of Object.entries(K)) { await k.open(session.page); await wait(900); await k.use(session.page, session); await closeAll(session.page); await wait(400); }
    });
    const baseline = await measure(session);
    report.counters.baseline = pick(baseline);

    await step(`open, use and close every tab kind x${ROUNDS}`, async () => {
        for (let round = 0; round < ROUNDS; round++) {
            for (const [name, k] of Object.entries(K)) {
                phase = `open-use-close:${name}`;
                await k.open(session.page); await wait(900);
                await k.use(session.page, session);
                await closeAll(session.page); await wait(400);
            }
        }
        assertFlat('open-use-close', baseline, await measure(session));
    });

    let historyChat = null;
    await step('sleep and wake: 12 tabs over the live-view limit', async () => {
        const { page } = session;
        await K.chat.open(page); await wait(1000);
        for (let i = 1; i <= 3; i++) await sendSideChat(page, `休眠前的问题 ${i}`);
        historyChat = await activeTabId(page);
        const expected = await chatItems(page);
        await K.chat.open(page); await wait(800);
        for (const name of ['terminal', 'browser', 'plan-git', 'trajectory', 'tool-output']) { await K[name].open(page); await wait(900); if (name === 'plan-git') await K[name].use(page, session); }
        for (const n of [1, 2, 3, 4, 5]) {
            const f = path.join(workspace, `f${n}.txt`);
            await cmd(page, { id: 'code-viewer:' + f, kind: 'code-viewer', title: `f${n}.txt`, closable: true, scopeMode: 'global', payload: { filePath: f, mode: 'view', language: 'plaintext' } });
            await wait(500);
        }
        const ids = await page.evaluate(() => [...document.querySelectorAll('.side-pane-tab[data-tab-id]')].map(e => e.dataset.tabId).filter(id => id !== 'notifications'));
        // 辅助对话按 keep 常驻、浏览器另有网页名额，其余 9 个视图（终端、计划、轨迹、命令输出、5 个代码）超出 8 个名额
        assert.ok(ids.length >= 12, `expected at least 12 tabs, got ${ids.length}`);
        const counts = [];
        let first = null;
        for (let round = 0; round < 3; round++) {
            for (const id of ids) { await activate(page, id); if (id === historyChat) counts.push(await settledChatItems(page, expected)); }
            const m = await measure(session);
            const dormant = m.tabs.filter(t => t.view === 'dormant');
            assert.ok(dormant.length >= 1, 'nothing went dormant over the live-view limit');
            assert.ok(dormant.every(t => t.resources == null), 'a dormant tab still holds resources');
            if (first) assertFlat(`sleep-wake round ${round}`, first, m, { domNodes: 30 });
            else first = m;
        }
        assert.ok(counts.every(c => c === expected), `side chat history after wake: ${counts.join(',')} (expected ${expected})`);
        return { tabs: ids.length, wakeItems: counts };
    });

    await step('topic switching x6 with side chats open', async () => {
        const { page } = session;
        const [a, b] = await topicIds(page);
        await pickTopic(page, a);
        const before = await measure(session);
        for (let i = 0; i < 6; i++) { await pickTopic(page, b); await pickTopic(page, a); }
        await wait(500);
        assertFlat('topic switching', before, await measure(session), { domNodes: 30 });
    });

    await step('agent switching x4', async () => {
        const { page } = session;
        const before = await measure(session);
        for (let i = 0; i < 4; i++) { await selectAgent(page, 'SmokeAgentB'); await selectAgent(page, 'SmokeAgent'); }
        assertFlat('agent switching', before, await measure(session), { domNodes: 30 });
    });

    const tabsBeforeRestart = await session.page.evaluate(() => [...document.querySelectorAll('.side-pane-tab[data-tab-id]')].map(e => e.dataset.tabId).filter(id => id !== 'notifications'));
    await step('restart and restore', async () => {
        await wait(1500); // 等布局写盘
        await quit(session);
        session = await launch();
        const { page } = session;
        await selectAgent(page, 'SmokeAgent');
        const [a] = await topicIds(page);
        await pickTopic(page, a);
        await wait(1500);
        const restored = await page.evaluate(() => [...document.querySelectorAll('.side-pane-tab[data-tab-id]')].map(e => e.dataset.tabId).filter(id => id !== 'notifications'));
        const expected = tabsBeforeRestart.filter(id => !NOT_PERSISTED.test(id));
        const missing = expected.filter(id => !restored.includes(id));
        assert.deepEqual(missing, [], `tabs not restored after restart: ${missing.join(', ')}`);
        assert.ok(expected.length >= 5, `too few persistable tabs to check restore: ${expected.join(', ')}`);
        // 恢复的标签都能重新挂载并显示内容
        for (const id of expected) {
            await activate(page, id);
            await waitIn(page, () => (document.querySelector('.side-pane-view.active')?.getElementsByTagName('*').length || 0) > 3, null, `restored tab ${id} mounted`);
        }
        await activate(page, expected.find(id => id.startsWith('browser:')));
        await K.browser.use(page, session);
        return { restored: restored.length, expected: expected.length };
    });

    await step('streaming after restart, then close everything', async () => {
        const { page } = session;
        await K.chat.open(page); await wait(1000);
        await sendSideChat(page, '重启后的问题');
        await closeAll(page); await wait(1500);
        // 重启后再跑一轮热身，回到同样的起点再比
        for (const k of Object.values(K)) { await k.open(page); await wait(900); await k.use(page, session); await closeAll(page); await wait(400); }
        const base2 = await measure(session);
        for (const k of Object.values(K)) { await k.open(page); await wait(900); await k.use(page, session); await closeAll(page); await wait(400); }
        assertFlat('after restart', base2, await measure(session));
    });

    phase = 'done';
    assert.deepEqual(errors, [], `console errors or unhandled rejections:\n${errors.map(e => `[${e.phase}] ${e.source}: ${e.text}`).join('\n')}`);
    exitCode = 0;
    console.log(`Side pane smoke passed (${report.phases.length} phases, ${replies} streamed replies).`);
} catch (error) {
    report.failure = String(error.stack || error);
    console.error(error.message || error);
    if (errors.length) console.error(errors.map(e => `[${e.phase}] ${e.source}: ${e.text}`).join('\n'));
    // CI 里拿不到界面，把 Electron 日志尾部直接打出来
    try { console.error('--- electron.log (tail) ---\n' + fs.readFileSync(path.join(data, 'electron.log'), 'utf8').split('\n').slice(-80).join('\n')); } catch { /* 还没启动 */ }
} finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(data, 'smoke-report.json'), JSON.stringify(report, null, 1));
    if (session) await quit(session).catch(() => {});
    stopChild();
    mockModel.close();
    pageServer.close();
    if (exitCode === 0 && !KEEP) {
        // Electron 的子进程可能比主进程晚退出，还在往 Partitions 里写，删目录会撞上 ENOTEMPTY；
        // 重试几次，仍删不掉也只是留下临时目录，不算冒烟失败
        try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
        catch (error) { console.warn(`Could not remove ${data}: ${error.code || error.message}`); }
    } else console.log('Evidence: ' + data);
    process.exit(exitCode);
}
