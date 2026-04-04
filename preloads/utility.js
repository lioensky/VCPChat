const { contextBridge, ipcRenderer } = require('electron');

function command(value) {
    return { kind: 'command', value };
}

function query(value) {
    return { kind: 'query', value };
}

function subscription(value) {
    return { kind: 'subscription', value };
}

function createOps() {
    const subscribeIpc = (channel, callback, mapper = (_event, ...args) => args) => {
        const listener = (event, ...args) => {
            const mapped = mapper(event, ...args);
            if (Array.isArray(mapped)) {
                callback(...mapped);
                return;
            }
            callback(mapped);
        };

        ipcRenderer.on(channel, listener);
        return () => {
            ipcRenderer.removeListener(channel, listener);
        };
    };

    return {
        invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
        send: (channel, ...args) => ipcRenderer.send(channel, ...args),
        subscribe: (channel, mapper) => (callback) => subscribeIpc(channel, callback, mapper),
        pathApi: {
            dirname: (filePath) => ipcRenderer.invoke('path:dirname', filePath),
            extname: (filePath) => ipcRenderer.invoke('path:extname', filePath),
            basename: (filePath) => ipcRenderer.invoke('path:basename', filePath),
        },
    };
}

function materializeApi(definitions, keys) {
    return keys.reduce((api, key) => {
        if (definitions[key]) {
            api[key] = definitions[key].value;
        }
        return api;
    }, {});
}

function createIsolationMessage(name) {
    return `权限已隔离: ${name}`;
}

function createIsolationStub(name, kind) {
    const message = createIsolationMessage(name);

    if (kind === 'subscription') {
        return () => {
            console.error(message);
            return () => {};
        };
    }

    if (kind === 'query') {
        return () => {
            console.error(message);
            return Promise.reject(new Error(message));
        };
    }

    return () => {
        console.error(message);
    };
}

function createCompatApi(definitions, allowedKeys) {
    const compatApi = {};
    const allowedKeySet = new Set(allowedKeys);

    for (const [key, definition] of Object.entries(definitions)) {
        compatApi[key] = allowedKeySet.has(key)
            ? definition.value
            : createIsolationStub(key, definition.kind);
    }

    return compatApi;
}

function exposeRoleApis(roleApiName, roleApi, compatApi, ops) {
    contextBridge.exposeInMainWorld('electronPath', ops.pathApi);
    contextBridge.exposeInMainWorld(roleApiName, roleApi);
    contextBridge.exposeInMainWorld('electronAPI', compatApi);
}

