// AI 设计助手（纯逻辑）：生成提示词、解析回复、校验并转换成资料卡数据、导入资料卡
import { makeUnit, makeSkill, makeMap, makeWave, makeUnitType, makeTrait, uid } from './defaults.js';
import { EFFECTS, TRAIT_EFFECTS, MISSION_NAMES, normalizeSkill, enterCost, validateMission, DEFAULT_VISION } from './engine.js';

export const DESIGN_TASKS = {
    story: '根据剧情创建关卡',
    growth: '根据剧情更新单位（成长、新技能、新同伴）',
    battle: '整场战斗（地图＋需要的单位、地形、兵种）',
    map: '地图',
    units: '单位',
    terrains: '地形',
    types: '兵种与克制',
};

const SIDES = ['player', 'enemy', 'ally'];
const AIS = ['aggressive', 'defensive', 'stationary', 'ranged', 'flee'];
const KEYS = ['unitTypes', 'terrains', 'units', 'maps'];
export const DESIGN_LABELS = { unitTypes: '兵种', terrains: '地形', units: '单位', maps: '地图' };

// ---------------------------------------------------------------- 提示词

function effectList(defs) {
    return Object.entries(defs).map(([id, d]) => `${id}（${d.name}${d.noValue ? '' : `，数值单位：${d.unit || ''}`}${d.instant ? '，立即生效' : ''}）`).join('；');
}

function terrainLine(t) {
    const bits = [`移动消耗${t.moveCost ?? 1}`];
    if (t.passable === false) bits.push(t.flyable === false ? '不可通过' : '仅飞行可过');
    if (Number(t.defBonus)) bits.push(`减伤${t.defBonus}%`);
    if (Number(t.avoid)) bits.push(`闪避${t.avoid}%`);
    if (Number(t.healPct)) bits.push(`回复${t.healPct}%`);
    if (Number(t.enterDamage) || Number(t.turnDamagePct)) bits.push('有地形伤害');
    if (Number(t.visionBonus)) bits.push(`视野+${t.visionBonus}`);
    if (Number(t.conceal)) bits.push(`隐蔽${t.conceal}`);
    if (t.blockSight) bits.push('遮挡视线');
    return `- ${t.name}（${bits.join('，')}）${t.desc ? `：${t.desc}` : ''}`;
}

function unitLine(u, types) {
    const type = types.find(t => t.id === u.typeId)?.name;
    const stats = u.kind === 'object' ? `HP${u.hp} DEF${u.def} MDEF${u.mdef}` : `HP${u.hp} ATK${u.atk} MATK${u.matk} DEF${u.def} MDEF${u.mdef} AGI${u.agi} MOV${u.mov} 射程${u.rangeMin}-${u.rangeMax}`;
    const skills = (u.skills || []).map(s => s.name).join('、');
    const air = [u.flying && '飞行', u.antiAir && '普通攻击可对空'].filter(Boolean).join('、');
    return `- ${u.name}｜${{ player: '我方', enemy: '敌方', ally: '友军' }[u.side]}${u.kind === 'object' ? '｜建筑' : ''}${type ? `｜兵种：${type}` : ''}｜${stats}${air ? `｜${air}` : ''}${skills ? `｜技能：${skills}` : ''}`;
}

