const identity = value => JSON.stringify([value.itemType, value.itemId, value.topicId]);
export function createNativeHistoryRefresh({ getSelection, getTopicId, syncHistory, hasActiveStream = () => false, isEditing = () => false, reportError = console.error, retryMs = 50 }) {
    const pending = new Map(), saving = new Map(), unsaved = new Set();
    let disposed = false, running = false, timer = null;
    const current = () => { const s = getSelection(); return { itemId: s?.id, itemType: s?.type, topicId: getTopicId() }; };
    const schedule = () => {
        if (disposed || timer || !pending.size) return;
        timer = setTimeout(() => { timer = null; void drain(); }, retryMs);
    };
    async function drain() {
        if (disposed || running) return;
        running = true;
        try {
            for (const [key, change] of pending) {
                if (key !== identity(current())) { pending.delete(key); continue; }
                if (saving.get(key) || unsaved.has(key) || hasActiveStream(change) || isEditing()) continue;
                pending.delete(key);
                const allowed = () => !disposed && key === identity(current()) && !saving.get(key) && !unsaved.has(key) && !hasActiveStream(change) && !isEditing();
                try {
                    await syncHistory(change.itemId, change.itemType, change.topicId, allowed);
                    if (!allowed() && !disposed && key === identity(current())) pending.set(key, change);
                }
                catch (error) { pending.set(key, change); reportError('[NativeSync] history refresh failed', error); }
            }
        } finally { running = false; schedule(); }
    }
    return Object.freeze({
        consume(event) {
            if (disposed) return;
            const selected = current();
            const change = { itemId: event.ownerId || event.agentId, itemType: event.ownerType || selected.itemType, topicId: event.topicId };
            if (identity(change) !== identity(selected)) return;
            pending.set(identity(change), change);
            void drain();
        },
        beginPersistence(context) {
            const d = { itemId: context.groupId || context.agentId, itemType: context.isGroupMessage ? 'group' : 'agent', topicId: context.topicId };
            const key = identity(d);
            saving.set(key, (saving.get(key) || 0) + 1);
            let released = false;
            return success => {
                if (released) return; released = true;
                const count = (saving.get(key) || 1) - 1;
                if (count) saving.set(key, count); else saving.delete(key);
                if (success) unsaved.delete(key); else unsaved.add(key);
                void drain();
            };
        },
        drain,
        diagnostics: () => ({ pending: pending.size, saving: saving.size, unsaved: unsaved.size }),
        dispose() { disposed = true; clearTimeout(timer); timer = null; pending.clear(); saving.clear(); unsaved.clear(); },
    });
}
