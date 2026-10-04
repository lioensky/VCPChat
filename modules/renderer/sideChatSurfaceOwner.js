/* sideChatSurfaceOwner.js
 * Surface owner for Workspace Side Chat, supporting independent conversation,
 * concurrent streaming, cancellation, selection references, and lifecycle disposal.
 */
'use strict';

import { escapeHtmlValue as escapeHtml } from '../ui-system/text-escape.js';
import { createSideChatShell } from './side-chat/shell.js';
import { createSideChatComposerState } from './side-chat/composer-state.js';
import { createSideChatScrolling } from './side-chat/scrolling.js';
import { createSideChatMessageActions } from './side-chat/message-actions.js';
import { createSideChatReferences } from './side-chat/references.js';
import { createSideChatPersistence } from './side-chat/persistence.js';
import { createSideChatModelPicker } from './side-chat/model-picker.js';
import { createSideChatDraftCache } from './side-chat/draft-cache.js';
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

    // Shell template: the composer mirrors the main chat input card (textarea, then one actions row
    // with a ghost model select on the right and the round send button), nothing else.
    const shellOwner = createSideChatShell({
        currentModel,
        container,
        descriptor,
        escapeHtml
    });
    const { root, form, textarea, sendBtn, stopBtn, statusText, persistenceBadge, referenceList, modelPickerBtn, modelPopover, modelNameSpan } = shellOwner;

    let currentDescriptor = {
        ...descriptor,
        model: currentModel
    };

    // 父快照：来源话题的历史，首条消息发送前会重新截取
    let snapshotMessages = Array.isArray(descriptor.parentSnapshot) ? [...descriptor.parentSnapshot] : [];




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

    const store = Object.freeze({
        get currentModel() { return currentModel; },
        set currentModel(value) { currentModel = value; },
        get currentDescriptor() { return currentDescriptor; },
        set currentDescriptor(value) { currentDescriptor = value; },
        get snapshotMessages() { return snapshotMessages; },
        set snapshotMessages(value) { snapshotMessages = value; },
        get isDisposed() { return isDisposed; },
        set isDisposed(value) { isDisposed = value; },
        get isHistoryLoaded() { return isHistoryLoaded; },
        set isHistoryLoaded(value) { isHistoryLoaded = value; },
        get references() { return references; },
        get hasUnsavedChanges() { return hasUnsavedChanges; },
        set hasUnsavedChanges(value) { hasUnsavedChanges = value; },
        get lastPersistenceError() { return lastPersistenceError; },
        set lastPersistenceError(value) { lastPersistenceError = value; },
        get pendingSaveHistory() { return pendingSaveHistory; },
        set pendingSaveHistory(value) { pendingSaveHistory = value; }
    });

    const composerStateOwner = createSideChatComposerState({
        store,
        onStatusChange,
        root,
        sendBtn,
        statusText,
        textarea
    });
    const { updateStatus, updateEmptyState, updateComposerState } = composerStateOwner;

    const scrollingOwner = createSideChatScrolling({
        store,
        doc,
        root
    });
    const { pinToBottomIfSticky } = scrollingOwner;

    const messageActionsOwner = createSideChatMessageActions({
        store,
        chatCapabilities,
        descriptor,
        doc,
        root,
        updateEmptyState: (...args) => updateEmptyState(...args),
        pinToBottomIfSticky
    });
    const { extractTextFromContentDiv, attachMessageActions, syncMessageActions } = messageActionsOwner;

    const referencesOwner = createSideChatReferences({
        store,
        doc,
        referenceList,
        getHandle: () => handle
    });
    const { renderReferences } = referencesOwner;

    const persistenceOwner = createSideChatPersistence({
        store,
        chatCapabilities,
        descriptor,
        doc,
        persistenceBadge,
        repository,
        statusText,
        textarea,
        updateComposerState: (...args) => updateComposerState(...args),
        updateEmptyState: (...args) => updateEmptyState(...args),
        updateStatus: (...args) => updateStatus(...args),
        getConversation: () => enhancedConversation,
        getSurface: () => surface
    });
    const { needsSnapshotRefresh, refreshSnapshot, persistMetadata, scheduleInputSave, flushInputSave, retryPersistence, discardUnsaved, loadHistoryFn } = persistenceOwner;

    const modelPickerOwner = createSideChatModelPicker({
        store,
        chatCapabilities,
        doc,
        modelNameSpan,
        modelPickerBtn,
        modelPopover,
        persistMetadata: (...args) => persistMetadata(...args),
        onModelChange: model => { selectedItem.model = model; if (selectedItem.config) selectedItem.config.model = model; },
        updateComposerState: (...args) => updateComposerState(...args)
    });
    const { updateModel } = modelPickerOwner;




    if (!repository || typeof createRenderer !== 'function' || !chatManager) {
        updateStatus('聊天能力尚未就绪', 'error');
        return {
            descriptor,
            setVisible() {},
            focus() {},
            async requestClose() { return { closed: true }; },
            async dispose() {
                composerStateOwner.dispose();
                scrollingOwner.dispose();
                messageActionsOwner.dispose();
                referencesOwner.dispose();
                persistenceOwner.dispose();
                modelPickerOwner.dispose();
                childScope?.dispose?.('side-chat-unavailable');
                container.replaceChildren();
            },
            addReference() {},
            removeReference() {},
        };
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
        shouldScrollToBottom: () => scrollingOwner.isSticky(),
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
        scrollingOwner.resume();
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

    const loadPromise = loadHistoryFn().catch(() => {});

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
            composerStateOwner.dispose();
            scrollingOwner.dispose();
            messageActionsOwner.dispose();
            referencesOwner.dispose();
            persistenceOwner.dispose();
            modelPickerOwner.dispose();
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
    scope = null,
    mountSurface = mountSideChatSurface
}) {
    const drafts = createSideChatDraftCache();
    return Object.freeze({
        async mountTab(descriptor, container) {
            const handle = await mountSurface(container, { descriptor, chatCapabilities, scope });
            return drafts.ownHandle(handle, descriptor);
        },
        dispose() { drafts.dispose(); }
    });
}
