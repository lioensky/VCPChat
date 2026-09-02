// render/widgets — M1 分区里的专属组件标记构建器。
// 这些块（头像资料卡、折叠样式区、调试面板、动画示例/预览、外观工作台卡、
// 字体场景预览、呈现模式选择器）是自包含组件而非普通字段：标记逐字对齐
// main.html 静态版本，由既有增强（avatar-picker、identity-name 编辑器、
// uiux-disclosures、identity-controls、动画预览监听、语言行/分段激活）
// 按类名/id 接管。后续阶段组件化后从这里收编。
import { buildFormIcon, el } from './shared.js';
import { buildInputPrimitiveWrap, buildLanguageRowStructure } from './field-renderer.js';

export function buildUserProfileCard(doc) {
    const card = el(doc, 'div', 'vcp-uiux-user-profile-card');
    card.dataset.vcpSettingsRow = 'true';
    const main = el(doc, 'div', 'agent-identity-main');
    main.dataset.vcpSettingsRow = 'true';
    const avatarWrapper = el(doc, 'div', 'agent-avatar-wrapper');
    const img = doc.createElement('img');
    img.id = 'userAvatarPreview';
    img.src = 'assets/default_user_avatar.png';
    img.alt = '用户头像预览';
    img.className = 'agent-avatar-display';
    img.setAttribute('data-vcp-style', '1');
    const overlay = doc.createElement('label');
    overlay.setAttribute('for', 'userAvatarInput');
    overlay.className = 'avatar-upload-overlay';
    // M5-c pass6：表单图标直出（原 form-icons pass 收编为 vcp-ui-icon 节点，
    // 由 lucide-adapter 统一渲染为相机图标）。
    overlay.append(buildFormIcon(doc, 'camera'));
    const fileInput = doc.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'userAvatarInput';
    fileInput.name = 'userAvatar';
    fileInput.accept = 'image/png, image/jpeg, image/gif';
    fileInput.setAttribute('data-vcp-style', '2');
    avatarWrapper.append(img, overlay, fileInput);
    main.append(avatarWrapper);
    const nameWrapper = el(doc, 'div', 'agent-name-wrapper vcp-ui-settings-field');
    // M5-c pass3：Field 增强的挂载产物（vcp-ui-settings-field 类 + 初始校验
    // 态）在编译期就地产出；运行期 agent-name-fields 步只剩校验态行为绑定
    // （invalid/input/change → data-state/aria-invalid 重同步）。
    nameWrapper.dataset.state = 'error';
    const nameLabel = doc.createElement('label');
    nameLabel.setAttribute('for', 'userName');
    nameLabel.textContent = '用户名:';
    const nameDisplay = el(doc, 'div', 'vcp-uiux-identity-name-display');
    const nameValue = el(doc, 'span', 'vcp-uiux-identity-name-value');
    nameValue.textContent = '用户';
    const editButton = doc.createElement('button');
    editButton.type = 'button';
    editButton.className = 'vcp-uiux-identity-name-edit';
    editButton.setAttribute('aria-label', '修改用户名');
    editButton.setAttribute('title', '修改用户名');
    const editIcon = el(doc, 'span', 'vcp-ui-icon');
    editIcon.setAttribute('aria-hidden', 'true');
    editIcon.textContent = 'edit';
    editButton.append(editIcon);
    const cancelButton = doc.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'vcp-uiux-identity-name-cancel';
    cancelButton.setAttribute('aria-label', '取消修改用户名');
    cancelButton.setAttribute('title', '取消修改用户名');
    cancelButton.hidden = true;
    const cancelIcon = el(doc, 'span', 'vcp-ui-icon');
    cancelIcon.setAttribute('aria-hidden', 'true');
    cancelIcon.textContent = 'x';
    cancelButton.append(cancelIcon);
    nameDisplay.append(nameValue, editButton, cancelButton);
    const nameInput = doc.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'userName';
    nameInput.name = 'userName';
    nameInput.placeholder = '您的用户名';
    nameInput.required = true;
    nameInput.setAttribute('aria-invalid', 'true');
    nameWrapper.append(nameLabel, nameDisplay, buildInputPrimitiveWrap(doc, nameInput));
    main.append(nameWrapper);
    card.append(main, buildUserStyleCollapsible(doc));
    return card;
}

