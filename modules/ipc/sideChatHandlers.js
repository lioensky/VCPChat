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
    'side-chat:update-branch',
    'side-chat:export-note',
];

// 分形分支：允许通过 update-branch 合并更新的字段白名单
const BRANCH_PATCH_FIELDS = ['rootTopicId', 'forkFromTopicId', 'forkMessageId', 'forkLabel', 'branchTitle', 'title', 'depth', 'crystallized'];

// 元数据写锁：同一子话题的 save-metadata（全量写）与 update-branch（读改写）
// 必须串行，否则「读-改-写」窗口内的并发全量写会被旧快照覆盖（丢失更新）。
// 键为 `${agentId}:${childTopicId}`，值为前一个写操作的 Promise。
const metadataWriteLocks = new Map();
function withMetadataLock(key, operation) {
    const previous = metadataWriteLocks.get(key) || Promise.resolve();
    const next = previous.then(operation, operation);
    // 完成后清理：仅当仍是自己时移除，避免误删后续排队者的锁
    metadataWriteLocks.set(key, next);
    next.finally(() => {
        if (metadataWriteLocks.get(key) === next) metadataWriteLocks.delete(key);
    }).catch(() => {});
    return next;
}

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
            const lockKey = `${agentId}:${childTopicId}`;

            // 全程持锁：读盘（snapshotBoundary 回读 + 分支字段保留）→ 构造 payload → 写入，
            // 与 update-branch 的读改写互斥。锁外读+锁内写 = 过时快照覆盖（R3）
            return withMetadataLock(lockKey, async () => {
            // 分形子分支：拓扑字段归 update-branch/rename 专管。save-metadata 的调用方
            // 常持有发起时刻的旧 descriptor 快照，若原样覆盖会把并发 rename 抹掉（R3）。
            // 磁盘上已有元数据且调用方未主动改动该字段时，以磁盘为准。
            let diskBranchFields = null;
            if (await fs.pathExists(metadataPath)) {
                try {
                    const disk = await fs.readJson(metadataPath);
                    if (disk?.forkFromTopicId) {
                        diskBranchFields = {};
                        for (const f of ['rootTopicId', 'forkFromTopicId', 'forkMessageId', 'forkLabel', 'branchTitle', 'depth', 'crystallized']) {
                            if (Object.prototype.hasOwnProperty.call(disk, f)) diskBranchFields[f] = disk[f];
                        }
                    }
                } catch (diskErr) { void diskErr; }
            }
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
                // ── 分形分支树拓扑字段（可选；旧侧聊没有这些字段，视为独立根）──
                rootTopicId: typeof metadata.rootTopicId === 'string' ? metadata.rootTopicId : null,
                forkFromTopicId: typeof metadata.forkFromTopicId === 'string' ? metadata.forkFromTopicId : null,
                forkMessageId: typeof metadata.forkMessageId === 'string' ? metadata.forkMessageId : null,
                forkLabel: typeof metadata.forkLabel === 'string' ? metadata.forkLabel.slice(0, 200) : null,
                branchTitle: typeof metadata.branchTitle === 'string' ? metadata.branchTitle.slice(0, 200) : null,
                depth: Number.isFinite(metadata.depth) ? Math.max(0, Math.floor(metadata.depth)) : 0,
                crystallized: Boolean(metadata.crystallized),
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

            // 分支拓扑字段以磁盘为准（R3）：rename/update-branch 是这些字段的唯一写者
            if (diskBranchFields) {
                Object.assign(payload, diskBranchFields);
            }

                await fs.writeJson(metadataPath, payload, { spaces: 2 });
                return { success: true, metadata: payload };
            });
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
            // 级联删除：递归收集并清理所有以 childTopicId 为祖先的子分支
            // （直接扫描磁盘 metadata，不依赖前端 IPC，主进程内自洽）
            // 环防护：visited 挡住递归重入（环状 forkFrom 不会死循环）；
            // doomed 永不含被删根自身（根由下方 removeChildDir 统一删除）
            const topicsDir = path.join(USER_DATA_DIR, validateSegment(String(agentId)) || '', 'topics');
            async function collectDescendants(parentId, visited) {
                const entries = await fs.readdir(topicsDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    if (entry.name === childTopicId || visited.has(entry.name)) continue;
                    const metaPath = path.join(topicsDir, entry.name, 'sidechat-metadata.json');
                    try {
                        await fs.lstat(metaPath);
                    } catch (statErr) {
                        if (statErr?.code === 'ENOENT') continue;
                        throw new Error(`无法检查侧聊分支元数据 ${entry.name}: ${statErr?.message || statErr}`);
                    }

                    let meta;
                    try {
                        meta = await fs.readJson(metaPath);
                    } catch (readErr) {
                        throw new Error(`无法读取侧聊分支元数据 ${entry.name}: ${readErr?.message || readErr}`);
                    }
                    if (meta?.forkFromTopicId === parentId) {
                        visited.add(entry.name);
                        await collectDescendants(entry.name, visited);
                    }
                }
            }
            const doomed = new Set();
            try {
                await collectDescendants(childTopicId, doomed);
            } catch (walkErr) {
                return { success: false, error: 'CASCADE_SCAN_FAILED', message: walkErr?.message || String(walkErr) };
            }
            doomed.delete(childTopicId);
            // 后代与根同等确权：metadata 里的 forkFromTopicId 只是血缘线索，不是删除授权。
            // 每个候选都必须通过 requireChild（目录、真实路径、child 标记、归属一致）才能进入删除。
            let cascaded = 0;
            const failed = [];
            for (const descId of doomed) {
                const descDir = getTopicDir(agentId, descId);
                if (!descDir || !await fs.pathExists(descDir)) continue; // 已不存在：视为完成，幂等
                const marker = await requireChild(descDir, agentId, descId);
                if (!marker) {
                    failed.push({ topicId: descId, error: 'NOT_A_SIDE_CHAT_CHILD' });
                    continue;
                }
                try {
                    await removeChildDir(descDir);
                    await clearTrajectoryOf({ agentId, topicId: descId });
                    cascaded += 1;
                } catch (rmErr) {
                    failed.push({ topicId: descId, error: rmErr?.message || 'REMOVE_FAILED' });
                }
            }
            // 部分失败：中止整删（根保留），明确报告——绝不把「找到几个」当「删掉几个」。
            // 已成功删除的后代保持删除态；重试时 collectDescendants 自然不再收集它们。
            if (failed.length > 0) {
                console.error('[SideChatHandlers] delete-child cascade partial failure:', failed);
                return { success: false, error: 'CASCADE_PARTIAL_FAILED', cascaded, failed };
            }
            await removeChildDir(topicDir);
            await clearTrajectoryOf({ agentId, topicId: childTopicId });
            // 契约保持：无级联时不附加字段，旧调用方与测试的 deepEqual 不受影响
            return cascaded > 0
                ? { success: true, removed: true, cascaded }
                : { success: true, removed: true };
        } catch (error) {
            console.error('[SideChatHandlers] delete-child error:', error);
            return { success: false, error: error.message };
        }
    });

    register('side-chat:create-snapshot', async (event, agentId, parentTopicId, childTopicId = null, explicitMessages = null) => {
        try {
            const parentDir = getTopicDir(agentId, parentTopicId);
            if (!parentDir) return { success: false, error: 'INVALID_PARENT_PATH' };

            let rawHistory = [];
            // 分形分支：分叉时由前端组装好「祖先链完整上下文」显式传入，直接采用，不再读单父话题
            if (Array.isArray(explicitMessages)) {
                rawHistory = explicitMessages;
            } else if (historyMutationQueue && typeof historyMutationQueue.read === 'function') {
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

    // 分形分支：轻量更新某个侧聊子话题的分支拓扑字段。读-改-写合并进 metadata，
    // 不触碰 history.json、草稿、引用等其他文件。返回合并后的完整 metadata。
    register('side-chat:update-branch', async (event, agentId, childTopicId, patch = {}) => {
        try {
            if (!agentId || !childTopicId || !patch || typeof patch !== 'object') {
                return { success: false, error: 'MISSING_PARAMS' };
            }
            const topicDir = getTopicDir(agentId, childTopicId);
            if (!topicDir) return { success: false, error: 'INVALID_PATH' };
            const marker = await requireChild(topicDir, agentId, childTopicId);
            if (!marker) return { success: false, error: 'NOT_A_SIDE_CHAT_CHILD' };

            const metadataPath = path.join(topicDir, 'sidechat-metadata.json');
            const lockKey = `${agentId}:${childTopicId}`;
            // 读改写全程持锁：与 save-metadata 的全量写互斥（R3 丢失更新防护）
            return withMetadataLock(lockKey, async () => {
                let meta = {};
                if (await fs.pathExists(metadataPath)) {
                    try { meta = await fs.readJson(metadataPath); } catch { meta = {}; }
                }

                for (const field of BRANCH_PATCH_FIELDS) {
                    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
                    const value = patch[field];
                    if (field === 'depth') {
                        meta[field] = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
                    } else if (field === 'crystallized') {
                        meta[field] = Boolean(value);
                    } else if (value === null) {
                        meta[field] = null;
                    }  else if (typeof value === 'string' && value) {
                        meta[field] = field === 'forkLabel' || field === 'branchTitle' || field === 'title'
                            ? value.slice(0, 200)
                            : value;
                    }
                }
                if (patch.branchTitle && !patch.title) {
                    meta.title = meta.branchTitle;
                }
                meta.updatedAt = Date.now();
                await fs.writeJson(metadataPath, meta, { spaces: 2 });
                return { success: true, metadata: meta };
            });
        } catch (error) {
            console.error('[SideChatHandlers] update-branch error:', error);
            return { success: false, error: error.message };
        }
    });

    // 笔记固化：弹原生保存对话框，把自包含 Markdown 笔记写入选定路径
    register('side-chat:export-note', async (event, payload = {}) => {
        try {
            const content = typeof payload?.content === 'string' ? payload.content : '';
            const suggestedName = typeof payload?.fileName === 'string' && payload.fileName.trim()
                ? payload.fileName.trim()
                : '知识结晶.md';
            if (!content) return { success: false, error: 'EMPTY_CONTENT' };

            const { dialog } = electronModule || {};
            const win = event?.sender?.isDestroyed?.() ? null : resolveWindowWebContents(getMainWindow);
            const browserWindow = win && typeof win.getContentBounds === 'function' ? win : undefined;

            const sanitizeFileName = (name) => {
                let out = '';
                for (const ch of name) {
                    const code = ch.codePointAt(0);
                    out += ('<>:"/\\|?*'.includes(ch) || code < 32) ? '_' : ch;
                }
                return out;
            };
            const safeName = sanitizeFileName(suggestedName).slice(0, 120) || '知识结晶.md';
            const finalName = /\.md$/i.test(safeName) ? safeName : `${safeName}.md`;

            const result = await dialog.showSaveDialog(browserWindow, {
                title: '保存知识结晶笔记',
                defaultPath: finalName,
                filters: [{ name: 'Markdown', extensions: ['md'] }]
            });
            if (result.canceled || !result.filePath) return { success: true, canceled: true };

            // 禁止写到侧聊数据目录内部，避免污染数据区
            const targetPath = result.filePath;
            await fs.writeFile(targetPath, content, 'utf8');
            return { success: true, filePath: targetPath };
        } catch (error) {
            console.error('[SideChatHandlers] export-note error:', error);
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
