// modules/ipc/musicHandlers.js

const electron = require('electron');
const { ipcMain, BrowserWindow, dialog } = electron;
const path = require('path');
const fs = require('fs-extra');
const { scanFolder, SUPPORTED_FORMATS } = require('../musicLibraryScanner');
const lyricFetcher = require('../lyricFetcher'); // Import the new lyric fetcher
const webdavManager = require('../webdavManager'); // WebDAV support
const windowService = require('../services/windowService');
const WINDOW_APP_IDS = require('../services/windowAppIds');
const { PRELOAD_ROLES, resolveProjectPreload } = require('../services/preloadPaths');
const audioEngineEndpoint = require('../services/audioEngineEndpoint');
const musicGrooveBus = require('../services/musicGrooveBus');
const { findTrack } = require('../musicTrackMatch');
const windowBounds = require('../musicWindowBounds');
const { createDesktopLyrics } = require('./musicDesktopLyrics');
const { createMusicThumbar } = require('../musicThumbar');
const { createLyricsTranslator } = require('../musicLyricsTranslate');
const { createLibraryWatch } = require('../musicLibraryWatch');
const { formatCurrentLyrics } = require('../lyrics/lyricsMarkdown');
const m3u = require('./musicM3u');
const { registerMusicEngineHandlers } = require('./musicEngineHandlers');
const { registerMusicWebdavHandlers } = require('./musicWebdavHandlers');
const { registerMusicLyricsHandlers } = require('./musicLyricsHandlers');
const { randomUUID } = require('crypto');
let fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;

let musicWindow = null;
// 任务栏缩略图上的上一首/播放暂停/下一首（只在 Windows 上）
// （主进程单测会把这几个辅助模块换成空对象，下面三个都留了什么都不做的退路）
const musicThumbar = typeof createMusicThumbar === 'function'
    ? createMusicThumbar({ nativeImage: electron.nativeImage })
    : { update() { return false; }, reset() {} };
// 曲库文件夹自动同步：记住加过的文件夹，音乐窗口开着时后台对磁盘、监听变化（modules/musicLibraryWatch.js）
const musicFoldersFile = () => (MUSIC_PLAYLIST_FILE ? path.join(path.dirname(MUSIC_PLAYLIST_FILE), 'music_folders.json') : null);
const libraryWatch = typeof createLibraryWatch !== 'function'
    ? { start() {}, stop() {}, rememberFolder: async () => {}, noteLibrarySaved: async () => {}, folders: async () => [], forgetFolder: async () => false }
    : createLibraryWatch({
    // 用户自己在加文件夹时先等它扫完：两边的结果同时回到窗口会互相打乱「正在扫描」和排序
    scan: async (folderPath, signal) => {
        while (activeUserScans > 0 && !signal.aborted) await new Promise((r) => setTimeout(r, 2000));
        return scanFolder({
        folderPath,
        coverCachePath: MUSIC_COVER_CACHE_DIR,
        knownTracks: await readPlaylistFile(),
        signal
        });
    },
    readKnown: () => readPlaylistFile(),
    readFolders: async () => {
        const file = musicFoldersFile();
        if (!file) return [];
        try { const list = await fs.readJson(file); return Array.isArray(list) ? list.filter((d) => typeof d === 'string') : []; } catch (e) { return []; }
    },
    writeFolders: async (list) => { const file = musicFoldersFile(); if (file) await writeJsonAtomic(file, list, { spaces: 2 }); },
    readExcluded: async () => {
        const file = musicFoldersFile() && path.join(path.dirname(MUSIC_PLAYLIST_FILE), 'music_excluded.json');
        if (!file) return [];
        try { const list = await fs.readJson(file); return Array.isArray(list) ? list.filter((d) => typeof d === 'string') : []; } catch (e) { return []; }
    },
    writeExcluded: async (list) => { if (MUSIC_PLAYLIST_FILE) await writeJsonAtomic(path.join(path.dirname(MUSIC_PLAYLIST_FILE), 'music_excluded.json'), list); },
    send: (channel, payload) => { if (musicWindow && !musicWindow.isDestroyed()) musicWindow.webContents.send(channel, payload); }
});
// 外语歌词没有翻译时，用 VCP 上的模型翻成中文（缓存在歌词目录 translations/）
const lyricsTranslator = typeof createLyricsTranslator !== 'function'
    ? { translate: async () => ({ status: 'unavailable', message: '歌词翻译模块没有加载' }) }
    : createLyricsTranslator({
        getSettings: async () => (settingsManager ? settingsManager.readSettings() : {}),
        getCacheDir: () => (LYRIC_DIR ? path.join(LYRIC_DIR, 'translations') : null)
    });
let musicCapsuleState = { open: false, title: '', trackKey: '', playing: false };
let musicInfoInjectionEnabled = true;
let settingsManager = null;

// 音乐窗口有两套页面：新版 Musicmodules/，和上游原版 Musicmodules-legacy/（原样保留，可随时切回）。
// 用哪套看设置里的 musicLegacyUI；两套共用同一个主进程、预加载和音频引擎。
const MUSIC_PAGES = {
    current: path.join(__dirname, '..', '..', 'Musicmodules', 'music.html'),
    legacy: path.join(__dirname, '..', '..', 'Musicmodules-legacy', 'music.html')
};
async function readLegacyUISetting() {
    try { return (await settingsManager?.readSettings())?.musicLegacyUI === true; } catch (e) { return false; }
}
async function musicPageFile() {
    return (await readLegacyUISetting()) ? MUSIC_PAGES.legacy : MUSIC_PAGES.current;
}
const getMusicCapsuleSnapshot = () => ({ ...musicCapsuleState, musicInfoInjectionEnabled });
function publishMusicCapsule() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('music-capsule-state', getMusicCapsuleSnapshot());
    }
}
let currentSongInfo = null; // 保持这个变量，用于可能的UI状态同步
let mainWindow = null; // To be initialized
let openChildWindows = []; // To be initialized
let MUSIC_PLAYLIST_FILE;
let MUSIC_COVER_CACHE_DIR;
let MUSIC_WINDOW_BOUNDS_FILE;
let LYRIC_DIR;
let startAudioEngine; // To hold the function from main.js
let stopAudioEngine; // To hold the function from main.js
let musicWindowPromise = null; // To handle concurrent window creation requests
let pendingPlaybackForNewWindow = null; // 用于在新窗口创建时传递待播放曲目及可选演出模式
let ipcHandlersRegistered = false;
let desktopLyrics = null; // 桌面歌词条（musicDesktopLyrics.js），注册 IPC 时创建
const MUSIC_CRASH_LIMIT = 3;
const MUSIC_CRASH_WINDOW_MS = 60 * 1000;

