'use strict';

const { WebContentsView, app, shell, screen } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { PRELOAD_ROLES, resolveAppPreload } = require('./preloadPaths');
const windowService = require('./windowService');
const embeddedAppAllowlist = require('../shared/embeddedAppAllowlist');
const MAX_EMBEDDED_SESSIONS = 6;
const MAX_DETACH_COORDINATE = 1_000_000;

function toFileUrl(appRoot, relativePath, query = {}) {
    const url = pathToFileURL(path.join(appRoot, relativePath));
    Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, String(value));
        }
    });
    url.searchParams.set('vcpEmbedded', '1');
    return url.toString();
}

async function resolveDescriptor(appAction, appRoot) {
    // Embedded business pages stay on their upstream Classic presentation in
    // this PR. The parent may use the Next shell, but it must not implicitly
    // opt child documents into an unshipped presentation.
    const uiMode = 'classic';
    const entry = embeddedAppAllowlist.get(appAction);
    return entry ? { url: toFileUrl(appRoot, entry.page, { uiMode }) } : null;
}

function normalizeBounds(bounds, parentBounds) {
    const parentWidth = Math.max(1, Number(parentBounds?.width) || 1);
    const parentHeight = Math.max(1, Number(parentBounds?.height) || 1);
    const x = Math.max(0, Math.min(parentWidth - 1, Math.round(Number(bounds?.x) || 0)));
    const y = Math.max(0, Math.min(parentHeight - 1, Math.round(Number(bounds?.y) || 0)));
    const width = Math.max(1, Math.min(parentWidth - x, Math.round(Number(bounds?.width) || 1)));
    const height = Math.max(1, Math.min(parentHeight - y, Math.round(Number(bounds?.height) || 1)));
    return { x, y, width, height };
}

function cancelledResult() {
    return { success: false, embeddable: true, cancelled: true, error: '操作已取消。' };
}

function normalizeEmbeddedAction(appAction, { optional = false } = {}) {
    if (optional && (appAction === null || appAction === undefined || appAction === '')) return null;
    if (typeof appAction !== 'string' || !embeddedAppAllowlist.get(appAction)) {
        throw new TypeError('内嵌应用操作无效。');
    }
    return appAction;
}

function normalizeDetachPoint(point) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)
        || Math.abs(x) > MAX_DETACH_COORDINATE || Math.abs(y) > MAX_DETACH_COORDINATE) {
        return null;
    }
    return { x: Math.round(x), y: Math.round(y) };
}

