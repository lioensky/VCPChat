'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { VTradeClient, readCredentials } = require('../modules/game/vtrade/client');
const { VTradeOrchestrator } = require('../modules/game/vtrade/orchestrator');

const temporary = t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vtrade-vgame-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
};
const account = async () => ({ origin: 'http://127.0.0.1:6005', username: 'admin', password: 'secret' });

test('凭据取自设置与论坛账号，缺少时给出可操作的提示', async t => {
    const root = temporary(t);
    fs.mkdirSync(path.join(root, 'AppData', 'UserData'), { recursive: true });
    assert.deepEqual(await readCredentials(root), { origin: '', username: '', password: '' });
    await assert.rejects(new VTradeClient({ credentials: () => readCredentials(root) }).duel('invites'), { code: 'NOT_CONFIGURED' });
    fs.writeFileSync(path.join(root, 'AppData', 'settings.json'), JSON.stringify({ vcpServerUrl: 'http://127.0.0.1:6005/v1/chat/completions' }));
    await assert.rejects(new VTradeClient({ credentials: () => readCredentials(root) }).duel('invites'), { code: 'NO_ADMIN_ACCOUNT' });
    fs.writeFileSync(path.join(root, 'AppData', 'UserData', 'forum.config.json'), JSON.stringify({ username: 'admin', password: 'secret' }));
    assert.deepEqual(await readCredentials(root), { origin: 'http://127.0.0.1:6005', username: 'admin', password: 'secret' });
});

