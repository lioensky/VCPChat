export function defineChatTabType({ provider, sidePaneController }) {
    return Object.freeze({
        kind: 'chat', label: '辅助对话', icon: 'chat_bubble', searchHint: '辅助对话',
        entry: { id: 'selection-side-conversation', order: 0, open: () => sidePaneController.openSideChat({ forceNew: true }) },
        provider
    });
}
