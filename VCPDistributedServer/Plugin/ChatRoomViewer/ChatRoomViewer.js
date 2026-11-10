const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const chokidar = require('chokidar'); // 添加chokidar用于实时文件监控

// 全局变量用于存储最新数据
let cachedData = {
    statusInfo: null,
    themeInfo: null,
    agentsInfo: null,
    sessionWatcherInfo: null,
    modeBubbleTip: null,
    sessionTimeElapsed: null,
    groupSessionWatcher: null,
    lastUpdate: Date.now()
};

// 文件监控器
let fileWatchers = new Map();
let isWatcherMode = process.argv.includes('--watch');

// 当前监控的文件路径缓存
let currentSessionFile = null;
let currentAgentConfigs = new Set();

// 从环境变量读取配置
const debugMode = (process.env.DebugMode || "false").toLowerCase() === "true";
const enabled = (process.env.Enabled || "true").toLowerCase() === "true";
const customVCPChatRoot = process.env.VCPChatRoot; // 自定义VCPChat根目录
const timeZone = process.env.TimeZone || "Asia/Shanghai"; // 默认东八区

function FORCE_LOG(...args) {
    if (debugMode) {
        console.error(...args); // 强制日志输出到 stderr
    }
}

// 时间戳格式化函数 - 支持时区转换
function formatTimestamp(timestamp, format = 'time') {
    try {
        let date;
        if (typeof timestamp === 'string') {
            date = new Date(timestamp);
        } else if (typeof timestamp === 'number') {
            date = new Date(timestamp);
        } else {
            date = new Date();
        }
        
        // 使用指定时区格式化
        const options = {
            timeZone: timeZone,
            hour12: false // 使甤24小时制
        };
        
        if (format === 'time') {
            // 只显示时间部分（如 19:44:00）
            options.hour = '2-digit';
            options.minute = '2-digit';
            options.second = '2-digit';
        } else if (format === 'datetime') {
            // 显示完整日期时间
            options.year = 'numeric';
            options.month = '2-digit';
            options.day = '2-digit';
            options.hour = '2-digit';
            options.minute = '2-digit';
            options.second = '2-digit';
        } else if (format === 'iso') {
            // 返回ISO格式
            return date.toLocaleString('sv-SE', { timeZone: timeZone }).replace(' ', 'T') + '.000Z';
        }
        
        return date.toLocaleString('zh-CN', options);
    } catch (error) {
        FORCE_LOG('[时间戳格式化错误]:', error.message);
        return timestamp?.toString() || new Date().toLocaleTimeString();
    }
}

// 获取当前时间戳（格式化后）
function getCurrentTimestamp(format = 'iso') {
    return formatTimestamp(new Date(), format);
}

// 初始化文件监控器
function initializeFileWatchers() {
    if (!isWatcherMode) return;
    
    // 为避免初始化过程阻塞，异步执行
    setImmediate(async () => {
        try {
            const mainDir = getVCPChatMainDirectory();
            const settingsPath = path.join(mainDir, 'AppData', 'settings.json');
            
            // 监控settings.json文件变化（进一步降低稳定性阈值）
            const settingsWatcher = chokidar.watch(settingsPath, {
                persistent: true,
                ignoreInitial: true,
                awaitWriteFinish: {
                    stabilityThreshold: 50,  // 从100降低到50
                    pollInterval: 10         // 从50降低到10
                }
            });
            
            settingsWatcher.on('change', async () => {
                FORCE_LOG('[ChatRoomViewer] Settings file changed, updating theme info and status...');
                try {
                    // 更新主题信息和状态信息
                    cachedData.themeInfo = await generateThemeInfo();
                    cachedData.statusInfo = await generateVCPChatStatus();
                    cachedData.lastUpdate = Date.now();
                    
                    // 立即输出更新后的数据
                    outputCachedData();
                } catch (error) {
                    FORCE_LOG('[ChatRoomViewer] Error updating data after settings change:', error.message);
                }
            });
            
            fileWatchers.set('settings', settingsWatcher);
            
            // 监控主题CSS文件的变化（进一步降低稳定性阈值）
            const themeCSSPath = path.join(mainDir, 'styles', 'themes.css');
            const themeCSSWatcher = chokidar.watch(themeCSSPath, {
                persistent: true,
                ignoreInitial: true,
                awaitWriteFinish: {
                    stabilityThreshold: 30,  // 从50降低到30
                    pollInterval: 10         // 从25降低到10
                }
            });
            
            themeCSSWatcher.on('change', async () => {
                FORCE_LOG('[ChatRoomViewer] Theme CSS file changed, updating theme info...');
                try {
                    // 更新主题信息
                    cachedData.themeInfo = await generateThemeInfo();
                    cachedData.lastUpdate = Date.now();
                    
                    // 立即输出更新后的数据
                    outputCachedData();
                } catch (error) {
                    FORCE_LOG('[ChatRoomViewer] Error updating theme info after CSS change:', error.message);
                }
            });
            
            fileWatchers.set('themeCSS', themeCSSWatcher);
            
            // 初始化Agent配置文件监控
            await initializeAgentConfigWatchers();
            
            // 初始化会话文件监控
            await initializeSessionFileWatcher();
            
            FORCE_LOG('[ChatRoomViewer] File watchers initialized');
        } catch (error) {
            FORCE_LOG('[ChatRoomViewer] Error initializing file watchers:', error.message);
        }
    });
}

