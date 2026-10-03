'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const MANIFEST = 'plugin-manifest.json';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = manifest => JSON.stringify(Object.fromEntries(Object.entries(manifest || {}).filter(([key]) => !['basePath', 'pluginSpecificEnvConfig', 'isDistributed', 'serverId'].includes(key))));
const publicManifest = manifest => ({ name: manifest.name, displayName: manifest.displayName, description: manifest.description, version: manifest.version, pluginType: manifest.pluginType });

// Settings owns configuration; the running loaders remain authoritative for runtime state.
function createPluginSettingsService({ root, readSettings, getRuntime = () => ({}), fetchImpl = global.fetch }) {
    const pluginRoot = path.join(root, 'VCPDistributedServer', 'Plugin');
    let backendSession = null;
    const queues = new Map();
    const pending = new Map();
    async function serial(key, run) {
        const previous = queues.get(key) || Promise.resolve();
        const task = previous.catch(() => {}).then(run);
        queues.set(key, task);
        try { return await task; } finally { if (queues.get(key) === task) queues.delete(key); }
    }
    async function directory(id) {
        if (typeof id !== 'string' || !/^[^<>:"/\\|?*\x00-\x1f]+$/.test(id) || ['.', '..'].includes(id) || id.trim() !== id) throw new Error('无效的插件标识');
        const resolvedRoot = await fs.realpath(pluginRoot);
        const folder = await fs.realpath(path.join(pluginRoot, id));
        if (path.dirname(folder) !== resolvedRoot) throw new Error('插件目录不能指向外部路径');
        return folder;
    }
    async function readFileSafe(folder, name, optional = false) {
        const target = path.join(folder, name);
        try {
            const stat = await fs.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('插件配置必须是普通文件');
            if (stat.size > 1024 * 1024) throw new Error('插件配置超过 1 MB');
            return await fs.readFile(target, 'utf8');
        } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
    }
    async function local(id) {
        const folder = await directory(id);
        let enabled = true;
        let rawManifest;
        try { rawManifest = await readFileSafe(folder, MANIFEST); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            enabled = false;
            rawManifest = await readFileSafe(folder, MANIFEST + '.block');
        }
        const jsonConfig = await readFileSafe(folder, 'plugin-config.json', true);
        const configFormat = jsonConfig !== null ? 'json' : 'env';
        const config = jsonConfig !== null ? jsonConfig : (await readFileSafe(folder, 'config.env', true)) || '';
        let manifest = {}, error = '';
        try {
            manifest = JSON.parse(rawManifest);
            if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error();
        } catch { manifest = {}; error = 'Manifest 必须是有效的 JSON 对象'; }
        const category = manifest.pluginType === 'renderer' ? 'renderer' : 'local';
        const runtime = getRuntime();
        const loaded = runtime.plugins?.get(manifest.name);
        const loadedHere = loaded && path.resolve(loaded.basePath || '') === path.resolve(folder);
        const changed = loadedHere && (canonical(loaded) !== canonical(manifest) || (configFormat === 'env' && JSON.stringify(loaded.pluginSpecificEnvConfig || {}) !== JSON.stringify(dotenv.parse(config))));
        const serviceFailed = loadedHere && ['service', 'hybridservice'].includes(manifest.pluginType) && manifest.communication?.protocol === 'direct' && !runtime.services?.has(manifest.name);
        const revision = digest(String(enabled) + '\0' + rawManifest + '\0' + config);
        return { id, category, enabled, manifest, rawManifest, config, configFormat, revision, error,
            runtime: category === 'renderer' ? 'renderer' : serviceFailed ? 'error' : changed || (loadedHere && !enabled) ? 'restart' : loadedHere ? 'loaded' : 'unloaded',
            connected: Boolean(runtime.connected), pendingRestart: pending.has(id) && pending.get(id) !== revision };
    }
    function summary(item) {
        return { id: item.id, category: item.category, enabled: item.enabled, revision: item.revision, ...publicManifest(item.manifest), error: item.error,
            runtime: item.runtime, connected: item.connected, pendingRestart: item.pendingRestart, readOnly: Boolean(item.readOnly) };
    }
    async function endpoint() {
        const settings = await readSettings();
        const url = new URL(settings.vcpServerUrl || settings.vcpLogUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请先设置有效的 VCPToolBox 服务器地址');
        // Admin API is mounted at the server root, independently of /v1/chat/completions.
        return url.origin;
    }
    async function backendRequest(route, body, session = backendSession) {
        const origin = await endpoint();
        if (!session || session.origin !== origin) { backendSession = null; throw new Error('请登录当前 VCPToolBox 管理端'); }
        const response = await fetchImpl(origin + '/admin_api' + route, {
            method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(12000),
            headers: { Authorization: 'Basic ' + session.auth, 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        if (!response.ok) {
            if ([401, 403].includes(response.status)) { backendSession = null; throw new Error('管理端登录失效，请检查账号和密码'); }
            throw new Error(`VCPToolBox 管理接口返回 ${response.status}`);
        }
        return response.json();
    }
    async function backendItems() {
        const origin = await endpoint();
        const response = await backendRequest('/plugins');
        if (!Array.isArray(response)) throw new Error('管理端插件清单格式无效');
        return response.map(p => ({ id: p.name, category: 'backend', enabled: Boolean(p.enabled), manifest: p.manifest || {},
            runtime: p.enabled ? 'registered' : 'disabled', readOnly: Boolean(p.isDistributed), config: p.configEnvContent || '',
            revision: digest(origin + '\0' + String(Boolean(p.enabled)) + '\0' + JSON.stringify(p.manifest || {}) + '\0' + (p.configEnvContent || '')), error: '' }));
    }
    async function detail(category, id) {
        if (!['renderer', 'local', 'backend'].includes(category)) throw new Error('无效的插件分类');
        const item = category === 'backend' ? (await backendItems()).find(p => p.id === id) : await local(id);
        if (!item || item.category !== category) throw new Error('找不到此分类的插件');
        return { ...summary(item), revision: item.revision, config: item.config, configFormat: item.configFormat || 'env', configSchema: item.manifest.configSchema || {},
            rawManifest: item.rawManifest || JSON.stringify(Object.fromEntries(Object.entries(item.manifest).filter(([key]) => !['pluginSpecificEnvConfig', 'basePath'].includes(key))), null, 2) };
    }
    return {
        async list(category) {
            if (category === 'backend') return (await backendItems()).map(summary);
            if (!['renderer', 'local'].includes(category)) throw new Error('无效的插件分类');
            const items = [];
            for (const entry of await fs.readdir(pluginRoot, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                try { const item = await local(entry.name); if (item.category === category) items.push(summary(item)); }
                catch (error) { if (error.code !== 'ENOENT') items.push({ id: entry.name, category, displayName: entry.name, enabled: false, error: error.message, runtime: 'error', readOnly: true }); }
            }
            return items.sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id, 'zh-CN'));
        },
        detail,
        async connect({ username, password }) {
            if (typeof username !== 'string' || !username || typeof password !== 'string' || !password || username.includes(':')) throw new Error('请输入管理端账号和密码');
            backendSession = null;
            const session = { origin: await endpoint(), auth: Buffer.from(username + ':' + password).toString('base64') };
            await backendRequest('/plugins', null, session);
            backendSession = session;
            return { connected: true };
        },
        disconnect() { backendSession = null; },
        toggle({ category, id, enabled, revision }) {
            return serial(category === 'backend' ? 'backend' : id, async () => {
                if (typeof enabled !== 'boolean') throw new Error('启停值必须是布尔类型');
                const item = await detail(category, id);
                if (revision !== undefined && revision !== item.revision) throw new Error('插件配置已被其他窗口修改，请刷新后重试');
                if (item.readOnly || item.error) throw new Error('此插件由其他节点管理或清单无效');
                if (category === 'backend') await backendRequest('/plugins/' + encodeURIComponent(id) + '/toggle', { enable: enabled });
                else if (item.enabled !== enabled) {
                    const folder = await directory(id);
                    const source = path.join(folder, MANIFEST + (enabled ? '.block' : ''));
                    const target = path.join(folder, MANIFEST + (enabled ? '' : '.block'));
                    try { await fs.lstat(target); throw new Error('启用和禁用清单同时存在，请先在高级入口检查'); }
                    catch (error) { if (error.code !== 'ENOENT') throw error; }
                    await fs.rename(source, target);
                    if (!pending.has(id)) pending.set(id, item.revision);
                }
                return { requiresRestart: category !== 'backend' && (await local(id)).pendingRestart };
            });
        },
        save({ category, id, revision, config, rawManifest }) {
            return serial(category === 'backend' ? 'backend' : id, async () => {
                const item = await detail(category, id);
                if (item.readOnly) throw new Error('分布式插件请在所属本机节点配置');
                if (revision !== item.revision) throw new Error('插件配置已被其他窗口修改，请刷新后重试');
                if (typeof config !== 'string' || Buffer.byteLength(config) > 1024 * 1024) throw new Error('配置内容无效或超过 1 MB');
                if (category === 'backend') {
                    if (rawManifest !== undefined) throw new Error('后端管理接口不支持直接编辑 Manifest');
                    await backendRequest('/plugins/' + encodeURIComponent(id) + '/config', { content: config });
                } else {
                    const folder = await directory(id);
                    if (item.configFormat === 'json') {
                        try { const parsed = JSON.parse(config); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); }
                        catch { throw new Error('plugin-config.json 必须是有效的 JSON 对象'); }
                    }
                    if (rawManifest !== undefined && rawManifest !== item.rawManifest) {
                        if (typeof rawManifest !== 'string' || Buffer.byteLength(rawManifest) > 1024 * 1024) throw new Error('Manifest 内容无效');
                        let manifest;
                        try { manifest = JSON.parse(rawManifest); } catch { throw new Error('Manifest JSON 无效'); }
                        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || typeof manifest.name !== 'string' || !manifest.name || typeof manifest.pluginType !== 'string' || !manifest.pluginType) throw new Error('Manifest 缺少有效的 name 或 pluginType');
                        let previousName = id;
                        try { previousName = JSON.parse(item.rawManifest).name || id; } catch { /* repair an invalid manifest without changing its folder identity */ }
                        if (manifest.name !== previousName || (manifest.pluginType === 'renderer') !== (category === 'renderer')) throw new Error('此入口不能更改插件标识或分类');
                        await fs.writeFile(path.join(folder, MANIFEST + (item.enabled ? '' : '.block')), rawManifest, 'utf8');
                    }
                    await fs.writeFile(path.join(folder, item.configFormat === 'json' ? 'plugin-config.json' : 'config.env'), config, 'utf8');
                    if (!pending.has(id)) pending.set(id, item.revision);
                }
                return { requiresRestart: category !== 'backend' && (await local(id)).pendingRestart };
            });
        }
    };
}

module.exports = { createPluginSettingsService };
