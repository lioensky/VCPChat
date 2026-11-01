// 默认数据：地形、示例单位、示例地图、插件设置
export const MODULE_NAME = 'tavern_srpg';
export const META_KEY = 'tavern_srpg';

export function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export const DEFAULT_TERRAINS = [
    { id: 'plain', name: '平原', symbol: '', color: '#9ccc65', moveCost: 1, passable: true, flyable: true, avoid: 0, defBonus: 0, healPct: 0, desc: '开阔的草地，视野良好' },
    { id: 'forest', name: '森林', symbol: '♣', color: '#2e7d32', moveCost: 2, passable: true, flyable: true, avoid: 15, defBonus: 20, healPct: 0, conceal: 1, desc: '茂密的树林，便于隐蔽，提高闪避并减少受到的伤害' },
    { id: 'mountain', name: '山地', symbol: '▲', color: '#8d6e63', moveCost: 3, passable: true, flyable: true, avoid: 20, defBonus: 30, healPct: 0, visionBonus: 2, desc: '崎岖的山岭，难以行进但易守难攻，登高望远' },
    { id: 'river', name: '河流', symbol: '≈', color: '#42a5f5', moveCost: 1, passable: false, flyable: true, avoid: 0, defBonus: 0, healPct: 0, desc: '湍急的河水，步行无法通过，飞行单位可越过' },
    { id: 'canyon', name: '峡谷', symbol: '▼', color: '#5d4037', moveCost: 1, passable: false, flyable: true, avoid: 0, defBonus: 0, healPct: 0, desc: '深不见底的裂谷，只有飞行单位能跨越' },
    { id: 'bridge', name: '桥梁', symbol: '=', color: '#bcaaa4', moveCost: 1, passable: true, flyable: true, avoid: 0, defBonus: 0, healPct: 0, desc: '横跨河流的木桥，兵家必争之地' },
    { id: 'desert', name: '沙地', symbol: '∴', color: '#ffe082', moveCost: 2, passable: true, flyable: true, avoid: -10, defBonus: 0, healPct: 0, desc: '松软的沙地，拖慢行军，难以闪避' },
    { id: 'fort', name: '堡垒', symbol: '⌂', color: '#b0bec5', moveCost: 1, passable: true, flyable: true, avoid: 10, defBonus: 30, healPct: 10, visionBonus: 1, desc: '坚固的据点，回合开始时恢复10%生命' },
    { id: 'wall', name: '城墙', symbol: '█', color: '#455a64', moveCost: 1, passable: false, flyable: false, avoid: 0, defBonus: 0, healPct: 0, blockSight: true, desc: '高耸的石墙，任何单位都无法通过' },
    { id: 'lava', name: '熔岩', symbol: '♨', color: '#e64a19', moveCost: 2, passable: true, flyable: true, avoid: 0, defBonus: 0, healPct: 0, enterDamage: 5, enterDamagePct: 0, turnDamage: 0, turnDamagePct: 10, damageFlying: false, desc: '落脚时受到5点伤害；阵营回合开始时损失最大HP的10%，飞行单位免疫' },
];

export function makeUnit(over = {}) {
    return {
        id: uid('unit'),
        name: '新单位',
        kind: 'unit', // unit: 角色 ; object: 建筑物 / 目标物（不会行动）
        keyTarget: false, // 关键目标：守城战中需要保护，进攻战中需要破坏
        side: 'player',
        icon: '',
        color: '',
        hp: 20, atk: 8, matk: 4, def: 4, mdef: 3, agi: 5, mov: 5,
        tough: 2, // 韧性：每次防御或反击消耗 1 点，耗尽后只能承受伤害；己方阶段开始时回满
        vision: 4, // 视野（格）：战争迷雾中能看到多远；建筑默认 0
        typeId: '', // 兵种（资料卡 unitTypes 中的 id），用于克制关系
        rangeMin: 1, rangeMax: 1,
        atkType: 'physical',
        weaponName: '',
        attackOrder: 'normal', // last：普通攻击时，对能回击的非后手目标让出先攻
        flying: false,
        antiAir: false, // 普通攻击可以对空：战斗规则开启「对空」时才能打到飞行单位
        ai: 'aggressive',
        mapReckless: true, // 鲁莽使用MAP攻击：AI 不顾误伤友军；关闭后只在打敌人的收益大于误伤时使用
        traits: [], // 常驻特质 [{ id, name, desc, effects }]
        skills: [],
        wb: null,
        aliases: '', // 故事中的名字 / 别名，逗号分隔，可以写 {{user}} {{char}}
        notes: '',
        ...over,
    };
}

