// 把 petLife 的阶段和动作变成逐帧的参数增量（Live2D 标准参数名），外加拖动时的摆动角度和跳起高度。
// 只用标准参数，模型没有的参数由调用方跳过；没有对应动作文件的模型也能演出来。
// 纯计算，不碰 Pixi：Live2D 后端每帧把 params 叠到模型上，立绘和头像只用 swing / hop。

import { ACTION_MS } from './petLife.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// 0 → 1 → 0 的包络：attack 比例内升起，release 比例内落下
function envelope(p, attack = 0.2, release = 0.3) {
    if (p <= 0 || p >= 1) return 0;
    if (p < attack) return ease(p / attack);
    if (p > 1 - release) return ease((1 - p) / release);
    return 1;
}
const ease = (x) => x * x * (3 - 2 * x);
// 在 [a, b] 区间内从 0 升到 1 再落回 0 的钟形
function bump(p, a, b) {
    if (p <= a || p >= b) return 0;
    return Math.sin(((p - a) / (b - a)) * Math.PI);
}

// 每个阶段的姿态（权重平滑过渡）
const PHASE_POSE = {
    awake: {},
    drowsy: { ParamEyeLOpen: -0.45, ParamEyeROpen: -0.45, ParamAngleY: -6, ParamBrowLY: -0.2, ParamBrowRY: -0.2 },
    asleep: {
        ParamEyeLOpen: -1, ParamEyeROpen: -1, ParamEyeLSmile: 0.3, ParamEyeRSmile: 0.3,
        ParamAngleY: -16, ParamAngleZ: 7, ParamBodyAngleZ: 3, ParamMouthForm: 0.2, ParamBrowLY: -0.1, ParamBrowRY: -0.1,
    },
};

