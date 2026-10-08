'use strict';

// Official LoomApp hosted by the side pane. Only registered guests owned by the
// trusted main renderer are eligible; never resolve arbitrary webContents IDs.
const crypto = require('node:crypto');
const core = require('./webcore');
const { createElectronWebAgentAdapter } = require('./webcore/electron-adapter');

const APP_ID = 'vcpchat-browser';
const MAX_TABS = 12;
const MANIFEST = Object.freeze({
    id: APP_ID, name: 'VCPChat 协作浏览器', description: '用户与 Agent 共享的侧栏浏览器',
    startUrl: 'https://www.bing.com/', enabled: true, builtin: true,
    exposeInAppDrawer: false, exposeManagerInAppDrawer: false, icon: '', emoji: '🌐',
});

function fail(code, message) {
    return new core.protocol.WebAgentError(code, message);
}

function webUrl(value) {
    let url;
    try { url = new URL(String(value || '')); } catch { throw fail('INVALID_REQUEST', '请输入完整 HTTP/HTTPS 网址。'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw fail('INVALID_REQUEST', '协作浏览器仅允许 HTTP/HTTPS 网址。');
    return url.href;
}

class SideBrowserService {
    constructor({ manager, getMainWindow, timeoutMs = 30000 }) {
        this.manager = manager;
        this.getMainWindow = getMainWindow;
        this.timeoutMs = timeoutMs;
        this.targets = new Map();
        this.pending = new Map();
        this.activeId = null;
    }

    host() {
        const win = this.getMainWindow();
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) throw fail('NO_ACTIVE_TARGET', 'VCPChat 主窗口不可用。');
        return win;
    }

    async request(action, params = {}) {
        const win = this.host();
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        const sender = win.webContents;
        const requestId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const finish = (error, data) => {
                clearTimeout(timer);
                sender.removeListener('destroyed', gone);
                sender.removeListener('did-start-navigation', navigated);
                this.pending.delete(requestId);
                if (error) reject(error); else resolve(data);
            };
            const gone = () => finish(fail('NO_ACTIVE_TARGET', '主窗口已关闭。'));
            const navigated = (_event, _url, inPlace, mainFrame) => {
                if (mainFrame && !inPlace) gone();
            };
            const timer = setTimeout(() => finish(fail('BROWSER_HOST_TIMEOUT', '侧栏浏览器请求超时；有副作用操作不会自动重试。')), this.timeoutMs);
            this.pending.set(requestId, { sender, finish });
            sender.once('destroyed', gone);
            sender.on('did-start-navigation', navigated);
            try { sender.send('browser:agent-request', { requestId, action, params }); }
            catch (error) { finish(error); }
        });
    }

    respond(sender, payload = {}) {
        const pending = this.pending.get(payload.requestId);
        if (!pending || pending.sender !== sender) return false;
        pending.finish(payload.success === true ? null : fail('BROWSER_HOST_ERROR', String(payload.error || '侧栏操作失败。')), payload.data);
        return true;
    }

    register(sender, tabId, guest) {
        if (!/^browser:[a-zA-Z0-9_-]+$/.test(tabId)) throw fail('INVALID_REQUEST', '浏览器标签标识无效。');
        const previous = this.targets.get(tabId);
        if (previous?.view.webContents === guest) return this.describe(previous);
        if (!previous && this.targets.size >= MAX_TABS) throw fail('BROWSER_TAB_LIMIT', '协作浏览器标签数量已达上限。');
        if (previous) this.unregister(sender, tabId, previous.view.webContents.id);
        const instance = {
            appId: APP_ID, tabId, manifest: MANIFEST, window: this.host(), sender,
            view: { webContents: guest }, loading: guest.isLoadingMainFrame?.() || false,
            documentGeneration: 1, webAgentReady: false, webAgentInitializationPromise: null,
            lastError: null, lastSuccessfulRender: null, assistance: null, busy: 0,
            documentReadyPromise: Promise.resolve(), resolveDocumentReady: null, listeners: [],
        };
        const adapter = createElectronWebAgentAdapter(guest, {
            appId: APP_ID,
            executePageOperation: (action, params, request) => this.manager.executeIsolatedPageOperation(instance, action, params, request),
        });
        // Keep the mature per-page Electron bridge; only replace target management
        // with the side-pane host, not shared mutable "current webContents" state.
        adapter.listTargets = async () => ({ code: 'TARGETS_RETURNED', result: { tabs: this.list(), targets: this.list(), count: this.targets.size } });
        adapter.getActiveTarget = async () => this.describe(this.resolve());
        adapter.activateTarget = async target => this.activate(target);
        adapter.createTarget = async options => this.open(options);
        adapter.closeTarget = async target => this.close(target);
        if (instance.loading) instance.documentReadyPromise = new Promise(resolve => { instance.resolveDocumentReady = resolve; });
        instance.webAgentAdapter = adapter;
        instance.webAgentRuntime = core.createRuntime(adapter);
        const listen = (event, fn) => {
            guest.on(event, fn);
            instance.listeners.push(() => guest.removeListener(event, fn));
        };
        listen('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
            if (!mainFrame || inPlace) return;
            instance.documentGeneration++;
            instance.loading = true;
            instance.webAgentReady = false;
            instance.webAgentInitializationPromise = null;
            instance.lastSuccessfulRender = null;
            instance.resolveDocumentReady?.();
            instance.documentReadyPromise = new Promise(resolve => { instance.resolveDocumentReady = resolve; });
            adapter.invalidateDocument();
        });
        const ready = () => {
            instance.loading = false;
            instance.resolveDocumentReady?.();
            instance.resolveDocumentReady = null;
        };
        listen('dom-ready', ready);
        listen('did-finish-load', () => { instance.lastError = null; ready(); });
        listen('did-fail-load', (_event, code, description, _url, mainFrame) => {
            if (mainFrame === false || code === -3) return;
            instance.lastError = `${description} (${code})`;
            ready();
        });
        listen('render-process-gone', () => {
            instance.webAgentReady = false;
            instance.lastError = '页面进程已退出，请在侧栏重试。';
            ready();
        });
        listen('destroyed', () => this.unregister(sender, tabId, guest.id));
        this.targets.set(tabId, instance);
        return this.describe(instance);
    }

    unregister(sender, tabId, guestId) {
        const instance = this.targets.get(tabId);
        if (!instance || instance.sender !== sender || instance.view.webContents.id !== guestId) return false;
        this.targets.delete(tabId);
        instance.resolveDocumentReady?.();
        instance.listeners.splice(0).forEach(off => off());
        void instance.webAgentAdapter.dispose().catch(() => {});
        if (this.activeId === tabId) this.activeId = null;
        return true;
    }

    describe(instance) {
        const wc = instance.view.webContents;
        return {
            id: instance.tabId, targetId: instance.tabId, webContentsId: wc.id, appId: APP_ID,
            title: wc.isDestroyed() ? '' : wc.getTitle(), url: wc.isDestroyed() ? '' : wc.getURL(),
            active: this.activeId === instance.tabId, loading: instance.loading,
            error: instance.lastError, assistance: instance.assistance,
        };
    }

    list() {
        return [...this.targets.values()].filter(i => !i.view.webContents.isDestroyed()).map(i => this.describe(i));
    }

    resolve(targetId) {
        const id = targetId === undefined || targetId === null || targetId === '' ? this.activeId : String(targetId);
        const instance = this.targets.get(id);
        if (!instance || instance.view.webContents.isDestroyed()) throw fail('TARGET_NOT_FOUND', '浏览器目标不存在或未激活；请先打开或切换标签，并使用回执中的 targetId。');
        return instance;
    }

    async open(options = {}) {
        const url = webUrl(options.url || MANIFEST.startUrl);
        if (this.targets.size >= MAX_TABS) throw fail('BROWSER_TAB_LIMIT', '浏览器标签数量已达上限。');
        const result = await this.request('open', { url });
        const instance = this.resolve(result?.targetId);
        this.activeId = instance.tabId;
        await this.manager.ensureWebAgentRuntime(instance);
        if (instance.lastError) throw fail('BROWSER_LOAD_FAILED', instance.lastError);
        return { ...this.describe(instance), ready: true };
    }

    async activate(targetId) {
        const instance = this.resolve(targetId);
        await this.request('activate', { targetId: instance.tabId });
        this.activeId = instance.tabId;
        return { code: 'TARGET_ACTIVATED', result: this.describe(instance) };
    }

    async close(targetId) {
        const instance = this.resolve(targetId);
        await this.request('close', { targetId: instance.tabId });
        return { code: 'TARGET_CLOSED', result: { targetId: instance.tabId, closed: !this.targets.has(instance.tabId) } };
    }

    async pageInfo(targetId) {
        const instance = this.resolve(targetId);
        await this.manager.ensureWebAgentRuntime(instance);
        const result = await instance.view.webContents.executeJavaScriptInIsolatedWorld(999, [{
            code: 'globalThis.__vcpLoomWebAgentRuntime.snapshot()',
        }], true);
        return { ...result, appId: APP_ID, targetId: instance.tabId, tabs: this.list(), assistance: instance.assistance };
    }

    async execute(actionId, params = {}, options = {}) {
        const action = this.manager.normalizeLoomActionId(actionId);
        let result;
        if (action === 'target_list') result = { tabs: this.list(), targets: this.list(), count: this.targets.size };
        else if (action === 'target_open') result = await this.open(params);
        else if (action === 'target_get_active') result = this.describe(this.resolve());
        else if (action === 'target_activate') result = await this.activate(params.targetId || params.target);
        else if (action === 'target_close') result = await this.close(params.targetId || params.target);
        else {
            const instance = this.resolve(params.targetId ?? params.targetContext?.targetId);
            const definition = core.protocol.resolveCommand(action).definition;
            if (instance.assistance && instance.assistance.status !== 'completed' && definition.sideEffecting) {
                throw fail('USER_ASSISTANCE_PENDING', '用户正在接管此页面；完成接管前 Agent 写操作已暂停。');
            }
            if (action === 'target_navigate') webUrl(params.url);
            instance.busy++;
            try {
                const response = await instance.webAgentRuntime.execute({
                    command: action, params, options,
                    targetContext: { ...params.targetContext, appId: APP_ID,
                        targetId: instance.view.webContents.id,
                        runtimeInstanceId: params.runtimeInstanceId,
                        documentGeneration: params.documentGeneration, snapshotId: params.snapshotId },
                });
                if (response.status === 'error') throw fail(response.code, response.error || response.message);
                return { appId: APP_ID, targetId: instance.tabId, actionId: action,
                    executedAt: new Date().toISOString(), response };
            } finally { instance.busy--; }
        }
        return { appId: APP_ID, actionId: action, executedAt: new Date().toISOString(),
            response: { status: 'success', code: 'COMMAND_COMPLETED', result: { result } } };
    }

    async requestAssistance(targetId, message) {
        const instance = this.resolve(targetId);
        const assistance = { requestId: crypto.randomUUID(), status: 'waiting',
            message: String(message || '请接管此页面，完成验证或登录后点击“已完成”。').slice(0, 2000) };
        if (instance.busy) throw fail('BROWSER_BUSY', '页面操作尚未结束，请等待后再请求用户接管。');
        instance.assistance = assistance;
        try { await this.request('assist', { targetId: instance.tabId, assistance }); }
        catch (error) { if (instance.assistance === assistance) instance.assistance = null; throw error; }
        return { ...this.describe(instance), instruction: '请向用户说明需要协助的原因，暂停页面写操作；用户确认完成后重新读取页面快照，不重放之前的提交。' };
    }

    completeAssistance(sender, targetId, requestId, cancelled = false) {
        const instance = this.resolve(targetId);
        if (instance.sender !== sender || instance.assistance?.requestId !== requestId) throw fail('INVALID_REQUEST', '接管请求已失效。');
        instance.assistance = { ...instance.assistance, status: cancelled ? 'cancelled' : 'completed' };
        return this.describe(instance);
    }
}

module.exports = { SideBrowserService, APP_ID, MANIFEST, MAX_TABS, webUrl };