// M0/M1 验收：schema 编译产物与静态标记同构，切换面幂等且不丢现值。
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { quickActionsSection } from '../modules/settings/schema/quick-actions.js';
import { userIdentitySection } from '../modules/settings/schema/user-identity.js';
import { serverConnectionSection } from '../modules/settings/schema/server-connection.js';
import { renderSettingsSection } from '../modules/settings/schema/render-settings.js';
import { selectionAssistantSection } from '../modules/settings/schema/selection-assistant.js';
import { voiceSettingsSection } from '../modules/settings/schema/voice-settings.js';
import { advancedFeaturesSection } from '../modules/settings/schema/advanced-features.js';
import { appearanceSettingsSection } from '../modules/settings/schema/appearance-settings.js';
import { renderSchemaSection, renderSchemaField } from '../modules/settings/render/field-renderer.js';
import { captureSectionValues, restoreSectionValues, readControlById } from '../modules/settings/store.js';
import { applySchemaSurface, schemaSurfaceSections } from '../modules/settings/schema-surface.js';
import { mountCanonicalSettingsRows } from '../modules/ui-system/settings/canonical-rows.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://localhost/' });
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.HTMLElement = dom.window.HTMLElement;

const doc = dom.window.document;

function renderIntoForm(sectionDescriptor) {
    const form = doc.createElement('form');
    const host = doc.createElement('div');
    host.id = `section-${sectionDescriptor.key}`;
    host.className = 'settings-section';
    host.dataset.settingsSectionKey = sectionDescriptor.key;
    form.append(host);
    host.replaceChildren(...renderSchemaSection(sectionDescriptor, doc));
    return { form, host };
}

test('八分区全部登记且 schema 编译无异常', () => {
    const keys = schemaSurfaceSections().map(s => s.key);
    assert.deepEqual(keys, ['user-identity', 'server-connection', 'appearance-settings', 'render-settings',
        'selection-assistant', 'voice-settings', 'advanced-features', 'quick-actions']);
    for (const sectionDescriptor of schemaSurfaceSections()) {
        const nodes = renderSchemaSection(sectionDescriptor, doc);
        assert.ok(nodes.length > 1, `${sectionDescriptor.key} 应编译出标题与行`);
        assert.equal(nodes[0].textContent, sectionDescriptor.title);
    }
});

test('quick-actions schema 编译产物保留全部业务锚点与行为标记', () => {
    const { form } = renderIntoForm(quickActionsSection);
    for (const key of ['continueWritingPrompt', 'flowlockContinueDelay', 'enableMiddleClickQuickAction',
        'middleClickQuickAction', 'enableRegenerateConfirmation', 'enableMiddleClickAdvanced',
        'middleClickAdvancedDelay']) {
        assert.ok(form.querySelector(`#${key}[name="${key}"]`), `missing control #${key}`);
    }
    for (const id of ['middleClickQuickActionContainer', 'regenerateConfirmationContainer',
        'middleClickAdvancedToggleRow', 'middleClickAdvancedSettings']) {
        assert.ok(form.querySelector(`#${id}`), `missing anchored row #${id}`);
    }
    assert.equal(form.querySelector('#middleClickQuickActionContainer').getAttribute('data-visible-when'), 'enableMiddleClickQuickAction');
    assert.equal(form.querySelector('#regenerateConfirmationContainer').getAttribute('data-visible-when'),
        'enableMiddleClickQuickAction && middleClickQuickAction=regenerate');
    assert.equal(form.querySelector('#middleClickAdvancedSettings').getAttribute('data-visible-when'),
        'enableMiddleClickQuickAction && enableMiddleClickAdvanced');
    const textarea = form.querySelector('#continueWritingPrompt');
    assert.equal(textarea.tagName, 'TEXTAREA');
    assert.equal(textarea.getAttribute('placeholder'), '默认: 请继续');
    assert.equal(textarea.getAttribute('rows'), '1');
    assert.equal(textarea.getAttribute('spellcheck'), 'false');
    assert.equal(textarea.textContent, '请继续');
    const delay = form.querySelector('#flowlockContinueDelay');
    assert.equal(delay.getAttribute('min'), '1');
    assert.equal(delay.getAttribute('max'), '300');
    assert.equal(delay.getAttribute('step'), '1');
    assert.equal(delay.value, '5');
    const select = form.querySelector('#middleClickQuickAction');
    assert.equal(select.hidden, true);
    assert.equal(select.options.length, 9);
    assert.equal(select.options[7].value, 'regenerate');
    const advancedToggle = form.querySelector('#enableMiddleClickAdvanced');
    assert.equal(advancedToggle.type, 'checkbox');
    assert.ok(advancedToggle.closest('label.switch'));
    assert.ok(advancedToggle.closest('label.switch').querySelector('span.slider.round'));
    assert.equal(form.querySelector('.settings-section-title').textContent, '快捷操作');
});

