/**
 * modules/ipc/desktopMetrics.js
 * VCPdesktop 系统指标采集模块
 * 负责：跨平台采集 CPU、内存、磁盘、网络、进程、电池、Docker、GPU 与传感器快照
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { app } = require('electron');
const libreHardwareMonitorBridge = require('./libreHardwareMonitorBridge');

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 8 * 1024 * 1024;

let handlersRegistered = false;
let capabilitiesCache = null;
let capabilitiesCacheAt = 0;

const samplingState = {
    cpu: readCpuSample(),
    network: new Map(),
    linuxVm: null,
    linuxIntr: null,
    processes: new Map(),
};

function readCpuSample() {
    const cpus = os.cpus() || [];
    let total = 0;
    let idle = 0;

    cpus.forEach((cpu) => {
        const times = cpu.times || {};
        const cpuTotal = (times.user || 0) + (times.nice || 0) + (times.sys || 0) + (times.idle || 0) + (times.irq || 0);
        total += cpuTotal;
        idle += times.idle || 0;
    });

    return {
        total,
        idle,
        ts: Date.now(),
    };
}

function roundNumber(value, digits = 1) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    const base = Math.pow(10, digits);
    return Math.round(value * base) / base;
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null) return [];
    return [value];
}

function safeJsonParse(text, fallback = null) {
    try {
        return JSON.parse(text);
    } catch (err) {
        return fallback;
    }
}

function toNumber(value) {
    const parsed = Number(value);
    return isFinite(parsed) ? parsed : null;
}

function toInt(value) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function readTextIfExists(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        return null;
    }
}

function fileExists(filePath) {
    try {
        fs.accessSync(filePath, fs.constants.F_OK);
        return true;
    } catch (err) {
        return false;
    }
}

async function runCommand(file, args, options = {}) {
    const result = await execFileAsync(file, args, {
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        ...options,
    });
    return (result.stdout || '').trim();
}

async function runPowerShell(script) {
    return runCommand('powershell.exe', ['-Command', script]);
}

async function commandExists(command) {
    try {
        if (process.platform === 'win32') {
            await runCommand('where.exe', [command]);
        } else {
            await runCommand('which', [command]);
        }
        return true;
    } catch (err) {
        return false;
    }
}

async function detectLibreHardwareMonitorWmi() {
    if (process.platform !== 'win32') return false;
    try {
        await runPowerShell("Get-CimClass -Namespace 'root/LibreHardwareMonitor' -ClassName Sensor -ErrorAction Stop | Out-Null; 'ok'");
        return true;
    } catch (err) {
        return false;
    }
}

async function probeProviders() {
    const platform = process.platform;
    const providers = {
        base: true,
        docker: await commandExists('docker'),
        nvidiaSmi: await commandExists('nvidia-smi'),
        libreHardwareMonitor: false,
        libreHardwareMonitorDll: false,
        libreHardwareMonitorDllMeta: null,
        libreHardwareMonitorWmi: false,
        sensors: false,
    };

    if (platform === 'win32') {
        const dllProvider = libreHardwareMonitorBridge.probeLibreHardwareMonitorDllProvider();
        providers.libreHardwareMonitorDllMeta = dllProvider || null;
        providers.libreHardwareMonitorDll = !!dllProvider.available;
        providers.libreHardwareMonitorWmi = await detectLibreHardwareMonitorWmi();
        providers.libreHardwareMonitor = providers.libreHardwareMonitorDll || providers.libreHardwareMonitorWmi;
    } else if (platform === 'linux') {
        providers.sensors = (await commandExists('sensors')) || fileExists('/sys/class/hwmon');
    }

    return providers;
}

function buildCapabilities(platform, providers) {
    const sensorsSupported = !!providers.libreHardwareMonitor || !!providers.sensors;
    const powerSupported = !!providers.nvidiaSmi || sensorsSupported;
    let primary = `${platform}-base`;
    let detail = '使用宿主层基础指标采集路线';

    if (platform === 'win32') {
        if (providers.libreHardwareMonitorDll) {
            primary = 'windows-enhanced-dotnet';
            detail = 'Windows 基础指标 + LibreHardwareMonitorLib DLL (electron-edge-js) + 可选 nvidia-smi';
        } else if (providers.libreHardwareMonitorWmi) {
            primary = 'windows-enhanced-wmi';
            detail = 'Windows 基础指标 + LibreHardwareMonitor WMI + 可选 nvidia-smi';
        } else {
            primary = 'windows-base';
            detail = 'Windows 基础指标 + 可选 nvidia-smi；如需主板温度/风扇/电压，请提供 LibreHardwareMonitor 便携版目录中的 LibreHardwareMonitorLib.dll 及其伴随 DLL，或运行 LibreHardwareMonitor 暴露 WMI';
        }
    } else if (platform === 'linux') {
        primary = providers.sensors ? 'linux-procfs-hwmon' : 'linux-procfs';
        detail = providers.sensors
            ? 'Linux /proc + /sys/hwmon + 可选 sensors / nvidia-smi / docker'
            : 'Linux /proc + /sys 基础路线；传感器建议安装 lm-sensors';
    } else if (platform === 'darwin') {
        primary = 'darwin-base';
        detail = 'macOS 基础路线：CPU / 内存 / 磁盘 / 网络 / 电池 / 进程；高级传感器不承诺';
    }

    return {
        platform,
        routes: {
            primary,
            detail,
        },
        providers,
        metrics: {
            cpu: 'supported',
            memory: 'supported',
            disk: 'supported',
            network: 'supported',
            processes: 'supported',
            swap: 'supported',
            battery: 'supported',
            docker: providers.docker ? 'supported' : 'provider_missing',
            gpu: providers.nvidiaSmi ? 'supported' : (platform === 'darwin' ? 'unsupported' : 'provider_missing'),
            sensors: sensorsSupported ? 'supported' : (platform === 'darwin' ? 'unsupported' : 'provider_missing'),
            loadAverage: platform === 'win32' ? 'unsupported' : 'supported',
            interrupts: platform === 'darwin' ? 'unsupported' : 'supported',
            pageFaults: platform === 'darwin' ? 'unsupported' : 'supported',
            power: powerSupported ? 'supported' : 'provider_missing',
            voltage: sensorsSupported ? 'supported' : 'provider_missing',
            fans: sensorsSupported ? 'supported' : 'provider_missing',
        },
    };
}

async function getCapabilities(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && capabilitiesCache && (now - capabilitiesCacheAt) < 30000) {
        return capabilitiesCache;
    }

    const providers = await probeProviders();
    capabilitiesCache = buildCapabilities(process.platform, providers);
    capabilitiesCacheAt = now;
    return capabilitiesCache;
}

function collectCpu() {
    const cpus = os.cpus() || [];
    const currentSample = readCpuSample();
    const previousSample = samplingState.cpu;
    samplingState.cpu = currentSample;

    let usagePct = null;
    if (previousSample && currentSample.total > previousSample.total) {
        const deltaTotal = currentSample.total - previousSample.total;
        const deltaIdle = currentSample.idle - previousSample.idle;
        usagePct = ((deltaTotal - deltaIdle) / deltaTotal) * 100;
    }

    return {
        usagePct: roundNumber(usagePct, 1),
        coreCount: cpus.length,
        model: cpus[0]?.model || null,
    };
}

function collectMemoryBase() {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = totalBytes - freeBytes;
    return {
        totalBytes,
        freeBytes,
        usedBytes,
        usagePct: totalBytes > 0 ? roundNumber((usedBytes / totalBytes) * 100, 1) : null,
        swapTotalBytes: null,
        swapUsedBytes: null,
        swapUsagePct: null,
    };
}

function convertSizedNumber(rawValue, unit) {
    const value = Number(rawValue);
    if (!isFinite(value)) return null;
    switch (String(unit || '').toUpperCase()) {
        case 'K':
            return value * 1024;
        case 'M':
            return value * 1024 * 1024;
        case 'G':
            return value * 1024 * 1024 * 1024;
        default:
            return value;
    }
}

async function collectMemory() {
    const memory = collectMemoryBase();

    if (process.platform === 'linux') {
        const meminfoText = readTextIfExists('/proc/meminfo');
        if (meminfoText) {
            const swapTotalMatch = meminfoText.match(/^SwapTotal:\s+(\d+)\s+kB$/m);
            const swapFreeMatch = meminfoText.match(/^SwapFree:\s+(\d+)\s+kB$/m);
            const swapTotalBytes = swapTotalMatch ? Number(swapTotalMatch[1]) * 1024 : 0;
            const swapFreeBytes = swapFreeMatch ? Number(swapFreeMatch[1]) * 1024 : 0;
            memory.swapTotalBytes = swapTotalBytes;
            memory.swapUsedBytes = Math.max(0, swapTotalBytes - swapFreeBytes);
            memory.swapUsagePct = swapTotalBytes > 0 ? roundNumber((memory.swapUsedBytes / swapTotalBytes) * 100, 1) : null;
        }
    } else if (process.platform === 'win32') {
        try {
            const output = await runPowerShell([
                "$rows = Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue | Select-Object AllocatedBaseSize, CurrentUsage",
                "$total = 0",
                "$used = 0",
                "foreach ($row in $rows) {",
                "  $total += ([double]$row.AllocatedBaseSize * 1MB)",
                "  $used += ([double]$row.CurrentUsage * 1MB)",
                "}",
                "@{ swapTotalBytes = $total; swapUsedBytes = $used } | ConvertTo-Json -Compress",
            ].join('; '));
            const data = safeJsonParse(output, {});
            memory.swapTotalBytes = toNumber(data.swapTotalBytes);
            memory.swapUsedBytes = toNumber(data.swapUsedBytes);
            memory.swapUsagePct = memory.swapTotalBytes > 0 ? roundNumber((memory.swapUsedBytes / memory.swapTotalBytes) * 100, 1) : null;
        } catch (err) {
            memory.swapTotalBytes = null;
            memory.swapUsedBytes = null;
            memory.swapUsagePct = null;
        }
    } else if (process.platform === 'darwin') {
        try {
            const output = await runCommand('sysctl', ['vm.swapusage']);
            const match = output.match(/total = ([0-9.]+)([MGK])\s+used = ([0-9.]+)([MGK])/i);
            if (match) {
                const total = convertSizedNumber(match[1], match[2]);
                const used = convertSizedNumber(match[3], match[4]);
                memory.swapTotalBytes = total;
                memory.swapUsedBytes = used;
                memory.swapUsagePct = total > 0 ? roundNumber((used / total) * 100, 1) : null;
            }
        } catch (err) {
            memory.swapTotalBytes = null;
            memory.swapUsedBytes = null;
            memory.swapUsagePct = null;
        }
    }

    return memory;
}

async function collectDisk() {
    let items = [];

    if (process.platform === 'win32') {
        for (let code = 67; code <= 90; code++) {
            const root = `${String.fromCharCode(code)}:\\`;
            try {
                const stats = fs.statfsSync(root);
                const totalBytes = Number(stats.blocks) * Number(stats.bsize);
                const freeBytes = Number(stats.bavail) * Number(stats.bsize);
                const usedBytes = Math.max(0, totalBytes - freeBytes);
                if (!totalBytes) continue;
                items.push({
                    name: root.slice(0, 2),
                    mount: root,
                    totalBytes,
                    freeBytes,
                    usedBytes,
                    usagePct: roundNumber((usedBytes / totalBytes) * 100, 1),
                });
            } catch (err) {
                // ignore missing drives
            }
        }
    } else {
        try {
            const output = await runCommand('df', ['-Pk']);
            const lines = output.split(/\r?\n/).slice(1).filter(Boolean);
            items = lines.map((line) => {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 6) return null;
                const mount = parts[5];
                const totalBytes = Number(parts[1]) * 1024;
                const usedBytes = Number(parts[2]) * 1024;
                const freeBytes = Number(parts[3]) * 1024;
                return {
                    name: parts[0],
                    mount,
                    totalBytes,
                    freeBytes,
                    usedBytes,
                    usagePct: totalBytes > 0 ? roundNumber((usedBytes / totalBytes) * 100, 1) : null,
                };
            }).filter(Boolean);
        } catch (err) {
            items = [];
        }
    }

    const summary = items.reduce((acc, item) => {
        acc.totalBytes += item.totalBytes || 0;
        acc.usedBytes += item.usedBytes || 0;
        acc.freeBytes += item.freeBytes || 0;
        return acc;
    }, { totalBytes: 0, usedBytes: 0, freeBytes: 0 });

    summary.usagePct = summary.totalBytes > 0 ? roundNumber((summary.usedBytes / summary.totalBytes) * 100, 1) : null;

    return {
        items,
        summary,
    };
}

function shouldSkipInterface(name) {
    const lower = String(name || '').toLowerCase();
    return !lower || lower.includes('loopback') || lower === 'lo' || lower.startsWith('lo');
}

function applyNetworkRates(items) {
    const now = Date.now();
    const previousMap = samplingState.network;
    const nextMap = new Map();
    const totals = {
        rxBytes: 0,
        txBytes: 0,
        rxPerSec: null,
        txPerSec: null,
    };

    let totalRxRate = 0;
    let totalTxRate = 0;
    let hasRate = false;

    items.forEach((item) => {
        const rxBytes = toNumber(item.rxBytes) || 0;
        const txBytes = toNumber(item.txBytes) || 0;
        const previous = previousMap.get(item.name);
        let rxPerSec = null;
        let txPerSec = null;

        if (previous && now > previous.ts) {
            const seconds = (now - previous.ts) / 1000;
            rxPerSec = Math.max(0, (rxBytes - previous.rxBytes) / seconds);
            txPerSec = Math.max(0, (txBytes - previous.txBytes) / seconds);
            totalRxRate += rxPerSec;
            totalTxRate += txPerSec;
            hasRate = true;
        }

        nextMap.set(item.name, {
            rxBytes,
            txBytes,
            ts: now,
        });

        item.rxBytes = rxBytes;
        item.txBytes = txBytes;
        item.rxPerSec = rxPerSec !== null ? roundNumber(rxPerSec, 1) : null;
        item.txPerSec = txPerSec !== null ? roundNumber(txPerSec, 1) : null;

        totals.rxBytes += rxBytes;
        totals.txBytes += txBytes;
    });

    samplingState.network = nextMap;
    totals.rxPerSec = hasRate ? roundNumber(totalRxRate, 1) : null;
    totals.txPerSec = hasRate ? roundNumber(totalTxRate, 1) : null;

    return {
        items,
        totals,
    };
}

async function collectNetwork() {
    let items = [];

    if (process.platform === 'win32') {
        try {
            const output = await runPowerShell([
                "$items = Get-Counter -Counter '\\Network Interface(*)\\Bytes Received/sec','\\Network Interface(*)\\Bytes Sent/sec' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CounterSamples | Select-Object Path, CookedValue",
                "$items | ConvertTo-Json -Compress -Depth 4",
            ].join('; '));
            const rows = asArray(safeJsonParse(output, []));
            const interfaceMap = new Map();
            let totalRxPerSec = 0;
            let totalTxPerSec = 0;

            rows.forEach((entry) => {
                const rawPath = String(entry.Path || '');
                const match = rawPath.match(/network interface\((.+?)\)\\bytes (received|sent)\/sec$/i);
                if (!match) return;
                const name = match[1];
                if (shouldSkipInterface(name)) return;
                const current = interfaceMap.get(name) || {
                    name,
                    rxBytes: null,
                    txBytes: null,
                    rxPerSec: null,
                    txPerSec: null,
                };
                const cookedValue = roundNumber(toNumber(entry.CookedValue), 1);
                if (/received/i.test(match[2])) {
                    current.rxPerSec = cookedValue;
                    totalRxPerSec += cookedValue || 0;
                } else {
                    current.txPerSec = cookedValue;
                    totalTxPerSec += cookedValue || 0;
                }
                interfaceMap.set(name, current);
            });

            items = Array.from(interfaceMap.values());
            return {
                items,
                totals: {
                    rxBytes: null,
                    txBytes: null,
                    rxPerSec: roundNumber(totalRxPerSec, 1),
                    txPerSec: roundNumber(totalTxPerSec, 1),
                },
            };
        } catch (err) {
            items = [];
        }
    } else if (process.platform === 'linux') {
        const netDevText = readTextIfExists('/proc/net/dev');
        if (netDevText) {
            items = netDevText.split(/\r?\n/).slice(2).map((line) => {
                const match = line.match(/^\s*([^:]+):\s*(.+)$/);
                if (!match) return null;
                const name = match[1].trim();
                const columns = match[2].trim().split(/\s+/);
                return {
                    name,
                    rxBytes: Number(columns[0]),
                    txBytes: Number(columns[8]),
                };
            }).filter((entry) => entry && !shouldSkipInterface(entry.name));
        }
    } else if (process.platform === 'darwin') {
        try {
            const output = await runCommand('netstat', ['-ibn']);
            const lines = output.split(/\r?\n/).filter(Boolean);
            const header = lines[0].trim().split(/\s+/);
            const iBytesIndex = header.indexOf('Ibytes');
            const oBytesIndex = header.indexOf('Obytes');
            const perInterface = new Map();

            lines.slice(1).forEach((line) => {
                const parts = line.trim().split(/\s+/);
                if (parts.length <= Math.max(iBytesIndex, oBytesIndex)) return;
                const name = parts[0];
                if (shouldSkipInterface(name)) return;
                const current = perInterface.get(name) || { name, rxBytes: 0, txBytes: 0 };
                current.rxBytes = Math.max(current.rxBytes, Number(parts[iBytesIndex]) || 0);
                current.txBytes = Math.max(current.txBytes, Number(parts[oBytesIndex]) || 0);
                perInterface.set(name, current);
            });

            items = Array.from(perInterface.values());
        } catch (err) {
            items = [];
        }
    }

    return applyNetworkRates(items);
}

function findCounterValue(counterMap, suffix) {
    const target = String(suffix || '').toLowerCase();
    const entry = Object.entries(counterMap || {}).find(([key]) => String(key || '').toLowerCase().endsWith(target));
    return entry ? toNumber(entry[1]) : null;
}

async function collectBattery() {
    if (process.platform === 'win32') {
        try {
            const output = await runPowerShell([
                "$items = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object Name, DeviceID, EstimatedChargeRemaining, BatteryStatus, EstimatedRunTime",
                "$items | ConvertTo-Json -Compress",
            ].join('; '));
            const item = asArray(safeJsonParse(output, [])).find(Boolean);
            if (!item) {
                return { present: false };
            }

            const batteryStatus = toInt(item.BatteryStatus);
            return {
                present: true,
                percent: toNumber(item.EstimatedChargeRemaining),
                isCharging: [6, 7, 8, 9].includes(batteryStatus),
                batteryStatus,
                timeRemainingSec: item.EstimatedRunTime && item.EstimatedRunTime !== 71582788 ? Number(item.EstimatedRunTime) * 60 : null,
                source: 'Win32_Battery',
            };
        } catch (err) {
            return { present: false };
        }
    }

    if (process.platform === 'linux') {
        try {
            const supplyRoot = '/sys/class/power_supply';
            if (!fileExists(supplyRoot)) return { present: false };
            const batteryDirs = fs.readdirSync(supplyRoot).filter((name) => /^BAT/i.test(name));
            if (!batteryDirs.length) return { present: false };
            const batteryDir = path.join(supplyRoot, batteryDirs[0]);
            const percent = toNumber(readTextIfExists(path.join(batteryDir, 'capacity')));
            const status = (readTextIfExists(path.join(batteryDir, 'status')) || '').trim();
            const powerNow = toNumber(readTextIfExists(path.join(batteryDir, 'power_now')));
            const energyNow = toNumber(readTextIfExists(path.join(batteryDir, 'energy_now')));
            const chargeNow = toNumber(readTextIfExists(path.join(batteryDir, 'charge_now')));
            const voltageNow = toNumber(readTextIfExists(path.join(batteryDir, 'voltage_now')));
            const energyFull = toNumber(readTextIfExists(path.join(batteryDir, 'energy_full')));
            const chargeFull = toNumber(readTextIfExists(path.join(batteryDir, 'charge_full')));

            let timeRemainingSec = null;
            let powerWatts = null;

            if (powerNow && powerNow > 0) {
                powerWatts = powerNow / 1000000;
                const currentEnergy = energyNow !== null ? energyNow : (chargeNow !== null && voltageNow !== null ? (chargeNow * voltageNow) / 1000000 : null);
                const fullEnergy = energyFull !== null ? energyFull : (chargeFull !== null && voltageNow !== null ? (chargeFull * voltageNow) / 1000000 : null);
                if (currentEnergy !== null) {
                    const remainingEnergy = /^charging$/i.test(status) && fullEnergy !== null ? Math.max(0, fullEnergy - currentEnergy) : currentEnergy;
                    timeRemainingSec = Math.floor((remainingEnergy / powerNow) * 3600);
                }
            }

            return {
                present: true,
                percent,
                isCharging: /^charging$/i.test(status),
                status,
                timeRemainingSec,
                powerWatts: roundNumber(powerWatts, 2),
                source: 'sysfs',
            };
        } catch (err) {
            return { present: false };
        }
    }

    if (process.platform === 'darwin') {
        try {
            const output = await runCommand('pmset', ['-g', 'batt']);
            const percentMatch = output.match(/(\d+)%/);
            if (!percentMatch) return { present: false };
            const isCharging = /charging/i.test(output);
            const timeMatch = output.match(/(\d+):(\d+)\s+remaining/i);
            let timeRemainingSec = null;
            if (timeMatch) {
                timeRemainingSec = (Number(timeMatch[1]) * 60 + Number(timeMatch[2])) * 60;
            }
            return {
                present: true,
                percent: Number(percentMatch[1]),
                isCharging,
                timeRemainingSec,
                source: 'pmset',
            };
        } catch (err) {
            return { present: false };
        }
    }

    return { present: false };
}

function parsePercentString(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/([0-9.]+)\s*%/);
    return match ? roundNumber(Number(match[1]), 1) : null;
}

async function collectDocker(includeDocker, providers) {
    if (includeDocker === false) {
        return {
            available: false,
            skipped: true,
        };
    }

    if (!providers.docker) {
        return {
            available: false,
            reason: 'provider_missing',
        };
    }

    try {
        const infoText = await runCommand('docker', ['info', '--format', '{{json .}}']);
        const statsText = await runCommand('docker', ['stats', '--no-stream', '--format', '{{json .}}']);
        const info = safeJsonParse(infoText, {});
        const stats = statsText.split(/\r?\n/).filter(Boolean).map((line) => safeJsonParse(line, null)).filter(Boolean);

        return {
            available: true,
            containersTotal: toInt(info.Containers) || 0,
            containersRunning: toInt(info.ContainersRunning) || 0,
            stats: stats.slice(0, 8).map((entry) => ({
                name: entry.Name || entry.Container || 'container',
                cpuPercent: parsePercentString(entry.CPUPerc),
                memPercent: parsePercentString(entry.MemPerc),
                memUsage: entry.MemUsage || null,
                netIO: entry.NetIO || null,
                blockIO: entry.BlockIO || null,
            })),
            source: 'docker',
        };
    } catch (err) {
        return {
            available: false,
            reason: 'error',
            error: err.message,
        };
    }
}

async function collectGpu(providers) {
    if (!providers.nvidiaSmi) {
        return {
            available: false,
            reason: 'provider_missing',
            cards: [],
        };
    }

    try {
        const output = await runCommand('nvidia-smi', [
            '--query-gpu=name,utilization.gpu,utilization.memory,memory.total,memory.used,temperature.gpu,fan.speed,power.draw',
            '--format=csv,noheader,nounits',
        ]);

        const cards = output.split(/\r?\n/).filter(Boolean).map((line) => {
            const parts = line.split(/\s*,\s*/);
            return {
                name: parts[0] || 'NVIDIA GPU',
                utilizationGpuPct: roundNumber(Number(parts[1]), 1),
                utilizationMemoryPct: roundNumber(Number(parts[2]), 1),
                memoryTotalMB: roundNumber(Number(parts[3]), 0),
                memoryUsedMB: roundNumber(Number(parts[4]), 0),
                temperatureC: roundNumber(Number(parts[5]), 1),
                fanPercent: roundNumber(Number(parts[6]), 1),
                powerWatts: roundNumber(Number(parts[7]), 1),
                source: 'nvidia-smi',
            };
        });

        return {
            available: cards.length > 0,
            cards,
            source: 'nvidia-smi',
        };
    } catch (err) {
        return {
            available: false,
            reason: 'error',
            error: err.message,
            cards: [],
        };
    }
}

