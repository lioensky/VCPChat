// 战斗回溯：每个我方阶段开始时保存一份战场存档（随聊天保存），可以回到之前的回合补录剧情再继续

export const MAX_CHECKPOINTS = 20;
const LOG_KEEP = 30; // 存档只保留最近的战斗记录，控制聊天元数据体积

/** 去掉存档本身、LLM 撤回快照等，只留可以继续战斗的战场 */
function snapshot(b, keepPending) {
    const { history, llm, paused, ...rest } = b;
    const state = structuredClone(rest);
    state.log = (state.log || []).slice(-LOG_KEEP);
    if (!keepPending) state.pending = [];
    return state;
}

function aliveCount(b, side) {
    return (b.units || []).filter(u => u.hp > 0 && u.side === side && !u.object).length;
}

function push(b, cp) {
    b.history ||= [];
    b.history.push(cp);
    // 保留开战时的存档，超出上限时丢弃最早的回合存档
    while (b.history.length > MAX_CHECKPOINTS) b.history.splice(b.history[0].kind === 'start' ? 1 : 0, 1);
    return cp;
}

function makeCheckpoint(b, kind, chat, keepPending) {
    b.cpSeq = (b.cpSeq || 0) + 1;
    return {
        id: `cp${b.cpSeq}`,
        kind, // start：开战 ; turn：回合开始 ; rewind：回溯前的进度
        turn: b.turn,
        phase: b.phase,
        chat: Number(chat) || 0, // 当时聊天的楼层数
        at: Date.now(),
        player: aliveCount(b, 'player'),
        enemy: aliveCount(b, 'enemy'),
        result: b.result || null,
        state: snapshot(b, keepPending),
    };
}

/** 我方阶段开始时记录存档；战斗已结束则不记录 */
export function recordCheckpoint(b, { chat = 0, kind = 'turn' } = {}) {
    if (!b?.active || b.result || b.phase !== 'player') return null;
    return push(b, makeCheckpoint(b, kind, chat, false));
}

/**
 * 回到某个存档，返回新的战斗对象（原对象不变）。
 * 当前进度会先保存为「回溯前的进度」（保留待发送行动），之后仍能回来。
 */
export function rewindBattle(b, id, { chat = 0 } = {}) {
    const cp = b?.history?.find(c => c.id === id);
    if (!cp) return null;
    const from = structuredClone(b);
    delete from.llm;
    push(from, makeCheckpoint(from, 'rewind', chat, true));
    const next = structuredClone(cp.state);
    next.history = from.history;
    next.cpSeq = from.cpSeq;
    next.rev = b.rev;
    const event = { type: 'rewind', turn: next.turn, toTurn: next.turn, fromTurn: b.turn, restore: cp.kind === 'rewind' };
    next.pending = [...(next.pending || []), event];
    return next;
}

/** 存档在列表中的标题 */
export function checkpointTitle(cp) {
    if (cp.kind === 'rewind') return `回溯前的进度 · 第 ${cp.turn} 回合${cp.result ? (cp.result === 'victory' ? '（已胜利）' : '（已战败）') : ''}`;
    if (cp.kind === 'start') return '开战 · 第 1 回合';
    return `第 ${cp.turn} 回合开始`;
}