function buildUserStyleCollapsible(doc) {
    const container = el(doc, 'div', 'agent-style-collapsible-container collapsed');
    container.dataset.vcpSettingsRow = 'true';
    // M5-c pass6：折叠区静态标记直出（原 uiux-disclosures 步的收编循环），
    // 运行期只剩 aria/collapse 行为绑定。
    container.dataset.settingPrimitive = 'disclosure';
    const header = el(doc, 'div', 'style-collapse-header vcp-uiux-disclosure-row');
    header.id = 'userStyleCollapseHeader';
    const icon = el(doc, 'span', 'style-collapse-icon');
    icon.textContent = '▶';
    const title = el(doc, 'span', 'style-collapse-title');
    title.textContent = '自定义样式设置';
    header.append(icon, title);
    const controls = el(doc, 'div', 'agent-style-controls');
    controls.append(
        buildColorPairItem(doc, 'userAvatarBorderColor', 'userAvatarBorderColorText', '头像外框颜色:', '#3d5a80', '头像外框颜色十六进制值'),
        buildColorPairItem(doc, 'userNameTextColor', 'userNameTextColorText', '名称文字颜色:', '#ffffff', '名称文字颜色十六进制值'),
        buildResetColorsItem(doc),
    );
    container.append(header, controls);
    return container;
}

function buildColorPairItem(doc, colorId, textId, labelText, defaultValue, ariaLabel) {
    const item = el(doc, 'div', 'style-control-item');
    const label = doc.createElement('label');
    label.setAttribute('for', colorId);
    label.textContent = labelText;
    const group = el(doc, 'div', 'color-input-group');
    const color = doc.createElement('input');
    color.type = 'color';
    color.id = colorId;
    color.name = colorId;
    color.value = defaultValue;
    const text = doc.createElement('input');
    text.type = 'text';
    text.id = textId;
    text.placeholder = defaultValue;
    text.maxLength = 7;
    text.setAttribute('aria-label', ariaLabel);
    group.append(color, text);
    item.append(label, group);
    return item;
}

function buildResetColorsItem(doc) {
    const item = el(doc, 'div', 'style-control-item full-width');
    const button = doc.createElement('button');
    button.type = 'button';
    button.id = 'resetUserAvatarColorsBtn';
    button.className = 'reset-colors-btn';
    button.setAttribute('aria-label', '重置为头像默认颜色');
    button.setAttribute('title', '重置为头像默认颜色');
    button.append(buildFormIcon(doc, 'refresh'));
    item.append(button);
    return item;
}

export function buildRustDebugPanel(doc) {
    const panel = el(doc, 'div', '', 22);
    panel.id = 'rustDebugPanel';
    panel.setAttribute('data-visible-when', 'rustDebugMode');
    const rows = [
        ['当前生效实现:', 'assistantRuntimeMode', '未知'],
        ['监听状态:', 'assistantRuntimeActive', '未知'],
        ['期望实现:', 'assistantRuntimeDesiredMode', '未知'],
        ['最近诊断:', 'assistantRuntimeDebugReason', '无'],
        ['Rust事件转发数:', 'assistantRuntimeForwardedCount', '0'],
        ['Rust监听活跃(sidecar):', 'assistantRuntimeSidecarActive', '未知'],
        ['Rust进程状态:', 'assistantRuntimeProcessAlive', '未知'],
        ['Rust进程PID:', 'assistantRuntimeProcessPid', '未知'],
        ['自动回退次数:', 'assistantRuntimeAutoFallbackCount', '0'],
        ['最近自动回退原因:', 'assistantRuntimeAutoFallbackReason', '无'],
        ['主进程收到选区数:', 'assistantRuntimeReceivedCount', '0'],
        ['弹窗尝试次数:', 'assistantRuntimeShowAttemptCount', '0'],
        ['最近弹窗错误:', 'assistantRuntimeShowError', '无'],
    ];
    for (const [labelText, spanId, initial] of rows) {
        const line = doc.createElement('div');
        const strong = doc.createElement('strong');
        strong.textContent = labelText;
        const span = doc.createElement('span');
        span.id = spanId;
        span.textContent = initial;
        line.append(strong, ' ', span);
        panel.append(line);
    }
    return panel;
}

