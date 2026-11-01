// 战场页：开始战斗、棋盘操作、整理并发送给 LLM
import { h, add, clear, toast, button, select, renderBoard, renderToken, setTokenPreview, textArea, textDialog, field, numInput, checkbox } from './dom.js';
import * as E from '../engine.js';
import { composeMessage, formatEvent, shouldNarrate, missionText, upcomingWaves, skillSummary } from '../narrator.js';
import * as ST from '../st.js';
import { runAiPhases, previewProposals, acceptProposals, rejectProposals } from './llm-flow.js';
import { COMMANDS } from '../commands.js';
import { applyManualChange } from '../manual.js';
import { playBattleEvents } from './action-process.js';
import { exchangePreview } from '../exchange.js';
import { recordCheckpoint, rewindBattle, checkpointTitle } from '../history.js';

const PHASE = { player: '我方阶段', enemy: '敌方阶段', ally: '友军阶段' };
const AI_NAMES = { aggressive: '主动出击', defensive: '原地迎击', stationary: '固守不动', ranged: '远程游击', flee: '逃跑' };
const KIND = { physical: '物理', magical: '魔法', support: '辅助' };

/** 战场交互状态（不持久化） */
export function newBattleUi() {
    return { sel: null, mode: 'idle', skillId: null, hover: null, undo: [], note: '', setupMap: null, showLog: false, busy: null, keep: null, engagement: null, cancelReaction: null, cheat: false, cheatTool: 'edit', cheatDef: null, cheatTerrain: null };
}

export function renderBattleTab(app, root) {
    clear(root);
    if (!ST.hasChat()) {
        root.append(h('div.tsrpg-empty', '请先打开一个角色或群组聊天。战斗进度会保存在当前聊天中。'));
        return;
    }
    if (!ST.isEnabledForChat()) {
        add(root, h('div.tsrpg-empty', '当前角色 / 群组未绑定资料卡，战棋未启用。'), button('绑定资料卡', () => app.setTab('profiles'), { icon: 'fa-link' }));
        return;
    }
    const b = ST.getBattle();
    if (!b?.active) renderSetup(app, root);
    else if (b.paused) renderPaused(app, root, b);
    else renderActive(app, root, app.bs.playback?.source === b ? app.bs.playback.battle : b);
}

/** 暂停保持战斗数据，不推进阶段，也不向聊天注入战场。 */
export function setBattlePaused(app, b, paused) {
    if (ST.getBattle() !== b || app.bs.busy || b.result) return;
    b.paused = paused;
    app.bs.sel = null; app.bs.mode = 'idle'; app.bs.engagement = null;
    ST.saveBattle();
    ST.setInjection('');
    app.updateInjection(); app.render();
}

function pauseButton(app, b) {
    return button('暂停战斗', () => setBattlePaused(app, b, true), {
        icon: 'fa-pause', disabled: !!app.bs.busy || !!b.result,
        title: '保留进度并停止战场注入；行动结算结束后可暂停',
    });
}

function renderPaused(app, root, b) {
    add(root, h('div.tsrpg-mission', `战斗已暂停：${b.mapName} · 第 ${b.turn} 回合 · ${PHASE[b.phase] || b.phase}`),
        h('div.tsrpg-muted', '棋盘、HP、技能冷却及待发送行动已保留。暂停期间不注入战场信息、不同步战场变化；关闭窗口或刷新后仍可继续。'),
        h('div.tsrpg-row', button('继续战斗', () => setBattlePaused(app, b, false), { icon: 'fa-play', cls: 'primary' })),
        h('div.tsrpg-board-wrap', renderBoard({ w: b.w, h: b.h, tiles: b.tiles, cell: app.cellFor(b.w, 312, b.h), terrain: id => b.terrains[id] || { color: '#999' }, units: E.alive(b).filter(u => E.visibleTo(b, 'P', u)), marks: fogMarks(b) })));
}

// ---------------------------------------------------------------- 开战准备

function renderSetup(app, root) {
    const s = app.settings;
    const ui = app.bs;
    if (!app.data.maps.length) {
        root.append(h('div.tsrpg-empty', `资料卡「${app.data.name}」还没有地图。请先在「地图」页创建地图并放置单位，或在「资料卡」页切换资料卡。`));
        return;
    }
    if (!app.data.maps.some(m => m.id === ui.setupMap)) ui.setupMap = app.data.maps[0].id;
    const map = app.data.maps.find(m => m.id === ui.setupMap);
    const terr = id => app.data.terrains.find(t => t.id === id) || { name: id, color: '#999' };
    const unitDefs = new Map(app.data.units.map(u => [u.id, u]));
    const placed = map.placements.filter(p => unitDefs.has(p.unitId));
    const all = placed.map(p => ({ ...unitDefs.get(p.unitId), x: p.x, y: p.y }));
    const counts = side => all.filter(u => u.side === side && u.kind !== 'object').length;
    const problems = E.validateMission(map, app.data.units);
    // 用一个临时战场生成任务说明与增援预告
    const preview = E.createBattle(map, app.data.units, app.data.terrains, app.data.unitTypes);
    // 战争迷雾：开战前只显示我方视野内的敌人
    const units = preview.fog.enabled ? preview.units.filter(u => E.visibleTo(preview, 'P', u)) : all;
    const marks = fogMarks(preview);
    for (const w of map.reinforcements || []) (marks.get(`${w.x},${w.y}`) || marks.set(`${w.x},${w.y}`, []).get(`${w.x},${w.y}`)).push('m-spawn');

    if (s.ui.layout === 'compact') {
        add(root,
            h('div.tsrpg-row',
                select(app.data.maps.map(m => [m.id, m.name]), map.id, v => { ui.setupMap = v; app.render(); }),
                button('开始战斗', () => startBattle(app, map), { icon: 'fa-flag', cls: 'primary', disabled: problems.length > 0 })),
            problems.map(p => h('div.tsrpg-warn', p)),
            h('div.tsrpg-board-wrap', renderBoard({ w: map.w, h: map.h, tiles: map.tiles, terrain: terr, units, marks, cell: app.cellFor(map.w) })),
        );
        return;
    }

    add(root,
        h('div.tsrpg-row.tsrpg-muted', h('i.fa-solid.fa-address-card'), ` 资料卡：${app.data.name}`,
            h('a.tsrpg-link', { onclick: () => app.setTab('profiles') }, '切换 / 绑定')),
        h('div.tsrpg-row',
            h('b', '选择地图：'),
            select(app.data.maps.map(m => [m.id, `${m.name}（${m.w}×${m.h}）· ${E.MISSION_NAMES[m.mission?.type || 'annihilate']}`]), map.id, v => { ui.setupMap = v; app.render(); }),
            button('开始战斗', () => startBattle(app, map), { icon: 'fa-flag', cls: 'primary', disabled: problems.length > 0 }),
        ),
        h('div.tsrpg-mission', h('i.fa-solid.fa-bullseye'), ' ', missionText(preview)),
        preview.fog.enabled ? h('div.tsrpg-muted', h('i.fa-solid.fa-smog'), ` 战争迷雾：只能看到我方视野内的敌人${preview.fog.ai ? '，敌人同样只知道看得见的我方单位' : '，敌人知道我方所有单位的位置'}。`) : null,
        upcomingWaves(preview) ? h('div.tsrpg-muted', h('i.fa-solid.fa-people-group'), ` 增援：${upcomingWaves(preview)}`) : null,
        map.desc ? h('div.tsrpg-desc', map.desc) : null,
        h('div.tsrpg-row.tsrpg-muted', `我方 ${counts('player')} · 友军 ${counts('ally')} · 敌方 ${preview.fog.enabled ? '?' : counts('enemy')}`),
        problems.map(p => h('div.tsrpg-warn', h('i.fa-solid.fa-triangle-exclamation'), ` ${p}`)),
        h('div.tsrpg-board-wrap', renderBoard({ w: map.w, h: map.h, tiles: map.tiles, terrain: terr, units, marks, cell: Math.min(app.cellFor(map.w), 32) })),
    );
}

export function startBattle(app, map) {
    if (ST.boundProfile()?.id !== app.data.id) return toast('warning', '请先使用当前聊天绑定的资料卡。');
    const s = app.settings;
    const problems = E.validateMission(map, app.data.units);
    if (problems.length) return toast('warning', problems.join('；'));
    const b = E.createBattle(map, app.data.units, app.data.terrains, app.data.unitTypes);
    b.airRule = app.data.rules.airTarget === 'antiAir';
    b.profileId = app.data.id;
    b.profileName = app.data.name;
    b.pending.push({ type: 'mission', turn: 1, text: missionText(b) });
    b.pending.push({ type: 'phase', turn: 1, phase: 'player' });
    recordCheckpoint(b, { chat: ST.chatLength(), kind: 'start' });
    app.bs = newBattleUi();
    ST.setBattle(b);
    app.updateInjection();
    toast('success', `战斗开始：${map.name}`);
    app.render();
}

// ---------------------------------------------------------------- 战斗中

function selUnit(b, ui) {
    return ui.sel ? E.getUnit(b, ui.sel) : null;
}

function canControl(b, u) {
    return u && u.hp > 0 && u.side === 'player' && !u.object && !E.isStunned(u) && !u.acted && b.phase === 'player' && !b.result;
}

/** 玩家是否按战争迷雾看棋盘（手动修改时显示全部） */
function fogView(b, ui) {
    return E.fogOn(b, 'P') && !ui?.cheat;
}

/** 玩家眼中 (x,y) 上的单位 */
function seenAt(b, ui, x, y) {
    return fogView(b, ui) ? E.visibleUnitAt(b, 'P', x, y) : E.unitAt(b, x, y);
}