function restoreMusicWindowBounds(limits) {
    if (!MUSIC_WINDOW_BOUNDS_FILE) return null;
    const saved = windowBounds.readSavedBounds(MUSIC_WINDOW_BOUNDS_FILE);
    if (!saved) return null;
    let workAreas = [];
    try {
        workAreas = (electron.screen?.getAllDisplays?.() || []).map((d) => d.workArea);
    } catch (_) { /* 屏幕信息拿不到就用默认位置 */ }
    return windowBounds.restoreBounds(saved, workAreas, limits);
}

// --- Singleton Music Window Creation Function ---
function createOrFocusMusicWindow() {
    if (musicWindowPromise) {
        console.log('[Music] Window creation already in progress, returning existing promise.');
        return musicWindowPromise;
    }

    musicWindowPromise = new Promise(async (resolve, reject) => {
        let readyHandler = null;
        let timeoutId = null;

        let isSettled = false;

        const cleanupWindowCreationWaiters = () => {
            if (readyHandler) {
                ipcMain.removeListener('music-renderer-ready', readyHandler);
                readyHandler = null;
            }
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        };

        const resolveWindowCreation = (win) => {
            if (isSettled) return;
            isSettled = true;
            cleanupWindowCreationWaiters();
            musicWindowPromise = null;
            resolve(win);
        };

        const rejectWindowCreation = (error) => {
            if (isSettled) return;
            isSettled = true;
            cleanupWindowCreationWaiters();
            musicWindowPromise = null;
            pendingPlaybackForNewWindow = null; // 窗口创建失败或夭折，及时清理暂存请求避免脏残留
            reject(error);
        };
        try {
            // Always wait for the engine to be ready before creating/focusing the window.
            // Thanks to pre-warming in main.js, this should be very fast.
            if (typeof startAudioEngine === 'function') {
                await startAudioEngine();
            } else {
                throw new Error("startAudioEngine function not provided.");
            }
        } catch (error) {
            // 引擎起不来时照常打开窗口，由窗口顶部的提示说明原因（见 music-get-audio-engine-endpoint），
            // 而不是让用户对着时长 0:00 猜。下次打开窗口会再尝试启动。
            console.error('[Music] Failed to ensure audio engine is ready:', error);
            if (audioEngineEndpoint.getStatus().state !== 'failed') {
                audioEngineEndpoint.markFailed(error?.message || '音频引擎没有启动');
            }
        }

        if (musicWindow && !musicWindow.isDestroyed()) {
            console.log('[Music] Music window already exists. Focusing it.');
            if (!musicWindow.isVisible()) {
                musicWindow.show();
            }
            musicWindow.focus();
            resolveWindowCreation(musicWindow);
            return;
        }

        console.log('[Music] Creating new music window instance.');
        // 回到上次关窗时的位置和大小；那块屏不在了或窗口跑到屏幕外，就用默认位置居中
        const restored = restoreMusicWindowBounds({ minWidth: 420, minHeight: 600 });
        musicWindow = new BrowserWindow({
            width: restored?.width || 1280,
            height: restored?.height || 700,
            ...(restored ? { x: restored.x, y: restored.y } : {}),
            minWidth: 420,
            minHeight: 600,
            title: '音乐播放器',
            frame: false, // 移除原生窗口框架
            ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
            modal: false,
            webPreferences: {
                // Rust keeps playing when this window is occluded; keep its lyric/spectrum frame clock running too.
                // 关了节流以后页面总报「可见」，最小化 / 隐藏由下面的 music-window-visibility 补报给新版页面。
                backgroundThrottling: false,
                preload: resolveProjectPreload(path.join(__dirname, '..', '..'), PRELOAD_ROLES.UTILITY),
                sandbox: false, // preloads/* 需要 require 本地模块，见 preloads/README.md
                contextIsolation: true,
                nodeIntegration: false,
                devTools: true
            },
            icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
            show: false
        });

        musicWindow.loadFile(await musicPageFile());
        windowService.attachWindow(WINDOW_APP_IDS.MUSIC, musicWindow);

        openChildWindows.push(musicWindow);
        musicWindow.setMenu(null);

        musicWindow.once('ready-to-show', () => {
            if (restored?.maximized) musicWindow.maximize();
            musicWindow.show();
            musicCapsuleState = { ...musicCapsuleState, open: true };
            publishMusicCapsule();
            musicThumbar.update(musicWindow, { playing: musicCapsuleState.playing, force: true });
        });
        // 页面关了后台节流，最小化 / 隐藏时 document.hidden 不会变；告诉新版页面，让舞台和 3D 首页停画
        const reportVisibility = () => {
            if (!musicWindow || musicWindow.isDestroyed()) return;
            const hidden = musicWindow.isMinimized() || !musicWindow.isVisible();
            musicWindow.webContents.send('music-window-visibility', { hidden });
        };
        for (const eventName of ['minimize', 'restore', 'hide', 'show']) musicWindow.on(eventName, reportVisibility);
        // 窗口藏起来再显示时 Windows 会丢掉缩略图按钮，重新设一遍
        musicWindow.on('show', () => {
            musicThumbar.update(musicWindow, { playing: musicCapsuleState.playing, force: true });
        });

        // Wait for the renderer to signal that it's ready
        readyHandler = (event) => {
            if (musicWindow && !musicWindow.isDestroyed() && event.sender === musicWindow.webContents) {
                console.log('[Music] Received "music-renderer-ready" signal. Resolving promise.');
                desktopLyrics?.musicReady();
                libraryWatch.start();
                // pendingPlaybackForNewWindow 由前端通过 music-get-pending-track 主动拉取
                // 不在这里发送，避免时序问题
                resolveWindowCreation(musicWindow);
            }
        };

        // Add a timeout to prevent hanging forever if the renderer fails to signal
        timeoutId = setTimeout(() => {
            console.error('[Music] Timeout waiting for "music-renderer-ready" signal.');
            // We resolve anyway to allow the command to proceed, or we could reject.
            // Resolving might lead to other errors, but it's better than a permanent hang.
            resolveWindowCreation(musicWindow);
        }, 10000); // 10 second timeout

        ipcMain.on('music-renderer-ready', readyHandler);

        musicWindow.on('close', (event) => {
            if (MUSIC_WINDOW_BOUNDS_FILE) windowBounds.writeSavedBounds(MUSIC_WINDOW_BOUNDS_FILE, musicWindow);
            if (process.platform === 'darwin' && !require('electron').app.isQuitting) {
                event.preventDefault();
                musicWindow.hide();
            }
        });

        musicWindow.on('closed', () => {
            console.log('[Music] Music window closed. Stopping playback.');
            // 若窗口在 ready 之前就被用户强行关闭，立即 reject 挂起的 Promise，避免调用方永久超时死锁
            if (!isSettled) {
                console.warn('[Music] Music window closed before renderer signal was received. Rejecting creation promise.');
                rejectWindowCreation(new Error('Music window was closed before initialization completed.'));
            } else {
                cleanupWindowCreationWaiters();
                musicWindowPromise = null;
            }

            // We don't stop the engine when the music window closes anymore,
            // as it's managed by the main app lifecycle now (pre-warmed).
            // We just stop the playback.
            audioEngineApi('/stop').catch(err => console.error("[Music] Failed to send stop command on close:", err));

            desktopLyrics?.musicClosed();
            openChildWindows = openChildWindows.filter(win => win !== musicWindow);
            musicWindow = null;
            currentSongInfo = null; // 清理歌曲信息
            musicCapsuleState = { open: false, title: '', trackKey: '', playing: false };
            publishMusicCapsule();
            musicThumbar.reset();
            libraryWatch.stop();
            musicGrooveBus.publish({ playing: false });
            pendingPlaybackForNewWindow = null; // 清理未消费的待播放请求
        });

        // 从资源管理器把歌曲或图片拖进窗口时，Chromium 默认会跳转去打开那个文件，整个播放器被换掉、
        // 播放状态全丢。音乐窗口只该停在自己的页面上（含旧版界面）。
        musicWindow.webContents.on('will-navigate', (event, url) => {
            if (!/\/Musicmodules(?:-legacy)?\/music\.html(?:[?#]|$)/.test(String(url).replace(/\\/g, '/'))) event.preventDefault();
        });

        musicWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
            console.error(`[Music] Music window failed to load: ${errorDescription} (code: ${errorCode})`);
            rejectWindowCreation(new Error(`Music window failed to load: ${errorDescription}`));
        });

        // 页面进程崩了（显卡驱动重置、内存不够）：窗口没有系统边框，标题栏和按钮都在页面里，
        // 崩了以后关不掉、也停不了，引擎却还在放。先暂停，再把页面重新载入，它会回到上次的歌和进度。
        // 一分钟里崩到第 4 次就不再重来，直接关窗口（关窗口会停播），免得页面本身有问题时无限崩溃。
        const crashedWindow = musicWindow;
        let crashTimes = [];
        crashedWindow.webContents.on('render-process-gone', (_event, details) => {
            const reason = details?.reason || 'unknown';
            console.error(`[Music] Music window renderer gone: ${reason}`);
            if (reason === 'clean-exit' || crashedWindow.isDestroyed()) return;
            audioEngineApi('/pause', 'POST').catch(() => {});
            musicCapsuleState = { ...musicCapsuleState, playing: false };
            publishMusicCapsule();
            musicThumbar.update(crashedWindow, { playing: false });
            musicGrooveBus.publish({ playing: false });
            const now = Date.now();
            crashTimes = crashTimes.filter((at) => now - at < MUSIC_CRASH_WINDOW_MS).concat(now);
            if (crashTimes.length > MUSIC_CRASH_LIMIT) {
                crashedWindow.close();
                return;
            }
            setTimeout(() => { if (!crashedWindow.isDestroyed()) crashedWindow.reload(); }, 250);
        });
    });

    return musicWindowPromise;
}

// 无缝切到下一首时不走 music-load，「当前播放」注入会一直报上一首。
// 窗口每次换歌都会发胶囊状态，按它的路径跟上；新窗口顺带给出歌手和专辑，旧窗口只给路径时从曲库里查。
async function followTrackChange(state) {
    const trackPath = typeof state?.trackKey === 'string' ? state.trackKey : '';
    if (!trackPath || currentSongInfo?.path === trackPath) return;
    let info = null;
    if (typeof state.artist === 'string' || typeof state.album === 'string') {
        info = { title: state.title, artist: state.artist, album: state.album };
    } else {
        const track = (await readPlaylistFile()).find(t => t && t.path === trackPath);
        info = track ? { title: track.title, artist: track.artist, album: track.album } : { title: state.title };
    }
    if (!musicWindow || musicCapsuleState.trackKey !== trackPath) return; // 查曲库期间又换了歌或窗口关了
    currentSongInfo = {
        title: String(info.title || '').slice(0, 512) || '未知标题',
        artist: String(info.artist || '').slice(0, 512) || '未知艺术家',
        album: String(info.album || '').slice(0, 512) || '未知专辑',
        path: trackPath
    };
}

// 扫一个文件夹（或几首单曲），把进度和结果发回发起的窗口。只给 filePaths 时 folderPath 为空：
// 窗口收到后只加不删（不会把「没扫到」的歌当成被删了）。
// 同一个窗口正在扫的文件夹：扫描途中再选一次同一个文件夹（或连着拖两次）不再从头读第二遍，
// 两遍并行时 CPU 和硬盘占双份，结束时还会连着整理、保存两次曲库。
const runningFolderScans = new Map();
function runLibraryScan(event, options = {}) {
    const folderPath = options.folderPath || null;
    if (!folderPath) return scanLibrary(event, options);
    const key = `${event.sender?.id ?? ''}|${path.resolve(folderPath).replace(/[\\/]+$/, '').toLowerCase()}`;
    const running = runningFolderScans.get(key);
    if (running) return running;
    const scan = scanLibrary(event, options).finally(() => runningFolderScans.delete(key));
    runningFolderScans.set(key, scan);
    return scan;
}

let activeUserScans = 0;
async function scanLibrary(event, options = {}) {
    activeUserScans++;
    try { return await scanLibraryNow(event, options); } finally { activeUserScans--; }
}
async function scanLibraryNow(event, { folderPath = null, filePaths } = {}) {
    const sendToRequester = (channel, payload) => {
        if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send(channel, payload);
        }
    };

    // 窗口在扫描中途关掉就停下，不替一个已经不在的窗口把整个文件夹读完。
    const abort = new AbortController();
    const onGone = () => abort.abort();
    event.sender.once('destroyed', onGone);

    try {
        // 上次保存的歌单里带着文件大小和修改时间；没动过的文件不用再读一遍。
        const knownTracks = await readPlaylistFile();
        const scanned = await scanFolder({
            folderPath,
            filePaths,
            coverCachePath: MUSIC_COVER_CACHE_DIR,
            knownTracks,
            signal: abort.signal,
            onStart: (info) => sendToRequester('music-scan-start', info),
            onProgress: (info) => sendToRequester('music-scan-progress', info),
            onBatch: (tracks) => sendToRequester('music-scan-batch', { tracks, folderPath })
        });
        console.log(`[Music] Scan of ${folderPath || `${filePaths?.length || 0} files`}: ${scanned.stats.total} files, ${scanned.stats.parsed} read, ${scanned.stats.reused} unchanged, ${scanned.stats.failed} failed, ${scanned.stats.elapsedMs} ms`);
        if (!scanned.stats.aborted) {
            sendToRequester('music-scan-complete', {
                tracks: scanned.tracks, folderPath,
                stats: { total: scanned.stats.total, failed: scanned.stats.failed }
            });
        }
    } catch (err) {
        console.error("Error during music scan:", err);
        sendToRequester('music-scan-complete', { tracks: [], folderPath, failed: true, error: err?.message || String(err) });
    } finally {
        if (!event.sender.isDestroyed()) event.sender.removeListener('destroyed', onGone);
    }
}