// 初始化Agent配置文件监控
async function initializeAgentConfigWatchers() {
    try {
        const mainDir = getVCPChatMainDirectory();
        const agentsDir = path.join(mainDir, 'AppData', 'Agents');
        
        // 监控整个Agents目录的变化（进一步优化监控参数）
        const agentDirWatcher = chokidar.watch(agentsDir, {
            persistent: true,
            ignoreInitial: true,
            depth: 2, // 监控到config.json的深度
            awaitWriteFinish: {
                stabilityThreshold: 30,  // 从50降低到30
                pollInterval: 10         // 从25降低到10
            },
            usePolling: true,           // 使用轮询提高响应速度
            interval: 100               // 轮询间隔100ms
        });
        
        agentDirWatcher.on('change', async (filePath) => {
            // 只关注config.json文件的变化
            if (path.basename(filePath) === 'config.json') {
                FORCE_LOG('[ChatRoomViewer] Agent config file changed:', filePath);
                try {
                    // 更新Agent信息
                    cachedData.agentsInfo = await getAllAgentsInfo();
                    cachedData.lastUpdate = Date.now();
                    
                    // 立即输出更新后的数据
                    outputCachedData();
                } catch (error) {
                    FORCE_LOG('[ChatRoomViewer] Error updating agents info after config change:', error.message);
                }
            }
        });
        
        agentDirWatcher.on('add', async (filePath) => {
            // 新增的config.json文件
            if (path.basename(filePath) === 'config.json') {
                FORCE_LOG('[ChatRoomViewer] New agent config file added:', filePath);
                try {
                    cachedData.agentsInfo = await getAllAgentsInfo();
                    cachedData.lastUpdate = Date.now();
                    outputCachedData();
                } catch (error) {
                    FORCE_LOG('[ChatRoomViewer] Error updating agents info after config addition:', error.message);
                }
            }
        });
        
        agentDirWatcher.on('unlink', async (filePath) => {
            // 删除的config.json文件
            if (path.basename(filePath) === 'config.json') {
                FORCE_LOG('[ChatRoomViewer] Agent config file deleted:', filePath);
                try {
                    cachedData.agentsInfo = await getAllAgentsInfo();
                    cachedData.lastUpdate = Date.now();
                    outputCachedData();
                } catch (error) {
                    FORCE_LOG('[ChatRoomViewer] Error updating agents info after config deletion:', error.message);
                }
            }
        });
        
        fileWatchers.set('agentConfigs', agentDirWatcher);
        FORCE_LOG('[ChatRoomViewer] Agent config watchers initialized');
        
    } catch (error) {
        FORCE_LOG('[ChatRoomViewer] Error initializing agent config watchers:', error.message);
    }
}

// 初始化会话文件监控
async function initializeSessionFileWatcher() {
    try {
        // 获取当前活跃的会话文件
        const sessionWatcher = await getCurrentSessionWatcher();
        
        if (sessionWatcher.status === 'active' && sessionWatcher.currentSession) {
            const sessionFilePath = sessionWatcher.currentSession.filePath;
            
            // 如果当前监控的文件发生了变化，需要重新设置监控
            if (currentSessionFile !== sessionFilePath) {
                // 清除旧的会话文件监控
                if (fileWatchers.has('sessionFile')) {
                    fileWatchers.get('sessionFile').close();
                    fileWatchers.delete('sessionFile');
                }
                
                // 设置新的会话文件监控（进一步优化监控参数）
                const sessionFileWatcher = chokidar.watch(sessionFilePath, {
                    persistent: true,
                    ignoreInitial: true,
                    awaitWriteFinish: {
                        stabilityThreshold: 30,  // 从50降低到30
                        pollInterval: 10         // 从25降低到10
                    },
                    usePolling: true,           // 使用轮询提高响应速度
                    interval: 100               // 轮询间隔100ms
                });
                
                sessionFileWatcher.on('change', async () => {
                    FORCE_LOG('[ChatRoomViewer] Session history file changed:', sessionFilePath);
                    try {
                        // 更新会话相关的信息 - 同时更新sessionWatcherInfo以供其他占位符复用
                        const latestSessionWatcher = await getCurrentSessionWatcher();
                        cachedData.sessionWatcherInfo = latestSessionWatcher;
                        cachedData.statusInfo = await generateVCPChatStatus();
                        cachedData.sessionTimeElapsed = await generateSessionTimeElapsed();
                        cachedData.lastUpdate = Date.now();
                        
                        // 立即输出更新后的数据
                        outputCachedData();
                    } catch (error) {
                        FORCE_LOG('[ChatRoomViewer] Error updating session info after history change:', error.message);
                    }
                });
                
                fileWatchers.set('sessionFile', sessionFileWatcher);
                currentSessionFile = sessionFilePath;
                FORCE_LOG('[ChatRoomViewer] Session file watcher initialized for:', sessionFilePath);
            }
        }
        
        // 同时监控UserData目录以检测新的会话文件（进一步优化监控参数）
        const mainDir = getVCPChatMainDirectory();
        const userDataDir = path.join(mainDir, 'AppData', 'UserData');
        
        if (!fileWatchers.has('userDataDir')) {
            const userDataDirWatcher = chokidar.watch(userDataDir, {
                persistent: true,
                ignoreInitial: true,
                depth: 3, // 监控到history.json的深度
                awaitWriteFinish: {
                    stabilityThreshold: 30,  // 从50降低到30
                    pollInterval: 10         // 从25降低到10
                },
                usePolling: true,           // 使用轮询提高响应速度
                interval: 100               // 轮询间隔100ms
            });
            
            userDataDirWatcher.on('change', async (filePath) => {
                // 只关注history.json文件的变化
                if (path.basename(filePath) === 'history.json') {
                    FORCE_LOG('[ChatRoomViewer] History file changed in UserData:', filePath);
                    
                    // 重新检查当前活跃的会话是否发生了变化
                    const newSessionWatcher = await getCurrentSessionWatcher();
                    if (newSessionWatcher.status === 'active' && newSessionWatcher.currentSession) {
                        const newSessionFile = newSessionWatcher.currentSession.filePath;
                        
                        // 如果活跃的会话文件发生了变化，重新初始化监控
                        if (newSessionFile !== currentSessionFile) {
                            await initializeSessionFileWatcher();
                        } else {
                            // 更新会话相关信息，确保三个占位符的同步更新
                            try {
                                cachedData.sessionWatcherInfo = newSessionWatcher;
                                cachedData.statusInfo = await generateVCPChatStatus();
                                cachedData.sessionTimeElapsed = await generateSessionTimeElapsed();
                                cachedData.lastUpdate = Date.now();
                                outputCachedData();
                            } catch (error) {
                                FORCE_LOG('[ChatRoomViewer] Error updating session info:', error.message);
                            }
                        }
                    }
                }
            });
            
            userDataDirWatcher.on('add', async (filePath) => {
                if (path.basename(filePath) === 'history.json') {
                    FORCE_LOG('[ChatRoomViewer] New history file added:', filePath);
                    // 重新检查活跃会话
                    await initializeSessionFileWatcher();
                }
            });
            
            fileWatchers.set('userDataDir', userDataDirWatcher);
            FORCE_LOG('[ChatRoomViewer] UserData directory watcher initialized');
        }
        
    } catch (error) {
        FORCE_LOG('[ChatRoomViewer] Error initializing session file watcher:', error.message);
    }
}