export function makeTrait(over = {}) {
    return { id: uid('trait'), name: '新特质', desc: '', effects: [], ...over };
}

export function makeSkill(over = {}) {
    return {
        id: uid('sk'),
        name: '新技能',
        kind: 'physical', // physical 物理伤害 | magical 魔法伤害 | support 辅助
        target: 'enemy', // 辅助技能的作用对象：ally 友方（含自己）| enemy 敌方 | self 仅自己
        power: 150, // 伤害技能的百分比倍率
        rangeMin: 1, rangeMax: 1,
        radius: 0, // 0 = 单体，>0 = 以目标格为中心的范围
        attackMode: 'normal', // normal | mapLine | mapArea
        lineLength: 3,
        mapTargets: 'all', // all：除施法者外敌我全部；enemy：仅敌方
        cooldown: 0, // 冷却回合：N = 每 N 回合可用一次，0 = 无冷却
        hitMod: 0, // 命中修正（±%）
        sureHit: false, // 必中
        antiAir: false, // 可以对空：战斗规则开启「对空」时才能打到飞行单位
        uses: 0, // 0 = 无限
        effects: [], // 预设效果 [{ type, value, turns }]，type 见 engine.js 的 EFFECTS
        desc: '',
        ...over,
    };
}

export function makeMap(over = {}) {
    const w = over.w || 10, h = over.h || 8;
    return {
        id: uid('map'),
        name: '新地图',
        w, h,
        tiles: new Array(w * h).fill('plain'),
        desc: '',
        placements: [],
        mission: { type: 'annihilate', turns: 0 }, // annihilate 歼灭 / defend 守城 / assault 进攻；turns 见设置说明
        fog: { enabled: false, ai: true }, // 战争迷雾；ai：敌方 AI 也只知道视野内的单位
        reinforcements: [],
        ...over,
    };
}

/**
 * 兵种：vs[防守方兵种 id] = { dmg 伤害倍率%, hit 命中修正, tough 防守方招架时消耗的韧性倍数 }，未设置的组合视为 100% / 0 / ×1
 */
export function makeUnitType(over = {}) {
    return { id: uid('type'), name: '新兵种', desc: '', color: '', vs: {}, ...over };
}

/** 兵种模板：战士 / 坦克 / 侦察 / 射手 的一套克制关系 */
export function unitTypePreset() {
    const warrior = makeUnitType({ name: '战士', desc: '近战主力，擅长贴身压制射手', color: '#e57373' });
    const tank = makeUnitType({ name: '坦克', desc: '重甲前排，近战难以撼动，但怕远程穿甲', color: '#90a4ae' });
    const scout = makeUnitType({ name: '侦察', desc: '轻装快速、视野开阔，适合突袭射手，正面打不动坦克', color: '#81c784' });
    const archer = makeUnitType({ name: '射手', desc: '远程火力，专克轻装单位，被近身就难以招架', color: '#ffb74d' });
    warrior.vs = { [archer.id]: { dmg: 130, hit: 0, tough: 2 }, [tank.id]: { dmg: 70, hit: 0, tough: 1 } };
    tank.vs = { [warrior.id]: { dmg: 120, hit: 10, tough: 1 }, [scout.id]: { dmg: 120, hit: 0, tough: 2 } };
    scout.vs = { [archer.id]: { dmg: 130, hit: 10, tough: 1 }, [tank.id]: { dmg: 60, hit: 0, tough: 1 } };
    archer.vs = { [scout.id]: { dmg: 130, hit: 15, tough: 1 }, [tank.id]: { dmg: 120, hit: 0, tough: 1 }, [warrior.id]: { dmg: 90, hit: 0, tough: 1 } };
    return [warrior, tank, scout, archer];
}

export function makeWave(over = {}) {
    return {
        id: uid('wave'),
        unitId: null,
        x: 0, y: 0,
        count: 1, // 每次出现的数量
        startTurn: 2, // 第几回合（敌方阶段结束时）出现
        every: 0, // 每隔几回合再次出现，0＝只出现一次
        times: 0, // 最多出现几次，0＝无限（every>0 时）
        ...over,
    };
}

