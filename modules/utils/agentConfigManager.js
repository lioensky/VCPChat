// modules/utils/agentConfigManager.js
const fs = require('fs-extra');
const path = require('path');
const { EventEmitter } = require('events');

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
        return agentId ? agentId.toLowerCase() : agentId;
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

        while (true) {
            try {
                // 使用 'wx' 标志进行原子性写入，如果文件已存在则会抛出错误
                await fs.writeFile(lockFile, `${process.pid}-${Date.now()}`, { flag: 'wx' });
                return; // 成功获取锁
            } catch (error) {
                if (error.code === 'EEXIST') {
                    // 锁文件已存在，检查是否超时
                    if (Date.now() - startTime > timeout) {
                        console.warn(`Agent ${id} lock acquisition timeout, removing stale lock`);
                        await fs.remove(lockFile).catch(() => { });
                        // 继续循环尝试重新创建
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

    async releaseLock(agentId) {
        const id = this.normalizeId(agentId);
        const { lockFile } = this.getAgentPaths(id);
        await fs.remove(lockFile).catch(() => { });
    }

    async readAgentConfig(agentId, { allowDefault = false, retryCount = 0 } = {}) {
        const id = this.normalizeId(agentId);
        const { configPath } = this.getAgentPaths(id);

        try {
            // 使用缓存机制减少文件读取
            const stats = await fs.stat(configPath).catch(() => null);
            const cacheKey = id;
            const cachedConfig = this.caches.get(cacheKey);
            const cacheTimestamp = this.cacheTimestamps.get(cacheKey) || 0;

            if (stats && cachedConfig && stats.mtimeMs <= cacheTimestamp) {
                return { ...cachedConfig };
            }

            const content = await fs.readFile(configPath, 'utf8');
            if (!content.trim()) {
                throw new Error('CONFIG_EMPTY');
            }
            const config = JSON.parse(content);

            // 更新缓存
            this.caches.set(cacheKey, config);
            this.cacheTimestamps.set(cacheKey, stats ? stats.mtimeMs : Date.now());

            return { ...config };
        } catch (error) {
            const isTransient = error.code === 'ENOENT' || error instanceof SyntaxError || error.message === 'CONFIG_EMPTY';
            if (isTransient && retryCount < 3) {
                // 文件可能正处于原子性替换（fs.move）或 非原子写入（fs.writeFile）过程中的瞬间
                const retryDelays = [100, 200, 500];
                const delay = retryDelays[retryCount];
                
                await new Promise(resolve => setTimeout(resolve, delay));
                console.warn(`Agent ${id} config read failed (${error.message || error.code}), retrying (${retryCount + 1}/3)...`);
                return await this.readAgentConfig(id, { allowDefault, retryCount: retryCount + 1 });
            }

            if (error.code === 'ENOENT') {
                // 所有重试都失败后，优先返回缓存数据
                const cachedConfig = this.caches.get(id);
                if (cachedConfig) {
                    console.warn(`Agent ${id} config file not found after retries, using cached data`);
                    return { ...cachedConfig };
                }

                // 仅在明确允许的场景（如新建Agent）才返回默认配置
                if (allowDefault) {
                    const defaultConfig = {
                        name: id,
                        systemPrompt: `你是 ${id}。`,
                        model: 'gemini-2.0-flash-exp',
                        temperature: 0.7,
                        contextTokenLimit: 1000000,
                        maxOutputTokens: 60000,
                        topics: [{ id: "default", name: "主要对话", createdAt: Date.now() }]
                    };
                    return { ...defaultConfig };
                }

                // 严禁悄悄返回默认配置，抛出错误以防止覆盖用户数据
                throw new Error(`Agent config for ${id} not found after retries and no cache available`);
            }

            console.error(`Error reading agent ${agentId} config, attempting recovery:`, error);

            // 尝试从备份恢复
            const backupPath = configPath + '.backup';
            if (await fs.pathExists(backupPath)) {
                try {
                    const backupContent = await fs.readFile(backupPath, 'utf8');
                    const backupConfig = JSON.parse(backupContent);

                    // 验证备份数据是否有效且包含用户自定义数据（例如非默认的 systemPrompt 或 topics）
                    const isNonDefault = backupConfig && (
                        (Array.isArray(backupConfig.topics) && backupConfig.topics.length > 0 && backupConfig.topics[0].id !== 'default') ||
                        (backupConfig.systemPrompt && !backupConfig.systemPrompt.includes(`你是 ${agentId}`)) ||
                        backupConfig.model
                    );

                    if (isNonDefault) {
                        console.log(`Recovered agent ${agentId} config from valid backup`);
                        return { ...backupConfig };
                    } else {
                        console.warn(`Agent ${agentId} backup exists but appears to be default or empty, skipping recovery to prevent overwrite`);
                    }
                } catch (backupError) {
                    console.error(`Agent ${agentId} backup also corrupted:`, backupError);
                }
            }

            // 最后尝试缓存
            const cachedConfig = this.caches.get(agentId);
            if (cachedConfig) {
                console.warn(`Agent ${agentId} config corrupted, falling back to cached data`);
                return { ...cachedConfig };
            }

            // 如果主文件损坏且没有有效的备份，抛出错误以防止覆盖
            throw new Error(`Agent config for ${agentId} corrupted and no valid backup found: ${error.message}`);
        }
    }

    async writeAgentConfig(agentId, config) {
        const id = this.normalizeId(agentId);
        const { agentPath, configPath } = this.getAgentPaths(id);
        const tempFile = configPath + '.tmp';
        const backupFile = configPath + '.backup';

        try {
            // 确保agent目录存在
            await fs.ensureDir(agentPath);

            // 写入临时文件
            await fs.writeJson(tempFile, config, { spaces: 2 });

            // 验证临时文件
            const verifyContent = await fs.readFile(tempFile, 'utf8');
            JSON.parse(verifyContent);

            // 创建备份（如果原文件存在）
            if (await fs.pathExists(configPath)) {
                await fs.copy(configPath, backupFile, { overwrite: true });
            }

            // 原子性替换
            await fs.move(tempFile, configPath, { overwrite: true });

            // 更新缓存（使用实际文件的修改时间，而非 Date.now()，确保与 readAgentConfig 的 stat 比较一致）
            const newStats = await fs.stat(configPath).catch(() => null);
            this.caches.set(id, { ...config });
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

    async updateAgentConfig(agentId, updater) {
        const id = this.normalizeId(agentId);
        return new Promise((resolve, reject) => {
            // 为每个agent维护独立的队列
            if (!this.queues.has(id)) {
                this.queues.set(id, []);
            }

            this.queues.get(id).push({ updater, resolve, reject });
            this.processQueue(id);
        });
    }

    async processQueue(agentId) {
        const queue = this.queues.get(agentId);
        if (!queue || this.processing.get(agentId) || queue.length === 0) {
            return;
        }

        this.processing.set(agentId, true);
        const { updater, resolve, reject } = queue.shift();

        try {
            await this.acquireLock(agentId);

            const currentConfig = await this.readAgentConfig(agentId);
            const newConfig = typeof updater === 'function'
                ? await updater(currentConfig)
                : { ...currentConfig, ...updater };

            await this.writeAgentConfig(agentId, newConfig);

            resolve({ success: true, config: newConfig });
        } catch (error) {
            reject(error);
        } finally {
            await this.releaseLock(agentId);
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

                        // 如果锁文件超过10秒，认为是过期的
                        if (Date.now() - parseInt(timestamp) > 10000) {
                            console.log(`Removing stale lock file for agent ${agentId}`);
                            await fs.remove(lockFile);
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