// 初始化群聊会话文件监控
async function initializeGroupSessionWatcher() {
    if (!isWatcherMode) return;
    
    // 为避免初始化过程阻塞，异步执行
    setImmediate(async () => {
        try {
            // 获取当前活跃的群聊会话文件
            const groupSessionWatcher = await generateGroupSessionWatcher();
            
            if (groupSessionWatcher.status === 'active' && groupSessionWatcher.currentSession) {
                const groupSessionFilePath = groupSessionWatcher.currentSession.filePath;
                
                // 设置群聊会话文件监控
                const groupSessionFileWatcher = chokidar.watch(groupSessionFilePath, {
                    persistent: true,
                    ignoreInitial: true,
                    awaitWriteFinish: {
                        stabilityThreshold: 50, // 降低稳定性阈值提高响应速度
                        pollInterval: 25
                    }
                });
                
                groupSessionFileWatcher.on('change', async () => {
                    FORCE_LOG('[ChatRoomViewer] Group session history file changed:', groupSessionFilePath);
                    try {
                        // 更新群聊会话相关信息
                        cachedData.groupSessionWatcher = await generateGroupSessionWatcher();
                        cachedData.lastUpdate = Date.now();
                        
                        // 立即输出更新后的数据
                        outputCachedData();
                    } catch (error) {
                        FORCE_LOG('[ChatRoomViewer] Error updating group session info after history change:', error.message);
                    }
                });
                
                fileWatchers.set('groupSessionFile', groupSessionFileWatcher);
                FORCE_LOG('[ChatRoomViewer] Group session file watcher initialized for:', groupSessionFilePath);
            }
            
            // 监控AgentGroups目录以检测新的群聊会话文件
            const mainDir = getVCPChatMainDirectory();
            const agentGroupsDir = path.join(mainDir, 'AppData', 'AgentGroups');
            
            if (!fileWatchers.has('agentGroupsDir')) {
                const agentGroupsDirWatcher = chokidar.watch(agentGroupsDir, {
                    persistent: true,
                    ignoreInitial: true,
                    depth: 4, // 监控到group history.json文件的深度
                    awaitWriteFinish: {
                        stabilityThreshold: 50, // 降低稳定性阈值提高响应速度
                        pollInterval: 25
                    }
                });
                
                agentGroupsDirWatcher.on('change', async (filePath) => {
                    // 只关注群聊相关的history.json文件变化
                    if (path.basename(filePath) === 'history.json' && filePath.includes('group_topic_')) {
                        FORCE_LOG('[ChatRoomViewer] Group history file changed in AgentGroups:', filePath);
                        
                        try {
                            cachedData.groupSessionWatcher = await generateGroupSessionWatcher();
                            cachedData.lastUpdate = Date.now();
                            outputCachedData();
                        } catch (error) {
                            FORCE_LOG('[ChatRoomViewer] Error updating group session info:', error.message);
                        }
                    }
                });
                
                agentGroupsDirWatcher.on('add', async (filePath) => {
                    if (path.basename(filePath) === 'history.json' && filePath.includes('group_topic_')) {
                        FORCE_LOG('[ChatRoomViewer] New group history file added:', filePath);
                        // 重新初始化群聊监控
                        await initializeGroupSessionWatcher();
                    }
                });
                
                fileWatchers.set('agentGroupsDir', agentGroupsDirWatcher);
                FORCE_LOG('[ChatRoomViewer] AgentGroups directory watcher initialized');
            }
            
        } catch (error) {
            FORCE_LOG('[ChatRoomViewer] Error initializing group session watcher:', error.message);
        }
    });
}

// 输出缓存的数据
function outputCachedData() {
    const outputData = {
        "{{VCPChatStatus}}": JSON.stringify(cachedData.statusInfo || {}),
        "{{VCPChatTheme}}": JSON.stringify(cachedData.themeInfo || {}),
        "{{VCPChatSessionWatcher}}": JSON.stringify(cachedData.sessionWatcherInfo || {}),
        "{{VCPChatAgent}}": JSON.stringify(cachedData.agentsInfo || {}),
        "{{VCPChatModeBubbleTip}}": JSON.stringify(cachedData.modeBubbleTip || {}),
        "{{VCPChatSessionTimeElapsed}}": JSON.stringify(cachedData.sessionTimeElapsed || {}),
        "{{VCPChatGroupSessionWatcher}}": JSON.stringify(cachedData.groupSessionWatcher || {})
    };
    
    process.stdout.write(JSON.stringify(outputData));
}

// 清理文件监控器
function cleanupFileWatchers() {
    for (const [name, watcher] of fileWatchers) {
        try {
            watcher.close();
            FORCE_LOG(`[ChatRoomViewer] Closed file watcher: ${name}`);
        } catch (error) {
            FORCE_LOG(`[ChatRoomViewer] Error closing file watcher ${name}:`, error.message);
        }
    }
    fileWatchers.clear();
    // 重置缓存的文件路径
    currentSessionFile = null;
    currentAgentConfigs.clear();
}

// 检测VCPChat主目录
function getVCPChatMainDirectory() {
    // 优先使用环境变量中的自定义路径
    if (customVCPChatRoot) {
        FORCE_LOG('[ChatRoomViewer] Using custom VCPChat root from env:', customVCPChatRoot);
        return customVCPChatRoot;
    }
    
    // 从当前插件路径推断主目录
    const currentDir = __dirname;
    // 插件路径格式：/path/to/VCPChat/VCPDistributedServer/Plugin/ChatRoomViewer
    // 需要回到 /path/to/VCPChat
    const vcpChatMainDir = path.resolve(currentDir, '../../..');
    
    FORCE_LOG('[ChatRoomViewer] Auto-detected VCPChat root:', vcpChatMainDir);
    return vcpChatMainDir;
}

// 读取VCPChat设置文件
async function readVCPChatSettings() {
    try {
        const mainDir = getVCPChatMainDirectory();
        // VCPChat的settings.json位于AppData目录下，不是用户主目录
        const settingsPath = path.join(mainDir, 'AppData', 'settings.json');
        
        FORCE_LOG('[ChatRoomViewer] Attempting to read settings from:', settingsPath);
        
        const settingsContent = await fs.readFile(settingsPath, 'utf-8');
        const settings = JSON.parse(settingsContent);
        return settings;
    } catch (error) {
        FORCE_LOG('[ChatRoomViewer] Error reading settings:', error.message);
        
        // 尝试备用路径：用户主目录
        try {
            const fallbackPath = path.join(os.homedir(), 'VCPChat', 'settings.json');
            FORCE_LOG('[ChatRoomViewer] Trying fallback path:', fallbackPath);
            const settingsContent = await fs.readFile(fallbackPath, 'utf-8');
            return JSON.parse(settingsContent);
        } catch (fallbackError) {
            FORCE_LOG('[ChatRoomViewer] Fallback path also failed:', fallbackError.message);
            return null;
        }
    }
}

