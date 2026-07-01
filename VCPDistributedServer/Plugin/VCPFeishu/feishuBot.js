'use strict';

const path = require('path');
const fs = require('fs');

let lark = null;
let wsClient = null;
let config = {};
let debugMode = false;

let stats = {
    connected: false,
    lastReconnectAttempt: 0,
    messagesReceived: 0,
    messagesProcessed: 0,
    messagesFailed: 0,
    lastMessageAt: null,
    lastError: null,
    startedAt: null,
};

function log(...args) { console.log('[VCPFeishu][Bot]', ...args); }
function warn(...args) { console.warn('[VCPFeishu][Bot]', ...args); }
function debug(...args) { if (debugMode) console.log('[VCPFeishu][Bot][debug]', ...args); }

function setStatsError(err) {
    stats.lastError = {
        message: String(err?.message || err || ''),
        at: new Date().toISOString(),
    };
}

function getConfigValue(...keys) {
    for (const key of keys) {
        if (config[key] !== undefined && config[key] !== null && config[key] !== '') return config[key];
        if (process.env[key] !== undefined && process.env[key] !== null && process.env[key] !== '') return process.env[key];
    }
    return '';
}

function normalizeBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback || false;
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true';
}

function normalizeInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeIntegerPositive(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
    const trimmed = String(value).trim();
    if (!trimmed) return [];
    return trimmed.split(',').map(v => v.trim()).filter(Boolean);
}

function loadRuntimeConfig() {
    return {
        appId: String(getConfigValue('FeishuAppId') || '').trim(),
        appSecret: String(getConfigValue('FeishuAppSecret') || '').trim(),
        bindAgent: String(getConfigValue('FeishuBindAgent') || '').trim(),
        maxReconnect: normalizeInteger(getConfigValue('FeishuMaxReconnect'), -1),
        streamReply: normalizeBoolean(getConfigValue('FeishuStreamReply'), true),
        streamHint: String(getConfigValue('FeishuStreamHint') || '正在思考中...'),
        allowedUsers: splitList(getConfigValue('FeishuAllowedUsers')),
        agentTimeoutMs: normalizeIntegerPositive(getConfigValue('FeishuAgentTimeoutMs'), 120000),
    };
}

function stripMentionPrefix(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return '';
    const m = trimmed.match(/^@\S+\s+([\s\S]+)$/);
    if (m && m[1].trim()) return m[1].trim();
    return trimmed;
}

function findAgentByNameOrId(agentsDir, bindAgent) {
    if (!fs.existsSync(agentsDir)) return null;
    
    try {
        const folders = fs.readdirSync(agentsDir);
        
        for (const folder of folders) {
            const folderPath = path.join(agentsDir, folder);
            if (!fs.statSync(folderPath).isDirectory()) continue;
            
            const configPath = path.join(folderPath, 'config.json');
            if (!fs.existsSync(configPath)) continue;
            
            let config;
            try {
                config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            } catch (_) {
                continue;
            }
            
            if (folder === bindAgent || config.name === bindAgent) {
                return { folder, config };
            }
        }
    } catch (e) {
        warn('查找 Agent 失败:', e.message);
    }
    
    return null;
}

