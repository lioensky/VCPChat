import assert from 'node:assert/strict';
import { createStreamSession } from '../modules/chat/streamSession.js';

const session = createStreamSession({ sessionId: 'invariant-session', conversationKey: 'invariant-conversation' });
assert.equal(session.pushChunk('a'), true, 'first chunk must be accepted');
assert.equal(session.terminal('completed'), true, 'first terminal must be accepted');
assert.equal(session.terminal('failed'), false, 'second terminal must be rejected');
assert.equal(session.pushChunk('late'), false, 'late chunk must be rejected');
assert.equal(session.snapshot.text, 'a', 'late chunk changed stream state');
assert.equal((await session.dispose('invariant-dispose')).kind, 'completed', 'dispose must preserve accepted terminal');
console.log('Chat contract runtime invariants passed (single terminal, late-result isolation, quiescent dispose).');
