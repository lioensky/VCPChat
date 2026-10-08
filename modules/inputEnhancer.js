// modules/inputEnhancer.js
console.log('[InputEnhancer] Module loaded.');

const LONG_TEXT_THRESHOLD = 2000; // Characters

// API is provided by renderer.js through refs so this module does not depend on a global preload alias.
let attachedFilesRef; // Reference to renderer.js's attachedFiles array
let updateAttachmentPreviewRef; // Reference to renderer.js's updateAttachmentPreview function
let currentAgentIdRef; // Function to get currentAgentId
let currentTopicIdRef; // Function to get currentTopicId
let electronApiRef; // Stable API reference for helper functions outside initializeInputEnhancer
let inputEnhancerDispose = async () => {};

/**
 * Initializes the input enhancer module.
 * @param {object} refs - References to functions and variables from renderer.js
 * @param {HTMLTextAreaElement} refs.messageInput - The message input textarea element.
 * @param {HTMLElement} [refs.dropTargetElement] - Optional drag-and-drop target container for the composer.
 * @param {object} refs.electronAPI - The exposed electron API from preload.js.
 * @param {Array} refs.attachedFiles - Reference to the array holding files to be attached.
 * @param {Function} refs.updateAttachmentPreview - Function to update the attachment preview UI.
 * @param {Function} refs.getCurrentAgentId - Function that returns the current agent ID.
 * @param {Function} refs.getCurrentTopicId - Function that returns the current topic ID.
 * @param {object} [refs.listenerOwner] - Renderer lifecycle owner for DOM listeners.
 */
