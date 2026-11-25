'use strict';

const { invoke } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/mijiaHandlers.js'],
    roles: ['chat', 'utility'],
    api: {
        mijiaListDevices: invoke('mijia:list'),
        mijiaReadProperties: invoke('mijia:properties-read', 'id'),
        mijiaWriteProperties: invoke('mijia:properties-write', 'id', 'mode', 'changes'),
        mijiaStartLogin: invoke('mijia:login-start'),
        mijiaLoginState: invoke('mijia:login-state', 'attemptId'),
        mijiaCancelLogin: invoke('mijia:login-cancel', 'attemptId'),
    },
};