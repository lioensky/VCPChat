// Musicmodules/music.js - Rewritten for Python Hi-Fi Audio Engine
document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Element Selections ---
    const playPauseBtn = document.getElementById('play-pause-btn');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const modeBtn = document.getElementById('mode-btn');
    const volumeBtn = document.getElementById('volume-btn'); // 音量功能暂时由UI控制，不与引擎交互
    const volumeSlider = document.getElementById('volume-slider'); // 同上
    const progressContainer = document.querySelector('.progress-container');
    const progressBar = document.querySelector('.progress-bar');
    const progress = document.querySelector('.progress');
    const currentTimeEl = document.querySelector('.current-time');
    const durationEl = document.querySelector('.duration');
    const albumArt = document.querySelector('.album-art');
    const albumArtWrapper = document.querySelector('.album-art-wrapper');
    const trackTitle = document.querySelector('.track-title');
    const trackArtist = document.querySelector('.track-artist');
    const trackBitrate = document.querySelector('.track-bitrate');
    const playlistEl = document.getElementById('playlist');
    const addFolderBtn = document.getElementById('add-folder-btn');
    const searchInput = document.getElementById('search-input');
    const loadingIndicator = document.getElementById('loading-indicator');
    const scanProgressContainer = document.querySelector('.scan-progress-container');
    const scanProgressBar = document.querySelector('.scan-progress-bar');
    const scanProgressLabel = document.querySelector('.scan-progress-label');
    const playerBackground = document.getElementById('player-background');
    const visualizerCanvas = document.getElementById('visualizer');
    const visualizerCtx = visualizerCanvas.getContext('2d');
    const shareBtn = document.getElementById('share-btn');
    // --- New UI Elements for WASAPI ---
    const deviceSelect = document.getElementById('device-select');
    const wasapiSwitch = document.getElementById('wasapi-switch');
    const eqSwitch = document.getElementById('eq-switch');
    const eqBandsContainer = document.getElementById('eq-bands');
    const eqPresetSelect = document.getElementById('eq-preset-select');
    const eqSection = document.getElementById('eq-section');
    const eqTypeSelect = document.getElementById('eq-type-select');
    const firTapsSelect = document.getElementById('fir-taps-select');
    const ditherSwitch = document.getElementById('dither-switch');
    const replaygainSwitch = document.getElementById('replaygain-switch');
    const upsamplingSelect = document.getElementById('upsampling-select');
    // --- Resampling Settings UI Elements ---
    const resampleQualitySelect = document.getElementById('resample-quality-select');
    const resampleCacheSwitch = document.getElementById('resample-cache-switch');
    const preemptiveResampleSwitch = document.getElementById('preemptive-resample-switch');
    const lyricsContainer = document.getElementById('lyrics-container');
    const lyricsList = document.getElementById('lyrics-list');

    // --- IR Convolver UI Elements ---
    const irSwitch = document.getElementById('ir-switch');
    const irPresetSelect = document.getElementById('ir-preset-select');
    const irLoadBtn = document.getElementById('ir-load-btn');
    const irStatus = document.getElementById('ir-status');

    // --- Loudness Normalization UI Elements ---
    const loudnessSwitch = document.getElementById('loudness-switch');
    const loudnessModeSelect = document.getElementById('loudness-mode-select');
    const loudnessLufsSlider = document.getElementById('loudness-lufs-slider');
    const loudnessLufsValue = document.getElementById('loudness-lufs-value');
    const loudnessPreampSlider = document.getElementById('loudness-preamp-slider');
    const loudnessPreampValue = document.getElementById('loudness-preamp-value');
    const loudnessInfo = document.getElementById('loudness-info');
    const loudnessCurrentLufs = document.getElementById('loudness-current-lufs');

    // --- Saturation Effect UI Elements ---
    const saturationSwitch = document.getElementById('saturation-switch');
    const saturationTypeSelect = document.getElementById('saturation-type-select');
    const saturationDriveSlider = document.getElementById('saturation-drive-slider');
    const saturationDriveValue = document.getElementById('saturation-drive-value');
    const saturationMixSlider = document.getElementById('saturation-mix-slider');
    const saturationMixValue = document.getElementById('saturation-mix-value');

    // --- Crossfeed UI Elements ---
    const crossfeedSwitch = document.getElementById('crossfeed-switch');
    const crossfeedMixSlider = document.getElementById('crossfeed-mix-slider');
    const crossfeedMixValue = document.getElementById('crossfeed-mix-value');

    // --- Dynamic Loudness UI Elements ---
    const dynamicLoudnessSwitch = document.getElementById('dynamic-loudness-switch');
    const dynamicLoudnessStrengthSlider = document.getElementById('dynamic-loudness-strength-slider');
    const dynamicLoudnessStrengthValue = document.getElementById('dynamic-loudness-strength-value');
    const dynamicLoudnessFactor = document.getElementById('dynamic-loudness-factor');

    // --- Noise Shaper UI Elements ---
    const outputBitsSelect = document.getElementById('output-bits-select');
    const noiseShaperCurveSelect = document.getElementById('noise-shaper-curve-select');

    const phantomAudio = document.getElementById('phantom-audio');

    // --- Custom Title Bar ---
    const minimizeBtn = document.getElementById('minimize-music-btn');
    const maximizeBtn = document.getElementById('maximize-music-btn');
    const closeBtn = document.getElementById('close-music-btn');

    // --- Sidebar Elements ---
    const leftSidebar = document.getElementById('left-sidebar');
    const sidebarTabs = document.querySelectorAll('.sidebar-tab');
    const sidebarFooter = document.getElementById('sidebar-footer');
    const createPlaylistBtn = document.getElementById('create-playlist-btn');

    // --- Context Menu Elements ---
    const contextMenu = document.getElementById('track-context-menu');
    const playlistSubmenu = document.getElementById('playlist-submenu');

    // --- Dialog Elements ---
    const playlistDialog = document.getElementById('playlist-dialog');
    const playlistNameInput = document.getElementById('playlist-name-input');
    const dialogCancel = document.getElementById('dialog-cancel');
    const dialogConfirm = document.getElementById('dialog-confirm');

    // --- Playlist Edit Modal Elements ---
    const playlistEditModal = document.getElementById('playlist-edit-modal');
    const modalPlaylistTitle = document.getElementById('modal-playlist-title');
    const modalSearchInput = document.getElementById('modal-search-input');
    const modalSongList = document.getElementById('modal-song-list');
    const modalCount = document.getElementById('modal-count');
    const modalCloseBtn = document.getElementById('modal-close-btn');
    const modalDoneBtn = document.getElementById('modal-done-btn');

    // --- State Variables ---
    let playlist = [];
    let currentTrackIndex = 0;
    let isPlaying = false; // 本地UI状态，会与引擎同步
    let isTrackLoading = false;
    let pendingLoadRequestId = 0;
    let pendingTrackPath = null;
    let backgroundTransitionToken = 0;
    let backgroundTransitionTimer = null;
    let lyricsRequestToken = 0;
    const playModes = ['repeat', 'repeat-one', 'shuffle'];
    let currentPlayMode = 0;
    let currentTheme = 'dark';
    let currentLyrics = [];
    let currentLyricIndex = -1;
    let lyricOffset = -0.05; // In seconds. Negative value makes lyrics appear earlier to compensate for UI lag.
    let lyricSpeedFactor = 1.0; // Should be 1.0 for correctly timed LRC files.
    let lastKnownCurrentTime = 0;
    let lastStateUpdateTime = 0;
    let lastKnownDuration = 0;
    let wnpAdapter; // Rainmeter WebNowPlaying Adapter
    let visualizerColor = { r: 118, g: 106, b: 226 };
    let statePollInterval; // 用于轮询状态的定时器
    let currentDeviceId = null;
    let useWasapiExclusive = false;
    let targetUpsamplingRate = 0;
    let eqEnabled = false;

    // --- IR Convolver State ---
    let irEnabled = false;
    let irLoadedPath = null;
    const irPresets = {
        // 内置预设路径（如果存在的话）
        // 用户可以加载自定义 IR 文件
    };

    // --- Loudness Normalization State ---
    let loudnessEnabled = true;
    let loudnessMode = 'track';
    let targetLufs = -12.0;
    let loudnessPreampDb = 0.0;

    // --- Saturation Effect State ---
    let saturationEnabled = false;
    let saturationType = 'tube';
    let saturationDrive = 0.25;
    let saturationMix = 0.2;

    // --- Crossfeed State ---
    let crossfeedEnabled = false;
    let crossfeedMix = 0.3;

    // --- Dynamic Loudness State ---
    let dynamicLoudnessEnabled = false;
    let dynamicLoudnessStrength = 1.0;

    // --- Noise Shaper State ---
    let outputBits = 32;
    let noiseShaperCurve = 'TpdfOnly';

    // --- Gapless State ---
    let isPreloadingNext = false;  // 防止重复预加载
    
    // --- Settings Save State ---
    let saveSettingsTimeout = null;
    
    // Debounced save settings function
    const saveSettings = () => {
        if (saveSettingsTimeout) {
            clearTimeout(saveSettingsTimeout);
        }
        saveSettingsTimeout = setTimeout(async () => {
            if (!window.electron) return;
            
            const settings = {
                volume: parseFloat(volumeSlider.value),
                device_id: currentDeviceId,
                exclusive_mode: useWasapiExclusive,
                eq_type: eqTypeSelect.value,
                eq_bands: Object.keys(eqBands).length > 0 ? eqBands : null,
                fir_taps: eqTypeSelect.value === 'FIR' ? parseInt(firTapsSelect.value, 10) : null,
                dither_enabled: ditherSwitch.checked,
                output_bits: parseInt(outputBitsSelect.value, 10),
                noise_shaper_curve: noiseShaperCurveSelect.value,
                loudness_enabled: loudnessEnabled,
                loudness_mode: loudnessMode,
                target_lufs: targetLufs,
                preamp_db: loudnessPreampDb,
                saturation_enabled: saturationEnabled,
                saturation_drive: saturationDrive,
                saturation_mix: saturationMix,
                crossfeed_enabled: crossfeedEnabled,
                crossfeed_mix: crossfeedMix,
                dynamic_loudness_enabled: dynamicLoudnessEnabled,
                dynamic_loudness_strength: dynamicLoudnessStrength,
                target_samplerate: targetUpsamplingRate > 0 ? targetUpsamplingRate : null,
                resample_quality: document.getElementById('resample-quality-select')?.value || 'hq',
                use_cache: document.getElementById('resample-cache-switch')?.checked || false,
                preemptive_resample: document.getElementById('preemptive-resample-switch')?.checked ?? true
            };
            
            try {
                await window.electron.invoke('music-save-settings', { settings });
                console.log('[Music] Settings saved');
            } catch (e) {
                console.error('[Music] Failed to save settings:', e);
            }
        }, 500);  // Debounce 500ms
    };

    // --- Sidebar State ---
    let currentSidebarView = 'all';
    let customPlaylists = [];
    let filteredPlaylistSource = null; // { type: 'album'|'artist'|'playlist', name: string, id?: number }
    let pendingAddToPlaylist = null; // Callback for dialog
    let editingPlaylistId = null; // Currently editing playlist in modal
    let modalSearchQuery = ''; // Search filter for modal
    let lastModalClickIndex = -1; // For shift-select in modal
    let currentFilteredTracks = null; // Active playlist tracks for shuffle scope
    let shuffleQueue = [];
    let lastShuffleList = null;

    const eqBands = {
        '31': 0, '62': 0, '125': 0, '250': 0, '500': 0,
        '1k': 0, '2k': 0, '4k': 0, '8k': 0, '16k': 0
    };
    const eqPresets = {
        'balance': { '31': 0, '62': 0, '125': 0, '250': 0, '500': 0, '1k': 0, '2k': 0, '4k': 0, '8k': 0, '16k': 0 },
        'classical': { '31': 0, '62': 0, '125': 0, '250': -2, '500': -4, '1k': -5, '2k': -4, '4k': -3, '8k': 2, '16k': 3 },
        'pop': { '31': 2, '62': 4, '125': 5, '250': 2, '500': -1, '1k': -2, '2k': 0, '4k': 3, '8k': 4, '16k': 5 },
        'rock': { '31': 5, '62': 3, '125': -2, '250': -4, '500': -1, '1k': 2, '2k': 5, '4k': 6, '8k': 7, '16k': 7 },
        'electronic': { '31': 6, '62': 5, '125': 2, '250': 0, '500': -2, '1k': 0, '2k': 3, '4k': 5, '8k': 6, '16k': 7 },
        'acg_vocal': { '31': 1, '62': 2, '125': -1, '250': 1, '500': -2, '1k': 2, '2k': 5, '4k': 4, '8k': 3, '16k': 2 },
    };
    let isDraggingProgress = false;

    // --- Visualizer State ---
    let animationFrameId;
    let targetVisualizerData = [];
    let currentVisualizerData = [];
    const easingFactor = 0.2; // 缓动因子，值越小动画越平滑
    let bassScale = 1.0; // 用于专辑封面 Bass 动画
    const BASS_BOOST = 1.06; // Bass 触发时的放大系数
    const BASS_DECAY = 0.96; // 动画恢复速度
    const BASS_THRESHOLD = 0.55; // Bass 触发阈值
    let particles = []; // 用于存储粒子
    const PARTICLE_COUNT = 80; // 定义粒子数量

    // --- Particle Class ---
    class Particle {
        constructor(x, y) {
            this.x = x;
            this.y = y;
            this.targetY = y;
            this.vy = 0; // Vertical velocity
            this.size = 1.1;
            this.spring = 0.08; // Spring stiffness
            this.friction = 0.85; // Friction/damping
        }

        update() {
            // Spring physics for a bouncy effect
            const dy = this.targetY - this.y;
            const ay = dy * this.spring;
            this.vy += ay;
            this.vy *= this.friction;
            this.y += this.vy;
        }

    }

    const recreateParticles = () => {
        particles.length = 0; // Clear existing particles, more performant
        if (visualizerCanvas.width > 0) {
            // Distribute particles across the full width of the canvas
            for (let i = 0; i < PARTICLE_COUNT; i++) {
                // This ensures the first particle is at x=0 and the last is at x=width
                const x = visualizerCanvas.width * (i / (PARTICLE_COUNT - 1));
                // Initially place them slightly above the bottom
                particles.push(new Particle(x, visualizerCanvas.height - 10));
            }
        }
    };

    // --- WebSocket for Visualization (Native WebSocket) ---
    // Replaced socket.io with native WebSocket for Rust server compatibility
    let ws = null;
    const connectWebSocket = () => {
        ws = new WebSocket("ws://127.0.0.1:63789/ws");

        ws.onopen = () => {
            console.log('[Music.js] Connected to Rust Audio Engine via WebSocket.');
            if (!animationFrameId) {
                startVisualizerAnimation(); // Start animation loop
            }
        };

        ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'spectrum_data') {
                    if (isPlaying) {
                        targetVisualizerData = message.data;
                        if (currentVisualizerData.length === 0) {
                            currentVisualizerData = Array(targetVisualizerData.length).fill(0);
                        }
                    }
                } else if (message.type === 'needs_preload') {
                    // Gapless playback: engine requests next track preload
                    console.log('[Music.js] Received needs_preload event, remaining:', message.remaining_secs?.toFixed(1), 's');
                    handleNeedsPreload();
                }
            } catch (e) {
                console.error('[Music.js] Failed to parse WebSocket message:', e);
            }
        };

        ws.onclose = () => {
            // console.log('[Music.js] Disconnected from Rust Audio Engine WebSocket. Retrying in 5s...');
            setTimeout(connectWebSocket, 5000);
        };

        ws.onerror = (err) => {
            console.error('[Music.js] WebSocket error:', err);
            ws.close();
        };
    };

    connectWebSocket();


    // --- Helper Functions ---
    const formatTime = (seconds) => {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    };

    const normalizePathForCompare = (inputPath) => {
        if (!inputPath) return null;
        let normalized = inputPath.replace(/\\/g, '/');
        if (normalized.startsWith('//?/')) {
            normalized = normalized.substring(4);
        }
        return normalized;
    };

    // --- 双层背景切换系统 ---
    // 初始化双层背景层
    const initBackgroundLayers = () => {
        if (!playerBackground) return;
        
        // 创建两个背景层
        playerBackground.innerHTML = `
            <div class="bg-layer current"></div>
            <div class="bg-layer next"></div>
        `;
    };
    
    // 在脚本开始时初始化背景层
    initBackgroundLayers();

    const updateBlurredBackground = (imageUrl) => {
        if (!playerBackground) return;
        
        const layers = playerBackground.querySelectorAll('.bg-layer');
        if (layers.length < 2) {
            // 降级到单层模式
            playerBackground.classList.add('fallback');
            playerBackground.style.backgroundImage = imageUrl;
            return;
        }
        
        const currentLayer = layers[0];
        const nextLayer = layers[1];
        
        // 获取当前显示的背景URL
        const currentBg = currentLayer.style.backgroundImage;
        const newBg = imageUrl || 'none';
        
        // 如果背景相同，不做任何操作
        if (currentBg === newBg || (currentBg === '' && newBg === 'none')) {
            return;
        }

        const transitionToken = ++backgroundTransitionToken;
        if (backgroundTransitionTimer) {
            clearTimeout(backgroundTransitionTimer);
            backgroundTransitionTimer = null;
        }
        playerBackground.classList.remove('switching');
        
        // 设置新背景到 next 层
        nextLayer.style.backgroundImage = newBg;
        
        // 添加切换类触发动画
        playerBackground.classList.add('switching');
        
        // 动画结束后仅提交“最新”请求，避免旧定时器回写新背景
        backgroundTransitionTimer = setTimeout(() => {
            if (transitionToken !== backgroundTransitionToken) {
                return;
            }

            // 临时禁用过渡，避免 remove('switching') 触发反向过渡
            // 导致 currentLayer/nextLayer 同时半透明形成双曝光变亮效果
            currentLayer.style.transition = 'none';
            nextLayer.style.transition = 'none';

            currentLayer.style.backgroundImage = newBg;
            playerBackground.classList.remove('switching');

            // 下一帧恢复过渡，确保浏览器已完成本帧布局绘制
            requestAnimationFrame(() => {
                currentLayer.style.transition = '';
                nextLayer.style.transition = '';
                backgroundTransitionTimer = null;
            });
        }, 800); // 与 CSS transition 时间一致
    };

    const hexToRgb = (hex) => {
        if (!hex) return null;
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    };

    // --- Rainmeter WebNowPlaying Adapter ---
    class WebNowPlayingAdapter {
        constructor() {
            this.ws = null;
            this.reconnectInterval = 5000; // 5 seconds
            this.connect();
        }

        connect() {
            try {
                // WebNowPlaying default port is 8974
                this.ws = new WebSocket('ws://127.0.0.1:8974');

                this.ws.onopen = () => {
                    console.log('[WebNowPlaying] Connected to Rainmeter.');
                    this.sendUpdate(); // Send initial state
                };

                this.ws.onerror = (err) => {
                    // This will fire on connection refusal, ignore silently
                    this.ws = null;
                };

                this.ws.onclose = () => {
                    // Automatically try to reconnect
                    this.ws = null;
                    setTimeout(() => this.connect(), this.reconnectInterval);
                };
            } catch (e) {
                setTimeout(() => this.connect(), this.reconnectInterval);
            }
        }

        sendUpdate() {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

            const track = playlist.length > 0 ? playlist[currentTrackIndex] : null;
            const currentMode = playModes[currentPlayMode];

            const data = {
                player: 'VCP Music Player',
                state: !track ? 0 : (isPlaying ? 1 : 2), // 0=stopped, 1=playing, 2=paused
                title: track ? track.title || '' : 'No Track Loaded',
                artist: track ? track.artist || '' : '',
                album: track ? track.album || '' : '',
                cover: track && track.albumArt ? 'file://' + track.albumArt.replace(/\\/g, '/') : '',
                duration: lastKnownDuration || 0,
                position: lastKnownCurrentTime || 0,
                volume: Math.round(parseFloat(volumeSlider.value) * 100),
                rating: 0, // Not implemented
                // WebNowPlaying standard: 0=off, 1=repeat track, 2=repeat playlist
                repeat: currentMode === 'repeat-one' ? 1 : (currentMode === 'repeat' ? 2 : 0),
                shuffle: currentMode === 'shuffle' ? 1 : 0
            };

            try {
                this.ws.send(JSON.stringify(data));
            } catch (e) {
                console.error('[WebNowPlaying] Failed to send update:', e);
            }
        }
    }

    // --- Media Session API Integration ---
    const setupMediaSessionHandlers = () => {
        if (!('mediaSession' in navigator)) {
            return;
        }
        // 显式绑定 MediaSession 动作，确保 AirPods 手势能触发 playTrack/pauseTrack
        navigator.mediaSession.setActionHandler('play', () => {
            console.log('[MediaSession] Play action triggered');
            playTrack();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            console.log('[MediaSession] Pause action triggered');
            pauseTrack();
        });
        navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
        navigator.mediaSession.setActionHandler('nexttrack', nextTrack);

        // 监听 phantomAudio 的播放事件，作为 AirPods 手势的补充触发源
        phantomAudio.onplay = () => {
            if (!isPlaying && !isTrackLoading) {
                console.log('[PhantomAudio] Play event detected');
                playTrack();
            }
        };
        phantomAudio.onpause = () => {
            if (isPlaying && !isTrackLoading) {
                console.log('[PhantomAudio] Pause event detected');
                pauseTrack();
            }
        };
    };

    const updateMediaSessionMetadata = () => {
        if (!('mediaSession' in navigator) || playlist.length === 0 || !playlist[currentTrackIndex]) {
            return;
        }
        const track = playlist[currentTrackIndex];
        const artworkSrc = track.albumArt ? `file://${track.albumArt.replace(/\\/g, '/')}` : '';

        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title || '未知标题',
            artist: track.artist || '未知艺术家',
            album: track.album || 'VCP Music Player', // Default album name
            artwork: artworkSrc ? [{ src: artworkSrc }] : []
        });

        // 强制更新播放状态，确保系统控制中心与引擎同步
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    };

    // --- Core Player Logic ---
    const loadTrack = async (trackIndex, andPlay = true) => {
        const requestId = ++pendingLoadRequestId;

    // Cancel any pending gapless preload when user manually changes track
        isPreloadingNext = false;  // 重置标志
        try {
            await window.electron.invoke('music-cancel-preload');
        } catch (e) {
            // Ignore errors if no preload was pending
        }

        if (playlist.length === 0) {
            // 清空UI
            trackTitle.textContent = '未选择歌曲';
            trackArtist.textContent = '未知艺术家';
            trackBitrate.textContent = '';
            const defaultArtUrl = `url('../assets/${currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
            albumArt.style.backgroundImage = defaultArtUrl;
            updateBlurredBackground('none'); // 没有歌曲时，回退到全局背景
            renderPlaylist(currentFilteredTracks);
            return;
        }

        currentTrackIndex = trackIndex;
        const track = playlist[trackIndex];
    pendingTrackPath = track.path;
    isTrackLoading = true;

        // 更新UI
        trackTitle.textContent = track.title || '未知标题';
        trackArtist.textContent = track.artist || '未知艺术家';
        if (track.bitrate) {
            trackBitrate.textContent = `${Math.round(track.bitrate / 1000)} kbps`;
        } else {
            trackBitrate.textContent = '';
        }

        const defaultArtUrl = `url('../assets/${currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
        if (track.albumArt) {
            const albumArtUrl = `url('file://${track.albumArt.replace(/\\/g, '/')}')`;
            albumArt.style.backgroundImage = albumArtUrl;
            updateBlurredBackground(albumArtUrl);
        } else {
            albumArt.style.backgroundImage = defaultArtUrl;
            updateBlurredBackground(defaultArtUrl); // 没有封面时，回退到播放器默认封面背景
        }

        renderPlaylist(currentFilteredTracks);
        fetchAndDisplayLyrics(track.artist, track.title);
        updateMediaSessionMetadata(); // Update OS media controls
        if (wnpAdapter) wnpAdapter.sendUpdate();

        // 通过IPC让主进程通知Python引擎加载文件
        const result = await window.electron.invoke('music-load', track);
        if (result && result.status === 'success') {
            updateUIWithState(result.state);

            const waitForTrackReady = async () => {
                const timeoutAt = Date.now() + 12000;
                const targetPath = normalizePathForCompare(track.path);

                while (Date.now() < timeoutAt) {
                    if (requestId !== pendingLoadRequestId) {
                        return false;
                    }

                    const stateResult = await window.electron.invoke('music-get-state');
                    if (stateResult && stateResult.status === 'success' && stateResult.state) {
                        const state = stateResult.state;
                        updateUIWithState(state);

                        const loadedPath = normalizePathForCompare(state.file_path);
                        const engineLoading = !!state.is_loading;
                        if (loadedPath === targetPath && !engineLoading) {
                            return true;
                        }
                    }

                    await new Promise(resolve => setTimeout(resolve, 120));
                }

                return false;
            };

            const ready = await waitForTrackReady();
            if (requestId === pendingLoadRequestId) {
                isTrackLoading = false;
            }

            if (andPlay) {
                if (ready) {
                    playTrack();
                } else {
                    console.warn('[Music.js] Track load timed out before ready, skip auto-play for this request.');
                }
            }
        } else {
            if (requestId === pendingLoadRequestId) {
                isTrackLoading = false;
            }
            console.error("Failed to load track in audio engine:", result.message);
        }
    };

    const playTrack = async () => {
        if (playlist.length === 0 || isTrackLoading) return;
        const result = await window.electron.invoke('music-play');
        if (result.status === 'success') {
            isPlaying = true;
            playPauseBtn.classList.add('is-playing');
            // AirPods 手势恢复播放依赖于 phantomAudio 的状态同步
            // 循环播放占位音频，防止其结束后导致 MediaSession 状态失效
            phantomAudio.loop = true;
            phantomAudio.play().catch(e => console.error("Phantom audio play failed:", e));

            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'playing';
            }
            startStatePolling();
            if (wnpAdapter) wnpAdapter.sendUpdate();
        }
    };

    const pauseTrack = async () => {
        const result = await window.electron.invoke('music-pause');
        if (result.status === 'success') {
            isPlaying = false;
            playPauseBtn.classList.remove('is-playing');
            // AirPods 离开耳朵或手势暂停时，同步暂停 phantomAudio
            phantomAudio.pause();
            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'paused';
            }
            stopStatePolling();
            if (wnpAdapter) wnpAdapter.sendUpdate();
        }
    };

    const prevTrack = () => {
        currentTrackIndex = (currentTrackIndex - 1 + playlist.length) % playlist.length;
        loadTrack(currentTrackIndex);
        if (wnpAdapter) wnpAdapter.sendUpdate();
    };

    const nextTrack = () => {
        // Use filtered tracks if a playlist is active, otherwise use all tracks
        const activeList = currentFilteredTracks || playlist;

        // Reset shuffle queue if the active list has changed
        if (lastShuffleList !== activeList) {
            shuffleQueue = [];
            lastShuffleList = activeList;
        }

        if (activeList.length <= 1) {
            if (activeList.length === 1) {
                const track = activeList[0];
                const idx = playlist.indexOf(track);
                if (idx !== -1) loadTrack(idx);
            }
            return;
        }

        switch (playModes[currentPlayMode]) {
            case 'repeat':
                // Find current track's position in active list
                const currentTrack = playlist[currentTrackIndex];
                const currentPosInActive = activeList.indexOf(currentTrack);
                if (currentPosInActive !== -1) {
                    const nextPosInActive = (currentPosInActive + 1) % activeList.length;
                    const nextTrack = activeList[nextPosInActive];
                    currentTrackIndex = playlist.indexOf(nextTrack);
                } else {
                    // Current track not in active list, pick first from active
                    currentTrackIndex = playlist.indexOf(activeList[0]);
                }
                break;
            case 'repeat-one':
                // 引擎会在播放结束时停止，我们需要在这里重新加载并播放
                break;
            case 'shuffle':
                // If queue is empty, refill it with all indices from activeList
                if (shuffleQueue.length === 0) {
                    shuffleQueue = Array.from({ length: activeList.length }, (_, i) => i);
                    // Fisher-Yates shuffle algorithm
                    for (let i = shuffleQueue.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [shuffleQueue[i], shuffleQueue[j]] = [shuffleQueue[j], shuffleQueue[i]];
                    }
                    
                    // Avoid playing the same song again immediately if it's the first in the new queue
                    if (shuffleQueue.length > 1) {
                        const firstTrack = activeList[shuffleQueue[0]];
                        if (playlist.indexOf(firstTrack) === currentTrackIndex) {
                            // Move the first element to the end
                            shuffleQueue.push(shuffleQueue.shift());
                        }
                    }
                }
                
                const nextIndexInActive = shuffleQueue.shift();
                const selectedTrack = activeList[nextIndexInActive];
                currentTrackIndex = playlist.indexOf(selectedTrack);
                break;
        }
        loadTrack(currentTrackIndex);
        if (wnpAdapter) wnpAdapter.sendUpdate();
    };

    // --- Gapless Playback: Preload next track when engine requests ---
    const handleNeedsPreload = async () => {
        // 防止重复预加载
        if (isPreloadingNext) {
            return;
        }

        // Determine next track based on play mode (same logic as nextTrack)
        const activeList = currentFilteredTracks || playlist;
        if (activeList.length <= 1) {
            console.log('[Music.js] Gapless: No next track to preload');
            return;
        }

        let nextTrackToPreload = null;

        switch (playModes[currentPlayMode]) {
            case 'repeat':
                const currentTrack = playlist[currentTrackIndex];
                const currentPosInActive = activeList.indexOf(currentTrack);
                if (currentPosInActive !== -1) {
                    const nextPosInActive = (currentPosInActive + 1) % activeList.length;
                    nextTrackToPreload = activeList[nextPosInActive];
                } else {
                    nextTrackToPreload = activeList[0];
                }
                break;
            case 'repeat-one':
                // Repeat-one: preload same track (optional, engine handles loop)
                nextTrackToPreload = playlist[currentTrackIndex];
                break;
            case 'shuffle':
                // For shuffle, use the next item in shuffleQueue if available
                if (shuffleQueue.length > 0) {
                    const nextIndexInActive = shuffleQueue[0]; // Peek, don't shift
                    nextTrackToPreload = activeList[nextIndexInActive];
                } else {
                    // Generate shuffle queue to find next
                    const tempQueue = Array.from({ length: activeList.length }, (_, i) => i);
                    for (let i = tempQueue.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [tempQueue[i], tempQueue[j]] = [tempQueue[j], tempQueue[i]];
                    }
                    if (tempQueue.length > 0) {
                        nextTrackToPreload = activeList[tempQueue[0]];
                    }
                }
                break;
        }

        if (nextTrackToPreload && nextTrackToPreload.path) {
            console.log('[Music.js] Gapless: Preloading next track:', nextTrackToPreload.title);
            isPreloadingNext = true;
            try {
                await window.electron.invoke('music-queue-next', {
                    path: nextTrackToPreload.path,
                    username: nextTrackToPreload.username,
                    password: nextTrackToPreload.password
                });
            } catch (e) {
                console.error('[Music.js] Gapless: Failed to queue next track:', e);
            } finally {
                // 预加载完成后重置标志（成功或失败都要重置）
                // 延迟重置以防止短时间内重复调用
                setTimeout(() => {
                    isPreloadingNext = false;
                }, 500);
            }
        }
    };

    // --- UI Update and State Management ---
    const updateUIWithState = (state) => {
        if (!state) return;

        if (state.is_loading !== undefined) {
            isTrackLoading = !!state.is_loading;
        }

        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = (state.is_playing && !state.is_paused) ? 'playing' : 'paused';
        }

        isPlaying = state.is_playing && !state.is_paused;
        playPauseBtn.classList.toggle('is-playing', isPlaying);

        const duration = state.duration || 0;
        lastKnownDuration = duration; // Store for WebNowPlaying
        const currentTime = state.current_time || 0;
        lastKnownCurrentTime = currentTime;
        lastStateUpdateTime = Date.now();

        durationEl.textContent = formatTime(duration);
        currentTimeEl.textContent = formatTime(currentTime);

        const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
        progress.style.width = `${progressPercent}%`;

        // --- Gapless: Detect file_path change and update UI ---
        if (state.file_path) {
            // Normalize path: remove \\?\ prefix and convert to forward slashes
            const newFilePath = normalizePathForCompare(state.file_path);
            
            const currentTrack = playlist[currentTrackIndex];
            const currentPath = currentTrack ? normalizePathForCompare(currentTrack.path) : null;

            const pendingPath = normalizePathForCompare(pendingTrackPath);
            const isPendingTrackReady = !!(pendingPath && newFilePath === pendingPath && !state.is_loading);
            if (pendingPath && newFilePath === pendingPath && !state.is_loading) {
                isTrackLoading = false;
            }

            // 手动切歌加载中：忽略旧 file_path 的 gapless 回写，防止封面/背景闪回
            if (isTrackLoading && pendingPath && !isPendingTrackReady) {
                return;
            }
            
            // Check if the playing file has changed (gapless switch)
            if (currentPath !== newFilePath) {
                // Find the new track index in playlist
                const newIndex = playlist.findIndex(t => {
                    const tPath = normalizePathForCompare(t.path);
                    return tPath === newFilePath;
                });
                
                if (newIndex !== -1 && newIndex !== currentTrackIndex) {
                    console.log('[Music.js] Gapless: Detected track change to:', playlist[newIndex].title);
                    currentTrackIndex = newIndex;
                    // Update UI with new track info
                    const track = playlist[newIndex];
                    trackTitle.textContent = track.title || '未知标题';
                    trackArtist.textContent = track.artist || '未知艺术家';
                    if (track.bitrate) {
                        trackBitrate.textContent = `${Math.round(track.bitrate / 1000)} kbps`;
                    } else {
                        trackBitrate.textContent = '';
                    }
                    const defaultArtUrl = `url('../assets/${currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
                    if (track.albumArt) {
                        const albumArtUrl = `url('file://${track.albumArt.replace(/\\/g, '/')}')`;
                        albumArt.style.backgroundImage = albumArtUrl;
                        updateBlurredBackground(albumArtUrl);
                    } else {
                        albumArt.style.backgroundImage = defaultArtUrl;
                        updateBlurredBackground(defaultArtUrl);
                    }
                    renderPlaylist(currentFilteredTracks);
                    fetchAndDisplayLyrics(track.artist, track.title);
                    updateMediaSessionMetadata();
                    if (wnpAdapter) wnpAdapter.sendUpdate();
                }
            }
        }

        // 检查播放是否已结束（非 gapless 模式下的正常结束）
        if (!isTrackLoading && state.is_playing === false && currentTrackIndex !== -1 && currentTime > 0 && duration > 0) {
            // 播放结束
            // console.log("Playback seems to have ended.");
            stopStatePolling();
            if (playModes[currentPlayMode] === 'repeat-one') {
                loadTrack(currentTrackIndex, true);
            } else {
                nextTrack();
            }
        }
        // Update device selection UI
        if (deviceSelect.value !== state.device_id) {
            deviceSelect.value = state.device_id;
        }
        if (wasapiSwitch.checked !== state.exclusive_mode) {
            wasapiSwitch._programmaticUpdate = true;
            wasapiSwitch.checked = state.exclusive_mode;
            Promise.resolve().then(() => { wasapiSwitch._programmaticUpdate = false; });
        }
        // Update EQ UI
        if (state.eq_enabled !== undefined && eqSwitch.checked !== state.eq_enabled) {
            eqSwitch._programmaticUpdate = true;
            eqSwitch.checked = state.eq_enabled;
            Promise.resolve().then(() => { eqSwitch._programmaticUpdate = false; });
        }
        if (state.eq_type !== undefined && eqTypeSelect.value !== state.eq_type && !eqTypeSelect.matches(':focus')) {
            eqTypeSelect.value = state.eq_type;
        }
        if (state.dither_enabled !== undefined && ditherSwitch.checked !== state.dither_enabled) {
            ditherSwitch._programmaticUpdate = true;
            ditherSwitch.checked = state.dither_enabled;
            Promise.resolve().then(() => { ditherSwitch._programmaticUpdate = false; });
        }
        // ReplayGain switch syncs with loudness_mode
        const isRgMode = state.loudness_mode === 'replaygain_track' || state.loudness_mode === 'replaygain_album';
        if (replaygainSwitch.checked !== isRgMode) {
            replaygainSwitch._programmaticUpdate = true;
            replaygainSwitch.checked = isRgMode;
            Promise.resolve().then(() => { replaygainSwitch._programmaticUpdate = false; });
        }
        if (state.eq_bands) {
            for (const [band, gain] of Object.entries(state.eq_bands)) {
                const slider = document.getElementById(`eq-${band}`);
                if (slider && slider.value !== gain) {
                    slider.value = gain;
                }
                eqBands[band] = gain;
            }
        }
        // Update upsampling UI
        if (state.target_samplerate !== undefined && upsamplingSelect.value !== state.target_samplerate) {
            upsamplingSelect.value = state.target_samplerate || 0;
        }

        // Update resampling settings UI
        if (state.resample_quality !== undefined && resampleQualitySelect.value !== state.resample_quality) {
            resampleQualitySelect.value = state.resample_quality;
        }
        if (state.use_cache !== undefined && resampleCacheSwitch.checked !== state.use_cache) {
            resampleCacheSwitch._programmaticUpdate = true;
            resampleCacheSwitch.checked = state.use_cache;
            Promise.resolve().then(() => { resampleCacheSwitch._programmaticUpdate = false; });
        }
        if (state.preemptive_resample !== undefined && preemptiveResampleSwitch.checked !== state.preemptive_resample) {
            preemptiveResampleSwitch._programmaticUpdate = true;
            preemptiveResampleSwitch.checked = state.preemptive_resample;
            Promise.resolve().then(() => { preemptiveResampleSwitch._programmaticUpdate = false; });
        }

        // Update loudness normalization UI
        if (state.loudness_enabled !== undefined && loudnessSwitch.checked !== state.loudness_enabled) {
            loudnessSwitch._programmaticUpdate = true;
            loudnessSwitch.checked = state.loudness_enabled;
            Promise.resolve().then(() => { loudnessSwitch._programmaticUpdate = false; });
        }
        if (state.loudness_mode !== undefined && loudnessModeSelect.value !== state.loudness_mode) {
            loudnessModeSelect.value = state.loudness_mode;
        }
        if (state.target_lufs !== undefined && parseFloat(loudnessLufsSlider.value) !== state.target_lufs) {
            loudnessLufsSlider.value = state.target_lufs;
            updateLoudnessLufsDisplay();
        }
        if (state.preamp_db !== undefined && parseFloat(loudnessPreampSlider.value) !== state.preamp_db) {
            loudnessPreampSlider.value = state.preamp_db;
            updateLoudnessPreampDisplay();
        }

        // Update saturation UI
        if (state.saturation_enabled !== undefined && saturationSwitch.checked !== state.saturation_enabled) {
            saturationSwitch._programmaticUpdate = true;
            saturationSwitch.checked = state.saturation_enabled;
            Promise.resolve().then(() => { saturationSwitch._programmaticUpdate = false; });
        }
        if (state.saturation_drive !== undefined) {
            const drivePercent = Math.round(state.saturation_drive * 100);
            if (parseInt(saturationDriveSlider.value) !== drivePercent) {
                saturationDriveSlider.value = drivePercent;
                updateSaturationDriveDisplay();
            }
        }
        if (state.saturation_mix !== undefined) {
            const mixPercent = Math.round(state.saturation_mix * 100);
            if (parseInt(saturationMixSlider.value) !== mixPercent) {
                saturationMixSlider.value = mixPercent;
                updateSaturationMixDisplay();
            }
        }

        // Update crossfeed UI
        if (state.crossfeed_enabled !== undefined && crossfeedSwitch.checked !== state.crossfeed_enabled) {
            crossfeedSwitch._programmaticUpdate = true;
            crossfeedSwitch.checked = state.crossfeed_enabled;
            Promise.resolve().then(() => { crossfeedSwitch._programmaticUpdate = false; });
        }
        if (state.crossfeed_mix !== undefined) {
            const cfMixPercent = Math.round(state.crossfeed_mix * 100);
            if (parseInt(crossfeedMixSlider.value) !== cfMixPercent) {
                crossfeedMixSlider.value = cfMixPercent;
                updateCrossfeedMixDisplay();
            }
        }

        // Update dynamic loudness UI
        if (state.dynamic_loudness_enabled !== undefined && dynamicLoudnessSwitch.checked !== state.dynamic_loudness_enabled) {
            dynamicLoudnessSwitch._programmaticUpdate = true;
            dynamicLoudnessSwitch.checked = state.dynamic_loudness_enabled;
            Promise.resolve().then(() => { dynamicLoudnessSwitch._programmaticUpdate = false; });
        }
        if (state.dynamic_loudness_strength !== undefined) {
            const dlStrengthPercent = Math.round(state.dynamic_loudness_strength * 100);
            if (parseInt(dynamicLoudnessStrengthSlider.value) !== dlStrengthPercent) {
                dynamicLoudnessStrengthSlider.value = dlStrengthPercent;
                updateDynamicLoudnessStrengthDisplay();
            }
        }
        if (state.dynamic_loudness_factor !== undefined) {
            dynamicLoudnessFactor.textContent = state.dynamic_loudness_factor.toFixed(2);
        }

        // Update noise shaper UI
        if (state.output_bits !== undefined && parseInt(outputBitsSelect.value) !== state.output_bits) {
            outputBitsSelect.value = state.output_bits;
        }
        if (state.noise_shaper_curve !== undefined && noiseShaperCurveSelect.value !== state.noise_shaper_curve) {
            noiseShaperCurveSelect.value = state.noise_shaper_curve;
        }

        if (wnpAdapter) wnpAdapter.sendUpdate();
    };

    const pollState = async () => {
        const result = await window.electron.invoke('music-get-state');
        if (result.status === 'success') {
            updateUIWithState(result.state);
        }
    };

    const startStatePolling = () => {
        if (statePollInterval) clearInterval(statePollInterval);
        statePollInterval = setInterval(pollState, 250); // 每250ms更新一次进度
    };

    const stopStatePolling = () => {
        clearInterval(statePollInterval);
        statePollInterval = null;
    };


    // --- Visualizer ---
    const startVisualizerAnimation = () => {
        const draw = () => {
            if (isPlaying) {
                animateLyrics();
            }

            // --- Bass Animation Logic ---
            if (isPlaying && currentVisualizerData.length > 0 && albumArtWrapper) {
                // 从低频段计算 Bass 能量
                const bassBinCount = Math.floor(currentVisualizerData.length * 0.05); // 取前5%的频段
                let bassEnergy = 0;
                for (let i = 0; i < bassBinCount; i++) {
                    bassEnergy += currentVisualizerData[i];
                }
                bassEnergy /= bassBinCount; // 平均能量

                // 如果 Bass 能量超过阈值，则触发动画
                if (bassEnergy > BASS_THRESHOLD && bassScale < BASS_BOOST) {
                    bassScale = BASS_BOOST;
                } else {
                    // 动画效果逐渐衰减回原样
                    bassScale = Math.max(1.0, bassScale * BASS_DECAY);
                }

                albumArtWrapper.style.transform = `scale(${bassScale})`;
            }
            // --- End Bass Animation Logic ---

            if (targetVisualizerData.length === 0) {
                visualizerCtx.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
                animationFrameId = requestAnimationFrame(draw);
                return;
            }

            // 使用缓动公式更新当前数据
            for (let i = 0; i < targetVisualizerData.length; i++) {
                if (currentVisualizerData[i] === undefined) {
                    currentVisualizerData[i] = 0;
                }
                currentVisualizerData[i] += (targetVisualizerData[i] - currentVisualizerData[i]) * easingFactor;
            }

            // 使用平滑后的当前数据进行绘制
            drawVisualizer(currentVisualizerData);

            // 更新和绘制粒子
            // 更新和绘制粒子
            // First, update all particle positions based on the spectrum
            particles.forEach(p => {
                // 找到粒子对应的频谱数据点
                const positionRatio = p.x / visualizerCanvas.width;
                const dataIndexFloat = positionRatio * (currentVisualizerData.length - 1);
                const index1 = Math.floor(dataIndexFloat);
                const index2 = Math.min(index1 + 1, currentVisualizerData.length - 1);

                // Linear interpolation for smooth height transition between data points
                const value1 = currentVisualizerData[index1] || 0;
                const value2 = currentVisualizerData[index2] || 0;
                const fraction = dataIndexFloat - index1;
                const interpolatedValue = value1 + (value2 - value1) * fraction;

                // 计算目标Y值，让粒子在频谱线上方一点
                const spectrumY = visualizerCanvas.height - (interpolatedValue * visualizerCanvas.height * 1.2);
                p.targetY = spectrumY - 6; // Keep particles a bit higher than the curve

                p.update();
            });

            // Now, draw a smooth curve connecting the particles
            if (particles.length > 1) {
                visualizerCtx.beginPath();
                visualizerCtx.moveTo(particles[0].x, particles[0].y);

                // Draw segments to midpoints, which creates a smooth chain
                for (let i = 0; i < particles.length - 2; i++) {
                    const p1 = particles[i];
                    const p2 = particles[i + 1];
                    const xc = (p1.x + p2.x) / 2;
                    const yc = (p1.y + p2.y) / 2;
                    visualizerCtx.quadraticCurveTo(p1.x, p1.y, xc, yc);
                }

                // For the last segment, curve to the last point to make it smooth
                const secondLast = particles[particles.length - 2];
                const last = particles[particles.length - 1];
                visualizerCtx.quadraticCurveTo(secondLast.x, secondLast.y, last.x, last.y);


                const { r, g, b } = visualizerColor;
                visualizerCtx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.85)`;
                visualizerCtx.lineWidth = 1.5;
                visualizerCtx.lineJoin = 'round';
                visualizerCtx.lineCap = 'round';
                visualizerCtx.stroke();
            }

            animationFrameId = requestAnimationFrame(draw);
        };
        draw();
    };

    const drawVisualizer = (data) => {
        visualizerCtx.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);

        const bufferLength = data.length;
        if (bufferLength === 0) return;

        const gradient = visualizerCtx.createLinearGradient(0, 0, 0, visualizerCanvas.height);
        const { r, g, b } = visualizerColor;
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.85)`);
        gradient.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, 0.4)`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.05)`);

        visualizerCtx.fillStyle = gradient;
        visualizerCtx.strokeStyle = gradient;
        visualizerCtx.lineWidth = 2;

        visualizerCtx.beginPath();
        visualizerCtx.moveTo(0, visualizerCanvas.height);

        const sliceWidth = visualizerCanvas.width / (bufferLength - 1);

        // Helper to get a point's coordinates
        const getPoint = (index) => {
            const value = data[index] || 0;
            const x = index * sliceWidth;
            const y = visualizerCanvas.height - (value * visualizerCanvas.height * 1.2);
            return [x, y];
        };

        for (let i = 0; i < bufferLength - 1; i++) {
            const [x1, y1] = getPoint(i);
            const [x2, y2] = getPoint(i + 1);

            const [prev_x, prev_y] = i > 0 ? getPoint(i - 1) : [x1, y1];
            const [next_x, next_y] = i < bufferLength - 2 ? getPoint(i + 2) : [x2, y2];

            const tension = 0.5;
            const cp1_x = x1 + (x2 - prev_x) / 6 * tension;
            const cp1_y = y1 + (y2 - prev_y) / 6 * tension;
            const cp2_x = x2 - (next_x - x1) / 6 * tension;
            const cp2_y = y2 - (next_y - y1) / 6 * tension;

            if (i === 0) {
                visualizerCtx.lineTo(x1, y1);
            }

            visualizerCtx.bezierCurveTo(cp1_x, cp1_y, cp2_x, cp2_y, x2, y2);

            // --- Particle Generation ---
        }

        visualizerCtx.lineTo(visualizerCanvas.width, visualizerCanvas.height);
        visualizerCtx.closePath();
        visualizerCtx.fill();
    };

    // --- Event Listeners ---
    playPauseBtn.addEventListener('click', () => {
        if (isTrackLoading) return;
        isPlaying ? pauseTrack() : playTrack();
    });
    prevBtn.addEventListener('click', prevTrack);
    nextBtn.addEventListener('click', nextTrack);
    // --- Progress Bar Drag Logic ---
    let dragInProgress = false; // Use a different name to avoid conflict

    const handleProgressUpdate = async (e, shouldSeek = false) => {
        const rect = progressContainer.getBoundingClientRect();
        // Ensure offsetX is within valid bounds
        const offsetX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const width = rect.width;

        const result = await window.electron.invoke('music-get-state');
        if (result.status === 'success' && result.state.duration > 0) {
            const duration = result.state.duration;
            const newTime = (offsetX / width) * duration;

            // Update UI immediately
            progress.style.width = `${(newTime / duration) * 100}%`;
            currentTimeEl.textContent = formatTime(newTime);

            if (shouldSeek) {
                await window.electron.invoke('music-seek', newTime);
                // If still playing after drag, resume polling
                if (isPlaying) {
                    startStatePolling();
                }
            }
        }
    };

    progressContainer.addEventListener('mousedown', (e) => {
        dragInProgress = true;
        stopStatePolling(); // Pause state polling during drag to prevent UI jumps
        handleProgressUpdate(e);
    });

    window.addEventListener('mousemove', (e) => {
        if (dragInProgress) {
            handleProgressUpdate(e);
        }
    });

    window.addEventListener('mouseup', (e) => {
        if (dragInProgress) {
            handleProgressUpdate(e, true); // Pass true to seek
            // The click event will fire after mouseup, so we delay resetting the flag
            setTimeout(() => {
                dragInProgress = false;
            }, 0);
        }
    });

    progressContainer.addEventListener('click', (e) => {
        // Only seek on click if not dragging
        if (!dragInProgress) {
            handleProgressUpdate(e, true);
        }
    });

    const updateVolumeSliderBackground = (value) => {
        const percentage = value * 100;
        volumeSlider.style.backgroundSize = `${percentage}% 100%`;
    };

    // 音量控制暂时保持前端控制，因为它不影响HIFI解码
    volumeSlider.addEventListener('input', async (e) => {
        const newVolume = parseFloat(e.target.value);
        updateVolumeSliderBackground(newVolume);
        if (window.electron) {
            await window.electron.invoke('music-set-volume', newVolume);
        }
    });
    volumeSlider.addEventListener('change', () => {
        saveSettings();
    });
    volumeBtn.addEventListener('click', () => {
        // Mute toggle logic can be implemented here if needed
        const isMuted = volumeSlider.value === '0';
        const newVolume = isMuted ? (volumeBtn.dataset.lastVolume || 1) : 0;

        if (!isMuted) {
            volumeBtn.dataset.lastVolume = volumeSlider.value;
        }

        volumeSlider.value = newVolume;
        // Manually trigger the input event to send the new volume to the engine
        volumeSlider.dispatchEvent(new Event('input'));
    });

    modeBtn.addEventListener('click', () => {
        currentPlayMode = (currentPlayMode + 1) % playModes.length;
        // Reset shuffle queue when switching to shuffle mode to ensure a fresh sequence
        if (playModes[currentPlayMode] === 'shuffle') {
            shuffleQueue = [];
        }
        updateModeButton();
        if (wnpAdapter) wnpAdapter.sendUpdate();
    });

    const updateModeButton = () => {
        modeBtn.className = 'control-btn icon-btn'; // Reset classes
        const currentMode = playModes[currentPlayMode];
        modeBtn.classList.add(currentMode);
        if (currentMode !== 'repeat') {
            modeBtn.classList.add('active');
        }
    };

    playlistEl.addEventListener('click', (e) => {
        if (e.target.tagName === 'LI') {
            const index = parseInt(e.target.dataset.index, 10);
            // Reset shuffle queue on manual selection to start a new sequence from this song
            shuffleQueue = [];
            loadTrack(index);
        }
    });

    searchInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase();
        const filteredPlaylist = playlist.filter(track =>
            (track.title || '').toLowerCase().includes(searchTerm) ||
            (track.artist || '').toLowerCase().includes(searchTerm) ||
            (track.album || '').toLowerCase().includes(searchTerm)
        );
        renderPlaylist(filteredPlaylist);
    });

    window.addEventListener('resize', () => {
        visualizerCanvas.width = visualizerCanvas.clientWidth;
        visualizerCanvas.height = visualizerCanvas.clientHeight;
        recreateParticles(); // Re-distribute particles on resize
    });

    shareBtn.addEventListener('click', () => {
        if (!playlist || playlist.length === 0 || !playlist[currentTrackIndex]) return;
        const track = playlist[currentTrackIndex];
        if (track.path && window.electron) {
            window.electron.send('share-file-to-main', track.path);
        }
    });

    // --- Custom Title Bar Listeners ---
    minimizeBtn.addEventListener('click', () => {
        if (window.electronAPI) window.electronAPI.minimizeWindow();
    });

    maximizeBtn.addEventListener('click', () => {
        if (window.electronAPI) window.electronAPI.maximizeWindow();
    });

    closeBtn.addEventListener('click', () => {
        window.close();
    });

    // --- WASAPI and Device Control ---
    const populateDeviceList = async (forceRefresh = false) => {
        if (!window.electron) return;
        try {
            const result = await window.electron.invoke('music-get-devices', { refresh: forceRefresh });
            if (result.status === 'success' && result.devices) {
                deviceSelect.innerHTML = ''; // Clear existing options

                // Add default device option
                const defaultOption = document.createElement('option');
                defaultOption.value = 'default';
                defaultOption.textContent = '默认设备';
                deviceSelect.appendChild(defaultOption);

                // Add Preferred devices (WASAPI or Core Audio)
                const preferredDevices = result.devices.preferred || [];
                const preferredName = result.devices.preferred_name || '推荐设备';

                if (preferredDevices.length > 0) {
                    const preferredGroup = document.createElement('optgroup');
                    preferredGroup.label = preferredName;
                    preferredDevices.forEach(device => {
                        const option = document.createElement('option');
                        option.value = device.id;
                        option.textContent = device.name;
                        preferredGroup.appendChild(option);
                    });
                    deviceSelect.appendChild(preferredGroup);
                }

                // Add Other devices
                const otherDevices = result.devices.other || [];
                if (otherDevices.length > 0) {
                    const otherGroup = document.createElement('optgroup');
                    otherGroup.label = '其他设备';
                    otherDevices.forEach(device => {
                        const option = document.createElement('option');
                        option.value = device.id;
                        option.textContent = device.name;
                        otherGroup.appendChild(option);
                    });
                    deviceSelect.appendChild(otherGroup);
                }
            } else {
                console.error("Failed to get audio devices:", result.message);
            }
        } catch (error) {
            console.error("Error populating device list:", error);
        }
    };

    const configureOutput = async () => {
        if (!window.electron) return;

        const selectedDeviceId = deviceSelect.value === 'default' ? null : parseInt(deviceSelect.value, 10);
        const useExclusive = wasapiSwitch.checked;

        // Prevent re-configuration if nothing changed
        if (selectedDeviceId === currentDeviceId && useExclusive === useWasapiExclusive) {
            return;
        }

        console.log(`Configuring output: Device ID=${selectedDeviceId}, Exclusive=${useExclusive}`);

        // 禁用选择框防止重复触发
        deviceSelect.disabled = true;
        wasapiSwitch.disabled = true;

        try {
            currentDeviceId = selectedDeviceId;
            useWasapiExclusive = useExclusive;

            await window.electron.invoke('music-configure-output', {
                device_id: currentDeviceId,
                exclusive: useWasapiExclusive
            });

            // 切换后重新获取设备列表，以更新“(系统默认)”标记
            await populateDeviceList(false);
            deviceSelect.value = currentDeviceId === null ? 'default' : currentDeviceId;
        } catch (error) {
            console.error("Error configuring output:", error);
        } finally {
            deviceSelect.disabled = false;
            wasapiSwitch.disabled = false;
        }
    };

    deviceSelect.addEventListener('change', configureOutput);
    wasapiSwitch.addEventListener('change', () => {
        if (!wasapiSwitch._programmaticUpdate) {
            configureOutput();
        }
    });

    // --- Upsampling Control ---
    const configureUpsampling = async () => {
        if (!window.electron) return;
        const selectedRate = parseInt(upsamplingSelect.value, 10);

        if (selectedRate === targetUpsamplingRate) {
            return;
        }

        targetUpsamplingRate = selectedRate;

        console.log(`Configuring upsampling: Target Rate=${targetUpsamplingRate}`);
        await window.electron.invoke('music-configure-upsampling', {
            target_samplerate: targetUpsamplingRate > 0 ? targetUpsamplingRate : null
        });
        
        saveSettings();
    };

    upsamplingSelect.addEventListener('change', configureUpsampling);

    // --- Resampling Settings Control ---
    const configureResampling = async () => {
        if (!window.electron) return;
        await window.electron.invoke('music-configure-resampling', {
            quality: resampleQualitySelect.value,
            use_cache: resampleCacheSwitch.checked,
            preemptive_resample: preemptiveResampleSwitch.checked
        });
        
        saveSettings();
    };

    resampleQualitySelect.addEventListener('change', configureResampling);
    resampleCacheSwitch.addEventListener('change', configureResampling);
    preemptiveResampleSwitch.addEventListener('change', configureResampling);

    // --- EQ Control ---
    const populateEqPresets = () => {
        const presetNames = {
            'balance': '平衡',
            'classical': '古典',
            'pop': '流行',
            'rock': '摇滚',
            'electronic': '电子',
            'acg_vocal': '萌系ACG'
        };
        for (const preset in eqPresets) {
            const option = document.createElement('option');
            option.value = preset;
            option.textContent = presetNames[preset] || preset;
            eqPresetSelect.appendChild(option);
        }
    };

    const applyEqPreset = (presetName) => {
        const preset = eqPresets[presetName];
        if (!preset) return;

        for (const band in preset) {
            const slider = document.getElementById(`eq-${band}`);
            if (slider) {
                slider.value = preset[band];
            }
        }
        sendEqSettings();
    };

    const createEqBands = () => {
        eqBandsContainer.innerHTML = '';
        for (const band in eqBands) {
            const bandContainer = document.createElement('div');
            bandContainer.className = 'eq-band';

            const label = document.createElement('label');
            label.setAttribute('for', `eq-${band}`);
            label.textContent = band;

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.id = `eq-${band}`;
            slider.min = -15;
            slider.max = 15;
            slider.step = 1;
            slider.value = eqBands[band];

            slider.addEventListener('input', () => sendEqSettings());

            bandContainer.appendChild(label);
            bandContainer.appendChild(slider);
            eqBandsContainer.appendChild(bandContainer);
        }
    };

    const sendEqSettings = async () => {
        if (!window.electron) return;

        const newBands = {};
        for (const band in eqBands) {
            const slider = document.getElementById(`eq-${band}`);
            newBands[band] = parseInt(slider.value, 10);
        }

        eqEnabled = eqSwitch.checked;

        await window.electron.invoke('music-set-eq', {
            bands: newBands,
            enabled: eqEnabled
        });
    };

    eqSwitch.addEventListener('change', () => {
        if (!eqSwitch._programmaticUpdate) {
            sendEqSettings();
        }
    });

    eqTypeSelect.addEventListener('change', async () => {
        if (!window.electron) return;
        const selectedType = eqTypeSelect.value;
        
        // 显示/隐藏 FIR taps 选择器
        if (selectedType === 'FIR') {
            firTapsSelect.style.display = 'inline-block';
        } else {
            firTapsSelect.style.display = 'none';
        }
        
        // 构建 API 请求参数
        const params = { type: selectedType };
        if (selectedType === 'FIR') {
            params.fir_taps = parseInt(firTapsSelect.value, 10);
        }
        
        const result = await window.electron.invoke('music-set-eq-type', params);
        if (result.status === 'success') {
            updateUIWithState(result.state);
        } else {
            // 恢复到当前有效的 EQ 类型
            console.warn('[Music.js] EQ type change failed:', result.message);
            eqTypeSelect.value = 'IIR';
            firTapsSelect.style.display = 'none';
        }
    });
    
    // FIR taps 变更时重新启用 FIR EQ
    firTapsSelect.addEventListener('change', async () => {
        if (!window.electron) return;
        if (eqTypeSelect.value !== 'FIR') return;
        
        const numTaps = parseInt(firTapsSelect.value, 10);
        const result = await window.electron.invoke('music-set-eq-type', { 
            type: 'FIR', 
            fir_taps: numTaps 
        });
        if (result.status === 'success') {
            console.log('[Music.js] FIR EQ updated to', numTaps, 'taps');
        }
    });

    const updateOptimizations = async () => {
        if (!window.electron) return;
        await window.electron.invoke('music-configure-optimizations', {
            dither_enabled: ditherSwitch.checked
        });
    };

    ditherSwitch.addEventListener('change', () => {
        if (!ditherSwitch._programmaticUpdate) {
            updateOptimizations();
        }
    });
    
    // ReplayGain switch controls NormalizationMode: ON=replaygain_track, OFF=track
    replaygainSwitch.addEventListener('change', () => {
        if (!replaygainSwitch._programmaticUpdate) {
            const newMode = replaygainSwitch.checked ? 'replaygain_track' : 'track';
            // Sync the loudness mode dropdown
            loudnessModeSelect.value = newMode;
            // Update backend
            window.electron.invoke('music-configure-normalization', {
                mode: newMode
            }).catch(e => console.error('[Music.js] Failed to set ReplayGain mode:', e));
        }
    });

    eqPresetSelect.addEventListener('change', (e) => {
        applyEqPreset(e.target.value);
    });

    // --- IR Convolver Logic ---
    const updateIrStatus = (text, state = 'idle') => {
        const statusText = irStatus.querySelector('.ir-status-text');
        statusText.textContent = text;
        irStatus.className = 'ir-status';
        if (state === 'loaded') {
            irStatus.classList.add('loaded');
        } else if (state === 'error') {
            irStatus.classList.add('error');
        }
    };

    const loadIrFile = async (filePath) => {
        if (!window.electron) return;
        updateIrStatus('加载中...', 'idle');
        try {
            const result = await window.electron.invoke('music-load-ir', { path: filePath });
            if (result.status === 'success') {
                irLoadedPath = filePath;
                irEnabled = true;
                irSwitch.checked = true;
                const fileName = filePath.split(/[/\\]/).pop();
                updateIrStatus(`已加载: ${fileName}`, 'loaded');
            } else {
                updateIrStatus(`错误: ${result.message || '加载失败'}`, 'error');
                irEnabled = false;
                irSwitch.checked = false;
            }
        } catch (e) {
            updateIrStatus(`错误: ${e.message}`, 'error');
            irEnabled = false;
            irSwitch.checked = false;
        }
    };

    const unloadIr = async () => {
        if (!window.electron) return;
        try {
            await window.electron.invoke('music-unload-ir');
            irLoadedPath = null;
            irEnabled = false;
            irSwitch.checked = false;
            updateIrStatus('未加载', 'idle');
        } catch (e) {
            console.error('[Music.js] Failed to unload IR:', e);
        }
    };

    irSwitch.addEventListener('change', async () => {
        if (irSwitch.checked) {
            if (!irLoadedPath) {
                // 没有加载 IR，提示用户选择预设或文件
                irSwitch.checked = false;
                irPresetSelect.focus();
                return;
            }
            irEnabled = true;
        } else {
            irEnabled = false;
        }
    });

    irPresetSelect.addEventListener('change', async (e) => {
        const preset = e.target.value;
        
        if (preset === 'custom') {
            // 显示加载按钮，让用户选择文件
            irLoadBtn.style.display = 'flex';
            return;
        } else {
            irLoadBtn.style.display = 'none';
        }
        
        if (preset === '') {
            // 选择了 "-- 选择预设 --"，卸载当前 IR
            await unloadIr();
            return;
        }

        // 内置预设处理（这里可以扩展为内置 IR 文件路径）
        // 目前只有占位符，用户需要自己加载 IR 文件
        updateIrStatus(`预设 "${preset}" 需要加载 IR 文件`, 'idle');
        irLoadBtn.style.display = 'flex';
    });

    irLoadBtn.addEventListener('click', async () => {
        // 使用 Electron 的文件选择对话框
        // 由于 preload.js 没有暴露 dialog API，我们需要通过 IPC 实现
        // 这里使用一个变通方法：触发主进程打开文件对话框
        const result = await window.electron.invoke('select-ir-file');
        if (result && result.filePaths && result.filePaths.length > 0) {
            await loadIrFile(result.filePaths[0]);
        }
    });

    // --- Loudness Normalization Logic ---
    const updateLoudnessSettings = async () => {
        if (!window.electron) return;
        loudnessEnabled = loudnessSwitch.checked;
        loudnessMode = loudnessModeSelect.value;
        targetLufs = parseFloat(loudnessLufsSlider.value);
        loudnessPreampDb = parseFloat(loudnessPreampSlider.value);

        await window.electron.invoke('music-configure-normalization', {
            enabled: loudnessEnabled,
            target_lufs: targetLufs,
            mode: loudnessMode,
            preamp_db: loudnessPreampDb
        });
        
        // Sync ReplayGain switch with loudness mode
        const isRgMode = loudnessMode === 'replaygain_track' || loudnessMode === 'replaygain_album';
        if (replaygainSwitch.checked !== isRgMode) {
            replaygainSwitch._programmaticUpdate = true;
            replaygainSwitch.checked = isRgMode;
            Promise.resolve().then(() => { replaygainSwitch._programmaticUpdate = false; });
        }
        
        saveSettings();
    };

    const updateLoudnessLufsDisplay = () => {
        loudnessLufsValue.textContent = loudnessLufsSlider.value;
    };

    const updateLoudnessPreampDisplay = () => {
        const val = parseFloat(loudnessPreampSlider.value);
        loudnessPreampValue.textContent = (val >= 0 ? '+' : '') + val + ' dB';
    };

    const fetchLoudnessInfo = async () => {
        if (!window.electron) return;
        try {
            const result = await window.electron.invoke('music-get-loudness-info');
            if (result && result.status === 'success' && result.info) {
                const info = result.info;
                if (info.track_loudness !== undefined && info.track_loudness !== null) {
                    loudnessInfo.style.display = 'block';
                    loudnessCurrentLufs.textContent = info.track_loudness.toFixed(1);
                } else {
                    loudnessInfo.style.display = 'none';
                }
            }
        } catch (e) {
            console.error('[Music.js] Failed to fetch loudness info:', e);
        }
    };

    loudnessSwitch.addEventListener('change', () => {
        // Ignore change events triggered by programmatic updates
        if (loudnessSwitch._programmaticUpdate) {
            return;
        }
        updateLoudnessSettings();
    });
    loudnessModeSelect.addEventListener('change', updateLoudnessSettings);
    loudnessLufsSlider.addEventListener('input', () => {
        updateLoudnessLufsDisplay();
    });
    loudnessLufsSlider.addEventListener('change', updateLoudnessSettings);
    loudnessPreampSlider.addEventListener('input', () => {
        updateLoudnessPreampDisplay();
    });
    loudnessPreampSlider.addEventListener('change', updateLoudnessSettings);

    // --- Saturation Effect Logic ---
    const updateSaturationSettings = async () => {
        if (!window.electron) return;
        saturationEnabled = saturationSwitch.checked;
        saturationType = saturationTypeSelect.value;
        saturationDrive = parseFloat(saturationDriveSlider.value) / 100;
        saturationMix = parseFloat(saturationMixSlider.value) / 100;

        await window.electron.invoke('music-set-saturation', {
            enabled: saturationEnabled,
            drive: saturationDrive,
            mix: saturationMix
        });
        
        saveSettings();
    };

    const updateSaturationDriveDisplay = () => {
        saturationDriveValue.textContent = saturationDriveSlider.value + '%';
    };

    const updateSaturationMixDisplay = () => {
        saturationMixValue.textContent = saturationMixSlider.value + '%';
    };

    saturationSwitch.addEventListener('change', () => {
        if (!saturationSwitch._programmaticUpdate) {
            updateSaturationSettings();
        }
    });
    saturationTypeSelect.addEventListener('change', updateSaturationSettings);
    saturationDriveSlider.addEventListener('input', () => {
        updateSaturationDriveDisplay();
    });
    saturationDriveSlider.addEventListener('change', updateSaturationSettings);
    saturationMixSlider.addEventListener('input', () => {
        updateSaturationMixDisplay();
    });
    saturationMixSlider.addEventListener('change', updateSaturationSettings);

    // --- Crossfeed Logic ---
    const updateCrossfeedSettings = async () => {
        if (!window.electron) return;
        crossfeedEnabled = crossfeedSwitch.checked;
        crossfeedMix = parseFloat(crossfeedMixSlider.value) / 100;

        await window.electron.invoke('music-set-crossfeed', {
            enabled: crossfeedEnabled,
            mix: crossfeedMix
        });
        
        saveSettings();
    };

    const updateCrossfeedMixDisplay = () => {
        crossfeedMixValue.textContent = crossfeedMixSlider.value + '%';
    };

    crossfeedSwitch.addEventListener('change', () => {
        if (!crossfeedSwitch._programmaticUpdate) {
            updateCrossfeedSettings();
        }
    });
    crossfeedMixSlider.addEventListener('input', () => {
        updateCrossfeedMixDisplay();
    });
    crossfeedMixSlider.addEventListener('change', updateCrossfeedSettings);

    // --- Dynamic Loudness Logic ---
    const updateDynamicLoudnessSettings = async () => {
        if (!window.electron) return;
        dynamicLoudnessEnabled = dynamicLoudnessSwitch.checked;
        dynamicLoudnessStrength = parseFloat(dynamicLoudnessStrengthSlider.value) / 100;

        await window.electron.invoke('music-set-dynamic-loudness', {
            enabled: dynamicLoudnessEnabled,
            strength: dynamicLoudnessStrength
        });
        
        saveSettings();
    };

    const updateDynamicLoudnessStrengthDisplay = () => {
        dynamicLoudnessStrengthValue.textContent = dynamicLoudnessStrengthSlider.value + '%';
    };

    dynamicLoudnessSwitch.addEventListener('change', () => {
        if (!dynamicLoudnessSwitch._programmaticUpdate) {
            updateDynamicLoudnessSettings();
        }
    });
    dynamicLoudnessStrengthSlider.addEventListener('input', () => {
        updateDynamicLoudnessStrengthDisplay();
    });
    dynamicLoudnessStrengthSlider.addEventListener('change', updateDynamicLoudnessSettings);

    // --- Noise Shaper Logic ---
    const updateNoiseShaperSettings = async () => {
        if (!window.electron) return;
        outputBits = parseInt(outputBitsSelect.value, 10);
        noiseShaperCurve = noiseShaperCurveSelect.value;

        await window.electron.invoke('music-configure-output-bits', { bits: outputBits });
        await window.electron.invoke('music-set-noise-shaper-curve', { curve: noiseShaperCurve });
    };

    outputBitsSelect.addEventListener('change', updateNoiseShaperSettings);
    noiseShaperCurveSelect.addEventListener('change', updateNoiseShaperSettings);

    // --- WebDAV State ---
    let webdavServers = [];       // [{ id, name, url, username, password }]
    let activeWebDavServer = null; // currently selected server
    let webdavCurrentPath = '/';  // current browse path
    let webdavScannedTracks = []; // tracks found by scan

    // --- WebDAV DOM Elements ---
    const addWebDavBtn = document.getElementById('add-webdav-btn');
    const webdavModal = document.getElementById('webdav-modal');
    const webdavModalClose = document.getElementById('webdav-modal-close');
    const webdavServerList = document.getElementById('webdav-server-list');
    const webdavAddServerBtn = document.getElementById('webdav-add-server-btn');
    const webdavBreadcrumb = document.getElementById('webdav-breadcrumb');
    const webdavFileList = document.getElementById('webdav-file-list');
    const webdavScanBtn = document.getElementById('webdav-scan-btn');
    const webdavImportBtn = document.getElementById('webdav-import-btn');
    const webdavServerDialog = document.getElementById('webdav-server-dialog');
    const webdavDialogCancel = document.getElementById('webdav-dialog-cancel');
    const webdavDialogTest = document.getElementById('webdav-dialog-test');
    const webdavDialogConfirm = document.getElementById('webdav-dialog-confirm');
    const webdavDialogStatus = document.getElementById('webdav-dialog-status');

    // --- WebDAV Logic ---
    const openWebDavModal = async () => {
        webdavModal.classList.add('active');
        if (!window.electron) return;
        webdavServers = await window.electron.invoke('webdav-list-servers') || [];
        renderWebDavServerList();
        if (activeWebDavServer) browseWebDav(webdavCurrentPath);
    };

    const closeWebDavModal = () => {
        webdavModal.classList.remove('active');
    };

    const renderWebDavServerList = () => {
        webdavServerList.innerHTML = '';
        if (webdavServers.length === 0) {
            webdavServerList.innerHTML = '<div class="no-lyrics" style="padding:12px;font-size:12px;">暂无服务器</div>';
            return;
        }
        webdavServers.forEach(server => {
            const div = document.createElement('div');
            div.className = 'webdav-server-item' + (activeWebDavServer && activeWebDavServer.id === server.id ? ' active' : '');
            div.innerHTML = `<span class="webdav-server-name">${server.name}</span><button class="webdav-server-remove" data-id="${server.id}" title="删除">✕</button>`;
            div.querySelector('.webdav-server-name').addEventListener('click', () => {
                activeWebDavServer = server;
                webdavCurrentPath = '/';
                webdavScannedTracks = [];
                webdavScanBtn.disabled = false;
                webdavImportBtn.disabled = true;
                renderWebDavServerList();
                browseWebDav('/');
            });
            div.querySelector('.webdav-server-remove').addEventListener('click', async (e) => {
                e.stopPropagation();
                await window.electron.invoke('webdav-remove-server', { id: server.id });
                if (activeWebDavServer && activeWebDavServer.id === server.id) {
                    activeWebDavServer = null;
                    webdavFileList.innerHTML = '<div class="no-lyrics" style="padding:20px;">请先选择或添加一个 WebDAV 服务器</div>';
                    webdavBreadcrumb.innerHTML = '';
                    webdavScanBtn.disabled = true;
                    webdavImportBtn.disabled = true;
                }
                webdavServers = webdavServers.filter(s => s.id !== server.id);
                renderWebDavServerList();
            });
            webdavServerList.appendChild(div);
        });
    };

    const browseWebDav = async (dirPath) => {
        if (!activeWebDavServer) return;
        webdavFileList.innerHTML = '<div class="no-lyrics" style="padding:20px;">加载中...</div>';
        webdavCurrentPath = dirPath;
        renderWebDavBreadcrumb(dirPath);
        const result = await window.electron.invoke('webdav-list-directory', {
            serverId: activeWebDavServer.id,
            url: activeWebDavServer.url,
            path: dirPath
        });
        if (!result || result.status !== 'success') {
            webdavFileList.innerHTML = `<div class="no-lyrics" style="padding:20px;">错误: ${result ? result.message : '未知错误'}</div>`;
            return;
        }
        // Filter out the current directory itself
        const entries = result.entries.filter(e => {
            const ePath = decodeURIComponent(e.href.replace(/\/$/, ''));
            const cPath = dirPath.replace(/\/$/, '');
            return !ePath.endsWith(cPath) || e.isDir && e.href !== dirPath;
        });
        if (entries.length === 0) {
            webdavFileList.innerHTML = '<div class="no-lyrics" style="padding:20px;">此目录为空</div>';
            return;
        }
        const AUDIO_EXTS = new Set(['.mp3','.flac','.wav','.ogg','.m4a','.aac','.opus','.wv','.ape']);
        webdavFileList.innerHTML = '';
        const frag = document.createDocumentFragment();
        entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
        entries.forEach(entry => {
            const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop().toLowerCase() : '';
            const isAudio = !entry.isDir && AUDIO_EXTS.has(ext);
            const div = document.createElement('div');
            div.className = 'webdav-file-item' + (entry.isDir ? ' is-dir' : '') + (isAudio ? ' is-audio' : '');
            div.innerHTML = `<span class="webdav-file-icon">${entry.isDir ? '📁' : (isAudio ? '🎵' : '📄')}</span><span class="webdav-file-name">${entry.name}</span>`;
            if (entry.isDir) {
                div.addEventListener('dblclick', () => {
                    const href = entry.href.replace(/\/$/, '');
                    const base = activeWebDavServer.url.replace(/\/$/, '');
                    const originMatch = base.match(/^https?:\/\/[^\/]+/);
                    const origin = originMatch ? originMatch[0] : base;
                    let newPath = href.replace(origin, '');
                    if (!newPath.startsWith('/')) newPath = '/' + newPath;
                    browseWebDav(newPath);
                });
            } else if (isAudio) {
                div.addEventListener('dblclick', () => playWebDavTrack(entry));
                div.title = '双击播放';
            }
            frag.appendChild(div);
        });
        webdavFileList.appendChild(frag);
    };

    const renderWebDavBreadcrumb = (dirPath) => {
        webdavBreadcrumb.innerHTML = '';
        const parts = dirPath.replace(/^\/$/, '').split('/').filter(Boolean);
        const rootSpan = document.createElement('span');
        rootSpan.className = 'webdav-crumb';
        rootSpan.textContent = activeWebDavServer ? activeWebDavServer.name : '根目录';
        rootSpan.addEventListener('click', () => browseWebDav('/'));
        webdavBreadcrumb.appendChild(rootSpan);
        let cumPath = '';
        parts.forEach((part, i) => {
            cumPath += '/' + part;
            const sep = document.createElement('span');
            sep.textContent = ' / ';
            sep.style.opacity = '0.5';
            webdavBreadcrumb.appendChild(sep);
            const span = document.createElement('span');
            span.className = 'webdav-crumb';
            span.textContent = decodeURIComponent(part);
            const snapPath = cumPath;
            span.addEventListener('click', () => browseWebDav(snapPath));
            webdavBreadcrumb.appendChild(span);
        });
    };

    const playWebDavTrack = async (entry) => {
        if (!activeWebDavServer || !window.electron) return;
        const track = {
            title: entry.name.replace(/\.[^.]+$/, ''),
            artist: '',
            album: '',
            path: entry.url,
            isRemote: true,
            serverId: activeWebDavServer.id
        };
        if (!playlist.some(t => t.path === track.path)) playlist.push(track);
        const idx = playlist.findIndex(t => t.path === track.path);
        // Pass serverId to let backend retrieve credentials securely
        await window.electron.invoke('webdav-load-track', {
            url: entry.url,
            serverId: activeWebDavServer.id,
            trackMeta: {
                title: track.title,
                artist: track.artist,
                album: track.album
            }
        });
        currentTrackIndex = idx;
        trackTitle.textContent = track.title;
        trackArtist.textContent = track.artist || '未知艺术家';
        trackBitrate.textContent = '';
        renderPlaylist(currentFilteredTracks);
        playTrack();
    };

    const setupWebDavHandlers = () => {
        console.log('[WebDAV] setupWebDavHandlers called, electron:', !!window.electron);
        console.log('[WebDAV] DOM elements - webdavScanBtn:', !!webdavScanBtn, 'webdavImportBtn:', !!webdavImportBtn);
        if (!window.electron) return;

        addWebDavBtn?.addEventListener('click', openWebDavModal);
        webdavModalClose?.addEventListener('click', closeWebDavModal);
        webdavModal?.addEventListener('click', (e) => { if (e.target === webdavModal) closeWebDavModal(); });

        webdavAddServerBtn?.addEventListener('click', () => {
            document.getElementById('webdav-server-name').value = '';
            document.getElementById('webdav-server-url').value = '';
            document.getElementById('webdav-server-username').value = '';
            document.getElementById('webdav-server-password').value = '';
            webdavDialogStatus.textContent = '';
            webdavServerDialog.classList.add('active');
        });

        webdavDialogCancel?.addEventListener('click', () => webdavServerDialog.classList.remove('active'));
        webdavServerDialog?.addEventListener('click', (e) => { if (e.target === webdavServerDialog) webdavServerDialog.classList.remove('active'); });

        webdavDialogTest?.addEventListener('click', async () => {
            const url = document.getElementById('webdav-server-url').value.trim();
            const username = document.getElementById('webdav-server-username').value.trim();
            const password = document.getElementById('webdav-server-password').value;
            if (!url) { webdavDialogStatus.textContent = '请输入 URL'; return; }
            webdavDialogStatus.textContent = '测试中...';
            const result = await window.electron.invoke('webdav-test-connection', { url, username, password });
            webdavDialogStatus.style.color = result.status === 'success' ? 'var(--music-highlight)' : '#e55';
            webdavDialogStatus.textContent = result.message;
        });

        webdavDialogConfirm?.addEventListener('click', async () => {
            const name = document.getElementById('webdav-server-name').value.trim();
            const url = document.getElementById('webdav-server-url').value.trim();
            const username = document.getElementById('webdav-server-username').value.trim();
            const password = document.getElementById('webdav-server-password').value;
            if (!name || !url) { webdavDialogStatus.textContent = '名称和 URL 不能为空'; return; }
            const server = await window.electron.invoke('webdav-add-server', { name, url, username, password });
            webdavServers.push(server);
            webdavServerDialog.classList.remove('active');
            renderWebDavServerList();
        });

        webdavScanBtn?.addEventListener('click', async () => {
            console.log('[WebDAV] Scan button clicked, activeServer:', activeWebDavServer?.id);
            if (!activeWebDavServer) {
                alert('请先选择一个服务器');
                return;
            }
            webdavScanBtn.disabled = true;
            webdavScanBtn.textContent = '扫描中...';
            window.electron.on('webdav-scan-progress', ({ count }) => {
                webdavScanBtn.textContent = `已找到 ${count} 首...`;
            });
            
            console.log('[WebDAV] Calling webdav-scan-audio with:', { serverId: activeWebDavServer.id, url: activeWebDavServer.url });
            let result;
            try {
                result = await window.electron.invoke('webdav-scan-audio', {
                    serverId: activeWebDavServer.id,
                    url: activeWebDavServer.url
                });
                console.log('[WebDAV] Scan result received:', result);
            } catch (err) {
                console.error('[WebDAV] Scan error:', err);
                alert('扫描出错: ' + err.message);
                webdavScanBtn.textContent = '扫描全部音频';
                webdavScanBtn.disabled = false;
                return;
            }
            
            webdavScanBtn.textContent = '扫描全部音频';
            webdavScanBtn.disabled = false;
            console.log('[WebDAV] Scan complete, result:', result?.status, 'tracks:', result?.tracks?.length);
            if (result && result.status === 'success') {
                webdavScannedTracks = result.tracks || [];
                console.log('[WebDAV] webdavScannedTracks set to:', webdavScannedTracks.length);
                webdavImportBtn.disabled = webdavScannedTracks.length === 0;
                webdavImportBtn.textContent = `导入 ${webdavScannedTracks.length} 首到全部`;
                if (webdavScannedTracks.length === 0) {
                    alert('未找到音频文件');
                }
            } else {
                alert('扫描失败: ' + (result?.message || '未知错误'));
            }
        });

        webdavImportBtn?.addEventListener('click', () => {
            console.log('[WebDAV] Import button clicked');
            console.log('[WebDAV] webdavScannedTracks.length:', webdavScannedTracks.length);
            console.log('[WebDAV] activeWebDavServer:', activeWebDavServer?.id);
            console.log('[WebDAV] playlist.length:', playlist.length);
            
            if (webdavScannedTracks.length === 0) {
                alert('请先扫描音频文件');
                return;
            }
            
            // 辅助函数：提取文件名（不含扩展名）用于比较
            const getTrackName = (track) => {
                const title = track.title || track.name || '';
                if (title) return title.toLowerCase().trim();
                // 从路径提取文件名
                const path = track.path || '';
                const filename = path.split('/').pop().split('\\').pop();
                return filename.replace(/\.[^.]+$/, '').toLowerCase().trim();
            };
            
            // 为每个曲目添加 serverId
            const tracksWithServerId = webdavScannedTracks.map(t => ({
                ...t,
                serverId: activeWebDavServer.id,
                isRemote: true
            }));
            
            // 智能去重：基于标题比较，云端和本地相同时优先保留本地
            const newTracks = tracksWithServerId.filter(remoteTrack => {
                const remoteName = getTrackName(remoteTrack);
                // 检查播放列表中是否已有相同曲目
                const existingIndex = playlist.findIndex(p => {
                    const existingName = getTrackName(p);
                    return existingName === remoteName;
                });
                
                if (existingIndex === -1) {
                    // 没有重复，直接添加
                    return true;
                }
                
                // 有重复，检查是否是本地版本
                const existing = playlist[existingIndex];
                if (!existing.isRemote && !existing.path.startsWith('http')) {
                    // 已有本地版本，跳过云端版本
                    console.log(`[WebDAV] 跳过云端重复曲目（已有本地版本）: ${remoteName}`);
                    return false;
                }
                
                // 已有云端版本或路径重复，也跳过
                return false;
            });
            
            playlist.push(...newTracks);
            // 重置筛选以显示所有曲目（包括新导入的）
            currentFilteredTracks = null;
            renderPlaylist(null);
            window.electron.send('save-music-playlist', playlist);
            webdavImportBtn.textContent = `已导入 ${newTracks.length} 首到全部`;
            webdavImportBtn.disabled = true;
            closeWebDavModal();
        });
    };

    // --- Electron IPC and Initialization ---
    const setupElectronHandlers = () => {
        if (!window.electron) return;

        addFolderBtn.addEventListener('click', () => {
            loadingIndicator.style.display = 'flex';
            scanProgressContainer.style.display = 'none';
            scanProgressBar.style.width = '0%';
            scanProgressLabel.textContent = '';
            window.electron.send('open-music-folder');
        });

        let totalFilesToScan = 0, filesScanned = 0;
        window.electron.on('scan-started', ({ total }) => {
            totalFilesToScan = total;
            filesScanned = 0;
            scanProgressContainer.style.display = 'block';
            scanProgressLabel.textContent = `0 / ${totalFilesToScan}`;
        });

        window.electron.on('scan-progress', () => {
            filesScanned++;
            const percentage = totalFilesToScan > 0 ? (filesScanned / totalFilesToScan) * 100 : 0;
            scanProgressBar.style.width = `${percentage}%`;
            scanProgressLabel.textContent = `${filesScanned} / ${totalFilesToScan}`;
        });

        window.electron.on('scan-finished', (newlyScannedFiles) => {
            loadingIndicator.style.display = 'none';
            // Only update playlist if new files were actually scanned.
            // This prevents clearing the list if the user cancels the folder selection.
            if (newlyScannedFiles && newlyScannedFiles.length > 0) {
                playlist = newlyScannedFiles;
                renderPlaylist();
                window.electron.send('save-music-playlist', playlist);
                if (playlist.length > 0) {
                    loadTrack(0, false); // Load first track but don't play
                }
            }
            // If newlyScannedFiles is empty or null, do nothing, preserving the old playlist.
        });

        // Listen for errors from the main process (e.g., engine connection failed)
        window.electron.on('audio-engine-error', ({ message }) => {
            console.error("Received error from main process:", message);
            // You can display this error to the user, e.g., in a toast notification
        });

        // Listen for track changes from the main process (e.g., from AI control)
        window.electron.on('music-set-track', (track) => {
            if (!playlist.some(t => t.path === track.path)) {
                playlist.unshift(track); // Add to playlist if not already there
            }
            const trackIndex = playlist.findIndex(t => t.path === track.path);
            if (trackIndex !== -1) {
                shuffleQueue = []; // Reset shuffle on external track change
                loadTrack(trackIndex, true); // Load and play the track
            }
        });
    };

    const renderPlaylist = (filteredPlaylist) => {
        const songsToRender = filteredPlaylist || playlist;
        playlistEl.innerHTML = '';
        const fragment = document.createDocumentFragment();
        songsToRender.forEach((track) => {
            const li = document.createElement('li');
            li.textContent = track.title || '未知标题';
            const originalIndex = playlist.indexOf(track);
            li.dataset.index = originalIndex;
            if (originalIndex === currentTrackIndex) {
                li.classList.add('active');
            }
            fragment.appendChild(li);
        });
        playlistEl.appendChild(fragment);
        updateAllCount();
    };

    // --- Lyrics Handling ---
    const fetchAndDisplayLyrics = async (artist, title) => {
        const requestToken = ++lyricsRequestToken;
        resetLyrics();
        if (!window.electron) return;

        const lrcContent = await window.electron.invoke('music-get-lyrics', { artist, title });
        if (requestToken !== lyricsRequestToken) {
            return;
        }

        if (lrcContent) {
            currentLyrics = parseLrc(lrcContent);
            renderLyrics();
        } else {
            // If no local lyrics, try fetching from network
            lyricsList.innerHTML = '<li class="no-lyrics">正在网络上搜索歌词...</li>';
            try {
                const fetchedLrc = await window.electron.invoke('music-fetch-lyrics', { artist, title });
                if (requestToken !== lyricsRequestToken) {
                    return;
                }
                if (fetchedLrc) {
                    currentLyrics = parseLrc(fetchedLrc);
                    renderLyrics();
                } else {
                    lyricsList.innerHTML = '<li class="no-lyrics">暂无歌词</li>';
                }
            } catch (error) {
                if (requestToken !== lyricsRequestToken) {
                    return;
                }
                console.error('Failed to fetch lyrics from network:', error);
                lyricsList.innerHTML = '<li class="no-lyrics">歌词获取失败</li>';
            }
        }
    };

    const parseLrc = (lrcContent) => {
        const lyricsMap = new Map();
        const lines = lrcContent.split('\n');
        const timeRegex = /\[(\d{2}):(\d{2})[.:](\d{2,3})\]/g;

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            const text = trimmedLine.replace(timeRegex, '').trim();
            if (text) {
                let match;
                timeRegex.lastIndex = 0;
                while ((match = timeRegex.exec(trimmedLine)) !== null) {
                    const minutes = parseInt(match[1], 10);
                    const seconds = parseInt(match[2], 10);
                    const milliseconds = parseInt(match[3].padEnd(3, '0'), 10);
                    const time = (minutes * 60 + seconds + milliseconds / 1000) * lyricSpeedFactor + lyricOffset;

                    const timeKey = time.toFixed(4); // Use fixed precision for map key

                    if (lyricsMap.has(timeKey)) {
                        // This is likely the translation, append it.
                        // This simple logic assumes original text comes before translation for the same timestamp.
                        if (!lyricsMap.get(timeKey).translation) {
                            lyricsMap.get(timeKey).translation = text;
                        }
                    } else {
                        // This is the original lyric
                        lyricsMap.set(timeKey, { time, original: text, translation: '' });
                    }
                }
            }
        }

        return Array.from(lyricsMap.values()).sort((a, b) => a.time - b.time);
    };

    const renderLyrics = () => {
        lyricsList.innerHTML = '';
        const fragment = document.createDocumentFragment();
        currentLyrics.forEach((line, index) => {
            const li = document.createElement('li');

            const originalSpan = document.createElement('span');
            originalSpan.textContent = line.original;
            originalSpan.className = 'lyric-original';
            li.appendChild(originalSpan);

            if (line.translation) {
                const translationSpan = document.createElement('span');
                translationSpan.textContent = line.translation;
                translationSpan.className = 'lyric-translation';
                li.appendChild(translationSpan);
            }

            li.dataset.index = index;
            fragment.appendChild(li);
        });
        lyricsList.appendChild(fragment);
    };

    const animateLyrics = () => {
        if (currentLyrics.length === 0 || !isPlaying) return;

        // Re-introduce client-side time estimation for smooth scrolling, anchored by backend state.
        const elapsedTime = (Date.now() - lastStateUpdateTime) / 1000;
        const estimatedTime = lastKnownCurrentTime + elapsedTime;

        let newLyricIndex = -1;
        for (let i = 0; i < currentLyrics.length; i++) {
            if (estimatedTime >= currentLyrics[i].time) {
                newLyricIndex = i;
            } else {
                break;
            }
        }

        if (newLyricIndex !== currentLyricIndex) {
            currentLyricIndex = newLyricIndex;
        }

        // Update visual styles (like opacity) on every frame for smoothness.
        const allLi = lyricsList.querySelectorAll('li');
        allLi.forEach((li, index) => {
            const distance = Math.abs(index - currentLyricIndex);

            if (index === currentLyricIndex) {
                li.classList.add('active');
                li.style.opacity = 1;
            } else {
                li.classList.remove('active');
                li.style.opacity = Math.max(0.1, 1 - distance * 0.22).toFixed(2);
            }
        });

        // Smooth scrolling logic
        if (currentLyricIndex > -1) {
            const currentLine = currentLyrics[currentLyricIndex];
            const nextLine = currentLyrics[currentLyricIndex + 1];

            const currentLineLi = lyricsList.querySelector(`li[data-index='${currentLyricIndex}']`);
            if (!currentLineLi) return;

            let progress = 0;
            if (nextLine) {
                const timeIntoLine = estimatedTime - currentLine.time;
                const lineDuration = nextLine.time - currentLine.time;
                if (lineDuration > 0) {
                    progress = Math.max(0, Math.min(1, timeIntoLine / lineDuration));
                }
            }

            const nextLineLi = nextLine ? lyricsList.querySelector(`li[data-index='${currentLyricIndex + 1}']`) : null;
            const currentOffset = currentLineLi.offsetTop;
            const nextOffset = nextLineLi ? nextLineLi.offsetTop : currentOffset;

            const interpolatedOffset = currentOffset + (nextOffset - currentOffset) * progress;

            const goldenRatioPoint = lyricsContainer.clientHeight * 0.382;
            const scrollOffset = interpolatedOffset - goldenRatioPoint + (currentLineLi.clientHeight / 2);

            lyricsList.style.transform = `translateY(-${scrollOffset}px)`;
        }
    };

    const resetLyrics = () => {
        currentLyrics = [];
        currentLyricIndex = -1;
        lyricsList.innerHTML = '<li class="no-lyrics">加载歌词中...</li>';
        lyricsList.style.transform = 'translateY(0px)';
    };

    // --- Theme Handling ---
    const applyTheme = (theme) => {
        currentTheme = theme;
        document.body.classList.toggle('light-theme', theme === 'light');
        // Use requestAnimationFrame to wait for the styles to be applied
        requestAnimationFrame(() => {
            // A second frame might be needed for variables to be fully available
            requestAnimationFrame(() => {
                const highlightColor = getComputedStyle(document.body).getPropertyValue('--music-highlight');
                const rgbColor = hexToRgb(highlightColor);
                if (rgbColor) {
                    visualizerColor = rgbColor;
                }
                // Also re-apply volume slider background as it depends on a theme variable
                updateVolumeSliderBackground(volumeSlider.value);
            });
        });
        const currentArt = albumArt.style.backgroundImage;
        if (!currentArt || currentArt.includes('musicdark.jpeg') || currentArt.includes('musiclight.jpeg')) {
            const defaultArtUrl = `url('../assets/${theme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
            albumArt.style.backgroundImage = defaultArtUrl;
            updateBlurredBackground(defaultArtUrl);
        }
    };

    const initializeTheme = async () => {
        if (window.electronAPI) {
            // Use the new robust theme listener
            window.electronAPI.onThemeUpdated(applyTheme);
            try {
                const theme = await window.electronAPI.getCurrentTheme();
                applyTheme(theme || 'dark');
            } catch (error) {
                console.error('Failed to initialize theme:', error);
                applyTheme('dark');
            }
        } else {
            applyTheme('dark'); // Fallback for non-electron env
        }
    };

    // --- Phantom Audio Generation ---
    const createSilentAudio = () => {
        const context = new (window.AudioContext || window.webkitAudioContext)();
        const sampleRate = 44100;
        const duration = 60; // 60秒足够，且不会导致启动卡顿
        const frameCount = sampleRate * duration;
        const buffer = context.createBuffer(1, frameCount, sampleRate);
        // The buffer is already filled with zeros (silence)

        // Convert buffer to WAV
        const getWav = (buffer) => {
            const numChannels = buffer.numberOfChannels;
            const sampleRate = buffer.sampleRate;
            const format = 1; // PCM
            const bitDepth = 16;
            const blockAlign = numChannels * bitDepth / 8;
            const byteRate = sampleRate * blockAlign;
            const dataSize = buffer.length * numChannels * bitDepth / 8;
            const bufferSize = 44 + dataSize;

            const view = new DataView(new ArrayBuffer(bufferSize));
            let offset = 0;

            const writeString = (str) => {
                for (let i = 0; i < str.length; i++) {
                    view.setUint8(offset++, str.charCodeAt(i));
                }
            };

            writeString('RIFF');
            view.setUint32(offset, 36 + dataSize, true); offset += 4;
            writeString('WAVE');
            writeString('fmt ');
            view.setUint32(offset, 16, true); offset += 4;
            view.setUint16(offset, format, true); offset += 2;
            view.setUint16(offset, numChannels, true); offset += 2;
            view.setUint32(offset, sampleRate, true); offset += 4;
            view.setUint32(offset, byteRate, true); offset += 4;
            view.setUint16(offset, blockAlign, true); offset += 2;
            view.setUint16(offset, bitDepth, true); offset += 2;
            writeString('data');
            view.setUint32(offset, dataSize, true); offset += 4;

            const pcm = new Int16Array(buffer.length);
            // Buffer is already silent, no need to loop and fill from channelData
            for (let i = 0; i < pcm.length; i++, offset += 2) {
                view.setInt16(offset, pcm[i], true);
            }

            return view.buffer;
        };

        const wavBuffer = getWav(buffer);
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        return URL.createObjectURL(blob);
    };

    // ===== SIDEBAR FUNCTIONALITY =====

    // --- Custom Playlist Persistence ---
    const loadCustomPlaylists = async () => {
        if (window.electron) {
            customPlaylists = await window.electron.invoke('get-custom-playlists') || [];
        }
    };

    const saveCustomPlaylists = () => {
        if (window.electron) {
            window.electron.send('save-custom-playlists', customPlaylists);
        }
    };

    // --- Grouping Functions ---
    const getAlbumGroups = () => {
        const albums = {};
        playlist.forEach(track => {
            const albumName = track.album || '未知专辑';
            if (!albums[albumName]) {
                albums[albumName] = { name: albumName, art: track.albumArt, tracks: [] };
            }
            albums[albumName].tracks.push(track);
        });
        return Object.values(albums).sort((a, b) => b.tracks.length - a.tracks.length);
    };

    const getArtistGroups = () => {
        const artists = {};
        playlist.forEach(track => {
            const artistName = track.artist || '未知艺术家';
            if (!artists[artistName]) {
                artists[artistName] = { name: artistName, art: track.albumArt, tracks: [] };
            }
            artists[artistName].tracks.push(track);
        });
        return Object.values(artists).sort((a, b) => b.tracks.length - a.tracks.length);
    };

    // --- Update Song Count ---
    const updateAllCount = () => {
        const allCountEl = document.getElementById('all-count');
        if (allCountEl) {
            allCountEl.textContent = playlist.length;
        }
    };

    // --- Sidebar Rendering ---
    const renderSidebarContent = (view) => {
        currentSidebarView = view;
        sidebarFooter.style.display = view === 'playlists' ? 'block' : 'none';
        
        const playlistEl = document.getElementById('playlist');
        const categoryView = document.getElementById('sidebar-category-view');

        if (view === 'all') {
            filteredPlaylistSource = null;
            currentFilteredTracks = null;
            if (playlistEl) playlistEl.style.display = 'block';
            if (categoryView) categoryView.style.display = 'none';
            renderPlaylist();
            updateAllCount();
        } else if (view === 'albums') {
            if (playlistEl) playlistEl.style.display = 'none';
            if (categoryView) {
                categoryView.style.display = 'block';
                const albums = getAlbumGroups();
                categoryView.innerHTML = '';
                albums.forEach(album => {
                    const div = document.createElement('div');
                    div.className = 'category-item';
                    div.innerHTML = `
                        <div class="cover" style="${album.art ? `background-image: url('file://${album.art.replace(/\\/g, '/')}')` : ''}"></div>
                        <div class="info">
                            <div class="name">${album.name}</div>
                            <div class="count">${album.tracks.length} 首</div>
                        </div>
                    `;
                    div.addEventListener('click', () => {
                        filteredPlaylistSource = { type: 'album', name: album.name };
                        currentFilteredTracks = album.tracks;
                        if (playlistEl) playlistEl.style.display = 'block';
                        if (categoryView) categoryView.style.display = 'none';
                        renderPlaylist(album.tracks);
                        document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
                        document.querySelector('.sidebar-tab[data-view="all"]').classList.add('active');
                        currentSidebarView = 'all';
                    });
                    categoryView.appendChild(div);
                });
            }
        } else if (view === 'artists') {
            if (playlistEl) playlistEl.style.display = 'none';
            if (categoryView) {
                categoryView.style.display = 'block';
                const artists = getArtistGroups();
                categoryView.innerHTML = '';
                artists.forEach(artist => {
                    const div = document.createElement('div');
                    div.className = 'category-item';
                    div.innerHTML = `
                        <div class="cover artist-avatar" style="${artist.art ? `background-image: url('file://${artist.art.replace(/\\/g, '/')}')` : ''}"></div>
                        <div class="info">
                            <div class="name">${artist.name}</div>
                            <div class="count">${artist.tracks.length} 首</div>
                        </div>
                    `;
                    div.addEventListener('click', () => {
                        filteredPlaylistSource = { type: 'artist', name: artist.name };
                        currentFilteredTracks = artist.tracks;
                        if (playlistEl) playlistEl.style.display = 'block';
                        if (categoryView) categoryView.style.display = 'none';
                        renderPlaylist(artist.tracks);
                        document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
                        document.querySelector('.sidebar-tab[data-view="all"]').classList.add('active');
                        currentSidebarView = 'all';
                    });
                    categoryView.appendChild(div);
                });
            }
        } else if (view === 'playlists') {
            if (playlistEl) playlistEl.style.display = 'none';
            if (categoryView) {
                categoryView.style.display = 'block';
                categoryView.innerHTML = '';
                customPlaylists.forEach(pl => {
                    const div = document.createElement('div');
                    div.className = 'category-item';
                    div.innerHTML = `
                        <div class="cover" style="display:flex;align-items:center;justify-content:center;font-size:1.2em;">📁</div>
                        <div class="info">
                            <div class="name">${pl.name}</div>
                            <div class="count">${pl.tracks.length} 首</div>
                        </div>
                        <button class="edit-btn" title="编辑歌单">✎</button>
                        <button class="delete-btn" title="删除歌单">✕</button>
                    `;
                    div.querySelector('.edit-btn').addEventListener('click', (e) => {
                        e.stopPropagation();
                        openPlaylistEditModal(pl.id);
                    });
                    div.querySelector('.delete-btn').addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (confirm(`确定删除歌单 "${pl.name}" 吗？`)) {
                            customPlaylists = customPlaylists.filter(p => p.id !== pl.id);
                            saveCustomPlaylists();
                            renderSidebarContent('playlists');
                        }
                    });
                    div.addEventListener('click', () => {
                        filteredPlaylistSource = { type: 'playlist', name: pl.name, id: pl.id };
                        const tracks = pl.tracks.map(path => playlist.find(t => t.path === path)).filter(Boolean);
                        currentFilteredTracks = tracks;
                        if (playlistEl) playlistEl.style.display = 'block';
                        if (categoryView) categoryView.style.display = 'none';
                        renderPlaylist(tracks);
                        document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
                        document.querySelector('.sidebar-tab[data-view="all"]').classList.add('active');
                        currentSidebarView = 'all';
                    });
                    categoryView.appendChild(div);
                });
                if (customPlaylists.length === 0) {
                    categoryView.innerHTML = '<div class="sidebar-stats">暂无歌单<br>点击下方按钮创建</div>';
                }
            }
        }
    };

    // --- Sidebar Tab Events ---
    const setupSidebarTabs = () => {
        sidebarTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                sidebarTabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                renderSidebarContent(tab.dataset.view);
            });
        });
    };

    // --- Accordion Setup (Deprecated) ---
    const setupAccordion = () => {
        // Accordion logic removed in favor of grid layout
    };

    // --- Dialog Functions ---
    const showPlaylistDialog = (callback) => {
        pendingAddToPlaylist = callback;
        playlistNameInput.value = '';
        playlistDialog.classList.add('visible');
        playlistNameInput.focus();
    };

    const hidePlaylistDialog = () => {
        playlistDialog.classList.remove('visible');
        pendingAddToPlaylist = null;
    };

    const createNewPlaylist = (name) => {
        const newPlaylist = { id: Date.now(), name, tracks: [] };
        customPlaylists.push(newPlaylist);
        saveCustomPlaylists();
        return newPlaylist;
    };

    // --- Context Menu Functions ---
    const showContextMenu = (x, y) => {
        // Update submenu with playlists
        updatePlaylistSubmenu();

        // Position menu
        contextMenu.style.left = `${x}px`;
        contextMenu.style.top = `${y}px`;
        contextMenu.classList.add('visible');

        // Adjust if off screen
        requestAnimationFrame(() => {
            const rect = contextMenu.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                contextMenu.style.left = `${window.innerWidth - rect.width - 10}px`;
            }
            if (rect.bottom > window.innerHeight) {
                contextMenu.style.top = `${window.innerHeight - rect.height - 10}px`;
            }
        });
    };

    const hideContextMenu = () => {
        contextMenu.classList.remove('visible');
    };

    const updatePlaylistSubmenu = () => {
        if (customPlaylists.length === 0) {
            playlistSubmenu.innerHTML = '<div class="submenu-empty">暂无歌单</div>';
        } else {
            playlistSubmenu.innerHTML = '';
            customPlaylists.forEach(pl => {
                const item = document.createElement('div');
                item.className = 'submenu-item';
                item.textContent = pl.name;
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    addSelectedTracksToPlaylist(pl.id);
                    hideContextMenu();
                });
                playlistSubmenu.appendChild(item);
            });
        }
    };
    const addSelectedTracksToPlaylist = (playlistId) => {
        const pl = customPlaylists.find(p => p.id === playlistId);
        if (!pl || contextMenuTrackIndex === null) return;

        const track = playlist[contextMenuTrackIndex];
        if (!track) return;

        if (pl.tracks.includes(track.path)) {
            alert(`歌曲 "${track.title || '未知标题'}" 已在歌单 "${pl.name}" 中`);
            return;
        }

        pl.tracks.push(track.path);
        saveCustomPlaylists();
        
        // 如果当前正在查看该歌单，则刷新显示
        if (filteredPlaylistSource?.type === 'playlist' && filteredPlaylistSource.id === playlistId) {
            const tracks = pl.tracks.map(path => playlist.find(t => t.path === path)).filter(Boolean);
            renderPlaylist(tracks);
        }
        
        // 刷新侧边栏以更新歌曲计数
        if (currentSidebarView === 'playlists') {
            renderSidebarContent('playlists');
        }
    };


    // ===== PLAYLIST EDIT MODAL FUNCTIONS =====

    // --- Open Modal ---
    const openPlaylistEditModal = (playlistId) => {
        const pl = customPlaylists.find(p => p.id === playlistId);
        if (!pl) return;

        editingPlaylistId = playlistId;
        modalSearchQuery = '';
        lastModalClickIndex = -1; // Reset for shift-select
        modalSearchInput.value = '';
        modalPlaylistTitle.textContent = `编辑: ${pl.name}`;
        renderModalSongList();
        playlistEditModal.classList.add('visible');
    };

    // --- Close Modal ---
    const closePlaylistEditModal = () => {
        playlistEditModal.classList.remove('visible');
        editingPlaylistId = null;
        // Refresh sidebar if we're on playlists view
        if (currentSidebarView === 'playlists') {
            renderSidebarContent('playlists');
        }
    };

    // --- Render Songs in Modal ---
    const renderModalSongList = () => {
        const pl = customPlaylists.find(p => p.id === editingPlaylistId);
        if (!pl) return;

        // Filter by search query
        const query = modalSearchQuery.toLowerCase();
        const filteredTracks = query
            ? playlist.filter(t =>
                (t.title || '').toLowerCase().includes(query) ||
                (t.artist || '').toLowerCase().includes(query) ||
                (t.album || '').toLowerCase().includes(query)
            )
            : playlist;

        if (filteredTracks.length === 0) {
            modalSongList.innerHTML = '<div class="music-modal-empty">没有匹配的歌曲</div>';
            modalCount.textContent = `${pl.tracks.length} 首已添加`;
            return;
        }

        modalSongList.innerHTML = '';
        const fragment = document.createDocumentFragment();

        filteredTracks.forEach((track, index) => {
            const isInPlaylist = pl.tracks.includes(track.path);
            const div = document.createElement('div');
            div.className = `music-modal-song-item${isInPlaylist ? ' in-playlist' : ''}`;
            div.dataset.path = track.path;
            div.dataset.index = index;
            div.innerHTML = `
                <div class="music-modal-song-checkbox">
                    <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg>
                </div>
                <div class="music-modal-song-info">
                    <div class="music-modal-song-title">${track.title || '未知标题'}</div>
                    <div class="music-modal-song-artist">${track.artist || '未知艺术家'}</div>
                </div>
            `;
            div.addEventListener('click', (e) => {
                const clickedIndex = parseInt(div.dataset.index, 10);

                if (e.shiftKey && lastModalClickIndex !== -1 && lastModalClickIndex !== clickedIndex) {
                    // Shift-click: toggle range
                    const start = Math.min(lastModalClickIndex, clickedIndex);
                    const end = Math.max(lastModalClickIndex, clickedIndex);
                    for (let i = start; i <= end; i++) {
                        const targetPath = filteredTracks[i].path;
                        // Check target state based on clicked item's desired state
                        const targetIsIn = pl.tracks.includes(targetPath);
                        const clickedIsIn = pl.tracks.includes(track.path);
                        // If clicked item will be added, add all; if removed, remove all
                        if (!clickedIsIn && !targetIsIn) {
                            pl.tracks.push(targetPath);
                        } else if (clickedIsIn && targetIsIn) {
                            const idx = pl.tracks.indexOf(targetPath);
                            if (idx !== -1) pl.tracks.splice(idx, 1);
                        }
                    }
                    saveCustomPlaylists();
                    renderModalSongList(); // Re-render to update all checkboxes
                } else {
                    toggleSongInPlaylist(track.path);
                }
                lastModalClickIndex = clickedIndex;
            });
            fragment.appendChild(div);
        });

        modalSongList.appendChild(fragment);
        modalCount.textContent = `${pl.tracks.length} 首已添加`;
    };

    // --- Toggle Song in Playlist ---
    const toggleSongInPlaylist = (trackPath) => {
        const pl = customPlaylists.find(p => p.id === editingPlaylistId);
        if (!pl) return;

        const index = pl.tracks.indexOf(trackPath);
        if (index === -1) {
            pl.tracks.push(trackPath);
        } else {
            pl.tracks.splice(index, 1);
        }
        saveCustomPlaylists();

        // Update UI
        const item = modalSongList.querySelector(`[data-path="${CSS.escape(trackPath)}"]`);
        if (item) {
            item.classList.toggle('in-playlist', index === -1);
        }
        modalCount.textContent = `${pl.tracks.length} 首已添加`;
    };

    // --- Setup Modal Handlers ---
    const setupModalHandlers = () => {
        modalCloseBtn?.addEventListener('click', closePlaylistEditModal);
        modalDoneBtn?.addEventListener('click', closePlaylistEditModal);

        // Close on backdrop click
        playlistEditModal?.addEventListener('click', (e) => {
            if (e.target === playlistEditModal) {
                closePlaylistEditModal();
            }
        });

        // Search
        modalSearchInput?.addEventListener('input', (e) => {
            modalSearchQuery = e.target.value;
            renderModalSongList();
        });

        // ESC to close
        playlistEditModal?.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closePlaylistEditModal();
            }
        });
    };

    // --- Simplified Context Menu (for single track) ---
    let contextMenuTrackIndex = null;

    const setupContextMenuHandlers = () => {
        // Right-click on playlist items
        playlistEl.addEventListener('contextmenu', (e) => {
            const li = e.target.closest('li');
            if (li && li.dataset.index !== undefined) {
                e.preventDefault();
                contextMenuTrackIndex = parseInt(li.dataset.index, 10);
                updatePlaylistSubmenu();
                showContextMenu(e.clientX, e.clientY);
            }
        });

        // Hide context menu on click outside
        document.addEventListener('click', (e) => {
            if (!contextMenu.contains(e.target)) {
                hideContextMenu();
            }
        });

        // Context menu actions
        contextMenu.addEventListener('click', (e) => {
            const item = e.target.closest('.context-menu-item');
            if (!item) return;

            const action = item.dataset.action;
            if (!action) return;

            // Capture the index immediately to avoid issues with async callbacks
            const trackIndex = contextMenuTrackIndex;

            switch (action) {
                case 'play':
                    if (trackIndex !== null) {
                        shuffleQueue = []; // Reset shuffle on manual selection
                        loadTrack(trackIndex);
                    }
                    break;
                case 'play-next':
                    console.log('Play next - queue feature');
                    break;
                case 'create-playlist-add':
                    showPlaylistDialog((newPlaylist) => {
                        const track = playlist[trackIndex];
                        if (track && !newPlaylist.tracks.includes(track.path)) {
                            newPlaylist.tracks.push(track.path);
                            saveCustomPlaylists();
                        }
                    });
                    break;
                case 'remove-from-list':
                    if (filteredPlaylistSource?.type === 'playlist') {
                        const pl = customPlaylists.find(p => p.id === filteredPlaylistSource.id);
                        const track = playlist[trackIndex];
                        if (pl && track) {
                            pl.tracks = pl.tracks.filter(path => path !== track.path);
                            saveCustomPlaylists();
                            const tracks = pl.tracks.map(path => playlist.find(t => t.path === path)).filter(Boolean);
                            renderPlaylist(tracks);
                        }
                    }
                    break;
            }
            hideContextMenu();
            contextMenuTrackIndex = null;
        });
    };

    // --- Dialog Event Handlers ---
    const setupDialogHandlers = () => {
        createPlaylistBtn?.addEventListener('click', () => {
            showPlaylistDialog();
        });

        dialogCancel?.addEventListener('click', hidePlaylistDialog);

        dialogConfirm?.addEventListener('click', () => {
            const name = playlistNameInput.value.trim();
            if (name) {
                const newPlaylist = createNewPlaylist(name);
                if (pendingAddToPlaylist) {
                    pendingAddToPlaylist(newPlaylist);
                }
                hidePlaylistDialog();
                if (currentSidebarView === 'playlists') {
                    renderSidebarContent('playlists');
                }
            }
        });

        playlistNameInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                dialogConfirm?.click();
            } else if (e.key === 'Escape') {
                hidePlaylistDialog();
            }
        });

        playlistDialog?.addEventListener('click', (e) => {
            if (e.target === playlistDialog) {
                hidePlaylistDialog();
            }
        });
    };

    // --- Initialize Sidebar ---
    const initSidebar = async () => {
        await loadCustomPlaylists();
        setupSidebarTabs();
        setupContextMenuHandlers();
        setupDialogHandlers();
        setupModalHandlers();
        setupAccordion();
        renderSidebarContent('all');
        updateAllCount();
    };

    // --- App Initialization ---
    const init = async () => {
        if (window.electron) {
            window.electron.send('music-renderer-ready');
        }
        visualizerCanvas.width = visualizerCanvas.clientWidth;
        visualizerCanvas.height = visualizerCanvas.clientHeight;

        // --- Initialize Particles ---
        recreateParticles();


        setupElectronHandlers();
        setupWebDavHandlers();
        setupMediaSessionHandlers(); // Setup OS media controls
        updateModeButton();
        await initializeTheme();

        // Setup phantom audio
        try {
            phantomAudio.src = createSilentAudio();
        } catch (e) {
            console.error("Failed to create silent audio:", e);
        }

        // Initialize WebNowPlaying Adapter for Rainmeter
        wnpAdapter = new WebNowPlayingAdapter();

        if (window.electron) {
            const savedPlaylist = await window.electron.invoke('get-music-playlist');
            if (savedPlaylist && savedPlaylist.length > 0) {
                playlist = savedPlaylist;
                renderPlaylist();
                await loadTrack(0, false); // Wait for the track to load
            }
            // Initialize sidebar after playlist is loaded
            await initSidebar();
            // Sync initial volume
            const initialState = await window.electron.invoke('music-get-state');
            if (initialState && initialState.state && initialState.state.volume !== undefined) {
                volumeSlider.value = initialState.state.volume;
                updateVolumeSliderBackground(initialState.state.volume);
            }
        }

        // --- New: Populate devices and set initial state ---
        // 刷新页面后，直接获取设备列表，不再强制重新扫描以避免启动卡顿
        populateDeviceList(false);
        createEqBands(); // Create EQ sliders
        populateEqPresets(); // Populate EQ presets
        window.electron.invoke('music-get-state').then(initialDeviceState => {
            if (initialDeviceState && initialDeviceState.state) {
                currentDeviceId = initialDeviceState.state.device_id;
                useWasapiExclusive = initialDeviceState.state.exclusive_mode;
                deviceSelect.value = currentDeviceId === null ? 'default' : currentDeviceId;
                wasapiSwitch._programmaticUpdate = true;
                wasapiSwitch.checked = useWasapiExclusive;
                Promise.resolve().then(() => { wasapiSwitch._programmaticUpdate = false; });

                // Set initial EQ state from engine
                if (initialDeviceState.state.eq_enabled !== undefined) {
                    eqEnabled = initialDeviceState.state.eq_enabled;
                    eqSwitch._programmaticUpdate = true;
                    eqSwitch.checked = eqEnabled;
                    Promise.resolve().then(() => { eqSwitch._programmaticUpdate = false; });
                }
                if (initialDeviceState.state.eq_type !== undefined) {
                    eqTypeSelect.value = initialDeviceState.state.eq_type;
                }
                if (initialDeviceState.state.dither_enabled !== undefined) {
                    ditherSwitch._programmaticUpdate = true;
                    ditherSwitch.checked = initialDeviceState.state.dither_enabled;
                    Promise.resolve().then(() => { ditherSwitch._programmaticUpdate = false; });
                }
                // ReplayGain switch syncs with loudness_mode
                const initLoudnessMode = initialDeviceState.state.loudness_mode;
                const initIsRgMode = initLoudnessMode === 'replaygain_track' || initLoudnessMode === 'replaygain_album';
                replaygainSwitch._programmaticUpdate = true;
                replaygainSwitch.checked = initIsRgMode;
                Promise.resolve().then(() => { replaygainSwitch._programmaticUpdate = false; });
                if (initialDeviceState.state.eq_bands) {
                    for (const [band, gain] of Object.entries(initialDeviceState.state.eq_bands)) {
                        const slider = document.getElementById(`eq-${band}`);
                        if (slider) {
                            slider.value = gain;
                        }
                        eqBands[band] = gain;
                    }
                }
                // Set initial upsampling state
                if (initialDeviceState.state.target_samplerate !== undefined) {
                    targetUpsamplingRate = initialDeviceState.state.target_samplerate || 0;
                    upsamplingSelect.value = targetUpsamplingRate;
                }
                // Set initial resampling settings
                if (initialDeviceState.state.resample_quality !== undefined) {
                    resampleQualitySelect.value = initialDeviceState.state.resample_quality;
                }
                if (initialDeviceState.state.use_cache !== undefined) {
                    resampleCacheSwitch._programmaticUpdate = true;
                    resampleCacheSwitch.checked = initialDeviceState.state.use_cache;
                    Promise.resolve().then(() => { resampleCacheSwitch._programmaticUpdate = false; });
                }
                if (initialDeviceState.state.preemptive_resample !== undefined) {
                    preemptiveResampleSwitch._programmaticUpdate = true;
                    preemptiveResampleSwitch.checked = initialDeviceState.state.preemptive_resample;
                    Promise.resolve().then(() => { preemptiveResampleSwitch._programmaticUpdate = false; });
                }
            }
        });
    };

    init();
});
