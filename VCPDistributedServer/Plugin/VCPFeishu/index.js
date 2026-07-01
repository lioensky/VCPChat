'use strict';

const path = require('path');
const fs = require('fs');

const FeishuBot = require('./feishuBot');

let config = {};
let debugMode = false;

function log(...args) { console.log('[VCPFeishu]', ...args); }
function warn(...args) { console.warn('[VCPFeishu]', ...args); }

function getConfigValue(...keys) {
    for (const key of keys) {
        if (config[key] !== undefined && config[key] !== null && config[key] !== '') return config[key];
        if (process.env[key] !== undefined && process.env[key] !== null && process.env[key] !== '') return process.env[key];
    }
    return '';
}

function normalizeBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true';
}

async function registerRoutes(app, pluginConfig, projectBasePath) {
    config = { ...config, ...pluginConfig };
    debugMode = normalizeBoolean(config.DebugMode, false);

    log('管理路由已注册');

    app.get('/api/plugins/feishu/status', (req, res) => {
        const status = getBotStatus();
        res.json(status);
    });

    app.post('/api/plugins/feishu/start', async (req, res) => {
        try {
            const result = await startBot(req.body?.config);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/plugins/feishu/stop', async (req, res) => {
        try {
            const result = await stopBot();
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/plugins/feishu', (req, res) => {
        const status = getBotStatus();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>VCPFeishu 管理</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
        .status { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; }
        .status.connected { background: #e8f5e9; color: #2e7d32; }
        .status.disconnected { background: #ffebee; color: #c62828; }
        .status.running { background: #e3f2fd; color: #1565c0; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
        th, td { padding: 8px 12px; border-bottom: 1px solid #eee; text-align: left; }
        th { background: #f5f5f5; }
        button { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; }
        button.start { background: #4CAF50; color: white; }
        button.stop { background: #f44336; color: white; }
        button:hover { opacity: 0.8; }
        .actions { display: flex; gap: 8px; }
    </style>
</head>
<body>
    <h1>VCPFeishu 插件管理</h1>
    <div class="status ${status.connected ? 'connected' : 'disconnected'}">
        WebSocket 连接状态: ${status.connected ? '✅ 已连接' : '❌ 未连接'}
    </div>
    <div class="status ${status.running ? 'running' : 'disconnected'}">
        机器人运行状态: ${status.running ? '✅ 运行中' : '❌ 已停止'}
    </div>
    <table>
        <tr><th>项目</th><th>值</th></tr>
        <tr><td>App ID</td><td>${status.appId || '未配置'}</td></tr>
        <tr><td>绑定 Agent</td><td>${status.bindAgent || '未配置'}</td></tr>
        <tr><td>消息接收数</td><td>${status.messagesReceived}</td></tr>
        <tr><td>消息处理数</td><td>${status.messagesProcessed}</td></tr>
        <tr><td>消息失败数</td><td>${status.messagesFailed}</td></tr>
        <tr><td>最后消息时间</td><td>${status.lastMessageAt || '-'}</td></tr>
        <tr><td>最后错误</td><td>${status.lastError?.message || '-'}</td></tr>
    </table>
    <div class="actions">
        <button class="start" onclick="startBot()">启动机器人</button>
        <button class="stop" onclick="stopBot()">停止机器人</button>
        <button onclick="location.reload()">刷新状态</button>
    </div>
    <script>
        async function startBot() {
            const r = await fetch('/api/plugins/feishu/start', { method: 'POST' });
            const data = await r.json();
            alert(data.status === 'success' ? '启动成功' : '启动失败: ' + data.error);
            location.reload();
        }
        async function stopBot() {
            const r = await fetch('/api/plugins/feishu/stop', { method: 'POST' });
            const data = await r.json();
            alert(data.status === 'success' ? '停止成功' : '停止失败: ' + data.error);
            location.reload();
        }
    </script>
</body>
</html>
        `);
    });

    const appId = String(getConfigValue('FeishuAppId') || '').trim();
    const appSecret = String(getConfigValue('FeishuAppSecret') || '').trim();

    if (appId && appSecret) {
        log('检测到飞书凭证，自动启动机器人...');
        await startBot();
    } else {
        log('未检测到飞书凭证，插件待机（请访问 /api/plugins/feishu 配置）');
    }
}

let botInitialized = false;

async function startBot(botConfig) {
    if (botInitialized) {
        return { status: 'success', message: '飞书机器人已在运行中' };
    }
    if (botConfig) {
        config = { ...config, ...botConfig };
    }
    await FeishuBot.initialize(config);
    botInitialized = true;
    log('飞书机器人已启动');
    return { status: 'success', message: '飞书机器人已启动' };
}

async function stopBot() {
    FeishuBot.shutdown();
    botInitialized = false;
    log('飞书机器人已停止');
    return { status: 'success', message: '飞书机器人已停止' };
}

function getBotStatus() {
    const botStats = FeishuBot.getStatus();
    return {
        connected: botStats.connected || false,
        running: botInitialized,
        appId: config.FeishuAppId ? config.FeishuAppId.slice(0, 8) + '***' : null,
        bindAgent: config.FeishuBindAgent || null,
        messagesReceived: botStats.messagesReceived || 0,
        messagesProcessed: botStats.messagesProcessed || 0,
        messagesFailed: botStats.messagesFailed || 0,
        lastMessageAt: botStats.lastMessageAt || null,
        lastError: botStats.lastError || null,
        startedAt: botStats.startedAt || null,
    };
}

async function processToolCall(args = {}) {
    const command = String(args.command || args.cmd || '').trim();
    const action = String(args.action || '').trim();

    if (command === 'FeishuSend' || action === 'send') {
        const target = String(args.target || '').trim();
        const content = String(args.content || args.message || '').trim();
        if (!target) throw new Error('FeishuSend 缺少 target 参数（chat_id 或 open_id）');
        if (!content) throw new Error('FeishuSend 缺少 content 参数');

        const botStats = FeishuBot.getStatus();
        if (!botStats.connected) {
            throw new Error('飞书 WebSocket 未连接，无法发送消息');
        }

        await FeishuBot.sendMessage(target, content);
        return {
            content: [{
                type: 'text',
                text: `已向 ${target} 推送飞书消息（${content.length} 字）。`,
            }],
        };
    }

    if (command === 'status' || command === 'Status' || action === 'status') {
        const status = getBotStatus();
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(status, null, 2),
            }],
        };
    }

    if (action === 'start') {
        if (botInitialized) {
            return { content: [{ type: 'text', text: '飞书机器人已在运行中' }] };
        }
        const appId = String(args.config?.FeishuAppId || getConfigValue('FeishuAppId') || '').trim();
        const appSecret = String(args.config?.FeishuAppSecret || getConfigValue('FeishuAppSecret') || '').trim();
        if (!appId || !appSecret) {
            throw new Error('缺少飞书凭证（FeishuAppId / FeishuAppSecret）');
        }
        return await startBot(args.config);
    }

    if (action === 'stop') {
        return await stopBot();
    }

    throw new Error(`VCPFeishu 未知 command/action: ${command || action || '(空)'}`);
}

module.exports = {
    registerRoutes,
    processToolCall,
    getBotStatus,
};