'use strict';

const protocol = require('./web-agent-protocol');
const contract = require('./adapter-contract');

const VERSION = '0.1.0';
const CAPABILITIES = Object.freeze([
    'page',
    'script',
    'debugger',
    'runtime',
    'dom',
    'accessibility',
    'nativeInput',
    'network',
    'storage',
    'emulation',
    'screenshot',
    'targets',
]);

class ElectronWebAgentAdapter extends contract.WebAgentAdapter {
    constructor(webContents, options = {}) {
        super({
            id: 'electron-loom',
            version: VERSION,
            backend: 'electron-webcontents',
        });
        if (!webContents) throw new Error('Electron Adapter 缺少 webContents');
        this.webContents = webContents;
        this.appId = String(options.appId || '');
        this.worldId = Number(options.worldId) || 999;
        this.executePageOperationHandler = options.executePageOperation;
        this.runtimeInstanceId = options.runtimeInstanceId
            || `loom-electron-${this.appId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        this.documentGeneration = Math.max(1, Number(options.documentGeneration) || 1);
        this.snapshotId = null;
        this.networkLogs = new Map();
        this.debuggerListeners = new Set();
        this.bound = false;
        this.bindDebuggerEvents();
    }

    assertAvailable() {
        if (this.webContents.isDestroyed()) {
            throw new protocol.WebAgentError(
                protocol.ErrorCode.NO_ACTIVE_TARGET,
                `LoomAPP "${this.appId}" 页面进程不可用`
            );
        }
    }

    async getCapabilities() {
        return CAPABILITIES.slice();
    }

    async getTargetIdentity() {
        this.assertAvailable();
        return {
            adapter: this.id,
            targetId: this.webContents.id,
            appId: this.appId,
            runtimeInstanceId: this.runtimeInstanceId,
        };
    }

    async getDocumentState() {
        return {
            documentGeneration: this.documentGeneration,
            snapshotId: this.snapshotId,
        };
    }

    updateDocumentState(state = {}) {
        if (state.runtimeInstanceId) this.runtimeInstanceId = state.runtimeInstanceId;
        if (Number.isFinite(Number(state.documentGeneration))) {
            this.documentGeneration = Number(state.documentGeneration);
        }
        if (state.snapshotId !== undefined) this.snapshotId = state.snapshotId;
    }

    invalidateDocument() {
        this.documentGeneration += 1;
        this.snapshotId = null;
    }

    async executePageOperation(operation, payload = {}, request = {}) {
        if (operation === 'network_query') {
            const logs = Array.from(this.networkLogs.values()).filter((log) =>
                !payload.urlIncludes || log.request?.url?.includes(String(payload.urlIncludes))
            );
            return {
                message: 'Loom 网络日志查询成功',
                code: 'NETWORK_LOGS_RETURNED',
                result: logs,
                backendUsed: 'electron-debugger',
            };
        }
        if (operation === 'network_clear') {
            this.networkLogs.clear();
            return {
                message: 'Loom 网络日志已清空',
                code: 'NETWORK_LOGS_CLEARED',
                result: { cleared: true },
                backendUsed: 'electron-debugger',
            };
        }
        if (operation.startsWith('storage_')) {
            return this.executeStorageOperation(operation, payload);
        }
        if (typeof this.executePageOperationHandler !== 'function') {
            throw this.notSupported('executePageOperation');
        }
        const response = await this.executePageOperationHandler(operation, payload, request);
        if (response?.status === protocol.Status.ERROR || response?.status === 'error') {
            throw new protocol.WebAgentError(
                response.code || protocol.ErrorCode.ADAPTER_EXECUTION_ERROR,
                response.error || response.message || `页面动作 ${operation} 执行失败`,
                response.details || response.result || {}
            );
        }
        const identity = response?.result?.runtimeInstanceId
            ? {
                runtimeInstanceId: response.result.runtimeInstanceId,
                documentGeneration: response.result.documentGeneration,
                snapshotId: response.result.snapshotId
                    ?? response.result.snapshotIdBefore,
            }
            : null;
        if (identity) this.updateDocumentState(identity);
        if (operation === 'page_get_image') {
            return this.captureResolvedPageImage(response, payload);
        }
        return {
            ...response,
            backendUsed: response?.backendUsed || 'electron-isolated-world',
        };
    }

    async captureResolvedPageImage(response, options = {}) {
        const resolved = response?.result || {};
        const rect = resolved.viewportRect || {};
        const rawX = Math.round(Number(rect.x));
        const rawY = Math.round(Number(rect.y));
        const rawWidth = Math.round(Number(rect.width));
        const rawHeight = Math.round(Number(rect.height));
        if (
            !Number.isFinite(rawX) ||
            !Number.isFinite(rawY) ||
            !Number.isFinite(rawWidth) ||
            !Number.isFinite(rawHeight) ||
            rawWidth <= 0 ||
            rawHeight <= 0
        ) {
            throw new protocol.WebAgentError(
                protocol.ErrorCode.ADAPTER_EXECUTION_ERROR,
                '页面图片没有可截取的有效视口区域',
                { viewportRect: rect }
            );
        }

        const [viewportWidth, viewportHeight] = this.webContents.getSize();
        const x = Math.max(0, rawX);
        const y = Math.max(0, rawY);
        const right = Math.min(viewportWidth, rawX + rawWidth);
        const bottom = Math.min(viewportHeight, rawY + rawHeight);
        const width = Math.round(right - x);
        const height = Math.round(bottom - y);
        if (width <= 0 || height <= 0) {
            throw new protocol.WebAgentError(
                protocol.ErrorCode.ADAPTER_EXECUTION_ERROR,
                '页面图片滚动后仍位于 Loom 可视区域之外',
                { viewportRect: rect, viewportSize: { width: viewportWidth, height: viewportHeight } }
            );
        }

        const requestedFormat = String(
            options.imageFormat || options.format || 'jpeg'
        ).toLowerCase();
        const format = requestedFormat === 'png' ? 'png' : 'jpeg';
        const quality = Math.min(Math.max(Number(options.quality) || 85, 1), 100);
        const maxWidth = Math.round(
            Math.min(Math.max(Number(options.maxWidth) || 1600, 64), 4096)
        );
        let image = await this.webContents.capturePage({ x, y, width, height });
        const capturedSize = image.getSize();
        if (!capturedSize.width || !capturedSize.height) {
            throw new protocol.WebAgentError(
                protocol.ErrorCode.ADAPTER_EXECUTION_ERROR,
                '页面图片截图结果为空',
                { viewportRect: rect }
            );
        }
        if (capturedSize.width > maxWidth) {
            image = image.resize({
                width: maxWidth,
                quality: 'best',
            });
        }

        const outputSize = image.getSize();
        const buffer = format === 'png' ? image.toPNG() : image.toJPEG(quality);
        return {
            ...response,
            code: 'PAGE_IMAGE_CAPTURED',
            message: `Loom 页面图片 ${resolved.imageId || resolved.resolvedImageId || ''} 获取成功 (${format})`,
            result: {
                ...resolved,
                dataUrl: `data:image/${format};base64,${buffer.toString('base64')}`,
                mimeType: `image/${format}`,
                format,
                quality: format === 'jpeg' ? quality : null,
                maxWidth,
                capturedSize,
                outputSize,
                byteLength: buffer.length,
                capturedAt: new Date().toISOString(),
            },
            backendUsed: 'electron-capture-page',
        };
    }

    async executeStorageOperation(operation, payload) {
        const area = operation.includes('_session') ? 'sessionStorage' : 'localStorage';
        const mode = operation.includes('_set_') ? 'set' : 'get';
        const code = `(() => {
            const storage = globalThis[${JSON.stringify(area)}];
            const payload = ${JSON.stringify(payload)};
            if (${JSON.stringify(mode)} === 'get') {
                if (payload.key !== undefined) {
                    return { [String(payload.key)]: storage.getItem(String(payload.key)) };
                }
                return Object.fromEntries(Array.from({ length: storage.length }, (_, index) => {
                    const key = storage.key(index);
                    return [key, storage.getItem(key)];
                }));
            }
            const entries = payload.entries && typeof payload.entries === 'object'
                ? Object.entries(payload.entries)
                : [[payload.key, payload.value]];
            for (const [key, value] of entries) {
                storage.setItem(String(key), String(value ?? ''));
            }
            return { written: entries.map(([key]) => String(key)) };
        })()`;
        const result = await this.executeInWorld(code, 'ISOLATED');
        return {
            message: `${area} ${mode} 成功`,
            code: mode === 'get' ? 'STORAGE_VALUES_RETURNED' : 'STORAGE_VALUES_WRITTEN',
            result,
            backendUsed: 'electron-isolated-world',
        };
    }

    async executeInWorld(code, executionWorld = 'MAIN') {
        this.assertAvailable();
        if (String(executionWorld).toUpperCase() === 'ISOLATED') {
            return this.webContents.executeJavaScriptInIsolatedWorld(
                this.worldId,
                [{
                    code,
                    url: `vcp-loom-webcore://script/${Date.now()}.js`,
                }],
                true
            );
        }
        return this.webContents.executeJavaScript(code, true);
    }

    async executeScript(options = {}) {
        const code = String(options.code || '');
        if (!code.trim()) {
            throw new protocol.WebAgentError(
                protocol.ErrorCode.INVALID_REQUEST,
                '脚本执行缺少代码'
            );
        }
        if (options.operation) {
            throw new protocol.WebAgentError(
                protocol.ErrorCode.CAPABILITY_NOT_SUPPORTED,
                `Electron Adapter 未注册固定 operation: ${options.operation}`
            );
        }
        const executionWorld = String(options.executionWorld || 'MAIN').toUpperCase() === 'ISOLATED'
            ? 'ISOLATED'
            : 'MAIN';
        const wrapped = `(async () => {
            const runner = new Function(${JSON.stringify(`return (async () => {\n${code}\n})()`)});
            return await runner();
        })()`;
        const result = await this.executeInWorld(wrapped, executionWorld);
        return {
            message: result === undefined
                ? `脚本执行完成，但未返回可序列化结果 (${executionWorld})`
                : `脚本执行成功 (${executionWorld})`,
            code: result === undefined ? 'SCRIPT_RESULT_MISSING' : 'SCRIPT_RESULT_RETURNED',
            result: result === undefined ? null : result,
            details: {
                executionWorld,
                resultPresent: result !== undefined,
                resultType: result === null ? 'null' : typeof result,
            },
            backendUsed: executionWorld === 'ISOLATED'
                ? 'electron-isolated-world'
                : 'electron-main-world',
        };
    }

    async attachDebugger(_targetContext = {}, options = {}) {
        this.assertAvailable();
        const debuggerApi = this.webContents.debugger;
        if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
        if (options.network !== false) {
            await debuggerApi.sendCommand('Network.enable');
        }
        return {
            message: 'Loom Debugger 连接成功',
            code: 'DEBUGGER_ATTACHED',
            result: { targetId: this.webContents.id, attached: true },
            backendUsed: 'electron-debugger',
        };
    }

    async detachDebugger() {
        const debuggerApi = this.webContents.debugger;
        if (debuggerApi.isAttached()) debuggerApi.detach();
        this.networkLogs.clear();
        return {
            message: 'Loom Debugger 已断开',
            code: 'DEBUGGER_DETACHED',
            result: { targetId: this.webContents.id, attached: false },
            backendUsed: 'electron-debugger',
        };
    }

    async getDebuggerStatus() {
        return {
            message: 'Loom Debugger 状态已返回',
            code: 'DEBUGGER_STATUS_RETURNED',
            result: {
                attached: !this.webContents.isDestroyed() && this.webContents.debugger.isAttached(),
                targetId: this.webContents.id,
            },
            backendUsed: 'electron-debugger',
        };
    }

    async ensureDebugger(options = {}) {
        if (!this.webContents.debugger.isAttached()) {
            await this.attachDebugger({}, options);
        }
    }

    async sendDebuggerCommand(method, params = {}) {
        if (!method) {
            throw new protocol.WebAgentError(
                protocol.ErrorCode.INVALID_REQUEST,
                'Debugger 命令缺少 method'
            );
        }
        await this.ensureDebugger({ network: method.startsWith('Network.') });
        const result = await this.webContents.debugger.sendCommand(method, params);
        return {
            message: `${method} 执行成功`,
            code: 'DEBUGGER_COMMAND_COMPLETED',
            result: result || {},
            backendUsed: 'electron-debugger',
        };
    }

    subscribeDebuggerEvents(listener) {
        this.debuggerListeners.add(listener);
        return () => this.debuggerListeners.delete(listener);
    }

    unsubscribeDebuggerEvents(listener) {
        if (listener) this.debuggerListeners.delete(listener);
        else this.debuggerListeners.clear();
    }

    bindDebuggerEvents() {
        if (this.bound) return;
        this.bound = true;
        this.webContents.debugger.on('message', (_event, method, params, sessionId) => {
            if (method === 'Network.requestWillBeSent') {
                this.networkLogs.set(params.requestId, {
                    requestId: params.requestId,
                    request: params.request,
                    timestamp: params.timestamp,
                    resourceType: params.type,
                });
            } else if (method === 'Network.responseReceived') {
                const log = this.networkLogs.get(params.requestId);
                if (log) log.response = params.response;
            }
            const event = {
                adapter: this.id,
                targetId: this.webContents.id,
                appId: this.appId,
                method,
                params,
                sessionId: sessionId || null,
                timestamp: Date.now(),
            };
            for (const listener of this.debuggerListeners) listener(event);
        });
        this.webContents.debugger.on('detach', () => {
            this.networkLogs.clear();
        });
    }

    async dispatchNativeInput(plan) {
        await this.ensureDebugger({ network: false });
        if (plan.type === 'insert-text') {
            await this.webContents.debugger.sendCommand('Input.insertText', {
                text: String(plan.text || ''),
            });
        } else if (plan.type === 'keyboard-sequence') {
            for (const descriptor of plan.keys) {
                const common = {
                    key: descriptor.key,
                    code: descriptor.code,
                    modifiers: plan.modifiers,
                    location: descriptor.location,
                    windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
                    nativeVirtualKeyCode: descriptor.nativeVirtualKeyCode,
                };
                await this.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
                    type: descriptor.text && plan.modifiers === 0 ? 'keyDown' : 'rawKeyDown',
                    ...common,
                });
                if (descriptor.text && plan.modifiers === 0) {
                    await this.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
                        type: 'char',
                        ...common,
                        text: descriptor.text,
                        unmodifiedText: descriptor.text,
                    });
                }
                await this.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
                    type: 'keyUp',
                    ...common,
                });
            }
        } else if (plan.type === 'mouse-sequence') {
            const typeMap = {
                move: 'mouseMoved',
                down: 'mousePressed',
                up: 'mouseReleased',
                wheel: 'mouseWheel',
            };
            for (const event of plan.events) {
                await this.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
                    ...event,
                    type: typeMap[event.type] || event.type,
                });
            }
        } else {
            throw new protocol.WebAgentError(
                protocol.ErrorCode.INVALID_REQUEST,
                `未知原生输入计划: ${plan.type}`
            );
        }
        return {
            message: 'Loom 原生输入计划执行成功',
            code: 'ACTION_DISPATCHED',
            result: { attempted: true, verified: null, plan },
            backendUsed: 'electron-debugger',
        };
    }

    async captureScreenshot(options = {}) {
        this.assertAvailable();
        const format = ['jpeg', 'jpg'].includes(
            String(options.imageFormat || options.format || '').toLowerCase()
        ) ? 'jpeg' : 'png';
        const quality = Math.min(Math.max(Number(options.quality) || 90, 1), 100);
        const image = await this.webContents.capturePage();
        const buffer = format === 'jpeg'
            ? image.toJPEG(quality)
            : image.toPNG();
        return {
            message: `Loom 页面截图获取成功 (${format})`,
            code: 'SCREENSHOT_CAPTURED',
            result: {
                dataUrl: `data:image/${format};base64,${buffer.toString('base64')}`,
                mimeType: `image/${format}`,
                format,
                byteLength: buffer.length,
                capturedAt: new Date().toISOString(),
                target: await this.getTarget(),
            },
            backendUsed: 'electron-capture-page',
        };
    }

    normalizeTarget() {
        this.assertAvailable();
        return {
            id: this.webContents.id,
            targetId: this.webContents.id,
            appId: this.appId,
            title: this.webContents.getTitle() || '',
            url: this.webContents.getURL() || '',
            active: true,
            loading: this.webContents.isLoading(),
        };
    }

    async listTargets() {
        const target = this.normalizeTarget();
        return {
            message: 'Loom 目标列表获取成功',
            code: 'TARGETS_RETURNED',
            result: { targets: [target], tabs: [target], count: 1 },
            backendUsed: 'electron-webcontents',
        };
    }

    async getTarget() {
        return this.normalizeTarget();
    }

    async getActiveTarget() {
        return this.normalizeTarget();
    }

    async activateTarget() {
        return {
            message: `LoomAPP "${this.appId}" 已是当前适配器目标`,
            code: 'TARGET_ACTIVATED',
            result: this.normalizeTarget(),
            backendUsed: 'electron-webcontents',
        };
    }

    async createTarget(options = {}) {
        if (!options.url) {
            throw new protocol.WebAgentError(
                protocol.ErrorCode.INVALID_REQUEST,
                'Loom 单目标适配器创建目标时必须提供 url'
            );
        }
        return this.navigate('navigate', options);
    }

    async closeTarget() {
        throw new protocol.WebAgentError(
            protocol.ErrorCode.CAPABILITY_NOT_SUPPORTED,
            'Loom 单目标适配器不通过 target_close 关闭应用，请使用 CloseApp'
        );
    }

    async navigate(action, payload = {}) {
        this.assertAvailable();
        if (action === 'navigate') {
            await this.webContents.loadURL(String(payload.url || ''));
        } else if (action === 'reload') {
            this.webContents.reload();
        } else if (action === 'back' && this.webContents.navigationHistory.canGoBack()) {
            this.webContents.navigationHistory.goBack();
        } else if (action === 'forward' && this.webContents.navigationHistory.canGoForward()) {
            this.webContents.navigationHistory.goForward();
        }
        this.invalidateDocument();
        return {
            message: `Loom 目标导航操作已分派: ${action}`,
            code: 'TARGET_NAVIGATION_DISPATCHED',
            result: this.normalizeTarget(),
            backendUsed: 'electron-webcontents',
        };
    }

    async waitForNavigation(context = {}) {
        this.assertAvailable();
        const timeoutMs = Math.min(Math.max(Number(context.timeoutMs) || 10000, 100), 120000);
        return new Promise((resolve) => {
            let settled = false;
            const finish = (reason) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.webContents.removeListener('did-finish-load', onFinish);
                resolve({
                    message: `Loom 导航等待结束: ${reason}`,
                    code: reason === 'complete'
                        ? 'NAVIGATION_COMPLETED'
                        : 'NAVIGATION_WAIT_TIMEOUT',
                    result: { reason, target: this.normalizeTarget() },
                    backendUsed: 'electron-webcontents',
                });
            };
            const onFinish = () => finish('complete');
            const timer = setTimeout(() => finish('timeout'), timeoutMs);
            this.webContents.once('did-finish-load', onFinish);
        });
    }

    async dispose() {
        this.debuggerListeners.clear();
        if (!this.webContents.isDestroyed() && this.webContents.debugger.isAttached()) {
            this.webContents.debugger.detach();
        }
    }
}

function createElectronWebAgentAdapter(webContents, options) {
    return new ElectronWebAgentAdapter(webContents, options);
}

module.exports = Object.freeze({
    VERSION,
    CAPABILITIES,
    ElectronWebAgentAdapter,
    createElectronWebAgentAdapter,
});