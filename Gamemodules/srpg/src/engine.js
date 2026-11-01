// 战斗引擎：纯逻辑，不依赖 SillyTavern / DOM，可在 node 中测试
// 坐标从 0 开始，对外描述时 +1

const IMPASSABLE = Infinity;

export const SIDE_NAMES = { player: '我方', enemy: '敌方', ally: '友军' };

export function team(u) {
    return u.side === 'enemy' ? 'E' : 'P';
}

export function isFoe(a, b) {
    return team(a) !== team(b);
}

export function dist(ax, ay, bx, by) {
    return Math.abs(ax - bx) + Math.abs(ay - by);
}

export function inBounds(b, x, y) {
    return x >= 0 && y >= 0 && x < b.w && y < b.h;
}

export function terrainAt(b, x, y) {
    const id = b.tiles[y * b.w + x];
    return b.terrains[id] || { id, name: id || '未知', moveCost: 1, passable: true, flyable: true, defBonus: 0, healPct: 0, desc: '' };
}

/** 场上的单位（未倒下、未撤退） */
export function alive(b) {
    return b.units.filter(u => u.hp > 0 && !u.retreated);
}

export function unitAt(b, x, y) {
    return b.units.find(u => u.hp > 0 && !u.retreated && u.x === x && u.y === y) || null;
}

export function getUnit(b, uid) {
    return b.units.find(u => u.uid === uid) || null;
}

/** 单位进入某格的消耗，不可进入返回 Infinity */
export function enterCost(b, unit, x, y) {
    const t = terrainAt(b, x, y);
    if (unit.flying) return t.flyable === false ? IMPASSABLE : 1;
    if (t.passable === false) return IMPASSABLE;
    const cost = Number(t.moveCost);
    return cost > 0 ? cost : 1; // 允许小数（如 0.5＝移动力翻倍），0 或无效时按 1 计

}

// ---------------------------------------------------------------- 兵种克制
// 攻击方兵种对防守方兵种：伤害倍率%、命中修正、防守方防御 / 反击时消耗的韧性倍数。

export const NEUTRAL_MATCHUP = Object.freeze({ dmg: 100, hit: 0, tough: 1 });

export function matchup(b, attacker, defender) {
    const vs = b?.unitTypes?.[attacker?.typeId]?.vs?.[defender?.typeId];
    if (!vs) return NEUTRAL_MATCHUP;
    const num = (v, d) => v === '' || v == null || !Number.isFinite(Number(v)) ? d : Number(v);
    return { dmg: Math.max(0, num(vs.dmg, 100)), hit: num(vs.hit, 0), tough: Math.max(0, Math.floor(num(vs.tough, 1))) };
}

export function isNeutralMatchup(m) {
    return !m || (m.dmg === 100 && !m.hit && m.tough === 1);
}

/** 例如「伤害150%、命中+10%、韧性消耗×2」 */
export function matchupLabel(m) {
    if (isNeutralMatchup(m)) return '';
    const bits = [];
    if (m.dmg !== 100) bits.push(`伤害${m.dmg}%`);
    if (m.hit) bits.push(`命中${m.hit > 0 ? '+' : ''}${m.hit}%`);
    if (m.tough !== 1) bits.push(m.tough ? `韧性消耗×${m.tough}` : '招架不消耗韧性');
    return bits.join('、');
}

export function unitTypeName(b, u) {
    return b?.unitTypes?.[u?.typeId]?.name || '';
}

// ---------------------------------------------------------------- 视野与战争迷雾
// 地形始终可见；单位只有在己方（我方＋友军共享视野）某个单位的视野内才可见。
// 建筑、刚攻击或被攻击过的单位（revealed，到其阵营下一阶段开始）、嘲讽和「暴露行踪」的单位总是可见。

export const DEFAULT_VISION = 4;

/** 该阵营（P＝我方与友军，E＝敌方）是否受战争迷雾限制 */
export function fogOn(b, teamKey = 'P') {
    return !!b?.fog?.enabled && (teamKey === 'P' || b.fog.ai !== false);
}

export function blocksSight(t) {
    return t.blockSight != null ? !!t.blockSight : t.passable === false && t.flyable === false; // 旧地形：城墙类挡住视线
}

/** 视野范围：视野属性（含增减益）＋所在地形的视野加成 */
export function visionRange(b, u) {
    if (u.hp <= 0 || u.retreated) return 0;
    return Math.max(0, stat(u, 'vision') + (Number(terrainAt(b, u.x, u.y).visionBonus) || 0));
}

/** 两格之间是否有挡住视线的地形（不计两端）；正好擦过格角时，两侧都挡住才算被挡 */
export function lineOfSight(b, x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const n = Math.max(Math.abs(dx), Math.abs(dy)) * 2;
    const opaque = (x, y) => !(x === x0 && y === y0) && !(x === x1 && y === y1) && blocksSight(terrainAt(b, x, y));
    const near = v => { const f = Math.floor(v); return v - f === 0.5 ? [f, f + 1] : [Math.round(v)]; };
    for (let i = 1; i < n; i++) {
        const xs = near(x0 + (dx * i) / n), ys = near(y0 + (dy * i) / n);
        if (xs.every(x => ys.every(y => opaque(x, y)))) return false;
    }
    return true;
}

/** 某阵营能提供视野的单位，附带视野范围 */
function viewers(b, teamKey) {
    const out = [];
    for (const v of b.units) {
        if (v.hp <= 0 || v.retreated || team(v) !== teamKey) continue;
        const r = visionRange(b, v);
        if (r > 0) out.push({ x: v.x, y: v.y, r });
    }
    return out;
}

function seesTile(b, eye, x, y) {
    return dist(eye.x, eye.y, x, y) <= eye.r && lineOfSight(b, eye.x, eye.y, x, y);
}

/** 站在 (x,y) 的单位能否被 eye 发现：隐蔽地形只能在近处发现（飞行单位不受隐蔽） */
function spotsAt(b, eye, x, y, flying = false) {
    const conceal = flying ? 0 : Math.max(0, Number(terrainAt(b, x, y).conceal) || 0);
    if (conceal > 0 && dist(eye.x, eye.y, x, y) > conceal) return false;
    return seesTile(b, eye, x, y);
}

/** 某阵营能否看到单位 u */
export function visibleTo(b, teamKey, u) {
    if (!fogOn(b, teamKey) || team(u) === teamKey || u.object || u.revealed) return true;
    if ((u.statuses || []).some(s => s.type === 'reveal' || s.type === 'taunt')) return true;
    return viewers(b, teamKey).some(eye => spotsAt(b, eye, u.x, u.y, u.flying));
}

/** 我方视野看不到的敌方单位 */
export function hiddenFromPlayer(b, u) {
    return fogOn(b, 'P') && team(u) === 'E' && !visibleTo(b, 'P', u);
}

/** 单位所在阵营已经发现的敌人 */
export function knownFoes(b, unit) {
    return alive(b).filter(t => isFoe(t, unit) && visibleTo(b, team(unit), t));
}

/** 某阵营视野内的格子（用于界面显示迷雾） */
export function visibleTiles(b, teamKey = 'P') {
    const seen = new Set();
    for (const v of viewers(b, teamKey)) {
        for (const [x, y] of tilesInRange(b, v.x, v.y, 0, v.r)) {
            if (!seen.has(`${x},${y}`) && lineOfSight(b, v.x, v.y, x, y)) seen.add(`${x},${y}`);
        }
    }
    return seen;
}

/** 某阵营眼中 (x,y) 上的单位（看不见的敌人视为空格） */
export function visibleUnitAt(b, teamKey, x, y) {
    const u = unitAt(b, x, y);
    return u && visibleTo(b, teamKey, u) ? u : null;
}

function fogTag(b, u, ev) {
    if (ev && u && hiddenFromPlayer(b, u)) ev.fog = true;
    return ev;
}

/** 攻击会暴露双方位置，直到各自阵营的下一个阶段开始 */
function reveal(b, ...units) {
    if (b.fog?.enabled) for (const u of units) if (u) u.revealed = true;
}

/**
 * 情报：各阵营记得的敌人位置（最后发现位置）。看到时更新；再次看到原位置却没有人时忘掉。
 * AI 受迷雾限制时，看不到任何敌人就朝这些位置搜索。
 */
export function updateIntel(b) {
    if (!b?.fog?.enabled) return;
    b.intel ||= {};
    for (const T of ['P', 'E']) {
        const memo = b.intel[T] ||= {};
        if (!fogOn(b, T)) continue;
        const eyes = viewers(b, T);
        for (const f of b.units) {
            if (team(f) === T || f.object) continue;
            const known = memo[f.uid];
            if (f.hp <= 0 || f.retreated) delete memo[f.uid];
            else if (visibleTo(b, T, f)) memo[f.uid] = { x: f.x, y: f.y, turn: b.turn };
            else if (known && eyes.some(v => spotsAt(b, v, known.x, known.y))) delete memo[f.uid];
        }
    }
}

/** 开启迷雾时初始化情报：敌方知道我方的布阵位置，我方只知道看得见的敌人 */
export function initFog(b) {
    if (!b.fog?.enabled) return;
    b.intel = { P: {}, E: {} };
    for (const u of alive(b)) if (team(u) === 'P' && !u.object) b.intel.E[u.uid] = { x: u.x, y: u.y, turn: b.turn };
    updateIntel(b);
}

/** 某阵营记得、但现在看不到的敌人位置 */
export function lastSeen(b, teamKey = 'P') {
    if (!fogOn(b, teamKey)) return [];
    return Object.entries(b.intel?.[teamKey] || {}).map(([uid, p]) => ({ unit: getUnit(b, uid), ...p }))
        .filter(g => g.unit && g.unit.hp > 0 && !g.unit.retreated && !visibleTo(b, teamKey, g.unit));
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** 最小堆（按 key 取最小） */
class Heap {
    constructor(key) { this.a = []; this.key = key; }
    get size() { return this.a.length; }
    push(v) {
        const a = this.a; a.push(v);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.key(a[p]) <= this.key(a[i])) break;
            [a[p], a[i]] = [a[i], a[p]]; i = p;
        }
    }
    pop() {
        const a = this.a, top = a[0], last = a.pop();
        if (a.length) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = i * 2 + 1, r = l + 1;
                let m = i;
                if (l < a.length && this.key(a[l]) < this.key(a[m])) m = l;
                if (r < a.length && this.key(a[r]) < this.key(a[m])) m = r;
                if (m === i) break;
                [a[m], a[i]] = [a[i], a[m]]; i = m;
            }
        }
        return top;
    }
}

/**
 * 计算可到达的格子（Dijkstra）。敌对单位阻挡通行，友方可穿过但不能停留。
 * @param {boolean} fogView 按该单位阵营的视野计算：看不见的敌人视为空格（战争迷雾中给玩家显示用）
 * @returns {Map<string,{x:number,y:number,cost:number,prev:string|null}>} 仅包含可停留的格子
 */
export function reachable(b, unit, maxMove = stat(unit, 'mov'), includeOccupied = false, fogView = false) {
    const seen = t => !fogView || visibleTo(b, team(unit), t);
    const start = `${unit.x},${unit.y}`;
    const best = new Map([[start, { x: unit.x, y: unit.y, cost: 0, prev: null }]]);
    const queue = new Heap(n => n.cost);
    queue.push(best.get(start));
    while (queue.size) {
        const cur = queue.pop();
        if (cur.cost > (best.get(`${cur.x},${cur.y}`)?.cost ?? Infinity)) continue;
        for (const [dx, dy] of DIRS) {
            const nx = cur.x + dx, ny = cur.y + dy;
            if (!inBounds(b, nx, ny)) continue;
            const occ = unitAt(b, nx, ny);
            if (occ && occ !== unit && isFoe(occ, unit) && seen(occ)) continue;
            const c = cur.cost + enterCost(b, unit, nx, ny);
            if (c > maxMove + 1e-9) continue; // 小数消耗累加的浮点误差
            const key = `${nx},${ny}`;
            if (c < (best.get(key)?.cost ?? Infinity)) {
                const node = { x: nx, y: ny, cost: c, prev: `${cur.x},${cur.y}` };
                best.set(key, node);
                queue.push(node);
            }
        }
    }
    // 移除被其他单位占据的格子（可穿过但不可停留）
    for (const [key, node] of includeOccupied ? [] : best) {
        const occ = unitAt(b, node.x, node.y);
        if (occ && occ !== unit && seen(occ)) best.delete(key);
    }
    return best;
}

