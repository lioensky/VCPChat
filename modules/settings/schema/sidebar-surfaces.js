// Settings sidebar schema and renderer.
//
// The settings managers own business state and persistence. This module owns
// the DOM contract: every field has a descriptor, every view is rendered from
// a descriptor, and dynamic business modules receive stable ids/slots.

const SVG_TOGGLE = '<svg class="toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>';

const field = (id, type, label, options = {}) => Object.freeze({
    id,
    type,
    label,
    ...options,
});

const agentFields = Object.freeze([
    field('agentNameInput', 'text', 'Agent 名称', { name: 'name', placeholder: 'Agent 名称', required: true, tooltip: '列表和聊天中显示的助手名称。', validation: { required: true } }),
    field('agentModel', 'text', 'Agent 模型', { name: 'model', placeholder: '例如 gemini-2.5-flash-preview-05-20', tooltip: '留空时使用服务端默认模型。' }),
    field('agentTemperature', 'number', 'Temperature (0-2)', { name: 'temperature', min: 0, max: 2, step: 0.1, validation: { min: 0, max: 2 } }),
    field('agentContextTokenLimit', 'number', '上下文Token上限', { name: 'contextTokenLimit', min: 0, step: 100, validation: { min: 0 } }),
    field('agentMaxOutputTokens', 'number', '最大输出Token上限', { name: 'maxOutputTokens', min: 0, step: 50, validation: { min: 0 } }),
    field('agentTopP', 'number', 'Top P (0-2)', { name: 'top_p', min: 0, max: 2, step: 0.05, validation: { min: 0, max: 2 } }),
    field('agentTopK', 'number', 'Top K (0-64)', { name: 'top_k', min: 0, max: 64, step: 1, validation: { min: 0, max: 64 } }),
    field('agentTtsVoicePrimary', 'select', '主语言音色 / MiMo 模式', { name: 'ttsVoicePrimary', options: [['', '不使用语音']], tooltip: '主语言的音色或网络语音模式。' }),
    field('agentTtsRegexPrimary', 'text', '主语言正则 (留空则匹配全部)', { name: 'ttsRegexPrimary', placeholder: '例如 [^\\[\\]]+', tooltip: '用于匹配需要使用主语言音色的文本。' }),
    field('agentTtsVoiceSecondary', 'select', '副语言音色 / MiMo 模式', { name: 'ttsVoiceSecondary', options: [['', '不使用']], tooltip: '可选的副语言音色。' }),
    field('agentTtsRegexSecondary', 'text', '副语言正则', { name: 'ttsRegexSecondary', placeholder: '例如 \\[(.*?)\\]', tooltip: '用于匹配需要使用副语言音色的文本。' }),
    field('agentTtsSpeed', 'range', '语速', { name: 'ttsSpeed', min: 0.5, max: 2, step: 0.1, value: 1, tooltip: '本地 SoVITS 使用该语速；网络模式按模型原生节奏合成，可用下方自然语言提示词描述语速。', validation: { min: 0.5, max: 2 } }),
    field('agentCustomCss', 'textarea', '列表项自定义CSS', { name: 'customCss', rows: 3, tooltip: '此CSS将应用于【助手】页面的Agent列表项容器。' }),
    field('agentCardCss', 'textarea', '名片样式CSS', { name: 'cardCss', rows: 3, tooltip: '此CSS将应用于【设置】页面中Agent的名片区域（头像和名称）。' }),
    field('agentChatCss', 'textarea', '会话样式CSS', { name: 'chatCss', rows: 4, tooltip: '此CSS将应用于【聊天会话】中Agent的头像和名称。可使用 .message-avatar 控制头像，.sender-name 控制名称。' }),
]);

const groupFields = Object.freeze([
    field('groupNameInput', 'text', '群组名称', { placeholder: '群组名称', required: true, tooltip: '列表和聊天中显示的群组名称。', validation: { required: true } }),
    field('groupChatMode', 'select', '群聊模式', { options: [['sequential', '顺序发言'], ['naturerandom', '自然随机'], ['invite_only', '邀请发言']], tooltip: '决定群组如何选择下一位发言者：顺序发言、自然随机或仅受邀请。' }),
    field('tagMatchMode', 'select', 'Tag 触发模式', { options: [['strict', '严格模式'], ['natural', '自然模式']], tooltip: '自然模式会区分 Tag 来源，尽量避免 Agent 因引用自身历史发言而重复触发。', dependsOn: { field: 'groupChatMode', equals: 'naturerandom' } }),
    field('groupUnifiedModelInput', 'text', '群组统一模型', { placeholder: '选择群组统一模型', tooltip: '启用统一模型后，群组成员共享此模型。', dependsOn: { field: 'groupUseUnifiedModel', equals: true } }),
    field('groupPrompt', 'textarea', 'GroupPrompt', { rows: 4, tooltip: '注入群聊上下文的系统提示词，作为群组整体对话指导。' }),
    field('invitePrompt', 'textarea', 'InvitePrompt', { rows: 4, tooltip: '邀请某个成员发言时使用的提示词。可使用 {{VCPChatAgentName}} 作为被邀请发言的 Agent 名称占位符。' }),
]);