async function collectSensors(providers) {
    if (process.platform === 'win32') {
        return collectWindowsSensors(providers);
    }

    if (process.platform === 'linux') {
        return collectLinuxSensors(providers);
    }

    return {
        temperatures: [],
        fans: [],
        voltages: [],
        powers: [],
        source: 'unsupported',
    };
}

async function collectWindowsSensors(providers) {
    let dllError = null;

    if (providers.libreHardwareMonitorDll) {
        try {
            return await libreHardwareMonitorBridge.collectLibreHardwareMonitorDllSensors();
        } catch (err) {
            dllError = err;
            console.warn('[DesktopMetrics] LibreHardwareMonitor DLL bridge failed:', err.message);
        }
    }

    if (providers.libreHardwareMonitorWmi) {
        return collectWindowsSensorsFromWmi(dllError);
    }

    if (!providers.libreHardwareMonitor) {
        const dllProbeError = providers.libreHardwareMonitorDllMeta && providers.libreHardwareMonitorDllMeta.error
            ? String(providers.libreHardwareMonitorDllMeta.error)
            : null;
        return {
            temperatures: [],
            fans: [],
            voltages: [],
            powers: [],
            source: 'provider_missing',
            error: dllError ? dllError.message : (dllProbeError || undefined),
        };
    }
}

