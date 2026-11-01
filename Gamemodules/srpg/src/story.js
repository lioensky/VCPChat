// 剧情同步（纯逻辑）：插件 LLM 读取聊天记录的范围与提示词、角色成长的提示词 / 校验 / 差异 / 应用
import { uid } from './defaults.js';
import { normalizeSkill, SIDE_NAMES } from './engine.js';
import { SCHEMA, designRules, existingContent, normalizeDesign, applyDesign, skillFrom, traitFrom, int, str, bool, pick, arr } from './designer.js';
import { skillSummary } from './narrator.js';

export const STORY_KINDS = { grow: '角色成长', battle: '剧情关卡' };
export const SYNC_TRIGGERS = { interval: '每隔几轮对话自动同步', manual: '只在我点击时同步' };

// ---------------------------------------------------------------- 剧情同步：读取范围

/** AI 回复的楼层数（after, upto]：用来判断「每隔几轮」 */
export function countReplies(chat, after = -1, upto = (chat?.length ?? 0) - 1) {
    let n = 0;
    for (let i = Math.max(0, after + 1); i <= upto && i < (chat?.length ?? 0); i++) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system) n++;
    }
    return n;
}

/**
 * 这次同步读哪些楼层：最多 depth 层，以 to 结尾；from 之前的楼层已经同步过，只作参考
 * @returns {{start:number, from:number, to:number, skipped:number}} skipped：太早、没能读到的未同步楼层数
 */
export function syncWindow({ syncedTo = -1, to, depth = 20, from = null }) {
    const start = Math.max(0, to - Math.max(1, depth) + 1);
    let f = Math.max(0, from ?? (syncedTo + 1));
    const skipped = Math.max(0, start - f);
    if (f < start) f = start;
    return { start, from: f, to, skipped };
}

// ---------------------------------------------------------------- 角色成长：提示词

const GROWTH_SCHEMA = `{
  "updates": [{
    "unit": "要修改的已有单位名",
    "reason": "剧情依据（一句话）",
    "changes": { "hp": 36, "atk": 14, "matk": 6, "def": 9, "mdef": 4, "agi": 5, "mov": 5, "tough": 3, "vision": 4, "rangeMin": 1, "rangeMax": 1,
      "atkType": "physical|magical", "attackOrder": "normal|last", "weaponName": "新武器名", "flying": false, "antiAir": false, "type": "兵种名", "aliases": "故事中的称呼" },
    "addSkills": [ 技能，格式同下方 units[].skills ],
    "editSkills": [{ "name": "原技能名", "newName": "改名（可省略）", ...只写需要修改的技能字段 }],
    "removeSkills": ["要移除的技能名"],
    "addTraits": [ 特质，格式同下方 units[].traits ],
    "removeTraits": ["要移除的特质名"]
  }],
  "newUnits": [ 新加入的单位，格式同下方 units ],
  "unitTypes": [ 需要的新兵种（可省略） ]
}`;

const SKILL_FIELDS = ['name', 'kind', 'target', 'power', 'rangeMin', 'rangeMax', 'radius', 'attackMode', 'lineLength', 'mapTargets', 'cooldown', 'uses', 'hitMod', 'sureHit', 'quick', 'antiAir', 'desc'];

/** 比较技能是否真的有变化（旧技能可能缺少新版字段） */
function skillKey(sk) {
    return JSON.stringify([...SKILL_FIELDS.map(k => sk[k] == null || sk[k] === false || sk[k] === '' ? null : sk[k]),
        (sk.effects || []).map(e => [e.type, Number(e.value) || 0, Number(e.turns) || 0])]);
}