/** 以若干目标格为源，对某单位的移动方式计算距离场（忽略单位阻挡），用于 AI 接近目标 */
export function distanceField(b, unit, sources) {
    const field = new Array(b.w * b.h).fill(Infinity);
    const queue = new Heap(n => n[2]);
    for (const [x, y] of sources) {
        field[y * b.w + x] = 0;
        queue.push([x, y, 0]);
    }
    while (queue.size) {
        const [x, y, d] = queue.pop();
        if (d > field[y * b.w + x]) continue;
        // 反向扩展：从邻格 n 走到 (x,y) 的代价是进入 (x,y) 的代价；源格（目标所在格）只需相邻即可
        const step = d === 0 ? 1 : enterCost(b, unit, x, y);
        if (!isFinite(step)) continue;
        for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy;
            if (!inBounds(b, nx, ny)) continue;
            if (!isFinite(enterCost(b, unit, nx, ny))) continue;
            const nd = d + step;
            if (nd < field[ny * b.w + nx]) {
                field[ny * b.w + nx] = nd;
                queue.push([nx, ny, nd]);
            }
        }
    }
    return field;
}

export function tilesInRange(b, x, y, min, max) {
    const out = [];
    for (let dy = -max; dy <= max; dy++) {
        for (let dx = -max; dx <= max; dx++) {
            const d = Math.abs(dx) + Math.abs(dy);
            if (d < min || d > max) continue;
            const nx = x + dx, ny = y + dy;
            if (inBounds(b, nx, ny)) out.push([nx, ny]);
        }
    }
    return out;
}

export function skillUsable(skill) {
    if (skill.uses && !(skill.usesLeft > 0)) return false;
    return !(skill.cdLeft > 0);
}

/** 冷却中的技能在第几回合可再次使用（用于界面显示） */
export function readyTurn(b, unit, skill) {
    if (!(skill.cdLeft > 0)) return b.turn;
    const order = ['player', 'enemy', 'ally'];
    const started = order.indexOf(b.phase) >= order.indexOf(unit.side);
    return b.turn + skill.cdLeft - (started ? 0 : 1);
}

// ---------------------------------------------------------------- 效果（增益 / 减益 / 立即）

/**
 * 预设效果。instant：立即生效；其余为持续效果，持续回合在「施法者阵营的阶段开始时」减 1。
 * stat + sign：属性修正（flat 为固定值，否则为百分比）；debuff：可被驱散的减益。
 */
export const EFFECTS = {
    heal: { name: '恢复HP', group: '立即', instant: true, value: 120, unit: '% MATK', help: '恢复 施法者MATK × 数值% 的生命' },
    heal_pct: { name: '恢复HP（按比例）', group: '立即', instant: true, value: 30, unit: '% 最大HP', help: '恢复 目标最大HP × 数值% 的生命' },
    cleanse: { name: '驱散减益', group: '立即', instant: true, noValue: true, help: '移除目标身上所有减益效果' },
    refresh: { name: '额外行动', group: '立即', instant: true, noValue: true, help: '本回合多行动一次：已行动的目标立即可以再行动；尚未行动的目标（包括自己）在下一次行动后可以再行动（可再移动）。只对正在行动的阵营有效，每个单位每回合最多获得一次' },
    recall: { name: '召回到身边', group: '立即', instant: true, noValue: true, help: '目标瞬间移动到施法者身边的空格（建筑不受影响）；会受到落脚地形伤害' },
    atk_up: { name: '攻击力上升', group: '增益', stat: 'atk', sign: 1, value: 30, unit: '%' },
    matk_up: { name: '魔攻上升', group: '增益', stat: 'matk', sign: 1, value: 30, unit: '%' },
    def_up: { name: '防御力上升', group: '增益', stat: 'def', sign: 1, value: 30, unit: '%' },
    mdef_up: { name: '魔防上升', group: '增益', stat: 'mdef', sign: 1, value: 30, unit: '%' },
    agi_up: { name: '敏捷上升', group: '增益', stat: 'agi', sign: 1, value: 30, unit: '%', help: '提高命中与闪避' },
    mov_up: { name: '移动力上升', group: '增益', stat: 'mov', sign: 1, value: 2, unit: '格', flat: true },
    vision_up: { name: '视野上升', group: '增益', stat: 'vision', sign: 1, value: 2, unit: '格', flat: true, help: '战争迷雾中看得更远' },
    regen: { name: '持续恢复', group: '增益', value: 10, unit: '% 最大HP / 回合', help: '每次自己阵营的阶段开始时恢复生命' },
    taunt: { name: '嘲讽', group: '增益', value: 0, unit: '格（0＝全图）', help: '范围内的敌人只能攻击带有嘲讽的单位' },
    cover: { name: '援护', group: '增益', noValue: true, help: '施法者替目标承受下一次单体攻击（普通攻击或单体伤害技能），承受一次后消失；援护者不反击，可以防御。不能援护自己' },
    cover_area: { name: '范围援护', group: '增益', value: 2, unit: '格', flat: true, help: '总是作用于施法者（无论技能选择谁）：施法者周围此范围内的友军受到单体攻击时，都由施法者承受（不限次数）；不反击，可以防御。MAP / 范围攻击不会被援护' },
    atk_down: { name: '攻击力下降', group: '减益', stat: 'atk', sign: -1, value: 30, unit: '%', debuff: true },
    matk_down: { name: '魔攻下降', group: '减益', stat: 'matk', sign: -1, value: 30, unit: '%', debuff: true },
    def_down: { name: '防御力下降', group: '减益', stat: 'def', sign: -1, value: 30, unit: '%', debuff: true },
    mdef_down: { name: '魔防下降', group: '减益', stat: 'mdef', sign: -1, value: 30, unit: '%', debuff: true },
    agi_down: { name: '敏捷下降', group: '减益', stat: 'agi', sign: -1, value: 30, unit: '%', debuff: true, help: '降低命中与闪避' },
    mov_down: { name: '移动力下降', group: '减益', stat: 'mov', sign: -1, value: 2, unit: '格', flat: true, debuff: true },
    vision_down: { name: '视野下降', group: '减益', stat: 'vision', sign: -1, value: 2, unit: '格', flat: true, debuff: true, help: '战争迷雾中看得更近' },
    reveal: { name: '暴露行踪', group: '减益', noValue: true, debuff: true, help: '战争迷雾中，所有敌人都能看到该单位' },
    poison: { name: '中毒', group: '减益', value: 10, unit: '% 最大HP / 回合', debuff: true, help: '每次自己阵营的阶段开始时损失生命，不会因此倒下' },
    stun: { name: '眩晕', group: '减益', noValue: true, debuff: true, help: '无法行动' },
};

// 特质与临时状态独立：不会过期，也不能被驱散。
export const TRAIT_EFFECTS = {
    ...Object.fromEntries(Object.entries(EFFECTS).filter(([, d]) => d.stat)),
    regen: { name: '回合开始恢复HP（比例）', value: 10, unit: '% 最大HP' },
    regen_flat: { name: '回合开始恢复HP（固定）', value: 5, unit: 'HP' },
    attract: { name: '吸引敌人优先攻击', value: 3, unit: '格（0＝全图）' },
};

export function traitEffects(u) {
    return (Array.isArray(u.traits) ? u.traits : []).flatMap(t =>
        (Array.isArray(t.effects) ? t.effects : []).filter(e => TRAIT_EFFECTS[e.type]).map(e => ({ ...e, traitName: t.name || '未命名特质' })));
}

export function traitSummary(t) {
    return (t.effects || []).filter(e => TRAIT_EFFECTS[e.type]).map(e => {
        const d = TRAIT_EFFECTS[e.type], value = Math.max(0, Number(e.value) || 0);
        if (d.stat) return `${d.stat === 'vision' ? '视野' : d.stat.toUpperCase()}${d.sign > 0 ? '+' : '-'}${value}${d.flat || e.flat ? (['mov', 'vision'].includes(d.stat) ? '格' : '点') : '%'}`;
        if (e.type === 'attract') return `${value ? value + '格内' : '全图'}敌人优先攻击自己`;
        return `自己阵营回合开始恢复${value}${e.type === 'regen' ? '%最大HP' : 'HP'}`;
    }).join('、');
}

/** 吸引优先级依据敌人本阶段起点；不会限制玩家的攻击选择。 */
export function attractionTargets(b, unit) {
    const px = unit.phaseX ?? unit.x, py = unit.phaseY ?? unit.y;
    return knownFoes(b, unit).filter(t => traitEffects(t).some(e =>
        e.type === 'attract' && (!Number(e.value) || dist(t.x, t.y, px, py) <= Math.max(0, Number(e.value) || 0))));
}

export function effectLabel(e) {
    const def = EFFECTS[e.type];
    if (!def) return e.type;
    if (e.type === 'cover' && e.byName) return `受${e.byName}援护`;
    if (def.noValue || (e.type === 'taunt' && !Number(e.value))) return def.name;
    if (e.type === 'taunt') return `${def.name}（${e.value}格）`;
    if (def.instant) return def.name;
    return `${def.name}${e.value}${def.flat ? '格' : '%'}`;
}

/** 旧版数据兼容：kind 'heal' → 辅助技能 + 恢复效果 */
export function normalizeSkill(sk) {
    if (sk.kind === 'heal') {
        sk.kind = 'support';
        sk.target = 'ally';
        sk.effects = [{ type: 'heal', value: Number(sk.power) || 100, turns: 0 }];
    }
    if (!Array.isArray(sk.effects)) sk.effects = [];
    if (!sk.target) sk.target = sk.kind === 'support' ? 'ally' : 'enemy';
    if (sk.cooldown == null) sk.cooldown = 0;
    if (sk.hitMod == null) sk.hitMod = 0;
    if (sk.sureHit == null) sk.sureHit = false;
    if (!['normal', 'mapLine', 'mapArea'].includes(sk.attackMode) || sk.kind === 'support') sk.attackMode = 'normal';
    if (sk.lineLength == null) sk.lineLength = 3;
    if (!['all', 'enemy'].includes(sk.mapTargets)) sk.mapTargets = 'all';
    return sk;
}

export function hasStatus(u, type) {
    return (u.statuses || []).some(s => s.type === type);
}

export function isStunned(u) {
    return hasStatus(u, 'stun');
}

/** 计入增益 / 减益后的属性 */
export function stat(u, key) {
    // 旧战斗中的单位没有视野字段
    const base = key === 'vision' && u.vision == null ? (u.object ? 0 : DEFAULT_VISION) : Number(u[key]) || 0;
    let pct = 0, flat = 0;
    for (const s of [...(u.statuses || []), ...traitEffects(u)]) {
        const def = EFFECTS[s.type];
        if (def?.stat !== key) continue;
        if (def.flat || s.flat) flat += def.sign * (Number(s.value) || 0);
        else pct += def.sign * (Number(s.value) || 0);
    }
    return Math.max(0, Math.round(base * (1 + pct / 100) + flat));
}

/** 正在嘲讽该单位的敌人（以单位在本阶段开始时的位置判断范围） */
export function taunters(b, unit) {
    const px = unit.phaseX ?? unit.x, py = unit.phaseY ?? unit.y;
    return alive(b).filter(t => isFoe(t, unit) && (t.statuses || []).some(s =>
        s.type === 'taunt' && (!Number(s.value) || dist(t.x, t.y, px, py) <= Number(s.value))));
}

/** 技能作用于哪一方：enemy / ally / self / tile（传送自身到空地） */
export function skillTargetSide(skill) {
    return skill.kind === 'support' ? (skill.target || 'ally') : 'enemy';
}

/** 速攻：辅助技能，不消耗行动，每回合最多一次 */
export function isQuick(skill) {
    return !!skill.quick && skill.kind === 'support';
}

function healOnly(skill) {
    return skill.kind === 'support' && skill.effects?.length > 0 && skill.effects.every(e => e.type === 'heal' || e.type === 'heal_pct');
}

// ---------------------------------------------------------------- 伤害计算

function roll(rules, rng) {
    const v = Math.max(0, Number(rules.variance) || 0);
    if (!v) return 1;
    return 1 + ((rng() * 2 - 1) * v) / 100;
}

/**
 * @param {'physical'|'magical'} kind
 * @param {number} power 百分比
 * @param {boolean} expected 为 true 时不计算随机浮动（用于预览和 AI）
 */