export function buildStreamAnimationCustomExample(doc) {
    const example = el(doc, 'div', 'stream-animation-custom-example');
    const heading = el(doc, 'div', 'stream-animation-custom-example-heading');
    const strong = doc.createElement('strong');
    strong.textContent = '定义示例';
    const fillButton = doc.createElement('button');
    fillButton.type = 'button';
    fillButton.id = 'fillStreamAnimationCssExample';
    fillButton.className = 'small-button';
    fillButton.textContent = '填入示例';
    heading.append(strong, fillButton);
    const pre = doc.createElement('pre');
    const code = doc.createElement('code');
    code.textContent = 'opacity: 0;\ntransform: translateY(12px) scale(0.98);\nfilter: blur(3px);\ntransform-origin: center bottom;';
    pre.append(code);
    const note = doc.createElement('small');
    note.textContent = '保存后，每个新内容块会从上述状态过渡到正常状态；动画时长仍由上方滑杆统一控制。';
    example.append(heading, pre, note);
    return example;
}

export function buildStreamAnimationPreview(doc) {
    const preview = el(doc, 'div', 'stream-animation-preview');
    preview.setAttribute('aria-labelledby', 'streamAnimationPreviewTitle');
    const toolbar = el(doc, 'div', 'stream-animation-preview-toolbar');
    const titleBlock = doc.createElement('div');
    const title = doc.createElement('strong');
    title.id = 'streamAnimationPreviewTitle';
    title.textContent = '动画预览';
    const titleHint = doc.createElement('small');
    titleHint.textContent = '预览会使用当前未保存的选项';
    titleBlock.append(title, titleHint);
    const replayButton = doc.createElement('button');
    replayButton.type = 'button';
    replayButton.id = 'replayStreamAnimationPreview';
    replayButton.className = 'small-button';
    const glyph = doc.createElement('span');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '↻';
    replayButton.append(glyph, ' 重新播放');
    toolbar.append(titleBlock, replayButton);
    const stage = el(doc, 'div', 'stream-animation-preview-stage');
    const message = el(doc, 'div', 'stream-animation-preview-message');
    message.id = 'streamAnimationPreviewElement';
    const avatar = el(doc, 'span', 'stream-animation-preview-avatar');
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = 'AI';
    const content = doc.createElement('span');
    const contentTitle = doc.createElement('strong');
    contentTitle.textContent = '流式内容块';
    const contentHint = doc.createElement('small');
    contentHint.textContent = '这是一段新生成的回复内容。';
    content.append(contentTitle, contentHint);
    message.append(avatar, content);
    stage.append(message);
    preview.append(toolbar, stage);
    return preview;
}

