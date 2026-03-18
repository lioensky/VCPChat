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
        dragInProgress: false,
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
        app.irPresetSelect.onchange = (e) => {
            const val = e.target.value;
            if (val === 'custom') { app.irLoadBtn.style.display = 'block'; app.irLoadBtn.click(); }
            else { app.irLoadBtn.style.display = 'none'; if (val) app.loadIrFile(val); else app.unloadIr(); }
        };
        app.irLoadBtn.onclick = async () => {
            const filePath = await window.electron.invoke('select-ir-file');
            if (filePath) app.loadIrFile(filePath);
        };

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
            const query = e.target.value.toLowerCase();
            app.currentFilteredTracks = query ? app.playlist.filter(t => (t.title || '').toLowerCase().includes(query) || (t.artist || '').toLowerCase().includes(query)) : null;
            app.renderPlaylist(app.currentFilteredTracks);
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
        window.electron.on('music-scan-complete', (newPlaylist) => {
            app.loadingIndicator.style.display = 'none'; app.playlist = newPlaylist;
            app.renderPlaylist(); app.renderSidebarContent(app.currentSidebarView);
        });
        window.electron.on('theme-updated', (theme) => app.applyTheme(theme));
        window.electron.on('music-control', (command) => {
            if (command === 'play') app.playTrack();
            else if (command === 'pause') app.pauseTrack();
            else if (command === 'next') app.nextTrack();
            else if (command === 'previous') app.prevTrack();
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
                    upsampling: app.targetUpsamplingRate,
                    loudness: { enabled: app.loudnessEnabled, mode: app.loudnessMode, target_lufs: app.targetLufs, preamp: app.loudnessPreampDb },
                    saturation: { enabled: app.saturationEnabled, type: app.saturationType, drive: app.saturationDrive, mix: app.saturationMix },
                    crossfeed: { enabled: app.crossfeedEnabled, mix: app.crossfeedMix },
                    dynamic_loudness: { enabled: app.dynamicLoudnessEnabled, strength: app.dynamicLoudnessStrength }
                });
            }
        }, 1000);
    };

    const initializeTheme = async () => {
        if (window.electron) app.applyTheme(await window.electron.invoke('get-theme'));
    };

    init();
});
