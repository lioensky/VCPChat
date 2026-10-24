// 固定覆盖收起横条、展开胶囊及动画经过的范围（CSS 像素，不能再乘 DPR）。
// 收起时也盖住胶囊按钮会出现的那一块：光标直接回到按钮的位置（中途出过窗口、停得久了胶囊已经收起），
// 胶囊照样冒出来，点下去不会穿到桌面上。只多算会话列表那段更宽的空白。
export function dockHitArea(width, height, { collapsed = false, sessions = true } = {}) {
    const w = Math.min(collapsed || !sessions ? 95 : 134, Math.max(0, width - 24));
    const y = Math.max(0, height - 54);
    return { x: (width - w) / 2, y, width: w, height: Math.min(54, height - y) };
}

export function containsPoint(rect, x, y) {
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}