test('编译产物行形态与静态标记同构（data-vcp-style 与类名）', () => {
    const { form } = renderIntoForm(quickActionsSection);
    const stackedRow = form.querySelector('#continueWritingPrompt').closest('.vcp-settings-row');
    assert.ok(stackedRow.classList.contains('vcp-settings-row-stacked'));
    assert.equal(stackedRow.getAttribute('data-vcp-style'), '37');
    assert.equal(form.querySelector('#continueWritingPrompt').getAttribute('data-vcp-style'), '38');
    assert.equal(form.querySelector('#flowlockContinueDelay').getAttribute('data-vcp-style'), '19');
    assert.equal(form.querySelector('#enableMiddleClickQuickAction').closest('.vcp-settings-control-row').getAttribute('data-vcp-style'), '15');
    assert.equal(form.querySelector('#middleClickQuickActionContainer').getAttribute('data-vcp-style'), '34');
    assert.equal(form.querySelector('#middleClickAdvancedSettings').getAttribute('data-vcp-style'), '41');
    assert.equal(form.querySelector('#middleClickAdvancedDelay').getAttribute('data-vcp-style'), '27');
});

test('user-identity：专属组件与业务锚点齐备', () => {
    const { form } = renderIntoForm(userIdentitySection);
    for (const id of ['userAvatarPreview', 'userAvatarInput', 'userName', 'userStyleCollapseHeader',
        'userAvatarBorderColor', 'userAvatarBorderColorText', 'userNameTextColor', 'userNameTextColorText',
        'resetUserAvatarColorsBtn', 'adminUsername', 'adminPassword']) {
        assert.ok(form.querySelector(`#${id}`), `missing #${id}`);
    }
    assert.ok(form.querySelector('.vcp-uiux-user-profile-card[data-vcp-settings-row]'));
    assert.ok(form.querySelector('.agent-style-collapsible-container.collapsed'));
    assert.ok(form.querySelector('.vcp-uiux-identity-name-display .vcp-uiux-identity-name-edit'));
    assert.equal(form.querySelector('#userAvatarBorderColor').value, '#3d5a80');
    // 管理员行的历史样式标记
    assert.equal(form.querySelector('#adminUsername').closest('.vcp-settings-row').getAttribute('data-vcp-style'), '3');
    assert.equal(form.querySelector('#adminPassword').getAttribute('type'), 'password');
});

test('server-connection：卡片结构与动态容器锚点', () => {
    const { form } = renderIntoForm(serverConnectionSection);
    for (const id of ['vcpConnectionCardBody', 'networkNotesCardBody', 'networkNotesPathsContainer', 'addNetworkPathBtn']) {
        assert.ok(form.querySelector(`#${id}`), `missing #${id}`);
    }
    const toggle = form.querySelector('.vcp-settings-card-toggle');
    assert.equal(toggle.getAttribute('aria-controls'), 'vcpConnectionCardBody');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.ok(toggle.querySelector('svg.vcp-settings-card-chevron'));
    assert.equal(form.querySelector('#vcpServerUrl').getAttribute('type'), 'url');
    assert.ok(form.querySelector('#vcpServerUrl').required);
    assert.equal(form.querySelector('#vcpApiKey').getAttribute('type'), 'password');
    assert.equal(form.querySelector('#addNetworkPathBtn').getAttribute('data-vcp-style'), '6');
    assert.ok(form.querySelector('#addNetworkPathBtn').classList.contains('vcp-settings-card-add-row'));
});

