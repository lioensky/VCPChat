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
        // Dock 状态
        dock: {
            items: [],               // [{ id, name, icon, targetPath, args, workingDir, originalPath, type:'shortcut'|'builtin' }]
            maxVisible: 8,           // Dock 默认最大可见图标数
            position: 'bottom',      // Dock 位置：'top' | 'bottom' | 'left' | 'right'
            edgeDistance: 12,        // Dock 距边缘距离 (px)
        },
        // 桌面图标（从 Dock 拖出的快捷方式）
        desktopIcons: [],            // [{ id, name, icon, targetPath, args, workingDir, originalPath, x, y }]
        // 上次载入的预设ID（用于桌面右键菜单"保存当前预设"功能的检测）
        lastLoadedPresetId: null,
        lastLoadedPresetName: null,
        // 全局设置
        globalSettings: {
            autoMaximize: false,     // 打开桌面时自动最大化
            alwaysOnBottom: false,   // 桌面窗口自动置底
            visibilityFreezerEnabled: true,  // 最小化/遮挡时自动冻结动画
            defaultPresetId: null,   // 启动时自动加载的预设ID
            dock: {
                maxVisible: 8,       // Dock 栏默认显示图标数
                iconSize: 32,        // Dock 栏图标大小 (px)
                position: 'bottom',  // Dock 栏位置：'top' | 'bottom' | 'left' | 'right'
                edgeDistance: 12,     // Dock 栏距边缘距离 (px)
            },
            desktopIcon: {
                gridSnap: false,     // 桌面图标网格对齐
                iconSize: 40,        // 桌面图标大小 (px)，默认 40
            },
            wallpaper: {
                enabled: false,          // 是否启用自定义壁纸
                type: 'none',            // 'image' | 'video' | 'html' | 'none'
                source: '',              // 文件 URL (file:///...)
                filePath: '',            // 原始文件路径（用于显示和重新加载）
                opacity: 1,              // 壁纸透明度 0~1
                blur: 0,                 // 模糊度 px
                brightness: 1,           // 亮度 0~2
                videoMuted: true,        // 视频壁纸是否静音
                videoPlaybackRate: 1,    // 视频播放速率
            },
        },
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