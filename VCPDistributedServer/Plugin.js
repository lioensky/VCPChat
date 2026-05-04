// Plugin.js for VCP Distributed Server
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const schedule = require('node-schedule');
const dotenv = require('dotenv');

const PLUGIN_DIR = path.join(__dirname, 'Plugin');
const manifestFileName = 'plugin-manifest.json';

class PluginManager {
    constructor() {
        this.plugins = new Map();
        this.serviceModules = new Map(); // 新增：用于存储服务类插件
        this.staticPlaceholderValues = new Map(); // 新增：用于存储静态插件占位符值
        this.scheduledJobs = new Map(); // 新增：用于存储定时任务
        this.projectBasePath = null;
        this.serverPort = null; // 新增：用于构造回调 URL
        this.debugMode = (process.env.DebugMode || "False").toLowerCase() === "true";
    }

    setServerPort(port) {
        this.serverPort = port;
    }

    setProjectBasePath(basePath) {
        this.projectBasePath = basePath;
        if (this.debugMode) console.log(`[DistPluginManager] Project base path set to: ${this.projectBasePath}`);
    }

    _getPluginConfig(pluginManifest) {
        const config = {};
        const globalEnv = process.env;
        const pluginSpecificEnv = pluginManifest.pluginSpecificEnvConfig || {};

        if (pluginManifest.configSchema) {
            for (const key in pluginManifest.configSchema) {
                const expectedType = pluginManifest.configSchema[key];
                let rawValue;

                if (pluginSpecificEnv.hasOwnProperty(key)) {
                    rawValue = pluginSpecificEnv[key];
                } else if (globalEnv.hasOwnProperty(key)) {
                    rawValue = globalEnv[key];
                } else {
                    continue;
                }

                let value = rawValue;
                if (expectedType === 'integer') {
                    value = parseInt(value, 10);
                    if (isNaN(value)) value = undefined;
                } else if (expectedType === 'boolean') {
                    value = String(value).toLowerCase() === 'true';
                }
                config[key] = value;
            }
        }
        
        // 添加调试模式配置
        if (pluginSpecificEnv.hasOwnProperty('DebugMode')) {
            config.DebugMode = String(pluginSpecificEnv.DebugMode).toLowerCase() === 'true';
        } else if (globalEnv.hasOwnProperty('DebugMode')) {
            config.DebugMode = String(globalEnv.DebugMode).toLowerCase() === 'true';
        } else if (!config.hasOwnProperty('DebugMode')) {
            config.DebugMode = false;
        }
        return config;
    }

    async loadPlugins() {
        console.log('[DistPluginManager] Starting plugin discovery...');
        this.plugins.clear();

        try {
            const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
            for (const folder of pluginFolders) {
                if (folder.isDirectory()) {
                    const pluginPath = path.join(PLUGIN_DIR, folder.name);
                    const manifestPath = path.join(pluginPath, manifestFileName);
                    try {
                        const manifestContent = await fs.readFile(manifestPath, 'utf-8');
                        const manifest = JSON.parse(manifestContent);
                        if (!manifest.name || !manifest.pluginType || !manifest.entryPoint) {
                            if (this.debugMode) console.warn(`[DistPluginManager] Invalid manifest in ${folder.name}. Skipping.`);
                            continue;
                        }
                        if (this.plugins.has(manifest.name)) {
                            if (this.debugMode) console.warn(`[DistPluginManager] Duplicate plugin name '${manifest.name}'. Skipping.`);
                            continue;
                        }
                        manifest.basePath = pluginPath;
                        
                        // Load plugin-specific config.env
                        manifest.pluginSpecificEnvConfig = {};
                         try {
                            await fs.access(path.join(pluginPath, 'config.env'));
                            const pluginEnvContent = await fs.readFile(path.join(pluginPath, 'config.env'), 'utf-8');
                            manifest.pluginSpecificEnvConfig = dotenv.parse(pluginEnvContent);
                        } catch (envError) {
                            // Ignore if config.env doesn't exist
                        }

                        // 加载所有类型的插件
                        this.plugins.set(manifest.name, manifest);
                        console.log(`[DistPluginManager] Loaded manifest: ${manifest.displayName} (${manifest.name}, Type: ${manifest.pluginType})`);

                        // 如果是服务类或混合服务类插件，则加载其模块以备初始化
                        if ((manifest.pluginType === 'service' || manifest.pluginType === 'hybridservice') && manifest.entryPoint.script && manifest.communication?.protocol === 'direct') {
                            try {
                                const scriptPath = path.join(pluginPath, manifest.entryPoint.script);
                                const serviceModule = require(scriptPath);
                                this.serviceModules.set(manifest.name, { manifest, module: serviceModule });
                                if (this.debugMode) console.log(`[DistPluginManager] Loaded service module: ${manifest.name}`);
                            } catch (e) {
                                console.error(`[DistPluginManager] Error requiring service module for ${manifest.name}:`, e);
                            }
                        }
                    } catch (error) {
                        if (this.debugMode) console.error(`[DistPluginManager] Error loading plugin from ${folder.name}:`, error);
                    }
                }
            }
            console.log(`[DistPluginManager] Plugin discovery finished. Loaded ${this.plugins.size} plugins.`);
            
            // 初始化静态插件
            await this.initializeStaticPlugins();
        } catch (error) {
            console.error(`[DistPluginManager] Plugin directory ${PLUGIN_DIR} not found or could not be read.`);
        }
    }
    