function initializeInputEnhancer(refs) {
    if (!refs.messageInput || !refs.electronAPI || !refs.attachedFiles || !refs.updateAttachmentPreview || !refs.getCurrentAgentId || !refs.getCurrentTopicId) {
        console.error('[InputEnhancer] Initialization failed: Missing required references.');
        return;
    }
    const localElectronAPI = refs.electronAPI; // Use a local const to avoid confusion if needed, or directly use refs.electronAPI
    console.log('[InputEnhancer] Initializing with localElectronAPI:', localElectronAPI); // Log the API object
    attachedFilesRef = refs.attachedFiles;
    updateAttachmentPreviewRef = refs.updateAttachmentPreview;
    currentAgentIdRef = refs.getCurrentAgentId;
    currentTopicIdRef = refs.getCurrentTopicId;
    electronApiRef = localElectronAPI;

    void inputEnhancerDispose();
    const ownedDisposers = [];
    const lifecycle = { active: true, tasks: new Set(), disposal: null };
    const isActive = () => lifecycle.active;
    const track = value => {
        const task = Promise.resolve(value);
        lifecycle.tasks.add(task);
        task.finally(() => lifecycle.tasks.delete(task)).catch(() => {});
        return task;
    };
    const addListener = (target, type, handler, options) => {
        const ownedHandler = (...args) => {
            if (!isActive()) return;
            try {
                const result = handler(...args);
                return result?.then ? track(result) : result;
            } catch (error) {
                console.error(`[InputEnhancer] ${type} listener failed:`, error);
            }
        };
        if (!refs.listenerOwner?.add?.(target, type, ownedHandler, options)) {
            target?.addEventListener?.(type, ownedHandler, options);
        }
        ownedDisposers.push(() => target?.removeEventListener?.(type, ownedHandler, options));
    };
    inputEnhancerDispose = () => {
        if (lifecycle.disposal) return lifecycle.disposal;
        lifecycle.active = false;
        try {
            window.chatVoiceComposer?.dispose?.();
        } catch (_) {}
        ownedDisposers.splice(0).reverse().forEach(dispose => dispose());
        noteSuggestionPopup?.remove?.();
        noteSuggestionPopup = null;
        lifecycle.disposal = Promise.allSettled([...lifecycle.tasks]).then(() => {});
        return lifecycle.disposal;
    };
    const messageInput = refs.messageInput;
    const dropTargetElement = refs.dropTargetElement || messageInput;
    let dragDepth = 0;

    const activateDropTarget = () => dropTargetElement.classList.add('drag-over');
    const deactivateDropTarget = () => {
        dragDepth = 0;
        dropTargetElement.classList.remove('drag-over');
    };

    // 1. Drag and Drop functionality
    addListener(dropTargetElement, 'dragenter', (event) => {
        event.preventDefault();
        event.stopPropagation();
        console.log('[InputEnhancer] dragenter event');
        dragDepth += 1;
        activateDropTarget();
    });

    addListener(dropTargetElement, 'dragover', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        if (!dropTargetElement.classList.contains('drag-over')) {
            activateDropTarget();
        }
    });

    addListener(dropTargetElement, 'dragleave', (event) => {
        event.preventDefault();
        event.stopPropagation();
        console.log('[InputEnhancer] dragleave event');
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
            dropTargetElement.classList.remove('drag-over');
        }
    });

    addListener(dropTargetElement, 'drop', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        console.log('[InputEnhancer] drop event triggered.');
        deactivateDropTarget();

        const agentId = currentAgentIdRef();
        const topicId = currentTopicIdRef();
        console.log(`[InputEnhancer] Drop event - currentAgentId: ${agentId}, currentTopicId: ${topicId}`); // Added log

        if (!agentId || !topicId) {
            alert('请先选择一个 Agent 和话题，才能拖拽文件。');
            console.warn('[InputEnhancer] Drop aborted: Agent ID or Topic ID missing.');
            return;
        }

        const files = event.dataTransfer.files;
        if (files && files.length > 0) {
            console.log(`[InputEnhancer] Dropped ${files.length} files.`);
            const filesToProcess = [];

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                // 本地文件优先传真实路径：主进程据此识别工作区文件并建立实时引用，
                // 非工作区文件也由主进程按路径读取，无需在渲染进程整份读入内存。
                const realPath = getDroppedFilePath(localElectronAPI, file);
                if (realPath) {
                    filesToProcess.push(Promise.resolve({
                        name: file.name,
                        type: file.type || 'application/octet-stream',
                        size: file.size,
                        path: realPath
                    }));
                    continue;
                }
                // 无本地路径（例如从浏览器拖入的数据）时回退为读取内容。
                filesToProcess.push(new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        const arrayBuffer = e.target.result;
                        // If arrayBuffer is null or empty, it means FileReader couldn't read it.
                        if (!arrayBuffer) {
                            console.warn(`[InputEnhancer] FileReader received null ArrayBuffer for ${file.name}. Original size: ${file.size}.`);
                            resolve({ name: file.name, error: '无法读取文件内容' });
                            return;
                        }
                        const fileBuffer = new Uint8Array(arrayBuffer);
                        console.log(`[InputEnhancer] FileReader finished for ${file.name}. Size: ${file.size}, Buffer length: ${fileBuffer.length}, Type: ${file.type}`);
                        
                        // If fileBuffer is empty but original file size is not 0, it's still an issue.
                        // However, for very small files (e.g., 0-byte files), fileBuffer.length will be 0.
                        // We should allow 0-byte files to pass through if file.size is also 0.
                        // Removed the strict check for fileBuffer.length === 0 && file.size > 0 here,
                        // as it might be overly aggressive for certain file types or empty files.
                        // The main process's fileManager.storeFile will handle empty buffers.

                        resolve({
                            name: file.name,
                            type: file.type || 'application/octet-stream',
                            data: fileBuffer, // Send the buffer data
                            size: file.size
                        });
                    };
                    reader.onerror = (err) => {
                        console.error(`[InputEnhancer] FileReader error for ${file.name}:`, err);
                        resolve({ name: file.name, error: '无法读取文件: ' + err.message });
                    };
                    reader.readAsArrayBuffer(file);
                }));
            }

            const droppedFilesData = await Promise.all(filesToProcess);
            if (!isActive()) return;
            const successfulFiles = droppedFilesData.filter(f => !f.error);
            const failedFiles = droppedFilesData.filter(f => f.error);

            if (failedFiles.length > 0) {
                failedFiles.forEach(f => {
                    alert('处理拖拽的文件 ' + f.name + ' 失败: ' + f.error);
                    console.error(`[InputEnhancer] Failed to process dropped file ${f.name}: ${f.error}`);
                });
            }

            if (successfulFiles.length === 0) {
                console.warn('[InputEnhancer] No processable files found in drop event after reading attempts.');
                return;
            }

            try {
                console.log('[InputEnhancer] Calling localElectronAPI.handleFileDrop with:', agentId, topicId, successfulFiles.map(f => ({ name: f.name, type: f.type, size: f.size, data: f.data ? `[Buffer, length: ${f.data.length}]` : 'N/A' })));
                // Pass the actual buffers to main process
                const results = await localElectronAPI.handleFileDrop(agentId, topicId, successfulFiles);
                if (!isActive()) return;
                console.log('[InputEnhancer] Results from handleFileDrop:', results);
                if (results && results.length > 0) {
                    results.forEach(result => {
                        if (result.success && result.attachment) {
                            appendAttachment(result.attachment);
                            console.log(`[InputEnhancer] Successfully attached dropped file: ${result.attachment.name}`);
                        } else if (result.error) {
                            console.error(`[InputEnhancer] Error processing dropped file ${result.name || 'unknown'}: ${result.error}`);
                            alert('处理拖拽的文件 ' + (result.name || '未知文件') + ' 失败: ' + result.error);
                        }
                    });
                    updateAttachmentPreviewRef();
                }
            } catch (err) {
                console.error('[InputEnhancer] Error calling localElectronAPI.handleFileDrop IPC:', err);
                alert('处理拖拽的文件时发生意外错误。');
            }
        } else {
            console.log('[InputEnhancer] Drop event occurred but no files found in dataTransfer.');
        }
    });

    // 2. Enhanced Paste functionality
    addListener(messageInput, 'paste', async (event) => {
        const agentId = currentAgentIdRef();
        const topicId = currentTopicIdRef();
        const clipboardData = event.clipboardData || window.clipboardData;

        if (!clipboardData) return;

        // 1. 濡偓閺屻儲妲搁崥锔芥箒閺傚洣娆㈤幋鏍ф禈閻?
        const items = clipboardData.items;
        let hasFile = false;
        if (items && items.length > 0) {
            for (let i = 0; i < items.length; i++) {
                if (items[i].kind === 'file') {
                    hasFile = true;
                    break;
                }
            }
        }
        
        // 婵″倹鐏夐張澶嬫瀮娴犺绱濋崚娆撴▎濮濄垽绮拋銈堫攽娑撳搫鑻熸径鍕倞
        if (hasFile) {
            event.preventDefault();
            if (!agentId || !topicId) {
                alert('请先选择一个 Agent 和话题，再粘贴文件。');
                return;
            }
            // 鐎电粯澹樼粭顑跨娑擃亝鏋冩禒璺鸿嫙婢跺嫮鎮?
            for (let i = 0; i < items.length; i++) {
                if (items[i].kind === 'file') {
                    const file = items[i].getAsFile();
                    if (file) {
                        await handlePastedFileSafe(file, agentId, topicId, lifecycle, localElectronAPI);
                        return; // 婢跺嫮鎮婄€瑰瞼顑囨稉鈧稉顏呮瀮娴犺泛姘ㄧ紒鎾存将
                    }
                }
            }
            // 婵″倹鐏夐張澶嬪焻閸ユ拝绱濇稊鐔虹暬閺傚洣娆㈤敍灞肩瑐闂堛垻娈戦柅鏄忕帆娴兼艾顦╅悶?
            const imageData = await localElectronAPI.readImageFromClipboard();
            if (!isActive()) return;
            if (imageData && imageData.data) {
                 await handlePastedImageDataSafe(imageData, agentId, topicId, lifecycle, localElectronAPI);
                 return;
            }

        }

        // 2. 婵″倹鐏夊▽鈩冩箒閺傚洣娆㈤敍灞绢梾閺屻儲妲搁崥锔芥Ц闂€鎸庢瀮閺?
        const pastedText = clipboardData.getData('text/plain');
        if (pastedText && pastedText.length > LONG_TEXT_THRESHOLD) {
            event.preventDefault();
            if (!agentId || !topicId) {
                alert('请先选择一个 Agent 和话题，再粘贴长文本。');
                return;
            }
            await handleLongTextPasteSafe(pastedText, agentId, topicId, lifecycle, localElectronAPI);
            return;
        }

        // 3. 婵″倹鐏夐弮顫瑝閺勵垱鏋冩禒璁圭礉娑旂喍绗夐弰顖炴毐閺傚洦婀伴敍灞藉灟娑撳秵澧界悰灞兼崲娴ｆ洘鎼锋担婊愮礉閸忎浇顔忔妯款吇閻ㄥ嫮鐭樼拹纾嬵攽娑?
        console.log('[InputEnhancer] Paste is short text, allowing default behavior.');
    });

    console.log('[InputEnhancer] Event listeners attached to message input.');

    // Listen for files shared from other windows (like the music player)
    const consumeSharedFile = async (filePath) => {
        console.log(`[InputEnhancer] Received shared file path: ${filePath}`);
        const agentId = currentAgentIdRef();
        const topicId = currentTopicIdRef();

        if (!agentId || !topicId) {
            alert('请先选择一个 Agent 和话题，才能分享文件。');
            return;
        }

        // We can reuse the handleFileDrop logic. It's designed to take file paths.
        // The main process will read the file content from the path.
        try {
            // We need to get the filename from the path to mimic a real File object.
            const fileName = await window.electronPath.basename(filePath);
            if (!isActive()) return;
            const results = await localElectronAPI.handleFileDrop(agentId, topicId, [{ path: filePath, name: fileName }]);
            if (!isActive()) return;
            if (results && results.length > 0 && results[0].success && results[0].attachment) {
                const att = results[0].attachment;
                attachedFilesRef.append({
                    file: { name: att.name, type: att.type, size: att.size },
                    localPath: att.internalPath,
                    originalName: att.name,
                    _fileManagerData: att
                });
                updateAttachmentPreviewRef();
                console.log(`[InputEnhancer] Successfully attached shared file: ${att.name}`);
            } else {
                const errorMsg = results && results.length > 0 && results[0].error ? results[0].error : '閺堫亞鐓￠柨娆掝嚖';
                alert('附加分享的文件失败: ' + errorMsg);
            }
        } catch (err) {
            if (!isActive()) return;
            console.error('[InputEnhancer] Error attaching shared file:', err);
            alert('附加分享的文件时发生意外错误。');
        }
    };
    const sharedFileSubscription = localElectronAPI.onAddFileToInput(filePath => {
        if (!isActive()) return;
        return track(consumeSharedFile(filePath));
    });
    // Either the instance or its renderer owner may retire first; release once.
    let sharedFileReleased = false;
    const releaseSharedFile = () => {
        if (sharedFileReleased) return;
        sharedFileReleased = true;
        sharedFileSubscription?.();
    };
    ownedDisposers.push(releaseSharedFile);
    refs.listenerOwner?.own?.(releaseSharedFile);

    // --- @ 提及：笔记 + 工作区文件 ---
    // 语法：
    //   @关键词           同时搜索笔记与全部启用工作区的文件（只有一个工作区时即直接搜索它）；
    //   @别名/路径片段     限定在某个工作区内按文件名或相对路径搜索（多工作区时先补全别名）。
    let noteSuggestionPopup = null;
    let activeSuggestionIndex = -1;
    let currentSuggestions = [];
    let mentionSequence = 0;
    let workspaceCache = { at: 0, list: [], activeAlias: null };
    // 输入框工作区按钮切换后立即失效缓存，下一次 @ 使用新的搜索范围。
    addListener(window, 'vcp-active-workspace-changed', () => {
        workspaceCache = { at: 0, list: [], activeAlias: null };
    });
    const WORKSPACE_CACHE_MS = 5000;
    const MAX_SUGGESTIONS = 50;
    // @ 前必须是行首、空白或常见标点，避免把邮箱 a@b.com 当成提及。
    const MENTION_PATTERN = /(?:^|[\s(（\[【"'“‘，。、；：,;:])@([^\s@]*)$/;

    function getMentionMatch() {
        const cursorPos = messageInput.selectionStart;
        const before = messageInput.value.substring(0, cursorPos);
        const match = before.match(MENTION_PATTERN);
        if (!match) return null;
        const query = match[1];
        return { query, start: cursorPos - query.length - 1, end: cursorPos };
    }

    async function loadWorkspaces() {
        if (typeof localElectronAPI.listWorkspaces !== 'function') return [];
        if (Date.now() - workspaceCache.at < WORKSPACE_CACHE_MS) return workspaceCache.list;
        try {
            const result = await localElectronAPI.listWorkspaces();
            const list = Array.isArray(result?.workspaces)
                ? result.workspaces.filter(ws => ws && ws.enabled !== false && typeof ws.alias === 'string')
                : [];
            const active = list.find(ws => ws.id === result?.activeWorkspaceId);
            workspaceCache = { at: Date.now(), list, activeAlias: active ? active.alias : null };
        } catch (error) {
            console.warn('[InputEnhancer] Failed to list workspaces:', error);
            workspaceCache = { at: Date.now(), list: [], activeAlias: null };
        }
        return workspaceCache.list;
    }

    async function searchWorkspaceSafe(query, alias) {
        if (typeof localElectronAPI.searchWorkspaceFiles !== 'function') return [];
        try {
            const result = await localElectronAPI.searchWorkspaceFiles(query, { alias, limit: 30 });
            return Array.isArray(result?.results) ? result.results : [];
        } catch (error) {
            console.warn('[InputEnhancer] Failed to search workspace files:', error);
            return [];
        }
    }

    async function searchNotesSafe(query) {
        if (!query || typeof localElectronAPI.searchNotes !== 'function') return [];
        try {
            const notes = await localElectronAPI.searchNotes(query);
            return Array.isArray(notes) ? notes : [];
        } catch (error) {
            console.warn('[InputEnhancer] Failed to search notes:', error);
            return [];
        }
    }

    function toNoteSuggestion(note) {
        return {
            kind: 'note',
            name: note.name,
            path: note.path,
            detail: String(note.path || '').replace(/\\/g, '/').split('/').slice(-3, -1).join('/'),
            badge: '笔记',
        };
    }

    function toWorkspaceSuggestion(file) {
        const dir = file.relPath.includes('/') ? file.relPath.slice(0, file.relPath.lastIndexOf('/')) : '';
        return {
            kind: 'workspace',
            name: file.name,
            path: file.path,
            alias: file.alias,
            relPath: file.relPath,
            detail: dir ? `${file.alias}/${dir}` : file.alias,
            badge: file.alias,
        };
    }

    async function buildSuggestions(query) {
        const workspaces = await loadWorkspaces();
        const slash = query.indexOf('/');
        if (slash > 0) {
            const head = query.slice(0, slash).toLowerCase();
            const scoped = workspaces.find(ws => ws.alias === head);
            if (scoped) {
                const files = await searchWorkspaceSafe(query.slice(slash + 1), scoped.alias);
                return files.slice(0, MAX_SUGGESTIONS).map(toWorkspaceSuggestion);
            }
        }

        // 选定了当前工作区：@关键词 只搜笔记 + 当前工作区；@别名/ 仍可显式跨项目。
        const activeAlias = workspaceCache.activeAlias;
        if (activeAlias) {
            const [notes, files] = await Promise.all([
                searchNotesSafe(query),
                query ? searchWorkspaceSafe(query, activeAlias) : Promise.resolve([]),
            ]);
            return [...notes.map(toNoteSuggestion), ...files.map(toWorkspaceSuggestion)].slice(0, MAX_SUGGESTIONS);
        }

        const lower = query.toLowerCase();
        const aliasItems = workspaces.length > 1
            ? workspaces
                .filter(ws => ws.alias.startsWith(lower) && !query.includes('/'))
                .map(ws => ({ kind: 'alias', name: `${ws.alias}/`, alias: ws.alias, detail: ws.path, badge: '工作区' }))
            : [];
        const [notes, files] = await Promise.all([
            searchNotesSafe(query),
            query ? searchWorkspaceSafe(query, null) : Promise.resolve([]),
        ]);
        return [
            ...aliasItems,
            ...notes.map(toNoteSuggestion),
            ...files.map(toWorkspaceSuggestion),
        ].slice(0, MAX_SUGGESTIONS);
    }

    addListener(messageInput, 'input', async () => {
        const mention = getMentionMatch();
        const sequence = ++mentionSequence;
        if (!mention) {
            hideNoteSuggestions();
            return;
        }
        const suggestions = await buildSuggestions(mention.query);
        // 丢弃过期结果：用户在异步搜索期间已继续输入。
        if (!isActive() || sequence !== mentionSequence) return;
        if (suggestions.length > 0) {
            showNoteSuggestions(suggestions);
        } else {
            hideNoteSuggestions();
        }
    });

    addListener(messageInput, 'keydown', (e) => {
        if (e.isComposing || !noteSuggestionPopup || noteSuggestionPopup.style.display !== 'block') {
            return;
        }

        const items = noteSuggestionPopup.querySelectorAll('.suggestion-item');
        if (items.length === 0) {
            hideNoteSuggestions();
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopImmediatePropagation();
            activeSuggestionIndex = (activeSuggestionIndex + 1) % items.length;
            updateSuggestionHighlight();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopImmediatePropagation();
            activeSuggestionIndex = (activeSuggestionIndex - 1 + items.length) % items.length;
            updateSuggestionHighlight();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            // While the note picker is open, Enter/Tab confirm the highlighted
            // note instead of sending the message or moving focus out of input.
            e.preventDefault();
            e.stopImmediatePropagation();
            const selectedIndex = activeSuggestionIndex > -1 ? activeSuggestionIndex : 0;
            items[selectedIndex]?.click();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            hideNoteSuggestions();
        }
    }, true);

    // --- 输入框"当前工作区"按钮：全局一个，只决定 @关键词 的默认搜索范围 ---
    const workspacePickerBtn = document.getElementById('workspacePickerBtn');
    let workspaceMenu = null;

    function closeWorkspaceMenu({ restoreFocus = false } = {}) {
        if (!workspaceMenu) return;
        workspaceMenu.remove();
        workspaceMenu = null;
        workspacePickerBtn?.setAttribute('aria-expanded', 'false');
        if (restoreFocus) workspacePickerBtn?.focus();
    }
    ownedDisposers.push(() => closeWorkspaceMenu());

    function renderWorkspacePickerLabel(workspaces, activeId) {
        if (!workspacePickerBtn) return;
        const active = workspaces.find(ws => ws.id === activeId);
        const label = workspacePickerBtn.querySelector('.workspace-picker-label');
        if (label) label.textContent = active ? active.alias : '';
        workspacePickerBtn.classList.toggle('has-active-workspace', Boolean(active));
        const title = active ? `当前工作区：${active.alias}（${active.path}）` : '当前工作区：全部';
        workspacePickerBtn.title = title;
        workspacePickerBtn.setAttribute('aria-label', `选择当前工作区，${title}`);
    }

    async function refreshWorkspacePicker() {
        if (!workspacePickerBtn || typeof localElectronAPI.listWorkspaces !== 'function') return null;
        try {
            const result = await localElectronAPI.listWorkspaces();
            if (!isActive()) return null;
            const workspaces = Array.isArray(result?.workspaces) ? result.workspaces.filter(ws => ws.enabled !== false) : [];
            renderWorkspacePickerLabel(workspaces, result?.activeWorkspaceId || null);
            return { workspaces, activeWorkspaceId: result?.activeWorkspaceId || null };
        } catch (error) {
            console.warn('[InputEnhancer] Failed to refresh workspace picker:', error);
            return null;
        }
    }

    function openWorkspaceSettings() {
        document.getElementById('globalSettingsBtn')?.click();
        // 设置模态异步挂载，下一帧再切到"工作区管理"分区。
        setTimeout(() => {
            const tab = document.getElementById('vcpSettingsTab-workspace-management')
                || document.querySelector('[data-section="workspace-management"]');
            tab?.click();
        }, 150);
    }

    async function selectActiveWorkspace(workspaceId) {
        closeWorkspaceMenu({ restoreFocus: true });
        if (typeof localElectronAPI.setActiveWorkspace !== 'function') return;
        const result = await localElectronAPI.setActiveWorkspace(workspaceId);
        if (!isActive()) return;
        if (result?.success === false) console.warn('[InputEnhancer] Failed to set active workspace:', result.error);
        const workspaces = Array.isArray(result?.workspaces) ? result.workspaces.filter(ws => ws.enabled !== false) : [];
        renderWorkspacePickerLabel(workspaces, result?.activeWorkspaceId || null);
        window.dispatchEvent(new CustomEvent('vcp-active-workspace-changed', {
            detail: { activeWorkspaceId: result?.activeWorkspaceId || null },
        }));
    }

    async function openWorkspaceMenu() {
        const state = await refreshWorkspacePicker();
        if (!state || !isActive()) return;
        closeWorkspaceMenu();

        const menu = document.createElement('div');
        menu.id = 'workspace-picker-menu';
        menu.className = 'workspace-picker-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', '当前工作区');

        const addItem = (label, detail, { checked = null, onSelect }) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'workspace-picker-item';
            item.setAttribute('role', checked === null ? 'menuitem' : 'menuitemradio');
            if (checked !== null) item.setAttribute('aria-checked', checked ? 'true' : 'false');
            item.tabIndex = -1;
            const name = document.createElement('span');
            name.className = 'workspace-picker-item-name';
            name.textContent = label;
            item.append(name);
            if (detail) {
                const sub = document.createElement('span');
                sub.className = 'workspace-picker-item-detail';
                sub.textContent = detail;
                item.append(sub);
            }
            item.addEventListener('click', onSelect);
            menu.append(item);
            return item;
        };

        addItem('全部工作区', '@ 搜索所有已启用的工作区', {
            checked: !state.activeWorkspaceId,
            onSelect: () => selectActiveWorkspace(null),
        });
        for (const ws of state.workspaces) {
            addItem(ws.alias, ws.path, {
                checked: ws.id === state.activeWorkspaceId,
                onSelect: () => selectActiveWorkspace(ws.id),
            });
        }
        const separator = document.createElement('div');
        separator.className = 'workspace-picker-separator';
        separator.setAttribute('role', 'separator');
        menu.append(separator);
        addItem(state.workspaces.length ? '管理工作区…' : '添加工作区…', null, {
            onSelect: () => {
                closeWorkspaceMenu();
                openWorkspaceSettings();
            },
        });

        menu.addEventListener('keydown', event => {
            const items = [...menu.querySelectorAll('.workspace-picker-item')];
            const index = items.indexOf(document.activeElement);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                items[(index + delta + items.length) % items.length]?.focus();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                closeWorkspaceMenu({ restoreFocus: true });
            } else if (event.key === 'Tab') {
                closeWorkspaceMenu();
            }
        });

        document.body.appendChild(menu);
        const rect = workspacePickerBtn.getBoundingClientRect();
        menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
        menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
        workspaceMenu = menu;
        workspacePickerBtn.setAttribute('aria-expanded', 'true');
        (menu.querySelector('[aria-checked="true"]') || menu.querySelector('.workspace-picker-item'))?.focus();
    }

    if (workspacePickerBtn) {
        addListener(workspacePickerBtn, 'click', event => {
            event.preventDefault();
            if (workspaceMenu) {
                closeWorkspaceMenu();
                return;
            }
            return openWorkspaceMenu();
        });
        addListener(document, 'mousedown', event => {
            if (!workspaceMenu) return;
            if (workspaceMenu.contains(event.target) || workspacePickerBtn.contains(event.target)) return;
            closeWorkspaceMenu();
        }, true);
        // 设置页增删 / 重命名工作区后，按钮标签可能过期；聚焦窗口时顺手刷新。
        addListener(window, 'focus', () => refreshWorkspacePicker());
        void refreshWorkspacePicker();
    }

    function showNoteSuggestions(suggestions) {
        if (!noteSuggestionPopup) {
            noteSuggestionPopup = document.createElement('div');
            noteSuggestionPopup.id = 'note-suggestion-popup';
            noteSuggestionPopup.setAttribute('role', 'listbox');
            noteSuggestionPopup.setAttribute('aria-label', '笔记与工作区文件');
            document.body.appendChild(noteSuggestionPopup);
        }

        currentSuggestions = suggestions;
        noteSuggestionPopup.replaceChildren();
        suggestions.forEach(suggestion => {
            const item = document.createElement('div');
            item.className = `suggestion-item suggestion-kind-${suggestion.kind}`;
            item.setAttribute('role', 'option');

            // 文件名来自磁盘，一律用 textContent，避免文件名中的 HTML 被解析。
            const badge = document.createElement('span');
            badge.className = 'suggestion-source';
            badge.textContent = suggestion.badge;
            const name = document.createElement('span');
            name.className = 'suggestion-name';
            name.textContent = suggestion.name;
            const detail = document.createElement('span');
            detail.className = 'suggestion-path';
            detail.textContent = suggestion.detail || '';
            item.append(badge, name, detail);

            if (suggestion.path) item.dataset.filePath = suggestion.path;
            item.title = suggestion.relPath ? `${suggestion.alias}/${suggestion.relPath}` : (suggestion.path || suggestion.detail || '');
            // mousedown 阻止默认行为，保持输入框焦点与光标位置。
            addListener(item, 'mousedown', event => event.preventDefault());
            addListener(item, 'click', () => selectSuggestion(suggestion));
            noteSuggestionPopup.appendChild(item);
        });

        const rect = messageInput.getBoundingClientRect();
        noteSuggestionPopup.style.left = `${rect.left}px`;
        noteSuggestionPopup.style.bottom = `${window.innerHeight - rect.top}px`;
        noteSuggestionPopup.style.display = 'block';
        activeSuggestionIndex = 0;
        updateSuggestionHighlight();
    }

    function hideNoteSuggestions() {
        if (noteSuggestionPopup) {
            noteSuggestionPopup.style.display = 'none';
        }
        activeSuggestionIndex = -1;
        currentSuggestions = [];
    }

    function updateSuggestionHighlight() {
        const items = noteSuggestionPopup.querySelectorAll('.suggestion-item');
        items.forEach((item, index) => {
            const active = index === activeSuggestionIndex;
            item.classList.toggle('active', active);
            item.setAttribute('aria-selected', active ? 'true' : 'false');
            if (active) item.scrollIntoView?.({ block: 'nearest' });
        });
    }

    function replaceMention(replacement) {
        const mention = getMentionMatch();
        if (!mention) return;
        const text = messageInput.value;
        messageInput.value = text.substring(0, mention.start) + replacement + text.substring(mention.end);
        const cursor = mention.start + replacement.length;
        messageInput.selectionStart = cursor;
        messageInput.selectionEnd = cursor;
    }

    async function selectSuggestion(suggestion) {
        if (suggestion.kind === 'alias') {
            // 补全工作区别名后继续在该工作区内搜索。
            replaceMention(`@${suggestion.alias}/`);
            messageInput.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }

        const agentId = currentAgentIdRef();
        const topicId = currentTopicIdRef();
        const label = suggestion.kind === 'note' ? '笔记' : '工作区文件';
        if (!agentId || !topicId) {
            alert(`请先选择一个 Agent 和话题，才能附加${label}。`);
            return;
        }

        replaceMention('');
        hideNoteSuggestions();
        messageInput.dispatchEvent(new Event('input', { bubbles: true }));

        // 以"实时引用"方式附加：主进程不复制文件，附件路径直接指向真实文件，
        // AI 可以看到并修改该文件；文件更新后，上下文也会重新读取最新内容。
        // 工作区文件由主进程按路径自动识别归属，笔记显式标记 liveReference。
        try {
            const results = await localElectronAPI.handleFileDrop(agentId, topicId, [{
                path: suggestion.path,
                name: suggestion.name,
                liveReference: suggestion.kind === 'note'
            }]);
            if (!isActive()) return;

            if (results && results.length > 0 && results[0].success && results[0].attachment) {
                appendAttachment(results[0].attachment);
                updateAttachmentPreviewRef();
                console.log(`[InputEnhancer] Successfully attached ${suggestion.kind}: ${results[0].attachment.name}`);
            } else {
                const errorMsg = results && results.length > 0 && results[0].error ? results[0].error : '未知错误';
                alert(`附加${label} "${suggestion.name}" 失败: ${errorMsg}`);
            }
        } catch (err) {
            if (!isActive()) return;
            console.error('[InputEnhancer] Error attaching mention file:', err);
            alert(`附加${label} "${suggestion.name}" 时发生意外错误。`);
        }
    }

    if (typeof window !== 'undefined' && window.chatVoiceComposer?.init) {
        try {
            window.chatVoiceComposer.init({
                messageInput,
                electronAPI: localElectronAPI,
                attachedFiles: attachedFilesRef,
                updateAttachmentPreview: updateAttachmentPreviewRef,
                sendMessageBtn: typeof document !== 'undefined' ? document.getElementById('sendMessageBtn') : null,
                getCurrentAgentId: refs.getCurrentAgentId,
                getCurrentTopicId: refs.getCurrentTopicId,
                listenerOwner: refs.listenerOwner,
            });
        } catch (voiceInitErr) {
            console.warn('[InputEnhancer] chatVoiceComposer 初始化警告:', voiceInitErr);
        }
    }
}

