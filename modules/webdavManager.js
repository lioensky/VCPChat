// modules/webdavManager.js
// WebDAV 服务器管理模块
// 管理服务器配置并通过 Rust 音频引擎 HTTP API 进行 WebDAV 操作

const audioEngineEndpoint = require('./services/audioEngineEndpoint');
const path = require('path');
const fs = require('fs-extra');

let fetch;
let servers = [];
let serverIdCounter = 1;
let serversLoaded = false;

// 配置文件路径
const getConfigPath = () => {
    const appPath = process.env.VCP_DATA_PATH || path.join(require('os').homedir(), '.vcpchat');
    return path.join(appPath, 'webdav_servers.json');
};

// 从配置文件加载服务器列表（同步优先避免刚启动时读写竞态；测试 mock 无同步接口时退回异步）
function loadServersSync() {
    if (serversLoaded) return;
    if (typeof fs.pathExistsSync === 'function' && typeof fs.readJsonSync === 'function') {
        try {
            const configPath = getConfigPath();
            if (fs.pathExistsSync(configPath)) {
                const data = fs.readJsonSync(configPath);
                servers = Array.isArray(data?.servers) ? data.servers : [];
                serverIdCounter = data?.nextId || 1;
            }
            serversLoaded = true;
            return;
        } catch (err) {
            console.error('[WebDAV] Failed to load servers config:', err.message);
            serversLoaded = true;
            return;
        }
    }
    loadServers();
}

async function loadServers() {
    if (serversLoaded) return;
    try {
        const configPath = getConfigPath();
        if (await fs.pathExists(configPath)) {
            const data = await fs.readJson(configPath);
            if (!servers.length && Array.isArray(data?.servers)) servers = data.servers;
            serverIdCounter = Math.max(serverIdCounter, data?.nextId || 1);
        }
        serversLoaded = true;
    } catch (err) {
        console.error('[WebDAV] Failed to load servers config:', err.message);
        serversLoaded = true;
    }
}

// 保存服务器列表到配置文件（串行排队 + 有原子写能力时先写临时文件，避免并发写坏 JSON）
let saveChain = Promise.resolve();
let savePending = false;
function saveServers() {
    if (savePending) return saveChain;
    savePending = true;
    saveChain = saveChain.then(async () => {
        savePending = false;
        try {
            const configPath = getConfigPath();
            await fs.ensureDir(path.dirname(configPath));
            const payload = { servers: servers.slice(), nextId: serverIdCounter };
            if (typeof fs.writeFile === 'function' && typeof fs.move === 'function') {
                const tmp = `${configPath}.${process.pid}.tmp`;
                await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
                await fs.move(tmp, configPath, { overwrite: true });
            } else {
                await fs.writeJson(configPath, payload, { spaces: 2 });
            }
        } catch (err) {
            console.error('[WebDAV] Failed to save servers config:', err.message);
        }
    });
    return saveChain;
}

