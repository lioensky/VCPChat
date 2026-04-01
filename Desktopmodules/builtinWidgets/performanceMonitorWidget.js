/**
 * Desktopmodules/builtinWidgets/performanceMonitorWidget.js
 * 官方性能监视器挂件
 * 负责：可视化展示各挂件、壁纸和 Docker 本体的 CPU/GPU 估算占用
 */

'use strict';

(function () {
    const { state, CONSTANTS, widget } = window.VCPDesktop;

    /**
     * 创建性能监视器挂件
     */
    function createPerformanceMonitor() {
        const widgetId = 'builtin-performance-monitor';
        
        // 检查是否已存在
        if (state.widgets.has(widgetId)) {
            const w = state.widgets.get(widgetId);
            w.element.scrollIntoView({ behavior: 'smooth' });
            return;
        }

        const html = `
            <style>
                .perf-root { 
                    height: 100%; 
                    min-width: 320px; 
                    color: #fff; 
                    font-family: "Inter", "Segoe UI", sans-serif; 
                    padding: 16px;
                    background: linear-gradient(165deg, rgba(20, 24, 40, 0.95), rgba(35, 25, 50, 0.92));
                    border-radius: 20px;
                    backdrop-filter: blur(20px);
                    box-shadow: 0 20px 50px rgba(0,0,0,0.3);
                    display: flex;
                    flex-direction: column;
                }
                .perf-header { margin-bottom: 16px; display: flex; align-items: center; gap: 10px; }
                .perf-icon { font-size: 20px; }
                .perf-title { font-size: 16px; font-weight: 600; flex: 1; }
                .perf-status { font-size: 10px; padding: 4px 8px; border-radius: 10px; background: rgba(0, 255, 128, 0.15); color: #00ff80; }
                
                .perf-section { margin-bottom: 18px; }
                .perf-section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.5; margin-bottom: 8px; font-weight: 700; }
                
                .perf-item { 
                    display: flex; align-items: center; justify-content: space-between; 
                    padding: 8px 10px; border-radius: 10px; background: rgba(255,255,255,0.03); margin-bottom: 5px;
                    transition: background 0.2s;
                }
                .perf-item:hover { background: rgba(255,255,255,0.06); }
                .perf-item-info { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
                .perf-item-name { font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .perf-item-sub { font-size: 9px; opacity: 0.5; }
                
                .perf-item-value { text-align: right; margin-left: 12px; }
                .perf-cpu-val { font-size: 13px; font-weight: 700; color: #00e0ff; font-family: monospace; }
                .perf-bar-bg { width: 40px; height: 3px; background: rgba(255,255,255,0.1); border-radius: 2px; margin-top: 4px; overflow: hidden; }
                .perf-bar-fill { height: 100%; background: #00e0ff; transition: width 0.5s ease; }
                
                .perf-empty { font-size: 11px; opacity: 0.3; text-align: center; padding: 10px 0; }
                
                .perf-gpu-tag { color: #ff00c8; }
            </style>
            <div class="perf-root">
                <div class="perf-header">
                    <span class="perf-icon">⚡</span>
                    <span class="perf-title">性能监视器</span>
                    <span class="perf-status">实时监控中</span>
                </div>

                <!-- 核心进程 -->
                <div class="perf-section">
                    <div class="perf-section-title">核心负载 (CPU/GPU)</div>
                    <div id="perf-core-list"></div>
                </div>

                <!-- 桌面内容 -->
                <div class="perf-section" style="flex: 1; overflow: auto;">
                    <div class="perf-section-title">活跃挂件 & 壁纸</div>
                    <div id="perf-content-list"></div>
                </div>
                
                <div style="font-size: 9px; opacity: 0.3; text-align: right; margin-top: 5px;">
                    插桩监控已开启 | 刷新率: 1.5s
                </div>
            </div>

            <script>
                (function() {
                    var pm = window.VCPDesktop.performanceManager;
                    var coreList = document.getElementById('perf-core-list');
                    var contentList = document.getElementById('perf-content-list');
                    var updateTimer = null;

                    if (!pm) return;

                    function getTypeLabel(type) {
                        const labels = {
                            'browser': 'Docker 本体 (Main)',
                            'main': 'Docker 本体 (Main)',
                            'gpu-process': '图形渲染引擎 (GPU)',
                            'utility': '系统工具集',
                            'renderer': '桌面展示层',
                            'plugin': '内置插件进程',
                            'sandbox': '沙盒助手'
                        };
                        return labels[type] || type;
                    }

                    function updateUI() {
                        pm.getSnapshot().then(function(snap) {
                            console.log('[PerfMonitor] Snapshot received:', snap);
                            
                            // 1. 更新核心进程
                            var htmlCore = '';
                            if (snap.processes && snap.processes.length > 0) {
                                snap.processes.forEach(function(p) {
                                    // 统计主要的几个进程类型
                                    const mainTypes = ['browser', 'main', 'gpu-process', 'renderer'];
                                    if (mainTypes.indexOf(p.type) !== -1 || p.cpu > 0.5) {
                                        var isGpu = p.type === 'gpu-process';
                                        htmlCore += '<div class="perf-item">' +
                                            '<div class="perf-item-info">' +
                                                '<div class="perf-item-name">' + getTypeLabel(p.type) + '</div>' +
                                                '<div class="perf-item-sub">PID: ' + p.pid + '</div>' +
                                            '</div>' +
                                            '<div class="perf-item-value">' +
                                                '<div class="perf-cpu-val ' + (isGpu ? 'perf-gpu-tag' : '') + '">' + Math.round(p.cpu) + '%</div>' +
                                                '<div class="perf-bar-bg"><div class="perf-bar-fill" style="width: ' + Math.min(100, p.cpu) + '%; background: ' + (isGpu ? '#ff00c8' : '#00e0ff') + '"></div></div>' +
                                            '</div>' +
                                        '</div>';
                                    }
                                });
                            }
                            coreList.innerHTML = htmlCore || '<div class="perf-empty">正在等待进程数据...</div>';

                            // 2. 更新壁纸 & 挂件
                            var htmlContent = '';
                            
                            // 壁纸
                            if (snap.wallpaper && snap.wallpaper.enabled && snap.wallpaper.type !== 'none') {
                                var wpType = snap.wallpaper.type.toUpperCase();
                                htmlContent += '<div class="perf-item" style="border-left: 2px solid #ffaa00;">' +
                                    '<div class="perf-item-info">' +
                                        '<div class="perf-item-name">🖼️ 桌面壁纸 (' + wpType + ')</div>' +
                                        '<div class="perf-item-sub">' + snap.wallpaper.source + '</div>' +
                                    '</div>' +
                                    '<div class="perf-item-value">' +
                                        '<div class="perf-item-sub">高图形优先级</div>' +
                                    '</div>' +
                                '</div>';
                            }

                            // 挂件
                            if (snap.widgets.length === 0) {
                                htmlContent += '<div class="perf-empty">当前没有活跃脚本</div>';
                            } else {
                                // 按 CPU 排序
                                snap.widgets.sort((a,b) => b.cpuUsage - a.cpuUsage);
                                snap.widgets.forEach(function(w) {
                                    var widgetData = window.VCPDesktop.state.widgets.get(w.id);
                                    // 优先显示 ID，如果是内置挂件则尝试转换名称
                                    var name = w.id;
                                    if (name.startsWith('builtin-')) {
                                        const builtinNames = {
                                            'builtin-weather': '天气预报',
                                            'builtin-music': '音乐播放条',
                                            'builtin-news': '今日热点',
                                            'builtin-translate': 'AI 翻译',
                                            'builtin-app-tray': '应用托盘',
                                            'builtin-performance-monitor': '性能监视器',
                                            'builtin-monitor-cpu': 'CPU 监控',
                                            'builtin-monitor-gpu': 'GPU 监控',
                                            'builtin-metrics': '系统监控'
                                        };
                                        name = builtinNames[name] || name;
                                    } else if (widgetData && widgetData.savedName) {
                                        name = widgetData.savedName;
                                    }
                                    
                                    htmlContent += '<div class="perf-item">' +
                                        '<div class="perf-item-info">' +
                                            '<div class="perf-item-name">🧩 ' + name + '</div>' +
                                            '<div class="perf-item-sub">ID: ' + w.id + ' | 活跃: ' + w.executionTimeMs + 'ms</div>' +
                                        '</div>' +
                                        '<div class="perf-item-value">' +
                                            '<div class="perf-cpu-val">' + w.cpuUsage + '%</div>' +
                                            '<div class="perf-bar-bg"><div class="perf-bar-fill" style="width: ' + Math.min(100, w.cpuUsage) + '%"></div></div>' +
                                        '</div>' +
                                    '</div>';
                                });
                            }
                            contentList.innerHTML = htmlContent;
                        });
                    }

                    // 挂载时启动
                    pm.start();
                    updateUI(); // 初始更新
                    updateTimer = setInterval(updateUI, 1500);

                    // 监听销毁（由于是内联 script 在挂件内部，当 DOM 被移除时我们希望停止）
                    // 挂件管理器在销毁时会清除这里的计时器，因为我们在沙箱里覆盖了 setInterval
                })();
            </script>
        `;

        // 1. 创建容器 (widgetId, options)
        const widgetData = widget.create(widgetId, {
            x: 100,
            y: CONSTANTS.TITLE_BAR_HEIGHT + 20,
            width: 320,
            height: 480,
        });

        // 2. 注入 HTML 内容
        widgetData.contentBuffer = html;
        widgetData.contentContainer.innerHTML = html;

        // 3. 处理解析
        widget.processInlineStyles(widgetData);
        
        // 4. 完成构建状态
        widgetData.isConstructing = false;
        widgetData.element.classList.remove('constructing');
        widget.autoResize(widgetData);

        // 5. 延迟解析并运行内部脚本
        setTimeout(function () {
            widget.processInlineScripts(widgetData);
        }, 100);

        console.log('[PerformanceMonitorWidget] Spawned successfully.');
    }

    // 导出门面
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.builtinPerformanceMonitor = {
        spawn: createPerformanceMonitor
    };

    console.log('[PerformanceMonitorWidget] Registered.');
})();
