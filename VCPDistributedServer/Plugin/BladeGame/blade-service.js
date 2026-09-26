'use strict';

const { BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const PLUGIN_DIR = __dirname;
const STATE_FILE = path.join(PLUGIN_DIR, 'game_state.json');
const PRELOAD_FILE = path.join(PLUGIN_DIR, 'blade-preload.js');
const HTML_FILE = path.join(PLUGIN_DIR, 'blade-electron.html');
const AVATAR_DIR = path.resolve(PLUGIN_DIR, '..', '..', '..', 'AppData', 'avatarimage');
const MAX_HP = 6;
const MAX_ENERGY = 6;
const MAX_TURNS = 20;
const COUNTDOWN_START_TURN = 16;

const MOVES = Object.freeze({
    Charge: { name: '蓄势', cost: 0, type: 'buff', level: 0, desc: '剑气 +1' },
    Slash: { name: '斩击', cost: 0, type: 'attack', level: 1, damage: 1, desc: '1 伤害' },
    LightStep: { name: '轻霜踏雪', cost: 1, type: 'attack', level: 2, damage: 2, desc: '2 伤害' },
    PlumBlossom: { name: '寒梅逐鹿', cost: 2, type: 'attack', level: 3, damage: 4, heal: 1, desc: '4 伤害 · 回血' },
    Flash: { name: '回光无影', cost: 3, type: 'attack', level: 4, damage: 9, desc: '9 伤害' },
    Block: { name: '御剑格挡', cost: 0, type: 'defense', level: 0, desc: '减免 4 伤' },
    Taiji: { name: '太极两仪', cost: 0, type: 'defense', level: 0, desc: '化解回光' },
});

let bladeWindow = null;
let initialized = false;

const contentText = text => ({
    content: [{ type: 'text', text: String(text || '') }],
});

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return null;
    }
}

