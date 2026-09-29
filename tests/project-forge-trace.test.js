'use strict';
// ProjectForge Trace（P3 链路地图）测试：
// 1. 纯函数：buildGraph / trace 对手写 facts 的装配（页面顺序告警、别名同页判定、wrapper/param 处理），不依赖二进制；
// 2. 端到端：临时迷你仓库（preload 声明表 + 主进程包装 handler + 页面级别名 + 加载顺序问题），需要索引器二进制，缺失时 skip。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LG = require('../VCPDistributedServer/Plugin/ProjectForge/linkGraph');
const forge = require('../VCPDistributedServer/Plugin/ProjectForge/ProjectForgeService');
const { resolveDefaultBinaryPath } = require('../VCPDistributedServer/Plugin/ProjectForge/indexerClient');

const SKIP_BIN = fs.existsSync(resolveDefaultBinaryPath()) ? false : '未找到索引器二进制（npm run build:pf-indexer 构建后再跑）';
const textOf = r => r.content.filter(p => p.type === 'text').map(p => p.text).join('\n');

let tmp;
let repo;

function write(rel, content) {
    const abs = path.join(repo, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

test.before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-trace-test-'));
    repo = path.join(tmp, 'repo');
    write('preloads/core/registry.js', `'use strict';
module.exports = {
    ROLE_GLOBALS: { chat: 'chatAPI', utility: 'utilityAPI' },
    describeApis: () => [
        { name: 'saveSettings', domain: 'settings', kind: 'query', channel: 'save-settings', roles: ['chat'] },
        { name: 'onTick', domain: 'settings', kind: 'subscription', channel: 'tick', roles: ['chat'] },
        { name: 'orphanApi', domain: 'settings', kind: 'query', channel: 'orphan', roles: ['utility'] },
    ],
};
`);
    write('preloads/api/settings.js', "'use strict';\nmodule.exports = {};\n");
    write('main/handlers.js', `const { ipcMain } = require('electron');
const util = require('./util');
function handle(channel, fn) {
    ipcMain.handle(channel, fn);
}
function init(win) {
    handle('save-settings', () => util.ok());
    win.webContents.send('tick', 1);
}
module.exports = { init };
`);
    write('main/util.js', 'module.exports = { ok: () => 1 };\n');
    write('page/index.html', `<!doctype html>
<html><body>
<!-- <script src="legacy.js"></script> -->
<script src="boot.js"></script>
<script src="use.js"></script>
<script src="def.js"></script>
</body></html>
`);
    write('page/boot.js', 'const api = window.chatAPI || window.electronAPI;\n');
    write('page/use.js', "api.saveSettings({});\nchatAPI.onTick(() => {});\nwindow.Helper.run();\n");
    write('page/def.js', 'window.Helper = { run() {} };\n');

    forge.initialize({
        dbPath: path.join(tmp, 'db', 'pf.db'),
        services: { workspaceService: { list: () => [{ id: 'w', alias: 'repo', path: repo, enabled: true }], getActiveWorkspaceId: () => 'w' } },
        logger: { log() {}, warn() {}, error() {} },
    });
});

