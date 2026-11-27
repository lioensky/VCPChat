(function (global) {
    'use strict';

    const Runtime = global.MusicStageRuntime;
    const Modes = global.MusicStageModes;
    const Config = global.MusicStageConfig;
    if (!Runtime || !Modes || !Config) throw new Error('Music stage runtime, config and modes must load before music-stage-host.js');

    const { clamp, DisposableScope } = Runtime;
    // 模式外观特性（3D / 铺满 / 夜色）只在登记表里写一份，见 music-stage-advanced-modes.js
    const modeTraits = (id) => Modes.traits?.(id) || { scene3d: false, opaque: false, night: false };

    // 和 music-utils 的 app.fileUrl 一样：路径里的空格、#、?、'、% 都要编码，否则封面断图
    const fileUrl = (path) => {
        if (!path) return '';
        const p = String(path).replace(/\\/g, '/');
        return 'file://' + encodeURI(p.startsWith('/') ? p : '/' + p).replace(/[?#']/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    };

    const resolveThemeAssetValue = (value) => {
        if (typeof value !== 'string' || !value.includes('url(')) return value;
        // Theme files are normally copied to styles/themes.css before being
        // loaded by the main page. Resolve their relative assets against that
        // effective stylesheet location, not against this music-stage script.
        const base = new URL('../styles/themes.css', document.baseURI);
        return value.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, assetPath) => {
            if (/^(?:data:|https?:|file:|blob:|#)/i.test(assetPath)) return match;
            try {
                return `url("${new URL(assetPath, base).href}")`;
            } catch (error) {
                return match;
            }
        });
    };

    const createElement = (tag, className, attributes = {}) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        const resolvedAttributes = typeof attributes === 'string'
            ? { text: attributes }
            : attributes;
        Object.entries(resolvedAttributes || {}).forEach(([name, value]) => {
            if (name === 'text') element.textContent = value;
            else if (name === 'html') element.innerHTML = value;
            else if (value !== undefined && value !== null) element.setAttribute(name, String(value));
        });
        return element;
    };

    const icons = Object.freeze({
        previous: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.5 5.5v13L9 12l9.5-6.5ZM5 5h2v14H5z" fill="currentColor"/></svg>',
        next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 5.5v13L15 12 5.5 5.5ZM17 5h2v14h-2z" fill="currentColor"/></svg>',
        play: '<svg class="stage-play-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 5v14L19 12 7.5 5Z" fill="currentColor"/></svg>',
        pause: '<svg class="stage-pause-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6V5Zm8 0h4v14h-4V5Z" fill="currentColor"/></svg>',
        volume: '<svg class="stage-volume-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Zm12.2-.8a5.4 5.4 0 0 1 0 7.6M18.8 5.6a9 9 0 0 1 0 12.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        muted: '<svg class="stage-muted-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4m4.5-1.5 11 11m0-11-11 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        repeat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m17 3 4 4-4 4M3 10V8a3 3 0 0 1 3-3h15M7 21l-4-4 4-4m14 1v2a3 3 0 0 1-3 3H3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        repeatOne: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m17 3 4 4-4 4M3 10V8a3 3 0 0 1 3-3h15M7 21l-4-4 4-4m14 1v2a3 3 0 0 1-3 3H3M11 10h2v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        shuffle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    });

    function setupMusicStage(app) {
        const root = document.getElementById('music-stage');
        if (!root) {
            console.warn('[MusicStage] Required DOM was not found.');
            return;
        }

        const elements = {
            backdropCurrent: root.querySelector('.music-stage-backdrop-current'),
            backdropNext: root.querySelector('.music-stage-backdrop-next'),
            shade: root.querySelector('.music-stage-shade'),
            edgeSpectrum: root.querySelector('.music-stage-edge-spectrum'),
            edgeCanvas: root.querySelector('.music-stage-edge-spectrum-canvas'),
            modeRoot: root.querySelector('.music-stage-mode-root'),
            modeSwitcher: root.querySelector('.music-stage-mode-switcher')
                || document.querySelector('#custom-title-bar .music-stage-mode-picker'),
            homeButton: document.querySelector('#custom-title-bar .music-stage-home'),
            settings: root.querySelector('.music-stage-settings'),
            settingsToggle: root.querySelector('.music-stage-settings-toggle'),
            settingsCard: root.querySelector('.music-stage-settings-card'),
            settingsClose: root.querySelector('.music-stage-settings-close'),
            modeOptions: root.querySelector('.music-stage-mode-options'),
            tuningControls: root.querySelector('.music-stage-tuning-controls'),
            commonControls: root.querySelector('.music-stage-common-controls'),
            settingsHint: root.querySelector('.music-stage-current-mode-hint'),
            settingsReset: root.querySelector('.music-stage-settings-reset'),
            settingsStatus: root.querySelector('.music-stage-settings-status'),
            cover: root.querySelector('.music-stage-cover'),
            title: root.querySelector('.music-stage-track-title'),
            artist: root.querySelector('.music-stage-track-artist'),
            album: root.querySelector('.music-stage-track-album'),
            currentTime: root.querySelector('.music-stage-current-time'),
            duration: root.querySelector('.music-stage-duration'),
            progressTrack: root.querySelector('.music-stage-progress-track'),
            progressFill: root.querySelector('.music-stage-progress-fill'),
            progressGlow: root.querySelector('.music-stage-progress-glow'),
            playMode: root.querySelector('[data-stage-action="play-mode"]'),
            prev: root.querySelector('[data-stage-action="previous"]'),
            play: root.querySelector('[data-stage-action="toggle-play"]'),
            next: root.querySelector('[data-stage-action="next"]'),
            volumeButton: root.querySelector('[data-stage-action="toggle-mute"]'),
            volumeSlider: root.querySelector('.music-stage-volume-slider'),
            chrome: root.querySelector('.music-stage-chrome'),
            emptyNotice: root.querySelector('.music-stage-empty-notice')
        };


        const scope = new DisposableScope();
        let editingSettings = false;
        let settingsReturnFocus = null;
        const pixiTuningDefinitions = [
            { key: 'performanceIntensity', label: '场景编舞强度', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
            { key: 'beatImpact', label: '音频起音冲击', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
            { key: 'opticalImpact', label: '瞬态套印色散', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'accentEffects', label: '歌词强调（短语回声／螺旋落字／外框循迹）', type: 'toggle' },
            { key: 'accentMotion', label: '歌词强调动势', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
            { key: 'sceneTransitions', label: '切句过渡', type: 'toggle' },
            { key: 'shotFlow', label: '分镜镜头', type: 'select', options: [['auto', '自动导演'], ['editorial-column', '编辑纵列'], ['type-impact', '文字冲击'], ['fragment-collage', '碎片拼贴'], ['tracking-ribbon', '带状追焦'], ['mask-reveal', '上升揭幕'], ['poster-blocks', '海报定景'], ['quiet-tableau', '静谧长镜']] },
            { key: 'cameraSoftness', label: '镜头平缓度', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'cameraRoll', label: '镜头侧倾', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'lyricLayout', label: '歌词构图', type: 'select', options: [['lines', '整句分行'], ['phrases', '短语分组'], ['staircase', '阶梯短语'], ['editorial-track', '纵横连续版轨'], ['starbloom', '繁星如盛']] },
            { key: 'trackVerticalChance', label: '版轨纵排概率', type: 'range', min: 0.1, max: 0.9, step: 0.05, unit: '%', onlyWhen: ['lyricLayout', ['editorial-track']] },
            { key: 'trackJunction', label: '版轨交错幅度', type: 'range', min: 0, max: 1, step: 0.05, unit: '%', onlyWhen: ['lyricLayout', ['editorial-track']] },
            { key: 'trackLookAhead', label: '镜头提前看下一段', type: 'range', min: 0, max: 1, step: 0.05, unit: '%', onlyWhen: ['lyricLayout', ['editorial-track']] },
            { key: 'trackMinSegment', label: '换栏最短字数', type: 'range', min: 2, max: 8, step: 1, unit: '字', onlyWhen: ['lyricLayout', ['editorial-track']] },
            { key: 'phraseLength', label: '短语目标字数', type: 'range', min: 6, max: 24, step: 1, unit: '字' },
            { key: 'phraseEmphasis', label: '短语聚光', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'cameraTracking', label: '逐词追焦', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'cameraBreath', label: '镜头呼吸', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
            { key: 'fontScale', label: '歌词字号', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
            { key: 'glyphStyle', label: '逐字入场', type: 'select', options: [['rise', '升起落位'], ['scatter', '交错散入'], ['impact', '缩放打击']] },
            { key: 'waitingOpacity', label: '未唱文字可见度', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'releaseDuration', label: '句尾消散', type: 'range', min: 0, max: 1.5, step: 0.05, unit: 's' },
            { key: 'lensDistortion', label: '镜头光学畸变', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
            { key: 'lensDispersion', label: '径向色散', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'rgbShift', label: '色彩错位', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'grain', label: '胶片颗粒', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'contrast', label: '对比度增强', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'halftone', label: '半调网点', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'vignette', label: '镜头暗角', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' }
        ];
        const lyricPerformanceControls = [
            { key: 'chorusRipple', label: '副歌涟漪（需歌词副歌标记）', type: 'toggle' },
            { key: 'sceneTransitions', label: '切句进退场', type: 'toggle' },
            { key: 'showTranslation', label: '翻译／罗马音', type: 'toggle' },
            { key: 'showUpcoming', label: '下一句预告', type: 'toggle' }
        ];
        const vectorDecorControls = [
            { key: 'vectorDecor', label: '矢量装饰', type: 'toggle' },
            { key: 'decorOpacity', label: '装饰可见度', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'decorMotion', label: '装饰运动', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' }
        ];
        const lyricLayoutStyle = { key: 'layoutStyle', label: '构图风格', type: 'select', options: [['calm', '平静'], ['normal', '标准'], ['chaotic', '奔放']] };
        const tuningDefinitions = Object.freeze({
            tempera: [
                { key: 'cameraIntensity', label: '镜头强度', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'glyphMotion', label: '逐字动势', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'colorMode', label: '色彩模式', type: 'select', options: [['duo', '主题双色'], ['mono', '黑白灰'], ['gradient', '封面渐变']] },
                { key: 'showBlocks', label: '色块场景', type: 'toggle' },
                { key: 'showDecor', label: '装饰元素', type: 'toggle' },
                { key: 'textInversion', label: '演唱强调色', type: 'toggle' },
                { key: 'postProcess', label: '光学后期（节能档关闭）', type: 'toggle' },
                ...pixiTuningDefinitions
            ],
            sonnet: [
                { key: 'cameraIntensity', label: '镜头强度', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'typographyMotion', label: '文字动势', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'guideLines', label: '轨迹线', type: 'toggle' },
                { key: 'showBackground', label: '主场景', type: 'toggle' },
                { key: 'showDecor', label: '背景装饰', type: 'toggle' },
                { key: 'postProcess', label: '光学后期（节能档关闭）', type: 'toggle' },
                ...pixiTuningDefinitions
            ],
            diorama: [
                { key: 'aurora', label: '天际极光（左上方流动光幕，随韵律波动）', type: 'toggle' },
                { key: 'journeyEvents', label: '旅途奇遇（留白中的流星与水面生灵）', type: 'toggle' },
                { key: 'fireworks', label: '远方烟花（副歌句尾与段后，默认关闭）', type: 'toggle' },
                { key: 'cameraCuts', label: '自动剪辑（避开演唱中的字）', type: 'toggle' },
                { key: 'letterbox', label: '电影遮幅', type: 'toggle' },
                { key: 'lyricCarrier', label: '歌词载体', type: 'select', options: [['auto', '章节自动编排'], ['sign', '沿线站牌'], ['constellation', '星空文字']] },
                { key: 'showTranslation', label: '翻译／罗马音', type: 'toggle' },
                { key: 'postProcess', label: '光学后期（节能档关闭）', type: 'toggle' },
                { key: 'grain', label: '胶片颗粒', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'vignette', label: '镜头暗角', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'narrativeStations', label: '沿线站台与电线杆', type: 'toggle' },
                { key: 'stationIntensity', label: '沿线设施密度', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'waterReflection', label: '水面倒影', type: 'toggle' },
                { key: 'waterStrength', label: '倒影强度', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'cameraSpeed', label: '镜头速度', type: 'range', min: 0.55, max: 1.85, step: 0.05, unit: 'x' },
                { key: 'motionAmount', label: '运动幅度', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'audioReactivity', label: '音频响应', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'lyricHop', label: '字随拍跳（正在唱的字随鼓点轻跳，0 关闭）', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'lyricFont', label: '歌词字体', type: 'select', options: [['sans', '黑体'], ['serif', '宋体（明朝）'], ['kai', '楷体']] },
                { key: 'coverTint', label: '天色随封面（封面的主色染进天空与极光，0 关闭）', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'showParticles', label: '天球星空', type: 'toggle' },
                { key: 'geometryMode', label: '取景方式', type: 'select', options: [['clouds', '电影取景'], ['corridor', '全幅取景']] },
                { key: 'cabinFrame', label: '车窗前景（侧望窗外时淡入）', type: 'toggle' },
                { key: 'rain', label: '雨（节能档减量）', type: 'select', options: [['off', '关'], ['light', '小雨'], ['heavy', '大雨']] },
                { key: 'glow', label: '辉光强度', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' }
            ],
            luminous: [
                ...vectorDecorControls,
                { key: 'fontScale', label: '歌词字号', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'semanticLayout', label: '语义与标点组合', type: 'toggle' },
                lyricLayoutStyle,
                ...lyricPerformanceControls,
                { key: 'wordRotation', label: '逐字旋转', type: 'toggle' },
                { key: 'breathing', label: '呼吸浮动', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'wordSpacing', label: '文字间距', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'glow', label: '辉光强度', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' }
            ],
            partita: [
                ...vectorDecorControls,
                { key: 'guidePulse', label: '短语引导光点', type: 'toggle' },
                { key: 'fontScale', label: '歌词字号', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'glow', label: '逐字辉光', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'breathing', label: '整句呼吸', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                lyricLayoutStyle,
                ...lyricPerformanceControls,
                { key: 'guideLines', label: '引导线', type: 'toggle' },
                { key: 'semanticLayout', label: '语义分块', type: 'toggle' },
                { key: 'staggerMin', label: '最小错位', type: 'range', min: 0, max: 180, step: 5, unit: 'px' },
                { key: 'staggerMax', label: '最大错位', type: 'range', min: 0, max: 180, step: 5, unit: 'px' },
                { key: 'power', label: '构图强度', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' }
            ],
            cadenza: [
                ...vectorDecorControls,
                { key: 'heroEmphasis', label: '中心强调词', type: 'toggle' },
                { key: 'breathing', label: '构图呼吸', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                ...lyricPerformanceControls,
                { key: 'motion', label: '词片运动', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'fontScale', label: '歌词字号', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'widthRatio', label: '构图宽度', type: 'range', min: 0.5, max: 0.95, step: 0.01, unit: '%' },
                { key: 'glow', label: '辉光强度', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' }
            ],
            fume: [
                { key: 'backgroundDetail', label: '几何细节（双线／轨道光点）', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'backgroundMotion', label: '背景自转与微风', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'geometricBackground', label: '几何背景', type: 'toggle' },
                { key: 'backgroundOpacity', label: '背景物体', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'cameraSpeed', label: '镜头速度', type: 'range', min: 0.55, max: 1.85, step: 0.05, unit: 'x' },
                { key: 'cameraMode', label: '镜头方式', type: 'select', options: [['smooth', '平滑'], ['stepped', '定格']] },
                { key: 'glow', label: '辉光强度', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'heroScale', label: '标题比例', type: 'range', min: 0.82, max: 1.32, step: 0.02, unit: 'x' },
                { key: 'articleSpacing', label: '长卷段落间距', type: 'range', min: 0.65, max: 1.6, step: 0.05, unit: 'x' },
                { key: 'textHoldRatio', label: '已唱文字驻留（100% 不淡出）', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'hidePrintSymbols', label: '隐藏打印标记', type: 'toggle' }
            ],
            starborn: [
                { key: 'transitionLock', label: '换场最短间隔', type: 'range', min: 0.5, max: 12, step: 0.5, unit: 's' },
                { key: 'avoidRepeat', label: '不连续用同一舞台', type: 'toggle' }
            ],
            inkdraft: [
                { key: 'cameraCuts', label: '踩词硬切（多机位分镜）', type: 'toggle' },
                { key: 'figures', label: '线稿', type: 'toggle' },
                { key: 'inkScene', label: '意象场景', type: 'select', options: [['auto', '自动（每首歌一套）'], ['notebook', '演算纸'], ['rail', '铁道'], ['sea', '海'], ['night', '星夜'], ['city', '城市'], ['flora', '植物'], ['letters', '信笺'], ['weather', '天气'], ['score', '乐谱']] },
                { key: 'collisions', label: '墨团对撞', type: 'toggle' },
                { key: 'keywords', label: '关键词套色（反复出现的意象词用强调色）', type: 'toggle' },
                { key: 'halftone', label: '半调网点', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'cloud', label: '墨云浓度', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'grain', label: '砂纸颗粒', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'fontScale', label: '歌词字号', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'waitingOpacity', label: '未唱文字可见度', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'inkFlip', label: '画面反相（纸墨对调）', type: 'toggle' },
                { key: 'negativeShots', label: '反相镜头（偶尔一镜纸墨对调）', type: 'toggle' },
                { key: 'showTranslation', label: '翻译／罗马音', type: 'toggle' },
                { key: 'audioReactivity', label: '音频响应', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' }
            ],
            fogpane: [
                { key: 'fog', label: '雾气浓度', type: 'range', min: 0.5, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'view', label: '窗外的景', type: 'select', options: [['alternate', '间奏时换景（街景／水族馆）'], ['street', '雨夜街景'], ['aquarium', '水族馆']] },
                { key: 'rain', label: '窗外的天气', type: 'select', options: [['off', '晴'], ['light', '小雨'], ['heavy', '大雨'], ['snow', '下雪（窗上结霜）']] },
                { key: 'drops', label: '玻璃上的水珠', type: 'toggle' },
                { key: 'drips', label: '往下淌的水痕', type: 'toggle' },
                { key: 'fireflies', label: '窗外萤火', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'cameraSpeed', label: '车速', type: 'range', min: 0.55, max: 1.85, step: 0.05, unit: 'x' },
                { key: 'fontScale', label: '歌词字号', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'grain', label: '颗粒', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'showTranslation', label: '翻译／罗马音', type: 'toggle' }
            ],
            impression: [
                { key: 'timeOfDay', label: '每段换一个时辰的光', type: 'toggle' },
                { key: 'flecks', label: '画上的光斑', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'frame', label: '画框', type: 'toggle' },
                { key: 'lamp', label: '画灯', type: 'range', min: 0, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'fontScale', label: '歌词字号', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'grain', label: '颗粒', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'showTranslation', label: '翻译／罗马音', type: 'toggle' },
                { key: 'audioReactivity', label: '音频响应', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' }
            ],
            groupchat: [
                { key: 'echoes', label: '副歌大家一起唱', type: 'toggle' },
                { key: 'voiceNotes', label: '间奏发语音', type: 'toggle' },
                { key: 'reactions', label: '点赞和已读', type: 'toggle' },
                { key: 'fontScale', label: '歌词字号', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'showTranslation', label: '翻译／罗马音', type: 'toggle' },
                { key: 'audioReactivity', label: '音频响应', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' }
            ],
            signal: [
                { key: 'panel', label: '监视窗', type: 'select', options: [['lyrics', '歌词'], ['history', '电平记录'], ['off', '不显示']] },
                { key: 'showSpectrum', label: '频谱条', type: 'toggle' },
                { key: 'pulseRate', label: '脉冲', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'fontScale', label: '歌词字号', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'grain', label: '颗粒', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'showTranslation', label: '翻译／罗马音', type: 'toggle' },
                { key: 'audioReactivity', label: '音频响应', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' }
            ],
            orbit: [
                { key: 'tilt', label: '轨道倾斜（扁到圆）', type: 'range', min: 0.15, max: 0.6, step: 0.01, unit: 'x' },
                { key: 'roll', label: '轨道侧转', type: 'range', min: -30, max: 30, step: 1, unit: '°' },
                { key: 'axisLine', label: '轴线', type: 'toggle' },
                { key: 'nebula', label: '星尘星云', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'fontScale', label: '歌词字号', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'waitingOpacity', label: '未唱文字可见度', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'grain', label: '颗粒', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'showTranslation', label: '翻译／罗马音', type: 'toggle' },
                { key: 'audioReactivity', label: '音频响应', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' }
            ],
            clockwork: [
                { key: 'secondHand', label: '秒针', type: 'toggle' },
                { key: 'wireframe', label: '蓝图线稿层', type: 'toggle' },
                { key: 'perspective', label: '表盘透视（随歌换角度）', type: 'toggle' },
                { key: 'parallax', label: '分层视差', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'smoke', label: '背景烟纹', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'fontScale', label: '歌词字号', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'waitingOpacity', label: '其他句可见度', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'grain', label: '颗粒', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'showTranslation', label: '翻译／罗马音', type: 'toggle' },
                { key: 'audioReactivity', label: '音频响应', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' }
            ],
            hanabi: [
                { key: 'density', label: '烟花密度', type: 'range', min: 0.4, max: 1.6, step: 0.05, unit: 'x' },
                { key: 'trails', label: '尾迹长度', type: 'range', min: 0, max: 1.6, step: 0.05, unit: 'x' },
                { key: 'smoke', label: '火药烟', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'bloom', label: '副歌泛光', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'collage', label: '副歌拼贴（重复的句子拆成大小不一的词块）', type: 'toggle' },
                { key: 'reflection', label: '河面倒影（节能档关闭）', type: 'toggle' },
                { key: 'fontScale', label: '歌词字号', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'waitingOpacity', label: '未唱文字可见度', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'grain', label: '颗粒', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'showTranslation', label: '翻译／罗马音', type: 'toggle' },
                { key: 'audioReactivity', label: '音频响应', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' }
            ],
            lumiere: [
                { key: 'smoke', label: '舞台烟雾', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'dust', label: '光里的浮尘', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'flare', label: '光源眩光', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'bokeh', label: '前景散景', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'fontScale', label: '歌词字号', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'waitingOpacity', label: '未唱文字可见度', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'grain', label: '颗粒', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'showTranslation', label: '翻译／罗马音', type: 'toggle' },
                { key: 'audioReactivity', label: '音频响应', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' }
            ],
            kowloon: [
                { key: 'cameraMode', label: '镜头（可拖拽看景，双击回正）', type: 'select', options: [['sandbox', '沙盒截面'], ['auto', '分镜运镜'], ['diorama', '斜俯视全景']] },
                { key: 'rain', label: '雨（节能档减量）', type: 'select', options: [['off', '关'], ['light', '小雨'], ['heavy', '大雨']] },
                { key: 'lightning', label: '副歌闪电', type: 'toggle' },
                { key: 'reflections', label: '积水倒影（节能档关闭）', type: 'toggle' },
                { key: 'fog', label: '雾气浓度', type: 'range', min: 0.5, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'showTranslation', label: '翻译／罗马音', type: 'toggle' },
                { key: 'postProcess', label: '光学后期（节能档关闭）', type: 'toggle' },
                { key: 'glow', label: '霓虹辉光', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'grain', label: '胶片颗粒', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'vignette', label: '镜头暗角', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'audioReactivity', label: '音频响应', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' }
            ],
            tunnel: [
                { key: 'cameraSpeed', label: '穿行速度', type: 'range', min: 0.55, max: 1.85, step: 0.05, unit: 'x' },
                { key: 'motionAmount', label: '空间运动', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'pauseDuration', label: '句尾停驻（唱完后停留）', type: 'range', min: 0, max: 3, step: 0.05, unit: 's' },
                { key: 'cameraBreath', label: '镜头呼吸', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'cameraShake', label: '镜头晃动', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'objectDensity', label: '物体密度', type: 'range', min: 0.25, max: 2, step: 0.05, unit: 'x' },
                { key: 'starfield', label: '星场', type: 'toggle' },
                { key: 'showPlanets', label: '星球', type: 'toggle' },
                { key: 'showRings', label: '星环', type: 'toggle' },
                { key: 'showShips', label: '飞船', type: 'toggle' },
                { key: 'showStations', label: '空间站', type: 'toggle' },
                { key: 'dissolveAmount', label: '点阵消散', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
                { key: 'textHoldRatio', label: '已唱歌词驻留', type: 'range', min: 0, max: 0.8, step: 0.05, unit: '%' },
                { key: 'fontScale', label: '歌词字号', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'lyricFont', label: '歌词字体', type: 'select', options: [['sans', '黑体'], ['serif', '宋体（明朝）'], ['kai', '楷体']] },
                { key: 'showTranslation', label: '翻译／罗马音', type: 'toggle' },
                { key: 'glow', label: '点阵辉光', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'audioReactivity', label: '音频响应', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'lyricHop', label: '字随拍跳（正在唱的字随鼓点轻跳，0 关闭）', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'coverTint', label: '星云随封面（封面的主色染进星云，0 关闭）', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' }
            ]
        });
        const state = {
            active: false,
            modeId: localStorage.getItem('musicStageMode') || 'luminous',
            modeInstance: null,
            // Soft-focus switch: the old mode keeps performing until the new
            // one has drawn, then one blurs away as the other settles in.
            leaving: null,
            arriving: null,
            // Song handover: what the current mode is performing; see songHandover.
            handover: null,
            committedSong: null,
            committedIdentity: null,
            committedInstance: null,
            generation: 0,
            trackPath: null,
            trackSignature: '',
            coverUrl: '',
            backgroundTimer: null,
            lastFrame: null,
            draggingProgress: false,
            seekHold: null,
            lastTransportSignature: '',
            lastProgressWidth: '',
            lastCurrentTimeText: '',
            lastDurationText: '',
            lastProgressAriaValue: '',
            lastProgressAriaText: '',
            lastPlaybackState: null,
            lastNonZeroVolume: Math.max(0.35, Number(app.volumeSlider?.value) || 1),
            themeCatalog: [],
            appliedThemeVariables: new Set(),
            destroyed: false,
            config: Config.get(),
            settingsOpen: false,
            stats: {
                modeCreates: 0,
                modeDestroys: 0,
                frameUpdates: 0,
                modeSwitches: 0
            }
        };
        // 边框频谱在 music-stage-edge.js
        const edge = global.MusicStageEdge.create({ app, root, elements, state, scope, clamp });

        // A mode on its way out of a soft-focus switch; see setMode.
        const dropLeaving = () => {
            const leaving = state.leaving;
            if (!leaving) return;
            state.leaving = null;
            leaving.instance.destroy();
            state.stats.modeDestroys += 1;
        };

        const destroyMode = () => {
            dropLeaving();
            state.arriving = null;
            if (!state.modeInstance) return;
            state.modeInstance.destroy();
            state.modeInstance = null;
            state.stats.modeDestroys += 1;
        };

        const createMode = (modeId, { keepCurrent = false } = {}) => {
            if (!keepCurrent) destroyMode();
            elements.modeRoot.classList.remove('is-switching');
            state.generation += 1;
            state.modeId = Modes.get(modeId).id;
            state.modeInstance = Modes.create(state.modeId, elements.modeRoot, {
                app,
                config: state.config,
                generation: state.generation,
                isCurrentGeneration: (generation) => generation === state.generation && !state.destroyed
            });
            state.stats.modeCreates += 1;
            localStorage.setItem('musicStageMode', state.modeId);
            // The 3D modes paint every pixel themselves; see .stage-scene-3d.
            const traits = modeTraits(state.modeId);
            const scene3d = traits.scene3d;
            state.scene3d = scene3d;
            root.classList.toggle('stage-scene-3d', scene3d);
            // 自己铺满整张纸的舞台：底下的模糊封面画了也看不见。
            root.classList.toggle('stage-opaque', scene3d || traits.opaque);
            // 雾笺、绘光的画面在浅色主题下也是夜色，左上角字标要换成浅色才看得见。
            root.classList.toggle('stage-night', traits.night);
            document.body.classList.toggle('music-stage-scene-3d', scene3d);

            elements.modeSwitcher.querySelectorAll('[data-stage-mode]').forEach((button) => {
                const selected = button.dataset.stageMode === state.modeId;
                button.classList.toggle('is-active', selected);
                button.setAttribute(button.getAttribute('role') === 'menuitemradio' ? 'aria-checked' : 'aria-pressed', String(selected));
            });
            syncModePickerLabel();
            revealActiveMode();

            if (state.active) {
                state.lastFrame = Runtime.createFrame(app, performance.now());
                state.modeInstance.updateFrame(state.lastFrame);
            }
        };

        // 舞台切换：角落里一个按钮写着当前舞台，点开竖着弹出全部舞台（行高 28，和主程序设置页的下拉同一套）。
        // 键盘：上下键 / Home / End 移动，回车或空格选中，Esc 或点外面收起；列表放不下时自己滚动。
        const picker = { built: false, open: false, toggle: null, label: null, menu: null };
        const isPicker = () => elements.modeSwitcher?.classList.contains('music-stage-mode-picker');
        const modeMenu = () => (picker.built ? picker.menu : elements.modeSwitcher);
        const modeOptions = () => Array.from(modeMenu()?.querySelectorAll('[data-stage-mode]') || []);
        const buildModePicker = () => {
            if (picker.built || !isPicker()) return;
            const host = elements.modeSwitcher;
            picker.toggle = createElement('button', 'music-stage-mode-picker-toggle', {
                type: 'button',
                'aria-haspopup': 'menu',
                'aria-expanded': 'false',
                title: '切换舞台'
            });
            picker.label = createElement('span', 'music-stage-mode-picker-label');
            const chevron = createElement('span', 'music-stage-mode-picker-chevron', {
                'aria-hidden': 'true',
                html: '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            });
            picker.toggle.append(picker.label, chevron);
            picker.menu = createElement('div', 'music-stage-mode-menu', { role: 'menu', 'aria-label': '歌词演出模式', tabindex: '-1' });
            picker.menu.hidden = true;
            host.replaceChildren(picker.toggle, picker.menu);
            picker.built = true;
        };
        const syncModePickerLabel = () => {
            if (!picker.built) return;
            const entry = Modes.entries.find((item) => item.id === state.modeId);
            picker.label.textContent = entry?.label || '';
            picker.toggle.title = entry ? `舞台：${entry.label}（点开切换）` : '切换舞台';
        };
        const focusModeOption = (index) => {
            const options = modeOptions();
            if (!options.length) return;
            const target = options[(index + options.length) % options.length];
            target.focus({ preventScroll: true });
            target.scrollIntoView?.({ block: 'nearest' });
        };
        const setModePickerOpen = (open, { focus = 'menu' } = {}) => {
            if (!picker.built || picker.open === open) return;
            picker.open = open;
            picker.menu.hidden = !open;
            picker.toggle.setAttribute('aria-expanded', String(open));
            elements.modeSwitcher.classList.toggle('is-open', open);
            if (open) {
                const options = modeOptions();
                const current = Math.max(0, options.findIndex((option) => option.dataset.stageMode === state.modeId));
                if (focus === 'menu') focusModeOption(current);
                else options[current]?.scrollIntoView?.({ block: 'nearest' });
            } else if (focus === 'toggle') {
                picker.toggle.focus({ preventScroll: true });
            }
        };

        // 旧的横排页签在窄窗口里会横向滚动：把选中的那个留在可见范围里。竖向菜单打开时由 setModePickerOpen 负责。
        const revealActiveMode = () => {
            if (picker.built) return;
            const bar = elements.modeSwitcher;
            const button = bar?.querySelector('.music-stage-mode-button.is-active');
            if (!button || bar.scrollWidth <= bar.clientWidth + 1) return;
            const start = button.offsetLeft - 8;
            const end = button.offsetLeft + button.offsetWidth + 8;
            if (start < bar.scrollLeft) bar.scrollLeft = start;
            else if (end > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = end - bar.clientWidth;
        };

        const renderModeButtons = () => {
            buildModePicker();
            const fragment = document.createDocumentFragment();
            const visibleIds = state.config.enabledModes.includes(state.modeId)
                ? state.config.enabledModes
                : [state.modeId, ...state.config.enabledModes];
            Modes.entries.filter((entry) => visibleIds.includes(entry.id)).forEach((entry) => {
                const selected = entry.id === state.modeId;
                const button = picker.built
                    ? createElement('button', 'music-stage-mode-menu-item', {
                        type: 'button',
                        role: 'menuitemradio',
                        tabindex: '-1',
                        'data-stage-mode': entry.id,
                        'aria-checked': String(selected)
                    })
                    : createElement('button', 'music-stage-mode-button', {
                        type: 'button',
                        text: entry.label,
                        title: `切换至${entry.label}`,
                        'data-stage-mode': entry.id,
                        'aria-pressed': String(selected)
                    });
                if (picker.built) {
                    button.append(
                        createElement('span', 'music-stage-mode-menu-item-label', entry.label),
                        createElement('span', 'music-stage-mode-menu-item-check', {
                            'aria-hidden': 'true',
                            html: '<svg viewBox="0 0 14 14" width="13" height="13"><path d="M3 7.2 5.8 10 11 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
                        })
                    );
                }
                button.classList.toggle('is-active', selected);
                fragment.appendChild(button);
            });
            modeMenu().replaceChildren(fragment);
            syncModePickerLabel();
            revealActiveMode();
        };

        const formatTuningValue = (definition, value) => {
            if (definition.type === 'toggle') return value ? '开' : '关';
            if (definition.type === 'select') return definition.options.find(([key]) => key === value)?.[1] || String(value || '');
            if (definition.unit === '%') return `${Math.round(Number(value) * 100)}%`;
            return `${Number(value).toFixed(definition.step < 0.1 ? 2 : 1)}${definition.unit || ''}`;
        };

        const applyStageTheme = () => {
            const config = state.config;
            const useCustom = config.themeMode === 'custom';
            const selectedTheme = state.themeCatalog.find(theme => theme.fileName === config.themeFile);
            const variables = useCustom
                ? (selectedTheme?.variables?.[config.themeVariant] || {})
                : {};

            state.appliedThemeVariables.forEach(name => root.style.removeProperty(name));
            state.appliedThemeVariables.clear();
            root.classList.toggle('stage-theme-custom', useCustom);
            root.classList.toggle('stage-theme-light', useCustom && config.themeVariant === 'light');
            root.classList.toggle('stage-theme-dark', useCustom && config.themeVariant !== 'light');

            if (useCustom && selectedTheme) {
                const styleTarget = root;
                Object.entries(variables).forEach(([name, value]) => {
                    styleTarget.style.setProperty(name, resolveThemeAssetValue(value));
                    state.appliedThemeVariables.add(name);
                });
                // These are declared on body in the normal theme stylesheet. Rebind
                // them on the stage so the descendant stage tokens resolve against
                // the selected custom palette rather than the page palette.
                [
                    ['--stage-bg', '--primary-bg'],
                    ['--stage-surface', '--secondary-bg'],
                    ['--stage-ink', '--primary-text'],
                    ['--stage-muted', '--secondary-text'],
                    ['--stage-accent', '--highlight-text'],
                    ['--stage-on-accent', '--text-on-accent'],
                    ['--stage-border', '--border-color'],
                    ['--stage-glass', '--panel-bg'],
                    ['--stage-blend', 'normal']
                ].forEach(([target, source]) => {
                    styleTarget.style.setProperty(target, source === 'normal' ? source : `var(${source})`);
                    state.appliedThemeVariables.add(target);
                });
                styleTarget.style.setProperty(
                    '--stage-wallpaper',
                    variables[`--chat-wallpaper-${config.themeVariant}`]
                        ? resolveThemeAssetValue(variables[`--chat-wallpaper-${config.themeVariant}`])
                        : 'none'
                );
                state.appliedThemeVariables.add('--stage-wallpaper');
                styleTarget.style.setProperty('color-scheme', config.themeVariant === 'light' ? 'light' : 'dark');
                state.appliedThemeVariables.add('color-scheme');
            }

            updateTheme();
        };

        const loadThemeCatalog = async () => {
            if (!app.api?.getThemes) return;
            try {
                const themes = await app.api.getThemes();
                state.themeCatalog = Array.isArray(themes) ? themes : [];
                if (
                    state.config.themeMode === 'custom'
                    && !state.themeCatalog.some(theme => theme.fileName === state.config.themeFile)
                ) {
                    state.config = Config.update({ themeMode: 'global', themeFile: '' });
                }
                renderSettingsControls();
                applyStageTheme();
            } catch (error) {
                console.warn('[MusicStage] Failed to load theme catalog:', error);
            }
        };

        const renderSettingsControls = () => {
            if (!elements.modeOptions || !elements.tuningControls || !elements.commonControls) return;
            const config = state.config;
            const modeFragment = document.createDocumentFragment();
            Modes.entries.forEach((entry) => {
                const label = createElement('label', 'music-stage-mode-menu-item', {
                    title: entry.description ? `${entry.label} · ${entry.description}` : entry.label
                });
                const checkbox = createElement('input', '', {
                    type: 'checkbox',
                    'aria-label': `在顶部切换器中显示${entry.label}`
                });
                checkbox.checked = config.enabledModes.includes(entry.id);
                checkbox.disabled = config.enabledModes.length === 1 && checkbox.checked;
                checkbox.dataset.stageConfigMode = entry.id;
                const text = createElement('span', 'music-stage-mode-option-copy');
                text.textContent = entry.label;
                label.append(checkbox, text);
                modeFragment.appendChild(label);
            });
            elements.modeOptions.replaceChildren(modeFragment);

            const modeMeta = Config.modes.find((entry) => entry.id === state.modeId);
            if (elements.settingsHint) elements.settingsHint.textContent = modeMeta?.description || '';
            const tuningFragment = document.createDocumentFragment();
            // Settings that only act under one choice of another setting (the
            // editorial-track knobs, say) are hidden while that choice is off,
            // so no slider in the list moves without changing anything.
            const tuningDependents = [];
            const syncTuningDependents = () => {
                const current = state.config.modes?.[state.modeId] || {};
                tuningDependents.forEach(({ row, when: [key, values] }) => {
                    row.hidden = !values.includes(current[key]);
                });
            };
            (tuningDefinitions[state.modeId] || []).forEach((definition) => {
                const value = config.modes[state.modeId]?.[definition.key];
                const row = createElement('label', 'music-stage-tuning-row');
                const header = createElement('span', 'music-stage-tuning-label');
                const valueText = createElement('span', 'music-stage-tuning-value');
                header.textContent = definition.label;
                valueText.textContent = formatTuningValue(definition, value);
                const control = definition.type === 'toggle'
                    ? createElement('input', '', {
                        type: 'checkbox',
                        'aria-label': definition.label
                    })
                    : definition.type === 'select'
                        ? createElement('select', '', {
                            'aria-label': definition.label
                        })
                        : createElement('input', '', {
                            type: 'range',
                            min: definition.min,
                            max: definition.max,
                            step: definition.step,
                            value,
                            'aria-label': definition.label
                        });
                if (definition.type === 'toggle') control.checked = Boolean(value);
                if (definition.type === 'select') {
                    definition.options.forEach(([optionValue, optionLabel]) => {
                        const option = createElement('option', '', { value: optionValue, text: optionLabel });
                        control.appendChild(option);
                    });
                    control.value = value;
                }
                control.dataset.stageConfigKey = definition.key;
                control.dataset.stageConfigType = definition.type;
                if (definition.onlyWhen) tuningDependents.push({ row, when: definition.onlyWhen });
                const handleControlChange = () => {
                    const next = definition.type === 'toggle'
                        ? control.checked
                        : definition.type === 'range'
                            ? Number(control.value)
                            : control.value;
                    valueText.textContent = formatTuningValue(definition, next);
                    editingSettings = true;
                    try { Config.setModePatch(state.modeId, { [definition.key]: next }); }
                    finally { editingSettings = false; }
                    syncTuningDependents();
                };
                control.addEventListener('input', handleControlChange);
                control.addEventListener('change', handleControlChange);
                row.append(header, valueText, control);
                tuningFragment.appendChild(row);
            });
            elements.tuningControls.replaceChildren(tuningFragment);
            syncTuningDependents();

            const commonFragment = document.createDocumentFragment();
            const edgeRow = createElement('label', 'music-stage-tuning-row');
            const edgeLabel = createElement('span', 'music-stage-tuning-label', '边缘频谱');
            const edgeToggle = createElement('input', '', {
                type: 'checkbox',
                'aria-label': '边缘频谱'
            });
            edgeToggle.checked = config.edgeSpectrum !== false;
            edgeToggle.addEventListener('change', () => Config.update({ edgeSpectrum: edgeToggle.checked }));
            edgeRow.append(edgeLabel, edgeToggle);
            commonFragment.appendChild(edgeRow);

            const quality = createElement('select', 'music-stage-common-select', {
                'aria-label': '性能档位'
            });
            [['energy-saving', '节能'], ['standard', '标准'], ['ultimate', '极致']].forEach(([value, label]) => {
                quality.appendChild(createElement('option', '', { value, text: label }));
            });
            quality.value = config.quality;
            quality.addEventListener('change', () => Config.update({ quality: quality.value }));
            const qualityRow = createElement('label', 'music-stage-tuning-row');
            qualityRow.append(createElement('span', 'music-stage-tuning-label', '性能档位'), quality);
            const intensity = createElement('input', 'music-stage-common-range', {
                type: 'range',
                min: 0,
                max: 2,
                step: 0.05,
                value: config.animationIntensity,
                'aria-label': '动画总强度'
            });
            const intensityValue = createElement('span', 'music-stage-tuning-value', `${config.animationIntensity.toFixed(2)}x`);
            intensity.addEventListener('input', () => {
                const next = Number(intensity.value);
                intensityValue.textContent = `${next.toFixed(2)}x`;
                editingSettings = true;
                try { Config.update({ animationIntensity: next }); }
                finally { editingSettings = false; }
            });
            const intensityRow = createElement('label', 'music-stage-tuning-row');
            intensityRow.append(createElement('span', 'music-stage-tuning-label', '动画总强度'), intensityValue, intensity);
            // Says when the 3D stage has had to draw below the chosen tier.
            const degradeNote = createElement('p', 'music-stage-degrade-note');
            degradeNote.hidden = true;
            degradeNote.setAttribute('aria-live', 'polite');
            elements.degradeNote = degradeNote;
            state.lastDegradeNote = null;
            commonFragment.append(qualityRow, degradeNote, intensityRow);

            const themeSelect = createElement('select', 'music-stage-common-select', {
                'aria-label': '舞台主题'
            });
            themeSelect.appendChild(createElement('option', '', {
                value: 'global',
                text: '跟随全局主题'
            }));
            state.themeCatalog.forEach((theme) => {
                const name = theme.name || theme.fileName.replace(/^themes/, '').replace(/\.css$/i, '');
                if (theme.variables?.light && Object.keys(theme.variables.light).length) {
                    themeSelect.appendChild(createElement('option', '', {
                        value: `custom:${theme.fileName}:light`,
                        text: `${name} 明`
                    }));
                }
                if (theme.variables?.dark && Object.keys(theme.variables.dark).length) {
                    themeSelect.appendChild(createElement('option', '', {
                        value: `custom:${theme.fileName}:dark`,
                        text: `${name} 暗`
                    }));
                }
            });
            themeSelect.value = state.config.themeMode === 'custom'
                ? `custom:${state.config.themeFile}:${state.config.themeVariant}`
                : 'global';
            if (![...themeSelect.options].some(option => option.value === themeSelect.value)) {
                themeSelect.value = 'global';
            }
            themeSelect.addEventListener('change', () => {
                const [kind, fileName, variant] = themeSelect.value.split(':');
                editingSettings = true;
                try {
                    Config.update(kind === 'custom'
                        ? { themeMode: 'custom', themeFile: fileName, themeVariant: variant }
                        : { themeMode: 'global', themeFile: '' });
                } finally {
                    editingSettings = false;
                }
            });
            const themeRow = createElement('label', 'music-stage-tuning-row');
            themeRow.append(
                createElement('span', 'music-stage-tuning-label', '舞台主题'),
                themeSelect
            );
            commonFragment.appendChild(themeRow);

            elements.commonControls.replaceChildren(commonFragment);
        };

        /*
         * The ambience behind the 2D modes is a heavily blurred picture. As a
         * CSS filter that blur ran over the whole window on every frame; a
         * blurred picture has no detail, so it is blurred once into a small
         * canvas and stretched instead. Where a canvas cannot be had the
         * layer keeps its picture and its filter.
         */
        const SOFT_SIZE = 160;
        const softCanvas = (host, className) => {
            const canvas = document.createElement('canvas');
            const context = canvas.getContext?.('2d');
            if (!host || !context || !('filter' in context)) return null;
            canvas.className = className;
            host.prepend(canvas);
            return { host, canvas, context };
        };
        const paintSoft = (soft, image, blur, saturate) => {
            const { context, host } = soft;
            const { canvas } = soft;
            if (!image) {
                context.clearRect(0, 0, canvas.width, canvas.height);
                host.classList.remove('is-soft');
                return;
            }
            // The picture's own shape, so stretching it crops as the layer did.
            const fit = SOFT_SIZE / Math.max(image.naturalWidth, image.naturalHeight);
            canvas.width = Math.max(8, Math.round(image.naturalWidth * fit));
            canvas.height = Math.max(8, Math.round(image.naturalHeight * fit));
            // The blur radius the layer would have had, at the canvas's scale.
            const stretch = Math.max(root.clientWidth / canvas.width, root.clientHeight / canvas.height, 1);
            const radius = blur / stretch;
            // Drawn a little past the edges so the blur has something to average there.
            const margin = radius * 2;
            context.filter = `blur(${radius.toFixed(2)}px) saturate(${saturate})`;
            context.drawImage(image, -margin, -margin, canvas.width + margin * 2, canvas.height + margin * 2);
            context.filter = 'none';
            host.classList.add('is-soft');
        };
        const loadImage = (url) => new Promise((resolve) => {
            const image = new Image();
            image.decoding = 'async';
            image.onload = () => resolve(image.naturalWidth ? image : null);
            image.onerror = () => resolve(null);
            image.src = url;
        });
        const softCurrent = softCanvas(elements.backdropCurrent, 'music-stage-backdrop-soft');
        const softNext = softCanvas(elements.backdropNext, 'music-stage-backdrop-soft');
        const softWallpaper = softCanvas(elements.backdropCurrent?.parentElement,
            'music-stage-backdrop-soft music-stage-backdrop-wallpaper');
        elements.backdropCurrent?.classList.add('is-empty');
        elements.backdropNext?.classList.add('is-empty');

        const updateWallpaper = async () => {
            if (!softWallpaper) return;
            const value = getComputedStyle(root).getPropertyValue('--stage-wallpaper').trim();
            if (value === state.wallpaperValue) return;
            state.wallpaperValue = value;
            // Only a single picture can be drawn; gradients stay with the stylesheet.
            const match = /^url\((['"]?)(.+?)\1\)$/.exec(value);
            const image = match ? await loadImage(match[2]) : null;
            if (state.destroyed || state.wallpaperValue !== value) return;
            paintSoft(softWallpaper, image, 36, 0.85);
        };

        const updateBackdrop = (coverUrl) => {
            const nextUrl = coverUrl || '';
            if (nextUrl === state.coverUrl) return;
            state.coverUrl = nextUrl;
            const cssImage = nextUrl ? `url("${nextUrl.replace(/"/g, '\\"')}")` : 'none';

            if (state.backgroundTimer) {
                clearTimeout(state.backgroundTimer);
                state.backgroundTimer = null;
            }

            const show = (image) => {
                // The 3D stages may take the cover's colour into their sky.
                app.stageCoverColour = image ? global.MusicStageModeUtils?.coverColour?.(image) ?? null : null;
                if (reducedMotion()) {
                    if (softNext && softCurrent) paintSoft(softCurrent, image, 46, 1.45);
                    elements.backdropCurrent.classList.toggle('is-empty', !nextUrl);
                    elements.backdropCurrent.style.backgroundImage = cssImage;
                    root.classList.remove('is-changing-cover');
                    return;
                }
                if (softNext && softCurrent) paintSoft(softNext, image, 46, 1.45);
                // A layer with no picture is still a blurred layer to the compositor.
                elements.backdropNext.classList.toggle('is-empty', !nextUrl);
                elements.backdropNext.style.backgroundImage = cssImage;
                root.classList.add('is-changing-cover');
                state.backgroundTimer = setTimeout(() => {
                    if (softNext && softCurrent) paintSoft(softCurrent, image, 46, 1.45);
                    elements.backdropCurrent.classList.toggle('is-empty', !nextUrl);
                    elements.backdropCurrent.style.backgroundImage = cssImage;
                    root.classList.remove('is-changing-cover');
                    state.backgroundTimer = null;
                }, 850);
            };
            if (!nextUrl) { show(null); return; }
            if (!softNext || !softCurrent) {
                show(null);
                loadImage(nextUrl).then((image) => {
                    if (!state.destroyed && state.coverUrl === nextUrl) app.stageCoverColour = global.MusicStageModeUtils?.coverColour?.(image) ?? null;
                });
                return;
            }
            loadImage(nextUrl).then((image) => {
                if (!state.destroyed && state.coverUrl === nextUrl) show(image);
            });
        };

        let lastTrackObj = undefined;
        let lastTrackPath = null;
        let lastTrackTitle = null;
        let lastTrackArtist = null;
        let lastTrackAlbum = null;
        let lastTrackArt = null;
        let lastTrackTheme = null;
        const updateTrack = (track) => {
            const theme = app.currentTheme;
            if (
                state.trackSignature
                && track === lastTrackObj
                && theme === lastTrackTheme
                && (track?.path ?? null) === lastTrackPath
                && (track?.title ?? null) === lastTrackTitle
                && (track?.artist ?? null) === lastTrackArtist
                && (track?.album ?? null) === lastTrackAlbum
                && (track?.albumArt ?? null) === lastTrackArt
            ) return;
            lastTrackObj = track;
            lastTrackPath = track?.path ?? null;
            lastTrackTitle = track?.title ?? null;
            lastTrackArtist = track?.artist ?? null;
            lastTrackAlbum = track?.album ?? null;
            lastTrackArt = track?.albumArt ?? null;
            lastTrackTheme = theme;

            const title = app.stripAudioExtension?.(track?.title) || track?.title || '未选择歌曲';
            const artist = track?.artist || '未知艺术家';
            const album = track?.album || '';
            const coverUrl = fileUrl(track?.albumArt);
            const identity = track?.path || `${title}\u0001${artist}`;
            const signature = `${identity}\u0001${title}\u0001${artist}\u0001${album}\u0001${coverUrl}\u0001${theme}`;
            if (signature === state.trackSignature) return;
            state.trackSignature = signature;

            if (identity !== state.trackPath) {
                state.trackPath = identity;
                elements.title.classList.remove('is-changing');
                if (!reducedMotion()) {
                    void elements.title.offsetWidth;
                    elements.title.classList.add('is-changing');
                }
            }

            elements.title.textContent = title;
            elements.artist.textContent = artist;
            elements.album.textContent = album;
            elements.album.hidden = !album;
            elements.cover.setAttribute('aria-label', `${title} 的封面`);
            elements.cover.style.backgroundImage = coverUrl
                ? `url("${coverUrl.replace(/"/g, '\\"')}")`
                : `url("../assets/${app.currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}")`;
            updateBackdrop(coverUrl);
            elements.emptyNotice.hidden = Boolean(track);
        };

        const updateProgress = (frame) => {
            const percent = frame.duration > 0 ? clamp(frame.playbackTime / frame.duration) * 100 : 0;
            const width = `${percent.toFixed(3)}%`;
            if (width !== state.lastProgressWidth) {
                state.lastProgressWidth = width;
                elements.progressFill.style.width = width;
                if (elements.progressGlow) elements.progressGlow.style.width = width;
            }

            const currentTimeText = app.formatTime?.(frame.playbackTime) || '0:00';
            if (currentTimeText !== state.lastCurrentTimeText) {
                state.lastCurrentTimeText = currentTimeText;
                elements.currentTime.textContent = currentTimeText;
            }
            const durationText = app.formatTime?.(frame.duration) || '0:00';
            if (durationText !== state.lastDurationText) {
                state.lastDurationText = durationText;
                elements.duration.textContent = durationText;
            }

            const ariaValue = String(Math.round(percent));
            if (ariaValue !== state.lastProgressAriaValue) {
                state.lastProgressAriaValue = ariaValue;
                elements.progressTrack.setAttribute('aria-valuenow', ariaValue);
            }
            const ariaText = `${currentTimeText} / ${durationText}`;
            if (ariaText !== state.lastProgressAriaText) {
                state.lastProgressAriaText = ariaText;
                elements.progressTrack.setAttribute('aria-valuetext', ariaText);
            }
        };

        const updatePlaybackState = (isPlaying) => {
            if (isPlaying === state.lastPlaybackState) return;
            state.lastPlaybackState = isPlaying;
            root.classList.toggle('is-playing', isPlaying);
            elements.play.classList.toggle('is-playing', isPlaying);
            elements.play.setAttribute('aria-label', isPlaying ? '暂停' : '播放');
            elements.play.title = isPlaying ? '暂停' : '播放';
        };


        const getPlayModePresentation = () => {
            const mode = app.playModes[app.currentPlayMode] || 'repeat';
            if (mode === 'repeat-one') return { mode, label: '单曲循环', icon: icons.repeatOne };
            if (mode === 'shuffle') return { mode, label: '随机播放', icon: icons.shuffle };
            return { mode, label: '列表循环', icon: icons.repeat };
        };

        const updateTransportControls = () => {
            const volume = clamp(Number(app.volumeSlider?.value) || 0);
            const presentation = getPlayModePresentation();
            const signature = `${presentation.mode}:${volume.toFixed(3)}`;
            if (signature === state.lastTransportSignature) return;
            state.lastTransportSignature = signature;

            elements.playMode.innerHTML = presentation.icon;
            elements.playMode.title = presentation.label;
            elements.playMode.setAttribute('aria-label', presentation.label);
            elements.playMode.dataset.playMode = presentation.mode;
            elements.playMode.classList.toggle('is-active', presentation.mode !== 'repeat');

            elements.volumeSlider.value = String(volume);
            elements.volumeSlider.style.setProperty('--stage-volume', `${(volume * 100).toFixed(1)}%`);
            elements.volumeButton.classList.toggle('is-muted', volume <= 0.001);
            elements.volumeButton.title = volume <= 0.001 ? '恢复音量' : '静音';
            elements.volumeButton.setAttribute('aria-label', volume <= 0.001 ? '恢复音量' : '静音');
            if (volume > 0.001) state.lastNonZeroVolume = volume;
        };

        const setVolume = (value) => {
            const volume = clamp(Number(value) || 0);
            if (app.volumeSlider) {
                app.volumeSlider.value = String(volume);
                app.updateVolumeSliderBackground?.(volume);
            }
            app.api?.setMusicVolume?.(volume);
            if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
            app.saveSettings?.();
            state.lastTransportSignature = '';
            updateTransportControls();
        };

        // Which song (and which lyrics) the current mode is performing. The
        // player empties the lyrics when a song changes and fills them in a
        // moment later, from cache or a search. A 3D mode that followed along
        // directly would build its whole journey for a song without words,
        // then again once the words arrive: two jumps. So the 3D modes stay
        // on the song they have until the new one is ready, fade out softly,
        // rebuild unseen and come back out of the same blur.
        const SONG_LEAVE_MS = 360;
        // Long enough for an in-world handover to have turned away from the old song.
        const SONG_TILT_MS = 900;
        const LYRICS_WAIT_MS = 2000;
        const linesIds = new WeakMap();
        let nextLinesId = 1;
        const songKey = (frame) => {
            const track = frame.track;
            const identity = track?.path || `${track?.title || ''}\u0001${track?.artist || ''}`;
            const lines = frame.lines;
            if (!lines?.length) return { identity, key: `${identity}\u0001-` };
            if (!linesIds.has(lines)) linesIds.set(lines, nextLinesId++);
            return { identity, key: `${identity}\u0001${linesIds.get(lines)}` };
        };
        // Returns whether the mode should get this frame.
        const songHandover = (frame) => {
            const instance = state.modeInstance;
            const { identity, key } = songKey(frame);
            const handover = state.handover;
            if (!instance || !modeTraits(state.modeId).scene3d || reducedMotion() || state.arriving
                || state.committedSong === null || state.committedInstance !== instance) {
                if (handover) instance?.root.classList.remove('is-song-leaving');
                state.handover = null;
                state.committedSong = key;
                state.committedIdentity = identity;
                state.committedInstance = instance;
                return true;
            }
            if (key === state.committedSong) {
                if (handover) {
                    // Went back to what is on screen (a quick skip back): show it again.
                    instance.root.classList.remove('is-song-leaving');
                    state.handover = null;
                }
                return true;
            }
            const now = performance.now();
            const newSong = identity !== state.committedIdentity;
            if (!handover || handover.newSong !== newSong) {
                // A mode that can show the way to the next song in its own world
                // does (镜台 tilts up to the sky and dissolves); the rest fade.
                const inWorld = handover?.inWorld ?? Boolean(instance.beginSongHandover?.());
                state.handover = { since: handover?.since ?? now, newSong, inWorld };
                if (!inWorld) instance.root.classList.add('is-song-leaving');
                state.stats.songHandovers = (state.stats.songHandovers || 0) + 1;
            }
            const waited = now - state.handover.since;
            // A new song waits for its words, or until it is clearly playing without them.
            const ready = !newSong || frame.lines?.length > 0 || waited >= LYRICS_WAIT_MS;
            const leaveMs = state.handover.inWorld ? SONG_TILT_MS : SONG_LEAVE_MS;
            if (waited < leaveMs || !ready) {
                if (state.handover.inWorld) instance.holdFrame?.(frame);
                return false;
            }
            state.handover = null;
            state.committedSong = key;
            state.committedIdentity = identity;
            // Rebuild on this frame while hidden, then let the picture come back.
            requestAnimationFrame(() => {
                if (state.modeInstance === instance && !state.handover) instance.root.classList.remove('is-song-leaving');
            });
            return true;
        };

        const TIER_LABELS = { 'energy-saving': '节能', standard: '标准', ultimate: '极致' };
        // Once a second (a cheap read): how far the 3D stage
        // has stepped down below the chosen tier to keep its frame rate.
        const updateDegradeNote = (now) => {
            const note = elements.degradeNote;
            if (!note || !note.isConnected || now - (state.degradeCheckedAt || 0) < 1000) return;
            state.degradeCheckedAt = now;
            const degrade = state.modeInstance?.getDegrade?.();
            const steps = degrade?.steps || 0;
            const drawn = degrade?.quality;
            const chosen = state.config.quality;
            const text = steps
                ? `画面跟不上，已自动降低 ${steps} 格${drawn && drawn !== chosen ? `（实际按「${TIER_LABELS[drawn] || drawn}」画）` : '（降低分辨率）'}`
                : '';
            if (text === state.lastDegradeNote) return;
            state.lastDegradeNote = text;
            note.textContent = text;
            note.hidden = !text;
        };

        /*
         * The audio levels change every frame. Set on the stage root they would
         * be inherited by, and restyle, every element of the stage each frame,
         * although only a handful of parts read them. They go to those parts
         * only: the backdrop, the edge spectrum (its corners and flow inherit),
         * the cover, and the two mode roots whose own decoration reads them.
         */
        const audioWritten = new WeakMap();
        const audioSinks = [];
        const collectAudioSinks = (opaque, edgeActive) => {
            audioSinks.length = 0;
            if (!opaque) root.querySelectorAll(':scope .music-stage-backdrop-layer').forEach(node => audioSinks.push(node));
            if (edgeActive && elements.edgeSpectrum) audioSinks.push(elements.edgeSpectrum);
            if (elements.cover) audioSinks.push(elements.cover);
            for (const child of elements.modeRoot?.children || []) {
                if (child.classList.contains('music-stage-mode-tunnel')) audioSinks.push(child);
                else if (child.classList.contains('music-stage-mode-starborn')) {
                    child.querySelectorAll(':scope > .starborn-star, :scope > .starborn-transition-burst')
                        .forEach(node => audioSinks.push(node));
                }
            }
        };
        const audioSinkRefs = [];
        const audioSinkClasses = [];
        let audioSinkInitialized = false;
        let audioSinkOpaque = false;
        let audioSinkEdge = true;
        const writeAudioLevels = (audio) => {
            const power = audio.power.toFixed(4);
            const bass = audio.bass.toFixed(4);
            const vocal = audio.vocal.toFixed(4);
            const key = `${power}|${bass}|${vocal}`;
            // Mode roots come and go with switches; the list follows them.
            const children = elements.modeRoot?.children;
            const len = children ? children.length : 0;
            const opaque = root.classList.contains('stage-opaque');
            const edgeActive = state.config.edgeSpectrum !== false && !reducedMotion();
            let changed = !audioSinkInitialized || len !== audioSinkRefs.length || opaque !== audioSinkOpaque || edgeActive !== audioSinkEdge;
            if (!changed) {
                for (let i = 0; i < len; i += 1) {
                    const child = children[i];
                    if (child !== audioSinkRefs[i] || child.className !== audioSinkClasses[i]) {
                        changed = true;
                        break;
                    }
                }
            }
            if (changed) {
                audioSinkInitialized = true;
                audioSinkOpaque = opaque;
                audioSinkEdge = edgeActive;
                audioSinkRefs.length = len;
                audioSinkClasses.length = len;
                for (let i = 0; i < len; i += 1) {
                    audioSinkRefs[i] = children[i];
                    audioSinkClasses[i] = children[i].className;
                }
                collectAudioSinks(opaque, edgeActive);
            }
            for (let i = 0; i < audioSinks.length; i += 1) {
                const node = audioSinks[i];
                if (audioWritten.get(node) === key) continue;
                audioWritten.set(node, key);
                node.style.setProperty('--stage-audio-power', power);
                node.style.setProperty('--stage-audio-bass', bass);
                node.style.setProperty('--stage-audio-vocal', vocal);
            }
        };

        const updateFrame = (timestamp) => {
            if (!state.active || state.destroyed || document.hidden) return;
            applySeekHold();
            const frame = Runtime.createFrame(app, timestamp);
            state.lastFrame = frame;
            state.stats.frameUpdates += 1;
            app.currentLyricIndex = frame.currentLineIndex;
            updateTrack(frame.track);
            updateProgress(frame);
            updatePlaybackState(frame.isPlaying);
            updateTransportControls();
            writeAudioLevels(frame.audio);
            edge.draw(frame);
            if (songHandover(frame)) state.modeInstance?.updateFrame?.(frame);
            updateDegradeNote(timestamp);
            if (state.leaving || state.arriving) {
                state.leaving?.instance.updateFrame?.(frame);
                advanceSoftSwitch(performance.now());
            }
        };

        // The lyric stages draw at most 60 frames a second, as the 3D stages do
        // on their standard tier: a 120 or 144 Hz display would otherwise run
        // every one of them twice as often as the eye can follow, at twice the
        // power. The 3D modes pace their own drawing, and the ultimate tier is
        // left unpaced. Calls from the stage itself (enter, theme) still draw.
        const frameCap = global.MusicStageModeUtils.createFrameCap();
        let lastPaced = -Infinity;
        const paceFrame = (timestamp) => {
            // A clock that went back (a caller's own timeline) starts over.
            if (timestamp < lastPaced) frameCap.reset();
            lastPaced = timestamp;
            if (!state.scene3d && state.config.quality !== 'ultimate'
                && !frameCap.take(timestamp, 'standard')) return;
            updateFrame(timestamp);
        };

        // The player polls the engine every 250 ms. During a drag, and until the
        // engine reports the committed position, those polls still carry the old
        // position, so the target is re-asserted before every stage frame.
        const holdSeek = (target, commit) => {
            const now = Date.now();
            state.seekHold = {
                target,
                stamp: now,
                until: commit ? now + 1500 : Infinity,
                origin: state.seekHold?.origin ?? (Number(app.lastKnownCurrentTime) || 0)
            };
            app.lastKnownCurrentTime = target;
            app.lastStateUpdateTime = now;
        };
        const applySeekHold = () => {
            const hold = state.seekHold;
            if (!hold) return;
            const now = Date.now();
            const polled = Number(app.lastKnownCurrentTime) || 0;
            const pollWrote = app.lastStateUpdateTime !== hold.stamp || polled !== hold.target;
            if (hold.until !== Infinity
                && (now > hold.until || (pollWrote && Math.abs(polled - hold.target) < 2))) {
                state.seekHold = null;
                return;
            }
            app.lastKnownCurrentTime = hold.target;
            app.lastStateUpdateTime = now;
            hold.stamp = now;
        };
        const cancelSeekHold = () => {
            const hold = state.seekHold;
            state.seekHold = null;
            if (!hold || hold.until !== Infinity) return;
            app.lastKnownCurrentTime = hold.origin;
            app.lastStateUpdateTime = Date.now();
        };

        const seekFromPointer = async (event, commit) => {
            const rect = elements.progressTrack.getBoundingClientRect();
            const ratio = clamp((event.clientX - rect.left) / Math.max(rect.width, 1));
            const duration = state.lastFrame?.duration || app.lastKnownDuration || 0;
            const target = duration * ratio;
            const width = `${(ratio * 100).toFixed(3)}%`;
            state.lastProgressWidth = width;
            elements.progressFill.style.width = width;
            if (elements.progressGlow) elements.progressGlow.style.width = width;
            const currentTimeText = app.formatTime?.(target) || '0:00';
            state.lastCurrentTimeText = currentTimeText;
            elements.currentTime.textContent = currentTimeText;
            holdSeek(target, commit);
            if (commit && duration > 0) await (app.seekTo ? app.seekTo(target) : app.api?.seekMusic?.(target));
        };

        const updateTheme = () => {
            if (state.destroyed) return;
            // 舞台未打开且无挂载实例时跳过主题探测（enter() 打开前必定再调一次 updateTheme()），
            // 避免启动阶段和后台切主题时触发 11 次同步样式重算与离屏 canvas 读回。
            if (!state.active && !state.modeInstance) {
                state.trackSignature = '';
                return;
            }
            // Custom palettes are already scoped to the stage root. Global mode
            // reads the page's computed wallpaper and color variables.
            if (state.config.themeMode !== 'custom') {
                const wallpaper = getComputedStyle(document.body).backgroundImage;
                root.style.setProperty('--stage-wallpaper', wallpaper || 'none');
                root.classList.remove('stage-theme-custom', 'stage-theme-light', 'stage-theme-dark');
            }
            void updateWallpaper();
            const palette = global.MusicStageModeUtils.refreshTheme(app, root);
            state.modeInstance?.updateTheme?.(palette);
            state.trackSignature = '';
            if (state.active) updateFrame(performance.now());
        };

        // 舞台选了自定义主题时，舞台和它上面的底栏、面板、标题栏按这份主题自己的明/暗取色，
        // 全局的「外观」亮暗切换原来对它不起作用（切了只有部分画面变）。在舞台里切亮暗时，
        // 自定义主题也换到同名主题的明/暗那一版；这份主题没有那一版就照旧。
        const followGlobalTheme = (theme) => {
            if (!state.active || state.destroyed || state.config.themeMode !== 'custom') return;
            const variant = theme === 'light' ? 'light' : 'dark';
            if (state.config.themeVariant === variant) return;
            const selected = state.themeCatalog.find(item => item.fileName === state.config.themeFile);
            if (!selected?.variables?.[variant] || !Object.keys(selected.variables[variant]).length) return;
            Config.update({ themeVariant: variant });
        };

        const enter = () => {
            if (state.active || state.destroyed) return;
            state.active = true;
            app.isStageActive = true;
            app.destroyAmbientPixi?.();
            document.body.classList.add('music-stage-active');
            root.hidden = false;
            root.setAttribute('aria-hidden', 'false');
            updateTheme();
            createMode(state.modeId);
            const enterGeneration = state.generation;
            requestAnimationFrame(() => {
                if (!state.active || state.destroyed || state.generation !== enterGeneration) return;
                root.classList.add('is-visible');
                root.focus({ preventScroll: true });
                updateFrame(performance.now());
            });
        };

        const exit = () => {
            if (!state.active || state.destroyed) return;
            if (state.settingsOpen) setSettingsOpen(false);
            setModePickerOpen(false, { focus: 'none' });
            state.active = false;
            app.isStageActive = false;
            root.classList.remove('is-visible');
            document.body.classList.remove('music-stage-active', 'music-stage-scene-3d');
            const generation = ++state.generation;
            requestAnimationFrame(() => {
                if (state.active || state.destroyed || generation !== state.generation) return;
                app.scrollCurrentTrackToSidebarTop?.();
            });
            scope.timeout(() => {
                if (state.active || state.destroyed || generation !== state.generation) return;
                destroyMode();
                edge.release();
                state.lastFrame = null;
                root.hidden = true;
                root.setAttribute('aria-hidden', 'true');
                document.querySelector('#music-dock-root [data-md="stage"]')?.focus({ preventScroll: true });
                app.createAmbientPixi?.();
            }, 380);
        };

        const toggle = () => state.active ? exit() : enter();

        const reducedMotion = () => Boolean(global.MusicMotion?.reduced?.()
            ?? global.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

        // Whether a mode has drawn its first real frame. The 3D modes report
        // `initialized` once their shaders are warm and a frame has run (or
        // `fallbackMode` once they settled for text); the others are ready
        // the moment they exist.
        const modeReady = (instance) => {
            if (!instance || instance.destroyed) return true;
            const snapshot = instance.getDebugSnapshot?.();
            if (!snapshot || !('initialized' in snapshot)) return true;
            return Boolean(snapshot.initialized || snapshot.fallbackMode);
        };

        // How long a switch waits for the new mode before showing it anyway.
        // A cold 3D start on a slow GPU can take longer; it then shows its
        // own text fallback until the scene is up, as it did before.
        const SWITCH_WAIT_MS = 2600;
        const SWITCH_LEAVE_MS = 360;
        const SWITCH_SETTLE_MS = 600;

        // Switch modes without a blank in between: the new mode is built
        // unseen behind the old one, both keep receiving frames, and once the
        // new one has drawn the old drifts forward and blurs away while the
        // new one comes out of the same blur.
        const softSwitch = (modeId) => {
            dropLeaving();
            if (state.arriving) {
                // Switched again before the last one was shown: that one never appeared.
                state.arriving = null;
                state.modeInstance?.destroy();
                state.stats.modeDestroys += 1;
                state.modeInstance = null;
            }
            const outgoing = state.modeInstance;
            state.modeInstance = null;
            if (outgoing) {
                state.leaving = { instance: outgoing, removeAt: Infinity };
                outgoing.root.classList.add('is-soft-leaving-wait');
            }
            createMode(modeId, { keepCurrent: true });
            const incoming = state.modeInstance;
            if (!incoming) return;
            incoming.root.classList.add('is-soft-arriving');
            state.arriving = { instance: incoming, since: performance.now() };
            advanceSoftSwitch(performance.now());
        };

        const advanceSoftSwitch = (now) => {
            const arriving = state.arriving;
            if (arriving) {
                if (arriving.instance !== state.modeInstance) { state.arriving = null; return; }
                if (!modeReady(arriving.instance) && now - arriving.since < SWITCH_WAIT_MS) return;
                state.arriving = null;
                const root = arriving.instance.root;
                // Start from the blurred state on a committed frame, then let it settle.
                root.classList.add('is-soft-settling');
                root.classList.remove('is-soft-arriving');
                requestAnimationFrame(() => root.classList.remove('is-soft-settling'));
                scope.timeout(() => root.classList.remove('is-soft-settling', 'is-soft-arriving'), SWITCH_SETTLE_MS + 200);
                if (state.leaving) {
                    state.leaving.instance.root.classList.remove('is-soft-leaving-wait');
                    state.leaving.instance.root.classList.add('is-soft-leaving');
                    state.leaving.removeAt = now + SWITCH_LEAVE_MS + 40;
                }
                return;
            }
            if (state.leaving && now >= state.leaving.removeAt) dropLeaving();
        };


        const setMode = (modeId) => {
            const resolved = Modes.get(modeId).id;
            if (resolved === state.modeId && state.modeInstance) return;
            state.stats.modeSwitches += 1;
            state.modeId = resolved;
            renderSettingsControls();
            if (!state.active) {
                localStorage.setItem('musicStageMode', resolved);
                return;
            }
            if (!reducedMotion() && state.modeInstance) {
                softSwitch(resolved);
                return;
            }
            elements.modeRoot.classList.add('is-switching');
            const generation = ++state.generation;
            scope.timeout(() => {
                if (!state.active || state.destroyed || generation !== state.generation) return;
                createMode(resolved);
                const createdGeneration = state.generation;
                requestAnimationFrame(() => {
                    if (!state.destroyed && state.generation === createdGeneration) elements.modeRoot.classList.remove('is-switching');
                });
            }, 170);
        };

        const onKeyDown = (event) => {
            if (!state.active) return;
            if (event.key === 'Tab' && state.settingsOpen && elements.settingsCard) {
                const focusable = Array.from(elements.settingsCard.querySelectorAll(
                    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
                )).filter((element) => !element.hidden && element.getClientRects().length > 0);
                if (focusable.length) {
                    const first = focusable[0];
                    const last = focusable[focusable.length - 1];
                    if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault();
                        last.focus({ preventScroll: true });
                    } else if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        first.focus({ preventScroll: true });
                    }
                }
            } else if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) {
                event.preventDefault();
                if (picker.open) {
                    setModePickerOpen(false, { focus: 'toggle' });
                    return;
                }
                if (state.settingsOpen) {
                    setSettingsOpen(false);
                    return;
                }
                exit();
            } else if (event.code === 'Space' && !event.defaultPrevented && !event.isComposing && !event.target?.closest?.('button, input, select, textarea, [contenteditable]')) {
                event.preventDefault();
                app.toggleTransport();
            } else if (event.key === 'ArrowLeft' && event.altKey) {
                event.preventDefault();
                app.prevTrack();
            } else if (event.key === 'ArrowRight' && event.altKey) {
                event.preventDefault();
                app.nextTrack();
            }
        };

        const setSettingsOpen = (open) => {
            const nextOpen = Boolean(open);
            if (nextOpen === state.settingsOpen) return;

            if (nextOpen) settingsReturnFocus = document.activeElement;
            state.settingsOpen = nextOpen;
            if (elements.settingsCard) {
                elements.settingsCard.hidden = !state.settingsOpen;
                elements.settingsCard.setAttribute('aria-hidden', String(!state.settingsOpen));
            }
            elements.settingsToggle?.setAttribute('aria-expanded', String(state.settingsOpen));
            elements.settings?.classList.toggle('is-open', state.settingsOpen);
            if (state.settingsOpen) {
                renderSettingsControls();
                elements.settingsClose?.focus({ preventScroll: true });
            } else if (!state.destroyed) {
                const focusTarget = settingsReturnFocus?.isConnected
                    ? settingsReturnFocus
                    : elements.settingsToggle;
                focusTarget?.focus?.({ preventScroll: true });
                settingsReturnFocus = null;
            }
        };

        let settingsStatusTimer = 0;
        scope.add(() => global.clearTimeout(settingsStatusTimer));
        const handleConfigChange = (config) => {
            state.config = config;
            root.classList.toggle('stage-edge-spectrum-off', config.edgeSpectrum === false);
            applyStageTheme();
            renderModeButtons();
            if (!editingSettings) renderSettingsControls();
            state.modeInstance?.updateConfig?.(config);
            if (elements.settingsStatus) {
                elements.settingsStatus.textContent = '已保存';
                elements.settingsStatus.classList.add('is-visible');
                global.clearTimeout(settingsStatusTimer);
                settingsStatusTimer = global.setTimeout(() => {
                    settingsStatusTimer = 0;
                    if (!state.destroyed) elements.settingsStatus.classList.remove('is-visible');
                }, 1200);
            }
        };

        root.classList.toggle('stage-edge-spectrum-off', state.config.edgeSpectrum === false);
        renderModeButtons();
        renderSettingsControls();
        loadThemeCatalog();
        elements.play.innerHTML = `${icons.play}${icons.pause}`;
        elements.prev.innerHTML = icons.previous;
        elements.next.innerHTML = icons.next;
        elements.volumeButton.innerHTML = `${icons.volume}${icons.muted}`;
        updateTransportControls();

        // 面板仅通过 Esc 或关闭按钮关闭，避免再次点击入口时误关闭。
        scope.listen(elements.settingsToggle, 'click', () => setSettingsOpen(true));
        scope.listen(elements.settingsClose, 'click', () => setSettingsOpen(false));
        scope.listen(elements.settingsReset, 'click', () => Config.reset());
        scope.listen(elements.modeOptions, 'change', (event) => {
            const checkbox = event.target.closest('[data-stage-config-mode]');
            if (!checkbox) return;
            Config.toggleMode(checkbox.dataset.stageConfigMode, checkbox.checked);
        });
        // 点击面板外部不关闭，避免调节控件时误触。
        scope.add(Config.subscribe(handleConfigChange));
        scope.listen(elements.play, 'click', () => app.toggleTransport());
        scope.listen(elements.prev, 'click', () => app.prevTrack());
        scope.listen(elements.next, 'click', () => app.nextTrack());
        scope.listen(elements.playMode, 'click', () => {
            if (typeof app.setPlayMode === 'function') {
                app.setPlayMode(app.currentPlayMode + 1);
            } else {
                app.currentPlayMode = (app.currentPlayMode + 1) % app.playModes.length;
                app.updateModeButton?.();
                app.saveSettings?.();
                if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
            }
            state.lastTransportSignature = '';
            updateTransportControls();
        });
        scope.listen(elements.volumeButton, 'click', () => {
            const current = Number(app.volumeSlider?.value) || 0;
            setVolume(current > 0.001 ? 0 : state.lastNonZeroVolume);
        });
        scope.listen(elements.volumeSlider, 'input', (event) => setVolume(event.target.value));
        // 左上角字标就是「返回首页」：和 Esc、底栏舞台按钮走同一条退出路径
        scope.listen(elements.homeButton, 'click', () => exit());
        scope.listen(elements.modeSwitcher, 'click', (event) => {
            if (picker.built && event.target.closest('.music-stage-mode-picker-toggle')) {
                // 鼠标点开时不抢焦点到列表（免得出现键盘焦点框），键盘打开时直接落到当前舞台上
                setModePickerOpen(!picker.open, { focus: event.detail === 0 ? 'menu' : 'none' });
                return;
            }
            const button = event.target.closest('[data-stage-mode]');
            if (!button) return;
            setMode(button.dataset.stageMode);
            setModePickerOpen(false, { focus: event.detail === 0 ? 'toggle' : 'none' });
        });
        scope.listen(elements.modeSwitcher, 'keydown', (event) => {
            if (!picker.built) return;
            const options = modeOptions();
            const index = options.indexOf(document.activeElement);
            if (event.target === picker.toggle && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                event.stopPropagation();
                setModePickerOpen(true);
                return;
            }
            if (!picker.open) return;
            const moves = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: options.length - 1 };
            if (event.key in moves) {
                event.preventDefault();
                event.stopPropagation();
                focusModeOption(index < 0 && event.key === 'ArrowUp' ? options.length - 1 : moves[event.key]);
            } else if (event.key === 'Escape' && !event.isComposing) {
                // 只收起菜单，不退出舞台
                event.preventDefault();
                event.stopPropagation();
                setModePickerOpen(false, { focus: 'toggle' });
            } else if (event.key === 'Tab') {
                setModePickerOpen(false, { focus: 'none' });
            }
        });
        scope.listen(document, 'pointerdown', (event) => {
            if (picker.open && !elements.modeSwitcher.contains(event.target)) setModePickerOpen(false, { focus: 'none' });
        }, true);
        scope.listen(elements.progressTrack, 'pointerdown', (event) => {
            state.draggingProgress = true;
            elements.progressTrack.setPointerCapture?.(event.pointerId);
            seekFromPointer(event, false);
        });
        scope.listen(elements.progressTrack, 'pointermove', (event) => {
            if (state.draggingProgress) seekFromPointer(event, false);
        });
        scope.listen(elements.progressTrack, 'pointerup', (event) => {
            if (!state.draggingProgress) return;
            state.draggingProgress = false;
            elements.progressTrack.releasePointerCapture?.(event.pointerId);
            seekFromPointer(event, true);
        });
        scope.listen(elements.progressTrack, 'pointercancel', () => {
            state.draggingProgress = false;
            cancelSeekHold();
        });
        scope.listen(elements.progressTrack, 'keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const duration = state.lastFrame?.duration || app.lastKnownDuration || 0;
            let target = app.lastKnownCurrentTime || 0;
            if (event.key === 'ArrowLeft') target -= 5;
            if (event.key === 'ArrowRight') target += 5;
            if (event.key === 'Home') target = 0;
            if (event.key === 'End') target = duration;
            target = clamp(target, 0, duration);
            state.seekHold = null;
            holdSeek(target, true);
            if (app.seekTo) app.seekTo(target); else app.api?.seekMusic?.(target);
        });
        scope.listen(global, 'keydown', onKeyDown);
        // Dragging a window edge fires resize many times a frame, and each
        // resize redraws the whole 3D picture: do it once per frame.
        let resizeFrame = 0;
        scope.add(() => global.cancelAnimationFrame?.(resizeFrame));
        scope.listen(global, 'resize', () => {
            edge.invalidate();
            if (resizeFrame) return;
            resizeFrame = global.requestAnimationFrame(() => {
                resizeFrame = 0;
                if (state.destroyed) return;
                const viewport = {
                    width: global.innerWidth,
                    height: global.innerHeight,
                    dpr: Math.min(2, global.devicePixelRatio || 1)
                };
                state.modeInstance?.resize?.(viewport);
                state.leaving?.instance.resize?.(viewport);
            });
        });
        scope.listen(document, 'visibilitychange', () => {
            // A hidden window would leave the old mode half faded out; finish the switch.
            if (document.hidden) { state.arriving = null; dropLeaving(); }
            if (state.modeInstance) {
                state.modeInstance.root.classList.remove('is-soft-arriving', 'is-soft-settling');
                if (document.hidden) state.modeInstance.suspend?.();
                else state.modeInstance.resume?.();
            }
        });
        scope.listen(global, 'music-motion-change', () => {
            if (state.active && !state.destroyed) updateFrame(performance.now());
        });
        scope.listen(global, 'beforeunload', () => app.stageHost?.destroy?.(), { once: true });

        // When 镜台 is the stage the listener will most likely open, build its
        // fixed shapes once the window has settled and is idle, so the first
        // visit does not stop the entry transition for them. A quarter of a
        // second of work, once per window, and nothing on the GPU.
        const PREPARE_AFTER_MS = 4000;
        const preparePreferredStage = (attempt = 0) => {
            if (state.active || state.destroyed || state.modeId !== 'diorama') return;
            const World = global.MusicStageDioramaWorld;
            if (!global.THREE || !World?.prepareShapes) return;
            // Not while the opening plays or anything else is moving on screen.
            if (document.hidden || document.body.classList.contains('music-intro-playing')) {
                if (attempt < 5) scope.timeout(() => preparePreferredStage(attempt + 1), PREPARE_AFTER_MS);
                return;
            }
            try { World.prepareShapes(global.THREE); } catch (error) {
                console.warn('[MusicStage] preparing the diorama ahead failed:', error);
            }
        };
        let prepareIdleId = 0;
        scope.add(() => {
            if (prepareIdleId) global.cancelIdleCallback?.(prepareIdleId);
            prepareIdleId = 0;
        });
        scope.timeout(() => {
            if (typeof global.requestIdleCallback === 'function') {
                prepareIdleId = global.requestIdleCallback(() => {
                    prepareIdleId = 0;
                    preparePreferredStage();
                }, { timeout: 10000 });
            } else preparePreferredStage();
        }, PREPARE_AFTER_MS);

        root.hidden = true;
        root.setAttribute('aria-hidden', 'true');

        app.stageHost = {
            enter,
            exit,
            toggle,
            setMode,
            updateFrame: paceFrame,
            updateTrack,
            updateTheme,
            followGlobalTheme,
            get active() { return state.active; },
            get modeId() { return state.modeId; },
            getDebugSnapshot() {
                return {
                    active: state.active,
                    modeId: state.modeId,
                    generation: state.generation,
                    hasModeInstance: Boolean(state.modeInstance),
                    switching: state.arriving ? 'waiting' : state.leaving ? 'crossfading' : null,
                    leavingModeId: state.leaving?.instance.id || null,
                    songHandover: state.handover ? (state.handover.newSong ? 'new-song' : 'new-lyrics') : null,
                    modeRootChildren: elements.modeRoot.childElementCount,
                    canvasCount: elements.modeRoot.querySelectorAll('canvas:not(.stage-handover-veil)').length,
                    ...state.stats,
                    mode: state.modeInstance?.getDebugSnapshot?.() || null
                };
            },
            destroy() {
                if (state.destroyed) return;
                state.destroyed = true;
                state.active = false;
                setSettingsOpen(false);
                app.isStageActive = false;
                state.generation += 1;
                if (state.backgroundTimer) clearTimeout(state.backgroundTimer);
                destroyMode();
                edge.release();
                scope.destroy();
                document.body.classList.remove('music-stage-active', 'music-stage-scene-3d');
                root.remove();
            }
        };
    }

    global.setupMusicStage = setupMusicStage;
})(window);