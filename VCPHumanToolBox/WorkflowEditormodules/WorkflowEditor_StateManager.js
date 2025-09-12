// WorkflowEditor State Manager Module
(function() {
    'use strict';

    class WorkflowEditor_StateManager {
        constructor() {
            if (WorkflowEditor_StateManager.instance) {
                return WorkflowEditor_StateManager.instance;
            }
            
            this.state = {
                // 工作流基本信息
                workflowName: '未命名工作流',
                workflowId: null,
                
                // 画布状态
                canvasOffset: { x: 0, y: 0 },
                canvasZoom: 1,
                
                // 节点和连接
                nodes: new Map(),
                connections: new Map(),
                
                // 选择状态
                selectedNodes: new Set(),
                selectedConnections: new Set(),
                
                // 可用插件
                availablePlugins: {
                    vcpChat: [],
                    vcpToolBox: [],
                    auxiliary: []
                },
                
                // 执行状态
                isExecuting: false,
                executionHistory: [],
                
                // UI状态
                isVisible: false,
                activePropertyPanel: null,

                // 撤销/重做历史
                undoStack: [],
                redoStack: []
            };
            
            this.listeners = new Map();
            this.nodeIdCounter = 1;
            this.connectionIdCounter = 1;
            
            WorkflowEditor_StateManager.instance = this;
        }

        static getInstance() {
            if (!WorkflowEditor_StateManager.instance) {
                WorkflowEditor_StateManager.instance = new WorkflowEditor_StateManager();
            }
            return WorkflowEditor_StateManager.instance;
        }

        // 状态监听器
        on(event, callback) {
            if (!this.listeners.has(event)) {
                this.listeners.set(event, new Set());
            }
            this.listeners.get(event).add(callback);
        }

        off(event, callback) {
            if (this.listeners.has(event)) {
                this.listeners.get(event).delete(callback);
            }
        }

        emit(event, data) {
            if (this.listeners.has(event)) {
                this.listeners.get(event).forEach(callback => {
                    try {
                        callback(data);
                    } catch (error) {
                        console.error(`Error in event listener for ${event}:`, error);
                    }
                });
            }
        }

        // 基本状态操作
        get(key) {
            return this.state[key];
        }

        set(key, value) {
            const oldValue = this.state[key];
            this.state[key] = value;
            this.emit('stateChanged', { key, value, oldValue });
            this.emit(`${key}Changed`, { value, oldValue });
        }

        // 工作流操作
        setWorkflowName(name) {
            this.set('workflowName', name);
        }

        getWorkflowName() {
            return this.get('workflowName');
        }

        // 画布操作
        setCanvasOffset(offset) {
            this.set('canvasOffset', offset);
        }

        getCanvasOffset() {
            return this.get('canvasOffset');
        }

        setCanvasZoom(zoom) {
            this.set('canvasZoom', Math.max(0.1, Math.min(3, zoom)));
        }

        getCanvasZoom() {
            return this.get('canvasZoom');
        }

        // 节点操作
        addNode(nodeData, recordHistory = true) {
            const newNode = this._addNode(nodeData); // 先添加节点，获取其最终ID
            if (recordHistory) {
                this.recordAction({
                    type: 'addNode',
                    data: { node: newNode } // 记录完整的节点对象，包含其生成的ID
                });
            }
            return newNode;
        }

        _addNode(nodeData) {
            const nodeId = nodeData.id || `node_${this.nodeIdCounter++}`;
            const node = {
                id: nodeId,
                type: nodeData.type,
                name: nodeData.name,
                position: nodeData.position || { x: 100, y: 100 },
                config: nodeData.config || {},
                inputs: nodeData.inputs || [],
                outputs: nodeData.outputs || [],
                status: 'idle', // idle, running, success, error
                ...nodeData
            };
            
            this.state.nodes.set(nodeId, node);
            this.emit('nodeAdded', node);
            return node;
        }

        removeNode(nodeId, recordHistory = true) {
            const node = this.state.nodes.get(nodeId);
            if (!node) return false;

            if (recordHistory) {
                // 在记录操作前，先收集所有相关连接，因为它们也会被删除
                const connectionsToRemove = [];
                this.state.connections.forEach((connection, connectionId) => {
                    if (connection.sourceNodeId === nodeId || connection.targetNodeId === nodeId) {
                        connectionsToRemove.push(connection);
                    }
                });
                this.recordAction({
                    type: 'removeNode',
                    data: { nodeId, node, connectionsToRemove }
                });
            }
            return this._removeNode(nodeId);
        }

        _removeNode(nodeId) {
            const node = this.state.nodes.get(nodeId);
            if (!node) return false;

            // 移除相关连接 (不记录历史，因为父操作已经记录)
            const connectionsToRemove = [];
            this.state.connections.forEach((connection, connectionId) => {
                if (connection.sourceNodeId === nodeId || connection.targetNodeId === nodeId) {
                    connectionsToRemove.push(connectionId);
                }
            });
            
            connectionsToRemove.forEach(connectionId => {
                this._removeConnection(connectionId); // 使用内部方法，不记录历史
            });

            // 移除节点
            this.state.nodes.delete(nodeId);
            this.state.selectedNodes.delete(nodeId);
            this.emit('nodeRemoved', { nodeId, node });
            return true;
        }

        updateNode(nodeId, updates) {
            const node = this.state.nodes.get(nodeId);
            if (!node) return false;

            const updatedNode = { ...node, ...updates };
            this.state.nodes.set(nodeId, updatedNode);
            this.emit('nodeUpdated', { nodeId, node: updatedNode, updates });
            return true;
        }

        getNode(nodeId) {
            return this.state.nodes.get(nodeId);
        }

        getAllNodes() {
            return Array.from(this.state.nodes.values());
        }

        // 连接操作
        addConnection(connectionData, skipRender = false, recordHistory = true) {
            if (recordHistory) {
                this.recordAction({
                    type: 'addConnection',
                    data: { connectionData, skipRender }
                });
            }
            return this._addConnection(connectionData, skipRender);
        }

        _addConnection(connectionData, skipRender = false) {
            const existingConnection = Array.from(this.state.connections.values()).find(conn =>
                conn.sourceNodeId === connectionData.sourceNodeId &&
                conn.targetNodeId === connectionData.targetNodeId &&
                conn.targetParam === connectionData.targetParam
            );

            if (existingConnection) {
                console.warn('[StateManager] Connection already exists:', existingConnection);
                return existingConnection;
            }

            if (!this.state.nodes.has(connectionData.sourceNodeId) || !this.state.nodes.has(connectionData.targetNodeId)) {
                console.error(`[StateManager] Source or target node not found for connection.`);
                return null;
            }

            const connectionId = connectionData.id || `connection_${this.connectionIdCounter++}`;
            const connection = { id: connectionId, ...connectionData };

            this.state.connections.set(connectionId, connection);
            console.log('[StateManager] Connection added:', connection);

            if (!skipRender) {
                this.emit('connectionAdded', connection);
            }
            return connection;
        }

        removeConnection(connectionId, recordHistory = true) {
            const connection = this.state.connections.get(connectionId);
            if (!connection) {
                console.warn('[StateManager] Connection not found for removal:', connectionId);
                return false;
            }
            if (recordHistory) {
                this.recordAction({
                    type: 'removeConnection',
                    data: { connectionId, connection }
                });
            }
            return this._removeConnection(connectionId);
        }

        _removeConnection(connectionId) {
            const connection = this.state.connections.get(connectionId);
            if (!connection) return false;

            this.state.connections.delete(connectionId);
            this.state.selectedConnections.delete(connectionId);
            console.log('[StateManager] Connection removed from state:', connectionId);

            this.emit('connectionRemoved', { connectionId, connection });
            return true;
        }

        getConnection(connectionId) {
            return this.state.connections.get(connectionId);
        }

        getAllConnections() {
            return Array.from(this.state.connections.values());
        }

        // 选择操作
        selectNode(nodeId, multiSelect = false) {
            if (!multiSelect) {
                this.state.selectedNodes.clear();
            }
            this.state.selectedNodes.add(nodeId);
            this.emit('selectionChanged', {
                selectedNodes: Array.from(this.state.selectedNodes),
                selectedConnections: Array.from(this.state.selectedConnections)
            });
        }

        deselectNode(nodeId) {
            this.state.selectedNodes.delete(nodeId);
            this.emit('selectionChanged', {
                selectedNodes: Array.from(this.state.selectedNodes),
                selectedConnections: Array.from(this.state.selectedConnections)
            });
        }

        clearSelection() {
            this.state.selectedNodes.clear();
            this.state.selectedConnections.clear();
            this.emit('selectionChanged', {
                selectedNodes: [],
                selectedConnections: []
            });
        }

        getSelectedNodes() {
            return Array.from(this.state.selectedNodes);
        }

        // 历史记录操作 (Undo/Redo)
        recordAction(action) {
            this.state.undoStack.push(action);
            this.state.redoStack = []; // 清空重做栈
            this.emit('historyChanged', {
                undoCount: this.state.undoStack.length,
                redoCount: this.state.redoStack.length
            });
        }

        undo() {
            if (this.state.undoStack.length === 0) return;

            const action = this.state.undoStack.pop();
            this.state.redoStack.push(action);

            switch (action.type) {
                case 'addConnection':
                    // 撤销添加，即删除
                    const connection = Array.from(this.state.connections.values()).find(c => 
                        c.sourceNodeId === action.data.connectionData.sourceNodeId &&
                        c.targetNodeId === action.data.connectionData.targetNodeId &&
                        c.targetParam === action.data.connectionData.targetParam
                    );
                    if (connection) {
                        this._removeConnection(connection.id);
                    }
                    break;
                case 'removeConnection':
                    // 撤销删除，即重新添加
                    this._addConnection(action.data.connection, false);
                    break;
                case 'addNode':
                    // 撤销添加节点，即删除节点
                    this._removeNode(action.data.node.id); // 使用记录的完整节点对象中的ID
                    break;
                case 'removeNode':
                    // 撤销删除节点，即重新添加节点及其相关连接
                    this._addNode(action.data.node, false); // 重新添加节点
                    action.data.connectionsToRemove.forEach(conn => {
                        this._addConnection(conn, false); // 重新添加相关连接
                    });
                    break;
            }
            
            this.emit('historyChanged', {
                undoCount: this.state.undoStack.length,
                redoCount: this.state.redoStack.length
            });
            console.log('[StateManager] Undo performed:', action.type);
        }

        redo() {
            if (this.state.redoStack.length === 0) return;

            const action = this.state.redoStack.pop();
            this.state.undoStack.push(action);

            switch (action.type) {
                case 'addConnection':
                    // 重做添加
                    this._addConnection(action.data.connectionData, action.data.skipRender);
                    break;
                case 'removeConnection':
                    // 重做删除
                    this._removeConnection(action.data.connectionId);
                    break;
                case 'addNode':
                    // 重做添加节点
                    this._addNode(action.data.node); // 使用记录的完整节点对象
                    break;
                case 'removeNode':
                    // 重做删除节点及其相关连接
                    this._removeNode(action.data.nodeId);
                    break;
            }

            this.emit('historyChanged', {
                undoCount: this.state.undoStack.length,
                redoCount: this.state.redoStack.length
            });
            console.log('[StateManager] Redo performed:', action.type);
        }

        // 可用插件管理
        setAvailablePlugins(category, plugins) {
            this.state.availablePlugins[category] = plugins;
            this.emit('availablePluginsChanged', { category, plugins });
        }

        getAvailablePlugins(category) {
            return this.state.availablePlugins[category] || [];
        }

        getAllAvailablePlugins() {
            return this.state.availablePlugins;
        }

        // 工作流序列化
        serialize() {
            const nodes = {};
            this.state.nodes.forEach((node, id) => {
                // 复制节点数据，但排除图片上传器的base64数据
                const nodeData = { ...node };
                
                // 如果是图片上传节点，移除base64数据以减小文件大小
                if (node.type === 'imageUpload' || node.pluginId === 'imageUpload' || 
                    (node.type === 'auxiliary' && node.pluginId === 'imageUpload')) {
                    
                    // 移除base64数据，但保留文件名等元信息
                    if (nodeData.uploadedImage) {
                        nodeData.uploadedImage = {
                            ...nodeData.uploadedImage,
                            base64Data: null // 清除base64数据
                        };
                    }
                    
                    // 也清除旧格式的base64数据
                    if (nodeData.uploadedImageData) {
                        delete nodeData.uploadedImageData;
                    }
                    
                    console.log(`[StateManager] Excluded base64 data from image upload node: ${id}`);
                }
                
                nodes[id] = nodeData;
            });

            const connections = {};
            this.state.connections.forEach((connection, id) => {
                connections[id] = { ...connection };
            });

            return {
                version: '1.0',
                name: this.state.workflowName,
                id: this.state.workflowId,
                canvas: {
                    offset: this.state.canvasOffset,
                    zoom: this.state.canvasZoom
                },
                nodes,
                connections,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
        }

        // 工作流反序列化
        deserialize(data) {
            try {
                console.log('[StateManager] Starting workflow deserialization:', data);
                
                // 清空当前状态
                this.state.nodes.clear();
                this.state.connections.clear();
                this.clearSelection();

                // 恢复基本信息
                this.state.workflowName = data.name || '未命名工作流';
                this.state.workflowId = data.id || null;

                // 恢复画布状态
                if (data.canvas) {
                    this.state.canvasOffset = data.canvas.offset || { x: 0, y: 0 };
                    this.state.canvasZoom = data.canvas.zoom || 1;
                }

                // 恢复节点 - 先加载节点数据到状态中
                if (data.nodes) {
                    console.log('[StateManager] Loading nodes:', Object.keys(data.nodes));
                    Object.entries(data.nodes).forEach(([id, nodeData]) => {
                        // 对图片上传节点进行特殊处理
                        if (nodeData.type === 'imageUpload' || nodeData.pluginId === 'imageUpload' || 
                            (nodeData.type === 'auxiliary' && nodeData.pluginId === 'imageUpload')) {
                            
                            // 如果图片上传节点没有base64数据，设置为未上传状态
                            if (nodeData.uploadedImage && !nodeData.uploadedImage.base64Data) {
                                console.log(`[StateManager] Image upload node ${id} loaded without base64 data, setting to empty state`);
                                // 清除上传状态，让节点显示为未上传状态
                                delete nodeData.uploadedImage;
                                delete nodeData.uploadedImageData;
                                delete nodeData.uploadedFileName;
                            }
                        }
                        
                        this.state.nodes.set(id, nodeData);
                    });
                }

                // 恢复连接 - 先加载连接数据到状态中
                if (data.connections) {
                    console.log('[StateManager] Loading connections:', Object.keys(data.connections));
                    Object.entries(data.connections).forEach(([id, connectionData]) => {
                        this.state.connections.set(id, connectionData);
                    });
                }

                // 更新计数器
                this.updateCounters();

                // 发出工作流加载事件，延迟确保所有节点都已渲染
                setTimeout(() => {
                    this.emit('workflowLoaded', data);
                    
                    // 恢复节点的动态输入参数
                    Object.entries(data.nodes).forEach(([id, nodeData]) => {
                        if (nodeData.dynamicInputs && Array.isArray(nodeData.dynamicInputs) && nodeData.dynamicInputs.length > 0) {
                            console.log('[StateManager] Restoring dynamic inputs for node:', id, nodeData.dynamicInputs);
                            // 通知画布管理器更新节点输入
                            if (window.WorkflowEditor_CanvasManager && window.WorkflowEditor_CanvasManager.updateNodeInputs) {
                                window.WorkflowEditor_CanvasManager.updateNodeInputs(id, nodeData.dynamicInputs);
                            }
                        }
                    });
                }, 100);
                
                console.log('[StateManager] Workflow deserialization completed successfully');
                return true;
            } catch (error) {
                console.error('[StateManager] Failed to deserialize workflow:', error);
                return false;
            }
        }

        // 更新ID计数器
        updateCounters() {
            let maxNodeId = 0;
            let maxConnectionId = 0;

            this.state.nodes.forEach((node, id) => {
                const match = id.match(/node_(\d+)/);
                if (match) {
                    maxNodeId = Math.max(maxNodeId, parseInt(match[1]));
                }
            });

            this.state.connections.forEach((connection, id) => {
                const match = id.match(/connection_(\d+)/);
                if (match) {
                    maxConnectionId = Math.max(maxConnectionId, parseInt(match[1]));
                }
            });

            this.nodeIdCounter = maxNodeId + 1;
            this.connectionIdCounter = maxConnectionId + 1;
        }

        // 执行状态管理
        setExecutionState(isExecuting) {
            this.set('isExecuting', isExecuting);
        }

        isExecuting() {
            return this.get('isExecuting');
        }

        setNodeStatus(nodeId, status) {
            const node = this.state.nodes.get(nodeId);
            if (node) {
                node.status = status;
                this.emit('nodeStatusChanged', { nodeId, status });
            }
        }

        // 工作流验证
        validateWorkflow() {
            const errors = [];
            const warnings = [];

            // 检查是否有节点
            if (this.state.nodes.size === 0) {
                errors.push('工作流中没有节点');
                return { valid: false, errors, warnings };
            }

            // 检查节点配置
            this.state.nodes.forEach((node, nodeId) => {
                if (!node.name || node.name.trim() === '') {
                    errors.push(`节点 ${nodeId} 缺少名称`);
                }

                // 检查必需的配置项
                if (node.type === 'plugin' && !node.config.pluginId) {
                    errors.push(`插件节点 ${nodeId} 缺少插件ID配置`);
                }
            });

            // 检查连接
            this.state.connections.forEach((connection, connectionId) => {
                const sourceNode = this.state.nodes.get(connection.sourceNodeId);
                const targetNode = this.state.nodes.get(connection.targetNodeId);

                if (!sourceNode) {
                    errors.push(`连接 ${connectionId} 的源节点不存在`);
                }

                if (!targetNode) {
                    errors.push(`连接 ${connectionId} 的目标节点不存在`);
                }
            });

            // 检查循环依赖
            if (this.hasCircularDependency()) {
                errors.push('工作流存在循环依赖');
            }

            return {
                valid: errors.length === 0,
                errors,
                warnings
            };
        }

        // 检查循环依赖
        hasCircularDependency() {
            const visited = new Set();
            const recursionStack = new Set();

            const dfs = (nodeId) => {
                if (recursionStack.has(nodeId)) {
                    return true; // 发现循环
                }

                if (visited.has(nodeId)) {
                    return false;
                }

                visited.add(nodeId);
                recursionStack.add(nodeId);

                // 获取所有从当前节点出发的连接
                const outgoingConnections = Array.from(this.state.connections.values())
                    .filter(conn => conn.sourceNodeId === nodeId);

                for (const connection of outgoingConnections) {
                    if (dfs(connection.targetNodeId)) {
                        return true;
                    }
                }

                recursionStack.delete(nodeId);
                return false;
            };

            // 检查所有节点
            for (const nodeId of this.state.nodes.keys()) {
                if (!visited.has(nodeId)) {
                    if (dfs(nodeId)) {
                        return true;
                    }
                }
            }

            return false;
        }

        // 获取执行顺序
        getExecutionOrder() {
            const inDegree = new Map();
            const adjList = new Map();

            // 初始化
            this.state.nodes.forEach((node, nodeId) => {
                inDegree.set(nodeId, 0);
                adjList.set(nodeId, []);
            });

            // 构建图
            this.state.connections.forEach(connection => {
                const source = connection.sourceNodeId;
                const target = connection.targetNodeId;

                adjList.get(source).push(target);
                inDegree.set(target, inDegree.get(target) + 1);
            });

            // 拓扑排序
            const queue = [];
            const result = [];

            // 找到所有入度为0的节点
            inDegree.forEach((degree, nodeId) => {
                if (degree === 0) {
                    queue.push(nodeId);
                }
            });

            while (queue.length > 0) {
                const current = queue.shift();
                result.push(current);

                // 处理相邻节点
                adjList.get(current).forEach(neighbor => {
                    inDegree.set(neighbor, inDegree.get(neighbor) - 1);
                    if (inDegree.get(neighbor) === 0) {
                        queue.push(neighbor);
                    }
                });
            }

            // 如果结果长度不等于节点数量，说明有循环依赖
            if (result.length !== this.state.nodes.size) {
                return null;
            }

            return result;
        }

        // 重置状态
        reset() {
            this.state.undoStack = [];
            this.state.redoStack = [];
            this.state.nodes.clear();
            this.state.connections.clear();
            this.clearSelection();
            this.state.workflowName = '未命名工作流';
            this.state.workflowId = null;
            this.state.canvasOffset = { x: 0, y: 0 };
            this.state.canvasZoom = 1;
            this.state.isExecuting = false;
            this.nodeIdCounter = 1;
            this.connectionIdCounter = 1;
            this.emit('workflowReset');
        }

        // 获取统计信息
        getStats() {
            return {
                nodeCount: this.state.nodes.size,
                connectionCount: this.state.connections.size,
                selectedNodeCount: this.state.selectedNodes.size,
                selectedConnectionCount: this.state.selectedConnections.size
            };
        }
    }

    // 导出为全局单例
    window.WorkflowEditor_StateManager = WorkflowEditor_StateManager.getInstance();
})();