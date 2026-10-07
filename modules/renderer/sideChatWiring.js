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

// 主进程拉模型列表没有超时；服务器挂住时最多等这么久，之后按缓存显示
const MODEL_REFRESH_TIMEOUT_MS = 10000;
// 连续打开模型菜单时共用同一次刷新，不并发重复拉取
const pendingModelRefresh = new WeakMap();

function refreshModelsOnce(api) {
    let pending = pendingModelRefresh.get(api);
    if (!pending) {
        pending = Promise.resolve()
            .then(() => api.refreshModels())
            .catch(error => {
                console.warn('[SideChat] Failed to refresh models:', error);
                return null;
            })
            .finally(() => pendingModelRefresh.delete(api));
        pendingModelRefresh.set(api, pending);
    }
    return pending;
}

/** 与输入框模型选择器同源：服务器缓存的模型 + 收藏 */
export async function listSideChatModels(api, { timeoutMs = MODEL_REFRESH_TIMEOUT_MS } = {}) {
    let [models, favorites] = await Promise.all([
        api?.getCachedModels?.() ?? [],
        api?.getFavoriteModels?.() ?? [],
    ]);
    if (!normalizeModelIds(models).length && api?.refreshModels) {
        // refresh-models 拉取完成后才返回结果，不再固定等 1.5 秒猜它好了没有
        let timer = null;
        const timedOut = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
        const refreshed = await Promise.race([refreshModelsOnce(api), timedOut]);
        clearTimeout(timer);
        // 刷新失败或超时：再看一眼缓存（可能已被别的窗口刷新过）
        models = Array.isArray(refreshed?.models) ? refreshed.models : await api.getCachedModels?.();
    }
    return { ids: normalizeModelIds(models), favorites: new Set(Array.isArray(favorites) ? favorites : []) };
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
            listModels: () => listSideChatModels(win.electronAPI || chatAPI),
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

        return getController().openTab({ kind: 'chat', descriptor });
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
                // 面板收着放久了这个侧聊可能已经休眠（视图拆了、标签还在）：重新挂上再加，不能另开一个新的
                const handle = getController().getTabHandle(activeTab.id)
                    || await getController().openTab({ kind: 'chat', descriptor: activeTab.descriptor });
                if (handle?.addReference) {
                    handle.addReference(options.reference);
                    getController().setVisible(true);
                    handle.focus?.();
                    return handle;
                }
            }
        }

        // 同一父会话下并发的创建请求合并为一次，避免连点产生多个子会话。
        // 引用由每个调用方在创建完成后各自加上：合并进来的第二次「在侧栏提问」不能把自己的引用丢掉（同 ZCode SessionPane）
        const handle = await dedupeSideChatCreation(`${currentItem.id}:${currentTopicId}`,
            () => createSideChat(options, currentItem, currentTopicId));
        if (options?.reference && handle?.addReference) handle.addReference(options.reference);
        return handle;
    }

    async function restoreSessions(agentId, parentTopicId) {
        const listRes = await listSideChatsForParent({ electronAPI: chatAPI, agentId, parentTopicId });
        if (!isSameParent(getController().getSnapshot().parent, agentId, parentTopicId)) return [];
        if (!listRes.ok || !Array.isArray(listRes.items)) return [];

        // 收齐了一次性在后台补回：不抢用户正在看的标签，不强行展开，也不改这个话题记下的收起状态
        const restored = [];
        for (const item of listRes.items) {
            try {
                if (!isSameParent(getController().getSnapshot().parent, agentId, parentTopicId)) break;
                if (item.open === false || item.status === 'closed') continue;
                const childTopicId = item.child?.topicId;
                if (getController().getSnapshot().tabs.some(t => t.descriptor?.child?.topicId === childTopicId)) continue;
                if (restored.some(t => t.descriptor.child?.topicId === childTopicId)) continue;

                // 从未发过消息、也没有草稿和引用的空侧聊不再恢复，直接清理
                const childAgentId = item.child.itemId || agentId;
                const storedDraft = sideChatOwner.readDraft(item);
                const input = storedDraft.input || item;
                // 草稿只存在本机（composerStorage local）时这份就是唯一的一份：读坏了要告诉用户，不能悄悄变成空白
                if (!storedDraft.ok && item.composerStorage === 'local') {
                    console.warn('[SideChat] Failed to read side chat draft:', storedDraft.error);
                    notify(`辅助对话「${item.title || '未命名'}」保存的草稿读不出来，已按空白恢复`, 'warning');
                }
                const hasPendingInput = !!input.draft || (Array.isArray(input.references) && input.references.length > 0);
                if (storedDraft.ok && !hasPendingInput && typeof chatAPI?.getChatHistory === 'function') {
                    const childHistory = await chatAPI.getChatHistory(childAgentId, childTopicId);
                    // 读历史期间这个子话题可能刚被新建或打开（来回切话题时并发的恢复），那就不是"空的旧侧聊"
                    const openedMeanwhile = getController().getSnapshot().tabs.some(t => t.descriptor?.child?.topicId === childTopicId);
                    if (!openedMeanwhile && Array.isArray(childHistory) && childHistory.length === 0) {
                        const removed = await deleteSideChatChild({ electronAPI: chatAPI, agentId: childAgentId, childTopicId });
                        if (removed.ok) sideChatOwner.forgetDraft(item);
                        else console.warn('[SideChat] Failed to clean up empty side chat:', removed.message);
                        continue;
                    }
                }

                restored.push({ kind: 'chat', descriptor: { ...createSideChatDescriptor({
                    parent: item.parent,
                    childTopicId,
                    title: item.title,
                    contextMode: item.contextMode,
                    snapshotId: item.snapshotId,
                    parentSnapshot: item.parentSnapshot || [],
                    model: input.model || null,
                    open: true,
                    status: 'ready',
                    draft: input.draft || '',
                    references: Array.isArray(input.references) ? input.references : []
                }),
                // 沿用存档里的 id：标签 id 每次重启都一样，面板才能按对话记忆回到这个辅助对话
                ...(typeof item.id === 'string' && item.id ? { id: item.id } : {}),
                // 创建时间也沿用存档：辅助对话按它排序，换成重启时间的话改一次模型存一下档，顺序就乱了
                ...(Number.isFinite(item.createdAt) ? { createdAt: item.createdAt } : {}),
                composerStorage: item.composerStorage } });
            } catch (e) {
                console.warn('[SideChat] Failed to restore side chat tab:', e);
            }
        }
        if (restored.length > 0 && isSameParent(getController().getSnapshot().parent, agentId, parentTopicId)) {
            await getController().restoreTabs(restored);
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
    // 还没显示过的辅助对话（恢复出来、没挂载）关闭前同样确认：有记录或草稿就问一句，和挂载后的 requestClose 一致
    async function requestTabClose(descriptor) {
        if (typeof uiHelper?.showConfirmDialog !== 'function') return { closed: true };
        const agentId = descriptor?.child?.itemId || descriptor?.parent?.itemId;
        const childTopicId = descriptor?.child?.topicId;
        if (!agentId || !childTopicId) return { closed: true };
        const stored = sideChatOwner.readDraft(descriptor);
        const input = stored?.input || {};
        let hasContent = !!input.draft || (Array.isArray(input.references) && input.references.length > 0);
        if (!hasContent && typeof chatAPI?.getChatHistory === 'function') {
            try {
                const history = await chatAPI.getChatHistory(agentId, childTopicId);
                // 读不出来时按有记录处理：宁可多问一句
                hasContent = !Array.isArray(history) || history.length > 0;
            } catch {
                hasContent = true;
            }
        }
        if (!hasContent) return { closed: true };
        const confirmed = await uiHelper.showConfirmDialog(
            `关闭「${descriptor.title || '辅助对话'}」会删除这段辅助对话的全部记录，无法恢复。`,
            '关闭辅助对话', '关闭并删除', '取消', true);
        return confirmed ? { closed: true } : { closed: false, reason: 'USER_CANCELED' };
    }
    async function onTabClosed(descriptor) {
        const agentId = descriptor?.child?.itemId || descriptor?.parent?.itemId;
        const childTopicId = descriptor?.child?.topicId;
        if (!agentId || !childTopicId) return;
        const result = await deleteSideChatChild({ electronAPI: chatAPI, agentId, childTopicId });
        if (result.ok) sideChatOwner.forgetDraft(descriptor);
        else console.warn('[SideChat] Failed to delete closed side chat:', result.message);
    }
    return Object.freeze({
        provider: sideChatOwner, openSideChat, restoreSessions, onTabClosed, requestTabClose,
        dispose() {
            sideChatOwner.dispose();
            if (win.openSideChatWithSelection === selectionEntry) {
                if (previousSelectionEntry) win.openSideChatWithSelection = previousSelectionEntry;
                else delete win.openSideChatWithSelection;
            }
        }
    });
}
