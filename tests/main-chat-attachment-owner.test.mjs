import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainChatAttachmentOwner } from '../modules/renderer/mainChatAttachmentOwner.js';

test('attachment owner provides one stable ref and projects its current files', () => {
    const previews = [];
    const owner = createMainChatAttachmentOwner({ renderPreview: files => previews.push([...files]) });
    const ref = owner.ref;
    const files = [{ name: 'one.txt' }];

    assert.equal(owner.ref, ref);
    const stored = ref.set(files);
    assert.notEqual(stored, files);
    assert.notEqual(owner.get(), files);
    files.push({ name: 'outside.txt' });
    assert.deepEqual(owner.get(), [{ name: 'one.txt' }]);
    const appended = ref.append({ name: 'two.txt' });
    assert.notEqual(appended, stored);
    assert.deepEqual(owner.get(), [{ name: 'one.txt' }, { name: 'two.txt' }]);
    assert.throws(() => owner.get().push({ name: 'bypass.txt' }), /extensible|read only/i);
    assert.equal(owner.syncPreview(), true);
    assert.deepEqual(previews, [[{ name: 'one.txt' }, { name: 'two.txt' }]]);
    assert.deepEqual(owner.clear(), []);
    assert.deepEqual(owner.get(), []);
});

test('attachment owner dispose is idempotent and rejects later mutation', () => {
    const owner = createMainChatAttachmentOwner();
    owner.ref.set([{ name: 'one.txt' }]);
    owner.dispose();
    owner.dispose();

    assert.deepEqual(owner.get(), []);
    assert.equal(owner.syncPreview(), false);
    assert.throws(() => owner.ref.set([]), /disposed/);
    assert.throws(() => owner.ref.append({ name: 'late.txt' }), /disposed/);
    assert.throws(() => owner.clear(), /disposed/);
});