export function calcDamage(b, attacker, defender, kind, power, rules, rng = Math.random, expected = false) {
    const atk = stat(attacker, kind === 'magical' ? 'matk' : 'atk') * (power / 100);
    const def = stat(defender, kind === 'magical' ? 'mdef' : 'def');
    let dmg;
    if (rules.formula === 'diminishing') {
        // 防御只影响减伤比例；技能倍率线性作用于最终伤害。
        const scale = Math.max(1, Number(rules.defenseScale) || 12);
        dmg = Math.max(0, atk) * scale / (scale + Math.max(0, def));
    } else if (rules.formula === 'ratio') {
        dmg = atk <= 0 ? 0 : (atk * atk) / (atk + Math.max(0, def));
    } else {
        dmg = atk - def;
    }
    dmg *= matchup(b, attacker, defender).dmg / 100;
    const t = terrainAt(b, defender.x, defender.y);
    dmg *= 1 - (Number(t.defBonus) || 0) / 100;
    if (!expected) dmg *= roll(rules, rng);
    return Math.max(Number(rules.minDamage ?? 1), Math.round(dmg));
}

export function calcHeal(caster, target, power, rules, rng = Math.random, expected = false) {
    let v = stat(caster, 'matk') * (power / 100);
    if (!expected) v *= roll(rules, rng);
    v = Math.max(1, Math.round(v));
    return Math.min(v, target.maxHp - target.hp);
}

/**
 * 命中率（0–100）：基础命中 + (攻方AGI − 守方AGI) × 系数 + 修正 − 守方地形闪避。
 * 对友方的行动、对建筑物的攻击、关闭命中系统时，必定命中。
 */
export function hitChance(b, attacker, defender, rules, mod = 0) {
    if (rules.hitEnabled === false || defender.object || !isFoe(attacker, defender)) return 100;
    const base = Number(rules.baseHit ?? 90);
    const k = Number(rules.agiFactor ?? 3);
    const avoid = Number(terrainAt(b, defender.x, defender.y).avoid) || 0;
    const v = base + (stat(attacker, 'agi') - stat(defender, 'agi')) * k + (Number(mod) || 0) + matchup(b, attacker, defender).hit - avoid;
    return Math.max(0, Math.min(100, Math.round(v)));
}

/** 技能对某个目标的命中率 */
export function skillHitChance(b, unit, skill, t, rules) {
    if (skill.sureHit || !isFoe(unit, t)) return 100;
    return hitChance(b, unit, t, rules, skill.hitMod);
}

function rollHit(chance, rng) {
    return chance >= 100 || (chance > 0 && rng() * 100 < chance);
}

function applyDamage(u, dmg) {
    const before = u.hp;
    u.hp = Math.max(0, u.hp - dmg);
    return { hpBefore: before, hpAfter: u.hp, killed: before > 0 && u.hp === 0 };
}

function ref(u) {
    const alias = String(u.aliases || '').split(/[,，、]/).map(x => x.trim()).find(Boolean) || '';
    return { uid: u.uid, name: u.name, side: u.side, alias, wbKey: u.wb?.keys?.[0] || '', object: !!u.object, keyTarget: !!u.keyTarget };
}

// ---------------------------------------------------------------- 对空
// 战斗规则 airTarget＝antiAir 时（同步为战场的 b.airRule），飞行单位只能被「对空」的普通攻击 / 技能或其他飞行单位打到。

export const AIR_RULES = { all: '可以被任何攻击打到', antiAir: '只能被对空攻击或飞行单位打到' };

/** 这次攻击（skill 为空＝普通攻击 / 反击）能否打到目标 */
export function canHit(b, attacker, target, skill = null) {
    if (!b?.airRule || !target?.flying || attacker?.flying) return true;
    return !!(skill ? skill.antiAir : attacker?.antiAir);
}

/** 单位有没有任何办法打到目标（用于 AI 选择追击对象） */
export function canEverHit(b, unit, target) {
    return canHit(b, unit, target) || (unit.skills || []).some(sk => sk.kind !== 'support' && canHit(b, unit, target, sk));
}

export function canCounter(b, defender, attacker) {
    if (defender.hp <= 0 || defender.object || defender.noCounter || isStunned(defender)) return false;
    if (!canHit(b, defender, attacker)) return false;
    const d = dist(defender.x, defender.y, attacker.x, attacker.y);
    return d >= defender.rangeMin && d <= defender.rangeMax;
}

// ---------------------------------------------------------------- 韧性
// 防御或反击各消耗 1 点；耗尽后只能承受伤害。在己方阶段开始时回满。

export const DEFAULT_TOUGH = 2;

export function toughMax(u) {
    if (u.object) return 0;
    const n = Number(u.toughMax);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : DEFAULT_TOUGH; // 旧战斗中的单位没有韧性字段
}

export function toughLeft(u) {
    const n = Number(u.tough);
    return Math.min(toughMax(u), Number.isFinite(n) ? Math.max(0, Math.floor(n)) : toughMax(u));
}

export const TOUGH_MODES = { all: '所有单位', player: '仅我方角色', off: '关闭' };

/** 韧性系统是否作用于该单位：rules.toughness = all（默认）/ player（仅我方）/ off */
export function toughApplies(u, rules) {
    if (u.object) return false;
    const mode = rules?.toughness || 'all';
    return mode === 'all' || (mode === 'player' && u.side === 'player');
}

/** 是否还能防御或反击（不受韧性系统约束的单位不限次数） */
export function canBrace(u, rules) {
    if (u.object) return false;
    return !toughApplies(u, rules) || toughLeft(u) > 0;
}

// ---------------------------------------------------------------- 行动

/** 地形伤害不受防御减免，可致死；飞行单位默认免疫。 */
export function terrainDamage(b, unit, timing = 'enter') {
    const t = terrainAt(b, unit.x, unit.y);
    if (unit.hp <= 0 || unit.object || (unit.flying && !t.damageFlying)) return null;
    const fixed = Math.max(0, Number(t[`${timing}Damage`]) || 0);
    const pct = Math.max(0, Number(t[`${timing}DamagePct`]) || 0);
    const amount = Math.floor(fixed) + (pct > 0 ? Math.max(1, Math.round(unit.maxHp * pct / 100)) : 0);
    if (!amount) return null;
    const before = unit.hp;
    unit.hp = Math.max(0, unit.hp - amount);
    if (!unit.hp) unit.acted = true;
    return fogTag(b, unit, { type: 'terrainDamage', turn: b.turn, actor: ref(unit), timing, terrain: t.name, damage: before - unit.hp, hpBefore: before, hpAfter: unit.hp, killed: !unit.hp });
}

/**
 * 移动。fogView：按玩家看到的局面寻路（战争迷雾中），途中撞上看不见的敌人时遭遇伏击，
 * 停在前一个能停留的格子，伏击者暴露。
 */
export function doMove(b, unit, x, y, { fogView = false } = {}) {
    const fog = fogView && fogOn(b, team(unit));
    const reach = reachable(b, unit, stat(unit, 'mov'), true, fog);
    const node = reach.get(`${x},${y}`);
    const occ = unitAt(b, x, y);
    if (!node || (occ && occ !== unit && !(fog && isFoe(occ, unit) && !visibleTo(b, team(unit), occ)))) throw new Error('无法移动到该位置');
    const from = { x: unit.x, y: unit.y };
    let path = [];
    for (let step = node; step; step = step.prev ? reach.get(step.prev) : null) path.unshift({ x: step.x, y: step.y });
    let ambush = null;
    if (fog) {
        const blocker = path.findIndex((p, i) => i > 0 && unitAt(b, p.x, p.y) && isFoe(unitAt(b, p.x, p.y), unit));
        if (blocker > 0) {
            ambush = unitAt(b, path[blocker].x, path[blocker].y);
            let stop = blocker - 1; // 可以穿过但不能停在友军格子上
            while (stop > 0 && unitAt(b, path[stop].x, path[stop].y)) stop--;
            path = path.slice(0, stop + 1);
            ({ x, y } = path.at(-1));
            ambush.revealed = true;
        }
    }
    const hidBefore = hiddenFromPlayer(b, unit);
    unit.x = x; unit.y = y;
    unit.moved = true;
    if (from.x === x && from.y === y && !ambush) return null;
    const hidAfter = hiddenFromPlayer(b, unit);
    return {
        type: 'move', turn: b.turn, actor: ref(unit),
        from, to: { x, y }, path,
        terrain: terrainAt(b, x, y).name,
        fromTerrain: terrainAt(b, from.x, from.y).name,
        ...(ambush ? { ambush: ref(ambush) } : {}),
        ...(hidBefore && hidAfter ? { fog: true } : hidBefore ? { fogIn: true } : hidAfter ? { fogOut: true } : {}),
        terrainDamage: from.x === x && from.y === y ? null : terrainDamage(b, unit),
    };
}

export function attackTargets(b, unit, fromX = unit.x, fromY = unit.y) {
    const forced = taunters(b, unit);
    return alive(b).filter(t => {
        if (!isFoe(t, unit) || (forced.length && !forced.includes(t))) return false;
        if (!visibleTo(b, team(unit), t)) return false; // 战争迷雾：只能攻击看得见的敌人
        if (!canHit(b, unit, t)) return false; // 对空规则：普通攻击打不到飞行单位
        const d = dist(fromX, fromY, t.x, t.y);
        return d >= unit.rangeMin && d <= unit.rangeMax;
    });
}

export function defenseDamage(damage, rules) {
    const reduction = Math.max(0, Math.min(100, Number(rules.defenseReduction ?? 50)));
    return Math.max(Number(rules.minDamage ?? 1), Math.round(damage * (1 - reduction / 100)));
}

export function canRespond(b, attacker, defender, rules, skill = null, covering = false) {
    if (covering) return false; // 援护者不反击
    if (!isFoe(attacker, defender) || !canBrace(defender, rules) || !canCounter(b, defender, attacker)) return false;
    if (skill && (skill.kind === 'support' || ['mapLine', 'mapArea'].includes(skill.attackMode))) return false;
    return !!rules.counter || (!skill && attacker.attackOrder === 'last' && defender.attackOrder !== 'last');
}

export function defaultReaction(b, attacker, defender, rules, skill = null, covering = false) {
    if (defender.object || !isFoe(attacker, defender) || !canBrace(defender, rules)) return 'none';
    if (canRespond(b, attacker, defender, rules, skill, covering)) return 'counter';
    // 不受韧性系统约束的 AI 单位只在能反击时反击，不会防御（援护时总是防御）
    return covering || toughApplies(defender, rules) || defender.side === 'player' ? 'defend' : 'none';
}

/**
 * 援护：攻击单体目标时，替它承受的单位。单体援护（目标身上的「援护」）优先，其次是范围援护中离目标最近的单位。
 * MAP、范围技能和辅助技能不会被援护。返回 { unit, status? } 或 null。
 */
export function coverFor(b, attacker, target, skill = null) {
    if (!isFoe(attacker, target) || target.hp <= 0) return null;
    if (skill && (skill.kind === 'support' || ['mapLine', 'mapArea'].includes(skill.attackMode) || Number(skill.radius) > 0)) return null;
    const able = p => p && p !== target && p !== attacker && p.hp > 0 && !p.retreated && !p.object && !isStunned(p) && isFoe(attacker, p) && canHit(b, attacker, p, skill);
    const single = (target.statuses || []).find(s => s.type === 'cover' && able(getUnit(b, s.by)));
    if (single) return { unit: getUnit(b, single.by), status: single };
    const guards = alive(b).filter(p => able(p) && team(p) === team(target)
        && (p.statuses || []).some(s => s.type === 'cover_area' && dist(p.x, p.y, target.x, target.y) <= Math.max(0, Number(s.value) || 0)));
    guards.sort((p, q) => dist(p.x, p.y, target.x, target.y) - dist(q.x, q.y, target.x, target.y));
    return guards.length ? { unit: guards[0] } : null;
}

/**
 * 结算前校正受击反应并扣除韧性：没有韧性只能承受（exhausted）；无法反击时的「反击」视为承受。
 * 必须在扣血前调用，返回 { reaction, exhausted?, tough? }。
 */
function useReaction(b, attacker, defender, rules, reaction, skill = null, covering = false) {
    if (defender.object || !isFoe(attacker, defender)) return { reaction: 'none' };
    if (!canBrace(defender, rules)) return { reaction: 'none', exhausted: true };
    if (reaction === 'none') return toughApplies(defender, rules) ? { reaction: 'none', endured: true } : { reaction: 'none' }; // 主动承受：不防御不反击，保留韧性
    if (!['counter', 'defend'].includes(reaction)) return { reaction: 'none' };
    if (reaction === 'counter' && covering) reaction = 'defend'; // 援护者不反击，按防御处理
    if (reaction === 'counter' && !canRespond(b, attacker, defender, rules, skill)) return { reaction: 'none' };
    if (!toughApplies(defender, rules)) return { reaction };
    // 兵种克制可以让一次招架消耗多点韧性（或不消耗）
    const before = toughLeft(defender);
    defender.tough = Math.max(0, before - matchup(b, attacker, defender).tough);
    return { reaction, tough: [before, defender.tough] };
}