function sampleData() {
    const knight = makeUnit({ id: 'unit_sample_knight', name: '骑士', side: 'player', icon: '骑', hp: 32, atk: 12, matk: 2, def: 9, mdef: 3, agi: 4, mov: 5,
        skills: [
            makeSkill({ id: 'sk_sample_charge', name: '冲锋', kind: 'physical', power: 160, cooldown: 2, sureHit: true, desc: '全力冲刺后的重击' }),
            makeSkill({ id: 'sk_sample_provoke', name: '挑衅', kind: 'support', target: 'self', rangeMin: 0, rangeMax: 0, cooldown: 3,
                effects: [{ type: 'taunt', value: 0, turns: 1 }, { type: 'def_up', value: 20, turns: 1 }], desc: '高举盾牌大声挑衅，吸引所有敌人的攻击' }),
        ] });
    const mage = makeUnit({ id: 'unit_sample_mage', name: '法师', side: 'player', icon: '法', hp: 22, atk: 3, matk: 13, def: 3, mdef: 9, agi: 6, mov: 4, rangeMin: 1, rangeMax: 2, atkType: 'magical',
        skills: [
            makeSkill({ id: 'sk_sample_fireball', name: '火球术', kind: 'magical', power: 130, rangeMin: 1, rangeMax: 3, radius: 1, cooldown: 2, hitMod: 10, antiAir: true, desc: '在目标处炸开的火球' }),
            makeSkill({ id: 'sk_sample_heal', name: '治愈', kind: 'support', target: 'ally', rangeMin: 0, rangeMax: 2, cooldown: 1,
                effects: [{ type: 'heal', value: 120, turns: 0 }], desc: '温暖的治愈之光' }),
            makeSkill({ id: 'sk_sample_guard', name: '守护之光', kind: 'support', target: 'ally', rangeMin: 0, rangeMax: 2, radius: 1, cooldown: 3,
                effects: [{ type: 'def_up', value: 30, turns: 2 }, { type: 'mdef_up', value: 30, turns: 2 }], desc: '笼罩同伴的金色光幕' }),
        ] });
    const goblin = makeUnit({ id: 'unit_sample_goblin', name: '哥布林', side: 'enemy', icon: '哥', hp: 18, atk: 9, matk: 0, def: 3, mdef: 1, agi: 8, mov: 5 });
    const archer = makeUnit({ id: 'unit_sample_archer', name: '哥布林弓手', side: 'enemy', icon: '弓', hp: 15, atk: 8, matk: 0, def: 2, mdef: 2, agi: 9, mov: 4, rangeMin: 2, rangeMax: 3, ai: 'defensive', antiAir: true,
        skills: [makeSkill({ id: 'sk_sample_poison', name: '毒箭', kind: 'physical', power: 80, rangeMin: 2, rangeMax: 3, cooldown: 3,
            effects: [{ type: 'poison', value: 10, turns: 2 }], desc: '箭头涂着绿色的毒液' })] });

    const w = 12, h = 8;
    const tiles = new Array(w * h).fill('plain');
    const set = (x, y, t) => { tiles[y * w + x] = t; };
    for (let y = 0; y < h; y++) set(6, y, 'river');
    set(6, 3, 'bridge'); set(6, 4, 'bridge');
    [[2, 1], [3, 1], [2, 2], [8, 6], [9, 6], [9, 5]].forEach(([x, y]) => set(x, y, 'forest'));
    [[10, 0], [11, 0], [11, 1]].forEach(([x, y]) => set(x, y, 'mountain'));
    set(10, 4, 'fort');
    const map = makeMap({ id: 'map_sample', name: '河畔之战', w, h, tiles, desc: '一条河流将平原一分为二，唯一的木桥位于中央。敌人占据了东岸的堡垒。',
        placements: [
            { unitId: knight.id, x: 1, y: 3 },
            { unitId: mage.id, x: 1, y: 5 },
            { unitId: goblin.id, x: 9, y: 3 },
            { unitId: goblin.id, x: 8, y: 5 },
            { unitId: archer.id, x: 10, y: 4 },
        ] });

    // 守城战示例：守住城门 5 回合，敌人每 2 回合从东边增援
    const gate = makeUnit({ id: 'unit_sample_gate', name: '城门', kind: 'object', keyTarget: true, side: 'player', icon: '门', color: '#8d6e63', hp: 60, def: 8, mdef: 6, mov: 0 });
    const dw = 12, dh = 9;
    const dtiles = new Array(dw * dh).fill('plain');
    const dset = (x, y, t) => { dtiles[y * dw + x] = t; };
    for (let y = 0; y < dh; y++) if (y !== 4) dset(2, y, 'wall');
    dset(2, 4, 'fort');
    [[6, 1], [7, 1], [6, 7], [7, 7], [8, 6]].forEach(([x, y]) => dset(x, y, 'forest'));
    const defend = makeMap({ id: 'map_sample_defend', name: '死守城门', w: dw, h: dh, tiles: dtiles,
        desc: '城墙由北向南贯穿战场，唯一的城门是敌人的目标。只要城门不倒，援军就会在第 5 回合后赶到。',
        mission: { type: 'defend', turns: 5 },
        placements: [
            { unitId: gate.id, x: 2, y: 4 },
            { unitId: knight.id, x: 3, y: 4 },
            { unitId: mage.id, x: 1, y: 4 },
            { unitId: goblin.id, x: 9, y: 3 },
            { unitId: goblin.id, x: 10, y: 5 },
        ],
        reinforcements: [makeWave({ id: 'wave_sample_def', unitId: goblin.id, x: 11, y: 4, count: 2, startTurn: 1, every: 2, times: 0 })] });

    // 进攻战示例：破坏敌阵后方的魔法水晶，敌人第 2 回合起每 3 回合增援，最多 2 次
    const crystal = makeUnit({ id: 'unit_sample_crystal', name: '魔法水晶', kind: 'object', keyTarget: true, side: 'enemy', icon: '晶', color: '#7e57c2', hp: 40, def: 6, mdef: 12, mov: 0 });
    const aw = 12, ah = 8;
    const atiles = new Array(aw * ah).fill('plain');
    const aset = (x, y, t) => { atiles[y * aw + x] = t; };
    [[4, 0], [4, 1], [4, 2], [4, 5], [4, 6], [4, 7]].forEach(([x, y]) => aset(x, y, 'canyon'));
    [[7, 2], [7, 5], [8, 2], [8, 5]].forEach(([x, y]) => aset(x, y, 'mountain'));
    aset(10, 3, 'fort'); aset(10, 4, 'fort');
    const assault = makeMap({ id: 'map_sample_assault', name: '破坏水晶', w: aw, h: ah, tiles: atiles,
        desc: '峡谷中间只有一条通路，魔法水晶被安置在敌阵后方的堡垒里，源源不断地召唤着援兵。',
        mission: { type: 'assault', turns: 0 },
        placements: [
            { unitId: knight.id, x: 1, y: 3 },
            { unitId: mage.id, x: 1, y: 4 },
            { unitId: crystal.id, x: 10, y: 3 },
            { unitId: archer.id, x: 9, y: 4 },
            { unitId: goblin.id, x: 6, y: 3 },
        ],
        reinforcements: [makeWave({ id: 'wave_sample_asl', unitId: goblin.id, x: 11, y: 4, count: 1, startTurn: 2, every: 3, times: 2 })] });

    // 战争迷雾示例：森林里埋伏着哥布林，斥候视野开阔，负责探路
    const scout = makeUnit({ id: 'unit_sample_scout', name: '斥候', side: 'player', icon: '斥', hp: 20, atk: 8, matk: 0, def: 3, mdef: 3, agi: 11, mov: 6, vision: 7, tough: 1,
        skills: [makeSkill({ id: 'sk_sample_flare', name: '照明弹', kind: 'support', target: 'enemy', rangeMin: 1, rangeMax: 5, radius: 1, cooldown: 3, sureHit: true,
            effects: [{ type: 'reveal', value: 0, turns: 2 }], desc: '向夜空打出一枚照明弹，照亮躲在暗处的敌人' })] });
    const fw = 12, fh = 8;
    const ftiles = new Array(fw * fh).fill('plain');
    const fset = (x, y, t) => { ftiles[y * fw + x] = t; };
    [[4, 1], [5, 1], [4, 2], [7, 2], [8, 2], [8, 3], [5, 5], [6, 5], [6, 6], [9, 5], [9, 6], [10, 6], [3, 6]].forEach(([x, y]) => fset(x, y, 'forest'));
    [[10, 1], [11, 1], [11, 2]].forEach(([x, y]) => fset(x, y, 'mountain'));
    const fogMap = makeMap({ id: 'map_sample_fog', name: '夜袭森林', w: fw, h: fh, tiles: ftiles,
        desc: '深夜的森林里伸手不见五指，哥布林埋伏在树丛之间，弓手占据了东北的山头。',
        fog: { enabled: true, ai: true },
        placements: [
            { unitId: knight.id, x: 1, y: 3 },
            { unitId: mage.id, x: 1, y: 4 },
            { unitId: scout.id, x: 2, y: 5 },
            { unitId: goblin.id, x: 8, y: 2 },
            { unitId: goblin.id, x: 6, y: 5 },
            { unitId: goblin.id, x: 9, y: 6 },
            { unitId: archer.id, x: 10, y: 1 },
        ] });

    return { units: [knight, mage, scout, goblin, archer, gate, crystal], maps: [map, defend, assault, fogMap] };
}