function createCatalog(ops) {
    return {
        // Shared shell/config/theme helpers
        loadSettings: query(() => ops.invoke('load-settings')),
        saveSettings: query((settings) => ops.invoke('save-settings', settings)),
        saveUserAvatar: query((avatarData) => ops.invoke('save-user-avatar', avatarData)),
        saveAvatarColor: query((data) => ops.invoke('save-avatar-color', data)),
        readImageFromClipboard: query(async () => {
            const result = await ops.invoke('read-image-from-clipboard-main');
            if (result && result.success) {
                return { data: result.data, extension: result.extension };
            }
            return null;
        }),
        readTextFromClipboard: query(async () => {
            const result = await ops.invoke('read-text-from-clipboard-main');
            if (result && result.success) {
                return result.text;
            }
            return '';
        }),
        minimizeWindow: command(() => ops.send('minimize-window')),
        maximizeWindow: command(() => ops.send('maximize-window')),
        unmaximizeWindow: command(() => ops.send('unmaximize-window')),
        closeWindow: command(() => ops.send('close-window')),
        hideWindow: command(() => ops.send('hide-window')),
        openDevTools: command(() => ops.send('open-dev-tools')),
        sendToggleNotificationsSidebar: command(() => ops.send('toggle-notifications-sidebar')),
        onDoToggleNotificationsSidebar: subscription(ops.subscribe('do-toggle-notifications-sidebar', () => undefined)),
        openAdminPanel: query(() => ops.invoke('open-admin-panel')),
        onWindowMaximized: subscription(ops.subscribe('window-maximized', () => undefined)),
        onWindowUnmaximized: subscription(ops.subscribe('window-unmaximized', () => undefined)),
        onWindowOccluded: subscription(ops.subscribe('window-occluded', (_event, occluded) => occluded)),
        minimizeToTray: command(() => ops.send('minimize-to-tray')),
        closeApp: command(() => ops.send('close-app')),
        showImageContextMenu: command((imageUrl) => ops.send('show-image-context-menu', imageUrl)),
        openImageViewer: command((data) => ops.send('open-image-viewer', data)),
        openImageInNewWindow: command((imageUrl, imageTitle) => ops.send('open-image-in-new-window', imageUrl, imageTitle)),
        openTextInNewWindow: query((textContent, windowTitle, theme) => ops.invoke('display-text-content-in-viewer', textContent, windowTitle, theme)),
        sendOpenExternalLink: command((url) => ops.send('open-external-link', url)),
        onThemeUpdated: subscription(ops.subscribe('theme-updated', (_event, theme) => theme)),
        getCurrentTheme: query(() => ops.invoke('get-current-theme')),
        setTheme: command((theme) => ops.send('set-theme', theme)),
        setThemeMode: command((themeMode) => ops.send('set-theme-mode', themeMode)),
        getPlatform: query(() => ops.invoke('get-platform')),
        getWallpaperThumbnail: query((filePath) => ops.invoke('get-wallpaper-thumbnail', filePath)),

        // Shared window launching
        openNotesWindow: query((theme) => ops.invoke('open-notes-window', theme)),
        openNotesWithContent: query((data) => ops.invoke('open-notes-with-content', data)),
        openTranslatorWindow: query((theme) => ops.invoke('open-translator-window', theme)),
        openRAGObserverWindow: query(() => ops.invoke('open-rag-observer-window')),
        openThemesWindow: command(() => ops.send('open-themes-window')),
        openVoiceChatWindow: command((data) => ops.send('open-voice-chat-window', data)),
        openForumWindow: command(() => ops.send('open-forum-window')),
        openMemoWindow: command(() => ops.send('open-memo-window')),
        openMusicWindow: command(() => ops.send('open-music-window')),
        openDiceWindow: query(() => ops.invoke('open-dice-window')),
        openCanvasWindow: query(() => ops.invoke('open-canvas-window')),
        openDesktopWindow: query(() => ops.invoke('open-desktop-window')),

        // Chat/app shell APIs
        getAgents: query(() => ops.invoke('get-agents')),
        getAgentConfig: query((agentId) => ops.invoke('get-agent-config', agentId)),
        saveAgentConfig: query((agentId, config) => ops.invoke('save-agent-config', agentId, config)),
        selectAvatar: query(() => ops.invoke('select-avatar')),
        saveAvatar: query((agentId, avatarData) => ops.invoke('save-avatar', agentId, avatarData)),
        createAgent: query((agentName, initialConfig) => ops.invoke('create-agent', agentName, initialConfig)),
        deleteAgent: query((agentId) => ops.invoke('delete-agent', agentId)),
        getCachedModels: query(() => ops.invoke('get-cached-models')),
        refreshModels: command(() => ops.send('refresh-models')),
        getHotModels: query(() => ops.invoke('get-hot-models')),
        getFavoriteModels: query(() => ops.invoke('get-favorite-models')),
        toggleFavoriteModel: query((modelId) => ops.invoke('toggle-favorite-model', modelId)),
        onModelsUpdated: subscription(ops.subscribe('models-updated', (_event, models) => models)),
        getAllItems: query(() => ops.invoke('get-all-items')),
        importRegexRules: query((agentId) => ops.invoke('import-regex-rules', agentId)),
        updateAgentConfig: query((agentId, updates) => ops.invoke('update-agent-config', agentId, updates)),
        getGlobalWarehouse: query(() => ops.invoke('get-global-warehouse')),
        saveGlobalWarehouse: query((data) => ops.invoke('save-global-warehouse', data)),
        loadPresetPrompts: query((presetPath) => ops.invoke('load-preset-prompts', presetPath)),
        loadPresetContent: query((filePath) => ops.invoke('load-preset-content', filePath)),
        selectDirectory: query(() => ops.invoke('select-directory')),
        getActiveSystemPrompt: query((agentId) => ops.invoke('get-active-system-prompt', agentId)),
        programmaticSetPromptMode: query((agentId, mode) => ops.invoke('programmatic-set-prompt-mode', agentId, mode)),
        onReloadAgentSettings: subscription(ops.subscribe('reload-agent-settings', (_event, data) => data)),
        getAgentTopics: query((agentId) => ops.invoke('get-agent-topics', agentId)),
        createNewTopicForAgent: query((agentId, topicName, isBranch, locked) => ops.invoke('create-new-topic-for-agent', agentId, topicName, isBranch, locked)),
        saveAgentTopicTitle: query((agentId, topicId, newTitle) => ops.invoke('save-agent-topic-title', agentId, topicId, newTitle)),
        deleteTopic: query((agentId, topicId) => ops.invoke('delete-topic', agentId, topicId)),
        getUnreadTopicCounts: query(() => ops.invoke('get-unread-topic-counts')),
        toggleTopicLock: query((agentId, topicId) => ops.invoke('toggle-topic-lock', agentId, topicId)),
        setTopicUnread: query((agentId, topicId, unread) => ops.invoke('set-topic-unread', agentId, topicId, unread)),
        onCreateUnlockedTopic: subscription(ops.subscribe('create-unlocked-topic', () => undefined)),
        getChatHistory: query((agentId, topicId) => ops.invoke('get-chat-history', agentId, topicId)),
        saveChatHistory: query((agentId, topicId, history) => ops.invoke('save-chat-history', agentId, topicId, history)),
        getOriginalMessageContent: query((itemId, itemType, topicId, messageId) => ops.invoke('get-original-message-content', itemId, itemType, topicId, messageId)),
        handleFilePaste: query((agentId, topicId, fileData) => ops.invoke('handle-file-paste', agentId, topicId, fileData)),
        selectFilesToSend: query((agentId, topicId) => ops.invoke('select-files-to-send', agentId, topicId)),
        getFileAsBase64: query((filePath) => ops.invoke('get-file-as-base64', filePath)),
        getTextContent: query((filePath, fileType) => ops.invoke('get-text-content', filePath, fileType)),
        handleTextPasteAsFile: query((agentId, topicId, textContent) => ops.invoke('handle-text-paste-as-file', agentId, topicId, textContent)),
        handleFileDrop: query((agentId, topicId, droppedFilesData) => ops.invoke('handle-file-drop', agentId, topicId, droppedFilesData)),
        onAddFileToInput: subscription(ops.subscribe('add-file-to-input', (_event, filePath) => filePath)),
        saveAgentOrder: query((orderedAgentIds) => ops.invoke('save-agent-order', orderedAgentIds)),
        saveTopicOrder: query((agentId, orderedTopicIds) => ops.invoke('save-topic-order', agentId, orderedTopicIds)),
        saveCombinedItemOrder: query((orderedItemsWithTypes) => ops.invoke('save-combined-item-order', orderedItemsWithTypes)),
        sendToVCP: query((vcpUrl, vcpApiKey, messages, modelConfig, messageId, isGroupCall, context) => ops.invoke('send-to-vcp', vcpUrl, vcpApiKey, messages, modelConfig, messageId, isGroupCall, context)),
        onVCPStreamEvent: subscription(ops.subscribe('vcp-stream-event', (_event, eventData) => eventData)),
        onVCPStreamChunk: subscription(ops.subscribe('vcp-stream-chunk', (_event, chunkData) => chunkData)),
        interruptVcpRequest: query((data) => ops.invoke('interrupt-vcp-request', data)),
        createAgentGroup: query((groupName, initialConfig) => ops.invoke('create-agent-group', groupName, initialConfig)),
        getAgentGroups: query(() => ops.invoke('get-agent-groups')),
        getAgentGroupConfig: query((groupId) => ops.invoke('get-agent-group-config', groupId)),
        saveAgentGroupConfig: query((groupId, configData) => ops.invoke('save-agent-group-config', groupId, configData)),
        deleteAgentGroup: query((groupId) => ops.invoke('delete-agent-group', groupId)),
        saveAgentGroupAvatar: query((groupId, avatarData) => ops.invoke('save-agent-group-avatar', groupId, avatarData)),
        getGroupTopics: query((groupId, searchTerm) => ops.invoke('get-group-topics', groupId, searchTerm)),
        createNewTopicForGroup: query((groupId, topicName) => ops.invoke('create-new-topic-for-group', groupId, topicName)),
        deleteGroupTopic: query((groupId, topicId) => ops.invoke('delete-group-topic', groupId, topicId)),
        saveGroupTopicTitle: query((groupId, topicId, newTitle) => ops.invoke('save-group-topic-title', groupId, topicId, newTitle)),
        getGroupChatHistory: query((groupId, topicId) => ops.invoke('get-group-chat-history', groupId, topicId)),
        saveGroupChatHistory: query((groupId, topicId, history) => ops.invoke('save-group-chat-history', groupId, topicId, history)),
        sendGroupChatMessage: query((groupId, topicId, userMessage) => ops.invoke('send-group-chat-message', groupId, topicId, userMessage)),
        onVCPGroupTopicUpdated: subscription(ops.subscribe('vcp-group-topic-updated', (_event, eventData) => eventData)),
        onHistoryFileUpdated: subscription(ops.subscribe('history-file-updated', (_event, data) => data)),
        saveGroupTopicOrder: query((groupId, orderedTopicIds) => ops.invoke('save-group-topic-order', groupId, orderedTopicIds)),
        searchTopicsByContent: query((itemId, itemType, searchTerm) => ops.invoke('search-topics-by-content', itemId, itemType, searchTerm)),
        inviteAgentToSpeak: query((groupId, topicId, invitedAgentId) => ops.invoke('inviteAgentToSpeak', groupId, topicId, invitedAgentId)),
        redoGroupChatMessage: query((groupId, topicId, messageId, agentId) => ops.invoke('redo-group-chat-message', groupId, topicId, messageId, agentId)),
        interruptGroupRequest: query((messageId) => ops.invoke('interrupt-group-request', messageId)),
        exportTopicAsMarkdown: query((exportData) => ops.invoke('export-topic-as-markdown', exportData)),
        connectVCPLog: command((url, key) => ops.send('connect-vcplog', { url, key })),
        disconnectVCPLog: command(() => ops.send('disconnect-vcplog')),
        onVCPLogMessage: subscription(ops.subscribe('vcp-log-message', (_event, value) => value)),
        onVCPLogStatus: subscription(ops.subscribe('vcp-log-status', (_event, value) => value)),
        sendVCPLogMessage: command((data) => ops.send('send-vcplog-message', data)),
        toggleSelectionListener: command((enable) => ops.send('toggle-selection-listener', enable)),
        getSelectionListenerStatus: query(() => ops.invoke('get-selection-listener-status')),
        suspendAssistantListener: query((durationMs) => ops.invoke('assistant-suspend-listener', durationMs)),
        getAssistantRuntimeStatus: query(() => ops.invoke('get-assistant-runtime-status')),
        getRustAssistantConfig: query(() => ops.invoke('get-rust-assistant-config')),
        saveRustAssistantConfig: query((configPatch) => ops.invoke('save-rust-assistant-config', configPatch)),
        assistantAction: command((action) => ops.send('assistant-action', action)),
        closeAssistantBar: command(() => ops.send('close-assistant-bar')),
        onAssistantBarData: subscription(ops.subscribe('assistant-bar-data', (_event, data) => data)),
        getAssistantBarInitialData: query(() => ops.invoke('get-assistant-bar-initial-data')),
        onAssistantData: subscription(ops.subscribe('assistant-data', (_event, data) => data)),
        sovitsGetModels: query((forceRefresh = false) => ops.invoke('sovits-get-models', forceRefresh)),
        sovitsSpeak: command((options) => ops.send('sovits-speak', options)),
        sovitsStop: command(() => ops.send('sovits-stop')),
        onPlayTtsAudio: subscription(ops.subscribe('play-tts-audio', (_event, data) => data)),
        onStopTtsAudio: subscription(ops.subscribe('stop-tts-audio', () => undefined)),
        getEmoticonLibrary: query(() => ops.invoke('get-emoticon-library')),
        onVoiceChatData: subscription(ops.subscribe('voice-chat-data', (_event, data) => data)),
        startSpeechRecognition: command(() => ops.send('start-speech-recognition')),
        stopSpeechRecognition: command(() => ops.send('stop-speech-recognition')),
        onSpeechRecognitionResult: subscription(ops.subscribe('speech-recognition-result', (_event, text) => text)),
        onFlowlockCommand: subscription(ops.subscribe('flowlock-command', (_event, data) => data)),
        onFlowlockRequest: subscription(ops.subscribe('flowlock:request', (_event, data) => data)),
        sendFlowlockRpcResponse: command((data) => ops.send('flowlock:response', data)),

        // Utility APIs
        readNotesTree: query(() => ops.invoke('read-notes-tree')),
        writeTxtNote: query((noteData) => ops.invoke('write-txt-note', noteData)),
        deleteItem: query((itemPath) => ops.invoke('delete-item', itemPath)),
        createNoteFolder: query((data) => ops.invoke('create-note-folder', data)),
        renameItem: query((data) => ops.invoke('rename-item', data)),
        'notes:move-items': query((data) => ops.invoke('notes:move-items', data)),
        savePastedImageToFile: query((imageData, noteId) => ops.invoke('save-pasted-image-to-file', imageData, noteId)),
        getNotesRootDir: query(() => ops.invoke('get-notes-root-dir')),
        copyNoteContent: query((filePath) => ops.invoke('copy-note-content', filePath)),
        scanNetworkNotes: command(() => ops.send('scan-network-notes')),
        onNetworkNotesScanned: subscription(ops.subscribe('network-notes-scanned', (_event, networkTree) => networkTree)),
        getCachedNetworkNotes: query(() => ops.invoke('get-cached-network-notes')),
        searchNotes: query((queryText) => ops.invoke('search-notes', queryText)),
        onSharedNoteData: subscription(ops.subscribe('shared-note-data', (_event, data) => data)),
        loadForumConfig: query(() => ops.invoke('load-forum-config')),
        saveForumConfig: query((config) => ops.invoke('save-forum-config', config)),
        loadAgentsList: query(() => ops.invoke('load-agents-list')),
        loadUserAvatar: query(() => ops.invoke('load-user-avatar')),
        loadAgentAvatar: query((folderName) => ops.invoke('load-agent-avatar', folderName)),
        loadMemoConfig: query(() => ops.invoke('load-memo-config')),
        saveMemoConfig: query((config) => ops.invoke('save-memo-config', config)),
        getThemes: query(() => ops.invoke('get-themes')),
        applyTheme: command((fileName) => ops.send('apply-theme', fileName)),
        executePythonCode: query((code) => ops.invoke('execute-python-code', code)),
        windowReady: command((appId, payload = {}) => ops.send('window-lifecycle:ready', { appId, ...payload })),
        canvasReady: command(() => ops.send('canvas-ready')),
        createNewCanvas: command(() => ops.send('create-new-canvas')),
        loadCanvasFile: command((filePath) => ops.send('load-canvas-file', filePath)),
        saveCanvasFile: command((file) => ops.send('save-canvas-file', file)),
        onCanvasLoadData: subscription(ops.subscribe('canvas-load-data', (_event, data) => data)),
        onCanvasFileChanged: subscription(ops.subscribe('canvas-file-changed', (_event, file) => file)),
        onExternalFileChanged: subscription(ops.subscribe('external-file-changed', (_event, file) => file)),
        onCanvasContentUpdate: subscription(ops.subscribe('canvas-content-update', (_event, data) => data)),
        onLoadCanvasFileByPath: subscription(ops.subscribe('load-canvas-file-by-path', (_event, filePath) => filePath)),
        onCanvasWindowClosed: subscription(ops.subscribe('canvas-window-closed', () => undefined)),
        renameCanvasFile: query((data) => ops.invoke('rename-canvas-file', data)),
        copyCanvasFile: command((filePath) => ops.send('copy-canvas-file', filePath)),
        deleteCanvasFile: command((filePath) => ops.send('delete-canvas-file', filePath)),
        getLatestCanvasContent: query(() => ops.invoke('get-latest-canvas-content')),
        watcherStart: query((filePath, agentId, topicId) => ops.invoke('watcher:start', filePath, agentId, topicId)),
        watcherStop: query(() => ops.invoke('watcher:stop')),
        onRollDice: subscription(ops.subscribe('roll-dice', (_event, notation, options) => [notation, options])),
        sendDiceModuleReady: command(() => ops.send('dice-module-ready')),
        sendDiceRollComplete: command((results) => ops.send('dice-roll-complete', results)),
        ragOverlayShow: command((payload) => ops.send('rag-overlay-show', payload)),
        ragOverlayHide: command(() => ops.send('rag-overlay-hide')),
        ragOverlaySetEnabled: command((enabled) => ops.send('rag-overlay-set-enabled', enabled)),
        ragOverlaySetOpacity: command((opacity) => ops.send('rag-overlay-set-opacity', opacity)),
        ragOverlaySetPassThrough: command((passThrough) => ops.send('rag-overlay-set-pass-through', passThrough)),
        ragOverlayResize: command((payload) => ops.send('rag-overlay-resize', payload)),
        ragOverlayGetBounds: query(() => ops.invoke('rag-overlay-get-bounds')),
        ragOverlayGetState: query(() => ops.invoke('rag-overlay-get-state')),
        sendRagOverlayApprovalAction: command((payload) => ops.send('rag-overlay-approval-action', payload)),
        onRagOverlayPayload: subscription(ops.subscribe('rag-overlay-payload', (_event, payload) => payload)),
        onRagOverlayPassThroughChanged: subscription(ops.subscribe('rag-overlay-pass-through-changed', (_event, payload) => payload)),
        onRagOverlayApprovalAction: subscription(ops.subscribe('rag-overlay-approval-action', (_event, payload) => payload)),

        // Music-specific utility APIs
        getMusicPlaylist: query(() => ops.invoke('get-music-playlist')),
        saveMusicPlaylist: query((playlist) => ops.invoke('save-music-playlist', playlist)),
        getCustomPlaylists: query(() => ops.invoke('get-custom-playlists')),
        saveCustomPlaylists: query((playlists) => ops.invoke('save-custom-playlists', playlists)),
        musicLoad: query((track) => ops.invoke('music-load', track)),
        musicPlay: query(() => ops.invoke('music-play')),
        musicPause: query(() => ops.invoke('music-pause')),
        seekMusic: query((position) => ops.invoke('music-seek', position)),
        getMusicState: query(() => ops.invoke('music-get-state')),
        setMusicVolume: query((volume) => ops.invoke('music-set-volume', volume)),
        addMusicFolder: query(() => ops.invoke('music-add-folder')),
        shareMusicTrack: query((trackPath) => ops.invoke('music-share-track', trackPath)),
        getMusicDevices: query((options) => ops.invoke('music-get-devices', options)),
        configureMusicOutput: query((options) => ops.invoke('music-configure-output', options)),
        setMusicEq: query((options) => ops.invoke('music-set-eq', options)),
        setMusicEqType: query((options) => ops.invoke('music-set-eq-type', options)),
        configureMusicOptimizations: query((options) => ops.invoke('music-configure-optimizations', options)),
        configureMusicUpsampling: query((options) => ops.invoke('music-configure-upsampling', options)),
        getMusicLyrics: query((options) => ops.invoke('music-get-lyrics', options)),
        fetchMusicLyrics: query((options) => ops.invoke('music-fetch-lyrics', options)),
        queueNextMusicTrack: query((track) => ops.invoke('music-queue-next', track)),
        cancelMusicPreload: query(() => ops.invoke('music-cancel-preload')),
        musicLoadIr: query((options) => ops.invoke('music-load-ir', options)),
        musicUnloadIr: query(() => ops.invoke('music-unload-ir')),
        selectMusicIrFile: query(() => ops.invoke('select-ir-file')),
        configureMusicNormalization: query((options) => ops.invoke('music-configure-normalization', options)),
        getMusicLoudnessInfo: query((options) => ops.invoke('music-get-loudness-info', options)),
        scanMusicLoudness: query((options) => ops.invoke('music-scan-loudness', options)),
        scanMusicLoudnessInBackground: query((options) => ops.invoke('music-scan-loudness-background', options)),
        getMusicSaturation: query(() => ops.invoke('music-get-saturation')),
        setMusicSaturation: query((options) => ops.invoke('music-set-saturation', options)),
        getMusicCrossfeed: query(() => ops.invoke('music-get-crossfeed')),
        setMusicCrossfeed: query((options) => ops.invoke('music-set-crossfeed', options)),
        getMusicDynamicLoudness: query(() => ops.invoke('music-get-dynamic-loudness')),
        setMusicDynamicLoudness: query((options) => ops.invoke('music-set-dynamic-loudness', options)),
        configureMusicOutputBits: query((options) => ops.invoke('music-configure-output-bits', options)),
        setMusicNoiseShaperCurve: query((options) => ops.invoke('music-set-noise-shaper-curve', options)),
        getMusicIrStatus: query(() => ops.invoke('music-get-ir-status')),
        listMusicIrPresets: query(() => ops.invoke('music-list-ir-presets')),
        getMusicIrPresetPath: query((presetName) => ops.invoke('music-get-ir-preset-path', presetName)),
        configureMusicResampling: query((options) => ops.invoke('music-configure-resampling', options)),
        getMusicSettings: query(() => ops.invoke('music-get-settings')),
        saveMusicSettings: query((settings) => ops.invoke('music-save-settings', settings)),
        getMusicPendingTrack: query(() => ops.invoke('music-get-pending-track')),
        musicRendererReady: command(() => ops.send('music-renderer-ready')),
        onMusicFiles: subscription(ops.subscribe('music-files', (_event, data) => data)),
        onMusicScanStart: subscription(ops.subscribe('music-scan-start', () => undefined)),
        onMusicScanProgress: subscription(ops.subscribe('music-scan-progress', (_event, data) => data)),
        onMusicScanComplete: subscription(ops.subscribe('music-scan-complete', (_event, data) => data)),
        onAudioEngineError: subscription(ops.subscribe('audio-engine-error', (_event, data) => data)),
        onMusicSetTrack: subscription(ops.subscribe('music-set-track', (_event, track) => track)),
        onMusicControl: subscription(ops.subscribe('music-control', (_event, commandData) => commandData)),
        sendMusicRemoteCommand: command((command) => ops.send('music-remote-command', command)),
        onWebdavScanProgress: subscription(ops.subscribe('webdav-scan-progress', (_event, data) => data)),
        listWebdavServers: query(() => ops.invoke('webdav-list-servers')),
        removeWebdavServer: query((data) => ops.invoke('webdav-remove-server', data)),
        testWebdavConnection: query((data) => ops.invoke('webdav-test-connection', data)),
        listWebdavDirectory: query((data) => ops.invoke('webdav-list-directory', data)),
        scanWebdavAudio: query((data) => ops.invoke('webdav-scan-audio', data)),
        getWebdavFileUrl: query((data) => ops.invoke('webdav-get-file-url', data)),
        loadWebdavTrack: query((data) => ops.invoke('webdav-load-track', data)),
        addWebdavServer: query((data) => ops.invoke('webdav-add-server', data)),

        // Desktop APIs
        desktopPush: command((data) => ops.send('desktop-push', data)),
        onDesktopPush: subscription(ops.subscribe('desktop-push-to-canvas', (_event, data) => data)),
        onDesktopStatus: subscription(ops.subscribe('desktop-status', (_event, data) => data)),
        onDesktopRemoteSetWallpaper: subscription(ops.subscribe('desktop-remote-set-wallpaper', (_event, data) => data)),
        onDesktopRemoteRequest: subscription(ops.subscribe('desktop-remote:request', (_event, data) => data)),
        sendDesktopRemoteResponse: command((data) => ops.send('desktop-remote:response', data)),
        desktopSaveWidget: query((data) => ops.invoke('desktop-save-widget', data)),
        desktopLoadWidget: query((id) => ops.invoke('desktop-load-widget', id)),
        desktopDeleteWidget: query((id) => ops.invoke('desktop-delete-widget', id)),
        desktopListWidgets: query(() => ops.invoke('desktop-list-widgets')),
        desktopSaveWidgetFile: query((data) => ops.invoke('desktop-save-widget-file', data)),
        desktopLoadWidgetFile: query((data) => ops.invoke('desktop-load-widget-file', data)),
        desktopListWidgetFiles: query((widgetId) => ops.invoke('desktop-list-widget-files', widgetId)),
        desktopCaptureWidget: query((rect) => ops.invoke('desktop-capture-widget', rect)),
        desktopGetCredentials: query(() => ops.invoke('desktop-get-credentials')),
        desktopShortcutParse: query((filePath) => ops.invoke('desktop-shortcut-parse', filePath)),
        desktopShortcutParseBatch: query((filePaths) => ops.invoke('desktop-shortcut-parse-batch', filePaths)),
        desktopShortcutLaunch: query((shortcutData) => ops.invoke('desktop-shortcut-launch', shortcutData)),
        desktopScanShortcuts: query(() => ops.invoke('desktop-scan-shortcuts')),
        desktopSaveDock: query((dockData) => ops.invoke('desktop-save-dock', dockData)),
        desktopLoadDock: query(() => ops.invoke('desktop-load-dock')),
        desktopSaveLayout: query((layoutData) => ops.invoke('desktop-save-layout', layoutData)),
        desktopLoadLayout: query(() => ops.invoke('desktop-load-layout')),
        desktopIconsetListPresets: query(() => ops.invoke('desktop-iconset-list-presets')),
        desktopIconsetListIcons: query((params) => ops.invoke('desktop-iconset-list-icons', params)),
        desktopIconsetGetIconData: query((relativePath) => ops.invoke('desktop-iconset-get-icon-data', relativePath)),
        desktopLaunchVchatApp: query((appAction) => ops.invoke('desktop-launch-vchat-app', appAction)),
        desktopSelectWallpaper: query(() => ops.invoke('desktop-select-wallpaper')),
        desktopReadWallpaperThumbnail: query((filePath) => ops.invoke('desktop-read-wallpaper-thumbnail', filePath)),
        setAlwaysOnBottom: query((enabled) => ops.invoke('desktop-set-always-on-bottom', enabled)),
        desktopMetricsGetSnapshot: query((options = {}) => ops.invoke('desktop-metrics-get-snapshot', options)),
        desktopMetricsGetCapabilities: query(() => ops.invoke('desktop-metrics-get-capabilities')),
        desktopMetricsGetDetailedProcesses: query(() => ops.invoke('desktop-metrics-get-detailed-processes')),
        desktopOpenSystemTool: query((cmd) => ops.invoke('desktop-open-system-tool', cmd)),
    };
}

