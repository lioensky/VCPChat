'use strict';

// chat 角色 preload：主聊天窗口、划词助手浮条、语音聊天窗口共用。
// 暴露 window.chatAPI（本角色可见 API）与 window.electronAPI（兼容层）。
// API 定义在 preloads/api/*.js，角色可见性由各条目的 roles 决定；约定见 preloads/README.md。
const { exposeRole } = require('./core/expose');

exposeRole('chat');

console.log('[Preload][chat] loaded');
