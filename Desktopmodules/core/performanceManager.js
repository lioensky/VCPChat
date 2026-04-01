/**
 * Desktopmodules/core/performanceManager.js
 * 桌面性能管理中枢
 * 负责：记录各挂件 JS 执行时长、获取进程级指标、计算 CPU 估算百分比
 */

class PerformanceManager {
    constructor() {
        this.active = false;
        this.widgetStats = new Map(); // id -> { totalTime: ms, lastSnapshotTime: ms }
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
     * 获取当前快照
     */
    async getSnapshot() {
        const now = performance.now();
        const deltaTotal = now - this.lastTotalTick;
        
        // 1. 获取 Electron 进程指标
        let processData = [];
        try {
            const res = await window.electronAPI.desktopMetricsGetDetailedProcesses();
            if (res.success) {
                processData = res.data;
            }
        } catch (e) {
            console.error('[PerformanceManager] Failed to fetch process metrics:', e);
        }

        // 2. 计算挂件 CPU 占用比例 (JS 线程占比)
        const widgetMetrics = [];
        this.widgetStats.forEach((stats, id) => {
            const cpuUsage = (stats.totalTime / deltaTotal) * 100;
            widgetMetrics.push({
                id,
                cpuUsage: Math.min(100, Math.round(cpuUsage * 10) / 10), // 保留一位小数
                executionTimeMs: Math.round(stats.totalTime)
            });
            // 重置该周期的累加计秒
            stats.totalTime = 0;
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
