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
const { createApplicationSenderGuard, resolveWindowWebContents } = require('./applicationSender');
const { clearTrajectoryOf } = require('../modelTrajectory');

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
const CHILD_ID_PATTERN = /^sidechat_\d+_[0-9a-f]+$/;
// Windows 上目录可能被文件监听或杀毒软件短暂占着，删除失败时重试几次
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

// 标记文件最后删：中途失败时目录里还留着标记，下次还认得出来、还能接着删
async function removeChildDir(topicDir) {
    for (const name of await fs.readdir(topicDir)) {
        if (name !== CHILD_MARKER_FILE) await fs.promises.rm(path.join(topicDir, name), REMOVE_OPTIONS);
    }
    await fs.promises.rm(path.join(topicDir, CHILD_MARKER_FILE), REMOVE_OPTIONS);
    await fs.promises.rm(topicDir, REMOVE_OPTIONS);
}

// 以前删到一半留下的空侧聊目录：已经没有标记，只在名字是侧聊格式且确实为空时才删
async function removeEmptyChildDir(topicDir, topicId) {
    if (!CHILD_ID_PATTERN.test(topicId)) return false;
    try {
        const stat = await fs.lstat(topicDir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
        await fs.promises.rmdir(topicDir);
        return true;
    } catch { return false; }
}

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

    const getMainWindow = typeof paths.getMainWindow === 'function' ? paths.getMainWindow : () => paths.mainWindow;
    const isAllowedSender = createApplicationSenderGuard({ getWebContents: () => resolveWindowWebContents(getMainWindow) });
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
            if (metadata.composerStorage === 'local') {
                payload.composerStorage = 'local';
                delete payload.draft;
                delete payload.references;
                delete payload.model;
            }

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

            // 普通话题远多于侧聊；先用一次 stat 排除没有侧聊元数据的目录，
            // 再做 requireChild 的多次 lstat/realpath/读标记校验。1000 个话题时
            // 这次扫描从约 650ms 降到约 25ms。
            const candidates = await Promise.all(entries.map(async entry => {
                if (!entry.isDirectory()) return null;
                const entryDir = path.join(topicsDir, entry.name);
                return await fs.pathExists(path.join(entryDir, 'sidechat-metadata.json')) ? entry : null;
            }));

            for (const entry of candidates) {
                if (!entry) continue;
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

    // 侧聊是临时会话（隐藏的子会话）：只在磁盘上创建历史目录，
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
                if (await removeEmptyChildDir(topicDir, childTopicId)) return { success: true, removed: true };
                return { success: false, error: 'NOT_A_SIDE_CHAT_CHILD' };
            }
            await removeChildDir(topicDir);
            await clearTrajectoryOf({ agentId, topicId: childTopicId });
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

// 创建到一半就失败的侧聊：有标记但从没绑定父话题、没写元数据、记录为空，而且不是刚建的。
// 它不会出现在任何列表里，也不属于任何父话题；顺带清掉，免得一直留在磁盘上
const ABANDONED_CREATION_MS = 10 * 60 * 1000;
async function isAbandonedCreation(entryDir, marker) {
    if (marker.parentTopicId !== null || !(Date.now() - Number(marker.createdAt) > ABANDONED_CREATION_MS)) return false;
    if (await fs.pathExists(path.join(entryDir, 'sidechat-metadata.json'))) return false;
    try {
        const history = await fs.readJson(path.join(entryDir, 'history.json'));
        return Array.isArray(history) && history.length === 0;
    } catch (error) { return error?.code === 'ENOENT'; }
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
        let marker = null;
        try {
            marker = await fs.readJson(path.join(entryDir, CHILD_MARKER_FILE));
        } catch {
            // 没有标记的空侧聊目录顺手清掉；非空的一律不碰
            if (await removeEmptyChildDir(entryDir, entry.name)) removed += 1;
            continue;
        }
        try {
            if (marker?.schemaVersion !== 1 || marker.ephemeral !== true ||
                marker.agentId !== safeAgentId || marker.topicId !== entry.name) continue;
            if (marker.parentTopicId !== safeParentId && !await isAbandonedCreation(entryDir, marker)) continue;
            await removeChildDir(entryDir);
            await clearTrajectoryOf({ agentId: safeAgentId, topicId: entry.name });
            removed += 1;
        } catch {}
    }
    return removed;
}

module.exports = {
    CHANNELS,
    initialize,
    filterStableHistory,
    removeSideChatChildrenOfParent
};
