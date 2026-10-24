'use strict';

// 应用功能模块的加载器。一个功能就是 modules/ 下带 feature.json 的目录，核心只认这份清单：
//
//   {
//     "name": "Example",              功能名，启停和日志都用它
//     "displayName": "示例",           插件管理器里显示的名字
//     "version", "description", "author",
//     "main": "index.js",              主进程入口（相对功能目录），导出 register(host) → { dispose() }
//     "renderer": "Some/entry.js",     可选：主窗口一侧的入口（相对项目根目录），导出 install(context)
//     "schemes": [{ "scheme", "privileges" }],  可选：要在 app ready 之前登记的自定义协议
//     "defaultEnabled": true
//   }
//
// 停用或删掉的功能不会被 require，也不登记协议和主窗口入口。启停记在 <AppData>/features.json
// （{ "disabled": [name] }），在插件管理器里切换，重启后生效。

const fs = require('fs');
const path = require('path');

const MANIFEST_FILE = 'feature.json';
const STATE_FILE = 'features.json';
const NAME_PATTERN = /^[A-Za-z][\w.-]{0,63}$/;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;

function isInside(root, target) {
    const relative = path.relative(root, target);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// 清单 → 规整后的功能描述；不合格的带 error，列出来但不加载
function readFeature(dir, projectRoot) {
    const base = { folder: path.basename(dir), dir, manifest: {}, error: null };
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
    } catch (error) {
        return { ...base, name: base.folder, error: `${MANIFEST_FILE} 读不出来：${error.message}` };
    }
    const feature = { ...base, manifest, name: String(manifest?.name || base.folder) };
    const fail = (error) => ({ ...feature, error });
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return fail(`${MANIFEST_FILE} 必须是 JSON 对象`);
    if (!NAME_PATTERN.test(feature.name)) return fail(`功能名不合法：${feature.name}`);
    if (typeof manifest.main !== 'string' || !manifest.main) return fail('缺少 main');
    const main = path.resolve(dir, manifest.main);
    if (!isInside(dir, main)) return fail('main 必须在功能目录里');
    let renderer = null;
    if (manifest.renderer != null) {
        if (typeof manifest.renderer !== 'string' || !manifest.renderer.endsWith('.js')) return fail('renderer 必须是 .js 文件');
        const file = path.resolve(projectRoot, manifest.renderer);
        if (!isInside(projectRoot, file)) return fail('renderer 必须在项目目录里');
        renderer = path.relative(projectRoot, file).split(path.sep).join('/');
    }
    const schemes = manifest.schemes ?? [];
    if (!Array.isArray(schemes) || schemes.some((item) => !SCHEME_PATTERN.test(String(item?.scheme || '')))) return fail('schemes 不合法');
    return { ...feature, main, renderer, schemes, defaultEnabled: manifest.defaultEnabled !== false };
}

/**
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {string} options.appDataRoot 启停状态写在这里的 features.json
 * @param {string} [options.modulesDir] 默认 <projectRoot>/modules
 */