export const settingsSidebarSchema = Object.freeze({
    version: 1,
    agent: Object.freeze({
        sections: Object.freeze(['identity', 'prompt', 'model', 'params', 'tts', 'regex']),
        fields: agentFields,
    }),
    group: Object.freeze({
        sections: Object.freeze(['identity', 'mode', 'model', 'prompt']),
        fields: groupFields,
    }),
});

function setAttributes(node, attributes = {}) {
    Object.entries(attributes).forEach(([name, value]) => {
        if (value === undefined || value === null || value === false) return;
        node.setAttribute(name, value === true ? '' : String(value));
    });
    return node;
}

function el(doc, tag, attributes = {}, ...children) {
    const node = setAttributes(doc.createElement(tag), attributes);
    children.flat(Infinity).forEach(child => {
        if (child === null || child === undefined || child === false) return;
        node.append(child.nodeType ? child : doc.createTextNode(String(child)));
    });
    return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(doc, tag, attributes = {}, ...children) {
    const node = setAttributes(doc.createElementNS(SVG_NS, tag), attributes);
    children.flat(Infinity).forEach(child => {
        if (child === null || child === undefined || child === false) return;
        node.append(child.nodeType ? child : doc.createTextNode(String(child)));
    });
    return node;
}

function buildCameraIcon(doc) {
    return svgEl(doc, 'svg', {
        class: 'avatar-upload-icon',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
        'aria-hidden': 'true',
    },
        svgEl(doc, 'path', { d: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z' }),
        svgEl(doc, 'circle', { cx: '12', cy: '13', r: '4' }),
    );
}

function buildPlusIcon(doc) {
    return svgEl(doc, 'svg', {
        class: 'vcp-ui-icon-svg',
        viewBox: '0 0 16 16',
        width: '10',
        height: '10',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.8',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
    },
        svgEl(doc, 'path', { d: 'M8 3v10M3 8h10' }),
    );
}

function makeHelpBadge(doc, tooltipText) {
    const badge = el(doc, 'button', {
        type: 'button',
        class: 'vcp-settings-info-badge',
        title: tooltipText || '提示说明',
        'aria-label': tooltipText || '提示说明',
        'data-tooltip': tooltipText,
    }, '?');
    badge.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
    });
    return badge;
}

function labelFor(doc, spec) {
    const label = el(doc, 'label', { for: spec.id }, spec.label);
    if (spec.tooltip) {
        label.append(makeHelpBadge(doc, spec.tooltip));
    }
    return label;
}

function renderControl(doc, spec) {
    const attributes = { id: spec.id, name: spec.name, type: spec.type, placeholder: spec.placeholder,
        required: spec.required, min: spec.min, max: spec.max, step: spec.step, rows: spec.rows };
    if (spec.type === 'select') {
        const select = el(doc, 'select', { id: spec.id, name: spec.name });
        (spec.options || []).forEach(([value, text]) => select.append(el(doc, 'option', { value }, text)));
        return select;
    }
    if (spec.type === 'textarea') return el(doc, 'textarea', { ...attributes, spellcheck: false, autocorrect: 'off', autocapitalize: 'off' });
    return el(doc, 'input', attributes);
}

function renderField(doc, spec, className = 'settings-schema-field') {
    const row = el(doc, 'div', { class: className, 'data-schema-field': spec.id });
    row.dataset.schemaField = spec.id;
    const control = renderControl(doc, spec);
    if (spec.tooltip) {
        row.dataset.schemaTooltip = spec.tooltip;
    }
    if (spec.validation) row.dataset.schemaValidation = JSON.stringify(spec.validation);
    if (spec.dependsOn) row.dataset.schemaDependsOn = JSON.stringify(spec.dependsOn);
    row.append(labelFor(doc, spec), control);
    return row;
}

const SECTION_ICONS = {
    identity: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M11.0307 5.46369C11.0305 3.78995 9.6734 2.43357 7.99961 2.43357C6.32601 2.43379 4.96972 3.79009 4.96949 5.46369C4.96949 7.13748 6.32587 8.49455 7.99961 8.49477C9.67354 8.49477 11.0307 7.13762 11.0307 5.46369ZM12.3163 5.46369C12.3163 7.84777 10.3837 9.78042 7.99961 9.78042C5.61572 9.7802 3.68288 7.84763 3.68288 5.46369C3.6831 3.07993 5.61586 1.14718 7.99961 1.14695C10.3836 1.14695 12.3161 3.0798 12.3163 5.46369Z" fill="currentColor"/><path d="M8.00002 10.3316C11.7343 10.3316 14.1864 11.8997 15.0387 14.4445L14.4292 14.6483L13.8197 14.8531C13.1955 12.9893 11.3673 11.6182 8.00002 11.6182C4.63277 11.6182 2.80455 12.9893 2.18031 14.8531L1.5708 14.6483L0.961304 14.4445C1.81368 11.8997 4.26579 10.3316 8.00002 10.3316Z" fill="currentColor"/></svg>',
    prompt: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M9.94076 1.34942C10.7047 0.90231 11.6503 0.902415 12.4143 1.34942C12.7061 1.52015 12.9688 1.79118 13.3104 2.13284C13.6521 2.47448 13.9231 2.73721 14.0939 3.02894C14.5408 3.79294 14.5409 4.73856 14.0939 5.50251C13.9231 5.79415 13.652 6.05704 13.3104 6.39861L6.65932 13.0497C6.28068 13.4284 6.00695 13.7108 5.66543 13.9097C5.32391 14.1085 4.94315 14.2074 4.42705 14.3498L3.24394 14.6761C2.77527 14.8054 2.34538 14.9262 2.00131 14.9684C1.65196 15.0112 1.17964 15.0013 0.810764 14.6325C0.441921 14.2637 0.432107 13.7913 0.47486 13.442C0.517035 13.0979 0.6379 12.668 0.767181 12.1993L1.09352 11.0162C1.23588 10.5001 1.33481 10.1193 1.5336 9.77784C1.7325 9.43632 2.0149 9.1626 2.39355 8.78395L9.04466 2.13284C9.38625 1.79126 9.64911 1.52016 9.94076 1.34942ZM15.5427 14.8398H7.55223L8.96707 13.425H15.5427V14.8398ZM3.39382 9.78422C2.965 10.213 2.84244 10.3436 2.75709 10.49C2.67183 10.6366 2.61862 10.8079 2.45733 11.3925L2.13099 12.5756C2.00183 13.0439 1.92194 13.3419 1.88863 13.5536C2.10041 13.5204 2.39872 13.4416 2.86764 13.3123L4.05075 12.9859C4.63544 12.8246 4.80669 12.7715 4.95323 12.6862C5.09968 12.6008 5.23022 12.4783 5.65905 12.0494L10.721 6.98644L8.45577 4.72121L3.39382 9.78422ZM11.7 2.57079C11.3774 2.38198 10.9777 2.38198 10.6551 2.57079C10.5602 2.62647 10.4487 2.72931 10.0449 3.13311L9.45604 3.72094L11.7213 5.98617L12.3102 5.39833C12.7139 4.99457 12.8168 4.88307 12.8725 4.78818C13.0613 4.46561 13.0612 4.06585 12.8725 3.74326C12.8169 3.64827 12.7146 3.53752 12.3102 3.13311C11.9057 2.72863 11.795 2.6264 11.7 2.57079Z" fill="currentColor"/></svg>',
    model: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2"></rect><path d="M6 1v2M10 1v2M6 13v2M10 13v2M1 6h2M1 10h2M13 6h2M13 10h2"></path></svg>',
    params: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M14.0861 5.51366C13.8717 5.0575 13.588 4.58542 13.2889 4.18108C13.208 4.07172 13.1596 4.04373 13.0243 4.03054C12.4277 3.97255 11.8245 4.05527 11.2269 3.9972C10.7224 3.94816 10.3133 3.71661 10.0115 3.30919C9.66986 2.84777 9.43973 2.31343 9.09824 1.85234C9.01771 1.74365 8.96805 1.71589 8.83354 1.70282C8.29432 1.65044 7.70402 1.65061 7.16656 1.70282C7.03205 1.71589 6.98239 1.74365 6.90186 1.85234C6.56067 2.31303 6.33025 2.84774 5.98855 3.30919C5.68681 3.71661 5.27774 3.94816 4.77317 3.9972C4.17564 4.05527 3.57239 3.97255 2.97585 4.03054C2.84046 4.04373 2.79208 4.07172 2.71115 4.18108C2.41212 4.58542 2.12835 5.0575 1.91403 5.51366C1.85299 5.64359 1.85286 5.7018 1.91403 5.8319C2.14865 6.33077 2.49748 6.76892 2.73237 7.26854C2.9594 7.7515 2.96041 8.24717 2.73338 8.73044C2.49837 9.23061 2.14891 9.66837 1.91403 10.1681C1.85291 10.2982 1.85299 10.3564 1.91403 10.4863C2.12856 10.9429 2.41185 11.4142 2.71115 11.8189C2.79208 11.9283 2.84046 11.9563 2.97585 11.9694C3.57239 12.0274 4.17564 11.9447 4.77317 12.0028C5.27774 12.0518 5.68681 12.2834 5.98855 12.6908C6.33024 13.1522 6.56037 13.6866 6.90186 14.1476C6.98239 14.2563 7.03205 14.2841 7.16656 14.2972C7.70402 14.3494 8.29432 14.3495 8.83354 14.2972C8.96805 14.2841 9.01771 14.2563 9.09824 14.1476C9.43944 13.687 9.66985 13.1522 10.0115 12.6908C10.3133 12.2834 10.7224 12.0518 11.2269 12.0028C11.8244 11.9447 12.4271 12.0275 13.0243 11.9694C13.1596 11.9563 13.208 11.9283 13.2889 11.8189C13.5891 11.4131 13.872 10.942 14.0861 10.4863C14.1471 10.3564 14.1472 10.2982 14.0861 10.1681C13.8513 9.66861 13.5017 9.23061 13.2667 8.73044C13.0397 8.24717 13.0407 7.7515 13.2677 7.26854C13.5026 6.7689 13.8513 6.33106 14.0861 5.8319C14.1472 5.7018 14.1471 5.64359 14.0861 5.51366ZM9.13764 7.99999C9.13764 7.3715 8.62855 6.8624 8.00005 6.8624C7.37155 6.8624 6.86246 7.3715 6.86246 7.99999C6.86246 8.62849 7.37155 9.13759 8.00005 9.13759C8.62855 9.13759 9.13764 8.62849 9.13764 7.99999ZM10.4834 7.99999C10.4834 9.37126 9.37132 10.4833 8.00005 10.4833C6.62878 10.4833 5.51674 9.37126 5.51674 7.99999C5.51674 6.62873 6.62878 5.51669 8.00005 5.51669C9.37132 5.51669 10.4834 6.62873 10.4834 7.99999Z" fill="currentColor"/></svg>',
    tts: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M7.33333 2.66667L4 5.33333H1.33333V10.6667H4L7.33333 13.3333V2.66667Z" fill="currentColor"/><path d="M10.3333 5C11.1667 5.83333 11.6667 7 11.6667 8C11.6667 9 11.1667 10.1667 10.3333 11M12.6667 2.66667C14.1667 4.16667 15 6 15 8C15 10 14.1667 11.8333 12.6667 13.3333" stroke="currentColor" stroke-width="1.33" stroke-linecap="round"/></svg>',
    regex: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 2.5H14.5L9.5 8.5V13.5L6.5 15V8.5L1.5 2.5Z"/></svg>',
    mode: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM11.5 6a2 2 0 100-4 2 2 0 000 4zM6 7c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4zM11.5 8c-.37 0-.77.03-1.19.09 1.02.73 1.69 1.7 1.69 2.91v2H16v-2c0-1.63-2.9-2.9-4.5-3z" fill="currentColor"/></svg>',
};

function renderSection(doc, { kind, key, title, tooltip, summaryId, content, contentId, sectionClass }) {
    const prefix = kind === 'agent' ? 'agent' : 'group';
    const section = el(doc, 'section', {
        class: `${prefix}-settings-collapsible-container ${prefix}-settings-section collapsed${sectionClass ? ' ' + sectionClass : ''}`,
        'data-section-key': key,
        'data-schema-section': key,
    });
    section.dataset.schemaSection = key;
    const headerId = kind === 'agent'
        ? `${key}ToggleHeader`
        : `group${key[0].toUpperCase()}${key.slice(1)}ToggleHeader`;
    const header = el(doc, 'div', {
        class: `${prefix}-settings-section-header`,
        id: headerId,
        role: 'button',
        tabindex: '0',
        'aria-expanded': 'false',
    });
    const summary = el(doc, 'span', { class: `${prefix}-settings-section-summary`, id: summaryId }, '');
    const toggle = el(doc, 'button', {
        type: 'button',
        id: kind === 'agent' ? `${key}ToggleBtn` : `group${key[0].toUpperCase()}${key.slice(1)}ToggleBtn`,
        class: `${prefix}-settings-toggle-btn ${prefix}-settings-section-toggle`,
        'aria-label': `切换${title}`,
        'aria-expanded': 'false',
    });
    toggle.innerHTML = SVG_TOGGLE;
    const iconHtml = SECTION_ICONS[key] || '';
    const titleChildren = [];
    if (iconHtml) {
        const iconWrapper = el(doc, 'span', { class: 'section-title-icon-wrapper', 'aria-hidden': 'true' });
        iconWrapper.innerHTML = iconHtml;
        titleChildren.push(iconWrapper);
    }
    titleChildren.push(el(doc, 'span', { class: `${prefix}-settings-section-title` }, title));
    if (tooltip) {
        titleChildren.push(makeHelpBadge(doc, tooltip));
    }
    const titleRow = el(doc, 'div', { class: `${prefix}-settings-section-title-row` }, titleChildren);
    header.append(titleRow, summary, toggle);
    const contentNode = el(doc, 'div', {
        class: `${prefix}-settings-section-content`,
        id: contentId || (kind === 'agent' ? `${key}Content` : `group${key[0].toUpperCase()}${key.slice(1)}Content`)
    });
    contentNode.append(content(doc));
    section.append(header, contentNode);

    const toggleSection = (event) => {
        if (event?.target?.closest('.vcp-settings-info-badge')) return;
        const manager = doc.defaultView?.settingsManager || globalThis.window?.settingsManager;
        let handled = false;
        if (manager?.toggleAgentSettingsSection && kind === 'agent') {
            try {
                const result = manager.toggleAgentSettingsSection(key);
                if (result !== false) handled = true;
            } catch (_) {}
        }
        if (!handled) {
            section.classList.toggle('collapsed');
        }
        const isCollapsed = section.classList.contains('collapsed');
        const expanded = !isCollapsed;
        header.setAttribute('aria-expanded', String(expanded));
        toggle.setAttribute('aria-expanded', String(expanded));
    };
    header.addEventListener('click', (e) => {
        if (e.target.closest('button') && e.target !== header) return;
        toggleSection(e);
    });
    header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            if (e.target.closest('button') && e.target !== header) return;
            e.preventDefault();
            toggleSection(e);
        }
    });
    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSection(e);
    });
    return section;
}

