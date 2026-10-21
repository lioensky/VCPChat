// schema/advanced-features — "高级功能" 分区（M2）。
// 依赖行：净化深度容器依赖 enableContextSanitizer（typed-field-owners
// 快照路径也按容器 id 直写其可见性，id 即锚点）。话题总结模型行为
// model-input-container 复合控件保留原生输入与 SettingsManager 兼容命令。
import { section, switchField, number, custom, text, textarea, disclosure } from './kernel.js';
import { buildFormIcon } from '../render/shared.js';

function buildTopicSummaryModelRow(doc) {
    const row = doc.createElement('div');
    row.className = 'vcp-settings-row';
    row.id = 'topicSummaryModelContainer';
    const label = doc.createElement('label');
    label.setAttribute('for', 'topicSummaryModel');
    label.textContent = '话题总结模型';
    const container = doc.createElement('div');
    container.className = 'model-input-container';
    const input = doc.createElement('input');
    input.type = 'text';
    input.id = 'topicSummaryModel';
    input.name = 'topicSummaryModel';
    input.value = 'gemini-2.5-flash-preview-05-20';
    input.placeholder = '默认: gemini-2.5-flash-preview-05-20';
    const button = doc.createElement('button');
    button.type = 'button';
    button.id = 'openTopicSummaryModelSelectBtn';
    button.className = 'small-button';
    button.title = '选择模型';
    // M5-c pass6：表单图标直出（原 form-icons pass 收编为 vcp-ui-icon 节点，
    // 由 lucide-adapter 统一渲染为下拉箭头）。
    button.append(buildFormIcon(doc, 'chevron-down'));
    container.append(input, button);
    const hint = doc.createElement('small');
    hint.setAttribute('data-vcp-style', '4');
    hint.textContent = '用于自动生成话题摘要的模型';
    row.append(label, container, hint);
    return row;
}

export const advancedFeaturesSection = section('advanced-features', '高级功能', [
    disclosure('contextCompactionSettings', {
        title: '上下文智能压缩（仅单聊）',
        description: '保留完整聊天历史，仅向主 AI 发送最新快照及后续消息。发送前达到 Agent 上下文容量的估算 85% 时压缩；流式工具回执结束时达到估算容量，则立即按正常中止回复流程停止并压缩。',
        open: false,
        fields: [
            switchField('enableContextCompaction', { label: '开启上下文智能压缩' }),
            text('contextCompactionModel', {
                label: '上下文压缩模型', hint: '填写模型 ID；使用当前 VCP 服务器和密钥。',
                when: ['enableContextCompaction'], save: { trim: true },
            }),
            textarea('contextCompactionPrompt', {
                label: '压缩提示词（引擎职责与输出规范）', defaultValue: '',
                placeholder: '留空使用默认压缩提示词',
                hint: '留空使用默认引擎职责与结构化快照输出规范。',
                when: ['enableContextCompaction'],
            }),
            textarea('contextCompactionSendPrompt', {
                label: '发送给压缩模型的提示词', defaultValue: '',
                placeholder: '留空使用默认发送提示词',
                hint: '留空使用默认提示词。占位符 {{conversation_history}} 注入带角色的原始历史数组；宿主已剥离日记。',
                when: ['enableContextCompaction'],
            }),
            textarea('contextCompactionMainPrompt', {
                label: '发送给主 AI 的提示词', defaultValue: '',
                placeholder: '留空使用默认接续提示词',
                hint: '留空使用默认提示词。占位符 {{context_checkpoint}} 为快照，{{latest_diaries}} 为宿主保留的最新日记原文。',
                when: ['enableContextCompaction'],
            }),
        ],
    }),
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
