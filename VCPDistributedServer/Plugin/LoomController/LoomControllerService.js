'use strict';

let runtime = {
    loomManager: null,
    logger: console,
};

function initialize(options = {}) {
    runtime = {
        loomManager: options.services?.loomManager || options.loomManager || null,
        logger: options.logger || console,
    };
}

function requireManager() {
    if (!runtime.loomManager) {
        throw new Error('[LoomController] VCP Loom 管理器当前不可用。');
    }
    return runtime.loomManager;
}

function firstNonEmptyString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function normalizeCommand(args) {
    return firstNonEmptyString(
        args.command,
        args.action,
        args.commandIdentifier
    ).toLowerCase();
}

function requireAppId(args) {
    const appId = firstNonEmptyString(args.appId, args.app_id, args.id);
    if (!appId) throw new Error('[LoomController] 缺少必需参数 appId。');
    return appId;
}

function requireActionId(args) {
    const actionId = firstNonEmptyString(args.actionId, args.action_id, args.webAction);
    if (!actionId) throw new Error('[LoomController] 缺少必需参数 actionId。');
    return actionId;
}

function requireImageId(args) {
    const imageId = firstNonEmptyString(args.imageId, args.image_id, args.target);
    if (!imageId) throw new Error('[LoomController] 缺少必需参数 imageId。');
    return imageId;
}

function parseObject(value, fieldName, fallback = {}) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') {
        throw new Error(`[LoomController] ${fieldName} 必须是 JSON 对象。`);
    }

    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('根值不是对象');
        }
        return parsed;
    } catch (error) {
        throw new Error(`[LoomController] ${fieldName} 不是有效的 JSON 对象：${error.message}`);
    }
}

function parseWaitMs(args = {}) {
    let value = args.waitMs ?? args.durationMs;
    if (value === undefined && args.seconds !== undefined) {
        value = Number(args.seconds) * 1000;
    }
    const parsed = value === undefined || value === ''
        ? 1000
        : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error('[LoomController] wait 时长必须是非负数。');
    }
    return Math.min(Math.round(parsed), 30000);
}

function delay(waitMs) {
    return new Promise((resolve) => setTimeout(resolve, waitMs));
}

function getSerialCommandEntries(args) {
    return Object.entries(args)
        .map(([key, value]) => {
            const match = key.match(/^command(\d+)$/i);
            return match
                ? { index: Number(match[1]), command: String(value || '').trim() }
                : null;
        })
        .filter((entry) => entry && entry.index > 0 && entry.command)
        .sort((a, b) => a.index - b.index);
}

function extractSerialStepArgs(rawArgs, index) {
    const suffix = String(index);
    const step = {};
    for (const [key, value] of Object.entries(rawArgs)) {
        const match = key.match(/^(.+?)(\d+)$/);
        if (!match || Number(match[2]) !== index || match[1].toLowerCase() === 'command') continue;
        step[match[1]] = value;
    }

    // 公共 appId 由所有步骤继承；编号 appIdN 优先。
    step.appId = firstNonEmptyString(
        step.appId,
        step.app_id,
        rawArgs.appId,
        rawArgs.app_id,
        rawArgs.id
    );
    return step;
}

function buildSerialActionArgs(command, stepArgs) {
    const explicit = command.toLowerCase() === 'executeaction';
    const actionId = explicit
        ? requireActionId(stepArgs)
        : command;
    const params = parseObject(stepArgs.params ?? stepArgs.actionParams, 'params');
    const options = parseObject(stepArgs.options ?? stepArgs.actionOptions, 'options');
    const reserved = new Set([
        'appId', 'app_id', 'id',
        'actionId', 'action_id', 'webAction',
        'params', 'actionParams', 'options', 'actionOptions',
        'waitMs', 'durationMs', 'seconds',
    ]);
    const optionNames = new Set([
        'strict', 'verification', 'backend', 'actionBackend', 'allowFallback',
    ]);

    for (const [key, value] of Object.entries(stepArgs)) {
        if (reserved.has(key)) continue;
        if (optionNames.has(key)) {
            const optionKey = key === 'actionBackend' ? 'backend' : key;
            options[optionKey] = ['strict', 'allowFallback'].includes(optionKey)
                ? optionalBoolean(value, optionKey === 'allowFallback')
                : value;
        } else {
            params[key] = value;
        }
    }

    return {
        appId: requireAppId(stepArgs),
        actionId,
        params,
        options,
    };
}

function summarizeSerialStep(index, command, result) {
    if (result.status === 'failed') {
        return `- 步骤 ${index} · ${command}：失败 — ${result.error}`;
    }
    if (result.type === 'wait') {
        return `- 步骤 ${index} · ${command}：已等待 ${result.waitMs} ms`;
    }
    const details = result.output?.details || {};
    const response = details.response || {};
    return [
        `- 步骤 ${index} · ${command}：成功`,
        details.actionId ? `  - Action ID：${details.actionId}` : '',
        response.code ? `  - 结果码：${response.code}` : '',
    ].filter(Boolean).join('\n');
}