/** 伤害、命中、效果预设、对空等规则说明（设计与成长共用） */
export function designRules(rules = {}) {
    return [
        `- 伤害：${rules.formula === 'diminishing' || !rules.formula ? `攻击 × 威力% × ${rules.defenseScale || 12} ÷ (${rules.defenseScale || 12} + 防御)，物理用 ATK/DEF，魔法用 MATK/MDEF` : rules.formula === 'ratio' ? '比例公式 a²/(a+防御)' : '攻击 − 防御'}。命中率＝${rules.baseHit ?? 90}% + (攻方AGI − 守方AGI) × ${rules.agiFactor ?? 3}% − 地形闪避。`,
        '- 韧性 tough：每次防御或反击消耗 1 点；视野 vision：战争迷雾中能看到几格（默认 4，侦察兵 6–8，建筑 0）。',
        '- 建筑（kind=object，如城门、水晶）只有 hp / def / mdef，不会行动；keyTarget=true 的是关键目标（守城战要保护的我方目标、进攻战要摧毁的敌方目标）。',
        '- 任务 mission.type：annihilate 歼灭（turns 为回合限制，0 不限）；defend 守城（需要我方关键目标，turns 为坚守回合）；assault 进攻（需要敌方关键目标）。',
        '- AI 行为 ai：aggressive 主动出击、defensive 原地迎击、stationary 固守不动、ranged 远程游击、flee 逃跑。',
        '- 技能 kind=support 为辅助，target 决定作用对象（tile＝传送到空地）；伤害技能的 power 为威力百分比。cooldown 为冷却回合。',
        `- 技能效果 type 只能从以下预设中选：${effectList(EFFECTS)}。`,
        `- 特质效果 type 只能从以下预设中选：${effectList(TRAIT_EFFECTS)}；属性类效果 flat=true 时为固定值，否则为百分比。`,
        `- 对空：单位的 antiAir＝普通攻击可以打到飞行单位（弓箭手等），技能的 antiAir＝该技能可以打到飞行单位（火球、箭雨等）。${rules.airTarget === 'antiAir' ? '当前规则：飞行单位只能被对空攻击或其他飞行单位打到，请给远程、对空类单位和技能设置 antiAir，并确保有飞行敌人时我方有对空手段。' : '当前规则下任何攻击都能打到飞行单位，antiAir 只在以后开启对空规则时生效。'}`,
        '- 兵种克制 vs：dmg 伤害倍率%（100 不变），hit 命中修正%，tough 被攻击方招架时消耗的韧性倍数（默认 1）。',
        '- 地图坐标 x、y 从 1 开始（x 列从左到右，y 行从上到下）。rows 的每个字符都必须出现在 legend 里，legend 的值是地形名（已有或本次新建的）。',
        '- 地形属性：moveCost 移动消耗；passable 步行可通过；flyable 飞行可通过；avoid 闪避加成%；defBonus 减伤%；healPct 回合回复%；visionBonus 视野加成；conceal 隐蔽距离（单位只能被这么近的敌人发现）；blockSight 遮挡视线。',
        '- 单位放在能站立的格子上，不要两个单位放在同一格；我方通常在一侧，敌方在另一侧，留出接敌的空间。',
        '- wbEntry：如果单位对应世界书里的某个角色或种族条目，写上条目名（与下方世界书标题一致），插件会自动绑定。',
    ];
}

export const SCHEMA = `{
  "unitTypes": [{ "name": "兵种名", "desc": "说明", "color": "#rrggbb",
    "vs": [{ "target": "被攻击的兵种名", "dmg": 150, "hit": 10, "tough": 2 }] }],
  "terrains": [{ "name": "地形名", "symbol": "一个字符", "color": "#rrggbb", "moveCost": 1, "passable": true, "flyable": true,
    "avoid": 0, "defBonus": 0, "healPct": 0, "enterDamage": 0, "enterDamagePct": 0, "turnDamage": 0, "turnDamagePct": 0, "damageFlying": false,
    "visionBonus": 0, "conceal": 0, "blockSight": false, "desc": "给叙事用的描述" }],
  "units": [{ "name": "单位名", "side": "player|enemy|ally", "kind": "unit|object", "type": "兵种名或省略", "icon": "棋子上的一个字", "color": "#rrggbb",
    "aliases": "故事中的称呼，逗号分隔", "keyTarget": false, "wbEntry": "对应的世界书条目名（可省略）",
    "hp": 20, "atk": 8, "matk": 4, "def": 4, "mdef": 3, "agi": 5, "mov": 5, "tough": 2, "vision": 4,
    "rangeMin": 1, "rangeMax": 1, "atkType": "physical|magical", "attackOrder": "normal|last", "weaponName": "", "flying": false, "antiAir": false,
    "ai": "aggressive|defensive|stationary|ranged|flee",
    "traits": [{ "name": "特质名", "desc": "说明", "effects": [{ "type": "特质效果 id", "value": 10, "flat": false }] }],
    "skills": [{ "name": "技能名", "kind": "physical|magical|support", "target": "enemy|ally|self|tile", "power": 150,
      "rangeMin": 1, "rangeMax": 1, "radius": 0, "attackMode": "normal|mapLine|mapArea", "lineLength": 3, "mapTargets": "all|enemy",
      "cooldown": 0, "uses": 0, "hitMod": 0, "sureHit": false, "quick": false, "antiAir": false,
      "effects": [{ "type": "效果 id", "value": 30, "turns": 2 }], "desc": "技能描述" }],
    "notes": "" }],
  "maps": [{ "name": "地图名", "desc": "战场概况", "w": 12, "h": 8,
    "legend": { "字符": "地形名" }, "rows": ["每行正好 w 个字符，共 h 行"],
    "placements": [{ "unit": "单位名", "x": 1, "y": 1 }],
    "mission": { "type": "annihilate|defend|assault", "turns": 0, "lossLimit": 1 },
    "fog": { "enabled": false, "ai": true },
    "reinforcements": [{ "unit": "单位名", "x": 12, "y": 4, "count": 1, "startTurn": 2, "every": 0, "times": 0 }] }]
}`;

