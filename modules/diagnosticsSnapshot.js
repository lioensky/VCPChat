'use strict';

// 一次性诊断快照：把主进程能看到的东西合成一份 JSON 写到 userData/diagnostics 下——每个进程的 CPU / 内存
// （app.getAppMetrics）、窗口和 WebContents 的可见性与节流状态、以及 lifecycle:get-main-snapshot 同一份
// 生命周期快照（含主窗口响应性记录）。用户反馈"卡住 / 发热"时导出一份即可随手附上。
// 只记录数字、类型、状态和 id：不含聊天内容、窗口标题、页面 URL 或文件路径。

const SCHEMA = 'vcpchat-diagnostics/1';

function round(value, digits = 2) {
    return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function pad(value) {
    return String(value).padStart(2, '0');
}

function fileStamp(date) {
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate())
        + '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

function createDiagnosticsExporter({
    app,
    BrowserWindow,
    webContents,
    process: proc = process,
    os = require('os'),
    fs = require('fs'),
    path = require('path'),
    getLifecycleSnapshot = () => null,
    getTerminalSnapshot = () => null,
    now = () => new Date(),
} = {}) {
    if (!app) throw new TypeError('createDiagnosticsExporter requires app');

    function section(errors, name, produce, fallback = null) {
        try {
            return produce();
        } catch (error) {
            errors.push({ section: name, error: error?.message || String(error) });
            return fallback;
        }
    }

    function describeApp() {
        return {
            name: typeof app.getName === 'function' ? app.getName() : (app.name ?? null),
            version: typeof app.getVersion === 'function' ? app.getVersion() : null,
            packaged: Boolean(app.isPackaged),
            electron: proc.versions?.electron ?? null,
            chrome: proc.versions?.chrome ?? null,
            node: proc.versions?.node ?? null,
            platform: proc.platform ?? null,
            arch: proc.arch ?? null,
            uptimeSeconds: round(typeof proc.uptime === 'function' ? proc.uptime() : null, 1),
        };
    }

    function describeSystem() {
        const memory = typeof proc.getSystemMemoryInfo === 'function' ? proc.getSystemMemoryInfo() : null;
        return {
            cpuCount: Array.isArray(os.cpus?.()) ? os.cpus().length : null,
            totalMemoryKB: memory?.total ?? (typeof os.totalmem === 'function' ? Math.round(os.totalmem() / 1024) : null),
            freeMemoryKB: memory?.free ?? (typeof os.freemem === 'function' ? Math.round(os.freemem() / 1024) : null),
            loadAverage: typeof os.loadavg === 'function' ? os.loadavg().map(value => round(value)) : null,
        };
    }

    function describeMainProcess() {
        const memory = typeof proc.memoryUsage === 'function' ? proc.memoryUsage() : null;
        const cpu = typeof proc.cpuUsage === 'function' ? proc.cpuUsage() : null;
        return {
            pid: proc.pid ?? null,
            rssKB: memory ? Math.round(memory.rss / 1024) : null,
            heapUsedKB: memory ? Math.round(memory.heapUsed / 1024) : null,
            heapTotalKB: memory ? Math.round(memory.heapTotal / 1024) : null,
            externalKB: memory ? Math.round(memory.external / 1024) : null,
            cpuUserMs: cpu ? Math.round(cpu.user / 1000) : null,
            cpuSystemMs: cpu ? Math.round(cpu.system / 1000) : null,
        };
    }

    function describeProcesses() {
        return app.getAppMetrics().map(metric => ({
            pid: metric.pid,
            type: metric.type,
            name: metric.name ?? null,
            serviceName: metric.serviceName ?? null,
            cpuPercent: round(metric.cpu?.percentCPUUsage),
            idleWakeupsPerSecond: metric.cpu?.idleWakeupsPerSecond ?? null,
            workingSetKB: metric.memory?.workingSetSize ?? null,
            peakWorkingSetKB: metric.memory?.peakWorkingSetSize ?? null,
            privateBytesKB: metric.memory?.privateBytes ?? null,
            creationTime: metric.creationTime ?? null,
            sandboxed: metric.sandboxed ?? null,
            integrityLevel: metric.integrityLevel ?? null,
        }));
    }

    function describeWindows() {
        if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') return [];
        return BrowserWindow.getAllWindows().map(win => ({
            id: win.id,
            webContentsId: win.webContents?.id ?? null,
            visible: Boolean(win.isVisible?.()),
            minimized: Boolean(win.isMinimized?.()),
            focused: Boolean(win.isFocused?.()),
        }));
    }

    function describeWebContents() {
        if (!webContents || typeof webContents.getAllWebContents !== 'function') return [];
        return webContents.getAllWebContents().map(contents => {
            const destroyed = Boolean(contents.isDestroyed?.());
            return {
                id: contents.id,
                type: typeof contents.getType === 'function' ? contents.getType() : null,
                destroyed,
                loading: destroyed ? null : Boolean(contents.isLoading?.()),
                backgroundThrottling: !destroyed && typeof contents.getBackgroundThrottling === 'function'
                    ? contents.getBackgroundThrottling()
                    : null,
                ownerWindowId: !destroyed && typeof BrowserWindow?.fromWebContents === 'function'
                    ? (BrowserWindow.fromWebContents(contents)?.id ?? null)
                    : null,
            };
        });
    }

    function collect() {
        const errors = [];
        const createdAt = now();
        return {
            schema: SCHEMA,
            createdAt: createdAt.toISOString(),
            app: section(errors, 'app', describeApp),
            system: section(errors, 'system', describeSystem),
            mainProcess: section(errors, 'mainProcess', describeMainProcess),
            processes: section(errors, 'processes', describeProcesses, []),
            windows: section(errors, 'windows', describeWindows, []),
            webContents: section(errors, 'webContents', describeWebContents, []),
            lifecycle: section(errors, 'lifecycle', getLifecycleSnapshot),
            terminal: section(errors, 'terminal', getTerminalSnapshot),
            errors,
        };
    }

    function defaultDirectory() {
        return path.join(app.getPath('userData'), 'diagnostics');
    }

    async function exportToFile({ directory = defaultDirectory() } = {}) {
        const snapshot = collect();
        const filePath = path.join(directory, 'vcpchat-diagnostics-' + fileStamp(new Date(snapshot.createdAt)) + '.json');
        await fs.promises.mkdir(directory, { recursive: true });
        await fs.promises.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
        return {
            success: true,
            filePath,
            summary: {
                processes: snapshot.processes.length,
                windows: snapshot.windows.length,
                webContents: snapshot.webContents.length,
                errors: snapshot.errors.length,
            },
        };
    }

    return { collect, exportToFile, defaultDirectory };
}

module.exports = { SCHEMA, createDiagnosticsExporter };
