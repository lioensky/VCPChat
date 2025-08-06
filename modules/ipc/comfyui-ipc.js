// ComfyUI IPC Handler Module
const { ipcMain } = require('electron');
const fs = require('fs').promises;
const path = require('path');

// 使用 PathResolver 来定位 VCPToolBox
const PathResolver = require('../../VCPHumanToolBox/ComfyUImodules/PathResolver');

class ComfyUIIpcHandler {
    constructor() {
        this.pathResolver = new PathResolver();
        this.configPath = null;
        this.workflowsPath = null;
        this.mainWindow = null;
    }

    async initialize(mainWindow) {
        this.mainWindow = mainWindow;
        
        try {
            // 获取配置文件和工作流目录路径
            this.configPath = await this.pathResolver.getConfigFilePath();
            this.workflowsPath = await this.pathResolver.getWorkflowsPath();
            
            // 确保目录存在
            const configDir = path.dirname(this.configPath);
            await fs.mkdir(configDir, { recursive: true });
            await fs.mkdir(this.workflowsPath, { recursive: true });
            
            console.log('[ComfyUI IPC] Initialized with paths:', {
                config: this.configPath,
                workflows: this.workflowsPath
            });
        } catch (error) {
            console.error('[ComfyUI IPC] Failed to initialize paths:', error);
            throw error;
        }
    }

    // 注册所有 IPC handlers
    registerHandlers() {
        // 获取配置
        ipcMain.handle('comfyui:get-config', async () => {
            try {
                // 检查文件是否存在
                try {
                    await fs.access(this.configPath);
                } catch {
                    // 文件不存在，返回默认配置
                    return {
                        success: true,
                        data: {
                            serverUrl: 'http://localhost:8188',
                            apiKey: '',
                            workflow: 'text2img_basic',
                            defaultModel: 'sd_xl_base_1.0.safetensors',
                            defaultWidth: 1024,
                            defaultHeight: 1024,
                            defaultSteps: 30,
                            defaultCfg: 7.5,
                            defaultSampler: 'dpmpp_2m',
                            defaultScheduler: 'normal',
                            defaultSeed: -1,
                            defaultBatchSize: 1,
                            defaultDenoise: 1.0,
                            negativePrompt: 'lowres, bad anatomy, bad hands, text, error',
                            qualityTags: 'masterpiece, best quality, high resolution',
                            loras: []
                        }
                    };
                }
                
                const content = await fs.readFile(this.configPath, 'utf8');
                const data = JSON.parse(content);
                return { success: true, data };
            } catch (error) {
                console.error('[ComfyUI IPC] Failed to get config:', error);
                return { success: false, error: error.message };
            }
        });

        // 保存配置
        ipcMain.handle('comfyui:save-config', async (event, config) => {
            try {
                const content = JSON.stringify(config, null, 2);
                await fs.writeFile(this.configPath, content, 'utf8');
                return { success: true, path: this.configPath };
            } catch (error) {
                console.error('[ComfyUI IPC] Failed to save config:', error);
                return { success: false, error: error.message };
            }
        });

        // 获取工作流列表
        ipcMain.handle('comfyui:get-workflows', async () => {
            try {
                const files = await fs.readdir(this.workflowsPath);
                const workflows = [];
                
                for (const file of files) {
                    if (file.endsWith('.json')) {
                        const name = path.basename(file, '.json');
                        const filePath = path.join(this.workflowsPath, file);
                        
                        try {
                            const content = await fs.readFile(filePath, 'utf8');
                            const data = JSON.parse(content);
                            workflows.push({
                                name: name,
                                displayName: data.displayName || name,
                                path: filePath
                            });
                        } catch (e) {
                            // 如果读取失败，仍然添加到列表但没有 displayName
                            workflows.push({
                                name: name,
                                displayName: name,
                                path: filePath
                            });
                        }
                    }
                }
                
                return { success: true, workflows };
            } catch (error) {
                console.error('[ComfyUI IPC] Failed to get workflows:', error);
                return { success: false, error: error.message };
            }
        });

        // 读取工作流
        ipcMain.handle('comfyui:read-workflow', async (event, { name }) => {
            try {
                // 验证文件名安全性
                if (!this.isValidFileName(name)) {
                    throw new Error('Invalid workflow name');
                }
                
                const filePath = path.join(this.workflowsPath, `${name}.json`);
                const content = await fs.readFile(filePath, 'utf8');
                const data = JSON.parse(content);
                return { success: true, data };
            } catch (error) {
                console.error('[ComfyUI IPC] Failed to read workflow:', error);
                return { success: false, error: error.message };
            }
        });

        // 保存工作流
        ipcMain.handle('comfyui:save-workflow', async (event, { name, data }) => {
            try {
                // 验证文件名安全性
                if (!this.isValidFileName(name)) {
                    throw new Error('Invalid workflow name');
                }
                
                const filePath = path.join(this.workflowsPath, `${name}.json`);
                const content = JSON.stringify(data, null, 2);
                await fs.writeFile(filePath, content, 'utf8');

                // 广播工作流变更事件，通知渲染进程刷新
                try {
                    if (this.mainWindow && this.mainWindow.webContents) {
                        this.mainWindow.webContents.send('comfyui:workflows-changed');
                    }
                } catch (broadcastErr) {
                    console.warn('[ComfyUI IPC] Failed to broadcast workflows-changed:', broadcastErr);
                }

                return { success: true, path: filePath };
            } catch (error) {
                console.error('[ComfyUI IPC] Failed to save workflow:', error);
                return { success: false, error: error.message };
            }
        });

        // 删除工作流
        ipcMain.handle('comfyui:delete-workflow', async (event, { name }) => {
            try {
                // 验证文件名安全性
                if (!this.isValidFileName(name)) {
                    throw new Error('Invalid workflow name');
                }
                
                const filePath = path.join(this.workflowsPath, `${name}.json`);
                await fs.unlink(filePath);

                // 广播工作流变更事件，通知渲染进程刷新
                try {
                    if (this.mainWindow && this.mainWindow.webContents) {
                        this.mainWindow.webContents.send('comfyui:workflows-changed');
                    }
                } catch (broadcastErr) {
                    console.warn('[ComfyUI IPC] Failed to broadcast workflows-changed:', broadcastErr);
                }

                return { success: true };
            } catch (error) {
                console.error('[ComfyUI IPC] Failed to delete workflow:', error);
                return { success: false, error: error.message };
            }
        });

        // 获取插件路径
        ipcMain.handle('comfyui:get-plugin-path', async () => {
            try {
                const pluginPath = await this.pathResolver.getPluginPath();
                return { success: true, path: pluginPath };
            } catch (error) {
                console.error('[ComfyUI IPC] Failed to get plugin path:', error);
                return { success: false, error: error.message };
            }
        });
    }

    // 验证文件名安全性
    isValidFileName(name) {
        // 只允许字母、数字、中文、下划线、连字符和空格
        const validPattern = /^[\u4e00-\u9fa5\w\s\-]+$/;
        return validPattern.test(name) && !name.includes('..') && !name.includes('/') && !name.includes('\\');
    }
}

// 导出注册函数
module.exports = {
    registerComfyUIIpcHandlers: async (mainWindow) => {
        const handler = new ComfyUIIpcHandler();
        
        try {
            await handler.initialize(mainWindow);
            handler.registerHandlers();
            
            console.log('[ComfyUI IPC] Handlers registered successfully');
            return handler;
        } catch (error) {
            console.error('[ComfyUI IPC] Failed to register handlers:', error);
            throw error;
        }
    }
};