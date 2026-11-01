// 单位 / 地形 / 地图 编辑器
import { h, clear, toast, button, select, field, numInput, textInput, textArea, checkbox, renderBoard, renderToken, contrast, groupSections } from './dom.js';
import { makeUnit, makeTrait, makeSkill, makeMap, makeWave, makeUnitType, unitTypePreset, uid, DEFAULT_TERRAINS } from '../defaults.js';
import { MISSION_NAMES, EFFECTS, TRAIT_EFFECTS, traitSummary, normalizeSkill, matchup, matchupLabel, isNeutralMatchup, battleUnitTypes, blocksSight, DEFAULT_VISION } from '../engine.js';
import * as ST from '../st.js';

const SIDES = [['player', '我方'], ['ally', '友军'], ['enemy', '敌方']];
const AIS = [['aggressive', '主动出击（会接近目标）'], ['defensive', '原地迎击（只攻击可触及的目标）'], ['stationary', '固守不动（不移动）'],
    ['ranged', '远程游击（从安全位置攻击，不踏入敌人射程）'], ['flee', '逃跑（敌人接近时逃开，不攻击）']];
const KINDS = [['physical', '物理伤害（ATK vs DEF）'], ['magical', '魔法伤害（MATK vs MDEF）'], ['support', '辅助（治疗 / 增益 / 减益）']];
const TARGETS = [['ally', '友方（含自己）'], ['enemy', '敌方'], ['self', '仅自己'], ['tile', '空地（传送自身）']];

export function newEditorUi() {
    return { unitId: null, skillUnitId: null, skillId: null, typeId: null, terrainId: null, mapId: null, tool: 'paint', brush: 'plain', placeUnit: null, wbBook: null };
}

/** 编辑器顶部：提示正在编辑哪张资料卡 */
function profileNote(app) {
    return h('div.tsrpg-row.tsrpg-muted.tsrpg-profile-note', h('i.fa-solid.fa-address-card'), ` 正在编辑资料卡：${app.data.name}`,
        h('a.tsrpg-link', { onclick: () => app.setTab('profiles') }, '切换'));
}

function listItem(active, onclick, ...content) {
    return h(`div.tsrpg-list-item${active ? '.active' : ''}`, { onclick }, ...content);
}

// ================================================================ 单位

export function renderUnitsTab(app, root) {
    clear(root);
    const s = app.settings, ed = app.ed;
    if (!app.data.units.some(u => u.id === ed.unitId)) ed.unitId = app.data.units[0]?.id || null;
    const cur = app.data.units.find(u => u.id === ed.unitId);

    const add = side => {
        const u = makeUnit({ side, name: side === 'enemy' ? '新敌人' : side === 'ally' ? '新友军' : '新角色' });
        app.data.units.push(u); ed.unitId = u.id; app.save(); app.render();
    };
    const list = h('div.tsrpg-list', { 'data-scroll': 'units-list' },
        h('div.tsrpg-row',
            button('我方', () => add('player'), { icon: 'fa-plus' }),
            button('敌方', () => add('enemy'), { icon: 'fa-plus' }),
            button('友军', () => add('ally'), { icon: 'fa-plus' })),
        SIDES.map(([side, label]) => {
            const us = app.data.units.filter(u => u.side === side);
            if (!us.length) return null;
            return [h('div.tsrpg-list-group', label), us.map(u => listItem(u.id === ed.unitId, () => { ed.unitId = u.id; ed.wbBook = null; app.render(); },
                renderToken({ ...u, maxHp: 0 }), h('span', u.name), typeBadge(typeOf(app, u.typeId)), u.wb ? h('i.fa-solid.fa-book.tsrpg-muted', { title: `${u.wb.book} › ${u.wb.label}` }) : null))];
        }),
    );
    root.append(profileNote(app));
    root.append(h('div.tsrpg-editor', list, h('div.tsrpg-form', { 'data-scroll': `units-form-${cur?.id || ''}` }, cur ? unitForm(app, cur) : h('div.tsrpg-empty', '新建一个单位开始吧。'))));
}