// --- Playlist file helpers ---
async function readPlaylistFile() {
    try {
        if (await fs.pathExists(MUSIC_PLAYLIST_FILE)) {
            const playlist = await fs.readJson(MUSIC_PLAYLIST_FILE);
            return Array.isArray(playlist) ? playlist : [];
        }
    } catch (error) {
        console.error('Error reading music playlist:', error);
    }
    return [];
}

// 要把一份非空的列表写成空列表时，先把原文件复制成 .bak（只留最近一份）。
async function backupBeforeEmptying(file) {
    try {
        const current = await fs.readJson(file);
        if (Array.isArray(current) && current.length > 0) await fs.copy(file, `${file}.bak`, { overwrite: true });
    } catch (_) { /* 没有原文件或读不出来就不备份 */ }
}

// 先写临时文件再改名：写到一半退出或断电不会留下半截歌单。同一个文件的保存排队进行，
// 排队期间又来的保存只留最后一份。歌单本身不缩进，几千首歌时少写一半字节。
const jsonWriteQueues = new Map();
function writeJsonAtomic(file, data, options = {}) {
    let queue = jsonWriteQueues.get(file);
    if (!queue) {
        queue = { running: false, next: null };
        jsonWriteQueues.set(file, queue);
    }
    const run = async (job) => {
        queue.running = true;
        try {
            const temp = `${file}.${process.pid}.tmp`;
            await fs.writeFile(temp, JSON.stringify(job.data, null, options.spaces || 0));
            await fs.move(temp, file, { overwrite: true });
            job.waiters.forEach((w) => w.resolve());
        } catch (error) {
            job.waiters.forEach((w) => w.reject(error));
        } finally {
            queue.running = false;
            const next = queue.next;
            queue.next = null;
            if (next) run(next);
            else jsonWriteQueues.delete(file);
        }
    };
    return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        if (!queue.running) run({ data, waiters: [waiter] });
        else if (queue.next) { queue.next.data = data; queue.next.waiters.push(waiter); }
        else queue.next = { data, waiters: [waiter] };
    });
}

