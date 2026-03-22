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
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.ipc = {
        init: initIpcListeners,
    };

})();