// modules/deskpet/petMotion.js
// 桌宠在桌面上怎么动：跟着光标拖、松手甩出去、贴边、藏进屏幕边里再探出来、沿任务栏溜达。
// 窗口一帧一帧地挪都走这里的 playFrames。

const edgeSnap = require('./edgeSnap');
const throwMotion = require('./throwMotion');
const wander = require('./wander');

const DRAG_TICK_MS = 16;
const DRAG_MAX_MS = 60000;
// 藏在边里的桌宠：鼠标停在露出来的那条上、气泡或输入框开着时整只探出来；都没了等一会儿再缩回去。
const TUCK_BACK_MS = 1200;

function createPetMotion(ctx) {
    const { screen } = ctx.electron;

    // 混合 DPI 多屏之间 setPosition 可能顺带改尺寸，统一用 setBounds 固定宽高。
    function moveWithCursor(pet, drag) {
        const c = screen.getCursorScreenPoint();
        // 记最近几个光标位置：松手时按它算甩出去的速度
        // 光标没动就不记：停稳了再松手时最后一个样本是旧的，才认得出「不是甩」
        const samples = drag.samples || (drag.samples = []);
        const last = samples[samples.length - 1];
        if (!last || last.x !== c.x || last.y !== c.y) samples.push({ t: Date.now(), x: c.x, y: c.y });
        if (samples.length > 12) samples.shift();
        ctx.geometry.applyBounds(pet, { x: Math.round(c.x - drag.dx), y: Math.round(c.y - drag.dy), ...ctx.geometry.sizeOf(pet) }, { verify: false });
    }

    // 一帧一帧挪窗口（甩出去、滑过去、溜达共用）：窗口没了、被拎起来或 halted() 时 stop()；
    // 走完最后一帧先 stop() 再 done(最后一帧)
    function playFrames(pet, frames, { stop, halted = () => false, done }) {
        const size = ctx.geometry.sizeOf(pet);
        return setInterval(() => {
            const next = frames.shift();
            if (!next || pet.win.isDestroyed() || pet.drag || halted()) {
                stop();
                return;
            }
            ctx.geometry.applyBounds(pet, { ...next, ...size }, { verify: false });
            if (!frames.length) {
                stop();
                done?.(next);
            }
        }, DRAG_TICK_MS);
    }

    // 甩出去（modules/deskpet/throwMotion.js）：松手时光标还在快速移动就带着速度滑出去、落到任务栏上，
    // 落地时页面演一下「落地」。按着 Alt 松手、慢慢放下的不甩。
    function throwPet(pet, figure, samples) {
        const win = pet.win.getBounds();
        const frames = throwMotion.throwPath(win, figure, ctx.geometry.workAreaAt(win), throwMotion.releaseVelocity(samples, Date.now()), DRAG_TICK_MS);
        if (!frames) return false;
        stopSnap(pet);
        pet.snap = playFrames(pet, frames, {
            stop: () => stopSnap(pet),
            done: (last) => {
                // 甩走了就不再藏在边里（拿起来时 pet.tuck 已清，这里把存下的也清掉）
                ctx.savePetState(pet.agentId, { x: last.x, y: last.y, tuck: null }).catch(() => {});
                pet.win.webContents.send('deskpet:landed');
            },
        });
        return true;
    }

    // 贴边（modules/deskpet/edgeSnap.js）：松手时角色离屏幕左右边或任务栏很近，就滑过去贴齐。
    // figure 是页面报的角色包围盒（窗口内坐标）；free 是按着 Alt 松手，不吸。
    function stopSnap(pet) {
        clearInterval(pet.snap);
        pet.snap = null;
    }

    // 窗口滑到 to（几帧，先快后慢）；滑完 done
    function slideTo(pet, to, done) {
        stopSnap(pet);
        const win = pet.win.getBounds();
        if (to.x === win.x && to.y === win.y) {
            done?.();
            return;
        }
        pet.snap = playFrames(pet, edgeSnap.snapFrames(win, to), { stop: () => stopSnap(pet), done: () => done?.() });
    }

    function snapToEdge(pet, figure, { free = false } = {}) {
        stopSnap(pet);
        pet.tuck = null;
        if (free || pet.win.isDestroyed()) return false;
        const win = pet.win.getBounds();
        const area = ctx.geometry.workAreaAt(win);
        // 拖出去一大截：收进边里只露一条，鼠标过来、有话说时探出来（见 setWantOut）
        const tuck = figure && edgeSnap.tuckPosition(win, figure, area, (side, y) => ctx.geometry.isOuterEdge(area, side, y));
        if (tuck) {
            pet.tuck = { side: tuck.side, tucked: tuck.tucked, outPos: tuck.out, isOut: false };
            slideTo(pet, tuck.tucked, () => ctx.savePetState(pet.agentId, {
                x: tuck.tucked.x, y: tuck.tucked.y, tuck: { side: tuck.side, tucked: tuck.tucked, outPos: tuck.out },
            }).catch(() => {}));
            return true;
        }
        ctx.savePetState(pet.agentId, { tuck: null }).catch(() => {});
        const inside = figure && figure.x >= -1 && figure.y >= -1
            && figure.x + figure.width <= win.width + 1 && figure.y + figure.height <= win.height + 1;
        if (!inside) return false;
        const target = edgeSnap.snapPosition(win, figure, area);
        if (!target || (target.x === win.x && target.y === win.y)) return false;
        slideTo(pet, target, () => ctx.savePetPosition(pet.agentId, [target.x, target.y]).catch(() => {}));
        return true;
    }

    // 大小变了、换了屏：窗口整个挪回屏里，藏边作废
    function untuck(pet) {
        clearTimeout(pet.tuckTimer);
        pet.tuck = null;
        // 正在滑、甩、溜达的也停下：它们的下一帧还按旧位置、旧屏走
        stopSnap(pet);
        stopWalk(pet, { save: false });
    }

    function setWantOut(pet, want) {
        const tuck = pet.tuck;
        if (!tuck || pet.drag || pet.win.isDestroyed()) return;
        clearTimeout(pet.tuckTimer);
        if (want) {
            if (!tuck.isOut) {
                tuck.isOut = true;
                slideTo(pet, tuck.outPos);
            }
        } else if (tuck.isOut) {
            pet.tuckTimer = setTimeout(() => {
                if (pet.tuck !== tuck || pet.drag || pet.win.isDestroyed()) return;
                tuck.isOut = false;
                slideTo(pet, tuck.tucked);
            }, TUCK_BACK_MS);
        }
    }

    // 溜达（modules/deskpet/wander.js）：页面闲了一阵来问，主进程沿任务栏慢慢挪窗口；
    // 鼠标碰到角色、拖动、说话、藏起来都会停在原地。
    function stopWalk(pet, { save = true } = {}) {
        if (!pet.walk) return;
        clearInterval(pet.walk);
        pet.walk = null;
        if (pet.win.isDestroyed()) return;
        pet.win.webContents.send('deskpet:walk', { dir: null });
        if (save) ctx.savePetPosition(pet.agentId, pet.win.getPosition()).catch(() => {});
    }

    function startWalk(pet, figure) {
        if (ctx.controls?.get().wander !== true || pet.walk || pet.drag || pet.snap || pet.tuck || pet.interactive) return false;
        if (pet.win.isDestroyed() || !pet.win.isVisible()) return false;
        const win = pet.win.getBounds();
        const target = wander.wanderTarget(win, figure, ctx.geometry.workAreaAt(win));
        if (!target) return false;
        pet.win.webContents.send('deskpet:walk', { dir: target.dir });
        pet.walk = playFrames(pet, wander.walkFrames(win, target, DRAG_TICK_MS), { stop: () => stopWalk(pet), halted: () => !pet.win.isVisible() });
        return true;
    }

    function stopDrag(pet, { save = false } = {}) {
        if (!pet.drag) return;
        clearInterval(pet.drag.timer);
        pet.drag = null;
        if (save && !pet.win.isDestroyed()) ctx.savePetPosition(pet.agentId, pet.win.getPosition()).catch(() => {});
    }

    // 拖动在主进程里跟随光标，不用 -webkit-app-region：它在 Windows 上会吞点击，
    // 也没法和按像素穿透同时用。origin 是按下那一刻的屏幕坐标。
    function startDrag(pet, origin) {
        if (pet.win.isDestroyed() || pet.ignoringMouse === 'through') return;
        // 上一次拖动的 pointerup 丢了（触屏 pointercancel、拖动中弹出菜单）时还会再来一次 drag-start；
        // 先收掉旧的定时器，否则它会一直跟着光标，drag-end 之后还会每帧抛异常。
        stopDrag(pet);
        stopSnap(pet);
        // 拿起来了：藏边的状态作废，松手时重新算
        clearTimeout(pet.tuckTimer);
        pet.tuck = null;
        stopWalk(pet, { save: false });
        const [wx, wy] = pet.win.getPosition();
        const { width, height } = pet.win.getBounds();
        const local = origin?.local;
        const validLocal = local && Number.isFinite(local.x) && Number.isFinite(local.y)
            && local.x >= 0 && local.y >= 0 && local.x <= width && local.y <= height;
        // 页面内坐标与窗口同为 DIP，避免多屏缩放时 Chromium 的 screenX/Y 与原生屏幕坐标不一致。
        const p = validLocal ? { x: wx + local.x, y: wy + local.y }
            : origin && Number.isFinite(origin.x) && Number.isFinite(origin.y) ? origin : screen.getCursorScreenPoint();
        const drag = { dx: p.x - wx, dy: p.y - wy, timer: null, startedAt: Date.now() };
        drag.timer = setInterval(() => {
            if (pet.win.isDestroyed() || pet.drag !== drag) {
                clearInterval(drag.timer);
                return;
            }
            // 兜底：页面再也没发 drag-end（渲染进程卡死），不让窗口永远粘在光标上。
            if (Date.now() - drag.startedAt > DRAG_MAX_MS) {
                stopDrag(pet, { save: true });
                return;
            }
            moveWithCursor(pet, drag);
        }, DRAG_TICK_MS);
        pet.drag = drag;
        ctx.windows.setIgnoreMouse(pet, false);
        moveWithCursor(pet, drag);
    }

    function endDrag(pet, report) {
        if (!pet.drag || pet.win.isDestroyed()) return;
        moveWithCursor(pet, pet.drag);
        const samples = pet.drag.samples;
        stopDrag(pet, { save: true });
        const figure = ctx.figureFrom(report);
        const free = report?.free === true;
        // 拖出屏幕边一大截松手是想藏起来，不当成甩
        const win = pet.win.getBounds();
        const { workAreaAt, isOuterEdge } = ctx.geometry;
        const tucking = figure && edgeSnap.tuckPosition(win, figure, workAreaAt(win), (side, y) => isOuterEdge(workAreaAt(win), side, y));
        if (!free && figure && !tucking && throwPet(pet, figure, samples)) return;
        snapToEdge(pet, figure, { free });
    }

    return {
        moveWithCursor,
        playFrames,
        throwPet,
        stopSnap,
        slideTo,
        snapToEdge,
        untuck,
        setWantOut,
        stopWalk,
        startWalk,
        stopDrag,
        startDrag,
        endDrag,
    };
}

module.exports = { createPetMotion };
