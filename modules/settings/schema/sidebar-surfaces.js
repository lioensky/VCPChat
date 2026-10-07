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
    field('groupChatMode', 'select', '群聊模式', { options: [['sequential', '顺序发言'], ['naturerandom', '自然随机'], ['invite_only', '邀请发言'], ['jev', 'JEV 智能群聊']], tooltip: '决定群组如何选择下一位发言者。JEV 智能群聊会按成员权重截断并自主推进话题。' }),
    field('tagMatchMode', 'select', 'Tag 触发模式', { options: [['strict', '严格模式'], ['natural', '自然模式']], tooltip: '自然模式会区分 Tag 来源，尽量避免 Agent 因引用自身历史发言而重复触发。', dependsOn: { field: 'groupChatMode', equals: 'naturerandom' } }),
    field('groupUnifiedModelInput', 'text', '群组统一模型', { placeholder: '选择群组统一模型', tooltip: '启用统一模型后，群组成员共享此模型。', dependsOn: { field: 'groupUseUnifiedModel', equals: true } }),
    field('groupPrompt', 'textarea', 'GroupPrompt', { rows: 4, tooltip: '注入群聊上下文的系统提示词，作为群组整体对话指导。' }),
    field('invitePrompt', 'textarea', 'InvitePrompt', { rows: 4, tooltip: '邀请某个成员发言时使用的提示词。可使用 {{VCPChatAgentName}} 作为被邀请发言的 Agent 名称占位符。' }),
    field('jevNavigatorPrompt', 'textarea', 'JEV 导航员提示词', { rows: 5, tooltip: '指导 JEV 根据群聊上下文、成员风格和结束必要性分配发言权重。' }),
    field('jevSpeakerThreshold', 'number', '发言权重截断阈值', { min: 0, max: 1, step: 0.01, tooltip: '概率低于此值的成员不会进入本轮 K 队列。' }),
    field('jevContinueThreshold', 'number', '继续讨论阈值', { min: 0, max: 1, step: 0.01, tooltip: 'JEV 判断继续讨论的概率低于此值时智能结束。' }),
    field('jevStopThreshold', 'number', '结束选项阈值', { min: 0, max: 1, step: 0.01, tooltip: '结束选项达到此值且权重最高时智能结束。' }),
    field('jevMaxSpeakersPerRound', 'number', '单轮最大回复人数 K', { min: 1, max: 32, step: 1, tooltip: '每次裁决最多选取多少位成员依次发言。' }),
    field('jevMaxAutonomousRounds', 'number', '最大自治裁决轮数', { min: 1, max: 100, step: 1, tooltip: '一次自治运行最多连续裁决轮数，用于防止无限对话。' }),
    field('jevHistoryWindow', 'number', 'JEV 历史窗口消息数', { min: 1, max: 200, step: 1, tooltip: '发送给 JEV 裁判的最近消息数量，默认 12。适当减小可减少输入 Token 和裁决费用，但窗口过小可能削弱上下文判断。' }),
    field('jevContinueDebounceMs', 'number', '继续群聊防抖 (ms)', { min: 0, max: 10000, step: 100, tooltip: '防止重复点击继续群聊产生多次运行。' }),
    field('groupEnableContextMessageWindow', 'checkbox', '启用上下文楼层窗口', { tooltip: '默认关闭。开启后仅把最近指定数量的消息发送给群成员模型；完整聊天记录仍会保存和显示。' }),
    field('groupContextMessageWindowSize', 'number', '最多保留楼层数', { min: 1, max: 10000, step: 1, tooltip: '发送给群成员模型的最近消息条数（包括用户和 Agent 消息）。不影响历史记录、瀑布流显示和话题总结。', dependsOn: { field: 'groupEnableContextMessageWindow', equals: true } }),
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

// Section header icons: Lucide names, turned into SVG by the shared adapter.
const SECTION_ICONS = {
    identity: 'user-round',
    prompt: 'square-pen',
    model: 'cpu',
    params: 'sliders-horizontal',
    tts: 'volume-2',
    regex: 'regex',
    mode: 'users',
};