/** 给 AI 看的单位完整资料（用于精确修改） */
function unitSheet(u, types) {
    const type = types.find(t => t.id === u.typeId)?.name || '';
    return JSON.stringify({
        name: u.name, side: u.side, type: type || undefined, aliases: u.aliases || undefined,
        hp: u.hp, atk: u.atk, matk: u.matk, def: u.def, mdef: u.mdef, agi: u.agi, mov: u.mov, tough: u.tough, vision: u.vision,
        rangeMin: u.rangeMin, rangeMax: u.rangeMax, atkType: u.atkType, attackOrder: u.attackOrder, weaponName: u.weaponName || undefined,
        flying: u.flying || undefined, antiAir: u.antiAir || undefined,
        traits: (u.traits || []).map(t => ({ name: t.name, desc: t.desc, effects: t.effects })),
        skills: (u.skills || []).map(s => ({ name: s.name, kind: s.kind, target: s.kind === 'support' ? s.target : undefined, power: s.kind === 'support' ? undefined : s.power,
            rangeMin: s.rangeMin, rangeMax: s.rangeMax, radius: s.radius || undefined, attackMode: s.attackMode !== 'normal' ? s.attackMode : undefined,
            cooldown: s.cooldown || undefined, uses: s.uses || undefined, effects: s.effects?.length ? s.effects : undefined, desc: s.desc || undefined })),
    });
}

const GROWTH_RULES = [
    '只修改剧情明确支持的部分：学会新能力就加技能，装备了新武器就改武器和相应属性，修行成长就小幅提高属性；没有发生变化的角色不要输出。',
    '成长要克制：一次剧情事件一般只让属性提高 1–3 点，新技能的强度与角色现有技能相当；能力要符合世界观设定（世界书与角色设定）。',
    '新同伴加入时放在 newUnits 里（side 为 player 或 ally），数值参考同等级的已有我方单位。',
];

/** 字段格式与规则说明（成长与剧情同步共用） */
function formatRef(profile) {
    return ['', '## 单位、技能、特质的字段格式', SCHEMA, '', '## 规则说明', ...designRules(profile.rules || {})];
}

/** 世界观资料与可以修改的单位（成长与剧情同步共用） */
function profileContext(profile, { scope = 'party', lore = '', character = '' } = {}) {
    const types = profile.unitTypes || [];
    const candidates = (profile.units || []).filter(u => u.kind !== 'object' && (scope === 'all' || u.side !== 'enemy'));
    const ctx = [];
    if (character) ctx.push('## 角色卡设定', character, '');
    if (lore) ctx.push('## 世界书（世界观设定）', lore, '');
    ctx.push(...existingContent(profile), '');
    ctx.push('## 可以修改的单位（当前完整资料）', ...candidates.map(u => unitSheet(u, types)), '');
    return ctx;
}

/**
 * @param {object} profile
 * @param {object} o
 * @param {string} o.hint 用户写的说明，例如「艾琳学会了星落」
 * @param {'party'|'all'} [o.scope] 可以修改哪些单位
 */
export function buildGrowthPrompt(profile, { hint = '', scope = 'party', chat = '', lore = '', character = '', previous = '', feedback = '' } = {}) {
    const system = [
        '你是 SRPG（战棋）的成长设计师。根据剧情的发展，更新资料卡中角色的属性、技能和特质，或者加入新的同伴。',
        ...GROWTH_RULES,
        '只输出一个 JSON 对象，不要输出任何解释；可以放在 ```json 代码块中。',
        '',
        '## 输出格式',
        GROWTH_SCHEMA,
        'changes 中写修改后的新数值（不是增量），只写有变化的字段。',
        ...formatRef(profile),
    ].join('\n');
    const ctx = profileContext(profile, { scope, lore, character });
    if (chat) ctx.push('## 最近的剧情（聊天记录，越靠后越新）', chat, '');
    ctx.push('## 本次要处理的剧情事件', hint.trim() || '根据最近的剧情，找出我方角色发生的成长或变化。');
    if (previous) ctx.push('', '## 上一版修改', previous, '', '## 修改意见', feedback.trim() || '请改进上一版。', '请输出修改后的完整 JSON。');
    return { system, user: ctx.join('\n') };
}

// ---------------------------------------------------------------- 剧情同步：提示词与解析

