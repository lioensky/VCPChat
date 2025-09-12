// 连线状态管理器 - 统一管理工作流连线状态
// 解决连线状态在保存、加载、执行时不一致的问题

(function() {
    'use strict';

    class WorkflowEditor_ConnectionManager {
        constructor() {
            this.connections = new Map(); // 连线数据存储
            this.listeners = new Map(); // 事件监听器
            this.isInitialized = false;
            
            console.log('[ConnectionManager] 连线管理器已创建');
        }

        // 初始化连线管理器
        initialize(stateManager, canvasManager) {
            if (this.isInitialized) {
                console.warn('[ConnectionManager] 已经初始化过了');
                return;
            }

            this.stateManager = stateManager;
            this.canvasManager = canvasManager;
            this.isInitialized = true;

            // 监听 StateManager 的连线事件
            if (stateManager) {
                console.log('[ConnectionManager] 设置 StateManager 事件监听');
                stateManager.on('connectionAdded', (connection) => {
                    console.log('[ConnectionManager] 收到 StateManager connectionAdded 事件:', connection);
                    this.onStateConnectionAdded(connection);
                });

                stateManager.on('connectionRemoved', (data) => {
                    console.log('[ConnectionManager] 收到 StateManager connectionRemoved 事件:', data);
                    this.onStateConnectionRemoved(data.connectionId, data.connection);
                });
            } else {
                console.warn('[ConnectionManager] StateManager 不可用，无法设置事件监听');
            }

            // 监听 CanvasManager 的连线事件
            if (canvasManager && canvasManager.jsPlumbInstance) {
                canvasManager.jsPlumbInstance.bind('connection', (info) => {
                    this.onCanvasConnectionCreated(info);
                });

                canvasManager.jsPlumbInstance.bind('connectionDetached', (info) => {
                    this.onCanvasConnectionDetached(info);
                });
            }

            console.log('[ConnectionManager] 初始化完成');
        }

        // 添加连线（统一入口）
        addConnection(connectionData, options = {}) {
            const { 
                skipStateUpdate = false, 
                skipCanvasUpdate = false, 
                skipValidation = false 
            } = options;

            console.log('[ConnectionManager] 添加连线:', connectionData);

            // 验证连线数据
            if (!skipValidation && !this.validateConnection(connectionData)) {
                console.error('[ConnectionManager] 连线数据验证失败:', connectionData);
                return null;
            }

            // 生成连线ID
            const connectionId = connectionData.id || this.generateConnectionId();
            const connection = {
                id: connectionId,
                sourceNodeId: connectionData.sourceNodeId,
                targetNodeId: connectionData.targetNodeId,
                sourcePort: connectionData.sourcePort || 'output',
                targetPort: connectionData.targetPort || 'input',
                targetParam: connectionData.targetParam || 'input',
                timestamp: new Date().toISOString(),
                ...connectionData
            };

            // 检查是否已存在相同连线
            if (this.hasConnection(connection)) {
                console.warn('[ConnectionManager] 连线已存在，跳过添加');
                return this.getExistingConnection(connection);
            }

            // 保存到内部存储
            this.connections.set(connectionId, connection);

            // 同步到 StateManager
            if (!skipStateUpdate && this.stateManager) {
                this.stateManager._addConnection(connection, true); // skipRender = true
            }

            // 同步到 CanvasManager
            if (!skipCanvasUpdate && this.canvasManager) {
                this.createCanvasConnection(connection);
            }

            // 触发事件
            this.emit('connectionAdded', connection);

            console.log('[ConnectionManager] 连线添加成功:', connectionId);
            return connection;
        }

        // 移除连线（统一入口）
        removeConnection(connectionId, options = {}) {
            const { 
                skipStateUpdate = false, 
                skipCanvasUpdate = false 
            } = options;

            console.log('[ConnectionManager] 移除连线:', connectionId);

            const connection = this.connections.get(connectionId);
            if (!connection) {
                console.warn('[ConnectionManager] 连线不存在:', connectionId);
                return false;
            }

            // 从内部存储移除
            this.connections.delete(connectionId);

            // 从 StateManager 移除
            if (!skipStateUpdate && this.stateManager) {
                this.stateManager._removeConnection(connectionId);
            }

            // 从 CanvasManager 移除
            if (!skipCanvasUpdate && this.canvasManager) {
                this.removeCanvasConnection(connectionId);
            }

            // 触发事件
            this.emit('connectionRemoved', { connectionId, connection });

            console.log('[ConnectionManager] 连线移除成功:', connectionId);
            return true;
        }

        // 获取所有连线
        getAllConnections() {
            return Array.from(this.connections.values());
        }

        // 获取单个连线
        getConnection(connectionId) {
            return this.connections.get(connectionId);
        }

        // 清空所有连线
        clearAllConnections() {
            console.log('[ConnectionManager] 清空所有连线');
            
            const connectionIds = Array.from(this.connections.keys());
            connectionIds.forEach(id => {
                this.removeConnection(id);
            });
        }

        // 同步状态 - 确保所有组件的连线状态一致
        syncConnectionStates() {
            console.log('[ConnectionManager] 开始同步连线状态');

            // 获取各组件的连线状态
            const stateConnections = this.stateManager ? this.stateManager.getAllConnections() : [];
            const canvasConnections = this.canvasManager ? this.getCanvasConnections() : [];
            const internalConnections = this.getAllConnections();

            console.log('[ConnectionManager] 连线状态统计:', {
                internal: internalConnections.length,
                state: stateConnections.length,
                canvas: canvasConnections.length
            });
            
            // 详细输出画布连接信息用于调试
            if (canvasConnections.length > 0) {
                console.log('[ConnectionManager] 画布连接详情:', canvasConnections);
            }

            // 优先从 StateManager 同步连接数据到内部存储（如果 StateManager 有更多数据）
            if (stateConnections.length > internalConnections.length) {
                console.log('[ConnectionManager] 从 StateManager 同步连接数据到内部存储');
                // 清空内部存储并重新同步
                this.connections.clear();
                stateConnections.forEach(conn => {
                    this.connections.set(conn.id, { ...conn });
                });
                console.log('[ConnectionManager] 已同步', stateConnections.length, '个连接到内部存储');
            }
            
            // 强制同步画布上的所有连接
            if (canvasConnections.length > 0) {
                console.log('[ConnectionManager] 强制同步画布连接到内部存储和 StateManager');
                canvasConnections.forEach(canvasConn => {
                    if (canvasConn.id) {
                        // 添加到内部存储
                        if (!this.connections.has(canvasConn.id)) {
                            console.log('[ConnectionManager] 从画布添加缺失的连接到内部存储:', canvasConn.id);
                            this.connections.set(canvasConn.id, canvasConn);
                        }
                        
                        // 添加到 StateManager
                        if (this.stateManager && !this.stateManager.state.connections.has(canvasConn.id)) {
                            console.log('[ConnectionManager] 从画布添加缺失的连接到 StateManager:', canvasConn.id);
                            this.stateManager.state.connections.set(canvasConn.id, canvasConn);
                        }
                    }
                });
            }

            // 重新获取内部连接（可能已更新）
            const updatedInternalConnections = this.getAllConnections();
            
            // 以内部存储为准，同步到其他组件
            const targetConnections = updatedInternalConnections;

            // 同步到 StateManager（如果需要）
            if (this.stateManager && updatedInternalConnections.length > stateConnections.length) {
                this.syncToStateManager(targetConnections);
            }

            // 同步到 CanvasManager
            if (this.canvasManager) {
                this.syncToCanvasManager(targetConnections);
            }

            console.log('[ConnectionManager] 连线状态同步完成，最终连接数:', updatedInternalConnections.length);
        }

        // 从工作流数据加载连线
        loadConnectionsFromWorkflow(workflowData) {
            console.log('[ConnectionManager] 从工作流数据加载连线');

            // 清空现有连线
            this.clearAllConnections();

            // 加载连线数据
            const connections = workflowData.connections || [];
            connections.forEach(connectionData => {
                this.addConnection(connectionData, { skipValidation: true });
            });

            // 同步状态
            this.syncConnectionStates();

            console.log('[ConnectionManager] 工作流连线加载完成，共', connections.length, '个连线');
        }

        // 导出连线数据用于保存工作流
        exportConnectionsForWorkflow() {
            const connections = this.getAllConnections();
            console.log('[ConnectionManager] 导出连线数据，共', connections.length, '个连线');
            
            return connections.map(conn => ({
                id: conn.id,
                sourceNodeId: conn.sourceNodeId,
                targetNodeId: conn.targetNodeId,
                sourcePort: conn.sourcePort,
                targetPort: conn.targetPort,
                targetParam: conn.targetParam
            }));
        }

        // 验证连线数据
        validateConnection(connectionData) {
            if (!connectionData.sourceNodeId || !connectionData.targetNodeId) {
                console.error('[ConnectionManager] 连线缺少源节点或目标节点ID');
                return false;
            }

            if (connectionData.sourceNodeId === connectionData.targetNodeId) {
                console.error('[ConnectionManager] 不能连接到自身');
                return false;
            }

            return true;
        }

        // 检查是否已存在相同连线
        hasConnection(connectionData) {
            return Array.from(this.connections.values()).some(conn =>
                conn.sourceNodeId === connectionData.sourceNodeId &&
                conn.targetNodeId === connectionData.targetNodeId &&
                conn.targetParam === connectionData.targetParam
            );
        }

        // 获取已存在的相同连线
        getExistingConnection(connectionData) {
            return Array.from(this.connections.values()).find(conn =>
                conn.sourceNodeId === connectionData.sourceNodeId &&
                conn.targetNodeId === connectionData.targetNodeId &&
                conn.targetParam === connectionData.targetParam
            );
        }

        // 生成连线ID
        generateConnectionId() {
            return `connection_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }

        // StateManager 连线添加事件处理
        onStateConnectionAdded(connection) {
            console.log('[ConnectionManager] StateManager 添加连线事件:', connection.id);
            
            if (!this.connections.has(connection.id)) {
                this.connections.set(connection.id, connection);
                this.emit('connectionAdded', connection);
            }
        }

        // StateManager 连线移除事件处理
        onStateConnectionRemoved(connectionId, connection) {
            console.log('[ConnectionManager] StateManager 移除连线事件:', connectionId);
            
            if (this.connections.has(connectionId)) {
                this.connections.delete(connectionId);
                this.emit('connectionRemoved', { connectionId, connection });
            }
        }

        // CanvasManager 连线创建事件处理
        onCanvasConnectionCreated(info) {
            console.log('[ConnectionManager] CanvasManager 创建连线事件:', info);
            
            // 从 jsPlumb 连线信息提取数据
            const connectionData = this.extractConnectionDataFromJsPlumb(info);
            if (connectionData) {
                this.addConnection(connectionData, { skipCanvasUpdate: true });
            }
        }

        // CanvasManager 连线分离事件处理
        onCanvasConnectionDetached(info) {
            console.log('[ConnectionManager] CanvasManager 分离连线事件:', info);
            
            const connectionId = info.connection.getParameter('connectionId');
            if (connectionId) {
                this.removeConnection(connectionId, { skipCanvasUpdate: true });
            }
        }

        // 从 jsPlumb 连线信息提取数据
        extractConnectionDataFromJsPlumb(info) {
            try {
                const sourceElement = info.source;
                const targetElement = info.target;
                
                const sourceNodeId = this.getNodeIdFromElement(sourceElement);
                const targetNodeId = this.getNodeIdFromElement(targetElement);
                const targetParam = targetElement.getAttribute('data-param') || 'input';

                if (!sourceNodeId || !targetNodeId) {
                    console.error('[ConnectionManager] 无法提取节点ID');
                    return null;
                }

                return {
                    sourceNodeId,
                    targetNodeId,
                    targetParam,
                    sourcePort: 'output',
                    targetPort: 'input'
                };
            } catch (error) {
                console.error('[ConnectionManager] 提取连线数据失败:', error);
                return null;
            }
        }

        // 从元素获取节点ID
        getNodeIdFromElement(element) {
            // 向上查找包含 data-node-id 的元素
            let current = element;
            while (current && current !== document.body) {
                if (current.hasAttribute && current.hasAttribute('data-node-id')) {
                    return current.getAttribute('data-node-id');
                }
                current = current.parentElement;
            }
            return null;
        }

        // 在画布上创建连线
        createCanvasConnection(connection) {
            if (!this.canvasManager || !this.canvasManager.jsPlumbInstance) {
                console.warn('[ConnectionManager] CanvasManager 不可用');
                return;
            }

            // 实现画布连线创建逻辑
            // 这里需要根据具体的 CanvasManager 实现来调整
            console.log('[ConnectionManager] 在画布上创建连线:', connection.id);
        }

        // 从画布移除连线
        removeCanvasConnection(connectionId) {
            if (!this.canvasManager || !this.canvasManager.jsPlumbInstance) {
                console.warn('[ConnectionManager] CanvasManager 不可用');
                return;
            }

            // 实现画布连线移除逻辑
            console.log('[ConnectionManager] 从画布移除连线:', connectionId);
        }

        // 获取画布连线
        getCanvasConnections() {
            if (!this.canvasManager || !this.canvasManager.jsPlumbInstance) {
                return [];
            }

            // 从 jsPlumb 获取所有连线
            const jsConnections = this.canvasManager.jsPlumbInstance.getAllConnections();
            console.log('[ConnectionManager] 画布上的 jsPlumb 连接数量:', jsConnections.length);
            
            return jsConnections.map(conn => {
                let connectionId = conn.getParameter('connectionId') || conn.connectionId;
                const sourceNodeId = this.getNodeIdFromElement(conn.source);
                const targetNodeId = this.getNodeIdFromElement(conn.target);
                
                // 如果没有ID，为连接生成一个ID
                if (!connectionId && sourceNodeId && targetNodeId) {
                    connectionId = `${sourceNodeId}_${targetNodeId}_${Date.now()}`;
                    console.log('[ConnectionManager] 为画布连接生成ID:', connectionId);
                    // 设置ID到连接对象
                    conn.setParameter('connectionId', connectionId);
                    conn.connectionId = connectionId;
                }
                
                return {
                    id: connectionId,
                    sourceNodeId: sourceNodeId,
                    targetNodeId: targetNodeId,
                    sourceParam: conn.getParameter('sourceParam') || 'output',
                    targetParam: conn.getParameter('targetParam') || 'input'
                };
            }).filter(conn => conn.id && conn.sourceNodeId && conn.targetNodeId);
        }

        // 同步到 StateManager
        syncToStateManager(targetConnections) {
            if (!this.stateManager) return;

            console.log('[ConnectionManager] 同步到 StateManager');
            
            // 清空 StateManager 的连线
            const stateConnections = this.stateManager.getAllConnections();
            stateConnections.forEach(conn => {
                this.stateManager._removeConnection(conn.id);
            });

            // 添加目标连线
            targetConnections.forEach(conn => {
                this.stateManager._addConnection(conn, true);
            });
        }

        // 同步到 CanvasManager
        syncToCanvasManager(targetConnections) {
            if (!this.canvasManager) return;

            console.log('[ConnectionManager] 同步到 CanvasManager');
            
            // 使用 CanvasManager 的 restoreConnections 方法
            if (this.canvasManager.restoreConnections) {
                this.canvasManager.restoreConnections(targetConnections);
            }
        }

        // 事件系统
        on(event, callback) {
            if (!this.listeners.has(event)) {
                this.listeners.set(event, []);
            }
            this.listeners.get(event).push(callback);
        }

        off(event, callback) {
            if (this.listeners.has(event)) {
                const callbacks = this.listeners.get(event);
                const index = callbacks.indexOf(callback);
                if (index > -1) {
                    callbacks.splice(index, 1);
                }
            }
        }

        emit(event, data) {
            if (this.listeners.has(event)) {
                this.listeners.get(event).forEach(callback => {
                    try {
                        callback(data);
                    } catch (error) {
                        console.error('[ConnectionManager] 事件回调错误:', error);
                    }
                });
            }
        }

        // 调试方法
        debugConnectionStates() {
            console.log('[ConnectionManager] 连线状态调试信息:');
            console.log('内部连线:', this.getAllConnections());
            
            if (this.stateManager) {
                console.log('StateManager 连线:', this.stateManager.getAllConnections());
            }
            
            if (this.canvasManager) {
                console.log('CanvasManager 连线:', this.getCanvasConnections());
            }
        }
    }

    // 导出到全局
    window.WorkflowEditor_ConnectionManager = WorkflowEditor_ConnectionManager;
    
    console.log('[ConnectionManager] 连线管理器类已加载');
})();