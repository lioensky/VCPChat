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
import { createSideChatMessageEditor } from './side-chat/message-edit.js';
import { createSideChatReferences } from './side-chat/references.js';
import { createSideChatPersistence } from './side-chat/persistence.js';
import { createSideChatModelPicker } from './side-chat/model-picker.js';
import { createSideChatAttachments } from './side-chat/attachments.js';
import { createSideChatDraftCache } from './side-chat/draft-cache.js';
import { createSideChatDraftStore } from './side-chat/draft-store.js';
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
    onStatusChange = null,
    draftStore = null
} = {}) {
    if (!container || !container.ownerDocument) {
        throw new TypeError('mountSideChatSurface requires a valid container element');
    }
    if (!descriptor) {
        throw new TypeError('mountSideChatSurface requires a descriptor');
    }

    const doc = container.ownerDocument;
    const composerDrafts = draftStore || createSideChatDraftStore({ getStorage: () => doc.defaultView?.localStorage });
    const storedInput = composerDrafts.read(descriptor).input;
    if (storedInput) descriptor = { ...descriptor, ...storedInput };
    const repository = chatCapabilities?.repository;
    const createRenderer = chatCapabilities?.createRenderer;
    const chatManager = chatCapabilities?.manager;
    // 挂在这次挂载的 view scope 下：view 被释放时，整个对话面板跟着拆（见下方 ownTeardown）
    const childScope = scope?.active !== false && typeof scope?.child === 'function'
        ? scope.child(`side-chat-${descriptor.id}`)
        : null;
    // 拆卸只跑一次：handle.dispose 和 scope 释放谁先到都走同一份
    function ownTeardown(teardown) {
        let pending = null;
        // 同步部分立刻执行（比如先存输入框），和原来直接调 dispose 的时序一致
        const run = () => (pending ||= (async () => teardown())());
        // 挂载途中 scope 已被释放时不再登记，控制器随后会直接调 handle.dispose
        if (childScope?.active) childScope.own(run, 'side-chat-surface');
        return async (reason) => {
            await run();
            await childScope?.dispose?.(reason);
        };
    }

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
    const { root, form, textarea, sendBtn, stopBtn, statusText, persistenceBadge, referenceList, modelPickerBtn, modelPopover, modelNameSpan, attachBtn, emoticonBtn, attachmentPreview } = shellOwner;
    textarea.value = descriptor.draft || '';

    let currentDescriptor = {
        ...descriptor,
        model: currentModel
    };

    // 父快照：来源话题的历史，首条消息发送前会重新截取
    let snapshotMessages = Array.isArray(descriptor.parentSnapshot) ? [...descriptor.parentSnapshot] : [];




    let isDisposed = false;
    let isHistoryLoaded = false;
    let isDeletingMessage = false;
    // 重新回复先存截短的历史再发送：这段 await 期间还没有 activeSendController，另起的发送会和它撞车
    let isRegenerating = false;
    let isComposing = false;
    let activeOperation = null;
    let activeSendController = null;
    let submitInteractiveContent = null;
    let hasUnsavedChanges = false;
    let lastPersistenceError = null;
    let pendingSaveHistory = null;
    // 渲染器和会话在聊天能力就绪后才创建；右键菜单通过这里取用
    let liveRenderer = null;
    let liveConversation = null;
    let liveRegenerate = null;
    const references = []; // { id, text, sourceMessageId }
    for (const ref of descriptor.references || []) {
        if (validateReferenceList(references, ref).ok) references.push(ref);
    }

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
        get isDeletingMessage() { return isDeletingMessage; },
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
        textarea,
        toolButtons: [attachBtn, emoticonBtn]
    });
    const { updateStatus, updateEmptyState, updateComposerState } = composerStateOwner;

    const attachmentsOwner = createSideChatAttachments({
        chatCapabilities,
        descriptor,
        attachBtn,
        emoticonBtn,
        previewArea: attachmentPreview,
        textarea,
        dropTarget: root,
        getWindow: () => doc.defaultView,
        onChange: () => updateComposerState()
    });

    const scrollingOwner = createSideChatScrolling({
        store,
        doc,
        root
    });
    const { pinToBottomIfSticky } = scrollingOwner;

    const liveRegenerateProxy = (id) => liveRegenerate?.(id);
    const messageEditor = createSideChatMessageEditor({
        doc,
        getHistory: () => liveConversation?.historyRef?.get?.() || [],
        setHistory: (history) => liveConversation?.historyRef?.set?.(history),
        saveHistory: (history) => repository.saveHistory(descriptor.child.itemId, 'agent', descriptor.child.topicId, history),
        rerender: (messageId, text) => liveRenderer?.updateMessageContent?.(messageId, text),
        isBusy: () => isDeletingMessage || form.hasAttribute('aria-busy'),
        toast: (message, type) => chatCapabilities?.uiHelper?.showToastNotification?.(message, type)
    });

    const messageActionsOwner = createSideChatMessageActions({
        store,
        chatCapabilities,
        descriptor,
        doc,
        root,
        textarea,
        getHistory: () => liveConversation?.historyRef?.get?.() || [],
        saveHistory: (history) => repository.saveHistory(descriptor.child.itemId, 'agent', descriptor.child.topicId, history),
        removeMessage: (messageId) => liveRenderer?.removeMessageById?.(messageId, false),
        isBusy: () => isDeletingMessage || form.hasAttribute('aria-busy'),
        onDeletingChange: (pending) => { isDeletingMessage = pending; updateComposerState(); },
        onComposerFilled: () => scheduleInputSave(),
        editMessage: (messageItem, message) => messageEditor.start(messageItem, message),
        regenerate: liveRegenerateProxy,
        updateEmptyState: (...args) => updateEmptyState(...args),
        pinToBottomIfSticky
    });

    const referencesOwner = createSideChatReferences({
        store,
        doc,
        referenceList,
        getHandle: () => handle
    });
    const { renderReferences } = referencesOwner;
    renderReferences();

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
        getSurface: () => surface,
        saveDraft: (metadata, input) => composerDrafts.save(metadata, input)
    });
    const { needsSnapshotRefresh, refreshSnapshot, scheduleInputSave, flushInputSave, retryPersistence, discardUnsaved, loadHistoryFn } = persistenceOwner;

    const modelPickerOwner = createSideChatModelPicker({
        store,
        chatCapabilities,
        doc,
        modelNameSpan,
        modelPickerBtn,
        modelPopover,
        persistMetadata: () => persistenceOwner.saveComposerInput(),
        onModelChange: model => {
            selectedItem.model = model;
            if (selectedItem.config) selectedItem.config.model = model;
            // 发送时提示过「请先选择模型」，选好之后别让这条错误还挂着
            if (statusText?.textContent === '请先选择模型') updateStatus('就绪');
        },
        updateComposerState: (...args) => updateComposerState(...args)
    });
    const { updateModel } = modelPickerOwner;




    if (!repository || typeof createRenderer !== 'function' || !chatManager) {
        updateStatus('聊天能力尚未就绪', 'error');
        const release = ownTeardown(() => {
            composerStateOwner.dispose();
            scrollingOwner.dispose();
            messageActionsOwner.dispose();
            messageEditor.dispose();
            referencesOwner.dispose();
            persistenceOwner.dispose();
            modelPickerOwner.dispose();
            attachmentsOwner.dispose();
            container.replaceChildren();
        });
        const unavailableDispose = () => release('side-chat-unavailable');
        return {
            descriptor,
            focus() {},
            async requestClose() { return { closed: true }; },
            dispose: unavailableDispose,
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
    liveRenderer = renderer;

    // Supply frozen parent snapshot context if present (P1 context inheritance)
    const enhancedConversation = Object.freeze({
        ...rendererOwner.conversation,
        getContextHistory: () => (currentDescriptor.contextMode === 'parent-snapshot' ? [...snapshotMessages] : [])
    });
    liveConversation = enhancedConversation;
    liveRegenerate = (id) => regenerate(id);

    const operations = createChatOperations({
        send: async (request) => {
            try {
                return await chatManager.sendMessage({
                    ...request,
                    conversation: enhancedConversation,
                    awaitTerminal: true,
                    onOperation(operation) {
                        activeOperation = operation;
                    },
                });
            } finally {
                activeOperation = null;
            }
        },
        cancel: async () => {
            activeSendController?.abort('side-chat-user-cancel');
            const operation = activeOperation;
            if (operation && typeof operation.cancel === 'function') {
                return await operation.cancel('side-chat-user-cancel');
            }
            return Boolean(activeSendController);
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
        // 生成中按 Esc 停止，同 ZCode 的 Esc → stop；只认输入框里的 Esc，不和侧栏里菜单、搜索的 Esc 抢
        if (e.key === 'Escape' && !isComposing && !e.defaultPrevented && activeSendController) {
            e.preventDefault();
            onStop();
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey && !isComposing && e.keyCode !== 229) {
            e.preventDefault();
            form.requestSubmit();
        }
    });

    const onSubmit = async (event) => {
        event?.preventDefault?.();
        // 还在生成时不再起第二次发送：它失败后的清理会清掉正在进行的那次，停止按钮随之消失
        if (isDisposed || !isHistoryLoaded || isDeletingMessage || isRegenerating || activeSendController || form.hasAttribute('aria-busy')) return;
        if (!currentModel) {
            updateStatus('请先选择模型', 'error');
            return;
        }

        const rawText = textarea.value.trim();
        if (!rawText && references.length === 0 && attachmentsOwner.count === 0) return;

        const submittedText = rawText;
        const submittedReferenceIds = new Set(references.map(r => r.id));
        const submittedReferences = [...references];
        const submittedAttachments = attachmentsOwner.take();

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

        // 用户消息被撤回（未发出/发送失败）时才把草稿和引用放回输入框
        await runSend(payload, submittedAttachments, () => {
            // 生成期间输入框可用，撤回时用户可能已经写了下一句：放回的提问接在前面，两段都不丢
            if (submittedText) textarea.value = textarea.value ? `${submittedText}\n${textarea.value}` : submittedText;
            for (const ref of submittedReferences) {
                if (!references.some(r => r.id === ref.id)) references.unshift(ref);
            }
            attachmentsOwner.restore(submittedAttachments);
            renderReferences();
            scheduleInputSave();
        });
    };

    async function runSend(payload, submittedAttachments, restoreDraft) {
        // 停止按钮从准备阶段就可用：父快照、落盘和请求组装也属于这一轮。
        const sendController = new (doc.defaultView?.AbortController || AbortController)();
        activeSendController = sendController;
        messageEditor.close();
        // 输入框不禁用，和主聊一样：焦点留在原处，生成期间可以先写下一句（回车被上面的忙碌判断挡住），Esc 停止
        form.setAttribute('aria-busy', 'true');
        attachmentsOwner.setDisabled(true);
        sendBtn.hidden = true;
        stopBtn.hidden = false;
        updateStatus('生成中...');
        // 和主聊一致：自己发出的消息总是滚到底部跟随
        scrollingOwner.resume();
        pinToBottomIfSticky();

        // 已经进入历史的一轮（例如中途停止）不再回填，避免重复发送。只看这次新增的用户消息：
        // 以前发过同样的文字（比如「继续」）不代表这一轮还在，否则这次的草稿、附件和引用会一起丢掉
        const userMessagesBefore = new Set((enhancedConversation?.historyRef?.get?.() || [])
            .filter(msg => msg?.role === 'user').map(msg => msg.id ?? msg));
        const restoreDraftIfRetracted = () => {
            const history = enhancedConversation?.historyRef?.get?.() || [];
            if (history.some(msg => msg?.role === 'user' && !userMessagesBefore.has(msg.id ?? msg))) return;
            restoreDraft();
        };

        try {
            if (needsSnapshotRefresh()) await refreshSnapshot();
            if (sendController.signal.aborted) {
                restoreDraftIfRetracted();
                updateStatus('已取消', 'normal', 'cancelled');
                return;
            }
            const result = await surface.sendMessage({
                content: payload,
                attachments: submittedAttachments,
                input: textarea,
                domRenderer: surface.renderer,
                signal: sendController.signal,
                propagateError: true
            });

            const terminalType = result?.terminal?.event?.type;
            if (terminalType === 'cancelled' || terminalType === 'discarded') {
                restoreDraftIfRetracted();
                updateStatus('已取消', 'normal', 'cancelled');
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
            if (activeSendController === sendController) activeSendController = null;
            if (!isDisposed) {
                form.removeAttribute('aria-busy');
                sendBtn.hidden = false;
                stopBtn.hidden = true;
                updateComposerState();
                updateEmptyState();
                pinToBottomIfSticky();
            }
        }
    }

    // 重新回复：截掉这条回答对应的提问及其后的所有消息，再用侧栏自己的模型和上下文把提问重新发出
    async function regenerate(assistantId) {
        if (isDisposed || !isHistoryLoaded || isDeletingMessage || isRegenerating || activeSendController || form.hasAttribute('aria-busy')) return;
        isRegenerating = true;
        try {
            await regenerateNow(assistantId);
        } finally {
            isRegenerating = false;
        }
    }

    async function regenerateNow(assistantId) {
        if (!currentModel) {
            updateStatus('请先选择模型', 'error');
            return;
        }
        const history = enhancedConversation.historyRef.get() || [];
        const answerIndex = history.findIndex(m => m?.id === assistantId);
        let questionIndex = answerIndex - 1;
        while (questionIndex >= 0 && history[questionIndex]?.role !== 'user') questionIndex--;
        if (answerIndex === -1 || questionIndex < 0) {
            updateStatus('找不到这条回答对应的提问', 'error');
            return;
        }
        const question = history[questionIndex];
        const text = typeof question.content === 'string' ? question.content : (question.content?.text || '');
        const attachments = (Array.isArray(question.attachments) ? question.attachments : []).map(att => ({
            file: { name: att.name, type: att.type, size: att.size },
            localPath: att.src,
            originalName: att.name,
            _fileManagerData: att._fileManagerData || {}
        }));
        const kept = history.slice(0, questionIndex);
        // 截断落盘期间就算这一轮在忙：否则这时按回车会另起一轮，两轮抢同一个停止按钮和内存里的历史
        form.setAttribute('aria-busy', 'true');
        const releaseBusy = () => {
            if (isDisposed) return;
            form.removeAttribute('aria-busy');
            updateComposerState();
        };
        let saved;
        try {
            saved = await repository.saveHistory(descriptor.child.itemId, 'agent', descriptor.child.topicId, kept);
        } catch (error) {
            saved = { error: error?.message || String(error) };
        }
        if (saved && (saved.success === false || saved.error)) {
            releaseBusy();
            updateStatus(`重新回复失败：${saved.error || '保存历史出错'}`, 'error');
            return;
        }
        if (isDisposed) return;
        for (const msg of history.slice(questionIndex)) renderer.removeMessageById(msg.id, false);
        enhancedConversation.historyRef.set(kept);
        updateEmptyState();
        await runSend(text, attachments, () => {
            if (!textarea.value) textarea.value = text;
            attachmentsOwner.restore(attachments);
            updateComposerState();
            scheduleInputSave();
        });
    }

    // 消息里的交互按钮：和主聊一样只发这段文本，不覆盖、也不带上输入框里还没发出去的草稿、引用和附件
    submitInteractiveContent = (text) => {
        if (isDisposed) return;
        const notify = (message) => chatCapabilities?.uiHelper?.showToastNotification?.(message, 'warning');
        if (activeSendController || isRegenerating || isDeletingMessage || !isHistoryLoaded) {
            notify('辅助对话正在处理上一条消息，请稍后再点。');
            return;
        }
        if (textarea.value.trim() || references.length > 0 || attachmentsOwner.count > 0) {
            notify('输入框里还有没发出的内容，请先发送或清空后再点。');
            return;
        }
        textarea.value = String(text || '');
        form.requestSubmit();
    };

    const onStop = async () => {
        // 点停止后按钮会藏起来，焦点不能丢在 body 上
        if (doc.activeElement === stopBtn) textarea.focus();
        activeSendController?.abort('side-chat-user-cancel');
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
        // 发送、重新回复、删除、未保存、带附件或正在编辑时为 true（侧聊按 keep 不休眠，这里只报告忙碌）
        isBusy() {
            return !isDisposed && (Boolean(activeSendController) || isRegenerating || isDeletingMessage
                || hasUnsavedChanges || attachmentsOwner.count > 0 || messageEditor.isEditing()
                || form.hasAttribute('aria-busy'));
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
            if (isDeletingMessage) {
                chatCapabilities?.uiHelper?.showToastNotification?.('正在保存删除，请稍后关闭标签页。', 'warning');
                return { closed: false, reason: 'DELETE_PENDING' };
            }
            if (hasUnsavedChanges) {
                chatCapabilities?.uiHelper?.showToastNotification?.('无法关闭标签页：存在未保存的历史记录。请点击保存徽标重试，或右键点击徽标放弃更改。', 'warning');
                return { closed: false, reason: 'UNSAVED_CHANGES' };
            }
            // 关闭会删掉子话题；有记录或没发出去的输入时先确认，免得误点（含「关闭其他 / 全部」）把对话永久删掉。
            // 和没挂载时的 requestTabClose 一样：草稿和引用也算
            const uiHelper = chatCapabilities?.uiHelper;
            const history = liveConversation?.historyRef?.get?.() || [];
            const hasInput = Boolean(textarea.value.trim()) || references.length > 0 || attachmentsOwner.count > 0;
            if (typeof uiHelper?.showConfirmDialog === 'function' && (history.length > 0 || hasInput)) {
                const confirmed = await uiHelper.showConfirmDialog(
                    `关闭「${descriptor.title || '辅助对话'}」会删除这段辅助对话的全部记录，无法恢复。`,
                    '关闭辅助对话', '关闭并删除', '取消', true);
                if (!confirmed) return { closed: false, reason: 'USER_CANCELED' };
            }
            // Cancel active operation and wait for settlement
            if (activeSendController) {
                activeSendController.abort('side-chat-closed');
                try {
                    await surface.cancelMessage();
                } catch {}
            }
            return { closed: true };
        },
        dispose: () => releaseSurface('side-chat-unmounted')
    });

    async function teardownSurface() {
        if (isDisposed) return;
        flushInputSave();
        isDisposed = true;
        if (activeSendController) {
            activeSendController.abort('side-chat-unmounted');
            try {
                await surface.cancelMessage();
            } catch {}
        }
        composerStateOwner.dispose();
        scrollingOwner.dispose();
        messageActionsOwner.dispose();
        messageEditor.dispose();
        referencesOwner.dispose();
        persistenceOwner.dispose();
        modelPickerOwner.dispose();
        attachmentsOwner.dispose();
        submitInteractiveContent = null;
        form.removeEventListener('submit', onSubmit);
        stopBtn.removeEventListener('click', onStop);
        await surface.dispose();
        container.replaceChildren();
    }
    const releaseSurface = ownTeardown(teardownSurface);

    return handle;
}

/**
 * Creates a SideChatSurfaceOwner provider for SidePaneController.
 * @param {Object} options
 * @param {Object} options.chatCapabilities
 * @param {Object} [options.scope]
 * @returns {Object} { mountTab(descriptor, container, ctx) }
 */
export function createSideChatSurfaceOwner({
    chatCapabilities,
    scope = null,
    mountSurface = mountSideChatSurface,
    document: doc = globalThis.document
}) {
    const drafts = createSideChatDraftCache();
    let ownerDocument = doc;
    const draftStore = createSideChatDraftStore({ getStorage: () => ownerDocument?.defaultView?.localStorage });
    return Object.freeze({
        async mountTab(descriptor, container, { scope: viewScope = null } = {}) {
            ownerDocument ||= container.ownerDocument;
            const storedInput = draftStore.read(descriptor).input;
            if (storedInput) descriptor = { ...descriptor, ...storedInput };
            // 控制器给了 view scope 就挂在它下面，否则退回 provider 自己的 scope
            const handle = await mountSurface(container, { descriptor, chatCapabilities, scope: viewScope || scope, draftStore });
            return drafts.ownHandle(handle, descriptor);
        },
        readDraft: descriptor => draftStore.read(descriptor),
        forgetDraft(descriptor) {
            drafts.forget(descriptor);
            return draftStore.remove(descriptor);
        },
        dispose() { drafts.dispose(); }
    });
}
