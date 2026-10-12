'use strict';
const { GameToolAdapter } = require('../../../modules/game/gameToolAdapter');
const { createSignatureAuthorizer } = require('../../../modules/game/gameSeatResolver');
let adapter = null;
function initialize(options = {}) {
    const service = options.services?.gameService;
    adapter = service ? new GameToolAdapter({
        gameService: service,
        authorize: createSignatureAuthorizer(service),
    }) : null;
}
function processToolCall(args, executionContext) {
    if (!adapter) throw new Error('游戏服务尚未初始化，请重启VChat并确认游戏服务接线。');
    return adapter.processToolCall(args, executionContext);
}
function cleanup() { adapter = null; }
module.exports = { initialize, processToolCall, cleanup };