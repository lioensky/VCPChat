// modules/ipc/sideChatHandlers.js
/**
 * Main-process IPC handlers for Workspace Side Chat metadata and parent context snapshots.
 */
'use strict';

let electronModule = null;
try {
    electronModule = require('electron');
} catch {}
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { createApplicationSenderGuard } = require('./applicationSender');

function filterStableHistory(history = []) {
    if (!Array.isArray(history)) return [];

    const stable = [];
    for (const msg of history) {
        if (!msg || typeof msg !== 'object') continue;
        if (msg.transient || msg.isStreaming || msg.pending || msg.isThinking || msg.isPendingStream) continue;
        if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system' && (msg.role !== 'tool' || !msg.tool_call_id)) continue;
        const text = msg.content !== undefined ? msg.content : msg.text;
        const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
        if ((text === undefined || text === null || text === '') && !hasToolCalls) continue;

        const clonedContent = typeof text === 'object' && text !== null ? JSON.parse(JSON.stringify(text)) : (text ?? null);

        const entry = {
            id: msg.id || null,
            sourceMessageId: msg.id || null,
            role: msg.role,
            content: clonedContent,
            timestamp: msg.timestamp || null,
            isInherited: true
        };

        if (msg.tool_calls) {
            entry.tool_calls = JSON.parse(JSON.stringify(msg.tool_calls));
        }
        if (msg.tool_call_id) {
            entry.tool_call_id = msg.tool_call_id;
        }
        if (msg.attachments) {
            entry.attachments = JSON.parse(JSON.stringify(msg.attachments));
        }

        stable.push(entry);
    }

    return stable;
}