function hashSentMessage(message) {
    if (!message || typeof message !== 'object') return '';
    const content = message.content;
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
    let hash = 0;
    for (let i = 0; i < contentStr.length; i++) {
        const char = contentStr.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
}

function buildVcpChatExtensionsFromMessages(messages) {
    const messageTimestampBindings = [];
    messages.forEach((message, index) => {
        const meta = message && message.__vcpchatTimestampMeta;
        if (!meta || !meta.messageId || typeof meta.timestamp !== 'number') {
            return;
        }
        messageTimestampBindings.push({
            messageId: meta.messageId,
            role: message.role || meta.role,
            timestamp: meta.timestamp,
            timestampIso: new Date(meta.timestamp).toISOString(),
            source: 'client_history',
            sentMessageHash: hashSentMessage(message),
            sentMessageIndex: index
        });
    });

    if (messageTimestampBindings.length === 0) {
        return null;
    }

    return {
        schemaVersion: 1,
        messageMetadataMode: 'hash_only',
        messageTimestampBindings
    };
}

function stripInternalMessageMetadata(messages) {
    return messages.map(message => {
        if (!message || typeof message !== 'object') return message;
        const { __vcpchatTimestampMeta, ...cleanMessage } = message;
        return cleanMessage;
    });
}

async function callAgentForMessage({ prompt, userid, chatid, chattype, runtimeConfig }) {
    const vcpChatRoot = path.resolve(__dirname, '..', '..', '..');
    debug(`vcpChatRoot: ${vcpChatRoot}`);
    const settingsPath = path.join(vcpChatRoot, 'AppData', 'settings.json');
    
    let vcpServerUrl = 'http://localhost:6005/v1/chat/completions';
    let vcpApiKey = '123456';
    let settings = {};
    
    try {
        if (fs.existsSync(settingsPath)) {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            if (settings.vcpServerUrl) vcpServerUrl = settings.vcpServerUrl;
            if (settings.vcpApiKey) vcpApiKey = settings.vcpApiKey;
        }
    } catch (e) {
        warn('读取 settings.json 失败，使用默认值:', e.message);
    }

    let finalVcpUrl = vcpServerUrl;
    if (settings.enableVcpToolInjection === true) {
        try {
            const urlObject = new URL(vcpServerUrl);
            urlObject.pathname = '/v1/chatvcp/completions';
            finalVcpUrl = urlObject.toString();
            log(`VCP tool injection is ON. URL switched to: ${finalVcpUrl}`);
        } catch (e) {
            warn('切换URL失败:', e.message);
        }
    }

    const agentsDir = path.join(vcpChatRoot, 'AppData', 'Agents');
    let systemPrompt = `你是 ${runtimeConfig.bindAgent}。`;
    let model = '';
    let temperature = 0.7;
    let maxTokens = 2048;
    let agentId = runtimeConfig.bindAgent;

    const foundAgent = findAgentByNameOrId(agentsDir, runtimeConfig.bindAgent);
    if (foundAgent) {
        agentId = foundAgent.folder;
        const agentConfig = foundAgent.config;
        if (agentConfig.systemPrompt) systemPrompt = agentConfig.systemPrompt;
        if (agentConfig.model) model = agentConfig.model;
        if (agentConfig.temperature != null) temperature = agentConfig.temperature;
        if (agentConfig.maxOutputTokens) maxTokens = agentConfig.maxOutputTokens;
        log(`找到 Agent: name=${agentConfig.name} id=${agentId} model=${model}`);
    } else {
        warn(`未找到 Agent "${runtimeConfig.bindAgent}"，使用默认配置`);
    }

    let finalPrompt = prompt;
    if (typeof finalPrompt === 'string') {
        finalPrompt = stripMentionPrefix(finalPrompt);
        if (!finalPrompt) throw new Error('消息内容为空');
    }

    const messageId = `feishu_${Date.now()}_${String(Math.random()).slice(2, 8)}`;
    
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: finalPrompt },
    ];

    const vcpchatExtensions = buildVcpChatExtensionsFromMessages(messages);
    const cleanMessages = stripInternalMessageMetadata(messages);

    const modelConfig = {
        model: model || 'gemini-pro',
        temperature,
        max_tokens: maxTokens,
        stream: false,
    };

    const requestBody = {
        messages: cleanMessages,
        ...modelConfig,
        stream: modelConfig.stream === true,
        requestId: messageId,
    };

    if (vcpchatExtensions) {
        requestBody.vcpchatExtensions = vcpchatExtensions;
    }

    log(`调用 VCP: ${finalVcpUrl} agent=${agentId} model=${requestBody.model}`);
    log(`请求体: ${JSON.stringify(requestBody).substring(0, 200)}...`);

    const response = await fetch(finalVcpUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${vcpApiKey}`,
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        const errorText = await response.text();
        let errorData = { message: `服务器返回状态 ${response.status}` };
        try {
            const parsed = JSON.parse(errorText);
            if (parsed) errorData = parsed;
        } catch (_) {}
        const errMsg = errorData.message || errorData.error?.message || errorText || 'VCP 请求失败';
        throw new Error(`${response.status} - ${errMsg}`);
    }

    const vcpResponse = await response.json();

    if (vcpResponse?.choices?.[0]?.message?.content) {
        return vcpResponse.choices[0].message.content;
    }
    if (vcpResponse?.choices?.[0]?.text) {
        return vcpResponse.choices[0].text;
    }
    if (typeof vcpResponse?.content === 'string') {
        return vcpResponse.content;
    }

    throw new Error('VCP 后端未返回有效回复');
}

function isUserAllowed(userid, runtimeConfig) {
    if (!runtimeConfig.allowedUsers || runtimeConfig.allowedUsers.length === 0) return true;
    return runtimeConfig.allowedUsers.includes(userid);
}

function isBotMentioned(mentions) {
    if (!mentions || !Array.isArray(mentions) || mentions.length === 0) return false;
    return mentions.some(m => m.name === config.botName || m.tenant_key);
}

async function sendSimpleMessage(chatId, text, replyToMsgId) {
    if (!lark) throw new Error('飞书 SDK 未加载');
    const content = JSON.stringify({ text });
    const axios = require('axios');
    
    const tokenRes = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: config.FeishuAppId,
        app_secret: config.FeishuAppSecret,
    });
    const token = tokenRes.data.tenant_access_token;

    let result;
    if (replyToMsgId) {
        result = await axios.post(
            `https://open.feishu.cn/open-apis/im/v1/messages/${replyToMsgId}/reply`,
            { msg_type: 'text', content },
            { headers: { Authorization: `Bearer ${token}` } }
        );
    } else {
        result = await axios.post(
            'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
            { receive_id: chatId, msg_type: 'text', content },
            { headers: { Authorization: `Bearer ${token}` } }
        );
    }
    return result.data;
}

