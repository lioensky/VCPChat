// Musicmodules/music.js - Entry Point for the Refactored Music Player
document.addEventListener('DOMContentLoaded', () => {
    const PLAY_MODE_STORAGE_KEY = 'musicPlayMode';
    const PLAY_MODES = Object.freeze(['repeat', 'repeat-one', 'shuffle']);
    const storedPlayMode = localStorage.getItem(PLAY_MODE_STORAGE_KEY);
    const initialPlayModeIndex = Math.max(0, PLAY_MODES.indexOf(storedPlayMode));
    const LOUDNESS_MODE_ALIASES = Object.freeze({ album: 'replaygain_album', streaming: 'track' });
    const normalizeLoudnessMode = (mode) => LOUDNESS_MODE_ALIASES[mode] || mode || 'track';

    const app = {
        // --- DOM Elements ---
        playPauseBtn: document.getElementById('play-pause-btn'),
        prevBtn: document.getElementById('prev-btn'),
        nextBtn: document.getElementById('next-btn'),
        modeBtn: document.getElementById('mode-btn'),
        volumeBtn: document.getElementById('volume-btn'),
        volumeSlider: document.getElementById('volume-slider'),
        progressContainer: document.querySelector('.progress-container'),
        progressBar: document.querySelector('.progress-bar'),
        progress: document.querySelector('.progress'),
        currentTimeEl: document.querySelector('.current-time'),
        durationEl: document.querySelector('.duration'),
        albumArt: document.querySelector('.album-art'),
        albumArtWrapper: document.querySelector('.album-art-wrapper'),
        trackTitle: document.querySelector('.track-title'),
        trackArtist: document.querySelector('.track-artist'),
        trackBitrate: document.querySelector('.track-bitrate'),
        playlistEl: document.getElementById('playlist'),
        addFolderBtn: document.getElementById('add-folder-btn'),
        searchInput: document.getElementById('search-input'),
        loadingIndicator: document.getElementById('loading-indicator'),
        scanProgressContainer: document.querySelector('.scan-progress-container'),
        scanProgressBar: document.querySelector('.scan-progress-bar'),
        scanProgressLabel: document.querySelector('.scan-progress-label'),
        playerBackground: document.getElementById('player-background'),
        visualizerCanvas: document.getElementById('visualizer'),
        visualizerCtx: document.getElementById('visualizer').getContext('2d'),
        shareBtn: document.getElementById('share-btn'),
        deviceSelect: document.getElementById('device-select'),
        wasapiSwitch: document.getElementById('wasapi-switch'),
        eqSwitch: document.getElementById('eq-switch'),
        eqBandsContainer: document.getElementById('eq-bands'),
        eqPresetSelect: document.getElementById('eq-preset-select'),
        eqSection: document.getElementById('eq-section'),
        eqTypeSelect: document.getElementById('eq-type-select'),
        firTapsSelect: document.getElementById('fir-taps-select'),
        ditherSwitch: document.getElementById('dither-switch'),
        replaygainSwitch: document.getElementById('replaygain-switch'),
        upsamplingSelect: document.getElementById('upsampling-select'),
        resampleQualitySelect: document.getElementById('resample-quality-select'),
        resampleCacheSwitch: document.getElementById('resample-cache-switch'),
        preemptiveResampleSwitch: document.getElementById('preemptive-resample-switch'),
        lyricsContainer: document.getElementById('lyrics-container'),
        lyricsList: document.getElementById('lyrics-list'),
        irSwitch: document.getElementById('ir-switch'),
        irPresetSelect: document.getElementById('ir-preset-select'),
        irLoadBtn: document.getElementById('ir-load-btn'),
        irStatus: document.getElementById('ir-status'),
        loudnessSwitch: document.getElementById('loudness-switch'),
        loudnessModeSelect: document.getElementById('loudness-mode-select'),
        loudnessLufsSlider: document.getElementById('loudness-lufs-slider'),
        loudnessLufsValue: document.getElementById('loudness-lufs-value'),
        loudnessPreampSlider: document.getElementById('loudness-preamp-slider'),
        loudnessPreampValue: document.getElementById('loudness-preamp-value'),
        loudnessInfo: document.getElementById('loudness-info'),
        loudnessCurrentLufs: document.getElementById('loudness-current-lufs'),
        saturationSwitch: document.getElementById('saturation-switch'),
        saturationTypeSelect: document.getElementById('saturation-type-select'),
        saturationDriveSlider: document.getElementById('saturation-drive-slider'),
        saturationDriveValue: document.getElementById('saturation-drive-value'),
        saturationMixSlider: document.getElementById('saturation-mix-slider'),
        saturationMixValue: document.getElementById('saturation-mix-value'),
        crossfeedSwitch: document.getElementById('crossfeed-switch'),
        crossfeedMixSlider: document.getElementById('crossfeed-mix-slider'),
        crossfeedMixValue: document.getElementById('crossfeed-mix-value'),
        dynamicLoudnessSwitch: document.getElementById('dynamic-loudness-switch'),
        crossfadeSelect: document.getElementById('crossfade-select'),
        dynamicLoudnessStrengthSlider: document.getElementById('dynamic-loudness-strength-slider'),
        dynamicLoudnessStrengthValue: document.getElementById('dynamic-loudness-strength-value'),
        dynamicLoudnessFactor: document.getElementById('dynamic-loudness-factor'),
        outputBitsSelect: document.getElementById('output-bits-select'),
        noiseShaperCurveSelect: document.getElementById('noise-shaper-curve-select'),
        phantomAudio: document.getElementById('phantom-audio'),
        minimizeBtn: document.getElementById('minimize-music-btn'),
        maximizeBtn: document.getElementById('maximize-music-btn'),
        closeBtn: document.getElementById('close-music-btn'),
        leftSidebar: document.getElementById('left-sidebar'),
        sidebarTabs: document.querySelectorAll('.sidebar-tab'),
        sidebarFooter: document.getElementById('sidebar-footer'),
        createPlaylistBtn: document.getElementById('create-playlist-btn'),
        playlistDialog: document.getElementById('playlist-dialog'),
        playlistNameInput: document.getElementById('playlist-name-input'),
        dialogCancel: document.getElementById('dialog-cancel'),
        dialogConfirm: document.getElementById('dialog-confirm'),
        contextMenu: document.getElementById('track-context-menu'),
        playlistSubmenu: document.getElementById('playlist-submenu'),
        playlistEditModal: document.getElementById('playlist-edit-modal'),
        modalPlaylistTitle: document.getElementById('modal-playlist-title'),
        modalCloseBtn: document.getElementById('modal-close-btn'),
        modalSearchInput: document.getElementById('modal-search-input'),
        modalSongList: document.getElementById('modal-song-list'),
        modalCount: document.getElementById('modal-count'),
        modalDoneBtn: document.getElementById('modal-done-btn'),
        webdavModal: document.getElementById('webdav-modal'),
        webdavModalClose: document.getElementById('webdav-modal-close'),
        webdavServerList: document.getElementById('webdav-server-list'),
        webdavAddServerBtn: document.getElementById('webdav-add-server-btn'),
        webdavFileList: document.getElementById('webdav-file-list'),
        webdavBreadcrumb: document.getElementById('webdav-breadcrumb'),
        webdavScanBtn: document.getElementById('webdav-scan-btn'),
        webdavImportBtn: document.getElementById('webdav-import-btn'),
        webdavServerDialog: document.getElementById('webdav-server-dialog'),
        webdavDialogCancel: document.getElementById('webdav-dialog-cancel'),
        webdavDialogTest: document.getElementById('webdav-dialog-test'),
        webdavDialogConfirm: document.getElementById('webdav-dialog-confirm'),
        webdavDialogStatus: document.getElementById('webdav-dialog-status'),
        addWebDavBtn: document.getElementById('add-webdav-btn'),
        semanticSearchBtn: document.getElementById('semantic-search-btn'),
        lyricsFetchModal: document.getElementById('lyrics-fetch-modal'),
        lyricsFetchClose: document.getElementById('lyrics-fetch-close'),
        lyricsFetchTrack: document.getElementById('lyrics-fetch-track'),
        lyricsFetchTitle: document.getElementById('lyrics-fetch-title'),
        lyricsFetchArtist: document.getElementById('lyrics-fetch-artist'),
        lyricsFetchSearchBtn: document.getElementById('lyrics-fetch-search-btn'),
        lyricsFetchStatus: document.getElementById('lyrics-fetch-status'),
        lyricsFetchResults: document.getElementById('lyrics-fetch-results'),
        lyricsFetchSelection: document.getElementById('lyrics-fetch-selection'),
        lyricsFetchApply: document.getElementById('lyrics-fetch-apply'),
        api: window.utilityAPI || window.electronAPI,

        // --- State Variables ---
        playlist: [],
        currentFilteredTracks: null,
        filteredPlaylistSource: null,
        currentTrackIndex: 0,
        isPlaying: false,
        playModes: PLAY_MODES,
        currentPlayMode: initialPlayModeIndex,
        currentDeviceId: null,
        useWasapiExclusive: false,
        eqEnabled: false,
        eqBands: { "32": 0, "64": 0, "125": 0, "250": 0, "500": 0, "1k": 0, "2k": 0, "4k": 0, "8k": 0, "16k": 0 },
        eqPresets: {
            'balance': { "32": 0, "64": 0, "125": 0, "250": 0, "500": 0, "1k": 0, "2k": 0, "4k": 0, "8k": 0, "16k": 0 },
            'classical': { "32": 0, "64": 0, "125": 0, "250": 0, "500": 0, "1k": 0, "2k": 4, "4k": 4, "8k": 4, "16k": -2 },
            'pop': { "32": -2, "64": 0, "125": 2, "250": 4, "500": -2, "1k": -2, "2k": 0, "4k": 0, "8k": 0, "16k": -2 },
            'rock': { "32": 4, "64": 4, "125": 3, "250": 1, "500": -2, "1k": -2, "2k": 0, "4k": 2, "8k": 4, "16k": 4 },
            'electronic': { "32": 6, "64": 5, "125": 0, "250": -2, "500": -2, "1k": 0, "2k": 2, "4k": 4, "8k": 5, "16k": 6 },
            'acg_vocal': { "32": -2, "64": -2, "125": -1, "250": 0, "500": 2, "1k": 4, "2k": 5, "4k": 4, "8k": 2, "16k": 0 }
        },
        targetUpsamplingRate: 0,
        irEnabled: false,
        irLoadedPath: null,
        loudnessEnabled: true,
        loudnessMode: 'track',
        targetLufs: -12.0,
        loudnessPreampDb: 0.0,
        saturationEnabled: false,
        saturationType: 'tube',
        saturationDrive: 0.25,
        saturationMix: 0.2,
        crossfeedEnabled: false,
        crossfeedMix: 0.3,
        dynamicLoudnessEnabled: false,
        dynamicLoudnessStrength: 1.0,
        outputBits: 32,
        noiseShaperCurve: 'TpdfOnly',

        // --- Visualizer State ---
        ws: null,
        animationFrameId: null,
        targetVisualizerData: [],
        currentVisualizerData: [],
        easingFactor: 0.18,
        visualizerColor: { r: 0, g: 195, b: 255 },
        particles: [],
        PARTICLE_COUNT: 45,
        COVER_MID_START_RATIO: 0.12,
        COVER_MID_END_RATIO: 0.42,
        COVER_PULSE_FLOOR: 0.22,
        COVER_PULSE_INTENSITY: 0.13,
        COVER_PULSE_SMOOTHING: 0.45,
        coverPulseEnergy: 0,
        bassScale: 1.0,

        // --- Lyrics State ---
        currentLyrics: [],
        currentLyricIndex: -1,
        lastKnownCurrentTime: 0,
        lastKnownDuration: 0,
        lastStateUpdateTime: 0,
        lyricOffset: 0,
        lyricSpeedFactor: 1.0,
        lyricsRequestToken: 0,

        // --- Other State ---
        currentTheme: 'dark',
        statePollInterval: null,
        isTrackLoading: false,
        pendingLoadRequestId: 0,
        pendingTrackPath: null,
        isPreloadingNext: false,
        saveSettingsTimer: null,
        backgroundTransitionTimer: null,
        backgroundTransitionToken: 0,
        customPlaylists: [],
        currentSidebarView: 'all',
        contextMenuTrackIndex: null,
        editingPlaylistId: null,
        modalSearchQuery: '',
        lastModalClickIndex: -1,
        pendingAddToPlaylist: null,
        webdavServers: [],
        activeWebDavServer: null,
        webdavCurrentPath: '/',
        webdavScannedTracks: [],
        shuffleQueue: [],
        lastShuffleList: null,
        wnpAdapter: null,
        _gaplessJustSwitched: false,
        _gaplessSwitchTimer: null,
        dragInProgress: false,
        isChangingState: false,
        lastCommandTime: 0,
        expectedPlayingState: false,
        isSemanticSearchActive: false,
        isSemanticSearching: false,
        isStageActive: false,
        stageHost: null,
        lyricsFetchTrackIndex: null,
        lyricsFetchCandidates: [],
        selectedLyricsCandidateKey: null,
        lyricsFetchRequestToken: 0,
        sidebarScrollEndTimer: null,
        isSidebarScrolling: false,
        silentAudioUrl: null,
        destroyed: false,
    };


    let disposeAudioEngineStatus = null;
    let disposeElectronHandlers = null;
    let disposeEventListeners = null;
    let modalSearchTimer = null;
    app.destroy = () => {
        if (app.destroyed) return;
        app.destroyed = true;
        app.lyricsRequestToken++;
        app.disposeCurrentLyricsQuery?.();
        app.disposeCurrentLyricsQuery = null;
        disposeAudioEngineStatus?.();
        disposeAudioEngineStatus = null;
        disposeElectronHandlers?.();
        disposeElectronHandlers = null;
        disposeEventListeners?.();
        disposeEventListeners = null;

        app.stageHost?.destroy?.();
        app.destroyAmbientPixi?.();
        app.destroyVisualizer?.();
        app.wnpAdapter?.destroy?.();
        app.wnpAdapter = null;

        app.stopStatePolling?.();
        if (app.saveSettingsTimer) {
            clearTimeout(app.saveSettingsTimer);
            app.saveSettingsTimer = null;
        }
        if (app.searchInputTimer) {
            clearTimeout(app.searchInputTimer);
            app.searchInputTimer = null;
        }
        if (modalSearchTimer) {
            clearTimeout(modalSearchTimer);
            modalSearchTimer = null;
        }
        if (app.backgroundTransitionTimer) {
            clearTimeout(app.backgroundTransitionTimer);
            app.backgroundTransitionTimer = null;
        }
        if (app._gaplessSwitchTimer) {
            clearTimeout(app._gaplessSwitchTimer);
            app._gaplessSwitchTimer = null;
        }
        if (app.sidebarScrollEndTimer) {
            clearTimeout(app.sidebarScrollEndTimer);
            app.sidebarScrollEndTimer = null;
        }
        app.isSidebarScrolling = false;
        app.leftSidebar?.classList.remove('sidebar-is-scrolling');
        document.body.classList.remove('sidebar-is-scrolling');

        if ('mediaSession' in navigator) {
            ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto'].forEach((action) => {
                try { navigator.mediaSession.setActionHandler(action, null); } catch (error) {}
            });
            navigator.mediaSession.metadata = null;
        }

        if (app.phantomAudio) {
            app.phantomAudio.onplay = null;
            app.phantomAudio.onpause = null;
            app.phantomAudio.pause();
            app.phantomAudio.removeAttribute('src');
            app.phantomAudio.load();
        }
        if (app.silentAudioUrl) {
            URL.revokeObjectURL(app.silentAudioUrl);
            app.silentAudioUrl = null;
        }

        app.currentLyrics = [];
        app.lyricsFetchCandidates = [];
        app.currentFilteredTracks = null;
        app.filteredPlaylistSource = null;
    };

    window.addEventListener('beforeunload', app.destroy, { once: true });


    const normalizePlaybackRequest = (payload) => {
        if (payload?.track && typeof payload.track === 'object') {
            return {
                track: payload.track,
                stageMode: typeof payload.stageMode === 'string' ? payload.stageMode : null
            };
        }

        // Backward compatibility for callers that still send the track directly.
        return {
            track: payload,
            stageMode: null
        };
    };

    app.playRequestedTrack = async (payload) => {
        const { track, stageMode } = normalizePlaybackRequest(payload);
        if (!track || !track.path) return false;

        if (stageMode && app.stageHost) {
            app.stageHost.setMode(stageMode);
            app.stageHost.enter();
        }

        const normalizedTrackPath = app.normalizePathForCompare(track.path);
        let trackIndex = app.playlist.findIndex(candidate =>
            app.normalizePathForCompare(candidate.path) === normalizedTrackPath
        );

        // If path matching fails, use the existing title-based fallback.
        if (trackIndex === -1 && track.title) {
            const normalizedTitle = track.title.toLowerCase();
            trackIndex = app.playlist.findIndex(candidate => {
                const candidateTitle = (candidate.title || '').toLowerCase();
                return candidateTitle.includes(normalizedTitle)
                    || (normalizedTitle.includes(candidateTitle) && candidateTitle.length > 2);
            });
        }

        if (trackIndex === -1) {
            app.playlist.push(track);
            trackIndex = app.playlist.length - 1;
            app.renderPlaylist(app.currentFilteredTracks);
            await app.saveLibrary();
        }

        await app.loadTrack(trackIndex, true);
        return true;
    };

    // --- Audio engine endpoint & status ---
    // 引擎端口由主进程启动时探测决定；引擎没起来时在窗口顶部说明原因，而不是只显示时长 0:00。
    const audioEngineNotice = document.getElementById('audio-engine-notice');
    const applyAudioEngineEndpoint = (endpoint) => {
        if (!endpoint) return;
        const previousUrl = app.audioEngineWsUrl;
        if (endpoint.wsUrl) app.audioEngineWsUrl = endpoint.wsUrl;
        const failed = endpoint.state === 'failed';
        if (audioEngineNotice) {
            audioEngineNotice.hidden = !failed;
            const detail = audioEngineNotice.querySelector('.audio-engine-notice-detail');
            if (detail) detail.textContent = failed ? (endpoint.message || '') : '';
        }
        // 引擎换了端口重新就绪后，立即连到新地址，不等 5 秒重连。
        if (endpoint.state === 'ready' && previousUrl && previousUrl !== app.audioEngineWsUrl) {
            try { app.ws?.close(); } catch (_) { /* ignore */ }
            app.ws = null;
            app.connectWebSocket();
        }
        recoverAfterEngineRestart(endpoint.state);
    };
    // 引擎用着用着崩了又被重启：新引擎里什么都没加载。把那首歌重新加载回去、跳回原来的位置，
    // 原来在放就接着放。只认「就绪过 → 断了 → 又就绪」，窗口刚打开时的启动过程不算。
    let engineSeenReady = false;
    let engineLost = false;
    const recoverAfterEngineRestart = (state) => {
        if (state === 'ready') {
            const lost = engineLost;
            engineSeenReady = true;
            engineLost = false;
            if (!lost) return;
            const track = app.playlist[app.currentTrackIndex];
            app.engineTrackPath = null;
            if (!track) return;
            const wasPlaying = app.isPlaying === true || app.playIntent === true;
            const resumeAt = Math.max(0, Number(app.lastKnownCurrentTime) || 0);
            const index = app.currentTrackIndex;
            app.skipHistoryOnce = true;
            // 先加载、跳到原位置再播，不从头响一下。
            Promise.resolve(app.loadTrack(index, false)).then(async () => {
                if (app.currentTrackIndex !== index || app.engineTrackPath !== track.path) return; // 期间换了歌
                if (resumeAt > 1) await app.seekTo(resumeAt);
                if (wasPlaying && app.currentTrackIndex === index) app.playTrack();
            }).catch(error => console.warn('[Music] Reload after engine restart failed:', error));
        } else if (engineSeenReady && (state === 'failed' || state === 'starting' || state === 'stopped')) {
            engineLost = true;
        }
    };
    const refreshAudioEngineEndpoint = async () => {
        if (!app.api?.getAudioEngineEndpoint) return;
        try {
            applyAudioEngineEndpoint(await app.api.getAudioEngineEndpoint());
        } catch (error) {
            console.warn('[Music] Failed to read audio engine endpoint:', error);
        }
    };
    disposeAudioEngineStatus = app.api?.onAudioEngineStatus?.(applyAudioEngineEndpoint) || null;

    // --- Initialization ---
    const init = async () => {
        // Setup modules
        setupUtils(app);
        if (typeof setupAmbientPixi === 'function') {
            setupAmbientPixi(app);
        }
        setupVisualizer(app);
        setupLyrics(app);
        setupPlayer(app);
        setupOutput(app);
        setupEffects(app);
        setupWebDav(app);
        setupSidebar(app);
        setupUI(app);
        setupMusicStage(app);
        window.setupMusicSkin?.(app);
        window.MusicArchive?.init(app);

        // --- Handlers & Listeners ---
        disposeEventListeners = setupEventListeners();
        disposeElectronHandlers = setupElectronHandlers();
        window.setupMusicLikes?.(app); // 「喜欢」：右键菜单那一项要包在上面的菜单入口外面
        window.setupMusicGoto?.(app); // 右键「转到歌手 / 转到专辑」
        window.setupMusicSleep?.(app); // 定时关闭（入口在底栏抽屉）
        window.setupMusicStats?.(app); // 听歌记录（次数、上次播放、跳过），只存本机
        window.setupMusicRadio?.(app); // 电台与自动续播：一组放完接着放相似的歌，右键「从这首开电台」
        // 下面这些以前由 music-radio.js 在 setupMusicRadio 末尾顺带装上，顺序不变
        const installLater = (name, lib, fn) => { try { window[lib]?.[fn]?.(app); } catch (e) { console.warn(`[Music] ${name} 没装上:`, e); } };
        installLater('频谱检查', 'MusicSpectrum', 'setupMusicSpectrum'); // 右键「看频谱」
        installLater('按设备记 EQ', 'MusicDeviceSound', 'setupMusicDeviceSound');
        installLater('M3U 导入导出', 'MusicM3u', 'setupMusicM3u');
        installLater('在文件夹中显示', 'MusicTrackFile', 'setupMusicTrackFile');
        installLater('曲库文件夹', 'MusicFolders', 'setupMusicFolders');
        installLater('EQ 预设', 'MusicEqPresets', 'setupMusicEqPresets');
        installLater('声道', 'MusicChannels', 'setupMusicChannels'); // 新引擎才有
        installLater('窗口标题', 'MusicWindowTitle', 'setupMusicWindowTitle');
        installLater('撤销移除', 'MusicQueueUndo', 'setupMusicQueueUndo');
        window.setupMusicLyricsAi?.(app); // 外语歌词没有翻译时用 VCP 的模型翻成中文
        window.setupMusicSmart?.(app); // 智能歌单：检索框里的条件词（喜欢、没听过、次数>N……），存下来自己更新
        window.setupMusicDesktopLyrics?.(app); // 桌面歌词：开着时把当前行送给桌面上的歌词条
        app.setupWebDavHandlers();
        app.setupMediaSessionHandlers();

        // 并行预发起互不依赖的启动 IPC（引擎地址、主题、曲库、待播请求、歌单、当前状态），
        // 避免主进程读盘和引擎探测串行等待，后面仍严格按原顺序应用结果。
        const endpointPromise = app.api?.getAudioEngineEndpoint?.().catch((error) => {
            console.warn('[Music] Failed to read audio engine endpoint:', error);
            return null;
        });
        const themePromise = app.api?.getCurrentTheme?.().catch(() => null);
        const playlistPromise = app.api?.getMusicPlaylist?.();
        const pendingPromise = app.api?.getMusicPlaylist ? app.api?.getMusicPendingTrack?.() : null;
        const customPlaylistsPromise = app.api?.getMusicPlaylist ? app.loadCustomPlaylists() : null;
        const initialStatePromise = app.api?.getMusicPlaylist ? app.api?.getMusicState?.() : null;

        // Initial values
        app.initBackgroundLayers();
        // 档案页盖住经典视图时跳过对隐藏画布的同步布局测量，切回经典视图时由 archive-view 重置尺寸
        if (!app.isArchiveActive && app.visualizerCanvas) {
            app.visualizerCanvas.width = app.visualizerCanvas.clientWidth;
            app.visualizerCanvas.height = app.visualizerCanvas.clientHeight;
            app.recreateParticles();
        }
        if (endpointPromise) applyAudioEngineEndpoint(await endpointPromise);
        app.connectWebSocket();
        if (!app.animationFrameId) app.startVisualizerAnimation();
        app.updateModeButton();
        if (themePromise) {
            const theme = await themePromise;
            if (theme) app.applyTheme(theme);
        }
        window.MusicIntroLib?.init(app);

        if (typeof initMusicDock === 'function') initMusicDock(app);

        app.phantomAudio.src = app.createSilentAudio();
        app.wnpAdapter = new WebNowPlayingAdapter(app);

        if (app.api?.getMusicPlaylist) {
            let restoreQueueAfterSidebar = false;
            const savedPlaylist = await playlistPromise;
            if (savedPlaylist && savedPlaylist.length > 0) {
                app.playlist = savedPlaylist;
                app.renderPlaylist();
            }

            // 检查是否有待播放请求（AI 点歌触发的新窗口）
            const pendingPlayback = await pendingPromise;
            const pendingTrack = pendingPlayback?.track || pendingPlayback;
            if (pendingTrack && pendingTrack.path) {
                console.log(
                    '[Music] Found pending playback request from main process:',
                    pendingTrack.title,
                    pendingPlayback?.stageMode || 'regular'
                );
                // 引擎要把整首歌解码完才算加载好，可能要几秒。这里不等它：
                // 侧栏、音效设置和“窗口就绪”信号都不该被第一首歌的解码挡住。
                app.playRequestedTrack(pendingPlayback)
                    .catch(error => console.error('[Music] Pending playback failed:', error));
            } else if (app.playlist.length > 0) {
                // 没有待播放曲目：回到上次听的那首和进度（找不到就第一首），不自动播放。
                let initialIndex = 0;
                const resume = app.sessionStartPoint?.();
                if (resume) initialIndex = resume.index;
                else try {
                    const lastPath = app.normalizePathForCompare(localStorage.getItem('musicLastTrackPath'));
                    const found = lastPath
                        ? app.playlist.findIndex(t => app.normalizePathForCompare(t.path) === lastPath)
                        : -1;
                    if (found !== -1) initialIndex = found;
                } catch (error) {}
                app.loadTrack(initialIndex, false)
                    .then(() => {
                        // 加载期间用户没换歌，才跳回上次的进度
                        const total = Number(app.lastKnownDuration) || 0;
                        if (resume && resume.time > 1 && !(total > 0 && resume.time > total - 3)
                            && app.currentTrackIndex === initialIndex && !app.playIntent) app.seekTo(resume.time);
                    })
                    .catch(error => console.error('[Music] Initial track load failed:', error));
                restoreQueueAfterSidebar = !pendingTrack;
            }

            await customPlaylistsPromise;
            app.renderSidebarContent('all');
            // 侧栏初始化会清掉当前列表，所以上次的上下文和手动队列放在它之后恢复。
            if (restoreQueueAfterSidebar) app.applySessionQueue?.();

            const initialState = await initialStatePromise;
            if (initialState?.state?.volume !== undefined) {
                app.volumeSlider.value = initialState.state.volume;
                app.updateVolumeSliderBackground(initialState.state.volume);
            }
            syncInitialSettings(initialState);
            app.refreshAcousticSummary?.();
        }
        app.populateDeviceList(false);

        // Signal that the renderer is ready to handle commands
        if (app.api?.musicRendererReady) {
            console.log('[Music] Sending "music-renderer-ready" signal to main process.');
            app.api.musicRendererReady();
        }
        if (app.api?.windowReady) {
            app.api.windowReady('music');
        }
        app.createEqBands();
        app.populateEqPresets();
    };

    const setupEventListeners = () => {
        const listenerDisposers = [];
        const addManagedListener = (target, type, fn, opts) => {
            target?.addEventListener?.(type, fn, opts);
            listenerDisposers.push(() => target?.removeEventListener?.(type, fn, opts));
        };
        // 从资源管理器拖进来的文件：拦下默认动作，不然 Chromium 会跳去打开那个文件，整个播放器被换掉。
        // 能拿到本地路径时（新 preload）把拖进来的歌和文件夹加进曲库；拿不到就只是拦下。
        // 窗口里自己的拖拽（行拖到底栏入队）不带 Files，不受影响。
        const isFileDrag = (event) => {
            const types = event.dataTransfer?.types;
            if (!types) return false;
            if (typeof types.includes === 'function') return types.includes('Files');
            if (typeof types.contains === 'function') return types.contains('Files');
            for (let i = 0; i < types.length; i += 1) if (types[i] === 'Files') return true;
            return false;
        };
        const canImport = () => typeof app.api?.getPathForFile === 'function' && typeof app.api?.addMusicPaths === 'function';
        addManagedListener(document, 'dragover', (event) => {
            if (!isFileDrag(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = canImport() ? 'copy' : 'none';
        });
        addManagedListener(document, 'drop', (event) => {
            if (!isFileDrag(event)) return;
            event.preventDefault();
            if (!canImport()) return;
            const paths = Array.from(event.dataTransfer.files || [])
                .map((file) => { try { return app.api.getPathForFile(file); } catch (_) { return ''; } })
                .filter(Boolean);
            if (paths.length) app.api.addMusicPaths(paths)?.catch?.((error) => console.error('[Music] Adding dropped files failed:', error));
        });

        const formatCandidateDuration = (durationMs) => {
            const seconds = Math.max(0, Math.round((durationMs || 0) / 1000));
            return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        };

        const errText = (err, fallback) => (window.MusicErrorText ? window.MusicErrorText(err, fallback) : (err?.message || err || fallback));
        const setLyricsFetchStatus = (message = '', type = '') => {
            app.lyricsFetchStatus.textContent = message;
            app.lyricsFetchStatus.className = `lyrics-fetch-status${type ? ` ${type}` : ''}`;
        };

        const closeLyricsFetchModal = () => {
            app.lyricsFetchRequestToken++;
            app.lyricsFetchModal.classList.remove('visible');
            app.lyricsFetchTrackIndex = null;
            app.selectedLyricsCandidateKey = null;
        };

        const renderLyricsCandidates = () => {
            app.lyricsFetchResults.innerHTML = '';
            if (app.lyricsFetchCandidates.length === 0) {
                app.lyricsFetchResults.innerHTML = '<div class="music-modal-empty">没有找到可用歌词版本，可调整歌曲或歌手后重试</div>';
                return;
            }

            const fragment = document.createDocumentFragment();
            app.lyricsFetchCandidates.forEach(candidate => {
                const item = document.createElement('div');
                item.className = `lyrics-candidate${candidate.candidateKey === app.selectedLyricsCandidateKey ? ' selected' : ''}`;
                item.dataset.candidateKey = candidate.candidateKey;
                item.tabIndex = 0;
                item.setAttribute('role', 'radio');
                item.setAttribute('aria-checked', String(candidate.candidateKey === app.selectedLyricsCandidateKey));

                const radio = document.createElement('span');
                radio.className = 'lyrics-candidate-radio';
                radio.setAttribute('aria-hidden', 'true');

                const main = document.createElement('div');
                main.className = 'lyrics-candidate-main';

                const heading = document.createElement('div');
                heading.className = 'lyrics-candidate-heading';

                const source = document.createElement('span');
                source.className = 'lyrics-source-badge';
                source.textContent = candidate.sourceLabel || candidate.source;

                const title = document.createElement('span');
                title.className = 'lyrics-candidate-title';
                title.textContent = `${candidate.title || '未知歌曲'} · ${candidate.artist || '未知歌手'}`;

                const timing = document.createElement('span');
                timing.className = `lyrics-feature-badge ${candidate.isWordByWord ? 'word' : ''}`;
                timing.textContent = candidate.isWordByWord ? '流式逐字符' : '普通逐行';

                heading.append(source, title, timing);
                if (candidate.hasTranslation) {
                    const translation = document.createElement('span');
                    translation.className = 'lyrics-feature-badge translation';
                    translation.textContent = '翻译';
                    heading.appendChild(translation);
                }
                if (candidate.hasRomanization) {
                    const romanization = document.createElement('span');
                    romanization.className = 'lyrics-feature-badge';
                    romanization.textContent = '罗马音';
                    heading.appendChild(romanization);
                }

                const meta = document.createElement('div');
                meta.className = 'lyrics-candidate-meta';
                meta.textContent = `${candidate.album || '未知专辑'} · ${formatCandidateDuration(candidate.durationMs)} · ${candidate.lineCount} 行`;

                const preview = document.createElement('div');
                preview.className = 'lyrics-candidate-preview';
                preview.textContent = candidate.preview || '无可用预览';

                const score = document.createElement('div');
                score.className = 'lyrics-candidate-score';
                score.textContent = `${candidate.matchScore}% 匹配`;

                main.append(heading, meta, preview);
                item.append(radio, main, score);

                const selectCandidate = () => {
                    app.selectedLyricsCandidateKey = candidate.candidateKey;
                    app.lyricsFetchSelection.textContent = `已选择：${candidate.sourceLabel} · ${candidate.isWordByWord ? '流式逐字符' : '普通逐行'}`;
                    app.lyricsFetchApply.disabled = false;
                    // 原地切换选中态，保住键盘焦点，不销毁重建整张候选列表
                    for (const row of app.lyricsFetchResults.children) {
                        const on = row.dataset.candidateKey === candidate.candidateKey;
                        row.classList.toggle('selected', on);
                        row.setAttribute('aria-checked', String(on));
                    }
                };
                item.onclick = selectCandidate;
                item.onkeydown = (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        selectCandidate();
                    }
                };
                fragment.appendChild(item);
            });
            app.lyricsFetchResults.appendChild(fragment);
        };

        const searchLyricsCandidates = async () => {
            const track = app.playlist[app.lyricsFetchTrackIndex];
            const title = app.lyricsFetchTitle.value.trim();
            const artist = app.lyricsFetchArtist.value.trim();
            if (!track || !title) {
                setLyricsFetchStatus('请输入歌曲标题', 'error');
                return;
            }
            if (!app.api?.searchMusicLyricsCandidates) {
                setLyricsFetchStatus('当前版本未提供多源歌词接口', 'error');
                return;
            }

            const requestToken = ++app.lyricsFetchRequestToken;
            app.lyricsFetchSearchBtn.disabled = true;
            app.lyricsFetchApply.disabled = true;
            app.selectedLyricsCandidateKey = null;
            app.lyricsFetchCandidates = [];
            app.lyricsFetchSelection.textContent = '尚未选择歌词版本';
            app.lyricsFetchResults.innerHTML = '<div class="music-modal-empty"><div class="spinner"></div><div>正在并行搜索并检测歌词格式...</div></div>';
            setLyricsFetchStatus('正在连接网易云、QQ 音乐、酷狗与 AMLL…');

            try {
                const result = await app.api.searchMusicLyricsCandidates({
                    title,
                    artist,
                    album: track.album || '',
                    durationMs: Math.round((track.duration || 0) * 1000)
                });
                if (requestToken !== app.lyricsFetchRequestToken) return;
                app.lyricsFetchCandidates = result?.candidates || [];
                renderLyricsCandidates();
                setLyricsFetchStatus(
                    result?.success
                        ? `找到 ${app.lyricsFetchCandidates.length} 个可用版本`
                        : errText(result?.message, '歌词搜索失败'),
                    result?.success ? 'success' : 'error'
                );
            } catch (error) {
                if (requestToken !== app.lyricsFetchRequestToken) return;
                app.lyricsFetchCandidates = [];
                renderLyricsCandidates();
                setLyricsFetchStatus(errText(error, '歌词搜索失败'), 'error');
            } finally {
                if (requestToken === app.lyricsFetchRequestToken) {
                    app.lyricsFetchSearchBtn.disabled = false;
                }
            }
        };

        app.openLyricsFetchModal = (trackIndex) => {
            const track = app.playlist[trackIndex];
            if (!track) return;
            app.lyricsFetchRequestToken++;
            app.lyricsFetchTrackIndex = trackIndex;
            app.lyricsFetchCandidates = [];
            app.selectedLyricsCandidateKey = null;
            app.lyricsFetchTitle.value = app.stripAudioExtension(track.title) || '';
            app.lyricsFetchArtist.value = track.artist || '';
            app.lyricsFetchTrack.textContent = `${app.stripAudioExtension(track.title) || '未知歌曲'} · ${track.artist || '未知艺术家'}`;
            app.lyricsFetchResults.innerHTML = '<div class="music-modal-empty">点「搜索多个源」查找可用的歌词版本</div>';
            app.lyricsFetchSelection.textContent = '尚未选择歌词版本';
            app.lyricsFetchApply.disabled = true;
            app.lyricsFetchSearchBtn.disabled = false;
            setLyricsFetchStatus('');
            app.lyricsFetchModal.classList.add('visible');
            app.lyricsFetchTitle.focus({ preventScroll: true });
        };

        app.lyricsFetchSearchBtn.onclick = searchLyricsCandidates;
        app.lyricsFetchClose.onclick = closeLyricsFetchModal;
        // 点击遮罩不关闭；仅允许通过 Esc 或 × 主动关闭窗口。
        // 中文输入法选词时按的回车、Esc 是给输入法的（isComposing），不算确定或关闭。
        app.lyricsFetchTitle.onkeydown = app.lyricsFetchArtist.onkeydown = (event) => {
            if (event.key === 'Enter' && !event.isComposing) searchLyricsCandidates();
        };
        app.lyricsFetchApply.onclick = async () => {
            const track = app.playlist[app.lyricsFetchTrackIndex];
            if (!track || !app.selectedLyricsCandidateKey || !app.api?.applyMusicLyricsCandidate) return;

            const requestToken = app.lyricsFetchRequestToken;
            // 手选版本优先，作废当前曲目仍在进行的自动获取。
            if (app.pendingTrackPath === track.path) app.lyricsRequestToken++;
            app.lyricsFetchApply.disabled = true;
            app.lyricsFetchSearchBtn.disabled = true;
            setLyricsFetchStatus('正在覆盖当前歌词文件…');
            try {
                const result = await app.api.applyMusicLyricsCandidate({
                    candidateKey: app.selectedLyricsCandidateKey,
                    title: track.title,
                    artist: track.artist || ''
                });
                if (requestToken !== app.lyricsFetchRequestToken) return;
                if (!result?.success) {
                    setLyricsFetchStatus(errText(result?.message, '覆盖歌词失败'), 'error');
                    app.lyricsFetchApply.disabled = false;
                    return;
                }

                setLyricsFetchStatus('歌词已覆盖并立即生效', 'success');
                if (app.pendingTrackPath === track.path) {
                    app.currentLyricsData = result.lyrics;
                    app.currentLyrics = app.normalizeStructuredLyrics(result.lyrics);
                    app.currentLyricIndex = -1;
                    app.renderLyrics();
                }
                // 获取成功后保留窗口及结果，由用户主动关闭。
            } catch (error) {
                if (requestToken !== app.lyricsFetchRequestToken) return;
                setLyricsFetchStatus(errText(error, '覆盖歌词失败'), 'error');
                app.lyricsFetchApply.disabled = false;
            } finally {
                if (requestToken === app.lyricsFetchRequestToken) app.lyricsFetchSearchBtn.disabled = false;
            }
        };

        app.playPauseBtn.onclick = () => app.toggleTransport();
        app.prevBtn.onclick = () => app.prevTrack();
        app.nextBtn.onclick = () => app.nextTrack();
        app.modeBtn.onclick = () => {
            app.setPlayMode(app.currentPlayMode + 1);
        };

        app.volumeSlider.oninput = (e) => {
            const val = parseFloat(e.target.value);
            app.updateVolumeSliderBackground(val);
            if (app.api?.setMusicVolume) {
                if (app.sendLatest) app.sendLatest('volume', () => app.api.setMusicVolume(val));
                else app.api.setMusicVolume(val);
            }
            if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
            app.saveSettings();
        };

        let dragRect = null;
        let dragEndTimer = 0;
        app.handleProgressUpdate = async (e, shouldSeek = false, knownRect = null) => {
            const rect = knownRect || app.progressContainer.getBoundingClientRect();
            const offsetX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
            const width = rect.width;

            if (app.lastKnownDuration > 0 && width > 0) {
                const newTime = (offsetX / width) * app.lastKnownDuration;
                // Update UI immediately
                app.progress.style.width = `${(newTime / app.lastKnownDuration) * 100}%`;
                app.currentTimeEl.textContent = app.formatTime(newTime);

                if (shouldSeek) await app.seekTo(newTime);
            }
        };

        const onProgressMove = (e) => {
            if (app.dragInProgress) app.handleProgressUpdate(e, false, dragRect);
        };
        const detachProgressDrag = () => {
            window.removeEventListener('mousemove', onProgressMove);
            window.removeEventListener('mouseup', onProgressUp);
            dragRect = null;
        };
        const onProgressUp = (e) => {
            const rect = dragRect;
            detachProgressDrag();
            if (app.dragInProgress) {
                app.handleProgressUpdate(e, true, rect);
                if (dragEndTimer) clearTimeout(dragEndTimer);
                dragEndTimer = setTimeout(() => { dragEndTimer = 0; app.dragInProgress = false; }, 0);
            }
        };
        listenerDisposers.push(() => {
            detachProgressDrag();
            if (dragEndTimer) { clearTimeout(dragEndTimer); dragEndTimer = 0; }
        });

        app.progressContainer.onmousedown = (e) => {
            app.dragInProgress = true;
            app.stopStatePolling();
            dragRect = app.progressContainer.getBoundingClientRect();
            window.addEventListener('mousemove', onProgressMove);
            window.addEventListener('mouseup', onProgressUp);
            app.handleProgressUpdate(e, false, dragRect);
        };

        app.progressBar.onclick = (e) => {
            if (!app.dragInProgress) app.handleProgressUpdate(e, true);
        };


        app.addFolderBtn.onclick = () => app.api?.addMusicFolder?.();
        app.shareBtn.onclick = () => app.shareCurrentTrack();

        app.deviceSelect.onchange = () => app.configureOutput();
        app.wasapiSwitch.onchange = () => { if (!app.wasapiSwitch._programmaticUpdate) app.configureOutput(); };
        app.eqSwitch.onchange = () => {
            app.updateEqSectionState();
            if (!app.eqSwitch._programmaticUpdate) app.sendEqSettings();
        };
        app.eqTypeSelect.onchange = () => {
            app.firTapsSelect.style.display = app.eqTypeSelect.value === 'FIR' ? 'block' : 'none';
            app.sendEqSettings();
        };
        app.firTapsSelect.onchange = () => app.sendEqSettings();
        app.eqPresetSelect.onchange = (e) => app.applyEqPreset(e.target.value);
        app.ditherSwitch.onchange = () => { app.syncDitherSection(); app.updateOptimizations(); };
        app.replaygainSwitch.onchange = () => {
            if (app.replaygainSwitch._programmaticUpdate) return;
            app.loudnessModeSelect.value = app.replaygainSwitch.checked ? 'replaygain_track' : 'track';
            // 只换模式不开归一化，开关亮了却什么都不变。
            if (app.replaygainSwitch.checked) app.loudnessSwitch.checked = true;
            app.updateLoudnessSettings();
        };
        app.upsamplingSelect.onchange = () => app.configureUpsampling();
        app.resampleQualitySelect.onchange = () => app.configureResampling();
        app.resampleCacheSwitch.onchange = () => app.configureResampling();
        app.preemptiveResampleSwitch.onchange = () => app.configureResampling();

        app.irSwitch.onchange = () => {
            if (app.irSwitch.checked) { if (app.irLoadedPath) app.loadIrFile(app.irLoadedPath); else app.irLoadBtn.click(); }
            else app.unloadIr();
        };
        app.irPresetSelect.onchange = async (e) => {
            const val = e.target.value;
            if (val === 'custom') { 
                app.irLoadBtn.style.display = 'block'; 
                app.irLoadBtn.click(); 
            } else if (val === '') {
                app.irLoadBtn.style.display = 'none';
                app.unloadIr();
            } else {
                app.irLoadBtn.style.display = 'none';
                try {
                    const filePath = await app.api.getMusicIrPresetPath(val);
                    if (filePath) app.loadIrFile(filePath);
                    else app.updateIrStatus('预设文件未找到', 'error');
                } catch (err) {
                    console.error('[Music] Failed to load IR preset:', err);
                    app.updateIrStatus('加载预设失败', 'error');
                }
            }
        };

        app.loadAvailableIrPresets = async () => {
            try {
                const presets = await app.api.listMusicIrPresets();
                if (presets && presets.length > 0) {
                    const select = app.irPresetSelect;
                    if (!select || select.options.length < 2) return;
                    // 保留第一个和最后一个选项
                    const customOption = select.options[select.options.length - 1];
                    const defaultOption = select.options[0];
                    const frag = document.createDocumentFragment();
                    frag.appendChild(defaultOption);
                    presets.forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p;
                        opt.textContent = p;
                        frag.appendChild(opt);
                    });
                    frag.appendChild(customOption);
                    select.innerHTML = '';
                    select.appendChild(frag);
                }
            } catch (err) {
                console.error('[Music] Failed to update IR presets list:', err);
            }
        };
        app.loadAvailableIrPresets();
        app.irLoadBtn.onclick = () => app.pickIrFile();

        // --- IR Help Tip Logic ---
        const irHelpIcon = document.getElementById('ir-help-icon');
        const irHelpTip = document.getElementById('ir-help-tip');
        const irAutoEqLink = document.getElementById('ir-autoeq-link');

        if (irHelpIcon && irHelpTip) {
            irHelpIcon.onclick = (e) => {
                e.stopPropagation();
                const isHidden = irHelpTip.style.display === 'none';
                irHelpTip.style.display = isHidden ? 'block' : 'none';
            };
            
            if (irAutoEqLink) {
                irAutoEqLink.onclick = (e) => {
                    e.preventDefault();
                    if (app.api?.sendOpenExternalLink) {
                        app.api.sendOpenExternalLink('https://autoeq.app/');
                    }
                };
            }

            // 点击外部关闭提示
            addManagedListener(document, 'click', (e) => {
                if (irHelpTip.style.display === 'block' && !irHelpTip.contains(e.target) && e.target !== irHelpIcon) {
                    irHelpTip.style.display = 'none';
                }
            });
        }

        app.loudnessSwitch.onchange = () => app.updateLoudnessSettings();
        app.loudnessModeSelect.onchange = () => app.updateLoudnessSettings();
        app.loudnessLufsSlider.oninput = () => { app.updateLoudnessLufsDisplay(); app.updateLoudnessSettings(); };
        app.loudnessPreampSlider.oninput = () => { app.updateLoudnessPreampDisplay(); app.updateLoudnessSettings(); };

        app.saturationSwitch.onchange = () => app.updateSaturationSettings();
        app.saturationTypeSelect.onchange = () => app.updateSaturationSettings();
        app.saturationDriveSlider.oninput = () => { app.updateSaturationDriveDisplay(); app.updateSaturationSettings(); };
        app.saturationMixSlider.oninput = () => { app.updateSaturationMixDisplay(); app.updateSaturationSettings(); };

        app.crossfeedSwitch.onchange = () => app.updateCrossfeedSettings();
        app.crossfeedMixSlider.oninput = () => { app.updateCrossfeedMixDisplay(); app.updateCrossfeedSettings(); };

        app.dynamicLoudnessSwitch.onchange = () => app.updateDynamicLoudnessSettings();
        app.dynamicLoudnessStrengthSlider.oninput = () => { app.updateDynamicLoudnessStrengthDisplay(); app.updateDynamicLoudnessSettings(); };

        app.outputBitsSelect.onchange = () => app.updateNoiseShaperSettings();
        app.noiseShaperCurveSelect.onchange = () => app.updateNoiseShaperSettings();

        const sidebarScrollHost = app.leftSidebar || document.body;
        const markSidebarScrolling = () => {
            if (!app.isSidebarScrolling) {
                app.isSidebarScrolling = true;
                sidebarScrollHost.classList.add('sidebar-is-scrolling');
            }
            if (app.sidebarScrollEndTimer) clearTimeout(app.sidebarScrollEndTimer);
            app.sidebarScrollEndTimer = setTimeout(() => {
                app.sidebarScrollEndTimer = null;
                app.isSidebarScrolling = false;
                sidebarScrollHost.classList.remove('sidebar-is-scrolling');
            }, 140);
        };
        addManagedListener(app.playlistEl, 'scroll', markSidebarScrolling, { passive: true });

        // 经典列表当前显示的顺序（可能按标题、歌手等排过序）。
        app.classicOrder = () => {
            // 档案页开着时经典列表还没重画，按它待画的那组歌算
            if (app.classicPendingSongs) {
                if (app.classicPendingSongs === app.playlist) return app.playlist.slice();
                const inLib = new Set(app.playlist);
                return app.classicPendingSongs.filter(t => inLib.has(t));
            }
            // 列表只建了看得见的那些行，顺序按它要显示的整组歌算
            const shown = app.classicShownSongs?.();
            if (Array.isArray(shown)) {
                if (shown === app.playlist) return app.playlist.slice();
                const inLib = new Set(app.playlist);
                return shown.filter(t => inLib.has(t));
            }
            return Array.from(app.playlistEl.children, li => app.playlist[Number(li.dataset.index)]).filter(Boolean);
        };
        app.playlistEl.addEventListener('click', (e) => {
            const li = e.target?.closest?.('li');
            if (!li || !app.playlistEl.contains(li)) return;
            const index = parseInt(li.dataset.index, 10);
            // 从经典列表点播：上下文就是看到的这一组、按看到的顺序。
            if (typeof app.playFromContext === 'function') {
                app.playFromContext(app.classicOrder(), index, { source: app.filteredPlaylistSource, origin: 'classic', render: false });
            } else app.loadTrack(index);
        });
        app.playlistEl.addEventListener('contextmenu', (e) => {
            const li = e.target?.closest?.('li');
            if (li && app.playlistEl.contains(li)) {
                e.preventDefault(); app.contextMenuTrackIndex = parseInt(li.dataset.index, 10);
                app.showContextMenu(e.clientX, e.clientY);
            }
        });

        app.sidebarTabs.forEach(tab => tab.onclick = () => {
            app.sidebarTabs.forEach(t => t.classList.remove('active')); tab.classList.add('active');
            app.renderSidebarContent(tab.dataset.view);
        });

        app.createPlaylistBtn.onclick = () => app.showPlaylistDialog((name) => {
            const id = Date.now().toString(); app.customPlaylists.push({ id, name, tracks: [] });
            app.saveCustomPlaylists(); app.renderSidebarContent('playlists');
            try { app.archiveView?.refresh?.(); } catch (_) {}
        });
        app.dialogCancel.onclick = () => app.hidePlaylistDialog();
        app.dialogConfirm.onclick = () => {
            const name = app.playlistNameInput.value.trim();
            if (name && app.pendingAddToPlaylist) { app.pendingAddToPlaylist(name); app.hidePlaylistDialog(); }
        };
        app.playlistNameInput.onkeydown = (e) => {
            if (e.isComposing) return; // 输入法还在选词：回车是把拼音上屏，不是确定
            if (e.key === 'Enter') app.dialogConfirm.click();
            if (e.key === 'Escape') app.dialogCancel.click();
        };

        const closePlaylistEditModal = () => {
            if (modalSearchTimer) { clearTimeout(modalSearchTimer); modalSearchTimer = null; }
            const modal = app.playlistEditModal;
            const ret = modal?._returnFocus;
            if (modal) modal._returnFocus = null;
            if (ret && ret !== document.body && ret.isConnected && !modal.contains(ret) && !ret.closest?.('[inert], [hidden]')) ret.focus?.({ preventScroll: true });
            else if (modal?.contains(document.activeElement)) document.activeElement?.blur?.();
            modal.classList.remove('visible');
            if (app.currentSidebarView === 'playlists') app.renderSidebarContent('playlists');
        };
        app.modalCloseBtn.onclick = app.modalDoneBtn.onclick = closePlaylistEditModal;
        app.modalSearchInput.oninput = (e) => {
            const nextQuery = e.target.value;
            app.modalSearchQuery = nextQuery;
            if (modalSearchTimer) { clearTimeout(modalSearchTimer); modalSearchTimer = null; }
            if (!nextQuery.trim()) { app.renderModalSongList(); return; }
            modalSearchTimer = setTimeout(() => {
                modalSearchTimer = null;
                if (app.playlistEditModal?.classList.contains('visible')) app.renderModalSongList();
            }, 120);
        };

        addManagedListener(document, 'click', (e) => {
            const t = e.target;
            if (!(t && typeof t.nodeType === 'number' && app.contextMenu.contains(t))) app.contextMenu.classList.remove('visible');
        });
        addManagedListener(document, 'keydown', (e) => {
            if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
            if (document.querySelector('.dialog-overlay.music-dialog.visible:not([data-closing])')) return;
            if (app.playlistDialog?.classList.contains('visible')) { app.hidePlaylistDialog(); e.preventDefault(); return; }
            if (app.playlistEditModal?.classList.contains('visible')) { closePlaylistEditModal(); e.preventDefault(); return; }
            if (app.lyricsFetchModal?.classList.contains('visible')) { closeLyricsFetchModal(); e.preventDefault(); }
        });
        // ── 右键菜单的作用范围 ──
        // 「从列表中移除」要按右键时所在的视图决定删哪里，而不是按上一次从哪里点播。
        // 经典列表记下它此刻显示的是哪一组；档案页由档案视图告诉我们选中的是哪一列。
        const appHooks = (globalThis.MusicAppHooks || require('./music-app-hooks.js'));
        app.playlistViewSource = null;
        appHooks.wrap(app, 'renderPlaylist', 'menu-scope', (renderPlaylistBase) => (filtered) => {
            let source = filtered ? (app.filteredPlaylistSource || { type: 'filter' }) : null;
            if (source?.type === 'playlist') {
                // 语义搜索等别的入口不会清掉旧的歌单来源：显示的歌不全在这个歌单里，就不算歌单视图。
                const pl = app.customPlaylists.find(p => p.id === source.id);
                let allIn = Boolean(pl);
                if (allIn) {
                    const paths = new Set(pl.tracks);
                    for (let i = 0; i < filtered.length; i += 1) {
                        if (!paths.has(filtered[i].path)) { allIn = false; break; }
                    }
                }
                if (!allIn) source = { type: 'filter' };
            }
            app.playlistViewSource = source;
            const result = renderPlaylistBase(filtered);
            // 正在放的上下文是从经典列表点出来的：列表换了排序（同一组歌），队列跟着换顺序。
            if (app.contextFrom?.('classic') && app.classicOrder) app.reorderContext(app.classicOrder(), 'classic');
            return result;
        });
        const onScopeDoc = typeof addManagedListener === 'function'
            ? (type, handler, opts) => addManagedListener(document, type, handler, opts)
            : (type, handler, opts) => document.addEventListener(type, handler, opts);
        let pendingMenuSurface = null;
        onScopeDoc('contextmenu', (e) => {
            pendingMenuSurface = e.target?.closest?.('#playlist') ? 'classic'
                : e.target?.closest?.('#music-archive-view') ? 'archive' : null;
        }, true);
        onScopeDoc('click', (e) => {
            if (e.target?.closest?.('#music-archive-view [data-act="save"]')) pendingMenuSurface = 'archive';
        }, true);
        const archiveMenuScope = () => {
            if (app.contextMenuScopeHint !== undefined) { const hint = app.contextMenuScopeHint; app.contextMenuScopeHint = undefined; return hint; }
            try {
                const d = app.archiveView?.debug?.();
                const n = d?.columns?.length || 0;
                const id = n ? d.columns[((d.lane % n) + n) % n].id : '';
                if (id.startsWith('playlist:')) {
                    const plId = id.slice('playlist:'.length);
                    const pl = app.customPlaylists.find(p => String(p.id) === plId);
                    if (pl) return { type: 'playlist', id: pl.id, name: pl.name };
                }
            } catch (err) { /* 拿不到就按曲库处理，曲库移除会先确认 */ }
            return null;
        };
        appHooks.wrap(app, 'showContextMenu', 'menu-scope', (showContextMenuBase) => (x, y) => {
            const surface = pendingMenuSurface;
            pendingMenuSurface = null;
            app.contextMenuScope = surface === 'classic' ? app.playlistViewSource
                : surface === 'archive' ? archiveMenuScope() : null;
            return showContextMenuBase(x, y);
        });
        const notify = (message, action) => {
            try { window.MusicToast?.show?.({ message, action }); } catch (err) { /* 提示层不在时只是没有撤销 */ }
        };
        const removeFromPlaylist = (scope, track) => {
            const pl = app.customPlaylists.find(p => p.id === scope.id);
            if (!pl) return;
            const at = pl.tracks.indexOf(track.path);
            if (at < 0) return;
            pl.tracks.splice(at, 1);
            const refresh = () => {
                app.saveCustomPlaylists();
                if (app.playlistViewSource?.type === 'playlist' && app.playlistViewSource.id === pl.id) {
                    const byPath = new Map();
                    for (const tr of app.playlist) if (tr && tr.path && !byPath.has(tr.path)) byPath.set(tr.path, tr);
                    app.currentFilteredTracks = pl.tracks.map(p => byPath.get(p)).filter(Boolean);
                    app.renderPlaylist(app.currentFilteredTracks);
                }
                app.archiveView?.refresh?.();
                app.refreshPreload?.();
            };
            refresh();
            notify(`已从歌单「${pl.name}」移除`, { label: '撤销', run: () => { if (!pl.tracks.includes(track.path)) { pl.tracks.splice(Math.min(at, pl.tracks.length), 0, track.path); refresh(); } } });
        };
        const removeFromLibrary = async (index) => {
            const track = app.playlist[index];
            if (!track) return;
            const name = app.stripAudioExtension ? app.stripAudioExtension(track.title || '') : (track.title || '');
            const ask = { title: `从曲库移除「${name}」？`, message: '只是不再显示在播放器里，磁盘上的文件不会删除。', confirmText: '移除', danger: true };
            const ok = window.MusicDialog ? await window.MusicDialog.confirm(ask) : confirm(`${ask.title}\n${ask.message}`);
            // 确认框开着时列表可能已经变了（扫描、别处删除）：按对象重新找位置。
            if (!ok) return;
            index = app.playlist.indexOf(track);
            if (index < 0) return;
            const wasCurrent = app.currentTrackIndex === index;
            // 删的正是在放的这首：先按当前列表记下它后面那首，删完直接接上（不跳过一首）。
            const active = app.currentFilteredTracks || app.playlist;
            const pos = active.indexOf(track);
            const follower = wasCurrent && active.length > 1 ? active[(pos + 1) % active.length] : null;
            const wasPlaying = Boolean(app.isPlaying || app.playIntent);
            app.playlist.splice(index, 1);
            if (Array.isArray(app.currentFilteredTracks)) app.currentFilteredTracks = app.currentFilteredTracks.filter(t => t !== track);
            if (!wasCurrent && app.currentTrackIndex > index) app.currentTrackIndex--;
            const view = app.playlistViewSource;
            if (view && Array.isArray(app.currentFilteredTracks)) app.renderPlaylist(app.currentFilteredTracks);
            else app.renderPlaylist();
            if (wasCurrent) {
                const next = follower && follower !== track ? app.playlist.indexOf(follower) : -1;
                if (next >= 0) app.loadTrack(next, wasPlaying);
                else { app.pauseTrack?.(); app.currentTrackIndex = Math.min(index, app.playlist.length - 1); }
            }
            app.saveLibrary();
            app.archiveView?.refresh?.();
            if (!wasCurrent) app.refreshPreload?.();
            notify(`已从曲库列表移除「${name}」`, { label: '撤销', run: () => {
                if (app.playlist.includes(track)) return;
                const at = Math.min(index, app.playlist.length);
                app.playlist.splice(at, 0, track);
                if (app.currentTrackIndex >= at) app.currentTrackIndex++;
                if (Array.isArray(app.currentFilteredTracks) && view && pos >= 0 && !app.currentFilteredTracks.includes(track)) {
                    const list = app.currentFilteredTracks.slice();
                    list.splice(Math.min(pos, list.length), 0, track);
                    app.currentFilteredTracks = list;
                }
                if (app.currentFilteredTracks && view) app.renderPlaylist(app.currentFilteredTracks); else app.renderPlaylist();
                app.saveLibrary();
                app.archiveView?.refresh?.();
                app.refreshPreload?.();
            } });
        };
        app.removeTrackInScope = (index, scope = app.contextMenuScope) => {
            const track = app.playlist[index];
            if (!track) return;
            if (scope?.type === 'playlist') removeFromPlaylist(scope, track);
            else removeFromLibrary(index);
        };

        app.contextMenu.querySelectorAll('.context-menu-item').forEach(item => {
            item.onclick = (e) => {
                const action = item.dataset.action; if (!action || action === 'add-to-playlist') return;
                if (action === 'play') app.loadTrack(app.contextMenuTrackIndex);
                else if (action === 'get-lyrics') app.openLyricsFetchModal(app.contextMenuTrackIndex);
                else if (action === 'play-next' || action === 'add-to-queue') {
                    // 进播放器的手动队列；引擎的预载槽由队列自己去填，不在这里直接写。
                    const t = app.playlist[app.contextMenuTrackIndex];
                    const next = action === 'play-next';
                    const before = app.queueSnapshot?.() || [];
                    const queued = next ? app.queuePlayNext?.(t) : app.queueAdd?.(t);
                    if (queued) {
                        const name = app.stripAudioExtension ? app.stripAudioExtension(queued.title || '') : (queued.title || '');
                        try {
                            window.MusicToast?.show({ id: 'queue', kind: 'success', message: `${next ? '下一首播放' : '已加入队列'}：${name}`,
                                action: { label: '撤销', run: () => app.queueRevert([queued], before) } });
                        } catch (err) { /* 没有提示层也不影响入队 */ }
                    }
                } else if (action === 'create-playlist-add') {
                    const track = app.playlist[app.contextMenuTrackIndex];
                    if (track?.path) {
                        app.showPlaylistDialog((name) => {
                            const id = Date.now().toString();
                            app.customPlaylists.push({ id, name, tracks: [track.path] });
                            app.saveCustomPlaylists();
                            if (app.currentSidebarView === 'playlists') app.renderSidebarContent('playlists');
                            try { app.archiveView?.refresh?.(); } catch (_) {}
                        });
                    }
                } else if (action === 'remove-from-list') {
                    app.removeTrackInScope(app.contextMenuTrackIndex);
                }
                app.contextMenu.classList.remove('visible');
            };
        });

        app.searchInput.oninput = (e) => {
            if (app.isSemanticSearchActive) {
                // 语义搜索模式下不随输入过滤；但把框清空就回到整个曲库，不然还停在上一次的语义结果上。
                if (!app.searchInput.value.trim() && app.currentFilteredTracks) {
                    app.currentFilteredTracks = null; app.filteredPlaylistSource = null;
                    app.renderPlaylist(null);
                }
                return;
            }
            // 连续输入时只在停顿后过滤一次，避免每敲一个字就重建整个列表。
            clearTimeout(app.searchInputTimer);
            app.searchInputTimer = setTimeout(() => {
                if (app.isSemanticSearchActive) return;
                const query = app.searchInput.value.trim();
                app.currentFilteredTracks = query ? app.searchTracks(app.playlist, query) : null; app.filteredPlaylistSource = null; // 搜索结果是整个曲库里搜的，不再算某个歌单
                app.renderPlaylist(app.currentFilteredTracks);
            }, 120);
        };

        app.searchInput.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.isComposing && app.isSemanticSearchActive) {
                const query = app.searchInput.value.trim();
                if (query) app.performSemanticSearch(query);
            }
        };

        app.semanticSearchBtn.onclick = () => {
            app.isSemanticSearchActive = !app.isSemanticSearchActive;
            app.semanticSearchBtn.classList.toggle('active', app.isSemanticSearchActive);
            app.searchInput.placeholder = app.isSemanticSearchActive ? "描述想听的歌，按语义搜索" : "搜索歌曲";
            
            if (!app.isSemanticSearchActive) {
                // 退出语义搜索时恢复普通搜索
                const query = app.searchInput.value.trim();
                app.currentFilteredTracks = query ? app.searchTracks(app.playlist, query) : null; app.filteredPlaylistSource = null; // 搜索结果是整个曲库里搜的，不再算某个歌单
                app.renderPlaylist(app.currentFilteredTracks);
            }
        };

        app.minimizeBtn.onclick = () => { app.api?.minimizeWindow?.(); };
        app.maximizeBtn.onclick = () => { app.api?.maximizeWindow?.(); };
        app.closeBtn.onclick = () => { app.api?.closeWindow?.(); };


        addManagedListener(window, 'resize', () => {
            if (document.body.classList.contains('music-archive-on') || !app.visualizerCanvas) return;
            const w = app.visualizerCanvas.clientWidth;
            const h = app.visualizerCanvas.clientHeight;
            if (w > 0 && h > 0 && (app.visualizerCanvas.width !== w || app.visualizerCanvas.height !== h)) {
                app.visualizerCanvas.width = w;
                app.visualizerCanvas.height = h;
                app.recreateParticles();
            }
        });
        return () => {
            while (listenerDisposers.length) {
                const dispose = listenerDisposers.pop();
                try { dispose(); } catch (_) {}
            }
        };
    };

    const setupElectronHandlers = () => {
        if (!app.api?.onMusicScanStart) return null;
        const disposers = [];
        const trackIpc = (unsub) => { if (typeof unsub === 'function') disposers.push(unsub); };
        // 同时在扫几个文件夹（连着拖进来、或扫描途中又加了一个）：先扫完的那个不能把「正在扫描」藏掉。
        let activeScans = 0;
        let lastScanPct = '';
        let lastScanLabel = '';
        trackIpc(app.api.onMusicScanStart(() => { activeScans += 1; lastScanPct = ''; lastScanLabel = ''; app.loadingIndicator.style.display = 'flex'; app.scanProgressContainer.style.display = 'none'; }));
        trackIpc(app.api.onMusicScanProgress((data) => {
            if (app.scanProgressContainer.style.display !== 'block') app.scanProgressContainer.style.display = 'block';
            const percent = data.total > 0 ? Math.min(100, (data.current / data.total) * 100) : 0;
            const pctStr = `${percent.toFixed(1)}%`;
            if (pctStr !== lastScanPct) { lastScanPct = pctStr; app.scanProgressBar.style.width = pctStr; }
            const label = `正在扫描: ${data.current} / ${data.total}`;
            if (label !== lastScanLabel) { lastScanLabel = label; app.scanProgressLabel.textContent = label; }
        }));
        // 扫描途中节流追加曲目（400ms 重排一次），结束时在 complete 里恢复磁盘顺序并存盘
        let scanBatchTimer = 0, scanKnownPaths = null, scanAddedPaths = null;
        disposers.push(() => { if (scanBatchTimer) { clearTimeout(scanBatchTimer); scanBatchTimer = 0; } });
        const flushScanBatches = () => { scanBatchTimer = 0; app.renderPlaylist(); app.renderSidebarContent(app.currentSidebarView); };
        trackIpc(app.api.onMusicScanBatch?.((data) => {
            const inc = data && Array.isArray(data.tracks) ? data.tracks : [];
            if (!scanKnownPaths) {
                scanKnownPaths = new Set();
                for (let i = 0; i < app.playlist.length; i++) scanKnownPaths.add(app.playlist[i].path);
            }
            const fresh = [];
            for (let i = 0; i < inc.length; i++) {
                const t = inc[i];
                if (t && t.path && !scanKnownPaths.has(t.path)) {
                    scanKnownPaths.add(t.path);
                    (scanAddedPaths || (scanAddedPaths = new Set())).add(t.path);
                    fresh.push(t);
                }
            }
            if (!fresh.length) return;
            app.playlist = app.playlist.concat(fresh);
            if (!scanBatchTimer) scanBatchTimer = setTimeout(flushScanBatches, 400);
        }));
        trackIpc(app.api.onMusicScanComplete((data) => {
            clearTimeout(scanBatchTimer); scanBatchTimer = 0; scanKnownPaths = null;
            const addedDuringScan = scanAddedPaths;
            const playingPath = app.playlist[app.currentTrackIndex]?.path;
            activeScans = Math.max(0, activeScans - 1);
            if (!activeScans) app.loadingIndicator.style.display = 'none';
            const newPlaylist = Array.isArray(data) ? data : (data.tracks || []);
            const folderPath = Array.isArray(data) ? null : (data.folderPath || null);
            const scannedMap = new Map();
            for (let i = 0; i < newPlaylist.length; i++) scannedMap.set(newPlaylist[i].path, newPlaylist[i]);
            // 仅移除本次扫描目录内已删除文件；扫描失败时保留原曲目
            const folderKey = folderPath && !data.failed
                ? String(app.normalizePathForCompare(folderPath) || '').replace(/\/+$/, '') + '/'
                : null;
            const insideFolder = (p) => Boolean(folderKey) && String(app.normalizePathForCompare(p) || '').startsWith(folderKey);
            const updatedPlaylist = [], handledPaths = new Set(), appended = new Map();
            for (const track of app.playlist) {
                if (addedDuringScan?.has(track.path) && scannedMap.has(track.path)) {
                    appended.set(track.path, track);
                    addedDuringScan.delete(track.path);
                    continue;
                }
                if (scannedMap.has(track.path)) {
                    Object.assign(track, scannedMap.get(track.path));
                    updatedPlaylist.push(track);
                    handledPaths.add(track.path);
                } else if (!insideFolder(track.path)) {
                    updatedPlaylist.push(track);
                }
            }

            // Add brand-new tracks that weren't in the existing playlist
            for (const track of newPlaylist) {
                if (!handledPaths.has(track.path)) {
                    const early = appended.get(track.path);
                    updatedPlaylist.push(early ? Object.assign(early, track) : track);
                }
            }

            if (scanAddedPaths && !scanAddedPaths.size) scanAddedPaths = null;
            app.playlist = updatedPlaylist;
            if (playingPath) {
                const at = updatedPlaylist.findIndex(t => t.path === playingPath);
                if (at !== -1) app.currentTrackIndex = at;
            }
            app.renderPlaylist(); app.renderSidebarContent(app.currentSidebarView);
            app.saveLibrary();
        }));
        if (app.api?.onThemeUpdated) {
            trackIpc(app.api.onThemeUpdated((theme) => app.applyTheme(theme)));
        }
        trackIpc(app.api.onMusicControl((command) => {
            console.log('[Music] Received music-control command:', command);
            if (command === 'play') app.playTrack();
            else if (command === 'pause') app.pauseTrack();
            else if (command === 'next') app.nextTrack();
            else if (command === 'previous') app.prevTrack();
        }));

        // --- 处理从主进程发来的 "点歌" 命令 ---
        // 新协议传递 { track, stageMode }；共享消费函数仍兼容旧的纯 track 格式。
        trackIpc(app.api.onMusicSetTrack((playbackRequest) => {
            const track = playbackRequest?.track || playbackRequest;
            console.log(
                '[Music] Received music-set-track:',
                track?.title,
                track?.path,
                playbackRequest?.stageMode || 'regular'
            );
            void app.playRequestedTrack(playbackRequest);
        }));
        return () => {
            while (disposers.length) {
                const dispose = disposers.pop();
                try { dispose(); } catch (_) {}
            }
        };
    };

    // 换歌时清掉上一首的进度样本，免得新歌第一次状态被当成「在往前走」。
    app.resetEngineProgress = () => { app.lastEngineProgress = null; };
    app.updateUIWithState = (state, options = {}) => {
        if (!state) return;
        app.syncOutputFallback?.(state);
        // 切歌加载期间引擎报的还是上一首（或已停止）的状态，写进界面会让进度条和按钮乱跳。
        if (app.isTrackLoading && !options.force) return;
        // 引擎重启过（主进程会自动拉起）：里面已经没有歌了。记下来，再按播放就重新加载这首，
        // 而不是对着空引擎发「播放」、一直报播放失败。
        if ('file_path' in state && !state.file_path && !state.is_loading && app.engineTrackPath) app.engineTrackPath = null;
        app.lastKnownCurrentTime = state.current_time; app.lastKnownDuration = state.duration;
        app.lastStateUpdateTime = Date.now();
        app.syncMediaPosition?.();
        const uic = app.updateUIWithState._c || (app.updateUIWithState._c = { w: '', cur: '', dur: '', lufsOn: false, lufs: '', dyn: '', dynOn: false });
        if (!app.lastEngineProgress) { uic.w = ''; uic.cur = ''; uic.dur = ''; }
        if (app.dragInProgress) {
            uic.w = ''; uic.cur = '';
        } else if (state.duration > 0) {
            const widthStr = `${((state.current_time / state.duration) * 100).toFixed(2)}%`;
            if (widthStr !== uic.w) { uic.w = widthStr; app.progress.style.width = widthStr; }
            const curText = app.formatTime(state.current_time);
            if (curText !== uic.cur) { uic.cur = curText; app.currentTimeEl.textContent = curText; }
            const durText = app.formatTime(state.duration);
            if (durText !== uic.dur) { uic.dur = durText; app.durationEl.textContent = durText; }
        }
        // 引擎的 is_playing 只在输出流建好之后才为真：刚发出播放、或者引擎重建输出流的那段时间，
        // 它会报“未播放”，可声音其实马上就来（或者一直在响）。所以“在不在播”要结合进度看：
        // 没有明确报告已暂停、且进度确实在往前走，就算在播。
        const nowMs = Date.now();
        const prev = app.lastEngineProgress;
        app.lastEngineProgress = { time: state.current_time, at: nowMs };
        let advancing = false;
        if (prev && nowMs - prev.at < 3000) {
            const moved = state.current_time - prev.time;
            // 跳转造成的大幅位移不算“在播”
            advancing = moved > 0.02 && moved < (nowMs - prev.at) / 1000 + 1;
        }
        // 引擎推送的状态带指令序号确认过（options.confirmed），不需要靠进度推断，也不需要防抖。
        const enginePlaying = options.confirmed
            ? state.is_playing === true
            : state.is_playing === true || (state.is_paused !== true && advancing);
        if (enginePlaying === app.isPlaying) {
            app.stateMismatchPolls = 0;
            if (enginePlaying === app.expectedPlayingState) app.isChangingState = false;
        } else if (options.confirmed) {
            app.stateMismatchPolls = 0;
            app.isChangingState = false;
            app.playIntent = enginePlaying;
            app.applyPlayingUi(enginePlaying);
            if (app.isPlaying) app.startStatePolling(); else app.stopStatePolling();
        } else if (options.force) {
            app.stateMismatchPolls = 0;
            // 刚加载好的曲目一定是停止状态；用户想播放时由 loadTrack 接着发播放指令，这里不改按钮。
            if (!app.playIntent) {
                app.playIntent = enginePlaying;
                app.applyPlayingUi(enginePlaying);
                if (app.isPlaying) app.startStatePolling(); else app.stopStatePolling();
            }
        } else {
            // 刚发过指令：给引擎留出执行时间（建输出流可能要几秒），期间不拿旧状态去翻按钮。
            const grace = app.expectedPlayingState ? 5000 : 1500;
            const waitingForCommand = app.isChangingState && nowMs - (app.lastCommandTime || 0) < grace;
            // 平时也要连续两次查询都不一致才认为状态真的变了。
            if (!waitingForCommand && (app.stateMismatchPolls = (app.stateMismatchPolls || 0) + 1) >= 2) {
                app.stateMismatchPolls = 0;
                app.isChangingState = false;
                app.playIntent = enginePlaying;
                app.applyPlayingUi(enginePlaying);
                if (app.isPlaying) app.startStatePolling(); else app.stopStatePolling();
            }
        }
        if (!app.isTrackLoading) app.publishCapsuleState?.();
        if (state.loudness_info) {
            if (!uic.lufsOn) { uic.lufsOn = true; app.loudnessInfo.style.display = 'block'; }
            const lufsText = state.loudness_info.current_lufs.toFixed(1);
            if (lufsText !== uic.lufs) { uic.lufs = lufsText; app.loudnessCurrentLufs.textContent = lufsText; }
        }
        if (state.dynamic_loudness_factor !== undefined) {
            const factorText = state.dynamic_loudness_factor.toFixed(2) + 'x';
            if (factorText !== uic.dyn) { uic.dyn = factorText; app.dynamicLoudnessFactor.textContent = factorText; }
            // 引擎报上来之前不显示「补偿：--」这种占位
            if (!uic.dynOn) { uic.dynOn = true; const info = app.dynamicLoudnessFactor.parentElement; if (info?.hidden) info.hidden = false; }
        }
        if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
    };

    const syncInitialSettings = (initialState) => {
        if (!initialState?.state) return;
        const s = initialState.state;
        app.currentDeviceId = s.device_id; app.useWasapiExclusive = s.exclusive_mode;
        app.deviceSelect.value = s.device_id === null ? 'default' : s.device_id;
        app.wasapiSwitch._programmaticUpdate = true; app.wasapiSwitch.checked = s.exclusive_mode;
        Promise.resolve().then(() => app.wasapiSwitch._programmaticUpdate = false);
        app.syncOutputFallback?.(s);
        if (s.eq_enabled !== undefined) {
            app.eqEnabled = s.eq_enabled; app.eqSwitch._programmaticUpdate = true;
            app.eqSwitch.checked = s.eq_enabled;
            app.updateEqSectionState();
            Promise.resolve().then(() => app.eqSwitch._programmaticUpdate = false);
        }
        if (s.eq_type !== undefined) {
            app.eqTypeSelect.value = s.eq_type;
            app.firTapsSelect.style.display = s.eq_type === 'FIR' ? 'block' : 'none';
        }
        if (s.fir_taps !== undefined) app.firTapsSelect.value = String(s.fir_taps);
        // 同步守卫标记：引擎启动已按 settings 应用 EQ，避免首次拖动频段滑块时重发
        app._syncedEqType = app.eqTypeSelect.value;
        app._syncedFirTaps = parseInt(app.firTapsSelect.value, 10) || 1023;
        if (s.dither_enabled !== undefined) {
            app.ditherSwitch._programmaticUpdate = true; app.ditherSwitch.checked = s.dither_enabled;
            app.syncDitherSection();
            Promise.resolve().then(() => app.ditherSwitch._programmaticUpdate = false);
        }
        if (s.output_bits !== undefined) {
            app.outputBits = s.output_bits;
            app.outputBitsSelect.value = String(s.output_bits);
        }
        if (s.noise_shaper_curve !== undefined) {
            app.noiseShaperCurve = s.noise_shaper_curve;
            app.noiseShaperCurveSelect.value = s.noise_shaper_curve;
        }
        const isRg = s.loudness_mode === 'replaygain_track' || s.loudness_mode === 'replaygain_album';
        app.replaygainSwitch._programmaticUpdate = true; app.replaygainSwitch.checked = isRg;
        Promise.resolve().then(() => app.replaygainSwitch._programmaticUpdate = false);
        if (s.eq_bands) {
            for (const [b, g] of Object.entries(s.eq_bands)) {
                const slider = document.getElementById(`eq-${b}`);
                if (slider) slider.value = g; app.eqBands[b] = g;
            }
        }
        if (s.target_samplerate !== undefined) app.targetUpsamplingRate = s.target_samplerate || 0;
        app.upsamplingSelect.value = app.targetUpsamplingRate;
        if (s.resample_quality !== undefined) app.resampleQualitySelect.value = s.resample_quality;
        if (s.use_cache !== undefined) {
            app.resampleCacheSwitch._programmaticUpdate = true; app.resampleCacheSwitch.checked = s.use_cache;
            Promise.resolve().then(() => app.resampleCacheSwitch._programmaticUpdate = false);
        }
        if (s.preemptive_resample !== undefined) {
            app.preemptiveResampleSwitch._programmaticUpdate = true; app.preemptiveResampleSwitch.checked = s.preemptive_resample;
            Promise.resolve().then(() => app.preemptiveResampleSwitch._programmaticUpdate = false);
        }

        // Restore missing effects settings (Structural Fix)
        // 引擎启动时已经按本机设置生效并在 initialState 中返回，这里只回填界面状态，
        // 仅当旧版 loudness_mode 别名被归一时才写回引擎，避免每次打开重复发 4 轮 HTTP 与写盘。
        if (s.loudness_enabled !== undefined) {
            app.loudnessEnabled = s.loudness_enabled;
            app.loudnessSwitch.checked = s.loudness_enabled;
            // 「专辑」和「流媒体」两档已并掉：引擎里专辑就是按专辑标签，流媒体和单曲实测一样。
            app.loudnessMode = normalizeLoudnessMode(s.loudness_mode);
            app.loudnessModeSelect.value = app.loudnessMode;
            app.targetLufs = s.target_lufs;
            app.loudnessLufsSlider.value = s.target_lufs;
            app.loudnessPreampDb = s.preamp_db;
            app.loudnessPreampSlider.value = s.preamp_db;
            app.updateLoudnessLufsDisplay();
            app.updateLoudnessPreampDisplay();
            if (app.loudnessMode !== s.loudness_mode) app.updateLoudnessSettings();
        }
        if (s.saturation_enabled !== undefined) {
            app.saturationEnabled = s.saturation_enabled;
            app.saturationSwitch.checked = s.saturation_enabled;
            app.saturationDrive = s.saturation_drive;
            app.saturationDriveSlider.value = s.saturation_drive * 100;
            app.saturationMix = s.saturation_mix;
            app.saturationMixSlider.value = s.saturation_mix * 100;
            app.updateSaturationDriveDisplay();
            app.updateSaturationMixDisplay();
        }
        if (s.crossfeed_enabled !== undefined) {
            app.crossfeedEnabled = s.crossfeed_enabled;
            app.crossfeedSwitch.checked = s.crossfeed_enabled;
            app.crossfeedMix = s.crossfeed_mix;
            app.crossfeedMixSlider.value = s.crossfeed_mix * 100;
            app.updateCrossfeedMixDisplay();
        }
        if (s.dynamic_loudness_enabled !== undefined) {
            app.dynamicLoudnessEnabled = s.dynamic_loudness_enabled;
            app.dynamicLoudnessSwitch.checked = s.dynamic_loudness_enabled;
            app.dynamicLoudnessStrength = s.dynamic_loudness_strength;
            app.dynamicLoudnessStrengthSlider.value = s.dynamic_loudness_strength * 100;
            app.updateDynamicLoudnessStrengthDisplay();
        }
        // 旧引擎不认识 crossfade_ms：没有这个字段就不显示，免得开关点了没反应
        const crossfadeBlock = document.getElementById('crossfade-section');
        if (crossfadeBlock) crossfadeBlock.style.display = s.crossfade_ms === undefined ? 'none' : '';
        if (s.crossfade_ms !== undefined && app.crossfadeSelect) {
            const ms = String(s.crossfade_ms);
            const opts = app.crossfadeSelect.options;
            let found = false;
            for (let i = 0; i < opts.length; i += 1) if (opts[i].value === ms) { found = true; break; }
            app.crossfadeSelect.value = found ? ms : '0';
        }
    };

    app.setPlayMode = (modeOrIndex) => {
        const requestedIndex = typeof modeOrIndex === 'string'
            ? app.playModes.indexOf(modeOrIndex)
            : Number(modeOrIndex);
        app.currentPlayMode = Number.isInteger(requestedIndex) && requestedIndex >= 0
            ? requestedIndex % app.playModes.length
            : 0;
        localStorage.setItem(PLAY_MODE_STORAGE_KEY, app.playModes[app.currentPlayMode]);
        app.updateModeButton();
        if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
        app.refreshPreload?.();
    };

    app.updateModeButton = () => {
        const mode = app.playModes[app.currentPlayMode];
        let svg = '';
        if (mode === 'repeat') svg = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>';
        else if (mode === 'repeat-one') svg = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path><path d="M11 10h1v4"></path></svg>';
        else svg = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"></polyline><line x1="4" y1="20" x2="21" y2="3"></line><polyline points="21 16 21 21 16 21"></polyline><line x1="15" y1="15" x2="21" y2="21"></line><line x1="4" y1="4" x2="9" y2="9"></line></svg>';
        const label = mode === 'repeat' ? '列表循环' : (mode === 'repeat-one' ? '单曲循环' : '随机播放');
        app.modeBtn.innerHTML = svg;
        app.modeBtn.title = label;
        app.modeBtn.setAttribute('aria-label', label);
        app.modeBtn.classList.toggle('active', mode !== 'repeat');
    };

    // 从当前 DOM slider 读取频段增益，作为持久化载荷（回填后 app.eqBands 已同步）
    const eqSliderEls = new Map();
    app.buildEqBandsPayload = () => {
        const bands = {};
        for (const band in app.eqBands) {
            let slider = eqSliderEls.get(band);
            if (!slider || !slider.isConnected) {
                slider = document.getElementById(`eq-${band}`);
                if (slider) eqSliderEls.set(band, slider);
            }
            bands[band] = slider ? parseInt(slider.value, 10) : app.eqBands[band];
        }
        return bands;
    };

    app.saveSettings = () => {
        if (app.saveSettingsTimer) clearTimeout(app.saveSettingsTimer);
        app.saveSettingsTimer = setTimeout(() => {
            if (app.api?.saveMusicSettings) {
                app.api.saveMusicSettings({
                    settings: {
                        volume: parseFloat(app.volumeSlider.value),
                        target_samplerate: app.targetUpsamplingRate,
                        loudness_enabled: app.loudnessEnabled,
                        loudness_mode: app.loudnessMode,
                        target_lufs: app.targetLufs,
                        preamp_db: app.loudnessPreampDb,
                        saturation_enabled: app.saturationEnabled,
                        saturation_drive: app.saturationDrive,
                        saturation_mix: app.saturationMix,
                        crossfeed_enabled: app.crossfeedEnabled,
                        crossfeed_mix: app.crossfeedMix,
                        dynamic_loudness_enabled: app.dynamicLoudnessEnabled,
                        dynamic_loudness_strength: app.dynamicLoudnessStrength,
                        crossfade_ms: parseInt(app.crossfadeSelect?.value, 10) || 0,
                        eq_type: app.eqTypeSelect?.value || 'IIR',
                        eq_enabled: app.eqSwitch?.checked ?? false,
                        eq_bands: app.buildEqBandsPayload(),
                        fir_taps: parseInt(app.firTapsSelect?.value, 10) || 1023,
                        dither_enabled: app.ditherSwitch?.checked ?? true,
                        output_bits: parseInt(app.outputBitsSelect?.value, 10) || 24,
                        noise_shaper_curve: app.noiseShaperCurveSelect?.value || 'Lipshitz5',
                        resample_quality: app.resampleQualitySelect?.value || 'hq',
                        use_cache: app.resampleCacheSwitch?.checked ?? false,
                        preemptive_resample: app.preemptiveResampleSwitch?.checked ?? false
                    }
                });
            }
        }, 1000);
    };

    // 启动中途出错就别让开窗底色层继续盖着；错误照常往外抛
    init().catch((error) => { window.MusicIntroLib?.dropCover?.(); throw error; });
});
