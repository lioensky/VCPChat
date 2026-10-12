'use strict';
const { invoke } = require('../core/define');
module.exports = {
    handlers: ['modules/ipc/gameHandlers.js'],
    roles: ['utility'],
    api: {
        launchGame: invoke('vcp-game:launch', 'gameId'),
        listGameAgents: invoke('vcp-game:agents'),
        createGameTable: invoke('vcp-game:create', 'request'),
        observeGameTable: invoke('vcp-game:observe', 'request'),
        submitGameAction: invoke('vcp-game:submit', 'request'),
        continueGameTable: invoke('vcp-game:continue', 'request'),
        stopGameTable: invoke('vcp-game:stop', 'request'),
    },
};