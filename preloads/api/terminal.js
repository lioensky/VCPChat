'use strict';

// 侧栏终端：VCPChat 自带终端（PowerShellExecutor 的 PTY 会话）在侧栏里的镜像视图
// （挂载 / 输入 / 调整大小 / 关闭视图 / 重启会话 / 跳转到工作区）与其数据、清屏、退出事件，
// 以及 AI 命令运行记录（列表 / 读取输出 / 变更通知）
// 主进程：modules/ipc/terminalHandlers.js（仅主窗口页面可用）
const { invoke, on } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/terminalHandlers.js'],
    roles: ['chat'],
    api: {
        terminalCreate: invoke('terminal:create', 'options'),
        terminalWrite: invoke('terminal:write', 'id', 'data'),
        terminalResize: invoke('terminal:resize', 'id', 'cols', 'rows'),
        terminalKill: invoke('terminal:kill', 'id'),
        terminalRestart: invoke('terminal:restart', 'id'),
        terminalChangeDirectory: invoke('terminal:cd', 'id', 'workspaceId'),
        terminalListCommandRuns: invoke('terminal:command-runs'),
        terminalGetCommandRun: invoke('terminal:command-run', 'id', 'options'),
        terminalWatchCommandRuns: invoke('terminal:watch-command-runs'),
        onTerminalCommandRunChanged: on('terminal:command-run-changed'),
        onTerminalData: on('terminal:data'),
        onTerminalClear: on('terminal:clear'),
        onTerminalExit: on('terminal:exit'),
    },
};
