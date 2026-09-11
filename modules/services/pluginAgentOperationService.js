const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const PROMPT_COMMANDS = new Set([
    'GetPromptMode',
    'SetPromptMode',
    'GetActivePrompt',
    'SetOriginalPrompt',
    'GetModularBlocks',
    'AddBlock',
    'UpdateBlock',
    'DeleteBlock',
    'MoveBlock',
    'AddVariant',
    'UpdateVariant',
    'DeleteVariant',
    'SelectVariant',
    'HideBlock',
    'RestoreBlock',
    'GetWarehouses',
    'CreateWarehouse',
    'RenameWarehouse',
    'DeleteWarehouse',
    'ListPresets',
    'SetPreset',
    'SetPresetContent',
]);

const TOPIC_COMMANDS = new Set([
    'CreateTopic',
    'CreateFlowlockTopic',
    'ReadUnlockedTopics',
    'CheckNewTopics',
    'CheckUnreadMessages',
    'ReplyToTopic',
    'CheckTopicOwnership',
    'ListUnlockedTopics',
    'ReadTopicContent',
]);

function validateId(value, label = 'identifier') {
    if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`${label} 不能为空。`);
    }
    const normalized = value.trim();
    if (
        /[<>:"/\\|?*\x00-\x1f]/.test(normalized)
        || normalized === '.'
        || normalized === '..'
        || /[. ]$/.test(normalized)
    ) {
        throw new TypeError(`${label} 非法。`);
    }
    return normalized;
}

