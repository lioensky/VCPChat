// WorkflowEditor UI Manager Module
(function() {
    'use strict';

    class WorkflowEditor_UIManager {
        constructor() {
            if (WorkflowEditor_UIManager.instance) {
                return WorkflowEditor_UIManager.instance;
            }
            
            this.container = null;
            this.isVisible = false;
            this.stateManager = null;
			this.nodeManager = null;
            this.connectionManager = null; // 连接管理器
            this.searchTimeout = null; // 添加搜索防抖定时器
            
            WorkflowEditor_UIManager.instance = this;
        }

        static getInstance() {
            if (!WorkflowEditor_UIManager.instance) {
                WorkflowEditor_UIManager.instance = new WorkflowEditor_UIManager();
            }
            return WorkflowEditor_UIManager.instance;
        }

        // 初始化UI
        init(stateManager) {
            this.stateManager = stateManager;
			this.nodeManager = window.WorkflowEditor_NodeManager || null;
            
            // 初始化简化版连接管理器
            if (window.WorkflowEditor_ConnectionManager_Simplified) {
                this.connectionManager = new window.WorkflowEditor_ConnectionManager_Simplified();
                console.log('[WorkflowEditor_UIManager] Simplified ConnectionManager initialized');
            } else {
                console.warn('[WorkflowEditor_UIManager] Simplified ConnectionManager not available');
            }
            
            this.createContainer();
            this.bindEvents();
            this.setExecutionState(false); // 确保初始状态下“停止执行”按钮是隐藏的

            
            console.log('[WorkflowEditor_UIManager] Initialized');
        }

        // 创建主容器
        createContainer() {
            // 移除已存在的容器
            const existing = document.getElementById('workflowEditorContainer');
            if (existing) {
                existing.remove();
            }

            this.container = document.createElement('div');
            this.container.id = 'workflowEditorContainer';
            this.container.className = 'workflow-editor-container';
            
            this.container.innerHTML = `
                <!-- 顶部工具栏 - 分为上下两部分 -->
                <div class="workflow-toolbar">
                    <!-- 标题部分 - 撑住不可点击区域 -->
                    <div class="workflow-toolbar-header">
                        <div class="workflow-logo">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                            </svg>
                            VCP 工作流编排
                        </div>
                    
                    </div>
                    <!-- 按钮部分 - 完全可点击 -->
                    <div class="workflow-toolbar-actions">
                        <button class="workflow-btn" id="newWorkflowBtn">新建</button>
                        <button class="workflow-btn" id="loadWorkflowBtn">加载</button>
                        <button class="workflow-btn" id="saveWorkflowBtn">保存</button>
                        <button class="workflow-btn secondary" id="exportWorkflowBtn">导出</button>
                        <button class="workflow-btn success" id="executeWorkflowBtn">▶️ 执行工作流</button>
                        <button class="workflow-btn danger" id="stopWorkflowBtn">⏹️ 停止执行</button>
                    
                        <button class="workflow-btn secondary" id="apiConfigBtn">API配置</button>
                        <button class="workflow-btn danger" id="closeWorkflowBtn">关闭</button>
                    </div>
                </div>

                <!-- 主内容区域 -->
                <div class="workflow-main">
                    <!-- 左侧插件面板 -->
                    <div class="workflow-sidebar">
                        <div class="sidebar-header">
                            <input type="text" class="sidebar-search" id="pluginSearch" placeholder="搜索插件...">
                        </div>
                        <div class="sidebar-content" id="pluginPanel">
                            <div class="plugin-category">
                                <div class="category-title">VCPChat 插件</div>
                                <div id="vcpChatPlugins"></div>
                            </div>
                            <div class="plugin-category">
                                <div class="category-title">VCPToolBox 插件</div>
                                <div id="vcpToolBoxPlugins"></div>
                            </div>
                            <div class="plugin-category">
                                <div class="category-title">辅助节点</div>
                                <div id="auxiliaryNodes"></div>
                            </div>
                        </div>
                    </div>

                    <!-- 中央画布区域 -->
                    <div class="workflow-canvas" id="workflowCanvas">
                        <div class="canvas-container">
                            <div class="canvas-viewport" id="canvasViewport">
                                <div class="canvas-content" id="canvasContent">
                                    <!-- 画布内容将在这里动态生成 -->
                                </div>
                                <svg class="canvas-connections" id="canvasConnections">
                                    <!-- 连接线将在这里动态生成 -->
                                </svg>
                            </div>
                        </div>
                    </div>

                    <!-- 右侧属性面板 -->
                    <div class="workflow-properties">
                        <div class="properties-header">
                            <div class="properties-title">属性配置</div>
                        </div>
                        <div class="properties-content" id="propertiesContent">
                            <div style="text-align: center; color: #94a3b8; margin-top: 40px;">
                                选择一个节点来配置属性
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 底部状态栏 -->
                <div class="workflow-statusbar">
                    <div class="status-item">
                        <div class="status-indicator" id="workflowStatus"></div>
                        <span id="workflowStatusText">就绪</span>
                    </div>
                    <div class="status-item">
                        <span>节点: <span id="nodeCount">0</span></span>
                    </div>
                    <div class="status-item">
                        <span>连接: <span id="connectionCount">0</span></span>
                    </div>
                    <div class="zoom-controls">
                        <button class="zoom-btn" id="zoomOutBtn">-</button>
                        <div class="zoom-level" id="zoomLevel">100%</div>
                        <button class="zoom-btn" id="zoomInBtn">+</button>
                        <button class="zoom-btn" id="zoomFitBtn">适应</button>
                    </div>
                </div>

                <!-- 拖拽覆盖层 -->
                <div class="drag-overlay" id="dragOverlay"></div>
                <div class="drag-preview" id="dragPreview"></div>
            `;

            document.body.appendChild(this.container);
        }

        // 绑定事件
        bindEvents() {
            // 工具栏事件
            this.bindElement('newWorkflowBtn', 'click', () => this.newWorkflow());
            this.bindElement('loadWorkflowBtn', 'click', () => this.loadWorkflow());
            this.bindElement('saveWorkflowBtn', 'click', () => this.saveWorkflow());
            this.bindElement('exportWorkflowBtn', 'click', () => this.exportWorkflow());
            this.bindElement('executeWorkflowBtn', 'click', () => this.executeWorkflow());
            this.bindElement('stopWorkflowBtn', 'click', () => this.stopWorkflow());
            this.bindElement('pluginManagerBtn', 'click', () => this.showPluginManager());
            this.bindElement('apiConfigBtn', 'click', () => this.showApiConfig());
            this.bindElement('closeWorkflowBtn', 'click', () => this.hide());

            // 工作流标题输入
            this.bindElement('workflowTitleInput', 'input', (e) => {
                this.stateManager.setWorkflowName(e.target.value);
            });

            // 插件搜索 - 添加防抖和状态保护
            // 插件搜索 - 添加防抖和状态保护，防止键盘事件冲突
            this.bindElement('pluginSearch', 'input', (e) => {
                // 阻止事件冒泡，防止触发全局键盘事件
                e.stopPropagation();
                
                // 清除之前的搜索定时器
                if (this.searchTimeout) {
                    clearTimeout(this.searchTimeout);
                }
                
                // 防抖处理，避免频繁搜索
                this.searchTimeout = setTimeout(() => {
                    // 保护画布状态，确保搜索不影响已存在的节点
                    const canvasNodes = document.querySelectorAll('#canvasContent .canvas-node');
                    const canvasNodeCount = canvasNodes.length;
                    
                    // 执行搜索
                    this.filterPlugins(e.target.value);
                    
                    // 验证画布节点是否受到影响
                    const newCanvasNodes = document.querySelectorAll('#canvasContent .canvas-node');
                    if (newCanvasNodes.length !== canvasNodeCount) {
                        console.warn('[UIManager] Canvas nodes affected by search, restoring...');
                        // 如果画布节点受到影响，触发画布重新渲染
                        if (this.stateManager) {
                            this.stateManager.emit('canvasNeedsRefresh');
                        }
                    }
                }, 300); // 300ms 防抖延迟
            });

            // 为搜索框添加额外的键盘事件保护
            const pluginSearchElement = document.getElementById('pluginSearch');
            if (pluginSearchElement) {
                // 防止搜索框的键盘事件影响画布操作
                pluginSearchElement.addEventListener('keydown', (e) => {
                    e.stopPropagation();
                    console.log('[UIManager] Plugin search keydown event stopped:', e.key);
                });
                
                pluginSearchElement.addEventListener('keyup', (e) => {
                    e.stopPropagation();
                });
                
                pluginSearchElement.addEventListener('focus', (e) => {
                    console.log('[UIManager] Plugin search focused');
                });
                
                pluginSearchElement.addEventListener('blur', (e) => {
                    console.log('[UIManager] Plugin search blurred');
                });
            }

            // 缩放控制
            this.bindElement('zoomInBtn', 'click', () => this.zoomIn());
            this.bindElement('zoomOutBtn', 'click', () => this.zoomOut());
            this.bindElement('zoomFitBtn', 'click', () => this.zoomFit());

            // 状态管理器事件监听
            // 全局键盘事件处理 - 防止删除节点与输入框冲突
            document.addEventListener('keydown', (e) => {
                // 检查当前焦点是否在输入框、文本区域或可编辑元素上
                const activeElement = document.activeElement;
                const isInputFocused = activeElement && (
                    activeElement.tagName === 'INPUT' ||
                    activeElement.tagName === 'TEXTAREA' ||
                    activeElement.tagName === 'SELECT' ||
                    activeElement.isContentEditable ||
                    activeElement.classList.contains('property-input') ||
                    activeElement.classList.contains('sidebar-search') ||
                    activeElement.classList.contains('workflow-title-input') ||
                    activeElement.closest('.plugin-dialog') ||
                    activeElement.closest('.api-config-dialog') ||
                    activeElement.closest('.workflow-save-dialog') ||
                    activeElement.closest('.workflow-load-dialog')
                );
                
                // 只有在没有输入框获得焦点时才处理删除节点
                if (e.key === 'Delete' && !isInputFocused) {
                    const selectedNodes = this.stateManager.getSelectedNodes();
                    if (selectedNodes.length > 0) {
                        e.preventDefault();
                        selectedNodes.forEach(nodeId => {
                            this.stateManager.removeNode(nodeId);
                        });
                        console.log('[UIManager] Deleted selected nodes:', selectedNodes);
                    }
                }
                
                // ESC键取消选择
                if (e.key === 'Escape' && !isInputFocused) {
                    this.stateManager.clearSelection();
                }
            });

            // 状态管理器事件监听
            if (this.stateManager) {
                this.stateManager.on('workflowNameChanged', (data) => {
                    const input = document.getElementById('workflowTitleInput');
                    if (input && input.value !== data.value) {
                        input.value = data.value;
                    }
                });

				this.stateManager.on('nodeAdded', (node) => {
					this.updateStats();
					// 如果只选中该节点，则渲染属性
					const selected = this.stateManager.getSelectedNodes();
					if (selected.length === 1 && selected[0] === node.id) {
						this.renderPropertiesPanel(node);
					}
				});
                this.stateManager.on('nodeRemoved', () => this.updateStats());
                this.stateManager.on('connectionAdded', () => this.updateStats());
                this.stateManager.on('connectionRemoved', () => this.updateStats());
                this.stateManager.on('canvasZoomChanged', (data) => this.updateZoomDisplay(data.value));
				this.stateManager.on('selectionChanged', (data) => {
					if (data.selectedNodes.length === 1) {
						const node = this.stateManager.getNode(data.selectedNodes[0]);
						this.renderPropertiesPanel(node);
					} else {
						this.clearPropertiesPanel();
					}
				});
				this.stateManager.on('nodeUpdated', (data) => {
					const selected = this.stateManager.getSelectedNodes();
					if (selected.length === 1 && selected[0] === data.nodeId) {
						// 检查是否是配置更新，如果是则不重新渲染属性面板
						if (data.updates && data.updates.config && Object.keys(data.updates).length === 1) {
							// 只是配置更新，不重新渲染整个属性面板
							console.log('[UIManager] Config-only update, skipping properties panel re-render');
							return;
						}
						this.renderPropertiesPanel(data.node);
					}
				});

				// 监听工作流加载事件 - 禁用自动重建，由加载方法手动处理
				this.stateManager.on('workflowLoaded', (data) => {
					console.log('[UIManager] Workflow loaded event received, skipping auto-rebuild');
					// 不自动重建画布，由 loadWorkflowFromStorage 方法手动处理
				});
            }

            // 插件管理器事件监听
            document.addEventListener('pluginManagerRefreshed', async (e) => {
                console.log('[UIManager] Plugin manager refreshed, updating plugin panel');
                await this.refreshPluginPanel();
            });

            document.addEventListener('pluginManagerConfigNeeded', (e) => {
                console.log('[UIManager] Plugin manager config needed');
                this.showToast('请配置API服务器以获取远程插件', 'warning');
            });

            document.addEventListener('pluginManagerError', (e) => {
                console.log('[UIManager] Plugin manager error:', e.detail.message);
                this.showToast(e.detail.message, 'error');
            });
        }

        // 绑定元素事件的辅助方法
        bindElement(id, event, handler) {
            const element = document.getElementById(id);
            if (element) {
                element.addEventListener(event, handler);
            }
        }

        // 显示工作流编辑器
        show() {
            if (this.container) {
                this.container.classList.add('active');
                this.isVisible = true;
                this.stateManager.set('isVisible', true);
                
                // 初始化 ConnectionManager 与其他组件的连接
                if (this.connectionManager && !this.connectionManager.isInitialized) {
                    const canvasManager = window.WorkflowEditor_CanvasManager;
                    this.connectionManager.initialize(this.stateManager, canvasManager);
                    
                    console.log('[UIManager] ConnectionManager 初始化完成');
                }
                
                this.initializePluginPanel();
                this.updateStats();
            }
        }

        // 隐藏工作流编辑器
        hide() {
            if (this.container) {
                this.container.classList.remove('active');
                this.isVisible = false;
                this.stateManager.set('isVisible', false);
            }
        }

        // 初始化插件面板
        async initializePluginPanel() {
            // 等待插件管理器初始化完成
            if (window.WorkflowEditor_PluginManager) {
                await this.loadDynamicPlugins();
            } else {
                // 如果插件管理器未初始化，使用静态插件
                this.loadVCPChatPlugins();
                this.loadVCPToolBoxPlugins();
            }
			this.loadAuxiliaryNodes();
        }

        // 加载动态发现的插件
        async loadDynamicPlugins() {
            const pluginManager = window.WorkflowEditor_PluginManager;
            
            console.log('[UIManager] Loading dynamic plugins...');
            
            // 加载VCPChat插件（包含带云端标识的远程插件）
            const vcpChatPlugins = pluginManager.getPluginsByCategory('vcpChat');
            this.renderPluginCategory('vcpChatPlugins', vcpChatPlugins, 'vcpChat');
            console.log('[UIManager] Loaded VCPChat plugins:', vcpChatPlugins.length);
            
            // 加载VCPToolBox插件（包含不带云端标识的远程插件）
            const vcpToolBoxPlugins = pluginManager.getPluginsByCategory('vcpToolBox');
            this.renderPluginCategory('vcpToolBoxPlugins', vcpToolBoxPlugins, 'vcpToolBox');
            console.log('[UIManager] Loaded VCPToolBox plugins:', vcpToolBoxPlugins.length);
            
            // 加载自定义插件
            const customPlugins = pluginManager.getPluginsByCategory('custom');
            console.log('[UIManager] Found custom plugins:', customPlugins.length);
            
            if (customPlugins.length > 0) {
                this.renderCustomPluginCategory(customPlugins);
            } else {
                // 如果没有自定义插件，移除自定义插件分类
                const existingCustomCategory = document.querySelector('.plugin-category.custom');
                if (existingCustomCategory) {
                    existingCustomCategory.remove();
                }
            }
        }

        // 渲染插件分类
        renderPluginCategory(containerId, plugins, category) {
            const container = document.getElementById(containerId);
            if (!container) return;

            container.innerHTML = '';
            plugins.forEach(plugin => {
                const node = this.createPluginNode({
                    id: plugin.id,
                    name: plugin.name,
                    desc: plugin.description || '暂无描述',
                    icon: this.getPluginIcon(plugin.icon)
                }, category);
                container.appendChild(node);
            });
        }

        // 渲染自定义插件分类
        renderCustomPluginCategory(customPlugins) {
            console.log('[UIManager] Rendering custom plugin category with', customPlugins.length, 'plugins');
            
            // 检查是否已存在自定义插件分类
            let customCategory = document.querySelector('.plugin-category.custom');
            if (!customCategory) {
                // 创建自定义插件分类
                customCategory = document.createElement('div');
                customCategory.className = 'plugin-category custom';
                customCategory.innerHTML = `
                    <div class="category-title">自定义插件</div>
                    <div id="customPlugins"></div>
                `;
                
                // 插入到辅助节点之前
                const auxiliaryCategory = document.querySelector('.plugin-category:last-child');
                const sidebarContent = document.getElementById('pluginPanel');
                if (auxiliaryCategory && sidebarContent) {
                    sidebarContent.insertBefore(customCategory, auxiliaryCategory);
                    console.log('[UIManager] Created custom plugin category');
                } else {
                    // 如果没有找到辅助节点分类，直接添加到末尾
                    const sidebarContent = document.getElementById('pluginPanel');
                    if (sidebarContent) {
                        sidebarContent.appendChild(customCategory);
                        console.log('[UIManager] Added custom plugin category to end');
                    }
                }
            }

            // 渲染自定义插件
            const container = document.getElementById('customPlugins');
            if (container) {
                container.innerHTML = '';
                customPlugins.forEach(plugin => {
                    const node = this.createPluginNode({
                        id: plugin.id,
                        name: plugin.name,
                        desc: plugin.description || '暂无描述',
                        icon: this.getPluginIcon(plugin.icon)
                    }, 'custom');
                    container.appendChild(node);
                    console.log('[UIManager] Added custom plugin node:', plugin.name);
                });
                console.log('[UIManager] Custom plugin category rendered successfully');
            } else {
                console.error('[UIManager] Custom plugins container not found');
            }
        }

        // 获取插件图标
        getPluginIcon(iconName) {
            const iconMap = {
                'extension': '🧩',
                'plugin': '🔌',
                'tool': '🔧',
                'code': '💻',
                'data': '📊',
                'transform': '🔄',
                'chat': '💬',
                'music': '🎵',
                'note': '📝',
                'search': '🔍',
                'task': '✅',
                'image': '🎨',
                'video': '🎬'
            };
            return iconMap[iconName] || '🔌';
        }

        // 刷新插件面板
        async refreshPluginPanel() {
            console.log('[UIManager] Refreshing plugin panel...');
            await this.initializePluginPanel();
            
            // 强制重新渲染插件面板
            if (window.WorkflowEditor_PluginManager) {
                await this.loadDynamicPlugins();
            }
            
            console.log('[UIManager] Plugin panel refreshed');
        }

        // 加载VCPChat插件
        loadVCPChatPlugins() {
            const container = document.getElementById('vcpChatPlugins');
            if (!container) return;

            const plugins = [
                { id: 'assistant', name: 'AI助手', desc: '智能对话助手', icon: '🤖' },
                { id: 'music', name: '音乐播放', desc: '音乐播放控制', icon: '🎵' },
                { id: 'note', name: '笔记管理', desc: '笔记记录和管理', icon: '📝' },
                { id: 'search', name: '搜索引擎', desc: '网络搜索功能', icon: '🔍' }
            ];

            container.innerHTML = '';
            plugins.forEach(plugin => {
                const node = this.createPluginNode(plugin, 'vcpChat');
                container.appendChild(node);
            });
        }

        // 加载VCPToolBox插件
        loadVCPToolBoxPlugins() {
            const container = document.getElementById('vcpToolBoxPlugins');
            if (!container) return;

            const plugins = [
                { id: 'TodoManager', name: '任务管理', desc: '待办事项管理', icon: '✅' },
                { id: 'FluxGen', name: '图像生成', desc: 'AI图像生成工具', icon: '🎨' },
                { id: 'ComfyUIGen', name: 'ComfyUI', desc: 'ComfyUI图像生成', icon: '🖼️' },
                { id: 'BilibiliFetch', name: 'B站数据', desc: 'B站视频信息获取', icon: '📺' },
                { id: 'VideoGenerator', name: '视频生成', desc: '视频内容生成', icon: '🎬' }
            ];

            container.innerHTML = '';
            plugins.forEach(plugin => {
                const node = this.createPluginNode(plugin, 'vcpToolBox');
                container.appendChild(node);
            });
        }

		// 加载辅助节点（动态从节点管理器获取定义）
		loadAuxiliaryNodes() {
			const container = document.getElementById('auxiliaryNodes');
			if (!container) return;
			container.innerHTML = '';
			let nodes = [];
			try {
				if (this.nodeManager && this.nodeManager.getAllNodeTypes) {
					const allTypes = this.nodeManager.getAllNodeTypes();
					allTypes.forEach(([type, def]) => {
						if (def.category === 'auxiliary') {
							const meta = this.getAuxiliaryMeta(type);
							nodes.push({ id: type, name: meta.name, desc: meta.desc, icon: meta.icon });
						}
					});
				}
			} catch (e) {
				console.warn('[UIManager] loadAuxiliaryNodes fallback due to error:', e.message);
			}
			if (nodes.length === 0) {
				nodes = [
					{ id: 'regex', name: '正则处理', desc: '文本正则表达式处理', icon: '🔤' },
					{ id: 'dataTransform', name: '数据转换', desc: '数据格式转换', icon: '🔄' },
					{ id: 'codeEdit', name: '代码编辑', desc: '代码处理和编辑', icon: '💻' },
					{ id: 'condition', name: '条件判断', desc: '条件分支控制', icon: '🔀' },
					{ id: 'loop', name: '循环控制', desc: '循环执行控制', icon: '🔁' },
					{ id: 'delay', name: '延时等待', desc: '延时执行控制', icon: '⏱️' }
				];
			}
			nodes.forEach(node => {
				const nodeElement = this.createPluginNode(node, 'auxiliary');
				container.appendChild(nodeElement);
			});
		}

		// 获取辅助节点的展示元数据
		getAuxiliaryMeta(type) {
			const map = {
				regex: { name: '正则处理', desc: '文本正则表达式处理', icon: '🔤' },
				dataTransform: { name: '数据转换', desc: '数据格式转换', icon: '🔄' },
				codeEdit: { name: '代码编辑', desc: '代码处理和编辑', icon: '💻' },
				condition: { name: '条件判断', desc: '条件分支控制', icon: '🔀' },
				loop: { name: '循环控制', desc: '循环执行控制', icon: '🔁' },
                loopStart: { name: '循环开始', desc: '循环子图入口，遍历数组/计数/条件循环', icon: '🔄▶' },
                loopEnd: { name: '循环结束', desc: '循环子图出口，收集迭代结果', icon: '🔄⏹' },
                variableAggregator: { name: '变量聚合器', desc: '多路输入合并为统一输出', icon: '🔀📦' },
				delay: { name: '延时等待', desc: '延时执行控制', icon: '⏱️' },
				urlRenderer: { name: 'URL渲染器', desc: '实时渲染URL内容', icon: '🖼️' },
				contentInput: { name: '内容输入器', desc: '提供文本内容作为工作流输入', icon: '📝' },
				urlExtractor: { name: 'URL提取器', desc: '从数据中提取URL链接', icon: '🔗' },
				imageUpload: { name: '图片上传器', desc: '上传图片并转换为base64格式', icon: '📷' }
			};
			return map[type] || { name: type, desc: '辅助处理节点', icon: '⚙️' };
		}

        // 创建插件节点元素
        createPluginNode(plugin, category) {
            const node = document.createElement('div');
            node.className = 'plugin-node';
            node.draggable = true;
            node.dataset.pluginId = plugin.id;
            node.dataset.category = category;

            node.innerHTML = `
                <div class="plugin-node-header">
                    <span class="plugin-node-icon">${plugin.icon}</span>
                    <span class="plugin-node-name">${plugin.name}</span>
                </div>
                <div class="plugin-node-desc">${plugin.desc}</div>
            `;

            // 绑定拖拽事件
            node.addEventListener('dragstart', (e) => this.handleDragStart(e, plugin, category));
            node.addEventListener('dragend', (e) => this.handleDragEnd(e));

            return node;
        }

        // 处理拖拽开始
        handleDragStart(e, plugin, category) {
            const dragOverlay = document.getElementById('dragOverlay');
            const dragPreview = document.getElementById('dragPreview');
            
            if (dragOverlay) dragOverlay.classList.add('active');
            if (dragPreview) {
                dragPreview.textContent = plugin.name;
                dragPreview.style.display = 'block';
            }

            e.dataTransfer.setData('application/json', JSON.stringify({
                plugin,
                category
            }));

            // 绑定画布拖拽事件
            const canvas = document.getElementById('workflowCanvas');
            if (canvas) {
                canvas.addEventListener('dragover', this.handleCanvasDragOver);
                canvas.addEventListener('drop', this.handleCanvasDrop);
            }
        }

        // 处理拖拽结束
        handleDragEnd(e) {
            const dragOverlay = document.getElementById('dragOverlay');
            const dragPreview = document.getElementById('dragPreview');
            
            if (dragOverlay) dragOverlay.classList.remove('active');
            if (dragPreview) dragPreview.style.display = 'none';

            // 移除画布拖拽事件
            const canvas = document.getElementById('workflowCanvas');
            if (canvas) {
                canvas.removeEventListener('dragover', this.handleCanvasDragOver);
                canvas.removeEventListener('drop', this.handleCanvasDrop);
            }
        }

        // 处理画布拖拽悬停
        handleCanvasDragOver = (e) => {
            e.preventDefault();
            const dragPreview = document.getElementById('dragPreview');
            if (dragPreview) {
                dragPreview.style.left = e.clientX + 'px';
                dragPreview.style.top = e.clientY + 'px';
            }
        }

        // 处理画布放置
		handleCanvasDrop = (e) => {
            e.preventDefault();
            
            try {
                const data = JSON.parse(e.dataTransfer.getData('application/json'));
                const canvasRect = document.getElementById('workflowCanvas').getBoundingClientRect();
                const canvasOffset = this.stateManager.getCanvasOffset();
                const canvasZoom = this.stateManager.getCanvasZoom();
                
                // 计算在画布坐标系中的位置
                const x = (e.clientX - canvasRect.left - canvasOffset.x) / canvasZoom;
                const y = (e.clientY - canvasRect.top - canvasOffset.y) / canvasZoom;

					let nodeData;
					if (data.category === 'auxiliary') {
						nodeData = {
							type: 'auxiliary',
							name: data.plugin.name,
							pluginId: data.plugin.id,
							category: data.category,
							position: { x, y },
							config: this.getDefaultConfigForNode(data),
							inputs: ['input'],
							outputs: ['output']
						};
					} else {
						// 插件节点，带指令与参数
						const pluginInfo = this.getFullPluginInfo(data.category, data.plugin.id);
						const firstCommand = pluginInfo && Array.isArray(pluginInfo.commands) && pluginInfo.commands.length > 0 ? pluginInfo.commands[0] : null;
						const mergedSchema = this.mergeSchemas(
							pluginInfo ? (pluginInfo.configSchema || {}) : {},
							firstCommand ? (firstCommand.paramsSchema || {}) : {}
						);
						const defaultConfig = this.getDefaultsFromSchema(mergedSchema);
						nodeData = {
							type: data.category === 'vcpChat' ? 'vcpChat' : 'VCPToolBox',
							name: data.plugin.name,
							pluginId: data.plugin.id,
							category: data.category,
							position: { x, y },
							config: defaultConfig,
							command: firstCommand ? firstCommand.id : 'default',
							commandId: firstCommand ? firstCommand.id : 'default',
							inputs: firstCommand ? (firstCommand.inputs || ['trigger']) : ['trigger'],
							outputs: firstCommand ? (firstCommand.outputs || ['result', 'error']) : ['result', 'error']
						};
					}

                const newNode = this.stateManager.addNode(nodeData);
                
                // 如果是插件节点且有指令，生成动态输入端点
                // 如果是插件节点且有指令，生成动态输入端点
                if (nodeData.type === 'VCPToolBox' || nodeData.type === 'vcpChat') {
                    setTimeout(() => {
                        console.log('[UIManager] Setting up dynamic inputs for plugin node');
                        const pluginInfo = this.getFullPluginInfo(data.category, data.plugin.id);
                        const firstCommand = pluginInfo && Array.isArray(pluginInfo.commands) && pluginInfo.commands.length > 0 ? pluginInfo.commands[0] : null;
                        
                        console.log('[UIManager] Calling updateNodeInputsForCommand on node creation:', {
                            nodeId: newNode.id,
                            commandId: firstCommand ? firstCommand.id : 'unknown',
                            pluginKey: `${data.category}_${data.plugin.id}`
                        });
                        
                        if (this.nodeManager && this.nodeManager.updateNodeInputsForCommand && firstCommand) {
                            const pluginKey = `${data.category}_${data.plugin.id}`;
                            this.nodeManager.updateNodeInputsForCommand(newNode.id, firstCommand.id, pluginKey);
                        }
                    }, 100); // 延迟执行，确保节点已经渲染完成
                }
            } catch (error) {
                console.error('Failed to create node:', error);
            }
        }

		// 获取节点默认配置
		getDefaultConfigForNode(data) {
			if (data.category === 'auxiliary' && this.nodeManager && this.nodeManager.getNodeConfigTemplate) {
				try {
					console.log('[UIManager] Getting default config for:', data.plugin.id);
					const config = this.nodeManager.getNodeConfigTemplate(data.plugin.id);
					console.log('[UIManager] Default config result:', config);
					return config;
				} catch (e) {
					console.warn('[UIManager] getDefaultConfigForNode fallback:', e.message);
				}
			}
			return {};
		}

		// 根据schema获取默认值对象
		getDefaultsFromSchema(schema) {
			const result = {};
			Object.entries(schema || {}).forEach(([k, def]) => {
				if (def && Object.prototype.hasOwnProperty.call(def, 'default')) {
					result[k] = def.default;
				} else {
					result[k] = def && def.type === 'number' ? 0 : def && def.type === 'boolean' ? false : '';
				}
			});
			return result;
		}

		// 合并两个schema（后者优先）
		mergeSchemas(baseSchema, extraSchema) {
			return { ...(baseSchema || {}), ...(extraSchema || {}) };
		}

		// 获取完整插件信息
		getFullPluginInfo(category, id) {
			const pm = window.WorkflowEditor_PluginManager;
			if (!pm) return null;
			const key = `${category}_${id}`;
			return pm.getPluginInfo(key) || null;
		}

		// 清空属性面板
		clearPropertiesPanel() {
			const panel = document.getElementById('propertiesContent');
			if (!panel) return;
			panel.innerHTML = '<div style="text-align: center; color: #94a3b8; margin-top: 40px;">选择一个节点来配置属性</div>';
		}

		// 渲染属性面板（根据节点/指令 schema 自动生成表单）
		renderPropertiesPanel(node) {
			const panel = document.getElementById('propertiesContent');
			if (!panel || !node) return;
			let schema = null;
			let extraHeader = '';
			if (node.category === 'auxiliary') {
				if (this.nodeManager && this.nodeManager.getNodeType) {
					const def = this.nodeManager.getNodeType(node.pluginId || node.type);
					schema = def && def.configSchema ? def.configSchema : null;
				}
			} else {
				const pluginInfo = this.getFullPluginInfo(node.category, node.pluginId);
				const currentCmd = (pluginInfo && Array.isArray(pluginInfo.commands)) ?
					(pluginInfo.commands.find(c => c.id === node.commandId) || pluginInfo.commands[0]) : null;
				schema = this.mergeSchemas(
					pluginInfo ? (pluginInfo.configSchema || {}) : {},
					currentCmd ? (currentCmd.paramsSchema || {}) : {}
				);
				// 指令选择器
				if (pluginInfo && pluginInfo.commands && pluginInfo.commands.length > 0) {
					extraHeader = `<div style="margin-bottom:8px;">
						<label style="display:block;margin:0 0 4px;">指令</label>
						<select id="cmd-select-${node.id}" class="property-input"></select>
					</div>`;
					setTimeout(() => {
						const sel = document.getElementById(`cmd-select-${node.id}`);
						if (!sel) return;
						sel.innerHTML = '';
						pluginInfo.commands.forEach(cmd => {
							const opt = document.createElement('option');
							opt.value = cmd.id;
							opt.textContent = cmd.name || cmd.id;
							if (cmd.id === node.commandId) opt.selected = true;
							sel.appendChild(opt);
						});
						sel.addEventListener('change', () => {
							console.log('[UIManager] Command selection changed:', sel.value);
							const newCmd = pluginInfo.commands.find(c => c.id === sel.value);
							console.log('[UIManager] Found new command:', newCmd);
							
							const newSchema = this.mergeSchemas(pluginInfo.configSchema || {}, newCmd.paramsSchema || {});
							const defaults = this.getDefaultsFromSchema(newSchema);
							// 尽量保留旧值
							const newConfig = { ...defaults, ...(node.config || {}) };
							
							// 更新节点配置
							this.stateManager.updateNode(node.id, {
								commandId: newCmd.id,
								inputs: newCmd.inputs || ['trigger'],
								outputs: newCmd.outputs || ['result', 'error'],
								config: newConfig
							});
							
							// 更新动态输入端点
							if (this.nodeManager && this.nodeManager.updateNodeInputsForCommand) {
								const pluginKey = `${node.category}_${node.pluginId}`;
								console.log('[UIManager] Calling updateNodeInputsForCommand with:', { nodeId: node.id, commandId: newCmd.id, pluginKey });
								this.nodeManager.updateNodeInputsForCommand(node.id, newCmd.id, pluginKey);
							} else {
								console.error('[UIManager] NodeManager or updateNodeInputsForCommand not available');
							}
						});
					}, 0);
				}
			}
			if (!schema) { this.clearPropertiesPanel(); return; }
			const formId = `node-form-${node.id}`;
			const title = `${node.name} 配置`;
			panel.innerHTML = `
				<div class="properties-section">
					<div class="properties-section-title">${title}</div>
					${extraHeader}
					<form id="${formId}" class="properties-form"></form>
				</div>
			`;
			const form = document.getElementById(formId);
			// 生成字段
			Object.entries(schema).forEach(([key, field]) => {
				const fieldEl = this.createFieldElement(node, key, field);
				form.appendChild(fieldEl);
			});

			// 对 aiCompose 的 model 字段进行下拉增强与模型懒加载
			try {
				if (node && (node.type === 'aiCompose' || node.pluginId === 'aiCompose')) {
					const modelInput = form.querySelector('input[name="model"], select[name="model"]');
					if (modelInput) {
						const applyOptions = (modelsArr) => {
							if (!Array.isArray(modelsArr) || modelsArr.length === 0) return;
							// 如果是 input，替换为 select
							let selectEl = modelInput;
							if (modelInput.tagName.toLowerCase() === 'input') {
								selectEl = document.createElement('select');
								selectEl.name = 'model';
								selectEl.className = modelInput.className;
								selectEl.style.cssText = modelInput.style.cssText;
								modelInput.parentNode.replaceChild(selectEl, modelInput);
							}
							selectEl.innerHTML = '';
							modelsArr.forEach(m => {
								const id = (m && (m.id || m.name || m.toString()))
								if (!id) return;
								const opt = document.createElement('option');
								opt.value = id;
								opt.textContent = id;
								if (node.config && node.config.model === id) opt.selected = true;
								selectEl.appendChild(opt);
							});
						};

						// 先用缓存
						if (Array.isArray(window.__WE_AI_MODELS__) && window.__WE_AI_MODELS__.length > 0) {
							applyOptions(window.__WE_AI_MODELS__);
						} else if (window.AiClientFactory) {
							// 懒加载
							window.AiClientFactory.getClient().listModels().then(models => {
								window.__WE_AI_MODELS__ = models;
								applyOptions(models);
							}).catch(err => console.warn('[UIManager] 加载AI模型失败:', err?.message || err));
						}
					}
				}
			} catch (e) { console.warn('[UIManager] aiCompose model 下拉增强失败:', e?.message || e); }
		}

		// 创建单个表单字段
		createFieldElement(node, key, field) {
			const wrapper = document.createElement('div');
			wrapper.className = 'property-field';
			const label = document.createElement('label');
			// 使用 field.label 如果存在，否则使用 key
			label.textContent = field.label || key;
			label.style.display = 'block';
			label.style.margin = '8px 0 4px 0';
			label.style.color = '#94a3b8';
			label.style.fontSize = '12px';
			label.style.fontWeight = '500';
			
			// 添加描述信息
			let descriptionEl = null;
			if (field.description) {
				descriptionEl = document.createElement('div');
				descriptionEl.textContent = field.description;
				descriptionEl.style.fontSize = '10px';
				descriptionEl.style.color = '#64748b';
				descriptionEl.style.marginBottom = '4px';
				descriptionEl.style.lineHeight = '1.3';
			}
			
			let input;
			const current = node.config && node.config[key] !== undefined ? node.config[key] : (field.default !== undefined ? field.default : '');
			
			switch (field.type) {
				case 'number': {
					input = document.createElement('input');
					input.type = 'number';
					if (field.min !== undefined) input.min = String(field.min);
					if (field.max !== undefined) input.max = String(field.max);
					input.value = current !== '' ? current : (field.default || 0);
					break;
				}
				case 'boolean': {
					input = document.createElement('select');
					['false','true'].forEach(v => {
						const o = document.createElement('option');
						o.value = v;
						o.textContent = v;
						if (String(current) === v) o.selected = true;
						input.appendChild(o);
					});
					break;
				}
				case 'enum': {
					input = document.createElement('select');
					(field.options || []).forEach(opt => {
						const o = document.createElement('option');
						o.value = opt;
						o.textContent = opt;
						if (opt === current) o.selected = true;
						input.appendChild(o);
					});
					break;
				}
				default: {
					if (key === 'code' || key === 'customScript') {
						input = document.createElement('textarea');
						input.rows = 8;
					} else {
						input = document.createElement('input');
						input.type = 'text';
					}
					input.value = current || '';
				}
			}
			
			// 确保输入框样式正确
			input.className = 'property-input';
			input.style.width = '100%';
			input.style.background = '#0f172a';
			input.style.border = '1px solid #475569';
			input.style.borderRadius = '6px';
			input.style.color = '#e2e8f0';
			input.style.padding = '8px 12px';
			input.style.fontSize = '14px';
			input.style.boxSizing = 'border-box';
			
			// 确保输入框可以获得焦点和输入
			input.tabIndex = 0;
			input.readOnly = false;
			input.disabled = false;
			
			// 创建防抖的更新函数
			let updateTimeout = null;
			const debouncedUpdate = (value) => {
				if (updateTimeout) {
					clearTimeout(updateTimeout);
				}
				updateTimeout = setTimeout(() => {
					try {
						let processedValue = value;
						if (field.type === 'number') {
							processedValue = value === '' ? 0 : Number(value);
							if (isNaN(processedValue)) {
								input.style.borderColor = '#ef4444';
								return;
							}
						}
						if (field.type === 'boolean') {
							processedValue = (value === 'true');
						}
						
						// 创建新的配置对象
						const newConfig = { ...(node.config || {}), [key]: processedValue };
						
						// 校验配置
						let valid = true;
						if (this.nodeManager && this.nodeManager.validateNodeConfig) {
							const res = this.nodeManager.validateNodeConfig(node.pluginId || node.type, newConfig);
							valid = res.valid;
							if (!valid && res.errors) {
								console.warn('[UIManager] Config validation failed:', res.errors);
							}
						}
						
						// 更新节点配置 - 静默更新，不触发属性面板重新渲染
						if (valid) {
							console.log('[UIManager] Updating node config:', { nodeId: node.id, key, value: processedValue });
							// 直接更新状态管理器中的节点数据，避免触发重新渲染
							const currentNode = this.stateManager.getNode(node.id);
							if (currentNode) {
								currentNode.config = newConfig;
								// 只发出配置更新事件，不触发完整的节点更新事件
								this.stateManager.emit('nodeConfigUpdated', { nodeId: node.id, config: newConfig });
							}
							input.style.borderColor = '#475569';
							input.style.boxShadow = '';
						} else {
							input.style.borderColor = '#ef4444';
							input.style.boxShadow = '0 0 0 2px rgba(239, 68, 68, 0.2)';
						}
					} catch (error) {
						console.error('[UIManager] Error updating node config:', error);
						input.style.borderColor = '#ef4444';
					}
				}, 300); // 300ms 防抖延迟
			};
			
			// 绑定事件监听器
			const onInput = (e) => {
				e.stopPropagation();
				debouncedUpdate(e.target.value);
			};
			
			const onChange = (e) => {
				e.stopPropagation();
				// 立即更新，不使用防抖
				const value = e.target.value;
				try {
					let processedValue = value;
					if (field.type === 'number') {
						processedValue = value === '' ? 0 : Number(value);
						if (isNaN(processedValue)) {
							input.style.borderColor = '#ef4444';
							return;
						}
					}
					if (field.type === 'boolean') {
						processedValue = (value === 'true');
					}
					
					const newConfig = { ...(node.config || {}), [key]: processedValue };
					console.log('[UIManager] onChange - Updating node config:', { nodeId: node.id, key, value: processedValue });
					
					// 静默更新，避免重新渲染属性面板
					const currentNode = this.stateManager.getNode(node.id);
					if (currentNode) {
						currentNode.config = newConfig;
						// 只发出配置更新事件，不触发完整的节点更新事件
						this.stateManager.emit('nodeConfigUpdated', { nodeId: node.id, config: newConfig });
					}
					input.style.borderColor = '#475569';
				} catch (error) {
					console.error('[UIManager] Error in onChange:', error);
					input.style.borderColor = '#ef4444';
				}
			};
			
			const onFocus = (e) => {
				e.target.style.borderColor = '#3b82f6';
				e.target.style.boxShadow = '0 0 0 2px rgba(59, 130, 246, 0.2)';
			};
			
			const onBlur = (e) => {
				if (e.target.style.borderColor !== '#ef4444') {
					e.target.style.borderColor = '#475569';
				}
				e.target.style.boxShadow = '';
			};
			
			// 添加事件监听器
			input.addEventListener('input', onInput);
			input.addEventListener('change', onChange);
			input.addEventListener('focus', onFocus);
			input.addEventListener('blur', onBlur);
			
			// 防止事件冒泡影响其他功能
			input.addEventListener('mousedown', (e) => e.stopPropagation());
			input.addEventListener('click', (e) => e.stopPropagation());
			input.addEventListener('keydown', (e) => e.stopPropagation());
			
			wrapper.appendChild(label);
			// 添加描述信息（如果存在）
			if (descriptionEl) {
				wrapper.appendChild(descriptionEl);
			}
			wrapper.appendChild(input);
			return wrapper;
		}

        // 过滤插件 - 修复后的版本，确保不影响画布状态
        filterPlugins(searchTerm) {
            // 防止搜索操作影响画布状态
            const term = searchTerm.toLowerCase().trim();
            
            // 获取所有插件节点，但只操作插件面板中的节点，不影响画布
            const pluginPanelNodes = document.querySelectorAll('#pluginPanel .plugin-node');
            
            pluginPanelNodes.forEach(plugin => {
                const nameElement = plugin.querySelector('.plugin-node-name');
                const descElement = plugin.querySelector('.plugin-node-desc');
                
                if (nameElement && descElement) {
                    const name = nameElement.textContent.toLowerCase();
                    const desc = descElement.textContent.toLowerCase();
                    const matches = term === '' || name.includes(term) || desc.includes(term);
                    
                    // 使用更安全的显示/隐藏方式
                    if (matches) {
                        plugin.style.display = '';
                        plugin.classList.remove('filtered-out');
                    } else {
                        plugin.style.display = 'none';
                        plugin.classList.add('filtered-out');
                    }
                }
            });
            
            // 更新分类标题的显示状态
            this.updateCategoryVisibility();
        }

        // 更新分类标题的显示状态
        updateCategoryVisibility() {
            const categories = document.querySelectorAll('#pluginPanel .plugin-category');
            
            categories.forEach(category => {
                const visiblePlugins = category.querySelectorAll('.plugin-node:not([style*="display: none"])');
                const categoryTitle = category.querySelector('.category-title');
                
                if (visiblePlugins.length > 0) {
                    category.style.display = '';
                    if (categoryTitle) {
                        categoryTitle.style.opacity = '1';
                    }
                } else {
                    // 不完全隐藏分类，只是降低透明度
                    category.style.display = '';
                    if (categoryTitle) {
                        categoryTitle.style.opacity = '0.5';
                    }
                }
            });
        }

        // 缩放操作
        zoomIn() {
            const currentZoom = this.stateManager.getCanvasZoom();
            this.stateManager.setCanvasZoom(currentZoom * 1.2);
        }

        zoomOut() {
            const currentZoom = this.stateManager.getCanvasZoom();
            this.stateManager.setCanvasZoom(currentZoom / 1.2);
        }

        zoomFit() {
            this.stateManager.setCanvasZoom(1);
            this.stateManager.setCanvasOffset({ x: 0, y: 0 });
        }

        // 更新缩放显示
        updateZoomDisplay(zoom) {
            const zoomLevel = document.getElementById('zoomLevel');
            if (zoomLevel) {
                zoomLevel.textContent = Math.round(zoom * 100) + '%';
            }
        }

        // 更新统计信息
        updateStats() {
            const stats = this.stateManager.getStats();
            
            const nodeCount = document.getElementById('nodeCount');
            const connectionCount = document.getElementById('connectionCount');
            
            if (nodeCount) nodeCount.textContent = stats.nodeCount;
            if (connectionCount) connectionCount.textContent = stats.connectionCount;
        }

        // 工作流操作
        newWorkflow() {
            if (confirm('确定要创建新工作流吗？当前工作流将被清空。')) {
                console.log('[UIManager] Creating new workflow...');
                
                // 使用统一的清空逻辑
                this.clearAllWorkflowStates();
                
                // 重置UI状态
                const titleInput = document.getElementById('workflowTitleInput');
                if (titleInput) {
                    titleInput.value = '未命名工作流';
                }
                
                // 更新统计信息
                this.updateStats();
                
                // 重置缩放和偏移
                this.stateManager.setCanvasZoom(1);
                this.stateManager.setCanvasOffset({ x: 0, y: 0 });
                this.updateZoomDisplay(1);
                
                console.log('[UIManager] New workflow created successfully');
                this.showToast('新工作流创建成功！', 'success');
            }
        }

        // 统一的清空所有工作流状态的方法
        clearAllWorkflowStates() {
            console.log('[UIManager] Clearing all workflow states...');

            // 1. 首先重置状态管理器，清空所有节点和连接数据
            this.stateManager.reset();
            console.log('[UIManager] StateManager reset completed');

            // 2. 清空连接管理器状态
            if (this.connectionManager && this.connectionManager.clearAllConnections) {
                console.log('[UIManager] Clearing connection manager...');
                this.connectionManager.clearAllConnections();
            }

            // 3. 清空画布
            const canvasManager = window.WorkflowEditor_CanvasManager;
            if (canvasManager && canvasManager.clear) {
                console.log('[UIManager] Clearing canvas...');
                canvasManager.clear();
            }

            // 4. 清理执行引擎状态
            const executionEngine = window.WorkflowEditor_ExecutionEngine;
            if (executionEngine && executionEngine.clearResults) {
                console.log('[UIManager] Clearing execution engine results...');
                executionEngine.clearResults();
            }

            // 5. 清空属性面板
            this.clearPropertiesPanel();

            // 6. 重置UI状态
            this.updateWorkflowStatus('ready', '就绪');
            this.setExecutionState(false);

            console.log('[UIManager] All workflow states cleared successfully');
        }

        loadWorkflow() {
            console.log('[UIManager] Load workflow clicked');
            
            // 显示加载对话框，包含本地存储的工作流和文件导入选项
            this.showWorkflowLoadDialog();
        }

        saveWorkflow() {
            console.log('[UIManager] Save workflow clicked');
            this.showWorkflowSaveDialog();
        }

        exportWorkflow() {
            console.log('[UIManager] Export workflow clicked');
            this.exportWorkflowAsJSON();
        }

        // 显示工作流保存对话框
        showWorkflowSaveDialog() {
            const currentName = this.stateManager.getWorkflowName();
            
            // 创建自定义对话框替代prompt
            const dialog = document.createElement('div');
            dialog.className = 'workflow-save-dialog';
            dialog.innerHTML = `
                <div class="dialog-overlay" style="
                    position: fixed; 
                    top: 0; 
                    left: 0; 
                    width: 100%; 
                    height: 100%; 
                    background: rgba(0,0,0,0.7); 
                    backdrop-filter: blur(4px);
                    z-index: 9999; 
                    display: flex; 
                    align-items: center; 
                    justify-content: center;
                    animation: fadeIn 0.2s ease-out;
                ">
                    <div class="dialog-content" style="
                        background: linear-gradient(135deg, #1f2937 0%, #111827 100%);
                        border-radius: 12px; 
                        padding: 0; 
                        max-width: 500px; 
                        width: 90%; 
                        box-shadow: 0 25px 50px rgba(0, 0, 0, 0.5);
                        border: 1px solid #374151;
                        animation: slideUp 0.3s ease-out;
                        overflow: hidden;
                    ">
                        <div class="dialog-header" style="
                            padding: 24px; 
                            border-bottom: 1px solid #374151; 
                            display: flex; 
                            justify-content: space-between; 
                            align-items: center;
                            background: linear-gradient(135deg, #374151 0%, #1f2937 100%);
                        ">
                            <div style="display: flex; align-items: center; gap: 12px;">
                                <div style="
                                    width: 40px;
                                    height: 40px;
                                    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                                    border-radius: 8px;
                                    display: flex;
                                    align-items: center;
                                    justify-content: center;
                                ">
                                    <svg width="20" height="20" fill="white" viewBox="0 0 20 20">
                                        <path d="M7.707 10.293a1 1 0 10-1.414 1.414l3 3a1 1 0 001.414 0l3-3a1 1 0 00-1.414-1.414L11 11.586V6h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2h5v5.586l-1.293-1.293zM9 4a1 1 0 012 0v2H9V4z"/>
                                    </svg>
                                </div>
                                <div>
                                    <h3 style="margin: 0; color: #f9fafb; font-size: 20px; font-weight: 600;">保存工作流</h3>
                                    <p style="margin: 4px 0 0 0; color: #9ca3af; font-size: 14px;">为您的工作流设置一个名称</p>
                                </div>
                            </div>
                            <button class="dialog-close" style="
                                background: rgba(107, 114, 128, 0.1); 
                                border: 1px solid #374151; 
                                color: #9ca3af; 
                                font-size: 18px; 
                                cursor: pointer; 
                                padding: 8px; 
                                width: 36px; 
                                height: 36px;
                                border-radius: 6px;
                                transition: all 0.2s ease;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                            " onmouseover="this.style.background='rgba(239, 68, 68, 0.1)'; this.style.borderColor='#ef4444'; this.style.color='#ef4444'" onmouseout="this.style.background='rgba(107, 114, 128, 0.1)'; this.style.borderColor='#374151'; this.style.color='#9ca3af'">&times;</button>
                        </div>
                        <div class="dialog-body" style="padding: 24px;">
                            <div style="margin-bottom: 20px;">
                                <label style="
                                    display: block; 
                                    color: #f3f4f6; 
                                    margin-bottom: 8px; 
                                    font-weight: 500;
                                    font-size: 14px;
                                ">工作流名称</label>
                                <input type="text" id="workflow-name-input" value="${currentName}" style="
                                    width: 100%; 
                                    padding: 12px 16px; 
                                    background: rgba(31, 41, 55, 0.8); 
                                    border: 1px solid #374151; 
                                    border-radius: 8px; 
                                    color: #f9fafb; 
                                    font-size: 16px; 
                                    box-sizing: border-box;
                                    transition: all 0.2s ease;
                                    outline: none;
                                " onfocus="this.style.borderColor='#3b82f6'; this.style.boxShadow='0 0 0 3px rgba(59, 130, 246, 0.1)'" onblur="this.style.borderColor='#374151'; this.style.boxShadow='none'">
                            </div>
                            <div style="
                                background: rgba(59, 130, 246, 0.1);
                                border: 1px solid rgba(59, 130, 246, 0.2);
                                border-radius: 8px;
                                padding: 12px;
                                margin-bottom: 16px;
                            ">
                                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                                    <svg width="16" height="16" fill="#3b82f6" viewBox="0 0 20 20">
                                        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/>
                                    </svg>
                                    <span style="color: #93c5fd; font-size: 13px; font-weight: 500;">保存选项说明</span>
                                </div>
                                <div style="color: #93c5fd; font-size: 12px; line-height: 1.4; margin-left: 24px;">
                                    <div style="margin-bottom: 4px;">• <strong>保存</strong>：覆盖当前工作流（Enter键）</div>
                                    <div style="margin-bottom: 4px;">• <strong>另存为</strong>：创建新的工作流副本（Ctrl+Enter键）</div>
                                    <div style="color: #6b7280;">如果名称重复，另存为会自动添加数字后缀</div>
                                </div>
                            </div>
                        </div>
                        <div class="dialog-footer" style="
                            padding: 20px 24px; 
                            border-top: 1px solid #374151; 
                            display: flex; 
                            justify-content: space-between; 
                            align-items: center;
                            background: rgba(31, 41, 55, 0.5);
                        ">
                            <button class="btn btn-secondary" id="cancel-save-btn" style="
                                background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%);
                                color: white; 
                                border: none; 
                                padding: 12px 20px; 
                                border-radius: 8px; 
                                cursor: pointer;
                                font-size: 14px;
                                font-weight: 500;
                                transition: all 0.2s ease;
                                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                                min-width: 80px;
                            " onmouseover="this.style.transform='translateY(-1px)'; this.style.boxShadow='0 4px 12px rgba(0, 0, 0, 0.2)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 4px rgba(0, 0, 0, 0.1)'">取消</button>
                            <div style="display: flex; gap: 12px;">
                                <button class="btn btn-info" id="save-as-btn" style="
                                    background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
                                    color: white; 
                                    border: none; 
                                    padding: 12px 20px; 
                                    border-radius: 8px; 
                                    cursor: pointer;
                                    font-size: 14px;
                                    font-weight: 500;
                                    transition: all 0.2s ease;
                                    box-shadow: 0 2px 4px rgba(139, 92, 246, 0.2);
                                    min-width: 100px;
                                    display: flex;
                                    align-items: center;
                                    justify-content: center;
                                    gap: 6px;
                                " onmouseover="this.style.transform='translateY(-1px)'; this.style.boxShadow='0 4px 12px rgba(139, 92, 246, 0.3)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 4px rgba(139, 92, 246, 0.2)'">
                                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                                        <path d="M8 2a1 1 0 000 2h2a1 1 0 100-2H8z"/>
                                        <path d="M3 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v6h-4.586l1.293-1.293a1 1 0 10-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L10.414 13H15v3a2 2 0 01-2 2H5a2 2 0 01-2-2V5zM15 11h2V5h-2v6z"/>
                                    </svg>
                                    另存为
                                </button>
                                <button class="btn btn-primary" id="confirm-save-btn" style="
                                    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                                    color: white; 
                                    border: none; 
                                    padding: 12px 20px; 
                                    border-radius: 8px; 
                                    cursor: pointer;
                                    font-size: 14px;
                                    font-weight: 500;
                                    transition: all 0.2s ease;
                                    box-shadow: 0 2px 4px rgba(16, 185, 129, 0.2);
                                    min-width: 80px;
                                    display: flex;
                                    align-items: center;
                                    justify-content: center;
                                    gap: 6px;
                                " onmouseover="this.style.transform='translateY(-1px)'; this.style.boxShadow='0 4px 12px rgba(16, 185, 129, 0.3)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 4px rgba(16, 185, 129, 0.2)'">
                                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                                        <path d="M7.707 10.293a1 1 0 10-1.414 1.414l3 3a1 1 0 001.414 0l3-3a1 1 0 00-1.414-1.414L11 11.586V6h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2h5v5.586l-1.293-1.293zM9 4a1 1 0 012 0v2H9V4z"/>
                                    </svg>
                                    保存
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
                <style>
                    @keyframes fadeIn {
                        from { opacity: 0; }
                        to { opacity: 1; }
                    }
                    @keyframes slideUp {
                        from { 
                            opacity: 0;
                            transform: translateY(20px) scale(0.95);
                        }
                        to { 
                            opacity: 1;
                            transform: translateY(0) scale(1);
                        }
                    }
                </style>
            `;

            document.body.appendChild(dialog);

            const nameInput = dialog.querySelector('#workflow-name-input');
            const confirmBtn = dialog.querySelector('#confirm-save-btn');
            const saveAsBtn = dialog.querySelector('#save-as-btn');
            const cancelBtn = dialog.querySelector('#cancel-save-btn');
            const closeBtn = dialog.querySelector('.dialog-close');

            // 聚焦输入框并选中文本
            nameInput.focus();
            nameInput.select();

            // 确认保存（覆盖原工作流）
            const handleSave = () => {
                const workflowName = nameInput.value.trim();
                if (workflowName) {
                    this.stateManager.setWorkflowName(workflowName);
                    this.saveWorkflowToStorage();
                    document.body.removeChild(dialog);
                } else {
                    nameInput.style.borderColor = '#ef4444';
                    nameInput.focus();
                }
            };

            // 另存为（创建新工作流）
            const handleSaveAs = () => {
                const workflowName = nameInput.value.trim();
                if (workflowName) {
                    // 检查名称是否已存在
                    const savedWorkflows = this.getSavedWorkflows();
                    const existingNames = Object.values(savedWorkflows).map(w => w.name);
                    
                    let finalName = workflowName;
                    let counter = 1;
                    
                    // 如果名称已存在，自动添加数字后缀
                    while (existingNames.includes(finalName)) {
                        finalName = `${workflowName} (${counter})`;
                        counter++;
                    }
                    
                    // 保存原始工作流信息
                    const originalWorkflowId = this.stateManager.get('workflowId');
                    const originalWorkflowName = this.stateManager.getWorkflowName();
                    
                    try {
                        // 创建新的工作流ID
                        const newWorkflowId = `workflow_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                        
                        // 临时设置新的工作流信息进行另存为
                        this.stateManager.setWorkflowName(finalName);
                        this.stateManager.set('workflowId', newWorkflowId);
                        
                        // 简化：直接使用 StateManager 数据（单一数据源）
                        console.log('[UIManager] 另存为工作流，直接从 StateManager 序列化');
                        
                        // 获取序列化数据
                        const workflowData = this.stateManager.serialize();
                        
                        // 确保使用新的ID和名称
                        workflowData.id = newWorkflowId;
                        workflowData.name = finalName;
                        
                        // 保存到localStorage
                        savedWorkflows[newWorkflowId] = workflowData;
                        localStorage.setItem('workflowEditor_savedWorkflows', JSON.stringify(savedWorkflows));
                        
                        // 显示成功提示
                        this.showToast(`工作流已另存为 "${finalName}"`, 'success');
                        console.log('[UIManager] Workflow saved as new:', workflowData);
                        
                        document.body.removeChild(dialog);
                        
                    } catch (error) {
                        console.error('[UIManager] Failed to save workflow as new:', error);
                        
                        // 恢复原始工作流信息
                        this.stateManager.setWorkflowName(originalWorkflowName);
                        this.stateManager.set('workflowId', originalWorkflowId);
                        
                        this.showToast('另存为工作流失败: ' + error.message, 'error');
                    }
                } else {
                    nameInput.style.borderColor = '#ef4444';
                    nameInput.focus();
                }
            };

            // 取消保存
            const handleCancel = () => {
                document.body.removeChild(dialog);
            };

            // 绑定事件
            confirmBtn.addEventListener('click', handleSave);
            saveAsBtn.addEventListener('click', handleSaveAs);
            cancelBtn.addEventListener('click', handleCancel);
            closeBtn.addEventListener('click', handleCancel);

            // 回车键保存，Ctrl+Enter另存为
            nameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    if (e.ctrlKey || e.metaKey) {
                        // Ctrl+Enter 或 Cmd+Enter 触发另存为
                        handleSaveAs();
                    } else {
                        // 普通Enter触发保存
                        handleSave();
                    }
                } else if (e.key === 'Escape') {
                    handleCancel();
                }
            });

            // 点击遮罩层关闭
            dialog.querySelector('.dialog-overlay').addEventListener('click', (e) => {
                if (e.target === dialog.querySelector('.dialog-overlay')) {
                    handleCancel();
                }
            });
        }

        // 保存工作流到本地存储
        saveWorkflowToStorage() {
            try {
                // 简化：直接序列化 StateManager 数据（单一数据源）
                console.log('[UIManager] 开始保存工作流，直接从 StateManager 序列化');
                
                // 调试：输出当前状态
                const currentNodes = this.stateManager.getAllNodes();
                const currentConnections = this.stateManager.getAllConnections();
                console.log(`[UIManager] 当前状态 - 节点: ${currentNodes.length}, 连接: ${currentConnections.length}`);
                
                // 获取序列化数据
                const workflowData = this.stateManager.serialize();
                const workflowId = workflowData.id || `workflow_${Date.now()}`;
                workflowData.id = workflowId;
                
                // 调试信息：检查节点数据
                console.log('[UIManager] Saving workflow with nodes:', Object.keys(workflowData.nodes || {}));
                console.log('[UIManager] Saving workflow with connections:', Object.keys(workflowData.connections || {}));
                
                // 保存到localStorage
                const savedWorkflows = this.getSavedWorkflows();
                savedWorkflows[workflowId] = workflowData;
                localStorage.setItem('workflowEditor_savedWorkflows', JSON.stringify(savedWorkflows));
                
                // 更新当前工作流ID
                this.stateManager.set('workflowId', workflowId);
                
                this.showToast(`工作流 "${workflowData.name}" 保存成功！`, 'success');
                console.log('[UIManager] Workflow saved successfully:', {
                    name: workflowData.name,
                    id: workflowId,
                    nodeCount: Object.keys(workflowData.nodes || {}).length,
                    connectionCount: Object.keys(workflowData.connections || {}).length
                });
            } catch (error) {
                console.error('[UIManager] Failed to save workflow:', error);
                this.showToast('保存工作流失败: ' + error.message, 'error');
            }
        }

        // 显示工作流加载对话框
        showWorkflowLoadDialog() {
            const savedWorkflows = this.getSavedWorkflows();
            const workflowList = Object.values(savedWorkflows);
            
            // 即使没有保存的工作流，也显示对话框，允许从文件导入
            const hasWorkflows = workflowList.length > 0;

            // 创建加载对话框
            const dialog = document.createElement('div');
            dialog.className = 'workflow-load-dialog';
            
            const workflowListHTML = hasWorkflows ? 
                workflowList.map(workflow => `
                    <div class="workflow-item" data-workflow-id="${workflow.id}" style="
                        border: 1px solid #374151; 
                        border-radius: 8px; 
                        padding: 16px; 
                        margin-bottom: 12px; 
                        background: linear-gradient(135deg, #1f2937 0%, #111827 100%);
                        transition: all 0.2s ease;
                        cursor: pointer;
                        position: relative;
                        overflow: hidden;
                    " onmouseover="this.style.borderColor='#3b82f6'; this.style.transform='translateY(-2px)'; this.style.boxShadow='0 8px 25px rgba(59, 130, 246, 0.15)'" onmouseout="this.style.borderColor='#374151'; this.style.transform='translateY(0)'; this.style.boxShadow='none'">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                            <div class="workflow-info" style="flex: 1; min-width: 0;">
                                <div class="workflow-name" style="
                                    color: #f9fafb; 
                                    font-weight: 600; 
                                    font-size: 16px;
                                    margin-bottom: 8px;
                                    display: flex;
                                    align-items: center;
                                    gap: 8px;
                                ">
                                    <span style="
                                        display: inline-block;
                                        width: 8px;
                                        height: 8px;
                                        background: #10b981;
                                        border-radius: 50%;
                                        flex-shrink: 0;
                                    "></span>
                                    ${workflow.name}
                                </div>
                                <div class="workflow-meta" style="
                                    color: #9ca3af; 
                                    font-size: 13px;
                                    display: flex;
                                    flex-wrap: wrap;
                                    gap: 16px;
                                    margin-bottom: 8px;
                                ">
                                    <span style="display: flex; align-items: center; gap: 4px;">
                                        <svg width="14" height="14" fill="currentColor" viewBox="0 0 20 20">
                                            <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                                        </svg>
                                        节点: ${Object.keys(workflow.nodes || {}).length}
                                    </span>
                                    <span style="display: flex; align-items: center; gap: 4px;">
                                        <svg width="14" height="14" fill="currentColor" viewBox="0 0 20 20">
                                            <path d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>
                                        </svg>
                                        连接: ${Object.keys(workflow.connections || {}).length}
                                    </span>
                                </div>
                                <div style="color: #6b7280; font-size: 12px; display: flex; align-items: center; gap: 4px;">
                                    <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20">
                                        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd"/>
                                    </svg>
                                    更新: ${new Date(workflow.updatedAt).toLocaleString()}
                                </div>
                            </div>
                            <div class="workflow-actions" style="display: flex; gap: 8px; margin-left: 16px;">
                                <button class="btn btn-primary load-btn" style="
                                    background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
                                    color: white; 
                                    border: none; 
                                    padding: 10px 16px; 
                                    border-radius: 6px; 
                                    cursor: pointer;
                                    font-size: 13px;
                                    font-weight: 500;
                                    transition: all 0.2s ease;
                                    box-shadow: 0 2px 4px rgba(59, 130, 246, 0.2);
                                    display: inline-block;
                                    text-align: center;
                                    min-width: 70px;
                                    height: 36px;
                                    line-height: 16px;
                                    vertical-align: middle;
                                    position: relative;
                                    z-index: 10;
                                    overflow: visible;
                                " onmouseover="this.style.transform='translateY(-1px)'; this.style.boxShadow='0 4px 12px rgba(59, 130, 246, 0.3)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 4px rgba(59, 130, 246, 0.2)'">
                                    加载
                                </button>
                                <button class="btn btn-danger delete-btn" style="
                                    background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
                                    color: white; 
                                    border: none; 
                                    padding: 10px 16px; 
                                    border-radius: 6px; 
                                    cursor: pointer;
                                    font-size: 13px;
                                    font-weight: 500;
                                    transition: all 0.2s ease;
                                    box-shadow: 0 2px 4px rgba(239, 68, 68, 0.2);
                                    display: inline-block;
                                    text-align: center;
                                    min-width: 70px;
                                    height: 36px;
                                    line-height: 16px;
                                    vertical-align: middle;
                                    position: relative;
                                    z-index: 10;
                                    overflow: visible;
                                " onmouseover="this.style.transform='translateY(-1px)'; this.style.boxShadow='0 4px 12px rgba(239, 68, 68, 0.3)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 4px rgba(239, 68, 68, 0.2)'">
                                    删除
                                </button>
                            </div>
                        </div>
                    </div>
                `).join('') :
                `<div style="
                    text-align: center; 
                    padding: 40px 20px; 
                    color: #9ca3af;
                    background: linear-gradient(135deg, #1f2937 0%, #111827 100%);
                    border-radius: 8px;
                    border: 2px dashed #374151;
                ">
                    <svg width="48" height="48" fill="currentColor" viewBox="0 0 20 20" style="margin-bottom: 16px; opacity: 0.5;">
                        <path fill-rule="evenodd" d="M4 4a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2H4zm0 2h12v8H4V6z" clip-rule="evenodd"/>
                    </svg>
                    <div style="font-size: 16px; font-weight: 500; margin-bottom: 8px;">暂无保存的工作流</div>
                    <div style="font-size: 14px;">您可以通过下方按钮导入工作流文件</div>
                </div>`;

            dialog.innerHTML = `
                <div class="dialog-overlay" style="
                    position: fixed; 
                    top: 0; 
                    left: 0; 
                    width: 100%; 
                    height: 100%; 
                    background: rgba(0,0,0,0.7); 
                    backdrop-filter: blur(4px);
                    z-index: 9999; 
                    display: flex; 
                    align-items: center; 
                    justify-content: center;
                    animation: fadeIn 0.2s ease-out;
                ">
                    <div class="dialog-content" style="
                        background: linear-gradient(135deg, #1f2937 0%, #111827 100%);
                        border-radius: 12px; 
                        padding: 0; 
                        max-width: 700px; 
                        width: 90%; 
                        max-height: 85vh; 
                        overflow: hidden; 
                        box-shadow: 0 25px 50px rgba(0, 0, 0, 0.5);
                        border: 1px solid #374151;
                        animation: slideUp 0.3s ease-out;
                    ">
                        <div class="dialog-header" style="
                            padding: 24px; 
                            border-bottom: 1px solid #374151; 
                            display: flex; 
                            justify-content: space-between; 
                            align-items: center;
                            background: linear-gradient(135deg, #374151 0%, #1f2937 100%);
                        ">
                            <div style="display: flex; align-items: center; gap: 12px;">
                                <div style="
                                    width: 40px;
                                    height: 40px;
                                    background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
                                    border-radius: 8px;
                                    display: flex;
                                    align-items: center;
                                    justify-content: center;
                                ">
                                    <svg width="20" height="20" fill="white" viewBox="0 0 20 20">
                                        <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd"/>
                                    </svg>
                                </div>
                                <div>
                                    <h3 style="margin: 0; color: #f9fafb; font-size: 20px; font-weight: 600;">加载工作流</h3>
                                    <p style="margin: 4px 0 0 0; color: #9ca3af; font-size: 14px;">选择要加载的工作流或导入新文件</p>
                                </div>
                            </div>
                            <button class="dialog-close" style="
                                background: rgba(107, 114, 128, 0.1); 
                                border: 1px solid #374151; 
                                color: #9ca3af; 
                                font-size: 18px; 
                                cursor: pointer; 
                                padding: 8px; 
                                width: 36px; 
                                height: 36px;
                                border-radius: 6px;
                                transition: all 0.2s ease;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                            " onmouseover="this.style.background='rgba(239, 68, 68, 0.1)'; this.style.borderColor='#ef4444'; this.style.color='#ef4444'" onmouseout="this.style.background='rgba(107, 114, 128, 0.1)'; this.style.borderColor='#374151'; this.style.color='#9ca3af'">&times;</button>
                        </div>
                        <div class="dialog-body" style="
                            padding: 24px; 
                            max-height: 500px; 
                            overflow-y: auto;
                            scrollbar-width: thin;
                            scrollbar-color: #374151 transparent;
                        ">
                            <div class="workflow-list">
                                ${workflowListHTML}
                            </div>
                        </div>
                        <div class="dialog-footer" style="
                            padding: 20px 24px; 
                            border-top: 1px solid #374151; 
                            display: flex; 
                            justify-content: space-between;
                            align-items: center;
                            background: rgba(31, 41, 55, 0.5);
                        ">
                            <div style="color: #6b7280; font-size: 13px;">
                                ${hasWorkflows ? `共 ${workflowList.length} 个工作流` : '暂无保存的工作流'}
                            </div>
                            <button class="btn btn-secondary" id="import-json-btn" style="
                                background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%);
                                color: white; 
                                border: none; 
                                padding: 12px 20px; 
                                border-radius: 8px; 
                                cursor: pointer;
                                font-size: 14px;
                                font-weight: 500;
                                transition: all 0.2s ease;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                                gap: 8px;
                                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                                min-width: 120px;
                                white-space: nowrap;
                            " onmouseover="this.style.transform='translateY(-1px)'; this.style.boxShadow='0 4px 12px rgba(0, 0, 0, 0.2)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 4px rgba(0, 0, 0, 0.1)'">
                                <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20" style="pointer-events: none;">
                                    <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM6.293 6.707a1 1 0 010-1.414l3-3a1 1 0 011.414 0l3 3a1 1 0 01-1.414 1.414L11 5.414V13a1 1 0 11-2 0V5.414L7.707 6.707a1 1 0 01-1.414 0z" clip-rule="evenodd"/>
                                </svg>
                                <span style="pointer-events: none;">从文件导入</span>
                            </button>
                            <input type="file" id="import-file-input" accept=".json" style="display: none;">
                        </div>
                    </div>
                </div>
                <style>
                    @keyframes fadeIn {
                        from { opacity: 0; }
                        to { opacity: 1; }
                    }
                    @keyframes slideUp {
                        from { 
                            opacity: 0;
                            transform: translateY(20px) scale(0.95);
                        }
                        to { 
                            opacity: 1;
                            transform: translateY(0) scale(1);
                        }
                    }
                    .dialog-body::-webkit-scrollbar {
                        width: 6px;
                    }
                    .dialog-body::-webkit-scrollbar-track {
                        background: transparent;
                    }
                    .dialog-body::-webkit-scrollbar-thumb {
                        background: #374151;
                        border-radius: 3px;
                    }
                    .dialog-body::-webkit-scrollbar-thumb:hover {
                        background: #4b5563;
                    }
                </style>
            `;

            document.body.appendChild(dialog);

            // 绑定事件
            dialog.querySelector('.dialog-close').addEventListener('click', () => {
                document.body.removeChild(dialog);
            });

            dialog.querySelector('.dialog-overlay').addEventListener('click', (e) => {
                if (e.target === dialog.querySelector('.dialog-overlay')) {
                    document.body.removeChild(dialog);
                }
            });

            // 加载按钮事件 - 修复点击区域问题
            dialog.querySelectorAll('.load-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    // 确保从按钮本身获取工作流ID，而不是从事件目标
                    const workflowItem = btn.closest('.workflow-item');
                    if (workflowItem) {
                        const workflowId = workflowItem.dataset.workflowId;
                        console.log('[UIManager] Loading workflow:', workflowId);
                        this.loadWorkflowFromStorage(workflowId);
                        document.body.removeChild(dialog);
                    }
                });
            });

            // 删除按钮事件 - 修复点击区域问题
            dialog.querySelectorAll('.delete-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    // 确保从按钮本身获取工作流信息，而不是从事件目标
                    const workflowItem = btn.closest('.workflow-item');
                    if (workflowItem) {
                        const workflowId = workflowItem.dataset.workflowId;
                        const workflowNameElement = workflowItem.querySelector('.workflow-name');
                        const workflowName = workflowNameElement ? workflowNameElement.textContent : '未知工作流';
                        
                        console.log('[UIManager] Deleting workflow:', workflowId, workflowName);
                        
                        if (confirm(`确定要删除工作流 "${workflowName}" 吗？`)) {
                            this.deleteWorkflowFromStorage(workflowId);
                            workflowItem.remove();
                        }
                    }
                });
            });

            // 从文件导入按钮事件 - 修复点击区域问题
            const importBtn = dialog.querySelector('#import-json-btn');
            const fileInput = dialog.querySelector('#import-file-input');
            
            if (importBtn && fileInput) {
                importBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log('[UIManager] Import button clicked');
                    fileInput.click();
                });

                fileInput.addEventListener('change', (e) => {
                    const file = e.target.files[0];
                    if (file) {
                        console.log('[UIManager] File selected:', file.name);
                        this.importWorkflowFromFile(file);
                        document.body.removeChild(dialog);
                    }
                });
            }
        }

        // 从本地存储加载工作流
        loadWorkflowFromStorage(workflowId) {
            try {
                const savedWorkflows = this.getSavedWorkflows();
                const workflowData = savedWorkflows[workflowId];
                // 标记进入连接恢复期，避免 ConnectionManager 误删
                window.__WE_isRestoringConnections = true;
                
                if (!workflowData) {
                    throw new Error('工作流不存在');
                }

                console.log('[UIManager] Starting workflow load, clearing all states...');

                // 使用统一的清空方法
                this.clearAllWorkflowStates();

                console.log('[UIManager] All states cleared, loading workflow data...');

                // 加载工作流数据
                const success = this.stateManager.deserialize(workflowData);
                
                if (success) {
                    // 重新渲染所有节点
                    const canvasManager = window.WorkflowEditor_CanvasManager;
                    this.stateManager.getAllNodes().forEach(node => {
                        if (canvasManager) {
                            canvasManager.renderNode(node);
                        }
                    });

                        // 先恢复插件节点的动态输入端点与样式，再恢复连接，避免首个节点目标端点缺失
                        setTimeout(() => {
                            console.log('[UIManager] Step 1: Preparing dynamic inputs before restoring connections at', Date.now());
                            const startTime = Date.now();

                            // 恢复节点的多参数端点和样式（为插件节点生成动态输入端点）
                            this.restoreNodeInputsAndStyles();

                            console.log(`[UIManager] Dynamic inputs preparation completed in ${Date.now() - startTime}ms`);

                            // 稍等端点渲染完成后再恢复连接
                            setTimeout(() => {
                                console.log('[UIManager] Step 2: Starting connection restoration at', Date.now());
                                const restoreStartTime = Date.now();
                                const canvasManager = window.WorkflowEditor_CanvasManager;

                                // 使用专门的 restoreConnections 方法，避免重复检测
                                if (canvasManager && canvasManager.restoreConnections) {
                                    // 直接从 StateManager 获取连接数据，因为工作流加载时连接存储在那里
                                    const connections = this.stateManager.getAllConnections();
                                    console.log(`[UIManager] Calling restoreConnections with ${connections.length} connections at`, Date.now());
                                    console.log('[UIManager] Connection data:', connections);
                                    canvasManager.restoreConnections(connections);
                                } else {
                                    console.warn('[UIManager] restoreConnections method not available');
                                }

                                // 更新画布变换
                                if (canvasManager) {
                                    canvasManager.updateCanvasTransform();
                                    console.log(`[UIManager] Canvas transform updated. Total restore time: ${Date.now() - restoreStartTime}ms`);
                                }
                                
                                // 简化：结束连接恢复期
                                setTimeout(() => {
                                    window.__WE_isRestoringConnections = false;
                                    console.log('[UIManager] Connection restoring period ended');
                                }, 500);
                            }, 220);
                        }, 500);

                    this.showToast(`工作流 "${workflowData.name}" 加载成功！`, 'success');
                    console.log('[UIManager] Workflow loaded:', workflowData);
                } else {
                    throw new Error('工作流数据格式错误');
                }
            } catch (error) {
                console.error('[UIManager] Failed to load workflow:', error);
                this.showToast('加载工作流失败: ' + error.message, 'error');
            }
        }



        // 导出工作流为JSON文件
        exportWorkflowAsJSON() {
            try {
                // 简化：直接使用 StateManager 数据（单一数据源）
                console.log('[UIManager] 导出工作流，直接从 StateManager 序列化');
                
                const workflowData = this.stateManager.serialize();
                const jsonString = JSON.stringify(workflowData, null, 2);
                
                const blob = new Blob([jsonString], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                
                const a = document.createElement('a');
                a.href = url;
                a.download = `${workflowData.name || '未命名工作流'}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                
                this.showToast('工作流导出成功！', 'success');
            } catch (error) {
                console.error('[UIManager] Failed to export workflow:', error);
                this.showToast('导出工作流失败: ' + error.message, 'error');
            }
        }

        // 从文件导入工作流
        importWorkflowFromFile(file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const workflowData = JSON.parse(e.target.result);
                    
                    console.log('[UIManager] Starting workflow import, clearing all states...');
                    
                    // 标记进入连接恢复期，避免 ConnectionManager 误删
                    window.__WE_isRestoringConnections = true;
                    
                    // 使用统一的清空方法
                    this.clearAllWorkflowStates();
                    
                    console.log('[UIManager] All states cleared, loading imported workflow data...');

                    // 加载工作流数据
                    const success = this.stateManager.deserialize(workflowData);
                    
                    if (success) {
                        // 重新渲染所有节点
                        const canvasManager = window.WorkflowEditor_CanvasManager;
                        this.stateManager.getAllNodes().forEach(node => {
                            if (canvasManager) {
                                canvasManager.renderNode(node);
                            }
                        });

                        // 先恢复插件节点的动态输入端点与样式，再恢复连接，避免首个节点目标端点缺失
                        setTimeout(() => {
                            console.log('[UIManager] Preparing dynamic inputs before restoring connections...');
                            // 恢复节点的多参数端点和样式（为插件节点生成动态输入端点）
                            this.restoreNodeInputsAndStyles();

                            // 稍等端点渲染完成后再恢复连接
                            setTimeout(() => {
                                console.log('[UIManager] Restoring connections after dynamic inputs prepared...');
                                const canvasManager = window.WorkflowEditor_CanvasManager;
                                
                                // 使用 restoreConnections 方法而不是直接创建连接
                                if (canvasManager && canvasManager.restoreConnections) {
                                    const connections = this.stateManager.getAllConnections();
                                    console.log('[UIManager] Calling restoreConnections with', connections.length, 'connections');
                                    canvasManager.restoreConnections(connections);
                                } else {
                                    console.warn('[UIManager] restoreConnections method not available, falling back to createConnection');
                                    // 备用方案：直接创建连接（此时目标端点已存在）
                                    const fallbackConnections = this.connectionManager ? 
                                        this.connectionManager.getAllConnections() : 
                                        this.stateManager.getAllConnections();
                                    fallbackConnections.forEach(connection => {
                                        if (canvasManager) {
                                            canvasManager.createConnection(connection);
                                        }
                                    });
                                }

                                // 更新画布变换
                                if (canvasManager) {
                                    canvasManager.updateCanvasTransform();
                                }
                                
                                // 简化：结束连接恢复期
                                setTimeout(() => {
                                    window.__WE_isRestoringConnections = false;
                                    console.log('[UIManager] Connection restoring period ended for import');
                                }, 500);
                            }, 220);
                        }, 300);

                        this.showToast(`工作流 "${workflowData.name}" 导入成功！`, 'success');
                        console.log('[UIManager] Workflow imported:', workflowData);
                    } else {
                        throw new Error('工作流数据格式错误');
                    }
                } catch (error) {
                    console.error('[UIManager] Failed to import workflow:', error);
                    this.showToast('导入工作流失败: ' + error.message, 'error');
                }
            };
            reader.readAsText(file);
        }

        // 从状态重新构建画布 - 修复工作流加载时连接线消失的问题
        rebuildCanvasFromState() {
            console.log('[UIManager] Starting canvas rebuild from state...');
            
            const canvasManager = window.WorkflowEditor_CanvasManager;
            if (!canvasManager) {
                console.error('[UIManager] Canvas manager not available');
                return;
            }

            // 清空画布和连接管理器的状态
            console.log('[UIManager] Clearing canvas and connections...');
            canvasManager.clear();

            // 重新渲染所有节点
            console.log('[UIManager] Re-rendering nodes...');
            const nodes = this.stateManager.getAllNodes();
            
            // 分批渲染节点，确保每个节点都完全初始化
            let nodeIndex = 0;
            const renderNextNode = () => {
                if (nodeIndex < nodes.length) {
                    const node = nodes[nodeIndex];
                    console.log('[UIManager] Rendering node:', node.id, node.name);
                    canvasManager.renderNode(node);
                    nodeIndex++;
                    
                    // 给每个节点一些时间完成渲染
                    setTimeout(renderNextNode, 50);
                } else {
                    // 所有节点渲染完成后，开始创建连接
                    console.log('[UIManager] All nodes rendered, creating connections...');
                    this.createConnectionsAfterNodesReady();
                }
            };
            
            renderNextNode();
        }

        // 在节点准备就绪后创建连接
        createConnectionsAfterNodesReady() {
            const canvasManager = window.WorkflowEditor_CanvasManager;
            const connections = this.connectionManager ? 
                this.connectionManager.getAllConnections() : 
                this.stateManager.getAllConnections();
            
            console.log('[UIManager] Creating connections after nodes are ready...');
            
            // 分批创建连接，避免并发问题
            let connectionIndex = 0;
            const createNextConnection = () => {
                if (connectionIndex < connections.length) {
                    const connection = connections[connectionIndex];
                    console.log('[UIManager] Creating connection:', connection.id, 
                        `${connection.sourceNodeId} -> ${connection.targetNodeId}`);
                    
                    // 验证源节点和目标节点是否存在
                    const sourceNode = document.getElementById(connection.sourceNodeId);
                    const targetNode = document.getElementById(connection.targetNodeId);
                    
                    if (sourceNode && targetNode) {
                        canvasManager.createConnection(connection);
                        connectionIndex++;
                        
                        // 给每个连接一些时间完成创建
                        setTimeout(createNextConnection, 100);
                    } else {
                        console.warn('[UIManager] Skipping connection due to missing nodes:', {
                            connectionId: connection.id,
                            sourceExists: !!sourceNode,
                            targetExists: !!targetNode
                        });
                        connectionIndex++;
                        setTimeout(createNextConnection, 50);
                    }
                } else {
                    // 所有连接创建完成后，恢复节点样式和端点
                    console.log('[UIManager] All connections created, restoring node styles...');
                    this.finalizeCanvasRestore();
                }
            };
            
            createNextConnection();
        }

        // 完成画布恢复的最后步骤
        finalizeCanvasRestore() {
            const canvasManager = window.WorkflowEditor_CanvasManager;
            
            // 恢复节点的多参数端点和样式
            setTimeout(() => {
                console.log('[UIManager] Restoring node inputs and styles...');
                this.restoreNodeInputsAndStyles();
                
                // 更新画布变换
                if (canvasManager) {
                    canvasManager.updateCanvasTransform();
                }
                
                // 更新统计信息
                this.updateStats();
                
                // 清空属性面板
                this.clearPropertiesPanel();
                
                console.log('[UIManager] Canvas rebuild completed successfully');
                this.showToast('工作流加载完成', 'success');
                
                // 重置重建标志
                this.isRebuildingFromState = false;
            }, 300);
        }

        // 恢复节点的输入端点和样式
        restoreNodeInputsAndStyles() {
            console.log('[UIManager] Starting node inputs and styles restoration...');
            const nodes = this.stateManager.getAllNodes();
            console.log(`[UIManager] Processing ${nodes.length} nodes for input restoration:`);

            nodes.forEach((node, index) => {
                try {
                    console.log(`[UIManager] Processing node ${index + 1}/${nodes.length}: ${node.id} (${node.category}) type: ${node.type} pluginId: ${node.pluginId}`);

                    // 恢复插件节点的多参数端点
                    if ((node.type === 'VCPToolBox' || node.type === 'vcpChat') && node.commandId) {
                        console.log(`[UIManager] 🔧 Restoring inputs for plugin node: ${node.id} with command: ${node.commandId}`);

                        const pluginInfo = this.getFullPluginInfo(node.category, node.pluginId);
                        if (pluginInfo && pluginInfo.commands) {
                            const command = pluginInfo.commands.find(c => c.id === node.commandId);
                            if (command && this.nodeManager && this.nodeManager.updateNodeInputsForCommand) {
                                const pluginKey = `${node.category}_${node.pluginId}`;
                                console.log(`[UIManager] 📝 Calling updateNodeInputsForCommand: node=${node.id}, command=${command.id}, pluginKey=${pluginKey}`);
                                const startTime = Date.now();
                                this.nodeManager.updateNodeInputsForCommand(node.id, command.id, pluginKey);
                                console.log(`[UIManager] ✅ updateNodeInputsForCommand completed in ${Date.now() - startTime}ms for node ${node.id}`);
                            } else {
                                console.warn(`[UIManager] ❌ Cannot update inputs for node ${node.id}:`, {
                                    hasNodeManager: !!this.nodeManager,
                                    hasCommand: !!command,
                                    hasMethod: !!(this.nodeManager && this.nodeManager.updateNodeInputsForCommand)
                                });
                            }
                        } else {
                            console.warn(`[UIManager] ❌ Plugin info not available for ${node.category}_${node.pluginId}`);
                        }
                    }

                    // 恢复辅助节点的样式和端点
                    if (node.category === 'auxiliary' && this.nodeManager) {
                        console.log(`[UIManager] 🔧 Processing auxiliary node: ${node.id} pluginId: ${node.pluginId}`);
                        // 辅助节点不需要动态输入端点，跳过处理
                        console.log(`[UIManager] ℹ️ Auxiliary nodes do not need dynamic input endpoints: ${node.id}`);
                    }

                } catch (error) {
                    console.error(`[UIManager] ❌ Error restoring node ${node.id}:`, error);
                }
            });

            console.log('[UIManager] ✅ Node inputs and styles restoration completed for all nodes');
        }

        // 获取已保存的工作流
        getSavedWorkflows() {
            try {
                const saved = localStorage.getItem('workflowEditor_savedWorkflows');
                return saved ? JSON.parse(saved) : {};
            } catch (error) {
                console.error('[UIManager] Failed to get saved workflows:', error);
                return {};
            }
        }

        // 从存储中删除工作流
        deleteWorkflowFromStorage(workflowId) {
            try {
                const savedWorkflows = this.getSavedWorkflows();
                delete savedWorkflows[workflowId];
                localStorage.setItem('workflowEditor_savedWorkflows', JSON.stringify(savedWorkflows));
                console.log('[UIManager] Workflow deleted:', workflowId);
            } catch (error) {
                console.error('[UIManager] Failed to delete workflow:', error);
            }
        }

        // 显示插件管理器
        showPluginManager() {
            if (window.WorkflowEditor_PluginDialog) {
                window.WorkflowEditor_PluginDialog.show();
            }
        }

        // 显示API配置对话框
        showApiConfig() {
            if (window.WorkflowEditor_PluginManager) {
                window.WorkflowEditor_PluginManager.showApiConfigDialog();
            } else {
                console.error('[UIManager] Plugin Manager not available');
            }
        }

        // 显示Toast消息
        // 执行工作流
        async executeWorkflow() {
            try {
                // 检查是否有节点
                const nodes = this.stateManager.getAllNodes();
                if (nodes.length === 0) {
                    this.showToast('工作流为空，请先添加节点', 'warning');
                    return;
                }

                // 更新UI状态
                this.setExecutionState(true);
                this.updateWorkflowStatus('executing', '正在执行工作流...');

                // 获取执行引擎
                const executionEngine = window.WorkflowEditor_ExecutionEngine;
                if (!executionEngine) {
                    throw new Error('执行引擎未初始化');
                }

                // 简化：初始化执行引擎（移除 ConnectionManager 依赖）
                if (!executionEngine.stateManager) {
                    executionEngine.init(this.stateManager, this.nodeManager);
                    console.log('[UIManager] ExecutionEngine 已初始化，使用 StateManager 作为单一数据源');
                }

                // 开始执行
                await executionEngine.executeWorkflow();

                // 执行成功
                this.updateWorkflowStatus('success', '工作流执行完成');
                this.showToast('工作流执行成功！', 'success');

            } catch (error) {
                console.error('[UIManager] Workflow execution failed:', error);
                this.updateWorkflowStatus('error', `执行失败: ${error.message}`);
                this.showToast(`工作流执行失败: ${error.message}`, 'error');
            } finally {
                this.setExecutionState(false);
            }
        }

        // 停止工作流执行
        stopWorkflow() {
            const executionEngine = window.WorkflowEditor_ExecutionEngine;
            if (executionEngine) {
                executionEngine.stopExecution();
                this.setExecutionState(false);
                this.updateWorkflowStatus('stopped', '执行已停止');
                this.showToast('工作流执行已停止', 'info');
            }
        }

        // 设置执行状态
        setExecutionState(isExecuting) {
            const executeBtn = document.getElementById('executeWorkflowBtn');
            const stopBtn = document.getElementById('stopWorkflowBtn');
            
            if (executeBtn && stopBtn) {
                if (isExecuting) {
                    executeBtn.classList.add('hidden');
                    stopBtn.classList.remove('hidden');
                } else {
                    executeBtn.classList.remove('hidden');
                    stopBtn.classList.add('hidden');
                }
            }
        }

        // 更新工作流状态
        updateWorkflowStatus(status, message) {
            const statusIndicator = document.getElementById('workflowStatus');
            const statusText = document.getElementById('workflowStatusText');
            
            if (statusIndicator) {
                statusIndicator.className = `status-indicator ${status}`;
            }
            
            if (statusText) {
                statusText.textContent = message;
            }
        }

        // 显示Toast消息
        showToast(message, type = 'info') {
            // 复用ComfyUI的Toast功能
            if (window.ComfyUI_UIManager) {
                window.ComfyUI_UIManager.showToast(message, type);
            } else {
                console.log(`[${type.toUpperCase()}] ${message}`);
            }
        }
    }

    // 导出为全局单例
    window.WorkflowEditor_UIManager = WorkflowEditor_UIManager.getInstance();
})();