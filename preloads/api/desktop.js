'use strict';

// VCP 桌面：桌面窗口、小组件存取与截图、快捷方式、Dock 与布局、图标集、壁纸、置底、系统指标、推送到桌面画布。
// 主进程：modules/ipc/desktopHandlers.js、modules/ipc/desktopMetrics.js、modules/ipc/desktopRemoteHandlers.js
// 渲染端：Desktopmodules/
const { invoke, send, on } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/desktopHandlers.js', 'modules/ipc/desktopMetrics.js', 'modules/ipc/desktopRemoteHandlers.js'],
    roles: ['desktop'],
    api: {
        openDesktopWindow: invoke('open-desktop-window').roles('chat', 'utility', 'desktop'),
        desktopCanvasReady: invoke('desktop-canvas-ready'),

        // 聊天窗口 → 桌面画布的内容推送，以及桌面状态回传
        desktopPush: send('desktop-push', 'data').roles('chat', 'desktop'),
        onDesktopPush: on('desktop-push-to-canvas').roles('chat', 'desktop'),
        onDesktopStatus: on('desktop-status').roles('chat', 'desktop'),

        // 远程控制（AI 通过 VCP 插件操作桌面）
        onDesktopRemoteSetWallpaper: on('desktop-remote-set-wallpaper').roles('chat', 'desktop'),
        onDesktopRemoteRequest: on('desktop-remote:request').roles('chat', 'desktop'),
        sendDesktopRemoteResponse: send('desktop-remote:response', 'data').roles('chat', 'desktop'),

        // 小组件
        desktopSaveWidget: invoke('desktop-save-widget', 'data'),
        desktopLoadWidget: invoke('desktop-load-widget', 'id'),
        desktopDeleteWidget: invoke('desktop-delete-widget', 'id'),
        desktopListWidgets: invoke('desktop-list-widgets'),
        desktopSaveWidgetFile: invoke('desktop-save-widget-file', 'data'),
        desktopLoadWidgetFile: invoke('desktop-load-widget-file', 'data'),
        desktopListWidgetFiles: invoke('desktop-list-widget-files', 'widgetId'),
        desktopCaptureWidget: invoke('desktop-capture-widget', 'rect'),
        desktopGetCredentials: invoke('desktop-get-credentials'),
        // 在画布窗口里编辑小组件源码，保存后回推给桌面
        desktopOpenWidgetInCanvas: invoke('desktop-open-widget-in-canvas', 'data').roles('utility', 'desktop'),
        onDesktopWidgetSourceSaved: on('desktop-widget-source-saved').roles('utility', 'desktop'),

        // 快捷方式与应用启动
        desktopShortcutParse: invoke('desktop-shortcut-parse', 'filePath'),
        desktopShortcutParseBatch: invoke('desktop-shortcut-parse-batch', 'filePaths'),
        desktopShortcutLaunch: invoke('desktop-shortcut-launch', 'shortcutData'),
        desktopScanShortcuts: invoke('desktop-scan-shortcuts'),
        desktopLaunchVchatApp: invoke('desktop-launch-vchat-app', 'appAction').roles('chat', 'desktop'),
        desktopOpenSystemTool: invoke('desktop-open-system-tool', 'cmd').roles('chat', 'desktop'),

        // Dock、布局、图标集
        desktopSaveDock: invoke('desktop-save-dock', 'dockData'),
        desktopLoadDock: invoke('desktop-load-dock'),
        desktopSaveLayout: invoke('desktop-save-layout', 'layoutData'),
        desktopPatchLayout: invoke('desktop-patch-layout', 'patch'),
        desktopLoadLayout: invoke('desktop-load-layout'),
        desktopIconsetListPresets: invoke('desktop-iconset-list-presets'),
        desktopIconsetListIcons: invoke('desktop-iconset-list-icons', 'params'),
        desktopIconsetGetIconData: invoke('desktop-iconset-get-icon-data', 'relativePath'),

        // 壁纸与窗口层级
        desktopSelectWallpaper: invoke('desktop-select-wallpaper'),
        desktopReadWallpaperThumbnail: invoke('desktop-read-wallpaper-thumbnail', 'filePath'),
        selectVchatWallpaperDirectory: invoke('vchat-wallpaper-select-directory', (directoryPath = '') => [directoryPath]).roles('chat'),
        setAlwaysOnBottom: invoke('desktop-set-always-on-bottom', 'enabled'),

        // 系统指标
        desktopMetricsGetSnapshot: invoke('desktop-metrics-get-snapshot', (options = {}) => [options]),
        desktopMetricsGetCapabilities: invoke('desktop-metrics-get-capabilities'),
        desktopMetricsGetDetailedProcesses: invoke('desktop-metrics-get-detailed-processes'),
    },
};