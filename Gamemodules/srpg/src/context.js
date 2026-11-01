// 给 LLM 读取的战场信息：地图网格、单位详情、地形图例、任务、最近战况
import {
    SIDE_NAMES, EFFECTS, traitSummary, alive, terrainAt, stat, effectLabel, attackTargets, skillUsable, readyTurn, dist, toughLeft, toughMax, toughApplies, extraActions,
    fogOn, visibleTo, knownFoes, lastSeen, blocksSight, visionRange, unitTypeName, matchupLabel, isNeutralMatchup, matchup,
} from './engine.js';
import { missionText, upcomingWaves, skillSummary } from './narrator.js';

export const CONTEXT_SECTIONS = {
    map: '地图网格',
    legend: '地形图例',
    stats: '单位属性',
    skills: '技能与冷却',
    nearest: '敌我距离',
};

export function defaultContextOptions() {
    return { map: true, legend: true, stats: true, skills: true, nearest: true, logLines: 0 };
}

const pos = u => `(${u.x + 1},${u.y + 1})`;
const PREFIX = { player: 'P', ally: 'A', enemy: 'E' };

/** 单位编号：P1 P2… / A1… / E1…，按出场顺序固定 */
export function unitLabels(b) {
    const count = {}, labels = {};
    for (const u of b.units) {
        const p = PREFIX[u.side] || 'U';
        count[p] = (count[p] || 0) + 1;
        labels[u.uid] = `${p}${count[p]}`;
    }
    return labels;
}

/** 别名：单位编辑器里填的「故事中的名字」+ 绑定的世界书关键词 */
export function unitAliases(u) {
    const list = [
        ...String(u.aliases || '').split(/[,，、]/).map(x => x.trim()),
        ...(u.wb?.keys || []),
    ].filter(x => x && x !== u.name);
    return [...new Set(list)];
}

/** 为地图上出现的每种地形分配一个字符 */
function terrainChars(b) {
    const used = [...new Set(b.tiles)];
    const chars = {}, taken = new Set();
    for (const id of used) {
        const t = b.terrains[id] || { name: id };
        let c = t.symbol || (id === 'plain' ? '·' : (t.name || '?').slice(0, 1));
        if (taken.has(c)) c = (t.name || id).slice(0, 1);
        let n = 2;
        while (taken.has(c)) c = `${(t.name || id).slice(0, 1)}${n++}`;
        taken.add(c);
        chars[id] = c;
    }
    return chars;
}

function direction(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const ew = dx > 0 ? '东' : dx < 0 ? '西' : '';
    const ns = dy > 0 ? '南' : dy < 0 ? '北' : '';
    return ew && ns ? `${ew}${ns}` : ew || ns || '同一格';
}

/** 战争迷雾中我方看得到的单位 */
function shownUnits(b) {
    return alive(b).filter(u => visibleTo(b, 'P', u));
}

function terrainTraits(t, fog = false) {
    const bits = [];
    if (t.passable === false) bits.push(t.flyable === false ? '不可通过' : '步行不可通过，飞行可越过');
    else bits.push(`移动消耗${Number(t.moveCost) || 1}`);
    if (Number(t.defBonus)) bits.push(`减伤${t.defBonus}%`);
    if (Number(t.avoid)) bits.push(`闪避${t.avoid > 0 ? '+' : ''}${t.avoid}%`);
    if (Number(t.healPct)) bits.push(`每回合回复${t.healPct}%`);
    if (Number(t.enterDamage) || Number(t.enterDamagePct)) bits.push(`落脚伤害${Number(t.enterDamage) || 0} + 最大HP的${Number(t.enterDamagePct) || 0}%`);
    if (Number(t.turnDamage) || Number(t.turnDamagePct)) bits.push(`阵营回合开始伤害${Number(t.turnDamage) || 0} + 最大HP的${Number(t.turnDamagePct) || 0}%`);
    if (Number(t.enterDamage) || Number(t.enterDamagePct) || Number(t.turnDamage) || Number(t.turnDamagePct)) bits.push(t.damageFlying ? '飞行也受伤' : '飞行免疫地形伤害');
    if (fog && Number(t.visionBonus)) bits.push(`站在此处视野${t.visionBonus > 0 ? '+' : ''}${t.visionBonus}`);
    if (fog && Number(t.conceal) > 0) bits.push(`隐蔽：站在这里的单位只能被${t.conceal}格内的敌人发现`);
    if (fog && blocksSight(t)) bits.push('遮挡视线');
    return bits.join('，');
}

