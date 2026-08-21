/**
 * locate.js - 定位本机 Wallpaper Engine 安装
 *
 * 移植自 elysia395/dsh-wallpaper-engine (MIT)，适配 VCPWEWallpaper service 插件。
 * 策略（按优先级）：
 *   1. Windows 注册表 HKCU\Software\Valve\Steam -> SteamPath
 *   2. 常见 Steam 安装目录探针（含多盘 SteamLibrary）
 *   3. 解析 libraryfolders.vdf 找到拥有 WE (appid 431960) 的库
 *   4. 校验 wallpaper32.exe 存在性
 */
'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { join, normalize } = require('node:path');
const { execFileSync } = require('node:child_process');

/** Wallpaper Engine 的 Steam appid。 */
const WE_APPID = '431960';

/** 常见 Steam 安装位置（libraryfolders.vdf 缺失时的探针列表）。 */
const STEAM_PROBE_DIRS = [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    'D:\\Steam',
    'D:\\SteamLibrary',
    'E:\\SteamLibrary',
];

/** Windows 安装器写入注册表的 Steam 根目录；探针列表覆盖不到自定义目录。 */
function steamPathFromRegistry() {
    if (process.platform !== 'win32') return null;
    try {
        const reg = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
        const out = execFileSync(
            reg,
            ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
            { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
        );
        const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(out);
        return m ? normalize(m[1].trim()) : null;
    } catch {
        return null;
    }
}

/** 探针列表，注册表已知的 Steam 根目录排在最前。 */
function steamProbeDirs() {
    const reg = steamPathFromRegistry();
    return reg ? [reg, ...STEAM_PROBE_DIRS] : STEAM_PROBE_DIRS;
}

/**
 * Valve KeyValues 极简解析：从 libraryfolders.vdf 提取拥有 WE 的库目录。
 * vdf 结构中每个库块含 "path" 行与其拥有的 appid 列表。
 */
function librariesFromVdf(vdfPath) {
    const text = readFileSync(vdfPath, 'utf8');
    const libs = [];
    let current = null;
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*"path"\s+"([^"]+)"\s*$/.exec(line);
        if (m) {
            current = m[1].replace(/\\\\/g, '\\');
            continue;
        }
        if (current && line.includes(WE_APPID) && !libs.includes(current)) libs.push(current);
    }
    return libs;
}

/** 返回所有 Steam 探针根目录（去重）。 */
function steamRoots() {
    const roots = [...steamProbeDirs()];
    for (const probe of steamProbeDirs()) {
        const vdf = join(probe, 'steamapps', 'libraryfolders.vdf');
        if (existsSync(vdf)) {
            try {
                for (const lib of librariesFromVdf(vdf)) {
                    if (!roots.includes(lib)) roots.push(lib);
                }
            } catch { /* 解析失败则跳过该 vdf */ }
        }
    }
    return roots;
}

/**
 * 定位 WE 安装目录（含 wallpaper32.exe）。
 * @returns {string|null} 绝对路径或 null
 */
function locateWallpaperEngine() {
    const candidates = [];
    for (const root of steamRoots()) {
        candidates.push(join(root, 'steamapps', 'common', 'wallpaper_engine'));
    }
    candidates.push('C:\\Program Files (x86)\\Wallpaper Engine');

    const seen = new Set();
    for (const raw of candidates) {
        const dir = normalize(raw);
        if (seen.has(dir)) continue;
        seen.add(dir);
        if (existsSync(join(dir, 'wallpaper32.exe'))) return dir;
    }
    return null;
}

/**
 * 拥有 WE 的 Steam 库目录（用于 workshop content 根）。
 * @returns {string[]}
 */
function owningLibraries() {
    return steamRoots();
}

module.exports = {
    WE_APPID,
    steamPathFromRegistry,
    librariesFromVdf,
    steamRoots,
    locateWallpaperEngine,
    owningLibraries,
};