// --- Audio Engine API Helper ---
// 引擎卡住或已经退出时，没有超时的请求会一直挂着，渲染端的播放/暂停/加载也就永远等不到结果。
// 状态查询是高频轮询，给短超时；分析类接口本身耗时长，单独放宽。
function audioEngineTimeoutMs(endpoint) {
    if (endpoint === '/state') return 3000;
    if (/scan|loudness|load_ir|devices|configure/.test(endpoint)) return 60000;
    return 8000;
}

async function audioEngineApi(endpoint, method = 'POST', body = null) {
    // The check for engine readiness is now handled in createOrFocusMusicWindow,
    // so we can remove the promise check from here, simplifying this function.
    const timeoutMs = audioEngineTimeoutMs(endpoint);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        if (!fetch) throw new Error('node-fetch module is not available yet.');

        const url = `${audioEngineEndpoint.getBaseUrl()}${endpoint}`;
        const options = {
            method,
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
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
        if (error?.name === 'AbortError') {
            error = new Error(`音频引擎 ${Math.round(timeoutMs / 1000)} 秒内没有响应（${endpoint}）`);
        }
        console.error(`[Music] Error calling Audio Engine API endpoint '${endpoint}':`, error.message);
        if (musicWindow && !musicWindow.isDestroyed()) {
            musicWindow.webContents.send('audio-engine-error', { message: error.message });
        }
        return { status: 'error', message: error.message };
    } finally {
        clearTimeout(timer);
    }
}


// 从当前渲染端读取，兼容 gapless 切歌、手动换词以及 LRC/逐字歌词。
// 不创建窗口、不联网、不依赖可能滞后的 currentSongInfo。
async function getCurrentLyrics() {
    const win = musicWindow;
    let snapshot = null;
    if (win && !win.isDestroyed()) {
        snapshot = await new Promise((resolve, reject) => {
            const requestId = randomUUID();
            const cleanup = () => {
                clearTimeout(timer);
                ipcMain.removeListener('music-current-lyrics-response', onResponse);
                win.removeListener('closed', onClosed);
            };
            const onClosed = () => { cleanup(); resolve(null); };
            const onResponse = (event, payload) => {
                if (event.sender !== win.webContents || payload?.requestId !== requestId) return;
                cleanup();
                resolve(payload.snapshot);
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error('读取当前歌词超时，请稍后重试。'));
            }, 5000);
            ipcMain.on('music-current-lyrics-response', onResponse);
            win.once('closed', onClosed);
            try {
                win.webContents.send('music-current-lyrics-request', { requestId });
            } catch (error) {
                cleanup();
                reject(error);
            }
        });
    }
    return {
        status: 'success',
        result: { content: [{ type: 'text', text: formatCurrentLyrics(snapshot) }] }
    };
}