export function previewAttack(b, unit, target, rules, reaction = 'counter') {
    let dmg = calcDamage(b, unit, target, unit.atkType, 100, rules, Math.random, true);
    if (reaction === 'defend' && !target.object) dmg = defenseDamage(dmg, rules);
    const hit = hitChance(b, unit, target, rules);
    let counter = 0, counterHit = 0;
    const firstStrike = reaction === 'counter' && unit.attackOrder === 'last' && target.attackOrder !== 'last' && canCounter(b, target, unit);
    const responds = reaction === 'counter' && (rules.counter || firstStrike) && canCounter(b, target, unit);
    if (responds) {
        counter = calcDamage(b, target, unit, target.atkType, 100, rules, Math.random, true);
        counterHit = hitChance(b, target, unit, rules);
    }
    const canSurviveFirst = firstStrike && counter >= unit.hp ? 1 - counterHit / 100 : 1;
    const canSurviveAttack = !firstStrike && dmg >= target.hp ? 1 - hit / 100 : 1;
    return { damage: dmg, hit, counter, counterHit, firstStrike, responds, expectedDamage: dmg * hit / 100 * canSurviveFirst, expectedCounter: counter * counterHit / 100 * canSurviveAttack };
}

function strike(b, attacker, defender, kind, power, chance, rules, rng, defending = false) {
    if (!rollHit(chance, rng)) return { hit: false, hitRate: chance, damage: 0, hpBefore: defender.hp, hpAfter: defender.hp, killed: false };
    const raw = calcDamage(b, attacker, defender, kind, power, rules, rng);
    const damage = defending && !defender.object ? defenseDamage(raw, rules) : raw;
    return { hit: true, hitRate: chance, damage, ...applyDamage(defender, damage) };
}

export function doAttack(b, unit, target, rules, rng = Math.random, reaction = 'counter') {
    if (unit.hp <= 0 || unit.retreated) throw new Error('单位已倒下或离场，无法攻击');
    const d = dist(unit.x, unit.y, target.x, target.y);
    if (!isFoe(unit, target) || target.hp <= 0 || target.retreated || d < unit.rangeMin || d > unit.rangeMax) {
        throw new Error('目标不在攻击范围内');
    }
    const forced = taunters(b, unit);
    if (forced.length && !forced.includes(target)) throw new Error(`被嘲讽，只能攻击${forced.map(t => t.name).join('、')}`);
    if (!canHit(b, unit, target)) throw new Error(`${unit.name}的普通攻击不能对空，打不到飞行单位`);
    // 援护：由援护者承受（命中、伤害、反应都按援护者计算），单体援护用掉即消失
    const cover = coverFor(b, unit, target);
    if (cover?.status) target.statuses = target.statuses.filter(s => s !== cover.status);
    const covered = target;
    if (cover) target = cover.unit;
    reveal(b, unit, target);
    const edge = matchup(b, unit, target);
    const used = useReaction(b, unit, target, rules, reaction, null, !!cover);
    reaction = used.reaction;
    const first = reaction === 'counter' && unit.attackOrder === 'last' && target.attackOrder !== 'last' && canCounter(b, target, unit)
        ? { atkType: target.atkType, ...strike(b, target, unit, target.atkType, 100, hitChance(b, target, unit, rules), rules, rng) } : null;
    const ev = {
        type: 'attack', turn: b.turn, actor: ref(unit), target: ref(target),
        ...(cover ? { coveredFor: ref(covered) } : {}),
        ...(isNeutralMatchup(edge) ? {} : { matchup: edge }),
        atkType: unit.atkType,
        ...(unit.hp > 0 ? strike(b, unit, target, unit.atkType, 100, hitChance(b, unit, target, rules), rules, rng, reaction === 'defend') : { hit: false, damage: 0, hpBefore: target.hp, hpAfter: target.hp, killed: false }),
        terrain: terrainAt(b, target.x, target.y).name,
        counter: null,
        firstStrike: first,
        cancelled: !!first && unit.hp <= 0,
        reaction,
        ...(used.exhausted ? { exhausted: true } : {}),
        ...(used.endured ? { endured: true } : {}),
        ...(used.tough ? { tough: used.tough } : {}),
    };
    if (reaction === 'counter' && !first && rules.counter && canCounter(b, target, unit)) {
        ev.counter = { atkType: target.atkType, ...strike(b, target, unit, target.atkType, 100, hitChance(b, target, unit, rules), rules, rng) };
    }
    endAction(b, unit);
    return ev;
}

/** 以 (tx,ty) 为目标时会受到技能影响的单位 */
export function skillAreaTiles(b, unit, skill, tx, ty) {
    if (skill.attackMode === 'mapLine') {
        const dx = Math.sign(tx - unit.x), dy = Math.sign(ty - unit.y);
        if ((!dx && !dy) || (dx && dy)) return [];
        const out = [];
        const length = Math.max(1, Math.min(100, Math.floor(Number(skill.lineLength) || 3)));
        for (let n = 1; n <= length; n++) {
            const x = unit.x + dx * n, y = unit.y + dy * n;
            if (!inBounds(b, x, y)) break;
            out.push([x, y]);
        }
        return out;
    }
    return tilesInRange(b, tx, ty, 0, skill.attackMode === 'mapArea' ? Math.max(1, Number(skill.radius) || 1) : Math.max(0, Number(skill.radius) || 0));
}

export function skillAffected(b, unit, skill, tx, ty) {
    const side = skillTargetSide(skill);
    if (side === 'self' || side === 'tile') return unit.hp > 0 ? [unit] : [];
    const area = new Set(skillAreaTiles(b, unit, skill, tx, ty).map(([x, y]) => `${x},${y}`));
    const hostile = skill.kind !== 'support' || side === 'enemy';
    return alive(b).filter(t => {
        if (!area.has(`${t.x},${t.y}`)) return false;
        if (hostile && !canHit(b, unit, t, skill)) return false; // 对空规则：不能对空的技能打不到飞行单位（包括误伤）
        if (skill.attackMode === 'mapLine' || skill.attackMode === 'mapArea') return t.uid !== unit.uid && (skill.mapTargets !== 'enemy' || isFoe(t, unit));
        return side === 'ally' ? !isFoe(t, unit) : isFoe(t, unit);
    });
}

export function skillTargetTiles(b, unit, skill, fromX = unit.x, fromY = unit.y) {
    const side = skillTargetSide(skill);
    if (side === 'self') return [[fromX, fromY]];
    if (side === 'tile') {
        // 传送：射程内能站立的空地
        return tilesInRange(b, fromX, fromY, Math.max(1, Number(skill.rangeMin) || 0), Number(skill.rangeMax) || 0)
            .filter(([x, y]) => !unitAt(b, x, y) && isFinite(enterCost(b, unit, x, y)));
    }
    const forced = side === 'enemy' ? taunters(b, unit) : [];
    const mapLine = skill.attackMode === 'mapLine';
    const tiles = mapLine ? DIRS.flatMap(([dx, dy]) => {
        const origin = { ...unit, x: fromX, y: fromY };
        return skillAreaTiles(b, origin, skill, fromX + dx, fromY + dy);
    }) : tilesInRange(b, fromX, fromY, Number(skill.rangeMin) || 0, Number(skill.rangeMax) || 0);
    return tiles
        .filter(([x, y]) => {
            // 战争迷雾：单体技能只能指定看得见的敌人；范围 / MAP 可以朝迷雾里打
            const aff = skillAffected(b, { ...unit, x: fromX, y: fromY }, skill, x, y).filter(t => visibleTo(b, team(unit), t));
            if (forced.length) return aff.some(t => forced.includes(t));
            if (mapLine || skill.attackMode === 'mapArea') return true;
            if ((Number(skill.radius) || 0) > 0) return true;
            // 只有治疗效果的单体技能，只能对受伤的友方使用
            return healOnly(skill) ? aff.some(t => t.hp < t.maxHp) : aff.length > 0;
        });
}

/** 对目标施加技能附带的效果，返回结果描述 */
/** 召回：施法者身边离目标最近、目标能站立的空格 */
function recallTile(b, caster, t) {
    for (let r = 1; r <= 3; r++) {
        const free = tilesInRange(b, caster.x, caster.y, r, r)
            .filter(([x, y]) => (!unitAt(b, x, y) || unitAt(b, x, y) === t) && isFinite(enterCost(b, t, x, y)))
            .sort((p, q) => dist(p[0], p[1], t.x, t.y) - dist(q[0], q[1], t.x, t.y));
        if (free.length) return free[0];
    }
    return null;
}

function applyEffects(b, caster, t, effects, rules, rng) {
    const out = [];
    t.statuses ||= [];
    for (const e of effects || []) {
        const def = EFFECTS[e.type];
        if (!def) continue;
        const value = Number(e.value) || 0;
        if (e.type === 'refresh') {
            const why = t.object ? '建筑无法行动' : t.side !== b.phase ? '不是该阵营的行动阶段'
                : t.boostTurn === b.turn ? '本回合已获得过额外行动' : '';
            // 已行动：立即恢复行动；尚未行动（含施法者自己）：下一次行动结束后再行动一次
            const now = !why && t.acted && t !== caster;
            if (!why) {
                t.boostTurn = b.turn;
                if (now) { t.acted = false; t.moved = false; t.againTurn = b.turn; }
                else { t.extraTurn = b.turn; t.extraLeft = 1; }
            }
            out.push({ type: e.type, label: def.name, ...(why ? { failed: why } : { now }) });
            continue;
        }
        if (e.type === 'recall') {
            const to = t.object || t === caster ? null : recallTile(b, caster, t);
            if (!to || (to[0] === t.x && to[1] === t.y)) { out.push({ type: e.type, label: def.name, failed: t.object ? '建筑无法移动' : t === caster ? '对自身无效' : to ? '已在身边' : '身边没有空位' }); continue; }
            const from = { x: t.x, y: t.y };
            t.x = to[0]; t.y = to[1];
            out.push({ type: e.type, label: def.name, from, to: { x: t.x, y: t.y }, terrain: terrainAt(b, t.x, t.y).name, terrainDamage: terrainDamage(b, t) });
            continue;
        }
        if (e.type === 'cover') {
            if (t === caster) { out.push({ type: e.type, label: def.name, failed: '不能援护自己' }); continue; }
            const turns = Math.max(1, Number(e.turns) || 1);
            t.statuses = t.statuses.filter(x => x.type !== 'cover');
            t.statuses.push({ type: 'cover', value: 0, turns, srcSide: caster.side, by: caster.uid, byName: caster.name });
            out.push({ type: e.type, label: `受${caster.name}援护`, turns });
            continue;
        }
        if (e.type === 'cover_area') {
            // 范围援护以施法者为中心，由施法者承受；技能选中的是友军时也挂在施法者身上
            const turns = Math.max(1, Number(e.turns) || 1);
            caster.statuses ||= [];
            caster.statuses = caster.statuses.filter(x => x.type !== 'cover_area');
            caster.statuses.push({ type: 'cover_area', value, turns, srcSide: caster.side });
            out.push({ type: e.type, label: effectLabel({ type: e.type, value }), turns, holder: caster.name, value });
            continue;
        }
        if (e.type === 'heal' || e.type === 'heal_pct') {
            const amount = e.type === 'heal'
                ? calcHeal(caster, t, value, rules, rng)
                : Math.min(t.maxHp - t.hp, Math.max(1, Math.round(t.maxHp * value / 100)));
            t.hp += amount;
            out.push({ type: e.type, label: def.name, heal: amount });
        } else if (e.type === 'cleanse') {
            const removed = t.statuses.filter(x => EFFECTS[x.type]?.debuff);
            t.statuses = t.statuses.filter(x => !EFFECTS[x.type]?.debuff);
            out.push({ type: e.type, label: def.name, removed: removed.map(effectLabel) });
        } else {
            const turns = Math.max(1, Number(e.turns) || 1);
            t.statuses = t.statuses.filter(x => x.type !== e.type); // 同类效果刷新
            t.statuses.push({ type: e.type, value, turns, srcSide: caster.side });
            out.push({ type: e.type, label: effectLabel({ type: e.type, value }), turns, debuff: !!def.debuff });
        }
    }
    return out;
}

