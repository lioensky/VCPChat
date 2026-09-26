'use strict';

const CURRENT_DIR = '.';
const STATE_URL = `${CURRENT_DIR}/game_state.json`;
const SETTINGS_URL = '../../../AppData/settings.json';
const THEME_URL = '../../../styles/themes.css';
const AVATAR_DIR = '../../../AppData/avatarimage';
const USER_AVATAR_URL = '../../../AppData/UserData/user_avatar.png';
const MAX_HP = 6;
const MAX_ENERGY = 6;

const MOVES = {
    Charge: { name: '蓄势', cost: 0, desc: '能量 +1' },
    Slash: { name: '斩击', cost: 0, desc: '1 伤害' },
    LightStep: { name: '轻霜踏雪', cost: 1, desc: '2 伤害' },
    PlumBlossom: { name: '寒梅逐鹿', cost: 2, desc: '4 伤害 · 回血' },
    Flash: { name: '回光无影', cost: 3, desc: '9 伤害' },
    Block: { name: '御剑格挡', cost: 0, desc: '减免 4 伤' },
    Taiji: { name: '太极两仪', cost: 0, desc: '化解回光' },
};

const RESULT_LABELS = Object.freeze({
    'ai-hit': '对手命中',
    'user-hit': '你命中',
    trade: '双剑相交',
    guard: '剑锋受阻',
    taiji: '太极化解',
    neutral: '招式试探',
});

const MOVE_ANIMATION_TYPES = Object.freeze({
    Charge: 'charge',
    Slash: 'slash',
    LightStep: 'step',
    PlumBlossom: 'plum',
    Flash: 'flash',
    Block: 'block',
    Taiji: 'taiji',
});

const $ = id => document.getElementById(id);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

let lastStateSignature = '';
let lastEventTurn = null;
let pixiController = null;
let currentState = null;

function setText(id, text) {
    const node = $(id);
    if (node) node.textContent = text;
}

function setMeter(id, value, max) {
    const node = $(id);
    if (node) node.style.width = `${clamp(Number(value) || 0, 0, max) / max * 100}%`;
}

function setAvatar(id, source, fallback) {
    const node = $(id);
    if (!node) return;
    node.onerror = () => {
        node.onerror = null;
        node.src = fallback;
    };
    node.src = source;
}

async function readJson(url, fallback = {}) {
    try {
        const response = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.warn(`[BladeGame] 读取失败 ${url}:`, error.message);
        return fallback;
    }
}

async function applyThemeMode() {
    const settings = await readJson(SETTINGS_URL);
    document.body.classList.toggle('light-theme', settings.currentThemeMode === 'light');
}

function normalizeName(value) {
    return String(value || '').trim().toLocaleLowerCase();
}

function avatarCandidates(maidName) {
    const encodedName = encodeURIComponent(String(maidName || '').trim());
    // 浏览器无法枚举本地目录，因此完整匹配优先，包含匹配由窗口桥接提供。
    return [
        `${AVATAR_DIR}/${encodedName}.png`,
        `${AVATAR_DIR}/${encodedName}.jpg`,
        `${AVATAR_DIR}/${encodedName}.jpeg`,
        `${AVATAR_DIR}/${encodedName}.webp`,
    ];
}

async function resolveAiAvatar(maidName) {
    const bridge = window.bladeGame;
    if (typeof bridge?.findAvatar === 'function') {
        const matched = await bridge.findAvatar(maidName);
        if (matched) return matched;
    }
    return avatarCandidates(maidName)[0];
}

function createMoveButtons() {
    const grid = $('moveGrid');
    if (!grid) return;
    grid.replaceChildren();

    Object.entries(MOVES).forEach(([key, move]) => {
        const button = document.createElement('button');
        button.className = 'move-button';
        button.dataset.move = key;
        button.innerHTML = `<span class="move-name">${move.name}</span><span class="move-desc">${move.desc}</span>`;
        button.addEventListener('click', () => submitMove(key));
        grid.appendChild(button);
    });
}

async function submitMove(moveKey) {
    if (!currentState || currentState.user_ready || currentState.game_over) return;
    const move = MOVES[moveKey];
    if (!move || Number(currentState.user_energy) < move.cost) return;

    if (typeof window.bladeGame?.submitMove !== 'function') {
        setText('moveHint', '当前窗口尚未连接输入桥');
        return;
    }

    try {
        const result = await window.bladeGame.submitMove(moveKey);
        if (!result?.success) {
            setText('moveHint', result?.error || '提交失败，请重试');
            return;
        }
        await pollState();
    } catch (error) {
        setText('moveHint', `提交失败：${error.message}`);
    }
}

