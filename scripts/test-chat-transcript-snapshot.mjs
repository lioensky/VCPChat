import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStreamSession } from '../modules/chat/streamSession.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scenarios = [
    { id: 'chat-stream', sessionId: 'snapshot-session', conversationKey: 'snapshot-conversation', prompt: 'say hello', chunks: ['hello ', 'world'], terminal: 'completed' },
    { id: 'chat-stream-cancel', sessionId: 'snapshot-cancel-session', conversationKey: 'snapshot-cancel-conversation', prompt: 'start a reply', chunks: ['partial'], terminal: 'cancelled' },
    { id: 'chat-stream-failed', sessionId: 'snapshot-failed-session', conversationKey: 'snapshot-failed-conversation', prompt: 'trigger an error', chunks: ['partial'], terminal: 'failed' },
    { id: 'chat-stream-discarded', sessionId: 'snapshot-discarded-session', conversationKey: 'snapshot-discarded-conversation', prompt: 'dispose the reply', chunks: ['partial'], terminal: 'discarded' },
];
for (const scenario of scenarios) {
    const session = createStreamSession({ sessionId: scenario.sessionId, conversationKey: scenario.conversationKey });
    const wire = [];
    const statuses = [];
    session.subscribe(event => {
        wire.push(event.type === 'chunk' ? `chunk:${event.text}` : event.type);
        statuses.push(event.type === 'chunk' ? 'streaming' : event.type);
    });
    for (const chunk of scenario.chunks) session.pushChunk(chunk);
    session.terminal(scenario.terminal);
    const snapshot = {
        modelVisible: [
            { role: 'user', content: scenario.prompt },
            { role: 'assistant', content: session.snapshot.text, terminal: session.snapshot.terminal.kind },
        ],
        chatVisible: {
            role: 'assistant',
            status: session.snapshot.terminal.kind,
            content: session.snapshot.text,
        },
        durable: { conversationKey: session.snapshot.conversationKey, terminal: session.snapshot.terminal.kind, text: session.snapshot.text },
        projection: { statuses, chunkCount: session.snapshot.chunkCount, text: session.snapshot.text },
        wire,
    };
    const expected = JSON.parse(fs.readFileSync(path.join(root, `docs/contracts/snapshots/${scenario.id}.json`), 'utf8'));
    assert.deepEqual(snapshot, expected, `${scenario.id} snapshot changed; review the semantic diff before recording`);
}
console.log('Chat transcript snapshots passed (completed, cancelled, failed and discarded durable/projection/wire transcripts).');
