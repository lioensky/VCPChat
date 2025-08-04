// ComfyUImodules/comfyUIHandlers.js
const { ipcMain } = require('electron');
const fs = require('fs-extra');
const path = require('path');
const PathResolver = require('./PathResolver');

// 创建路径解析器实例
const pathResolver = new PathResolver();

// 后端配置缓存，提高性能
let configCache = null;
let configCacheTimestamp = 0;
const CONFIG_CACHE_TIMEOUT = 30000; // 30秒缓存超时

/**
 * 降级策略：在用户目录创建配置
 */
async function loadConfigFallback() {
    const os = require('os');
    const fallbackDir = path.join(os.homedir(), '.vcpchat', 'VCPToolBox', 'Plugin', 'ComfyUIGen');
    const fallbackConfigFile = path.join(fallbackDir, 'comfyui-settings.json');
    
    console.log('[Main] Using fallback config location:', fallbackConfigFile);
    
    try {
        // 确保目录存在
        await fs.ensureDir(fallbackDir);
        
        // 如果文件存在，读取它
        if (await fs.pathExists(fallbackConfigFile)) {
            const config = await fs.readJson(fallbackConfigFile);
            configCache = config;
            configCacheTimestamp = Date.now();
            return config;
        } else {
            // 创建默认配置
            const defaultConfig = {
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
                defaultLoRA: '',
                defaultLoRAStrength: 1.0,
                negativePrompt: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry',
                version: '1.0.0',
                lastUpdated: new Date().toISOString()
            };
            
            await fs.writeJson(fallbackConfigFile, defaultConfig, { spaces: 2 });
            configCache = defaultConfig;
            configCacheTimestamp = Date.now();
            return defaultConfig;
        }
    } catch (error) {
        console.error('[Main] Fallback config creation failed:', error);
        // 返回内存中的默认配置
        return {
            serverUrl: 'http://localhost:8188',
            apiKey: '',
            workflow: 'text2img_basic',
            defaultModel: 'sd_xl_base_1.0.safetensors',
            defaultWidth: 1024,
            defaultHeight: 1024,
            defaultSteps: 30,
            defaultCfg: 7.5,
            defaultSampler: 'dpmpp_2m'
        };
    }
}

/**
 * 加载配置（带缓存）
 */
async function loadConfigWithCache() {
    const now = Date.now();
    
    // 检查缓存是否有效
    if (configCache && (now - configCacheTimestamp) < CONFIG_CACHE_TIMEOUT) {
        return configCache;
    }
    
    try {
        // 使用PathResolver获取配置文件路径
        const configFile = await pathResolver.getConfigFilePath();
        
        console.log('[Main] Attempting to load config from:', configFile);
        
        if (await fs.pathExists(configFile)) {
            const config = await fs.readJson(configFile);
            
            // 更新缓存
            configCache = config;
            configCacheTimestamp = now;
            
            console.log('[Main] Successfully loaded config from file');
            return config;
        } else {
            console.log('[Main] Config file does not exist, using defaults');
            // 更新的默认配置（包含所有新字段）
            const defaultConfig = {
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
                defaultLoRA: '',
                defaultLoRAStrength: 1.0,
                negativePrompt: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry',
                version: '1.0.0',
                lastUpdated: new Date().toISOString()
            };
            
            // 缓存默认配置
            configCache = defaultConfig;
            configCacheTimestamp = now;
            
            return defaultConfig;
        }
    } catch (error) {
        console.error('Error loading configuration:', error);
        return null;
    }
}

/**
 * 清理配置缓存
 */
function clearConfigCache() {
    configCache = null;
    configCacheTimestamp = 0;
    console.log('[Main] ComfyUI config cache cleared');
}

/**
 * Initializes ComfyUI related IPC handlers.
 */
