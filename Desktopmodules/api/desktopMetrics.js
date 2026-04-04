/**
 * VCPdesktop - 桌面指标服务模块
 * 负责：封装系统指标 IPC、能力缓存、格式化工具，供内置监控挂件调用
 */

'use strict';

(function () {
    const desktopApi = window.desktopAPI || window.electronAPI;
    let _capabilitiesCache = null;
    let _capabilitiesUpdatedAt = 0;
    const COMPONENT_DEFINITIONS = [
        { key: 'cpu', label: 'CPU', capabilityKeys: ['cpu', 'loadAverage', 'interrupts'] },
        { key: 'memory', label: 'RAM', capabilityKeys: ['memory', 'swap', 'pageFaults'] },
        { key: 'disk', label: '磁盘', capabilityKeys: ['disk'] },
        { key: 'network', label: '网络', capabilityKeys: ['network'] },
        { key: 'gpu', label: 'GPU', capabilityKeys: ['gpu', 'power'] },
        { key: 'battery', label: '电池', capabilityKeys: ['battery', 'power'] },
        { key: 'docker', label: 'Docker', capabilityKeys: ['docker'] },
        { key: 'sensors', label: '传感器', capabilityKeys: ['sensors'] },
        { key: 'processes', label: '进程', capabilityKeys: ['processes'] },
    ];
    const COMPONENT_MAP = COMPONENT_DEFINITIONS.reduce((acc, item) => {
        acc[item.key] = item;
        return acc;
    }, {});
    const COMPONENT_ALIASES = {
        ram: 'memory',
        mem: 'memory',
        storage: 'disk',
        net: 'network',
        nic: 'network',
        process: 'processes',
        proc: 'processes',
        sensor: 'sensors',
    };

    function createUnavailableCapabilities(message) {
        return {
            platform: 'unknown',
            routes: {
                primary: 'renderer-unavailable',
                detail: message || '宿主层未提供桌面指标接口',
            },
            providers: {},
            metrics: {
                cpu: 'unsupported',
                memory: 'unsupported',
                disk: 'unsupported',
                network: 'unsupported',
                battery: 'unsupported',
                docker: 'unsupported',
                gpu: 'unsupported',
                sensors: 'unsupported',
                processes: 'unsupported',
                loadAverage: 'unsupported',
                interrupts: 'unsupported',
                pageFaults: 'unsupported',
                swap: 'unsupported',
                power: 'unsupported',
                voltage: 'unsupported',
                fans: 'unsupported',
            },
        };
    }

    function createUnavailableSnapshot(message) {
        return {
            collectedAt: new Date().toISOString(),
            platform: 'unknown',
            route: {
                primary: 'renderer-unavailable',
                detail: message || '宿主层未提供桌面指标接口',
            },
            cpu: null,
            memory: null,
            disk: null,
            network: null,
            battery: null,
            docker: null,
            gpu: null,
            sensors: null,
            system: null,
            processes: null,
            capabilities: createUnavailableCapabilities(message),
            error: message || 'desktop metrics unavailable',
        };
    }

    async function getCapabilities(forceRefresh) {
        const now = Date.now();
        if (!forceRefresh && _capabilitiesCache && (now - _capabilitiesUpdatedAt) < 30000) {
            return _capabilitiesCache;
        }

        if (!desktopApi?.desktopMetricsGetCapabilities) {
            _capabilitiesCache = createUnavailableCapabilities('desktopMetricsGetCapabilities 不可用');
            _capabilitiesUpdatedAt = now;
            return _capabilitiesCache;
        }

        try {
            const result = await desktopApi.desktopMetricsGetCapabilities();
            if (result?.success && result.data) {
                _capabilitiesCache = result.data;
                _capabilitiesUpdatedAt = now;
                return _capabilitiesCache;
            }
            _capabilitiesCache = createUnavailableCapabilities(result?.error || '能力探测失败');
            _capabilitiesUpdatedAt = now;
            return _capabilitiesCache;
        } catch (err) {
            _capabilitiesCache = createUnavailableCapabilities(err.message);
            _capabilitiesUpdatedAt = now;
            return _capabilitiesCache;
        }
    }

    async function getSnapshot(options) {
        const capabilities = await getCapabilities(false);

        if (!desktopApi?.desktopMetricsGetSnapshot) {
            return createUnavailableSnapshot('desktopMetricsGetSnapshot 不可用');
        }

        try {
            const result = await desktopApi.desktopMetricsGetSnapshot(options || {});
            if (result?.success && result.data) {
                if (result.data.capabilities) {
                    _capabilitiesCache = result.data.capabilities;
                    _capabilitiesUpdatedAt = Date.now();
                }
                return result.data;
            }
            return createUnavailableSnapshot(result?.error || '获取快照失败');
        } catch (err) {
            const snapshot = createUnavailableSnapshot(err.message);
            snapshot.capabilities = capabilities;
            return snapshot;
        }
    }

    function normalizeComponentKey(component) {
        const key = String(component || '').trim().toLowerCase();
        if (!key) return null;
        return COMPONENT_MAP[key] ? key : (COMPONENT_ALIASES[key] || null);
    }

    function pickBestStatus(statuses) {
        const list = Array.isArray(statuses) ? statuses : [];
        if (list.includes('supported')) return 'supported';
        if (list.includes('permission_denied')) return 'permission_denied';
        if (list.includes('provider_missing')) return 'provider_missing';
        if (list.includes('error')) return 'error';
        return 'unsupported';
    }

    function getComponentStatus(component, capabilities) {
        const componentKey = normalizeComponentKey(component);
        const definition = componentKey ? COMPONENT_MAP[componentKey] : null;
        if (!definition || !capabilities?.metrics) return 'unsupported';
        const statuses = definition.capabilityKeys.map((key) => capabilities.metrics[key]).filter(Boolean);
        return pickBestStatus(statuses);
    }

    function buildComponentSnapshot(component, snapshot) {
        const componentKey = normalizeComponentKey(component);
        const definition = componentKey ? COMPONENT_MAP[componentKey] : null;
        if (!definition) {
            throw new Error(`未知指标组件: ${component}`);
        }

        return {
            key: componentKey,
            label: definition.label,
            status: getComponentStatus(componentKey, snapshot?.capabilities),
            collectedAt: snapshot?.collectedAt || new Date().toISOString(),
            platform: snapshot?.platform || 'unknown',
            route: snapshot?.route || { primary: 'renderer-unavailable', detail: '未获取到组件快照' },
            capabilities: snapshot?.capabilities || createUnavailableCapabilities('组件快照不可用'),
            data: snapshot ? snapshot[componentKey] : null,
            snapshot: snapshot || createUnavailableSnapshot('组件快照不可用'),
        };
    }

    async function getComponentSnapshot(component, options) {
        const snapshot = await getSnapshot(options || {});
        return buildComponentSnapshot(component, snapshot);
    }

    function listComponents() {
        return COMPONENT_DEFINITIONS.map((definition) => ({
            key: definition.key,
            label: definition.label,
            capabilityKeys: definition.capabilityKeys.slice(),
        }));
    }

    function createNamedComponentGetter(componentKey) {
        return function (options) {
            return getComponentSnapshot(componentKey, options);
        };
    }

    function formatBytes(bytes) {
        if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '--';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = bytes;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex++;
        }
        const digits = value >= 100 || unitIndex === 0 ? 0 : 1;
        return `${value.toFixed(digits)} ${units[unitIndex]}`;
    }

    function formatRate(bytesPerSec) {
        if (typeof bytesPerSec !== 'number' || !isFinite(bytesPerSec) || bytesPerSec < 0) return '--';
        return `${formatBytes(bytesPerSec)}/s`;
    }

    function formatPercent(value) {
        if (typeof value !== 'number' || !isFinite(value)) return '--';
        return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
    }

    function formatDuration(seconds) {
        if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '--';
        const totalMinutes = Math.floor(seconds / 60);
        const days = Math.floor(totalMinutes / 1440);
        const hours = Math.floor((totalMinutes % 1440) / 60);
        const minutes = totalMinutes % 60;

        if (days > 0) return `${days}天 ${hours}小时`;
        if (hours > 0) return `${hours}小时 ${minutes}分钟`;
        return `${minutes}分钟`;
    }

    function summarizeStatus(status) {
        switch (status) {
            case 'supported':
                return '可用';
            case 'provider_missing':
                return '缺少提供方';
            case 'permission_denied':
                return '权限不足';
            case 'error':
                return '采集失败';
            case 'unsupported':
            default:
                return '不支持';
        }
    }

    const componentApi = {
        getCpuSnapshot: createNamedComponentGetter('cpu'),
        getMemorySnapshot: createNamedComponentGetter('memory'),
        getDiskSnapshot: createNamedComponentGetter('disk'),
        getNetworkSnapshot: createNamedComponentGetter('network'),
        getGpuSnapshot: createNamedComponentGetter('gpu'),
        getBatterySnapshot: createNamedComponentGetter('battery'),
        getDockerSnapshot: createNamedComponentGetter('docker'),
        getSensorsSnapshot: createNamedComponentGetter('sensors'),
        getProcessesSnapshot: createNamedComponentGetter('processes'),
    };

    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.metrics = {
        getCapabilities,
        getSnapshot,
        getComponentSnapshot,
        getComponentStatus,
        listComponents,
        normalizeComponentKey,
        formatBytes,
        formatRate,
        formatPercent,
        formatDuration,
        summarizeStatus,
        ...componentApi,
    };
})();