async function collectWindowsSensorsFromWmi(fallbackError) {
    try {
        const output = await runPowerShell([
            "$items = Get-CimInstance -Namespace 'root/LibreHardwareMonitor' -Class Sensor -ErrorAction Stop |",
            "  Select-Object Name, SensorType, Identifier, Value",
            "$items | ConvertTo-Json -Compress -Depth 4",
        ].join('; '));

        const entries = asArray(safeJsonParse(output, []));
        const sensors = {
            temperatures: [],
            fans: [],
            voltages: [],
            powers: [],
            source: 'LibreHardwareMonitor',
        };

        entries.forEach((entry) => {
            const sensorType = String(entry.SensorType || '').toLowerCase();
            const base = {
                name: entry.Name || entry.Identifier || sensorType || 'sensor',
                source: 'LibreHardwareMonitor',
            };
            const value = toNumber(entry.Value);
            if (value === null) return;

            if (sensorType === 'temperature') {
                sensors.temperatures.push({ ...base, valueC: roundNumber(value, 1) });
            } else if (sensorType === 'fan') {
                sensors.fans.push({ ...base, rpm: roundNumber(value, 0) });
            } else if (sensorType === 'voltage') {
                sensors.voltages.push({ ...base, volts: roundNumber(value, 3) });
            } else if (sensorType === 'power') {
                sensors.powers.push({ ...base, watts: roundNumber(value, 1) });
            }
        });

        return sensors;
    } catch (err) {
        return {
            temperatures: [],
            fans: [],
            voltages: [],
            powers: [],
            source: 'LibreHardwareMonitor',
            error: fallbackError ? `${fallbackError.message}; WMI fallback failed: ${err.message}` : err.message,
        };
    }
}

