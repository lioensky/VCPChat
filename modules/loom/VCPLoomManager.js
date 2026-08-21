'use strict';

const {
    BrowserWindow,
    WebContentsView,
    ipcMain,
    session,
    app,
    dialog,
    shell,
} = require('electron');
const path = require('path');
const fs = require('fs-extra');
const webAgentCore = require('./webcore');
const {
    createElectronWebAgentAdapter,
} = require('./webcore/electron-adapter');

const MANIFEST_FILE = 'loom.json';
const INJECT_CSS_FILE = 'inject.css';
const INJECT_JS_FILE = 'inject.js';
const DEVICE_PERMISSIONS_FILE = 'device-permissions.json';
const PACKAGE_FORMAT = 'vcp-loom-package';
const PACKAGE_VERSION = 1;
const TITLE_BAR_HEIGHT = 44;
const SAFE_APP_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const MAX_INJECT_BYTES = 2 * 1024 * 1024;
const MAX_SHARE_TEXT = 100000;
const MAX_RUNTIME_SOURCE = 4 * 1024 * 1024;
const MAX_RENDERED_TEXT = 500000;
const WEB_AGENT_WORLD_ID = 999;
const LOOM_PAGE_ACTIONS = Object.freeze(new Set([
    'page_get_info',
    'page_get_image',
    'page_query_html',
    'page_query_scripts',
    'page_code_search',
    'page_wait_for',
    'page_click',
    'page_type',
    'page_set_value',
    'page_send_keys',
    'page_select_option',
    'page_check',
    'page_hover',
    'page_scroll',
]));
const LOOM_ACTIONS = Object.freeze(new Set(
    webAgentCore.getCapabilityCatalog().map((definition) => definition.command)
));

const USER_AGENTS = Object.freeze({
    desktop: '',
    mobile: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
});

const DEFAULT_MANIFEST = Object.freeze({
    schemaVersion: 1,
    id: '',
    name: '未命名 LoomAPP',
    description: '',
    startUrl: 'https://example.com/',
    enabled: true,
    exposeInAppDrawer: true,
    exposeManagerInAppDrawer: true,
    icon: '',
    emoji: '🕸️',
    window: {
        width: 420,
        height: 780,
        minWidth: 320,
        minHeight: 480,
        maxWidth: null,
        maxHeight: null,
        resizable: true,
    },
    viewport: {
        width: 390,
        height: 700,
        autoResize: true,
    },
    request: {
        profile: 'mobile',
        userAgent: '',
        headers: {},
    },
    navigation: {
        allowPopups: false,
        openExternalOriginsInBrowser: false,
    },
    injection: {
        css: 'inject.css',
        js: 'inject.js',
    },
});

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeManifest(input = {}) {
    const base = clone(DEFAULT_MANIFEST);
    return {
        ...base,
        ...input,
        window: { ...base.window, ...(isPlainObject(input.window) ? input.window : {}) },
        viewport: { ...base.viewport, ...(isPlainObject(input.viewport) ? input.viewport : {}) },
        request: { ...base.request, ...(isPlainObject(input.request) ? input.request : {}) },
        navigation: { ...base.navigation, ...(isPlainObject(input.navigation) ? input.navigation : {}) },
        injection: { ...base.injection, ...(isPlainObject(input.injection) ? input.injection : {}) },
    };
}

function clampInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function optionalBound(value, min, max) {
    if (value === null || value === undefined || value === '') return null;
    return clampInteger(value, null, min, max);
}

function normalizeHeaders(headers) {
    if (!isPlainObject(headers)) return {};
    const normalized = {};
    for (const [rawName, rawValue] of Object.entries(headers)) {
        const name = String(rawName).trim();
        const value = String(rawValue ?? '').replace(/[\r\n]+/g, ' ').trim();
        if (!name || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue;
        if (name.toLowerCase() === 'cookie' || name.toLowerCase() === 'host') continue;
        normalized[name] = value;
    }
    return normalized;
}

function normalizeManifest(input, forcedId = null) {
    const manifest = mergeManifest(input);
    const id = String(forcedId || manifest.id || '').trim().toLowerCase();
    if (!SAFE_APP_ID.test(id)) {
        throw new Error('应用 ID 必须为 2-64 位小写字母、数字、短横线或下划线，且以字母或数字开头。');
    }

    let startUrl;
    try {
        startUrl = new URL(String(manifest.startUrl || ''));
    } catch {
        throw new Error('启动 URL 无效。');
    }
    if (!['http:', 'https:'].includes(startUrl.protocol)) {
        throw new Error('启动 URL 仅允许 http 或 https 协议。');
    }

    const profile = ['desktop', 'mobile', 'iphone', 'custom'].includes(manifest.request.profile)
        ? manifest.request.profile
        : 'desktop';

    const normalized = {
        schemaVersion: 1,
        id,
        name: String(manifest.name || id).trim().slice(0, 80) || id,
        description: String(manifest.description || '').trim().slice(0, 500),
        startUrl: startUrl.toString(),
        enabled: manifest.enabled !== false,
        exposeInAppDrawer: manifest.exposeInAppDrawer !== false,
        exposeManagerInAppDrawer: manifest.exposeManagerInAppDrawer !== false,
        icon: String(manifest.icon || '').trim().slice(0, 500),
        emoji: String(manifest.emoji || '🕸️').trim().slice(0, 8) || '🕸️',
        window: {
            width: clampInteger(manifest.window.width, 420, 320, 3840),
            height: clampInteger(manifest.window.height, 780, 360, 2160),
            minWidth: clampInteger(manifest.window.minWidth, 320, 240, 3840),
            minHeight: clampInteger(manifest.window.minHeight, 480, 240, 2160),
            maxWidth: optionalBound(manifest.window.maxWidth, 320, 7680),
            maxHeight: optionalBound(manifest.window.maxHeight, 360, 4320),
            resizable: manifest.window.resizable !== false,
        },
        viewport: {
            width: clampInteger(manifest.viewport.width, 390, 240, 3840),
            height: clampInteger(manifest.viewport.height, 700, 240, 4320),
            autoResize: manifest.viewport.autoResize !== false,
        },
        request: {
            profile,
            userAgent: String(manifest.request.userAgent || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 1000),
            headers: normalizeHeaders(manifest.request.headers),
        },
        navigation: {
            allowPopups: manifest.navigation.allowPopups === true,
            openExternalOriginsInBrowser: manifest.navigation.openExternalOriginsInBrowser === true,
        },
        injection: {
            css: INJECT_CSS_FILE,
            js: INJECT_JS_FILE,
        },
    };

    normalized.window.minWidth = Math.min(normalized.window.minWidth, normalized.window.width);
    normalized.window.minHeight = Math.min(normalized.window.minHeight, normalized.window.height);
    if (normalized.window.maxWidth !== null) {
        normalized.window.maxWidth = Math.max(normalized.window.maxWidth, normalized.window.width);
    }
    if (normalized.window.maxHeight !== null) {
        normalized.window.maxHeight = Math.max(normalized.window.maxHeight, normalized.window.height);
    }

    return normalized;
}

function safeText(value, maxBytes = MAX_INJECT_BYTES) {
    const text = String(value ?? '');
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new Error(`脚本内容超过 ${Math.round(maxBytes / 1024)} KB 限制。`);
    }
    return text;
}

