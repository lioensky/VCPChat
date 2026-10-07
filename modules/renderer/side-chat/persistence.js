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
    getSurface,
    saveDraft
}) {
    const disposeCleanups = [];
    const metadataErrorText = '信息未保存 · 点击重试';
    const draftErrorText = '草稿未保存 · 点击重试';
    let metadataSaveFailed = false;
    let fileMetadataFailed = false;
    let composerMigrated = descriptor.composerStorage === 'local';
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

    async function persistMetadata() {
        // 浏览器草稿写不进去（比如存储满了）也照常保存会话信息：换模型、刷新快照不能因此丢失
        let composerSaved = true;
        try {
            persistComposerInput();
        } catch (error) {
            composerSaved = false;
            console.warn('[SideChat] Failed to persist draft:', error);
        }
        const { draft, references, model, ...metadata } = store.currentDescriptor;
        // 浏览器里没存上时，输入继续留在文件里，不让迁移删掉唯一的一份
        const metaToPersist = composerSaved
            ? { ...metadata, composerStorage: 'local' }
            : { ...store.currentDescriptor, composerStorage: undefined };
        const save = chatCapabilities?.saveSideChatMetadata
            || chatCapabilities?.repository?.saveSideChatMetadata
            || globalThis.chatAPI?.saveSideChatMetadata;
        if (typeof save !== 'function') return null;
        try {
            const result = await save(metaToPersist);
            // The side session service reports failure as { ok: false }, not a rejected promise.
            if (result?.ok === false || result?.success === false || result?.error) {
                throw new Error(result.message || result.error || '保存辅助对话信息失败');
            }
            fileMetadataFailed = false;
            // 草稿这次没存上：保留"草稿未保存"的提示和重试，等草稿写成功再清
            if (!composerSaved) return result;
            composerMigrated = true;
            const wasFailed = metadataSaveFailed;
            metadataSaveFailed = false;
            if (wasFailed && !store.isDisposed) {
                statusText.removeAttribute('role');
                statusText.removeAttribute('tabindex');
            }
            if (wasFailed && !store.isDisposed && [metadataErrorText, draftErrorText].includes(statusText.textContent)) updateStatus('就绪');
            return result;
        } catch (error) {
            fileMetadataFailed = true;
            if (!store.isDisposed) {
                if (!metadataSaveFailed) chatCapabilities?.uiHelper?.showToastNotification?.('草稿已保留，对话信息未保存。点击底部提示重试。', 'error');
                metadataSaveFailed = true;
                updateStatus(metadataErrorText, 'error');
                statusText.setAttribute('role', 'button');
                statusText.tabIndex = 0;
            }
            throw error;
        }
    }

    let inputSaveTimer = null;

    function persistComposerInput() {
        store.currentDescriptor = {
            ...store.currentDescriptor,
            model: store.currentModel || null,
            draft: textarea.value,
            references: store.references.map(({ id, text, sourceMessageId }) => ({ id, text, sourceMessageId: sourceMessageId ?? null }))
        };
        const result = saveDraft(store.currentDescriptor, store.currentDescriptor);
        if (!result.ok) {
            if (!metadataSaveFailed) chatCapabilities?.uiHelper?.showToastNotification?.('草稿和设置未保存，当前输入已保留。点击底部提示重试。', 'error');
            metadataSaveFailed = true;
            updateStatus(draftErrorText, 'error');
            statusText.setAttribute('role', 'button');
            statusText.tabIndex = 0;
            throw result.error;
        }
        if (metadataSaveFailed && !fileMetadataFailed) {
            metadataSaveFailed = false;
            statusText.removeAttribute('role');
            statusText.removeAttribute('tabindex');
            if ([metadataErrorText, draftErrorText].includes(statusText.textContent)) updateStatus('就绪');
        }
        return result;
    }

    async function saveComposerInput() {
        try {
            persistComposerInput();
            // Old file drafts are removed only after the browser write succeeds.
            if (!composerMigrated) await persistMetadata();
        } catch (error) {
            console.warn('[SideChat] Failed to persist draft:', error);
        }
    }

    function scheduleInputSave() {
        if (store.isDisposed) return;
        clearTimeout(inputSaveTimer);
        inputSaveTimer = setTimeout(() => {
            inputSaveTimer = null;
            if (!store.isDisposed) saveComposerInput();
        }, 400);
    }

    function flushInputSave() {
        if (inputSaveTimer === null) return;
        clearTimeout(inputSaveTimer);
        inputSaveTimer = null;
        return saveComposerInput();
    }

    textarea.addEventListener('input', scheduleInputSave);

    const win = doc.defaultView;

    win?.addEventListener?.('pagehide', flushInputSave);
    win?.addEventListener?.('blur', flushInputSave);

    disposeCleanups.push(() => {
        textarea.removeEventListener('input', scheduleInputSave);
        win?.removeEventListener?.('pagehide', flushInputSave);
        win?.removeEventListener?.('blur', flushInputSave);
    });

    async function retryPersistence() {
        if (!store.hasUnsavedChanges) return { ok: true, message: '无未保存的历史' };
        if (store.isDeletingMessage || store.isSavingMessageEdit) {
            const error = store.isSavingMessageEdit ? '正在保存编辑，请稍后重试。' : '正在保存删除，请稍后重试。';
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
        updateEmptyState({ historyPending: true });
        try {
            const res = await getSurface().loadHistory(
                descriptor.child.itemId,
                'agent',
                descriptor.child.topicId,
                { initialBatch: 5, batchSize: 10, batchDelay: 80 }
            );
            if (store.isDisposed) return res;
            store.isHistoryLoaded = true;
            if (!metadataSaveFailed) {
                statusText.removeAttribute('tabindex');
                statusText.removeAttribute('role');
            }
            textarea.disabled = false;
            updateComposerState();
            updateEmptyState();
            updateStatus('就绪');
            return res;
        } catch (err) {
            if (store.isDisposed) return;
            store.isHistoryLoaded = false;
            updateStatus(`加载历史失败：${err.message}（点击重试）`, 'error');
            // 键盘也能重试：状态文字这时当按钮用
            statusText.tabIndex = 0;
            statusText.setAttribute('role', 'button');
            throw err;
        }
    }

    statusText.addEventListener('click', () => {
        if (metadataSaveFailed && !store.isDisposed) {
            saveComposerInput();
            return;
        }
        if (!store.isHistoryLoaded && !store.isDisposed) {
            loadHistoryFn().catch(() => {});
        }
    });

    const onStatusKeydown = (event) => {
        if ((metadataSaveFailed || !store.isHistoryLoaded) && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            statusText.click();
        }
    };
    statusText.addEventListener('keydown', onStatusKeydown);
    disposeCleanups.push(() => statusText.removeEventListener('keydown', onStatusKeydown));

    return Object.freeze({ needsSnapshotRefresh, refreshSnapshot, persistMetadata, saveComposerInput, scheduleInputSave, flushInputSave, retryPersistence, discardUnsaved, loadHistoryFn, dispose() { flushInputSave(); disposeCleanups.splice(0).forEach(fn => { try { fn(); } catch {} }); } });
}