const TASK_RULES = {
    story: '根据「最近的剧情」设计一场接下来要发生的战斗：地点、敌人、我方出场角色、任务目标都要与剧情一致（剧情中在场的我方角色才出场）。输出 1 张地图，以及需要的新单位、新地形和兵种；已有的单位和地形直接用名字引用。地图的 name 用剧情中的地点或事件命名，desc 写清战斗的起因与局势。',
    battle: '设计一场完整的战斗：输出 1 张地图，以及这场战斗需要的新单位（我方、敌方，必要时友军和建筑）、新地形和兵种。已有的单位和地形可以直接用名字引用，不必重复输出。',
    map: '设计 1 张地图（maps 数组只放一张）。',
    units: '设计单位，只输出 units；如果用到了不存在的兵种，可以在 unitTypes 里一并给出。不要输出 maps。',
    terrains: '设计地形，只输出 terrains。',
    types: '设计兵种及它们之间的克制关系，只输出 unitTypes。可以把已有兵种作为 vs 的 target。',
};

/** 资料卡已有内容的简表 */
export function existingContent(profile) {
    const types = profile.unitTypes || [];
    const out = ['## 资料卡中已有的内容（可以直接用名字引用）'];
    out.push('地形：', ...(profile.terrains || []).map(terrainLine));
    if (types.length) out.push('兵种：', ...types.map(t => `- ${t.name}${t.desc ? `：${t.desc}` : ''}`));
    if ((profile.units || []).length) out.push('单位：', ...profile.units.map(u => unitLine(u, types)));
    if ((profile.maps || []).length) out.push(`地图：${profile.maps.map(m => `${m.name}（${m.w}×${m.h}，${MISSION_NAMES[m.mission?.type] || '歼灭战'}）`).join('、')}`);
    return out;
}

/**
 * @param {object} profile 当前资料卡
 * @param {object} o
 * @param {string} o.task DESIGN_TASKS 的键
 * @param {string} o.request 用户的要求
 * @param {{w:number,h:number}} [o.size] 地图尺寸
 * @param {boolean} [o.allowNew] 地图任务是否允许新建单位 / 地形 / 兵种
 * @param {string} [o.lore] 世界书内容
 * @param {string} [o.character] 角色卡设定
 * @param {string} [o.previous] 上一版设计（JSON 文本），与 feedback 一起用于修改
 * @param {string} [o.feedback]
 * @returns {{system:string, user:string}}
 */
