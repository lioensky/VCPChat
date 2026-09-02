// schema/advanced-features — "高级功能" 分区（M2）。
// 依赖行：净化深度容器依赖 enableContextSanitizer（typed-field-owners
// 快照路径也按容器 id 直写其可见性，id 即锚点）。话题总结模型行为
// model-input-container 复合控件，由 mountTypedTopicSummaryModelPicker 接管。
import { section, switchField, number, custom } from './kernel.js';

function buildTopicSummaryModelRow(doc) {
    const row = doc.createElement('div');
    row.className = 'vcp-settings-row';
    row.id = 'topicSummaryModelContainer';
    const label = doc.createElement('label');
    label.setAttribute('for', 'topicSummaryModel');
    label.textContent = '话题总结模型:';
    const container = doc.createElement('div');
    container.className = 'model-input-container';
    const input = doc.createElement('input');
    input.type = 'text';
    input.id = 'topicSummaryModel';
    input.name = 'topicSummaryModel';
    input.placeholder = '默认: gemini-2.5-flash-preview-05-20';
    const button = doc.createElement('button');
    button.type = 'button';
    button.id = 'openTopicSummaryModelSelectBtn';
    button.className = 'small-button';
    button.title = '选择模型';
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('data-slot', 'icon');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('d', 'M19.5 8.25l-7.5 7.5-7.5-7.5');
    svg.append(path);
    button.append(svg);
    container.append(input, button);
    const hint = doc.createElement('small');
    hint.setAttribute('data-vcp-style', '4');
    hint.textContent = '用于自动生成话题摘要的模型';
    row.append(label, container, hint);
    return row;
}

export const advancedFeaturesSection = section('advanced-features', '高级功能', [
    switchField('enableDistributedServer', {
        label: '启用VCP分布式服务器',
        rowStyle: 33,
    }),
    switchField('enableVcpToolInjection', {
        label: '开启VCP工具信息注入上下文',
        rowStyle: 33,
    }),
    switchField('enableThoughtChainInjection', {
        label: '元思考注入 AI 上下文',
        labelTitle: '开启后，AI 的元思考内容（Thought Chain）将保留在上下文中，否则将被自动清理。',
        rowStyle: 33,
    }),
    switchField('enableAiMessageButtons', {
        label: '启用AI消息快捷按钮',
        labelTitle: '开启后，AI回复中的按钮将可以点击并自动发送消息',
        rowStyle: 33,
    }),
    switchField('enableContextSanitizer', {
        label: '上下文HTML标签转MD净化器',
        labelTitle: '开启后，在提交给AI的上下文中，较早的AI消息的HTML将被转换为Markdown以节省Token。',
    }),
    number('contextSanitizerDepth', {
        label: '净化初始深度:',
        hint: '例如: 设置为2，则从倒数第3条AI消息开始净化。设置为0，则净化所有AI消息。',
        min: 0,
        defaultValue: 2,
        groupId: 'contextSanitizerDepthContainer',
        rowStyle: 34,
        controlStyle: 19,
        hintStyle: 4,
        when: ['enableContextSanitizer'],
        save: { parse: 'int', fallback: 0 },
    }),
    switchField('agentMusicControl', {
        label: '启用Agent音乐控制',
        rowStyle: 35,
    }),
    // 旧 advancedDivider（<hr>，data-vcp-style=36）不再编译输出：行语义分隔
    // 由 canonical 行自带的 hairline 承担，投影 pass 本就挂载即删（M5-b）。
    custom('topicSummaryModelContainer', buildTopicSummaryModelRow, ['topicSummaryModel'], {
        saveMap: { topicSummaryModel: { trim: true } },
    }),
]);