// 外观工作台入口卡：appearance-studio 读 data-appearance-summary-* 写摘要、
// settings-bridge 绑定 openAppearanceStudioFromSettings 打开工作台。
export function buildAppearanceWorkbenchCard(doc) {
    const card = el(doc, 'div', 'appearance-workbench-card');
    card.id = 'appearanceSettingsWorkbenchCard';
    const preview = el(doc, 'div', 'appearance-workbench-preview');
    preview.setAttribute('data-appearance-summary-preview', '');
    preview.setAttribute('aria-hidden', 'true');
    preview.append(el(doc, 'span', 'appearance-workbench-preview-rail'));
    const previewContent = el(doc, 'span', 'appearance-workbench-preview-content');
    for (let i = 0; i < 3; i += 1) previewContent.append(doc.createElement('i'));
    preview.append(previewContent);
    const copy = el(doc, 'div', 'appearance-workbench-copy');
    const eyebrow = el(doc, 'span', 'appearance-workbench-eyebrow');
    eyebrow.textContent = '可视化工作台';
    const title = doc.createElement('strong');
    title.setAttribute('data-appearance-summary-title', '');
    title.textContent = '自定义外观';
    const description = doc.createElement('p');
    description.setAttribute('data-appearance-summary-description', '');
    description.textContent = '集中预览并调整主题、布局与聊天呈现。';
    const chips = el(doc, 'div', 'appearance-workbench-chips');
    chips.setAttribute('aria-label', '当前外观摘要');
    const chipValues = [
        ['data-appearance-summary-density', '舒适'],
        ['data-appearance-summary-radius', '中圆角'],
        ['data-appearance-summary-presentation', '气泡'],
    ];
    for (const [attr, text] of chipValues) {
        const chip = doc.createElement('span');
        chip.setAttribute(attr, '');
        chip.textContent = text;
        chips.append(chip);
    }
    copy.append(eyebrow, title, description, chips);
    const openButton = doc.createElement('button');
    openButton.type = 'button';
    openButton.className = 'appearance-workbench-open';
    openButton.id = 'openAppearanceStudioFromSettings';
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'appearance-workbench-open-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M2 14h4', 'M10 8h4', 'M18 16h4']) {
        const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        svg.append(path);
    }
    const openLabel = doc.createElement('span');
    openLabel.textContent = '打开工作台';
    openButton.append(svg, openLabel);
    card.append(preview, copy, openButton);
    return card;
}

// 场景字体预览行：四张预览卡（正文/代码/日记/工具），卡内的字体 preset
// select 与自定义值 input 由 mountChatFontRows 与既有输入增强接管；
// 8 个业务控件通过 custom 的 captureKeys 参与现值快照。
const SCENARIO_FONT_OPTIONS = {
    chat: [
        ['system', '系统默认'], ['segoe', 'Segoe UI'], ['ubuntu', 'Ubuntu'],
        ['yahei', 'Microsoft YaHei'], ['pingfang', 'PingFang SC'],
        ['source-han', 'Source Han Sans SC'], ['serif', '衬线体'], ['custom', '自定义'],
    ],
    code: [
        ['cascadia', 'Cascadia Code'], ['fira', 'Fira Code'], ['consolas', 'Consolas'],
        ['system', '系统默认'], ['jetbrains', 'JetBrains Mono'], ['monaspace', 'Monaspace'],
        ['custom', '自定义'],
    ],
    diary: [
        ['serif', '衬线体'], ['system', '系统默认'], ['segoe', 'Segoe UI'],
        ['ubuntu', 'Ubuntu'], ['yahei', 'Microsoft YaHei'], ['pingfang', 'PingFang SC'],
        ['source-han', 'Source Han Sans SC'], ['custom', '自定义'],
    ],
    tool: [
        ['system', '系统默认'], ['segoe', 'Segoe UI'], ['ubuntu', 'Ubuntu'],
        ['yahei', 'Microsoft YaHei'], ['pingfang', 'PingFang SC'],
        ['source-han', 'Source Han Sans SC'], ['cascadia', 'Cascadia Code'],
        ['fira', 'Fira Code'], ['consolas', 'Consolas'], ['jetbrains', 'JetBrains Mono'],
        ['monaspace', 'Monaspace'], ['serif', '衬线体'], ['custom', '自定义'],
    ],
};

