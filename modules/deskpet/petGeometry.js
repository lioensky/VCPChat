// modules/deskpet/petGeometry.js
// 桌宠窗口的位置和大小算在这里：按缩放和长宽比算窗口尺寸、没记过位置时站哪、
// 记下的位置还在不在屏上、以及统一的写回窗口矩形。

const petPrefs = require('./petPrefs');
const { hasSavedPosition } = require('./petState');

/**
 * 窗口大小随每个桌宠自己的缩放和形象的长宽比走（modules/deskpet/petPrefs.js）；不知道比例时 1 倍是 360×580，
 * 上方留出气泡和输入框的位置。
 */
function createPetGeometry(ctx) {
    const { pets } = ctx;
    const { screen } = ctx.electron;

    function sizeOf(pet) {
        return petPrefs.windowSizeForScale(pet.scale, pet.aspect, pet.kind);
    }

    // 没有记下位置的桌宠从屏幕右下角往左排：已经有桌宠站着的地方让开（窗口两边是透明的，按中间那段人物算），
    // 不然几个桌宠叠在同一个角落，后开的把前面的整个挡住。index 是第几个位置（显示器变了、要挪回来时用）。
    function defaultPosition(index, size, { avoid = [] } = {}) {
        const area = screen.getPrimaryDisplay().workArea;
        const step = Math.max(40, Math.round(size.width * 0.55));
        const xAt = (slot) => Math.max(area.x, area.x + area.width - size.width - 24 - slot * step);
        const middle = (x, width) => [x + width * 0.25, x + width * 0.75];
        const taken = (x) => avoid.some((b) => {
            const [a1, a2] = middle(x, size.width);
            const [b1, b2] = middle(b.x, b.width);
            return a1 < b2 && b1 < a2;
        });
        let slot = index;
        for (let i = 0; i < 12 && taken(xAt(slot)); i += 1) slot += 1;
        return { x: xAt(slot), y: area.y + area.height - size.height };
    }

    function isOnScreen(x, y, size) {
        return screen.getAllDisplays().some(({ workArea: a }) =>
            x + size.width > a.x && x < a.x + a.width && y + 40 > a.y && y < a.y + a.height);
    }

    function workAreaAt(bounds) {
        try {
            return (screen.getDisplayMatching?.(bounds) || screen.getPrimaryDisplay()).workArea;
        } catch {
            return screen.getPrimaryDisplay().workArea;
        }
    }

    function initialBounds(saved, size) {
        const others = [...pets.values()].filter((p) => !p.win.isDestroyed()).map((p) => p.win.getBounds());
        const fallback = defaultPosition(0, size, { avoid: others });
        if (!hasSavedPosition(saved)) return { ...size, ...fallback };
        // 位置不在任何显示器上（拔了外接屏）就回到默认位置。
        if (!isOnScreen(saved.x, saved.y, size)) return { ...size, ...fallback };
        // 上次藏在屏幕边里：窗口本来就有一大截在屏外，原样放回（openPet 接着按藏边处理）
        const tucked = saved.tuck?.tucked;
        if (tucked && tucked.x === saved.x && tucked.y === saved.y) return { ...size, x: saved.x, y: saved.y };
        // 在那块屏上放不全（换了分辨率、上次在更大的屏上）：整个挪回屏里。
        // 底边留出脚下那截透明的余量：贴着任务栏、甩下去落地的桌宠窗口本来就比工作区低一点，重开不能悬空
        const area = workAreaAt({ x: saved.x, y: saved.y, ...size });
        return {
            ...size,
            x: Math.min(Math.max(saved.x, area.x), area.x + area.width - size.width),
            y: Math.min(Math.max(saved.y, area.y), area.y + area.height - size.height + petPrefs.FOOT_RESERVE),
        };
    }

    // 窗口位置和大小都从这里设。宽高总用算出来的值，不把 getBounds() 读回来的再写回去：
    // Windows 在 125%/150% 缩放下读回来的宽高可能多了一两个像素，写回去就会越变越大。
    function applyBounds(pet, bounds, { verify = true } = {}) {
        if (pet.win.isDestroyed()) return;
        pet.win.setBounds(bounds);
        if (!verify) return;
        const got = pet.win.getBounds();
        if (got.width === bounds.width && got.height === bounds.height) return;
        // 不可调整大小的窗口在部分缩放比例下 setBounds 改不动尺寸，临时放开再设一次
        pet.win.setResizable?.(true);
        pet.win.setBounds(bounds);
        pet.win.setResizable?.(false);
    }

    // 那条边外面还有没有屏幕（扩展屏中间那条边不能藏：藏进去的半个身子会露在另一块屏上）
    function isOuterEdge(area, side, y) {
        const x = side === 'left' ? area.x - 2 : area.x + area.width + 2;
        try {
            return !screen.getAllDisplays().some((d) => {
                const b = d.bounds || d.workArea;
                return b && x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
            });
        } catch {
            return true;
        }
    }

    return { sizeOf, defaultPosition, isOnScreen, workAreaAt, initialBounds, applyBounds, isOuterEdge };
}

module.exports = { createPetGeometry };
