// modules/ipc/musicHandlers.js

const { ipcMain, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { Worker } = require('worker_threads');
const lyricFetcher = require('../lyricFetcher'); // Import the new lyric fetcher
const webdavManager = require('../webdavManager'); // WebDAV support
const AUDIO_ENGINE_URL = 'http://127.0.0.1:63789';
let fetch;

let musicWindow = null;
let currentSongInfo = null; // 保持这个变量，用于可能的UI状态同步
let mainWindow = null; // To be initialized
let openChildWindows = []; // To be initialized
let MUSIC_PLAYLIST_FILE;
let MUSIC_COVER_CACHE_DIR;
let LYRIC_DIR;
let startAudioEngine; // To hold the function from main.js
let stopAudioEngine; // To hold the function from main.js
let audioEngineReadyPromise = null; // Promise to track engine readiness

// --- Singleton Music Window Creation Function ---
function createOrFocusMusicWindow() {
    return new Promise(async (resolve, reject) => {
        try {
            // Always wait for the engine to be ready before creating/focusing the window.
            // Thanks to pre-warming in main.js, this should be very fast.
            if (typeof startAudioEngine === 'function') {
                await startAudioEngine();
            } else {
                throw new Error("startAudioEngine function not provided.");
            }
        } catch (error) {
            console.error('[Music] Failed to ensure audio engine is ready:', error);
            dialog.showErrorBox('音乐引擎错误', '无法启动或连接后端音频引擎，请检查日志或重启应用。');
            reject(error);
            return;
        }

        if (musicWindow && !musicWindow.isDestroyed()) {
            console.log('[Music] Music window already exists. Focusing it.');
            if (!musicWindow.isVisible()) {
                musicWindow.show();
            }
            musicWindow.focus();
            resolve(musicWindow);
            return;
        }

        console.log('[Music] Creating new music window instance.');
        musicWindow = new BrowserWindow({
            width: 1280,
            height: 700,
            minWidth: 900,
            minHeight: 600,
            title: '音乐播放器',
            frame: false, // 移除原生窗口框架
            ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
            modal: false,
            webPreferences: {
                preload: path.join(__dirname, '..', '..', 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                devTools: true
            },
            icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
            show: false
        });

        musicWindow.loadFile(path.join(__dirname, '..', '..', 'Musicmodules', 'music.html'));

        openChildWindows.push(musicWindow);
        musicWindow.setMenu(null);

        musicWindow.once('ready-to-show', () => {
            musicWindow.show();
        });

        // Wait for the renderer to signal that it's ready
        ipcMain.once('music-renderer-ready', (event) => {
            if (event.sender === musicWindow.webContents) {
                console.log('[Music] Received "music-renderer-ready" signal. Resolving promise.');
                resolve(musicWindow);
            }
        });

        musicWindow.on('close', (event) => {
            if (process.platform === 'darwin' && !require('electron').app.isQuitting) {
                event.preventDefault();
                musicWindow.hide();
            }
        });

        musicWindow.on('closed', () => {
            console.log('[Music] Music window closed. Stopping playback.');
            // We don't stop the engine when the music window closes anymore,
            // as it's managed by the main app lifecycle now (pre-warmed).
            // We just stop the playback.
            audioEngineApi('/stop').catch(err => console.error("[Music] Failed to send stop command on close:", err));

            openChildWindows = openChildWindows.filter(win => win !== musicWindow);
            musicWindow = null;
            currentSongInfo = null; // 清理歌曲信息
        });

        musicWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
            console.error(`[Music] Music window failed to load: ${errorDescription} (code: ${errorCode})`);
            reject(new Error(`Music window failed to load: ${errorDescription}`));
        });
    });
}

// --- Audio Engine API Helper ---
async function audioEngineApi(endpoint, method = 'POST', body = null) {
    // The check for engine readiness is now handled in createOrFocusMusicWindow,
    // so we can remove the promise check from here, simplifying this function.
    try {
        if (!fetch) throw new Error('node-fetch module is not available yet.');

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
            throw new Error(`Audio engine request failed with status ${response.status}: ${errorText}`);
        }

        return await response.json();
    } catch (error) {
        console.error(`[Music] Error calling Audio Engine API endpoint '${endpoint}':`, error.message);
        if (musicWindow && !musicWindow.isDestroyed()) {
            musicWindow.webContents.send('audio-engine-error', { message: error.message });
        }
        return { status: 'error', message: error.message };
    }
}