test('render-settings：stepper 内联行、预设行、滑杆与自定义行', () => {
    const { form } = renderIntoForm(renderSettingsSection);
    for (const id of ['enableSmoothStreaming', 'minChunkBufferSize', 'smoothStreamIntervalMs',
        'streamAnimationSettingsRow', 'streamAnimationPreset', 'streamAnimationDurationRow',
        'streamAnimationDurationMs', 'streamAnimationDurationValue', 'streamAnimationCustomRow',
        'streamAnimationCustomCss', 'fillStreamAnimationCssExample', 'replayStreamAnimationPreview',
        'streamAnimationPreviewElement']) {
        assert.ok(form.querySelector(`#${id}`), `missing #${id}`);
    }
    // 开关行：label+hint 在包裹 div 内
    const smoothRow = form.querySelector('#enableSmoothStreaming').closest('.vcp-settings-control-row');
    assert.equal(smoothRow.getAttribute('data-vcp-style'), '15');
    assert.ok(smoothRow.querySelector(':scope > div > small'));
    // stepper 双控件内联行
    const inlineRow = form.querySelector('#minChunkBufferSize').closest('.settings-inline-number-row');
    assert.ok(inlineRow.classList.contains('form-group'));
    assert.equal(form.querySelector('#minChunkBufferSize').getAttribute('data-vcp-style'), '19');
    const stepperCell = form.querySelector('#minChunkBufferSize').parentElement;
    assert.equal(stepperCell.querySelector(':scope > label').getAttribute('data-vcp-style'), '18');
    assert.equal(form.querySelector('#minChunkBufferSize').getAttribute('min'), '1');
    assert.equal(form.querySelector('#smoothStreamIntervalMs').value, '100');
    // 预设 select hidden 且行 id 保留
    assert.equal(form.querySelector('#streamAnimationSettingsRow').classList.contains('vcp-settings-row'), true);
    assert.equal(form.querySelector('#streamAnimationPreset').hidden, true);
    assert.equal(form.querySelector('#streamAnimationPreset').options.length, 6);
    // 滑杆与 output
    const range = form.querySelector('#streamAnimationDurationMs');
    assert.equal(range.getAttribute('min'), '100');
    assert.equal(range.getAttribute('max'), '2000');
    assert.equal(form.querySelector('#streamAnimationDurationValue').textContent, '500ms');
    // 自定义行默认 hidden，textarea 契约与示例按钮
    assert.equal(form.querySelector('#streamAnimationCustomRow').hidden, true);
    assert.equal(form.querySelector('#streamAnimationCustomCss').getAttribute('rows'), '4');
    assert.equal(form.querySelector('#streamAnimationCustomCss').getAttribute('spellcheck'), 'false');
    assert.ok(form.querySelector('#streamAnimationCustomRow .stream-animation-custom-example pre code'));
});

