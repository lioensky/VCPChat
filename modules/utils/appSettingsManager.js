// modules/utils/settingsManager.js
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class SettingsValidator {
    static validate(settings, defaultSettings) {
        const validated = { ...settings };
        let hasIssues = false;

        // 检查必要字段
        for (const [key, defaultValue] of Object.entries(defaultSettings)) {
            if (!(key in validated)) {
                validated[key] = defaultValue;
                hasIssues = true;
                console.log(`Added missing field: ${key}`);
            }

            // 类型检查 - 允许新添加的字段从 undefined 变为 null
            if (typeof validated[key] !== typeof defaultValue && defaultValue !== null) {
                validated[key] = defaultValue;
                hasIssues = true;
                console.log(`Fixed type for field: ${key}`);
            } else if (key.startsWith('lastOpen') && validated[key] === undefined) {
                // 确保新添加的 lastOpen... 字段在 settings.json 中不存在时，被正确初始化为 null
                validated[key] = null;
            }
        }

        // 数值范围检查
        if (validated.sidebarWidth < 100 || validated.sidebarWidth > 800) {
            validated.sidebarWidth = 260;
            hasIssues = true;
        }

        const allowedChatPresentationModes = new Set(['bubble', 'panel', 'immersive']);
        if (!allowedChatPresentationModes.has(validated.chatPresentationMode)) {
            validated.chatPresentationMode = 'bubble';
            hasIssues = true;
            console.log('Fixed invalid chatPresentationMode');
        }

        const allowedVoiceInputModes = new Set(['windows_voice_typing', 'right_alt_hold']);
        if (!allowedVoiceInputModes.has(validated.voiceInputMode)) {
            validated.voiceInputMode = 'windows_voice_typing';
            hasIssues = true;
            console.log('Fixed invalid voiceInputMode');
        }

        if (typeof validated.voiceInputShortcut !== 'string' || !validated.voiceInputShortcut.trim()) {
            validated.voiceInputShortcut = 'F7';
            hasIssues = true;
            console.log('Fixed invalid voiceInputShortcut');
        } else {
            validated.voiceInputShortcut = validated.voiceInputShortcut.trim().toUpperCase();
        }

        if ('speechRecognizerBrowserPath' in validated) {
            delete validated.speechRecognizerBrowserPath;
            hasIssues = true;
        }
        if ('speechRecognizerPagePath' in validated) {
            delete validated.speechRecognizerPagePath;
            hasIssues = true;
        }

        const allowedStreamAnimationPresets = new Set(['slide-left', 'fade', 'rise', 'scale', 'none', 'custom']);
        if (!allowedStreamAnimationPresets.has(validated.streamAnimationPreset)) {
            validated.streamAnimationPreset = 'slide-left';
            hasIssues = true;
            console.log('Fixed invalid streamAnimationPreset');
        }

        const streamAnimationDurationMs = Number(validated.streamAnimationDurationMs);
        const normalizedStreamAnimationDurationMs = Number.isFinite(streamAnimationDurationMs)
            ? Math.min(2000, Math.max(100, Math.round(streamAnimationDurationMs / 50) * 50))
            : 500;
        if (normalizedStreamAnimationDurationMs !== validated.streamAnimationDurationMs) {
            validated.streamAnimationDurationMs = normalizedStreamAnimationDurationMs;
            hasIssues = true;
        }

        if (typeof validated.streamAnimationCustomCss !== 'string') {
            validated.streamAnimationCustomCss = '';
            hasIssues = true;
        } else if (validated.streamAnimationCustomCss.length > 4000) {
            validated.streamAnimationCustomCss = validated.streamAnimationCustomCss.slice(0, 4000);
            hasIssues = true;
        }

        const appearanceDefaults = defaultSettings.appearanceProfile;
        const appearanceOptions = {
            density: new Set(['compact', 'comfortable', 'relaxed']),
            radius: new Set(['square', 'small', 'medium', 'round', 'custom']),
            typography: new Set(['system', 'humanist', 'serif']),
            fontScale: new Set(['small', 'normal', 'large']),
            contentWidth: new Set(['full', 'centered']),
            surface: new Set(['solid', 'translucent', 'custom']),
            surfaceEffect: new Set(['vibrancy', 'mica', 'acrylic', 'liquid']),
            shellRadius: new Set(['tuned', 'follow', 'square', 'small', 'medium', 'round', 'custom']),
            composerRadius: new Set(['tuned', 'follow', 'square', 'small', 'medium', 'round', 'custom']),
            sidebarRadius: new Set(['tuned', 'follow', 'square', 'small', 'medium', 'round', 'custom']),
            cardRadius: new Set(['tuned', 'follow', 'square', 'small', 'medium', 'round', 'custom'])
        };
        const appearanceRanges = {
            sidebarRowHeight: { min: 38, max: 64 },
            sidebarAvatarSize: { min: 20, max: 52 },
            customRadius: { min: 0, max: 32 },
            surfaceOpacity: { min: 20, max: 100 },
            surfaceBlur: { min: 0, max: 40 },
            surfaceSaturation: { min: 50, max: 180 },
            surfaceBrightness: { min: 80, max: 120 },
            surfaceBorder: { min: 0, max: 100 },
            surfaceShadow: { min: 0, max: 100 },
            surfaceSheen: { min: 0, max: 100 }
        };
        if (!validated.appearanceProfile || typeof validated.appearanceProfile !== 'object' || Array.isArray(validated.appearanceProfile)) {
            validated.appearanceProfile = { ...appearanceDefaults };
            hasIssues = true;
        } else {
            const normalizedAppearance = {};
            for (const [key, allowed] of Object.entries(appearanceOptions)) {
                const value = validated.appearanceProfile[key];
                normalizedAppearance[key] = allowed.has(value) ? value : appearanceDefaults[key];
                if (normalizedAppearance[key] !== value) hasIssues = true;
            }
            for (const [key, range] of Object.entries(appearanceRanges)) {
                const parsed = Number(validated.appearanceProfile[key]);
                const fallback = appearanceDefaults[key];
                normalizedAppearance[key] = Number.isFinite(parsed)
                    ? Math.min(range.max, Math.max(range.min, Math.round(parsed)))
                    : fallback;
                if (normalizedAppearance[key] !== validated.appearanceProfile[key]) hasIssues = true;
            }
            const safeAvatarSize = Math.min(
                normalizedAppearance.sidebarAvatarSize,
                normalizedAppearance.sidebarRowHeight - 4
            );
            if (safeAvatarSize !== normalizedAppearance.sidebarAvatarSize) hasIssues = true;
            normalizedAppearance.sidebarAvatarSize = safeAvatarSize;
            validated.appearanceProfile = normalizedAppearance;
        }

        // 数组检查
        if (!Array.isArray(validated.networkNotesPaths)) {
            validated.networkNotesPaths = [];
            hasIssues = true;
        }

        if (!Array.isArray(validated.combinedItemOrder)) {
            validated.combinedItemOrder = [];
            hasIssues = true;
        }

        if (!Array.isArray(validated.agentOrder)) {
            validated.agentOrder = [];
            hasIssues = true;
        }

        if (!Array.isArray(validated.filterRules)) {
            validated.filterRules = [];
            hasIssues = true;
        }

        if (!Array.isArray(validated.toolAutoApprovalRules)) {
            validated.toolAutoApprovalRules = [];
            hasIssues = true;
        }

        return { validated, hasIssues };
    }
}

