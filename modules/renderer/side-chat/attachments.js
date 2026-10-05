/* side-chat/attachments.js
 * Attachments and emoticons for the side chat composer. Files are picked through
 * the same IPC as the main composer and stored under the side topic.
 */
'use strict';

export function createSideChatAttachments({
    chatCapabilities,
    descriptor,
    attachBtn,
    emoticonBtn,
    previewArea,
    textarea,
    getWindow,
    onChange
}) {
    let files = [];
    let disposed = false;
    const chatAPI = chatCapabilities?.electronAPI;
    const uiHelper = chatCapabilities?.uiHelper;

    function render() {
        if (disposed || !previewArea) return;
        if (typeof uiHelper?.updateAttachmentPreview === 'function') {
            uiHelper.updateAttachmentPreview(files, previewArea, removeAt);
        }
        previewArea.hidden = files.length === 0;
        onChange?.();
    }

    function removeAt(index) {
        if (index < 0 || index >= files.length) return false;
        files = files.filter((_, i) => i !== index);
        render();
        return true;
    }

    async function pick() {
        if (disposed || attachBtn.disabled) return;
        if (typeof chatAPI?.selectFilesToSend !== 'function') {
            uiHelper?.showToastNotification?.('当前环境不支持添加附件', 'warning');
            return;
        }
        let result;
        try {
            result = await chatAPI.selectFilesToSend(descriptor.child.itemId, descriptor.child.topicId);
        } catch (error) {
            uiHelper?.showToastNotification?.(`选择文件时出错: ${error?.message || error}`, 'error');
            return;
        }
        if (disposed) return;
        if (result?.success && Array.isArray(result.attachments) && result.attachments.length > 0) {
            const added = [];
            for (const att of result.attachments) {
                if (att.error) {
                    uiHelper?.showToastNotification?.(`处理文件 ${att.name || '未知文件'} 失败: ${att.error}`, 'error');
                    continue;
                }
                added.push({
                    file: { name: att.name, type: att.type, size: att.size },
                    localPath: att.internalPath,
                    originalName: att.name,
                    _fileManagerData: att
                });
            }
            if (added.length > 0) {
                files = [...files, ...added];
                render();
            }
        } else if (result?.error) {
            uiHelper?.showToastNotification?.(`选择文件时出错: ${result.error}`, 'error');
        }
    }

    function toggleEmoticons(event) {
        event?.stopPropagation?.();
        const manager = getWindow?.()?.emoticonManager;
        if (typeof manager?.togglePanel !== 'function') {
            uiHelper?.showToastNotification?.('表情包尚未就绪', 'warning');
            return;
        }
        manager.togglePanel(emoticonBtn, textarea);
    }

    attachBtn?.addEventListener('click', pick);
    emoticonBtn?.addEventListener('click', toggleEmoticons);

    return Object.freeze({
        get count() { return files.length; },
        /** Hands the current files to a send and clears the composer. */
        take() {
            const taken = files;
            files = [];
            render();
            return taken;
        },
        /** Puts files back after a send was retracted, ahead of any picked since. */
        restore(taken) {
            if (disposed || !Array.isArray(taken) || taken.length === 0) return;
            files = [...taken, ...files.filter(f => !taken.includes(f))];
            render();
        },
        setDisabled(disabled) {
            if (attachBtn) attachBtn.disabled = Boolean(disabled);
            if (emoticonBtn) emoticonBtn.disabled = Boolean(disabled);
        },
        dispose() {
            disposed = true;
            attachBtn?.removeEventListener('click', pick);
            emoticonBtn?.removeEventListener('click', toggleEmoticons);
            files = [];
        }
    });
}
