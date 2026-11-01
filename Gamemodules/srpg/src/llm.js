// 让 LLM 读取战场：宏（{{srpg}} 等）与函数调用工具
import { ctx, getBattle, substitute } from './st.js';
import { alive, visibleTo } from './engine.js';
import { unitAliases } from './context.js';

/** 宏名 → [说明, 要输出的部分（null＝全部）] */
export const MACROS = {
    srpg: ['完整战场信息（与自动注入的内容相同）', null],
    srpg_mission: ['回合、阶段、任务与增援预告', ['mission']],
    srpg_map: ['地图网格与地形图例', ['map']],
    srpg_units: ['所有单位的 HP、位置、属性、状态、技能', ['units']],
    srpg_log: ['最近的战斗记录', ['log']],
};

export function registerMacros(app) {
    const c = ctx();
    if (typeof c.registerMacro !== 'function') {
        console.warn('[Tavern-SRPG] 当前 SillyTavern 版本不支持 registerMacro，跳过宏注册');
        return [];
    }
    for (const [name, [, sections]] of Object.entries(MACROS)) {
        c.registerMacro(name, () => {
            if (sections?.[0] === 'log' && !app.settings.inject.logLines) {
                const b = getBattle();
                return b?.active && !b.paused ? (b.log || []).slice(-10).map(l => `- ${l}`).join('\n') : '';
            }
            return app.battleContext(sections || undefined);
        });
    }
    c.registerMacro('srpg_turn', () => String(getBattle()?.active && !getBattle()?.paused ? getBattle().turn : ''));
    return [...Object.keys(MACROS), 'srpg_turn'];
}

const TOOL_NAME = 'SRPG_GetBattleState';

/** 在 SillyTavern 的函数调用中注册一个只读工具，LLM 可以主动查询战场 */
export function registerTool(app) {
    const c = ctx();
    if (typeof c.registerFunctionTool !== 'function') return false;
    c.registerFunctionTool({
        name: TOOL_NAME,
        displayName: 'SRPG 战场查询',
        description: '查询当前 SRPG 战斗的实时状态（由战斗系统计算，权威且只读）。在描写战斗、判断角色位置/HP/状态、或不确定某个角色是否在场时调用。',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                section: {
                    type: 'string',
                    enum: ['all', 'mission', 'map', 'units', 'unit', 'log'],
                    description: 'all＝全部；mission＝回合与任务；map＝地图网格与地形；units＝所有单位；unit＝某个单位（需填 name）；log＝最近战况',
                },
                name: { type: 'string', description: 'section 为 unit 时，要查询的单位名、别名或编号（如 P1、E2）' },
            },
            required: ['section'],
        },
        action: async ({ section = 'all', name = '' } = {}) => {
            const b = getBattle();
            if (!b?.active || b.paused) return '当前没有进行中的 SRPG 战斗。';
            if (section === 'unit') return unitInfo(app, b, name);
            if (section === 'log') return (b.log || []).slice(-15).map(l => `- ${l}`).join('\n') || '暂无战斗记录。';
            return app.battleContext(section === 'all' ? undefined : [section]);
        },
        formatMessage: ({ section, name } = {}) => `查询战场：${section === 'unit' ? name : section}`,
        shouldRegister: () => !!app.settings.tool?.enabled && !!getBattle()?.active && !getBattle()?.paused,
    });
    return true;
}

function unitInfo(app, b, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return '请提供单位名、别名或编号。';
    const full = app.battleContext(['units']).split('\n');
    // 单位块以「[P1] 名字」开头，后续缩进行属于同一单位
    const blocks = [];
    for (const line of full) {
        if (/^\[[A-Z]\d+\] /.test(line)) blocks.push([line]);
        else if (line.startsWith('  ') && blocks.length) blocks.at(-1).push(line);
    }
    const match = blocks.find(bl => bl[0].toLowerCase().startsWith(`[${q}]`))
        || blocks.find(bl => bl[0].toLowerCase().includes(q));
    if (match) return match.join('\n');
    const dead = b.units.find(u => u.hp <= 0 && (u.name.toLowerCase().includes(q) || unitAliases(u).some(a => substitute(a).toLowerCase().includes(q))));
    if (dead) return `${dead.name} 已经倒下。`;
    return `战场上没有名为「${query}」的单位。在场单位：${alive(b).filter(u => visibleTo(b, 'P', u)).map(u => u.name).join('、')}`;
}