async function collectLinuxSensors() {
    try {
        if (await commandExists('sensors')) {
            const output = await runCommand('sensors', ['-j']);
            const data = safeJsonParse(output, {});
            return parseLinuxSensorsJson(data);
        }
    } catch (err) {
        // fallback below
    }

    if (!fileExists('/sys/class/hwmon')) {
        return {
            temperatures: [],
            fans: [],
            voltages: [],
            powers: [],
            source: 'provider_missing',
        };
    }

    const sensors = {
        temperatures: [],
        fans: [],
        voltages: [],
        powers: [],
        source: 'hwmon',
    };

    try {
        const root = '/sys/class/hwmon';
        const dirs = fs.readdirSync(root);
        dirs.forEach((dirName) => {
            const dirPath = path.join(root, dirName);
            const chipName = (readTextIfExists(path.join(dirPath, 'name')) || dirName).trim();
            const files = fs.readdirSync(dirPath);
            files.forEach((fileName) => {
                const filePath = path.join(dirPath, fileName);
                const raw = readTextIfExists(filePath);
                if (raw === null) return;
                const value = Number(String(raw).trim());
                if (!isFinite(value)) return;

                if (/^temp\d+_input$/i.test(fileName)) {
                    sensors.temperatures.push({ name: `${chipName} ${fileName}`, valueC: roundNumber(value / 1000, 1), source: 'hwmon' });
                } else if (/^fan\d+_input$/i.test(fileName)) {
                    sensors.fans.push({ name: `${chipName} ${fileName}`, rpm: roundNumber(value, 0), source: 'hwmon' });
                } else if (/^in\d+_input$/i.test(fileName)) {
                    sensors.voltages.push({ name: `${chipName} ${fileName}`, volts: roundNumber(value / 1000, 3), source: 'hwmon' });
                } else if (/^power\d+_input$/i.test(fileName)) {
                    sensors.powers.push({ name: `${chipName} ${fileName}`, watts: roundNumber(value / 1000000, 2), source: 'hwmon' });
                }
            });
        });
    } catch (err) {
        sensors.error = err.message;
    }

    return sensors;
}