export function doSkill(b, unit, skill, tx, ty, rules, rng = Math.random, responses = {}) {
    if (!skillUsable(skill)) throw new Error(skill.cdLeft > 0 ? '技能冷却中' : '技能次数已用尽');
    const side = skillTargetSide(skill);
    if (side === 'self') {
        tx = unit.x; ty = unit.y;
    } else if (!skillTargetTiles(b, unit, skill).some(([x, y]) => x === tx && y === ty)) {
        throw new Error('目标不在技能范围内');
    }
    let teleport = null;
    if (side === 'tile') {
        // 传送不经过路径、无视移动消耗，但会受到落脚地形伤害
        teleport = { from: { x: unit.x, y: unit.y }, to: { x: tx, y: ty }, terrain: terrainAt(b, tx, ty).name };
        unit.x = tx; unit.y = ty;
        teleport.terrainDamage = terrainDamage(b, unit);
    }
    const targets = skillAffected(b, unit, skill, tx, ty);
    // 战争迷雾中朝看不清的区域施放范围技能时，没有目标也照常消耗（不泄露迷雾中有没有人）
    const blind = fogOn(b, team(unit)) && Number(skill.radius) > 0 && side === 'enemy';
    if (!targets.length && !['mapLine', 'mapArea'].includes(skill.attackMode) && !teleport && !blind) throw new Error('该位置没有可作用的目标');
    // 只在己方之间使用的辅助技能不会暴露位置；看不见时不告诉玩家
    const hostile = skill.kind !== 'support' || side === 'enemy';
    const unseen = !hostile && hiddenFromPlayer(b, unit) && targets.every(t => hiddenFromPlayer(b, t));
    // 单体伤害技能可以被援护：改由援护者承受
    const covers = new Map();
    const affected = targets.map(t => {
        const cover = coverFor(b, unit, t, skill);
        if (!cover) return t;
        if (cover.status) t.statuses = t.statuses.filter(s => s !== cover.status);
        covers.set(cover.unit.uid, t);
        return cover.unit;
    });
    // 受击反应先于命中判定确定，未命中也已消耗韧性
    // 未提供反应视为无反应；明确传入 'none' 才算主动承受
    const used = Object.fromEntries(affected.map(t => [t.uid, skill.kind === 'support' ? { reaction: 'none' } : useReaction(b, unit, t, rules, responses[t.uid] || 'unset', skill, covers.has(t.uid))]));
    const results = affected.map(t => {
        const r = { target: ref(t), hpBefore: t.hp, terrain: terrainAt(b, t.x, t.y).name, killed: false };
        if (hostile && isFoe(unit, t)) reveal(b, unit, t);
        const edge = skill.kind !== 'support' && isFoe(unit, t) ? matchup(b, unit, t) : null;
        if (!isNeutralMatchup(edge)) r.matchup = edge;
        if (used[t.uid].exhausted) r.exhausted = true;
        if (used[t.uid].endured) r.endured = true;
        if (covers.has(t.uid)) r.coveredFor = ref(covers.get(t.uid));
        if (used[t.uid].tough) r.tough = used[t.uid].tough;
        const chance = skillHitChance(b, unit, skill, t, rules);
        if (!rollHit(chance, rng)) {
            Object.assign(r, { missed: true, hitRate: chance, hpAfter: t.hp });
            return r;
        }
        if (skill.kind !== 'support') {
            r.damage = calcDamage(b, unit, t, skill.kind, skill.power, rules, rng);
            r.reaction = used[t.uid].reaction;
            if (r.reaction === 'defend' && !t.object) r.damage = defenseDamage(r.damage, rules);
            r.killed = applyDamage(t, r.damage).killed;
        }
        if (t.hp > 0) {
            r.effects = applyEffects(b, unit, t, skill.effects, rules, rng);
            const healed = r.effects.reduce((n, e) => n + (e.heal || 0), 0);
            if (r.effects.some(e => e.heal != null)) r.heal = healed;
        }
        r.hpAfter = t.hp;
        return r;
    });
    for (let i = 0; i < affected.length && unit.hp > 0; i++) {
        const target = affected[i];
        // 反击已在 useReaction 中确认并扣除韧性，这里只检查目标是否还能出手
        if (used[target.uid].reaction === 'counter' && canCounter(b, target, unit)) {
            results[i].counter = { atkType: target.atkType, ...strike(b, target, unit, target.atkType, 100, hitChance(b, target, unit, rules), rules, rng) };
        }
    }
    if (skill.uses) skill.usesLeft = Math.max(0, (skill.usesLeft ?? skill.uses) - 1);
    const quick = isQuick(skill);
    // 速攻每回合最多一次：冷却至少 1（己方阶段开始时归零）
    if (Number(skill.cooldown) > 0 || quick) skill.cdLeft = Math.max(Number(skill.cooldown) || 0, quick ? 1 : 0);
    if (!quick) endAction(b, unit);
    return {
        type: 'skill', turn: b.turn, actor: ref(unit),
        skill: { name: skill.name, kind: skill.kind, target: side, desc: skill.desc || '', attackMode: skill.attackMode, mapTargets: skill.mapTargets, ...(quick ? { quick: true } : {}) },
        area: skillAreaTiles(b, unit, skill, tx, ty),
        at: { x: tx, y: ty }, results,
        ...(teleport ? { teleport } : {}),
        ...(unseen ? { fog: true } : {}),
    };
}

/** 本回合还剩几次额外行动 */
export function extraActions(b, u) {
    return u.extraTurn === b.turn ? Math.max(0, Number(u.extraLeft) || 0) : 0;
}

/** 结束一次行动：有额外行动时消耗它并恢复为未行动（可再移动），否则标记已行动 */
export function endAction(b, unit) {
    if (unit.hp > 0 && extraActions(b, unit) > 0) {
        unit.extraLeft -= 1;
        unit.acted = false; unit.moved = false; unit.againTurn = b.turn;
        return true;
    }
    unit.acted = true; unit.moved = true;
    return false;
}

export function doWait(b, unit) {
    endAction(b, unit);
    return fogTag(b, unit, { type: 'wait', turn: b.turn, actor: ref(unit), terrain: terrainAt(b, unit.x, unit.y).name });
}

// ---------------------------------------------------------------- 任务与胜负

export const MISSION_NAMES = { annihilate: '歼灭战', defend: '守城战', assault: '进攻战' };

export function missionOf(b) {
    return b.mission || { type: 'annihilate', turns: 0 };
}

/** 守城战中需要保护的目标：我方 / 友军的关键目标 */
export function guardTargets(b) {
    return b.units.filter(u => u.keyTarget && team(u) === 'P');
}

/** 守城战中被摧毁几个守卫目标即失败（默认 1；超过目标数量时按全部被摧毁计） */
export function defendLossLimit(b) {
    const total = guardTargets(b).length;
    const n = Math.max(1, Math.floor(Number(missionOf(b).lossLimit) || 1));
    return total ? Math.min(n, total) : n;
}

/** 进攻战中需要破坏的目标：敌方的关键目标 */
export function enemyKeyTargets(b) {
    return b.units.filter(u => u.keyTarget && u.side === 'enemy');
}

/** 某个增援波次下一次出现的回合（null 表示不再出现） */
export function nextWaveTurn(b, w) {
    const fired = b.reinfFired?.[w.id] || 0;
    const every = Math.max(0, Number(w.every) || 0);
    const times = Math.max(0, Number(w.times) || 0);
    const start = Math.max(1, Number(w.startTurn) || 1);
    if (every === 0 && fired > 0) return null;
    if (every > 0 && times > 0 && fired >= times) return null;
    return Math.max(b.turn, start + fired * every);
}

export function wavesRemaining(b, side = 'enemy') {
    return (b.reinforcements || []).some(w => w.side === side && nextWaveTurn(b, w) != null);
}

/** @returns {{result:'victory'|'defeat', reason:string}|null} */
export function checkResult(b) {
    const m = missionOf(b);
    const units = alive(b);
    if (!units.some(u => u.side === 'player' && !u.object)) return { result: 'defeat', reason: '我方全军覆没' };
    if (m.type === 'defend') {
        const guards = guardTargets(b);
        const lost = guards.filter(u => u.hp <= 0);
        const limit = defendLossLimit(b);
        if (lost.length && lost.length >= limit) {
            const names = lost.map(u => `「${u.name}」`).join('');
            return { result: 'defeat', reason: guards.length > 1 ? `守卫目标${names}被摧毁（${lost.length}/${guards.length}，达到失败条件）` : `守卫目标${names}被摧毁` };
        }
    }
    if (m.type === 'assault') {
        const keys = enemyKeyTargets(b);
        if (keys.length && keys.every(u => u.hp <= 0)) {
            return { result: 'victory', reason: `敌方关键目标${keys.map(k => `「${k.name}」`).join('')}已全部被摧毁` };
        }
    } else if (!units.some(u => u.side === 'enemy' && !u.object) && !wavesRemaining(b)) {
        return { result: 'victory', reason: '所有敌人都被击败' };
    }
    return null;
}

/** 回合结束时的回合数判定 */
function checkTurnLimit(b) {
    const m = missionOf(b);
    const n = Number(m.turns) || 0;
    if (!n || b.turn < n) return null;
    if (m.type === 'defend') return { result: 'victory', reason: `成功坚守了 ${n} 回合` };
    return { result: 'defeat', reason: `未能在 ${n} 回合内${m.type === 'assault' ? '摧毁关键目标' : '歼灭敌人'}` };
}

function setResult(b, r, events) {
    if (!r || b.result) return;
    b.result = r.result;
    b.resultReason = r.reason;
    events.push({ type: 'result', turn: b.turn, result: r.result, reason: r.reason });
}

function finish(b, events) {
    setResult(b, checkResult(b), events);
    updateIntel(b);
    return b.result;
}

/** 包装玩家行动：执行后自动检测胜负 */
export function commit(b, ev) {
    const events = ev ? [ev] : [];
    finish(b, events);
    return events;
}

// ---------------------------------------------------------------- AI

/** AI 对“给 t 施加效果 e”的估值 */
function effectScore(b, caster, t, e, rules) {
    const def = EFFECTS[e.type];
    if (!def) return 0;
    const v = Number(e.value) || 0;
    const missing = t.maxHp - t.hp;
    switch (e.type) {
        case 'refresh':
            return !t.object && t.side === b.phase && t.boostTurn !== b.turn && !isStunned(t)
                && alive(b).some(f => isFoe(f, t) && !f.object) ? 15 : 0;
        case 'recall':
            return 0; // 召回由玩家或 LLM 指挥官决定，内置 AI 不主动使用
        case 'cover': {
            // 替更脆弱、又可能被攻击的同伴挡刀
            const near = alive(b).some(f => isFoe(f, t) && !f.object && dist(f.x, f.y, t.x, t.y) <= stat(f, 'mov') + f.rangeMax + 1);
            return t !== caster && near && caster.hp > t.hp && t.hp / t.maxHp < 0.7 ? 9 : 0;
        }
        case 'cover_area': {
            // 总是挂在施法者身上，按施法者周围受威胁的友军估值
            if (t !== caster || hasStatus(caster, 'cover_area') || caster.hp / caster.maxHp < 0.5) return 0;
            const r = Math.max(0, v);
            const guarded = alive(b).filter(a => a !== caster && team(a) === team(caster) && dist(a.x, a.y, caster.x, caster.y) <= r
                && alive(b).some(f => isFoe(f, a) && !f.object && dist(f.x, f.y, a.x, a.y) <= stat(f, 'mov') + f.rangeMax + 1)).length;
            return Math.min(16, guarded * 4);
        }
        case 'heal':
            return missing / t.maxHp < 0.3 ? 0 : Math.min(missing, calcHeal(caster, t, v, rules, Math.random, true));
        case 'heal_pct':
            return missing / t.maxHp < 0.3 ? 0 : Math.min(missing, Math.round(t.maxHp * v / 100));
        case 'cleanse':
            return 8 * (t.statuses || []).filter(x => EFFECTS[x.type]?.debuff).length;
    }
    if (hasStatus(t, e.type)) return 0;
    if (e.type === 'stun') return 18;
    if (e.type === 'reveal') return fogOn(b, team(caster)) ? 5 : 0;
    if (e.type === 'vision_up' || e.type === 'vision_down') return fogOn(b, e.type === 'vision_up' ? team(t) : team(caster)) ? 4 : 0;
    const foeNear = alive(b).some(f => isFoe(f, t) && !f.object && dist(f.x, f.y, t.x, t.y) <= stat(f, 'mov') + f.rangeMax + 1);
    if (e.type === 'taunt') return foeNear && t.hp / t.maxHp >= 0.5 && !t.object ? 10 : 0;
    if (e.type === 'regen') return missing > 0 ? 5 : 0;
    if (def.debuff) return 6;
    return foeNear ? 7 : 2;
}