// 渲染进程附件记录统一入口：实时引用标记同时写在顶层，供预览与上下文构建识别。
function appendAttachment(att) {
    attachedFilesRef.append({
        file: { name: att.name, type: att.type, size: att.size },
        localPath: att.internalPath,
        originalName: att.name,
        isLiveReference: att.isLiveReference === true,
        _fileManagerData: att
    });
}

// Electron 32+ 移除了 File.path，只能经由 preload 的 webUtils.getPathForFile 取真实路径。
function getDroppedFilePath(api, file) {
    try {
        const resolved = typeof api?.getPathForFile === 'function' ? api.getPathForFile(file) : '';
        if (typeof resolved === 'string' && resolved) return resolved;
    } catch (error) {
        console.warn('[InputEnhancer] getPathForFile failed:', error);
    }
    return typeof file?.path === 'string' && file.path ? file.path : '';
}

// --- Helper functions for paste handling ---

function getElectronApi() {
    if (!electronApiRef) {
        throw new Error('Chat API is not initialized for inputEnhancer.');
    }

    return electronApiRef;
}

function readFileAsUint8Array(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const arrayBuffer = event.target?.result;
            if (!(arrayBuffer instanceof ArrayBuffer)) {
                reject(new Error('无法读取粘贴文件内容。'));
                return;
            }

            resolve(new Uint8Array(arrayBuffer));
        };
        reader.onerror = () => reject(new Error('读取粘贴文件 "' + file.name + '" 失败。'));
        reader.readAsArrayBuffer(file);
    });
}

