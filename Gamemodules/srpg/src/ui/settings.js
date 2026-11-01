// 设置页：描写模式、发送方式、战斗规则、注入、导入导出
import { groupSections, h, add, clear, toast, button, select, field, numInput, textArea, checkbox, textDialog } from './dom.js';
import { CONTEXT_SECTIONS } from '../context.js';
import { TOUGH_MODES, AIR_RULES } from '../engine.js';
import { MACROS } from '../llm.js';
import { COMMANDS } from '../commands.js';
import { getBattle } from '../st.js';
import * as ST from '../st.js';
import { DEFAULT_HEADER, defaultSettings } from '../defaults.js';
import { allPayload, profilesFromPayload, addProfiles, GLOBAL_KEYS } from '../profiles.js';
import { normalizeProfile } from '../st.js';
import { downloadJson, pickJson, today } from './files.js';


/** 单位资料：资料卡里的单位像世界书条目一样提供给聊天 AI */
function unitLoreSection(app, on) {
    const cfg = app.settings.inject.units;
    const refresh = () => { app.updateUnitLore(); app.render(); };
    return [
        h('div.tsrpg-section-title', h('i.fa-solid.fa-address-book'), ' 单位资料（类似世界书）'),
        h('div.tsrpg-muted', '把当前聊天绑定的资料卡中设定的单位（属性、兵种、特质、技能、别名）提供给聊天 AI，战斗之外也能读到，剧情描写与战棋能力保持一致。与世界书条目一样按关键词触发：最近的消息里出现单位的名字、别名或绑定的世界书关键词时才附上，放在角色设定之后。'),
        h('div.tsrpg-row',
            checkbox('把单位资料提供给 AI', cfg.enabled, on(cfg, 'enabled', refresh)),
            button('查看本次会附上的内容', () => {
                const { text, used, list } = app.unitLore();
                const note = !cfg.enabled ? '开关未开启，以下为开启后的效果。' : !ST.isEnabledForChat() ? '当前聊天没有绑定资料卡，不会注入。'
                    : `${list.length} 个单位中，${used.length ? `本次触发：${used.join('、')}` : '本次没有触发的单位（最近的消息里没有提到它们）'}。`;
                const all = app.unitLorePreview();
                const preview = cfg.enabled && text ? text : `${cfg.enabled ? '（本次不会附上任何内容。下面是各单位的资料，消息里提到时才会附上。）\n\n' : ''}${all || '（资料卡里没有符合范围的单位）'}`;
                textDialog(app.panel, '单位资料', preview, { note });
            }, { icon: 'fa-eye' })),
        cfg.enabled ? h('div.tsrpg-grid4',
            field('提供哪些单位', select([['party', '我方与友军'], ['all', '全部（包括敌人）']], cfg.scope, on(cfg, 'scope', refresh))),
            field('触发方式', select([['keyword', '提到名字或别名时'], ['constant', '总是附上']], cfg.trigger, on(cfg, 'trigger', refresh)),
                '「总是附上」会占用更多上下文'),
            cfg.trigger === 'keyword' ? field('扫描最近几条消息', numInput(cfg.scanDepth, on(cfg, 'scanDepth'), { min: 1, max: 50 })) : null,
            h('div', checkbox('包含技能', cfg.skills !== false, on(cfg, 'skills', refresh)))) : null,
        cfg.enabled ? h('small.tsrpg-muted', '战斗进行中、且开启了战场信息自动注入时，场上的单位以战场状态为准，不再重复附上。别名中的 {{user}} {{char}} 会被替换。单位编辑器里的「备注」不会提供给 AI。') : null,
    ];
}

