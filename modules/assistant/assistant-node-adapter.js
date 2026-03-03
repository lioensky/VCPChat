const { clipboard, globalShortcut } = require('electron');

function getForegroundAppName() {
    if (process.platform !== 'win32') return '';
    try {
        const { execSync } = require('child_process');
        const result = execSync(
            'powershell "Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -First 1 ProcessName"',
            { encoding: 'utf8' }
        );
        return result.trim();
    } catch {
        return '';
    }
}

class NodeAssistantAdapter {
    constructor(options = {}) {
        this.logger = options.logger || console;
        this.SelectionHook = null;
        this.selectionHookInstance = null;
        this.selectionListenerActive = false;
        this.suspendUntil = 0;
        this.lastClipboardContent = '';
        this.lastProcessedSelection = '';
        this.clipChecker = null;
        this.selectionCallback = null;
    }

    async initialize() {
        if (process.platform !== 'win32') {
            this.logger.log('[Assistant][NodeAdapter] selection-hook only supports Windows.');
            return;
        }

        try {
            const selectionHookModule = await import('selection-hook');
            this.SelectionHook = selectionHookModule.default || selectionHookModule;
            this.logger.log('[Assistant][NodeAdapter] selection-hook loaded.');
        } catch (error) {
            this.logger.error('[Assistant][NodeAdapter] Failed to load selection-hook:', error);
            this.SelectionHook = null;
        }
    }

    onSelection(callback) {
        this.selectionCallback = callback;
    }

    suspend(durationMs) {
        this.suspendUntil = Date.now() + Math.max(0, Number(durationMs) || 0);
    }

    isActive() {
        return this.selectionListenerActive;
    }

    registerSuspendHotkey() {
        globalShortcut.register('CommandOrControl+Shift+P', () => {
            this.suspend(10000);
            this.logger.log('[Assistant][NodeAdapter] Manually suspended for 10s');
        });
    }

    detectClipboardConflict() {
        const currentClip = clipboard.readText();
        if (currentClip !== this.lastClipboardContent) {
            this.logger.log('[Assistant][NodeAdapter] External clipboard change, suspending 1s');
            this.suspend(1000);
            this.lastClipboardContent = currentClip;
        }
    }

    handleSelectionData = (selectionData) => {
        if (Date.now() < this.suspendUntil) {
            return;
        }

        const foregroundApp = getForegroundAppName();
        const screenshotApps = ['SnippingTool', 'Snipaste', 'ShareX', 'QQ', 'WeChat'];
        if (screenshotApps.some(app => foregroundApp.includes(app))) {
            this.logger.log('[Assistant][NodeAdapter] Screenshot tool active, suspending 3s');
            this.suspend(3000);
            return;
        }

        const selectedText = selectionData?.text || '';
        if (!selectedText || selectedText.trim() === '') {
            this.lastProcessedSelection = '';
            if (this.selectionCallback) {
                this.selectionCallback({ text: '' });
            }
            return;
        }

        if (selectedText === this.lastProcessedSelection) {
            return;
        }
        this.lastProcessedSelection = selectedText;

        if (this.selectionCallback) {
            this.selectionCallback(selectionData);
        }
    };

    start() {
        if (this.selectionListenerActive) {
            return true;
        }
        if (!this.SelectionHook) {
            this.logger.warn('[Assistant][NodeAdapter] SelectionHook is unavailable.');
            return false;
        }

        try {
            this.selectionHookInstance = new this.SelectionHook();
            this.selectionHookInstance.on('text-selection', this.handleSelectionData);
            this.selectionHookInstance.on('error', (error) => {
                this.logger.error('[Assistant][NodeAdapter] selection-hook error:', error);
            });

            this.clipChecker = setInterval(() => {
                if (!this.selectionListenerActive) {
                    clearInterval(this.clipChecker);
                    this.clipChecker = null;
                    return;
                }
                // 首次读取剪贴板（延迟到第一次冲突检查时）
                if (!this.lastClipboardContent) {
                    try {
                        this.lastClipboardContent = clipboard.readText() || '';
                    } catch (e) {
                        this.lastClipboardContent = '';
                    }
                }
                this.detectClipboardConflict();
            }, 500);

            const started = this.selectionHookInstance.start({ debug: false });
            if (!started) {
                this.logger.error('[Assistant][NodeAdapter] Failed to start selection-hook listener.');
                this.selectionHookInstance = null;
                if (this.clipChecker) {
                    clearInterval(this.clipChecker);
                    this.clipChecker = null;
                }
                return false;
            }

            this.selectionListenerActive = true;
            this.registerSuspendHotkey();
            this.logger.log('[Assistant][NodeAdapter] Listener started.');
            return true;
        } catch (e) {
            this.logger.error('[Assistant][NodeAdapter] Failed to start listener:', e);
            this.selectionHookInstance = null;
            if (this.clipChecker) {
                clearInterval(this.clipChecker);
                this.clipChecker = null;
            }
            this.selectionListenerActive = false;
            return false;
        }
    }

    stop() {
        if (!this.selectionListenerActive || !this.selectionHookInstance) {
            return;
        }

        try {
            this.selectionHookInstance.stop();
            globalShortcut.unregister('CommandOrControl+Shift+P');
            if (this.clipChecker) {
                clearInterval(this.clipChecker);
                this.clipChecker = null;
            }
            this.logger.log('[Assistant][NodeAdapter] Listener stopped.');
        } catch (e) {
            this.logger.error('[Assistant][NodeAdapter] Failed to stop listener:', e);
        } finally {
            this.selectionHookInstance = null;
            this.selectionListenerActive = false;
        }
    }
}

function createNodeAssistantAdapter(options) {
    return new NodeAssistantAdapter(options);
}

module.exports = {
    createNodeAssistantAdapter,
    NodeAssistantAdapter
};
