// WorkflowEditor Node Manager Module
(function() {
    'use strict';

    class WorkflowEditor_NodeManager {
        constructor() {
            if (WorkflowEditor_NodeManager.instance) {
                return WorkflowEditor_NodeManager.instance;
            }
            
            this.stateManager = null;
            this.nodeTypes = new Map();
            this.nodeExecutors = new Map();
            
            WorkflowEditor_NodeManager.instance = this;
        }

        static getInstance() {
            if (!WorkflowEditor_NodeManager.instance) {
                WorkflowEditor_NodeManager.instance = new WorkflowEditor_NodeManager();
            }
            return WorkflowEditor_NodeManager.instance;
        }

        // 初始化节点管理器
        init(stateManager) {
            this.stateManager = stateManager;
            this.registerNodeTypes();
            this.registerNodeExecutors();
            console.log('[WorkflowEditor_NodeManager] Initialized');
        }

        // 注册节点类型
        registerNodeTypes() {
            // VCPChat插件节点
            this.registerNodeType('vcpChat', {
                category: 'vcpChat',
                inputs: ['trigger'],
                outputs: ['result', 'error'],
                configSchema: {
                    pluginId: { type: 'string', required: true },
                    command: { type: 'string', required: true },
                    parameters: { type: 'object', default: {} }
                },
                dynamicInputs: true // 支持动态输入端点
            });

            // VCPToolBox插件节点
            this.registerNodeType('VCPToolBox', {
                category: 'vcpToolBox',
                inputs: ['trigger'],
                outputs: ['result', 'error'],
                configSchema: {
                    pluginId: { type: 'string', required: true },
                    command: { type: 'string', required: true },
                    parameters: { type: 'object', default: {} }
                },
                dynamicInputs: true // 支持动态输入端点
            });

            // 注册具体的插件节点类型
            this.registerPluginNodeTypes();

            // 辅助节点类型
            this.registerAuxiliaryNodeTypes();
        }

        // 注册具体的插件节点类型
        registerPluginNodeTypes() {
            // FileOperator 插件节点
            this.registerNodeType('FileOperator', {
                category: 'vcpChat',
                inputs: ['trigger'],
                outputs: ['result', 'error'],
                configSchema: {
                    url: { type: 'string', required: false, default: '' },
                    downloadDir: { type: 'string', required: false, default: '' },
                    command: { type: 'string', required: false, default: 'DownloadFile' }
                },
                dynamicInputs: true
            });

            // 其他常见插件节点类型
            this.registerNodeType('TodoManager', {
                category: 'vcpToolBox',
                inputs: ['trigger'],
                outputs: ['result', 'error'],
                configSchema: {
                    action: { type: 'string', required: false, default: 'list' },
                    task: { type: 'string', required: false, default: '' }
                },
                dynamicInputs: true
            });

            this.registerNodeType('FluxGen', {
                category: 'vcpToolBox',
                inputs: ['trigger'],
                outputs: ['result', 'error'],
                configSchema: {
                    prompt: { type: 'string', required: false, default: '' },
                    width: { type: 'number', required: false, default: 512 },
                    height: { type: 'number', required: false, default: 512 }
                },
                dynamicInputs: true
            });

            this.registerNodeType('ComfyUIGen', {
                category: 'vcpToolBox',
                inputs: ['trigger'],
                outputs: ['result', 'error'],
                configSchema: {
                    prompt: { type: 'string', required: false, default: '' },
                    workflow: { type: 'string', required: false, default: '' }
                },
                dynamicInputs: true
            });

            this.registerNodeType('BilibiliFetch', {
                category: 'vcpToolBox',
                inputs: ['trigger'],
                outputs: ['result', 'error'],
                configSchema: {
                    url: { type: 'string', required: false, default: '' },
                    type: { type: 'string', required: false, default: 'info' }
                },
                dynamicInputs: true
            });

            this.registerNodeType('VideoGenerator', {
                category: 'vcpToolBox',
                inputs: ['trigger'],
                outputs: ['result', 'error'],
                configSchema: {
                    prompt: { type: 'string', required: false, default: '' },
                    duration: { type: 'number', required: false, default: 5 }
                },
                dynamicInputs: true
            });
        }

        // 注册辅助节点类型
        registerAuxiliaryNodeTypes() {
            // 正则处理节点
            this.registerNodeType('regex', {
                category: 'auxiliary',
                inputs: ['input'],
                outputs: ['output', 'matches'],
                configSchema: {
                    pattern: { 
                        type: 'string', 
                        required: true, 
                        default: '',
                        label: '正则表达式 (Pattern)',
                        description: '用于匹配或替换的正则表达式模式，如: \\d+ 匹配数字，[a-zA-Z]+ 匹配字母',
                        placeholder: '例如: https?://[^\\s]+ 匹配URL'
                    },
                    flags: { 
                        type: 'string', 
                        default: 'g',
                        label: '正则标志 (Flags)',
                        description: '正则表达式标志：g=全局匹配，i=忽略大小写，m=多行模式，s=单行模式',
                        placeholder: '例如: gi 表示全局忽略大小写'
                    },
                    operation: { 
                        type: 'enum', 
                        options: ['match', 'replace', 'test', 'split'],
                        default: 'match',
                        label: '操作类型 (Operation)',
                        description: '选择正则操作：match=匹配提取，replace=替换文本，test=测试匹配，split=分割字符串'
                    },
                    replacement: { 
                        type: 'string', 
                        default: '',
                        label: '替换文本 (Replacement)',
                        description: '替换操作时的目标文本，支持 $1, $2 等捕获组引用',
                        placeholder: '例如: $1 引用第一个捕获组'
                    },
                    outputParamName: { 
                        type: 'string', 
                        default: 'regexResult',
                        label: '输出参数名 (Output Param Name)',
                        description: '输出结果的参数名称，用于下游节点引用处理结果',
                        placeholder: '例如: extractedUrl 或 matchedText'
                    }
                }
            });

            // 数据转换节点
            this.registerNodeType('dataTransform', {
                category: 'auxiliary',
                inputs: ['input'],
                outputs: ['output'],
                configSchema: {
                    transformType: {
                        type: 'enum',
                        options: ['json-parse', 'json-stringify', 'to-string', 'to-number', 'to-array', 'custom'],
                        default: 'json-parse',
                        label: '转换类型 (Transform Type)',
                        description: '数据转换方式：json-parse=解析JSON，json-stringify=转为JSON字符串，to-string=转为字符串，to-number=转为数字，to-array=转为数组，custom=自定义脚本'
                    },
                    customScript: { 
                        type: 'string', 
                        default: '',
                        label: '自定义脚本 (Custom Script)',
                        description: '自定义JavaScript代码进行数据转换，输入数据通过 input 变量访问，返回转换结果',
                        placeholder: '例如: return input.map(item => item.toUpperCase())'
                    },
                    outputParamName: { 
                        type: 'string', 
                        default: 'transformedData',
                        label: '输出参数名 (Output Param Name)',
                        description: '输出结果的参数名称，用于下游节点引用转换后的数据',
                        placeholder: '例如: processedArray 或 convertedData'
                    }
                }
            });

            // 代码编辑节点
            this.registerNodeType('codeEdit', {
                category: 'auxiliary',
                inputs: ['input'],
                outputs: ['output'],
                configSchema: {
                    language: {
                        type: 'enum',
                        options: ['javascript', 'python', 'html', 'css', 'json'],
                        default: 'javascript',
                        label: '编程语言 (Language)',
                        description: '选择代码的编程语言类型，影响语法高亮和处理方式'
                    },
                    code: { 
                        type: 'string', 
                        default: '',
                        label: '代码内容 (Code)',
                        description: '要处理的代码内容，支持多行输入和语法高亮显示',
                        placeholder: '输入您的代码...'
                    },
                    operation: {
                        type: 'enum',
                        options: ['format', 'minify', 'validate', 'execute'],
                        default: 'format',
                        label: '操作类型 (Operation)',
                        description: '代码处理操作：format=格式化美化，minify=压缩代码，validate=语法验证，execute=执行代码'
                    }
                }
            });

            // 条件判断节点
            this.registerNodeType('condition', {
                category: 'auxiliary',
                inputs: ['input'],
                outputs: ['true', 'false'],
                configSchema: {
                    condition: { 
                        type: 'string', 
                        required: true, 
                        default: '',
                        label: '条件表达式 (Condition)',
                        description: '要判断的条件表达式或字段路径，如: input.status 或 input.length',
                        placeholder: '例如: input.status 或 input.data.length'
                    },
                    operator: {
                        type: 'enum',
                        options: ['==', '!=', '>', '<', '>=', '<=', 'contains', 'startsWith', 'endsWith'],
                        default: '==',
                        label: '比较运算符 (Operator)',
                        description: '条件比较运算符：==等于，!=不等于，>大于，<小于，>=大于等于，<=小于等于，contains包含，startsWith开头匹配，endsWith结尾匹配'
                    },
                    value: { 
                        type: 'string', 
                        default: '',
                        label: '比较值 (Value)',
                        description: '用于比较的目标值，支持字符串、数字等类型',
                        placeholder: '例如: success 或 100 或 error'
                    }
                }
            });

            // 循环控制节点
            this.registerNodeType('loop', {
                category: 'auxiliary',
                inputs: ['input', 'items'],
                outputs: ['output', 'item', 'index'],
                configSchema: {
                    loopType: {
                        type: 'enum',
                        options: ['forEach', 'times', 'while'],
                        default: 'forEach',
                        label: '循环类型 (Loop Type)',
                        description: '循环执行方式：forEach=遍历数组每个元素，times=指定次数循环，while=条件循环'
                    },
                    maxIterations: { 
                        type: 'number', 
                        default: 100,
                        label: '最大迭代次数 (Max Iterations)',
                        description: '循环的最大执行次数，防止无限循环导致系统卡死',
                        min: 1,
                        max: 10000
                    }
                }
            });

            // 延时等待节点
            this.registerNodeType('delay', {
                category: 'auxiliary',
                inputs: ['input'],
                outputs: ['output'],
                configSchema: {
                    delay: { 
                        type: 'number', 
                        default: 1000, 
                        min: 0,
                        label: '延时时长 (Delay Duration)',
                        description: '等待的时间长度，配合时间单位使用，用于控制执行节奏',
                        placeholder: '例如: 1000 (毫秒) 或 5 (秒)'
                    },
                    unit: {
                        type: 'enum',
                        options: ['milliseconds', 'seconds', 'minutes'],
                        default: 'milliseconds',
                        label: '时间单位 (Time Unit)',
                        description: '延时的时间单位：milliseconds=毫秒，seconds=秒，minutes=分钟'
                    }
                }
            });

            // URL渲染节点
            this.registerNodeType('urlRenderer', {
                category: 'auxiliary',
                inputs: ['input', 'trigger'],
                outputs: ['result'],
                configSchema: {
                    urlPath: { 
                        type: 'string', 
                        default: 'url', 
                        required: false,
                        label: 'URL路径 (URL Path)',
                        description: 'JSON中URL字段的路径，如: url 或 data.imageUrl 或 result.images[0]，支持数组路径如: images',
                        placeholder: '例如: {{input.extractedUrls}} 或 url 或 data.imageUrl'
                    },
                    renderType: {
                        type: 'enum',
                        options: ['auto', 'image', 'video', 'iframe', 'text'],
                        default: 'auto',
                        label: '渲染类型 (Render Type)',
                        description: '选择URL内容的渲染方式：auto=自动检测，image=图片，video=视频，iframe=网页嵌入，text=纯文本链接'
                    },
                    batchMode: {
                        type: 'boolean',
                        default: true,
                        label: '批量模式 (Batch Mode)',
                        description: '启用批量渲染模式，自动检测单个URL或URL数组，支持多图片网格显示'
                    },
                    maxItems: {
                        type: 'number',
                        default: 10,
                        min: 1,
                        max: 50,
                        label: '最大项目数 (Max Items)',
                        description: '批量渲染时的最大项目数量，超出部分将被截断以避免性能问题'
                    },
                    gridColumns: {
                        type: 'number',
                        default: 3,
                        min: 1,
                        max: 6,
                        label: '网格列数 (Grid Columns)',
                        description: '多图片显示时的网格布局列数，1-6列可选，影响图片排列方式'
                    },
                    width: { 
                        type: 'number', 
                        default: 300, 
                        min: 50, 
                        max: 800,
                        label: '显示宽度 (Width)',
                        description: '渲染区域的宽度（像素），影响图片和视频的显示尺寸'
                    },
                    height: { 
                        type: 'number', 
                        default: 200, 
                        min: 50, 
                        max: 600,
                        label: '显示高度 (Height)',
                        description: '渲染区域的高度（像素），影响图片和视频的显示尺寸'
                    },
                    autoRefresh: { 
                        type: 'boolean', 
                        default: true,
                        label: '自动刷新 (Auto Refresh)',
                        description: '当输入数据变化时自动刷新显示内容，建议保持开启'
                    },
                    showControls: { 
                        type: 'boolean', 
                        default: true,
                        label: '显示控件 (Show Controls)',
                        description: '显示图片缩放、网格调整等交互控件，提供更好的用户体验'
                    },
                    allowFullscreen: { 
                        type: 'boolean', 
                        default: true,
                        label: '允许全屏 (Allow Fullscreen)',
                        description: '允许点击图片进入全屏查看模式，方便查看大图'
                    },
                    outputParamName: { 
                        type: 'string', 
                        default: 'renderedUrl', 
                        label: '输出参数名 (Output Param Name)',
                        description: '输出结果的参数名称，用于下游节点引用渲染结果',
                        placeholder: '例如: displayedImage 或 renderedContent'
                    }
                }
            });

            // 内容输入器节点
            this.registerNodeType('contentInput', {
                label: '内容输入器', // 添加 label 属性
                type: 'contentInput', // 添加 type 属性
                category: 'auxiliary',
                inputs: [], // 作为输入端节点，没有输入
                outputs: [{ name: 'output', type: 'string' }], // 明确输出类型
                configSchema: {
                    content: {
                        type: 'string',
                        default: '',
                        required: false,
                        label: '输入内容 (Content)',
                        description: '输入任意文本内容，支持字符串、URL、JSON等格式，作为工作流的起始数据源',
                        placeholder: '输入文本、URL、JSON数据等...',
                        ui: {
                            component: 'textarea', // 使用多行文本框
                            rows: 5
                        }
                    },
                    outputParamName: { // 移动到 configSchema 内部
                        type: 'string', 
                        default: 'output', 
                        required: false,
                        label: '输出参数名 (Output Param Name)',
                        description: '自定义输出参数名称，用于下游节点引用此内容',
                        placeholder: '例如: myContent 或 inputData'
                    }
                },
                properties: { content: '' } // 兼容旧版，保留properties
            });

            // URL提取器节点
            this.registerNodeType('urlExtractor', {
                label: 'URL提取器',
                category: 'auxiliary',
                inputs: ['input'],
                outputs: ['urls', 'result'],
                configSchema: {
                    urlTypes: {
                        type: 'multiselect',
                        options: ['image', 'video', 'audio', 'all'],
                        default: ['image'],
                        label: 'URL类型 (URL Types)',
                        description: '要提取的URL类型：image=图片链接，video=视频链接，audio=音频链接，all=所有类型'
                    },
                    deduplication: {
                        type: 'boolean',
                        default: true,
                        label: '去重处理 (Deduplication)',
                        description: '是否对提取的URL进行去重处理，避免重复链接'
                    },
                    outputFormat: {
                        type: 'enum',
                        options: ['array', 'single', 'object'],
                        default: 'array',
                        label: '输出格式 (Output Format)',
                        description: '输出格式：array=URL数组，single=单个URL（取第一个），object=详细信息对象'
                    },
                    outputParamName: {
                        type: 'string',
                        default: 'extractedUrls',
                        label: '输出参数名 (Output Param Name)',
                        description: '输出结果的参数名称，用于下游节点引用提取的URL',
                        placeholder: '例如: imageUrls 或 videoLinks'
                    }
                }
            });

            // 图片上传节点
            this.registerNodeType('imageUpload', {
                label: '图片上传器',
                category: 'auxiliary',
                inputs: [], // 作为起始节点，没有输入
                outputs: ['imageData'],
                configSchema: {
                    outputParamName: {
                        type: 'string',
                        default: 'imageBase64',
                        label: '输出参数名 (Output Param Name)',
                        description: '输出结果的参数名称，用于下游节点引用上传的图片数据',
                        placeholder: '例如: uploadedImage 或 imageData'
                    },
                    maxFileSize: {
                        type: 'number',
                        default: 10,
                        min: 1,
                        max: 50,
                        label: '最大文件大小 (Max File Size)',
                        description: '允许上传的最大文件大小限制（MB），超出将被拒绝'
                    },
                    acceptedFormats: {
                        type: 'multiselect',
                        options: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'],
                        default: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
                        label: '支持格式 (Accepted Formats)',
                        description: '允许上传的图片格式类型，可多选'
                    },
                    compressionQuality: {
                        type: 'number',
                        default: 0.8,
                        min: 0.1,
                        max: 1.0,
                        step: 0.1,
                        label: '压缩质量 (Compression Quality)',
                        description: '图片压缩质量（0.1-1.0），1.0为无损，数值越小文件越小但质量越低'
                    },
                    maxWidth: {
                        type: 'number',
                        default: 1920,
                        min: 100,
                        max: 4096,
                        description: '最大宽度（像素）'
                    },
                    maxHeight: {
                        type: 'number',
                        default: 1080,
                        min: 100,
                        max: 4096,
                        description: '最大高度（像素）'
                    }
                }
            });
        }

        // 注册节点类型
        registerNodeType(type, definition) {
            this.nodeTypes.set(type, definition);
        }

        // 获取节点类型定义
        getNodeType(type) {
            return this.nodeTypes.get(type);
        }

        // 获取所有节点类型
        getAllNodeTypes() {
            return Array.from(this.nodeTypes.entries());
        }

        // 注册节点执行器
        registerNodeExecutors() {
            // VCP插件执行器
            this.registerNodeExecutor('vcpChat', this.executeVCPChatPlugin.bind(this));
            this.registerNodeExecutor('vcpToolBox', this.executeVCPToolBoxPlugin.bind(this));

            // 辅助节点执行器
            this.registerNodeExecutor('regex', this.executeRegexNode.bind(this));
            this.registerNodeExecutor('dataTransform', this.executeDataTransformNode.bind(this));
            this.registerNodeExecutor('codeEdit', this.executeCodeEditNode.bind(this));
            this.registerNodeExecutor('condition', this.executeConditionNode.bind(this));
            this.registerNodeExecutor('loop', this.executeLoopNode.bind(this));
            this.registerNodeExecutor('delay', this.executeDelayNode.bind(this));
            this.registerNodeExecutor('urlRenderer', this.executeUrlRendererNode.bind(this));
            this.registerNodeExecutor('urlExtractor', this.executeUrlExtractorNode.bind(this));
            this.registerNodeExecutor('imageUpload', this.executeImageUploadNode.bind(this));
        }

        // 注册节点执行器
        registerNodeExecutor(type, executor) {
            this.nodeExecutors.set(type, executor);
        }

        // 执行节点
        async executeNode(nodeId, inputData = {}) {
            const node = this.stateManager.getNode(nodeId);
            if (!node) {
                throw new Error(`Node ${nodeId} not found`);
            }

            const executor = this.nodeExecutors.get(node.pluginId || node.type);
            if (!executor) {
                throw new Error(`No executor found for node type: ${node.pluginId || node.type}`);
            }

            try {
                this.stateManager.setNodeStatus(nodeId, 'running');
                const result = await executor(node, inputData);
                this.stateManager.setNodeStatus(nodeId, 'success');
                return result;
            } catch (error) {
                this.stateManager.setNodeStatus(nodeId, 'error');
                throw error;
            }
        }

        // 执行VCPChat插件
        async executeVCPChatPlugin(node, inputData) {
            // TODO: 集成VCPChat插件系统
            console.log(`Executing VCPChat plugin: ${node.pluginId}`, inputData);
            
            // 模拟插件执行
            await this.delay(1000);
            
            return {
                result: `VCPChat ${node.pluginId} executed successfully`,
                data: inputData,
                timestamp: new Date().toISOString()
            };
        }

        // 执行VCPToolBox插件
        async executeVCPToolBoxPlugin(node, inputData) {
            // TODO: 集成VCPToolBox插件系统
            console.log(`Executing VCPToolBox plugin: ${node.pluginId}`, inputData);
            
            // 模拟插件执行
            await this.delay(1500);
            
            return {
                result: `VCPToolBox ${node.pluginId} executed successfully`,
                data: inputData,
                timestamp: new Date().toISOString()
            };
        }

        // 执行正则处理节点
        async executeRegexNode(node, inputData) {
            const { pattern, flags, operation, replacement } = node.config;
            const input = inputData.input || '';

            if (!pattern) {
                throw new Error('Regex pattern is required');
            }

            try {
                const regex = new RegExp(pattern, flags);
                let result;

                switch (operation) {
                    case 'match':
                        result = input.match(regex);
                        return { output: result, matches: result };
                    
                    case 'replace':
                        result = input.replace(regex, replacement || '');
                        return { output: result };
                    
                    case 'test':
                        result = regex.test(input);
                        return { output: result };
                    
                    case 'split':
                        result = input.split(regex);
                        return { output: result };
                    
                    default:
                        throw new Error(`Unknown regex operation: ${operation}`);
                }
            } catch (error) {
                throw new Error(`Regex execution failed: ${error.message}`);
            }
        }

        // 执行数据转换节点
        async executeDataTransformNode(node, inputData) {
            const { transformType, customScript } = node.config;
            const input = inputData.input;

            try {
                let result;

                switch (transformType) {
                    case 'json-parse':
                        result = JSON.parse(input);
                        break;
                    
                    case 'json-stringify':
                        result = JSON.stringify(input, null, 2);
                        break;
                    
                    case 'to-string':
                        result = String(input);
                        break;
                    
                    case 'to-number':
                        result = Number(input);
                        if (isNaN(result)) {
                            throw new Error('Cannot convert to number');
                        }
                        break;
                    
                    case 'to-array':
                        result = Array.isArray(input) ? input : [input];
                        break;
                    
                    default:
                        if (customScript) {
                            // 执行自定义脚本
                            const func = new Function('input', customScript);
                            result = func(input);
                        } else {
                            result = input;
                        }
                }

                return { output: result };
            } catch (error) {
                throw new Error(`Data transform failed: ${error.message}`);
            }
        }

        // 执行代码编辑节点
        async executeCodeEditNode(node, inputData) {
            const { language, code, operation } = node.config;
            const input = inputData.input || code;

            try {
                let result;

                switch (operation) {
                    case 'format':
                        // 简单的代码格式化
                        result = this.formatCode(input, language);
                        break;
                    
                    case 'minify':
                        // 简单的代码压缩
                        result = this.minifyCode(input, language);
                        break;
                    
                    case 'validate':
                        // 代码验证
                        result = this.validateCode(input, language);
                        break;
                    
                    case 'execute':
                        // 执行代码（仅JavaScript）
                        if (language === 'javascript') {
                            const func = new Function(input);
                            result = func();
                        } else {
                            throw new Error(`Cannot execute ${language} code`);
                        }
                        break;
                    
                    default:
                        result = input;
                }

                return { output: result };
            } catch (error) {
                throw new Error(`Code edit failed: ${error.message}`);
            }
        }

        // 执行条件判断节点
        async executeConditionNode(node, inputData) {
            const { condition, operator, value } = node.config;
            const input = inputData.input;

            try {
                let result;

                switch (operator) {
                    case '==':
                        result = input == value;
                        break;
                    case '!=':
                        result = input != value;
                        break;
                    case '>':
                        result = Number(input) > Number(value);
                        break;
                    case '<':
                        result = Number(input) < Number(value);
                        break;
                    case '>=':
                        result = Number(input) >= Number(value);
                        break;
                    case '<=':
                        result = Number(input) <= Number(value);
                        break;
                    case 'contains':
                        result = String(input).includes(String(value));
                        break;
                    case 'startsWith':
                        result = String(input).startsWith(String(value));
                        break;
                    case 'endsWith':
                        result = String(input).endsWith(String(value));
                        break;
                    default:
                        // 自定义条件表达式
                        const func = new Function('input', 'value', `return ${condition}`);
                        result = func(input, value);
                }

                return result ? { true: input } : { false: input };
            } catch (error) {
                throw new Error(`Condition evaluation failed: ${error.message}`);
            }
        }

        // 执行循环控制节点
        async executeLoopNode(node, inputData) {
            const { loopType, maxIterations } = node.config;
            const input = inputData.input;
            const items = inputData.items || [];

            try {
                const results = [];

                switch (loopType) {
                    case 'forEach':
                        for (let i = 0; i < Math.min(items.length, maxIterations); i++) {
                            results.push({
                                output: input,
                                item: items[i],
                                index: i
                            });
                        }
                        break;
                    
                    case 'times':
                        const times = Math.min(Number(input) || 1, maxIterations);
                        for (let i = 0; i < times; i++) {
                            results.push({
                                output: input,
                                item: i,
                                index: i
                            });
                        }
                        break;
                    
                    case 'while':
                        // 简单的while循环实现
                        let count = 0;
                        while (count < maxIterations && input) {
                            results.push({
                                output: input,
                                item: count,
                                index: count
                            });
                            count++;
                        }
                        break;
                }

                return { output: results };
            } catch (error) {
                throw new Error(`Loop execution failed: ${error.message}`);
            }
        }

        // 执行延时等待节点
        async executeDelayNode(node, inputData) {
            const { delay, unit } = node.config;
            const input = inputData.input;

            let delayMs = delay;
            switch (unit) {
                case 'seconds':
                    delayMs = delay * 1000;
                    break;
                case 'minutes':
                    delayMs = delay * 60 * 1000;
                    break;
            }

            await this.delay(delayMs);
            return { output: input };
        }

        // 执行URL渲染节点
        async executeUrlRendererNode(node, inputData) {
            const { urlPath, renderType, width, height, autoRefresh, showControls, allowFullscreen } = node.config;
            const input = inputData.input || inputData.url;

            if (!input) {
                throw new Error('Input data is required for URL rendering');
            }

            try {
                // 从输入数据中提取URL
                const url = this.extractUrlFromData(input, urlPath || 'url');
                
                if (!url) {
                    throw new Error(`URL not found in input data using path: ${urlPath || 'url'}`);
                }

                // 检测URL类型
                const detectedType = renderType === 'auto' ? this.detectUrlType(url) : renderType;
                
                // 在节点UI中实时显示渲染结果
                const nodeElement = document.querySelector(`[data-node-id="${node.id}"]`);
                if (nodeElement) {
                    this.renderUrlInNode(nodeElement, url, detectedType, { width, height, showControls, allowFullscreen });
                }

                return { 
                    result: url, 
                    rendered: true, 
                    type: detectedType,
                    originalData: input,
                    timestamp: new Date().toISOString()
                };
            } catch (error) {
                throw new Error(`URL rendering failed: ${error.message}`);
            }
        }

        // 从复合数据中提取URL
        extractUrlFromData(data, path) {
            if (!data || !path) return null;

            // 如果输入直接是字符串URL
            if (typeof data === 'string' && this.isValidUrl(data)) {
                return data;
            }

            // 如果输入不是对象，返回null
            if (typeof data !== 'object') return null;

            try {
                // 支持多种路径格式
                const pathParts = path.split('.');
                let current = data;

                for (const part of pathParts) {
                    // 处理数组索引，如 images[0]
                    if (part.includes('[') && part.includes(']')) {
                        const arrayName = part.substring(0, part.indexOf('['));
                        const indexStr = part.substring(part.indexOf('[') + 1, part.indexOf(']'));
                        const index = parseInt(indexStr);

                        if (arrayName && current[arrayName] && Array.isArray(current[arrayName])) {
                            current = current[arrayName][index];
                        } else {
                            return null;
                        }
                    } else {
                        // 普通属性访问
                        if (current && typeof current === 'object' && current.hasOwnProperty(part)) {
                            current = current[part];
                        } else {
                            return null;
                        }
                    }
                }

                // 验证最终结果是否为有效URL
                if (typeof current === 'string' && this.isValidUrl(current)) {
                    return current;
                }

                return null;
            } catch (error) {
                console.error('Error extracting URL from data:', error);
                return null;
            }
        }

        // 验证是否为有效URL
        isValidUrl(string) {
            try {
                new URL(string);
                return true;
            } catch (_) {
                // 也支持相对路径或简单的文件路径
                return /^(https?:\/\/|\/|\.\/|\w+\.\w+)/.test(string);
            }
        }

        // 检测URL类型
        detectUrlType(url) {
            const urlLower = url.toLowerCase();
            
            // 图片格式
            if (/\.(jpg|jpeg|png|gif|bmp|webp|svg)(\?.*)?$/i.test(urlLower)) {
                return 'image';
            }
            
            // 视频格式
            if (/\.(mp4|webm|ogg|avi|mov|wmv|flv|mkv)(\?.*)?$/i.test(urlLower)) {
                return 'video';
            }
            
            // 音频格式
            if (/\.(mp3|wav|ogg|aac|flac|m4a)(\?.*)?$/i.test(urlLower)) {
                return 'audio';
            }
            
            // 文档格式
            if (/\.(pdf|doc|docx|txt)(\?.*)?$/i.test(urlLower)) {
                return 'iframe';
            }
            
            // 默认使用iframe
            return 'iframe';
        }

        // 在节点中渲染URL内容
        renderUrlInNode(nodeElement, url, type, config) {
            let renderArea = nodeElement.querySelector('.url-render-area');
            
            if (!renderArea) {
                // 创建渲染区域
                renderArea = document.createElement('div');
                renderArea.className = 'url-render-area';
                renderArea.style.cssText = `
                    min-height: 120px;
                    background: #1a1a1a;
                    border: 1px solid #333;
                    border-radius: 6px;
                    margin: 8px 0;
                    padding: 8px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    overflow: hidden;
                `;
                
                // 插入到节点内容区域
                const nodeContent = nodeElement.querySelector('.node-content') || nodeElement;
                const nodeHeader = nodeElement.querySelector('.node-header');
                if (nodeHeader && nodeHeader.nextSibling) {
                    nodeContent.insertBefore(renderArea, nodeHeader.nextSibling);
                } else {
                    nodeContent.appendChild(renderArea);
                }
            }

            // 清空现有内容
            renderArea.innerHTML = '';

            // 添加加载指示器
            const loadingIndicator = document.createElement('div');
            loadingIndicator.style.cssText = `
                color: #888;
                font-size: 12px;
                display: flex;
                align-items: center;
                gap: 8px;
            `;
            loadingIndicator.innerHTML = `
                <div style="
                    width: 16px;
                    height: 16px;
                    border: 2px solid #333;
                    border-top: 2px solid #666;
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                "></div>
                正在加载...
            `;
            renderArea.appendChild(loadingIndicator);

            // 创建渲染内容
            setTimeout(() => {
                try {
                    const content = this.createUrlContent(url, type, config);
                    renderArea.innerHTML = '';
                    renderArea.appendChild(content);
                } catch (error) {
                    this.showRenderError(renderArea, error.message);
                }
            }, 500);
        }

        // 创建URL内容元素
        createUrlContent(url, type, config) {
            const container = document.createElement('div');
            container.style.cssText = `
                width: 100%;
                height: 100%;
                display: flex;
                align-items: center;
                justify-content: center;
            `;

            let element;

            switch (type) {
                case 'image':
                    element = document.createElement('img');
                    element.src = url;
                    element.style.cssText = `
                        max-width: ${config.width}px;
                        max-height: ${config.height}px;
                        object-fit: contain;
                        border-radius: 4px;
                    `;
                    element.onerror = () => this.showRenderError(container, '图片加载失败');
                    break;

                case 'video':
                    element = document.createElement('video');
                    element.src = url;
                    element.controls = config.showControls;
                    element.style.cssText = `
                        max-width: ${config.width}px;
                        max-height: ${config.height}px;
                        border-radius: 4px;
                    `;
                    if (config.allowFullscreen) {
                        element.setAttribute('allowfullscreen', '');
                    }
                    element.onerror = () => this.showRenderError(container, '视频加载失败');
                    break;

                case 'audio':
                    element = document.createElement('audio');
                    element.src = url;
                    element.controls = config.showControls;
                    element.style.cssText = `
                        width: 100%;
                        max-width: ${config.width}px;
                    `;
                    element.onerror = () => this.showRenderError(container, '音频加载失败');
                    break;

                case 'iframe':
                    element = document.createElement('iframe');
                    element.src = url;
                    element.style.cssText = `
                        width: ${config.width}px;
                        height: ${config.height}px;
                        border: none;
                        border-radius: 4px;
                    `;
                    if (config.allowFullscreen) {
                        element.setAttribute('allowfullscreen', '');
                    }
                    element.onerror = () => this.showRenderError(container, '页面加载失败');
                    break;

                case 'text':
                    element = document.createElement('div');
                    element.style.cssText = `
                        width: ${config.width}px;
                        height: ${config.height}px;
                        overflow: auto;
                        background: #2a2a2a;
                        color: #fff;
                        padding: 12px;
                        border-radius: 4px;
                        font-family: monospace;
                        font-size: 12px;
                        line-height: 1.4;
                    `;
                    
                    // 异步加载文本内容
                    fetch(url)
                        .then(response => response.text())
                        .then(text => {
                            element.textContent = text;
                        })
                        .catch(error => {
                            this.showRenderError(container, '文本加载失败');
                        });
                    break;

                default:
                    element = document.createElement('div');
                    element.style.cssText = `
                        color: #888;
                        text-align: center;
                        padding: 20px;
                    `;
                    element.textContent = '不支持的URL类型';
            }

            container.appendChild(element);
            return container;
        }

        // 显示渲染错误
        showRenderError(container, message) {
            container.innerHTML = `
                <div style="
                    color: #ff6b6b;
                    text-align: center;
                    padding: 20px;
                    font-size: 12px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 8px;
                ">
                    <svg width="24" height="24" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>
                    </svg>
                    ${message}
                </div>
            `;
        }

        // 辅助方法：延时
        delay(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        // 辅助方法：格式化代码
        formatCode(code, language) {
            // 简单的代码格式化实现
            switch (language) {
                case 'json':
                    try {
                        return JSON.stringify(JSON.parse(code), null, 2);
                    } catch {
                        return code;
                    }
                case 'javascript':
                    // 简单的JavaScript格式化
                    return code.replace(/;/g, ';\n').replace(/{/g, '{\n').replace(/}/g, '\n}');
                default:
                    return code;
            }
        }

        // 辅助方法：压缩代码
        minifyCode(code, language) {
            // 简单的代码压缩实现
            switch (language) {
                case 'json':
                    try {
                        return JSON.stringify(JSON.parse(code));
                    } catch {
                        return code;
                    }
                case 'javascript':
                    // 简单的JavaScript压缩
                    return code.replace(/\s+/g, ' ').replace(/;\s/g, ';').trim();
                default:
                    return code.replace(/\s+/g, ' ').trim();
            }
        }

        // 辅助方法：验证代码
        validateCode(code, language) {
            try {
                switch (language) {
                    case 'json':
                        JSON.parse(code);
                        return { valid: true, message: 'Valid JSON' };
                    case 'javascript':
                        new Function(code);
                        return { valid: true, message: 'Valid JavaScript' };
                    default:
                        return { valid: true, message: 'Syntax check not available' };
                }
            } catch (error) {
                return { valid: false, message: error.message };
            }
        }

        // 验证节点配置
        validateNodeConfig(nodeType, config) {
            const nodeTypeDef = this.getNodeType(nodeType);
            if (!nodeTypeDef) {
                return { valid: false, errors: [`Unknown node type: ${nodeType}`] };
            }

            const errors = [];
            const schema = nodeTypeDef.configSchema || {};

            // 检查必需字段
            Object.entries(schema).forEach(([key, fieldDef]) => {
                if (fieldDef.required && (config[key] === undefined || config[key] === '')) {
                    errors.push(`Field '${key}' is required`);
                }

                // 类型检查
                if (config[key] !== undefined) {
                    const value = config[key];
                    switch (fieldDef.type) {
                        case 'number':
                            if (isNaN(Number(value))) {
                                errors.push(`Field '${key}' must be a number`);
                            }
                            break;
                        case 'enum':
                            if (!fieldDef.options.includes(value)) {
                                errors.push(`Field '${key}' must be one of: ${fieldDef.options.join(', ')}`);
                            }
                            break;
                    }
                }
            });

            return { valid: errors.length === 0, errors };
        }

        // 获取节点配置模板
        getNodeConfigTemplate(nodeType) {
            const nodeTypeDef = this.getNodeType(nodeType);
            if (!nodeTypeDef) {
                return {};
            }

            const template = {};
            const schema = nodeTypeDef.configSchema || {};

            Object.entries(schema).forEach(([key, fieldDef]) => {
                template[key] = fieldDef.default !== undefined ? fieldDef.default : '';
            });

            return template;
        }

        // 动态输入端点管理
        updateNodeInputsForCommand(nodeId, command, pluginKey) {
            console.log('[NodeManager] updateNodeInputsForCommand called:', { nodeId, command, pluginKey });
            
            const node = this.stateManager.getNode(nodeId);
            console.log('[NodeManager] Found node:', node);
            
            if (!node || (node.type !== 'VCPToolBox' && node.type !== 'vcpChat')) {
                console.warn('[NodeManager] Invalid node or type:', node?.type);
                return;
            }

            // 获取插件管理器实例
            const pluginManager = window.WorkflowEditor_PluginManager;
            if (!pluginManager) {
                console.error('[NodeManager] PluginManager not found');
                return;
            }

            // 获取插件信息
            const plugin = pluginManager.getPlugin(pluginKey);
            console.log('[NodeManager] Found plugin:', plugin);
            if (!plugin) {
                console.error('[NodeManager] Plugin not found:', pluginKey);
                return;
            }

            // 获取指令的参数信息
            const commandInfo = pluginManager.getCommandInfo(pluginKey, command);
            console.log('[NodeManager] Found commandInfo:', commandInfo);
            if (!commandInfo) {
                console.error('[NodeManager] CommandInfo not found:', { pluginKey, command });
                return;
            }

            // 获取动态输入端点
            const dynamicInputs = this.getDynamicInputsForCommand(commandInfo);
            console.log('[NodeManager] Generated dynamicInputs:', dynamicInputs);
            
            // 更新节点配置
            node.command = command;
            node.dynamicInputs = dynamicInputs;

            // 通知画布管理器更新节点输入端点
            // 通知画布管理器更新节点输入端点
            let canvasManager = null;
            
            // 尝试多种方式获取 CanvasManager
            if (window.WorkflowEditor_CanvasManager) {
                canvasManager = window.WorkflowEditor_CanvasManager;
                console.log('[NodeManager] Found CanvasManager via global variable');
            } else if (this.stateManager && this.stateManager.canvasManager) {
                canvasManager = this.stateManager.canvasManager;
                console.log('[NodeManager] Found CanvasManager via StateManager');
            }
            
            if (canvasManager) {
                console.log('[NodeManager] CanvasManager found, checking methods...');
                console.log('[NodeManager] updateNodeInputs method type:', typeof canvasManager.updateNodeInputs);
                
                if (typeof canvasManager.updateNodeInputs === 'function') {
                    console.log('[NodeManager] Calling canvasManager.updateNodeInputs');
                    canvasManager.updateNodeInputs(nodeId, dynamicInputs);
                } else if (typeof canvasManager.rerenderNode === 'function') {
                    console.log('[NodeManager] Using canvasManager.rerenderNode instead');
                    // 先更新节点数据
                    this.stateManager.updateNode(nodeId, { dynamicInputs });
                    // 然后重新渲染节点
                    canvasManager.rerenderNode(nodeId);
                } else {
                    console.log('[NodeManager] No suitable method found, updating node directly');
                    // 直接更新节点的 dynamicInputs 属性
                    this.stateManager.updateNode(nodeId, { dynamicInputs });
                    
                    // 尝试触发画布重新渲染
                    if (this.stateManager.emit) {
                        this.stateManager.emit('nodeNeedsRerender', { nodeId, dynamicInputs });
                    }
                    
                    // 尝试直接调用画布渲染方法
                    if (canvasManager.renderNodes) {
                        console.log('[NodeManager] Triggering full canvas rerender');
                        canvasManager.renderNodes();
                    }
                }
            } else {
                console.log('[NodeManager] CanvasManager not found, updating node directly');
                // 直接更新节点的 dynamicInputs 属性
                this.stateManager.updateNode(nodeId, { dynamicInputs });
                
                // 触发画布重新渲染该节点
                if (this.stateManager.emit) {
                    this.stateManager.emit('nodeNeedsRerender', { nodeId, dynamicInputs });
                }
            }
            
            console.log('[NodeManager] Updated node inputs for command:', { nodeId, command, dynamicInputs });
        }

        getDynamicInputsForCommand(commandInfo) {
            const inputs = [];
            
            if (commandInfo && commandInfo.parameters) {
                Object.entries(commandInfo.parameters).forEach(([paramName, paramInfo]) => {
                    // 跳过 tool_name 和 command 参数，这些不需要输入端点
                    if (paramName.toLowerCase() === 'tool_name' || paramName.toLowerCase() === 'command') {
                        return;
                    }
                    
                    inputs.push({
                        name: paramName,
                        label: paramInfo.description || paramName,
                        type: paramInfo.type || 'string',
                        required: paramInfo.required || false,
                        defaultValue: paramInfo.defaultValue
                    });
                });
            }

            console.log('Generated dynamic inputs:', inputs);
            return inputs;
        }

        findPluginKey(pluginName) {
            // 在插件管理器中查找插件键值
            const pluginManager = window.WorkflowEditor_PluginManager;
            if (!pluginManager) return null;

            const plugins = pluginManager.getPlugins();
            for (const [key, plugin] of Object.entries(plugins)) {
                if (plugin.name === pluginName || plugin.manifest?.name === pluginName) {
                    return key;
                }
            }
            return null;
        }

        // 更新辅助节点的输入端点 - 辅助节点不需要动态输入端点
        updateNodeInputsForAuxiliary(nodeId, auxiliaryType) {
            console.log('[NodeManager] updateNodeInputsForAuxiliary called - 辅助节点不需要动态输入端点:', { nodeId, auxiliaryType });
            
            // 辅助节点不需要动态输入端点功能，直接返回
            // 这个功能只针对插件节点
            return;
        }

        // 为辅助节点生成动态输入端点 - 已移除，辅助节点不需要动态输入端点功能
        getDynamicInputsForAuxiliary(nodeTypeDef) {
            // 辅助节点不需要动态输入端点功能，直接返回空数组
            return [];
        }

        // 执行图片上传节点
        async executeImageUploadNode(node, inputData = {}) {
            console.log('[NodeManager] 执行图片上传节点:', node.id);
            
            const config = node.config || {};
            const {
                outputParamName = 'imageBase64',
                maxFileSize = 10,
                acceptedFormats = ['jpg', 'jpeg', 'png', 'gif', 'webp'],
                compressionQuality = 0.8,
                maxWidth = 1920,
                maxHeight = 1080
            } = config;

            // 检查节点是否已经有上传的图片数据
            if (node.uploadedImageData) {
                console.log('[NodeManager] 使用已上传的图片数据');
                
                const result = {
                    [outputParamName]: node.uploadedImageData,
                    fileName: node.uploadedFileName || 'uploaded_image',
                    fileSize: node.uploadedFileSize || 0,
                    timestamp: new Date().toISOString(),
                    success: true
                };

                console.log('[NodeManager] 图片上传节点执行完成:', result);
                return result;
            } else {
                // 如果没有上传的图片，返回等待上传的状态
                console.log('[NodeManager] 等待用户上传图片');
                
                const result = {
                    [outputParamName]: null,
                    message: '请上传图片文件',
                    success: false,
                    waiting: true,
                    timestamp: new Date().toISOString()
                };

                return result;
            }
        }

        // 处理图片上传（由UI调用）
        async handleImageUpload(nodeId, file) {
            console.log('[NodeManager] 处理图片上传:', { nodeId, fileName: file.name, fileSize: file.size });
            
            const node = this.stateManager.getNode(nodeId);
            if (!node) {
                throw new Error(`节点 ${nodeId} 不存在`);
            }

            const config = node.config || {};
            const {
                maxFileSize = 10,
                acceptedFormats = ['jpg', 'jpeg', 'png', 'gif', 'webp'],
                compressionQuality = 0.8,
                maxWidth = 1920,
                maxHeight = 1080
            } = config;

            // 验证文件类型
            const fileExtension = file.name.split('.').pop().toLowerCase();
            if (!acceptedFormats.includes(fileExtension)) {
                throw new Error(`不支持的文件格式: ${fileExtension}。支持的格式: ${acceptedFormats.join(', ')}`);
            }

            // 验证文件大小
            const fileSizeMB = file.size / (1024 * 1024);
            if (fileSizeMB > maxFileSize) {
                throw new Error(`文件大小超过限制: ${fileSizeMB.toFixed(2)}MB > ${maxFileSize}MB`);
            }

            try {
                // 读取文件并转换为base64
                const imageData = await this.processImageFile(file, {
                    compressionQuality,
                    maxWidth,
                    maxHeight
                });

                // 保存到节点数据中
                this.stateManager.updateNode(nodeId, {
                    uploadedImageData: imageData,
                    uploadedFileName: file.name,
                    uploadedFileSize: file.size,
                    uploadedTimestamp: new Date().toISOString()
                });

                console.log('[NodeManager] 图片上传处理完成');
                return {
                    success: true,
                    fileName: file.name,
                    fileSize: file.size,
                    dataUrl: imageData
                };

            } catch (error) {
                console.error('[NodeManager] 图片处理失败:', error);
                throw new Error(`图片处理失败: ${error.message}`);
            }
        }

        // 处理图片文件（压缩和转换）
        async processImageFile(file, options = {}) {
            const {
                compressionQuality = 0.8,
                maxWidth = 1920,
                maxHeight = 1080
            } = options;

            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                
                reader.onload = (e) => {
                    const img = new Image();
                    
                    img.onload = () => {
                        try {
                            // 创建canvas进行图片处理
                            const canvas = document.createElement('canvas');
                            const ctx = canvas.getContext('2d');

                            // 计算新的尺寸（保持宽高比）
                            let { width, height } = this.calculateNewDimensions(
                                img.width, 
                                img.height, 
                                maxWidth, 
                                maxHeight
                            );

                            canvas.width = width;
                            canvas.height = height;

                            // 绘制图片
                            ctx.drawImage(img, 0, 0, width, height);

                            // 转换为base64
                            const dataUrl = canvas.toDataURL('image/jpeg', compressionQuality);
                            resolve(dataUrl);

                        } catch (error) {
                            reject(error);
                        }
                    };

                    img.onerror = () => {
                        reject(new Error('图片加载失败'));
                    };

                    img.src = e.target.result;
                };

                reader.onerror = () => {
                    reject(new Error('文件读取失败'));
                };

                reader.readAsDataURL(file);
            });
        }

        // 计算新的图片尺寸（保持宽高比）
        calculateNewDimensions(originalWidth, originalHeight, maxWidth, maxHeight) {
            let width = originalWidth;
            let height = originalHeight;

            // 如果图片尺寸超过限制，按比例缩放
            if (width > maxWidth || height > maxHeight) {
                const widthRatio = maxWidth / width;
                const heightRatio = maxHeight / height;
                const ratio = Math.min(widthRatio, heightRatio);

                width = Math.round(width * ratio);
                height = Math.round(height * ratio);
            }

            return { width, height };
        }
    }

    // 导出为全局单例
    window.WorkflowEditor_NodeManager = WorkflowEditor_NodeManager.getInstance();
})();