// --- Music Control Handler (Legacy, for distributed server) ---
// 这个函数现在将指令转发到新的IPC通道，或者直接调用API
async function handleMusicControl(args) {
    const { command, target } = args;
    console.log(`[MusicControl] Received command: ${command}, Target: ${target}`);

    // 确保音乐窗口存在
    await createOrFocusMusicWindow();

    switch (command.toLowerCase()) {
        case 'play':
            // 如果有目标，需要先从播放列表找到文件路径
            if (target) {
                const playlist = await fs.readJson(MUSIC_PLAYLIST_FILE).catch(() => []);
                const track = playlist.find(t =>
                    (t.title || '').toLowerCase().includes(target.toLowerCase()) ||
                    (t.artist || '').toLowerCase().includes(target.toLowerCase())
                );
                if (track) {
                    // Load the track in the engine
                    await audioEngineApi('/load', 'POST', { path: track.path });

                    // Tell the UI to update with the new track information
                    if (musicWindow && !musicWindow.isDestroyed()) {
                        musicWindow.webContents.send('music-set-track', track);
                    }

                    // Play the track
                    return audioEngineApi('/play', 'POST');
                } else {
                    return { status: 'error', message: `Track '${target}' not found.` };
                }
            } else {
                return audioEngineApi('/play', 'POST');
            }
        case 'pause':
            return audioEngineApi('/pause', 'POST');
        case 'stop':
            return audioEngineApi('/stop', 'POST');
        // 'next' and 'prev' are handled by the renderer for now
        default:
            return { status: 'error', message: `Unknown command: ${command}` };
    }
}