// 读取当前主题配置
async function readCurrentTheme(themeName, settings = null) {
    try {
        if (!themeName) {
            // 读取当前激活的主题文件
            const mainDir = getVCPChatMainDirectory();
            const activeThemePath = path.join(mainDir, 'styles', 'themes.css');
            
            FORCE_LOG('[ChatRoomViewer] Reading active theme from:', activeThemePath);
            
            const themeContent = await fs.readFile(activeThemePath, 'utf-8');
            
            // 解析当前主题信息
            const themeInfo = parseThemeFromCSS(themeContent, settings);
            return themeInfo;
        }
        
        const mainDir = getVCPChatMainDirectory();
        // 尝试多个可能的主题路径
        const possiblePaths = [
            path.join(mainDir, 'styles', 'themes', `themes${themeName}.css`),
            path.join(mainDir, 'styles', 'themes', `${themeName}.css`),
            path.join(mainDir, 'public', 'assets', 'themes', themeName, 'theme.config.json'),
            path.join(mainDir, 'styles', 'themes.css') // 当前激活的主题
        ];
        
        for (const themePath of possiblePaths) {
            try {
                FORCE_LOG('[ChatRoomViewer] Attempting to read theme from:', themePath);
                
                const themeContent = await fs.readFile(themePath, 'utf-8');
                
                if (themePath.endsWith('.json')) {
                    return JSON.parse(themeContent);
                } else {
                    return parseThemeFromCSS(themeContent, null);
                }
            } catch (err) {
                continue; // 尝试下一个路径
            }
        }
        
        return null;
    } catch (error) {
        FORCE_LOG('[ChatRoomViewer] Error reading theme config:', error.message);
        return null;
    }
}

// 从CSS文件中解析主题信息
function parseThemeFromCSS(cssContent, settings = null) {
    const themeInfo = {
        name: "当前主题",
        isDarkMode: true, // 默认暗色模式
        colors: {},
        wallpaper: {}
    };
    
    // 优先从settings.json读取currentThemeMode字段
    if (settings && settings.currentThemeMode) {
        themeInfo.isDarkMode = settings.currentThemeMode === 'dark';
        FORCE_LOG('[ChatRoomViewer] Theme mode from settings.json:', settings.currentThemeMode);
    } else {
        // 备用方法：从CSS内容判断
        if (cssContent.includes('body.light-theme')) {
            themeInfo.isDarkMode = false;
        }
        FORCE_LOG('[ChatRoomViewer] Theme mode from CSS fallback:', themeInfo.isDarkMode ? 'dark' : 'light');
    }
    
    // 解析主题名称
    const nameMatch = cssContent.match(/\/\*[\s\S]*?([^\*\/]+)\s*Theme[\s\S]*?\*\//i);
    if (nameMatch) {
        themeInfo.name = nameMatch[1].trim();
    }
    
    // 解析CSS变量
    const varMatches = cssContent.matchAll(/--([\w-]+):\s*([^;]+);/g);
    for (const match of varMatches) {
        const varName = match[1];
        const varValue = match[2].trim();
        
        if (varName.includes('color') || varName.includes('bg')) {
            themeInfo.colors[varName] = varValue;
        }
        
        if (varName.includes('wallpaper')) {
            themeInfo.wallpaper[varName] = varValue;
        }
    }
    
    return themeInfo;
}

// 获取当前节点信息 - 基于真实的Agent配置
async function getCurrentNodeInfo() {
    try {
        const mainDir = getVCPChatMainDirectory();
        const agentsDir = path.join(mainDir, 'AppData', 'Agents');
        
        // 获取所有Agent目录（兼容 _Agent_ 前缀与新版动态命名目录）
        const agentDirs = await fs.readdir(agentsDir, { withFileTypes: true });
        const validAgents = agentDirs.filter(dir => dir.isDirectory());
        
        if (validAgents.length > 0) {
            const preferredDir = validAgents.find(dir => dir.name.startsWith('_Agent_')) || validAgents[0];
            const agentDirName = preferredDir.name;
            const parts = agentDirName.match(/_Agent_(\d+)_(\d+)/) || agentDirName.match(/_(\d{10,})$/);
            
            if (parts) {
                const nodeId = parts[1];
                const timestamp = parts[2] || parts[1];
                
                return {
                    nodeId: agentDirName,
                    agentId: nodeId,
                    timestamp: timestamp,
                    hostname: os.hostname(),
                    createdAt: getCurrentTimestamp('iso'),
                    displayTime: formatTimestamp(parseInt(timestamp), 'time'),
                    source: `VCPChat节点: ${agentDirName}`
                };
            }
        }
        
        // 如果没有找到有效的Agent，则生成一个临时节点ID
        const fallbackNodeId = `temp-${Date.now()}`;
        return {
            nodeId: fallbackNodeId,
            hostname: os.hostname(),
            source: `临时节点: ${fallbackNodeId}`
        };
    } catch (error) {
        FORCE_LOG('[ChatRoomViewer] Error getting node info:', error.message);
        
        const fallbackNodeId = `error-${Date.now()}`;
        return {
            nodeId: fallbackNodeId,
            hostname: os.hostname(),
            error: error.message,
            source: `错误节点: ${fallbackNodeId}`
        };
    }
}

// 检测系统状态
function getSystemStatus() {
    const memUsage = process.memoryUsage();
    
    return {
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        memoryUsage: {
            rss: Math.round(memUsage.rss / 1024 / 1024 * 100) / 100, // MB
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100, // MB
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024 * 100) / 100 // MB
        }
    };
}

// 生成VCPChat状态信息
async function generateVCPChatStatus() {
    const systemStatus = getSystemStatus();
    const settings = await readVCPChatSettings();
    const nodeInfo = await getCurrentNodeInfo();
    const sessionWatcher = await getCurrentSessionWatcher();
    
    let statusInfo = {
        timestamp: getCurrentTimestamp('iso'),
        displayTime: formatTimestamp(new Date(), 'time'),
        system: systemStatus,
        clientStatus: "运行中",
        nodeInfo: {
            hostname: nodeInfo.hostname
        },
        timeZone: timeZone
    };
    
    if (settings) {
        statusInfo.settings = {
            userName: settings.userName || "未设置",
            vcpServerUrl: settings.vcpServerUrl || "未设置",
            vcpLogEnabled: !!(settings.vcpLogUrl && settings.vcpLogKey),
            distributedServerEnabled: settings.enableDistributedServer || false,
            assistantEnabled: settings.assistantEnabled || false,
            musicControlEnabled: settings.agentMusicControl || false,
            vcpToolInjectionEnabled: settings.enableVcpToolInjection || false,
            sidebarWidth: settings.sidebarWidth || 260,
            notificationsSidebarWidth: settings.notificationsSidebarWidth || 300
        };
    } else {
        statusInfo.settings = {
            error: "无法读取设置文件"
        };
    }
    
    // 添加会话监控信息
    statusInfo.sessionWatcher = sessionWatcher;
    
    return statusInfo;
}