function parseLinuxSensorsJson(data) {
    const sensors = {
        temperatures: [],
        fans: [],
        voltages: [],
        powers: [],
        source: 'lm-sensors',
    };

    Object.entries(data || {}).forEach(([chipName, chipValue]) => {
        if (!chipValue || typeof chipValue !== 'object') return;
        Object.entries(chipValue).forEach(([entryKey, entryValue]) => {
            if (!entryValue || typeof entryValue !== 'object' || Array.isArray(entryValue)) return;
            const label = entryValue[`${entryKey}_label`] || entryKey;
            Object.entries(entryValue).forEach(([metricKey, metricValue]) => {
                const numericValue = toNumber(metricValue);
                if (numericValue === null) return;
                if (/_input$/i.test(metricKey) && /^temp/i.test(metricKey)) {
                    sensors.temperatures.push({ name: `${chipName} ${label}`, valueC: roundNumber(numericValue, 1), source: 'lm-sensors' });
                } else if (/_input$/i.test(metricKey) && /^fan/i.test(metricKey)) {
                    sensors.fans.push({ name: `${chipName} ${label}`, rpm: roundNumber(numericValue, 0), source: 'lm-sensors' });
                } else if (/_input$/i.test(metricKey) && /^in/i.test(metricKey)) {
                    sensors.voltages.push({ name: `${chipName} ${label}`, volts: roundNumber(numericValue, 3), source: 'lm-sensors' });
                } else if (/_input$/i.test(metricKey) && /^power/i.test(metricKey)) {
                    sensors.powers.push({ name: `${chipName} ${label}`, watts: roundNumber(numericValue, 1), source: 'lm-sensors' });
                }
            });
        });
    });

    return sensors;
}