// 动作：p 是 0..1 的进度，t 是动作开始后的秒数，side 是这次随机的方向（±1）
const ACTIONS = {
    lookAround: () => ({}), // 主要靠视线游走，参数上只配合一点转头（由视线负责）
    tilt: (p, _t, side) => {
        const k = envelope(p, 0.25, 0.3);
        return { ParamAngleZ: 12 * side * k, ParamEyeBallX: -0.3 * side * k, ParamBrowLY: 0.3 * k, ParamBrowRY: 0.3 * k };
    },
    stretch: (p) => {
        const k = envelope(p, 0.3, 0.3);
        return { ParamAngleY: 12 * k, ParamBodyAngleY: 8 * k, ParamEyeLOpen: -0.6 * k, ParamEyeROpen: -0.6 * k, ParamMouthOpenY: 0.25 * k, ParamBodyAngleZ: 3 * Math.sin(p * Math.PI * 2) * k };
    },
    hum: (p, t) => {
        const k = envelope(p, 0.15, 0.2);
        return { ParamAngleZ: 6 * Math.sin(t * 5) * k, ParamBodyAngleZ: 3 * Math.sin(t * 5 - 0.6) * k, ParamMouthForm: 0.6 * k, ParamEyeLSmile: 0.5 * k, ParamEyeRSmile: 0.5 * k };
    },
    yawn: (p) => {
        const open = bump(p, 0.12, 0.8);
        const k = envelope(p, 0.15, 0.25);
        return {
            ParamMouthOpenY: open, ParamMouthForm: -0.3 * open,
            ParamEyeLOpen: -0.75 * k, ParamEyeROpen: -0.75 * k,
            ParamAngleY: 10 * bump(p, 0.05, 0.6) - 4 * bump(p, 0.6, 1),
            ParamAngleZ: -5 * k, ParamBrowLY: 0.4 * open, ParamBrowRY: 0.4 * open,
        };
    },
    nod: (p) => {
        // 头慢慢往下沉，到底时猛地抬起来，眼睛也一下睁开
        const sink = p < 0.6 ? ease(p / 0.6) : Math.max(0, 1 - (p - 0.6) / 0.12);
        const jolt = bump(p, 0.62, 0.9);
        return { ParamAngleY: -20 * sink + 4 * jolt, ParamEyeLOpen: -0.4 * sink + 0.35 * jolt, ParamEyeROpen: -0.4 * sink + 0.35 * jolt };
    },
    wake: (p, t) => {
        // 慢慢睁眼（阶段姿态负责从闭眼过渡到睁眼），中间揉一揉：头左右晃两下
        const k = envelope(p, 0.2, 0.35);
        return { ParamAngleZ: 5 * Math.sin(t * 9) * k, ParamEyeLOpen: -0.4 * k, ParamEyeROpen: -0.4 * k, ParamMouthOpenY: 0.2 * bump(p, 0.1, 0.5) };
    },
    startle: (p) => {
        const k = envelope(p, 0.06, 0.5);
        return { ParamEyeLOpen: 0.4 * k, ParamEyeROpen: 0.4 * k, ParamBrowLY: 0.8 * k, ParamBrowRY: 0.8 * k, ParamAngleY: 6 * k, ParamMouthOpenY: 0.4 * k, ParamMouthForm: -0.3 * k };
    },
    poke: () => ({}), // 沿用原来的开心动作，这里只负责跳一下
    headTap: (p) => {
        const k = envelope(p, 0.1, 0.4);
        return { ParamEyeLOpen: -0.8 * k, ParamEyeROpen: -0.8 * k, ParamEyeLSmile: k, ParamEyeRSmile: k, ParamCheek: 0.6 * k, ParamAngleY: -6 * k, ParamMouthForm: 0.6 * k };
    },
    pat: (p, t) => {
        const k = envelope(p, 0.15, 0.35);
        return { ParamEyeLOpen: -0.6 * k, ParamEyeROpen: -0.6 * k, ParamEyeLSmile: k, ParamEyeRSmile: k, ParamCheek: 0.8 * k, ParamMouthForm: k, ParamAngleZ: 4 * Math.sin(t * 6) * k, ParamAngleY: -5 * k };
    },
    sleepPat: (p, t) => {
        const k = envelope(p, 0.25, 0.4);
        return { ParamMouthForm: 0.8 * k, ParamCheek: 0.5 * k, ParamAngleZ: 3 * Math.sin(t * 3) * k };
    },
    annoyed: (p, t) => {
        const k = envelope(p, 0.1, 0.3);
        const shake = Math.max(0, 1 - p * 1.6);
        return {
            ParamBrowLAngle: -0.9 * k, ParamBrowRAngle: -0.9 * k, ParamBrowLY: -0.4 * k, ParamBrowRY: -0.4 * k,
            ParamMouthForm: -0.8 * k, ParamCheek: 0.6 * k, ParamEyeLOpen: -0.2 * k, ParamEyeROpen: -0.2 * k,
            ParamAngleX: 8 * Math.sin(t * 22) * shake,
        };
    },
    dizzy: (p, t) => {
        const k = envelope(p, 0.1, 0.3);
        return {
            ParamAngleZ: 12 * Math.sin(t * 7) * k, ParamAngleX: 10 * Math.cos(t * 7) * k,
            ParamEyeBallX: 0.8 * Math.cos(t * 9) * k, ParamEyeBallY: 0.8 * Math.sin(t * 9) * k,
            ParamMouthOpenY: 0.3 * k, ParamEyeLOpen: -0.2 * k, ParamEyeROpen: -0.2 * k,
        };
    },
    // 回复里的动作
    agree: (p) => {
        // 点两下头，眼睛笑一笑
        const k = envelope(p, 0.1, 0.25);
        const nods = Math.max(0, Math.sin(p * Math.PI * 4));
        return { ParamAngleY: -14 * nods * k, ParamBodyAngleY: -3 * nods * k, ParamEyeLSmile: 0.4 * k, ParamEyeRSmile: 0.4 * k, ParamMouthForm: 0.4 * k };
    },
    disagree: (p, t) => {
        // 左右摇两三下，越摇越轻
        const k = envelope(p, 0.08, 0.3);
        return { ParamAngleX: 18 * Math.sin(t * 15) * k * (1 - 0.5 * p), ParamBodyAngleX: 3 * Math.sin(t * 15 - 0.5) * k, ParamBrowLY: -0.2 * k, ParamBrowRY: -0.2 * k };
    },
    cheer: (p) => {
        const k = envelope(p, 0.1, 0.35);
        return { ParamEyeLSmile: k, ParamEyeRSmile: k, ParamMouthForm: k, ParamMouthOpenY: 0.4 * bump(p, 0.1, 0.7), ParamAngleY: 6 * bump(p, 0.1, 0.6), ParamCheek: 0.4 * k };
    },
    bow: (p) => {
        const k = envelope(p, 0.3, 0.35);
        return { ParamAngleY: -24 * k, ParamBodyAngleY: -10 * k, ParamEyeLOpen: -0.5 * k, ParamEyeROpen: -0.5 * k };
    },
    landed: (p) => {
        const k = bump(p, 0, 1);
        return { ParamAngleY: -6 * k, ParamEyeLOpen: -0.5 * bump(p, 0.1, 0.5), ParamEyeROpen: -0.5 * bump(p, 0.1, 0.5) };
    },
};

