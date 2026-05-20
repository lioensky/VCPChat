const http = require('http');
const path = require('path');
const fs = require('fs-extra');
const groupChat = require('../../Groupmodules/groupchat');
const fileManager = require('../fileManager');

let codexBridgeHttpServer = null;

function readJsonRequest(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 1024 * 1024) {
                reject(new Error('Request body too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, statusCode, payload) {
    const data = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data)
    });
    res.end(data);
}

function inferMimeTypeFromName(fileName, fallback = 'application/octet-stream') {
    const ext = path.extname(fileName || '').toLowerCase();
    switch (ext) {
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.gif': return 'image/gif';
        case '.webp': return 'image/webp';
        case '.svg': return 'image/svg+xml';
        case '.pdf': return 'application/pdf';
        case '.doc': return 'application/msword';
        case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        case '.ppt': return 'application/vnd.ms-powerpoint';
        case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        case '.xls': return 'application/vnd.ms-excel';
        case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        case '.md':
        case '.txt': return 'text/plain';
        default: return fallback || 'application/octet-stream';
    }
}

async function buildBridgeAttachments(payload, topicId) {
    const inlineAttachments = Array.isArray(payload.attachments)
        ? payload.attachments.filter(att => att && typeof att === 'object')
        : [];
    const fileInputs = Array.isArray(payload.attachmentFiles) ? payload.attachmentFiles : [];
    const storedAttachments = [];

    for (const fileInput of fileInputs) {
        if (!fileInput || typeof fileInput !== 'object') continue;
        const sourcePath = String(fileInput.path || '').trim();
        if (!sourcePath) throw new Error('attachmentFiles item is missing path');
        if (!await fs.pathExists(sourcePath)) throw new Error(`attachment file not found: ${sourcePath}`);

        const originalName = String(fileInput.name || path.basename(sourcePath));
        const providedType = String(fileInput.type || '');
        const fileTypeHint = (!providedType || providedType === 'application/octet-stream')
            ? inferMimeTypeFromName(originalName)
            : providedType;
        if (fileInput.requireImage === true && !fileTypeHint.startsWith('image/')) {
            throw new Error(`image attachment must be image/*, got ${fileTypeHint}: ${sourcePath}`);
        }

        const storedFile = await fileManager.storeFile(
            sourcePath,
            originalName,
            'codex_context_sync',
            topicId,
            fileTypeHint
        );
        storedAttachments.push({
            type: storedFile.type,
            src: storedFile.internalPath,
            name: storedFile.name,
            size: storedFile.size,
            _fileManagerData: storedFile,
            codexBridgeAttachmentKind: fileInput.kind || (storedFile.type.startsWith('image/') ? 'image' : 'file')
        });
    }

    return [...inlineAttachments, ...storedAttachments];
}

function buildStreamSender(mainWindow) {
    return (data) => {
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('vcp-stream-event', data);
        }
    };
}

async function handleCodexStatus({ payload, mainWindow, getAgentConfigById, port }) {
    const groupId = String(payload.groupId || 'codex_vcp_shared_group');
    const topicId = String(payload.topicId || '');
    const status = String(payload.status || payload.state || '').toLowerCase();
    if (!topicId || !['start', 'stop'].includes(status)) {
        return { statusCode: 400, body: { ok: false, error: 'groupId/topicId/status(start|stop) are required' } };
    }

    const agentConfig = await getAgentConfigById('Codex_Projection');
    const timestamp = Number(payload.timestamp || Date.now());
    const messageId = String(payload.id || `codex_status_${groupId}_${topicId}`);
    const displayText = String(payload.message || '思考中');
    buildStreamSender(mainWindow)({
        type: 'codex_thinking_status',
        status,
        messageId,
        content: displayText,
        timestamp,
        context: {
            groupId,
            topicId,
            agentId: 'Codex_Projection',
            agentName: agentConfig?.name || 'AI设计师 Codex',
            avatarColor: agentConfig?.avatarCalculatedColor,
            isGroupMessage: true,
            transient: true
        }
    });
    return {
        statusCode: 200,
        body: { ok: true, groupId, topicId, messageId, status, transient: true, savedToHistory: false, port }
    };
}

async function appendDisplayOnlyHistory({ userDataDir, groupId, topicId, messageId, senderName, text, timestamp, messageRole, userMessage, attachments }) {
    const groupHistoryPath = path.join(userDataDir, groupId, 'topics', topicId, 'history.json');
    await fs.ensureDir(path.dirname(groupHistoryPath));
    const groupHistory = await fs.pathExists(groupHistoryPath) ? await fs.readJson(groupHistoryPath) : [];
    if (!groupHistory.some(msg => msg.id === messageId)) {
        groupHistory.push({
            role: messageRole,
            name: senderName,
            content: text,
            timestamp,
            id: messageId,
            isGroupMessage: true,
            groupId,
            topicId,
            agentId: userMessage.agentId,
            avatarColor: userMessage.avatarColor,
            attachments,
            metadata: userMessage.metadata
        });
        await fs.writeJson(groupHistoryPath, groupHistory, { spaces: 2 });
    }
}

