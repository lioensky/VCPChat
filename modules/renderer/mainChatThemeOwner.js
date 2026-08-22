const MODES = Object.freeze(['bubble', 'panel', 'immersive']);

/** Owns main-chat theme and presentation transitions, persistence and rollback. */
export function createMainChatThemeOwner({ settingsOwner, documentRef, presentationState, getUiManager, matchMedia, saveSettings, pretextBridge, refreshLayout, syncControls, captureAnchor, restoreAnchor, scheduleFrame, notify } = {}) {
    let disposed = false;
    const normalizePresentation = mode => MODES.includes(mode) ? mode : 'bubble';
    const applyInitialTheme = mode => {
        if (disposed) return;
        let theme = mode === 'light' || mode === 'dark' ? mode : null;
        if (!theme && typeof matchMedia === 'function') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        theme ||= 'light';
        const uiManager = getUiManager?.();
        if (uiManager?.applyTheme) uiManager.applyTheme(theme);
        else { documentRef.body.classList.remove('light-theme', 'dark-theme'); documentRef.body.classList.add(`${theme}-theme`); }
        presentationState?.set?.({ theme }); documentRef.body.removeAttribute('data-theme-pending');
    };
    const applyPresentation = async (mode, { persist = false, preserveScroll = true, notify: shouldNotify = false, source = 'unknown' } = {}) => {
        if (disposed) return { success: false, mode: normalizePresentation(settingsOwner.get().chatPresentationMode), error: new Error('Theme owner disposed') };
        const normalized = normalizePresentation(mode); const previous = normalizePresentation(settingsOwner.get().chatPresentationMode); const anchor = preserveScroll ? captureAnchor?.() : null;
        documentRef.body?.classList.remove(...MODES.map(value => `chat-presentation-${value}`)); documentRef.body?.classList.add(`chat-presentation-${normalized}`);
        settingsOwner.update('chatPresentationMode', normalized); syncControls?.(normalized);
        if (pretextBridge?.setPresentationMode) pretextBridge.setPresentationMode(normalized); else pretextBridge?.clearAll?.();
        refreshLayout?.();
        if (anchor) scheduleFrame?.(() => scheduleFrame?.(() => restoreAnchor?.(anchor)));
        if (!persist || normalized === previous) return { success: true, mode: normalized };
        try {
            const result = await saveSettings?.({ chatPresentationMode: normalized }); if (!result?.success) throw new Error(result?.error || '设置保存失败');
            if (shouldNotify) notify?.('聊天显示模式已切换。', 'success'); return { success: true, mode: normalized, source };
        } catch (error) {
            await applyPresentation(previous, { persist: false, preserveScroll: true, source: 'rollback' }); notify?.(`聊天显示模式保存失败：${error.message}`, 'error'); return { success: false, mode: previous, error };
        }
    };
    const dispose = () => { disposed = true; };
    return Object.freeze({ normalizePresentation, applyInitialTheme, applyPresentation, dispose });
}