async function handlePastedFileSafe(file, agentId, topicId, lifecycle, localElectronAPI) {
    try {
        const fileBuffer = await readFileAsUint8Array(file);
        if (!lifecycle.active) return;

        if (fileBuffer.length === 0 && file.size !== 0) {
            alert('无法读取粘贴文件 "' + file.name + '" 的内容。');
            return;
        }

        const results = await localElectronAPI.handleFileDrop(agentId, topicId, [{
            name: file.name,
            type: file.type || 'application/octet-stream',
            data: fileBuffer,
            size: file.size
        }]);
        if (!lifecycle.active) return;

        if (results && results.length > 0 && results[0].success && results[0].attachment) {
            const att = results[0].attachment;
            attachedFilesRef.append({
                file: { name: att.name, type: att.type, size: att.size },
                localPath: att.internalPath,
                originalName: att.name,
                _fileManagerData: att
            });
            updateAttachmentPreviewRef();
            return;
        }

        const errorMsg = results && results.length > 0 && results[0].error ? results[0].error : '未知错误';
        alert('粘贴文件 "' + file.name + '" 失败: ' + errorMsg);
    } catch (error) {
        if (!lifecycle.active) return;
        console.error('[InputEnhancer] Failed to handle pasted file:', error);
        alert('粘贴文件 "' + file.name + '" 时发生错误: ' + error.message);
    }
}