/** 迷雾中的格子（我方视野之外）变暗 */
function fogMarks(b, ui = null, marks = new Map()) {
    if (!fogView(b, ui)) return marks;
    const seen = E.visibleTiles(b, 'P');
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
        if (seen.has(`${x},${y}`)) continue;
        if (!marks.has(`${x},${y}`)) marks.set(`${x},${y}`, []);
        marks.get(`${x},${y}`).push('m-fog');
    }
    return marks;
}

/** 最后发现敌人的位置：半透明的「?」棋子 */
function ghostTokens(b, ui, shown) {
    if (!fogView(b, ui)) return [];
    const taken = new Set(shown.map(u => `${u.x},${u.y}`));
    return E.lastSeen(b, 'P').filter(g => !taken.has(`${g.x},${g.y}`)).map(g => ({
        uid: `ghost:${g.unit.uid}`, ghost: true, side: g.unit.side, icon: '?', color: g.unit.color, x: g.x, y: g.y,
        name: `${g.unit.name}（第 ${g.turn} 回合最后发现于此）`, maxHp: 0,
    }));
}

function visibleFoeIds(b) {
    return new Set(E.alive(b).filter(u => E.team(u) === 'E' && E.visibleTo(b, 'P', u)).map(u => u.uid));
}

function computeMarks(b, ui) {
    const marks = fogMarks(b, ui);
    const add = (x, y, cls) => {
        const k = `${x},${y}`;
        if (!marks.has(k)) marks.set(k, []);
        marks.get(k).push(cls);
    };
    // 增援出现点：本回合结束时就会出现的用更醒目的样式
    for (const w of b.reinforcements || []) {
        const t = E.nextWaveTurn(b, w);
        if (t != null) add(w.x, w.y, t === b.turn ? 'm-spawn-soon' : 'm-spawn');
    }
    const u = selUnit(b, ui);
    if (!u || u.hp <= 0) return marks;
    add(u.x, u.y, 'm-sel');

    if (ui.mode === 'move' || ui.mode === 'inspect') {
        const reach = E.reachable(b, u, undefined, false, ui.mode === 'move' && fogView(b, ui));
        const reachCls = ui.mode === 'move' ? 'm-reach' : 'm-reach-foe';
        const threat = new Set();
        for (const n of reach.values()) {
            add(n.x, n.y, reachCls);
            for (const [tx, ty] of E.tilesInRange(b, n.x, n.y, u.rangeMin, u.rangeMax)) threat.add(`${tx},${ty}`);
        }
        for (const k of threat) {
            if (reach.has(k)) continue;
            const [x, y] = k.split(',').map(Number);
            add(x, y, 'm-threat');
        }
    }
    if (ui.mode === 'action' || ui.mode === 'attack') {
        for (const t of E.attackTargets(b, u)) add(t.x, t.y, 'm-target');
        if (ui.mode === 'attack') {
            for (const [x, y] of E.tilesInRange(b, u.x, u.y, u.rangeMin, u.rangeMax)) add(x, y, 'm-threat');
        }
    }
    if (ui.mode === 'skill') {
        const sk = u.skills.find(s => s.id === ui.skillId);
        if (sk) {
            for (const [x, y] of E.skillTargetTiles(b, u, sk)) add(x, y, E.skillTargetSide(sk) === 'enemy' ? 'm-skill' : 'm-heal');
        }
    }
    if (ui.engagement?.skillId) {
        const skill = u.skills.find(sk => sk.id === ui.engagement.skillId);
        if (skill) for (const [x, y] of E.skillAreaTiles(b, u, skill, ui.engagement.x, ui.engagement.y)) add(x, y, 'm-area');
    }
    if (ui.engagement?.targetId) {
        const target = E.getUnit(b, ui.engagement.targetId);
        if (target) add(target.x, target.y, 'm-target');
    }
    return marks;
}

function pushUndo(app, b) {
    // 回合内的操作不改动回溯存档，撤销快照不必复制它
    const { history, ...rest } = b;
    app.bs.undo.push(structuredClone(rest));
    if (app.bs.undo.length > 30) app.bs.undo.shift();
}

function undo(app) {
    if (app.bs.busy || ST.getBattle()?.paused) return;
    const snap = app.bs.undo.pop();
    if (!snap) return;
    if (!snap.history && ST.getBattle()?.history) snap.history = ST.getBattle().history;
    ST.setBattle(snap);
    app.bs.sel = null; app.bs.mode = 'idle';
    app.bs.engagement = null;
    app.updateInjection();
    app.render();
}

function afterAction(app, b, events, before) {
    for (const ev of events) if (ev) b.pending.push(ev);
    const results = E.commit(b, null);
    b.pending.push(...results);
    app.bs.sel = null; app.bs.mode = 'idle'; app.bs.skillId = null;
    app.bs.engagement = null;
    ST.saveBattle();
    app.updateInjection();
    const notify = () => {
        if (ST.getBattle() !== b || b.paused) return;
        if (b.result) toast(b.result === 'victory' ? 'success' : 'error', b.result === 'victory' ? '战斗胜利！' : '战斗失败……');
        else if (!E.alive(b).some(u => u.side === 'player' && !u.acted)) toast('info', '我方单位均已行动，可以结束回合。');
    };
    app.render();
    const completed = [...events, ...results].filter(Boolean);
    if (app.settings.ui.animate !== false) return playBattleEvents(app, b, before, completed).then(() => { notify(); return completed; });
    notify();
    return completed;
}

/** 释放辅助技能；速攻技能不消耗行动，结算后保持选中并回到原来的步骤（移动前 / 移动后） */
function castSkill(app, b, u, sk, x, y) {
    const back = u.moved ? 'action' : 'move';
    const done = act(app, b, () => E.doSkill(b, u, sk, x, y, app.data.rules));
    if (!E.isQuick(sk) || !done) return done;
    const restore = events => {
        if (ST.getBattle() === b && !app.bs.busy && canControl(b, u)) {
            app.bs.sel = u.uid; app.bs.mode = back; app.bs.skillBack = null; app.render();
        }
        return events;
    };
    return done.then ? done.then(restore) : restore(done);
}

function act(app, b, fn) {
    if (app.bs.busy || b.paused || ST.getBattle() !== b) return;
    try {
        pushUndo(app, b);
        const ev = fn();
        return afterAction(app, b, Array.isArray(ev) ? ev : [ev], app.bs.undo.at(-1));
    } catch (err) {
        app.bs.undo.pop();
        toast('warning', err.message || String(err));
        app.render();
    }
}

function onCell(app, b, x, y) {
    const ui = app.bs;
    if (ui.busy || b.paused || ST.getBattle() !== b) return;
    const u = selUnit(b, ui);
    const at = seenAt(b, ui, x, y);
    const key = `${x},${y}`;

    if (ui.cheat) {
        if (ui.cheatTool === 'spawn') manualChange(app, b, { type: 'spawn', defId: ui.cheatDef, x, y });
        else if (ui.cheatTool === 'terrain') manualChange(app, b, { type: 'terrain', terrainId: ui.cheatTerrain, x, y });
        else if (ui.cheatTool === 'remove' && at) manualChange(app, b, { type: 'remove', uid: at.uid });
        else if (ui.cheatTool === 'move' && u) manualChange(app, b, { type: 'move', uid: u.uid, x, y });
        else { ui.sel = at?.uid || null; app.render(); }
        return;
    }

    if (ui.mode === 'move' && u) {
        const fog = fogView(b, ui);
        const reach = E.reachable(b, u, undefined, false, fog);
        if (reach.has(key)) {
            pushUndo(app, b);
            const snapshot = ui.undo.at(-1);
            const seenBefore = fog ? visibleFoeIds(b) : null;
            const ev = E.doMove(b, u, x, y, { fogView: fog });
            if (ev) b.pending.push(ev);
            // 迷雾中发现了新的敌人（或遭遇伏击）后不能撤销，避免用撤销侦察
            if (fog && (ev?.ambush || [...visibleFoeIds(b)].some(id => !seenBefore.has(id)))) {
                ui.undo = [];
                toast(ev?.ambush ? 'warning' : 'info', ev?.ambush ? `遭遇伏击！${ev.ambush.name}埋伏在迷雾中，${u.name}被迫停下。` : '发现了迷雾中的敌人，本次移动无法撤销。');
            }
            const results = E.commit(b, null);
            b.pending.push(...results);
            ui.mode = u.hp > 0 && !b.result ? 'action' : 'idle';
            if (u.hp <= 0) ui.sel = null;
            ST.saveBattle();
            app.updateInjection();
            app.render();
            if (app.settings.ui.animate !== false) return playBattleEvents(app, b, snapshot, [ev, ...results].filter(Boolean));
            return;
        }
    }
    if ((ui.mode === 'action' || ui.mode === 'attack') && u && at && E.isFoe(at, u)) {
        if (E.attackTargets(b, u).includes(at)) {
            ui.engagement = { unitId: u.uid, targetId: at.uid };
            app.render(); return;
        }
    }
    if (ui.mode === 'skill' && u) {
        const sk = u.skills.find(s => s.id === ui.skillId);
        if (sk && E.skillTargetTiles(b, u, sk).some(([tx, ty]) => tx === x && ty === y)) {
            if (sk.kind !== 'support') {
                ui.engagement = { unitId: u.uid, skillId: sk.id, x, y };
                app.render(); return;
            }
            return castSkill(app, b, u, sk, x, y);
        }
        ui.mode = ui.skillBack || 'action'; ui.skillId = null; ui.skillBack = null;
        app.render();
        return;
    }
    if (ui.mode === 'action' || ui.mode === 'attack') {
        // 已移动的单位必须先选择行动（或撤销移动）
        if (ui.mode === 'attack') { ui.mode = 'action'; app.render(); }
        return;
    }
    if (at) {
        ui.sel = at.uid;
        ui.mode = canControl(b, at) ? (at.moved ? 'action' : 'move') : 'inspect';
    } else {
        ui.sel = null; ui.mode = 'idle';
    }
    app.render();
}

