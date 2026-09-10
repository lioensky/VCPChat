// modules/utils/agentConfigManager.js
const fs = require('fs-extra');
const path = require('path');
const { EventEmitter } = require('events');
const crypto = require('crypto');

class AgentConfigManager extends EventEmitter {
    constructor(agentDir) {
        super();
        this.agentDir = agentDir;
        this.queues = new Map(); // 每个agent一个队列
        this.processing = new Map(); // 每个agent的处理状态
        this.locks = new Map(); // 每个agent的锁文件路径
        this.caches = new Map(); // 每个agent的缓存
        this.cacheTimestamps = new Map(); // 每个agent的缓存时间戳
    }

    normalizeId(agentId) {
        if (!agentId) return agentId;
        // 在 Linux 等大小写敏感的系统上，必须保持原始大小写以匹配目录名。
        // 在 Windows 上，原本强制转小写是为了避免同一目录因大小写差异产生多个锁/缓存。
        // 为了兼容多系统，我们仅在 Windows 系统上保持强制转换。
        if (process.platform === 'win32') {
            return agentId.toLowerCase();
        }
        return agentId;
    }

    getAgentPaths(agentId) {
        const id = this.normalizeId(agentId);
        const agentPath = path.join(this.agentDir, id);
        const configPath = path.join(agentPath, 'config.json');
        const lockFile = configPath + '.lock';
        return { agentPath, configPath, lockFile };
    }