async function processSerialToolCall(rawArgs) {
    const entries = getSerialCommandEntries(rawArgs);
    if (!entries.length) {
        throw new Error('[LoomController] 串行请求未包含有效的 command1、command2 等字段。');
    }

    const steps = [];
    let failedStep = null;
    for (const entry of entries) {
        const stepArgs = extractSerialStepArgs(rawArgs, entry.index);
        const normalized = entry.command.toLowerCase();
        try {
            if (['wait', 'sleep', 'delay'].includes(normalized)) {
                const waitMs = parseWaitMs(stepArgs);
                await delay(waitMs);
                steps.push({
                    index: entry.index,
                    command: entry.command,
                    type: 'wait',
                    status: 'success',
                    waitMs,
                });
                continue;
            }

            let output;
            if (['getpageinfo', 'get_page_info', 'page_get_info'].includes(normalized)) {
                output = await getPageInfo(stepArgs);
            } else {
                output = await executeAction(buildSerialActionArgs(entry.command, stepArgs));
            }
            steps.push({
                index: entry.index,
                command: entry.command,
                type: 'command',
                status: 'success',
                output,
            });
        } catch (error) {
            failedStep = {
                index: entry.index,
                command: entry.command,
                type: ['wait', 'sleep', 'delay'].includes(normalized) ? 'wait' : 'command',
                status: 'failed',
                error: error.message,
            };
            steps.push(failedStep);
            break;
        }
    }

    const completedSteps = steps.filter((step) => step.status === 'success');
    const content = [{
        type: 'text',
        text: [
            failedStep
                ? '# LoomAPP 串行指令部分完成'
                : '# LoomAPP 串行指令执行完成',
            '',
            ...steps.map((step) => summarizeSerialStep(step.index, step.command, step)),
            failedStep ? '' : null,
            failedStep
                ? `步骤 ${failedStep.index} 失败，后续步骤已停止；此前 ${completedSteps.length} 个步骤的回执保留如下。`
                : null,
        ].filter((line) => line !== null).join('\n'),
    }];

    // 统一串行协议：保留失败前所有成功步骤的完整文本或多模态回执。
    for (const step of completedSteps) {
        if (!Array.isArray(step.output?.content)) continue;
        content.push({
            type: 'text',
            text: `## 步骤 ${step.index} · ${step.command} 回执`,
        });
        content.push(...step.output.content);
    }

    return {
        content,
        details: {
            command: 'SerialExecute',
            status: failedStep ? 'partial_failure' : 'success',
            count: steps.length,
            requestedCount: entries.length,
            completedCount: completedSteps.length,
            stopped: Boolean(failedStep),
            failedStep,
            appId: firstNonEmptyString(rawArgs.appId, rawArgs.app_id, rawArgs.id),
            steps: steps.map((step) => ({
                index: step.index,
                command: step.command,
                type: step.type,
                status: step.status,
                waitMs: step.waitMs,
                error: step.error,
                details: step.output?.details || null,
            })),
        },
    };
}

function optionalBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    throw new Error('[LoomController] refresh 必须为 true 或 false。');
}

function textResult(text, details = {}) {
    return {
        content: [
            {
                type: 'text',
                text,
            },
        ],
        details,
    };
}

function jsonText(value) {
    return JSON.stringify(value, null, 2);
}

function summarizeApps(apps, title) {
    if (!apps.length) return `${title}\n\n当前没有符合条件的 LoomAPP。`;
    return [
        title,
        '',
        ...apps.map((app) => [
            `- ${app.name} (${app.id || app.appId})`,
            `  - 状态：${app.running ? '运行中' : '未运行'}`,
            `  - URL：${app.url || app.startUrl || ''}`,
            app.loading === undefined ? '' : `  - 加载中：${app.loading ? '是' : '否'}`,
            app.error ? `  - 最近错误：${app.error}` : '',
        ].filter(Boolean).join('\n')),
    ].join('\n');
}

async function listApps() {
    const apps = requireManager().listApps();
    return textResult(summarizeApps(apps, '# LoomAPP 列表'), {
        command: 'ListApps',
        count: apps.length,
        apps,
    });
}

async function listOpenApps() {
    const apps = requireManager().listOpenApps();
    return textResult(summarizeApps(apps, '# 当前打开的 LoomAPP'), {
        command: 'ListOpenApps',
        count: apps.length,
        apps,
    });
}