function unitForm(app, u) {
    const s = app.settings;
    const set = (k, rerender = false) => v => { u[k] = v; app.save(); if (rerender) app.render(); };
    const stat = (k, label, opts) => field(label, numInput(u[k], set(k), { min: 0, ...opts }));

    return groupSections(h('div',
        h('div.tsrpg-row',
            h('b.tsrpg-form-title', u.name),
            h('div.tsrpg-spacer'),
            button('复制', () => {
                const c = structuredClone(u); c.id = uid('unit'); c.name += '·副本';
                c.skills.forEach(sk => { sk.id = uid('sk'); });
                app.data.units.push(c); app.ed.unitId = c.id; app.save(); app.render();
            }, { icon: 'fa-copy' }),
            button('删除', () => {
                if (!confirm(`删除单位「${u.name}」？地图上它的放置和增援也会被移除。`)) return;
                app.data.units.splice(app.data.units.indexOf(u), 1);
                app.data.maps.forEach(m => {
                    m.placements = m.placements.filter(p => p.unitId !== u.id);
                    m.reinforcements = (m.reinforcements || []).filter(w => w.unitId !== u.id);
                });
                app.save(); app.render();
            }, { icon: 'fa-trash', cls: 'danger' }),
        ),
        h('div.tsrpg-section-title', h('i.fa-solid.fa-id-card'), ' 基本信息'),
        h('div.tsrpg-grid3',
            field('名称', textInput(u.name, set('name', true))),
            field('阵营', select(SIDES, u.side, set('side', true))),
            field('类型', select([['unit', '角色（会行动）'], ['object', '建筑 / 目标物（不会行动）']], u.kind || 'unit', set('kind', true)),
                '建筑物只有 HP / DEF / MDEF，例如城门、水晶、旗帜'),
            field('故事中的名字 / 别名', textInput(u.aliases, set('aliases'), '逗号分隔，可写 {{user}} {{char}}'),
                'LLM 在故事里怎么称呼这个单位；会写进战场信息，让两边对上号'),
            field('棋子文字', textInput(u.icon, set('icon', true), '默认取名称首字')),
            field('棋子颜色', h('div.tsrpg-row',
                h('input', { type: 'color', value: u.color || '#2f6fd6', onchange: e => set('color', true)(e.target.value) }),
                button('', () => set('color', true)(''), { icon: 'fa-rotate-left', title: '使用阵营默认色' }))),
        ),
        h('div.tsrpg-grid2',
            field('兵种', select([['', '— 无兵种 —'], ...(app.data.unitTypes || []).map(t => [t.id, t.name])], u.typeId || '', set('typeId', true)),
                '兵种之间的克制关系（伤害、命中、韧性消耗）在「兵种」页设置'),
            h('div.tsrpg-row', button('编辑兵种', () => { if (u.typeId) app.ed.typeId = u.typeId; app.setTab('types'); }, { icon: 'fa-chess' }))),
        h('div.tsrpg-row',
            checkbox('★ 关键目标', u.keyTarget, set('keyTarget', true), '守城战：我方/友军的关键目标是敌人进攻的对象，被摧毁即失败；进攻战：敌方的关键目标全部被摧毁即胜利'),
            h('small.tsrpg-muted', u.side === 'enemy' ? '敌方关键目标：进攻战中需要破坏它' : '我方关键目标：守城战中敌人会直奔它，被摧毁即失败'),
        ),
        h('div.tsrpg-section-title', h('i.fa-solid.fa-chart-simple'), ' ', '基础数值'),
        u.kind === 'object' ? [h('div.tsrpg-grid7', stat('hp', 'HP', { min: 1 }), stat('def', 'DEF'), stat('mdef', 'MDEF'), field('视野', numInput(u.vision ?? 0, set('vision'), { min: 0 }))),
            h('small.tsrpg-muted', '建筑的视野默认 0；设为大于 0 可以当作瞭望塔，在战争迷雾中为己方提供视野。')] : [
            h('div.tsrpg-grid7',
                stat('hp', 'HP', { min: 1 }), stat('atk', 'ATK'), stat('matk', 'MATK'),
                stat('def', 'DEF'), stat('mdef', 'MDEF'), stat('agi', 'AGI'), stat('mov', 'MOV'),
            ),
            h('small.tsrpg-muted', 'AGI（敏捷）影响命中与闪避：命中率＝基础命中 ＋（攻方AGI − 守方AGI）× 系数 − 地形闪避。'),
            h('div.tsrpg-grid3', stat('tough', '韧性', { min: 0 }), field('视野', numInput(u.vision ?? DEFAULT_VISION, set('vision'), { min: 0 }))),
            h('small.tsrpg-muted', '韧性：受到攻击时每次防御或反击消耗 1 点（兵种克制可以改变消耗），耗尽后只能承受全额伤害；己方阶段开始时回满。集中攻击同一目标可以打穿它的韧性。视野：战争迷雾中能看到几格内的敌人，侦察兵可以设得更高。'),
            h('div.tsrpg-grid3',
                field('普通攻击类型', select(KINDS.slice(0, 2), u.atkType, set('atkType'))),
                field('攻击射程（最小）', numInput(u.rangeMin, set('rangeMin'), { min: 1 })),
                field('攻击射程（最大）', numInput(u.rangeMax, set('rangeMax'), { min: 1 })),
            ),
            h('div.tsrpg-grid2',
                field('武器名称', textInput(u.weaponName || '', set('weaponName'), '例如：大剑、长枪')),
                field('普通攻击顺序', select([['normal', '普通：主动攻击时先出手'], ['last', '后手：大剑 / 重武器']], u.attackOrder || 'normal', set('attackOrder')))),
            h('small.tsrpg-muted', '后手角色主动普通攻击时，可回击且非后手的目标先攻击；若先被击败则无法出手。双方都是后手时仍由主动方先攻。目标无法回击、眩晕或是建筑时不抢先；MAP技能不触发这一规则。'),
            h('div.tsrpg-row',
                checkbox('飞行单位', u.flying, set('flying'), '飞行单位无视地形移动消耗，可越过河流、峡谷等'),
                checkbox('普通攻击可对空', u.antiAir, set('antiAir'), '例如弓箭手：战斗规则中「飞行单位」设为「只能被对空攻击打到」时，只有对空的普通攻击能攻击和反击飞行单位'),
                app.data.rules.airTarget === 'antiAir' ? null : h('small.tsrpg-muted', '（对空只在「设置 → 战斗规则 → 飞行单位」开启限制后生效）'),
            ),
            u.side !== 'player' ? field('AI 行为', select(AIS, u.ai, set('ai'))) : null,
            u.side !== 'player' && u.skills?.some(sk => ['mapLine', 'mapArea'].includes(sk.attackMode))
                ? checkbox('鲁莽使用MAP攻击', u.mapReckless !== false, set('mapReckless'), '开启：只要能打到敌人就发射，不顾误伤友军，可以引诱它轰击自己人；关闭：误伤友军的损失大于收益时不使用')
                : null,
        ],
        h('div.tsrpg-section-title', h('i.fa-solid.fa-book'), ' ', '世界书绑定'),
        wbBinder(app, u),
        traitEditor(app, u),
        u.kind === 'object' ? null : skillEditor(app, u),
        field('备注', textArea(u.notes, set('notes'), 2, '仅自己可见的备注')),
    ));
}

/** 选择一个特质编辑；同一特质可组合任意多个效果。 */
function traitEditor(app, u) {
    u.traits ||= [];
    const ed = app.ed;
    if (ed.traitUnitId !== u.id || !u.traits.some(t => t.id === ed.traitId)) {
        ed.traitUnitId = u.id;
        ed.traitId = u.traits[0]?.id || null;
    }
    const t = u.traits.find(t => t.id === ed.traitId);
    const save = () => app.save();
    const add = (over = {}) => {
        const t = makeTrait(over); u.traits.push(t); ed.traitId = t.id; save(); app.render();
    };
    return h('div.tsrpg-skill-editor',
        h('div.tsrpg-section-title', h('i.fa-solid.fa-star'), ' ', '特质'),
        h('small.tsrpg-muted', '常驻生效，不消耗行动、不被驱散。多个特质的属性加成相加；描述用于战斗描写，实际效果由下面的组合决定。修改后在新战斗或新摆放的单位上生效。'),
        h('div.tsrpg-row.tsrpg-skill-picker',
            u.traits.length ? field('选择已有特质', select(u.traits.map(t => [t.id, t.name || '未命名特质']), ed.traitId, id => { ed.traitId = id; app.render(); })) : null,
            button('创建新特质', () => add(), { icon: 'fa-plus' }),
            button('强壮', () => add({ name: '强壮', desc: '体格强健，攻击力常驻提高10%。', effects: [{ type: 'atk_up', value: 10 }] })),
            button('再生', () => add({ name: '再生', desc: '每次自己阵营回合开始恢复生命。', effects: [{ type: 'regen', value: 10 }] })),
            button('欠揍', () => add({ name: '欠揍', desc: '容易吸引周围敌人的注意。', effects: [{ type: 'attract', value: 3 }] }))),
        t ? h('div.tsrpg-skill',
            field('特质名称', textInput(t.name, v => { t.name = v; save(); })),
            field('特质描述', textArea(t.desc, v => { t.desc = v; save(); }, 2, '写下特质的表现与设定')),
            h('div.tsrpg-muted', traitSummary(t) || '尚未配置效果'),
            (t.effects || []).map(e => {
                const d = TRAIT_EFFECTS[e.type] || {};
                return h('div.tsrpg-effect',
                    select(Object.entries(TRAIT_EFFECTS).map(([id, def]) => [id, def.name]), e.type, type => {
                        e.type = type; e.value = TRAIT_EFFECTS[type].value; e.flat = false; save(); app.render();
                    }),
                    h('label.tsrpg-inline', numInput(e.value, v => { e.value = v; save(); }, { min: 0 }),
                        h('small', d.stat && e.flat ? '固定值' : d.unit || '')),
                    d.stat && !d.flat ? checkbox('固定数值加成', e.flat, v => { e.flat = v; save(); app.render(); }) : h('small.tsrpg-muted', e.type === 'attract' ? '优先攻击，无法攻击时可选其他目标' : d.stat ? '常驻' : '自己阵营回合开始触发'),
                    button('', () => { t.effects.splice(t.effects.indexOf(e), 1); save(); app.render(); }, { icon: 'fa-xmark', cls: 'danger', title: '移除特质效果' }));
            }),
            h('div.tsrpg-row',
                button('添加特质效果', () => { (t.effects ||= []).push({ type: 'atk_up', value: 10 }); save(); app.render(); }, { icon: 'fa-plus' }),
                button('删除特质', () => { u.traits.splice(u.traits.indexOf(t), 1); save(); app.render(); }, { icon: 'fa-trash', cls: 'danger' })))
            : h('div.tsrpg-muted', '先选择已有特质，或创建一个新特质。'));
}

