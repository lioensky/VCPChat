/* Compose the current assistant profile for the home page and the app list for the "+" menu. */
export function createSidePaneHomeWiring({ doc, win, chatAPI, chatManager, uiHelper, selectedItemRef, controller }) {
    const owners = [];
    const subscriptions = { add: owner => owners.push(owner) };
    // 首页顶部显示当前助手：点头像去设置页换头像（群组只显示），点名字直接改名
    const renameSelectedItem = async (item, name) => {
        const api = chatAPI || win.electronAPI;
        const save = item.type === 'group' ? api?.saveAgentGroupConfig : api?.saveAgentConfig;
        if (typeof save !== 'function') return { error: 'unsupported' };
        const result = await save.call(api, item.id, { name });
        if (!result?.success) {
            uiHelper?.showToastNotification?.(`改名失败: ${result?.error || '未知错误'}`, 'error');
            return { error: result?.error || 'save-failed' };
        }
        const latest = selectedItemRef.get();
        if (latest?.id === item.id) {
            const next = { ...latest, name };
            if (latest.config) next.config = { ...latest.config, name };
            selectedItemRef.set(next);
            const header = doc.getElementById('currentChatAgentName');
            if (header && item.name && !window.vcpChatHeader?.renameItem?.(item.name, name)
                && header.textContent.includes(item.name)) {
                header.textContent = header.textContent.replace(item.name, name);
            }
        }
        // 设置页正开着这一项时同步名称框，免得之后保存设置又把旧名字写回去
        const [idField, nameField] = item.type === 'group'
            ? ['editingGroupId', 'groupNameInput']
            : ['editingAgentId', 'agentNameInput'];
        if (doc.getElementById(idField)?.value === item.id) {
            const input = doc.getElementById(nameField);
            if (input) input.value = name;
        }
        await win.itemListManager?.loadItems?.();
        controller.setHomeProfileProvider(getHomeProfile);
        return result;
    };
    const getHomeProfile = () => {
        const item = selectedItemRef.get();
        if (!item?.id) return null;
        return {
            name: item.name || '',
            avatarUrl: item.avatarUrl || '',
            onEditAvatar: item.type === 'agent' ? () => {
                win.uiManager?.switchToTab?.('settings');
                doc.getElementById('agentAvatarInput')?.click();
            } : null,
            onRename: item.type === 'agent' || item.type === 'group' ? (name) => renameSelectedItem(item, name) : null
        };
    };
    controller.setHomeProfileProvider(getHomeProfile);
    const unbindHomeProfile = chatManager?.onSelectionChange?.(() => controller.setHomeProfileProvider(getHomeProfile));
    if (unbindHomeProfile) subscriptions.add({ dispose: unbindHomeProfile });

    // 「+」菜单下半部分的应用：和托盘同一批应用、同一套图标和打开方式
    const getAddMenuApps = () => {
        const shell = win.VCPNextShellController;
        const tray = win.trayManager;
        const external = (tray?.getApps?.() || [])
            .filter(app => app.id !== 'vchat-app-main')
            .map(app => ({
                id: app.id,
                label: app.name,
                title: app.embed ? `${app.name}（在标签页中打开）` : `${app.name}（在独立窗口中打开）`,
                iconSvg: tray?.getIcon?.(app.icon) || '',
                open: () => (app.embed && shell?.openEmbeddedApp ? shell.openEmbeddedApp(app) : tray?.launchApp?.(app)),
            }));
        const internal = (win.nextUiApps?.list?.() || []).filter(app => app.discoverable !== false).map(app => ({
            id: `internal:${app.id}`,
            label: app.title,
            title: app.title,
            iconSvg: tray?.getIcon?.(app.id === 'ui-component-library' ? 'widgets' : app.launchpadIcon) || '',
            open: () => shell?.openInternalApp?.(app.id),
        }));
        return [...external, ...internal];
    };
    if (win.trayManager?.getApps) controller.setAddMenuAppsProvider(getAddMenuApps);

    return Object.freeze({ dispose() { owners.splice(0).forEach(owner => owner.dispose?.()); } });
}