test('selection-assistant：调试面板、阈值依赖与规则模式', () => {
    const { form } = renderIntoForm(selectionAssistantSection);
    for (const id of ['assistantAgentContainer', 'assistantAgent', 'rustDebugMode', 'rustDebugPanel',
        'rustUseAssistant', 'rustEnableCustomThresholds', 'rustMinEventIntervalMs', 'rustMinDistance',
        'rustScreenshotSuspendMs', 'rustClipboardConflictSuspendMs', 'rustClipboardCheckIntervalMs',
        'rustRuleModeRow', 'rustRuleMode', 'rustWhitelistKeywords', 'rustBlacklistKeywords', 'rustScreenshotApps']) {
        assert.ok(form.querySelector(`#${id}`), `missing #${id}`);
    }
    // 调试面板挂在开关行内，可见性依赖调试开关
    const debugRow = form.querySelector('#rustDebugMode').closest('.vcp-settings-control-row');
    assert.equal(debugRow.getAttribute('data-vcp-style'), '23');
    const panel = form.querySelector('#rustDebugPanel');
    assert.equal(panel.parentElement, debugRow);
    assert.equal(panel.getAttribute('data-visible-when'), 'rustDebugMode');
    for (const spanId of ['assistantRuntimeMode', 'assistantRuntimeProcessPid', 'assistantRuntimeShowError']) {
        assert.ok(panel.querySelector(`#${spanId}`), `missing panel span #${spanId}`);
    }
    // 阈值行依赖子句与样式
    const threshold = form.querySelector('#rustMinEventIntervalMs').closest('.form-group');
    assert.equal(threshold.getAttribute('data-vcp-style'), '26');
    assert.equal(threshold.getAttribute('data-visible-when'), 'rustUseAssistant && rustEnableCustomThresholds');
    assert.equal(form.querySelector('#rustMinEventIntervalMs').getAttribute('data-vcp-style'), '27');
    assert.equal(threshold.querySelector('small').getAttribute('data-vcp-style'), '28');
    // 规则模式 select 与关键词 textarea
    assert.equal(form.querySelector('#rustRuleMode').getAttribute('data-vcp-style'), '30');
    assert.equal(form.querySelector('#rustRuleModeRow').getAttribute('data-vcp-style'), '29');
    assert.equal(form.querySelector('#rustRuleModeRow').getAttribute('data-visible-when'), 'rustUseAssistant');
    assert.equal(form.querySelector('#rustBlacklistKeywords').closest('.form-group').getAttribute('data-visible-when'),
        'rustUseAssistant && rustRuleMode=blacklist');
    assert.equal(form.querySelector('#rustWhitelistKeywords').getAttribute('rows'), '3');
    assert.equal(form.querySelector('#rustWhitelistKeywords').getAttribute('data-vcp-style'), null);
    assert.equal(form.querySelector('#rustWhitelistKeywords').placeholder.includes('\n'), true);
});

test('voice-settings：单选组结构与胶囊 select 行', () => {
    const { form } = renderIntoForm(voiceSettingsSection);
    for (const id of ['voiceModeLocal', 'voiceModeNetwork', 'voiceInputModeRow', 'voiceInputMode',
        'voiceInputShortcut', 'voiceNetworkProviderUrl', 'voiceNetworkProviderKey',
        'voiceLocalSovitsUrl', 'voiceLocalSovitsKey']) {
        assert.ok(form.querySelector(`#${id}`), `missing #${id}`);
    }
    const local = form.querySelector('#voiceModeLocal');
    assert.equal(local.checked, true);
    assert.equal(local.name, 'voiceMode');
    assert.equal(local.value, 'local');
    const innerRow = local.closest('.vcp-settings-control-row');
    assert.equal(innerRow.getAttribute('data-vcp-style'), '13');
    const group = local.closest('.form-group');
    assert.equal(group.getAttribute('data-vcp-style'), '32');
    assert.equal(group.querySelector(':scope > label').getAttribute('data-vcp-style'), '11');
    assert.equal(group.querySelector(':scope > label').textContent, '语音工作模式');
    assert.equal(group.querySelector(':scope > small').getAttribute('data-vcp-style'), '4');
    // 快捷键默认值与 url 占位
    assert.equal(form.querySelector('#voiceInputShortcut').value, 'F7');
    assert.equal(form.querySelector('#voiceLocalSovitsUrl').getAttribute('type'), 'url');
    assert.equal(form.querySelector('#voiceInputModeRow').classList.contains('vcp-settings-row'), true);
    assert.equal(form.querySelector('#voiceInputMode').hidden, true);
});