/** 先选择技能，再编辑；切换单位或删除技能时修正当前选择。 */
function skillEditor(app, u) {
    const ed = app.ed;
    if (ed.skillUnitId !== u.id || !u.skills.some(sk => sk.id === ed.skillId)) {
        ed.skillUnitId = u.id;
        ed.skillId = u.skills[0]?.id || null;
    }
    const selected = u.skills.find(sk => sk.id === ed.skillId);
    return h('div.tsrpg-skill-editor',
        h('div.tsrpg-section-title', h('i.fa-solid.fa-wand-sparkles'), ' ', '技能'),
        h('div.tsrpg-row.tsrpg-skill-picker',
            u.skills.length ? field('选择已有技能', select(
                u.skills.map(sk => [sk.id, sk.name || '未命名技能']), ed.skillId,
                id => { ed.skillId = id; app.render(); },
            )) : null,
            button('创建新技能', () => {
                const sk = makeSkill();
                u.skills.push(sk);
                ed.skillId = sk.id;
                app.save(); app.render();
            }, { icon: 'fa-plus' }),
        ),
        selected ? skillForm(app, u, selected) : h('div.tsrpg-muted', '还没有技能，点击「创建新技能」开始编辑。'),
    );
}

/** 预设效果下拉框（按 立即 / 增益 / 减益 分组），效果类型只能从预设中选择 */
function effectSelect(value, onchange) {
    const groups = {};
    for (const [id, def] of Object.entries(EFFECTS)) (groups[def.group] ||= []).push([id, def.name]);
    const el = h('select.text_pole', { onchange: e => onchange(e.target.value) },
        Object.entries(groups).map(([g, opts]) => h('optgroup', { label: g }, opts.map(([id, name]) => h('option', { value: id }, name)))));
    el.value = value;
    return el;
}

function effectRow(app, sk, e) {
    const def = EFFECTS[e.type] || {};
    const save = () => { app.save(); };
    return h('div.tsrpg-effect',
        effectSelect(e.type, v => {
            // 换类型时套用该预设的默认数值
            e.type = v;
            e.value = EFFECTS[v].value ?? 0;
            e.turns = EFFECTS[v].instant ? 0 : (e.turns || 2);
            app.save(); app.render();
        }),
        def.noValue ? h('span.tsrpg-muted', '—') : h('label.tsrpg-inline',
            numInput(e.value, v => { e.value = v; save(); }, { min: e.type === 'taunt' ? 0 : 1 }), h('small', def.unit || '')),
        def.instant ? h('small.tsrpg-muted', '立即生效') : h('label.tsrpg-inline',
            numInput(e.turns, v => { e.turns = Math.max(1, v); save(); }, { min: 1 }), h('small', '回合')),
        h('small.tsrpg-muted.tsrpg-effect-help', def.help || ''),
        button('', () => { sk.effects.splice(sk.effects.indexOf(e), 1); app.save(); app.render(); }, { icon: 'fa-xmark', cls: 'danger', title: '移除效果' }),
    );
}

