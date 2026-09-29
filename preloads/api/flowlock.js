'use strict';

// Flowlock（心流锁）：远程控制指令、RPC 请求/响应、待认领话题的认领与归还。
// 主进程：modules/ipc/desktopRemoteHandlers.js（flowlock-command）、modules/ipc/chatHandlers.js（*-flowlock-*）
// 渲染端：Flowlockmodules/
const { invoke, send, on } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/desktopRemoteHandlers.js', 'modules/ipc/chatHandlers.js'],
    roles: ['chat'],
    api: {
        onFlowlockCommand: on('flowlock-command'),
        onFlowlockRequest: on('flowlock:request'),
        sendFlowlockRpcResponse: send('flowlock:response', 'data'),
        claimPendingFlowlockTopic: invoke('claim-pending-flowlock-topic', (agentId, constraints = {}) => [agentId, constraints]),
        restoreFlowlockClaim: invoke('restore-flowlock-claim', 'agentId', 'requestId', 'reason'),
        listPendingFlowlockTopics: invoke('list-pending-flowlock-topics'),
    },
};