class SettingsManager extends EventEmitter {
    constructor(settingsPath) {
        super();
        this.settingsPath = settingsPath;
        this.queue = [];
        this.processing = false;
        this.cache = null;
        this.cacheTimestamp = 0;
        this.lockFile = settingsPath + '.lock';

        // 默认设置模板
        this.defaultSettings = {
            sidebarWidth: 260,
            notificationsSidebarWidth: 300,
            userName: '用户',
            vcpServerUrl: '',
            vcpApiKey: '',
            fileKey: '',
            vcpLogUrl: '',
            vcpLogKey: '',
            networkNotesPaths: [],
            filterEnabled: false,
            filterRules: [],
            toolAutoApprovalEnabled: false,
            toolAutoApprovalRules: [],
            enableSmoothStreaming: false,
            streamAnimationPreset: 'slide-left',
            streamAnimationDurationMs: 500,
            streamAnimationCustomCss: '',
            uiMode: 'next',
            showHomeVisualBrand: true,
            showHomeVisualTagline: true,
            homeVisualTagline: '语义级打穿 AI、UI/UX、APP 与人类想象力的边界',
            appearanceProfile: {
                density: 'comfortable',
                radius: 'small',
                typography: 'system',
                fontScale: 'normal',
                contentWidth: 'full',
                sidebarRowHeight: 46,
                sidebarAvatarSize: 32,
                customRadius: 10,
                surface: 'translucent',
                surfaceEffect: 'vibrancy',
                surfaceOpacity: 68,
                surfaceBlur: 24,
                surfaceSaturation: 145,
                surfaceBrightness: 103,
                surfaceBorder: 32,
                surfaceShadow: 18,
                surfaceSheen: 18,
                shellRadius: 'tuned',
                composerRadius: 'tuned',
                sidebarRadius: 'tuned',
                cardRadius: 'tuned'
            },
            enableWideChatLayout: false,
            chatPresentationMode: 'bubble',
            chatBubbleMaxWidthDefault: 82,
            chatBubbleMaxWidthNotifications: 90,
            chatBubbleMaxWidthNarrow: 85,
            chatBubbleMaxWidthWideDefault: 92,
            chatBubbleMaxWidthWideNotifications: 96,
            chatBubbleMaxWidthWideNarrow: 92,
            chatFontPreset: 'system',
            chatFontCustom: '',
            chatCodeFontPreset: 'consolas',
            chatCodeFontCustom: '',
            chatDiaryFontPreset: 'serif',
            chatDiaryFontCustom: '',
            chatToolFontPreset: 'system',
            chatToolFontCustom: '',
            enableUserChatBubbleUi: true,
            showUserMetaInChatBubbleUi: true,
            minChunkBufferSize: 1,
            smoothStreamIntervalMs: 25,
            assistantAgent: '',
            voiceMode: 'local',
            voiceInputMode: 'windows_voice_typing',
            voiceInputShortcut: 'F7',
            voiceLocalSettings: {
                sovitsUrl: '',
                sovitsKey: ''
            },
            voiceNetworkSettings: {
                providerUrl: '',
                providerKey: ''
            },
            enableDistributedServer: true,
            ChatDataServiceEnabled: true,
            ChatDataServiceShadowMode: true,
            ChatDataServiceNotifyEnabled: true,
            ChatDataServiceTantivyEnabled: true,
            MobileSyncUseCentralIndex: true,
            DeepMemoUseCentralSearch: false,
            DeepMemoLegacyFallback: true,
            agentMusicControl: false,
            enableDistributedServerLogs: false,
            enableVcpToolInjection: false,
            ragOverlaySettings: {
                enabled: true,
                passThrough: true,
                opacity: 0.9,
                bounds: null,
                useCustomBounds: false,
                notificationCategoryEnabled: false
            },
            lastOpenItemId: null,
            lastOpenItemType: null,
            lastOpenTopicId: null,
            combinedItemOrder: [],
            agentOrder: []
        };
    }