function onHover(app, b, x, y, refs) {
    const ui = app.bs;
    if (ui.hover && ui.hover[0] === x && ui.hover[1] === y) return;
    ui.hover = [x, y];
    const u = selUnit(b, ui);
    // 范围技能：高亮影响区域
    refs.board.querySelectorAll('.m-area').forEach(c => c.classList.remove('m-area'));
    let preview = '';
    if (u && ui.mode === 'skill') {
        const sk = u.skills.find(s => s.id === ui.skillId);
        if (sk && E.skillTargetTiles(b, u, sk).some(([tx, ty]) => tx === x && ty === y)) {
            for (const [ax, ay] of E.skillAreaTiles(b, u, sk, x, y)) {
                refs.board.querySelector(`[data-x="${ax}"][data-y="${ay}"]`)?.classList.add('m-area');
            }
            const aff = shownTargets(b, ui, E.skillAffected(b, u, sk, x, y));
            const rules = app.data.rules;
            const fx = sk.effects.filter(e => !['heal', 'heal_pct'].includes(e.type)).map(e => E.effectLabel(e));
            preview = aff.map(t => {
                const bits = [];
                const hit = E.skillHitChance(b, u, sk, t, rules);
                if (hit < 100) bits.push(`命中${hit}%`);
                if (sk.kind !== 'support') {
                    const p = exchangePreview(b, u, t, rules, sk);
                    bits.push(`-${p.damage}（期望≈${approx(p.expectedDamage)}）`);
                    if (p.counter) bits.push(`可能反击${p.counter}，命中${p.counterHit}%`);
                }
                for (const e of sk.effects) {
                    if (e.type === 'heal') bits.push(`+${E.calcHeal(u, t, Number(e.value) || 0, rules, Math.random, true)}`);
                    if (e.type === 'heal_pct') bits.push(`+${Math.min(t.maxHp - t.hp, Math.round(t.maxHp * (Number(e.value) || 0) / 100))}`);
                }
                return `${t.name} ${bits.join(' ')}`.trim();
            }).join('，');
            if (preview) preview = `【${sk.name}】预计：${preview}${fx.length ? `；附加 ${fx.join('、')}` : ''}`;
            if (E.skillTargetSide(sk) === 'tile') preview = `【${sk.name}】传送到 (${x + 1},${y + 1})${E.terrainAt(b, x, y).name}${fx.length ? `；附加 ${fx.join('、')}` : ''}`;
        }
    }
    const at = seenAt(b, ui, x, y);
    if (u && at && E.isFoe(at, u) && (ui.mode === 'action' || ui.mode === 'attack') && E.attackTargets(b, u).includes(at)) {
        const p = exchangePreview(b, u, at, app.data.rules);
        const killed = p.damage >= at.hp;
        preview = `${p.firstStrike ? `${at.name}先攻：命中 ${p.counterHit}%，伤害 ${p.counter}${p.counter >= u.hp ? '（可能先被击败，无法出手）' : ''}；存活后` : ''}攻击 ${at.name}：命中 ${p.hit}%，伤害 ${p.damage}${killed ? '（可击败）' : ''}`
            + (!p.firstStrike && p.counter ? `；反击${killed ? '（若未击败）' : ''}：命中 ${p.counterHit}%，伤害 ${p.counter}` : '');
    }
    refs.preview.textContent = ui.engagement ? '' : preview || '';
    // 悬停在可攻击的目标上：棋子血条闪烁显示预计 HP 变化；离开后恢复战斗确认中的预览
    let hoverMap = null;
    if (u && ui.mode === 'skill') {
        const sk = u.skills.find(s => s.id === ui.skillId);
        if (sk && sk.kind !== 'support' && E.skillTargetTiles(b, u, sk).some(([tx, ty]) => tx === x && ty === y)) hoverMap = forecastHp(b, u, sk, shownTargets(b, ui, E.skillAffected(b, u, sk, x, y)), app.data.rules);
    } else if (u && at && E.isFoe(at, u) && (ui.mode === 'action' || ui.mode === 'attack') && E.attackTargets(b, u).includes(at)) {
        hoverMap = forecastHp(b, u, null, [at], app.data.rules);
    }
    const shown = hoverMap || refs.basePreview;
    refs.board.querySelectorAll?.('.tsrpg-token[data-uid]').forEach(tok => {
        const unit = E.getUnit(b, tok.dataset.uid);
        if (unit) setTokenPreview(tok, unit, shown?.get(unit.uid));
    });
    clear(refs.hoverInfo);
    const show = at && at !== u ? at : null;
    if (show) refs.hoverInfo.append(unitCard(b, show, true, app.data.rules));
    else {
        const t = E.terrainAt(b, x, y);
        const fog = fogView(b, ui);
        const sight = b.fog?.enabled ? `${Number(t.visionBonus) ? ` 视野${t.visionBonus > 0 ? '+' : ''}${t.visionBonus}` : ''}${Number(t.conceal) > 0 ? ` 隐蔽(${t.conceal}格内才能发现)` : ''}${E.blocksSight(t) ? ' 遮挡视线' : ''}` : '';
        refs.hoverInfo.append(h('div.tsrpg-muted', `(${x + 1},${y + 1}) ${t.name}${t.defBonus ? ` 减伤${t.defBonus}%` : ''}${Number(t.avoid) ? ` 闪避${t.avoid > 0 ? '+' : ''}${t.avoid}%` : ''}${t.healPct ? ` 回复${t.healPct}%` : ''}${t.passable === false ? ' 不可步行' : ''}${sight} ${t.desc || ''}`));
        if (fog && !E.visibleTiles(b, 'P').has(`${x},${y}`)) refs.hoverInfo.append(h('div.tsrpg-muted', h('i.fa-solid.fa-smog'), ' 迷雾中：看不到这里有没有敌人'));
        const ghost = fog && E.lastSeen(b, 'P').find(g => g.x === x && g.y === y);
        if (ghost) refs.hoverInfo.append(h('div.tsrpg-warn', `最后发现：${ghost.unit.name}（第 ${ghost.turn} 回合），现在可能已经离开`));
        for (const w of b.reinforcements || []) {
            const turn = E.nextWaveTurn(b, w);
            if (w.x !== x || w.y !== y || turn == null) continue;
            refs.hoverInfo.append(h('div.tsrpg-warn', `增援出现点：第 ${turn} 回合结束时 ${b.unitDefs?.[w.unitId]?.name || '?'}×${w.count || 1}${Number(w.every) ? `，之后每 ${w.every} 回合一次` : ''}`));
        }
    }
}

function unitCard(b, u, compact = false, rules = null) {
    const t = E.terrainAt(b, u.x, u.y);
    const pct = Math.round((u.hp / u.maxHp) * 100);
    return h(`div.tsrpg-card.side-${u.side}`,
        h('div.tsrpg-card-title', renderToken(u), h('b', u.name), h('span.tsrpg-tag', E.SIDE_NAMES[u.side]),
            E.unitTypeName(b, u) ? h('span.tsrpg-tag', { title: b.unitTypes[u.typeId].desc || '' }, E.unitTypeName(b, u)) : null,
            u.object ? h('span.tsrpg-tag', '建筑') : null,
            u.keyTarget ? h('span.tsrpg-tag.key', '★ 关键目标') : null,
            u.acted && !u.object ? h('span.tsrpg-tag', '已行动') : null,
            E.extraActions(b, u) ? h('span.tsrpg-tag', `额外行动 ×${E.extraActions(b, u)}`) : null,
            u.attackOrder === 'last' ? h('span.tsrpg-tag', `${u.weaponName || '重武器'} · 后手`) : null,
            b.airRule && u.flying ? h('span.tsrpg-tag', { title: '只能被对空攻击或其他飞行单位打到' }, '飞行 · 需对空') : null,
            b.airRule && u.antiAir && !u.flying ? h('span.tsrpg-tag', { title: '普通攻击可以打到飞行单位' }, '对空') : null,
            E.taunters(b, u).length ? h('span.tsrpg-tag.dead', `被嘲讽：只能攻击${E.taunters(b, u).map(t => t.name).join('、')}`) : null,
            u.hp <= 0 ? h('span.tsrpg-tag.dead', u.object ? '已摧毁' : '已击败') : null),
        h('div.tsrpg-hp', h('div', { style: { width: `${pct}%` } }), h('span', `HP ${u.hp}/${u.maxHp}`)),
        statGrid(u, rules, b),
        (u.traits || []).length ? h('div.tsrpg-statuses', u.traits.map(t =>
            h('span.tsrpg-chip', { title: `${t.desc || ''}\n${E.traitSummary(t)}` }, `特质：${t.name}`))) : null,
        (u.statuses || []).length ? h('div.tsrpg-statuses', u.statuses.map(st => {
            const def = E.EFFECTS[st.type] || {};
            return h(`span.tsrpg-chip${def.debuff ? '.debuff' : ''}`, { title: def.help || '' }, `${E.effectLabel(st)} · ${st.turns}回合`);
        })) : null,
        compact ? null : h('div.tsrpg-muted', u.object
            ? `不会行动 · 位于${t.name}(${u.x + 1},${u.y + 1})`
            : `${KIND[u.atkType]}攻击${u.flying ? ' · 飞行' : ''}${u.side !== 'player' ? ` · ${AI_NAMES[u.ai] || u.ai}` : ''} · 位于${t.name}(${u.x + 1},${u.y + 1})`),
        !compact && u.skills.length ? h('div.tsrpg-skills', u.skills.map(sk =>
            h('div.tsrpg-muted', `【${sk.name}】${skillSummary(sk)}${sk.cdLeft > 0 ? `（冷却中，第 ${E.readyTurn(b, u, sk)} 回合可用）` : ''}`))) : null,
        u.wb ? h('div.tsrpg-muted', h('i.fa-solid.fa-book'), ` ${u.wb.book} › ${u.wb.label}`) : null,
    );
}

