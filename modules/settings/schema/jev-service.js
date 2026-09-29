// schema/jev-service — 全局 Jev 结构化模糊判断服务配置。
import { section, card, switchField, select, text, number } from './kernel.js';

export const jevServiceSection = section('jev-service', 'Jev 服务', [
    card('jevConnection', {
        cardKey: 'jev-connection',
        title: 'Jev 决策服务',
        description: '为 VChat 后续功能提供快速、低成本、带置信度的结构化模糊判断。',
        fields: [
            switchField('jevEnabled', {
                label: '启用全局 Jev 服务',
                hint: '关闭时所有全局 Jev 决策请求都会被主进程拒绝。',
                hintInsideWrapper: true,
            }),
            select('jevProvider', {
                label: '服务提供商',
                rowId: 'jevProviderRow',
                options: [
                    { value: 'typesafe', label: 'TypeSafe 官方' },
                    { value: 'openrouter', label: 'OpenRouter' },
                ],
                languageRow: {
                    title: '服务提供商',
                    description: '切换提供商后，请确认下方 URL 与模型名称。',
                },
                save: {
                    allowed: ['typesafe', 'openrouter'],
                    fallback: 'typesafe',
                },
            }),
            text('jevApiUrl', {
                inputType: 'url',
                label: 'API URL',
                placeholder: 'https://api.typesafe.ai/v1/systemone',
                stacked: true,
                save: { trim: true },
            }),
            text('jevApiKey', {
                inputType: 'password',
                label: 'API Key（支持多个）',
                placeholder: '多个 Key 可用英文逗号、中文逗号或 | 分隔',
                description: '仅保存在本机 settings.json；多个 Key 按请求依次轮询，同一请求重试时不切换 Key。',
                stacked: true,
                save: { trim: true },
            }),
            text('jevModel', {
                label: '模型',
                placeholder: 'jev-latest',
                stacked: true,
                save: { trim: true },
            }),
        ],
    }),
    card('flowlockJev', {
        cardKey: 'flowlock-jev',
        title: '心流锁 JEV 裁决',
        description: 'Agent 生成候选，JEV 选择唯一下一步或结束。需先启用全局 JEV；新会话生效，失败不会降级为盲目续写。',
        fields: [
            switchField('flowlockJevEnabled', { label: '心流锁使用 JEV 裁决', checked: true }),
            number('flowlockJevMaxRounds', { label: '最大自治轮数（含规划轮）', min: 1, max: 200, step: 1, defaultValue: 30, save: { parse: 'int', min: 1, max: 200, fallback: 30 } }),
            number('flowlockJevMinConfidence', { label: 'Choice 最低置信度', min: 0, max: 1, step: 0.05, defaultValue: 0.6, description: '低于阈值停止并等待人工确认；置信度不是授权。', save: { parse: 'float', min: 0, max: 1, nanFallback: 0.6 } }),
            number('flowlockJevMinEvidence', { label: '证据 / 可执行性最低概率', min: 0, max: 1, step: 0.05, defaultValue: 0.85, description: 'Noul 门槛；默认值是保守应用策略，需用实际任务评估校准。', save: { parse: 'float', min: 0, max: 1, nanFallback: 0.85 } })
        ]
    }),
    card('jevReliability', {
        cardKey: 'jev-reliability',
        title: '可靠性与网络',
        description: '配置超时、指数退避重试和可选 HTTPS 代理。',
        fields: [
            number('jevTimeoutMs', {
                label: '请求超时',
                min: 1000,
                max: 300000,
                step: 1000,
                defaultValue: 30000,
                description: '单次请求最长等待时间',
                save: { parse: 'int', min: 1000, max: 300000, fallback: 30000 },
            }),
            number('jevMaxRetries', {
                label: '最大重试次数',
                min: 0,
                max: 10,
                step: 1,
                defaultValue: 2,
                description: '仅对限流、服务过载和网络错误重试',
                save: { parse: 'int', min: 0, max: 10, nanFallback: 2 },
            }),
            number('jevRetryBaseDelayMs', {
                label: '重试基础延迟',
                min: 1,
                max: 30000,
                step: 100,
                defaultValue: 500,
                description: '指数退避的初始等待时间',
                save: { parse: 'int', min: 1, max: 30000, fallback: 500 },
            }),
            text('jevProxyUrl', {
                inputType: 'url',
                label: 'HTTPS 代理 URL（可选）',
                placeholder: 'http://127.0.0.1:7890',
                stacked: true,
                save: { trim: true },
            }),
        ],
    }),
    card('jevOpenRouterMetadata', {
        cardKey: 'jev-openrouter-metadata',
        title: 'OpenRouter 应用标识',
        description: '仅使用 OpenRouter 时发送；留空不会影响 Jev 调用。',
        fields: [
            text('jevHttpReferer', {
                inputType: 'url',
                label: 'HTTP Referer（可选）',
                placeholder: 'https://your-site.example',
                stacked: true,
                save: { trim: true },
            }),
            text('jevAppTitle', {
                label: '应用标题',
                placeholder: 'VCPChat',
                stacked: true,
                save: { trim: true, fallback: 'VCPChat' },
            }),
        ],
    }),
]);