function initialize(options) {
    console.error('[Music] ========== INITIALIZE CALLED ==========');
    console.log('[Music] initialize called');
    mainWindow = options.mainWindow;
    openChildWindows = options.openChildWindows;
    startAudioEngine = options.startAudioEngine; // Receive the start function
    stopAudioEngine = options.stopAudioEngine; // Receive the stop function
    const APP_DATA_ROOT_IN_PROJECT = options.APP_DATA_ROOT_IN_PROJECT;
    MUSIC_PLAYLIST_FILE = path.join(APP_DATA_ROOT_IN_PROJECT, 'songlist.json');
    MUSIC_COVER_CACHE_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'MusicCoverCache');
    LYRIC_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'lyric');

    const registerIpcHandlers = () => {
        console.log('[Music] registerIpcHandlers called');
        ipcMain.on('open-music-window', async () => {
            try {
                await createOrFocusMusicWindow();
            } catch (error) {
                console.error("[Music] Failed to open or focus music window from IPC:", error);
            }
        });

        ipcMain.handle('music-load', async (event, track) => {
            if (track && track.path) {
                currentSongInfo = {
                    title: track.title || '未知标题',
                    artist: track.artist || '未知艺术家',
                    album: track.album || '未知专辑'
                };
                
                // 检查是否是 WebDAV 远程曲目
                if (track.isRemote || track.path.startsWith('http://') || track.path.startsWith('https://')) {
                    // 如果有 serverId，使用它获取凭据
                    if (track.serverId) {
                        return await webdavManager.configureAndLoad({
                            url: track.path,
                            serverId: track.serverId
                        });
                    }
                    // 否则尝试通过 URL 匹配服务器
                    const path = track.path;
                    const matchingServer = webdavManager.listServers().find(s => {
                        return path.startsWith(s.url);
                    });
                    if (matchingServer) {
                        const creds = webdavManager.getServerCredentials(matchingServer.id);
                        if (creds) {
                            return await webdavManager.configureAndLoad({
                                url: track.path,
                                username: creds.username,
                                password: creds.password
                            });
                        }
                    }
                }
                
                // 本地文件或无法匹配的远程文件
                return audioEngineApi('/load', 'POST', { path: track.path });
            }
            return { status: 'error', message: 'Invalid track data provided.' };
        });

        ipcMain.handle('music-play', () => {
            // 只有在有歌曲信息时才真正播放
            if (currentSongInfo) {
                return audioEngineApi('/play', 'POST');
            }
            return { status: 'error', message: 'No song loaded to play.' };
        });

        ipcMain.handle('music-pause', () => {
            return audioEngineApi('/pause', 'POST');
        });

        ipcMain.handle('music-seek', (event, positionSeconds) => {
            return audioEngineApi('/seek', 'POST', { position: positionSeconds });
        });

        ipcMain.handle('music-get-state', async () => {
            return await audioEngineApi('/state', 'GET');
        });

        ipcMain.handle('music-set-volume', (event, volume) => {
            return audioEngineApi('/volume', 'POST', { volume });
        });

        // --- New handlers for WASAPI and device selection ---
        ipcMain.handle('music-get-devices', async (event, options = {}) => {
            const refresh = options.refresh ? '?refresh=true' : '';
            return await audioEngineApi(`/devices${refresh}`, 'GET');
        });

        ipcMain.handle('music-configure-output', (event, { device_id, exclusive }) => {
            return audioEngineApi('/configure_output', 'POST', { device_id, exclusive });
        });

        // --- New handler for EQ ---
        ipcMain.handle('music-set-eq', (event, { bands, enabled }) => {
            return audioEngineApi('/set_eq', 'POST', { bands, enabled });
        });

        // --- New handler for Upsampling ---
        ipcMain.handle('music-configure-upsampling', (event, { target_samplerate }) => {
            return audioEngineApi('/configure_upsampling', 'POST', { target_samplerate });
        });

        // --- Resampling Settings Handler ---
        ipcMain.handle('music-configure-resampling', (event, { quality, use_cache, preemptive_resample }) => {
            return audioEngineApi('/configure_resampling', 'POST', { quality, use_cache, preemptive_resample });
        });

        ipcMain.handle('music-set-eq-type', (event, { type, fir_taps }) => {
            return audioEngineApi('/set_eq_type', 'POST', { type, fir_taps });
        });

        ipcMain.handle('music-configure-optimizations', (event, data) => {
            return audioEngineApi('/configure_optimizations', 'POST', data);
        });

        // --- Loudness Normalization Handlers ---
        ipcMain.handle('music-configure-normalization', async (event, data) => {
            console.log('[Music] configure_normalization request:', JSON.stringify(data));
            const result = await audioEngineApi('/configure_normalization', 'POST', data);
            console.log('[Music] configure_normalization response:', JSON.stringify(result));
            return result;
        });

        ipcMain.handle('music-get-loudness-info', async () => {
            return await audioEngineApi('/loudness_info', 'GET');
        });

        ipcMain.handle('music-scan-loudness', (event, { path }) => {
            return audioEngineApi('/scan_loudness', 'POST', { path });
        });

        ipcMain.handle('music-scan-loudness-background', (event, { path, store }) => {
            return audioEngineApi('/scan_loudness_background', 'POST', { path, store });
        });

        // --- Saturation Effect Handlers ---
        ipcMain.handle('music-get-saturation', async () => {
            return await audioEngineApi('/saturation', 'GET');
        });

        ipcMain.handle('music-set-saturation', (event, data) => {
            return audioEngineApi('/set_saturation', 'POST', data);
        });

        // --- Crossfeed Handlers ---
        ipcMain.handle('music-get-crossfeed', async () => {
            return await audioEngineApi('/crossfeed', 'GET');
        });

        ipcMain.handle('music-set-crossfeed', (event, data) => {
            return audioEngineApi('/set_crossfeed', 'POST', data);
        });

        // --- Dynamic Loudness Handlers ---
        ipcMain.handle('music-get-dynamic-loudness', async () => {
            return await audioEngineApi('/dynamic_loudness', 'GET');
        });

        ipcMain.handle('music-set-dynamic-loudness', (event, data) => {
            return audioEngineApi('/set_dynamic_loudness', 'POST', data);
        });

        // --- Noise Shaper Handlers ---
        ipcMain.handle('music-get-noise-shaper-curve', async () => {
            return await audioEngineApi('/noise_shaper_curve', 'GET');
        });

        ipcMain.handle('music-set-noise-shaper-curve', (event, { curve }) => {
            return audioEngineApi('/set_noise_shaper_curve', 'POST', { curve });
        });

        ipcMain.handle('music-configure-output-bits', (event, { bits }) => {
            return audioEngineApi('/configure_output_bits', 'POST', { bits });
        });

        // --- IR Status Handler ---
        ipcMain.handle('music-get-ir-status', async () => {
            return await audioEngineApi('/ir_status', 'GET');
        });
        
        // --- Settings Persistence ---
        ipcMain.handle('music-get-settings', async () => {
            return await audioEngineApi('/settings', 'GET');
        });

        ipcMain.handle('music-save-settings', (event, data) => {
            return audioEngineApi('/save_settings', 'POST', data);
        });

        // --- Gapless Playback Handlers ---
        ipcMain.handle('music-queue-next', (event, { path, username, password }) => {
            return audioEngineApi('/queue_next', 'POST', { path, username, password });
        });

        ipcMain.handle('music-cancel-preload', () => {
            return audioEngineApi('/cancel_preload', 'POST');
        });

        // --- FIR IR Convolver Handlers ---
        ipcMain.handle('music-load-ir', (event, { path }) => {
            return audioEngineApi('/load_ir', 'POST', { path });
        });

        ipcMain.handle('music-unload-ir', () => {
            return audioEngineApi('/unload_ir', 'POST');
        });

        // --- IR Presets Handling ---
        ipcMain.handle('music-list-ir-presets', async () => {
            const irPresetDir = path.join(__dirname, '..', '..', 'audio_engine', 'IRPreset');
            if (!(await fs.pathExists(irPresetDir))) return [];
            try {
                const files = await fs.readdir(irPresetDir);
                const audioExtensions = new Set(['.wav', '.flac', '.mp3', '.ogg', '.m4a', '.ape']);
                return files
                    .filter(file => audioExtensions.has(path.extname(file).toLowerCase()))
                    .map(file => path.parse(file).name);
            } catch (err) {
                console.error('[Music] Failed to list IR presets:', err);
                return [];
            }
        });

        ipcMain.handle('music-get-ir-preset-path', async (event, presetName) => {
            const irPresetDir = path.join(__dirname, '..', '..', 'audio_engine', 'IRPreset');
            if (!(await fs.pathExists(irPresetDir))) return null;
            try {
                const files = await fs.readdir(irPresetDir);
                const audioExtensions = new Set(['.wav', '.flac', '.mp3', '.ogg', '.m4a', '.ape']);
                const match = files.find(file => {
                    const p = path.parse(file);
                    return p.name === presetName && audioExtensions.has(p.ext.toLowerCase());
                });
                return match ? path.join(irPresetDir, match) : null;
            } catch (err) {
                console.error('[Music] Failed to get IR preset path:', err);
                return null;
            }
        });

        // --- IR File Selection Dialog ---
        ipcMain.handle('select-ir-file', async () => {
            const result = await dialog.showOpenDialog(musicWindow || mainWindow, {
                title: '选择脉冲响应文件 (IR)',
                filters: [
                    { name: '音频文件', extensions: ['wav', 'flac', 'mp3', 'ogg', 'm4a', 'ape'] },
                    { name: 'WAV', extensions: ['wav'] },
                    { name: 'FLAC', extensions: ['flac'] },
                    { name: '所有文件', extensions: ['*'] }
                ],
                properties: ['openFile']
            });
            if (result.canceled || result.filePaths.length === 0) return null;
            return result.filePaths[0];
        });

        ipcMain.handle('music-add-folder', async (event) => {
            const result = await dialog.showOpenDialog(mainWindow, {
                properties: ['openDirectory']
            });

            if (result.canceled || result.filePaths.length === 0) {
                return;
            }

            const folderPath = result.filePaths[0];
            const supportedFormats = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a']);
            const fileList = [];

            async function collectFilePaths(dir) {
                try {
                    const files = await fs.readdir(dir, { withFileTypes: true });
                    for (const file of files) {
                        const fullPath = path.join(dir, file.name);
                        if (file.isDirectory()) {
                            await collectFilePaths(fullPath);
                        } else if (supportedFormats.has(path.extname(file.name).toLowerCase())) {
                            fileList.push(fullPath);
                        }
                    }
                } catch (err) {
                    console.error(`Error collecting file paths in ${dir}:`, err);
                }
            }

            try {
                await collectFilePaths(folderPath);
                event.sender.send('music-scan-start', { total: fileList.length });

                await fs.ensureDir(MUSIC_COVER_CACHE_DIR);

                const worker = new Worker(path.join(__dirname, '..', '..', 'modules', 'musicScannerWorker.js'), {
                    workerData: {
                        coverCachePath: MUSIC_COVER_CACHE_DIR
                    }
                });
                const finalPlaylist = [];
                let processedCount = 0;

                worker.on('message', (result) => {
                    if (result.status === 'success') {
                        finalPlaylist.push(result.data);
                    } else {
                        console.error(result.error);
                    }

                    processedCount++;
                    event.sender.send('music-scan-progress', { current: processedCount, total: fileList.length });

                    if (processedCount === fileList.length) {
                        event.sender.send('music-scan-complete', finalPlaylist);
                        worker.terminate();
                    }
                });

                worker.on('error', (error) => {
                    console.error('Worker thread error:', error);
                    event.sender.send('music-scan-complete', finalPlaylist);
                    worker.terminate();
                });

                worker.on('exit', (code) => {
                    if (code !== 0) {
                        console.error(`Worker stopped with exit code ${code}`);
                    }
                });

                fileList.forEach(filePath => worker.postMessage(filePath));

            } catch (err) {
                console.error("Error during music scan setup:", err);
                event.sender.send('music-scan-complete', []);
            }
        });

        ipcMain.handle('get-music-playlist', async () => {
            try {
                if (await fs.pathExists(MUSIC_PLAYLIST_FILE)) {
                    return await fs.readJson(MUSIC_PLAYLIST_FILE);
                }
                return [];
            } catch (error) {
                console.error('Error reading music playlist:', error);
                return [];
            }
        });

        ipcMain.handle('save-music-playlist', async (event, playlist) => {
            try {
                await fs.writeJson(MUSIC_PLAYLIST_FILE, playlist, { spaces: 2 });
                return { success: true };
            } catch (error) {
                console.error('Error saving music playlist:', error);
                return { success: false, error: error.message };
            }
        });

        // 自定义歌单持久化
        const CUSTOM_PLAYLISTS_FILE = path.join(path.dirname(MUSIC_PLAYLIST_FILE), 'custom_playlists.json');

        ipcMain.handle('get-custom-playlists', async () => {
            try {
                if (await fs.pathExists(CUSTOM_PLAYLISTS_FILE)) {
                    return await fs.readJson(CUSTOM_PLAYLISTS_FILE);
                }
                return [];
            } catch (error) {
                console.error('[Music] Error reading custom playlists:', error);
                return [];
            }
        });

        ipcMain.handle('save-custom-playlists', async (event, playlists) => {
            try {
                await fs.writeJson(CUSTOM_PLAYLISTS_FILE, playlists, { spaces: 2 });
                return { success: true };
            } catch (error) {
                console.error('[Music] Error saving custom playlists:', error);
                return { success: false, error: error.message };
            }
        });

        ipcMain.handle('music-share-track', (event, filePath) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                console.log(`[Music] Forwarding shared file to renderer: ${filePath}`);
                mainWindow.webContents.send('add-file-to-input', filePath);
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.focus();
            }
        });

        ipcMain.handle('music-get-lyrics', async (event, { artist, title }) => {
            if (!title) return null;

            // A simple sanitizer to remove characters that are invalid in file paths.
            const sanitize = (str) => str.replace(/[\\/:"*?<>|]/g, '_');
            const sanitizedTitle = sanitize(title);

            const possiblePaths = [];
            if (artist) {
                const sanitizedArtist = sanitize(artist);
                possiblePaths.push(path.join(LYRIC_DIR, `${sanitizedArtist} - ${sanitizedTitle}.lrc`));
            }
            possiblePaths.push(path.join(LYRIC_DIR, `${sanitizedTitle}.lrc`));

            for (const lrcPath of possiblePaths) {
                try {
                    if (await fs.pathExists(lrcPath)) {
                        const content = await fs.readFile(lrcPath, 'utf-8');
                        return content;
                    }
                } catch (error) {
                    console.error(`[Music] Error reading lyric file ${lrcPath}:`, error);
                }
            }

            return null;
        });

        ipcMain.handle('music-fetch-lyrics', async (event, { artist, title }) => {
            if (!title) return null;
            console.log(`[Music] IPC: Received request to fetch lyrics for "${title}" by "${artist}"`);
            try {
                // Ensure the lyric directory exists before fetching
                await fs.ensureDir(LYRIC_DIR);
                const lrcContent = await lyricFetcher.fetchAndSaveLyrics(artist, title, LYRIC_DIR);
                return lrcContent;
            } catch (error) {
                console.error(`[Music] Error fetching lyrics via IPC for "${title}":`, error);
                return null;
            }
        });

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
            
            currentSongInfo = {
                title: config.trackMeta?.title || config.url.split('/').pop().split('?')[0],
                artist: config.trackMeta?.artist || '未知艺术家',
                album: config.trackMeta?.album || '未知专辑',
            };
            return await webdavManager.configureAndLoad(config);
        });
    };

    // 使用动态导入，并在成功后注册所有IPC处理器
    // 先注册 IPC 处理器，再异步加载 node-fetch
    console.error('[Music] About to call registerIpcHandlers...');
    registerIpcHandlers();
    console.error('[Music] IPC handlers registered.');
    console.log('[Music] IPC handlers registered.');
    
    import('node-fetch').then(module => {
        fetch = module.default;
        console.log('[Music] node-fetch loaded successfully.');
    }).catch(err => {
        console.error('[Music] Failed to load node-fetch:', err);
    });
}

module.exports = {
    initialize,
    handleMusicControl,
    getMusicState: () => ({ musicWindow, currentSongInfo })
};
