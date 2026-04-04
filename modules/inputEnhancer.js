// modules/inputEnhancer.js
console.log('[InputEnhancer] Module loaded.');

const LONG_TEXT_THRESHOLD = 2000; // Characters

// API is provided by renderer.js through refs so this module does not depend on a global preload alias.
let attachedFilesRef; // Reference to renderer.js's attachedFiles array
let updateAttachmentPreviewRef; // Reference to renderer.js's updateAttachmentPreview function
let currentAgentIdRef; // Function to get currentAgentId
let currentTopicIdRef; // Function to get currentTopicId
let electronApiRef; // Stable API reference for helper functions outside initializeInputEnhancer

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

    const messageInput = refs.messageInput;
    const dropTargetElement = refs.dropTargetElement || messageInput;
    let dragDepth = 0;

    const activateDropTarget = () => dropTargetElement.classList.add('drag-over');
    const deactivateDropTarget = () => {
        dragDepth = 0;
        dropTargetElement.classList.remove('drag-over');
    };

    // 1. Drag and Drop functionality
    dropTargetElement.addEventListener('dragenter', (event) => {
        event.preventDefault();
        event.stopPropagation();
        console.log('[InputEnhancer] dragenter event');
        dragDepth += 1;
        activateDropTarget();
    });

    dropTargetElement.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        if (!dropTargetElement.classList.contains('drag-over')) {
            activateDropTarget();
        }
    });

    dropTargetElement.addEventListener('dragleave', (event) => {
        event.preventDefault();
        event.stopPropagation();
        console.log('[InputEnhancer] dragleave event');
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
            dropTargetElement.classList.remove('drag-over');
        }
    });

    dropTargetElement.addEventListener('drop', async (event) => {
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
                // Always try to read the file as a Buffer/ArrayBuffer, regardless of 'path' property.
                // This is more robust for drag-and-drop in Electron.
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
                console.log('[InputEnhancer] Results from handleFileDrop:', results);
                if (results && results.length > 0) {
                    results.forEach(result => {
                        if (result.success && result.attachment) {
                            const att = result.attachment;
                            const currentFiles = attachedFilesRef.get();
                            currentFiles.push({
                                file: { name: att.name, type: att.type, size: att.size },
                                localPath: att.internalPath,
                                originalName: att.name,
                                _fileManagerData: att
                            });
                            attachedFilesRef.set(currentFiles);
                            console.log(`[InputEnhancer] Successfully attached dropped file: ${att.name}`);
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
    messageInput.addEventListener('paste', async (event) => {
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
                        await handlePastedFileSafe(file, agentId, topicId);
                        return; // 婢跺嫮鎮婄€瑰瞼顑囨稉鈧稉顏呮瀮娴犺泛姘ㄧ紒鎾存将
                    }
                }
            }
            // 婵″倹鐏夐張澶嬪焻閸ユ拝绱濇稊鐔虹暬閺傚洣娆㈤敍灞肩瑐闂堛垻娈戦柅鏄忕帆娴兼艾顦╅悶?
            const imageData = await localElectronAPI.readImageFromClipboard();
            if (imageData && imageData.data) {
                 await handlePastedImageDataSafe(imageData, agentId, topicId);
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
            await handleLongTextPasteSafe(pastedText, agentId, topicId);
            return;
        }

        // 3. 婵″倹鐏夐弮顫瑝閺勵垱鏋冩禒璁圭礉娑旂喍绗夐弰顖炴毐閺傚洦婀伴敍灞藉灟娑撳秵澧界悰灞兼崲娴ｆ洘鎼锋担婊愮礉閸忎浇顔忔妯款吇閻ㄥ嫮鐭樼拹纾嬵攽娑?
        console.log('[InputEnhancer] Paste is short text, allowing default behavior.');
    });

    console.log('[InputEnhancer] Event listeners attached to message input.');

    // Listen for files shared from other windows (like the music player)
    localElectronAPI.onAddFileToInput(async (filePath) => {
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
            const results = await localElectronAPI.handleFileDrop(agentId, topicId, [{ path: filePath, name: fileName }]);
            if (results && results.length > 0 && results[0].success && results[0].attachment) {
                const att = results[0].attachment;
                const currentFiles = attachedFilesRef.get();
                currentFiles.push({
                    file: { name: att.name, type: att.type, size: att.size },
                    localPath: att.internalPath,
                    originalName: att.name,
                    _fileManagerData: att
                });
                attachedFilesRef.set(currentFiles);
                updateAttachmentPreviewRef();
                console.log(`[InputEnhancer] Successfully attached shared file: ${att.name}`);
            } else {
                const errorMsg = results && results.length > 0 && results[0].error ? results[0].error : '閺堫亞鐓￠柨娆掝嚖';
                alert('附加分享的文件失败: ' + errorMsg);
            }
        } catch (err) {
            console.error('[InputEnhancer] Error attaching shared file:', err);
            alert('附加分享的文件时发生意外错误。');
        }
    });

    // --- @note Mention Functionality ---
    let noteSuggestionPopup = null;
    let activeSuggestionIndex = -1;

    messageInput.addEventListener('input', async () => {
        const text = messageInput.value;
        const cursorPos = messageInput.selectionStart;
        const atMatch = text.substring(0, cursorPos).match(/@([\w\u4e00-\u9fa5]*)$/);

        if (atMatch) {
            const query = atMatch[1];
            const notes = await localElectronAPI.searchNotes(query);
            if (notes.length > 0) {
                showNoteSuggestions(notes, query);
            } else {
                hideNoteSuggestions();
            }
        } else {
            hideNoteSuggestions();
        }
    });

    messageInput.addEventListener('keydown', (e) => {
        if (noteSuggestionPopup && noteSuggestionPopup.style.display === 'block') {
            const items = noteSuggestionPopup.querySelectorAll('.suggestion-item');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                activeSuggestionIndex = (activeSuggestionIndex + 1) % items.length;
                updateSuggestionHighlight();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                activeSuggestionIndex = (activeSuggestionIndex - 1 + items.length) % items.length;
                updateSuggestionHighlight();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (activeSuggestionIndex > -1) {
                    items[activeSuggestionIndex].click();
                }
            } else if (e.key === 'Escape') {
                hideNoteSuggestions();
            }
        }
    });

    function showNoteSuggestions(notes, query) {
        if (!noteSuggestionPopup) {
            noteSuggestionPopup = document.createElement('div');
            noteSuggestionPopup.id = 'note-suggestion-popup';
            document.body.appendChild(noteSuggestionPopup);
        }

        noteSuggestionPopup.innerHTML = '';
        notes.forEach((note, index) => {
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            
            // 閹绘劕褰囬惄绋款嚠鐠侯垰绶? 
            const relativePath = note.path.replace(/\\/g, '/').split('/').slice(-3, -1).join('/');  
            
            item.innerHTML = `  
                <span class="suggestion-name">${note.name}</span>  
                <span class="suggestion-path">${relativePath}</span>  
            `;  
            
            item.dataset.filePath = note.path;
            item.addEventListener('click', () => selectNoteSuggestion(note));
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
    }

    function updateSuggestionHighlight() {
        const items = noteSuggestionPopup.querySelectorAll('.suggestion-item');
        items.forEach((item, index) => {
            item.classList.toggle('active', index === activeSuggestionIndex);
        });
    }

    async function selectNoteSuggestion(note) {
        const agentId = currentAgentIdRef();
        const topicId = currentTopicIdRef();
        if (!agentId || !topicId) {
            alert('请先选择一个 Agent 和话题，才能附加笔记。');
            return;
        }

        // Replace the @mention text
        const text = messageInput.value;
        const cursorPos = messageInput.selectionStart;
        const textBeforeCursor = text.substring(0, cursorPos);
        const atMatch = textBeforeCursor.match(/@([\w\u4e00-\u9fa5]*)$/);
        if (atMatch) {
            const mentionLength = atMatch[0].length;
            const newText = text.substring(0, cursorPos - mentionLength) + text.substring(cursorPos);
            messageInput.value = newText;
        }

        hideNoteSuggestions();

        // Attach the file using existing logic
        try {
            const results = await localElectronAPI.handleFileDrop(agentId, topicId, [{
                path: note.path, // Pass the full path
                name: note.name
                // No need to specify type or data, main process will handle it
            }]);

            if (results && results.length > 0 && results[0].success && results[0].attachment) {
                const att = results[0].attachment;
                const currentFiles = attachedFilesRef.get();
                currentFiles.push({
                    file: { name: att.name, type: att.type, size: att.size },
                    localPath: att.internalPath,
                    originalName: att.name,
                    _fileManagerData: att
                });
                attachedFilesRef.set(currentFiles);
                updateAttachmentPreviewRef();
                console.log(`[InputEnhancer] Successfully attached note: ${att.name}`);
            } else {
                const errorMsg = results && results.length > 0 && results[0].error ? results[0].error : '閺堫亞鐓￠柨娆掝嚖';
                alert('附加笔记 "' + note.name + '" 失败: ' + errorMsg);
            }
        } catch (err) {
            console.error('[InputEnhancer] Error attaching note file:', err);
            alert('附加笔记 "' + note.name + '" 时发生意外错误。');
        }
    }
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

async function handlePastedFileSafe(file, agentId, topicId) {
    try {
        const localElectronAPI = getElectronApi();
        const fileBuffer = await readFileAsUint8Array(file);

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

        if (results && results.length > 0 && results[0].success && results[0].attachment) {
            const att = results[0].attachment;
            const currentFiles = attachedFilesRef.get();
            currentFiles.push({
                file: { name: att.name, type: att.type, size: att.size },
                localPath: att.internalPath,
                originalName: att.name,
                _fileManagerData: att
            });
            attachedFilesRef.set(currentFiles);
            updateAttachmentPreviewRef();
            return;
        }

        const errorMsg = results && results.length > 0 && results[0].error ? results[0].error : '未知错误';
        alert('粘贴文件 "' + file.name + '" 失败: ' + errorMsg);
    } catch (error) {
        console.error('[InputEnhancer] Failed to handle pasted file:', error);
        alert('粘贴文件 "' + file.name + '" 时发生错误: ' + error.message);
    }
}

async function handlePastedImageDataSafe(imageData, agentId, topicId) {
    try {
        const localElectronAPI = getElectronApi();
        const result = await localElectronAPI.handleFilePaste(agentId, topicId, {
            type: 'base64',
            data: imageData.data,
            extension: imageData.extension || 'png'
        });
        if (result.success && result.attachment) {
            const att = result.attachment;
            const currentFiles = attachedFilesRef.get();
            currentFiles.push({
                file: { name: att.name, type: att.type, size: att.size },
                localPath: att.internalPath,
                originalName: att.name,
                _fileManagerData: att
            });
            attachedFilesRef.set(currentFiles);
            updateAttachmentPreviewRef();
        } else {
            alert('无法从剪贴板粘贴图片: ' + (result.error || '截图处理失败'));
        }
    } catch (error) {
        console.error('[InputEnhancer] Failed to handle pasted image data:', error);
        alert('粘贴截图时发生错误: ' + error.message);
    }
}

async function handleLongTextPasteSafe(pastedText, agentId, topicId) {
    try {
        const localElectronAPI = getElectronApi();
        const result = await localElectronAPI.handleTextPasteAsFile(agentId, topicId, pastedText);
        if (result.success && result.attachment) {
            const att = result.attachment;
            const currentFiles = attachedFilesRef.get();
            currentFiles.push({
                file: { name: att.name, type: att.type, size: att.size },
                localPath: att.internalPath,
                originalName: att.name,
                _fileManagerData: att
            });
            attachedFilesRef.set(currentFiles);
            updateAttachmentPreviewRef();
        } else {
            alert('长文本转存为 .txt 文件失败: ' + (result.error || '未知错误'));
        }
    } catch (error) {
        console.error('[InputEnhancer] Failed to handle long text paste:', error);
        alert('长文本转存时发生错误: ' + error.message);
    }
}

async function handlePastedFile(file, agentId, topicId) {
    return handlePastedFileSafe(file, agentId, topicId);
}

async function handlePastedImageData(imageData, agentId, topicId) {
    return handlePastedImageDataSafe(imageData, agentId, topicId);
}

async function handleLongTextPaste(pastedText, agentId, topicId) {
    return handleLongTextPasteSafe(pastedText, agentId, topicId);
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
    initializeInputEnhancer
};