class VCPLoomManager {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..');
        this.appDataRoot = options.appDataRoot || path.join(this.projectRoot, 'AppData');
        this.appsRoot = path.join(this.appDataRoot, 'LoomApps');
        this.managerUiPath = path.join(this.projectRoot, 'Loommodules', 'manager.html');
        this.shellUiPath = path.join(this.projectRoot, 'Loommodules', 'shell.html');
        this.deviceMenuUiPath = path.join(this.projectRoot, 'Loommodules', 'device-menu.html');
        this.preloadPath = path.join(this.projectRoot, 'preloads', 'loom.js');
        this.pagePreloadPath = path.join(this.projectRoot, 'preloads', 'loom-page.js');
        this.webCoreRoot = path.join(__dirname, 'webcore');
        this.webAgentSourceCache = null;
        this.mainWindow = options.mainWindow || null;
        this.openChildWindows = options.openChildWindows || [];
        this.managerWindow = null;
        this.instances = new Map();
        this.manifests = new Map();
        this.requestConfiguredPartitions = new Set();
        this.ipcRegistered = false;
        this.initialized = false;
        this.initializationPromise = null;
    }

    async initialize() {
        if (this.initialized) return this;
        if (this.initializationPromise) return this.initializationPromise;

        this.initializationPromise = (async () => {
            await fs.ensureDir(this.appsRoot);
            await this.reloadRegistry();
            this.registerIpc();
            this.initialized = true;
            console.log(`[VCPLoomManager] Initialized with ${this.manifests.size} app(s).`);
            return this;
        })();

        try {
            return await this.initializationPromise;
        } catch (error) {
            this.initializationPromise = null;
            throw error;
        }
    }

    assertAppId(appId) {
        const id = String(appId || '').trim().toLowerCase();
        if (!SAFE_APP_ID.test(id)) throw new Error('不安全或无效的 LoomAPP ID。');
        return id;
    }

    appDir(appId) {
        return path.join(this.appsRoot, this.assertAppId(appId));
    }

    manifestPath(appId) {
        return path.join(this.appDir(appId), MANIFEST_FILE);
    }

    injectionPath(appId, type) {
        const fileName = type === 'css' ? INJECT_CSS_FILE : INJECT_JS_FILE;
        return path.join(this.appDir(appId), fileName);
    }

    partitionName(appId) {
        return `persist:vcp-loom-${this.assertAppId(appId)}`;
    }

    async reloadRegistry() {
        await fs.ensureDir(this.appsRoot);
        const entries = await fs.readdir(this.appsRoot, { withFileTypes: true });
        const next = new Map();

        for (const entry of entries) {
            if (!entry.isDirectory() || !SAFE_APP_ID.test(entry.name)) continue;
            const manifestPath = path.join(this.appsRoot, entry.name, MANIFEST_FILE);
            if (!await fs.pathExists(manifestPath)) continue;
            try {
                const raw = await fs.readJson(manifestPath);
                const manifest = normalizeManifest(raw, entry.name);
                next.set(manifest.id, manifest);
            } catch (error) {
                console.warn(`[VCPLoomManager] Ignoring invalid app "${entry.name}": ${error.message}`);
            }
        }

        this.manifests = next;
        this.broadcastRegistryChanged();
        return this.listApps();
    }

    publicManifest(manifest) {
        const icon = this.resolveIcon(manifest);
        return {
            ...clone(manifest),
            icon,
            running: this.isRunning(manifest.id),
        };
    }

    listApps() {
        return Array.from(this.manifests.values())
            .map((manifest) => this.publicManifest(manifest))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }

    getApp(appId) {
        const id = this.assertAppId(appId);
        const manifest = this.manifests.get(id);
        if (!manifest) throw new Error(`LoomAPP "${id}" 不存在。`);
        return manifest;
    }

    resolveIcon(manifest) {
        if (!manifest.icon) return '';
        if (/^(data:|https?:|file:)/i.test(manifest.icon)) return manifest.icon;
        const candidate = path.resolve(this.appDir(manifest.id), manifest.icon);
        const relative = path.relative(this.appDir(manifest.id), candidate);
        if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.pathExistsSync(candidate)) return '';
        return `file:///${candidate.replace(/\\/g, '/')}`;
    }

    async readSources(appId) {
        const manifest = this.getApp(appId);
        const [css, js] = await Promise.all([
            fs.readFile(this.injectionPath(manifest.id, 'css'), 'utf8').catch(() => ''),
            fs.readFile(this.injectionPath(manifest.id, 'js'), 'utf8').catch(() => ''),
        ]);
        // 编辑器必须拿到清单中的原始图标值（通常是应用目录相对路径）；
        // file:// 展示 URL 仅供应用列表和桌面抽屉使用。
        return {
            manifest: {
                ...clone(manifest),
                running: this.isRunning(manifest.id),
            },
            css,
            js,
        };
    }

    listOpenApps() {
        return Array.from(this.instances.values())
            .filter((instance) => !instance.window.isDestroyed() && !instance.view.webContents.isDestroyed())
            .map((instance) => ({
                ...this.buildRuntimeState(instance),
                manifest: clone(instance.manifest),
            }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }

    getRunningInstance(appId) {
        const id = this.assertAppId(appId);
        const instance = this.instances.get(id);
        if (
            !instance
            || instance.window.isDestroyed()
            || instance.view.webContents.isDestroyed()
        ) {
            throw new Error(`LoomAPP "${id}" 当前未打开。`);
        }
        return instance;
    }

    buildRuntimeState(instance) {
        const contents = instance.view.webContents;
        const successfulRender = instance.lastSuccessfulRender;
        return {
            appId: instance.appId,
            name: instance.manifest.name,
            running: true,
            url: contents.isDestroyed() ? '' : contents.getURL(),
            loading: instance.loading,
            error: instance.lastError,
            pageTitle: successfulRender?.title || '',
            lastSuccessfulRenderAt: successfulRender?.capturedAt || null,
        };
    }

    truncateRuntimeContent(value, maxBytes) {
        const text = String(value ?? '');
        const byteLength = Buffer.byteLength(text, 'utf8');
        if (byteLength <= maxBytes) {
            return { content: text, byteLength, truncated: false };
        }

        let low = 0;
        let high = text.length;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= maxBytes) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        return {
            content: text.slice(0, low),
            byteLength,
            truncated: true,
        };
    }

    async captureRenderedSnapshot(instance) {
        const contents = instance.view.webContents;
        if (contents.isDestroyed()) throw new Error('LoomAPP 页面进程不可用。');

        const snapshot = await contents.executeJavaScript(`(() => ({
            title: document.title || '',
            url: location.href,
            text: (document.body && document.body.innerText ? document.body.innerText : '').trim()
        }))()`, true);
        const limited = this.truncateRuntimeContent(snapshot.text, MAX_RENDERED_TEXT);
        instance.lastSuccessfulRender = {
            title: String(snapshot.title || ''),
            url: String(snapshot.url || contents.getURL()),
            text: limited.content,
            originalByteLength: limited.byteLength,
            truncated: limited.truncated,
            capturedAt: new Date().toISOString(),
        };
        return clone(instance.lastSuccessfulRender);
    }

    async readRuntimeSource(appId) {
        const instance = this.getRunningInstance(appId);
        const contents = instance.view.webContents;
        const result = await contents.executeJavaScript(`(() => ({
            title: document.title || '',
            url: location.href,
            html: document.documentElement ? document.documentElement.outerHTML : ''
        }))()`, true);
        const limited = this.truncateRuntimeContent(result.html, MAX_RUNTIME_SOURCE);
        return {
            appId: instance.appId,
            title: String(result.title || ''),
            url: String(result.url || contents.getURL()),
            source: limited.content,
            originalByteLength: limited.byteLength,
            truncated: limited.truncated,
            capturedAt: new Date().toISOString(),
        };
    }

    async readRenderedText(appId, options = {}) {
        const instance = this.getRunningInstance(appId);
        const refresh = options.refresh !== false;
        if (refresh || !instance.lastSuccessfulRender) {
            await this.captureRenderedSnapshot(instance);
        }
        if (!instance.lastSuccessfulRender) {
            throw new Error(`LoomAPP "${instance.appId}" 尚无成功渲染的文本快照。`);
        }
        return {
            appId: instance.appId,
            ...clone(instance.lastSuccessfulRender),
        };
    }

    async getWebAgentSources() {
        if (this.webAgentSourceCache) return this.webAgentSourceCache;
        const files = [
            'web-agent-protocol.js',
            'web-agent-page-core.js',
            'web-agent-page-runtime-core.js',
        ];
        this.webAgentSourceCache = await Promise.all(files.map(async (fileName) => ({
            code: await fs.readFile(path.join(this.webCoreRoot, fileName), 'utf8'),
            url: `vcp-loom-webcore://${fileName}`,
        })));
        return this.webAgentSourceCache;
    }

    async waitForDocumentReady(instance, generation) {
        const contents = instance?.view?.webContents;
        if (!contents || contents.isDestroyed()) {
            throw new Error('LoomAPP 页面进程不可用。');
        }
        if (!contents.isLoadingMainFrame?.() && !instance.loading) return;

        await Promise.race([
            instance.documentReadyPromise,
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('等待 LoomAPP 文档加载完成超时。')),
                30000
            )),
        ]);
        if (generation !== instance.documentGeneration) {
            const error = new Error('页面已导航，放弃旧文档的 Web Agent 初始化。');
            error.code = 'LOOM_DOCUMENT_CHANGED';
            throw error;
        }
    }

    async initializeWebAgentRuntime(instance, generation = instance.documentGeneration) {
        const contents = instance?.view?.webContents;
        if (!contents || contents.isDestroyed()) {
            throw new Error('LoomAPP 页面进程不可用。');
        }

        await this.waitForDocumentReady(instance, generation);
        const sources = await this.getWebAgentSources();
        if (generation !== instance.documentGeneration) {
            const error = new Error('页面已导航，放弃旧文档的 Web Agent 初始化。');
            error.code = 'LOOM_DOCUMENT_CHANGED';
            throw error;
        }

        await contents.executeJavaScriptInIsolatedWorld(WEB_AGENT_WORLD_ID, [
            ...sources,
            {
                code: `(() => {
                    const core = globalThis.VCPWebAgentPageRuntimeCore;
                    if (!core || typeof core.createWebAgentPageRuntime !== 'function') {
                        throw new Error('VCP Web Agent Page Runtime Core 加载失败');
                    }
                    globalThis.__vcpLoomWebAgentRuntime = core.createWebAgentPageRuntime(
                        { window, document, Node },
                        {
                            runtimeInstanceId: ${JSON.stringify(`loom-${instance.appId}-${generation}-${Date.now()}`)},
                            redactSensitiveDom: true
                        }
                    );
                    return globalThis.__vcpLoomWebAgentRuntime.getIdentity();
                })()`,
                url: 'vcp-loom-webcore://bootstrap.js',
            },
        ], true);
        if (generation !== instance.documentGeneration) {
            const error = new Error('页面已导航，Web Agent 初始化结果已过期。');
            error.code = 'LOOM_DOCUMENT_CHANGED';
            throw error;
        }

        const identity = await contents.executeJavaScriptInIsolatedWorld(
            WEB_AGENT_WORLD_ID,
            [{
                code: 'globalThis.__vcpLoomWebAgentRuntime.getIdentity()',
                url: 'vcp-loom-webcore://identity.js',
            }],
            true
        );
        if (generation !== instance.documentGeneration) {
            const error = new Error('页面已导航，Web Agent 身份信息已过期。');
            error.code = 'LOOM_DOCUMENT_CHANGED';
            throw error;
        }
        instance.webAgentReady = true;
        instance.webAgentAdapter?.updateDocumentState(identity);
    }

    async ensureWebAgentRuntime(instance) {
        if (instance.webAgentReady) return instance;
        if (instance.webAgentInitializationPromise) {
            await instance.webAgentInitializationPromise;
            return instance;
        }

        const generation = instance.documentGeneration;
        const initialization = this.initializeWebAgentRuntime(instance, generation);
        instance.webAgentInitializationPromise = initialization;
        try {
            await initialization;
        } finally {
            if (instance.webAgentInitializationPromise === initialization) {
                instance.webAgentInitializationPromise = null;
            }
        }
        return instance;
    }

    async getWebAgentPageInfo(appId) {
        const instance = await this.ensureWebAgentRuntime(this.getRunningInstance(appId));
        const result = await instance.view.webContents.executeJavaScriptInIsolatedWorld(
            WEB_AGENT_WORLD_ID,
            [{
                code: `(() => {
                    const runtime = globalThis.__vcpLoomWebAgentRuntime;
                    if (!runtime) throw new Error('Loom Web Agent Runtime 尚未初始化');
                    return runtime.snapshot();
                })()`,
                url: 'vcp-loom-webcore://snapshot.js',
            }],
            true
        );
        return {
            appId: instance.appId,
            actionCatalog: webAgentCore.getCapabilityCatalog(),
            ...result,
        };
    }

    normalizeLoomActionId(actionId) {
        const input = String(actionId || '').trim();
        const resolved = webAgentCore.protocol.resolveCommand(input);
        if (!resolved.definition || !LOOM_ACTIONS.has(resolved.canonical)) {
            throw new Error(`不支持的 Loom Web Agent 动作：${input || '(empty)'}`);
        }
        return resolved.canonical;
    }

    async executeIsolatedPageOperation(instance, action, params = {}, request = {}) {
        await this.ensureWebAgentRuntime(instance);
        const serializedAction = JSON.stringify(action);
        const serializedParams = JSON.stringify(params);
        const serializedOptions = JSON.stringify({
            ...(request.options || {}),
            targetContext: request.targetContext || {},
        });
        return instance.view.webContents.executeJavaScriptInIsolatedWorld(
            WEB_AGENT_WORLD_ID,
            [{
                code: `(async () => {
                    const runtime = globalThis.__vcpLoomWebAgentRuntime;
                    if (!runtime) throw new Error('Loom Web Agent Runtime 尚未初始化');
                    return runtime.execute(
                        ${serializedAction},
                        ${serializedParams},
                        ${serializedOptions}
                    );
                })()`,
                url: `vcp-loom-webcore://action/${encodeURIComponent(action)}.js`,
            }],
            true
        );
    }

    async executeWebAgentAction(appId, actionId, params = {}, options = {}) {
        const instance = this.getRunningInstance(appId);
        const action = this.normalizeLoomActionId(actionId);
        if (!isPlainObject(params)) throw new Error('Loom Web Agent 动作 params 必须是对象。');
        if (!isPlainObject(options)) throw new Error('Loom Web Agent 动作 options 必须是对象。');

        if (!instance.webAgentRuntime) {
            throw new Error('Loom Web Agent 后端运行时尚未初始化。');
        }
        const response = await instance.webAgentRuntime.execute({
            command: action,
            targetContext: {
                adapter: 'electron-loom',
                targetId: instance.view.webContents.id,
                appId: instance.appId,
                ...(isPlainObject(params.targetContext) ? params.targetContext : {}),
            },
            params,
            options,
            metadata: {
                source: 'LoomController',
                loomAppId: instance.appId,
            },
        });

        if (response?.status === webAgentCore.protocol.Status.ERROR) {
            const error = new Error(response.error || response.message || `Loom 动作 ${action} 执行失败。`);
            error.code = response.code || 'LOOM_ACTION_FAILED';
            error.details = response.details || null;
            throw error;
        }

        return {
            appId: instance.appId,
            actionId: action,
            definition: webAgentCore.protocol.resolveCommand(action).definition,
            executedAt: new Date().toISOString(),
            response,
        };
    }

    async editAppSources(appId, payload = {}) {
        const id = this.assertAppId(appId);
        const current = await this.readSources(id);
        const suppliedManifest = isPlainObject(payload.manifest)
            ? payload.manifest
            : {};
        const manifest = {
            ...current.manifest,
            ...suppliedManifest,
            id,
            window: {
                ...current.manifest.window,
                ...(isPlainObject(suppliedManifest.window) ? suppliedManifest.window : {}),
            },
            viewport: {
                ...current.manifest.viewport,
                ...(isPlainObject(suppliedManifest.viewport) ? suppliedManifest.viewport : {}),
            },
            request: {
                ...current.manifest.request,
                ...(isPlainObject(suppliedManifest.request) ? suppliedManifest.request : {}),
            },
            navigation: {
                ...current.manifest.navigation,
                ...(isPlainObject(suppliedManifest.navigation) ? suppliedManifest.navigation : {}),
            },
            injection: {
                ...current.manifest.injection,
                ...(isPlainObject(suppliedManifest.injection) ? suppliedManifest.injection : {}),
            },
        };
        return this.saveApp({
            originalId: id,
            manifest,
            css: payload.css === undefined ? current.css : payload.css,
            js: payload.js === undefined ? current.js : payload.js,
        });
    }

    async saveApp(payload = {}) {
        const previousId = payload.originalId ? this.assertAppId(payload.originalId) : null;
        const manifest = normalizeManifest(payload.manifest || payload, previousId || null);
        const targetDir = this.appDir(manifest.id);

        if (!previousId && await fs.pathExists(targetDir)) {
            throw new Error(`LoomAPP ID "${manifest.id}" 已存在。`);
        }

        await fs.ensureDir(targetDir);
        await fs.writeJson(path.join(targetDir, MANIFEST_FILE), manifest, { spaces: 2 });
        await fs.writeFile(path.join(targetDir, INJECT_CSS_FILE), safeText(payload.css), 'utf8');
        await fs.writeFile(path.join(targetDir, INJECT_JS_FILE), safeText(payload.js), 'utf8');

        this.manifests.set(manifest.id, manifest);
        const instance = this.instances.get(manifest.id);
        if (instance && !instance.window.isDestroyed()) {
            instance.manifest = manifest;
            instance.window.setTitle(`VCP Loom · ${manifest.name}`);
            instance.window.setResizable(manifest.window.resizable);
            instance.window.setMinimumSize(manifest.window.minWidth, manifest.window.minHeight);
            instance.window.setMaximumSize(
                manifest.window.maxWidth || 100000,
                manifest.window.maxHeight || 100000
            );
            this.updateViewBounds(instance);
            this.configureRequestProfile(instance);
            this.sendToShell(instance, 'loom:shell-state', this.buildShellState(instance));
            await this.applyInjections(instance);
            try {
                await this.captureRenderedSnapshot(instance);
            } catch (error) {
                console.warn(`[VCPLoomManager] Failed to refresh rendered snapshot for ${instance.appId}: ${error.message}`);
            }
        }

        this.broadcastRegistryChanged();
        return this.publicManifest(manifest);
    }

    async createApp(payload = {}) {
        const source = payload.manifest || payload;
        const manifest = normalizeManifest(source);
        return this.saveApp({ ...payload, manifest });
    }

    async deleteApp(appId) {
        const id = this.assertAppId(appId);
        await this.closeApp(id);
        await fs.remove(this.appDir(id));
        this.manifests.delete(id);
        this.broadcastRegistryChanged();
        return { success: true };
    }

    async setEnabled(appId, enabled) {
        const sources = await this.readSources(appId);
        sources.manifest.enabled = Boolean(enabled);
        return this.saveApp({
            originalId: sources.manifest.id,
            manifest: sources.manifest,
            css: sources.css,
            js: sources.js,
        });
    }

    resolveUserAgent(manifest) {
        if (manifest.request.userAgent) return manifest.request.userAgent;
        if (manifest.request.profile === 'custom') return '';
        return USER_AGENTS[manifest.request.profile] || '';
    }

    configureRequestProfile(instance) {
        const contents = instance.view.webContents;
        const userAgent = this.resolveUserAgent(instance.manifest);

        if (userAgent && !contents.isDestroyed()) {
            contents.setUserAgent(userAgent);
        }
    }

    isAllowedHardwareOrigin(instance, rawOrigin) {
        try {
            const origin = new URL(String(rawOrigin || '')).origin;
            const currentUrl = instance.view.webContents.getURL();
            const allowed = new Set([new URL(instance.manifest.startUrl).origin]);
            if (currentUrl) allowed.add(new URL(currentUrl).origin);
            return allowed.has(origin);
        } catch {
            return false;
        }
    }

    devicePermissionsPath(appId) {
        return path.join(this.appDir(appId), DEVICE_PERMISSIONS_FILE);
    }

    normalizeDeviceOrigin(value) {
        try {
            return new URL(String(value || '')).origin;
        } catch {
            return '';
        }
    }

    deviceFingerprint(deviceType, device = {}) {
        const type = String(deviceType || device.type || '').toLowerCase();
        const vendorId = device.vendorId ?? device.usbVendorId;
        const productId = device.productId ?? device.usbProductId;

        // Chromium 的设备选择事件与刷新后的 device permission 回调不保证
        // 提供相同的展示字段和 HID collections。这里只使用跨枚举稳定的硬件
        // 标识；deviceId、名称和 collections 均不能参与持久授权匹配。
        return JSON.stringify({
            type,
            vendorId: Number.isFinite(Number(vendorId)) ? Number(vendorId) : null,
            productId: Number.isFinite(Number(productId)) ? Number(productId) : null,
            serialNumber: String(device.serialNumber || ''),
        });
    }

    normalizeStoredDeviceFingerprint(deviceType, fingerprint) {
        try {
            const identity = JSON.parse(String(fingerprint || ''));
            return this.deviceFingerprint(deviceType, identity);
        } catch {
            return String(fingerprint || '');
        }
    }

    async loadDevicePermissionGrants(appId) {
        try {
            const data = await fs.readJson(this.devicePermissionsPath(appId));
            const grants = Array.isArray(data?.grants) ? data.grants : [];
            return grants
                .filter((grant) =>
                    ['hid', 'usb', 'serial'].includes(grant?.deviceType)
                    && typeof grant.origin === 'string'
                    && typeof grant.fingerprint === 'string'
                )
                .map((grant) => ({
                    deviceType: grant.deviceType,
                    origin: this.normalizeDeviceOrigin(grant.origin),
                    // 自动兼容旧版包含 name/collections 的指纹格式；下次写入时
                    // 会自然迁移为稳定格式。
                    fingerprint: this.normalizeStoredDeviceFingerprint(
                        grant.deviceType,
                        grant.fingerprint
                    ),
                    name: String(grant.name || ''),
                    grantedAt: String(grant.grantedAt || ''),
                }))
                .filter((grant) => grant.origin);
        } catch {
            return [];
        }
    }

    async saveDevicePermissionGrants(instance) {
        await fs.writeJson(this.devicePermissionsPath(instance.appId), {
            schemaVersion: 1,
            grants: instance.devicePermissionGrants,
        }, { spaces: 2 });
    }

    hasDevicePermission(instance, deviceType, origin, device) {
        const normalizedOrigin = this.normalizeDeviceOrigin(origin);
        const fingerprint = this.deviceFingerprint(deviceType, device);
        return instance.devicePermissionGrants.some((grant) =>
            grant.deviceType === deviceType
            && grant.origin === normalizedOrigin
            && grant.fingerprint === fingerprint
        );
    }

    async grantDevicePermission(instance, deviceType, origin, device, name = '') {
        const normalizedOrigin = this.normalizeDeviceOrigin(origin);
        if (!normalizedOrigin) throw new Error('设备授权来源无效。');
        const fingerprint = this.deviceFingerprint(deviceType, device);
        const existing = instance.devicePermissionGrants.find((grant) =>
            grant.deviceType === deviceType
            && grant.origin === normalizedOrigin
            && grant.fingerprint === fingerprint
        );
        if (existing) {
            existing.name = String(name || existing.name || '');
            existing.grantedAt = new Date().toISOString();
        } else {
            instance.devicePermissionGrants.push({
                deviceType,
                origin: normalizedOrigin,
                fingerprint,
                name: String(name || ''),
                grantedAt: new Date().toISOString(),
            });
        }

        // 选择回调返回给 Chromium 之前必须完成持久化。否则 requestDevice()
        // 已成功但紧随其后的刷新可能早于授权文件落盘。
        await this.saveDevicePermissionGrants(instance);
    }

    revokeDevicePermission(instance, deviceType, origin, device) {
        const normalizedOrigin = this.normalizeDeviceOrigin(origin);
        const fingerprint = this.deviceFingerprint(deviceType, device);
        const before = instance.devicePermissionGrants.length;
        instance.devicePermissionGrants = instance.devicePermissionGrants.filter((grant) =>
            !(
                grant.deviceType === deviceType
                && grant.origin === normalizedOrigin
                && grant.fingerprint === fingerprint
            )
        );
        if (instance.devicePermissionGrants.length !== before) {
            void this.saveDevicePermissionGrants(instance).catch((error) => {
                console.warn(`[VCPLoomManager] Failed to persist revoked device permission for ${instance.appId}: ${error.message}`);
            });
        }
    }

    configureDevicePermissionBroker(instance) {
        const contents = instance.view.webContents;
        const persistentSession = contents.session;
        const permissionTypes = new Set(['hid', 'usb', 'serial']);

        persistentSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
            return permissionTypes.has(permission)
                && this.isAllowedHardwareOrigin(instance, requestingOrigin);
        });
        persistentSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
            const origin = details?.requestingOrigin || details?.securityOrigin || contents.getURL();
            callback(
                permissionTypes.has(permission)
                && this.isAllowedHardwareOrigin(instance, origin)
            );
        });
        persistentSession.setDevicePermissionHandler((details) => {
            const deviceType = String(details?.deviceType || '');
            return permissionTypes.has(deviceType)
                && this.isAllowedHardwareOrigin(instance, details?.origin)
                && this.hasDevicePermission(
                    instance,
                    deviceType,
                    details?.origin,
                    details?.device || {}
                );
        });

        const protocols = [
            {
                id: 'hid',
                selectEvent: 'select-hid-device',
                addedEvent: 'hid-device-added',
                removedEvent: 'hid-device-removed',
                initial: (args) => args[0]?.deviceList,
                callback: (args) => args[1],
                idOf: (device) => device?.deviceId,
                nameOf: (device) => device?.productName,
                requestOrigin: (args) =>
                    args[0]?.frameOrigin || args[0]?.origin || contents.getURL(),
                revokedEvent: 'hid-device-revoked',
                revokedDevice: (details) => details?.device,
                revokedOrigin: (details) => details?.origin,
            },
            {
                id: 'usb',
                selectEvent: 'select-usb-device',
                addedEvent: 'usb-device-added',
                removedEvent: 'usb-device-removed',
                initial: (args) => args[0]?.deviceList,
                callback: (args) => args[1],
                idOf: (device) => device?.deviceId,
                nameOf: (device) => device?.productName,
                requestOrigin: (args) =>
                    args[0]?.frameOrigin || args[0]?.origin || contents.getURL(),
                revokedEvent: 'usb-device-revoked',
                revokedDevice: (details) => details?.device,
                revokedOrigin: (details) => details?.origin,
            },
            {
                id: 'serial',
                selectEvent: 'select-serial-port',
                addedEvent: 'serial-port-added',
                removedEvent: 'serial-port-removed',
                initial: (args) => args[0],
                callback: (args) => args[2],
                idOf: (device) => device?.portId,
                nameOf: (device) => device?.displayName,
                requestOrigin: () => contents.getURL(),
                revokedEvent: 'serial-port-revoked',
                revokedDevice: (details) => details?.port,
                revokedOrigin: (details) => details?.origin,
            },
        ];

        const cleanupCallbacks = [];
        const publish = (protocol, devicesById) => {
            const devices = Array.from(devicesById.values()).map((device, index) => {
                const id = String(protocol.idOf(device) || '');
                const name = protocol.nameOf(device) || `${protocol.id.toUpperCase()} 设备 ${index + 1}`;
                const ids = [];
                if (device.vendorId !== undefined) {
                    ids.push(`VID ${Number(device.vendorId).toString(16).padStart(4, '0')}`);
                }
                if (device.productId !== undefined) {
                    ids.push(`PID ${Number(device.productId).toString(16).padStart(4, '0')}`);
                }
                if (device.serialNumber) ids.push(`SN ${device.serialNumber}`);
                return { id, name, detail: ids.join(' · ') };
            });
            this.sendToShell(instance, 'loom:device-candidates', {
                protocol: protocol.id,
                devices,
            });
        };

        for (const protocol of protocols) {
            const onSelect = (event, ...args) => {
                event.preventDefault();
                instance.pendingDeviceSelections.get(protocol.id)?.cancel();

                const callback = protocol.callback(args);
                if (typeof callback !== 'function') return;
                const devicesById = new Map();
                const add = (device) => {
                    const id = String(protocol.idOf(device) || '');
                    if (id) devicesById.set(id, device);
                };
                for (const device of Array.isArray(protocol.initial(args)) ? protocol.initial(args) : []) {
                    add(device);
                }

                let settled = false;
                const onAdded = (_event, device) => {
                    add(device);
                    publish(protocol, devicesById);
                };
                const onRemoved = (_event, device) => {
                    devicesById.delete(String(protocol.idOf(device) || ''));
                    publish(protocol, devicesById);
                };
                const finish = (deviceId = '') => {
                    if (settled) return;
                    settled = true;
                    persistentSession.removeListener(protocol.addedEvent, onAdded);
                    persistentSession.removeListener(protocol.removedEvent, onRemoved);
                    if (instance.pendingDeviceSelections.get(protocol.id)?.finish === finish) {
                        instance.pendingDeviceSelections.delete(protocol.id);
                    }
                    callback(String(deviceId || ''));
                };

                persistentSession.on(protocol.addedEvent, onAdded);
                persistentSession.on(protocol.removedEvent, onRemoved);
                instance.pendingDeviceSelections.set(protocol.id, {
                    protocol,
                    origin: this.normalizeDeviceOrigin(protocol.requestOrigin(args)),
                    devicesById,
                    finish,
                    cancel: () => finish(''),
                });
                publish(protocol, devicesById);
            };
            const onRevoked = (_event, details) => {
                const device = protocol.revokedDevice(details);
                const origin = protocol.revokedOrigin(details) || contents.getURL();
                if (device) {
                    this.revokeDevicePermission(instance, protocol.id, origin, device);
                }
            };
            persistentSession.on(protocol.selectEvent, onSelect);
            persistentSession.on(protocol.revokedEvent, onRevoked);
            cleanupCallbacks.push(() => {
                instance.pendingDeviceSelections.get(protocol.id)?.cancel();
                persistentSession.removeListener(protocol.selectEvent, onSelect);
                persistentSession.removeListener(protocol.revokedEvent, onRevoked);
            });
        }

        const onBluetooth = (event, devices, callback) => {
            event.preventDefault();
            let pending = instance.pendingDeviceSelections.get('bluetooth');
            if (!pending) {
                const devicesById = new Map();
                const finish = (deviceId = '') => {
                    if (instance.pendingDeviceSelections.get('bluetooth') === pending) {
                        instance.pendingDeviceSelections.delete('bluetooth');
                    }
                    callback(String(deviceId || ''));
                };
                pending = {
                    devicesById,
                    finish,
                    cancel: () => finish(''),
                };
                instance.pendingDeviceSelections.set('bluetooth', pending);
            }
            for (const device of Array.isArray(devices) ? devices : []) {
                const id = String(device?.deviceId || '');
                if (id) pending.devicesById.set(id, device);
            }
            this.sendToShell(instance, 'loom:device-candidates', {
                protocol: 'bluetooth',
                devices: Array.from(pending.devicesById.values()).map((device, index) => ({
                    id: String(device.deviceId || ''),
                    name: device.deviceName || `蓝牙设备 ${index + 1}`,
                    detail: '',
                })),
            });
        };
        contents.on('select-bluetooth-device', onBluetooth);
        cleanupCallbacks.push(() => {
            instance.pendingDeviceSelections.get('bluetooth')?.cancel();
            contents.removeListener('select-bluetooth-device', onBluetooth);
        });

        instance.devicePermissionCleanup = () => {
            for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
            for (const pending of instance.pendingDeviceSelections.values()) pending.cancel();
            instance.pendingDeviceSelections.clear();
        };
    }

    requestDeviceFromShell(instance, protocolId) {
        const protocol = String(protocolId || '').toLowerCase();
        if (!instance.deviceRequestStates) instance.deviceRequestStates = new Map();
        const requestState = {
            id: `${protocol}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            committed: false,
        };
        instance.deviceRequestStates.set(protocol, requestState);

        const scripts = {
            hid: `(async () => {
                if (!navigator.hid) throw new Error('当前页面不支持 WebHID');
                const selected = Array.from(await navigator.hid.requestDevice({ filters: [] }));
                return {
                    confirmed: selected.length > 0,
                    count: selected.length,
                    name: selected.map((device) => device.productName || 'HID 设备').join('、')
                };
            })()`,
            usb: `(async () => {
                if (!navigator.usb) throw new Error('当前页面不支持 WebUSB');
                const selected = await navigator.usb.requestDevice({ filters: [] });
                return {
                    confirmed: Boolean(selected),
                    count: selected ? 1 : 0,
                    name: selected?.productName || 'USB 设备'
                };
            })()`,
            serial: `(async () => {
                if (!navigator.serial) throw new Error('当前页面不支持 WebSerial');
                const selected = await navigator.serial.requestPort({ filters: [] });
                return {
                    confirmed: Boolean(selected),
                    count: selected ? 1 : 0,
                    name: '串口设备'
                };
            })()`,
            // WebBluetooth 没有 getDevices()，网站应直接消费 requestDevice()
            // 返回值；不能通过一次盲目刷新来“确认”授权。
            bluetooth: `(async () => {
                if (!navigator.bluetooth) throw new Error('当前页面不支持 WebBluetooth');
                const selected = await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
                return { confirmed: true, reload: false, count: 1, name: selected.name || '蓝牙设备' };
            })()`,
        };
        if (!Object.prototype.hasOwnProperty.call(scripts, protocol)) {
            throw new Error(`不支持的设备协议：${protocol}`);
        }

        const contents = instance.view.webContents;
        if (contents.isDestroyed()) throw new Error('LoomAPP 页面进程不可用。');
        const requestPromise = contents.executeJavaScript(scripts[protocol], true);
        void requestPromise.then((result) => {
            if (
                instance.deviceRequestStates?.get(protocol) !== requestState
                || requestState.committed
            ) {
                return;
            }
            if (!result?.confirmed) {
                this.sendToShell(instance, 'loom:device-candidates', {
                    protocol,
                    devices: [],
                    error: `设备已选择，但授权尚未稳定（当前可回读 ${Number(result?.count) || 0} 个设备）。页面未刷新，请重试。`,
                });
                return;
            }

            this.sendToShell(instance, 'loom:device-candidates', {
                protocol,
                devices: [],
                connected: true,
                count: Number(result.count) || 0,
                name: result.name || `${protocol.toUpperCase()} 设备`,
            });

            // 不在这里刷新。许多厂商站点会在 requestDevice() 完成后自行
            // 重建或刷新控制应用；再次 reload 会销毁新页面刚打开的 HID/USB/
            // Serial 句柄，导致首条 sendReport()/transferOut() 通讯失败。
        }).catch((error) => {
            // 厂商常在选择完成后立即刷新同 URL 的控制应用。此时旧页面中的
            // executeJavaScript 会因上下文销毁而拒绝，但主进程授权其实已经
            // 持久化并提交，不能让旧异步结果覆盖“已授权”状态。
            if (
                instance.deviceRequestStates?.get(protocol) !== requestState
                || requestState.committed
            ) {
                return;
            }
            this.sendToShell(instance, 'loom:device-candidates', {
                protocol,
                devices: [],
                error: error?.message || String(error),
            });
        });
        return { pending: true, protocol };
    }

    async selectDeviceFromShell(instance, payload = {}) {
        const protocol = String(payload.protocol || '').toLowerCase();
        const deviceId = String(payload.deviceId || '');
        const pending = instance.pendingDeviceSelections.get(protocol);
        if (!pending || !deviceId || !pending.devicesById.has(deviceId)) {
            throw new Error('设备候选已失效，请重新扫描。');
        }
        const device = pending.devicesById.get(deviceId);
        const name = pending.protocol?.nameOf?.(device)
            || device?.deviceName
            || `${protocol.toUpperCase()} 设备`;
        if (pending.protocol && ['hid', 'usb', 'serial'].includes(protocol)) {
            try {
                await this.grantDevicePermission(
                    instance,
                    protocol,
                    pending.origin || instance.view.webContents.getURL(),
                    device,
                    name
                );
            } catch (error) {
                // 持久化失败时取消 Chromium 选择，避免产生“本次看似成功、
                // 刷新或重启立即丢失”的半提交状态。
                pending.finish('');
                throw new Error(`设备授权持久化失败：${error.message}`);
            }
        }
        const requestState = instance.deviceRequestStates?.get(protocol);
        if (requestState) requestState.committed = true;

        // 这里才是权威成功点：授权记录已落盘，且即将向 Chromium 提交选择。
        // 提前通知菜单，避免厂商随即刷新页面导致旧 executeJavaScript 误报。
        this.sendToShell(instance, 'loom:device-candidates', {
            protocol,
            devices: [],
            connected: true,
            count: 1,
            name,
        });
        pending.finish(deviceId);
        return { connected: true, protocol, deviceId, name };
    }

    configureSession(manifest) {
        const partition = this.partitionName(manifest.id);
        const persistentSession = session.fromPartition(partition, { cache: true });
        const userAgent = this.resolveUserAgent(manifest);

        // 由 Chromium 会话原生设置 User-Agent。不要通过 webRequest 强制伪造
        // Sec-CH-UA-*；这些受保护头由 Chromium 根据实际网络栈生成，人为覆盖
        // 可能令站点的 HTML、脚本和缓存命中不同客户端变体。
        if (userAgent) {
            persistentSession.setUserAgent(userAgent, 'zh-CN,zh;q=0.9,en;q=0.8');
        }

        const requestHeaders = { ...manifest.request.headers };
        const configKey = `${partition}:request-profile-v3:${manifest.request.profile}:${JSON.stringify(requestHeaders)}`;

        if (!this.requestConfiguredPartitions.has(configKey)) {
            for (const key of this.requestConfiguredPartitions) {
                if (key.startsWith(`${partition}:`)) this.requestConfiguredPartitions.delete(key);
            }
            persistentSession.webRequest.onBeforeSendHeaders((details, callback) => {
                callback({
                    requestHeaders: {
                        ...details.requestHeaders,
                        ...requestHeaders,
                    },
                });
            });
            this.requestConfiguredPartitions.add(configKey);
        }

        return persistentSession;
    }

    async openApp(appId) {
        const manifest = this.getApp(appId);
        if (!manifest.enabled) throw new Error('此 LoomAPP 已停用。');

        const existing = this.instances.get(manifest.id);
        if (existing && !existing.window.isDestroyed()) {
            if (existing.window.isMinimized()) existing.window.restore();
            if (!existing.window.isVisible()) existing.window.show();
            existing.window.focus();
            return this.publicManifest(existing.manifest);
        }

        const persistentSession = this.configureSession(manifest);
        const win = new BrowserWindow({
            width: manifest.window.width,
            height: manifest.window.height,
            minWidth: manifest.window.minWidth,
            minHeight: manifest.window.minHeight,
            maxWidth: manifest.window.maxWidth || undefined,
            maxHeight: manifest.window.maxHeight || undefined,
            resizable: manifest.window.resizable,
            frame: false,
            title: `VCP Loom · ${manifest.name}`,
            backgroundColor: '#10131a',
            show: false,
            webPreferences: {
                preload: this.preloadPath,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });

        const view = new WebContentsView({
            webPreferences: {
                session: persistentSession,
                preload: this.pagePreloadPath,
                additionalArguments: [
                    `--loom-page-profile=${encodeURIComponent(manifest.request.profile)}`,
                ],
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                javascript: true,
                webSecurity: true,
            },
        });
        const deviceMenuView = new WebContentsView({
            webPreferences: {
                preload: this.preloadPath,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                javascript: true,
                webSecurity: true,
            },
        });
        deviceMenuView.setBackgroundColor('#00000000');

        const devicePermissionGrants = await this.loadDevicePermissionGrants(manifest.id);
        let resolveDocumentReady;
        const instance = {
            appId: manifest.id,
            manifest,
            window: win,
            view,
            deviceMenuView,
            cssKey: null,
            loading: true,
            lastError: null,
            lastSuccessfulRender: null,
            documentGeneration: 0,
            documentReadyPromise: new Promise((resolve) => {
                resolveDocumentReady = resolve;
            }),
            resolveDocumentReady,
            webAgentReady: false,
            webAgentInitializationPromise: null,
            webAgentAdapter: null,
            webAgentRuntime: null,
            deviceMenuOpen: false,
            devicePermissionGrants,
            pendingDeviceSelections: new Map(),
            deviceRequestStates: new Map(),
            devicePermissionCleanup: null,
        };
        this.configureDevicePermissionBroker(instance);
        instance.webAgentAdapter = createElectronWebAgentAdapter(view.webContents, {
            appId: manifest.id,
            worldId: WEB_AGENT_WORLD_ID,
            executePageOperation: (action, params, request) =>
                this.executeIsolatedPageOperation(instance, action, params, request),
        });
        instance.webAgentRuntime = webAgentCore.createRuntime(instance.webAgentAdapter, {
            audit: (entry) => {
                if (entry.phase === 'error') {
                    console.warn(`[VCPLoomManager] Web Agent ${instance.appId} ${entry.command || 'unknown'} failed.`);
                }
            },
        });

        this.instances.set(manifest.id, instance);
        win.contentView.addChildView(view);
        // 后加入的原生 View 位于网页 View 上方，菜单可真正覆盖网页。
        win.contentView.addChildView(deviceMenuView);
        deviceMenuView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        await deviceMenuView.webContents.loadFile(this.deviceMenuUiPath);
        this.trackChildWindow(win);
        this.bindInstance(instance);

        // 必须在加载本地壳之前注册；否则壳很快触发 ready-to-show 后，
        // 等远程页面加载完成再注册会永久错过事件。
        win.once('ready-to-show', () => {
            if (!win.isDestroyed()) win.show();
        });

        const shellUrl = `file:///${this.shellUiPath.replace(/\\/g, '/')}?appId=${encodeURIComponent(manifest.id)}`;
        await win.loadURL(shellUrl);

        // 首次导航前设置真实 WebContentsView 尺寸与请求配置。
        // 不启用任何 Chromium 设备仿真层；部分 Electron + WebContentsView
        // 组合会因此触发原生层崩溃。
        this.updateViewBounds(instance);
        this.configureRequestProfile(instance);
        const userAgent = this.resolveUserAgent(manifest);
        await view.webContents.loadURL(manifest.startUrl, userAgent ? { userAgent } : undefined);
        this.updateViewBounds(instance);

        // 网络极慢或页面持续加载时也应及时显示可信壳。
        if (!win.isDestroyed() && !win.isVisible()) win.show();

        this.broadcastRegistryChanged();
        return this.publicManifest(manifest);
    }

    bindInstance(instance) {
        const { window: win, view } = instance;
        const contents = view.webContents;

        const syncBounds = () => this.updateViewBounds(instance);
        win.on('resize', syncBounds);
        win.on('maximize', syncBounds);
        win.on('unmaximize', syncBounds);

        contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
            if (!isMainFrame || isInPlace) return;
            instance.documentGeneration += 1;
            instance.loading = true;
            instance.webAgentReady = false;
            instance.webAgentInitializationPromise = null;
            instance.documentReadyPromise = new Promise((resolve) => {
                instance.resolveDocumentReady = resolve;
            });
            instance.webAgentAdapter?.invalidateDocument();
            this.sendToShell(instance, 'loom:shell-state', this.buildShellState(instance));
        });

        contents.on('did-start-loading', () => {
            instance.loading = true;
            this.sendToShell(instance, 'loom:shell-state', this.buildShellState(instance));
        });

        contents.on('did-stop-loading', () => {
            instance.loading = false;
            this.sendToShell(instance, 'loom:shell-state', this.buildShellState(instance));
        });

        contents.on('did-finish-load', async () => {
            instance.lastError = null;
            instance.loading = false;
            instance.resolveDocumentReady?.();
            const generation = instance.documentGeneration;

            // 用户注入脚本、Agent 运行时和文本快照互不阻塞。尤其不能让一个
            // 长时间运行的 inject.js 阻止 AI/CDP 侧获得页面能力。
            const results = await Promise.allSettled([
                this.applyInjections(instance),
                this.ensureWebAgentRuntime(instance),
                this.captureRenderedSnapshot(instance),
            ]);
            const agentResult = results[1];
            if (
                agentResult.status === 'rejected'
                && generation === instance.documentGeneration
                && agentResult.reason?.code !== 'LOOM_DOCUMENT_CHANGED'
            ) {
                instance.webAgentReady = false;
                console.warn(`[VCPLoomManager] Failed to initialize Web Agent Runtime for ${instance.appId}: ${agentResult.reason.message}`);
            }
            const snapshotResult = results[2];
            if (
                snapshotResult.status === 'rejected'
                && generation === instance.documentGeneration
            ) {
                console.warn(`[VCPLoomManager] Failed to capture rendered snapshot for ${instance.appId}: ${snapshotResult.reason.message}`);
            }
            this.sendToShell(instance, 'loom:shell-state', this.buildShellState(instance));
        });

        contents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
            if (!isMainFrame || code === -3) return;
            instance.loading = false;
            instance.resolveDocumentReady?.();
            instance.lastError = `${description} (${code})`;
            this.sendToShell(instance, 'loom:shell-state', this.buildShellState(instance));
            console.warn(`[VCPLoomManager] ${instance.appId} failed to load ${validatedUrl}: ${instance.lastError}`);
        });

        contents.on('page-title-updated', (_event, title) => {
            this.sendToShell(instance, 'loom:shell-state', {
                ...this.buildShellState(instance),
                pageTitle: title,
            });
        });

        contents.on('will-navigate', (event, targetUrl) => {
            if (!instance.manifest.navigation.openExternalOriginsInBrowser) return;
            try {
                const sourceOrigin = new URL(contents.getURL()).origin;
                const targetOrigin = new URL(targetUrl).origin;
                if (sourceOrigin !== targetOrigin) {
                    event.preventDefault();
                    void shell.openExternal(targetUrl);
                }
            } catch {
                event.preventDefault();
            }
        });

        contents.setWindowOpenHandler(({ url }) => {
            if (instance.manifest.navigation.allowPopups) {
                void contents.loadURL(url);
            } else {
                void shell.openExternal(url);
            }
            return { action: 'deny' };
        });

        contents.on('render-process-gone', (_event, details) => {
            if (instance.closing) return;
            instance.lastError = `页面进程异常退出：${details.reason}`;
            this.sendToShell(instance, 'loom:shell-state', this.buildShellState(instance));
        });

        win.once('close', () => {
            instance.closing = true;
            instance.devicePermissionCleanup?.();
            instance.devicePermissionCleanup = null;
            void instance.webAgentAdapter?.dispose().catch((error) => {
                console.warn(`[VCPLoomManager] Failed to dispose Web Agent Adapter for ${instance.appId}: ${error.message}`);
            });
            const menuContents = instance.deviceMenuView?.webContents;
            if (menuContents && !menuContents.isDestroyed()) {
                try {
                    win.contentView.removeChildView(instance.deviceMenuView);
                } catch (error) {
                    console.warn(`[VCPLoomManager] Failed to detach device menu for ${instance.appId}: ${error.message}`);
                }
                menuContents.close({ waitForBeforeUnload: false });
            }
            if (!contents.isDestroyed()) {
                // WebContentsView 不会随 BrowserWindow 自动销毁。必须在父窗口的
                // 原生对象释放前先脱离视图树并关闭，否则 closed 阶段操作它会触发
                // “Object has been destroyed”。
                try {
                    win.contentView.removeChildView(view);
                } catch (error) {
                    console.warn(`[VCPLoomManager] Failed to detach view for ${instance.appId}: ${error.message}`);
                }
                contents.close({ waitForBeforeUnload: false });
            }
        });

        win.on('closed', () => {
            this.instances.delete(instance.appId);
            this.untrackChildWindow(win);
            this.broadcastRegistryChanged();
        });
    }

    updateViewBounds(instance) {
        if (!instance || instance.window.isDestroyed()) return;
        const [contentWidth, contentHeight] = instance.window.getContentSize();
        const availableWidth = Math.max(1, contentWidth);
        const availableHeight = Math.max(1, contentHeight - TITLE_BAR_HEIGHT);
        const { viewport } = instance.manifest;

        const width = viewport.autoResize ? availableWidth : Math.min(viewport.width, availableWidth);
        const height = viewport.autoResize ? availableHeight : Math.min(viewport.height, availableHeight);
        const x = Math.max(0, Math.floor((availableWidth - width) / 2));

        // 网页尺寸永远不因设备菜单开关而变化。
        instance.view.setBounds({
            x,
            y: TITLE_BAR_HEIGHT,
            width,
            height,
        });

        const menuView = instance.deviceMenuView;
        if (menuView?.webContents && !menuView.webContents.isDestroyed()) {
            if (instance.deviceMenuOpen) {
                const menuWidth = Math.max(280, Math.min(360, contentWidth - 16));
                menuView.setBounds({
                    x: Math.max(8, contentWidth - menuWidth - 8),
                    y: TITLE_BAR_HEIGHT + 6,
                    width: menuWidth,
                    height: Math.min(212, availableHeight),
                });
            } else {
                menuView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
            }
        }
    }

    async applyInjections(instance) {
        if (!instance || instance.view.webContents.isDestroyed()) return;
        const contents = instance.view.webContents;

        try {
            if (instance.cssKey) {
                contents.removeInsertedCSS(instance.cssKey);
                instance.cssKey = null;
            }

            const [css, js] = await Promise.all([
                fs.readFile(this.injectionPath(instance.appId, 'css'), 'utf8').catch(() => ''),
                fs.readFile(this.injectionPath(instance.appId, 'js'), 'utf8').catch(() => ''),
            ]);

            if (css.trim()) {
                instance.cssKey = await contents.insertCSS(css, { cssOrigin: 'user' });
            }
            if (js.trim()) {
                await contents.executeJavaScript(`(() => {\n${js}\n})()\n//# sourceURL=vcp-loom://${instance.appId}/inject.js`, true);
            }
        } catch (error) {
            instance.lastError = `注入失败：${error.message}`;
            this.sendToShell(instance, 'loom:shell-state', this.buildShellState(instance));
            console.warn(`[VCPLoomManager] Injection failed for ${instance.appId}:`, error);
        }
    }

    buildShellState(instance) {
        const contents = instance.view.webContents;
        return {
            appId: instance.appId,
            name: instance.manifest.name,
            url: contents.isDestroyed() ? '' : contents.getURL(),
            loading: instance.loading,
            canGoBack: !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
            canGoForward: !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
            error: instance.lastError,
        };
    }

    sendToShell(instance, channel, payload) {
        const shellContents = instance?.window?.webContents;
        if (shellContents && !shellContents.isDestroyed()) {
            shellContents.send(channel, payload);
        }
        if (channel === 'loom:device-candidates') {
            const menuContents = instance?.deviceMenuView?.webContents;
            if (menuContents && !menuContents.isDestroyed()) {
                menuContents.send(channel, payload);
            }
        }
    }

    getInstanceBySender(sender) {
        for (const instance of this.instances.values()) {
            if (instance.window.isDestroyed()) continue;
            if (instance.window.webContents.id === sender.id) return instance;
            const menuContents = instance.deviceMenuView?.webContents;
            if (menuContents && !menuContents.isDestroyed() && menuContents.id === sender.id) {
                return instance;
            }
        }
        return null;
    }

    async navigate(instance, action) {
        const contents = instance.view.webContents;
        if (contents.isDestroyed()) return;
        if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
        if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
        if (action === 'reload') contents.reload();
        if (action === 'home') await contents.loadURL(instance.manifest.startUrl);
    }

    normalizeNavigationUrl(value) {
        const input = String(value || '').trim();
        if (!input) throw new Error('请输入网址。');

        const candidate = /^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`;
        let url;
        try {
            url = new URL(candidate);
        } catch {
            throw new Error('网址格式无效。');
        }
        if (!['http:', 'https:'].includes(url.protocol)) {
            throw new Error('仅允许访问 HTTP 或 HTTPS 网址。');
        }
        return url.toString();
    }

    async navigateToUrl(instance, value) {
        const contents = instance.view.webContents;
        if (contents.isDestroyed()) throw new Error('LoomAPP 页面进程不可用。');
        const url = this.normalizeNavigationUrl(value);
        instance.lastError = null;
        const userAgent = this.resolveUserAgent(instance.manifest);
        await contents.loadURL(url, userAgent ? { userAgent } : undefined);
        return this.buildShellState(instance);
    }

    async shareVisibleText(instance) {
        const contents = instance.view.webContents;
        const result = await contents.executeJavaScript(`(() => ({
            title: document.title || '',
            url: location.href,
            text: (document.body && document.body.innerText ? document.body.innerText : '').trim()
        }))()`, true);

        const text = String(result.text || '').slice(0, MAX_SHARE_TEXT);
        const payload = [
            `> 来自 VCP Loom · ${instance.manifest.name}`,
            result.title ? `> 页面：${result.title}` : '',
            result.url ? `> 链接：${result.url}` : '',
            '',
            text,
        ].filter((line, index) => line || index >= 3).join('\n');

        if (!this.mainWindow || this.mainWindow.isDestroyed()) {
            throw new Error('VChat 主窗口当前不可用。');
        }
        if (this.mainWindow.isMinimized()) this.mainWindow.restore();
        if (!this.mainWindow.isVisible()) this.mainWindow.show();
        this.mainWindow.focus();
        this.mainWindow.webContents.send('loom:share-text-to-input', payload);
        return { success: true, length: payload.length };
    }

    toggleDevToolsForWindow(win) {
        if (!win || win.isDestroyed()) return false;
        const instance = Array.from(this.instances.values()).find((candidate) =>
            !candidate.window.isDestroyed() && candidate.window === win
        );
        if (!instance || instance.view.webContents.isDestroyed()) return false;

        const contents = instance.view.webContents;
        if (contents.isDevToolsOpened()) {
            contents.closeDevTools();
        } else {
            // WebContentsView 是位于 BrowserWindow 壳之上的原生视图。若把壳的
            // DevTools 停靠在窗口内，网页视图会覆盖控制台，因此始终独立打开。
            contents.openDevTools({ mode: 'detach', activate: true });
        }
        return true;
    }

    async closeApp(appId) {
        const id = this.assertAppId(appId);
        const instance = this.instances.get(id);
        if (instance && !instance.window.isDestroyed()) {
            instance.window.close();
        }
        return { success: true };
    }

    isRunning(appId) {
        const instance = this.instances.get(appId);
        return Boolean(instance && !instance.window.isDestroyed());
    }

    async clearSession(appId) {
        const id = this.assertAppId(appId);
        await this.closeApp(id);
        const persistentSession = session.fromPartition(this.partitionName(id));
        await Promise.all([
            persistentSession.clearStorageData(),
            persistentSession.clearCache(),
            persistentSession.clearAuthCache(),
        ]);
        await persistentSession.cookies.flushStore();
        await fs.remove(this.devicePermissionsPath(id));
        return { success: true };
    }

    async openManager() {
        if (this.managerWindow && !this.managerWindow.isDestroyed()) {
            if (this.managerWindow.isMinimized()) this.managerWindow.restore();
            if (!this.managerWindow.isVisible()) this.managerWindow.show();
            this.managerWindow.focus();
            return;
        }

        const win = new BrowserWindow({
            width: 1120,
            height: 760,
            minWidth: 860,
            minHeight: 600,
            frame: false,
            title: 'VCP Loom Manager',
            backgroundColor: '#10131a',
            show: false,
            webPreferences: {
                preload: this.preloadPath,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });

        this.managerWindow = win;
        this.trackChildWindow(win);
        await win.loadFile(this.managerUiPath);
        win.once('ready-to-show', () => win.show());
        win.on('closed', () => {
            this.untrackChildWindow(win);
            if (this.managerWindow === win) this.managerWindow = null;
        });
    }

    async exportApp(appId) {
        const sources = await this.readSources(appId);
        const iconPayload = await this.readIconForPackage(sources.manifest);
        const result = await dialog.showSaveDialog(this.managerWindow || undefined, {
            title: '导出 LoomAPP',
            defaultPath: `${sources.manifest.id}.vloom.json`,
            filters: [
                { name: 'VCP Loom Package', extensions: ['vloom.json'] },
                { name: 'JSON', extensions: ['json'] },
            ],
        });
        if (result.canceled || !result.filePath) return { success: false, canceled: true };

        const packageData = {
            format: PACKAGE_FORMAT,
            packageVersion: PACKAGE_VERSION,
            exportedAt: new Date().toISOString(),
            manifest: {
                ...sources.manifest,
                icon: iconPayload ? iconPayload.fileName : sources.manifest.icon,
            },
            files: {
                [INJECT_CSS_FILE]: { encoding: 'utf8', content: sources.css },
                [INJECT_JS_FILE]: { encoding: 'utf8', content: sources.js },
            },
        };
        if (iconPayload) {
            packageData.files[iconPayload.fileName] = {
                encoding: 'base64',
                content: iconPayload.content,
            };
        }

        await fs.writeJson(result.filePath, packageData, { spaces: 2 });
        return { success: true, filePath: result.filePath };
    }

    async readIconForPackage(manifest) {
        if (!manifest.icon || /^(data:|https?:|file:)/i.test(manifest.icon)) return null;
        const filePath = path.resolve(this.appDir(manifest.id), manifest.icon);
        const relative = path.relative(this.appDir(manifest.id), filePath);
        if (relative.startsWith('..') || path.isAbsolute(relative) || !await fs.pathExists(filePath)) return null;
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return null;
        return {
            fileName: path.basename(filePath),
            content: (await fs.readFile(filePath)).toString('base64'),
        };
    }

    async importApp() {
        const result = await dialog.showOpenDialog(this.managerWindow || undefined, {
            title: '导入 LoomAPP',
            properties: ['openFile'],
            filters: [
                { name: 'VCP Loom Package', extensions: ['json'] },
            ],
        });
        if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true };

        const packageData = await fs.readJson(result.filePaths[0]);
        if (packageData.format !== PACKAGE_FORMAT || packageData.packageVersion !== PACKAGE_VERSION) {
            throw new Error('不是受支持的 VCP Loom 分发包。');
        }

        const manifest = normalizeManifest(packageData.manifest);
        if (this.manifests.has(manifest.id) || await fs.pathExists(this.appDir(manifest.id))) {
            throw new Error(`LoomAPP ID "${manifest.id}" 已存在，请先删除或修改分发包 ID。`);
        }

        const files = isPlainObject(packageData.files) ? packageData.files : {};
        const css = safeText(files[INJECT_CSS_FILE]?.content || '');
        const js = safeText(files[INJECT_JS_FILE]?.content || '');
        const targetDir = this.appDir(manifest.id);
        await fs.ensureDir(targetDir);

        try {
            await fs.writeJson(path.join(targetDir, MANIFEST_FILE), manifest, { spaces: 2 });
            await fs.writeFile(path.join(targetDir, INJECT_CSS_FILE), css, 'utf8');
            await fs.writeFile(path.join(targetDir, INJECT_JS_FILE), js, 'utf8');

            if (manifest.icon && files[manifest.icon]?.encoding === 'base64') {
                const iconName = path.basename(manifest.icon);
                if (iconName !== manifest.icon) throw new Error('分发包图标路径无效。');
                const buffer = Buffer.from(String(files[manifest.icon].content || ''), 'base64');
                if (buffer.length > 5 * 1024 * 1024) throw new Error('分发包图标超过 5 MB。');
                await fs.writeFile(path.join(targetDir, iconName), buffer);
            }
        } catch (error) {
            await fs.remove(targetDir);
            throw error;
        }

        this.manifests.set(manifest.id, manifest);
        this.broadcastRegistryChanged();
        return { success: true, app: this.publicManifest(manifest) };
    }

    trackChildWindow(win) {
        if (Array.isArray(this.openChildWindows) && !this.openChildWindows.includes(win)) {
            this.openChildWindows.push(win);
        }
    }

    untrackChildWindow(win) {
        if (!Array.isArray(this.openChildWindows)) return;
        const index = this.openChildWindows.indexOf(win);
        if (index >= 0) this.openChildWindows.splice(index, 1);
    }

    broadcastRegistryChanged() {
        const apps = this.listApps();
        const targets = [this.managerWindow, ...BrowserWindow.getAllWindows()];
        const sent = new Set();
        for (const win of targets) {
            if (!win || win.isDestroyed() || sent.has(win.webContents.id)) continue;
            sent.add(win.webContents.id);
            win.webContents.send('loom:registry-changed', apps);
        }
    }

    async shutdown() {
        for (const instance of Array.from(this.instances.values())) {
            if (!instance.window.isDestroyed()) instance.window.destroy();
        }
        this.instances.clear();
        if (this.managerWindow && !this.managerWindow.isDestroyed()) {
            this.managerWindow.destroy();
        }
        this.managerWindow = null;
    }

    registerIpc() {
        if (this.ipcRegistered) return;

        const handle = (channel, handler) => {
            ipcMain.removeHandler(channel);
            ipcMain.handle(channel, async (event, ...args) => {
                try {
                    return { success: true, data: await handler(event, ...args) };
                } catch (error) {
                    console.error(`[VCPLoomManager] ${channel} failed:`, error);
                    return { success: false, error: error.message };
                }
            });
        };

        handle('loom:list-apps', () => this.listApps());
        handle('loom:list-open-apps', () => this.listOpenApps());
        handle('loom:get-app', (_event, appId) => this.readSources(appId));
        handle('loom:get-runtime-source', (_event, appId) => this.readRuntimeSource(appId));
        handle('loom:get-rendered-text', (_event, appId, options) => this.readRenderedText(appId, options));
        handle('loom:get-web-agent-page-info', (_event, appId) => this.getWebAgentPageInfo(appId));
        handle('loom:execute-web-agent-action', (_event, appId, actionId, params, options) =>
            this.executeWebAgentAction(appId, actionId, params, options));
        handle('loom:create-app', (_event, payload) => this.createApp(payload));
        handle('loom:save-app', (_event, payload) => this.saveApp(payload));
        handle('loom:edit-app-sources', (_event, appId, payload) => this.editAppSources(appId, payload));
        handle('loom:delete-app', (_event, appId) => this.deleteApp(appId));
        handle('loom:set-enabled', (_event, appId, enabled) => this.setEnabled(appId, enabled));
        handle('loom:open-app', (_event, appId) => this.openApp(appId));
        handle('loom:close-app', (_event, appId) => this.closeApp(appId));
        handle('loom:clear-session', (_event, appId) => this.clearSession(appId));
        handle('loom:reload-registry', () => this.reloadRegistry());
        handle('loom:open-manager', () => this.openManager());
        handle('loom:export-app', (_event, appId) => this.exportApp(appId));
        handle('loom:import-app', () => this.importApp());
        handle('loom:open-app-folder', async (_event, appId) => {
            const error = await shell.openPath(this.appDir(appId));
            if (error) throw new Error(error);
            return { success: true };
        });

        handle('loom:shell-ready', (event) => {
            const instance = this.getInstanceBySender(event.sender);
            if (!instance) throw new Error('无法识别 Loom 壳窗口。');
            return this.buildShellState(instance);
        });
        handle('loom:shell-action', async (event, action, payload) => {
            const instance = this.getInstanceBySender(event.sender);
            if (!instance) throw new Error('无法识别 Loom 壳窗口。');
            if (['back', 'forward', 'reload', 'home'].includes(action)) {
                await this.navigate(instance, action);
            } else if (action === 'navigate') {
                return this.navigateToUrl(instance, payload);
            } else if (action === 'share-text') {
                return this.shareVisibleText(instance);
            } else if (action === 'device-menu') {
                instance.deviceMenuOpen = payload === true;
                this.updateViewBounds(instance);
                return {
                    appId: instance.appId,
                    deviceMenuOpen: instance.deviceMenuOpen,
                };
            } else if (action === 'device-request') {
                return this.requestDeviceFromShell(instance, payload);
            } else if (action === 'device-select') {
                return this.selectDeviceFromShell(instance, payload);
            } else if (action === 'open-external') {
                await shell.openExternal(instance.view.webContents.getURL());
            } else {
                throw new Error(`不支持的壳操作：${action}`);
            }
            return this.buildShellState(instance);
        });

        this.ipcRegistered = true;
    }
}

let singleton = null;

async function initialize(options = {}) {
    if (!singleton) singleton = new VCPLoomManager(options);
    await singleton.initialize();
    return singleton;
}

function getManager() {
    return singleton;
}

module.exports = {
    VCPLoomManager,
    initialize,
    getManager,
    DEFAULT_MANIFEST,
    USER_AGENTS,
    LOOM_PAGE_ACTIONS,
    LOOM_ACTIONS,
};