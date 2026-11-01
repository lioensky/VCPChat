'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

let modulesPromise = null;
function loadCoreModules() {
    if (!modulesPromise) {
        const srcDir = path.join(__dirname, 'src');
        const imp = name => import(pathToFileURL(path.join(srcDir, name)).href);
        modulesPromise = Promise.all([
            imp('defaults.js'),
            imp('engine.js'),
            imp('manual.js'),
            imp('history.js'),
            imp('context.js'),
            imp('narrator.js'),
            imp('commands.js'),
            imp('designer.js'),
            imp('profiles.js'),
        ]).then(([defaults, engine, manual, history, context, narrator, commands, designer, profiles]) => ({
            defaults, engine, manual, history, context, narrator, commands, designer, profiles,
        }));
    }
    return modulesPromise;
}

function stepsOf(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须为对象');
    const numbered = Object.keys(args)
        .filter(k => /^command[1-9]\d*$/.test(k))
        .map(k => Number(k.slice(7)))
        .sort((a, b) => a - b);
    if (!numbered.length) return [{ ...args }];
    if (args.command) throw new Error('不能混用command与commandN');
    if (numbered.length > 32 || numbered.some((n, i) => n !== i + 1)) {
        throw new Error('串指令须从1连续编号，最多32步');
    }
    const keys = [
        'command', 'mapId', 'mapName', 'profileId', 'unit', 'target', 'skill',
        'x', 'y', 'tx', 'ty', 'reaction', 'type', 'key', 'value', 'defId',
        'terrainId', 'checkpointId', 'commandsText', 'designJson', 'note',
        'revision', 'overwrite', 'damage', 'hp',
    ];
    return numbered.map(n => {
        const step = {};
        for (const k of keys) {
            if (args[k + n] !== undefined) step[k] = args[k + n];
            else if (k !== 'command' && args[k] !== undefined) step[k] = args[k];
        }
        if (n > 1 && args['revision' + n] === undefined) delete step.revision;
        return step;
    });
}

/** 转为 0-based 整数坐标（用户输入 1-based 棋盘坐标，或显式传 zeroBased=true） */
function toCoord(v, label = '坐标', zeroBased = false) {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`${label}必须为整数`);
    return zeroBased ? n : n - 1;
}

class SessionStore {
    constructor(directory) {
        this.directory = directory;
        this.queues = new Map();
        this.listeners = new Set();
    }

    subscribe(callback) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    file(boardId = 'shared') {
        const safe = String(boardId || 'shared').trim() || 'shared';
        return path.join(this.directory, crypto.createHash('sha256').update(safe).digest('hex') + '.json');
    }

    async createDefaultSession() {
        const { defaults, engine, history } = await loadCoreModules();
        const settings = defaults.defaultSettings();
        const profile = settings.profiles[0];
        const map = profile.maps[0];
        const battle = engine.createBattle(map, profile.units, profile.terrains, profile.unitTypes);
        battle.profileId = profile.id;
        battle.profileName = profile.name;
        battle.rev = 1;
        history.recordCheckpoint(battle, { chat: 0, kind: 'start' });
        return {
            boardId: 'shared',
            revision: 1,
            updatedAt: Date.now(),
            settings,
            battle,
        };
    }