    getAllPluginManifests() {
        return Array.from(this.plugins.values());
    }

    getPlugin(name) {
        return this.plugins.get(name);
    }

    getServiceModule(name) {
        return this.serviceModules.get(name)?.module;
    }

    async processToolCall(toolName, toolArgs) {
        const plugin = this.plugins.get(toolName);
        if (!plugin) {
            throw new Error(`[DistPluginManager] Plugin "${toolName}" not found for tool call.`);
        }

        // --- 混合服务插件直接调用逻辑 ---
        if (plugin.pluginType === 'hybridservice' && plugin.communication?.protocol === 'direct') {
            if (this.debugMode) console.log(`[DistPluginManager] Processing direct tool call for hybrid service: ${toolName}`);
            const serviceModule = this.getServiceModule(toolName);
            if (serviceModule && typeof serviceModule.processToolCall === 'function') {
                // 直接调用模块的 processToolCall 方法
                return serviceModule.processToolCall(toolArgs);
            } else {
                throw new Error(`[DistPluginManager] Hybrid service plugin "${toolName}" does not have a processToolCall function.`);
            }
        }

        // --- 现有同步插件调用逻辑 (后备) ---
        let executionParam = null;
        executionParam = toolArgs ? JSON.stringify(toolArgs) : null;

        if (this.debugMode) console.log(`[DistPluginManager] Calling executePlugin for: ${toolName} with prepared param:`, executionParam);
        
        return this.executePlugin(toolName, executionParam);
    }

