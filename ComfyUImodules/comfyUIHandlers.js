// ComfyUImodules/comfyUIHandlers.js
const { ipcMain } = require('electron');
const fs = require('fs-extra');
const path = require('path');
const PathResolver = require('./PathResolver');

// 延迟创建路径解析器实例（按需）
let pathResolverInstance = null;
function getPathResolver() {
    if (!pathResolverInstance) {
        pathResolverInstance = new PathResolver();
    }
    return pathResolverInstance;
}

/**
 * 加载配置
 */
async function loadConfig() {
    try {
        // 使用PathResolver获取配置文件路径
        const configFile = await getPathResolver().getConfigFilePath();
        
        console.log('[Main] Attempting to load config from:', configFile);
        
        if (await fs.pathExists(configFile)) {
            const config = await fs.readJson(configFile);
            console.log('[Main] Successfully loaded config from file');
            return config;
        } else {
            console.log('[Main] Config file does not exist, using defaults');
            // 更新的默认配置（包含所有新字段）
            return {
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
        }
    } catch (error) {
        console.error('Error loading configuration:', error);
        return null;
    }
}

/**
 * Initializes ComfyUI related IPC handlers.
 */
function initialize(mainWindow) {
    // ComfyUI Configuration Handlers
    ipcMain.handle('comfyui:save-config', async (event, config) => {
        try {
            // 使用路径解析器获取配置文件路径
            let configFile;
            try {
                configFile = await getPathResolver().getConfigFilePath();
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
            
            console.log('[Main] ComfyUI configuration saved successfully to:', configFile);
            return { success: true };
        } catch (error) {
            console.error('Error saving ComfyUI configuration:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('comfyui:get-config', async () => {
        try {
            const config = await loadConfig();
            if (config) {
                return { success: true, data: config };
            }
            return { success: false, error: 'Failed to load configuration' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // ComfyUI 文件监听相关处理器
    ipcMain.handle('watch-comfyui-config', async () => {
        try {
            const configFile = await getPathResolver().getConfigFilePath();
            
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
            const configFile = await getPathResolver().getConfigFilePath();
            if (await fs.pathExists(configFile)) {
                return await fs.readJson(configFile);
            }
            // 与 loadConfig 默认保持一致，去除重复定义
            return {
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
        } catch {
            return null;
        }
    });

    // ComfyUI Workflow Management Handlers
    ipcMain.handle('comfyui:get-workflows', async () => {
        try {
            const workflowsDir = await getPathResolver().getWorkflowsPath();
            
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
            
            return { success: true, workflows };
        } catch (error) {
            console.error('Error loading ComfyUI workflows:', error);
            return { success: false, error: error.message, workflows: [] };
        }
    });

    ipcMain.handle('comfyui:read-workflow', async (event, { name }) => {
        try {
            const workflowsDir = await getPathResolver().getWorkflowsPath();
            const workflowFile = path.join(workflowsDir, `${name}.json`);
            
            if (await fs.pathExists(workflowFile)) {
                const content = await fs.readJson(workflowFile);
                console.log(`[Main] Loaded workflow content for: ${name}`);
                return { success: true, data: content };
            } else {
                throw new Error(`Workflow ${name} not found`);
            }
        } catch (error) {
            console.error(`Error loading workflow content for ${name}:`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('comfyui:save-workflow', async (event, { name, data }) => {
        try {
            const workflowsDir = await getPathResolver().getWorkflowsPath();
            const workflowFile = path.join(workflowsDir, `${name}.json`);
            
            // Ensure directory exists
            await fs.ensureDir(workflowsDir);
            
            // Save workflow content
            await fs.writeJson(workflowFile, data, { spaces: 2 });
            return { success: true, path: workflowFile };
        } catch (error) {
            console.error(`Error saving workflow ${name}:`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('comfyui:delete-workflow', async (event, { name }) => {
        try {
            // Prevent deletion of built-in workflows
            if (['text2img_basic', 'img2img_basic'].includes(name)) {
                throw new Error('Cannot delete built-in workflows');
            }
            
            const workflowsDir = await getPathResolver().getWorkflowsPath();
            const workflowFile = path.join(workflowsDir, `${name}.json`);
            
            if (await fs.pathExists(workflowFile)) {
                await fs.remove(workflowFile);
                return { success: true };
            } else {
                throw new Error(`Workflow ${name} not found`);
            }
        } catch (error) {
            console.error(`Error deleting workflow ${name}:`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('create-new-workflow', async (event, workflowName, templateType = 'text2img_basic') => {
        try {
            const workflowsDir = await getPathResolver().getWorkflowsPath();
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

    // 工作流模板转换处理器
    ipcMain.handle('convert-workflow-to-template', async (event, workflowData, templateName) => {
        try {
            // 参数验证
            if (!templateName || typeof templateName !== 'string') {
                throw new Error(`模板名称无效: ${templateName} (类型: ${typeof templateName})`);
            }
            
            if (!workflowData || typeof workflowData !== 'object') {
                if (typeof workflowData === 'string') {
                    try {
                        workflowData = JSON.parse(workflowData);
                    } catch (parseError) {
                        throw new Error(`工作流数据不是有效的JSON格式: ${parseError.message}`);
                    }
                } else {
                    throw new Error(`工作流数据无效: ${typeof workflowData}`);
                }
            }
            
            // 使用PathResolver获取VCPToolBox路径
            const toolboxPath = await getPathResolver().findVCPToolBoxPath();
            const processorPath = path.join(toolboxPath, 'Plugin', 'ComfyUIGen', 'WorkflowTemplateProcessor.js');
            
            // 动态导入WorkflowTemplateProcessor
            const WorkflowTemplateProcessor = require(processorPath);
            const processor = new WorkflowTemplateProcessor();
            
            // 转换工作流为模板
            const template = processor.convertToTemplate(workflowData);
            
            // 保存到templates目录
            const workflowsDir = await getPathResolver().getWorkflowsPath();
            const templatesDir = path.join(path.dirname(workflowsDir), 'templates');
            const templateFile = path.join(templatesDir, `${templateName}.json`);
            
            await fs.ensureDir(templatesDir);
            await fs.writeJson(templateFile, template, { spaces: 2 });
            
            return { 
                success: true, 
                templatePath: templateFile,
                replacements: template._template_metadata ? template._template_metadata.replacementsMade.length : 0,
                preserved: template._template_metadata ? template._template_metadata.preservedNodes.length : 0
            };
        } catch (error) {
            console.error(`Error converting workflow to template:`, error);
            return { success: false, error: error.message };
        }
    });

    // 导入原版工作流并自动转换
    ipcMain.handle('import-and-convert-workflow', async (event, workflowData, workflowName) => {
        try {
            // 参数验证
            if (!workflowName || typeof workflowName !== 'string') {
                throw new Error(`工作流名称无效: ${workflowName} (类型: ${typeof workflowName})`);
            }
            
            if (!workflowData) {
                throw new Error(`工作流数据为空或未定义`);
            }
            
            // 处理workflowData
            if (typeof workflowData === 'string') {
                try {
                    workflowData = JSON.parse(workflowData);
                } catch (parseError) {
                    throw new Error(`工作流数据不是有效的JSON格式: ${parseError.message}`);
                }
            }
            
            if (typeof workflowData !== 'object') {
                throw new Error(`工作流数据无效: ${typeof workflowData}`);
            }

            // 使用PathResolver获取VCPToolBox路径
            const toolboxPath = await getPathResolver().findVCPToolBoxPath();
            const processorPath = path.join(toolboxPath, 'Plugin', 'ComfyUIGen', 'WorkflowTemplateProcessor.js');

            // 动态导入WorkflowTemplateProcessor
            const WorkflowTemplateProcessor = require(processorPath);
            const processor = new WorkflowTemplateProcessor();

            // 转换为模板
            const template = processor.convertToTemplate(workflowData);

            // 保存到workflows目录
            const workflowsDir = await getPathResolver().getWorkflowsPath();
            const workflowFile = path.join(workflowsDir, `${workflowName}.json`);

            // 移除模板元数据，保存为标准模板工作流
            delete template._template_metadata;

            await fs.ensureDir(workflowsDir);
            await fs.writeJson(workflowFile, template, { spaces: 2 });

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

    // 验证工作流是否为模板格式
    ipcMain.handle('validate-workflow-template', async (event, workflowData) => {
        try {
            // 参数验证
            if (!workflowData || typeof workflowData !== 'object') {
                if (typeof workflowData === 'string') {
                    try {
                        workflowData = JSON.parse(workflowData);
                    } catch (parseError) {
                        throw new Error(`工作流数据不是有效的JSON格式: ${parseError.message}`);
                    }
                } else {
                    throw new Error(`工作流数据无效: ${typeof workflowData}`);
                }
            }
            
            // 使用PathResolver获取VCPToolBox路径
            const toolboxPath = await getPathResolver().findVCPToolBoxPath();
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