// 生成主题信息
async function generateThemeInfo() {
    const settings = await readVCPChatSettings();
    let themeInfo = {
        timestamp: getCurrentTimestamp('iso'),
        displayTime: formatTimestamp(new Date(), 'time')
    };
    
    try {
        // 读取当前激活的主题
        const themeConfig = await readCurrentTheme(null, settings);
        
        if (themeConfig) {
            themeInfo.currentTheme = themeConfig.name || "未知主题";
            themeInfo.mode = themeConfig.isDarkMode ? "暗色模式" : "亮色模式";
            themeInfo.isDarkMode = themeConfig.isDarkMode;
            
            // 提取主要颜色信息
            const colors = themeConfig.colors || {};
            themeInfo.colors = {
                primaryBg: colors['primary-bg'] || colors['--primary-bg'] || "#unknown",
                secondaryBg: colors['secondary-bg'] || colors['--secondary-bg'] || "#unknown",
                primaryText: colors['primary-text'] || colors['--primary-text'] || "#unknown",
                highlightText: colors['highlight-text'] || colors['--highlight-text'] || "#unknown",
                borderColor: colors['border-color'] || colors['--border-color'] || "#unknown"
            };
            
            // 提取壁纸信息
            const wallpaper = themeConfig.wallpaper || {};
            const wallpaperDark = wallpaper['chat-wallpaper-dark'] || wallpaper['--chat-wallpaper-dark'];
            const wallpaperLight = wallpaper['chat-wallpaper-light'] || wallpaper['--chat-wallpaper-light'];
            
            themeInfo.wallpaper = {
                current: themeConfig.isDarkMode ? wallpaperDark : wallpaperLight,
                dark: wallpaperDark,
                light: wallpaperLight
            };
            
            // 提取完整的CSS信息
            const mainDir = getVCPChatMainDirectory();
            const activeThemePath = path.join(mainDir, 'styles', 'themes.css');
            try {
                const fullCSS = await fs.readFile(activeThemePath, 'utf-8');
                themeInfo.fullCSS = fullCSS; // 不再截断，返回完整内容
            } catch (cssError) {
                themeInfo.fullCSS = "无法读取完整CSS";
            }
            
        } else {
            themeInfo.error = "无法读取主题配置";
        }
        
        // 如果有设置文件，尝试获取设置中的主题信息
        if (settings && settings.currentTheme) {
            themeInfo.settingsTheme = settings.currentTheme;
        }
        
    } catch (error) {
        FORCE_LOG('[ChatRoomViewer] Error generating theme info:', error.message);
        themeInfo.error = `生成主题信息时出错: ${error.message}`;
    }
    
    return themeInfo;
}


// 获取当前会话监控信息
async function getCurrentSessionWatcher() {
    try {
        const mainDir = getVCPChatMainDirectory();
        const userDataDir = path.join(mainDir, 'AppData', 'UserData');
        
        // 查找最新修改的history.json文件
        let latestFile = null;
        let latestTime = 0;
        
        const reservedUserDataDirs = new Set(['attachments', 'backups']);
        const agentDirs = await fs.readdir(userDataDir, { withFileTypes: true });
        
        for (const agentDir of agentDirs) {
            if (agentDir.isDirectory() && !reservedUserDataDirs.has(agentDir.name)) {
                const topicsDir = path.join(userDataDir, agentDir.name, 'topics');
                try {
                    const topicDirs = await fs.readdir(topicsDir, { withFileTypes: true });
                    
                    for (const topicDir of topicDirs) {
                        if (topicDir.isDirectory()) {
                            const historyPath = path.join(topicsDir, topicDir.name, 'history.json');
                            try {
                                const stats = await fs.stat(historyPath);
                                if (stats.mtime.getTime() > latestTime) {
                                    latestTime = stats.mtime.getTime();
                                    latestFile = {
                                        filePath: historyPath,
                                        agentId: agentDir.name,
                                        topicId: topicDir.name,
                                        lastModified: stats.mtime,
                                        size: stats.size
                                    };
                                }
                            } catch (statError) {
                                // 跳过无法访问的文件
                            }
                        }
                    }
                } catch (topicsError) {
                    // 跳过无法访问的topics目录
                }
            }
        }
        
        if (latestFile) {
            return {
                status: "active",
                currentSession: {
                    agentId: latestFile.agentId,
                    topicId: latestFile.topicId,
                    filePath: latestFile.filePath,
                    lastModified: formatTimestamp(latestFile.lastModified, 'iso'),
                    lastModifiedDisplay: formatTimestamp(latestFile.lastModified, 'time'),
                    modifiedTimestamp: latestFile.lastModified.getTime(),
                    size: latestFile.size
                },
                timestamp: getCurrentTimestamp('iso'),
                displayTime: formatTimestamp(new Date(), 'time')
            };
        } else {
            return {
                status: "no_active_session",
                message: "未找到活跃的会话文件",
                timestamp: getCurrentTimestamp('iso'),
                displayTime: formatTimestamp(new Date(), 'time')
            };
        }
    } catch (error) {
        FORCE_LOG('[ChatRoomViewer] Error in getCurrentSessionWatcher:', error.message);
        return {
            status: "error",
            error: error.message,
            timestamp: getCurrentTimestamp('iso'),
            displayTime: formatTimestamp(new Date(), 'time')
        };
    }
}

