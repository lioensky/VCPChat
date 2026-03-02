document.addEventListener('DOMContentLoaded', () => {
    const editorTextarea = document.getElementById('editor');
    const historyList = document.getElementById('historyList');
    const newCanvasBtn = document.getElementById('newCanvasBtn');
    const filePathSpan = document.getElementById('filePath');
    const errorInfoSpan = document.getElementById('errorInfo');
    const minimizeBtn = document.getElementById('minimize-btn');
    const maximizeBtn = document.getElementById('maximize-btn');
    const closeBtn = document.getElementById('close-btn');
    const sidebar = document.querySelector('.sidebar');
    const resizer = document.getElementById('resizer');
    const changeHistorySidebar = document.getElementById('change-history-sidebar');
    const resizerRight = document.getElementById('resizer-right');
    const changeHistoryList = document.getElementById('changeHistoryList');
    const contextMenu = document.getElementById('context-menu');
    const renameBtn = document.getElementById('rename-btn');
    const copyBtn = document.getElementById('copy-btn');
    const deleteBtn = document.getElementById('delete-btn');
    const runPyBtn = document.getElementById('run-py-btn');
    const renderMdBtn = document.getElementById('render-md-btn');
    const renderHtmlBtn = document.getElementById('render-html-btn');
    const toggleWrapBtn = document.getElementById('toggle-wrap-btn');
    const externalChangeBar = document.getElementById('external-change-bar');
    const viewDiffBtn = document.getElementById('view-diff-btn');
    const dismissChangeBtn = document.getElementById('dismiss-change-btn');
    const diffModal = document.getElementById('diff-modal');
    const diffViewContainer = document.getElementById('diff-view');
    const acceptChangesBtn = document.getElementById('accept-changes-btn');
    const rejectChangesBtn = document.getElementById('reject-changes-btn');
    const canvasSearchInput = document.getElementById('canvasSearchInput');
    const editorSearchBar = document.getElementById('editor-search-bar');
    const editorSearchInput = document.getElementById('editorSearchInput');
    const searchCount = document.getElementById('search-count');
    const searchPrevBtn = document.getElementById('search-prev-btn');
    const searchNextBtn = document.getElementById('search-next-btn');
    const searchCloseBtn = document.getElementById('search-close-btn');

    let editor;
    let externalFileContent = null; // To store content from AI
    let diffView = null;
    const editorContextMenu = document.getElementById('editor-context-menu');
    let filesHistory = {}; // Object to store history arrays, keyed by file path
    let allCanvasFiles = []; // Store all files for filtering
    let searchMatches = [];
    let currentMatchIndex = -1;

    // --- CodeMirror 5 Initialization ---
    function initializeEditor(initialData) {
        if (editor) {
            // If editor exists, just update its content
            if (initialData.current) {
                editor.setValue(initialData.current.content);
                filePathSpan.textContent = initialData.current.path;
                // Update syntax highlighting for the new content's file type
                if (editor) {
                    const mode = getModeForFilePath(initialData.current.path);
                    editor.setOption('mode', mode);
                    updateTopBarButtons(initialData.current.path);
                }
            }
            if (initialData.history) {
                updateHistoryList(initialData.history);
            }
            return;
        }

        editor = CodeMirror.fromTextArea(editorTextarea, {
            lineNumbers: true,
            mode: 'javascript',
            theme: 'material-darker',
            lineWrapping: false,
            continueComments: "Enter",
        });

        // --- Event Listeners (only bind once) ---

        // Auto-save on content change
        let debounceTimer;
        editor.on('change', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const content = editor.getValue();
                const path = filePathSpan.textContent;
                if (path !== '未保存' && window.electronAPI) {
                    window.electronAPI.saveCanvasFile({ path, content });
                    addContentHistory(path, content);
                }
            }, 2000);
        });

        // Editor Context Menu
        editor.on('contextmenu', (cm, e) => {
            e.preventDefault();
            const selection = cm.getSelection();
            editorContextMenu.querySelector('[data-action="cut"]').disabled = !selection;
            editorContextMenu.querySelector('[data-action="copy"]').disabled = !selection;
            navigator.clipboard.readText().then(text => {
                editorContextMenu.querySelector('[data-action="paste"]').disabled = !text;
            }).catch(() => {
                editorContextMenu.querySelector('[data-action="paste"]').disabled = true;
            });
            const history = cm.historySize();
            editorContextMenu.querySelector('[data-action="undo"]').disabled = history.undo === 0;
            editorContextMenu.querySelector('[data-action="redo"]').disabled = history.redo === 0;
            editorContextMenu.style.top = `${e.clientY}px`;
            editorContextMenu.style.left = `${e.clientX}px`;
            editorContextMenu.style.display = 'block';
        });

        // Search Shortcuts
        editor.addKeyMap({
            "Ctrl-F": (cm) => {
                toggleSearchBar(true);
            },
            "Esc": (cm) => {
                if (editorSearchBar.style.display !== 'none') {
                    toggleSearchBar(false);
                }
            }
        });

        if (initialData.current) {
            const path = initialData.current.path;
            const initialContent = initialData.current.content;
            editor.setValue(initialContent);
            filePathSpan.textContent = path;
            // Initialize history for this file path if it doesn't exist
            if (!filesHistory[path]) {
                filesHistory[path] = [];
            }
            addContentHistory(path, initialContent, true); // Add initial state
            updateChangeHistoryList(path); // Display history for the current file
            // Set initial syntax highlighting
            const mode = getModeForFilePath(path);
            editor.setOption('mode', mode);
            updateTopBarButtons(path);
        } else {
            editor.setValue('// Welcome to Canvas with CodeMirror 5!');
        }

        if (initialData.history) {
            updateHistoryList(initialData.history);
        }

    }

    // --- Theme Handling ---
    function applyTheme(theme) {
        const currentTheme = theme || 'dark';
        document.body.classList.toggle('light-theme', currentTheme === 'light');
        if (editor) {
            editor.setOption('theme', currentTheme === 'light' ? 'default' : 'material-darker');
        }
    }

    // --- IPC Event Listeners ---
    if (window.electronAPI) {
        window.electronAPI.onCanvasLoadData(async (data) => {
            initializeEditor(data);
            // After editor is initialized, get and apply the current theme
            try {
                const theme = await window.electronAPI.getCurrentTheme();
                applyTheme(theme);

                // Attach the theme update listener only after the editor is initialized
                // to prevent race conditions where the theme updates before the editor exists.
                if (!window.isThemeListenerAttached) {
                    window.electronAPI.onThemeUpdated(applyTheme);
                    window.isThemeListenerAttached = true;
                }

            } catch (error) {
                console.error('Failed to get current theme on load:', error);
                applyTheme('dark'); // Fallback to dark theme
            }
        });

        window.electronAPI.onCanvasFileChanged((file) => {
            const path = file.path;
            // Initialize history for this file path if it doesn't exist
            if (!filesHistory[path]) {
                filesHistory[path] = [];
            }

            if (editor && editor.getValue() !== file.content) {
                editor.setValue(file.content);
                const mode = getModeForFilePath(path);
                editor.setOption('mode', mode);
                updateTopBarButtons(path);
                addContentHistory(path, file.content);
                // Immediately update the UI after setting the value
                updateChangeHistoryList(path);
            }
            filePathSpan.textContent = path;
            // Also ensure the list is updated even if content is the same
            // (e.g., switching back and forth between files)
            updateChangeHistoryList(path);
        });

        // Listen for direct load commands from the main process
        window.electronAPI.onLoadCanvasFileByPath((filePath) => {
            if (window.electronAPI) {
                window.electronAPI.loadCanvasFile(filePath);
            }
        });
 
        window.electronAPI.onExternalFileChanged((file) => {
            if (editor && editor.getValue() !== file.content) {
                console.log('External change detected, showing notification bar.');
                externalFileContent = file.content; // Store the new content
                externalChangeBar.style.display = 'flex';
            }
        });
 
        // Inform main process that the window is ready to receive data
        window.electronAPI.canvasReady();
    }

    // --- Diff View Logic ---
    function initializeDiffView(originalContent, modifiedContent) {
        if (diffView) {
            // If it exists, just update contents
            diffView.edit.setValue(originalContent);
            diffView.right.orig.setValue(modifiedContent);
            return;
        }
        
        diffViewContainer.innerHTML = ''; // Clear previous view if any
        diffView = CodeMirror.MergeView(diffViewContainer, {
            value: originalContent,          // Original content on the left
            origRight: modifiedContent,      // Modified content on the right
            lineNumbers: true,
            mode: editor.getOption('mode'),  // Use the same mode as the main editor
            theme: editor.getOption('theme'),
            lineWrapping: editor.getOption('lineWrapping'), // Sync line wrapping with main editor
            revertButtons: false,            // We have our own buttons
            connect: 'align',
            collapseIdentical: true,
        });
    }

    viewDiffBtn.addEventListener('click', () => {
        if (editor && externalFileContent !== null) {
            const originalContent = editor.getValue();
            initializeDiffView(originalContent, externalFileContent);
            diffModal.style.display = 'flex';
            // Refresh the diff view after it becomes visible
            setTimeout(() => {
                if (diffView) {
                   diffView.edit.refresh();
                   diffView.right.orig.refresh();
                }
            }, 10);
        }
    });

    function closeDiffViewAndBar() {
        diffModal.style.display = 'none';
        externalChangeBar.style.display = 'none';
        externalFileContent = null;
    }

    acceptChangesBtn.addEventListener('click', () => {
        if (editor && externalFileContent !== null) {
            editor.setValue(externalFileContent); // This will trigger the auto-save
        }
        closeDiffViewAndBar();
    });

    function rejectChanges() {
        if (editor && window.electronAPI) {
            const userContent = editor.getValue();
            const path = filePathSpan.textContent;
            // Force save the user's current content back to the file system
            window.electronAPI.saveCanvasFile({ path, content: userContent });
        }
        closeDiffViewAndBar();
    }

    rejectChangesBtn.addEventListener('click', rejectChanges);
    dismissChangeBtn.addEventListener('click', rejectChanges);

    // --- UI Event Listeners ---
    newCanvasBtn.addEventListener('click', () => {
        if (window.electronAPI) {
            window.electronAPI.createNewCanvas();
        }
    });

    toggleWrapBtn.addEventListener('click', () => {
        if (editor) {
            const currentStatus = editor.getOption('lineWrapping');
            editor.setOption('lineWrapping', !currentStatus);
            toggleWrapBtn.textContent = `自动换行: ${!currentStatus ? '开' : '关'}`;
        }
    });

    // --- Search Logic ---
    function toggleSearchBar(show) {
        if (show) {
            editorSearchBar.style.display = 'flex';
            editorSearchInput.focus();
            if (editorSearchInput.value) {
                doSearch(editorSearchInput.value);
            }
        } else {
            editorSearchBar.style.display = 'none';
            clearSearch();
            editor.focus();
        }
    }

    function clearSearch() {
        searchMatches = [];
        currentMatchIndex = -1;
        searchCount.textContent = '0/0';
        editor.operation(() => {
            // Remove previous highlights
            editor.getAllMarks().forEach(mark => {
                if (mark.className === 'cm-search-match' || mark.className === 'cm-search-match-selected') {
                    mark.clear();
                }
            });
        });
    }

    function doSearch(query) {
        clearSearch();
        if (!query) return;

        const cursor = editor.getSearchCursor(query, null, { caseFold: true });
        while (cursor.findNext()) {
            const mark = editor.markText(cursor.from(), cursor.to(), { className: 'cm-search-match' });
            searchMatches.push({ from: cursor.from(), to: cursor.to(), mark: mark });
        }

        if (searchMatches.length > 0) {
            currentMatchIndex = 0;
            updateSearchUI();
            jumpToMatch(currentMatchIndex);
        } else {
            searchCount.textContent = '0/0';
        }
    }

    function updateSearchUI() {
        searchCount.textContent = `${currentMatchIndex + 1}/${searchMatches.length}`;
    }

    function jumpToMatch(index) {
        if (index < 0 || index >= searchMatches.length) return;

        const match = searchMatches[index];
        
        // Highlight active match
        editor.operation(() => {
            searchMatches.forEach((m, i) => {
                if (m.selectedMark) {
                    m.selectedMark.clear();
                    m.selectedMark = null;
                }
                if (i === index) {
                    m.selectedMark = editor.markText(m.from(), m.to(), { className: 'cm-search-match-selected' });
                }
            });
        });

        editor.scrollIntoView({ from: match.from, to: match.to }, 100);
        editor.setSelection(match.from, match.to);
    }

    editorSearchInput.addEventListener('input', () => {
        doSearch(editorSearchInput.value);
    });

    editorSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            if (e.shiftKey) {
                findPrev();
            } else {
                findNext();
            }
        } else if (e.key === 'Escape') {
            toggleSearchBar(false);
        }
    });

    searchNextBtn.addEventListener('click', findNext);
    searchPrevBtn.addEventListener('click', findPrev);
    searchCloseBtn.addEventListener('click', () => toggleSearchBar(false));

    function findNext() {
        if (searchMatches.length === 0) return;
        currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
        updateSearchUI();
        jumpToMatch(currentMatchIndex);
    }

    function findPrev() {
        if (searchMatches.length === 0) return;
        currentMatchIndex = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
        updateSearchUI();
        jumpToMatch(currentMatchIndex);
    }

    historyList.addEventListener('click', (e) => {
        if (e.target && e.target.matches('li[data-path]')) {
            const filePath = e.target.dataset.path;
            if (window.electronAPI) {
                window.electronAPI.loadCanvasFile(filePath);
            }
        }
    });

    // --- Context Menu for History List ---
    let activeListItem = null;

    historyList.addEventListener('contextmenu', (e) => {
        const targetLi = e.target.closest('li[data-path]');
        if (targetLi) {
            e.preventDefault();
            activeListItem = targetLi;
            contextMenu.style.top = `${e.clientY}px`;
            contextMenu.style.left = `${e.clientX}px`;
            contextMenu.style.display = 'block';
        }
    });

    document.addEventListener('click', (e) => {
        // Close both context menus if clicked outside
        if (!contextMenu.contains(e.target)) {
            contextMenu.style.display = 'none';
            activeListItem = null;
        }
        if (!editorContextMenu.contains(e.target)) {
            editorContextMenu.style.display = 'none';
        }
    });

    editorContextMenu.addEventListener('click', (e) => {
        const action = e.target.closest('button')?.dataset.action;
        if (action && editor) {
            switch (action) {
                case 'undo': editor.undo(); break;
                case 'redo': editor.redo(); break;
                case 'cut':
                    const selection = editor.getSelection();
                    if (selection) {
                        navigator.clipboard.writeText(selection).then(() => {
                            editor.replaceSelection('');
                        });
                    }
                    break;
                case 'copy': document.execCommand('copy'); break;
                case 'paste':
                    navigator.clipboard.readText().then(text => {
                        editor.replaceSelection(text);
                    });
                    break;
                case 'selectAll': editor.execCommand('selectAll'); break;
            }
        }
        editorContextMenu.style.display = 'none';
    });

    renameBtn.addEventListener('click', () => {
        if (activeListItem) {
            enterRenameMode(activeListItem);
        }
        contextMenu.style.display = 'none';
    });

    copyBtn.addEventListener('click', () => {
        if (activeListItem && window.electronAPI) {
            const filePath = activeListItem.dataset.path;
            window.electronAPI.copyCanvasFile(filePath);
        }
        contextMenu.style.display = 'none';
    });

    deleteBtn.addEventListener('click', async () => {
        if (activeListItem && window.electronAPI) {
            const filePath = activeListItem.dataset.path;
            const fileName = await window.electronPath.basename(filePath);
            // Add a confirmation dialog before deleting
            if (confirm(`确定要删除文件 "${fileName}"? 这个操作无法撤销。`)) {
                window.electronAPI.deleteCanvasFile(filePath);
            }
        }
        contextMenu.style.display = 'none';
    });

    function enterRenameMode(li) {
        const originalTitle = li.textContent;
        li.innerHTML = ''; // Clear the list item

        const input = document.createElement('input');
        input.type = 'text';
        input.value = originalTitle;
        input.className = 'rename-input';
        li.appendChild(input);
        input.focus();
        input.select();

        const finishRename = async () => {
            const newTitle = input.value.trim();
            const oldPath = li.dataset.path;

            if (newTitle && newTitle !== originalTitle) {
                if (window.electronAPI) {
                    try {
                        const newPath = await window.electronAPI.renameCanvasFile({ oldPath, newTitle });
                        li.textContent = newTitle;
                        li.dataset.path = newPath;
                        // If the renamed file is the active one, update the file path display
                        if (filePathSpan.textContent === oldPath) {
                            filePathSpan.textContent = newPath;
                        }
                    } catch (error) {
                        console.error('Rename failed:', error);
                        li.textContent = originalTitle; // Revert on failure
                    }
                }
            } else {
                li.textContent = originalTitle; // Revert if no change or empty
            }
        };

        input.addEventListener('blur', finishRename);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                input.blur();
            } else if (e.key === 'Escape') {
                li.textContent = originalTitle;
                input.removeEventListener('blur', finishRename); // Avoid double-revert
                input.blur();
            }
        });
    }

    if (minimizeBtn && maximizeBtn && closeBtn) {
        minimizeBtn.addEventListener('click', () => {
            if (window.electronAPI) window.electronAPI.minimizeWindow();
        });
        maximizeBtn.addEventListener('click', () => {
            if (window.electronAPI) window.electronAPI.maximizeWindow();
        });
        closeBtn.addEventListener('click', () => {
            if (window.electronAPI) window.electronAPI.closeWindow();
        });
    }

    // --- Sidebar Resizing ---
    let isResizing = false;
    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', () => {
            isResizing = false;
            document.removeEventListener('mousemove', handleMouseMove);
            // Refresh CodeMirror to adjust to the new size
            if (editor) {
                editor.refresh();
            }
        });
    });

    function handleMouseMove(e) {
        if (!isResizing) return;
        // The new width is simply the mouse's x position, since the sidebar is anchored to the left.
        const newWidth = e.clientX;
        const minWidth = parseInt(getComputedStyle(sidebar).minWidth, 10);
        const maxWidth = parseInt(getComputedStyle(sidebar).maxWidth, 10);

        if (newWidth >= minWidth && newWidth <= maxWidth) {
            sidebar.style.width = `${newWidth}px`;
        }
    }

    // --- Right Sidebar Resizing ---
    let isResizingRight = false;
    resizerRight.addEventListener('mousedown', (e) => {
        isResizingRight = true;
        document.addEventListener('mousemove', handleRightMouseMove);
        document.addEventListener('mouseup', () => {
            isResizingRight = false;
            document.removeEventListener('mousemove', handleRightMouseMove);
            if (editor) {
                editor.refresh();
            }
        });
    });

    function handleRightMouseMove(e) {
        if (!isResizingRight) return;
        const containerWidth = document.querySelector('.main-container').offsetWidth;
        const newWidth = containerWidth - e.clientX;
        const minWidth = 150; // Or get from CSS
        const maxWidth = 500;  // Or get from CSS

        if (newWidth >= minWidth && newWidth <= maxWidth) {
            changeHistorySidebar.style.width = `${newWidth}px`;
        }
    }

    // --- Top Bar Button Logic ---
    function updateTopBarButtons(filePath) {
       const extension = filePath ? filePath.split('.').pop().toLowerCase() : '';
       runPyBtn.style.display = extension === 'py' ? 'block' : 'none';
       renderMdBtn.style.display = extension === 'md' ? 'block' : 'none';
       renderHtmlBtn.style.display = extension === 'html' ? 'block' : 'none';
    }

    runPyBtn.addEventListener('click', () => {
       if (editor && window.electronAPI) {
           const code = editor.getValue();
           window.electronAPI.executePythonCode(code).then(({ stdout, stderr }) => {
               // For now, just log the output. A dedicated output panel would be better.
               console.log('Python stdout:', stdout);
               console.error('Python stderr:', stderr);
               alert('Python Output:\n' + (stdout || stderr));
           }).catch(err => {
               console.error('Python execution failed:', err);
               alert('Python execution failed:\n' + err);
           });
       }
    });

    renderMdBtn.addEventListener('click', () => {
       if (editor && window.electronAPI) {
           const content = editor.getValue();
           window.electronAPI.openTextInNewWindow(content, 'Markdown Preview', 'dark');
       }
    });

    renderHtmlBtn.addEventListener('click', () => {
       if (editor && window.electronAPI) {
           const content = editor.getValue();
           // We can reuse the text viewer for HTML rendering as it supports iframes
           window.electronAPI.openTextInNewWindow(content, 'HTML Preview', 'dark');
       }
    });

    // --- Helper Functions ---
    function getModeForFilePath(filePath) {
        if (!filePath) {
           updateTopBarButtons('');
           return 'javascript'; // Default mode
        }
        const extension = filePath.split('.').pop().toLowerCase();
        switch (extension) {
            case 'js':
                return 'javascript';
            case 'ts':
                return 'text/typescript';
            case 'py':
                return 'python';
            case 'css':
                return 'css';
            case 'html':
                return 'htmlmixed';
            case 'json':
                return 'application/json';
            case 'md':
                return 'markdown';
            case 'rs':
                return 'rust';
            case 'cpp':
            case 'h':
                return 'text/x-c++src';
            case 'cs':
                return 'text/x-csharp';
            case 'java':
                return 'text/x-java';
            case 'go':
                return 'text/x-go';
            case 'rb':
                return 'text/x-ruby';
            case 'php':
                return 'application/x-httpd-php';
            case 'swift':
                return 'text/x-swift';
            case 'kt':
                return 'text/x-kotlin';
            case 'sh':
                return 'text/x-sh';
            case 'yml':
            case 'yaml':
                return 'text/x-yaml';
            case 'toml':
                return 'text/x-toml';
            case 'xml':
                return 'application/xml';
            case 'txt':
            default:
                return 'text/plain';
        }
    }

    function updateHistoryList(history) {
        allCanvasFiles = history; // Store the full list
        renderHistoryList(history);
    }

    function renderHistoryList(files) {
        historyList.innerHTML = '';
        files.forEach(item => {
            const li = document.createElement('li');
            li.textContent = item.title;
            li.dataset.path = item.path;
            if (item.isActive) {
                li.classList.add('active');
            }
            historyList.appendChild(li);
        });
    }

    canvasSearchInput.addEventListener('input', async () => {
        const searchTerm = canvasSearchInput.value.toLowerCase().trim();
        if (!searchTerm) {
            renderHistoryList(allCanvasFiles);
            return;
        }

        const filteredFiles = [];
        for (const file of allCanvasFiles) {
            // Search in title
            if (file.title.toLowerCase().includes(searchTerm)) {
                filteredFiles.push(file);
                continue;
            }

            // Search in content (if we have it or can get it)
            try {
                const fileData = await window.electronAPI.getTextContent(file.path);
                if (fileData && fileData.toLowerCase().includes(searchTerm)) {
                    filteredFiles.push(file);
                }
            } catch (err) {
                console.error(`Failed to search in file ${file.path}:`, err);
            }
        }
        renderHistoryList(filteredFiles);
    });

    // --- Document Change History Logic ---
    function addContentHistory(path, content, isInitial = false) {
        if (!path || !filesHistory[path]) return;

        const history = filesHistory[path];
        // Avoid adding duplicates
        if (!isInitial && history.length > 0 && history[history.length - 1].content === content) {
            return;
        }
        const historyEntry = {
            content: content,
            timestamp: new Date(),
        };
        history.push(historyEntry);
        updateChangeHistoryList(path);
    }

    async function updateChangeHistoryList(path) {
        changeHistoryList.innerHTML = '';
        if (!path || !filesHistory[path]) return;

        const history = filesHistory[path];
        const currentContent = editor.getValue();
        let activeIndex = -1;

        // Find which history entry matches the current content to highlight it
        for(let i = history.length - 1; i >= 0; i--) {
            if (history[i].content === currentContent) {
                activeIndex = i;
                break;
            }
        }

        const fileName = window.electronPath ? await window.electronPath.basename(path) : path;

        history.forEach((item, index) => {
            const li = document.createElement('li');
            li.textContent = `${item.timestamp.toLocaleTimeString()} - ${fileName}`;
            li.dataset.index = index;
            if (index === activeIndex) {
                li.classList.add('active');
            }
            changeHistoryList.appendChild(li);
        });
        // Auto-scroll to the bottom
        changeHistoryList.scrollTop = changeHistoryList.scrollHeight;
    }

    changeHistoryList.addEventListener('click', (e) => {
        if (e.target && e.target.matches('li[data-index]')) {
            const path = filePathSpan.textContent;
            if (!path || !filesHistory[path]) return;

            const history = filesHistory[path];
            const index = parseInt(e.target.dataset.index, 10);

            if (index >= 0 && index < history.length) {
                const selectedContent = history[index].content;
                if (editor.getValue() !== selectedContent) {
                    editor.setValue(selectedContent);
                    // The editor 'change' event will fire, which will trigger a save
                    // and add a new history item. This is desired behavior if the user
                    // reverts and then starts typing again.
                }
                // Update the active state in the list
                updateChangeHistoryList(path);
            }
        }
    });

});