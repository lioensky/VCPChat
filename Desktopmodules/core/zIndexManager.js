/**
 * VCPdesktop - Z-Index 层级管理模块
 * 负责：挂件层级排序、置顶、置底、上移/下移一层
 *
 * 层级规则：
 *   z-index 1~4   : 置底区域（低于桌面图标）
 *   z-index 5      : 桌面快捷方式图标层级（由 CSS 定义）
 *   z-index 10+    : 普通挂件层级（在图标之上）
 */

'use strict';

(function () {
    const { state } = window.VCPDesktop;

    // 桌面图标的基准 z-index（与 CSS 中 .desktop-shortcut-icon 的 z-index 一致）
    const DESKTOP_ICON_Z = 5;

    /**
     * 将挂件提升到最前（所有挂件之上）
     * @param {string} widgetId
     */
    function bringToFront(widgetId) {
        // 锁定状态下禁止改变层级
        if (state.desktopLocked) return;
        const widgetData = state.widgets.get(widgetId);
        if (!widgetData) return;
        const newZ = state.nextZIndex++;
        widgetData.zIndex = newZ;
        widgetData.element.style.zIndex = newZ;
    }

    /**
     * 将挂件发送到最底（低于桌面图标）
     * @param {string} widgetId
     */
    function sendToBack(widgetId) {
        // 锁定状态下禁止改变层级
        if (state.desktopLocked) return;
        const widgetData = state.widgets.get(widgetId);
        if (!widgetData) return;

        // 找到当前所有在图标层级以下的 widget 的最小 z-index
        let minBelowIcon = Infinity;
        state.widgets.forEach((wd, id) => {
            if (id !== widgetId && wd.zIndex < DESKTOP_ICON_Z) {
                if (wd.zIndex < minBelowIcon) minBelowIcon = wd.zIndex;
            }
        });

        // 设置为低于图标层级的最小值
        const newZ = minBelowIcon < Infinity ? Math.max(1, minBelowIcon - 1) : DESKTOP_ICON_Z - 2;
        widgetData.zIndex = newZ;
        widgetData.element.style.zIndex = newZ;
    }

    /**
     * 上移一层：与上方最近的挂件交换 z-index
     * @param {string} widgetId
     */
    function moveUp(widgetId) {
        // 锁定状态下禁止改变层级
        if (state.desktopLocked) return;
        const widgetData = state.widgets.get(widgetId);
        if (!widgetData) return;

        const currentZ = widgetData.zIndex;
        let closestAbove = null;
        let closestAboveZ = Infinity;

        // 找到 z-index 刚好大于当前的挂件
        state.widgets.forEach((wd, id) => {
            if (id !== widgetId && wd.zIndex > currentZ && wd.zIndex < closestAboveZ) {
                closestAboveZ = wd.zIndex;
                closestAbove = wd;
            }
        });

        if (closestAbove) {
            // 交换 z-index
            closestAbove.zIndex = currentZ;
            closestAbove.element.style.zIndex = currentZ;
            widgetData.zIndex = closestAboveZ;
            widgetData.element.style.zIndex = closestAboveZ;
        } else {
            // 没有更高层的挂件，分配新的最高层
            bringToFront(widgetId);
        }
    }

    /**
     * 下移一层：与下方最近的挂件交换 z-index
     * @param {string} widgetId
     */
    function moveDown(widgetId) {
        // 锁定状态下禁止改变层级
        if (state.desktopLocked) return;
        const widgetData = state.widgets.get(widgetId);
        if (!widgetData) return;

        const currentZ = widgetData.zIndex;
        let closestBelow = null;
        let closestBelowZ = -Infinity;

        // 找到 z-index 刚好小于当前的挂件
        state.widgets.forEach((wd, id) => {
            if (id !== widgetId && wd.zIndex < currentZ && wd.zIndex > closestBelowZ) {
                closestBelowZ = wd.zIndex;
                closestBelow = wd;
            }
        });

        if (closestBelow) {
            // 交换 z-index
            closestBelow.zIndex = currentZ;
            closestBelow.element.style.zIndex = currentZ;
            widgetData.zIndex = closestBelowZ;
            widgetData.element.style.zIndex = closestBelowZ;
        } else {
            // 没有更低层的挂件，设为最低
            const newZ = Math.max(1, currentZ - 1);
            widgetData.zIndex = newZ;
            widgetData.element.style.zIndex = newZ;
        }
    }

    /**
     * 获取下一个 z-index 值（不递增计数器）
     * @returns {number}
     */
    function peekNextZIndex() {
        return state.nextZIndex;
    }

    /**
     * 分配一个新的 z-index 值并递增计数器
     * @returns {number}
     */
    function allocateZIndex() {
        return state.nextZIndex++;
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.zIndex = {
        bringToFront,
        sendToBack,
        moveUp,
        moveDown,
        peekNext: peekNextZIndex,
        allocate: allocateZIndex,
        DESKTOP_ICON_Z,
    };

})();