// schema/selection-assistant — "划词助手" 分区（M1）。
// 调试面板挂载在调试开关行内（switch extra）；阈值/关键词行全部
// 以 data-visible-when 依赖 rustUseAssistant / rustEnableCustomThresholds /
// rustRuleMode 取值。划词 Agent 下拉的选项由运行时填充，节点整体保留。
import { section, select, switchField, number, textarea, custom } from './kernel.js';
import { buildRustDebugPanel } from '../render/widgets.js';

export const selectionAssistantSection = section('selection-assistant', '划词助手', [
    select('assistantAgent', {
        rowId: 'assistantAgentContainer',
        groupRowClass: 'vcp-settings-row',
        // Agent 列表由运行时填充并整体重建，语言行胶囊需镜像每次重建。
        languageRow: { title: '划词助手 Agent', description: '划词内容交给所选 Agent 处理', dynamic: true },
        hintStyle: null,
        options: [
            { value: '', label: '请选择一个Agent' },
        ],
    }),
    switchField('rustDebugMode', {
        label: '调试模式（输出诊断）',
        rowStyle: 23,
        extra: doc => [buildRustDebugPanel(doc)],
        save: false,
    }),
    switchField('rustUseAssistant', {
        label: '启用 Rust 划词助手',
        rowStyle: 23,
        save: false,
    }),
    switchField('rustEnableCustomThresholds', {
        label: '启用自定义阈值',
        rowStyle: 23,
        when: ['rustUseAssistant'],
        save: false,
    }),
    number('rustMinEventIntervalMs', {
        label: '最小事件间隔 (ms):',
        hint: '选区事件的最小时间间隔，防止重复触发',
        min: 0, defaultValue: 80,
        rowStyle: 26, controlStyle: 27, hintStyle: 28,
        grouped: true,
        when: ['rustUseAssistant', 'rustEnableCustomThresholds'],
        save: false,
    }),
    number('rustMinDistance', {
        label: '最小位移距离 (px):',
        hint: '鼠标释放点距离按下点的最小像素数（0 = 禁用此检查）',
        min: 0, defaultValue: 0,
        rowStyle: 26, controlStyle: 27, hintStyle: 28,
        grouped: true,
        when: ['rustUseAssistant', 'rustEnableCustomThresholds'],
        save: false,
    }),
    number('rustScreenshotSuspendMs', {
        label: '截图暂停时长 (ms):',
        hint: '检测到截图软件后，暂停的时长',
        min: 0, defaultValue: 3000,
        rowStyle: 26, controlStyle: 27, hintStyle: 28,
        grouped: true,
        when: ['rustUseAssistant', 'rustEnableCustomThresholds'],
        save: false,
    }),
    number('rustClipboardConflictSuspendMs', {
        label: '剪贴板冲突暂停 (ms):',
        hint: '检测到剪贴板冲突后，暂停的时长',
        min: 0, defaultValue: 1000,
        rowStyle: 26, controlStyle: 27, hintStyle: 28,
        grouped: true,
        when: ['rustUseAssistant', 'rustEnableCustomThresholds'],
        save: false,
    }),
    number('rustClipboardCheckIntervalMs', {
        label: '剪贴板检查间隔 (ms):',
        hint: '后台剪贴板监控的检查间隔（最小50ms）',
        min: 50, defaultValue: 500,
        rowStyle: 16, controlStyle: 27, hintStyle: 28,
        grouped: true,
        when: ['rustUseAssistant', 'rustEnableCustomThresholds'],
        save: false,
    }),
    select('rustRuleMode', {
        rowId: 'rustRuleModeRow',
        rowStyle: 29,
        languageRow: { title: '规则模式', description: 'Rust 划词助手的文本处理规则' },
        selectStyle: 30,
        hintStyle: 4,
        when: ['rustUseAssistant'],
        options: [
            { value: 'none', label: '不使用规则' },
            { value: 'whitelist', label: '白名单模式（只在匹配的应用中启用）' },
            { value: 'blacklist', label: '黑名单模式（在非匹配的应用中启用）' },
        ],
        save: false,
    }),
    textarea('rustWhitelistKeywords', {
        grouped: true,
        label: '白名单关键词（每行一个）',
        hint: '只在包含这些关键词的窗口中启用划词助手',
        rows: 3,
        placeholder: '例如：visual studio code\nchrome',
        textareaStyle: null,
        when: ['rustUseAssistant', 'rustRuleMode=whitelist'],
        save: false,
    }),
    textarea('rustBlacklistKeywords', {
        grouped: true,
        label: '黑名单关键词（每行一个）',
        hint: '在包含这些关键词的窗口中禁用划词助手',
        rows: 4,
        placeholder: '例如：password\ncredential\nsecret',
        textareaStyle: null,
        when: ['rustUseAssistant', 'rustRuleMode=blacklist'],
        save: false,
    }),
    textarea('rustScreenshotApps', {
        grouped: true,
        stacked: true,
        label: '截图软件关键词（每行一个）',
        hint: '检测到这些窗口时，暂停导词助手以避免冲突',
        rows: 3,
        placeholder: '例如：snippingtool\nsnipaste\ncapturescreen',
        textareaStyle: null,
        when: ['rustUseAssistant'],
        save: false,
    }),
], {
});
