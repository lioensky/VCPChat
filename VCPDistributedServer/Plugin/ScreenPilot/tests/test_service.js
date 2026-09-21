'use strict';

const assert = require('node:assert/strict');
const service = require('../ScreenPilotService');

async function expectCompatibilityError() {
    try {
        await service.processToolCall({ command: '__CompatibilityProbe__' });
        assert.fail('Compatibility probe must report an unknown command.');
    } catch (error) {
        assert.match(error.message, /未知指令/);
        assert.equal(error.code, 'COMMAND_FAILED');
    }
}

async function run() {
    await service.initialize({
        logger: {
            error() {},
            warn() {},
            log() {},
        },
        config: {},
    });

    try {
        await expectCompatibilityError();
        const first = service._test.getRuntimeStatus();
        assert.equal(first.workerRunning, true);
        assert.equal(Number.isInteger(first.workerPid), true);

        await expectCompatibilityError();
        const second = service._test.getRuntimeStatus();
        assert.equal(second.workerRunning, true);
        assert.equal(second.workerPid, first.workerPid);
        assert.equal(second.workerGeneration, first.workerGeneration);
        assert.equal(second.pendingRequests, 0);
    } finally {
        service.cleanup();
    }

    const stopped = service._test.getRuntimeStatus();
    assert.equal(stopped.workerRunning, false);
    assert.equal(stopped.workerPid, null);
    console.log('ScreenPilot persistent service tests passed.');
}

run().catch((error) => {
    service.cleanup();
    console.error(error);
    process.exitCode = 1;
});