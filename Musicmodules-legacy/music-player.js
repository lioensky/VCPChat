// Musicmodules/music-player.js
// 核心播放逻辑

function setupPlayer(app) {
    let lastCapsuleSnapshot = '';
    app.publishCapsuleState = () => {
        const track = app.playlist[app.currentTrackIndex];
        const state = {
            title: track ? app.stripAudioExtension(track.title) || '未知标题' : '',
            trackKey: track?.path || '',
            playing: app.isPlaying === true
        };
        const snapshot = JSON.stringify(state);
        if (snapshot === lastCapsuleSnapshot) return;
        lastCapsuleSnapshot = snapshot;
        app.api?.publishMusicCapsuleState?.(state);
    };
    // --- 播放控制的三个约定 ---
    // 1. playIntent 记录用户最后一次想要的状态；加载期间按下的播放/暂停不丢，也不会被自动播放覆盖。
    // 2. 播放/暂停/跳转各走一次独立的 HTTP 请求，到达引擎的先后没有保证，所以这里串行发送。
    // 3. controlEpoch 在每次控制指令时递增；指令发出前就在路上的状态查询回来后直接丢弃。
    app.playIntent = false;
    app.controlEpoch = 0;
    app.statePollInFlight = false;
    app.engineLoadErrorSeq = 0;
    app.engineLoadError = '';
    app.engineLoadCompleteSeq = 0;
    app.engineLoadProgressAt = 0;
    let controlChain = Promise.resolve();
    let wakeLoadWait = null;
    let lastLoadSentAt = 0;
    const RAPID_SWITCH_WINDOW_MS = 400;
    const RAPID_SWITCH_SETTLE_MS = 180;
    app.engineTrackPath = null;

    // 播放/暂停只有“最后一次”有意义：排着队还没发出去的那条，直接被后来的顶替。
    // 这样不管是谁在短时间内反复触发（连点、媒体键、别的窗口发来的指令），
    // 队列里最多只有一条待发的播放/暂停，不会越积越多，引擎也不会被一串过期指令轮番折腾。
    let queuedTransport = null;
    app.enqueueControl = (send, kind) => {
        if (kind === 'transport' && queuedTransport) {
            const slot = queuedTransport;
            slot.resolve({ status: 'superseded' });
            return new Promise(resolve => { slot.send = send; slot.resolve = resolve; });
        }
        const slot = { send, resolve: null };
        const result = new Promise(resolve => { slot.resolve = resolve; });
        if (kind === 'transport') queuedTransport = slot;
        controlChain = controlChain.then(() => {
            if (queuedTransport === slot) queuedTransport = null;
            return Promise.resolve().then(() => slot.send()).catch(error => ({
                status: 'error',
                message: error?.message || String(error)
            })).then(value => slot.resolve(value));
        });
        return result;
    };

    const freezePlaybackClock = (wasPlaying) => {
        const now = Date.now();
        if (wasPlaying && app.lastStateUpdateTime) {
            app.lastKnownCurrentTime = (app.lastKnownCurrentTime || 0) + (now - app.lastStateUpdateTime) / 1000;
        }
        app.lastStateUpdateTime = now;
    };

    // 静音的占位 <audio> 只为让系统媒体键和耳机按键能控制播放。
    // 它的 play/pause 事件是异步派发的：我们自己调用 play()/pause() 之后，事件可能在
    // 几百毫秒后才到，那时界面状态也许已经又变了。如果把这种“回声”当成用户按了媒体键，
    // 就会反过来给引擎再发一次播放/暂停，和状态轮询互相触发，按钮来回抽搐、引擎被反复重启。
    // 所以每次主动调用都记一笔，事件到来时先销账，只有销不掉的才算外部操作。
    const PHANTOM_ECHO_WINDOW_MS = 3000;
    const phantomEchoes = { play: [], pause: [] };
    const externalPhantomEvents = [];
    let phantomStormWarned = false;
    const expectPhantomEvent = (type) => phantomEchoes[type].push(Date.now() + PHANTOM_ECHO_WINDOW_MS);
    const consumePhantomEcho = (type) => {
        const pending = phantomEchoes[type];
        const now = Date.now();
        while (pending.length && pending[0] < now) pending.shift();
        if (!pending.length) return false;
        pending.shift();
        return true;
    };

    app.setPhantomAudio = (playing) => {
        const audio = app.phantomAudio;
        if (!audio) return;
        if (playing) {
            audio.loop = true;
            if (audio.paused === false) return; // 已经在播，不会再派发事件
            expectPhantomEvent('play');
            Promise.resolve(audio.play()).catch(e => {
                // 被随后的 pause() 打断时 play 事件照样已经派发；只有被策略拒绝才不会有事件，撤销这一笔。
                if (e?.name === 'AbortError') return;
                phantomEchoes.play.shift();
                console.error("Phantom audio play failed:", e);
            });
        } else {
            if (audio.paused === true) return;
            expectPhantomEvent('pause');
            audio.pause();
        }
    };

    app.handlePhantomAudioEvent = (type) => {
        if (consumePhantomEcho(type)) return;
        if (app.isTrackLoading) return;
        // 真人按媒体键不可能一秒好几次；短时间内来了一串，说明有东西在自激，直接不理。
        const now = Date.now();
        while (externalPhantomEvents.length && externalPhantomEvents[0] < now - 2000) externalPhantomEvents.shift();
        if (externalPhantomEvents.length >= 4) {
            if (!phantomStormWarned) {
                phantomStormWarned = true;
                console.warn('[Music.js] Ignoring a burst of media play/pause events.');
            }
            return;
        }
        externalPhantomEvents.push(now);
        if (type === 'play' && !app.isPlaying) app.playTrack();
        else if (type === 'pause' && app.isPlaying) app.pauseTrack();
    };

    // 把界面切到“播放中 / 已暂停”。点击后立即调用，引擎确认失败时再回滚。
    app.applyPlayingUi = (playing) => {
        // 暂停期间歌词时钟不应继续走，否则恢复播放的第一帧会跳到后面的歌词。
        if (app.isPlaying !== playing) freezePlaybackClock(app.isPlaying === true);
        app.isPlaying = playing;
        app.publishCapsuleState();
        document.body.classList.toggle('music-playing', playing);
        app.playPauseBtn.classList.toggle('is-playing', playing);
        app.setPhantomAudio(playing);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
        if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
    };

    app.toggleTransport = () => (app.isTrackLoading ? app.playIntent : app.isPlaying)
        ? app.pauseTrack() : app.playTrack();

    app.showPlaybackNotice = (message) => {
        console.warn('[Music.js]', message);
        app.trackBitrate.textContent = message;
    };

    // 引擎通过 WebSocket 推送的加载事件，用来立刻结束等待，而不是轮询到超时。
    app.handleEngineLoadEvent = (message) => {
        if (message.type === 'load_error') {
            app.engineLoadError = message.error || '未知错误';
            app.engineLoadErrorSeq++;
        } else if (message.type === 'load_complete') {
            app.engineLoadCompleteSeq++;
        } else if (message.type === 'loading_progress') {
            app.engineLoadProgressAt = Date.now();
            return;
        }
        if (wakeLoadWait) wakeLoadWait();
    };

    app.loadTrack = async (trackIndex, andPlay = true) => {
        const requestId = ++app.pendingLoadRequestId;
        const skipHistory = app.skipHistoryOnce === true;
        app.skipHistoryOnce = false;
        const loadErrorSeq = app.engineLoadErrorSeq;
        app.controlEpoch++;
        app.playIntent = andPlay === true;
        // 切歌意图一出现就作废旧歌词，不能等取消预加载返回后才作废。
        app.resetLyrics();
        app.isPreloadingNext = false;
        try {
            await app.api?.cancelMusicPreload?.();
        } catch (e) {}
        if (requestId !== app.pendingLoadRequestId) return;

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
        try { localStorage.setItem('musicLastTrackPath', track.path); } catch (error) {}
        if (!skipHistory) app.rememberPlayed(track);
        app.engineTrackPath = null;
        app.isTrackLoading = true;
        app.applyPlayingUi(false);
        app.lastKnownCurrentTime = 0;
        app.lastStateUpdateTime = Date.now();
        app.lastEngineProgress = null;
        app.isChangingState = false;
        app.playPauseBtn.classList.toggle('is-playing', app.playIntent);

        app.trackTitle.textContent = app.stripAudioExtension(track.title) || '未知标题';
        app.trackArtist.textContent = track.artist || '未知艺术家';
        app.trackBitrate.textContent = track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : '';

        const defaultArtUrl = `url('../assets/${app.currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
        if (track.albumArt) {
            const albumArtUrl = `url('file://${track.albumArt.replace(/\\/g, '/')}')`;
            app.albumArt.style.backgroundImage = albumArtUrl;
            app.updateBlurredBackground(albumArtUrl);
        } else {
            app.albumArt.style.backgroundImage = defaultArtUrl;
            app.updateBlurredBackground('none');
        }

        app.renderPlaylist(app.currentFilteredTracks);
        app.scrollCurrentTrackToSidebarTop?.();
        app.fetchAndDisplayLyrics(track.artist, track.title, {
            duration: track.duration || 0,
            album: track.album || ''
        });
        app.updateMediaSessionMetadata();
        if (app.wnpAdapter) app.wnpAdapter.sendUpdate();

        // 旧歌的轮询到此为止；加载期间由下面的等待循环负责读状态。
        app.stopStatePolling();
        app.progress.style.width = '0%';
        app.currentTimeEl.textContent = app.formatTime(0);
        if (track.duration > 0) app.durationEl.textContent = app.formatTime(track.duration);

        // 连续快速切歌时只让引擎加载最后停下的那一首。
        // 引擎每收到一次加载都会起一个线程把整首歌解码完，连点五次就是五首歌同时在解码。
        const sinceLastLoad = Date.now() - lastLoadSentAt;
        if (sinceLastLoad < RAPID_SWITCH_WINDOW_MS) {
            await new Promise(resolve => setTimeout(resolve, RAPID_SWITCH_SETTLE_MS));
            if (requestId !== app.pendingLoadRequestId) return;
        }
        lastLoadSentAt = Date.now();

        const result = await app.enqueueControl(() => app.api.musicLoad(track));
        if (requestId !== app.pendingLoadRequestId) return;
        if (result && result.status === 'success') {
            const waitForTrackReady = async () => {
                const startedAt = Date.now();
                const targetPath = app.normalizePathForCompare(result.accepted_path || track.path);
                let pollInterval = 120;

                // 引擎会把整首歌解码完才算加载好，长曲目或开了升频会超过十几秒。
                // 只要还在收到解码进度就继续等，完全没动静才判超时。
                const deadline = () => Math.min(
                    startedAt + 120000,
                    Math.max(startedAt + 12000, (app.engineLoadProgressAt || 0) + 10000)
                );

                while (Date.now() < deadline()) {
                    if (requestId !== app.pendingLoadRequestId) return 'stale';
                    if (app.engineLoadErrorSeq !== loadErrorSeq) return 'error';

                    const stateResult = await app.api.getMusicState();
                    if (requestId !== app.pendingLoadRequestId) return 'stale';
                    if (app.engineLoadErrorSeq !== loadErrorSeq) return 'error';
                    if (stateResult && stateResult.status === 'success' && stateResult.state) {
                        const state = stateResult.state;
                        const loadedPath = app.normalizePathForCompare(state.file_path);
                        if (targetPath && loadedPath === targetPath && state.is_loading === false) {
                            app.updateUIWithState(state, { force: true });
                            return 'ready';
                        }
                    }
                    const completeSeq = app.engineLoadCompleteSeq;
                    await new Promise(resolve => {
                        const timer = setTimeout(done, pollInterval);
                        function done() {
                            clearTimeout(timer);
                            if (wakeLoadWait === done) wakeLoadWait = null;
                            resolve();
                        }
                        wakeLoadWait = done;
                        // 等待前事件就已经到了的情况。
                        if (app.engineLoadCompleteSeq !== completeSeq || app.engineLoadErrorSeq !== loadErrorSeq) done();
                    });
                    // 逐步增大轮询间隔，避免高频轮询（最大 500ms）
                    pollInterval = Math.min(pollInterval + 50, 500);
                }
                return 'timeout';
            };

            const outcome = await waitForTrackReady();
            if (requestId !== app.pendingLoadRequestId) return;
            app.isTrackLoading = false;
            if (outcome === 'ready') {
                app.engineTrackPath = track.path;
                app.publishCapsuleState();
                if (app.playIntent) app.playTrack();
                return;
            }
            app.playIntent = false;
            app.applyPlayingUi(false);
            app.showPlaybackNotice(outcome === 'error'
                ? `加载失败：${app.engineLoadError}`
                : '加载超时，请重试或换一首');
        } else {
            if (requestId !== app.pendingLoadRequestId) return;
            app.isTrackLoading = false;
            app.playIntent = false;
            app.applyPlayingUi(false);
            app.showPlaybackNotice(`加载失败：${result?.message || '音频引擎没有响应'}`);
        }
    };

    app.playTrack = async () => {
        if (app.playlist.length === 0) return;
        app.playIntent = true;
        if (app.isTrackLoading) {
            app.playPauseBtn.classList.toggle('is-playing', true);
            return;
        }
        // 当前这首并不在引擎里（上次加载失败或超时）：按播放就是重试加载，
        // 而不是对着空的引擎发一个“播放”然后界面假装在播。
        const current = app.playlist[app.currentTrackIndex];
        if (current && app.engineTrackPath !== current.path) {
            return app.loadTrack(app.currentTrackIndex, true);
        }
        const epoch = ++app.controlEpoch;
        app.isChangingState = true;
        app.lastCommandTime = Date.now();
        app.expectedPlayingState = true;
        app.applyPlayingUi(true);
        const result = await app.enqueueControl(() => app.api.musicPlay(), 'transport');
        if (epoch !== app.controlEpoch) return; // 已被更新的指令取代
        if (result?.status === 'success') {
            app.lastCommandTime = Date.now();
            app.startStatePolling();
        } else {
            app.playIntent = false;
            app.isChangingState = false;
            app.applyPlayingUi(false);
            app.showPlaybackNotice(`播放失败：${result?.message || '音频引擎没有响应'}`);
        }
    };

    app.pauseTrack = async () => {
        app.playIntent = false;
        if (app.isTrackLoading) {
            app.playPauseBtn.classList.toggle('is-playing', false);
            return;
        }
        const wasPlaying = app.isPlaying === true;
        const epoch = ++app.controlEpoch;
        app.isChangingState = true;
        app.lastCommandTime = Date.now();
        app.expectedPlayingState = false;
        app.applyPlayingUi(false);
        app.stopStatePolling();
        const result = await app.enqueueControl(() => app.api.musicPause(), 'transport');
        if (epoch !== app.controlEpoch) return;
        if (result?.status === 'success') {
            app.lastCommandTime = Date.now();
        } else if (wasPlaying && !app.isTrackLoading) {
            // 暂停没送达，引擎多半还在响，界面不能停在“已暂停”。
            app.isChangingState = false;
            app.playIntent = true;
            app.applyPlayingUi(true);
            app.startStatePolling();
            app.showPlaybackNotice(`暂停失败：${result?.message || '音频引擎没有响应'}`);
        }
    };

    app.seekTo = async (seconds) => {
        const epoch = ++app.controlEpoch;
        app.lastKnownCurrentTime = seconds;
        app.lastStateUpdateTime = Date.now();
        const result = await app.enqueueControl(() => app.api.seekMusic(seconds));
        if (epoch === app.controlEpoch && app.isPlaying) app.startStatePolling();
        return result;
    };

    // 最近播放过的曲目，供“上一首”回退。随机播放时“上一首”应该回到刚才听的那首，
    // 而不是总列表里排在前面的那首。
    const playHistory = [];
    app.rememberPlayed = (track) => {
        if (!track || playHistory[playHistory.length - 1] === track) return;
        playHistory.push(track);
        if (playHistory.length > 200) playHistory.shift();
    };

    app.prevTrack = () => {
        const activeList = app.currentFilteredTracks || app.playlist;
        if (activeList.length === 0) return;
        const currentTrack = app.playlist[app.currentTrackIndex];

        // 先按播放历史回退（历史里的歌可能已被移出列表，跳过）。
        if (playHistory[playHistory.length - 1] === currentTrack) playHistory.pop();
        while (playHistory.length > 0) {
            const index = app.playlist.indexOf(playHistory.pop());
            if (index === -1 || index === app.currentTrackIndex) continue;
            app.skipHistoryOnce = true;
            app.loadTrack(index);
            return;
        }

        // 没有历史：在当前显示的列表（搜索结果或自建歌单）里取前一首，不跳到列表之外。
        const position = activeList.indexOf(currentTrack);
        const previous = activeList[(Math.max(position, 0) - 1 + activeList.length) % activeList.length];
        const index = app.playlist.indexOf(previous);
        if (index !== -1) app.loadTrack(index);
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
                await app.api.queueNextMusicTrack({
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
        // 上一次查询还没回来就不再发，避免引擎忙时请求越堆越多、回包乱序。
        if (app.statePollInFlight || app.isTrackLoading) return;
        app.statePollInFlight = true;
        const epoch = app.controlEpoch;
        try {
            const result = await app.api.getMusicState();
            if (epoch !== app.controlEpoch || app.isTrackLoading) return;
            if (result?.status === 'success') app.updateUIWithState(result.state);
        } catch (error) {
            console.warn('[Music.js] pollState failed:', error?.message || error);
        } finally {
            app.statePollInFlight = false;
        }
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
            app.engineTrackPath = track.path;
            app.rememberPlayed(track);
            app.trackTitle.textContent = app.stripAudioExtension(track.title) || '未知标题';
            app.trackArtist.textContent = track.artist || '未知艺术家';
            app.trackBitrate.textContent = track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : '';
            
            const defaultArtUrl = `url('../assets/${app.currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
            if (track.albumArt) {
                const albumArtUrl = `url('file://${track.albumArt.replace(/\\/g, '/')}')`;
                app.albumArt.style.backgroundImage = albumArtUrl;
                app.updateBlurredBackground(albumArtUrl);
            } else {
                app.albumArt.style.backgroundImage = defaultArtUrl;
                app.updateBlurredBackground('none');
            }
            
            app.renderPlaylist(app.currentFilteredTracks);
            app.scrollCurrentTrackToSidebarTop?.();
            app.fetchAndDisplayLyrics(track.artist, track.title, {
                duration: track.duration || 0,
                album: track.album || ''
            });
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
                    app.engineTrackPath = track.path;
                    app.rememberPlayed(track);
                    app.trackTitle.textContent = app.stripAudioExtension(track.title) || '未知标题';
                    app.trackArtist.textContent = track.artist || '未知艺术家';
                    app.trackBitrate.textContent = track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : '';
                    
                    const defaultArtUrl = `url('../assets/${app.currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
                    if (track.albumArt) {
                        const albumArtUrl = `url('file://${track.albumArt.replace(/\\/g, '/')}')`;
                        app.albumArt.style.backgroundImage = albumArtUrl;
                        app.updateBlurredBackground(albumArtUrl);
                    } else {
                        app.albumArt.style.backgroundImage = defaultArtUrl;
                        app.updateBlurredBackground('none');
                    }
                    
                    app.renderPlaylist(app.currentFilteredTracks);
                    app.scrollCurrentTrackToSidebarTop?.();
                    app.fetchAndDisplayLyrics(track.artist, track.title, {
                        duration: track.duration || 0,
                        album: track.album || ''
                    });
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

    const syncTrackIndexByPath = app.syncTrackIndexByPath;
    app.syncTrackIndexByPath = (path) => {
        syncTrackIndexByPath(path);
        app.publishCapsuleState();
    };

    // 歌词和进度在两次查询之间按本地时钟推算，查询只用来校准，不需要每秒 4 次。
    // 窗口不可见时再降到 2 秒一次，只为外部的“正在播放”信息保持更新。
    let hiddenPollSkips = 0;
    app.startStatePolling = () => {
        if (app.statePollInterval) clearInterval(app.statePollInterval);
        app.statePollInterval = setInterval(() => {
            if (document.hidden && ++hiddenPollSkips % 4 !== 0) return;
            app.pollState();
        }, 500);
        app.pollState();
    };

    app.stopStatePolling = () => {
        clearInterval(app.statePollInterval);
        app.statePollInterval = null;
    };
}
