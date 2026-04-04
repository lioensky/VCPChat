'use strict';

(function () {
    const desktopApi = window.desktopAPI || window.electronAPI;
    const { state, status, widget } = window.VCPDesktop;

    function sendDesktopRemoteRpcResponse(requestId, response) {
        if (!desktopApi?.sendDesktopRemoteResponse) {
            return;
        }

        desktopApi.sendDesktopRemoteResponse({
            requestId,
            ok: response.ok !== false,
            data: response.data,
            error: response.error,
        });
    }

    async function handleDesktopRemoteRpcRequest(request) {
        const requestId = request?.requestId;
        const command = request?.command;
        const payload = request?.payload || {};

        if (!requestId || !command) {
            return;
        }

        try {
            switch (command) {
                case 'QueryDesktop': {
                    const widgetsList = [];
                    const widgetsDir = 'AppData/DesktopWidgets';

                    for (const [widgetId, widgetData] of state.widgets) {
                        const info = { id: widgetId };
                        if (widgetData.savedName) {
                            info.savedName = widgetData.savedName;
                            info.savedId = widgetData.savedId;
                            info.savedDir = `${widgetsDir}/${widgetData.savedId}`;
                        }
                        widgetsList.push(info);
                    }

                    const iconNames = [];
                    const canvas = document.getElementById('desktop-canvas');
                    if (canvas) {
                        const iconElements = canvas.querySelectorAll('.desktop-shortcut-icon');
                        iconElements.forEach((iconEl) => {
                            const label = iconEl.querySelector('.desktop-shortcut-icon-label');
                            if (label) {
                                iconNames.push(label.textContent || 'Unnamed');
                            }
                        });
                    }

                    sendDesktopRemoteRpcResponse(requestId, {
                        ok: true,
                        data: {
                            widgets: widgetsList,
                            icons: iconNames,
                        },
                    });
                    return;
                }

                case 'QueryDock': {
                    const dockItems = [];
                    if (state.dock?.items) {
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

                    const vchatApps = [];
                    if (window.VCPDesktop.vchatApps?.VCHAT_APPS) {
                        for (const app of window.VCPDesktop.vchatApps.VCHAT_APPS) {
                            vchatApps.push({
                                name: app.name,
                                emoji: app.emoji || '',
                                appAction: app.appAction,
                            });
                        }
                    }

                    const systemTools = [];
                    if (window.VCPDesktop.vchatApps?.SYSTEM_TOOLS) {
                        for (const tool of window.VCPDesktop.vchatApps.SYSTEM_TOOLS) {
                            systemTools.push({
                                name: tool.name,
                                emoji: tool.emoji || '',
                                appAction: tool.appAction,
                            });
                        }
                    }

                    sendDesktopRemoteRpcResponse(requestId, {
                        ok: true,
                        data: {
                            dockItems,
                            vchatApps,
                            systemTools,
                            builtinWidgets: [
                                { name: 'Weather Widget', builtinId: 'builtinWeather' },
                                { name: 'Music Widget', builtinId: 'builtinMusic' },
                                { name: 'App Tray', builtinId: 'builtinAppTray' },
                            ],
                        },
                    });
                    return;
                }

                case 'ViewWidgetSource': {
                    const widgetId = payload.widgetId;
                    const widgetData = state.widgets.get(widgetId);
                    if (!widgetData) {
                        sendDesktopRemoteRpcResponse(requestId, {
                            ok: false,
                            error: `Widget "${widgetId}" does not exist on the current desktop.`,
                        });
                        return;
                    }

                    sendDesktopRemoteRpcResponse(requestId, {
                        ok: true,
                        data: {
                            widgetId,
                            html: widgetData.contentBuffer || widgetData.contentContainer?.innerHTML || '',
                            savedName: widgetData.savedName || null,
                            savedId: widgetData.savedId || null,
                        },
                    });
                    return;
                }

                case 'CreateWidget': {
                    const {
                        widgetId,
                        htmlContent,
                        options = {},
                        autoSave,
                        saveName,
                        preSavedId,
                        builtinWidgetKey,
                        metricComponent,
                    } = payload;

                    const builtinKey = builtinWidgetKey || metricComponent;
                    if (builtinKey && window.VCPDesktop.metricWidgets?.spawn) {
                        const spawnResult = window.VCPDesktop.metricWidgets.spawn(builtinKey, {
                            ...options,
                            widgetId,
                        });
                        const createdWidgetId = spawnResult?.widgetId || widgetId;
                        const builtinWidgetData = state.widgets.get(createdWidgetId);
                        const savedResult = autoSave && saveName && builtinWidgetData
                            ? await _autoSaveWidget(createdWidgetId, saveName, builtinWidgetData).catch(() => null)
                            : null;

                        sendDesktopRemoteRpcResponse(requestId, {
                            ok: true,
                            data: {
                                widgetId: createdWidgetId,
                                savedId: savedResult?.id || null,
                                savedName: savedResult?.name || null,
                                builtinWidgetKey: builtinKey,
                            },
                        });
                        return;
                    }

                    if (!widgetId || !htmlContent) {
                        throw new Error('CreateWidget requires widgetId and htmlContent.');
                    }

                    const widgetData = widget.create(widgetId, {
                        x: options.x || 100,
                        y: options.y || 100,
                        width: options.width || 320,
                        height: options.height || 200,
                    });
                    if (!widgetData) {
                        throw new Error(`Widget "${widgetId}" is being removed. Try again shortly.`);
                    }

                    if (preSavedId) {
                        widgetData.savedId = preSavedId;
                        widgetData.savedName = saveName || 'AI Widget';
                    }

                    widget.appendContent(widgetId, htmlContent);
                    widget.finalize(widgetId);

                    if (preSavedId) {
                        _captureAndUpdateThumbnail(preSavedId, widgetData).catch(() => {});
                        if (window.VCPDesktop?.sidebar?.refresh) {
                            window.VCPDesktop.sidebar.refresh();
                        } else if (window.VCPDesktop?.favorites?.loadList) {
                            window.VCPDesktop.favorites.loadList();
                        }
                    }

                    const savedResult = !preSavedId && autoSave && saveName
                        ? await _autoSaveWidget(widgetId, saveName, widgetData).catch(() => null)
                        : null;

                    sendDesktopRemoteRpcResponse(requestId, {
                        ok: true,
                        data: {
                            widgetId,
                            savedId: preSavedId || savedResult?.id || null,
                            savedName: (preSavedId ? saveName : savedResult?.name) || null,
                        },
                    });
                    return;
                }

                case 'SetStyleAutomation': {
                    if (!window.VCPDesktop?.styleAutomation) {
                        throw new Error('styleAutomation module is unavailable.');
                    }
                    const statusResult = await window.VCPDesktop.styleAutomation.setConfigPatch(payload.configPatch, {
                        persist: !!payload.persist,
                    });
                    sendDesktopRemoteRpcResponse(requestId, {
                        ok: true,
                        data: {
                            action: 'set',
                            status: statusResult,
                        },
                    });
                    return;
                }

                case 'GetStyleAutomationStatus': {
                    if (!window.VCPDesktop?.styleAutomation) {
                        throw new Error('styleAutomation module is unavailable.');
                    }
                    sendDesktopRemoteRpcResponse(requestId, {
                        ok: true,
                        data: {
                            action: 'status',
                            status: window.VCPDesktop.styleAutomation.getStatus(),
                        },
                    });
                    return;
                }

                default:
                    sendDesktopRemoteRpcResponse(requestId, {
                        ok: false,
                        error: `Unknown desktop remote command: ${command}`,
                    });
            }
        } catch (err) {
            console.error('[Desktop IPC] RPC bridge error:', err);
            sendDesktopRemoteRpcResponse(requestId, {
                ok: false,
                error: err?.message || String(err),
            });
        }
    }

    function initIpcListeners() {
        if (desktopApi?.onDesktopPush) {
            desktopApi.onDesktopPush((data) => {
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

        if (desktopApi?.onDesktopStatus) {
            desktopApi.onDesktopStatus((data) => {
                state.isConnected = data.connected;
                status.update(
                    data.connected ? 'connected' : 'waiting',
                    data.message || (data.connected ? '已连接' : '等待连接...')
                );
            });
        }

        if (desktopApi?.onDesktopRemoteRequest) {
            desktopApi.onDesktopRemoteRequest((request) => {
                handleDesktopRemoteRpcRequest(request);
            });
        }

        if (desktopApi?.onDesktopRemoteSetWallpaper) {
            desktopApi.onDesktopRemoteSetWallpaper((wallpaperConfig) => {
                console.log('[Desktop IPC] Received remote wallpaper push:', wallpaperConfig.type);
                try {
                    if (state.globalSettings) {
                        state.globalSettings.wallpaper = {
                            ...state.globalSettings.wallpaper,
                            ...wallpaperConfig,
                        };
                    }

                    if (window.VCPDesktop.wallpaper) {
                        window.VCPDesktop.wallpaper.apply(wallpaperConfig);
                    }

                    if (window.VCPDesktop.globalSettings?.save) {
                        window.VCPDesktop.globalSettings.save();
                    }

                    status.update('connected', `AI 推送了新壁纸（${wallpaperConfig.type}）`);
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
    }

    async function _autoSaveWidget(widgetId, saveName, widgetData) {
        try {
            const savedId = `saved-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
            const htmlContent = widgetData.contentBuffer || widgetData.contentContainer?.innerHTML || '';

            if (!htmlContent || !desktopApi?.desktopSaveWidget) {
                return null;
            }

            let thumbnail = '';
            try {
                const rect = widgetData.element.getBoundingClientRect();
                if (desktopApi.desktopCaptureWidget) {
                    const captureResult = await desktopApi.desktopCaptureWidget({
                        x: Math.round(rect.x),
                        y: Math.round(rect.y),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                    });
                    if (captureResult?.success) {
                        thumbnail = captureResult.thumbnail;
                    }
                }
            } catch (error) {
                console.warn('[Desktop IPC] Thumbnail capture failed:', error.message);
            }

            const result = await desktopApi.desktopSaveWidget({
                id: savedId,
                name: saveName,
                html: htmlContent,
                thumbnail,
            });

            if (result?.success) {
                widgetData.savedName = saveName;
                widgetData.savedId = savedId;
                if (window.VCPDesktop?.sidebar?.refresh) {
                    window.VCPDesktop.sidebar.refresh();
                } else if (window.VCPDesktop?.favorites?.loadList) {
                    window.VCPDesktop.favorites.loadList();
                }
                return { id: savedId, name: saveName };
            }

            return null;
        } catch (err) {
            console.error('[Desktop IPC] Auto-save error:', err);
            return null;
        }
    }

    async function _captureAndUpdateThumbnail(savedId, widgetData) {
        try {
            await new Promise((resolve) => setTimeout(resolve, 1000));

            if (!desktopApi?.desktopCaptureWidget || !desktopApi?.desktopSaveWidget) {
                return;
            }

            const rect = widgetData.element.getBoundingClientRect();
            const captureResult = await desktopApi.desktopCaptureWidget({
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            });

            if (captureResult?.success && captureResult.thumbnail) {
                const htmlContent = widgetData.contentBuffer || widgetData.contentContainer?.innerHTML || '';
                await desktopApi.desktopSaveWidget({
                    id: savedId,
                    name: widgetData.savedName || 'AI Widget',
                    html: htmlContent,
                    thumbnail: captureResult.thumbnail,
                });
            }
        } catch (error) {
            console.warn('[Desktop IPC] _captureAndUpdateThumbnail error:', error.message);
        }
    }

    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.ipc = {
        init: initIpcListeners,
    };
})();
