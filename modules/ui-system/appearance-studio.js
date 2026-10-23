(() => {
    'use strict';

    const LifecycleScope = window.VCPLifecycle?.LifecycleScope;
    const moduleScope = LifecycleScope ? new LifecycleScope('next:appearance-studio-controller') : null;
    let capabilities = Object.create(null);
    window.addEventListener('vcp-appearance-studio-configure', event => {
        capabilities = Object.freeze({ ...(event.detail || {}) });
    }, { once: true });
    window.addEventListener('vcp-appearance-studio-dispose', event => {
        if (destroyPromise) {
            event.detail.promise = destroyPromise;
            return;
        }
        destroyed = true;
        destroyPromise = (async () => {
            await disposeView({ rollback: true });
            await moduleScope?.dispose('appearance-controller-destroyed');
        })();
        event.detail.promise = destroyPromise;
    }, { once: true });
    const service = (name, fallback) => capabilities[name] || fallback?.();
    const getSettings = () => service('settings', null)?.get?.() || {};
    const replaceSettings = patch => service('settings', null)?.replace?.(patch);
    const getAppearance = () => service('appearance', () => window.VCPAppearance);
    const getUiManager = () => service('uiManager', () => window.uiManager);
    const getPresentationMode = mode => service('presentation', null)?.normalize?.(mode);
    const applyPresentation = (...args) => service('presentation', null)?.apply?.(...args);

    const DEFAULT_HOME_TAGLINE = '语义级打穿 AI、UI/UX、APP 与人类想象力的边界';
    const CANONICAL_UI_MODE = 'next';

    // 材质（磨砂）字段只为已保存数据的兼容而保留在引擎里；工作台不再暴露它们。
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
    const PROFILE_FIELDS = Object.freeze([
        'density',
        'toolPresentation',
        'toolExpansion',
        'radius',
        'typography',
        'fontScale',
        'contentWidth',
        'wallpaperScope',
        'sidebarRowHeight',
        'sidebarAvatarSize',
        'customRadius',
        'surface',
        'surfaceEffect',
        ...MATERIAL_FIELDS,
        'shellRadius',
        'composerRadius',
        'sidebarRadius',
        'cardRadius'
    ]);
    const THEME_MODES = new Set(['light', 'dark', 'system']);

    const BASE_PROFILE = Object.freeze({
        density: 'comfortable',
        radius: 'medium',
        typography: 'humanist',
        fontScale: 'normal',
        contentWidth: 'full',
        wallpaperScope: 'theme',
        toolPresentation: 'legacy',
        toolExpansion: 'attention',
        sidebarRowHeight: 46,
        sidebarAvatarSize: 32,
        customRadius: 10,
        surface: 'translucent',
        surfaceEffect: 'vibrancy',
        ...MATERIAL_DEFAULTS,
        shellRadius: 'tuned',
        composerRadius: 'tuned',
        sidebarRadius: 'tuned',
        cardRadius: 'tuned'
    });
    // 只留两套：默认（原版气泡 + 经典标题栏）与极简（胶囊标题栏 + 对话布局）。
    // 预设只切换结构（消息样式、标题栏），圆角、字体、密度等细节留给下面的分区自行调整。
    const makePreset = (name, icon, description, presentation, chatHeader) => Object.freeze({
        name,
        icon,
        description,
        presentation,
        messageWidth: 'normal',
        chatHeader,
        profile: BASE_PROFILE
    });
    const PRESETS = Object.freeze({
        balanced: makePreset('默认', 'layout_dashboard', '气泡消息 · 原版标题栏', 'bubble', 'classic'),
        minimal: makePreset('极简', 'pill', '对话布局 · 胶囊标题栏', 'messenger', 'capsule')
    });

    const DEFAULT_STATE = Object.freeze({
        themeMode: 'system',
        themeFileName: null,
        presentation: 'bubble',
        messageWidth: 'normal',
        chatHeader: 'classic',
        homeVisual: 'shown',
        homeTagline: 'shown',
        homeTaglineText: DEFAULT_HOME_TAGLINE,
        profile: BASE_PROFILE
    });
    const PROFILE_CONTROL_IDS = Object.freeze({
        density: 'appearanceDensity',
        toolPresentation: 'appearanceToolPresentation',
        toolExpansion: 'appearanceToolExpansion',
        radius: 'appearanceRadius',
        typography: 'appearanceTypography',
        fontScale: 'appearanceFontScale',
        contentWidth: 'appearanceContentWidth',
        wallpaperScope: 'appearanceWallpaperScope',
        sidebarRowHeight: 'appearanceSidebarRowHeight',
        sidebarAvatarSize: 'appearanceSidebarAvatarSize',
        sidebarRadius: 'appearanceSidebarRadius',
        customRadius: 'appearanceCustomRadius',
        surface: 'appearanceSurface'
    });
    const SUMMARY_LABELS = Object.freeze({
        density: Object.freeze({ compact: '紧凑', comfortable: '舒适', relaxed: '宽松' }),
        radius: Object.freeze({ square: '直角', small: '小圆角', medium: '中圆角', round: '大圆角', custom: '自定义圆角' }),
        typography: Object.freeze({ system: '系统字体', humanist: '人文字体', serif: '衬线字体' }),
        fontScale: Object.freeze({ small: '小字号', normal: '标准字号', large: '大字号' }),
        contentWidth: Object.freeze({ full: '全宽', centered: '居中' }),
        wallpaperScope: Object.freeze({ theme: '壁纸跟随主题', panel: '内容区壁纸', global: '全局壁纸' }),
        messageWidth: Object.freeze({ normal: '标准消息宽度', wide: '宽屏消息宽度' }),
        surface: Object.freeze({ solid: '纯色表面', translucent: '主题材质', custom: '自定义磨砂' }),
        toolPresentation: Object.freeze({ legacy: '原有卡片', compact: '紧凑单行', grouped: '分组折叠', inline: '单行合并', process: '整轮折叠' }),
        toolExpansion: Object.freeze({ attention: '仅异常', none: '全收起', all: '全展开' }),
        presentation: Object.freeze({ bubble: '气泡', panel: '面板', immersive: '沉浸', messenger: '对话' }),
        themeMode: Object.freeze({ light: '浅色', dark: '深色', system: '跟随系统' })
    });
    const DETAIL_RADIUS_FIELDS = Object.freeze([
        'sidebarRadius',
        'shellRadius',
        'composerRadius',
        'cardRadius'
    ]);
    const DETAIL_RADIUS_LABELS = Object.freeze({
        shellRadius: Object.freeze({ tuned: '原设计 · 14px', follow: '跟随全局', square: '直角 · 0px', small: '小圆角 · 8px', medium: '中圆角 · 12px', round: '大圆角 · 18px', custom: '自定义值' }),
        composerRadius: Object.freeze({ tuned: '原设计 · 24px', follow: '跟随全局', square: '直角 · 0px', small: '小圆角 · 12px', medium: '中圆角 · 18px', round: '大圆角 · 24px', custom: '自定义值' }),
        sidebarRadius: Object.freeze({ tuned: '原设计 · 10px', follow: '跟随全局', square: '直角 · 0px', small: '小圆角 · 6px', medium: '中圆角 · 10px', round: '大圆角 · 14px', custom: '自定义值' }),
        cardRadius: Object.freeze({ tuned: '原设计 · 8px', follow: '跟随全局', square: '直角 · 0px', small: '小圆角 · 6px', medium: '中圆角 · 8px', round: '大圆角 · 14px', custom: '自定义值' })
    });
    const DETAIL_RADIUS_NAMES = Object.freeze({
        sidebarRadius: '侧栏列表',
        shellRadius: '主面板',
        composerRadius: '输入框',
        cardRadius: '卡片与弹窗'
    });
    const SECTION_IDS = Object.freeze(['layout', 'tools', 'shape', 'type', 'home', 'theme']);

    let view = null;
    let viewScope = null;
    let viewScopeTeardown = Promise.resolve();
    let snapshot = null;
    let snapshotRevision = 0;
    let draft = null;
    let saving = false;
    let previewGeneration = 0;
    let installedThemes = [];
    let themesLoading = false;
    let themesLoadError = null;
    let themesLoadSequence = 0;
    let destroyed = false;
    let destroyPromise = null;
    let disposePromise = null;
    let pendingInitialState = null;
    let opener = null;
    // 展开状态在标签页重新打开之间保留；主题与配色默认折叠，布局默认展开。
    const openSections = new Set(['layout']);
    // 与 ZCode / DSH 一致：改动默认即时落盘；关掉后回到“预览 → 应用”两步。偏好只属于当前查看者。
    const AUTO_APPLY_KEY = 'vcp-appearance-studio-auto-apply';
    const AUTO_APPLY_DELAY_MS = 450;
    const readAutoApply = () => {
        try { return window.localStorage.getItem(AUTO_APPLY_KEY) !== '0'; } catch (_error) { return true; }
    };
    let autoApply = readAutoApply();
    let autoSaveTimer = null;
    let sessionStart = null;

    const clone = value => JSON.parse(JSON.stringify(value));
    const api = () => window.chatAPI || window.electronAPI;
    const toOps = (value, prefix = []) => Object.entries(value || {}).flatMap(([key, next]) => {
        const path = [...prefix, key];
        return next && typeof next === 'object' && !Array.isArray(next) ? toOps(next, path) : [{ op: 'set', path, value: next }];
    });
    const saveSettingsPatch = patch => api()?.saveSettings?.({ __vcpSettingsOps: toOps(patch) });
    function normalizeHomeTaglineText(value, fallback = DEFAULT_HOME_TAGLINE) {
        const normalized = typeof value === 'string' ? value.trim().slice(0, 120) : '';
        return normalized || fallback;
    }
    function applyHomeVisual(value) {
        const normalized = value === 'hidden' ? 'hidden' : 'shown';
        document.documentElement.dataset.vcpHomeVisual = normalized;
        return normalized;
    }
    function applyHomeTagline(visibility, textValue) {
        const tagline = document.getElementById('nextUiEmptyTagline');
        const visible = visibility !== 'hidden';
        const text = normalizeHomeTaglineText(textValue);
        document.documentElement.dataset.vcpHomeTagline = visible ? 'shown' : 'hidden';
        if (tagline) {
            tagline.textContent = text;
            tagline.hidden = !visible;
        }
        return { visibility: visible ? 'shown' : 'hidden', text };
    }
    const radiusDetailOptions = field => Object.entries(DETAIL_RADIUS_LABELS[field])
        .map(([value, label]) => `<option value="${value}">${label}</option>`)
        .join('');

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
        replaceSettings({ currentThemeMode: normalizedMode });
        getUiManager()?.applyTheme?.(effectiveTheme);
        if (persist) {
            if (normalizedMode === 'system') api()?.setThemeMode?.('system');
            else api()?.setTheme?.(normalizedMode);
        }
        syncAccountMenuValue();
        syncSettingsSummary();
        window.dispatchEvent(new CustomEvent('global-settings-updated', {
            detail: { settings: getSettings(), source }
        }));
        return true;
    }

    function readState() {
        const settings = getSettings();
        const themeMode = THEME_MODES.has(settings.currentThemeMode)
            ? settings.currentThemeMode
            : readEffectiveTheme();
        return {
            profile: getAppearance()?.normalize(settings.appearanceProfile, CANONICAL_UI_MODE)
                || clone(PRESETS.balanced.profile),
            presentation: getPresentationMode(settings.chatPresentationMode) || 'bubble',
            messageWidth: settings.enableWideChatLayout === true ? 'wide' : 'normal',
            chatHeader: settings.chatHeaderStyle === 'capsule' ? 'capsule' : 'classic',
            homeVisual: settings.showHomeVisualBrand === false ? 'hidden' : 'shown',
            homeTagline: settings.showHomeVisualTagline === false ? 'hidden' : 'shown',
            homeTaglineText: normalizeHomeTaglineText(settings.homeVisualTagline),
            themeMode,
            themeFileName: null
        };
    }

    function normalizeState(state, fallback = readState()) {
        const source = state && typeof state === 'object' ? state : {};
        const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_STATE;
        const themeMode = THEME_MODES.has(source.themeMode) ? source.themeMode : base.themeMode;
        const themeFileName = typeof source.themeFileName === 'string'
            ? source.themeFileName
            : (typeof base.themeFileName === 'string' ? base.themeFileName : null);
        return {
            profile: getAppearance()?.normalize(source.profile || base.profile, CANONICAL_UI_MODE)
                || clone(base.profile),
            presentation: getPresentationMode(source.presentation || base.presentation)
                || base.presentation,
            messageWidth: source.messageWidth === 'wide' || source.messageWidth === 'normal'
                ? source.messageWidth
                : (base.messageWidth === 'wide' ? 'wide' : 'normal'),
            chatHeader: source.chatHeader === 'capsule' || source.chatHeader === 'classic'
                ? source.chatHeader
                : (base.chatHeader === 'capsule' ? 'capsule' : 'classic'),
            homeVisual: source.homeVisual === 'hidden' || source.homeVisual === 'shown'
                ? source.homeVisual
                : (base.homeVisual === 'hidden' ? 'hidden' : 'shown'),
            homeTagline: source.homeTagline === 'hidden' || source.homeTagline === 'shown'
                ? source.homeTagline
                : (base.homeTagline === 'hidden' ? 'hidden' : 'shown'),
            homeTaglineText: normalizeHomeTaglineText(source.homeTaglineText, base.homeTaglineText),
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
        return normalizeState({
            profile,
            presentation: document.querySelector('input[name="chatPresentationMode"]:checked')?.value
                || base.presentation,
            messageWidth: document.getElementById('chatLayoutModeWide')?.checked ? 'wide' : 'normal',
            chatHeader: base.chatHeader,
            homeVisual: document.getElementById('showHomeVisualBrand')?.checked === false ? 'hidden' : 'shown',
            homeTagline: document.getElementById('showHomeVisualTagline')?.checked === false ? 'hidden' : 'shown',
            homeTaglineText: normalizeHomeTaglineText(document.getElementById('homeVisualTagline')?.value, base.homeTaglineText),
            themeMode: base.themeMode
        }, base);
    }

    // 预设、引擎归一化与表单读出的字段顺序各不相同，比较时按键排序。
    const stableStringify = value => JSON.stringify(value, (_key, next) => (
        next && typeof next === 'object' && !Array.isArray(next)
            ? Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : next
    ));

    function statesEqual(left, right) {
        return Boolean(left && right && stableStringify(left) === stableStringify(right));
    }

    function matchingPreset(state) {
        if (!state) return null;
        return Object.entries(PRESETS).find(([, preset]) => {
            return preset.presentation === state.presentation && preset.chatHeader === state.chatHeader;
        })?.[0] || null;
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
                SUMMARY_LABELS.themeMode[state.themeMode],
                SUMMARY_LABELS.typography[state.profile.typography],
                SUMMARY_LABELS.contentWidth[state.profile.contentWidth],
                SUMMARY_LABELS.wallpaperScope[state.profile.wallpaperScope],
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
        }
    }

    // 侧栏头像不再有工作台控件：它跟随列表项高度自动取值，保证始终留有安全内边距。
    function automaticSidebarAvatarSize(rowHeight) {
        return Math.min(44, Math.max(24, rowHeight - 14));
    }

    function syncSettingsGeometryControls(changedId = null) {
        const rowControl = document.getElementById('appearanceSidebarRowHeight');
        const avatarControl = document.getElementById('appearanceSidebarAvatarSize');
        if (!rowControl || !avatarControl) return;
        const previousRowHeight = Number(rowControl.dataset.previousValue) || Number(rowControl.value) || 46;
        const rowHeight = Math.min(64, Math.max(38, Math.round(Number(rowControl.value) || 46)));
        let avatarSize = Math.round(Number(avatarControl.value) || 32);
        if (changedId === 'appearanceSidebarRowHeight'
            && avatarSize === automaticSidebarAvatarSize(previousRowHeight)) {
            avatarSize = automaticSidebarAvatarSize(rowHeight);
        }
        const avatarMaximum = Math.min(52, rowHeight - 4);
        avatarSize = Math.min(avatarMaximum, Math.max(20, avatarSize));
        rowControl.value = String(rowHeight);
        rowControl.dataset.previousValue = String(rowHeight);
        avatarControl.max = String(avatarMaximum);
        avatarControl.value = String(avatarSize);
        window.VCPUI?.getController?.(avatarControl)?.update({
            max: avatarMaximum,
            value: avatarSize
        });
        const rowOutput = document.getElementById('appearanceSidebarRowHeightValue');
        const avatarOutput = document.getElementById('appearanceSidebarAvatarSizeValue');
        if (rowOutput) rowOutput.value = `${rowHeight}px`;
        if (avatarOutput) avatarOutput.value = `${avatarSize}px`;
        const customRadiusControl = document.getElementById('appearanceCustomRadius');
        const customRadiusOutput = document.getElementById('appearanceCustomRadiusValue');
        if (customRadiusControl && customRadiusOutput) {
            const customRadius = Math.min(32, Math.max(0, Math.round(Number(customRadiusControl.value) || 0)));
            customRadiusControl.value = String(customRadius);
            customRadiusOutput.value = `${customRadius}px`;
            window.VCPUI?.getController?.(customRadiusControl)?.update({ value: customRadius });
        }
        const sidebarRadiusControl = document.getElementById('appearanceSidebarRadius');
        const sidebarRadiusChoice = document.getElementById(
            `appearanceSidebarRadiusChoice-${sidebarRadiusControl?.value || 'tuned'}`
        );
        if (sidebarRadiusChoice) sidebarRadiusChoice.checked = true;
    }

    function bindSettingsSummary() {
        const card = document.getElementById('appearanceSettingsWorkbenchCard');
        const form = document.getElementById('globalSettingsForm');
        const trigger = document.getElementById('openAppearanceStudioFromSettings');
        if (!card || !form || !trigger) return;
        if (!card.dataset.appearanceSummaryBound) {
            const bindSummary = (target, type, handler, options) => moduleScope
                ? moduleScope.listen(target, type, handler, options, `appearance-settings-summary:${type}`)
                : target.addEventListener(type, handler, options);
            bindSummary(form, 'change', event => {
                if (event.target.matches('input[name="appearanceSidebarRadiusChoice"]')) {
                    const compatibilityControl = document.getElementById('appearanceSidebarRadius');
                    if (compatibilityControl) compatibilityControl.value = event.target.value;
                }
                if (event.target.matches('[id^="appearance"], #showHomeVisualBrand, #showHomeVisualTagline, #homeVisualTagline, input[name="chatPresentationMode"]')) {
                    syncSettingsSummary();
                }
            });
            // 回填快照（applySettings）写值只派发不冒泡的 vcp-uiux-sync；
            // 若快照回填落在开模态的 rAF 绑定同步之后，摘要会滞留 base
            // 默认文案且再无事件兜底。捕获监听能在祖先上收到不冒泡事件，
            // 使回填写值后的摘要无条件重同步（消除开模态竞态）。
            bindSummary(form, 'vcp-uiux-sync', event => {
                if (event.target.matches?.('[id^="appearance"], #showHomeVisualBrand, #showHomeVisualTagline, #homeVisualTagline, input[name="chatPresentationMode"]')) {
                    syncSettingsSummary();
                }
            }, true);
            bindSummary(form, 'input', event => {
                if (event.target.id === 'appearanceCustomRadius') {
                    const output = document.getElementById('appearanceCustomRadiusValue');
                    if (output) output.value = `${event.target.value}px`;
                    return;
                }
                if (!['appearanceSidebarRowHeight', 'appearanceSidebarAvatarSize'].includes(event.target.id)) return;
                syncSettingsGeometryControls(event.target.id);
            });
            bindSummary(trigger, 'click', () => {
                // 工作台现在是侧栏标签页：先收起盖在最上层的设置弹窗，再把表单里的当前值带过去预览。
                const initialState = readSettingsFormState();
                service('uiHelper', () => window.uiHelperFunctions)?.closeModal?.('globalSettingsModal');
                open({ trigger, initialState });
            });
            card.dataset.appearanceSummaryBound = 'true';
            moduleScope?.own(() => {
                delete card.dataset.appearanceSummaryBound;
            }, 'appearance-settings-summary-marker', 'dom-state');
        }
        syncSettingsGeometryControls();
        syncSettingsSummary();
    }

    // ------------------------------------------------------------------
    // 视图（侧栏标签页内的工作台）
    // ------------------------------------------------------------------

    const segmented = (key, label, options, extra = '') => `
        <div class="side-appearance-row" data-row="${key}">
            <span class="side-appearance-row-label">${label}</span>
            <div class="side-appearance-seg" role="group" aria-label="${label}">
                ${options.map(([value, text]) => `<button type="button" data-appearance-key="${key}" data-appearance-value="${value}">${text}</button>`).join('')}
            </div>
            ${extra}
        </div>`;
    // 工具呈现：每种样式画一个小示意（行 = 一次工具调用），让人直接看到效果而不是只读名字。
    const TOOL_STYLE_CHOICES = Object.freeze([
        ['legacy', '原有卡片', '每次调用一张卡片', '<b class="tm-card"><i></i><s></s><s></s></b><b class="tm-card"><i></i><s></s></b>'],
        ['compact', '紧凑单行', '每次调用压成一行', '<b class="tm-row"><i></i><s></s><em></em></b><b class="tm-row"><i></i><s></s><em></em></b><b class="tm-row"><i></i><s></s><em></em></b>'],
        ['grouped', '分组折叠', '同批调用收进分组', '<b class="tm-group"><i></i><s></s><em></em></b><b class="tm-row tm-nest"><i></i><s></s></b><b class="tm-row tm-nest"><i></i><s></s></b>'],
        ['inline', '单行合并', '多次调用并排一行', '<b class="tm-chips"><u></u><u></u><u></u><u></u></b>'],
        ['process', '整轮折叠', '整轮工具只留一行', '<b class="tm-group"><i></i><s></s><em></em></b>']
    ]);
    const toolStyleCards = () => `
        <div class="side-appearance-choices" role="group" aria-label="展示样式" data-row="toolPresentation">
            ${TOOL_STYLE_CHOICES.map(([value, title, desc, mock]) => `
                <button type="button" class="side-appearance-choice" data-appearance-key="toolPresentation" data-appearance-value="${value}">
                    <span class="side-appearance-choice-mock" data-tool-kind="${value}" aria-hidden="true">${mock}</span>
                    <span class="side-appearance-choice-name">${title}</span>
                    <span class="side-appearance-choice-desc">${desc}</span>
                </button>`).join('')}
        </div>`;
    const rangeRow = (key, label, min, max, unit) => `
        <label class="side-appearance-row side-appearance-range-row" data-row="${key}">
            <span class="side-appearance-row-label">${label}</span>
            <span class="side-appearance-range">
                <input type="range" min="${min}" max="${max}" step="1" data-appearance-key="${key}" aria-label="${label}">
                <output data-appearance-output="${key}" data-unit="${unit}"></output>
            </span>
        </label>`;
    const section = (id, icon, title, bodyHtml) => `
        <details class="side-appearance-section" data-section="${id}">
            <summary>
                <span class="vcp-ui-icon side-appearance-section-icon" aria-hidden="true">${icon}</span>
                <span class="side-appearance-section-title">${title}</span>
                <span class="side-appearance-section-summary" data-section-summary="${id}"></span>
                <span class="vcp-ui-icon side-appearance-section-chevron" aria-hidden="true">expand_more</span>
            </summary>
            <div class="side-appearance-section-body">${bodyHtml}</div>
        </details>`;

    function presetTile(id, preset) {
        return `
            <button type="button" class="side-appearance-preset" data-appearance-preset="${id}" aria-pressed="false">
                <span class="side-appearance-preset-mock" data-presentation="${preset.presentation}" data-header="${preset.chatHeader}" aria-hidden="true">
                    <u></u><i></i><i></i><b></b>
                </span>
                <span class="side-appearance-preset-name">${preset.name}</span>
                <span class="side-appearance-preset-desc">${preset.description}</span>
                <span class="vcp-ui-icon side-appearance-preset-check" aria-hidden="true">check</span>
            </button>`;
    }

    function buildViewHtml() {
        const layoutBody = [
            segmented('presentation', '消息样式', [['bubble', '气泡'], ['panel', '面板'], ['immersive', '沉浸'], ['messenger', '对话']]),
            segmented('contentWidth', '阅读区', [['full', '全宽'], ['centered', '居中']]),
            segmented('messageWidth', '消息宽度', [['normal', '标准'], ['wide', '宽屏']]),
            segmented('chatHeader', '标题栏', [['classic', '原版'], ['capsule', '胶囊']]),
            segmented('density', '界面密度', [['compact', '紧凑'], ['comfortable', '舒适'], ['relaxed', '宽松']])
        ].join('');
        const toolsBody = [
            toolStyleCards(),
            segmented('toolExpansion', '默认展开', [['attention', '仅异常'], ['none', '全收起'], ['all', '全展开']]),
            '<p class="side-appearance-hint">仅异常：失败或等待确认的调用自动展开，其余收起。</p>'
        ].join('');
        const shapeBody = [
            segmented('radius', '全局圆角', [['square', '直角'], ['small', '小'], ['medium', '中'], ['round', '大'], ['custom', '自定义']]),
            rangeRow('customRadius', '自定义圆角', 0, 32, 'px'),
            rangeRow('sidebarRowHeight', '侧栏行高', 38, 64, 'px'),
            segmented('surface', '导航表面', [['translucent', '主题'], ['solid', '纯色']]),
            `<details class="side-appearance-subdetails" data-radius-details>
                <summary><span>分别设置圆角</span><span class="side-appearance-section-summary" data-radius-details-status>使用全局</span></summary>
                <div class="side-appearance-subdetails-body">
                    ${DETAIL_RADIUS_FIELDS.map(field => `
                        <label class="side-appearance-row">
                            <span class="side-appearance-row-label">${DETAIL_RADIUS_NAMES[field]}</span>
                            <select data-appearance-key="${field}" aria-label="${DETAIL_RADIUS_NAMES[field]}圆角">${radiusDetailOptions(field)}</select>
                        </label>`).join('')}
                </div>
            </details>`
        ].join('');
        const typeBody = [
            segmented('typography', '字形', [['system', '系统'], ['humanist', '人文'], ['serif', '衬线']]),
            segmented('fontScale', '字号', [['small', '小'], ['normal', '标准'], ['large', '大']])
        ].join('');
        const homeBody = [
            segmented('wallpaperScope', '壁纸范围', [['theme', '跟随主题'], ['panel', '内容区'], ['global', '全局']]),
            segmented('homeVisual', '首页标识', [['shown', '显示'], ['hidden', '隐藏']]),
            segmented('homeTagline', '首页寄语', [['shown', '显示'], ['hidden', '隐藏']]),
            `<input class="side-appearance-text" type="text" maxlength="120" data-home-tagline-input
                aria-label="首页寄语内容" value="${DEFAULT_HOME_TAGLINE}">`
        ].join('');
        const themeBody = `
            ${segmented('themeMode', '显示模式', [['system', '系统'], ['light', '浅色'], ['dark', '深色']])}
            <div class="side-appearance-palette-head">
                <span class="side-appearance-row-label">配色主题 <small data-theme-load-state>正在读取主题…</small></span>
                <button type="button" class="side-appearance-link" data-studio-action="themes">
                    <span class="vcp-ui-icon" aria-hidden="true">palette</span><span>管理</span>
                </button>
            </div>
            <div class="side-appearance-palette" data-theme-palette-grid aria-live="polite"></div>`;

        return `
            <div class="side-appearance-scroll">
                <header class="side-appearance-head">
                    <div class="side-appearance-head-copy">
                        <h2>外观与布局</h2>
                        <p data-current-preset>自定义</p>
                    </div>
                    <span class="side-appearance-state" data-studio-status>已同步</span>
                </header>
                <section class="side-appearance-presets" aria-label="快速预设">
                    <div class="side-appearance-preset-grid">
                        ${Object.entries(PRESETS).map(([id, preset]) => presetTile(id, preset)).join('')}
                    </div>
                </section>
                ${section('layout', 'view_agenda', '布局', layoutBody)}
                ${section('tools', 'build', '工具呈现', toolsBody)}
                ${section('shape', 'rounded_corner', '形状与尺寸', shapeBody)}
                ${section('type', 'text_fields', '字体', typeBody)}
                ${section('home', 'home', '首页与壁纸', homeBody)}
                ${section('theme', 'palette', '主题与配色', themeBody)}
                <button type="button" class="side-appearance-more" data-studio-action="settings">
                    <span class="vcp-ui-icon" aria-hidden="true">settings</span><span>完整设置</span>
                    <span class="vcp-ui-icon" aria-hidden="true">chevron_right</span>
                </button>
            </div>
            <footer class="side-appearance-footer">
                <button type="button" class="side-appearance-btn side-appearance-btn-ghost" data-reset-all title="恢复默认外观">
                    <span class="vcp-ui-icon" aria-hidden="true">restore</span><span>恢复默认</span>
                </button>
                <button type="button" class="side-appearance-btn side-appearance-btn-ghost side-appearance-auto" data-studio-auto aria-pressed="true" title="改动后自动应用">
                    <span class="vcp-ui-icon" aria-hidden="true">bolt</span><span>实时</span>
                </button>
                <span class="side-appearance-footer-spacer"></span>
                <button type="button" class="side-appearance-btn" data-studio-revert>还原</button>
                <button type="button" class="side-appearance-btn side-appearance-btn-primary" data-studio-save>
                    <span class="vcp-ui-icon" aria-hidden="true">check</span><span>应用</span>
                </button>
            </footer>`;
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
        if (!view) return;
        const grid = view.themeGrid;
        grid.replaceChildren();
        view.themeLoadState.textContent = themesLoading
            ? '正在读取主题…'
            : themesLoadError || (installedThemes.length ? `${installedThemes.length} 款已安装` : '暂无可用主题');
        if (themesLoading) {
            view.themePreviewStyle.textContent = '';
            for (let index = 0; index < 6; index += 1) {
                const skeleton = document.createElement('span');
                skeleton.className = 'side-appearance-theme-skeleton';
                skeleton.setAttribute('aria-hidden', 'true');
                grid.append(skeleton);
            }
            return;
        }
        installedThemes.forEach((theme, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'side-appearance-theme';
            button.dataset.themeFileName = theme.fileName;
            button.dataset.themePreviewIndex = String(index);
            button.title = theme.name;
            button.innerHTML = `
                <span class="side-appearance-theme-preview" aria-hidden="true">
                    <i></i><i></i><i></i>
                    <span class="vcp-ui-icon">check</span>
                </span>
                <span class="side-appearance-theme-name"></span>`;
            button.querySelector('.side-appearance-theme-name').textContent = theme.name;
            grid.append(button);
        });
        syncThemePaletteColors();
        syncThemePaletteSelection();
    }

    function syncThemePaletteColors() {
        if (!view) return;
        view.themePreviewStyle.textContent = installedThemes.map((theme, index) => {
            const [primary, accent, secondary] = themePreviewColors(theme);
            return `[data-theme-preview-index="${index}"]{--theme-preview-primary:${primary};--theme-preview-accent:${accent};--theme-preview-secondary:${secondary}}`;
        }).join('');
    }

    function syncThemePaletteSelection() {
        if (!view || !draft) return;
        view.themeGrid.querySelectorAll('[data-theme-file-name]').forEach(button => {
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
            link.addEventListener('load', () => {
                if (draft?.profile.wallpaperScope === 'theme') {
                    getAppearance()?.refreshWallpaperScope?.({ source: 'appearance-theme-preview' });
                }
            });
            document.head.append(link);
        }
        link.href = new URL(`styles/themes/${encodeURIComponent(fileName)}`, document.baseURI).href;
    }

    async function loadThemes() {
        if (!view) return;
        const sequence = ++themesLoadSequence;
        themesLoading = true;
        themesLoadError = null;
        renderThemePalette();
        try {
            const tasks = window.VCPTasks;
            const ownerScope = viewScope;
            const themeTask = api()?.getThemes && tasks?.createTask?.({
                id: tasks.createTaskId?.('appearance-themes') || `appearance-themes:${Date.now()}`,
                start: () => api().getThemes(),
            });
            const themes = themeTask && ownerScope
                ? await themeTask.own(ownerScope, 'appearance-theme-list')
                : await api()?.getThemes?.();
            if (sequence !== themesLoadSequence || !view) return;
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
            if (sequence === themesLoadSequence && view) {
                themesLoading = false;
                renderThemePalette();
                syncControls();
            }
        }
    }

    function setBusy(nextBusy) {
        saving = nextBusy;
        if (!view) return;
        view.root.toggleAttribute('data-saving', nextBusy);
        view.root.querySelectorAll('button, input, select').forEach(control => {
            control.disabled = nextBusy || (control === view.saveButton && statesEqual(snapshot, draft));
        });
    }

    function sectionSummary(id) {
        const profile = draft.profile;
        const activeTheme = installedThemes.find(theme => theme.fileName === draft.themeFileName)?.name;
        switch (id) {
            case 'layout':
                return `${SUMMARY_LABELS.presentation[draft.presentation]} · ${SUMMARY_LABELS.contentWidth[profile.contentWidth]}`;
            case 'tools':
                return `${SUMMARY_LABELS.toolPresentation[profile.toolPresentation] || '原有卡片'} · ${SUMMARY_LABELS.toolExpansion[profile.toolExpansion] || '仅异常'}`;
            case 'shape':
                return `${SUMMARY_LABELS.radius[profile.radius]} · ${SUMMARY_LABELS.density[profile.density]}`;
            case 'type':
                return `${SUMMARY_LABELS.typography[profile.typography]} · ${SUMMARY_LABELS.fontScale[profile.fontScale]}`;
            case 'home':
                return draft.homeVisual === 'hidden' ? '首页标识已隐藏' : SUMMARY_LABELS.wallpaperScope[profile.wallpaperScope];
            case 'theme':
                return [SUMMARY_LABELS.themeMode[draft.themeMode], activeTheme].filter(Boolean).join(' · ');
            default:
                return '';
        }
    }

    function syncControls() {
        if (!view || !draft) return;
        const taglineInput = view.root.querySelector('[data-home-tagline-input]');
        if (taglineInput && taglineInput.value !== draft.homeTaglineText && document.activeElement !== taglineInput) {
            taglineInput.value = draft.homeTaglineText;
        }
        view.root.querySelectorAll('[data-appearance-key]').forEach(control => {
            const { appearanceKey: key, appearanceValue: value } = control.dataset;
            const current = PROFILE_FIELDS.includes(key) ? draft.profile[key] : draft[key];
            if (control.matches('select')) {
                control.value = current;
                return;
            }
            if (control.matches('input[type="range"]')) {
                control.value = String(current);
                window.VCPUI?.getController?.(control)?.update({ value: current });
                const output = view.root.querySelector(`[data-appearance-output="${key}"]`);
                if (output) output.textContent = `${current}${output.dataset.unit || ''}`;
                return;
            }
            const active = current === value;
            control.classList.toggle('active', active);
            control.setAttribute('aria-pressed', String(active));
        });
        // 自定义圆角滑块只在选中“自定义”或有细节项取自定义值时才有意义。
        const customRadiusVisible = draft.profile.radius === 'custom'
            || DETAIL_RADIUS_FIELDS.some(field => draft.profile[field] === 'custom');
        const customRadiusRow = view.root.querySelector('[data-row="customRadius"]');
        if (customRadiusRow) customRadiusRow.hidden = !customRadiusVisible;
        syncThemePaletteSelection();
        syncThemePaletteColors();
        const activePreset = matchingPreset(draft);
        view.root.querySelectorAll('[data-appearance-preset]').forEach(button => {
            const active = button.dataset.appearancePreset === activePreset;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        view.currentPreset.textContent = activePreset ? PRESETS[activePreset].name : '自定义';
        const changed = !statesEqual(snapshot, draft);
        view.status.textContent = autoSaveTimer ? '即将应用…' : (changed ? '预览中 · 未应用' : '已同步');
        view.status.classList.toggle('is-dirty', changed);
        view.saveButton.disabled = saving || !changed;
        view.revertButton.disabled = saving || statesEqual(revertTarget(), draft);
        view.revertButton.title = autoApply ? '还原到打开时的外观' : '放弃未应用的预览';
        view.autoButton.classList.toggle('active', autoApply);
        view.autoButton.setAttribute('aria-pressed', String(autoApply));
        SECTION_IDS.forEach(id => {
            const target = view.root.querySelector(`[data-section-summary="${id}"]`);
            if (target) target.textContent = sectionSummary(id);
        });
        const customDetailCount = DETAIL_RADIUS_FIELDS.filter(field => !['tuned', 'follow'].includes(draft.profile[field])).length;
        const followCount = DETAIL_RADIUS_FIELDS.filter(field => draft.profile[field] === 'follow').length;
        const detailStatus = view.root.querySelector('[data-radius-details-status]');
        if (detailStatus) {
            detailStatus.textContent = customDetailCount
                ? `${customDetailCount} 项独立`
                : (followCount === DETAIL_RADIUS_FIELDS.length ? '全部跟随全局' : '使用原设计');
        }
    }

    async function preview(options = {}) {
        if (!draft) return;
        const generation = ++previewGeneration;
        if (generation !== previewGeneration || !draft) return;
        getAppearance()?.apply(draft.profile, {
            uiMode: CANONICAL_UI_MODE,
            cache: false,
            source: 'appearance-studio-preview'
        });
        document.body.classList.toggle('chat-wide-layout', draft.messageWidth === 'wide');
        window.vcpChatHeader?.apply?.(draft.chatHeader);
        applyHomeVisual(draft.homeVisual);
        applyHomeTagline(draft.homeTagline, draft.homeTaglineText);
        if (!options.appearanceOnly) {
            getUiManager()?.applyTheme?.(effectiveThemeForMode(draft.themeMode));
            previewThemeFile(draft.themeFileName);
            await applyPresentation(draft.presentation, {
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
        previewGeneration += 1;
        if ((getAppearance()?.getRevision?.() || 0) !== snapshotRevision) return;
        removeThemePreview();
        getAppearance()?.apply(snapshot.profile, {
            uiMode: CANONICAL_UI_MODE,
            cache: false,
            source: 'appearance-studio-rollback'
        });
        document.body.classList.toggle('chat-wide-layout', snapshot.messageWidth === 'wide');
        window.vcpChatHeader?.apply?.(snapshot.chatHeader);
        applyHomeVisual(snapshot.homeVisual);
        applyHomeTagline(snapshot.homeTagline, snapshot.homeTaglineText);
        getUiManager()?.applyTheme?.(effectiveThemeForMode(snapshot.themeMode));
        await applyPresentation(snapshot.presentation, {
            persist: false,
            preserveScroll: true,
            notify: false,
            source: 'appearance-studio-rollback'
        });
    }

    function syncSettingsControls() {
        if (!draft) return;
        const homeVisual = document.getElementById('showHomeVisualBrand');
        if (homeVisual) homeVisual.checked = draft.homeVisual !== 'hidden';
        const homeTagline = document.getElementById('showHomeVisualTagline');
        if (homeTagline) homeTagline.checked = draft.homeTagline !== 'hidden';
        const homeTaglineText = document.getElementById('homeVisualTagline');
        if (homeTaglineText) homeTaglineText.value = draft.homeTaglineText;
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
        syncSettingsGeometryControls();
    }

    async function save() {
        if (!draft || saving || statesEqual(snapshot, draft)) return;
        setBusy(true);
        previewGeneration += 1;
        const nextState = clone(draft);
        const persistedSnapshot = snapshot ? {
            appearanceProfile: snapshot.profile,
            chatPresentationMode: snapshot.presentation,
            enableWideChatLayout: snapshot.messageWidth === 'wide',
            chatHeaderStyle: snapshot.chatHeader,
            showHomeVisualBrand: snapshot.homeVisual !== 'hidden',
            showHomeVisualTagline: snapshot.homeTagline !== 'hidden',
            homeVisualTagline: snapshot.homeTaglineText,
            currentThemeMode: snapshot.themeMode
        } : null;
        let settingsPersisted = false;
        try {
            const result = await saveSettingsPatch({
                appearanceProfile: nextState.profile,
                chatPresentationMode: nextState.presentation,
                enableWideChatLayout: nextState.messageWidth === 'wide',
                chatHeaderStyle: nextState.chatHeader,
                showHomeVisualBrand: nextState.homeVisual !== 'hidden',
                showHomeVisualTagline: nextState.homeTagline !== 'hidden',
                homeVisualTagline: nextState.homeTaglineText,
                currentThemeMode: nextState.themeMode
            });
            if (!result?.success) throw new Error(result?.error || '设置保存失败');
            settingsPersisted = true;

            replaceSettings({
                appearanceProfile: nextState.profile,
                chatPresentationMode: nextState.presentation,
                enableWideChatLayout: nextState.messageWidth === 'wide',
                chatHeaderStyle: nextState.chatHeader,
                showHomeVisualBrand: nextState.homeVisual !== 'hidden',
                showHomeVisualTagline: nextState.homeTagline !== 'hidden',
                homeVisualTagline: nextState.homeTaglineText,
                currentThemeMode: nextState.themeMode
            });
            await applyPresentation(nextState.presentation, {
                persist: false,
                preserveScroll: true,
                notify: false,
                source: 'appearance-studio-save'
            });
            // Commit the appearance revision only after all fallible local
            // projections have succeeded. Otherwise rollback mistakes our
            // own partial commit for a newer external settings revision.
            getAppearance()?.commit(nextState.profile, {
                uiMode: CANONICAL_UI_MODE,
                source: 'appearance-studio-save'
            });
            if (nextState.themeMode === 'system') {
                api()?.setThemeMode?.('system');
                getUiManager()?.applyTheme?.(effectiveThemeForMode('system'));
            } else {
                api()?.setTheme?.(nextState.themeMode);
                getUiManager()?.applyTheme?.(nextState.themeMode);
            }
            if (nextState.themeFileName && nextState.themeFileName !== snapshot.themeFileName) {
                api()?.applyTheme?.(nextState.themeFileName);
            }
            syncSettingsControls();
            snapshot = clone(nextState);
            snapshotRevision = getAppearance()?.getRevision?.() || snapshotRevision;
            syncAccountMenuValue(nextState);
            window.dispatchEvent(new CustomEvent('global-settings-updated', {
                detail: { settings: getSettings(), source: 'appearance-studio' }
            }));
            service('uiHelper', () => window.uiHelperFunctions)?.showToastNotification?.('外观与布局已应用。', 'success');
        } catch (error) {
            if (settingsPersisted && persistedSnapshot) {
                try {
                    const rollbackResult = await saveSettingsPatch(persistedSnapshot);
                    if (!rollbackResult?.success) throw new Error(rollbackResult?.error || '设置回写失败');
                } catch (rollbackError) {
                    console.error('[AppearanceStudio] Failed to restore persisted settings:', rollbackError);
                    service('uiHelper', () => window.uiHelperFunctions)?.showToastNotification?.(
                        `外观保存失败，且磁盘设置恢复失败：${rollbackError.message}`,
                        'error'
                    );
                }
                replaceSettings({
                    ...persistedSnapshot,
                    appearanceProfile: clone(persistedSnapshot.appearanceProfile)
                });
            }
            await restoreSnapshot();
            if (snapshot) draft = clone(snapshot);
            syncControls();
            service('uiHelper', () => window.uiHelperFunctions)?.showToastNotification?.(`外观与布局保存失败：${error.message}`, 'error');
        } finally {
            setBusy(false);
            syncControls();
        }
    }

    // 即时应用时已保存的外观几乎总是最新的，“还原”要回到本次打开时的外观才有意义。
    function revertTarget() {
        return (autoApply && sessionStart) || snapshot;
    }

    function cancelAutoSave() {
        if (autoSaveTimer === null) return false;
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
        return true;
    }

    function scheduleAutoSave({ immediate = false } = {}) {
        cancelAutoSave();
        if (!autoApply || !view || !draft || statesEqual(snapshot, draft)) {
            syncControls();
            return;
        }
        autoSaveTimer = setTimeout(() => {
            autoSaveTimer = null;
            void save();
        }, immediate ? 0 : AUTO_APPLY_DELAY_MS);
        syncControls();
    }

    function setAutoApply(next) {
        autoApply = next;
        try { window.localStorage.setItem(AUTO_APPLY_KEY, next ? '1' : '0'); } catch (_error) { /* 偏好无法落盘时只在本次有效 */ }
        if (next) scheduleAutoSave({ immediate: true });
        else cancelAutoSave();
        syncControls();
    }

    async function revertDraft() {
        const target = revertTarget();
        if (!draft || !target || saving) return;
        cancelAutoSave();
        draft = clone(target);
        await preview();
        scheduleAutoSave({ immediate: true });
    }

    // 开始一次编辑会话：以当前已保存的外观为快照，可选地带入外部给定的初始草稿。
    function beginSession() {
        autoApply = readAutoApply();
        snapshot = readState();
        sessionStart = clone(snapshot);
        snapshotRevision = getAppearance()?.getRevision?.() || 0;
        draft = normalizeState(pendingInitialState, snapshot);
        pendingInitialState = null;
        if (statesEqual(snapshot, draft)) syncControls();
        else void preview();
        void loadThemes();
    }

    function mount(host, options = {}) {
        if (destroyed || !host) return null;
        if (view) disposeViewSync();
        viewScope = moduleScope?.child('next:appearance-studio-view') || null;

        const root = document.createElement('div');
        root.className = 'zc-scope vcp-ui-scope side-appearance-root';
        root.innerHTML = buildViewHtml();
        host.classList.add('side-appearance-view');
        host.append(root);
        viewScope?.own(() => {
            root.remove();
            host.classList.remove('side-appearance-view');
        }, 'appearance-root', 'dom');

        root.querySelectorAll('details.side-appearance-section').forEach(details => {
            details.open = openSections.has(details.dataset.section);
        });
        root.querySelectorAll('input[type="range"]').forEach(control => {
            if (window.VCPUI?.getController?.(control)) return;
            const controller = window.VCPUI?.enhance?.('Range', control);
            if (controller && viewScope) viewScope.own(() => controller.destroy(), 'appearance-range', 'ui-registration');
        });
        const themePreviewStyle = document.createElement('style');
        themePreviewStyle.dataset.appearanceThemeSwatches = 'true';
        root.append(themePreviewStyle);

        view = {
            root,
            host,
            onRequestClose: options.onRequestClose || null,
            status: root.querySelector('[data-studio-status]'),
            currentPreset: root.querySelector('[data-current-preset]'),
            saveButton: root.querySelector('[data-studio-save]'),
            revertButton: root.querySelector('[data-studio-revert]'),
            autoButton: root.querySelector('[data-studio-auto]'),
            themePreviewStyle,
            themeGrid: root.querySelector('[data-theme-palette-grid]'),
            themeLoadState: root.querySelector('[data-theme-load-state]')
        };

        const listen = (type, handler, capture) => viewScope
            ? viewScope.listen(root, type, handler, capture, `appearance:${type}`)
            : root.addEventListener(type, handler, capture);
        listen('click', handleClick);
        listen('change', handleChange);
        listen('input', handleInput);
        // details 的 toggle 事件不冒泡，用捕获记住各分组的展开状态。
        listen('toggle', event => {
            const details = event.target.closest?.('details.side-appearance-section');
            if (!details) return;
            if (details.open) openSections.add(details.dataset.section);
            else openSections.delete(details.dataset.section);
        }, true);

        beginSession();
        return {
            focus() { view?.root.querySelector('.side-appearance-scroll')?.focus?.({ preventScroll: true }); },
            dispose: () => disposeView({ rollback: true })
        };
    }

    function disposeViewSync() {
        const scope = viewScope;
        viewScope = null;
        const hadView = Boolean(view);
        view = null;
        themesLoadSequence += 1;
        themesLoading = false;
        viewScopeTeardown = scope ? scope.dispose('appearance-view-disposed') : Promise.resolve();
        return hadView;
    }

    // 关闭标签页时把还没“应用”的预览回滚到已保存的外观，避免预览态泄漏到整个界面。
    function disposeView({ rollback = true } = {}) {
        if (disposePromise) return disposePromise;
        if (!view) return Promise.resolve();
        disposePromise = (async () => {
            // 关闭时还在等待即时应用的改动属于用户，先落盘而不是当作未应用预览回滚。
            if (cancelAutoSave() && !saving) await save();
            const dirty = !statesEqual(snapshot, draft);
            try {
                if (rollback && dirty) await restoreSnapshot();
            } finally {
                removeThemePreview();
                snapshot = null;
                sessionStart = null;
                snapshotRevision = 0;
                draft = null;
                disposeViewSync();
                // 视图作用域的清理是异步的：等它移除 DOM 后标签页才算真正关闭。
                await viewScopeTeardown;
            }
        })().finally(() => { disposePromise = null; });
        return disposePromise;
    }

    function registerOpener(next) {
        opener = next && typeof next.open === 'function' ? next : null;
        return () => { if (opener === next) opener = null; };
    }

    function open(options = {}) {
        if (destroyed) return false;
        if (options.initialState) pendingInitialState = options.initialState;
        if (!opener) {
            service('uiHelper', () => window.uiHelperFunctions)?.showToastNotification?.('当前窗口不支持外观配置工作台', 'info');
            return false;
        }
        const applyPendingToLiveView = () => {
            // 标签页已经在编辑：把设置表单带来的当前值并入草稿即可，不重置会话。
            if (!view || !draft || !pendingInitialState) return;
            draft = normalizeState(pendingInitialState, draft);
            pendingInitialState = null;
            void preview();
        };
        Promise.resolve(opener.open(options)).then(applyPendingToLiveView).catch(error => {
            console.error('[AppearanceStudio] Failed to open the side pane tab:', error);
        });
        return true;
    }

    function close() {
        if (opener?.close) return Promise.resolve(opener.close());
        return disposeView({ rollback: true });
    }

    function applyPreset(presetId) {
        const preset = PRESETS[presetId];
        if (!preset || !draft) return Promise.resolve();
        draft = {
            // 预设不碰圆角、字体、密度与工具呈现等细节设置。
            profile: clone(draft.profile),
            presentation: preset.presentation,
            messageWidth: draft.messageWidth,
            chatHeader: preset.chatHeader,
            homeVisual: draft.homeVisual,
            homeTagline: draft.homeTagline,
            homeTaglineText: draft.homeTaglineText,
            themeMode: draft.themeMode,
            themeFileName: draft.themeFileName
        };
        return preview();
    }

    async function handleClick(event) {
        const target = event.target.closest('button');
        if (!target || saving || !draft) return;
        if (target.matches('[data-studio-save]')) {
            await save();
            return;
        }
        if (target.matches('[data-studio-revert]')) {
            await revertDraft();
            return;
        }
        if (target.matches('[data-studio-auto]')) {
            setAutoApply(!autoApply);
            return;
        }
        if (target.matches('[data-reset-all]')) {
            const themeFileName = draft.themeFileName;
            draft = { ...clone(DEFAULT_STATE), themeFileName };
            await preview();
            scheduleAutoSave();
            return;
        }
        const presetId = target.dataset.appearancePreset;
        if (presetId && PRESETS[presetId]) {
            await applyPreset(presetId);
            scheduleAutoSave();
            return;
        }
        const key = target.dataset.appearanceKey;
        const value = target.dataset.appearanceValue;
        if (key && value) {
            if (PROFILE_FIELDS.includes(key)) draft.profile[key] = value;
            else draft[key] = value;
            await preview();
            scheduleAutoSave();
            return;
        }
        const themeFileName = target.dataset.themeFileName;
        if (themeFileName && installedThemes.some(theme => theme.fileName === themeFileName)) {
            draft.themeFileName = themeFileName;
            await preview();
            scheduleAutoSave();
            return;
        }
        if (target.dataset.studioAction === 'themes') {
            api()?.openThemesWindow?.();
        } else if (target.dataset.studioAction === 'settings') {
            service('uiHelper', () => window.uiHelperFunctions)?.openModal?.('globalSettingsModal');
        }
    }

    async function handleChange(event) {
        const control = event.target.closest('select[data-appearance-key]');
        if (!control || saving || !draft) return;
        const key = control.dataset.appearanceKey;
        if (!PROFILE_FIELDS.includes(key)) return;
        draft.profile[key] = control.value;
        await preview({ appearanceOnly: true });
        scheduleAutoSave();
    }

    async function handleInput(event) {
        const taglineInput = event.target.closest('[data-home-tagline-input]');
        if (taglineInput && !saving && draft) {
            draft.homeTaglineText = normalizeHomeTaglineText(taglineInput.value, DEFAULT_HOME_TAGLINE);
            applyHomeTagline(draft.homeTagline, draft.homeTaglineText);
            syncControls();
            scheduleAutoSave();
            return;
        }
        const control = event.target.closest('input[data-appearance-key]');
        if (!control || saving || !draft) return;
        const key = control.dataset.appearanceKey;
        if (key === 'sidebarRowHeight') {
            const previousRowHeight = draft.profile.sidebarRowHeight;
            const nextRowHeight = Math.min(64, Math.max(38, Math.round(Number(control.value) || 46)));
            const previousAutoAvatar = automaticSidebarAvatarSize(previousRowHeight);
            draft.profile.sidebarRowHeight = nextRowHeight;
            // 头像大小不再单独调节：沿用自动值，用户在完整设置里自定义过的值则只做安全裁剪。
            if (draft.profile.sidebarAvatarSize === previousAutoAvatar) {
                draft.profile.sidebarAvatarSize = automaticSidebarAvatarSize(nextRowHeight);
            }
            draft.profile.sidebarAvatarSize = Math.min(draft.profile.sidebarAvatarSize, nextRowHeight - 4);
            try { await preview({ appearanceOnly: true }); } catch (error) { console.error('[AppearanceStudio] Preview failed while editing sidebar row height:', error); }
            scheduleAutoSave();
            return;
        }
        if (key === 'customRadius') {
            draft.profile.customRadius = Math.min(32, Math.max(0, Math.round(Number(control.value) || 0)));
            await preview({ appearanceOnly: true });
            scheduleAutoSave();
        }
    }

    const listenModule = (target, type, handler, options) => moduleScope
        ? moduleScope.listen(target, type, handler, options, `appearance-controller:${type}`)
        : target.addEventListener(type, handler, options);
    listenModule(window, 'global-settings-updated', event => {
        if (!draft) {
            const state = readState();
            applyHomeVisual(state.homeVisual);
            applyHomeTagline(state.homeTagline, state.homeTaglineText);
        } else if (view && !saving && event.detail?.source !== 'appearance-studio' && statesEqual(snapshot, draft)) {
            // 没有未应用的预览时，工作台跟随外部（账户菜单、完整设置）对外观的修改。
            const themeFileName = snapshot.themeFileName;
            snapshot = { ...readState(), themeFileName };
            snapshotRevision = getAppearance()?.getRevision?.() || snapshotRevision;
            sessionStart = clone(snapshot);
            draft = clone(snapshot);
            syncControls();
        }
        if (!view) syncAccountMenuValue();
        syncSettingsSummary();
    });
    listenModule(document, 'DOMContentLoaded', () => {
        const state = readState();
        applyHomeVisual(state.homeVisual);
        applyHomeTagline(state.homeTagline, state.homeTaglineText);
        syncAccountMenuValue();
        bindSettingsSummary();
    }, { once: true });
    listenModule(document, 'modal-ready', event => {
        if (event.detail?.modalId !== 'globalSettingsModal') return;
        if (moduleScope) moduleScope.animationFrame(bindSettingsSummary, 'bind-settings-summary');
        else requestAnimationFrame(bindSettingsSummary);
    });

    Object.defineProperty(window, 'VCPAppearanceStudio', { value: Object.freeze({
        PRESETS,
        open,
        close,
        mount,
        registerOpener,
        isOpen: () => Boolean(view),
        readState,
        syncAccountMenuValue,
        syncSettingsSummary,
        setThemeMode,
    }), writable: false, configurable: false });
})();
