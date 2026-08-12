(() => {
    const api = () => window.chatAPI || window.electronAPI;
    let maximized = false;

    function syncMaximizeControl() {
        const button = document.getElementById('nextUiMaximizeBtn');
        const icon = button?.querySelector('.vcp-ui-icon');
        const label = maximized ? '还原窗口' : '最大化窗口';
        if (icon) {
            if (window.VCPIcons?.set) window.VCPIcons.set(icon, maximized ? 'filter_none' : 'crop_square');
            else icon.textContent = maximized ? 'filter_none' : 'crop_square';
        }
        button?.setAttribute('title', label);
        button?.setAttribute('aria-label', label);
        button?.setAttribute('aria-pressed', String(maximized));
    }

    api()?.onWindowMaximized?.(() => {
        maximized = true;
        syncMaximizeControl();
    });
    api()?.onWindowUnmaximized?.(() => {
        maximized = false;
        syncMaximizeControl();
    });
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', syncMaximizeControl, { once: true });
    } else {
        syncMaximizeControl();
    }

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
        try {
            await api().openForumWindow();
            return { success: true };
        } catch (error) {
            notify(`打开论坛失败: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    async function openMemo() {
        if (!api()?.openMemoWindow) {
            notify('无法打开 VCPMemo 中心：功能不可用。');
            return { success: false, error: 'openMemoWindow unavailable' };
        }
        try {
            await api().openMemoWindow();
            return { success: true };
        } catch (error) {
            notify(`打开 VCPMemo 中心失败: ${error.message}`);
            return { success: false, error: error.message };
        }
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

    async function createAgent({ name, model = '' }) {
        const result = await api()?.createAgent?.(name, model ? { model } : undefined);
        if (!result?.success) return result || { success: false, error: '创建功能不可用' };
        try {
            await window.itemListManager?.loadItems?.();
            await window.chatManager?.selectItem?.(result.agentId, 'agent', result.agentName, null, result.config);
            window.uiManager?.switchToTab?.('settings');
            return { ...result, navigationSuccess: true };
        } catch (error) {
            console.error('[MainChatCommands] Agent created but UI navigation failed:', error);
            notify(`助手已创建，但界面刷新失败：${error.message}`, 'warning');
            return { ...result, navigationSuccess: false, warning: error.message };
        }
    }

    async function createGroup({ name, model = '' }) {
        const initialConfig = model ? { useUnifiedModel: true, unifiedModel: model } : undefined;
        const result = await api()?.createAgentGroup?.(name, initialConfig);
        if (!result?.success) return result || { success: false, error: '创建功能不可用' };
        const group = result.agentGroup;
        if (!group?.id) return { success: false, error: '群组已创建，但返回数据不完整。' };
        try {
            await window.itemListManager?.loadItems?.();
            await window.chatManager?.selectItem?.(group.id, 'group', group.name, group.avatarUrl, group);
            window.uiManager?.switchToTab?.('settings');
            return { ...result, navigationSuccess: true };
        } catch (error) {
            console.error('[MainChatCommands] Group created but UI navigation failed:', error);
            notify(`群组已创建，但界面刷新失败：${error.message}`, 'warning');
            return { ...result, navigationSuccess: false, warning: error.message };
        }
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
