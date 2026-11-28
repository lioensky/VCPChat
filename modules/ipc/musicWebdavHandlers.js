// modules/ipc/musicWebdavHandlers.js
// WebDAV 的 IPC：服务器增删查、测试连接、浏览目录、扫描音频、取文件地址和凭据、加载远程曲目。
// 由 musicHandlers.js 在注册 IPC 时调用；从那里搬出来，行为不变。

const URL_QUERY_HASH_RE = /[?#]/;

function safeDecode(text) {
    try { return decodeURIComponent(text); } catch (_) { return text; }
}

function registerMusicWebdavHandlers({ ipcMain, webdavManager, getMusicWindow, setCurrentSongInfo }) {
    // ============ WebDAV IPC Handlers ============
    // 前端直接传递完整凭据 {url, username, password, path}

    ipcMain.handle('webdav-add-server', (event, config) => {
        return webdavManager.addServer(config);
    });

    ipcMain.handle('webdav-remove-server', (event, { id } = {}) => {
        webdavManager.removeServer(id);
        return { ok: true };
    });

    ipcMain.handle('webdav-list-servers', () => {
        return webdavManager.listServers();
    });

    // 前端传递: { url, username, password }
    ipcMain.handle('webdav-test-connection', async (event, config = {}) => {
        return await webdavManager.testConnection(config);
    });

    // 前端传递: { serverId?, url, username?, password?, path }
    ipcMain.handle('webdav-list-directory', async (event, config) => {
        const req = config && typeof config === 'object' ? { ...config } : {};
        // 如果提供了 serverId，从后端获取完整凭据
        if (req.serverId) {
            const serverCreds = webdavManager.getServerCredentials(req.serverId);
            if (serverCreds) {
                req.url = serverCreds.url;
                req.username = serverCreds.username;
                req.password = serverCreds.password;
            }
        }
        return await webdavManager.listDirectory(req);
    });

    // 前端传递: { serverId?, url, username?, password?, path? }
    ipcMain.handle('webdav-scan-audio', async (event, config) => {
        const req = config && typeof config === 'object' ? { ...config } : {};
        console.log('[Music] webdav-scan-audio called with config:', { serverId: req.serverId, url: req.url });
        // 如果提供了 serverId，从后端获取完整凭据
        if (req.serverId) {
            const serverCreds = webdavManager.getServerCredentials(req.serverId);
            console.log('[Music] serverCreds found:', !!serverCreds, 'hasPassword:', !!(serverCreds?.password));
            if (serverCreds) {
                req.url = serverCreds.url;
                req.username = serverCreds.username;
                req.password = serverCreds.password;
            }
        }
        let lastSentAt = 0;
        let lastSentCount = -1;
        const sendProgress = (count, force = false) => {
            const now = Date.now();
            if (!force && now - lastSentAt < 100) return;
            if (count === lastSentCount) return;
            lastSentAt = now;
            lastSentCount = count;
            const musicWindow = getMusicWindow();
            if (musicWindow && !musicWindow.isDestroyed() && musicWindow.webContents && !musicWindow.webContents.isDestroyed?.()) {
                musicWindow.webContents.send('webdav-scan-progress', { count });
            }
        };
        const results = await webdavManager.scanAudioFiles(req, (count) => {
            sendProgress(count, false);
        });
        if (results?.tracks?.length) sendProgress(results.tracks.length, true);
        console.log('[Music] scanAudioFiles returned:', results?.status, 'tracks:', results?.tracks?.length);
        return results;
    });

    // 前端传递: { url, serverId?, remotePath? }
    ipcMain.handle('webdav-get-file-url', (event, config) => {
        return webdavManager.getFileUrl(config);
    });

    // 获取服务器完整凭据（包含密码）
    ipcMain.handle('webdav-get-server-credentials', (event, { serverId } = {}) => {
        return webdavManager.getServerCredentials(serverId);
    });

    // Load a WebDAV file: 前端传递 { url, serverId?, username?, password?, trackMeta? }
    // 如果提供 serverId，则从后端获取完整凭据（包含密码）
    ipcMain.handle('webdav-load-track', async (event, config) => {
        if (!config || typeof config !== 'object' || !config.url) return { status: 'error', message: 'No URL provided' };
        const req = { ...config };
        // 如果提供了 serverId，从后端获取完整凭据
        if (req.serverId && !req.password) {
            const serverCreds = webdavManager.getServerCredentials(req.serverId);
            if (serverCreds) {
                req.username = serverCreds.username;
                req.password = serverCreds.password;
            }
        }
        const rawUrl = String(req.url);
        const qIdx = rawUrl.search(URL_QUERY_HASH_RE);
        const pathOnly = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
        const slashIdx = pathOnly.lastIndexOf('/');
        const rawName = slashIdx >= 0 ? pathOnly.slice(slashIdx + 1) : pathOnly;
        setCurrentSongInfo({
            title: req.trackMeta?.title || safeDecode(rawName),
            artist: req.trackMeta?.artist || '未知艺术家',
            album: req.trackMeta?.album || '未知专辑',
        });
        return await webdavManager.configureAndLoad(req);
    });
}

module.exports = { registerMusicWebdavHandlers };
