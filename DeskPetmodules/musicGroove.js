// 对数频谱 → 轻量节拍时钟。不是乐谱分析：弱节拍用平滑时钟，静音和断流不继续跳。
// 时间单位为秒，由调用方注入单调时钟；无 DOM、音频设备和定时器，便于测试。
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = (v, fallback = 0) => Number.isFinite(v) ? v : fallback;

export function createMusicGroove() {
    let previous = [];
    let history = [];
    let intervals = [];
    let lastSample = -Infinity;
    let lastOnset = -Infinity;
    let phaseBeat = 0;
    let phaseAt = 0;
    let period = 0.5;
    let energy = 0;
    let confidence = 0;
    let playing = false;
    let trackKey = null;
    let lastNow = 0;

    function reset() {
        previous = [];
        history = [];
        intervals = [];
        lastSample = lastOnset = -Infinity;
        phaseBeat = 0;
        phaseAt = lastNow;
        period = 0.5;
        energy = confidence = 0;
    }

    function snapshot(now = lastNow) {
        now = finite(now, lastNow);
        const fresh = playing && now - lastSample <= 0.8 && now >= lastSample;
        const level = fresh ? energy : energy * Math.exp(-Math.max(0, now - lastSample - 0.8) * 8);
        const beat = Math.max(0, phaseBeat + Math.max(0, now - phaseAt) / period);
        return {
            playing: fresh && level > 0.015,
            energy: clamp(level, 0, 1),
            bpm: 60 / period,
            confidence,
            beat,
            beatPhase: beat % 1,
            bar: Math.floor(beat / 4),
        };
    }

    function push(data, { now = 0, playing: nextPlaying = true, trackKey: key = '' } = {}) {
        now = finite(now, lastNow);
        if (key !== trackKey || now < lastNow || now - lastSample > 2 || nextPlaying !== playing) reset();
        trackKey = key;
        playing = nextPlaying === true;
        lastNow = now;
        if (!playing) return snapshot(now);
        if (!Array.isArray(data) && !ArrayBuffer.isView(data)) return snapshot(now);
        if (!data.length || data.length > 2048) return snapshot(now);
        const values = Array.from(data, v => clamp(finite(v), 0, 1));
        const dt = Number.isFinite(lastSample) ? clamp(now - lastSample, 0.001, 0.25) : 0.05;
        // 后端输出 20Hz～Nyquist 对数分带。前约 40% 覆盖低频，避免假设固定采样率。
        const bassEnd = Math.max(1, Math.floor(values.length * 0.4));
        let sum = 0, bass = 0, flux = 0;
        for (let i = 0; i < values.length; i++) {
            sum += values[i] * values[i];
            if (i < bassEnd) {
                bass += values[i];
                flux += Math.max(0, values[i] - (previous[i] ?? values[i]));
            }
        }
        bass /= bassEnd;
        flux /= bassEnd;
        const rms = Math.sqrt(sum / values.length);
        const goal = clamp((rms - 0.025) * 1.8, 0, 1);
        energy += (goal - energy) * (1 - Math.exp(-dt * (goal > energy ? 12 : 5)));
        const mean = history.length ? history.reduce((s, h) => s + h.flux, 0) / history.length : 0;
        const onset = previous.length === values.length && bass > 0.055 && flux > Math.max(0.025, mean * 1.7)
            && now - lastOnset >= 0.28;
        // 在当前周期下先积分到 now；随后变速不会重算过去的整段播放时间。
        phaseBeat += Math.max(0, now - phaseAt) / period;
        phaseAt = now;
        if (onset) {
            const gap = now - lastOnset;
            if (gap >= 0.3 && gap <= 1.1) {
                intervals.push(gap);
                intervals = intervals.slice(-8);
                const ordered = [...intervals].sort((a, b) => a - b);
                const median = ordered[Math.floor(ordered.length / 2)];
                const consistent = intervals.filter(v => Math.abs(v - median) < median * 0.16).length;
                confidence = consistent / Math.max(4, intervals.length);
                period += (clamp(median, 1 / 3, 1) - period) * 0.25;
            }
            // 鼓点只微调拍内误差，绝不归零累计拍数。
            const error = Math.round(phaseBeat) - phaseBeat;
            phaseBeat += clamp(error, -0.08, 0.08) * 0.15;
            lastOnset = now;
        }
        history.push({ now, flux });
        history = history.filter(h => now - h.now < 1.5).slice(-60);
        previous = values;
        lastSample = now;
        return { ...snapshot(now), onBeat: onset };
    }

    return { push, snapshot, reset };
}

// 律动只使用标准参数；模型映射在 Live2D 层额外处理。
export function groovePose(groove, strength = 1) {
    const k = groove?.playing ? clamp(finite(groove.energy), 0, 1) * clamp(finite(strength), 0, 2) : 0;
    const beat = finite(groove?.beat);
    const sway = Math.sin(beat * Math.PI);
    const nod = (1 + Math.cos(beat * Math.PI * 2)) / 2;
    return {
        params: {
            ParamAngleX: sway * 5 * k,
            ParamAngleY: -nod * 4 * k,
            ParamAngleZ: sway * 5 * k,
            ParamBodyAngleX: sway * 3 * k,
            ParamBodyAngleY: -nod * 2 * k,
            ParamBodyAngleZ: -sway * 3 * k,
            ParamEyeLSmile: 0.35 * k,
            ParamEyeRSmile: 0.35 * k,
            ParamMouthForm: 0.35 * k,
        },
        swing: sway * 2 * k,
        hop: nod * 4 * k,
        bounce: nod * k,
    };
}