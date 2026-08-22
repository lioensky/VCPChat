import test from 'node:test';
import assert from 'node:assert/strict';

test('enhanced color utils does not install a process-lifetime cleanup interval', async () => {
    const originalSetInterval = globalThis.setInterval;
    let calls = 0;
    globalThis.setInterval = () => { calls += 1; return 1; };
    try {
        await import('../modules/renderer/enhancedColorUtils.js?lifecycle-test=1');
        assert.equal(calls, 0);
    } finally {
        globalThis.setInterval = originalSetInterval;
    }
});
