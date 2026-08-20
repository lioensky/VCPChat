import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRenderDependencies } from '../modules/renderer/renderDependencies.js';

const ref = value => ({ get: () => value, set: next => { value = next; } });
const valid = () => {
    const dom = new JSDOM('<!doctype html><div id="chat"></div>');
    return {
    chatMessagesDiv: dom.window.document.getElementById('chat'),
    currentChatHistoryRef: ref([]),
    currentSelectedItemRef: ref({ id: 'a' }),
    currentTopicIdRef: ref('t'),
    globalSettingsRef: ref({}),
    electronAPI: {},
    chatRepository: { saveHistory() {} },
    historyMutationAuthority: { replace() {} },
    markedInstance: { parse: value => value },
    uiHelper: { scrollToBottom() {} },
    summarizeTopicFromMessages() {},
    handleCreateBranch() {},
    messageCommands: { handleSendMessage() {} },
    __dom: dom,
    };
};

test('RenderDependencies creates one frozen explicit capability closure', () => {
    const dependencies = createRenderDependencies(valid());
    assert.equal(Object.isFrozen(dependencies), true);
    assert.equal(Object.isFrozen(dependencies.state), true);
    assert.equal(dependencies.root, dependencies.chatMessagesDiv);
    assert.equal(dependencies.transport, dependencies.electronAPI);
    assert.equal(dependencies.state.history, dependencies.currentChatHistoryRef);
    assert.equal(typeof dependencies.messageCommands.handleSendMessage, 'function');
    assert.equal('chatManager' in dependencies, false,
        'the renderer closure must expose narrow message commands rather than the full chat manager');
    inputDomCleanup(dependencies);
});

function inputDomCleanup(dependencies) {
    dependencies.document?.defaultView?.close?.();
}

test('RenderDependencies fails fast for absent root, state, transport and parser powers', () => {
    for (const key of ['chatMessagesDiv', 'currentChatHistoryRef', 'electronAPI', 'markedInstance', 'historyMutationAuthority']) {
        const input = valid();
        delete input[key];
        assert.throws(() => createRenderDependencies(input), /RenderDependencies requires/, key);
        input.__dom?.window.close();
    }
});
