'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const { GameService } = require('../modules/services/gameService');
const { GameRuntime, clampGameAgentConfig, GAME_TURN_MAX_OUTPUT_TOKENS } = require('../modules/game/gameRuntime');
const { classify, beats } = require('../modules/game/doudizhu/cards');
const controller = require('../VCPDistributedServer/Plugin/GameController/GameControllerService');

const decode = result => JSON.parse(result.content[0].text);

test('三AI斗蛐蛐全自动对局：0/1/2全座位工具署名落子、单座位模型覆盖及续局继承', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vgame-spectator-'));
    t.after(async () => {
        controller.cleanup();
        await fs.rm(root, { recursive: true, force: true });
    });
    const service = new GameService({ appDataRoot: root, integer: () => 0 });
    await service.initialize();
    controller.initialize({ services: { gameService: service } });

    const defaultProfiles = {
        alpha: { id: 'alpha', name: 'Alpha', model: 'model-alpha-default' },
        beta: { id: 'beta', name: 'beta', model: 'model-beta-default' },
        gamma: { id: 'gamma', name: 'Gamma', model: 'model-gamma-default' },
    };
    const history = [];
    const seenDecisions = [];
    let group;

    const runtime = new GameRuntime({
        gameService: service,
        groupChat: {
            createAgentGroup: async (_name, config) => {
                group = { ...config, id: 'g-spec', topics: [{ id: 't-spec' }] };
                return { success: true, agentGroup: group };
            },
            getAgentGroupConfig: async () => group,
            appendGroupHistoryMessage: async (_g, _t, message) => {
                if (!history.some(entry => entry.id === message.id)) history.push(message);
            },
        },
        loadAgent: async id => structuredClone(defaultProfiles[id]),
        toolInstructions: async () => '',
        runAgent: async decision => {
            seenDecisions.push({
                seat: decision.seat,
                agentId: decision.agentId,
                model: decision.model || defaultProfiles[decision.agentId].model,
                explicitOverride: decision.model || null,
            });
            const obs = decision.observation;
            const signature = defaultProfiles[decision.agentId].name;
            if (obs.phase === 'bidding') {
                const res = decode(await controller.processToolCall({
                    maid: signature,
                    command: 'SubmitAction',
                    matchId: decision.matchId,
                    decisionId: obs.decisionId,
                    revision: String(obs.revision),
                    submissionId: `bid-${obs.revision}`,
                    action: 'bid',
                    bid: obs.seat === 0 ? '3' : '0',
                    speech: obs.seat === 0 ? '地主归我！' : '',
                }));
                assert.equal(res.accepted, true);
                return;
            }
            const playable = obs.hand.find(card => beats(classify([card]), obs.target?.combination));
            const res = decode(await controller.processToolCall({
                maid: signature,
                command: 'SubmitAction',
                matchId: decision.matchId,
                decisionId: obs.decisionId,
                revision: obs.revision,
                submissionId: `move-${obs.revision}`,
                action: playable ? 'play' : 'pass',
                ...(playable ? { cards: JSON.stringify([playable]) } : {}),
            }));
            assert.equal(res.accepted, true);
        },
    });

    const table = await runtime.openTable({
        mode: 'spectate',
        agentIds: ['alpha', 'beta', 'gamma'],
        agentModels: ['model-favorite', '', 'model-override'],
    });

    await assert.rejects(
        runtime.submitHuman(table.matchId, { submissionId: 'illegal', decisionId: `${table.matchId}:0`, revision: 0, action: { type: 'bid', bid: 1 } }),
        { code: 'SPECTATOR_MODE' },
    );

    const finalState = await runtime.continue(table.matchId);
    assert.equal(finalState.status, 'finished');
    const saved = await service.read(table.matchId);
    assert.equal(saved.state.phase, 'finished');
    assert.ok(['landlord', 'farmers'].includes(saved.state.winner));

    // Seat 0 (Alpha) and Seat 2 (Gamma) used overridden models; Seat 1 (beta) kept default model.
    const bySeat = new Map();
    for (const d of seenDecisions) {
        if (!bySeat.has(d.seat)) bySeat.set(d.seat, d);
    }
    assert.equal(bySeat.get(0).explicitOverride, 'model-favorite');
    assert.equal(bySeat.get(1).explicitOverride, null);
    assert.equal(bySeat.get(1).model, 'model-beta-default');
    assert.equal(bySeat.get(2).explicitOverride, 'model-override');
    assert.equal(defaultProfiles.alpha.model, 'model-alpha-default');

    // Next match preserves all 3 AI seats and their model overrides when no new models are passed.
    const next = await runtime.nextTable(table.matchId);
    const nextRecord = await service.read(next.matchId);
    assert.deepEqual(
        nextRecord.seats.map(s => ({ id: s.agentId, model: s.model || null, effective: s.effectiveModel })),
        [
            { id: 'alpha', model: 'model-favorite', effective: 'model-favorite' },
            { id: 'beta', model: null, effective: 'model-beta-default' },
            { id: 'gamma', model: 'model-override', effective: 'model-override' },
        ],
    );

    // Mid-match live model switch updates seat models immediately, and nextTable applies newly chosen models.
    await runtime.updateSeatModels(next.matchId, {
        agentIds: ['alpha', 'beta', 'gamma'],
        agentModels: ['', 'model-hot', 'model-switched'],
    });
    const updatedMidGame = await service.read(next.matchId);
    assert.deepEqual(
        updatedMidGame.seats.map(s => ({ id: s.agentId, model: s.model || null, effective: s.effectiveModel })),
        [
            { id: 'alpha', model: null, effective: 'model-alpha-default' },
            { id: 'beta', model: 'model-hot', effective: 'model-hot' },
            { id: 'gamma', model: 'model-switched', effective: 'model-switched' },
        ],
    );

    await assert.rejects(
        runtime.updateSeatModels(next.matchId, {
            agentIds: ['alpha', 'gamma', 'beta'],
            agentModels: ['', '', ''],
        }),
        { code: 'SEAT_ROSTER_CHANGED' },
    );

    await runtime.continue(next.matchId);
    const third = await runtime.nextTable(next.matchId, {
        agentIds: ['alpha', 'beta', 'gamma'],
        agentModels: ['model-favorite', '', 'model-switched'],
    });
    const thirdRecord = await service.read(third.matchId);
    assert.deepEqual(
        thirdRecord.seats.map(s => ({ id: s.agentId, model: s.model || null, effective: s.effectiveModel })),
        [
            { id: 'alpha', model: 'model-favorite', effective: 'model-favorite' },
            { id: 'beta', model: null, effective: 'model-beta-default' },
            { id: 'gamma', model: 'model-switched', effective: 'model-switched' },
        ],
    );
});

