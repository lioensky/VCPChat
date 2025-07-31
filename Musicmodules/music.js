// Musicmodules/music.js - Rewritten for Python Hi-Fi Audio Engine
document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Element Selections ---
    const playPauseBtn = document.getElementById('play-pause-btn');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const modeBtn = document.getElementById('mode-btn');
    const volumeBtn = document.getElementById('volume-btn'); // 音量功能暂时由UI控制，不与引擎交互
    const volumeSlider = document.getElementById('volume-slider'); // 同上
    const progressBar = document.querySelector('.progress-bar');
    const progress = document.querySelector('.progress');
    const currentTimeEl = document.querySelector('.current-time');
    const durationEl = document.querySelector('.duration');
    const albumArt = document.querySelector('.album-art');
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
  const eqResetBtn = document.getElementById('eq-reset-btn');
  const eqSection = document.getElementById('eq-section');
  const upsamplingSelect = document.getElementById('upsampling-select');
  const lyricsContainer = document.getElementById('lyrics-container');
  const lyricsList = document.getElementById('lyrics-list');

  // --- Custom Title Bar ---
  const minimizeBtn = document.getElementById('minimize-music-btn');
  const maximizeBtn = document.getElementById('maximize-music-btn');
  const closeBtn = document.getElementById('close-music-btn');

   // --- State Variables ---
    let playlist = [];
    let currentTrackIndex = 0;
    let isPlaying = false; // 本地UI状态，会与引擎同步
    const playModes = ['repeat', 'repeat-one', 'shuffle'];
    let currentPlayMode = 0;
    let currentTheme = 'dark';
    let currentLyrics = [];
    let currentLyricIndex = -1;
    let lyricOffset = -0.05; // In seconds. Negative value makes lyrics appear earlier to compensate for UI lag.
    let lyricSpeedFactor = 1.0; // Should be 1.0 for correctly timed LRC files.
    let lastKnownCurrentTime = 0;
    let lastStateUpdateTime = 0;
    let visualizerColor = { r: 118, g: 106, b: 226 };
    let statePollInterval; // 用于轮询状态的定时器
   let currentDeviceId = null;
   let useWasapiExclusive = false;
   let targetUpsamplingRate = 0;
   let eqEnabled = false;
  const eqBands = {
       '31': 0, '62': 0, '125': 0, '250': 0, '500': 0,
       '1k': 0, '2k': 0, '4k': 0, '8k': 0, '16k': 0
  };

   // --- Visualizer State ---
    let animationFrameId;
    let targetVisualizerData = [];
    let currentVisualizerData = [];
    const easingFactor = 0.2; // 缓动因子，值越小动画越平滑

    // --- WebSocket for Visualization ---
    const socket = io("http://127.0.0.1:5555");

    socket.on('connect', () => {
        // console.log('[Music.js] Connected to Python Audio Engine via WebSocket.');
        if (!animationFrameId) {
            startVisualizerAnimation(); // 连接成功后启动动画循环
        }
    });

    socket.on('spectrum_data', (specData) => {
        if (isPlaying) {
            // 只更新目标数据，让动画循环去处理绘制
            targetVisualizerData = specData.data;
            if (currentVisualizerData.length === 0) {
                // 初始化当前数据，避免从0开始跳变
                currentVisualizerData = Array(targetVisualizerData.length).fill(0);
            }
        }
    });
    
    socket.on('playback_state', (state) => {
        // console.log('[Music.js] Received playback state from engine:', state);
        updateUIWithState(state);
    });

    socket.on('disconnect', () => {
        // console.log('[Music.js] Disconnected from Python Audio Engine WebSocket.');
    });


    // --- Helper Functions ---
    const formatTime = (seconds) => {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    };

    const updateBlurredBackground = (imageUrl) => {
        if (playerBackground) {
            playerBackground.style.backgroundImage = imageUrl;
        }
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

    // --- Core Player Logic ---
    const loadTrack = async (trackIndex, andPlay = true) => {
        if (playlist.length === 0) {
            // 清空UI
            trackTitle.textContent = '未选择歌曲';
            trackArtist.textContent = '未知艺术家';
            trackBitrate.textContent = '';
            const defaultArtUrl = `url('../assets/${currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
            albumArt.style.backgroundImage = defaultArtUrl;
            updateBlurredBackground(defaultArtUrl);
            renderPlaylist();
            return;
        }
        
        currentTrackIndex = trackIndex;
        const track = playlist[trackIndex];

        // 更新UI
        trackTitle.textContent = track.title || '未知标题';
        trackArtist.textContent = track.artist || '未知艺术家';
        if (track.bitrate) {
            trackBitrate.textContent = `${Math.round(track.bitrate / 1000)} kbps`;
        } else {
            trackBitrate.textContent = '';
        }
        const defaultArtUrl = `url('../assets/${currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
        const albumArtUrl = track.albumArt ? `url('file://${track.albumArt.replace(/\\/g, '/')}')` : defaultArtUrl;
        albumArt.style.backgroundImage = albumArtUrl;
        updateBlurredBackground(albumArtUrl);
        renderPlaylist();
        fetchAndDisplayLyrics(track.artist, track.title);

        // 通过IPC让主进程通知Python引擎加载文件
        const result = await window.electron.invoke('music-load', track.path);
        if (result && result.status === 'success') {
            updateUIWithState(result.state);
            if (andPlay) {
                playTrack();
            }
        } else {
            console.error("Failed to load track in audio engine:", result.message);
        }
    };

    const playTrack = async () => {
        if (playlist.length === 0) return;
        const result = await window.electron.invoke('music-play');
        if (result.status === 'success') {
            isPlaying = true;
            playPauseBtn.classList.add('is-playing');
            startStatePolling();
        }
    };

    const pauseTrack = async () => {
        const result = await window.electron.invoke('music-pause');
        if (result.status === 'success') {
            isPlaying = false;
            playPauseBtn.classList.remove('is-playing');
            stopStatePolling();
        }
    };

    const prevTrack = () => {
        currentTrackIndex = (currentTrackIndex - 1 + playlist.length) % playlist.length;
        loadTrack(currentTrackIndex);
    };

    const nextTrack = () => {
        if (playlist.length <= 1) {
            loadTrack(currentTrackIndex);
            return;
        }

        switch (playModes[currentPlayMode]) {
            case 'repeat':
                currentTrackIndex = (currentTrackIndex + 1) % playlist.length;
                break;
            case 'repeat-one':
                // 引擎会在播放结束时停止，我们需要在这里重新加载并播放
                break; 
            case 'shuffle':
                let nextIndex;
                do {
                    nextIndex = Math.floor(Math.random() * playlist.length);
                } while (playlist.length > 1 && nextIndex === currentTrackIndex);
                currentTrackIndex = nextIndex;
                break;
        }
        loadTrack(currentTrackIndex);
    };

    // --- UI Update and State Management ---
    const updateUIWithState = (state) => {
        if (!state) return;
        
        isPlaying = state.is_playing && !state.is_paused;
        playPauseBtn.classList.toggle('is-playing', isPlaying);

        const duration = state.duration || 0;
        const currentTime = state.current_time || 0;
        lastKnownCurrentTime = currentTime;
        lastStateUpdateTime = Date.now();
        
        durationEl.textContent = formatTime(duration);
        currentTimeEl.textContent = formatTime(currentTime);
        
        const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
        progress.style.width = `${progressPercent}%`;

        // 检查播放是否已结束
        if (state.is_playing === false && currentTrackIndex !== -1 && currentTime > 0) {
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
           wasapiSwitch.checked = state.exclusive_mode;
       }
      // Update EQ UI
      if (state.eq_enabled !== undefined && eqSwitch.checked !== state.eq_enabled) {
          eqSwitch.checked = state.eq_enabled;
          eqSection.classList.toggle('expanded', state.eq_enabled);
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

    const setProgress = async (e) => {
        const width = progressBar.clientWidth;
        const clickX = e.offsetX;
        const result = await window.electron.invoke('music-get-state');
        if (result.status === 'success' && result.state.duration > 0) {
            const newTime = (clickX / width) * result.state.duration;
            await window.electron.invoke('music-seek', newTime);
            // 立即更新UI以获得即时反馈
            pollState();
        }
    };

    // --- Visualizer ---
    const startVisualizerAnimation = () => {
        const draw = () => {
           if (isPlaying) {
               animateLyrics();
           }

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
            animationFrameId = requestAnimationFrame(draw);
        };
        draw();
    };

    const drawVisualizer = (data) => {
        // --- 数据平滑处理 ---
        const smoothingFactor = 3; // 平滑窗口大小
        const smoothedData = [];
        for (let i = 0; i < data.length; i++) {
            let sum = 0;
            let count = 0;
            for (let j = -smoothingFactor; j <= smoothingFactor; j++) {
                if (i + j >= 0 && i + j < data.length) {
                    sum += data[i + j];
                    count++;
                }
            }
            smoothedData.push(sum / count);
        }
        
        visualizerCtx.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
        
        const bufferLength = smoothedData.length;
        if (bufferLength === 0) return;

        const barWidth = visualizerCanvas.width / (bufferLength - 1);

        const gradient = visualizerCtx.createLinearGradient(0, 0, 0, visualizerCanvas.height);
        const { r, g, b } = visualizerColor;
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.85)`);
        gradient.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, 0.4)`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.05)`);
        
        visualizerCtx.fillStyle = gradient;
        visualizerCtx.beginPath();
        visualizerCtx.moveTo(0, visualizerCanvas.height);

        let x = 0;
        for (let i = 0; i < bufferLength; i++) {
            const barHeight = smoothedData[i] * visualizerCanvas.height * 0.9;
            const y = visualizerCanvas.height - barHeight;
            visualizerCtx.lineTo(x, y);
            x += barWidth;
        }

        visualizerCtx.lineTo(visualizerCanvas.width, visualizerCanvas.height);
        visualizerCtx.closePath();
        visualizerCtx.fill();
    };

    // --- Event Listeners ---
    playPauseBtn.addEventListener('click', () => {
        isPlaying ? pauseTrack() : playTrack();
    });
    prevBtn.addEventListener('click', prevTrack);
    nextBtn.addEventListener('click', nextTrack);
    progressBar.addEventListener('click', setProgress);
    
    // 音量控制暂时保持前端控制，因为它不影响HIFI解码
    volumeSlider.addEventListener('input', async (e) => {
        const newVolume = parseFloat(e.target.value);
        if (window.electron) {
            await window.electron.invoke('music-set-volume', newVolume);
        }
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
        updateModeButton();
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
            loadTrack(index);
        }
    });

    searchInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase();
        const filteredPlaylist = playlist.filter(track =>
            (track.title || '').toLowerCase().includes(searchTerm) ||
            (track.artist || '').toLowerCase().includes(searchTerm)
        );
        renderPlaylist(filteredPlaylist);
    });

    window.addEventListener('resize', () => {
        visualizerCanvas.width = visualizerCanvas.clientWidth;
        visualizerCanvas.height = visualizerCanvas.clientHeight;
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
   const populateDeviceList = async () => {
       if (!window.electron) return;
       const result = await window.electron.invoke('music-get-devices');
       if (result.status === 'success' && result.devices) {
           deviceSelect.innerHTML = ''; // Clear existing options

           // Add default device option
           const defaultOption = document.createElement('option');
           defaultOption.value = 'default';
           defaultOption.textContent = '默认设备';
           deviceSelect.appendChild(defaultOption);

           // Add WASAPI devices
           if (result.devices.wasapi && result.devices.wasapi.length > 0) {
               const wasapiGroup = document.createElement('optgroup');
               wasapiGroup.label = 'WASAPI';
               result.devices.wasapi.forEach(device => {
                   const option = document.createElement('option');
                   option.value = device.id;
                   option.textContent = device.name;
                   wasapiGroup.appendChild(option);
               });
               deviceSelect.appendChild(wasapiGroup);
           }
       } else {
           console.error("Failed to get audio devices:", result.message);
       }
   };

   const configureOutput = async () => {
       if (!window.electron) return;
       
       const selectedDeviceId = deviceSelect.value === 'default' ? null : parseInt(deviceSelect.value, 10);
       const useExclusive = wasapiSwitch.checked;

       console.log(`Configuring output: Device ID=${selectedDeviceId}, Exclusive=${useExclusive}`);
       
       // Prevent re-configuration if nothing changed
       if (selectedDeviceId === currentDeviceId && useExclusive === useWasapiExclusive) {
           return;
       }

       currentDeviceId = selectedDeviceId;
       useWasapiExclusive = useExclusive;

       await window.electron.invoke('music-configure-output', {
           device_id: currentDeviceId,
           exclusive: useWasapiExclusive
       });
   };

   deviceSelect.addEventListener('change', configureOutput);
   wasapiSwitch.addEventListener('change', configureOutput);

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
  };

  upsamplingSelect.addEventListener('change', configureUpsampling);

  // --- EQ Control ---
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
       eqSection.classList.toggle('expanded', eqSwitch.checked);
       sendEqSettings();
  });

  eqResetBtn.addEventListener('click', () => {
      for (const band in eqBands) {
          const slider = document.getElementById(`eq-${band}`);
          if (slider) {
              slider.value = 0;
          }
      }
      sendEqSettings();
  });

   // --- Electron IPC and Initialization ---
    const setupElectronHandlers = () => {
        if (!window.electron) return;

        addFolderBtn.addEventListener('click', () => {
            playlist = [];
            renderPlaylist();
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
            playlist = newlyScannedFiles;
            renderPlaylist();
            window.electron.send('save-music-playlist', playlist);
            if (playlist.length > 0) {
                loadTrack(0, false); // Load first track but don't play
            }
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
    };
    
   // --- Lyrics Handling ---
   const fetchAndDisplayLyrics = async (artist, title) => {
       resetLyrics();
       if (!window.electron) return;

       const lrcContent = await window.electron.invoke('music-get-lyrics', { artist, title });

       if (lrcContent) {
           currentLyrics = parseLrc(lrcContent);
           renderLyrics();
       } else {
           // If no local lyrics, try fetching from network
           lyricsList.innerHTML = '<li class="no-lyrics">正在网络上搜索歌词...</li>';
           try {
               const fetchedLrc = await window.electron.invoke('music-fetch-lyrics', { artist, title });
               if (fetchedLrc) {
                   currentLyrics = parseLrc(fetchedLrc);
                   renderLyrics();
               } else {
                   lyricsList.innerHTML = '<li class="no-lyrics">暂无歌词</li>';
               }
           } catch (error) {
               console.error('Failed to fetch lyrics from network:', error);
               lyricsList.innerHTML = '<li class="no-lyrics">歌词获取失败</li>';
           }
       }
   };

   const parseLrc = (lrcContent) => {
       const lyrics = [];
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
                   // Apply speed factor and offset during parsing for more accurate synchronization
                   const time = (minutes * 60 + seconds + milliseconds / 1000) * lyricSpeedFactor + lyricOffset;
                   lyrics.push({ time, text });
               }
           }
       }
 
       return lyrics.sort((a, b) => a.time - b.time);
   };

   const renderLyrics = () => {
       lyricsList.innerHTML = '';
       const fragment = document.createDocumentFragment();
       currentLyrics.forEach((line, index) => {
           const li = document.createElement('li');
           li.textContent = line.text;
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
               li.style.opacity = Math.max(0.15, 1 - distance * 0.2).toFixed(2);
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
        setTimeout(() => {
            const highlightColor = getComputedStyle(document.body).getPropertyValue('--music-highlight');
            const rgbColor = hexToRgb(highlightColor);
            if (rgbColor) {
                visualizerColor = rgbColor;
            }
        }, 50);
        const currentArt = albumArt.style.backgroundImage;
        if (!currentArt || currentArt.includes('musicdark.jpeg') || currentArt.includes('musiclight.jpeg')) {
            const defaultArtUrl = `url('../assets/${theme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
            albumArt.style.backgroundImage = defaultArtUrl;
            updateBlurredBackground(defaultArtUrl);
        }
    };
    
    const initializeTheme = async () => {
        if (!window.electronAPI) {
            applyTheme('dark');
            return;
        }
        try {
            const theme = await window.electronAPI.getCurrentTheme();
            applyTheme(theme || 'dark');
            window.electronAPI.onThemeUpdated((newTheme) => {
                applyTheme(newTheme);
            });
        } catch (error) {
            console.error('Failed to initialize theme:', error);
            applyTheme('dark');
        }
    };

    // --- App Initialization ---
    const init = async () => {
        visualizerCanvas.width = visualizerCanvas.clientWidth;
        visualizerCanvas.height = visualizerCanvas.clientHeight;

        setupElectronHandlers();
        updateModeButton();
        await initializeTheme();
    
        if (window.electron) {
            const savedPlaylist = await window.electron.invoke('get-music-playlist');
            if (savedPlaylist && savedPlaylist.length > 0) {
                playlist = savedPlaylist;
                renderPlaylist();
                await loadTrack(0, false); // Wait for the track to load
            }
            // Sync initial volume
            const initialState = await window.electron.invoke('music-get-state');
            if (initialState && initialState.state && initialState.state.volume !== undefined) {
                volumeSlider.value = initialState.state.volume;
            }
        }
       
       // --- New: Populate devices and set initial state ---
       await populateDeviceList();
      createEqBands(); // Create EQ sliders
       const initialDeviceState = await window.electron.invoke('music-get-state');
       if (initialDeviceState && initialDeviceState.state) {
           currentDeviceId = initialDeviceState.state.device_id;
           useWasapiExclusive = initialDeviceState.state.exclusive_mode;
           deviceSelect.value = currentDeviceId === null ? 'default' : currentDeviceId;
           wasapiSwitch.checked = useWasapiExclusive;

           // Set initial EQ state from engine
           if (initialDeviceState.state.eq_enabled !== undefined) {
               eqEnabled = initialDeviceState.state.eq_enabled;
               eqSwitch.checked = eqEnabled;
               eqSection.classList.toggle('expanded', eqEnabled);
           }
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
       }


        if (window.electron) {
            window.electron.send('music-renderer-ready');
        }
    };

    init();
});
