import { createSidePaneController } from '../ui-system/side-pane/side-pane-controller.js';
import { captureSelectionReference } from '../ui-system/side-pane/selection-reference.js';
import { createSideChatSurfaceOwner } from './sideChatSurfaceOwner.js';
import { createNotesSideProvider } from '../ui-system/side-pane/notesSideProvider.js';
import { createCodeViewerSideProvider } from '../ui-system/side-pane/codeViewerSideProvider.js';
import { createBrowserSideProvider } from '../ui-system/side-pane/browserSideProvider.js';
import { createTerminalSideProvider } from '../ui-system/side-pane/terminalSideProvider.js';
import { createToolOutputSideProvider } from '../ui-system/side-pane/toolOutputSideProvider.js';
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

/**
 * Wires the workspace side pane into the main window: the pane controller, the side chat provider,
 * the "辅助对话" entry, topic following, and the selection entry points.
 * Returns the controller, or null when the window has no side pane.
 */
export function initWorkspaceSidePane({
    document: doc,
    window: win,
    elements,
    chatAPI,
    chatRepository,
    chatManager,
    uiHelper,
    createRenderer,
    settingsRef,
    selectedItemRef,
    topicIdRef,
    historyRef,
    subscriptions,
}) {
    const { root, resizerHandle, tabList, contentContainer, toggleNotificationsBtn, toggleChatBtn, closeBtn, addBtn } = elements;
    if (!root) return null;

    const notify = (message, type) => uiHelper?.showToastNotification?.(message, type);
    const isSameParent = (parent, agentId, topicId) => !parent
        || (parent.itemId === agentId && (!topicId || parent.topicId === topicId));

    const sideChatOwner = createSideChatSurfaceOwner({
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
        // 和 ZCode 一样按序号命名：取同一父话题下还没被占用的最小序号
        const usedOrdinals = new Set(controller.getSnapshot().tabs
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

        const descriptor = createSideChatDescriptor({
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
        });

        // 元数据落盘成功后才挂载，失败就把刚建的子话题删掉
        const saveMetaRes = await saveSideChatMetadata({ electronAPI: chatAPI, metadata: descriptor });
        if (!saveMetaRes?.ok) {
            await discardChild();
            notify(`保存辅助对话信息失败：${saveMetaRes?.message || saveMetaRes?.error || '元数据持久化异常'}`, 'error');
            return null;
        }

        const handle = await controller.openChat(descriptor);
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
            const existingHandle = await controller.openChat(reopenDesc);
            if (existingHandle) {
                controller.setVisible(true);
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
            const state = controller.getSnapshot();
            const activeTab = state.tabs.find(t => t.id === state.activeTabId && t.kind === 'chat');
            const parent = activeTab?.descriptor?.parent;
            if (parent?.itemId === currentItem.id && parent?.topicId === currentTopicId) {
                const handle = controller.getTabHandle(activeTab.id);
                if (handle?.addReference) {
                    handle.addReference(options.reference);
                    controller.setVisible(true);
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
        if (!isSameParent(controller.getSnapshot().parent, agentId, parentTopicId)) return [];
        if (!listRes.ok || !Array.isArray(listRes.items)) return [];

        for (const item of listRes.items) {
            try {
                if (!isSameParent(controller.getSnapshot().parent, agentId, parentTopicId)) break;
                if (item.open === false || item.status === 'closed') continue;
                const childTopicId = item.child?.topicId;
                if (controller.getSnapshot().tabs.some(t => t.descriptor?.child?.topicId === childTopicId)) continue;

                // 从未发过消息、也没有草稿和引用的空侧聊不再恢复，直接清理
                const childAgentId = item.child.itemId || agentId;
                const hasPendingInput = !!item.draft || (Array.isArray(item.references) && item.references.length > 0);
                if (!hasPendingInput && typeof chatAPI?.getChatHistory === 'function') {
                    const childHistory = await chatAPI.getChatHistory(childAgentId, childTopicId);
                    if (Array.isArray(childHistory) && childHistory.length === 0) {
                        deleteSideChatChild({ electronAPI: chatAPI, agentId: childAgentId, childTopicId })
                            .catch(err => console.warn('[SideChat] Failed to clean up empty side chat:', err));
                        continue;
                    }
                }

                await controller.openChat(createSideChatDescriptor({
                    parent: item.parent,
                    childTopicId,
                    title: item.title,
                    contextMode: item.contextMode,
                    snapshotId: item.snapshotId,
                    parentSnapshot: item.parentSnapshot || [],
                    model: item.model || item.descriptor?.model || null,
                    open: true,
                    status: 'ready',
                    draft: item.draft || '',
                    references: Array.isArray(item.references) ? item.references : []
                }));
            } catch (e) {
                console.warn('[SideChat] Failed to restore side chat tab:', e);
            }
        }
        return listRes.items;
    }

    const controller = createSidePaneController({
        root,
        resizerHandle,
        tabListElement: tabList,
        contentContainer,
        toggleNotificationsBtn,
        toggleChatBtn,
        closeSidePaneBtn: closeBtn,
        addChatTabBtn: addBtn,
        settingsRef,
        electronAPI: chatAPI,
        providers: { chat: sideChatOwner },
        openTabEntries: [{
            id: 'selection-side-conversation',
            label: '辅助对话',
            icon: 'chat_bubble',
            order: 0,
            open: () => controller.openSideChat({ forceNew: true })
        }],
        onOpenSideChat: openSideChat,
        // 辅助对话是临时会话，关标签即删除子话题和它的历史
        onTabClosed: async (descriptor) => {
            const agentId = descriptor?.child?.itemId || descriptor?.parent?.itemId;
            const childTopicId = descriptor?.child?.topicId;
            if (!agentId || !childTopicId) return;
            deleteSideChatChild({ electronAPI: chatAPI, agentId, childTopicId })
                .catch(err => console.warn('[SideChat] Failed to delete closed side chat:', err));
        },
        onRestoreSessions: restoreSessions
    });
    win.vcpSidePaneController = controller;
    subscriptions.add(controller);

    // 笔记和代码查看是全局标签，不随话题切换
    const notesProvider = createNotesSideProvider({
        electronAPI: chatAPI,
        utilityAPI: win.utilityAPI,
        sidePaneController: controller,
        uiHelper
    });
    controller.registerProvider('notes', notesProvider);
    const codeViewerProvider = createCodeViewerSideProvider({
        document: doc,
        api: chatAPI || win.utilityAPI || win.electronAPI,
        uiHelper,
        sidePaneController: controller
    });
    controller.registerProvider('code-viewer', codeViewerProvider);
    controller.registerOpenTabEntry({ id: 'notes', label: '随手笔记', icon: 'edit_note', order: 20, open: () => notesProvider.openNotesTab() });
    controller.registerOpenTabEntry({
        id: 'code-viewer',
        label: '代码查看',
        icon: 'code',
        order: 30,
        // 空载荷进入浏览模式（选工作区和文件）；固定 id，重复点击回到同一个标签
        open: async () => {
            await controller.openTab({
                id: 'code-viewer:browse',
                kind: 'code-viewer',
                title: '代码查看',
                icon: 'code',
                closable: true,
                scopeMode: 'global',
                payload: {}
            });
            controller.setVisible(true);
        }
    });
    // 浏览器标签同样是全局的；网页里的新窗口由主进程转成新的浏览器标签
    const browserProvider = createBrowserSideProvider({
        document: doc,
        api: chatAPI || win.electronAPI,
        sidePaneController: controller
    });
    controller.registerProvider('browser', browserProvider);
    controller.registerOpenTabEntry({ id: 'browser', label: '浏览器', icon: 'public', order: 40, open: () => browserProvider.openBrowserTab() });
    // 终端与命令输出共用 PowerShellExecutor 的同一个会话；终端里的链接交给浏览器标签打开
    const terminalProvider = createTerminalSideProvider({
        document: doc,
        api: chatAPI || win.electronAPI,
        sidePaneController: controller,
        onOpenUrl: (url) => browserProvider.openBrowserTab({ url, forceNew: true })
    });
    controller.registerProvider('terminal', terminalProvider);
    const toolOutputProvider = createToolOutputSideProvider({
        document: doc,
        api: chatAPI || win.electronAPI,
        sidePaneController: controller,
        uiHelper
    });
    controller.registerProvider('tool-output', toolOutputProvider);
    controller.registerOpenTabEntry({ id: 'terminal', label: '终端', icon: 'terminal', order: 50, open: () => terminalProvider.openTerminalTab() });
    controller.registerOpenTabEntry({ id: 'tool-output', label: '命令输出', icon: 'description', order: 60, open: () => toolOutputProvider.openToolOutputTab() });

    // 跟随主聊天：切换助手或话题时，侧栏换成那个话题的标签
    const syncSidePaneParent = async ({ item, topicId }) => {
        if (item?.type !== 'agent') {
            controller.setParent(null);
            return;
        }
        controller.setParent({ itemType: 'agent', itemId: item.id, topicId: topicId || '' });
        if (topicId) await controller.restoreSessions(item.id, topicId);
    };
    const unbindSelection = chatManager?.onSelectionChange?.(syncSidePaneParent);
    if (unbindSelection) subscriptions.add({ dispose: unbindSelection });
    const initialItem = selectedItemRef.get();
    if (initialItem?.id) syncSidePaneParent({ item: initialItem, topicId: topicIdRef.get() });

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
        await controller.openSideChat(reference ? { reference } : {});
    };

    wireFloatingSelectionButton({ doc, win, notify, subscriptions });

    return controller;
}

/** 在消息里选中文字时，选区上方浮出"在侧栏提问" */
function wireFloatingSelectionButton({ doc, win, notify, subscriptions }) {
    const floatingBtn = doc.getElementById('floatingSelectionSideChatBtn');
    if (!floatingBtn) return;

    const getSelectionMessageItem = (range) => {
        const node = range?.commonAncestorContainer;
        return (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.('.message-item') || null;
    };

    const hide = () => { floatingBtn.hidden = true; };

    const onSelectionChange = () => {
        const sel = win.getSelection();
        const selectedText = sel && !sel.isCollapsed && sel.rangeCount ? sel.toString().trim() : '';
        const range = selectedText.length >= 2 ? sel.getRangeAt(0) : null;
        if (!range || !getSelectionMessageItem(range)) {
            hide();
            return;
        }
        const rect = range.getBoundingClientRect();
        floatingBtn.hidden = false;
        const btnWidth = floatingBtn.offsetWidth || 110;
        const left = Math.max(10, Math.min(win.innerWidth - btnWidth - 10, rect.left + rect.width / 2 - btnWidth / 2));
        floatingBtn.style.left = `${Math.round(left)}px`;
        floatingBtn.style.top = `${Math.round(Math.max(10, rect.top - 36))}px`;
    };

    // 按下时不抢走选区
    const onMouseDown = (e) => e.preventDefault();

    const onClick = async (e) => {
        e.stopPropagation();
        const sel = win.getSelection();
        const selectedText = sel ? sel.toString().trim() : '';
        hide();
        if (!selectedText) return;
        if (selectedText.length > MAX_REFERENCE_CHARS) {
            notify(`选区文本超过 ${MAX_REFERENCE_CHARS} 字符上限，无法引用`, 'warning');
            return;
        }
        const messageItem = getSelectionMessageItem(sel.rangeCount ? sel.getRangeAt(0) : null);
        const sourceMessageId = messageItem?.getAttribute?.('data-message-id') || messageItem?.id || null;
        await win.openSideChatWithSelection({ selectedText, message: { id: sourceMessageId } });
    };

    doc.addEventListener('selectionchange', onSelectionChange);
    floatingBtn.addEventListener('mousedown', onMouseDown);
    floatingBtn.addEventListener('click', onClick);
    subscriptions.add({
        dispose: () => {
            doc.removeEventListener('selectionchange', onSelectionChange);
            floatingBtn.removeEventListener('mousedown', onMouseDown);
            floatingBtn.removeEventListener('click', onClick);
        }
    });
}
