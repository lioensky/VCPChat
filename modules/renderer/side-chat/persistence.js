/* side-chat/persistence.js
 * Owns side-chat metadata, composer drafts, history loading and save retries.
 * The mounted conversation is the source for edits made after a failed save.
 */
'use strict';

export function createSideChatPersistence({
    store,
    chatCapabilities,
    descriptor,
    doc,
    persistenceBadge,
    repository,
    statusText,
    textarea,
    updateComposerState,
    updateEmptyState,
    updateStatus,
    getConversation,
    getSurface
}) {
    const disposeCleanups = [];
    function needsSnapshotRefresh() {
        return store.currentDescriptor.contextMode === 'parent-snapshot'
            && typeof chatCapabilities?.refreshParentSnapshot === 'function'
            && (getConversation()?.historyRef?.get?.() || []).length === 0;
    }

    async function refreshSnapshot() {
        try {
            const res = await chatCapabilities.refreshParentSnapshot(store.currentDescriptor);
            if (!res?.ok || store.isDisposed) return;
            store.snapshotMessages = Array.isArray(res.messages) ? [...res.messages] : [];
            store.currentDescriptor = { ...store.currentDescriptor, snapshotId: res.snapshotId || store.currentDescriptor.snapshotId, parentSnapshot: store.snapshotMessages };
            persistMetadata().catch(e => console.warn('[SideChat] Failed to persist refreshed snapshot:', e));
        } catch (error) {
            console.warn('[SideChat] Failed to refresh parent snapshot; keeping the existing one:', error);
        }
    }

    function persistMetadata() {
        const metaToPersist = { ...store.currentDescriptor, model: store.currentModel || null };
        const save = chatCapabilities?.saveSideChatMetadata
            || chatCapabilities?.repository?.saveSideChatMetadata
            || globalThis.chatAPI?.saveSideChatMetadata;
        return typeof save === 'function' ? Promise.resolve(save(metaToPersist)) : Promise.resolve(null);
    }

    let inputSaveTimer = null;

    function persistComposerInput() {
        store.currentDescriptor = {
            ...store.currentDescriptor,
            draft: textarea.value,
            references: store.references.map(({ id, text, sourceMessageId }) => ({ id, text, sourceMessageId: sourceMessageId ?? null }))
        };
        persistMetadata().catch(e => console.warn('[SideChat] Failed to persist draft:', e));
    }

    function scheduleInputSave() {
        if (store.isDisposed) return;
        clearTimeout(inputSaveTimer);
        inputSaveTimer = setTimeout(() => {
            inputSaveTimer = null;
            if (!store.isDisposed) persistComposerInput();
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

    async function retryPersistence() {
        if (!store.hasUnsavedChanges) return { ok: true, message: '无未保存的历史' };
        if (store.isDeletingMessage) {
            const error = '正在保存删除，请稍后重试。';
            updateStatus(error, 'error');
            return { ok: false, error };
        }
        updateStatus('正在重试保存...');
        try {
            // The side conversation remains editable after a failed save. Its
            // live history owns later edits/deletions, including deletion of all
            // messages; the failure snapshot is only a fallback without a view.
            const liveHistory = getConversation()?.historyRef?.get?.();
            let targetHistory = Array.isArray(liveHistory) ? liveHistory : store.pendingSaveHistory;
            if (!Array.isArray(targetHistory)) {
                const histRes = await repository.getHistory(descriptor.child.itemId, 'agent', descriptor.child.topicId);
                targetHistory = Array.isArray(histRes) ? histRes : histRes?.history;
                if (!Array.isArray(targetHistory)) throw new Error(histRes?.error || '读取辅助对话历史失败');
            }
            const saveRes = await repository.saveHistory(
                descriptor.child.itemId,
                'agent',
                descriptor.child.topicId,
                targetHistory
            );
            if (!(saveRes && (saveRes.success === false || saveRes.error))) {
                store.hasUnsavedChanges = false;
                store.pendingSaveHistory = null;
                store.lastPersistenceError = null;
                if (getConversation()?.historyRef?.set) {
                    getConversation().historyRef.set(targetHistory);
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
        store.hasUnsavedChanges = false;
        store.pendingSaveHistory = null;
        store.lastPersistenceError = null;
        persistenceBadge.hidden = true;
        updateStatus('就绪');
    }

    async function loadHistoryFn() {
        updateStatus('正在加载历史...');
        try {
            const res = await getSurface().loadHistory(
                descriptor.child.itemId,
                'agent',
                descriptor.child.topicId,
                { initialBatch: 5, batchSize: 10, batchDelay: 80 }
            );
            if (store.isDisposed) return res;
            store.isHistoryLoaded = true;
            textarea.disabled = false;
            updateComposerState();
            updateEmptyState();
            updateStatus('就绪');
            return res;
        } catch (err) {
            if (store.isDisposed) return;
            store.isHistoryLoaded = false;
            updateStatus(`加载历史失败：${err.message} (点击重试)`, 'error');
            throw err;
        }
    }

    statusText.addEventListener('click', () => {
        if (!store.isHistoryLoaded && !store.isDisposed) {
            loadHistoryFn().catch(() => {});
        }
    });

    return Object.freeze({ needsSnapshotRefresh, refreshSnapshot, persistMetadata, scheduleInputSave, flushInputSave, retryPersistence, discardUnsaved, loadHistoryFn, dispose() { flushInputSave(); disposeCleanups.splice(0).forEach(fn => { try { fn(); } catch {} }); } });
}