test('advanced-features：依赖行、分隔线与模型复合控件', () => {
    const { form, host } = renderIntoForm(advancedFeaturesSection);
    for (const id of ['enableDistributedServer', 'enableVcpToolInjection', 'enableThoughtChainInjection',
        'enableAiMessageButtons', 'enableContextSanitizer', 'contextSanitizerDepthContainer',
        'contextSanitizerDepth', 'agentMusicControl', 'topicSummaryModelContainer', 'topicSummaryModel',
        'openTopicSummaryModelSelectBtn']) {
        assert.ok(form.querySelector(`#${id}`), `missing #${id}`);
    }
    // 净化深度行：依赖子句 + 历史样式
    const depthRow = form.querySelector('#contextSanitizerDepthContainer');
    assert.equal(depthRow.getAttribute('data-vcp-style'), '34');
    assert.equal(depthRow.getAttribute('data-visible-when'), 'enableContextSanitizer');
    assert.equal(form.querySelector('#contextSanitizerDepth').getAttribute('data-vcp-style'), '19');
    assert.equal(form.querySelector('#contextSanitizerDepth').value, '2');
    // 开关行的 title 提示
    assert.ok(form.querySelector('label[for="enableThoughtChainInjection"][title]'));
    // 分隔线与模型复合控件
    const hr = host.querySelector('hr');
    assert.equal(hr.getAttribute('data-vcp-style'), '36');
    assert.ok(form.querySelector('#topicSummaryModelContainer .model-input-container button svg'));
    // 复合控件内部输入可快照迁移
    form.querySelector('#topicSummaryModel').value = 'gpt-x';
    const snapshot = captureSectionValues(form, advancedFeaturesSection);
    assert.equal(snapshot.get('topicSummaryModel'), 'gpt-x');
    host.replaceChildren(...renderSchemaSection(advancedFeaturesSection, doc));
    restoreSectionValues(form, snapshot);
    assert.equal(form.querySelector('#topicSummaryModel').value, 'gpt-x');
});

test('appearance-settings：裸 select 行、几何滑杆与主页视觉开关', () => {
    const { form } = renderIntoForm(appearanceSettingsSection);
    // 裸 select 行：容器 id + data-vcp-settings-row + hidden select（语言行 passes 的宿主锚点）
    for (const key of ['appearanceDensity', 'appearanceRadius', 'appearanceTypography',
        'appearanceFontScale', 'appearanceContentWidth', 'appearanceSurface']) {
        const row = form.querySelector(`#${key}Row`);
        assert.ok(row, `missing #${key}Row`);
        assert.equal(row.getAttribute('data-vcp-settings-row'), '');
        const selectNode = row.querySelector(`#${key}`);
        assert.ok(selectNode?.hidden, `#${key} 应为 hidden select`);
        assert.ok(selectNode.options.length >= 2, `#${key} 应保留全部选项`);
    }
    const radiusRow = form.querySelector('#appearanceSidebarRadiusLanguageRow');
    assert.equal(radiusRow.className, 'appearance-radius-language-host');
    assert.equal(radiusRow.querySelector('#appearanceSidebarRadius').getAttribute('aria-label'), '列表项圆角');
    // 几何滑杆：label 整行 + heading 内嵌 output + min/max/step
    const heightRow = form.querySelector('label[for="appearanceSidebarRowHeight"]');
    assert.ok(heightRow.classList.contains('appearance-geometry-control'));
    const heightOutput = heightRow.querySelector('#appearanceSidebarRowHeightValue');
    assert.equal(heightOutput.getAttribute('for'), 'appearanceSidebarRowHeight');
    assert.equal(heightOutput.textContent, '46px');
    const heightInput = heightRow.querySelector('#appearanceSidebarRowHeight');
    assert.equal(heightInput.min, '38');
    assert.equal(heightInput.max, '64');
    const radiusHelper = form.querySelector('label[for="appearanceCustomRadius"] small.appearance-geometry-helper');
    assert.ok(radiusHelper, '自定义圆角行应带 geometry helper 提示');
    // 主页视觉开关行：appearance-home-visual-setting 结构
    const brandRow = form.querySelector('#showHomeVisualBrand').closest('.appearance-home-visual-setting');
    assert.equal(brandRow.getAttribute('data-vcp-settings-row'), '');
    assert.equal(brandRow.querySelector('.appearance-home-visual-copy strong').textContent, '主页视觉文字');
    assert.equal(brandRow.querySelector('label.switch').getAttribute('aria-label'), '显示主页视觉文字');
    assert.equal(form.querySelector('#showHomeVisualTagline').checked, true);
    // 寄语内容：整行 label + span 标题 + maxlength
    const taglineRow = form.querySelector('label.vcp-settings-row[for="homeVisualTagline"]');
    assert.equal(taglineRow.querySelector(':scope > span').textContent, '寄语内容');
    assert.equal(taglineRow.querySelector('#homeVisualTagline').getAttribute('maxlength'), '120');
});

