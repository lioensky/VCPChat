import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assertChatEventContract,
    normalizeChatTerminal,
    STREAM_TERMINAL_KINDS,
} from '../modules/chat/chatEventContract.js';

test('chat event contracts distinguish durable terminal from transient events', () => {
    assert.equal(assertChatEventContract({ name: 'chat.stream.completed', terminal: true, durable: true }).terminal, true);
    assert.equal(assertChatEventContract({ name: 'chat.stream.chunk', terminal: false, durable: false }).terminal, false);
    assert.throws(() => assertChatEventContract({ name: 'chat.stream.completed', terminal: false, durable: true }), /terminal declaration mismatch/);
});

test('chat terminal normalization rejects unknown values at the contract seam', () => {
    assert.deepEqual(normalizeChatTerminal('abort'), { kind: 'cancelled' });
    assert.deepEqual(normalizeChatTerminal({ type: 'error', message: 'x' }), { type: 'error', message: 'x', kind: 'failed' });
    assert.throws(() => normalizeChatTerminal('mystery'), /unknown chat stream terminal/);
    assert.deepEqual(STREAM_TERMINAL_KINDS, ['completed', 'failed', 'cancelled', 'discarded']);
});
