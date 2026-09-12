(function (global) {
    'use strict';

    const Runtime = global.MusicStageRuntime;
    const Modes = global.MusicStageModes;
    const Config = global.MusicStageConfig;
    if (!Runtime || !Modes || !Config) throw new Error('Music stage runtime, config and modes must load before music-stage-host.js');

    const { clamp, DisposableScope } = Runtime;

    const fileUrl = (path) => path ? `file://${String(path).replace(/\\/g, '/')}` : '';

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
        const toggleButton = document.getElementById('stage-toggle-btn');
        if (!root || !toggleButton) {
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
            modeSwitcher: root.querySelector('.music-stage-mode-switcher'),
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

        const edgeContext = elements.edgeCanvas?.getContext('2d', { alpha: true });
        const prefersReducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const edgeCanvasState = {
            width: 0,
            height: 0,
            dpr: 1,
            top: new Float32Array(0),
            right: new Float32Array(0),
            bottom: new Float32Array(0),
            left: new Float32Array(0)
        };

        const scope = new DisposableScope();
        let editingSettings = false;
        const pixiTuningDefinitions = [
            { key: 'performanceIntensity', label: '场景编舞强度', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
            { key: 'beatImpact', label: '音频起音冲击', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
            { key: 'opticalImpact', label: '瞬态套印色散', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'accentEffects', label: '偶发强调（商籁螺旋落字／凝彩外框循迹）', type: 'toggle' },
            { key: 'accentMotion', label: '偶发强调动势', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
            { key: 'sceneTransitions', label: '切句过渡', type: 'toggle' },
            { key: 'shotFlow', label: '分镜镜头', type: 'select', options: [['auto', '自动导演'], ['editorial-column', '编辑纵列'], ['type-impact', '文字冲击'], ['fragment-collage', '碎片拼贴'], ['tracking-ribbon', '带状追焦'], ['mask-reveal', '上升揭幕'], ['poster-blocks', '海报定景'], ['quiet-tableau', '静谧长镜']] },
            { key: 'cameraSoftness', label: '镜头平缓度', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'cameraRoll', label: '镜头侧倾', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'lyricLayout', label: '歌词构图', type: 'select', options: [['lines', '整句分行'], ['phrases', '短语分组'], ['staircase', '阶梯短语'], ['editorial-track', '纵横连续版轨']] },
            { key: 'trackVerticalChance', label: '版轨纵排概率', type: 'range', min: 0.1, max: 0.9, step: 0.05, unit: '%' },
            { key: 'trackJunction', label: '版轨交错幅度', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'trackLookAhead', label: '镜头前路预瞄', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
            { key: 'trackMinSegment', label: '空格错栏最短字数', type: 'range', min: 2, max: 8, step: 1, unit: '字' },
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
            { key: 'rgbShift', label: 'RGB 偏移', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
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
        const lyricLayoutStyle = { key: 'layoutStyle', label: '构图风格', type: 'select', options: [['calm', '平静'], ['normal', '原作标准'], ['chaotic', '奔放']] };
        const tuningDefinitions = Object.freeze({
            tempera: [
                { key: 'cameraIntensity', label: '镜头强度', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'glyphMotion', label: '逐字动势', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'colorMode', label: '色彩模式', type: 'select', options: [['duo', '主题双色'], ['mono', '黑白灰'], ['gradient', '封面渐变']] },
                { key: 'showBlocks', label: '色块场景', type: 'toggle' },
                { key: 'showDecor', label: '装饰元素', type: 'toggle' },
                { key: 'textInversion', label: '演唱强调色', type: 'toggle' },
                { key: 'postProcess', label: '光学后处理（节能档关闭）', type: 'toggle' },
                ...pixiTuningDefinitions
            ],
            sonnet: [
                { key: 'cameraIntensity', label: '镜头强度', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'typographyMotion', label: '文字动势', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'guideLines', label: '轨迹线', type: 'toggle' },
                { key: 'showBackground', label: '主场景', type: 'toggle' },
                { key: 'showDecor', label: '背景装饰', type: 'toggle' },
                { key: 'postProcess', label: '光学后处理（节能档关闭）', type: 'toggle' },
                ...pixiTuningDefinitions
            ],
            diorama: [
                { key: 'cameraSpeed', label: '镜头速度', type: 'range', min: 0.55, max: 1.85, step: 0.05, unit: 'x' },
                { key: 'motionAmount', label: '运动幅度', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'audioReactivity', label: '点云音频响应', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' },
                { key: 'showParticles', label: '背景粒子', type: 'toggle' },
                { key: 'geometryMode', label: '几何形态', type: 'select', options: [['clouds', '点云'], ['corridor', '长廊']] },
                { key: 'glow', label: '辉光强度', type: 'range', min: 0, max: 2, step: 0.05, unit: 'x' }
            ],
            luminous: [
                ...vectorDecorControls,
                { key: 'fontScale', label: '文字比例', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
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
                { key: 'fontScale', label: '文字比例', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
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
                { key: 'fontScale', label: '文字比例', type: 'range', min: 0.65, max: 1.5, step: 0.05, unit: 'x' },
                { key: 'widthRatio', label: '构图宽度', type: 'range', min: 0.5, max: 0.95, step: 0.01, unit: '' },
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
                { key: 'transitionLock', label: '转场锁定', type: 'range', min: 0.5, max: 12, step: 0.5, unit: 's' },
                { key: 'avoidRepeat', label: '避免重复', type: 'toggle' }
            ]
        });
        const state = {
            active: false,
            modeId: localStorage.getItem('musicStageMode') || 'luminous',
            modeInstance: null,
            generation: 0,
            trackPath: null,
            trackSignature: '',
            coverUrl: '',
            backgroundTimer: null,
            lastFrame: null,
            draggingProgress: false,
            lastTransportSignature: '',
            lastProgressWidth: '',
            lastCurrentTimeText: '',
            lastDurationText: '',
            lastProgressAriaValue: '',
            lastProgressAriaText: '',
            lastPlaybackState: null,
            lastAudioPower: '',
            lastAudioBass: '',
            lastAudioVocal: '',
            lastNonZeroVolume: Math.max(0.35, Number(app.volumeSlider?.value) || 1),
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

        const setButtonState = () => {
            toggleButton.classList.toggle('is-active', state.active);
            toggleButton.setAttribute('aria-pressed', String(state.active));
            toggleButton.setAttribute('aria-label', state.active ? '退出歌词舞台' : '进入歌词舞台');
            toggleButton.title = state.active ? '退出歌词舞台 (Esc)' : '进入歌词舞台';
        };

        const destroyMode = () => {
            if (!state.modeInstance) return;
            state.modeInstance.destroy();
            state.modeInstance = null;
            state.stats.modeDestroys += 1;
        };

        const createMode = (modeId) => {
            destroyMode();
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

            elements.modeSwitcher.querySelectorAll('[data-stage-mode]').forEach((button) => {
                const selected = button.dataset.stageMode === state.modeId;
                button.classList.toggle('is-active', selected);
                button.setAttribute('aria-pressed', String(selected));
            });

            if (state.active) {
                state.lastFrame = Runtime.createFrame(app, performance.now());
                state.modeInstance.updateFrame(state.lastFrame);
            }
        };

        const renderModeButtons = () => {
            const fragment = document.createDocumentFragment();
            const visibleIds = state.config.enabledModes.includes(state.modeId)
                ? state.config.enabledModes
                : [state.modeId, ...state.config.enabledModes];
            Modes.entries.filter((entry) => visibleIds.includes(entry.id)).forEach((entry) => {
                const button = createElement('button', 'music-stage-mode-button', {
                    type: 'button',
                    text: entry.label,
                    title: `切换至${entry.label}`,
                    'data-stage-mode': entry.id,
                    'aria-pressed': String(entry.id === state.modeId)
                });
                button.classList.toggle('is-active', entry.id === state.modeId);
                fragment.appendChild(button);
            });
            elements.modeSwitcher.replaceChildren(fragment);
        };

        const formatTuningValue = (definition, value) => {
            if (definition.type === 'toggle') return value ? '开' : '关';
            if (definition.type === 'select') return definition.options.find(([key]) => key === value)?.[1] || String(value || '');
            if (definition.unit === '%') return `${Math.round(Number(value) * 100)}%`;
            return `${Number(value).toFixed(definition.step < 0.1 ? 2 : 1)}${definition.unit || ''}`;
        };

        const renderSettingsControls = () => {
            if (!elements.modeOptions || !elements.tuningControls || !elements.commonControls) return;
            const config = state.config;
            const modeFragment = document.createDocumentFragment();
            Modes.entries.forEach((entry) => {
                const label = createElement('label', 'music-stage-mode-option');
                const checkbox = createElement('input', '', { type: 'checkbox' });
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
            (tuningDefinitions[state.modeId] || []).forEach((definition) => {
                const value = config.modes[state.modeId]?.[definition.key];
                const row = createElement('label', 'music-stage-tuning-row');
                const header = createElement('span', 'music-stage-tuning-label');
                const valueText = createElement('span', 'music-stage-tuning-value');
                header.textContent = definition.label;
                valueText.textContent = formatTuningValue(definition, value);
                const control = definition.type === 'toggle'
                    ? createElement('input', '', { type: 'checkbox' })
                    : definition.type === 'select'
                        ? createElement('select', '')
                        : createElement('input', '', {
                            type: 'range',
                            min: definition.min,
                            max: definition.max,
                            step: definition.step,
                            value
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
                };
                control.addEventListener('input', handleControlChange);
                control.addEventListener('change', handleControlChange);
                row.append(header, valueText, control);
                tuningFragment.appendChild(row);
            });
            elements.tuningControls.replaceChildren(tuningFragment);

            const commonFragment = document.createDocumentFragment();
            const edgeRow = createElement('label', 'music-stage-tuning-row');
            const edgeLabel = createElement('span', 'music-stage-tuning-label', '边缘频谱');
            const edgeToggle = createElement('input', '', { type: 'checkbox' });
            edgeToggle.checked = config.edgeSpectrum !== false;
            edgeToggle.addEventListener('change', () => Config.update({ edgeSpectrum: edgeToggle.checked }));
            edgeRow.append(edgeLabel, edgeToggle);
            commonFragment.appendChild(edgeRow);

            const quality = createElement('select', 'music-stage-common-select');
            [['energy-saving', '节能'], ['standard', '标准'], ['ultimate', '极致']].forEach(([value, label]) => {
                quality.appendChild(createElement('option', '', { value, text: label }));
            });
            quality.value = config.quality;
            quality.addEventListener('change', () => Config.update({ quality: quality.value }));
            const qualityRow = createElement('label', 'music-stage-tuning-row');
            qualityRow.append(createElement('span', 'music-stage-tuning-label', '性能档位'), quality);
            const intensity = createElement('input', 'music-stage-common-range', {
                type: 'range', min: 0, max: 2, step: 0.05, value: config.animationIntensity
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
            commonFragment.append(qualityRow, intensityRow);
            elements.commonControls.replaceChildren(commonFragment);
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

            elements.backdropNext.style.backgroundImage = cssImage;
            root.classList.add('is-changing-cover');
            state.backgroundTimer = setTimeout(() => {
                elements.backdropCurrent.style.backgroundImage = cssImage;
                root.classList.remove('is-changing-cover');
                state.backgroundTimer = null;
            }, 850);
        };

        const updateTrack = (track) => {
            const title = app.stripAudioExtension?.(track?.title) || track?.title || '未选择歌曲';
            const artist = track?.artist || '未知艺术家';
            const album = track?.album || '';
            const coverUrl = fileUrl(track?.albumArt);
            const identity = track?.path || `${title}\u0001${artist}`;
            const signature = `${identity}\u0001${title}\u0001${artist}\u0001${album}\u0001${coverUrl}\u0001${app.currentTheme}`;
            if (signature === state.trackSignature) return;
            state.trackSignature = signature;

            if (identity !== state.trackPath) {
                state.trackPath = identity;
                elements.title.classList.remove('is-changing');
                void elements.title.offsetWidth;
                elements.title.classList.add('is-changing');
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

        const resizeEdgeCanvas = (frame) => {
            if (!edgeContext || !elements.edgeCanvas) return false;
            const width = Math.max(1, root.clientWidth);
            const height = Math.max(1, root.clientHeight);
            const dpr = Math.min(1.75, frame.viewport?.dpr || global.devicePixelRatio || 1);
            const pixelWidth = Math.round(width * dpr);
            const pixelHeight = Math.round(height * dpr);
            if (
                edgeCanvasState.width !== width
                || edgeCanvasState.height !== height
                || edgeCanvasState.dpr !== dpr
            ) {
                elements.edgeCanvas.width = pixelWidth;
                elements.edgeCanvas.height = pixelHeight;
                elements.edgeCanvas.style.width = `${width}px`;
                elements.edgeCanvas.style.height = `${height}px`;
                edgeCanvasState.width = width;
                edgeCanvasState.height = height;
                edgeCanvasState.dpr = dpr;
            }
            edgeContext.setTransform(dpr, 0, 0, dpr, 0, 0);
            return true;
        };

        const getSpectrumSample = (spectrum, ratio, offset = 0) => {
            if (!spectrum?.length) return 0;
            const wrappedRatio = (clamp(ratio) * 0.86 + offset) % 1;
            const center = Math.floor(Math.pow(wrappedRatio, 1.55) * (spectrum.length - 1));
            const radius = Math.max(1, Math.floor(spectrum.length / 180));
            let total = 0;
            let count = 0;
            for (let index = Math.max(0, center - radius); index <= Math.min(spectrum.length - 1, center + radius); index += 1) {
                total += Number(spectrum[index]) || 0;
                count += 1;
            }
            const value = total / Math.max(1, count);
            return clamp(Math.pow(Math.max(0, value - 0.025), 0.78));
        };

        const ensureEdgeBuffer = (side, pointCount) => {
            const coordinateCount = pointCount * 2;
            if (edgeCanvasState[side].length !== coordinateCount) {
                edgeCanvasState[side] = new Float32Array(coordinateCount);
            }
            return edgeCanvasState[side];
        };

        const fillEdgePoints = (
            points,
            side,
            spectrum,
            offset,
            inset,
            width,
            height,
            amplitude,
            idleScale
        ) => {
            const count = points.length / 2;
            const span = side === 'top' || side === 'bottom'
                ? width - inset * 2
                : height - inset * 2;
            for (let index = 0; index < count; index += 1) {
                const ratio = index / Math.max(1, count - 1);
                const edgeFade = Math.pow(Math.sin(ratio * Math.PI), 0.42);
                const energy = getSpectrumSample(spectrum, ratio, offset) * edgeFade * idleScale;
                const coordinateIndex = index * 2;
                if (side === 'top') {
                    points[coordinateIndex] = inset + ratio * span;
                    points[coordinateIndex + 1] = inset + energy * amplitude;
                } else if (side === 'bottom') {
                    points[coordinateIndex] = width - inset - ratio * span;
                    points[coordinateIndex + 1] = height - inset - energy * amplitude;
                } else if (side === 'left') {
                    points[coordinateIndex] = inset + energy * amplitude;
                    points[coordinateIndex + 1] = height - inset - ratio * span;
                } else {
                    points[coordinateIndex] = width - inset - energy * amplitude;
                    points[coordinateIndex + 1] = inset + ratio * span;
                }
            }
        };

        const strokeEdgePath = (points, color, alpha, blur) => {
            if (!edgeContext || points.length < 4) return;
            edgeContext.save();
            edgeContext.beginPath();
            edgeContext.moveTo(points[0], points[1]);
            for (let index = 2; index < points.length - 2; index += 2) {
                edgeContext.quadraticCurveTo(
                    points[index],
                    points[index + 1],
                    (points[index] + points[index + 2]) / 2,
                    (points[index + 1] + points[index + 3]) / 2
                );
            }
            edgeContext.lineTo(points[points.length - 2], points[points.length - 1]);
            edgeContext.lineCap = 'round';
            edgeContext.lineJoin = 'round';
            edgeContext.lineWidth = blur > 0 ? 2.8 : 1.05;
            edgeContext.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
            edgeContext.shadowColor = `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.min(0.9, alpha * 1.45)})`;
            edgeContext.shadowBlur = blur;
            edgeContext.stroke();
            edgeContext.restore();
        };

        const drawEdgeSpectrum = (frame) => {
            if (state.config.edgeSpectrum === false) return;
            if (!resizeEdgeCanvas(frame) || !edgeContext) return;
            const { width, height } = edgeCanvasState;
            edgeContext.clearRect(0, 0, width, height);
            if (prefersReducedMotion?.matches || !frame.audio.spectrum?.length) return;

            const spectrum = frame.audio.spectrum;
            const color = global.MusicStageModeUtils.resolveAccent(app);
            const inset = clamp(Math.min(width, height) * 0.012, 7, 14);
            const horizontalAmplitude = clamp(height * 0.052, 18, 48);
            const verticalAmplitude = clamp(width * 0.038, 15, 42);
            const horizontalCount = clamp(Math.round(width / 15), 44, 104);
            const verticalCount = clamp(Math.round(height / 15), 28, 72);
            const idleScale = frame.isPlaying ? 1 : 0.12;

            const top = ensureEdgeBuffer('top', horizontalCount);
            const right = ensureEdgeBuffer('right', verticalCount);
            const bottom = ensureEdgeBuffer('bottom', horizontalCount);
            const left = ensureEdgeBuffer('left', verticalCount);
            fillEdgePoints(top, 'top', spectrum, 0, inset, width, height, horizontalAmplitude, idleScale);
            fillEdgePoints(right, 'right', spectrum, 0.11, inset, width, height, verticalAmplitude, idleScale);
            fillEdgePoints(bottom, 'bottom', spectrum, 0.21, inset, width, height, horizontalAmplitude, idleScale);
            fillEdgePoints(left, 'left', spectrum, 0.34, inset, width, height, verticalAmplitude, idleScale);

            const alpha = 0.28 + frame.audio.power * 0.62;
            strokeEdgePath(top, color, alpha * 0.38, 13);
            strokeEdgePath(right, color, alpha * 0.38, 13);
            strokeEdgePath(bottom, color, alpha * 0.38, 13);
            strokeEdgePath(left, color, alpha * 0.38, 13);
            strokeEdgePath(top, color, alpha, 2.5);
            strokeEdgePath(right, color, alpha, 2.5);
            strokeEdgePath(bottom, color, alpha, 2.5);
            strokeEdgePath(left, color, alpha, 2.5);
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

        const updateFrame = (timestamp) => {
            if (!state.active || state.destroyed || document.hidden) return;
            const frame = Runtime.createFrame(app, timestamp);
            state.lastFrame = frame;
            state.stats.frameUpdates += 1;
            app.currentLyricIndex = frame.currentLineIndex;
            updateTrack(frame.track);
            updateProgress(frame);
            updatePlaybackState(frame.isPlaying);
            updateTransportControls();
            const audioPower = frame.audio.power.toFixed(4);
            if (audioPower !== state.lastAudioPower) {
                state.lastAudioPower = audioPower;
                root.style.setProperty('--stage-audio-power', audioPower);
            }
            const audioBass = frame.audio.bass.toFixed(4);
            if (audioBass !== state.lastAudioBass) {
                state.lastAudioBass = audioBass;
                root.style.setProperty('--stage-audio-bass', audioBass);
            }
            const audioVocal = frame.audio.vocal.toFixed(4);
            if (audioVocal !== state.lastAudioVocal) {
                state.lastAudioVocal = audioVocal;
                root.style.setProperty('--stage-audio-vocal', audioVocal);
            }
            drawEdgeSpectrum(frame);
            state.modeInstance?.updateFrame?.(frame);
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
            app.lastKnownCurrentTime = target;
            app.lastStateUpdateTime = Date.now();
            if (commit && duration > 0) await app.api?.seekMusic?.(target);
        };

        const updateTheme = () => {
            if (state.destroyed) return;
            // Read the computed image rather than copying a raw CSS variable:
            // relative URLs must resolve against the theme stylesheet, not this one.
            const wallpaper = getComputedStyle(document.body).backgroundImage;
            root.style.setProperty('--stage-wallpaper', wallpaper || 'none');
            const palette = global.MusicStageModeUtils.refreshTheme(app, root);
            state.modeInstance?.updateTheme?.(palette);
            state.trackSignature = '';
            if (state.active) updateFrame(performance.now());
        };

        const enter = () => {
            if (state.active || state.destroyed) return;
            state.active = true;
            app.isStageActive = true;
            document.body.classList.add('music-stage-active');
            root.hidden = false;
            root.setAttribute('aria-hidden', 'false');
            updateTheme();
            createMode(state.modeId);
            setButtonState();
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
            state.active = false;
            app.isStageActive = false;
            root.classList.remove('is-visible');
            document.body.classList.remove('music-stage-active');
            setButtonState();
            const generation = ++state.generation;
            scope.timeout(() => {
                if (state.active || state.destroyed || generation !== state.generation) return;
                destroyMode();
                state.lastFrame = null;
                root.hidden = true;
                root.setAttribute('aria-hidden', 'true');
                toggleButton.focus({ preventScroll: true });
            }, 380);
        };

        const toggle = () => state.active ? exit() : enter();

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
            if (event.key === 'Escape') {
                event.preventDefault();
                if (state.settingsOpen) {
                    setSettingsOpen(false);
                    elements.settingsToggle?.focus({ preventScroll: true });
                    return;
                }
                exit();
            } else if (event.code === 'Space' && !event.target.closest('button, input, select')) {
                event.preventDefault();
                app.isPlaying ? app.pauseTrack() : app.playTrack();
            } else if (event.key === 'ArrowLeft' && event.altKey) {
                event.preventDefault();
                app.prevTrack();
            } else if (event.key === 'ArrowRight' && event.altKey) {
                event.preventDefault();
                app.nextTrack();
            }
        };

        const setSettingsOpen = (open) => {
            state.settingsOpen = Boolean(open);
            if (elements.settingsCard) elements.settingsCard.hidden = !state.settingsOpen;
            elements.settingsToggle?.setAttribute('aria-expanded', String(state.settingsOpen));
            elements.settings?.classList.toggle('is-open', state.settingsOpen);
            if (state.settingsOpen) {
                renderSettingsControls();
                elements.settingsClose?.focus({ preventScroll: true });
            }
        };

        const handleConfigChange = (config) => {
            state.config = config;
            root.classList.toggle('stage-edge-spectrum-off', config.edgeSpectrum === false);
            renderModeButtons();
            if (!editingSettings) renderSettingsControls();
            state.modeInstance?.updateConfig?.(config);
            if (elements.settingsStatus) {
                elements.settingsStatus.textContent = '已保存';
                elements.settingsStatus.classList.add('is-visible');
                scope.timeout(() => elements.settingsStatus.classList.remove('is-visible'), 1200);
            }
        };

        root.classList.toggle('stage-edge-spectrum-off', state.config.edgeSpectrum === false);
        renderModeButtons();
        renderSettingsControls();
        elements.play.innerHTML = `${icons.play}${icons.pause}`;
        elements.prev.innerHTML = icons.previous;
        elements.next.innerHTML = icons.next;
        elements.volumeButton.innerHTML = `${icons.volume}${icons.muted}`;
        updateTransportControls();

        scope.listen(toggleButton, 'click', toggle);
        scope.listen(elements.settingsToggle, 'click', () => setSettingsOpen(!state.settingsOpen));
        scope.listen(elements.settingsClose, 'click', () => setSettingsOpen(false));
        scope.listen(elements.settingsReset, 'click', () => Config.reset());
        scope.listen(elements.modeOptions, 'change', (event) => {
            const checkbox = event.target.closest('[data-stage-config-mode]');
            if (!checkbox) return;
            Config.toggleMode(checkbox.dataset.stageConfigMode, checkbox.checked);
        });
        scope.listen(document, 'pointerdown', (event) => {
            if (state.settingsOpen
                && elements.settings
                && !elements.settings.contains(event.target)) {
                setSettingsOpen(false);
            }
        });
        scope.add(Config.subscribe(handleConfigChange));
        scope.listen(elements.play, 'click', () => app.isPlaying ? app.pauseTrack() : app.playTrack());
        scope.listen(elements.prev, 'click', () => app.prevTrack());
        scope.listen(elements.next, 'click', () => app.nextTrack());
        scope.listen(elements.playMode, 'click', () => {
            app.currentPlayMode = (app.currentPlayMode + 1) % app.playModes.length;
            app.updateModeButton?.();
            if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
            state.lastTransportSignature = '';
            updateTransportControls();
        });
        scope.listen(elements.volumeButton, 'click', () => {
            const current = Number(app.volumeSlider?.value) || 0;
            setVolume(current > 0.001 ? 0 : state.lastNonZeroVolume);
        });
        scope.listen(elements.volumeSlider, 'input', (event) => setVolume(event.target.value));
        scope.listen(elements.modeSwitcher, 'click', (event) => {
            const button = event.target.closest('[data-stage-mode]');
            if (button) setMode(button.dataset.stageMode);
        });
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
            app.lastKnownCurrentTime = target;
            app.lastStateUpdateTime = Date.now();
            app.api?.seekMusic?.(target);
        });
        scope.listen(global, 'keydown', onKeyDown);
        scope.listen(global, 'resize', () => {
            edgeCanvasState.width = 0;
            edgeCanvasState.height = 0;
            state.modeInstance?.resize?.({
                width: global.innerWidth,
                height: global.innerHeight,
                dpr: Math.min(2, global.devicePixelRatio || 1)
            });
        });
        scope.listen(document, 'visibilitychange', () => {
            if (!state.modeInstance) return;
            if (document.hidden) state.modeInstance.suspend?.();
            else state.modeInstance.resume?.();
        });
        scope.listen(global, 'beforeunload', () => app.stageHost?.destroy?.(), { once: true });

        setButtonState();
        root.hidden = true;
        root.setAttribute('aria-hidden', 'true');

        app.stageHost = {
            enter,
            exit,
            toggle,
            setMode,
            updateFrame,
            updateTrack,
            updateTheme,
            get active() { return state.active; },
            get modeId() { return state.modeId; },
            getDebugSnapshot() {
                return {
                    active: state.active,
                    modeId: state.modeId,
                    generation: state.generation,
                    hasModeInstance: Boolean(state.modeInstance),
                    modeRootChildren: elements.modeRoot.childElementCount,
                    canvasCount: elements.modeRoot.querySelectorAll('canvas').length,
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
                if (edgeContext && elements.edgeCanvas) {
                    edgeContext.clearRect(0, 0, elements.edgeCanvas.width, elements.edgeCanvas.height);
                    elements.edgeCanvas.width = 1;
                    elements.edgeCanvas.height = 1;
                }
                scope.destroy();
                document.body.classList.remove('music-stage-active');
                root.remove();
            }
        };
    }

    global.setupMusicStage = setupMusicStage;
})(window);