test('appearance-settings：场景字体预览与呈现模式组件', () => {
    const { form } = renderIntoForm(appearanceSettingsSection);
    // 工作台卡：appearance-studio 的摘要锚点与工作台按钮
    const workbench = form.querySelector('#appearanceSettingsWorkbenchCard');
    assert.ok(workbench.querySelector('[data-appearance-summary-preview]'));
    assert.ok(workbench.querySelector('[data-appearance-summary-density]'));
    assert.ok(workbench.querySelector('[data-appearance-summary-radius]'));
    assert.ok(workbench.querySelector('[data-appearance-summary-presentation]'));
    assert.ok(workbench.querySelector('#openAppearanceStudioFromSettings svg'));
    // 场景预览：四卡 + 8 个字体控件的宿主 id
    const grid = form.querySelector('#fontScenarioPreviewGrid');
    assert.equal(grid.querySelectorAll('.scenario-preview-card').length, 4);
    for (const id of ['chatFontPresetRow', 'chatFontCustomRow', 'chatCodeFontPresetRow', 'chatCodeFontCustomRow',
        'chatDiaryFontPresetRow', 'chatDiaryFontCustomRow', 'chatToolFontPresetRow', 'chatToolFontCustomRow']) {
        assert.ok(form.querySelector(`#${id}`), `missing #${id}`);
    }
    assert.equal(form.querySelector('#chatFontPreset').options.length, 8);
    assert.equal(form.querySelector('#chatToolFontPreset').options.length, 13);
    assert.equal(form.querySelector('#scenarioPreviewCode').textContent.includes('const sum'), true);
    // 呈现模式：fieldset 三张 radio 卡，气泡默认选中
    const bubble = form.querySelector('#chatPresentationModeBubble');
    assert.equal(bubble.closest('fieldset').className, 'form-group chat-presentation-mode-selector');
    assert.equal(bubble.value, 'bubble');
    assert.equal(bubble.checked, true);
    assert.equal(form.querySelector('#chatPresentationModePanel').checked, false);
    assert.equal(bubble.closest('fieldset').getAttribute('data-vcp-style'), '10');
});

