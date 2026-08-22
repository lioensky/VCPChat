(() => {
    let chatManagerProvider = null;
    let capabilities = Object.create(null);
    const api = () => window.chatAPI || window.electronAPI;
    const capability = (name, fallback) => capabilities[name] || fallback?.();
    const windowCommand = (name, fallback) => window.VCPWindowState?.[name]
        ? window.VCPWindowState[name]()
        : fallback?.();
    function minimize() {
        return windowCommand('minimize', () => api()?.minimizeWindow?.());
    }

    function minimizeToTray() {
        return windowCommand('minimizeToTray', () => api()?.minimizeToTray?.());
    }

    function toggleMaximize() {
        return window.VCPWindowState?.toggleMaximize?.();
    }

    function close() {
        return windowCommand('close', () => api()?.closeWindow?.());
    }

    function openSettings() {
        const open = () => capability('uiHelper', () => window.uiHelperFunctions)?.openModal?.('globalSettingsModal');
        return window.VCPPerformance?.measure
            ? window.VCPPerformance.measure('settings.open', open, { source: 'main-chat-command' })
            : open();
    }

    function openThemes() {
        api()?.openThemesWindow?.();
    }

    function toggleTheme() {
        const currentTheme = capability('uiManager', () => window.uiManager)?.getThemeState?.()?.effective || 'light';
        const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
        if (!capability('appearanceStudio', () => window.VCPAppearanceStudio)?.setThemeMode?.(nextTheme, { source: 'main-chat-command' })) {
            api()?.setTheme?.(nextTheme);
        }
    }

    function createItem() {
        return capability('topTabManager', () => window.topTabManager)?.openCreateDialog?.();
    }

    function notify(message, type = 'error') {
        capability('uiHelper', () => window.uiHelperFunctions)?.showToastNotification?.(message, type);
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
        return capability('filterManager', () => window.filterManager)?.toggleFilterMode?.();
    }

    function openNotificationFilterSettings() {
        return capability('filterManager', () => window.filterManager)?.openFilterRulesModal?.();
    }

    function clearNotifications() {
        return capability('notificationRenderer', () => window.notificationRenderer)?.clearPersistentNotifications?.()
            || { success: false, removed: 0 };
    }

    function isAborted(signal) {
        return Boolean(signal?.aborted);
    }

    function chatManagerReady() {
        return Boolean(chatManagerProvider?.selectItem)
            && (typeof chatManagerProvider.isReady !== 'function' || chatManagerProvider.isReady());
    }

    async function createAgent({ name, model = '', signal = null }) {
        const result = await api()?.createAgent?.(name, model ? { model } : undefined);
        if (!result?.success) return result || { success: false, error: '创建功能不可用' };
        if (isAborted(signal)) return { ...result, navigationSuccess: false, cancelled: true };
        if (!chatManagerReady()) {
            return { ...result, navigationSuccess: false, warning: '聊天界面尚未就绪，请稍后重试。' };
        }
        try {
            await capability('itemListManager', () => window.itemListManager)?.loadItems?.();
            if (isAborted(signal)) return { ...result, navigationSuccess: false, cancelled: true };
            await chatManagerProvider?.selectItem?.(result.agentId, 'agent', result.agentName, null, result.config);
            if (isAborted(signal)) return { ...result, navigationSuccess: false, cancelled: true };
            capability('uiManager', () => window.uiManager)?.switchToTab?.('settings');
            return { ...result, navigationSuccess: true };
        } catch (error) {
            console.error('[MainChatCommands] Agent created but UI navigation failed:', error);
            notify(`助手已创建，但界面刷新失败：${error.message}`, 'warning');
            return { ...result, navigationSuccess: false, warning: error.message };
        }
    }

    async function createGroup({ name, model = '', signal = null }) {
        const initialConfig = model ? { useUnifiedModel: true, unifiedModel: model } : undefined;
        const result = await api()?.createAgentGroup?.(name, initialConfig);
        if (!result?.success) return result || { success: false, error: '创建功能不可用' };
        const group = result.agentGroup;
        if (!group?.id) return { success: false, error: '群组已创建，但返回数据不完整。' };
        if (isAborted(signal)) return { ...result, navigationSuccess: false, cancelled: true };
        if (!chatManagerReady()) {
            return { ...result, navigationSuccess: false, warning: '聊天界面尚未就绪，请稍后重试。' };
        }
        try {
            await capability('itemListManager', () => window.itemListManager)?.loadItems?.();
            if (isAborted(signal)) return { ...result, navigationSuccess: false, cancelled: true };
            await chatManagerProvider?.selectItem?.(group.id, 'group', group.name, group.avatarUrl, group);
            if (isAborted(signal)) return { ...result, navigationSuccess: false, cancelled: true };
            capability('uiManager', () => window.uiManager)?.switchToTab?.('settings');
            return { ...result, navigationSuccess: true };
        } catch (error) {
            console.error('[MainChatCommands] Group created but UI navigation failed:', error);
            notify(`群组已创建，但界面刷新失败：${error.message}`, 'warning');
            return { ...result, navigationSuccess: false, warning: error.message };
        }
    }

    const handlers = {
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
    };
    const commandRegistry = window.VCPContributions?.commands;
    const commandTitles = {
        minimize: '最小化窗口', minimizeToTray: '最小化到托盘', toggleMaximize: '切换最大化', close: '关闭窗口',
        openSettings: '打开全局设置', openThemes: '打开主题管理器', toggleTheme: '切换明暗主题', createItem: '创建助手或群组',
        openForum: '打开论坛', openMemo: '打开记忆', toggleNotificationFilter: '切换通知过滤',
        openNotificationFilterSettings: '打开通知过滤设置', clearNotifications: '清空通知', createAgent: '创建助手', createGroup: '创建群组',
    };
    const commandIds = Object.fromEntries(Object.keys(handlers).map(name => [
        name,
        `main.${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`,
    ]));
    window.addEventListener('vcp-main-chat-commands-configure', event => {
        const provider = event.detail?.chatManager;
        const nextCapabilities = event.detail?.capabilities;
        if (!provider || typeof provider.selectItem !== 'function') {
            throw new TypeError('MainChatCommands requires a chat manager provider.');
        }
        if (!nextCapabilities || typeof nextCapabilities !== 'object') {
            throw new TypeError('MainChatCommands capabilities must be an object.');
        }
        if (chatManagerProvider && chatManagerProvider !== provider) {
            throw new Error('MainChatCommands chat manager provider is already registered.');
        }
        chatManagerProvider = provider;
        capabilities = Object.freeze({ ...nextCapabilities });
    }, { once: true });
    if (commandRegistry) {
        Object.entries(handlers).forEach(([name, handler]) => {
            const id = commandIds[name];
            if (!commandRegistry.get(id)) commandRegistry.register({ id, title: commandTitles[name], handler });
        });
    }
    const facade = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [
        name,
        (...args) => commandRegistry ? commandRegistry.execute(commandIds[name], ...args) : handler(...args),
    ]));
    Object.defineProperty(window, 'MainChatCommands', { value: Object.freeze({
        ...facade,
        getWindowState: () => window.VCPWindowState?.getState?.() || Object.freeze({ ready: false, maximized: false }),
        subscribeWindowState: (listener, options) => window.VCPWindowState?.subscribe?.(listener, options) || (() => false),
        execute: (id, ...args) => commandRegistry?.execute(id, ...args),
        list: () => commandRegistry?.list() || [],
        register: (definition, options) => commandRegistry?.register(definition, options),
    }), writable: false, configurable: false });
})();