async function handleMessage(event) {
    const runtimeConfig = loadRuntimeConfig();
    const msg = event.message || event;
    const { message_id, chat_type, sender, content, mentions } = event;
    const msgType = msg.msg_type || msg.message_type;
    const msgChatType = msg.chat_type || chat_type;
    const msgContent = msg.content || content;
    const msgMentions = msg.mentions || mentions;
    const msgId = msg.message_id || message_id;
    const msgChatId = msg.chat_id;

    if (msgType !== 'text') {
        debug('跳过非文本消息:', msgType);
        return;
    }

    stats.messagesReceived++;

    if (msgChatType === 'group' && !isBotMentioned(msgMentions)) {
        debug('群聊消息未 @机器人，跳过');
        return;
    }

    const senderId = sender?.sender_id?.open_id || sender?.sender_id?.user_id;
    const chatId = msgChatType === 'group' ? msgChatId : senderId;

    if (!senderId) {
        warn('消息缺少 sender_id');
        return;
    }

    if (!isUserAllowed(senderId, runtimeConfig)) {
        log('用户不在白名单中:', senderId);
        return;
    }

    let text = '';
    try {
        const parsed = typeof msgContent === 'string' ? JSON.parse(msgContent) : msgContent;
        text = parsed.text || '';
    } catch (err) {
        warn('解析消息内容失败:', err.message);
        text = String(msgContent || '');
    }

    if (!text.trim()) {
        debug('消息内容为空');
        return;
    }

    log(`收到消息: from=${senderId} chat_type=${msgChatType} text=${text.slice(0, 60)}`);

    if (runtimeConfig.streamReply) {
        try {
            await sendSimpleMessage(chatId, runtimeConfig.streamHint, msgId);
        } catch (err) {
            warn('发送流式提示失败:', err.message);
        }
    }

    try {
        stats.messagesProcessed++;
        const replyText = await callAgentForMessage({
            prompt: text,
            userid: senderId,
            chatid: chatId,
            chattype: msgChatType,
            runtimeConfig,
        });

        if (replyText) {
            await sendSimpleMessage(chatId, replyText, msgId);
            log(`回复已发送: to=${chatId} length=${replyText.length}`);
        }
    } catch (err) {
        stats.messagesFailed++;
        warn('处理消息失败:', err.message);
        setStatsError(err);
        try {
            await sendSimpleMessage(chatId, `抱歉，处理出错：${err.message}`, msgId);
        } catch (_) {}
    }

    stats.lastMessageAt = new Date().toISOString();
}

