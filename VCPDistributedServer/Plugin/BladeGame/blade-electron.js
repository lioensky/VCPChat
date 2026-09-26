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
    if (damageEvent) showDamage(damageEvent);
    applyBattleClass(clashEvent?.result);
    pixiController?.playClash(
        clashEvent?.result || 'neutral',
        aiMoveEvent?.move,
        userMoveEvent?.move,
        {
            damageEvent,
            healEvent: state.events.find(event => event.type === 'heal'),
            gameOver: state.game_over,
        }
    );
}

function updateUi(state) {
    currentState = state;
    updateFighterState(state);
    updateButtons(state);
    setText('turnText', `回合 ${Math.max(1, Number(state.turn || 1))}`);
    setText('battleLog', state.last_log || '等待游戏状态…');
    setText('statusText', state.game_over ? '对局结束' : state.user_ready ? '等待 AI 结算' : '轮到你出招');

    pixiController?.updateEnergy(
        Number(state.user_energy) || 0,
        Number(state.ai_energy) || 0
    );

    if (state.turn_result) presentEvents(state);
}

class BladePixiController {
    constructor(root) {
        this.root = root;
        this.app = null;
        this.stage = null;
        this.backgroundLayer = null;
        this.ambientLayer = null;
        this.pedestalLayer = null;
        this.movesLayer = null;
        this.impactsLayer = null;
        this.overlayLayer = null;

        this.resizeObserver = null;
        this.moveEffects = [];
        this.sparks = [];
        this.shockwaves = [];
        this.ambientParticles = [];
        this.shakeTimer = 0;
        this.shakeMagnitude = 0;

        this.userEnergy = 0;
        this.aiEnergy = 0;
        this.now = 0;
    }

