/**
 * VCPdesktop - 桌面画布渲染器（主入口）
 * 
 * 模块化架构：
 *   core/state.js          - 全局状态管理 & 常量
 *   core/theme.js          - 主题同步（light/dark）
 *   core/statusIndicator.js - 底部状态指示器
 *   core/zIndexManager.js  - Z-Index 层级管理
 *   core/dragSystem.js     - 拖拽系统（带限位）
 *   core/widgetManager.js  - 挂件管理核心（创建/删除/Shadow DOM/脚本处理）
 *   ui/contextMenu.js      - 右键菜单系统
 *   ui/saveModal.js        - 收藏命名模态窗
 *   ui/sidebar.js          - 收藏侧栏
 *   favorites/thumbnail.js       - 缩略图捕获
 *   favorites/favoritesManager.js - 收藏系统（保存/加载/删除/恢复）
 *   api/vcpProxy.js        - vcpAPI 代理层（凭据 + fetch）
 *   api/ipcBridge.js       - IPC 监听桥接
 *   builtinWidgets/weatherWidget.js - 内置天气挂件
 *   builtinWidgets/musicWidget.js   - 内置音乐播放条
 *   debug/debugTools.js    - 调试工具
 * 
 * 所有模块通过 window.VCPDesktop 命名空间进行通信。
 * 模块加载顺序由 desktop.html 中的 script 标签决定。
 */

'use strict';

// ============================================================
// 主入口初始化
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    const D = window.VCPDesktop;

    // 1. 初始化 DOM 引用
    D.initDomRefs();

    // 2. 标题栏窗口控制按钮
    document.getElementById('desktop-btn-minimize')?.addEventListener('click', () => {
        window.electronAPI?.minimizeWindow();
    });
    document.getElementById('desktop-btn-maximize')?.addEventListener('click', () => {
        window.electronAPI?.maximizeWindow();
    });
    document.getElementById('desktop-btn-close')?.addEventListener('click', () => {
        window.electronAPI?.closeWindow();
    });

    // 3. 侧栏开关按钮
    document.getElementById('desktop-btn-sidebar')?.addEventListener('click', () => {
        D.sidebar.toggle();
    });

    // 4. 初始化各子系统
    D.theme.init();
    if (D.wallpaper) {
        D.wallpaper.init();
    }
    // 初始化窗口可见性冻结系统
    if (D.visibilityFreezer) {
        D.visibilityFreezer.init();
    }
    D.status.update('waiting', '等待主窗口连接...');
    setTimeout(() => {
        D.status.hide();
    }, 3000);

    D.contextMenu.init();
    D.sidebar.init();
    D.sidebar.initCanvasDrop();
    D.saveModal.init();
    D.favorites.loadList();

    // 5.5. 初始化 Dock 栏
    if (D.dock) {
        D.dock.init();
    }

    // 5.5.1. 注入 VChat 内部应用到 Dock
    // 在 Dock 加载配置完成后（loadDockConfig 是异步的），延迟注入确保不覆盖已有配置
    if (D.vchatApps) {
        // 给 Dock 配置加载留出时间后再注入
        setTimeout(() => {
            D.vchatApps.inject();
        }, 500);
    }

    // 5.5.2. 恢复桌面图标（在 Dock 配置加载完成后延迟恢复）
    // 如果设置了默认预设，applyPreset 会先清除所有桌面图标再恢复预设中的图标，不会冲突
    if (D.dock && D.dock.restoreDesktopIcons) {
        setTimeout(() => {
            D.dock.restoreDesktopIcons();
        }, 600);
    }

    // 5.6. 初始化全局设置
    if (D.globalSettings) {
        D.globalSettings.init().then(() => {
            D.globalSettings.initNumberControls();
        });
    }

    // 5. 点击空白关闭右键菜单
    document.addEventListener('click', () => {
        D.contextMenu.hide();
    });

    // 6. 阻止画布/挂件区域的默认右键菜单
    document.addEventListener('contextmenu', (e) => {
        if (e.target.closest('#desktop-canvas') || e.target.closest('.desktop-widget')) {
            e.preventDefault();
        }
    });

    // 7. 初始化调试工具
    D.debug.init();

    console.log('[VCPdesktop] Desktop canvas renderer initialized (modular).');
    console.log('[VCPdesktop] Debug: window.__desktopDebug.test() to create a test widget.');
});

// ============================================================
// IPC 监听（需在 DOMContentLoaded 之外立即注册，避免丢失消息）
// ============================================================
window.VCPDesktop.ipc.init();

// ============================================================
// vcpAPI 凭据加载 & 内置挂件自动启动
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    const D = window.VCPDesktop;

    // 加载 vcpAPI 凭据
    await D.vcpApi.init();

    // 官方内置挂件不再自动启动到桌面，而是通过侧栏或 Dock 按需加载
    // 用户可以通过调试工具手动生成：window.__desktopDebug.spawnWeatherWidget() 等
    console.log('[VCPdesktop] Built-in widgets registered (available via sidebar/debug).');

    // 应用全局设置（包括自动最大化、窗口置底、加载默认预设等）
    if (D.globalSettings) {
        await D.globalSettings.applyOnStartup();
    }
});