'use strict';

// Ask Nova（DeepWiki 问答）：向 Nova 发起查询与取消查询。
// 主进程：modules/ipc/deepWikiHandlers.js
const { invoke } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/deepWikiHandlers.js'],
    roles: ['chat'],
    api: {
        askNovaQuery: invoke('ask-nova:query', 'payload'),
        cancelAskNovaQuery: invoke('ask-nova:cancel', 'requestId'),
    },
};