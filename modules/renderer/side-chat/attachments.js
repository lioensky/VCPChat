/* side-chat/attachments.js
 * Attachments and emoticons for the side chat composer. Files are picked, pasted or
 * dropped through the same IPC as the main composer and stored under the side topic.
 * Paste and drop follow ZCode's composer (handlePaste / handleDropComposer in
 * packages/ui/src/v4/ConversationComposer.tsx): files in the clipboard or the drop
 * become attachments, plain text keeps the default behaviour.
 */
'use strict';

export function createSideChatAttachments({
    chatCapabilities,
    descriptor,
    attachBtn,
    emoticonBtn,
    previewArea,
    textarea,
    dropTarget,
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
            accept(result.attachments);
        } else if (result?.error) {
            uiHelper?.showToastNotification?.(`选择文件时出错: ${result.error}`, 'error');
        }
    }

    function accept(stored) {
        const added = [];
        for (const att of stored) {
            if (!att || att.error) {
                uiHelper?.showToastNotification?.(`处理文件 ${att?.name || '未知文件'} 失败: ${att?.error || '未知错误'}`, 'error');
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
    }

    // 粘贴截图、拖进文件：和主输入框走同一个 handle-file-drop 通道，存到辅助话题下
    async function addFiles(list) {
        if (typeof chatAPI?.handleFileDrop !== 'function') {
            uiHelper?.showToastNotification?.('当前环境不支持添加附件', 'warning');
            return;
        }
        const { itemId, topicId } = descriptor.child;
        try {
            const payload = await Promise.all(list.map(async file => ({
                name: file.name || 'image.png',
                type: file.type || 'application/octet-stream',
                data: new Uint8Array(await file.arrayBuffer()),
                size: file.size
            })));
            if (disposed) return;
            const results = await chatAPI.handleFileDrop(itemId, topicId, payload);
            if (disposed) return;
            accept((Array.isArray(results) ? results : []).map((result, i) => result?.success && result.attachment
                ? result.attachment : { name: payload[i]?.name, error: result?.error || '未知错误' }));
        } catch (error) {
            if (!disposed) uiHelper?.showToastNotification?.(`添加附件时出错: ${error?.message || error}`, 'error');
        }
    }

    // 剪贴板里是截图位图、拿不到 File 时（部分系统的截图工具），和主输入框一样再从系统剪贴板读一次
    async function addClipboardImage() {
        if (typeof chatAPI?.readImageFromClipboard !== 'function' || typeof chatAPI?.handleFilePaste !== 'function') return;
        const { itemId, topicId } = descriptor.child;
        try {
            const image = await chatAPI.readImageFromClipboard();
            if (disposed || !image?.data) return;
            const result = await chatAPI.handleFilePaste(itemId, topicId, { type: 'base64', data: image.data, extension: image.extension || 'png' });
            if (disposed) return;
            accept([result?.success && result.attachment ? result.attachment : { name: '截图', error: result?.error || '截图处理失败' }]);
        } catch (error) {
            if (!disposed) uiHelper?.showToastNotification?.(`粘贴截图时出错: ${error?.message || error}`, 'error');
        }
    }

    function onPaste(event) {
        const items = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file');
        if (disposed || items.length === 0) return;
        event.preventDefault();
        if (attachBtn?.disabled) return;
        const pasted = items.map(item => item.getAsFile()).filter(Boolean);
        if (pasted.length > 0) addFiles(pasted);
        else addClipboardImage();
    }

    const carriesFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
    function onDragOver(event) {
        if (disposed || !carriesFiles(event)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = attachBtn?.disabled ? 'none' : 'copy';
    }
    function onDrop(event) {
        if (disposed || !carriesFiles(event)) return;
        event.preventDefault();
        if (attachBtn?.disabled) return;
        const dropped = [...(event.dataTransfer?.files || [])];
        if (dropped.length > 0) addFiles(dropped);
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
    textarea?.addEventListener('paste', onPaste);
    dropTarget?.addEventListener('dragover', onDragOver);
    dropTarget?.addEventListener('drop', onDrop);

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
            textarea?.removeEventListener('paste', onPaste);
            dropTarget?.removeEventListener('dragover', onDragOver);
            dropTarget?.removeEventListener('drop', onDrop);
            files = [];
        }
    });
}