test('三AI连续三次全员不叫时自动由当前首叫1分兜底当庄，避免死循环烧Token', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vgame-redeal-cap-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const service = new GameService({ appDataRoot: root, integer: () => 0 });
    const { matchId } = await service.createMatch({
        groupId: 'g', topicId: 't',
        seats: [
            { kind: 'agent', agentId: 'a', name: 'A' },
            { kind: 'agent', agentId: 'b', name: 'B' },
            { kind: 'agent', agentId: 'c', name: 'C' },
        ],
    });
    // Deal 1 (seats 0,1,2 pass) -> redeal #2; Deal 2 (seats 1,2,0 pass) -> redeal #3; Deal 3 (seats 2,0,1 pass) -> forced landlord!
    for (let step = 0; step < 9; step++) {
        const obs = await service.getObservation(matchId, (await service.read(matchId)).state.turn);
        await service.submit(matchId, obs.seat, {
            submissionId: `pass-bid-${step}`,
            decisionId: obs.decisionId,
            revision: obs.revision,
            action: { type: 'bid', bid: 0 },
        });
    }
    const after = await service.read(matchId);
    assert.equal(after.state.phase, 'playing');
    assert.equal(after.state.dealNumber, 3);
    assert.equal(after.state.highestBid, 1);
    assert.equal(after.state.landlord, 2);
});