export const DEFAULT_HEADER = '【SRPG 战斗系统】以下行动结果已由战斗系统计算完成，请据此生动地描写战斗过程。严格遵循给出的数值与结果（伤害、击败、位置），不要自行改变或追加判定。';

export function defaultRules() {
    return {
        formula: 'diminishing', // 攻 × 威力% × 防御基准/(防御基准+防)，保留 subtract / ratio
        defenseScale: 12, // 防御等于此数值时减伤50%
        defenseReduction: 50, // 选择防御时减伤%，且不反击
        variance: 10, // 伤害浮动 ±%
        counter: true, // 普通攻击是否触发反击
        minDamage: 1,
        hitEnabled: true, // 命中判定
        baseHit: 90, // 基础命中率 %
        agiFactor: 3, // 每 1 点敏捷差影响的命中率 %
        toughness: 'all', // 韧性系统：all 所有单位 ; player 仅我方角色 ; off 关闭（不受约束的 AI 单位只反击、不防御）
        airTarget: 'all', // 飞行单位：all 可以被任何攻击打到 ; antiAir 只能被对空的普通攻击 / 技能或其他飞行单位打到
    };
}

/** 资料卡：一套完整的游戏内容（单位、地形、地图、战斗规则），可以绑定到角色卡 */
export function makeProfile(over = {}) {
    return {
        id: uid('profile'),
        name: '新资料卡',
        desc: '',
        terrains: structuredClone(DEFAULT_TERRAINS),
        unitTypes: [], // 兵种与克制关系，见 makeUnitType
        units: [],
        maps: [],
        rules: defaultRules(),
        updatedAt: Date.now(),
        ...over,
    };
}

