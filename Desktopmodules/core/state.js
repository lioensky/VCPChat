/**
 * VCPdesktop - 全局状态管理
 * 负责：集中管理桌面所有状态数据，提供状态访问接口
 */

'use strict';

(function () {
    // ============================================================
    // 全局状态对象
    // ============================================================
    const desktopState = {
        widgets: new Map(),          // id -> widgetData
        dragState: null,
        isConnected: false,
        nextZIndex: 10,              // z-index 递增计数器
        sidebarOpen: false,
        favorites: [],               // [{ id, name, thumbnail }]
    };

    // ============================================================
    // 常量
    // ============================================================
    const CONSTANTS = {
        TITLE_BAR_HEIGHT: 32,
        MIN_WIDGET_WIDTH: 120,
        MIN_WIDGET_HEIGHT: 60,
        DRAG_MIN_VISIBLE: 40,        // 拖拽时至少保留在可视区域内的像素
        AUTO_RESIZE_MIN_W: 140,
        AUTO_RESIZE_MIN_H: 60,
        AUTO_RESIZE_MAX_RATIO: 0.85,  // 相对窗口的最大比例
        AUTO_RESIZE_PAD_W: 8,
        AUTO_RESIZE_PAD_H: 14,
    };

    // ============================================================
    // DOM 缓存引用
    // ============================================================
    const domRefs = {
        canvas: null,
        statusIndicator: null,
        statusDot: null,
        statusText: null,
    };

    /**
     * 初始化 DOM 引用（在 DOMContentLoaded 后调用）
     */
    function initDomRefs() {
        domRefs.canvas = document.getElementById('desktop-canvas');
        domRefs.statusIndicator = document.getElementById('desktop-status-indicator');
        domRefs.statusDot = domRefs.statusIndicator?.querySelector('.desktop-status-dot');
        domRefs.statusText = domRefs.statusIndicator?.querySelector('.desktop-status-text');
    }

    // ============================================================
    // 导出到全局命名空间
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.state = desktopState;
    window.VCPDesktop.CONSTANTS = CONSTANTS;
    window.VCPDesktop.domRefs = domRefs;
    window.VCPDesktop.initDomRefs = initDomRefs;

})();