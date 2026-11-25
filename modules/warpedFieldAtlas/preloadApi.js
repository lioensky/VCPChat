'use strict';

// 双曲场图的 preload API（preloads/core/registry.js 自动收；停用或删掉 modules/warpedFieldAtlas 就没有了）。
// 主进程：modules/warpedFieldAtlas/index.js
const { invoke } = require('../../preloads/core/define');

module.exports = {
    handlers: ['modules/warpedFieldAtlas/index.js'],
    roles: ['chat'],
    api: {
        // 主窗口用：打开（或切到）双曲场图的窗口。
        warpedFieldAtlasOpen: invoke('warped-field-atlas:open'),
        // 通过 chat 和 utility 两个角色供主窗口和双曲场图窗口调用。route：/status、/messages[?q=文字]、/field/<tag|chunk>、
        //   /field/<kind>/node/<编号>、/field/<kind>/query?node=<编号>、/field/<kind>/query?message=<消息的 hash>
        warpedFieldAtlasGet: invoke('warped-field-atlas:get', 'route').roles('chat', 'utility'),
    },
};
