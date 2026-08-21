(function exposeAvatarPicker(global) {
    const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
    let sequence = 0;

    function bindInput({ input, preview, onCommit, cropType = 'agent', onBusyChange, onError }) {
        if (!input || !preview || typeof onCommit !== 'function') throw new TypeError('AvatarPicker requires input, preview and onCommit.');
        input.accept = ACCEPT;
        let previewUrl = null;
        let disposed = false;
        const onChange = () => {
            const file = input.files?.[0];
            if (!file || disposed) return;
            const helper = global.uiHelperFunctions;
            if (!helper?.openAvatarCropper) {
                onError?.(new Error('共享头像裁剪器尚未就绪。'));
                return;
            }
            onBusyChange?.(true);
            helper.openAvatarCropper(file, async (croppedFile) => {
                try {
                    if (disposed) return;
                    if (previewUrl) global.URL.revokeObjectURL(previewUrl);
                    previewUrl = global.URL.createObjectURL(croppedFile);
                    preview.src = previewUrl;
                    preview.hidden = false;
                    preview.closest('.agent-avatar-wrapper')?.classList.remove('no-avatar');
                    await onCommit(croppedFile, previewUrl);
                } catch (error) {
                    onError?.(error);
                } finally {
                    input.value = '';
                    onBusyChange?.(false);
                }
            }, cropType);
        };
        input.addEventListener('change', onChange);
        return { destroy() { disposed = true; input.removeEventListener('change', onChange); if (previewUrl) global.URL.revokeObjectURL(previewUrl); } };
    }

    function create({ src, alt = '头像预览', disabled = false, onCommit, onBusyChange, onError }) {
        const wrapper = document.createElement('div');
        wrapper.className = 'agent-avatar-wrapper vcp-avatar-picker';
        const preview = document.createElement('img');
        preview.className = 'agent-avatar-display';
        preview.src = src || 'assets/default_avatar.png';
        preview.alt = alt;
        preview.width = 76;
        preview.height = 76;
        preview.onerror = () => { preview.src = 'assets/default_avatar.png'; };
        const input = document.createElement('input');
        input.type = 'file'; input.id = `vcpAvatarPickerInput-${++sequence}`; input.hidden = true; input.disabled = disabled;
        input.setAttribute('aria-label', '选择 Agent 头像');
        const overlay = document.createElement('label');
        overlay.className = 'avatar-upload-overlay'; overlay.htmlFor = input.id; overlay.setAttribute('aria-label', '选择并裁剪 Agent 头像');
        overlay.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>';
        wrapper.append(preview, overlay, input);
        const controller = bindInput({ input, preview, onCommit, onBusyChange, onError });
        return { element: wrapper, input, preview, destroy: controller.destroy };
    }

    global.VCPAvatarPicker = Object.freeze({ ACCEPT, bindInput, create });
})(window);