function updateButtons(state) {
    document.querySelectorAll('.move-button').forEach(button => {
        const move = MOVES[button.dataset.move];
        button.disabled = Boolean(
            state.game_over ||
            state.user_ready ||
            !move ||
            Number(state.user_energy) < move.cost
        );
    });

    setText(
        'moveHint',
        state.game_over ? '对局结束' : state.user_ready ? '等待 AI 出招…' : '请选择招式'
    );
}

function updateFighterState(state) {
    setText('aiName', state.maid_name || 'AI');
    setText('userHpText', `${state.user_hp} / ${MAX_HP}`);
    setText('aiHpText', `${state.ai_hp} / ${MAX_HP}`);
    setText('userEnergyText', `${state.user_energy} / ${MAX_ENERGY}`);
    setText('aiEnergyText', `${state.ai_energy} / ${MAX_ENERGY}`);
    setMeter('userHpBar', state.user_hp, MAX_HP);
    setMeter('aiHpBar', state.ai_hp, MAX_HP);
    setMeter('userEnergyBar', state.user_energy, MAX_ENERGY);
    setMeter('aiEnergyBar', state.ai_energy, MAX_ENERGY);

    const maidName = state.maid_name || 'AI';
    resolveAiAvatar(maidName).then(source => setAvatar('aiAvatar', source, avatarCandidates('AI')[0]));
    setAvatar('userAvatar', USER_AVATAR_URL, '');
}

function showSpeech(text) {
    const bubble = $('aiSpeech');
    if (!bubble) return;
    if (!text) {
        bubble.hidden = true;
        bubble.textContent = '';
        return;
    }
    bubble.hidden = false;
    bubble.textContent = text;
    bubble.classList.remove('speech-bubble-ai');
    void bubble.offsetWidth;
    bubble.classList.add('speech-bubble-ai');
}

function showDamage(event) {
    const container = $('damageFloaters');
    if (!container) return;

    const values = [
        ['AI', Number(event.user_damage) || 0, 'user'],
        ['你', Number(event.ai_damage) || 0, 'ai'],
    ];
    values.forEach(([label, damage, side]) => {
        if (!damage) return;
        const floater = document.createElement('span');
        floater.className = `damage-floater damage-${side}`;
        floater.textContent = `${damage} 伤`;
        floater.title = `${label}受到伤害`;
        container.appendChild(floater);
        floater.addEventListener('animationend', () => floater.remove(), { once: true });
    });
}

function applyBattleClass(resultType) {
    document.body.classList.remove('blade-hit-ai', 'blade-hit-user');
    if (resultType === 'ai-hit' || resultType === 'trade') {
        document.body.classList.add('blade-hit-user');
    }
    if (resultType === 'user-hit' || resultType === 'trade') {
        document.body.classList.add('blade-hit-ai');
    }
    window.setTimeout(() => document.body.classList.remove('blade-hit-ai', 'blade-hit-user'), 460);
}

function resultLabel(resultType) {
    return RESULT_LABELS[resultType] || '招式交锋';
}

function moveEventLabel(moveEvent) {
    if (!moveEvent) return '';
    const move = MOVES[moveEvent.move];
    return move?.name || moveEvent.name || '未知招式';
}

function presentEvents(state) {
    if (!Array.isArray(state.events) || state.turn_result?.turn === lastEventTurn) return;
    lastEventTurn = state.turn_result?.turn ?? null;

    const speechEvent = state.events.find(event => event.type === 'speech');
    const clashEvent = state.events.find(event => event.type === 'clash');
    const damageEvent = state.events.find(event => event.type === 'damage');
    const moveEvents = state.events.filter(event => event.type === 'move');

    showSpeech(speechEvent?.text || state.ai_speech || '');

    const aiMoveEvent = moveEvents.find(event => event.side === 'ai');
    const userMoveEvent = moveEvents.find(event => event.side === 'user');
    const moveSummary = aiMoveEvent && userMoveEvent
        ? `${moveEventLabel(userMoveEvent)} · ${moveEventLabel(aiMoveEvent)}`
        : '招式交锋';
    setText(
        'battleCaption',
        clashEvent?.result
            ? `${resultLabel(clashEvent.result)}　${moveSummary}`
            : moveSummary
    );

    if (damageEvent) showDamage(damageEvent);
    applyBattleClass(clashEvent?.result);
    pixiController?.playClash(
        clashEvent?.result || 'neutral',
        aiMoveEvent?.move,
        userMoveEvent?.move
    );
}

