'use strict';

// utility 角色 preload：笔记、音乐、画布、主题、翻译、骰子、RAG、论坛、施工图等子窗口共用。
// 暴露 window.utilityAPI（本角色可见 API）与 window.electronAPI（兼容层）。
// API 定义在 preloads/api/*.js，角色可见性由各条目的 roles 决定；约定见 preloads/README.md。
const { exposeRole } = require('./core/expose');
const { installEmbeddedSurface } = require('./behaviors/embeddedSurface');
const { installPinButton } = require('./behaviors/pinButton');

const { ctx, roleApi } = exposeRole('utility');
installEmbeddedSurface(ctx);
installPinButton(ctx, roleApi);

console.log('[Preload][utility] loaded');