// 新增：生成会话时间流逝信息（优化实现，直接复用缓存数据）
async function generateSessionTimeElapsed() {
    try {
        // 直接复用缓存的sessionWatcherInfo，避免重复查询
        let sessionWatcher = cachedData.sessionWatcherInfo;
        
        // 如果缓存为空或过期（降低过期时间阈值），则获取最新数据
        if (!sessionWatcher || Date.now() - cachedData.lastUpdate > 50) {  // 从100降低到50
            sessionWatcher = await getCurrentSessionWatcher();
        }
        
        if (sessionWatcher.status !== "active" || !sessionWatcher.currentSession) {
            return {
                status: "no_session",
                message: "当前没有活跃的会话",
                timestamp: getCurrentTimestamp('iso'),
                displayTime: formatTimestamp(new Date(), 'time')
            };
        }
        
        // 直接使用已知的会话文件路径，避免重复查询
        const historyPath = sessionWatcher.currentSession.filePath;
        let historyContent = [];
        
        try {
            const content = await fs.readFile(historyPath, 'utf-8');
            historyContent = JSON.parse(content);
        } catch (readError) {
            return {
                status: "empty_session",
                message: "会话文件为空",
                currentTime: formatTimestamp(new Date(), 'datetime'),
                sessionFilePath: historyPath,
                timestamp: getCurrentTimestamp('iso')
            };
        }
        
        if (!Array.isArray(historyContent) || historyContent.length === 0) {
            return {
                status: "empty_session", 
                message: "会话文件为空",
                currentTime: formatTimestamp(new Date(), 'datetime'),
                sessionFilePath: historyPath,
                timestamp: getCurrentTimestamp('iso')
            };
        }
        
        const currentTime = Date.now();
        const lastMessage = historyContent[historyContent.length - 1];
        const lastMessageTime = lastMessage.timestamp || 0;
        const timeSinceLastMessage = currentTime - lastMessageTime;
        
        // 计算会话持续时间
        const firstMessage = historyContent[0];
        const sessionStart = firstMessage.timestamp || 0;
        const sessionEnd = lastMessageTime;
        const totalDuration = sessionEnd - sessionStart;
        
        // 分析会话中的集中交流时段
        const conversationSessions = analyzeConversationSessions(historyContent);
        
        return {
            status: "active",
            timeSinceLastMessage: {
                milliseconds: timeSinceLastMessage,
                humanReadable: formatDuration(timeSinceLastMessage),
                lastMessageTime: formatTimestamp(lastMessageTime, 'datetime')
            },
            currentTime: formatTimestamp(currentTime, 'datetime'),
            sessionDuration: {
                startTime: formatTimestamp(sessionStart, 'datetime'),
                endTime: formatTimestamp(sessionEnd, 'datetime'),
                totalDuration: formatDuration(totalDuration),
                totalMilliseconds: totalDuration
            },
            conversationSessions: conversationSessions,
            sessionFilePath: historyPath,
            messageCount: historyContent.length,
            timestamp: getCurrentTimestamp('iso'),
            displayTime: formatTimestamp(new Date(), 'time')
        };
        
    } catch (error) {
        FORCE_LOG('[ChatRoomViewer] Error generating session time elapsed:', error.message);
        return {
            status: "error",
            error: error.message,
            timestamp: getCurrentTimestamp('iso'),
            displayTime: formatTimestamp(new Date(), 'time')
        };
    }
}

// 分析会话中的集中交流时段
function analyzeConversationSessions(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    
    const sessions = [];
    let currentSession = null;
    const SESSION_GAP_THRESHOLD = 30 * 60 * 1000; // 30分钟间隔认为是新的会话时段
    
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const messageTime = message.timestamp || 0;
        
        if (!currentSession) {
            // 开始新的会话时段
            currentSession = {
                startIndex: i,
                startTime: messageTime,
                endTime: messageTime,
                messageCount: 1,
                endIndex: i
            };
        } else {
            const timeSinceLastMessage = messageTime - currentSession.endTime;
            
            if (timeSinceLastMessage > SESSION_GAP_THRESHOLD) {
                // 时间间隔太长，结束当前会话，开始新会话
                sessions.push({
                    ...currentSession,
                    duration: currentSession.endTime - currentSession.startTime,
                    durationHuman: formatDuration(currentSession.endTime - currentSession.startTime),
                    startTimeHuman: formatTimestamp(currentSession.startTime, 'datetime'),
                    endTimeHuman: formatTimestamp(currentSession.endTime, 'datetime')
                });
                
                currentSession = {
                    startIndex: i,
                    startTime: messageTime,
                    endTime: messageTime,
                    messageCount: 1,
                    endIndex: i
                };
            } else {
                // 继续当前会话时段
                currentSession.endTime = messageTime;
                currentSession.messageCount++;
                currentSession.endIndex = i;
            }
        }
    }
    
    // 添加最后一个会话时段
    if (currentSession) {
        sessions.push({
            ...currentSession,
            duration: currentSession.endTime - currentSession.startTime,
            durationHuman: formatDuration(currentSession.endTime - currentSession.startTime),
            startTimeHuman: formatTimestamp(currentSession.startTime, 'datetime'),
            endTimeHuman: formatTimestamp(currentSession.endTime, 'datetime')
        });
    }
    
    return sessions;
}

// 格式化持续时间为人类可读格式
function formatDuration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
        const remainingHours = hours % 24;
        const remainingMinutes = minutes % 60;
        return `${days}天${remainingHours}小时${remainingMinutes}分钟`;
    } else if (hours > 0) {
        const remainingMinutes = minutes % 60;
        const remainingSeconds = seconds % 60;
        return `${hours}小时${remainingMinutes}分钟${remainingSeconds}秒`;
    } else if (minutes > 0) {
        const remainingSeconds = seconds % 60;
        return `${minutes}分钟${remainingSeconds}秒`;
    } else {
        return `${seconds}秒`;
    }
}

// 新增：生成群聊会话监控信息
async function generateGroupSessionWatcher() {
    try {
        const mainDir = getVCPChatMainDirectory();
        const groupDataDir = path.join(mainDir, 'AppData', 'UserData');
        
        // 查找群聊会话文件（以_Agent_开头但实际是群聊的特殊处理）
        let latestGroupFile = null;
        let latestTime = 0;
        
        const agentGroupsDir = path.join(mainDir, 'AppData', 'AgentGroups');
        let knownGroupIds = new Set();
        try {
            const groupConfigDirs = await fs.readdir(agentGroupsDir, { withFileTypes: true });
            knownGroupIds = new Set(groupConfigDirs.filter(d => d.isDirectory()).map(d => d.name));
        } catch {
            knownGroupIds = new Set();
        }

        const dirs = await fs.readdir(groupDataDir, { withFileTypes: true });
        
        // 寻找群聊相关的目录结构（匹配 AgentGroups 登记的群组 ID 或 group_topic_ 历史前缀）
        for (const dir of dirs) {
            if (dir.isDirectory()) {
                const isKnownGroup = knownGroupIds.has(dir.name);
                const groupTopicsDir = path.join(groupDataDir, dir.name, 'topics');
                try {
                    const topicDirs = await fs.readdir(groupTopicsDir, { withFileTypes: true });
                    
                    for (const topicDir of topicDirs) {
                        if (topicDir.isDirectory() && (isKnownGroup || topicDir.name.startsWith('group_topic_'))) {
                            const historyPath = path.join(groupTopicsDir, topicDir.name, 'history.json');
                            try {
                                const stats = await fs.stat(historyPath);
                                if (stats.mtime.getTime() > latestTime) {
                                    latestTime = stats.mtime.getTime();
                                    latestGroupFile = {
                                        filePath: historyPath,
                                        groupId: dir.name,
                                        topicId: topicDir.name,
                                        lastModified: stats.mtime,
                                        size: stats.size
                                    };
                                }
                            } catch (statError) {
                                // 跳过无法访问的文件
                            }
                        }
                    }
                } catch (topicsError) {
                    // 跳过无法访问的topics目录
                }
            }
        }
        
        if (latestGroupFile) {
            return {
                status: "active",
                currentSession: {
                    groupId: latestGroupFile.groupId,
                    topicId: latestGroupFile.topicId,
                    filePath: latestGroupFile.filePath,
                    lastModified: formatTimestamp(latestGroupFile.lastModified, 'iso'),
                    lastModifiedDisplay: formatTimestamp(latestGroupFile.lastModified, 'time'),
                    modifiedTimestamp: latestGroupFile.lastModified.getTime(),
                    size: latestGroupFile.size
                },
                timestamp: getCurrentTimestamp('iso'),
                displayTime: formatTimestamp(new Date(), 'time')
            };
        } else {
            return {
                status: "no_group_session",
                message: "未找到活跃的群聊会话文件",
                timestamp: getCurrentTimestamp('iso'),
                displayTime: formatTimestamp(new Date(), 'time')
            };
        }
    } catch (error) {
        FORCE_LOG('[ChatRoomViewer] Error in generateGroupSessionWatcher:', error.message);
        return {
            status: "error",
            error: error.message,
            timestamp: getCurrentTimestamp('iso'),
            displayTime: formatTimestamp(new Date(), 'time')
        };
    }
}