    async acquireLock(agentId, timeout = 5000) {
        const id = this.normalizeId(agentId);
        const { lockFile } = this.getAgentPaths(id);
        const startTime = Date.now();
        const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(12).toString('hex')}`;

        while (true) {
            try {
                // 使用 'wx' 标志进行原子性写入，如果文件已存在则会抛出错误
                await fs.writeFile(lockFile, token, { flag: 'wx' });
                return token;
            } catch (error) {
                if (error.code === 'EEXIST') {
                    // 锁文件已存在，检查是否超时
                    if (Date.now() - startTime > timeout) {
                        const busy = new Error(`Agent ${id} configuration is locked; retry after the writer exits`);
                        busy.code = 'AGENT_CONFIG_LOCK_BUSY';
                        throw busy;
                    } else {
                        // 等待一段时间后重试
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                } else {
                    // 其他错误
                    throw error;
                }
            }
        }
    }
    async releaseLock(agentId, token) {
        if (!token) return;
        const id = this.normalizeId(agentId);
        const { lockFile } = this.getAgentPaths(id);
        const current = await fs.readFile(lockFile, 'utf8').catch(() => null);
        if (current === token) await fs.remove(lockFile);
    }

    async readAgentConfig(agentId, { allowDefault = false, retryCount = 0, fresh = false } = {}) {
        const id = this.normalizeId(agentId);
        const { configPath } = this.getAgentPaths(id);

        try {
            // 使用缓存机制减少文件读取
            const stats = await fs.stat(configPath).catch(() => null);
            const cacheKey = id;
            const cachedConfig = this.caches.get(cacheKey);
            const cacheTimestamp = this.cacheTimestamps.get(cacheKey) || 0;

            if (!fresh && stats && cachedConfig && stats.mtimeMs === cacheTimestamp) {
                return structuredClone(cachedConfig);
            }

            const content = await fs.readFile(configPath, 'utf8');
            if (!content.trim()) {
                throw new Error('CONFIG_EMPTY');
            }
            const config = JSON.parse(content);
            if (!config || typeof config !== 'object' || Array.isArray(config)) {
                throw new Error('CONFIG_INVALID_OBJECT');
            }

            // 更新缓存
            this.caches.set(cacheKey, config);
            this.cacheTimestamps.set(cacheKey, stats ? stats.mtimeMs : Date.now());

            return structuredClone(config);
        } catch (error) {
            const isTransient = error.code === 'ENOENT' || error instanceof SyntaxError || error.message === 'CONFIG_EMPTY';
            if (isTransient && retryCount < 3) {
                // 文件可能正处于原子性替换（fs.move）或 非原子写入（fs.writeFile）过程中的瞬间
                const retryDelays = [100, 200, 500];
                const delay = retryDelays[retryCount];
                
                await new Promise(resolve => setTimeout(resolve, delay));
                console.warn(`Agent ${id} config read failed (${error.message || error.code}), retrying (${retryCount + 1}/3)...`);
                return await this.readAgentConfig(id, { allowDefault, retryCount: retryCount + 1, fresh });
            }

            // Writers must fail closed. Recovery candidates are for reading or
            // explicit recovery, never a silent base for overwriting the disk.
            if (fresh) {
                const failure = new Error(`Cannot update agent ${id}: fresh config read failed: ${error.message}`);
                failure.code = 'AGENT_CONFIG_READ_FAILED';
                throw failure;
            }

            // 如果读取失败，按优先级尝试恢复：缓存 > 备份 > 默认配置（如果允许）
            const cachedConfig = this.caches.get(id);

            // 1. 尝试从缓存恢复
            if (cachedConfig) {
                console.warn(`Agent ${id} config read failed, using cached data`);
                return structuredClone(cachedConfig);
            }

            // 2. 尝试从备份恢复
            const backupPath = configPath + '.backup';
            if (await fs.pathExists(backupPath)) {
                try {
                    const backupContent = await fs.readFile(backupPath, 'utf8');
                    const backupConfig = JSON.parse(backupContent);

                    // 只要备份有效且看起来不是完全空的（ID匹配即可视为有效）
                    if (backupConfig && (backupConfig.id === id || backupConfig.name)) {
                        console.log(`Recovered agent ${id} config from backup`);
                        // 恢复后存入缓存
                        this.caches.set(id, backupConfig);
                        return structuredClone(backupConfig);
                    }
                } catch (backupError) {
                    console.error(`Agent ${id} backup recovery failed:`, backupError);
                }
            }

            // 3. 仅在缺失文件且允许时返回默认配置
            if (error.code === 'ENOENT' && allowDefault) {
                const defaultConfig = {
                    name: id,
                    systemPrompt: `你是 ${id}。`,
                    model: 'gemini-2.0-flash-exp',
                    temperature: 0.7,
                    contextTokenLimit: 1000000,
                    maxOutputTokens: 60000,
                    topics: [{ id: "default", name: "主要对话", createdAt: Date.now() }]
                };
                console.warn(`Agent ${id} config not found, returning default config (allowDefault=true)`);
                return { ...defaultConfig };
            }

            // 4. 全部失败，抛出错误
            const errorMessage = error.code === 'ENOENT' 
                ? `Agent config for ${id} not found and no cache/backup available`
                : `Agent config for ${id} corrupted and recovery failed: ${error.message}`;
            
            console.error(`[AgentConfigManager] ${errorMessage}`);
            throw new Error(errorMessage);
        }
    }

    async preserveConfigVersion(configPath) {
        let content;
        try {
            content = await fs.readFile(configPath);
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        // Preserve exact bytes, including damaged files useful for recovery.
        // Content addressing deduplicates unchanged snapshots without deleting
        // older recovery points during a burst of erroneous saves.
        const digest = crypto.createHash('sha256').update(content).digest('hex');
        const directory = configPath + '.versions';
        await fs.ensureDir(directory);
        const versionPath = path.join(directory, `${digest}.json`);
        try {
            await fs.writeFile(versionPath, content, { flag: 'wx' });
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const existing = await fs.readFile(versionPath);
            if (!existing.equals(content)) {
                throw new Error('Agent configuration recovery point verification failed');
            }
        }
    }

    async writeAgentConfig(agentId, config) {
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            throw new TypeError('Agent configuration must be a non-null object');
        }
        // Freeze the caller's values before asynchronous filesystem work.
        config = structuredClone(config);
        const id = this.normalizeId(agentId);
        const { agentPath, configPath } = this.getAgentPaths(id);
        const tempFile = `${configPath}.${crypto.randomBytes(12).toString('hex')}.tmp`;
        const backupFile = configPath + '.backup';

        try {
            // 确保agent目录存在
            await fs.ensureDir(agentPath);

            // 写入临时文件
            await fs.writeJson(tempFile, config, { spaces: 2 });

            // 验证临时文件
            const verifyContent = await fs.readFile(tempFile, 'utf8');
            const verifiedConfig = JSON.parse(verifyContent);
            if (!verifiedConfig || typeof verifiedConfig !== 'object' || Array.isArray(verifiedConfig)) {
                throw new TypeError('Serialized Agent configuration must be an object');
            }
            // Cache and revision acknowledgements must describe the JSON that
            // actually reaches disk, including JSON's omission of undefined.
            config = verifiedConfig;

            // A failed recovery-point write aborts the update. Preserve the
            // existing compatibility backup too, before replacing its slot.
            await this.preserveConfigVersion(backupFile);
            await this.preserveConfigVersion(configPath);
            if (await fs.pathExists(configPath)) {
                await fs.copy(configPath, backupFile, { overwrite: true });
            }

            // Same-directory rename replaces the destination without an
            // explicit unlink. If the OS refuses replacement, fail closed;
            // never delete the original file to make the operation succeed.
            await fs.rename(tempFile, configPath);

            // 更新缓存（使用实际文件的修改时间，而非 Date.now()，确保与 readAgentConfig 的 stat 比较一致）
            const newStats = await fs.stat(configPath).catch(() => null);
            this.caches.set(id, structuredClone(config));
            this.cacheTimestamps.set(id, newStats ? newStats.mtimeMs : Date.now());

            // 触发更新事件
            this.emit('agent-config-updated', id, config);

            return true;
        } catch (error) {
            console.error(`Error writing agent ${id} config:`, error);

            // 清理临时文件
            await fs.remove(tempFile).catch(() => { });

            throw error;
        }
    }

    getRevision(config) {
        const stable = value => {
            if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
            if (value && typeof value === 'object') {
                return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
            }
            return JSON.stringify(value);
        };
        return crypto.createHash('sha256').update(stable(config)).digest('hex');
    }

    async updateAgentConfig(agentId, updater, options = {}) {
        const id = this.normalizeId(agentId);
        return new Promise((resolve, reject) => {
            // 为每个agent维护独立的队列
            if (!this.queues.has(id)) {
                this.queues.set(id, []);
            }

            this.queues.get(id).push({
                updater: typeof updater === 'function' ? updater : structuredClone(updater),
                options: { ...options },
                resolve,
                reject
            });
            this.processQueue(id);
        });
    }

    async processQueue(agentId) {
        const queue = this.queues.get(agentId);
        if (!queue || this.processing.get(agentId) || queue.length === 0) {
            return;
        }

        this.processing.set(agentId, true);
        const { updater, resolve, reject, options = {} } = queue.shift();
        let lockToken;

        try {
            lockToken = await this.acquireLock(agentId);

            const currentConfig = await this.readAgentConfig(agentId, { fresh: true });
            const currentRevision = this.getRevision(currentConfig);
            if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
                const conflict = new Error('Agent configuration changed since it was loaded; local draft retained');
                conflict.code = 'AGENT_CONFIG_CONFLICT';
                conflict.expectedRevision = options.expectedRevision;
                conflict.currentRevision = currentRevision;
                conflict.operationId = options.operationId;
                throw conflict;
            }
            const proposedConfig = typeof updater === 'function'
                ? await updater(currentConfig)
                : { ...currentConfig, ...updater };
            if (!proposedConfig || typeof proposedConfig !== 'object' || Array.isArray(proposedConfig)) {
                throw new TypeError('Agent config updater must produce an object');
            }
            const newConfig = JSON.parse(JSON.stringify(proposedConfig));

            await this.writeAgentConfig(agentId, newConfig);

            resolve({
                success: true,
                status: 'success',
                operationId: options.operationId,
                currentRevision: this.getRevision(newConfig),
                config: structuredClone(newConfig)
            });
        } catch (error) {
            reject(error);
        } finally {
            await this.releaseLock(agentId, lockToken).catch(error => {
                console.error('Failed to release Agent configuration lock:', error);
            });
            this.processing.set(agentId, false);

            // 继续处理队列
            if (queue.length > 0) {
                setImmediate(() => this.processQueue(agentId));
            }
        }
    }

    // 定期清理过期的锁文件
    startCleanupTimer() {
        setInterval(async () => {
            for (const [agentId] of this.queues) {
                const { lockFile } = this.getAgentPaths(agentId);
                if (await fs.pathExists(lockFile)) {
                    try {
                        const lockContent = await fs.readFile(lockFile, 'utf8');
                        const [pid, timestamp] = lockContent.split('-');

                        // 超过10秒只告警，不凭年龄判定锁已失效。
                        if (Date.now() - parseInt(timestamp) > 10000) {
                            // Age does not prove that the writer has stopped.
                            // Leave recovery to an explicit offline action.
                            console.warn(`Agent ${agentId} has a long-held configuration lock (owner ${pid}); preserving it`);
                        }
                    } catch (error) {
                        console.error(`Error checking lock file for agent ${agentId}:`, error);
                    }
                }
            }
        }, 30000); // 每30秒检查一次
    }

    // 清理指定agent的缓存
    clearCache(agentId) {
        const id = this.normalizeId(agentId);
        this.caches.delete(id);
        this.cacheTimestamps.delete(id);
    }

    // 清理所有缓存
    clearAllCaches() {
        this.caches.clear();
        this.cacheTimestamps.clear();
    }
}

module.exports = AgentConfigManager;