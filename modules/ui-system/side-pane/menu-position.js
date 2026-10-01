/**
 * 在指针位置弹出的菜单：贴着指针摆放，碰到窗口边缘时往回收。
 * 坐标只能在运行时量出来，所以这里是唯一直接写定位样式的地方。
 */
export function placeMenuAt(menu, x, y, win = menu?.ownerDocument?.defaultView, margin = 4) {
    if (!menu) return;
    const width = menu.offsetWidth || 224;
    const height = menu.offsetHeight || 110;
    const viewportWidth = win?.innerWidth || 1000;
    const viewportHeight = win?.innerHeight || 800;
    menu.style.left = `${Math.round(Math.max(margin, Math.min(x, viewportWidth - width - margin)))}px`;
    menu.style.top = `${Math.round(Math.max(margin, Math.min(y, viewportHeight - height - margin)))}px`;
}