    async init() {
        if (!window.PIXI || !this.root) return;
        this.app = new PIXI.Application();
        await this.app.init({
            backgroundAlpha: 0,
            preference: 'webgl',
            antialias: true,
            autoStart: false,
            resolution: Math.min(2, window.devicePixelRatio || 1),
            autoDensity: true,
        });

        this.root.replaceChildren(this.app.canvas);
        this.app.canvas.style.width = '100%';
        this.app.canvas.style.height = '100%';
        this.stage = this.app.stage;

        this.backgroundLayer = new PIXI.Graphics();
        this.pedestalLayer = new PIXI.Graphics();
        this.ambientLayer = new PIXI.Graphics();
        this.movesLayer = new PIXI.Graphics();
        this.impactsLayer = new PIXI.Graphics();
        this.overlayLayer = new PIXI.Graphics();

        this.stage.addChild(
            this.backgroundLayer,
            this.pedestalLayer,
            this.ambientLayer,
            this.movesLayer,
            this.impactsLayer,
            this.overlayLayer
        );

        this.initAmbientParticles(36);

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.root);
        this.resize();
        this.app.ticker.add(ticker => this.render(ticker.deltaMS / 1000));
        this.app.start();
    }

    initAmbientParticles(count) {
        this.ambientParticles = [];
        for (let i = 0; i < count; i += 1) {
            this.ambientParticles.push(this.spawnAmbientParticle(true));
        }
    }

    spawnAmbientParticle(initial = false) {
        const width = Math.max(300, this.root.clientWidth || 600);
        const height = Math.max(200, this.root.clientHeight || 400);
        const typeRoll = Math.random();
        return {
            x: initial ? Math.random() * width : -20 + Math.random() * 40,
            y: initial ? Math.random() * height : Math.random() * height,
            vx: 18 + Math.random() * 32,
            vy: (Math.random() - 0.5) * 16,
            rotation: Math.random() * Math.PI * 2,
            vRot: (Math.random() - 0.5) * 2.5,
            size: 2.5 + Math.random() * 4.5,
            type: typeRoll < 0.45 ? 'petal' : typeRoll < 0.75 ? 'frost' : 'spark',
            alpha: 0.25 + Math.random() * 0.5,
            life: 6 + Math.random() * 8,
            age: initial ? Math.random() * 6 : 0,
        };
    }

    updateEnergy(userEnergy, aiEnergy) {
        this.userEnergy = clamp(userEnergy, 0, MAX_ENERGY);
        this.aiEnergy = clamp(aiEnergy, 0, MAX_ENERGY);
    }

    triggerShake(magnitude = 6, duration = 0.32) {
        this.shakeMagnitude = magnitude;
        this.shakeTimer = duration;
    }

    resize() {
        if (!this.app) return;
        this.app.renderer.resize(
            Math.max(1, this.root.clientWidth),
            Math.max(1, this.root.clientHeight)
        );
    }

    playClash(result, aiMove, userMove, extra = {}) {
        const isFlash = aiMove === 'Flash' || userMove === 'Flash';
        const isTrade = result === 'trade';
        const isHit = result === 'ai-hit' || result === 'user-hit';

        // 震屏与冲击力度
        const shakePower = isFlash ? 14 : isTrade ? 10 : isHit ? 7 : 4;
        this.triggerShake(shakePower, isFlash ? 0.45 : 0.28);

        // 产生中心冲击波
        this.shockwaves.push({
            age: 0,
            life: isFlash ? 0.95 : 0.65,
            color: isFlash ? 0xfff4d0 : result === 'ai-hit' ? 0xf2a900 : result === 'user-hit' ? 0x76bfae : 0xffffff,
            maxRadius: isFlash ? 260 : 160,
            xRatio: 0.5,
            yRatio: 0.52,
        });

        // 产生交锋爆发火星粒子
        const sparkCount = isFlash ? 42 : isTrade ? 36 : isHit ? 26 : 16;
        for (let i = 0; i < sparkCount; i += 1) {
            const angle = Math.random() * Math.PI * 2;
            const speed = (isFlash ? 160 : 90) + Math.random() * (isFlash ? 240 : 160);
            this.sparks.push({
                xRatio: 0.5 + (Math.random() - 0.5) * 0.04,
                yRatio: 0.52 + (Math.random() - 0.5) * 0.04,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                color: isFlash ? (Math.random() > 0.4 ? 0xffffff : 0xffbb33) : (Math.random() > 0.5 ? 0xf2a900 : 0x76bfae),
                size: 2 + Math.random() * 3.5,
                age: 0,
                life: 0.4 + Math.random() * 0.45,
            });
        }

        // 招式专属特效
        if (aiMove) {
            this.moveEffects.push({
                age: 0,
                side: 'ai',
                move: aiMove,
                type: MOVE_ANIMATION_TYPES[aiMove] || 'slash',
                life: aiMove === 'Flash' ? 1.35 : aiMove === 'PlumBlossom' ? 1.2 : 0.95,
                heal: extra.healEvent?.ai_heal || 0,
            });
        }
        if (userMove) {
            this.moveEffects.push({
                age: 0,
                side: 'user',
                move: userMove,
                type: MOVE_ANIMATION_TYPES[userMove] || 'slash',
                life: userMove === 'Flash' ? 1.35 : userMove === 'PlumBlossom' ? 1.2 : 0.95,
                heal: extra.healEvent?.user_heal || 0,
            });
        }
    }

    drawSwordIcon(gfx, x, y, angle, length, color, alpha) {
        gfx.save();
        gfx.moveTo(x, y);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const tipX = x + cos * length;
        const tipY = y + sin * length;
        const hiltX = x - cos * (length * 0.3);
        const hiltY = y - sin * (length * 0.3);
        const guardSpan = length * 0.28;
        const perpX = -sin * guardSpan;
        const perpY = cos * guardSpan;

        // 剑身光芒
        gfx.moveTo(tipX, tipY)
            .lineTo(hiltX, hiltY)
            .stroke({ color, width: 2.2, alpha });
        // 剑锋反光核心
        gfx.moveTo(tipX, tipY)
            .lineTo(hiltX, hiltY)
            .stroke({ color: 0xffffff, width: 1, alpha: alpha * 0.8 });
        // 剑格
        gfx.moveTo(x + perpX, y + perpY)
            .lineTo(x - perpX, y - perpY)
            .stroke({ color, width: 2, alpha });
        gfx.restore();
    }

    drawBaguaArray(gfx, cx, cy, radius, now) {
        // 外层两仪八卦符文旋转光环
        gfx.circle(cx, cy, radius)
            .stroke({ color: 0x76bfae, alpha: 0.16, width: 1.5 });
        gfx.circle(cx, cy, radius * 0.82)
            .stroke({ color: 0xf2a900, alpha: 0.12, width: 1.2 });

        // 外层八卦方位刻度
        const marks = 8;
        for (let i = 0; i < marks; i += 1) {
            const a = (Math.PI * 2 * i) / marks + now * 0.08;
            const r1 = radius * 0.85;
            const r2 = radius * 0.98;
            gfx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
                .lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2)
                .stroke({ color: 0x76bfae, alpha: 0.35, width: 1.8 });

            // 卦象点缀
            const subA = a + 0.12;
            gfx.circle(cx + Math.cos(subA) * radius * 0.92, cy + Math.sin(subA) * radius * 0.92, 1.8)
                .fill({ color: 0xf2a900, alpha: 0.4 });
        }

        // 内层太极双鱼虚影
        const innerR = radius * 0.45;
        const rot = -now * 0.15;
        gfx.circle(cx, cy, innerR)
            .stroke({ color: 0x9be7d2, alpha: 0.22, width: 1 });

        // 阴阳双鱼核心流转
        const eyeOffset = innerR * 0.48;
        const y1x = cx + Math.cos(rot) * eyeOffset;
        const y1y = cy + Math.sin(rot) * eyeOffset;
        const y2x = cx - Math.cos(rot) * eyeOffset;
        const y2y = cy - Math.sin(rot) * eyeOffset;

        gfx.circle(y1x, y1y, innerR * 0.18).fill({ color: 0x76bfae, alpha: 0.25 });
        gfx.circle(y1x, y1y, innerR * 0.06).fill({ color: 0xffffff, alpha: 0.6 });

        gfx.circle(y2x, y2y, innerR * 0.18).fill({ color: 0xf2a900, alpha: 0.22 });
        gfx.circle(y2x, y2y, innerR * 0.06).fill({ color: 0xffffff, alpha: 0.6 });

        // 太极S形分割线弧光
        gfx.arc(cx + Math.cos(rot) * (innerR * 0.5), cy + Math.sin(rot) * (innerR * 0.5), innerR * 0.5, rot + Math.PI, rot)
            .stroke({ color: 0x76bfae, alpha: 0.28, width: 1.2 });
        gfx.arc(cx - Math.cos(rot) * (innerR * 0.5), cy - Math.sin(rot) * (innerR * 0.5), innerR * 0.5, rot, rot + Math.PI)
            .stroke({ color: 0xf2a900, alpha: 0.28, width: 1.2 });
    }

    drawFighterPedestal(gfx, px, py, energy, side, now) {
        const isUser = side === 'user';
        const color = isUser ? 0xf2a900 : 0x76bfae;
        const rx = 65;
        const ry = 22;

        // 剑台基座光晕
        gfx.ellipse(px, py, rx, ry).stroke({ color, alpha: 0.28, width: 1.5 });
        gfx.ellipse(px, py, rx * 0.65, ry * 0.65).fill({ color, alpha: 0.06 });

        // 随能量点亮的环绕飞剑
        if (energy > 0) {
            const rotSpeed = 0.8 + energy * 0.3;
            for (let i = 0; i < energy; i += 1) {
                const angle = (Math.PI * 2 * i) / energy + (isUser ? now * rotSpeed : -now * rotSpeed);
                const swordX = px + Math.cos(angle) * (rx * 0.95);
                const swordY = py + Math.sin(angle) * (ry * 1.05) - 12;
                const tilt = angle + Math.PI * 0.5;

                this.drawSwordIcon(gfx, swordX, swordY, tilt, 14, color, 0.75);

                // 飞剑剑尖微光
                gfx.circle(swordX, swordY, 2).fill({ color: 0xffffff, alpha: 0.8 });
            }

            // 能量达到3点及以上时的升腾剑煞
            if (energy >= 3) {
                const flameAlpha = 0.15 + Math.sin(now * 4 + (isUser ? 0 : 2)) * 0.08;
                gfx.moveTo(px - 26, py)
                    .quadraticCurveTo(px, py - 46, px + 26, py)
                    .fill({ color, alpha: flameAlpha });
            }
        }
    }

    drawMoveEffect(gfx, effect, width, height) {
        const progress = effect.age / effect.life;
        const isUser = effect.side === 'user';
        const dir = isUser ? 1 : -1;
        const originX = isUser ? width * 0.22 : width * 0.78;
        const targetX = width * 0.5;
        const cy = height * 0.52;
        const alpha = Math.max(0, 1 - progress);

        // 1. 蓄势 (Charge)：天地灵气八方汇聚向角色，凝聚冲天聚气剑芒与回荡气浪
        if (effect.type === 'charge') {
            const easeP = Math.min(1, progress * 1.3);
            const gatherCount = 8;
            for (let i = 0; i < gatherCount; i += 1) {
                const angle = (Math.PI * 2 * i) / gatherCount + progress * 3;
                const startDist = 75 * (1 - easeP);
                const gx = originX + Math.cos(angle) * startDist;
                const gy = cy + Math.sin(angle) * startDist * 0.6;
                gfx.circle(gx, gy, 3.5 * (1 - easeP * 0.6))
                    .fill({ color: 0x4c9cff, alpha: (1 - easeP) * 0.85 });
                gfx.moveTo(gx, gy)
                    .lineTo(originX, cy)
                    .stroke({ color: 0x76bfae, width: 1.5, alpha: (1 - easeP) * 0.4 });
            }

            // 聚气核心光柱爆发
            if (progress > 0.4) {
                const burstP = (progress - 0.4) / 0.6;
                const burstR = 12 + burstP * 48;
                gfx.circle(originX, cy, burstR)
                    .stroke({ color: 0x4c9cff, alpha: (1 - burstP) * 0.9, width: 2.5 });
                gfx.circle(originX, cy, burstR * 0.5)
                    .fill({ color: 0x76bfae, alpha: (1 - burstP) * 0.35 });

                // 冲天剑气
                gfx.moveTo(originX, cy + 20)
                    .lineTo(originX, cy - 80 * (1 - burstP * 0.3))
                    .stroke({ color: 0xffffff, width: 4 * (1 - burstP), alpha: (1 - burstP) * 0.9 });
            }
            return;
        }

        // 2. 斩击 (Slash)：破空月牙弧刃剑气，携带多重锋芒与切裂残影
        if (effect.type === 'slash') {
            const travel = Math.min(1, progress * 1.7);
            const currentX = originX + (targetX - originX) * travel;
            const bladeLen = 65;
            const rot = dir * (Math.PI * 0.22);

            // 月牙剑芒弧面
            gfx.save();
            const topX = currentX + Math.cos(rot - Math.PI * 0.5) * bladeLen;
            const topY = cy + Math.sin(rot - Math.PI * 0.5) * bladeLen;
            const botX = currentX + Math.cos(rot + Math.PI * 0.5) * bladeLen;
            const botY = cy + Math.sin(rot + Math.PI * 0.5) * bladeLen;
            const midBulge = currentX + dir * 28;

            gfx.moveTo(topX, topY)
                .quadraticCurveTo(midBulge, cy, botX, botY)
                .quadraticCurveTo(currentX - dir * 12, cy, topX, topY)
                .fill({ color: 0xf2a900, alpha: alpha * 0.75 });

            // 锋锐白色刃光核心
            gfx.moveTo(topX, topY)
                .quadraticCurveTo(midBulge, cy, botX, botY)
                .stroke({ color: 0xffffff, width: 3.5, alpha: alpha * 0.95 });

            // 斩击尾迹气流
            for (let t = 1; t <= 3; t += 1) {
                const trailX = currentX - dir * t * 14;
                gfx.moveTo(topX - dir * t * 10, topY)
                    .quadraticCurveTo(trailX, cy, botX - dir * t * 10, botY)
                    .stroke({ color: 0xf2a900, width: 1.2, alpha: alpha * (0.5 / t) });
            }
            gfx.restore();
            return;
        }

        // 3. 轻霜踏雪 (LightStep)：踏雪无痕凌波疾闪，地面冰晶雪花蔓延，三道交叉冰棱飞刺
        if (effect.type === 'step') {
            const travel = Math.min(1, progress * 1.5);
            const currentX = originX + (targetX - originX) * travel;

            // 沿途踏雪冰花
            const stepPoints = 4;
            for (let i = 0; i < stepPoints; i += 1) {
                const stepProg = i / (stepPoints - 1);
                if (travel >= stepProg) {
                    const sx = originX + (targetX - originX) * stepProg;
                    const sy = cy + Math.sin(stepProg * Math.PI) * 16 * (i % 2 === 0 ? 1 : -1);
                    const flowerA = Math.max(0, 1 - (progress - stepProg * 0.5) * 1.8);
                    if (flowerA > 0) {
                        // 绘制六角冰花
                        for (let arm = 0; arm < 6; arm += 1) {
                            const a = (Math.PI * 2 * arm) / 6;
                            const r = 9 * (1 - stepProg * 0.2);
                            gfx.moveTo(sx, sy)
                                .lineTo(sx + Math.cos(a) * r, sy + Math.sin(a) * r)
                                .stroke({ color: 0x9be7d2, width: 1.5, alpha: flowerA * 0.8 });
                        }
                    }
                }
            }

            // 终点冰棱暴刺
            const frostAlpha = alpha;
            for (let angleOff of [-0.35, 0, 0.35]) {
                const len = 42 + Math.sin(progress * 4) * 8;
                const fx = currentX + Math.cos(angleOff) * dir * len;
                const fy = cy + Math.sin(angleOff) * len * 0.8;
                gfx.moveTo(currentX, cy)
                    .lineTo(fx, fy)
                    .stroke({ color: 0xffffff, width: 2.8, alpha: frostAlpha });
                gfx.moveTo(currentX, cy)
                    .lineTo(fx, fy)
                    .stroke({ color: 0x76bfae, width: 5.5, alpha: frostAlpha * 0.45 });
            }
            return;
        }

        // 4. 寒梅逐鹿 (PlumBlossom)：红梅傲雪绽放，花瓣风暴席卷，青莲回春灵气生机回流
        if (effect.type === 'plum') {
            const travel = Math.min(1, progress * 1.4);
            const currentX = originX + (targetX - originX) * travel;

            // 漫天旋转飞旋的寒梅花瓣风暴
            const petalCount = 14;
            for (let i = 0; i < petalCount; i += 1) {
                const angle = (Math.PI * 2 * i) / petalCount + progress * 6;
                const swirlR = 14 + progress * 42;
                const px = currentX + Math.cos(angle) * swirlR;
                const py = cy + Math.sin(angle) * swirlR * 0.65;
                const petalAngle = angle + Math.PI * 0.5;

                gfx.save();
                gfx.ellipse(px, py, 6.5, 3.5)
                    .fill({ color: i % 2 === 0 ? 0xe06c9f : 0xff99bb, alpha: alpha * 0.85 });
                gfx.circle(px, py, 1.5).fill({ color: 0xffffff, alpha: alpha * 0.9 });
                gfx.restore();
            }

            // 傲雪红梅印记
            if (progress < 0.6) {
                const bloomA = (1 - progress / 0.6) * alpha;
                for (let petal = 0; petal < 5; petal += 1) {
                    const pa = (Math.PI * 2 * petal) / 5;
                    const pr = 14;
                    gfx.circle(originX + Math.cos(pa) * pr, cy + Math.sin(pa) * pr, 8)
                        .fill({ color: 0xe06c9f, alpha: bloomA * 0.5 });
                }
                gfx.circle(originX, cy, 5).fill({ color: 0xf2a900, alpha: bloomA * 0.8 });
            }

            // 回春生机流光回流自身 (Heal Aura)
            if (progress > 0.35) {
                const healP = (progress - 0.35) / 0.65;
                const healX = targetX + (originX - targetX) * healP;
                const healY = cy - Math.sin(healP * Math.PI) * 35;
                gfx.circle(healX, healY, 6).fill({ color: 0x76bfae, alpha: (1 - healP) * 0.9 });
                gfx.circle(healX, healY, 14).stroke({ color: 0x9be7d2, width: 2, alpha: (1 - healP) * 0.6 });

                // 自身周围生命粒子环
                for (let h = 0; h < 6; h += 1) {
                    const ha = (Math.PI * 2 * h) / 6 + healP * 5;
                    const hr = 24 + healP * 16;
                    gfx.circle(originX + Math.cos(ha) * hr, cy + Math.sin(ha) * hr * 0.6 - 15, 2.5)
                        .fill({ color: 0x76bfae, alpha: (1 - healP) * 0.8 });
                }
            }
            return;
        }

        // 5. 回光无影 (Flash)：终极大招（9伤）！瞬狱断空多重裂痕，全屏白金神剑极光引爆
        if (effect.type === 'flash') {
            // 阶段 1 (0.0 ~ 0.45)：虚空瞬狱切线割裂全场
            const cuts = [
                [-0.4, -0.6, 0.4, 0.6],
                [-0.45, 0.5, 0.45, -0.5],
                [-0.5, -0.1, 0.5, 0.15],
                [-0.2, -0.7, 0.25, 0.7],
                [-0.48, 0.25, 0.48, -0.2],
            ];

            cuts.forEach((cut, index) => {
                const delay = index * 0.08;
                if (progress >= delay) {
                    const cutProg = Math.min(1, (progress - delay) / 0.35);
                    const startX = width * (0.5 + cut[0]);
                    const startY = height * (0.5 + cut[1]);
                    const endX = width * (0.5 + cut[2]);
                    const endY = height * (0.5 + cut[3]);
                    const curEndX = startX + (endX - startX) * cutProg;
                    const curEndY = startY + (endY - startY) * cutProg;

                    // 裂痕白光核心
                    gfx.moveTo(startX, startY)
                        .lineTo(curEndX, curEndY)
                        .stroke({ color: 0xffffff, width: 5.5, alpha });
                    // 外层金色剑芒电光
                    gfx.moveTo(startX, startY)
                        .lineTo(curEndX, curEndY)
                        .stroke({ color: 0xf2a900, width: 14, alpha: alpha * 0.45 });
                }
            });

            // 阶段 2 (0.4 ~ 1.0)：虚空归一爆裂光刺
            if (progress > 0.4) {
                const burstP = (progress - 0.4) / 0.6;
                const burstA = Math.max(0, 1 - burstP);
                const burstR = 30 + burstP * (width * 0.45);

                gfx.circle(targetX, cy, burstR)
                    .stroke({ color: 0xffffff, width: 4 * burstA, alpha: burstA * 0.9 });
                gfx.circle(targetX, cy, burstR * 0.6)
                    .fill({ color: 0xf2a900, alpha: burstA * 0.28 });

                // 放射状八方神剑芒刺
                for (let ray = 0; ray < 12; ray += 1) {
                    const ra = (Math.PI * 2 * ray) / 12 + progress * 0.5;
                    const rayLen = 50 + burstP * 120;
                    gfx.moveTo(targetX, cy)
                        .lineTo(targetX + Math.cos(ra) * rayLen, cy + Math.sin(ra) * rayLen)
                        .stroke({ color: 0xffffff, width: 2.5 * burstA, alpha: burstA * 0.8 });
                }
            }
            return;
        }

        // 6. 御剑格挡 (Block)：六柄金光飞剑极速盘旋形成八卦金刚剑盾，反弹一切冲击
        if (effect.type === 'block') {
            const shieldX = originX + dir * 28;
            const shieldR = 48;
            const rot = progress * 7;

            // 金刚八角剑阵光幕
            const vertices = 8;
            gfx.moveTo(
                shieldX + Math.cos(rot) * shieldR,
                cy + Math.sin(rot) * (shieldR * 1.2)
            );
            for (let v = 1; v <= vertices; v += 1) {
                const va = (Math.PI * 2 * v) / vertices + rot;
                gfx.lineTo(shieldX + Math.cos(va) * shieldR, cy + Math.sin(va) * (shieldR * 1.2));
            }
            gfx.stroke({ color: 0x76bfae, width: 3, alpha: alpha * 0.85 })
                .fill({ color: 0x76bfae, alpha: alpha * 0.18 });

            // 环绕护体飞剑
            const swordCount = 5;
            for (let s = 0; s < swordCount; s += 1) {
                const sa = (Math.PI * 2 * s) / swordCount - rot * 1.2;
                const sx = shieldX + Math.cos(sa) * (shieldR * 0.95);
                const sy = cy + Math.sin(sa) * (shieldR * 1.15);
                this.drawSwordIcon(gfx, sx, sy, sa + Math.PI * 0.5, 18, 0x9be7d2, alpha * 0.9);
            }

            // 受击震荡光环
            const pulseR = 20 + progress * 40;
            gfx.ellipse(shieldX, cy, pulseR, pulseR * 1.2)
                .stroke({ color: 0xffffff, width: 2, alpha: alpha * 0.6 });
            return;
        }

        // 7. 太极两仪 (Taiji)：黑白阴阳双鱼流转生生不息，化劲大旋涡吞噬化解强攻
        if (effect.type === 'taiji') {
            const taijiX = originX + dir * 32;
            const radius = 54;
            const rot = progress * 6;

            // 外层太极两仪光环
            gfx.circle(taijiX, cy, radius + Math.sin(progress * 6) * 4)
                .stroke({ color: 0xd6b3ff, width: 2.5, alpha: alpha * 0.85 });

            // 阴阳双鱼主环
            const eyeDist = radius * 0.48;
            const p1x = taijiX + Math.cos(rot) * eyeDist;
            const p1y = cy + Math.sin(rot) * eyeDist;
            const p2x = taijiX - Math.cos(rot) * eyeDist;
            const p2y = cy - Math.sin(rot) * eyeDist;

            // 阳极流光
            gfx.circle(p1x, p1y, radius * 0.45)
                .fill({ color: 0x76bfae, alpha: alpha * 0.45 });
            gfx.circle(p1x, p1y, 5).fill({ color: 0xffffff, alpha: alpha * 0.9 });

            // 阴极流光
            gfx.circle(p2x, p2y, radius * 0.45)
                .fill({ color: 0x3d3054, alpha: alpha * 0.55 });
            gfx.circle(p2x, p2y, 5).fill({ color: 0xd6b3ff, alpha: alpha * 0.9 });

            // 化解虚无旋涡向心吸附线
            for (let v = 0; v < 6; v += 1) {
                const va = (Math.PI * 2 * v) / 6 - rot * 1.5;
                const vr1 = radius * 1.2;
                const vr2 = radius * 0.2;
                gfx.moveTo(taijiX + Math.cos(va) * vr1, cy + Math.sin(va) * vr1)
                    .quadraticCurveTo(taijiX + Math.cos(va + 0.6) * radius * 0.6, cy + Math.sin(va + 0.6) * radius * 0.6, taijiX, cy)
                    .stroke({ color: 0xd6b3ff, width: 1.5, alpha: alpha * 0.6 });
            }
        }
    }

    render(dt = 1 / 60) {
        if (!this.app) return;
        const width = this.root.clientWidth;
        const height = this.root.clientHeight;
        const cx = width / 2;
        const cy = height / 2;
        this.now += dt;

        // 震屏阻尼更新
        if (this.shakeTimer > 0) {
            this.shakeTimer = Math.max(0, this.shakeTimer - dt);
            const intensity = (this.shakeTimer / 0.35) * this.shakeMagnitude;
            this.stage.position.x = (Math.random() - 0.5) * intensity * 2;
            this.stage.position.y = (Math.random() - 0.5) * intensity * 2;
        } else {
            this.stage.position.x = 0;
            this.stage.position.y = 0;
        }

        // 1. 背景天罡八卦剑阵
        this.backgroundLayer.clear();
        const baseRadius = Math.min(width, height) * 0.36;
        this.drawBaguaArray(this.backgroundLayer, cx, cy, baseRadius, this.now);

        // 2. 双方剑台基座与能量环绕飞剑
        this.pedestalLayer.clear();
        this.drawFighterPedestal(this.pedestalLayer, width * 0.22, height * 0.54, this.userEnergy, 'user', this.now);
        this.drawFighterPedestal(this.pedestalLayer, width * 0.78, height * 0.54, this.aiEnergy, 'ai', this.now);

        // 3. 漫天环境氛围粒子（寒梅、雪晶、剑尘）
        this.ambientLayer.clear();
        this.ambientParticles.forEach(p => {
            p.age += dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.rotation += p.vRot * dt;

            if (p.x > width + 30 || p.y < -30 || p.y > height + 30 || p.age >= p.life) {
                Object.assign(p, this.spawnAmbientParticle(false));
            }

            const fade = Math.sin((p.age / p.life) * Math.PI) * p.alpha;
            if (p.type === 'petal') {
                this.ambientLayer.ellipse(p.x, p.y, p.size * 1.4, p.size * 0.7)
                    .fill({ color: 0xe06c9f, alpha: fade });
            } else if (p.type === 'frost') {
                this.ambientLayer.rect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size)
                    .fill({ color: 0x9be7d2, alpha: fade });
            } else {
                this.ambientLayer.circle(p.x, p.y, p.size * 0.5)
                    .fill({ color: 0xf2a900, alpha: fade });
            }
        });

        // 4. 招式特效层
        this.movesLayer.clear();
        this.moveEffects = this.moveEffects.filter(effect => {
            effect.age += Math.min(dt, 0.05);
            if (effect.age >= effect.life) return false;
            this.drawMoveEffect(this.movesLayer, effect, width, height);
            return true;
        });

        // 5. 碰撞交锋与打击反馈层 (冲击波与爆散火星)
        this.impactsLayer.clear();

        // 冲击波
        this.shockwaves = this.shockwaves.filter(wave => {
            wave.age += Math.min(dt, 0.05);
            const p = wave.age / wave.life;
            if (p >= 1) return false;
            const r = 16 + p * wave.maxRadius;
            const a = (1 - p) * 0.85;
            const wx = width * wave.xRatio;
            const wy = height * wave.yRatio;

            this.impactsLayer.circle(wx, wy, r)
                .stroke({ color: wave.color, width: 3.5 * (1 - p), alpha: a });
            this.impactsLayer.circle(wx, wy, r * 0.6)
                .stroke({ color: 0xffffff, width: 1.5, alpha: a * 0.7 });
            return true;
        });

        // 碰撞火星
        this.sparks = this.sparks.filter(spark => {
            spark.age += Math.min(dt, 0.05);
            if (spark.age >= spark.life) return false;
            spark.xRatio += (spark.vx * dt) / width;
            spark.yRatio += (spark.vy * dt) / height;
            spark.vy += 80 * dt; // 微重力

            const p = spark.age / spark.life;
            const a = (1 - p) * 0.9;
            const sx = width * spark.xRatio;
            const sy = height * spark.yRatio;

            this.impactsLayer.circle(sx, sy, spark.size * (1 - p * 0.5))
                .fill({ color: spark.color, alpha: a });
            return true;
        });

        // 6. 遮罩层 (大招暗幕或全屏闪白)
        this.overlayLayer.clear();
        const activeFlash = this.moveEffects.find(e => e.type === 'flash');
        if (activeFlash) {
            const fp = activeFlash.age / activeFlash.life;
            if (fp < 0.25) {
                // 瞬狱暗幕
                const darkA = Math.sin((fp / 0.25) * Math.PI * 0.5) * 0.55;
                this.overlayLayer.rect(0, 0, width, height)
                    .fill({ color: 0x07090b, alpha: darkA });
            } else if (fp >= 0.4 && fp < 0.55) {
                // 爆裂闪白
                const flashA = (1 - (fp - 0.4) / 0.15) * 0.35;
                this.overlayLayer.rect(0, 0, width, height)
                    .fill({ color: 0xffffff, alpha: flashA });
            }
        }
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