async function createApp(args) {
    const manager = requireManager();
    const manifest = parseObject(args.manifest ?? args.config, 'manifest');
    const css = String(args.css ?? args.injectCss ?? '');
    const js = String(args.js ?? args.injectJs ?? '');
    const app = await manager.createApp({ manifest, css, js });
    return textResult(
        `LoomAPP “${app.name}” (${app.id}) 已创建，并已保存配置、CSS 与 JavaScript 注入源码。`,
        { command: 'CreateApp', app }
    );
}

async function openApp(args) {
    const appId = requireAppId(args);
    const app = await requireManager().openApp(appId);
    return textResult(
        `LoomAPP “${app.name}” (${app.id}) 已打开或聚焦。`,
        { command: 'OpenApp', app }
    );
}

async function closeApp(args) {
    const appId = requireAppId(args);
    await requireManager().closeApp(appId);
    return textResult(
        `LoomAPP “${appId}” 已关闭。`,
        { command: 'CloseApp', appId }
    );
}

async function getAppSources(args) {
    const appId = requireAppId(args);
    const sources = await requireManager().readSources(appId);
    const text = [
        `# LoomAPP 源码：${sources.manifest.name} (${sources.manifest.id})`,
        '',
        '## loom.json',
        '```json',
        jsonText(sources.manifest),
        '```',
        '',
        '## inject.css',
        '```css',
        sources.css,
        '```',
        '',
        '## inject.js',
        '```javascript',
        sources.js,
        '```',
    ].join('\n');
    return textResult(text, {
        command: 'GetAppSources',
        appId,
        sources,
    });
}

async function getRuntimeSource(args) {
    const appId = requireAppId(args);
    const source = await requireManager().readRuntimeSource(appId);
    const fence = source.source.includes('```') ? '````' : '```';
    const text = [
        `# LoomAPP 当前运行时源码：${source.title || appId}`,
        '',
        `- App ID：${appId}`,
        `- URL：${source.url}`,
        `- 获取时间：${source.capturedAt}`,
        `- 原始字节数：${source.originalByteLength}`,
        `- 是否截断：${source.truncated ? '是' : '否'}`,
        '',
        `${fence}html`,
        source.source,
        fence,
    ].join('\n');
    return textResult(text, {
        command: 'GetRuntimeSource',
        ...source,
    });
}

async function getRenderedText(args) {
    const appId = requireAppId(args);
    const refresh = optionalBoolean(args.refresh, true);
    const snapshot = await requireManager().readRenderedText(appId, { refresh });
    const text = [
        `# LoomAPP 已渲染成功文本：${snapshot.title || appId}`,
        '',
        `- App ID：${appId}`,
        `- URL：${snapshot.url}`,
        `- 快照时间：${snapshot.capturedAt}`,
        `- 原始字节数：${snapshot.originalByteLength}`,
        `- 是否截断：${snapshot.truncated ? '是' : '否'}`,
        '',
        snapshot.text,
    ].join('\n');
    return textResult(text, {
        command: 'GetRenderedText',
        ...snapshot,
    });
}

async function getPageInfo(args) {
    const appId = requireAppId(args);
    const pageInfo = await requireManager().getWebAgentPageInfo(appId);
    return textResult(pageInfo.markdown || [
        `# LoomAPP 页面状态：${pageInfo.title || appId}`,
        '',
        `- App ID：${appId}`,
        `- URL：${pageInfo.url || ''}`,
        `- 可操作元素：${pageInfo.elementCount || 0}`,
        `- Snapshot：${pageInfo.snapshotId || 0}`,
    ].join('\n'), {
        command: 'GetPageInfo',
        appId,
        pageInfo,
    });
}

async function getPageImage(args) {
    const appId = requireAppId(args);
    const imageId = requireImageId(args);
    const params = {
        imageId,
    };
    for (const field of [
        'format',
        'imageFormat',
        'quality',
        'maxWidth',
        'snapshotId',
        'documentGeneration',
        'runtimeInstanceId',
    ]) {
        if (args[field] !== undefined && args[field] !== null && args[field] !== '') {
            params[field] = args[field];
        }
    }

    const strict = optionalBoolean(args.strict, false);
    if (args.strict !== undefined) params.strict = strict;
    const execution = await requireManager().executeWebAgentAction(
        appId,
        'page_get_image',
        params,
        { strict }
    );
    const routed = execution.response?.result || {};
    const image = routed.result || routed;
    const dataUrl = firstNonEmptyString(image.dataUrl, image.url);
    if (!dataUrl.startsWith('data:image/')) {
        throw new Error('[LoomController] 页面图片动作未返回有效的 data:image Data URL。');
    }

    const summary = [
        '# LoomAPP 页面图片已获取',
        '',
        `- App ID：${appId}`,
        `- 图片 ID：${image.imageId || imageId}`,
        image.resolvedImageId ? `- 严格图片 ID：${image.resolvedImageId}` : '',
        image.kind ? `- 类型：${image.kind}` : '',
        image.caption ? `- 说明：${image.caption}` : (image.alt ? `- 说明：${image.alt}` : ''),
        image.outputSize
            ? `- 输出尺寸：${image.outputSize.width}×${image.outputSize.height}`
            : '',
        image.format ? `- 格式：${image.format}` : '',
        image.byteLength ? `- 字节数：${image.byteLength}` : '',
    ].filter(Boolean).join('\n');
    const { dataUrl: _dataUrl, url: _url, ...imageMetadata } = image;
    return {
        content: [
            { type: 'text', text: summary },
            { type: 'image_url', image_url: { url: dataUrl } },
        ],
        details: {
            command: 'GetPageImage',
            appId,
            actionId: execution.actionId,
            executedAt: execution.executedAt,
            responseCode: execution.response?.code,
            image: imageMetadata,
        },
    };
}

