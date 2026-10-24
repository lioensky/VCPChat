#!/usr/bin/env node
// 把 Live2D Cubism Core 下到 vendor/live2d-cubism-core/，桌宠的 Live2D 形象随应用就能用。
// Core 是 Live2D 的专有组件，不进 git：npm install（postinstall）和打包（pack / dist）时由这里从 Live2D 官网下载。
// 选哪份和设置页「一键启用」一样（modules/deskpet/cubismCore.js 的 fetchOfficialCore）：先单独发布的 Core，
// 用不了再退回锁定版本的 SDK 5-r.4；在 Node 的 vm 里真的加载一遍，确认是 5.x 才写进去。
//
//   node scripts/deskpet/fetch-cubism-core.cjs            已经有一份 5.x 就跳过；下载失败只提示，不让 npm install 失败
//   node scripts/deskpet/fetch-cubism-core.cjs --force    重新下载
//   node scripts/deskpet/fetch-cubism-core.cjs --strict   失败就以非 0 退出（打包用：发布的包必须带上 Core）
//   VCPCHAT_SKIP_CUBISM_CORE=1                            跳过（离线安装、不想要 Live2D）

'use strict';

const path = require('path');
const vm = require('vm');
const fs = require('fs-extra');
const { fetchOfficialCore, bundledCorePath, formatCoreVersion, CORE_V5, CORE_V6 } = require('../../modules/deskpet/cubismCore');

const PROBE_TIMEOUT_MS = 10 * 1000;

/** 在一个干净的 vm 上下文里加载 Core，等 WebAssembly 初始化完，返回 csmGetVersion()；加载不了返回 0。 */
async function probeInNode(source) {
    const context = vm.createContext({ console, setTimeout, clearTimeout, WebAssembly, TextDecoder, TextEncoder, performance, atob });
    try {
        vm.runInContext(`${source}\n;globalThis.__core = Live2DCubismCore;`, context, { timeout: PROBE_TIMEOUT_MS });
    } catch {
        return 0;
    }
    // 真的 Core 一加载就有 Version.csmGetVersion，只是 WebAssembly 初始化完之前调用会抛错
    if (typeof context.__core?.Version?.csmGetVersion !== 'function') return 0;
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            return context.__core.Version.csmGetVersion() >>> 0;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    return 0;
}

async function readBundledVersion(dir) {
    try {
        const info = await fs.readJson(path.join(dir, 'core.json'));
        return typeof info.version === 'string' ? info.version : '';
    } catch {
        return '';
    }
}

async function fetchBundledCore({ projectRoot, force = false, fetchImpl = fetch, probe = probeInNode, log = console.log } = {}) {
    const target = bundledCorePath(projectRoot);
    const dir = path.dirname(target);
    const existing = await readBundledVersion(dir);
    if (!force && existing.startsWith('5.') && await fs.pathExists(target)) {
        log(`[cubism-core] Cubism Core ${existing} already in ${path.relative(projectRoot, dir)}`);
        return { skipped: true, version: existing };
    }
    const info = await fetchOfficialCore(fetchImpl, async ({ source, release }) => {
        const version = await probe(source);
        if (!(version >= CORE_V5)) throw new Error('downloaded Cubism Core does not load');
        if (version >= CORE_V6) throw new Error(`downloaded Cubism Core is ${formatCoreVersion(version)}, only 5.x is supported`);
        await fs.ensureDir(dir);
        await fs.writeFile(target, source);
        const result = {
            version: formatCoreVersion(version),
            sdk: release ? `${release.major}-r.${release.revision}` : null,
            origin: 'bundled',
            fetchedAt: new Date().toISOString(),
        };
        await fs.writeJson(path.join(dir, 'core.json'), result, { spaces: 2 });
        return result;
    });
    log(`[cubism-core] Cubism Core ${info.version} saved to ${path.relative(projectRoot, target)}`);
    return { skipped: false, ...info };
}

async function main(argv) {
    const strict = argv.includes('--strict');
    if (process.env.VCPCHAT_SKIP_CUBISM_CORE === '1' && !strict) {
        console.log('[cubism-core] skipped (VCPCHAT_SKIP_CUBISM_CORE=1)');
        return 0;
    }
    try {
        await fetchBundledCore({ projectRoot: path.resolve(__dirname, '..', '..'), force: argv.includes('--force') });
        return 0;
    } catch (error) {
        const message = `[cubism-core] could not fetch Live2D Cubism Core: ${error.message}`;
        if (strict) {
            console.error(message);
            return 1;
        }
        console.warn(`${message}\n[cubism-core] Live2D desk pets fall back to portraits; enable Live2D later in Settings > 桌宠 > Live2D 支持.`);
        return 0;
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { probeInNode, fetchBundledCore, main };