function skillForm(app, u, sk) {
    normalizeSkill(sk);
    const set = (k, rerender = false) => v => { sk[k] = v; app.save(); if (rerender) app.render(); };
    const support = sk.kind === 'support';
    const self = support && sk.target === 'self';
    const tile = support && sk.target === 'tile';
    const map = ['mapLine', 'mapArea'].includes(sk.attackMode);
    return h('div.tsrpg-skill',
        h('div.tsrpg-grid3',
            field('技能名', textInput(sk.name, set('name', true))),
            field('类型', select(KINDS, sk.kind, v => {
                sk.kind = v;
                sk.target = v === 'support' ? 'ally' : 'enemy';
                if (v === 'support') sk.attackMode = 'normal';
                app.save(); app.render();
            })),
            support
                ? field('作用对象', select(TARGETS, sk.target, set('target', true)))
                : field('威力 %', numInput(sk.power, set('power'), { min: 0, step: 10 })),
        ),
        support ? null : h('div.tsrpg-grid2',
            field('攻击方式', select([['normal', '普通技能'], ['mapLine', 'MAP：直线路径攻击'], ['mapArea', 'MAP：指定地块范围攻击']], sk.attackMode, v => {
                sk.attackMode = v;
                if (v === 'mapArea') sk.radius = Math.max(1, Number(sk.radius) || 1);
                app.save(); app.render();
            })),
            map ? field('MAP作用对象', select([['all', '敌我全部（不伤害自己）'], ['enemy', '仅敌方']], sk.mapTargets, set('mapTargets', true))) : null),
        map ? h('small.tsrpg-muted', 'MAP不触发反击或后手交换；同时攻击所有覆盖目标。默认会误伤友军，可切换为仅敌方。') : null,
        tile ? h('small.tsrpg-muted', '传送：点击射程内的空地，施法者瞬间移动过去，无视路径和移动消耗（落脚地形伤害照常）。下方的效果作用于施法者自己，可以不添加。') : null,
        support ? h('div.tsrpg-row',
            checkbox('速攻', !!sk.quick, set('quick', true), '选中角色后随时使用（移动前后都可以），不消耗行动；每回合最多使用一次'),
            h('small.tsrpg-muted', '速攻：不消耗行动和攻击机会，每回合一次；敌方 AI 会在行动前使用')) : null,
        h('div.tsrpg-grid5',
            self || sk.attackMode === 'mapLine' ? null : field('射程最小', numInput(sk.rangeMin, set('rangeMin'), { min: 0 }), '0＝可以对自己所在格使用'),
            self || sk.attackMode === 'mapLine' ? null : field('射程最大', numInput(sk.rangeMax, set('rangeMax'), { min: 0 })),
            sk.attackMode === 'mapLine' ? field('直线长度', numInput(sk.lineLength, set('lineLength'), { min: 1, max: 100 }), '从自己向上下左右延伸；点击方向上的任一格') : self || tile ? null : field('范围半径', numInput(sk.radius, set('radius'), { min: sk.attackMode === 'mapArea' ? 1 : 0 }), '按格子距离计算菱形范围；普通技能0＝单体'),
            field('冷却回合', numInput(sk.cooldown, set('cooldown'), { min: 0 }), '每 N 回合可用一次；0 或 1＝每回合可用'),
            field('次数', numInput(sk.uses, set('uses'), { min: 0 }), '每场战斗；0＝无限'),
        ),
        support && sk.target !== 'enemy' ? null : h('div.tsrpg-row',
            h('span.tsrpg-label', '命中修正 %'),
            h('div', { style: { width: '90px' } }, numInput(sk.hitMod, set('hitMod'), { min: -100, max: 100, step: 5 })),
            checkbox('必中（无视闪避）', sk.sureHit, set('sureHit', true)),
            checkbox('可以对空', sk.antiAir, set('antiAir', true), '例如火球：战斗规则中「飞行单位」设为「只能被对空攻击打到」时，只有对空的技能能打到飞行单位（范围技能也只波及对空能打到的单位）'),
            h('small.tsrpg-muted', '对友方的技能必定命中'),
        ),
        h('div.tsrpg-label', support ? '效果' : '附加效果（命中且未被击败的目标获得）'),
        sk.effects.map(e => effectRow(app, sk, e)),
        h('div.tsrpg-row',
            button('添加效果', () => {
                const type = support ? (sk.target === 'enemy' ? 'atk_down' : 'heal') : 'def_down';
                sk.effects.push({ type, value: EFFECTS[type].value, turns: EFFECTS[type].instant ? 0 : 2 });
                app.save(); app.render();
            }, { icon: 'fa-plus' }),
            support && !tile && !sk.effects.length ? h('small.tsrpg-warn', '辅助技能至少需要一个效果') : null,
        ),
        h('div.tsrpg-row',
            textInput(sk.desc, set('desc'), '技能描述（会告诉 LLM，用于描写）'),
            button('', () => { u.skills.splice(u.skills.indexOf(sk), 1); app.save(); app.render(); }, { icon: 'fa-trash', cls: 'danger', title: '删除技能' }),
        ),
    );
}

function wbBinder(app, u) {
    const ed = app.ed;
    const book = ed.wbBook ?? u.wb?.book ?? '';
    const bookSel = select([['', '— 选择世界书 —']], '', v => { ed.wbBook = v; app.render(); });
    const entrySel = select([['', '— 选择条目 —']], '', async v => {
        if (!v) return;
        const entries = await ST.loadBookEntries(book);
        const e = entries.find(x => String(x.uid) === v);
        if (!e) return;
        u.wb = { book, uid: e.uid, label: e.label, keys: e.keys };
        ed.wbBook = null;
        app.save(); app.render();
    });
    const status = h('div.tsrpg-muted');

    ST.listWorldBooks().then(names => {
        names.forEach(n => bookSel.append(h('option', { value: n }, n)));
        bookSel.value = book;
        if (book && !names.includes(book)) status.textContent = `⚠ 世界书「${book}」不存在或未加载`;
    }).catch(() => { status.textContent = '无法读取世界书列表'; });

    if (book) {
        ST.loadBookEntries(book, true).then(entries => {
            entries.forEach(e => entrySel.append(h('option', { value: String(e.uid) }, `${e.label}${e.keys.length ? `  [${e.keys.slice(0, 3).join(', ')}]` : ''}${e.disabled ? '（已禁用）' : ''}`)));
            if (u.wb?.book === book) entrySel.value = String(u.wb.uid);
            if (u.wb?.book === book && !entries.some(e => e.uid === u.wb.uid)) status.textContent = '⚠ 绑定的条目已不存在';
        }).catch(err => { status.textContent = `读取条目失败：${err.message || err}`; });
    }

    return h('div',
        h('div.tsrpg-grid2', field('世界书', bookSel), field('条目', entrySel)),
        u.wb ? h('div.tsrpg-row',
            h('span', h('i.fa-solid.fa-link'), ` 已绑定：${u.wb.book} › ${u.wb.label}`, u.wb.keys?.length ? h('small.tsrpg-muted', `  关键词：${u.wb.keys.join(', ')}`) : null),
            h('div.tsrpg-spacer'),
            button('用条目名命名', () => { u.name = u.wb.label; app.save(); app.render(); }, { icon: 'fa-signature' }),
            button('刷新', async () => {
                const e = (await ST.loadBookEntries(u.wb.book, true)).find(x => x.uid === u.wb.uid);
                if (!e) return toast('warning', '条目已不存在');
                Object.assign(u.wb, { label: e.label, keys: e.keys }); app.save(); app.render();
            }, { icon: 'fa-rotate', title: '重新读取条目名称与关键词' }),
            button('解除', () => { u.wb = null; app.save(); app.render(); }, { icon: 'fa-link-slash', cls: 'danger' }),
        ) : h('div.tsrpg-muted', '绑定后，发送战斗描写时会带上条目的第一个关键词，从而触发该世界书条目；也可在设置中选择把条目内容注入战场状态。'),
        status,
    );
}

// ================================================================ 兵种

function typeOf(app, id) {
    return id ? (app.data.unitTypes || []).find(t => t.id === id) || null : null;
}

function typeBadge(t) {
    if (!t) return null;
    const color = t.color || '#78909c';
    return h('span.tsrpg-type-badge', { style: { background: color, color: contrast(color) }, title: t.desc || t.name }, t.name);
}