async function executeAction(args) {
    const appId = requireAppId(args);
    const actionId = requireActionId(args);
    const params = parseObject(args.params ?? args.actionParams, 'params');
    const options = parseObject(args.options ?? args.actionOptions, 'options');
    const execution = await requireManager().executeWebAgentAction(
        appId,
        actionId,
        params,
        options
    );
    const response = execution.response || {};
    const text = [
        `# LoomAPP 页面动作已执行`,
        '',
        `- App ID：${appId}`,
        `- Action ID：${execution.actionId}`,
        `- 状态：${response.status || 'success'}`,
        `- 结果码：${response.code || 'COMMAND_COMPLETED'}`,
        `- 消息：${response.message || '动作执行完成'}`,
        `- 执行时间：${execution.executedAt}`,
        '',
        '## 结构化结果',
        '```json',
        jsonText(response.result ?? response),
        '```',
    ].join('\n');
    return textResult(text, {
        command: 'ExecuteAction',
        ...execution,
    });
}

async function editAppSources(args) {
    const appId = requireAppId(args);
    const hasManifest = args.manifest !== undefined || args.config !== undefined;
    const payload = {
        manifest: hasManifest
            ? parseObject(args.manifest ?? args.config, 'manifest')
            : undefined,
        css: args.css === undefined && args.injectCss === undefined
            ? undefined
            : String(args.css ?? args.injectCss ?? ''),
        js: args.js === undefined && args.injectJs === undefined
            ? undefined
            : String(args.js ?? args.injectJs ?? ''),
    };

    if (
        payload.manifest === undefined
        && payload.css === undefined
        && payload.js === undefined
    ) {
        throw new Error('[LoomController] EditAppSources 至少需要 manifest、css 或 js 中的一项。');
    }

    const app = await requireManager().editAppSources(appId, payload);
    return textResult(
        `LoomAPP “${app.name}” (${app.id}) 的配置与注入源码已更新${app.running ? '，运行实例已热应用变更' : ''}。`,
        {
            command: 'EditAppSources',
            app,
            updated: {
                manifest: payload.manifest !== undefined,
                css: payload.css !== undefined,
                js: payload.js !== undefined,
            },
        }
    );
}

async function processToolCall(rawArgs = {}) {
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
        throw new Error('[LoomController] 无效的工具参数。');
    }

    if (getSerialCommandEntries(rawArgs).length) {
        return processSerialToolCall(rawArgs);
    }

    const command = normalizeCommand(rawArgs);
    switch (command) {
        case 'listapps':
            return listApps();
        case 'listopenapps':
            return listOpenApps();
        case 'createapp':
            return createApp(rawArgs);
        case 'openapp':
            return openApp(rawArgs);
        case 'closeapp':
            return closeApp(rawArgs);
        case 'getappsources':
            return getAppSources(rawArgs);
        case 'getruntimesource':
            return getRuntimeSource(rawArgs);
        case 'getrenderedtext':
            return getRenderedText(rawArgs);
        case 'getpageinfo':
            return getPageInfo(rawArgs);
        case 'getpageimage':
        case 'get_page_image':
        case 'page_get_image':
            return getPageImage(rawArgs);
        case 'executeaction':
            return executeAction(rawArgs);
        case 'editappsources':
            return editAppSources(rawArgs);
        default:
            throw new Error(
                '[LoomController] 不支持的 command。可用值：ListApps、ListOpenApps、CreateApp、OpenApp、CloseApp、GetAppSources、GetRuntimeSource、GetRenderedText、GetPageInfo、GetPageImage、ExecuteAction、EditAppSources。'
            );
    }
}

function resetForTests() {
    runtime = {
        loomManager: null,
        logger: console,
    };
}

module.exports = {
    initialize,
    processToolCall,
    _test: {
        normalizeCommand,
        requireActionId,
        requireImageId,
        parseObject,
        parseWaitMs,
        getSerialCommandEntries,
        extractSerialStepArgs,
        buildSerialActionArgs,
        resetForTests,
    },
};