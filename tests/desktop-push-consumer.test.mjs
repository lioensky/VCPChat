import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopPushConsumer } from '../modules/renderer/desktopPushConsumer.js';

function createHarness() {
    const intervals = new Map();
    const cleared = [];
    let nextId = 1;
    let statusListener = null;
    let unsubscribeCalls = 0;
    const pushes = [];
    const scheduler = {
        setInterval(callback, delay) {
            const id = nextId++;
            intervals.set(id, { callback, delay });
            return id;
        },
        clearInterval(id) {
            cleared.push(id);
            intervals.delete(id);
        },
    };
    const electronAPI = {
        onDesktopStatus(listener) {
            statusListener = listener;
            return () => { unsubscribeCalls += 1; statusListener = null; };
        },
        desktopPush(payload) { pushes.push(payload); },
    };
    return {
        scheduler,
        electronAPI,
        intervals,
        cleared,
        pushes,
        emitStatus(value) { statusListener?.({ connected: value }); },
        captureStatusListener() { return statusListener; },
        get unsubscribeCalls() { return unsubscribeCalls; },
    };
}

test('desktop push consumer owns subscription, message timer, and terminal cleanup', () => {
    const harness = createHarness();
    const consumer = createDesktopPushConsumer({
        electronAPI: harness.electronAPI,
        scheduler: harness.scheduler,
        createWidgetId: () => 'widget-1',
        logger: { log() {}, warn() {} },
    });
    consumer.start();
    harness.emitStatus(true);

    const output = consumer.processToken(
        'message-1',
        'visible<<<[DESKTOP_PUSH]>>><div>desktop content<<<[DESKTOP_PUSH_END]>>>tail',
    );

    assert.equal(output, 'visibletail');
    assert.deepEqual(harness.pushes.map(push => push.action), ['create', 'append', 'finalize']);
    assert.equal(harness.intervals.size, 0, 'closed block must release its throttle timer');
    assert.equal(consumer.getStateCount(), 1, 'message lease remains until stream terminal cleanup');

    consumer.cleanupMessage('message-1');
    assert.equal(consumer.getStateCount(), 0);
    consumer.dispose();
    assert.equal(harness.unsubscribeCalls, 1);
});

test('dispose revokes late status, timer, and token side effects', () => {
    const harness = createHarness();
    let clock = 1;
    const consumer = createDesktopPushConsumer({
        electronAPI: harness.electronAPI,
        scheduler: harness.scheduler,
        now: () => clock,
        createWidgetId: () => 'widget-2',
        logger: { log() {}, warn() {} },
    });
    consumer.start();
    harness.emitStatus(true);
    consumer.processToken('message-2', '<<<[DESKTOP_PUSH]>>><section>pending');
    assert.equal(harness.intervals.size, 1);
    const lateStatus = harness.captureStatusListener();
    const lateTimer = [...harness.intervals.values()][0].callback;
    const pushesBeforeDispose = harness.pushes.length;

    consumer.dispose();

    assert.equal(harness.unsubscribeCalls, 1);
    assert.equal(harness.intervals.size, 0);
    assert.equal(consumer.getStateCount(), 0);
    lateStatus({ connected: true });
    clock += 200_000;
    lateTimer();
    const lateToken = '<<<[DESKTOP_PUSH_END]>>>';
    assert.equal(consumer.processToken('message-2', lateToken), lateToken);
    assert.equal(harness.pushes.length, pushesBeforeDispose, 'late callbacks and tokens must lose Desktop IPC authority');

    consumer.dispose();
    assert.equal(harness.unsubscribeCalls, 1, 'dispose must be idempotent');
});

test('message cleanup revokes an already queued throttle callback', () => {
    const harness = createHarness();
    const consumer = createDesktopPushConsumer({
        electronAPI: harness.electronAPI,
        scheduler: harness.scheduler,
        createWidgetId: () => 'widget-3',
        logger: { log() {}, warn() {} },
    });
    consumer.start();
    harness.emitStatus(true);
    consumer.processToken('message-3', '<<<[DESKTOP_PUSH]>>><main>pending');
    const queuedTick = [...harness.intervals.values()][0].callback;
    const pushesBeforeCleanup = harness.pushes.length;

    consumer.cleanupMessage('message-3');
    queuedTick();

    assert.equal(harness.pushes.length, pushesBeforeCleanup);
    assert.equal(consumer.getStateCount(), 0);
    assert.equal(harness.intervals.size, 0);
    consumer.dispose();
});

test('a queued timer from a closed block cannot act on a later block for the same message', () => {
    const harness = createHarness();
    const consumer = createDesktopPushConsumer({
        electronAPI: harness.electronAPI,
        scheduler: harness.scheduler,
        createWidgetId: () => `widget-${harness.pushes.length}`,
        logger: { log() {}, warn() {} },
    });
    consumer.start();
    harness.emitStatus(true);
    consumer.processToken('message-4', '<<<[DESKTOP_PUSH]>>><div>first');
    const staleTick = [...harness.intervals.values()][0].callback;
    consumer.processToken('message-4', '<<<[DESKTOP_PUSH_END]>>>');
    consumer.processToken('message-4', '<<<[DESKTOP_PUSH]>>><section>second');
    const pushesBeforeStaleTick = harness.pushes.length;

    staleTick();

    assert.equal(harness.pushes.length, pushesBeforeStaleTick);
    consumer.dispose();
});