    async executePlugin(pluginName, inputData) {
        const plugin = this.plugins.get(pluginName);
        if (!plugin) {
            throw new Error(`[DistPluginManager] Plugin "${pluginName}" not found.`);
        }
        if (!plugin.entryPoint || !plugin.entryPoint.command) {
            throw new Error(`[DistPluginManager] Entry point command undefined for plugin "${pluginName}".`);
        }

        const pluginConfig = this._getPluginConfig(plugin);
        const envForProcess = { ...process.env, ...pluginConfig };
        if (this.projectBasePath) {
            envForProcess.PROJECT_BASE_PATH = this.projectBasePath;
        }

        // --- 异步插件特殊环境变量注入 ---
        const isAsyncPlugin = plugin.pluginType === 'asynchronous';
        if (isAsyncPlugin) {
            if (this.serverPort) {
                envForProcess.CALLBACK_BASE_URL = `http://127.0.0.1:${this.serverPort}/plugin/callback`;
            }
            envForProcess.PLUGIN_NAME_FOR_CALLBACK = pluginName;
        }

        envForProcess.PYTHONIOENCODING = 'utf-8';

        return new Promise((resolve, reject) => {
            const [command, ...args] = plugin.entryPoint.command.split(' ');
            const pluginProcess = spawn(command, args, { cwd: plugin.basePath, shell: true, env: envForProcess, windowsHide: true });

            let outputBuffer = '';
            let errorOutput = '';
            let initialResponseSent = false;
            const timeoutDuration = plugin.entryPoint?.timeout || plugin.communication?.timeout || (isAsyncPlugin ? 1800000 : 60000);

            const timeoutId = setTimeout(() => {
                if (!initialResponseSent) {
                    pluginProcess.kill('SIGKILL');
                    reject(new Error(`Plugin "${pluginName}" execution timed out.`));
                }
            }, timeoutDuration);

            pluginProcess.stdout.setEncoding('utf8');
            pluginProcess.stdout.on('data', (data) => {
                if (isAsyncPlugin && initialResponseSent) return;

                outputBuffer += data;

                // 异步插件早期返回逻辑
                if (isAsyncPlugin) {
                    try {
                        const potentialJsonMatch = outputBuffer.match(/(\{[\s\S]*?\})(?:\s|$)/);
                        if (potentialJsonMatch && potentialJsonMatch[1]) {
                            const parsedOutput = JSON.parse(potentialJsonMatch[1]);
                            if (parsedOutput && (parsedOutput.status === "success" || parsedOutput.status === "error")) {
                                initialResponseSent = true;
                                resolve(outputBuffer.trim());
                            }
                        }
                    } catch (e) {
                        // Incomplete JSON, wait for more data
                    }
                }
            });

            pluginProcess.stderr.setEncoding('utf8');
            pluginProcess.stderr.on('data', (data) => {
                errorOutput += data;
            });

            pluginProcess.on('error', (err) => {
                clearTimeout(timeoutId);
                reject(new Error(`Failed to start plugin "${pluginName}": ${err.message}`));
            });

            pluginProcess.on('exit', (code, signal) => {
                clearTimeout(timeoutId);
                if (isAsyncPlugin && initialResponseSent) {
                    if (this.debugMode) console.log(`[DistPluginManager] Async plugin ${pluginName} exited after initial response.`);
                    return;
                }

                if (code !== 0 && signal !== 'SIGKILL') {
                    const errMsg = `Plugin ${pluginName} exited with code ${code}. Stderr: ${errorOutput.trim()}`;
                    console.error(`[DistPluginManager] ${errMsg}`);
                    if (!initialResponseSent) reject(new Error(errMsg));
                } else {
                    if (errorOutput.trim() && this.debugMode) {
                        console.warn(`[DistPluginManager] Plugin ${pluginName} produced stderr: ${errorOutput.trim()}`);
                    }
                    if (!initialResponseSent) resolve(outputBuffer.trim());
                }
            });

            if (inputData !== undefined && inputData !== null) {
                pluginProcess.stdin.write(inputData.toString());
            }
            pluginProcess.stdin.end();
        });
    }
    // 新增：初始化服务类插件的方法
    async initializeServices(app, adminApiRouter, projectBasePath) {
        if (!app) {
            console.error('[DistPluginManager] Cannot initialize services without Express app instance.');
            return;
        }
        console.log('[DistPluginManager] Initializing service plugins...');
        for (const [name, serviceData] of this.serviceModules) {
            try {
                const pluginConfig = this._getPluginConfig(serviceData.manifest);
                if (this.debugMode) console.log(`[DistPluginManager] Registering routes for service plugin: ${name}.`);
                
                if (serviceData.module && typeof serviceData.module.registerRoutes === 'function') {
                    // 分布式服务器只传递核心参数
                    serviceData.module.registerRoutes(app, pluginConfig, projectBasePath);
                }
            } catch (e) {
                console.error(`[DistPluginManager] Error initializing service plugin ${name}:`, e);
            }
        }
        console.log('[DistPluginManager] Service plugins initialized.');
    }