function validateSegment(value) {
    if (typeof value !== 'string' || !value ||
        /[<>:"/\\|?*\x00-\x1f]/.test(value) ||
        value === '.' || value === '..' || /[. ]$/.test(value) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
        return null;
    }
    return value;
}

const CHANNELS = [
    'side-chat:save-metadata',
    'side-chat:list-metadata',
    'side-chat:create-snapshot',
    'side-chat:create-child',
    'side-chat:delete-child',
];

// 侧聊子会话目录标记：仅带此标记的目录才允许被 delete-child 整体删除
const CHILD_MARKER_FILE = 'sidechat-child.json';

/**
 * Initializes Side Chat IPC handlers.
 * @param {Object} paths
 * @param {string} paths.USER_DATA_DIR
 * @param {string} [paths.AGENT_DIR]
 * @param {Object} [paths.historyMutationQueue]
 * @param {Object} [paths.ipcMain]
 */
function initialize(paths) {
    const { USER_DATA_DIR, historyMutationQueue, ipcMain: injectedIpcMain } = paths || {};
    const ipc = injectedIpcMain || (electronModule && typeof electronModule === 'object' ? electronModule.ipcMain : null);
    if (!ipc || typeof ipc.handle !== 'function') {
        console.error('[SideChatHandlers] ipcMain is missing or invalid; handlers cannot be registered.');
        return;
    }

    for (const channel of CHANNELS) {
        try {
            ipc.removeHandler(channel);
        } catch {}
    }

    const isAllowedSender = createApplicationSenderGuard({ getWebContents: () => paths.mainWindow?.webContents });
    const register = (channel, handler) => ipc.handle(channel, async (event, ...args) => {
        if (!isAllowedSender(event)) return { success: false, error: 'UNAUTHORIZED_SENDER' };
        return handler(event, ...args);
    });

    async function requireChild(topicDir, agentId, topicId, parentTopicId = null) {
        try {
            for (const directory of [path.join(USER_DATA_DIR, agentId), path.join(USER_DATA_DIR, agentId, 'topics')]) {
                const ancestor = await fs.lstat(directory);
                if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) return null;
            }
            const stat = await fs.lstat(topicDir);
            const base = await fs.realpath(USER_DATA_DIR);
            const real = await fs.realpath(topicDir);
            const relative = path.relative(base, real);
            const marker = await fs.readJson(path.join(topicDir, CHILD_MARKER_FILE));
            if (!stat.isDirectory() || stat.isSymbolicLink() || relative.startsWith('..') || path.isAbsolute(relative) ||
                marker.schemaVersion !== 1 || marker.ephemeral !== true ||
                (marker.agentId && marker.agentId !== agentId) || (marker.topicId && marker.topicId !== topicId)) return null;
            if (parentTopicId && marker.parentTopicId && marker.parentTopicId !== parentTopicId) return null;
            return marker;
        } catch { return null; }
    }

    function getTopicDir(agentId, topicId) {
        const safeAgentId = validateSegment(String(agentId || ''));
        const safeTopicId = validateSegment(String(topicId || ''));
        if (!safeAgentId || !safeTopicId) return null;
        return path.join(USER_DATA_DIR, safeAgentId, 'topics', safeTopicId);
    }

    register('side-chat:save-metadata', async (event, metadata) => {
        try {
            if (!metadata || typeof metadata !== 'object') {
                return { success: false, error: 'INVALID_METADATA' };
            }
            const agentId = metadata.child?.itemId || metadata.parent?.itemId;
            const childTopicId = metadata.child?.topicId;
            if (!agentId || !childTopicId) {
                return { success: false, error: 'MISSING_AGENT_OR_TOPIC' };
            }

            const topicDir = getTopicDir(agentId, childTopicId);
            if (!topicDir) {
                return { success: false, error: 'INVALID_PATH' };
            }

            const parentTopicId = validateSegment(metadata.parent?.topicId);
            if (!parentTopicId || metadata.parent?.itemId !== agentId) return { success: false, error: 'INVALID_PARENT' };
            const marker = await requireChild(topicDir, agentId, childTopicId, parentTopicId);
            if (!marker) return { success: false, error: 'NOT_A_SIDE_CHAT_CHILD' };
            marker.parentTopicId = parentTopicId;
            await fs.writeJson(path.join(topicDir, CHILD_MARKER_FILE), marker, { spaces: 2 });
            const metadataPath = path.join(topicDir, 'sidechat-metadata.json');

            const snapshotPath = path.join(topicDir, 'parent-snapshot.json');
            let snapshotBoundary = metadata.snapshotBoundary || null;
            if (!snapshotBoundary && await fs.pathExists(snapshotPath)) {
                try {
                    const snap = await fs.readJson(snapshotPath);
                    snapshotBoundary = snap.snapshotBoundary || null;
                } catch {}
            }

            const payload = {
                schemaVersion: 1,
                id: metadata.id || `sidechat-${Date.now()}`,
                parent: {
                    itemType: 'agent',
                    itemId: String(metadata.parent?.itemId || agentId),
                    topicId: String(metadata.parent?.topicId || ''),
                    name: metadata.parent?.name || null,
                    avatar: metadata.parent?.avatar || null
                },
                child: {
                    itemType: 'agent',
                    itemId: String(agentId),
                    topicId: String(childTopicId)
                },
                title: metadata.title || '辅助对话',
                contextMode: metadata.contextMode === 'parent-snapshot' ? 'parent-snapshot' : 'references-only',
                snapshotId: metadata.snapshotId || null,
                snapshotBoundary,
                model: metadata.model || null,
                open: metadata.open !== undefined ? Boolean(metadata.open) : (metadata.status !== 'closed'),
                draft: typeof metadata.draft === 'string' ? metadata.draft : '',
                references: Array.isArray(metadata.references) ? metadata.references : [],
                status: metadata.status || (metadata.open === false ? 'closed' : 'ready'),
                createdAt: metadata.createdAt || Date.now(),
                updatedAt: Date.now()
            };

            await fs.writeJson(metadataPath, payload, { spaces: 2 });
            return { success: true, metadata: payload };
        } catch (error) {
            console.error('[SideChatHandlers] save-metadata error:', error);
            return { success: false, error: error.message };
        }
    });

    register('side-chat:list-metadata', async (event, agentId, parentTopicId = null) => {
        try {
            if (!agentId) return { success: false, error: 'MISSING_AGENT_ID' };
            const safeAgentId = validateSegment(String(agentId || ''));
            if (!safeAgentId) return { success: false, error: 'INVALID_AGENT_ID' };
            const topicsDir = path.join(USER_DATA_DIR, safeAgentId, 'topics');

            if (!await fs.pathExists(topicsDir)) {
                return { success: true, items: [] };
            }

            const entries = await fs.readdir(topicsDir, { withFileTypes: true });
            const items = [];

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const entryDir = path.join(topicsDir, entry.name);
                if (!await requireChild(entryDir, safeAgentId, entry.name, parentTopicId)) continue;
                const metadataPath = path.join(entryDir, 'sidechat-metadata.json');
                try {
                    if (await fs.pathExists(metadataPath)) {
                        const meta = await fs.readJson(metadataPath);
                        if (meta && meta.schemaVersion === 1) {
                            if (!parentTopicId || meta.parent?.topicId === parentTopicId) {
                                const snapshotPath = path.join(entryDir, 'parent-snapshot.json');
                                if (await fs.pathExists(snapshotPath)) {
                                    try {
                                        const snap = await fs.readJson(snapshotPath);
                                        meta.parentSnapshot = snap.messages || [];
                                        const boundary = snap.snapshotBoundary || snap.boundary;
                                        if (boundary) {
                                            meta.snapshotBoundary = boundary;
                                        }
                                    } catch {}
                                }
                                items.push(meta);
                            }
                        }
                    }
                } catch {
                    // Ignore corrupted individual metadata files
                }
            }

            // Sort chronologically
            items.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
            return { success: true, items };
        } catch (error) {
            console.error('[SideChatHandlers] list-metadata error:', error);
            return { success: false, error: error.message };
        }
    });

    // 侧聊是临时会话（对应 ZCode 的隐藏子会话）：只在磁盘上创建历史目录，
    // 不写入 agent config.topics，因此不会出现在话题列表里。
    register('side-chat:create-child', async (event, agentId) => {
        try {
            const safeAgentId = validateSegment(String(agentId || ''));
            if (!safeAgentId) return { success: false, error: 'INVALID_AGENT_ID' };

            let topicId = null;
            let topicDir = null;
            for (let attempt = 0; attempt < 5; attempt++) {
                const candidate = `sidechat_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
                const candidateDir = getTopicDir(safeAgentId, candidate);
                if (candidateDir && !await fs.pathExists(candidateDir)) {
                    topicId = candidate;
                    topicDir = candidateDir;
                    break;
                }
            }
            if (!topicId) return { success: false, error: 'ID_COLLISION' };

            await fs.ensureDir(USER_DATA_DIR);
            const base = await fs.realpath(USER_DATA_DIR);
            for (const directory of [path.join(USER_DATA_DIR, safeAgentId), path.join(USER_DATA_DIR, safeAgentId, 'topics')]) {
                try { await fs.mkdir(directory); } catch(error) { if (error.code !== 'EEXIST') throw error; }
                const stat = await fs.lstat(directory);
                const relative = path.relative(base, await fs.realpath(directory));
                if (!stat.isDirectory() || stat.isSymbolicLink() || relative.startsWith('..') || path.isAbsolute(relative)) {
                    return {success:false,error:'UNSAFE_CHILD_ANCESTOR'};
                }
            }
            await fs.mkdir(topicDir); // Exclusive creation; never follow a pre-existing child link.
            await fs.writeJson(path.join(topicDir, 'history.json'), [], { spaces: 2 });
            await fs.writeJson(path.join(topicDir, CHILD_MARKER_FILE), {
                schemaVersion: 1,
                ephemeral: true,
                agentId: safeAgentId,
                topicId,
                parentTopicId: null,
                createdAt: Date.now()
            }, { spaces: 2 });
            return { success: true, topicId };
        } catch (error) {
            console.error('[SideChatHandlers] create-child error:', error);
            return { success: false, error: error.message };
        }
    });

    register('side-chat:delete-child', async (event, agentId, childTopicId) => {
        try {
            const topicDir = getTopicDir(agentId, childTopicId);
            if (!topicDir) return { success: false, error: 'INVALID_PATH' };
            if (!await fs.pathExists(topicDir)) return { success: true, removed: false };
            // 拒绝删除没有侧聊标记的目录，避免误删真实话题
            if (!await requireChild(topicDir, agentId, childTopicId)) {
                return { success: false, error: 'NOT_A_SIDE_CHAT_CHILD' };
            }
            await fs.remove(topicDir);
            return { success: true, removed: true };
        } catch (error) {
            console.error('[SideChatHandlers] delete-child error:', error);
            return { success: false, error: error.message };
        }
    });

    register('side-chat:create-snapshot', async (event, agentId, parentTopicId, childTopicId = null) => {
        try {
            const parentDir = getTopicDir(agentId, parentTopicId);
            if (!parentDir) return { success: false, error: 'INVALID_PARENT_PATH' };

            let rawHistory = [];
            if (historyMutationQueue && typeof historyMutationQueue.read === 'function') {
                try {
                    rawHistory = await historyMutationQueue.read({ itemId: agentId, itemType: 'agent', topicId: parentTopicId });
                } catch (readErr) {
                    console.error('[SideChatHandlers] create-snapshot history read error:', readErr);
                    return { success: false, error: readErr.message || 'HISTORY_READ_FAILED' };
                }
            } else {
                const parentHistoryPath = path.join(parentDir, 'history.json');
                if (await fs.pathExists(parentHistoryPath)) {
                    rawHistory = await fs.readJson(parentHistoryPath);
                }
            }

            const stableHistory = filterStableHistory(rawHistory);
            const now = Date.now();
            const snapshotId = `snapshot_${now}_${crypto.randomBytes(4).toString('hex')}`;
            const lastMsg = stableHistory[stableHistory.length - 1];
            const snapshotBoundary = {
                lastMessageId: lastMsg?.id || null,
                capturedAt: now,
                messageCount: stableHistory.length
            };

            // If childTopicId is provided, write snapshot into child topic dir
            if (childTopicId) {
                const childDir = getTopicDir(agentId, childTopicId);
                const marker = childDir && await requireChild(childDir, agentId, childTopicId, parentTopicId);
                if (!marker) return { success: false, error: 'NOT_A_SIDE_CHAT_CHILD' };
                if (childDir) {
                    marker.parentTopicId = parentTopicId;
                    await fs.writeJson(path.join(childDir, CHILD_MARKER_FILE), marker, { spaces: 2 });
                    await fs.writeJson(path.join(childDir, 'parent-snapshot.json'), {
                        snapshotId,
                        parentTopicId,
                        boundary: snapshotBoundary,
                        snapshotBoundary,
                        messages: stableHistory
                    }, { spaces: 2 });
                }
            }

            return {
                success: true,
                snapshotId,
                snapshotBoundary,
                messages: stableHistory
            };
        } catch (error) {
            console.error('[SideChatHandlers] create-snapshot error:', error);
            return { success: false, error: error.message };
        }
    });
}

// 删除父话题时一并删除挂在它下面的辅助对话；只认带侧聊标记且父话题匹配的目录
async function removeSideChatChildrenOfParent({ USER_DATA_DIR, agentId, parentTopicId }) {
    const safeAgentId = validateSegment(String(agentId || ''));
    const safeParentId = validateSegment(String(parentTopicId || ''));
    if (!USER_DATA_DIR || !safeAgentId || !safeParentId) return 0;
    const topicsDir = path.join(USER_DATA_DIR, safeAgentId, 'topics');
    let entries;
    try {
        const stat = await fs.lstat(topicsDir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return 0;
        entries = await fs.readdir(topicsDir, { withFileTypes: true });
    } catch { return 0; }
    let removed = 0;
    for (const entry of entries) {
        if (!entry.isDirectory() || !validateSegment(entry.name)) continue;
        const entryDir = path.join(topicsDir, entry.name);
        try {
            const marker = await fs.readJson(path.join(entryDir, CHILD_MARKER_FILE));
            if (marker?.schemaVersion !== 1 || marker.ephemeral !== true ||
                marker.agentId !== safeAgentId || marker.topicId !== entry.name ||
                marker.parentTopicId !== safeParentId) continue;
            await fs.remove(entryDir);
            removed += 1;
        } catch {}
    }
    return removed;
}

module.exports = {
    initialize,
    filterStableHistory,
    removeSideChatChildrenOfParent
};
