(function (global) {
    'use strict';

    const STORAGE_KEY = 'musicStageConfig';
    const VERSION = 1;
    const clamp = (value, min, max, fallback) => {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(max, Math.max(min, number));
    };
    const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback;
    const enumValue = (value, values, fallback) => values.includes(value) ? value : fallback;

    const MODE_META = Object.freeze([
        { id: 'luminous', label: '流光', description: '逐字辉光与呼吸浮动' },
        { id: 'partita', label: '云阶', description: '分块排版与引导线' },
        { id: 'cadenza', label: '心象', description: '空间排版与镜头漂移' },
        { id: 'fume', label: '浮名', description: '文章镜头与几何背景' },
        { id: 'starborn', label: '星诞', description: '按歌词段落自动导演' }
    ]);

    const DEFAULTS = Object.freeze({
        enabledModes: ['luminous', 'partita', 'cadenza', 'fume', 'starborn'],
        quality: 'standard',
        animationIntensity: 1,
        edgeSpectrum: true,
        modes: {
            luminous: {
                wordRotation: true,
                breathing: 1,
                wordSpacing: 0.7,
                glow: 1
            },
            partita: {
                guideLines: true,
                semanticLayout: true,
                staggerMin: 20,
                staggerMax: 100,
                power: 1
            },
            cadenza: {
                motion: 1,
                fontScale: 1,
                widthRatio: 0.78,
                glow: 1
            },
            fume: {
                geometricBackground: true,
                backgroundOpacity: 0.5,
                cameraSpeed: 1,
                cameraMode: 'smooth',
                glow: 1,
                heroScale: 1
            },
            starborn: {
                transitionLock: 4,
                avoidRepeat: true
            }
        }
    });

    const normalizeMode = (mode, fallback) => {
        const source = mode && typeof mode === 'object' ? mode : {};
        return {
            ...fallback,
            ...source,
            wordRotation: bool(source.wordRotation, fallback.wordRotation),
            breathing: clamp(source.breathing, 0, 2, fallback.breathing),
            wordSpacing: clamp(source.wordSpacing, 0, 2, fallback.wordSpacing),
            glow: clamp(source.glow, 0, 2, fallback.glow),
            guideLines: bool(source.guideLines, fallback.guideLines),
            semanticLayout: bool(source.semanticLayout, fallback.semanticLayout),
            staggerMin: clamp(source.staggerMin, 0, 180, fallback.staggerMin),
            staggerMax: clamp(source.staggerMax, 0, 180, fallback.staggerMax),
            power: clamp(source.power, 0, 2, fallback.power),
            motion: clamp(source.motion, 0, 2, fallback.motion),
            fontScale: clamp(source.fontScale, 0.65, 1.5, fallback.fontScale),
            widthRatio: clamp(source.widthRatio, 0.5, 0.95, fallback.widthRatio),
            geometricBackground: bool(source.geometricBackground, fallback.geometricBackground),
            backgroundOpacity: clamp(source.backgroundOpacity, 0, 1, fallback.backgroundOpacity),
            cameraSpeed: clamp(source.cameraSpeed, 0.55, 1.85, fallback.cameraSpeed),
            cameraMode: enumValue(source.cameraMode, ['stepped', 'smooth'], fallback.cameraMode),
            heroScale: clamp(source.heroScale, 0.82, 1.32, fallback.heroScale),
            transitionLock: clamp(source.transitionLock, 0.5, 12, fallback.transitionLock),
            avoidRepeat: bool(source.avoidRepeat, fallback.avoidRepeat)
        };
    };

    const normalize = (candidate) => {
        const source = candidate && typeof candidate === 'object' ? candidate : {};
        const requestedModes = Array.isArray(source.enabledModes) ? source.enabledModes : DEFAULTS.enabledModes;
        const enabledModes = MODE_META
            .map((entry) => entry.id)
            .filter((id) => requestedModes.includes(id));
        const modes = {};
        MODE_META.forEach((entry) => {
            modes[entry.id] = normalizeMode(source.modes?.[entry.id], DEFAULTS.modes[entry.id]);
        });
        if (!enabledModes.length) enabledModes.push('luminous');

        return {
            version: VERSION,
            enabledModes,
            quality: enumValue(source.quality, ['energy-saving', 'standard', 'ultimate'], DEFAULTS.quality),
            animationIntensity: clamp(source.animationIntensity, 0, 2, DEFAULTS.animationIntensity),
            edgeSpectrum: bool(source.edgeSpectrum, DEFAULTS.edgeSpectrum),
            modes
        };
    };

    const clone = (value) => JSON.parse(JSON.stringify(value));
    let current = normalize(DEFAULTS);
    const listeners = new Set();

    const notify = () => {
        const snapshot = clone(current);
        listeners.forEach((listener) => {
            try {
                listener(snapshot);
            } catch (error) {
                console.warn('[MusicStageConfig] listener failed:', error);
            }
        });
    };

    const persist = () => {
        try {
            global.localStorage?.setItem(STORAGE_KEY, JSON.stringify(current));
        } catch (error) {
            console.warn('[MusicStageConfig] persist failed:', error);
        }
    };

    const load = () => {
        try {
            const saved = global.localStorage?.getItem(STORAGE_KEY);
            current = normalize(saved ? JSON.parse(saved) : DEFAULTS);
        } catch (error) {
            current = normalize(DEFAULTS);
        }
        return clone(current);
    };

    const update = (patch) => {
        const source = typeof patch === 'function' ? patch(clone(current)) : patch;
        current = normalize({
            ...current,
            ...(source || {}),
            modes: {
                ...current.modes,
                ...(source?.modes || {})
            }
        });
        persist();
        notify();
        return clone(current);
    };

    const setModePatch = (modeId, patch) => {
        if (!MODE_META.some((entry) => entry.id === modeId)) return clone(current);
        return update({
            modes: {
                [modeId]: {
                    ...current.modes[modeId],
                    ...(patch || {})
                }
            }
        });
    };

    const toggleMode = (modeId, enabled) => {
        if (!MODE_META.some((entry) => entry.id === modeId)) return clone(current);
        const enabledModes = current.enabledModes.filter((id) => id !== modeId);
        if (enabled && !enabledModes.includes(modeId)) enabledModes.push(modeId);
        return update({ enabledModes });
    };

    const reset = () => {
        current = normalize(DEFAULTS);
        persist();
        notify();
        return clone(current);
    };

    load();

    global.MusicStageConfig = Object.freeze({
        STORAGE_KEY,
        VERSION,
        modes: MODE_META,
        defaults: DEFAULTS,
        load,
        get: () => clone(current),
        update,
        setModePatch,
        toggleMode,
        reset,
        subscribe(listener) {
            if (typeof listener !== 'function') return () => {};
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    });
})(window);