export const SAMPLE_PROFILE_ID = 'profile_sample';
export const FE_KAI_PROFILE_ID = 'profile_fe_kai';

export function sampleProfile() {
    const sample = sampleData();
    return makeProfile({
        id: SAMPLE_PROFILE_ID,
        name: '示例：哥布林战役',
        desc: '内置示例：河畔之战（歼灭）、死守城门（守城）、破坏水晶（进攻）、夜袭森林（战争迷雾）。',
        units: sample.units,
        maps: sample.maps,
    });
}

export function feKaiProfile() {
    const cavalry = makeUnitType({ id: 'type_fe_cavalry', name: '魔眼骑兵', desc: '高机动突击骑兵，擅长奔袭压制步兵与射手', color: '#f59e0b' });
    const arbiter = makeUnitType({ id: 'type_fe_arbiter', name: '调停者', desc: '执掌无铭之枪与瓦连粒子的时间依代，攻守兼备', color: '#38bdf8' });
    const infantry = makeUnitType({ id: 'type_fe_infantry', name: '前锋步兵', desc: '均衡近战步兵，战线中坚', color: '#ef4444' });
    const armor = makeUnitType({ id: 'type_fe_armor', name: '重甲卫士', desc: '高防重装单位，正面极难击穿但畏惧魔法与穿甲', color: '#94a3b8' });
    const archerType = makeUnitType({ id: 'type_fe_archer', name: '游击弓手', desc: '远程狙击兵种，压制轻装与飞行单位', color: '#a3e635' });
    cavalry.vs = { [infantry.id]: { dmg: 120, hit: 10, tough: 1 }, [archerType.id]: { dmg: 135, hit: 10, tough: 2 } };
    arbiter.vs = { [armor.id]: { dmg: 130, hit: 10, tough: 2 }, [infantry.id]: { dmg: 115, hit: 5, tough: 1 } };
    infantry.vs = { [archerType.id]: { dmg: 125, hit: 5, tough: 1 }, [armor.id]: { dmg: 75, hit: 0, tough: 1 } };
    armor.vs = { [infantry.id]: { dmg: 115, hit: 5, tough: 1 }, [cavalry.id]: { dmg: 115, hit: 0, tough: 2 } };
    archerType.vs = { [cavalry.id]: { dmg: 120, hit: 10, tough: 1 } };

    const kai = makeUnit({
        id: 'unit_fe_kai', name: '凯伊', side: 'player', icon: '凯', color: '#d97706',
        typeId: cavalry.id, aliases: '魔眼凯伊,Kai', weaponName: '骑枪',
        hp: 28, atk: 11, matk: 6, def: 6, mdef: 4, agi: 9, mov: 7, tough: 2, vision: 5,
        traits: [
            makeTrait({ id: 'tr_fe_evil_eye', name: '魔眼先读', desc: '看穿敌军动作轨迹，提升命中与闪避', effects: [{ type: 'agi_up', value: 15 }] }),
        ],
        skills: [
            makeSkill({ id: 'sk_fe_lance_rush', name: '疾驰突刺', kind: 'physical', power: 145, rangeMin: 1, rangeMax: 1, cooldown: 2, hitMod: 10, desc: '借坐骑冲势贯穿敌阵的战技' }),
            makeSkill({ id: 'sk_fe_starfall', name: '落星冥焰狱', kind: 'magical', power: 160, rangeMin: 1, rangeMax: 3, radius: 1, attackMode: 'mapArea', mapTargets: 'enemy', cooldown: 4, sureHit: true, desc: '召唤坠星冥焰轰炸指定区域，不触发反击' }),
        ],
        notes: '《万缕千丝》凯伊线主角，高机动骑兵（可在手动修改中按NS2面板随时微调MOV/HP）',
    });

    const ishmael = makeUnit({
        id: 'unit_fe_ishmael', name: '以实玛利', side: 'player', icon: '调', color: '#0284c7',
        typeId: arbiter.id, aliases: '调停者,Ishmael', weaponName: '无铭之枪',
        hp: 30, atk: 12, matk: 8, def: 7, mdef: 6, agi: 8, mov: 5, tough: 3, vision: 5,
        traits: [
            makeTrait({ id: 'tr_fe_valen', name: '瓦连粒子炉', desc: '体内高次元缩退炉每回合自动修复肉体损伤', effects: [{ type: 'regen', value: 10 }] }),
        ],
        skills: [
            makeSkill({ id: 'sk_fe_banish', name: '破邪闪击', kind: 'physical', power: 155, rangeMin: 1, rangeMax: 2, radius: 1, cooldown: 2, hitMod: 15, desc: '挥舞无铭之枪释放破邪冲击波' }),
            makeSkill({ id: 'sk_fe_pulse', name: '因果调停', kind: 'support', target: 'ally', rangeMin: 0, rangeMax: 2, cooldown: 2, effects: [{ type: 'heal_pct', value: 35, turns: 0 }, { type: 'atk_up', value: 20, turns: 2 }], desc: '借天刻共鸣修复友军并强化战意' }),
        ],
        notes: '逆涉时间回到1449年的调停者，持有天刻之白沙',
    });

    const allyGuard = makeUnit({
        id: 'unit_fe_retainer', name: '随行护卫', side: 'player', icon: '卫', color: '#0d9488',
        typeId: armor.id, aliases: '护卫,队友', weaponName: '铁枪',
        hp: 26, atk: 9, matk: 2, def: 9, mdef: 3, agi: 5, mov: 4, tough: 2,
        skills: [
            makeSkill({ id: 'sk_fe_cover', name: '挺身援护', kind: 'support', target: 'ally', rangeMin: 1, rangeMax: 1, cooldown: 1, effects: [{ type: 'cover', value: 0, turns: 1 }], desc: '替相邻同伴承受下一次单体攻击' }),
        ],
    });

    const enemyFighter = makeUnit({
        id: 'unit_fe_bandit', name: '敌方前锋', side: 'enemy', icon: '贼', color: '#dc2626',
        typeId: infantry.id, weaponName: '铁斧',
        hp: 20, atk: 9, matk: 0, def: 4, mdef: 1, agi: 6, mov: 5, tough: 1, ai: 'aggressive',
    });

    const enemyArcher = makeUnit({
        id: 'unit_fe_archer', name: '敌方弓手', side: 'enemy', icon: '弓', color: '#ea580c',
        typeId: archerType.id, weaponName: '短弓',
        hp: 17, atk: 8, matk: 0, def: 3, mdef: 2, agi: 7, mov: 4, rangeMin: 2, rangeMax: 2, tough: 1, ai: 'defensive', antiAir: true,
    });

    const enemyBoss = makeUnit({
        id: 'unit_fe_boss', name: '敌军首领', side: 'enemy', icon: '首', color: '#991b1b',
        typeId: armor.id, keyTarget: true, weaponName: '钢枪',
        hp: 32, atk: 12, matk: 3, def: 8, mdef: 4, agi: 6, mov: 4, rangeMin: 1, rangeMax: 2, tough: 2, ai: 'defensive',
        skills: [
            makeSkill({ id: 'sk_fe_heavy', name: '碎骨重击', kind: 'physical', power: 140, rangeMin: 1, rangeMax: 1, cooldown: 2, effects: [{ type: 'def_down', value: 20, turns: 2 }], desc: '势大力沉的破甲一击' }),
        ],
    });

    const w = 12, h = 9;
    const tiles = new Array(w * h).fill('plain');
    const set = (x, y, t) => { tiles[y * w + x] = t; };
    [[2, 2], [3, 2], [2, 6], [6, 3], [6, 5], [8, 2], [8, 6]].forEach(([x, y]) => set(x, y, 'forest'));
    [[5, 0], [5, 1], [5, 7], [5, 8], [10, 0], [11, 0], [10, 8], [11, 8]].forEach(([x, y]) => set(x, y, 'mountain'));
    set(4, 4, 'fort'); set(10, 4, 'fort');

    const firstMap = makeMap({
        id: 'map_fe_kai_ch1',
        name: '凯伊线首战 · 战术沙盘',
        w, h, tiles,
        desc: '《火焰之纹章：万缕千丝》凯伊线第一场战棋战役伴侣沙盘。支持开启「手动修改」随时拖拽同步 NS2 实机走位、血量与天刻悔棋。',
        mission: { type: 'annihilate', turns: 0 },
        placements: [
            { unitId: kai.id, x: 1, y: 3 },
            { unitId: ishmael.id, x: 1, y: 5 },
            { unitId: allyGuard.id, x: 2, y: 4 },
            { unitId: enemyFighter.id, x: 6, y: 2 },
            { unitId: enemyFighter.id, x: 6, y: 6 },
            { unitId: enemyFighter.id, x: 7, y: 4 },
            { unitId: enemyArcher.id, x: 8, y: 3 },
            { unitId: enemyArcher.id, x: 8, y: 5 },
            { unitId: enemyBoss.id, x: 10, y: 4 },
        ],
    });

    return makeProfile({
        id: FE_KAI_PROFILE_ID,
        name: '万缕千丝：凯伊线战棋沙盘',
        desc: '专为《火焰之纹章：万缕千丝》NS2 实机伴侣推演定制的战棋资料卡，内置魔眼凯伊、调停者以实玛利及首战沙盘。',
        unitTypes: [cavalry, arbiter, infantry, armor, archerType],
        units: [kai, ishmael, allyGuard, enemyFighter, enemyArcher, enemyBoss],
        maps: [firstMap],
    });
}