export function renderTypesTab(app, root) {
    clear(root);
    const ed = app.ed;
    const types = app.data.unitTypes ||= [];
    if (!types.some(t => t.id === ed.typeId)) ed.typeId = types[0]?.id || null;
    const cur = types.find(t => t.id === ed.typeId);
    const list = h('div.tsrpg-list', { 'data-scroll': 'types-list' },
        button('新建兵种', () => {
            const t = makeUnitType(); types.push(t); ed.typeId = t.id; app.save(); app.render();
        }, { icon: 'fa-plus' }),
        button('添加模板', () => {
            const preset = unitTypePreset();
            if (!confirm(`添加 ${preset.map(t => `「${t.name}」`).join('')} 四个兵种和它们之间的克制关系？已有兵种不受影响。`)) return;
            types.push(...preset); ed.typeId = preset[0].id; app.save(); app.render();
        }, { icon: 'fa-wand-magic-sparkles', title: '战士 / 坦克 / 侦察 / 射手' }),
        types.map(t => listItem(t.id === ed.typeId, () => { ed.typeId = t.id; app.render(); },
            typeBadge(t), h('small.tsrpg-muted', ` ${app.data.units.filter(u => u.typeId === t.id).length} 个单位`))),
    );
    root.append(profileNote(app));
    root.append(h('div.tsrpg-editor', list, h('div.tsrpg-form', { 'data-scroll': `types-form-${cur?.id || ''}` },
        cur ? typeForm(app, cur) : h('div.tsrpg-empty', '兵种是单位的分类（如侦察、坦克、战士），可以设置兵种之间的克制关系。新建一个兵种，或点「添加模板」。'),
        types.length ? matchupMatrix(app) : null)));
}

const VS_FIELDS = [['dmg', '伤害倍率 %', 100, { min: 0, step: 10 }], ['hit', '命中修正 %', 0, { min: -100, max: 100, step: 5 }], ['tough', '韧性消耗倍数', 1, { min: 0, max: 10 }]];

function typeForm(app, t) {
    const types = app.data.unitTypes;
    const set = (k, rerender = false) => v => { t[k] = v; app.save(); if (rerender) app.render(); };
    const snapshot = { unitTypes: battleUnitTypes(types) };
    const edit = (d, key) => v => {
        const vs = t.vs[d.id] = { dmg: 100, hit: 0, tough: 1, ...(t.vs[d.id] || {}), [key]: v };
        if (isNeutralMatchup(matchup({ unitTypes: battleUnitTypes([t]) }, { typeId: t.id }, { typeId: d.id }))) delete t.vs[d.id];
        else t.vs[d.id] = vs;
        app.save(); app.render();
    };
    const users = app.data.units.filter(u => u.typeId === t.id);
    return groupSections(h('div',
        h('div.tsrpg-row', h('b.tsrpg-form-title', t.name), h('div.tsrpg-spacer'),
            button('删除', () => {
                if (!confirm(`删除兵种「${t.name}」？使用它的 ${users.length} 个单位会变为无兵种。`)) return;
                types.splice(types.indexOf(t), 1);
                for (const o of types) delete o.vs?.[t.id];
                for (const u of users) u.typeId = '';
                app.save(); app.render();
            }, { icon: 'fa-trash', cls: 'danger' })),
        h('div.tsrpg-section-title', h('i.fa-solid.fa-id-card'), ' 基本信息'),
        h('div.tsrpg-grid2',
            field('名称', textInput(t.name, set('name', true))),
            field('标签颜色', h('div.tsrpg-row',
                h('input', { type: 'color', value: t.color || '#78909c', onchange: e => set('color', true)(e.target.value) }),
                button('', () => set('color', true)(''), { icon: 'fa-rotate-left', title: '默认颜色' })))),
        field('描述（会告诉 LLM）', textArea(t.desc, set('desc'), 2, '例如：轻装快速、视野开阔，擅长突袭射手')),
        h('div.tsrpg-section-title', h('i.fa-solid.fa-crosshairs'), ` 「${t.name}」攻击其他兵种时`),
        h('small.tsrpg-muted', '伤害倍率：100＝不变，150＝伤害×1.5；命中修正：加在命中率上；韧性消耗倍数：对方每次防御或反击消耗的韧性（默认 1，0＝招架不消耗，2＝一次耗两点）。普通攻击、技能和反击都适用，未设置的组合不受影响。'),
        h('div.tsrpg-vs-table',
            h('div.tsrpg-vs-row.head', h('span', '防守方'), VS_FIELDS.map(([, label]) => h('span', label)), h('span', '')),
            types.map(d => {
                const m = matchup(snapshot, { typeId: t.id }, { typeId: d.id });
                return h(`div.tsrpg-vs-row${isNeutralMatchup(m) ? '' : '.set'}`,
                    h('span', typeBadge(d)),
                    VS_FIELDS.map(([key, , , opts]) => numInput(m[key], edit(d, key), opts)),
                    isNeutralMatchup(m) ? h('small.tsrpg-muted', { title: '无克制' }, '—') : button('', () => { delete t.vs[d.id]; app.save(); app.render(); }, { icon: 'fa-rotate-left', title: '恢复为无克制' }));
            })),
        h('div.tsrpg-section-title', h('i.fa-solid.fa-shield-halved'), ` 其他兵种攻击「${t.name}」时`),
        types.map(a => {
            const label = matchupLabel(matchup(snapshot, { typeId: a.id }, { typeId: t.id }));
            return label ? h('div.tsrpg-row', typeBadge(a), h('span', `→ ${t.name}：${label}`)) : null;
        }),
        types.some(a => !isNeutralMatchup(matchup(snapshot, { typeId: a.id }, { typeId: t.id }))) ? null : h('div.tsrpg-muted', '没有兵种克制它。'),
        h('div.tsrpg-section-title', h('i.fa-solid.fa-users'), ' 使用这个兵种的单位'),
        users.length ? h('div.tsrpg-row', users.map(u => h('a.tsrpg-link.tsrpg-type-user', { onclick: () => { app.ed.unitId = u.id; app.setTab('units'); } }, renderToken({ ...u, maxHp: 0 }), ` ${u.name}`)))
            : h('div.tsrpg-muted', '还没有单位使用。在「单位」页选择兵种。'),
    ));
}

/** 克制总览：行＝攻击方，列＝防守方，格子显示伤害倍率（悬停看完整设置） */
function matchupMatrix(app) {
    const types = app.data.unitTypes;
    const snapshot = { unitTypes: battleUnitTypes(types) };
    return h('div.tsrpg-matrix-wrap',
        h('div.tsrpg-section-title', '克制总览', h('small.tsrpg-muted', '（行＝攻击方，列＝防守方；点击切换编辑的兵种）')),
        h('table.tsrpg-matrix',
            h('tr', h('th', '攻 \ 守'), types.map(d => h('th', typeBadge(d)))),
            types.map(a => h('tr',
                h('th', typeBadge(a)),
                types.map(d => {
                    const m = matchup(snapshot, { typeId: a.id }, { typeId: d.id });
                    const cls = m.dmg > 100 ? '.adv' : m.dmg < 100 ? '.dis' : '';
                    return h(`td${cls}${a.id === app.ed.typeId ? '.cur' : ''}`, { title: matchupLabel(m) || '无克制', onclick: () => { app.ed.typeId = a.id; app.render(); } },
                        isNeutralMatchup(m) ? '·' : `${m.dmg}%${m.hit ? ` ${m.hit > 0 ? '+' : ''}${m.hit}` : ''}${m.tough !== 1 ? ` 🛡×${m.tough}` : ''}`);
                })))));
}

