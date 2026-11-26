'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { tools, validateArguments } = require('./tools.cjs');
const { searchTool, createSearcher } = require('./search.cjs');
const { DEFAULT_VCP_URL, topicTools, normalizeVcpUrl, createTopicClient } = require('./topic.cjs');

const INSTRUCTIONS = 'Use ProjectForge tools for source investigation and edits instead of raw file writes. First reuse an existing projectId in the configured workspace; paths are relative to its root. Use pf_search for workspace content search via native CodeSearcher (no project required), Outline/FindSymbol for definitions and bounded ReadCode; batch same-file changes in EditCode.edits against one original snapshot. Supply reason for changes. Resolve ambiguous edits using returned tickets; never guess candidates or blindly retry uncertain writes. When topic tools are enabled, read topics progressively via tm_list_topics -> tm_outline_topic / tm_search_topic -> bounded tm_get_topic_content, and pass structured contextItems or riverLast on ts_reply_to_topic. Read projectforge_development prompt (or projectforge://instructions) for full workflow. Keep terminal, Git and LSP diagnostics for builds, tests and validation. No VCPToolCall, ink or valet fields are used.';
const PROMPT_URI = 'projectforge://instructions';

function loadConfig(filename) {
    if (!filename || !path.isAbsolute(filename)) throw new Error('--config requires an absolute JSON file path');
    const raw = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
    const allowed = new Set([
        'workspaces', 'activeWorkspaceId', 'dbPath', 'binaryPath', 'maid',
        'enableEval', 'enablePurge', 'enableBash', 'enableTopic', 'vcpUrl', 'vcpKey',
        'vcpAppDataPath', 'topicReadMode',
    ]);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Config must be an object');
    for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`Unknown config field: ${key}`);
    if (!Array.isArray(raw.workspaces) || !raw.workspaces.length) throw new Error('Configure at least one explicit workspace');
    const ids = new Set();
    const aliases = new Set();
    const workspaces = raw.workspaces.map(ws => {
        if (!ws || typeof ws !== 'object' || Array.isArray(ws)) throw new Error('Invalid workspace');
        for (const key of Object.keys(ws)) if (!['id', 'alias', 'path', 'enabled'].includes(key)) throw new Error(`Unknown workspace field: ${key}`);
        if (typeof ws.id !== 'string' || !ws.id.trim() || typeof ws.alias !== 'string' || !ws.alias.trim()) throw new Error('Workspace needs id and alias');
        if (ids.has(ws.id.toLowerCase()) || aliases.has(ws.alias.toLowerCase())) throw new Error('Duplicate workspace id/alias');
        if (typeof ws.path !== 'string' || !path.isAbsolute(ws.path)) throw new Error('Workspace path must be absolute');
        if (ws.enabled !== undefined && typeof ws.enabled !== 'boolean') throw new Error('Workspace enabled must be boolean');
        const root = fs.realpathSync(ws.path);
        if (!fs.statSync(root).isDirectory()) throw new Error('Workspace must be a directory');
        ids.add(ws.id.toLowerCase()); aliases.add(ws.alias.toLowerCase());
        return { ...ws, path: root, enabled: ws.enabled !== false };
    });
    if (!workspaces.some(ws => ws.enabled)) throw new Error('At least one workspace must be enabled');
    if (raw.activeWorkspaceId !== undefined && !workspaces.some(ws => ws.id === raw.activeWorkspaceId && ws.enabled)) throw new Error('activeWorkspaceId must name an enabled workspace');
    for (const key of ['dbPath', 'binaryPath', 'vcpAppDataPath']) {
        if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !path.isAbsolute(raw[key]))) throw new Error(`${key} must be absolute`);
    }
    if (raw.topicReadMode !== undefined && !['auto', 'local', 'http'].includes(raw.topicReadMode)) {
        throw new Error('topicReadMode must be auto, local or http');
    }
    for (const key of ['enableEval', 'enablePurge', 'enableBash', 'enableTopic']) {
        if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw new Error(`${key} must be boolean`);
    }
    if (raw.maid !== undefined && (typeof raw.maid !== 'string' || !raw.maid.trim() || raw.maid.length > 100)) throw new Error('maid must be 1–100 characters');
    const vcpUrl = raw.vcpUrl !== undefined ? normalizeVcpUrl(raw.vcpUrl) : DEFAULT_VCP_URL;
    if (raw.vcpKey !== undefined && (typeof raw.vcpKey !== 'string' || !raw.vcpKey.trim() || /[\r\n\0]/.test(raw.vcpKey))) {
        throw new Error('vcpKey must be a single-line non-empty string');
    }
    const envKey = typeof process.env.VCP_API_KEY === 'string' ? process.env.VCP_API_KEY.trim() : '';
    if (envKey && /[\r\n\0]/.test(envKey)) throw new Error('VCP_API_KEY must not contain newlines or NUL');
    const enableTopic = raw.enableTopic === true;
    const vcpKey = raw.vcpKey !== undefined ? raw.vcpKey.trim() : envKey;
    if (enableTopic && !vcpKey) throw new Error('enableTopic requires vcpKey or VCP_API_KEY');
    return {
        ...raw, workspaces,
        activeWorkspaceId: raw.activeWorkspaceId || workspaces.find(ws => ws.enabled).id,
        dbPath: raw.dbPath || path.resolve(__dirname, '../../../../AppData/ProjectForge/mcp-projectforge.db'),
        maid: raw.maid || 'MCP',
        enableEval: raw.enableEval === true, enablePurge: raw.enablePurge === true, enableBash: raw.enableBash === true,
        enableTopic, vcpUrl, ...(vcpKey ? { vcpKey } : {}),
    };
}

