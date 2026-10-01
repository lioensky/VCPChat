/* Notes Sub-Screen (Side Pane) Provider for VCPChat.
 * Delivers purpose-built quick-memo, note picking, real-time autosave,
 * and bi-directional atomic integration with the main chat.
 */
'use strict';

export function createNotesSideProvider({
    electronAPI = null,
    utilityAPI = null,
    sidePaneController = null,
    onOpenFullNotes = null,
    uiHelper = null
} = {}) {
    const api = utilityAPI || electronAPI || (typeof window !== 'undefined' ? (window.utilityAPI || window.electronAPI) : null);

    let activeHandle = null;

    return Object.freeze({
        kind: 'notes',

        async openNotesTab(options = {}) {
            if (!sidePaneController) return null;
            const tabDesc = {
                id: options.id || 'side-pane-notes',
                kind: 'notes',
                title: options.title || '随手笔记',
                icon: 'edit_note',
                closable: true,
                scopeMode: 'global',
                ...options
            };
            const handle = await sidePaneController.openTab(tabDesc);
            sidePaneController.setVisible(true);
            handle?.focus?.();
            return handle;
        },

        async mountTab(tabDescriptor, viewElement) {
            if (!viewElement) return null;

            const doc = viewElement.ownerDocument || document;
            viewElement.innerHTML = '';
            viewElement.classList.add('side-notes-view');

            const container = doc.createElement('div');
            container.className = 'side-notes-container';

            // 1. Toolbar
            const toolbar = doc.createElement('div');
            toolbar.className = 'side-notes-toolbar';

            const selectorWrapper = doc.createElement('div');
            selectorWrapper.className = 'side-notes-selector-wrapper';

            const noteIcon = doc.createElement('span');
            noteIcon.className = 'vcp-ui-icon side-notes-icon';
            noteIcon.textContent = 'description';

            const noteSelect = doc.createElement('select');
            noteSelect.className = 'side-notes-select';
            noteSelect.title = '选择已有笔记或新建';
            noteSelect.setAttribute('aria-label', '笔记列表');

            const newOpt = doc.createElement('option');
            newOpt.value = '__new__';
            newOpt.textContent = '+ 新建便签...';
            noteSelect.appendChild(newOpt);

            selectorWrapper.append(noteIcon, noteSelect);

            const actionsWrapper = doc.createElement('div');
            actionsWrapper.className = 'side-notes-actions';

            const statusBadge = doc.createElement('span');
            statusBadge.className = 'side-notes-status';
            statusBadge.textContent = '已就绪';

            const insertBtn = doc.createElement('button');
            insertBtn.type = 'button';
            insertBtn.className = 'side-notes-action-btn';
            insertBtn.setAttribute('data-action', 'insert-to-chat');
            insertBtn.title = '将便签内容插入主输入框';
            insertBtn.setAttribute('aria-label', '插入主聊天');
            insertBtn.innerHTML = '<span class="vcp-ui-icon">input</span>';

            const grabBtn = doc.createElement('button');
            grabBtn.type = 'button';
            grabBtn.className = 'side-notes-action-btn';
            grabBtn.setAttribute('data-action', 'grab-from-chat');
            grabBtn.title = '将主聊天最新回复存入便签';
            grabBtn.setAttribute('aria-label', '抓取回复');
            grabBtn.innerHTML = '<span class="vcp-ui-icon">save_alt</span>';

            const newBtn = doc.createElement('button');
            newBtn.type = 'button';
            newBtn.className = 'side-notes-action-btn';
            newBtn.setAttribute('data-action', 'new-note');
            newBtn.title = '新建空白便签';
            newBtn.setAttribute('aria-label', '新建便签');
            newBtn.innerHTML = '<span class="vcp-ui-icon">add</span>';

            const fullBtn = doc.createElement('button');
            fullBtn.type = 'button';
            fullBtn.className = 'side-notes-action-btn';
            fullBtn.setAttribute('data-action', 'open-full');
            fullBtn.title = '在主窗口或独立窗口中完整打开笔记';
            fullBtn.setAttribute('aria-label', '完整打开');
            fullBtn.innerHTML = '<span class="vcp-ui-icon">open_in_new</span>';

            actionsWrapper.append(statusBadge, insertBtn, grabBtn, newBtn, fullBtn);
            toolbar.append(selectorWrapper, actionsWrapper);

            // 2. Body
            const body = doc.createElement('div');
            body.className = 'side-notes-body';

            const titleInput = doc.createElement('input');
            titleInput.type = 'text';
            titleInput.className = 'side-notes-title-input';
            titleInput.placeholder = '便签标题...';
            titleInput.setAttribute('aria-label', '便签标题');

            const contentTextarea = doc.createElement('textarea');
            contentTextarea.className = 'side-notes-content-textarea';
            contentTextarea.placeholder = '随手记录灵感、要点或备忘... (自动实时保存)';
            contentTextarea.setAttribute('aria-label', '便签正文');

            body.append(titleInput, contentTextarea);
            container.append(toolbar, body);
            viewElement.appendChild(container);

            // State
            let currentFilePath = null;
            let saveTimer = null;
            let savePromise = null;
            let editGeneration = 0;
            let switchGeneration = 0;
            let listGeneration = 0;
            let isClosing = false;
            let pendingSave = false;
            let lastSavedSnapshot = '';
            let isDisposed = false;
            const notesIndex = new Map(); // path -> { title, content }

            function setStatus(text, isError = false) {
                statusBadge.textContent = text;
                statusBadge.classList.toggle('is-error', isError);
            }

            function getSnapshot() {
                return JSON.stringify({
                    title: titleInput.value.trim(),
                    content: contentTextarea.value.trim()
                });
            }

            function scheduleSave() {
                if (isDisposed || isClosing) return;
                setStatus('编辑中...');
                if (saveTimer) clearTimeout(saveTimer);
                saveTimer = setTimeout(() => {
                    saveTimer = null;
                    saveNote();
                }, 600);
            }

            function saveNote({ force = false } = {}) {
                if (isDisposed) return Promise.resolve(false);
                if (savePromise) {
                    pendingSave = true;
                    // 对照 ZCode 持久化队列：切换必须等待真实提交结束，不能把“正在保存”当作完成。
                    return savePromise;
                }
                savePromise = (async () => {
                    do {
                        pendingSave = false;
                        const generation = editGeneration;
                        const filePath = currentFilePath;
                        const title = titleInput.value.trim();
                        const content = contentTextarea.value.trim();
                        const snapshot = getSnapshot();
                        if (!title && !content) { setStatus('空便签'); return true; }
                        if (!force && snapshot === lastSavedSnapshot) return true;
                        force = false;
                        if (!api?.saveMiniNote) { setStatus('笔记保存接口不可用', true); return false; }
                        setStatus('保存中...');
                        try {
                            const result = await api.saveMiniNote({ title, content, filePath });
                            if (!result?.success) { setStatus(result?.error || '保存失败', true); return false; }
                            // setNote 可由外部打开文件：旧提交只拥有捕获的编辑身份，不能改写新笔记路径。
                            if (generation === editGeneration && !isDisposed) {
                                currentFilePath = result.path || filePath;
                                lastSavedSnapshot = snapshot;
                                setStatus('已保存');
                                await refreshNotesList();
                            }
                        } catch (err) {
                            console.error('[NotesSideProvider] Save note error:', err);
                            setStatus('保存出错', true);
                            return false;
                        }
                    } while (!isDisposed && (pendingSave || getSnapshot() !== lastSavedSnapshot));
                    return !isDisposed;
                })().finally(() => { savePromise = null; });
                return savePromise;
            }

            async function refreshNotesList() {
                if (isDisposed || !api?.readNotesTree) return;
                const request = ++listGeneration;
                try {
                    const tree = await api.readNotesTree();
                    if (isDisposed || request !== listGeneration) return;
                    if (!Array.isArray(tree)) {
                        // main process reports failures as { error }
                        if (tree?.error) setStatus('读取笔记列表失败', true);
                        return;
                    }
                    const noteFiles = [];
                    notesIndex.clear();

                    // Real tree nodes: { type: 'note' | 'folder', title, content, path, children }
                    function extractNotes(nodes, trail) {
                        if (!Array.isArray(nodes)) return;
                        for (const node of nodes) {
                            if (node?.type === 'note' && node.path) {
                                const title = node.title || node.name || '未命名';
                                noteFiles.push({
                                    name: trail.length ? `${trail.join(' / ')} / ${title}` : title,
                                    path: node.path
                                });
                                notesIndex.set(node.path, { title, content: typeof node.content === 'string' ? node.content : '' });
                            } else if (node?.type === 'folder' && Array.isArray(node.children)) {
                                extractNotes(node.children, [...trail, node.name || node.title || '文件夹']);
                            }
                        }
                    }
                    extractNotes(tree, []);

                    noteSelect.innerHTML = '';
                    const createOpt = doc.createElement('option');
                    createOpt.value = '__new__';
                    createOpt.textContent = '+ 新建便签...';
                    noteSelect.appendChild(createOpt);

                    noteFiles.forEach(file => {
                        const opt = doc.createElement('option');
                        opt.value = file.path;
                        opt.textContent = file.name;
                        if (file.path === currentFilePath) {
                            opt.selected = true;
                        }
                        noteSelect.appendChild(opt);
                    });
                } catch (err) {
                    console.warn('[NotesSideProvider] Failed to read notes tree:', err);
                }
            }

            // Event Listeners
            titleInput.addEventListener('input', scheduleSave);
            contentTextarea.addEventListener('input', scheduleSave);

            async function switchNote(selectedPath) {
                const request = ++switchGeneration;
                titleInput.disabled = contentTextarea.disabled = noteSelect.disabled = newBtn.disabled = true;
                if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
                try {
                    if (!await saveNote() || isDisposed || request !== switchGeneration) return;
                    let note = null;
                    if (selectedPath !== '__new__') {
                        await refreshNotesList();
                        if (isDisposed || request !== switchGeneration) return;
                        note = notesIndex.get(selectedPath);
                        if (!note) { setStatus('笔记已不存在', true); return; }
                    }
                    ++editGeneration;
                    currentFilePath = note ? selectedPath : null;
                    titleInput.value = note?.title || '';
                    contentTextarea.value = note?.content || '';
                    lastSavedSnapshot = getSnapshot();
                    noteSelect.value = note ? selectedPath : '__new__';
                    setStatus(note ? '已载入' : '新建就绪');
                } finally {
                    if (!isDisposed && request === switchGeneration) {
                        titleInput.disabled = contentTextarea.disabled = noteSelect.disabled = newBtn.disabled = false;
                        noteSelect.value = currentFilePath || '__new__';
                        titleInput.focus();
                    }
                }
            }
            noteSelect.addEventListener('change', () => { void switchNote(noteSelect.value); });

            // Action: Insert to Main Chat
            insertBtn.addEventListener('click', () => {
                const noteText = contentTextarea.value.trim();
                const noteTitle = titleInput.value.trim();
                if (!noteText && !noteTitle) {
                    uiHelper?.showToastNotification?.('便签暂无内容可插入', 'info');
                    return;
                }
                const formatted = noteTitle ? `【笔记：${noteTitle}】\n${noteText}` : noteText;
                const messageInput = doc.getElementById('messageInput');
                if (messageInput) {
                    const currentVal = messageInput.value;
                    messageInput.value = currentVal ? `${currentVal}\n\n${formatted}` : formatted;
                    messageInput.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
                    messageInput.focus();
                    uiHelper?.showToastNotification?.('已将便签内容插入主聊天输入框', 'success');
                }
            });

            // Action: Grab from Main Chat (Latest Assistant Reply)
            grabBtn.addEventListener('click', () => {
                const chatContainer = doc.getElementById('chatMessages');
                if (!chatContainer) return;
                const assistantMessages = Array.from(chatContainer.querySelectorAll('.message-item.assistant'))
                    .filter(message => !message.matches('.is-streaming, .streaming, .thinking, [data-streaming="true"], [data-is-streaming="true"]') &&
                        !message.querySelector('.thinking-indicator, .loading-indicator'));
                // 抓取只读真实正文；头像、消息操作、思考区和尚未完成的回复不进入便签。
                const lastMsg = assistantMessages[assistantMessages.length - 1];
                if (!lastMsg) {
                    uiHelper?.showToastNotification?.('主聊天中暂无助手回复可抓取', 'info');
                    return;
                }
                const targetEl = lastMsg.querySelector('.md-content');
                if (!targetEl) return;
                const textContent = (targetEl.innerText || targetEl.textContent || '').trim();
                if (!textContent) return;

                const separator = contentTextarea.value.trim().length > 0 ? '\n\n---\n**引用自 AI 回复：**\n' : '**引用自 AI 回复：**\n';
                contentTextarea.value += separator + textContent;
                if (!titleInput.value.trim()) {
                    titleInput.value = `摘录 ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
                }
                scheduleSave();
                uiHelper?.showToastNotification?.('已成功抓取 AI 回复并存入便签', 'success');
            });

            // Action: New Note
            newBtn.addEventListener('click', () => { void switchNote('__new__'); });

            // Action: Open Full
            fullBtn.addEventListener('click', async () => {
                // 完整窗口从磁盘读笔记，先把还没到时间的改动写下去
                if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
                await saveNote();
                if (isDisposed) return;
                if (typeof onOpenFullNotes === 'function') {
                    onOpenFullNotes();
                } else if (api?.openNotesWindow) {
                    api.openNotesWindow();
                } else {
                    const notesTabBtn = doc.querySelector('[data-action="open-notes-window"]');
                    notesTabBtn?.click?.();
                }
            });

            // Shortcut Ctrl+S / Cmd+S
            const onKeyDown = async (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault();
                    if (saveTimer) clearTimeout(saveTimer);
                    await saveNote({ force: true });
                }
            };
            viewElement.addEventListener('keydown', onKeyDown);

            // Initial load
            await refreshNotesList();

            const handle = Object.freeze({
                focus() {
                    refreshNotesList();
                    if (titleInput.value.trim()) {
                        contentTextarea.focus();
                    } else {
                        titleInput.focus();
                    }
                },
                getDraft() {
                    return {
                        title: titleInput.value,
                        content: contentTextarea.value,
                        filePath: currentFilePath
                    };
                },
                setNote({ title = '', content = '', filePath = null } = {}) {
                    ++editGeneration;
                    ++switchGeneration;
                    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
                    titleInput.disabled = contentTextarea.disabled = noteSelect.disabled = newBtn.disabled = false;
                    titleInput.value = title;
                    contentTextarea.value = content;
                    currentFilePath = filePath;
                    lastSavedSnapshot = getSnapshot();
                    setStatus('已更新');
                },
                refresh() {
                    return refreshNotesList();
                },
                async dispose() {
                    if (isDisposed) return;
                    isClosing = true;
                    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
                    if (!await saveNote()) {
                        isClosing = false;
                        throw new Error('笔记尚未保存，无法关闭');
                    }
                    isDisposed = true;
                    ++switchGeneration;
                    ++listGeneration;
                    viewElement.removeEventListener('keydown', onKeyDown);
                    viewElement.innerHTML = '';
                    if (activeHandle === handle) activeHandle = null;
                }
            });

            activeHandle = handle;
            return handle;
        }
    });
}