function statGrid(u, rules, b = null) {
    // 受增益 / 减益影响的属性显示为绿色 / 红色
    const cell = (label, key) => {
        const base = u[key], now = E.stat(u, key);
        return h('div', h('small', label), h(`b${now > base ? '.up' : now < base ? '.down' : ''}`, { title: now !== base ? `基础 ${base}` : '' }, String(now)));
    };
    if (u.object) return h('div.tsrpg-stats', cell('DEF', 'def'), cell('MDEF', 'mdef'));
    return h('div.tsrpg-stats',
        cell('ATK', 'atk'), cell('MATK', 'matk'), cell('DEF', 'def'), cell('MDEF', 'mdef'), cell('AGI', 'agi'), cell('MOV', 'mov'),
        h('div', h('small', '射程'), h('b', String(u.rangeMin === u.rangeMax ? u.rangeMax : `${u.rangeMin}-${u.rangeMax}`))),
        E.toughApplies(u, rules) ? h('div', { title: '每次防御或反击消耗1点，耗尽后只能承受伤害；己方阶段开始时回满' }, h('small', '韧性'),
            h(`b${E.canBrace(u, rules) ? '' : '.down'}`, `${E.toughLeft(u)}/${E.toughMax(u)}`)) : null,
        b?.fog?.enabled ? h('div', { title: '战争迷雾中能看到几格内的敌人（含地形加成）' }, h('small', '视野'), h('b', String(E.visionRange(b, u)))) : null);
}

function actionPanel(app, b, u) {
    const ui = app.bs;
    if (ui.busy || !u || u.side !== 'player' || u.object || b.phase !== 'player' || b.result) return null;
    if (E.isStunned(u)) return h('div.tsrpg-warn', '眩晕中，本回合无法行动。');
    const skillButton = sk => {
        const tiles = E.skillTargetTiles(b, u, sk);
        const ok = E.skillUsable(sk) && tiles.length;
        const side = E.skillTargetSide(sk);
        let label = `${E.isQuick(sk) ? '⚡' : ''}${sk.name}`;
        if (sk.cdLeft > 0) label += E.isQuick(sk) && Number(sk.cooldown) <= 1 ? ' 本回合已用' : ` ⏳第${E.readyTurn(b, u, sk)}回合`;
        else if (sk.uses) label += ` ${sk.usesLeft}/${sk.uses}`;
        // 只作用于自身的技能直接释放
        const onClick = side === 'self'
            ? () => castSkill(app, b, u, sk, u.x, u.y)
            : () => { ui.skillBack = ui.mode === 'move' ? 'move' : 'action'; ui.mode = 'skill'; ui.skillId = sk.id; app.render(); };
        return button(label, onClick, {
            icon: sk.kind !== 'support' ? 'fa-wand-sparkles' : side === 'tile' ? 'fa-location-arrow' : side === 'enemy' ? 'fa-skull' : sk.effects.some(e => e.type.startsWith('heal')) ? 'fa-heart' : 'fa-shield-heart',
            disabled: !ok, cls: ui.mode === 'skill' && ui.skillId === sk.id ? 'active' : '',
            title: `${skillSummary(sk)}${sk.desc ? `\n${sk.desc}` : ''}`,
        });
    };
    const quick = u.skills.filter(E.isQuick);
    if (ui.mode === 'move' || (ui.mode === 'skill' && ui.skillBack === 'move')) {
        return h('div.tsrpg-actions',
            h('div.tsrpg-muted', `点击蓝色格子移动（点击自身＝原地行动）。${quick.length ? '⚡速攻技能不消耗行动，可以先用。' : ''}`),
            button('原地行动', () => { pushUndo(app, b); ui.mode = 'action'; ui.skillBack = null; u.moved = true; app.render(); }, { icon: 'fa-hand' }),
            quick.map(skillButton),
        );
    }
    if (!['action', 'attack', 'skill'].includes(ui.mode)) return null;
    const targets = E.attackTargets(b, u);
    return h('div.tsrpg-actions',
        button(`攻击${targets.length ? `(${targets.length})` : ''}`, () => { ui.mode = 'attack'; app.render(); },
            { icon: 'fa-khanda', disabled: !targets.length, cls: ui.mode === 'attack' ? 'active' : '' }),
        u.skills.map(skillButton),
        button('待机', () => act(app, b, () => E.doWait(b, u)), { icon: 'fa-hourglass' }),
        button('撤销移动', () => undo(app), { icon: 'fa-rotate-left', disabled: !ui.undo.length }),
    );
}

/** 战斗中允许修改世界书绑定：把单位定义里的绑定同步到战场单位 */
function syncBindings(app, b) {
    const defs = new Map(app.data.units.map(u => [u.id, u]));
    let changed = false;
    for (const u of b.units) {
        const d = defs.get(u.defId);
        if (!d) continue;
        if (JSON.stringify(d.wb || null) !== JSON.stringify(u.wb || null)) {
            u.wb = d.wb ? structuredClone(d.wb) : null;
            changed = true;
        }
        // 更新前开始的战斗：单位没有韧性字段时按资料卡补上
        if (u.toughMax == null && !u.object) { u.toughMax = E.unitTough(d); u.tough = u.toughMax; changed = true; }
        // 更新前开始的战斗：补上兵种与视野
        if (u.typeId == null) { u.typeId = d.typeId || ''; changed = true; }
        if (u.vision == null) { u.vision = E.unitVision(d); changed = true; }
        if (u.antiAir == null && !u.object) { u.antiAir = !!d.antiAir; changed = true; }
        // AI 倾向随资料卡更新，已在场的单位也立即生效
        const reckless = d.mapReckless !== false;
        if (u.mapReckless !== reckless) { u.mapReckless = reckless; changed = true; }
    }
    if (!b.unitTypes) { b.unitTypes = E.battleUnitTypes(app.data.unitTypes); changed = true; }
    if (!b.fog) { b.fog = { enabled: false, ai: true }; changed = true; }
    // 对空规则属于资料卡的战斗规则，修改后对进行中的战斗立即生效
    const airRule = app.data.rules.airTarget === 'antiAir';
    if (!!b.airRule !== airRule) { b.airRule = airRule; changed = true; }
    if (changed) { ST.saveBattle(); }
    return changed;
}

