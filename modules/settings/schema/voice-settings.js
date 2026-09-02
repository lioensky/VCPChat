// schema/voice-settings — "语音设置" 分区（M1）。
// 语音工作模式是单选组（M5-c pass5 起分段结构由渲染器直出，运行期只绑
// 行为）；输入模式为语言行胶囊 select；其余为 text/url/password 行。
import { section, radioGroup, radio, select, text } from './kernel.js';

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
        languageRow: { title: '语音输入模式', description: '选择系统听写适配方式' },
        hintStyle: null,
        options: [
            { value: 'windows_voice_typing', label: 'Windows 语音键入（Win+H）' },
            { value: 'right_alt_hold', label: '输入法语音（按住右 Alt）' },
        ],
        save: { allowed: ['windows_voice_typing', 'right_alt_hold'], fallback: 'windows_voice_typing' },
    }),
    text('voiceInputShortcut', {
        inputType: 'text',
        label: '语音输入快捷键:',
        value: 'F7',
        placeholder: '当前支持 F1 - F24',
        hint: '全局按住说话键。当前支持 F1 - F24 单键；按下开始听写，松开结束听写。',
        save: { trim: true, falsy: 'F7', upper: true },
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