function mapSection(b, labels) {
    const chars = terrainChars(b);
    const occupant = new Map(shownUnits(b).map(u => [`${u.x},${u.y}`, labels[u.uid]]));
    const lines = [`## 地图（${b.w}×${b.h}）`];
    lines.push(`坐标写作 (x,y)：x 是列，从左到右 1–${b.w}；y 是行，从上到下 1–${b.h}。北＝上方，南＝下方，东＝右侧，西＝左侧。`);
    lines.push(`    ${Array.from({ length: b.w }, (_, i) => String(i + 1)).join(' ')}`);
    for (let y = 0; y < b.h; y++) {
        const row = [];
        for (let x = 0; x < b.w; x++) row.push(occupant.get(`${x},${y}`) || chars[b.tiles[y * b.w + x]]);
        lines.push(`${String(y + 1).padStart(3)} ${row.join(' ')}`);
    }
    lines.push(`网格中 P＝我方、A＝友军、E＝敌方单位，其余字符为地形（见图例）。`);
    const spawns = (b.reinforcements || []).map(w => `(${w.x + 1},${w.y + 1})`);
    if (spawns.length) lines.push(`增援出现点：${[...new Set(spawns)].join('、')}`);
    return lines;
}

function legendSection(b, withChars) {
    const chars = terrainChars(b);
    const lines = ['## 地形'];
    for (const id of new Set(b.tiles)) {
        const t = b.terrains[id] || { name: id };
        lines.push(`- ${withChars ? `${chars[id]} ` : ''}${t.name}（${terrainTraits(t, b.fog?.enabled)}）${t.desc ? `：${t.desc}` : ''}`);
    }
    return lines;
}

function unitBlock(b, u, labels, opts) {
    const t = terrainAt(b, u.x, u.y);
    const aliases = unitAliases(u);
    const tags = [SIDE_NAMES[u.side]];
    if (unitTypeName(b, u)) tags.push(`兵种：${unitTypeName(b, u)}`);
    if (u.object) tags.push('建筑');
    if (u.keyTarget) tags.push(u.side === 'enemy' ? '★关键目标（摧毁它）' : '★关键目标（保护它）');
    if (u.flying) tags.push(b.airRule ? '飞行（只能被对空攻击打到）' : '飞行');
    if (b.airRule && u.antiAir && !u.flying) tags.push('普通攻击可对空');
    if (u.attackOrder === 'last') tags.push(`${u.weaponName || '重武器'}：普通攻击后手`);
    const tough = !toughApplies(u, opts.rules) ? '' : `｜韧性 ${toughLeft(u)}/${toughMax(u)}${toughLeft(u) ? '' : '（耗尽，无法防御或反击）'}`;
    const lines = [`[${labels[u.uid]}] ${u.name}${aliases.length ? `（又名：${aliases.join('、')}）` : ''}｜${tags.join('｜')}｜位于 ${pos(u)} ${t.name}｜HP ${u.hp}/${u.maxHp}${tough}`];

    if (opts.stats) {
        const keys = u.object ? ['def', 'mdef'] : ['atk', 'matk', 'def', 'mdef', 'agi', 'mov'];
        const st = keys.map(k => {
            const now = stat(u, k);
            return `${k.toUpperCase()} ${now !== u[k] ? `${u[k]}→${now}` : now}`;
        }).join(' ');
        const extra = u.object ? '不会行动' : `${u.atkType === 'magical' ? '魔法' : '物理'}攻击 射程${u.rangeMin === u.rangeMax ? u.rangeMax : `${u.rangeMin}-${u.rangeMax}`}`;
        const sight = b.fog?.enabled && visionRange(b, u) ? `｜视野 ${visionRange(b, u)}` : '';
        lines.push(`  ${st}｜${extra}${sight}`);
    }
    for (const t of u.traits || []) lines.push(`  常驻特质【${t.name}】：${traitSummary(t)}${t.desc ? `；${t.desc}` : ''}`);
    const sts = (u.statuses || []).map(s => `${effectLabel(s)}（${EFFECTS[s.type]?.debuff ? '减益' : '增益'}，剩 ${s.turns} 回合）`);
    if (sts.length) lines.push(`  状态：${sts.join('、')}`);
    if (!u.object && b.phase === u.side && !b.result) {
        const extra = extraActions(b, u);
        lines.push(`  本回合：${u.acted ? '已行动' : u.moved ? '已移动，尚未行动' : '尚未行动'}${extra ? `（还有 ${extra} 次额外行动）` : ''}`);
    }
    if (opts.skills && u.skills?.length) {
        const sk = u.skills.map(s => {
            const state = skillUsable(s) ? '可用' : s.cdLeft > 0 ? `冷却中，第 ${readyTurn(b, u, s)} 回合可用` : '次数已用尽';
            return `${s.name}〔${state}〕${skillSummary(s)}`;
        });
        lines.push(`  技能：${sk.join('；')}`);
    }
    if (opts.nearest && !u.object) {
        // 战争迷雾中只列出我方看得到的敌人
        const foes = (u.side === 'enemy' ? alive(b).filter(f => f.side !== 'enemy') : knownFoes(b, u));
        if (foes.length) {
            const near = foes.map(f => [f, dist(u.x, u.y, f.x, f.y)]).sort((a, c) => a[1] - c[1]).slice(0, 2);
            const txt = near.map(([f, d]) => `${f.name}[${labels[f.uid]}] 在${direction(u, f)} ${d} 格${d === 1 ? '（相邻）' : ''}`);
            lines.push(`  最近的敌人：${txt.join('；')}`);
            const inRange = attackTargets(b, u);
            if (inRange.length) lines.push(`  无需移动即可攻击：${inRange.map(f => f.name).join('、')}`);
        }
    }
    return lines;
}