/**
 * 在 (x,y) 位置能做出的所有行动及估值
 * @param {(t:object)=>boolean} filter 攻击类行动必须命中至少一个满足条件的目标
 * @param {'attack'|'support'|'quick'} mode attack：普通攻击与伤害技能；support：辅助技能（不含速攻）；quick：速攻辅助技能
 */
function candidatesAt(b, unit, x, y, rules, filter, mode) {
    const ox = unit.x, oy = unit.y;
    unit.x = x; unit.y = y;
    const preferred = attractionTargets(b, unit);
    const list = [];
    const consider = (cand) => { if (cand.score > 0) list.push(cand); };
    if (mode === 'attack') {
        for (const t of attackTargets(b, unit).filter(filter)) {
            const preview = previewAttack(b, unit, t, rules, defaultReaction(b, unit, t, rules));
            const dmg = preview.damage;
            const hit = preview.hit / 100;
            if (!hit) continue; // 不会去打完全打不中的目标
            let score = 1 + (Math.min(dmg, t.hp) + (dmg >= t.hp ? 100 : 0)) * hit;
            if (preview.counter) {
                const survive = preview.firstStrike ? 1 : dmg >= t.hp ? 1 - hit : 1;
                score -= calcDamage(b, t, unit, t.atkType, 100, rules, Math.random, true) * (hitChance(b, t, unit, rules) / 100) * survive * 0.3;
                if (preview.firstStrike && preview.counter >= unit.hp) score *= 1 - preview.counterHit / 100;
            }
            consider({ kind: 'attack', x, y, target: t, score: Math.max(0.5, score) + (preferred.includes(t) ? 10000 : 0) });
        }
    }
    for (const sk of unit.skills || []) {
        if (!skillUsable(sk) || (sk.kind === 'support') !== (mode !== 'attack')) continue;
        // 速攻单独在行动前使用；传送由玩家或 LLM 决定落点，内置 AI 不使用
        if (isQuick(sk) !== (mode === 'quick') || skillTargetSide(sk) === 'tile') continue;
        for (const [tx, ty] of skillTargetTiles(b, unit, sk)) {
            // 战争迷雾：看不见的敌人不计入估值
            const aff = skillAffected(b, unit, sk, tx, ty).filter(t => visibleTo(b, team(unit), t));
            let score = 0;
            if (mode !== 'attack') {
                for (const t of aff) {
                    const hit = skillHitChance(b, unit, sk, t, rules) / 100;
                    for (const e of sk.effects) score += effectScore(b, unit, t, e, rules) * hit;
                }
            } else {
                if (!aff.some(t => filter(t) && skillHitChance(b, unit, sk, t, rules) > 0)) continue;
                // 鲁莽的单位使用MAP攻击时不在乎误伤友军（旧单位没有该字段，视为鲁莽）
                const reckless = unit.mapReckless !== false;
                for (const t of aff) {
                    const foe = isFoe(t, unit);
                    if (!foe && reckless) continue;
                    let dmg = calcDamage(b, unit, t, sk.kind, sk.power, rules, Math.random, true);
                    if (defaultReaction(b, unit, t, rules, sk) === 'defend' && !t.object) dmg = defenseDamage(dmg, rules);
                    const hit = skillHitChance(b, unit, sk, t, rules) / 100;
                    const value = 1 + (Math.min(dmg, t.hp) + (dmg >= t.hp ? 100 : 0)) * hit;
                    score += foe ? value : -value * 2;
                    if (foe && dmg < t.hp) for (const e of sk.effects) score += effectScore(b, unit, t, e, rules) * 0.5 * hit;
                }
            }
            // 有次数限制或冷却的技能，略微倾向于保留
            if (sk.uses || Number(sk.cooldown) > 1) score *= 0.9;
            if (mode === 'attack' && score > 0 && aff.some(t => preferred.includes(t))) score += 10000;
            consider({ kind: 'skill', x, y, skill: sk, tx, ty, targets: aff, score });
        }
    }
    unit.x = ox; unit.y = oy;
    return list;
}

function bestActionAt(b, unit, x, y, rules, filter, mode) {
    let best = null;
    for (const c of candidatesAt(b, unit, x, y, rules, filter, mode)) if (!best || c.score > best.score) best = c;
    return best;
}

function bestAction(b, unit, nodes, rules, filter, mode = 'attack', penalty = null) {
    let best = null;
    for (const node of nodes) {
        const cand = bestActionAt(b, unit, node.x, node.y, rules, filter, mode);
        if (!cand) continue;
        cand.score -= node.cost * 0.01; // 同分时少走路
        if (penalty) cand.score -= penalty(node);
        if (!best || cand.score > best.score) best = cand;
    }
    return best;
}

/** AI 想要攻击的目标：被嘲讽时只能是嘲讽者；守城战的敌人盯着守卫目标；其余情况找角色（不含建筑物） */
export function goalTargets(b, unit) {
    const forced = taunters(b, unit);
    if (forced.length) return forced;
    const type = missionOf(b).type;
    // 只追击打得到的目标（对空规则下，没有对空手段的单位不会去追飞行单位）
    const foes = knownFoes(b, unit).filter(t => canEverHit(b, unit, t));
    const preferred = attractionTargets(b, unit).filter(t => canEverHit(b, unit, t));
    const fighters = foes.filter(t => !t.object);
    if (team(unit) === 'E' && type === 'defend') {
        const guards = foes.filter(t => t.keyTarget);
        if (guards.length) return [...new Set([...preferred, ...guards])];
    }
    if (team(unit) === 'P' && type === 'assault') {
        const goals = [...fighters, ...foes.filter(t => t.object && t.keyTarget)];
        return goals.length ? goals : searchTargets(b, unit);
    }
    return fighters.length || preferred.length ? [...new Set([...preferred, ...fighters])] : searchTargets(b, unit);
}

/** 战争迷雾中看不到敌人时：前往最后发现敌人的位置搜索（没有情报时原地警戒） */
function searchTargets(b, unit) {
    return lastSeen(b, team(unit)).map(g => ({ uid: g.unit.uid, name: `${g.unit.name}的最后发现位置`, x: g.x, y: g.y, ghost: true }));
}

function fieldDist(b, field, t) {
    let d = field[t.y * b.w + t.x];
    for (const [dx, dy] of DIRS) {
        const nx = t.x + dx, ny = t.y + dy;
        if (inBounds(b, nx, ny)) d = Math.min(d, field[ny * b.w + nx] + 1);
    }
    return d;
}

function* respondAttack(b, unit, target, rules, rng, events) {
    const cover = coverFor(b, unit, target);
    // 被援护时由援护者选择反应（不能反击）
    const reaction = yield { attacker: unit, target: cover ? cover.unit : target, cover: cover ? target : null, skill: null, eventsBefore: [...events] };
    return doAttack(b, unit, target, rules, rng, reaction);
}

function* respondSkill(b, unit, skill, tx, ty, rules, rng, events) {
    const responses = {};
    if (skill.kind !== 'support') {
        for (const target of skillAffected(b, unit, skill, tx, ty)) {
            const cover = coverFor(b, unit, target, skill);
            const victim = cover ? cover.unit : target;
            responses[victim.uid] = yield { attacker: unit, target: victim, cover: cover ? target : null, skill, tx, ty, eventsBefore: [...events] };
        }
    }
    return doSkill(b, unit, skill, tx, ty, rules, rng, responses);
}

function* execute(b, unit, plan, rules, rng, events) {
    const mv = doMove(b, unit, plan.x, plan.y);
    if (mv) events.push(mv);
    if (unit.hp <= 0) return;
    if (plan.kind === 'attack') events.push(yield* respondAttack(b, unit, plan.target, rules, rng, events));
    else events.push(yield* respondSkill(b, unit, plan.skill, plan.tx, plan.ty, rules, rng, events));
}

function better(a, c) {
    if (!a) return c;
    if (!c) return a;
    return c.score > a.score ? c : a;
}

// ---------------------------------------------------------------- 危险评估（逃跑 / 远程游击）

/** 站在 (x,y) 时地形造成的伤害（落脚 + 回合开始），不修改单位 */
function tileHazard(b, unit, x, y) {
    const t = terrainAt(b, x, y);
    if (unit.object || (unit.flying && !t.damageFlying)) return 0;
    let total = 0;
    for (const timing of ['enter', 'turn']) {
        const fixed = Math.max(0, Number(t[`${timing}Damage`]) || 0);
        const pct = Math.max(0, Number(t[`${timing}DamagePct`]) || 0);
        total += Math.floor(fixed) + (pct > 0 ? Math.max(1, Math.round(unit.maxHp * pct / 100)) : 0);
    }
    return total;
}

/** 敌人从 (x,y) 出发、不移动时能用普通攻击或伤害技能打到的格子 */
function strikeTiles(b, foe, x, y, target = null) {
    const keys = new Set();
    const put = ([tx, ty]) => keys.add(`${tx},${ty}`);
    if (!target || canHit(b, foe, target)) tilesInRange(b, x, y, foe.rangeMin, foe.rangeMax).forEach(put);
    for (const sk of foe.skills || []) {
        if (sk.kind === 'support' || !skillUsable(sk) || (target && !canHit(b, foe, target, sk))) continue;
        if (sk.attackMode === 'mapLine') {
            const len = Math.max(1, Math.min(100, Math.floor(Number(sk.lineLength) || 3)));
            for (const [dx, dy] of DIRS) for (let n = 1; n <= len && inBounds(b, x + dx * n, y + dy * n); n++) put([x + dx * n, y + dy * n]);
        } else {
            const radius = sk.attackMode === 'mapArea' ? Math.max(1, Number(sk.radius) || 1) : Math.max(0, Number(sk.radius) || 0);
            tilesInRange(b, x, y, 0, (Number(sk.rangeMax) || 0) + radius).forEach(put);
        }
    }
    return keys;
}

/**
 * 下一个敌方阶段的威胁：格子 -> 可能受到的伤害估计（每个敌人取其最强一击，叠加）。
 * 敌人的移动按当前站位估算，眩晕、建筑不计。
 */
export function threatMap(b, unit, rules) {
    const map = new Map();
    for (const f of knownFoes(b, unit)) {
        if (f.object || isStunned(f) || !canEverHit(b, f, unit)) continue; // 打不到飞行单位的敌人不构成威胁
        let hit = canHit(b, f, unit) ? calcDamage(b, f, unit, f.atkType, 100, rules, Math.random, true) : 0;
        for (const sk of f.skills || []) {
            if (sk.kind !== 'support' && skillUsable(sk) && canHit(b, f, unit, sk)) hit = Math.max(hit, calcDamage(b, f, unit, sk.kind, sk.power, rules, Math.random, true));
        }
        const zone = new Set();
        const from = f.ai === 'stationary' ? [{ x: f.x, y: f.y }] : reachable(b, f, stat(f, 'mov'), true).values();
        for (const n of from) for (const k of strikeTiles(b, f, n.x, n.y, unit)) zone.add(k);
        for (const k of zone) map.set(k, (map.get(k) || 0) + hit);
    }
    return map;
}

function dangerOf(b, unit, threat, x, y) {
    return (threat.get(`${x},${y}`) || 0) + tileHazard(b, unit, x, y) * 2;
}

/** 逃跑：当前位置安全就不动；否则去危险最小、离敌人最远的格子 */
export function fleeDestination(b, unit, nodes, rules, threat = threatMap(b, unit, rules)) {
    if (!(threat.get(`${unit.x},${unit.y}`) > 0)) return null;
    const foes = knownFoes(b, unit).filter(f => !f.object);
    const far = (x, y) => foes.length ? Math.min(...foes.map(f => dist(x, y, f.x, f.y))) : 0;
    let best = null;
    for (const n of nodes) {
        const c = { x: n.x, y: n.y, cost: n.cost, danger: dangerOf(b, unit, threat, n.x, n.y), far: far(n.x, n.y) };
        if (!best || c.danger < best.danger || (c.danger === best.danger && (c.far > best.far || (c.far === best.far && c.cost < best.cost)))) best = c;
    }
    return best && (best.x !== unit.x || best.y !== unit.y) ? best : null;
}

/** 远程游击没有攻击目标时：朝目标前进，但尽量停在敌人的威胁范围之外 */
function cautiousAdvance(b, unit, nodes, rules, threat) {
    const goals = goalTargets(b, unit);
    if (!goals.length) return null;
    const field = distanceField(b, unit, goals.map(g => [g.x, g.y]));
    let best = null;
    for (const n of nodes) {
        const c = { x: n.x, y: n.y, cost: n.cost, danger: dangerOf(b, unit, threat, n.x, n.y), v: field[n.y * b.w + n.x] };
        if (!best || c.danger < best.danger || (c.danger === best.danger && (c.v < best.v || (c.v === best.v && c.cost < best.cost)))) best = c;
    }
    return best && (best.x !== unit.x || best.y !== unit.y) ? best : null;
}

