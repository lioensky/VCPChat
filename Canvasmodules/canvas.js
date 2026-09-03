const api = window.utilityAPI || window.electronAPI;

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
    const diffReviewPath = document.getElementById('diff-review-path');
    const reviewReasonInput = document.getElementById('review-reason-input');
    const acceptChangesBtn = document.getElementById('accept-changes-btn');
    const rejectChangesBtn = document.getElementById('reject-changes-btn');
    const canvasSearchInput = document.getElementById('canvasSearchInput');
    const editorSearchBar = document.getElementById('editor-search-bar');
    const editorSearchInput = document.getElementById('editorSearchInput');
    const searchCount = document.getElementById('search-count');
    const searchPrevBtn = document.getElementById('search-prev-btn');
    const searchNextBtn = document.getElementById('search-next-btn');
    const searchCloseBtn = document.getElementById('search-close-btn');
    const fileSidebar = document.getElementById('file-sidebar');
    const collapseLeftBtn = document.getElementById('collapse-left-btn');
    const collapseLeftTrigger = document.getElementById('collapse-left-trigger');
    const collapseRightBtn = document.getElementById('collapse-right-btn');
    const toggleRightBtn = document.getElementById('toggle-right-btn');
    const activeFileName = document.getElementById('active-file-name');
    const fileTypeBadge = document.getElementById('file-type-badge');
    const dirtyIndicator = document.getElementById('dirty-indicator');
    const saveStatus = document.getElementById('saveStatus');
    const cursorPosition = document.getElementById('cursor-position');
    const documentStats = document.getElementById('document-stats');
    const languageMode = document.getElementById('language-mode');
    const outputPanel = document.getElementById('output-panel');
    const outputContent = document.getElementById('output-content');
    const outputSummary = document.getElementById('output-summary');
    const outputStatusDot = document.getElementById('output-status-dot');
    const copyOutputBtn = document.getElementById('copy-output-btn');
    const clearOutputBtn = document.getElementById('clear-output-btn');
    const closeOutputBtn = document.getElementById('close-output-btn');
    const colorEditorPopover = document.getElementById('color-editor-popover');
    const colorEditorFormat = document.getElementById('color-editor-format');
    const colorPickerInput = document.getElementById('color-picker-input');
    const colorValueInput = document.getElementById('color-value-input');
    const colorEditorError = document.getElementById('color-editor-error');
    const colorEditorClose = document.getElementById('color-editor-close');
    const colorEditorCancel = document.getElementById('color-editor-cancel');
    const colorEditorApply = document.getElementById('color-editor-apply');

    let editor;
    let pendingEditProposal = null;
    let diffView = null;
    const editorContextMenu = document.getElementById('editor-context-menu');
    let filesHistory = {}; // Object to store history arrays, keyed by file path
    let allCanvasFiles = []; // Store all files for filtering
    let searchMatches = [];
    let currentMatchIndex = -1;
    let currentTheme = 'dark';
    let canvasSearchGeneration = 0;
    let historyRenderGeneration = 0;
    let isApplyingExternalContent = false;
    let currentSession = { context: 'canvas', rootDir: '', metadata: {} };
    let colorMarks = [];
    let colorScanTimer = null;
    let activeColorMark = null;

    const CSS_COLOR_PATTERN = /#(?:[\da-fA-F]{8}|[\da-fA-F]{6}|[\da-fA-F]{4}|[\da-fA-F]{3})(?![\da-fA-F])|rgba?\(\s*[^()\r\n]+\)|hsla?\(\s*[^()\r\n]+\)/g;

    const languageLabels = {
        javascript: 'JavaScript',
        'text/typescript': 'TypeScript',
        python: 'Python',
        css: 'CSS',
        htmlmixed: 'HTML',
        'application/json': 'JSON',
        markdown: 'Markdown',
        rust: 'Rust',
        'text/x-c++src': 'C++',
        'text/x-csharp': 'C#',
        'text/x-java': 'Java',
        'text/x-go': 'Go',
        'text/x-ruby': 'Ruby',
        'application/x-httpd-php': 'PHP',
        'text/x-swift': 'Swift',
        'text/x-kotlin': 'Kotlin',
        'text/x-sh': 'Shell',
        'text/x-yaml': 'YAML',
        'text/x-toml': 'TOML',
        'application/xml': 'XML',
        'text/plain': '纯文本',
    };

    function getDisplayName(path) {
        return String(path || '').split(/[\\/]/).pop() || '未命名';
    }

    function setSaveState(state, detail) {
        const labels = {
            ready: detail || '就绪',
            dirty: detail || '等待保存',
            saving: detail || '正在保存…',
            saved: detail || '已保存',
            error: detail || '保存失败',
        };
        saveStatus.textContent = labels[state] || labels.ready;
        saveStatus.className = `status-item${state === 'saving' ? ' is-saving' : ''}${state === 'saved' ? ' is-saved' : ''}${state === 'error' ? ' is-error' : ''}`;
        dirtyIndicator.textContent = state === 'dirty' || state === 'saving' ? '未保存' : labels[state];
        dirtyIndicator.classList.toggle('is-dirty', state === 'dirty' || state === 'saving');
    }

    function updateDocumentUi(path = filePathSpan.textContent) {
        const safePath = path && path !== '未保存' ? path : '';
        const extension = safePath.includes('.') ? safePath.split('.').pop().toUpperCase() : 'TXT';
        const mode = getModeForFilePath(safePath);
        activeFileName.textContent = getDisplayName(safePath);
        activeFileName.title = safePath || '未保存';
        fileTypeBadge.textContent = extension.slice(0, 5) || 'TXT';
        languageMode.textContent = languageLabels[mode] || mode;
        if (editor) {
            const lineCount = editor.lineCount();
            const charCount = editor.getValue().length;
            documentStats.textContent = `${lineCount} 行 · ${charCount} 字符`;
        }
    }

    function updateCursorStatus() {
        if (!editor) return;
        const cursor = editor.getCursor();
        const selections = editor.listSelections();
        const selectedLength = selections.reduce((total, selection) => {
            return total + editor.getRange(selection.anchor, selection.head).length;
        }, 0);
        cursorPosition.textContent = selectedLength
            ? `已选择 ${selectedLength} 字符`
            : `行 ${cursor.line + 1}，列 ${cursor.ch + 1}`;
    }

    function applySessionUi(session) {
        currentSession = session || { context: 'canvas', rootDir: '', metadata: {} };
        const sidebarTitle = document.querySelector('.sidebar h3');
        const isWidgetSource = currentSession.context === 'desktop-widget';
        const isThemeSource = currentSession.context === 'theme';

        if (sidebarTitle) {
            sidebarTitle.textContent = isWidgetSource
                ? 'Widget源码'
                : (isThemeSource ? '主题样式' : 'Canvas目录');
        }

        if (newCanvasBtn) {
            const label = newCanvasBtn.querySelector('span:last-child');
            if (label) {
                label.textContent = isWidgetSource
                    ? '新建源码文件'
                    : (isThemeSource ? '新建主题样式' : '新建 Canvas');
            }
        }

        if (errorInfoSpan) {
            errorInfoSpan.textContent = isWidgetSource
                ? `Widget源码模式${currentSession.metadata?.savedId ? ` · ${currentSession.metadata.savedId}` : ''}`
                : (isThemeSource
                    ? `主题编辑模式${currentSession.metadata?.themeName ? ` · ${currentSession.metadata.themeName}` : ''}`
                    : '无错误');
        }
    }

    function isValidCssColor(value) {
        return typeof value === 'string'
            && value.trim() !== ''
            && window.CSS?.supports?.('color', value.trim());
    }

    function cssColorToHex(value) {
        if (!isValidCssColor(value)) return null;
        const probe = document.createElement('span');
        probe.style.color = value.trim();
        probe.style.display = 'none';
        document.body.appendChild(probe);
        const computed = getComputedStyle(probe).color;
        probe.remove();

        const channels = computed.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
        if (!channels) return null;
        return `#${channels.slice(1, 4).map(channel => {
            return Math.max(0, Math.min(255, Math.round(Number(channel))))
                .toString(16)
                .padStart(2, '0');
        }).join('')}`;
    }

    function getColorFormat(value) {
        const normalized = value.trim().toLowerCase();
        if (normalized.startsWith('#')) return `HEX · ${normalized.length - 1} 位`;
        if (normalized.startsWith('hsl')) return normalized.startsWith('hsla') ? 'HSLA' : 'HSL';
        return normalized.startsWith('rgba') ? 'RGBA' : 'RGB';
    }

    function findColorAtPosition(position) {
        if (!editor || !position) return null;
        const lineText = editor.getLine(position.line) || '';
        CSS_COLOR_PATTERN.lastIndex = 0;
        let match;
        while ((match = CSS_COLOR_PATTERN.exec(lineText)) !== null) {
            const from = match.index;
            const to = from + match[0].length;
            if (position.ch >= from && position.ch <= to && isValidCssColor(match[0])) {
                return {
                    value: match[0],
                    from: { line: position.line, ch: from },
                    to: { line: position.line, ch: to },
                };
            }
        }
        return null;
    }

    function closeColorEditor({ focusEditor = true } = {}) {
        colorEditorPopover.hidden = true;
        colorEditorError.textContent = '';
        activeColorMark?.clear();
        activeColorMark = null;
        if (focusEditor) editor?.focus();
    }

    function openColorEditor(colorToken) {
        if (!colorToken) return;
        activeColorMark?.clear();
        activeColorMark = editor.markText(colorToken.from, colorToken.to, {
            clearWhenEmpty: false,
        });
        colorValueInput.value = colorToken.value;
        colorEditorFormat.textContent = getColorFormat(colorToken.value);
        colorEditorError.textContent = '';
        const pickerHex = cssColorToHex(colorToken.value);
        if (pickerHex) colorPickerInput.value = pickerHex;
        colorEditorPopover.hidden = false;
        requestAnimationFrame(() => {
            colorValueInput.focus();
            colorValueInput.select();
        });
    }

    function renderColorMarks() {
        if (!editor) return;
        colorMarks.forEach(mark => mark.clear());
        colorMarks = [];

        editor.operation(() => {
            editor.eachLine(lineHandle => {
                const lineNumber = editor.getLineNumber(lineHandle);
                const lineText = lineHandle.text;
                CSS_COLOR_PATTERN.lastIndex = 0;
                let match;
                while ((match = CSS_COLOR_PATTERN.exec(lineText)) !== null) {
                    const value = match[0];
                    if (!isValidCssColor(value)) continue;
                    const from = { line: lineNumber, ch: match.index };
                    const to = { line: lineNumber, ch: match.index + value.length };
                    const swatch = document.createElement('span');
                    swatch.className = 'cm-color-swatch';
                    swatch.style.setProperty('--cm-color-token-value', value);
                    swatch.dataset.line = String(lineNumber);
                    swatch.dataset.ch = String(match.index);
                    swatch.title = `点击编辑颜色 ${value}`;
                    swatch.setAttribute('aria-label', swatch.title);
                    swatch.setAttribute('role', 'button');
                    swatch.contentEditable = 'false';
                    swatch.draggable = false;

                    const bookmark = editor.setBookmark(from, {
                        widget: swatch,
                        insertLeft: true,
                    });
                    const mark = editor.markText(from, to, {
                        className: 'cm-color-token',
                        title: `点击编辑颜色 ${value}`,
                    });
                    colorMarks.push(bookmark, mark);
                }
            });
        });
    }

    function scheduleColorMarks() {
        clearTimeout(colorScanTimer);
        colorScanTimer = setTimeout(renderColorMarks, 160);
    }

    function applyColorEdit() {
        if (!editor || !activeColorMark) return;
        const value = colorValueInput.value.trim();
        if (!isValidCssColor(value)) {
            colorEditorError.textContent = '请输入有效的 HEX、RGB(A) 或 HSL(A) 颜色值。';
            colorValueInput.focus();
            return;
        }

        const range = activeColorMark.find();
        if (!range) {
            colorEditorError.textContent = '原颜色位置已变化，请重新点击颜色值。';
            return;
        }

        editor.replaceRange(value, range.from, range.to, '+color-picker');
        closeColorEditor();
        scheduleColorMarks();
    }

    // --- CodeMirror 5 Initialization ---
    function initializeEditor(initialData) {
        applySessionUi(initialData?.session);
        if (editor) {
            // If editor exists, just update its content
            if (initialData.current) {
                isApplyingExternalContent = true;
                editor.setValue(initialData.current.content);
                isApplyingExternalContent = false;
                filePathSpan.textContent = initialData.current.path;
                const mode = getModeForFilePath(initialData.current.path);
                editor.setOption('mode', mode);
                updateTopBarButtons(initialData.current.path);
                updateDocumentUi(initialData.current.path);
                scheduleColorMarks();
                closeColorEditor({ focusEditor: false });
                setSaveState('saved');
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
            updateDocumentUi();
            scheduleColorMarks();
            if (isApplyingExternalContent) return;
            clearTimeout(debounceTimer);
            const path = filePathSpan.textContent;
            if (path === '未保存' || !api) {
                setSaveState('dirty');
                return;
            }
            setSaveState('dirty');
            debounceTimer = setTimeout(() => {
                try {
                    setSaveState('saving');
                    const content = editor.getValue();
                    api.saveCanvasFile({ path, content });
                    addContentHistory(path, content);
                    setSaveState('saved');
                } catch (error) {
                    console.error('Canvas auto-save failed:', error);
                    setSaveState('error');
                }
            }, 900);
        });

        editor.on('cursorActivity', updateCursorStatus);

        editor.on('mousedown', (cm, event) => {
            const swatch = event.target.closest?.('.cm-color-swatch');
            const colorTokenElement = event.target.closest?.('.cm-color-token');
            if (!swatch && !colorTokenElement) return;

            const position = swatch
                ? { line: Number(swatch.dataset.line), ch: Number(swatch.dataset.ch) }
                : cm.coordsChar({ left: event.clientX, top: event.clientY }, 'window');
            const colorToken = findColorAtPosition(position);
            if (!colorToken) return;
            event.preventDefault();
            openColorEditor(colorToken);
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
            showContextMenu(editorContextMenu, e.clientX, e.clientY);
        });

        // Workbench shortcuts
        editor.addKeyMap({
            "Ctrl-F": () => {
                toggleSearchBar(true);
            },
            "Ctrl-P": () => {
                canvasSearchInput.focus();
                canvasSearchInput.select();
            },
            "Ctrl-Enter": () => {
                if (runPyBtn.style.display !== 'none') runPyBtn.click();
            },
            "Esc": () => {
                if (editorSearchBar.style.display !== 'none') {
                    toggleSearchBar(false);
                }
            }
        });

        if (initialData.current) {
            const path = initialData.current.path;
            const initialContent = initialData.current.content;
            isApplyingExternalContent = true;
            editor.setValue(initialContent);
            isApplyingExternalContent = false;
            filePathSpan.textContent = path;
            // Initialize history for this file path if it doesn't exist
            if (!filesHistory[path]) {
                filesHistory[path] = [];
            }
            addContentHistory(path, initialContent, true);
            // Set initial syntax highlighting
            const mode = getModeForFilePath(path);
            editor.setOption('mode', mode);
            updateTopBarButtons(path);
            updateDocumentUi(path);
            scheduleColorMarks();
            setSaveState('saved');
        } else {
            isApplyingExternalContent = true;
            editor.setValue('// Welcome to Canvas with CodeMirror 5!');
            isApplyingExternalContent = false;
            updateDocumentUi('');
            setSaveState('ready');
        }
        updateCursorStatus();

        if (initialData.history) {
            updateHistoryList(initialData.history);
        }

    }

    // --- Theme Handling ---
    function applyTheme(theme) {
        currentTheme = theme || 'dark';
        document.body.classList.toggle('light-theme', currentTheme === 'light');
        if (editor) {
            editor.setOption('theme', currentTheme === 'light' ? 'default' : 'material-darker');
        }
    }

    // --- IPC Event Listeners ---
    if (api) {
        api.onCanvasLoadData(async (data) => {
            initializeEditor(data);
            // After editor is initialized, get and apply the current theme
            try {
                const theme = await api.getCurrentTheme();
                applyTheme(theme);

                // Attach the theme update listener only after the editor is initialized
                // to prevent race conditions where the theme updates before the editor exists.
                if (!window.isThemeListenerAttached) {
                    api.onThemeUpdated(applyTheme);
                    window.isThemeListenerAttached = true;
                }

            } catch (error) {
                console.error('Failed to get current theme on load:', error);
                applyTheme('dark'); // Fallback to dark theme
            }
        });

        api.onCanvasFileChanged((file) => {
            const path = file.path;
            // Initialize history for this file path if it doesn't exist
            if (!filesHistory[path]) {
                filesHistory[path] = [];
            }

            if (editor && editor.getValue() !== file.content) {
                isApplyingExternalContent = true;
                editor.setValue(file.content);
                isApplyingExternalContent = false;
                const mode = getModeForFilePath(path);
                editor.setOption('mode', mode);
                updateTopBarButtons(path);
                addContentHistory(path, file.content);
                // Immediately update the UI after setting the value
                updateChangeHistoryList(path);
            }
            filePathSpan.textContent = path;
            updateDocumentUi(path);
            scheduleColorMarks();
            closeColorEditor({ focusEditor: false });
            setSaveState('saved');
            // Also ensure the list is updated even if content is the same
            // (e.g., switching back and forth between files)
            updateChangeHistoryList(path);
        });

        // Listen for direct load commands from the main process
        api.onLoadCanvasFileByPath((filePath) => {
            if (api) {
                api.loadCanvasFile(filePath);
            }
        });
 
        api.onCanvasEditProposal((proposal) => {
            if (!proposal?.requestId) return;
            pendingEditProposal = proposal;
            reviewReasonInput.value = '';
            diffReviewPath.textContent = proposal.path || '';
            externalChangeBar.style.display = 'flex';
            errorInfoSpan.textContent = 'AI 编辑提案等待审阅';
        });
  
        // Inform main process that the window is ready to receive data
        api?.canvasReady?.();
        if (api?.windowReady) {
            api.windowReady('canvas');
        }
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

    function showContextMenu(menu, x, y) {
        menu.style.display = 'block';
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - rect.width - 6))}px`;
        menu.style.top = `${Math.max(46, Math.min(y, window.innerHeight - rect.height - 6))}px`;
    }

    viewDiffBtn.addEventListener('click', () => {
        if (editor && pendingEditProposal) {
            initializeDiffView(
                pendingEditProposal.originalContent,
                pendingEditProposal.modifiedContent
            );
            diffReviewPath.textContent = pendingEditProposal.path || '';
            diffModal.style.display = 'flex';
            // Refresh the diff view after it becomes visible
            setTimeout(() => {
                if (diffView) {
                   diffView.edit.refresh();
                   diffView.right.orig.refresh();
                }
                reviewReasonInput.focus();
            }, 10);
        }
    });

    function closeDiffViewAndBar() {
        diffModal.style.display = 'none';
        externalChangeBar.style.display = 'none';
        reviewReasonInput.value = '';
        diffReviewPath.textContent = '';
        pendingEditProposal = null;
        errorInfoSpan.textContent = currentSession.context === 'desktop-widget'
            ? `Widget源码模式${currentSession.metadata?.savedId ? ` · ${currentSession.metadata.savedId}` : ''}`
            : '无错误';
    }

    function submitEditDecision(approved, fallbackReason = '') {
        if (!pendingEditProposal || !api?.sendCanvasEditDecision) return false;
        const reason = reviewReasonInput.value.trim() || fallbackReason;
        api.sendCanvasEditDecision({
            requestId: pendingEditProposal.requestId,
            approved,
            reason,
        });
        closeDiffViewAndBar();
        return true;
    }

    acceptChangesBtn.addEventListener('click', () => {
        submitEditDecision(true);
    });

    function rejectChanges(fallbackReason = '') {
        submitEditDecision(false, fallbackReason);
    }

    rejectChangesBtn.addEventListener('click', () => rejectChanges());
    dismissChangeBtn.addEventListener('click', () => {
        rejectChanges('用户未打开差异详情并直接拒绝了该提案。');
    });

    diffModal.addEventListener('click', (event) => {
        if (event.target === diffModal) {
            diffModal.style.display = 'none';
            editor?.focus();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (!colorEditorPopover.hidden) {
                closeColorEditor();
                return;
            }
            closeContextMenus();
            if (diffModal.style.display !== 'none') {
                diffModal.style.display = 'none';
                editor?.focus();
                return;
            }
        }
        if (event.ctrlKey && event.key.toLowerCase() === 'p') {
            event.preventDefault();
            if (fileSidebar.classList.contains('is-collapsed')) {
                setLeftSidebarCollapsed(false);
            }
            canvasSearchInput.focus();
            canvasSearchInput.select();
        }
    });

    colorPickerInput.addEventListener('input', () => {
        colorValueInput.value = colorPickerInput.value.toUpperCase();
        colorEditorFormat.textContent = 'HEX · 6 位';
        colorEditorError.textContent = '';
    });

    colorValueInput.addEventListener('input', () => {
        const value = colorValueInput.value.trim();
        const pickerHex = cssColorToHex(value);
        colorEditorError.textContent = value && !pickerHex ? '当前颜色值尚未生效。' : '';
        if (pickerHex) {
            colorPickerInput.value = pickerHex;
            colorEditorFormat.textContent = getColorFormat(value);
        }
    });

    colorValueInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            applyColorEdit();
        }
    });

    colorEditorApply.addEventListener('click', applyColorEdit);
    colorEditorClose.addEventListener('click', () => closeColorEditor());
    colorEditorCancel.addEventListener('click', () => closeColorEditor());

    // --- UI Event Listeners ---
    newCanvasBtn.addEventListener('click', () => {
        if (api) {
            api.createNewCanvas();
        }
    });

    toggleWrapBtn.addEventListener('click', () => {
        if (editor) {
            const currentStatus = editor.getOption('lineWrapping');
            editor.setOption('lineWrapping', !currentStatus);
            toggleWrapBtn.textContent = `自动换行：${!currentStatus ? '开' : '关'}`;
            toggleWrapBtn.setAttribute('aria-pressed', String(!currentStatus));
        }
    });

    function setLeftSidebarCollapsed(collapsed) {
        fileSidebar.classList.toggle('is-collapsed', collapsed);
        resizer.classList.toggle('is-hidden', collapsed);
        document.body.classList.toggle('left-sidebar-collapsed', collapsed);
        setTimeout(() => editor?.refresh(), 220);
    }

    function setRightSidebarCollapsed(collapsed) {
        changeHistorySidebar.classList.toggle('is-collapsed', collapsed);
        resizerRight.classList.toggle('is-hidden', collapsed);
        toggleRightBtn.setAttribute('aria-pressed', String(!collapsed));
        setTimeout(() => editor?.refresh(), 220);
    }

    collapseLeftBtn.addEventListener('click', () => setLeftSidebarCollapsed(true));
    collapseLeftTrigger.addEventListener('click', () => setLeftSidebarCollapsed(false));
    collapseRightBtn.addEventListener('click', () => setRightSidebarCollapsed(true));
    toggleRightBtn.addEventListener('click', () => {
        setRightSidebarCollapsed(!changeHistorySidebar.classList.contains('is-collapsed'));
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
            if (api) {
                api.loadCanvasFile(filePath);
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
            showContextMenu(contextMenu, e.clientX, e.clientY);
        }
    });

    function closeContextMenus() {
        contextMenu.style.display = 'none';
        editorContextMenu.style.display = 'none';
        activeListItem = null;
    }

    document.addEventListener('pointerdown', (event) => {
        const clickedInsideMenu = contextMenu.contains(event.target)
            || editorContextMenu.contains(event.target);
        if (!clickedInsideMenu) closeContextMenus();
    }, true);

    document.addEventListener('contextmenu', (event) => {
        const clickedFile = event.target.closest?.('#historyList li[data-path]');
        const clickedEditor = event.target.closest?.('.CodeMirror');
        const clickedInsideMenu = contextMenu.contains(event.target)
            || editorContextMenu.contains(event.target);
        if (!clickedFile && !clickedEditor && !clickedInsideMenu) {
            closeContextMenus();
        }
    }, true);

    window.addEventListener('blur', closeContextMenus);

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
        if (activeListItem && api) {
            const filePath = activeListItem.dataset.path;
            api.copyCanvasFile(filePath);
        }
        contextMenu.style.display = 'none';
    });

    deleteBtn.addEventListener('click', async () => {
        if (activeListItem && api) {
            const filePath = activeListItem.dataset.path;
            const fileName = await window.electronPath.basename(filePath);
            // Add a confirmation dialog before deleting
            if (confirm(`确定要删除文件 "${fileName}"? 这个操作无法撤销。`)) {
                api.deleteCanvasFile(filePath);
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
                if (api) {
                    try {
                        const newPath = await api.renameCanvasFile({ oldPath, newTitle });
                        li.textContent = newTitle;
                        li.dataset.path = newPath;
                        // If the renamed file is the active one, update the file path display
                        if (filePathSpan.textContent === oldPath) {
                            filePathSpan.textContent = newPath;
                            updateDocumentUi(newPath);
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
            if (api) api.minimizeWindow();
        });
        maximizeBtn.addEventListener('click', () => {
            if (api) api.maximizeWindow();
        });
        closeBtn.addEventListener('click', () => {
            if (api) api.closeWindow();
        });
    }

    // --- Sidebar Resizing ---
    let isResizing = false;
    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        document.body.classList.add('is-resizing');
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', () => {
            isResizing = false;
            document.body.classList.remove('is-resizing');
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
        document.body.classList.add('is-resizing');
        document.addEventListener('mousemove', handleRightMouseMove);
        document.addEventListener('mouseup', () => {
            isResizingRight = false;
            document.body.classList.remove('is-resizing');
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

    function showOutput(content, state, summary) {
        outputPanel.hidden = false;
        outputContent.textContent = content || '（没有输出）';
        outputSummary.textContent = summary;
        outputStatusDot.className = `output-status-dot is-${state}`;
    }

    runPyBtn.addEventListener('click', async () => {
        if (!editor || !api?.executePythonCode) return;
        runPyBtn.disabled = true;
        showOutput('正在执行本地 Python…', 'running', '运行中');
        try {
            const { stdout = '', stderr = '' } = await api.executePythonCode(editor.getValue());
            const sections = [];
            if (stdout) sections.push(stdout);
            if (stderr) sections.push(`STDERR\n${stderr}`);
            showOutput(sections.join('\n\n'), stderr ? 'error' : 'success', stderr ? '执行完成，存在错误输出' : '执行成功');
        } catch (error) {
            console.error('Python execution failed:', error);
            showOutput(String(error?.message || error), 'error', '执行失败');
        } finally {
            runPyBtn.disabled = false;
        }
    });

    copyOutputBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(outputContent.textContent);
        const previousText = copyOutputBtn.textContent;
        copyOutputBtn.textContent = '已复制';
        setTimeout(() => { copyOutputBtn.textContent = previousText; }, 1200);
    });
    clearOutputBtn.addEventListener('click', () => {
        outputContent.textContent = '';
        outputSummary.textContent = '已清空';
        outputStatusDot.className = 'output-status-dot';
    });
    closeOutputBtn.addEventListener('click', () => {
        outputPanel.hidden = true;
        editor?.refresh();
    });

    renderMdBtn.addEventListener('click', () => {
        if (editor && api) {
            api.openTextInNewWindow(editor.getValue(), `${getDisplayName(filePathSpan.textContent)} · Markdown 预览`, currentTheme);
        }
    });

    renderHtmlBtn.addEventListener('click', () => {
        if (editor && api) {
            api.openTextInNewWindow(editor.getValue(), `${getDisplayName(filePathSpan.textContent)} · HTML 预览`, currentTheme);
        }
    });

    // --- Helper Functions ---
    function getModeForFilePath(filePath) {
        if (!filePath) {
            updateTopBarButtons('');
            return 'text/plain';
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
            li.title = item.path;
            li.tabIndex = 0;
            if (item.isActive || item.path === filePathSpan.textContent) {
                li.classList.add('active');
            }
            historyList.appendChild(li);
        });
    }

    historyList.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const item = event.target.closest('li[data-path]');
        if (!item || !api) return;
        event.preventDefault();
        api.loadCanvasFile(item.dataset.path);
    });

    canvasSearchInput.addEventListener('input', async () => {
        const generation = ++canvasSearchGeneration;
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
                const fileData = await api.getTextContent(file.path);
                const fileText = typeof fileData === 'string'
                    ? fileData
                    : (typeof fileData?.text === 'string' ? fileData.text : '');
                if (fileText.toLowerCase().includes(searchTerm)) {
                    filteredFiles.push(file);
                }
            } catch (err) {
                console.error(`Failed to search in file ${file.path}:`, err);
            }
        }
        if (generation === canvasSearchGeneration) {
            renderHistoryList(filteredFiles);
        }
    });

    // --- Document Change History Logic ---
    function addContentHistory(path, content, isInitial = false) {
        if (!path || !filesHistory[path]) return;

        const history = filesHistory[path];
        // Never append identical adjacent snapshots. This also protects against
        // repeated load events during window initialization.
        if (history.length > 0 && history[history.length - 1].content === content) {
            updateChangeHistoryList(path);
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
        const generation = ++historyRenderGeneration;
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
        if (generation !== historyRenderGeneration || path !== filePathSpan.textContent) return;

        changeHistoryList.innerHTML = '';
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
