import { measureSilhouette, silhouetteAspect, fitSilhouette } from './figure.js';
import { TOP_RESERVE, FOOT_RESERVE, HIT_ALPHA } from './petStage.js';
import { CELL, SPRITE_ROWS, animationCell, lookCell, spriteFps, spriteState } from './spriteAnimation.js';

// Canvas2D keeps sprite pets independent of Cubism Core and WebGL availability.
export async function createSpriteBackend(assets, env) {
    const image = new Image();
    image.src = assets.sprite.sheetUrl;
    await image.decode();
    const version = assets.sprite.version;
    if (image.naturalWidth !== 1536 || image.naturalHeight !== (version === 2 ? 2288 : 1872)) throw new Error('精灵图尺寸与版本不一致');
    const atlas = document.createElement('canvas');
    atlas.width = image.naturalWidth;
    atlas.height = image.naturalHeight;
    const atlasContext = atlas.getContext('2d', { willReadFrequently: true });
    atlasContext.drawImage(image, 0, 0);
    const atlasWidth = atlas.width;
    let alpha = new Uint8Array(atlas.width * atlas.height);
    {
        const pixels = atlasContext.getImageData(0, 0, atlas.width, atlas.height).data;
        for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
    }
    const first = atlasContext.getImageData(0, 0, CELL.width, CELL.height);
    const idle = measureSilhouette(first.data, CELL.width, CELL.height);
    if (!idle) throw new Error('精灵图的待机帧是空的');
    // One transform for all poses: jumping must lift off the ground without resizing every frame.
    const box = { left: CELL.width, right: 0, top: CELL.height, bottom: 0 };
    const rows = [...Object.values(SPRITE_ROWS), ...(version === 2 ? [[9, 8], [10, 8]] : [])];
    for (const [row, frames] of rows) {
        for (let column = 0; column < frames; column++) {
            const data = atlasContext.getImageData(column * CELL.width, row * CELL.height, CELL.width, CELL.height);
            const b = measureSilhouette(data.data, CELL.width, CELL.height);
            if (!b) throw new Error(`精灵图第 ${row + 1} 行第 ${column + 1} 帧是空的`);
            box.left = Math.min(box.left, b.left);
            box.right = Math.max(box.right, b.right);
            box.top = Math.min(box.top, b.top);
            box.bottom = Math.max(box.bottom, b.bottom);
        }
    }
    // 命中只需要 alpha 通道；测完轮廓立即释放整张临时画布，避免长期保留两份 RGBA 图集。
    atlas.width = atlas.height = 0;
    const hitMaskBytes = alpha.length;
    const canvas = env.canvas;
    const context = canvas.getContext('2d');
    let fit, timer = 0, paused = false, disposed = false, frame = {}, action = '', actionUntil = 0;
    let held = false, velocity = 0, velocityAt = 0, phase = 'awake', level = 'idle', speed = 'normal', fps = spriteFps(level), state = '', stateAt = 0;
    let gaze = { x: 0, y: 0 }, gazeAt = 0, cell = { row: 0, column: 0 }, lastKey = '';
    canvas.hidden = false;
    const layout = () => {
        const resolution = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(window.innerWidth * resolution);
        canvas.height = Math.round(window.innerHeight * resolution);
        context.setTransform(resolution, 0, 0, resolution, 0, 0);
        fit = fitSilhouette(box, { width: window.innerWidth, height: window.innerHeight, topReserve: TOP_RESERVE, bottomReserve: FOOT_RESERVE });
        lastKey = '';
    };
    const draw = () => {
        const now = performance.now();
        const next = spriteState({ frame, approval: env.activity?.().approval, held, velocity: now - velocityAt < 160 ? velocity : 0,
            walk: env.activity?.().walk, action: now < actionUntil ? action : '', sleeping: phase === 'asleep' });
        if (next !== state) { state = next; stateAt = now; }
        const look = state === 'idle' && phase === 'awake' && now - gazeAt < 1300 ? lookCell(gaze.x, gaze.y, version) : null;
        cell = look || animationCell(state, now - stateAt, phase === 'asleep' ? spriteFps('sleep', speed) : fps);
        const key = `${cell.row}:${cell.column}`;
        if (key === lastKey) return;
        lastKey = key;
        context.clearRect(0, 0, window.innerWidth, window.innerHeight);
        context.drawImage(image, cell.column * CELL.width, cell.row * CELL.height, CELL.width, CELL.height,
            fit.x, fit.y, CELL.width * fit.scale, CELL.height * fit.scale);
        canvas.dataset.spriteState = state;
        canvas.dataset.spriteCell = key;
    };
    const tick = () => {
        timer = 0;
        if (paused || disposed) return;
        draw();
        timer = setTimeout(tick, 1000 / (phase === 'asleep' ? spriteFps('sleep', speed) : fps));
    };
    const restart = () => { clearTimeout(timer); if (!paused && !disposed) tick(); };
    const resize = () => { layout(); draw(); };
    const act = (name, ms = 1500) => {
        action = ({ greeting: 'waving', wave: 'waving', headTap: 'jumping', cheer: 'jumping', startle: 'failed',
            bow: 'review', stretch: 'jumping', wink: 'waving', disagree: 'failed', dizzy: 'failed' })[name] || (SPRITE_ROWS[name] ? name : 'waving');
        actionUntil = performance.now() + Math.max(500, ms);
        state = '';
        restart();
    };
    layout();
    tick();
    window.addEventListener('resize', resize);
    const bounds = () => ({ x: fit.x + box.left * fit.scale, y: fit.y + box.top * fit.scale,
        width: (box.right - box.left) * fit.scale, height: (box.bottom - box.top) * fit.scale });
    const head = () => ({ x: fit.x + idle.head.x * fit.scale, y: fit.y + idle.head.y * fit.scale, width: idle.head.width * fit.scale });
    const setGaze = g => { if (g && Number.isFinite(g.x) && Number.isFinite(g.y)) { gaze = g; gazeAt = performance.now(); } };
    return {
        kind: 'sprite', bounds, head, figureReady: Promise.resolve(silhouetteAspect(box)),
        probe(x, y) {
            if (disposed) return;
            const u = Math.floor((x - fit.x) / fit.scale), v = Math.floor((y - fit.y) / fit.scale);
            const hit = u >= 0 && u < CELL.width && v >= 0 && v < CELL.height
                && alpha[(cell.row * CELL.height + v) * atlasWidth + cell.column * CELL.width + u] >= HIT_ALPHA;
            env.onHit(Boolean(hit));
        },
        focus(x, y) { const h = head(); setGaze({ x: (x - h.x) / (window.innerWidth * 0.5), y: (h.y - y) / (window.innerHeight * 0.5) }); },
        apply(next) {
            if (['thinking', 'tool'].includes(frame.state) && !next.state) act('review', 1800);
            frame = next;
            restart();
        },
        tap() { act('jumping', 1100); },
        canShow: () => true,
        setMouth() {},
        setActive(value) { level = value; fps = spriteFps(level, speed); restart(); },
        setSpeed(value) { speed = value; fps = spriteFps(level, speed); restart(); },
        setPaused(value) { paused = Boolean(value); restart(); },
        life: {
            phase(value) { phase = value; restart(); }, act,
            held(value) { held = Boolean(value); velocity = 0; restart(); },
            dragVelocity(value) { velocity = value; velocityAt = performance.now(); },
            gaze: setGaze,
        },
        destroy() { disposed = true; clearTimeout(timer); window.removeEventListener('resize', resize); alpha = null; image.src = ''; canvas.width = canvas.height = 0; },
        info: { renderer: 'canvas2d', version, states: 9, lookDirections: version === 2 ? 16 : 0, hitMaskBytes },
    };
}
