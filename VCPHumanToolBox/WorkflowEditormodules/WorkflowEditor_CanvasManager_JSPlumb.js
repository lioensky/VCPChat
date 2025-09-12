// WorkflowEditor Canvas Manager with JSPlumb integration
(function() {
    'use strict';

    class WorkflowEditor_CanvasManager {
        constructor() {
            if (WorkflowEditor_CanvasManager.instance) {
                return WorkflowEditor_CanvasManager.instance;
            }
            
            this.canvas = null;
            this.viewport = null;
            this.content = null;
            this.stateManager = null;
            this.jsPlumbInstance = null;
            
            // 节点管理
            this.nodes = new Map();
            this.connections = new Map();
            
            WorkflowEditor_CanvasManager.instance = this;
        }

        static getInstance() {
            if (!WorkflowEditor_CanvasManager.instance) {
                WorkflowEditor_CanvasManager.instance = new WorkflowEditor_CanvasManager();
            }
            return WorkflowEditor_CanvasManager.instance;
        }

        // 初始化画布管理器
        init(stateManager) {
            this.stateManager = stateManager;
            this.canvas = document.getElementById('workflowCanvas');
            this.viewport = document.getElementById('canvasViewport');
            this.content = document.getElementById('canvasContent');
            
            this.initJSPlumb();
            this.bindEvents();
            
            console.log('[WorkflowEditor_CanvasManager] Initialized with JSPlumb');
        }

        // 初始化JSPlumb
        initJSPlumb() {
            // 检查JSPlumb是否可用
            if (typeof jsPlumb === 'undefined') {
                console.error('[CanvasManager] JSPlumb library not loaded');
                return;
            }

            // 创建JSPlumb实例
            this.jsPlumbInstance = jsPlumb.getInstance({
                Container: this.content,
                Connector: ['Bezier', { curviness: 50 }],
                PaintStyle: {
                    stroke: '#3b82f6',
                    strokeWidth: 2
                },
                HoverPaintStyle: {
                    stroke: '#1d4ed8',
                    strokeWidth: 3
                },
                EndpointStyle: {
                    fill: '#3b82f6',
                    stroke: '#1e40af',
                    strokeWidth: 2,
                    radius: 6
                },
                EndpointHoverStyle: {
                    fill: '#1d4ed8',
                    stroke: '#1e3a8a',
                    strokeWidth: 2,
                    radius: 8
                },
                Anchor: ['Left', 'Right'],
                Endpoint: ['Dot', { radius: 6 }],
                ConnectionOverlays: [
                    ['Arrow', {
                        location: 1,
                        visible: true,
                        width: 11,
                        length: 11,
                        id: 'arrow'
                    }]
                ],
                LogEnabled: false
            });

            // 绑定连接事件
            this.jsPlumbInstance.bind('connection', (info) => {
                this.handleConnectionCreated(info);
            });

            this.jsPlumbInstance.bind('connectionDetached', (info) => {
                this.handleConnectionDetached(info);
            });

            this.jsPlumbInstance.bind('click', (connection) => {
                this.handleConnectionClick(connection);
            });
        }

        // 绑定画布事件
        bindEvents() {
            if (!this.viewport) return;

            // 画布缩放和平移
            this.viewport.addEventListener('wheel', (e) => this.handleCanvasWheel(e));
            
            // 画布拖拽
            let isDraggingCanvas = false;
            let dragStart = { x: 0, y: 0 };

            this.viewport.addEventListener('mousedown', (e) => {
                if (e.target === this.viewport || e.target === this.content) {
                    isDraggingCanvas = true;
                    dragStart = { x: e.clientX, y: e.clientY };
                    this.viewport.style.cursor = 'grabbing';
                    
                    // 清除选择
                    this.stateManager.clearSelection();
                }
            });

            document.addEventListener('mousemove', (e) => {
                if (isDraggingCanvas) {
                    const deltaX = e.clientX - dragStart.x;
                    const deltaY = e.clientY - dragStart.y;
                    const currentOffset = this.stateManager.getCanvasOffset();
                    
                    this.stateManager.setCanvasOffset({
                        x: currentOffset.x + deltaX,
                        y: currentOffset.y + deltaY
                    });
                    
                    dragStart = { x: e.clientX, y: e.clientY };
                }
            });

            document.addEventListener('mouseup', () => {
                if (isDraggingCanvas) {
                    isDraggingCanvas = false;
                    this.viewport.style.cursor = '';
                }
            });

            // 画布点击事件 - 修复连接线
            this.viewport.addEventListener('click', (e) => {
                if (e.target === this.viewport || e.target === this.content) {
                    // 点击画布空白区域时修复所有连接线
                    this.repairAllConnections();
                }
            });

        // 键盘事件
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));

        // 状态管理器事件
            if (this.stateManager) {
                this.stateManager.on('nodeAdded', (node) => this.renderNode(node));
                this.stateManager.on('nodeRemoved', (data) => this.removeNode(data.nodeId));
                this.stateManager.on('nodeUpdated', (data) => {
                    // 延迟处理，确保DOM更新完成，增加延迟时间以避免DOM未完全渲染的问题
                    setTimeout(() => {
                        try {
                            // 只有当节点存在且有位置信息时才更新
                            const nodeElement = this.nodes.get(data.nodeId);
                            if (nodeElement && data.node && data.node.position) {
                                this.updateNode(data.nodeId, data.node);
                            }
                        } catch (error) {
                            console.warn('[CanvasManager] Failed to update node on nodeUpdated event:', error);
                        }
                    }, 100);
                });
                this.stateManager.on('connectionAdded', (connection) => this.createConnection(connection));
                this.stateManager.on('connectionRemoved', (data) => this.removeConnection(data.connectionId));
                this.stateManager.on('canvasOffsetChanged', () => this.updateCanvasTransform());
                this.stateManager.on('canvasZoomChanged', () => this.updateCanvasTransform());
                this.stateManager.on('selectionChanged', (data) => this.updateSelection(data));
                
                // 监听工作流加载完成事件：先全局重绘，再对图片上传节点做安全 revalidate
                this.stateManager.on('workflowLoaded', (data) => {
                    console.log('[CanvasManager] Workflow loaded, fixing image upload node connections...');
                    // 第一步：全局 repaint（避免 revalidate 引起的崩溃）
                    setTimeout(() => {
                        this.repairAllConnections();
                    }, 150);

                    // 第二步：仅对图片上传节点定点 revalidate（两次小延迟，确保布局稳定）
                    const doRevalidateImageUploads = () => {
                        if (!this.nodes) return;
                        this.nodes.forEach((el, id) => {
                            if (el && el.classList && el.classList.contains('image-upload')) {
                                if (typeof this.revalidateNodeSafe === 'function') {
                                    this.revalidateNodeSafe(id);
                                }
                            }
                        });
                    };
                    setTimeout(doRevalidateImageUploads, 260);
                    setTimeout(doRevalidateImageUploads, 400);
                });
            }
        }

        // 处理画布滚轮缩放
        handleCanvasWheel(e) {
            e.preventDefault();
            
            const rect = this.viewport.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            
            const currentZoom = this.stateManager.getCanvasZoom();
            const currentOffset = this.stateManager.getCanvasOffset();
            
            const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
            const newZoom = Math.max(0.1, Math.min(3, currentZoom * zoomFactor));
            
            // 计算缩放中心点
            const zoomRatio = newZoom / currentZoom;
            const newOffset = {
                x: mouseX - (mouseX - currentOffset.x) * zoomRatio,
                y: mouseY - (mouseY - currentOffset.y) * zoomRatio
            };
            
            this.stateManager.setCanvasZoom(newZoom);
            this.stateManager.setCanvasOffset(newOffset);
        }

        // 处理键盘事件
        handleKeyDown(e) {
            if (!this.stateManager.get('isVisible')) return;

            const isCtrlOrCmd = e.ctrlKey || e.metaKey;

            if (isCtrlOrCmd && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                this.stateManager.undo();
            } else if (isCtrlOrCmd && e.key.toLowerCase() === 'y') {
                e.preventDefault();
                this.stateManager.redo();
            } else {
                switch (e.key) {
                    case 'Delete':
                    case 'Backspace':
                        this.deleteSelected();
                        break;
                    case 'Escape':
                        this.stateManager.clearSelection();
                        break;
                    case 'a':
                    case 'A':
                        if (isCtrlOrCmd) {
                            e.preventDefault();
                            this.selectAll();
                        }
                        break;
                }
            }
        }

        // 渲染节点
        renderNode(node) {
            // 检查节点是否已经存在，避免重复渲染
            const existingNode = document.getElementById(node.id);
            if (existingNode) {
                console.log('[CanvasManager] Node already exists, removing old one:', node.id);
                this.removeNode(node.id);
            }

            const nodeElement = document.createElement('div');
            let nodeClasses = `canvas-node ${node.category === 'auxiliary' ? 'auxiliary' : ''}`;
            
            // 为URL渲染节点添加特殊类
            if (node.type === 'urlRenderer' || node.pluginId === 'urlRenderer') {
                nodeClasses += ' url-renderer';
            }
            
            // 为图片上传节点添加特殊类
            if (node.type === 'imageUpload' || node.pluginId === 'imageUpload') {
                nodeClasses += ' image-upload';
            }
            
            nodeElement.className = nodeClasses;
            nodeElement.id = node.id; // 直接使用节点ID，不添加前缀
            nodeElement.setAttribute('data-node-id', node.id); // 添加数据属性
            nodeElement.style.left = node.position.x + 'px';
            nodeElement.style.top = node.position.y + 'px';
            nodeElement.style.position = 'absolute';
            
            // 为图片上传节点创建特殊UI
            if (node.type === 'imageUpload' || node.pluginId === 'imageUpload') {
                nodeElement.innerHTML = `
                    <div class="canvas-node-header">
                        <span class="canvas-node-icon">${this.getNodeIcon(node)}</span>
                        <span class="canvas-node-title">${node.name}</span>
                        <div class="canvas-node-status ${node.status || 'idle'}"></div>
                    </div>
                    <div class="canvas-node-body">
                        <div class="canvas-node-desc">${this.getNodeDescription(node)}</div>
                        <div class="image-upload-area">
                            <div class="upload-content">
                                <div class="upload-text">点击上传图片</div>
                                <div class="upload-preview">
                                    <img />
                                </div>
                            </div>
                        </div>
                        <input type="file" class="image-upload-input" accept="image/*" />
                    </div>
                `;
            } else {
                nodeElement.innerHTML = `
                    <div class="canvas-node-header">
                        <span class="canvas-node-icon">${this.getNodeIcon(node)}</span>
                        <span class="canvas-node-title">${node.name}</span>
                        <div class="canvas-node-status ${node.status || 'idle'}"></div>
                    </div>
                    <div class="canvas-node-body">
                        <div class="canvas-node-desc">${this.getNodeDescription(node)}</div>
                    </div>
                `;
            }

            this.content.appendChild(nodeElement);
            this.nodes.set(node.id, nodeElement);

            // 使节点可拖拽
            this.makeNodeDraggable(nodeElement, node);
            
            // 添加连接点
            this.addEndpoints(nodeElement, node);
            
            // 绑定节点事件
            this.bindNodeEvents(nodeElement, node);

            console.log('[CanvasManager] Node rendered successfully:', node.id, node.name);
        }

        // 获取节点图标
        getNodeIcon(node) {
            const icons = {
                assistant: '🤖', music: '🎵', note: '📝', search: '🔍',
                TodoManager: '✅', FluxGen: '🎨', ComfyUIGen: '🖼️', 
                BilibiliFetch: '📺', VideoGenerator: '🎬',
                regex: '🔤', dataTransform: '🔄', codeEdit: '💻',
                condition: '🔀', loop: '🔁', delay: '⏱️', urlRenderer: '🖼️',
                imageUpload: '📤'
            };
            return icons[node.pluginId || node.type] || '⚙️';
        }

        // 获取节点描述
        getNodeDescription(node) {
            if (node.category === 'auxiliary') {
                const descriptions = {
                    regex: '正则表达式处理',
                    dataTransform: '数据格式转换',
                    codeEdit: '代码处理编辑',
                    condition: '条件分支判断',
                    loop: '循环执行控制',
                    delay: '延时等待执行',
                    imageUpload: '上传图片转base64'
                };
                return descriptions[node.pluginId || node.type] || '辅助处理节点';
            }
            return `${node.category === 'vcpChat' ? 'VCPChat' : 'VCPToolBox'} 插件`;
        }

        // 使节点可拖拽
        makeNodeDraggable(nodeElement, node) {
            if (!this.jsPlumbInstance) return;

            try {
                // 检查节点是否已经是可拖拽的，避免重复设置
                if (nodeElement.classList.contains('jtk-draggable')) {
                    console.log('[CanvasManager] Node already draggable:', node.id);
                    return;
                }

                this.jsPlumbInstance.draggable(nodeElement, {
                    containment: 'parent',
                    grid: [10, 10], // 网格对齐
                    force: true, // 强制启用拖拽，避免 force 属性未定义错误
                    start: (params) => {
                        // 选择节点
                        if (this.stateManager && this.stateManager.selectNode) {
                            this.stateManager.selectNode(node.id, params.e && (params.e.ctrlKey || params.e.metaKey));
                        }
                        // 标记正在拖拽，避免频繁重新验证连接
                        nodeElement._isDragging = true;
                    },
                    drag: (params) => {
                        // 拖拽过程中不触发StateManager更新，避免频繁重新验证连接
                        // JSPlumb会自动处理连接线的实时更新
                    },
                    stop: (params) => {
                        // 拖拽结束后更新最终位置
                        const newPos = {
                            x: parseInt(params.el.style.left) || 0,
                            y: parseInt(params.el.style.top) || 0
                        };
                        
                        // 清除拖拽标记
                        nodeElement._isDragging = false;
                        
                        // 更新StateManager中的节点位置
                        if (this.stateManager && this.stateManager.updateNode) {
                            this.stateManager.updateNode(node.id, { position: newPos });
                        }
                        
                        // 拖拽结束后重新验证连接，确保连接线位置正确
                        setTimeout(() => {
                            if (this.jsPlumbInstance && nodeElement.offsetParent !== null) {
                                try {
                                    this.jsPlumbInstance.revalidate(nodeElement);
                                    this.jsPlumbInstance.repaint(nodeElement);
                                } catch (error) {
                                    console.warn('[CanvasManager] Failed to revalidate after drag:', error);
                                }
                            }
                        }, 50);
                        
                        console.log(`[CanvasManager] Node ${node.id} moved to:`, newPos);
                    }
                });

                console.log('[CanvasManager] Node made draggable successfully:', node.id);
            } catch (error) {
                console.error('[CanvasManager] Error making node draggable:', error);
                console.error('Node element:', nodeElement);
                console.error('Node data:', node);
            }
        }

        // 添加连接点
        addEndpoints(nodeElement, node) {
            if (!this.jsPlumbInstance) return;

            console.log('[CanvasManager] Adding endpoints for node:', node.id, node.category);

            let inputEndpoint = null;
            let outputEndpoint = null;

            // 对于 'contentInput' 节点，只添加输出端点
            if (node.type === 'contentInput' || node.pluginId === 'contentInput') {
                console.log('[CanvasManager] Adding output-only endpoint for contentInput node:', node.id);
                outputEndpoint = this.jsPlumbInstance.addEndpoint(nodeElement, {
                    anchor: 'Right',
                    isSource: true,
                    isTarget: false,
                    maxConnections: -1,
                    endpoint: ['Dot', { radius: 6 }],
                    paintStyle: { fill: '#f59e0b', stroke: '#d97706' },
                    hoverPaintStyle: { fill: '#b45309', stroke: '#92400e' },
                    connectorStyle: { stroke: '#3b82f6', strokeWidth: 2 },
                    connectorHoverStyle: { stroke: '#1d4ed8', strokeWidth: 3 },
                    dragOptions: { cursor: 'pointer', zIndex: 2000 }
                });
                
                // 设置端点的节点ID，用于连接创建时的识别
                if (outputEndpoint) {
                    outputEndpoint.nodeId = node.id;
                    outputEndpoint.paramName = 'output';
                }
            } else {
                // 其他节点添加输入和输出端点
                console.log('[CanvasManager] Adding input and output endpoints for node:', node.id);
                inputEndpoint = this.jsPlumbInstance.addEndpoint(nodeElement, {
                    anchor: 'Left',
                    isTarget: true,
                    isSource: false,
                    maxConnections: -1,
                    endpoint: ['Dot', { radius: 6 }],
                    paintStyle: { fill: '#10b981', stroke: '#059669' },
                    hoverPaintStyle: { fill: '#047857', stroke: '#065f46' },
                    connectorStyle: { stroke: '#3b82f6', strokeWidth: 2 },
                    connectorHoverStyle: { stroke: '#1d4ed8', strokeWidth: 3 },
                    dropOptions: { hoverClass: 'hover', activeClass: 'active' }
                });

                outputEndpoint = this.jsPlumbInstance.addEndpoint(nodeElement, {
                    anchor: 'Right',
                    isSource: true,
                    isTarget: false,
                    maxConnections: -1,
                    endpoint: ['Dot', { radius: 6 }],
                    paintStyle: { fill: '#f59e0b', stroke: '#d97706' },
                    hoverPaintStyle: { fill: '#b45309', stroke: '#92400e' },
                    connectorStyle: { stroke: '#3b82f6', strokeWidth: 2 },
                    connectorHoverStyle: { stroke: '#1d4ed8', strokeWidth: 3 },
                    dragOptions: { cursor: 'pointer', zIndex: 2000 }
                });
                
                // 设置端点的节点ID和参数名，用于连接创建时的识别
                if (inputEndpoint) {
                    inputEndpoint.nodeId = node.id;
                    inputEndpoint.paramName = 'input';
                }
                if (outputEndpoint) {
                    outputEndpoint.nodeId = node.id;
                    outputEndpoint.paramName = 'output';
                }
            }

            // 存储端点引用
            nodeElement._inputEndpoint = inputEndpoint;
            nodeElement._outputEndpoint = outputEndpoint;

            // 为辅助节点确保端点正确设置 (现在已经包含在上面的逻辑中，但保留以防万一)
            if (node.category === 'auxiliary') {
                console.log('[CanvasManager] Setting up auxiliary node endpoints:', node.id);
                
                if (inputEndpoint) {
                    inputEndpoint.setVisible(true);
                    inputEndpoint.setEnabled(true);
                }
                
                if (outputEndpoint) {
                    outputEndpoint.setVisible(true);
                    outputEndpoint.setEnabled(true);
                }
            }

            console.log('[CanvasManager] Endpoints added successfully for node:', node.id);
            try {
                // 在 DOM 上写入 data-node-id，方便事件 fallback 解析
                if (nodeElement && nodeElement.setAttribute) {
                    nodeElement.setAttribute('data-node-id', node.id);
                }
            } catch (e) {
                console.warn('[CanvasManager] Failed to set data-node-id on node element:', e);
            }
        }

        // 绑定节点事件
        bindNodeEvents(nodeElement, node) {
            // 单击选择
            nodeElement.addEventListener('click', (e) => {
                e.stopPropagation();
                this.stateManager.selectNode(node.id, e.ctrlKey || e.metaKey);
            });

            // 双击编辑
            nodeElement.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.editNode(node.id);
            });

            // 右键菜单
            nodeElement.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showNodeContextMenu(e, node.id);
            });

            // 为图片上传节点添加特殊事件处理
            if (node.type === 'imageUpload' || node.pluginId === 'imageUpload') {
                this.bindImageUploadEvents(nodeElement, node);
            }
        }

        // 绑定图片上传节点的特殊事件
        bindImageUploadEvents(nodeElement, node) {
            const uploadArea = nodeElement.querySelector('.image-upload-area');
            const fileInput = nodeElement.querySelector('.image-upload-input');
            const uploadText = nodeElement.querySelector('.upload-text');
            const uploadPreview = nodeElement.querySelector('.upload-preview');
            const previewImg = uploadPreview.querySelector('img');

            if (!uploadArea || !fileInput) {
                console.error('[CanvasManager] Image upload elements not found');
                return;
            }

            // 检查节点是否已经有上传的图片数据（工作流加载时恢复状态）
            // 支持两种数据格式：uploadedImage（新格式）和uploadedImageData（旧格式）
            let imageData = null;
            let fileName = null;
            
            if (node.uploadedImage && node.uploadedImage.base64Data) {
                // 新格式
                imageData = node.uploadedImage.base64Data;
                fileName = node.uploadedImage.fileName;
            } else if (node.uploadedImageData) {
                // 旧格式（NodeManager使用的格式）
                imageData = node.uploadedImageData;
                fileName = node.uploadedFileName || '已上传图片';
            }
            
            if (imageData) {
                console.log('[CanvasManager] Restoring uploaded image for node:', node.id);
                uploadText.textContent = fileName || '已上传图片';
                uploadText.style.fontSize = '10px';
                uploadText.style.wordBreak = 'break-all';
                previewImg.src = imageData;
                uploadPreview.style.display = 'block';
                
                // 确保图片加载完成后重新计算连接线位置（含缓存命中的兜底）
                const doRefresh = () => {
                    setTimeout(() => {
                        this.refreshNodeConnections(node.id);
                    }, 50);
                };
                previewImg.onload = doRefresh;
                if (previewImg.complete) {
                    doRefresh();
                }
            }

            // 点击上传区域触发文件选择
            uploadArea.addEventListener('click', (e) => {
                e.stopPropagation();
                fileInput.click();
            });

            // 文件选择处理
            fileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    this.handleImageUpload(file, node, uploadText, uploadPreview, previewImg);
                }
            });

            // 拖拽上传支持
            uploadArea.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                uploadArea.style.borderColor = '#007bff';
                uploadArea.style.backgroundColor = '#f8f9fa';
            });

            uploadArea.addEventListener('dragleave', (e) => {
                e.preventDefault();
                e.stopPropagation();
                uploadArea.style.borderColor = '#ccc';
                uploadArea.style.backgroundColor = '';
            });

            uploadArea.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                uploadArea.style.borderColor = '#ccc';
                uploadArea.style.backgroundColor = '';

                const files = e.dataTransfer.files;
                if (files.length > 0) {
                    const file = files[0];
                    if (file.type.startsWith('image/')) {
                        this.handleImageUpload(file, node, uploadText, uploadPreview, previewImg);
                    } else {
                        alert('请上传图片文件');
                    }
                }
            });
        }

        // 安全 revalidate 单个节点（仅该节点，避免全局失效引用）
        revalidateNodeSafe(nodeId) {
            if (!this.jsPlumbInstance) return;
            try {
                const nodeElement = this.nodes && this.nodes.get ? this.nodes.get(nodeId) : document.getElementById(nodeId);
                if (!nodeElement) return;
                if (nodeElement.offsetParent !== null && document.contains(nodeElement)) {
                    try { this.jsPlumbInstance.revalidate(nodeElement); } catch (_) {}
                    try { this.jsPlumbInstance.repaint(nodeElement); } catch (_) {}
                    if (typeof requestAnimationFrame === 'function') {
                        requestAnimationFrame(() => {
                            try { this.jsPlumbInstance.repaint(nodeElement); } catch (_) {}
                        });
                    }
                }
            } catch (e) {
                console.warn('[CanvasManager] revalidateNodeSafe error:', e);
            }
        }

        // 处理图片上传
        handleImageUpload(file, node, uploadText, uploadPreview, previewImg) {
            // 检查文件大小 - NodeManager中的maxFileSize是以MB为单位
            const maxSizeMB = (node.config && node.config.maxFileSize) || 10; // 10MB
            const maxSizeBytes = maxSizeMB * 1024 * 1024; // 转换为字节
            const fileSizeMB = file.size / (1024 * 1024);
            
            if (file.size > maxSizeBytes) {
                alert(`文件大小超过限制: ${fileSizeMB.toFixed(2)}MB > ${maxSizeMB}MB`);
                return;
            }

            // 检查文件格式
            const acceptedFormats = (node.config && node.config.acceptedFormats) || ['jpg', 'png', 'gif', 'webp'];
            const fileExtension = file.name.split('.').pop().toLowerCase();
            
            // 处理acceptedFormats可能是数组或字符串的情况
            const formatArray = Array.isArray(acceptedFormats) ? acceptedFormats : acceptedFormats.split(',');
            
            if (!formatArray.includes(fileExtension)) {
                alert(`不支持的文件格式，支持的格式: ${formatArray.join(', ')}`);
                return;
            }

            // 读取文件并转换为base64
            const reader = new FileReader();
            reader.onload = (e) => {
                const base64Data = e.target.result;
                
                // 更新UI显示
                uploadText.textContent = file.name;
                uploadText.style.fontSize = '10px';
                uploadText.style.wordBreak = 'break-all';
                previewImg.src = base64Data;
                uploadPreview.style.display = 'block';

                // 更新节点状态，存储base64数据（同时保存新旧两种格式以确保兼容性）
                if (this.stateManager && this.stateManager.updateNode) {
                    const outputParamName = (node.config && node.config.outputParamName) || 'imageBase64';
                    this.stateManager.updateNode(node.id, {
                        // 新格式（用于UI显示）
                        uploadedImage: {
                            fileName: file.name,
                            fileSize: file.size,
                            base64Data: base64Data,
                            outputParamName: outputParamName
                        },
                        // 旧格式（用于NodeManager执行）
                        uploadedImageData: base64Data,
                        uploadedFileName: file.name
                    });
                }

                // 更新节点状态为已准备
                this.updateNodeStatus(node.id, 'ready');
                
                // 重新计算并更新JSPlumb连接点位置
                setTimeout(() => {
                    this.refreshNodeConnections(node.id);
                }, 100);
                
                console.log('[CanvasManager] Image uploaded successfully:', file.name, 'Size:', file.size);
            };

            reader.onerror = (error) => {
                console.error('[CanvasManager] Error reading file:', error);
                alert('读取文件失败');
            };

            reader.readAsDataURL(file);
        }

        // 更新节点状态
        updateNodeStatus(nodeId, status) {
            const nodeElement = this.nodes.get(nodeId);
            if (nodeElement) {
                const statusElement = nodeElement.querySelector('.canvas-node-status');
                if (statusElement) {
                    statusElement.className = `canvas-node-status ${status}`;
                }
            }
        }

        // 刷新节点连接点位置
        refreshNodeConnections(nodeId) {
            if (!this.jsPlumbInstance) return;
            
            try {
                const nodeElement = this.nodes.get(nodeId);
                if (!nodeElement) {
                    console.warn('[CanvasManager] Node element not found for refresh:', nodeId);
                    return;
                }
                
                // 更严格的DOM存在性检查
                if (nodeElement.offsetParent !== null && 
                    nodeElement.offsetLeft !== undefined && 
                    nodeElement.offsetTop !== undefined &&
                    document.contains(nodeElement)) {
                    
                    // 重新计算节点的连接点位置
                    this.jsPlumbInstance.revalidate(nodeElement);
                    
                    // 重绘所有与该节点相关的连接
                    this.jsPlumbInstance.repaint(nodeElement);
                    
                    console.log('[CanvasManager] Refreshed connections for node:', nodeId);
                } else {
                    console.warn('[CanvasManager] Cannot refresh connections - node not properly in DOM:', nodeId);
                }
            } catch (error) {
                console.error('[CanvasManager] Error refreshing node connections:', error);
            }
        }

        // 修复所有连接线位置
        repairAllConnections() {
            if (!this.jsPlumbInstance) return;
            try {
                console.log('[CanvasManager] Repairing all connections...');
                // 仅进行全局重绘，避免触发 jsPlumb 对失效元素的 revalidate 扫描
                this.jsPlumbInstance.repaintEverything();
                // 下一帧再重绘一次，确保布局稳定后刷新
                if (typeof requestAnimationFrame === 'function') {
                    requestAnimationFrame(() => {
                        try { this.jsPlumbInstance.repaintEverything(); } catch (_) {}
                    });
                }
                console.log('[CanvasManager] All connections repaired');
            } catch (error) {
                console.error('[CanvasManager] Error repairing connections:', error);
            }
        }

        // 创建连接
        createConnection(connectionData) {
            if (!this.jsPlumbInstance) {
                console.error('[CanvasManager] JSPlumb instance not available');
                return;
            }

            console.log('[CanvasManager] Creating connection:', connectionData);

            const sourceNode = this.nodes.get(connectionData.sourceNodeId);
            const targetNode = this.nodes.get(connectionData.targetNodeId);

            if (!sourceNode || !targetNode) {
                console.warn(`[CanvasManager] Nodes not ready for connection. Source: ${sourceNode ? 'found' : 'NOT FOUND'}, Target: ${targetNode ? 'found' : 'NOT FOUND'}`);
                console.log(`[CanvasManager] Available nodes:`, Array.from(this.nodes.keys()));
                
                // 延迟重试，增加重试次数和间隔
                let retryCount = 0;
                const maxRetries = 5;
                const retryInterval = 200;
                
                const retryConnection = () => {
                    retryCount++;
                    console.log(`[CanvasManager] Retry attempt ${retryCount}/${maxRetries} for connection ${connectionData.sourceNodeId} -> ${connectionData.targetNodeId}`);
                    
                    const retrySourceNode = this.nodes.get(connectionData.sourceNodeId);
                    const retryTargetNode = this.nodes.get(connectionData.targetNodeId);
                    
                    if (retrySourceNode && retryTargetNode) {
                        console.log(`[CanvasManager] Retry ${retryCount} successful, creating connection`);
                        this.createConnectionInternal(connectionData, retrySourceNode, retryTargetNode);
                    } else if (retryCount < maxRetries) {
                        setTimeout(retryConnection, retryInterval);
                    } else {
                        console.error(`[CanvasManager] Failed to create connection after ${maxRetries} retries`);
                        console.error(`[CanvasManager] Missing nodes - Source: ${connectionData.sourceNodeId}, Target: ${connectionData.targetNodeId}`);
                    }
                };
                
                setTimeout(retryConnection, retryInterval);
                return;
            }

            this.createConnectionInternal(connectionData, sourceNode, targetNode);
        }

        // 内部连接创建方法
        createConnectionInternal(connectionData, sourceNode, targetNode) {
            try {
                // 检查是否已存在相同的连接ID，避免重复创建
                if (this.connections.has(connectionData.id)) {
                    console.log('[CanvasManager] Connection with same ID already exists, skipping creation:', connectionData.id);
                    return;
                }

                // 检查是否已存在相同的JSPlumb连接（基于源和目标节点）
                const existingJSPlumbConnection = Array.from(this.connections.values()).find(conn => {
                    if (!conn || !conn.source || !conn.target) return false;
                    
                    const connSourceId = conn.source.id || conn.sourceId;
                    const connTargetId = conn.target.id || conn.targetId;
                    
                    return connSourceId === sourceNode.id && connTargetId === targetNode.id;
                });
                
                if (existingJSPlumbConnection) {
                    console.log('[CanvasManager] JSPlumb connection already exists between nodes, skipping creation');
                    return;
                }

                // 确保节点已经被JSPlumb管理，使用更安全的方式
                try {
                    // 检查节点是否已经有拖拽功能，如果没有则添加
                    if (!sourceNode.classList.contains('jtk-draggable')) {
                        console.log('[CanvasManager] Making source node draggable:', sourceNode.id);
                        this.jsPlumbInstance.draggable(sourceNode, {
                            containment: 'parent',
                            grid: [10, 10],
                            force: true // 强制启用拖拽
                        });
                    }
                    
                    if (!targetNode.classList.contains('jtk-draggable')) {
                        console.log('[CanvasManager] Making target node draggable:', targetNode.id);
                        this.jsPlumbInstance.draggable(targetNode, {
                            containment: 'parent',
                            grid: [10, 10],
                            force: true // 强制启用拖拽
                        });
                    }
                } catch (dragError) {
                    console.warn('[CanvasManager] Error making nodes draggable:', dragError);
                    // 继续尝试创建连接，即使拖拽设置失败
                }

                // 使用更安全的连接创建方式
                const connection = this.jsPlumbInstance.connect({
                    source: sourceNode,
                    target: targetNode,
                    anchor: ['Right', 'Left'],
                    connector: ['Bezier', { curviness: 50 }],
                    paintStyle: { stroke: '#3b82f6', strokeWidth: 2 },
                    hoverPaintStyle: { stroke: '#1d4ed8', strokeWidth: 3 },
                    overlays: [
                        ['Arrow', {
                            location: 1,
                            visible: true,
                            width: 11,
                            length: 11,
                            id: 'arrow'
                        }]
                    ],
                    // 添加连接参数以避免JSPlumb内部错误
                    parameters: {
                        connectionId: connectionData.id,
                        sourceNodeId: connectionData.sourceNodeId,
                        targetNodeId: connectionData.targetNodeId
                    },
                    // 确保连接不会触发事件处理
                    doNotFireConnectionEvent: false
                });

                if (connection) {
                    // 标记为程序化创建的连接，避免触发handleConnectionCreated
                    connection._programmaticConnection = true;
                    connection.connectionId = connectionData.id;
                    this.connections.set(connectionData.id, connection);
                    console.log(`[CanvasManager] Connection created successfully: ${connectionData.sourceNodeId} -> ${connectionData.targetNodeId}`);
                } else {
                    console.error('[CanvasManager] JSPlumb connect returned null/undefined');
                }
            } catch (error) {
                console.error('[CanvasManager] Error creating connection:', error);
                console.error('Connection data:', connectionData);
                console.error('Source node:', sourceNode);
                console.error('Target node:', targetNode);
                
                // 如果连接创建失败，尝试延迟重试一次
                setTimeout(() => {
                    console.log('[CanvasManager] Retrying connection creation after error...');
                    try {
                        const retryConnection = this.jsPlumbInstance.connect({
                            source: sourceNode,
                            target: targetNode,
                            anchor: ['Right', 'Left'],
                            connector: ['Bezier', { curviness: 50 }],
                            paintStyle: { stroke: '#3b82f6', strokeWidth: 2 },
                            parameters: {
                                connectionId: connectionData.id,
                                sourceNodeId: connectionData.sourceNodeId,
                                targetNodeId: connectionData.targetNodeId
                            },
                            doNotFireConnectionEvent: false
                        });
                        
                        if (retryConnection) {
                            retryConnection._programmaticConnection = true;
                            retryConnection.connectionId = connectionData.id;
                            this.connections.set(connectionData.id, retryConnection);
                            console.log('[CanvasManager] Connection retry successful');
                        }
                    } catch (retryError) {
                        console.error('[CanvasManager] Connection retry also failed:', retryError);
                    }
                }, 500);
            }
        }

        // 处理连接创建
        handleConnectionCreated(info) {
            console.log('[CanvasManager] Connection created event:', info);
            console.log('[CanvasManager] Source element:', info.source);
            console.log('[CanvasManager] Target element:', info.target);
            console.log('[CanvasManager] Source endpoint:', info.sourceEndpoint);
            console.log('[CanvasManager] Target endpoint:', info.targetEndpoint);
            
            // 检查是否是程序化创建的连接（避免重复处理）
            if (info.connection._programmaticConnection) {
                // 如果连接已经存在于我们自己的映射中，则安全跳过
                try {
                    if (info.connection.connectionId && this.connections && this.connections.has(info.connection.connectionId)) {
                        console.log('[CanvasManager] Skipping programmatic connection event (already tracked):', info.connection.connectionId);
                        return;
                    }
                } catch (e) {
                    console.warn('[CanvasManager] Error checking existing programmatic connection mapping:', e);
                }
                // 如果连接被标记为程序化但尚未记录到 canvas/state，则继续处理，防止误判导致丢失
                console.log('[CanvasManager] Programmatic flag present but connection not tracked — proceeding to handle it to avoid loss');
            }
            
            try {
                // 更强健的节点ID获取逻辑
                let sourceNodeId, targetNodeId;
                let sourceParam = 'output', targetParam = 'input';

                // 从源端点获取节点ID
                if (info.sourceEndpoint && info.sourceEndpoint.nodeId) {
                    sourceNodeId = info.sourceEndpoint.nodeId;
                } else if (info.source) {
                    // 如果源是节点元素本身
                    if (info.source.classList && info.source.classList.contains('canvas-node')) {
                        sourceNodeId = info.source.id;
                    } else {
                        // 向上查找节点容器
                        let nodeElement = info.source;
                        while (nodeElement && !nodeElement.classList.contains('canvas-node')) {
                            nodeElement = nodeElement.parentElement;
                        }
                        if (nodeElement && nodeElement.id) {
                            sourceNodeId = nodeElement.id;
                        }
                    }
                }

                // 从目标端点获取节点ID和参数名
                if (info.targetEndpoint && info.targetEndpoint.nodeId) {
                    targetNodeId = info.targetEndpoint.nodeId;
                    if (info.targetEndpoint.paramName) {
                        targetParam = info.targetEndpoint.paramName;
                    }
                } else if (info.target) {
                    // 检查目标是否有节点ID属性
                    if (info.target.hasAttribute('data-node-id')) {
                        targetNodeId = info.target.getAttribute('data-node-id');
                        if (info.target.hasAttribute('data-param-name')) {
                            targetParam = info.target.getAttribute('data-param-name');
                        }
                    } else if (info.target.classList && info.target.classList.contains('canvas-node')) {
                        targetNodeId = info.target.id;
                    } else {
                        // 向上查找节点容器
                        let nodeElement = info.target;
                        while (nodeElement && !nodeElement.classList.contains('canvas-node')) {
                            nodeElement = nodeElement.parentElement;
                        }
                        if (nodeElement && nodeElement.id) {
                            targetNodeId = nodeElement.id;
                        }
                    }
                }

                console.log(`[CanvasManager] Resolved IDs - Source: ${sourceNodeId}, Target: ${targetNodeId}`);
                console.log(`[CanvasManager] Parameters - Source: ${sourceParam}, Target: ${targetParam}`);

                // 验证节点ID是否有效
                if (!sourceNodeId || !targetNodeId) {
                    console.error('[CanvasManager] Could not resolve node IDs');
                    console.error('Source element:', info.source);
                    console.error('Target element:', info.target);
                    console.error('Source endpoint:', info.sourceEndpoint);
                    console.error('Target endpoint:', info.targetEndpoint);
                    return;
                }

                // 验证节点是否存在于状态管理器中
                if (!this.nodes.has(sourceNodeId) || !this.nodes.has(targetNodeId)) {
                    console.error(`[CanvasManager] Nodes not found in canvas - source: ${sourceNodeId}, target: ${targetNodeId}`);
                    console.log('[CanvasManager] Available nodes:', Array.from(this.nodes.keys()));
                    return;
                }

                // 检查是否已存在相同的连接
                const existingConnections = this.stateManager.getAllConnections();
                const isDuplicate = existingConnections.some(conn => 
                    conn.sourceNodeId === sourceNodeId && 
                    conn.targetNodeId === targetNodeId &&
                    conn.targetParam === targetParam
                );

                if (isDuplicate) {
                    console.log('[CanvasManager] Duplicate connection detected, removing JSPlumb connection');
                    this.jsPlumbInstance.deleteConnection(info.connection);
                    return;
                }

                // 创建连接数据
                const connectionData = {
                    id: `${sourceNodeId}_${targetNodeId}_${Date.now()}`,
                    sourceNodeId: sourceNodeId,
                    targetNodeId: targetNodeId,
                    sourceParam: sourceParam,
                    targetParam: targetParam
                };

                console.log('[CanvasManager] Creating connection:', connectionData);

                // 标记连接ID到JSPlumb连接对象
                info.connection.connectionId = connectionData.id;
                info.connection.setParameter('connectionId', connectionData.id);
                this.connections.set(connectionData.id, info.connection);

                // 通过状态管理器添加连接（触发事件以便 ConnectionManager 同步）
                if (this.stateManager && this.stateManager.addConnection) {
                    console.log('[CanvasManager] 调用 StateManager.addConnection:', connectionData);
                    // 调用 addConnection，记录历史并触发事件，但不重复渲染（因为连接已经在画布上了）
                    const result = this.stateManager.addConnection(connectionData, false, true);
                    console.log('[CanvasManager] StateManager.addConnection 结果:', result);
                } else {
                    console.error('[CanvasManager] StateManager or addConnection method not available');
                }

            } catch (error) {
                console.error('[CanvasManager] Error handling connection creation:', error);
                console.error('Error details:', error.stack);
            }
        }

        // 处理连接断开
        handleConnectionDetached(info) {
            console.log('[CanvasManager] Connection detached:', info);
            
            // 检查是否是程序化删除的连接（避免重复处理）
            if (info.connection._programmaticDelete) {
                console.log('[CanvasManager] Skipping programmatic delete event');
                return;
            }
            
            try {
                if (info.connection.connectionId) {
                    console.log('[CanvasManager] Removing connection from state:', info.connection.connectionId);
                    
                    // 从内部连接映射中移除
                    this.connections.delete(info.connection.connectionId);
                    
                    // 通知状态管理器移除连接
                    if (this.stateManager && this.stateManager.removeConnection) {
                        // 调用 removeConnection，它会记录历史
                        this.stateManager.removeConnection(info.connection.connectionId, true);
                    }
                } else {
                    console.warn('[CanvasManager] Connection detached without ID');
                }
            } catch (error) {
                console.error('[CanvasManager] Error handling connection detached:', error);
            }
        }

        // 处理连接点击
        handleConnectionClick(connection) {
            // 选择连接线
            console.log('[CanvasManager] Connection clicked:', connection.connectionId);
        }

        // 移除节点
        removeNode(nodeId) {
            const nodeElement = this.nodes.get(nodeId);
            if (nodeElement) {
                // 移除JSPlumb管理的连接和端点
                if (this.jsPlumbInstance) {
                    this.jsPlumbInstance.remove(nodeElement);
                }
                
                // 从DOM中移除
                if (nodeElement.parentNode) {
                    nodeElement.parentNode.removeChild(nodeElement);
                }
                
                this.nodes.delete(nodeId);
            }
        }

        // 更新节点
        updateNode(nodeId, nodeData) {
            const nodeElement = this.nodes.get(nodeId);
            if (!nodeElement) {
                console.warn('[CanvasManager] Node element not found for update:', nodeId);
                return;
            }
            
            if (nodeData.position) {
                nodeElement.style.left = nodeData.position.x + 'px';
                nodeElement.style.top = nodeData.position.y + 'px';
                
                // 如果节点正在拖拽中，跳过重新验证，避免连接线错乱
                if (nodeElement._isDragging) {
                    return;
                }
                
                // 更严格的DOM存在性检查
                if (this.jsPlumbInstance && 
                    nodeElement.offsetParent !== null && 
                    nodeElement.offsetLeft !== undefined && 
                    nodeElement.offsetTop !== undefined &&
                    document.contains(nodeElement)) {
                    try {
                        this.jsPlumbInstance.revalidate(nodeElement);
                    } catch (error) {
                        console.warn('[CanvasManager] Failed to revalidate node connections:', error);
                    }
                }
            }
        }

        // 移除连接
        removeConnection(connectionId) {
            console.log('[CanvasManager] Removing connection:', connectionId);
            
            const connection = this.connections.get(connectionId);
            if (connection && this.jsPlumbInstance) {
                try {
                    // 检查连接对象是否有效
                    if (connection && typeof connection === 'object') {
                        this.jsPlumbInstance.deleteConnection(connection);
                        console.log('[CanvasManager] Connection deleted from JSPlumb');
                    } else {
                        console.warn('[CanvasManager] Invalid connection object:', connection);
                    }
                } catch (error) {
                    console.warn('[CanvasManager] Error deleting connection from JSPlumb:', error);
                    // 即使JSPlumb删除失败，也要清理内部状态
                }
                
                this.connections.delete(connectionId);
                console.log('[CanvasManager] Connection removed from internal state');
            } else {
                console.warn('[CanvasManager] Connection not found or JSPlumb not available:', {
                    connectionId,
                    connectionExists: !!connection,
                    jsPlumbExists: !!this.jsPlumbInstance
                });
                
                // 确保从内部状态中移除，即使连接对象不存在
                this.connections.delete(connectionId);
            }
        }

        // 更新画布变换
        updateCanvasTransform() {
            if (!this.content) return;
            
            const offset = this.stateManager.getCanvasOffset();
            const zoom = this.stateManager.getCanvasZoom();
            
            this.content.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`;
            
            // 重绘所有连接线
            if (this.jsPlumbInstance) {
                this.jsPlumbInstance.repaintEverything();
            }
        }

        // 更新选择状态
        updateSelection(data) {
            this.nodes.forEach((nodeElement, nodeId) => {
                if (data.selectedNodes.includes(nodeId)) {
                    nodeElement.classList.add('selected');
                } else {
                    nodeElement.classList.remove('selected');
                }
            });
        }

        // 删除选中的元素
        deleteSelected() {
            const selectedNodes = this.stateManager.getSelectedNodes();
            selectedNodes.forEach(nodeId => {
                this.stateManager.removeNode(nodeId);
            });
        }

        // 全选
        selectAll() {
            const allNodes = this.stateManager.getAllNodes();
            allNodes.forEach(node => {
                this.stateManager.selectNode(node.id, true);
            });
        }

        // 编辑节点
        editNode(nodeId) {
            const node = this.stateManager.getNode(nodeId);
            if (!node) return;
            if (window.WorkflowEditor_UIManager && window.WorkflowEditor_UIManager.renderPropertiesPanel) {
                window.WorkflowEditor_UIManager.renderPropertiesPanel(node);
            }
        }

        // 更新节点输入端点
        updateNodeInputs(nodeId, dynamicInputs) {
            console.log('[CanvasManager_JSPlumb] Updating node inputs for:', nodeId, dynamicInputs);
            
            const nodeElement = document.getElementById(nodeId);
            if (!nodeElement) {
                console.warn('[CanvasManager_JSPlumb] Node element not found:', nodeId);
                return;
            }

            // 移除现有的动态参数容器
            const existingParamsContainer = nodeElement.querySelector('.node-params-container');
            if (existingParamsContainer) {
                // 端点实际附加在 .param-input-box 元素上，逐一清理端点并尝试从受管列表移除
                const paramInputs = existingParamsContainer.querySelectorAll('.param-input-box');
                paramInputs.forEach(el => {
                    if (this.jsPlumbInstance) {
                        try { this.jsPlumbInstance.removeAllEndpoints(el); } catch (e) { console.warn('[CanvasManager] removeAllEndpoints failed:', e); }
                        try { if (typeof this.jsPlumbInstance.unmanage === 'function') this.jsPlumbInstance.unmanage(el); } catch (_) {}
                    }
                });
                existingParamsContainer.remove();
            }

            // 如果有动态输入参数，隐藏原有输入端点并创建参数输入框
            if (dynamicInputs && Array.isArray(dynamicInputs) && dynamicInputs.length > 0) {
                // 隐藏原有的输入端点
                if (nodeElement._inputEndpoint) {
                    nodeElement._inputEndpoint.setVisible(false);
                }

                const nodeBody = nodeElement.querySelector('.canvas-node-body');
                if (!nodeBody) return;

                // 创建参数容器
                const paramsContainer = document.createElement('div');
                paramsContainer.className = 'node-params-container';
                paramsContainer.style.cssText = `
                    margin-top: 8px;
                    padding: 8px;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                `;

                // 为每个参数创建输入框
                dynamicInputs.forEach((input, index) => {
                    const paramWrapper = document.createElement('div');
                    paramWrapper.className = 'param-wrapper';
                    paramWrapper.style.cssText = `
                        position: relative;
                        display: flex;
                        align-items: center;
                        margin-left: 12px;
                    `;

                    // 创建参数输入框
                    const paramInput = document.createElement('div');
                    paramInput.className = 'param-input-box';
                    paramInput.setAttribute('data-param', input.name);
                    paramInput.style.cssText = `
                        flex: 1;
                        padding: 6px 8px;
                        background: rgba(255, 255, 255, 0.1);
                        border: 1px solid rgba(255, 255, 255, 0.2);
                        border-radius: 3px;
                        font-size: 12px;
                        color: #e2e8f0;
                        text-align: center;
                        min-height: 20px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    `;
                    paramInput.textContent = input.name;

                    paramWrapper.appendChild(paramInput);
                    paramsContainer.appendChild(paramWrapper);

                    // 直接在输入框上添加JSPlumb端点
                    if (this.jsPlumbInstance) {
                        const endpoint = this.jsPlumbInstance.addEndpoint(paramInput, {
                            anchor: 'Left',
                            endpoint: 'Dot',
                            paintStyle: {
                                fill: '#333',
                                stroke: '#666',
                                strokeWidth: 1,
                                radius: 4
                            },
                            hoverPaintStyle: {
                                fill: '#555',
                                stroke: '#888',
                                strokeWidth: 1,
                                radius: 5
                            },
                            isTarget: true,
                            maxConnections: -1, // 允许无限连接，确保端点不会因连接断开而消失
                            connectorStyle: { 
                                stroke: '#3b82f6', 
                                strokeWidth: 2 
                            },
                            connectorHoverStyle: { 
                                stroke: '#1d4ed8', 
                                strokeWidth: 3 
                            }
                        });

                        // 为端点添加节点ID信息，便于连接时识别
                        if (endpoint) {
                            endpoint.nodeId = nodeId;
                            endpoint.paramName = input.name;
                            // 确保端点元素有正确的节点关联
                            paramInput.setAttribute('data-node-id', nodeId);
                            paramInput.setAttribute('data-param-name', input.name);
                        }
                    }
                });

                nodeBody.appendChild(paramsContainer);
            } else {
                // 如果没有动态输入参数，显示原有的输入端点
                if (nodeElement._inputEndpoint) {
                    nodeElement._inputEndpoint.setVisible(true);
                }
            }

            // 更新节点的dynamicInputs属性，直接更新不触发事件避免工作流加载期间的连接线重新验证
            const node = this.stateManager.getNode(nodeId);
            if (node) {
                node.dynamicInputs = dynamicInputs;
                // 直接更新节点数据，不触发nodeUpdated事件
                // this.stateManager.updateNode(nodeId, { dynamicInputs });
            }

            console.log('[CanvasManager_JSPlumb] Node inputs updated successfully');
        }

        // 显示节点右键菜单
        showNodeContextMenu(e, nodeId) {
            console.log('[CanvasManager] Show context menu for node:', nodeId);
            // TODO: 实现右键菜单
        }

        // 清空画布
        clear() {
            console.log('[CanvasManager] Clearing canvas...');
            
            // 先移除所有JSPlumb管理的连接和端点
            if (this.jsPlumbInstance) {
                try {
                    this.jsPlumbInstance.deleteEveryConnection();
                    this.jsPlumbInstance.deleteEveryEndpoint();
                    // 重置内部管理状态，清空残留引用
                    try {
                        if (typeof this.jsPlumbInstance.reset === 'function') {
                            this.jsPlumbInstance.reset();
                        }
                    } catch (e) {
                        console.warn('[CanvasManager] jsPlumb reset failed:', e);
                    }
                    
                    // 清除所有拖拽元素
                    this.nodes.forEach((nodeElement) => {
                        if (nodeElement) {
                            try {
                                this.jsPlumbInstance.remove(nodeElement);
                            } catch (e) {
                                console.warn('[CanvasManager] Error removing JSPlumb element:', e);
                            }
                        }
                    });
                } catch (error) {
                    console.warn('[CanvasManager] Error clearing JSPlumb elements:', error);
                }
            }
            
            // 清空内部状态
            this.nodes.clear();
            this.connections.clear();
            
            // 清空DOM内容
            if (this.content) {
                // 确保彻底清空所有子元素
                while (this.content.firstChild) {
                    this.content.removeChild(this.content.firstChild);
                }
                this.content.innerHTML = '';
            }
            
            console.log('[CanvasManager] Canvas cleared successfully');
        }

        // 恢复连接（专门用于工作流加载，避免重复检测）
        restoreConnections(connections) {
            console.log('[CanvasManager] Starting connection restoration, total:', connections.length);

            if (!this.jsPlumbInstance) {
                console.error('[CanvasManager] JSPlumb instance not available for connection restoration');
                return;
            }

            // 添加端点存在性检查
            let totalConnectionsProcessed = 0;
            let failedConnections = 0;

            connections.forEach((connectionData, index) => {
                setTimeout(() => {
                    console.log(`[CanvasManager] Restoring connection ${index + 1}/${connections.length} at ${Date.now()}:`, connectionData.id);
                    totalConnectionsProcessed++;

                    const sourceNode = this.nodes.get(connectionData.sourceNodeId);
                    const targetNode = this.nodes.get(connectionData.targetNodeId);

                    if (!sourceNode || !targetNode) {
                        console.warn(`[CanvasManager] Cannot restore connection - nodes not found. Source: ${connectionData.sourceNodeId}, Target: ${connectionData.targetNodeId}`);
                        failedConnections++;
                        return;
                    }

                    // 检查连接是否已经存在
                    if (this.connections.has(connectionData.id)) {
                        console.log('[CanvasManager] Connection already restored:', connectionData.id);
                        return;
                    }

                    try {
                        // 查找正确的目标端点
                        let targetElement = targetNode;
                        let sourceElement = sourceNode;

                        console.log(`[CanvasManager] Looking for endpoints - Source: ${connectionData.sourceNodeId}, Target: ${connectionData.targetNodeId}, TargetParam: ${connectionData.targetParam}`);

                        // 如果连接有特定的目标参数，查找对应的参数输入框
                        if (connectionData.targetParam && connectionData.targetParam !== 'input') {
                            const paramInput = targetNode.querySelector(`[data-param="${connectionData.targetParam}"]`);
                            if (paramInput) {
                                targetElement = paramInput;
                                console.log(`[CanvasManager] Found specific param input for ${connectionData.targetParam}`);
                            } else {
                                console.error(`[CanvasManager] Target param input not found: ${connectionData.targetParam} on node ${connectionData.targetNodeId}`);
                                // 尝试查找所有参数输入框作为调试信息
                                const allParams = targetNode.querySelectorAll('[data-param]');
                                console.log('[CanvasManager] Available param inputs:', Array.from(allParams).map(p => p.getAttribute('data-param')));
                                failedConnections++;
                                return;
                            }
                        }

                        // 查找源端点（通常是输出端点）
                        if (connectionData.sourceParam && connectionData.sourceParam !== 'output') {
                            const sourceParam = sourceNode.querySelector(`[data-param="${connectionData.sourceParam}"]`);
                            if (sourceParam) {
                                sourceElement = sourceParam;
                            }
                        }

                        console.log(`[CanvasManager] Creating connection between elements - Source:`, sourceElement, 'Target:', targetElement);

                        // 检查元素是否已经准备好
                        if (!document.contains(sourceElement) || !document.contains(targetElement)) {
                            console.error('[CanvasManager] Elements not in DOM, skipping connection:', {
                                sourceInDOM: document.contains(sourceElement),
                                targetInDOM: document.contains(targetElement)
                            });
                            failedConnections++;
                            return;
                        }

                        // 直接创建JSPlumb连接，不触发事件处理
                        const connection = this.jsPlumbInstance.connect({
                            source: sourceElement,
                            target: targetElement,
                            anchor: ['Right', 'Left'],
                            connector: ['Bezier', { curviness: 50 }],
                            paintStyle: { stroke: '#3b82f6', strokeWidth: 2 },
                            hoverPaintStyle: { stroke: '#1d4ed8', strokeWidth: 3 },
                            overlays: [
                                ['Arrow', {
                                    location: 1,
                                    visible: true,
                                    width: 11,
                                    length: 11,
                                    id: 'arrow'
                                }]
                            ],
                            parameters: {
                                connectionId: connectionData.id,
                                sourceNodeId: connectionData.sourceNodeId,
                                targetNodeId: connectionData.targetNodeId,
                                targetParam: connectionData.targetParam
                            },
                            // 关键：不触发连接事件，避免重复检测
                            doNotFireConnectionEvent: true
                        });

                        if (connection) {
                            // 标记为恢复的连接，避免被重复检测删除
                            connection._restoredConnection = true;
                            connection._programmaticConnection = true;
                            connection.connectionId = connectionData.id;
                            this.connections.set(connectionData.id, connection);
                            
                            // 重要：将恢复的连接添加到状态管理器中，确保保存时不会丢失
                            if (this.stateManager && this.stateManager.addConnection) {
                                // 使用 skipRender=true 避免重复渲染，recordHistory=false 避免记录历史
                                const addResult = this.stateManager.addConnection(connectionData, true, false);
                                if (addResult) {
                                    console.log(`[CanvasManager] ✅ Connection added to StateManager: ${connectionData.id}`);
                                } else {
                                    console.warn(`[CanvasManager] ⚠️ Failed to add connection to StateManager: ${connectionData.id}`);
                                    // 强制添加到状态管理器的连接映射中
                                    if (this.stateManager.state && this.stateManager.state.connections) {
                                        this.stateManager.state.connections.set(connectionData.id, connectionData);
                                        console.log(`[CanvasManager] 🔧 Force added connection to StateManager: ${connectionData.id}`);
                                    }
                                }
                            } else {
                                console.error('[CanvasManager] StateManager or addConnection method not available');
                                // 如果状态管理器不可用，尝试直接访问状态
                                if (window.WorkflowEditor_StateManager && window.WorkflowEditor_StateManager.state) {
                                    window.WorkflowEditor_StateManager.state.connections.set(connectionData.id, connectionData);
                                    console.log(`[CanvasManager] 🔧 Force added connection via global StateManager: ${connectionData.id}`);
                                }
                            }
                            
                            console.log(`[CanvasManager] ✅ Connection restored successfully: ${connectionData.sourceNodeId} -> ${connectionData.targetNodeId} (${connectionData.targetParam}) at ${Date.now()}`);
                        } else {
                            console.error('[CanvasManager] ❌ Failed to restore connection:', connectionData.id, '- jsPlumb.connect returned null');
                            failedConnections++;
                        }
                    } catch (error) {
                        console.error('[CanvasManager] ❌ Error restoring connection:', error, connectionData);
                        failedConnections++;
                    }

                    // 在最后一个连接处理完成后输出统计信息
                    if (totalConnectionsProcessed === connections.length) {
                        console.log(`[CanvasManager] Connection restoration completed: ${totalConnectionsProcessed - failedConnections}/${totalConnectionsProcessed} successful, ${failedConnections} failed`);
                    }
                }, index * 100); // 每个连接间隔100ms，避免并发问题
            });

            // 全部连接恢复后，针对图片上传节点及其目标节点做一次安全 revalidate
            try {
                const totalDelay = (connections?.length || 0) * 100 + 150;
                console.log(`[CanvasManager] Scheduling post-restore revalidate in ${totalDelay}ms`);
                setTimeout(() => {
                    console.log('[CanvasManager] Starting post-restore revalidate at', Date.now());
                    const imageUploadNodeIds = [];
                    this.nodes.forEach((el, id) => {
                        if (el && el.classList && el.classList.contains('image-upload')) {
                            imageUploadNodeIds.push(id);
                        }
                    });

                    console.log('[CanvasManager] Found image upload nodes:', imageUploadNodeIds);

                    // 从连接列表中找出图片上传节点的目标节点
                    const targetNodeIds = new Set();
                    if (Array.isArray(connections)) {
                        connections.forEach(c => {
                            if (imageUploadNodeIds.includes(c.sourceNodeId)) {
                                targetNodeIds.add(c.targetNodeId);
                            }
                        });
                    }

                    const uniqueIds = new Set([...imageUploadNodeIds, ...targetNodeIds]);
                    console.log('[CanvasManager] Nodes requiring revalidate:', Array.from(uniqueIds));
                    let revalidateCount = 0;
                    uniqueIds.forEach(id => {
                        if (typeof this.revalidateNodeSafe === 'function') {
                            this.revalidateNodeSafe(id);
                            revalidateCount++;
                        }
                    });
                    console.log(`[CanvasManager] Revalidate completed for ${revalidateCount} nodes at`, Date.now());
                }, totalDelay);
            } catch (e) {
                console.warn('[CanvasManager] Post-restore revalidate failed:', e);
            }
        }

        // 获取画布数据
        getCanvasData() {
            return {
                nodes: Array.from(this.nodes.keys()),
                connections: Array.from(this.connections.keys())
            };
        }
    }

    // 导出为全局单例
    window.WorkflowEditor_CanvasManager = WorkflowEditor_CanvasManager.getInstance();
})();