'use strict';

// 应用功能模块：主窗口启动时问主进程有哪些功能要在这一侧载入（modules/appFeatures.js）。
// 渲染端：modules/renderer/appFeatures.js
const { invoke } = require('../core/define');

module.exports = {
    handlers: ['modules/appFeatures.js'],
    roles: ['chat'],
    api: {
        listAppFeatureEntries: invoke('app-features:renderer-entries'),
    },
};
