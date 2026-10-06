import { captureSelectionReference } from '../ui-system/side-pane/selection-reference.js';
import { createSideChatSurfaceOwner } from './sideChatSurfaceOwner.js';
import {
    createSideChatDescriptor,
    createChildTopicForAgent,
    deleteSideChatChild,
    dedupeSideChatCreation,
    createParentSnapshot,
    saveSideChatMetadata,
    listSideChatsForParent
} from '../chat/sideChatSessionService.js';

const MAX_REFERENCE_CHARS = 8000;

function createReferenceId() {
    return `ref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeModelIds(models) {
    const list = Array.isArray(models) ? models
        : Array.isArray(models?.data) ? models.data
            : Array.isArray(models?.models) ? models.models : [];
    return list.map(m => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
}

export function createSideChatWiring({
    doc, win, chatAPI, chatRepository, chatManager, uiHelper, createRenderer,
    selectedItemRef, topicIdRef, historyRef, getController
}) {
    const notify = (message, type) => uiHelper?.showToastNotification?.(message, type);
    const previousSelectionEntry = win.openSideChatWithSelection;
    const isSameParent = (parent, agentId, topicId) => !parent
        || (parent.itemId === agentId && (!topicId || parent.topicId === topicId));

    const sideChatOwner = createSideChatSurfaceOwner({
        document: doc,
        chatCapabilities: {
            repository: chatRepository,
            createRenderer,
            manager: chatManager,
            uiHelper,
            electronAPI: chatAPI,
            saveSideChatMetadata: (metadata) => saveSideChatMetadata({ electronAPI: chatAPI, metadata }),
            resolveAgentConfig: async (agentId) => {
                const current = selectedItemRef.get();
                let rawConfig = null;
                if (current?.id === agentId && current?.config) {
                    rawConfig = current.config;
                } else if (typeof chatAPI?.getAgentConfig === 'function') {
                    // get-agent-config 直接返回配置对象，失败时返回 { error }
                    const config = await chatAPI.getAgentConfig(agentId);
                    if (config && typeof config === 'object' && !config.error) rawConfig = config;
                } else {
                    rawConfig = current?.config || null;
                }
                return rawConfig ? structuredClone(rawConfig) : null;
            },
            listModels: async () => {
                // 与输入框模型选择器同源：服务器缓存的模型 + 收藏
                const api = win.electronAPI || chatAPI;
                let [models, favorites] = await Promise.all([
                    api?.getCachedModels?.() ?? [],
                    api?.getFavoriteModels?.() ?? [],
                ]);
                if (!normalizeModelIds(models).length && api?.refreshModels) {
                    api.refreshModels();
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    models = await api.getCachedModels();
                }
                return { ids: normalizeModelIds(models), favorites: new Set(Array.isArray(favorites) ? favorites : []) };
            },
            refreshParentSnapshot: (descriptor) => createParentSnapshot({
                electronAPI: chatAPI,
                agentId: descriptor.parent.itemId,
                parentTopicId: descriptor.parent.topicId,
                childTopicId: descriptor.child.topicId,
                fallbackHistory: []
            }),
            getCurrentTopic: () => topicIdRef.get() || null,
            getCurrentItem: () => selectedItemRef.get() || null,
            navigateToParent: async (parent) => {
                if (!parent) return;
                if (parent.itemId && selectedItemRef.get()?.id !== parent.itemId) {
                    await chatManager?.selectItem?.(parent.itemId, parent.itemType || 'agent', parent.name);
                }
                if (parent.topicId && topicIdRef.get() !== parent.topicId) {
                    await chatManager?.selectTopic?.(parent.topicId);
                }
            },
        }
    });

    async function createSideChat(options, currentItem, currentTopicId) {
        // 按序号命名：取同一父话题下还没被占用的最小序号
        const usedOrdinals = new Set(getController().getSnapshot().tabs
            .filter(tab => isSameParent(tab.descriptor?.parent, currentItem.id, currentTopicId))
            .map(tab => /^辅助对话 (\d+)$/.exec(tab.title || '')?.[1])
            .filter(Boolean)
            .map(Number));
        let ordinal = 1;
        while (usedOrdinals.has(ordinal)) ordinal += 1;
        const topicTitle = options?.title || `辅助对话 ${ordinal}`;
        const createResult = await createChildTopicForAgent({ electronAPI: chatAPI, agentId: currentItem.id, topicTitle });
        if (!createResult.ok) {
            notify(`创建辅助对话失败：${createResult.message}`, 'error');
            return null;
        }
        const discardChild = () => deleteSideChatChild({ electronAPI: chatAPI, agentId: currentItem.id, childTopicId: createResult.topicId });

        let snapshotRes = { ok: true, snapshotId: null, messages: [] };
        const isReferencesOnly = options?.contextMode === 'references-only';
        if (!isReferencesOnly) {
            snapshotRes = await createParentSnapshot({
                electronAPI: chatAPI,
                agentId: currentItem.id,
                parentTopicId: currentTopicId,
                childTopicId: createResult.topicId,
                fallbackHistory: historyRef.get() || []
            });
            if (!snapshotRes?.ok) {
                await discardChild();
                notify(`获取父历史快照失败：${snapshotRes?.message || snapshotRes?.error || '快照创建异常'}`, 'error');
                return null;
            }
        }

        const descriptor = { ...createSideChatDescriptor({
            parent: {
                itemId: currentItem.id,
                topicId: currentTopicId,
                name: currentItem.name,
                avatar: currentItem.avatarUrl || currentItem.avatar,
                config: currentItem.config || null
            },
            childTopicId: createResult.topicId,
            title: topicTitle,
            contextMode: isReferencesOnly ? 'references-only' : 'parent-snapshot',
            snapshotId: snapshotRes.snapshotId,
            parentSnapshot: snapshotRes.messages || [],
            model: currentItem.config?.model || null,
            open: true,
            status: 'ready'
        }), composerStorage: 'local' };

        // 元数据落盘成功后才挂载，失败就把刚建的子话题删掉
        const saveMetaRes = await saveSideChatMetadata({ electronAPI: chatAPI, metadata: descriptor });
        if (!saveMetaRes?.ok) {
            await discardChild();
            notify(`保存辅助对话信息失败：${saveMetaRes?.message || saveMetaRes?.error || '元数据持久化异常'}`, 'error');
            return null;
        }

        const handle = await getController().openTab({ kind: 'chat', descriptor });
        if (options?.reference && handle?.addReference) {
            handle.addReference(options.reference);
        }
        return handle;
    }

    async function openSideChat(options = {}) {
        // 按描述符重新打开一个已有的侧聊
        if (options?.child?.topicId || (options?.id && options?.parent)) {
            const reopenDesc = { ...options, open: true, status: 'ready' };
            saveSideChatMetadata({ electronAPI: chatAPI, metadata: reopenDesc })
                .catch(err => console.warn('[SideChat] Failed to persist reopened metadata:', err));
            const existingHandle = await getController().openTab({ kind: 'chat', descriptor: reopenDesc });
            if (existingHandle) {
                getController().setVisible(true);
                existingHandle.focus?.();
                return existingHandle;
            }
        }

        const currentItem = selectedItemRef.get();
        const currentTopicId = topicIdRef.get();
        if (!currentItem || currentItem.type !== 'agent') {
            notify('请先在主聊天中选择一个助手，再开启辅助对话', 'warning');
            return null;
        }

        // 带引用且没要求新开时，引用追加到当前对话正在看的侧聊里
        if (options?.reference && !options?.forceNew) {
            const state = getController().getSnapshot();
            const activeTab = state.tabs.find(t => t.id === state.activeTabId && t.kind === 'chat');
            const parent = activeTab?.descriptor?.parent;
            if (parent?.itemId === currentItem.id && parent?.topicId === currentTopicId) {
                const handle = getController().getTabHandle(activeTab.id);
                if (handle?.addReference) {
                    handle.addReference(options.reference);
                    getController().setVisible(true);
                    handle.focus?.();
                    return handle;
                }
            }
        }

        // 同一父会话下并发的创建请求合并为一次，避免连点产生多个子会话
        return dedupeSideChatCreation(`${currentItem.id}:${currentTopicId}`,
            () => createSideChat(options, currentItem, currentTopicId));
    }

    async function restoreSessions(agentId, parentTopicId) {
        const listRes = await listSideChatsForParent({ electronAPI: chatAPI, agentId, parentTopicId });
        if (!isSameParent(getController().getSnapshot().parent, agentId, parentTopicId)) return [];
        if (!listRes.ok || !Array.isArray(listRes.items)) return [];

        // openTab 会激活恢复出来的侧聊，恢复完切回用户原来看的标签
        const activeBefore = getController().getSnapshot().activeTabId;
        for (const item of listRes.items) {
            try {
                if (!isSameParent(getController().getSnapshot().parent, agentId, parentTopicId)) break;
                if (item.open === false || item.status === 'closed') continue;
                const childTopicId = item.child?.topicId;
                if (getController().getSnapshot().tabs.some(t => t.descriptor?.child?.topicId === childTopicId)) continue;

                // 从未发过消息、也没有草稿和引用的空侧聊不再恢复，直接清理
                const childAgentId = item.child.itemId || agentId;
                const storedDraft = sideChatOwner.readDraft(item);
                const input = storedDraft.input || item;
                const hasPendingInput = !!input.draft || (Array.isArray(input.references) && input.references.length > 0);
                if (storedDraft.ok && !hasPendingInput && typeof chatAPI?.getChatHistory === 'function') {
                    const childHistory = await chatAPI.getChatHistory(childAgentId, childTopicId);
                    if (Array.isArray(childHistory) && childHistory.length === 0) {
                        const removed = await deleteSideChatChild({ electronAPI: chatAPI, agentId: childAgentId, childTopicId });
                        if (removed.ok) sideChatOwner.forgetDraft(item);
                        else console.warn('[SideChat] Failed to clean up empty side chat:', removed.message);
                        continue;
                    }
                }

                await getController().openTab({ kind: 'chat', descriptor: { ...createSideChatDescriptor({
                    parent: item.parent,
                    childTopicId,
                    title: item.title,
                    contextMode: item.contextMode,
                    snapshotId: item.snapshotId,
                    parentSnapshot: item.parentSnapshot || [],
                    model: input.model || item.descriptor?.model || null,
                    open: true,
                    status: 'ready',
                    draft: input.draft || '',
                    references: Array.isArray(input.references) ? input.references : []
                }), composerStorage: item.composerStorage } });
            } catch (e) {
                console.warn('[SideChat] Failed to restore side chat tab:', e);
            }
        }
        const snapshot = getController().getSnapshot();
        if (activeBefore && activeBefore !== snapshot.activeTabId && isSameParent(snapshot.parent, agentId, parentTopicId)
            && snapshot.tabs.some(t => t.id === activeBefore)) {
            getController().activateTab(activeBefore, { focus: false });
        }
        return listRes.items;
    }

    // 消息右键菜单"在侧栏提问"的入口
    win.openSideChatWithSelection = async (contextParams = null) => {
        let reference = null;
        if (contextParams?.selectedText) {
            if (contextParams.selectedText.length > MAX_REFERENCE_CHARS) {
                notify(`选区文本超过 ${MAX_REFERENCE_CHARS} 字符上限，无法引用`, 'warning');
                return;
            }
            reference = {
                id: createReferenceId(),
                text: contextParams.selectedText,
                sourceMessageId: contextParams.message?.id || null,
                capturedAt: Date.now()
            };
        } else if (contextParams?.messageItem) {
            const selRes = captureSelectionReference(win, contextParams.messageItem, contextParams.message);
            if (selRes.ok) {
                reference = selRes.reference;
            } else {
                const rawContent = String(contextParams.message?.content || contextParams.message?.text || '').trim();
                if (rawContent) {
                    reference = {
                        id: createReferenceId(),
                        text: rawContent.length > 300 ? `${rawContent.slice(0, 300)}...` : rawContent,
                        sourceMessageId: contextParams.message?.id || null,
                        capturedAt: Date.now()
                    };
                }
            }
        } else {
            const selRes = captureSelectionReference(win);
            if (selRes.ok) reference = selRes.reference;
        }
        await openSideChat(reference ? { reference } : {});
    };


    const selectionEntry = win.openSideChatWithSelection;
    async function onTabClosed(descriptor) {
        const agentId = descriptor?.child?.itemId || descriptor?.parent?.itemId;
        const childTopicId = descriptor?.child?.topicId;
        if (!agentId || !childTopicId) return;
        const result = await deleteSideChatChild({ electronAPI: chatAPI, agentId, childTopicId });
        if (result.ok) sideChatOwner.forgetDraft(descriptor);
        else console.warn('[SideChat] Failed to delete closed side chat:', result.message);
    }
    return Object.freeze({
        provider: sideChatOwner, openSideChat, restoreSessions, onTabClosed,
        dispose() {
            sideChatOwner.dispose();
            if (win.openSideChatWithSelection === selectionEntry) {
                if (previousSelectionEntry) win.openSideChatWithSelection = previousSelectionEntry;
                else delete win.openSideChatWithSelection;
            }
        }
    });
}
