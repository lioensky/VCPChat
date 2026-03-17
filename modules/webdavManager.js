// modules/webdavManager.js
// WebDAV 服务器管理模块
// 管理服务器配置并通过 Rust 音频引擎 HTTP API 进行 WebDAV 操作

const AUDIO_ENGINE_URL = 'http://127.0.0.1:63789';
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

// 从配置文件加载服务器列表
async function loadServers() {
    if (serversLoaded) return;
    try {
        const configPath = getConfigPath();
        if (await fs.pathExists(configPath)) {
            const data = await fs.readJson(configPath);
            servers = data.servers || [];
            serverIdCounter = data.nextId || 1;
        }
        serversLoaded = true;
    } catch (err) {
        console.error('[WebDAV] Failed to load servers config:', err.message);
        serversLoaded = true;
    }
}

// 保存服务器列表到配置文件
async function saveServers() {
    try {
        const configPath = getConfigPath();
        await fs.ensureDir(path.dirname(configPath));
        await fs.writeJson(configPath, { servers, nextId: serverIdCounter }, { spaces: 2 });
    } catch (err) {
        console.error('[WebDAV] Failed to save servers config:', err.message);
    }
}

// 调用 Rust 音频引擎 API
async function audioEngineApi(endpoint, method = 'POST', body = null) {
    if (!fetch) {
        fetch = (await import('node-fetch')).default;
    }
    
    const url = `${AUDIO_ENGINE_URL}${endpoint}`;
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (body) {
        options.body = JSON.stringify(body);
    }
    
    const response = await fetch(url, options);
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Audio engine error: ${response.status} - ${errorText}`);
    }
    return await response.json();
}

// 添加服务器
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
        // 先配置 Rust 引擎的 WebDAV
        await audioEngineApi('/webdav/configure', 'POST', {
            base_url: config.url.replace(/\/$/, ''),
            username: config.username || null,
            password: config.password || null
        });
        
        // 尝试浏览根目录
        const result = await audioEngineApi('/webdav/browse?path=/', 'GET');
        
        if (result.status === 'success') {
            return { status: 'success', message: '连接成功' };
        } else {
            return { status: 'error', message: result.message || '连接失败' };
        }
    } catch (err) {
        console.error('[WebDAV] Test connection failed:', err.message);
        return { status: 'error', message: err.message };
    }
}

// 浏览目录 - 接受完整凭据
async function listDirectory(config) {
    try {
        // 配置 Rust 引擎的 WebDAV
        await audioEngineApi('/webdav/configure', 'POST', {
            base_url: config.url.replace(/\/$/, ''),
            username: config.username || null,
            password: config.password || null
        });
        
        // 浏览目录
        const result = await audioEngineApi(`/webdav/browse?path=${encodeURIComponent(config.path || '/')}`, 'GET');
        
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
            return { status: 'error', message: result.message || '浏览失败' };
        }
    } catch (err) {
        console.error('[WebDAV] List directory failed:', err.message);
        return { status: 'error', message: err.message };
    }
}

// 音频文件扩展名
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wv', '.ape', '.wma', '.aiff']);

// 递归扫描音频文件
async function scanAudioFiles(config, progressCallback) {
    console.log('[WebDAV] scanAudioFiles called with config:', JSON.stringify(config));
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
    
    async function scanDir(dirPath) {
        if (visitedDirs.has(dirPath)) return;
        visitedDirs.add(dirPath);
        
        try {
            const result = await listDirectory({ ...scanConfig, path: dirPath });
            if (result.status !== 'success') {
                console.log('[WebDAV] scanDir failed for', dirPath, ':', result.message);
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
    
    await scanDir(scanConfig.path);
    console.log('[WebDAV] scanAudioFiles complete, found', tracks.length, 'tracks');
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
        
        // 尝试从已保存的服务器列表中找到匹配的服务器
        const matchingServer = servers.find(s => {
            const serverUrl = s.url.replace(/\/$/, '');
            return fileUrl.startsWith(serverUrl + '/') || fileUrl === serverUrl;
        });
        
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
        
        // 配置 Rust 引擎的 WebDAV 凭据
        await audioEngineApi('/webdav/configure', 'POST', {
            base_url: baseUrl,
            username: config.username || null,
            password: config.password || null
        });
        
        // 加载曲目
        return await audioEngineApi('/load', 'POST', { path: config.url });
    } catch (err) {
        console.error('[WebDAV] Configure and load failed:', err.message);
        return { status: 'error', message: err.message };
    }
}

// 初始化时加载服务器列表
loadServers();

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
    configureAndLoad
};