function createEmbeddedAppSessionManager({ mainWindow, launchStandalone, powerMonitor = null }) {
    const sessions = new Map();
    const closingSessions = new Map();
    const appRoot = app.getAppPath();
    let activeAction = null;

    function assertMainRenderer(event) {
        if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
            throw new Error('Embedded application sessions can only be controlled by the main renderer.');
        }
    }

    function notify(action, state, detail = {}) {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const contents = mainWindow.webContents;
        if (!contents || contents.isDestroyed() || contents.isCrashed?.()) return;
        try {
            contents.send('embedded-vchat-app-state', { action, state, ...detail });
        } catch (error) {
            // A renderer can disappear between the liveness check and send().
            // Main retains the authoritative session; the replacement
            // renderer reconciles it through list() after recovery.
            console.warn(`[EmbeddedApps] Deferred ${state} notification for ${action}:`, error.message);
        }
    }

    function hideAll() {
        sessions.forEach(session => session.view.setVisible(false));
    }

    function list() {
        return {
            sessions: [...sessions.values()]
                .filter(session => !session.view.webContents.isDestroyed())
                .map(session => ({ action: session.action })),
            activeAction,
        };
    }

    function suspend() {
        // A renderer reload/crash destroys the DOM host before it can release
        // the native child view. Hide native surfaces immediately, but retain
        // ownership so the replacement renderer can reconcile and reuse them.
        hideAll();
        return { success: true };
    }

    function resume() {
        if (!activeAction) return { success: true, restored: false };
        const result = activate(activeAction);
        if (result.success) notify(activeAction, 'resumed');
        return { ...result, restored: result.success };
    }

    async function create(appAction, options = {}) {
        try { appAction = normalizeEmbeddedAction(appAction); }
        catch (error) { return { success: false, embeddable: false, error: error.message }; }
        const signal = options.signal || null;
        if (signal?.aborted) return cancelledResult();
        if (!embeddedAppAllowlist.isEmbeddable(appAction)) {
            return { success: false, embeddable: false, error: '此应用需要在独立窗口中运行。' };
        }
        const pendingClose = closingSessions.get(appAction);
        if (pendingClose) await pendingClose;
        if (signal?.aborted) return cancelledResult();
        const current = sessions.get(appAction);
        if (current && !current.view.webContents.isDestroyed()) {
            return { success: true, embeddable: true, action: appAction, reused: true };
        }
        if (sessions.size >= MAX_EMBEDDED_SESSIONS) {
            return { success: false, embeddable: true, error: `最多同时打开 ${MAX_EMBEDDED_SESSIONS} 个内嵌应用。` };
        }

        const descriptor = await resolveDescriptor(appAction, appRoot);
        if (signal?.aborted) return cancelledResult();
        if (!descriptor) return { success: false, embeddable: false, error: '没有可用的内嵌应用描述。' };

        const view = new WebContentsView({
            webPreferences: {
                preload: resolveAppPreload(appRoot, PRELOAD_ROLES.UTILITY),
                contextIsolation: true,
                nodeIntegration: false,
                devTools: true,
            },
        });
        // Integrated pages paint only their own main surface. Keeping the
        // native child view transparent lets the parent navigation material
        // continue behind the embedded sidebar without color approximation.
        view.setBackgroundColor?.('#00000000');
        const session = { action: appAction, view, bounds: { x: 0, y: 44, width: 1, height: 1 } };
        sessions.set(appAction, session);
        mainWindow.contentView.addChildView(view);
        view.setVisible(false);
        view.setBounds(session.bounds);
        view.webContents.setWindowOpenHandler(({ url }) => {
            if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
            return { action: 'deny' };
        });
        view.webContents.on('render-process-gone', (_event, details) => {
            notify(appAction, 'error', { error: `应用进程已退出：${details.reason}` });
        });
        view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
            if (isMainFrame !== false && errorCode !== -3) {
                notify(appAction, 'error', { error: errorDescription, url: validatedURL });
            }
        });
        view.webContents.once('destroyed', () => {
            const active = sessions.get(appAction);
            if (active?.view === view) sessions.delete(appAction);
            if (activeAction === appAction) activeAction = null;
        });

        const abortLoad = () => {
            try { view.webContents.stop(); } catch (_error) { /* already destroyed */ }
            void close(appAction);
        };
        signal?.addEventListener('abort', abortLoad, { once: true });

        try {
            await view.webContents.loadURL(descriptor.url);
            if (signal?.aborted || sessions.get(appAction)?.view !== view) {
                await close(appAction);
                return cancelledResult();
            }
            notify(appAction, 'ready');
            return { success: true, embeddable: true, action: appAction };
        } catch (error) {
            await close(appAction);
            if (signal?.aborted) return cancelledResult();
            return { success: false, embeddable: true, error: error.message };
        } finally {
            signal?.removeEventListener('abort', abortLoad);
        }
    }

    function activate(appAction) {
        try { appAction = normalizeEmbeddedAction(appAction, { optional: true }); }
        catch (error) { return { success: false, error: error.message }; }
        hideAll();
        activeAction = null;
        if (!appAction) return { success: true };
        const session = sessions.get(appAction);
        if (!session || session.view.webContents.isDestroyed()) {
            return { success: false, error: '内嵌应用会话不存在。' };
        }
        session.view.setBounds(normalizeBounds(session.bounds, mainWindow.getContentBounds()));
        session.view.setVisible(true);
        activeAction = appAction;
        return { success: true };
    }

    function setBounds(appAction, bounds) {
        try { appAction = normalizeEmbeddedAction(appAction); }
        catch (error) { return { success: false, error: error.message }; }
        const session = sessions.get(appAction);
        if (!session || session.view.webContents.isDestroyed()) {
            return { success: false, error: '内嵌应用会话不存在。' };
        }
        session.bounds = normalizeBounds(bounds, mainWindow.getContentBounds());
        session.view.setBounds(session.bounds);
        return { success: true };
    }

    function close(appAction) {
        try { appAction = normalizeEmbeddedAction(appAction); }
        catch (error) { return Promise.resolve({ success: false, error: error.message }); }
        const pendingClose = closingSessions.get(appAction);
        if (pendingClose) return pendingClose;
        const session = sessions.get(appAction);
        if (!session) return Promise.resolve({ success: true });
        sessions.delete(appAction);
        if (activeAction === appAction) activeAction = null;
        try { mainWindow.contentView.removeChildView(session.view); } catch (_error) { /* already detached */ }
        const closing = new Promise(resolve => {
            const contents = session.view.webContents;
            if (contents.isDestroyed()) {
                resolve();
                return;
            }
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve();
            };
            const timeout = setTimeout(() => {
                console.warn(`[EmbeddedApps] Timed out waiting for ${appAction} webContents destruction.`);
                finish();
            }, 5000);
            contents.once('destroyed', finish);
            contents.close({ waitForBeforeUnload: false });
        }).then(() => {
            notify(appAction, 'closed');
            return { success: true };
        }).finally(() => {
            if (closingSessions.get(appAction) === closing) closingSessions.delete(appAction);
        });
        closingSessions.set(appAction, closing);
        return closing;
    }

    function closeBySender(sender) {
        const session = [...sessions.values()].find(candidate => candidate.view.webContents === sender);
        if (!session) return { success: false, error: '未找到调用方对应的内嵌应用会话。' };
        return close(session.action);
    }

    async function detach(appAction, point = {}, options = {}) {
        try { appAction = normalizeEmbeddedAction(appAction); }
        catch (error) { return { success: false, error: error.message }; }
        const normalizedPoint = normalizeDetachPoint(point);
        if (!normalizedPoint) return { success: false, error: '标签拖出坐标无效。' };
        if (options.signal?.aborted) return { success: false, cancelled: true, error: '操作已取消。' };
        if (!sessions.has(appAction)) return { success: false, error: '内嵌应用会话不存在。' };
        // Closing the embedded view is the detach commit point. Once it has
        // started we always finish launching the standalone window so a late
        // cancellation cannot make the user's application disappear.
        await close(appAction);
        const result = await launchStandalone(appAction);
        if (!result?.success) return result || { success: false, error: '独立窗口启动失败。' };
        if (result.appId) {
            const standaloneWindow = windowService.getWindow(result.appId);
            if (standaloneWindow && !standaloneWindow.isDestroyed()) {
                const windowBounds = standaloneWindow.getBounds();
                const display = screen.getDisplayNearestPoint(normalizedPoint);
                const area = display.workArea;
                const x = Math.min(area.x + area.width - windowBounds.width, Math.max(area.x, normalizedPoint.x - 80));
                const y = Math.min(area.y + area.height - windowBounds.height, Math.max(area.y, normalizedPoint.y - 18));
                standaloneWindow.setPosition(x, y, false);
            }
        }
        return { ...result, detached: true };
    }

    async function closeAll() {
        await Promise.all([...sessions.keys()].map(close));
        await Promise.all([...closingSessions.values()]);
    }

    const handleSystemSuspend = () => suspend();
    const handleSystemResume = () => resume();
    powerMonitor?.on?.('suspend', handleSystemSuspend);
    powerMonitor?.on?.('resume', handleSystemResume);

    mainWindow.on('closed', () => {
        powerMonitor?.off?.('suspend', handleSystemSuspend);
        powerMonitor?.off?.('resume', handleSystemResume);
        void closeAll();
    });

    return {
        isEmbeddable: appAction => embeddedAppAllowlist.isEmbeddable(appAction),
        list,
        suspend,
        resume,
        create,
        activate,
        setBounds,
        close,
        closeBySender,
        detach,
        closeAll,
        assertMainRenderer,
    };
}

module.exports = {
    EMBEDDED_APP_ACTIONS: new Set(embeddedAppAllowlist.entries.map(entry => entry.action)),
    MAX_EMBEDDED_SESSIONS,
    MAX_DETACH_COORDINATE,
    normalizeEmbeddedAction,
    normalizeDetachPoint,
    createEmbeddedAppSessionManager,
};
