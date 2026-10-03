/* sideChatSurfaceOwner.js
 * Surface owner for Workspace Side Chat, supporting independent conversation,
 * concurrent streaming, cancellation, selection references, and lifecycle disposal.
 */
'use strict';

import { createChatSurface } from '../chat/chatSurface.js';
import { createChatOperations } from '../chat/chatOperation.js';
import { validateReferenceList } from '../ui-system/side-pane/selection-reference.js';

/**
 * Mounts a full interactive side-chat surface into container.
 * @param {HTMLElement} container
 * @param {Object} options
 * @param {Object} options.descriptor - SideChatDescriptor
 * @param {Object} options.chatCapabilities - Shared chat capabilities
 * @param {Object} [options.scope] - LifecycleScope
 * @param {Function} [options.onStatusChange]
 * @returns {Promise<Object>} TabHandle
 */
export async function mountSideChatSurface(container, {
    descriptor,
    chatCapabilities,
    scope = null,
    onStatusChange = null
} = {}) {
    if (!container || !container.ownerDocument) {
        throw new TypeError('mountSideChatSurface requires a valid container element');
    }
    if (!descriptor) {
        throw new TypeError('mountSideChatSurface requires a descriptor');
    }

    const doc = container.ownerDocument;
    const repository = chatCapabilities?.repository;
    const createRenderer = chatCapabilities?.createRenderer;
    const chatManager = chatCapabilities?.manager;
    const childScope = scope?.child?.(`side-chat-${descriptor.id}`) || null;

    // Resolve agent config from descriptor or capability or fallback
    const agentConfig = descriptor.child?.config
        || descriptor.parent?.config
        || (typeof chatCapabilities?.resolveAgentConfig === 'function'
            ? await chatCapabilities.resolveAgentConfig(descriptor.child?.itemId)
            : null)
        || { streamOutput: true };

    const clonedConfig = agentConfig ? structuredClone(agentConfig) : {};
    let currentModel = descriptor.model || clonedConfig?.model || '';
    clonedConfig.model = currentModel;

    const selectedItem = {
        id: descriptor.child.itemId,
        type: 'agent',
        name: descriptor.parent.name,
        avatarUrl: descriptor.parent.avatar,
        config: clonedConfig,
        model: currentModel,
        systemPrompt: clonedConfig?.systemPrompt,
        streamOutput: clonedConfig?.streamOutput
    };

    const modelName = currentModel || '选择模型';
    const isSnapshot = descriptor.contextMode === 'parent-snapshot';
    const disposeCleanups = [];

    // Shell template: the composer mirrors the main chat input card (textarea, then one actions row
    // with a ghost model select on the right and the round send button), nothing else.
    container.innerHTML = `
      <div class="side-chat-surface" aria-label="辅助对话">
        <span class="side-chat-topic-title sr-only" title="${escapeHtml(descriptor.title)}">${escapeHtml(descriptor.title)}</span>
        <div class="side-chat-messages-container" tabindex="-1" aria-label="辅助对话消息">
          <div class="side-chat-empty-state" aria-hidden="true">
            <div class="side-chat-empty-title">辅助对话</div>
            <div class="side-chat-empty-desc">
              ${isSnapshot
                ? '发送第一条消息时会带上来源话题的历史快照。在下方输入提问，或在主聊中划选文字追问。'
                : '当前为仅引用模式。选区引用会作为上下文随问题一同发送。'}
            </div>
          </div>
        </div>
        <form class="side-chat-composer">
          <div class="chat-input-card side-chat-input-card">
            <div class="side-chat-reference-list" hidden aria-label="选区引用"></div>
            <textarea class="chat-message-input side-chat-textarea" placeholder="输入消息... (Enter 发送, Shift+Enter 换行)" rows="1" aria-label="辅助对话输入框" disabled></textarea>
            <div class="chat-input-actions side-chat-input-actions">
              <div class="side-chat-status-bar" role="status" aria-live="polite">
                <span class="side-chat-status-text"></span>
                <button type="button" class="side-chat-persistence-badge side-chat-status-unsaved" hidden title="历史保存失败。左键重试保存，右键放弃未保存状态">未保存 ↻</button>
              </div>
              <div class="side-chat-model-picker-wrapper">
                <button type="button" class="side-chat-model-picker-btn" title="切换模型 (当前: ${escapeHtml(modelName)})" aria-haspopup="listbox" aria-expanded="false">
                  <span class="side-chat-model-name">${escapeHtml(modelName)}</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
                </button>
                <div class="side-chat-model-popover" hidden aria-label="选择模型">
                  <input type="text" class="side-chat-model-search" placeholder="搜索模型..." aria-label="搜索模型" />
                  <div class="side-chat-model-list" role="listbox"></div>
                </div>
              </div>
              <button type="submit" class="chat-send-button side-chat-send-btn" title="发送 (Enter)" aria-label="发送" disabled>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="m5 12 7-7 7 7"></path>
                  <path d="M12 19V5"></path>
                </svg>
              </button>
              <button type="button" class="chat-send-button side-chat-stop-btn interrupt-mode" hidden title="停止生成" aria-label="停止生成">
                <span class="vcp-ui-icon">stop</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    `;

    const root = container.querySelector('.side-chat-messages-container');
    const form = container.querySelector('.side-chat-composer');
    const textarea = form.querySelector('.side-chat-textarea');
    const sendBtn = form.querySelector('.side-chat-send-btn');
    const stopBtn = form.querySelector('.side-chat-stop-btn');
    const statusText = container.querySelector('.side-chat-status-text');
    const persistenceBadge = container.querySelector('.side-chat-persistence-badge');
    const referenceList = container.querySelector('.side-chat-reference-list');
    const modelPickerBtn = container.querySelector('.side-chat-model-picker-btn');
    const modelPopover = container.querySelector('.side-chat-model-popover');
    const modelNameSpan = container.querySelector('.side-chat-model-name');

    let currentDescriptor = {
        ...descriptor,
        model: currentModel
    };

    function updateModel(newModel) {
        if (!newModel || isDisposed) return;
        currentModel = newModel;
        currentDescriptor = { ...currentDescriptor, model: newModel };
        selectedItem.model = newModel;
        if (selectedItem.config) selectedItem.config.model = newModel;
        if (modelNameSpan) modelNameSpan.textContent = newModel;
        if (modelPickerBtn) {
            modelPickerBtn.title = `切换模型 (当前: ${newModel})`;
            modelPickerBtn.setAttribute('aria-expanded', 'false');
        }
        if (modelPopover) modelPopover.hidden = true;
        persistMetadata().catch(e => console.warn('[SideChat] Failed to persist model update:', e));
    }

    // 父快照：来源话题的历史，首条消息发送前会重新截取
    let snapshotMessages = Array.isArray(descriptor.parentSnapshot) ? [...descriptor.parentSnapshot] : [];

    // 侧聊尚未产生任何消息时，在发送前重新截取父话题，避免复用一个早已过期的快照
    function needsSnapshotRefresh() {
        return currentDescriptor.contextMode === 'parent-snapshot'
            && typeof chatCapabilities?.refreshParentSnapshot === 'function'
            && (enhancedConversation?.historyRef?.get?.() || []).length === 0;
    }

    async function refreshSnapshot() {
        try {
            const res = await chatCapabilities.refreshParentSnapshot(currentDescriptor);
            if (!res?.ok || isDisposed) return;
            snapshotMessages = Array.isArray(res.messages) ? [...res.messages] : [];
            currentDescriptor = { ...currentDescriptor, snapshotId: res.snapshotId || currentDescriptor.snapshotId, parentSnapshot: snapshotMessages };
            persistMetadata().catch(e => console.warn('[SideChat] Failed to persist refreshed snapshot:', e));
        } catch (error) {
            console.warn('[SideChat] Failed to refresh parent snapshot; keeping the existing one:', error);
        }
    }

    function persistMetadata() {
        const metaToPersist = { ...currentDescriptor, model: currentModel || null };
        const save = chatCapabilities?.saveSideChatMetadata
            || chatCapabilities?.repository?.saveSideChatMetadata
            || globalThis.chatAPI?.saveSideChatMetadata;
        return typeof save === 'function' ? Promise.resolve(save(metaToPersist)) : Promise.resolve(null);
    }

    // 草稿和引用随输入写进元数据，重载或重启后恢复；连续输入合并成一次写入
    let inputSaveTimer = null;
    function persistComposerInput() {
        currentDescriptor = {
            ...currentDescriptor,
            draft: textarea.value,
            references: references.map(({ id, text, sourceMessageId }) => ({ id, text, sourceMessageId: sourceMessageId ?? null }))
        };
        persistMetadata().catch(e => console.warn('[SideChat] Failed to persist draft:', e));
    }
    function scheduleInputSave() {
        if (isDisposed) return;
        clearTimeout(inputSaveTimer);
        inputSaveTimer = setTimeout(() => {
            inputSaveTimer = null;
            if (!isDisposed) persistComposerInput();
        }, 400);
    }
    function flushInputSave() {
        if (inputSaveTimer === null) return;
        clearTimeout(inputSaveTimer);
        inputSaveTimer = null;
        persistComposerInput();
    }
    textarea.addEventListener('input', scheduleInputSave);
    const win = doc.defaultView;
    win?.addEventListener?.('pagehide', flushInputSave);
    disposeCleanups.push(() => {
        textarea.removeEventListener('input', scheduleInputSave);
        win?.removeEventListener?.('pagehide', flushInputSave);
    });

    // 模型列表与主聊输入框的模型选择器同源（VCP 服务器缓存 + 收藏），不再内置写死的假列表
    if (modelPickerBtn && modelPopover) {
        const modelSearch = modelPopover.querySelector('.side-chat-model-search');
        const modelList = modelPopover.querySelector('.side-chat-model-list');
        let modelCatalog = null;

        const renderModelList = () => {
            const q = (modelSearch?.value || '').trim().toLowerCase();
            modelList.replaceChildren();
            const { ids = [], favorites = new Set() } = modelCatalog || {};
            const match = (id) => !q || id.toLowerCase().includes(q);
            const favs = ids.filter(id => favorites.has(id) && match(id));
            const rest = ids.filter(id => !favorites.has(id) && match(id));
            const addGroup = (title, arr) => {
                if (!arr.length) return;
                if (title) {
                    const g = doc.createElement('div');
                    g.className = 'side-chat-model-group';
                    g.textContent = title;
                    modelList.appendChild(g);
                }
                arr.forEach((id) => {
                    const item = doc.createElement('div');
                    item.className = 'side-chat-model-item' + (id === currentModel ? ' active' : '');
                    item.setAttribute('role', 'option');
                    item.setAttribute('aria-selected', String(id === currentModel));
                    item.setAttribute('data-model', id);
                    item.tabIndex = -1;
                    item.textContent = id;
                    item.title = id;
                    modelList.appendChild(item);
                });
            };
            addGroup(favs.length && rest.length ? '收藏' : '', favs);
            addGroup(favs.length && rest.length ? '全部' : '', rest);
            if (!favs.length && !rest.length) {
                const empty = doc.createElement('div');
                empty.className = 'side-chat-model-empty';
                empty.textContent = modelCatalog === null ? '加载中…'
                    : (ids.length ? '没有匹配的模型' : '没有可用的模型，请检查 VCP 服务器地址');
                modelList.appendChild(empty);
            }
        };

        const loadModelCatalog = async () => {
            renderModelList();
            try {
                modelCatalog = await (chatCapabilities?.listModels?.() ?? { ids: [], favorites: new Set() });
            } catch (error) {
                console.warn('[SideChat] Failed to load model list:', error);
                modelCatalog = { ids: [], favorites: new Set() };
            }
            if (!isDisposed) renderModelList();
        };

        const closePopover = () => {
            modelPopover.hidden = true;
            modelPickerBtn.setAttribute('aria-expanded', 'false');
        };

        const openPopover = () => {
            modelPopover.hidden = false;
            modelPickerBtn.setAttribute('aria-expanded', 'true');
            if (modelSearch) modelSearch.value = '';
            loadModelCatalog();
            modelSearch?.focus?.();
        };

        modelPickerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (modelPopover.hidden) openPopover(); else closePopover();
        });

        modelSearch?.addEventListener('input', renderModelList);

        modelList.addEventListener('click', (e) => {
            const item = e.target.closest('.side-chat-model-item');
            const newModel = item?.getAttribute('data-model');
            if (!newModel) return;
            updateModel(newModel);
            updateComposerState();
            modelPickerBtn.focus();
        });

        modelPopover.addEventListener('keydown', (e) => {
            const items = Array.from(modelList.querySelectorAll('.side-chat-model-item'));
            const idx = items.indexOf(doc.activeElement);
            if (e.key === 'Escape') {
                e.preventDefault();
                closePopover();
                modelPickerBtn.focus();
            } else if (e.key === 'ArrowDown' && items.length) {
                e.preventDefault();
                items[(idx + 1) % items.length].focus();
            } else if (e.key === 'ArrowUp' && items.length) {
                e.preventDefault();
                items[(idx - 1 + items.length) % items.length].focus();
            } else if (e.key === 'Enter' && doc.activeElement?.classList?.contains('side-chat-model-item')) {
                e.preventDefault();
                doc.activeElement.click();
            }
        });

        const onDocClick = (e) => {
            if (!modelPickerBtn.contains?.(e.target) && !modelPopover.contains?.(e.target)) closePopover();
        };
        doc.addEventListener('click', onDocClick);
        disposeCleanups.push(() => doc.removeEventListener('click', onDocClick));
    }

    let isDisposed = false;
    let isHistoryLoaded = false;
    let isComposing = false;
    let activeOperation = null;
    let operationReady = Promise.resolve(null);
    let publishOperation = null;
    let submitInteractiveContent = null;
    let hasUnsavedChanges = false;
    let lastPersistenceError = null;
    let pendingSaveHistory = null;
    const references = []; // { id, text, sourceMessageId }

    function extractTextFromContentDiv(contentDiv) {
        if (!contentDiv) return '';
        const clone = contentDiv.cloneNode(true);
        clone.querySelectorAll?.(
            '.vcp-tool-use-bubble, .vcp-tool-result-bubble, .vcp-tool-call-summary-bubble, .vcp-flowlock-bubble, .vcp-role-divider, .vcp-thought-chain-bubble, .message-attachments, .message-attachment-remove-btn, .side-chat-message-actions, style, script'
        )?.forEach?.(el => el.remove());
        return (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    }

    function attachMessageActions(messageItem) {
        if (!messageItem || messageItem.hasAttribute?.('data-has-side-action')) return;
        if (messageItem.classList?.contains('user')) return;
        messageItem.setAttribute('data-has-side-action', 'true');

        const actionsDiv = doc.createElement('div');
        actionsDiv.className = 'side-chat-message-actions';

        const sendToMainBtn = doc.createElement('button');
        sendToMainBtn.type = 'button';
        sendToMainBtn.className = 'side-chat-send-to-main-btn';
        sendToMainBtn.title = '将此回答填入主聊天输入框';
        sendToMainBtn.innerHTML = '<span class="vcp-ui-icon">reply</span> 填入主聊';

        sendToMainBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const contentDiv = messageItem.querySelector('.md-content');
            const cleanText = extractTextFromContentDiv(contentDiv);
            if (!cleanText) {
                chatCapabilities?.uiHelper?.showToastNotification?.('无可填入的文本内容', 'warning');
                return;
            }

            const mainInput = doc.querySelector('#messageInput');
            if (mainInput) {
                const curItem = typeof chatCapabilities?.getCurrentItem === 'function' ? chatCapabilities.getCurrentItem() : null;
                const parentItemId = descriptor.parent?.itemId;
                if (curItem && parentItemId && curItem.id !== parentItemId) {
                    chatCapabilities?.uiHelper?.showToastNotification?.(`主聊天当前不在来源助手（${descriptor.parent?.name || parentItemId}），已阻止填入`, 'warning');
                    return;
                }
                const inputTopic = mainInput.getAttribute('data-current-topic')
                    || (typeof chatCapabilities?.getCurrentTopic === 'function' ? chatCapabilities.getCurrentTopic() : null);
                const parentTopic = descriptor.parent?.topicId;
                if (inputTopic && parentTopic && inputTopic !== parentTopic) {
                    chatCapabilities?.uiHelper?.showToastNotification?.(`主聊天当前不在来源话题（${parentTopic}），已阻止填入`, 'warning');
                    return;
                }
                const currentVal = mainInput.value ? mainInput.value.trim() : '';
                mainInput.value = currentVal ? `${currentVal}\n\n${cleanText}` : cleanText;
                chatCapabilities?.uiHelper?.autoResizeTextarea?.(mainInput);
                const EventClass = doc.defaultView?.Event || globalThis.Event;
                mainInput.dispatchEvent(new EventClass('input', { bubbles: true }));
                mainInput.focus();
                chatCapabilities?.uiHelper?.showToastNotification?.('已填入主聊天输入框', 'success');
            } else {
                chatCapabilities?.uiHelper?.showToastNotification?.('未找到主聊天输入框', 'error');
            }
        });

        actionsDiv.appendChild(sendToMainBtn);
        // 放在气泡下方，而不是作为 .message-item 的第三个 flex 子项挤到行尾
        const bubbleColumn = messageItem.querySelector('.details-and-bubble-wrapper') || messageItem;
        bubbleColumn.appendChild(actionsDiv);
    }

    const MutationObserverClass = doc.defaultView?.MutationObserver || globalThis.MutationObserver;
    let messageObserver = null;
    function syncMessageActions() {
        if (isDisposed || !root) return;
        const items = root.querySelectorAll('.message-item:not([data-has-side-action])');
        items.forEach(item => {
            if (!item.classList?.contains('streaming')) {
                attachMessageActions(item);
            }
        });
        updateEmptyState();
    }

    // 贴底：分批加载历史、标签从隐藏切回可见、内容增长时都停在最新消息；
    // 用户主动往上翻之后就不再强制滚动，回到底部附近再恢复
    let stickToBottom = true;
    let lastScrollTop = 0;
    function pinToBottomIfSticky() {
        if (!isDisposed && stickToBottom && root && root.clientHeight > 0) {
            root.scrollTop = root.scrollHeight;
        }
    }
    if (root) {
        const onRootScroll = () => {
            if (root.clientHeight === 0) return;
            // 只有往上滚才算离开底部；内容增长、布局变化引起的滚动事件不改变贴底状态
            if (root.scrollHeight - root.scrollTop - root.clientHeight < 48) stickToBottom = true;
            else if (root.scrollTop < lastScrollTop - 1) stickToBottom = false;
            lastScrollTop = root.scrollTop;
        };
        root.addEventListener('scroll', onRootScroll, { passive: true });
        disposeCleanups.push(() => root.removeEventListener('scroll', onRootScroll));
        const ResizeObserverClass = doc.defaultView?.ResizeObserver || globalThis.ResizeObserver;
        if (ResizeObserverClass) {
            const rootResizeObserver = new ResizeObserverClass(pinToBottomIfSticky);
            rootResizeObserver.observe(root);
            disposeCleanups.push(() => rootResizeObserver.disconnect());
        }
    }

    if (MutationObserverClass && root) {
        messageObserver = new MutationObserverClass(() => {
            syncMessageActions();
            pinToBottomIfSticky();
        });
        messageObserver.observe(root, { childList: true, subtree: true });
    }

    function updateStatus(text, type = 'normal') {
        if (isDisposed) return;
        // Like the main composer, progress is shown by the send/stop button; only failures get text.
        const shown = type === 'error' ? text : '';
        statusText.textContent = shown;
        statusText.title = shown;
        statusText.className = 'side-chat-status-text' + (type === 'error' ? ' side-chat-status-error' : '');
        onStatusChange?.({ text, type });
    }

    function renderReferences() {
        referenceList.replaceChildren();
        referenceList.hidden = references.length === 0;
        if (references.length === 0) return;

        references.forEach((ref, idx) => {
            const card = doc.createElement('div');
            card.className = 'side-chat-reference-box';

            const preview = doc.createElement('span');
            preview.className = 'side-chat-ref-text';
            const shortText = ref.text.length > 80 ? ref.text.slice(0, 80) + '...' : ref.text;
            preview.textContent = `${references.length > 1 ? `引用 ${idx + 1}` : '引用'}：「${shortText}」`;

            const removeBtn = doc.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'side-chat-reference-remove';
            removeBtn.title = '移除引用';
            removeBtn.setAttribute('aria-label', '移除引用');
            removeBtn.innerHTML = '<span class="vcp-ui-icon">close</span>';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                handle.removeReference(ref.id);
            });

            card.append(preview, removeBtn);
            referenceList.appendChild(card);
        });
    }

    if (!repository || typeof createRenderer !== 'function' || !chatManager) {
        updateStatus('聊天能力尚未就绪', 'error');
        return {
            descriptor,
            setVisible() {},
            focus() {},
            async requestClose() { return { closed: true }; },
            async dispose() {
                disposeCleanups.forEach(fn => { try { fn(); } catch {} });
                disposeCleanups.length = 0;
                messageObserver?.disconnect?.();
                childScope?.dispose?.('side-chat-unavailable');
                container.replaceChildren();
            },
            addReference() {},
            removeReference() {},
        };
    }

    function updateEmptyState() {
        if (!root) return;
        const emptyState = root.querySelector('.side-chat-empty-state');
        if (!emptyState) return;
        const messageItems = root.querySelectorAll('.message-item');
        emptyState.hidden = messageItems.length > 0;
    }

    function updateComposerState() {
        if (isDisposed) return;
        const hasText = Boolean(textarea.value.trim());
        const hasRefs = references.length > 0;
        sendBtn.disabled = !isHistoryLoaded || !currentModel;
        sendBtn.title = currentModel ? '发送 (Enter)' : '请先选择模型';
        if (!hasText && hasRefs && currentDescriptor.contextMode !== 'parent-snapshot') {
            textarea.placeholder = '输入针对引用的问题... (直接回车可发送引用)';
        } else {
            textarea.placeholder = '输入消息... (Enter 发送, Shift+Enter 换行)';
        }
    }

    // Mount owned isolated internal renderer
    const rendererOwner = createRenderer({
        root,
        mode: 'interactive',
        conversation: {
            selectedItem,
            topicId: descriptor.child.topicId,
        },
        handleSendMessage: (text) => submitInteractiveContent?.(text),
        shouldScrollToBottom: () => stickToBottom,
    });

    const renderer = rendererOwner.renderer;

    // Supply frozen parent snapshot context if present (P1 context inheritance)
    const enhancedConversation = Object.freeze({
        ...rendererOwner.conversation,
        getContextHistory: () => (currentDescriptor.contextMode === 'parent-snapshot' ? [...snapshotMessages] : [])
    });

    const operations = createChatOperations({
        send: async (request) => {
            operationReady = new Promise((resolve) => { publishOperation = resolve; });
            try {
                return await chatManager.sendMessage({
                    ...request,
                    conversation: enhancedConversation,
                    awaitTerminal: true,
                    onOperation(operation) {
                        activeOperation = operation;
                        publishOperation?.(operation);
                        publishOperation = null;
                    },
                });
            } finally {
                publishOperation?.(null);
                publishOperation = null;
                activeOperation = null;
            }
        },
        cancel: async () => {
            const operation = activeOperation;
            if (operation && typeof operation.cancel === 'function') {
                return await operation.cancel('side-chat-user-cancel');
            }
            return false;
        }
    });

    const surface = createChatSurface({
        root,
        renderer,
        repository,
        focusTarget: textarea,
        mode: 'interactive',
        operations,
        disposeRenderer: () => rendererOwner.dispose(),
        conversation: enhancedConversation
    });

    // Composer event handling
    textarea.addEventListener('compositionstart', () => { isComposing = true; });
    textarea.addEventListener('compositionend', () => { isComposing = false; });

    textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
        updateComposerState();
    });

    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !isComposing && e.keyCode !== 229) {
            e.preventDefault();
            form.requestSubmit();
        }
    });

    const onSubmit = async (event) => {
        event?.preventDefault?.();
        if (isDisposed || !isHistoryLoaded) return;
        if (!currentModel) {
            updateStatus('请先选择模型', 'error');
            return;
        }

        const rawText = textarea.value.trim();
        if (!rawText && references.length === 0) return;

        const submittedText = rawText;
        const submittedReferenceIds = new Set(references.map(r => r.id));
        const submittedReferences = [...references];

        // Compose payload with references if present
        let payload = rawText;
        if (references.length > 0) {
            // 用户气泡按纯文本显示，用「」包住引用原文，不用 Markdown 引用块
            const refContent = references
                .map((r, i) => `${references.length > 1 ? `引用 ${i + 1}` : '引用'}：「${r.text}」`)
                .join('\n\n');
            payload = rawText ? `${refContent}\n\n${rawText}` : refContent;
        }

        // Clear composer draft and remove submitted references from composer view
        textarea.value = '';
        textarea.style.height = 'auto';
        for (let i = references.length - 1; i >= 0; i--) {
            if (submittedReferenceIds.has(references[i].id)) {
                references.splice(i, 1);
            }
        }
        renderReferences();
        scheduleInputSave();

        form.setAttribute('aria-busy', 'true');
        textarea.disabled = true;
        sendBtn.hidden = true;
        stopBtn.hidden = false;
        updateStatus('生成中...');
        // 和主聊一致：自己发出的消息总是滚到底部跟随
        stickToBottom = true;
        pinToBottomIfSticky();

        // 用户消息被撤回（未发出/发送失败）时才把草稿和引用放回输入框；
        // 已经进入历史的一轮（例如中途停止）不再回填，避免重复发送
        const restoreDraftIfRetracted = () => {
            const history = enhancedConversation?.historyRef?.get?.() || [];
            if (history.some(msg => msg?.role === 'user' && msg.content === payload)) return;
            if (!textarea.value && submittedText) textarea.value = submittedText;
            for (const ref of submittedReferences) {
                if (!references.some(r => r.id === ref.id)) references.unshift(ref);
            }
            renderReferences();
            scheduleInputSave();
        };

        try {
            if (needsSnapshotRefresh()) await refreshSnapshot();
            const result = await surface.sendMessage({
                content: payload,
                attachments: [],
                input: textarea,
                domRenderer: surface.renderer,
                propagateError: true
            });

            const terminalType = result?.terminal?.event?.type;
            if (terminalType === 'cancelled' || terminalType === 'discarded') {
                restoreDraftIfRetracted();
                updateStatus('已取消');
            } else if (terminalType === 'failed') {
                const transportErr = result.terminal.event.outcome?.transport?.error;
                const persistenceErr = result.terminal.event.outcome?.persistence?.error;
                const err = transportErr || persistenceErr || '连接中断';
                if (!persistenceErr) {
                    restoreDraftIfRetracted();
                    updateStatus(`发送失败：${err?.message || err}`, 'error');
                } else {
                    hasUnsavedChanges = true;
                    lastPersistenceError = persistenceErr;
                    const inMem = enhancedConversation?.historyRef?.get?.();
                    if (Array.isArray(inMem) && inMem.length > 0) {
                        pendingSaveHistory = [...inMem];
                    }
                    persistenceBadge.hidden = false;
                    persistenceBadge.textContent = '保存失败 (点击重试)';
                    updateStatus('已生成但保存失败', 'error');
                }
            } else {
                hasUnsavedChanges = false;
                pendingSaveHistory = null;
                lastPersistenceError = null;
                persistenceBadge.hidden = true;
                updateStatus('就绪');
            }
        } catch (error) {
            restoreDraftIfRetracted();
            updateStatus(`发送失败：${error.message}`, 'error');
        } finally {
            if (!isDisposed) {
                form.removeAttribute('aria-busy');
                textarea.disabled = false;
                sendBtn.hidden = false;
                stopBtn.hidden = true;
                updateComposerState();
                updateEmptyState();
                // 回答结束时"填入主聊"按钮才显示出来（只是类名变化，观察器看不到），贴底阅读时补滚这一行
                pinToBottomIfSticky();
            }
        }
    };

    submitInteractiveContent = (text) => {
        if (isDisposed) return;
        textarea.value = String(text || '');
        form.requestSubmit();
    };

    const onStop = async () => {
        updateStatus('正在停止...');
        await surface.cancelMessage();
    };

    form.addEventListener('submit', onSubmit);
    stopBtn.addEventListener('click', onStop);

    async function retryPersistence() {
        if (!hasUnsavedChanges) return { ok: true, message: '无未保存的历史' };
        updateStatus('正在重试保存...');
        try {
            const inMem = (pendingSaveHistory && pendingSaveHistory.length > 0)
                ? pendingSaveHistory
                : (enhancedConversation?.historyRef?.get?.() || []);
            let targetHistory = inMem;
            if (!Array.isArray(targetHistory) || targetHistory.length === 0) {
                const histRes = await repository.getHistory(descriptor.child.itemId, 'agent', descriptor.child.topicId);
                targetHistory = Array.isArray(histRes) ? histRes : (histRes?.history || []);
            }
            const saveRes = await repository.saveHistory(
                descriptor.child.itemId,
                'agent',
                descriptor.child.topicId,
                targetHistory
            );
            if (!(saveRes && (saveRes.success === false || saveRes.error))) {
                hasUnsavedChanges = false;
                pendingSaveHistory = null;
                lastPersistenceError = null;
                if (enhancedConversation?.historyRef?.set) {
                    enhancedConversation.historyRef.set(targetHistory);
                }
                persistenceBadge.hidden = true;
                updateStatus('保存成功');
                return { ok: true };
            } else {
                updateStatus(`重试保存失败：${saveRes?.error || '未知错误'}`, 'error');
                return { ok: false, error: saveRes?.error };
            }
        } catch (err) {
            updateStatus(`重试保存失败：${err.message}`, 'error');
            return { ok: false, error: err.message };
        }
    }

    function discardUnsaved() {
        hasUnsavedChanges = false;
        pendingSaveHistory = null;
        lastPersistenceError = null;
        persistenceBadge.hidden = true;
        updateStatus('就绪');
    }

    if (persistenceBadge) {
        persistenceBadge.addEventListener('click', async (e) => {
            e.stopPropagation();
            await retryPersistence();
        });
        persistenceBadge.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            discardUnsaved();
            chatCapabilities?.uiHelper?.showToastNotification?.('已放弃未保存的历史更改', 'info');
        });
    }

    async function loadHistoryFn() {
        updateStatus('正在加载历史...');
        try {
            const res = await surface.loadHistory(
                descriptor.child.itemId,
                'agent',
                descriptor.child.topicId,
                { initialBatch: 5, batchSize: 10, batchDelay: 80 }
            );
            if (isDisposed) return res;
            isHistoryLoaded = true;
            textarea.disabled = false;
            updateComposerState();
            updateEmptyState();
            updateStatus('就绪');
            return res;
        } catch (err) {
            if (isDisposed) return;
            isHistoryLoaded = false;
            updateStatus(`加载历史失败：${err.message} (点击重试)`, 'error');
            throw err;
        }
    }

    const loadPromise = loadHistoryFn().catch(() => {});

    statusText.addEventListener('click', () => {
        if (!isHistoryLoaded && !isDisposed) {
            loadHistoryFn().catch(() => {});
        }
    });

    const handle = Object.freeze({
        get descriptor() {
            return currentDescriptor;
        },
        surface,
        setVisible(visible) {
            if (visible && !isDisposed && isHistoryLoaded) {
                textarea.focus();
            }
        },
        focus() {
            if (!isDisposed && isHistoryLoaded) {
                textarea.focus();
            }
        },
        addReference(ref) {
            if (!ref || !ref.text || isDisposed) return;
            const validation = validateReferenceList(references, ref);
            if (!validation.ok) {
                chatCapabilities?.uiHelper?.showToastNotification?.(validation.message, 'warning');
                return;
            }
            references.push(ref);
            renderReferences();
            updateComposerState();
            scheduleInputSave();
        },
        removeReference(refId) {
            const index = references.findIndex(r => r.id === refId);
            if (index !== -1) {
                references.splice(index, 1);
                renderReferences();
                updateComposerState();
                scheduleInputSave();
            }
        },
        getReferences() {
            return [...references];
        },
        setModel(model) {
            updateModel(model);
        },
        getModel() {
            return currentModel;
        },
        getDraft() {
            return textarea.value;
        },
        setDraft(text) {
            if (isDisposed) return;
            textarea.value = String(text || '');
            updateComposerState();
            scheduleInputSave();
        },
        getUnsavedStatus() {
            return { hasUnsavedChanges, error: lastPersistenceError };
        },
        async retryPersistence() {
            return await retryPersistence();
        },
        discardUnsaved() {
            discardUnsaved();
        },
        async retryLoadHistory() {
            return await loadHistoryFn();
        },
        async requestClose() {
            if (hasUnsavedChanges) {
                chatCapabilities?.uiHelper?.showToastNotification?.('无法关闭标签页：存在未保存的历史记录。请点击保存徽标重试，或右键点击徽标放弃更改。', 'warning');
                return { closed: false, reason: 'UNSAVED_CHANGES' };
            }
            // Cancel active operation and wait for settlement
            if (activeOperation) {
                try {
                    await surface.cancelMessage();
                } catch {}
            }
            return { closed: true };
        },
        async dispose() {
            if (isDisposed) return;
            flushInputSave();
            isDisposed = true;
            if (activeOperation) {
                try {
                    await surface.cancelMessage();
                } catch {}
            }
            disposeCleanups.forEach(fn => { try { fn(); } catch {} });
            disposeCleanups.length = 0;
            messageObserver?.disconnect?.();
            submitInteractiveContent = null;
            form.removeEventListener('submit', onSubmit);
            stopBtn.removeEventListener('click', onStop);
            await surface.dispose();
            childScope?.dispose?.('side-chat-unmounted');
            container.replaceChildren();
        }
    });

    return handle;
}

/**
 * Creates a SideChatSurfaceOwner provider for SidePaneController.
 * @param {Object} options
 * @param {Object} options.chatCapabilities
 * @param {Object} [options.scope]
 * @returns {Object} { mountTab(descriptor, container) }
 */
export function createSideChatSurfaceOwner({
    chatCapabilities,
    scope = null
}) {
    return Object.freeze({
        async mountTab(descriptor, container) {
            return await mountSideChatSurface(container, {
                descriptor,
                chatCapabilities,
                scope
            });
        }
    });
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
