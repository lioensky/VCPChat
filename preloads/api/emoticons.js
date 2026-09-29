'use strict';

// 表情包库：聊天输入与论坛使用的表情包清单。
// 主进程：modules/ipc/emoticonHandlers.js
const { invoke } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/emoticonHandlers.js'],
    roles: ['chat', 'utility'],
    api: {
        getEmoticonLibrary: invoke('get-emoticon-library'),
    },
};