async function collectProcesses(includeProcesses) {
    if (includeProcesses === false) {
        return {
            running: null,
            topCpu: [],
            topMemory: [],
            skipped: true,
        };
    }

    if (process.platform === 'win32') {
        try {
            const output = await runPowerShell([
                "$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName }",
                "$rows = $procs | Select-Object Name, Id, CPU, WS",
                "@{ running = $procs.Count; rows = $rows } | ConvertTo-Json -Compress -Depth 4",
            ].join('; '));
            const data = safeJsonParse(output, {});
            const now = Date.now();
            const currentRows = asArray(data.rows).map((entry) => ({
                pid: toInt(entry.Id),
                name: entry.Name || 'process',
                cpuSeconds: roundNumber(toNumber(entry.CPU), 3),
                memoryBytes: toNumber(entry.WS),
            })).filter((entry) => entry.pid);
            const nextProcessMap = new Map();

            currentRows.forEach((entry) => {
                const previous = samplingState.processes.get(entry.pid);
                let cpuPercent = null;
                if (previous && previous.ts && now > previous.ts && entry.cpuSeconds !== null && previous.cpuSeconds !== null) {
                    const elapsedSec = (now - previous.ts) / 1000;
                    const deltaCpuSec = entry.cpuSeconds - previous.cpuSeconds;
                    if (elapsedSec > 0 && deltaCpuSec >= 0) {
                        cpuPercent = roundNumber((deltaCpuSec / elapsedSec) * 100, 1);
                    }
                }
                entry.cpuPercent = cpuPercent;
                nextProcessMap.set(entry.pid, {
                    cpuSeconds: entry.cpuSeconds,
                    ts: now,
                });
            });
            samplingState.processes = nextProcessMap;

            const topCpu = currentRows
                .slice()
                .sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1))
                .slice(0, 8);
            const topMemory = currentRows
                .slice()
                .sort((a, b) => (b.memoryBytes || 0) - (a.memoryBytes || 0))
                .slice(0, 8);

            return {
                running: toInt(data.running),
                topCpu,
                topMemory,
            };
        } catch (err) {
            return {
                running: null,
                topCpu: [],
                topMemory: [],
                error: err.message,
            };
        }
    }

    try {
        const output = await runCommand('ps', ['-eo', 'pid=,comm=,%cpu=,%mem=,rss=', '--sort=-%cpu']);
        const rows = output.split(/\r?\n/).filter(Boolean).map((line) => {
            const parts = line.trim().split(/\s+/, 5);
            return {
                pid: Number(parts[0]),
                name: parts[1],
                cpuPercent: roundNumber(Number(parts[2]), 1),
                memoryPercent: roundNumber(Number(parts[3]), 1),
                memoryBytes: Number(parts[4]) * 1024,
            };
        }).filter((entry) => entry.pid);

        const topCpu = rows.slice(0, 8);
        const topMemory = rows.slice().sort((a, b) => (b.memoryBytes || 0) - (a.memoryBytes || 0)).slice(0, 8);
        return {
            running: rows.length,
            topCpu,
            topMemory,
        };
    } catch (err) {
        return {
            running: null,
            topCpu: [],
            topMemory: [],
            error: err.message,
        };
    }
}