    async acquireLock(timeout = 5000) {
        const startTime = Date.now();
        const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        for (;;) {
            try {
                await fs.writeFile(this.lockFile, token, { flag: 'wx', encoding: 'utf8' });
                return token;
            } catch (error) {
                if (error?.code !== 'EEXIST') throw error;
                if (Date.now() - startTime > timeout) {
                    const busy = new Error('Settings lock acquisition timed out');
                    busy.code = 'SETTINGS_LOCK_BUSY';
                    throw busy;
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
    }

    async releaseLock(token) {
        if (!token) return;
        const current = await fs.readFile(this.lockFile, 'utf8').catch(() => null);
        if (current === token) await fs.remove(this.lockFile).catch(() => {});
    }

    async readSettings({ fresh = false } = {}) {
        try {
            // 使用缓存机制减少文件读取
            const stats = await fs.stat(this.settingsPath).catch(() => null);
            if (!fresh && stats && this.cache && stats.mtimeMs <= this.cacheTimestamp) {
                return { ...this.cache };
            }

            const content = await fs.readFile(this.settingsPath, 'utf8');
            const settings = JSON.parse(content);

            // 更新缓存
            this.cache = settings;
            this.cacheTimestamp = stats ? stats.mtimeMs : Date.now();

            return { ...settings };
        } catch (error) {
            if (error.code === 'ENOENT') {
                return { ...this.defaultSettings };
            }

            console.error('Error reading settings, attempting recovery:', error);

            // 尝试从备份恢复
            const backupPath = this.settingsPath + '.backup';
            if (await fs.pathExists(backupPath)) {
                try {
                    const backupContent = await fs.readFile(backupPath, 'utf8');
                    const backupSettings = JSON.parse(backupContent);

                    // 验证备份数据是否有效且包含用户自定义数据（例如 Agent 列表顺序或非默认用户名）
                    const isNonDefault = backupSettings && (
                        (Array.isArray(backupSettings.combinedItemOrder) && backupSettings.combinedItemOrder.length > 0) ||
                        (backupSettings.userName && backupSettings.userName !== '用户') ||
                        backupSettings.vcpServerUrl
                    );

                    if (isNonDefault) {
                        console.log('Recovered settings from valid backup');
                        return { ...backupSettings };
                    } else {
                        console.warn('Backup exists but appears to be default or empty, skipping recovery to prevent overwrite');
                    }
                } catch (backupError) {
                    console.error('Backup also corrupted:', backupError);
                }
            }

            // 如果主文件损坏且没有有效的备份，抛出错误以防止覆盖
            throw new Error(`Settings file corrupted and no valid backup found: ${error.message}`);
        }
    }

    async writeSettings(settings) {
        const tempFile = this.settingsPath + '.tmp';
        const backupFile = this.settingsPath + '.backup';

        try {
            // 验证设置
            const { validated } = SettingsValidator.validate(settings, this.defaultSettings);

            // 写入临时文件
            await fs.writeJson(tempFile, validated, { spaces: 2 });

            // 验证临时文件
            const verifyContent = await fs.readFile(tempFile, 'utf8');
            JSON.parse(verifyContent);

            // 创建备份（如果原文件存在）
            if (await fs.pathExists(this.settingsPath)) {
                await fs.copy(this.settingsPath, backupFile, { overwrite: true });
            }

            // 原子性替换
            await fs.move(tempFile, this.settingsPath, { overwrite: true });

            // 更新缓存 - 确保原子性
            const newTimestamp = Date.now();
            this.cache = { ...validated };
            this.cacheTimestamp = newTimestamp;

            // 触发更新事件
            this.emit('settings-updated', validated);

            return true;
        } catch (error) {
            console.error('Error writing settings:', error);

            // 清理临时文件
            await fs.remove(tempFile).catch(() => {});

            throw error;
        }
    }

    async updateSettings(updater, options = {}) {
        return new Promise((resolve, reject) => {
            this.queue.push({ updater, resolve, reject, options });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;
        const { updater, resolve, reject, options = {} } = this.queue.shift();
        let lockToken;

        try {
            lockToken = await this.acquireLock();

            // CAS must compare against the bytes currently protected by this
            // lock, never a renderer/process cache that may be stale.
            const currentSettings = await this.readSettings({ fresh: true });
            const currentRevision = this.getRevision(currentSettings);
            if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
                const conflict = new Error(`Settings changed since it was read (expected ${options.expectedRevision}, current ${currentRevision})`);
                conflict.code = 'SETTINGS_CONFLICT';
                conflict.expectedRevision = options.expectedRevision;
                conflict.currentRevision = currentRevision;
                conflict.operationId = options.operationId;
                throw conflict;
            }
            let newSettings;
            if (typeof updater === 'function') {
                newSettings = await updater(currentSettings);
            } else if (updater && Array.isArray(updater.__vcpSettingsOps)) {
                newSettings = this.applyPathOperations(currentSettings, updater.__vcpSettingsOps);
            } else {
                newSettings = { ...this.defaultSettings, ...currentSettings, ...this.mergePatch(currentSettings, updater) };
            }

            await this.writeSettings(newSettings);

            resolve({ success: true, status: 'success', operationId: options.operationId, currentRevision: this.getRevision(newSettings), settings: newSettings });
        } catch (error) {
            if (error?.code === 'SETTINGS_CONFLICT') {
                resolve({ success: false, status: 'conflict', code: error.code, operationId: error.operationId, expectedRevision: error.expectedRevision, currentRevision: error.currentRevision, error: error.message });
            } else reject(error);
        } finally {
            await this.releaseLock(lockToken);
            this.processing = false;

            // 继续处理队列
            if (this.queue.length > 0) {
                setImmediate(() => this.processQueue());
            }
        }
    }

    getRevision(settings) {
        const stable = value => {
            if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
            if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
            return JSON.stringify(value);
        };
        return crypto.createHash('sha256').update(stable(settings || {})).digest('hex');
    }

    mergePatch(current, patch) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
        const merge = (base, next) => {
            if (!next || typeof next !== 'object' || Array.isArray(next)) return next;
            const output = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
            for (const [key, value] of Object.entries(next)) output[key] = value && typeof value === 'object' && !Array.isArray(value)
                ? merge(output[key], value)
                : value;
            return output;
        };
        return merge(current, patch);
    }

    applyPathOperations(current, operations) {
        const next = JSON.parse(JSON.stringify(current || {}));
        for (const operation of operations || []) {
            if (!operation || !Array.isArray(operation.path) || operation.path.some(part => typeof part !== 'string')) {
                throw new TypeError('Invalid settings path operation');
            }
            let target = next;
            const path = operation.path;
            for (const part of path.slice(0, -1)) {
                if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) target[part] = {};
                target = target[part];
            }
            const leaf = path[path.length - 1];
            if (operation.op === 'unset') {
                if (path.length) delete target[leaf];
            } else if (operation.op === 'set') {
                if (!path.length) throw new TypeError('Root settings path cannot be set');
                target[leaf] = operation.value;
            } else throw new TypeError(`Unknown settings path operation: ${operation.op}`);
        }
        return { ...this.defaultSettings, ...next };
    }

    // 定期清理过期的锁文件
    startCleanupTimer() {
        setInterval(async () => {
            if (await fs.pathExists(this.lockFile)) {
                try {
                    const lockContent = await fs.readFile(this.lockFile, 'utf8');
                    const [pid, timestamp] = lockContent.split('-');

                    // Lock age cannot distinguish a crashed owner from a live
                    // writer paused by the OS. Never remove another owner\'s
                    // lock here; recovery is operator-driven.
                    void pid;
                    void timestamp;
                } catch (error) {
                    console.error('Error checking lock file:', error);
                }
            }
        }, 30000); // 每30秒检查一次
    }

    // 自动备份机制
    startAutoBackup(userDataDir) {
        setInterval(async () => {
            try {
                if (await fs.pathExists(this.settingsPath)) {
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const backupDir = path.join(userDataDir, 'backups');
                    await fs.ensureDir(backupDir);

                    const backupPath = path.join(backupDir, `settings-${timestamp}.json`);
                    await fs.copy(this.settingsPath, backupPath);

                    // 只保留最近7天的备份
                    const files = await fs.readdir(backupDir);
                    const backupFiles = files.filter(f => f.startsWith('settings-'));
                    if (backupFiles.length > 7) {
                        backupFiles.sort((a, b) => b.localeCompare(a)); // 降序，最新在前
                        for (let i = 7; i < backupFiles.length; i++) {
                            await fs.remove(path.join(backupDir, backupFiles[i]));
                        }
                    }
                }
            } catch (error) {
                console.error('Auto backup failed:', error);
            }
        }, 24 * 60 * 60 * 1000); // 每天备份一次
    }

    // 清理缓存
    clearCache() {
        this.cache = null;
        this.cacheTimestamp = 0;
    }

    // 强制刷新缓存
    async refreshCache() {
        this.clearCache();
        return await this.readSettings();
    }
}
module.exports = SettingsManager;
