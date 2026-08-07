(() => {
    'use strict';

    const MATERIAL_FIELDS = Object.freeze([
        'surfaceOpacity',
        'surfaceBlur',
        'surfaceSaturation',
        'surfaceBrightness',
        'surfaceBorder',
        'surfaceShadow',
        'surfaceSheen'
    ]);
    const MATERIAL_DEFAULTS = Object.freeze({
        surfaceOpacity: 68,
        surfaceBlur: 24,
        surfaceSaturation: 145,
        surfaceBrightness: 103,
        surfaceBorder: 32,
        surfaceShadow: 18,
        surfaceSheen: 18
    });
    const MATERIAL_EFFECTS = Object.freeze({
        vibrancy: Object.freeze({
            name: 'Vibrancy', description: 'macOS 侧栏', icon: 'blur_on',
            values: Object.freeze({ ...MATERIAL_DEFAULTS })
        }),
        mica: Object.freeze({
            name: 'Mica', description: 'Windows 云母', icon: 'wallpaper',
            values: Object.freeze({ surfaceOpacity: 94, surfaceBlur: 0, surfaceSaturation: 100, surfaceBrightness: 100, surfaceBorder: 18, surfaceShadow: 8, surfaceSheen: 5 })
        }),
        acrylic: Object.freeze({
            name: 'Acrylic', description: 'Fluent 亚克力', icon: 'texture',
            values: Object.freeze({ surfaceOpacity: 76, surfaceBlur: 28, surfaceSaturation: 125, surfaceBrightness: 100, surfaceBorder: 28, surfaceShadow: 20, surfaceSheen: 12 })
        }),
        liquid: Object.freeze({
            name: 'Liquid Glass', description: '边缘折射', icon: 'water_drop',
            values: Object.freeze({ surfaceOpacity: 52, surfaceBlur: 18, surfaceSaturation: 132, surfaceBrightness: 104, surfaceBorder: 62, surfaceShadow: 24, surfaceSheen: 38 })
        })
    });
    const MATERIAL_CONTROLS = Object.freeze({
        surfaceOpacity: Object.freeze({ label: '表面浓度', description: '控制侧栏与顶栏的主题色浓度', min: 20, max: 100, unit: '%' }),
        surfaceBlur: Object.freeze({ label: '磨砂模糊', description: '柔化导航外壳后方的壁纸与视频', min: 0, max: 40, unit: 'px' }),
        surfaceSaturation: Object.freeze({ label: '背景饱和度', description: '增强或压低透过材质的颜色', min: 50, max: 180, unit: '%' }),
        surfaceBrightness: Object.freeze({ label: '背景亮度', description: '调整材质后方内容的明暗', min: 80, max: 120, unit: '%' }),
        surfaceBorder: Object.freeze({ label: '边缘清晰度', description: '控制导航外壳与内容区的分界', min: 0, max: 100, unit: '%' }),
        surfaceShadow: Object.freeze({ label: '悬浮阴影', description: '调整侧栏与顶栏的层次深度', min: 0, max: 100, unit: '%' }),
        surfaceSheen: Object.freeze({ label: '材质高光', description: '增加玻璃表面的色彩反光', min: 0, max: 100, unit: '%' })
    });
    const PROFILE_FIELDS = Object.freeze([
        'density',
        'radius',
        'typography',
        'fontScale',
        'contentWidth',
        'surface',
        'surfaceEffect',
        ...MATERIAL_FIELDS,
        'shellRadius',
        'composerRadius',
        'sidebarRadius',
        'cardRadius'
    ]);
    const THEME_MODES = new Set(['light', 'dark', 'system']);
    const UI_MODES = new Set(['classic', 'next']);
    const PRESETS = Object.freeze({
        balanced: Object.freeze({
            name: '平衡默认',
            icon: 'layout_dashboard',
            presentation: 'bubble',
            profile: Object.freeze({
                density: 'comfortable',
                radius: 'medium',
                typography: 'humanist',
                fontScale: 'normal',
                contentWidth: 'full',
                surface: 'translucent',
                surfaceEffect: 'vibrancy',
                ...MATERIAL_DEFAULTS,
                shellRadius: 'tuned',
                composerRadius: 'tuned',
                sidebarRadius: 'tuned',
                cardRadius: 'tuned'
            })
        }),
        focus: Object.freeze({
            name: '紧凑专注',
            icon: 'center_focus_strong',
            presentation: 'panel',
            profile: Object.freeze({
                density: 'compact',
                radius: 'small',
                typography: 'system',
                fontScale: 'small',
                contentWidth: 'centered',
                surface: 'solid',
                surfaceEffect: 'vibrancy',
                ...MATERIAL_DEFAULTS,
                shellRadius: 'tuned',
                composerRadius: 'tuned',
                sidebarRadius: 'tuned',
                cardRadius: 'tuned'
            })
        }),
        reading: Object.freeze({
            name: '沉浸阅读',
            icon: 'auto_stories',
            presentation: 'immersive',
            profile: Object.freeze({
                density: 'relaxed',
                radius: 'round',
                typography: 'serif',
                fontScale: 'large',
                contentWidth: 'centered',
                surface: 'solid',
                surfaceEffect: 'vibrancy',
                ...MATERIAL_DEFAULTS,
                shellRadius: 'tuned',
                composerRadius: 'tuned',
                sidebarRadius: 'tuned',
                cardRadius: 'tuned'
            })
        })
    });

    const DEFAULT_STATE = Object.freeze({
        uiMode: 'next',
        themeMode: 'system',
        themeFileName: null,
        presentation: 'bubble',
        messageWidth: 'normal',
        profile: Object.freeze({
            density: 'comfortable',
            radius: 'medium',
            typography: 'humanist',
            fontScale: 'normal',
            contentWidth: 'full',
            surface: 'translucent',
            surfaceEffect: 'vibrancy',
            ...MATERIAL_DEFAULTS,
            shellRadius: 'tuned',
            composerRadius: 'tuned',
            sidebarRadius: 'tuned',
            cardRadius: 'tuned'
        })
    });
    const PROFILE_CONTROL_IDS = Object.freeze({
        density: 'appearanceDensity',
        radius: 'appearanceRadius',
        typography: 'appearanceTypography',
        fontScale: 'appearanceFontScale',
        contentWidth: 'appearanceContentWidth',
        surface: 'appearanceSurface'
    });
    const SUMMARY_LABELS = Object.freeze({
        density: Object.freeze({ compact: '紧凑', comfortable: '舒适', relaxed: '宽松' }),
        radius: Object.freeze({ square: '直角', small: '小圆角', medium: '中圆角', round: '大圆角' }),
        typography: Object.freeze({ system: '系统字体', humanist: '人文字体', serif: '衬线字体' }),
        contentWidth: Object.freeze({ full: '全宽阅读区', centered: '居中阅读区' }),
        messageWidth: Object.freeze({ normal: '标准消息宽度', wide: '宽屏消息宽度' }),
        surface: Object.freeze({ solid: '纯色表面', translucent: '主题材质', custom: '自定义磨砂' }),
        detailRadius: Object.freeze({
            tuned: '原设计', follow: '跟随全局', square: '直角',
            small: '小圆角', medium: '中圆角', round: '大圆角'
        }),
        presentation: Object.freeze({ bubble: '气泡', panel: '面板', immersive: '沉浸' }),
        themeMode: Object.freeze({ light: '浅色', dark: '深色', system: '跟随系统' }),
        uiMode: Object.freeze({ classic: '经典布局', next: 'Next 布局' })
    });
    const DETAIL_RADIUS_FIELDS = Object.freeze([
        'shellRadius',
        'composerRadius',
        'sidebarRadius',
        'cardRadius'
    ]);
    const DETAIL_RADIUS_OPTIONS = Object.freeze([
        ['tuned', '原设计'],
        ['follow', '跟随全局'],
        ['square', '直角'],
        ['small', '小圆角'],
        ['medium', '中圆角'],
        ['round', '大圆角']
    ]);

    let surface = null;
    let snapshot = null;
    let snapshotRevision = 0;
    let draft = null;
    let sourceTrigger = null;
    let saving = false;
    let installedThemes = [];
    let themesLoading = false;
    let themesLoadError = null;
    let themesLoadSequence = 0;

    const clone = value => JSON.parse(JSON.stringify(value));
    const api = () => window.chatAPI || window.electronAPI;
    const currentUiMode = () => document.documentElement.dataset.uiMode || 'classic';
    const radiusDetailOptions = () => DETAIL_RADIUS_OPTIONS.map(([value, label]) => (
        `<option value="${value}">${label}</option>`
    )).join('');
    const materialControlRows = () => Object.entries(MATERIAL_CONTROLS).map(([key, control]) => `
        <label class="vcp-appearance-material-row">
            <span class="vcp-appearance-material-copy">
                <strong>${control.label}</strong><small>${control.description}</small>
            </span>
            <span class="vcp-appearance-material-control">
                <input type="range" min="${control.min}" max="${control.max}" step="1"
                    data-appearance-key="${key}" aria-label="${control.label}">
                <output data-material-output="${key}">${MATERIAL_DEFAULTS[key]}${control.unit}</output>
            </span>
        </label>`).join('');
    const materialEffectTiles = () => Object.entries(MATERIAL_EFFECTS).map(([id, effect]) => `
        <button type="button" class="vcp-appearance-material-effect vcp-appearance-material-effect-${id}"
            data-material-effect="${id}" title="${effect.name} · ${effect.description}">
            <span class="vcp-appearance-material-effect-icon" aria-hidden="true"><span class="vcp-ui-icon">${effect.icon}</span></span>
            <span><strong>${effect.name}</strong><small>${effect.description}</small></span>
            <span class="vcp-ui-icon vcp-appearance-material-effect-check" aria-hidden="true">check</span>
        </button>`).join('');

    function readEffectiveTheme() {
        return document.body.classList.contains('light-theme') ? 'light' : 'dark';
    }

    function effectiveThemeForMode(mode) {
        if (mode === 'light' || mode === 'dark') return mode;
        if (typeof window.matchMedia === 'function') {
            return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        return readEffectiveTheme();
    }

    function setThemeMode(mode, options = {}) {
        const normalizedMode = THEME_MODES.has(mode) ? mode : null;
        if (!normalizedMode) return false;
        const { persist = true, source = 'appearance-theme-control' } = options;
        const effectiveTheme = effectiveThemeForMode(normalizedMode);
        window.globalSettings = window.globalSettings || {};
        window.globalSettings.currentThemeMode = normalizedMode;
        window.uiManager?.applyTheme?.(effectiveTheme);
        if (persist) {
            if (normalizedMode === 'system') api()?.setThemeMode?.('system');
            else api()?.setTheme?.(normalizedMode);
        }
        syncAccountMenuValue();
        syncSettingsSummary();
        window.dispatchEvent(new CustomEvent('global-settings-updated', {
            detail: { settings: window.globalSettings, source }
        }));
        return true;
    }

    function readState() {
        const settings = window.globalSettings || {};
        const uiMode = UI_MODES.has(settings.uiMode) ? settings.uiMode : currentUiMode();
        const themeMode = THEME_MODES.has(settings.currentThemeMode)
            ? settings.currentThemeMode
            : readEffectiveTheme();
        return {
            uiMode,
            profile: window.VCPAppearance?.normalize(settings.appearanceProfile, uiMode)
                || clone(PRESETS.balanced.profile),
            presentation: window.normalizeChatPresentationMode?.(settings.chatPresentationMode) || 'bubble',
            messageWidth: settings.enableWideChatLayout === true ? 'wide' : 'normal',
            themeMode,
            themeFileName: null
        };
    }

    function normalizeState(state, fallback = readState()) {
        const source = state && typeof state === 'object' ? state : {};
        const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_STATE;
        const themeMode = THEME_MODES.has(source.themeMode) ? source.themeMode : base.themeMode;
        const uiMode = UI_MODES.has(source.uiMode) ? source.uiMode : base.uiMode;
        const themeFileName = typeof source.themeFileName === 'string'
            ? source.themeFileName
            : (typeof base.themeFileName === 'string' ? base.themeFileName : null);
        return {
            uiMode,
            profile: window.VCPAppearance?.normalize(source.profile || base.profile, uiMode)
                || clone(base.profile),
            presentation: window.normalizeChatPresentationMode?.(source.presentation || base.presentation)
                || base.presentation,
            messageWidth: source.messageWidth === 'wide' || source.messageWidth === 'normal'
                ? source.messageWidth
                : (base.messageWidth === 'wide' ? 'wide' : 'normal'),
            themeMode,
            themeFileName
        };
    }

    function readSettingsFormState() {
        const base = readState();
        const form = document.getElementById('globalSettingsForm');
        if (!form) return base;
        const profile = {
            ...base.profile,
            ...Object.fromEntries(Object.entries(PROFILE_CONTROL_IDS).map(([field, id]) => (
                [field, document.getElementById(id)?.value || base.profile[field]]
            )))
        };
        const modeControl = document.getElementById('enableNextUi');
        return normalizeState({
            uiMode: modeControl ? (modeControl.checked ? 'next' : 'classic') : base.uiMode,
            profile,
            presentation: document.querySelector('input[name="chatPresentationMode"]:checked')?.value
                || base.presentation,
            messageWidth: document.getElementById('chatLayoutModeWide')?.checked ? 'wide' : 'normal',
            themeMode: base.themeMode
        }, base);
    }

    function statesEqual(left, right) {
        return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
    }

    function matchingPreset(state) {
        if (!state) return null;
        return Object.entries(PRESETS).find(([, preset]) => (
            preset.presentation === state.presentation
            && PROFILE_FIELDS.every(field => preset.profile[field] === state.profile[field])
        ))?.[0] || null;
    }

    function syncAccountMenuValue(state = readState()) {
        const value = document.getElementById('nextUiAccountAppearanceStudioValue');
        if (!value) return;
        const presetId = matchingPreset(state);
        value.textContent = presetId ? PRESETS[presetId].name : '自定义';
    }

    function syncSettingsSummary() {
        const card = document.getElementById('appearanceSettingsWorkbenchCard');
        if (!card) return;
        const state = readSettingsFormState();
        const presetId = matchingPreset(state);
        const title = card.querySelector('[data-appearance-summary-title]');
        const description = card.querySelector('[data-appearance-summary-description]');
        const preview = card.querySelector('[data-appearance-summary-preview]');
        const density = card.querySelector('[data-appearance-summary-density]');
        const radius = card.querySelector('[data-appearance-summary-radius]');
        const presentation = card.querySelector('[data-appearance-summary-presentation]');
        if (title) title.textContent = presetId ? PRESETS[presetId].name : '自定义外观';
        if (description) {
            description.textContent = [
                SUMMARY_LABELS.uiMode[state.uiMode],
                SUMMARY_LABELS.themeMode[state.themeMode],
                SUMMARY_LABELS.typography[state.profile.typography],
                SUMMARY_LABELS.contentWidth[state.profile.contentWidth],
                SUMMARY_LABELS.messageWidth[state.messageWidth],
                SUMMARY_LABELS.surface[state.profile.surface]
            ].join(' · ');
        }
        if (density) density.textContent = SUMMARY_LABELS.density[state.profile.density];
        if (radius) radius.textContent = SUMMARY_LABELS.radius[state.profile.radius];
        if (presentation) presentation.textContent = SUMMARY_LABELS.presentation[state.presentation];
        if (preview) {
            preview.dataset.density = state.profile.density;
            preview.dataset.radius = state.profile.radius;
            preview.dataset.presentation = state.presentation;
            preview.dataset.theme = effectiveThemeForMode(state.themeMode);
            preview.dataset.uiMode = state.uiMode;
        }
    }

    function bindSettingsSummary() {
        const card = document.getElementById('appearanceSettingsWorkbenchCard');
        const form = document.getElementById('globalSettingsForm');
        const trigger = document.getElementById('openAppearanceStudioFromSettings');
        if (!card || !form || !trigger) return;
        if (!card.dataset.appearanceSummaryBound) {
            form.addEventListener('change', event => {
                if (event.target.matches('[id^="appearance"], input[name="chatPresentationMode"]')) {
                    syncSettingsSummary();
                }
            });
            trigger.addEventListener('click', () => {
                open({ trigger, initialState: readSettingsFormState() });
            });
            card.dataset.appearanceSummaryBound = 'true';
        }
        syncSettingsSummary();
    }

    function createSurface() {
        if (surface?.root?.isConnected) return surface;

        const root = document.createElement('div');
        root.id = 'vcpAppearanceStudio';
        root.className = 'vcp-ui-scope vcp-appearance-studio-overlay';
        root.hidden = true;
        root.innerHTML = `
            <section class="vcp-appearance-studio" role="dialog" aria-modal="true"
                aria-label="外观与布局" tabindex="-1">
                <div class="vcp-appearance-studio-content">
                    <section class="vcp-appearance-studio-section vcp-appearance-theme-section" aria-labelledby="vcpAppearanceThemeTitle">
                        <div class="vcp-appearance-studio-section-heading">
                            <div><h3 id="vcpAppearanceThemeTitle">主题与配色</h3><p>明暗模式与配色主题相互独立</p></div>
                            <div class="vcp-appearance-studio-header-actions">
                                <span class="vcp-appearance-studio-state" data-studio-status>已同步</span>
                                <button type="button" class="vcp-appearance-studio-reset" data-reset-section="theme" aria-label="重置主题模式" title="重置本节">
                                    <span class="vcp-ui-icon" aria-hidden="true">refresh</span>
                                </button>
                                <button type="button" class="vcp-appearance-studio-icon-button" data-studio-close
                                    aria-label="关闭外观与布局" title="关闭">
                                    <span class="vcp-ui-icon" aria-hidden="true">close</span>
                                </button>
                            </div>
                        </div>
                        <div class="vcp-appearance-theme-mode-row">
                            <h4>显示模式</h4>
                            <div class="vcp-appearance-theme-mode" role="group" aria-label="主题模式">
                            <button type="button" data-appearance-key="themeMode" data-appearance-value="system" title="跟随系统">
                                <span class="vcp-ui-icon" aria-hidden="true">computer</span><span>系统</span>
                            </button>
                            <button type="button" data-appearance-key="themeMode" data-appearance-value="light" title="浅色模式">
                                <span class="vcp-ui-icon" aria-hidden="true">light_mode</span><span>浅色</span>
                            </button>
                            <button type="button" data-appearance-key="themeMode" data-appearance-value="dark" title="深色模式">
                                <span class="vcp-ui-icon" aria-hidden="true">dark_mode</span><span>深色</span>
                            </button>
                            </div>
                        </div>
                        <div class="vcp-appearance-theme-palette-heading">
                            <div><h4>配色主题</h4><span data-theme-load-state>正在读取主题…</span></div>
                            <button type="button" class="vcp-appearance-studio-link" data-studio-action="themes">
                                <span class="vcp-ui-icon" aria-hidden="true">palette</span><span>管理</span>
                            </button>
                        </div>
                        <div class="vcp-appearance-theme-palette-grid" data-theme-palette-grid aria-live="polite"></div>
                    </section>
                    <section class="vcp-appearance-studio-section" aria-labelledby="vcpAppearanceLayoutTitle">
                        <div class="vcp-appearance-studio-section-heading">
                            <div><h3 id="vcpAppearanceLayoutTitle">界面布局</h3><p>选择主页结构，再调整空间密度和内容区域</p></div>
                            <button type="button" class="vcp-appearance-studio-reset" data-reset-section="layout" aria-label="重置界面布局" title="重置本节"><span class="vcp-ui-icon">refresh</span></button>
                        </div>
                        <div class="vcp-appearance-subsection vcp-appearance-shell-subsection">
                            <h4>主页布局</h4>
                            <div class="vcp-appearance-option-grid vcp-appearance-shell-grid" role="group" aria-label="主页布局">
                                <button type="button" class="vcp-appearance-option vcp-appearance-shell-option" data-appearance-key="uiMode" data-appearance-value="classic">
                                    <span class="vcp-appearance-shell-preview classic" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
                                    <span class="vcp-appearance-shell-copy"><strong>经典布局</strong><small>原版标题栏与三栏结构</small></span>
                                </button>
                                <button type="button" class="vcp-appearance-option vcp-appearance-shell-option" data-appearance-key="uiMode" data-appearance-value="next">
                                    <span class="vcp-appearance-shell-preview next" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
                                    <span class="vcp-appearance-shell-copy"><strong>Next 布局</strong><small>标签顶栏与圆角内容区</small></span>
                                </button>
                            </div>
                            <p class="vcp-appearance-shell-note"><span class="vcp-ui-icon" aria-hidden="true">info</span>只切换主页外壳；主题、壁纸与聊天内容保持不变。</p>
                        </div>
                        <div class="vcp-appearance-subsection"><h4>密度</h4><div class="vcp-appearance-option-grid vcp-appearance-density-grid" role="group" aria-label="界面密度">
                            <button type="button" class="vcp-appearance-option" data-appearance-key="density" data-appearance-value="compact"><span class="vcp-appearance-option-preview vcp-appearance-density-preview compact"><i></i><i></i><i></i><i></i></span><span class="vcp-appearance-tile-label">紧凑</span></button>
                            <button type="button" class="vcp-appearance-option" data-appearance-key="density" data-appearance-value="comfortable"><span class="vcp-appearance-option-preview vcp-appearance-density-preview comfortable"><i></i><i></i><i></i></span><span class="vcp-appearance-tile-label">舒适</span></button>
                            <button type="button" class="vcp-appearance-option" data-appearance-key="density" data-appearance-value="relaxed"><span class="vcp-appearance-option-preview vcp-appearance-density-preview relaxed"><i></i><i></i></span><span class="vcp-appearance-tile-label">宽松</span></button>
                        </div></div>
                        <div class="vcp-appearance-subsection"><h4>圆角</h4><div class="vcp-appearance-option-grid vcp-appearance-radius-grid" role="group" aria-label="圆角">
                            <button type="button" class="vcp-appearance-option" data-appearance-key="radius" data-appearance-value="square"><span class="vcp-appearance-option-preview vcp-appearance-radius-preview square"><i></i></span><span class="vcp-appearance-tile-label">直角</span></button>
                            <button type="button" class="vcp-appearance-option" data-appearance-key="radius" data-appearance-value="small"><span class="vcp-appearance-option-preview vcp-appearance-radius-preview small"><i></i></span><span class="vcp-appearance-tile-label">小</span></button>
                            <button type="button" class="vcp-appearance-option" data-appearance-key="radius" data-appearance-value="medium"><span class="vcp-appearance-option-preview vcp-appearance-radius-preview medium"><i></i></span><span class="vcp-appearance-tile-label">中</span></button>
                            <button type="button" class="vcp-appearance-option" data-appearance-key="radius" data-appearance-value="round"><span class="vcp-appearance-option-preview vcp-appearance-radius-preview round"><i></i></span><span class="vcp-appearance-tile-label">圆润</span></button>
                        </div></div>
                        <details class="vcp-appearance-detail-menu" data-radius-details>
                            <summary>
                                <span class="vcp-ui-icon" aria-hidden="true">tune</span>
                                <span class="vcp-appearance-detail-summary-copy">
                                    <strong>细节圆角</strong>
                                    <small>关键区域可独立于全局圆角</small>
                                </span>
                                <span class="vcp-appearance-detail-status" data-radius-details-status>使用原设计</span>
                                <span class="vcp-ui-icon vcp-appearance-detail-chevron" aria-hidden="true">expand_more</span>
                            </summary>
                            <div class="vcp-appearance-detail-body">
                                <label class="vcp-appearance-detail-row">
                                    <span><strong>主面板</strong><small>主聊天与 Build 左上角</small></span>
                                    <select data-appearance-key="shellRadius" aria-label="主面板圆角">${radiusDetailOptions()}</select>
                                </label>
                                <label class="vcp-appearance-detail-row">
                                    <span><strong>消息输入框</strong><small>主聊天与 Build 输入卡片</small></span>
                                    <select data-appearance-key="composerRadius" aria-label="消息输入框圆角">${radiusDetailOptions()}</select>
                                </label>
                                <label class="vcp-appearance-detail-row">
                                    <span><strong>侧栏列表</strong><small>Agent、话题与会话列表同步</small></span>
                                    <select data-appearance-key="sidebarRadius" aria-label="侧栏列表圆角">${radiusDetailOptions()}</select>
                                </label>
                                <label class="vcp-appearance-detail-row">
                                    <span><strong>卡片与弹窗</strong><small>设置、通知及内容卡片</small></span>
                                    <select data-appearance-key="cardRadius" aria-label="卡片与弹窗圆角">${radiusDetailOptions()}</select>
                                </label>
                            </div>
                        </details>
                        <div class="vcp-appearance-mini-options" role="group" aria-label="阅读区、消息宽度和导航材质">
                            <div class="vcp-appearance-mini-item"><h4>阅读区布局</h4><div class="vcp-appearance-segmented"><button type="button" data-appearance-key="contentWidth" data-appearance-value="full">全宽画布</button><button type="button" data-appearance-key="contentWidth" data-appearance-value="centered">居中阅读</button></div><p class="vcp-appearance-mini-helper">控制整个聊天阅读区</p></div>
                            <div class="vcp-appearance-mini-item"><h4>消息宽度</h4><div class="vcp-appearance-segmented"><button type="button" data-appearance-key="messageWidth" data-appearance-value="normal">标准</button><button type="button" data-appearance-key="messageWidth" data-appearance-value="wide">宽屏</button></div><p class="vcp-appearance-mini-helper">控制单条消息的最大宽度</p></div>
                            <div class="vcp-appearance-mini-item vcp-appearance-mini-item-wide"><h4>导航材质</h4><div class="vcp-appearance-segmented vcp-appearance-material-segmented"><button type="button" data-appearance-key="surface" data-appearance-value="translucent">主题</button><button type="button" data-appearance-key="surface" data-appearance-value="solid">纯色</button><button type="button" data-appearance-key="surface" data-appearance-value="custom">自定义</button></div></div>
                        </div>
                        <details class="vcp-appearance-material-menu" data-material-details>
                            <summary>
                                <span class="vcp-ui-icon" aria-hidden="true">blur_on</span>
                                <span class="vcp-appearance-detail-summary-copy">
                                    <strong>导航磨砂编辑器</strong>
                                    <small>仅作用于左侧栏与顶栏</small>
                                </span>
                                <span class="vcp-appearance-detail-status" data-material-details-status>主题原样</span>
                                <span class="vcp-ui-icon vcp-appearance-detail-chevron" aria-hidden="true">expand_more</span>
                            </summary>
                            <div class="vcp-appearance-material-body">
                                <div class="vcp-appearance-material-toolbar">
                                    <span>选择效果配方，再继续微调</span>
                                    <button type="button" data-reset-material>
                                        <span class="vcp-ui-icon" aria-hidden="true">restart_alt</span>
                                        <span>恢复主题默认</span>
                                    </button>
                                </div>
                                <div class="vcp-appearance-material-effect-grid" role="group" aria-label="磨砂效果配方">
                                    ${materialEffectTiles()}
                                </div>
                                <div class="vcp-appearance-material-preview" data-material-preview aria-hidden="true">
                                    <span class="vcp-appearance-material-preview-scene"></span>
                                    <span class="vcp-appearance-material-preview-topbar"></span>
                                    <span class="vcp-appearance-material-preview-sidebar"><i></i><i></i><i></i></span>
                                    <span class="vcp-appearance-material-preview-content"><i></i><i></i><i></i></span>
                                </div>
                                <div class="vcp-appearance-material-controls">${materialControlRows()}</div>
                            </div>
                        </details>
                    </section>
                    <section class="vcp-appearance-studio-section" aria-labelledby="vcpAppearanceTypeTitle">
                        <div class="vcp-appearance-studio-section-heading">
                            <div><h3 id="vcpAppearanceTypeTitle">字体与阅读</h3><p>让文字更贴合你的阅读习惯</p></div>
                            <button type="button" class="vcp-appearance-studio-reset" data-reset-section="type" aria-label="重置字体设置" title="重置本节"><span class="vcp-ui-icon">refresh</span></button>
                        </div>
                        <div class="vcp-appearance-option-grid vcp-appearance-font-grid" role="group" aria-label="界面字形">
                            <button type="button" class="vcp-appearance-option" data-appearance-key="typography" data-appearance-value="system"><span class="vcp-appearance-font-preview system">Aa</span><span class="vcp-appearance-tile-label">系统</span></button>
                            <button type="button" class="vcp-appearance-option" data-appearance-key="typography" data-appearance-value="humanist"><span class="vcp-appearance-font-preview humanist">Aa</span><span class="vcp-appearance-tile-label">人文</span></button>
                            <button type="button" class="vcp-appearance-option" data-appearance-key="typography" data-appearance-value="serif"><span class="vcp-appearance-font-preview serif">Aa</span><span class="vcp-appearance-tile-label">衬线</span></button>
                        </div>
                        <div class="vcp-appearance-font-scale"><h4>字号</h4><div class="vcp-appearance-segmented"><button type="button" data-appearance-key="fontScale" data-appearance-value="small">小</button><button type="button" data-appearance-key="fontScale" data-appearance-value="normal">标准</button><button type="button" data-appearance-key="fontScale" data-appearance-value="large">大</button></div></div>
                    </section>
                    <section class="vcp-appearance-studio-section" aria-labelledby="vcpAppearanceChatTitle">
                        <div class="vcp-appearance-studio-section-heading">
                            <div><h3 id="vcpAppearanceChatTitle">聊天呈现</h3><p>选择消息在主面板中的组织方式</p></div>
                            <button type="button" class="vcp-appearance-studio-reset" data-reset-section="chat" aria-label="重置聊天呈现" title="重置本节"><span class="vcp-ui-icon">refresh</span></button>
                        </div>
                        <div class="vcp-appearance-mode-grid" role="group" aria-label="聊天呈现">
                            <button type="button" data-appearance-key="presentation" data-appearance-value="bubble">
                                <span class="vcp-appearance-chat-preview bubble" aria-hidden="true"><i></i><i></i></span><span class="vcp-appearance-tile-label">气泡</span>
                            </button>
                            <button type="button" data-appearance-key="presentation" data-appearance-value="panel">
                                <span class="vcp-appearance-chat-preview panel" aria-hidden="true"><i></i><i></i><i></i></span><span class="vcp-appearance-tile-label">面板</span>
                            </button>
                            <button type="button" data-appearance-key="presentation" data-appearance-value="immersive">
                                <span class="vcp-appearance-chat-preview immersive" aria-hidden="true"><i></i></span><span class="vcp-appearance-tile-label">沉浸</span>
                            </button>
                        </div>
                    </section>
                    <section class="vcp-appearance-studio-section vcp-appearance-studio-section-featured vcp-appearance-studio-section-presets" aria-labelledby="vcpAppearancePresetsTitle">
                        <div class="vcp-appearance-studio-section-heading">
                            <div>
                                <h3 id="vcpAppearancePresetsTitle">快速预设</h3>
                                <p>一键组合布局与阅读参数，不改变当前明暗主题</p>
                            </div>
                        </div>
                        <div class="vcp-appearance-preset-grid">
                            ${Object.entries(PRESETS).map(([id, preset]) => `
                                <button type="button" class="vcp-appearance-preset vcp-appearance-tile" data-appearance-preset="${id}">
                                    <span class="vcp-appearance-preset-preview vcp-appearance-preset-preview-${id}" aria-hidden="true">
                                        <span></span><span></span><span></span>
                                    </span>
                                    <span class="vcp-appearance-tile-label">${preset.name}</span>
                                    <span class="vcp-appearance-tile-description">${id === 'focus' ? '高效工作' : id === 'reading' ? '长文阅读' : '日常对话'}</span>
                                    <span class="vcp-appearance-tile-check" aria-hidden="true"><span class="vcp-ui-icon">check</span></span>
                                </button>`).join('')}
                        </div>
                    </section>
                    <section class="vcp-appearance-studio-section vcp-appearance-studio-actions" aria-label="更多外观设置">
                        <button type="button" data-studio-action="wallpaper">
                            <span class="vcp-ui-icon" aria-hidden="true">movie</span><span>视频壁纸</span>
                            <span class="vcp-ui-icon" aria-hidden="true">chevron_right</span>
                        </button>
                        <button type="button" data-studio-action="settings">
                            <span class="vcp-ui-icon" aria-hidden="true">settings</span><span>完整设置</span>
                            <span class="vcp-ui-icon" aria-hidden="true">chevron_right</span>
                        </button>
                    </section>
                </div>
                <footer class="vcp-appearance-studio-footer">
                    <button type="button" class="vcp-appearance-studio-reset-all" data-reset-all><span class="vcp-ui-icon">restore</span><span>恢复默认</span></button>
                    <button type="button" class="vcp-appearance-studio-secondary" data-studio-cancel>取消</button>
                    <button type="button" class="vcp-appearance-studio-primary" data-studio-save>
                        <span class="vcp-ui-icon" aria-hidden="true">check</span><span>应用</span>
                    </button>
                </footer>
            </section>`;

        root.querySelectorAll('.vcp-appearance-option, .vcp-appearance-mode-grid button').forEach(button => {
            const check = document.createElement('span');
            check.className = 'vcp-appearance-option-check';
            check.innerHTML = '<span class="vcp-ui-icon" aria-hidden="true">check</span>';
            button.append(check);
        });

        document.body.append(root);
        const themePreviewStyle = document.createElement('style');
        themePreviewStyle.dataset.appearanceThemeSwatches = 'true';
        root.append(themePreviewStyle);
        const dialog = root.querySelector('.vcp-appearance-studio');
        const status = root.querySelector('[data-studio-status]');
        const saveButton = root.querySelector('[data-studio-save]');
        const wallpaperButton = root.querySelector('[data-studio-action="wallpaper"]');

        root.addEventListener('click', handleClick);
        root.addEventListener('change', handleChange);
        root.addEventListener('input', handleInput);
        root.addEventListener('keydown', handleKeydown);
        root.addEventListener('pointerdown', event => {
            if (event.target === root) void close({ rollback: true });
        });
        surface = {
            root,
            dialog,
            status,
            saveButton,
            wallpaperButton,
            themePreviewStyle,
            themeGrid: root.querySelector('[data-theme-palette-grid]'),
            themeLoadState: root.querySelector('[data-theme-load-state]')
        };
        return surface;
    }

    function themePreviewColors(theme) {
        const effectiveMode = effectiveThemeForMode(draft?.themeMode || readState().themeMode);
        const preferred = theme?.variables?.[effectiveMode] || {};
        const alternate = theme?.variables?.[effectiveMode === 'dark' ? 'light' : 'dark'] || {};
        const safeColor = color => {
            const normalized = String(color || '').trim();
            return /^#[\da-f]{3,8}$/i.test(normalized)
                || /^(?:rgb|hsl)a?\([\d\s.,%+-]+\)$/i.test(normalized)
                ? normalized
                : null;
        };
        const value = (...keys) => {
            for (const variables of [preferred, alternate]) {
                for (const key of keys) {
                    const color = safeColor(variables[key]);
                    if (color) return color;
                }
            }
            return null;
        };
        return [
            value('--primary-bg', '--secondary-bg') || '#20242b',
            value('--button-bg', '--highlight-text', '--accent-color') || '#6d7cff',
            value('--secondary-bg', '--message-bg', '--input-bg') || '#343a46'
        ];
    }

    function renderThemePalette() {
        if (!surface) return;
        const grid = surface.themeGrid;
        grid.replaceChildren();
        surface.themeLoadState.textContent = themesLoading
            ? '正在读取主题…'
            : themesLoadError || (installedThemes.length ? `${installedThemes.length} 款已安装` : '暂无可用主题');
        if (themesLoading) {
            surface.themePreviewStyle.textContent = '';
            for (let index = 0; index < 8; index += 1) {
                const skeleton = document.createElement('span');
                skeleton.className = 'vcp-appearance-theme-skeleton';
                skeleton.setAttribute('aria-hidden', 'true');
                grid.append(skeleton);
            }
            return;
        }
        installedThemes.forEach((theme, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'vcp-appearance-theme-swatch';
            button.dataset.themeFileName = theme.fileName;
            button.dataset.themePreviewIndex = String(index);
            button.title = theme.name;
            button.innerHTML = `
                <span class="vcp-appearance-theme-swatch-preview" aria-hidden="true">
                    <i></i><i></i><i></i>
                    <span class="vcp-ui-icon">check</span>
                </span>
                <span class="vcp-appearance-theme-swatch-name"></span>`;
            button.querySelector('.vcp-appearance-theme-swatch-name').textContent = theme.name;
            grid.append(button);
        });
        syncThemePaletteColors();
        syncThemePaletteSelection();
    }

    function syncThemePaletteColors() {
        if (!surface) return;
        surface.themePreviewStyle.textContent = installedThemes.map((theme, index) => {
            const [primary, accent, secondary] = themePreviewColors(theme);
            return `[data-theme-preview-index="${index}"]{--theme-preview-primary:${primary};--theme-preview-accent:${accent};--theme-preview-secondary:${secondary}}`;
        }).join('');
    }

    function syncThemePaletteSelection() {
        if (!surface || !draft) return;
        surface.themeGrid.querySelectorAll('[data-theme-file-name]').forEach(button => {
            const active = button.dataset.themeFileName === draft.themeFileName;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    }

    function removeThemePreview() {
        document.getElementById('vcpAppearanceThemePreview')?.remove();
    }

    function previewThemeFile(fileName) {
        if (!fileName || fileName === snapshot?.themeFileName) {
            removeThemePreview();
            return;
        }
        if (!installedThemes.some(theme => theme.fileName === fileName)) return;
        let link = document.getElementById('vcpAppearanceThemePreview');
        if (!link) {
            link = document.createElement('link');
            link.id = 'vcpAppearanceThemePreview';
            link.rel = 'stylesheet';
            link.dataset.appearanceThemePreview = 'true';
            document.head.append(link);
        }
        link.href = new URL(`styles/themes/${encodeURIComponent(fileName)}`, document.baseURI).href;
    }

    async function loadThemes() {
        if (!surface) return;
        const sequence = ++themesLoadSequence;
        themesLoading = true;
        themesLoadError = null;
        renderThemePalette();
        try {
            const themes = await api()?.getThemes?.();
            if (sequence !== themesLoadSequence || !surface || surface.root.hidden) return;
            installedThemes = Array.isArray(themes)
                ? themes.slice().sort((left, right) => Number(right.isActive) - Number(left.isActive)
                    || String(left.name).localeCompare(String(right.name), 'zh-CN'))
                : [];
            const activeTheme = installedThemes.find(theme => theme.isActive)?.fileName || null;
            if (snapshot && draft && snapshot.themeFileName === null && draft.themeFileName === null) {
                snapshot.themeFileName = activeTheme;
                draft.themeFileName = activeTheme;
            }
        } catch (error) {
            installedThemes = [];
            themesLoadError = '主题读取失败';
            console.error('[AppearanceStudio] Failed to load installed themes:', error);
        } finally {
            if (sequence === themesLoadSequence) {
                themesLoading = false;
                renderThemePalette();
                syncControls();
            }
        }
    }

    function setBusy(nextBusy) {
        saving = nextBusy;
        if (!surface) return;
        surface.root.toggleAttribute('data-saving', nextBusy);
        surface.root.querySelectorAll('button, input, select').forEach(control => {
            control.disabled = nextBusy || (control === surface.saveButton && statesEqual(snapshot, draft));
        });
    }

    function syncControls() {
        if (!surface || !draft) return;
        surface.root.querySelectorAll('[data-appearance-key]').forEach(button => {
            const { appearanceKey: key, appearanceValue: value } = button.dataset;
            const current = PROFILE_FIELDS.includes(key) ? draft.profile[key] : draft[key];
            if (button.matches('select')) {
                button.value = current;
                return;
            }
            if (button.matches('input[type="range"]')) {
                button.value = String(current);
                const output = surface.root.querySelector(`[data-material-output="${key}"]`);
                if (output) output.textContent = `${current}${MATERIAL_CONTROLS[key]?.unit || ''}`;
                return;
            }
            const active = current === value;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        syncThemePaletteSelection();
        syncThemePaletteColors();
        const activePreset = matchingPreset(draft);
        surface.root.querySelectorAll('[data-appearance-preset]').forEach(button => {
            const active = button.dataset.appearancePreset === activePreset;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        const changed = !statesEqual(snapshot, draft);
        surface.status.textContent = changed ? '预览中' : '已同步';
        surface.status.classList.toggle('is-dirty', changed);
        surface.saveButton.disabled = saving || !changed;
        surface.wallpaperButton.hidden = !document.getElementById('vchatDynamicWallpaperMenuButton');
        const customDetailCount = DETAIL_RADIUS_FIELDS.filter(field => draft.profile[field] !== 'tuned').length;
        const detailStatus = surface.root.querySelector('[data-radius-details-status]');
        if (detailStatus) {
            detailStatus.textContent = customDetailCount
                ? `${customDetailCount} 项自定义`
                : '使用原设计';
        }
        const materialStatus = surface.root.querySelector('[data-material-details-status]');
        if (materialStatus) {
            materialStatus.textContent = draft.profile.surface === 'custom'
                ? `${MATERIAL_EFFECTS[draft.profile.surfaceEffect]?.name || 'Vibrancy'} · 自定义`
                : draft.profile.surface === 'solid' ? '纯色' : '主题原样';
        }
        surface.root.querySelectorAll('[data-material-effect]').forEach(button => {
            const active = draft.profile.surface === 'custom'
                && button.dataset.materialEffect === draft.profile.surfaceEffect;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        const materialPreview = surface.root.querySelector('[data-material-preview]');
        if (materialPreview) {
            materialPreview.dataset.surface = draft.profile.surface;
            materialPreview.dataset.effect = draft.profile.surfaceEffect;
        }
    }

    function resetSection(section) {
        if (!draft) return;
        const defaults = DEFAULT_STATE;
        if (section === 'theme') {
            draft.themeMode = defaults.themeMode;
        } else if (section === 'layout') {
            ['density', 'radius', 'contentWidth', 'surface', ...MATERIAL_FIELDS, ...DETAIL_RADIUS_FIELDS].forEach(field => {
                draft.profile[field] = defaults.profile[field];
            });
            draft.messageWidth = defaults.messageWidth;
        } else if (section === 'type') {
            ['typography', 'fontScale'].forEach(field => {
                draft.profile[field] = defaults.profile[field];
            });
        } else if (section === 'chat') {
            draft.presentation = defaults.presentation;
        }
        void preview();
    }

    async function preview(options = {}) {
        if (!draft) return;
        if (window.uiModeManager?.applyAsync) {
            await window.uiModeManager.applyAsync(draft.uiMode, { cache: false });
        } else {
            window.uiModeManager?.apply(draft.uiMode, { cache: false });
        }
        window.VCPAppearance?.apply(draft.profile, {
            uiMode: draft.uiMode,
            cache: false,
            source: 'appearance-studio-preview'
        });
        document.body.classList.toggle('chat-wide-layout', draft.messageWidth === 'wide');
        if (!options.appearanceOnly) {
            window.uiManager?.applyTheme?.(effectiveThemeForMode(draft.themeMode));
            previewThemeFile(draft.themeFileName);
            await window.applyChatPresentationMode?.(draft.presentation, {
                persist: false,
                preserveScroll: true,
                notify: false,
                source: 'appearance-studio-preview'
            });
        }
        syncControls();
        window.dispatchEvent(new CustomEvent('vcp-appearance-studio-preview', {
            detail: { state: clone(draft) }
        }));
    }

    async function restoreSnapshot() {
        if (!snapshot) return;
        if ((window.VCPAppearance?.getRevision?.() || 0) !== snapshotRevision) return;
        removeThemePreview();
        if (window.uiModeManager?.applyAsync) {
            await window.uiModeManager.applyAsync(snapshot.uiMode, { cache: false });
        } else {
            window.uiModeManager?.apply(snapshot.uiMode, { cache: false });
        }
        window.VCPAppearance?.apply(snapshot.profile, {
            uiMode: snapshot.uiMode,
            cache: false,
            source: 'appearance-studio-rollback'
        });
        document.body.classList.toggle('chat-wide-layout', snapshot.messageWidth === 'wide');
        window.uiManager?.applyTheme?.(effectiveThemeForMode(snapshot.themeMode));
        await window.applyChatPresentationMode?.(snapshot.presentation, {
            persist: false,
            preserveScroll: true,
            notify: false,
            source: 'appearance-studio-rollback'
        });
    }

    function syncLegacySettingsControls() {
        if (!draft) return;
        const enableNextUi = document.getElementById('enableNextUi');
        if (enableNextUi) enableNextUi.checked = draft.uiMode === 'next';
        Object.entries(PROFILE_CONTROL_IDS).forEach(([field, id]) => {
            const control = document.getElementById(id);
            if (control) {
                control.value = draft.profile[field];
                control.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        const presentation = document.querySelector(
            `input[name="chatPresentationMode"][value="${draft.presentation}"]`
        );
        if (presentation) {
            presentation.checked = true;
            presentation.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const messageWidth = document.getElementById(
            draft.messageWidth === 'wide' ? 'chatLayoutModeWide' : 'chatLayoutModeNormal'
        );
        if (messageWidth) {
            messageWidth.checked = true;
            messageWidth.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    async function save() {
        if (!draft || saving || statesEqual(snapshot, draft)) return;
        setBusy(true);
        const nextState = clone(draft);
        try {
            const result = await api()?.saveSettings?.({
                uiMode: nextState.uiMode,
                appearanceProfile: nextState.profile,
                chatPresentationMode: nextState.presentation,
                enableWideChatLayout: nextState.messageWidth === 'wide',
                currentThemeMode: nextState.themeMode
            });
            if (!result?.success) throw new Error(result?.error || '设置保存失败');

            Object.assign(window.globalSettings || {}, {
                uiMode: nextState.uiMode,
                appearanceProfile: nextState.profile,
                chatPresentationMode: nextState.presentation,
                enableWideChatLayout: nextState.messageWidth === 'wide',
                currentThemeMode: nextState.themeMode
            });
            if (window.uiModeManager?.applyAsync) {
                await window.uiModeManager.applyAsync(nextState.uiMode, { cache: true });
            } else {
                window.uiModeManager?.apply(nextState.uiMode, { cache: true });
            }
            window.VCPAppearance?.commit(nextState.profile, {
                uiMode: nextState.uiMode,
                source: 'appearance-studio-save'
            });
            await window.applyChatPresentationMode?.(nextState.presentation, {
                persist: false,
                preserveScroll: true,
                notify: false,
                source: 'appearance-studio-save'
            });
            if (nextState.themeMode === 'system') {
                api()?.setThemeMode?.('system');
                window.uiManager?.applyTheme?.(effectiveThemeForMode('system'));
            } else {
                api()?.setTheme?.(nextState.themeMode);
                window.uiManager?.applyTheme?.(nextState.themeMode);
            }
            if (nextState.themeFileName && nextState.themeFileName !== snapshot.themeFileName) {
                api()?.applyTheme?.(nextState.themeFileName);
            }
            syncLegacySettingsControls();
            snapshot = clone(nextState);
            snapshotRevision = window.VCPAppearance?.getRevision?.() || snapshotRevision;
            syncAccountMenuValue(nextState);
            window.dispatchEvent(new CustomEvent('global-settings-updated', {
                detail: { settings: window.globalSettings, source: 'appearance-studio' }
            }));
            window.uiHelperFunctions?.showToastNotification?.('外观与布局已应用。', 'success');
            await close({ rollback: false });
        } catch (error) {
            await restoreSnapshot();
            draft = clone(snapshot);
            syncControls();
            window.uiHelperFunctions?.showToastNotification?.(`外观与布局保存失败：${error.message}`, 'error');
        } finally {
            setBusy(false);
        }
    }

    async function close({ rollback = true } = {}) {
        if (!surface || surface.root.hidden || (saving && rollback)) return;
        surface.root.hidden = true;
        surface.root.classList.remove('active');
        document.body.classList.remove('vcp-appearance-studio-open');
        if (rollback) await restoreSnapshot();
        const nextFocus = sourceTrigger?.isConnected ? sourceTrigger : null;
        sourceTrigger = null;
        snapshot = null;
        snapshotRevision = 0;
        draft = null;
        themesLoadSequence += 1;
        document.documentElement.classList.remove('vcp-appearance-studio-host');
        nextFocus?.focus?.();
    }

    function open(options = {}) {
        document.documentElement.classList.add('vcp-appearance-studio-host');
        const currentSurface = createSurface();
        if (!currentSurface.root.hidden) {
            currentSurface.dialog.focus();
            return true;
        }
        sourceTrigger = options.trigger || document.activeElement;
        snapshot = readState();
        snapshotRevision = window.VCPAppearance?.getRevision?.() || 0;
        draft = normalizeState(options.initialState, snapshot);
        currentSurface.root.hidden = false;
        document.body.classList.add('vcp-appearance-studio-open');
        if (statesEqual(snapshot, draft)) syncControls();
        else void preview();
        void loadThemes();
        requestAnimationFrame(() => {
            currentSurface.root.classList.add('active');
            currentSurface.dialog.focus();
        });
        return true;
    }

    async function openAccountSubmenu(buttonId) {
        await close({ rollback: true });
        window.topTabManager?.openAccountMenu?.();
        if (buttonId === 'vchatDynamicWallpaperMenuButton') {
            window.VCPFrontendPlugins?.get?.('vchat-dynamic-wallpaper')?.openMenu?.();
        }
    }

    async function handleClick(event) {
        const target = event.target.closest('button');
        if (!target || saving) return;
        if (target.matches('[data-studio-close], [data-studio-cancel]')) {
            await close({ rollback: true });
            return;
        }
        if (target.matches('[data-studio-save]')) {
            await save();
            return;
        }
        if (target.matches('[data-reset-section]')) {
            resetSection(target.dataset.resetSection);
            return;
        }
        if (target.matches('[data-reset-material]')) {
            draft.profile.surface = 'translucent';
            draft.profile.surfaceEffect = 'vibrancy';
            MATERIAL_FIELDS.forEach(field => {
                draft.profile[field] = MATERIAL_DEFAULTS[field];
            });
            await preview({ appearanceOnly: true });
            return;
        }
        const materialEffect = target.dataset.materialEffect;
        if (materialEffect && MATERIAL_EFFECTS[materialEffect]) {
            draft.profile.surface = 'custom';
            draft.profile.surfaceEffect = materialEffect;
            Object.assign(draft.profile, MATERIAL_EFFECTS[materialEffect].values);
            await preview({ appearanceOnly: true });
            return;
        }
        if (target.matches('[data-reset-all]')) {
            const themeFileName = draft.themeFileName;
            const uiMode = draft.uiMode;
            draft = { ...clone(DEFAULT_STATE), uiMode, themeFileName };
            await preview();
            return;
        }
        const presetId = target.dataset.appearancePreset;
        if (presetId && PRESETS[presetId]) {
            const preset = PRESETS[presetId];
            draft = {
                uiMode: draft.uiMode,
                profile: clone(preset.profile),
                presentation: preset.presentation,
                messageWidth: draft.messageWidth,
                themeMode: draft.themeMode,
                themeFileName: draft.themeFileName
            };
            await preview();
            return;
        }
        const key = target.dataset.appearanceKey;
        const value = target.dataset.appearanceValue;
        if (key && value && draft) {
            if (PROFILE_FIELDS.includes(key)) draft.profile[key] = value;
            else draft[key] = value;
            await preview();
            return;
        }
        const themeFileName = target.dataset.themeFileName;
        if (themeFileName && draft && installedThemes.some(theme => theme.fileName === themeFileName)) {
            draft.themeFileName = themeFileName;
            await preview();
            return;
        }
        if (target.dataset.studioAction === 'themes') {
            await close({ rollback: true });
            api()?.openThemesWindow?.();
        } else if (target.dataset.studioAction === 'wallpaper') {
            await openAccountSubmenu('vchatDynamicWallpaperMenuButton');
        } else if (target.dataset.studioAction === 'settings') {
            await close({ rollback: true });
            window.uiHelperFunctions?.openModal?.('globalSettingsModal');
        }
    }

    async function handleChange(event) {
        const control = event.target.closest('select[data-appearance-key]');
        if (!control || saving || !draft) return;
        const key = control.dataset.appearanceKey;
        if (!PROFILE_FIELDS.includes(key)) return;
        draft.profile[key] = control.value;
        await preview({ appearanceOnly: true });
    }

    async function handleInput(event) {
        const control = event.target.closest('input[type="range"][data-appearance-key]');
        if (!control || saving || !draft) return;
        const key = control.dataset.appearanceKey;
        if (!MATERIAL_FIELDS.includes(key)) return;
        const config = MATERIAL_CONTROLS[key];
        const value = Math.min(config.max, Math.max(config.min, Number(control.value)));
        draft.profile[key] = value;
        draft.profile.surface = 'custom';
        await preview({ appearanceOnly: true });
    }

    function handleKeydown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            void close({ rollback: true });
            return;
        }
        if (event.key !== 'Tab' || !surface) return;
        const focusable = Array.from(surface.dialog.querySelectorAll(
            'button:not([disabled]):not([hidden]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter(element => element.getClientRects().length || element === document.activeElement);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    window.addEventListener('global-settings-updated', () => {
        if (!surface || surface.root.hidden) syncAccountMenuValue();
        syncSettingsSummary();
    });
    window.addEventListener('ui-mode-changed', () => {
        if (!surface || surface.root.hidden) syncSettingsSummary();
    });
    document.addEventListener('DOMContentLoaded', () => {
        syncAccountMenuValue();
        bindSettingsSummary();
    });
    document.addEventListener('modal-ready', event => {
        if (event.detail?.modalId === 'globalSettingsModal') requestAnimationFrame(bindSettingsSummary);
    });

    window.VCPAppearanceStudio = Object.freeze({
        PRESETS,
        open,
        close,
        isOpen: () => Boolean(surface && !surface.root.hidden),
        readState,
        syncAccountMenuValue,
        syncSettingsSummary,
        setThemeMode
    });
})();
