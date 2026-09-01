// schema/render-settings — "消息渲染" 分区（M1）。
// 流式开关（提示在包裹 div 内）、双 stepper 内联行、动画预设 select、
// 时长滑杆、自定义 CSS 行（含示例块）与动画预览组件。
import { section, switchField, inlineNumbers, select, range, textarea, custom } from './kernel.js';
import { buildStreamAnimationCustomExample, buildStreamAnimationPreview } from '../render/widgets.js';

function buildStreamAnimationCustomRow(doc) {
    const row = doc.createElement('div');
    row.className = 'vcp-settings-row';
    row.id = 'streamAnimationCustomRow';
    row.hidden = true;
    const label = doc.createElement('label');
    label.setAttribute('for', 'streamAnimationCustomCss');
    label.textContent = '自定义动画 CSS:';
    const area = doc.createElement('textarea');
    area.id = 'streamAnimationCustomCss';
    area.name = 'streamAnimationCustomCss';
    area.setAttribute('rows', '4');
    area.setAttribute('spellcheck', 'false');
    area.placeholder = 'opacity: 0;\ntransform: translateY(12px) scale(0.98);';
    const note = doc.createElement('small');
    note.textContent = '填写动画元素进入前的初始状态，无需选择器或花括号。结束状态固定恢复为 opacity: 1、transform: none、filter: none。';
    row.append(label, area, note, buildStreamAnimationCustomExample(doc));
    return row;
}

export const renderSettingsSection = section('render-settings', '消息渲染', [
    switchField('enableSmoothStreaming', {
        label: '开启高级流式渲染',
        hint: '对增量文本进行缓冲，使输出节奏更加平滑。',
        hintInsideWrapper: true,
    }),
    inlineNumbers('streamInlineNumbers', [
        { key: 'minChunkBufferSize', label: '最小渲染 Chunk 字数（≥1）', min: 1, defaultValue: 16 },
        { key: 'smoothStreamIntervalMs', label: '最小刷新间隔（ms，≥1）', min: 1, defaultValue: 100 },
    ]),
    select('streamAnimationPreset', {
        rowId: 'streamAnimationSettingsRow',
        groupRowClass: 'vcp-settings-row',
        hintStyle: null,
        options: [
            { value: 'slide-left', label: '右侧滑入（经典）' },
            { value: 'fade', label: '纯淡入' },
            { value: 'rise', label: '柔和上浮' },
            { value: 'scale', label: '轻微缩放' },
            { value: 'none', label: '关闭动画' },
            { value: 'custom', label: '自定义 CSS' },
        ],
    }),
    range('streamAnimationDurationMs', {
        rowId: 'streamAnimationDurationRow',
        min: 100,
        max: 2000,
        step: 50,
        value: 500,
        outputId: 'streamAnimationDurationValue',
        outputFor: 'streamAnimationDurationMs',
        outputText: '500ms',
    }),
    custom('streamAnimationCustomRow', buildStreamAnimationCustomRow, ['streamAnimationCustomCss']),
    custom('streamAnimationPreview', buildStreamAnimationPreview),
]);
