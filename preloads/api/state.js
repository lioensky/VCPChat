'use strict';

// 主进程推送的订阅登记：渲染端的共享数据源有了第一个持有者时订阅，最后一个离开时取消。
// 主进程只把推送发给订阅了的窗口，窗口关闭或刷新时它的订阅自动清掉。
// 主进程：modules/ipc/stateSubscriptions.js
const { invoke } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/stateSubscriptions.js'],
    roles: ['chat', 'utility'],
    api: {
        subscribeMainState: invoke('state:subscribe', 'topic', 'key'),
        unsubscribeMainState: invoke('state:unsubscribe', 'topic', 'key'),
    },
};