function renderActive(app, root, b) {
    const s = app.settings;
    const ui = app.bs;
    if (!ui.playback && syncBindings(app, b)) app.updateInjection();
    const u = selUnit(b, ui);
    if (u && u.hp <= 0 && !ui.cheat) { ui.sel = null; ui.mode = 'idle'; }

    const status = b.result
        ? h(`span.tsrpg-result.${b.result}`, b.result === 'victory' ? '胜利' : '战败')
        : h('span.tsrpg-tag', PHASE[b.phase] || b.phase);
    const left = E.alive(b).filter(x => x.side === 'player' && !x.object && !x.acted && !E.isStunned(x)).length;

    const refs = {};
    refs.preview = h('div.tsrpg-preview');
    refs.hoverInfo = h('div.tsrpg-hoverinfo');
    // 战斗确认时，在棋子血条上预览这次交战的 HP 变化
    refs.basePreview = ui.engagement && !ui.playback ? engagementForecast(app, b) : null;
    // 回放中被击败的单位在倒下那一帧仍然显示（淡出）；战争迷雾中只显示看得见的单位
    const shown = (ui.playback ? b.units.filter(x => (x.hp > 0 && !x.retreated) || ui.playback.effects?.some(e => e.uid === x.uid && e.ko)) : E.alive(b))
        .filter(x => !fogView(b, ui) || E.visibleTo(b, 'P', x) || ui.playback?.effects?.some(e => e.uid === x.uid && e.ko));
    refs.board = renderBoard({
        w: b.w, h: b.h, tiles: b.tiles, cell: app.cellFor(b.w, 312, b.h),
        terrain: id => b.terrains[id] || { name: id, color: '#999' },
        units: [...shown, ...ghostTokens(b, ui, shown)],
        marks: computeMarks(b, ui),
        effects: ui.playback?.effects,
        area: ui.playback?.area,
        preview: refs.basePreview,
        selected: ui.sel,
        onCell: (x, y) => onCell(app, b, x, y),
        onHover: (x, y) => onHover(app, b, x, y, refs),
        onContext: () => { ui.sel = null; ui.mode = 'idle'; app.render(); },
    });

    if (s.ui.layout === 'compact') {
        add(root,
            h('div.tsrpg-topbar',
                h('div.tsrpg-topbar-info', h('b', `第 ${b.turn} 回合`), status),
                h('div.tsrpg-btn-group',
                    button('撤销', () => undo(app), { icon: 'fa-rotate-left', disabled: !ui.undo.length || !!ui.busy, title: '撤销上一步操作' }),
                    button('结束回合', () => endTurn(app, b), { icon: 'fa-forward', cls: 'primary', disabled: !!b.result || b.phase !== 'player' || !!ui.busy }),
                    quietTurnButton(app, b)),
                h('div.tsrpg-btn-group.tools', pauseButton(app, b))),
            h('div.tsrpg-board-wrap', refs.board),
            processStatus(app),
            u ? h('div.tsrpg-mini-unit', renderToken(u), h('b', u.name), hpForecast(u, u.hp),
                h('small.tsrpg-muted', `${E.toughApplies(u, app.data.rules) ? `韧性 ${E.toughLeft(u)}/${E.toughMax(u)}` : ''}${u.acted ? ' · 已行动' : ''}`)) : null,
            ui.busy ? null : ui.cheat ? manualPanel(app, b) : ui.engagement ? engagementPanel(app, b) : actionPanel(app, b, u),
            refs.preview,
            h('div.tsrpg-row',
                button('发送行动', () => dispatch(app, b), { icon: 'fa-paper-plane', disabled: !!ui.busy || (!b.pending.length && !ui.note.trim()) }),
                b.llm?.proposals ? button('处理剧情提议', () => { app.setLayout('float'); app.setTab('battle'); }, { icon: 'fa-scroll' }) : null,
                button('取消选择', () => { ui.sel = null; ui.mode = 'idle'; app.render(); }, { disabled: !ui.sel })),
            manualToggle(app),
            h('details.tsrpg-battle-management',
                h('summary', '战斗管理'),
                rewindButton(app, b),
                button('结束战斗', () => endBattle(app), { icon: 'fa-flag-checkered', cls: 'danger', disabled: !!ui.busy })),
        );
        return;
    }

    const pending = b.pending.filter(e => e.type !== 'phase' || b.pending.length > 1);
    const pendingList = h('div.tsrpg-events', pending.length
        ? pending.map(e => h(`div.tsrpg-event${shouldNarrate(e, s.narration) ? '' : '.muted'}`, formatEvent(e)))
        : h('div.tsrpg-muted', '暂无待发送的行动。'));

    const noteBox = textArea(ui.note, v => { ui.note = v; }, 2, '补充要求（可选）：例如“着重描写骑士的心理”。会和战斗结果一起发送。');
    noteBox.addEventListener('input', e => { ui.note = e.target.value; });

    const sendLabel = { send: '发送给 LLM', fill: '填入输入框', preview: '预览并发送' }[s.send.mode];

    add(root,
        h('div.tsrpg-topbar',
            h('div.tsrpg-topbar-info',
                h('b.tsrpg-map-name', b.mapName), h('span.tsrpg-turn', `第 ${b.turn} 回合`), status,
                b.fog?.enabled ? h('span.tsrpg-tag', { title: E.fogOn(b, 'E') ? '战争迷雾：双方都只能看到视野内的敌人' : '战争迷雾：我方只能看到视野内的敌人' }, h('i.fa-solid.fa-smog'), ' 迷雾') : null,
                b.phase === 'player' && !b.result ? h('span.tsrpg-muted', `待行动 ${left}`) : null),
            h('div.tsrpg-btn-group',
                button('撤销', () => undo(app), { icon: 'fa-rotate-left', disabled: !ui.undo.length || !!ui.busy, title: '撤销上一步操作' }),
                button('结束回合', () => endTurn(app, b), { icon: 'fa-forward', cls: 'primary', disabled: !!b.result || b.phase !== 'player' || !!ui.busy }),
                quietTurnButton(app, b)),
            // 不常用的操作只显示图标（悬停查看说明）
            h('div.tsrpg-btn-group.tools',
                pauseButton(app, b),
                rewindButton(app, b),
                manualToggle(app),
                button('', () => textDialog(app.panel, 'LLM 看到的战场信息', app.battleContext(), { note: '自动注入与 {{srpg}} 宏的内容。可在「设置 → LLM 读取战场」中调整。' }), { icon: 'fa-eye', title: '查看 LLM 看到的战场信息' }),
                button('', () => endBattle(app), { icon: 'fa-flag-checkered', title: '结束 / 放弃战斗' })),
        ),
        h('div.tsrpg-mission',
            h('i.fa-solid.fa-bullseye'), ' ', b.result ? `${b.result === 'victory' ? '胜利' : '战败'}：${b.resultReason || ''}` : missionText(b),
            !b.result && upcomingWaves(b) ? h('div.tsrpg-muted', h('i.fa-solid.fa-people-group'), ` 增援：${upcomingWaves(b)}`) : null),
        h('div.tsrpg-battle',
            h('div.tsrpg-board-wrap', refs.board),
            h('div.tsrpg-side',
                processStatus(app),
                ui.busy ? null : proposalPanel(app, b),
                u ? unitCard(b, u, false, app.data.rules) : h('div.tsrpg-side-hint', h('i.fa-solid.fa-hand-pointer'), ' 点击我方单位选择，右键取消。悬停查看地形与敌人。'),
                ui.busy ? null : ui.cheat ? manualPanel(app, b) : ui.engagement ? engagementPanel(app, b) : actionPanel(app, b, u),
                refs.preview,
                refs.hoverInfo,
                h('div.tsrpg-side-card',
                    h('div.tsrpg-section-title', h('i.fa-solid.fa-scroll'), ' 待发送的行动', h('small.tsrpg-muted', `${pending.length ? ` ${pending.length} 条` : ''}（灰色＝按设置不描写）`)),
                    pendingList,
                    noteBox,
                    h('div.tsrpg-row',
                        button(sendLabel, () => dispatch(app, b), { icon: 'fa-paper-plane', cls: 'primary' }),
                        button('清空', () => { b.pending = []; ST.saveBattle(); app.render(); }, { icon: 'fa-eraser', disabled: !b.pending.length || !!ui.busy, title: '丢弃待发送的行动（棋盘不变）' }))),
                h('details.tsrpg-log.tsrpg-side-card', { open: ui.showLog, ontoggle: e => { ui.showLog = e.target.open; } },
                    h('summary', h('i.fa-solid.fa-book'), ` 战斗记录（${b.log.length}）`),
                    h('div.tsrpg-events', b.log.slice(-80).map(l => h('div.tsrpg-event', l)))),
            ),
        ),
    );
}

const approx = value => Number(value.toFixed(1));

/** 预览血条：当前 HP，将损失的部分闪烁（回复为绿色），文字显示变化 */
function hpForecast(u, after) {
    const max = Math.max(1, u.maxHp);
    const next = Math.max(0, Math.min(max, after));
    const pct = v => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
    const lo = Math.min(next, u.hp), hi = Math.max(next, u.hp);
    const ko = next <= 0 && u.hp > 0;
    // 将损失 / 回复的部分直接画在血条上（标出 −伤害；击败时标出「击败」）
    const chunk = hi > lo ? h(`div.tsrpg-fbar-${next < u.hp ? 'loss' : 'gain'}`, { style: { left: pct(lo), width: pct(hi - lo) } },
        h('span', ko ? '击败' : `${next < u.hp ? '−' : '+'}${hi - lo}`)) : null;
    return h(`div.tsrpg-fbar.side-${u.side}${ko ? '.ko' : ''}`, { title: `HP ${u.hp}/${u.maxHp}${next !== u.hp ? ` → ${next}` : ''}` },
        h('div.tsrpg-fbar-keep', { style: { width: pct(lo) } }), chunk,
        chunk ? null : h('span.tsrpg-fbar-text', `${u.hp}/${u.maxHp}`));
}

/** 交战预测的一侧：头像、名字、HP 变化，下面是大血条和一个小标签 */
function forecastSide(u, after, tag, rules, cls = '') {
    const next = Math.max(0, after);
    return h(`div.tsrpg-fc-side${cls}`,
        h('div.tsrpg-fc-name', renderToken(u), h('b', u.name),
            h('small.tsrpg-fc-hp', next === u.hp ? `${u.hp}/${u.maxHp}` : `${u.hp} → ${next}`),
            E.toughApplies(u, rules) ? h('small.tsrpg-fc-tough', { title: '韧性：防御或反击各消耗1点' }, `🛡${E.toughLeft(u)}`) : null),
        hpForecast(u, after),
        tag ? h('div.tsrpg-fc-tag', tag) : null);
}

/** 一次交战的预计 HP（按命中计算；被援护时由援护者承受；反击 / 先攻计入攻击者） */
function forecastHp(b, actor, skill, targets, rules) {
    const map = new Map();
    let actorHp = actor.hp;
    for (const t of targets) {
        const c = E.coverFor(b, actor, t, skill || null);
        const v = c ? c.unit : t;
        const p = exchangePreview(b, actor, v, rules, skill || null, E.defaultReaction(b, actor, v, rules, skill || null, !!c));
        const after = Math.max(0, (map.get(v.uid) ?? v.hp) - (p.hit > 0 ? p.damage : 0));
        map.set(v.uid, after);
        if (p.responds && (p.firstStrike || after > 0)) actorHp -= p.counter;
    }
    if (actorHp !== actor.hp) map.set(actor.uid, Math.max(0, actorHp));
    return map;
}

/** 战争迷雾中界面只预览看得见的目标（范围攻击打到迷雾里的敌人时，结算后才知道） */
function shownTargets(b, ui, list) {
    return fogView(b, ui) ? list.filter(t => E.visibleTo(b, 'P', t)) : list;
}

function engagementForecast(app, b) {
    const plan = app.bs.engagement;
    const actor = E.getUnit(b, plan.unitId);
    if (!actor) return null;
    const skill = plan.skillId && actor.skills.find(sk => sk.id === plan.skillId);
    const target = plan.targetId && E.getUnit(b, plan.targetId);
    const targets = skill ? shownTargets(b, app.bs, E.skillAffected(b, actor, skill, plan.x, plan.y)) : target ? [target] : [];
    return forecastHp(b, actor, skill || null, targets, app.data.rules);
}