// 获取所有Agent的基本信息
async function getAllAgentsInfo() {
    try {
        const mainDir = getVCPChatMainDirectory();
        const agentsDir = path.join(mainDir, 'AppData', 'Agents');
        
        // 获取所有Agent目录（兼容全部包含 config.json 的 Agent 目录，不再硬编码 _Agent_ 前缀）
        const agentDirs = await fs.readdir(agentsDir, { withFileTypes: true });
        const validAgents = agentDirs.filter(dir => dir.isDirectory());
        
        const agentsInfo = [];
        
        for (const agentDir of validAgents) {
            const agentPath = path.join(agentsDir, agentDir.name);
            const configPath = path.join(agentPath, 'config.json');
            
            try {
                const configContent = await fs.readFile(configPath, 'utf-8');
                const config = JSON.parse(configContent);
                
                // 使用config.json文件的创建时间作为Agent创建时间
                const configStats = await fs.stat(configPath);
                const createdTimestamp = configStats.birthtime.getTime(); // 文件创建时间
                
                // 统计topics数量
                let topicsCount = 0;
                if (config.topics && Array.isArray(config.topics)) {
                    topicsCount = config.topics.length;
                }
                
                const agentInfo = {
                    agentId: agentDir.name,
                    folderPath: agentPath,
                    name: config.name || '未命名Agent',
                    model: config.model || '未指定',
                    temperature: config.temperature || 0.5,
                    contextTokenLimit: config.contextTokenLimit || 0,
                    maxOutputTokens: config.maxOutputTokens || 0,
                    // 查找Agent头像文件
                    avatarPath: await findAgentAvatar(agentPath),
                    // 使用config.json文件的创建时间作为正式的Agent创建时间
                    createdAt: formatTimestamp(createdTimestamp, 'iso'),
                    // topics数量统计
                    topicsCount: topicsCount
                };
                
                // 添加非空的配置项
                if (config.streamOutput !== undefined) agentInfo.streamOutput = config.streamOutput;
                if (config.ttsVoicePrimary) agentInfo.ttsVoicePrimary = config.ttsVoicePrimary;
                if (config.ttsRegexPrimary) agentInfo.ttsRegexPrimary = config.ttsRegexPrimary;
                if (config.ttsVoiceSecondary) agentInfo.ttsVoiceSecondary = config.ttsVoiceSecondary;
                if (config.ttsRegexSecondary) agentInfo.ttsRegexSecondary = config.ttsRegexSecondary;
                if (config.ttsSpeed !== undefined) agentInfo.ttsSpeed = config.ttsSpeed;
                if (config.avatarCalculatedColor) agentInfo.avatarCalculatedColor = config.avatarCalculatedColor;
                if (config.top_p !== undefined) agentInfo.top_p = config.top_p;
                if (config.top_k !== undefined) agentInfo.top_k = config.top_k;
                
                agentsInfo.push(agentInfo);
                
            } catch (configError) {
                FORCE_LOG(`[ChatRoomViewer] Error reading agent config for ${agentDir.name}:`, configError.message);
                // 即使配置文件读取失败，也记录Agent基本信息
                
                // 尝试获取文件创建时间
                let createdTimestamp = null;
                let displayTime = null;
                
                try {
                    const configStats = await fs.stat(configPath);
                    createdTimestamp = configStats.birthtime.getTime();
                    displayTime = formatTimestamp(createdTimestamp, 'time');
                } catch (statError) {
                    // 如果无法获取文件统计信息，使用当前时间
                    createdTimestamp = Date.now();
                    displayTime = formatTimestamp(new Date(), 'time');
                }
                
                agentsInfo.push({
                    agentId: agentDir.name,
                    folderPath: agentPath,
                    name: '无法读取配置',
                    error: configError.message,
                    avatarPath: await findAgentAvatar(agentPath),
                    createdAt: formatTimestamp(createdTimestamp, 'iso'),
                    topicsCount: 0 // 配置读取失败时无法统计topics
                });
            }
        }
        
        return {
            totalCount: agentsInfo.length,
            agents: agentsInfo,
            lastUpdate: getCurrentTimestamp('iso'),
            lastUpdateDisplay: formatTimestamp(new Date(), 'time')
        };
        
    } catch (error) {
        FORCE_LOG('[ChatRoomViewer] Error getting agents info:', error.message);
        return {
            error: `获取Agent信息失败: ${error.message}`,
            totalCount: 0,
            agents: [],
            lastUpdate: getCurrentTimestamp('iso'),
            lastUpdateDisplay: formatTimestamp(new Date(), 'time')
        };
    }
}

// 查找Agent头像文件
async function findAgentAvatar(agentPath) {
    const possibleAvatarFiles = [
        'avatar.png',
        'avatar.jpg',
        'avatar.jpeg',
        'avatar.gif',
        'avatar.webp',
        'profile.png',
        'profile.jpg'
    ];
    
    for (const avatarFile of possibleAvatarFiles) {
        const avatarPath = path.join(agentPath, avatarFile);
        try {
            await fs.access(avatarPath);
            return avatarPath; // 找到头像文件
        } catch (err) {
            // 继续尝试下一个
        }
    }
    
    // 如果没有找到头像，返回默认头像路径
    return 'assets/default_avatar.png';
}