test('页面接口带管理员认证与 VTrade 请求头，错误映射为明确代码', async () => {
    const calls = [];
    let status = 200, body = { ok: true, invites: [] };
    const client = new VTradeClient({ credentials: account, fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return { status, json: async () => body };
    } });
    assert.deepEqual((await client.duel('invites')).invites, []);
    assert.equal(calls[0].url, 'http://127.0.0.1:6005/admin_api/vtrade/api/duel');
    assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('admin:secret').toString('base64')}`);
    assert.equal(calls[0].init.headers['X-VTrade-Request'], '1');
    assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'invites' });
    status = 401; await assert.rejects(client.duel('invites'), { code: 'UNAUTHORIZED' });
    status = 404; await assert.rejects(client.duel('invites'), { code: 'PLUGIN_MISSING' });
    status = 400; body = { ok: false, code: 'STALE_DAY', error: '回合已变化' };
    await assert.rejects(client.duel('hold'), { code: 'STALE_DAY' });
    const page = await client.pageUrl();
    assert.equal(page.url, 'http://127.0.0.1:6005/admin_api/vtrade/duel/');
});

// A fake VTrade with one Agent seat waiting; decide() makes the seat stop waiting.
function fakeVTrade({ agent = 'Nova' } = {}) {
    const state = { day: 3, waiting: true, holds: [], turns: [] };
    const invite = () => ({ roundId: 'duel-0123456789abcdef', seatId: 'seat-2', agent, label: agent, mode: 'duel', day: state.day,
        lengthDays: 60, turnAt: '2026-10-27T00:00:00Z', ticket: 'duel-0123456789abcdef.seat-2.3.0123456789abcdef01234567' });
    return { state, decide() { state.waiting = false; }, client: {
        async duel(action, input) {
            if (action === 'invites') return { invites: state.waiting ? [invite()] : [] };
            if (action === 'turn') {
                state.turns.push(input);
                return { turn: { roundId: input.roundId, seatId: input.seatId, day: state.day, status: 'active', decided: !state.waiting,
                    ticket: invite().ticket, invitation: `【VTrade 对决邀请】${input.reminder ? '这是补邀' : ''}` } };
            }
            if (action === 'hold') { state.holds.push(input); state.waiting = false; return { round: {} }; }
            throw new Error(`unexpected ${action}`);
        },
    } };
}
function fakeGroups() {
    const groups = new Map();
    return { groups, async createAgentGroup(name, config) {
        const group = { id: `g${groups.size + 1}`, name, ...config, topics: [{ id: 't1' }] };
        groups.set(group.id, group);
        return { success: true, agentGroup: group };
    }, async getAgentGroupConfig(id) { return groups.get(id) || null; } };
}

test('编排器在后台游戏群里邀请对应 Agent，补邀两次后维持原仓位', async t => {
    const vtrade = fakeVTrade(), groupChat = fakeGroups(), runs = [];
    const orchestrator = new VTradeOrchestrator({ client: vtrade.client, groupChat, sessionsFile: path.join(temporary(t), 'sessions.json'),
        listAgents: async () => [{ id: 'nova_1', name: 'Nova' }], runAgent: async request => { runs.push(request); } });
    orchestrator.timer = 1;
    for (let i = 0; i < 4; i++) await orchestrator.tick();
    assert.equal(runs.length, 3);
    assert.deepEqual([...new Set(runs.map(r => `${r.groupId}/${r.topicId}/${r.agentId}`))], ['g1/t1/nova_1']);
    assert.match(runs[0].invitePrompt, /^\[系统邀请指令:\]\n【VTrade 对决邀请】$/);
    assert.match(runs[1].invitePrompt, /这是补邀/);
    assert.deepEqual(vtrade.state.turns.map(t => t.reminder), [false, true, true]);
    assert.equal(groupChat.groups.size, 1);
    const group = groupChat.groups.get('g1');
    assert.deepEqual([group.mode, group.members, group.modeSettings.game.gameTypeId], ['game', ['nova_1'], 'vtrade-duel']);
    assert.equal(vtrade.state.holds.length, 1);
    assert.match(vtrade.state.holds[0].reason, /3 次邀请后仍未提交/);
});

test('Agent 交了决定就不再补邀；同一局重启后复用后台群', async t => {
    const sessionsFile = path.join(temporary(t), 'sessions.json');
    const vtrade = fakeVTrade(), groupChat = fakeGroups();
    const make = () => new VTradeOrchestrator({ client: vtrade.client, groupChat, sessionsFile,
        listAgents: async () => [{ id: 'nova_1', name: 'Nova' }], runAgent: async () => vtrade.decide() });
    const first = make(); first.timer = 1;
    await first.tick(); await first.tick();
    assert.equal(vtrade.state.turns.length, 1);
    assert.equal(vtrade.state.holds.length, 0);
    vtrade.state.waiting = true; vtrade.state.day = 4;
    const second = make(); second.timer = 1;
    await second.tick();
    assert.equal(groupChat.groups.size, 1);
});

test('名单同步：Chat 中已配置模型的 Agent 连同小头像交给 VTrade，读不到头像的只给名称', async t => {
    const calls = [], read = [];
    const orchestrator = new VTradeOrchestrator({ client: { async duel(action, input) { calls.push({ action, input }); return { roster: { count: 2 } }; } },
        groupChat: fakeGroups(), sessionsFile: path.join(temporary(t), 'r.json'), runAgent: async () => {},
        listAgents: async () => [{ id: 'nova_1', name: 'Nova', avatarUrl: 'file:///agents/nova_1/avatar.png?v=1' }, { id: 'kerr_2', name: 'Kerr', avatarUrl: null }],
        readAvatar: url => { read.push(url); return url ? 'data:image/png;base64,AAAA' : null; } });
    await orchestrator.syncRoster();
    assert.deepEqual(read, ['file:///agents/nova_1/avatar.png?v=1', null]);
    assert.deepEqual(calls, [{ action: 'syncRoster', input: { agents: [{ name: 'Nova', avatar: 'data:image/png;base64,AAAA' }, { name: 'Kerr' }] } }]);
});

test('Agent 回答期间仍向 VTrade 取邀请，页面据此知道编排器在线', async t => {
    const vtrade = fakeVTrade(), actions = [];
    let release = null;
    const client = { async duel(action, input) { actions.push(action); return vtrade.client.duel(action, input); } };
    const orchestrator = new VTradeOrchestrator({ client, groupChat: fakeGroups(), sessionsFile: path.join(temporary(t), 'b.json'),
        listAgents: async () => [{ id: 'nova_1', name: 'Nova' }], runAgent: () => new Promise(resolve => { release = resolve; }) });
    orchestrator.timer = 1;
    const answering = orchestrator.tick();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const before = actions.filter(a => a === 'invites').length;
    await orchestrator.tick();
    await new Promise(resolve => setImmediate(resolve));
    await orchestrator.tick();
    assert.equal(actions.filter(a => a === 'invites').length, before + 2);
    vtrade.decide(); release();
    await answering;
    assert.equal(vtrade.state.turns.length, 1);
});

test('两位 Agent 同时出手，各在自己的后台群里；同一座位不会重复邀请', async t => {
    const seats = [['seat-1', 'Nova'], ['seat-2', 'Kerr']], waiting = new Set(seats.map(([id]) => id)), turns = [];
    const invite = ([seatId, agent]) => ({ roundId: 'duel-0123456789abcdef', seatId, agent, label: agent, mode: 'watch', day: 0,
        lengthDays: 60, turnAt: '2026-10-27T00:00:00Z', ticket: `duel-0123456789abcdef.${seatId}.0.0123456789abcdef01234567` });
    const client = { async duel(action, input) {
        if (action === 'invites') return { invites: seats.filter(([id]) => waiting.has(id)).map(invite) };
        if (action === 'turn') {
            turns.push(input.seatId);
            return { turn: { roundId: input.roundId, seatId: input.seatId, day: 0, status: 'active', decided: false, invitation: '邀请' } };
        }
        throw new Error(`unexpected ${action}`);
    } };
    const answering = [], groupChat = fakeGroups();
    const orchestrator = new VTradeOrchestrator({ client, groupChat, sessionsFile: path.join(temporary(t), 'p.json'),
        listAgents: async () => [{ id: 'nova_1', name: 'Nova' }, { id: 'kerr_2', name: 'Kerr' }],
        runAgent: request => new Promise(resolve => { answering.push({ request, resolve }); }) });
    orchestrator.timer = 1;
    const first = orchestrator.tick();
    while (answering.length < 2) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(answering.map(a => a.request.agentId).sort(), ['kerr_2', 'nova_1']);
    assert.equal(new Set(answering.map(a => a.request.groupId)).size, 2);
    await orchestrator.tick();
    assert.equal(turns.length, 2);
    for (const { request, resolve } of answering) { waiting.delete(request.agentId === 'nova_1' ? 'seat-1' : 'seat-2'); resolve(); }
    await first;
    const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(orchestrator.sessionsFile), 'p.json'), 'utf8'));
    assert.equal(Object.keys(saved).length, 2);
});

test('Chat 启动时有 Agent 座位在等才开始轮询；没有或连不上就只问一次', async t => {
    const make = duel => new VTradeOrchestrator({ client: { duel }, groupChat: fakeGroups(), sessionsFile: path.join(temporary(t), 'r.json'),
        listAgents: async () => [], runAgent: async () => {} });
    let calls = 0;
    const idle = make(async () => { calls++; return { invites: [] }; });
    await idle.resumeIfWaiting();
    assert.deepEqual([calls, idle.timer], [1, null]);
    const missing = make(async () => { throw Object.assign(new Error('没有插件'), { code: 'PLUGIN_MISSING' }); });
    await missing.resumeIfWaiting();
    assert.equal(missing.timer, null);
    const vtrade = fakeVTrade(), waiting = make(vtrade.client.duel.bind(vtrade.client));
    waiting.start = function start(options) { this.started = options; };
    await waiting.resumeIfWaiting({ windowOpen: () => false });
    assert.ok(waiting.started);
});

test('VCPChat 中没有这位 Agent 时维持原仓位；插件缺失时停止轮询', async t => {
    const vtrade = fakeVTrade({ agent: 'Ghost' }), runs = [];
    const orchestrator = new VTradeOrchestrator({ client: vtrade.client, groupChat: fakeGroups(), sessionsFile: path.join(temporary(t), 's.json'),
        listAgents: async () => [{ id: 'nova_1', name: 'Nova' }], runAgent: async request => runs.push(request) });
    orchestrator.timer = 1;
    await orchestrator.tick();
    assert.equal(runs.length, 0);
    assert.match(vtrade.state.holds[0].reason, /没有名为 Ghost 的 Agent/);
    const missing = new VTradeOrchestrator({ client: { async duel() { throw Object.assign(new Error('没有插件'), { code: 'PLUGIN_MISSING' }); } },
        groupChat: fakeGroups(), sessionsFile: path.join(temporary(t), 'm.json'), listAgents: async () => [], runAgent: async () => {} });
    missing.start();
    await new Promise(resolve => setImmediate(resolve));
    await missing.tick();
    assert.equal(missing.timer, null);
    assert.equal(missing.status.state, 'stopped');
});

test('大厅打开 VTrade 对决窗口：独立会话、只对 VTrade 页面加认证、导航不出 VTrade', async () => {
    const windows = [], filters = [];
    class Window extends EventEmitter {
        constructor(options) {
            super();
            this.options = options; this.webContents = new EventEmitter();
            this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
            windows.push(this);
        }
        isDestroyed() { return Boolean(this.destroyed); }
        isMinimized() { return false; }
        setMenu() {} show() {} focus() {}
        async loadURL(url) { this.url = url; }
        destroy() { this.destroyed = true; this.emit('closed'); }
    }
    const session = { fromPartition: name => ({ webRequest: { onBeforeSendHeaders(filter, listener) { filters.push({ name, filter, listener }); } } }) };
    const original = Module._load;
    Module._load = function(request, parent, isMain) {
        if (request === 'electron') return { BrowserWindow: Window, session, ipcMain: { handle() {} } };
        return original.call(this, request, parent, isMain);
    };
    let win;
    try {
        delete require.cache[require.resolve('../modules/game/vtrade/window')];
        win = require('../modules/game/vtrade/window');
    } finally { Module._load = original; }
    const client = new VTradeClient({ credentials: account });
    await win.open(client);
    await win.open(client);
    assert.equal(windows.length, 1);
    const [opened] = windows;
    assert.equal(opened.url, 'http://127.0.0.1:6005/admin_api/vtrade/duel/');
    assert.deepEqual([opened.options.webPreferences.partition, opened.options.webPreferences.sandbox, opened.options.webPreferences.nodeIntegration,
        opened.options.webPreferences.preload], ['persist:vcp-vtrade', true, false, undefined]);
    assert.deepEqual(filters[0].filter.urls, ['http://127.0.0.1:6005/admin_api/vtrade/*']);
    let sent;
    filters[0].listener({ requestHeaders: { Accept: '*/*' } }, result => { sent = result.requestHeaders; });
    assert.equal(sent.Authorization, `Basic ${Buffer.from('admin:secret').toString('base64')}`);
    assert.deepEqual(opened.openHandler(), { action: 'deny' });
    const navigate = target => { let blocked = false; opened.webContents.emit('will-navigate', { preventDefault: () => { blocked = true; } }, target); return blocked; };
    assert.equal(navigate('http://127.0.0.1:6005/admin_api/vtrade/workspace/'), false);
    assert.equal(navigate('http://127.0.0.1:6005/admin_api/plugins'), true);
    assert.equal(navigate('https://example.com/admin_api/vtrade/duel/'), true);
    assert.equal(win.isOpen(), true);
    opened.destroy();
    assert.equal(win.isOpen(), false);
});

test('大厅有 VTrade 对决卡片，启动入口交给 VTrade 窗口', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'Gamemodules', 'game.html'), 'utf8');
    assert.match(html, /data-game="vtrade"/);
    const source = fs.readFileSync(path.join(__dirname, '..', 'modules', 'ipc', 'gameHandlers.js'), 'utf8');
    assert.match(source, /gameId === 'vtrade'/);
    assert.ok(pathToFileURL(path.join(__dirname, '..', 'modules', 'game', 'vtrade', 'window.js')));
});
