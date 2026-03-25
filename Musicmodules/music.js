// Musicmodules/music.js - Entry Point for the Refactored Music Player
document.addEventListener('DOMContentLoaded', () => {
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

        // --- State Variables ---
        playlist: [],
        currentFilteredTracks: null,
        filteredPlaylistSource: null,
        currentTrackIndex: 0,
        isPlaying: false,
        playModes: ['repeat', 'repeat-one', 'shuffle'],
        currentPlayMode: 0,
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
        BASS_THRESHOLD: 0.35,
        BASS_BOOST: 1.04,
        BASS_DECAY: 0.98,
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
    };


    // --- Initialization ---
    const init = async () => {
        // Setup modules
        setupUtils(app);
        setupVisualizer(app);
        setupLyrics(app);
        setupPlayer(app);
        setupOutput(app);
        setupEffects(app);
        setupWebDav(app);
        setupSidebar(app);
        setupUI(app);

        // --- Handlers & Listeners ---
        setupEventListeners();
        setupElectronHandlers();
        app.setupWebDavHandlers();
        app.setupMediaSessionHandlers();

        // Initial values
        app.initBackgroundLayers();
        app.visualizerCanvas.width = app.visualizerCanvas.clientWidth;
        app.visualizerCanvas.height = app.visualizerCanvas.clientHeight;
        app.recreateParticles();
        app.connectWebSocket();
        app.updateModeButton();
        await initializeTheme();

        app.phantomAudio.src = app.createSilentAudio();
        app.wnpAdapter = new WebNowPlayingAdapter(app);

        if (window.electron) {
            const savedPlaylist = await window.electron.invoke('get-music-playlist');
            if (savedPlaylist && savedPlaylist.length > 0) {
                app.playlist = savedPlaylist;
                app.renderPlaylist();
            }

            // 检查是否有待播放的曲目（AI 点歌触发的新窗口）
            const pendingTrack = await window.electron.invoke('music-get-pending-track');
            if (pendingTrack && pendingTrack.path) {
                console.log('[Music] Found pending track from main process:', pendingTrack.title);
                // 在播放列表中查找匹配的曲目
                const normalizedPendingPath = app.normalizePathForCompare(pendingTrack.path);
                let pendingIndex = app.playlist.findIndex(t =>
                    app.normalizePathForCompare(t.path) === normalizedPendingPath
                );
                // 如果路径匹配失败，尝试标题模糊匹配
                if (pendingIndex === -1 && pendingTrack.title) {
                    pendingIndex = app.playlist.findIndex(t =>
                        (t.title || '').toLowerCase().includes(pendingTrack.title.toLowerCase()) ||
                        (pendingTrack.title.toLowerCase().includes((t.title || '').toLowerCase()) && (t.title || '').length > 2)
                    );
                }
                if (pendingIndex !== -1) {
                    console.log('[Music] Loading pending track at index:', pendingIndex);
                    await app.loadTrack(pendingIndex, true); // 加载并播放
                } else {
                    // 播放列表中没找到，追加后播放
                    app.playlist.push(pendingTrack);
                    app.renderPlaylist();
                    await app.loadTrack(app.playlist.length - 1, true);
                    window.electron.invoke('save-music-playlist', app.playlist);
                }
            } else if (app.playlist.length > 0) {
                // 没有待播放曲目，按默认行为加载第一首（不自动播放）
                await app.loadTrack(0, false);
            }

            await app.loadCustomPlaylists();
            app.renderSidebarContent('all');

            const initialState = await window.electron.invoke('music-get-state');
            if (initialState?.state?.volume !== undefined) {
                app.volumeSlider.value = initialState.state.volume;
                app.updateVolumeSliderBackground(initialState.state.volume);
            }
            syncInitialSettings(initialState);
        }
        app.populateDeviceList(false);

        // Signal that the renderer is ready to handle commands
        if (window.electron) {
            console.log('[Music] Sending "music-renderer-ready" signal to main process.');
            window.electron.send('music-renderer-ready');
        }
        app.createEqBands();
        app.populateEqPresets();
    };

    const setupEventListeners = () => {
        app.playPauseBtn.onclick = () => app.isPlaying ? app.pauseTrack() : app.playTrack();
        app.prevBtn.onclick = () => app.prevTrack();
        app.nextBtn.onclick = () => app.nextTrack();
        app.modeBtn.onclick = () => {
            app.currentPlayMode = (app.currentPlayMode + 1) % app.playModes.length;
            app.updateModeButton();
            if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
        };

        app.volumeSlider.oninput = (e) => {
            const val = parseFloat(e.target.value);
            app.updateVolumeSliderBackground(val);
            if (window.electron) window.electron.invoke('music-set-volume', val);
            if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
            app.saveSettings();
        };

        app.handleProgressUpdate = async (e, shouldSeek = false) => {
            const rect = app.progressContainer.getBoundingClientRect();
            const offsetX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
            const width = rect.width;

            if (app.lastKnownDuration > 0) {
                const newTime = (offsetX / width) * app.lastKnownDuration;
                // Update UI immediately
                app.progress.style.width = `${(newTime / app.lastKnownDuration) * 100}%`;
                app.currentTimeEl.textContent = app.formatTime(newTime);

                if (shouldSeek) {
                    await window.electron.invoke('music-seek', newTime);
                    if (app.isPlaying) app.startStatePolling();
                }
            }
        };

        app.progressContainer.onmousedown = (e) => {
            app.dragInProgress = true;
            app.stopStatePolling();
            app.handleProgressUpdate(e);
        };

        window.addEventListener('mousemove', (e) => {
            if (app.dragInProgress) app.handleProgressUpdate(e);
        });

        window.addEventListener('mouseup', (e) => {
            if (app.dragInProgress) {
                app.handleProgressUpdate(e, true);
                setTimeout(() => { app.dragInProgress = false; }, 0);
            }
        });

        app.progressBar.onclick = (e) => {
            if (!app.dragInProgress) app.handleProgressUpdate(e, true);
        };


        app.addFolderBtn.onclick = () => window.electron.invoke('music-add-folder');
        app.shareBtn.onclick = () => {
            if (app.pendingTrackPath) window.electron.invoke('music-share-track', app.pendingTrackPath);
        };

        app.deviceSelect.onchange = () => app.configureOutput();
        app.wasapiSwitch.onchange = () => { if (!app.wasapiSwitch._programmaticUpdate) app.configureOutput(); };
        app.eqSwitch.onchange = () => { if (!app.eqSwitch._programmaticUpdate) app.sendEqSettings(); };
        app.eqTypeSelect.onchange = () => {
            app.firTapsSelect.style.display = app.eqTypeSelect.value === 'FIR' ? 'block' : 'none';
            app.sendEqSettings();
        };
        app.firTapsSelect.onchange = () => app.sendEqSettings();
        app.eqPresetSelect.onchange = (e) => app.applyEqPreset(e.target.value);
        app.ditherSwitch.onchange = () => app.updateOptimizations();
        app.replaygainSwitch.onchange = () => {
            if (app.replaygainSwitch._programmaticUpdate) return;
            app.loudnessModeSelect.value = app.replaygainSwitch.checked ? 'replaygain_track' : 'track';
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
                    const filePath = await window.electron.invoke('music-get-ir-preset-path', val);
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
                const presets = await window.electron.invoke('music-list-ir-presets');
                if (presets && presets.length > 0) {
                    const select = app.irPresetSelect;
                    // 保留第一个和最后一个选项
                    const customOption = select.options[select.options.length - 1];
                    const defaultOption = select.options[0];
                    
                    select.innerHTML = '';
                    select.add(defaultOption);
                    
                    presets.forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p;
                        opt.textContent = p;
                        select.add(opt);
                    });
                    
                    select.add(customOption);
                }
            } catch (err) {
                console.error('[Music] Failed to update IR presets list:', err);
            }
        };
        app.loadAvailableIrPresets();
        app.irLoadBtn.onclick = async () => {
            const filePath = await window.electron.invoke('select-ir-file');
            if (filePath) app.loadIrFile(filePath);
        };

        // --- IR Help Tip Logic ---
        const irHelpIcon = document.getElementById('ir-help-icon');
        const irHelpTip = document.getElementById('ir-help-tip');
        const irAutoEqLink = document.getElementById('ir-autoeq-link');

        console.log('[IR Help] Found elements:', { irHelpIcon: !!irHelpIcon, irHelpTip: !!irHelpTip });

        if (irHelpIcon && irHelpTip) {
            irHelpIcon.onclick = (e) => {
                console.log('[IR Help] Icon clicked');
                e.stopPropagation();
                const isHidden = irHelpTip.style.display === 'none';
                irHelpTip.style.display = isHidden ? 'block' : 'none';
                console.log('[IR Help] Tooltip display set to:', irHelpTip.style.display);
            };
            
            if (irAutoEqLink) {
                irAutoEqLink.onclick = (e) => {
                    e.preventDefault();
                    console.log('[IR Help] AutoEq link clicked');
                    if (window.electronAPI && window.electronAPI.sendOpenExternalLink) {
                        window.electronAPI.sendOpenExternalLink('https://autoeq.app/');
                    }
                };
            }

            // 点击外部关闭提示
            document.addEventListener('click', (e) => {
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

        app.playlistEl.addEventListener('click', (e) => {
            if (e.target.tagName === 'LI') app.loadTrack(parseInt(e.target.dataset.index, 10));
        });
        app.playlistEl.addEventListener('contextmenu', (e) => {
            if (e.target.tagName === 'LI') {
                e.preventDefault(); app.contextMenuTrackIndex = parseInt(e.target.dataset.index, 10);
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
        });
        app.dialogCancel.onclick = () => app.hidePlaylistDialog();
        app.dialogConfirm.onclick = () => {
            const name = app.playlistNameInput.value.trim();
            if (name && app.pendingAddToPlaylist) { app.pendingAddToPlaylist(name); app.hidePlaylistDialog(); }
        };
        app.playlistNameInput.onkeydown = (e) => { if (e.key === 'Enter') app.dialogConfirm.click(); if (e.key === 'Escape') app.dialogCancel.click(); };

        app.modalCloseBtn.onclick = app.modalDoneBtn.onclick = () => { app.playlistEditModal.classList.remove('visible'); if (app.currentSidebarView === 'playlists') app.renderSidebarContent('playlists'); };
        app.modalSearchInput.oninput = (e) => { app.modalSearchQuery = e.target.value; app.renderModalSongList(); };

        document.addEventListener('click', (e) => { if (!app.contextMenu.contains(e.target)) app.contextMenu.classList.remove('visible'); });
        app.contextMenu.querySelectorAll('.context-menu-item').forEach(item => {
            item.onclick = (e) => {
                const action = item.dataset.action; if (!action || action === 'add-to-playlist') return;
                if (action === 'play') app.loadTrack(app.contextMenuTrackIndex);
                else if (action === 'play-next') {
                    const t = app.playlist[app.contextMenuTrackIndex];
                    if (window.electron) window.electron.invoke('music-queue-next', { path: t.path, username: t.username, password: t.password });
                } else if (action === 'create-playlist-add') {
                    app.showPlaylistDialog((name) => {
                        const id = Date.now().toString(), track = app.playlist[app.contextMenuTrackIndex];
                        app.customPlaylists.push({ id, name, tracks: [track.path] });
                        app.saveCustomPlaylists(); if (app.currentSidebarView === 'playlists') app.renderSidebarContent('playlists');
                    });
                } else if (action === 'remove-from-list') {
                    if (app.filteredPlaylistSource?.type === 'playlist') {
                        const pl = app.customPlaylists.find(p => p.id === app.filteredPlaylistSource.id);
                        if (pl) {
                            const t = app.playlist[app.contextMenuTrackIndex];
                            pl.tracks = pl.tracks.filter(tp => tp !== t.path);
                            app.currentFilteredTracks = pl.tracks.map(p => app.playlist.find(tr => tr.path === p)).filter(Boolean);
                            app.saveCustomPlaylists(); app.renderPlaylist(app.currentFilteredTracks);
                        }
                    } else {
                        const t = app.playlist[app.contextMenuTrackIndex];
                        app.playlist.splice(app.contextMenuTrackIndex, 1);
                        if (app.currentTrackIndex === app.contextMenuTrackIndex) app.nextTrack();
                        else if (app.currentTrackIndex > app.contextMenuTrackIndex) app.currentTrackIndex--;
                        app.renderPlaylist(); window.electron.invoke('save-music-playlist', app.playlist);
                    }
                }
                app.contextMenu.classList.remove('visible');
            };
        });

        app.searchInput.oninput = (e) => {
            if (app.isSemanticSearchActive) return; // 语义搜索模式下不进行实时过滤
            const query = e.target.value.toLowerCase();
            app.currentFilteredTracks = query ? app.playlist.filter(t => (t.title || '').toLowerCase().includes(query) || (t.artist || '').toLowerCase().includes(query)) : null;
            app.renderPlaylist(app.currentFilteredTracks);
        };

        app.searchInput.onkeydown = (e) => {
            if (e.key === 'Enter' && app.isSemanticSearchActive) {
                const query = app.searchInput.value.trim();
                if (query) app.performSemanticSearch(query);
            }
        };

        app.semanticSearchBtn.onclick = () => {
            app.isSemanticSearchActive = !app.isSemanticSearchActive;
            app.semanticSearchBtn.classList.toggle('active', app.isSemanticSearchActive);
            app.searchInput.placeholder = app.isSemanticSearchActive ? "输入描述进行语义搜索..." : "搜索歌曲...";
            
            if (!app.isSemanticSearchActive) {
                // 退出语义搜索时恢复普通搜索
                const query = app.searchInput.value.toLowerCase();
                app.currentFilteredTracks = query ? app.playlist.filter(t => (t.title || '').toLowerCase().includes(query) || (t.artist || '').toLowerCase().includes(query)) : null;
                app.renderPlaylist(app.currentFilteredTracks);
            }
        };

        app.minimizeBtn.onclick = () => { if (window.electronAPI) window.electronAPI.minimizeWindow(); };
        app.maximizeBtn.onclick = () => { if (window.electronAPI) window.electronAPI.maximizeWindow(); };
        app.closeBtn.onclick = () => { if (window.electronAPI) window.electronAPI.closeWindow(); };


        window.addEventListener('resize', () => {
            app.visualizerCanvas.width = app.visualizerCanvas.clientWidth;
            app.visualizerCanvas.height = app.visualizerCanvas.clientHeight;
            app.recreateParticles();
        });
    };

    const setupElectronHandlers = () => {
        if (!window.electron) return;
        window.electron.on('music-scan-start', () => { app.loadingIndicator.style.display = 'flex'; app.scanProgressContainer.style.display = 'none'; });
        window.electron.on('music-scan-progress', (data) => {
            app.scanProgressContainer.style.display = 'block';
            const percent = (data.current / data.total) * 100;
            app.scanProgressBar.style.width = `${percent}%`;
            app.scanProgressLabel.textContent = `正在扫描: ${data.current} / ${data.total}`;
        });
        window.electron.on('music-scan-complete', (data) => {
            app.loadingIndicator.style.display = 'none';
            // data may be { tracks, folderPath } (new format) or plain array (legacy)
            const newPlaylist = Array.isArray(data) ? data : (data.tracks || []);
            const folderPath = Array.isArray(data) ? null : (data.folderPath || null);

            // Build a map of newly scanned tracks by path for quick lookup
            const scannedMap = new Map(newPlaylist.map(t => [t.path, t]));
            const scannedPaths = new Set(scannedMap.keys());

            // Normalize folder path for prefix matching (ensure trailing separator)
            const folderPrefix = folderPath ? folderPath.replace(/[\\/]+$/, '') : null;

            const updatedPlaylist = [];
            const handledPaths = new Set();

            for (const track of app.playlist) {
                if (scannedPaths.has(track.path)) {
                    // Track exists in new scan — use updated metadata
                    updatedPlaylist.push(scannedMap.get(track.path));
                    handledPaths.add(track.path);
                } else if (folderPrefix && track.path.startsWith(folderPrefix)) {
                    // Track belongs to the scanned folder but was NOT found in new scan
                    // → file was deleted from disk, remove it from playlist
                    // (skip adding it)
                } else {
                    // Track from a different folder/source — keep it
                    updatedPlaylist.push(track);
                }
            }

            // Add brand-new tracks that weren't in the existing playlist
            for (const track of newPlaylist) {
                if (!handledPaths.has(track.path)) {
                    updatedPlaylist.push(track);
                }
            }

            app.playlist = updatedPlaylist;
            app.renderPlaylist(); app.renderSidebarContent(app.currentSidebarView);
            window.electron.invoke('save-music-playlist', app.playlist);
        });
        window.electron.on('theme-updated', (theme) => app.applyTheme(theme));
        window.electron.on('music-control', (command) => {
            console.log('[Music] Received music-control command:', command);
            if (command === 'play') app.playTrack();
            else if (command === 'pause') app.pauseTrack();
            else if (command === 'next') app.nextTrack();
            else if (command === 'previous') app.prevTrack();
        });

        // --- 处理从主进程发来的 "点歌" 命令 ---
        // 当 AI 或分布式服务器点歌时，主进程会发送 music-set-track 通知
        // 前端在播放列表中查找匹配的曲目，并通过 loadTrack() 统一处理加载+UI更新+播放
        window.electron.on('music-set-track', (track) => {
            console.log('[Music] Received music-set-track:', track?.title, track?.path);
            if (!track || !track.path) return;

            // 在播放列表中查找匹配的曲目
            const normalizedTrackPath = app.normalizePathForCompare(track.path);
            let trackIndex = app.playlist.findIndex(t =>
                app.normalizePathForCompare(t.path) === normalizedTrackPath
            );

            // 如果路径精确匹配失败，尝试标题+艺术家模糊匹配
            if (trackIndex === -1 && track.title) {
                trackIndex = app.playlist.findIndex(t =>
                    (t.title || '').toLowerCase().includes(track.title.toLowerCase()) ||
                    (track.title.toLowerCase().includes((t.title || '').toLowerCase()) && (t.title || '').length > 2)
                );
            }

            if (trackIndex !== -1) {
                console.log('[Music] Found track in playlist at index:', trackIndex);
                app.loadTrack(trackIndex, true); // true = 加载并自动播放
            } else {
                console.warn('[Music] music-set-track: Track not found in local playlist:', track.title);
                // 即使播放列表中没找到，也可尝试直接用 track 信息播放
                // 将 track 添加到播放列表末尾后播放
                app.playlist.push(track);
                const newIndex = app.playlist.length - 1;
                app.renderPlaylist(app.currentFilteredTracks);
                app.loadTrack(newIndex, true);
                // 持久化
                if (window.electron) window.electron.invoke('save-music-playlist', app.playlist);
            }
        });
    };

    app.updateUIWithState = (state) => {
        if (!state) return;
        app.lastKnownCurrentTime = state.current_time; app.lastKnownDuration = state.duration;
        app.lastStateUpdateTime = Date.now();
        if (state.duration > 0) {
            const percent = (state.current_time / state.duration) * 100;
            app.progress.style.width = `${percent}%`;
            app.currentTimeEl.textContent = app.formatTime(state.current_time);
            app.durationEl.textContent = app.formatTime(state.duration);
        }
        if (state.is_playing !== app.isPlaying) {
            // Optimistic UI guard: Ignore polled state if we just sent a command
            const now = Date.now();
            if (app.isChangingState && (now - app.lastCommandTime < 800)) {
                if (state.is_playing === app.expectedPlayingState) {
                    app.isChangingState = false;
                } else {
                    // Skip update to prevent flickering
                    return;
                }
            }

            app.isPlaying = state.is_playing;
            app.playPauseBtn.classList.toggle('is-playing', app.isPlaying);
            if (app.isPlaying) app.startStatePolling(); else app.stopStatePolling();
        }
        if (state.loudness_info) {
            app.loudnessInfo.style.display = 'block';
            app.loudnessCurrentLufs.textContent = state.loudness_info.current_lufs.toFixed(1);
        }
        if (state.dynamic_loudness_factor !== undefined) {
            app.dynamicLoudnessFactor.textContent = state.dynamic_loudness_factor.toFixed(2) + 'x';
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
        if (s.eq_enabled !== undefined) {
            app.eqEnabled = s.eq_enabled; app.eqSwitch._programmaticUpdate = true;
            app.eqSwitch.checked = s.eq_enabled; Promise.resolve().then(() => app.eqSwitch._programmaticUpdate = false);
        }
        if (s.eq_type !== undefined) app.eqTypeSelect.value = s.eq_type;
        if (s.dither_enabled !== undefined) {
            app.ditherSwitch._programmaticUpdate = true; app.ditherSwitch.checked = s.dither_enabled;
            Promise.resolve().then(() => app.ditherSwitch._programmaticUpdate = false);
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
        if (s.loudness_enabled !== undefined) {
            app.loudnessEnabled = s.loudness_enabled;
            app.loudnessSwitch.checked = s.loudness_enabled;
            app.loudnessMode = s.loudness_mode;
            app.loudnessModeSelect.value = s.loudness_mode;
            app.targetLufs = s.target_lufs;
            app.loudnessLufsSlider.value = s.target_lufs;
            app.loudnessPreampDb = s.preamp_db;
            app.loudnessPreampSlider.value = s.preamp_db;
            app.updateLoudnessLufsDisplay();
            app.updateLoudnessPreampDisplay();
            app.updateLoudnessSettings(); // Sync to engine
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
            app.updateSaturationSettings(); // Sync to engine
        }
        if (s.crossfeed_enabled !== undefined) {
            app.crossfeedEnabled = s.crossfeed_enabled;
            app.crossfeedSwitch.checked = s.crossfeed_enabled;
            app.crossfeedMix = s.crossfeed_mix;
            app.crossfeedMixSlider.value = s.crossfeed_mix * 100;
            app.updateCrossfeedMixDisplay();
            app.updateCrossfeedSettings(); // Sync to engine
        }
        if (s.dynamic_loudness_enabled !== undefined) {
            app.dynamicLoudnessEnabled = s.dynamic_loudness_enabled;
            app.dynamicLoudnessSwitch.checked = s.dynamic_loudness_enabled;
            app.dynamicLoudnessStrength = s.dynamic_loudness_strength;
            app.dynamicLoudnessStrengthSlider.value = s.dynamic_loudness_strength * 100;
            app.updateDynamicLoudnessStrengthDisplay();
            app.updateDynamicLoudnessSettings(); // Sync to engine
        }
    };

    app.updateModeButton = () => {
        const mode = app.playModes[app.currentPlayMode];
        let svg = '';
        if (mode === 'repeat') svg = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>';
        else if (mode === 'repeat-one') svg = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path><path d="M11 10h1v4"></path></svg>';
        else svg = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"></polyline><line x1="4" y1="20" x2="21" y2="3"></line><polyline points="21 16 21 21 16 21"></polyline><line x1="15" y1="15" x2="21" y2="21"></line><line x1="4" y1="4" x2="9" y2="9"></line></svg>';
        app.modeBtn.innerHTML = svg;
        app.modeBtn.title = mode === 'repeat' ? '列表循环' : (mode === 'repeat-one' ? '单曲循环' : '随机播放');
        app.modeBtn.classList.toggle('active', mode !== 'repeat');
    };

    app.saveSettings = () => {
        if (app.saveSettingsTimer) clearTimeout(app.saveSettingsTimer);
        app.saveSettingsTimer = setTimeout(() => {
            if (window.electron) {
                window.electron.invoke('music-save-settings', {
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
                        dynamic_loudness_strength: app.dynamicLoudnessStrength
                    }
                });
            }
        }, 1000);
    };

    const initializeTheme = async () => {
        if (window.electron) app.applyTheme(await window.electron.invoke('get-theme'));
    };

    init();
});
