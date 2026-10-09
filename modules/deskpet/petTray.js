// modules/deskpet/petTray.js
// 托盘菜单「桌宠」那一项怎么少折腾：托盘菜单每换一次，Electron 都会留着换下来的旧菜单
// （Linux 上实测，换多少次留多少份；同一份菜单再设一次不会）。
// 所以内容没变不动；只是勾选、可用、显示变了就改现有菜单（applyTrayState）；只有文字、快捷键这些变了才重建。

'use strict';

const TRAY_STATE_FIELDS = ['checked', 'enabled', 'visible'];

function trayMenuKey(items, { stateOnly = false } = {}) {
    return JSON.stringify(items, (key, value) => {
        if (typeof value === 'function') return undefined;
        if (stateOnly && TRAY_STATE_FIELDS.includes(key)) return undefined;
        return value;
    });
}

function trayStateItems(items, out = []) {
    for (const item of items) {
        if (item.id) out.push(item);
        if (Array.isArray(item.submenu)) trayStateItems(item.submenu, out);
    }
    return out;
}

/** 把 items 里带 id 那几项的勾选、可用、显示写进已经建好的菜单；少了哪一项返回 false（要重建）。 */
function applyTrayState(menu, items) {
    const stateful = trayStateItems(items);
    const targets = stateful.map((item) => menu?.getMenuItemById?.(item.id));
    if (targets.some((target) => !target)) return false;
    stateful.forEach((item, index) => {
        for (const field of TRAY_STATE_FIELDS) if (field in item) targets[index][field] = item[field];
    });
    return true;
}

/** rebuild(structureChanged)：structureChanged 为 false 时只是状态变了，可以用 applyTrayState 改现有菜单。 */
function refreshWhenChanged(currentItems, rebuild) {
    let shown = null;
    let shape = null;
    return () => {
        const items = currentItems();
        const key = trayMenuKey(items);
        if (key === shown) return;
        const nextShape = trayMenuKey(items, { stateOnly: true });
        const structureChanged = nextShape !== shape;
        shown = key;
        shape = nextShape;
        rebuild(structureChanged);
    };
}

module.exports = { applyTrayState, refreshWhenChanged, trayMenuKey };