export function buildDesignPrompt(profile, { task = 'battle', request = '', size = null, allowNew = true, lore = '', character = '', chat = '', previous = '', feedback = '' } = {}) {
    const types = profile.unitTypes || [];
    const rules = profile.rules || {};
    const system = [
        '你是 SRPG（战棋）关卡与单位设计师，为一个 SillyTavern 战棋插件设计游戏内容。',
        '设计必须符合下方提供的世界观设定（世界书与角色设定）：名称、外观、能力、阵营和地形都要贴合这个世界，不要引入设定之外的元素。',
        '数值要和已有内容保持平衡，可参考下方已有单位的数值。',
        '只输出一个 JSON 对象，不要输出任何解释、注释或 Markdown 以外的文字；可以放在 ```json 代码块中。',
        '',
        '## JSON 格式（只输出本次任务需要的字段，其余字段可省略，省略时使用默认值）',
        SCHEMA,
        '',
        '## 规则说明',
        ...designRules(rules),
    ].join('\n');

    const ctx = [];
    if (character) ctx.push('## 角色卡设定', character, '');
    if (lore) ctx.push('## 世界书（世界观设定）', lore, '');
    if (chat) ctx.push('## 最近的剧情（聊天记录，越靠后越新）', chat, '');
    ctx.push(...existingContent(profile));
    ctx.push('', '## 本次任务', TASK_RULES[task] || TASK_RULES.battle);
    if (['battle', 'map', 'story'].includes(task) && size?.w && size?.h) ctx.push(`地图尺寸：宽 ${size.w} × 高 ${size.h}。`);
    if (task === 'map' && !allowNew) ctx.push('只能使用已有的单位和地形，不要输出 units、terrains、unitTypes。');
    if (task === 'map' && allowNew) ctx.push('如果已有的单位或地形不够用，可以在 units、terrains、unitTypes 中新建。');
    if (request.trim()) ctx.push('', '## 用户的要求', request.trim());
    if (previous) {
        ctx.push('', '## 上一版设计', previous);
        ctx.push('', '## 修改意见', feedback.trim() || '请改进上一版设计。', '请输出修改后的完整 JSON（包含所有要保留的内容）。');
    }
    return { system, user: ctx.join('\n') };
}

// ---------------------------------------------------------------- 解析回复

