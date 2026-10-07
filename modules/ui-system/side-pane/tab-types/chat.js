/* 辅助对话标签类型：描述符校验、描述符到标签的映射、provider 适配。控制器不认识辅助对话，全靠这里的钩子。 */

export const SIDE_CHAT_DESCRIPTOR_VERSION = 1;

export function freezeSideChatDescriptor(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') {
        throw new TypeError('SideChatDescriptor must be an object');
    }
    if (!descriptor.id || typeof descriptor.id !== 'string') {
        throw new TypeError('SideChatDescriptor requires a string id');
    }
    if (!descriptor.parent || typeof descriptor.parent !== 'object') {
        throw new TypeError('SideChatDescriptor requires a parent conversation reference');
    }
    if (!descriptor.child || typeof descriptor.child !== 'object') {
        throw new TypeError('SideChatDescriptor requires a child conversation reference');
    }
    if (descriptor.parent.topicId === descriptor.child.topicId) {
        throw new Error('Child topicId must differ from parent topicId');
    }

    return Object.freeze({
        schemaVersion: SIDE_CHAT_DESCRIPTOR_VERSION,
        id: descriptor.id,
        parent: Object.freeze({
            itemType: descriptor.parent.itemType || 'agent',
            itemId: String(descriptor.parent.itemId || ''),
            topicId: String(descriptor.parent.topicId || '')
        }),
        child: Object.freeze({
            itemType: descriptor.child.itemType || 'agent',
            itemId: String(descriptor.child.itemId || ''),
            topicId: String(descriptor.child.topicId || '')
        }),
        title: String(descriptor.title || '辅助对话'),
        createdAt: Number.isFinite(descriptor.createdAt) ? descriptor.createdAt : Date.now(),
        contextMode: descriptor.contextMode === 'parent-snapshot' ? 'parent-snapshot' : 'references-only',
        snapshotId: descriptor.snapshotId ? String(descriptor.snapshotId) : undefined,
        model: descriptor.model ? String(descriptor.model) : undefined,
        composerStorage: descriptor.composerStorage === 'local' ? 'local' : undefined,
        draft: typeof descriptor.draft === 'string' ? descriptor.draft : '',
        references: Array.isArray(descriptor.references) ? descriptor.references : [],
        parentSnapshot: Array.isArray(descriptor.parentSnapshot) ? descriptor.parentSnapshot : []
    });
}

/**
 * 把辅助对话描述符变成一个标签。同一个子话题已经有标签时沿用那个标签的 id，
 * 所以重复打开（包括并发打开）只会落到同一个标签上。
 */
export function sideChatTab(rawDescriptor, tabs = []) {
    const descriptor = freezeSideChatDescriptor(rawDescriptor);
    const existing = tabs.find(tab => tab.id === descriptor.id || (
        tab.kind === 'chat' && tab.descriptor?.child?.topicId === descriptor.child.topicId
    ));
    return {
        id: existing ? existing.id : descriptor.id,
        kind: 'chat',
        type: 'selection-side-chat',
        // 临时标签：关掉就删子话题，不进"最近关闭"，也不随布局持久化（由会话服务恢复）
        ephemeral: true,
        title: descriptor.title,
        icon: 'chat_bubble',
        closable: true,
        scopeMode: 'topic',
        parent: descriptor.parent,
        descriptor
    };
}

/**
 * @returns {import('../side-pane-types.js').SidePaneTabType}
 * provider：mountTab(descriptor, view, ctx)，返回辅助对话 handle；ctx 原样转交控制器给的挂载上下文（含 view scope）。
 * openSideChat：新标签页入口；不传时不出现在新标签页里。
 * onClosed(descriptor)：标签关掉后调用，用来删掉子话题。
 * requestClose(descriptor)：还没挂载的标签关闭前确认（挂着的由 handle.requestClose 确认），返回 { closed: false } 取消。
 * canOpen()：当前能不能新开辅助对话（群聊里不能）；返回 false 时新标签页里不列这个入口。
 */
export function defineChatTabType({ provider, openSideChat = null, onClosed = null, requestClose = null, canOpen = null }) {
    return Object.freeze({
        kind: 'chat', label: '辅助对话', icon: 'chat_bubble', searchHint: '辅助对话',
        persist: false,
        // 输入框里可能有还没发出去的内容，隐藏再久也不休眠
        dormancy: 'keep',
        entry: typeof openSideChat === 'function'
            ? {
                id: 'selection-side-conversation', order: 0, open: () => openSideChat({ forceNew: true }),
                ...(typeof canOpen === 'function' ? { isAvailable: canOpen } : {})
            }
            : null,
        // openTab({ kind: 'chat', descriptor }) 走这里
        toTab: (payload, tabs) => sideChatTab(payload.descriptor, tabs),
        provider: provider ? {
            mountTab: (payload, view, ctx) => provider.mountTab(payload.descriptor, view, ctx)
        } : null,
        onClosed: typeof onClosed === 'function' ? tab => onClosed({ ...tab.descriptor }) : null,
        requestClose: typeof requestClose === 'function' ? tab => requestClose({ ...tab.descriptor }) : null
    });
}
