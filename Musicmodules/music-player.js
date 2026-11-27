// Musicmodules/music-player.js
// 核心播放逻辑

// 引擎报错是英文原文（Rust 的错误串），直接拼进提示里看不懂。常见几类换成一句能照着做的中文，
// 认不出的原样保留，免得把真正的原因藏掉。
function describeEngineError(raw) {
    const text = String(raw || '').trim();
    const t = text.toLowerCase();
    const rules = [
        // 主进程连本机音频引擎失败时 Node 只给「fetch failed」：引擎进程退出了，不是网络问题
        [/^fetch failed$|socket hang up|econnrefused 127\.0\.0\.1|econnrefused ::1|econnrefused localhost/, '连不上音频引擎（可能已经退出），关掉音乐窗口再打开试试'],
        [/no song loaded/, '还没有加载歌曲'],
        [/private\/internal address/, '这台 WebDAV 服务器在内网，当前音频引擎不允许访问，更新音频引擎后就能放'],
        [/file not found|no such file|cannot find the (file|path)|系统找不到|os error [23]\b/, '文件不在原来的位置了（被移动、改名，或所在的盘没插上）'],
        [/access is denied|permission denied|拒绝访问|os error 5\b/, '没有权限读取这个文件'],
        [/\b401\b|unauthorized/, 'WebDAV 账号或密码不对'],
        [/\b403\b|forbidden/, 'WebDAV 服务器拒绝了访问'],
        [/\b404\b/, '服务器上找不到这首歌了'],
        [/timed out|timeout|error sending request|connection (refused|reset)|dns|failed to lookup/, '连不上服务器，检查网络或 WebDAV 地址'],
        [/unsupported (format|codec)|no audio track|unsupported feature|probe error/, '不支持这种音频格式'],
        [/decoded track is empty/, '文件里没有可播放的声音'],
        [/malformed|invalid data|corrupt|end of stream|unexpected eof|format error|decoder error/, '文件已损坏或不完整'],
        [/too large for non-range/, '文件太大，服务器又不支持分段下载'],
    ];
    for (const [pattern, message] of rules) if (pattern.test(t)) return message;
    // 主进程的超时说明末尾带着接口路径（「…没有响应（/play）」），给人看时去掉
    return text.replace(/（\/[\w-]+）$/, '');
}