function renderAgentIdentity(doc) {
    const avatar = el(doc, 'div', { class: 'agent-avatar-wrapper' },
        el(doc, 'img', { id: 'agentAvatarPreview', src: 'assets/default_avatar.png', alt: '头像预览', class: 'agent-avatar-display', width: 60, height: 60 }),
        el(doc, 'label', { for: 'agentAvatarInput', class: 'avatar-upload-overlay', 'aria-label': '更换头像' }, buildCameraIcon(doc)),
        el(doc, 'input', { id: 'agentAvatarInput', name: 'avatar', type: 'file', accept: 'image/png, image/jpeg, image/gif', hidden: true }));
    const identityMain = el(doc, 'div', { class: 'agent-identity-main' }, avatar, renderField(doc, agentFields[0], 'agent-name-wrapper'));
    const style = el(doc, 'div', { class: 'agent-style-collapsible-container collapsed', 'data-schema-section': 'style', 'data-setting-primitive': 'disclosure' });
    const styleIcon = el(doc, 'span', { class: 'style-collapse-icon', 'aria-hidden': 'true' });
    const styleHeader = el(doc, 'div', { class: 'style-collapse-header vcp-uiux-disclosure-row', id: 'styleCollapseHeader', role: 'button', tabindex: '0', 'aria-expanded': 'false', 'aria-controls': 'agentStyleControls' },
        styleIcon, el(doc, 'span', { class: 'style-collapse-title' }, '自定义样式设置'));

    const toggleStyle = () => {
        const isCollapsed = style.classList.toggle('collapsed');
        const expanded = !isCollapsed;
        styleHeader.setAttribute('aria-expanded', String(expanded));
        const manager = doc.defaultView?.settingsManager || globalThis.window?.settingsManager;
        if (manager?.persistCollapseStatesForCurrentSelection) {
            try { manager.persistCollapseStatesForCurrentSelection(); } catch (_) {}
        }
    };
    styleHeader.addEventListener('click', toggleStyle);
    styleHeader.dataset.collapsibleBound = 'true';
    styleHeader.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleStyle();
        }
    });
    const controls = el(doc, 'div', { class: 'agent-style-controls', id: 'agentStyleControls' });
    [['disableCustomColors', '助手页面中使用主题默认颜色'], ['useThemeColorsInChat', '会话界面中使用主题默认颜色']].forEach(([id, text]) => {
        const checkbox = el(doc, 'input', { id, type: 'checkbox', name: id });
        controls.append(el(doc, 'div', { class: 'style-control-item full-width' },
            el(doc, 'div', { class: 'form-group-inline style-toggle-row' },
                el(doc, 'label', { for: id }, text),
                el(doc, 'label', { class: 'switch', for: id, 'aria-label': text }, checkbox, el(doc, 'span', { class: 'slider round' })))));
    });
    const colorPair = (id, text, value, name) => el(doc, 'div', { class: 'style-control-item' },
        el(doc, 'label', { for: id }, text), el(doc, 'div', { class: 'color-input-group' },
            el(doc, 'input', { id, type: 'color', name, value }),
            el(doc, 'input', { id: `${id}Text`, type: 'text', placeholder: value, 'aria-label': `${text}十六进制值`, maxlength: 7 })));
    controls.append(colorPair('agentAvatarBorderColor', '头像外框颜色:', '#3d5a80', 'avatarBorderColor'), colorPair('agentNameTextColor', '名称文字颜色:', '#ffffff', 'nameTextColor'));
    controls.append(el(doc, 'div', { class: 'style-control-item full-width' }, el(doc, 'button', { type: 'button', id: 'resetAvatarColorsBtn', class: 'reset-colors-btn' }, '重置为头像默认颜色')));
    const customCss = renderField(doc, agentFields[12]);
    const cardCss = renderField(doc, agentFields[13]);
    const chatCss = renderField(doc, agentFields[14]);
    controls.append(customCss, cardCss, chatCss);
    style.append(styleHeader, controls);
    return el(doc, 'div', { class: 'agent-identity-container' }, identityMain, style);
}

