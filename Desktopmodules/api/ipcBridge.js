/**
 * VCPdesktop - IPC 监听桥接模块
 * 负责：监听来自主窗口的流式推送、状态更新，分发到对应模块
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
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.ipc = {
        init: initIpcListeners,
    };

})();