/**
 * 剧情同步：插件 LLM 读一段聊天记录，找出角色成长、即将开始的战斗和战场变化。
 * 聊天 AI 不需要写任何标记，插件与聊天互不干扰。
 * @param {object} o
 * @param {string} o.before 已经同步过的楼层（只作参考）
 * @param {string} o.fresh 这次要同步的楼层
 * @param {boolean} [o.allowBattle] 允许提出剧情关卡（已有进行中的战斗时为 false）
 * @param {string} [o.battle] 进行中战斗的战场信息
 * @param {string} [o.commands] 战场变化的写法（commandGuide）；为空时不提出战场变化
 */
export function buildSyncPrompt(profile, { before = '', fresh = '', lore = '', character = '', allowBattle = true, battle = '', commands = '', scope = 'party' } = {}) {
    const tasks = ['1. 角色成长（growth）：我方角色学会了新能力或技能、得到或失去装备、实力成长或受到长期削弱、新的同伴加入我方。'];
    if (allowBattle) tasks.push(`${tasks.length + 1}. 剧情关卡（battle）：剧情即将进入一场需要在战棋棋盘上进行的战斗（双方已经对峙、即将开打）。只是提到、回忆或已经结束的战斗不算。`);
    if (commands) tasks.push(`${tasks.length + 1}. 战场变化（battleChanges）：战斗进行中，剧情本身让战场发生了常规攻击与技能之外的变化（落石、喝下药水、援军赶到、桥被砍断等）。`);
    const system = [
        '你是 SRPG（战棋）插件的剧情同步助手。你会读到一段角色扮演的聊天记录，从中找出需要同步到战棋资料的变化。你不参与对话，也不续写剧情。',
        '需要找出的变化：',
        ...tasks,
        '只处理「新的剧情」；「之前的剧情」只用来理解上下文，那里的事件已经同步过，不要重复。资料中已经有的能力、装备、同伴不要重复添加。',
        ...GROWTH_RULES,
        '没有变化时对应字段留空；绝大多数对话都没有变化，不要为了输出而编造。',
        '只输出一个 JSON 对象，不要输出任何解释；可以放在 ```json 代码块中。',
        '',
        '## 输出格式',
        '{',
        '  "summary": "一句话说明新的剧情里与战棋有关的变化，没有就写“无”",',
        `  "growth": ${GROWTH_SCHEMA.replace(/\n/g, '\n  ')}${allowBattle || commands ? ',' : ''}`,
        allowBattle ? `  "battle": null 或 { "place": "战斗地点", "summary": "敌人是谁、我方哪些角色出场、局势如何（一两句话）" }${commands ? ',' : ''}` : null,
        commands ? '  "battleChanges": ["指令", …]' : null,
        '}',
        'growth.changes 中写修改后的新数值（不是增量），只写有变化的字段；没有成长时 growth 写 {"updates": [], "newUnits": []}。',
        commands ? ['', commands].join('\n') : null,
        ...formatRef(profile),
    ].filter(x => x != null).join('\n');
    const ctx = profileContext(profile, { scope, lore, character });
    if (battle) ctx.push('## 进行中的战斗（战场状态由战斗系统计算）', battle, '');
    if (before) ctx.push('## 之前的剧情（已经同步过，只作参考）', before, '');
    ctx.push('## 新的剧情（只处理这一部分）', fresh || '（无）');
    return { system, user: ctx.join('\n') };
}

/**
 * 解析剧情同步的回复
 * @returns {{summary:string, growth:object|null, battle:{subject:string, text:string}|null, commands:string[]}}
 */
export function normalizeSync(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const g = r.growth && typeof r.growth === 'object' ? r.growth : (r.updates || r.newUnits ? r : null);
    const growth = g && (arr(g.updates).length || arr(g.newUnits ?? g.units).length) ? g : null;
    const bt = r.battle && typeof r.battle === 'object' ? r.battle : null;
    const battle = bt && (str(bt.place) || str(bt.summary)) ? { subject: str(bt.place) || '剧情战斗', text: str(bt.summary) } : null;
    const commands = arr(r.battleChanges).map(c => str(typeof c === 'string' ? c : c?.command)).filter(Boolean);
    const summary = str(r.summary).replace(/^无[。.]?$/, '');
    return { summary, growth, battle, commands };
}

