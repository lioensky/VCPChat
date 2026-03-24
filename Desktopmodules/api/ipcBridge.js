/**
 * VCPdesktop - IPC 监听桥接模块
 * 负责：监听来自主窗口的流式推送、状态更新、桌面远程控制，分发到对应模块
 */

'use strict';

(function () {
    const { state, status, widget } = window.VCPDesktop;

    /**
     * 初始化 IPC 监听
     * 接收来自主窗口的流式推送（创建/追加/完成/替换/删除/清除）
     */
    function initIpcListeners() {
        // 桌面推送监听
        if (window.electronAPI?.onDesktopPush) {
            window.electronAPI.onDesktopPush((data) => {
                const { action, widgetId, content, options } = data;

                switch (action) {
                    case 'create':
                        widget.create(widgetId, options);
                        status.update('streaming', `正在渲染挂件: ${widgetId}`);
                        break;

                    case 'append':
                        widget.appendContent(widgetId, content);
                        break;

                    case 'finalize':
                        widget.finalize(widgetId);
                        status.update('connected', `挂件渲染完成: ${widgetId}`);
                        break;

                    case 'replace':
                        widget.replaceInWidgets(data.targetSelector, content);
                        status.update('streaming', `替换内容: ${data.targetSelector}`);
                        break;

                    case 'remove':
                        widget.remove(widgetId);
                        break;

                    case 'clear':
                        widget.clearAll();
                        break;

                    default:
                        console.warn(`[Desktop] Unknown action: ${action}`);
                }
            });
        }

        // 状态更新监听
        if (window.electronAPI?.onDesktopStatus) {
            window.electronAPI.onDesktopStatus((data) => {
                state.isConnected = data.connected;
                status.update(
                    data.connected ? 'connected' : 'waiting',
                    data.message || (data.connected ? '已连接' : '等待连接...')
                );
            });
        }

        // ============================================================
        // DesktopRemote 远程控制监听
        // ============================================================

        // 远程壁纸推送
        if (window.electronAPI?.onDesktopRemoteSetWallpaper) {
            window.electronAPI.onDesktopRemoteSetWallpaper((wallpaperConfig) => {
                console.log('[Desktop IPC] Received remote wallpaper push:', wallpaperConfig.type);
                try {
                    // 更新全局设置中的壁纸配置
                    if (state.globalSettings) {
                        state.globalSettings.wallpaper = {
                            ...state.globalSettings.wallpaper,
                            ...wallpaperConfig,
                        };
                    }

                    // 应用壁纸
                    if (window.VCPDesktop.wallpaper) {
                        window.VCPDesktop.wallpaper.apply(wallpaperConfig);
                    }

                    // 保存设置到磁盘
                    if (window.VCPDesktop.globalSettings && window.VCPDesktop.globalSettings.save) {
                        window.VCPDesktop.globalSettings.save();
                    }

                    status.update('connected', `AI推送了新壁纸（${wallpaperConfig.type}）`);
                    status.show();
                    setTimeout(() => status.hide(), 3000);
                } catch (err) {
                    console.error('[Desktop IPC] Failed to apply remote wallpaper:', err);
                    status.update('waiting', '壁纸应用失败');
                    status.show();
                    setTimeout(() => status.hide(), 3000);
                }
            });
        }

        // 远程桌面感知查询
        if (window.electronAPI?.onDesktopRemoteQuery) {
            window.electronAPI.onDesktopRemoteQuery(() => {
                console.log('[Desktop IPC] Received remote desktop query');
                try {
                    // 收集挂件信息
                    const widgetsList = [];
                    const WIDGETS_DIR = 'AppData/DesktopWidgets'; // 相对路径供AI参考

                    for (const [widgetId, widgetData] of state.widgets) {
                        const info = { id: widgetId };
                        if (widgetData.savedName) {
                            info.savedName = widgetData.savedName;
                            info.savedId = widgetData.savedId;
                            // 提供持久化目录路径，方便AI调用FileOperator维护
                            info.savedDir = `${WIDGETS_DIR}/${widgetData.savedId}`;
                        }
                        widgetsList.push(info);
                    }

                    // 收集桌面图标名称列表
                    const iconNames = [];
                    const canvas = document.getElementById('desktop-canvas');
                    if (canvas) {
                        const iconElements = canvas.querySelectorAll('.desktop-shortcut-icon');
                        iconElements.forEach((iconEl) => {
                            const label = iconEl.querySelector('.desktop-shortcut-icon-label');
                            if (label) {
                                iconNames.push(label.textContent || '未命名');
                            }
                        });
                    }

                    // 发送响应
                    if (window.electronAPI?.sendDesktopRemoteQueryResponse) {
                        window.electronAPI.sendDesktopRemoteQueryResponse({
                            success: true,
                            widgets: widgetsList,
                            icons: iconNames,
                        });
                    }

                    console.log(`[Desktop IPC] Query response: ${widgetsList.length} widgets, ${iconNames.length} icons`);
                } catch (err) {
                    console.error('[Desktop IPC] Desktop query error:', err);
                    if (window.electronAPI?.sendDesktopRemoteQueryResponse) {
                        window.electronAPI.sendDesktopRemoteQueryResponse({
                            success: false,
                            error: err.message,
                        });
                    }
                }
            });
        }

        // 远程 Dock 应用列表查询
        if (window.electronAPI?.onDesktopRemoteQueryDock) {
            window.electronAPI.onDesktopRemoteQueryDock(() => {
                console.log('[Desktop IPC] Received remote dock query');
                try {
                    // 收集 Dock 中的用户快捷方式列表
                    const dockItems = [];
                    if (state.dock && state.dock.items) {
                        for (const item of state.dock.items) {
                            const info = {
                                name: item.name,
                                type: item.type || 'shortcut',
                                visible: item.visible !== false,
                            };
                            if (item.type === 'vchat-app') {
                                info.appAction = item.appAction || '';
                            } else if (item.type === 'builtin') {
                                info.builtinId = item.builtinId || '';
                            } else {
                                info.targetPath = item.targetPath || '';
                            }
                            dockItems.push(info);
                        }
                    }

                    // 收集 VChat 内部应用列表（硬编码，始终可用）
                    const vchatApps = [];
                    if (window.VCPDesktop.vchatApps && window.VCPDesktop.vchatApps.VCHAT_APPS) {
                        for (const app of window.VCPDesktop.vchatApps.VCHAT_APPS) {
                            vchatApps.push({
                                name: app.name,
                                emoji: app.emoji || '',
                                appAction: app.appAction,
                            });
                        }
                    }

                    // 收集系统工具列表
                    const systemTools = [];
                    if (window.VCPDesktop.vchatApps && window.VCPDesktop.vchatApps.SYSTEM_TOOLS) {
                        for (const tool of window.VCPDesktop.vchatApps.SYSTEM_TOOLS) {
                            systemTools.push({
                                name: tool.name,
                                emoji: tool.emoji || '',
                                appAction: tool.appAction,
                            });
                        }
                    }

                    // 收集内置挂件列表
                    const builtinWidgets = [
                        { name: '天气挂件', builtinId: 'builtinWeather' },
                        { name: '音乐播放条', builtinId: 'builtinMusic' },
                        { name: '应用托盘', builtinId: 'builtinAppTray' },
                    ];

                    // 发送响应
                    if (window.electronAPI?.sendDesktopRemoteQueryDockResponse) {
                        window.electronAPI.sendDesktopRemoteQueryDockResponse({
                            success: true,
                            dockItems,
                            vchatApps,
                            systemTools,
                            builtinWidgets,
                        });
                    }

                    console.log(`[Desktop IPC] Dock query response: ${dockItems.length} dock items, ${vchatApps.length} vchat apps, ${systemTools.length} system tools`);
                } catch (err) {
                    console.error('[Desktop IPC] Dock query error:', err);
                    if (window.electronAPI?.sendDesktopRemoteQueryDockResponse) {
                        window.electronAPI.sendDesktopRemoteQueryDockResponse({
                            success: false,
                            error: err.message,
                        });
                    }
                }
            });
        }

        // 远程查看挂件源码
        if (window.electronAPI?.onDesktopRemoteViewSource) {
            window.electronAPI.onDesktopRemoteViewSource((data) => {
                const { widgetId } = data;
                console.log(`[Desktop IPC] Received view source request for widget: ${widgetId}`);
                try {
                    const widgetData = state.widgets.get(widgetId);
                    if (!widgetData) {
                        if (window.electronAPI?.sendDesktopRemoteViewSourceResponse) {
                            window.electronAPI.sendDesktopRemoteViewSourceResponse({
                                success: false,
                                widgetId,
                                error: `挂件 '${widgetId}' 不存在于当前桌面上。可用的挂件ID: ${[...state.widgets.keys()].join(', ') || '(无)'}`,
                            });
                        }
                        return;
                    }

                    // 获取挂件的HTML内容
                    // 优先使用 contentBuffer（保存时的原始HTML），其次从 contentContainer 获取当前渲染内容
                    const htmlSource = widgetData.contentBuffer || widgetData.contentContainer?.innerHTML || '';

                    if (window.electronAPI?.sendDesktopRemoteViewSourceResponse) {
                        window.electronAPI.sendDesktopRemoteViewSourceResponse({
                            success: true,
                            widgetId,
                            html: htmlSource,
                            savedName: widgetData.savedName || null,
                            savedId: widgetData.savedId || null,
                        });
                    }

                    console.log(`[Desktop IPC] View source response: ${htmlSource.length} chars`);
                } catch (err) {
                    console.error('[Desktop IPC] View source error:', err);
                    if (window.electronAPI?.sendDesktopRemoteViewSourceResponse) {
                        window.electronAPI.sendDesktopRemoteViewSourceResponse({
                            success: false,
                            error: err.message,
                        });
                    }
                }
            });
        }

        // 远程创建挂件
        if (window.electronAPI?.onDesktopRemoteCreateWidget) {
            window.electronAPI.onDesktopRemoteCreateWidget((data) => {
                const { widgetId, htmlContent, options, autoSave, saveName, preSavedId } = data;
                console.log(`[Desktop IPC] Received remote create widget: ${widgetId}`, options, preSavedId ? `(pre-saved: ${preSavedId})` : '');
                try {
                    // 使用 widgetManager 创建挂件
                    const widgetData = widget.create(widgetId, {
                        x: options.x || 100,
                        y: options.y || 100,
                        width: options.width || 320,
                        height: options.height || 200,
                    });

                    // 如果有预保存的 ID（说明主进程已经保存了文件到收藏目录），
                    // 直接在 widgetData 上标记收藏信息，这样 processInlineScripts 中的
                    // widgetFS 等 API 也能正常工作
                    if (preSavedId) {
                        widgetData.savedId = preSavedId;
                        widgetData.savedName = saveName || 'AI Widget';
                    }

                    // 设置内容
                    widget.appendContent(widgetId, htmlContent);

                    // 完成渲染（执行脚本等）
                    widget.finalize(widgetId);

                    status.update('connected', `AI创建了新挂件: ${widgetId}`);
                    status.show();
                    setTimeout(() => status.hide(), 3000);

                    // 如果已经预保存（有 scriptFiles 的情况），直接返回成功
                    if (preSavedId) {
                        // 文件已由主进程预保存，补充截图缩略图（异步，不阻塞响应）
                        _captureAndUpdateThumbnail(preSavedId, widgetData).catch((e) => {
                            console.warn('[Desktop IPC] Thumbnail capture for pre-saved widget failed:', e.message);
                        });

                        // 刷新侧栏
                        if (window.VCPDesktop?.sidebar?.refresh) {
                            window.VCPDesktop.sidebar.refresh();
                        } else if (window.VCPDesktop?.favorites?.loadList) {
                            window.VCPDesktop.favorites.loadList();
                        }

                        if (window.electronAPI?.sendDesktopRemoteCreateWidgetResponse) {
                            window.electronAPI.sendDesktopRemoteCreateWidgetResponse({
                                success: true,
                                widgetId,
                                savedId: preSavedId,
                                savedName: saveName || 'AI Widget',
                            });
                        }
                    } else if (autoSave && saveName) {
                        // 普通的自动收藏流程
                        _autoSaveWidget(widgetId, saveName, widgetData).then((savedResult) => {
                            if (window.electronAPI?.sendDesktopRemoteCreateWidgetResponse) {
                                window.electronAPI.sendDesktopRemoteCreateWidgetResponse({
                                    success: true,
                                    widgetId,
                                    savedId: savedResult?.id || null,
                                    savedName: savedResult?.name || null,
                                });
                            }
                        }).catch((saveErr) => {
                            console.warn('[Desktop IPC] Auto-save failed, but widget was created:', saveErr);
                            if (window.electronAPI?.sendDesktopRemoteCreateWidgetResponse) {
                                window.electronAPI.sendDesktopRemoteCreateWidgetResponse({
                                    success: true,
                                    widgetId,
                                    savedId: null,
                                    savedName: null,
                                });
                            }
                        });
                    } else {
                        // 无需收藏，直接返回成功
                        if (window.electronAPI?.sendDesktopRemoteCreateWidgetResponse) {
                            window.electronAPI.sendDesktopRemoteCreateWidgetResponse({
                                success: true,
                                widgetId,
                            });
                        }
                    }

                    console.log(`[Desktop IPC] Widget created successfully: ${widgetId}`);
                } catch (err) {
                    console.error('[Desktop IPC] Create widget error:', err);
                    if (window.electronAPI?.sendDesktopRemoteCreateWidgetResponse) {
                        window.electronAPI.sendDesktopRemoteCreateWidgetResponse({
                            success: false,
                            widgetId,
                            error: err.message,
                        });
                    }
                }
            });
        }
    }

    /**
     * 自动收藏挂件（内部辅助函数）
     * @param {string} widgetId - 挂件 ID
     * @param {string} saveName - 收藏名称
     * @param {object} widgetData - 挂件数据
     * @returns {Promise<{id: string, name: string}|null>}
     */
    async function _autoSaveWidget(widgetId, saveName, widgetData) {
        try {
            const savedId = `saved-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
            const htmlContent = widgetData.contentBuffer || widgetData.contentContainer?.innerHTML || '';

            if (!htmlContent) {
                console.warn('[Desktop IPC] No content to save for auto-save');
                return null;
            }

            // 获取缩略图
            let thumbnail = '';
            try {
                const rect = widgetData.element.getBoundingClientRect();
                if (window.electronAPI?.desktopCaptureWidget) {
                    const captureResult = await window.electronAPI.desktopCaptureWidget({
                        x: Math.round(rect.x),
                        y: Math.round(rect.y),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                    });
                    if (captureResult?.success) {
                        thumbnail = captureResult.thumbnail;
                    }
                }
            } catch (e) {
                console.warn('[Desktop IPC] Thumbnail capture failed:', e.message);
            }

            // 调用收藏 API
            if (window.electronAPI?.desktopSaveWidget) {
                const result = await window.electronAPI.desktopSaveWidget({
                    id: savedId,
                    name: saveName,
                    html: htmlContent,
                    thumbnail,
                });

                if (result?.success) {
                    // 更新挂件的收藏标记
                    widgetData.savedName = saveName;
                    widgetData.savedId = savedId;
                    console.log(`[Desktop IPC] Widget auto-saved: ${saveName} (${savedId})`);

                    // 刷新侧栏
                    if (window.VCPDesktop?.sidebar?.refresh) {
                        window.VCPDesktop.sidebar.refresh();
                    } else if (window.VCPDesktop?.favorites?.loadList) {
                        window.VCPDesktop.favorites.loadList();
                    }

                    return { id: savedId, name: saveName };
                }
            }

            return null;
        } catch (err) {
            console.error('[Desktop IPC] Auto-save error:', err);
            return null;
        }
    }

    /**
     * 为预保存的 widget 补充缩略图（内部辅助函数）
     * 当 scriptFiles 场景下，主进程已经预保存了目录和文件，
     * 但缩略图需要等 widget 渲染完成后从渲染进程截取。
     * @param {string} savedId - 收藏 ID
     * @param {object} widgetData - 挂件数据
     */
    async function _captureAndUpdateThumbnail(savedId, widgetData) {
        try {
            // 等待 widget 渲染稳定
            await new Promise(resolve => setTimeout(resolve, 1000));

            const rect = widgetData.element.getBoundingClientRect();
            if (window.electronAPI?.desktopCaptureWidget) {
                const captureResult = await window.electronAPI.desktopCaptureWidget({
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                });
                if (captureResult?.success && captureResult.thumbnail) {
                    // 将缩略图保存到已有的收藏目录
                    // 通过 desktopSaveWidget 更新（会保留 createdAt）
                    const htmlContent = widgetData.contentBuffer || widgetData.contentContainer?.innerHTML || '';
                    if (window.electronAPI?.desktopSaveWidget) {
                        await window.electronAPI.desktopSaveWidget({
                            id: savedId,
                            name: widgetData.savedName || 'AI Widget',
                            html: htmlContent,
                            thumbnail: captureResult.thumbnail,
                        });
                        console.log(`[Desktop IPC] Thumbnail updated for pre-saved widget: ${savedId}`);
                    }
                }
            }
        } catch (e) {
            console.warn('[Desktop IPC] _captureAndUpdateThumbnail error:', e.message);
        }
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.ipc = {
        init: initIpcListeners,
    };

})();