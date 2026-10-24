'use strict';

/**
 * 读取 preloads/api/*.js，以及可选功能模块自带的 modules/<功能>/preloadApi.js，
 * 合并成一张 "API 名 → 条目" 表。功能目录删掉，它的 API 就跟着消失，不用改这里；
 * 带 feature.json 的功能被停用时，preload 把它的目录名放进 skipFeatures，效果一样。
 *
 * 本文件不依赖 electron，测试和工具脚本可以直接在 Node 里 require 它，
 * 用来查询某个 API 属于哪个领域、走哪个通道、对哪些角色可见。
 *
 * 领域文件格式（见 preloads/README.md）：
 *   module.exports = {
 *       handlers: ['modules/ipc/xxxHandlers.js'], // 主进程实现位置，仅作文档
 *       roles: ['utility'],                       // 本文件条目的默认可见角色
 *       api: { apiName: invoke('channel', 'arg'), ... },
 *   };
 *
 * 加载时会做以下校验，任一失败都直接抛错，preload 启动即暴露问题：
 *   - api 名跨文件重复
 *   - 条目不是 define.js 生成的 ApiEntry
 *   - roles 里写了不存在的角色
 */

const fs = require('fs');
const path = require('path');
const { ApiEntry } = require('./define');

// 角色名 → 暴露到页面上的全局对象名
const ROLE_GLOBALS = Object.freeze({
    chat: 'chatAPI',
    utility: 'utilityAPI',
    desktop: 'desktopAPI',
});

const API_DIR = path.join(__dirname, '..', 'api');
const FEATURE_DIR = path.join(__dirname, '..', '..', 'modules');
const FEATURE_API_FILE = 'preloadApi.js';

// [{ domain, file, where }]：api/ 下按文件名排序，再接可选功能模块（领域名取目录名）
function listDomainFiles(skipFeatures = []) {
    const files = fs.readdirSync(API_DIR).filter((name) => name.endsWith('.js')).sort()
        .map((name) => ({ domain: path.basename(name, '.js'), file: path.join(API_DIR, name), where: `preloads/api/${name}` }));
    let features = [];
    try {
        features = fs.readdirSync(FEATURE_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch {
        // 测试或工具在没有 modules/ 的环境里加载时，只有 api/
    }
    for (const name of features) {
        if (skipFeatures.includes(name)) continue;
        const file = path.join(FEATURE_DIR, name, FEATURE_API_FILE);
        if (fs.existsSync(file)) files.push({ domain: name, file, where: `modules/${name}/${FEATURE_API_FILE}` });
    }
    return files;
}

function assertRoles(roleNames, where) {
    if (!Array.isArray(roleNames) || roleNames.length === 0) {
        throw new TypeError(`${where}: roles 必须是非空数组`);
    }
    for (const role of roleNames) {
        if (!Object.prototype.hasOwnProperty.call(ROLE_GLOBALS, role)) {
            throw new TypeError(`${where}: 未知角色 "${role}"，可用角色: ${Object.keys(ROLE_GLOBALS).join(', ')}`);
        }
    }
}

const cachedRegistries = new Map();

/**
 * @param {{ skipFeatures?: string[] }} [options] 不加载这些 modules/<目录>/preloadApi.js
 * @returns {Map<string, { entry: ApiEntry, domain: string, roles: string[] }>}
 */
function loadRegistry({ skipFeatures = [] } = {}) {
    const cacheKey = [...skipFeatures].sort().join('/');
    if (cachedRegistries.has(cacheKey)) return cachedRegistries.get(cacheKey);

    const registry = new Map();
    for (const { domain, file, where } of listDomainFiles(skipFeatures)) {
        const definition = require(file);

        if (!definition || typeof definition.api !== 'object') {
            throw new TypeError(`${where}: 缺少 api 对象`);
        }
        assertRoles(definition.roles, where);

        for (const [name, entry] of Object.entries(definition.api)) {
            if (!(entry instanceof ApiEntry)) {
                throw new TypeError(`${where}: ${name} 必须由 core/define.js 的 invoke/send/on 等函数创建`);
            }
            if (registry.has(name)) {
                throw new Error(`preload API 重名: "${name}" 同时定义在 ${registry.get(name).where} 与 ${where}`);
            }
            const roles = entry.allowedRoles || definition.roles;
            assertRoles(roles, `${where} → ${name}`);
            registry.set(name, { entry, domain, where, roles: [...roles] });
        }
    }

    cachedRegistries.set(cacheKey, registry);
    return registry;
}

/**
 * 以纯数据形式列出全部 API，供测试、文档和函数地图等工具使用。
 */
function describeApis() {
    return [...loadRegistry()].map(([name, { entry, domain, where, roles }]) => ({
        name,
        domain,
        where,
        kind: entry.kind,
        channel: entry.channel,
        roles,
    }));
}

module.exports = {
    ROLE_GLOBALS,
    loadRegistry,
    describeApis,
};