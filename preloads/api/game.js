'use strict';
const { invoke } = require('../core/define');
module.exports = {
    handlers: ['modules/ipc/gameHandlers.js'],
    roles: ['utility'],
    api: {
        launchGame: invoke('vcp-game:launch', 'gameId'),
        listGameRecords: invoke('vcp-game:records'),
        getGameRecord: invoke('vcp-game:record', 'request'),
        listGameAgents: invoke('vcp-game:agents'),
        createGameTable: invoke('vcp-game:create', 'request'),
        nextGameTable: invoke('vcp-game:next', 'request'),
        observeGameTable: invoke('vcp-game:observe', 'request'),
        submitGameAction: invoke('vcp-game:submit', 'request'),
        continueGameTable: invoke('vcp-game:continue', 'request'),
        stopGameTable: invoke('vcp-game:stop', 'request'),
    },
};