import { captureSelectionReference } from '../ui-system/side-pane/selection-reference.js';
import { createSideChatSurfaceOwner } from './sideChatSurfaceOwner.js';
import {
    createSideChatDescriptor,
    createChildTopicForAgent,
    deleteSideChatChild,
    dedupeSideChatCreation,
    createParentSnapshot,
    saveSideChatMetadata,
    listSideChatsForParent,
    updateSideChatBranch
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

    // ── 深链接 vcp://sidechat/open?agent=..&branch=..&focus=..：点击跳回对话现场 ──
    function parseSideChatDeepLink(href) {
        if (!href || !href.startsWith('vcp://sidechat/')) return null;
        try {
            const qIndex = href.indexOf('?');
            if (qIndex === -1) return null;
            const params = new URLSearchParams(href.slice(qIndex + 1));
            const agent = params.get('agent');
            const branch = params.get('branch');
            if (!agent || !branch) return null;
            return { agent, branch, focus: params.get('focus') };
        } catch (err) {
            void err;
            return null;
        }
    }

    function branchMetaToReopenArgs(meta) {
        return {
            id: typeof meta.id === 'string' && meta.id ? meta.id : undefined,
            parent: meta.parent,
            child: meta.child,
            title: meta.title,
            contextMode: meta.contextMode,
            snapshotId: meta.snapshotId,
            rootTopicId: meta.rootTopicId,
            forkFromTopicId: meta.forkFromTopicId,
            forkMessageId: meta.forkMessageId,
            forkLabel: meta.forkLabel,
            branchTitle: meta.branchTitle,
            depth: meta.depth,
            crystallized: meta.crystallized
        };
    }

    async function openSideChatBranchByDeepLink(agent, branch) {
        const currentItem = selectedItemRef.get();
        if (!currentItem || currentItem.id !== agent) {
            notify('该笔记来自另一个助手的辅助对话，请先切换到对应助手', 'warning');
            return;
        }
        const controller = getController();
        const tab = controller.getSnapshot().tabs.find(t => t.kind === 'chat'
            && t.descriptor?.child?.topicId === branch);
        if (tab) {
            controller.setVisible(true);
            controller.activateTab(tab.id);
            controller.getTabHandle(tab.id)?.focus?.();
            return;
        }
        const listRes = await listSideChatsForParent({
            electronAPI: chatAPI,
            agentId: agent,
            parentTopicId: topicIdRef.get()
        });
        const meta = listRes?.items?.find(m => m?.child?.topicId === branch);
        if (!meta) {
            notify('找不到对应的辅助对话分支，可能已关闭或被删除', 'warning');
            return;
        }
        await openSideChat(branchMetaToReopenArgs(meta));
    }

    const onDeepLinkClick = (event) => {
        const anchor = event.target?.closest?.('a[href]');
        if (!anchor) return;
        const parsed = parseSideChatDeepLink(anchor.getAttribute('href'));
        if (!parsed) return;
        event.preventDefault();
        openSideChatBranchByDeepLink(parsed.agent, parsed.branch).catch(err =>
            console.warn('[SideChat] deep link open failed:', err));
    };
    doc.addEventListener('click', onDeepLinkClick, true);

    // ── 分形分支树：列出同族 / 分叉 / 切换 / 结晶，全部经现有 child-topic 管线 ──
    const branchApi = {
        async listSiblingMeta(descriptor) {
            const agentId = descriptor?.parent?.itemId;
            const parentTopicId = descriptor?.parent?.topicId;
            if (!agentId || !parentTopicId) return [];
            const res = await listSideChatsForParent({ electronAPI: chatAPI, agentId, parentTopicId });
            return res?.ok && Array.isArray(res.items) ? res.items : [];
        },

        // descriptor：来源分支；ancestorMessages：来源分支的完整上下文（祖先链快照 + 本支稳定消息）
        async forkBranch({ descriptor, ancestorMessages = [], forkMessageId = null, forkLabel = '', branchTitle = '', reference = null }) {
            const agentId = descriptor.parent.itemId;
            const parentTopicId = descriptor.parent.topicId;
            const currentItem = selectedItemRef.get();
            const createResult = await createChildTopicForAgent({ electronAPI: chatAPI, agentId });
            if (!createResult.ok) throw new Error(createResult.message || '创建分支失败');
            const discardChild = () => deleteSideChatChild({ electronAPI: chatAPI, agentId, childTopicId: createResult.topicId });

            // 祖先链完整上下文写入新分支快照：沿血缘递归传递，孙分支也不丢根上下文
            const snapshotRes = await createParentSnapshot({
                electronAPI: chatAPI,
                agentId,
                parentTopicId,
                childTopicId: createResult.topicId,
                fallbackHistory: [],
                explicitMessages: ancestorMessages
            });
            if (!snapshotRes?.ok) {
                await discardChild();
                throw new Error(snapshotRes?.message || snapshotRes?.error || '分支快照失败');
            }

            const rootTopicId = descriptor.rootTopicId || descriptor.child.topicId;
            const depth = (Number.isFinite(descriptor.depth) ? descriptor.depth : 0) + 1;
            const label = String(forkLabel || '').slice(0, 200);
            const title = String(branchLabelFallback(branchTitle, label)).slice(0, 200);
            const refs = reference ? [reference] : [];

            const childDescriptor = { ...createSideChatDescriptor({
                parent: {
                    itemId: agentId,
                    topicId: parentTopicId,
                    name: descriptor.parent.name || currentItem?.name,
                    avatar: descriptor.parent.avatar || currentItem?.avatarUrl || currentItem?.avatar,
                    config: currentItem?.config || null
                },
                childTopicId: createResult.topicId,
                title,
                contextMode: 'parent-snapshot',
                snapshotId: snapshotRes.snapshotId,
                parentSnapshot: snapshotRes.messages || [],
                model: descriptor.model || currentItem?.config?.model || null,
                open: true,
                status: 'ready',
                references: refs,
                rootTopicId,
                forkFromTopicId: descriptor.child.topicId,
                forkMessageId,
                forkLabel: label || null,
                branchTitle: title,
                depth
            }), composerStorage: 'local' };

            const saveRes = await saveSideChatMetadata({ electronAPI: chatAPI, metadata: childDescriptor });
            if (!saveRes?.ok) {
                await discardChild();
                throw new Error(saveRes?.message || saveRes?.error || '分支信息保存失败');
            }
            const tabHandle = await getController().openTab({ kind: 'chat', descriptor: childDescriptor });
            if (reference && tabHandle?.addReference) {
                tabHandle.addReference(reference);
            }
            return tabHandle;
        },

        async switchBranch(childTopicId, currentDescriptor = null) {
            if (!childTopicId) return null;
            const controller = getController();
            const state = controller.getSnapshot();
            const tab = state.tabs.find(t => t.kind === 'chat' && t.descriptor?.child?.topicId === childTopicId);
            if (tab) {
                controller.setVisible(true);
                if (state.activeTabId !== tab.id) controller.activateTab(tab.id);
                const handle = controller.getTabHandle(tab.id);
                handle?.focus?.();
                return handle || null;
            }

            // Tab 已被关闭或未打开：从同族元数据重新打开该分支
            const currentItem = selectedItemRef.get();
            const agentId = currentDescriptor?.parent?.itemId || currentDescriptor?.child?.itemId || currentItem?.id;
            const parentTopicId = currentDescriptor?.parent?.topicId || topicIdRef.get();
            if (!agentId) return null;

            try {
                const listRes = await listSideChatsForParent({
                    electronAPI: chatAPI,
                    agentId,
                    parentTopicId
                });
                const meta = listRes?.items?.find(m => m?.child?.topicId === childTopicId);
                if (!meta) {
                    notify('找不到对应的分支会话，可能已被删除', 'warning');
                    return null;
                }
                const handle = await openSideChat(branchMetaToReopenArgs(meta));
                return handle || null;
            } catch (err) {
                console.warn('[SideChat] Failed to switch to branch by reopening:', err);
                return null;
            }
        },

        async renameBranch({ childTopicId, newTitle, currentDescriptor = null }) {
            const trimmed = String(newTitle || '').trim();
            if (!trimmed) throw new Error('分支名称不能为空');
            const currentItem = selectedItemRef.get();
            const agentId = currentDescriptor?.parent?.itemId || currentDescriptor?.child?.itemId || currentItem?.id;
            if (!agentId) throw new Error('缺少 agentId');

            const res = await updateSideChatBranch({
                electronAPI: chatAPI,
                agentId,
                childTopicId,
                patch: { branchTitle: trimmed, title: trimmed }
            });
            if (!res?.ok) throw new Error(res.message || '重命名失败');

            // 如果当前 Tab 存在，同步更新 Tab 标题
            const controller = getController();
            const state = controller.getSnapshot();
            const tab = state.tabs.find(t => t.kind === 'chat' && t.descriptor?.child?.topicId === childTopicId);
            if (tab && typeof controller.updateTab === 'function') {
                const updatedDesc = {
                    ...tab.descriptor,
                    title: trimmed,
                    branchTitle: trimmed
                };
                controller.updateTab(tab.id, { title: trimmed, descriptor: updatedDesc });
            }
            return res.metadata;
        },

        async deleteBranch({ childTopicId, currentDescriptor = null }) {
            const currentItem = selectedItemRef.get();
            const agentId = currentDescriptor?.parent?.itemId || currentDescriptor?.child?.itemId || currentItem?.id;
            if (!agentId) throw new Error('缺少 agentId');

            // 先记录被删分支的父级，用于删除后返航
            let deletedParentTopicId = null;
            try {
                const listRes = await listSideChatsForParent({
                    electronAPI: chatAPI,
                    agentId,
                    parentTopicId: currentDescriptor?.parent?.topicId || topicIdRef.get()
                });
                const meta = listRes?.items?.find(m => m?.child?.topicId === childTopicId);
                deletedParentTopicId = meta?.forkFromTopicId || null;
            } catch (err) { void err; }

            const res = await chatAPI.deleteSideChatChild(agentId, childTopicId);
            if (!res?.success) throw new Error(res.error || '删除失败');

            const controller = getController();
            const state = controller.getSnapshot();
            const tab = state.tabs.find(t => t.kind === 'chat' && t.descriptor?.child?.topicId === childTopicId);
            const isDeletingCurrentBranch = currentDescriptor?.child?.topicId === childTopicId;

            if (tab) {
                await controller.closeTab(tab.id);
            }
            // 只有删除的是「当前正在查看的分支」时才返航其父分支；删除别的分支不打扰当前视图
            if (isDeletingCurrentBranch && deletedParentTopicId) {
                await this.switchBranch(deletedParentTopicId, currentDescriptor);
            }
            return { success: true };
        },

        async setCrystallized(descriptor, childTopicId, value) {
            const agentId = descriptor?.parent?.itemId;
            if (!agentId) throw new Error('缺少 agentId');
            const res = await updateSideChatBranch({ electronAPI: chatAPI, agentId, childTopicId, patch: { crystallized: Boolean(value) } });
            if (!res?.ok) throw new Error(res.message || '结晶状态更新失败');
            return res.metadata;
        },

        async promptTitle(defaultLabel, hint = '') {
            if (typeof uiHelper?.prompt === 'function') {
                const result = await uiHelper.prompt({
                    title: '为新分支命名',
                    description: `这个盲点想探究什么？${hint ? ` ${hint}` : '（将作为拓扑轨上的分支名）'}`,
                    placeholder: defaultLabel || '例如：阻抗匹配的微观机制',
                    defaultValue: defaultLabel || '',
                    confirmText: '开分支',
                    cancelText: '取消',
                    required: false
                });
                if (result?.cancelled || result?.canceled) return null;
                return String(result?.value ?? result?.text ?? '').trim();
            }
            return String(defaultLabel || '').trim();
        }
    };

    function branchLabelFallback(branchTitle, label) {
        if (branchTitle) return branchTitle;
        if (label) return label.length > 16 ? `${label.slice(0, 16)}…` : label;
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `分支 ${timeStr}`;
    }

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
            refreshParentSnapshot: (descriptor) => {
                // 分形分支：快照是分叉那一刻固化的「祖先链完整上下文」。
                // 不能在发送前重读主聊天当前历史，否则会覆盖掉祖先链、让孙分支丢根上下文。
                if (descriptor.forkFromTopicId) {
                    return Promise.resolve({
                        ok: true,
                        snapshotId: descriptor.snapshotId || null,
                        snapshotBoundary: descriptor.snapshotBoundary || null,
                        messages: Array.isArray(descriptor.parentSnapshot) ? descriptor.parentSnapshot : []
                    });
                }
                return createParentSnapshot({
                    electronAPI: chatAPI,
                    agentId: descriptor.parent.itemId,
                    parentTopicId: descriptor.parent.topicId,
                    childTopicId: descriptor.child.topicId,
                    fallbackHistory: []
                });
            },
            getCurrentTopic: () => topicIdRef.get() || null,
            getCurrentItem: () => selectedItemRef.get() || null,
            branchApi,
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
        // 引用由每个调用方在创建完成后各自加上：合并进来的第二次「在侧栏提问」不能把自己的引用丢掉
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
                    references: Array.isArray(input.references) ? input.references : [],
                    rootTopicId: item.rootTopicId,
                    forkFromTopicId: item.forkFromTopicId,
                    forkMessageId: item.forkMessageId,
                    forkLabel: item.forkLabel,
                    branchTitle: item.branchTitle,
                    depth: item.depth,
                    crystallized: item.crystallized
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
        // 分形树分支：仅关闭视图 Tab，不物理销毁子话题，随时可从脉络图重开
        if (descriptor?.forkFromTopicId || descriptor?.rootTopicId) {
            return { closed: true };
        }
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
        // 分形树分支：关闭 Tab 不物理删除分支子话题，保留在脉络图中随时可重新激活
        if (descriptor?.forkFromTopicId || descriptor?.rootTopicId) {
            return;
        }
        const result = await deleteSideChatChild({ electronAPI: chatAPI, agentId, childTopicId });
        if (result.ok) sideChatOwner.forgetDraft(descriptor);
        else console.warn('[SideChat] Failed to delete closed side chat:', result.message);
    }
    return Object.freeze({
        provider: sideChatOwner, openSideChat, restoreSessions, onTabClosed, requestTabClose,
        dispose() {
            doc.removeEventListener('click', onDeepLinkClick, true);
            sideChatOwner.dispose();
            if (win.openSideChatWithSelection === selectionEntry) {
                if (previousSelectionEntry) win.openSideChatWithSelection = previousSelectionEntry;
                else delete win.openSideChatWithSelection;
            }
        }
    });
}