/** 行动前先使用有价值的速攻技能（不消耗行动；每个速攻技能每回合一次） */
function useQuickSkills(b, unit, rules, rng, events) {
    for (let i = 0; i < 10 && unit.hp > 0 && !b.result; i++) {
        const c = bestActionAt(b, unit, unit.x, unit.y, rules, t => isFoe(t, unit), 'quick');
        if (!c) return;
        events.push(doSkill(b, unit, c.skill, c.tx, c.ty, rules, rng));
        finish(b, events);
    }
}

/**
 * 让单个 AI 单位行动，返回事件列表
 * - 主动出击：按距离从近到远，攻击最近的能打到的目标；都打不到就朝最近的目标前进，途中顺手攻击射程内的敌人
 *   （守城战中敌人的目标是守卫目标；被嘲讽时目标只能是嘲讽者）
 * - 原地迎击：只攻击移动后能打到的目标，不主动接近
 * - 固守不动：不移动，只攻击射程内的目标
 * - 逃跑：不攻击；敌人下回合打不到就原地不动，否则逃到最安全的位置（仍可使用辅助技能）
 * - 远程游击：从最安全的位置攻击；打不到目标时前进到敌人威胁范围边缘，不主动踏入
 * 辅助技能（治疗、增益、减益）与攻击比较估值，取较高者
 */
function* aiActSteps(b, unit, rules, rng = Math.random) {
    const events = [];
    if (unit.hp <= 0 || unit.object || b.result) return events;
    if (isStunned(unit)) {
        unit.acted = true;
        events.push(fogTag(b, unit, { type: 'stunned', turn: b.turn, actor: ref(unit) }));
        return events;
    }
    useQuickSkills(b, unit, rules, rng, events);
    if (unit.hp <= 0 || b.result) { unit.acted = true; return events; }
    const nodes = [...(unit.ai === 'stationary'
        ? [{ x: unit.x, y: unit.y, cost: 0 }]
        : reachable(b, unit).values())];
    const anyFoe = t => isFoe(t, unit);
    const support = bestAction(b, unit, nodes, rules, anyFoe, 'support');

    let plan = null;
    if (unit.ai === 'aggressive') {
        const goals = goalTargets(b, unit);
        const fromMe = distanceField(b, unit, [[unit.x, unit.y]]);
        const preferred = attractionTargets(b, unit);
        const ordered = goals.map(g => [g, fieldDist(b, fromMe, g)]).sort((a, c) => Number(preferred.includes(c[0])) - Number(preferred.includes(a[0])) || a[1] - c[1]);
        for (const [g] of ordered) {
            plan = bestAction(b, unit, nodes, rules, t => t === g);
            if (plan) break;
        }
        plan = better(plan, support);
        if (!plan && goals.length) {
            // 朝最近的目标前进
            const field = distanceField(b, unit, goals.map(g => [g.x, g.y]));
            let dest = null;
            for (const n of nodes) {
                const v = field[n.y * b.w + n.x];
                if (!dest || v < dest.v || (v === dest.v && n.cost < dest.cost)) dest = { ...n, v };
            }
            if (dest && isFinite(dest.v) && (dest.x !== unit.x || dest.y !== unit.y)) {
                const mv = doMove(b, unit, dest.x, dest.y);
                if (mv) events.push(mv);
            }
            const here = [{ x: unit.x, y: unit.y, cost: 0 }];
            plan = better(bestAction(b, unit, here, rules, anyFoe), bestAction(b, unit, here, rules, anyFoe, 'support'));
        }
    } else if (unit.ai === 'flee') {
        const dest = fleeDestination(b, unit, nodes, rules);
        if (dest) {
            const mv = doMove(b, unit, dest.x, dest.y);
            if (mv) events.push(mv);
        }
        if (unit.hp > 0) plan = bestAction(b, unit, [{ x: unit.x, y: unit.y, cost: 0 }], rules, anyFoe, 'support');
    } else if (unit.ai === 'ranged') {
        const threat = threatMap(b, unit, rules);
        // 攻击位置按承受的风险扣分（伤害约按一半计入），能打就打，只是挑更安全的格子
        const risk = n => dangerOf(b, unit, threat, n.x, n.y) * 0.5;
        plan = better(bestAction(b, unit, nodes, rules, anyFoe, 'attack', risk), bestAction(b, unit, nodes, rules, anyFoe, 'support', risk));
        if (!plan) {
            const dest = cautiousAdvance(b, unit, nodes, rules, threat);
            if (dest) {
                const mv = doMove(b, unit, dest.x, dest.y);
                if (mv) events.push(mv);
            }
        }
    } else {
        plan = better(bestAction(b, unit, nodes, rules, anyFoe), support);
    }
    if (plan && unit.hp > 0) yield* execute(b, unit, plan, rules, rng, events);
    else endAction(b, unit); // 没有攻击或技能（只移动 / 原地不动）也结束这次行动
    finish(b, events);
    return events;
}

function settleSteps(b, rules, steps) {
    let next = steps.next();
    while (!next.done) {
        const request = next.value;
        next = steps.next(defaultReaction(b, request.attacker, request.target, rules, request.skill, !!request.cover));
    }
    return next.value;
}

async function settleInteractive(steps, choose) {
    let next = steps.next();
    while (!next.done) {
        const response = await choose(next.value);
        if (!['counter', 'defend', 'none'].includes(response)) throw new Error('战斗反应已取消');
        next = steps.next(response);
    }
    return next.value;
}

export function aiAct(b, unit, rules, rng = Math.random) {
    return settleSteps(b, rules, aiActSteps(b, unit, rules, rng));
}

export function aiActInteractive(b, unit, rules, choose, rng = Math.random) {
    return settleInteractive(aiActSteps(b, unit, rules, rng), choose);
}

/**
 * 某阵营阶段开始：
 * 1. 该阵营单位：记录阶段开始位置、地形回复、持续恢复 / 中毒、技能冷却 -1
 * 2. 由该阵营施加的持续效果：剩余回合 -1，归零则结束
 */
function startTurnEffects(b, side) {
    const events = [];
    for (const u of alive(b).filter(x => x.side === side)) {
        u.phaseX = u.x; u.phaseY = u.y;
        u.tough = toughMax(u);
        u.revealed = false; // 攻击暴露的位置在己方阶段开始时重新隐入迷雾
        const t = terrainAt(b, u.x, u.y);
        const damage = terrainDamage(b, u, 'turn');
        if (damage) events.push(damage);
        if (u.hp <= 0) continue;
        const pct = Number(t.healPct) || 0;
        if (pct > 0 && u.hp < u.maxHp && !u.object) {
            const amount = Math.min(u.maxHp - u.hp, Math.max(1, Math.round(u.maxHp * pct / 100)));
            const before = u.hp;
            u.hp += amount;
            events.push(fogTag(b, u, { type: 'terrainHeal', turn: b.turn, actor: ref(u), terrain: t.name, heal: amount, hpBefore: before, hpAfter: u.hp }));
        }
        for (const e of traitEffects(u)) {
            if (!['regen', 'regen_flat'].includes(e.type) || u.hp >= u.maxHp) continue;
            const value = Math.max(0, Number(e.value) || 0);
            const amount = Math.round(e.type === 'regen' ? u.maxHp * value / 100 : value);
            if (amount <= 0) continue;
            const before = u.hp;
            u.hp = Math.min(u.maxHp, u.hp + amount);
            events.push(fogTag(b, u, { type: 'dot', turn: b.turn, actor: ref(u), effect: 'regen', label: `特质：${e.traitName}`, hpBefore: before, hpAfter: u.hp }));
        }
        for (const st of u.statuses || []) {
            const v = Math.max(1, Math.round(u.maxHp * (Number(st.value) || 0) / 100));
            const before = u.hp;
            if (st.type === 'regen' && u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + v);
            else if (st.type === 'poison' && u.hp > 1) u.hp = Math.max(1, u.hp - v);
            else continue;
            events.push(fogTag(b, u, { type: 'dot', turn: b.turn, actor: ref(u), effect: st.type, label: EFFECTS[st.type].name, hpBefore: before, hpAfter: u.hp }));
        }
        for (const sk of u.skills || []) if (sk.cdLeft > 0) sk.cdLeft -= 1;
    }
    for (const u of alive(b)) {
        if (!u.statuses?.length) continue;
        const ended = [];
        u.statuses = u.statuses.filter(st => {
            if (st.srcSide !== side) return true;
            st.turns -= 1;
            if (st.turns > 0) return true;
            ended.push(effectLabel(st));
            return false;
        });
        if (ended.length) events.push(fogTag(b, u, { type: 'statusEnd', turn: b.turn, actor: ref(u), effects: ended }));
    }
    return events;
}

// ---------------------------------------------------------------- 增援

/** 在 (x,y) 附近找一个能站的空格 */
function freeTileNear(b, def, x, y, radius = 3) {
    const probe = { flying: !!def.flying };
    for (let r = 0; r <= radius; r++) {
        for (const [tx, ty] of tilesInRange(b, x, y, r, r)) {
            if (!unitAt(b, tx, ty) && isFinite(enterCost(b, probe, tx, ty))) return [tx, ty];
        }
    }
    return null;
}

/** 处理本回合到期的增援，返回事件 */
export function processReinforcements(b) {
    const events = [];
    b.reinfFired ||= {};
    b.spawnCount ||= {};
    for (const w of b.reinforcements || []) {
        const next = nextWaveTurn(b, w);
        if (next == null || next > b.turn) continue;
        b.reinfFired[w.id] = (b.reinfFired[w.id] || 0) + 1;
        const def = b.unitDefs?.[w.unitId];
        if (!def) continue;
        const spawned = [];
        for (let i = 0; i < Math.max(1, Number(w.count) || 1); i++) {
            const pos = freeTileNear(b, def, w.x, w.y);
            if (!pos) break;
            b.spawnCount[def.id] = (b.spawnCount[def.id] || 0) + 1;
            const u = makeBattleUnit(def, `r${b.nextUid++}`, `${def.name}·增援${b.spawnCount[def.id]}`, pos[0], pos[1]);
            u.acted = true; // 增援出现的回合不行动
            b.units.push(u);
            spawned.push(ref(u));
        }
        events.push({
            type: 'reinforce', turn: b.turn, side: w.side, at: { x: w.x, y: w.y },
            terrain: terrainAt(b, w.x, w.y).name, units: spawned, wanted: Math.max(1, Number(w.count) || 1),
            actor: { side: w.side, name: def.name },
        });
    }
    return events;
}

export const AI_SIDES = ['enemy', 'ally'];

/**
 * 某个 AI 阵营的阶段开始：结算持续效果，返回本阶段要行动的单位
 * （即使该阵营没有单位，也要结算它施加的持续效果）
 */
export function beginSidePhase(b, side) {
    const events = [];
    const group = alive(b).filter(u => u.side === side && !u.object);
    const effects = startTurnEffects(b, side);
    if (group.length) {
        b.phase = side;
        events.push({ type: 'phase', turn: b.turn, phase: side });
    }
    events.push(...effects);
    finish(b, events);
    for (const u of group) { u.moved = false; u.acted = false; }
    return { events, group };
}

/** 本阶段通过「额外行动」重新可行动的单位，需要排到队尾再行动一次 */
export function refreshedUnits(b, group, queue = []) {
    return group.filter(g => g.hp > 0 && !g.retreated && !g.acted && g.againTurn === b.turn && !queue.includes(g));
}

/** 所有 AI 阵营行动完毕：增援 → 回合限制 → 新回合的我方阶段 */
export function finishRound(b) {
    const events = [];
    if (b.result) return events;
    events.push(...processReinforcements(b));
    setResult(b, checkTurnLimit(b), events);
    if (b.result) return events;
    b.turn += 1;
    b.phase = 'player';
    for (const u of b.units) { u.moved = false; u.acted = false; }
    events.push({ type: 'phase', turn: b.turn, phase: 'player' });
    events.push(...startTurnEffects(b, 'player'));
    finish(b, events);
    return events;
}