function renderAgentParams(doc) {
    const content = el(doc, 'div', { class: 'params-content', id: 'paramsContent' });
    agentFields.slice(2, 7).forEach(spec => content.append(renderField(doc, spec)));
    const stream = el(doc, 'div', { class: 'form-group-inline agent-stream-mode-group' },
        el(doc, 'span', { class: 'agent-stream-mode-title' }, '输出模式:'),
        el(doc, 'div', { class: 'agent-stream-mode-segmented' },
            el(doc, 'label', { class: 'agent-stream-mode-option', for: 'agentStreamOutputTrue' }, el(doc, 'input', { id: 'agentStreamOutputTrue', type: 'radio', name: 'streamOutput', value: 'true', checked: true }), '流式'),
            el(doc, 'label', { class: 'agent-stream-mode-option', for: 'agentStreamOutputFalse' }, el(doc, 'input', { id: 'agentStreamOutputFalse', type: 'radio', name: 'streamOutput', value: 'false' }), '非流式')));
    content.append(stream);
    return el(doc, 'div', { class: 'agent-settings-card-shell' }, content);
}

function renderAgentTts(doc) {
    const content = el(doc, 'div', { class: 'params-content', id: 'ttsContent' });
    const selectRow = (spec, button) => el(doc, 'div', { 'data-schema-field': spec.id }, labelFor(doc, spec), el(doc, 'div', { class: 'model-input-container' }, renderControl(doc, spec), button));
    const refresh = el(doc, 'button', { type: 'button', id: 'refreshTtsModelsBtn', class: 'small-button', title: '刷新模型列表', 'aria-label': '刷新模型列表' },
        el(doc, 'span', { class: 'vcp-ui-icon', 'aria-hidden': 'true' }, 'refresh'));
    content.append(selectRow(agentFields[7], refresh), renderField(doc, agentFields[8]), selectRow(agentFields[9]), renderField(doc, agentFields[10]));
    const speed = renderField(doc, agentFields[11]);
    const speedInput = speed.querySelector('input');
    speedInput?.setAttribute('value', '1.0');
    const speedValue = el(doc, 'span', { id: 'ttsSpeedValue', class: 'slider-value-pill' }, '1.0');
    const syncSpeedDisplay = () => {
        const val = parseFloat(speedInput.value);
        speedValue.textContent = Number.isFinite(val) ? val.toFixed(1) : speedInput.value;
    };
    speedInput?.addEventListener('input', syncSpeedDisplay);
    speedInput?.addEventListener('change', syncSpeedDisplay);
    const speedControl = el(doc, 'div', { class: 'slider-container' });
    speedControl.append(speedInput, speedValue);
    speed.append(speedControl);
    content.append(speed);
    const composer = el(doc, 'div', { class: 'settings-form-group tts-director-settings' },
        el(doc, 'div', { class: 'tts-director-heading' },
            el(doc, 'label', { for: 'agentTtsDirectorPromptInput' }, 'MiMo 导演提示词:', makeHelpBadge(doc, '适用于网络模式：预置音色模式使用“提示词 + voice”控制演绎；自然语言控制模式使用专用模型且不发送 voice；克隆模式使用参考音频作为 voice。Ctrl+Enter 添加，卡片右上角 × 删除。'))),
        el(doc, 'div', { class: 'tts-director-composer' },
            el(doc, 'textarea', { id: 'agentTtsDirectorPromptInput', class: 'tts-director-editor tts-director-editor-new', rows: 3, spellcheck: false, autocorrect: 'off', autocapitalize: 'off', placeholder: '描述角色、场景与演绎指导 (Ctrl+Enter 添加)' }),
            el(doc, 'div', { class: 'tts-director-floating-actions' },
                el(doc, 'button', { type: 'button', id: 'fillAgentTtsDirectorTemplateBtn', class: 'tts-director-template-button', title: '填入角色、场景和指导模板' }, '模板'),
                el(doc, 'button', { type: 'button', id: 'addAgentTtsDirectorPromptBtn', class: 'small-button tts-director-action-button', title: '添加导演提示词', 'aria-label': '添加导演提示词' }, buildPlusIcon(doc)))),
        el(doc, 'div', { id: 'agentTtsDirectorPromptsContainer', class: 'tts-director-prompts-container' }));
    content.append(composer);
    return el(doc, 'div', { class: 'agent-settings-card-shell' }, content);
}