test('appearance-settings：内容宽度单选组、气泡依赖行与宽屏数字组', () => {
    const { form, host } = renderIntoForm(appearanceSettingsSection);
    const widthRow = form.querySelector('#chatLayoutModeNormal').closest('.form-group');
    assert.equal(widthRow.getAttribute('data-vcp-style'), '12');
    assert.equal(widthRow.querySelector(':scope > .vcp-settings-control-row').getAttribute('data-vcp-style'), '13');
    assert.equal(widthRow.querySelector('label').getAttribute('data-vcp-style'), '11');
    assert.equal(form.querySelector('#chatLayoutModeNormal').checked, true);
    // 气泡依赖行：visible-when 子句与 hintInsideWrapper 结构
    const bubbleRow = form.querySelector('#enableUserChatBubbleUi').closest('.vcp-settings-control-row');
    assert.equal(bubbleRow.getAttribute('data-visible-when'), 'chatPresentationModeBubble');
    assert.ok(bubbleRow.querySelector(':scope > div > small'));
    const metaRow = form.querySelector('#userChatBubbleMetaSettings');
    assert.equal(metaRow.getAttribute('data-visible-when'), 'chatPresentationModeBubble && enableUserChatBubbleUi');
    // 宽屏数字组：三组 label+number，依赖两子句
    const wideRow = form.querySelector('#chatBubbleMaxWidthWideDefault').closest('.vcp-settings-control-row');
    assert.equal(wideRow.getAttribute('data-visible-when'), 'chatPresentationModeBubble && chatLayoutModeWide');
    assert.equal(wideRow.getAttribute('data-vcp-style'), '17');
    assert.equal(wideRow.querySelector(':scope > label').textContent, '宽屏模式自定义宽度（%）');
    assert.equal(form.querySelector('#chatBubbleMaxWidthWideDefault').value, '92');
    assert.equal(form.querySelector('#chatBubbleMaxWidthWideNotifications').value, '96');
    assert.equal(form.querySelector('#chatBubbleMaxWidthWideNarrow').value, '92');
    // 呈现模式与字体控件参与快照迁移
    form.querySelector('#chatPresentationModePanel').checked = true;
    form.querySelector('#chatFontCustom').value = '"LXGW WenKai", sans-serif';
    form.querySelector('#chatBubbleMaxWidthWideDefault').value = '80';
    const snapshot = captureSectionValues(form, appearanceSettingsSection);
    host.replaceChildren(...renderSchemaSection(appearanceSettingsSection, doc));
    restoreSectionValues(form, snapshot);
    assert.equal(form.querySelector('#chatPresentationModePanel').checked, true);
    assert.equal(form.querySelector('#chatFontCustom').value, '"LXGW WenKai", sans-serif');
    assert.equal(form.querySelector('#chatBubbleMaxWidthWideDefault').value, '80');
});

test('canonical-rows 对编译产物投影出与静态标记一致的 canonical 行', () => {
    const { form } = renderIntoForm(quickActionsSection);
    mountCanonicalSettingsRows(form);
    const stackedItem = form.querySelector('#continueWritingPrompt').closest('.vcp-uiux-general-item');
    assert.ok(stackedItem, 'textarea 行应成为 canonical 行');
    assert.ok(stackedItem.classList.contains('vcp-uiux-general-row'));
    assert.ok(stackedItem.classList.contains('vcp-settings-row-stacked'));
    assert.equal(stackedItem.dataset.settingKey, 'continueWritingPrompt');
    assert.equal(stackedItem.dataset.settingsSectionKey, 'quick-actions');
    const copy = stackedItem.querySelector(':scope > .vcp-uiux-row-copy');
    assert.ok(copy, 'textarea 行应有 row-copy 槽');
    assert.equal(copy.querySelector('label').getAttribute('for'), 'continueWritingPrompt');
    assert.ok(copy.querySelector('small'), '提示应进 row-copy 槽');
    const switchRow = form.querySelector('#enableMiddleClickQuickAction').closest('.vcp-uiux-general-item');
    assert.ok(switchRow.querySelector(':scope > .vcp-uiux-row-copy label'));
    assert.ok(switchRow.querySelector(':scope > label.switch'));
    assert.ok(form.querySelector('#middleClickQuickActionContainer'), '容器 id 必须穿越投影');
});

test('store 快照：多类型现值迁移不丢失', () => {
    const { form, host } = renderIntoForm(quickActionsSection);
    form.querySelector('#continueWritingPrompt').value = '自定义提示词';
    form.querySelector('#enableMiddleClickQuickAction').checked = true;
    form.querySelector('#middleClickQuickAction').value = 'regenerate';
    const snapshot = captureSectionValues(form, quickActionsSection);
    host.replaceChildren(...renderSchemaSection(quickActionsSection, doc));
    assert.equal(form.querySelector('#continueWritingPrompt').value, '请继续', '重渲染后应回到默认值');
    restoreSectionValues(form, snapshot);
    assert.equal(form.querySelector('#continueWritingPrompt').value, '自定义提示词');
    assert.equal(form.querySelector('#enableMiddleClickQuickAction').checked, true);
    assert.equal(form.querySelector('#middleClickQuickAction').value, 'regenerate');
    assert.equal(readControlById(form, 'enableMiddleClickAdvanced'), false);
});

