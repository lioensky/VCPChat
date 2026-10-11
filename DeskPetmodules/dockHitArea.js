// 固定覆盖收起横条、展开胶囊及动画经过的范围（CSS 像素，不能再乘 DPR）。
export function dockHitArea(width, height) {
    const w = Math.min(140, Math.max(0, width - 24));
    return { x: (width - w) / 2, y: Math.max(0, height - 54), width: w, height: Math.min(54, height) };
}

export function containsPoint(rect, x, y) {
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}
