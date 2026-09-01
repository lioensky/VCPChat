// render/widgets — M1 分区里的专属组件标记构建器。
// 这些块（头像资料卡、折叠样式区、调试面板、动画示例/预览）是自包含
// 组件而非普通字段：标记逐字对齐 main.html 静态版本，由既有增强
// （avatar-picker、identity-name 编辑器、uiux-disclosures、identity-controls、
// 动画预览监听）按类名/ id 接管。后续阶段组件化后从这里收编。
import { el } from './shared.js';

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
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z');
    const circle = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '13');
    circle.setAttribute('r', '4');
    svg.append(path, circle);
    overlay.append(svg);
    const fileInput = doc.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'userAvatarInput';
    fileInput.name = 'userAvatar';
    fileInput.accept = 'image/png, image/jpeg, image/gif';
    fileInput.setAttribute('data-vcp-style', '2');
    avatarWrapper.append(img, overlay, fileInput);
    main.append(avatarWrapper);
    const nameWrapper = el(doc, 'div', 'agent-name-wrapper');
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
    nameWrapper.append(nameLabel, nameDisplay, nameInput);
    main.append(nameWrapper);
    card.append(main, buildUserStyleCollapsible(doc));
    return card;
}

function buildUserStyleCollapsible(doc) {
    const container = el(doc, 'div', 'agent-style-collapsible-container collapsed');
    container.dataset.vcpSettingsRow = 'true';
    const header = el(doc, 'div', 'style-collapse-header');
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
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    for (const d of [
        'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8',
        'M21 3v5h-5',
        'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16',
        'M3 21v-5h5',
    ]) {
        const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        svg.append(path);
    }
    button.append(svg);
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