/** 结束我方阶段：敌方行动 → 友军行动 → 增援 → 新回合（全部由内置 AI 决定） */
export function endPlayerPhase(b, rules, rng = Math.random) {
    const events = [];
    if (b.result) return events;
    for (const side of AI_SIDES) {
        const { events: ev, group } = beginSidePhase(b, side);
        events.push(...ev);
        if (b.result) return events;
        const queue = [...group];
        while (queue.length) {
            const u = queue.shift();
            if (u.hp <= 0 || u.retreated) continue;
            events.push(...aiAct(b, u, rules, rng));
            if (b.result) return events;
            queue.push(...refreshedUnits(b, group, queue));
        }
    }
    events.push(...finishRound(b));
    return events;
}

// ---------------------------------------------------------------- 供 LLM 选择的行动

/**
 * 列出某个 AI 单位本回合可选的行动（供 LLM 指挥官选择）。
 * 每个目标只保留最好的一种打法，再加上朝不同目标前进、原地待命。
 * @returns {{kind:'attack'|'skill'|'move'|'wait', x:number, y:number, target?:object, skill?:object, tx?:number, ty?:number, toward?:object, score:number}[]}
 */
export function aiOptions(b, unit, rules, limit = 6) {
    if (unit.hp <= 0 || unit.object || isStunned(unit)) return [];
    const nodes = [...(unit.ai === 'stationary'
        ? [{ x: unit.x, y: unit.y, cost: 0 }]
        : reachable(b, unit).values())];
    const anyFoe = t => isFoe(t, unit);
    const wait = { kind: 'wait', x: unit.x, y: unit.y, score: 0 };
    if (unit.ai === 'flee') {
        // 逃跑的单位不攻击：逃离 / 原地使用辅助技能 / 待命
        const dest = fleeDestination(b, unit, nodes, rules);
        const support = candidatesAt(b, unit, unit.x, unit.y, rules, anyFoe, 'support').sort((a, c) => c.score - a.score).slice(0, Math.max(1, limit - 2));
        return [...(dest ? [{ kind: 'move', x: dest.x, y: dest.y, flee: true, score: 0 }] : []), ...support, wait];
    }
    const best = new Map();
    for (const n of nodes) {
        for (const mode of ['attack', 'support']) {
            for (const c of candidatesAt(b, unit, n.x, n.y, rules, anyFoe, mode)) {
                c.score -= n.cost * 0.01;
                const key = c.kind === 'attack' ? `a:${c.target.uid}` : `s:${c.skill.id}:${(c.targets || []).map(t => t.uid).join(',')}`;
                if (!best.has(key) || best.get(key).score < c.score) best.set(key, c);
            }
        }
    }
    const actions = [...best.values()].sort((a, c) => c.score - a.score).slice(0, Math.max(1, limit - 2));

    const moves = [];
    if (unit.ai === 'ranged') {
        const dest = cautiousAdvance(b, unit, nodes, rules, threatMap(b, unit, rules));
        if (dest) moves.push({ kind: 'move', x: dest.x, y: dest.y, cautious: true, score: 0 });
    }
    if (unit.ai !== 'stationary') {
        const fromMe = distanceField(b, unit, [[unit.x, unit.y]]);
        const goals = goalTargets(b, unit).map(g => [g, fieldDist(b, fromMe, g)]).sort((a, c) => a[1] - c[1]).slice(0, 2);
        for (const [g] of goals) {
            const field = distanceField(b, unit, [[g.x, g.y]]);
            let dest = null;
            for (const n of nodes) {
                const v = field[n.y * b.w + n.x];
                if (!dest || v < dest.v || (v === dest.v && n.cost < dest.cost)) dest = { ...n, v };
            }
            if (dest && isFinite(dest.v) && (dest.x !== unit.x || dest.y !== unit.y) && !moves.some(m => m.x === dest.x && m.y === dest.y)) {
                moves.push({ kind: 'move', x: dest.x, y: dest.y, toward: g, score: 0 });
            }
        }
    }
    return [...actions, ...moves, wait];
}

/** 当前局面下这个行动是否仍然可以执行（其他单位行动后，位置或目标可能已经变化） */
export function planValid(b, unit, plan) {
    if (!plan || unit.hp <= 0 || unit.retreated || isStunned(unit)) return false;
    if (plan.x !== unit.x || plan.y !== unit.y) {
        if (unit.ai === 'stationary' || !reachable(b, unit).has(`${plan.x},${plan.y}`)) return false;
    }
    const ox = unit.x, oy = unit.y;
    unit.x = plan.x; unit.y = plan.y;
    let ok = true;
    if (plan.kind === 'attack') {
        const t = getUnit(b, plan.target.uid);
        ok = !!t && attackTargets(b, unit).includes(t);
    } else if (plan.kind === 'skill') {
        const sk = unit.skills.find(x => x.id === plan.skill.id);
        ok = !!sk && skillUsable(sk) && skillTargetTiles(b, unit, sk).some(([x, y]) => x === plan.tx && y === plan.ty);
    }
    unit.x = ox; unit.y = oy;
    return ok;
}

/**
 * 按指定的行动行动；行动已经无效时交给内置 AI。
 * @returns {{events: object[], usedPlan: boolean}}
 */
function* planSteps(b, unit, plan, rules, rng = Math.random) {
    if (!planValid(b, unit, plan)) return { events: yield* aiActSteps(b, unit, rules, rng), usedPlan: false };
    const events = [];
    useQuickSkills(b, unit, rules, rng, events);
    if (!planValid(b, unit, plan)) {
        events.push(...(yield* aiActSteps(b, unit, rules, rng)));
        return { events, usedPlan: false };
    }
    const mv = doMove(b, unit, plan.x, plan.y);
    if (mv) events.push(mv);
    if (unit.hp <= 0) {
        finish(b, events);
        return { events, usedPlan: true };
    }
    if (plan.kind === 'attack') events.push(yield* respondAttack(b, unit, getUnit(b, plan.target.uid), rules, rng, events));
    else if (plan.kind === 'skill') events.push(yield* respondSkill(b, unit, unit.skills.find(x => x.id === plan.skill.id), plan.tx, plan.ty, rules, rng, events));
    else if (plan.kind === 'wait' && !mv) events.push(doWait(b, unit));
    if (plan.kind === 'move' || (plan.kind === 'wait' && mv)) endAction(b, unit); // 只移动也算一次行动
    finish(b, events);
    return { events, usedPlan: true };
}

export function actWithPlan(b, unit, plan, rules, rng = Math.random) {
    return settleSteps(b, rules, planSteps(b, unit, plan, rules, rng));
}

export function actWithPlanInteractive(b, unit, plan, rules, choose, rng = Math.random) {
    return settleInteractive(planSteps(b, unit, plan, rules, rng), choose);
}

// ---------------------------------------------------------------- 创建战斗

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 资料卡单位的韧性上限 */
export function unitTough(d) {
    const n = Number(d.tough);
    return d.kind === 'object' ? 0 : Number.isFinite(n) && d.tough !== '' && d.tough != null ? Math.max(0, Math.floor(n)) : DEFAULT_TOUGH;
}

/** 资料卡单位的视野（建筑默认 0，可设为瞭望塔） */
export function unitVision(d) {
    const n = Number(d.vision);
    return d.vision !== '' && d.vision != null && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : d.kind === 'object' ? 0 : DEFAULT_VISION;
}

export function makeBattleUnit(d, uidStr, name, x, y) {
    const hp = Math.max(1, Number(d.hp) || 1);
    const object = d.kind === 'object';
    return {
        uid: uidStr,
        defId: d.id,
        name,
        side: d.side,
        icon: d.icon || d.name.slice(0, 1),
        color: d.color || '',
        x, y,
        hp, maxHp: hp,
        atk: object ? 0 : +d.atk || 0,
        matk: object ? 0 : +d.matk || 0,
        def: +d.def || 0, mdef: +d.mdef || 0,
        agi: object ? 0 : +d.agi || 0,
        mov: object ? 0 : +d.mov || 0,
        rangeMin: object ? 0 : Math.max(1, +d.rangeMin || 1),
        rangeMax: object ? 0 : Math.max(+d.rangeMin || 1, +d.rangeMax || 1),
        atkType: d.atkType === 'magical' ? 'magical' : 'physical',
        attackOrder: d.attackOrder === 'last' ? 'last' : 'normal',
        weaponName: d.weaponName || '',
        flying: !object && !!d.flying,
        antiAir: !object && !!d.antiAir,
        typeId: d.typeId || '',
        vision: unitVision(d),
        ai: object ? 'stationary' : d.ai || 'aggressive',
        mapReckless: d.mapReckless !== false,
        toughMax: object ? 0 : unitTough(d),
        tough: object ? 0 : unitTough(d),
        object,
        keyTarget: !!d.keyTarget,
        skills: object ? [] : (d.skills || []).map(s => ({ ...normalizeSkill(structuredClone(s)), usesLeft: Number(s.uses) || 0, cdLeft: 0 })),
        traits: structuredClone(Array.isArray(d.traits) ? d.traits : []),
        statuses: [],
        phaseX: x, phaseY: y,
        wb: d.wb ? structuredClone(d.wb) : null,
        aliases: d.aliases || '',
        notes: d.notes || '',
        moved: false, acted: false,
    };
}

/** 资料卡兵种 → 战场快照 { id: { name, desc, vs } } */
export function battleUnitTypes(types = []) {
    return Object.fromEntries((types || []).filter(t => t?.id).map(t => [t.id, { name: t.name || '未命名兵种', desc: t.desc || '', vs: structuredClone(t.vs || {}) }]));
}

export function createBattle(map, unitDefs, terrainDefs, unitTypes = []) {
    const defs = new Map(unitDefs.map(u => [u.id, u]));
    const terrains = {};
    for (const t of terrainDefs) terrains[t.id] = structuredClone(t);
    const placements = (map.placements || []).filter(p => defs.has(p.unitId));
    const count = {};
    placements.forEach(p => { count[p.unitId] = (count[p.unitId] || 0) + 1; });
    const seen = {};
    const units = placements.map((p, i) => {
        const d = defs.get(p.unitId);
        seen[d.id] = (seen[d.id] || 0) + 1;
        const suffix = count[d.id] > 1 ? (LETTERS[seen[d.id] - 1] || seen[d.id]) : '';
        return makeBattleUnit(d, `u${i}`, d.name + suffix, p.x, p.y);
    });
    const reinforcements = (map.reinforcements || [])
        .filter(w => defs.has(w.unitId))
        .map(w => ({ ...structuredClone(w), side: defs.get(w.unitId).side }));
    const unitDefs2 = {};
    reinforcements.forEach(w => { unitDefs2[w.unitId] = structuredClone(defs.get(w.unitId)); });
    const b = {
        active: true,
        mapId: map.id,
        mapName: map.name,
        mapDesc: map.desc || '',
        w: map.w, h: map.h,
        tiles: [...map.tiles],
        terrains,
        units,
        mission: { type: 'annihilate', turns: 0, ...(map.mission || {}) },
        fog: { enabled: !!map.fog?.enabled, ai: map.fog?.ai !== false },
        unitTypes: battleUnitTypes(unitTypes),
        reinforcements,
        unitDefs: unitDefs2,
        reinfFired: {},
        spawnCount: {},
        nextUid: 1,
        turn: 1,
        phase: 'player',
        result: null,
        resultReason: '',
        pending: [],
        log: [],
    };
    initFog(b);
    return b;
}

/** 开战前检查任务设置是否完整，返回问题列表 */
export function validateMission(map, unitDefs) {
    const defs = new Map(unitDefs.map(u => [u.id, u]));
    const placed = (map.placements || []).map(p => defs.get(p.unitId)).filter(Boolean);
    const type = map.mission?.type || 'annihilate';
    const problems = [];
    if (!placed.some(d => d.side === 'player' && d.kind !== 'object')) problems.push('至少需要一个我方角色');
    const enemyWaves = (map.reinforcements || []).filter(w => defs.get(w.unitId)?.side === 'enemy');
    if (!placed.some(d => d.side === 'enemy') && !enemyWaves.length) problems.push('至少需要一个敌方单位或敌方增援');
    if (type === 'defend' && !placed.some(d => d.side !== 'enemy' && d.keyTarget)) problems.push('守城战需要放置一个我方/友军的「关键目标」（如城门）');
    if (type === 'assault' && !placed.some(d => d.side === 'enemy' && d.keyTarget)) problems.push('进攻战需要放置至少一个敌方「关键目标」');
    if (type === 'annihilate' && enemyWaves.some(w => (Number(w.every) || 0) > 0 && !(Number(w.times) || 0)) && !(Number(map.mission?.turns) || 0)) {
        problems.push('歼灭战中有无限次的敌方增援，敌人永远杀不完，请限制增援次数');
    }
    return problems;
}
