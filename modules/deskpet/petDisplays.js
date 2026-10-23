// modules/deskpet/petDisplays.js
// 屏幕那边变了的时候：拔外接屏、改分辨率或缩放后把桌宠摆回屏里，
// 以及别的程序全屏时让位（藏起来、退出全屏再放出来）。

const petPrefs = require('./petPrefs');
const { createFullscreenWatch } = require('./fullscreenWatch');

const DISPLAY_SETTLE_MS = 400;

function createPetDisplays(ctx) {
    const { pets } = ctx;
    const { screen } = ctx.electron;

    // 拔掉外接屏、改分辨率或缩放之后：不在任何屏上的桌宠挪回主屏，被系统改掉的窗口尺寸改回来，
    // 新屏放不下的大小缩到放得下。
    function fitPetsToDisplays() {
        const { geometry, motion, sizing } = ctx;
        let index = 0;
        for (const pet of pets.values()) {
            if (pet.win.isDestroyed() || pet.drag) continue;
            const b = pet.win.getBounds();
            const area = geometry.workAreaAt(b);
            const previous = { ...b, ...geometry.sizeOf(pet) };
            const fitted = petPrefs.fitScale(pet.scale, area, pet.aspect, pet.kind);
            const scaleChanged = fitted !== pet.scale;
            pet.scale = fitted;
            const size = geometry.sizeOf(pet);
            const onScreen = geometry.isOnScreen(b.x, b.y, size);
            // 缩小了：脚底对齐、整个挪回这块屏里；没缩只是不在屏上：回默认位置
            const next = scaleChanged ? petPrefs.resizeAnchored(previous, size, area)
                : onScreen ? { x: b.x, y: b.y } : geometry.defaultPosition(index, size);
            if (scaleChanged || !onScreen || b.width !== size.width || b.height !== size.height) {
                if (scaleChanged || !onScreen) motion.untuck(pet);
                geometry.applyBounds(pet, { ...next, ...size });
                if (scaleChanged || !onScreen) ctx.savePetState(pet.agentId, { x: next.x, y: next.y, tuck: null, ...(scaleChanged ? { scale: fitted } : {}) });
            }
            if (scaleChanged) {
                sizing.resetShape(pet);
                sizing.sendPrefs(pet);
            }
            index += 1;
        }
    }

    let displayTimer = null;
    function onDisplaysChanged() {
        // 改缩放、远程桌面重连时这些事件会连发，等它们停下来再处理。
        clearTimeout(displayTimer);
        displayTimer = setTimeout(() => {
            displayTimer = null;
            try { fitPetsToDisplays(); for (const pet of pets.values()) ctx.windows.reassertTopmost(pet); } catch (error) { console.warn('[DeskPet] display change:', error.message); }
        }, DISPLAY_SETTLE_MS);
    }

    // ---- 全屏让位（modules/deskpet/fullscreenWatch.js）---------------------------------
    // 别的程序在某块屏上全屏时，那块屏上露着的桌宠先藏起来（记作 yielded），退出全屏再放出来。
    // 只在进出全屏的那一下动手：全屏期间用户自己把桌宠叫出来就留着，自己藏起来的也不会被放回来。

    let fullscreenWatch = null;
    function updateFullscreenWatch() {
        if (!fullscreenWatch) return;
        const settings = ctx.controls?.get() || petPrefs.DEFAULT_SETTINGS;
        if (settings.yieldToFullscreen && pets.size > 0 && !ctx.shuttingDown) fullscreenWatch.start();
        else fullscreenWatch.stop();
    }

    /** 全屏的那块屏（DIP）上有没有这个桌宠；只有一块屏时都算。 */
    function onFullscreenDisplay(pet, area) {
        const displays = screen.getAllDisplays();
        if (displays.length <= 1) return true;
        return screen.getDisplayMatching(area).id === screen.getDisplayMatching(pet.win.getBounds()).id;
    }

    function applyFullscreen(state) {
        let area = null;
        if (state?.fullscreen && state.rect) {
            // 脚本报的是物理像素；只有 Windows 有 screenToDipRect，也只有 Windows 会报
            area = typeof screen.screenToDipRect === 'function' ? screen.screenToDipRect(null, state.rect) : state.rect;
        }
        for (const pet of pets.values()) {
            if (pet.win.isDestroyed()) continue;
            if (area && onFullscreenDisplay(pet, area)) {
                if (!pet.win.isVisible() || pet.drag || pet.interactive) continue;
                pet.yielded = true;
                pet.win.hide();
            } else if (pet.yielded) {
                ctx.windows.showPet(pet);
            }
        }
        ctx.refreshTray();
    }

    return {
        fitPetsToDisplays,
        onDisplaysChanged,
        applyFullscreen,
        updateFullscreenWatch,
        /** 初始化时建起全屏监视；真正开不开由设置和桌宠数量决定（updateFullscreenWatch）。 */
        initFullscreenWatch() {
            fullscreenWatch = createFullscreenWatch({ onChange: applyFullscreen });
        },
        /** 退出：停掉去抖和全屏监视。 */
        stop() {
            clearTimeout(displayTimer);
            fullscreenWatch?.stop();
        },
    };
}

module.exports = { createPetDisplays };