function buildScenarioFontControls(doc, { presetRowId, presetId, optionKey, customRowId, customId, placeholder, ariaLabel, langRow }) {
    const presetRow = doc.createElement('div');
    presetRow.id = presetRowId;
    const select = doc.createElement('select');
    select.id = presetId;
    select.name = presetId;
    select.hidden = true;
    const options = SCENARIO_FONT_OPTIONS[optionKey];
    for (const [value, label] of options) {
        const option = doc.createElement('option');
        option.value = value;
        option.textContent = label;
        select.append(option);
    }
    presetRow.append(select);
    // M5-c pass4：场景字体的语言行结构直出（mountChatFontRows 退役，运行期
    // 只剩 global-language-rows 的行为激活）。
    if (langRow) {
        presetRow.append(buildLanguageRowStructure(doc, {
            title: langRow.title,
            description: langRow.description,
            options: options.map(([value, label]) => ({ value, label })),
            activeId: select.value,
        }));
    }
    const customRow = el(doc, 'div', '', 8);
    customRow.id = customRowId;
    const input = doc.createElement('input');
    input.type = 'text';
    input.id = customId;
    input.name = customId;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', ariaLabel);
    customRow.append(buildInputPrimitiveWrap(doc, input));
    const controls = el(doc, 'div', 'scenario-preview-controls');
    controls.append(presetRow, customRow);
    return controls;
}

export function buildFontScenarioPreviewRow(doc) {
    const row = el(doc, 'div', 'vcp-settings-row', 7);
    const label = doc.createElement('label');
    label.textContent = '场景预览';
    const grid = el(doc, 'div', 'scenario-preview-grid');
    grid.id = 'fontScenarioPreviewGrid';

    const chatCard = el(doc, 'div', 'scenario-preview-card');
    const chatTitle = el(doc, 'div', 'scenario-preview-title');
    chatTitle.textContent = '聊天正文';
    const chatBody = el(doc, 'div', 'scenario-preview-body');
    chatBody.id = 'scenarioPreviewBody';
    chatBody.textContent = '这是普通聊天正文的显示效果，适合长段阅读与自然对话。';
    chatCard.append(chatTitle, chatBody, buildScenarioFontControls(doc, {
        presetRowId: 'chatFontPresetRow', presetId: 'chatFontPreset', optionKey: 'chat',
        langRow: { title: '聊天字体', description: '选择聊天正文使用的字体' },
        customRowId: 'chatFontCustomRow', customId: 'chatFontCustom',
        placeholder: '例如: "LXGW WenKai", "Microsoft YaHei", sans-serif',
        ariaLabel: '聊天字体自定义值',
    }));

    const codeCard = el(doc, 'div', 'scenario-preview-card scenario-preview-card-code');
    const codeTitle = el(doc, 'div', 'scenario-preview-title');
    codeTitle.textContent = '代码块';
    const codeBody = doc.createElement('pre');
    codeBody.className = 'scenario-preview-body scenario-preview-code';
    codeBody.id = 'scenarioPreviewCode';
    codeBody.textContent = 'const sum = (a, b) =>\n  a + b;';
    codeCard.append(codeTitle, codeBody, buildScenarioFontControls(doc, {
        presetRowId: 'chatCodeFontPresetRow', presetId: 'chatCodeFontPreset', optionKey: 'code',
        langRow: { title: '代码字体', description: '选择代码块使用的字体' },
        customRowId: 'chatCodeFontCustomRow', customId: 'chatCodeFontCustom',
        placeholder: '例如: "Maple Mono", "JetBrains Mono", monospace',
        ariaLabel: '代码字体自定义值',
    }));

    const diaryCard = el(doc, 'div', 'scenario-preview-card scenario-preview-card-diary');
    const diaryTitle = el(doc, 'div', 'scenario-preview-title');
    diaryTitle.textContent = '日记 / 文学块';
    const diaryBody = el(doc, 'div', 'scenario-preview-body');
    diaryBody.id = 'scenarioPreviewDiary';
    diaryBody.textContent = '晚风穿过窗边，纸页轻轻翻动，像一段被放慢的心事。';
    diaryCard.append(diaryTitle, diaryBody, buildScenarioFontControls(doc, {
        presetRowId: 'chatDiaryFontPresetRow', presetId: 'chatDiaryFontPreset', optionKey: 'diary',
        langRow: { title: '场景字体', description: '选择日记与文学块使用的字体' },
        customRowId: 'chatDiaryFontCustomRow', customId: 'chatDiaryFontCustom',
        placeholder: '例如: "Noto Serif SC", Georgia, serif',
        ariaLabel: '日记字体自定义值',
    }));

    const toolCard = el(doc, 'div', 'scenario-preview-card scenario-preview-card-tool');
    const toolTitle = el(doc, 'div', 'scenario-preview-title');
    toolTitle.textContent = '工具结果 / 系统卡片';
    const toolBody = el(doc, 'div', 'scenario-preview-body');
    toolBody.id = 'scenarioPreviewTool';
    toolBody.append('status: success', doc.createElement('br'), 'result: 已完成内容整理与渲染。');
    toolCard.append(toolTitle, toolBody, buildScenarioFontControls(doc, {
        presetRowId: 'chatToolFontPresetRow', presetId: 'chatToolFontPreset', optionKey: 'tool',
        langRow: { title: '场景字体', description: '选择工具结果与系统卡片使用的字体' },
        customRowId: 'chatToolFontCustomRow', customId: 'chatToolFontCustom',
        placeholder: '例如: "Segoe UI", "Microsoft YaHei", sans-serif',
        ariaLabel: '工具字体自定义值',
    }));

    grid.append(chatCard, codeCard, diaryCard, toolCard);
    row.append(label, grid);
    return row;
}

