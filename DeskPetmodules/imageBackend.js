// 差分立绘 / 头像后端：没有 Live2D、网格立绘（或用不了）时的形象。
// 立绘按情绪换差分（与侧栏首页立绘同一套 portrait.<情绪>.png），头像加一个情绪色环。
import { resolvePortrait } from 'vcp-deskpet://pet/emotion/portraitVariants.js';
import { measureSilhouette, silhouetteAspect, fitSilhouette } from './figure.js';
import { createLifeMotion } from './lifeMotion.js';
import { EMOTION_EMOJI, EMOTION_RING } from './emotionLook.js';
import { fpsTier, HIT_ALPHA, TOP_RESERVE, FOOT_RESERVE } from './petStage.js';

const $ = (id) => document.getElementById(id);

// 立绘和头像没有参数可调：阶段和动作写成 #lifeBody 上的属性，由样式里的关键帧演；
// 拖动摆动和跳一下用同一套单摆计算，只在动起来时跑 requestAnimationFrame，停稳就不再占帧。
// 呼吸（立绘轻轻起伏、头像上下浮）也由页面按档位定时写一个变量，不用无限循环的 CSS 动画：
// 那种动画让透明置顶窗口每秒合成 60 帧，实测立绘桌宠待机比 8 帧的 Live2D 还多花三倍 GPU。
const BREATH_FPS = { active: 15, idle: 10, sleep: 6 };
const BREATH_PERIOD_MS = { awake: 4000, drowsy: 6000, asleep: 7500 };

function createCssLife() {
    const body = $('lifeBody');
    const stage = $('stage');
    const motion = createLifeMotion();
    let raf = 0;
    let last = 0;
    let paused = false;
    let actTimer = 0;
    let breathTimer = 0;
    let breathFps = BREATH_FPS.active;
    let breathPeriod = BREATH_PERIOD_MS.awake;
    let breathPhase = 0; // 0–1，换速度时接着当前位置走，不跳
    let breathAt = 0;
    const breathe = () => {
        breathTimer = 0;
        if (paused) return;
        const now = performance.now();
        breathPhase = (breathPhase + (breathAt ? (now - breathAt) / breathPeriod : 0)) % 1;
        breathAt = now;
        // 0 → 1 → 0 的缓入缓出，和原来的关键帧一样
        stage.style.setProperty('--breath', ((1 - Math.cos(breathPhase * 2 * Math.PI)) / 2).toFixed(3));
        breathTimer = setTimeout(breathe, 1000 / breathFps);
    };
    const restartBreath = () => {
        clearTimeout(breathTimer);
        breathTimer = 0;
        breathAt = 0;
        if (!paused) breathe();
    };
    restartBreath();
    const loop = (ts) => {
        raf = 0;
        if (paused) return;
        const dt = last ? (ts - last) / 1000 : 1 / 60;
        last = ts;
        const { swing, hop } = motion.step(dt);
        stage.style.setProperty('--life-swing', `${swing.toFixed(2)}deg`);
        stage.style.setProperty('--life-hop', `${(-hop).toFixed(1)}px`);
        if (!motion.settled) raf = requestAnimationFrame(loop);
        else { last = 0; stage.style.removeProperty('--life-swing'); stage.style.removeProperty('--life-hop'); }
    };
    const kick = () => { if (!raf && !paused) raf = requestAnimationFrame(loop); };
    return {
        phase(p) {
            body.dataset.lifePhase = p;
            motion.setPhase(p);
            breathPeriod = BREATH_PERIOD_MS[p] || BREATH_PERIOD_MS.awake;
        },
        setActive(level) {
            const fps = BREATH_FPS[fpsTier(level)];
            if (fps === breathFps) return;
            breathFps = fps;
            restartBreath();
        },
        act(name, ms) {
            clearTimeout(actTimer);
            delete body.dataset.lifeAct;
            void body.offsetWidth; // 同一个动作连着来也要从头播
            body.style.setProperty('--life-ms', `${ms}ms`);
            body.dataset.lifeAct = name;
            actTimer = setTimeout(() => { delete body.dataset.lifeAct; }, ms);
            motion.play(name, ms);
            kick();
        },
        held(on) { motion.setHeld(on); kick(); },
        dragVelocity(vx) { motion.dragVelocity(vx); kick(); },
        gaze() {},
        setPaused(p) {
            paused = p;
            if (!p) kick();
            restartBreath();
        },
    };
}

