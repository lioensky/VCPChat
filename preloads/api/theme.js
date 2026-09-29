'use strict';

// 主题：当前主题、明暗模式、主题列表与切换、壁纸缩略图、主题窗口。
// 主进程：modules/ipc/themeHandlers.js、modules/ipc/settingsHandlers.js（set-theme）
const { invoke, send, on } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/themeHandlers.js', 'modules/ipc/settingsHandlers.js'],
    roles: ['chat', 'utility', 'desktop'],
    api: {
        onThemeUpdated: on('theme-updated'),
        getCurrentTheme: invoke('get-current-theme'),
        setTheme: send('set-theme', 'theme'),
        setThemeMode: send('set-theme-mode', 'themeMode'),

        getThemes: invoke('get-themes').roles('chat', 'utility'),
        applyTheme: send('apply-theme', 'fileName').roles('chat', 'utility'),
        getWallpaperThumbnail: invoke('get-wallpaper-thumbnail', 'filePath').roles('chat', 'utility'),
        openThemesWindow: send('open-themes-window').roles('chat', 'utility'),
    },
};