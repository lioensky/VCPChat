'use strict';

// 侧栏「调用轨迹」：按话题读取每次模型调用的请求 / 响应 / 用量，清空，打开记录目录，以及实时变更通知
// 主进程：modules/ipc/modelTrajectoryHandlers.js（仅主窗口页面可用）；记录器：modules/modelTrajectory.js
const { invoke, on } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/modelTrajectoryHandlers.js'],
    roles: ['chat'],
    api: {
        modelTrajectoryList: invoke('model-trajectory:list', 'sessionKey', 'options'),
        modelTrajectoryClear: invoke('model-trajectory:clear', 'sessionKey'),
        modelTrajectoryOpenDirectory: invoke('model-trajectory:open-directory'),
        modelTrajectoryWatch: invoke('model-trajectory:watch'),
        modelTrajectoryUnwatch: invoke('model-trajectory:unwatch'),
        onModelTrajectoryChanged: on('model-trajectory:changed'),
    },
};
