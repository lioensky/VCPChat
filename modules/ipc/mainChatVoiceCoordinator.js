const { ipcMain } = require('electron');

const MAIN_CHAT_INITIAL_IDLE_MS = 5500;
const MAIN_CHAT_CAPTURE_QUIET_MS = 2500;
const MAIN_CHAT_SETTLE_FAST_MS = 50;
const MAIN_CHAT_MAX_SETTLE_MS = 6000;

function clearSettleTimers(session) {
    clearTimeout(session.autoFinishTimer);
    clearTimeout(session.settleTimer);
    clearTimeout(session.settleDeadlineTimer);
    clearTimeout(session.idleTimer);
    session.autoFinishTimer = null;
    session.settleTimer = null;
    session.settleDeadlineTimer = null;
    session.idleTimer = null;
}

function resolveSessionText(session) {
    if (!session.settleResolve) return;
    const resolve = session.settleResolve;
    session.settleResolve = null;
    clearSettleTimers(session);
    resolve(session.text.trim());
}

function resetSettleTimer(session, isSettled = false) {
    if (!session.stopping || !session.settleResolve) return;
    clearTimeout(session.settleTimer);
    session.settleTimer = null;

    if (!session.composing) {
        const delay = isSettled ? 10 : MAIN_CHAT_SETTLE_FAST_MS;
        session.settleTimer = setTimeout(() => {
            resolveSessionText(session);
        }, delay);
    }
}

function scheduleIdleTimeout(session, onTimeout) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
    if (session.stopping) return;

    const idleMs = session.idleTimeoutMs || MAIN_CHAT_INITIAL_IDLE_MS;
    session.idleTimer = setTimeout(() => {
        session.idleTimer = null;
        if (!session.stopping && !session.text.trim()) {
            onTimeout?.();
        }
    }, idleMs);
}

function scheduleAutoFinish(session, onAutoFinish) {
    clearTimeout(session.autoFinishTimer);
    session.autoFinishTimer = null;

    if (session.mode !== 'windows_voice_typing' || session.stopping || session.composing || !session.text.trim()) {
        return;
    }

    const finishDelay = Math.max(500, session.quietTimeoutMs || MAIN_CHAT_CAPTURE_QUIET_MS);
    session.autoFinishTimer = setTimeout(() => {
        session.autoFinishTimer = null;
        if (!session.stopping && !session.composing) {
            onAutoFinish?.();
        }
    }, finishDelay);
}

function waitForSessionTextToSettle(session) {
    return new Promise(resolve => {
        session.settleResolve = resolve;
        session.settleDeadlineTimer = setTimeout(() => {
            resolveSessionText(session);
        }, MAIN_CHAT_MAX_SETTLE_MS);
        resetSettleTimer(session);
    });
}

function getNativeWindowHandleString(win) {
    if (!win || win.isDestroyed() || typeof win.getNativeWindowHandle !== 'function') {
        return null;
    }
    const buffer = win.getNativeWindowHandle();
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    if (buffer.length >= 8) return buffer.readBigUInt64LE(0).toString();
    if (buffer.length >= 4) return String(buffer.readUInt32LE(0));
    return null;
}

class MainChatVoiceCoordinator {
    constructor(deps) {
        this.deps = deps;
        this.activeSession = null;
        this.sessionSequence = 0;
    }

    getActiveSession() {
        return this.activeSession;
    }

    isSessionActive() {
        return Boolean(this.activeSession && !this.activeSession.stopping);
    }

    handleCaptureUpdate(payload = {}) {
        if (!this.activeSession) return false;
        const session = this.activeSession;
        session.text = String(payload.text || '');
        session.composing = payload.composing === true;
        session.updatedAt = Number(payload.updatedAt) || Date.now();

        if (session.text.trim()) {
            clearTimeout(session.idleTimer);
            session.idleTimer = null;
        }

        if (session.stopping) {
            resetSettleTimer(session, payload.settled === true);
        } else {
            scheduleAutoFinish(session, () => {
                this.stopSession().catch(err => {
                    console.error('[MainChatVoiceCoordinator] 自动结算异常:', err);
                });
            });
        }
        return true;
    }

    async startSession(options = {}) {
        if (this.deps.isSubwindowHotkeyActive?.()) {
            return {
                success: false,
                reason: 'subwindow_active',
                error: '语音聊天小窗口正在听写中',
            };
        }

        const mainWindow = this.deps.getMainWindow?.();
        if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
            return { success: false, error: '主聊天窗口不可用' };
        }

        if (this.activeSession) {
            await this.stopSession();
        }

        const settings = this.deps.getSettingsManager ? await this.deps.getSettingsManager().readSettings() : {};
        const mode = options.mode || (settings?.voiceInputMode === 'right_alt_hold' ? 'right_alt_hold' : 'windows_voice_typing');

        await this.deps.ensureVoiceCaptureWindowReady();
        const engine = this.deps.getVoiceInputEngine();
        await engine.start();
        this.deps.ensureEngineEvents?.();

        const shortcut = this.deps.getConfiguredShortcut?.() || 'F7';
        await engine.configureHotkey({ shortcut, mode });

        const initialIdle = Number(options.idleTimeoutMs)
            || (Number(settings?.mainChatVoiceInitialIdleTimeout) ? Number(settings.mainChatVoiceInitialIdleTimeout) * 1000 : MAIN_CHAT_INITIAL_IDLE_MS);
        const quiet = Number(options.quietTimeoutMs)
            || (Number(settings?.mainChatVoiceQuietTimeout) ? Number(settings.mainChatVoiceQuietTimeout) * 1000 : MAIN_CHAT_CAPTURE_QUIET_MS);

