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

/**
 * 菜单里的方向键：上下循环、Home / End 到头尾；焦点不在菜单项上时，下键到第一项、上键到最后一项。
 * 处理了返回 true（已 preventDefault），不是这几个键或没有可用项时返回 false。
 */
export function moveMenuFocus(event, items) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !items.length) return false;
    event.preventDefault();
    const current = items.indexOf(items[0]?.ownerDocument?.activeElement);
    let next = 0;
    if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
    else if (event.key === 'ArrowUp') next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    items[next].focus();
    return true;
}
