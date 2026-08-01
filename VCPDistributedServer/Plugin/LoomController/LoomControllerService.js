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
        case 'editappsources':
            return editAppSources(rawArgs);
        default:
            throw new Error(
                '[LoomController] 不支持的 command。可用值：ListApps、ListOpenApps、CreateApp、OpenApp、CloseApp、GetAppSources、GetRuntimeSource、GetRenderedText、EditAppSources。'
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
        parseObject,
        resetForTests,
    },
};