// ---------------------------------------------------------------- 角色成长：校验与差异

const NUMBERS = { hp: ['HP', 1, 9999], atk: ['ATK', 0, 999], matk: ['MATK', 0, 999], def: ['DEF', 0, 999], mdef: ['MDEF', 0, 999], agi: ['AGI', 0, 999], mov: ['MOV', 0, 20],
    tough: ['韧性', 0, 10], vision: ['视野', 0, 20], rangeMin: ['最小射程', 1, 20], rangeMax: ['最大射程', 1, 20] };
const FIELD_LABELS = { atkType: '攻击类型', attackOrder: '攻击顺序', weaponName: '武器', flying: '飞行', antiAir: '普通攻击对空', typeId: '兵种', aliases: '别名' };

function findUnit(profile, name) {
    const n = str(name);
    const units = profile.units || [];
    return units.find(u => u.name === n) || units.find(u => u.name.toLowerCase() === n.toLowerCase())
        || units.find(u => String(u.aliases || '').split(/[,，、]/).map(x => x.trim()).includes(n)) || null;
}

/**
 * 把模型给出的成长转换成可预览、可应用的修改
 * @returns {{updates:object[], design:{unitTypes:object[], terrains:[], units:object[], maps:[], warnings:string[]}, warnings:string[]}}
 */
export function normalizeGrowth(raw, profile, { entries = [] } = {}) {
    const warnings = [];
    const design = normalizeDesign({ units: raw.newUnits || raw.units, unitTypes: raw.unitTypes }, profile, { entries });
    warnings.push(...design.warnings);
    const types = [...(profile.unitTypes || []), ...design.unitTypes];
    const updates = [];
    for (const r of arr(raw.updates)) {
        const u = findUnit(profile, r?.unit ?? r?.name);
        if (!u) { warnings.push(`成长对象「${str(r?.unit ?? r?.name)}」不在资料卡中，已忽略（新同伴请放在 newUnits）`); continue; }
        if (u.kind === 'object') { warnings.push(`「${u.name}」是建筑，不能成长`); continue; }
        const c = r.changes || r.stats || {};
        const patch = {};
        for (const [k, [, min, max]] of Object.entries(NUMBERS)) if (k in c) {
            const v = int(c[k], u[k], min, max);
            if (v !== u[k]) patch[k] = v;
        }
        const rmin = patch.rangeMin ?? u.rangeMin, rmax = patch.rangeMax ?? u.rangeMax;
        if (rmax < rmin) patch.rangeMax = rmin;
        if ('atkType' in c && pick(c.atkType, ['physical', 'magical'], u.atkType) !== u.atkType) patch.atkType = c.atkType;
        if ('attackOrder' in c && pick(c.attackOrder, ['normal', 'last'], u.attackOrder) !== u.attackOrder) patch.attackOrder = c.attackOrder;
        if ('weaponName' in c && str(c.weaponName) !== (u.weaponName || '')) patch.weaponName = str(c.weaponName);
        if ('aliases' in c && str(c.aliases) !== (u.aliases || '')) patch.aliases = str(c.aliases);
        for (const k of ['flying', 'antiAir']) if (k in c && bool(c[k]) !== !!u[k]) patch[k] = bool(c[k]);
        if ('type' in c) {
            const t = str(c.type) ? types.find(x => x.name === str(c.type)) : null;
            if (str(c.type) && !t) warnings.push(`「${u.name}」的新兵种「${str(c.type)}」不存在，已忽略`);
            else if ((t?.id || '') !== (u.typeId || '')) patch.typeId = t?.id || '';
        }

        const removeSkills = arr(r.removeSkills).map(n => u.skills.find(s => s.name === str(n?.name ?? n)) || (warnings.push(`「${u.name}」没有技能「${str(n?.name ?? n)}」，无法移除`), null)).filter(Boolean);
        const editSkills = [];
        const edit = (old, fields) => {
            const merged = skillFrom({ ...structuredClone(old), ...fields, name: str(fields.newName) || old.name }, u, warnings);
            if (!merged) return;
            merged.id = old.id;
            if (skillKey(merged) !== skillKey(normalizeSkill(structuredClone(old)))) editSkills.push({ id: old.id, before: old, after: merged });
        };
        for (const e of arr(r.editSkills)) {
            const old = u.skills.find(s => s.name === str(e?.name));
            if (!old) { warnings.push(`「${u.name}」没有技能「${str(e?.name)}」，无法修改`); continue; }
            edit(old, e);
        }
        const addSkills = [];
        for (const sk of arr(r.addSkills)) {
            const same = u.skills.find(s => s.name === str(sk?.name));
            if (same) { edit(same, sk); continue; } // 同名技能视为升级
            const made = skillFrom(sk, u, warnings);
            if (made) addSkills.push(made);
        }
        const removeTraits = arr(r.removeTraits).map(n => (u.traits || []).find(t => t.name === str(n?.name ?? n)) || (warnings.push(`「${u.name}」没有特质「${str(n?.name ?? n)}」，无法移除`), null)).filter(Boolean);
        const addTraits = arr(r.addTraits).map(t => traitFrom(t, u, warnings)).filter(t => t.effects.length || t.desc);

        const update = { id: uid('grow'), unitId: u.id, unitName: u.name, reason: str(r.reason), patch, addSkills, editSkills,
            removeSkills: removeSkills.map(s => ({ id: s.id, name: s.name })), addTraits, removeTraits: removeTraits.map(t => ({ id: t.id, name: t.name })) };
        if (!growthLines(update, u, types).length) { warnings.push(`「${u.name}」的修改与现有资料相同，已忽略`); continue; }
        updates.push(update);
    }
    return { updates, design, warnings };
}

