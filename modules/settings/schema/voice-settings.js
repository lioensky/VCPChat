// schema/voice-settings — "语音设置" 分区（M1）。
// 语音工作模式是单选组（M5-c pass5 起分段结构由渲染器直出，运行期只绑
// 行为）；输入模式为语言行胶囊 select；其余为 text/url/password 行。
import { section, radioGroup, radio, select, text, number, card } from './kernel.js';

export const voiceSettingsSection = section('voice-settings', '语音设置', [
    radioGroup('voiceModeGroup', {
        label: '语音工作模式',
        hint: '该选项为全局语音管线预留主开关，当前主要作用于语音聊天体系配置分流。',
        radios: [
            radio('voiceModeLocal', {
                name: 'voiceMode', value: 'local', checked: true, label: '本地推理模式',
                // 仅回填：collect 由 voiceModeNetwork 的 else 分支覆盖。
                save: { valuePath: 'voiceMode', checkedValue: 'local', collect: false },
            }),
            radio('voiceModeNetwork', {
                name: 'voiceMode', value: 'network', label: '网络 MiMo TTS 模式',
                save: { valuePath: 'voiceMode', checkedValue: 'network', elseValue: 'local' },
            }),
        ],
    }),
    select('voiceInputMode', {
        rowId: 'voiceInputModeRow',
        groupRowClass: 'vcp-settings-row',
        languageRow: {
            title: '语音输入模式',
            description: '两种模式均使用同一快捷键启停。右 Alt 模式会在听写期间由程序持续模拟按住右 Alt，无需手动长按快捷键。',
        },
        hintStyle: null,
        options: [
            { value: 'windows_voice_typing', label: 'Windows 语音键入（Win+H）' },
            { value: 'right_alt_hold', label: '输入法语音（模拟长按右 Alt）' },
        ],
        save: { allowed: ['windows_voice_typing', 'right_alt_hold'], fallback: 'windows_voice_typing' },
    }),
    text('voiceInputShortcut', {
        inputType: 'text',
        label: '语音输入快捷键:',
        value: 'F7',
        placeholder: '当前支持 F1 - F24',
        hint: '当前支持 F1 - F24 单键。按一次开始听写，再按一次停止并发送；停止后会等待输入法完成文字上屏和静默防抖，请勿连续快速触发。',
        save: { trim: true, falsy: 'F7', upper: true },
    }),
    card('mainChatVoiceSettingsCard', {
        cardKey: 'main-chat-voice-card',
        title: '主聊天界面语音交互设置',
        description: '配置主聊天普通输入框的麦克风按钮行为与停顿关闭时长；独立语音聊天子窗口不受影响。',
        fields: [
            number('mainChatVoiceInitialIdleTimeout', {
                label: '未发声超时关闭 (秒):',
                hint: '开启听写后未检测到有效发声时的自动关闭时长，默认 5.5 秒。',
                defaultValue: 5.5,
                step: 0.5,
                min: 1,
                max: 12,
                save: { parse: 'float', nanFallback: 5.5, fallback: 5.5, min: 1, max: 12 },
            }),
            number('mainChatVoiceQuietTimeout', {
                label: '语音静音自动关闭 (秒):',
                hint: '说话转文字完成后的静默关闭时长，达到该时长后自动结束并上屏，默认 2.5 秒。',
                defaultValue: 2.5,
                step: 0.5,
                min: 0.5,
                max: 15,
                save: { parse: 'float', nanFallback: 2.5, fallback: 2.5, min: 0.5, max: 15 },
            }),
            text('mainChatVoiceClearPhrase', {
                inputType: 'text',
                label: '主页面语音清空短语:',
                placeholder: '例如: 清空, 清除 (留空不启用，多短语用逗号隔开)',
                hint: '留空表示不启用快捷短语。识别文字中包含该短语时直接清空输入框，支持中英文逗号隔开，短语首尾空格自动清除。',
                save: { trim: true, falsy: '' },
            }),
            text('mainChatVoiceSendPhrase', {
                inputType: 'text',
                label: '主页面语音发送短语:',
                placeholder: '例如: 发送, 发出 (留空不启用，多短语用逗号隔开)',
                hint: '留空表示不启用快捷短语。识别文字中包含该短语时剥离短语并直接发送消息，支持中英文逗号隔开，短语首尾空格自动清除。注意：当 AI 正在流式输出时，不会探测发送快捷短语（既不会发送，也不会将其从文本中清除，作为普通文字完整保留）；清空快捷短语不受此影响，仍可随时执行清空。',
                save: { trim: true, falsy: '' },
            }),
        ],
    }),
    text('voiceNetworkProviderUrl', {
        inputType: 'url',
        label: 'MiMo API URL:',
        placeholder: 'https://www.dmxapi.cn/v1 或 https://api.xiaomimimo.com/v1',
        hint: '可填写到 /v1，也可填写完整的 /v1/chat/completions。',
        save: { valuePath: 'voiceNetworkSettings.providerUrl', trim: true, falsy: '' },
    }),
    text('voiceNetworkProviderKey', {
        inputType: 'password',
        label: 'MiMo API Key:',
        placeholder: '填写与 URL 属于同一平台的 API Key',
        save: { valuePath: 'voiceNetworkSettings.providerKey', falsy: '' },
    }),
    text('voiceLocalSovitsUrl', {
        inputType: 'url',
        label: '本地 SoVITS URL:',
        placeholder: '例如: http://127.0.0.1:9880',
        save: { valuePath: 'voiceLocalSettings.sovitsUrl', trim: true, falsy: '' },
    }),
    text('voiceLocalSovitsKey', {
        inputType: 'password',
        label: '本地 SoVITS Key:',
        placeholder: '如无可留空',
        save: { valuePath: 'voiceLocalSettings.sovitsKey', falsy: '' },
    }),
]);
