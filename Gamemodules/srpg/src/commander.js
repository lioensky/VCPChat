// LLM 指挥官：把 AI 单位的可选行动列给 LLM，由 LLM 选择。纯逻辑部分（描述、提示词、解析回复）。
import { SIDE_NAMES, aiOptions, hitChance, skillHitChance, skillAffected, terrainAt, getUnit, attractionTargets, isFoe, canBrace } from './engine.js';
import { unitLabels } from './context.js';
import { exchangePreview } from './exchange.js';

const pos = (x, y) => `(${x + 1},${y + 1})`;

/** 把一个行动写成一句话 */
export function describePlan(b, unit, plan, rules, labels = unitLabels(b)) {
    const moved = plan.x !== unit.x || plan.y !== unit.y;
    const go = moved ? `移动到 ${pos(plan.x, plan.y)}${terrainAt(b, plan.x, plan.y).name} 后` : '原地';
    const name = t => `${t.name}[${labels[t.uid]}]`;
    const ox = unit.x, oy = unit.y;
    unit.x = plan.x; unit.y = plan.y; // 在目标位置估算命中与伤害
    try {
        switch (plan.kind) {
            case 'attack': {
                const t = getUnit(b, plan.target.uid);
                const preview = exchangePreview(b, unit, t, rules);
                const dmg = preview.damage;
                return `${go}普通攻击 ${name(t)}（命中 ${hitChance(b, unit, t, rules)}%，伤害约 ${dmg}${dmg >= t.hp ? '，可击败' : ''}${canBrace(t, rules) ? '' : '，目标韧性耗尽无法招架'}${preview.firstStrike ? `；目标先攻，若受到约${preview.counter}点伤害后存活才出手` : ''}）`;
            }
            case 'skill': {
                const sk = plan.skill;
                const aff = skillAffected(b, unit, sk, plan.tx, plan.ty);
                const who = aff.map(t => {
                    const bits = [];
                    const hit = skillHitChance(b, unit, sk, t, rules);
                    if (hit < 100) bits.push(`命中${hit}%`);
                    if (sk.kind !== 'support') bits.push(`伤害约${exchangePreview(b, unit, t, rules, sk).damage}`);
                    if (!isFoe(t, unit)) bits.unshift('误伤友军');
                    return `${name(t)}${bits.length ? `（${bits.join('，')}）` : ''}`;
                });
                return `${go}使用【${sk.name}】${sk.attackMode === 'mapLine' ? 'MAP直线，不反击；' : sk.attackMode === 'mapArea' ? 'MAP范围，不反击；' : ''}作用于 ${who.join('、')}`;
            }
            case 'move':
                if (plan.flee) return `逃离敌人，移动到 ${pos(plan.x, plan.y)}${terrainAt(b, plan.x, plan.y).name}`;
                if (plan.cautious) return `保持距离前进，移动到 ${pos(plan.x, plan.y)}${terrainAt(b, plan.x, plan.y).name}（尽量停在敌人攻击范围外）`;
                return `向 ${name(plan.toward)} 前进，移动到 ${pos(plan.x, plan.y)}${terrainAt(b, plan.x, plan.y).name}`;
            default:
                return '原地待命，不行动';
        }
    } finally {
        unit.x = ox; unit.y = oy;
    }
}

/**
 * 为一组 AI 单位生成选项与提示词
 * @returns {{prompt:string, options: Map<string, object[]>}} options: uid -> 行动列表
 */
export function buildCommanderPrompt(b, side, group, rules, { limit = 6, context = '', intent = true } = {}) {
    const labels = unitLabels(b);
    const options = new Map();
    const lines = [
        `[Tavern-SRPG 战术指挥｜第 ${b.turn} 回合 · ${SIDE_NAMES[side]}阶段]`,
        `你现在指挥${SIDE_NAMES[side]}的单位。请结合当前剧情、各角色的性格与动机以及战场局势，为每个单位选择本回合的行动。`,
        '选项由战斗系统根据规则生成，全部可以执行；命中与伤害为估算值。',
    ];
    if (context) lines.push('', context);
    lines.push('', '## 可选行动');
    for (const u of group) {
        const opts = aiOptions(b, u, rules, limit);
        if (!opts.length) continue;
        options.set(u.uid, opts);
        const attracted = attractionTargets(b, u);
        if (attracted.length) lines.push(`特质优先目标：${attracted.map(t => `${t.name}[${labels[t.uid]}]`).join('、')}。如果存在可执行且能命中的攻击，优先攻击这些目标；无法攻击时可选择其他行动。`);
        lines.push(`${labels[u.uid]} ${u.name}（HP ${u.hp}/${u.maxHp}，位于 ${pos(u.x, u.y)}）：`);
        opts.forEach((p, i) => lines.push(`  ${i + 1}. ${describePlan(b, u, p, rules, labels)}`));
    }
    lines.push('', '## 回复格式');
    lines.push('每行一个单位，只写编号和选项序号，不要输出其他内容：');
    const sample = [...options.keys()].slice(0, 2).map(uid => labels[uid]);
    lines.push(intent
        ? `${sample[0] || 'E1'}: 选项序号 | 一句话说明意图（会写进战斗描写，可省略）`
        : `${sample[0] || 'E1'}: 选项序号`);
    lines.push('单位按上面的顺序依次行动。写 0 表示交给战斗系统自动决定。');
    return { prompt: lines.join('\n'), options };
}

/**
 * 解析指挥官的回复
 * @returns {Map<string, {index:number, intent:string}>} uid -> 选择（index 从 1 开始，0 = 自动）
 */
export function parseCommanderReply(b, text) {
    const labels = unitLabels(b);
    const byLabel = new Map(Object.entries(labels).map(([uid, l]) => [l.toUpperCase(), uid]));
    const out = new Map();
    const re = /\b([PAE]\d+)\b[^\d\n]{0,12}?(\d+)[^\S\n]*(?:[|｜:：\-—]+[^\S\n]*([^\n]*))?/gi;
    for (const m of String(text || '').matchAll(re)) {
        const uid = byLabel.get(m[1].toUpperCase());
        if (!uid || out.has(uid)) continue;
        out.set(uid, { index: parseInt(m[2], 10), intent: (m[3] || '').trim().replace(/^["“「]|["”」]$/g, '') });
    }
    return out;
}
