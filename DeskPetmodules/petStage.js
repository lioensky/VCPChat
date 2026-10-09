/* global PIXI */
// 各种形象后端共用的舞台：帧率档位、窗口里给气泡和小胶囊留的位置、WebGL 探测和上下文丢失计数、
// Pixi 应用的建立和收尾、按轮廓摆放、按像素命中。
import { measureSilhouette, silhouetteAspect, fitSilhouette, touchesEdge } from './figure.js';

// 帧率：有回复、刚被碰过时用 active，空闲一会儿降到 idle，睡着了再降到 sleep；
// 没有显卡、用软件渲染时整体再降一档。
export const FPS = { active: 30, idle: 15, sleep: 10 };
export const FPS_SOFTWARE = { active: 20, idle: 8, sleep: 5 };
export const HIT_ALPHA = 24;
export const TOP_RESERVE = 150;       // 窗口上方留给气泡的高度（与样式一致）
export const FOOT_RESERVE = 54;       // 脚下留给小胶囊的高度（与 petPrefs、样式里 #avatar 的 54px 一致）
const FIGURE_MEASURE_MS = 450;        // Live2D、网格立绘载入后过这么久（物理和待机动作稳下来）量一次轮廓
const CONTEXT_LOST_RELOAD_MS = 250;
const CONTEXT_LOSS_WINDOW_MS = 120000;
export const CONTEXT_LOSS_LIMIT = 3;
const CONTEXT_LOSS_KEY = 'deskpet:webgl-losses';

// setActive 的参数：true/false 是旧的「有动静 / 空闲」，也可以直接给档位名
export function fpsTier(level) {
    if (level === true) return 'active';
    if (level === false) return 'idle';
    return level === 'sleep' || level === 'idle' ? level : 'active';
}

export function loadScript(src) {
    return new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = resolve;
        el.onerror = () => reject(new Error(`加载失败: ${src}`));
        document.head.appendChild(el);
    });
}

export async function fetchJson(url) {
    try {
        const res = await fetch(url);
        return res.ok ? res.json() : null;
    } catch {
        return null;
    }
}

/** 给人看的错误：气泡里原样显示 message。 */
export function userFacing(message) {
    const err = new Error(message);
    err.userFacing = true;
    return err;
}

// 有没有 WebGL，以及是不是软件渲染（没有显卡或显卡被禁用时 Chromium 用 SwiftShader）
function probeWebGL() {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { renderer, software: /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer) };
}

/** 最近两分钟里 WebGL 上下文丢了几次（同一个页面会话里，重载也接着数）。 */
export function recentContextLosses() {
    try {
        const list = JSON.parse(sessionStorage.getItem(CONTEXT_LOSS_KEY) || '[]');
        return Array.isArray(list) ? list.filter((t) => Date.now() - t < CONTEXT_LOSS_WINDOW_MS) : [];
    } catch {
        return [];
    }
}

function recordContextLoss() {
    try {
        sessionStorage.setItem(CONTEXT_LOSS_KEY, JSON.stringify([...recentContextLosses(), Date.now()]));
    } catch { /* 存不了就只是不计数 */ }
}

/**
 * 在 canvas 上建一个透明的 Pixi 应用，交给 mount(app, { webgl, fps, prepared }) 摆上形象，返回 mount 给的后端。
 * 没有 WebGL 时抛 noWebGL 那句话；prepare() 在确认有 WebGL 之后、建应用之前跑（载入 Core 和渲染引擎），结果是 prepared。
 * mount 失败时把建好的上下文和渲染循环一起收掉再抛出去。
 * 显卡驱动重置、GPU 进程崩溃、睡眠唤醒都可能让 WebGL 上下文丢失；丢了以后模型不会自己画回来，
 * 角色既看不见也点不到（命中靠读像素）。整页重载重建渲染（先 onContextLost 告诉用户）；短时间内反复丢由页面改用立绘。
 */
export async function createPixiStage(canvas, { noWebGL, prepare, onContextLost, mount }) {
    const webgl = probeWebGL();
    if (!webgl) throw userFacing(noWebGL);
    const fps = webgl.software ? FPS_SOFTWARE : FPS;
    const prepared = prepare ? await prepare() : null;
    canvas.hidden = false;
    const onLost = (event) => {
        event.preventDefault();
        recordContextLoss();
        onContextLost?.();
        setTimeout(() => window.location.reload(), CONTEXT_LOST_RELOAD_MS);
    };
    canvas.addEventListener('webglcontextlost', onLost, { once: true });
    const app = new PIXI.Application();
    await app.init({
        canvas,
        resizeTo: window,
        preference: 'webgl',
        backgroundAlpha: 0,
        // 软件渲染时多重采样很贵，人物边缘的锯齿在桌面上也不明显
        antialias: !webgl.software,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
        preserveDrawingBuffer: false,
        powerPreference: 'low-power',
    });
    app.ticker.maxFPS = fps.active;
    try {
        return await mount(app, { webgl, fps, prepared });
    } catch (error) {
        // 模型坏了：把已经建好的 WebGL 上下文和渲染循环一起收掉，不然它会一直空转。
        // 销毁会主动释放上下文，这不是意外丢失，不能触发重载。
        canvas.removeEventListener('webglcontextlost', onLost);
        app.destroy({ removeView: false }, { children: true });
        canvas.hidden = true;
        throw error;
    }
}

