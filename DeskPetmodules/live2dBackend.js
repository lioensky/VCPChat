/* global PIXI */
// Live2D 后端：untitled-pixi-live2d-engine（vendor/live2d）加用户装的 Cubism Core 5.x。
// 情绪 → 表情 / 动作的映射规则在 expressionMap.js（设置页「表情映射」也用它）；
// 闲时动作和互动是叠在标准参数上的曲线（lifeMotion.js），模型自己有对应动作组时一起放。
import { VOWELS } from './voice.js';
import { shapeGaze, limitGaze } from './gaze.js';
import { createLifeMotion } from './lifeMotion.js';
import { zoneOf, hasZones } from './hitAreas.js';
import { pickExpression as mapExpression, pickMotion as mapMotion, pickTap, modelNameOf } from './expressionMap.js';
import { paramTargets } from './emotionLook.js';
import { createPixiStage, createFigureFit, createAlphaProbe, tickerControls, loadScript, fetchJson, userFacing } from './petStage.js';

const CORE_V6 = 0x06000000;
const ENGINE_URL = 'vcp-deskpet://pet/vendor/live2d/untitled-pixi-live2d-engine.cubism.min.js';

// 闲时和互动的动作：先看 deskpet.json 的 motions，再按组名找；都没有就只靠参数曲线演（lifeMotion.js）。
const LIFE_MOTIONS = {
    headTap: ['TapHead', 'Tap@Head', 'Head'],
    pat: ['TapHead', 'Tap@Head', 'Head'],
    annoyed: ['Angry', 'Flick@Body', 'Flick', 'Shake'],
    dizzy: ['Dizzy', 'Shake', 'FlickDown'],
    startle: ['Surprised', 'FlickUp', 'Flick'],
    yawn: ['Yawn', 'Sleepy'],
    stretch: ['Stretch'],
    hum: ['Happy', 'Dance'],
    wake: ['Wake', 'WakeUp'],
    landed: ['Landing', 'FlickDown'],
    agree: ['Nod', 'Agree', 'Yes'],
    disagree: ['Shake', 'Disagree', 'No'],
    cheer: ['Cheer', 'Jump', 'Happy'],
    bow: ['Bow'],
};
const LIFE_MOTION_WEIGHT = 0.4; // 模型自己有这个动作时，参数曲线只轻轻叠一点

// 模型里的元音口形参数：Cubism 标准名 ParamA、ParamI、ParamU、ParamE、ParamO（有些模型写成 ParamMouthA 这类）
export function vowelParamsOf(paramIds) {
    const found = [];
    for (const vowel of VOWELS) {
        const upper = vowel.toUpperCase();
        const id = [`Param${upper}`, `ParamMouth${upper}`, `PARAM_${upper}`].find((name) => paramIds.has(name));
        if (id) found.push({ vowel, id });
    }
    // 只有一两个对得上多半是巧合（别的参数刚好叫这个名字）：至少要 a、i、u 三个齐
    return ['a', 'i', 'u'].every((v) => found.some((f) => f.vowel === v)) ? found : [];
}