function previewCard(b, actor, target, rules, skill, reaction, defendingView = false) {
    const p = exchangePreview(b, actor, target, rules, skill, reaction);
    const targetAfter = Math.max(0, target.hp - (p.hit > 0 ? p.damage : 0));
    const countered = p.responds && (p.firstStrike || targetAfter > 0);
    const actorAfter = countered ? Math.max(0, actor.hp - p.counter) : actor.hp;
    // 目标一侧的标签：命中率，以及防御 / 韧性耗尽等状态
    const state = reaction === 'defend' && !target.object ? ' · 防御' : !target.object && E.isFoe(actor, target) && !E.canBrace(target, rules) ? ' · 韧性耗尽' : '';
    const hit = forecastSide(target, targetAfter, `命中 ${p.hit}%${state}`, rules, defendingView ? '' : '.right');
    const strikeTag = countered ? `${p.firstStrike ? '先攻' : '反击'} 命中 ${p.counterHit}%` : p.responds ? `击败则无反击（否则反击 ${p.counter}）` : '无反击';
    const strike = forecastSide(actor, actorAfter, strikeTag, rules, defendingView ? '.right' : '');
    // 兵种克制：进攻方向，以及对方反击时的方向
    const edges = [[actor, target], ...(p.responds ? [[target, actor]] : [])].map(([a, d]) => {
        const label = E.matchupLabel(E.matchup(b, a, d));
        return label ? `${E.unitTypeName(b, a)}→${E.unitTypeName(b, d)}：${label}` : '';
    }).filter(Boolean);
    return h('div.tsrpg-exchange-card', { title: `命中伤害 ${p.damage}，命中率 ${p.hit}%，期望伤害 ≈${approx(p.expectedDamage)}${p.responds ? `；${p.firstStrike ? '先攻' : '存活后反击'} ${p.counter}，命中率 ${p.counterHit}%` : ''}` },
        h('div.tsrpg-forecast', defendingView ? [hit, h('div.tsrpg-fc-vs', '⚔'), strike] : [strike, h('div.tsrpg-fc-vs', '⚔'), hit]),
        edges.length ? h('div.tsrpg-edge', h('i.fa-solid.fa-chess'), ` 兵种克制　${edges.join('；')}`) : null,
        p.firstStrike && p.counter >= actor.hp ? h('div.tsrpg-warn', defendingView ? '我方先攻可能击败对手，使其无法出手。' : '我方存在先被击败、无法出手的风险。') : null);
}

/** 多目标技能：每个目标一行血条预览，攻击者合计反击 */
function multiForecast(b, actor, skill, targets, rules) {
    const map = forecastHp(b, actor, skill, targets, rules);
    return h('div.tsrpg-exchange-card.tsrpg-multi-forecast',
        forecastSide(actor, map.get(actor.uid) ?? actor.hp, map.has(actor.uid) ? '会受到反击' : '无反击', rules),
        targets.map(t => {
            const c = E.coverFor(b, actor, t, skill);
            const v = c ? c.unit : t;
            const p = exchangePreview(b, actor, v, rules, skill, E.defaultReaction(b, actor, v, rules, skill, !!c));
            return h('div.tsrpg-fc-row', renderToken(v), h('b', v.name), hpForecast(v, map.get(v.uid) ?? v.hp),
                h('small', `${c ? `援护${t.name} · ` : ''}${E.isFoe(actor, v) ? '' : '误伤 · '}命中 ${p.hit}%${p.responds ? ` · 反击 ${p.counter}` : ''}`));
        }));
}

function engagementPanel(app, b) {
    const plan = app.bs.engagement;
    const actor = E.getUnit(b, plan.unitId);
    const skill = plan.skillId && actor?.skills.find(sk => sk.id === plan.skillId);
    const target = plan.targetId && E.getUnit(b, plan.targetId);
    const targets = actor ? skill ? shownTargets(b, app.bs, E.skillAffected(b, actor, skill, plan.x, plan.y)) : target ? [target] : [] : [];
    const covered = t => actor && E.coverFor(b, actor, t, skill);
    return h('div.tsrpg-engagement',
        h('div.tsrpg-section-title', h('i.fa-solid.fa-khanda'), ' 战斗确认'),
        h('b', `${actor?.name || '单位'} → ${skill ? skill.name : target?.name || '目标'}`),
        skill ? h('small.tsrpg-muted', skillSummary(skill)) : null,
        targets.length > 1 ? multiForecast(b, actor, skill, targets, app.data.rules) : targets.map(t => {
            const c = covered(t);
            if (!c) return previewCard(b, actor, t, app.data.rules, skill, E.defaultReaction(b, actor, t, app.data.rules, skill));
            return [h('div.tsrpg-warn', `【援护】${c.unit.name}将替${t.name}承受这次攻击（不反击）`),
                previewCard(b, actor, c.unit, app.data.rules, skill, E.defaultReaction(b, actor, c.unit, app.data.rules, skill, true))];
        }),
        !targets.length ? h('div.tsrpg-warn', fogView(b, app.bs) ? '范围内没有看得见的目标（迷雾中可能有敌人）；执行仍会消耗技能。' : '范围内没有目标；执行仍会消耗技能。') : null,
        h('small.tsrpg-muted', '血条上的斜纹＝命中时将损失的 HP；悬停卡片可查看具体数值。'),
        h('div.tsrpg-row',
            button('战斗', () => performEngagement(app, b, false), { icon: 'fa-khanda', cls: 'primary' }),
            button('战斗并生成描写', () => performEngagement(app, b, true), { icon: 'fa-comment' }),
            button('取消', () => { app.bs.engagement = null; app.render(); })),
    );
}

export async function performEngagement(app, b, narrate = false) {
    if (app.bs.busy || b.paused || ST.getBattle() !== b || !app.bs.engagement) return;
    if (narrate && ST.isGenerating()) return toast('warning', 'LLM正在生成，请稍后再选择生成描写。');
    const plan = app.bs.engagement;
    const actor = E.getUnit(b, plan.unitId);
    const skill = plan.skillId && actor?.skills.find(sk => sk.id === plan.skillId);
    const target = plan.targetId && E.getUnit(b, plan.targetId);
    if (!canControl(b, actor) || (plan.skillId && !skill) || (!skill && !target)) {
        app.bs.engagement = null; app.render(); return toast('warning', '战场已变化，请重新选择攻击。');
    }
    app.bs.engagement = null;
    const events = await act(app, b, () => {
        // 对方的反应：被援护时由援护者防御
        const react = t => {
            const c = E.coverFor(b, actor, t, skill || null);
            const v = c ? c.unit : t;
            return [v.uid, E.defaultReaction(b, actor, v, app.data.rules, skill || null, !!c)];
        };
        if (!skill) return E.doAttack(b, actor, target, app.data.rules, Math.random, react(target)[1]);
        const responses = Object.fromEntries(E.skillAffected(b, actor, skill, plan.x, plan.y).map(react));
        return E.doSkill(b, actor, skill, plan.x, plan.y, app.data.rules, Math.random, responses);
    });
    if (narrate) sendEngagementNarration(app, b, events);
}

/**
 * 发送「生成描写」：选中的交战必须描写，自上次发送以来的其余行动作为背景信息一并发送，
 * 之后清空待发送列表，避免已经过去的行动在下次发送时被重复要求描写。
 */
function sendEngagementNarration(app, b, events) {
    if (!events?.length || ST.getBattle() !== b || b.paused) return false;
    if (ST.isGenerating()) { toast('warning', 'LLM正在生成，本次战斗已保留在待发送行动中。'); return false; }
    let note = app.bs.note;
    if (app.settings.send.includeInput) note = [note, ST.readMainInput().trim()].filter(Boolean).join('\n');
    const chosen = new Set(events);
    const all = [...b.pending, ...events.filter(e => !b.pending.includes(e))];
    // 用户明确要求描写这次交战：攻击 / 技能不受「描写设置」限制，不能被归为可略过的背景信息
    const text = composeMessage(b, all, app.settings, note, {
        force: e => chosen.has(e) && (e.type === 'attack' || e.type === 'skill'),
        background: e => !chosen.has(e),
    });
    if (ST.sendAsUser(text) === false) return false;
    b.pending = [];
    b.log.push(...all.map(formatEvent).filter(Boolean));
    if (b.log.length > 300) b.log.splice(0, b.log.length - 300);
    app.bs.note = '';
    ST.saveBattle(); app.render();
    return true;
}

