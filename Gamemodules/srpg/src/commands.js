// 战场指令：剧情同步时，插件 LLM 从剧情中读出的战场变化（damage E1 5 落石 …）
// 解析 → 校验 → 应用。全部是纯逻辑，不依赖 SillyTavern。
import {
    EFFECTS, alive, getUnit, terrainAt, enterCost, unitAt, inBounds, effectLabel, makeBattleUnit, checkResult,
} from './engine.js';
import { unitLabels, unitAliases } from './context.js';

/** 指令定义：名字（含中文别名）、语法说明、默认是否允许 */
export const COMMANDS = {
    damage: { names: ['damage', '伤害', '扣血'], syntax: 'damage <单位> <数值> [原因]', label: '造成伤害', allow: true },
    heal: { names: ['heal', '治疗', '回复', '恢复'], syntax: 'heal <单位> <数值> [原因]', label: '回复 HP', allow: true },
    status: { names: ['status', '状态', '附加'], syntax: 'status <单位> <效果> [数值] [回合] [原因]', label: '附加状态', allow: true },
    unstatus: { names: ['unstatus', '解除', '移除状态'], syntax: 'unstatus <单位> <效果|all> [原因]', label: '解除状态', allow: true },
    move: { names: ['move', '移动', '位移'], syntax: 'move <单位> <x> <y> [原因]', label: '强制移动', allow: true },
    retreat: { names: ['retreat', '撤退', '离场'], syntax: 'retreat <单位> [原因]', label: '撤离战场', allow: true },
    spawn: { names: ['spawn', '增援', '登场', '出现'], syntax: 'spawn <单位类型名> <x> <y> [原因]', label: '新单位登场', allow: true },
    terrain: { names: ['terrain', '地形'], syntax: 'terrain <x> <y> <地形名> [原因]', label: '改变地形', allow: true },
    end: { names: ['end', '结束', '结束战斗'], syntax: 'end <victory|defeat> [原因]', label: '结束战斗', allow: false },
};

const NAME_TO_CMD = new Map(Object.entries(COMMANDS).flatMap(([id, c]) => c.names.map(n => [n.toLowerCase(), id])));

/** 把指令文字（每行一条）解析成指令列表；无法识别的行会带上 error */
export function parseCommands(blockText) {
    const out = [];
    for (let line of String(blockText || '').split('\n')) {
        line = line.replace(/^\s*[-*·•\d.)、]*\s*/, '').replace(/\s+#.*$/, '').trim();
        if (!line) continue;
        // 统一坐标写法：(5,6) 5,6 5，6 → 5 6
        const norm = line.replace(/[（(]\s*(\d+)\s*[,，]\s*(\d+)\s*[)）]/g, ' $1 $2 ').replace(/(\d+)\s*[,，]\s*(\d+)/g, '$1 $2');
        const [head, ...rest] = norm.split(/\s+/);
        const cmd = NAME_TO_CMD.get(head.toLowerCase());
        out.push(cmd ? { cmd, args: rest, raw: line } : { cmd: null, args: rest, raw: line, error: `无法识别的指令「${head}」` });
    }
    return out;
}

// ---------------------------------------------------------------- 解析参数

/** 按编号（P1/E2）、名字、别名查找场上单位 */
export function findUnit(b, ref, subst = x => x) {
    const q = String(ref || '').trim().replace(/^\[|\]$/g, '');
    if (!q) return null;
    const labels = unitLabels(b);
    const pool = b.units.filter(u => u.hp > 0 && !u.retreated);
    const lower = q.toLowerCase();
    return pool.find(u => labels[u.uid]?.toLowerCase() === lower)
        || pool.find(u => u.name === q)
        || pool.find(u => unitAliases(u).some(a => subst(a) === q))
        || pool.find(u => u.name.includes(q) || q.includes(u.name))
        || null;
}