function buildImportIcon(doc) {
    return svgEl(doc, 'svg', {
        class: 'vcp-ui-icon-svg',
        viewBox: '0 0 16 16',
        width: '11',
        height: '11',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.5',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
    },
        svgEl(doc, 'path', { d: 'M3 10.5v2.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2.5M8 2v7.5M5 6.5l3 3 3-3' }),
    );
}

function renderRegexSection(doc) {
    const invokeManager = (action, ...args) => {
        const manager = doc.defaultView?.settingsManager || globalThis.window?.settingsManager;
        if (typeof manager?.[action] === 'function') {
            try { manager[action](...args); } catch (_) { /* business action owns its own errors */ }
        }
    };
    const addBtn = el(doc, 'button', { type: 'button', class: 'btn-add-regex' }, buildPlusIcon(doc), '添加正则');
    const importBtn = el(doc, 'button', { type: 'button', class: 'btn-add-regex btn-add-regex-secondary' }, buildImportIcon(doc), '导入正则');
    addBtn.addEventListener('click', () => invokeManager('openRegexModal'));
    importBtn.addEventListener('click', () => invokeManager('handleImportRegex'));
    const actions = el(doc, 'div', { class: 'strip-regex-actions' }, addBtn, importBtn);
    const content = el(doc, 'div', { class: 'agent-settings-card-shell' },
        el(doc, 'div', { id: 'stripRegexListContainer', class: 'strip-regex-list-container' }),
        actions);
    return renderSection(doc, { kind: 'agent', key: 'regex', title: '正则设置', summaryId: 'regexSummary', contentId: 'regexContent', sectionClass: 'strip-regex-container', content: () => content });
}

