// schema/appearance-settings — 界面与外观分区（M3）。
// 全分区行结构对齐 main.html：裸 select 行（密度/圆角/字体/字号/内容宽度/
// 页面材质/列表项圆角）由 appearance-controls 的语言行/字号行 passes 以
// `#<key>Row` 为宿主重建可见 UI；几何滑杆由 appearance-ranges 挂 stepper；
// 主页视觉开关由 appearance-toggles 接管；场景字体与呈现模式是自包含组件
// （widgets.js），8 个字体控件与 3 个呈现模式 radio 通过 captureKeys 参与
// 现值快照。appearance-studio 只读 data-appearance-summary-* 摘要与
// openAppearanceStudioFromSettings 按钮，profile key 不变。
import { section, switchField, text, select, range, radio, radioGroup, numberCells, number, custom } from './kernel.js';
import { buildAppearanceWorkbenchCard, buildFontScenarioPreviewRow, buildChatPresentationModeFieldset } from '../render/widgets.js';

const CHAT_BUBBLE_WIDE_WIDTH_DEFAULT = 92;

export const appearanceSettingsSection = section('appearance-settings', '界面与外观', [
    custom('appearanceSettingsWorkbenchCard', buildAppearanceWorkbenchCard),
    switchField('showHomeVisualBrand', {
        variant: 'homeVisual',
        label: '主页视觉文字',
        description: '在空会话中显示 VCPCHAT 标识与寄语',
        ariaLabel: '显示主页视觉文字',
        checked: true,
    }),
    switchField('showHomeVisualTagline', {
        variant: 'homeVisual',
        label: '首页寄语',
        description: '显示在 VCPCHAT 视觉文字下方',
        ariaLabel: '显示首页寄语',
        checked: true,
    }),
    text('homeVisualTagline', {
        rowAsLabel: true,
        label: '寄语内容',
        maxLength: 120,
        value: '语义级打穿 AI、UI/UX、APP 与人类想象力的边界',
    }),
    select('appearanceDensity', {
        bareRow: true,
        rowId: 'appearanceDensityRow',
        options: [
            { value: 'compact', label: '紧凑' },
            { value: 'comfortable', label: '舒适' },
            { value: 'relaxed', label: '宽松' },
        ],
    }),
    select('appearanceRadius', {
        bareRow: true,
        rowId: 'appearanceRadiusRow',
        options: [
            { value: 'square', label: '直角 · 0px' },
            { value: 'small', label: '小圆角 · 6px 基准' },
            { value: 'medium', label: '中圆角 · 10px 基准' },
            { value: 'round', label: '大圆角 · 14px 基准' },
            { value: 'custom', label: '自定义' },
        ],
    }),
    select('appearanceTypography', {
        bareRow: true,
        rowId: 'appearanceTypographyRow',
        options: [
            { value: 'system', label: '系统字体' },
            { value: 'humanist', label: 'VChat 人文无衬线' },
            { value: 'serif', label: '衬线字体' },
        ],
    }),
    select('appearanceFontScale', {
        bareRow: true,
        rowId: 'appearanceFontScaleRow',
        options: [
            { value: 'small', label: '较小' },
            { value: 'normal', label: '标准' },
            { value: 'large', label: '较大' },
        ],
    }),
    select('appearanceContentWidth', {
        bareRow: true,
        rowId: 'appearanceContentWidthRow',
        options: [
            { value: 'full', label: '铺满' },
            { value: 'centered', label: '居中阅读' },
        ],
    }),
    select('appearanceSurface', {
        bareRow: true,
        rowId: 'appearanceSurfaceRow',
        options: [
            { value: 'translucent', label: '跟随主题' },
            { value: 'solid', label: '纯色' },
            { value: 'custom', label: '自定义磨砂' },
        ],
    }),
    range('appearanceSidebarRowHeight', {
        geometry: true,
        label: '列表项高度',
        min: 38, max: 64, step: 1, value: 46,
        outputText: '46px',
    }),
    range('appearanceSidebarAvatarSize', {
        geometry: true,
        label: '头像大小',
        min: 20, max: 52, step: 1, value: 32,
        outputText: '32px',
    }),
    select('appearanceSidebarRadius', {
        bareRow: true,
        rowId: 'appearanceSidebarRadiusLanguageRow',
        rowClass: 'appearance-radius-language-host',
        ariaLabel: '列表项圆角',
        options: [
            { value: 'tuned', label: '原设计 · 10px' },
            { value: 'follow', label: '跟随全局 · 自动' },
            { value: 'square', label: '直角 · 0px' },
            { value: 'small', label: '小圆角 · 6px' },
            { value: 'medium', label: '中圆角 · 10px' },
            { value: 'round', label: '大圆角 · 14px' },
            { value: 'custom', label: '自定义 · 使用下方数值' },
        ],
    }),
    range('appearanceCustomRadius', {
        geometry: true,
        label: '自定义圆角值',
        min: 0, max: 32, step: 1, value: 10,
        outputText: '10px',
        helper: '头像最大值会随当前列表项高度自动限制，避免超出圆角边界。',
    }),
    custom('fontScenarioPreviewGrid', buildFontScenarioPreviewRow, [
        'chatFontPreset', 'chatFontCustom',
        'chatCodeFontPreset', 'chatCodeFontCustom',
        'chatDiaryFontPreset', 'chatDiaryFontCustom',
        'chatToolFontPreset', 'chatToolFontCustom',
    ]),
    custom('chatPresentationModeGroup', buildChatPresentationModeFieldset, [
        'chatPresentationModeBubble',
        'chatPresentationModePanel',
        'chatPresentationModeImmersive',
    ]),
    radioGroup('chatLayoutMode', {
        label: '内容宽度',
        rowStyle: 12,
        hint: '气泡模式下控制气泡宽度；其他模式的外层宽度由聊天区域两侧边距自动决定。',
        radios: [
            radio('chatLayoutModeNormal', { name: 'chatLayoutMode', value: 'normal', label: '标准模式', checked: true }),
            radio('chatLayoutModeWide', { name: 'chatLayoutMode', value: 'wide', label: '宽屏模式' }),
        ],
    }),
    switchField('enableUserChatBubbleUi', {
        label: '以聊天气泡形式显示对话内容',
        hint: '仅作用于用户消息。关闭后，用户消息会改为靠左的文档流样式。',
        hintInsideWrapper: true,
        checked: true,
        when: ['chatPresentationModeBubble'],
    }),
    switchField('showUserMetaInChatBubbleUi', {
        rowId: 'userChatBubbleMetaSettings',
        label: '在气泡模式下显示用户头像和名字',
        hint: '关闭后，用户消息保留右侧气泡样式，但隐藏头像、名字和时间。',
        hintInsideWrapper: true,
        checked: true,
        when: ['chatPresentationModeBubble', 'enableUserChatBubbleUi'],
    }),
    numberCells('chatBubbleWideWidth', {
        label: '宽屏模式自定义宽度（%）',
        hint: '可设置范围为 50% - 98%。标准模式沿用系统默认宽度，这里只调整气泡模式的宽屏布局。',
        when: ['chatPresentationModeBubble', 'chatLayoutModeWide'],
        items: [
            number('chatBubbleMaxWidthWideDefault', {
                label: '普通聊天', min: 50, max: 98, step: 1,
                defaultValue: CHAT_BUBBLE_WIDE_WIDTH_DEFAULT,
            }),
            number('chatBubbleMaxWidthWideNotifications', {
                label: '通知侧栏打开', min: 50, max: 98, step: 1,
                defaultValue: 96,
            }),
            number('chatBubbleMaxWidthWideNarrow', {
                label: '窄窗口/小屏', min: 50, max: 98, step: 1,
                defaultValue: CHAT_BUBBLE_WIDE_WIDTH_DEFAULT,
            }),
        ],
    }),
]);
