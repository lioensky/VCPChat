// VCPDistributedServer.js
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const dotenv = require('dotenv');
const os = require('os');
const mime = require('mime-types');
 // const { ipcMain } = require('electron'); // This was incorrect. ipcMain should be injected.
 const pluginManager = require('./Plugin.js');

// DEBUG_MODE is now passed in config
// const DEBUG_MODE = (process.env.DebugMode || "False").toLowerCase() === "true";

class DistributedServer {
    constructor(config = {}) {
        this.mainServerUrl = config.mainServerUrl;
        this.vcpKey = config.vcpKey;
        this.serverName = config.serverName || 'Unnamed-Distributed-Server';
        this.port = config.port || 0; // 0 表示随机选择一个可用端口
        this.debugMode = config.debugMode || false;
        this.rendererProcess = config.rendererProcess; // To communicate with the renderer
        this.handleMusicControl = config.handleMusicControl; // Inject the music control handler
        this.handleDiceControl = config.handleDiceControl; // Inject the dice control handler
        this.handleCanvasControl = config.handleCanvasControl; // Inject the canvas control handler
        this.handleFlowlockControl = config.handleFlowlockControl; // Inject the flowlock control handler
        this.handleDesktopRemoteControl = config.handleDesktopRemoteControl; // Inject the desktop remote control handler
        this.ws = null;
        this.app = express(); // 创建 Express 应用
        this.server = http.createServer(this.app); // 创建 HTTP 服务器
        this.reconnectInterval = 5000;
        this.maxReconnectInterval = 60000;
        this.reconnectTimeoutId = null; // To keep track of the reconnect timeout
        this.stopped = false; // Flag to prevent reconnection when stopped manually
        this.initialConnection = true; // Flag to handle one-time actions on first connect
        this.staticPlaceholderUpdateInterval = null; // 新增：静态占位符更新定时器
    }

    async initialize() {
        console.log(`[${this.serverName}] Initializing...`);

        // Load server-specific config
        const serverConfigPath = path.join(__dirname, 'config.env');
        try {
            if (fsSync.existsSync(serverConfigPath)) {
                const serverEnv = dotenv.parse(fsSync.readFileSync(serverConfigPath));
                if (serverEnv.DIST_SERVER_PORT) {
                    const newPort = parseInt(serverEnv.DIST_SERVER_PORT, 10);
                    if (!isNaN(newPort)) {
                        this.port = newPort;
                        console.log(`[${this.serverName}] Port loaded from config.env: ${this.port}`);
                    }
                }
            }
        } catch (e) {
            console.error(`[${this.serverName}] Error reading server config.env:`, e);
        }

        // The base path should be relative to this file's location.
        const basePath = path.dirname(require.resolve('./VCPDistributedServer.js'));
        pluginManager.setProjectBasePath(basePath);
        await pluginManager.loadPlugins();

        // 初始化服务类插件
        await pluginManager.initializeServices(this.app, null, basePath);

        this.server.listen(this.port, '0.0.0.0', () => {
            this.port = this.server.address().port; // 获取实际监听的端口
            console.log(`[${this.serverName}] HTTP server listening on 0.0.0.0:${this.port}`);
            // 在 HTTP 服务器启动后，再连接到主服务器
            this.connect();
        });
    }

    connect() {
        if (this.stopped) {
            console.log(`[${this.serverName}] Server is stopped, not connecting.`);
            return;
        }
        if (!this.mainServerUrl || !this.vcpKey) {
            console.error(`[${this.serverName}] Error: mainServerUrl or vcpKey is not configured. Cannot connect.`);
            return;
        }

        const connectionUrl = `${this.mainServerUrl.replace(/^http/, 'ws')}/vcp-distributed-server/VCP_Key=${this.vcpKey}`;
        console.log(`[${this.serverName}] Attempting to connect to main server at ${connectionUrl}`);

        // this.ws 现在是一个纯粹的客户端实例
        this.ws = new WebSocket(connectionUrl);

        this.ws.on('open', async () => {
            console.log(`[${this.serverName}] Successfully connected to main server.`);
            this.reconnectInterval = 5000;
            this.registerTools();
            await this.reportIPAddress();
            
            // 新增：设置静态占位符定期推送
            this.setupStaticPlaceholderUpdates();
        });

        this.ws.on('message', (message) => {
            this.handleMainServerMessage(message);
        });
        
        this.ws.on('close', () => {
            console.log(`[${this.serverName}] Disconnected from main server.`);
            // 新增：清理静态占位符更新定时器
            this.clearStaticPlaceholderUpdates();
            this.scheduleReconnect();
        });

        this.ws.on('error', (error) => {
            console.error(`[${this.serverName}] WebSocket client error:`, error.message);
            // 'close' 事件会自动被触发，所以这里不需要额外的处理
        });
    }