function parseLinuxVmStat() {
    const text = readTextIfExists('/proc/vmstat');
    if (!text) return null;
    const faultsMatch = text.match(/^pgfault\s+(\d+)$/m);
    const majorMatch = text.match(/^pgmajfault\s+(\d+)$/m);
    return {
        faults: faultsMatch ? Number(faultsMatch[1]) : null,
        majorFaults: majorMatch ? Number(majorMatch[1]) : null,
        ts: Date.now(),
    };
}

function parseLinuxInterrupts() {
    const text = readTextIfExists('/proc/stat');
    if (!text) return null;
    const match = text.match(/^intr\s+(\d+)$/m);
    if (!match) return null;
    return {
        total: Number(match[1]),
        ts: Date.now(),
    };
}

async function collectSystem() {
    const system = {
        uptimeSec: roundNumber(os.uptime(), 0),
        loadAverage: process.platform === 'win32' ? null : os.loadavg().map((value) => roundNumber(value, 2)),
        interruptsPerSec: null,
        pageFaultsPerSec: null,
        majorPageFaultsPerSec: null,
        pagesPerSec: null,
    };

    if (process.platform === 'linux') {
        const currentVm = parseLinuxVmStat();
        const currentIntr = parseLinuxInterrupts();
        const previousVm = samplingState.linuxVm;
        const previousIntr = samplingState.linuxIntr;
        samplingState.linuxVm = currentVm;
        samplingState.linuxIntr = currentIntr;

        if (currentIntr && previousIntr && currentIntr.ts > previousIntr.ts) {
            const seconds = (currentIntr.ts - previousIntr.ts) / 1000;
            system.interruptsPerSec = roundNumber((currentIntr.total - previousIntr.total) / seconds, 1);
        }
        if (currentVm && previousVm && currentVm.ts > previousVm.ts) {
            const seconds = (currentVm.ts - previousVm.ts) / 1000;
            if (currentVm.faults !== null && previousVm.faults !== null) {
                system.pageFaultsPerSec = roundNumber((currentVm.faults - previousVm.faults) / seconds, 1);
            }
            if (currentVm.majorFaults !== null && previousVm.majorFaults !== null) {
                system.majorPageFaultsPerSec = roundNumber((currentVm.majorFaults - previousVm.majorFaults) / seconds, 1);
            }
        }
    } else if (process.platform === 'win32') {
        try {
            const output = await runPowerShell([
                "$counter = Get-Counter -Counter '\\Processor(_Total)\\Interrupts/sec','\\Memory\\Pages/sec','\\Memory\\Page Faults/sec' -ErrorAction SilentlyContinue",
                "$map = @{}",
                "foreach ($sample in $counter.CounterSamples) { $map[$sample.Path] = $sample.CookedValue }",
                "$map | ConvertTo-Json -Compress",
            ].join('; '));
            const data = safeJsonParse(output, {});
            system.interruptsPerSec = roundNumber(findCounterValue(data, '\\processor(_total)\\interrupts/sec'), 1);
            system.pagesPerSec = roundNumber(findCounterValue(data, '\\memory\\pages/sec'), 1);
            system.pageFaultsPerSec = roundNumber(findCounterValue(data, '\\memory\\page faults/sec'), 1);
        } catch (err) {
            system.interruptsPerSec = null;
            system.pagesPerSec = null;
            system.pageFaultsPerSec = null;
        }
    }

    return system;
}