export function renderAgentSettingsSurface(host, doc = host?.ownerDocument || document) {
    if (!host || !doc) return null;
    host.replaceChildren();
    host.dataset.settingsView = 'agent';
    host.classList.add('settings-sidebar-surface-view', 'vcp-settings-schema-surface');
    const title = el(doc, 'h3', { id: 'agentSettingsContainerTitle' }, '助手设置: ', el(doc, 'span', { id: 'selectedAgentNameForSettings' }));
    const form = el(doc, 'form', { id: 'agentSettingsForm', novalidate: true });
    form.append(el(doc, 'input', { type: 'hidden', id: 'editingAgentId', name: 'agentId' }));
    form.append(renderSection(doc, { kind: 'agent', key: 'identity', title: '基础信息', summaryId: 'identitySummary', content: renderAgentIdentity }));
    form.append(renderSection(doc, { kind: 'agent', key: 'prompt', title: '系统提示词', tooltip: '三个模块独立编辑后，注意保存以生效', summaryId: 'promptSummary', content: d => el(d, 'div', { class: 'agent-settings-card-shell' }, el(d, 'div', { id: 'systemPromptContainer', class: 'system-prompt-container' })) }));
    form.append(renderSection(doc, { kind: 'agent', key: 'model', title: '模型设置', summaryId: 'modelSummary', content: d => el(d, 'div', { class: 'agent-settings-card-shell' }, el(d, 'div', { 'data-schema-field': agentFields[1].id }, el(d, 'div', { class: 'model-input-container' }, renderControl(d, agentFields[1]), el(d, 'button', { type: 'button', id: 'openModelSelectBtn', class: 'small-button model-picker-toggle-btn', title: '选择模型', 'aria-label': '选择模型' }, el(d, 'span', { class: 'vcp-ui-icon', 'aria-hidden': 'true' }, 'expand_more'))))) }));
    form.append(renderSection(doc, { kind: 'agent', key: 'params', title: '模型参数配置', summaryId: 'paramsSummary', content: renderAgentParams }));
    form.append(renderSection(doc, { kind: 'agent', key: 'tts', title: '语音设置', summaryId: 'ttsSummary', content: renderAgentTts }));
    form.append(renderRegexSection(doc));
    form.append(el(doc, 'div', { class: 'form-actions' },
        el(doc, 'div', { id: 'formSaveStateIndicator', class: 'form-save-state-indicator', 'data-state': 'done' },
            el(doc, 'span', { id: 'formStateDotHost', class: 'form-state-dot-host' }),
            el(doc, 'span', { id: 'formStateDotLabel', class: 'form-state-dot-label' }, '已保存')),
        el(doc, 'button', { type: 'submit' }, '保存Agent设置'),
        el(doc, 'div', { class: 'delete-button-container' },
            el(doc, 'button', { type: 'button', id: 'deleteAgentBtn', class: 'danger-button' }, '删除此Agent'))));
    host.append(title, form);
    return form;
}