/** 一条成长的可读说明（用于预览、提示和记录） */
export function growthLines(update, unit, types = []) {
    const lines = [];
    const typeName = id => types.find(t => t.id === id)?.name || '无兵种';
    for (const [k, v] of Object.entries(update.patch)) {
        if (NUMBERS[k]) lines.push(`${NUMBERS[k][0]} ${unit[k]} → ${v}`);
        else if (k === 'typeId') lines.push(`兵种 ${typeName(unit.typeId)} → ${typeName(v)}`);
        else if (typeof v === 'boolean') lines.push(`${FIELD_LABELS[k]}：${v ? '是' : '否'}`);
        else lines.push(`${FIELD_LABELS[k]}：${unit[k] || '无'} → ${v || '无'}`);
    }
    for (const s of update.addSkills) lines.push(`学会技能【${s.name}】${skillSummary(s)}${s.desc ? `｜${s.desc}` : ''}`);
    for (const e of update.editSkills) lines.push(`技能【${e.before.name}】${e.after.name !== e.before.name ? `→【${e.after.name}】` : ''}：${skillSummary(e.before)}  ⇒  ${skillSummary(e.after)}`);
    for (const s of update.removeSkills) lines.push(`失去技能【${s.name}】`);
    for (const t of update.addTraits) lines.push(`获得特质【${t.name}】${t.desc ? `：${t.desc}` : ''}`);
    for (const t of update.removeTraits) lines.push(`失去特质【${t.name}】`);
    return lines;
}

// ---------------------------------------------------------------- 角色成长：应用