test.after(async () => {
    await forge.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------- 纯函数 ----------------

test('buildGraph：页面顺序告警、别名只在同页生效、param 不计入动态', () => {
    const decls = {
        status: 'ok', roleGlobals: { chat: 'chatAPI' },
        apis: [{ name: 'saveSettings', domain: 'd', kind: 'query', channel: 'save-settings', roles: ['chat'] }],
    };
    const facts = { scanned: 5, files: [
        { path: 'page/index.html', kind: 'html', scripts: [{ src: 'boot.js', line: 2 }, { src: 'use.js', line: 3 }, { src: 'def.js', line: 4 }] },
        { path: 'page/boot.js', kind: 'javascript', bridgeAliases: [{ name: 'api', object: 'chatAPI', line: 1, topLevel: true }] },
        { path: 'page/use.js', kind: 'javascript', bridge: [{ object: 'api', name: 'saveSettings', line: 1 }], globalsUsed: [{ object: 'window', name: 'Helper', line: 2 }] },
        { path: 'page/def.js', kind: 'javascript', globalsDefined: [{ name: 'Helper', how: 'window', line: 1 }] },
        { path: 'main/other.js', kind: 'javascript',
            bridge: [{ object: 'api', name: 'saveSettings', line: 9 }], // 不同页（主进程）→ 不采纳
            ipc: [
                { side: 'register', method: 'handle', channel: 'save-settings', via: 'wrapper', line: 3 },
                { side: 'register', method: 'handle', via: 'param', expr: 'ch → handle()', line: 1 },
                { side: 'push', method: 'send', via: 'dynamic', expr: 'ch', line: 5 },
            ] },
    ] };
    for (const rel of ['page/index.html', 'page/boot.js', 'page/use.js', 'page/def.js']) {
        fs.mkdirSync(path.join(tmp, 'pure', path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'pure', rel), '');
    }
    const g = LG.buildGraph(path.join(tmp, 'pure'), facts, decls);
    assert.equal(g.dynamic.length, 1, 'param 透传不计入动态，dynamic 计入');

    const ipc = LG.trace(g, 'api', 'saveSettings');
    assert.equal(ipc.details.channel, 'save-settings');
    assert.equal(ipc.details.handlers.length, 1);
    const callers = ipc.details.apis[0].callers;
    assert.deepEqual(callers.map(c => [c.path, c.alias, c.object]), [['page/use.js', 'api', 'chatAPI']]);

    const glob = LG.trace(g, 'global', 'window.Helper');
    assert.match(glob.text, /第 2 个）早于定义脚本（第 3 个）/);

    const page = LG.trace(g, 'page', 'index.html');
    assert.equal(page.details.page, 'page/index.html');
    assert.deepEqual(page.details.scripts.map(s => s.rel), ['page/boot.js', 'page/use.js', 'page/def.js']);

    assert.equal(LG.parseTarget('ipc: save-settings').value, 'save-settings');
    assert.equal(LG.parseTarget('nope:x'), null);
});

test('loadPreloadDecls：无声明表时 absent；子进程取数并缓存', async () => {
    assert.equal((await LG.loadPreloadDecls(tmp)).status, 'absent');
    const d = await LG.loadPreloadDecls(repo);
    assert.equal(d.status, 'ok', d.error);
    assert.equal(d.apis.length, 3);
    assert.deepEqual(LG.bridgeGlobalsOf(d), ['chatAPI', 'utilityAPI', 'electronAPI']);
    assert.ok(LG._test.declCache.has(repo));
});

// ---------------- 端到端 ----------------

test('Trace 端到端：wrapper handler、页面级别名、推送方、遗留声明、加载顺序', { skip: SKIP_BIN }, async () => {
    const r = await forge.processToolCall({ command: 'CreateProject', name: 'trace', dir: repo });
    const pid = r.details.project.id;
    const call = target => forge.processToolCall({ command: 'Trace', projectId: pid, target });

    const save = await call('api:saveSettings');
    assert.equal(save.details.channel, 'save-settings');
    assert.equal(save.details.handlers[0].via, 'wrapper');
    assert.equal(save.details.handlers[0].line, 7);
    assert.deepEqual(save.details.apis[0].callers.map(c => [c.path, c.line, c.alias]), [['page/use.js', 1, 'api']]);
    assert.match(textOf(save), /页面：page\/index\.html/);

    const tick = await call('ipc:tick');
    assert.equal(tick.details.pushes.length, 1);
    assert.equal(tick.details.apis[0].callers.length, 1);

    const orphan = await call('ipc:orphan');
    assert.match(textOf(orphan), /疑似遗留声明/);

    const helper = await call('global:Helper');
    assert.match(textOf(helper), /早于定义脚本/);

    const page = await call('page:page/index.html');
    assert.deepEqual(page.details.scripts.map(s => s.rel), ['page/boot.js', 'page/use.js', 'page/def.js'], '注释里的脚本不计入');

    const file = await call('file:main/handlers.js');
    assert.match(textOf(file), /→ `main\/util\.js`/);
    assert.match(textOf(file), /`save-settings` · ipcMain\.handle/);

    const miss = await call('ipc:save-setting');
    assert.equal(miss.details.found, false);
    assert.match(textOf(miss), /相近的：.*save-settings/);

    await assert.rejects(forge.processToolCall({ command: 'Trace', projectId: pid, target: 'bogus' }), /Trace 需要 target/);
});