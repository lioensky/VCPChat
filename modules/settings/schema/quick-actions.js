// schema/quick-actions — "快捷操作" 分区的设置项清单（M0 试点）。
// 文案、默认值与依赖子句逐字对齐原静态标记（main.html），控件锚点
// （id/name/容器 id）不变，保存链（handleSaveGlobalSettings）与
// typed-field-owners 的恢复/可见性直写路径按 id 命中原控件。
import { section, textarea, number, switchField, select } from './kernel.js';

export const quickActionsSection = section('quick-actions', '快捷操作', [
    textarea('continueWritingPrompt', {
        label: '中键续写默认提示词',
        hint: '提示：在输入框上中键点击时，如果输入框为空则使用此提示词进行续写；使用 ctrl/command+d 快速使用。',
        placeholder: '默认: 请继续',
        rows: 1,
        spellcheck: false,
        stacked: true,
        textareaStyle: 38,
        defaultValue: '请继续',
        save: { trim: true, falsy: '请继续' },
    }),
    number('flowlockContinueDelay', {
        label: '心流锁续写延迟 (秒):',
        hint: '提示：AI完成一次续写后，等待指定秒数再开始下一次续写。',
        min: 1,
        max: 300,
        step: 1,
        defaultValue: 5,
        save: { parse: 'int', fallback: 5 },
    }),
    switchField('enableMiddleClickQuickAction', {
        label: '启用在聊天气泡中的中键快捷功能',
    }),
    select('middleClickQuickAction', {
        groupId: 'middleClickQuickActionContainer',
        languageRow: { title: '中键快速执行功能', description: '按住中键从快捷环直接执行所选功能' },
        hint: '提示：启用后，中键按下消息气泡，1 秒内松开将快速执行选中的右键菜单功能',
        hidden: true,
        when: ['enableMiddleClickQuickAction'],
        options: [
            { value: '', label: '请选择要快速执行的功能' },
            { value: 'edit', label: '编辑消息' },
            { value: 'copy', label: '复制文本' },
            { value: 'createBranch', label: '创建分支' },
            { value: 'forward', label: '转发消息' },
            { value: 'readAloud', label: '朗读气泡' },
            { value: 'readMode', label: '阅读模式' },
            { value: 'regenerate', label: '重新回复' },
            { value: 'delete', label: '删除消息' },
        ],
    }),
    switchField('enableRegenerateConfirmation', {
        label: '重新回复保险机制',
        labelTitle: '开启后，当重新回复的消息不是最后一条时会显示确认对话框',
        rowId: 'regenerateConfirmationContainer',
        when: ['enableMiddleClickQuickAction', 'middleClickQuickAction=regenerate'],
    }),
    switchField('enableMiddleClickAdvanced', {
        label: '启用高级中键快捷环选择',
        rowId: 'middleClickAdvancedToggleRow',
        when: ['enableMiddleClickQuickAction'],
    }),
    number('middleClickAdvancedDelay', {
        label: '快捷环出现延迟 (毫秒):',
        groupId: 'middleClickAdvancedSettings',
        hint: '提示：中键按下后不松开，延迟若干时间 (1000-5000ms) 后出现快捷环选择界面，按住鼠标移动到相关功能后松开即可完成快速设置。',
        min: 1000,
        max: 5000,
        step: 100,
        defaultValue: 1000,
        when: ['enableMiddleClickQuickAction', 'enableMiddleClickAdvanced'],
        save: { parse: 'int', fallback: 1000, min: 1000 },
    }),
    // M5-b canonical 直出试点：本分区由渲染器直接产出 canonical 行。
], { canonicalRows: true });
