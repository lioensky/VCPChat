'use strict';

// 消息图片在主窗口里的 preload API（preloads/core/registry.js 自动收；停用或删掉 modules/messageImage 就没有了）。
// 主进程：modules/messageImage/index.js
const { invoke } = require('../../preloads/core/define');

module.exports = {
    handlers: ['modules/messageImage/index.js'],
    roles: ['chat'],
    api: {
        messageImagePrepare: invoke('message-image:prepare', 'parts', 'options'),
        messageImageOutput: invoke('message-image:output', 'action', 'bytes'),
    },
};
