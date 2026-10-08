'use strict';

// 笔记：笔记窗口、迷你笔记、本地笔记树的增删改、网络笔记扫描、全文搜索。
// 主进程：modules/ipc/notesHandlers.js、modules/ipc/chatHandlers.js（save-pasted-image-to-file）、modules/ipc/desktopHandlers.js（shared-note-data）
const { invoke, send, on, onSignal } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/notesHandlers.js', 'modules/ipc/chatHandlers.js', 'modules/ipc/desktopHandlers.js'],
    roles: ['utility'],
    api: {
        openNotesWindow: invoke('open-notes-window', 'theme').roles('chat', 'utility'),
        openNotesWithContent: invoke('open-notes-with-content', 'data').roles('chat', 'utility'),
        openNoteMiniWindow: invoke('open-note-mini-window'),

        readNotesTree: invoke('read-notes-tree').roles('chat', 'utility'),
        writeTxtNote: invoke('write-txt-note', 'noteData'),
        saveMiniNote: invoke('save-mini-note', 'noteData').roles('chat', 'utility'),
        deleteItem: invoke('delete-item', 'itemPath'),
        createNoteFolder: invoke('create-note-folder', 'data'),
        renameItem: invoke('rename-item', 'data'),
        'notes:move-items': invoke('notes:move-items', 'data'),
        savePastedImageToFile: invoke('save-pasted-image-to-file', 'imageData', 'noteId'),
        getNotesRootDir: invoke('get-notes-root-dir'),
        copyNoteContent: invoke('copy-note-content', 'filePath'),
        onLocalNotesChanged: onSignal('local-notes-changed'),
        onSharedNoteData: on('shared-note-data'),

        scanNetworkNotes: send('scan-network-notes'),
        onNetworkNotesScanned: on('network-notes-scanned'),
        getCachedNetworkNotes: invoke('get-cached-network-notes'),

        // 聊天、桌面也用它做 @笔记 检索
        searchNotes: invoke('search-notes', 'queryText').roles('chat', 'utility', 'desktop'),
    },
};