function setupPlayer(app) {
    let lastCapsuleSnapshot = '';
    app.publishCapsuleState = () => {
        const track = app.playlist[app.currentTrackIndex];
        const state = {
            title: track ? app.stripAudioExtension(track.title) || '未知标题' : '',
            artist: track?.artist || '',
            album: track?.album || '',
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

    // --- 引擎推送（协议 2）---
    // 新引擎连上 WebSocket 后先发 hello，之后播放状态由引擎主动推送 playback_state，
    // 不再需要轮询。每条控制指令在引擎里拿到一个递增的 cmd_seq，推送里的 applied_seq
    // 表示音频线程已经执行到哪一条：小于本窗口最后一条指令序号的推送一定是旧状态，直接丢弃。
    // 旧引擎没有 hello，继续走轮询。
    app.enginePush = false;
    app.latestEnginePush = null;
    app.lastIssuedCmdSeq = 0;
    app.controlsInFlight = 0;
    app.isBuffering = false;

    app.noteCommandResult = (result) => {
        const seq = Number(result?.state?.cmd_seq);
        if (Number.isFinite(seq) && seq > app.lastIssuedCmdSeq) app.lastIssuedCmdSeq = seq;
        return result;
    };

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
            app.controlsInFlight++;
            return Promise.resolve().then(() => slot.send()).catch(error => ({
                status: 'error',
                message: error?.message || String(error)
            })).then(value => {
                app.controlsInFlight--;
                app.noteCommandResult(value);
                // 指令在路上时到达的推送被搁置了；如果它已经反映了这条指令，现在补用。
                if (app.controlsInFlight === 0 && app.latestEnginePush) {
                    const latest = app.latestEnginePush;
                    Promise.resolve().then(() => app.handleEnginePlaybackState(latest));
                }
                slot.resolve(value);
            });
        });
        return result;
    };

    app.handleEngineHello = (message) => {
        const features = Array.isArray(message?.features) ? message.features : [];
        app.enginePush = Number(message?.protocol) >= 2 && features.includes('playback_state');
        app.latestEnginePush = null;
        if (app.enginePush) {
            console.log('[Music.js] Engine pushes playback state; polling off.');
            app.stopStatePolling();
        }
    };

    // WebSocket 断开时退回轮询，重连收到 hello 后再关掉。
    app.handleEngineDisconnected = () => {
        const hadPush = app.enginePush;
        app.enginePush = false;
        if (hadPush && app.isPlaying && !app.isTrackLoading) app.startStatePolling();
    };

    app.handleEnginePlaybackState = (message) => {
        if (!app.enginePush || !message) return;
        if (app.latestEnginePush && Number(message.rev) < Number(app.latestEnginePush.rev)) return;
        app.latestEnginePush = message;
        // 指令还在路上，或者推送反映的是本窗口最后一条指令之前的状态：不用。
        if (app.controlsInFlight > 0) return;
        if (Number(message.applied_seq) < app.lastIssuedCmdSeq) return;
        // 加载期间由 loadTrack 等 load_complete，推送不碰界面。
        if (app.isTrackLoading) return;

        const buffering = message.state === 'buffering';
        if (buffering !== app.isBuffering) {
            app.isBuffering = buffering;
            document.body.classList.toggle('music-buffering', buffering);
        }
        // 已确认的状态，不需要乐观更新的防抖保护。
        app.isChangingState = false;
        app.updateUIWithState({
            is_playing: message.is_playing === true,
            is_loading: message.state === 'loading',
            current_time: Number(message.position) || 0,
            duration: Number(message.duration) || 0,
            file_path: message.file_path
        }, { confirmed: true });
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
        // 事件说的状态和占位音频此刻的状态对不上，就是迟到的回声（比如我们刚 play() 又 pause()，
        // 机器很卡时 play 事件过了销账的时限才到）。真按媒体键时，事件到的那一刻两边是一致的。
        const audio = app.phantomAudio;
        if (audio && typeof audio.paused === 'boolean' && audio.paused !== (type === 'pause')) return;
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
        app.syncMediaPosition?.(true);
        if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
    };

    app.toggleTransport = () => (app.isTrackLoading ? app.playIntent : app.isPlaying)
        ? app.pauseTrack() : app.playTrack();

    app.showPlaybackNotice = (message) => {
        console.warn('[Music.js]', message);
        app.trackBitrate.textContent = message;
    };

    // 一首歌放不了（文件不在了、解码失败、引擎没回应）时：
    // 提示条给「跳过」，几秒后自己跳到下一首；连着几首都放不了就停下来说明，
    // 不会把整张列表一路刷过去。只有本来就要播放时才自动跳，启动时恢复上次那首失败只提示。
    const FAILURE_STOP_AFTER = 3;
    const FAILURE_TOAST_ID = 'playback-failure';
    app.failureSkipDelayMs = 3000;
    app.failureStreak = 0;
    let failureSkipTimer = null;
    let failureSkip = null;
    const failureToast = (opts) => {
        try { return globalThis.MusicToast?.show?.({ id: FAILURE_TOAST_ID, kind: 'error', ...opts }) || null; } catch (error) { return null; }
    };
    app.cancelFailureSkip = () => {
        clearTimeout(failureSkipTimer);
        failureSkipTimer = null;
        failureSkip = null;
    };
    const clearFailureNotice = () => {
        app.cancelFailureSkip();
        try { globalThis.MusicToast?.dismiss?.(FAILURE_TOAST_ID); } catch (error) {}
    };
    // 本次打开窗口里放不出来的歌：列表上标灰并写明原因，下次放成功就去掉（文件可能只是暂时读不到）。
    app.failedTracks = new Map();
    const markFailed = (track, detail) => {
        if (!track) return;
        const had = app.failedTracks.has(track);
        if (detail) app.failedTracks.set(track, detail); else app.failedTracks.delete(track);
        if (had === Boolean(detail) && !detail) return;
        try { globalThis.document?.dispatchEvent?.(new CustomEvent('music-track-health', { detail: { track, failed: Boolean(detail), reason: detail || '' } })); } catch (error) {}
    };
    // 连不上本机音频引擎（进程退出了）：不是这首歌的问题。以前照样把歌标灰成「坏文件」、几秒后跳下一首，
    // 下一首也一样失败，连着把好几首好好的歌都标坏。
    const ENGINE_GONE = /^fetch failed$|socket hang up|econnrefused (127\.0\.0\.1|::1|localhost)/i;
    app.isEngineGone = (message) => ENGINE_GONE.test(String(message || '').trim());
    const handleLoadFailure = (track, reason, requestId, wanted) => {
        const name = app.stripAudioExtension(track?.title) || '这首歌';
        const raw = String(reason);
        const rawReason = raw.startsWith('加载失败：') ? raw.slice(5) : raw;
        if (app.isEngineGone(rawReason)) {
            app.cancelFailureSkip?.();
            app.failureStreak = 0;
            app.showPlaybackNotice(`加载中断：${describeEngineError(rawReason)}`);
            return;
        }
        const detail = raw.startsWith('加载失败：') ? describeEngineError(raw.slice(5)) : raw;
        markFailed(track, detail || '无法播放');
        app.showPlaybackNotice(raw.startsWith('加载失败：') ? `加载失败：${detail}` : raw);
        if (!wanted) {
            failureToast({ message: `无法播放「${name}」：${detail}` });
            return;
        }
        // 曲库里还有同一首的另一份文件（别的格式、别的文件夹）：直接换那份接着放，不跳到下一首
        const alt = typeof app.alternateCopy === 'function' ? app.alternateCopy(track) : null;
        const altIndex = alt ? (app.playlist || []).indexOf(alt) : -1;
        if (altIndex >= 0 && requestId === app.pendingLoadRequestId) {
            app.cancelFailureSkip();
            const queue = app.currentFilteredTracks;
            if (Array.isArray(queue) && queue !== app.playlist) {
                const at = queue.indexOf(track);
                if (at >= 0 && !queue.includes(alt)) queue[at] = alt;
            }
            const ext = (t) => String(t.path || '').split('.').pop().toUpperCase();
            failureToast({ message: `「${name}」这份文件放不了（${detail}），换成了同一首的 ${ext(alt)} 版本` });
            app.loadTrack(altIndex, true);
            return;
        }
        app.failureStreak += 1;
        if (app.failureStreak >= FAILURE_STOP_AFTER) {
            const count = app.failureStreak;
            app.failureStreak = 0;
            app.cancelFailureSkip();
            failureToast({ message: `连续 ${count} 首无法播放，已停止。请检查文件是否还在原位置`, duration: 8000 });
            return;
        }
        const skip = () => {
            if (failureSkip !== skip) return; // 已经跳过，或用户自己换了歌
            app.cancelFailureSkip();
            if (requestId !== app.pendingLoadRequestId) return;
            app.nextTrack();
        };
        app.cancelFailureSkip();
        failureSkip = skip;
        const seconds = Math.max(1, Math.round(app.failureSkipDelayMs / 1000));
        const toast = failureToast({
            message: `无法播放「${name}」：${detail}`,
            action: { label: '跳过', run: skip, countdown: seconds }
        });
        // 提示层在时由它的倒计时触发；不在时（或倒计时被悬停拖住）由这个定时器兜底。
        failureSkipTimer = setTimeout(skip, toast ? app.failureSkipDelayMs + 4000 : app.failureSkipDelayMs);
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

    // 把一首歌摆上界面：标题、封面、列表位置、歌词、系统媒体信息。点播和无缝切歌共用。
    const showTrack = (track) => {
        app.trackTitle.textContent = app.stripAudioExtension(track.title) || '未知标题';
        app.trackArtist.textContent = track.artist || '未知艺术家';
        app.trackBitrate.textContent = track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : '';

        const defaultArtUrl = `url('../assets/${app.currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
        if (track.albumArt) {
            const albumArtUrl = `url("${app.fileUrl(track.albumArt)}")`;
            app.albumArt.style.backgroundImage = albumArtUrl;
            app.updateBlurredBackground(albumArtUrl);
        } else {
            app.albumArt.style.backgroundImage = defaultArtUrl;
            app.updateBlurredBackground('none');
        }

        app.renderPlaylist(app.currentFilteredTracks);
        app.scrollCurrentTrackToSidebarTop?.();
        app.fetchAndDisplayLyrics(track.artist, track.title, {
            path: track.path,
            duration: track.duration || 0,
            album: track.album || ''
        });
        app.updateMediaSessionMetadata();
        app.syncMediaPosition?.(true);
    };

    let preloadClearTimer = null;
    app.loadTrack = async (trackIndex, andPlay = true) => {
        const requestId = ++app.pendingLoadRequestId;
        const skipHistory = app.skipHistoryOnce === true;
        app.skipHistoryOnce = false;
        const loadErrorSeq = app.engineLoadErrorSeq;
        app.controlEpoch++;
        app.playIntent = andPlay === true;
        clearFailureNotice();
        // 切歌意图一出现就作废旧歌词，不能等取消预加载返回后才作废。
        app.resetLyrics();
        if (preloadClearTimer) { clearTimeout(preloadClearTimer); preloadClearTimer = null; }
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

        const track = app.playlist[trackIndex];
        if (!track) {
            // 上下文里的歌已经不在曲库了（被删、或者曲库刚重载）：不去加载第 -1 首。
            console.warn('[Music.js] loadTrack: no track at index', trackIndex);
            if (app.playIntent) app.applyPlayingUi(false);
            app.playIntent = false;
            return;
        }
        app.currentTrackIndex = trackIndex;
        app.pendingTrackPath = track.path;
        try { localStorage.setItem('musicLastTrackPath', track.path); } catch (error) {}
        scheduleSessionSave();
        if (!skipHistory) app.rememberPlayed(track);
        app.engineTrackPath = null;
        app.isTrackLoading = true;
        app.applyPlayingUi(false);
        app.lastKnownCurrentTime = 0;
        app.lastStateUpdateTime = Date.now();
        app.resetEngineProgress?.();
        app.isChangingState = false;
        app.playPauseBtn.classList.toggle('is-playing', app.playIntent);

        showTrack(track);
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
                let unreachable = 0;

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
                    // 引擎进程没了：连着几次连不上就别再等满超时，直接按「连不上引擎」收尾
                    if (stateResult?.status !== 'success' && app.isEngineGone(stateResult?.message)) {
                        if (++unreachable >= 6) { app.engineLoadError = stateResult.message; return 'error'; }
                    } else unreachable = 0;
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
                app.failureStreak = 0;
                if (app.failedTracks.has(track)) markFailed(track, '');
                app.engineTrackPath = track.path;
                app.publishCapsuleState();
                if (app.playIntent) app.playTrack();
                return;
            }
            const wanted = app.playIntent === true;
            app.playIntent = false;
            app.applyPlayingUi(false);
            handleLoadFailure(track, outcome === 'error'
                ? `加载失败：${app.engineLoadError}`
                : '加载超时，请重试或换一首', requestId, wanted);
        } else {
            if (requestId !== app.pendingLoadRequestId) return;
            const wanted = app.playIntent === true;
            app.isTrackLoading = false;
            app.playIntent = false;
            app.applyPlayingUi(false);
            handleLoadFailure(track, `加载失败：${result?.message || '音频引擎没有响应'}`, requestId, wanted);
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
            app.checkOutputFallbackSoon?.();
        } else {
            app.playIntent = false;
            app.isChangingState = false;
            app.applyPlayingUi(false);
            app.showPlaybackNotice(`播放失败：${result?.message ? describeEngineError(result.message) : '音频引擎没有响应'}`);
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
            app.showPlaybackNotice(`暂停失败：${result?.message ? describeEngineError(result.message) : '音频引擎没有响应'}`);
        }
    };

    app.seekTo = async (seconds) => {
        // 时长还不知道（0）或进度条量不到宽度时会算出 NaN；引擎把 NaN 当 0，歌会跳回开头。
        if (!Number.isFinite(seconds) || seconds < 0) return { status: 'error', message: 'invalid seek position' };
        const epoch = ++app.controlEpoch;
        app.lastKnownCurrentTime = seconds;
        app.lastStateUpdateTime = Date.now();
        app.syncMediaPosition?.(true);
        app.syncLyricsAfterSeek?.();
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
    // 播放过的（不含正在放的这首），旧的在前、最近的在后；队列页顶上的「播放过的」用
    app.getHistory = (limit = 30) => {
        const current = app.playlist[app.currentTrackIndex];
        const list = playHistory.slice();
        while (list.length && list[list.length - 1] === current) list.pop();
        if (!list.length) return [];
        const live = getLibrarySet();
        return list.filter((t) => live.has(t)).slice(-limit);
    };

    // ───────── 播放队列 ─────────
    // 两层：手动层（「下一首播放」插到最前，「加入队列」排到最后）先放完，再回到上下文层
    // （当前列表按播放模式走）。自动预载只读队列，不往队列里写。
    // 放手动层的歌时记下进队列前上下文放到哪一首，放完从那里接着走，而不是从手动的那首往后数。
    app.manualQueue = [];
    app.queueAnchor = null; // { from: 上下文里最后放的那首, playing: 正在放的手动曲目 }
    app.preloadIssuedFor = null;

    // 曲库数组被整个换掉（重新扫描文件夹、删歌、云端导入）时，新数组里是同路径的新对象。
    // 上下文列表、手动队列、播放历史、随机顺序都按对象身份找歌，留着旧对象就会
    // 「下一首」去加载第 -1 首、队列被当成全部失效清空。这里按路径换成新对象，曲库里没有了的去掉。
    // 每次用到这些列表前调一次；曲库数组没换就直接返回。
    let reconciledLibrary = app.playlist;
    let reconciledLength = Array.isArray(app.playlist) ? app.playlist.length : 0;
    const reconcileLibrary = () => {
        const library = app.playlist;
        if (!Array.isArray(library) || (reconciledLibrary === library && reconciledLength === library.length)) return;
        // 同一个数组里删了或插回一首（右键移出曲库、撤销）：按下标存的随机顺序全错位了，重洗。
        if (reconciledLibrary === library && app.lastShuffleList === library) { app.shuffleQueue = []; app.lastShuffleList = null; }
        reconciledLibrary = library;
        reconciledLength = library.length;
        const live = new Set(library);
        const stale = (t) => Boolean(t) && !live.has(t);
        const ctx = app.currentFilteredTracks;
        const anchor = app.queueAnchor;
        const shuffleList = app.lastShuffleList;
        const needed = (Array.isArray(ctx) && ctx.some(stale)) || app.manualQueue.some(stale) || playHistory.some(stale)
            || Boolean(anchor && (stale(anchor.from) || stale(anchor.playing)))
            || (Array.isArray(shuffleList) && shuffleList !== library && shuffleList !== ctx);
        if (!needed) return;
        const map = byPathMap();
        const swap = (t) => (!t ? null : live.has(t) ? t : lookup(map, t.path));
        if (Array.isArray(ctx)) {
            const list = ctx.map(swap).filter(Boolean);
            app.currentFilteredTracks = list.length ? list : null;
            if (app.playbackContext && app.playbackContext.list === ctx) app.playbackContext.list = app.currentFilteredTracks;
        }
        const active = app.currentFilteredTracks || library;
        // 随机顺序存的是上下文里的下标：歌数没变就沿用，变了就让它重洗。
        if (Array.isArray(shuffleList) && shuffleList !== active) {
            if (shuffleList.length === active.length) app.lastShuffleList = active;
            else { app.shuffleQueue = []; app.lastShuffleList = null; }
        }
        app.manualQueue = app.manualQueue.map(swap).filter(Boolean);
        const history = playHistory.map(swap).filter(Boolean);
        playHistory.length = 0;
        playHistory.push(...history);
        if (anchor) {
            const from = swap(anchor.from);
            const playing = swap(anchor.playing);
            app.queueAnchor = from && playing ? { from, playing } : null;
        }
        announceQueue();
    };
    app.reconcileLibrary = reconcileLibrary;

    const contextCurrent = () => {
        const current = app.playlist[app.currentTrackIndex];
        const anchor = app.queueAnchor;
        return anchor && anchor.playing === current && getLibrarySet().has(anchor.from) ? anchor.from : current;
    };
    const manualHead = () => {
        reconcileLibrary();
        if (app.manualQueue.length) {
            const lib = getLibrarySet();
            while (app.manualQueue.length && !lib.has(app.manualQueue[0])) app.manualQueue.shift();
        }
        return app.playModes?.[app.currentPlayMode] === 'repeat-one' ? null : (app.manualQueue[0] || null);
    };
    const beginManual = (track) => {
        const from = contextCurrent();
        app.manualQueue.shift();
        app.queueAnchor = { from, playing: track };
        // 这首在随机这一轮里也算放过了，不然之后还会再随到它。
        const activeList = app.currentFilteredTracks || app.playlist;
        if (app.lastShuffleList === activeList && Array.isArray(app.shuffleQueue)) {
            const at = app.shuffleQueue.indexOf(activeList.indexOf(track));
            if (at !== -1) app.shuffleQueue.splice(at, 1);
        }
        announceQueue();
    };
    const announceQueue = () => {
        try { document.dispatchEvent(new CustomEvent('music-queue-change')); } catch (error) { /* 没有 DOM 时忽略 */ }
    };
    // 引擎的预载槽已经按旧队列填过了，就按新队列重填一次。
    // 播放模式、曲库或歌单变了也要重填：引擎是自己无缝切进预载的那首的，界面来不及拦。
    // 新队列里没有该预载的（比如只剩一首）就把旧的预载撤掉，免得接着放一首已经移除的歌。
    let refreshPreloadTimer = null;
    const refreshPreload = () => {
        if (refreshPreloadTimer) { clearTimeout(refreshPreloadTimer); refreshPreloadTimer = null; }
        const current = app.playlist[app.currentTrackIndex];
        if (!current || app.preloadIssuedFor !== current.path) return;
        if (app.isPreloadingNext) {
            refreshPreloadTimer = setTimeout(() => { refreshPreloadTimer = null; refreshPreload(); }, 600);
            return;
        }
        // 引擎的预载槽一旦解码好就不再接受新的 queue_next，所以先撤掉旧的再重填。
        app.preloadIssuedFor = null;
        Promise.resolve(app.api?.cancelMusicPreload?.())
            .then(() => {
                if (app.playlist[app.currentTrackIndex] !== current) return; // 这期间已经换歌，换歌自己会重新预载
                return app.handleNeedsPreload();
            })
            .catch((error) => console.warn('[Music.js] Refreshing preload failed:', error?.message || error));
    };
    app.refreshPreload = refreshPreload;
    let queueBatchDepth = 0;
    let queueBatchDirty = false;
    const queueChanged = () => {
        if (queueBatchDepth > 0) { queueBatchDirty = true; return; }
        announceQueue();
        refreshPreload();
    };
    app.queueBatch = (fn) => {
        queueBatchDepth += 1;
        try {
            return fn();
        } finally {
            queueBatchDepth -= 1;
            if (queueBatchDepth === 0 && queueBatchDirty) {
                queueBatchDirty = false;
                queueChanged();
            }
        }
    };
    const resolveTrack = (ref) => {
        if (ref == null) return null;
        if (typeof ref === 'number') return app.playlist[ref] || null;
        if (typeof ref === 'string') return lookup(byPathMap(), ref);
        return getLibrarySet().has(ref) ? ref : (ref.path ? lookup(byPathMap(), ref.path) : null);
    };
    const enqueue = (ref, atFront) => {
        const track = resolveTrack(ref);
        if (!track) return null;
        const at = app.manualQueue.indexOf(track);
        if (at !== -1) app.manualQueue.splice(at, 1); // 已经在队列里就挪过去，不重复
        if (atFront) app.manualQueue.unshift(track); else app.manualQueue.push(track);
        queueChanged();
        return track;
    };
    app.queuePlayNext = (ref) => enqueue(ref, true);
    app.queueAdd = (ref) => enqueue(ref, false);
    app.queueRemove = (index) => {
        if (index < 0 || index >= app.manualQueue.length) return null;
        const [track] = app.manualQueue.splice(index, 1);
        queueChanged();
        return track;
    };
    app.queueMove = (from, to) => {
        const n = app.manualQueue.length;
        if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
        const [track] = app.manualQueue.splice(from, 1);
        app.manualQueue.splice(to, 0, track);
        queueChanged();
    };
    app.queueClear = () => {
        if (!app.manualQueue.length) return;
        app.manualQueue = [];
        queueChanged();
    };

    // 撤销一次入队：before 是入队前队列的样子（queueSnapshot() 取的），tracks 是这次加进去的歌。
    // 原来不在队列里的拿掉；原来就在队列里、只是被挪了位置的，放回原来排在谁后面的位置，不拿掉。
    // 撤销前已经放掉（不在队列里了）的不再加回来，入队之后别处的改动也不动。
    app.queueSnapshot = () => app.manualQueue.slice();
    app.queueRevert = (tracks, before) => {
        const touched = new Set((tracks || []).filter(t => app.manualQueue.includes(t)));
        if (!touched.size) return;
        const rest = app.manualQueue.filter(t => !touched.has(t));
        for (const t of before || []) {
            if (!touched.has(t)) continue;
            const at = before.indexOf(t);
            let after = -1;
            for (let k = at - 1; k >= 0; k--) {
                const i = rest.indexOf(before[k]);
                if (i !== -1) { after = i; break; }
            }
            rest.splice(after + 1, 0, t);
        }
        app.manualQueue = rest;
        queueChanged();
    };

    // ───────── 从某一组点播 ─────────
    // 档案页的列、目录分组、经典列表都走这一个入口：把「看到的这一组、按看到的顺序」设成上下文队列，再放其中一首。
    // list 为空或就是整个曲库原顺序时记为 null（= 整个曲库）。origin 记下是从哪来的（如 'classic'），
    // 之后那里的排序变了可以跟着更新。
    app.playFromContext = (list, index, { source = null, origin = null, render = true, play = true } = {}) => {
        const tracks = Array.isArray(list) ? list.filter(Boolean) : null;
        const whole = !tracks || (tracks.length === app.playlist.length && tracks.every((t, i) => t === app.playlist[i]));
        app.currentFilteredTracks = whole ? null : tracks;
        app.filteredPlaylistSource = source || null;
        // 记下这次设的是哪一份列表：之后别处（档案页等）换了上下文，这条记录就不再算数。
        app.playbackContext = { origin: origin || null, list: app.currentFilteredTracks, source: app.filteredPlaylistSource };
        if (render) { try { app.renderPlaylist?.(app.currentFilteredTracks); } catch (error) { /* 旧列表只是同步显示 */ } }
        return app.loadTrack(index, play);
    };
    // 正在放的列表叫什么：来自歌单时按 id 取歌单现在的名字（播放中改了名，队列标题跟着改）；歌单删了就还叫原来的名字。
    app.playbackSourceName = (source = app.filteredPlaylistSource) => {
        if (!source) return '';
        if (source.type === 'playlist' && source.id != null && Array.isArray(app.customPlaylists)) {
            const pl = app.customPlaylists.find((p) => p && String(p.id) === String(source.id));
            if (pl && pl.name) return pl.name;
        }
        return source.name || '';
    };
    // 上下文的顺序变了（比如经典列表换了排序），但还是同一组歌：换成新顺序，不打断播放。
    app.contextFrom = (origin) => {
        const ctx = app.playbackContext;
        return Boolean(ctx && ctx.origin === origin && ctx.list === app.currentFilteredTracks && ctx.source === app.filteredPlaylistSource);
    };
    app.reorderContext = (list, origin = null) => {
        if (origin && !app.contextFrom(origin)) return false;
        const current = app.currentFilteredTracks || app.playlist;
        if (!Array.isArray(list) || list.length !== current.length) return false;
        const members = new Set(current);
        if (!list.every(t => members.has(t))) return false;
        if (list.every((t, i) => t === current[i])) return false;
        const whole = list.every((t, i) => t === app.playlist[i]);
        app.currentFilteredTracks = whole ? null : list.slice();
        if (app.playbackContext) app.playbackContext.list = app.currentFilteredTracks;
        announceQueue();
        scheduleSessionSave();
        return true;
    };

    // ───────── 系统媒体控制：进度条和拖动 ─────────
    // 系统的媒体浮层按 setPositionState 给的位置和速率自己往前推，所以只在会跳变的时候报：
    // 切歌、播放/暂停、拖动、时长变了，或者引擎报的进度和推算的差了 1 秒以上。
    const mediaSession = () => (typeof navigator !== 'undefined' && navigator && navigator.mediaSession) || null;
    let mediaPosition = null; // 上次报给系统的 { position, duration, playing, at }
    const nowMs = () => Date.now();
    app.syncMediaPosition = (force = false) => {
        const session = mediaSession();
        if (!session || typeof session.setPositionState !== 'function') return false;
        const duration = Number(app.lastKnownDuration) || 0;
        const playing = app.isPlaying === true;
        if (!(duration > 0)) {
            if (mediaPosition) { try { session.setPositionState(); } catch (error) { /* 旧内核不认空参数 */ } mediaPosition = null; }
            return false;
        }
        const elapsed = playing && app.lastStateUpdateTime ? (nowMs() - app.lastStateUpdateTime) / 1000 : 0;
        const position = Math.min(duration, Math.max(0, (Number(app.lastKnownCurrentTime) || 0) + elapsed));
        if (!force && mediaPosition && mediaPosition.duration === duration && mediaPosition.playing === playing) {
            const expected = mediaPosition.position + (playing ? (nowMs() - mediaPosition.at) / 1000 : 0);
            if (Math.abs(expected - position) < 1) return false;
        }
        try {
            session.setPositionState({ duration, playbackRate: 1, position });
            mediaPosition = { position, duration, playing, at: nowMs() };
            return true;
        } catch (error) {
            mediaPosition = null;
            return false;
        }
    };
    {
        const session = mediaSession();
        if (session && typeof session.setActionHandler === 'function') {
            try {
                session.setActionHandler('seekto', (details) => {
                    const time = Number(details && details.seekTime);
                    if (!Number.isFinite(time)) return;
                    const duration = Number(app.lastKnownDuration) || 0;
                    app.seekTo(Math.max(0, duration > 0 ? Math.min(time, Math.max(0, duration - 0.5)) : time));
                });
            } catch (error) { /* 不支持 seekto 的内核就只有上一首/下一首 */ }
        }
    }

    // ───────── 歌词偏移和翻译开关 ─────────
    // 偏移按歌记住（路径 → 秒，正数是歌词推后），换歌时先取出来，解析歌词时就带上。
    // 调整时直接平移已经解析好的时间轴，不重新读歌词。翻译开关是全局的，只管显示。
    const LYRIC_OFFSETS_KEY = 'musicLyricOffsets';
    const LYRIC_TRANSLATION_KEY = 'musicLyricsTranslation';
    const LYRIC_OFFSET_LIMIT = 30;
    const MAX_LYRIC_OFFSETS = 500;
    const readStore = (key, fallback) => {
        try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); } catch (error) { return fallback; }
    };
    const writeStore = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* 存不了就只在本次生效 */ } };
    let offsetsRawCache = undefined;
    let offsetsMapCache = null;
    const readOffsets = () => {
        try {
            const raw = localStorage.getItem(LYRIC_OFFSETS_KEY);
            if (raw === offsetsRawCache && offsetsMapCache) return offsetsMapCache;
            offsetsRawCache = raw;
            const parsed = raw == null ? {} : JSON.parse(raw);
            offsetsMapCache = parsed && typeof parsed === 'object' ? parsed : {};
            return offsetsMapCache;
        } catch (error) {
            return {};
        }
    };
    const writeOffsets = (offsets) => {
        try {
            const raw = JSON.stringify(offsets);
            localStorage.setItem(LYRIC_OFFSETS_KEY, raw);
            offsetsRawCache = raw;
            offsetsMapCache = offsets;
        } catch (error) { /* 存不了就只在本次生效 */ }
    };
    app.lyricOffsetFor = (path) => {
        if (!path) return 0;
        const offsets = readOffsets();
        const value = Number(offsets && offsets[path]);
        return Number.isFinite(value) ? value : 0;
    };
    const lyricTrackPath = () => app.playlist?.[app.currentTrackIndex]?.path || null;
    const shiftLine = (line, d) => {
        for (const k of ['time', 'startTime', 'endTime']) if (typeof line[k] === 'number') line[k] += d;
        if (line.renderHints && typeof line.renderHints.renderEndTime === 'number') line.renderHints.renderEndTime += d;
        for (const w of Array.isArray(line.words) ? line.words : []) {
            if (typeof w.startTime === 'number') w.startTime += d;
            if (typeof w.endTime === 'number') w.endTime += d;
            for (const syl of Array.isArray(w.syllables) ? w.syllables : []) {
                if (typeof syl.startTime === 'number') syl.startTime += d;
                if (typeof syl.endTime === 'number') syl.endTime += d;
            }
        }
    };
    const lyricIndexAt = (time) => {
        if (typeof app.lyricIndexAt === 'function') return app.lyricIndexAt(time);
        const lines = Array.isArray(app.currentLyrics) ? app.currentLyrics : [];
        let index = -1;
        for (let i = 0; i < lines.length && time >= lines[i].time; i++) index = i;
        return index;
    };
    app.setLyricOffset = (value) => {
        const next = Math.max(-LYRIC_OFFSET_LIMIT, Math.min(LYRIC_OFFSET_LIMIT, Math.round((Number(value) || 0) * 10) / 10));
        const d = Math.round((next - (Number(app.lyricOffset) || 0)) * 1000) / 1000;
        if (!d) return app.lyricOffset || 0;
        app.lyricOffset = next;
        for (const line of Array.isArray(app.currentLyrics) ? app.currentLyrics : []) shiftLine(line, d);
        const path = lyricTrackPath();
        if (path) {
            const offsets = { ...readOffsets() };
            delete offsets[path];
            if (next) offsets[path] = next;
            const keys = Object.keys(offsets);
            for (const k of keys.slice(0, Math.max(0, keys.length - MAX_LYRIC_OFFSETS))) delete offsets[k];
            writeOffsets(offsets);
        }
        // 当前行按新时间轴重新定位，再重画（逐字高亮的时间在 DOM 上也要跟着变）。
        app.currentLyricIndex = lyricIndexAt(Number(app.lastKnownCurrentTime) || 0);
        try { app.renderLyrics?.(); } catch (error) { /* 歌词区没准备好时只改数据 */ }
        lyricsEvent('music-lyrics-offset', { offset: next });
        return next;
    };
    app.shiftLyrics = (delta) => app.setLyricOffset((Number(app.lyricOffset) || 0) + (Number(delta) || 0));
    app.lyricsTranslation = readStore(LYRIC_TRANSLATION_KEY, true) !== false;
    const lyricsEvent = (type, detail) => {
        if (typeof document === 'undefined' || typeof CustomEvent !== 'function') return;
        document.dispatchEvent(new CustomEvent(type, { detail }));
    };
    const applyTranslationClass = () => {
        if (typeof document !== 'undefined') document.body?.classList?.toggle?.('music-lyrics-hide-translation', !app.lyricsTranslation);
    };
    applyTranslationClass();
    app.setLyricsTranslation = (on) => {
        app.lyricsTranslation = Boolean(on);
        writeStore(LYRIC_TRANSLATION_KEY, app.lyricsTranslation);
        applyTranslationClass();
        // 行高变了，歌词区缓存的位置作废
        app._lyricLayout = null;
        try { app.renderLyrics?.(); } catch (error) { /* 同上 */ }
        lyricsEvent('music-lyrics-translation', { on: app.lyricsTranslation });
        return app.lyricsTranslation;
    };
    // 换歌取歌词前先换成这首的偏移。
    (globalThis.MusicAppHooks || require('./music-app-hooks.js')).wrap(app, 'fetchAndDisplayLyrics', 'player', (base) => (artist, title, options = {}) => {
        app.lyricOffset = app.lyricOffsetFor(options.path || lyricTrackPath());
        return base(artist, title, options);
    });

    // ───────── 重启恢复：队列、上下文、进度 ─────────
    // 和「上次那首」「播放模式」一样存在 localStorage：
    // { v, track, time, context: 路径数组或 null（整个曲库）, source, manual: 路径数组, shuffle: 随机顺序或 null }。
    // 只恢复，不自动播放。
    // 整份会话每 5 秒存一次（上下文可能有几千条路径）；进度另外用一个很小的键每秒存一次，
    // 这样即使窗口不是正常关掉的，回来时进度也只差一秒以内。
    const SESSION_KEY = 'musicSession';
    const SESSION_TIME_KEY = 'musicSessionTime';
    const sessionTime = () => Math.max(0, Math.round((Number(app.lastKnownCurrentTime) || 0) * 10) / 10);
    let lastSavedTimeTrack = '';
    let lastSavedTimeSec = -1;
    app.saveSessionTime = (force = false) => {
        const track = app.playlist?.[app.currentTrackIndex];
        if (!track) return;
        const time = sessionTime();
        if (!force && track.path === lastSavedTimeTrack && time === lastSavedTimeSec) return;
        lastSavedTimeTrack = track.path;
        lastSavedTimeSec = time;
        writeStore(SESSION_TIME_KEY, { track: track.path, time, at: Date.now() });
    };
    let lastSessionStructure = '';
    const sessionStructureKey = () => {
        const track = app.playlist?.[app.currentTrackIndex];
        if (!track) return '';
        const ctx = app.currentFilteredTracks && app.currentFilteredTracks !== app.playlist ? app.currentFilteredTracks : null;
        const activeList = ctx || app.playlist;
        const mode = app.playModes?.[app.currentPlayMode] || '';
        const shuf = mode === 'shuffle' && app.lastShuffleList === activeList && app.shuffleQueue?.length ? app.shuffleQueue : null;
        const mq = app.manualQueue;
        const src = app.filteredPlaylistSource;
        const origin = app.contextFrom?.(app.playbackContext?.origin) ? app.playbackContext.origin : '';
        return `${track.path}|${ctx ? ctx.length + ':' + (ctx[0]?.path || '') + ':' + (ctx[ctx.length - 1]?.path || '') : 'ALL'}|${src?.type || ''}:${src?.id || ''}:${src?.name || ''}|${origin}|${mq?.length || 0}:${mq?.[0]?.path || ''}:${mq?.[mq.length - 1]?.path || ''}|${mode}|${shuf ? shuf.length + ':' + shuf[0] + ':' + shuf[shuf.length - 1] : ''}`;
    };
    const pathsOf = (list) => (list || []).map(t => t && t.path).filter(Boolean);
    app.saveSession = () => {
        const track = app.playlist?.[app.currentTrackIndex];
        if (!track) return;
        const context = app.currentFilteredTracks && app.currentFilteredTracks !== app.playlist ? pathsOf(app.currentFilteredTracks) : null;
        const activeList = app.currentFilteredTracks || app.playlist;
        // 随机模式下把洗好的顺序也存下来（存的是上下文列表里的下标），重启后「接下来」还是同一个顺序。
        const shuffled = app.playModes?.[app.currentPlayMode] === 'shuffle' && app.lastShuffleList === activeList && app.shuffleQueue?.length;
        const session = {
            v: 1,
            track: track.path,
            time: sessionTime(),
            context,
            source: app.filteredPlaylistSource ? { ...app.filteredPlaylistSource } : null,
            // 上下文是从哪儿点播的（经典列表、档案页）：恢复后那边换排序，播放顺序还能跟着变。
            origin: app.contextFrom?.(app.playbackContext?.origin) ? app.playbackContext.origin : null,
            manual: pathsOf(app.manualQueue),
            shuffle: shuffled ? { size: activeList.length, order: Array.from(app.shuffleQueue) } : null,
            savedAt: Date.now()
        };
        try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (error) { /* 存不下就算了 */ }
        lastSessionStructure = sessionStructureKey();
        app.saveSessionTime(true);
    };
    app.readSession = () => {
        try {
            const session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
            if (!session || session.v !== 1) return null;
            // 每秒存的进度比整份会话新，而且还是同一首：用它。
            const tick = readStore(SESSION_TIME_KEY, null);
            if (tick && tick.track === session.track && Number(tick.at) >= Number(session.savedAt || 0) && Number.isFinite(Number(tick.time))) {
                session.time = Math.max(0, Number(tick.time));
            }
            return session;
        } catch (error) { return null; }
    };
    let byPathList = null;
    let byPathLen = -1;
    let byPathFirst = null;
    let byPathLast = null;
    let byPathNorm = null;
    let byPathCache = null;
    let byPathFirstIndexCache = null;
    const ensureByPathCaches = () => {
        const pl = app.playlist || [];
        const len = pl.length;
        const first = len ? pl[0] : null;
        const last = len ? pl[len - 1] : null;
        const norm = app.normalizePathForCompare || null;
        if (byPathCache && byPathList === app.playlist && byPathLen === len
            && byPathFirst === first && byPathLast === last && byPathNorm === norm) {
            return;
        }
        const map = new Map();
        const idxMap = new Map();
        for (let i = 0; i < len; i += 1) {
            const t = pl[i];
            if (!t) continue;
            const k = norm ? norm(t.path) : t.path;
            map.set(k, t);
            if (!idxMap.has(k)) idxMap.set(k, i);
        }
        byPathList = app.playlist;
        byPathLen = len;
        byPathFirst = first;
        byPathLast = last;
        byPathNorm = norm;
        byPathCache = map;
        byPathFirstIndexCache = idxMap;
    };
    const byPathMap = () => { ensureByPathCaches(); return byPathCache; };
    const byPathIndexMap = () => { ensureByPathCaches(); return byPathFirstIndexCache; };
    const lookup = (map, path) => map.get(app.normalizePathForCompare ? app.normalizePathForCompare(path) : path) || null;
    // 恢复上下文列表和手动队列（曲库里已经没有的歌跳过）。在侧栏初始化之后调，免得被它清掉。
    app.applySessionQueue = (session = app.readSession()) => {
        if (!session) return false;
        const map = byPathMap();
        if (Array.isArray(session.context)) {
            const list = session.context.map(p => lookup(map, p)).filter(Boolean);
            if (list.length) {
                app.currentFilteredTracks = list;
                app.filteredPlaylistSource = session.source && typeof session.source === 'object' ? session.source : null;
                try { app.renderPlaylist?.(list); } catch (error) { /* 旧列表只是同步显示 */ }
            }
        }
        if (typeof session.origin === 'string' && session.origin) {
            app.playbackContext = { origin: session.origin, list: app.currentFilteredTracks, source: app.filteredPlaylistSource };
        }
        // 随机顺序：只有上下文列表和存的时候一样长（没有歌被删掉）才接着用，否则让它重洗。
        const activeList = app.currentFilteredTracks || app.playlist;
        const order = session.shuffle && Array.isArray(session.shuffle.order) ? session.shuffle.order : null;
        if (order && session.shuffle.size === activeList.length && order.every(i => Number.isInteger(i) && i >= 0 && i < activeList.length)) {
            app.shuffleQueue = order.slice();
            app.lastShuffleList = activeList;
        }
        if (Array.isArray(session.manual)) {
            app.manualQueue = session.manual.map(p => lookup(map, p)).filter(Boolean);
            if (app.manualQueue.length) announceQueue();
        }
        return true;
    };
    // 启动时该停在哪一首、哪一秒。
    app.sessionStartPoint = (session = app.readSession()) => {
        if (!session || !session.track) return null;
        const map = byPathMap();
        const track = lookup(map, session.track);
        const index = track ? app.playlist.indexOf(track) : -1;
        if (index === -1) return null;
        // 上次停在最后几秒，或者文件换成了更短的版本：别跳到结尾（一按播放就切走、进度显示超过总长），从头开始。
        let time = Math.max(0, Number(session.time) || 0);
        const duration = Number(track.duration) || 0;
        if (duration > 0 && time > duration - 3) time = 0;
        return { index, time };
    };
    let sessionTimer = null;
    const scheduleSessionSave = () => {
        if (sessionTimer || typeof setTimeout !== 'function') return;
        sessionTimer = setTimeout(() => { sessionTimer = null; app.saveSession(); }, 1000);
    };
    app.scheduleSessionSave = scheduleSessionSave;
    // 播放中每秒记一次进度（小键），每 5 秒仅在队列/曲目结构变化时才重写整份大 JSON，
    // 避免大曲库/随机模式下每 5 秒同步序列化数百 KB 到 localStorage 造成微卡顿。
    let sessionTick = null;
    if (typeof setInterval === 'function') {
        let ticks = 0;
        sessionTick = setInterval(() => {
            if (!app.isPlaying) return;
            ticks += 1;
            if (ticks % 5 === 0 && sessionStructureKey() !== lastSessionStructure) app.saveSession();
            else app.saveSessionTime();
        }, 1000);
        sessionTick?.unref?.();
    }
    try {
        const onVisSave = () => { if (document.hidden) app.saveSession(); };
        const onPageHideSave = () => app.saveSession();
        const onBeforeUnloadPlayer = () => {
            app.saveSession();
            if (sessionTick) { clearInterval(sessionTick); sessionTick = null; }
            if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
            app.cancelFailureSkip?.();
            if (preloadClearTimer) { clearTimeout(preloadClearTimer); preloadClearTimer = null; }
            if (refreshPreloadTimer) { clearTimeout(refreshPreloadTimer); refreshPreloadTimer = null; }
            document.removeEventListener?.('music-queue-change', scheduleSessionSave);
            document.removeEventListener?.('visibilitychange', onVisSave);
            globalThis.removeEventListener?.('pagehide', onPageHideSave);
        };
        document.addEventListener?.('music-queue-change', scheduleSessionSave);
        document.addEventListener?.('visibilitychange', onVisSave);
        globalThis.addEventListener?.('pagehide', onPageHideSave);
        globalThis.addEventListener?.('beforeunload', onBeforeUnloadPlayer, { once: true });
    } catch (error) { /* 测试环境里没有这些事件 */ }

    // 随机顺序只在这里生成：预载和「下一首」用同一份，列表换了就重洗。
    const ensureShuffleQueue = (activeList) => {
        if (app.lastShuffleList !== activeList) {
            app.shuffleQueue = [];
            app.lastShuffleList = activeList;
        }
        if (app.shuffleQueue.length === 0) {
            app.shuffleQueue = Array.from({ length: activeList.length }, (_, i) => i);
            for (let i = app.shuffleQueue.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [app.shuffleQueue[i], app.shuffleQueue[j]] = [app.shuffleQueue[j], app.shuffleQueue[i]];
            }
            // 别一开始就是正在放的这首
            if (app.shuffleQueue.length > 1 && app.playlist.indexOf(activeList[app.shuffleQueue[0]]) === app.currentTrackIndex) {
                app.shuffleQueue.push(app.shuffleQueue.shift());
            }
        }
    };

    // 曲库成员集合单槽缓存：避免 getUpNext / peekPrevious 在 5000+ 曲库下反复重建整张 Set 或线性 includes 扫描。
    let libSetList = null;
    let libSetLen = -1;
    let libSetFirst = null;
    let libSetLast = null;
    let libSetCache = null;
    const getLibrarySet = () => {
        const pl = app.playlist || [];
        const len = pl.length;
        const first = len ? pl[0] : null;
        const last = len ? pl[len - 1] : null;
        if (libSetCache && libSetList === app.playlist && libSetLen === len && libSetFirst === first && libSetLast === last) {
            return libSetCache;
        }
        libSetList = app.playlist;
        libSetLen = len;
        libSetFirst = first;
        libSetLast = last;
        libSetCache = new Set(pl);
        return libSetCache;
    };

    // 接下来会放什么：手动层 + 上下文层的真实顺序（随机时就是洗好的顺序）。
    app.getUpNext = (limit = 200) => {
        reconcileLibrary();
        const activeList = app.currentFilteredTracks || app.playlist;
        const mode = app.playModes[app.currentPlayMode];
        manualHead();
        const manual = app.manualQueue.length
            ? (() => { const lib = getLibrarySet(); return app.manualQueue.filter(t => lib.has(t)); })()
            : [];
        const context = [];
        if (mode === 'repeat-one') {
            const current = app.playlist[app.currentTrackIndex];
            if (current) context.push(current);
        } else if (mode === 'shuffle') {
            if (activeList.length) ensureShuffleQueue(activeList);
            for (const i of app.shuffleQueue) {
                if (context.length >= limit) break;
                const track = activeList[i];
                if (track && track !== app.playlist[app.currentTrackIndex]) context.push(track);
            }
        } else {
            const pos = activeList.indexOf(contextCurrent());
            const count = pos === -1 ? activeList.length : activeList.length - 1;
            for (let k = 0; k < count && context.length < limit; k++) context.push(activeList[(pos + 1 + k) % activeList.length]);
        }
        return { manual, context };
    };

    // 「上一首」会放哪一首，但不动播放历史（底栏悬停标题区时预览用）。
    app.peekPrevious = () => {
        reconcileLibrary();
        const activeList = app.currentFilteredTracks || app.playlist;
        if (!activeList.length) return null;
        const currentTrack = app.playlist[app.currentTrackIndex];
        const lib = playHistory.length ? getLibrarySet() : null;
        for (let k = playHistory.length - 1; k >= 0; k--) {
            const track = playHistory[k];
            if (track === currentTrack) continue;
            if (lib.has(track)) return track;
        }
        const position = activeList.indexOf(currentTrack);
        return activeList[(Math.max(position, 0) - 1 + activeList.length) % activeList.length] || null;
    };

    // 「上一首」的通用规则：这首已经放了 3 秒以上，先回到这首开头；3 秒内再按一次才真的回上一首。
    // 引擎还在加载、或者当前没有歌时，直接回上一首。
    const PREV_RESTART_AFTER = 3;
    app.playedSeconds = () => {
        if (app.isTrackLoading || !app.playlist?.[app.currentTrackIndex]) return 0;
        const base = Number(app.lastKnownCurrentTime) || 0;
        const elapsed = app.isPlaying && app.lastStateUpdateTime ? (Date.now() - app.lastStateUpdateTime) / 1000 : 0;
        return Math.max(0, base + elapsed);
    };
    app.prevRestarts = () => app.playedSeconds() > PREV_RESTART_AFTER;

    app.prevTrack = ({ force = false } = {}) => {
        reconcileLibrary();
        const activeList = app.currentFilteredTracks || app.playlist;
        if (activeList.length === 0) return;
        const currentTrack = app.playlist[app.currentTrackIndex];
        if (!force && app.prevRestarts()) {
            app.seekTo(0);
            return 'restart';
        }

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
        reconcileLibrary();
        const activeList = app.currentFilteredTracks || app.playlist;
        if (app.lastShuffleList !== activeList) {
            app.shuffleQueue = [];
            app.lastShuffleList = activeList;
        }

        const queued = manualHead();
        if (queued) {
            beginManual(queued);
            app.loadTrack(app.playlist.indexOf(queued));
            return;
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
                const currentTrack = contextCurrent();
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
                ensureShuffleQueue(activeList);
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
        reconcileLibrary();
        const activeList = app.currentFilteredTracks || app.playlist;
        if (activeList.length === 0) return;

        let nextTrackToPreload = manualHead();
        if (!nextTrackToPreload) switch (app.playModes[app.currentPlayMode]) {
            case 'repeat':
                const currentTrack = contextCurrent();
                const currentPos = activeList.indexOf(currentTrack);
                nextTrackToPreload = activeList[currentPos !== -1 ? (currentPos + 1) % activeList.length : 0];
                break;
            case 'repeat-one':
                nextTrackToPreload = app.playlist[app.currentTrackIndex];
                break;
            case 'shuffle':
                ensureShuffleQueue(activeList);
                if (app.shuffleQueue.length > 0) {
                    nextTrackToPreload = activeList[app.shuffleQueue[0]];
                }
                break;
        }

        if (nextTrackToPreload && nextTrackToPreload.path) {
            // If we are in repeat-one mode and there's only one track,
            // we still want to preload it for gapless looping.
            // But if we are NOT in repeat-one and there's only one track, we don't need to preload.
            if (activeList.length <= 1 && app.playModes[app.currentPlayMode] !== 'repeat-one' && nextTrackToPreload !== app.manualQueue[0]) {
                return;
            }

            app.isPreloadingNext = true;
            app.preloadIssuedFor = app.playlist[app.currentTrackIndex]?.path || null;
            try {
                await app.api.queueNextMusicTrack({
                    path: nextTrackToPreload.path,
                    username: nextTrackToPreload.username,
                    password: nextTrackToPreload.password,
                    serverId: nextTrackToPreload.serverId
                });
            } catch (e) {
                console.error('[Music.js] Preload failed:', e);
            } finally {
                if (preloadClearTimer) clearTimeout(preloadClearTimer);
                preloadClearTimer = setTimeout(() => { preloadClearTimer = null; app.isPreloadingNext = false; }, 500);
            }
            return true;
        }
        return false;
    };

    app.pollState = async () => {
        // 上一次查询还没回来就不再发，避免引擎忙时请求越堆越多、回包乱序。
        if (app.statePollInFlight || app.isTrackLoading) return;
        app.statePollInFlight = true;
        const epoch = app.controlEpoch;
        let failure = null;
        try {
            const result = await app.api.getMusicState();
            if (epoch !== app.controlEpoch || app.isTrackLoading) return;
            if (result?.status === 'success') {
                app.statePollFailures = 0;
                const wasPlaying = app.isPlaying === true;
                app.updateUIWithState(result.state);
                if (wasPlaying && endedWhilePushDown(result.state)) app.handlePlaybackEnded('poll');
            } else failure = result?.message || '';
        } catch (error) {
            console.warn('[Music.js] pollState failed:', error?.message || error);
            failure = error?.message || '';
        } finally {
            app.statePollInFlight = false;
        }
        if (failure !== null) noteEngineUnreachable(failure);
    };

    // 一首歌放完：引擎发 playback_ended，但它只发给当时连着的客户端，不会攒着。推送连接断开重连的
    // 那几秒里正好放完，这个事件就丢了，播放停在结尾不往下走。所以连接断开靠轮询时，查到「停了、
    // 进度在结尾」也算放完。两条路都走这里，同一次加载只切一次。
    const endedWhilePushDown = (state) => {
        const socketUp = app.ws && app.ws.readyState === 1;
        if (socketUp || !state || state.is_playing || state.is_loading) return false;
        if (app.playIntent === false && app.isChangingState) return false; // 刚按了暂停
        const duration = Number(state.duration) || 0;
        return duration > 1 && (Number(state.current_time) || 0) >= duration - 0.75;
    };
    app.handlePlaybackEnded = (source = 'push') => {
        if (app.isTrackLoading) return false;
        // 同一次加载只算一次；刚切走的一两秒里（下一首还没开始加载）另一条路再报也不算。
        if (app.endedHandledForLoad === app.pendingLoadRequestId) return false;
        if (Date.now() - (app.endedHandledAt || 0) < 1500) return false;
        app.endedHandledForLoad = app.pendingLoadRequestId;
        app.endedHandledAt = Date.now();
        console.log(`[Music.js] Playback ended (${source}), moving to next track`);
        app.stopStatePolling();
        app.isPlaying = false;
        app.playPauseBtn?.classList.remove('is-playing');
        app.nextTrack();
        return true;
    };

    // 引擎进程退出（崩溃、被杀）后每次查询都失败：以前界面一直显示「在播」，进度条照本地时钟往前走，
    // 其实早就没声音了。连续几次查不到（约 2 秒）就停下来说明；主进程会把引擎重新拉起来，
    // 这首歌要重新加载，所以记成「引擎里没有歌」，再按播放就是重新加载。
    const ENGINE_DOWN_AFTER = 4;
    app.statePollFailures = 0;
    const noteEngineUnreachable = (message) => {
        app.statePollFailures += 1;
        if (app.statePollFailures !== ENGINE_DOWN_AFTER) return;
        app.engineTrackPath = null;
        if (!app.isPlaying && !app.playIntent) return;
        app.playIntent = false;
        app.isChangingState = false;
        app.applyPlayingUi(false);
        app.stopStatePolling();
        app.showPlaybackNotice(`播放中断：${message ? describeEngineError(message) : '音频引擎没有响应'}`);
    };

    // 引擎无缝切到了第 index 首：界面跟过去。和 loadTrack 一样把播放时钟归零、换上新时长，
    // 不然要等下一次状态回来之前，歌词和进度条还按上一首的进度走（一下跳到新歌的末尾）。
    const adoptSwitchedTrack = (index) => {
        app.currentTrackIndex = index;
        const track = app.playlist[index];
        app.pendingTrackPath = track.path;
        app.isTrackLoading = false; // gapless 切歌后后端已经加载好了，重置加载标志
        app.engineTrackPath = track.path;
        app.lastKnownCurrentTime = 0;
        app.lastStateUpdateTime = Date.now();
        app.resetEngineProgress?.();
        if (track.duration > 0) {
            app.lastKnownDuration = track.duration;
            app.durationEl.textContent = app.formatTime(track.duration);
        }
        app.progress.style.width = '0%';
        app.currentTimeEl.textContent = app.formatTime(0);
        // 之前加载失败标灰过的歌，这次无缝放起来了，就不再是坏的。
        if (app.failedTracks.has(track)) markFailed(track, '');
        app.rememberPlayed(track);
        showTrack(track);

        // 如果是随机播放，从队列中移除当前已开始播放的这首歌，防止之后再次随机到它
        if (app.playModes[app.currentPlayMode] === 'shuffle') {
            const activeList = app.currentFilteredTracks || app.playlist;
            const posInActiveList = activeList.indexOf(track);
            if (posInActiveList !== -1) {
                const queueIndex = app.shuffleQueue.indexOf(posInActiveList);
                if (queueIndex !== -1) app.shuffleQueue.splice(queueIndex, 1);
            }
        }

        if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
    };

    app.syncTrackIndexByPath = (path) => {
        if (!path) return;
        const normalizedPath = app.normalizePathForCompare(path);
        const idxHit = normalizedPath ? byPathIndexMap().get(normalizedPath) : undefined;
        let index = idxHit !== undefined ? idxHit : -1;
        if (index === -1) {
            // 后端可能返回带 \\?\ 前缀或不同斜杠方向的路径：退回按文件名匹配
            const fileName = normalizedPath ? normalizedPath.split('/').pop() : null;
            if (fileName) index = app.playlist.findIndex(t => {
                const tNorm = app.normalizePathForCompare(t.path);
                return tNorm && tNorm.split('/').pop() === fileName;
            });
        }
        if (index === -1) {
            console.warn('[Music.js] syncTrackIndexByPath: no match found for', path);
            return;
        }
        console.log('[Music.js] Syncing track index to:', index);
        adoptSwitchedTrack(index);
    };

    const sameFile = (a, b) => {
        const x = app.normalizePathForCompare(a), y = app.normalizePathForCompare(b);
        return Boolean(x && y) && (x === y || x.split('/').pop() === y.split('/').pop());
    };
    (globalThis.MusicAppHooks || require('./music-app-hooks.js')).wrap(app, 'syncTrackIndexByPath', 'player-queue', (syncTrackIndexByPath) => (path) => {
        // 引擎无缝切进了一首曲库里已经没有的歌（预载之后被移除，重填又没赶上）：
        // 界面没法显示它，直接按现在的队列切到下一首，不让声音和界面对不上。
        if (path) {
            const normP = app.normalizePathForCompare(path);
            const exists = Boolean(normP && byPathIndexMap().has(normP)) || app.playlist.some(t => sameFile(t.path, path));
            if (!exists) {
                console.warn('[Music.js] Engine switched to a track no longer in the library, moving on:', path);
                app.nextTrack();
                return;
            }
        }
        // 无缝切进了队列里的下一首：在当前索引变之前把它从手动层取出来，记下上下文位置。
        const queued = manualHead();
        if (queued && path && app.normalizePathForCompare(queued.path) === app.normalizePathForCompare(path)) beginManual(queued);
        syncTrackIndexByPath(path);
        scheduleSessionSave();
        app.publishCapsuleState();
    });

    // 歌词和进度在两次查询之间按本地时钟推算，查询只用来校准，不需要每秒 4 次。
    // 窗口不可见时再降到 2 秒一次，只为外部的“正在播放”信息保持更新。
    let hiddenPollSkips = 0;
    app.startStatePolling = () => {
        if (app.statePollInterval) clearInterval(app.statePollInterval);
        app.statePollInterval = null;
        // 引擎会推送状态时不轮询。
        if (app.enginePush) return;
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