    // 新增：执行静态插件命令
    async _executeStaticPluginCommand(plugin) {
        if (!plugin || plugin.pluginType !== 'static' || !plugin.entryPoint || !plugin.entryPoint.command) {
            console.error(`[DistPluginManager] Invalid static plugin or command for execution: ${plugin ? plugin.name : 'Unknown'}`);
            return Promise.reject(new Error(`Invalid static plugin or command for ${plugin ? plugin.name : 'Unknown'}`));
        }

        return new Promise((resolve, reject) => {
            const pluginConfig = this._getPluginConfig(plugin);
            const envForProcess = { ...process.env };
            for (const key in pluginConfig) {
                if (pluginConfig.hasOwnProperty(key) && pluginConfig[key] !== undefined) {
                    envForProcess[key] = String(pluginConfig[key]);
                }
            }
            if (this.projectBasePath) {
                envForProcess.PROJECT_BASE_PATH = this.projectBasePath;
            }

            const [command, ...args] = plugin.entryPoint.command.split(' ');
            const pluginProcess = spawn(command, args, { cwd: plugin.basePath, shell: true, env: envForProcess, windowsHide: true });
            let output = '';
            let errorOutput = '';
            let processExited = false;
            const timeoutDuration = plugin.communication?.timeout || 30000;

            const timeoutId = setTimeout(() => {
                if (!processExited) {
                    console.error(`[DistPluginManager] Static plugin "${plugin.name}" execution timed out after ${timeoutDuration}ms.`);
                    pluginProcess.kill('SIGKILL');
                    reject(new Error(`Static plugin "${plugin.name}" execution timed out.`));
                }
            }, timeoutDuration);

            pluginProcess.stdout.on('data', (data) => { output += data.toString(); });
            pluginProcess.stderr.on('data', (data) => { errorOutput += data.toString(); });

            pluginProcess.on('error', (err) => {
                processExited = true;
                clearTimeout(timeoutId);
                console.error(`[DistPluginManager] Failed to start static plugin ${plugin.name}: ${err.message}`);
                reject(err);
            });
            
            pluginProcess.on('exit', (code, signal) => {
                processExited = true;
                clearTimeout(timeoutId);
                if (signal === 'SIGKILL') {
                    return;
                }
                if (code !== 0) {
                    const errMsg = `Static plugin ${plugin.name} exited with code ${code}. Stderr: ${errorOutput.trim()}`;
                    console.error(`[DistPluginManager] ${errMsg}`);
                    reject(new Error(errMsg));
                } else {
                    if (errorOutput.trim() && this.debugMode) {
                        console.warn(`[DistPluginManager] Static plugin ${plugin.name} produced stderr output: ${errorOutput.trim()}`);
                    }
                    resolve(output.trim());
                }
            });
        });
    }

    // 新增：更新静态插件值
    async _updateStaticPluginValue(plugin) {
        let newValue = null;
        let executionError = null;
        try {
            if (this.debugMode) console.log(`[DistPluginManager] Updating static plugin: ${plugin.name}`);
            newValue = await this._executeStaticPluginCommand(plugin);
        } catch (error) {
            console.error(`[DistPluginManager] Error executing static plugin ${plugin.name} script:`, error.message);
            executionError = error;
        }

        if (plugin.capabilities && plugin.capabilities.systemPromptPlaceholders) {
            plugin.capabilities.systemPromptPlaceholders.forEach(ph => {
                const placeholderKey = ph.placeholder;
                const currentValue = this.staticPlaceholderValues.get(placeholderKey);

                if (newValue !== null && newValue.trim() !== "") {
                    // 尝试解析JSON输出
                    let parsedOutput = null;
                    try {
                        parsedOutput = JSON.parse(newValue.trim());
                    } catch (parseError) {
                        if (this.debugMode) console.warn(`[DistPluginManager] Static plugin ${plugin.name} output is not valid JSON, using as string.`);
                    }
                    
                    let valueForPlaceholder;
                    if (parsedOutput && typeof parsedOutput === 'object' && parsedOutput[placeholderKey]) {
                        // 如果插件输出包含占位符键，使用对应的值
                        valueForPlaceholder = parsedOutput[placeholderKey];
                        if (typeof valueForPlaceholder === 'string') {
                            this.staticPlaceholderValues.set(placeholderKey, valueForPlaceholder);
                        } else {
                            this.staticPlaceholderValues.set(placeholderKey, JSON.stringify(valueForPlaceholder));
                        }
                    } else {
                        // 否则使用整个输出
                        this.staticPlaceholderValues.set(placeholderKey, newValue.trim());
                    }
                    
                    if (this.debugMode) {
                        const displayValue = this.staticPlaceholderValues.get(placeholderKey);
                        console.log(`[DistPluginManager] Placeholder ${placeholderKey} for ${plugin.name} updated with value: "${(displayValue || "").substring(0,70)}..."`);
                    }
                } else if (executionError) {
                    const errorMessage = `[Error updating ${plugin.name}: ${executionError.message.substring(0,100)}...]`;
                    if (!currentValue || (currentValue && currentValue.startsWith("[Error"))) {
                        this.staticPlaceholderValues.set(placeholderKey, errorMessage);
                        if (this.debugMode) console.warn(`[DistPluginManager] Placeholder ${placeholderKey} for ${plugin.name} set to error state: ${errorMessage}`);
                    } else {
                        if (this.debugMode) console.warn(`[DistPluginManager] Placeholder ${placeholderKey} for ${plugin.name} failed to update. Keeping stale value: "${(currentValue || "").substring(0,70)}..."`);
                    }
                } else {
                    if (this.debugMode) console.warn(`[DistPluginManager] Static plugin ${plugin.name} produced no new output for ${placeholderKey}. Keeping stale value (if any).`);
                    if (!this.staticPlaceholderValues.has(placeholderKey)) {
                        this.staticPlaceholderValues.set(placeholderKey, `[${plugin.name} data currently unavailable]`);
                        if (this.debugMode) console.log(`[DistPluginManager] Placeholder ${placeholderKey} for ${plugin.name} set to 'unavailable'.`);
                    }
                }
            });
        }
    }

