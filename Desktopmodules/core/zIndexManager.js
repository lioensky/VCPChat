/**
 * VCPdesktop - Z-Index 层级管理模块
 * 负责：挂件层级排序、置顶、置底
 */

'use strict';

(function () {
    const { state } = window.VCPDesktop;

    /**
     * 将挂件提升到最前
     * @param {string} widgetId
     */
    function bringToFront(widgetId) {
        const widgetData = state.widgets.get(widgetId);
        if (!widgetData) return;
        const newZ = state.nextZIndex++;
        widgetData.zIndex = newZ;
        widgetData.element.style.zIndex = newZ;
    }

    /**
     * 将挂件发送到最底
     * @param {string} widgetId
     */
    function sendToBack(widgetId) {
        const widgetData = state.widgets.get(widgetId);
        if (!widgetData) return;
        // 找到当前最小z-index，减1
        let minZ = Infinity;
        state.widgets.forEach((wd) => {
            if (wd.zIndex < minZ) minZ = wd.zIndex;
        });
        const newZ = Math.max(1, minZ - 1);
        widgetData.zIndex = newZ;
        widgetData.element.style.zIndex = newZ;
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
        peekNext: peekNextZIndex,
        allocate: allocateZIndex,
    };

})();