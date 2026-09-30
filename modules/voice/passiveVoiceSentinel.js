class PassiveVoiceSentinel {
    constructor(options = {}) {
        this.sampleRate = options.sampleRate || 16000;
        this.bufferSize = options.bufferSize || 256;
        this.thresholdRms = options.thresholdRms || 0.007;
        this.minPeriodicity = options.minPeriodicity || 0.38;
        this.onTrigger = options.onTrigger || (() => {});
        this.logger = options.logger || console;

        this.audioContext = null;
        this.mediaStream = null;
        this.source = null;
        this.filter = null;
        this.processor = null;

        this.sampleBuffer = new Float32Array(this.bufferSize);
        this.fftSize = 256;

        this.noiseFloor = 0.005;
        this.lastRms = 0;
        this.consecutiveSpeechFrames = 0;
        this.resumeTime = 0;
        this.active = false;
        this.suspended = false;
        this.isStarting = false;
    }

    updateNoiseFloor(rms) {
        const diff = Math.abs(rms - (this.lastRms || rms));
        this.lastRms = rms;

        if (diff < 0.0015) {
            this.noiseFloor = this.noiseFloor * 0.75 + rms * 0.25;
        } else if (rms < this.noiseFloor) {
            this.noiseFloor = this.noiseFloor * 0.9 + rms * 0.1;
        } else if (rms < this.noiseFloor * 1.3) {
            this.noiseFloor = this.noiseFloor * 0.99 + rms * 0.01;
        }

        if (this.noiseFloor < 0.002) this.noiseFloor = 0.002;
        if (this.noiseFloor > 0.06) this.noiseFloor = 0.06;
    }

    computePeriodicity(samples) {
        const len = samples.length;
        let energy0 = 0;
        for (let i = 0; i < len; i++) {
            energy0 += samples[i] * samples[i];
        }
        if (energy0 < 0.000005) return 0;

        const minLag = 45;
        const maxLag = Math.min(140, len - 2);
        let maxCorr = 0;

        for (let lag = minLag; lag <= maxLag; lag++) {
            let sum = 0;
            let lagEnergy = 0;
            const n = len - lag;
            for (let i = 0; i < n; i++) {
                sum += samples[i] * samples[i + lag];
                lagEnergy += samples[i + lag] * samples[i + lag];
            }
            if (lagEnergy > 0) {
                const norm = sum / Math.sqrt(energy0 * lagEnergy);
                if (norm > maxCorr) {
                    maxCorr = norm;
                }
            }
        }

        return maxCorr;
    }

    async start() {
        if (this.active || this.isStarting) return true;
        this.isStarting = true;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: false,
                    channelCount: 1,
                    sampleRate: this.sampleRate,
                },
            });

            if (!this.isStarting) {
                stream.getTracks().forEach(track => track.stop());
                return false;
            }

            this.mediaStream = stream;
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioContextClass({
                sampleRate: this.sampleRate,
            });
            this.source = this.audioContext.createMediaStreamSource(stream);

            const highpass = this.audioContext.createBiquadFilter();
            highpass.type = 'highpass';
            highpass.frequency.value = 115;
            highpass.Q.value = 0.7071;
            this.source.connect(highpass);
            this.filter = highpass;

            const processor = this.audioContext.createScriptProcessor(
                this.bufferSize,
                1,
                1
            );
            processor.onaudioprocess = event => {
                const output = event.outputBuffer?.getChannelData(0);
                if (output) output.fill(0);
                if (!this.active) return;
                const input = event.inputBuffer.getChannelData(0);
                this.processAudioFrame(input);
            };
            highpass.connect(processor);
            processor.connect(this.audioContext.destination);
            this.processor = processor;

            this.active = true;
            this.suspended = false;
            this.consecutiveSpeechFrames = 0;
            return true;
        } catch (error) {
            this.logger.error('[PassiveVoiceSentinel] 启动失败:', error);
            this.stop();
            return false;
        } finally {
            this.isStarting = false;
        }
    }

    processAudioFrame(samples) {
        if (!this.active) return;
        const now = performance.now();

        if (this.resumeTime > 0) {
            if (now - this.resumeTime < 250) {
                return;
            }
            this.resumeTime = 0;
        }

        let sum = 0;
        let peak = 0;
        let eFront = 0;
        let eBack = 0;
        const len = samples.length;
        const half = len >> 1;

        for (let i = 0; i < len; i++) {
            const abs = Math.abs(samples[i]);
            if (abs > peak) peak = abs;
            const sq = abs * abs;
            sum += sq;
            if (i < half) eFront += sq;
            else eBack += sq;
        }
        const rms = Math.sqrt(sum / len);
        this.lastRms = rms;
        this.updateNoiseFloor(rms);

        // 如果处于挂起状态（听写会话执行中），仅保留振幅计算供波形使用，不触发重复唤醒
        if (this.suspended) return;

        const crestFactor = rms > 0.0001 ? peak / rms : 0;
        const impulseRatio = (eFront + 0.00001) / (eBack + 0.00001);
        const isClickImpulse = impulseRatio > 3.5 || impulseRatio < 0.28;

        const periodicity = this.computePeriodicity(samples);
        const isSteadyTone = crestFactor < 1.55;

        const isSpeechFrame =
            !isClickImpulse &&
            !isSteadyTone &&
            rms >= this.thresholdRms &&
            periodicity >= this.minPeriodicity;

        if (isSpeechFrame) {
            this.consecutiveSpeechFrames++;
            if (this.consecutiveSpeechFrames >= 3) {
                this.consecutiveSpeechFrames = 0;
                this.suspend();
                try {
                    this.onTrigger('VOICE');
                } catch (err) {
                    this.logger.error('[PassiveVoiceSentinel] 唤醒回调异常:', err);
                }
            }
        } else {
            this.consecutiveSpeechFrames = 0;
        }
    }

    suspend() {
        this.suspended = true;
    }

    resume() {
        if (!this.active) return;
        this.suspended = false;
        this.consecutiveSpeechFrames = 0;
        this.resumeTime = performance.now();
    }

    stop() {
        this.isStarting = false;
        this.active = false;
        this.suspended = false;
        if (this.processor) {
            try {
                this.processor.disconnect();
                this.processor.onaudioprocess = null;
            } catch (_) {}
            this.processor = null;
        }
        if (this.filter) {
            try {
                this.filter.disconnect();
            } catch (_) {}
            this.filter = null;
        }
        if (this.source) {
            try {
                this.source.disconnect();
            } catch (_) {}
            this.source = null;
        }
        if (this.mediaStream) {
            try {
                this.mediaStream.getTracks().forEach(track => track.stop());
            } catch (_) {}
            this.mediaStream = null;
        }
        if (this.audioContext) {
            try {
                this.audioContext.close();
            } catch (_) {}
            this.audioContext = null;
        }
        this.consecutiveSpeechFrames = 0;
    }

    amplitude() {
        return this.active ? (this.lastRms || 0) : 0;
    }
}

if (typeof window !== 'undefined') {
    window.VcpVoice = Object.assign(window.VcpVoice || {}, {
        PassiveVoiceSentinel,
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PassiveVoiceSentinel,
    };
}