// ================================================================ 地形

export function renderTerrainsTab(app, root) {
    clear(root);
    const s = app.settings, ed = app.ed;
    if (!app.data.terrains.some(t => t.id === ed.terrainId)) ed.terrainId = app.data.terrains[0]?.id || null;
    const cur = app.data.terrains.find(t => t.id === ed.terrainId);
    const list = h('div.tsrpg-list',
        button('新建地形', () => {
            const t = { id: uid('ter'), name: '新地形', symbol: '', color: '#a1887f', moveCost: 1, passable: true, flyable: true, defBonus: 0, healPct: 0, desc: '' };
            app.data.terrains.push(t); ed.terrainId = t.id; app.save(); app.render();
        }, { icon: 'fa-plus' }),
        button('添加熔岩', () => {
            let lava = app.data.terrains.find(t => t.id === 'lava');
            if (!lava) { lava = structuredClone(DEFAULT_TERRAINS.find(t => t.id === 'lava')); app.data.terrains.push(lava); app.save(); }
            ed.terrainId = lava.id; app.render();
        }, { icon: 'fa-fire' }),
        app.data.terrains.map(t => listItem(t.id === ed.terrainId, () => { ed.terrainId = t.id; app.render(); },
            h('span.tsrpg-swatch', { style: { background: t.color, color: contrast(t.color) } }, t.symbol || ''), h('span', t.name))),
    );
    root.append(profileNote(app));
    list.setAttribute('data-scroll', 'terrains-list');
    root.append(h('div.tsrpg-editor', list, h('div.tsrpg-form', { 'data-scroll': `terrains-form-${cur?.id || ''}` }, cur ? terrainForm(app, cur) : null)));
}

function terrainForm(app, t) {
    const s = app.settings;
    const set = (k, rerender = false) => v => { t[k] = v; app.save(); if (rerender) app.render(); };
    return groupSections(h('div',
        h('div.tsrpg-row', h('b.tsrpg-form-title', t.name), h('div.tsrpg-spacer'),
            button('删除', () => {
                if (app.data.terrains.length <= 1) return toast('warning', '至少保留一种地形');
                const fallback = app.data.terrains.find(x => x !== t);
                if (!confirm(`删除地形「${t.name}」？地图上使用它的格子会变为「${fallback.name}」。`)) return;
                app.data.terrains.splice(app.data.terrains.indexOf(t), 1);
                app.data.maps.forEach(m => { m.tiles = m.tiles.map(id => id === t.id ? fallback.id : id); });
                app.save(); app.render();
            }, { icon: 'fa-trash', cls: 'danger' })),
        h('div.tsrpg-section-title', h('i.fa-solid.fa-mountain-sun'), ' 基本属性'),
        h('div.tsrpg-grid3',
            field('名称', textInput(t.name, set('name', true))),
            field('符号', textInput(t.symbol, set('symbol', true), '如 ♣ ≈ ▲')),
            field('颜色', h('input', { type: 'color', value: t.color, onchange: e => set('color', true)(e.target.value) })),
        ),
        h('div.tsrpg-grid4',
            field('移动消耗', numInput(t.moveCost, set('moveCost'), { min: 0.1, step: 0.1 }), '进入此格消耗的移动力；可以是小数，0.5＝在此地形上移动距离翻倍'),
            field('减伤 %', numInput(t.defBonus, set('defBonus'), { min: -100, max: 100 }), '站在此格时受到伤害的减免（可为负）'),
            field('闪避加成 %', numInput(t.avoid ?? 0, set('avoid'), { min: -100, max: 100 }), '站在此格时，敌人对它的命中率降低（可为负）'),
            field('回合回复 %', numInput(t.healPct, set('healPct'), { min: 0, max: 100 }), '回合开始时恢复最大 HP 的比例'),
        ),
        h('div.tsrpg-row',
            checkbox('步行可通过', t.passable, set('passable')),
            checkbox('飞行可通过', t.flyable, set('flyable')),
        ),
        h('div.tsrpg-section-title', h('i.fa-solid.fa-fire'), ' ', '地形伤害'),
        h('div.tsrpg-grid4',
            field('落脚扣血', numInput(t.enterDamage ?? 0, set('enterDamage'), { min: 0 }), '移动终点落在此格时扣除固定HP'),
            field('落脚扣血 %', numInput(t.enterDamagePct ?? 0, set('enterDamagePct'), { min: 0, max: 100 }), '按最大HP计算，与固定伤害相加'),
            field('回合扣血', numInput(t.turnDamage ?? 0, set('turnDamage'), { min: 0 }), '该单位所属阵营阶段开始时扣血'),
            field('回合扣血 %', numInput(t.turnDamagePct ?? 0, set('turnDamagePct'), { min: 0, max: 100 }), '按最大HP计算，与固定伤害相加'),
        ),
        checkbox('地形伤害也影响飞行单位', t.damageFlying ?? false, set('damageFlying')),
        h('small.tsrpg-muted', '地形伤害可致死，不受防御减免；只结算落脚格，不计算沿途经过的格子。'),
        h('div.tsrpg-section-title', h('i.fa-solid.fa-eye'), ' ', '视野（战争迷雾）'),
        h('div.tsrpg-grid3',
            field('视野加成', numInput(t.visionBonus ?? 0, set('visionBonus'), { min: -10, max: 10 }), '站在此格的单位视野增减（格），例如山地 +2'),
            field('隐蔽距离', numInput(t.conceal ?? 0, set('conceal'), { min: 0, max: 20 }), '站在此格的单位只能被这么近的敌人发现；0＝不隐蔽，1＝只有相邻才能发现。飞行单位不受隐蔽'),
            h('div', checkbox('遮挡视线', blocksSight(t), set('blockSight'), '视线无法穿过此格（例如城墙）'))),
        h('small.tsrpg-muted', '只在开启了战争迷雾的地图上生效。'),
        field('描述（会告诉 LLM）', textArea(t.desc, set('desc'), 2, '例如：湍急的河流，水声隆隆')),
    ));
}

// ================================================================ 地图

let painting = false;
let lastPaint = null;
window.addEventListener('mouseup', () => { painting = false; lastPaint = null; });

export function renderMapsTab(app, root) {
    clear(root);
    const s = app.settings, ed = app.ed;
    if (!app.data.maps.some(m => m.id === ed.mapId)) ed.mapId = app.data.maps[0]?.id || null;
    const cur = app.data.maps.find(m => m.id === ed.mapId);
    const list = h('div.tsrpg-list',
        button('新建地图', () => {
            const m = makeMap({ tiles: undefined });
            m.tiles = new Array(m.w * m.h).fill(app.data.terrains[0]?.id || 'plain');
            app.data.maps.push(m); ed.mapId = m.id; app.save(); app.render();
        }, { icon: 'fa-plus' }),
        app.data.maps.map(m => listItem(m.id === ed.mapId, () => { ed.mapId = m.id; app.render(); }, h('span', m.name), h('small.tsrpg-muted', ` ${m.w}×${m.h}`))),
    );
    root.append(profileNote(app));
    list.setAttribute('data-scroll', 'maps-list');
    root.append(h('div.tsrpg-editor.wide', list, h('div.tsrpg-form', { 'data-scroll': `maps-form-${cur?.id || ''}` }, cur ? mapForm(app, cur) : h('div.tsrpg-empty', '新建一张地图吧。'))));
}