const ALLOWED_KEYS = [
    "loadSettings",
    "saveSettings",
    "saveUserAvatar",
    "saveAvatarColor",
    "readImageFromClipboard",
    "readTextFromClipboard",
    "minimizeWindow",
    "maximizeWindow",
    "unmaximizeWindow",
    "closeWindow",
    "hideWindow",
    "openDevTools",
    "sendToggleNotificationsSidebar",
    "onDoToggleNotificationsSidebar",
    "openAdminPanel",
    "onWindowMaximized",
    "onWindowUnmaximized",
    "showImageContextMenu",
    "openImageViewer",
    "openImageInNewWindow",
    "openTextInNewWindow",
    "sendOpenExternalLink",
    "onThemeUpdated",
    "getCurrentTheme",
    "setTheme",
    "setThemeMode",
    "getPlatform",
    "getWallpaperThumbnail",
    "openNotesWindow",
    "openNotesWithContent",
    "openTranslatorWindow",
    "openRAGObserverWindow",
    "openThemesWindow",
    "openVoiceChatWindow",
    "openForumWindow",
    "openMemoWindow",
    "openMusicWindow",
    "openCanvasWindow",
    "openDesktopWindow",
    "loadForumConfig",
    "saveForumConfig",
    "getTextContent",
    "loadAgentsList",
    "loadUserAvatar",
    "loadAgentAvatar",
    "loadMemoConfig",
    "saveMemoConfig",
    "getThemes",
    "applyTheme",
    "executePythonCode",
    "readNotesTree",
    "writeTxtNote",
    "deleteItem",
    "createNoteFolder",
    "renameItem",
    "notes:move-items",
    "savePastedImageToFile",
    "getNotesRootDir",
    "copyNoteContent",
    "scanNetworkNotes",
    "onNetworkNotesScanned",
    "getCachedNetworkNotes",
    "searchNotes",
    "onSharedNoteData",
    "windowReady",
    "canvasReady",
    "createNewCanvas",
    "loadCanvasFile",
    "saveCanvasFile",
    "onCanvasLoadData",
    "onCanvasFileChanged",
    "onExternalFileChanged",
    "onCanvasContentUpdate",
    "onLoadCanvasFileByPath",
    "onCanvasWindowClosed",
    "renameCanvasFile",
    "copyCanvasFile",
    "deleteCanvasFile",
    "getLatestCanvasContent",
    "watcherStart",
    "watcherStop",
    "openDiceWindow",
    "onRollDice",
    "sendDiceModuleReady",
    "sendDiceRollComplete",
    "ragOverlayShow",
    "ragOverlayHide",
    "ragOverlaySetEnabled",
    "ragOverlaySetOpacity",
    "ragOverlaySetPassThrough",
    "ragOverlayResize",
    "ragOverlayGetBounds",
    "ragOverlayGetState",
    "sendRagOverlayApprovalAction",
    "onRagOverlayPayload",
    "onRagOverlayPassThroughChanged",
    "onRagOverlayApprovalAction",
    "sendVCPLogMessage",
    "minimizeToTray",
    "getMusicPlaylist",
    "saveMusicPlaylist",
    "getCustomPlaylists",
    "saveCustomPlaylists",
    "musicLoad",
    "musicPlay",
    "musicPause",
    "seekMusic",
    "getMusicState",
    "setMusicVolume",
    "addMusicFolder",
    "shareMusicTrack",
    "getMusicDevices",
    "configureMusicOutput",
    "setMusicEq",
    "setMusicEqType",
    "configureMusicOptimizations",
    "configureMusicUpsampling",
    "getMusicLyrics",
    "fetchMusicLyrics",
    "queueNextMusicTrack",
    "cancelMusicPreload",
    "musicLoadIr",
    "musicUnloadIr",
    "selectMusicIrFile",
    "configureMusicNormalization",
    "getMusicLoudnessInfo",
    "scanMusicLoudness",
    "scanMusicLoudnessInBackground",
    "getMusicSaturation",
    "setMusicSaturation",
    "getMusicCrossfeed",
    "setMusicCrossfeed",
    "getMusicDynamicLoudness",
    "setMusicDynamicLoudness",
    "configureMusicOutputBits",
    "setMusicNoiseShaperCurve",
    "getMusicIrStatus",
    "listMusicIrPresets",
    "getMusicIrPresetPath",
    "configureMusicResampling",
    "getMusicSettings",
    "saveMusicSettings",
    "getMusicPendingTrack",
    "musicRendererReady",
    "onMusicFiles",
    "onMusicScanStart",
    "onMusicScanProgress",
    "onMusicScanComplete",
    "onAudioEngineError",
    "onMusicSetTrack",
    "onMusicControl",
    "onWebdavScanProgress",
    "listWebdavServers",
    "removeWebdavServer",
    "testWebdavConnection",
    "listWebdavDirectory",
    "scanWebdavAudio",
    "getWebdavFileUrl",
    "loadWebdavTrack",
    "addWebdavServer",
    "toggleSelectionListener",
    "getSelectionListenerStatus",
    "getEmoticonLibrary"
];

const ops = createOps();
const definitions = createCatalog(ops);
const roleApi = materializeApi(definitions, ALLOWED_KEYS);
const compatApi = createCompatApi(definitions, ALLOWED_KEYS);

exposeRoleApis('utilityAPI', roleApi, compatApi, ops);

console.log('[Preload][utility] loaded');
