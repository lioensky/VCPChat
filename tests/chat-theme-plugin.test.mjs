import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createChatThemePlugin } from '../modules/chat/chatThemePlugin.js';

test('chat theme plugin applies only allowlisted tokens and disposes them', () => {
    const root = new JSDOM('<div></div>').window.document.querySelector('div');
    const plugin = createChatThemePlugin({ id: 'soft', tokens: { accent: '#abc', surface: '#fff' } });
    const dispose = plugin.apply(root);
    assert.equal(root.style.getPropertyValue('--chat-accent'), '#abc');
    dispose();
    assert.equal(root.style.getPropertyValue('--chat-accent'), '');
    assert.throws(() => createChatThemePlugin({ id: 'bad', tokens: { css: 'body{}' } }), /Unsupported/);
});
