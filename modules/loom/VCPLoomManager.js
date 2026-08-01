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

const MANIFEST_FILE = 'loom.json';
const INJECT_CSS_FILE = 'inject.css';
const INJECT_JS_FILE = 'inject.js';
const PACKAGE_FORMAT = 'vcp-loom-package';
const PACKAGE_VERSION = 1;
const TITLE_BAR_HEIGHT = 44;
const SAFE_APP_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const MAX_INJECT_BYTES = 2 * 1024 * 1024;
const MAX_SHARE_TEXT = 100000;
const MAX_RUNTIME_SOURCE = 4 * 1024 * 1024;
const MAX_RENDERED_TEXT = 500000;

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
        this.preloadPath = path.join(this.projectRoot, 'preloads', 'loom.js');
        this.pagePreloadPath = path.join(this.projectRoot, 'preloads', 'loom-page.js');
        this.mainWindow = options.mainWindow || null;
        this.openChildWindows = options.openChildWindows || [];
        this.managerWindow = null;
        this.instances = new Map();
        this.manifests = new Map();
        this.requestConfiguredPartitions = new Set();
        this.ipcRegistered = false;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return this;
        await fs.ensureDir(this.appsRoot);
        await this.reloadRegistry();
        this.registerIpc();
        this.initialized = true;
        console.log(`[VCPLoomManager] Initialized with ${this.manifests.size} app(s).`);
        return this;
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

        const instance = {
            appId: manifest.id,
            manifest,
            window: win,
            view,
            cssKey: null,
            loading: true,
            lastError: null,
            lastSuccessfulRender: null,
        };

        this.instances.set(manifest.id, instance);
        win.contentView.addChildView(view);
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
            await this.applyInjections(instance);
            try {
                await this.captureRenderedSnapshot(instance);
            } catch (error) {
                console.warn(`[VCPLoomManager] Failed to capture rendered snapshot for ${instance.appId}: ${error.message}`);
            }
            this.sendToShell(instance, 'loom:shell-state', this.buildShellState(instance));
        });

        contents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
            if (!isMainFrame || code === -3) return;
            instance.loading = false;
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

        instance.view.setBounds({
            x,
            y: TITLE_BAR_HEIGHT,
            width,
            height,
        });
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
    }

    getInstanceBySender(sender) {
        for (const instance of this.instances.values()) {
            if (!instance.window.isDestroyed() && instance.window.webContents.id === sender.id) {
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
};