function createAppFeatures({ projectRoot, appDataRoot, modulesDir = path.join(projectRoot, 'modules'), logger = console, requireModule = require }) {
    const stateFile = path.join(appDataRoot, STATE_FILE);

    function readDisabled() {
        try {
            const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            return new Set(Array.isArray(state?.disabled) ? state.disabled.map(String) : []);
        } catch {
            return new Set();
        }
    }

    function discover() {
        let folders = [];
        try {
            folders = fs.readdirSync(modulesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
        } catch {
            return [];
        }
        const disabled = readDisabled();
        const seen = new Set();
        const features = [];
        for (const folder of folders) {
            const dir = path.join(modulesDir, folder);
            if (!fs.existsSync(path.join(dir, MANIFEST_FILE))) continue;
            let feature = readFeature(dir, projectRoot);
            if (!feature.error && seen.has(feature.name)) feature = { ...feature, error: `功能名重复：${feature.name}` };
            seen.add(feature.name);
            const enabled = !feature.error && (disabled.has(feature.name) ? false : feature.defaultEnabled);
            features.push({ ...feature, enabled });
        }
        return features;
    }

    // 本次运行按启动时的状态加载；中途切换只改状态文件
    const startup = discover();
    for (const feature of startup) {
        if (feature.error) logger.warn(`[AppFeatures] ${feature.folder}: ${feature.error}`);
    }
    const active = startup.filter((feature) => feature.enabled);
    const handles = new Map();

    function publicInfo(feature) {
        return {
            name: feature.name,
            folder: feature.folder,
            relativePath: path.relative(projectRoot, feature.dir).split(path.sep).join('/'),
            manifest: feature.manifest,
            enabled: Boolean(feature.enabled),
            active: handles.has(feature.name),
            error: feature.error,
        };
    }

    const api = {
        /** 插件管理器用：每次重新读清单和状态 */
        list() {
            return discover().map(publicInfo);
        },

        setEnabled(name, enabled) {
            const feature = discover().find((item) => item.name === name);
            if (!feature) throw new Error(`没有这个功能：${name}`);
            const disabled = readDisabled();
            if (enabled) disabled.delete(name);
            else disabled.add(name);
            fs.mkdirSync(appDataRoot, { recursive: true });
            fs.writeFileSync(stateFile, `${JSON.stringify({ disabled: [...disabled].sort() }, null, 2)}\n`);
            return { name, enabled: Boolean(enabled), restartRequired: handles.has(name) !== Boolean(enabled) };
        },

        /** app ready 之前调用一次：启用的功能声明的协议一起登记（Electron 只认最后一次调用） */
        registerSchemes(protocol) {
            const taken = new Set();
            const schemes = [];
            for (const feature of active) {
                for (const item of feature.schemes) {
                    if (taken.has(item.scheme)) {
                        logger.warn(`[AppFeatures] ${feature.name}: 协议 ${item.scheme} 已被别的功能登记`);
                        continue;
                    }
                    taken.add(item.scheme);
                    schemes.push({ scheme: item.scheme, privileges: { ...(item.privileges || {}) } });
                }
            }
            if (schemes.length) protocol.registerSchemesAsPrivileged(schemes);
            return schemes.map((item) => item.scheme);
        },

        /**
         * app ready、主窗口建好以后调用一次。每个功能拿到同一份 host，外加 host.feature（自己的名字和目录）。
         * 某个功能出错只记日志，不影响其他功能和核心。
         */
        registerAll(host) {
            for (const feature of active) {
                if (handles.has(feature.name)) continue;
                try {
                    const entry = requireModule(feature.main);
                    if (typeof entry?.register !== 'function') throw new Error('main 没有导出 register(host)');
                    const handle = entry.register({ ...host, feature: { name: feature.name, dir: feature.dir } });
                    handles.set(feature.name, handle || {});
                } catch (error) {
                    logger.error(`[AppFeatures] ${feature.name} 加载失败:`, error);
                }
            }
            return [...handles.keys()];
        },

        async disposeAll() {
            const entries = [...handles.entries()].reverse();
            handles.clear();
            for (const [name, handle] of entries) {
                try {
                    await handle.dispose?.();
                } catch (error) {
                    logger.warn(`[AppFeatures] ${name} 收尾失败:`, error?.message || error);
                }
            }
        },

        /** 主窗口要载入的入口：只给这次真的加载了的功能 */
        rendererEntries() {
            return active.filter((feature) => feature.renderer && handles.has(feature.name))
                .map((feature) => ({ name: feature.name, renderer: feature.renderer }));
        },

        installIpc(ipcMain) {
            ipcMain.handle('app-features:renderer-entries', () => api.rendererEntries());
        },
    };
    return api;
}

module.exports = { createAppFeatures, MANIFEST_FILE, STATE_FILE };