    scheduleReconnect() {
        if (this.stopped) {
            console.log(`[${this.serverName}] Stop called, cancelling reconnection.`);
            return;
        }
        console.log(`[${this.serverName}] Attempting to reconnect in ${this.reconnectInterval / 1000}s...`);
        // 新增：清理静态占位符更新定时器
        this.clearStaticPlaceholderUpdates();
        // Clear any existing timeout to avoid multiple reconnect loops
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId);
        }
        this.reconnectTimeoutId = setTimeout(() => this.connect(), this.reconnectInterval);
        // Exponential backoff
        this.reconnectInterval = Math.min(this.reconnectInterval * 2, this.maxReconnectInterval);
    }

    registerTools() {
        const manifests = pluginManager.getAllPluginManifests();

        // On the very first successful connection, send a notification about loaded plugins.
        if (this.initialConnection && manifests.length > 0) {
            const pluginCount = manifests.length;
            // Directly send a structured message to the renderer process for notification
            if (this.rendererProcess && !this.rendererProcess.isDestroyed()) {
                // Add a delay to give the renderer process time to set up its listeners
                setTimeout(() => {
                    if (this.rendererProcess && !this.rendererProcess.isDestroyed()) {
                        this.rendererProcess.send('vcp-log-message', {
                            type: 'vcp_log',
                            data: {
                                source: 'DistPluginManager',
                                content: `分布式服务器已启动，已推送 ${pluginCount} 个本地插件。`
                            }
                        });
                    }
                }, 1000); // 2-second delay
            }
            this.initialConnection = false; // Ensure this only runs once
        }

        if (manifests.length > 0) {
            const payload = {
                type: 'register_tools',
                data: {
                    serverName: this.serverName,
                    tools: manifests
                }
            };
            this.sendMessage(payload);
            console.log(`[${this.serverName}] Sent registration for ${manifests.length} tools to the main server.`);
        } else {
            if (this.debugMode) console.log(`[${this.serverName}] No local tools found to register.`);
        }
    }

    async reportIPAddress() {
        const { default: fetch } = await import('node-fetch');
        const networkInterfaces = os.networkInterfaces();
        const ipv4Addresses = [];
        let publicIp = null;

        for (const interfaceName in networkInterfaces) {
            const interfaces = networkInterfaces[interfaceName];
            for (const iface of interfaces) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    ipv4Addresses.push(iface.address);
                }
            }
        }

        try {
            const response = await fetch('https://api.ipify.org?format=json');
            if (response.ok) {
                const data = await response.json();
                publicIp = data.ip;
            } else {
                console.error(`[${this.serverName}] Failed to fetch public IP, status: ${response.status}`);
            }
        } catch (e) {
            console.error(`[${this.serverName}] Could not fetch public IP:`, e.message);
        }
        
        const payload = {
            type: 'report_ip',
            data: {
                serverName: this.serverName,
                localIPs: ipv4Addresses,
                publicIP: publicIp
            }
        };
        this.sendMessage(payload);
        console.log(`[${this.serverName}] Reported IP addresses to main server: Local: ${ipv4Addresses.join(', ')}, Public: ${publicIp || 'N/A'}`);
    }

    // 新增：设置静态占位符定期更新
    setupStaticPlaceholderUpdates() {
        // 每30秒推送一次静态占位符值
        this.staticPlaceholderUpdateInterval = setInterval(() => {
            this.pushStaticPlaceholderValues();
        }, 30000); // 30秒
        
        // 立即推送一次
        setTimeout(() => {
            this.pushStaticPlaceholderValues();
        }, 2000); // 2秒后第一次推送
        
        if (this.debugMode) console.log(`[${this.serverName}] Static placeholder updates scheduled every 30 seconds.`);
    }

    // 新增：清理静态占位符更新定时器
    clearStaticPlaceholderUpdates() {
        if (this.staticPlaceholderUpdateInterval) {
            clearInterval(this.staticPlaceholderUpdateInterval);
            this.staticPlaceholderUpdateInterval = null;
            if (this.debugMode) console.log(`[${this.serverName}] Static placeholder update interval cleared.`);
        }
    }

    // 新增：推送静态占位符值到主服务器
    async pushStaticPlaceholderValues() {
        const placeholderValues = pluginManager.getAllPlaceholderValues();
        if (placeholderValues.size === 0) {
            return;
        }

        // 检查是否在settings.json中禁用了静态插件日志
        const logStaticPlugins = await this.shouldLogStaticPlugins();

        const payload = {
            type: 'update_static_placeholders',
            data: {
                serverName: this.serverName,
                placeholders: Object.fromEntries(placeholderValues)
            }
        };
        
        this.sendMessage(payload);
        if (this.debugMode && logStaticPlugins) {
            console.log(`[${this.serverName}] Pushed ${placeholderValues.size} static placeholder values to main server.`);
            for (const [key, value] of placeholderValues) {
                console.log(`  - ${key}: ${value.substring(0, 100)}${value.length > 100 ? '...' : ''}`);
            }
        }
    }

    // 新增：检查是否应该记录静态插件日志
    async shouldLogStaticPlugins() {
        try {
            const settingsPath = path.join(__dirname, '..', 'AppData', 'settings.json');
            if (!fsSync.existsSync(settingsPath)) {
                return true; // 默认启用日志
            }
            const settings = JSON.parse(fsSync.readFileSync(settingsPath, 'utf8'));
            return settings.enableDistributedServerLogs !== false; // 默认启用，除非明确设置为false
        } catch (error) {
            if (this.debugMode) console.warn(`[${this.serverName}] Error reading settings for log control:`, error.message);
            return true; // 错误时默认启用日志
        }
    }

    async handleMainServerMessage(message) {
        try {
            const parsedMessage = JSON.parse(message);
            if (this.debugMode) console.log(`[${this.serverName}] Received message from main server:`, parsedMessage.type);

            if (parsedMessage.type === 'execute_tool') {
                await this.handleToolExecutionRequest(parsedMessage.data);
            }
        } catch (e) {
            console.error(`[${this.serverName}] Error parsing message from main server:`, e);
        }
    }

    async handleToolExecutionRequest(data) {
        const { requestId, toolName, toolArgs } = data;
        if (!requestId || !toolName) {
            console.error(`[${this.serverName}] Invalid tool execution request received.`);
            return;
        }

        if (this.debugMode) console.log(`[${this.serverName}] Executing tool '${toolName}' for request ID: ${requestId}`);

        let responsePayload;
        try {
            // --- 新增：处理内部文件请求 ---
            if (toolName === 'internal_request_file') {
                // 关键改进：对接 FileFetcherServer 的新协议
                const { fileUrl } = toolArgs;
                if (!fileUrl || !fileUrl.startsWith('file://')) {
                    throw new Error(`Invalid or missing fileUrl parameter for internal_request_file.`);
                }

                try {
                    // 在分布式服务器自己的环境中，安全地将 URL 转换为本地路径
                    const { fileURLToPath } = require('url');
                    const filePath = fileURLToPath(fileUrl);

                    const fileBuffer = await fs.readFile(filePath);
                    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
                    
                    responsePayload = {
                        type: 'tool_result',
                        data: {
                            requestId,
                            status: 'success',
                            result: {
                                status: 'success',
                                fileData: fileBuffer.toString('base64'),
                                mimeType: mimeType
                            }
                        }
                    };
                } catch (e) {
                    if (e.code === 'ENOENT') {
                        throw new Error(`File not found on distributed server: ${fileUrl}`);
                    } else if (e.code === 'ERR_INVALID_FILE_URL_PATH') {
                        throw new Error(`Invalid file URL path on distributed server: ${fileUrl}`);
                    } else {
                        throw new Error(`Error reading file on distributed server (${fileUrl}): ${e.message}`);
                    }
                }
                this.sendMessage(responsePayload);
                if (this.debugMode) console.log(`[${this.serverName}] Sent file content for request ID: ${requestId}`);
                return; // 处理完毕，直接返回
            }
            // --- 结束：处理内部文件请求 ---

            const result = await pluginManager.processToolCall(toolName, toolArgs);
            let finalResult;

            // --- Special Handling for MusicController ---
            if (toolName === 'MusicController') {
                const commandPayload = (typeof result === 'string') ? JSON.parse(result) : result;
                if (commandPayload.status === 'error') {
                    throw new Error(commandPayload.error);
                }
                
                if (typeof this.handleMusicControl !== 'function') {
                    throw new Error('Music control handler is not configured for the Distributed Server.');
                }

                // Directly call the injected handler function from main.js
                const resultFromMain = await this.handleMusicControl(commandPayload);

                if (resultFromMain.status === 'error') {
                    throw new Error(resultFromMain.message);
                }
                
                // For AI, we want a simple, natural language response.
                let naturalResponse = `指令 '${commandPayload.command}' 已成功执行。`;
                if (commandPayload.command === 'play' && commandPayload.target) {
                    naturalResponse = `已为您播放歌曲: ${commandPayload.target}`;
                } else if (commandPayload.command === 'play') {
                    naturalResponse = `已恢复播放。`;
                } else if (commandPayload.command === 'pause') {
                    naturalResponse = `已暂停播放。`;
                } else if (commandPayload.command === 'next') {
                    naturalResponse = `已切换到下一首。`;
                } else if (commandPayload.command === 'prev') {
                    naturalResponse = `已切换到上一首。`;
                }
                finalResult = { message: naturalResponse };

            } else if (toolName === 'SuperDice') {
                if (typeof this.handleDiceControl !== 'function') {
                    throw new Error('Dice control handler is not configured for the Distributed Server.');
                }
                // The toolArgs are already parsed, e.g., { notation: '2d20' }
                const resultFromMain = await this.handleDiceControl(toolArgs);

                if (resultFromMain.status === 'error') {
                    throw new Error(resultFromMain.message);
                }
                
                // The result from the dice roll is already structured, so we can pass it directly.
                finalResult = resultFromMain.data;

            } else if (toolName === 'Flowlock') {
                // --- Special Handling for Flowlock ---
                if (typeof this.handleFlowlockControl !== 'function') {
                    throw new Error('Flowlock control handler is not configured for the Distributed Server.');
                }
                
                // The toolArgs contain the command and parameters
                const resultFromMain = await this.handleFlowlockControl(toolArgs);
                
                if (resultFromMain.status === 'error') {
                    throw new Error(resultFromMain.message);
                }
                
                finalResult = { message: resultFromMain.message };
                
            } else if (toolName === 'DesktopRemote') {
                // --- Special Handling for DesktopRemote ---
                const commandPayload = (typeof result === 'string') ? JSON.parse(result) : result;
                if (commandPayload.status === 'error') {
                    throw new Error(commandPayload.error);
                }
                
                if (typeof this.handleDesktopRemoteControl !== 'function') {
                    throw new Error('Desktop remote control handler is not configured for the Distributed Server.');
                }

                // Directly call the injected handler function from main.js
                const resultFromMain = await this.handleDesktopRemoteControl(commandPayload);

                if (resultFromMain.status === 'error') {
                    throw new Error(resultFromMain.message);
                }
                
                // The handler returns { status, result: { content: [...] } } format
                // Pass through the result directly to preserve the content array structure
                finalResult = resultFromMain.result || { message: resultFromMain.message };

            } else {
                // --- Default Handling for all other plugins ---
                if (typeof result === 'object' && result !== null) {
                    // Result is already an object from a direct call (e.g., hybrid service)
                    finalResult = result;
                } else {
                    // Result is a string from stdio, needs parsing
                    try {
                        // --- Robust JSON Parsing ---
                        // The plugin might output debug info (like from dotenv) to stdout before the JSON.
                        // We need to find the actual JSON string.
                        const jsonStartIndex = result.indexOf('{');
                        const jsonEndIndex = result.lastIndexOf('}');
                        
                        if (jsonStartIndex === -1 || jsonEndIndex === -1) {
                            // If no JSON object is found, treat it as a raw string.
                            throw new SyntaxError("No JSON object found in plugin output.");
                        }

                        const jsonString = result.substring(jsonStartIndex, jsonEndIndex + 1);
                        const parsedPluginResult = JSON.parse(jsonString);
                        // --- End of Robust JSON Parsing ---

                        if (parsedPluginResult.status === 'success') {
                            finalResult = parsedPluginResult.result;
                            // --- VCP Protocol Enhancement ---
                            // If the plugin response has special action fields (e.g., for canvas),
                            // merge them into the final result object so they can be handled downstream.
                            if (parsedPluginResult._specialAction) {
                                if (typeof finalResult !== 'object' || finalResult === null) {
                                    finalResult = {}; // Ensure finalResult is an object
                                }
                                finalResult._specialAction = parsedPluginResult._specialAction;
                                finalResult.payload = parsedPluginResult.payload;
                            }
                        } else {
                            throw new Error(parsedPluginResult.error || 'Plugin reported an error without a message.');
                        }
                    } catch (e) {
                        if (e instanceof SyntaxError) {
                            finalResult = result; // Legacy plugin returning a raw string
                        } else {
                            throw e; // Other error
                        }
                    }
                }

                // --- Special Handling for create_canvas action (applied to the finalResult) ---
                if (finalResult && finalResult._specialAction === 'create_canvas') {
                    if (typeof this.handleCanvasControl === 'function') {
                        console.log(`[${this.serverName}] Detected create_canvas action. Calling main process handler.`);
                        this.handleCanvasControl(finalResult.payload.filePath);
                    } else {
                        console.error(`[${this.serverName}] Canvas control handler is not configured for the Distributed Server.`);
                    }
                }
                // --- End of special handling ---
            }

            responsePayload = {
                type: 'tool_result',
                data: {
                    requestId,
                    status: 'success',
                    result: finalResult
                }
            };
        } catch (error) {
            console.error(`[${this.serverName}] Error executing tool '${toolName}':`, error.message);
            responsePayload = {
                type: 'tool_result',
                data: {
                    requestId,
                    status: 'error',
                    error: error.message || 'An unknown error occurred.'
                }
            };
        }

        this.sendMessage(responsePayload);
        if (this.debugMode) console.log(`[${this.serverName}] Sent result for request ID: ${requestId}`);
    }

    sendMessage(payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        } else {
            console.error(`[${this.serverName}] Cannot send message, WebSocket is not open.`);
        }
    }

    async stop() {
        console.log(`[${this.serverName}] Stopping server...`);
        this.stopped = true;
        
        // 新增：清理静态占位符更新定时器
        this.clearStaticPlaceholderUpdates();
        
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = null;
        }
        
        // 新增：关闭插件管理器 - 使用异步方式，但不等待结果
        pluginManager.shutdownAllPlugins().catch(err => {
            console.error(`[${this.serverName}] Error during plugin shutdown:`, err);
        });
        
        if (this.ws) {
            // Remove listeners to prevent reconnection logic from firing on manual close
            this.ws.removeAllListeners('close');
            this.ws.removeAllListeners('error');
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.close(1000, 'Client initiated disconnect'); // 1000 is a normal closure
            }
            this.ws = null;
        }
        console.log(`[${this.serverName}] Server stopped.`);
    }
}

module.exports = DistributedServer;