// 模型载入失败时给人看的一句话：原始报错里是一长串 vcp-deskpet:// 地址和加载器的名字，气泡里看不懂
export function live2DFailureText(error) {
    const raw = String(error?.message || error || '');
    const file = (pattern) => decodeURIComponent((raw.match(pattern) || [])[1] || '');
    const texture = file(/([^/\s]+\.(?:png|jpe?g|webp))\b[^]*?(?:404|Not Found|Failed)/i);
    if (texture) return `这套 Live2D 模型缺贴图（${texture}），先用立绘代替`;
    if (/model3\.json|JSON|Network error|Unexpected token/i.test(raw)) return '这套 Live2D 模型的 .model3.json 读不了（文件可能坏了），先用立绘代替';
    if (/moc3?|createModel|Invalid|consistency/i.test(raw)) return '这套 Live2D 模型的 .moc3 文件读不了（可能坏了或版本太新），先用立绘代替';
    const short = raw.replace(/vcp-deskpet:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return short ? `Live2D 模型载入失败（${short}），先用立绘代替` : 'Live2D 模型载入失败，先用立绘代替';
}

/**
 * env：{ canvas, talkLevel(fake), vowels(), onHit(hit), onContextLost() }
 *   talkLevel：嘴张多大（朗读时跟着声音，回复流出来时按 fake() 假装在说）；vowels：朗读声音里的元音权重。
 */
export function createLive2DBackend(assets, env) {
    return createPixiStage(env.canvas, {
        // 渲染引擎只认 WebGL；显卡被禁用时 Pixi 会退到 Canvas，模型画不出来。
        noWebGL: '当前环境没有 WebGL（显卡加速被禁用？），Live2D 画不出来，先用立绘代替。',
        onContextLost: env.onContextLost,
        async prepare() {
            await loadScript(assets.coreUrl);
            // 文件损坏或放错了文件时脚本照样「加载成功」，只是没有定义 Core。
            const coreVersion = window.Live2DCubismCore?.Version?.csmGetVersion?.() || 0;
            if (!coreVersion) throw userFacing(`${assets.corePath} 不是可用的 Cubism Core（文件损坏或放错了文件），请换一份 5.x 的 live2dcubismcore.min.js。先用立绘代替。`);
            if (coreVersion >= CORE_V6) throw userFacing('Cubism Core 是 6.x，当前渲染引擎只支持 5.x。请换一份 5.x 的 live2dcubismcore.min.js。');
            await loadScript(ENGINE_URL);
            const { Live2DModel, Live2DPlugin } = PIXI.live2d;
            PIXI.extensions.add(Live2DPlugin);
            return { Live2DModel, coreVersion };
        },
        mount: (app, { webgl, fps, prepared }) => mountLive2DModel(app, assets, env, { ...prepared, webgl, fps }),
    });
}

async function mountLive2DModel(app, assets, env, { Live2DModel, coreVersion, webgl, fps }) {
    const model = await Live2DModel.from(assets.live2d.modelUrl, {
        ticker: app.ticker,
        autoHitTest: false,
        autoFocus: false,
        // 画出来只有几百像素高，不必上传整张 2048 图集的 mip 链。
        textureOptions: { lod: 'single-auto' },
    });
    app.stage.addChild(model);
    model.anchor.set(0.5, 1);
    // 角色画在下方，上面留给气泡和输入框；量出轮廓后按轮廓摆，脚底贴窗口底边（见 createFigureFit）。
    let hop = 0;
    const figure = createFigureFit(app, env.canvas, {
        width: model.internalModel.width,
        height: model.internalModel.height,
        apply(fit) {
            model.scale.set(fit.scale);
            model.position.set(fit.x, fit.y - hop);
        },
    });

    // 可选的模型配置：<model 同目录>/deskpet.json
    //   { "expressions": { "happy": "exp_02" }, "motions": { "happy": "Tap" } }
    let profile = (await fetchJson(new URL('deskpet.json', assets.live2d.modelUrl).href)) || {};
    const modelName = modelNameOf(assets.live2d.modelUrl);
    const internal = model.internalModel;
    const coreModel = internal.coreModel;
    const paramIds = new Set(coreModel?._model?.parameters?.ids || coreModel?.getModel?.()?.parameters?.ids || []);
    const expressionNames = (internal.motionManager?.expressionManager?.definitions || [])
        .map((d) => d.Name || d.name).filter(Boolean);
    const motionGroups = Object.keys(internal.motionManager?.definitions || {});
    // 模型标了头的点击区就按它判断点在哪（DeskPetmodules/hitAreas.js）
    const useZones = hasZones(Object.keys(internal.hitAreas || {}));

    const pickExpression = (emotion) => mapExpression(emotion, expressionNames, profile, modelName);
    const pickMotion = (emotion) => mapMotion(emotion, motionGroups, profile);
    function pickLifeMotion(name) {
        const configured = profile.motions?.[name];
        if (configured && motionGroups.includes(configured)) return configured;
        return (LIFE_MOTIONS[name] || []).find((g) => motionGroups.includes(g)) || null;
    }
    const life = createLifeMotion();
    const addParam = (id, value) => coreModel.addParameterValueById(internal.getIdSafe(id), value);
    // 互动动作要马上看到：打断待机动作再放（同一个动作连着放也能重播）
    const forceMotion = (group) => {
        internal.motionManager?.stopAllMotions?.();
        model.motion(group, undefined, PIXI.live2d.MotionPriority?.FORCE ?? 3);
    };

    // 闲时动作、拖动摆动、情绪参数要在物理之前叠上去：引擎每帧的顺序是 动作 → 表情 → 眨眼 → 视线 →
    // updateNaturalMovements（呼吸）→ 物理 → pose → beforeModelUpdate，叠在 beforeModelUpdate 里的
    // 头歪、身体晃不会带动头发和衣服的物理。所以接在 updateNaturalMovements 后面加，嘴和跳一下仍在后面。
    const current = {};
    let target = {};
    let mouthPhase = 0;
    const vowelParams = vowelParamsOf(paramIds);
    const naturalMovements = internal.updateNaturalMovements.bind(internal);
    internal.updateNaturalMovements = (now, dt) => {
        naturalMovements(now, dt);
        addLifeAndEmotion();
    };
    let lifeFrame = { params: {}, hop: 0 };
    function addLifeAndEmotion() {
        // 闲时动作、困意、拖动摆动：叠在情绪之上
        lifeFrame = life.step(app.ticker.deltaMS / 1000);
        for (const [id, v] of Object.entries(lifeFrame.params)) {
            if (paramIds.has(id)) addParam(id, v);
        }
        const keys = new Set([...Object.keys(current), ...Object.keys(target)]);
        for (const id of keys) {
            const goal = target[id] || 0;
            current[id] = (current[id] || 0) + (goal - (current[id] || 0)) * 0.12;
            if (Math.abs(current[id]) < 0.001 && !goal) { delete current[id]; continue; }
            if (paramIds.has(id)) addParam(id, current[id]);
        }
    }
    internal.on('beforeModelUpdate', () => {
        // 跳一下改的是模型位置
        if (lifeFrame.hop !== hop) {
            hop = lifeFrame.hop;
            model.position.y = figure.base().y - hop;
        }
        // 嘴：朗读时按声音的音量开合；没开朗读时回复流出来就假装在说话。
        const open = env.talkLevel(() => {
            mouthPhase += 0.55 + Math.random() * 0.35;
            return 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(mouthPhase));
        });
        if (open && paramIds.has('ParamMouthOpenY')) addParam('ParamMouthOpenY', open);
        // 模型带あいうえお口形参数（ParamA～ParamO）时，朗读按声音里的元音换口形；没有就只按张嘴程度
        if (vowelParams.length) {
            const weights = open ? env.vowels() : null;
            for (const { vowel, id } of vowelParams) {
                const v = weights ? weights[vowel] * Math.min(1, open * 1.2) : 0;
                if (v) addParam(id, v);
            }
        }
    });

    const alphaProbe = createAlphaProbe(app, env.onHit);

    let lastExpression = null;
    return {
        kind: 'live2d',
        probe: alphaProbe.probe,
        // 视线跟光标：不用模型自带的 focus（它只取方向，光标在上面就仰到最大），按离头多远、往哪边转多少
        focus(x, y) {
            const h = figure.head();
            const g = shapeGaze((x - h.x) / (window.innerWidth * 0.6), (h.y + h.width * 0.5 - y) / (window.innerHeight * 0.6));
            internal.focusController.focus(g.x, g.y);
        },
        bounds() { const b = model.getBounds(); return { x: b.x, y: b.y, width: b.width, height: b.height }; },
        head: () => figure.head(),
        // 'head' / 'body' / null（点在没标的地方）；模型没标点击区时 undefined，交给轮廓估计
        zone(x, y) {
            if (!useZones) return undefined;
            try {
                return zoneOf(model.hitTest(x, y));
            } catch {
                return undefined;
            }
        },
        figureReady: figure.ready,
        tap() {
            const group = pickMotion('happy') || motionGroups.find((g) => /tap/i.test(g));
            if (group) model.motion(group);
        },
        // 设置页给点头、点身体绑了表情 / 动作：照绑定的演，返回演了哪些（{ expression, motion }），没绑返回 null
        playTap(zone) {
            const bound = pickTap(zone, expressionNames, motionGroups, profile);
            if (!bound) return null;
            if (bound.motion) forceMotion(bound.motion);
            if (bound.expression) {
                model.expression(bound.expression);
                lastExpression = bound.expression;
            }
            return bound;
        },
        // motion: false 只换表情和参数（换阶段、互动反应演完换回来），不再放一遍情绪动作
        apply(f, { changed, motion = true }) {
            target = paramTargets(f);
            if (!changed) return;
            const expression = pickExpression(f.emotion);
            if (expression && expression !== lastExpression) {
                model.expression(expression);
                lastExpression = expression;
            } else if (!expression && lastExpression) {
                internal.motionManager?.expressionManager?.resetExpression?.();
                lastExpression = null;
            }
            if (!f.state && motion) {
                const group = pickMotion(f.emotion);
                if (group) model.motion(group);
            }
        },
        // 窗口藏起来时整个停掉（窗口关了后台节流，不停的话隐藏着也在一直画）
        ...tickerControls(app, fps),
        life: {
            phase(p) { life.setPhase(p); },
            act(name, ms) {
                const group = pickLifeMotion(name);
                life.play(name, ms, { weight: group ? LIFE_MOTION_WEIGHT : 1 });
                if (group) forceMotion(group);
            },
            held(on) { life.setHeld(on); },
            dragVelocity(vx) { life.dragVelocity(vx); },
            // 视线：g 以头为原点、-1..1；换算成窗口坐标交给模型自己的视线跟随
            gaze(g) {
                const v = limitGaze(g);
                internal.focusController.focus(v.x, v.y);
            },
        },
        // 设置页改了表情映射：不重载，下一次换情绪就按新的来
        setProfile(next) {
            profile = next && typeof next === 'object' ? next : {};
            lastExpression = null;
        },
        info: { coreVersion, expressions: expressionNames, motionGroups, renderer: webgl.renderer, software: webgl.software },
    };
}