/** Pixi 后端共用的帧率和暂停：setActive(档位)、setPaused(隐藏时整个停掉，不然隐藏着也在一直画)。 */
export function tickerControls(app, fps) {
    return {
        setActive(level) { app.ticker.maxFPS = fps[fpsTier(level)]; },
        setPaused(paused) {
            if (paused) app.ticker.stop();
            else if (!app.ticker.started) app.ticker.start();
        },
    };
}

// ---- 按轮廓摆放（Live2D、网格立绘） ------------------------------------------------
// 模型画布、底图四周常留着透明边（全身模型脚下空一截），按画布摆脚会浮在半空。
// 先按画布摆，等物理和待机动作稳下来，读回整帧量出不透明像素的轮廓和头，再按轮廓摆：
// 脚底贴窗口底边、左右居中、塞满角色区。量之前画布透明，看不到它先浮着再落下来。
// 坐标单位：以锚点（画布底边中点）为原点、1 倍缩放的模型像素；窗口一变就按同一个轮廓重摆。

export function createFigureFit(app, canvas, { width, height, apply }) {
    let box = { left: -width / 2, right: width / 2, top: -height, bottom: 0 };
    let head = null;
    let fit = null;
    let measured = false;
    const layout = () => {
        fit = fitSilhouette(box, { width: window.innerWidth, height: window.innerHeight, topReserve: TOP_RESERVE, bottomReserve: FOOT_RESERVE })
            || { scale: 1, x: window.innerWidth / 2, y: window.innerHeight };
        apply(fit);
    };
    layout();
    window.addEventListener('resize', layout);
    canvas.style.opacity = '0';

    const measureOnce = () => {
        app.render();
        const gl = app.renderer.gl;
        const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        const pixels = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const s = measureSilhouette(pixels, w, h, { flipY: true });
        if (!s) return false;
        const r = app.renderer.resolution || 1;
        const u = (px) => (px / r - fit.x) / fit.scale;
        const v = (py) => (py / r - fit.y) / fit.scale;
        box = { left: u(s.left), right: u(s.right), top: v(s.top), bottom: v(s.bottom) };
        head = { x: u(s.head.x), y: v(s.head.y), width: s.head.width / r / fit.scale };
        measured = true;
        layout();
        return touchesEdge(s, w, h) ? 'clipped' : true;
    };
    // 第一次摆的时候形象可能有一截在窗口外（模型画布四周留白不对称），量到的是被裁过的轮廓、摆出来会偏；
    // 按量到的摆好以后再量，直到整个形象都在窗口里
    const measure = () => {
        let result = false;
        for (let i = 0; i < 4; i++) {
            result = measureOnce();
            if (result !== 'clipped') break;
        }
        return result ? silhouetteAspect(box) : null;
    };
    const ready = new Promise((resolve) => {
        setTimeout(() => {
            let aspect = null;
            try { aspect = measure(); } catch (error) { console.warn('[DeskPet] 量轮廓失败：', error); }
            canvas.style.transition = 'opacity 160ms ease';
            canvas.style.opacity = '1';
            resolve(aspect);
        }, FIGURE_MEASURE_MS);
    });
    const toWindow = (b) => ({ x: fit.x + b.left * fit.scale, y: fit.y + b.top * fit.scale, width: (b.right - b.left) * fit.scale, height: (b.bottom - b.top) * fit.scale });
    return {
        ready,
        base: () => fit,
        bounds: () => toWindow(box),
        // 没量出来时按包围盒估：头在顶上、宽度取一半
        head() {
            if (measured && head) return { x: fit.x + head.x * fit.scale, y: fit.y + head.y * fit.scale, width: head.width * fit.scale };
            const b = toWindow(box);
            return { x: b.x + b.width / 2, y: b.y, width: b.width * 0.5 };
        },
    };
}

// 按像素命中：在当帧渲染之后读 alpha，结果交给 onHit(命中了没有)。
export function createAlphaProbe(app, onHit) {
    const gl = app.renderer.gl;
    const pixel = new Uint8Array(4);
    let pending = null;
    const readAlpha = (x, y) => {
        const r = app.renderer.resolution;
        gl.readPixels(Math.floor(x * r), Math.floor(gl.drawingBufferHeight - y * r - 1), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return pixel[3];
    };
    app.ticker.add(() => {
        if (!pending) return;
        const { x, y } = pending;
        pending = null;
        onHit(readAlpha(x, y) >= HIT_ALPHA);
    }, null, PIXI.UPDATE_PRIORITY.UTILITY);
    return {
        probe(x, y) {
            if (app.ticker.started) { pending = { x, y }; return; }
            app.render();
            onHit(readAlpha(x, y) >= HIT_ALPHA);
        },
    };
}
