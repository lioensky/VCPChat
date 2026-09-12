(function (global) {
    'use strict';

    const STORAGE_KEY = 'musicStageConfig';
    const VERSION = 2;
    const clamp = (value, min, max, fallback) => {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(max, Math.max(min, number));
    };
    const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback;
    const enumValue = (value, values, fallback) => values.includes(value) ? value : fallback;

    const MODE_META = Object.freeze([
        { id: 'tempera', label: '凝彩', description: '色块、网点与逐字分镜的实时歌词 MV' },
        { id: 'sonnet', label: '商籁', description: '编辑排版、HUD 与动态图形节目包装' },
        { id: 'diorama', label: '镜台', description: '三维歌词空间、点云与电影化运镜' },
        { id: 'fume', label: '浮名', description: '二维连续文字世界与长卷式镜头叙事' },
        { id: 'luminous', label: '流光', description: '逐字辉光与呼吸浮动' },
        { id: 'partita', label: '云阶', description: '分块排版与引导线' },
        { id: 'cadenza', label: '心象', description: '空间排版与镜头漂移' },
        { id: 'starborn', label: '星诞', description: '按歌词段落自动导演' }
    ]);

    const PIXI_DEFAULTS = Object.freeze({
        performanceIntensity: 1.25, beatImpact: 1.15, opticalImpact: 0.65,
        accentEffects: true, accentMotion: 1,
        cameraBreath: 0.5, cameraTracking: 0.35, shotFlow: 'auto', sceneTransitions: true,
        cameraSoftness: 0.75, cameraRoll: 0.25,
        lyricLayout: 'phrases', phraseLength: 12, phraseEmphasis: 0.4,
        trackVerticalChance: 0.42, trackJunction: 0.45, trackLookAhead: 0.38, trackMinSegment: 3,
        fontScale: 1, glyphStyle: 'rise', waitingOpacity: 0.25, releaseDuration: 0.45,
        postProcess: true, lensDistortion: 0.35, lensDispersion: 0.18,
        rgbShift: 0, grain: 0, contrast: 0, halftone: 0, vignette: 0.18
    });
    const DEFAULTS = Object.freeze({
        enabledModes: ['tempera', 'sonnet', 'diorama', 'fume', 'luminous', 'partita', 'cadenza', 'starborn'],
        quality: 'standard',
        animationIntensity: 1,
        edgeSpectrum: true,
        modes: {
            tempera: {
                ...PIXI_DEFAULTS,
                cameraIntensity: 1,
                glyphMotion: 1,
                colorMode: 'duo',
                showBlocks: true,
                showDecor: true,
                textInversion: true
            },
            sonnet: {
                ...PIXI_DEFAULTS,
                cameraIntensity: 1,
                typographyMotion: 1,
                guideLines: true,
                showBackground: true,
                showDecor: true,
                postProcess: true
            },
            diorama: {
                cameraSpeed: 1,
                motionAmount: 1,
                audioReactivity: 1,
                showParticles: true,
                geometryMode: 'clouds',
                glow: 1
            },
            luminous: {
                vectorDecor: true, decorOpacity: 0.55, decorMotion: 1,
                fontScale: 1, semanticLayout: true, layoutStyle: 'normal',
                chorusRipple: true, sceneTransitions: true, showTranslation: true, showUpcoming: true,
                wordRotation: true,
                breathing: 1,
                wordSpacing: 0.7,
                glow: 1
            },
            partita: {
                vectorDecor: true, decorOpacity: 0.5, decorMotion: 1, guidePulse: true,
                fontScale: 1, glow: 1, breathing: 1, layoutStyle: 'normal',
                chorusRipple: true, sceneTransitions: true, showTranslation: true, showUpcoming: true,
                guideLines: true,
                semanticLayout: true,
                staggerMin: 20,
                staggerMax: 100,
                power: 1
            },
            cadenza: {
                vectorDecor: true, decorOpacity: 0.5, decorMotion: 1,
                heroEmphasis: true, breathing: 0.5,
                chorusRipple: true, sceneTransitions: true, showTranslation: true, showUpcoming: true,
                motion: 1,
                fontScale: 1,
                widthRatio: 0.78,
                glow: 1
            },
            fume: {
                backgroundDetail: 0.6, backgroundMotion: 1,
                geometricBackground: true,
                backgroundOpacity: 0.5,
                cameraSpeed: 1,
                cameraMode: 'smooth',
                glow: 1,
                heroScale: 1,
                articleSpacing: 1,
                textHoldRatio: 0.35,
                hidePrintSymbols: false
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
            guidePulse: bool(source.guidePulse, fallback.guidePulse),
            backgroundDetail: clamp(source.backgroundDetail, 0, 1, fallback.backgroundDetail),
            backgroundMotion: clamp(source.backgroundMotion, 0, 2, fallback.backgroundMotion),
            vectorDecor: bool(source.vectorDecor, fallback.vectorDecor),
            decorOpacity: clamp(source.decorOpacity, 0, 1, fallback.decorOpacity),
            decorMotion: clamp(source.decorMotion, 0, 2, fallback.decorMotion),
            layoutStyle: enumValue(source.layoutStyle, ['calm', 'normal', 'chaotic'], fallback.layoutStyle),
            chorusRipple: bool(source.chorusRipple, fallback.chorusRipple),
            heroEmphasis: bool(source.heroEmphasis, fallback.heroEmphasis),
            showTranslation: bool(source.showTranslation, fallback.showTranslation),
            showUpcoming: bool(source.showUpcoming, fallback.showUpcoming),
            performanceIntensity: clamp(source.performanceIntensity, 0, 2, fallback.performanceIntensity),
            beatImpact: clamp(source.beatImpact, 0, 2, fallback.beatImpact),
            opticalImpact: clamp(source.opticalImpact, 0, 1, fallback.opticalImpact),
            accentEffects: bool(source.accentEffects, fallback.accentEffects),
            accentMotion: clamp(source.accentMotion, 0, 2, fallback.accentMotion),
            cameraIntensity: clamp(source.cameraIntensity, 0, 2, fallback.cameraIntensity),
            typographyMotion: clamp(source.typographyMotion, 0, 2, fallback.typographyMotion),
            glyphMotion: clamp(source.glyphMotion, 0, 2, fallback.glyphMotion),
            cameraBreath: clamp(source.cameraBreath, 0, 2, fallback.cameraBreath),
            cameraTracking: clamp(source.cameraTracking, 0, 1, fallback.cameraTracking),
            cameraSoftness: clamp(source.cameraSoftness, 0, 1, fallback.cameraSoftness),
            cameraRoll: clamp(source.cameraRoll, 0, 1, fallback.cameraRoll),
            lyricLayout: enumValue(source.lyricLayout, ['lines', 'phrases', 'staircase', 'editorial-track'], fallback.lyricLayout),
            phraseLength: Math.round(clamp(source.phraseLength, 6, 24, fallback.phraseLength) || 12),
            phraseEmphasis: clamp(source.phraseEmphasis, 0, 1, fallback.phraseEmphasis),
            trackVerticalChance: clamp(source.trackVerticalChance, 0.1, 0.9, fallback.trackVerticalChance),
            trackJunction: clamp(source.trackJunction, 0, 1, fallback.trackJunction),
            trackLookAhead: clamp(source.trackLookAhead, 0, 1, fallback.trackLookAhead),
            trackMinSegment: Math.round(clamp(source.trackMinSegment, 2, 8, fallback.trackMinSegment) || 3),
            sceneTransitions: bool(source.sceneTransitions, fallback.sceneTransitions),
            shotFlow: enumValue(source.shotFlow, ['auto', 'editorial-column', 'type-impact', 'fragment-collage', 'tracking-ribbon', 'mask-reveal', 'poster-blocks', 'quiet-tableau'], fallback.shotFlow),
            glyphStyle: enumValue(source.glyphStyle, ['rise', 'scatter', 'impact'], fallback.glyphStyle),
            waitingOpacity: clamp(source.waitingOpacity, 0, 1, fallback.waitingOpacity),
            releaseDuration: clamp(source.releaseDuration, 0, 1.5, fallback.releaseDuration),
            postProcess: bool(source.postProcess, fallback.postProcess),
            lensDistortion: clamp(source.lensDistortion, 0, 2, fallback.lensDistortion),
            lensDispersion: clamp(source.lensDispersion, 0, 1, fallback.lensDispersion),
            rgbShift: clamp(source.rgbShift, 0, 1, fallback.rgbShift),
            grain: clamp(source.grain, 0, 1, fallback.grain),
            contrast: clamp(source.contrast, 0, 1, fallback.contrast),
            halftone: clamp(source.halftone, 0, 1, fallback.halftone),
            vignette: clamp(source.vignette, 0, 1, fallback.vignette),
            colorMode: enumValue(source.colorMode, ['duo', 'mono', 'gradient'], fallback.colorMode),
            showBlocks: bool(source.showBlocks, fallback.showBlocks),
            showDecor: bool(source.showDecor, fallback.showDecor),
            showBackground: bool(source.showBackground, fallback.showBackground),
            textInversion: bool(source.textInversion, fallback.textInversion),
            motionAmount: clamp(source.motionAmount, 0, 2, fallback.motionAmount),
            audioReactivity: clamp(source.audioReactivity, 0, 2, fallback.audioReactivity),
            showParticles: bool(source.showParticles, fallback.showParticles),
            geometryMode: enumValue(source.geometryMode, ['clouds', 'corridor'], fallback.geometryMode),
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
            articleSpacing: clamp(source.articleSpacing, 0.65, 1.6, fallback.articleSpacing),
            textHoldRatio: clamp(source.textHoldRatio, 0, 1, fallback.textHoldRatio),
            hidePrintSymbols: bool(source.hidePrintSymbols, fallback.hidePrintSymbols),
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
            modes[entry.id] = normalizeMode(source.modes?.[entry.id], DEFAULTS.modes[entry.id] || {});
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