export function renderSettingsTab(app, root) {
    clear(root);
    const s = app.settings;
    const on = (obj, k, after) => v => { obj[k] = v; app.save(); after?.(); };

    add(root,
        h('div.tsrpg-section-title', h('i.fa-solid.fa-feather'), ' ', '描写模式'),
        h('div.tsrpg-muted', '控制哪些战场变化需要 LLM 描写。关闭的项目不会出现在“需要描写”的列表中。'),
        h('div.tsrpg-checks',
            checkbox('描写移动 / 待机', s.narration.move, on(s.narration, 'move')),
            checkbox('描写普通攻击', s.narration.attack, on(s.narration, 'attack')),
            checkbox('描写技能释放', s.narration.skill, on(s.narration, 'skill')),
            checkbox('描写敌人行动', s.narration.enemy, on(s.narration, 'enemy')),
            checkbox('描写友军行动', s.narration.ally, on(s.narration, 'ally')),
            checkbox('描写回合切换 / 地形回复', s.narration.turn, on(s.narration, 'turn')),
            checkbox('描写增援出现', s.narration.reinforce, on(s.narration, 'reinforce')),
            checkbox('描写状态变化（中毒 / 持续恢复 / 眩晕 / 效果结束）', s.narration.status, on(s.narration, 'status')),
            checkbox('不描写的行动作为背景简要告知', s.narration.brief, on(s.narration, 'brief'), '开启后，未勾选描写的行动仍会以一句话告诉 LLM，避免它不知道发生了什么'),
        ),

        h('div.tsrpg-section-title', h('i.fa-solid.fa-paper-plane'), ' ', '发送方式'),
        h('div.tsrpg-grid2',
            field('棋盘操作后', select([
                ['preview', '弹出预览，确认后发送'],
                ['send', '直接以用户身份发送'],
                ['fill', '只填入输入框，由我手动发送'],
            ], s.send.mode, on(s.send, 'mode'))),
            h('div',
                checkbox('结束回合时自动整理发送', s.send.autoOnEndTurn, on(s.send, 'autoOnEndTurn')),
                checkbox('附带主输入框中的文字作为补充要求', s.send.includeInput, on(s.send, 'includeInput')),
            ),
        ),
        field('消息开头（给 LLM 的指令）', h('div',
            textArea(s.send.header, on(s.send, 'header'), 3),
            button('恢复默认', () => { s.send.header = DEFAULT_HEADER; app.save(); app.render(); }, { icon: 'fa-rotate-left' }))),

        h('div.tsrpg-section-title', h('i.fa-solid.fa-scale-balanced'), ' ', '战斗规则', h('small.tsrpg-muted', `（属于当前资料卡「${app.data.name}」）`)),
        h('div.tsrpg-grid4',
            field('伤害公式', select([['diminishing', '递减防御（推荐）'], ['subtract', '旧版减法：攻 − 防'], ['ratio', '比例：攻² ÷ (攻 + 防)']], app.data.rules.formula, on(app.data.rules, 'formula'))),
            field('防御基准', numInput(app.data.rules.defenseScale ?? 12, on(app.data.rules, 'defenseScale'), { min: 1 }), '递减公式中，防御等于此数值时减伤50%'),
            field('防御减伤 %', numInput(app.data.rules.defenseReduction ?? 50, on(app.data.rules, 'defenseReduction'), { min: 0, max: 100 }), '选择防御时额外减伤，放弃反击'),
            field('伤害浮动 ±%', numInput(app.data.rules.variance, on(app.data.rules, 'variance'), { min: 0, max: 50 })),
            field('最低伤害', numInput(app.data.rules.minDamage, on(app.data.rules, 'minDamage'), { min: 0 })),
            h('div', checkbox('普通攻击触发反击', app.data.rules.counter, on(app.data.rules, 'counter'), '只控制主动方攻击后的普通反击，不影响后手武器让目标先攻的规则')),
            field('韧性系统', select(Object.entries(TOUGH_MODES), app.data.rules.toughness || 'all', on(app.data.rules, 'toughness')),
                '韧性：防御或反击消耗1点，耗尽只能承受。「仅我方角色」或「关闭」时，不受韧性约束的敌方 / 友军只在能反击时反击，不会防御；我方关闭韧性后可以不限次数防御或反击'),
            field('飞行单位', select(Object.entries(AIR_RULES), app.data.rules.airTarget || 'all', on(app.data.rules, 'airTarget')),
                '「只能被对空攻击打到」时：只有勾选了「对空」的普通攻击（单位）和技能，或者飞行单位自己，才能攻击、反击、范围波及飞行单位。修改后对进行中的战斗立即生效'),
        ),
        h('div.tsrpg-muted', '递减防御：伤害＝攻击 × 威力% × 基准 ÷（基准＋防御）。物理用ATK/DEF，魔法用MATK/MDEF；最后计算地形、伤害浮动和最低伤害。基准12时：防御12减伤50%，防御24减伤约67%。'),
        h('div.tsrpg-grid4',
            h('div', checkbox('启用命中判定', app.data.rules.hitEnabled, on(app.data.rules, 'hitEnabled'))),
            field('基础命中率 %', numInput(app.data.rules.baseHit, on(app.data.rules, 'baseHit'), { min: 0, max: 200 })),
            field('每点敏捷差 %', numInput(app.data.rules.agiFactor, on(app.data.rules, 'agiFactor'), { min: 0, max: 20 })),
        ),
        h('div.tsrpg-muted', '命中率＝基础命中 ＋（攻方AGI − 守方AGI）× 系数 ＋ 技能命中修正 − 守方地形闪避，限制在 0–100%。普通攻击、反击、伤害技能和对敌方的辅助技能都会判定；对友方的技能、攻击建筑物、必中技能一定命中。'),

        h('div.tsrpg-section-title', h('i.fa-solid.fa-eye'), ' ', 'LLM 读取战场', h('div.tsrpg-spacer'),
            button('查看 LLM 看到的内容', () => previewContext(app), { icon: 'fa-eye' })),
        h('div.tsrpg-muted', '让 LLM 随时知道每个单位的 HP、状态、位置和地图，避免描写与棋盘对不上。有三种方式，可以同时使用。'),

        h('div.tsrpg-label', '① 自动注入：每次生成时附上战场信息'),
        h('div.tsrpg-grid4',
            h('div', checkbox('启用自动注入', s.inject.enabled, on(s.inject, 'enabled', () => app.updateInjection()))),
            field('注入位置', select([['chat', '聊天记录中（按深度）'], ['before', '主提示词之前'], ['after', '主提示词之后']], s.inject.position, on(s.inject, 'position', () => { app.updateInjection(); app.render(); }))),
            s.inject.position === 'chat' ? field('深度', numInput(s.inject.depth, on(s.inject, 'depth', () => app.updateInjection()), { min: 0, max: 50 }), '0＝最新消息之后') : h('div'),
            field('身份', select([['system', 'System'], ['user', 'User'], ['assistant', 'Assistant']], s.inject.role, on(s.inject, 'role', () => app.updateInjection()))),
        ),
        h('div.tsrpg-checks',
            Object.entries(CONTEXT_SECTIONS).map(([k, label]) => checkbox(label, s.inject[k], on(s.inject, k, () => app.updateInjection()))),
            checkbox('附带绑定的世界书条目内容', s.inject.includeWb, on(s.inject, 'includeWb', () => app.updateInjection()), '条目内容较长时会占用较多上下文'),
        ),
        h('div.tsrpg-row',
            h('span.tsrpg-label', '附带最近战斗记录（条）'),
            h('div', { style: { width: '80px' } }, numInput(s.inject.logLines, on(s.inject, 'logLines', () => app.updateInjection()), { min: 0, max: 50 })),
            h('small.tsrpg-muted', '0＝不附带。战斗过程已经写在聊天记录里，一般不需要。'),
        ),

        h('div.tsrpg-label', '② 宏：在提示词、角色卡、世界书、作者注释里手动放置'),
        h('div.tsrpg-macros', Object.entries(MACROS).map(([name, [desc]]) =>
            h('div', h('code', `{{${name}}}`), h('span.tsrpg-muted', ` ${desc}`))),
        h('div', h('code', '{{srpg_turn}}'), h('span.tsrpg-muted', ' 当前回合数'))),
        h('small.tsrpg-muted', '没有战斗时宏为空。如果用宏放置了完整信息，可以关闭自动注入，避免重复。'),

        h('div.tsrpg-label', '③ 函数调用：LLM 需要时自己查询'),
        h('div.tsrpg-row',
            checkbox('注册查询工具 SRPG_GetBattleState', s.tool.enabled, on(s.tool, 'enabled')),
            h('small.tsrpg-muted', '仅在战斗进行中可用。需要使用支持函数调用的 Chat Completion 接口，并在 AI 响应配置中开启「启用函数调用」。'),
        ),

        unitLoreSection(app, on),
        h('div.tsrpg-section-title', h('i.fa-solid.fa-robot'), ' ', 'LLM 影响战场'),
        h('div.tsrpg-muted', '这里的 LLM 都是「AI 设计」页「API 设置」中配置的模型，在后台单独调用，不经过聊天，也不会要求聊天 AI 输出任何东西。LLM 不会直接改数值：它要么从战斗系统列出的合法行动里做选择，要么提出指令，由战斗系统校验后再执行。'),

        h('div.tsrpg-label', '① LLM 指挥官：由 LLM 为 AI 单位选择行动'),
        h('div.tsrpg-row',
            checkbox('指挥敌方', s.llm.commander.enemy, on(s.llm.commander, 'enemy')),
            checkbox('指挥友军', s.llm.commander.ally, on(s.llm.commander, 'ally')),
            checkbox('附带一句意图（写进战斗描写）', s.llm.intent, on(s.llm, 'intent')),
        ),
        h('div.tsrpg-row',
            h('span.tsrpg-label', '每个单位的选项数'),
            h('div', { style: { width: '80px' } }, numInput(s.llm.options, on(s.llm, 'options'), { min: 2, max: 12 })),
            h('small.tsrpg-muted', '结束回合时，战斗系统列出每个单位的合法行动（攻击谁、用什么技能、向谁前进、待命），一次后台生成让 LLM 全部选好，再由系统执行。选不出来或行动已失效时，自动交给内置 AI。'),
        ),

        h('div.tsrpg-label', '② 战场变化：剧情同步时，从剧情中读出常规攻击与技能之外的战场变化（落石、喝药、援军赶到、桥被砍断……）'),
        h('div.tsrpg-grid3',
            h('div', checkbox('允许剧情同步提出战场变化', s.llm.commands, on(s.llm, 'commands', () => app.render()))),
            field('提出变化时', select([['confirm', '列在战场页，由我确认'], ['auto', '自动应用']], s.llm.mode, on(s.llm, 'mode'))),
            h('div', s.designer.story.enabled ? null : h('small.tsrpg-warn', '需要先在「AI 设计」页开启剧情同步'))),
        h('div.tsrpg-checks', Object.entries(COMMANDS).map(([id, c]) =>
            checkbox(c.label, s.llm.allow[id] !== false, v => { s.llm.allow[id] = v; app.save(); }, c.syntax))),
        h('div.tsrpg-row',
            h('span.tsrpg-label', '单条指令 HP 变化上限 %'),
            h('div', { style: { width: '80px' } }, numInput(s.llm.maxChangePct, on(s.llm, 'maxChangePct'), { min: 1, max: 100 })),
            checkbox('允许指令直接击败单位', s.llm.allowKill, on(s.llm, 'allowKill')),
        ),
        h('small.tsrpg-muted', '战斗进行中，剧情同步会把战场状态和这些规则一起交给插件模型。重新生成、滑动或删除同步读到的最后一楼时，它造成的改动会自动撤回；如果之后棋盘又有别的改动，则不会自动撤回。'),

        h('div.tsrpg-section-title', h('i.fa-solid.fa-display'), ' ', '界面'),
        h('div.tsrpg-grid4',
            field('面板位置', select([['float', '完整窗口'], ['compact', '战斗小窗（地图和操作）']], s.ui.layout, v => app.setLayout(v))),
            field('格子大小上限（像素）', numInput(s.ui.cell, on(s.ui, 'cell', () => app.render()), { min: 18, max: 80 }), '棋盘会按面板的宽度和高度自动缩放，最大不超过此值'),
            h('div', checkbox('显示悬浮按钮', s.ui.fab, on(s.ui, 'fab', () => app.placeFab())), h('small.tsrpg-muted', '可拖动；关闭后从魔杖菜单或 /srpg 打开')),
            checkbox('显示移动和攻击过程', s.ui.animate !== false, on(s.ui, 'animate')),
            checkbox('受攻击时手动选择反击 / 防御', s.ui.confirmDefense !== false, on(s.ui, 'confirmDefense'), '关闭时自动选择可用的反击，否则防御'),
            field('过程速度（毫秒）', numInput(s.ui.actionDelay ?? 260, on(s.ui, 'actionDelay'), { min: 80, max: 1000, step: 20 }), '越小越快；战斗中也可以跳过过程'),
        ),

        h('div.tsrpg-section-title', h('i.fa-solid.fa-file-export'), ' ', '导入 / 导出'),
        h('div.tsrpg-muted', '这里导出 / 导入的是全部资料卡和全局设置。单张资料卡请在「资料卡」页导出。'),
        h('div.tsrpg-row',
            button('导出全部', () => downloadJson(`tavern-srpg-all-${today()}.json`, allPayload(s)), { icon: 'fa-file-export' }),
            button('导入', () => importAll(app), { icon: 'fa-file-import' }),
            button('恢复默认设置', () => {
                if (!confirm('把描写、发送、LLM、界面等全局设置恢复为默认值？资料卡（单位、地形、地图、战斗规则）不受影响。')) return;
                const d = defaultSettings();
                for (const k of GLOBAL_KEYS) s[k] = d[k];
                app.save(); app.applyLayout(); app.updateInjection(); app.render();
            }, { icon: 'fa-rotate-left', cls: 'danger' }),
        ),
    );
    groupSections(root);
}

