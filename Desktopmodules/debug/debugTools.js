/**
 * VCPdesktop - 调试工具模块
 * 负责：暴露调试接口到 window.__desktopDebug
 */

'use strict';

(function () {
    const { state, widget } = window.VCPDesktop;

    /**
     * 初始化调试工具
     */
    function initDebugTools() {
        window.__desktopDebug = {
            // 核心 widget 操作
            createWidget: widget.create,
            appendWidgetContent: widget.appendContent,
            finalizeWidget: widget.finalize,
            removeWidget: widget.remove,
            clearAllWidgets: widget.clearAll,

            // 状态查询
            getState: () => state,

            // 内置挂件
            spawnWeatherWidget: () => {
                if (window.VCPDesktop.builtinWeather) {
                    window.VCPDesktop.builtinWeather.spawn();
                }
            },
            spawnMusicWidget: () => {
                if (window.VCPDesktop.builtinMusic) {
                    window.VCPDesktop.builtinMusic.spawn();
                }
            },
            spawnNewsWidget: () => {
                if (window.VCPDesktop.builtinNews) {
                    window.VCPDesktop.builtinNews.spawn();
                }
            },

            // 测试挂件
            test: () => {
                const id = 'test-' + Date.now();
                widget.create(id, { x: 200, y: 150, width: 300, height: 180 });

                let html = '';
                const chunks = [
                    '<div style="padding:16px; background:rgba(0,0,0,0.3); border-radius:12px; color:#fff; font-family:sans-serif;">',
                    '<h2 style="margin:0 0 8px 0; font-size:18px;">🌤 武汉 · 多云</h2>',
                    '<p style="margin:0; font-size:32px; font-weight:bold;">18°C</p>',
                    '<p style="margin:4px 0 0 0; font-size:12px; opacity:0.6;">湿度 65% · 东风 3级</p>',
                    '</div>'
                ];

                let i = 0;
                const interval = setInterval(() => {
                    if (i >= chunks.length) {
                        clearInterval(interval);
                        widget.finalize(id);
                        return;
                    }
                    html += chunks[i];
                    widget.appendContent(id, html.slice(0));
                    const wd = state.widgets.get(id);
                    if (wd) {
                        wd.contentBuffer = html;
                        wd.contentContainer.innerHTML = html;
                    }
                    i++;
                }, 300);

                return id;
            },
        };
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.debug = {
        init: initDebugTools,
    };

})();