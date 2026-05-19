const api = window.utilityAPI || window.electronAPI;

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
    const noteBody = document.querySelector('.note-body');
    const editorContainer = document.querySelector('.editor-container');
    const previewContainer = document.querySelector('.preview-container');
    const editorPreviewResizer = document.getElementById('editorPreviewResizer');
    const confirmationModal = document.getElementById('confirmationModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalMessage = document.getElementById('modalMessage');
    const modalConfirmBtn = document.getElementById('modalConfirmBtn');
    const modalCancelBtn = document.getElementById('modalCancelBtn');
    const editorFindBar = document.getElementById('editorFindBar');
    const editorFindInput = document.getElementById('editorFindInput');
    const editorFindStatus = document.getElementById('editorFindStatus');
    const editorFindPrev = document.getElementById('editorFindPrev');
    const editorFindNext = document.getElementById('editorFindNext');
    const editorFindClose = document.getElementById('editorFindClose');
    const editorContextMenu = document.getElementById('editorContextMenu');
    const editorContextUndo = document.getElementById('editor-context-undo');
    const editorContextCut = document.getElementById('editor-context-cut');
    const editorContextCopy = document.getElementById('editor-context-copy');
    const editorContextPaste = document.getElementById('editor-context-paste');
    const editorContextSelectAll = document.getElementById('editor-context-select-all');

    // --- Custom Title Bar Elements ---
    const previewToggleBtn = document.getElementById('preview-toggle-btn');
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
        lastDragOverVisualElement: null,
        dropAction: null, // Can be 'before', 'after', 'inside'
        rafId: null,
        autoScrollFrameId: null,
        pendingDragOverEvent: null,
        lastPointer: null,
    };

    // --- SVG Icons ---
    const FOLDER_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="item-icon"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"></path></svg>`;
    const CLOUD_FOLDER_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="item-icon"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"></path></svg>`;
    const NOTE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="item-icon"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"></path></svg>`;
    const TOGGLE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="folder-toggle"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"></path></svg>`;


    // --- Preview Panel Toggle ---
    function updatePreviewToggleState(isPreviewCollapsed) {
        document.body.classList.toggle('preview-collapsed', isPreviewCollapsed);
        previewToggleBtn.classList.toggle('is-collapsed', isPreviewCollapsed);
        previewToggleBtn.title = isPreviewCollapsed ? '打开预览区' : '关闭预览区';
        previewToggleBtn.setAttribute('aria-label', isPreviewCollapsed ? '打开预览区' : '关闭预览区');
        previewToggleBtn.setAttribute('aria-pressed', String(isPreviewCollapsed));
        localStorage.setItem('notesPreviewCollapsed', String(isPreviewCollapsed));

        if (window.pretextBridge && window.pretextBridge.isReady()) {
            requestAnimationFrame(() => window.pretextBridge.recalculateAll(window.innerWidth));
        }
    }

    function togglePreviewPanel() {
        updatePreviewToggleState(!document.body.classList.contains('preview-collapsed'));
    }


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

    // --- Loading & Notification Helpers ---
    function showLoadingOverlay(message) {
        let overlay = document.getElementById('loading-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'loading-overlay';
            // Using CSS text for simplicity; ideally this would be a class
            overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); display:flex; justify-content:center; align-items:center; z-index:10000; color:white; flex-direction:column;';
            const p = document.createElement('p');
            overlay.appendChild(p);
            document.body.appendChild(overlay);
        }
        overlay.querySelector('p').textContent = message;
        overlay.style.display = 'flex';
    }

    function hideLoadingOverlay() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) overlay.style.display = 'none';
    }

    function createModal(title, message, id) {
        return new Promise((resolve) => {
            const existingModal = document.getElementById(id);
            if (existingModal) existingModal.remove();

            const modal = document.createElement('div');
            modal.id = id;
            modal.className = 'confirmation-modal'; // Reuse existing styles if possible
            modal.style.display = 'flex';
            // Inlined some styles to ensure it's visible without external CSS
            modal.innerHTML = `
                <div class="modal-content" style="background:var(--bg-color, #222); border: 1px solid var(--border-color, #444); padding: 20px; border-radius: 5px; box-shadow: 0 5px 15px rgba(0,0,0,0.5);">
                    <h2 class="modal-title" style="margin-top:0;">${title}</h2>
                    <p class="modal-message">${message}</p>
                    <div class="modal-buttons" style="text-align: right; margin-top: 20px;">
                        <button class="modal-ok-btn a-button">好</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            const okButton = modal.querySelector('.modal-ok-btn');
            const closeHandler = () => {
                modal.remove();
                resolve();
            };
            okButton.addEventListener('click', closeHandler);
        });
    }

    async function showInfoModal(title, message) {
        // We don't use the promise here, but it standardizes the interface
        await createModal(title, message, 'info-modal');
    }

    async function showErrorModal(title, message) {
        await createModal(title, `<span style="color:var(--error-color, #f44336);">${message}</span>`, 'error-modal');
    }

    // --- Theme Management ---
    let currentMermaidTheme = null;
    function applyTheme(theme) {
        const currentTheme = theme || 'dark'; // Fallback to dark if theme is null/undefined
        const highlightThemeStyle = document.getElementById('highlight-theme-style');
        
        document.body.classList.toggle('light-theme', currentTheme === 'light');

        if (highlightThemeStyle) {
            highlightThemeStyle.href = currentTheme === 'light'
                ? "../vendor/atom-one-light.min.css"
                : "../vendor/atom-one-dark.min.css";
        }

        // Sync mermaid theme so subsequent diagrams match the app theme.
        const desiredMermaidTheme = currentTheme === 'light' ? 'default' : 'dark';
        if (window.mermaid && typeof window.mermaid.initialize === 'function'
            && desiredMermaidTheme !== currentMermaidTheme) {
            try {
                window.mermaid.initialize({
                    startOnLoad: false,
                    theme: desiredMermaidTheme,
                    securityLevel: 'loose'
                });
                const previousTheme = currentMermaidTheme;
                currentMermaidTheme = desiredMermaidTheme;
                // Re-render the active note so the new mermaid theme takes effect.
                if (previousTheme !== null && activeNoteId) {
                    const note = findItemById(getCombinedTree(), activeNoteId);
                    if (note) renderMarkdown(note.content);
                }
            } catch (e) {
                console.warn('[Notes] Failed to re-initialize mermaid theme:', e);
            }
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
        // Do not split fenced code info strings such as ```mermaid / ```js.
        // Splitting them into "```\nmermaid" makes marked lose the language hint.
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
            ADD_ATTR: ['style', 'class'], // Keep inline styles and semantic classes such as mermaid.
            ALLOW_UNKNOWN_PROTOCOLS: true,
            FORCE_BODY: true
        });

        // Re-combine the sanitized body with the original, un-sanitized style blocks.
        previewContentDiv.innerHTML = styleBlocks.join('\n') + cleanHtmlBody;

        // --- Extract Mermaid blocks BEFORE hljs runs (hljs would inject spans and break parsing) ---
        const mermaidNodes = collectMermaidNodes(previewContentDiv);

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

        // Render mermaid diagrams (async). Capture the current note id so a quick switch
        // between notes won't paint stale diagrams into the new note.
        if (mermaidNodes.length > 0) {
            const renderTokenId = activeNoteId;
            renderMermaidNodes(mermaidNodes, renderTokenId);
        }

        // --- Pretext Integration ---
        // 为笔记预览生成 Pretext 高度缓存 (使用当前预览容器宽度)
        if (window.pretextBridge && window.pretextBridge.isReady() && activeNoteId) {
            const previewWidth = previewContentDiv.offsetWidth || 500;
            window.pretextBridge.estimateHeight('note-' + activeNoteId, markdown, 'note', previewWidth);
        }
    }

    // --- Mermaid helpers ---
    function escapeHtmlForMermaid(text) {
        if (typeof text !== 'string') return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Mermaid diagram-type keyword patterns. If a fenced block starts with one of these
    // (and has no other obvious language), we treat it as mermaid even when the language
    // tag is missing or marked didn't attach a `language-*` class.
    const MERMAID_CONTENT_PATTERN = /^\s*(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|requirementDiagram|quadrantChart|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|xychart-beta|sankey-beta|block-beta)\b/;
    const MERMAID_LANGUAGES = new Set(['mermaid', 'graph', 'flowchart']);

    // Find code blocks rendered by marked and replace mermaid ones with a <div class="mermaid">
    // node that mermaid.run() can take over. Works for both:
    //   <pre><code class="language-mermaid">...</code></pre>
    //   <pre><code>graph TD ...</code></pre>   (no language tag, detected by content)
    function collectMermaidNodes(container) {
        const nodes = Array.from(container.querySelectorAll('.mermaid'));
        nodes.push(...extractMermaidBlocks(container));
        return [...new Set(nodes)];
    }

    function extractMermaidBlocks(container) {
        const nodes = [];
        const codeBlocks = container.querySelectorAll('pre code');
        codeBlocks.forEach((codeBlock) => {
            // textContent decodes HTML entities so '&gt;' becomes '>', which mermaid needs.
            const code = (codeBlock.textContent || '').trim();
            if (!code) return;

            // Look at language hints in a few common forms.
            const langClass = Array.from(codeBlock.classList)
                .find(c => c.startsWith('language-') || c.startsWith('lang-'));
            const language = langClass
                ? langClass.replace(/^(?:language-|lang-)/, '').toLowerCase()
                : '';

            const matchByLanguage = MERMAID_LANGUAGES.has(language);
            // Only fall back to content sniffing when there's NO language tag, to avoid
            // hijacking unrelated code blocks (e.g. a "graph" variable in a JS snippet).
            const matchByContent = !language && MERMAID_CONTENT_PATTERN.test(code);

            if (!matchByLanguage && !matchByContent) return;

            const preElement = codeBlock.parentElement;
            if (!preElement || !preElement.parentNode) return;

            const mermaidContainer = document.createElement('div');
            mermaidContainer.className = 'mermaid';
            mermaidContainer.textContent = code;
            preElement.parentNode.replaceChild(mermaidContainer, preElement);
            nodes.push(mermaidContainer);
        });
        return nodes;
    }

    async function renderMermaidNodes(nodes, renderTokenId) {
        if (!window.mermaid || nodes.length === 0) return;
        try {
            nodes.forEach(node => node.removeAttribute('data-processed'));
            if (typeof window.mermaid.run === 'function') {
                await window.mermaid.run({ nodes });
            } else if (typeof window.mermaid.init === 'function') {
                window.mermaid.init(undefined, nodes);
            }
        } catch (error) {
            console.error('[Notes] Mermaid render error:', error);
            nodes.forEach(el => {
                if (!el.isConnected) return;
                const originalCode = el.textContent || '';
                el.innerHTML = `<div class="mermaid-error">Mermaid 渲染错误: ${escapeHtmlForMermaid(error.message || String(error))}</div><pre>${escapeHtmlForMermaid(originalCode)}</pre>`;
            });
        }

        // If the user switched notes while mermaid was rendering, drop the stale output.
        if (renderTokenId !== activeNoteId) {
            nodes.forEach(el => {
                if (el.isConnected && el.parentNode === previewContentDiv.parentNode) {
                    // No-op; the next renderMarkdown will overwrite previewContentDiv.innerHTML.
                }
            });
        }
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
                if (api && api.openImageInNewWindow) {
                    api.openImageInNewWindow(imageUrl, imageTitle);
                } else {
                    console.error('Image viewer API is not available.');
                }
            });
        });
    }

    // --- Core Data & File System Logic ---
    async function loadNoteTree() {
        try {
            const result = await api.readNotesTree();
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
            let displayName = item.name || item.title;
            let icon = FOLDER_ICON; // Default icon

            // Specifically target the cloud 'dailynote' folder
            if (isCloudItem(item.id) && displayName.includes('dailynote')) {
                displayName = 'VCP核心记忆库';
                icon = CLOUD_FOLDER_ICON;
                folderHeader.classList.add('dailynote-folder');
            }
            
            const nameSpan = `<span class="item-name">${displayName}</span>`;
            folderHeader.innerHTML = `${TOGGLE_ICON} ${icon} ${nameSpan}`;
            folderHeader.querySelector('.folder-toggle').classList.toggle('collapsed', isCollapsed);
            
            // Apply selection/active styles to the header for visual consistency
            if (selectedItems.has(item.id)) folderHeader.classList.add('selected');
            if (activeItemId === item.id) folderHeader.classList.add('active');
    
            li.appendChild(folderHeader);
    
            const childrenUl = document.createElement('ul');
            childrenUl.className = 'folder-content';
            childrenUl.classList.toggle('collapsed', isCollapsed);

            // PERFORMANCE: Do not build hidden subtree DOM for collapsed folders.
            // Large cloud folders can contain thousands of notes; keeping their hidden DOM around
            // makes dragover hit-testing and selector scans visibly stutter.
            if (item.children && !isCollapsed) {
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

    // PERFORMANCE: Update only the selection/active visual state without rebuilding the tree.
    // Used by click & context-menu paths so they don't block the main thread on large trees.
    function updateSelectionVisuals() {
        // Clear current visuals
        noteList.querySelectorAll('.selected, .active').forEach(el => {
            el.classList.remove('selected', 'active');
        });

        const getVisualTarget = (li) => {
            if (!li) return null;
            return li.matches('.note-item') ? li : li.querySelector(':scope > .folder-header-row');
        };

        // Apply selection
        selectedItems.forEach(id => {
            const li = noteList.querySelector(`li[data-id="${CSS.escape(id)}"]`);
            const target = getVisualTarget(li);
            if (target) target.classList.add('selected');
        });

        // Apply active
        if (activeItemId) {
            const li = noteList.querySelector(`li[data-id="${CSS.escape(activeItemId)}"]`);
            const target = getVisualTarget(li);
            if (target) target.classList.add('active');
        }
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
        // PERFORMANCE: Avoid re-rendering the whole tree just to move the selection highlight.
        updateSelectionVisuals();
    }

    async function selectNote(id, notePath) {
        activeNoteId = id;
        localStorage.setItem('lastActiveNoteId', id);
        
        const note = findItemById(getCombinedTree(), id);
        if (note) {
            noteTitleInput.value = note.title;
            noteContentInput.value = note.content;
            
            // 异步渲染：先让 UI 响应点击（显示标题和文本），再进行重度渲染
            setTimeout(() => {
                // 检查在定时器触发时，用户是否还在看这个笔记
                if (activeNoteId === id) {
                    renderMarkdown(note.content);
                }
            }, 0);

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
            parentPath = await api.getNotesRootDir();
        }

        if (type === 'folder') {
            const folderName = '新建文件夹';
            await api.createNoteFolder({ parentPath, folderName });
        } else {
            const newNote = {
                title: '无标题笔记',
                content: '',
                username: currentUsername,
                timestamp: Date.now(),
                directoryPath: parentPath,
                ext: ext // Pass the extension to the backend
            };
            const result = await api.writeTxtNote(newNote);
            if (result.success) {
                activeItemId = result.id;
                activeNoteId = result.id;
            }
        }
        await loadNoteTree();
    }

    // --- Save & Delete Logic ---
    const debouncedSaveNote = debounce(() => saveCurrentNote(true), 3000);
    const debouncedRender = debounce((content) => renderMarkdown(content), 300);

    // --- Editor Search & Context Menu Logic ---
    let editorSearchMatches = [];
    let editorSearchIndex = -1;

    function isEditorFocused() {
        return document.activeElement === noteContentInput;
    }

    function updateEditorFindStatus() {
        const total = editorSearchMatches.length;
        const current = total > 0 ? editorSearchIndex + 1 : 0;
        editorFindStatus.textContent = `${current}/${total}`;
        editorFindPrev.disabled = total === 0;
        editorFindNext.disabled = total === 0;
    }

    function collectEditorSearchMatches(query) {
        editorSearchMatches = [];
        editorSearchIndex = -1;

        if (!query) {
            updateEditorFindStatus();
            return;
        }

        const content = noteContentInput.value;
        const lowerContent = content.toLowerCase();
        const lowerQuery = query.toLowerCase();
        let fromIndex = 0;

        while (fromIndex <= lowerContent.length) {
            const matchIndex = lowerContent.indexOf(lowerQuery, fromIndex);
            if (matchIndex === -1) break;

            editorSearchMatches.push(matchIndex);
            fromIndex = matchIndex + Math.max(lowerQuery.length, 1);
        }

        updateEditorFindStatus();
    }

    function selectEditorSearchMatch(index, options = {}) {
        const { focusEditor = true } = options;

        if (editorSearchMatches.length === 0) {
            updateEditorFindStatus();
            return;
        }

        const query = editorFindInput.value;
        editorSearchIndex = (index + editorSearchMatches.length) % editorSearchMatches.length;
        const matchStart = editorSearchMatches[editorSearchIndex];
        const matchEnd = matchStart + query.length;

        const lineHeight = parseFloat(getComputedStyle(noteContentInput).lineHeight) || 22;
        const textBeforeMatch = noteContentInput.value.slice(0, matchStart);
        const lineIndex = textBeforeMatch.split('\n').length - 1;
        const targetScrollTop = Math.max(0, (lineIndex * lineHeight) - (noteContentInput.clientHeight / 2));
        noteContentInput.scrollTop = targetScrollTop;

        if (focusEditor) {
            noteContentInput.focus();
            noteContentInput.setSelectionRange(matchStart, matchEnd);
        }

        updateEditorFindStatus();
    }

    function findEditorMatch(direction = 1) {
        const query = editorFindInput.value;
        collectEditorSearchMatches(query);

        if (editorSearchMatches.length === 0) return;

        const selectionStart = noteContentInput.selectionStart;
        if (direction >= 0) {
            const nextIndex = editorSearchMatches.findIndex(matchIndex => matchIndex >= selectionStart + (editorSearchIndex >= 0 ? 1 : 0));
            selectEditorSearchMatch(nextIndex === -1 ? 0 : nextIndex);
        } else {
            let previousIndex = editorSearchMatches.length - 1;
            for (let i = editorSearchMatches.length - 1; i >= 0; i--) {
                if (editorSearchMatches[i] < selectionStart) {
                    previousIndex = i;
                    break;
                }
            }
            selectEditorSearchMatch(previousIndex);
        }
    }

    function openEditorFindBar() {
        editorFindBar.hidden = false;
        const selectedText = noteContentInput.value.slice(noteContentInput.selectionStart, noteContentInput.selectionEnd);
        if (selectedText && !selectedText.includes('\n')) {
            editorFindInput.value = selectedText;
        }
        editorFindInput.focus();
        editorFindInput.select();
        collectEditorSearchMatches(editorFindInput.value);
        if (editorFindInput.value) findEditorMatch(1);
    }

    function closeEditorFindBar() {
        editorFindBar.hidden = true;
        editorSearchMatches = [];
        editorSearchIndex = -1;
        noteContentInput.focus();
    }

    function runEditorCommand(command) {
        noteContentInput.focus();
        document.execCommand(command);
        if (command === 'cut' || command === 'paste' || command === 'undo') {
            noteContentInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    async function pasteTextIntoEditor() {
        noteContentInput.focus();

        try {
            if (navigator.clipboard?.readText) {
                const text = await navigator.clipboard.readText();
                const { selectionStart, selectionEnd, value } = noteContentInput;
                noteContentInput.value = `${value.slice(0, selectionStart)}${text}${value.slice(selectionEnd)}`;
                const caret = selectionStart + text.length;
                noteContentInput.setSelectionRange(caret, caret);
                noteContentInput.dispatchEvent(new Event('input', { bubbles: true }));
                return;
            }
        } catch (error) {
            console.warn('读取剪贴板失败，回退到浏览器粘贴命令:', error);
        }

        runEditorCommand('paste');
    }

    function hideEditorContextMenu() {
        editorContextMenu.style.display = 'none';
    }

    function updateEditorContextMenuState() {
        const hasSelection = noteContentInput.selectionStart !== noteContentInput.selectionEnd;
        editorContextCut.classList.toggle('disabled', !hasSelection);
        editorContextCopy.classList.toggle('disabled', !hasSelection);
    }

    function showEditorContextMenu(e) {
        e.preventDefault();
        e.stopPropagation();

        customContextMenu.style.display = 'none';
        updateEditorContextMenuState();

        editorContextMenu.style.left = `${e.clientX}px`;
        editorContextMenu.style.top = `${e.clientY}px`;
        editorContextMenu.style.display = 'block';
    }

    editorFindInput.addEventListener('input', () => {
        collectEditorSearchMatches(editorFindInput.value);
        if (editorSearchMatches.length > 0) {
            selectEditorSearchMatch(0, { focusEditor: false });
            editorFindInput.focus();
        }
    });

    editorFindInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            findEditorMatch(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeEditorFindBar();
        }
    });

    editorFindPrev.addEventListener('click', () => findEditorMatch(-1));
    editorFindNext.addEventListener('click', () => findEditorMatch(1));
    editorFindClose.addEventListener('click', closeEditorFindBar);

    noteContentInput.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            openEditorFindBar();
        } else if (e.key === 'Escape' && !editorFindBar.hidden) {
            e.preventDefault();
            closeEditorFindBar();
        }
    });

    noteContentInput.addEventListener('contextmenu', showEditorContextMenu);

    editorContextUndo.addEventListener('click', () => {
        runEditorCommand('undo');
        hideEditorContextMenu();
    });

    editorContextCut.addEventListener('click', () => {
        if (!editorContextCut.classList.contains('disabled')) runEditorCommand('cut');
        hideEditorContextMenu();
    });

    editorContextCopy.addEventListener('click', () => {
        if (!editorContextCopy.classList.contains('disabled')) runEditorCommand('copy');
        hideEditorContextMenu();
    });

    editorContextPaste.addEventListener('click', async () => {
        await pasteTextIntoEditor();
        hideEditorContextMenu();
    });

    editorContextSelectAll.addEventListener('click', () => {
        noteContentInput.focus();
        noteContentInput.select();
        hideEditorContextMenu();
    });

    document.addEventListener('keydown', (e) => {
        if (isEditorFocused() && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            openEditorFindBar();
        }
    }, true);

    noteTitleInput.addEventListener('input', debouncedSaveNote);
    noteContentInput.addEventListener('input', (e) => {
        debouncedRender(e.target.value);
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
            result = await api.renameItem({
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
            result = await api.writeTxtNote(noteData);
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
        if (!dragElement || !noteList.contains(dragElement)) {
            e.preventDefault();
            return;
        }

        // Reset stale drag state from any previous interrupted drag.
        cleanupDragOverVisuals();
        dragState.sourceIds = null;
        dragState.dropAction = null;
        dragState.pendingDragOverEvent = null;
        dragState.lastPointer = null;
        if (dragState.rafId) {
            cancelAnimationFrame(dragState.rafId);
            dragState.rafId = null;
        }
        stopDragAutoScroll();
    
        const id = dragElement.dataset.id;
        // PERFORMANCE FIX: Manually update selection instead of re-rendering the whole tree.
        if (!selectedItems.has(id)) {
            selectedItems.clear();
            selectedItems.add(id);
            activeItemId = id;
            updateSelectionVisuals();
        }
    
        dragState.sourceIds = Array.from(selectedItems);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/vnd.vcp-notes.items+json', JSON.stringify(dragState.sourceIds));
    
        // Immediately add dragging class synchronously for snappier visual feedback
        dragState.sourceIds.forEach(selectedId => {
            const el = noteList.querySelector(`li[data-id="${CSS.escape(selectedId)}"]`);
            if (el) el.classList.add('dragging');
        });
        
        // Asynchronously check and disable selection listener without blocking dragstart
        if (api && api.getSelectionListenerStatus) {
            api.getSelectionListenerStatus().then(isActive => {
                wasSelectionListenerActive = isActive;
                if (isActive && api.toggleSelectionListener) {
                    api.toggleSelectionListener(false);
                }
            }).catch(err => {
                console.error('Failed to get selection listener status:', err);
            });
        }
    }

    function stopDragAutoScroll() {
        if (dragState.autoScrollFrameId) {
            cancelAnimationFrame(dragState.autoScrollFrameId);
            dragState.autoScrollFrameId = null;
        }
    }

    function updateDragAutoScroll(clientY) {
        if (!dragState.sourceIds) {
            stopDragAutoScroll();
            return;
        }

        dragState.lastPointer = {
            ...(dragState.lastPointer || {}),
            clientY
        };

        if (dragState.autoScrollFrameId) return;

        const scrollStep = () => {
            dragState.autoScrollFrameId = null;

            if (!dragState.sourceIds || !dragState.lastPointer) return;

            const listRect = noteList.getBoundingClientRect();
            const threshold = 56;
            const maxSpeed = 18;
            const { clientX, clientY: pointerY } = dragState.lastPointer;
            let speed = 0;

            if (pointerY < listRect.top + threshold) {
                speed = -Math.ceil(((listRect.top + threshold - pointerY) / threshold) * maxSpeed);
            } else if (pointerY > listRect.bottom - threshold) {
                speed = Math.ceil(((pointerY - (listRect.bottom - threshold)) / threshold) * maxSpeed);
            }

            if (speed !== 0) {
                noteList.scrollTop += speed;

                // After scrolling, the element under the pointer changes even if dragover does not fire.
                // Recalculate the target from viewport coordinates so top -> bottom dragging remains reliable.
                if (typeof clientX === 'number') {
                    scheduleDragOverUpdateFromPoint(clientX, pointerY);
                }

                dragState.autoScrollFrameId = requestAnimationFrame(scrollStep);
            }
        };

        dragState.autoScrollFrameId = requestAnimationFrame(scrollStep);
    }

    function cleanupDragOverVisuals() {
        if (dragState.lastDragOverVisualElement) {
            dragState.lastDragOverVisualElement.classList.remove('drag-over-folder', 'drag-over-target-top', 'drag-over-target-bottom');
        }
        dragState.lastDragOverElement = null;
        dragState.lastDragOverVisualElement = null;
        dragState.dropAction = null;
    }

    function getRowItemElement(row) {
        if (!row || !noteList.contains(row)) return null;
        return row.matches('.note-item') ? row : row.closest('li.folder-item');
    }

    function isInvalidDropTarget(targetElement) {
        if (!dragState.sourceIds || !targetElement) return true;

        const targetId = targetElement.dataset.id;
        if (dragState.sourceIds.includes(targetId)) return true;

        // Prevent dropping a folder into one of its own descendants.
        return dragState.sourceIds.some(sourceId => {
            const sourceElement = noteList.querySelector(`li[data-id="${CSS.escape(sourceId)}"]`);
            return sourceElement && sourceElement !== targetElement && sourceElement.contains(targetElement);
        });
    }

    function getVisibleDropRows() {
        const listRect = noteList.getBoundingClientRect();
        return Array.from(noteList.querySelectorAll('.note-item, .folder-header-row'))
            .map(row => {
                const itemElement = getRowItemElement(row);
                const rect = row.getBoundingClientRect();
                return { row, itemElement, rect };
            })
            .filter(entry => {
                const { itemElement, rect } = entry;
                return itemElement
                    && itemElement.matches('li[draggable="true"]')
                    && rect.bottom >= listRect.top
                    && rect.top <= listRect.bottom
                    && !isInvalidDropTarget(itemElement);
            });
    }

    function computeDropIntentFromPoint(clientX, clientY) {
        if (!dragState.sourceIds) return null;

        const element = document.elementFromPoint(clientX, clientY);
        const directRow = element?.closest('.note-item, .folder-header-row');
        const directItem = getRowItemElement(directRow);

        // Only a direct hit on the folder header can become "inside".
        if (directRow && directItem && !isInvalidDropTarget(directItem) && directItem.dataset.type === 'folder') {
            const rect = directRow.getBoundingClientRect();
            const offsetY = clientY - rect.top;
            const insideThreshold = Math.max(6, rect.height * 0.28);

            if (offsetY >= insideThreshold && (rect.bottom - clientY) >= insideThreshold) {
                return {
                    targetElement: directItem,
                    visualElement: directRow,
                    dropAction: 'inside'
                };
            }
        }

        const rows = getVisibleDropRows();
        if (rows.length === 0) return null;

        // Reorder by row center, not by "nearest row". This makes downward moves deterministic:
        // pointer below a row center means "after" that row, not "before the nearest lower row".
        let candidate = rows[rows.length - 1];
        let action = 'after';

        for (const entry of rows) {
            const centerY = entry.rect.top + entry.rect.height / 2;
            if (clientY < centerY) {
                candidate = entry;
                action = 'before';
                break;
            }
        }

        return {
            targetElement: candidate.itemElement,
            visualElement: candidate.row,
            dropAction: action
        };
    }

    function applyDropIntentVisuals(intent) {
        if (!dragState.sourceIds) return;

        if (!intent) {
            cleanupDragOverVisuals();
            return;
        }

        const { targetElement, visualElement, dropAction } = intent;

        if (dragState.lastDragOverVisualElement && dragState.lastDragOverVisualElement !== visualElement) {
            dragState.lastDragOverVisualElement.classList.remove('drag-over-folder', 'drag-over-target-top', 'drag-over-target-bottom');
        }

        dragState.lastDragOverElement = targetElement;
        dragState.lastDragOverVisualElement = visualElement;
        dragState.dropAction = dropAction;

        visualElement.classList.toggle('drag-over-folder', dropAction === 'inside');
        visualElement.classList.toggle('drag-over-target-top', dropAction === 'before');
        visualElement.classList.toggle('drag-over-target-bottom', dropAction === 'after');
    }

    function scheduleDragOverUpdateFromPoint(clientX, clientY) {
        const intent = computeDropIntentFromPoint(clientX, clientY);

        dragState.pendingDragOverEvent = intent;

        if (dragState.rafId) return;

        dragState.rafId = requestAnimationFrame(() => {
            dragState.rafId = null;
            const pending = dragState.pendingDragOverEvent;
            dragState.pendingDragOverEvent = null;
            applyDropIntentVisuals(pending);
        });
    }

    function scheduleDragOverUpdate(e) {
        dragState.lastPointer = {
            clientX: e.clientX,
            clientY: e.clientY
        };
        scheduleDragOverUpdateFromPoint(e.clientX, e.clientY);
    }

    function handleListDragOver(e) {
        e.preventDefault(); // Necessary to allow for dropping
        if (!dragState.sourceIds) return;

        e.dataTransfer.dropEffect = 'move'; // 明确指示移动操作
        updateDragAutoScroll(e.clientY);
        scheduleDragOverUpdate(e);
    }

function handleListDragLeave(e) {
    if (!noteList.contains(e.relatedTarget)) {
        cleanupDragOverVisuals();
        stopDragAutoScroll();
    }
}

async function handleListDrop(e) {
    e.preventDefault();
    e.stopPropagation();

    // Keep local references to avoid race conditions if dragState is mutated elsewhere.
    let dropTargetElement = dragState.lastDragOverElement;
    let dropAction = dragState.dropAction;
    const sourceIds = Array.isArray(dragState.sourceIds) ? [...dragState.sourceIds] : null;

    // Always recompute at drop time. Dragover can be stale after auto-scroll, and using the stale
    // target is exactly what caused "drag down but move up / only move a little".
    if (dragState.lastPointer) {
        const finalIntent = computeDropIntentFromPoint(dragState.lastPointer.clientX, dragState.lastPointer.clientY);
        if (finalIntent) {
            dropTargetElement = finalIntent.targetElement;
            dropAction = finalIntent.dropAction;
        }
    }

    // --- Cleanup visuals first ---
    cleanupDragOverVisuals();
    
    // --- Validate Drop ---
    if (!dropTargetElement || !dropAction || !sourceIds || sourceIds.length === 0) {
        handleListDragEnd(e);
        return;
    }
    
    const sourcePaths = sourceIds.map(id => findItemById(getCombinedTree(), id)?.path).filter(Boolean);
    if (sourcePaths.length !== sourceIds.length) {
        console.error("Could not find paths for all source IDs.");
        handleListDragEnd(e);
        return;
    }
    
    const targetId = dropTargetElement.dataset.id;
    const targetItem = findItemById(getCombinedTree(), targetId);
    if (!targetItem) {
        handleListDragEnd(e);
        return;
    }
    
    // --- Build Intent ---
    let target;
    try {
        target = {
            targetId: targetItem.id,
            position: dropAction,
            destPath: dropAction === 'inside' ? targetItem.path : await window.electronPath.dirname(targetItem.path)
        };
    } catch(error) {
        console.error("Error building drop target:", error);
        handleListDragEnd(e);
        return;
    }
    
    // Before executing heavy async work, clear UI dragging classes but keep local data intact.
    noteList.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
    // Do NOT immediately null out dragState.sourceIds here — let handleListDragEnd manage final reset.
    
    // --- Execute operation with feedback ---
    try {
        const result = await api['notes:move-items']({ sourcePaths, target });
        
        if (!result || !result.success) {
            await showErrorModal('移动失败', result.error || '发生未知错误。');
        } else if (result.renamedItems && result.renamedItems.length > 0) {
            // 使用简单的字符串处理来获取文件名
            const getFileName = (path) => {
                const parts = path.split(/[\\/]/);
                return parts[parts.length - 1];
            };
            
            const message = result.renamedItems.map(item =>
                `"${getFileName(item.oldPath)}" 已重命名为 "${getFileName(item.newPath)}"`
            ).join('<br>');
            await showInfoModal('文件已自动重命名', message);
        }
    } catch (error) {
        console.error('handleListDrop failed unexpectedly:', error);
        await showErrorModal('移动失败', error.message);
    } finally {
        // ALWAYS reload the tree. Avoid showing a full-screen overlay to prevent flashing.
        await loadNoteTree();
        // Now perform the definitive cleanup of drag state & visuals
        handleListDragEnd(e);
    }
}

function handleListDragEnd(e) {
    // Prevent double execution if the drag was already fully cleaned.
    if (!dragState.sourceIds && !dragState.lastDragOverElement && !dragState.lastDragOverVisualElement && !dragState.rafId) return;

    if (dragState.rafId) {
        cancelAnimationFrame(dragState.rafId);
    }
    stopDragAutoScroll();

    // Clear dragging classes
    noteList.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));

    // Clear drag over visuals
    cleanupDragOverVisuals();

    // Reset drag state
    dragState = {
        sourceIds: null,
        lastDragOverElement: null,
        lastDragOverVisualElement: null,
        dropAction: null,
        rafId: null,
        autoScrollFrameId: null,
        pendingDragOverEvent: null,
        lastPointer: null,
    };

    // Re-enable global selection listener only if it was active before the drag.
    if (api && api.toggleSelectionListener) {
        if (wasSelectionListenerActive) {
            api.toggleSelectionListener(true);
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
            // PERFORMANCE: Only repaint selection state instead of rebuilding the tree.
            updateSelectionVisuals();
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

        const isProtected = isCloudItem(item.id) && (item.name || item.title).includes('dailynote');

        if (isProtected) {
            renameBtn.classList.add('disabled');
            deleteBtn.classList.add('disabled');
            renameBtn.onclick = null;
            deleteBtn.onclick = null;
        } else {
            renameBtn.classList.remove('disabled');
            deleteBtn.classList.remove('disabled');
            renameBtn.onclick = () => startInlineRename(item.id);
            deleteBtn.onclick = () => handleDirectDelete(true);
        }
        
        copyNoteBtn.onclick = async () => {
            const result = await api.copyNoteContent(item.path);
            if (result.success) {
                const originalText = copyNoteBtn.textContent;
                copyNoteBtn.textContent = '已复制!';
                setTimeout(() => {
                    copyNoteBtn.textContent = originalText;
                }, 1500);
            }
        };
    }

    // Hide context menu reliably even when item click handlers stop propagation.
    document.addEventListener('click', (e) => {
        if (!customContextMenu.contains(e.target)) {
            customContextMenu.style.display = 'none';
        }
        if (!editorContextMenu.contains(e.target)) {
            hideEditorContextMenu();
        }
    }, true);

    document.addEventListener('contextmenu', (e) => {
        if (!e.target.closest('#noteList [data-id]') && !customContextMenu.contains(e.target)) {
            customContextMenu.style.display = 'none';
        }
        if (!e.target.closest('#noteContent') && !editorContextMenu.contains(e.target)) {
            hideEditorContextMenu();
        }
    }, true);

    function startInlineRename(itemId) {
        const item = findItemById(getCombinedTree(), itemId);
        if (!item) return;

        // Prevent renaming the protected folder
        const isProtected = isCloudItem(item.id) && (item.name || item.title).includes('dailynote');
        if (isProtected) {
            showErrorModal('操作禁止', 'VCP核心记忆库是受保护的，不能被重命名。');
            return;
        }

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
                await api.renameItem({ oldPath: item.path, newName: newName, ext: extension });
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

        // Prevent deleting the protected folder
        const isProtectedFolderSelected = itemsToDelete.some(item =>
            isCloudItem(item.id) && (item.name || item.title).includes('dailynote')
        );

        if (isProtectedFolderSelected) {
            await showErrorModal('操作禁止', 'VCP核心记忆库是受保护的，不能被删除。');
            return;
        }

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
                const result = await api.deleteItem(item.path);
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
            
            // 实时通知 Pretext 重新计算布局（应对分屏尺寸变化）
            if (window.pretextBridge && window.pretextBridge.isReady()) {
                window.pretextBridge.recalculateAll(window.innerWidth);
            }
        };

        const mouseUpHandler = () => {
            document.removeEventListener('mousemove', mouseMoveHandler);
            document.removeEventListener('mouseup', mouseUpHandler);
        };

        resizer.addEventListener('mousedown', mouseDownHandler);
    }

    // --- Editor / Preview Split Resizer Logic ---
    function initEditorPreviewResizer() {
        if (!noteBody || !editorContainer || !previewContainer || !editorPreviewResizer) return;

        const minPercent = 20;
        const maxPercent = 80;
        const storageKey = 'notesEditorPreviewSplitPercent';

        const clampPercent = (value) => Math.min(maxPercent, Math.max(minPercent, value));

        const notifyLayoutChanged = () => {
            if (window.pretextBridge && window.pretextBridge.isReady()) {
                window.pretextBridge.recalculateAll(window.innerWidth);
            }
        };

        const applySplit = (percent) => {
            const safePercent = clampPercent(Number(percent) || 50);
            const editorBasis = `calc(${safePercent}% - 14px)`;
            const previewBasis = `calc(${100 - safePercent}% - 14px)`;

            editorContainer.style.flex = `0 0 ${editorBasis}`;
            previewContainer.style.flex = `0 0 ${previewBasis}`;
            editorPreviewResizer.setAttribute('aria-valuenow', String(Math.round(safePercent)));
            editorPreviewResizer.setAttribute('aria-valuemin', String(minPercent));
            editorPreviewResizer.setAttribute('aria-valuemax', String(maxPercent));

            requestAnimationFrame(notifyLayoutChanged);
        };

        const savedPercent = parseFloat(localStorage.getItem(storageKey));
        applySplit(Number.isFinite(savedPercent) ? savedPercent : 50);

        const mouseMoveHandler = (e) => {
            const rect = noteBody.getBoundingClientRect();
            if (rect.width <= 0) return;

            const percent = clampPercent(((e.clientX - rect.left) / rect.width) * 100);
            applySplit(percent);
        };

        const mouseUpHandler = (e) => {
            noteBody.classList.remove('is-resizing');
            document.removeEventListener('mousemove', mouseMoveHandler);
            document.removeEventListener('mouseup', mouseUpHandler);

            const rect = noteBody.getBoundingClientRect();
            if (rect.width > 0) {
                const percent = clampPercent(((e.clientX - rect.left) / rect.width) * 100);
                localStorage.setItem(storageKey, String(Math.round(percent * 10) / 10));
                applySplit(percent);
            }
        };

        editorPreviewResizer.addEventListener('mousedown', (e) => {
            if (document.body.classList.contains('preview-collapsed')) return;

            e.preventDefault();
            noteBody.classList.add('is-resizing');
            document.addEventListener('mousemove', mouseMoveHandler);
            document.addEventListener('mouseup', mouseUpHandler);
        });
    }

    // --- Initialization ---
    async function initializeApp() {
        // Initialize theme first to prevent flash of unstyled content
        if (api) {
            // Use the new robust theme listener
            api.onThemeUpdated(applyTheme);
            try {
                const initialTheme = await api.getCurrentTheme();
                applyTheme(initialTheme);
            } catch (e) {
                console.error("Failed to get initial theme", e);
                applyTheme('dark'); // Fallback
            }
        } else {
            applyTheme('dark'); // Fallback for non-electron env
        }

        initResizer();
        initEditorPreviewResizer();
        searchInput.addEventListener('input', debounce(renderTree, 300));
        
        // 监听全局布局变化
        window.addEventListener('resize', () => {
            if (window.pretextBridge && window.pretextBridge.isReady()) {
                window.pretextBridge.recalculateAll(window.innerWidth);
            }
        });

        // --- Custom Title Bar Listeners ---
        const isPreviewCollapsed = localStorage.getItem('notesPreviewCollapsed') === 'true';
        updatePreviewToggleState(isPreviewCollapsed);

        previewToggleBtn.addEventListener('click', togglePreviewPanel);

        minimizeNotesBtn.addEventListener('click', () => {
            if (api) api.minimizeWindow();
        });

        maximizeNotesBtn.addEventListener('click', () => {
            if (api) api.maximizeWindow();
        });

        closeNotesBtn.addEventListener('click', () => {
            if (api?.closeWindow) {
                api.closeWindow();
            } else {
                window.close();
            }
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
            const settings = await api.loadSettings();
            currentUsername = settings?.userName || 'defaultUser';
            NOTES_DIR_CACHE = await api.getNotesRootDir();
        } catch (error) {
            console.error('加载用户设置或根目录失败:', error);
        }
        
        // No longer need to clear collapsed state, as the default is now collapsed.
        // --- New Initialization Logic ---
        // 1. Load local notes first for immediate display
        const localResult = await api.readNotesTree();
        if (localResult.error) {
            console.error('加载本地笔记失败:', localResult.error);
        } else {
            localNoteTree = localResult;
        }

        // 2. Try to load network notes from cache for faster startup
        // 2. Try to load network notes from cache for faster startup (now returns array)
        const cachedNetworkNotes = await api.getCachedNetworkNotes();
        // Ensure it's always an array, handling both old object format and null/undefined
        networkNoteTree = Array.isArray(cachedNetworkNotes) ? cachedNetworkNotes : (cachedNetworkNotes ? [cachedNetworkNotes] : []);

        // 3. Initial render with whatever we have so far
        renderTree();

        // 4. Asynchronously ask the main process to scan for fresh network notes
        api.scanNetworkNotes();

        // 5. Listen for the updated network notes to be returned
        api.onNetworkNotesScanned((freshNetworkTree) => {
            // Ensure it's always an array, handling both old object format and null/undefined
            networkNoteTree = Array.isArray(freshNetworkTree) ? freshNetworkTree : (freshNetworkTree ? [freshNetworkTree] : []);
            renderTree(); // Re-render with the fresh data
        });

        // 6. Listen for local note tree changes so external file drops appear immediately.
        api.onLocalNotesChanged?.(() => {
            loadNoteTree();
        });

        api.onSharedNoteData(async (data) => {
            // Generate a robust, unique title based on date and time, as suggested.
            const now = new Date();
            const generatedTitleSuffix = `.${String(now.getMilliseconds()).padStart(3, '0')}`;
            const generatedTitle = `分享笔记 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}.${String(now.getSeconds()).padStart(2, '0')}`;

            // Prepend the original title to the content for context.
            const finalContent = data.title
                ? `# ${data.title}\n\n${data.content || ''}`
                : data.content || '';

            const newNoteData = {
                title: `${generatedTitle}${generatedTitleSuffix}`, // Keep assistant note filenames unique under burst writes
                content: finalContent,
                username: currentUsername,
                timestamp: Date.now(),
                directoryPath: await api.getNotesRootDir() // Create in root by default
            };

            const result = await api.writeTxtNote(newNoteData);
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

        if (api?.windowReady) {
            api.windowReady('notes');
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
                    
                    const result = await api.savePastedImageToFile({ data: base64Data, extension }, activeNoteId);

                    if (result.success && result.attachment) {
                        const markdownImage = `![${result.attachment.name}](${result.attachment.internalPath})`;
                        const { selectionStart, selectionEnd } = noteContentInput;
                        const currentContent = noteContentInput.value;
                        const newContent = `${currentContent.substring(0, selectionStart)}${markdownImage}${currentContent.substring(selectionEnd)}`;
                        noteContentInput.value = newContent;
                        debouncedRender(newContent);
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