// --- Music Control Handler (Legacy, for distributed server) ---
// 这个函数统一通过前端 renderer 来控制播放，避免竞态问题
async function handleMusicControl(args) {
    const { command, target, stageMode } = args;
    const supportedStageModes = new Set([
        'luminous',
        'partita',
        'cadenza',
        'tempera',
        'sonnet',
        'diorama',
        'fume',
        'tunnel',
        'kowloon',
        'inkdraft',
        'fogpane',
        'lumiere',
        'hanabi',
        'clockwork',
        'orbit',
        'signal',
        'groupchat',
        'impression',
        'starborn'
    ]);
    const normalizedStageMode = typeof stageMode === 'string' && stageMode.trim()
        ? stageMode.trim().toLowerCase()
        : null;

    if (normalizedStageMode && !supportedStageModes.has(normalizedStageMode)) {
        return { status: 'error', message: `Unknown music stage mode: ${stageMode}` };
    }

    console.log(`[MusicControl] Received command: ${command}, Target: ${target}, Stage mode: ${normalizedStageMode || 'regular'}`);

    // 窗口正在创建时，暂停/切歌/读歌词等消息发过去会落空：先等它就绪（失败也照常往下走）。
    const isPlayWithTarget = String(command || '').toLowerCase() === 'play' && target;
    if (musicWindowPromise && !isPlayWithTarget) {
        try { await musicWindowPromise; } catch (_) { /* 按窗口不在处理 */ }
    }

    switch (command.toLowerCase()) {
        case 'getcurrentlyrics':
            return getCurrentLyrics();
        case 'play':
            if (target) {
                // 从播放列表中找到目标曲目
                const playlist = await readPlaylistFile();
                const track = findTrack(playlist, target);
                if (!track) {
                    return { status: 'error', message: `Track '${target}' not found.` };
                }

                const playbackRequest = {
                    track,
                    stageMode: normalizedStageMode
                };

                // 窗口开着且已就绪：直接交给它。窗口还在创建（页面脚本可能还没跑，消息会丢）
                // 或者没开：放进 pending，等窗口就绪；它若在这之前已经取过 pending，就绪后再直接发。
                if (!musicWindowPromise && musicWindow && !musicWindow.isDestroyed()) {
                    console.log('[MusicControl] Window exists, sending music-set-track to renderer.');
                    musicWindow.webContents.send('music-set-track', playbackRequest);
                    if (!musicWindow.isVisible()) {
                        musicWindow.show();
                    }
                    musicWindow.focus();
                    return { status: 'success', message: `Playing: ${track.title}` };
                }
                console.log('[MusicControl] Window not ready, storing pending playback request.');
                pendingPlaybackForNewWindow = playbackRequest;
                try {
                    await createOrFocusMusicWindow();
                    if (pendingPlaybackForNewWindow === playbackRequest && musicWindow && !musicWindow.isDestroyed()) {
                        pendingPlaybackForNewWindow = null;
                        musicWindow.webContents.send('music-set-track', playbackRequest);
                    }
                    return { status: 'success', message: `Playing: ${track.title}` };
                } catch (createErr) {
                    console.error('[MusicControl] Failed to create music window for playback:', createErr);
                    if (pendingPlaybackForNewWindow === playbackRequest) pendingPlaybackForNewWindow = null;
                    return { status: 'error', message: `Music window creation aborted or failed: ${createErr.message}` };
                }
            } else {
                // 无目标，简单恢复播放
                if (musicWindow && !musicWindow.isDestroyed()) {
                    musicWindow.webContents.send('music-control', 'play');
                    return { status: 'success', message: 'Resumed playback.' };
                }
                return audioEngineApi('/play', 'POST');
            }
        case 'pause':
            if (musicWindow && !musicWindow.isDestroyed()) {
                musicWindow.webContents.send('music-control', 'pause');
                return { status: 'success', message: 'Paused.' };
            }
            return audioEngineApi('/pause', 'POST');
        case 'stop':
            // 窗口开着时绕过它直接停引擎，界面会一直以为还在放；交给窗口暂停。
            if (musicWindow && !musicWindow.isDestroyed()) {
                musicWindow.webContents.send('music-control', 'pause');
                return { status: 'success', message: 'Stopped.' };
            }
            return audioEngineApi('/stop', 'POST');
        case 'next':
            if (musicWindow && !musicWindow.isDestroyed()) {
                musicWindow.webContents.send('music-control', 'next');
                return { status: 'success', message: 'Next track.' };
            }
            return { status: 'error', message: 'Music window not available.' };
        case 'previous':
            if (musicWindow && !musicWindow.isDestroyed()) {
                musicWindow.webContents.send('music-control', 'previous');
                return { status: 'success', message: 'Previous track.' };
            }
            return { status: 'error', message: 'Music window not available.' };
        default:
            return { status: 'error', message: `Unknown command: ${command}` };
    }
}