function updateUi(state) {
    currentState = state;
    updateFighterState(state);
    updateButtons(state);
    setText('turnText', `回合 ${Math.max(1, Number(state.turn || 1))}`);
    setText('battleLog', state.last_log || '等待游戏状态…');
    setText('statusText', state.game_over ? '对局结束' : state.user_ready ? '等待 AI 结算' : '轮到你出招');

    if (state.turn_result) presentEvents(state);
}

class BladePixiController {
    constructor(root) {
        this.root = root;
        this.app = null;
        this.stage = null;
        this.background = null;
        this.effects = null;
        this.resizeObserver = null;
        this.pulses = [];
        this.moveEffects = [];
    }

    async init() {
        if (!window.PIXI || !this.root) return;
        this.app = new PIXI.Application();
        await this.app.init({
            backgroundAlpha: 0,
            preference: 'webgl',
            antialias: true,
            autoStart: false,
            resolution: Math.min(1.5, window.devicePixelRatio || 1),
            autoDensity: true,
        });

        this.root.replaceChildren(this.app.canvas);
        this.app.canvas.style.width = '100%';
        this.app.canvas.style.height = '100%';
        this.stage = this.app.stage;
        this.background = new PIXI.Graphics();
        this.effects = new PIXI.Graphics();
        this.stage.addChild(this.background, this.effects);
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.root);
        this.resize();
        this.app.ticker.add(ticker => this.render(ticker.deltaMS / 1000));
        this.app.start();
    }

    resize() {
        if (!this.app) return;
        this.app.renderer.resize(
            Math.max(1, this.root.clientWidth),
            Math.max(1, this.root.clientHeight)
        );
    }

    playClash(result, aiMove, userMove) {
        this.pulses.push({ age: 0, result, life: 0.85 });
        if (aiMove) {
            this.moveEffects.push({
                age: 0,
                side: 'ai',
                type: MOVE_ANIMATION_TYPES[aiMove] || 'slash',
                life: 1.05,
            });
        }
        if (userMove) {
            this.moveEffects.push({
                age: 0,
                side: 'user',
                type: MOVE_ANIMATION_TYPES[userMove] || 'slash',
                life: 1.05,
            });
        }
    }

    drawMoveEffect(effect, width, height) {
        const progress = effect.age / effect.life;
        const direction = effect.side === 'user' ? 1 : -1;
        const originX = effect.side === 'user' ? width * 0.25 : width * 0.75;
        const targetX = width * 0.5;
        const cy = height * 0.52;
        const travel = Math.min(1, progress * 1.6);
        const x = originX + (targetX - originX) * travel;
        const alpha = Math.max(0, 1 - progress);

        if (effect.type === 'charge') {
            this.effects.circle(originX, cy, 22 + progress * 35)
                .stroke({ color: 0x4c9cff, alpha: alpha * 0.75, width: 3 });
            this.effects.circle(originX, cy, 8 + progress * 16)
                .fill({ color: 0x76bfae, alpha: alpha * 0.45 });
            return;
        }

        if (effect.type === 'slash') {
            this.effects.moveTo(x - direction * 34, cy - 38);
            this.effects.lineTo(x + direction * 34, cy + 38);
            this.effects.stroke({ color: 0xf2a900, alpha, width: 5 });
            return;
        }

        if (effect.type === 'step') {
            this.effects.circle(x, cy, 10 + progress * 22)
                .stroke({ color: 0x76bfae, alpha, width: 3 });
            this.effects.moveTo(x - direction * 30, cy + 24);
            this.effects.lineTo(x + direction * 28, cy - 30);
            this.effects.stroke({ color: 0x9be7d2, alpha: alpha * 0.9, width: 3 });
            return;
        }

        if (effect.type === 'plum') {
            for (let index = 0; index < 5; index += 1) {
                const angle = (Math.PI * 2 * index) / 5 + progress * 2;
                this.effects.circle(
                    x + Math.cos(angle) * (12 + progress * 30),
                    cy + Math.sin(angle) * (12 + progress * 30),
                    7
                ).fill({ color: 0xe06c9f, alpha: alpha * 0.8 });
            }
            return;
        }

        if (effect.type === 'flash') {
            this.effects.moveTo(x - direction * 65, cy + 48);
            this.effects.lineTo(x + direction * 65, cy - 48);
            this.effects.stroke({ color: 0xffffff, alpha, width: 9 });
            this.effects.circle(x, cy, 18 + progress * 48)
                .fill({ color: 0xf2a900, alpha: alpha * 0.22 });
            return;
        }

        if (effect.type === 'block') {
            this.effects.rect(
                originX - 28,
                cy - 42,
                56,
                84
            ).stroke({ color: 0x76bfae, alpha, width: 4 });
            return;
        }

        if (effect.type === 'taiji') {
            this.effects.circle(originX, cy, 24 + progress * 22)
                .stroke({ color: 0xd6b3ff, alpha, width: 4 });
            this.effects.arc(originX, cy, 18 + progress * 12, 0, Math.PI)
                .stroke({ color: 0x76bfae, alpha, width: 3 });
            this.effects.arc(originX, cy, 18 + progress * 12, Math.PI, Math.PI * 2)
                .stroke({ color: 0xf2a900, alpha, width: 3 });
        }
    }

    render(dt = 1 / 60) {
        if (!this.app || !this.background || !this.effects) return;
        const width = this.root.clientWidth;
        const height = this.root.clientHeight;
        const cx = width / 2;
        const cy = height / 2;
        const now = performance.now() / 1000;

        this.background.clear();
        this.background.circle(cx, cy, Math.min(width, height) * (0.18 + Math.sin(now * 1.3) * 0.012))
            .fill({ color: 0xf2a900, alpha: 0.06 });
        this.background.circle(cx, cy, Math.min(width, height) * 0.34)
            .stroke({ color: 0x76bfae, alpha: 0.16, width: 1.5 });

        this.effects.clear();
        this.moveEffects = this.moveEffects.filter(effect => {
            effect.age += Math.min(dt, 0.05);
            if (effect.age >= effect.life) return false;
            this.drawMoveEffect(effect, width, height);
            return true;
        });
        this.pulses = this.pulses.filter(pulse => {
            pulse.age += Math.min(dt, 0.05);
            const progress = pulse.age / pulse.life;
            if (progress >= 1) return false;
            const radius = 20 + progress * Math.min(width, height) * 0.48;
            const alpha = (1 - progress) * 0.7;
            const color = pulse.result === 'ai-hit' ? 0xf2a900 : 0x76bfae;
            this.effects.circle(cx, cy, radius).stroke({ color, alpha, width: 3 - progress * 2 });
            this.effects.circle(cx, cy, Math.max(4, radius * 0.16)).fill({ color, alpha: alpha * 0.4 });
            return true;
        });
        // Application 的 ticker 在本次更新后统一渲染，避免重复绘制。
    }

    destroy() {
        this.resizeObserver?.disconnect();
        this.app?.destroy(true, { children: true, texture: true, textureSource: true });
    }
}