function resizeMap(m, w, h2, fill) {
    w = Math.max(3, Math.min(40, w | 0)); h2 = Math.max(3, Math.min(40, h2 | 0));
    const tiles = new Array(w * h2).fill(fill);
    for (let y = 0; y < Math.min(h2, m.h); y++) for (let x = 0; x < Math.min(w, m.w); x++) tiles[y * w + x] = m.tiles[y * m.w + x];
    m.tiles = tiles; m.w = w; m.h = h2;
    m.placements = m.placements.filter(p => p.x < w && p.y < h2);
    m.reinforcements = (m.reinforcements || []).filter(r => r.x < w && r.y < h2);
}

const TURNS_LABEL = {
    annihilate: ['回合限制', '0＝不限；超过回合数仍未歼灭敌人即失败'],
    defend: ['坚守回合数', '坚守到该回合结束即胜利；0＝必须击退所有敌人'],
    assault: ['回合限制', '0＝不限；超过回合数仍未摧毁关键目标即失败'],
};
const MISSION_HELP = {
    annihilate: '击败所有敌人（包括后续增援）。敌人会寻找最近的角色攻击。',
    defend: '放置我方/友军的「★ 关键目标」（如城门、平民）。敌人会朝它们前进并攻击，只在被挡住时攻击挡路的角色。被摧毁的数量达到下方设置即失败。',
    assault: '放置至少一个敌方「★ 关键目标」（如水晶、旗帜），全部摧毁即胜利。可配合增援让敌人源源不断。',
};

function guardCount(app, m) {
    const defs = new Map(app.data.units.map(u => [u.id, u]));
    return (m.placements || []).filter(p => { const d = defs.get(p.unitId); return d && d.side !== 'enemy' && d.keyTarget; }).length;
}

function fogEditor(app, m) {
    m.fog ||= { enabled: false, ai: true };
    const set = k => v => { m.fog[k] = v; app.save(); app.render(); };
    // 返回数组：由外层表单分组成卡片
    return [
        h('div.tsrpg-section-title', h('i.fa-solid.fa-smog'), ' 战争迷雾'),
        h('div.tsrpg-row',
            checkbox('开启战争迷雾', m.fog.enabled, set('enabled')),
            m.fog.enabled ? checkbox('敌方 AI 也受迷雾限制', m.fog.ai !== false, set('ai'), '开启：敌人只追踪看得见的我方单位，看不到时前往最后发现的位置搜索；关闭：敌人知道所有我方单位的位置') : null),
        h('small.tsrpg-muted', m.fog.enabled
            ? '我方与友军共享视野，只能看到视野内的敌人（单位的「视野」属性、地形的视野加成 / 隐蔽 / 遮挡视线）。地形始终可见。看不见的敌人不能被选为攻击或单体技能目标，移动途中撞上会遭遇伏击；攻击会暴露位置直到对方下一阶段开始。LLM 也只会读到我方看得见的敌人。'
            : '开启后，只能看到己方视野内的敌人，侦察、埋伏和照明会变得重要。')];
}

function missionEditor(app, m) {
    const s = app.settings;
    const ms = m.mission;
    const [label, hint] = TURNS_LABEL[ms.type] || TURNS_LABEL.annihilate;
    const unitOpts = app.data.units.map(u => [u.id, `${u.name}（${SIDES.find(x => x[0] === u.side)?.[1]}）`]);
    const num = (w, k, min = 0, offset = 0) => numInput((Number(w[k]) || 0) + offset, v => { w[k] = Math.max(min, v - offset); app.save(); app.render(); }, { min: min + offset });
    return [
        h('div.tsrpg-section-title', h('i.fa-solid.fa-bullseye'), ' 任务'),
        h('div.tsrpg-grid3',
            field('任务类型', select(Object.entries(MISSION_NAMES), ms.type, v => { ms.type = v; app.save(); app.render(); })),
            field(label, numInput(ms.turns, v => { ms.turns = Math.max(0, v); app.save(); }, { min: 0 }), hint),
            ms.type === 'defend' ? field('被摧毁几个算失败', numInput(Math.max(1, Number(ms.lossLimit) || 1), v => { ms.lossLimit = Math.max(1, Math.floor(v) || 1); app.save(); }, { min: 1 }),
                `1＝任意一个被摧毁即失败；大于等于关键目标数量时，全部被摧毁才失败。当前地图有 ${guardCount(app, m)} 个我方/友军关键目标`) : null,
        ),
        h('div.tsrpg-muted', MISSION_HELP[ms.type]),
        fogEditor(app, m),
        h('div.tsrpg-section-title', h('i.fa-solid.fa-people-group'), ' 增援', h('div.tsrpg-spacer'),
            button('添加增援', () => {
                m.reinforcements.push(makeWave({ unitId: app.data.units.find(u => u.side === 'enemy')?.id || app.data.units[0]?.id, x: m.w - 1, y: Math.floor(m.h / 2) }));
                app.save(); app.render();
            }, { icon: 'fa-plus' })),
        m.reinforcements.length ? m.reinforcements.map(w => h('div.tsrpg-skill',
            h('div.tsrpg-grid4',
                field('单位', select(unitOpts, w.unitId, v => { w.unitId = v; app.save(); app.render(); })),
                field('出现位置 X', num(w, 'x', 0, 1)),
                field('出现位置 Y', num(w, 'y', 0, 1)),
                field('每次数量', num(w, 'count', 1)),
            ),
            h('div.tsrpg-grid4',
                field('首次出现回合', num(w, 'startTurn', 1), '该回合的敌方/友军阶段结束时出现'),
                field('间隔回合', num(w, 'every', 0), '0＝只出现一次'),
                field('最多次数', num(w, 'times', 0), '0＝无限（间隔 > 0 时）'),
                h('div.tsrpg-row', button('删除', () => { m.reinforcements.splice(m.reinforcements.indexOf(w), 1); app.save(); app.render(); }, { icon: 'fa-trash', cls: 'danger' })),
            ),
        )) : h('div.tsrpg-muted', '没有增援。可以点「添加增援」，或用上方的「增援点」工具直接在地图上点选位置。'),
    ];
}