// 调用 Rust 音频引擎 API。引擎自己对远端有 30 秒（整首下载 120 秒）的超时，
// 这里再兜一层，引擎卡住时不让界面一直等。
const ENGINE_TIMEOUT_MS = { '/load': 150000 };
async function audioEngineApi(endpoint, method = 'POST', body = null) {
    if (!fetch) {
        fetch = typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
            ? globalThis.fetch
            : (await import('node-fetch')).default;
    }
    
    const url = `${audioEngineEndpoint.getBaseUrl()}${endpoint}`;
    const timeoutMs = ENGINE_TIMEOUT_MS[endpoint] || 45000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal
    };
    if (body) {
        options.body = JSON.stringify(body);
    }
    
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Audio engine error: ${response.status} - ${errorText}`);
        }
        return await response.json();
    } catch (err) {
        if (err?.name === 'AbortError') throw new Error(`WebDAV 服务器 ${Math.round(timeoutMs / 1000)} 秒内没有响应`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// 引擎只记一套 WebDAV 凭据：「配置凭据 + 用它发请求」必须成对执行，
// 否则同时扫一台、播另一台时，请求会带着另一台的账号发出去。
// 同一引擎实例连续对同一台服务器发请求（例如递归扫目录）时跳过重复 /webdav/configure；
// 引擎重启/异常或任意请求出错时清空缓存，确保下次重新下发凭据。
let engineQueue = Promise.resolve();
let lastConfiguredKey = null;
if (typeof audioEngineEndpoint.onStatus === 'function') {
    audioEngineEndpoint.onStatus((ep) => {
        if (!ep || ep.state !== 'ready') lastConfiguredKey = null;
    });
}
function withEngineCredentials(task) {
    const run = engineQueue.then(task, task);
    engineQueue = run.catch(() => {});
    return run;
}
async function ensureEngineCredentials(baseUrl, username, password) {
    const base = String(baseUrl || '').replace(/\/$/, '');
    const user = username || null;
    const pass = password || null;
    const key = `${audioEngineEndpoint.getBaseUrl()}\0${base}\0${user ?? ''}\0${pass ?? ''}`;
    if (lastConfiguredKey === key) return;
    lastConfiguredKey = null;
    await audioEngineApi('/webdav/configure', 'POST', {
        base_url: base,
        username: user,
        password: pass
    });
    lastConfiguredKey = key;
}

function addServer(config) {
    const id = `webdav_${serverIdCounter++}`;
    const server = {
        id,
        name: config.name || 'WebDAV Server',
        url: config.url.replace(/\/$/, ''),
        username: config.username || '',
        password: config.password || ''
    };
    servers.push(server);
    saveServers().catch(err => console.error('[WebDAV] Failed to save:', err.message));
    // 返回完整服务器对象（不含密码）供前端使用
    return {
        id: server.id,
        name: server.name,
        url: server.url,
        username: server.username
    };
}

// 移除服务器
function removeServer(serverId) {
    servers = servers.filter(s => s.id !== serverId);
    saveServers().catch(err => console.error('[WebDAV] Failed to save:', err.message));
}

// 列出所有服务器（不返回密码）
function listServers() {
    return servers.map(s => ({
        id: s.id,
        name: s.name,
        url: s.url,
        username: s.username
        // 不返回密码
    }));
}

// 根据 ID 获取完整服务器配置
function getServerById(serverId) {
    return servers.find(s => s.id === serverId);
}

// 获取服务器凭据（包含密码，供后端使用）
function getServerCredentials(serverId) {
    const server = servers.find(s => s.id === serverId);
    if (!server) return null;
    return {
        id: server.id,
        name: server.name,
        url: server.url,
        username: server.username,
        password: server.password
    };
}

// 测试连接
async function testConnection(config) {
    try {
        const result = await withEngineCredentials(async () => {
            lastConfiguredKey = null; // 显式测试时总是重新下发凭据验证
            await ensureEngineCredentials(config.url, config.username, config.password);
            return audioEngineApi('/webdav/browse?path=/', 'GET');
        });
        
        if (result.status === 'success') {
            return { status: 'success', message: '连接成功' };
        } else {
            lastConfiguredKey = null;
            return { status: 'error', message: result.message || '连接失败' };
        }
    } catch (err) {
        lastConfiguredKey = null;
        console.error('[WebDAV] Test connection failed:', err.message);
        return { status: 'error', message: err.message };
    }
}

// 浏览目录 - 接受完整凭据
async function listDirectory(config) {
    try {
        const result = await withEngineCredentials(async () => {
            await ensureEngineCredentials(config.url, config.username, config.password);
            return audioEngineApi(`/webdav/browse?path=${encodeURIComponent(config.path || '/')}`, 'GET');
        });
        
        if (result.status === 'success') {
            // 规范化返回格式
            const entries = (result.entries || []).map(e => ({
                name: e.display_name,
                href: e.href,
                url: e.url,
                isDir: e.is_dir,
                contentLength: e.content_length,
                contentType: e.content_type
            }));
            return { status: 'success', entries, path: result.path };
        } else {
            lastConfiguredKey = null;
            return { status: 'error', message: result.message || '浏览失败' };
        }
    } catch (err) {
        lastConfiguredKey = null;
        console.error('[WebDAV] List directory failed:', err.message);
        return { status: 'error', message: err.message };
    }
}

// 音频文件扩展名
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wv', '.ape', '.wma', '.aiff']);

// 递归扫描音频文件
async function scanAudioFiles(config, progressCallback) {
    const tracks = [];
    const visitedDirs = new Set();
    
    // 确保凭据完整
    const scanConfig = {
        url: config.url,
        username: config.username,
        password: config.password,
        path: config.path || '/'
    };
    console.log('[WebDAV] scanAudioFiles starting with config:', { url: scanConfig.url, hasCredentials: !!(scanConfig.username && scanConfig.password) });
    
    let rootError = null;
    async function scanDir(dirPath, isRoot = false) {
        const dirKey = String(dirPath || '/').replace(/\/+$/, '') || '/';
        if (visitedDirs.has(dirKey)) return;
        visitedDirs.add(dirKey);
        
        try {
            const result = await listDirectory({ ...scanConfig, path: dirPath });
            if (result.status !== 'success') {
                console.log('[WebDAV] scanDir failed for', dirPath, ':', result.message);
                if (isRoot) rootError = result.message || '浏览失败';
                return;
            }
            
            for (const entry of result.entries) {
                if (entry.isDir) {
                    await scanDir(entry.href);
                } else {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (AUDIO_EXTENSIONS.has(ext)) {
                        tracks.push({
                            name: entry.name,
                            path: entry.url,
                            href: entry.href,
                            title: entry.name.replace(/\.[^.]+$/, ''),
                            artist: '',
                            album: '',
                            isRemote: true
                        });
                        if (progressCallback) progressCallback(tracks.length);
                    }
                }
            }
        } catch (err) {
            console.error(`[WebDAV] Error scanning ${dirPath}:`, err.message);
        }
    }
    
    await scanDir(scanConfig.path, true);
    console.log('[WebDAV] scanAudioFiles complete, found', tracks.length, 'tracks');
    // 连起点都读不到（断网、密码错）就报错，不报「扫完了，0 首」。
    if (rootError) return { status: 'error', message: rootError, tracks: [] };
    return { status: 'success', tracks };
}

// 获取文件的可播放 URL
function getFileUrl(config) {
    if (config.url) {
        return config.url;
    }
    // 如果只传了 serverId 和 remotePath
    const server = getServerById(config.serverId);
    if (!server) return null;
    
    const baseUrl = server.url.replace(/\/$/, '');
    const remotePath = config.remotePath || '';
    return `${baseUrl}${remotePath.startsWith('/') ? remotePath : '/' + remotePath}`;
}

// 配置引擎凭据并返回播放信息
async function configureAndLoad(config) {
    try {
        // 如果提供了 serverId，先获取凭据
        if (config.serverId && !config.password) {
            const serverCreds = getServerCredentials(config.serverId);
            if (serverCreds) {
                config.url = config.url || serverCreds.url;
                config.username = serverCreds.username;
                config.password = serverCreds.password;
            } else {
                // 服务器已被删除
                return { 
                    status: 'error', 
                    message: `WebDAV 服务器已删除或不存在 (ID: ${config.serverId})。请重新添加服务器或删除此曲目。` 
                };
            }
        }
        
        // 检查是否有凭据
        if (!config.username || !config.password) {
            return { 
                status: 'error', 
                message: '缺少 WebDAV 认证凭据。请确保服务器配置正确。' 
            };
        }
        
        // 查找匹配的已配置服务器，获取正确的 base_url
        // 修复：不能只用 origin，因为 WebDAV 服务器的认证作用域可能是特定路径（如 /dav）
        let baseUrl = '';
        const fileUrl = config.url || '';
        
        // 尝试从已保存的服务器列表中找到路径边界最长匹配的服务器（与 credentialsForTrack 一致）
        const matchingServer = servers
            .filter(s => {
                const serverUrl = String(s.url || '').replace(/\/$/, '');
                return serverUrl && (fileUrl.startsWith(serverUrl + '/') || fileUrl === serverUrl);
            })
            .sort((a, b) => b.url.length - a.url.length)[0];
        
        if (matchingServer) {
            // 使用服务器配置的完整 URL（包含路径）
            baseUrl = matchingServer.url.replace(/\/$/, '');
        } else {
            // 回退：从文件 URL 提取目录路径作为 base_url
            // 例如：https://nas.local:5244/dav/music/song.flac -> https://nas.local:5244/dav
            const urlObj = new URL(fileUrl);
            const pathParts = urlObj.pathname.split('/').filter(p => p);
            if (pathParts.length > 0) {
                // 移除最后一个部分（文件名），得到目录路径
                pathParts.pop();
                const dirPath = pathParts.length > 0 ? '/' + pathParts.join('/') : '';
                baseUrl = `${urlObj.origin}${dirPath}`;
            } else {
                baseUrl = urlObj.origin;
            }
        }
        
        // 配置 Rust 引擎的 WebDAV 凭据，紧接着用它加载曲目
        return await withEngineCredentials(async () => {
            await ensureEngineCredentials(baseUrl, config.username, config.password);
            return audioEngineApi('/load', 'POST', { path: config.url });
        });
    } catch (err) {
        lastConfiguredKey = null;
        console.error('[WebDAV] Configure and load failed:', err.message);
        return { status: 'error', message: err.message };
    }
}

// 远程曲目的凭据：先按 serverId，找不到再按地址落在哪台服务器下面。
function credentialsForTrack({ serverId, path: trackPath } = {}) {
    const byId = serverId ? getServerCredentials(serverId) : null;
    if (byId) return byId;
    const url = String(trackPath || '');
    if (!/^https?:\/\//i.test(url)) return null;
    const server = servers
        .filter(s => { const base = String(s.url || '').replace(/\/$/, ''); return base && (url === base || url.startsWith(base + '/')); })
        .sort((a, b) => b.url.length - a.url.length)[0];
    return server ? getServerCredentials(server.id) : null;
}

// 初始化时加载服务器列表
loadServersSync();

module.exports = {
    addServer,
    removeServer,
    listServers,
    getServerById,
    getServerCredentials,
    testConnection,
    listDirectory,
    scanAudioFiles,
    getFileUrl,
    configureAndLoad,
    credentialsForTrack
};