async function handleGroupMessage({ payload, mainWindow, getAgentConfigById, userDataDir }) {
    const groupId = String(payload.groupId || 'codex_vcp_shared_group');
    const topicId = String(payload.topicId || '');
    const text = String(payload.message || payload.text || '').trim();
    if (!topicId || !text) {
        return { statusCode: 400, body: { ok: false, error: 'groupId/topicId/message are required' } };
    }

    const timestamp = Number(payload.timestamp || Date.now());
    const senderName = String(payload.senderName || 'AI设计师 Codex');
    const senderActorId = String(payload.senderActorId || 'codex_ai_designer');
    const senderAgentId = senderActorId === 'codex_ai_designer' ? 'Codex_Projection' : senderActorId;
    const speakerRoleHint = String(payload.speakerRoleHint || (senderActorId === 'codex_ai_designer' ? 'codex' : senderActorId));
    const senderAgentConfig = senderAgentId && senderAgentId !== senderActorId
        ? await getAgentConfigById(senderAgentId)
        : (senderAgentId ? await getAgentConfigById(senderAgentId) : null);
    const displayOnly = payload.displayOnly === true || payload.suppressAgents === true;
    const attachments = await buildBridgeAttachments(payload, topicId);
    const messageRole = String(payload.role || (displayOnly ? 'system' : 'user'));
    const actorType = displayOnly
        ? 'context_sync'
        : (senderActorId === 'yangchen'
            ? 'human'
            : (senderActorId === 'codex_ai_designer' ? 'external_codex' : 'external_participant'));
    const visualMessageRole = !displayOnly && actorType !== 'human' ? 'assistant' : messageRole;
    const messageId = String(payload.id || `bridge_native_${timestamp}_${Math.random().toString(36).substring(2, 9)}`);
    const xiaoanMessageId = `msg_group_${messageId}_VCP_Assistant_${Date.now()}`;
    const userMessage = {
        role: messageRole,
        name: senderName,
        content: { text },
        originalUserText: text,
        timestamp,
        id: messageId,
        preferredResponseIds: {
            VCP_Assistant: xiaoanMessageId
        },
        agentId: senderAgentId,
        avatarColor: senderAgentConfig && !senderAgentConfig.error ? senderAgentConfig.avatarCalculatedColor : undefined,
        metadata: {
            bridge_room: true,
            bridge_message_id: messageId,
            source: 'vcpchat-native-http',
            actor_id: senderActorId,
            actor_name_cn: senderName,
            actor_type: actorType,
            speaker_role_hint: speakerRoleHint,
            source_side: 'codex',
            bridge_session_id: String(payload.bridgeSessionId || ''),
            direction: displayOnly ? 'codex_context_sync' : (senderActorId === 'codex_ai_designer' ? 'codex_to_vcp' : 'bridge_participant'),
            display_only: displayOnly,
            suppress_agents: displayOnly
        },
        attachments
    };
    const sendStreamChunkToRenderer = buildStreamSender(mainWindow);
    sendStreamChunkToRenderer({
        type: 'external_user_message',
        messageId,
        context: {
            groupId,
            topicId,
            isGroupMessage: true
        },
        message: {
            role: visualMessageRole,
            name: senderName,
            content: text,
            timestamp,
            id: messageId,
            isGroupMessage: true,
            groupId,
            topicId,
            agentId: senderAgentId,
            avatarColor: senderAgentConfig && !senderAgentConfig.error ? senderAgentConfig.avatarCalculatedColor : undefined,
            attachments,
            metadata: userMessage.metadata
        }
    });

    if (displayOnly) {
        await appendDisplayOnlyHistory({
            userDataDir,
            groupId,
            topicId,
            messageId,
            senderName,
            text,
            timestamp,
            messageRole,
            userMessage,
            attachments
        });
        return {
            statusCode: 200,
            body: { ok: true, groupId, topicId, messageId, displayOnly: true, agentsTriggered: false, attachmentCount: attachments.length, attachments }
        };
    }

    const xiaoanConfig = await getAgentConfigById('VCP_Assistant');
    if (xiaoanConfig && !xiaoanConfig.error && /小安|vcp|记忆|审议|召回/i.test(text)) {
        sendStreamChunkToRenderer({
            type: 'agent_thinking',
            messageId: xiaoanMessageId,
            context: {
                groupId,
                topicId,
                agentId: 'VCP_Assistant',
                agentName: xiaoanConfig.name || '小安',
                avatarColor: xiaoanConfig.avatarCalculatedColor,
                isGroupMessage: true
            }
        });
    }

    await groupChat.handleGroupChatMessage(groupId, topicId, userMessage, sendStreamChunkToRenderer, getAgentConfigById);
    return { statusCode: 200, body: { ok: true, groupId, topicId, messageId, attachmentCount: attachments.length, attachments } };
}

function startCodexBridgeHttpServer(mainWindow, getAgentConfigById, userDataDir) {
    if (codexBridgeHttpServer) return;

    const port = Number(process.env.CODEX_VCPCHAT_BRIDGE_PORT || 6137);
    const host = '127.0.0.1';
    codexBridgeHttpServer = http.createServer(async (req, res) => {
        try {
            if (req.method === 'GET' && req.url === '/health') {
                sendJson(res, 200, { ok: true, service: 'vcpchat-codex-bridge', port });
                return;
            }

            const isStatusRequest = req.method === 'POST' && req.url === '/codex-status';
            const isGroupMessageRequest = req.method === 'POST' && req.url === '/group-message';
            if (!isStatusRequest && !isGroupMessageRequest) {
                sendJson(res, 404, { ok: false, error: 'not_found' });
                return;
            }

            const payload = await readJsonRequest(req);
            const result = isStatusRequest
                ? await handleCodexStatus({ payload, mainWindow, getAgentConfigById, port })
                : await handleGroupMessage({ payload, mainWindow, getAgentConfigById, userDataDir });
            sendJson(res, result.statusCode, result.body);
        } catch (error) {
            console.error('[CodexBridge HTTP] request failed:', error);
            sendJson(res, 500, { ok: false, error: error.message });
        }
    });
    codexBridgeHttpServer.on('error', error => {
        console.error('[CodexBridge HTTP] server error:', error);
    });
    codexBridgeHttpServer.listen(port, host, () => {
        console.log(`[CodexBridge HTTP] listening on http://${host}:${port}`);
    });
}

module.exports = {
    startCodexBridgeHttpServer
};
