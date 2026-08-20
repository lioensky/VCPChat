import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmoticonUrlFixer } from '../modules/renderer/emoticonUrlFixer.js';

test('emoticon catalogs remain isolated between renderer owners', async () => {
    const fixerA = createEmoticonUrlFixer();
    const fixerB = createEmoticonUrlFixer();
    await Promise.all([
        fixerA.initialize({ getEmoticonLibrary: async () => [{ filename: 'happy.png', url: 'file:///A/表情包/happy.png' }] }),
        fixerB.initialize({ getEmoticonLibrary: async () => [{ filename: 'happy.png', url: 'file:///B/表情包/happy.png' }] }),
    ]);

    const stale = 'file:///missing/表情包/happy.png';
    assert.equal(fixerA.fixEmoticonUrl(stale), 'file:///A/表情包/happy.png');
    assert.equal(fixerB.fixEmoticonUrl(stale), 'file:///B/表情包/happy.png');
});
