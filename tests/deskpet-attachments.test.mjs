import test from 'node:test';
import assert from 'node:assert/strict';
import { addFiles, describeFiles, pastedName, MAX_FILES } from '../DeskPetmodules/attachments.js';

test('dropped files are added once and capped', () => {
    let { list, dropped } = addFiles([], [{ path: '/a.png', name: 'a.png' }, { path: '/a.png', name: 'a.png' }, { name: 'nothing' }]);
    assert.deepEqual(list.map((f) => f.name), ['a.png']);
    assert.equal(dropped, 1);
    const many = Array.from({ length: 12 }, (_, i) => ({ path: `/f${i}`, name: `f${i}` }));
    ({ list, dropped } = addFiles(list, many));
    assert.equal(list.length, MAX_FILES);
    assert.equal(dropped, 3);
});

test('pasted images are told apart by name and size', () => {
    const a = { data: new Uint8Array(3), name: 'p.png', size: 3 };
    const b = { data: new Uint8Array(4), name: 'p.png', size: 4 };
    assert.equal(addFiles([a], [a, b]).list.length, 2);
});

test('the tray line names the first file and the count', () => {
    assert.equal(describeFiles([]), '');
    assert.equal(describeFiles([{ name: 'a.png' }]), '📎 a.png');
    assert.equal(describeFiles([{ name: 'a.png' }, { name: 'b.pdf' }]), '📎 a.png 等 2 个');
    assert.equal(describeFiles([{ name: 'x'.repeat(40) }]), `📎 ${'x'.repeat(23)}…`);
});

test('pasted images get a dated name with the right extension', () => {
    const at = new Date(2026, 9, 9, 15, 30, 12);
    assert.equal(pastedName('image/png', at), '粘贴的图片-20261009-153012.png');
    assert.equal(pastedName('image/jpeg', at), '粘贴的图片-20261009-153012.jpg');
    assert.equal(pastedName('', at), '粘贴的图片-20261009-153012.png');
});