function askReaction(app, b, request) {
    const { attacker, target, skill, cover } = request;
    const fallback = E.defaultReaction(b, attacker, target, app.data.rules, skill, !!cover);
    if (target.side !== 'player' || target.object || !E.isFoe(attacker, target) || app.settings.ui.confirmDefense === false || app.isOpen === false) return fallback;
    return new Promise(resolve => {
        const ui = app.bs;
        let done = false;
        const settle = value => {
            if (done) return;
            done = true; overlay.remove(); ui.cancelReaction = null;
            app.panel.classList.remove('tsrpg-reaction-open');
            ui.busy = '回合结算中……';
            resolve(value);
        };
        // 有韧性时可以防御 / 反击，也可以主动承受以保留韧性；韧性耗尽时只能承受。都可以选择生成描写
        const braced = E.canBrace(target, app.data.rules);
        const tough = E.toughApplies(target, app.data.rules);
        const responds = E.canRespond(b, attacker, target, app.data.rules, skill, !!cover);
        const generate = reaction => {
            if (ST.isGenerating()) return toast('warning', 'LLM正在生成，请稍后再选择生成描写。');
            settle({ reaction, narrate: true });
        };
        const defend = braced ? button('防御', () => settle('defend'), { icon: 'fa-shield', cls: 'primary' }) : null;
        const counter = responds ? button('反击', () => settle('counter'), { icon: 'fa-khanda' }) : null;
        const endure = button('承受', () => settle('none'), { icon: 'fa-heart-crack', cls: braced ? '' : 'primary', title: braced && tough ? '不防御也不反击，承受全额伤害，保留韧性' : '' });
        const defendNarrate = braced ? button('防御并生成描写', () => generate('defend'), { icon: 'fa-comment' }) : null;
        const counterNarrate = responds ? button('反击并生成描写', () => generate('counter'), { icon: 'fa-comment' }) : null;
        const endureNarrate = button('承受并生成描写', () => generate('none'), { icon: 'fa-comment' });
        const cancel = button('取消本次回合', () => settle(null));
        const choices = [counter, counterNarrate, defend, defendNarrate, endure, endureNarrate, cancel].filter(Boolean);
        const option = (title, reaction, buttons) => h('div.tsrpg-option',
            h('div.tsrpg-option-head', h('b', title), h('div.tsrpg-option-buttons', buttons)),
            previewCard(b, attacker, target, app.data.rules, skill, reaction, true));
        ui.busy = `等待${target.name}选择${!braced ? '承受' : responds ? '反击、防御或承受' : '防御或承受'}`;
        const overlay = h('div.tsrpg-overlay', { onkeydown: e => {
            if (e.key === 'Escape') { e.preventDefault(); settle(null); }
            if (e.key === 'Tab') {
                e.preventDefault();
                const index = choices.indexOf(document.activeElement);
                choices[(index + (e.shiftKey ? -1 : 1) + choices.length) % choices.length].focus();
            }
        } }, h('div.tsrpg-dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': braced ? '选择反击、防御或承受' : '承受攻击' },
            h('div.tsrpg-section-title', `${attacker.name}即将${skill ? `使用【${skill.name}】攻击` : '攻击'}${cover ? `${cover.name}，由${target.name}援护承受` : target.name}`),
            cover ? h('div.tsrpg-muted', `援护：${target.name}替${cover.name}挡下这次攻击，可以防御或承受，不能反击。`) : null,
            !braced ? h('div.tsrpg-warn', `${target.name}韧性耗尽，无法防御或反击，只能承受全额伤害（己方阶段开始时回满）。`)
                : !responds && !cover ? h('small.tsrpg-muted', '本次无法反击（射程、眩晕、反击设置或MAP攻击限制）。') : null,
            // 每个选项一张卡片：标题旁就是按钮，下面是双方血条预览
            responds ? option('选择反击时', 'counter', [counter, counterNarrate]) : null,
            braced ? option('选择防御时', 'defend', [defend, defendNarrate]) : null,
            option('选择承受时', 'none', [endure, endureNarrate]),
            h('small.tsrpg-muted', `${braced ? '防御减伤并放弃反击；反击需要受击后存活。' : ''}${braced && tough ? `防御或反击消耗1点韧性（剩余 ${E.toughLeft(target)}/${E.toughMax(target)}），承受不消耗。` : ''}「…并生成描写」：回合结算后详细描写这次交战。`),
            h('div.tsrpg-row.tsrpg-option-foot', cancel),
        ));
        ui.cancelReaction = () => settle(null);
        app.panel.classList.add('tsrpg-reaction-open');
        app.render(); app.panel.append(overlay); (defend || endure).focus();
    });
}

function processStatus(app) {
    return app.bs.busy ? h('div.tsrpg-busy.tsrpg-process-status', { 'aria-live': 'polite' },
        h('span', app.bs.busy), app.bs.playback ? button('跳过过程', () => { app.bs.skipPlayback = true; }, { icon: 'fa-forward-fast' }) : null) : null;
}

function quietTurnButton(app, b) {
    return button('仅结算回合', () => endTurn(app, b, true), { icon: 'fa-forward-step', disabled: !!b.result || b.phase !== 'player' || !!app.bs.busy, title: '只用内置AI结算，不调用LLM，也不发送提示词；行动保留，可稍后手动发送' });
}

function manualToggle(app) {
    return button(app.bs.cheat ? '退出手动修改' : '手动修改', () => {
        app.bs.cheat = !app.bs.cheat;
        app.bs.engagement = null;
        app.bs.mode = 'idle'; app.bs.sel = null;
        app.render();
    }, { icon: 'fa-wrench', cls: app.bs.cheat ? 'active' : '', disabled: !!app.bs.busy, title: app.bs.cheat ? '退出手动修改' : '手动修改：放置 / 撤除 / 移动单位、调整数值、改地形' });
}

function manualChange(app, b, change) {
    if (app.bs.busy || b.paused || ST.getBattle() !== b) return;
    pushUndo(app, b);
    try {
        const events = applyManualChange(b, change, app.data);
        b.pending.push(...events);
        ST.saveBattle(); app.updateInjection(); app.render();
    } catch (err) {
        app.bs.undo.pop();
        toast('warning', err.message || String(err));
        app.render();
    }
}

function manualPanel(app, b) {
    const ui = app.bs;
    const u = E.getUnit(b, ui.sel);
    if (!app.data.units.some(d => d.id === ui.cheatDef)) ui.cheatDef = app.data.units[0]?.id || null;
    if (!app.data.terrains.some(t => t.id === ui.cheatTerrain)) ui.cheatTerrain = app.data.terrains[0]?.id || null;
    const tools = [['edit', '选中 / 改数值'], ['spawn', '放置单位'], ['remove', '撤除单位'], ['move', '移动所选单位'], ['terrain', '改地形']];
    const hints = { edit: '点击棋子或下拉选择单位，修改立即生效。', spawn: '选择单位类型，然后点击空格放置。', remove: '点击棋子撤除，可用顶部「撤销」恢复。', move: '先选择单位，再点击空格移动，不消耗行动。', terrain: '选择地形，然后点击格子替换。' };
    return h('div.tsrpg-manual-panel',
        h('b', '手动修改（仅当前战斗）'),
        h('div.tsrpg-row', select(tools, ui.cheatTool, v => { ui.cheatTool = v; app.render(); })),
        h('small.tsrpg-muted', hints[ui.cheatTool]),
        ui.cheatTool === 'spawn' ? field('单位类型', select(app.data.units.map(d => [d.id, `${d.name} · ${E.SIDE_NAMES[d.side]}`]), ui.cheatDef, v => { ui.cheatDef = v; })) : null,
        ui.cheatTool === 'terrain' ? field('地形', select(app.data.terrains.map(t => [t.id, t.name]), ui.cheatTerrain, v => { ui.cheatTerrain = v; })) : null,
        field('所选单位', select([['', '— 选择单位 —'], ...b.units.map(unit => [unit.uid, `${unit.name} · ${E.SIDE_NAMES[unit.side]}${unit.retreated ? '（已撤除）' : unit.hp <= 0 ? '（倒下）' : ''}`])], ui.sel || '', v => { ui.sel = v || null; app.render(); })),
        u ? [
            h('div.tsrpg-grid3',
                [['hp', '当前HP'], ['maxHp', '最大HP'], ['atk', 'ATK'], ['matk', 'MATK'], ['def', 'DEF'], ['mdef', 'MDEF'], ['agi', 'AGI'], ['mov', 'MOV'], ['rangeMin', '最小射程'], ['rangeMax', '最大射程'], ['tough', '当前韧性'], ['toughMax', '韧性上限'], ['vision', '视野']].map(([key, label]) => field(label, numInput(key === 'tough' ? E.toughLeft(u) : key === 'toughMax' ? E.toughMax(u) : key === 'vision' ? E.stat({ ...u, statuses: [], traits: [] }, 'vision') : u[key], value => manualChange(app, b, { type: 'stat', uid: u.uid, key, value }), { min: key === 'maxHp' ? 1 : 0 })))),
            field('兵种', select([['', '— 无兵种 —'], ...Object.entries(b.unitTypes || {}).map(([id, t]) => [id, t.name])], u.typeId || '', value => manualChange(app, b, { type: 'stat', uid: u.uid, key: 'typeId', value }))),
            field('阵营', select(Object.entries(E.SIDE_NAMES), u.side, value => manualChange(app, b, { type: 'stat', uid: u.uid, key: 'side', value }))),
            field('普通攻击顺序', select([['normal', '普通'], ['last', '后手 / 大剑']], u.attackOrder || 'normal', value => manualChange(app, b, { type: 'stat', uid: u.uid, key: 'attackOrder', value }))),
            h('div.tsrpg-row', ['flying', 'antiAir', 'acted', 'keyTarget'].map((key, i) => checkbox(['飞行', '普通攻击可对空', '已行动', '关键目标'][i], !!u[key], value => manualChange(app, b, { type: 'stat', uid: u.uid, key, value })))),
            h('div.tsrpg-row',
                button('满血 / 重置行动技能', () => manualChange(app, b, { type: 'restore', uid: u.uid }), { icon: 'fa-heart' }),
                button('撤除所选单位', () => manualChange(app, b, { type: 'remove', uid: u.uid }), { cls: 'danger' })),
        ] : null,
        button('击败场上全部敌人', () => manualChange(app, b, { type: 'defeatEnemies' }), { cls: 'danger' }),
        h('div.tsrpg-row',
            checkbox('战争迷雾', !!b.fog?.enabled, enabled => manualChange(app, b, { type: 'fog', enabled, ai: b.fog?.ai !== false })),
            b.fog?.enabled ? checkbox('敌方 AI 受迷雾限制', b.fog.ai !== false, ai => manualChange(app, b, { type: 'fog', enabled: true, ai })) : null),
        b.fog?.enabled ? h('small.tsrpg-muted', '手动修改期间显示全部单位（含迷雾中的敌人）；退出后恢复迷雾。') : null,
        h('small.tsrpg-muted', '可撤销；资料卡不受影响。修改会保存在战斗中，并在下一次发送行动时附带说明。'),
    );
}

