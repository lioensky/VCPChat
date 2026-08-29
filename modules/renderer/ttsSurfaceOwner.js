/** Owns TTS playback state, preload subscriptions, and quiescent teardown for one Surface realm. */
export function createTtsSurfaceOwner({
    subscribePlay,
    subscribeStop,
    createAudioContext,
    decodeBase64,
    updateSpeakingIndicator,
    showError,
    logger = console,
} = {}) {
    if (typeof subscribePlay !== 'function' || typeof subscribeStop !== 'function') {
        throw new TypeError('TtsSurfaceOwner requires play and stop subscription capabilities');
    }
    if (typeof createAudioContext !== 'function' || typeof decodeBase64 !== 'function') {
        throw new TypeError('TtsSurfaceOwner requires audio context and base64 capabilities');
    }

    let audioContext = null;
    let currentSource = null;
    const streamingSources = new Set();
    let streamDecodeTail = Promise.resolve();
    let nextStreamingStartTime = 0;
    let queue = [];
    let playing = false;
    let currentMessageId = null;
    let sessionId = -1;
    let mounted = false;
    let disposed = false;
    let generation = 0;
    const unsubscribers = [];
    const activeWork = new Set();

    const setIndicator = (messageId, active) => {
        if (messageId && typeof updateSpeakingIndicator === 'function') {
            updateSpeakingIndicator(messageId, active);
        }
    };

    const stopPlayback = () => {
        generation += 1;
        sessionId += 1;
        queue = [];
        playing = false;
        streamDecodeTail = Promise.resolve();
        nextStreamingStartTime = 0;
        if (currentSource) {
            currentSource.onended = null;
            try { currentSource.stop(); } catch (error) { logger.warn?.('[TTS] failed to stop source', error); }
            currentSource = null;
        }
        streamingSources.forEach(source => {
            source.onended = null;
            try { source.stop(); } catch (error) { logger.warn?.('[TTS] failed to stop streaming source', error); }
        });
        streamingSources.clear();
        setIndicator(currentMessageId, false);
        currentMessageId = null;
    };

    const processQueue = async () => {
        if (disposed || playing || queue.length === 0 || !audioContext) return;
        playing = true;
        const ownerGeneration = generation;
        const { audioData, msgId, playbackRate = 1 } = queue.shift();
        if (currentMessageId !== msgId) {
            setIndicator(currentMessageId, false);
            currentMessageId = msgId;
            setIndicator(currentMessageId, true);
        }

        const work = (async () => {
            try {
                const bytes = decodeBase64(audioData);
                const buffer = await audioContext.decodeAudioData(bytes);
                if (disposed || !playing || ownerGeneration !== generation) return;
                const source = audioContext.createBufferSource();
                currentSource = source;
                source.buffer = buffer;
                source.playbackRate.value = Math.min(2, Math.max(0.5, Number(playbackRate) || 1));
                source.connect(audioContext.destination);
                source.onended = () => {
                    if (disposed || ownerGeneration !== generation) return;
                    currentSource = null;
                    playing = false;
                    void processQueue();
                };
                source.start(0);
            } catch (error) {
                if (!disposed && ownerGeneration === generation) {
                    showError?.(`播放音频失败: ${error.message}`);
                    playing = false;
                    void processQueue();
                }
            }
        })();
        activeWork.add(work);
        work.finally(() => activeWork.delete(work));
        await work;
    };

    const scheduleStreamingChunk = ({ audioData, msgId, playbackRate = 1 }, ownerGeneration) => {
        streamDecodeTail = streamDecodeTail.then(async () => {
            if (disposed || ownerGeneration !== generation || !audioContext) return;
            const bytes = decodeBase64(audioData);
            const buffer = await audioContext.decodeAudioData(bytes);
            if (disposed || ownerGeneration !== generation) return;

            if (currentMessageId !== msgId) {
                setIndicator(currentMessageId, false);
                currentMessageId = msgId;
                setIndicator(currentMessageId, true);
            }

            const source = audioContext.createBufferSource();
            const normalizedRate = Math.min(2, Math.max(0.5, Number(playbackRate) || 1));
            source.buffer = buffer;
            source.playbackRate.value = normalizedRate;
            source.connect(audioContext.destination);
            streamingSources.add(source);

            // 提前解码并按音频时钟连续排程，而不是等上一块 onended 后才解码，
            // 避免 MiMo PCM SSE 块之间因 JS 调度和解码产生明显空隙。
            const startAt = Math.max(audioContext.currentTime + 0.025, nextStreamingStartTime);
            nextStreamingStartTime = startAt + (buffer.duration / normalizedRate);
            source.onended = () => {
                streamingSources.delete(source);
                if (!disposed && ownerGeneration === generation && streamingSources.size === 0) {
                    nextStreamingStartTime = 0;
                    setIndicator(currentMessageId, false);
                    currentMessageId = null;
                }
            };
            source.start(startAt);
        }).catch(error => {
            if (!disposed && ownerGeneration === generation) {
                showError?.(`播放流式音频失败: ${error.message}`);
            }
        });

        activeWork.add(streamDecodeTail);
        streamDecodeTail.finally(() => activeWork.delete(streamDecodeTail)).catch(() => {});
    };

    const ensureAudioContext = () => {
        if (disposed) return false;
        if (audioContext) {
            void processQueue();
            return true;
        }
        try {
            audioContext = createAudioContext();
            void processQueue();
            return true;
        } catch (error) {
            logger.error?.('[TTS] failed to initialize AudioContext', error);
            showError?.('无法初始化音频播放器。');
            return false;
        }
    };

    const mount = () => {
        if (disposed) throw new Error('TtsSurfaceOwner is disposed');
        if (mounted) return;
        mounted = true;
        unsubscribers.push(subscribePlay(({
            audioData,
            msgId,
            sessionId: incomingSession,
            streaming = false,
            playbackRate = 1
        }) => {
            if (disposed || incomingSession < sessionId) return;
            if (incomingSession > sessionId) {
                stopPlayback();
                sessionId = incomingSession;
            }
            if (!ensureAudioContext()) return;
            if (streaming) {
                scheduleStreamingChunk({ audioData, msgId, playbackRate }, generation);
                return;
            }
            queue.push({ audioData, msgId, playbackRate });
            void processQueue();
        }));
        unsubscribers.push(subscribeStop(() => stopPlayback()));
    };

    const dispose = async () => {
        if (disposed) return;
        disposed = true;
        while (unsubscribers.length) {
            try { unsubscribers.pop()?.(); } catch (error) { logger.warn?.('[TTS] unsubscribe failed', error); }
        }
        stopPlayback();
        await Promise.allSettled([...activeWork]);
        if (typeof audioContext?.close === 'function') {
            try { await audioContext.close(); } catch (error) { logger.warn?.('[TTS] AudioContext close failed', error); }
        }
        audioContext = null;
    };

    return Object.freeze({ mount, ensureAudioContext, dispose });
}