function clone(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function blockText(block) {
    if (!block || block.disabled) return '';
    if (block.type === 'newline') return '\n';
    const selected = Number.isInteger(block.selectedVariant) ? block.selectedVariant : 0;
    return Array.isArray(block.variants)
        ? (block.variants[selected] ?? block.content ?? '')
        : (block.content ?? '');
}

function activePrompt(config, mode = config?.promptMode || 'original') {
    if (mode === 'original') {
        return config?.originalSystemPrompt ?? config?.systemPrompt ?? '';
    }
    if (mode === 'preset') {
        return config?.presetSystemPrompt ?? '';
    }
    if (mode === 'modular') {
        if (typeof config?.advancedSystemPrompt === 'string') {
            return config.advancedSystemPrompt;
        }
        return (config?.advancedSystemPrompt?.blocks || []).map(blockText).join('');
    }
    throw new TypeError(`未知提示词模式: ${mode}`);
}

function ensurePromptState(config) {
    const state = config.advancedSystemPrompt;
    if (state && typeof state === 'object' && !Array.isArray(state)) {
        return {
            ...state,
            blocks: Array.isArray(state.blocks) ? clone(state.blocks) : [],
            hiddenBlocks: state.hiddenBlocks && typeof state.hiddenBlocks === 'object'
                ? clone(state.hiddenBlocks)
                : { default: [] },
            warehouseOrder: Array.isArray(state.warehouseOrder)
                ? [...state.warehouseOrder]
                : ['default'],
        };
    }
    return {
        blocks: typeof state === 'string' && state
            ? [{ id: `block_${crypto.randomUUID()}`, type: 'text', content: state, disabled: false }]
            : [],
        hiddenBlocks: { default: [] },
        warehouseOrder: ['default'],
    };
}

function pluginMessage(agent, content, senderName, metadata = {}) {
    const timestamp = Date.now();
    return {
        role: 'assistant',
        name: senderName,
        content,
        timestamp,
        id: `msg_${timestamp}_assistant_${crypto.randomUUID()}`,
        isThinking: false,
        avatarUrl: agent.avatarUrl || null,
        avatarColor: agent.avatarColor || 'rgb(96,106,116)',
        isGroupMessage: false,
        agentId: agent.id,
        finishReason: 'completed',
        _metadata: {
            createdBy: 'plugin',
            createdAt: timestamp,
            ...metadata,
        },
    };
}

class PluginAgentOperationService {
    constructor({
        agentDir,
        userDataDir,
        agentConfigManager,
        historyMutationQueue,
        appDataRoot,
        logger = console,
        idempotencyTtlMs = 10 * 60 * 1000,
    } = {}) {
        if (!agentDir || !userDataDir || !agentConfigManager || !historyMutationQueue) {
            throw new TypeError('PluginAgentOperationService 缺少必需依赖。');
        }
        this.agentDir = agentDir;
        this.userDataDir = userDataDir;
        this.agentConfigManager = agentConfigManager;
        this.historyMutationQueue = historyMutationQueue;
        this.appDataRoot = appDataRoot || path.dirname(agentDir);
        this.logger = logger;
        this.idempotencyTtlMs = idempotencyTtlMs;
        this.completedRequests = new Map();
        this.runningRequests = new Map();
    }

    assertCommand(domain, command) {
        const allowlist = domain === 'prompt' ? PROMPT_COMMANDS : TOPIC_COMMANDS;
        if (!allowlist.has(command)) {
            throw new Error(`插件命令不在白名单中: ${command}`);
        }
    }

    cleanupIdempotency(now = Date.now()) {
        for (const [key, entry] of this.completedRequests) {
            if (now - entry.completedAt > this.idempotencyTtlMs) {
                this.completedRequests.delete(key);
            }
        }
    }

    runIdempotent(domain, command, requestId, operation) {
        if (!requestId) return operation();
        this.cleanupIdempotency();
        const key = `${domain}:${command}:${requestId}`;
        if (this.completedRequests.has(key)) {
            return Promise.resolve(clone(this.completedRequests.get(key).result));
        }
        if (this.runningRequests.has(key)) return this.runningRequests.get(key);
        const promise = Promise.resolve()
            .then(operation)
            .then(result => {
                this.completedRequests.set(key, { completedAt: Date.now(), result: clone(result) });
                return result;
            })
            .finally(() => this.runningRequests.delete(key));
        this.runningRequests.set(key, promise);
        return promise;
    }

    async findAgent(query) {
        const requested = validateId(query, 'Agent');
        const folders = await fs.readdir(this.agentDir, { withFileTypes: true });
        const exactFolder = folders.find(entry => entry.isDirectory() && entry.name === requested);
        if (exactFolder) {
            const config = await this.agentConfigManager.readAgentConfig(exactFolder.name);
            return { ...config, id: exactFolder.name };
        }

        const matches = [];
        for (const entry of folders) {
            if (!entry.isDirectory()) continue;
            try {
                const config = await this.agentConfigManager.readAgentConfig(entry.name);
                if (typeof config.name === 'string' && config.name.includes(requested)) {
                    matches.push({ ...config, id: entry.name });
                }
            } catch (error) {
                this.logger.warn?.(`[PluginAgentOperationService] 跳过无效 Agent ${entry.name}: ${error.message}`);
            }
        }
        if (matches.length === 0) throw new Error(`未找到 Agent: ${requested}`);
        if (matches.length > 1) throw new Error(`Agent 名称匹配不唯一: ${requested}`);
        return matches[0];
    }

    async readAgent(agentId) {
        const id = validateId(agentId, 'agentId');
        const config = await this.agentConfigManager.readAgentConfig(id);
        return { ...config, id };
    }

    async updateAgent(agentId, updater) {
        const id = validateId(agentId, 'agentId');
        let operationResult;
        const update = await this.agentConfigManager.updateAgentConfig(id, current => {
            const next = updater(clone(current));
            if (!next || typeof next.config !== 'object') {
                throw new Error('插件配置操作未返回有效配置。');
            }
            operationResult = next.result;
            return next.config;
        });
        return { result: operationResult, config: update.config };
    }

    /**
     * MobileSync 专用 Agent Owner 配置提交。
     * 只接受已由同步 DTO 层筛选出的字段，并在锁内重新读取最新配置；
     * 绝不接收任意 updater，避免同步边界绕过插件配置约束。
     */
    async applySyncedAgentOwner(agentId, dto) {
        const allowedFields = new Set([
            'name',
            'systemPrompt',
            'model',
            'temperature',
            'contextTokenLimit',
            'maxOutputTokens',
            'streamOutput',
        ]);
        if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
            throw new TypeError('同步 Agent Owner DTO 无效。');
        }
        const patch = {};
        for (const field of allowedFields) {
            if (dto[field] !== undefined) patch[field] = dto[field];
        }
        const updated = await this.updateAgent(agentId, config => ({
            config: { ...config, ...patch },
            result: { fields: Object.keys(patch) },
        }));
        return updated.config;
    }

    /**
     * MobileSync 专用 Agent Topic 提交。
     * 在同一个 AgentConfigManager 队列事务内按 Topic ID upsert，保留
     * 同步期间由后台 Agent/TopicSponsor 创建的其他 Topic。
     */
    async applySyncedAgentTopics(agentId, topicDtos) {
        const id = validateId(agentId, 'agentId');
        if (!Array.isArray(topicDtos)) {
            throw new TypeError('同步 Agent Topic DTO 必须是数组。');
        }
        const updated = await this.updateAgent(id, config => {
            const topics = Array.isArray(config.topics) ? [...config.topics] : [];
            const byId = new Map(topics.map(topic => [topic?.id, topic]));
            for (const dto of topicDtos) {
                if (!dto || typeof dto !== 'object' || Array.isArray(dto)
                    || dto.ownerId !== id
                    || typeof dto.id !== 'string'
                    || !dto.id.trim()
                    || typeof dto.name !== 'string'
                    || !Number.isSafeInteger(dto.createdAt)
                    || (dto.locked !== undefined && typeof dto.locked !== 'boolean')
                    || (dto.unread !== undefined && typeof dto.unread !== 'boolean')) {
                    throw new TypeError('同步 Agent Topic DTO 无效。');
                }
                const previous = byId.get(dto.id);
                const next = {
                    ...(previous || {}),
                    id: dto.id,
                    name: dto.name,
                    createdAt: dto.createdAt,
                    locked: dto.locked ?? previous?.locked ?? true,
                    unread: dto.unread ?? previous?.unread ?? false,
                    creatorSource: previous?.creatorSource ?? 'ui',
                };
                byId.set(dto.id, next);
            }
            const nextTopics = [...byId.values()]
                .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
            return {
                config: { ...config, topics: nextTopics },
                result: { topicIds: topicDtos.map(dto => dto.id) },
            };
        });
        return updated.config;
    }

    async processToolCall(toolName, args = {}, executionContext = {}) {
        if (toolName === 'PromptSponsor') {
            return this.processPromptCommand(args, executionContext);
        }
        if (toolName === 'TopicSponsor') {
            return this.processTopicCommand(args, executionContext);
        }
        throw new Error(`未注册的插件委托目标: ${toolName}`);
    }

    async processPromptCommand(args = {}, executionContext = {}) {
        const command = args.command;
        this.assertCommand('prompt', command);
        const requestId = executionContext.requestId || executionContext.vcpContext?.requestId;
        const mutating = !['GetPromptMode', 'GetActivePrompt', 'GetModularBlocks', 'GetWarehouses', 'ListPresets'].includes(command);
        const execute = () => this.executePromptCommand(command, args);
        return mutating
            ? this.runIdempotent('prompt', command, requestId, execute)
            : execute();
    }

    async executePromptCommand(command, args) {
        const agentId = validateId(args.agentId, 'agentId');
        if (command === 'GetPromptMode') {
            const config = await this.readAgent(agentId);
            return {
                agentId,
                mode: config.promptMode || 'original',
                availableModes: ['original', 'modular', 'preset'],
            };
        }
        if (command === 'GetActivePrompt') {
            const config = await this.readAgent(agentId);
            const mode = config.promptMode || 'original';
            const systemPrompt = activePrompt(config, mode);
            return { agentId, mode, systemPrompt, length: systemPrompt.length };
        }
        if (command === 'ListPresets') return this.listPresets(agentId);
        if (command === 'SetPreset') {
            if (typeof args.presetPath !== 'string' || !args.presetPath.trim()) {
                throw new TypeError('presetPath 不能为空。');
            }
            const presetPath = path.resolve(args.presetPath);
            const extension = path.extname(presetPath).toLowerCase();
            if (!['.md', '.txt'].includes(extension)) {
                throw new TypeError('预设文件仅支持 .md 或 .txt。');
            }
            const stats = await fs.stat(presetPath);
            if (!stats.isFile()) throw new TypeError('presetPath 不是文件。');
            const content = await fs.readFile(presetPath, 'utf8');
            const updated = await this.updateAgent(agentId, config => {
                const next = {
                    ...config,
                    presetSystemPrompt: content,
                    selectedPreset: presetPath,
                };
                if (config.promptMode === 'preset') next.systemPrompt = content;
                return {
                    config: next,
                    result: {
                        presetPath,
                        contentLength: content.length,
                    },
                };
            });
            return updated.result;
        }

        if (command === 'GetModularBlocks' || command === 'GetWarehouses') {
            const config = await this.readAgent(agentId);
            const state = ensurePromptState(config);
            if (command === 'GetModularBlocks') {
                return {
                    blocks: state.blocks,
                    totalBlocks: state.blocks.length,
                    enabledBlocks: state.blocks.filter(block => !block.disabled).length,
                };
            }
            return {
                warehouses: Object.fromEntries(state.warehouseOrder.map(name => [
                    name,
                    { name, blocks: state.hiddenBlocks[name] || [], blockCount: (state.hiddenBlocks[name] || []).length },
                ])),
                warehouseOrder: state.warehouseOrder,
                totalWarehouses: state.warehouseOrder.length,
            };
        }

        const updated = await this.updateAgent(agentId, config => {
            if (command === 'SetPromptMode') {
                if (!['original', 'modular', 'preset'].includes(args.mode)) {
                    throw new TypeError(`未知提示词模式: ${args.mode}`);
                }
                const systemPrompt = activePrompt(config, args.mode);
                return {
                    config: { ...config, promptMode: args.mode, systemPrompt },
                    result: { mode: args.mode, systemPrompt },
                };
            }
            if (command === 'SetOriginalPrompt') {
                if (typeof args.content !== 'string') throw new TypeError('content 必须是字符串。');
                const next = { ...config, originalSystemPrompt: args.content };
                if ((config.promptMode || 'original') === 'original') next.systemPrompt = args.content;
                return { config: next, result: { length: args.content.length } };
            }
            if (command === 'SetPresetContent') {
                if (typeof args.content !== 'string') throw new TypeError('content 必须是字符串。');
                const next = { ...config, presetSystemPrompt: args.content, selectedPreset: '' };
                if (config.promptMode === 'preset') next.systemPrompt = args.content;
                return { config: next, result: { contentLength: args.content.length } };
            }

            const state = ensurePromptState(config);
            let result;
            const blockId = typeof args.blockId === 'string' ? args.blockId : '';
            const blockIndex = state.blocks.findIndex(block => block.id === blockId);

            if (command === 'AddBlock') {
                if (!['text', 'newline'].includes(args.type)) throw new TypeError('积木类型非法。');
                const block = {
                    id: `block_${crypto.randomUUID()}`,
                    type: args.type,
                    content: typeof args.content === 'string' ? args.content : '',
                    name: typeof args.name === 'string' ? args.name : '',
                    disabled: false,
                };
                if (block.type === 'text' && block.content) {
                    block.variants = [block.content];
                    block.selectedVariant = 0;
                }
                const position = Number.parseInt(args.position, 10);
                if (Number.isInteger(position) && position >= 0 && position <= state.blocks.length) {
                    state.blocks.splice(position, 0, block);
                } else {
                    state.blocks.push(block);
                }
                result = { block, totalBlocks: state.blocks.length };
            } else if (['UpdateBlock', 'DeleteBlock', 'MoveBlock', 'AddVariant', 'UpdateVariant',
                'DeleteVariant', 'SelectVariant', 'HideBlock'].includes(command)) {
                if (blockIndex < 0) throw new Error(`未找到积木: ${blockId}`);
                const block = state.blocks[blockIndex];
                if (command === 'UpdateBlock') {
                    if (args.content !== undefined) {
                        block.content = String(args.content);
                        if (Array.isArray(block.variants) && block.variants.length) {
                            block.variants[block.selectedVariant || 0] = block.content;
                        }
                    }
                    if (args.name !== undefined) block.name = String(args.name);
                    if (args.disabled !== undefined) block.disabled = args.disabled === true || args.disabled === 'true';
                    result = { block };
                } else if (command === 'DeleteBlock') {
                    result = { deletedBlock: state.blocks.splice(blockIndex, 1)[0], remainingBlocks: state.blocks.length };
                } else if (command === 'MoveBlock') {
                    const position = Number.parseInt(args.newPosition, 10);
                    if (!Number.isInteger(position) || position < 0 || position >= state.blocks.length) {
                        throw new TypeError('newPosition 非法。');
                    }
                    const [blockToMove] = state.blocks.splice(blockIndex, 1);
                    state.blocks.splice(position, 0, blockToMove);
                    result = { block: blockToMove, newPosition: position };
                } else if (command === 'AddVariant') {
                    if (block.type === 'newline') throw new Error('换行块不支持轮换内容。');
                    if (!Array.isArray(block.variants)) {
                        block.variants = [block.content || ''];
                        block.selectedVariant = 0;
                    }
                    block.variants.push(String(args.content ?? ''));
                    result = { variantIndex: block.variants.length - 1, totalVariants: block.variants.length };
                } else if (['UpdateVariant', 'DeleteVariant', 'SelectVariant'].includes(command)) {
                    const variantIndex = Number.parseInt(args.variantIndex, 10);
                    if (!Array.isArray(block.variants) || !Number.isInteger(variantIndex)
                        || variantIndex < 0 || variantIndex >= block.variants.length) {
                        throw new TypeError('variantIndex 非法。');
                    }
                    if (command === 'UpdateVariant') {
                        block.variants[variantIndex] = String(args.content ?? '');
                    } else if (command === 'DeleteVariant') {
                        if (block.variants.length <= 1) throw new Error('不能删除最后一个轮换内容。');
                        block.variants.splice(variantIndex, 1);
                        if ((block.selectedVariant || 0) >= block.variants.length) {
                            block.selectedVariant = block.variants.length - 1;
                        }
                    } else {
                        block.selectedVariant = variantIndex;
                    }
                    block.content = block.variants[block.selectedVariant || 0] ?? '';
                    result = { variantIndex, selectedVariant: block.selectedVariant || 0, content: block.content };
                } else {
                    const warehouse = validateId(args.warehouse || 'default', 'warehouse');
                    state.hiddenBlocks[warehouse] ||= [];
                    const [hiddenBlock] = state.blocks.splice(blockIndex, 1);
                    state.hiddenBlocks[warehouse].push(hiddenBlock);
                    if (!state.warehouseOrder.includes(warehouse)) state.warehouseOrder.push(warehouse);
                    result = { block: hiddenBlock, warehouse };
                }
            } else if (command === 'RestoreBlock') {
                const warehouse = validateId(args.warehouse, 'warehouse');
                const hidden = state.hiddenBlocks[warehouse];
                const hiddenIndex = Number.parseInt(args.blockIndex, 10);
                if (!Array.isArray(hidden) || !Number.isInteger(hiddenIndex)
                    || hiddenIndex < 0 || hiddenIndex >= hidden.length) {
                    throw new TypeError('仓库或 blockIndex 非法。');
                }
                const [block] = hidden.splice(hiddenIndex, 1);
                block.id = `block_${crypto.randomUUID()}`;
                const position = Number.parseInt(args.position, 10);
                if (Number.isInteger(position) && position >= 0 && position <= state.blocks.length) {
                    state.blocks.splice(position, 0, block);
                } else {
                    state.blocks.push(block);
                }
                result = { block, warehouse };
            } else if (command === 'CreateWarehouse') {
                const name = validateId(args.warehouseName, 'warehouseName');
                if (name === 'default' || state.hiddenBlocks[name]) throw new Error('仓库名称不可用。');
                state.hiddenBlocks[name] = [];
                state.warehouseOrder.push(name);
                result = { warehouseName: name };
            } else if (command === 'RenameWarehouse') {
                const oldName = validateId(args.oldName, 'oldName');
                const newName = validateId(args.newName, 'newName');
                if (oldName === 'default' || newName === 'default'
                    || !state.hiddenBlocks[oldName] || state.hiddenBlocks[newName]) {
                    throw new Error('仓库重命名参数非法。');
                }
                state.hiddenBlocks[newName] = state.hiddenBlocks[oldName];
                delete state.hiddenBlocks[oldName];
                state.warehouseOrder = state.warehouseOrder.map(name => name === oldName ? newName : name);
                result = { oldName, newName };
            } else if (command === 'DeleteWarehouse') {
                const name = validateId(args.warehouseName, 'warehouseName');
                if (name === 'default' || !state.hiddenBlocks[name]) throw new Error('仓库不可删除。');
                const deletedBlockCount = state.hiddenBlocks[name].length;
                delete state.hiddenBlocks[name];
                state.warehouseOrder = state.warehouseOrder.filter(item => item !== name);
                result = { warehouseName: name, deletedBlockCount };
            } else {
                throw new Error(`尚未实现提示词命令: ${command}`);
            }

            const nextConfig = { ...config, advancedSystemPrompt: state };
            if (config.promptMode === 'modular') nextConfig.systemPrompt = activePrompt(nextConfig, 'modular');
            return { config: nextConfig, result };
        });
        return updated.result;
    }

    async listPresets(agentId) {
        const config = await this.readAgent(agentId);
        const configured = config.presetPromptPath || './AppData/systemPromptPresets';
        const absolutePath = path.isAbsolute(configured)
            ? path.resolve(configured)
            : path.resolve(path.dirname(this.appDataRoot), configured.replace(/^\.[/\\]/, ''));
        if (!await fs.pathExists(absolutePath)) {
            return { presets: [], presetPath: absolutePath, totalPresets: 0 };
        }
        const entries = await fs.readdir(absolutePath, { withFileTypes: true });
        const presets = [];
        for (const entry of entries) {
            const extension = path.extname(entry.name).toLowerCase();
            if (!entry.isFile() || !['.md', '.txt'].includes(extension)) continue;
            const filePath = path.join(absolutePath, entry.name);
            const stats = await fs.stat(filePath);
            presets.push({
                name: path.basename(entry.name, extension),
                path: filePath,
                extension,
                size: stats.size,
                modified: stats.mtime.toISOString(),
            });
        }
        presets.sort((a, b) => new Date(b.modified) - new Date(a.modified));
        return { presets, presetPath: absolutePath, totalPresets: presets.length };
    }

    async processTopicCommand(args = {}, executionContext = {}) {
        const command = args.command || args.tool_name;
        this.assertCommand('topic', command);
        const requestId = executionContext.requestId || executionContext.vcpContext?.requestId;
        const mutating = ['CreateTopic', 'CreateFlowlockTopic', 'ReplyToTopic'].includes(command);
        const execute = () => this.executeTopicCommand(command, args, requestId);
        return mutating
            ? this.runIdempotent('topic', command, requestId, execute)
            : execute();
    }

    async executeTopicCommand(command, args, requestId) {
        const agent = await this.findAgent(args.maid);
        const topics = Array.isArray(agent.topics) ? agent.topics : [];

        if (command === 'CreateTopic' || command === 'CreateFlowlockTopic') {
            if (typeof args.topic_name !== 'string' || !args.topic_name.trim()) {
                throw new TypeError('topic_name 不能为空。');
            }
            if (typeof args.initial_message !== 'string' || !args.initial_message) {
                throw new TypeError('initial_message 不能为空。');
            }
            const timestamp = Date.now();
            const topicId = `topic_${timestamp}_${crypto.randomUUID()}`;
            const flowlockRequest = command === 'CreateFlowlockTopic'
                ? {
                    requestId: requestId || crypto.randomUUID(),
                    requestedByAgentId: agent.id,
                    createdAt: timestamp,
                    heartbeatSeconds: Math.max(1, Math.min(86400, Number.parseInt(args.flowlock_heartbeat, 10) || 5)),
                    prompt: typeof args.flowlock_prompt === 'string' ? args.flowlock_prompt.trim() : '',
                    status: 'pending',
                }
                : null;
            const topic = {
                id: topicId,
                name: args.topic_name.trim(),
                createdAt: timestamp,
                locked: false,
                unread: true,
                creatorSource: 'plugin:TopicSponsor',
                _creator: { agentName: agent.name, agentId: agent.id, timestamp },
                ...(flowlockRequest ? { flowlockRequest } : {}),
            };
            const initialMessage = pluginMessage(agent, args.initial_message, agent.name, {
                topicCreator: agent.name,
                creatorAgentId: agent.id,
            });
            await this.historyMutationQueue.replace(
                { itemId: agent.id, itemType: 'agent', topicId },
                [initialMessage]
            );
            try {
                const updated = await this.updateAgent(agent.id, config => ({
                    config: {
                        ...config,
                        topics: [topic, ...(Array.isArray(config.topics) ? config.topics : [])],
                        ...(flowlockRequest ? {} : { current_topic_id: topicId }),
                    },
                    result: null,
                }));
                return {
                    message: `成功创建了新的${flowlockRequest ? ' Flowlock' : ''}话题：${topic.name}`,
                    topic_id: topicId,
                    topic_name: topic.name,
                    agent_name: agent.name,
                    agent_id: agent.id,
                    initial_message: args.initial_message,
                    ...(flowlockRequest ? {
                        request_id: flowlockRequest.requestId,
                        flowlock_status: flowlockRequest.status,
                        heartbeat_seconds: flowlockRequest.heartbeatSeconds,
                    } : {}),
                    topics: updated.config.topics,
                };
            } catch (error) {
                await fs.remove(path.dirname(this.historyMutationQueue.getHistoryPath(agent.id, topicId))).catch(() => {});
                throw error;
            }
        }

        if (command === 'ReplyToTopic') {
            const topicId = validateId(args.topic_id, 'topic_id');
            const topic = topics.find(item => item.id === topicId);
            if (!topic) throw new Error(`话题 ${topicId} 不存在。`);
            if (topic.locked && !topic.unread) throw new Error(`话题 ${topicId} 不允许插件回复。`);
            if (typeof args.message !== 'string' || !args.message) throw new TypeError('message 不能为空。');
            if (typeof args.sender_name !== 'string' || !args.sender_name.trim()) {
                throw new TypeError('sender_name 不能为空。');
            }
            const message = pluginMessage(agent, args.message, args.sender_name.trim(), {
                isPluginReply: true,
                originalSender: args.sender_name.trim(),
                targetAgent: agent.name,
            });
            await this.historyMutationQueue.mutate(
                { itemId: agent.id, itemType: 'agent', topicId },
                history => [...history, message]
            );
            return {
                message: `成功在 ${agent.name} 的话题「${topic.name}」中添加回复。`,
                topic_id: topicId,
                topic_name: topic.name,
                sender: message.name,
                message_id: message.id,
                timestamp: message.timestamp,
                agent_name: agent.name,
                agent_id: agent.id,
            };
        }

        if (command === 'CheckNewTopics') {
            const days = Math.max(0, Number(args.days) || 3);
            const cutoff = Date.now() - days * 86400000;
            const matched = topics.filter(topic => topic.locked === false && topic.createdAt > cutoff);
            return {
                agent_name: agent.name,
                has_new_topics: matched.length > 0,
                new_topics_count: matched.length,
                topics: matched.map(topic => ({
                    topic_id: topic.id,
                    topic_name: topic.name,
                    created_at: topic.createdAt,
                    age_hours: (Date.now() - topic.createdAt) / 3600000,
                    locked: false,
                })),
            };
        }

        const topicId = args.topic_id ? validateId(args.topic_id, 'topic_id') : null;
        const selectedTopic = topicId ? topics.find(topic => topic.id === topicId) : null;
        if (topicId && !selectedTopic) throw new Error(`话题 ${topicId} 不存在。`);

        if (command === 'ReadTopicContent') {
            const messages = await this.historyMutationQueue.read(
                { itemId: agent.id, itemType: 'agent', topicId }
            );
            return {
                agent_name: agent.name,
                agent_id: agent.id,
                topic_id: topicId,
                topic_name: selectedTopic.name,
                topic_info: {
                    locked: selectedTopic.locked !== undefined ? selectedTopic.locked : true,
                    unread: selectedTopic.unread === true,
                    created_at: selectedTopic.createdAt,
                },
                message_count: messages.length,
                messages,
            };
        }

        if (command === 'CheckTopicOwnership') {
            let creatorName = selectedTopic?._creator?.agentName || 'unknown';
            if (creatorName === 'unknown') {
                const history = await this.historyMutationQueue.read(
                    { itemId: agent.id, itemType: 'agent', topicId }
                );
                creatorName = history[0]?._metadata?.topicSponsor
                    || history[0]?._metadata?.topicCreator
                    || history[0]?.name
                    || 'unknown';
            }
            return {
                is_owner: creatorName === args.caller_name,
                creator_name: creatorName,
                topic_name: selectedTopic.name,
            };
        }

        const unlocked = topics.filter(topic =>
            topic.locked === false
            && (command !== 'ReadUnlockedTopics' || args.include_read === true || topic.unread === true)
        );
        const details = [];
        for (const topic of command === 'CheckUnreadMessages'
            ? topics.filter(item => item.unread === true)
            : unlocked) {
            const history = await this.historyMutationQueue.read(
                { itemId: agent.id, itemType: 'agent', topicId: topic.id }
            );
            details.push({
                topic_id: topic.id,
                topic_name: topic.name,
                locked: topic.locked === true,
                unread: topic.unread === true,
                created_at: topic.createdAt,
                message_count: history.length,
                ...(command === 'ReadUnlockedTopics' ? { messages: history } : {}),
                ...(command === 'CheckUnreadMessages' ? {
                    last_message_time: history.at(-1)?.timestamp || topic.createdAt,
                } : {}),
            });
        }
        if (command === 'CheckUnreadMessages') {
            return { agent_name: agent.name, has_unread: details.length > 0, unread_topics: details };
        }
        if (command === 'ListUnlockedTopics') {
            return {
                agent_name: agent.name,
                agent_id: agent.id,
                has_unlocked_topics: details.length > 0,
                unlocked_topics_count: details.length,
                topics: details,
            };
        }
        return {
            agent_name: agent.name,
            agent_id: agent.id,
            topics: details,
            total_topics: details.length,
        };
    }
}

module.exports = {
    PluginAgentOperationService,
    PROMPT_COMMANDS,
    TOPIC_COMMANDS,
    activePrompt,
};