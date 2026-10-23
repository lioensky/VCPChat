// 点击、双击和拖动只负责指针生命周期；窗口移动交给主进程，表情反应由调用方提供。
export function bindPointer({ api, onTap, onDoubleTap, onTapDown, onDrag, afterDrag, figureBounds, onActivity, doubleTapMs = 300, target = window }) {
    const listeners = [];
    const listen = (name, fn, options) => { target.addEventListener(name, fn, options); listeners.push(() => target.removeEventListener(name, fn, options)); };
    let down = null;
    let lastTap = 0;
    let lastUp = 0;
    let pairGap = Infinity; // 双击第一下离再前一下有多久：隔了一会儿才双击，是真想打开输入框，不是在连点
    let tapTimer = 0;
    listen('pointerdown', (e) => {
        api.touched?.();
        if (e.button !== 0 || e.target?.closest?.('.pet-ui')) return;
        // 上一次按下没收到 pointerup（被菜单、切窗口打断）时，先把它的拖动收尾（窗口和被拎着的姿势都放下）。
        if (down?.dragging) {
            afterDrag();
            api.dragEnd();
            onDrag('end');
        }
        down = { x: e.screenX, y: e.screenY, dragging: false, cx: e.clientX, cy: e.clientY };
        // 捕获指针：窗口跟着光标移动时 pointerup 也一定回到这里。
        try { e.target?.setPointerCapture?.(e.pointerId); } catch { /* 指针已经没了 */ }
    });
    listen('pointermove', (e) => {
        onActivity?.();
        if (!down) return;
        if (down.dragging) {
            onDrag('move', e);
            return;
        }
        if (Math.hypot(e.screenX - down.x, e.screenY - down.y) > 3) {
            down.dragging = true;
            api.dragStart({ x: down.x, y: down.y, local: { x: down.cx, y: down.cy } });
            onDrag('start', e);
        }
    });
    listen('pointerup', (e) => {
        if (!down) return;
        const at = { x: down.cx, y: down.cy };
        if (down.dragging) {
            // 松手的地方离屏幕边、任务栏很近时主进程会贴过去；按着 Alt 不贴
            afterDrag();
            api.dragEnd({ figure: figureBounds(), free: e.altKey });
            onDrag('end');
            down = null;
            return;
        }
        // 每一下都先报去数连点，再分单击、双击
        onTapDown(at);
        const upAt = Date.now();
        const gap = upAt - lastUp;
        lastUp = upAt;
        if (upAt - lastTap < doubleTapMs) {
            // 双击只打开输入框，不先做一遍单击的开心动作
            clearTimeout(tapTimer);
            lastTap = 0;
            onDoubleTap({ afterPause: pairGap >= doubleTapMs });
        } else {
            pairGap = gap;
            lastTap = upAt;
            clearTimeout(tapTimer);
            tapTimer = setTimeout(() => onTap(at), doubleTapMs);
        }
        down = null;
    });
    // 触屏手势被系统接管（pointercancel）、拖到一半切走窗口时收不到 pointerup，拖动必须在这里结束。
    const abort = () => {
        if (down?.dragging) {
            afterDrag();
            api.dragEnd();
            onDrag('end');
        }
        down = null;
    };
    listen('pointercancel', abort);
    listen('lostpointercapture', abort);
    listen('blur', abort);
    // Ctrl（macOS 上 Cmd）+ 滚轮调大小；气泡上的滚轮留给翻看回复
    listen('wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.target?.closest?.('.pet-ui')) return;
        e.preventDefault();
        const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
        api.wheelResize?.(px);
    }, { passive: false });
    listen('contextmenu', (e) => {
        if (e.target?.closest?.('#composer')) return; // 输入框里保留系统的复制粘贴菜单
        e.preventDefault();
        abort(); // 菜单会拿走指针，拖到一半右键也要先停下
        api.openContextMenu();
    });
    return { dispose() { abort(); clearTimeout(tapTimer); for (const remove of listeners.splice(0)) remove(); } };
}