function renderGroupSectionContent(doc, key) {
    if (key === 'identity') {
        return el(doc, 'div', { class: 'group-settings-identity-shell' },
            el(doc, 'div', { class: 'agent-identity-main group-identity-main' },
                el(doc, 'div', { class: 'agent-avatar-wrapper group-avatar-wrapper' }, el(doc, 'img', { id: 'groupAvatarPreview', src: 'assets/default_group_avatar.png', alt: '群组头像预览', class: 'agent-avatar-display group-avatar-display', width: 60, height: 60 }), el(doc, 'label', { for: 'groupAvatarInput', class: 'avatar-upload-overlay', 'aria-label': '更换群组头像' }, buildCameraIcon(doc)), el(doc, 'input', { id: 'groupAvatarInput', type: 'file', accept: 'image/*', hidden: true })),
                renderField(doc, groupFields[0], 'agent-name-wrapper group-name-wrapper')),
            el(doc, 'div', { class: 'group-settings-field-shell' }, el(doc, 'label', { for: 'groupMembersList' }, '群组成员', makeHelpBadge(doc, '勾选要加入此群聊的助手成员。')), el(doc, 'div', { id: 'groupMembersList', class: 'group-members-list-container' })));
    }
    if (key === 'mode') {
        const mode = renderField(doc, groupFields[1], 'group-settings-field-shell');
        const tags = renderField(doc, groupFields[2], 'group-settings-field-shell');
        tags.append(el(doc, 'div', { class: 'group-settings-field-shell group-member-tags-shell' }, el(doc, 'label', { class: 'group-settings-field-label', for: 'memberTagsInputs' }, '成员 Tags', makeHelpBadge(doc, '为成员配置触发标签（逗号分隔），在自然随机模式下匹配。')), el(doc, 'div', { id: 'memberTagsInputs' })));
        const seqLabel = el(doc, 'label', { class: 'group-settings-field-label', for: 'sequentialSpeakerOrderList' }, '顺序发言次序', makeHelpBadge(doc, '拖拽成员或点击上下箭头调整发言顺序。新加入且尚未排序的成员会自动追加到末尾。'));
        return el(doc, 'div', { class: 'group-settings-card-shell' }, mode, el(doc, 'div', { id: 'sequentialOrderContainer', class: 'group-settings-field-shell', hidden: true }, seqLabel, el(doc, 'div', { id: 'sequentialSpeakerOrderList', class: 'sequential-speaker-order-list', role: 'list', 'aria-label': '顺序发言次序' })), el(doc, 'div', { id: 'memberTagsContainer', class: 'group-settings-field-shell', hidden: true }, tags));
    }
    if (key === 'model') {
        return el(doc, 'div', { class: 'group-settings-card-shell' }, el(doc, 'div', { class: 'group-settings-switch-row' }, el(doc, 'label', { for: 'groupUseUnifiedModel' }, '启用群组统一模型'), el(doc, 'label', { class: 'switch', for: 'groupUseUnifiedModel', 'aria-label': '启用群组统一模型' }, el(doc, 'input', { id: 'groupUseUnifiedModel', type: 'checkbox' }), el(doc, 'span', { class: 'slider round' }))), el(doc, 'div', { id: 'groupUnifiedModelContainer', class: 'group-settings-field-shell', hidden: true, 'data-schema-field': groupFields[3].id, 'data-schema-depends-on': JSON.stringify(groupFields[3].dependsOn) }, el(doc, 'div', { class: 'model-input-container' }, renderControl(doc, groupFields[3]), el(doc, 'button', { type: 'button', id: 'openGroupModelSelectBtn', class: 'small-button model-picker-toggle-btn', title: '选择模型', 'aria-label': '打开模型选择器' }, el(doc, 'span', { class: 'vcp-ui-icon', 'aria-hidden': 'true' }, 'expand_more')))));
    }
    const groupPrompt = renderField(doc, groupFields[4]);
    groupPrompt.querySelector('textarea')?.setAttribute('placeholder', '例如：这里是用户家的聊天空间，成员应保持协作与角色分工。');
    const invitePrompt = renderField(doc, groupFields[5]);
    invitePrompt.querySelector('textarea')?.setAttribute('placeholder', '例如：现在轮到 {{VCPChatAgentName}} 发言了。');
    return el(doc, 'div', { class: 'group-settings-card-shell' }, groupPrompt, invitePrompt);
}

