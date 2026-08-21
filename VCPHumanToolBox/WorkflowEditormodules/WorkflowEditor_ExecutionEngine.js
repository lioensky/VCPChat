// WorkflowEditor Execution Engine
(function () {
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
            this.executedNodes = new Set(); // 全局执行状态跟踪
            this.executingNodes = new Set(); // 正在执行的节点

            // 从 settings.json 读取配置
            this.loadSettings();

            WorkflowEditor_ExecutionEngine.instance = this;
            try {
                console.log('[ExecutionEngine] URLRenderer router v2 loaded');
            } catch (_) { }
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
        async loadSettings() {
            try {
                const settings = await window.electronAPI.invoke('vcp-ht-get-settings');

                if (settings.vcpServerUrl) {
                    const url = new URL(settings.vcpServerUrl);
                    url.pathname = '/v1/human/tool';
                    this.VCP_SERVER_URL = url.toString();
                }
                this.VCP_API_KEY = settings.vcpApiKey || '';
                this.USER_NAME = settings.userName || 'Human';

                console.log('[ExecutionEngine] Settings loaded successfully');
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
            this.executedNodes.clear(); // 清空执行状态
            this.executingNodes.clear(); // 清空正在执行状态

            try {
                console.log('[ExecutionEngine] Starting workflow execution');

                // 获取所有节点和连接
                const nodes = this.stateManager.getAllNodes();

                // 简化：直接从 StateManager 获取连接（单一数据源）
                const connections = this.stateManager.getAllConnections();
                console.log('[ExecutionEngine] 从 StateManager 获取连接:', connections.length);

                // 调试信息：输出连接详情
                if (connections.length > 0) {
                    console.log('[ExecutionEngine] 连接详情:');
                    connections.forEach((conn, index) => {
                        console.log(`  ${index + 1}. ${conn.sourceNodeId} → ${conn.targetNodeId} (${conn.targetParam})`);
                    });
                } else {
                    console.warn('[ExecutionEngine] ⚠️ 没有找到任何连接，请检查连接是否正确保存');
                }

                // ===== 预飞行验证 =====
                // 检查环形依赖
                if (this.stateManager.hasCircularDependency()) {
                    throw new Error('⚠️ 工作流存在环形依赖，请检查连线');
                }

                // 检查必需输入是否已连线
                const preflightErrors = [];
                nodes.forEach(node => {
                    if (node.dynamicInputs && Array.isArray(node.dynamicInputs)) {
                        node.dynamicInputs.forEach(input => {
                            if (input.required) {
                                // 检查这个必需输入是否有连线接入
                                const hasConnection = connections.some(
                                    conn => conn.targetNodeId === node.id && conn.targetParam === input.name
                                );
                                // 也检查节点配置里是否有默认值
                                const hasDefault = node.config && node.config[input.name] !== undefined && node.config[input.name] !== '';
                                if (!hasConnection && !hasDefault) {
                                    preflightErrors.push(`节点"${node.name}"的必需输入"${input.name}"未连线且无默认值`);
                                }
                            }
                        });
                    }
                });

                if (preflightErrors.length > 0) {
                    const errorMsg = '⚠️ 预飞行检查失败:\n' + preflightErrors.join('\n');
                    console.error('[ExecutionEngine]', errorMsg);
                    throw new Error(errorMsg);
                }

                console.log('[ExecutionEngine]✅ 预飞行验证通过');

                // 构建执行图
                const executionGraph = this.buildExecutionGraph(nodes, connections);

                // 找到起始节点（没有输入连接的节点）
                const startNodes = this.findStartNodes(nodes, connections);

                if (startNodes.length === 0) {
                    throw new Error('未找到起始节点，请确保工作流有至少一个没有输入连接的节点');
                }

                // 初始化节点输入数据
                this.initializeNodeInputData(nodes);

                // 使用第一个起始节点触发执行（分层拓扑排序会覆盖全图）
                await this.executeNodeChain(startNodes[0], executionGraph);

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

        // 执行节点链 - 使用分层拓扑排序 + 同层并行 + 错误策略
        async executeNodeChain(startNode, executionGraph) {
            console.log(`[ExecutionEngine] 开始执行节点链，起始节点: ${startNode.id}`);

            // 1. 获取分层拓扑排序结果
            let layers;
            if (this.stateManager && typeof this.stateManager.getExecutionLayers === 'function') {
                layers = this.stateManager.getExecutionLayers();
            }

            if (!layers) {
                // fallback: 如果分层排序不可用或有环，退回扁平拓扑排序
                console.warn('[ExecutionEngine] 分层拓扑排序不可用，退回扁平顺序');
                const flatOrder = this.stateManager.getExecutionOrder();
                if (!flatOrder) {
                    throw new Error('工作流存在循环依赖，无法执行');
                }
                layers = flatOrder.map(id => [id]); // 每层一个节点，串行执行
            }

            console.log(`[ExecutionEngine] 拓扑分层结果: ${layers.length} 层`);
            layers.forEach((layer, i) => {
                console.log(`[ExecutionEngine]   层 ${i}: [${layer.join(', ')}]`);
            });

            // 2. 按层逐层执行
            const failedNodes = new Set(); // 记录失败的节点
            const skippedNodes = new Set(); // 记录被跳过的节点

            for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
                const layer = layers[layerIndex];
                console.log(`[ExecutionEngine] === 执行第 ${layerIndex} 层: [${layer.join(', ')}]===`);

                // 过滤掉需要跳过的节点（上游失败的）
                const executableNodes = layer.filter(nodeId => {
                    const graphNode = executionGraph.get(nodeId);
                    if (!graphNode) return false;

                    // 检查是否有上游节点失败
                    const hasFailedUpstream = graphNode.inputs.some(input => {
                        const sourceId = input.sourceNodeId;
                        // 已被循环引擎执行的节点不算失败
                        if (this.executedNodes.has(sourceId)) return false;
                        return failedNodes.has(sourceId) || skippedNodes.has(sourceId);
                    });
                    if (hasFailedUpstream) {
                        const errorPolicy = graphNode.node.config?.errorPolicy || 'stop';
                        if (errorPolicy === 'stop') {
                            console.warn(`[ExecutionEngine] 节点 ${nodeId} 上游失败且策略为stop，跳过`);
                            skippedNodes.add(nodeId);
                            this.updateNodeStatus(nodeId, 'skipped');
                            return false;
                        }
                        // errorPolicy === 'continue': 即使上游失败也尝试执行
                    }
                    return true;
                });

                if (executableNodes.length === 0) {
                    console.log(`[ExecutionEngine] 第 ${layerIndex} 层无可执行节点，跳过`); continue;
                }

                // Phase 3b: 同层并行执行 + maxConcurrency 限流
                const maxConcurrency = this.stateManager?.getWorkflowConfig?.()?.maxConcurrency || 0;
                const effectiveMax = maxConcurrency > 0 ? maxConcurrency : executableNodes.length; // 0=不限

                const layerResults = [];

                for (let chunkStart = 0; chunkStart < executableNodes.length; chunkStart += effectiveMax) {
                    const chunk = executableNodes.slice(chunkStart, chunkStart + effectiveMax);
                    if (maxConcurrency > 0) {
                        console.log(`[ExecutionEngine] 限流分批 ${Math.floor(chunkStart / effectiveMax) + 1}: ${chunk.length} 个节点 (max=${maxConcurrency})`);
                    }

                    const chunkPromises = chunk.map(async (nodeId) => {
                        const graphNode = executionGraph.get(nodeId);

                        // 检查必需输入是否就绪
                        if (!this.areRequiredInputsReady(nodeId, graphNode.node)) {
                            console.log(`[ExecutionEngine] 节点 ${nodeId} 必需输入未就绪，标记跳过`);
                            skippedNodes.add(nodeId);
                            this.updateNodeStatus(nodeId, 'skipped');
                            return { nodeId, status: 'skipped' };
                        }

                        try {
                            this.executingNodes.add(nodeId);

                            // === Loop 子图检测 ===
                            if (graphNode.node.pluginId === 'loopStart') {
                                console.log(`[ExecutionEngine] 检测到 LoopStart 节点 ${nodeId}，启动循环子图执行`);
                                const loopResult = await this.executeLoopFromStart(nodeId, executionGraph);
                                this.nodeResults.set(nodeId, loopResult);
                                this.propagateOutputData(nodeId, graphNode);
                                this.executedNodes.add(nodeId);
                                return { nodeId, status: 'success' };
                            }

                            // === 跳过循环体内节点（已被 LoopStart 接管） ===
                            if (this._isInsideLoopBody(nodeId, executionGraph)) {
                                console.log(`[ExecutionEngine] 节点 ${nodeId} 属于循环体内部，跳过（由 LoopStart 接管）`);
                                skippedNodes.add(nodeId);
                                return { nodeId, status: 'skipped' };
                            }

                            await this.executeNodeWithPolicy(graphNode.node, executionGraph);
                            this.propagateOutputData(nodeId, graphNode);
                            this.executedNodes.add(nodeId);
                            return { nodeId, status: 'success' };
                        }
                        catch (error) {
                            console.error(`[ExecutionEngine] 节点 ${nodeId} 执行失败:`, error);
                            failedNodes.add(nodeId);

                            const errorPolicy = graphNode.node.config?.errorPolicy;
                            const policyType = (typeof errorPolicy === 'object') ? errorPolicy.type : (errorPolicy || 'stop');
                            if (policyType === 'stop') {
                                throw error;
                            }
                            return { nodeId, status: 'error', error: error.message };
                        } finally {
                            this.executingNodes.delete(nodeId);
                        }
                    });

                    const chunkResults = await Promise.allSettled(chunkPromises);
                    layerResults.push(...chunkResults);

                    // 检查是否有 stop 策略的节点抛出了错误
                    for (const result of chunkResults) {
                        if (result.status === 'rejected') {
                            throw result.reason;
                        }
                    }
                }

                // 检查是否有stop 策略的节点抛出了错误
                for (const result of layerResults) {
                    if (result.status === 'rejected') {
                        // stop策略的错误会被reject，中断后续层
                        throw result.reason;
                    }
                }

                console.log(`[ExecutionEngine] 第 ${layerIndex} 层执行完成`);
            }

            // 3. 执行报告
            console.log(`[ExecutionEngine] 节点链执行完成`);
            console.log(`[ExecutionEngine]   成功: ${this.executedNodes.size} 个`);
            console.log(`[ExecutionEngine]   失败: ${failedNodes.size} 个`);
            console.log(`[ExecutionEngine]   跳过: ${skippedNodes.size} 个`);
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
                case 'loopStart':
                    return this.executeLoopStartNode(node, inputData);
                case 'loopEnd':
                    return this.executeLoopEndNode(node, inputData);
                case 'variableAggregator':
                    return this.executeVariableAggregatorNode(node, inputData);
                case 'aiCompose': // AI拼接器节点类型
                    return this.executeAiComposeNode(node, inputData);
                default:
                    throw new Error(`未知的辅助节点类型: ${node.pluginId}`);
            }
        }

        // 执行AI拼接器节点（转调 NodeManager 的实现）
        async executeAiComposeNode(node, inputData) {
            if (window.WorkflowEditor_NodeManager && window.WorkflowEditor_NodeManager.executeAiComposeNode) {
                try {
                    const result = await window.WorkflowEditor_NodeManager.executeAiComposeNode(node, inputData);
                    return result;
                } catch (error) {
                    console.error('[ExecutionEngine] AI拼接器执行失败:', error);
                    throw error;
                }
            } else {
                throw new Error('AI拼接器功能未加载，请确保相关模块已正确加载');
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

            // 先添加节点配置中的参数，支持模板变量解析
            if (node.config) {
                for (const [key, value] of Object.entries(node.config)) {
                    const resolvedValue = this._resolveValue(value, inputData);

                    // 统一的数据传播机制下，解析结果应该是简单类型
                    if (typeof resolvedValue === 'object' && resolvedValue !== null) {
                        // 对于对象类型，JSON 字符串化
                        allParams[key] = JSON.stringify(resolvedValue);
                        console.log(`[ExecutionEngine] JSON 字符串化对象参数 ${key}: ${allParams[key]}`);
                    } else {
                        // 对于简单类型，直接使用
                        allParams[key] = resolvedValue;
                        console.log(`[ExecutionEngine] 添加参数 ${key}: ${allParams[key]}`);
                    }
                }
            }

            // 数据传播的目的是为模板变量提供数据源
            // 一旦模板变量解析完成，就不需要再添加原始传播数据作为请求参数
            // 只使用节点配置中已经解析好的参数即可

            console.log(`[ExecutionEngine] 使用节点配置参数，跳过原始传播数据的添加`);
            console.log(`[ExecutionEngine] 输入数据仅用于模板变量解析:`, Object.keys(inputData));

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

            // 统一插件返回格式为三层结构
            result = this.normalizePluginResult(result);

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
            if (window.WorkflowEditor_NodeManager && typeof window.WorkflowEditor_NodeManager.executeUrlRendererNode === 'function') {
                console.log('[ExecutionEngine] 使用唯一URL渲染入口 (NodeManager.executeUrlRendererNode)');
                return window.WorkflowEditor_NodeManager.executeUrlRendererNode.call(
                    window.WorkflowEditor_NodeManager,
                    node,
                    inputData
                );
            }

            // 后备方案（理论上不会再走到这里）
            const config = node.config || {};
            let { urlPath = 'imageUrl', renderType = 'image' } = node.config || {};

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
                // 生成包含复制和下载功能的完整HTML结构
                const imgHtml = `
                    <div class="image-display-container" style="position: relative; display: inline-block; max-width: 200px;">
                        <img src="${imageUrl}" alt="显示图片" style="max-width: 100%; max-height: 200px; display: block;" />
                        <div class="image-controls" style="position: absolute; top: 5px; right: 5px; display: flex; gap: 5px; opacity: 0.8;">
                            <button class="copy-image-btn" style="background: rgba(0,0,0,0.7); color: white; border: none; border-radius: 3px; padding: 4px; cursor: pointer; font-size: 12px;" title="复制图片">
                                <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: currentColor;">
                                    <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path>
                                </svg>
                            </button>
                            <button class="download-image-btn" style="background: rgba(0,0,0,0.7); color: white; border: none; border-radius: 3px; padding: 4px; cursor: pointer; font-size: 12px;" title="下载图片">
                                <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: currentColor;">
                                    <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"></path>
                                </svg>
                            </button>
                        </div>
                    </div>
                `;

                // 更新节点显示
                if (this.stateManager) {
                    const nodeElement = document.querySelector(`[data-node-id="${node.id}"] .node-content`);
                    if (nodeElement) {
                        nodeElement.innerHTML = imgHtml;

                        // 添加事件监听器
                        this.addImageControlsEventListeners(nodeElement, imageUrl);
                    }
                }
            }

            return { success: true, imageUrl: imageUrl };
        }

        // 添加图片控制按钮的事件监听器
        addImageControlsEventListeners(nodeElement, imageUrl) {
            const copyBtn = nodeElement.querySelector('.copy-image-btn');
            const downloadBtn = nodeElement.querySelector('.download-image-btn');

            if (copyBtn) {
                copyBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await this.copyImageToClipboard(imageUrl, copyBtn);
                });
            }

            if (downloadBtn) {
                downloadBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.downloadImage(imageUrl);
                });
            }
        }

        // 复制图片到剪贴板
        async copyImageToClipboard(imageUrl, button) {
            if (!imageUrl || imageUrl === window.location.href) {
                console.warn('ExecutionEngine: No valid image to copy.');
                this.showButtonFeedback(button, '无效图片', 'error');
                return;
            }

            const originalButtonHTML = button.innerHTML;
            try {
                const response = await fetch(imageUrl);
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                let blob = await response.blob();
                let finalBlobType = blob.type || 'image/png';

                // 如果是JPEG，转换为PNG以确保剪贴板兼容性
                if (blob.type === 'image/jpeg' || blob.type === 'image/jpg') {
                    console.log('ExecutionEngine: Converting JPEG to PNG for clipboard.');
                    try {
                        const imageBitmap = await createImageBitmap(blob);
                        const canvas = document.createElement('canvas');
                        canvas.width = imageBitmap.width;
                        canvas.height = imageBitmap.height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(imageBitmap, 0, 0);
                        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                        finalBlobType = 'image/png';
                    } catch (conversionError) {
                        console.error('ExecutionEngine: Failed to convert JPEG to PNG -', conversionError);
                    }
                }

                const item = new ClipboardItem({ [finalBlobType]: blob });
                await navigator.clipboard.write([item]);
                console.log('ExecutionEngine: Image copied to clipboard as', finalBlobType);

                this.showButtonFeedback(button, `
                    <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: currentColor;">
                        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"></path>
                    </svg>
                `, 'success');

            } catch (err) {
                console.error('ExecutionEngine: Failed to copy image -', err);
                this.showButtonFeedback(button, '复制失败', 'error');
            }

            // 恢复原始按钮内容
            setTimeout(() => {
                button.innerHTML = originalButtonHTML;
            }, 2000);
        }

        // 下载图片
        downloadImage(imageUrl) {
            if (!imageUrl || imageUrl === window.location.href) {
                console.warn('ExecutionEngine: No valid image to download.');
                return;
            }

            try {
                const link = document.createElement('a');
                link.href = imageUrl;

                // 从URL中提取文件名
                let filename = 'downloaded_image';
                const urlFilename = imageUrl.substring(imageUrl.lastIndexOf('/') + 1).split('?')[0];
                const urlExtensionMatch = urlFilename.match(/\.(jpe?g|png|gif|webp|svg)$/i);

                if (urlExtensionMatch) {
                    filename = urlFilename;
                } else {
                    filename += '.png'; // 默认扩展名
                }

                link.download = filename;
                link.style.display = 'none';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);

                console.log('ExecutionEngine: Image download initiated:', filename);
            } catch (err) {
                console.error('ExecutionEngine: Failed to download image -', err);
            }
        }

        // 显示按钮反馈
        showButtonFeedback(button, content, type) {
            const originalContent = button.innerHTML;
            button.innerHTML = content;

            if (type === 'success') {
                button.style.background = 'rgba(0,128,0,0.8)';
            } else if (type === 'error') {
                button.style.background = 'rgba(255,0,0,0.8)';
            }

            setTimeout(() => {
                button.innerHTML = originalContent;
                button.style.background = 'rgba(0,0,0,0.7)';
            }, 2000);
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

        // 传播输出数据 - 统一的数据传播机制
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
                const targetParam = output.connection?.targetParam || output.targetPort || 'input';
                console.log(`[ExecutionEngine] 目标节点 ${output.targetNodeId} 当前输入数据:`, targetInputData, `targetParam: ${targetParam}`);

                // Phase 3b: 统一的数据传播逻辑 + targetParam key 重映射
                if (result && typeof result === 'object') {
                    // 展开所有 key 到顶层（保持向后兼容）
                    Object.assign(targetInputData, result);
                    console.log(`[ExecutionEngine] 数据已展开:`, Object.keys(result));

                    // 关键修复：确保 targetParam 对应的 key 有值
                    // 如果展开后 targetParam 仍为 null/undefined，尝试从 result 中取最合适的值
                    if (targetInputData[targetParam] === undefined || targetInputData[targetParam] === null) {
                        const fallbackValue = result.output ?? result.result ?? result.text ?? result[Object.keys(result)[0]];
                        if (fallbackValue !== undefined && fallbackValue !== null) {
                            targetInputData[targetParam] = fallbackValue;
                            console.log(`[ExecutionEngine] targetParam 重映射: ${targetParam} = `, fallbackValue);
                        }
                    }
                } else {
                    // 非对象结果：直接赋给 targetParam
                    targetInputData[targetParam] = result;
                    console.log(`[ExecutionEngine] 非对象结果，赋给 ${targetParam}:`, result);
                }

                this.nodeInputData.set(output.targetNodeId, targetInputData);
                console.log(`[ExecutionEngine] 节点 ${output.targetNodeId} 更新后的输入数据:`, targetInputData);

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

        // 解析变量路径 - 统一的顶层查找机制
        _resolveVariablePath(path, inputData) {
            console.log(`[ExecutionEngine] 解析变量路径: ${path}`);
            console.log(`[ExecutionEngine] 可用输入数据:`, Object.keys(inputData));

            // 兼容模式：支持 input.xxx 格式（向后兼容）
            if (path.startsWith('input.')) {
                const actualPath = path.substring(6); // 移除 "input." 前缀
                console.log(`[ExecutionEngine] 兼容模式 - 实际路径: ${actualPath}`);
                return this._getNestedProperty(inputData, actualPath);
            }

            // 统一的顶层查找：所有数据都已展开到顶层，直接查找即可
            // 支持: imageBase64, imageUrl, result, extractedUrls, extractedUrls[0], result.field 等
            const resolvedData = this._getNestedProperty(inputData, path);

            if (resolvedData !== undefined) {
                console.log(`[ExecutionEngine] 顶层查找成功: ${path} ->`, resolvedData);
                return resolvedData;
            }

            console.warn(`[ExecutionEngine] 无法解析变量路径: ${path}`);
            return undefined;

        }
        // ========================================
        // Phase 3a: Loop 子图循环执行系统
        // ========================================

        // 统一插件返回格式为三层结构 {structured, text, raw}
        normalizePluginResult(rawResult) {
            // content 数组格式（新插件标准：AnySearch/DoubaoGen/GPTImageGen）
            if (rawResult?.result?.content && Array.isArray(rawResult.result.content)) {
                const textParts = rawResult.result.content
                    .filter(c => c.type === 'text')
                    .map(c => c.text);
                return {
                    structured: rawResult.result.content,
                    text: textParts.join('\n'),
                    raw: rawResult
                };
            }
            // original_plugin_output 包装（旧插件经 Plugin.js:1142 包装）
            if (rawResult?.original_plugin_output) {
                const text = typeof rawResult.original_plugin_output === 'string'
                    ? rawResult.original_plugin_output
                    : JSON.stringify(rawResult.original_plugin_output);
                return { structured: [{ type: 'text', text }], text, raw: rawResult };
            }
            // result 字段是字符串（中间态插件）
            if (rawResult?.result && typeof rawResult.result === 'string') {
                return { structured: [{ type: 'text', text: rawResult.result }], text: rawResult.result, raw: rawResult };
            }
            // 纯字符串
            if (typeof rawResult === 'string') {
                return { structured: [{ type: 'text', text: rawResult }], text: rawResult, raw: rawResult };
            }
            // 对象兜底（保持原有展开行为不破坏下游）
            return rawResult;
        }

        // LoopStart 节点执行入口
        async executeLoopStartNode(node, inputData) {
            // LoopStart 本身不做实质执行——真正的循环由 executeLoopFromStart 驱动
            // 这个方法只在循环体内部子图执行时被调用（注入循环变量）
            console.log(`[ExecutionEngine] LoopStart 节点 ${node.id} 被直接执行（子图内部注入模式）`);
            const loopContext = inputData.__loop || {};
            return {
                item: loopContext.item,
                index: loopContext.index,
                total: loopContext.total,
                accumulator: loopContext.accumulator,
                output: loopContext.item // 向下游传播当前迭代项
            };
        }

        // LoopEnd 节点执行入口
        async executeLoopEndNode(node, inputData) {
            console.log(`[ExecutionEngine] LoopEnd 节点 ${node.id} 执行，收集迭代结果`);
            // LoopEnd 收集循环体的最终输出
            // 优先取 input 字段，否则取第一个非空字段
            let output = inputData.input;
            if (output === undefined || output === null) {
                const keys = Object.keys(inputData).filter(k => k !== '__loop');
                if (keys.length > 0) {
                    output = inputData[keys[0]];
                }
            }
            return { output, loopEndResult: output };
        }

        // Variable Aggregator 节点执行
        async executeVariableAggregatorNode(node, inputData) {
            console.log(`[ExecutionEngine] 执行变量聚合器节点: ${node.id}`);
            const config = node.config || {};
            const strategy = config.strategy || 'firstNonNull';
            const mappings = config.mappings || [];

            let result = {};

            switch (strategy) {
                case 'firstNonNull': {
                    // 取所有输入中第一个非 null/undefined 的值
                    const keys = Object.keys(inputData);
                    for (const key of keys) {
                        if (inputData[key] !== null && inputData[key] !== undefined) {
                            result = inputData[key];
                            break;
                        }
                    }
                    break;
                }
                case 'merge': {
                    // 合并所有输入对象
                    for (const value of Object.values(inputData)) {
                        if (value && typeof value === 'object') {
                            Object.assign(result, value);
                        } else if (value !== null && value !== undefined) {
                            result.value = value;
                        }
                    }
                    break;
                }
                case 'array': {
                    // 将所有非空输入收集为数组
                    result = Object.values(inputData).filter(v => v !== null && v !== undefined);
                    break;
                }
            }

            // 应用映射表
            if (mappings.length > 0 && typeof result === 'object' && !Array.isArray(result)) {
                const mapped = {};
                for (const { inputKey, outputKey } of mappings) {
                    if (result[inputKey] !== undefined) {
                        mapped[outputKey] = result[inputKey];
                    }
                }
                result = mapped;
            }

            return { aggregated: result, output: result };
        }

        // 从 LoopStart 启动循环子图执行
        async executeLoopFromStart(loopStartId, executionGraph) {
            const loopStartGraphNode = executionGraph.get(loopStartId);
            const loopStartNode = loopStartGraphNode.node;
            const config = loopStartNode.config || {};
            const loopType = config.loopType || 'forEach';
            const maxIterations = config.maxIterations || 100;
            const iterationDelayMs = config.iterationDelayMs || 0;

            console.log(`[ExecutionEngine] === 循环子图执行开始 === 类型: ${loopType}, 最大迭代: ${maxIterations}`);

            // 1. 识别循环体
            const loopBody = this.identifyLoopBody(loopStartId, executionGraph);
            if (!loopBody) {
                throw new Error(`LoopStart 节点 ${loopStartId} 找不到配对的 LoopEnd`);
            }

            console.log(`[ExecutionEngine] 循环体: LoopEnd=${loopBody.loopEndId}, 中间节点=${loopBody.bodyNodeIds.length}个`);

            // 2. 获取 LoopStart 的输入数据
            const loopInputData = this.nodeInputData.get(loopStartId) || {};
            let inputValue = loopInputData.input;
            if (inputValue === undefined) {
                // 取第一个非空输入
                const keys = Object.keys(loopInputData);
                if (keys.length > 0) inputValue = loopInputData[keys[0]];
            }
            // 尝试将字符串解析为数组（contentInput 输出的是 JSON 字符串）
            if (typeof inputValue === 'string') {
                try {
                    const parsed = JSON.parse(inputValue);
                    if (Array.isArray(parsed)) {
                        inputValue = parsed;
                    }
                } catch (e) {
                    // 不是 JSON，保持原样
                }
            }

            // 3. 确定迭代列表
            let iterations = [];
            switch (loopType) {
                case 'forEach': {
                    if (Array.isArray(inputValue)) {
                        iterations = inputValue;
                    } else if (inputValue !== undefined && inputValue !== null) {
                        iterations = [inputValue];
                    }
                    break;
                }
                case 'times': {
                    const count = Math.min(parseInt(inputValue) || 1, maxIterations);
                    iterations = Array.from({ length: count }, (_, i) => i + 1);
                    break;
                }
                case 'while': {
                    // while 模式在迭代中动态判断，先创建一个初始空列表
                    iterations = null; // 标记为动态模式
                    break;
                }
            }

            // 4. 执行循环
            const results = [];
            let accumulator = null;
            const iterCount = iterations ? Math.min(iterations.length, maxIterations) : maxIterations;

            for (let i = 0; i < iterCount; i++) {
                const item = iterations ? iterations[i] : i + 1;

                console.log(`[ExecutionEngine] --- 迭代 ${i + 1}/${iterations ? iterations.length : '?'} ---`);

                // 构建循环变量
                const loopVars = {
                    item: item,
                    index: i,
                    total: iterations ? iterations.length : maxIterations,
                    accumulator: accumulator
                };

                // 执行子图
                const iterResult = await this.executeSubgraph(
                    loopBody.bodyNodeIds,
                    loopBody.loopEndId,
                    loopStartId,
                    loopVars,
                    loopInputData,
                    executionGraph
                );

                results.push(iterResult);
                accumulator = iterResult;

                // while 模式终止检查
                if (loopType === 'while') {
                    const condition = config.condition || '';
                    if (condition) {
                        try {
                            const shouldContinue = new Function('result', 'index', 'accumulator', `return ${condition}`)(iterResult, i, accumulator);
                            if (!shouldContinue) {
                                console.log(`[ExecutionEngine] while 循环条件不满足，终止于迭代 ${i + 1}`);
                                break;
                            }
                        } catch (e) {
                            console.warn(`[ExecutionEngine] while 条件评估失败: ${e.message}，终止循环`);
                            break;
                        }
                    } else {
                        // 无条件的 while = 执行 maxIterations 次
                    }
                }

                // 迭代间延迟
                if (iterationDelayMs > 0 && i < iterCount - 1) {
                    await new Promise(resolve => setTimeout(resolve, iterationDelayMs));
                }
            }

            console.log(`[ExecutionEngine] === 循环子图执行完成 === 共 ${results.length} 次迭代`);

            // 5. 标记循环体所有节点为已执行（防止主图重复执行）
            for (const bodyNodeId of loopBody.bodyNodeIds) {
                this.executedNodes.add(bodyNodeId);
            }
            this.executedNodes.add(loopBody.loopEndId);
            // Phase 3b 修复：让主图 areRequiredInputsReady 不再误判 loopEnd
            const loopEndInputData = this.nodeInputData.get(loopBody.loopEndId) || {};
            loopEndInputData.loopBody = 'completed_by_loop_engine';
            this.nodeInputData.set(loopBody.loopEndId, loopEndInputData);

            // 6. 将 LoopEnd 的汇总结果设置到 LoopEnd 节点的 nodeResults 中
            const loopEndResult = {
                output: results,
                items: results,
                count: results.length,
                lastAccumulator: accumulator
            };
            this.nodeResults.set(loopBody.loopEndId, loopEndResult);

            // 传播 LoopEnd 的输出到其下游
            const loopEndGraphNode = executionGraph.get(loopBody.loopEndId);
            if (loopEndGraphNode) {
                this.propagateOutputData(loopBody.loopEndId, loopEndGraphNode);
            }

            // 返回给 LoopStart 节点的结果（用于 LoopStart 自身的 propagate）
            return loopEndResult;
        }

        // 识别循环体：从 LoopStart 向下 BFS 直到 LoopEnd
        identifyLoopBody(loopStartId, executionGraph) {
            const loopStartGraphNode = executionGraph.get(loopStartId);
            if (!loopStartGraphNode) return null;

            const visited = new Set();
            const bodyNodeIds = [];
            let loopEndId = null;
            const queue = [];

            // 从 LoopStart 的直接下游开始 BFS
            for (const output of loopStartGraphNode.outputs) {
                queue.push(output.targetNodeId);
            }

            while (queue.length > 0) {
                const nodeId = queue.shift();
                if (visited.has(nodeId)) continue;
                visited.add(nodeId);

                const graphNode = executionGraph.get(nodeId);
                if (!graphNode) continue;

                // 找到 LoopEnd
                if (graphNode.node.pluginId === 'loopEnd') {
                    loopEndId = nodeId;
                    continue; // LoopEnd 不继续往下探索
                }

                bodyNodeIds.push(nodeId);

                // 继续向下游探索
                for (const output of graphNode.outputs) {
                    if (!visited.has(output.targetNodeId)) {
                        queue.push(output.targetNodeId);
                    }
                }
            }

            if (!loopEndId) {
                console.error(`[ExecutionEngine] LoopStart ${loopStartId} 找不到配对的 LoopEnd`);
                return null;
            }

            return { loopEndId, bodyNodeIds };
        }

        // 判断节点是否在某个循环体内部
        _isInsideLoopBody(nodeId, executionGraph) {
            // 向上游回溯，看是否能触达一个 loopStart
            const visited = new Set();
            const queue = [];

            const graphNode = executionGraph.get(nodeId);
            if (!graphNode) return false;

            // 自身是 loopStart 或 loopEnd 不算"内部"
            if (graphNode.node.pluginId === 'loopStart' || graphNode.node.pluginId === 'loopEnd') {
                return false;
            }

            for (const input of graphNode.inputs) {
                queue.push(input.sourceNodeId);
            }

            while (queue.length > 0) {
                const id = queue.shift();
                if (visited.has(id)) continue;
                visited.add(id);

                const gn = executionGraph.get(id);
                if (!gn) continue;

                if (gn.node.pluginId === 'loopStart') {
                    return true; // 上游有 LoopStart → 该节点在循环体内
                }

                // 继续向上游回溯（但不超过 loopEnd——避免跨循环判断）
                if (gn.node.pluginId === 'loopEnd') continue;

                for (const input of gn.inputs) {
                    if (!visited.has(input.sourceNodeId)) {
                        queue.push(input.sourceNodeId);
                    }
                }
            }

            return false;
        }

        // 执行子图（循环体内部的一次完整迭代）
        async executeSubgraph(bodyNodeIds, loopEndId, loopStartId, loopVars, parentInputData, executionGraph) {
            console.log(`[ExecutionEngine] 执行子图迭代: item=${JSON.stringify(loopVars.item)}, index=${loopVars.index}`);

            // 1. 为子图节点创建隔离的 inputData 上下文
            const subgraphInputData = new Map();

            // LoopStart 的输出 = 当前迭代变量
            const loopStartOutput = {
                item: loopVars.item,
                index: loopVars.index,
                total: loopVars.total,
                accumulator: loopVars.accumulator,
                output: loopVars.item,
                __loop: loopVars
            };

            // 初始化 LoopStart 直接下游节点的输入
            const loopStartGraphNode = executionGraph.get(loopStartId);
            for (const output of loopStartGraphNode.outputs) {
                const targetId = output.targetNodeId;
                if (bodyNodeIds.includes(targetId) || targetId === loopEndId) {
                    const existingInput = subgraphInputData.get(targetId) || {};
                    Object.assign(existingInput, loopStartOutput);
                    subgraphInputData.set(targetId, existingInput);
                }
            }

            // 2. 对子图进行简单拓扑排序（BFS 层级）
            const subgraphOrder = this._topologicalSortSubgraph(bodyNodeIds, loopEndId, loopStartId, executionGraph);

            // 3. 子图节点结果存储
            const subResults = new Map();
            subResults.set(loopStartId, loopStartOutput);

            // 4. 按顺序执行子图节点
            for (const nodeId of subgraphOrder) {
                const graphNode = executionGraph.get(nodeId);
                if (!graphNode) continue;

                // 收集输入：从子图结果中获取上游输出
                let nodeInput = subgraphInputData.get(nodeId) || {};

                // 从已执行的子图上游节点收集数据
                for (const input of graphNode.inputs) {
                    const sourceResult = subResults.get(input.sourceNodeId);
                    if (sourceResult) {
                        if (typeof sourceResult === 'object' && sourceResult !== null) {
                            Object.assign(nodeInput, sourceResult);
                        } else {
                            nodeInput.input = sourceResult;
                        }
                    }
                }

                // 注入 __loop 变量
                nodeInput.__loop = loopVars;

                // 暂存到全局 nodeInputData（executeNode 会读取）
                const originalInputData = this.nodeInputData.get(nodeId);
                this.nodeInputData.set(nodeId, nodeInput);

                try {
                    // 执行节点
                    await this.executeNode(graphNode.node);
                    const result = this.nodeResults.get(nodeId);
                    subResults.set(nodeId, result);

                    // 传播到子图内的下游
                    for (const output of graphNode.outputs) {
                        if (bodyNodeIds.includes(output.targetNodeId) || output.targetNodeId === loopEndId) {
                            const targetInput = subgraphInputData.get(output.targetNodeId) || {};
                            if (result && typeof result === 'object') {
                                Object.assign(targetInput, result);
                            }
                            subgraphInputData.set(output.targetNodeId, targetInput);
                        }
                    }
                } finally {
                    // 恢复原始 inputData（防止子图污染主图）
                    if (originalInputData !== undefined) {
                        this.nodeInputData.set(nodeId, originalInputData);
                    }
                }
            }

            // 5. 执行 LoopEnd 收集结果
            let loopEndInput = subgraphInputData.get(loopEndId) || {};
            const loopEndGraphNode = executionGraph.get(loopEndId);
            for (const input of loopEndGraphNode.inputs) {
                const sourceResult = subResults.get(input.sourceNodeId);
                if (sourceResult) {
                    if (typeof sourceResult === 'object' && sourceResult !== null) {
                        Object.assign(loopEndInput, sourceResult);
                    }
                }
            }
            loopEndInput.__loop = loopVars;

            // LoopEnd 提取最终输出
            let iterOutput = loopEndInput.output || loopEndInput.result;
            if (iterOutput === undefined) {
                const keys = Object.keys(loopEndInput).filter(k => k !== '__loop');
                if (keys.length > 0) iterOutput = loopEndInput[keys[0]];
            }

            console.log(`[ExecutionEngine] 子图迭代完成，输出:`, iterOutput);
            return iterOutput;
        }

        // 子图拓扑排序（简化版——只处理 bodyNodes + loopEnd）
        _topologicalSortSubgraph(bodyNodeIds, loopEndId, loopStartId, executionGraph) {
            const allIds = [...bodyNodeIds]; // 不包含 loopEnd（它在最后单独处理）
            const inDegree = new Map();
            const adjList = new Map();

            // 初始化
            for (const id of allIds) {
                inDegree.set(id, 0);
                adjList.set(id, []);
            }

            // 构建子图邻接表
            for (const id of allIds) {
                const graphNode = executionGraph.get(id);
                if (!graphNode) continue;
                for (const input of graphNode.inputs) {
                    if (input.sourceNodeId === loopStartId || allIds.includes(input.sourceNodeId)) {
                        if (input.sourceNodeId !== loopStartId) {
                            // 来自子图内部的上游
                            inDegree.set(id, (inDegree.get(id) || 0) + 1);
                            const adj = adjList.get(input.sourceNodeId) || [];
                            adj.push(id);
                            adjList.set(input.sourceNodeId, adj);
                        }
                        // 来自 LoopStart 的入度不计（它是子图入口）
                    }
                }
            }

            // Kahn 算法
            const queue = [];
            for (const [id, deg] of inDegree) {
                if (deg === 0) queue.push(id);
            }

            const sorted = [];
            while (queue.length > 0) {
                const id = queue.shift();
                sorted.push(id);
                const neighbors = adjList.get(id) || [];
                for (const neighbor of neighbors) {
                    inDegree.set(neighbor, inDegree.get(neighbor) - 1);
                    if (inDegree.get(neighbor) === 0) {
                        queue.push(neighbor);
                    }
                }
            }

            // 如果有节点未被排序（子图内有环——不应该发生），附加到末尾
            for (const id of allIds) {
                if (!sorted.includes(id)) {
                    console.warn(`[ExecutionEngine] 子图节点 ${id} 未被拓扑排序覆盖，强制追加`);
                    sorted.push(id);
                }
            }

            return sorted;
        }

        // ========================================
        // Phase 3b: 错误策略 - retry + fallback + maxConcurrency
        // ========================================

        // 包装 executeNode，施加节点级错误策略（retry / fallback）
        // 只对主图节点生效——循环子图内部走 executeNode 直连（保持简洁）
        async executeNodeWithPolicy(node, executionGraph) {
            const policy = node.config?.errorPolicy;

            // 无策略 / 字符串策略（旧的 'stop'|'continue'） → 直接执行不包装
            if (!policy || typeof policy !== 'object') {
                return await this.executeNode(node);
            }

            const policyType = policy.type || 'stop';

            // stop/continue 不需要 retry 包装——它们在 executeNodeChain 的 catch 里处理
            if (policyType === 'stop' || policyType === 'continue') {
                return await this.executeNode(node);
            }

            // === retry / fallback 策略 ===
            const maxRetries = Math.min(policy.maxRetries || 3, 10); // 硬上限 10 次防滥用
            const backoffMs = policy.backoffMs || 1000;
            const maxBackoffMs = policy.maxBackoffMs || 30000;
            const backoffMultiplier = policy.backoffMultiplier || 2;

            let lastError;

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    const result = await this.executeNode(node);
                    if (attempt > 0) {
                        console.log(`[ExecutionEngine] 节点 ${node.id} 第 ${attempt + 1} 次尝试成功（共尝试 ${attempt + 1}/${maxRetries + 1} 次）`);
                    }
                    return result;
                } catch (error) {
                    lastError = error;
                    console.warn(`[ExecutionEngine] 节点 ${node.id} 第 ${attempt + 1}/${maxRetries + 1} 次执行失败: ${error.message}`);

                    if (attempt < maxRetries) {
                        // 指数退避
                        const delay = Math.min(
                            backoffMs * Math.pow(backoffMultiplier, attempt),
                            maxBackoffMs
                        );
                        console.log(`[ExecutionEngine] 等待 ${delay}ms 后重试（退避: ${backoffMs}×${backoffMultiplier}^${attempt}）`);
                        this.updateNodeStatus(node.id, 'retrying');
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }

            // retry 全部耗尽——检查 fallback
            console.error(`[ExecutionEngine] 节点 ${node.id} 全部 ${maxRetries + 1} 次尝试均失败`);

            if (policyType === 'fallback' && policy.fallbackNodeId) {
                console.log(`[ExecutionEngine] 启动 fallback 分支: ${policy.fallbackNodeId}`);
                return await this.executeFallbackBranch(policy.fallbackNodeId, node, lastError, executionGraph);
            }

            // onExhausted 降级策略
            const onExhausted = policy.onExhausted || 'stop';
            if (onExhausted === 'continue') {
                console.warn(`[ExecutionEngine] 节点 ${node.id} 策略降级为 continue（不中断工作流）`);
                // 写入错误占位结果——让下游能感知到上游失败但不崩
                this.nodeResults.set(node.id, {
                    __status: 'error',
                    __error: lastError.message,
                    __retryExhausted: true,
                    text: `[ERROR after ${maxRetries + 1} attempts] ${lastError.message}`
                });
                this.updateNodeStatus(node.id, 'error');
                return; // 不抛出——工作流继续
            }

            // 默认 stop：抛出错误中断整个工作流
            throw lastError;
        }

        // Fallback 分支执行
        // fallback 节点必须已经存在于执行图中（画布上画了但平时不走的备用路径）
        async executeFallbackBranch(fallbackNodeId, originalNode, originalError, executionGraph, depth = 0) {
            // 链深度保护——防止 fallback 节点又 fallback 到其他节点无限递归
            if (depth >= 3) {
                console.error(`[ExecutionEngine] Fallback 链深度超过 3 层，强制中止`);
                throw new Error(`Fallback chain depth exceeded (max 3). Original error: ${originalError.message}`);
            }

            const fallbackGraphNode = executionGraph.get(fallbackNodeId);
            if (!fallbackGraphNode) {
                console.error(`[ExecutionEngine] Fallback 节点 ${fallbackNodeId} 不在执行图中`);
                throw new Error(`Fallback node ${fallbackNodeId} not found in execution graph. Original error: ${originalError.message}`);
            }
            
            // 在确认 fallbackGraphNode 非空之后再读它的属性
            const fallbackPolicy = fallbackGraphNode.node.config?.errorPolicy;

            console.log(`[ExecutionEngine] 执行 Fallback 分支 [深度=${depth}]: ${fallbackNodeId} (${fallbackGraphNode.node.name})`);

            // 注入错误上下文——让 fallback 节点知道"为什么被调用"
            const fallbackInput = this.nodeInputData.get(fallbackNodeId) || {};
            fallbackInput.__originalError = {
                nodeId: originalNode.id,
                nodeName: originalNode.name,
                error: originalError.message,
                timestamp: new Date().toISOString()
            };
            // 同时继承原节点的输入——fallback 节点可能需要相同的数据来"换一种方式处理"
            const originalInput = this.nodeInputData.get(originalNode.id) || {};
            Object.assign(fallbackInput, originalInput);
            delete fallbackInput.__originalError; // 先删再加，保证在最外层
            fallbackInput.__originalError = {
                nodeId: originalNode.id,
                nodeName: originalNode.name,
                error: originalError.message,
                timestamp: new Date().toISOString()
            };
            this.nodeInputData.set(fallbackNodeId, fallbackInput);

            try {
                if (fallbackPolicy && typeof fallbackPolicy === 'object' && (fallbackPolicy.type === 'retry' || fallbackPolicy.type === 'fallback')) {
                    await this.executeNodeWithPolicy(fallbackGraphNode.node, executionGraph);
                } else {
                    await this.executeNode(fallbackGraphNode.node);
                }

                const result = this.nodeResults.get(fallbackNodeId);

                // 关键：fallback 结果回写到原始节点——下游透明消费，不知道走了备用分支
                this.nodeResults.set(originalNode.id, result);
                this.updateNodeStatus(originalNode.id, 'success');
                this.executedNodes.add(fallbackNodeId);

                console.log(`[ExecutionEngine] Fallback 成功，结果回写给原始节点 ${originalNode.id}`);
                return result;

            } catch (fallbackError) {
                console.error(`[ExecutionEngine] Fallback 分支执行失败:`, fallbackError.message);

                // fallback 的 fallback？检查它自己有没有 fallback 配置
                const fallbackFallbackId = fallbackPolicy?.fallbackNodeId;
                if (fallbackFallbackId && fallbackFallbackId !== fallbackNodeId) {
                    return await this.executeFallbackBranch(fallbackFallbackId, originalNode, fallbackError, executionGraph, depth + 1);
                }

                // 没有更多备用分支——检查 onExhausted
                const onExhausted = (fallbackPolicy?.onExhausted) || (originalNode.config?.errorPolicy?.onExhausted) || 'stop';
                if (onExhausted === 'continue') {
                    console.warn(`[ExecutionEngine] Fallback 也失败，策略降级为 continue`);
                    this.nodeResults.set(originalNode.id, {
                        __status: 'error',
                        __error: fallbackError.message,
                        __fallbackFailed: true,
                        text: `[FALLBACK FAILED] ${fallbackError.message}`
                    });
                    this.updateNodeStatus(originalNode.id, 'error');
                    return;
                }

                throw fallbackError;
            }
        }


        // executeFromJson 地基函数（Phase 4 WorkflowRunner 预留）
        async executeFromJson(workflowJson, inputOverrides = {}) {

            console.log('[ExecutionEngine] executeFromJson 被调用（地基函数）');

            // 反序列化节点和连接
            const nodes = workflowJson.nodes || [];
            const connections = workflowJson.connections || [];

            // 应用输入覆盖到 contentInput 节点
            if (inputOverrides && Object.keys(inputOverrides).length > 0) {
                for (const node of nodes) {
                    if (node.pluginId === 'contentInput' && inputOverrides[node.id]) {
                        node.config = node.config || {};
                        node.config.content = inputOverrides[node.id];
                    }
                }
            }

            // 构建执行图
            const executionGraph = this.buildExecutionGraph(nodes, connections);
            const startNodes = this.findStartNodes(nodes, connections);

            if (startNodes.length === 0) {
                throw new Error('executeFromJson: 未找到起始节点');
            }

            // 初始化
            this.nodeResults.clear();
            this.nodeInputData.clear();
            this.executedNodes.clear();
            this.executingNodes.clear();
            this.initializeNodeInputData(nodes);

            // 执行
            await this.executeNodeChain(startNodes[0], executionGraph);

            // 收集结果
            return {
                success: true,
                results: Object.fromEntries(this.nodeResults),
                executedCount: this.executedNodes.size
            };
        }

    }

    // 导出为全局单例
    window.WorkflowEditor_ExecutionEngine = WorkflowEditor_ExecutionEngine.getInstance();
})();