function patchSkills(list, update, battle = false) {
    const removed = new Set(update.removeSkills.map(s => s.id));
    let out = list.filter(s => !removed.has(s.id));
    for (const e of update.editSkills) {
        out = out.map(s => s.id !== e.id ? s : battle
            // 战斗中升级的技能：保留冷却，剩余次数不超过新的次数上限
            ? { ...structuredClone(e.after), usesLeft: Number(e.after.uses) ? Math.min(s.usesLeft ?? Number(e.after.uses), Number(e.after.uses)) : 0, cdLeft: s.cdLeft || 0 }
            : structuredClone(e.after));
    }
    for (const s of update.addSkills) out.push(battle ? { ...structuredClone(s), usesLeft: Number(s.uses) || 0, cdLeft: 0 } : structuredClone(s));
    return out;
}

function patchTraits(list, update) {
    const removed = new Set(update.removeTraits.map(t => t.id));
    return [...(list || []).filter(t => !removed.has(t.id)), ...update.addTraits.map(t => structuredClone(t))];
}

/**
 * 应用选中的成长与新同伴
 * @param {Set<string>} chosen 成长 id 与新单位 id
 * @param {object|null} battle 进行中的战斗：同步修改场上来自同一单位的棋子
 * @returns {{before: object[], lines: string[], added: number, synced: number, newIds: string[]}} before：修改前的单位，newIds：新加入的单位（用于撤销）
 */
export function applyGrowth(profile, growth, chosen, battle = null) {
    const before = [], lines = [];
    let synced = 0;
    for (const upd of growth.updates.filter(x => chosen.has(x.id))) {
        const u = profile.units.find(x => x.id === upd.unitId);
        if (!u) continue;
        before.push(structuredClone(u));
        lines.push(...growthLines(upd, u, profile.unitTypes || []).map(l => `${u.name}：${l}`));
        Object.assign(u, upd.patch);
        u.skills = patchSkills(u.skills || [], upd);
        u.traits = patchTraits(u.traits, upd);
        for (const bu of battle?.units?.filter(x => x.defId === u.id && !x.object) || []) {
            for (const [k, v] of Object.entries(upd.patch)) {
                if (k === 'hp') { const d = v - bu.maxHp; bu.maxHp = v; if (bu.hp > 0) bu.hp = Math.max(1, Math.min(v, bu.hp + Math.max(0, d))); }
                else if (k === 'tough') { bu.toughMax = v; bu.tough = Math.min(v, bu.tough ?? v); }
                else bu[k] = v;
            }
            bu.skills = patchSkills(bu.skills || [], upd, true);
            bu.traits = patchTraits(bu.traits, upd);
            synced++;
        }
    }
    const newIds = new Set(growth.design.units.filter(x => chosen.has(x.id)).map(x => x.id));
    const { ids } = newIds.size ? applyDesign(profile, growth.design, newIds) : { ids: [] };
    for (const id of ids) {
        const n = growth.design.units.find(x => x.id === id);
        if (n) lines.push(`${n.name}加入了${SIDE_NAMES[n.side]}`);
    }
    return { before, lines, added: newIds.size, synced, newIds: ids };
}

/** 撤销成长：把单位恢复成修改前的资料，移除新加入且没有被地图使用的单位（进行中的战斗不回退） */
export function revertGrowth(profile, before, newIds = []) {
    let n = 0;
    const used = new Set((profile.maps || []).flatMap(m => [...(m.placements || []), ...(m.reinforcements || [])].map(p => p.unitId)));
    profile.units = profile.units.filter(u => !newIds.includes(u.id) || used.has(u.id));
    for (const old of before || []) {
        const i = profile.units.findIndex(u => u.id === old.id);
        if (i >= 0) { profile.units[i] = structuredClone(old); n++; }
    }
    return n;
}

/** 成长结果的条目 id（默认全选） */
export function growthIds(growth) {
    return [...growth.updates.map(x => x.id), ...growth.design.units.map(x => x.id)];
}

export function growthSummary(growth) {
    const bits = [];
    if (growth.updates.length) bits.push(`${growth.updates.length} 个单位成长`);
    if (growth.design.units.length) bits.push(`${growth.design.units.length} 个新单位`);
    return bits.join(' · ') || '没有变化';
}