function mapForm(app, m) {
    const s = app.settings, ed = app.ed;
    const set = (k, rerender = false) => v => { m[k] = v; app.save(); if (rerender) app.render(); };
    m.mission ||= { type: 'annihilate', turns: 0 };
    m.reinforcements ||= [];
    if (!app.data.terrains.some(t => t.id === ed.brush)) ed.brush = app.data.terrains[0]?.id;
    if (!app.data.units.some(u => u.id === ed.placeUnit)) ed.placeUnit = app.data.units[0]?.id || null;
    const terrains = new Map(app.data.terrains.map(t => [t.id, t]));
    const terr = id => terrains.get(id) || { name: id, color: '#999' };
    const unitDefs = new Map(app.data.units.map(u => [u.id, u]));

    const apply = (x, y, cell) => {
        if (ed.tool === 'paint') {
            m.tiles[y * m.w + x] = ed.brush;
            const t = terr(ed.brush);
            if (cell) {
                cell.style.background = t.color; cell.style.color = contrast(t.color); cell.title = `(${x + 1},${y + 1}) ${t.name}`;
                const sym = cell.querySelector('.tsrpg-sym');
                if (sym) sym.textContent = t.symbol || ''; else if (t.symbol) cell.prepend(h('span.tsrpg-sym', t.symbol));
            }
            app.save();
            return false;
        }
        if (ed.tool === 'spawn') {
            if (ed.placeUnit) m.reinforcements.push(makeWave({ unitId: ed.placeUnit, x, y }));
            app.save();
            return true;
        }
        m.placements = m.placements.filter(p => p.x !== x || p.y !== y);
        if (ed.tool === 'place' && ed.placeUnit) m.placements.push({ unitId: ed.placeUnit, x, y });
        app.save();
        return true;
    };
    const marks = new Map();
    for (const w of m.reinforcements) marks.set(`${w.x},${w.y}`, ['m-spawn']);

    const board = renderBoard({
        w: m.w, h: m.h, tiles: m.tiles, terrain: terr, cell: app.cellFor(m.w, 192), marks,
        units: m.placements.filter(p => unitDefs.has(p.unitId)).map(p => ({ ...unitDefs.get(p.unitId), x: p.x, y: p.y, maxHp: 0 })),
        onCell: (x, y, e) => {
            painting = ed.tool === 'paint';
            lastPaint = [x, y];
            if (apply(x, y, e.target.closest('.tsrpg-cell'))) app.render();
        },
        onHover: (x, y, e) => {
            if (!painting || ed.tool !== 'paint') return;
            // 鼠标移动过快时补齐中间跳过的格子
            const [lx, ly] = lastPaint || [x, y];
            const steps = Math.max(Math.abs(x - lx), Math.abs(y - ly));
            for (let i = 1; i <= steps; i++) {
                const px = Math.round(lx + ((x - lx) * i) / steps), py = Math.round(ly + ((y - ly) * i) / steps);
                apply(px, py, board.querySelector(`[data-x="${px}"][data-y="${py}"]`));
            }
            lastPaint = [x, y];
        },
        onContext: (x, y) => {
            const key = ed.tool === 'spawn' ? 'reinforcements' : 'placements';
            const before = m[key].length;
            m[key] = m[key].filter(p => p.x !== x || p.y !== y);
            if (m[key].length !== before) { app.save(); app.render(); }
        },
    });

    const toolBtn = (tool, label, icon) => button(label, () => { ed.tool = tool; app.render(); }, { icon, cls: ed.tool === tool ? 'active' : '' });
    const sizeW = numInput(m.w, () => {}, { min: 3, max: 40 });
    const sizeH = numInput(m.h, () => {}, { min: 3, max: 40 });

    return groupSections(h('div',
        h('div.tsrpg-row', h('b.tsrpg-form-title', m.name), h('div.tsrpg-spacer'),
            button('复制', () => {
                const c = structuredClone(m); c.id = uid('map'); c.name += '·副本';
                app.data.maps.push(c); ed.mapId = c.id; app.save(); app.render();
            }, { icon: 'fa-copy' }),
            button('删除', () => {
                if (!confirm(`删除地图「${m.name}」？`)) return;
                app.data.maps.splice(app.data.maps.indexOf(m), 1); app.save(); app.render();
            }, { icon: 'fa-trash', cls: 'danger' })),
        h('div.tsrpg-section-title', h('i.fa-solid.fa-id-card'), ' 基本信息'),
        h('div.tsrpg-grid3',
            field('名称', textInput(m.name, set('name', true))),
            field('尺寸（宽×高）', h('div.tsrpg-row', sizeW, '×', sizeH,
                button('应用', () => { resizeMap(m, +sizeW.value, +sizeH.value, ed.brush); app.save(); app.render(); }, { icon: 'fa-check' }))),
        ),
        field('地图描述（会告诉 LLM）', textArea(m.desc, set('desc'), 2, '例如：一条河流将平原一分为二……')),
        h('div.tsrpg-section-title', h('i.fa-solid.fa-chess-board'), ' 地形与单位'),
        h('div.tsrpg-row.tsrpg-toolbar',
            toolBtn('paint', '画地形', 'fa-paintbrush'),
            toolBtn('place', '放置单位', 'fa-chess-pawn'),
            toolBtn('erase', '移除单位', 'fa-eraser'),
            toolBtn('spawn', '增援点', 'fa-flag'),
            ed.tool === 'paint' ? button('全图填充', () => {
                if (!confirm(`用「${terr(ed.brush).name}」填满整张地图？`)) return;
                m.tiles.fill(ed.brush); app.save(); app.render();
            }, { icon: 'fa-fill-drip' }) : null,
        ),
        ed.tool === 'paint' ? h('div.tsrpg-palette', app.data.terrains.map(t =>
            h(`div.tsrpg-palette-item${t.id === ed.brush ? '.active' : ''}`, { onclick: () => { ed.brush = t.id; app.render(); }, title: t.desc },
                h('span.tsrpg-swatch', { style: { background: t.color, color: contrast(t.color) } }, t.symbol || ''), t.name))) : null,
        ['place', 'spawn'].includes(ed.tool) ? h('div.tsrpg-palette', app.data.units.map(u =>
            h(`div.tsrpg-palette-item${u.id === ed.placeUnit ? '.active' : ''}`, { onclick: () => { ed.placeUnit = u.id; app.render(); } },
                renderToken({ ...u, maxHp: 0 }), u.name))) : null,
        h('div.tsrpg-muted', ed.tool === 'spawn'
            ? '点击地图添加一个增援点（使用上面选中的单位），右键删除该格的增援点。红色虚线 ⚑ 为增援出现点，详细设置在地图下方。'
            : '提示：按住鼠标拖动可连续绘制地形；右键格子可移除单位。同一单位可放置多次（自动编号 A、B、C…）。'),
        h('div.tsrpg-board-wrap', board),
        missionEditor(app, m),
    ));
}
