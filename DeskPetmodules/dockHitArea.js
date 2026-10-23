// 固定覆盖收起横条、展开胶囊及动画经过的范围（CSS 像素，不能再乘 DPR）。
export function dockHitArea(width, height, { collapsed = false } = {}) {
    const w = Math.min(collapsed ? 56 : 140, Math.max(0, width - 24));
    const y = Math.max(0, height - 54);
    return { x: (width - w) / 2, y, width: w, height: Math.min(collapsed ? 28 : 54, height - y) };
}

export function containsPoint(rect, x, y) {
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}
