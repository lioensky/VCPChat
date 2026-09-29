'use strict';

// 骰子：3D 骰子窗口，主进程下发掷骰指令，渲染端回报结果。
// 主进程：modules/ipc/diceHandlers.js
// 渲染端：Dicemodules/
const { invoke, send, onArgs } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/diceHandlers.js'],
    roles: ['utility'],
    api: {
        openDiceWindow: invoke('open-dice-window'),
        sendDiceModuleReady: send('dice-module-ready'),
        // 主进程发送 (notation, options) 两个参数，回调同样收到两个参数
        onRollDice: onArgs('roll-dice', 'notation', 'options'),
        sendDiceRollComplete: send('dice-roll-complete', 'results'),
    },
};