    // 新增：初始化静态插件
    async initializeStaticPlugins() {
        console.log('[DistPluginManager] Initializing static plugins...');
        for (const plugin of this.plugins.values()) {
            if (plugin.pluginType === 'static') {
                // 立即设置占位符为加载状态
                if (plugin.capabilities && plugin.capabilities.systemPromptPlaceholders) {
                    plugin.capabilities.systemPromptPlaceholders.forEach(ph => {
                        this.staticPlaceholderValues.set(ph.placeholder, `[${plugin.displayName} 正在加载中...]`);
                    });
                }

                // 在后台触发第一次更新
                this._updateStaticPluginValue(plugin).catch(err => {
                    console.error(`[DistPluginManager] Initial background update for ${plugin.name} failed: ${err.message}`);
                });

                // 设置定时更新任务
                if (plugin.refreshIntervalCron) {
                    if (this.scheduledJobs.has(plugin.name)) {
                        this.scheduledJobs.get(plugin.name).cancel();
                    }
                    try {
                        const job = schedule.scheduleJob(plugin.refreshIntervalCron, () => {
                            if (this.debugMode) console.log(`[DistPluginManager] Scheduled update for static plugin: ${plugin.name}`);
                            this._updateStaticPluginValue(plugin).catch(err => {
                                console.error(`[DistPluginManager] Scheduled background update for ${plugin.name} failed: ${err.message}`);
                            });
                        });
                        this.scheduledJobs.set(plugin.name, job);
                        if (this.debugMode) console.log(`[DistPluginManager] Scheduled ${plugin.name} with cron: ${plugin.refreshIntervalCron}`);
                    } catch (e) {
                        console.error(`[DistPluginManager] Invalid cron string for ${plugin.name}: ${plugin.refreshIntervalCron}. Error: ${e.message}`);
                    }
                }
            }
        }
        console.log('[DistPluginManager] Static plugins initialization process has been started (updates will run in the background).');
    }

    // 新增：获取占位符值
    getPlaceholderValue(placeholder) {
        return this.staticPlaceholderValues.get(placeholder) || `[Placeholder ${placeholder} not found]`;
    }

    // 新增：获取所有静态占位符值
    getAllPlaceholderValues() {
        const valuesMap = new Map();
        for (const [key, value] of this.staticPlaceholderValues.entries()) {
            // Ensure that the returned map contains only string values,
            // consistent with the main server's expectations.
            valuesMap.set(key, String(value));
        }
        return valuesMap;
    }

    // 新增：关闭所有插件
    async shutdownAllPlugins() {
        console.log('[DistPluginManager] Shutting down all plugins...');
        for (const job of this.scheduledJobs.values()) {
            job.cancel();
        }
        this.scheduledJobs.clear();
        console.log('[DistPluginManager] All scheduled jobs cancelled.');
    }
}

const pluginManager = new PluginManager();
module.exports = pluginManager;