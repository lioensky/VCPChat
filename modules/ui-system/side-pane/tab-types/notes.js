import { createNotesSideProvider } from '../notesSideProvider.js';

export function defineNotesTabType({ document: doc, window: win, chatAPI, sidePaneController, uiHelper }) {
    const provider = createNotesSideProvider({ electronAPI: chatAPI, utilityAPI: win.utilityAPI, sidePaneController, uiHelper });
    return Object.freeze({
        kind: 'notes', label: '随手笔记', icon: 'edit_note', searchHint: '随手笔记',
        entry: { id: 'notes', order: 20, open: () => provider.openNotesTab() },
        provider
    });
}
