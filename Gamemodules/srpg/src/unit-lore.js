// 单位资料：把资料卡中玩家设定的单位整理成类似世界书条目的文字，按关键词（名字 / 别名 / 绑定的世界书关键词）触发，
// 让聊天 AI 在战斗之外也能读到角色的能力、技能与特质。纯逻辑，不依赖 SillyTavern。
import { traitSummary, SIDE_NAMES, DEFAULT_VISION } from './engine.js';
import { skillSummary } from './narrator.js';

export const UNIT_LORE_HEADER = '[Tavern-SRPG 单位资料：战棋资料卡中设定的角色能力。描写这些角色的能力、装备、技能时与之保持一致；战斗进行中的实时数值以战场状态为准。]';

/** 一个单位的资料文字 */
export function unitLoreText(u, profile, { skills = true } = {}) {
    const type = (profile.unitTypes || []).find(t => t.id === u.typeId);
    const aliases = String(u.aliases || '').split(/[,，、]/).map(x => x.trim()).filter(x => x && x !== u.name);
    const tags = [SIDE_NAMES[u.side] || u.side];
    if (u.kind === 'object') tags.push('建筑');
    if (type) tags.push(`兵种：${type.name}${type.desc ? `（${type.desc}）` : ''}`);
    if (u.keyTarget) tags.push('关键目标');
    const lines = [`【${u.name}】${aliases.length ? `（又名：${aliases.join('、')}）` : ''}${tags.join('｜')}`];
    if (u.kind === 'object') {
        lines.push(`  HP ${u.hp} DEF ${u.def} MDEF ${u.mdef}｜不会行动`);
    } else {
        const air = [u.flying && '飞行', u.antiAir && '普通攻击可对空'].filter(Boolean);
        const weapon = u.weaponName ? `｜武器：${u.weaponName}${u.attackOrder === 'last' ? '（后手）' : ''}` : '';
        lines.push(`  HP ${u.hp} ATK ${u.atk} MATK ${u.matk} DEF ${u.def} MDEF ${u.mdef} AGI ${u.agi} MOV ${u.mov} 韧性 ${u.tough ?? 2} 视野 ${u.vision ?? DEFAULT_VISION}`
            + `｜${u.atkType === 'magical' ? '魔法' : '物理'}攻击 射程${u.rangeMin === u.rangeMax ? u.rangeMax : `${u.rangeMin}-${u.rangeMax}`}${weapon}${air.length ? `｜${air.join('、')}` : ''}`);
    }
    for (const t of u.traits || []) lines.push(`  特质【${t.name}】${traitSummary(t)}${t.desc ? `：${t.desc}` : ''}`);
    if (skills && u.kind !== 'object' && u.skills?.length) {
        lines.push(`  技能：${u.skills.map(s => `${s.name}（${skillSummary(s)}）${s.desc ? `——${s.desc}` : ''}`).join('；')}`);
    }
    return lines.join('\n');
}

/**
 * 资料卡里要提供给 AI 的单位条目
 * @param {object} o
 * @param {'party'|'all'} [o.scope] party：我方与友军
 * @param {Set<string>} [o.exclude] 不提供的单位（例如已经在战场信息里的单位）
 * @param {(s:string)=>string} [o.subst] 替换别名中的 {{user}} {{char}}
 * @returns {{id:string, name:string, keys:string[], text:string}[]}
 */
export function unitLoreList(profile, { scope = 'party', exclude = new Set(), subst = s => s, skills = true } = {}) {
    return (profile?.units || [])
        .filter(u => (scope === 'all' || u.side !== 'enemy') && !exclude.has(u.id))
        .map(u => {
            const aliases = String(subst(u.aliases || '')).split(/[,，、]/).map(x => x.trim());
            const keys = [...new Set([u.name, ...aliases, ...(u.wb?.keys || [])].map(k => String(k || '').trim()).filter(Boolean))];
            return { id: u.id, name: u.name, keys, text: subst(unitLoreText(u, profile, { skills })) };
        });
}

/** 关键词是否出现在文字中；单个字的别名容易误触发，只有作为完整名字时才算 */
export function loreTriggered(entry, text) {
    const hay = String(text || '').toLowerCase();
    return entry.keys.some(k => (k.length >= 2 || k === entry.name) && hay.includes(k.toLowerCase()));
}

/**
 * 本次生成要注入的文字
 * @param {'keyword'|'constant'} trigger keyword：最近的聊天里提到才注入；constant：总是注入
 * @returns {{text:string, used:string[]}}
 */
export function buildUnitLore(list, { trigger = 'keyword', scanText = '' } = {}) {
    const used = trigger === 'constant' ? list : list.filter(e => loreTriggered(e, scanText));
    return { text: used.length ? [UNIT_LORE_HEADER, ...used.map(e => e.text)].join('\n') : '', used: used.map(e => e.name) };
}
