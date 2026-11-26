// modules/ipc/musicWebdavHandlers.js
// WebDAV 的 IPC：服务器增删查、测试连接、浏览目录、扫描音频、取文件地址和凭据、加载远程曲目。
// 由 musicHandlers.js 在注册 IPC 时调用；从那里搬出来，行为不变。

function registerMusicWebdavHandlers({ ipcMain, webdavManager, getMusicWindow, setCurrentSongInfo }) {
    // ============ WebDAV IPC Handlers ============
    // 前端直接传递完整凭据 {url, username, password, path}

    ipcMain.handle('webdav-add-server', (event, config) => {
        return webdavManager.addServer(config);
    });

    ipcMain.handle('webdav-remove-server', (event, { id }) => {
        webdavManager.removeServer(id);
        return { ok: true };
    });

    ipcMain.handle('webdav-list-servers', () => {
        return webdavManager.listServers();
    });

    // 前端传递: { url, username, password }
    ipcMain.handle('webdav-test-connection', async (event, config) => {
        return await webdavManager.testConnection(config);
    });

    // 前端传递: { serverId?, url, username?, password?, path }
    ipcMain.handle('webdav-list-directory', async (event, config) => {
        // 如果提供了 serverId，从后端获取完整凭据
        if (config.serverId) {
            const serverCreds = webdavManager.getServerCredentials(config.serverId);
            if (serverCreds) {
                config.url = serverCreds.url;
                config.username = serverCreds.username;
                config.password = serverCreds.password;
            }
        }
        return await webdavManager.listDirectory(config);
    });

    // 前端传递: { serverId?, url, username?, password?, path? }
    ipcMain.handle('webdav-scan-audio', async (event, config) => {
        console.log('[Music] webdav-scan-audio called with config:', { serverId: config.serverId, url: config.url });
        // 如果提供了 serverId，从后端获取完整凭据
        if (config.serverId) {
            const serverCreds = webdavManager.getServerCredentials(config.serverId);
            console.log('[Music] serverCreds found:', !!serverCreds, 'hasPassword:', !!(serverCreds?.password));
            if (serverCreds) {
                config.url = serverCreds.url;
                config.username = serverCreds.username;
                config.password = serverCreds.password;
            }
        }
        const results = await webdavManager.scanAudioFiles(config, (count) => {
            const musicWindow = getMusicWindow();
            if (musicWindow && !musicWindow.isDestroyed()) {
                musicWindow.webContents.send('webdav-scan-progress', { count });
            }
        });
        console.log('[Music] scanAudioFiles returned:', results?.status, 'tracks:', results?.tracks?.length);
        return results;
    });

    // 前端传递: { url, serverId?, remotePath? }
    ipcMain.handle('webdav-get-file-url', (event, config) => {
        return webdavManager.getFileUrl(config);
    });

    // 获取服务器完整凭据（包含密码）
    ipcMain.handle('webdav-get-server-credentials', (event, { serverId }) => {
        return webdavManager.getServerCredentials(serverId);
    });

    // Load a WebDAV file: 前端传递 { url, serverId?, username?, password?, trackMeta? }
    // 如果提供 serverId，则从后端获取完整凭据（包含密码）
    ipcMain.handle('webdav-load-track', async (event, config) => {
        if (!config.url) return { status: 'error', message: 'No URL provided' };
        
        // 如果提供了 serverId，从后端获取完整凭据
        if (config.serverId && !config.password) {
            const serverCreds = webdavManager.getServerCredentials(config.serverId);
            if (serverCreds) {
                config.username = serverCreds.username;
                config.password = serverCreds.password;
            }
        }
        
        setCurrentSongInfo({
            title: config.trackMeta?.title || config.url.split('/').pop().split('?')[0],
            artist: config.trackMeta?.artist || '未知艺术家',
            album: config.trackMeta?.album || '未知专辑',
        });
        return await webdavManager.configureAndLoad(config);
    });
}

module.exports = { registerMusicWebdavHandlers };
