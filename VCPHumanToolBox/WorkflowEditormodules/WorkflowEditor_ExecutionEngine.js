// WorkflowEditor Execution Engine
(function() {
    'use strict';

    class WorkflowEditor_ExecutionEngine {
        constructor() {
            if (WorkflowEditor_ExecutionEngine.instance) {
                return WorkflowEditor_ExecutionEngine.instance;
            }
            
            this.stateManager = null;
            this.pluginManager = null;
            this.connectionManager = null; // 连接管理器
            this.isExecuting = false;
            this.executionQueue = [];
            this.nodeResults = new Map(); // 存储节点执行结果
            this.nodeInputData = new Map(); // 存储节点输入数据
            
            // 从 settings.json 读取配置
            this.loadSettings();
            
            WorkflowEditor_ExecutionEngine.instance = this;
        }

        static getInstance() {
            if (!WorkflowEditor_ExecutionEngine.instance) {
                WorkflowEditor_ExecutionEngine.instance = new WorkflowEditor_ExecutionEngine();
            }
            return WorkflowEditor_ExecutionEngine.instance;
        }

        // 初始化执行引擎
        init(stateManager, pluginManager) {
            this.stateManager = stateManager;
            this.pluginManager = pluginManager;
            
            console.log('[ExecutionEngine] Initialized');
        }

        // 从 settings.json 加载配置
        loadSettings() {
            try {
                const fs = require('fs');
                const path = require('path');
                const settingsPath = path.join(__dirname, '..', 'AppData', 'settings.json');
                const settingsData = fs.readFileSync(settingsPath, 'utf8');
                const settings = JSON.parse(settingsData);
                
                if (settings.vcpServerUrl) {
                    const url = new URL(settings.vcpServerUrl);
                    url.pathname = '/v1/human/tool';
                    this.VCP_SERVER_URL = url.toString();
                }
                this.VCP_API_KEY = settings.vcpApiKey || '';
                this.USER_NAME = settings.userName || 'Human';
                
                console.log('[ExecutionEngine] Settings loaded');
            } catch (error) {
                console.error('[ExecutionEngine] Failed to load settings:', error);
            }
        }

        // 开始执行工作流
        async executeWorkflow() {
            if (this.isExecuting) {
                console.warn('[ExecutionEngine] Workflow is already executing');
                return;
            }

            if (!this.VCP_SERVER_URL || !this.VCP_API_KEY) {
                throw new Error('VCP服务器配置未找到，请检查settings.json');
            }

            this.isExecuting = true;
            this.nodeResults.clear();
            this.nodeInputData.clear();
            
            try {
                console.log('[ExecutionEngine] Starting workflow execution');
                
                // 获取所有节点和连接
                const nodes = this.stateManager.getAllNodes();
                
                // 优先使用 ConnectionManager 获取连接
                let connections;
                if (this.connectionManager) {
                    connections = this.connectionManager.getAllConnections();
                    console.log('[ExecutionEngine] 使用 ConnectionManager 获取连接:', connections.length);
                } else {
                    connections = this.stateManager.getAllConnections();
                    console.log('[ExecutionEngine] 回退到 StateManager 获取连接:', connections.length);
                }
                
                // 构建执行图
                const executionGraph = this.buildExecutionGraph(nodes, connections);
                
                // 找到起始节点（没有输入连接的节点）
                const startNodes = this.findStartNodes(nodes, connections);
                
                if (startNodes.length === 0) {
                    throw new Error('未找到起始节点，请确保工作流有至少一个没有输入连接的节点');
                }
                
                // 初始化节点输入数据
                this.initializeNodeInputData(nodes);
                
                // 从起始节点开始执行
                for (const startNode of startNodes) {
                    await this.executeNodeChain(startNode, executionGraph);
                }
                
                console.log('[ExecutionEngine] Workflow execution completed');
                
            } catch (error) {
                console.error('[ExecutionEngine] Workflow execution failed:', error);
                throw error;
            } finally {
                this.isExecuting = false;
            }
        }

        // 构建执行图
        buildExecutionGraph(nodes, connections) {
            console.log(`[ExecutionEngine] 构建执行图 - 节点数: ${nodes.length}, 连接数: ${connections.length}`);
            
            // 打印所有连接信息
            connections.forEach((connection, index) => {
                console.log(`[ExecutionEngine] 连接 ${index + 1}: ${connection.sourceNodeId} -> ${connection.targetNodeId}`);
                console.log(`[ExecutionEngine] 连接详情:`, connection);
            });
            
            const graph = new Map();
            
            // 初始化图节点
            nodes.forEach(node => {
                graph.set(node.id, {
                    node: node,
                    inputs: [], // 输入连接
                    outputs: [] // 输出连接
                });
            });
            
            // 添加连接关系
            connections.forEach(connection => {
                const sourceGraphNode = graph.get(connection.sourceNodeId);
                const targetGraphNode = graph.get(connection.targetNodeId);
                
                console.log(`[ExecutionEngine] 处理连接: ${connection.sourceNodeId} -> ${connection.targetNodeId}`);
                console.log(`[ExecutionEngine] 源节点存在: ${!!sourceGraphNode}, 目标节点存在: ${!!targetGraphNode}`);
                
                if (sourceGraphNode && targetGraphNode) {
                    sourceGraphNode.outputs.push({
                        targetNodeId: connection.targetNodeId,
                        targetPort: connection.targetPort,
                        connection: connection
                    });
                    
                    targetGraphNode.inputs.push({
                        sourceNodeId: connection.sourceNodeId,
                        sourcePort: connection.sourcePort,
                        targetPort: connection.targetPort,
                        connection: connection
                    });
                    
                    console.log(`[ExecutionEngine] ✓ 连接已添加到执行图`);
                } else {
                    console.warn(`[ExecutionEngine] ✗ 连接无效，跳过: ${connection.sourceNodeId} -> ${connection.targetNodeId}`);
                }
            });
            
            // 打印最终的执行图结构
            graph.forEach((graphNode, nodeId) => {
                console.log(`[ExecutionEngine] 节点 ${nodeId}: ${graphNode.inputs.length} 个输入, ${graphNode.outputs.length} 个输出`);
            });
            
            return graph;
        }

        // 找到起始节点
        findStartNodes(nodes, connections) {
            const nodesWithInputs = new Set();
            connections.forEach(conn => {
                nodesWithInputs.add(conn.targetNodeId);
            });
            
            return nodes.filter(node => !nodesWithInputs.has(node.id));
        }

        // 初始化节点输入数据
        initializeNodeInputData(nodes) {
            nodes.forEach(node => {
                const inputData = {};
                
                // 如果节点有动态输入参数，初始化这些参数
                if (node.dynamicInputs && Array.isArray(node.dynamicInputs)) {
                    node.dynamicInputs.forEach(input => {
                        inputData[input.name] = null;
                    });
                }
                
                this.nodeInputData.set(node.id, inputData);
            });
        }

        // 执行节点链 - 使用拓扑排序避免循环依赖问题
        async executeNodeChain(startNode, executionGraph) {
            console.log(`[ExecutionEngine] 开始执行节点链，起始节点: ${startNode.id}`);
            console.log(`[ExecutionEngine] 执行图包含 ${executionGraph.size} 个节点`);
            
            // 打印执行图的连接信息
            executionGraph.forEach((graphNode, nodeId) => {
                console.log(`[ExecutionEngine] 节点 ${nodeId}: ${graphNode.inputs.length} 个输入, ${graphNode.outputs.length} 个输出`);
                graphNode.inputs.forEach((input, i) => {
                    console.log(`[ExecutionEngine]   输入 ${i + 1}: 来自节点 ${input.sourceNodeId}`);
                });
                graphNode.outputs.forEach((output, i) => {
                    console.log(`[ExecutionEngine]   输出 ${i + 1}: 到节点 ${output.targetNodeId}`);
                });
            });
            
            // 使用队列进行广度优先执行
            const executionQueue = [startNode.id];
            const executed = new Set();
            const executing = new Set();
            let maxIterations = executionGraph.size * 3; // 防止无限循环
            let iterations = 0;
            
            while (executionQueue.length > 0 && iterations < maxIterations) {
                iterations++;
                const nodeId = executionQueue.shift();
                
                console.log(`[ExecutionEngine] 处理队列中的节点: ${nodeId} (迭代 ${iterations})`);
                
                // 跳过已执行的节点
                if (executed.has(nodeId)) {
                    console.log(`[ExecutionEngine] 节点 ${nodeId} 已执行，跳过`);
                    continue;
                }
                
                // 检查循环依赖
                if (executing.has(nodeId)) {
                    console.warn(`[ExecutionEngine] 跳过正在执行的节点: ${nodeId}`);
                    continue;
                }
                
                const graphNode = executionGraph.get(nodeId);
                if (!graphNode) {
                    console.error(`[ExecutionEngine] 节点 ${nodeId} 不存在于执行图中`);
                    continue;
                }
                
                // 检查所有输入节点是否已执行
                const allInputsReady = graphNode.inputs.length === 0 || 
                    graphNode.inputs.every(input => {
                        const ready = executed.has(input.sourceNodeId);
                        console.log(`[ExecutionEngine] 检查输入节点 ${input.sourceNodeId}: ${ready ? '已执行' : '未执行'}`);
                        return ready;
                    });
                
                console.log(`[ExecutionEngine] 节点 ${nodeId} 所有输入是否就绪: ${allInputsReady}`);
                
                if (!allInputsReady) {
                    // 将节点重新加入队列末尾，等待输入节点执行完成
                    console.log(`[ExecutionEngine] 节点 ${nodeId} 输入未就绪，重新加入队列`);
                    executionQueue.push(nodeId);
                    continue;
                }
                
                // 收集输入数据
                this.collectInputData(nodeId, graphNode);
                
                // 检查是否所有必需参数都已准备好
                if (this.areRequiredInputsReady(nodeId, graphNode.node)) {
                    executing.add(nodeId);
                    
                    try {
                        console.log(`[ExecutionEngine] 开始执行节点: ${nodeId}`);
                        
                        // 执行节点
                        await this.executeNode(graphNode.node);
                        
                        console.log(`[ExecutionEngine] 节点 ${nodeId} 执行成功，开始传播数据`);
                        
                        // 传播输出数据到下游节点
                        this.propagateOutputData(nodeId, graphNode);
                        
                        // 将下游节点加入执行队列
                        graphNode.outputs.forEach(output => {
                            if (!executed.has(output.targetNodeId) && !executionQueue.includes(output.targetNodeId)) {
                                console.log(`[ExecutionEngine] 将下游节点加入队列: ${output.targetNodeId}`);
                                executionQueue.push(output.targetNodeId);
                            } else {
                                console.log(`[ExecutionEngine] 下游节点 ${output.targetNodeId} 已在队列中或已执行`);
                            }
                        });
                        
                        executed.add(nodeId);
                        console.log(`[ExecutionEngine] 节点 ${nodeId} 执行完成`);
                        
                    } catch (error) {
                        console.error(`[ExecutionEngine] 节点 ${nodeId} 执行失败:`, error);
                        throw error;
                    } finally {
                        executing.delete(nodeId);
                    }
                } else {
                    console.log(`[ExecutionEngine] 节点 ${nodeId} 必需输入未准备好，标记为已处理`);
                    executed.add(nodeId); // 标记为已处理，避免无限循环
                }
            }
            
            if (iterations >= maxIterations) {
                console.warn(`[ExecutionEngine] 达到最大迭代次数 ${maxIterations}，可能存在循环依赖`);
            }
            
            console.log(`[ExecutionEngine] 节点链执行完成，已执行节点:`, Array.from(executed));
        }

        // 收集输入数据
        collectInputData(nodeId, graphNode) {
            const inputData = this.nodeInputData.get(nodeId) || {};
            
            console.log(`[ExecutionEngine] 开始收集节点 ${nodeId} 的输入数据`);
            console.log(`[ExecutionEngine] 节点有 ${graphNode.inputs.length} 个输入连接`);
            
            graphNode.inputs.forEach(input => {
                const sourceResult = this.nodeResults.get(input.sourceNodeId);
                console.log(`[ExecutionEngine] 检查源节点 ${input.sourceNodeId} 的结果:`, sourceResult);
                
                if (sourceResult) {
                    // 解析JSON数据并支持字段访问
                    const processedData = this.processInputData(sourceResult);
                    
                    // 确保目标参数名有效，避免undefined键
                    const targetParam = input.targetPort || input.connection?.targetParam || 'input';
                    
                    console.log(`[ExecutionEngine] 收集输入数据: ${input.sourceNodeId} -> ${nodeId}, 参数: ${targetParam}`);
                    console.log(`[ExecutionEngine] 处理后的数据:`, processedData);
                    
                    // 只有当目标参数名有效时才设置数据
                    if (targetParam && targetParam !== 'undefined') {
                        inputData[targetParam] = processedData;
                        console.log(`[ExecutionEngine] 成功设置输入参数 ${targetParam}`);
                    } else {
                        console.warn(`[ExecutionEngine] 跳过无效的目标参数名: ${targetParam}`);
                    }
                } else {
                    console.warn(`[ExecutionEngine] 源节点 ${input.sourceNodeId} 没有结果数据`);
                }
            });
            
            console.log(`[ExecutionEngine] 收集完成，节点 ${nodeId} 的最终输入数据:`, inputData);
            this.nodeInputData.set(nodeId, inputData);
        }

        // 检查必需输入是否准备好
        areRequiredInputsReady(nodeId, node) {
            const inputData = this.nodeInputData.get(nodeId) || {};
            const nodeConfig = node.config || {};
            
            console.log(`[ExecutionEngine] 检查节点 ${nodeId} 的输入准备状态:`);
            console.log(`[ExecutionEngine] - 输入数据:`, inputData);
            console.log(`[ExecutionEngine] - 节点配置:`, nodeConfig);
            console.log(`[ExecutionEngine] - 动态输入:`, node.dynamicInputs);
            
            // 如果没有动态输入参数，检查节点配置是否有必需的参数
            if (!node.dynamicInputs || !Array.isArray(node.dynamicInputs)) {
                console.log(`[ExecutionEngine] 节点 ${nodeId} 没有动态输入，检查配置参数`);
                
                // 对于文件操作节点，检查基本配置
                if (node.pluginId === 'FileOperator') {
                    // 如果配置中有url或从输入数据中获取到url，则认为准备就绪
                    const hasUrl = nodeConfig.url || inputData.url;
                    const hasDownloadDir = nodeConfig.downloadDir || inputData.downloadDir;
                    
                    console.log(`[ExecutionEngine] FileOperator 节点检查: url=${hasUrl}, downloadDir=${hasDownloadDir}`);
                    
                    if (!hasUrl && !hasDownloadDir) {
                        console.log(`[ExecutionEngine] FileOperator 节点缺少必要参数`);
                        return false;
                    }
                }
                
                return true;
            }
            
            // 检查所有必需参数是否都有数据
            for (const input of node.dynamicInputs) {
                const hasInputData = inputData[input.name] !== null && inputData[input.name] !== undefined && inputData[input.name] !== '';
                const hasConfigData = nodeConfig[input.name] !== null && nodeConfig[input.name] !== undefined && nodeConfig[input.name] !== '';
                
                console.log(`[ExecutionEngine] 检查参数 ${input.name}: required=${input.required}, hasInputData=${hasInputData}, hasConfigData=${hasConfigData}`);
                
                if (input.required && !hasInputData && !hasConfigData) {
                    console.log(`[ExecutionEngine] Node ${nodeId} waiting for required input: ${input.name}`);
                    return false;
                }
            }
            
            console.log(`[ExecutionEngine] 节点 ${nodeId} 所有必需输入已准备就绪`);
            return true;
        }

        // 执行单个节点
        async executeNode(node) {
            console.log(`[ExecutionEngine] Executing node: ${node.id} (${node.name})`);
            
            // 更新节点状态为执行中
            this.updateNodeStatus(node.id, 'running');
            
            try {
                let result;
                
                if (node.category === 'auxiliary') {
                    // 辅助节点的处理
                    result = await this.executeAuxiliaryNode(node);
                } else {
                    // 插件节点的处理
                    result = await this.executePluginNode(node);
                }
                
                // 存储执行结果
                this.nodeResults.set(node.id, result);
                
                // 更新节点状态为成功
                this.updateNodeStatus(node.id, 'success');
                
                console.log(`[ExecutionEngine] Node ${node.id} executed successfully`);
                
            } catch (error) {
                console.error(`[ExecutionEngine] Node ${node.id} execution failed:`, error);
                
                // 更新节点状态为失败
                this.updateNodeStatus(node.id, 'error');
                
                throw error;
            }
        }

        // 执行辅助节点
        async executeAuxiliaryNode(node) {
            const inputData = this.nodeInputData.get(node.id) || {};
            
            switch (node.pluginId) {
                case 'textDisplay':
                    return this.executeTextDisplayNode(node, inputData);
                case 'imageDisplay':
                    return this.executeImageDisplayNode(node, inputData);
                case 'htmlDisplay':
                    return this.executeHtmlDisplayNode(node, inputData);
                case 'jsonDisplay':
                    return this.executeJsonDisplayNode(node, inputData);
                case 'urlRenderer':
                    return this.executeUrlRendererNode(node, inputData);
                case 'regex':
                    return this.executeRegexNode(node, inputData);
                case 'dataTransform':
                    return this.executeDataTransformNode(node, inputData);
                case 'codeEdit':
                    return this.executeCodeEditNode(node, inputData);
                case 'condition':
                    return this.executeConditionNode(node, inputData);
                case 'loop':
                    return this.executeLoopNode(node, inputData);
                case 'delay':
                    return this.executeDelayNode(node, inputData);
                case 'contentInput': // 新增内容输入器节点类型
                    return this.executeContentInputNode(node);
                case 'urlExtractor': // URL提取器节点类型
                    return this.executeUrlExtractorNode(node, inputData);
                case 'imageUpload': // 图片上传节点类型
                    return this.executeImageUploadNode(node, inputData);
                default:
                    throw new Error(`未知的辅助节点类型: ${node.pluginId}`);
            }
        }

        // 执行内容输入器节点
        async executeContentInputNode(node) {
            console.log(`[ExecutionEngine] 执行内容输入器节点: ${node.id}`);
            const content = node.config && node.config.content !== undefined ? node.config.content : '';
            // 从节点配置中获取自定义输出参数名，如果未设置则默认为 'output'
            const outputParamName = node.config && node.config.outputParamName ? node.config.outputParamName : 'output';
            
            console.log(`[ExecutionEngine] 内容输入器输出内容: ${content} (使用参数名: ${outputParamName})`);
            
            // 使用自定义的参数名作为输出对象的键
            const result = {};
            result[outputParamName] = content;
            return result;
        }

        // 执行插件节点
        async executePluginNode(node) {
            const inputData = this.nodeInputData.get(node.id) || {};
            
            console.log(`[ExecutionEngine] 开始执行插件节点 ${node.id} (${node.name})`);
            console.log(`[ExecutionEngine] 节点配置:`, node.config);
            console.log(`[ExecutionEngine] 输入数据:`, inputData);
            
            // 合并节点配置和输入数据，支持数据引用解析
            const allParams = {};
            
            // 先添加节点配置中的参数，支持数据引用
            if (node.config) {
                for (const [key, value] of Object.entries(node.config)) {
                    const resolvedValue = this._resolveValue(value, inputData);
                    
                    // 特殊处理：如果解析结果是对象，尝试提取 'output' 属性或将其 JSON 字符串化
                    if (typeof resolvedValue === 'object' && resolvedValue !== null) {
                        if (resolvedValue.output !== undefined) {
                            allParams[key] = String(resolvedValue.output); // 提取 output 属性并转为字符串
                            console.log(`[ExecutionEngine] 提取对象参数 ${key} 的 'output' 属性: ${allParams[key]}`);
                        } else {
                            allParams[key] = JSON.stringify(resolvedValue); // 否则，将整个对象 JSON 字符串化
                            console.log(`[ExecutionEngine] JSON 字符串化复杂对象参数 ${key}: ${allParams[key]}`);
                        }
                    } else {
                        allParams[key] = resolvedValue; // 对于非对象类型，直接使用解析后的值
                        console.log(`[ExecutionEngine] 添加参数 ${key}: ${allParams[key]}`);
                    }
                }
            }
            
            // 再添加输入数据中的参数，支持智能字段提取
            Object.entries(inputData).forEach(([key, value]) => {
                // 跳过无效的键名，避免添加undefined参数
                if (!key || key === 'undefined' || key === 'null') {
                    console.warn(`[ExecutionEngine] 跳过无效的参数键: ${key}`);
                    return;
                }
                
                // 仅当 allParams 中没有该键，或者该键的值为 undefined/null/空字符串时，才从 inputData 中添加
                // 这样可以确保 node.config 中的配置（已解析变量）优先
                if (allParams[key] === undefined || allParams[key] === null || allParams[key] === '') {
                    if (value !== null && value !== undefined && value !== '') {
                        // 如果输入数据是对象，尝试提取有用的字段
                        if (typeof value === 'object' && value !== null) {
                            // 智能字段映射：根据参数名称自动提取对应字段
                            if (key === 'url') {
                                // 对于url参数，优先查找imageUrl、url等字段
                                const urlValue = value.imageUrl || value.url || value.downloadUrl || value;
                                allParams[key] = urlValue;
                                console.log(`[ExecutionEngine] 智能提取URL字段 ${key}: ${urlValue}`);
                            } else if (key === 'downloadDir' && value.downloadDir) {
                                allParams[key] = value.downloadDir;
                                console.log(`[ExecutionEngine] 提取downloadDir字段: ${value.downloadDir}`);
                            } else if (value.output !== undefined) { // 增加对 {output: ...} 格式的支持
                                allParams[key] = String(value.output);
                                console.log(`[ExecutionEngine] 提取输入数据对象 ${key} 的 'output' 属性: ${allParams[key]}`);
                            }
                            else {
                                // 对于其他复杂对象，不再直接跳过，而是尝试 JSON 字符串化
                                allParams[key] = JSON.stringify(value);
                                console.log(`[ExecutionEngine] JSON 字符串化输入数据复杂对象 ${key}: ${allParams[key]}`);
                            }
                        } else {
                            // 简单类型的值直接添加
                            allParams[key] = value;
                            console.log(`[ExecutionEngine] 添加简单参数 ${key}: ${value}`);
                        }
                    }
                } else {
                    console.log(`[ExecutionEngine] 参数 ${key} 已在节点配置中处理，跳过输入数据`);
                }
            });
            
            console.log(`[ExecutionEngine] 合并后的参数:`, allParams);
            
            // 构建请求体，参考 renderer.js 的格式
            let requestBody = `<<<[TOOL_REQUEST]>>>\n`;
            const requestParams = [];
            
            // 添加基础参数
            requestParams.push(`maid:「始」${this.USER_NAME}「末」`);
            requestParams.push(`tool_name:「始」${node.pluginId}「末」`);
            
            // 智能命令匹配：根据节点配置和插件信息选择正确的命令
            let needsCommand = false;
            let commandToUse = null;
            
            if (this.pluginManager) {
                const pluginKey = `${node.category}_${node.pluginId}`;
                const pluginInfo = this.pluginManager.getPluginInfo(pluginKey);
                
                if (pluginInfo && pluginInfo.commands && pluginInfo.commands.length > 0) {
                    console.log(`[ExecutionEngine] 插件 ${node.pluginId} 找到 ${pluginInfo.commands.length} 个命令`);
                    
                    // 优先使用节点配置中的命令ID或名称
                    const nodeCommandId = node.config && node.config.command;
                    const nodeSelectedCommand = node.selectedCommand;
                    const nodeCommandIdFromNode = node.commandId;
                    
                    console.log(`[ExecutionEngine] 节点命令配置: commandId=${nodeCommandId}, selectedCommand=${nodeSelectedCommand}, commandIdFromNode=${nodeCommandIdFromNode}`);
                    
                    // 智能匹配命令
                    let matchedCommand = null;
                    
                    // 1. 首先尝试通过命令ID精确匹配
                    if (nodeCommandId || nodeSelectedCommand || nodeCommandIdFromNode) {
                        const targetCommandId = nodeCommandId || nodeSelectedCommand || nodeCommandIdFromNode;
                        
                        matchedCommand = pluginInfo.commands.find(cmd => 
                            cmd.id === targetCommandId || 
                            cmd.name === targetCommandId ||
                            cmd.command === targetCommandId
                        );
                        
                        if (matchedCommand) {
                            console.log(`[ExecutionEngine] 通过命令ID匹配到命令: ${matchedCommand.name || matchedCommand.id}`);
                        }
                    }
                    
                    // 2. 如果没有匹配到，尝试通过参数匹配
                    if (!matchedCommand) {
                        console.log(`[ExecutionEngine] 尝试通过参数匹配命令`);
                        
                        // 分析节点配置中的参数，找到最匹配的命令
                        const nodeParams = node.config || {};
                        const paramKeys = Object.keys(nodeParams);
                        
                        console.log(`[ExecutionEngine] 节点参数: ${paramKeys.join(', ')}`);
                        
                        // 为每个命令计算匹配度
                        let bestMatch = null;
                        let bestScore = 0;
                        
                        for (const cmd of pluginInfo.commands) {
                            let score = 0;
                            
                            // 检查命令的参数是否与节点参数匹配
                            if (cmd.parameters && Array.isArray(cmd.parameters)) {
                                for (const param of cmd.parameters) {
                                    if (paramKeys.includes(param.name)) {
                                        score += 1;
                                    }
                                }
                            }
                            
                            // 检查命令名称是否与插件ID相关
                            if (cmd.name && cmd.name.toLowerCase().includes(node.pluginId.toLowerCase())) {
                                score += 0.5;
                            }
                            
                            console.log(`[ExecutionEngine] 命令 ${cmd.name || cmd.id} 匹配度: ${score}`);
                            
                            if (score > bestScore) {
                                bestScore = score;
                                bestMatch = cmd;
                            }
                        }
                        
                        if (bestMatch && bestScore > 0) {
                            matchedCommand = bestMatch;
                            console.log(`[ExecutionEngine] 通过参数匹配选择命令: ${bestMatch.name || bestMatch.id} (匹配度: ${bestScore})`);
                        }
                    }
                    
                    // 3. 如果还是没有匹配到，使用第一个命令作为默认
                    if (!matchedCommand) {
                        matchedCommand = pluginInfo.commands[0];
                        console.log(`[ExecutionEngine] 使用默认命令: ${matchedCommand.name || matchedCommand.id}`);
                    }
                    
                    // 设置命令信息
                    needsCommand = matchedCommand.needsCommand || false;
                    
                    if (needsCommand) {
                        // 优先使用匹配到的命令的command，然后使用节点配置
                        commandToUse = matchedCommand.command || 
                                     (node.config && node.config.command) || 
                                     node.selectedCommand || 
                                     node.commandId ||
                                     matchedCommand.name ||
                                     matchedCommand.id;
                    }
                    
                    console.log(`[ExecutionEngine] 最终选择 - 插件 ${node.pluginId} needsCommand: ${needsCommand}, command: ${commandToUse}`);
                } else {
                    console.log(`[ExecutionEngine] 未找到插件 ${pluginKey} 的信息，跳过command参数`);
                }
            }
            
            // 只有需要command参数的插件才添加command参数
            if (needsCommand && commandToUse) {
                requestParams.push(`command:「始」${commandToUse}「末」`);
                console.log(`[ExecutionEngine] 使用指令: ${commandToUse}`);
            } else {
                console.log(`[ExecutionEngine] 节点 ${node.id} (${node.pluginId}) 不需要command参数`);
            }
            
            // 添加所有参数（配置 + 输入数据）
            for (const [key, value] of Object.entries(allParams)) {
                // 确保值不是 null, undefined 或空字符串，除非插件明确需要空值
                if (value !== null && value !== undefined && value !== '') { 
                    const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
                    requestParams.push(`${key}:「始」${valueStr}「末」`);
                    console.log(`[ExecutionEngine] 添加参数 ${key}: ${valueStr}`);
                } else {
                    console.log(`[ExecutionEngine] 参数 ${key} 的值为 ${value}，跳过添加`);
                }
            }
            
            // 构建最终请求体，最后一个参数不加逗号
            for (let i = 0; i < requestParams.length; i++) {
                if (i === requestParams.length - 1) {
                    // 最后一个参数不加逗号
                    requestBody += `${requestParams[i]}\n`;
                } else {
                    // 其他参数加逗号
                    requestBody += `${requestParams[i]},\n`;
                }
            }
            
            requestBody += `<<<[END_TOOL_REQUEST]>>>`;
            
            console.log(`[ExecutionEngine] 完整请求体:`, requestBody);
            console.log(`[ExecutionEngine] 请求URL: ${this.VCP_SERVER_URL}`);
            
            // 发送请求
            const startTime = Date.now();
            console.log(`[ExecutionEngine] 发送请求到服务器...`);
            
            const response = await fetch(this.VCP_SERVER_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain;charset=UTF-8',
                    'Authorization': `Bearer ${this.VCP_API_KEY}`
                },
                body: requestBody
            });
            
            const endTime = Date.now();
            console.log(`[ExecutionEngine] 请求耗时: ${endTime - startTime}ms`);
            console.log(`[ExecutionEngine] 响应状态: ${response.status} ${response.statusText}`);
            console.log(`[ExecutionEngine] 响应头:`, Object.fromEntries(response.headers.entries()));
            
            const responseText = await response.text();
            console.log(`[ExecutionEngine] 原始响应文本:`, responseText);
            
            if (!response.ok) {
                console.error(`[ExecutionEngine] 请求失败: HTTP ${response.status}`);
                try {
                    const errorJson = JSON.parse(responseText);
                    console.error(`[ExecutionEngine] 错误详情:`, errorJson);
                    throw new Error(`HTTP ${response.status}: ${errorJson.error || responseText}`);
                } catch (e) {
                    console.error(`[ExecutionEngine] 解析错误响应失败:`, e);
                    throw new Error(`HTTP ${response.status}: ${responseText}`);
                }
            }
            
            let data;
            try {
                data = JSON.parse(responseText);
                console.log(`[ExecutionEngine] 解析后的响应数据:`, data);
            } catch (e) {
                console.error(`[ExecutionEngine] 解析响应JSON失败:`, e);
                console.log(`[ExecutionEngine] 将响应文本作为结果返回`);
                return responseText;
            }
            
            // 直接使用插件输出，不进行过滤 - 保持数据流透明
            let result = data;
            console.log(`[ExecutionEngine] 插件原始输出:`, result);
            
            // 如果数据有特定的结构，尝试提取有用的信息
            if (data.result && typeof data.result.content === 'string') {
                console.log(`[ExecutionEngine] 尝试解析 result.content:`, data.result.content);
                try {
                    const parsedContent = JSON.parse(data.result.content);
                    console.log(`[ExecutionEngine] 解析后的 content:`, parsedContent);
                    result = parsedContent.original_plugin_output || parsedContent;
                    console.log(`[ExecutionEngine] 最终提取的结果:`, result);
                } catch (e) {
                    console.log(`[ExecutionEngine] 解析 content 失败，使用原始数据:`, e);
                    result = data;
                }
            }
            
            // 添加执行元数据，但不影响原始数据
            if (result && typeof result === 'object') {
                result._metadata = {
                    executedBy: node.id,
                    timestamp: new Date().toISOString(),
                    executionId: this.executionId || 'unknown'
                };
            }
            
            // 检查结果中是否包含错误信息
            if (result && typeof result === 'object') {
                if (result.error) {
                    console.error(`[ExecutionEngine] 插件返回错误:`, result.error);
                }
                if (result.success !== undefined) {
                    console.log(`[ExecutionEngine] 插件执行状态:`, result.success ? '成功' : '失败');
                }
                if (result.message) {
                    console.log(`[ExecutionEngine] 插件消息:`, result.message);
                }
                if (result.data) {
                    console.log(`[ExecutionEngine] 插件数据:`, result.data);
                }
            }
            
            console.log(`[ExecutionEngine] 节点 ${node.id} 执行完成，返回结果:`, result);
            return result;
        }

        // 执行正则表达式节点
        executeRegexNode(node, inputData) {
            const config = node.config || {};
            const { pattern, flags = 'g', operation = 'match', replacement = '' } = config;
            
            // 从输入数据中提取文本内容
            let text = '';
            if (inputData.input && typeof inputData.input === 'object') {
                // 如果输入是对象，尝试提取文本内容
                text = inputData.input.original_plugin_output || 
                       inputData.input.text || 
                       inputData.input.content || 
                       inputData.input.message ||
                       JSON.stringify(inputData.input);
            } else if (inputData.input) {
                text = String(inputData.input);
            } else if (inputData.text) {
                text = inputData.text;
            } else {
                // 如果没有找到文本，将整个输入转为字符串
                text = JSON.stringify(inputData);
            }
            
            if (!pattern) {
                throw new Error('正则表达式节点需要 pattern 参数');
            }
            
            console.log(`[ExecutionEngine] 正则处理 - 文本: ${text.substring(0, 100)}...`);
            console.log(`[ExecutionEngine] 正则处理 - 模式: ${pattern}`);
            
            try {
                const regex = new RegExp(pattern, flags);
                let result;

                switch (operation) {
                    case 'match':
                        const matches = [];
                        const captureGroups = [];
                        let match;
                        while ((match = regex.exec(text)) !== null) {
                            matches.push(match[0]); // 完整匹配
                            // 如果有捕获组，使用捕获组的内容；否则使用完整匹配
                            if (match.length > 1) {
                                captureGroups.push(match[1]); // 第一个捕获组
                            } else {
                                captureGroups.push(match[0]); // 完整匹配
                            }
                            if (!flags.includes('g')) break;
                        }
                        
                        return {
                            matches: matches,
                            output: captureGroups, // 返回捕获组内容
                            text: text
                        };
                    
                    case 'replace':
                        result = text.replace(regex, replacement);
                        return { output: result };
                    
                    case 'test':
                        result = regex.test(text);
                        return { output: result };
                    
                    case 'split':
                        result = text.split(regex);
                        return { output: result };
                    
                    default:
                        result = text.match(regex);
                        return { output: result || [], matches: result || [] };
                }
            } catch (error) {
                throw new Error(`正则表达式执行失败: ${error.message}`);
            }
        }

        // 执行数据转换节点
        executeDataTransformNode(node, inputData) {
            console.log('[ExecutionEngine] 数据转换 - 输入数据:', inputData);
            console.log('[ExecutionEngine] 数据转换 - 节点配置:', node.config);
            
            const { transformType, customScript, outputParamName } = node.config || {};
            let result;
            
            try {
                if (transformType === 'custom' && customScript) {
                    // 自定义脚本转换 - 将所有输入数据作为变量传递给脚本
                    const scriptVars = Object.keys(inputData);
                    const scriptValues = Object.values(inputData);
                    
                    console.log('[ExecutionEngine] 执行自定义脚本，可用变量:', scriptVars);
                    
                    // 创建函数，将所有输入数据作为参数传递
                    const func = new Function(...scriptVars, customScript);
                    result = func(...scriptValues);
                    
                    console.log('[ExecutionEngine] 自定义脚本执行结果:', result);
                } else {
                    // 默认转换：如果有 data 参数则使用，否则使用第一个输入参数
                    const dataKey = inputData.data !== undefined ? 'data' : Object.keys(inputData)[0];
                    const data = inputData[dataKey];
                    
                    console.log('[ExecutionEngine] 默认转换，使用参数:', dataKey, '值:', data);
                    
                    switch (transformType) {
                        case 'json':
                            result = typeof data === 'string' ? JSON.parse(data) : data;
                            break;
                        case 'string':
                            result = typeof data === 'object' ? JSON.stringify(data) : String(data);
                            break;
                        case 'array':
                            result = Array.isArray(data) ? data : [data];
                            break;
                        default:
                            result = data;
                    }
                }
                
                // 使用自定义输出参数名或默认的 'result'
                const outputKey = outputParamName || 'result';
                const output = { [outputKey]: result };
                
                console.log('[ExecutionEngine] 数据转换完成，输出:', output);
                return output;
                
            } catch (error) {
                console.error('[ExecutionEngine] 数据转换执行失败:', error);
                throw new Error(`数据转换失败: ${error.message}`);
            }
        }

        // 执行代码编辑节点
        async executeCodeEditNode(node, inputData) {
            console.log('[ExecutionEngine] 执行代码编辑节点:', node.id);
            console.log('[ExecutionEngine] 输入数据:', inputData);
            console.log('[ExecutionEngine] 节点配置:', node.config);
            
            const config = node.config || {};
            const { language = 'javascript', code = '', operation = 'format' } = config;
            
            // 获取输入内容
            let inputContent = '';
            if (inputData.input !== undefined) {
                if (typeof inputData.input === 'object') {
                    inputContent = JSON.stringify(inputData.input, null, 2);
                } else {
                    inputContent = String(inputData.input);
                }
            } else if (inputData.code) {
                inputContent = inputData.code;
            } else if (code) {
                inputContent = code;
            }
            
            console.log('[ExecutionEngine] 代码编辑 - 输入内容:', inputContent.substring(0, 200) + '...');
            console.log('[ExecutionEngine] 代码编辑 - 语言:', language, '操作:', operation);
            
            try {
                let result;
                
                switch (operation) {
                    case 'format':
                        result = this.formatCode(inputContent, language);
                        break;
                    
                    case 'minify':
                        result = this.minifyCode(inputContent, language);
                        break;
                    
                    case 'validate':
                        result = this.validateCode(inputContent, language);
                        break;
                    
                    case 'execute':
                        if (language === 'javascript') {
                            try {
                                // 创建安全的执行环境
                                const func = new Function('input', 'inputData', `
                                    ${inputContent}
                                    // 如果代码没有返回值，返回输入数据
                                    if (typeof result !== 'undefined') return result;
                                    return input;
                                `);
                                result = func(inputData.input, inputData);
                            } catch (error) {
                                throw new Error(`JavaScript执行失败: ${error.message}`);
                            }
                        } else {
                            throw new Error(`不支持执行 ${language} 代码`);
                        }
                        break;
                    
                    default:
                        result = inputContent;
                }
                
                console.log('[ExecutionEngine] 代码编辑结果:', result);
                
                // 使用自定义输出参数名
                const outputParamName = config.outputParamName || 'output';
                return { [outputParamName]: result };
                
            } catch (error) {
                console.error('[ExecutionEngine] 代码编辑执行失败:', error);
                throw new Error(`代码编辑失败: ${error.message}`);
            }
        }

        // 执行条件判断节点
        async executeConditionNode(node, inputData) {
            console.log('[ExecutionEngine] 执行条件判断节点:', node.id);
            console.log('[ExecutionEngine] 输入数据:', inputData);
            console.log('[ExecutionEngine] 节点配置:', node.config);
            
            const config = node.config || {};
            const { condition, operator = '==', value = '' } = config;
            
            // 获取输入值
            let inputValue = inputData.input;
            if (inputValue === undefined && Object.keys(inputData).length > 0) {
                inputValue = Object.values(inputData)[0]; // 使用第一个输入值
            }
            
            console.log('[ExecutionEngine] 条件判断 - 输入值:', inputValue, '操作符:', operator, '比较值:', value);
            
            try {
                let result = false;
                
                switch (operator) {
                    case '==':
                        result = inputValue == value;
                        break;
                    case '!=':
                        result = inputValue != value;
                        break;
                    case '>':
                        result = Number(inputValue) > Number(value);
                        break;
                    case '<':
                        result = Number(inputValue) < Number(value);
                        break;
                    case '>=':
                        result = Number(inputValue) >= Number(value);
                        break;
                    case '<=':
                        result = Number(inputValue) <= Number(value);
                        break;
                    case 'contains':
                        result = String(inputValue).includes(String(value));
                        break;
                    case 'startsWith':
                        result = String(inputValue).startsWith(String(value));
                        break;
                    case 'endsWith':
                        result = String(inputValue).endsWith(String(value));
                        break;
                    default:
                        // 自定义条件表达式
                        if (condition) {
                            const func = new Function('input', 'value', `return ${condition}`);
                            result = func(inputValue, value);
                        }
                }
                
                console.log('[ExecutionEngine] 条件判断结果:', result);
                
                // 根据结果返回到不同的输出端口
                if (result) {
                    return { true: inputValue, result: true };
                } else {
                    return { false: inputValue, result: false };
                }
                
            } catch (error) {
                console.error('[ExecutionEngine] 条件判断执行失败:', error);
                throw new Error(`条件判断失败: ${error.message}`);
            }
        }

        // 执行循环控制节点
        async executeLoopNode(node, inputData) {
            console.log('[ExecutionEngine] 执行循环控制节点:', node.id);
            console.log('[ExecutionEngine] 输入数据:', inputData);
            console.log('[ExecutionEngine] 节点配置:', node.config);
            
            const config = node.config || {};
            const { loopType = 'forEach', maxIterations = 100 } = config;
            
            let items = [];
            let inputValue = inputData.input;
            
            // 获取循环项目
            if (inputData.items && Array.isArray(inputData.items)) {
                items = inputData.items;
            } else if (Array.isArray(inputValue)) {
                items = inputValue;
            } else if (inputValue !== undefined) {
                items = [inputValue]; // 单个值转为数组
            }
            
            console.log('[ExecutionEngine] 循环控制 - 类型:', loopType, '项目数:', items.length, '最大迭代:', maxIterations);
            
            try {
                const results = [];
                let iterations = Math.min(items.length, maxIterations);
                
                switch (loopType) {
                    case 'forEach':
                        for (let i = 0; i < iterations; i++) {
                            results.push({
                                item: items[i],
                                index: i,
                                total: items.length
                            });
                        }
                        break;
                    
                    case 'times':
                        const times = Math.min(Number(inputValue) || 1, maxIterations);
                        for (let i = 0; i < times; i++) {
                            results.push({
                                item: i + 1,
                                index: i,
                                total: times
                            });
                        }
                        break;
                    
                    case 'while':
                        // 简单的while循环实现
                        let count = 0;
                        while (count < maxIterations && inputValue) {
                            results.push({
                                item: count + 1,
                                index: count,
                                total: maxIterations
                            });
                            count++;
                            // 简单条件：如果输入是数字，递减到0
                            if (typeof inputValue === 'number') {
                                inputValue--;
                            } else {
                                break; // 避免无限循环
                            }
                        }
                        break;
                }
                
                console.log('[ExecutionEngine] 循环控制结果:', results.length, '项');
                
                return {
                    output: results,
                    items: results.map(r => r.item),
                    count: results.length
                };
                
            } catch (error) {
                console.error('[ExecutionEngine] 循环控制执行失败:', error);
                throw new Error(`循环控制失败: ${error.message}`);
            }
        }

        // 执行延时等待节点
        async executeDelayNode(node, inputData) {
            console.log('[ExecutionEngine] 执行延时等待节点:', node.id);
            console.log('[ExecutionEngine] 输入数据:', inputData);
            console.log('[ExecutionEngine] 节点配置:', node.config);
            
            const config = node.config || {};
            const { delay = 1000, unit = 'milliseconds' } = config;
            
            let delayMs = delay;
            switch (unit) {
                case 'seconds':
                    delayMs = delay * 1000;
                    break;
                case 'minutes':
                    delayMs = delay * 60 * 1000;
                    break;
            }
            
            console.log('[ExecutionEngine] 延时等待:', delayMs, 'ms');
            
            await new Promise(resolve => setTimeout(resolve, delayMs));
            
            // 返回输入数据
            return { output: inputData.input || inputData };
        }

        // 执行URL提取器节点
        async executeUrlExtractorNode(node, inputData) {
            console.log('[ExecutionEngine] 执行URL提取器节点:', node.id);
            console.log('[ExecutionEngine] 输入数据:', inputData);
            console.log('[ExecutionEngine] 节点配置:', node.config);
            
            // 调用NodeManager中的URL提取器实现
            if (window.WorkflowEditor_NodeManager && window.WorkflowEditor_NodeManager.executeUrlExtractorNode) {
                try {
                    const result = await window.WorkflowEditor_NodeManager.executeUrlExtractorNode(node, inputData);
                    console.log('[ExecutionEngine] URL提取器执行结果:', result);
                    return result;
                } catch (error) {
                    console.error('[ExecutionEngine] URL提取器执行失败:', error);
                    throw error;
                }
            } else {
                throw new Error('URL提取器功能未加载，请确保相关模块已正确加载');
            }
        }

        // 执行图片上传节点
        async executeImageUploadNode(node, inputData) {
            console.log('[ExecutionEngine] 执行图片上传节点:', node.id);
            console.log('[ExecutionEngine] 输入数据:', inputData);
            console.log('[ExecutionEngine] 节点配置:', node.config);
            
            // 调用NodeManager中的图片上传节点实现
            if (window.WorkflowEditor_NodeManager && window.WorkflowEditor_NodeManager.executeImageUploadNode) {
                try {
                    const result = await window.WorkflowEditor_NodeManager.executeImageUploadNode(node, inputData);
                    console.log('[ExecutionEngine] 图片上传节点执行结果:', result);
                    return result;
                } catch (error) {
                    console.error('[ExecutionEngine] 图片上传节点执行失败:', error);
                    throw error;
                }
            } else {
                throw new Error('图片上传功能未加载，请确保相关模块已正确加载');
            }
        }

        // 代码格式化方法
        formatCode(code, language) {
            try {
                switch (language) {
                    case 'json':
                        const parsed = JSON.parse(code);
                        return JSON.stringify(parsed, null, 2);
                    
                    case 'javascript':
                        // 简单的JavaScript格式化
                        return code
                            .replace(/;/g, ';\n')
                            .replace(/{/g, '{\n')
                            .replace(/}/g, '\n}')
                            .replace(/,/g, ',\n')
                            .split('\n')
                            .map(line => line.trim())
                            .filter(line => line.length > 0)
                            .join('\n');
                    
                    case 'html':
                        // 简单的HTML格式化
                        return code
                            .replace(/></g, '>\n<')
                            .replace(/^\s+|\s+$/g, '');
                    
                    case 'css':
                        // 简单的CSS格式化
                        return code
                            .replace(/{/g, ' {\n')
                            .replace(/}/g, '\n}\n')
                            .replace(/;/g, ';\n')
                            .replace(/,/g, ',\n');
                    
                    default:
                        return code;
                }
            } catch (error) {
                console.warn('[ExecutionEngine] 代码格式化失败:', error);
                return code;
            }
        }

        // 代码压缩方法
        minifyCode(code, language) {
            try {
                switch (language) {
                    case 'json':
                        const parsed = JSON.parse(code);
                        return JSON.stringify(parsed);
                    
                    case 'javascript':
                        // 简单的JavaScript压缩
                        return code
                            .replace(/\s+/g, ' ')
                            .replace(/;\s/g, ';')
                            .replace(/{\s/g, '{')
                            .replace(/\s}/g, '}')
                            .trim();
                    
                    case 'css':
                        // 简单的CSS压缩
                        return code
                            .replace(/\s+/g, ' ')
                            .replace(/;\s/g, ';')
                            .replace(/{\s/g, '{')
                            .replace(/\s}/g, '}')
                            .trim();
                    
                    default:
                        return code.replace(/\s+/g, ' ').trim();
                }
            } catch (error) {
                console.warn('[ExecutionEngine] 代码压缩失败:', error);
                return code;
            }
        }

        // 代码验证方法
        validateCode(code, language) {
            try {
                switch (language) {
                    case 'json':
                        JSON.parse(code);
                        return { valid: true, message: 'JSON格式正确' };
                    
                    case 'javascript':
                        new Function(code);
                        return { valid: true, message: 'JavaScript语法正确' };
                    
                    case 'html':
                        // 简单的HTML验证
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(code, 'text/html');
                        const errors = doc.querySelectorAll('parsererror');
                        if (errors.length > 0) {
                            return { valid: false, message: 'HTML格式错误' };
                        }
                        return { valid: true, message: 'HTML格式正确' };
                    
                    default:
                        return { valid: true, message: '语法检查不可用' };
                }
            } catch (error) {
                return { valid: false, message: error.message };
            }
        }

        // 执行URL渲染器节点 - 使用批量渲染补丁
        executeUrlRendererNode(node, inputData) {
            console.log(`[ExecutionEngine] 执行URL渲染器节点:`, node.id);
            console.log(`[ExecutionEngine] 节点配置:`, node.config);
            console.log(`[ExecutionEngine] 输入数据:`, inputData);
            
            // 检查是否有批量渲染补丁可用
            if (window.WorkflowEditor_NodeManager && 
                window.WorkflowEditor_NodeManager.executeUrlRendererNode && 
                typeof window.WorkflowEditor_NodeManager.executeUrlRendererNode === 'function') {
                
                console.log(`[ExecutionEngine] 使用批量渲染补丁处理URL渲染`);
                
                try {
                    // 调用补丁中的批量渲染方法
                    return window.WorkflowEditor_NodeManager.executeUrlRendererNode.call(
                        window.WorkflowEditor_NodeManager, 
                        node, 
                        inputData
                    );
                } catch (error) {
                    console.error(`[ExecutionEngine] 批量渲染补丁执行失败，回退到原始方法:`, error);
                    // 如果补丁失败，继续使用原始方法
                }
            }
            
            // 原始单个URL渲染逻辑（作为后备方案）
            const config = node.config || {};
            let { urlPath = 'imageUrl', renderType = 'image', width = 300, height = 200 } = node.config || {};
            
            // 对 urlPath 进行变量解析
            console.log(`[ExecutionEngine] URL渲染器 - 原始urlPath: ${urlPath}`);
            const resolvedUrlPath = this._resolveValue(urlPath, inputData);
            console.log(`[ExecutionEngine] URL渲染器 - 解析后urlPath:`, resolvedUrlPath, `类型: ${typeof resolvedUrlPath}`);

            // 从输入数据或配置中获取URL
            let url = null;
            
            // 检查解析后的结果类型
            if (Array.isArray(resolvedUrlPath)) {
                // 如果解析结果是数组，说明 {{input.images}} 被解析成了数组
                console.log(`[ExecutionEngine] 检测到数组数据，尝试提取第一个URL`);
                
                // 尝试从数组中提取URL
                for (const item of resolvedUrlPath) {
                    if (typeof item === 'string' && (item.startsWith('http://') || item.startsWith('https://'))) {
                        url = item;
                        break;
                    } else if (typeof item === 'object' && item !== null) {
                        url = item.url || item.imageUrl || item.src;
                        if (url) break;
                    }
                }
                
                console.log(`[ExecutionEngine] 从数组中提取的URL: ${url}`);
            } 
            // 检查解析后的 urlPath 是否直接是一个URL字符串
            else if (resolvedUrlPath && (typeof resolvedUrlPath === 'string') && (resolvedUrlPath.startsWith('http://') || resolvedUrlPath.startsWith('https://'))) {
                url = resolvedUrlPath;
                console.log(`[ExecutionEngine] 从解析后的 urlPath 中获取URL: ${url}`);
            } 
            // 否则，尝试从 inputData 中提取
            else if (inputData.input && typeof inputData.input === 'object') {
                // 如果 urlPath 仍然是字符串路径，使用它来提取数据
                if (typeof urlPath === 'string') {
                    url = this._getNestedProperty(inputData.input, urlPath) || inputData.input.imageUrl || inputData.input.url;
                } else {
                    url = inputData.input.imageUrl || inputData.input.url;
                }
                console.log(`[ExecutionEngine] 从输入数据中提取URL: ${url}`);
            } else if (inputData.url) {
                url = inputData.url;
                console.log(`[ExecutionEngine] 从输入数据url字段获取: ${url}`);
            } else if (inputData.imageUrl) {
                url = inputData.imageUrl;
                console.log(`[ExecutionEngine] 从输入数据imageUrl字段获取: ${url}`);
            } else if (node.config.url) {
                url = this._resolveValue(node.config.url, inputData);
                console.log(`[ExecutionEngine] 从配置url字段获取: ${url}`);
            }
            
            console.log(`[ExecutionEngine] 最终提取的URL:`, url);
            
            if (!url) {
                console.warn(`[ExecutionEngine] URL渲染器未找到有效的URL`);
                return { error: '未找到有效的URL进行渲染' };
            }
            
            // 根据渲染类型生成相应的HTML内容
            let htmlContent = '';
            let actualRenderType = renderType;
            
            // 处理 auto 类型：根据URL自动判断渲染方式
            if (renderType === 'auto') {
                if (url.match(/\.(jpg|jpeg|png|gif|bmp|webp|svg)(\?.*)?$/i)) {
                    actualRenderType = 'image';
                } else if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('bilibili.com')) {
                    actualRenderType = 'iframe';
                } else {
                    actualRenderType = 'link';
                }
                console.log(`[ExecutionEngine] Auto模式检测到渲染类型: ${actualRenderType}`);
            }
            
            switch (actualRenderType) {
                case 'image':
                    htmlContent = `<img src="${url}" alt="渲染图片" style="max-width: ${width}px; max-height: ${height}px;" />`;
                    break;
                case 'iframe':
                    htmlContent = `<iframe src="${url}" width="${width}" height="${height}" frameborder="0"></iframe>`;
                    break;
                case 'link':
                    htmlContent = `<a href="${url}" target="_blank">${url}</a>`;
                    break;
                default:
                    htmlContent = `<div>URL: <a href="${url}" target="_blank">${url}</a></div>`;
            }
            
            // 更新节点的显示内容
            console.log(`[ExecutionEngine] 尝试更新节点 ${node.id} 的显示内容`);
            
            // 尝试多种选择器来找到节点元素
            let nodeElement = document.querySelector(`[data-node-id="${node.id}"] .node-content`);
            if (!nodeElement) {
                nodeElement = document.querySelector(`#${node.id} .node-content`);
            }
            if (!nodeElement) {
                nodeElement = document.querySelector(`[data-node-id="${node.id}"]`);
            }
            if (!nodeElement) {
                nodeElement = document.querySelector(`#${node.id}`);
            }
            
            if (nodeElement) {
                console.log(`[ExecutionEngine] 找到节点元素，更新内容:`, htmlContent);
                
                // 如果是 .node-content 元素，直接设置内容
                if (nodeElement.classList.contains('node-content')) {
                    nodeElement.innerHTML = htmlContent;
                } else {
                    // 如果是节点容器，查找或创建 .node-content 子元素
                    let contentElement = nodeElement.querySelector('.node-content');
                    if (!contentElement) {
                        contentElement = nodeElement.querySelector('.node-body');
                    }
                    if (!contentElement) {
                        // 创建一个内容区域
                        contentElement = document.createElement('div');
                        contentElement.className = 'node-rendered-content';
                        contentElement.style.cssText = 'padding: 10px; margin-top: 5px; border-top: 1px solid #333;';
                        nodeElement.appendChild(contentElement);
                    }
                    contentElement.innerHTML = htmlContent;
                }
                
                console.log(`[ExecutionEngine] 节点 ${node.id} 显示内容已更新`);
            } else {
                console.warn(`[ExecutionEngine] 未找到节点 ${node.id} 的DOM元素`);
                
                // 尝试通过 stateManager 更新节点
                if (this.stateManager && this.stateManager.updateNodeContent) {
                    console.log(`[ExecutionEngine] 尝试通过 stateManager 更新节点内容`);
                    this.stateManager.updateNodeContent(node.id, htmlContent);
                }
            }
            
            return {
                success: true,
                url: url,
                htmlContent: htmlContent,
                renderType: renderType
            };
        }

        // 执行文本显示节点
        executeTextDisplayNode(node, inputData) {
            console.log(`[ExecutionEngine] 执行文本显示节点:`, node.id);
            
            let text = '';
            if (inputData.input && typeof inputData.input === 'object') {
                text = inputData.input.text || inputData.input.message || JSON.stringify(inputData.input);
            } else if (inputData.text) {
                text = inputData.text;
            } else if (inputData.message) {
                text = inputData.message;
            }
            
            // 更新节点显示
            if (this.stateManager) {
                const nodeElement = document.querySelector(`[data-node-id="${node.id}"] .node-content`);
                if (nodeElement) {
                    nodeElement.textContent = text;
                }
            }
            
            return { success: true, text: text };
        }

        // 执行图片显示节点
        executeImageDisplayNode(node, inputData) {
            console.log(`[ExecutionEngine] 执行图片显示节点:`, node.id);
            
            let imageUrl = '';
            if (inputData.input && typeof inputData.input === 'object') {
                imageUrl = inputData.input.imageUrl || inputData.input.url;
            } else if (inputData.imageUrl) {
                imageUrl = inputData.imageUrl;
            } else if (inputData.url) {
                imageUrl = inputData.url;
            }
            
            if (imageUrl) {
                const imgHtml = `<img src="${imageUrl}" alt="显示图片" style="max-width: 200px; max-height: 200px;" />`;
                
                // 更新节点显示
                if (this.stateManager) {
                    const nodeElement = document.querySelector(`[data-node-id="${node.id}"] .node-content`);
                    if (nodeElement) {
                        nodeElement.innerHTML = imgHtml;
                    }
                }
            }
            
            return { success: true, imageUrl: imageUrl };
        }

        // 执行HTML显示节点
        executeHtmlDisplayNode(node, inputData) {
            console.log(`[ExecutionEngine] 执行HTML显示节点:`, node.id);
            
            let htmlContent = '';
            if (inputData.input && typeof inputData.input === 'object') {
                htmlContent = inputData.input.html || inputData.input.htmlContent || inputData.input.content;
            } else if (inputData.html) {
                htmlContent = inputData.html;
            } else if (inputData.htmlContent) {
                htmlContent = inputData.htmlContent;
            }
            
            // 更新节点显示
            if (this.stateManager) {
                const nodeElement = document.querySelector(`[data-node-id="${node.id}"] .node-content`);
                if (nodeElement) {
                    nodeElement.innerHTML = htmlContent;
                }
            }
            
            return { success: true, htmlContent: htmlContent };
        }

        // 执行JSON显示节点
        executeJsonDisplayNode(node, inputData) {
            console.log(`[ExecutionEngine] 执行JSON显示节点:`, node.id);
            
            let jsonData = inputData.input || inputData;
            const jsonString = JSON.stringify(jsonData, null, 2);
            
            // 更新节点显示
            if (this.stateManager) {
                const nodeElement = document.querySelector(`[data-node-id="${node.id}"] .node-content`);
                if (nodeElement) {
                    nodeElement.innerHTML = `<pre>${jsonString}</pre>`;
                }
            }
            
            return { success: true, jsonData: jsonData };
        }

        // 传播输出数据
        propagateOutputData(nodeId, graphNode) {
            const result = this.nodeResults.get(nodeId);
            const sourceNode = graphNode.node;
            console.log(`[ExecutionEngine] 传播节点 ${nodeId} 的输出数据:`, result);
            console.log(`[ExecutionEngine] 节点有 ${graphNode.outputs.length} 个输出连接`);
            
            if (graphNode.outputs.length === 0) {
                console.log(`[ExecutionEngine] 节点 ${nodeId} 没有输出连接，跳过数据传播`);
                return;
            }
            
            graphNode.outputs.forEach((output, index) => {
                console.log(`[ExecutionEngine] 处理输出连接 ${index + 1}:`, output);
                
                const targetInputData = this.nodeInputData.get(output.targetNodeId) || {};
                console.log(`[ExecutionEngine] 目标节点 ${output.targetNodeId} 当前输入数据:`, targetInputData);
                
                // 优先使用连接配置的目标参数名，然后是默认的 'input'
                let targetParam = output.connection?.targetParam || output.targetPort || 'input';
                let useCustomOutputName = false;
                
                // 如果源节点是辅助节点且配置了自定义输出参数名，使用它作为键名
                if (sourceNode.category === 'auxiliary' && sourceNode.config && sourceNode.config.outputParamName) {
                    // 注意：这里不应该改变 targetParam，而是在数据中使用自定义键名
                    useCustomOutputName = true;
                    console.log(`[ExecutionEngine] 源节点使用自定义输出参数名: ${sourceNode.config.outputParamName}`);
                }
                
                // 直接传播完整的输出数据 - 保持数据流透明
                let dataToPass = result;
                
                // 保留正则节点的特殊处理（向后兼容）
                if (useCustomOutputName && sourceNode.pluginId === 'regex' && result && typeof result === 'object' && result.output !== undefined) {
                    dataToPass = result.output;
                    console.log(`[ExecutionEngine] 正则节点使用自定义输出名，传递 output 字段:`, dataToPass);
                } else {
                    // 对于所有其他情况，直接传递完整数据
                    // 让下游节点通过模板语法自己选择需要的字段
                    console.log(`[ExecutionEngine] 传递完整输出数据到参数 ${targetParam}`);
                }
                
                targetInputData[targetParam] = dataToPass;
                
                console.log(`[ExecutionEngine] 设置节点 ${output.targetNodeId} 的输入参数 ${targetParam}:`, dataToPass);
                
                this.nodeInputData.set(output.targetNodeId, targetInputData);
                
                // 检查目标节点是否现在可以执行
                const targetNode = this.stateManager.getNode(output.targetNodeId);
                if (targetNode && this.areRequiredInputsReady(output.targetNodeId, targetNode)) {
                    console.log(`[ExecutionEngine] 节点 ${output.targetNodeId} 现在可以执行了`);
                }
            });
        }

        // 更新节点状态
        updateNodeStatus(nodeId, status) {
            if (this.stateManager) {
                const node = this.stateManager.getNode(nodeId);
                if (node) {
                    node.status = status;
                    this.stateManager.updateNode(nodeId, { status });
                }
            }
        }

        // 停止执行
        stopExecution() {
            this.isExecuting = false;
            console.log('[ExecutionEngine] Execution stopped');
        }

        // 获取节点结果
        getNodeResult(nodeId) {
            return this.nodeResults.get(nodeId);
        }

        // 获取所有结果
        getAllResults() {
            return Object.fromEntries(this.nodeResults);
        }

        // 清除结果
        clearResults() {
            this.nodeResults.clear();
            this.nodeInputData.clear();
        }

        // 已移除 extractPluginOutput 方法 - 数据流现在完全透明
        // 插件输出直接传递给下游节点，不进行任何过滤

        // 已移除 cleanPluginOutput 方法 - 不再进行数据清洗
        // 保持插件输出的完整性和透明性

        // 处理输入数据，支持JSON解析
        processInputData(data) {
            console.log(`[ExecutionEngine] 处理输入数据:`, data);
            
            // 如果数据是字符串，尝试解析为JSON
            if (typeof data === 'string') {
                try {
                    const parsed = JSON.parse(data);
                    console.log(`[ExecutionEngine] 成功解析JSON:`, parsed);
                    return parsed;
                } catch (e) {
                    console.log(`[ExecutionEngine] 字符串不是有效JSON，返回原始字符串`);
                    return data;
                }
            }
            
            return data;
        }


        // 设置嵌套对象的值（支持 a.b.c 格式）
        setNestedValue(obj, path, value) {
            const keys = path.split('.');
            let current = obj;
            
            for (let i = 0; i < keys.length - 1; i++) {
                const key = keys[i];
                if (!(key in current) || typeof current[key] !== 'object') {
                    current[key] = {};
                }
                current = current[key];
            }
            
            current[keys[keys.length - 1]] = value;
        }

        // 辅助方法：安全获取嵌套属性
        _getNestedProperty(obj, path) {
            if (!obj || typeof obj !== 'object' || !path) return undefined;
            const parts = path.split('.');
            let current = obj;
            for (const part of parts) {
                if (current === null || typeof current !== 'object' || !current.hasOwnProperty(part)) {
                    return undefined;
                }
                current = current[part];
            }
            return current;
        }

        // 辅助方法：解析带有 {{...}} 语法的变量
        _resolveValue(value, inputData) {
            if (typeof value !== 'string') {
                return value; // 只处理字符串
            }

            const regex = /\{\{(.*?)\}\}/g;
            let resolved = value;
            let match;

            // First pass: check if the entire string is a single {{...}} expression
            const fullMatchRegex = /^\{\{(.*?)\}\}$/;
            const fullMatch = value.match(fullMatchRegex);
            if (fullMatch) {
                const path = fullMatch[1].trim(); // 例如: 'extractedUrls' 或 'input.extractedUrls'
                const resolvedData = this._resolveVariablePath(path, inputData);
                
                // 特殊处理：如果解析结果是对象且包含 'output' 属性，则提取其值
                if (typeof resolvedData === 'object' && resolvedData !== null && resolvedData.output !== undefined) {
                    return String(resolvedData.output); // 返回 'output' 属性的值并转为字符串
                }
                return resolvedData; // 返回原始解析值，可以是任何类型
            }

            // Second pass: replace multiple {{...}} expressions within a string
            while ((match = regex.exec(value)) !== null) {
                const fullPlaceholder = match[0]; // 例如: {{extractedUrls}}
                const path = match[1].trim(); // 例如: extractedUrls

                let resolvedData = this._resolveVariablePath(path, inputData);
                
                // 特殊处理：如果解析结果是对象且包含 'output' 属性，则提取其值
                if (typeof resolvedData === 'object' && resolvedData !== null && resolvedData.output !== undefined) {
                    resolvedData = String(resolvedData.output); // 使用 'output' 属性的值并转为字符串
                } else if (typeof resolvedData === 'object' && resolvedData !== null) {
                    resolvedData = JSON.stringify(resolvedData); // 对于其他对象，将其 JSON 字符串化
                }
                
                // Replace the placeholder with the string representation of the resolved data
                resolved = resolved.replace(fullPlaceholder, resolvedData !== undefined ? String(resolvedData) : '');
            }
            return resolved;
        }

        // 解析变量路径 - 支持直接引用和兼容旧格式
        _resolveVariablePath(path, inputData) {
            console.log(`[ExecutionEngine] 解析变量路径: ${path}`);
            console.log(`[ExecutionEngine] 可用输入数据:`, Object.keys(inputData));
            
            // 兼容模式：支持 input.xxx 格式（向后兼容）
            if (path.startsWith('input.')) {
                const actualPath = path.substring(6); // 移除 "input." 前缀
                console.log(`[ExecutionEngine] 兼容模式 - 实际路径: ${actualPath}`);
                return this._getNestedProperty(inputData, actualPath);
            }
            
            // 直接引用模式：支持直接使用自定义输出名
            // 例如: extractedUrls, extractedUrls[0], extractedUrls.url
            const resolvedData = this._getNestedProperty(inputData, path);
            
            if (resolvedData !== undefined) {
                console.log(`[ExecutionEngine] 直接引用成功: ${path} ->`, resolvedData);
                return resolvedData;
            }
            
            console.warn(`[ExecutionEngine] 无法解析变量路径: ${path}`);
            return undefined;
        }
    }

    // 导出为全局单例
    window.WorkflowEditor_ExecutionEngine = WorkflowEditor_ExecutionEngine.getInstance();
})();