function findEffect(token) {
    const q = String(token || '').trim();
    if (EFFECTS[q]) return q;
    return Object.entries(EFFECTS).find(([, d]) => d.name === q)?.[0]
        || Object.entries(EFFECTS).find(([, d]) => d.name.includes(q) || q.includes(d.name))?.[0]
        || null;
}

const int = v => (/^-?\d+$/.test(String(v)) ? parseInt(v, 10) : NaN);

function ref(u) {
    return { uid: u.uid, name: u.name, side: u.side, alias: '', wbKey: u.wb?.keys?.[0] || '' };
}

// ---------------------------------------------------------------- 应用

/**
 * 校验并应用一条指令（会修改 b）。
 * @param {object} opt { allow: Record<cmd,bool>, maxChangePct, allowKill, unitDefs, terrainDefs, subst }
 * @returns {object} 事件
 * @throws 指令无效时抛出错误（b 不变）
 */
export function applyCommand(b, c, opt) {
    if (!c.cmd) throw new Error(c.error || '无法识别的指令');
    if (opt.allow && opt.allow[c.cmd] === false) throw new Error(`设置中不允许「${COMMANDS[c.cmd].label}」`);
    const a = c.args;
    const ev = { type: 'llm', cmd: c.cmd, turn: b.turn, raw: c.raw };
    const needUnit = (i = 0) => {
        const u = findUnit(b, a[i], opt.subst);
        if (!u) throw new Error(`找不到单位「${a[i] || ''}」`);
        return u;
    };
    const reasonFrom = i => a.slice(i).join(' ');
    const cap = u => Math.max(1, Math.ceil(u.maxHp * (Number(opt.maxChangePct ?? 50) / 100)));

    switch (c.cmd) {
        case 'damage': {
            const u = needUnit();
            let n = int(a[1]);
            if (!(n > 0)) throw new Error('伤害数值必须是正整数');
            const note = n > cap(u) ? `（超过上限，按 ${cap(u)} 计算）` : '';
            n = Math.min(n, cap(u));
            const before = u.hp;
            u.hp = Math.max(opt.allowKill ? 0 : 1, u.hp - n);
            return { ...ev, actor: ref(u), amount: before - u.hp, hpBefore: before, hpAfter: u.hp, killed: u.hp === 0, reason: reasonFrom(2), note };
        }
        case 'heal': {
            const u = needUnit();
            let n = int(a[1]);
            if (!(n > 0)) throw new Error('回复数值必须是正整数');
            n = Math.min(n, cap(u), u.maxHp - u.hp);
            const before = u.hp;
            u.hp += n;
            return { ...ev, actor: ref(u), amount: n, hpBefore: before, hpAfter: u.hp, reason: reasonFrom(2) };
        }
        case 'status': {
            const u = needUnit();
            const type = findEffect(a[1]);
            if (!type) throw new Error(`未知的效果「${a[1] || ''}」，只能使用预设效果`);
            const def = EFFECTS[type];
            if (type === 'cover') throw new Error('「援护」需要指定援护者，只能通过技能使用');
            if (def.instant && type !== 'cleanse') throw new Error(type.startsWith('heal') ? `「${def.name}」是立即效果，请用 heal 指令` : `「${def.name}」只能通过技能使用`);
            let i = 2;
            if (type === 'cleanse') {
                const removed = (u.statuses || []).filter(s => EFFECTS[s.type]?.debuff);
                u.statuses = (u.statuses || []).filter(s => !EFFECTS[s.type]?.debuff);
                return { ...ev, actor: ref(u), label: def.name, removed: removed.map(effectLabel), reason: reasonFrom(i) };
            }
            let value = def.value ?? 0;
            if (!def.noValue && !isNaN(int(a[i]))) value = int(a[i++]);
            let turns = 2;
            if (!isNaN(int(a[i]))) turns = Math.max(1, int(a[i++]));
            u.statuses = (u.statuses || []).filter(s => s.type !== type);
            u.statuses.push({ type, value, turns, srcSide: 'player' }); // 按回合计时（每个我方阶段开始时 -1）
            return { ...ev, actor: ref(u), label: effectLabel({ type, value }), turns, debuff: !!def.debuff, reason: reasonFrom(i) };
        }
        case 'unstatus': {
            const u = needUnit();
            const all = /^(all|全部)$/i.test(a[1] || '');
            const type = all ? null : findEffect(a[1]);
            if (!all && !type) throw new Error(`未知的效果「${a[1] || ''}」`);
            const removed = (u.statuses || []).filter(s => all || s.type === type);
            if (!removed.length) throw new Error(`${u.name} 身上没有该状态`);
            u.statuses = (u.statuses || []).filter(s => !removed.includes(s));
            return { ...ev, actor: ref(u), removed: removed.map(effectLabel), reason: reasonFrom(2) };
        }
        case 'move': {
            const u = needUnit();
            if (u.object) throw new Error('建筑无法移动');
            const x = int(a[1]) - 1, y = int(a[2]) - 1;
            if (!inBounds(b, x, y)) throw new Error('坐标超出地图');
            const occ = unitAt(b, x, y);
            if (occ && occ !== u) throw new Error(`(${x + 1},${y + 1}) 已经有 ${occ.name}`);
            if (!isFinite(enterCost(b, u, x, y))) throw new Error(`${u.name} 无法站在 ${terrainAt(b, x, y).name} 上`);
            const from = { x: u.x, y: u.y };
            u.x = x; u.y = y;
            return { ...ev, actor: ref(u), from, to: { x, y }, terrain: terrainAt(b, x, y).name, reason: reasonFrom(3) };
        }
        case 'retreat': {
            const u = needUnit();
            if (u.object) throw new Error('建筑无法撤退');
            u.retreated = true;
            return { ...ev, actor: ref(u), reason: reasonFrom(1) };
        }
        case 'spawn': {
            const name = a[0];
            const def = (opt.unitDefs || []).find(d => d.name === name) || (opt.unitDefs || []).find(d => d.name.includes(name || '\u0000'));
            if (!def) throw new Error(`没有名为「${name || ''}」的单位定义`);
            const x = int(a[1]) - 1, y = int(a[2]) - 1;
            if (!inBounds(b, x, y)) throw new Error('坐标超出地图');
            if (unitAt(b, x, y)) throw new Error(`(${x + 1},${y + 1}) 已经有单位`);
            if (def.kind !== 'object' && !isFinite(enterCost(b, { flying: !!def.flying }, x, y))) throw new Error(`${def.name} 无法站在 ${terrainAt(b, x, y).name} 上`);
            b.spawnCount ||= {};
            b.spawnCount[def.id] = (b.spawnCount[def.id] || 0) + 1;
            b.nextUid = (b.nextUid || 1);
            const u = makeBattleUnit(def, `r${b.nextUid++}`, `${def.name}·${b.spawnCount[def.id]}`, x, y);
            u.acted = true;
            b.units.push(u);
            return { ...ev, actor: ref(u), at: { x, y }, terrain: terrainAt(b, x, y).name, reason: reasonFrom(3) };
        }
        case 'terrain': {
            const x = int(a[0]) - 1, y = int(a[1]) - 1;
            if (!inBounds(b, x, y)) throw new Error('坐标超出地图');
            const q = a[2] || '';
            const t = Object.values(b.terrains).find(t => t.name === q || t.id === q)
                || (opt.terrainDefs || []).find(t => t.name === q || t.id === q);
            if (!t) throw new Error(`没有名为「${q}」的地形`);
            const occ = unitAt(b, x, y);
            const before = terrainAt(b, x, y).name;
            b.terrains[t.id] ||= structuredClone(t);
            const old = b.tiles[y * b.w + x];
            b.tiles[y * b.w + x] = t.id;
            if (occ && !occ.object && !isFinite(enterCost(b, occ, x, y))) {
                b.tiles[y * b.w + x] = old;
                throw new Error(`${occ.name} 站在那里，不能变成${t.name}`);
            }
            return { ...ev, at: { x, y }, from: before, to: t.name, reason: reasonFrom(3) };
        }
        case 'end': {
            const r = /^(victory|win|胜利|胜)$/i.test(a[0] || '') ? 'victory' : /^(defeat|lose|失败|败|战败)$/i.test(a[0] || '') ? 'defeat' : null;
            if (!r) throw new Error('end 需要 victory 或 defeat');
            if (b.result) throw new Error('战斗已经结束');
            b.result = r;
            b.resultReason = reasonFrom(1) || '剧情发展';
            return { ...ev, result: r, reason: b.resultReason };
        }
        default:
            throw new Error('无法识别的指令');
    }
}