async function safeCollect(collector) {
    try {
        return await collector();
    } catch (err) {
        console.warn('[DesktopMetrics] Collector failed:', err.message);
        return null;
    }
}

async function getSnapshot(options = {}) {
    const capabilities = await getCapabilities(!!options.forceRefresh);
    const providers = capabilities.providers || {};

    const [memory, disk, network, battery, docker, gpu, sensors, system, processes] = await Promise.all([
        safeCollect(() => collectMemory()),
        safeCollect(() => collectDisk()),
        safeCollect(() => collectNetwork()),
        safeCollect(() => collectBattery()),
        safeCollect(() => collectDocker(options.includeDocker !== false, providers)),
        safeCollect(() => collectGpu(providers)),
        safeCollect(() => collectSensors(providers)),
        safeCollect(() => collectSystem()),
        safeCollect(() => collectProcesses(options.includeProcesses !== false)),
    ]);

    return {
        collectedAt: new Date().toISOString(),
        platform: process.platform,
        route: capabilities.routes,
        cpu: collectCpu(),
        memory,
        disk,
        network,
        battery,
        docker,
        gpu,
        sensors,
        system,
        processes,
        capabilities,
    };
}

function initialize({ ipcMain }) {
    if (handlersRegistered) return;

    ipcMain.handle('desktop-metrics-get-capabilities', async () => {
        try {
            return {
                success: true,
                data: await getCapabilities(false),
            };
        } catch (err) {
            return {
                success: false,
                error: err.message,
            };
        }
    });

    ipcMain.handle('desktop-metrics-get-snapshot', async (event, options = {}) => {
        try {
            return {
                success: true,
                data: await getSnapshot(options || {}),
            };
        } catch (err) {
            return {
                success: false,
                error: err.message,
            };
        }
    });

    ipcMain.handle('desktop-metrics-get-detailed-processes', async () => {
        try {
            return {
                success: true,
                data: app.getAppMetrics().map(m => ({
                    pid: m.pid,
                    type: m.type,
                    name: m.name || '',
                    cpu: m.cpu.percentCPUUsage,
                    memory: m.memory.workingSetSize // Keeping memory for internal use if needed, though user said don't care
                }))
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    handlersRegistered = true;
    console.log('[DesktopMetrics] IPC handlers registered.');
}

module.exports = {
    initialize,
    getCapabilities,
    getSnapshot,
};
