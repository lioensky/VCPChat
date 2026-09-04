// M5-a 等价性金测：新 collectSettings（schema save 声明推导）与旧
// handleSaveGlobalSettings 手写收集器的载荷必须逐键等价。
// 旧收集器按 global-settings-manager.js 的载荷构造段逐行转写（含全部
// 特例语义：parseInt||fallback 的 0 兜底、气泡宽度现值钳位、checked!==false、
// URL 补全、allowed 白名单、slice/upper 等），作为冻结的黄金参照；
// 保存链切换提交后它就是 schema 值语义的契约文档。
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { schemaSurfaceSections } from '../modules/settings/schema-surface.js';
import { renderSchemaSection } from '../modules/settings/render/field-renderer.js';
import { collectSettings, clampBubbleWidthPercent } from '../modules/settings/value-semantics.js';

// —— 黄金参照：旧保存链载荷构造（逐行转写，勿"顺手修正"任何怪癖） —//
function legacyCollect({ doc, currentSettings, settingsManager, getAppearance, normalizeChatPresentationMode }) {
    const getElementById = id => doc.getElementById(id);

    const clampBubbleWidthPercent = (rawValue, fallback) => {
        const parsed = Number.parseInt(rawValue, 10);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(98, Math.max(50, parsed));
    };

    const networkNotesPathsContainer = getElementById('networkNotesPathsContainer');
    const pathInputs = networkNotesPathsContainer.querySelectorAll('input[name="networkNotesPath"]');
    const networkNotesPaths = Array.from(pathInputs).map(input => input.value.trim()).filter(path => path);

    const voiceMode = getElementById('voiceModeNetwork')?.checked ? 'network' : 'local';
    const allowedVoiceInputModes = new Set(['windows_voice_typing', 'right_alt_hold']);
    const selectedVoiceInputMode = getElementById('voiceInputMode')?.value;
    const voiceInputMode = allowedVoiceInputModes.has(selectedVoiceInputMode)
        ? selectedVoiceInputMode
        : 'windows_voice_typing';
    const voiceInputShortcut = (
        getElementById('voiceInputShortcut')?.value.trim()
        || 'F7'
    ).toUpperCase();
    const allowedStreamAnimationPresets = new Set(['slide-left', 'fade', 'rise', 'scale', 'none', 'custom']);
    const selectedStreamAnimationPreset = getElementById('streamAnimationPreset')?.value;
    const streamAnimationPreset = allowedStreamAnimationPresets.has(selectedStreamAnimationPreset)
        ? selectedStreamAnimationPreset
        : 'slide-left';
    const rawStreamAnimationDurationMs = Number(getElementById('streamAnimationDurationMs')?.value);
    const streamAnimationDurationMs = Number.isFinite(rawStreamAnimationDurationMs)
        ? Math.min(2000, Math.max(100, Math.round(rawStreamAnimationDurationMs / 50) * 50))
        : 500;
    const streamAnimationCustomCss = (getElementById('streamAnimationCustomCss')?.value || '').slice(0, 4000);

    const newSettings = {
        userName: getElementById('userName').value.trim() || '用户',
        userAvatarBorderColor: getElementById('userAvatarBorderColor')?.value || '#3d5a80',
        userNameTextColor: getElementById('userNameTextColor')?.value || '#ffffff',
        userUseThemeColorsInChat: getElementById('userUseThemeColorsInChat')?.checked || false,
        continueWritingPrompt: getElementById('continueWritingPrompt').value.trim() || '请继续',
        flowlockContinueDelay: parseInt(getElementById('flowlockContinueDelay').value, 10) || 5,
        enableMiddleClickQuickAction: getElementById('enableMiddleClickQuickAction').checked,
        middleClickQuickAction: getElementById('middleClickQuickAction').value,
        enableMiddleClickAdvanced: getElementById('enableMiddleClickAdvanced').checked,
        middleClickAdvancedDelay: Math.max(1000, parseInt(getElementById('middleClickAdvancedDelay').value, 10) || 1000),
        enableRegenerateConfirmation: getElementById('enableRegenerateConfirmation').checked,
        vcpServerUrl: settingsManager.completeVcpUrl(getElementById('vcpServerUrl').value.trim()),
        vcpApiKey: getElementById('vcpApiKey').value,
        fileKey: getElementById('fileKey')?.value || '',
        vcpLogUrl: getElementById('vcpLogUrl').value.trim(),
        vcpLogKey: getElementById('vcpLogKey').value.trim(),
        topicSummaryModel: getElementById('topicSummaryModel').value.trim(),
        networkNotesPaths: networkNotesPaths,
        sidebarWidth: currentSettings.sidebarWidth,
        notificationsSidebarWidth: currentSettings.notificationsSidebarWidth,
        enableSmoothStreaming: getElementById('enableSmoothStreaming').checked,
        streamAnimationPreset,
        streamAnimationDurationMs,
        streamAnimationCustomCss,
        showHomeVisualBrand: getElementById('showHomeVisualBrand')?.checked !== false,
        showHomeVisualTagline: getElementById('showHomeVisualTagline')?.checked !== false,
        homeVisualTagline: getElementById('homeVisualTagline')?.value.trim().slice(0, 120)
            || '语义级打穿 AI、UI/UX、APP 与人类想象力的边界',
        appearanceProfile: getAppearance()?.normalize({
            density: getElementById('appearanceDensity')?.value,
            radius: getElementById('appearanceRadius')?.value,
            typography: getElementById('appearanceTypography')?.value,
            fontScale: getElementById('appearanceFontScale')?.value,
            contentWidth: getElementById('appearanceContentWidth')?.value,
            wallpaperScope: getElementById('appearanceWallpaperScope')?.value
                || currentSettings.appearanceProfile?.wallpaperScope
                || 'theme',
            sidebarRowHeight: Number(getElementById('appearanceSidebarRowHeight')?.value)
                || currentSettings.appearanceProfile?.sidebarRowHeight
                || 46,
            sidebarAvatarSize: Number(getElementById('appearanceSidebarAvatarSize')?.value)
                || currentSettings.appearanceProfile?.sidebarAvatarSize
                || 32,
            customRadius: Number(getElementById('appearanceCustomRadius')?.value ?? 10),
            surface: getElementById('appearanceSurface')?.value,
            surfaceEffect: currentSettings.appearanceProfile?.surfaceEffect,
            surfaceOpacity: currentSettings.appearanceProfile?.surfaceOpacity,
            surfaceBlur: currentSettings.appearanceProfile?.surfaceBlur,
            surfaceSaturation: currentSettings.appearanceProfile?.surfaceSaturation,
            surfaceBrightness: currentSettings.appearanceProfile?.surfaceBrightness,
            surfaceBorder: currentSettings.appearanceProfile?.surfaceBorder,
            surfaceShadow: currentSettings.appearanceProfile?.surfaceShadow,
            surfaceSheen: currentSettings.appearanceProfile?.surfaceSheen,
            shellRadius: currentSettings.appearanceProfile?.shellRadius,
            composerRadius: currentSettings.appearanceProfile?.composerRadius,
            sidebarRadius: getElementById('appearanceSidebarRadius')?.value
                || currentSettings.appearanceProfile?.sidebarRadius,
            cardRadius: currentSettings.appearanceProfile?.cardRadius
        }, 'next') || currentSettings.appearanceProfile,
        chatFontPreset: getElementById('chatFontPreset')?.value || currentSettings.chatFontPreset || 'system',
        chatFontCustom: getElementById('chatFontCustom')?.value.trim() || '',
        chatCodeFontPreset: getElementById('chatCodeFontPreset')?.value || currentSettings.chatCodeFontPreset || 'consolas',
        chatCodeFontCustom: getElementById('chatCodeFontCustom')?.value.trim() || '',
        chatDiaryFontPreset: getElementById('chatDiaryFontPreset')?.value || currentSettings.chatDiaryFontPreset || 'serif',
        chatDiaryFontCustom: getElementById('chatDiaryFontCustom')?.value.trim() || '',
        chatToolFontPreset: getElementById('chatToolFontPreset')?.value || currentSettings.chatToolFontPreset || 'system',
        chatToolFontCustom: getElementById('chatToolFontCustom')?.value.trim() || '',
        enableWideChatLayout: getElementById('chatLayoutModeWide')?.checked || false,
        chatPresentationMode: normalizeChatPresentationMode(
            doc.querySelector('input[name="chatPresentationMode"]:checked')?.value
                || currentSettings.chatPresentationMode
        ),
        enableUserChatBubbleUi: getElementById('enableUserChatBubbleUi')?.checked !== false,
        showUserMetaInChatBubbleUi: getElementById('showUserMetaInChatBubbleUi')?.checked !== false,
        chatBubbleMaxWidthDefault: clampBubbleWidthPercent(currentSettings.chatBubbleMaxWidthDefault, 82),
        chatBubbleMaxWidthNotifications: clampBubbleWidthPercent(currentSettings.chatBubbleMaxWidthNotifications, 90),
        chatBubbleMaxWidthNarrow: clampBubbleWidthPercent(currentSettings.chatBubbleMaxWidthNarrow, 85),
        chatBubbleMaxWidthWideDefault: clampBubbleWidthPercent(getElementById('chatBubbleMaxWidthWideDefault')?.value, 92),
        chatBubbleMaxWidthWideNotifications: clampBubbleWidthPercent(getElementById('chatBubbleMaxWidthWideNotifications')?.value, 96),
        chatBubbleMaxWidthWideNarrow: clampBubbleWidthPercent(
            getElementById('chatBubbleMaxWidthWideNarrow')?.value,
            clampBubbleWidthPercent(currentSettings.chatBubbleMaxWidthWideNarrow, 92)
        ),
        minChunkBufferSize: parseInt(getElementById('minChunkBufferSize').value, 10) || 16,
        smoothStreamIntervalMs: parseInt(getElementById('smoothStreamIntervalMs').value, 10) || 100,
        assistantAgent: getElementById('assistantAgent').value,
        voiceMode,
        voiceInputMode,
        voiceInputShortcut,
        voiceLocalSettings: {
            sovitsUrl: getElementById('voiceLocalSovitsUrl')?.value.trim() || '',
            sovitsKey: getElementById('voiceLocalSovitsKey')?.value || ''
        },
        voiceNetworkSettings: {
            providerUrl: getElementById('voiceNetworkProviderUrl')?.value.trim() || '',
            providerKey: getElementById('voiceNetworkProviderKey')?.value || ''
        },
        enableDistributedServer: getElementById('enableDistributedServer').checked,
        agentMusicControl: getElementById('agentMusicControl').checked,
        enableVcpToolInjection: getElementById('enableVcpToolInjection').checked,
        enableThoughtChainInjection: getElementById('enableThoughtChainInjection').checked,
        enableContextSanitizer: getElementById('enableContextSanitizer').checked,
        contextSanitizerDepth: parseInt(getElementById('contextSanitizerDepth').value, 10) || 0,
        enableAiMessageButtons: getElementById('enableAiMessageButtons').checked,
    };
    return newSettings;
}

