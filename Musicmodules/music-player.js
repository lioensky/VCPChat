// Musicmodules/music-player.js
// 核心播放逻辑

function setupPlayer(app) {
    app.loadTrack = async (trackIndex, andPlay = true) => {
        const requestId = ++app.pendingLoadRequestId;
        app.isPreloadingNext = false;
        try {
            await window.electron.invoke('music-cancel-preload');
        } catch (e) {}

        if (app.playlist.length === 0) {
            app.trackTitle.textContent = '未选择歌曲';
            app.trackArtist.textContent = '未知艺术家';
            app.trackBitrate.textContent = '';
            const defaultArtUrl = `url('../assets/${app.currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
            app.albumArt.style.backgroundImage = defaultArtUrl;
            app.updateBlurredBackground('none');
            app.renderPlaylist(app.currentFilteredTracks);
            return;
        }

        app.currentTrackIndex = trackIndex;
        const track = app.playlist[trackIndex];
        app.pendingTrackPath = track.path;
        app.isTrackLoading = true;

        app.trackTitle.textContent = track.title || '未知标题';
        app.trackArtist.textContent = track.artist || '未知艺术家';
        app.trackBitrate.textContent = track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : '';

        const defaultArtUrl = `url('../assets/${app.currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
        if (track.albumArt) {
            const albumArtUrl = `url('file://${track.albumArt.replace(/\\/g, '/')}')`;
            app.albumArt.style.backgroundImage = albumArtUrl;
            app.updateBlurredBackground(albumArtUrl);
        } else {
            app.albumArt.style.backgroundImage = defaultArtUrl;
            app.updateBlurredBackground(defaultArtUrl);
        }

        app.renderPlaylist(app.currentFilteredTracks);
        app.fetchAndDisplayLyrics(track.artist, track.title);
        app.updateMediaSessionMetadata();
        if (app.wnpAdapter) app.wnpAdapter.sendUpdate();

        const result = await window.electron.invoke('music-load', track);
        if (result && result.status === 'success') {
            app.updateUIWithState(result.state);

            const waitForTrackReady = async () => {
                const timeoutAt = Date.now() + 12000;
                const targetPath = app.normalizePathForCompare(track.path);
                let pollInterval = 120;

                while (Date.now() < timeoutAt) {
                    if (requestId !== app.pendingLoadRequestId) return false;

                    const stateResult = await window.electron.invoke('music-get-state');
                    if (stateResult && stateResult.status === 'success' && stateResult.state) {
                        const state = stateResult.state;
                        app.updateUIWithState(state);
                        const loadedPath = app.normalizePathForCompare(state.file_path);
                        if (loadedPath === targetPath && !state.is_loading) return true;
                    }
                    await new Promise(r => setTimeout(r, pollInterval));
                    // 逐步增大轮询间隔，避免高频轮询（最大 500ms）
                    pollInterval = Math.min(pollInterval + 50, 500);
                }
                console.warn('[Music.js] waitForTrackReady timed out for:', track.title);
                return false;
            };

            const ready = await waitForTrackReady();
            if (requestId === app.pendingLoadRequestId) app.isTrackLoading = false;
            if (andPlay && ready) app.playTrack();
        } else {
            if (requestId === app.pendingLoadRequestId) app.isTrackLoading = false;
            console.error("Failed to load track:", result.message);
        }
    };

    app.playTrack = async () => {
        if (app.playlist.length === 0 || app.isTrackLoading) return;
        const result = await window.electron.invoke('music-play');
        if (result.status === 'success') {
            app.isChangingState = true;
            app.lastCommandTime = Date.now();
            app.expectedPlayingState = true;
            app.isPlaying = true;
            app.playPauseBtn.classList.add('is-playing');
            app.phantomAudio.loop = true;
            app.phantomAudio.play().catch(e => console.error("Phantom audio play failed:", e));

            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
            app.startStatePolling();
            if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
        }
    };

    app.pauseTrack = async () => {
        const result = await window.electron.invoke('music-pause');
        if (result.status === 'success') {
            app.isChangingState = true;
            app.lastCommandTime = Date.now();
            app.expectedPlayingState = false;
            app.isPlaying = false;
            app.playPauseBtn.classList.remove('is-playing');
            app.phantomAudio.pause();
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
            app.stopStatePolling();
            if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
        }
    };

    app.prevTrack = () => {
        app.currentTrackIndex = (app.currentTrackIndex - 1 + app.playlist.length) % app.playlist.length;
        app.loadTrack(app.currentTrackIndex);
    };

    app.nextTrack = () => {
        const activeList = app.currentFilteredTracks || app.playlist;
        if (app.lastShuffleList !== activeList) {
            app.shuffleQueue = [];
            app.lastShuffleList = activeList;
        }

        if (activeList.length <= 1) {
            if (activeList.length === 1) {
                const idx = app.playlist.indexOf(activeList[0]);
                if (idx !== -1) app.loadTrack(idx);
            }
            return;
        }

        const previousTrackIndex = app.currentTrackIndex;

        switch (app.playModes[app.currentPlayMode]) {
            case 'repeat':
                const currentTrack = app.playlist[app.currentTrackIndex];
                const currentPos = activeList.indexOf(currentTrack);
                if (currentPos !== -1) {
                    const nextPos = (currentPos + 1) % activeList.length;
                    app.currentTrackIndex = app.playlist.indexOf(activeList[nextPos]);
                } else {
                    app.currentTrackIndex = app.playlist.indexOf(activeList[0]);
                }
                break;
            case 'repeat-one': break;
            case 'shuffle':
                if (app.shuffleQueue.length === 0) {
                    app.shuffleQueue = Array.from({ length: activeList.length }, (_, i) => i);
                    for (let i = app.shuffleQueue.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [app.shuffleQueue[i], app.shuffleQueue[j]] = [app.shuffleQueue[j], app.shuffleQueue[i]];
                    }
                    if (app.shuffleQueue.length > 1 && app.playlist.indexOf(activeList[app.shuffleQueue[0]]) === app.currentTrackIndex) {
                        app.shuffleQueue.push(app.shuffleQueue.shift());
                    }
                }
                const nextIdx = app.shuffleQueue.shift();
                app.currentTrackIndex = app.playlist.indexOf(activeList[nextIdx]);
                break;
        }

        // 防御性保护：如果不是单曲循环模式，但计算出的下一首仍然是当前歌曲，
        // 则强制跳到列表中的下一首。这可以防止由于 gapless 事件竞争等原因
        // 导致的意外"单曲循环"行为。
        if (app.playModes[app.currentPlayMode] !== 'repeat-one'
            && app.currentTrackIndex === previousTrackIndex
            && activeList.length > 1) {
            console.warn('[Music.js] nextTrack: computed same track in non-repeat-one mode, forcing advance');
            const currentTrackForFix = app.playlist[app.currentTrackIndex];
            const currentPosForFix = activeList.indexOf(currentTrackForFix);
            const forcedNextPos = (currentPosForFix !== -1)
                ? (currentPosForFix + 1) % activeList.length
                : 0;
            app.currentTrackIndex = app.playlist.indexOf(activeList[forcedNextPos]);
        }

        app.loadTrack(app.currentTrackIndex);
    };

    app.handleNeedsPreload = async () => {
        if (app.isPreloadingNext) return;
        const activeList = app.currentFilteredTracks || app.playlist;
        if (activeList.length === 0) return;

        let nextTrackToPreload = null;
        switch (app.playModes[app.currentPlayMode]) {
            case 'repeat':
                const currentTrack = app.playlist[app.currentTrackIndex];
                const currentPos = activeList.indexOf(currentTrack);
                nextTrackToPreload = activeList[currentPos !== -1 ? (currentPos + 1) % activeList.length : 0];
                break;
            case 'repeat-one':
                nextTrackToPreload = app.playlist[app.currentTrackIndex];
                break;
            case 'shuffle':
                if (app.shuffleQueue.length === 0) {
                    // Generate a new shuffle queue if empty
                    app.shuffleQueue = Array.from({ length: activeList.length }, (_, i) => i);
                    for (let i = app.shuffleQueue.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [app.shuffleQueue[i], app.shuffleQueue[j]] = [app.shuffleQueue[j], app.shuffleQueue[i]];
                    }
                    // Avoid starting with the current track
                    if (app.shuffleQueue.length > 1 && app.playlist.indexOf(activeList[app.shuffleQueue[0]]) === app.currentTrackIndex) {
                        app.shuffleQueue.push(app.shuffleQueue.shift());
                    }
                }
                
                if (app.shuffleQueue.length > 0) {
                    nextTrackToPreload = activeList[app.shuffleQueue[0]];
                }
                break;
        }

        if (nextTrackToPreload && nextTrackToPreload.path) {
            // If we are in repeat-one mode and there's only one track,
            // we still want to preload it for gapless looping.
            // But if we are NOT in repeat-one and there's only one track, we don't need to preload.
            if (activeList.length <= 1 && app.playModes[app.currentPlayMode] !== 'repeat-one') {
                return;
            }

            app.isPreloadingNext = true;
            try {
                await window.electron.invoke('music-queue-next', {
                    path: nextTrackToPreload.path,
                    username: nextTrackToPreload.username,
                    password: nextTrackToPreload.password
                });
            } catch (e) {
                console.error('[Music.js] Preload failed:', e);
            } finally {
                setTimeout(() => { app.isPreloadingNext = false; }, 500);
            }
        }
    };

    app.pollState = async () => {
        const result = await window.electron.invoke('music-get-state');
        if (result.status === 'success') app.updateUIWithState(result.state);
    };

    app.syncTrackIndexByPath = (path) => {
        if (!path) return;
        const normalizedPath = app.normalizePathForCompare(path);
        const index = app.playlist.findIndex(t => app.normalizePathForCompare(t.path) === normalizedPath);
        if (index !== -1) {
            console.log('[Music.js] Syncing track index to:', index, 'path:', normalizedPath);
            app.currentTrackIndex = index;
            const track = app.playlist[index];
            app.pendingTrackPath = track.path;
            app.isTrackLoading = false; // gapless 切歌后后端已经加载好了，重置加载标志
            app.trackTitle.textContent = track.title || '未知标题';
            app.trackArtist.textContent = track.artist || '未知艺术家';
            app.trackBitrate.textContent = track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : '';
            
            const defaultArtUrl = `url('../assets/${app.currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
            if (track.albumArt) {
                const albumArtUrl = `url('file://${track.albumArt.replace(/\\/g, '/')}')`;
                app.albumArt.style.backgroundImage = albumArtUrl;
                app.updateBlurredBackground(albumArtUrl);
            } else {
                app.albumArt.style.backgroundImage = defaultArtUrl;
                app.updateBlurredBackground(defaultArtUrl);
            }
            
            app.renderPlaylist(app.currentFilteredTracks);
            app.fetchAndDisplayLyrics(track.artist, track.title);
            app.updateMediaSessionMetadata();

            // 如果是随机播放，从队列中移除当前已开始播放的这首歌，防止之后再次随机到它
            if (app.playModes[app.currentPlayMode] === 'shuffle') {
                const activeList = app.currentFilteredTracks || app.playlist;
                const posInActiveList = activeList.indexOf(track);
                if (posInActiveList !== -1) {
                    const queueIndex = app.shuffleQueue.indexOf(posInActiveList);
                    if (queueIndex !== -1) {
                        console.log('[Music.js] Removing synced track from shuffle queue at index:', queueIndex);
                        app.shuffleQueue.splice(queueIndex, 1);
                    }
                }
            }

            if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
        } else {
            // 路径匹配失败 —— 尝试文件名模糊匹配作为降级
            // 后端可能返回带 \\?\ 前缀或不同斜杠方向的路径
            const fileName = normalizedPath ? normalizedPath.split('/').pop() : null;
            if (fileName) {
                const fuzzyIndex = app.playlist.findIndex(t => {
                    const tNorm = app.normalizePathForCompare(t.path);
                    return tNorm && tNorm.split('/').pop() === fileName;
                });
                if (fuzzyIndex !== -1) {
                    console.log('[Music.js] Syncing track index (fuzzy match) to:', fuzzyIndex);
                    app.currentTrackIndex = fuzzyIndex;
                    const track = app.playlist[fuzzyIndex];
                    app.pendingTrackPath = track.path;
                    app.isTrackLoading = false;
                    app.trackTitle.textContent = track.title || '未知标题';
                    app.trackArtist.textContent = track.artist || '未知艺术家';
                    app.trackBitrate.textContent = track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : '';
                    
                    const defaultArtUrl = `url('../assets/${app.currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
                    if (track.albumArt) {
                        const albumArtUrl = `url('file://${track.albumArt.replace(/\\/g, '/')}')`;
                        app.albumArt.style.backgroundImage = albumArtUrl;
                        app.updateBlurredBackground(albumArtUrl);
                    } else {
                        app.albumArt.style.backgroundImage = defaultArtUrl;
                        app.updateBlurredBackground(defaultArtUrl);
                    }
                    
                    app.renderPlaylist(app.currentFilteredTracks);
                    app.fetchAndDisplayLyrics(track.artist, track.title);
                    app.updateMediaSessionMetadata();

                    // 同样处理模糊匹配的情况
                    if (app.playModes[app.currentPlayMode] === 'shuffle') {
                        const activeList = app.currentFilteredTracks || app.playlist;
                        const posInActiveList = activeList.indexOf(track);
                        if (posInActiveList !== -1) {
                            const queueIndex = app.shuffleQueue.indexOf(posInActiveList);
                            if (queueIndex !== -1) {
                                console.log('[Music.js] Removing synced track (fuzzy) from shuffle queue at index:', queueIndex);
                                app.shuffleQueue.splice(queueIndex, 1);
                            }
                        }
                    }

                    if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
                } else {
                    console.warn('[Music.js] syncTrackIndexByPath: no match found for', normalizedPath);
                }
            } else {
                console.warn('[Music.js] syncTrackIndexByPath: no match found for', path);
            }
        }
    };

    app.startStatePolling = () => {
        if (app.statePollInterval) clearInterval(app.statePollInterval);
        app.statePollInterval = setInterval(app.pollState, 250);
    };

    app.stopStatePolling = () => {
        clearInterval(app.statePollInterval);
        app.statePollInterval = null;
    };
}