/** env：{ onHit(hit), frame }，frame 是一开始显示的那一帧。 */
export function createImageBackend(assets, env) {
    const portraits = assets.portraits;
    const cssLife = createCssLife();
    const sampler = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    let activeImg = null;

    // 图片实际画在哪里（含呼吸、跳一下这些变换），scale 是画出来的像素 ÷ 原图像素。
    function drawnRect(img) {
        const box = img.getBoundingClientRect();
        if (!img.naturalWidth || !box.width) return null;
        return { x: box.x, y: box.y, width: box.width, height: box.height, scale: box.width / img.naturalWidth };
    }

    function pop() {
        const el = $('portrait');
        el.classList.remove('is-pop');
        void el.offsetWidth;
        el.classList.add('is-pop');
    }

    if (portraits) {
        const theme = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        $('portrait').hidden = false;
        const layers = [$('portraitA'), $('portraitB')];
        const talkImg = $('portraitTalk');
        let front = 0;
        let currentSrc = null;
        const failed = new Set();

        // 按轮廓摆：去掉透明边、脚底贴窗口底边。同一套差分画布一样大，都按第一张（默认立绘）的轮廓摆，
        // 换表情时人不会跳；画布大小不一样的那张按它自己的轮廓摆。
        const measured = new Map(); // src -> 轮廓（原图像素）
        let reference = null; // { width, height, silhouette }
        let resolveFigure = null;
        const figureReady = new Promise((resolve) => { resolveFigure = resolve; });
        const measureImage = (img) => {
            if (measured.has(img.src)) return measured.get(img.src);
            const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
            ctx.canvas.width = img.naturalWidth;
            ctx.canvas.height = img.naturalHeight;
            ctx.drawImage(img, 0, 0);
            let silhouette = null;
            try {
                silhouette = measureSilhouette(ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight).data, img.naturalWidth, img.naturalHeight);
            } catch (error) {
                console.warn('[DeskPet] 量立绘轮廓失败：', error);
            }
            // 整张都是透明的（或读不了像素）就按整张图摆
            silhouette ||= { left: 0, top: 0, right: img.naturalWidth, bottom: img.naturalHeight, head: { x: img.naturalWidth / 2, y: 0, width: img.naturalWidth / 2 } };
            measured.set(img.src, silhouette);
            return silhouette;
        };
        const silhouetteOf = (img) => {
            if (!img?.naturalWidth) return null;
            if (reference && reference.width === img.naturalWidth && reference.height === img.naturalHeight) return reference.silhouette;
            return measureImage(img);
        };
        const place = (img) => {
            const silhouette = silhouetteOf(img);
            if (!silhouette) return;
            const fit = fitSilhouette(silhouette, { width: window.innerWidth, height: window.innerHeight, topReserve: TOP_RESERVE, bottomReserve: FOOT_RESERVE });
            if (!fit) return;
            img.style.left = `${fit.x}px`;
            img.style.top = `${fit.y}px`;
            img.style.width = `${img.naturalWidth * fit.scale}px`;
            img.style.height = `${img.naturalHeight * fit.scale}px`;
        };
        window.addEventListener('resize', () => [...layers, talkImg].forEach(place));

        const show = async (src, withPop) => {
            if (!src || src === currentSrc || failed.has(src)) return;
            currentSrc = src;
            const next = layers[1 - front];
            next.src = src;
            try {
                await next.decode();
            } catch {
                failed.add(src); // 坏图记住，不再尝试
                if (!reference) resolveFigure(null);
                return;
            }
            if (src !== currentSrc) return;
            if (!reference) {
                reference = { width: next.naturalWidth, height: next.naturalHeight, silhouette: measureImage(next) };
                resolveFigure(silhouetteAspect(reference.silhouette));
                if (talkImg.naturalWidth) place(talkImg);
            }
            place(next);
            next.classList.add('is-active');
            layers[front].classList.remove('is-active');
            front = 1 - front;
            activeImg = next;
            sampler.canvas.width = next.naturalWidth;
            sampler.canvas.height = next.naturalHeight;
            sampler.clearRect(0, 0, next.naturalWidth, next.naturalHeight);
            sampler.drawImage(next, 0, 0);
            if (withPop) pop();
        };
        const urlFor = (f) => resolvePortrait(portraits, { state: f.state, emotion: f.emotion, theme })?.url;
        show(urlFor(env.frame), false);
        // 张嘴帧（portrait.talk.png，可选）：朗读时声音大过一点就换上，小下去再换回，中间留一段免得闪
        let talking = false;
        if (portraits.talk) {
            talkImg.src = portraits.talk;
            talkImg.decode().then(() => place(talkImg)).catch(() => {});
        }
        const setMouth = (open) => {
            if (!portraits.talk) return;
            const next = talking ? open > 0.08 : open > 0.2;
            if (next === talking) return;
            talking = next;
            $('portrait').classList.toggle('is-talking', talking);
        };
        // 轮廓（原图像素）换成窗口坐标
        const inWindow = (img) => {
            const r = img && drawnRect(img);
            const silhouette = r && silhouetteOf(img);
            if (!silhouette) return null;
            return { r, silhouette };
        };
        return {
            kind: 'portrait',
            probe(x, y) {
                const r = activeImg && drawnRect(activeImg);
                if (!r || x < r.x || y < r.y || x >= r.x + r.width || y >= r.y + r.height) return env.onHit(false);
                const a = sampler.getImageData(Math.floor((x - r.x) / r.scale), Math.floor((y - r.y) / r.scale), 1, 1).data[3];
                env.onHit(a >= HIT_ALPHA);
            },
            focus() {},
            bounds() {
                const got = inWindow(activeImg);
                if (!got) return null;
                const { r, silhouette: sil } = got;
                return { x: r.x + sil.left * r.scale, y: r.y + sil.top * r.scale, width: (sil.right - sil.left) * r.scale, height: (sil.bottom - sil.top) * r.scale };
            },
            head() {
                const got = inWindow(activeImg);
                if (!got) return null;
                const { r, silhouette: sil } = got;
                return { x: r.x + sil.head.x * r.scale, y: r.y + sil.head.y * r.scale, width: sil.head.width * r.scale };
            },
            figureReady,
            tap: pop,
            canShow: (emotion) => Boolean(portraits[emotion]),
            apply(f, { changed }) { if (changed) show(urlFor(f), true); },
            setMouth,
            setActive(level) { cssLife.setActive(level); },
            setPaused(paused) { cssLife.setPaused(paused); },
            life: cssLife,
        };
    }

    $('avatar').hidden = false;
    const img = $('avatarImg');
    // 没有头像就只显示情绪圆环和表情符号。
    if (assets.avatar) img.src = assets.avatar;
    else img.hidden = true;
    return {
        kind: 'avatar',
        probe(x, y) {
            const b = $('avatar').getBoundingClientRect();
            env.onHit(Math.hypot(x - (b.x + b.width / 2), y - (b.y + b.height / 2)) <= b.width / 2 + 4);
        },
        focus() {},
        bounds() { const b = $('avatar').getBoundingClientRect(); return { x: b.x - 6, y: b.y - 6, width: b.width + 12, height: b.height + 12 }; },
        head() { const b = $('avatar').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y, width: b.width * 0.8 }; },
        tap() {},
        apply(f) {
            $('avatar').style.setProperty('--deskpet-ring', EMOTION_RING[f.emotion] || EMOTION_RING.neutral);
            $('avatarBadge').textContent = f.state === 'thinking' || f.state === 'tool' ? '💭' : (EMOTION_EMOJI[f.emotion] || '');
        },
        setActive(level) { cssLife.setActive(level); },
        setPaused(paused) { cssLife.setPaused(paused); },
        life: cssLife,
    };
}