        const sessionId = `main-voice-${Date.now()}-${++this.sessionSequence}`;
        const session = {
            id: sessionId,
            targetWebContentsId: mainWindow.webContents.id,
            target: mainWindow,
            text: '',
            composing: false,
            updatedAt: Date.now(),
            stopping: false,
            autoFinishTimer: null,
            settleTimer: null,
            settleDeadlineTimer: null,
            settleResolve: null,
            idleTimer: null,
            focusReadySent: false,
            hotkey: shortcut,
            mode,
            originalWindowHandle: getNativeWindowHandleString(mainWindow),
            isMainChat: true,
            quietTimeoutMs: quiet,
            idleTimeoutMs: initialIdle,
        };

        this.activeSession = session;
        this.deps.onSessionCreated?.(session);

        const onTargetDestroyed = () => {
            if (this.activeSession?.id === sessionId) {
                this.cancelSession().catch(() => {});
            }
        };
        session.cleanupTarget = onTargetDestroyed;
        if (!mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.once('destroyed', onTargetDestroyed);
        }

        scheduleIdleTimeout(session, () => {
            this.stopSession().catch(err => {
                console.warn('[MainChatVoiceCoordinator] 空闲超时退出异常:', err);
            });
        });

        const win = this.deps.getVoiceCaptureWindow();
        this.deps.positionVoiceCaptureWindow();
        win.show();
        win.focus();
        win.webContents.focus();
        setImmediate(() => {
            if (this.activeSession?.id === sessionId && win && !win.isDestroyed()) {
                win.webContents.send('voice-input-capture:prepare', { sessionId });
            }
        });

        return { success: true, sessionId, mode };
    }

    async stopSession() {
        const session = this.activeSession;
        if (!session) return { success: true, text: '' };
        if (session.stopping && session.stopPromise) {
            return session.stopPromise;
        }
        session.stopping = true;

        session.stopPromise = (async () => {
            const engine = this.deps.getVoiceInputEngine();
            await engine?.stopSession().catch(err => {
                console.warn('[MainChatVoiceCoordinator] 停止听写引擎受阻:', err.message);
            });

            const win = this.deps.getVoiceCaptureWindow();
            if (win && !win.isDestroyed()) {
                win.webContents.send('voice-input-capture:stop', { sessionId: session.id });
            }

            const text = await waitForSessionTextToSettle(session);
            await engine?.restoreFocus().catch(err => {
                console.warn('[MainChatVoiceCoordinator] 恢复焦点受阻:', err.message);
            });

            if (session.cleanupTarget && session.target && !session.target.isDestroyed() && !session.target.webContents.isDestroyed()) {
                session.target.webContents.removeListener('destroyed', session.cleanupTarget);
                session.cleanupTarget = null;
            }

            if (win && !win.isDestroyed()) {
                win.hide();
            }
            if (this.activeSession === session) {
                this.activeSession = null;
            }
            this.deps.onSessionEnded?.(session);

            if (!session.canceled && session.target && !session.target.isDestroyed() && !session.target.webContents.isDestroyed()) {
                if (text) {
                    session.target.webContents.send('main-chat-voice:captured-text', {
                        text,
                        sessionId: session.id,
                        source: session.mode,
                    });
                }
                session.target.webContents.send('main-chat-voice:session-ended', {
                    text: text || '',
                    sessionId: session.id,
                    source: session.mode,
                });
            }

            return { success: true, text };
        })();

        return session.stopPromise;
    }

    async cancelSession(options = {}) {
        const session = this.activeSession;
        if (!session) return { success: true };
        session.stopping = true;
        session.canceled = true;
        if (this.activeSession === session) {
            this.activeSession = null;
        }
        clearSettleTimers(session);
        if (typeof session.settleResolve === 'function') {
            const resolve = session.settleResolve;
            session.settleResolve = null;
            resolve('');
        }

        if (session.cleanupTarget && session.target && !session.target.isDestroyed() && !session.target.webContents.isDestroyed()) {
            session.target.webContents.removeListener('destroyed', session.cleanupTarget);
            session.cleanupTarget = null;
        }

        const engine = this.deps.getVoiceInputEngine();
        await engine?.stopSession().catch(() => {});
        await engine?.releaseAll().catch(() => {});
        await engine?.restoreFocus().catch(() => {});

        const win = this.deps.getVoiceCaptureWindow();
        if (win && !win.isDestroyed()) {
            win.hide();
        }

        if (session.target && !session.target.isDestroyed() && !session.target.webContents.isDestroyed()) {
            session.target.webContents.send('main-chat-voice:session-ended', {
                text: '',
                sessionId: session.id,
                source: session.mode,
                canceled: true,
                forceDeactivate: true,
                reason: options?.reason || 'canceled',
            });
        }
        this.deps.onSessionEnded?.(session);
        return { success: true };
    }

    async getStatus() {
        const settings = this.deps.getSettingsManager ? await this.deps.getSettingsManager().readSettings() : {};
        const mode = settings?.voiceInputMode === 'right_alt_hold' ? 'right_alt_hold' : 'windows_voice_typing';
        const engine = this.deps.getVoiceInputEngine();

        return {
            success: true,
            active: this.isSessionActive(),
            mode,
            engine: engine?.getStatus() || {
                lifecycleState: 'stopped',
                ready: false,
                processAlive: false,
            },
        };
    }

    registerIpcHandlers() {
        ipcMain.handle('main-chat-voice:start', async (_event, options) => {
            return this.startSession(options);
        });
        ipcMain.handle('main-chat-voice:stop', async () => {
            return this.stopSession();
        });
        ipcMain.handle('main-chat-voice:cancel', async () => {
            return this.cancelSession();
        });
        ipcMain.handle('main-chat-voice:status', async () => {
            return this.getStatus();
        });
    }
}

module.exports = {
    MainChatVoiceCoordinator,
};