function initialize(options) {
    console.log('[Music] initialize called');
    mainWindow = options.mainWindow;
    openChildWindows = options.openChildWindows;
    startAudioEngine = options.startAudioEngine; // Receive the start function
    stopAudioEngine = options.stopAudioEngine; // Receive the stop function
    const APP_DATA_ROOT_IN_PROJECT = options.APP_DATA_ROOT_IN_PROJECT;
    MUSIC_PLAYLIST_FILE = path.join(APP_DATA_ROOT_IN_PROJECT, 'songlist.json');
    MUSIC_COVER_CACHE_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'MusicCoverCache');
    MUSIC_WINDOW_BOUNDS_FILE = path.join(APP_DATA_ROOT_IN_PROJECT, 'music-window-bounds.json');
    LYRIC_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'lyric');

    if (ipcHandlersRegistered) {
        console.log('[Music] IPC handlers already registered, skipping duplicate registration.');
        return;
    }

    settingsManager = options.settingsManager;
    const applyInjectionSetting = settings => {
        musicInfoInjectionEnabled = settings?.musicInfoInjectionEnabled !== false;
        publishMusicCapsule();
    };
    settingsManager?.on('settings-updated', applyInjectionSetting);
    settingsManager?.on('settings-external-updated', payload => applyInjectionSetting(payload?.settings));

    const registerIpcHandlers = () => {
        console.log('[Music] registerIpcHandlers called');
        desktopLyrics = createDesktopLyrics({
            ipcMain,
            getMusicWindow: () => musicWindow,
            stateFile: path.join(APP_DATA_ROOT_IN_PROJECT, 'music-desktop-lyrics.json'),
            projectRoot: path.join(__dirname, '..', '..')
        });
        ipcMain.on('open-music-window', async () => {
            try {
                await createOrFocusMusicWindow();
            } catch (error) {
                console.error("[Music] Failed to open or focus music window from IPC:", error);
            }
        });

        // 新版 / 旧版（原版）界面切换：存进设置，音乐窗口开着就当场换成另一套页面
        ipcMain.handle('music-get-legacy-ui', () => readLegacyUISetting());
        ipcMain.handle('music-set-legacy-ui', async (event, enabled) => {
            if (!settingsManager) throw new Error('设置管理器未初始化。');
            const legacy = enabled === true;
            const result = await settingsManager.updateSettings(current => ({ ...current, musicLegacyUI: legacy }));
            if (!result.success) throw new Error(result.error || '保存界面设置失败。');
            if (musicWindow && !musicWindow.isDestroyed() && event.sender === musicWindow.webContents) {
                // 原版界面不送歌词，桌面歌词条先收起（开关不变），回到新版时再打开
                if (legacy) desktopLyrics?.musicClosed();
                setImmediate(() => {
                    if (!musicWindow || musicWindow.isDestroyed()) return;
                    musicWindow.loadFile(legacy ? MUSIC_PAGES.legacy : MUSIC_PAGES.current);
                    if (!legacy) musicWindow.webContents.once('did-finish-load', () => desktopLyrics?.musicReady());
                });
            }
            return legacy;
        });

        // --- 前端初始化时拉取待播放请求（解决新窗口点歌竞态问题）---
        ipcMain.handle('music-capsule-get-state', async () => {
            if (settingsManager) applyInjectionSetting(await settingsManager.readSettings());
            return getMusicCapsuleSnapshot();
        });
        ipcMain.handle('music-info-injection-toggle', async event => {
            if (!mainWindow || event.sender !== mainWindow.webContents) {
                throw new Error('仅主聊天窗口可以切换音乐信息注入。');
            }
            if (!settingsManager) throw new Error('设置管理器未初始化。');
            const result = await settingsManager.updateSettings(current => ({
                ...current,
                musicInfoInjectionEnabled: current.musicInfoInjectionEnabled === false
            }));
            if (!result.success) throw new Error(result.error || '保存音乐信息注入状态失败。');
            applyInjectionSetting(result.settings);
            return getMusicCapsuleSnapshot();
        });
        ipcMain.on('music-groove-publish', (event, payload) => {
            if (!musicWindow || musicWindow.isDestroyed() || event.sender !== musicWindow.webContents) return;
            musicGrooveBus.publish(payload);
        });
        ipcMain.on('music-capsule-publish', (event, state) => {
            if (!musicWindow || musicWindow.isDestroyed() || event.sender !== musicWindow.webContents) return;
            musicCapsuleState = {
                open: true,
                title: typeof state?.title === 'string' ? state.title.slice(0, 512) : '',
                trackKey: typeof state?.trackKey === 'string' ? state.trackKey.slice(0, 4096) : '',
                playing: state?.playing === true
            };
            publishMusicCapsule();
            musicThumbar.update(musicWindow, { playing: musicCapsuleState.playing });
            if (!musicCapsuleState.playing) musicGrooveBus.publish({ playing: false });
            followTrackChange(state).catch(() => {});
        });
        ipcMain.on('music-capsule-command', (event, command) => {
            if (!mainWindow || event.sender !== mainWindow.webContents) return;
            if (!['previous', 'next', 'play', 'pause'].includes(command)) return;
            if (musicWindow && !musicWindow.isDestroyed()) musicWindow.webContents.send('music-control', command);
        });

        ipcMain.handle('music-get-audio-engine-endpoint', () => audioEngineEndpoint.getEndpoint());
        ipcMain.handle('music-translate-lyrics', async (event, payload) => {
            if (!musicWindow || musicWindow.isDestroyed() || event.sender !== musicWindow.webContents) {
                return { status: 'error', message: '只有音乐窗口可以翻译歌词' };
            }
            return lyricsTranslator.translate(payload || {});
        });

        // 频谱检查（真假无损）：把本机音频文件的原始字节交给音乐窗口去解码分析。只认音频扩展名、只给音乐窗口。
        ipcMain.handle('music-read-audio-file', async (event, payload) => {
            if (!musicWindow || musicWindow.isDestroyed() || event.sender !== musicWindow.webContents) {
                return { ok: false, message: '只有音乐窗口可以读' };
            }
            const file = payload && typeof payload.path === 'string' ? payload.path : '';
            if (!file || !path.isAbsolute(file) || !/\.(flac|mp3|wav|m4a|aac|ogg|opus|wv|aiff?|alac|ape|dsf|dff|wma)$/i.test(file)) {
                return { ok: false, message: '只能分析本机的音频文件' };
            }
            try {
                const stat = await fs.stat(file);
                if (!stat.isFile()) return { ok: false, message: '文件不在了' };
                if (stat.size > 400 * 1024 * 1024) return { ok: false, message: '文件太大（超过 400 MB），没法在窗口里分析' };
                const data = await fs.readFile(file);
                return { ok: true, data, size: stat.size };
            } catch (err) {
                return { ok: false, message: err && err.code === 'ENOENT' ? '文件不在了' : '读取失败：' + (err && err.message || err) };
            }
        });

        // 右键「在文件夹中显示」：只接受曲库里那种本机绝对路径，文件得还在
        ipcMain.handle('music-show-in-folder', async (event, payload) => {
            if (!musicWindow || musicWindow.isDestroyed() || event.sender !== musicWindow.webContents) return { ok: false, message: '只有音乐窗口可以用' };
            const file = typeof payload?.path === 'string' ? payload.path : '';
            if (!file || !path.isAbsolute(file)) return { ok: false, message: '这首没有本机文件' };
            const stat = await fs.stat(file).catch(() => null);
            if (!stat || !stat.isFile()) return { ok: false, message: '文件已经不在原来的位置了' };
            electron.shell.showItemInFolder(file);
            return { ok: true };
        });

        // 曲库文件夹管理：列出加过的文件夹、打开、移出（曲目由音乐窗口先从曲库拿掉并存盘，这里只忘掉文件夹、重建监听）、立即重扫
        ipcMain.handle('music-library-folders', async (event, payload) => {
            if (!musicWindow || musicWindow.isDestroyed() || event.sender !== musicWindow.webContents) return { ok: false, message: '只有音乐窗口可以用' };
            const op = payload?.op || 'list';
            const dir = typeof payload?.path === 'string' ? payload.path : '';
            try {
                if (op === 'list') {
                    const folders = typeof libraryWatch.folders === 'function' ? await libraryWatch.folders() : [];
                    const withState = await Promise.all(folders.map(async (d) => ({
                        path: d,
                        exists: Boolean((await fs.stat(d).catch(() => null))?.isDirectory())
                    })));
                    return { ok: true, folders: withState };
                }
                if (!dir || !path.isAbsolute(dir)) return { ok: false, message: '不是本机文件夹' };
                if (op === 'open') {
                    const stat = await fs.stat(dir).catch(() => null);
                    if (!stat || !stat.isDirectory()) return { ok: false, message: '这个文件夹已经不在了' };
                    const err = await electron.shell.openPath(dir);
                    return err ? { ok: false, message: err } : { ok: true };
                }
                if (op === 'forget') {
                    if (typeof libraryWatch.forgetFolder === 'function') await libraryWatch.forgetFolder(dir);
                    libraryWatch.start();
                    return { ok: true };
                }
                if (op === 'rescan') {
                    await libraryWatch.rescanNow?.();
                    return { ok: true };
                }
                return { ok: false, message: '不认识的操作' };
            } catch (err) {
                return { ok: false, message: String(err && err.message || err) };
            }
        });

        // 歌单导出 / 导入 .m3u8（和别的播放器互通）。只给音乐窗口；导出走保存对话框，导入走打开对话框或拖进来的文件。
        const fromMusicWindow = (event) => musicWindow && !musicWindow.isDestroyed() && event.sender === musicWindow.webContents;
        ipcMain.handle('music-m3u-export', async (event, payload) => {
            if (!fromMusicWindow(event)) return { ok: false, message: '只有音乐窗口可以导出' };
            const name = String(payload?.name || '');
            const tracks = Array.isArray(payload?.tracks) ? payload.tracks.slice(0, 50000) : [];
            if (!tracks.length) return { ok: false, message: '这个歌单是空的' };
            const result = await dialog.showSaveDialog(musicWindow, {
                title: '导出歌单',
                defaultPath: m3u.safeFileName(name) + '.m3u8',
                filters: [{ name: 'M3U8 歌单', extensions: ['m3u8'] }, { name: 'M3U 歌单', extensions: ['m3u'] }]
            });
            if (result.canceled || !result.filePath) return { ok: false, canceled: true };
            try {
                const text = m3u.buildM3u(name, tracks);
                // .m3u 给老播放器用：带 BOM 让它们认出是 UTF-8
                await fs.writeFile(result.filePath, /\.m3u$/i.test(result.filePath) ? '\uFEFF' + text : text, 'utf8');
                return { ok: true, file: result.filePath, count: tracks.length };
            } catch (err) {
                return { ok: false, message: '写不进去：' + (err && err.message || err) };
            }
        });
        ipcMain.handle('music-m3u-import', async (event, payload) => {
            if (!fromMusicWindow(event)) return { ok: false, message: '只有音乐窗口可以导入' };
            let file = typeof payload?.path === 'string' ? payload.path : '';
            if (!file) {
                const result = await dialog.showOpenDialog(musicWindow, {
                    title: '导入歌单',
                    filters: [{ name: '歌单', extensions: ['m3u8', 'm3u'] }],
                    properties: ['openFile']
                });
                if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
                file = result.filePaths[0];
            }
            if (!path.isAbsolute(file) || !/\.m3u8?$/i.test(file)) return { ok: false, message: '只认 .m3u / .m3u8 歌单' };
            try {
                const stat = await fs.stat(file);
                if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return { ok: false, message: '这个文件不像歌单' };
                const parsed = m3u.parseM3u(m3u.decodeM3u(await fs.readFile(file), file), { baseDir: path.dirname(file) });
                // 几千行的歌单逐个查文件太慢（网络盘、拔掉的盘每次都要等）：同一文件夹只查一次在不在，再 32 个一批并行查文件
                const list = parsed.entries.slice(0, 50000);
                const dirs = new Map();
                const dirOk = (d) => { if (!dirs.has(d)) dirs.set(d, fs.stat(d).then((s) => s.isDirectory(), () => false)); return dirs.get(d); };
                const entries = new Array(list.length);
                for (let at = 0; at < list.length; at += 32) {
                    await Promise.all(list.slice(at, at + 32).map(async (entry, k) => {
                        const s = (await dirOk(path.dirname(entry.path))) ? await fs.stat(entry.path).catch(() => null) : null;
                        entries[at + k] = { ...entry, exists: Boolean(s && s.isFile()) };
                    }));
                }
                return { ok: true, file, name: parsed.name || path.basename(file).replace(/\.m3u8?$/i, ''), entries, skipped: parsed.skipped };
            } catch (err) {
                return { ok: false, message: err && err.code === 'ENOENT' ? '文件不在了' : '读取失败：' + (err && err.message || err) };
            }
        });

        audioEngineEndpoint.onStatus((endpoint) => {
            if (musicWindow && !musicWindow.isDestroyed()) {
                musicWindow.webContents.send('audio-engine-status', endpoint);
            }
        });

        ipcMain.handle('music-get-pending-track', () => {
            const playbackRequest = pendingPlaybackForNewWindow;
            pendingPlaybackForNewWindow = null; // 取出后清空，只消费一次
            if (playbackRequest?.track) {
                console.log(
                    '[Music] Pending playback request consumed by renderer:',
                    playbackRequest.track.title,
                    playbackRequest.stageMode || 'regular'
                );
            }
            return playbackRequest; // 返回 null 或 { track, stageMode }
        });

        ipcMain.handle('music-load', async (event, track) => {
            if (track && track.path) {
                currentSongInfo = {
                    title: track.title || '未知标题',
                    artist: track.artist || '未知艺术家',
                    album: track.album || '未知专辑',
                    path: track.path
                };
                
                // 检查是否是 WebDAV 远程曲目
                if (track.isRemote || track.path.startsWith('http://') || track.path.startsWith('https://')) {
                    // 按 serverId 取账号；没有或服务器已删时，按地址落在哪台服务器下面（路径边界、最长前缀）。
                    // 原来按纯前缀取第一台：同一台 NAS 上 /dav 和 /dav2 两个服务器时会拿错账号。
                    const creds = webdavManager.credentialsForTrack?.({ serverId: track.serverId, path: track.path });
                    if (creds?.username && creds?.password) {
                        return await webdavManager.configureAndLoad({
                            url: track.path,
                            username: creds.username,
                            password: creds.password
                        });
                    }
                    if (track.serverId) {
                        // 服务器已删：交给 configureAndLoad 给出明确的提示
                        return await webdavManager.configureAndLoad({ url: track.path, serverId: track.serverId });
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

        // 引擎设置（设备、EQ、DSP、预载、IR……）的 IPC 在 musicEngineHandlers.js
        if (typeof registerMusicEngineHandlers === 'function') {
            registerMusicEngineHandlers({ ipcMain, dialog, audioEngineApi, webdavManager, getDialogWindow: () => musicWindow || mainWindow });
        }

        ipcMain.handle('music-add-folder', async (event) => {
            const result = await dialog.showOpenDialog(musicWindow || mainWindow, {
                properties: ['openDirectory']
            });

            if (result.canceled || result.filePaths.length === 0) {
                return;
            }

            await runLibraryScan(event, { folderPath: result.filePaths[0] });
            await libraryWatch.rememberFolder(result.filePaths[0]);
        });

        // 拖进窗口的文件和文件夹：文件夹整个扫，单曲只读这几首。路径来自渲染端，逐个确认是本地的目录或音频文件。
        ipcMain.handle('music-add-paths', async (event, paths) => {
            if (!Array.isArray(paths)) return { added: 0 };
            const candidates = paths.slice(0, 2000).filter((raw) => typeof raw === 'string' && path.isAbsolute(raw));
            const stats = new Array(candidates.length);
            for (let at = 0; at < candidates.length; at += 32) {
                await Promise.all(candidates.slice(at, at + 32).map(async (raw, k) => {
                    stats[at + k] = await fs.stat(raw).catch(() => null);
                }));
            }
            const folders = [];
            const files = [];
            for (let i = 0; i < candidates.length; i++) {
                const raw = candidates[i];
                const stat = stats[i];
                if (stat?.isDirectory()) folders.push(raw);
                else if (stat?.isFile() && SUPPORTED_FORMATS.has(path.extname(raw).toLowerCase())) files.push(raw);
            }
            for (const folderPath of folders) {
                await runLibraryScan(event, { folderPath });
                await libraryWatch.rememberFolder(folderPath);
            }
            if (files.length) await runLibraryScan(event, { filePaths: files });
            return { folders: folders.length, files: files.length };
        });

        ipcMain.handle('get-music-playlist', () => readPlaylistFile());

        ipcMain.handle('save-music-playlist', async (event, playlist) => {
            try {
                // 不是数组就不写：写进去之后下次读出来是空曲库。
                if (!Array.isArray(playlist)) throw new TypeError('playlist must be an array');
                // 一份非空曲库被清空时先留个备份：曲库读取失败后界面以空列表存盘，整个曲库就没了。
                if (playlist.length === 0) await backupBeforeEmptying(MUSIC_PLAYLIST_FILE);
                // 用户移出曲库的歌记下来，后台同步文件夹时不再加回来（空列表多半是读取失败，不算）
                const previous = playlist.length ? await readPlaylistFile() : null;
                await writeJsonAtomic(MUSIC_PLAYLIST_FILE, playlist);
                if (previous) libraryWatch.noteLibrarySaved(previous, playlist);
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
                    const playlists = await fs.readJson(CUSTOM_PLAYLISTS_FILE);
                    return Array.isArray(playlists) ? playlists : [];
                }
                return [];
            } catch (error) {
                console.error('[Music] Error reading custom playlists:', error);
                return [];
            }
        });

        ipcMain.handle('save-custom-playlists', async (event, playlists) => {
            try {
                if (!Array.isArray(playlists)) throw new TypeError('playlists must be an array');
                if (playlists.length === 0) await backupBeforeEmptying(CUSTOM_PLAYLISTS_FILE);
                await writeJsonAtomic(CUSTOM_PLAYLISTS_FILE, playlists, { spaces: 2 });
                return { success: true };
            } catch (error) {
                console.error('[Music] Error saving custom playlists:', error);
                return { success: false, error: error.message };
            }
        });

        // --- 跨窗口音乐控制命令（桌面/分布式 → 音乐窗口）：高瞻远瞩智能路由 ---
        ipcMain.on('music-remote-command', async (event, command) => {
            try {
                // 1. 若命令携带目标曲目（支持对象形式或 play:曲目名 前缀），走权威 handleMusicControl 模糊匹配点播
                if (typeof command === 'object' && command && command.target) {
                    console.log(`[Music] Remote track targeted play: ${command.target}`);
                    await handleMusicControl({ command: 'play', target: command.target });
                    return;
                }
                if (typeof command === 'string' && command.startsWith('play:')) {
                    const target = command.substring(5).trim();
                    console.log(`[Music] Remote track targeted play by prefix: ${target}`);
                    await handleMusicControl({ command: 'play', target });
                    return;
                }

                // 2. 基础播控命令（next/previous/play/pause）：窗口存在则直通转发
                if (musicWindow && !musicWindow.isDestroyed()) {
                    console.log(`[Music] Forwarding remote command to music window: ${command}`);
                    musicWindow.webContents.send('music-control', command);
                } else {
                    // 窗口不存在时自动唤醒并延迟派发
                    console.log(`[Music] Music window offline for command '${command}', auto-spawning window...`);
                    await createOrFocusMusicWindow();
                    setTimeout(() => {
                        if (musicWindow && !musicWindow.isDestroyed()) {
                            musicWindow.webContents.send('music-control', command);
                        }
                    }, 600);
                }
            } catch (err) {
                console.error('[Music] Error in music-remote-command handler:', err);
            }
        });

        ipcMain.handle('music-share-track', async (event, filePath) => {
            // 聊天附件只收本地文件：远程（WebDAV）曲目和已经不在磁盘上的文件在这里就说清楚，
            // 不然要到聊天窗口里才弹一个看不懂的「附加失败」。
            if (typeof filePath !== 'string' || /^https?:\/\//i.test(filePath)) {
                return { success: false, message: '远程曲目不能作为附件分享' };
            }
            if (!(await fs.pathExists(filePath))) {
                return { success: false, message: '这首歌的文件已经不在原来的位置了' };
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
                console.log(`[Music] Forwarding shared file to renderer: ${filePath}`);
                mainWindow.webContents.send('add-file-to-input', filePath);
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.focus();
                return { success: true };
            }
            return { success: false, message: '主窗口没有打开' };
        });

        // 歌词（本地读取、抓词、候选）的 IPC 在 musicLyricsHandlers.js
        if (typeof registerMusicLyricsHandlers === 'function') {
            registerMusicLyricsHandlers({ ipcMain, lyricFetcher, getLyricDir: () => LYRIC_DIR });
        }

        // WebDAV 的 IPC 在 musicWebdavHandlers.js
        if (typeof registerMusicWebdavHandlers === 'function') {
            registerMusicWebdavHandlers({
                ipcMain,
                webdavManager,
                getMusicWindow: () => musicWindow,
                setCurrentSongInfo: (info) => { currentSongInfo = info; }
            });
        }
    };

    // 先注册 IPC 处理器；仅当运行时无原生 fetch 时才动态加载 node-fetch
    registerIpcHandlers();
    ipcHandlersRegistered = true;
    console.log('[Music] IPC handlers registered.');

    if (!fetch) {
        import('node-fetch').then(module => {
            fetch = module.default;
            console.log('[Music] node-fetch loaded successfully.');
        }).catch(err => {
            console.error('[Music] Failed to load node-fetch:', err);
        });
    }
}

module.exports = {
    initialize,
    handleMusicControl,
    createOrFocusMusicWindow,
    getMusicWindow: () => musicWindow,
    getMusicState: () => ({ musicWindow, currentSongInfo })
};
