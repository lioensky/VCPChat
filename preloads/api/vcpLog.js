'use strict';

// VCPLog：与 VCP 服务器日志 WebSocket 的连接、消息收发，以及日志窗口。
// 主进程：main.js（connect-vcplog / disconnect-vcplog / send-vcplog-message）、modules/ipc/windowHandlers.js（open-log-window）
const { send, on } = require('../core/define');

module.exports = {
    handlers: ['main.js', 'modules/ipc/windowHandlers.js'],
    roles: ['chat'],
    api: {
        connectVCPLog: send('connect-vcplog', (url, key) => [{ url, key }]),
        disconnectVCPLog: send('disconnect-vcplog'),
        onVCPLogMessage: on('vcp-log-message'),
        onVCPLogStatus: on('vcp-log-status'),
        sendVCPLogMessage: send('send-vcplog-message', 'data').roles('chat', 'utility'),
        openLogWindow: send('open-log-window').roles('utility'),
    },
};