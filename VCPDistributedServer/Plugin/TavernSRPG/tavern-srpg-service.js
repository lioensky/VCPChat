'use strict';
const service = require('../../../Gamemodules/srpg/service.cjs');
module.exports = {
    initialize: () => service.initialize(),
    processToolCall: (args, executionContext) => service.processToolCall(args, executionContext),
    cleanup: () => service.cleanup(),
};