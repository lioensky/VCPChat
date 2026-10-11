'use strict';
const { invoke } = require('../core/define');
module.exports = {
    handlers: ['modules/ipc/gameHandlers.js'],
    roles: ['utility'],
    api: { launchGame: invoke('vcp-game:launch', 'gameId') },
};