test('斗地主前端UI：默认三AI观战、独立选模型与自定义输入、上帝明牌开关及切换亲自上桌', async () => {
    const projectRoot = path.resolve(__dirname, '..');
    const html = await fs.readFile(path.join(projectRoot, 'Gamemodules/doudizhu/index.html'), 'utf8');
    const script = await fs.readFile(path.join(projectRoot, 'Gamemodules/doudizhu/ui.js'), 'utf8');
    const dom = new JSDOM(html, { url: pathToFileURL(path.join(projectRoot, 'Gamemodules/doudizhu/index.html')).href, runScripts: 'outside-only' });
    const w = dom.window;

    const createPayloads = [];
    let mockAutoPass = true;
    let settingsFailure = false;
    const settingsUpdates = [];
    const observeUpdates = [];
    const nextPayloads = [];
    let mockSeats = [
        { kind: 'agent', agentId: 'alpha', name: 'Alpha', model: 'model-favorite', effectiveModel: 'model-favorite' },
        { kind: 'agent', agentId: 'beta', name: 'beta', effectiveModel: 'model-beta-default' },
        { kind: 'agent', agentId: 'gamma', name: 'Gamma', model: 'my-custom-llm', effectiveModel: 'my-custom-llm' },
    ];
    let mockPhase = 'bidding';
    let mockRunning = true;
    w.utilityAPI = {
        listGameAgents: async () => ({
            success: true,
            agents: [
                { id: 'alpha', name: 'Alpha', model: 'model-alpha-default' },
                { id: 'beta', name: 'beta', model: 'model-beta-default' },
                { id: 'gamma', name: 'Gamma', model: 'model-gamma-default' },
                { id: 'delta', name: 'Delta', model: 'model-delta-default' },
            ],
            favoriteModels: ['model-favorite'],
            hotModels: ['model-hot'],
            models: ['model-favorite', 'model-hot', 'model-switched', 'model-alpha-default'],
        }),
        updateGameSettings: async payload => {
            settingsUpdates.push(payload);
            if (settingsFailure) return {success:false,error:'settings offline'};
            mockAutoPass = payload.autoPass;
            return {success:true,autoPass:mockAutoPass};
        },
        createGameTable: async payload => {
            createPayloads.push(payload);
            return { success: true, matchId: 'match-11111111-1111-1111-1111-111111111111' };
        },
        nextGameTable: async payload => {
            nextPayloads.push(payload);
            return { success: true, matchId: 'match-22222222-2222-2222-2222-222222222222' };
        },
        observeGameTable: async payload => {
            if (Array.isArray(payload?.agentModels)) {
                observeUpdates.push(payload);
                mockSeats = mockSeats.map((seat, idx) => ({
                    ...seat,
                    model: payload.agentModels[idx] || undefined,
                    effectiveModel: payload.agentModels[idx] || 'model-default',
                }));
            }
            return {
                success: true,
                isSpectator: true,
                seats: mockSeats,
                spectator: {
                    hands: [['RJ', 'BJ'], ['HA'], ['S3']],
                    bottom: ['SA', 'HK', 'DQ'],
                },
                observation: {
                    matchId: payload.matchId,
                    decisionId: `${payload.matchId}:0`,
                    revision: 0,
                    phase: mockPhase,
                    autoPass: mockAutoPass,
                    turn: 0,
                    dealNumber: 1,
                    highestBid: 0,
                    landlord: 0,
                    bottom: [],
                    remaining: [2, 1, 1],
                    target: null,
                    winner: mockPhase === 'finished' ? 'landlord' : null,
                    hand: ['RJ', 'BJ'],
                    canPass: false,
                    events: [],
                },
                runtime: { running: mockRunning, status: mockRunning ? 'requesting' : 'finished', reason: null, seat: mockRunning ? 0 : null },
            };
        },
    };

    try {
        w.eval(script);
        await new Promise(resolve => setTimeout(resolve, 20));

        // Select the first three agents in catalog order, independent of names.
        assert.equal(w.document.getElementById('agent-zero').value, 'alpha');
        assert.equal(w.document.getElementById('agent-one').value, 'beta');
        assert.equal(w.document.getElementById('agent-two').value, 'gamma');
        assert.equal(w.document.getElementById('human-zone').hidden, true);

        // Human mode remains available and does not use the spectator-only seat.
        w.document.getElementById('mode-human').click();
        assert.equal(w.document.getElementById('slot-zero-card').hidden, true);
        assert.equal(w.document.getElementById('human-name-wrap').hidden, false);
        assert.equal(w.document.getElementById('human-zone').hidden, false);
        w.document.getElementById('mode-spectate').click();
        assert.equal(w.document.getElementById('slot-zero-card').hidden, false);
        assert.equal(w.document.getElementById('human-zone').hidden, true);

        // Configure seat 0 = favorite model, seat 1 = default, seat 2 = custom model
        const m0 = w.document.getElementById('model-zero');
        m0.value = 'model-favorite';
        m0.dispatchEvent(new w.Event('change'));

        const m2 = w.document.getElementById('model-two');
        m2.value = '__custom__';
        m2.dispatchEvent(new w.Event('change'));
        assert.equal(w.document.getElementById('custom-model-two').hidden, false);
        w.document.getElementById('custom-model-two').value = 'my-custom-llm';

        w.document.getElementById('create').click();
        await new Promise(resolve => setTimeout(resolve, 20));

        assert.equal(createPayloads.length, 1);
        const autoPassSwitch = w.document.getElementById('auto-pass');
        assert.equal(autoPassSwitch.checked, true);
        autoPassSwitch.checked = false;
        autoPassSwitch.dispatchEvent(new w.Event('change'));
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(settingsUpdates.length, 1);
        assert.equal(settingsUpdates[0].autoPass, false);
        assert.equal(autoPassSwitch.checked, false);
        assert.equal(autoPassSwitch.disabled, false);
        settingsFailure = true;
        autoPassSwitch.checked = true;
        autoPassSwitch.dispatchEvent(new w.Event('change'));
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(autoPassSwitch.checked, false);
        assert.equal(autoPassSwitch.disabled, false);
        settingsFailure = false;
        assert.deepEqual(JSON.parse(JSON.stringify(createPayloads[0])), {
            mode: 'spectate',
            autoPass: true,
            agentIds: ['alpha', 'beta', 'gamma'],
            agentModels: ['model-favorite', '', 'my-custom-llm'],
            userName: '莱恩',
            contextMessageWindowSize: 100,
        });

        // God-view hands & model chips rendered
        assert.match(w.document.getElementById('seats').textContent, /model-favorite/);
        assert.match(w.document.getElementById('seats').textContent, /大王/);
        assert.match(w.document.getElementById('bottom').textContent, /上帝透视/);

        // Toggle God-view off hides private cards
        w.document.getElementById('toggle-reveal').click();
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.match(w.document.getElementById('seats').textContent, /暗牌盲猜中/);
        assert.doesNotMatch(w.document.getElementById('seats').textContent, /大王/);

        // Changing seat 2 model dropdown mid-game immediately pushes update & repaints seat chip
        m2.value = 'model-switched';
        m2.dispatchEvent(new w.Event('change'));
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(observeUpdates.length, 1);
        assert.deepEqual(JSON.parse(JSON.stringify(observeUpdates[0])), {
            matchId: 'match-11111111-1111-1111-1111-111111111111',
            agentIds: ['alpha', 'beta', 'gamma'],
            agentModels: ['model-favorite', '', 'model-switched'],
        });
        assert.match(w.document.getElementById('seats').textContent, /model-switched/);

        // Resume restores dropdown controls from saved table seats
        m0.value = '';
        w.document.getElementById('resume').click();
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(m0.value, 'model-favorite');
        assert.equal(m2.value, 'model-switched');

        // When match finishes, clicking 「再来一局（保留上下文）」 passes the updated seat models
        mockPhase = 'finished';
        mockRunning = false;
        m0.value = 'model-hot';
        m0.dispatchEvent(new w.Event('change'));
        await new Promise(resolve => setTimeout(resolve, 20));
        w.document.getElementById('next').click();
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(nextPayloads.length, 1);
        assert.deepEqual(JSON.parse(JSON.stringify(nextPayloads[0])), {
            matchId: 'match-11111111-1111-1111-1111-111111111111',
            agentIds: ['alpha', 'beta', 'gamma'],
            agentModels: ['model-hot', '', 'model-switched'],
        });
    } finally {
        w.dispatchEvent(new w.Event('pagehide'));
        w.close();
    }
});
test('clampGameAgentConfig：单座换用中小窗口模型时自动钳制超高 maxOutputTokens，避免上游 0 字空流拒绝', () => {
    const largeProfile = {
        id: 'agent-large',
        name: 'Gamma',
        model: 'model-gamma-default',
        maxOutputTokens: 600000,
    };
    const clamped = clampGameAgentConfig(largeProfile, 'model-small');
    assert.equal(clamped.model, 'model-small');
    assert.equal(clamped.maxOutputTokens, GAME_TURN_MAX_OUTPUT_TOKENS);
    assert.equal(largeProfile.maxOutputTokens, 600000);

    const smallProfile = { id: 'mini', name: 'Mini', model: 'model-default', maxOutputTokens: 4096 };
    assert.equal(clampGameAgentConfig(smallProfile, '').maxOutputTokens, 4096);
    assert.equal(clampGameAgentConfig(smallProfile, '').model, 'model-default');
});

