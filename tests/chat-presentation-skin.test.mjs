import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPresentationSkin } from '../modules/chat/chatPresentationSkin.js';

test('presentation skin receives only frozen state/tokens and disposes owned DOM', () => {
    const root = new JSDOM('<div></div>').window.document.querySelector('div');
    let disposed = false;
    const skin = createPresentationSkin({ id: 'readonly-badge', tokens: { accent: '#888' }, render: (host, state, tokens) => {
        host.dataset.mode = state.mode;
        host.dataset.accent = tokens.accent;
        return () => { disposed = true; delete host.dataset.mode; };
    } });
    const teardown = skin.mount(root, { mode: 'readonly' });
    assert.equal(root.dataset.mode, 'readonly');
    assert.equal(Object.isFrozen(skin.tokens), true);
    teardown();
    assert.equal(disposed, true);
    assert.equal(root.dataset.mode, undefined);
});

test('presentation skin update is state-owned and unsubscribed with the mount', () => {
    const root = new JSDOM('<div></div>').window.document.querySelector('div');
    const seen = [];
    const skin = createPresentationSkin({
        id: 'stateful',
        render: (host, state) => { host.dataset.mode = state.mode; return () => {}; },
        update: (host, state) => { seen.push(state.mode); host.dataset.mode = state.mode; }
    });
    const mounted = skin.mount(root, { mode: 'idle' });
    mounted.update({ mode: 'streaming' });
    assert.deepEqual(seen, ['streaming']);
    assert.equal(root.dataset.mode, 'streaming');
    mounted();
});
