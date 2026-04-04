/**
 * Desktopmodules/core/performanceManager.js
 * 桌面性能管理中枢
 * 负责：记录各挂件 JS 执行时长、获取进程级指标、计算 CPU 估算百分比
 */

class PerformanceManager {
    constructor() {
        this.active = false;
        this.widgetStats = new Map(); // id -> { totalTime: ms, frameCount: 0 }
        this.processStats = [];
        this.timer = null;
        this.lastTotalTick = performance.now();
    }

    start() {
        if (this.active) return;
        this.active = true;
        this.reset();
        console.log('[PerformanceManager] Monitoring started.');
    }

    stop() {
        this.active = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        console.log('[PerformanceManager] Monitoring stopped.');
    }

    reset() {
        this.widgetStats.clear();
        this.lastTotalTick = performance.now();
    }

    /**
     * 进入任务打点
     * @param {string} widgetId 
     */
    taskStart(widgetId) {
        if (!this.active) return null;
        return {
            id: widgetId,
            start: performance.now()
        };
    }

    /**
     * 结束任务打点
     * @param {Object} token taskStart 返回的令牌
     */
    taskEnd(token) {
        if (!this.active || !token) return;
        const duration = performance.now() - token.start;
        const stats = this.widgetStats.get(token.id) || { totalTime: 0 };
        stats.totalTime += duration;
        this.widgetStats.set(token.id, stats);
    }

    /**
     * 记录一次渲染帧触发
     * @param {string} widgetId
     */
    recordFrame(widgetId) {
        if (!this.active) return;
        const stats = this.widgetStats.get(widgetId) || { totalTime: 0, frameCount: 0 };
        stats.frameCount = (stats.frameCount || 0) + 1;
        this.widgetStats.set(widgetId, stats);
    }

    /**
     * 获取当前快照
     */
    async getSnapshot() {
        const now = performance.now();
        const deltaTotal = now - this.lastTotalTick;
        const desktopApi = window.desktopAPI || window.electronAPI;
        
        // 1. 获取 Electron 进程指标
        let processData = [];
        try {
            const res = await desktopApi.desktopMetricsGetDetailedProcesses();
            if (res.success) {
                processData = res.data;
            }
        } catch (e) {
            console.error('[PerformanceManager] Failed to fetch process metrics:', e);
        }

        // 2. 计算挂件 CPU 占用比例 (JS 线程占比)
        const widgetMetrics = [];
        
        // 确保所有当前活跃的挂件都在统计列表中，即使它们在本周期内没有 JS 执行
        const activeWidgetIds = Array.from(window.VCPDesktop.state.widgets.keys());
        
        activeWidgetIds.forEach(id => {
            const stats = this.widgetStats.get(id) || { totalTime: 0 };
            const cpuUsage = (stats.totalTime / deltaTotal) * 100;
            const fps = (stats.frameCount || 0) / (deltaTotal / 1000);
            
            widgetMetrics.push({
                id,
                cpuUsage: Math.min(100, Math.round(cpuUsage * 10) / 10), // 保留一位小数
                fps: Math.round(fps * 10) / 10,
                executionTimeMs: Math.round(stats.totalTime)
            });
            // 重置该周期的累加计秒
            if (this.widgetStats.has(id)) {
                const s = this.widgetStats.get(id);
                s.totalTime = 0;
                s.frameCount = 0;
            }
        });

        // 清理已经不存在的挂件统计数据
        this.widgetStats.forEach((stats, id) => {
            if (!window.VCPDesktop.state.widgets.has(id)) {
                this.widgetStats.delete(id);
            }
        });

        // 3. 获取壁纸状态
        let wallpaperInfo = { type: 'none', source: '' };
        if (window.VCPDesktop.wallpaper) {
            const config = window.VCPDesktop.wallpaper.getConfig();
            wallpaperInfo = {
                type: config.type,
                enabled: config.enabled,
                source: config.source ? config.source.substring(config.source.lastIndexOf('/') + 1) : ''
            };
        }

        this.lastTotalTick = now;

        return {
            timestamp: Date.now(),
            duration: deltaTotal,
            processes: processData,
            widgets: widgetMetrics,
            wallpaper: wallpaperInfo
        };
    }
}

// 导出单例
window.VCPDesktop = window.VCPDesktop || {};
window.VCPDesktop.performanceManager = new PerformanceManager();