// —— 测试环境：八分区渲染进同一张表单 —— //
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://localhost/' });
global.document = dom.window.document;
global.CustomEvent = dom.window.CustomEvent;
global.HTMLElement = dom.window.HTMLElement;
const doc = dom.window.document;

function renderAllSections() {
    const form = doc.createElement('form');
    form.id = 'globalSettingsForm';
    for (const sectionDescriptor of schemaSurfaceSections()) {
        const host = doc.createElement('div');
        host.dataset.settingsSectionKey = sectionDescriptor.key;
        form.append(host);
        host.replaceChildren(...renderSchemaSection(sectionDescriptor, doc));
    }
    doc.body.append(form);
    return form;
}

// 网络笔记容器补动态子行（schema 只渲染空壳，子行由服务追加）。
function seedNetworkNotes(form, values) {
    const container = form.querySelector('#networkNotesPathsContainer');
    container.replaceChildren(...values.map(value => {
        const input = doc.createElement('input');
        input.type = 'text';
        input.name = 'networkNotesPath';
        input.value = value;
        return input;
    }));
}

function makeScope(currentSettings) {
    return {
        doc,
        currentSettings,
        settingsManager: { completeVcpUrl: url => `cmp(${url})` },
        getAppearance: () => ({
            normalize: (fragment, mode) => ({ ...fragment, __normalized: mode }),
        }),
        normalizeChatPresentationMode: value => (value === 'panel' ? 'panel' : value === 'immersive' ? 'immersive' : 'bubble'),
    };
}