/** 资料卡里的内容字段 */
export const PROFILE_KEYS = ['terrains', 'unitTypes', 'units', 'maps', 'rules'];

export function defaultSettings() {
    return {
        version: 7,
        profiles: [feKaiProfile(), sampleProfile()],
        activeProfile: FE_KAI_PROFILE_ID,
        defaultProfile: FE_KAI_PROFILE_ID, // 兼容旧设置，仅作编辑器回退；不启用未绑定聊天
        bindings: { 'char:fe_kai_sandbox.png': FE_KAI_PROFILE_ID }, // 默认绑定至VCP独立战棋沙盘宿主
        declinedEmbeds: {}, // 不再询问导入的角色卡内置资料卡
        narration: {
            move: true, // 描写移动
            attack: true, // 描写普通攻击
            skill: true, // 描写技能
            enemy: true, // 描写敌方行动
            ally: true, // 描写友军行动
            turn: true, // 描写回合切换/地形恢复
            reinforce: true, // 描写增援出现
            status: true, // 描写状态变化（中毒 / 持续恢复 / 眩晕 / 效果结束）
            brief: true, // 不描写的行动以简要背景告知
        },
        send: {
            mode: 'preview', // send: 直接发送 ; fill: 填入输入框 ; preview: 预览后发送
            autoOnEndTurn: true, // 结束回合时自动整理消息
            header: DEFAULT_HEADER,
            includeInput: true, // 把主输入框已有的文字作为补充要求一起发送
        },
        inject: {
            enabled: true,
            position: 'chat', // chat: 聊天记录中（按深度）; before: 主提示词之前; after: 主提示词之后
            depth: 2,
            role: 'system', // system | user | assistant
            includeWb: false, // 把绑定的世界书条目内容一并注入
            // 注入哪些部分
            map: true, legend: true, stats: true, skills: true, nearest: true,
            logLines: 0, // 附带最近 N 条战斗记录
            // 单位资料：把资料卡中的单位像世界书条目一样提供给聊天 AI（战斗之外也生效）
            units: {
                enabled: false,
                scope: 'party', // party: 我方与友军 ; all: 包括敌人
                trigger: 'keyword', // keyword: 最近的消息提到名字 / 别名 / 绑定的世界书关键词时注入 ; constant: 总是注入
                scanDepth: 4, // 关键词扫描最近几条消息
                skills: true, // 包含技能
            },
        },
        tool: {
            enabled: false, // 注册函数调用工具，让 LLM 主动查询战场（需要支持函数调用的 Chat Completion 接口）
        },
        llm: {
            // ① 战场变化：剧情同步时，插件 LLM 从剧情中读出的战场变化（落石、喝药、援军…）
            commands: false,
            mode: 'confirm', // confirm: 由我确认后应用 ; auto: 自动应用
            allow: { damage: true, heal: true, status: true, unstatus: true, move: true, retreat: true, spawn: true, terrain: true, end: false },
            maxChangePct: 50, // 单条指令的 HP 变化上限（目标最大 HP 的百分比）
            allowKill: false, // 指令能否直接击败单位
            // ② LLM 指挥官：由 LLM 为 AI 单位选择行动
            commander: { enemy: false, ally: false },
            options: 6, // 每个单位最多列出几个选项
            intent: true, // 让 LLM 附带一句意图，写进战斗描写
        },
        // AI 设计助手：生成地图、单位、地形、兵种（不随「导出全部」导出，避免泄露 API Key）
        designer: {
            source: 'st', // st: 当前 SillyTavern 使用的 API ; profile: SillyTavern 的连接配置 ; custom: 自定义 OpenAI 兼容接口
            profileId: '',
            custom: { url: 'https://api.openai.com/v1', key: '', model: '', proxy: false },
            maxTokens: 8000,
            temperature: 0.8,
            books: null, // 读取哪些世界书；null＝自动（当前角色、聊天和全局启用的世界书）
            includeChar: true, // 附带角色卡设定
            loreChars: 24000, // 世界书内容的字数上限
            // 剧情同步：由这里配置的模型（不是聊天 AI）读取聊天记录，找出角色成长、即将开始的战斗和战场变化
            story: {
                enabled: false,
                trigger: 'interval', // interval: 每隔 every 轮 AI 回复自动同步 ; manual: 只在点击时同步
                every: 3,
                grow: 'confirm', // confirm: 生成后由我确认 ; auto: 生成后自动应用（可撤销）
                battle: true, // 允许剧情触发关卡
                chatDepth: 20, // 每次最多读取几楼（以同步到的楼层结尾）
                syncBattle: true, // 成长同时更新进行中战斗里的单位
            },
        },
        ui: {
            layout: 'float', // float: 完整窗口 ; compact: 战斗小窗
            fab: true, // 显示悬浮按钮
            fabPos: { right: 20, bottom: 140 },
            cell: 48, // 格子大小上限（会根据面板大小自动缩小）
            animate: true,
            actionDelay: 260,
            confirmDefense: true,
            left: null, top: null, width: null, height: null, tab: 'battle',
        },
    };
}

/** 测试用：把示例资料卡的内容平铺到设置上（units / terrains / maps / rules + 全局设置） */
export function flatDefaults() {
    const d = defaultSettings();
    return { ...d, ...d.profiles[0] };
}