function initialize(mainWindow) {
    // ComfyUI Configuration Handlers
    ipcMain.handle('save-comfyui-config', async (event, config) => {
        try {
            // 使用路径解析器获取配置文件路径
            let configFile;
            try {
                configFile = await pathResolver.getConfigFilePath();
                // 确保目录存在
                await fs.ensureDir(path.dirname(configFile));
            } catch (pathError) {
                console.warn('[Main] PathResolver failed for save, using fallback:', pathError.message);
                // 降级到用户目录
                const os = require('os');
                const fallbackDir = path.join(os.homedir(), '.vcpchat', 'VCPToolBox', 'Plugin', 'ComfyUIGen');
                configFile = path.join(fallbackDir, 'comfyui-settings.json');
                await fs.ensureDir(fallbackDir);
            }
            
            console.log('[Main] Saving config to:', configFile);
            
            // Save configuration
            await fs.writeJson(configFile, config, { spaces: 2 });
            
            // 清理缓存，下次读取时会从文件加载
            clearConfigCache();
            
            console.log('[Main] ComfyUI configuration saved successfully to:', configFile);
            return { success: true };
        } catch (error) {
            console.error('Error saving ComfyUI configuration:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('load-comfyui-config', async () => {
        try {
            const config = await loadConfigWithCache();
            if (config) {
                console.log('[Main] ComfyUI configuration loaded successfully (with cache)');
                return config;
            } else {
                console.error('[Main] Failed to load ComfyUI configuration');
                return null;
            }
        } catch (error) {
            console.error('Error loading ComfyUI configuration:', error);
            return null;
        }
    });

    // ComfyUI 文件监听相关处理器
    ipcMain.handle('watch-comfyui-config', async () => {
        try {
            const configFile = await pathResolver.getConfigFilePath();
            
            console.log('[Main] Setting up file watcher for:', configFile);
            
            if (fs.existsSync(configFile)) {
                // 监听配置文件变化
                const watcher = fs.watch(configFile, (eventType, filename) => {
                    if (eventType === 'change') {
                        console.log('[Main] ComfyUI config file changed, notifying frontend');
                        // 通知前端配置文件已变化
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('comfyui-config-changed');
                        }
                    }
                });
                
                console.log('[Main] Started watching ComfyUI config file');
                return { success: true, watching: true };
            } else {
                console.log('[Main] ComfyUI config file does not exist yet at:', configFile);
                return { success: true, watching: false };
            }
        } catch (error) {
            console.error('Error setting up config file watcher:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-comfyui-config-realtime', async () => {
        try {
            // 实时读取，不使用缓存，用于文件变化后的实时更新
            const configFile = await pathResolver.getConfigFilePath();
            
            console.log('[Main] Real-time loading config from:', configFile);
            
            if (await fs.pathExists(configFile)) {
                const config = await fs.readJson(configFile);
                
                // 更新缓存
                configCache = config;
                configCacheTimestamp = Date.now();
                
                console.log('[Main] Real-time ComfyUI configuration loaded successfully');
                return config;
            } else {
                console.log('[Main] Config file not found for real-time load, using defaults');
                // 默认配置
                const defaultConfig = {
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
                    defaultLoRA: '',
                    defaultLoRAStrength: 1.0,
                    negativePrompt: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry'
                };
                
                // 更新缓存
                configCache = defaultConfig;
                configCacheTimestamp = Date.now();
                
                return defaultConfig;
            }
        } catch (error) {
            console.error('Error loading real-time ComfyUI configuration:', error);
            return null;
        }
    });

    // ComfyUI Workflow Management Handlers
    ipcMain.handle('load-comfyui-workflows', async () => {
        try {
            const workflowsDir = await pathResolver.getWorkflowsPath();
            
            // Ensure workflows directory exists
            await fs.ensureDir(workflowsDir);
            
            const files = await fs.readdir(workflowsDir);
            const workflows = [];
            
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const workflowName = path.basename(file, '.json');
                    const filePath = path.join(workflowsDir, file);
                    
                    try {
                        const content = await fs.readJson(filePath);
                        workflows.push({
                            name: workflowName,
                            displayName: content.displayName || workflowName,
                            description: content.description || '',
                            isCustom: !['text2img_basic', 'img2img_basic'].includes(workflowName)
                        });
                    } catch (error) {
                        console.warn(`Failed to read workflow ${file}:`, error.message);
                    }
                }
            }
            
            console.log(`[Main] Loaded ${workflows.length} ComfyUI workflows`);
            return workflows;
        } catch (error) {
            console.error('Error loading ComfyUI workflows:', error);
            return [];
        }
    });

    ipcMain.handle('load-workflow-content', async (event, workflowName) => {
        try {
            const workflowsDir = await pathResolver.getWorkflowsPath();
            const workflowFile = path.join(workflowsDir, `${workflowName}.json`);
            
            if (await fs.pathExists(workflowFile)) {
                const content = await fs.readJson(workflowFile);
                console.log(`[Main] Loaded workflow content for: ${workflowName}`);
                return content;
            } else {
                throw new Error(`Workflow ${workflowName} not found`);
            }
        } catch (error) {
            console.error(`Error loading workflow content for ${workflowName}:`, error);
            throw error;
        }
    });

    ipcMain.handle('save-workflow-content', async (event, workflowName, content) => {
        try {
            const workflowsDir = await pathResolver.getWorkflowsPath();
            const workflowFile = path.join(workflowsDir, `${workflowName}.json`);
            
            // Ensure directory exists
            await fs.ensureDir(workflowsDir);
            
            // Save workflow content
            await fs.writeJson(workflowFile, content, { spaces: 2 });
            console.log(`[Main] Saved workflow: ${workflowName}`);
            return { success: true };
        } catch (error) {
            console.error(`Error saving workflow ${workflowName}:`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('delete-workflow', async (event, workflowName) => {
        try {
            // Prevent deletion of built-in workflows
            if (['text2img_basic', 'img2img_basic'].includes(workflowName)) {
                throw new Error('Cannot delete built-in workflows');
            }
            
            const workflowsDir = await pathResolver.getWorkflowsPath();
            const workflowFile = path.join(workflowsDir, `${workflowName}.json`);
            
            if (await fs.pathExists(workflowFile)) {
                await fs.remove(workflowFile);
                console.log(`[Main] Deleted workflow: ${workflowName}`);
                return { success: true };
            } else {
                throw new Error(`Workflow ${workflowName} not found`);
            }
        } catch (error) {
            console.error(`Error deleting workflow ${workflowName}:`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('create-new-workflow', async (event, workflowName, templateType = 'text2img_basic') => {
        try {
            const workflowsDir = await pathResolver.getWorkflowsPath();
            const newWorkflowFile = path.join(workflowsDir, `${workflowName}.json`);
            
            // Check if workflow already exists
            if (await fs.pathExists(newWorkflowFile)) {
                throw new Error(`Workflow ${workflowName} already exists`);
            }
            
            // Load template workflow
            const templateFile = path.join(workflowsDir, `${templateType}.json`);
            let templateContent;
            
            if (await fs.pathExists(templateFile)) {
                templateContent = await fs.readJson(templateFile);
            } else {
                // Create basic template if none exists
                templateContent = {
                    displayName: workflowName,
                    description: `Custom workflow: ${workflowName}`,
                    version: "1.0",
                    workflow: {
                        // Basic ComfyUI workflow structure
                        "3": {
                            "inputs": {
                                "seed": 0,
                                "steps": 20,
                                "cfg": 8,
                                "sampler_name": "euler",
                                "scheduler": "normal",
                                "denoise": 1,
                                "model": ["4", 0],
                                "positive": ["6", 0],
                                "negative": ["7", 0],
                                "latent_image": ["5", 0]
                            },
                            "class_type": "KSampler"
                        },
                        "4": {
                            "inputs": {
                                "ckpt_name": "{{MODEL}}"
                            },
                            "class_type": "CheckpointLoaderSimple"
                        },
                        "5": {
                            "inputs": {
                                "width": "{{WIDTH}}",
                                "height": "{{HEIGHT}}",
                                "batch_size": 1
                            },
                            "class_type": "EmptyLatentImage"
                        },
                        "6": {
                            "inputs": {
                                "text": "{{POSITIVE_PROMPT}}",
                                "clip": ["4", 1]
                            },
                            "class_type": "CLIPTextEncode"
                        },
                        "7": {
                            "inputs": {
                                "text": "{{NEGATIVE_PROMPT}}",
                                "clip": ["4", 1]
                            },
                            "class_type": "CLIPTextEncode"
                        },
                        "8": {
                            "inputs": {
                                "samples": ["3", 0],
                                "vae": ["4", 2]
                            },
                            "class_type": "VAEDecode"
                        },
                        "9": {
                            "inputs": {
                                "filename_prefix": "ComfyUI",
                                "images": ["8", 0]
                            },
                            "class_type": "SaveImage"
                        }
                    }
                };
            }
            
            // Update template with new name
            templateContent.displayName = workflowName;
            templateContent.description = `Custom workflow: ${workflowName}`;
            
            // Save new workflow
            await fs.writeJson(newWorkflowFile, templateContent, { spaces: 2 });
            console.log(`[Main] Created new workflow: ${workflowName}`);
            return { success: true };
        } catch (error) {
            console.error(`Error creating workflow ${workflowName}:`, error);
            return { success: false, error: error.message };
        }
    });

    // 新增：工作流模板转换处理器
    ipcMain.handle('convert-workflow-to-template', async (event, workflowData, templateName) => {
        try {
            console.log(`[Main] Converting workflow to template: ${templateName}`);
            
            // 使用PathResolver获取VCPToolBox路径
            const toolboxPath = await pathResolver.findVCPToolBoxPath();
            const processorPath = path.join(toolboxPath, 'Plugin', 'ComfyUIGen', 'WorkflowTemplateProcessor.js');
            
            // 动态导入WorkflowTemplateProcessor
            const WorkflowTemplateProcessor = require(processorPath);
            const processor = new WorkflowTemplateProcessor();
            
            // 转换工作流为模板
            const template = processor.convertToTemplate(workflowData);
            
            // 保存到templates目录
            const workflowsDir = await pathResolver.getWorkflowsPath();
            const templatesDir = path.join(path.dirname(workflowsDir), 'templates');
            const templateFile = path.join(templatesDir, `${templateName}.json`);
            
            await fs.ensureDir(templatesDir);
            await fs.writeJson(templateFile, template, { spaces: 2 });
            
            console.log(`[Main] Template saved to: ${templateFile}`);
            
            return { 
                success: true, 
                templatePath: templateFile,
                replacements: template._template_metadata.replacementsMade.length,
                preserved: template._template_metadata.preservedNodes.length
            };
        } catch (error) {
            console.error(`Error converting workflow to template:`, error);
            return { success: false, error: error.message };
        }
    });

    // 新增：导入原版工作流并自动转换
    ipcMain.handle('import-and-convert-workflow', async (event, workflowData, workflowName) => {
        try {
            console.log(`[Main] Importing and converting workflow: ${workflowName}`);
            
            // 使用PathResolver获取VCPToolBox路径
            const toolboxPath = await pathResolver.findVCPToolBoxPath();
            const processorPath = path.join(toolboxPath, 'Plugin', 'ComfyUIGen', 'WorkflowTemplateProcessor.js');
            
            // 动态导入WorkflowTemplateProcessor
            const WorkflowTemplateProcessor = require(processorPath);
            const processor = new WorkflowTemplateProcessor();
            
            // 转换为模板
            const template = processor.convertToTemplate(workflowData);
            
            // 保存到workflows目录
            const workflowsDir = await pathResolver.getWorkflowsPath();
            const workflowFile = path.join(workflowsDir, `${workflowName}.json`);
            
            // 移除模板元数据，保存为标准模板工作流
            delete template._template_metadata;
            
            await fs.ensureDir(workflowsDir);
            await fs.writeJson(workflowFile, template, { spaces: 2 });
            
            console.log(`[Main] Converted workflow saved to: ${workflowFile}`);
            
            return { 
                success: true, 
                workflowPath: workflowFile,
                message: `工作流 "${workflowName}" 已成功转换并保存`
            };
        } catch (error) {
            console.error(`Error importing and converting workflow:`, error);
            return { success: false, error: error.message };
        }
    });

    // 新增：验证工作流是否为模板格式
    ipcMain.handle('validate-workflow-template', async (event, workflowData) => {
        try {
            // 使用PathResolver获取VCPToolBox路径
            const toolboxPath = await pathResolver.findVCPToolBoxPath();
            const processorPath = path.join(toolboxPath, 'Plugin', 'ComfyUIGen', 'WorkflowTemplateProcessor.js');
            
            // 动态导入WorkflowTemplateProcessor
            const WorkflowTemplateProcessor = require(processorPath);
            const processor = new WorkflowTemplateProcessor();
            
            // 检查是否包含占位符
            const placeholders = processor.getTemplatePlaceholders(workflowData);
            const isTemplate = placeholders.length > 0;
            
            return {
                success: true,
                isTemplate,
                placeholders,
                hasMetadata: !!workflowData._template_metadata
            };
        } catch (error) {
            console.error(`Error validating workflow template:`, error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    initialize
};