function mulberry32(seed) {
    let a = seed;
    return function next() {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const TEXT_POOL = ['', '   ', 'hello', '  padded  ', '值'.repeat(150), 'a,b；c', 'F7', '#12ab', '0'];
const NUMBER_POOL = ['', '0', 'abc', '-20', '123.7', '4999', '300', ' 50 ', '1e3'];

function pick(rng, pool) {
    return pool[Math.floor(rng() * pool.length)];
}

function fillFormRandomly(form, rng) {
    const inputs = form.querySelectorAll('input, textarea, select');
    for (const control of inputs) {
        const type = control.type;
        if (type === 'file' || type === 'button' || type === 'submit' || control.disabled) continue;
        if (type === 'checkbox') {
            control.checked = rng() < 0.5;
            continue;
        }
        if (type === 'radio') continue;
        if (control.tagName === 'SELECT') {
            const options = control.options;
            if (options.length) control.selectedIndex = Math.floor(rng() * options.length);
            continue;
        }
        control.value = pick(rng, type === 'number' || type === 'range' ? NUMBER_POOL : TEXT_POOL);
    }
    // 单选组：每组随机勾一个。
    const groups = new Map();
    for (const radio of form.querySelectorAll('input[type="radio"]')) {
        if (!groups.has(radio.name)) groups.set(radio.name, []);
        groups.get(radio.name).push(radio);
    }
    for (const radios of groups.values()) {
        const picked = radios[Math.floor(rng() * radios.length)];
        for (const radio of radios) radio.checked = radio === picked;
    }
}

function baseCurrentSettings() {
    return {
        sidebarWidth: 260,
        notificationsSidebarWidth: 320,
        chatBubbleMaxWidthDefault: 82,
        chatBubbleMaxWidthNotifications: 90,
        chatBubbleMaxWidthNarrow: 85,
        chatBubbleMaxWidthWideNarrow: 92,
        chatPresentationMode: 'bubble',
        appearanceProfile: {
            sidebarRowHeight: 48,
            sidebarAvatarSize: 34,
            sidebarRadius: 'medium',
            surfaceEffect: 'blur',
            surfaceOpacity: 0.6,
            surfaceBlur: 12,
            surfaceSaturation: 1.1,
            surfaceBrightness: 1,
            surfaceBorder: 'on',
            surfaceShadow: 'soft',
            surfaceSheen: 'off',
            shellRadius: 14,
            composerRadius: 12,
            cardRadius: 10,
        },
    };
}

const form = renderAllSections();

test('金测：随机灌值五轮，新收集器与旧收集器载荷逐键等价', () => {
    for (const seed of [11, 2024, 33333, 777777, 909090909]) {
        const rng = mulberry32(seed);
        const currentSettings = baseCurrentSettings();
        // 现值也随机化，覆盖 currentFallback/钳位兜底分支。
        currentSettings.chatBubbleMaxWidthDefault = pick(rng, ['0', '200', '82', 'abc', 64, undefined]) ?? currentSettings.chatBubbleMaxWidthDefault;
        currentSettings.chatBubbleMaxWidthNotifications = pick(rng, ['0', '300', '90', 12, undefined]) ?? currentSettings.chatBubbleMaxWidthNotifications;
        currentSettings.chatBubbleMaxWidthNarrow = pick(rng, ['0', '40', '85', 'junk', undefined]) ?? currentSettings.chatBubbleMaxWidthNarrow;
        currentSettings.chatBubbleMaxWidthWideNarrow = pick(rng, ['0', '75', '92', undefined]) ?? currentSettings.chatBubbleMaxWidthWideNarrow;
        currentSettings.chatFontPreset = rng() < 0.5 ? undefined : pick(rng, ['system', 'serif']);
        currentSettings.chatCodeFontPreset = rng() < 0.5 ? undefined : 'consolas';
        currentSettings.chatDiaryFontPreset = rng() < 0.5 ? undefined : 'serif';
        currentSettings.chatToolFontPreset = rng() < 0.5 ? undefined : 'system';
        currentSettings.chatPresentationMode = pick(rng, ['bubble', 'panel', 'immersive']);

        fillFormRandomly(form, rng);
        seedNetworkNotes(form, ['  a  ', '', 'b', '  ']);

        const scope = makeScope(currentSettings);
        const legacy = legacyCollect({ ...scope });
        const collected = collectSettings(schemaSurfaceSections(), { form, ...scope });
        assert.deepStrictEqual(collected, legacy, `seed=${seed} 载荷不一致`);
    }
});

test('金测：未灌值的新渲染表单与旧收集器等价（schema 默认值即表单初值）', () => {
    seedNetworkNotes(form, []);
    const currentSettings = baseCurrentSettings();
    const scope = makeScope(currentSettings);
    const legacy = legacyCollect({ ...scope });
    const collected = collectSettings(schemaSurfaceSections(), { form, ...scope });
    assert.deepStrictEqual(collected, legacy);
});

test('值语义特例：parseInt||fallback 的 0 兜底、钳位顺序、白名单', () => {
    const currentSettings = baseCurrentSettings();
    const scope = makeScope(currentSettings);
    const run = () => collectSettings(schemaSurfaceSections(), { form, ...scope });

    form.querySelector('#flowlockContinueDelay').value = '0';
    form.querySelector('#middleClickAdvancedDelay').value = '0';
    form.querySelector('#streamAnimationDurationMs').value = '0';
    form.querySelector('#contextSanitizerDepth').value = '0';
    let payload = run();
    assert.equal(payload.flowlockContinueDelay, 5);
    assert.equal(payload.middleClickAdvancedDelay, 1000);
    assert.equal(payload.streamAnimationDurationMs, 100); // Number('0')=0 有限 → 取整钳位，不走兜底
    assert.equal(payload.contextSanitizerDepth, 0);       // 0||0 === 0，兜底不改变结果

    form.querySelector('#streamAnimationDurationMs').value = 'abc';
    form.querySelector('#middleClickAdvancedDelay').value = '-20';
    form.querySelector('#streamAnimationCustomCss').value = 'x'.repeat(5000);
    payload = run();
    // jsdom 会按 range 语义把非法值消毒成合法值，无法在这里触发 NaN 兜底；
    // 无论消毒结果是什么，取整+钳位不变量必须成立（NaN 兜底由宽屏窄窗口
    // 宽度的 'abc' 用例覆盖）。
    assert.ok(payload.streamAnimationDurationMs >= 100
        && payload.streamAnimationDurationMs <= 2000
        && payload.streamAnimationDurationMs % 50 === 0,
        `时长应落在步长网格内，实际 ${payload.streamAnimationDurationMs}`);
    assert.equal(payload.middleClickAdvancedDelay, 1000);
    assert.equal(payload.streamAnimationCustomCss.length, 4000);

    // 快捷键：trim → 空兜底 F7 → 转大写。
    form.querySelector('#voiceInputShortcut').value = 'f2';
    payload = run();
    assert.equal(payload.voiceInputShortcut, 'F2');
    form.querySelector('#voiceInputShortcut').value = '   ';
    payload = run();
    assert.equal(payload.voiceInputShortcut, 'F7');

    // 寄语：130 字截断到 120；空值回落默认文案。
    form.querySelector('#homeVisualTagline').value = '长'.repeat(130);
    payload = run();
    assert.equal(payload.homeVisualTagline, '长'.repeat(120));
    form.querySelector('#homeVisualTagline').value = '   ';
    payload = run();
    assert.equal(payload.homeVisualTagline, '语义级打穿 AI、UI/UX、APP 与人类想象力的边界');

    // 标准模式气泡宽度：来自现值钳位而非表单。
    currentSettings.chatBubbleMaxWidthDefault = 200;
    currentSettings.chatBubbleMaxWidthNotifications = 'abc';
    currentSettings.chatBubbleMaxWidthNarrow = 0;
    payload = run();
    assert.equal(payload.chatBubbleMaxWidthDefault, 98);
    assert.equal(payload.chatBubbleMaxWidthNotifications, 90);
    assert.equal(payload.chatBubbleMaxWidthNarrow, 50);

    // 宽屏窄窗口宽度兜底 = 现值钳位（clamp(current, 92)），再过 50-98 钳位。
    form.querySelector('#chatBubbleMaxWidthWideNarrow').value = 'abc';
    currentSettings.chatBubbleMaxWidthWideNarrow = 30;
    payload = run();
    assert.equal(payload.chatBubbleMaxWidthWideNarrow, 50);
    currentSettings.chatBubbleMaxWidthWideNarrow = 75;
    payload = run();
    assert.equal(payload.chatBubbleMaxWidthWideNarrow, 75);
});

test('值语义特例：语音模式单选、呈现模式复合键与字体 currentFallback', () => {
    const currentSettings = baseCurrentSettings();
    const scope = makeScope(currentSettings);

    doc.querySelector('#voiceModeNetwork').checked = false;
    doc.querySelector('#voiceModeLocal').checked = true;
    let payload = collectSettings(schemaSurfaceSections(), { form, ...scope });
    assert.equal(payload.voiceMode, 'local');
    doc.querySelector('#voiceModeNetwork').checked = true;
    payload = collectSettings(schemaSurfaceSections(), { form, ...scope });
    assert.equal(payload.voiceMode, 'network');

    // 呈现模式：未勾选时回落现值并经 normalize。
    for (const radio of doc.querySelectorAll('input[name="chatPresentationMode"]')) radio.checked = false;
    currentSettings.chatPresentationMode = 'panel';
    payload = collectSettings(schemaSurfaceSections(), { form, ...scope });
    assert.equal(payload.chatPresentationMode, 'panel');

    // 字体预设空值 → 现值 → 固定兜底。
    doc.querySelector('#chatFontPreset').value = '';
    currentSettings.chatFontPreset = 'serif';
    payload = collectSettings(schemaSurfaceSections(), { form, ...scope });
    assert.equal(payload.chatFontPreset, 'serif');
    currentSettings.chatFontPreset = undefined;
    payload = collectSettings(schemaSurfaceSections(), { form, ...scope });
    assert.equal(payload.chatFontPreset, 'system');

    // 宽屏布局单选 → enableWideChatLayout 布尔。
    doc.querySelector('#chatLayoutModeWide').checked = true;
    payload = collectSettings(schemaSurfaceSections(), { form, ...scope });
    assert.equal(payload.enableWideChatLayout, true);
    doc.querySelector('#chatLayoutModeWide').checked = false;
    payload = collectSettings(schemaSurfaceSections(), { form, ...scope });
    assert.equal(payload.enableWideChatLayout, false);

    // 透传键直接来自现值。
    currentSettings.sidebarWidth = 280;
    currentSettings.notificationsSidebarWidth = 340;
    payload = collectSettings(schemaSurfaceSections(), { form, ...scope });
    assert.equal(payload.sidebarWidth, 280);
    assert.equal(payload.notificationsSidebarWidth, 340);

    // appearanceProfile 经 getAppearance().normalize 归一，模式为 next。
    doc.querySelector('#appearanceDensity').value = 'compact';
    doc.querySelector('#appearanceSidebarRowHeight').value = '52';
    payload = collectSettings(schemaSurfaceSections(), { form, ...scope });
    assert.equal(payload.appearanceProfile.density, 'compact');
    assert.equal(payload.appearanceProfile.sidebarRowHeight, 52);
    assert.equal(payload.appearanceProfile.__normalized, 'next');
    assert.equal(payload.appearanceProfile.surfaceOpacity, 0.6); // 现值保留键透传

    // clampBubbleWidthPercent 可复用形态与旧链一致。
    assert.equal(clampBubbleWidthPercent('30', 82), 50);
    assert.equal(clampBubbleWidthPercent('junk', 82), 82);
});

test('值语义通道：rust/论坛/头像字段不进全量载荷，通道清单登记', async () => {
    const { SAVE_CHANNEL_MANIFEST } = await import('../modules/settings/value-semantics.js');
    const currentSettings = baseCurrentSettings();
    const payload = collectSettings(schemaSurfaceSections(), { form, ...makeScope(currentSettings) });
    for (const key of Object.keys(payload)) {
        assert.match(key, /^(?!rust)/, `${key} 不应出现在全量载荷里（划词走独立通道）`);
    }
    assert.ok(payload.adminUsername === undefined);
    assert.ok(SAVE_CHANNEL_MANIFEST.rust.fields.includes('rustRuleMode'));
    assert.ok(SAVE_CHANNEL_MANIFEST.forum.fields.includes('adminUsername'));
    assert.ok(SAVE_CHANNEL_MANIFEST.avatar.fields.includes('userAvatarInput'));
});
