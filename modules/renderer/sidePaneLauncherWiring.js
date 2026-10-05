/* Compose the current assistant profile and the app/recommendation sources. */
export function createSidePaneLauncherWiring({ doc, win, chatAPI, chatManager, uiHelper, selectedItemRef, controller }) {
    const owners = [];
    const subscriptions = { add: owner => owners.push(owner) };
    // 新标签页顶部显示当前助手：点头像去设置页换头像（群组只显示），点名字直接改名
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
        controller.setLauncherProfileProvider(getLauncherProfile);
        return result;
    };
    const getLauncherProfile = () => {
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
    controller.setLauncherProfileProvider(getLauncherProfile);
    const unbindLauncherProfile = chatManager?.onSelectionChange?.(() => controller.setLauncherProfileProvider(getLauncherProfile));
    if (unbindLauncherProfile) subscriptions.add({ dispose: unbindLauncherProfile });

    // 新标签页的「应用」页：和顶部「+」启动台是同一批应用、同一套图标和打开方式。
    // 应用页和「推荐」各自一套动态图标，重画一处不会把另一处的画布停掉
    const createLauncherIconSet = () => {
        let icons = null;
        return {
            reset() {
                icons?.dispose?.();
                icons = null;
                const Icons = win.VCPNextShell?.LaunchpadIcons;
                if (!Icons) return;
                try {
                    icons = new Icons({ document: doc });
                    icons.setActive(true);
                } catch (error) {
                    console.warn('[SidePane] Failed to create launcher icons:', error);
                    icons = null;
                }
            },
            mount: (key, fallbackSvg) => (button, host) => {
                if (fallbackSvg) host.innerHTML = fallbackSvg;
                icons?.attach?.(button, host, key);
            },
            dispose() {
                icons?.dispose?.();
                icons = null;
            }
        };
    };
    const toLauncherApp = (app, iconSet) => {
        const shell = win.VCPNextShellController;
        const tray = win.trayManager;
        return {
            id: app.id,
            label: app.name,
            title: app.embed ? `${app.name}（在标签页中打开）` : `${app.name}（在独立窗口中打开）`,
            mountIcon: iconSet.mount(app.icon, tray?.getIcon?.(app.icon) || ''),
            open: () => (app.embed && shell?.openEmbeddedApp ? shell.openEmbeddedApp(app) : tray?.launchApp?.(app)),
        };
    };
    const appIcons = createLauncherIconSet();
    const getLauncherApps = () => {
        const shell = win.VCPNextShellController;
        appIcons.reset();
        const external = (win.trayManager?.getApps?.() || [])
            .filter(app => app.id !== 'vchat-app-main')
            .map(app => toLauncherApp(app, appIcons));
        const internal = (win.nextUiApps?.list?.() || []).filter(app => app.discoverable !== false).map(app => ({
            id: `internal:${app.id}`,
            label: app.title,
            title: app.title,
            mountIcon: appIcons.mount(app.id === 'ui-component-library' ? 'widgets' : app.launchpadIcon, ''),
            open: () => shell?.openInternalApp?.(app.id),
        }));
        return [...external, ...internal];
    };
    // 工具页下方的「推荐」：托盘的常用应用（最多 4 个，一排放得下），齿轮里改
    const RECOMMENDED_LIMIT = 4;
    const recommendedIcons = createLauncherIconSet();
    const getLauncherRecommended = () => {
        const tray = win.trayManager;
        recommendedIcons.reset();
        const apps = new Map((tray?.getApps?.() || []).map(app => [app.id, app]));
        return (tray?.getPinnedAppIds?.() || [])
            .map(id => apps.get(id))
            .filter(app => app && app.id !== 'vchat-app-main')
            .slice(0, RECOMMENDED_LIMIT)
            .map(app => toLauncherApp(app, recommendedIcons));
    };
    if (win.trayManager?.getApps) {
        controller.setLauncherAppsProvider(getLauncherApps);
        controller.setLauncherRecommendedProvider(getLauncherRecommended, {
            onSettings: win.trayManager.openSettings ? () => win.trayManager.openSettings() : null
        });
        const unbindPinned = win.trayManager.onPinnedChange?.(() => controller.refreshLauncherRecommended());
        if (unbindPinned) subscriptions.add({ dispose: unbindPinned });
        subscriptions.add({ dispose: () => appIcons.dispose() });
        subscriptions.add({ dispose: () => recommendedIcons.dispose() });
    }

    return Object.freeze({ dispose() { owners.splice(0).forEach(owner => owner.dispose?.()); } });
}