test('preload game API：listGameAgents 兼容无参调用与 refreshModels 参数透传', async () => {
    const { loadRegistry } = require('../preloads/core/registry');
    const entry = loadRegistry().get('listGameAgents')?.entry;
    assert.ok(entry);
    const calls = [];
    const fn = entry.build({
        ipcRenderer: {
            invoke: async (channel, ...args) => {
                calls.push([channel, ...args]);
                return { success: true };
            },
        },
    });
    await fn();
    await fn({ refreshModels: true });
    assert.deepEqual(calls, [
        ['vcp-game:agents'],
        ['vcp-game:agents', { refreshModels: true }],
    ]);
});

test('斗地主请求独立覆盖模型和输出预算，VTrade 及其他角色保留原配置', async () => {
    const vm = require('node:vm');
    const source = await fs.readFile(path.join(__dirname, '../modules/ipc/gameHandlers.js'), 'utf8');
    let doudizhuOptions, vtradeOptions;
    const profiles = {
        alpha: { id: 'alpha', model: 'default-large', maxOutputTokens: 600000 },
        beta: { id: 'beta', model: 'default-small', maxOutputTokens: 4096 },
    };
    const requests = [];
    const dependencies = {
        electron: { BrowserWindow: class {}, ipcMain: {} },
        '../game/gameRuntime': {
            GameRuntime: class { constructor(options) { doudizhuOptions = options; } },
            clampGameAgentConfig,
            GAME_TURN_MAX_OUTPUT_TOKENS,
        },
        '../game/vtrade/client': { VTradeClient: class {} },
        '../game/vtrade/window': {},
        '../game/vtrade/orchestrator': {
            VTradeOrchestrator: class { constructor(options) { vtradeOptions = options; } },
        },
    };
    const sandbox = {
        module: { exports: {} },
        __dirname: path.join(__dirname, '../modules/ipc'),
        require: id => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id),
        setTimeout: () => ({ unref() {} }),
    };
    vm.runInNewContext(source, sandbox);
    sandbox.module.exports.configureRuntime({
        gameService: {},
        listAgents: async () => [],
        loadAgent: async id => profiles[id],
        groupChat: {
            handleInviteAgentToSpeak: async (_groupId, _topicId, agentId, _send, loader) => {
                requests.push({ current: await loader(agentId), other: await loader('beta') });
            },
        },
    });

    await doudizhuOptions.runAgent({
        groupId: 'game-group', topicId: 'game-topic', agentId: 'alpha',
        model: 'seat-override', invitePrompt: 'game invitation',
    });
    assert.equal(requests[0].current.model, 'seat-override');
    assert.equal(requests[0].current.maxOutputTokens, GAME_TURN_MAX_OUTPUT_TOKENS);
    assert.equal(requests[0].other, profiles.beta);
    assert.equal(profiles.alpha.model, 'default-large');
    assert.equal(profiles.alpha.maxOutputTokens, 600000);

    await vtradeOptions.runAgent({
        groupId: 'trade-group', topicId: 'trade-topic', agentId: 'alpha',
        invitePrompt: 'trade invitation',
    });
    assert.equal(requests[1].current, profiles.alpha);
    assert.equal(requests[1].current.maxOutputTokens, 600000);
    assert.equal(requests[1].other, profiles.beta);
});
