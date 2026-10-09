/* global PIXI */
// 网格立绘后端（*.puppet.json，见 puppet.js）：一张立绘切块做的可动角色，不需要 Cubism Core。
// 参数名和 Live2D 一致，情绪参数、闲时动作曲线和 Live2D 共用。
import { shapeGaze, limitGaze } from './gaze.js';
import { createLifeMotion } from './lifeMotion.js';
import { paramTargets } from './emotionLook.js';
import { createPixiStage, createFigureFit, createAlphaProbe, tickerControls } from './petStage.js';

function clampUnit(v) {
    return Math.max(-1, Math.min(1, v));
}

// 呼吸、眨眼、视线和说话这些自动动作；Live2D 模型自带，网格立绘要自己做。
function createIdleAnimator(talkLevel) {
    let nextBlink = 1.5 + Math.random() * 3;
    let blinkT = -1;
    let doubleBlink = false;
    let mouthPhase = 0;
    let t = 0;
    return {
        step(dt) {
            t += dt;
            nextBlink -= dt;
            if (blinkT < 0 && nextBlink <= 0) {
                blinkT = 0;
                doubleBlink = Math.random() < 0.18;
                nextBlink = 2.5 + Math.random() * 4;
            }
            let eyeClose = 0;
            if (blinkT >= 0) {
                blinkT += dt;
                const CLOSE = 0.07, HOLD = 0.04, OPEN = 0.11;
                if (blinkT < CLOSE) eyeClose = blinkT / CLOSE;
                else if (blinkT < CLOSE + HOLD) eyeClose = 1;
                else if (blinkT < CLOSE + HOLD + OPEN) eyeClose = 1 - (blinkT - CLOSE - HOLD) / OPEN;
                else if (doubleBlink) { doubleBlink = false; blinkT = 0; }
                else blinkT = -1;
            }
            const talk = talkLevel(() => {
                mouthPhase += dt * (9 + Math.random() * 5);
                return 0.2 + 0.45 * Math.max(0, Math.sin(mouthPhase)) * (0.6 + 0.4 * Math.sin(mouthPhase * 0.37));
            });
            return {
                breath: 0.5 + 0.5 * Math.sin((t * 2 * Math.PI) / 3.6),
                eyeClose,
                talk,
                swayZ: 2.2 * Math.sin(t * 0.45) + 0.8 * Math.sin(t * 1.1),
                swayX: 3 * Math.sin(t * 0.31),
            };
        },
    };
}

/** env：{ canvas, talkLevel(fake), onHit(hit), onContextLost() }（同 live2dBackend.js） */
export function createPuppetBackend(assets, env) {
    return createPixiStage(env.canvas, {
        noWebGL: '当前环境没有 WebGL（显卡加速被禁用？），网格立绘画不出来，先用普通立绘代替。',
        onContextLost: env.onContextLost,
        prepare: () => import('vcp-deskpet://pet/app/puppet.js'),
        mount: async (app, { webgl, fps, prepared }) => mountPuppet(app, await prepared.createPuppet(assets.puppet.rigUrl), env, { webgl, fps }),
    });
}

function mountPuppet(app, puppet, env, { webgl, fps }) {
    const holder = new PIXI.Container();
    holder.addChild(puppet.root);
    app.stage.addChild(holder);
    let scale = 1;
    puppet.root.pivot.set(puppet.width / 2, puppet.height);
    // 与 Live2D 相同：先按底图大小摆，量出轮廓后按轮廓摆
    const figure = createFigureFit(app, env.canvas, {
        width: puppet.width,
        height: puppet.height,
        apply(fit) {
            scale = fit.scale;
            puppet.root.scale.set(scale);
            holder.position.set(fit.x, fit.y);
        },
    });

    const idle = createIdleAnimator(env.talkLevel);
    const params = {};
    const current = {};
    let target = {};
    const look = { x: 0, y: 0, tx: 0, ty: 0 };
    let hop = 0, hopV = 0;
    const life = createLifeMotion();
    let lifeParams = {};
    // 情绪目标 + 闲时动作和困意（lifeMotion）的增量
    const get = (id) => (current[id] || 0) + (lifeParams[id] || 0);
    app.ticker.add((ticker) => {
        const dt = Math.min(0.1, ticker.deltaMS / 1000);
        const a = idle.step(dt);
        const lifeFrame = life.step(dt);
        lifeParams = lifeFrame.params;
        const ease = 1 - Math.pow(1 - 0.12, dt * 60);
        for (const id of new Set([...Object.keys(current), ...Object.keys(target)])) {
            const now = current[id] || 0;
            current[id] = now + ((target[id] || 0) - now) * ease;
        }
        look.x += (look.tx - look.x) * (1 - Math.pow(1 - 0.08, dt * 60));
        look.y += (look.ty - look.y) * (1 - Math.pow(1 - 0.08, dt * 60));
        // 单击时跳一下：弹簧回到 0。
        hopV += (-180 * hop - 12 * hopV) * dt;
        hop += hopV * dt;
        holder.position.y = figure.base().y + hop - lifeFrame.hop;

        params.ParamAngleX = get('ParamAngleX') + look.x * 22 + a.swayX;
        params.ParamAngleY = get('ParamAngleY') + look.y * 16;
        params.ParamAngleZ = get('ParamAngleZ') + a.swayZ - look.x * 4;
        params.ParamEyeBallX = clampUnit(get('ParamEyeBallX') + look.x * 0.9);
        params.ParamEyeBallY = clampUnit(get('ParamEyeBallY') + look.y * 0.8);
        for (const side of ['L', 'R']) {
            const open = puppet.defaults[`ParamEye${side}Open`] + get(`ParamEye${side}Open`);
            params[`ParamEye${side}Open`] = Math.max(0, open * (1 - a.eyeClose));
            params[`ParamEye${side}Smile`] = get(`ParamEye${side}Smile`);
        }
        params.ParamMouthForm = get('ParamMouthForm');
        params.ParamMouthOpenY = Math.max(get('ParamMouthOpenY'), a.talk);
        params.ParamCheek = get('ParamCheek');
        params.ParamBreath = a.breath;
        puppet.update(params, dt);
    });

    const probe = createAlphaProbe(app, env.onHit);
    return {
        kind: 'puppet',
        probe: probe.probe,
        focus(x, y) {
            // 视线跟着光标：以脸为原点，按窗口尺寸归一化。
            const hx = holder.position.x + (puppet.headCenter[0] - puppet.width / 2) * scale;
            const hy = holder.position.y + (puppet.headCenter[1] - puppet.height) * scale;
            const g = shapeGaze((x - hx) / (window.innerWidth * 0.6), (hy - y) / (window.innerHeight * 0.6));
            look.tx = g.x;
            look.ty = g.y;
        },
        // 用静止时量出的轮廓，不跟着呼吸、单击轻跳和头发摆动抖（气泡按它贴头顶）。
        bounds: () => figure.bounds(),
        head: () => figure.head(),
        figureReady: figure.ready,
        tap() { hopV = -260; },
        apply(f) { target = paramTargets(f); },
        ...tickerControls(app, fps),
        life: {
            phase(p) { life.setPhase(p); },
            act(name, ms) { life.play(name, ms); },
            held(on) { life.setHeld(on); },
            dragVelocity(vx) { life.dragVelocity(vx); },
            gaze(g) { const v = limitGaze(g); look.tx = v.x; look.ty = v.y; },
        },
        info: { ...puppet.info, renderer: webgl.renderer, software: webgl.software },
    };
}