// 被拎起来时的表情（拖动期间一直有）
const LIFTED = { ParamEyeLOpen: 0.3, ParamEyeROpen: 0.3, ParamBrowLY: 0.5, ParamBrowRY: 0.5, ParamMouthOpenY: 0.3, ParamMouthForm: -0.4 };

// 跳起高度（像素，向上为正）
const HOPS = { startle: [0.0, 0.45, 26], poke: [0, 0.6, 14], headTap: [0, 0.4, 6], landed: [0, 1, -10], annoyed: [0, 0.3, 8], cheer: [0.05, 0.6, 22], bow: [0.25, 0.75, -6] };

export function createLifeMotion({ random = Math.random } = {}) {
    const weights = { awake: 1, drowsy: 0, asleep: 0 };
    let phase = 'awake';
    let action = null;   // { name, t, ms, side }
    let lifted = 0;      // 拖动表情权重
    let held = false;
    // 摆动：拖动时按横向速度甩起来的单摆，松手后自己荡回去
    let swing = 0;
    let swingV = 0;
    let dragVx = 0;
    let clock = 0;       // 犯困时眼皮起伏、睡着时呼吸用

    return {
        setPhase(next) { phase = next; },
        // weight：模型自己有这个动作文件时调小，参数曲线只轻轻叠一点
        play(name, ms = ACTION_MS[name] || 1000, { weight = 1 } = {}) {
            action = { name, t: 0, ms, weight, side: random() < 0.5 ? -1 : 1 };
        },
        setHeld(on) {
            held = on;
            if (!on) dragVx = 0;
        },
        // 拖动中窗口的横向速度（像素/秒）
        dragVelocity(vx) { dragVx = vx; },
        get settled() {
            return !action && !held && lifted < 0.01 && Math.abs(swing) < 0.05 && Math.abs(swingV) < 0.05
                && weights[phase] > 0.99;
        },

        step(dt) {
            dt = Math.min(0.1, Math.max(0, dt));
            clock += dt;
            // 阶段权重：困了慢慢合眼（约 1.5 秒），醒来时快一些
            const rate = phase === 'awake' ? 2.2 : 0.7;
            for (const key of Object.keys(weights)) {
                const goal = key === phase ? 1 : 0;
                weights[key] += (goal - weights[key]) * (1 - Math.exp(-rate * dt * 2));
            }
            const params = {};
            const add = (src, k) => {
                if (!k) return;
                for (const [id, v] of Object.entries(src)) params[id] = (params[id] || 0) + v * k;
            };
            add(PHASE_POSE.drowsy, weights.drowsy);
            add(PHASE_POSE.asleep, weights.asleep);
            if (weights.drowsy > 0.05) {
                // 犯困时眼皮一沉一抬，像在硬撑
                const fight = 0.15 * Math.sin(clock * 1.3);
                params.ParamEyeLOpen = (params.ParamEyeLOpen || 0) + fight * weights.drowsy;
                params.ParamEyeROpen = (params.ParamEyeROpen || 0) + fight * weights.drowsy;
            }
            if (weights.asleep > 0.05) {
                // 睡着时随呼吸轻轻起伏
                params.ParamAngleZ = (params.ParamAngleZ || 0) + 1.5 * Math.sin(clock * 0.9) * weights.asleep;
            }

            let hop = 0;
            if (action) {
                action.t += dt;
                const p = action.t / (action.ms / 1000);
                if (p >= 1) {
                    action = null;
                } else {
                    add(ACTIONS[action.name]?.(p, action.t, action.side) || {}, action.weight);
                    const h = HOPS[action.name];
                    if (h) hop = h[2] * bump(p, h[0], h[1]);
                }
            }

            lifted += ((held ? 1 : 0) - lifted) * (1 - Math.exp(-8 * dt));
            add(LIFTED, lifted);
            // 单摆：往拖动的反方向甩，阻尼回正
            const push = held ? clamp(-dragVx / 60, -18, 18) : 0;
            swingV += ((push - swing) * 40 - swingV * 6) * dt;
            swing += swingV * dt;
            if (Math.abs(swing) > 0.05) {
                params.ParamAngleZ = (params.ParamAngleZ || 0) + swing;
                params.ParamBodyAngleZ = (params.ParamBodyAngleZ || 0) + swing * 0.6;
            }
            return { params, swing, hop, weights: { ...weights } };
        },
    };
}