/** 从模型回复中取出 JSON 对象（容忍代码块、思考过程、尾逗号） */
export function parseDesignReply(text) {
    let s = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const start = s.search(/[{[]/);
    if (start < 0) throw new Error('回复中没有找到 JSON');
    const open = s[start], close = open === '{' ? '}' : ']';
    const end = s.lastIndexOf(close);
    if (end <= start) throw new Error('回复中的 JSON 不完整（可能被截断，请提高最大输出长度）');
    const body = s.slice(start, end + 1);
    let data;
    try {
        data = JSON.parse(body);
    } catch {
        try {
            data = JSON.parse(body.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"'));
        } catch (err) {
            throw new Error(`JSON 解析失败：${err.message}`);
        }
    }
    if (Array.isArray(data)) data = { units: data };
    if (!data || typeof data !== 'object') throw new Error('回复不是 JSON 对象');
    return data;
}

// ---------------------------------------------------------------- 校验与转换

export const num = (v, def, min = -Infinity, max = Infinity) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};
export const int = (v, def, min, max) => Math.round(num(v, def, min, max));
export const str = (v, def = '') => (v == null ? def : String(v)).trim();
export const bool = (v, def = false) => (typeof v === 'boolean' ? v : v == null ? def : ['true', '1', 'yes', '是'].includes(String(v).toLowerCase()));
const color = (v, def = '') => /^#[0-9a-f]{6}$/i.test(str(v)) ? str(v) : def;
export const pick = (v, list, def) => list.includes(v) ? v : def;
export const arr = v => Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [];

/** 效果 id：接受 id 或中文名 */
function effectId(defs, v) {
    const s = str(v);
    if (defs[s]) return s;
    return Object.entries(defs).find(([, d]) => d.name === s)?.[0] || null;
}

/** 名称不能与资料卡已有的同类内容重复 */
function uniqueName(name, taken) {
    let n = name, i = 2;
    while (taken.has(n)) n = `${name}（${i++}）`;
    taken.add(n);
    return n;
}

/**
 * 把模型给出的设计转换成资料卡数据。新内容都分配新 id；引用按名字匹配本次新建的内容，其次是资料卡已有的内容。
 * @param {object} raw parseDesignReply 的结果
 * @param {object} profile 当前资料卡
 * @param {{entries?: {book:string, uid:number, label:string, keys:string[]}[]}} [opt] 世界书条目，用于绑定 wbEntry
 * @returns {{unitTypes:object[], terrains:object[], units:object[], maps:object[], warnings:string[]}}
 */
export function normalizeDesign(raw, profile, { entries = [] } = {}) {
    const warnings = [];
    const out = { unitTypes: [], terrains: [], units: [], maps: [], warnings };
    const findBy = (list, name) => list.find(x => x.name === name) || list.find(x => str(x.name).toLowerCase() === str(name).toLowerCase());
    // 新内容与已有内容重名时会改名；设计内的引用仍按模型给出的原名优先指向新内容
    const original = new Map();
    const fresh = (list, name) => list.find(x => original.get(x) === name) || findBy(list, name);

    // 兵种（先建好 id，vs 之后再解析，允许互相引用）
    const typeNames = new Set((profile.unitTypes || []).map(t => t.name));
    const rawTypes = arr(raw.unitTypes);
    for (const r of rawTypes) {
        const name = str(r?.name);
        if (!name) { warnings.push('忽略了一个没有名称的兵种'); continue; }
        const t = makeUnitType({ name: uniqueName(name, typeNames), desc: str(r.desc), color: color(r.color) });
        original.set(t, name);
        out.unitTypes.push(t);
    }
    const typeRef = name => name ? fresh(out.unitTypes, str(name)) || findBy(profile.unitTypes || [], str(name)) || null : null;
    rawTypes.filter(r => str(r?.name)).forEach((r, i) => {
        const t = out.unitTypes[i];
        const vs = Array.isArray(r.vs) ? r.vs : Object.entries(r.vs || {}).map(([target, v]) => ({ target, ...(v || {}) }));
        for (const v of vs) {
            const target = typeRef(v?.target);
            if (!target) { warnings.push(`兵种「${t.name}」的克制对象「${str(v?.target)}」不存在，已忽略`); continue; }
            const m = { dmg: int(v.dmg, 100, 0, 1000), hit: int(v.hit, 0, -100, 100), tough: int(v.tough, 1, 0, 10) };
            if (m.dmg !== 100 || m.hit || m.tough !== 1) t.vs[target.id] = m;
        }
    });

    // 地形
    const terrainNames = new Set((profile.terrains || []).map(t => t.name));
    for (const r of arr(raw.terrains)) {
        const name = str(r?.name);
        if (!name) { warnings.push('忽略了一个没有名称的地形'); continue; }
        original.set(out.terrains[out.terrains.push({}) - 1], name);
        Object.assign(out.terrains.at(-1), {
            id: uid('ter'), name: uniqueName(name, terrainNames), symbol: Array.from(str(r.symbol))[0] || '', color: color(r.color, '#a1887f'),
            moveCost: num(r.moveCost, 1, 0.1, 99), passable: bool(r.passable, true), flyable: bool(r.flyable, true),
            avoid: int(r.avoid, 0, -100, 100), defBonus: int(r.defBonus, 0, -100, 100), healPct: int(r.healPct, 0, 0, 100),
            enterDamage: int(r.enterDamage, 0, 0, 999), enterDamagePct: int(r.enterDamagePct, 0, 0, 100),
            turnDamage: int(r.turnDamage, 0, 0, 999), turnDamagePct: int(r.turnDamagePct, 0, 0, 100), damageFlying: bool(r.damageFlying),
            visionBonus: int(r.visionBonus, 0, -10, 10), conceal: int(r.conceal, 0, 0, 20), blockSight: bool(r.blockSight), desc: str(r.desc),
        });
    }
    const terrainRef = name => fresh(out.terrains, str(name)) || findBy(profile.terrains || [], str(name)) || null;

    // 单位
    const unitNames = new Set((profile.units || []).map(u => u.name));
    for (const r of arr(raw.units)) {
        const name = str(r?.name);
        if (!name) { warnings.push('忽略了一个没有名称的单位'); continue; }
        const object = r.kind === 'object';
        const type = typeRef(r.type ?? r.unitType);
        if (str(r.type ?? r.unitType) && !type) warnings.push(`单位「${name}」的兵种「${str(r.type ?? r.unitType)}」不存在，已设为无兵种`);
        const rangeMin = int(r.rangeMin, 1, 1, 20);
        const u = makeUnit({
            name: uniqueName(name, unitNames), side: pick(r.side, SIDES, 'enemy'), kind: object ? 'object' : 'unit', typeId: type?.id || '',
            icon: Array.from(str(r.icon))[0] || '', color: color(r.color), aliases: str(r.aliases), keyTarget: bool(r.keyTarget), notes: str(r.notes),
            hp: int(r.hp, 20, 1, 9999), atk: int(r.atk, 8, 0, 999), matk: int(r.matk, 4, 0, 999), def: int(r.def, 4, 0, 999), mdef: int(r.mdef, 3, 0, 999),
            agi: int(r.agi, 5, 0, 999), mov: int(r.mov, 5, 0, 20), tough: int(r.tough, 2, 0, 10), vision: int(r.vision, object ? 0 : DEFAULT_VISION, 0, 20),
            rangeMin, rangeMax: Math.max(rangeMin, int(r.rangeMax, rangeMin, 1, 20)),
            atkType: pick(r.atkType, ['physical', 'magical'], 'physical'), attackOrder: pick(r.attackOrder, ['normal', 'last'], 'normal'),
            weaponName: str(r.weaponName), flying: !object && bool(r.flying), antiAir: !object && bool(r.antiAir), ai: object ? 'stationary' : pick(r.ai, AIS, 'aggressive'),
        });
        if (object) Object.assign(u, { atk: 0, matk: 0, agi: 0, mov: 0, tough: 0 });
        u.traits = arr(r.traits).map(t => traitFrom(t, u, warnings));
        u.skills = object ? [] : arr(r.skills).map(s => skillFrom(s, u, warnings)).filter(Boolean);
        const wanted = str(r.wbEntry);
        const entry = wanted ? entries.find(e => e.label === wanted) || entries.find(e => e.keys?.includes(wanted)) : null;
        if (entry) u.wb = { book: entry.book, uid: entry.uid, label: entry.label, keys: entry.keys || [] };
        else if (str(r.wbEntry)) warnings.push(`单位「${u.name}」的世界书条目「${str(r.wbEntry)}」没有找到，未绑定`);
        original.set(u, name);
        out.units.push(u);
    }
    const unitRef = name => fresh(out.units, str(name)) || findBy(profile.units || [], str(name)) || null;

    // 地图
    for (const r of arr(raw.maps)) out.maps.push(mapFrom(r, profile, out, { terrainRef, unitRef, warnings }));
    return out;
}

/** 模型给出的特质 → 资料卡特质（只保留预设效果） */
export function traitFrom(t, u, warnings) {
    return makeTrait({
        name: str(t?.name, '特质') || '特质', desc: str(t?.desc),
        effects: arr(t?.effects).map(e => {
            const type = effectId(TRAIT_EFFECTS, e?.type);
            if (!type) { warnings.push(`单位「${u.name}」的特质效果「${str(e?.type)}」不是预设效果，已忽略`); return null; }
            return { type, value: num(e.value, TRAIT_EFFECTS[type].value, 0, 999), ...(TRAIT_EFFECTS[type].stat && !TRAIT_EFFECTS[type].flat && bool(e.flat) ? { flat: true } : {}) };
        }).filter(Boolean),
    });
}

/** 模型给出的技能 → 资料卡技能（数值校验、只保留预设效果）；无效时返回 null */
export function skillFrom(s, u, warnings) {
    const name = str(s?.name);
    if (!name) return null;
    const kind = pick(s.kind, ['physical', 'magical', 'support'], 'physical');
    const sk = makeSkill({
        name, kind, desc: str(s.desc),
        target: kind === 'support' ? pick(s.target, ['ally', 'enemy', 'self', 'tile'], 'ally') : 'enemy',
        power: int(s.power, 150, 0, 1000), rangeMin: int(s.rangeMin, 1, 0, 20), rangeMax: int(s.rangeMax, 1, 0, 20), radius: int(s.radius, 0, 0, 10),
        attackMode: kind === 'support' ? 'normal' : pick(s.attackMode, ['normal', 'mapLine', 'mapArea'], 'normal'), lineLength: int(s.lineLength, 3, 1, 40),
        mapTargets: pick(s.mapTargets, ['all', 'enemy'], 'all'), cooldown: int(s.cooldown, 0, 0, 99), uses: int(s.uses, 0, 0, 99),
        hitMod: int(s.hitMod, 0, -100, 100), sureHit: bool(s.sureHit), quick: kind === 'support' && bool(s.quick), antiAir: bool(s.antiAir),
    });
    sk.rangeMax = Math.max(sk.rangeMin, sk.rangeMax);
    if (sk.attackMode === 'mapArea') sk.radius = Math.max(1, sk.radius);
    sk.effects = arr(s.effects).map(e => {
        const type = effectId(EFFECTS, e?.type);
        if (!type) { warnings.push(`「${u.name}」的技能「${name}」中的效果「${str(e?.type)}」不是预设效果，已忽略`); return null; }
        const def = EFFECTS[type];
        return { type, value: def.noValue ? 0 : num(e.value, def.value ?? 0, 0, 999), turns: def.instant ? 0 : int(e.turns, 2, 1, 99) };
    }).filter(Boolean);
    if (kind === 'support' && sk.target !== 'tile' && !sk.effects.length) {
        warnings.push(`「${u.name}」的辅助技能「${name}」没有有效效果，已忽略`);
        return null;
    }
    return normalizeSkill(sk);
}

function mapFrom(r, profile, out, { terrainRef, unitRef, warnings }) {
    const name = str(r?.name, 'AI 地图') || 'AI 地图';
    const label = `地图「${name}」`;
    // 地形网格：rows + legend，或二维地形名数组 tiles
    let grid = [];
    const legend = r.legend && typeof r.legend === 'object' ? r.legend : {};
    if (Array.isArray(r.rows)) grid = r.rows.map(row => Array.from(str(row)).map(ch => legend[ch] ?? ch));
    else if (Array.isArray(r.tiles) && Array.isArray(r.tiles[0])) grid = r.tiles.map(row => row.map(str));
    const h = Math.max(3, Math.min(40, grid.length || int(r.h, 8, 3, 40)));
    const w = Math.max(3, Math.min(40, int(r.w, 0, 0, 40) || Math.max(0, ...grid.map(row => row.length)) || 10));
    if (grid.length && (grid.length !== h || grid.some(row => row.length !== w))) warnings.push(`${label}的网格尺寸不一致，已按 ${w}×${h} 补齐或截断`);
    const fallback = terrainRef('平原') || out.terrains[0] || profile.terrains?.[0];
    const unknown = new Set();
    const tiles = [];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const cell = grid[y]?.[x];
            const t = cell == null ? fallback : terrainRef(cell);
            if (!t && cell != null) unknown.add(cell);
            tiles.push((t || fallback)?.id || 'plain');
        }
    }
    if (unknown.size) warnings.push(`${label}中的地形「${[...unknown].slice(0, 5).join('、')}」不存在，已替换为「${fallback?.name || '平原'}」`);

    const terrains = Object.fromEntries([...(profile.terrains || []), ...out.terrains].map(t => [t.id, t]));
    const probe = { w, h, tiles, terrains };
    const taken = new Set();
    const spot = (x, y, unit) => {
        // 首选格子不能站时，在 2 格内找一个空位
        for (let d = 0; d <= 2; d++) {
            for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
                if (Math.abs(dx) + Math.abs(dy) !== d) continue;
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h || taken.has(`${nx},${ny}`)) continue;
                if (!Number.isFinite(enterCost(probe, { flying: unit.kind !== 'object' && !!unit.flying }, nx, ny))) continue;
                return [nx, ny];
            }
        }
        return null;
    };
    const placements = [];
    for (const p of arr(r.placements)) {
        const unit = unitRef(p?.unit ?? p?.name);
        if (!unit) { warnings.push(`${label}中的单位「${str(p?.unit ?? p?.name)}」不存在，已跳过`); continue; }
        const x = int(p.x, 1, 1, w) - 1, y = int(p.y, 1, 1, h) - 1;
        const at = spot(x, y, unit);
        if (!at) { warnings.push(`${label}中「${unit.name}」(${x + 1},${y + 1}) 附近没有可站立的空格，已跳过`); continue; }
        if (at[0] !== x || at[1] !== y) warnings.push(`${label}中「${unit.name}」的位置 (${x + 1},${y + 1}) 无法站立或已被占用，挪到了 (${at[0] + 1},${at[1] + 1})`);
        taken.add(`${at[0]},${at[1]}`);
        placements.push({ unitId: unit.id, x: at[0], y: at[1] });
    }
    const reinforcements = [];
    for (const v of arr(r.reinforcements)) {
        const unit = unitRef(v?.unit ?? v?.name);
        if (!unit) { warnings.push(`${label}的增援单位「${str(v?.unit ?? v?.name)}」不存在，已跳过`); continue; }
        reinforcements.push(makeWave({ unitId: unit.id, x: int(v.x, w, 1, w) - 1, y: int(v.y, 1, 1, h) - 1,
            count: int(v.count, 1, 1, 20), startTurn: int(v.startTurn, 2, 1, 99), every: int(v.every, 0, 0, 99), times: int(v.times, 0, 0, 99) }));
    }
    const m = r.mission || {};
    const map = makeMap({
        name, desc: str(r.desc), w, h, tiles, placements, reinforcements,
        mission: { type: pick(m.type, Object.keys(MISSION_NAMES), 'annihilate'), turns: int(m.turns, 0, 0, 99), ...(m.type === 'defend' ? { lossLimit: int(m.lossLimit, 1, 1, 99) } : {}) },
        fog: { enabled: bool(r.fog?.enabled ?? r.fog), ai: bool(r.fog?.ai, true) },
    });
    const problems = validateMission(map, [...(profile.units || []), ...out.units]);
    problems.forEach(p => warnings.push(`${label}：${p}`));
    return map;
}