// 生成主题模式切换气泡示范
function generateModeBubbleTip() {
    // 恢复原来的硬编码内容
    const content = `主题模式自适应气泡实现指南：

使用CSS变量实现亮暗模式自动切换的关键要素：

1. 基础结构：
<div style="
    background-color: var(--primary-bg);
    color: var(--primary-text);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 20px;
">

2. 核心变量：
- var(--primary-bg) : 主背景色
- var(--secondary-bg) : 次要背景色
- var(--primary-text) : 主文字颜色
- var(--highlight-text) : 高亮文字颜色
- var(--border-color) : 边框颜色

3. 增强效果：
    backdrop-filter: blur(10px) saturate(120%);
    transition: all 0.3s ease-in-out;
    box-shadow: 0 4px 15px rgba(0,0,0,0.1);

4. 示例应用：
<h2 style="color: var(--highlight-text); border-bottom: 1px solid var(--border-color);">
    标题文字
</h2>
<p style="color: var(--primary-text);">内容文字</p>

关键优势：
- 自动适配亮色/暗色主题
- 无需JavaScript干预
- 平滑过渡动画
- 磨砂玻璃效果`;
    
    return {
        content: content,
        timestamp: getCurrentTimestamp('iso'),
        displayTime: formatTimestamp(new Date(), 'time'),
        purpose: '提供主题模式自适应气泡的实现指导'
    };
}

async function main() {
    if (!enabled) {
        FORCE_LOG('[ChatRoomViewer] Plugin is disabled by configuration.');
        const disabledOutput = {
            "{{VCPChatStatus}}": "[ChatRoomViewer: Disabled]",
            "{{VCPChatTheme}}": "[ChatRoomViewer: Disabled]",
            "{{VCPChatSessionWatcher}}": "[ChatRoomViewer: Disabled]",
            "{{VCPChatAgent}}": "[ChatRoomViewer: Disabled]",
            "{{VCPChatModeBubbleTip}}": "[ChatRoomViewer: Disabled]",
            "{{VCPChatSessionTimeElapsed}}": "[ChatRoomViewer: Disabled]",
            "{{VCPChatGroupSessionWatcher}}": "[ChatRoomViewer: Disabled]"
        };
        process.stdout.write(JSON.stringify(disabledOutput));
        process.exit(0);
        return;
    }

    try {
        FORCE_LOG('[ChatRoomViewer] Starting to collect VCPChat client information...');
        
        // 并行获取所有信息
        const [statusInfo, themeInfo, agentsInfo, sessionTimeElapsed, groupSessionWatcher] = await Promise.all([
            generateVCPChatStatus(),
            generateThemeInfo(),
            getAllAgentsInfo(),
            generateSessionTimeElapsed(),
            generateGroupSessionWatcher()
        ]);
        
        // 获取主题模式气泡示范（同步操作）
        const modeBubbleTip = generateModeBubbleTip();
        
        // 获取会话监控信息
        const sessionWatcherInfo = statusInfo.sessionWatcher || { error: "无法获取会话监控信息" };
        
        // 缓存数据
        cachedData.statusInfo = statusInfo;
        cachedData.themeInfo = themeInfo;
        cachedData.agentsInfo = agentsInfo;
        cachedData.sessionWatcherInfo = sessionWatcherInfo;
        cachedData.modeBubbleTip = modeBubbleTip;
        cachedData.sessionTimeElapsed = sessionTimeElapsed;
        cachedData.groupSessionWatcher = groupSessionWatcher;
        cachedData.lastUpdate = Date.now();
        
        const outputData = {
            "{{VCPChatStatus}}": JSON.stringify(statusInfo),
            "{{VCPChatTheme}}": JSON.stringify(themeInfo),
            "{{VCPChatSessionWatcher}}": JSON.stringify(sessionWatcherInfo),
            "{{VCPChatAgent}}": JSON.stringify(agentsInfo),
            "{{VCPChatModeBubbleTip}}": JSON.stringify(modeBubbleTip),
            "{{VCPChatSessionTimeElapsed}}": JSON.stringify(sessionTimeElapsed),
            "{{VCPChatGroupSessionWatcher}}": JSON.stringify(groupSessionWatcher)
        };
        
        if (debugMode) {
            FORCE_LOG('[ChatRoomViewer] Generated status data:', JSON.stringify(statusInfo, null, 2));
            FORCE_LOG('[ChatRoomViewer] Generated theme data:', JSON.stringify(themeInfo, null, 2));
            FORCE_LOG('[ChatRoomViewer] Generated session watcher data:', JSON.stringify(sessionWatcherInfo, null, 2));
            FORCE_LOG('[ChatRoomViewer] Generated agents data:', JSON.stringify(agentsInfo, null, 2));
            FORCE_LOG('[ChatRoomViewer] Generated mode bubble tip:', JSON.stringify(modeBubbleTip, null, 2));
            FORCE_LOG('[ChatRoomViewer] Generated session time elapsed:', JSON.stringify(sessionTimeElapsed, null, 2));
            FORCE_LOG('[ChatRoomViewer] Generated group session watcher:', JSON.stringify(groupSessionWatcher, null, 2));
        }
        
        process.stdout.write(JSON.stringify(outputData));
        
        // 初始化文件监控器（在获取数据后，确保有正确的会话文件信息）
        initializeFileWatchers();
        
        // 初始化群聊会话文件监控
        initializeGroupSessionWatcher();
        
        // 如果不是监控模式，则退出
        if (!isWatcherMode) {
            process.exit(0);
        }
        
    } catch (error) {
        const errorMsg = `[ChatRoomViewer] Unexpected error: ${error.message}`;
        FORCE_LOG(errorMsg);
        
        const errorOutput = {
            "{{VCPChatStatus}}": errorMsg,
            "{{VCPChatTheme}}": errorMsg,
            "{{VCPChatSessionWatcher}}": errorMsg,
            "{{VCPChatAgent}}": errorMsg,
            "{{VCPChatModeBubbleTip}}": errorMsg,
            "{{VCPChatSessionTimeElapsed}}": errorMsg,
            "{{VCPChatGroupSessionWatcher}}": errorMsg
        };
        process.stdout.write(JSON.stringify(errorOutput));
        
        if (!isWatcherMode) {
            process.exit(1);
        }
    }
}

// 处理退出信号
process.on('SIGTERM', () => {
    cleanupFileWatchers();
    process.exit(0);
});

process.on('SIGINT', () => {
    cleanupFileWatchers();
    process.exit(0);
});

// 执行主函数
main().catch(error => {
    FORCE_LOG('[ChatRoomViewer] Fatal error in main():', error);
    process.exit(1);
});