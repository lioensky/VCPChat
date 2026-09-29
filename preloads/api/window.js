'use strict';

// 窗口外壳：最小化/最大化/关闭、置顶、托盘、窗口生命周期、平台信息。
// 主进程：modules/ipc/windowHandlers.js、modules/services/windowPinService.js、main.js
const { invoke, send, on, onSignal, custom } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/windowHandlers.js', 'modules/services/windowPinService.js', 'main.js'],
    roles: ['chat', 'utility', 'desktop'],
    api: {
        minimizeWindow: send('minimize-window'),
        maximizeWindow: send('maximize-window'),
        unmaximizeWindow: send('unmaximize-window'),
        // 内嵌在主窗口 WebContentsView 里的页面（?vcpEmbedded=1）发送 close-window
        // 会关掉宿主主窗口，所以改为请求主进程销毁自己的内嵌会话。
        closeWindow: custom('command', 'close-window', ({ ipcRenderer, isEmbeddedSurface }) => () => {
            ipcRenderer.send(isEmbeddedSurface ? 'embedded-vchat-app:request-close' : 'close-window');
        }),
        hideWindow: send('hide-window'),
        openDevTools: send('open-dev-tools'),
        getPlatform: invoke('get-platform'),

        onWindowMaximized: onSignal('window-maximized').roles('chat', 'utility'),
        onWindowUnmaximized: onSignal('window-unmaximized').roles('chat', 'utility'),
        onWindowOccluded: on('window-occluded').roles('desktop'),

        // 窗口置顶（utility 子窗口标题栏的置顶按钮，见 behaviors/pinButton.js）
        togglePinWindow: invoke('toggle-pin-window').roles('utility'),
        isWindowPinned: invoke('is-window-pinned').roles('utility'),
        onWindowPinnedChanged: on('window-pinned-changed').roles('utility'),

        minimizeToTray: send('minimize-to-tray').roles('chat', 'utility'),
        closeApp: send('close-app').roles('chat'),
        windowReady: send('window-lifecycle:ready', (appId, payload = {}) => [{ appId, ...payload }]).roles('utility'),

        sendToggleNotificationsSidebar: send('toggle-notifications-sidebar').roles('chat', 'utility'),
        onDoToggleNotificationsSidebar: onSignal('do-toggle-notifications-sidebar').roles('chat', 'utility'),
        openAdminPanel: invoke('open-admin-panel').roles('chat', 'utility'),
    },
};