// 消息呈现模式选择器：三张 radio 卡（气泡/磨砂/沉浸），呈现管线按
// name=chatPresentationMode 的 checked 值投影。
const CHAT_PRESENTATION_MODES = [
    { id: 'chatPresentationModeBubble', value: 'bubble', checked: true, icon: 'chat', title: '气泡模式', description: '保留当前左右气泡、头像及元信息布局。' },
    { id: 'chatPresentationModePanel', value: 'panel', icon: 'view_agenda', title: '统一磨砂模式', description: '消息共用一块全宽磨砂面板，以分割线区分。' },
    { id: 'chatPresentationModeImmersive', value: 'immersive', icon: 'menu_book', title: '沉浸文本模式', description: '隐藏头像并使用居中的长文阅读栏。' },
];

export function buildChatPresentationModeFieldset(doc) {
    const fieldset = el(doc, 'fieldset', 'form-group chat-presentation-mode-selector', 10);
    const legend = el(doc, 'legend', '', 11);
    legend.textContent = '消息呈现模式';
    const options = el(doc, 'div', 'chat-presentation-mode-options');
    for (const mode of CHAT_PRESENTATION_MODES) {
        const label = doc.createElement('label');
        label.className = 'chat-presentation-mode-option';
        label.setAttribute('for', mode.id);
        const input = doc.createElement('input');
        input.type = 'radio';
        input.id = mode.id;
        input.name = 'chatPresentationMode';
        input.value = mode.value;
        if (mode.checked) input.checked = true;
        const span = doc.createElement('span');
        const icon = el(doc, 'span', 'chat-presentation-mode-icon vcp-ui-icon');
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = mode.icon;
        const strong = doc.createElement('strong');
        strong.textContent = mode.title;
        const small = doc.createElement('small');
        small.textContent = mode.description;
        span.append(icon, strong, small);
        label.append(input, span);
        options.append(label);
    }
    fieldset.append(legend, options);
    return fieldset;
}