/** 自动胜负判定（例如指令让最后一个敌人撤退） */
export function settle(b) {
    if (b.result) return null;
    const r = checkResult(b);
    if (!r) return null;
    b.result = r.result;
    b.resultReason = r.reason;
    return { type: 'result', turn: b.turn, result: r.result, reason: r.reason };
}

/**
 * 在副本上预演一组指令，得到每条的结果（不修改 b）
 * @returns {{c:object, ok:boolean, event?:object, error?:string}[]}
 */
export function previewCommands(b, cmds, opt) {
    const copy = structuredClone(b);
    return cmds.map(c => {
        try {
            return { c, ok: true, event: applyCommand(copy, c, opt) };
        } catch (err) {
            return { c, ok: false, error: err.message || String(err) };
        }
    });
}

/** 写进剧情同步的提示词：告诉插件 LLM 怎样把剧情中的战场变化写成 battleChanges */
export function commandGuide(opt) {
    const allowed = Object.entries(COMMANDS).filter(([id]) => opt.allow?.[id] !== false);
    if (!allowed.length) return '';
    const effects = Object.entries(EFFECTS).filter(([, d]) => !d.instant || d.name === '驱散减益')
        .map(([id, d]) => `${id}（${d.name}${d.noValue ? '' : `，数值单位：${d.unit}`}）`).join('、');
    const examples = {
        damage: 'damage E1 5 被落石砸中',
        heal: 'heal P2 8 喝下了药水',
        status: 'status P1 atk_up 30 2 受到同伴的鼓舞',
        unstatus: 'unstatus P1 poison 服下解毒剂',
        move: 'move E2 6 5 被冲击波击退',
        retreat: 'retreat E3 吓得落荒而逃',
        spawn: 'spawn 哥布林 11 4 号角声中赶来的援军',
        terrain: 'terrain 7 4 河流 木桥被砍断',
        end: 'end victory 敌军首领投降',
    };
    const lines = [
        '## 战场变化（battleChanges）的写法',
        '新的剧情里，如果剧情本身（而不是常规的攻击与技能）让战场发生了变化，把每个变化写成一条指令字符串，放进 battleChanges 数组，例如：',
        JSON.stringify(allowed.map(([id]) => examples[id])),
        `可用指令：${allowed.map(([, c]) => c.syntax).join('；')}。`,
        '单位写编号（P1、E2）或名字；坐标 x 为列、y 为行，从 1 开始。',
    ];
    if (allowed.some(([id]) => id === 'status' || id === 'unstatus')) lines.push(`可用效果：${effects}。`);
    lines.push(`单条指令的扣血 / 回复不超过目标最大 HP 的 ${opt.maxChangePct ?? 50}%${opt.allowKill ? '' : '，且指令不能直接击败单位（最多扣到 1 HP）'}。`);
    lines.push('战斗消息里由战斗系统结算的攻击、技能、移动、伤害已经生效，不要再写成指令；只描写了气氛、没有改变战场时，battleChanges 留空。');
    return lines.join('\n');
}
