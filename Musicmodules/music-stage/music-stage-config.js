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
            lyricLayout: enumValue(source.lyricLayout, ['lines', 'phrases', 'staircase', 'editorial-track', 'starbloom'], fallback.lyricLayout),
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
            aurora: bool(source.aurora, fallback.aurora),
            journeyEvents: bool(source.journeyEvents, fallback.journeyEvents),
            fireworks: bool(source.fireworks, fallback.fireworks),
            cameraCuts: bool(source.cameraCuts, fallback.cameraCuts),
            letterbox: bool(source.letterbox, fallback.letterbox),
            lyricCarrier: enumValue(source.lyricCarrier, ['auto', 'sign', 'constellation'], fallback.lyricCarrier),
            narrativeStations: bool(source.narrativeStations, fallback.narrativeStations),
            stationIntensity: clamp(source.stationIntensity, 0, 2, fallback.stationIntensity),
            waterReflection: bool(source.waterReflection, fallback.waterReflection),
            waterStrength: clamp(source.waterStrength, 0, 2, fallback.waterStrength),
            motionAmount: clamp(source.motionAmount, 0, 2, fallback.motionAmount),
            audioReactivity: clamp(source.audioReactivity, 0, 2, fallback.audioReactivity),
            lyricHop: fallback.lyricHop === undefined ? source.lyricHop : clamp(source.lyricHop, 0, 2, fallback.lyricHop),
            lyricFont: fallback.lyricFont === undefined ? source.lyricFont : enumValue(source.lyricFont, ['sans', 'serif', 'kai'], fallback.lyricFont),
            coverTint: fallback.coverTint === undefined ? source.coverTint : clamp(source.coverTint, 0, 1, fallback.coverTint),
            showParticles: bool(source.showParticles, fallback.showParticles),
            geometryMode: enumValue(source.geometryMode, ['clouds', 'corridor'], fallback.geometryMode),
            cabinFrame: bool(source.cabinFrame, fallback.cabinFrame),
            rain: enumValue(source.rain, ['off', 'light', 'heavy', 'snow'], fallback.rain),
            fog: fallback.fog === undefined ? source.fog : clamp(source.fog, 0.5, 1.5, fallback.fog),
            lightning: fallback.lightning === undefined ? source.lightning : bool(source.lightning, fallback.lightning),
            reflections: fallback.reflections === undefined ? source.reflections : bool(source.reflections, fallback.reflections),
            cameraMode: fallback.cameraMode === undefined
                ? source.cameraMode
                : ['sandbox', 'auto', 'diorama'].includes(fallback.cameraMode)
                    ? enumValue(source.cameraMode, ['sandbox', 'auto', 'diorama'], fallback.cameraMode)
                    : enumValue(source.cameraMode, ['stepped', 'smooth'], fallback.cameraMode),
            figures: fallback.figures === undefined ? source.figures : bool(source.figures, fallback.figures),
            collisions: fallback.collisions === undefined ? source.collisions : bool(source.collisions, fallback.collisions),
            inkFlip: fallback.inkFlip === undefined ? source.inkFlip : bool(source.inkFlip, fallback.inkFlip),
            negativeShots: fallback.negativeShots === undefined ? source.negativeShots : bool(source.negativeShots, fallback.negativeShots),
            inkScene: fallback.inkScene === undefined ? source.inkScene : enumValue(source.inkScene, ['auto', 'notebook', 'rail', 'sea', 'night', 'city', 'flora', 'letters', 'weather', 'score'], fallback.inkScene),
            drops: fallback.drops === undefined ? source.drops : bool(source.drops, fallback.drops),
            drips: fallback.drips === undefined ? source.drips : bool(source.drips, fallback.drips),
            keywords: fallback.keywords === undefined ? source.keywords : bool(source.keywords, fallback.keywords),
            collage: fallback.collage === undefined ? source.collage : bool(source.collage, fallback.collage),
            view: fallback.view === undefined ? source.view : enumValue(source.view, ['street', 'aquarium', 'alternate'], fallback.view),
            fireflies: fallback.fireflies === undefined ? source.fireflies : clamp(source.fireflies, 0, 2, fallback.fireflies),
            spotlights: fallback.spotlights === undefined ? source.spotlights : clamp(source.spotlights, 0, 2, fallback.spotlights),
            nebula: fallback.nebula === undefined ? source.nebula : clamp(source.nebula, 0, 2, fallback.nebula),
            bloom: fallback.bloom === undefined ? source.bloom : clamp(source.bloom, 0, 2, fallback.bloom),
            flare: fallback.flare === undefined ? source.flare : clamp(source.flare, 0, 2, fallback.flare),
            bokeh: fallback.bokeh === undefined ? source.bokeh : clamp(source.bokeh, 0, 2, fallback.bokeh),
            cloud: fallback.cloud === undefined ? source.cloud : clamp(source.cloud, 0, 1, fallback.cloud),
            smoke: fallback.smoke === undefined ? source.smoke : clamp(source.smoke, 0, 2, fallback.smoke),
            dust: fallback.dust === undefined ? source.dust : clamp(source.dust, 0, 2, fallback.dust),
            density: fallback.density === undefined ? source.density : clamp(source.density, 0.4, 1.6, fallback.density),
            trails: fallback.trails === undefined ? source.trails : clamp(source.trails, 0, 1.6, fallback.trails),
            reflection: fallback.reflection === undefined ? source.reflection : bool(source.reflection, fallback.reflection),
            perspective: fallback.perspective === undefined ? source.perspective : bool(source.perspective, fallback.perspective),
            parallax: fallback.parallax === undefined ? source.parallax : clamp(source.parallax, 0, 2, fallback.parallax),
            wireframe: fallback.wireframe === undefined ? source.wireframe : bool(source.wireframe, fallback.wireframe),
            secondHand: fallback.secondHand === undefined ? source.secondHand : bool(source.secondHand, fallback.secondHand),
            tilt: fallback.tilt === undefined ? source.tilt : clamp(source.tilt, 0.15, 0.6, fallback.tilt),
            roll: fallback.roll === undefined ? source.roll : clamp(source.roll, -30, 30, fallback.roll),
            flecks: fallback.flecks === undefined ? source.flecks : clamp(source.flecks, 0, 2, fallback.flecks),
            lamp: fallback.lamp === undefined ? source.lamp : clamp(source.lamp, 0, 1.5, fallback.lamp),
            frame: fallback.frame === undefined ? source.frame : bool(source.frame, fallback.frame),
            timeOfDay: fallback.timeOfDay === undefined ? source.timeOfDay : bool(source.timeOfDay, fallback.timeOfDay),
            voiceNotes: fallback.voiceNotes === undefined ? source.voiceNotes : bool(source.voiceNotes, fallback.voiceNotes),
            echoes: fallback.echoes === undefined ? source.echoes : bool(source.echoes, fallback.echoes),
            reactions: fallback.reactions === undefined ? source.reactions : bool(source.reactions, fallback.reactions),
            panel: fallback.panel === undefined ? source.panel : enumValue(source.panel, ['lyrics', 'history', 'off'], fallback.panel),
            showSpectrum: fallback.showSpectrum === undefined ? source.showSpectrum : bool(source.showSpectrum, fallback.showSpectrum),
            pulseRate: fallback.pulseRate === undefined ? source.pulseRate : clamp(source.pulseRate, 0, 2, fallback.pulseRate),
            axisLine: fallback.axisLine === undefined ? source.axisLine : bool(source.axisLine, fallback.axisLine),
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
            heroScale: clamp(source.heroScale, 0.82, 1.32, fallback.heroScale),
            articleSpacing: clamp(source.articleSpacing, 0.65, 1.6, fallback.articleSpacing),
            textHoldRatio: clamp(source.textHoldRatio, 0, 1, fallback.textHoldRatio),
            hidePrintSymbols: bool(source.hidePrintSymbols, fallback.hidePrintSymbols),
            transitionLock: clamp(source.transitionLock, 0.5, 12, fallback.transitionLock),
            avoidRepeat: bool(source.avoidRepeat, fallback.avoidRepeat),
            pauseDuration: clamp(source.pauseDuration, 0, 3, fallback.pauseDuration),
            objectDensity: clamp(source.objectDensity, 0.25, 2, fallback.objectDensity),
            starfield: bool(source.starfield, fallback.starfield),
            showPlanets: bool(source.showPlanets, fallback.showPlanets),
            showRings: bool(source.showRings, fallback.showRings),
            showShips: bool(source.showShips, fallback.showShips),
            showStations: bool(source.showStations, fallback.showStations),
            dissolveAmount: clamp(source.dissolveAmount, 0, 1, fallback.dissolveAmount),
            cameraShake: clamp(source.cameraShake, 0, 2, fallback.cameraShake)
        };
    };

    const normalize = (candidate) => {
        const source = candidate && typeof candidate === 'object' ? candidate : {};
        const savedVersion = Number(source.version) || 0;
        const requestedModes = Array.isArray(source.enabledModes)
            ? source.enabledModes.concat(Object.keys(ADDED_IN).filter((id) => savedVersion < ADDED_IN[id]))
            : DEFAULTS.enabledModes;
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
            themeMode: enumValue(source.themeMode, ['global', 'custom'], DEFAULTS.themeMode),
            themeFile: typeof source.themeFile === 'string' ? source.themeFile : DEFAULTS.themeFile,
            themeVariant: enumValue(source.themeVariant, ['dark', 'light'], DEFAULTS.themeVariant),
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