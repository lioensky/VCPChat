const requireFunction = (value, label) => {
    if (typeof value !== 'function') throw new TypeError(`RenderDependencies requires ${label}`);
    return value;
};
const requireRef = (value, label, writable = false) => {
    if (!value || typeof value.get !== 'function' || (writable && typeof value.set !== 'function')) {
        throw new TypeError(`RenderDependencies requires ${label} ${writable ? 'read/write' : 'read'} ref`);
    }
    return value;
};

/** Explicit capability closure for the legacy DOM adapter during D4 migration. */
export function createRenderDependencies(input = {}) {
    const root = input.chatMessagesDiv;
    if (!root || typeof root.querySelector !== 'function' || typeof root.addEventListener !== 'function') {
        throw new TypeError('RenderDependencies requires a DOM root capability');
    }
    if (!input.electronAPI || typeof input.electronAPI !== 'object') {
        throw new TypeError('RenderDependencies requires an Electron transport capability');
    }
    if (!input.chatRepository || typeof input.chatRepository.saveHistory !== 'function') {
        throw new TypeError('RenderDependencies requires a chat repository capability');
    }
    if (!input.markedInstance || typeof input.markedInstance.parse !== 'function') {
        throw new TypeError('RenderDependencies requires a Markdown parser capability');
    }
    if (!input.uiHelper || typeof input.uiHelper.scrollToBottom !== 'function') {
        throw new TypeError('RenderDependencies requires feedback/navigation capabilities');
    }

    const state = Object.freeze({
        history: requireRef(input.currentChatHistoryRef, 'history', true),
        selection: requireRef(input.currentSelectedItemRef, 'selection', true),
        topic: requireRef(input.currentTopicIdRef, 'topic', true),
        settings: requireRef(input.globalSettingsRef, 'settings', true),
    });
    const commands = Object.freeze({
        summarizeTopic: requireFunction(input.summarizeTopicFromMessages, 'summarizeTopic'),
        createBranch: requireFunction(input.handleCreateBranch, 'createBranch'),
    });
    const closure = {
        root,
        state,
        transport: input.electronAPI,
        repository: input.chatRepository,
        markdown: input.markedInstance,
        feedback: input.uiHelper,
        commands,
        interrupt: input.interruptHandler || null,
        chatManager: input.chatManager || null,
        chatDomRenderer: input.chatDomRenderer || null,

        // Flat aliases are temporary D4 migration adapters, not public globals.
        chatMessagesDiv: root,
        currentChatHistoryRef: state.history,
        currentSelectedItemRef: state.selection,
        currentTopicIdRef: state.topic,
        globalSettingsRef: state.settings,
        electronAPI: input.electronAPI,
        chatRepository: input.chatRepository,
        markedInstance: input.markedInstance,
        uiHelper: input.uiHelper,
        summarizeTopicFromMessages: commands.summarizeTopic,
        handleCreateBranch: commands.createBranch,
        interruptHandler: input.interruptHandler || null,
        chatManager: input.chatManager || null,
    };
    return Object.freeze(closure);
}