export function syncSchemaDependencies(container) {
    if (!container) return;
    const dependentRows = container.querySelectorAll?.('[data-schema-depends-on]');
    if (!dependentRows) return;
    dependentRows.forEach(row => {
        try {
            const raw = row.dataset.schemaDependsOn;
            if (!raw) return;
            const rule = JSON.parse(raw);
            if (!rule.field) return;
            const target = container.querySelector?.(`#${rule.field}`) || container.ownerDocument?.getElementById(rule.field);
            if (!target) return;
            const currentVal = target.type === 'checkbox' ? target.checked : target.value;
            const matches = rule.equals !== undefined ? currentVal === rule.equals : true;
            row.hidden = !matches;
        } catch (_) {}
    });
}

export function renderGroupSettingsSurface(host, doc = host?.ownerDocument || document) {
    if (!host || !doc) return null;
    host.replaceChildren();
    host.dataset.settingsView = 'group';
    host.classList.add('settings-sidebar-surface-view', 'vcp-settings-schema-surface');
    const form = el(doc, 'form', { id: 'groupSettingsForm' });
    form.append(el(doc, 'input', { type: 'hidden', id: 'editingGroupId' }));
    [['identity', '基础信息', 'groupIdentitySummary'], ['mode', '群聊模式', 'groupModeSummary'], ['model', '模型设置', 'groupModelSummary'], ['prompt', '系统提示词', 'groupPromptSummary']].forEach(([key, title, summaryId]) => form.append(renderSection(doc, { kind: 'group', key, title, summaryId, content: d => renderGroupSectionContent(d, key) })));
    form.append(el(doc, 'div', { class: 'form-actions' }, el(doc, 'button', { type: 'submit' }, '保存群组设置'), el(doc, 'div', { class: 'delete-button-container' }, el(doc, 'button', { type: 'button', id: 'deleteGroupBtn', class: 'danger-button' }, '删除此群组'))));
    form.addEventListener('change', () => {
        syncSchemaDependencies(form);
    });
    syncSchemaDependencies(form);
    host.append(form);
    return form;
}

export function renderGroupSettingsMarkup(doc = globalThis.document) {
    const host = doc.createElement('div');
    renderGroupSettingsSurface(host, doc);
    return host.innerHTML;
}

export function getSchemaField(kind, id) {
    return settingsSidebarSchema[kind]?.fields.find(entry => entry.id === id) || null;
}

if (globalThis.window) {
    globalThis.window.VCPSettingsSchema = Object.freeze({
        settingsSidebarSchema,
        renderAgentSettingsSurface,
        renderGroupSettingsSurface,
        renderGroupSettingsMarkup,
        getSchemaField,
        syncSchemaDependencies,
    });
}
