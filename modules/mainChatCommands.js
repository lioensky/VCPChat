(() => {
    const api = () => window.chatAPI || window.electronAPI;
    let maximized = false;

    api()?.onWindowMaximized?.(() => { maximized = true; });
    api()?.onWindowUnmaximized?.(() => { maximized = false; });

    function minimize() {
        api()?.minimizeWindow?.();
    }

    function toggleMaximize() {
        if (maximized) api()?.unmaximizeWindow?.();
        else api()?.maximizeWindow?.();
    }

    function close() {
        api()?.closeWindow?.();
    }

    function openSettings() {
        window.uiHelperFunctions?.openModal?.('globalSettingsModal');
    }

    function openThemes() {
        api()?.openThemesWindow?.();
    }

    function toggleTheme() {
        const nextTheme = document.body.classList.contains('dark-theme') ? 'light' : 'dark';
        if (!window.VCPAppearanceStudio?.setThemeMode?.(nextTheme, { source: 'main-chat-command' })) {
            api()?.setTheme?.(nextTheme);
        }
    }

    function createItem() {
        return window.topTabManager?.openCreateDialog?.();
    }

    window.MainChatCommands = Object.freeze({
        minimize,
        toggleMaximize,
        close,
        openSettings,
        openThemes,
        toggleTheme,
        createItem,
    });
})();
