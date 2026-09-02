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
import { activateNumericStepperRow } from '../modules/uiux/generated/primitives/numeric-stepper-row.js';
import { mountGlobalSteppers } from '../modules/ui-system/settings/global-input-upgrades.js';
import { activateLanguageRow } from '../modules/uiux/generated/primitives/language-row.js';
import { activateFontSizeRow } from '../modules/uiux/generated/primitives/font-size-row.js';
import { activateChoice } from '../modules/uiux/generated/primitives/choice.js';
import { mountGlobalLanguageRows } from '../modules/ui-system/settings/global-language-rows.js';
import { mountGlobalChoices } from '../modules/ui-system/settings/global-input-upgrades.js';
import { fieldProjection } from '../modules/ui-system/settings/field-registry.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://localhost/' });
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.HTMLElement = dom.window.HTMLElement;
global.MutationObserver = dom.window.MutationObserver;

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

test('quick-actions 直出 canonical 行：行语义类映射与样式标记保留（M5-b 试点）', () => {
    const { form } = renderIntoForm(quickActionsSection);
    const stackedItem = form.querySelector('#continueWritingPrompt').closest('.vcp-uiux-general-item');
    assert.ok(stackedItem, 'textarea 行应直出 canonical 行');
    assert.ok(stackedItem.classList.contains('vcp-uiux-general-row'));
    assert.ok(stackedItem.classList.contains('vcp-settings-row-stacked'), '历史堆叠类应按映射表保留');
    assert.equal(stackedItem.dataset.canonicalRow, 'true');
    assert.equal(stackedItem.dataset.settingPrimitive, 'general-item');
    assert.equal(stackedItem.getAttribute('data-vcp-style'), '37');
    assert.equal(form.querySelector('#continueWritingPrompt').getAttribute('data-vcp-style'), '38');
    assert.equal(form.querySelector('#flowlockContinueDelay').getAttribute('data-vcp-style'), '19');
    const switchItem = form.querySelector('#enableMiddleClickQuickAction').closest('.vcp-uiux-general-item');
    assert.ok(switchItem, '开关行应直出 canonical 行');
    assert.equal(switchItem.getAttribute('data-vcp-style'), '15');
    const container = form.querySelector('#middleClickQuickActionContainer');
    assert.equal(container.classList.contains('vcp-uiux-general-item'), true, '容器 id 穿越行语义映射');
    assert.equal(container.getAttribute('data-vcp-style'), '34');
    assert.equal(form.querySelector('#middleClickAdvancedSettings').getAttribute('data-vcp-style'), '41');
    assert.equal(form.querySelector('#middleClickAdvancedDelay').getAttribute('data-vcp-style'), '27');
    assert.ok(!form.querySelector('.vcp-settings-row, .vcp-settings-control-row, .form-group'), '旧包裹类不再输出');
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
    // 管理员行的历史样式标记（pass6 起 canonical 行直出，样式标记穿越映射）
    assert.equal(form.querySelector('#adminUsername').closest('.vcp-uiux-general-item').getAttribute('data-vcp-style'), '3');
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
    // M5-c pass2 起 output（#streamAnimationDurationValue）随步进器直出退役——
    // 旧管线里它本就被 NumericStepperRow 挂载的 replaceChildren 抹去。
    for (const id of ['enableSmoothStreaming', 'minChunkBufferSize', 'smoothStreamIntervalMs',
        'streamAnimationSettingsRow', 'streamAnimationPreset', 'streamAnimationDurationRow',
        'streamAnimationDurationMs', 'streamAnimationCustomRow',
        'streamAnimationCustomCss', 'fillStreamAnimationCssExample', 'replayStreamAnimationPreview',
        'streamAnimationPreviewElement']) {
        assert.ok(form.querySelector(`#${id}`), `missing #${id}`);
    }
    // 开关行：label+hint 在包裹 div 内（canonical 化不拆业务内部分组）
    const smoothRow = form.querySelector('#enableSmoothStreaming').closest('.vcp-uiux-general-item');
    assert.equal(smoothRow.getAttribute('data-vcp-style'), '15');
    assert.ok(smoothRow.querySelector(':scope > div > small'));
    // stepper 双控件内联行（M5-c pass2：直出 NumericStepperRow 终态结构，
    // 旧 cell label 由原语行内 title 承担，不再输出）
    const inlineRow = form.querySelector('#minChunkBufferSize').closest('.settings-inline-number-row');
    assert.ok(inlineRow.classList.contains('vcp-uiux-general-item'), '内联行直出 canonical 行（旧 form-group 类按映射退役）');
    const chunkInput = form.querySelector('#minChunkBufferSize');
    assert.equal(chunkInput.getAttribute('data-vcp-style'), '19');
    assert.equal(chunkInput.getAttribute('min'), '1');
    const chunkRow = chunkInput.closest('.vcp-uiux-numeric-stepper-row');
    assert.ok(chunkRow, 'stepper 直出行必须存在');
    assert.equal(chunkInput.parentElement, chunkRow, '业务 input 是步进行最后一个子节点');
    assert.equal(chunkRow.querySelector('.vcp-uiux-numeric-stepper-row-title').textContent, '最小渲染 Chunk 字数');
    assert.equal(chunkRow.querySelector('.vcp-uiux-numeric-stepper-row-description').textContent, '达到该字数才触发一次渲染（≥1）');
    assert.equal(chunkRow.querySelector('.vcp-uiux-numeric-stepper-row-unit').textContent, '字');
    assert.equal(chunkRow.querySelector(':scope > label'), null, 'cell 旧 label 不再输出');
    const chunkEditor = chunkRow.querySelector('.vcp-uiux-numeric-stepper-row-input');
    assert.equal(chunkEditor.getAttribute('aria-label'), '最小渲染 Chunk 字数');
    assert.equal(chunkEditor.getAttribute('min'), '1');
    assert.equal(chunkRow.querySelectorAll('.vcp-uiux-numeric-stepper-row-arrow').length, 2);
    assert.equal(form.querySelector('#smoothStreamIntervalMs').value, '100');
    // 预设 select hidden 且行 id 保留（canonical 行直出，id/data 锚点穿越）
    assert.equal(form.querySelector('#streamAnimationSettingsRow').classList.contains('vcp-uiux-general-item'), true);
    assert.equal(form.querySelector('#streamAnimationPreset').hidden, true);
    assert.equal(form.querySelector('#streamAnimationPreset').options.length, 6);
    // 滑杆（stepper 投影）：slider-container 内直出原语结构，output 退役
    const range = form.querySelector('#streamAnimationDurationMs');
    assert.equal(range.getAttribute('min'), '100');
    assert.equal(range.getAttribute('max'), '2000');
    const durationRow = range.closest('.vcp-uiux-numeric-stepper-row');
    assert.ok(durationRow, '滑杆步进行直出结构存在');
    assert.ok(range.closest('.slider-container'), 'slider-container 宿主保留');
    assert.equal(durationRow.querySelector('.vcp-uiux-numeric-stepper-row-unit').textContent, 'ms');
    assert.equal(form.querySelector('#streamAnimationDurationValue'), null, 'output 随直出退役');
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
    const debugRow = form.querySelector('#rustDebugMode').closest('.vcp-uiux-general-item');
    assert.equal(debugRow.getAttribute('data-vcp-style'), '23');
    const panel = form.querySelector('#rustDebugPanel');
    assert.equal(panel.parentElement, debugRow);
    assert.equal(panel.getAttribute('data-visible-when'), 'rustDebugMode');
    for (const spanId of ['assistantRuntimeMode', 'assistantRuntimeProcessPid', 'assistantRuntimeShowError']) {
        assert.ok(panel.querySelector(`#${spanId}`), `missing panel span #${spanId}`);
    }
    // 阈值行依赖子句与样式（canonical 行直出，row-copy 槽收纳 label+hint）
    const threshold = form.querySelector('#rustMinEventIntervalMs').closest('.vcp-uiux-general-item');
    assert.equal(threshold.getAttribute('data-vcp-style'), '26');
    assert.equal(threshold.getAttribute('data-visible-when'), 'rustUseAssistant && rustEnableCustomThresholds');
    assert.equal(form.querySelector('#rustMinEventIntervalMs').getAttribute('data-vcp-style'), '27');
    assert.equal(threshold.querySelector('.vcp-uiux-row-copy small').getAttribute('data-vcp-style'), '28');
    // 规则模式 select 与关键词 textarea
    assert.equal(form.querySelector('#rustRuleMode').getAttribute('data-vcp-style'), '30');
    assert.equal(form.querySelector('#rustRuleModeRow').getAttribute('data-vcp-style'), '29');
    assert.equal(form.querySelector('#rustRuleModeRow').getAttribute('data-visible-when'), 'rustUseAssistant');
    assert.equal(form.querySelector('#rustBlacklistKeywords').closest('.vcp-uiux-general-item').getAttribute('data-visible-when'),
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
    // 分段结构直出（M5-c pass5）：内层控制行保留历史类并叠加 choice 结构，
    // 外层行 pass6 起为 canonical 行。
    const innerRow = local.closest('.vcp-settings-control-row');
    assert.equal(innerRow.getAttribute('data-vcp-style'), '13');
    const group = local.closest('.vcp-uiux-general-item');
    assert.equal(group.getAttribute('data-vcp-style'), '32');
    assert.equal(group.querySelector(':scope > label').getAttribute('data-vcp-style'), '11');
    assert.equal(group.querySelector(':scope > label').textContent, '语音工作模式');
    assert.equal(group.querySelector(':scope > small').getAttribute('data-vcp-style'), '4');
    // 快捷键默认值与 url 占位
    assert.equal(form.querySelector('#voiceInputShortcut').value, 'F7');
    assert.equal(form.querySelector('#voiceLocalSovitsUrl').getAttribute('type'), 'url');
    assert.equal(form.querySelector('#voiceInputModeRow').classList.contains('vcp-uiux-general-item'), true);
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
    // 分隔线不再编译输出（M5-b）：canonical 行自带 hairline，投影 pass 本就
    // 挂载即删，画面零变化。
    assert.equal(host.querySelector('hr'), null, 'advancedDivider <hr> 停止输出');
    // M5-c pass6：表单图标直出——模型选择按钮直接产出 vcp-ui-icon 节点
    //（lucide-adapter 运行期渲染为 SVG），收编式 normalizeFormIcons 退役。
    const topicSummaryIcon = form.querySelector('#openTopicSummaryModelSelectBtn .vcp-ui-icon');
    assert.ok(topicSummaryIcon, '模型选择按钮应直出 vcp-ui-icon');
    assert.equal(topicSummaryIcon.textContent, 'chevron-down');
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
    assert.equal(radiusRow.className,
        'vcp-uiux-general-item vcp-uiux-general-row appearance-radius-language-host vcp-uiux-appearance-row',
        '宿主行直出 canonical 行（appearance 变体 + 历史宿主类保留）');
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
    // 寄语内容：整行 label 直出 canonical 行（label 行保留标签元素身份）
    const taglineRow = form.querySelector('label.vcp-uiux-general-item[for="homeVisualTagline"]');
    assert.ok(taglineRow.classList.contains('vcp-uiux-appearance-row'), 'appearance 分区 canonical 行为 appearance-row 变体');
    assert.equal(taglineRow.querySelector(':scope > span').textContent, '寄语内容');
    assert.equal(taglineRow.querySelector('#homeVisualTagline').getAttribute('maxlength'), '120');
});

test('appearance-settings：场景字体预览与呈现模式组件', () => {
    const { form, host } = renderIntoForm(appearanceSettingsSection);
    const appearanceChildren = [...host.children];
    const workbenchHost = appearanceChildren.find(node => node.id === 'appearanceSettingsWorkbenchCard');
    const presentationHost = appearanceChildren.find(node => node.contains(host.querySelector('input[name="chatPresentationMode"]')));
    const fontHost = appearanceChildren.find(node => node.contains(host.querySelector('#fontScenarioPreviewGrid')));
    assert.ok(appearanceChildren.indexOf(workbenchHost) < appearanceChildren.indexOf(presentationHost),
        '工作台应位于消息呈现模式之前');
    assert.ok(appearanceChildren.indexOf(presentationHost) < appearanceChildren.indexOf(fontHost),
        '消息呈现模式应位于四格字体预览之前');
    const homeDisclosure = form.querySelector('#homeVisualSettings');
    assert.equal(homeDisclosure?.tagName, 'DETAILS');
    assert.equal(homeDisclosure?.open, true);
    assert.equal(homeDisclosure.querySelectorAll('#showHomeVisualBrand, #showHomeVisualTagline, #homeVisualTagline').length, 3,
        '主页视觉文字、寄语开关和寄语内容应在同一可折叠框内');
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
    // 呈现模式：fieldset 三张 radio 卡，气泡默认选中（canonical 行直出，
    // 历史选择器类与样式标记穿越）
    const bubble = form.querySelector('#chatPresentationModeBubble');
    assert.equal(bubble.closest('fieldset').className,
        'vcp-uiux-general-item vcp-uiux-general-row chat-presentation-mode-selector vcp-uiux-appearance-row');
    assert.equal(bubble.value, 'bubble');
    assert.equal(bubble.checked, true);
    assert.equal(form.querySelector('#chatPresentationModePanel').checked, false);
    assert.equal(bubble.closest('fieldset').getAttribute('data-vcp-style'), '10');
});

test('appearance-settings：内容宽度单选组、气泡依赖行与宽屏数字组', () => {
    const { form, host } = renderIntoForm(appearanceSettingsSection);
    const widthRow = form.querySelector('#chatLayoutModeNormal').closest('.vcp-uiux-general-item');
    assert.equal(widthRow.getAttribute('data-vcp-style'), '12');
    assert.equal(widthRow.querySelector(':scope > .vcp-settings-control-row').getAttribute('data-vcp-style'), '13');
    assert.equal(widthRow.querySelector('label').getAttribute('data-vcp-style'), '11');
    assert.equal(form.querySelector('#chatLayoutModeNormal').checked, true);
    // 气泡依赖行：visible-when 子句与 hintInsideWrapper 结构（canonical 行直出）
    const bubbleRow = form.querySelector('#enableUserChatBubbleUi').closest('.vcp-uiux-general-item');
    assert.equal(bubbleRow.getAttribute('data-visible-when'), 'chatPresentationModeBubble');
    assert.ok(bubbleRow.querySelector(':scope > div > small'));
    const metaRow = form.querySelector('#userChatBubbleMetaSettings');
    assert.equal(metaRow.getAttribute('data-visible-when'), 'chatPresentationModeBubble && enableUserChatBubbleUi');
    // 宽屏数字组：三组 label+number，依赖两子句（canonical 行直出）
    const wideRow = form.querySelector('#chatBubbleMaxWidthWideDefault').closest('.vcp-uiux-general-item');
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

test('canonical 行直出结构完备（M5-b 试点结构，pass6 起全分区铺开）', () => {
    const { form } = renderIntoForm(quickActionsSection);
    const stackedItem = form.querySelector('#continueWritingPrompt').closest('.vcp-uiux-general-item');
    assert.ok(stackedItem, 'textarea 行应直出 canonical 行');
    assert.ok(stackedItem.classList.contains('vcp-uiux-general-row'));
    assert.ok(stackedItem.classList.contains('vcp-settings-row-stacked'));
    assert.equal(stackedItem.dataset.settingKey, 'continueWritingPrompt');
    assert.equal(stackedItem.dataset.settingsSectionKey, 'quick-actions');
    const copy = stackedItem.querySelector(':scope > .vcp-uiux-row-copy');
    assert.ok(copy, 'textarea 行应有 row-copy 槽');
    assert.equal(copy.dataset.settingPrimitive, 'row-copy');
    assert.equal(copy.querySelector('label').getAttribute('for'), 'continueWritingPrompt');
    assert.ok(copy.querySelector('small'), '提示应进 row-copy 槽');
    const switchRow = form.querySelector('#enableMiddleClickQuickAction').closest('.vcp-uiux-general-item');
    assert.ok(switchRow.querySelector(':scope > .vcp-uiux-row-copy label'));
    assert.ok(switchRow.querySelector(':scope > label.switch'));
    assert.ok(form.querySelector('#middleClickQuickActionContainer'), '容器 id 必须穿越直出');
    assert.equal(form.querySelectorAll('.form-group, .vcp-settings-row, .vcp-settings-control-row, .settings-form-group, .form-group-inline').length, 0,
        '试点分区不得残留旧包裹类');
});

const CONTROL_SELECTOR = 'input, select, textarea, button, [role="switch"]';

test('canonical 行直出全分区铺开，退役的 canonical-rows pass 空转（M5-c pass6 不变量）', () => {
    for (const sectionDescriptor of schemaSurfaceSections()) {
        const { form } = renderIntoForm(sectionDescriptor);
        // 旧包裹类零残留：与退役 pass 的守卫语义一致——嵌套在已达 canonical
        // 行内的控制行（radioGroup 内层）与尚无控件的空容器行（网络笔记路径
        // 容器，运行期才追加子行）不在 pass 候选内，允许保留旧类。
        const residue = [...form.querySelectorAll('.form-group, .vcp-settings-row, .vcp-settings-control-row, .settings-form-group, .form-group-inline')]
            .filter(row => row instanceof dom.window.HTMLElement)
            .filter(row => !row.closest('[data-canonical-row="true"]'))
            .filter(row => row.querySelector(CONTROL_SELECTOR));
        assert.equal(residue.length, 0,
            `${sectionDescriptor.key}：编译产物残留旧包裹类 ${residue.map(r => r.id || r.className).join(', ')}`);
        // 与退役 pass 同一候选清单：每个候选行都带 canonicalRow 已达标记。
        for (const row of form.querySelectorAll('[data-vcp-settings-row], [data-vcp-settings-control-row], .vcp-uiux-general-item, .vcp-uiux-general-row, .settings-form-group, .form-group-inline, .form-group')) {
            if (!(row instanceof dom.window.HTMLElement)) continue;
            if (!row.querySelector(CONTROL_SELECTOR)) continue;
            // 与退役 pass 的候选语义一致：嵌套在已达 canonical 行内的行不参与。
            if (row.dataset.canonicalRow !== 'true' && row.closest('[data-canonical-row="true"]')) continue;
            assert.equal(row.dataset.canonicalRow, 'true',
                `${sectionDescriptor.key}：#${row.id || row.dataset.settingKey || 'anonymous'} 行未直出 canonical 结构`);
        }
        // 分区 key 盖章穿越（appearance 分区行为 appearance-row 变体）。
        for (const item of form.querySelectorAll('.vcp-uiux-general-item')) {
            assert.equal(item.dataset.settingsSectionKey, sectionDescriptor.key,
                `${sectionDescriptor.key}：canonical 行缺分区 key`);
            if (sectionDescriptor.key === 'appearance-settings') {
                assert.equal(item.dataset.settingPrimitive, 'appearance-row');
                assert.ok(item.classList.contains('vcp-uiux-appearance-row'));
            }
        }
    }
});

test('开关行直出 Toggle 原语 holder（M5-c pass1：uiux-switches 退役）', () => {
    const { form } = renderIntoForm(quickActionsSection);
    const input = form.querySelector('#enableMiddleClickQuickAction');
    const wrap = input.closest('span.vcp-uiux-toggle');
    assert.ok(wrap, '开关 input 应被 vcp-uiux-toggle holder 直出包裹');
    assert.equal(wrap.parentElement.className, 'switch', 'holder 挂在 label.switch 下（mountToggle 产物同构）');
    const slider = wrap.parentElement.querySelector('span.slider.round');
    assert.ok(slider, '旧 slider 结构保留（结构映射契约）');
    assert.equal(slider.style.display, 'none', '旧 slider 内联隐藏（mountToggle 产物同构）');
    // typed toggle 收编字段（主页视觉双开关）保持原语就绪裸结构，
    // 运行时由 appearance-toggles 经真实 mountToggle 收编并注入 Toggle 样式表。
    const appearanceForm = renderIntoForm(appearanceSettingsSection).form;
    const brandInput = appearanceForm.querySelector('#showHomeVisualBrand');
    assert.ok(brandInput, '主页视觉开关存在');
    assert.equal(brandInput.closest('span.vcp-uiux-toggle'), null, 'toggle 收编字段不静态包裹');
    assert.equal(brandInput.parentElement.className, 'switch', '收编字段保持 label.switch 直接子级');
});

test('步进器行直出结构 + 激活行为绑定（M5-c pass2：stepper 投影/legacy-range 退役）', () => {
    // 测试用最小 scope：listen 直挂事件，own 记录释放项。
    const owned = [];
    const scope = {
        listen: (target, type, handler) => { target.addEventListener(type, handler); return () => target.removeEventListener(type, handler); },
        own: dispose => { owned.push(dispose); return dispose; },
    };
    const api = { activateNumericStepperRow };

    const { form } = renderIntoForm(renderSettingsSection);
    // canonical 行内已是原语终态结构：行为激活前编辑器为空、箭头可用。
    const range = form.querySelector('#streamAnimationDurationMs');
    const row = range.closest('.vcp-uiux-numeric-stepper-row');
    const editor = row.querySelector('.vcp-uiux-numeric-stepper-row-input');
    assert.equal(editor.value, '', '静态结构不预设现值（回填链负责）');
    assert.equal(editor.min, '100');
    assert.equal(editor.max, '2000');
    assert.equal(editor.step, '50');

    mountGlobalSteppers(form, api, scope);
    // 激活即同步呈现：业务值 500（schema 默认）镜像进编辑器，箭头按界启用。
    assert.equal(editor.value, '500');
    const [up, down] = row.querySelectorAll('.vcp-uiux-numeric-stepper-row-arrow');
    assert.equal(up.disabled, false);
    assert.equal(down.disabled, false);
    // 箭头步进写穿业务 input 并派发 input/change（保存链契约）。
    const events = [];
    range.addEventListener('input', () => events.push('input'));
    range.addEventListener('change', () => events.push('change'));
    up.click();
    assert.equal(range.value, '550');
    assert.equal(editor.value, '550');
    assert.deepEqual(events, ['input', 'change']);
    // vcp-uiux-sync（回填快照写值）镜像进编辑器。
    range.value = '1500';
    range.dispatchEvent(new dom.window.Event('vcp-uiux-sync'));
    assert.equal(editor.value, '1500');
    // 归一化：越界编辑收敛到界内并写回业务 input。
    editor.value = '99999';
    editor.dispatchEvent(new dom.window.Event('change'));
    assert.equal(range.value, '2000');
    assert.equal(editor.value, '2000');
    assert.equal(up.disabled, true, '上界处禁用增大箭头');

    // 幂等：重复激活不重复绑行为（一次点击只步进一次）。
    mountGlobalSteppers(form, api, scope);
    events.length = 0;
    down.click();
    assert.equal(range.value, '1950');
    assert.deepEqual(events, ['input', 'change']);

    // 快捷操作分区的分组步进器行同样直出 + 激活。
    const qa = renderIntoForm(quickActionsSection);
    const delayRow = qa.form.querySelector('#middleClickAdvancedDelay').closest('.vcp-uiux-numeric-stepper-row');
    assert.ok(delayRow, '分组步进器行直出结构存在');
    assert.equal(delayRow.parentElement.id, 'middleClickAdvancedSettings', '宿主行锚点保留');
    assert.equal(delayRow.parentElement.querySelector(':scope > small'), null, '旧 hint 被原语行取代');
    mountGlobalSteppers(qa.form, api, scope);
    const delayEditor = delayRow.querySelector('.vcp-uiux-numeric-stepper-row-input');
    assert.equal(delayEditor.min, '1000');
    assert.equal(delayEditor.max, '5000');
});


test('输入原语包裹直出结构（M5-c pass3：uiux-inputs 退役）', () => {
    const server = renderIntoForm(serverConnectionSection).form;
    for (const id of ['vcpServerUrl', 'vcpApiKey', 'vcpLogUrl', 'fileKey', 'vcpLogKey']) {
        const input = server.querySelector(`#${id}`);
        const wrap = input.closest('span.vcp-uiux-input-wrap');
        assert.ok(wrap, `#${id} 应被 Input 原语 wrap 直出包裹`);
        assert.equal(wrap.className, 'vcp-uiux-input-wrap wrap vcp-uiux-input-fill', `#${id} wrap 类名与 mountInput 产物一致`);
        assert.ok(input.classList.contains('input'), `#${id} 收编 input 类`);
        assert.equal(input.style.getPropertyPriority('height'), 'important', `#${id} 内联守卫样式带 important`);
        assert.equal(input.style.getPropertyValue('padding'), '0px 10px');
    }
    // 业务样式标记留在 input 上（wrap 不接管 data-vcp-style）。
    const quickDelay = renderIntoForm(quickActionsSection).form.querySelector('#flowlockContinueDelay');
    assert.equal(quickDelay.getAttribute('data-vcp-style'), '19');
    assert.ok(quickDelay.closest('span.vcp-uiux-input-wrap'));
    const voice = renderIntoForm(voiceSettingsSection).form;
    for (const id of ['voiceInputShortcut', 'voiceNetworkProviderUrl', 'voiceLocalSovitsKey']) {
        assert.ok(voice.querySelector(`#${id}`).closest('span.vcp-uiux-input-wrap'), `#${id} 应直出包裹`);
    }
    const advanced = renderIntoForm(advancedFeaturesSection).form;
    assert.ok(advanced.querySelector('#contextSanitizerDepth').closest('span.vcp-uiux-input-wrap'), '数字输入同样直出包裹');
    const selection = renderIntoForm(selectionAssistantSection).form;
    for (const id of ['rustMinEventIntervalMs', 'rustMinDistance', 'rustClipboardCheckIntervalMs']) {
        assert.ok(selection.querySelector(`#${id}`).closest('span.vcp-uiux-input-wrap'), `#${id} 应直出包裹`);
    }
    const quick = renderIntoForm(quickActionsSection).form;
    assert.ok(quick.querySelector('#flowlockContinueDelay').closest('span.vcp-uiux-input-wrap'), 'quick-actions 数字应直出包裹');    const appearance = renderIntoForm(appearanceSettingsSection).form;
    for (const id of ['chatBubbleMaxWidthWideDefault', 'chatBubbleMaxWidthWideNotifications', 'chatBubbleMaxWidthWideNarrow']) {
        assert.ok(appearance.querySelector(`#${id}`).closest('span.vcp-uiux-input-wrap'), `宽屏数字组 ${id} 应直出包裹`);
    }
    for (const id of ['chatFontCustom', 'chatCodeFontCustom', 'chatDiaryFontCustom', 'chatToolFontCustom']) {
        assert.ok(appearance.querySelector(`#${id}`).closest('span.vcp-uiux-input-wrap'), `场景字体自定义值 ${id} 应直出包裹`);
    }
    // raw 投影字段保持裸结构：chrome 归 typed owners 运行时收编。
    const identity = renderIntoForm(userIdentitySection).form;
    for (const [sectionForm, id] of [
        [appearance, 'homeVisualTagline'],
        [identity, 'adminUsername'], [identity, 'adminPassword'],
        [identity, 'userAvatarBorderColorText'],
        [identity, 'userNameTextColorText'],
    ]) {
        const control = sectionForm.querySelector(`#${id}`);
        assert.ok(control, `raw 字段 #${id} 存在`);
        assert.equal(control.closest('span.vcp-uiux-input-wrap'), null, `raw 投影字段 #${id} 不静态包裹`);
    }
    // 步进器/字号行编辑器保持原语内轻量代理，不被通用 wrap 套框。
    const render = renderIntoForm(renderSettingsSection).form;
    assert.equal(render.querySelector('#minChunkBufferSize').closest('span.vcp-uiux-input-wrap'), null, '步进器业务 input 不包裹');
    assert.equal(render.querySelector('.vcp-uiux-numeric-stepper-row-input').closest('span.vcp-uiux-input-wrap'), null, '步进器编辑器不包裹');
});

test('agent-name-wrapper 直出 Field 增强挂载产物（M5-c pass3：agent-name-fields 只剩行为绑定）', () => {
    const { form } = renderIntoForm(userIdentitySection);
    const wrapper = form.querySelector('.agent-name-wrapper');
    assert.ok(wrapper, '用户名行存在');
    assert.ok(wrapper.classList.contains('vcp-ui-settings-field'), 'Field 增强类直出');
    assert.equal(wrapper.dataset.state, 'error', '初始校验态直出（空 required 输入的挂载态）');
    const input = form.querySelector('#userName');
    assert.equal(input.getAttribute('aria-invalid'), 'true', 'aria-invalid 直出');
    const wrap = input.closest('span.vcp-uiux-input-wrap');
    assert.ok(wrap, 'userName 应被 Input 原语 wrap 直出包裹');
    assert.ok(wrap.classList.contains('vcp-uiux-input-fill'));
    assert.equal(wrap.previousElementSibling?.className, 'vcp-uiux-identity-name-display', 'wrap 顶替原 input 位置（display 与 label 之间）');
});

test('直出完备性：退役的通用包裹 pass 对全部编译产物空转（M5-c pass3 不变量）', () => {
    const selector = 'input:is(:not([type]), [type="text"], [type="url"], [type="password"], [type="number"], [type="email"], [type="search"], [type="tel"])';
    const rawProjection = new Set(['homeVisualTagline', 'userAvatarBorderColorText', 'userNameTextColorText', 'adminUsername', 'adminPassword']);
    for (const sectionDescriptor of schemaSurfaceSections()) {
        const { form } = renderIntoForm(sectionDescriptor);
        for (const control of form.querySelectorAll(selector)) {
            if (control.classList.contains('vcp-uiux-numeric-stepper-row-input')) continue;
            if (control.classList.contains('vcp-uiux-font-size-row-value')) continue;
            if (control.closest('.model-input-container')) continue;
            if (rawProjection.has(control.id)) continue;
            if (fieldProjection(control.id) === 'stepper') continue;
            assert.ok(control.closest('span.vcp-uiux-input-wrap'),
                `${sectionDescriptor.key}：#${control.id || control.name || '(anon)'} 应全部直出包裹（pass 空转不变量）`);
        }
    }
});

test('语言行/字号行直出结构（M5-c pass4：appearance-rows/语言行退役）', () => {
    // 裸 select 行：语言行结构与 select 同宿主直出（appearance 分区六行 + 侧栏圆角行）。
    const appearance = renderIntoForm(appearanceSettingsSection).form;
    const densityRow = appearance.querySelector('#appearanceDensityRow');
    const langRow = densityRow.querySelector(':scope > .vcp-uiux-language-row');
    assert.ok(langRow, '裸行内直出 .vcp-uiux-language-row');
    assert.equal(langRow.querySelector('.vcp-uiux-language-row-title').textContent, '界面密度');
    assert.equal(langRow.querySelector('.vcp-uiux-language-row-description').textContent, '调整设置页与工作区控件的疏密程度');
    const trigger = langRow.querySelector('.vcp-uiux-language-row-selector');
    assert.equal(trigger.type, 'button');
    // 首个子节点是标签文本节点（激活期 sync 原位改写），编译期取默认选项标签。
    const labelNode = [...trigger.childNodes].find(node => node.nodeType === 3);
    assert.equal(labelNode.textContent, '紧凑');
    const chevron = trigger.querySelector('svg.vcp-uiux-language-row-chevron');
    assert.equal(chevron.getAttribute('viewBox'), '0 0 14 14');
    assert.equal(chevron.querySelector('path').getAttribute('d'), 'M3 5L7 9L11 5');
    assert.ok(densityRow.querySelector('#appearanceDensity')?.hidden, '业务 select 保留在宿主内');

    // 圆角行：rowClass 宿主 + 自有文案。
    const radiusLangRow = appearance.querySelector('#appearanceSidebarRadiusLanguageRow > .vcp-uiux-language-row');
    assert.equal(radiusLangRow.querySelector('.vcp-uiux-language-row-title').textContent, '列表项圆角');

    // 字号行：结构整体直出，select 挂进行内（mount 的 replaceChildren 终态）。
    const fontScaleRow = appearance.querySelector('#appearanceFontScaleRow');
    const fsRow = fontScaleRow.querySelector(':scope > .vcp-uiux-font-size-row');
    assert.ok(fsRow, '字号行直出结构存在');
    assert.equal(fsRow.querySelector('.vcp-uiux-font-size-row-title').textContent, '字号');
    assert.equal(fsRow.querySelector('.vcp-uiux-font-size-row-description').textContent, '调整界面文字大小');
    const fsEditor = fsRow.querySelector('.vcp-uiux-font-size-row-value');
    assert.equal(fsEditor.min, '13');
    assert.equal(fsEditor.max, '16');
    assert.equal(fsEditor.dataset.vcpAppearanceDraftControl, 'true');
    assert.equal(fsRow.querySelector('#appearanceFontScale').dataset.vcpAppearanceDraftControl, 'true');
    assert.equal(fsRow.querySelector('.vcp-uiux-font-size-row-unit').textContent, 'px');
    const [fsUp, fsDown] = fsRow.querySelectorAll('.vcp-uiux-font-size-row-arrow');
    assert.equal(fsUp.getAttribute('aria-label'), '增大字号');
    assert.equal(fsDown.getAttribute('aria-label'), '减小字号');
    assert.equal(fontScaleRow.querySelector(':scope > select'), null, 'select 移入行内，宿主只剩行');

    // 场景字体行：widgets 直出（宿主 id 不变）。
    const chatLangRow = appearance.querySelector('#chatFontPresetRow > .vcp-uiux-language-row');
    assert.equal(chatLangRow.querySelector('.vcp-uiux-language-row-title').textContent, '聊天字体');
    assert.equal([...chatLangRow.querySelector('.vcp-uiux-language-row-selector').childNodes]
        .find(node => node.nodeType === 3).textContent, '系统默认');

    // 全局语言行：分组行 select + hint + 语言行（与旧 mount 追加位置一致）。
    const voice = renderIntoForm(voiceSettingsSection).form;
    const voiceRow = voice.querySelector('#voiceInputModeRow');
    const voiceLangRow = voiceRow.querySelector(':scope > .vcp-uiux-language-row');
    assert.ok(voiceLangRow);
    assert.equal(voiceLangRow.querySelector('.vcp-uiux-language-row-title').textContent, '语音输入模式');
    assert.equal([...voiceLangRow.querySelector('.vcp-uiux-language-row-selector').childNodes]
        .find(node => node.nodeType === 3).textContent, 'Windows 语音键入（Win+H）');
    assert.ok(voiceRow.contains(voiceLangRow) && voiceLangRow.previousElementSibling === voiceRow.querySelector('#voiceInputMode'),
        '语言行紧跟业务 select（旧 mount 追加位置）');

    const render = renderIntoForm(renderSettingsSection).form;
    const streamLangRow = render.querySelector('#streamAnimationSettingsRow > .vcp-uiux-language-row');
    assert.equal(streamLangRow.querySelector('.vcp-uiux-language-row-title').textContent, '流式内容动效');

    const selection = renderIntoForm(selectionAssistantSection).form;
    const agentLangRow = selection.querySelector('#assistantAgentContainer > .vcp-uiux-language-row');
    assert.equal([...agentLangRow.querySelector('.vcp-uiux-language-row-selector').childNodes]
        .find(node => node.nodeType === 3).textContent, '请选择一个Agent', '空值回落到占位选项标签');
    assert.equal(selection.querySelector('#rustRuleModeRow > .vcp-uiux-language-row .vcp-uiux-language-row-title').textContent, '规则模式');
    // rustRuleMode 行带 hint：select + hint + 语言行的次序与旧 mount 一致。
    assert.ok(selection.querySelector('#rustRuleModeRow > small'), 'hint 保留在语言行之前');

    const quick = renderIntoForm(quickActionsSection).form;
    const middleLangRow = quick.querySelector('#middleClickQuickActionContainer > .vcp-uiux-language-row');
    assert.ok(middleLangRow, '容器宿主语言行直出（canonical 分区同样成立）');
    assert.equal(middleLangRow.querySelector('.vcp-uiux-language-row-title').textContent, '中键快速执行功能');
});

test('语言行/字号行激活行为绑定（M5-c pass4：运行期只剩行为）', async () => {
    const owned = [];
    const scope = {
        listen: (target, type, handler) => { target.addEventListener(type, handler); return () => target.removeEventListener(type, handler); },
        own: dispose => { owned.push(dispose); return dispose; },
        child: () => scope,
        dispose: async () => {},
        active: true,
    };
    const api = { activateLanguageRow, activateFontSizeRow };

    const appearance = renderIntoForm(appearanceSettingsSection).form;
    mountGlobalLanguageRows(appearance, api, scope);
    // 字号行激活即同步 px 读数（编译默认取首选项 small → 13px）。
    const fsEditor = appearance.querySelector('.vcp-uiux-font-size-row-value');
    assert.equal(fsEditor.value, '13');
    const fsSelect = appearance.querySelector('#appearanceFontScale');
    fsSelect.value = 'large';
    fsSelect.dispatchEvent(new dom.window.Event('vcp-uiux-sync'));
    assert.equal(fsEditor.value, '16');

    // 语言行激活：vcp-uiux-sync（回填快照写值）镜像进胶囊标签。
    const densityTrigger = appearance.querySelector('#appearanceDensityRow .vcp-uiux-language-row-selector');
    assert.equal([...densityTrigger.childNodes].find(node => node.nodeType === 3).textContent, '紧凑');
    const densitySelect = appearance.querySelector('#appearanceDensity');
    densitySelect.value = 'comfortable';
    densitySelect.dispatchEvent(new dom.window.Event('vcp-uiux-sync'));
    assert.equal([...densityTrigger.childNodes].find(node => node.nodeType === 3).textContent, '舒适');

    // 菜单选择写穿业务 select 并派发 change（保存链契约）。
    densityTrigger.click();
    const menuItem = [...doc.querySelectorAll('.vcp-uiux-menu-item')]
        .find(item => item.textContent.includes('宽松'));
    assert.ok(menuItem, '菜单挂载并渲染选项');
    const changes = [];
    densitySelect.addEventListener('change', () => changes.push(densitySelect.value));
    menuItem.click();
    assert.equal(densitySelect.value, 'relaxed');
    assert.deepEqual(changes, ['relaxed']);

    // 幂等：重复激活不重复绑行为（镜像只收敛一次）。
    mountGlobalLanguageRows(appearance, api, scope);
    densitySelect.value = 'compact';
    densitySelect.dispatchEvent(new dom.window.Event('vcp-uiux-sync'));
    assert.equal([...densityTrigger.childNodes].find(node => node.nodeType === 3).textContent, '紧凑');

    // 全部直出行激活覆盖：每个语言行/字号行宿主的 select 都已打收编标记。
    const activatedSelects = [...appearance.querySelectorAll('.vcp-uiux-language-row, .vcp-uiux-font-size-row')]
        .map(row => (row.classList.contains('vcp-uiux-font-size-row') ? row : row.parentElement).querySelector('select'));
    assert.ok(activatedSelects.length >= 11, 'appearance 分区的语言行/字号行全部直出');
    for (const select of activatedSelects) {
        assert.equal(select.dataset.vcpTypedPrimitiveMounted, 'true', `#${select.id} 已激活`);
    }

    // 动态选项重建：MutationObserver 镜像重建（划词 Agent 列表填充路径）。
    const selection = renderIntoForm(selectionAssistantSection).form;
    mountGlobalLanguageRows(selection, api, scope);
    const agentSelect = selection.querySelector('#assistantAgent');
    const agentTrigger = selection.querySelector('#assistantAgentContainer .vcp-uiux-language-row-selector');
    const option = doc.createElement('option');
    option.value = 'agent-1';
    option.textContent = '测试 Agent';
    agentSelect.append(option);
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
    agentSelect.value = 'agent-1';
    agentSelect.dispatchEvent(new dom.window.Event('change'));
    assert.equal([...agentTrigger.childNodes].find(node => node.nodeType === 3).textContent, '测试 Agent',
        '选项列表重建后胶囊镜像新选项');
});

test('直出完备性：退役的语言行/字号行 pass 对全部编译产物空转（M5-c pass4 不变量）', () => {
    const owned = [];
    const scope = {
        listen: (target, type, handler) => { target.addEventListener(type, handler); return () => target.removeEventListener(type, handler); },
        own: dispose => { owned.push(dispose); return dispose; },
        child: () => scope,
        dispose: async () => {},
        active: true,
    };
    const api = { activateLanguageRow, activateFontSizeRow };
    for (const sectionDescriptor of schemaSurfaceSections()) {
        const { form } = renderIntoForm(sectionDescriptor);
        mountGlobalLanguageRows(form, api, scope);
        // 任何语言行宿主/字号行都必须已激活；反之，不存在"看起来是语言行
        // 宿主（裸 select 行）却没有任何直出行"的残留（退役 pass 无可挂载对象）。
        for (const row of form.querySelectorAll('[data-vcp-settings-row]')) {
            const select = row.querySelector('select');
            if (!select) continue;
            const structure = row.querySelector(':scope > .vcp-uiux-language-row, :scope > .vcp-uiux-font-size-row');
            if (structure) {
                assert.equal(select.dataset.vcpTypedPrimitiveMounted, 'true',
                    `${sectionDescriptor.key}：#${select.id} 的直出行未激活`);
            }
        }
    }
});

test('分段（Choice）直出结构（M5-c pass5：choice-controls 退役）', () => {
    // 语音工作模式：内层控制行在编译期获得 mountChoice 终态类与初值。
    const voice = renderIntoForm(voiceSettingsSection);
    const voiceRow = voice.form.querySelector('#voiceModeLocal').closest('.vcp-uiux-choice');
    assert.ok(voiceRow, '语音单选组内层行直出 vcp-uiux-choice 类');
    assert.equal(voiceRow.dataset.value, 'local', 'dataset.value 取编译期 checked 值');
    const voiceOptions = [...voiceRow.querySelectorAll('label')].filter(label => label.querySelector('input[type="radio"]'));
    assert.equal(voiceOptions.length, 2);
    for (const label of voiceOptions) {
        assert.equal(label.classList.contains('vcp-uiux-choice-option'), true, 'radio 标签直出分段选项类');
    }
    // 内容宽度单选组：同一构建器直出，初值 normal。
    const appearance = renderIntoForm(appearanceSettingsSection);
    const layoutRow = appearance.form.querySelector('#chatLayoutModeNormal').closest('.vcp-uiux-choice');
    assert.ok(layoutRow, '内容宽度单选组内层行直出 vcp-uiux-choice 类');
    assert.equal(layoutRow.dataset.value, 'normal');
    assert.equal(layoutRow.querySelector('label.vcp-uiux-choice-option input')?.id, 'chatLayoutModeNormal');
    // hint 次序与既有结构不变（分段类只在控制行上，行文案不受影响）。
    assert.ok(layoutRow.nextElementSibling === null || !layoutRow.nextElementSibling.classList.contains('vcp-uiux-choice-option'));
});

test('分段激活行为绑定（M5-c pass5：运行期只剩 dataset.value 重推导）', () => {
    const owned = [];
    const scope = {
        listen: (target, type, handler) => { target.addEventListener(type, handler); return () => target.removeEventListener(type, handler); },
        own: dispose => { owned.push(dispose); return dispose; },
        child: () => scope,
        dispose: async () => {},
        active: true,
    };
    const { form } = renderIntoForm(voiceSettingsSection);
    mountGlobalChoices(form, { activateChoice }, scope);
    const row = form.querySelector('#voiceModeLocal').closest('.vcp-uiux-choice');
    assert.equal(row.dataset.vcpTypedPrimitiveMounted, 'true', '激活后打标');

    // 用户驱动的 change：dataset.value 重推导。
    const network = form.querySelector('#voiceModeNetwork');
    network.checked = true;
    network.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(row.dataset.value, 'network');

    // 宿主驱动的快照回放（vcp-uiux-sync）同样收敛。
    const local = form.querySelector('#voiceModeLocal');
    local.checked = true;
    local.dispatchEvent(new dom.window.Event('vcp-uiux-sync', { bubbles: true }));
    assert.equal(row.dataset.value, 'local');

    // 重复激活幂等：标记在位即跳过，监听不翻倍。
    const listenCount = owned.length;
    mountGlobalChoices(form, { activateChoice }, scope);
    assert.equal(owned.length, listenCount);
    network.checked = true;
    network.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(row.dataset.value, 'network');
});

test('直出完备性：select-projection 与 choice-controls 对全部编译产物空转（M5-c pass5 不变量）', () => {
    const owned = [];
    const scope = {
        listen: (target, type, handler) => { target.addEventListener(type, handler); return () => target.removeEventListener(type, handler); },
        own: dispose => { owned.push(dispose); return dispose; },
        child: () => scope,
        dispose: async () => {},
        active: true,
    };
    const api = { activateLanguageRow, activateFontSizeRow, activateChoice };
    for (const sectionDescriptor of schemaSurfaceSections()) {
        const { form } = renderIntoForm(sectionDescriptor);
        // 与管线同序：行为激活（global-pill-steppers/global-typed-primitives）
        // 之后，select-projection 应无任何未打标 select 可投影。
        mountGlobalLanguageRows(form, api, scope);
        mountGlobalChoices(form, api, scope);
        for (const select of form.querySelectorAll('select')) {
            assert.equal(select.dataset.vcpTypedPrimitiveMounted, 'true',
                `${sectionDescriptor.key}：#${select.id} 未被直出结构激活，select-projection 将有可投影对象`);
        }
        for (const row of form.querySelectorAll('.vcp-uiux-choice')) {
            assert.equal(row.dataset.vcpTypedPrimitiveMounted, 'true',
                `${sectionDescriptor.key}：分段行未激活，choice-controls 将有可挂载对象`);
        }
    }
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

test('schema-surface：原地替换且幂等，现值由投影层回填', () => {
    const form = doc.createElement('form');
    const host = doc.createElement('div');
    host.id = 'section-quick-actions';
    host.className = 'settings-section';
    const staleRow = doc.createElement('div');
    staleRow.className = 'vcp-settings-row';
    const staleInput = doc.createElement('input');
    staleInput.id = 'flowlockContinueDelay';
    staleRow.append(staleInput);
    host.append(staleRow);
    form.append(host);
    const hostIdentity = host;

    // M4 起 schema 面转正：直接渲染并保持分区元素身份；替换是声明式的，
    // 不做静态面时代的快照采集/回填（持久值由 typed-field-owners 投影按 id 回填）。
    assert.ok(schemaSurfaceSections().some(s => s.key === 'quick-actions'));
    const replaced = applySchemaSurface(form, doc);
    assert.deepEqual(replaced, ['quick-actions']);
    assert.equal(host, hostIdentity, '分区元素身份必须保持');
    assert.equal(host.dataset.vcpSchemaRendered, 'true');
    assert.ok(host.querySelector('.settings-section-title'), '渲染后应有标题');
    assert.ok(host.querySelector('#middleClickQuickActionContainer'), '渲染后应有业务容器');
    assert.ok(form.querySelector('#flowlockContinueDelay'), '陈旧静态行被 schema 行取代');
    form.querySelector('#flowlockContinueDelay').value = '77';
    assert.deepEqual(applySchemaSurface(form, doc), [], '重复 refresh 不重渲染');
    assert.equal(form.querySelector('#flowlockContinueDelay').value, '77');
});

test('schema-surface：渲染产物为动态填充留出业务锚点', () => {
    const form = doc.createElement('form');
    const host = doc.createElement('div');
    host.id = 'section-selection-assistant';
    host.className = 'settings-section';
    form.append(host);

    assert.deepEqual(applySchemaSurface(form, doc), ['selection-assistant']);
    // 运行时选项/子行由各自服务在渲染之后填充（populate、addNetworkPathInput）。
    assert.ok(form.querySelector('#assistantAgentContainer'), '助手选择容器锚点存在');
    assert.ok(form.querySelector('#rustDebugPanel'), '渲染产物其余行正常');
    assert.deepEqual(applySchemaSurface(form, doc), [], '重复 refresh 不重渲染');
});
