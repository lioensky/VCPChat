'use strict';

// desktop 角色 preload：VCP 桌面窗口（Desktopmodules/desktop.html）专用。
// 暴露 window.desktopAPI（本角色可见 API）与 window.electronAPI（兼容层）。
// API 定义在 preloads/api/*.js，角色可见性由各条目的 roles 决定；约定见 preloads/README.md。
const { exposeRole } = require('./core/expose');

exposeRole('desktop');

console.log('[Preload][desktop] loaded');