// OpenAI-style data URLs become native MCP blocks. Never fetch remote media URLs.
function convertResult(result) {
    if (!result || !Array.isArray(result.content)) throw new Error('Invalid ProjectForge content response');
    const content = result.content.map(part => {
        if (part.type === 'text') return { type: 'text', text: String(part.text ?? '') };
        if (part.type === 'image_url') {
            const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
            const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]*)$/.exec(url || '');
            if (!match) return { type: 'text', text: '[Media omitted: unsupported non-data URL; no network request was made.]' };
            const [, mimeType, data] = match;
            if (mimeType.startsWith('image/')) return { type: 'image', mimeType, data: data.replace(/\s/g, '') };
            if (mimeType.startsWith('audio/')) return { type: 'audio', mimeType, data: data.replace(/\s/g, '') };
            return { type: 'text', text: `[Media omitted: MCP/Zed inline ${mimeType} rendering is not supported. Use an external viewer.]` };
        }
        throw new Error(`Unsupported ProjectForge content type: ${part.type}`);
    });
    // Keep structured query results and execution evidence, not whole source/edit snapshots.
    const details = result.details || {};
    const { command, status } = details;
    const failed = command === 'EvalSymbol'
        ? !['returned', 'passed', 'ambiguous'].includes(status)
        : command === 'Bash'
            ? details.ok !== true
            : ['error', 'failed', 'conflict', 'rejected', 'unknown', 'planningRejected', 'syntaxRejected'].includes(status);
    return {
        content,
        ...(['EvalSymbol', 'Query', 'Bash'].includes(command) ? { structuredContent: details } : {}),
        ...(result.isError === true || failed ? { isError: true } : {}),
    };
}

function createBridge(config, service) {
    const searcher = createSearcher(config);
    const topicClient = config.enableTopic === true ? createTopicClient(config) : null;
    const available = [
        ...tools,
        searchTool,
        ...(topicClient ? topicTools : []),
    ].filter(tool =>
        (tool.command !== 'EvalSymbol' || config.enableEval) &&
        (tool.command !== 'PurgeProjects' || config.enablePurge) &&
        (tool.command !== 'Bash' || config.enableBash === true));
    const byName = new Map(available.map(tool => [tool.name, tool]));
    let pending = 0;
    let closing = false;
    const promptFile = ['myMCPPrompt.md', 'MCPPrompt.md'].map(f => path.join(__dirname, f)).find(p => fs.existsSync(p));
    const prompt = () => fs.readFileSync(promptFile, 'utf8');
    service.initialize({
        config: { PROJECTFORGE_DB_PATH: config.dbPath, BASH_ENABLED: config.enableBash === true },
        ...(config.binaryPath ? { serviceBinaryPath: config.binaryPath, indexerBinaryPath: config.binaryPath } : {}),
        workspaceService: {
            list: () => config.workspaces.map(ws => ({ ...ws })),
            getActiveWorkspaceId: () => config.activeWorkspaceId,
        },
        logger: console,
    });
    return {
        listTools: () => available.map(({ command, plugin, toArgs, ...tool }) => tool),
        prompt,
        async call(name, args = {}) {
            const tool = byName.get(name);
            if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown or disabled tool: ${name}` }] };
            if (closing || pending >= 32) return { isError: true, content: [{ type: 'text', text: 'ProjectForge bridge is closing or busy; no operation admitted.' }] };
            pending++;
            try {
                validateArguments(tool, args);
                if (name === searchTool.name) return await searcher.search(args);
                if (tool.plugin) return await topicClient.call(tool, args);
                const result = await service.processToolCall({ ...args, command: tool.command, maid: args.maid || config.maid });
                return convertResult(result);
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `${error.code ? `[${error.code}] ` : ''}${error.message}${error.operationId ? `\noperationId: ${error.operationId}` : ''}\nIf a write was admitted, do not blindly retry after a connection/timeout error. Inspect project/history and disk state first.` }] };
            } finally { pending--; }
        },
        async close() {
            closing = true;
            const results = await Promise.allSettled([
                searcher.close(),
                ...(topicClient ? [topicClient.close()] : []),
                service.cleanup(),
            ]);
            const failed = results.find(result => result.status === 'rejected');
            if (failed) throw failed.reason;
        },
    };
}

module.exports = { loadConfig, convertResult, createBridge, INSTRUCTIONS, PROMPT_URI };