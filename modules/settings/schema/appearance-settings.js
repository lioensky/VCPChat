// schema/appearance-settings — 界面与外观分区（M3）。
// 全分区行结构对齐 main.html：裸 select 行（密度/圆角/字体/字号/内容宽度/
// 页面材质/列表项圆角）以 languageRow/fontSizeRow 元数据驱动 field-renderer
// 直出语言行/字号行结构（M5-c pass4），运行期只剩行为激活；几何滑杆由
// appearance-ranges 挂 stepper；
// 主页视觉开关由 appearance-toggles 接管；场景字体与呈现模式是自包含组件
// （widgets.js），8 个字体控件与 3 个呈现模式 radio 通过 captureKeys +
// saveMap 参与保存/回填（M5-a）。appearance-studio 只读
// data-appearance-summary-* 摘要与打开按钮，profile key 不变。
// 值语义：appearanceProfile 是复合键（分区 collect 钩子按旧保存链原样
// 组装、经 getAppearance().normalize 归一）；呈现模式经
// normalizeChatPresentationMode 收敛；标准模式气泡宽度三键不来自表单，
// 直接从现值钳位透传。
import { section, switchField, text, select, range, radio, radioGroup, numberCells, number, custom } from './kernel.js';
import { clampBubbleWidthPercent } from '../value-semantics.js';
import { buildAppearanceWorkbenchCard, buildFontScenarioPreviewRow, buildChatPresentationModeFieldset } from '../render/widgets.js';

const CHAT_BUBBLE_WIDE_WIDTH_DEFAULT = 92;
const HOME_TAGLINE_DEFAULT = '语义级打穿 AI、UI/UX、APP 与人类想象力的边界';
const APPEARANCE_PROFILE_SELECTS = [
    {
        key: 'appearanceDensity', profileKey: 'appearanceProfile.density',
        languageRow: { title: '界面密度', description: '调整设置页与工作区控件的疏密程度' },
        options: [
            { value: 'compact', label: '紧凑' },
            { value: 'comfortable', label: '舒适' },
            { value: 'relaxed', label: '宽松' },
        ],
    },
    {
        key: 'appearanceRadius', profileKey: 'appearanceProfile.radius',
        languageRow: { title: '圆角', description: '调整页面容器与控件的圆角风格' },
        options: [
            { value: 'square', label: '直角 · 0px' },
            { value: 'small', label: '小圆角 · 6px 基准' },
            { value: 'medium', label: '中圆角 · 10px 基准' },
            { value: 'round', label: '大圆角 · 14px 基准' },
            { value: 'custom', label: '自定义' },
        ],
    },
    {
        key: 'appearanceTypography', profileKey: 'appearanceProfile.typography',
        languageRow: { title: '界面字体', description: '选择界面使用的字体风格' },
        options: [
            { value: 'system', label: '系统字体' },
            { value: 'humanist', label: 'VChat 人文无衬线' },
            { value: 'serif', label: '衬线字体' },
        ],
    },
    {
        key: 'appearanceFontScale', profileKey: 'appearanceProfile.fontScale',
        fontSizeRow: { title: '字号', description: '调整界面文字大小' },
        options: [
            { value: 'small', label: '较小' },
            { value: 'normal', label: '标准' },
            { value: 'large', label: '较大' },
        ],
    },
    {
        key: 'appearanceContentWidth', profileKey: 'appearanceProfile.contentWidth',
        languageRow: { title: '内容宽度', description: '调整工作区内容的最大阅读宽度' },
        options: [
            { value: 'full', label: '铺满' },
            { value: 'centered', label: '居中阅读' },
        ],
    },
    {
        key: 'appearanceSurface', profileKey: 'appearanceProfile.surface',
        languageRow: { title: '导航材质', description: '选择侧栏与页面的表面材质' },
        options: [
            { value: 'translucent', label: '跟随主题' },
            { value: 'solid', label: '纯色' },
            { value: 'custom', label: '自定义磨砂' },
        ],
    },
];