// ---------------------------------------------------------------- 导入

/** 某个设计项依赖的、本次新建的其他设计项（地图 → 单位 / 地形；单位 → 兵种） */
function dependencies(design, item) {
    const ids = new Set();
    if (item.tiles) {
        item.tiles.forEach(id => ids.add(id));
        [...item.placements, ...item.reinforcements].forEach(p => ids.add(p.unitId));
    }
    if (item.typeId) ids.add(item.typeId);
    return KEYS.flatMap(k => design[k]).filter(x => ids.has(x.id));
}

/**
 * 把选中的设计项加入资料卡；被选中项依赖的新内容会自动一并加入。
 * @param {Set<string>} chosen 设计项 id
 * @returns {{added: Record<string, number>, auto: string[], ids: string[]}} auto：自动带上的依赖项名称；ids：实际导入的设计项
 */
export function applyDesign(profile, design, chosen) {
    const take = new Set(chosen);
    const auto = [];
    for (let changed = true; changed;) {
        changed = false;
        for (const item of KEYS.flatMap(k => design[k]).filter(x => take.has(x.id))) {
            for (const dep of dependencies(design, item)) {
                if (take.has(dep.id)) continue;
                take.add(dep.id); auto.push(dep.name); changed = true;
            }
        }
    }
    const added = {};
    const importedTypes = new Set([...(profile.unitTypes || []).map(t => t.id), ...design.unitTypes.filter(t => take.has(t.id)).map(t => t.id)]);
    for (const k of KEYS) {
        const items = design[k].filter(x => take.has(x.id)).map(x => structuredClone(x));
        // 克制对象没有导入时，去掉这条克制
        if (k === 'unitTypes') items.forEach(t => { for (const id of Object.keys(t.vs)) if (!importedTypes.has(id)) delete t.vs[id]; });
        (profile[k] ||= []).push(...items);
        added[k] = items.length;
    }
    return { added, auto, ids: [...take] };
}

export function designItems(design) {
    return KEYS.flatMap(k => design[k].map(item => ({ key: k, item })));
}

export function designSummary(design) {
    return KEYS.filter(k => design[k].length).map(k => `${DESIGN_LABELS[k]} ${design[k].length}`).join(' · ') || '没有内容';
}
