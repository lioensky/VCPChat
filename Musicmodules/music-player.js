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

                while (Date.now() < timeoutAt) {
                    if (requestId !== app.pendingLoadRequestId) return false;

                    const stateResult = await window.electron.invoke('music-get-state');
                    if (stateResult && stateResult.status === 'success' && stateResult.state) {
                        const state = stateResult.state;
                        app.updateUIWithState(state);
                        const loadedPath = app.normalizePathForCompare(state.file_path);
                        if (loadedPath === targetPath && !state.is_loading) return true;
                    }
                    await new Promise(r => setTimeout(r, 120));
                }
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
        app.loadTrack(app.currentTrackIndex);
    };

    app.handleNeedsPreload = async () => {
        if (app.isPreloadingNext) return;
        const activeList = app.currentFilteredTracks || app.playlist;
        if (activeList.length <= 1) return;

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
                if (app.shuffleQueue.length > 0) {
                    nextTrackToPreload = activeList[app.shuffleQueue[0]];
                } else {
                    const temp = Array.from({ length: activeList.length }, (_, i) => i);
                    for (let i = temp.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [temp[i], temp[j]] = [temp[j], temp[i]];
                    }
                    if (temp.length > 0) nextTrackToPreload = activeList[temp[0]];
                }
                break;
        }

        if (nextTrackToPreload && nextTrackToPreload.path) {
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

    app.startStatePolling = () => {
        if (app.statePollInterval) clearInterval(app.statePollInterval);
        app.statePollInterval = setInterval(app.pollState, 250);
    };

    app.stopStatePolling = () => {
        clearInterval(app.statePollInterval);
        app.statePollInterval = null;
    };
}
