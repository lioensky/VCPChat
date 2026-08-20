import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderDependencies } from '../modules/renderer/renderDependencies.js';

const ref = value => ({ get: () => value, set: next => { value = next; } });
const valid = () => ({
    chatMessagesDiv: { querySelector() {}, addEventListener() {} },
    currentChatHistoryRef: ref([]),
    currentSelectedItemRef: ref({ id: 'a' }),
    currentTopicIdRef: ref('t'),
    globalSettingsRef: ref({}),
    electronAPI: {},
    chatRepository: { saveHistory() {} },
    markedInstance: { parse: value => value },
    uiHelper: { scrollToBottom() {} },
    summarizeTopicFromMessages() {},
    handleCreateBranch() {},
});

test('RenderDependencies creates one frozen explicit capability closure', () => {
    const dependencies = createRenderDependencies(valid());
    assert.equal(Object.isFrozen(dependencies), true);
    assert.equal(Object.isFrozen(dependencies.state), true);
    assert.equal(dependencies.root, dependencies.chatMessagesDiv);
    assert.equal(dependencies.transport, dependencies.electronAPI);
    assert.equal(dependencies.state.history, dependencies.currentChatHistoryRef);
});

test('RenderDependencies fails fast for absent root, state, transport and parser powers', () => {
    for (const key of ['chatMessagesDiv', 'currentChatHistoryRef', 'electronAPI', 'markedInstance']) {
        const input = valid();
        delete input[key];
        assert.throws(() => createRenderDependencies(input), /RenderDependencies requires/, key);
    }
});
