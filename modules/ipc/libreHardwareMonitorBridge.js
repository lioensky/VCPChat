/**
 * modules/ipc/libreHardwareMonitorBridge.js
 * VCPdesktop LibreHardwareMonitor DLL 桥接模块
 * 负责：定位 LibreHardwareMonitorLib.dll，并通过 Edge 在宿主层直接读取传感器数据
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const EDGE_MODULE_NAMES = ['electron-edge-js', 'edge-js', 'node-edge-js', 'edge'];
const DLL_ENV_KEYS = ['VCP_LHM_DLL_PATH', 'LIBRE_HARDWARE_MONITOR_DLL_PATH'];
const DLL_RELATIVE_CANDIDATES = [
    path.join('vendor', 'LibreHardwareMonitor', 'LibreHardwareMonitorLib.dll'),
    path.join('vendor', 'LibreHardwareMonitorLib.dll'),
];
const MANAGED_BRIDGE_DIR = path.join(__dirname, 'dotnet', 'LibreHardwareMonitorBridge');
const MANAGED_BRIDGE_SOURCE = path.join(MANAGED_BRIDGE_DIR, 'Startup.cs');
const MANAGED_BRIDGE_OUTPUT_DIR = path.join(MANAGED_BRIDGE_DIR, 'bin', 'Release', 'net472');
const MANAGED_BRIDGE_ASSEMBLY = path.join(MANAGED_BRIDGE_OUTPUT_DIR, 'VCPChat.LibreHardwareMonitorBridge.dll');
const MANAGED_BRIDGE_META = path.join(MANAGED_BRIDGE_OUTPUT_DIR, 'vcp-lhm-bridge-build.json');
const RUNTIME_CACHE_ROOT = path.join(os.tmpdir(), 'vcpchat-lhm');
const RUNTIME_DLL_DIR = path.join(RUNTIME_CACHE_ROOT, 'lhm');
const RUNTIME_BRIDGE_DIR = path.join(RUNTIME_CACHE_ROOT, 'bridge');
const RUNTIME_BRIDGE_ASSEMBLY = path.join(RUNTIME_BRIDGE_DIR, 'VCPChat.LibreHardwareMonitorBridge.dll');
const RUNTIME_BRIDGE_META = path.join(RUNTIME_BRIDGE_DIR, 'vcp-lhm-bridge-build.json');
const CSC_CANDIDATES = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];
const COMPANION_DLL_NAMES = [
    'BlackSharp.Core.dll',
    'DiskInfoToolkit.dll',
    'HidSharp.dll',
    'Microsoft.Bcl.AsyncInterfaces.dll',
    'Microsoft.Bcl.HashCode.dll',
    'RAMSPDToolkit-NDD.dll',
    'System.Buffers.dll',
    'System.CodeDom.dll',
    'System.Collections.Immutable.dll',
    'System.Formats.Nrbf.dll',
    'System.IO.Pipelines.dll',
    'System.Memory.dll',
    'System.Numerics.Vectors.dll',
    'System.Reflection.Metadata.dll',
    'System.Resources.Extensions.dll',
    'System.Runtime.CompilerServices.Unsafe.dll',
    'System.Security.AccessControl.dll',
    'System.Security.Principal.Windows.dll',
    'System.Text.Encodings.Web.dll',
    'System.Text.Json.dll',
    'System.Threading.AccessControl.dll',
    'System.Threading.Tasks.Extensions.dll',
];

let cachedEdgeModule = undefined;
let cachedEdgeModuleError = null;
const bridgeCache = new Map();
let csharpCompilerPath = undefined;
let csharpCompilerError = null;

function fileExists(filePath) {
    if (!filePath) return false;
    try {
        fs.accessSync(filePath, fs.constants.F_OK);
        return true;
    } catch (err) {
        return false;
    }
}

function roundNumber(value, digits = 1) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    const base = Math.pow(10, digits);
    return Math.round(value * base) / base;
}

function normalizeArray(value) {
    return Array.isArray(value) ? value : [];
}

function uniquePaths(paths) {
    const seen = new Set();
    return paths.filter((item) => {
        const key = String(item || '').trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function resolveDllCandidates() {
    const candidates = [];

    DLL_ENV_KEYS.forEach((key) => {
        const rawValue = process.env[key];
        if (rawValue) {
            candidates.push(path.resolve(rawValue));
        }
    });

    DLL_RELATIVE_CANDIDATES.forEach((relativePath) => {
        candidates.push(path.join(PROJECT_ROOT, relativePath));
    });

    return uniquePaths(candidates);
}

function resolveDllPath() {
    const candidates = resolveDllCandidates();
    for (const candidate of candidates) {
        if (fileExists(candidate)) {
            return candidate;
        }
    }
    return null;
}

function readJsonIfExists(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        return null;
    }
}

function ensureDirectory(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function isAsarPath(filePath) {
    if (!filePath) return false;
    const normalized = String(filePath).toLowerCase();
    return normalized.includes('.asar\\') || normalized.includes('.asar/');
}

function copyFileIfNeeded(sourcePath, destinationPath) {
    try {
        if (fileExists(destinationPath)) {
            const sourceStat = fs.statSync(sourcePath);
            const destinationStat = fs.statSync(destinationPath);
            if (sourceStat.size === destinationStat.size) {
                return;
            }
        }
    } catch (err) {
        // 忽略 stat 失败，继续覆盖复制
    }

    ensureDirectory(path.dirname(destinationPath));
    fs.copyFileSync(sourcePath, destinationPath);
}

function ensureRuntimeDllDirectory(sourceDllPath) {
    if (!isAsarPath(sourceDllPath)) {
        return {
            dllPath: sourceDllPath,
            directory: path.dirname(sourceDllPath),
        };
    }

    const sourceDirectory = path.dirname(sourceDllPath);
    ensureDirectory(RUNTIME_DLL_DIR);

    fs.readdirSync(sourceDirectory).forEach((fileName) => {
        if (!fileName || path.extname(fileName).toLowerCase() !== '.dll') {
            return;
        }
        const from = path.join(sourceDirectory, fileName);
        const to = path.join(RUNTIME_DLL_DIR, fileName);
        copyFileIfNeeded(from, to);
    });

    return {
        dllPath: path.join(RUNTIME_DLL_DIR, path.basename(sourceDllPath)),
        directory: RUNTIME_DLL_DIR,
    };
}

function getMtimeMs(filePath) {
    try {
        return fs.statSync(filePath).mtimeMs || 0;
    } catch (err) {
        return 0;
    }
}

function isAssemblyUpToDate(assemblyPath) {
    if (!fileExists(assemblyPath)) return false;

    const assemblyMtime = getMtimeMs(assemblyPath);
    const inputs = [MANAGED_BRIDGE_SOURCE];

    return inputs.every((filePath) => getMtimeMs(filePath) <= assemblyMtime);
}

function resolveMissingCompanionDlls(dllPath) {
    const directory = path.dirname(dllPath);
    return COMPANION_DLL_NAMES.filter((fileName) => !fileExists(path.join(directory, fileName)));
}

function ensureCsharpCompilerAvailable() {
    if (csharpCompilerPath !== undefined || csharpCompilerError) {
        if (csharpCompilerError) {
            throw csharpCompilerError;
        }
        return csharpCompilerPath;
    }

    for (const candidate of CSC_CANDIDATES) {
        if (fileExists(candidate)) {
            csharpCompilerPath = candidate;
            return csharpCompilerPath;
        }
    }

    csharpCompilerError = new Error('未找到 .NET Framework C# 编译器 csc.exe');
    throw csharpCompilerError;
}

function buildManagedBridge() {
    const compilerPath = ensureCsharpCompilerAvailable();
    const outputAssembly = isAsarPath(MANAGED_BRIDGE_ASSEMBLY) ? RUNTIME_BRIDGE_ASSEMBLY : MANAGED_BRIDGE_ASSEMBLY;
    const outputMeta = isAsarPath(MANAGED_BRIDGE_META) ? RUNTIME_BRIDGE_META : MANAGED_BRIDGE_META;
    const outputDir = path.dirname(outputAssembly);
    ensureDirectory(outputDir);

    const sourceFile = isAsarPath(MANAGED_BRIDGE_SOURCE)
        ? path.join(outputDir, 'Startup.cs')
        : MANAGED_BRIDGE_SOURCE;
    if (sourceFile !== MANAGED_BRIDGE_SOURCE) {
        copyFileIfNeeded(MANAGED_BRIDGE_SOURCE, sourceFile);
    }

    try {
        execFileSync(compilerPath, [
            '/nologo',
            '/target:library',
            '/optimize+',
            `/out:${outputAssembly}`,
            sourceFile,
        ], {
            cwd: MANAGED_BRIDGE_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
    } catch (err) {
        const stdout = err.stdout ? String(err.stdout).trim() : '';
        const stderr = err.stderr ? String(err.stderr).trim() : '';
        const details = [stdout, stderr].filter(Boolean).join('\n');
        throw new Error(details ? `托管桥接程序集编译失败:\n${details}` : `托管桥接程序集编译失败: ${err.message}`);
    }

    fs.writeFileSync(outputMeta, JSON.stringify({
        builtAt: new Date().toISOString(),
        compiler: compilerPath,
    }, null, 2), 'utf8');
}

function ensureManagedBridgeBuilt() {
    const baseAssembly = MANAGED_BRIDGE_ASSEMBLY;
    const outputAssembly = isAsarPath(baseAssembly) ? RUNTIME_BRIDGE_ASSEMBLY : baseAssembly;

    if (fileExists(baseAssembly) && isAssemblyUpToDate(baseAssembly)) {
        if (isAsarPath(baseAssembly)) {
            copyFileIfNeeded(baseAssembly, outputAssembly);
        }
        return outputAssembly;
    }

    if (!isAssemblyUpToDate(outputAssembly)) {
        buildManagedBridge();
    }

    if (!fileExists(outputAssembly)) {
        throw new Error('托管桥接程序集不存在');
    }

    return outputAssembly;
}

function loadEdgeModule() {
    if (cachedEdgeModule !== undefined || cachedEdgeModuleError) {
        if (cachedEdgeModuleError) {
            throw cachedEdgeModuleError;
        }
        return cachedEdgeModule;
    }

    for (const moduleName of EDGE_MODULE_NAMES) {
        try {
            cachedEdgeModule = require(moduleName);
            return cachedEdgeModule;
        } catch (err) {
            if (!cachedEdgeModuleError) {
                cachedEdgeModuleError = err;
            }
        }
    }

    throw cachedEdgeModuleError || new Error('未找到可用的 Edge 模块');
}

function getBridge(dllPath) {
    const sourcePath = dllPath || resolveDllPath();
    if (!sourcePath) {
        throw new Error('未找到 LibreHardwareMonitorLib.dll');
    }

    const { dllPath: resolvedPath } = ensureRuntimeDllDirectory(sourcePath);

    if (bridgeCache.has(resolvedPath)) {
        return bridgeCache.get(resolvedPath);
    }

    const edge = loadEdgeModule();
    const assemblyFile = ensureManagedBridgeBuilt();
    const bridge = edge.func({
        assemblyFile,
        typeName: 'VCPChat.LibreHardwareMonitorBridge.Startup',
        methodName: 'Invoke',
    });

    bridgeCache.set(resolvedPath, bridge);
    return bridge;
}

function invokeBridge(bridge, payload) {
    return new Promise((resolve, reject) => {
        bridge(payload || null, (error, result) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(result || {});
        });
    });
}

function normalizeSensorEntry(entry, numericField, digits) {
    if (!entry || typeof entry !== 'object') return null;
    const value = Number(entry[numericField]);
    if (!isFinite(value)) return null;
    return {
        name: entry.name || entry.identifier || entry.hardware || numericField,
        identifier: entry.identifier || null,
        hardware: entry.hardware || null,
        hardwareType: entry.hardwareType || null,
        source: entry.source || 'LibreHardwareMonitorLib',
        [numericField]: roundNumber(value, digits),
    };
}

function normalizeSensorPayload(payload) {
    return {
        temperatures: normalizeArray(payload.temperatures)
            .map((entry) => normalizeSensorEntry(entry, 'valueC', 1))
            .filter(Boolean),
        fans: normalizeArray(payload.fans)
            .map((entry) => normalizeSensorEntry(entry, 'rpm', 0))
            .filter(Boolean),
        voltages: normalizeArray(payload.voltages)
            .map((entry) => normalizeSensorEntry(entry, 'volts', 3))
            .filter(Boolean),
        powers: normalizeArray(payload.powers)
            .map((entry) => normalizeSensorEntry(entry, 'watts', 1))
            .filter(Boolean),
        source: payload.source || 'LibreHardwareMonitorLib',
    };
}

function probeLibreHardwareMonitorDllProvider() {
    const sourceDllPath = resolveDllPath();
    if (!sourceDllPath) {
        return {
            available: false,
            reason: 'dll_missing',
            dllPath: null,
        };
    }

    let runtime;
    try {
        runtime = ensureRuntimeDllDirectory(sourceDllPath);
    } catch (err) {
        return {
            available: false,
            reason: 'dll_copy_failed',
            dllPath: sourceDllPath,
            error: err.message,
        };
    }

    const missingDependencies = resolveMissingCompanionDlls(runtime.dllPath);
    if (missingDependencies.length > 0) {
        return {
            available: false,
            reason: 'dll_dependency_missing',
            dllPath: runtime.dllPath,
            sourceDllPath,
            missingDependencies,
            error: `LibreHardwareMonitor 目录缺少伴随依赖: ${missingDependencies.join(', ')}`,
        };
    }

    try {
        loadEdgeModule();
        ensureManagedBridgeBuilt();
        return {
            available: true,
            reason: 'ready',
            dllPath: runtime.dllPath,
            sourceDllPath,
        };
    } catch (err) {
        return {
            available: false,
            reason: 'bridge_unavailable',
            dllPath: runtime.dllPath,
            sourceDllPath,
            error: err.message,
        };
    }
}

async function collectLibreHardwareMonitorDllSensors(options = {}) {
    const provider = probeLibreHardwareMonitorDllProvider();
    if (!provider.available || !provider.dllPath) {
        let error = '未找到 LibreHardwareMonitorLib.dll';
        if (provider.reason === 'dll_dependency_missing' && provider.error) {
            error = provider.error;
        } else if (provider.reason === 'bridge_unavailable' && provider.error) {
            error = provider.error;
        }
        throw new Error(error);
    }

    const bridge = getBridge(provider.dllPath);
    const payload = await invokeBridge(bridge, {
        dllPath: provider.dllPath,
        includeControllers: options.includeControllers === true,
    });
    return normalizeSensorPayload(payload || {});
}

module.exports = {
    probeLibreHardwareMonitorDllProvider,
    collectLibreHardwareMonitorDllSensors,
    resolveDllPath,
};
