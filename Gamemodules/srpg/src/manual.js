// 用户手动调整战场：只改当前战斗，不改资料卡；所有参数先校验再写入。
import { getUnit, unitAt, inBounds, enterCost, makeBattleUnit, commit, SIDE_NAMES, toughMax, toughLeft, initFog, stat } from './engine.js';

const NUMERIC = new Set(['hp', 'maxHp', 'atk', 'matk', 'def', 'mdef', 'agi', 'mov', 'rangeMin', 'rangeMax', 'tough', 'toughMax', 'vision']);
function position(b, x, y, unit) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || !inBounds(b, x, y)) throw new Error('坐标超出地图范围');
    const occupant = unitAt(b, x, y);
    if (occupant && occupant !== unit) throw new Error('此格已有单位');
}

export function applyManualChange(b, change, data) {
    let text = '';
    const u = change.uid ? getUnit(b, change.uid) : null;
    if (['stat', 'move', 'remove', 'restore'].includes(change.type) && !u) throw new Error('请先选择单位');
    switch (change.type) {
        case 'spawn': {
            const def = data.units.find(d => d.id === change.defId);
            if (!def) throw new Error('请选择要放置的单位类型');
            const x = change.x, y = change.y;
            position(b, x, y);
            if (!Number.isFinite(enterCost(b, def, x, y))) throw new Error('该单位无法进入此地形');
            b.nextUid = Number(b.nextUid) || 1;
            const unit = makeBattleUnit(def, `manual_${b.nextUid++}`, def.name, x, y);
            b.units.push(unit);
            text = `放置${unit.name}于 (${x + 1},${y + 1})。`;
            break;
        }
        case 'remove':
            u.retreated = true; u.hp = 0; u.acted = true;
            text = `${u.name}被撤除。`;
            break;
        case 'move':
            position(b, change.x, change.y, u);
            if (!Number.isFinite(enterCost(b, u, change.x, change.y))) throw new Error('该单位无法进入此地形');
            u.x = change.x; u.y = change.y; u.phaseX = u.x; u.phaseY = u.y;
            text = `${u.name}被移动到 (${u.x + 1},${u.y + 1})（手动移动不触发地形伤害）。`;
            break;
        case 'stat': {
            const key = change.key;
            let value = change.value;
            if (NUMERIC.has(key)) {
                if (!Number.isFinite(value) || value < 0 || (key === 'maxHp' && value < 1)) throw new Error('数值必须为非负数，最大HP至少为1');
                value = Math.floor(value);
                if (key === 'tough' && value > toughMax(u)) throw new Error('韧性不能超过韧性上限');
                if (key === 'hp') {
                    if (value > u.maxHp) throw new Error('HP不能超过最大HP');
                    if (value > 0) position(b, u.x, u.y, u);
                }
            } else if (key === 'side') {
                if (!Object.hasOwn(SIDE_NAMES, value)) throw new Error('无效阵营');
            } else if (key === 'attackOrder') {
                if (!['normal', 'last'].includes(value)) throw new Error('无效攻击顺序');
            } else if (['flying', 'antiAir', 'acted', 'keyTarget'].includes(key)) {
                if (typeof value !== 'boolean') throw new Error('无效开关值');
            } else if (key === 'typeId') {
                if (value && !b.unitTypes?.[value]) throw new Error('无效兵种');
            } else throw new Error('不支持修改此属性');
            const before = key === 'tough' ? toughLeft(u) : key === 'toughMax' ? toughMax(u) : key === 'vision' ? stat({ ...u, statuses: [], traits: [] }, 'vision')
                : key === 'typeId' ? b.unitTypes?.[u.typeId]?.name || '无兵种' : u[key];
            if (key === 'toughMax') u.tough = Math.min(toughLeft(u), value);
            u[key] = value;
            if (key === 'maxHp') u.hp = Math.min(u.hp, value);
            if (key === 'hp' && value > 0) u.retreated = false;
            if (key === 'rangeMin') u.rangeMax = Math.max(u.rangeMax, value);
            if (key === 'rangeMax') u.rangeMin = Math.min(u.rangeMin, value);
            text = key === 'typeId' ? `${u.name}的兵种：${before} → ${b.unitTypes?.[value]?.name || '无兵种'}。` : `${u.name}的${key}：${before} → ${value}。`;
            break;
        }
        case 'restore':
            position(b, u.x, u.y, u);
            u.hp = u.maxHp; u.retreated = false; u.acted = false; u.moved = false; u.statuses = []; u.tough = toughMax(u);
            for (const sk of u.skills) { sk.cdLeft = 0; sk.usesLeft = Number(sk.uses) || 0; }
            text = `${u.name}已满血恢复、回满韧性、解除状态、重置行动和技能。`;
            break;
        case 'terrain': {
            if (!inBounds(b, change.x, change.y) || !Number.isInteger(change.x) || !Number.isInteger(change.y)) throw new Error('坐标超出地图范围');
            const terrain = data.terrains.find(t => t.id === change.terrainId);
            if (!terrain) throw new Error('请选择地形');
            b.terrains[terrain.id] = structuredClone(terrain);
            b.tiles[change.y * b.w + change.x] = terrain.id;
            text = `(${change.x + 1},${change.y + 1})改为${terrain.name}。`;
            break;
        }
        case 'fog': {
            const was = !!b.fog?.enabled;
            b.fog = { enabled: !!change.enabled, ai: change.ai !== false };
            if (b.fog.enabled && !was) initFog(b);
            text = b.fog.enabled ? `战争迷雾${was ? '设置调整' : '开启'}：${b.fog.ai ? '敌我双方都只能看到视野内的单位' : '我方只能看到视野内的敌人，敌方掌握全部情报'}。` : '战争迷雾关闭，战场一览无余。';
            break;
        }
        case 'defeatEnemies':
            for (const enemy of b.units.filter(unit => unit.side === 'enemy')) { enemy.hp = 0; enemy.acted = true; }
            text = '场上全部敌人被击败（后续增援仍按地图规则出现）。';
            break;
        default: throw new Error('未知手动操作');
    }
    // 修改后重新判定，也允许通过复活 / 添加单位修复已结束的战场。
    b.result = null; b.resultReason = '';
    b.pending = b.pending.filter(e => e.type !== 'result');
    return commit(b, { type: 'manual', turn: b.turn, text });
}