async function handlePastedImageDataSafe(imageData, agentId, topicId, lifecycle, localElectronAPI) {
    try {
        const result = await localElectronAPI.handleFilePaste(agentId, topicId, {
            type: 'base64',
            data: imageData.data,
            extension: imageData.extension || 'png'
        });
        if (!lifecycle.active) return;
        if (result.success && result.attachment) {
            const att = result.attachment;
            attachedFilesRef.append({
                file: { name: att.name, type: att.type, size: att.size },
                localPath: att.internalPath,
                originalName: att.name,
                _fileManagerData: att
            });
            updateAttachmentPreviewRef();
        } else {
            alert('无法从剪贴板粘贴图片: ' + (result.error || '截图处理失败'));
        }
    } catch (error) {
        if (!lifecycle.active) return;
        console.error('[InputEnhancer] Failed to handle pasted image data:', error);
        alert('粘贴截图时发生错误: ' + error.message);
    }
}

async function handleLongTextPasteSafe(pastedText, agentId, topicId, lifecycle, localElectronAPI) {
    try {
        const result = await localElectronAPI.handleTextPasteAsFile(agentId, topicId, pastedText);
        if (!lifecycle.active) return;
        if (result.success && result.attachment) {
            const att = result.attachment;
            attachedFilesRef.append({
                file: { name: att.name, type: att.type, size: att.size },
                localPath: att.internalPath,
                originalName: att.name,
                _fileManagerData: att
            });
            updateAttachmentPreviewRef();
        } else {
            alert('长文本转存为 .txt 文件失败: ' + (result.error || '未知错误'));
        }
    } catch (error) {
        if (!lifecycle.active) return;
        console.error('[InputEnhancer] Failed to handle long text paste:', error);
        alert('长文本转存时发生错误: ' + error.message);
    }
}

async function handlePastedFile(file, agentId, topicId) {
    return handlePastedFileSafe(file, agentId, topicId, { active: true }, getElectronApi());
}

async function handlePastedImageData(imageData, agentId, topicId) {
    return handlePastedImageDataSafe(imageData, agentId, topicId, { active: true }, getElectronApi());
}

async function handleLongTextPaste(pastedText, agentId, topicId) {
    return handleLongTextPasteSafe(pastedText, agentId, topicId, { active: true }, getElectronApi());
}



function insertTextAtCursor(inputElement, text) {
    const start = inputElement.selectionStart;
    const end = inputElement.selectionEnd;
    const oldValue = inputElement.value;

    const newValue = oldValue.substring(0, start) + text + oldValue.substring(end);
    inputElement.value = newValue;

    const newCursorPos = start + text.length;
    inputElement.selectionStart = newCursorPos;
    inputElement.selectionEnd = newCursorPos;

    // Manually trigger an 'input' event so that other listeners (like auto-resize) can react.
    inputElement.dispatchEvent(new Event('input', { bubbles: true }));
}

window.inputEnhancer = {
    initializeInputEnhancer,
    dispose: () => inputEnhancerDispose()
};