async function importAll(app) {
    try {
        const data = await pickJson();
        const s = app.settings;
        const profiles = profilesFromPayload(data);
        const replace = profiles.some(p => s.profiles.some(x => x.id === p.id))
            && confirm('有同名（同 ID）的资料卡。点击“确定”覆盖它们；点击“取消”作为副本导入。');
        const added = addProfiles(s, profiles, { replace, normalize: normalizeProfile });
        let globals = false;
        if (GLOBAL_KEYS.some(k => data[k]) && confirm('文件中还包含全局设置（描写、发送、LLM、界面），要一起导入吗？')) {
            for (const k of GLOBAL_KEYS) if (data[k] && typeof data[k] === 'object') s[k] = { ...s[k], ...data[k] };
            globals = true;
        }
        app.save(); app.applyLayout(); app.updateInjection(); app.render();
        toast('success', `已导入 ${added.length} 张资料卡${globals ? '和全局设置' : ''}`);
    } catch (err) {
        if (err?.message !== 'cancelled') toast('error', `导入失败：${err.message || err}`);
    }
}

function previewContext(app) {
    const b = getBattle();
    if (!b?.active) {
        toast('info', '当前聊天没有进行中的战斗。先在「战场」页开始一场战斗。');
        return;
    }
    const text = app.battleContext();
    textDialog(app.panel, 'LLM 看到的战场信息', text, {
        note: `约 ${text.length} 字。这就是自动注入和 {{srpg}} 宏的内容（{{user}} {{char}} 等宏会在发送时替换）。`,
    });
}