test('store 快照：custom 组件按 captureKeys 迁移内部控件', () => {
    const { form, host } = renderIntoForm(renderSettingsSection);
    form.querySelector('#streamAnimationCustomCss').value = 'opacity: 0;';
    form.querySelector('#streamAnimationDurationMs').value = '800';
    const snapshot = captureSectionValues(form, renderSettingsSection);
    host.replaceChildren(...renderSchemaSection(renderSettingsSection, doc));
    restoreSectionValues(form, snapshot);
    assert.equal(form.querySelector('#streamAnimationCustomCss').value, 'opacity: 0;');
    assert.equal(form.querySelector('#streamAnimationDurationMs').value, '800');
});

test('schema-surface：开关关闭为空操作，开启后原地替换且幂等', () => {
    const form = doc.createElement('form');
    const host = doc.createElement('div');
    host.id = 'section-quick-actions';
    host.className = 'settings-section';
    const staticRow = doc.createElement('div');
    staticRow.className = 'vcp-settings-row';
    const staticInput = doc.createElement('input');
    staticInput.id = 'flowlockContinueDelay';
    staticInput.name = 'flowlockContinueDelay';
    staticInput.type = 'number';
    staticInput.value = '42';
    staticRow.append(staticInput);
    host.append(staticRow);
    form.append(host);
    const hostIdentity = host;

    // M4 起 schema 面转正：不再有开关，直接渲染并保持分区元素身份。
    assert.ok(schemaSurfaceSections().some(s => s.key === 'quick-actions'));
    const replaced = applySchemaSurface(form, doc);
    assert.deepEqual(replaced, ['quick-actions']);
    assert.equal(host, hostIdentity, '分区元素身份必须保持');
    assert.equal(host.dataset.vcpSchemaRendered, 'true');
    assert.ok(host.querySelector('.settings-section-title'), '渲染后应有标题');
    assert.ok(host.querySelector('#middleClickQuickActionContainer'), '渲染后应有业务容器');
    assert.equal(form.querySelector('#flowlockContinueDelay').value, '42');
    form.querySelector('#flowlockContinueDelay').value = '77';
    assert.deepEqual(applySchemaSurface(form, doc), []);
    assert.equal(form.querySelector('#flowlockContinueDelay').value, '77');
});

test('schema-surface：动态节点整体迁移（select 选项与容器子行）', () => {
    const form = doc.createElement('form');
    const host = doc.createElement('div');
    host.id = 'section-selection-assistant';
    host.className = 'settings-section';
    const row = doc.createElement('div');
    row.className = 'vcp-settings-row';
    row.id = 'assistantAgentContainer';
    const liveSelect = doc.createElement('select');
    liveSelect.id = 'assistantAgent';
    liveSelect.name = 'assistantAgent';
    liveSelect.hidden = true;
    for (const [value, label] of [['', '请选择一个Agent'], ['agentA', '助手A'], ['agentB', '助手B']]) {
        const option = doc.createElement('option');
        option.value = value;
        option.textContent = label;
        liveSelect.append(option);
    }
    liveSelect.value = 'agentB';
    row.append(liveSelect);
    host.append(row);
    form.append(host);

    assert.deepEqual(applySchemaSurface(form, doc), ['selection-assistant']);
    const kept = form.querySelector('#assistantAgent');
    assert.equal(kept, liveSelect, '动态填充的 select 必须原节点保留');
    assert.equal(kept.options.length, 3, '运行时选项不丢失');
    assert.equal(kept.value, 'agentB', '选中值不丢失');
    assert.ok(form.querySelector('#rustDebugPanel'), '渲染产物其余行正常');
});

test('field-renderer 拒绝未知字段类型', () => {
    assert.throws(() => renderSchemaField(doc, { key: 'x', type: 'mystery', label: 'x' }), /mystery/);
});