async function initialize(pluginConfig = {}) {
    config = pluginConfig || {};
    debugMode = normalizeBoolean(config.DebugMode, false);
    stats.startedAt = new Date().toISOString();
    log('初始化中...');

    try {
        lark = require('@larksuiteoapi/node-sdk');
    } catch (err) {
        warn('加载 @larksuiteoapi/node-sdk 失败:', err.message);
        warn('请在插件目录运行 npm install');
        setStatsError(err);
        return;
    }

    const runtimeConfig = loadRuntimeConfig();
    const missing = [];
    if (!runtimeConfig.appId) missing.push('FeishuAppId');
    if (!runtimeConfig.appSecret) missing.push('FeishuAppSecret');
    if (!runtimeConfig.bindAgent) missing.push('FeishuBindAgent');
    if (missing.length > 0) {
        warn(`配置缺失: ${missing.join(', ')}，不建立 WS 连接`);
        setStatsError(new Error(`配置缺失: ${missing.join(', ')}`));
        return;
    }

    log(`配置: bindAgent=${runtimeConfig.bindAgent} streamReply=${runtimeConfig.streamReply}`);

    try {
        const eventDispatcher = new lark.EventDispatcher({}).register({
            'im.message.receive_v1': async (data) => {
                try {
                    log('收到飞书事件:', JSON.stringify(data).slice(0, 500));
                    const event = data.event || data;
                    await handleMessage(event);
                } catch (err) {
                    warn('消息处理异常:', err.message);
                    setStatsError(err);
                }
            },
        });

        wsClient = new lark.WSClient({
            appId: runtimeConfig.appId,
            appSecret: runtimeConfig.appSecret,
            loggerLevel: debugMode ? lark.LoggerLevel.debug : lark.LoggerLevel.warn,
            autoReconnect: true,
        });

        await wsClient.start({ eventDispatcher });
        stats.connected = true;
        log('WebSocket 连接已建立');
    } catch (err) {
        warn('飞书机器人初始化失败:', err.message);
        setStatsError(err);
    }
}

function shutdown() {
    log('关闭中...');
    try {
        if (wsClient && typeof wsClient.close === 'function') {
            wsClient.close();
        }
    } catch (err) {
        warn('WS close 异常:', err.message);
    }
    wsClient = null;
    stats.connected = false;
}

async function sendMessage(target, content) {
    if (!lark) throw new Error('飞书 SDK 未加载');
    return sendSimpleMessage(target, content, null);
}

function getStatus() {
    return {
        ...stats,
        connected: stats.connected,
        runtimeConfigSummary: (() => {
            const rc = loadRuntimeConfig();
            return {
                appId: rc.appId ? rc.appId.slice(0, 8) + '***' : null,
                bindAgent: rc.bindAgent,
                streamReply: rc.streamReply,
                allowedUsersCount: rc.allowedUsers.length,
                agentTimeoutMs: rc.agentTimeoutMs,
            };
        })(),
    };
}

module.exports = {
    initialize,
    shutdown,
    sendMessage,
    getStatus,
};