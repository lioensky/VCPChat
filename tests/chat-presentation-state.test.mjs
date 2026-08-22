import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatPresentationState } from '../modules/chat/chatPresentationState.js';

test('presentation state publishes readonly snapshots and quiesces on dispose', () => {
    const state = createChatPresentationState({ theme: 'dark' });
    const seen = [];
    const unsubscribe = state.subscribe(snapshot => seen.push(snapshot));
    state.set({ mode: 'streaming', activeSurface: 'standalone' });
    assert.equal(seen[0].theme, 'dark');
    assert.equal(seen[1].mode, 'streaming');
    try { seen[1].mode = 'mutated'; } catch {}
    assert.equal(state.getSnapshot().mode, 'streaming');
    state.dispose();
    state.set({ mode: 'error' });
    unsubscribe();
    assert.equal(seen.length, 2);
});

test('one presentation subscriber cannot abort the state transition for other consumers', () => {
    const state = createChatPresentationState();
    const seen = [];
    state.subscribe(() => { throw new Error('broken skin'); });
    state.subscribe(snapshot => seen.push(snapshot.mode));
    assert.doesNotThrow(() => state.set({ mode: 'streaming' }));
    assert.deepEqual(seen, ['idle', 'streaming']);
});