async function pollState() {
    const state = await readJson(STATE_URL, null);
    if (!state) return;
    const signature = JSON.stringify({
        turn: state.turn,
        user_ready: state.user_ready,
        last_log: state.last_log,
        ai_hp: state.ai_hp,
        user_hp: state.user_hp,
    });
    if (signature !== lastStateSignature) {
        lastStateSignature = signature;
        updateUi(state);
    }
}

function bindWindowControls() {
    const bridge = window.bladeGame;
    const controls = [
        ['blade-minimize-btn', 'minimize'],
        ['blade-maximize-btn', 'toggleMaximize'],
        ['blade-close-btn', 'close'],
    ];

    if (!bridge) {
        setText('statusText', '窗口控制桥接未连接');
        console.error('[BladeGame] window.bladeGame preload bridge is unavailable');
        return;
    }

    controls.forEach(([id, method]) => {
        const button = $(id);
        if (!button || typeof bridge[method] !== 'function') {
            console.error(`[BladeGame] missing window control: ${id} -> ${method}`);
            return;
        }

        button.style.pointerEvents = 'auto';
        button.addEventListener('pointerdown', event => {
            event.stopPropagation();
        });
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            bridge[method]();
        });
    });

    bridge.onMaximizedChanged?.(maximized => {
        const button = $('blade-maximize-btn');
        if (!button) return;
        button.textContent = maximized ? '❐' : '□';
        button.title = maximized ? '还原' : '最大化';
        button.setAttribute('aria-label', button.title);
    });
}

async function bootstrap() {
    bindWindowControls();
    await applyThemeMode();
    createMoveButtons();
    pixiController = new BladePixiController($('pixiArena'));
    try {
        await pixiController.init();
    } catch (error) {
        console.warn('[BladeGame] 特效初始化失败，保留基础界面：', error);
        pixiController = null;
    }
    await pollState();
    const timer = window.setInterval(pollState, 250);
    const themeTimer = window.setInterval(applyThemeMode, 2000);
    window.addEventListener('beforeunload', () => {
        clearInterval(timer);
        clearInterval(themeTimer);
    }, { once: true });
}

window.addEventListener('beforeunload', () => pixiController?.destroy());
window.addEventListener('DOMContentLoaded', bootstrap);