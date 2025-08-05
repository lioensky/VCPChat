document.addEventListener('DOMContentLoaded', async () => {
    // --- DOM Element References ---
    const noteList = document.getElementById('noteList');
    const newMdBtn = document.getElementById('newMdBtn');
    const newTxtBtn = document.getElementById('newTxtBtn');
    const newFolderBtn = document.getElementById('newFolderBtn');
    const saveNoteBtn = document.getElementById('saveNoteBtn');
    const deleteNoteBtn = document.getElementById('deleteNoteBtn');
    const noteTitleInput = document.getElementById('noteTitle');
    const noteContentInput = document.getElementById('noteContent');
    const searchInput = document.getElementById('searchInput');
    const previewContentDiv = document.getElementById('previewContent');
    const editorBubble = document.querySelector('.editor-bubble');
    const previewBubble = document.querySelector('.preview-bubble');
    const customContextMenu = document.getElementById('customContextMenu');
    const resizer = document.getElementById('resizer');
    const sidebar = document.querySelector('.sidebar');
    const confirmationModal = document.getElementById('confirmationModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalMessage = document.getElementById('modalMessage');
    const modalConfirmBtn = document.getElementById('modalConfirmBtn');
    const modalCancelBtn = document.getElementById('modalCancelBtn');

    // --- Custom Title Bar Elements ---
    const minimizeNotesBtn = document.getElementById('minimize-notes-btn');
    const maximizeNotesBtn = document.getElementById('maximize-notes-btn');
    const closeNotesBtn = document.getElementById('close-notes-btn');

    // --- State Management ---
    let localNoteTree = []; // Stores the local note hierarchy
    let networkNoteTree = []; // Stores the network note hierarchy as an array of trees
    let activeNoteId = null; // ID of the note currently being edited
    let activeItemId = null; // ID of the last clicked item (note or folder)
    let selectedItems = new Set(); // Stores IDs of all selected items for multi-select
    let deleteTimer = null;
    let currentUsername = 'defaultUser';
    let expandedFolders = new Set(); // Stores IDs of EXPANDED folders to persist state
    let wasSelectionListenerActive = false; // To store the state of the selection listener before dragging
    // --- Drag & Drop State ---
    let dragState = {
        sourceIds: null,
        lastDragOverElement: null,
        dropAction: null, // Can be 'before', 'after', 'inside'
    };

    // --- SVG Icons ---
    const FOLDER_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="item-icon"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"></path></svg>`;
    const NOTE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="item-icon"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"></path></svg>`;
    const TOGGLE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="folder-toggle"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"></path></svg>`;


    // --- Debounce & Utility Functions ---
    const debounce = (func, delay) => {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), delay);
        };
    };

    const throttle = (func, limit) => {
        let lastFunc;
        let lastRan;
        return function() {
            const context = this;
            const args = arguments;
            if (!lastRan) {
                func.apply(context, args);
                lastRan = Date.now();
            } else {
                clearTimeout(lastFunc);
                lastFunc = setTimeout(function() {
                    if ((Date.now() - lastRan) >= limit) {
                        func.apply(context, args);
                        lastRan = Date.now();
                    }
                }, limit - (Date.now() - lastRan));
            }
        }
    };

    function showButtonFeedback(button, originalText, feedbackText, isSuccess = true, duration = 2000) {
        const feedbackClass = isSuccess ? 'button-success' : 'button-error';
        button.textContent = feedbackText;
        button.classList.add(feedbackClass);
        button.disabled = true;
        setTimeout(() => {
            button.textContent = originalText;
            button.classList.remove(feedbackClass);
            button.disabled = false;
            button.blur();
        }, duration);
    }

    // --- Confirmation Modal Logic ---
    function showConfirmationModal(title, message) {
        return new Promise((resolve) => {
            modalTitle.textContent = title;
            modalMessage.innerHTML = message; // Use innerHTML for simple formatting
            confirmationModal.style.display = 'flex';

            const confirmHandler = () => {
                cleanup();
                resolve(true);
            };

            const cancelHandler = () => {
                cleanup();
                resolve(false);
            };

            const cleanup = () => {
                modalConfirmBtn.removeEventListener('click', confirmHandler);
                modalCancelBtn.removeEventListener('click', cancelHandler);
                confirmationModal.style.display = 'none';
            };

            modalConfirmBtn.addEventListener('click', confirmHandler);
            modalCancelBtn.addEventListener('click', cancelHandler);
        });
    }

    // --- Theme Management ---
    function applyTheme(theme) {
        const currentTheme = theme || 'dark'; // Fallback to dark if theme is null/undefined
        const highlightThemeStyle = document.getElementById('highlight-theme-style');
        
        document.body.classList.toggle('light-theme', currentTheme === 'light');

        if (highlightThemeStyle) {
            highlightThemeStyle.href = currentTheme === 'light'
                ? "../vendor/atom-one-light.min.css"
                : "../vendor/atom-one-dark.min.css";
        }
    }
    

    // --- Markdown & Preview Rendering ---
    // --- Start: Ported Pre-processing functions ---
    function deIndentHtml(text) {
        if (typeof text !== 'string') return text;
        const lines = text.split('\n');
        let inFence = false;
        return lines.map(line => {
            if (line.trim().startsWith('```')) {
                inFence = !inFence;
                return line;
            }
            if (!inFence && line.trim().startsWith('<')) {
                return line.trimStart();
            }
            return line;
        }).join('\n');
    }

    function addParserBreakerBetweenDivAndCode(text) {
        if (typeof text !== 'string') return text;
        const regex = /(<\/div>)\s*(```(?=[\s\S]*?(?:<<<\[TOOL_REQUEST\]>>>|<<<DailyNoteStart>>>)))/g;
        return text.replace(regex, '$1\n\n<!-- -->\n\n$2');
    }

    function ensureSpecialBlockFenced(text, startTag, endTag) {
        if (typeof text !== 'string' || !text.includes(startTag)) return text;
        const regex = new RegExp(`(\`\`\`[\\s\\S]*?${startTag}[\\s\\S]*?${endTag}[\\s\\S]*?\`\`\`)|(${startTag}[\\s\\S]*?${endTag})`, 'g');
        return text.replace(regex, (match, fencedBlock, unfencedBlock) => {
            if (fencedBlock) return fencedBlock;
            if (unfencedBlock) return `\n\`\`\`\n${unfencedBlock}\n\`\`\`\n`;
            return match;
        });
    }
    
    function ensureHtmlFenced(text) {
        if (typeof text !== 'string') return text;
        const doctypeTag = '<!DOCTYPE html>';
        if (!text.toLowerCase().includes(doctypeTag.toLowerCase())) return text;
        let result = '';
        let lastIndex = 0;
        while (true) {
            const startIndex = text.toLowerCase().indexOf(doctypeTag.toLowerCase(), lastIndex);
            const textSegment = text.substring(lastIndex, startIndex === -1 ? text.length : startIndex);
            result += textSegment;
            if (startIndex === -1) break;
            const endIndex = text.toLowerCase().indexOf('</html>', startIndex + doctypeTag.length);
            if (endIndex === -1) {
                result += text.substring(startIndex);
                break;
            }
            const block = text.substring(startIndex, endIndex + '</html>'.length);
            const fencesInResult = (result.match(/```/g) || []).length;
            if (fencesInResult % 2 === 0) {
                result += `\n\`\`\`html\n${block}\n\`\`\`\n`;
            } else {
                result += block;
            }
            lastIndex = endIndex + '</html>'.length;
        }
        return result;
    }

    function preprocessFullContent(text) {
        if (typeof text !== 'string') return text;

        const htmlBlockMap = new Map();
        let placeholderId = 0;

        // Step 1: Find and protect ```html blocks.
        let processed = text.replace(/```html([\s\S]*?)```/g, (match) => {
            const placeholder = `__VCP_HTML_BLOCK_PLACEHOLDER_${placeholderId}__`;
            htmlBlockMap.set(placeholder, match);
            placeholderId++;
            return placeholder;
        });

        // Step 2: Run existing pre-processing on the text with placeholders.
        processed = deIndentHtml(processed);
        processed = addParserBreakerBetweenDivAndCode(processed);
        processed = ensureSpecialBlockFenced(processed, '<<<[TOOL_REQUEST]>>>', '<<<[END_TOOL_REQUEST]>>>');
        processed = ensureSpecialBlockFenced(processed, '<<<DailyNoteStart>>>', '<<<DailyNoteEnd>>>');
        processed = ensureHtmlFenced(processed);
        processed = processed.replace(/^(\s*```)(?![\r\n])/gm, '$1\n');
        processed = processed.replace(/~(?![\s~])/g, '~ ');
        processed = processed.replace(/^(\s*)(```.*)/gm, '$2');
        processed = processed.replace(/(<img[^>]+>)\s*(```)/g, '$1\n\n<!-- VCP-Renderer-Separator -->\n\n$2');
        
        // Step 3: Restore the protected ```html blocks.
        if (htmlBlockMap.size > 0) {
            for (const [placeholder, block] of htmlBlockMap.entries()) {
                processed = processed.replace(placeholder, block);
            }
        }

        return processed;
    }
    // --- End: Ported functions ---

    function renderMarkdown(markdown) {
        if (!window.marked || !window.hljs) {
            previewContentDiv.textContent = markdown;
            return;
        }

        // Use the full pre-processing pipeline
        const processedMarkdown = preprocessFullContent(markdown);

        // Sanitize local image paths (this part is specific to notes.js)
        const sanitizedMarkdown = processedMarkdown.replace(/!\[(.*?)\]\(file:\/\/([^)]+)\)/g, (match, alt, url) => {
            const correctedUrl = url.replace(/\\/g, '/');
            return `![${alt}](file://${correctedUrl})`;
        });

        const rawHtml = marked.parse(sanitizedMarkdown);
        
        // --- Style Extraction & Sanitization ---
        // Extract <style> blocks to prevent DOMPurify from stripping their content.
        const styleRegex = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
        const styleBlocks = rawHtml.match(styleRegex) || [];
        const htmlWithoutStyles = rawHtml.replace(styleRegex, '');

        // Sanitize the rest of the HTML.
        const cleanHtmlBody = DOMPurify.sanitize(htmlWithoutStyles, {
            // We don't need to allow 'style' tags here anymore as they are handled separately.
            ADD_TAGS: ['img', 'div'],
            ADD_ATTR: ['style'], // Still allow inline styles on elements like <div style="...">.
            ALLOW_UNKNOWN_PROTOCOLS: true,
            FORCE_BODY: true
        });

        // Re-combine the sanitized body with the original, un-sanitized style blocks.
        previewContentDiv.innerHTML = styleBlocks.join('\n') + cleanHtmlBody;

        // Post-rendering enhancements
        if (window.renderMathInElement) {
            renderMathInElement(previewContentDiv, {
                delimiters: [
                    { left: "$$", right: "$$", display: true },
                    { left: "$", right: "$", display: false },
                ],
                throwOnError: false
            });
        }
        previewContentDiv.querySelectorAll('pre code').forEach(hljs.highlightElement);
        addCopyButtonsToCodeBlocks();
        makeImagesClickable();
    }

    function addCopyButtonsToCodeBlocks() {
        previewContentDiv.querySelectorAll('pre code.hljs').forEach(block => {
            const preElement = block.parentElement;
            if (preElement.querySelector('.copy-button')) return;
            preElement.style.position = 'relative';
            const copyButton = document.createElement('button');
            copyButton.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
            copyButton.className = 'copy-button';
            copyButton.title = '复制';
            copyButton.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(block.innerText).then(() => {
                    copyButton.style.borderColor = 'var(--success-color)';
                    setTimeout(() => { copyButton.style.borderColor = ''; }, 1500);
                }).catch(err => console.error('无法复制:', err));
            });
            preElement.appendChild(copyButton);
        });
    }

    function makeImagesClickable() {
        previewContentDiv.querySelectorAll('img').forEach(img => {
            img.style.cursor = 'pointer';
            img.addEventListener('click', (e) => {
                e.preventDefault();
                const imageUrl = img.getAttribute('src');
                const imageTitle = img.getAttribute('alt') || '图片预览';
                if (window.electronAPI && window.electronAPI.openImageInNewWindow) {
                    window.electronAPI.openImageInNewWindow(imageUrl, imageTitle);
                } else {
                    console.error('Image viewer API is not available.');
                }
            });
        });
    }

    // --- Core Data & File System Logic ---
    async function loadNoteTree() {
        try {
            const result = await window.electronAPI.readNotesTree();
            if (result.error) {
                console.error('加载笔记树失败:', result.error);
                localNoteTree = [];
            } else {
                localNoteTree = result;
            }
            renderTree();
            // Restore active/selected state if needed
            if (activeNoteId) {
                const item = findItemById(getCombinedTree(), activeNoteId);
                if (item) {
                    selectNote(item.id, item.path);
                } else {
                    clearNoteEditor();
                }
            } else {
                 clearNoteEditor();
            }
        } catch (error) {
            console.error('加载笔记树时发生异常:', error);
        }
    }

    function getCombinedTree() {
        return [...networkNoteTree, ...localNoteTree];
    }

    function findItemById(tree, id) {
        for (const item of tree) {
            if (item.id === id) return item;
            if (item.type === 'folder' && item.children) {
                const found = findItemById(item.children, id);
                if (found) return found;
            }
        }
        return null;
    }

    function isCloudItem(id) {
        if (!networkNoteTree || networkNoteTree.length === 0) return false;
        // Check if the item exists within any of the network tree structures
        return findItemById(networkNoteTree, id) !== null;
    }
    
    async function getParentPath(itemId) {
        const item = findItemById(getCombinedTree(), itemId);
        if (!item || !item.path) return null;
        return await window.electronPath.dirname(item.path);
    }

    // --- DOM Rendering ---
    function renderTree() {
        noteList.innerHTML = '';
        const filter = searchInput.value.toLowerCase();
        const combinedTree = getCombinedTree();
        const filteredTree = filter ? filterTree(combinedTree, filter) : combinedTree;
        
        const fragment = document.createDocumentFragment();
        filteredTree.forEach(item => fragment.appendChild(createTreeElement(item)));
        noteList.appendChild(fragment);
    }

    function filterTree(tree, filter) {
        const result = [];
        for (const item of tree) {
            if (item.type === 'note') {
                if (item.title.toLowerCase().includes(filter) || item.content.toLowerCase().includes(filter)) {
                    result.push(item);
                }
            } else if (item.type === 'folder') {
                const children = filterTree(item.children, filter);
                if (children.length > 0 || item.name.toLowerCase().includes(filter)) {
                    result.push({ ...item, children: children });
                }
            }
        }
        return result;
    }

    function createTreeElement(item) {
        const isFolder = item.type === 'folder';
        const li = document.createElement('li');
        li.dataset.id = item.id;
        li.dataset.path = item.path;
        li.dataset.type = item.type;
    
        if (isFolder) {
            li.className = 'folder-item';
            li.setAttribute('draggable', true); // Make the entire <li> draggable
            const isCollapsed = !expandedFolders.has(item.id);
    
            const folderHeader = document.createElement('div');
            folderHeader.className = 'folder-header-row';
            // No longer draggable itself, the parent <li> is.
            const nameSpan = `<span class="item-name">${item.name || item.title}</span>`;
            folderHeader.innerHTML = `${TOGGLE_ICON} ${FOLDER_ICON} ${nameSpan}`;
            folderHeader.querySelector('.folder-toggle').classList.toggle('collapsed', isCollapsed);
            
            // Apply selection/active styles to the header for visual consistency
            if (selectedItems.has(item.id)) folderHeader.classList.add('selected');
            if (activeItemId === item.id) folderHeader.classList.add('active');
    
            li.appendChild(folderHeader);
    
            const childrenUl = document.createElement('ul');
            childrenUl.className = 'folder-content';
            childrenUl.classList.toggle('collapsed', isCollapsed);
            if (item.children) {
                item.children.forEach(child => childrenUl.appendChild(createTreeElement(child)));
            }
            li.appendChild(childrenUl);
    
            // Event listeners are now handled by delegation on the parent noteList
        } else {
            li.className = 'note-item';
            li.setAttribute('draggable', true); // Make note items draggable
            const nameSpan = `<span class="item-name">${item.title}</span>`;
            const timeSpan = `<span class="note-timestamp-display">${new Date(item.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>`;
            li.innerHTML = `${NOTE_ICON} ${nameSpan} ${timeSpan}`;
            
            if (selectedItems.has(item.id)) li.classList.add('selected');
            if (activeItemId === item.id) li.classList.add('active');
    
            // Event listeners are now handled by delegation on the parent noteList
        }
    
        return li;
    }

    function toggleFolder(folderId) {
        if (expandedFolders.has(folderId)) {
            expandedFolders.delete(folderId);
        } else {
            expandedFolders.add(folderId);
        }
        renderTree(); // Re-render to reflect the change
    }

    // --- Event Handlers ---
    function handleItemClick(event, item) {
        event.stopPropagation();
        const { id, type, path } = item;

        if (event.shiftKey && activeItemId) {
            // Shift-click for range selection
            const allItems = Array.from(noteList.querySelectorAll('[data-id]')).map(el => el.dataset.id);
            const startIndex = allItems.indexOf(activeItemId);
            const endIndex = allItems.indexOf(id);
            if (startIndex !== -1 && endIndex !== -1) {
                const [start, end] = [Math.min(startIndex, endIndex), Math.max(startIndex, endIndex)];
                if (!event.ctrlKey) selectedItems.clear();
                for (let i = start; i <= end; i++) {
                    selectedItems.add(allItems[i]);
                }
            }
        } else if (event.ctrlKey) {
            // Ctrl-click for individual selection
            if (selectedItems.has(id)) {
                selectedItems.delete(id);
            } else {
                selectedItems.add(id);
            }
        } else {
            // Simple click
            selectedItems.clear();
            selectedItems.add(id);
        }
        
        activeItemId = id;
        if (type === 'note') {
            selectNote(id, path);
        } else {
            clearNoteEditor();
        }
        renderTree();
    }

    async function selectNote(id, notePath) {
        activeNoteId = id;
        localStorage.setItem('lastActiveNoteId', id);
        
        const note = findItemById(getCombinedTree(), id);
        if (note) {
            noteTitleInput.value = note.title;
            noteContentInput.value = note.content;
            renderMarkdown(note.content);
            noteTitleInput.disabled = false;
            noteContentInput.disabled = false;
        } else {
            clearNoteEditor();
        }
    }

    function clearNoteEditor() {
        activeNoteId = null;
        localStorage.removeItem('lastActiveNoteId');
        noteTitleInput.value = '';
        noteContentInput.value = '';
        previewContentDiv.innerHTML = '';
        noteTitleInput.disabled = true;
        noteContentInput.disabled = true;
    }

    newMdBtn.addEventListener('click', () => createNewItem('note', '.md'));
    newTxtBtn.addEventListener('click', () => createNewItem('note', '.txt'));
    newFolderBtn.addEventListener('click', () => createNewItem('folder'));

    async function createNewItem(type, ext = '.md') { // Default to .md for backward compatibility if needed
        let parentPath;
        const activeItem = activeItemId ? findItemById(getCombinedTree(), activeItemId) : null;

        if (activeItem) {
            if (activeItem.type === 'folder') {
                parentPath = activeItem.path;
            } else {
                // It's a note, so get its parent directory
                parentPath = await window.electronPath.dirname(activeItem.path);
            }
        } else {
            // No active item, create at root.
            parentPath = await window.electronAPI.getNotesRootDir();
        }

        if (type === 'folder') {
            const folderName = '新建文件夹';
            await window.electronAPI.createNoteFolder({ parentPath, folderName });
        } else {
            const newNote = {
                title: '无标题笔记',
                content: '',
                username: currentUsername,
                timestamp: Date.now(),
                directoryPath: parentPath,
                ext: ext // Pass the extension to the backend
            };
            const result = await window.electronAPI.writeTxtNote(newNote);
            if (result.success) {
                activeItemId = result.id;
                activeNoteId = result.id;
            }
        }
        await loadNoteTree();
    }

    // --- Save & Delete Logic ---
    const debouncedSaveNote = debounce(() => saveCurrentNote(true), 3000);
    noteTitleInput.addEventListener('input', debouncedSaveNote);
    noteContentInput.addEventListener('input', (e) => {
        renderMarkdown(e.target.value);
        debouncedSaveNote();
    });
    saveNoteBtn.addEventListener('click', () => saveCurrentNote(false));

    async function saveCurrentNote(isAutoSave = false) {
        if (!activeNoteId) {
            if (!isAutoSave) showButtonFeedback(saveNoteBtn, '保存', '无活动笔记', false);
            return;
        }
        const noteInTree = findItemById(getCombinedTree(), activeNoteId);
        if (!noteInTree) return;

        const newTitle = noteTitleInput.value.trim() || '无标题笔记';
        const newContent = noteContentInput.value;

        const titleChanged = noteInTree.title !== newTitle;
        const contentChanged = noteInTree.content !== newContent;

        if (!titleChanged && !contentChanged) {
            return; // No changes, exit early
        }

        let result;
        const extension = await window.electronPath.extname(noteInTree.path);

        if (titleChanged) {
            // If title changes, we must use rename-item to change filename and content
            result = await window.electronAPI.renameItem({
                oldPath: noteInTree.path,
                newName: newTitle,
                newContentBody: newContent,
                ext: extension
            });
            if (result.success && result.newId) {
                // IMPORTANT: Update the activeNoteId to the new ID before reloading the tree
                activeNoteId = result.newId;
                activeItemId = result.newId; // Also update the general active item
            }
        } else {
            // If only content changes, use the lighter write-txt-note
            const noteData = {
                ...noteInTree,
                title: newTitle, // Title is still needed for the header
                content: newContent,
                username: currentUsername,
                timestamp: Date.now(),
                oldFilePath: noteInTree.path, // Pass the path to identify the file
                ext: extension
            };
            result = await window.electronAPI.writeTxtNote(noteData);
        }

        if (result.success) {
            if (isAutoSave) {
                saveNoteBtn.classList.add('button-autosave-feedback');
                setTimeout(() => {
                    saveNoteBtn.classList.remove('button-autosave-feedback');
                }, 700);
            } else {
                showButtonFeedback(saveNoteBtn, '保存', '已保存', true);
            }
            // Always reload the tree to ensure consistency from the single source of truth
            // Instead of a full reload which can cause a flicker or lose state,
            // we perform an in-place update of the model and re-render the tree.
            // The background rescan will bring the authoritative state later.
            const noteToUpdate = findItemById(getCombinedTree(), activeNoteId);
            if (noteToUpdate) {
                noteToUpdate.title = newTitle;
                noteToUpdate.content = newContent;
                noteToUpdate.timestamp = Date.now(); // Update timestamp for immediate UI feedback

                // If the save/rename resulted in a new ID (from a title change), update our state
                if (result.newId && result.newId !== activeNoteId) {
                    const oldId = activeNoteId;
                    noteToUpdate.id = result.newId;
                    noteToUpdate.path = result.newPath || result.filePath;
                    
                    // Update the global state trackers
                    activeNoteId = result.newId;
                    activeItemId = result.newId;
                    if (selectedItems.has(oldId)) {
                        selectedItems.delete(oldId);
                        selectedItems.add(result.newId);
                    }
                }
            }
            await loadNoteTree(); // Re-render the list with the updated data, keeping the editor intact.
        } else {
            if (!isAutoSave) showButtonFeedback(saveNoteBtn, '保存', `保存失败: ${result.error}`, false);
        }
    }

    function removeItemById(tree, id) {
        for (let i = 0; i < tree.length; i++) {
            if (tree[i].id === id) {
                tree.splice(i, 1);
                return true;
            }
            if (tree[i].type === 'folder' && tree[i].children) {
                if (removeItemById(tree[i].children, id)) {
                    return true;
                }
            }
        }
        return false;
    }

    deleteNoteBtn.addEventListener('click', () => handleDirectDelete(false));

    // --- Delegated Event Handlers ---

    function handleListClick(e) {
        const itemElement = e.target.closest('[data-id]');
        if (!itemElement) return;

        if (e.target.closest('.folder-toggle')) {
            e.stopPropagation();
            toggleFolder(itemElement.dataset.id);
            return;
        }
        
        const item = findItemById(getCombinedTree(), itemElement.dataset.id);
        if (item) {
            handleItemClick(e, item);
        }
    }

    function handleListContextMenu(e) {
        const itemElement = e.target.closest('[data-id]');
        if (!itemElement) return;
        
        const item = findItemById(getCombinedTree(), itemElement.dataset.id);
        if (item) {
            handleItemContextMenu(e, item);
        }
    }

    async function handleListDragStart(e) {
        const dragElement = e.target.closest('li[draggable="true"]');
        if (!dragElement) {
            e.preventDefault();
            return;
        }
    
        const id = dragElement.dataset.id;
        // PERFORMANCE FIX: Manually update selection instead of re-rendering the whole tree.
        if (!selectedItems.has(id)) {
            // Clear previous selection visuals
            noteList.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
            selectedItems.clear();
            
            // Select the new item
            const itemContainer = dragElement.matches('.note-item') ? dragElement : dragElement.querySelector('.folder-header-row');
            if(itemContainer) itemContainer.classList.add('selected');
            selectedItems.add(id);
            activeItemId = id;
        }
    
        dragState.sourceIds = Array.from(selectedItems);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/vnd.vcp-notes.items+json', JSON.stringify(dragState.sourceIds));
    
        // Defer adding the 'dragging' class to ensure the drag ghost image is correct.
        setTimeout(() => {
            dragState.sourceIds.forEach(selectedId => {
                const el = noteList.querySelector(`li[data-id='${selectedId}']`);
                if (el) el.classList.add('dragging');
            });
        }, 0);
        
        // Check original state, store it, and then disable if it was active.
        if (window.electronAPI && window.electronAPI.getSelectionListenerStatus) {
            wasSelectionListenerActive = await window.electronAPI.getSelectionListenerStatus();
            if (wasSelectionListenerActive) {
                window.electronAPI.toggleSelectionListener(false);
            }
        }
    }

    const throttledUpdateDragOverVisuals = throttle((targetElement, event) => {
        // RACE CONDITION FIX: If drag has already ended, sourceIds will be null. Do nothing.
        if (!dragState.sourceIds) {
            return;
        }

        // Clear previous target's visuals
        if (dragState.lastDragOverElement && dragState.lastDragOverElement !== targetElement) {
            dragState.lastDragOverElement.classList.remove('drag-over-folder', 'drag-over-target-top', 'drag-over-target-bottom');
        }
        dragState.lastDragOverElement = targetElement;
        dragState.dropAction = null; // Reset action
    
        // Prevent dropping onto itself or its children (if dragging a folder)
        if (dragState.sourceIds.includes(targetElement.dataset.id)) {
            return;
        }
    
        const rect = targetElement.getBoundingClientRect();
        const isFolder = targetElement.dataset.type === 'folder';
        const isNearTop = (event.clientY - rect.top) < (rect.height / 2);
    
        // Determine drop action based on position
        if (isFolder) {
            const dropIntoThreshold = rect.height * 0.25; // 25% margin top/bottom for reordering
            if (event.clientY - rect.top < dropIntoThreshold) {
                dragState.dropAction = 'before';
            } else if (rect.bottom - event.clientY < dropIntoThreshold) {
                dragState.dropAction = 'after';
            } else {
                dragState.dropAction = 'inside';
            }
        } else {
            dragState.dropAction = isNearTop ? 'before' : 'after';
        }
    
        // Apply visuals based on the determined action
        targetElement.classList.toggle('drag-over-folder', dragState.dropAction === 'inside');
        targetElement.classList.toggle('drag-over-target-top', dragState.dropAction === 'before');
        targetElement.classList.toggle('drag-over-target-bottom', dragState.dropAction === 'after');
    
    }, 50);

    function handleListDragOver(e) {
        e.preventDefault(); // Necessary to allow for dropping
        const targetElement = e.target.closest('li[draggable="true"]');
        if (targetElement) {
            throttledUpdateDragOverVisuals(targetElement, e);
        }
    }

    function handleListDragLeave(e) {
        // When leaving a specific item, remove its visuals
        // If the mouse leaves an element that had visuals, clear them.
        const targetElement = e.target.closest('li[draggable="true"]');
        if (targetElement && dragState.lastDragOverElement === targetElement) {
            dragState.lastDragOverElement.classList.remove('drag-over-folder', 'drag-over-target-top', 'drag-over-target-bottom');
            dragState.lastDragOverElement = null;
            dragState.dropAction = null;
        }
    }

    async function handleListDrop(e) {
        e.preventDefault();
        e.stopPropagation();
    
        const dropTargetElement = dragState.lastDragOverElement;
        const dropAction = dragState.dropAction;
    
        // --- Cleanup ---
        if (dropTargetElement) {
            dropTargetElement.classList.remove('drag-over-folder', 'drag-over-target-top', 'drag-over-target-bottom');
        }
        // Reset state immediately after drop
        const sourceIds = dragState.sourceIds;
        dragState = { sourceIds: null, lastDragOverElement: null, dropAction: null };
    
        // --- Validate Drop ---
        if (!dropTargetElement || !dropAction || !sourceIds) {
            await loadNoteTree(); // Reload to clean up any visual artifacts
            return;
        }
    
        const sourcePaths = sourceIds.map(id => findItemById(getCombinedTree(), id)?.path).filter(Boolean);
        if (sourcePaths.length === 0) return;
    
        const targetId = dropTargetElement.dataset.id;
        const targetItem = findItemById(getCombinedTree(), targetId);
        if (!targetItem) return;
    
        // --- Build Intent ---
        let target = {
            targetId: targetItem.id,
            position: dropAction,
        };
    
        if (dropAction === 'inside') {
            target.destPath = targetItem.path;
        } else {
            target.destPath = await window.electronPath.dirname(targetItem.path);
        }
    
        // --- Send Intent & Reload ---
        const result = await window.electronAPI['notes:move-items']({ sourcePaths, target });
        if (!result.success) {
            console.error('Move operation failed:', result.error);
        }
        await loadNoteTree();
    }

    function handleListDragEnd(e) {
        // This is a catch-all to ensure dragging classes and state are cleared.
        noteList.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
        if (dragState.lastDragOverElement) {
            dragState.lastDragOverElement.classList.remove('drag-over-folder', 'drag-over-target-top', 'drag-over-target-bottom');
        }
        dragState = { sourceIds: null, lastDragOverElement: null, dropAction: null };

        // Re-enable global selection listener only if it was active before the drag.
        if (window.electronAPI && window.electronAPI.toggleSelectionListener) {
            if (wasSelectionListenerActive) {
                window.electronAPI.toggleSelectionListener(true);
            }
            wasSelectionListenerActive = false; // Reset state
        }
    }

    let NOTES_DIR_CACHE = null; // Cache for the root directory

    // --- Context Menu ---
    function handleItemContextMenu(e, item) {
        e.preventDefault();
        e.stopPropagation();
        
        if (!selectedItems.has(item.id)) {
            selectedItems.clear();
            selectedItems.add(item.id);
            activeItemId = item.id;
            renderTree();
        }

        const menu = document.getElementById('customContextMenu');
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        menu.style.display = 'block';
        
        // Setup menu items based on selection
        // This part can be expanded to disable/enable items
        
        const renameBtn = document.getElementById('context-rename');
        const deleteBtn = document.getElementById('context-delete');
        const copyNoteBtn = document.getElementById('context-copy-note');

        renameBtn.onclick = () => startInlineRename(item.id);
        deleteBtn.onclick = () => handleDirectDelete(true);
        
        copyNoteBtn.onclick = async () => {
            const result = await window.electronAPI.copyNoteContent(item.path);
            if (result.success) {
                const originalText = copyNoteBtn.textContent;
                copyNoteBtn.textContent = '已复制!';
                setTimeout(() => {
                    copyNoteBtn.textContent = originalText;
                }, 1500);
            }
        };
    }

    document.addEventListener('click', () => {
        customContextMenu.style.display = 'none';
    });

    function startInlineRename(itemId) {
        const itemElement = noteList.querySelector(`[data-id="${itemId}"]`);
        if (!itemElement) return;
    
        const container = itemElement.classList.contains('note-item')
            ? itemElement
            : itemElement.querySelector('.folder-header-row');
        
        if (!container) return;
    
        const nameSpan = container.querySelector('.item-name');
        if (!nameSpan) return;
    
        const currentName = nameSpan.textContent;
        nameSpan.style.display = 'none';
    
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-edit-input';
        input.value = currentName;
        
        nameSpan.after(input);
        input.focus();
        input.select();
    
        const cleanup = () => {
            input.removeEventListener('blur', handleBlur);
            input.removeEventListener('keydown', handleKeydown);
            input.remove();
            nameSpan.style.display = '';
        };
    
        const handleBlur = async () => {
            const newName = input.value.trim();
            cleanup();
            if (newName && newName !== currentName) {
                const item = findItemById(getCombinedTree(), itemId);
                const extension = await window.electronPath.extname(item.path);
                await window.electronAPI.renameItem({ oldPath: item.path, newName: newName, ext: extension });
                await loadNoteTree();
            }
        };
    
        const handleKeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            } else if (e.key === 'Escape') {
                cleanup();
            }
        };
    
        const handleClick = (e) => {
            e.stopPropagation();
        };
    
        input.addEventListener('click', handleClick);
        input.addEventListener('blur', handleBlur);
        input.addEventListener('keydown', handleKeydown);
    }

    async function handleDirectDelete(isFromContextMenu = true) {
        if (selectedItems.size === 0) {
            if (!isFromContextMenu) {
                showButtonFeedback(deleteNoteBtn, '删除', '未选择项目', false);
            }
            return;
        }

        const itemsToDelete = Array.from(selectedItems).map(id => findItemById(getCombinedTree(), id)).filter(Boolean);
        const containsFolder = itemsToDelete.some(item => item.type === 'folder');
        const containsCloudFolder = itemsToDelete.some(item => item.type === 'folder' && isCloudItem(item.id));

        let confirmed = false;
        if (containsFolder) {
            const title = '确认删除文件夹';
            let message = `你确定要删除选中的 ${selectedItems.size} 个项目吗？<br><b>此操作无法撤销。</b>`;
            if (containsCloudFolder) {
                message = `你确定要删除选中的 ${selectedItems.size} 个项目吗？<br>其中包含云文件夹，<b>删除后将无法从回收站恢复！</b>`;
            }
            confirmed = await showConfirmationModal(title, message);
        } else {
            // For notes-only deletion, still confirm but with a less alarming message.
            const title = '确认删除笔记';
            const message = `你确定要删除选中的 ${selectedItems.size} 个笔记吗？`;
            confirmed = await showConfirmationModal(title, message);
        }

        if (confirmed) {
            for (const item of itemsToDelete) {
                const result = await window.electronAPI.deleteItem(item.path);
                if (result.success) {
                    removeItemById(localNoteTree, item.id);
                    if (networkNoteTree && networkNoteTree.length > 0) {
                        networkNoteTree.forEach(tree => removeItemById(tree.children, item.id));
                    }
                } else {
                    console.error(`Failed to delete item ${item.path}:`, result.error);
                }
            }

            selectedItems.clear();
            activeItemId = null;
            clearNoteEditor();
            renderTree();

            if (!isFromContextMenu) {
                showButtonFeedback(deleteNoteBtn, '删除', '已删除', true, 1000);
            }
        }
    }

    // --- Resizer Logic ---
    function initResizer() {
        let x = 0;
        let sidebarWidth = 0;

        const mouseDownHandler = (e) => {
            x = e.clientX;
            sidebarWidth = sidebar.getBoundingClientRect().width;

            document.addEventListener('mousemove', mouseMoveHandler);
            document.addEventListener('mouseup', mouseUpHandler);
        };

        const mouseMoveHandler = (e) => {
            const dx = e.clientX - x;
            const newSidebarWidth = sidebarWidth + dx;
            sidebar.style.width = `${newSidebarWidth}px`;
        };

        const mouseUpHandler = () => {
            document.removeEventListener('mousemove', mouseMoveHandler);
            document.removeEventListener('mouseup', mouseUpHandler);
        };

        resizer.addEventListener('mousedown', mouseDownHandler);
    }

    // --- Initialization ---
    async function initializeApp() {
        // Initialize theme first to prevent flash of unstyled content
        if (window.electronAPI) {
            // Use the new robust theme listener
            window.electronAPI.onThemeUpdated(applyTheme);
            try {
                const initialTheme = await window.electronAPI.getCurrentTheme();
                applyTheme(initialTheme);
            } catch (e) {
                console.error("Failed to get initial theme", e);
                applyTheme('dark'); // Fallback
            }
        } else {
            applyTheme('dark'); // Fallback for non-electron env
        }

        initResizer();
        searchInput.addEventListener('input', debounce(renderTree, 300));

        // --- Custom Title Bar Listeners ---
        minimizeNotesBtn.addEventListener('click', () => {
            if (window.electronAPI) window.electronAPI.minimizeWindow();
        });

        maximizeNotesBtn.addEventListener('click', () => {
            if (window.electronAPI) window.electronAPI.maximizeWindow();
        });

        closeNotesBtn.addEventListener('click', () => {
            window.close();
        });

        // --- Attach Delegated Event Listeners ---
        noteList.addEventListener('click', (e) => {
            const itemElement = e.target.closest('[data-id]');
            if (itemElement) {
                // If click is on an item, delegate to the main handler
                handleListClick(e);
            } else {
                // If click is in an empty area, clear the selection
                selectedItems.clear();
                activeItemId = null;
                activeNoteId = null;
                clearNoteEditor();
                renderTree(); // Re-render to show the cleared selection
            }
        });
        noteList.addEventListener('contextmenu', handleListContextMenu);
        noteList.addEventListener('dragstart', handleListDragStart);
        noteList.addEventListener('dragover', handleListDragOver);
        noteList.addEventListener('dragleave', handleListDragLeave);
        noteList.addEventListener('drop', handleListDrop);
        noteList.addEventListener('dragend', handleListDragEnd);

        try {
            const settings = await window.electronAPI.loadSettings();
            currentUsername = settings?.userName || 'defaultUser';
            NOTES_DIR_CACHE = await window.electronAPI.getNotesRootDir();
        } catch (error) {
            console.error('加载用户设置或根目录失败:', error);
        }
        
        // No longer need to clear collapsed state, as the default is now collapsed.
        // --- New Initialization Logic ---
        // 1. Load local notes first for immediate display
        const localResult = await window.electronAPI.readNotesTree();
        if (localResult.error) {
            console.error('加载本地笔记失败:', localResult.error);
        } else {
            localNoteTree = localResult;
        }

        // 2. Try to load network notes from cache for faster startup
        // 2. Try to load network notes from cache for faster startup (now returns array)
        const cachedNetworkNotes = await window.electronAPI.getCachedNetworkNotes();
        // Ensure it's always an array, handling both old object format and null/undefined
        networkNoteTree = Array.isArray(cachedNetworkNotes) ? cachedNetworkNotes : (cachedNetworkNotes ? [cachedNetworkNotes] : []);

        // 3. Initial render with whatever we have so far
        renderTree();

        // 4. Asynchronously ask the main process to scan for fresh network notes
        window.electronAPI.scanNetworkNotes();

        // 5. Listen for the updated network notes to be returned
        window.electronAPI.onNetworkNotesScanned((freshNetworkTree) => {
            // Ensure it's always an array, handling both old object format and null/undefined
            networkNoteTree = Array.isArray(freshNetworkTree) ? freshNetworkTree : (freshNetworkTree ? [freshNetworkTree] : []);
            renderTree(); // Re-render with the fresh data
        });

        window.electronAPI.onSharedNoteData(async (data) => {
            // Generate a robust, unique title based on date and time, as suggested.
            const now = new Date();
            const generatedTitle = `分享笔记 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}.${String(now.getSeconds()).padStart(2, '0')}`;

            // Prepend the original title to the content for context.
            const finalContent = data.title
                ? `# ${data.title}\n\n${data.content || ''}`
                : data.content || '';

            const newNoteData = {
                title: generatedTitle, // Use the safe, generated title for the filename and header
                content: finalContent,
                username: currentUsername,
                timestamp: Date.now(),
                directoryPath: await window.electronAPI.getNotesRootDir() // Create in root by default
            };

            const result = await window.electronAPI.writeTxtNote(newNoteData);
            if (result.success) {
                await loadNoteTree();
                // Activate the new note
                activeItemId = result.id;
                activeNoteId = result.id;
                selectNote(result.id, result.filePath);
                renderTree();
            } else {
                console.error('Failed to create new note from shared content:', result.error);
            }
        });

        if (window.electronAPI.sendNotesWindowReady) {
            window.electronAPI.sendNotesWindowReady();
        }
    }

    // --- Paste Image Logic ---
    noteContentInput.addEventListener('paste', async (event) => {
        const items = (event.clipboardData || window.clipboardData).items;
        for (const item of items) {
            if (item.type.indexOf('image') !== -1) {
                event.preventDefault();
                const file = item.getAsFile();
                const reader = new FileReader();
                
                reader.onload = async (e) => {
                    const base64Data = e.target.result.split(',')[1];
                    const extension = file.type.split('/')[1];
                    
                    const result = await window.electronAPI.savePastedImageToFile({ data: base64Data, extension }, activeNoteId);

                    if (result.success && result.attachment) {
                        const markdownImage = `![${result.attachment.name}](${result.attachment.internalPath})`;
                        const { selectionStart, selectionEnd } = noteContentInput;
                        const currentContent = noteContentInput.value;
                        const newContent = `${currentContent.substring(0, selectionStart)}${markdownImage}${currentContent.substring(selectionEnd)}`;
                        noteContentInput.value = newContent;
                        renderMarkdown(newContent);
                        debouncedSaveNote();
                    } else {
                        console.error('Failed to save pasted image:', result.error);
                    }
                };
                
                reader.readAsDataURL(file);
                return; // Stop after handling the first image
            }
        }
    });

    initializeApp();
});
