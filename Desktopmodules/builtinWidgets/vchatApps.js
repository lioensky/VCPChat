/**
 * VCPdesktop - VChat 内部应用注册表 & 启动器
 * 负责：将 VChat 系统内部各子应用（聊天主界面、笔记中心、论坛、翻译、骰子、Canvas、音乐、RAG 监听等）
 *       注册到桌面 Dock 栏中，使用户可以统一从桌面启动这些应用。
 * 
 * 所有内部应用默认使用 assets/icon.png 作为图标。
 * 启动方式通过 IPC 通道 'desktop-launch-vchat-app' 与主进程通信。
 */

'use strict';

(function () {
    const { state } = window.VCPDesktop;

    // ============================================================
    // VChat 内部应用注册表
    // ============================================================

    /**
     * 所有可用的 VChat 内部子应用定义
     * 
     * 每个应用包含：
     *   - id:          唯一标识（用于 Dock 去重）
     *   - name:        显示名称
     *   - icon:        图标路径（相对于 desktop.html）
     *   - emoji:       备用 emoji 图标
     *   - description: 功能描述
     *   - appAction:   主进程执行的动作标识
     */
    const VCHAT_APPS = [
        {
            id: 'vchat-app-main',
            name: 'VChat 主界面',
            icon: '../assets/icon.png',
            emoji: '💬',
            description: '打开 VChat 聊天主窗口',
            appAction: 'show-main-window',
        },
        {
            id: 'vchat-app-notes',
            name: '用户笔记中心',
            icon: '../assets/icon.png',
            emoji: '📝',
            description: '打开用户笔记管理窗口',
            appAction: 'open-notes-window',
        },
        {
            id: 'vchat-app-memo',
            name: 'AI记忆中心',
            icon: '../assets/icon.png',
            emoji: '🧠',
            description: '打开 AI 记忆图谱 & 备忘录',
            appAction: 'open-memo-window',
        },
        {
            id: 'vchat-app-forum',
            name: '论坛模块',
            icon: '../assets/icon.png',
            emoji: '🏛️',
            description: '打开 VCP 论坛讨论区',
            appAction: 'open-forum-window',
        },
        {
            id: 'vchat-app-rag-observer',
            name: 'RAG 信息流监听',
            icon: '../assets/icon.png',
            emoji: '📡',
            description: '打开 VCP RAG 信息流监听器',
            appAction: 'open-rag-observer-window',
        },
        {
            id: 'vchat-app-dice',
            name: '丢骰子',
            icon: '../assets/icon.png',
            emoji: '🎲',
            description: '打开骰子投掷器模块',
            appAction: 'open-dice-window',
        },
        {
            id: 'vchat-app-canvas',
            name: 'Canvas 协同',
            icon: '../assets/icon.png',
            emoji: '🎨',
            description: '打开 Canvas 协同编辑画布',
            appAction: 'open-canvas-window',
        },
        {
            id: 'vchat-app-translator',
            name: '翻译模块',
            icon: '../assets/icon.png',
            emoji: '🌐',
            description: '打开 AI 翻译工具窗口',
            appAction: 'open-translator-window',
        },
        {
            id: 'vchat-app-music',
            name: '音乐播放器',
            icon: '../assets/icon.png',
            emoji: '🎵',
            description: '打开 HIFI 音乐播放器',
            appAction: 'open-music-window',
        },
        {
            id: 'vchat-app-themes',
            name: '主题商店',
            icon: '../assets/icon.png',
            emoji: '🎭',
            description: '打开主题定制与管理',
            appAction: 'open-themes-window',
        },
    ];

    // ============================================================
    // 启动 VChat 内部应用
    // ============================================================

    /**
     * 通过 IPC 启动 VChat 内部应用
     * @param {object} appDef - 应用定义对象（来自 VCHAT_APPS）
     */
    async function launchVchatApp(appDef) {
        if (!appDef || !appDef.appAction) {
            console.warn('[VChatApps] Invalid app definition:', appDef);
            return;
        }

        console.log(`[VChatApps] Launching: ${appDef.name} (action: ${appDef.appAction})`);

        if (window.VCPDesktop.status) {
            window.VCPDesktop.status.update('streaming', `正在启动: ${appDef.name}...`);
            window.VCPDesktop.status.show();
        }

        try {
            if (window.electronAPI?.desktopLaunchVchatApp) {
                const result = await window.electronAPI.desktopLaunchVchatApp(appDef.appAction);
                if (result?.success) {
                    console.log(`[VChatApps] Successfully launched: ${appDef.name}`);
                    if (window.VCPDesktop.status) {
                        window.VCPDesktop.status.update('connected', `已启动: ${appDef.name}`);
                        setTimeout(() => window.VCPDesktop.status.hide(), 2000);
                    }
                } else {
                    console.error(`[VChatApps] Launch failed: ${appDef.name}`, result?.error);
                    if (window.VCPDesktop.status) {
                        window.VCPDesktop.status.update('waiting', `启动失败: ${result?.error || '未知错误'}`);
                        setTimeout(() => window.VCPDesktop.status.hide(), 3000);
                    }
                }
            } else {
                console.warn('[VChatApps] desktopLaunchVchatApp API not available');
                if (window.VCPDesktop.status) {
                    window.VCPDesktop.status.update('waiting', '启动接口不可用');
                    setTimeout(() => window.VCPDesktop.status.hide(), 3000);
                }
            }
        } catch (err) {
            console.error(`[VChatApps] Launch error for ${appDef.name}:`, err);
            if (window.VCPDesktop.status) {
                window.VCPDesktop.status.update('waiting', `启动出错: ${err.message}`);
                setTimeout(() => window.VCPDesktop.status.hide(), 3000);
            }
        }
    }

    // ============================================================
    // 将 VChat 内部应用注入到 Dock 系统
    // ============================================================

    /**
     * 将所有 VChat 内部应用注入到 Dock 的 items 列表中。
     * 使用 type: 'vchat-app' 区分于外部快捷方式和内置挂件。
     * 只注入尚未存在的应用（基于 id 去重），保证不会重复。
     */
    function injectVchatAppsToDock() {
        let injectedCount = 0;
        let updatedCount = 0;

        for (const appDef of VCHAT_APPS) {
            const existing = state.dock.items.find(item => item.id === appDef.id);
            if (existing) {
                // 已存在：同步更新属性（名称/描述/图标等可能在代码中修改过）
                let changed = false;
                if (existing.name !== appDef.name) { existing.name = appDef.name; changed = true; }
                if (existing.emoji !== appDef.emoji) { existing.emoji = appDef.emoji; changed = true; }
                if (existing.description !== appDef.description) { existing.description = appDef.description; changed = true; }
                if (existing.appAction !== appDef.appAction) { existing.appAction = appDef.appAction; changed = true; }
                // 图标仅在用户未自定义时同步（如果是 data: URL 则说明用户自定义了）
                if (existing.icon && !existing.icon.startsWith('data:') && existing.icon !== appDef.icon) {
                    existing.icon = appDef.icon;
                    changed = true;
                }
                if (changed) updatedCount++;
                continue;
            }

            // 不存在：新增注入
            state.dock.items.push({
                id: appDef.id,
                name: appDef.name,
                icon: appDef.icon,
                emoji: appDef.emoji,
                description: appDef.description,
                appAction: appDef.appAction,
                type: 'vchat-app',
            });

            injectedCount++;
        }

        if (injectedCount > 0 || updatedCount > 0) {
            console.log(`[VChatApps] Dock sync: ${injectedCount} new, ${updatedCount} updated`);
            // 触发 Dock 重新渲染
            if (window.VCPDesktop.dock && window.VCPDesktop.dock.render) {
                window.VCPDesktop.dock.render();
            }
            // 保存 Dock 配置以持久化
            if (window.VCPDesktop.dock && window.VCPDesktop.dock.saveDockConfig) {
                window.VCPDesktop.dock.saveDockConfig();
            }
        } else {
            console.log('[VChatApps] All VChat apps in sync, no changes needed');
        }
    }

    /**
     * 获取 VChat 应用定义列表（供外部模块使用）
     */
    function getVchatApps() {
        return VCHAT_APPS;
    }

    /**
     * 根据 appAction 查找应用定义
     */
    function findAppByAction(action) {
        return VCHAT_APPS.find(app => app.appAction === action);
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.vchatApps = {
        list: getVchatApps,
        launch: launchVchatApp,
        inject: injectVchatAppsToDock,
        findByAction: findAppByAction,
        VCHAT_APPS,
    };

})();