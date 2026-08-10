(() => {
    const api = () => window.chatAPI || window.electronAPI;
    let maximized = false;

    api()?.onWindowMaximized?.(() => { maximized = true; });
    api()?.onWindowUnmaximized?.(() => { maximized = false; });

    function minimize() {
        api()?.minimizeWindow?.();
    }

    function minimizeToTray() {
        api()?.minimizeToTray?.();
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

    function notify(message, type = 'error') {
        window.uiHelperFunctions?.showToastNotification?.(message, type);
    }

    async function openForum() {
        if (!api()?.openForumWindow) {
            notify('无法打开论坛：功能不可用。');
            return { success: false, error: 'openForumWindow unavailable' };
        }
        await api().openForumWindow();
        return { success: true };
    }

    async function openMemo() {
        if (!api()?.openMemoWindow) {
            notify('无法打开 VCPMemo 中心：功能不可用。');
            return { success: false, error: 'openMemoWindow unavailable' };
        }
        await api().openMemoWindow();
        return { success: true };
    }

    function toggleNotificationFilter() {
        return window.filterManager?.toggleFilterMode?.();
    }

    function openNotificationFilterSettings() {
        return window.filterManager?.openFilterRulesModal?.();
    }

    function clearNotifications() {
        const notificationsList = document.getElementById('notificationsList');
        if (!notificationsList) return { success: false, removed: 0 };
        let removed = 0;
        notificationsList.querySelectorAll('.notification-item').forEach(item => {
            if (item.dataset.protectedNotification === 'tool-approval') return;
            item.remove();
            removed += 1;
        });
        return { success: true, removed };
    }

    function createAgentConfig(name, model) {
        return {
            systemPrompt: `你是 ${name}。`,
            model,
            temperature: 0.7,
            contextTokenLimit: 1000000,
            maxOutputTokens: 60000,
            topics: [{ id: 'default', name: '主要对话', createdAt: Date.now() }],
            disableCustomColors: true,
            useThemeColorsInChat: true,
        };
    }

    async function createAgent({ name, model = '' }) {
        const result = await api()?.createAgent?.(name, model ? createAgentConfig(name, model) : undefined);
        if (!result?.success) return result || { success: false, error: '创建功能不可用' };
        await window.itemListManager?.loadItems?.();
        await window.chatManager?.selectItem?.(result.agentId, 'agent', result.agentName, null, result.config);
        window.uiManager?.switchToTab?.('settings');
        return result;
    }

    async function createGroup({ name, model = '' }) {
        const initialConfig = model ? { useUnifiedModel: true, unifiedModel: model } : undefined;
        const result = await api()?.createAgentGroup?.(name, initialConfig);
        if (!result?.success) return result || { success: false, error: '创建功能不可用' };
        const group = result.agentGroup;
        if (!group?.id) return { success: false, error: '群组已创建，但返回数据不完整。' };
        await window.itemListManager?.loadItems?.();
        await window.chatManager?.selectItem?.(group.id, 'group', group.name, group.avatarUrl, group);
        window.uiManager?.switchToTab?.('settings');
        return result;
    }

    window.MainChatCommands = Object.freeze({
        minimize,
        minimizeToTray,
        toggleMaximize,
        close,
        openSettings,
        openThemes,
        toggleTheme,
        createItem,
        openForum,
        openMemo,
        toggleNotificationFilter,
        openNotificationFilterSettings,
        clearNotifications,
        createAgent,
        createGroup,
    });
})();
