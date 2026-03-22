/**
 * VCPdesktop - 主题同步模块
 * 负责：初始主题读取、IPC 主题变更监听、light/dark 切换
 */

'use strict';

(function () {
    /**
     * 初始化主题同步
     * 从 URL 参数读取初始主题，并监听主进程的主题更新
     */
    function initThemeSync() {
        const params = new URLSearchParams(window.location.search);
        const initialTheme = params.get('currentThemeMode');
        if (initialTheme === 'light') {
            document.body.classList.add('light-theme');
        }

        if (window.electronAPI?.onThemeUpdated) {
            window.electronAPI.onThemeUpdated((theme) => {
                if (theme === 'light') {
                    document.body.classList.add('light-theme');
                } else {
                    document.body.classList.remove('light-theme');
                }
            });
        }
    }

    /**
     * 获取当前主题模式
     * @returns {'light' | 'dark'}
     */
    function getCurrentTheme() {
        return document.body.classList.contains('light-theme') ? 'light' : 'dark';
    }

    /**
     * 设置主题模式
     * @param {'light' | 'dark'} theme
     */
    function setTheme(theme) {
        if (theme === 'light') {
            document.body.classList.add('light-theme');
        } else {
            document.body.classList.remove('light-theme');
        }
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.theme = {
        init: initThemeSync,
        getCurrent: getCurrentTheme,
        set: setTheme,
    };

})();