export const appearanceSettingsSection = section('appearance-settings', '界面与外观', [
    custom('appearanceSettingsWorkbenchCard', buildAppearanceWorkbenchCard),
    switchField('showHomeVisualBrand', {
        variant: 'homeVisual',
        label: '主页视觉文字',
        description: '在空会话中显示 VCPCHAT 标识与寄语',
        ariaLabel: '显示主页视觉文字',
        checked: true,
        save: { present: true },
    }),
    switchField('showHomeVisualTagline', {
        variant: 'homeVisual',
        label: '首页寄语',
        description: '显示在 VCPCHAT 视觉文字下方',
        ariaLabel: '显示首页寄语',
        checked: true,
        save: { present: true },
    }),
    text('homeVisualTagline', {
        rowAsLabel: true,
        label: '寄语内容',
        maxLength: 120,
        value: HOME_TAGLINE_DEFAULT,
        save: { trim: true, slice: 120, falsy: HOME_TAGLINE_DEFAULT },
    }),
    ...APPEARANCE_PROFILE_SELECTS.map(({ key, profileKey, options, languageRow, fontSizeRow }) => select(key, {
        bareRow: true,
        rowId: `${key}Row`,
        options,
        languageRow,
        fontSizeRow,
        // profile 复合收集走分区钩子，这里只声明回填路径。
        save: { valuePath: profileKey, collect: false },
    })),
    range('appearanceSidebarRowHeight', {
        geometry: true,
        label: '列表项高度',
        min: 38, max: 64, step: 1, value: 46,
        outputText: '46px',
        save: { valuePath: 'appearanceProfile.sidebarRowHeight', collect: false },
    }),
    range('appearanceSidebarAvatarSize', {
        geometry: true,
        label: '头像大小',
        min: 20, max: 52, step: 1, value: 32,
        outputText: '32px',
        save: { valuePath: 'appearanceProfile.sidebarAvatarSize', collect: false },
    }),
    select('appearanceSidebarRadius', {
        bareRow: true,
        rowId: 'appearanceSidebarRadiusLanguageRow',
        rowClass: 'appearance-radius-language-host',
        ariaLabel: '列表项圆角',
        languageRow: { title: '列表项圆角', description: '控制助手、话题和账户列表项的圆角' },
        options: [
            { value: 'tuned', label: '原设计 · 10px' },
            { value: 'follow', label: '跟随全局 · 自动' },
            { value: 'square', label: '直角 · 0px' },
            { value: 'small', label: '小圆角 · 6px' },
            { value: 'medium', label: '中圆角 · 10px' },
            { value: 'round', label: '大圆角 · 14px' },
            { value: 'custom', label: '自定义 · 使用下方数值' },
        ],
        save: { valuePath: 'appearanceProfile.sidebarRadius', collect: false },
    }),
    range('appearanceCustomRadius', {
        geometry: true,
        label: '自定义圆角值',
        min: 0, max: 32, step: 1, value: 10,
        outputText: '10px',
        helper: '头像最大值会随当前列表项高度自动限制，避免超出圆角边界。',
        save: { valuePath: 'appearanceProfile.customRadius', collect: false },
    }),
    custom('fontScenarioPreviewGrid', buildFontScenarioPreviewRow, [
        'chatFontPreset', 'chatFontCustom',
        'chatCodeFontPreset', 'chatCodeFontCustom',
        'chatDiaryFontPreset', 'chatDiaryFontCustom',
        'chatToolFontPreset', 'chatToolFontCustom',
    ], {
        saveMap: {
            chatFontPreset: { currentFallback: 'chatFontPreset', fallback: 'system' },
            chatFontCustom: { trim: true, falsy: '' },
            chatCodeFontPreset: { currentFallback: 'chatCodeFontPreset', fallback: 'consolas' },
            chatCodeFontCustom: { trim: true, falsy: '' },
            chatDiaryFontPreset: { currentFallback: 'chatDiaryFontPreset', fallback: 'serif' },
            chatDiaryFontCustom: { trim: true, falsy: '' },
            chatToolFontPreset: { currentFallback: 'chatToolFontPreset', fallback: 'system' },
            chatToolFontCustom: { trim: true, falsy: '' },
        },
    }),
    custom('chatPresentationModeGroup', buildChatPresentationModeFieldset, [
        'chatPresentationModeBubble',
        'chatPresentationModePanel',
        'chatPresentationModeImmersive',
    ], {
        // 呈现模式是单选组复合键：collect 走分区钩子，这里声明三个成员
        // radio 的回填写值。
        saveMap: {
            chatPresentationModeBubble: { valuePath: 'chatPresentationMode', checkedValue: 'bubble', collect: false },
            chatPresentationModePanel: { valuePath: 'chatPresentationMode', checkedValue: 'panel', collect: false },
            chatPresentationModeImmersive: { valuePath: 'chatPresentationMode', checkedValue: 'immersive', collect: false },
        },
    }),
    radioGroup('chatLayoutMode', {
        label: '内容宽度',
        rowStyle: 12,
        hint: '气泡模式下控制气泡宽度；其他模式的外层宽度由聊天区域两侧边距自动决定。',
        radios: [
            radio('chatLayoutModeNormal', {
                name: 'chatLayoutMode', value: 'normal', label: '标准模式', checked: true,
                save: { valuePath: 'enableWideChatLayout', checkedValue: false, collect: false },
            }),
            radio('chatLayoutModeWide', {
                name: 'chatLayoutMode', value: 'wide', label: '宽屏模式',
                save: { valuePath: 'enableWideChatLayout', checkedValue: true, elseValue: false },
            }),
        ],
    }),
    switchField('enableUserChatBubbleUi', {
        label: '以聊天气泡形式显示对话内容',
        hint: '仅作用于用户消息。关闭后，用户消息会改为靠左的文档流样式。',
        hintInsideWrapper: true,
        checked: true,
        when: ['chatPresentationModeBubble'],
        save: { present: true },
    }),
    switchField('showUserMetaInChatBubbleUi', {
        rowId: 'userChatBubbleMetaSettings',
        label: '在气泡模式下显示用户头像和名字',
        hint: '关闭后，用户消息保留右侧气泡样式，但隐藏头像、名字和时间。',
        hintInsideWrapper: true,
        checked: true,
        when: ['chatPresentationModeBubble', 'enableUserChatBubbleUi'],
        save: { present: true },
    }),
    numberCells('chatBubbleWideWidth', {
        label: '宽屏模式自定义宽度（%）',
        hint: '可设置范围为 50% - 98%。标准模式沿用系统默认宽度，这里只调整气泡模式的宽屏布局。',
        when: ['chatPresentationModeBubble', 'chatLayoutModeWide'],
        items: [
            number('chatBubbleMaxWidthWideDefault', {
                label: '普通聊天', min: 50, max: 98, step: 1,
                defaultValue: CHAT_BUBBLE_WIDE_WIDTH_DEFAULT,
                save: { parse: 'int', nanFallback: 92, min: 50, max: 98 },
            }),
            number('chatBubbleMaxWidthWideNotifications', {
                label: '通知侧栏打开', min: 50, max: 98, step: 1,
                defaultValue: 96,
                save: { parse: 'int', nanFallback: 96, min: 50, max: 98 },
            }),
            number('chatBubbleMaxWidthWideNarrow', {
                label: '窄窗口/小屏', min: 50, max: 98, step: 1,
                defaultValue: CHAT_BUBBLE_WIDE_WIDTH_DEFAULT,
                save: {
                    parse: 'int',
                    // 兜底取现值钳位（旧链 clamp(current, 92)），再过 50-98 钳位。
                    nanFallback: scope => clampBubbleWidthPercent(scope.currentSettings?.chatBubbleMaxWidthWideNarrow, 92),
                    min: 50, max: 98,
                },
            }),
        ],
    }),
], {
    collect(scope) {
        const doc = scope.doc;
        const profile = scope.currentSettings?.appearanceProfile || {};
        const byId = id => doc?.getElementById(id)?.value;
        const collect = {
            // 呈现模式：单选组现值缺省时回落到现值，再经呈现模式归一。
            chatPresentationMode: scope.normalizeChatPresentationMode(
                doc?.querySelector('input[name="chatPresentationMode"]:checked')?.value
                    || scope.currentSettings?.chatPresentationMode
            ),
            // 标准模式气泡宽度三键没有表单控件，直接从现值钳位透传（旧链同）。
            chatBubbleMaxWidthDefault: clampBubbleWidthPercent(scope.currentSettings?.chatBubbleMaxWidthDefault, 82),
            chatBubbleMaxWidthNotifications: clampBubbleWidthPercent(scope.currentSettings?.chatBubbleMaxWidthNotifications, 90),
            chatBubbleMaxWidthNarrow: clampBubbleWidthPercent(scope.currentSettings?.chatBubbleMaxWidthNarrow, 85),
        };
        if (scope.getAppearance) {
            collect.appearanceProfile = scope.getAppearance()?.normalize({
                density: byId('appearanceDensity'),
                radius: byId('appearanceRadius'),
                typography: byId('appearanceTypography'),
                fontScale: byId('appearanceFontScale'),
                contentWidth: byId('appearanceContentWidth'),
                sidebarRowHeight: Number(byId('appearanceSidebarRowHeight')) || profile.sidebarRowHeight || 46,
                sidebarAvatarSize: Number(byId('appearanceSidebarAvatarSize')) || profile.sidebarAvatarSize || 32,
                customRadius: Number(byId('appearanceCustomRadius') ?? 10),
                surface: byId('appearanceSurface'),
                surfaceEffect: profile.surfaceEffect,
                surfaceOpacity: profile.surfaceOpacity,
                surfaceBlur: profile.surfaceBlur,
                surfaceSaturation: profile.surfaceSaturation,
                surfaceBrightness: profile.surfaceBrightness,
                surfaceBorder: profile.surfaceBorder,
                surfaceShadow: profile.surfaceShadow,
                surfaceSheen: profile.surfaceSheen,
                shellRadius: profile.shellRadius,
                composerRadius: profile.composerRadius,
                sidebarRadius: byId('appearanceSidebarRadius') || profile.sidebarRadius,
                cardRadius: profile.cardRadius,
            }, 'next') || scope.currentSettings?.appearanceProfile;
        }
        return collect;
    },
});
