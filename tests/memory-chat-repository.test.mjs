import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryChatRepository } from '../modules/chat/memoryChatRepository.js';

test('memory chat repository owns cloned short-session history', async () => {
    let history = [{ id: 'm1', content: 'before' }];
    const repository = createMemoryChatRepository({
        read: () => history,
        write: next => { history = next; },
    });
    const loaded = await repository.getHistory('ignored', 'agent', 'temporary');
    loaded[0].content = 'mutated copy';
    assert.equal(history[0].content, 'before');
    const input = [{ id: 'm2', content: 'saved' }];
    await repository.saveHistory('ignored', 'agent', 'temporary', input);
    input[0].content = 'late mutation';
    assert.equal(history[0].content, 'saved');
});

test('memory chat repository fails loud without explicit state powers', () => {
    assert.throws(() => createMemoryChatRepository(), /read and write/);
});
