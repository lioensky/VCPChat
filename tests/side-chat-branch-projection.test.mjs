import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildBranchForest } from '../modules/renderer/side-chat/branch-tree.js';
import { createSideChatBranchRail } from '../modules/renderer/side-chat/branch-rail.js';
import { openThoughtMapModal } from '../modules/renderer/side-chat/thought-map-modal.js';

const meta = (id, parent = null, depth = 99) => ({
    child: { topicId: id }, forkFromTopicId: parent, depth,
    title: 'old title', branchTitle: 'renamed', forkLabel: 'old excerpt'
});

test('branch depth derives from topology regardless of metadata order and stale depth', () => {
    for (const input of [
        [meta('C', 'B'), meta('B', 'A'), meta('A')],
        [meta('A'), meta('C', 'B'), meta('B', 'A')]
    ]) {
        const forest = buildBranchForest(input);
        assert.deepEqual(['A', 'B', 'C'].map(id => forest.nodes.get(id).depth), [0, 1, 2]);
    }
    const forest = buildBranchForest([meta('orphan', 'missing'), meta('x', 'y'), meta('y', 'x')]);
    for (const root of forest.roots) assert.equal(root.depth, 0);
});

test('rail and thought map display renamed title instead of immutable fork excerpt', async () => {
    const dom = new JSDOM('<body><div class="slot"></div></body>');
    const doc = dom.window.document;
    const previousDocument = globalThis.document;
    const previousRaf = globalThis.requestAnimationFrame;
    globalThis.document = doc;
    globalThis.requestAnimationFrame = callback => { callback(); return 1; };
    let rail;
    let modal;
    try {
        const items = [meta('A')];
        rail = createSideChatBranchRail({
            container: doc.querySelector('.slot'), doc,
            descriptor: items[0], listSiblings: async () => items
        });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(doc.querySelector('.branch-rail-label').textContent, 'renamed');
        modal = openThoughtMapModal({ doc, forest: buildBranchForest(items), currentTopicId: 'A' });
        assert.equal(doc.querySelector('.thought-map-node-group text').textContent, 'renamed');
    } finally {
        modal?.close();
        rail?.dispose();
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
        if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
        else globalThis.requestAnimationFrame = previousRaf;
        dom.window.close();
    }
});