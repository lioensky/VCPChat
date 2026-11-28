(function (global) {
    'use strict';

    const STORAGE_KEY = 'musicStageConfig';
    const VERSION = 14;
    // 后来加的模式：旧版本存下的启用列表里没有它们，读到旧版本时补上。
    const ADDED_IN = Object.freeze({ kowloon: 5, inkdraft: 6, fogpane: 7, lumiere: 8, hanabi: 9, clockwork: 10, orbit: 11, signal: 12, groupchat: 13, impression: 14 });
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
        { id: 'diorama', label: '镜台', description: '末班车：浅水铁道、星空倒影与章节化歌词演出' },
        { id: 'fume', label: '浮名', description: '二维连续文字世界与长卷式镜头叙事' },
        { id: 'luminous', label: '流光', description: '逐字辉光与呼吸浮动' },
        { id: 'partita', label: '云阶', description: '分块排版与引导线' },
        { id: 'cadenza', label: '心象', description: '空间排版与镜头漂移' },
        { id: 'starborn', label: '星诞', description: '按歌词段落自动导演' },
        { id: 'tunnel', label: '隧图', description: '点阵星际穿行、实体化歌词与深空物体演出' },
        { id: 'kowloon', label: '町景', description: '雨夜叠楼城寨：霓虹招牌、窄巷与广告屏上的歌词' },
        { id: 'inkdraft', label: '墨痕', description: '墨团凝成歌词、演算纸线稿、半调网点与踩词硬切' },
        { id: 'fogpane', label: '雾笺', description: '雨夜车窗起了雾，手指一笔一笔写下歌词，透出窗外街景' },
        { id: 'lumiere', label: '绘光', description: '舞台顶光、烟雾和浮尘，每一句歌词被光束照亮' },
        { id: 'hanabi', label: '花火', description: '夏夜河边的烟花大会，每句歌词升起一发烟花，倒映在河面上' },
        { id: 'clockwork', label: '时计', description: '一组咬合的齿轮，歌词像指针从轴心伸出，每唱一句齿轮转一格' },
        { id: 'orbit', label: '回环', description: '一圈斜着的椭圆轨道，歌词排在轨道上，唱到的字转到最前面' },
        { id: 'signal', label: '信号', description: '一条∞形的信号环，脉冲沿环流动，频谱和电平跟着音乐跳，歌词在监视窗里' },
        { id: 'groupchat', label: '群唱', description: '歌词变成一个群聊：大家轮流发消息、一字一字打出来，副歌一起唱，间奏发语音' },
        { id: 'impression', label: '印象', description: '封面重画成一幅油画挂在墙上，每段换一个时辰的光，歌词像展签一样走' }
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
        enabledModes: ['tempera', 'sonnet', 'diorama', 'fume', 'luminous', 'partita', 'cadenza', 'starborn', 'tunnel', 'kowloon', 'inkdraft', 'fogpane', 'lumiere', 'hanabi', 'clockwork', 'orbit', 'signal', 'groupchat', 'impression'],
        quality: 'standard',
        animationIntensity: 1,
        edgeSpectrum: true,
        themeMode: 'global',
        themeFile: '',
        themeVariant: 'dark',
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
                aurora: true,
                journeyEvents: true,
                fireworks: false,
                cameraCuts: true,
                letterbox: true,
                lyricCarrier: 'auto',
                showTranslation: true,
                postProcess: true,
                grain: 0.08,
                vignette: 0.22,
                narrativeStations: true,
                stationIntensity: 1,
                waterReflection: true,
                waterStrength: 1,
                cameraSpeed: 1,
                motionAmount: 1,
                audioReactivity: 1,
                lyricHop: 1,
                lyricFont: 'sans',
                coverTint: 0.5,
                showParticles: true,
                geometryMode: 'clouds',
                cabinFrame: true,
                rain: 'off',
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
            },
            tunnel: {
                cameraSpeed: 1,
                motionAmount: 1,
                cameraBreath: 0.5,
                cameraShake: 1,
                pauseDuration: 0.4,
                showTranslation: true,
                objectDensity: 1,
                starfield: true,
                showPlanets: true,
                showRings: true,
                showShips: true,
                showStations: true,
                dissolveAmount: 0.72,
                textHoldRatio: 0.32,
                fontScale: 1,
                glow: 1,
                audioReactivity: 1,
                lyricHop: 1,
                lyricFont: 'sans',
                coverTint: 0.5
            },
            kowloon: {
                cameraMode: 'sandbox',
                rain: 'light',
                lightning: true,
                reflections: true,
                fog: 1,
                postProcess: true,
                glow: 1,
                grain: 0.06,
                vignette: 0.28,
                showTranslation: true,
                audioReactivity: 1
            },
            inkdraft: {
                cameraCuts: true,
                figures: true,
                collisions: true,
                inkFlip: false,
                negativeShots: true,
                inkScene: 'auto',
                halftone: 0.8,
                cloud: 0.75,
                keywords: true,
                grain: 0.5,
                fontScale: 1,
                waitingOpacity: 0.35,
                showTranslation: true,
                audioReactivity: 1
            },
            fogpane: {
                fontScale: 1,
                fog: 1,
                rain: 'light',
                view: 'alternate',
                drops: true,
                drips: true,
                fireflies: 1,
                spotlights: 0,
                cameraSpeed: 1,
                grain: 0.4,
                showTranslation: true
            },
            lumiere: {
                fontScale: 1,
                smoke: 1,
                dust: 1,
                waitingOpacity: 0.22,
                audioReactivity: 1,
                grain: 0.4,
                flare: 1,
                bokeh: 1,
                showTranslation: true
            },
            hanabi: {
                fontScale: 1,
                density: 1,
                trails: 1,
                smoke: 1,
                reflection: true,
                waitingOpacity: 0.25,
                audioReactivity: 1,
                grain: 0.3,
                bloom: 1,
                collage: true,
                showTranslation: true
            },
            clockwork: {
                fontScale: 1,
                waitingOpacity: 0.35,
                secondHand: true,
                smoke: 1,
                wireframe: true,
                perspective: true,
                parallax: 1,
                audioReactivity: 1,
                grain: 0.3,
                showTranslation: true
            },
            orbit: {
                fontScale: 1,
                tilt: 0.3,
                roll: -12,
                axisLine: true,
                nebula: 1,
                waitingOpacity: 0.3,
                audioReactivity: 1,
                grain: 0.3,
                showTranslation: true
            },
            impression: {
                fontScale: 1,
                flecks: 1,
                lamp: 1,
                frame: true,
                timeOfDay: true,
                audioReactivity: 1,
                grain: 0.3,
                showTranslation: true
            },
            groupchat: {
                fontScale: 1,
                voiceNotes: true,
                echoes: true,
                reactions: true,
                audioReactivity: 1,
                showTranslation: true
            },
            signal: {
                fontScale: 1,
                panel: 'lyrics',
                showSpectrum: true,
                pulseRate: 1,
                audioReactivity: 1,
                grain: 0.3,
                showTranslation: true
            }
        }
    });

    const rng = (min, max) => (v, fb) => clamp(v, min, max, fb);
    const enm = (values) => (v, fb) => enumValue(v, values, fb);
    const opt = (fn) => (v, fb) => (fb === undefined ? v : fn(v, fb));
    const CAMERA_3D_MODES = ['sandbox', 'auto', 'diorama'];
    const CAMERA_2D_MODES = ['stepped', 'smooth'];
    const MODE_VALIDATORS = Object.freeze({
        guidePulse: bool,
        backgroundDetail: rng(0, 1),
        backgroundMotion: rng(0, 2),
        vectorDecor: bool,
        decorOpacity: rng(0, 1),
        decorMotion: rng(0, 2),
        layoutStyle: enm(['calm', 'normal', 'chaotic']),
        chorusRipple: bool,
        heroEmphasis: bool,
        showTranslation: bool,
        showUpcoming: bool,
        performanceIntensity: rng(0, 2),
        beatImpact: rng(0, 2),
        opticalImpact: rng(0, 1),
        accentEffects: bool,
        accentMotion: rng(0, 2),
        cameraIntensity: rng(0, 2),
        typographyMotion: rng(0, 2),
        glyphMotion: rng(0, 2),
        cameraBreath: rng(0, 2),
        cameraTracking: rng(0, 1),
        cameraSoftness: rng(0, 1),
        cameraRoll: rng(0, 1),
        lyricLayout: enm(['lines', 'phrases', 'staircase', 'editorial-track', 'starbloom']),
        phraseLength: (v, fb) => Math.round(clamp(v, 6, 24, fb) || 12),
        phraseEmphasis: rng(0, 1),
        trackVerticalChance: rng(0.1, 0.9),
        trackJunction: rng(0, 1),
        trackLookAhead: rng(0, 1),
        trackMinSegment: (v, fb) => Math.round(clamp(v, 2, 8, fb) || 3),
        sceneTransitions: bool,
        shotFlow: enm(['auto', 'editorial-column', 'type-impact', 'fragment-collage', 'tracking-ribbon', 'mask-reveal', 'poster-blocks', 'quiet-tableau']),
        glyphStyle: enm(['rise', 'scatter', 'impact']),
        waitingOpacity: rng(0, 1),
        releaseDuration: rng(0, 1.5),
        postProcess: bool,
        lensDistortion: rng(0, 2),
        lensDispersion: rng(0, 1),
        rgbShift: rng(0, 1),
        grain: rng(0, 1),
        contrast: rng(0, 1),
        halftone: rng(0, 1),
        vignette: rng(0, 1),
        colorMode: enm(['duo', 'mono', 'gradient']),
        showBlocks: bool,
        showDecor: bool,
        showBackground: bool,
        textInversion: bool,
        aurora: bool,
        journeyEvents: bool,
        fireworks: bool,
        cameraCuts: bool,
        letterbox: bool,
        lyricCarrier: enm(['auto', 'sign', 'constellation']),
        narrativeStations: bool,
        stationIntensity: rng(0, 2),
        waterReflection: bool,
        waterStrength: rng(0, 2),
        motionAmount: rng(0, 2),
        audioReactivity: rng(0, 2),
        lyricHop: opt(rng(0, 2)),
        lyricFont: opt(enm(['sans', 'serif', 'kai'])),
        coverTint: opt(rng(0, 1)),
        showParticles: bool,
        geometryMode: enm(['clouds', 'corridor']),
        cabinFrame: bool,
        rain: enm(['off', 'light', 'heavy', 'snow']),
        fog: opt(rng(0.5, 1.5)),
        lightning: opt(bool),
        reflections: opt(bool),
        cameraMode: (v, fb) => (fb === undefined
            ? v
            : (CAMERA_3D_MODES.includes(fb)
                ? enumValue(v, CAMERA_3D_MODES, fb)
                : enumValue(v, CAMERA_2D_MODES, fb))),
        figures: opt(bool),
        collisions: opt(bool),
        inkFlip: opt(bool),
        negativeShots: opt(bool),
        inkScene: opt(enm(['auto', 'notebook', 'rail', 'sea', 'night', 'city', 'flora', 'letters', 'weather', 'score'])),
        drops: opt(bool),
        drips: opt(bool),
        keywords: opt(bool),
        collage: opt(bool),
        view: opt(enm(['street', 'aquarium', 'alternate'])),
        fireflies: opt(rng(0, 2)),
        spotlights: opt(rng(0, 2)),
        nebula: opt(rng(0, 2)),
        bloom: opt(rng(0, 2)),
        flare: opt(rng(0, 2)),
        bokeh: opt(rng(0, 2)),
        cloud: opt(rng(0, 1)),
        smoke: opt(rng(0, 2)),
        dust: opt(rng(0, 2)),
        density: opt(rng(0.4, 1.6)),
        trails: opt(rng(0, 1.6)),
        reflection: opt(bool),
        perspective: opt(bool),
        parallax: opt(rng(0, 2)),
        wireframe: opt(bool),
        secondHand: opt(bool),
        tilt: opt(rng(0.15, 0.6)),
        roll: opt(rng(-30, 30)),
        flecks: opt(rng(0, 2)),
        lamp: opt(rng(0, 1.5)),
        frame: opt(bool),
        timeOfDay: opt(bool),
        voiceNotes: opt(bool),
        echoes: opt(bool),
        reactions: opt(bool),
        panel: opt(enm(['lyrics', 'history', 'off'])),
        showSpectrum: opt(bool),
        pulseRate: opt(rng(0, 2)),
        axisLine: opt(bool),
        wordRotation: bool,
        breathing: rng(0, 2),
        wordSpacing: rng(0, 2),
        glow: rng(0, 2),
        guideLines: bool,
        semanticLayout: bool,
        staggerMin: rng(0, 180),
        staggerMax: rng(0, 180),
        power: rng(0, 2),
        motion: rng(0, 2),
        fontScale: rng(0.65, 1.5),
        widthRatio: rng(0.5, 0.95),
        geometricBackground: bool,
        backgroundOpacity: rng(0, 1),
        cameraSpeed: rng(0.55, 1.85),
        heroScale: rng(0.82, 1.32),
        articleSpacing: rng(0.65, 1.6),
        textHoldRatio: rng(0, 1),
        hidePrintSymbols: bool,
        transitionLock: rng(0.5, 12),
        avoidRepeat: bool,
        pauseDuration: rng(0, 3),
        objectDensity: rng(0.25, 2),
        starfield: bool,
        showPlanets: bool,
        showRings: bool,
        showShips: bool,
        showStations: bool,
        dissolveAmount: rng(0, 1),
        cameraShake: rng(0, 2)
    });

    const HAS_OWN = Object.prototype.hasOwnProperty;
    const ADDED_IN_KEYS = Object.freeze(Object.keys(ADDED_IN));
    const QUALITY_VALUES = Object.freeze(['energy-saving', 'standard', 'ultimate']);
    const THEME_MODE_VALUES = Object.freeze(['global', 'custom']);
    const THEME_VARIANT_VALUES = Object.freeze(['dark', 'light']);

    const normalizeMode = (mode, fallback) => {
        const source = mode && typeof mode === 'object' ? mode : null;
        const out = {};
        for (const key in fallback) {
            if (!HAS_OWN.call(fallback, key)) continue;
            const fb = fallback[key];
            const sv = source && HAS_OWN.call(source, key) ? source[key] : undefined;
            const validator = HAS_OWN.call(MODE_VALIDATORS, key) ? MODE_VALIDATORS[key] : null;
            const val = validator ? validator(sv, fb) : (sv !== undefined ? sv : fb);
            if (val !== undefined) out[key] = val;
        }
        if (source) {
            for (const key in source) {
                if (!HAS_OWN.call(source, key) || HAS_OWN.call(fallback, key)) continue;
                const sv = source[key];
                const validator = HAS_OWN.call(MODE_VALIDATORS, key) ? MODE_VALIDATORS[key] : null;
                const val = validator ? validator(sv, undefined) : sv;
                if (val !== undefined) out[key] = val;
            }
        }
        return out;
    };

    const normalize = (candidate) => {
        const source = candidate && typeof candidate === 'object' ? candidate : {};
        const savedVersion = Number(source.version) || 0;
        let requestedModes = DEFAULTS.enabledModes;
        if (Array.isArray(source.enabledModes)) {
            requestedModes = source.enabledModes.slice();
            for (let i = 0; i < ADDED_IN_KEYS.length; i += 1) {
                const id = ADDED_IN_KEYS[i];
                if (savedVersion < ADDED_IN[id]) requestedModes.push(id);
            }
        }
        const requestedSet = new Set(requestedModes);
        const enabledModes = [];
        const modes = {};
        for (let i = 0; i < MODE_META.length; i += 1) {
            const id = MODE_META[i].id;
            if (requestedSet.has(id)) enabledModes.push(id);
            modes[id] = normalizeMode(source.modes?.[id], DEFAULTS.modes[id] || {});
        }
        if (!enabledModes.length) enabledModes.push('luminous');

        return {
            version: VERSION,
            enabledModes,
            quality: enumValue(source.quality, QUALITY_VALUES, DEFAULTS.quality),
            animationIntensity: clamp(source.animationIntensity, 0, 2, DEFAULTS.animationIntensity),
            edgeSpectrum: bool(source.edgeSpectrum, DEFAULTS.edgeSpectrum),
            themeMode: enumValue(source.themeMode, THEME_MODE_VALUES, DEFAULTS.themeMode),
            themeFile: typeof source.themeFile === 'string' ? source.themeFile : DEFAULTS.themeFile,
            themeVariant: enumValue(source.themeVariant, THEME_VARIANT_VALUES, DEFAULTS.themeVariant),
            modes
        };
    };

    const clone = (value) => {
        if (!value || typeof value !== 'object') return value;
        const modes = {};
        if (value.modes) {
            for (const key in value.modes) {
                if (Object.prototype.hasOwnProperty.call(value.modes, key)) modes[key] = { ...value.modes[key] };
            }
        }
        return {
            ...value,
            enabledModes: Array.isArray(value.enabledModes) ? value.enabledModes.slice() : [],
            modes
        };
    };
    const MODE_IDS = new Set(MODE_META.map((entry) => entry.id));
    let current = null;
    const listeners = new Set();
    let persistTimer = null;
    let persistDirty = false;

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

    const persistNow = () => {
        if (persistTimer !== null) { global.clearTimeout?.(persistTimer); persistTimer = null; }
        persistDirty = false;
        try {
            global.localStorage?.setItem(STORAGE_KEY, JSON.stringify(current));
        } catch (error) {
            console.warn('[MusicStageConfig] persist failed:', error);
        }
    };

    const schedulePersist = () => {
        persistDirty = true;
        if (typeof global.setTimeout !== 'function') { persistNow(); return; }
        if (persistTimer !== null) return;
        persistTimer = global.setTimeout(() => {
            persistTimer = null;
            if (persistDirty) persistNow();
        }, 250);
    };

    const flushPersist = () => {
        if (persistDirty) persistNow();
    };

    const load = () => {
        if (persistTimer !== null) { global.clearTimeout?.(persistTimer); persistTimer = null; }
        persistDirty = false;
        try {
            const saved = global.localStorage?.getItem(STORAGE_KEY);
            current = normalize(saved ? JSON.parse(saved) : DEFAULTS);
        } catch (error) {
            current = normalize(DEFAULTS);
        }
        return clone(current);
    };

    const update = (patch, options = null) => {
        const source = typeof patch === 'function' ? patch(clone(current)) : patch;
        current = normalize({
            ...current,
            ...(source || {}),
            modes: {
                ...current.modes,
                ...(source?.modes || {})
            }
        });
        if (options && options.debounce) schedulePersist();
        else persistNow();
        notify();
        return clone(current);
    };

    const setModePatch = (modeId, patch) => {
        if (!MODE_IDS.has(modeId)) return clone(current);
        const prevMode = current.modes[modeId] || {};
        const merged = { ...prevMode, ...(patch || {}) };
        const nextMode = normalizeMode(merged, DEFAULTS.modes[modeId] || {});
        const hasOwn = Object.prototype.hasOwnProperty;
        let prevCount = 0;
        for (const key in prevMode) if (hasOwn.call(prevMode, key)) prevCount += 1;
        let nextCount = 0;
        let same = true;
        for (const key in nextMode) {
            if (!hasOwn.call(nextMode, key)) continue;
            nextCount += 1;
            if (same && !Object.is(prevMode[key], nextMode[key])) same = false;
        }
        if (same && nextCount === prevCount) {
            return clone(current);
        }
        current = {
            ...current,
            modes: {
                ...current.modes,
                [modeId]: nextMode
            }
        };
        schedulePersist();
        notify();
        return clone(current);
    };

    const toggleMode = (modeId, enabled) => {
        if (!MODE_IDS.has(modeId)) return clone(current);
        const src = current.enabledModes;
        const enabledModes = [];
        for (let i = 0; i < src.length; i += 1) {
            if (src[i] !== modeId) enabledModes.push(src[i]);
        }
        if (enabled) enabledModes.push(modeId);
        return update({ enabledModes });
    };

    const reset = () => {
        current = normalize(DEFAULTS);
        persistNow();
        notify();
        return clone(current);
    };

    load();
    global.addEventListener?.('beforeunload', flushPersist, { once: true });
    global.addEventListener?.('pagehide', flushPersist, { once: true });

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
        flush: flushPersist,
        subscribe(listener) {
            if (typeof listener !== 'function') return () => {};
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    });
})(window);