    async load(boardId = 'shared') {
        const { defaults, engine } = await loadCoreModules();
        try {
            const raw = JSON.parse(await fs.readFile(this.file(boardId), 'utf8'));
            if (!raw || typeof raw !== 'object') throw new Error('戦棋存档格式无效');
            if (!raw.settings) raw.settings = defaults.defaultSettings();
            if (!Array.isArray(raw.settings.profiles) || !raw.settings.profiles.length) {
                raw.settings.profiles = defaults.defaultSettings().profiles;
            }
            // 确保内置的凯伊线资料卡存在
            if (!raw.settings.profiles.some(p => p.id === defaults.FE_KAI_PROFILE_ID)) {
                raw.settings.profiles.unshift(defaults.feKaiProfile());
            }
            raw.settings.bindings ||= {};
            raw.settings.bindings['char:fe_kai_sandbox.png'] ||= raw.settings.activeProfile || defaults.FE_KAI_PROFILE_ID;
            raw.revision = Number(raw.revision) || 1;
            if (!raw.battle && raw.settings.profiles[0]?.maps?.[0]) {
                const p = raw.settings.profiles.find(x => x.id === raw.settings.activeProfile) || raw.settings.profiles[0];
                const m = p.maps[0];
                if (m) {
                    raw.battle = engine.createBattle(m, p.units, p.terrains, p.unitTypes);
                    raw.battle.profileId = p.id;
                    raw.battle.profileName = p.name;
                }
            }
            return raw;
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
    }

    async save(boardId, session) {
        await fs.mkdir(this.directory, { recursive: true });
        session.updatedAt = Date.now();
        session.revision = (Number(session.revision) || 0) + 1;
        if (session.battle) session.battle.rev = session.revision;
        const file = this.file(boardId);
        const temp = `${file}.${crypto.randomUUID()}.tmp`;
        try {
            await fs.writeFile(temp, JSON.stringify(session), { encoding: 'utf8', flag: 'wx' });
            await fs.rename(temp, file);
        } finally {
            await fs.unlink(temp).catch(() => {});
        }
    }

    async syncFromUi(boardId = 'shared', payload = {}) {
        const prior = this.queues.get(boardId) || Promise.resolve();
        const next = prior.catch(() => {}).then(async () => {
            let session = (await this.load(boardId)) || (await this.createDefaultSession());
            if (payload.settings && typeof payload.settings === 'object') {
                session.settings = payload.settings;
                session.settings.bindings ||= {};
                session.settings.bindings['char:fe_kai_sandbox.png'] = session.settings.activeProfile || 'profile_fe_kai';
            }
            if ('battle' in payload) {
                session.battle = payload.battle;
            }
            await this.save(boardId, session);
            const summary = await this.buildSummary(session);
            const output = { ok: true, source: 'ui', state: summary };
            for (const listener of this.listeners) {
                try { listener(boardId, output); } catch { /* ignore listener error */ }
            }
            return output;
        });
        this.queues.set(boardId, next);
        void next.finally(() => {
            if (this.queues.get(boardId) === next) this.queues.delete(boardId);
        }).catch(() => {});
        return next;
    }

    execute(boardId = 'shared', args = {}) {
        const prior = this.queues.get(boardId) || Promise.resolve();
        const next = prior.catch(() => {}).then(() => this.executeSerial(boardId, args));
        this.queues.set(boardId, next);
        void next.finally(() => {
            if (this.queues.get(boardId) === next) this.queues.delete(boardId);
        }).catch(() => {});
        return next;
    }

    async buildSummary(session) {
        const { context, narrator, history } = await loadCoreModules();
        const profile = session.settings.profiles.find(p => p.id === session.settings.activeProfile) || session.settings.profiles[0];
        const b = session.battle;
        const battleText = b ? context.buildBattleContext(b, {
            map: true, legend: true, stats: true, skills: true, nearest: true, logLines: 12, rules: profile?.rules,
        }) : '当前尚无进行中的战棋对局。';
        const pendingText = b?.pending?.length
            ? narrator.composeMessage(b, b.pending, session.settings, '', { force: () => true })
            : '';
        const checkpoints = (b?.history || []).map(cp => ({
            id: cp.id,
            turn: cp.turn,
            kind: cp.kind,
            title: history.checkpointTitle(cp),
            player: cp.player,
            enemy: cp.enemy,
        }));
        return {
            revision: session.revision,
            updatedAt: session.updatedAt,
            activeProfile: session.settings.activeProfile,
            profileName: profile?.name || '',
            settings: session.settings,
            battle: session.battle,
            battleText,
            pendingText,
            checkpoints,
        };
    }

    async executeSerial(boardId, args) {
        const mods = await loadCoreModules();
        const { engine, manual, history, commands, designer, narrator } = mods;
        const steps = stepsOf(args);
        const results = [], events = [];
        let session = await this.load(boardId);
        if (!session) {
            session = await this.createDefaultSession();
            await this.save(boardId, session);
        }
        let failedStep = null;

        const activeProfile = () =>
            session.settings.profiles.find(p => p.id === session.settings.activeProfile) || session.settings.profiles[0];

        const resolveUnit = (b, ref) => {
            if (!b) throw new Error('当前没有进行中的战斗');
            const u = commands.findUnit(b, String(ref || '').trim());
            if (!u) throw new Error(`找不到单位：${ref}`);
            return u;
        };

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const cmd = step.command || 'GetState';
            let stepResult;
            try {
                if (step.revision !== undefined && Number(step.revision) !== session.revision) {
                    throw new Error(`棋盘状态已更新（当前 revision=${session.revision}），请先 GetState 获取最新状态`);
                }
                const profile = activeProfile();
                const rules = profile.rules;

                switch (cmd) {
                    case 'GetState': {
                        stepResult = { ok: true, message: '已读取当前战棋沙盘状态', events: [] };
                        break;
                    }
                    case 'StartBattle': {
                        if (session.battle && step.overwrite !== true && step.overwrite !== 'true' && !step.mapId && !step.mapName) {
                            stepResult = { ok: true, resumed: true, message: '已恢复现有战棋对局', events: [] };
                            break;
                        }
                        if (step.profileId) {
                            const targetProfile = session.settings.profiles.find(p => p.id === step.profileId || p.name === step.profileId);
                            if (!targetProfile) throw new Error(`找不到资料卡：${step.profileId}`);
                            session.settings.activeProfile = targetProfile.id;
                            session.settings.bindings['char:fe_kai_sandbox.png'] = targetProfile.id;
                        }
                        const p = activeProfile();
                        let map = p.maps[0];
                        if (step.mapId || step.mapName) {
                            const q = String(step.mapId || step.mapName).trim();
                            map = p.maps.find(m => m.id === q || m.name === q || m.name.includes(q));
                            if (!map) throw new Error(`找不到地图：${q}`);
                        }
                        if (!map) throw new Error('当前资料卡没有可用地图');
                        const b = engine.createBattle(map, p.units, p.terrains, p.unitTypes);
                        b.profileId = p.id;
                        b.profileName = p.name;
                        history.recordCheckpoint(b, { chat: 0, kind: 'start' });
                        session.battle = b;
                        await this.save(boardId, session);
                        stepResult = { ok: true, resumed: false, message: `已开启战役「${map.name}」（${map.w}×${map.h}）`, events: [...(b.pending || [])] };
                        break;
                    }
                    case 'Move': {
                        const b = session.battle;
                        const u = resolveUnit(b, step.unit);
                        const x = toCoord(step.x, 'x');
                        const y = toCoord(step.y, 'y');
                        const ev = engine.doMove(b, u, x, y);
                        engine.commit(b, ev);
                        await this.save(boardId, session);
                        stepResult = { ok: true, message: narrator.formatEvent(ev), events: [ev] };
                        break;
                    }
                    case 'Attack': {
                        const b = session.battle;
                        const u = resolveUnit(b, step.unit);
                        const t = resolveUnit(b, step.target);
                        if (step.x !== undefined && step.y !== undefined) {
                            const mx = toCoord(step.x, 'x'), my = toCoord(step.y, 'y');
                            if (mx !== u.x || my !== u.y) {
                                const mev = engine.doMove(b, u, mx, my);
                                engine.commit(b, mev);
                            }
                        }
                        const ev = engine.doAttack(b, u, t, rules, Math.random, step.reaction || 'counter');
                        engine.commit(b, ev);
                        await this.save(boardId, session);
                        stepResult = { ok: true, message: narrator.formatEvent(ev), events: [ev] };
                        break;
                    }
                    case 'Skill': {
                        const b = session.battle;
                        const u = resolveUnit(b, step.unit);
                        if (step.x !== undefined && step.y !== undefined) {
                            const mx = toCoord(step.x, 'x'), my = toCoord(step.y, 'y');
                            if (mx !== u.x || my !== u.y) {
                                const mev = engine.doMove(b, u, mx, my);
                                engine.commit(b, mev);
                            }
                        }
                        const skName = String(step.skill || '').trim();
                        const sk = (u.skills || []).find(s => s.id === skName || s.name === skName || s.name.includes(skName));
                        if (!sk) throw new Error(`${u.name} 没有技能：${skName}`);
                        let tx = u.x, ty = u.y;
                        if (step.target) {
                            const t = resolveUnit(b, step.target);
                            tx = t.x; ty = t.y;
                        } else if (step.tx !== undefined && step.ty !== undefined) {
                            tx = toCoord(step.tx, 'tx');
                            ty = toCoord(step.ty, 'ty');
                        }
                        const ev = engine.doSkill(b, u, sk, tx, ty, rules);
                        engine.commit(b, ev);
                        await this.save(boardId, session);
                        stepResult = { ok: true, message: narrator.formatEvent(ev), events: [ev] };
                        break;
                    }
                    case 'Wait': {
                        const b = session.battle;
                        const u = resolveUnit(b, step.unit);
                        if (step.x !== undefined && step.y !== undefined) {
                            const mx = toCoord(step.x, 'x'), my = toCoord(step.y, 'y');
                            if (mx !== u.x || my !== u.y) {
                                const mev = engine.doMove(b, u, mx, my);
                                engine.commit(b, mev);
                            }
                        }
                        const ev = engine.doWait(b, u);
                        engine.commit(b, ev);
                        await this.save(boardId, session);
                        stepResult = { ok: true, message: narrator.formatEvent(ev), events: [ev] };
                        break;
                    }
                    case 'EndTurn': {
                        const b = session.battle;
                        if (!b) throw new Error('当前没有进行中的战斗');
                        const evs = engine.endPlayerPhase(b, rules);
                        history.recordCheckpoint(b, { chat: 0, kind: 'turn' });
                        await this.save(boardId, session);
                        stepResult = {
                            ok: true,
                            message: evs.map(e => narrator.formatEvent(e)).filter(Boolean).join(' '),
                            events: evs,
                        };
                        break;
                    }
                    case 'Manual': {
                        const b = session.battle;
                        if (!b) throw new Error('当前没有进行中的战斗');
                        const mType = step.type || 'stat';
                        const change = { type: mType };
                        if (step.unit) change.uid = resolveUnit(b, step.unit).uid;
                        if (step.x !== undefined) change.x = toCoord(step.x, 'x');
                        if (step.y !== undefined) change.y = toCoord(step.y, 'y');
                        if (step.key !== undefined) change.key = String(step.key);
                        if (step.value !== undefined) {
                            if (['true', 'false'].includes(String(step.value).toLowerCase())) {
                                change.value = String(step.value).toLowerCase() === 'true';
                            } else if (!Number.isNaN(Number(step.value)) && String(step.value).trim() !== '') {
                                change.value = Number(step.value);
                            } else {
                                change.value = step.value;
                            }
                        }
                        if (step.defId) {
                            const q = String(step.defId).trim();
                            const def = profile.units.find(d => d.id === q || d.name === q || d.name.includes(q));
                            if (!def) throw new Error(`资料卡中找不到单位模板：${q}`);
                            change.defId = def.id;
                        }
                        if (step.terrainId) {
                            const q = String(step.terrainId).trim();
                            const ter = profile.terrains.find(t => t.id === q || t.name === q || t.symbol === q);
                            if (!ter) throw new Error(`资料卡中找不到地形：${q}`);
                            change.terrainId = ter.id;
                        }
                        const evs = manual.applyManualChange(b, change, profile);
                        if (step.note) {
                            for (const ev of evs) {
                                if (ev.type === 'manual') ev.text = `${String(ev.text || '').replace(/。$/, '')}（${step.note}）。`;
                            }
                        }
                        await this.save(boardId, session);
                        stepResult = {
                            ok: true,
                            message: evs.map(e => narrator.formatEvent(e)).filter(Boolean).join(' '),
                            events: evs,
                        };
                        break;
                    }
                    case 'BatchCommands': {
                        const b = session.battle;
                        if (!b) throw new Error('当前没有进行中的战斗');
                        const parsed = commands.parseCommands(String(step.commandsText || ''));
                        if (!parsed.length) throw new Error('未解析到有效战场指令');
                        const applied = [];
                        const opt = {
                            allow: { damage: true, heal: true, status: true, unstatus: true, move: true, retreat: true, spawn: true, terrain: true, end: true },
                            maxChangePct: 100,
                            allowKill: true,
                            profile,
                        };
                        for (const c of parsed) {
                            const r = commands.applyCommand(b, c, opt);
                            if (!r.ok) throw new Error(`指令 [${c.raw}] 失败：${r.reason}`);
                            applied.push(r.event);
                        }
                        const resEvs = commands.settle(b);
                        await this.save(boardId, session);
                        stepResult = {
                            ok: true,
                            message: [...applied, ...resEvs].map(e => narrator.formatEvent(e)).filter(Boolean).join(' '),
                            events: [...applied, ...resEvs],
                        };
                        break;
                    }
                    case 'Rewind': {
                        const b = session.battle;
                        if (!b) throw new Error('当前没有进行中的战斗');
                        const list = b.history || [];
                        if (!list.length) throw new Error('当前尚无天刻回溯存档点');
                        let targetId = step.checkpointId;
                        if (!targetId || targetId === 'latest' || targetId === 'last') {
                            targetId = list.at(-1).id;
                        } else if (targetId === 'start') {
                            targetId = list[0].id;
                        }
                        const rewound = history.rewindBattle(b, targetId, { chat: 0 });
                        if (!rewound) throw new Error(`找不到存档点：${targetId}`);
                        session.battle = rewound;
                        await this.save(boardId, session);
                        stepResult = {
                            ok: true,
                            message: `天刻之白沙发动！已回溯至存档点 ${targetId}（第 ${rewound.turn} 回合）`,
                            events: rewound.pending.slice(-1),
                        };
                        break;
                    }
                    case 'ImportDesign': {
                        const raw = typeof step.designJson === 'string'
                            ? designer.parseDesignReply(step.designJson)
                            : step.designJson;
                        const norm = designer.normalizeDesign(raw, profile);
                        const chosen = new Set(designer.designItems(norm).map(x => x.key));
                        designer.applyDesign(profile, norm, chosen);
                        if (norm.maps?.length && (step.overwrite === true || step.overwrite === 'true' || !session.battle)) {
                            const newMap = profile.maps.find(m => m.id === norm.maps[0].id) || profile.maps.at(-1);
                            const b = engine.createBattle(newMap, profile.units, profile.terrains, profile.unitTypes);
                            b.profileId = profile.id;
                            b.profileName = profile.name;
                            history.recordCheckpoint(b, { chat: 0, kind: 'start' });
                            session.battle = b;
                        }
                        await this.save(boardId, session);
                        stepResult = {
                            ok: true,
                            message: `已导入战棋设计：${designer.designSummary(norm)}${norm.warnings?.length ? `（修正：${norm.warnings.join('；')}）` : ''}`,
                            events: [{ type: 'designImported' }],
                        };
                        break;
                    }
                    default:
                        throw new Error(`未知战棋命令：${cmd}`);
                }
            } catch (error) {
                stepResult = { ok: false, error: error.message, events: [] };
            }
            results.push({ step: i + 1, command: cmd, ...stepResult });
            if (stepResult.events?.length) events.push(...stepResult.events);
            if (!stepResult.ok) {
                failedStep = i + 1;
                break;
            }
        }

        const summary = await this.buildSummary(session);
        const output = {
            ok: failedStep === null,
            partial: failedStep !== null && results.some(r => r.ok),
            failedStep,
            skipped: steps.slice(results.length).map((s, idx) => ({ step: results.length + idx + 1, command: s.command })),
            error: failedStep === null ? undefined : results.at(-1).error,
            results,
            events,
            source: 'tool',
            state: summary,
        };
        for (const listener of this.listeners) {
            try { listener(boardId, output); } catch { /* ignore listener error */ }
        }
        return output;
    }
}

module.exports = { SessionStore, stepsOf, loadCoreModules };