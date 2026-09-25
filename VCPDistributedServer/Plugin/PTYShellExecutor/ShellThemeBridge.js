'use strict';

const fs = require('fs');
const path = require('path');

const THEME_STATE_CHANNEL = 'theme-state-updated';
const VALID_THEME_MODES = new Set(['light', 'dark', 'system']);

function isUsableWebContents(contents) {
    return Boolean(
        contents
        && typeof contents.send === 'function'
        && !contents.isDestroyed?.()
        && !contents.isCrashed?.()
    );
}

function readThemeMode(settingsPaths = [], nativeTheme) {
    for (const settingsPath of settingsPaths) {
        if (!settingsPath || !fs.existsSync(settingsPath)) continue;
        try {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            if (VALID_THEME_MODES.has(settings.currentThemeMode)) {
                return settings.currentThemeMode;
            }
        } catch (error) {
            console.warn(`[PTYShellExecutor] Failed to read theme settings ${settingsPath}:`, error.message);
        }
    }

    return VALID_THEME_MODES.has(nativeTheme?.themeSource)
        ? nativeTheme.themeSource
        : 'dark';
}

/**
 * 插件内部主题桥接：监听设置与主题样式，只向当前 ShellViewer 发送快照。
 */
class ShellThemeBridge {
    constructor({
        chokidar,
        nativeTheme,
        settingsPaths = [],
        themeStylesheetPath = null,
        getTarget = () => null,
        getMode,
        channel = THEME_STATE_CHANNEL,
        debounceMs = 80,
        initialRevision = Date.now()
    } = {}) {
        const normalizedSettingsPaths = Array.isArray(settingsPaths) ? settingsPaths : [];
        this.chokidar = chokidar;
        this.nativeTheme = nativeTheme;
        this.settingsPaths = normalizedSettingsPaths.filter(
            settingsPath => typeof settingsPath === 'string' && settingsPath.length > 0
        );
        this.themeStylesheetPath = typeof themeStylesheetPath === 'string'
            ? themeStylesheetPath
            : null;
        this.getTarget = typeof getTarget === 'function' ? getTarget : () => null;
        this.getMode = typeof getMode === 'function'
            ? getMode
            : () => readThemeMode(this.settingsPaths, this.nativeTheme);
        this.channel = channel;
        this.debounceMs = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : 80;
        this.revision = Number.isFinite(initialRevision) ? initialRevision : Date.now();
        this.watcher = null;
        this.sendTimer = null;
        this.started = false;
        this.onWatchEvent = (_event, changedPath) => {
            if (!this.started) return;
            const stylesheetChanged = changedPath
                && this.themeStylesheetPath
                && path.resolve(changedPath) === path.resolve(this.themeStylesheetPath);
            this.notifyChanged({ stylesheetChanged });
        };
        this.onWatcherError = error => {
            console.warn('[PTYShellExecutor] Theme watcher error:', error.message);
        };
        this.onNativeThemeUpdated = () => {
            if (this.started && this.getSnapshot().mode === 'system') this.notifyChanged();
        };
    }

    getSnapshot() {
        let requestedMode;
        try {
            requestedMode = this.getMode();
        } catch (error) {
            console.warn('[PTYShellExecutor] Failed to resolve theme mode:', error.message);
        }
        const mode = VALID_THEME_MODES.has(requestedMode)
            ? requestedMode
            : readThemeMode(this.settingsPaths, this.nativeTheme);
        return {
            mode,
            resolvedMode: mode === 'system'
                ? (this.nativeTheme?.shouldUseDarkColors ? 'dark' : 'light')
                : mode,
            revision: this.revision
        };
    }

    sendSnapshot(target = this.getTarget?.()) {
        if (!isUsableWebContents(target)) return false;
        try {
            target.send(this.channel, this.getSnapshot());
            return true;
        } catch (error) {
            console.warn('[PTYShellExecutor] Failed to send theme state:', error.message);
            return false;
        }
    }

    notifyChanged({ stylesheetChanged = false } = {}) {
        if (!this.started) return;
        if (stylesheetChanged) {
            this.revision = Math.max(this.revision + 1, Date.now());
        }
        if (this.sendTimer !== null) clearTimeout(this.sendTimer);
        this.sendTimer = setTimeout(() => {
            this.sendTimer = null;
            this.sendSnapshot();
        }, this.debounceMs);
    }

    start() {
        if (this.started) return this;
        this.started = true;

        if (this.chokidar?.watch) {
            const watchedPaths = [...this.settingsPaths, this.themeStylesheetPath].filter(Boolean);
            if (watchedPaths.length > 0) {
                try {
                    this.watcher = this.chokidar.watch(watchedPaths, {
                        persistent: true,
                        ignoreInitial: true,
                        awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 }
                    });
                    this.watcher.on('all', this.onWatchEvent);
                    this.watcher.on('error', this.onWatcherError);
                } catch (error) {
                    console.warn('[PTYShellExecutor] Failed to start theme watcher:', error.message);
                    this.watcher = null;
                }
            }
        }
        this.nativeTheme?.on?.('updated', this.onNativeThemeUpdated);
        return this;
    }

    dispose() {
        this.started = false;
        if (this.sendTimer !== null) {
            clearTimeout(this.sendTimer);
            this.sendTimer = null;
        }
        this.nativeTheme?.removeListener?.('updated', this.onNativeThemeUpdated);
        const watcher = this.watcher;
        watcher?.removeListener?.('all', this.onWatchEvent);
        try {
            const closeResult = watcher?.close?.();
            if (closeResult?.then) {
                Promise.resolve(closeResult)
                    .catch(error => {
                        console.warn('[PTYShellExecutor] Failed to close theme watcher:', error.message);
                    })
                    .finally(() => watcher?.removeListener?.('error', this.onWatcherError));
            } else {
                watcher?.removeListener?.('error', this.onWatcherError);
            }
        } catch (error) {
            console.warn('[PTYShellExecutor] Failed to close theme watcher:', error.message);
            watcher?.removeListener?.('error', this.onWatcherError);
        }
        this.watcher = null;
    }
}

function createShellThemeBridge(options) {
    return new ShellThemeBridge(options);
}

module.exports = {
    createShellThemeBridge,
    readThemeMode,
    ShellThemeBridge,
    THEME_STATE_CHANNEL
};