/** 场上兵种的说明与克制关系（只列出非默认的组合） */
function matchupSection(b, units) {
    const types = b.unitTypes || {};
    const present = [...new Set(units.map(u => u.typeId).filter(id => types[id]))];
    if (!present.length) return [];
    const lines = ['', '## 兵种'];
    for (const id of present) if (types[id].desc) lines.push(`- ${types[id].name}：${types[id].desc}`);
    const rules = [];
    for (const a of present) for (const d of present) {
        const m = matchup(b, { typeId: a }, { typeId: d });
        if (!isNeutralMatchup(m)) rules.push(`- ${types[a].name} 攻击 ${types[d].name}：${matchupLabel(m)}`);
    }
    if (rules.length) lines.push('克制关系（已由战斗系统计入伤害与命中；韧性消耗＝被攻击方每次防御或反击消耗的韧性）：', ...rules);
    return lines.length > 2 ? lines : [];
}

/**
 * 构建完整的战场信息
 * @param {object} b 战场
 * @param {object} opts 见 defaultContextOptions，另有 sections: 只输出指定部分（'map'|'units'|'mission'|'log'）
 * @param {Record<string,string>} wbContents uid -> 世界书条目内容
 */
export function buildBattleContext(b, opts = defaultContextOptions(), wbContents = {}) {
    if (!b?.active || b.paused) return '';
    const only = opts.sections ? new Set(opts.sections) : null;
    const want = k => !only || only.has(k);
    const labels = unitLabels(b);
    const out = [];
    const phase = b.result ? (b.result === 'victory' ? '已胜利' : '已战败') : `${SIDE_NAMES[b.phase] || b.phase}阶段`;
    out.push(`[Tavern-SRPG 战场状态｜${b.mapName}｜第 ${b.turn} 回合 · ${phase}]`);

    if (want('mission')) {
        out.push(`任务：${b.result ? `战斗已结束，${b.resultReason || ''}` : missionText(b)}`);
        const waves = upcomingWaves(b);
        if (waves && !b.result) out.push(`增援预告：${waves}`);
        if (b.mapDesc) out.push(`战场概况：${b.mapDesc}`);
        if (fogOn(b, 'P')) {
            out.push('战争迷雾：我方（含友军）只能看到视野内的敌人，下方地图与单位列表不包含迷雾中的敌人；描写时不要提到迷雾中看不到的敌人的具体位置。');
            const ghosts = lastSeen(b, 'P');
            if (ghosts.length) out.push(`最后发现位置（现在看不到）：${ghosts.map(g => `${g.unit.name}[${labels[g.unit.uid]}] ${pos(g)}（第 ${g.turn} 回合）`).join('；')}`);
        }
    }
    if (want('map') && opts.map) out.push('', ...mapSection(b, labels));
    if (want('map') && opts.legend) out.push('', ...legendSection(b, opts.map));

    if (want('units')) {
        out.push('', '## 单位');
        const shown = shownUnits(b);
        for (const side of ['player', 'ally', 'enemy']) {
            for (const u of shown.filter(x => x.side === side)) out.push(...unitBlock(b, u, labels, opts));
        }
        out.push(...matchupSection(b, shown));
        const fallen = b.units.filter(u => u.hp <= 0);
        if (fallen.length) out.push(`已倒下：${fallen.map(u => `${u.name}（${SIDE_NAMES[u.side]}${u.object ? '，已摧毁' : ''}）`).join('、')}`);
        const gone = b.units.filter(u => u.hp > 0 && u.retreated);
        if (gone.length) out.push(`已撤离战场：${gone.map(u => `${u.name}（${SIDE_NAMES[u.side]}）`).join('、')}`);
        const wb = alive(b).filter(u => wbContents[u.uid]);
        if (wb.length) {
            out.push('', '## 单位设定（来自世界书）');
            wb.forEach(u => out.push(`- ${u.name}：${wbContents[u.uid]}`));
        }
    }
    const n = Number(opts.logLines) || 0;
    if (want('log') && n > 0 && b.log?.length) {
        out.push('', `## 最近战况（最近 ${Math.min(n, b.log.length)} 条）`, ...b.log.slice(-n).map(l => `- ${l}`));
    }
    out.push('', '规则：以上数值（HP、位置、状态、击败与否）只由 SRPG 战斗系统计算。描写时请与之保持一致；若用户以自由文字描述行动，只做叙事描写，不要自行判定伤害、击败、位移或改变上述状态。');
    return out.join('\n');
}