function writeState(state) {
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function defaultSpeech(moveKey) {
    return {
        Charge: '先蓄一口气。',
        Slash: '接招。',
        LightStep: '轻霜踏雪。',
        PlumBlossom: '寒梅，开。',
        Flash: '这一剑，定胜负。',
        Block: '休想突破我的防线。',
        Taiji: '四两，拨千斤。',
    }[moveKey] || '小心了。';
}

function createInitialState(maidName) {
    return {
        maid_name: maidName || 'AI',
        turn: 1,
        max_turns: MAX_TURNS,
        ai_hp: 5,
        ai_energy: 0,
        user_hp: 5,
        user_energy: 0,
        game_over: false,
        user_ready: false,
        user_input: null,
        last_ai_move: null,
        last_user_move: null,
        ai_speech: '',
        turn_result: null,
        events: [],
        last_log: '游戏开始！请出招。',
    };
}

function gameResultText(state, completedTurn, aiMove, userMove, resultText, ending) {
    const countdown = !state.game_over && completedTurn >= COUNTDOWN_START_TURN
        ? `倒计时：还剩 ${MAX_TURNS - completedTurn} 回合，届时将根据双方剩余血量结算。`
        : '';

    return [
        `第${completedTurn}回合：AI出${aiMove.name}，大侠出${userMove.name}。`,
        `本回合结果：${resultText}`,
        `当前血量：AI ${state.ai_hp}/${MAX_HP}，大侠 ${state.user_hp}/${MAX_HP}；`,
        `剑气：AI ${state.ai_energy}/${MAX_ENERGY}，大侠 ${state.user_energy}/${MAX_ENERGY}。`,
        ending,
        countdown,
    ].filter(Boolean).join(' ');
}

function resolveTurn(state, aiAction, reason = '') {
    const aiMove = MOVES[aiAction];
    const userMove = MOVES[state.user_input];

    if (!aiMove) throw new Error('AI 招式无效。');
    if (!userMove) throw new Error('用户招式无效。');

    state.ai_energy -= aiMove.cost;
    state.user_energy -= userMove.cost;

    if (aiAction === 'Charge') state.ai_energy = Math.min(MAX_ENERGY, state.ai_energy + 1);
    if (state.user_input === 'Charge') state.user_energy = Math.min(MAX_ENERGY, state.user_energy + 1);

    let aiDamage = 0;
    let userDamage = 0;
    let aiHeal = 0;
    let userHeal = 0;
    let aiAttackSuccess = false;
    let userAttackSuccess = false;
    let log = `第 ${state.turn} 回合：AI[${aiMove.name}] vs 用户[${userMove.name}]。`;

    if (aiMove.type === 'attack') {
        if (userMove.type === 'attack') {
            if (aiMove.level > userMove.level) {
                aiAttackSuccess = true;
                log += ' AI招式更胜一筹，打断了用户。';
            } else if (userMove.level > aiMove.level) {
                userAttackSuccess = true;
                log += ' 用户招式凌厉，打断了AI。';
            } else {
                log += ' 双方剑锋相交，攻击抵消。';
                if (aiAction === 'PlumBlossom') aiHeal = aiMove.heal;
                if (state.user_input === 'PlumBlossom') userHeal = userMove.heal;
            }
        } else {
            aiAttackSuccess = true;
        }
    }

    if (userMove.type === 'attack' && aiMove.type !== 'attack') userAttackSuccess = true;
    if (aiAttackSuccess) {
        aiDamage = aiMove.damage;
        aiHeal = aiMove.heal || 0;
    }
    if (userAttackSuccess) {
        userDamage = userMove.damage;
        userHeal = userMove.heal || 0;
    }

    if (state.user_input === 'Block') aiDamage = Math.max(0, aiDamage - 4);
    if (state.user_input === 'Taiji' && aiAction === 'Flash') aiDamage = 0;
    if (aiAction === 'Block') userDamage = Math.max(0, userDamage - 4);
    if (aiAction === 'Taiji' && state.user_input === 'Flash') userDamage = 0;

    state.ai_hp = Math.max(0, Math.min(MAX_HP, state.ai_hp + aiHeal - userDamage));
    state.user_hp = Math.max(0, Math.min(MAX_HP, state.user_hp + userHeal - aiDamage));

    const resultType = aiAttackSuccess && userAttackSuccess
        ? 'trade'
        : aiAttackSuccess ? 'ai-hit'
            : userAttackSuccess ? 'user-hit'
                : aiAction === 'Block' || state.user_input === 'Block' ? 'guard'
                    : aiAction === 'Taiji' || state.user_input === 'Taiji' ? 'taiji'
                        : 'neutral';

    const events = [
        { type: 'speech', side: 'ai', text: String(reason || defaultSpeech(aiAction)).trim() },
        { type: 'move', side: 'ai', move: aiAction, name: aiMove.name, level: aiMove.level },
        { type: 'move', side: 'user', move: state.user_input, name: userMove.name, level: userMove.level },
        { type: 'clash', result: resultType, ai_attack_success: aiAttackSuccess, user_attack_success: userAttackSuccess },
    ];

    if (aiDamage || userDamage) {
        events.push({ type: 'damage', ai_damage: aiDamage, user_damage: userDamage });
    }
    if (aiHeal || userHeal) {
        events.push({ type: 'heal', ai_heal: aiHeal, user_heal: userHeal });
    }

    const completedTurn = state.turn;
    state.turn += 1;
    state.user_ready = false;
    state.last_ai_move = aiAction;
    state.last_user_move = state.user_input;
    state.ai_speech = String(reason || defaultSpeech(aiAction)).trim();
    state.turn_result = {
        turn: completedTurn,
        ai_move: aiAction,
        user_move: state.user_input,
        result_type: resultType,
        ai_damage: aiDamage,
        user_damage: userDamage,
        ai_heal: aiHeal,
        user_heal: userHeal,
        ai_hp: state.ai_hp,
        user_hp: state.user_hp,
        events,
    };
    state.events = events;

    let ending = '';
    if (state.ai_hp <= 0 && state.user_hp <= 0) {
        state.game_over = true;
        ending = '双方力竭倒地，平局！';
    } else if (state.ai_hp <= 0) {
        state.game_over = true;
        ending = 'AI败北，恭喜大侠获胜！';
    } else if (state.user_hp <= 0) {
        state.game_over = true;
        ending = '胜负已分，AI获胜！';
    } else if (completedTurn >= MAX_TURNS) {
        state.game_over = true;
        ending = state.ai_hp === state.user_hp
            ? `达到${MAX_TURNS}回合上限，双方剩余血量相同，判定为平局！`
            : state.ai_hp > state.user_hp
                ? `达到${MAX_TURNS}回合上限，按剩余血量判定：AI获胜！`
                : `达到${MAX_TURNS}回合上限，按剩余血量判定：大侠获胜！`;
    }

    if (state.game_over) {
        events.push({ type: 'game-over', result: ending, text: ending });
    }

    const resultText = `AI造成${aiDamage}伤害${aiHeal ? `并回复${aiHeal}点生命` : ''}，大侠造成${userDamage}伤害${userHeal ? `并回复${userHeal}点生命` : ''}。`;
    state.last_log = `${log} ${resultText}${ending ? ` ${ending}` : ''}`;
    writeState(state);

    return gameResultText(state, completedTurn, aiMove, userMove, resultText, ending);
}

function submitMove(moveKey) {
    const state = readState();
    const move = MOVES[moveKey];

    if (!move) return { success: false, error: '无效招式。' };
    if (!state) return { success: false, error: '游戏尚未开始。' };
    if (state.game_over) return { success: false, error: '游戏已经结束。' };
    if (state.user_ready) return { success: false, error: '本回合已经提交招式。' };
    if (state.user_energy < move.cost) return { success: false, error: '剑气不足。' };

    state.user_input = moveKey;
    state.user_ready = true;
    writeState(state);
    return { success: true };
}

function isBladeSender(event) {
    return Boolean(event?.sender && bladeWindow && !bladeWindow.isDestroyed() && event.sender === bladeWindow.webContents);
}

function findAvatar(maidName) {
    const normalized = String(maidName || '').trim().toLocaleLowerCase();
    if (!normalized || !fs.existsSync(AVATAR_DIR)) return null;

    const matched = fs.readdirSync(AVATAR_DIR)
        .filter(name => /\.(png|jpe?g|webp|gif|bmp)$/i.test(name))
        .map(name => ({
            name,
            stem: path.parse(name).name.toLocaleLowerCase(),
        }))
        .filter(item => item.stem.includes(normalized))
        .sort((a, b) => Number(b.stem === normalized) - Number(a.stem === normalized) || a.name.length - b.name.length)[0];

    return matched ? `../../../AppData/avatarimage/${encodeURIComponent(matched.name)}` : null;
}

function createOrFocusWindow() {
    if (bladeWindow && !bladeWindow.isDestroyed()) {
        if (bladeWindow.isMinimized()) bladeWindow.restore();
        bladeWindow.show();
        bladeWindow.focus();
        return bladeWindow;
    }

    bladeWindow = new BrowserWindow({
        width: 1180,
        height: 820,
        minWidth: 900,
        minHeight: 620,
        title: '华山论剑',
        frame: false,
        ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
        autoHideMenuBar: true,
        backgroundColor: '#171A1D',
        show: false,
        webPreferences: {
            preload: PRELOAD_FILE,
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false,
        },
    });

    bladeWindow.loadFile(HTML_FILE);
    bladeWindow.once('ready-to-show', () => {
        if (!bladeWindow || bladeWindow.isDestroyed()) return;
        bladeWindow.show();
        bladeWindow.focus();
        bladeWindow.webContents.send(
            'blade-game:window:maximized-changed',
            bladeWindow.isMaximized()
        );
    });
    bladeWindow.on('maximize', () => {
        if (!bladeWindow.isDestroyed()) {
            bladeWindow.webContents.send('blade-game:window:maximized-changed', true);
        }
    });
    bladeWindow.on('unmaximize', () => {
        if (!bladeWindow.isDestroyed()) {
            bladeWindow.webContents.send('blade-game:window:maximized-changed', false);
        }
    });
    bladeWindow.on('closed', () => {
        bladeWindow = null;
    });
    return bladeWindow;
}

function registerIpc() {
    ipcMain.handle('blade-game:submit-move', (event, moveKey) => isBladeSender(event) ? submitMove(moveKey) : { success: false, error: '非法窗口请求。' });
    ipcMain.handle('blade-game:find-avatar', (event, maidName) => isBladeSender(event) ? findAvatar(maidName) : null);
    ipcMain.on('blade-game:window:minimize', event => { if (isBladeSender(event)) bladeWindow.minimize(); });
    ipcMain.on('blade-game:window:toggle-maximize', event => {
        if (!isBladeSender(event)) return;
        if (bladeWindow.isMaximized()) bladeWindow.unmaximize();
        else bladeWindow.maximize();
    });
    ipcMain.on('blade-game:window:close', event => { if (isBladeSender(event)) bladeWindow.close(); });
}

async function processToolCall(args = {}) {
    const command = String(args.command || '').trim();
    if (command === 'StartGame') {
        const maid = String(args.maid || 'AI');
        writeState(createInitialState(maid));
        createOrFocusWindow();
        return contentText(`华山论剑已开始，对手是${maid}。当前为第1回合，双方初始生命均为5点、剑气均为0点。请大侠先在游戏窗口选择招式，之后再调用 PlayTurn。`);
    }

    const state = readState();
    if (command === 'PlayTurn') {
        if (!state) return contentText('游戏尚未创建，请先调用 StartGame。');
        if (state.game_over) return contentText(`游戏已结束。${state.last_log}`);
        if (!state.user_ready) return contentText('用户尚未在游戏窗口出招，请等待大侠选择招式后再调用 PlayTurn。');

        const requested = MOVES[args.action] ? args.action : 'Charge';
        const action = state.ai_energy >= MOVES[requested].cost ? requested : 'Charge';
        const reason = args.reason || (action === requested ? '' : '原定招式气力不足，先蓄势。');
        return contentText(resolveTurn(state, action, reason));
    }

    return contentText(`未知指令：${command || '未提供 command'}`);
}

function initialize() {
    if (initialized) return;
    initialized = true;
    registerIpc();
}

function cleanup() {
    if (bladeWindow && !bladeWindow.isDestroyed()) bladeWindow.close();
    bladeWindow = null;
}

module.exports = { initialize, processToolCall, cleanup, createOrFocusWindow };