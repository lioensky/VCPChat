import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBrowserInput, resolveBrowserAddress } from '../modules/ui-system/side-pane/browserSideProvider.js';

test('addresses open as before', () => {
    assert.deepEqual(resolveBrowserAddress('example.com'), { url: 'https://example.com/' });
    assert.deepEqual(resolveBrowserAddress('localhost:3000'), { url: 'http://localhost:3000/' });
    assert.deepEqual(resolveBrowserAddress('https://a.test/x?y=1'), { url: 'https://a.test/x?y=1' });
    assert.equal(resolveBrowserAddress('   '), null);
});

test('plain text becomes a web search instead of an error', () => {
    assert.ok(normalizeBrowserInput('vcp 工具').error);
    assert.deepEqual(resolveBrowserAddress('vcp 工具'), { url: 'https://www.bing.com/search?q=vcp%20%E5%B7%A5%E5%85%B7' });
    assert.deepEqual(resolveBrowserAddress('electron'), { url: 'https://www.bing.com/search?q=electron' });
    assert.deepEqual(resolveBrowserAddress('what is: this'), { url: 'https://www.bing.com/search?q=what%20is%3A%20this' });
});

test('unsupported schemes stay errors rather than searches', () => {
    for (const text of ['javascript:alert(1)', 'chrome://settings', 'vbscript:x']) {
        assert.ok(resolveBrowserAddress(text).error, text);
    }
});