function sectionIconHtml(key) {
    const name = SECTION_ICONS[key];
    if (!name) return '';
    const icons = typeof window !== 'undefined' ? window.VCPIcons : null;
    return icons?.markup?.(name, { size: 15 })
        || `<span class="vcp-ui-icon" style="--vcp-ui-icon-size: 15px" aria-hidden="true">${name}</span>`;
}

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
    // The header is a mouse target only. The chevron button is the one
    // keyboard and screen-reader control, as with a Radix Accordion trigger;
    // a role=button wrapper around a real button nested two controls.
    const header = el(doc, 'div', {
        class: `${prefix}-settings-section-header`,
        id: headerId,
        'aria-expanded': 'false',
    });
    const summary = el(doc, 'span', { class: `${prefix}-settings-section-summary`, id: summaryId }, '');
    const resolvedContentId = contentId || (kind === 'agent' ? `${key}Content` : `group${key[0].toUpperCase()}${key.slice(1)}Content`);
    const toggle = el(doc, 'button', {
        type: 'button',
        id: kind === 'agent' ? `${key}ToggleBtn` : `group${key[0].toUpperCase()}${key.slice(1)}ToggleBtn`,
        class: `${prefix}-settings-toggle-btn ${prefix}-settings-section-toggle`,
        'aria-label': `切换${title}`,
        'aria-expanded': 'false',
        'aria-controls': resolvedContentId,
    });
    toggle.innerHTML = SVG_TOGGLE;
    const iconHtml = sectionIconHtml(key);
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
        id: resolvedContentId
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
            el(doc, 'div', { class: 'group-settings-field-shell' }, el(doc, 'label', { id: 'groupMembersListLabel' }, '群组成员', makeHelpBadge(doc, '勾选要加入此群聊的助手成员。')), el(doc, 'div', { id: 'groupMembersList', class: 'group-members-list-container', role: 'group', 'aria-labelledby': 'groupMembersListLabel' })));
    }
    if (key === 'mode') {
        const mode = renderField(doc, groupFields[1], 'group-settings-field-shell');
        const tags = renderField(doc, groupFields[2], 'group-settings-field-shell');
        tags.append(el(doc, 'div', { class: 'group-settings-field-shell group-member-tags-shell' }, el(doc, 'label', { class: 'group-settings-field-label', id: 'memberTagsInputsLabel' }, '成员 Tags', makeHelpBadge(doc, '为成员配置触发标签（逗号分隔），在自然随机模式下匹配。')), el(doc, 'div', { id: 'memberTagsInputs', role: 'group', 'aria-labelledby': 'memberTagsInputsLabel' })));
        const seqLabel = el(doc, 'label', { class: 'group-settings-field-label' }, '顺序发言次序', makeHelpBadge(doc, '拖拽成员或点击上下箭头调整发言顺序。新加入且尚未排序的成员会自动追加到末尾。'));
        const jevSettings = el(doc, 'div', { id: 'jevModeSettingsContainer', class: 'group-settings-field-shell', hidden: true },
            renderField(doc, groupFields[6], 'group-settings-field-shell'),
            el(doc, 'div', { class: 'group-settings-grid' },
                ...groupFields.slice(7, 14).map(spec => renderField(doc, spec, 'group-settings-field-shell'))),
            el(doc, 'div', { class: 'group-settings-field-shell' },
                el(doc, 'label', { class: 'group-settings-field-label', id: 'jevMemberStylesInputsLabel' }, '成员发言触发事件风格', makeHelpBadge(doc, '为每位成员填写自然语言描述，告诉 JEV 在什么话题和情境下应提高其发言权重。')),
                el(doc, 'div', { id: 'jevMemberStylesInputs', role: 'group', 'aria-labelledby': 'jevMemberStylesInputsLabel' })));
        return el(doc, 'div', { class: 'group-settings-card-shell' }, mode, el(doc, 'div', { id: 'sequentialOrderContainer', class: 'group-settings-field-shell', hidden: true }, seqLabel, el(doc, 'div', { id: 'sequentialSpeakerOrderList', class: 'sequential-speaker-order-list', role: 'list', 'aria-label': '顺序发言次序' })), el(doc, 'div', { id: 'memberTagsContainer', class: 'group-settings-field-shell', hidden: true }, tags), jevSettings);
    }
    if (key === 'model') {
        const contextWindowToggleSpec = groupFields[14];
        const contextWindowSizeSpec = groupFields[15];
        return el(doc, 'div', { class: 'group-settings-card-shell' },
            el(doc, 'div', { class: 'group-settings-switch-row' },
                el(doc, 'label', { for: 'groupUseUnifiedModel' }, '启用群组统一模型'),
                el(doc, 'label', { class: 'switch', for: 'groupUseUnifiedModel', 'aria-label': '启用群组统一模型' },
                    el(doc, 'input', { id: 'groupUseUnifiedModel', type: 'checkbox' }),
                    el(doc, 'span', { class: 'slider round' }))),
            el(doc, 'div', { id: 'groupUnifiedModelContainer', class: 'group-settings-field-shell', hidden: true, 'data-schema-field': groupFields[3].id, 'data-schema-depends-on': JSON.stringify(groupFields[3].dependsOn) },
                el(doc, 'div', { class: 'model-input-container' },
                    renderControl(doc, groupFields[3]),
                    el(doc, 'button', { type: 'button', id: 'openGroupModelSelectBtn', class: 'small-button model-picker-toggle-btn', title: '选择模型', 'aria-label': '打开模型选择器' },
                        el(doc, 'span', { class: 'vcp-ui-icon', 'aria-hidden': 'true' }, 'expand_more')))),
            el(doc, 'div', { class: 'group-settings-switch-row', 'data-schema-field': contextWindowToggleSpec.id },
                el(doc, 'label', { for: contextWindowToggleSpec.id },
                    contextWindowToggleSpec.label,
                    makeHelpBadge(doc, contextWindowToggleSpec.tooltip)),
                el(doc, 'label', { class: 'switch', for: contextWindowToggleSpec.id, 'aria-label': contextWindowToggleSpec.label },
                    renderControl(doc, contextWindowToggleSpec),
                    el(doc, 'span', { class: 'slider round' }))),
            el(doc, 'div', {
                id: 'groupContextMessageWindowContainer',
                class: 'group-settings-field-shell',
                hidden: true,
                'data-schema-field': contextWindowSizeSpec.id,
                'data-schema-depends-on': JSON.stringify(contextWindowSizeSpec.dependsOn)
            }, labelFor(doc, contextWindowSizeSpec), renderControl(doc, contextWindowSizeSpec)));
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
    form.append(el(doc, 'div', { class: 'form-actions' },
        el(doc, 'div', { id: 'groupFormSaveStateIndicator', class: 'form-save-state-indicator', 'data-state': 'done' },
            el(doc, 'span', { class: 'form-state-dot-host' }),
            el(doc, 'span', { class: 'form-state-dot-label' }, '已保存')),
        el(doc, 'button', { type: 'submit' }, '保存群组设置'), el(doc, 'div', { class: 'delete-button-container' }, el(doc, 'button', { type: 'button', id: 'deleteGroupBtn', class: 'danger-button' }, '删除此群组'))));
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
