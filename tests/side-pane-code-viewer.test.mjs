import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createCodeViewerSideProvider } from '../modules/ui-system/side-pane/codeViewerSideProvider.js';
import * as SidePaneState from '../modules/ui-system/side-pane/side-pane-state.js';

test('openViewer opens a workspace-wide tab that becomes active even while a conversation is the parent', async () => {
    const dom = new JSDOM('<div></div>');
    const opened = [];
    const provider = createCodeViewerSideProvider({
        document: dom.window.document,
        api: null,
        uiHelper: null,
        sidePaneController: { openTab: async (tab) => { opened.push(tab); return tab; } }
    });

    await provider.openViewer({ filePath: 'C:/proj/src/app.js' });
    assert.equal(opened.length, 1);
    assert.equal(opened[0].scopeMode, 'global');
    assert.equal(opened[0].title, 'app.js');

    let state = SidePaneState.createInitialSidePaneState();
    state = SidePaneState.setParent(state, { itemType: 'agent', itemId: 'a1', topicId: 't1' });
    state = SidePaneState.openTab(state, opened[0]);
    assert.equal(state.activeTabId, 'code-viewer:C:/proj/src/app.js');
    assert.equal(state.visible, true);
});