async function endTurn(app, b, quiet = false) {
    if (app.bs.busy || b.paused || ST.getBattle() !== b) return;
    const left = E.alive(b).filter(x => x.side === 'player' && !x.object && !x.acted && !E.isStunned(x)).length;
    if (left && !confirm(`还有 ${left} 个我方单位未行动，确定结束回合吗？`)) return;
    const s = app.settings;
    const ui = app.bs;
    const before = structuredClone(b);
    let events;
    const narratedActors = new Set();
    ui.busy = '敌方回合结算中……';
    ui.sel = null; ui.mode = 'idle'; ui.engagement = null;
    app.render();
    try {
        events = await runAiPhases(app, b, {
            quiet,
            chooseReaction: async request => {
                const choice = await askReaction(app, b, request);
                if (choice?.narrate) narratedActors.add(request.attacker.uid);
                return choice?.reaction || choice;
            },
            processEvents: async (snapshot, batch) => {
                if (s.ui.animate !== false) await playBattleEvents(app, b, snapshot, batch);
            },
        });
    } catch (err) {
        if (app.bs === ui) { ui.busy = null; ui.playback = null; }
        if (ST.getBattle() === b) { ST.setBattle(before); app.updateInjection(); toast('warning', err.message || String(err)); }
        app.render(); return;
    }
    if (app.bs !== ui || ST.getBattle() !== b) return;
    ui.busy = null;
    b.pending.push(...hideFogEvents(b, events));
    recordCheckpoint(b, { chat: ST.chatLength() });
    app.bs.undo = [];
    app.bs.sel = null; app.bs.mode = 'idle';
    ST.saveBattle();
    app.updateInjection();
    app.render();
    if (ST.getBattle() !== b || b.paused) return;
    if (b.result) toast(b.result === 'victory' ? 'success' : 'error', b.result === 'victory' ? '战斗胜利！' : '战斗失败……');
    if (narratedActors.size) {
        sendEngagementNarration(app, b, events.filter(e => narratedActors.has(e.actor?.uid) && ['attack', 'skill', 'move'].includes(e.type)));
    } else if (!quiet && app.settings.send.autoOnEndTurn) dispatch(app, b);
}

/** 我方看不到的敌方行动不进入待发送列表；只留一句「迷雾中有动静」 */
function hideFogEvents(b, events) {
    const out = [];
    let noted = false;
    for (const e of events) {
        if (!e.fog) { out.push(e); continue; }
        if (!noted && ['move', 'skill', 'wait'].includes(e.type)) {
            out.push({ type: 'fogActivity', turn: e.turn, actor: { side: e.actor?.side || 'enemy', name: '' } });
            noted = true;
        }
    }
    return out;
}

/** 剧情同步提出的战场变化，等待确认 */
function proposalPanel(app, b) {
    const p = b.llm?.proposals;
    if (!p) return null;
    const ui = app.bs;
    const rows = previewProposals(app, b);
    if (!ui.keep || ui.keep.length !== rows.length || ui.keepFor !== p) {
        ui.keep = rows.map(r => r.ok);
        ui.keepFor = p;
    }
    return h('div.tsrpg-proposals',
        h('div.tsrpg-section-title', h('i.fa-solid.fa-scroll'), ` 剧情同步提出的战场变化（读到第 ${p.mesId} 楼）`),
        rows.map((r, i) => h(`label.tsrpg-proposal${r.ok ? '' : '.bad'}`,
            h('input', { type: 'checkbox', checked: ui.keep[i], disabled: !r.ok, onchange: e => { ui.keep[i] = e.target.checked; } }),
            h('span',
                r.ok ? formatEvent(r.event) : `${r.c.raw}`,
                r.ok ? null : h('small.tsrpg-warn', ` ✖ ${r.error}`),
                r.c.cmd ? h('small.tsrpg-muted', ` 〔${COMMANDS[r.c.cmd].label}〕`) : null))),
        h('div.tsrpg-row',
            button('应用勾选的变化', () => acceptProposals(app, b, ui.keep), { icon: 'fa-check', cls: 'primary', disabled: !rows.some(r => r.ok) }),
            button('全部拒绝', () => rejectProposals(app, b), { icon: 'fa-xmark' })),
        h('small.tsrpg-muted', `预览按顺序推演；应用后可以用「撤销」撤回。重新生成或删除第 ${p.mesId} 楼时，已应用的变化会自动撤回。`),
    );
}

function endBattle(app) {
    const battle = ST.getBattle();
    if (!battle || battle.paused || app.bs.busy || app.endBattleDialog) return;
    const dismiss = () => {
        overlay.remove();
        app.endBattleDialog = null;
    };
    const cancel = button('继续战斗', dismiss, { cls: 'primary' });
    const confirmEnd = button('确认结束战斗', () => {
        dismiss();
        // 聊天切换或异步结算后，旧确认框不能清除新战斗。
        if (ST.getBattle() !== battle || battle.paused || app.bs.busy) return;
        ST.setBattle(null);
        app.bs = newBattleUi();
        app.updateInjection();
        app.render();
    }, { icon: 'fa-flag-checkered', cls: 'danger' });
    const overlay = h('div.tsrpg-overlay', {
        onclick: e => { if (e.target === overlay) dismiss(); },
        onkeydown: e => {
            if (e.key === 'Escape') { e.preventDefault(); dismiss(); }
            if (e.key === 'Tab') {
                e.preventDefault();
                (document.activeElement === cancel ? confirmEnd : cancel).focus();
            }
        },
    }, h('div.tsrpg-dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '确认结束战斗' },
        h('div.tsrpg-section-title', '结束当前战斗？'),
        h('p', `「${battle.mapName}」第 ${battle.turn} 回合的棋盘进度和未发送行动将被清除，聊天记录会保留。`),
        h('div.tsrpg-row.tsrpg-end-battle-buttons', cancel, confirmEnd)));
    app.endBattleDialog = overlay;
    app.panel.append(overlay);
    cancel.focus();
}

// ---------------------------------------------------------------- 回溯

function rewindButton(app, b) {
    return button('回溯', () => rewindDialog(app, b), {
        icon: 'fa-clock-rotate-left', disabled: !!app.bs.busy,
        title: '回到之前某个回合开始时的战场，补录剧情后继续',
    });
}

const clock = at => {
    const d = new Date(at);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function rewindDialog(app, b) {
    if (app.bs.busy || b.paused || ST.getBattle() !== b || app.rewindDialog) return;
    const dismiss = () => {
        overlay.remove();
        app.rewindDialog = null;
    };
    const list = (b.history || []).slice().reverse();
    const rows = list.map(cp => h('div.tsrpg-checkpoint',
        h('div',
            h('b', checkpointTitle(cp)),
            h('div.tsrpg-muted', `聊天第 ${cp.chat} 楼 · 我方 ${cp.player} 人 · 敌方 ${cp.enemy} 人 · ${clock(cp.at)}`)),
        button('回到这里', () => { dismiss(); rewindTo(app, b, cp.id); }, { icon: 'fa-clock-rotate-left' })));
    const close = button('关闭', dismiss, { cls: 'primary' });
    const overlay = h('div.tsrpg-overlay', {
        onclick: e => { if (e.target === overlay) dismiss(); },
        onkeydown: e => { if (e.key === 'Escape') { e.preventDefault(); dismiss(); } },
    }, h('div.tsrpg-dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '战斗回溯' },
        h('div.tsrpg-section-title', '战斗回溯'),
        h('p.tsrpg-muted', '回到某个回合开始时的战场：棋盘、HP、技能冷却、状态和增援进度都恢复到那时，聊天记录不会被删除，可以直接补录对话后继续战斗。当前进度会自动保存为「回溯前的进度」，也可以用「撤销」立即返回。'),
        rows.length ? h('div.tsrpg-checkpoints', rows) : h('div.tsrpg-muted', '还没有存档。每个我方阶段开始时会自动保存（更新前开始的战斗从下一回合开始记录）。'),
        h('div.tsrpg-row', close)));
    app.rewindDialog = overlay;
    app.panel.append(overlay);
    close.focus();
}

export function rewindTo(app, b, id) {
    // 旧对话框不能改动切换聊天后的战斗
    if (app.bs.busy || b.paused || ST.getBattle() !== b) return false;
    const next = rewindBattle(b, id, { chat: ST.chatLength() });
    if (!next) return false;
    app.bs = newBattleUi();
    app.bs.undo = [structuredClone(b)];
    ST.setBattle(next);
    app.updateInjection();
    toast('success', `已回到第 ${next.turn} 回合，可以补录剧情后继续战斗。`);
    app.render();
    return true;
}

// ---------------------------------------------------------------- 发送

export function dispatch(app, b, forceMode) {
    if (ST.getBattle() !== b || b.paused) return;
    if (app.bs.busy) return toast('info', '请等行动过程结束，或点击「跳过过程」。');
    const s = app.settings;
    if (!b.pending.length && !app.bs.note.trim()) {
        toast('info', '没有需要发送的内容。');
        return;
    }
    let note = app.bs.note;
    if (s.send.includeInput) {
        const main = ST.readMainInput().trim();
        if (main) note = [note.trim(), main].filter(Boolean).join('\n');
    }
    const text = composeMessage(b, b.pending, s, note);
    const mode = forceMode || s.send.mode;
    if (mode === 'preview') return showPreview(app, b, text);
    deliver(app, b, text, mode);
}

function deliver(app, b, text, mode) {
    if (ST.getBattle() !== b || b.paused) return false;
    if (mode === 'send' && ST.isGenerating()) {
        toast('warning', 'LLM 正在生成中，请稍后再发送。');
        return false;
    }
    if (mode === 'send') ST.sendAsUser(text);
    else ST.writeMainInput(text);
    b.log.push(...b.pending.map(formatEvent).filter(Boolean));
    if (b.log.length > 300) b.log.splice(0, b.log.length - 300);
    b.pending = [];
    app.bs.note = '';
    ST.saveBattle();
    app.render();
    return true;
}

function showPreview(app, b, text) {
    const ta = h('textarea.text_pole.tsrpg-preview-text', { rows: 14, value: text });
    const overlay = h('div.tsrpg-overlay',
        h('div.tsrpg-dialog',
            h('div.tsrpg-section-title', '发送预览（可编辑）'),
            ta,
            h('div.tsrpg-row',
                button('发送', () => { if (deliver(app, b, ta.value, 'send')) overlay.remove(); }, { icon: 'fa-paper-plane', cls: 'primary' }),
                button('填入输入框', () => { deliver(app, b, ta.value, 'fill'); overlay.remove(); }, { icon: 'fa-keyboard' }),
                button('取消', () => overlay.remove(), { icon: 'fa-xmark' }),
            ),
        ));
    app.panel.append(overlay);
    ta.focus();
}
