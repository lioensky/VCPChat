// ComfyUI UI Manager Module
(function() {
    'use strict';

    class ComfyUI_UIManager {
        constructor() {
            if (ComfyUI_UIManager.instance) {
                return ComfyUI_UIManager.instance;
            }
            this.domCache = new Map();
            this.modalStack = [];
            ComfyUI_UIManager.instance = this;
        }

        static getInstance() {
            if (!ComfyUI_UIManager.instance) {
                ComfyUI_UIManager.instance = new ComfyUI_UIManager();
            }
            return ComfyUI_UIManager.instance;
        }

        // --- DOM Utilities ---
        getElement(id, useCache = true) {
            if (useCache && this.domCache.has(id)) {
                const cached = this.domCache.get(id);
                if (cached && document.contains(cached)) {
                    return cached;
                }
                this.domCache.delete(id);
            }
            const element = document.getElementById(id);
            if (element && useCache) {
                this.domCache.set(id, element);
            }
            return element;
        }

        clearDOMCache() {
            this.domCache.clear();
        }

        // --- Event Registration ---
        register(idOrSelector, event, handler, opts = {}) {
            const node = typeof idOrSelector === 'string' ? this.getElement(idOrSelector) : idOrSelector;
            if (!node) return null;
            const clone = node.cloneNode(true);
            node.parentNode.replaceChild(clone, node);
            clone.addEventListener(event, handler, opts);
            return clone;
        }

        registerAll(selector, event, handler, opts = {}) {
            const nodes = Array.from(document.querySelectorAll(selector));
            return nodes.map(n => this.register(n, event, handler, opts));
        }

        // --- Toast Notifications ---
        showToast(message, type = 'info') {
            try {
                if (window.uiHelperFunctions?.showToastNotification) {
                    window.uiHelperFunctions.showToastNotification(message, type);
                } else if (window.uiHelperFunctions?.showToast) {
                    window.uiHelperFunctions.showToast(message, type);
                } else {
                    this.showFallbackToast(message, type);
                }
            } catch (error) {
                this.showFallbackToast(message, type);
            }
        }

        showFallbackToast(message, type = 'info') {
            const toast = document.createElement('div');
            toast.style.cssText = `
                position: fixed; top: 20px; right: 20px;
                background-color: ${type === 'error' ? '#dc3545' : type === 'success' ? '#28a745' : '#007bff'};
                color: white; padding: 12px 20px; border-radius: 4px; z-index: 10000;
                font-size: 14px; max-width: 300px; box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            `;
            toast.textContent = message;
            document.body.appendChild(toast);
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 3000);
        }

        // --- Modal Management ---
        openModal(modalId) {
            if (window.uiHelperFunctions) {
                window.uiHelperFunctions.openModal(modalId);
            } else {
                const modal = this.getElement(modalId);
                if (modal) modal.classList.add('active');
            }
            if (!this.modalStack.includes(modalId)) {
                this.modalStack.push(modalId);
            }
        }

        closeModal(modalId) {
            if (window.uiHelperFunctions) {
                window.uiHelperFunctions.closeModal(modalId);
            } else {
                const modal = this.getElement(modalId);
                if (modal) modal.classList.remove('active');
            }
            const index = this.modalStack.indexOf(modalId);
            if (index > -1) {
                this.modalStack.splice(index, 1);
            }
        }

        closeAllModals() {
            while (this.modalStack.length > 0) {
                const modalId = this.modalStack.pop();
                this.closeModal(modalId);
            }
        }
        
        // --- UI Updates ---
        updateConnectionStatus(isConnected) {
            const statusText = this.getElement('comfyUIConnectionStatus')?.querySelector('.status-text');
            const statusIndicator = this.getElement('comfyUIConnectionStatus')?.querySelector('.status-indicator');
            if (statusText && statusIndicator) {
                statusText.textContent = isConnected ? '已连接' : '未连接';
                statusIndicator.classList.toggle('online', isConnected);
                statusIndicator.classList.toggle('offline', !isConnected);
            }
        }
        
        setTestConnectionButtonState(enabled, text = '测试连接') {
            const testBtn = this.getElement('testConnectionBtn');
            if (testBtn) {
                testBtn.disabled = !enabled;
                testBtn.textContent = text;
            }
        }

        // --- UI Generation and Population ---
        createPanelContent(container, coordinator, options = {}) {
            if (!container) {
                return;
            }

            container.innerHTML = `
                <div class="drawer-header">
                    <h2>ComfyUI 图像生成配置</h2>
                    <button class="close-button" id="drawer-close-btn">&times;</button>
                </div>
                
                <div class="config-tabs">
                    <button class="config-tab-button ${ (options.defaultTab||'connection')==='parameters' ? 'active' : '' }" data-tab="parameters">生成参数</button>
                    <button class="config-tab-button ${ (options.defaultTab||'connection')==='connection' ? 'active' : '' }" data-tab="connection">连接设置</button>
                    <button class="config-tab-button ${ (options.defaultTab||'connection')==='prompt' ? 'active' : '' }" data-tab="prompt">提示词配置</button>
                    <button class="config-tab-button ${ (options.defaultTab||'connection')==='workflows' ? 'active' : '' }" data-tab="workflows">工作流管理</button>
                    <button class="config-tab-button ${ (options.defaultTab||'connection')==='import' ? 'active' : '' }" data-tab="import">导入工作流</button>
                </div>
                
                <div class="config-tab-content ${ (options.defaultTab||'connection')==='parameters' ? 'active' : '' }" id="parametersTab">
                    <div class="config-section">
                        <h3>尺寸预设</h3>
                        <div class="preset-buttons" id="sizePresetButtons">
                            <button type="button" class="preset-btn" data-width="512" data-height="512">512 x 512</button>
                            <button type="button" class="preset-btn" data-width="768" data-height="768">768 x 768</button>
                            <button type="button" class="preset-btn" data-width="1024" data-height="1024">1024 x 1024</button>
                            <button type="button" class="preset-btn" data-width="1216" data-height="832">1216 x 832</button>
                            <button type="button" class="preset-btn" data-width="832" data-height="1216">832 x 1216</button>
                            <button type="button" class="preset-btn" data-width="1280" data-height="720">1280 x 720</button>
                            <button type="button" class="preset-btn" data-width="720" data-height="1280">720 x 1280</button>
                        </div>
                    </div>
                    <div class="config-section">
                        <h3>核心参数</h3>
                        <div class="form-grid">
                            <div class="form-group">
                                <label for="workflowSelect">工作流模板:</label>
                                <select id="workflowSelect"></select>
                            </div>
                            <div class="form-group">
                                <label for="defaultModel">默认模型:</label>
                                <select id="defaultModel"></select>
                            </div>
                            <div class="form-group">
                                <label for="defaultWidth">宽度:</label>
                                <input type="number" id="defaultWidth" step="64">
                            </div>
                            <div class="form-group">
                                <label for="defaultHeight">高度:</label>
                                <input type="number" id="defaultHeight" step="64">
                            </div>
                            <div class="form-group">
                                <label for="defaultSteps">采样步数:</label>
                                <input type="number" id="defaultSteps" min="1" max="150">
                            </div>
                            <div class="form-group">
                                <label for="defaultCfg">CFG Scale:</label>
                                <input type="number" id="defaultCfg" min="1" max="30" step="0.5">
                            </div>
                            <div class="form-group">
                                <label for="defaultSampler">采样器:</label>
                                <select id="defaultSampler"></select>
                            </div>
                            <div class="form-group">
                                <label for="defaultScheduler">调度器:</label>
                                <select id="defaultScheduler"></select>
                            </div>
                        </div>
                    </div>
                     <details class="config-section-collapsible">
                        <summary>其他参数</summary>
                        <div class="form-grid">
                           <div class="form-group">
                                <label for="defaultSeed">随机种子 (-1为随机):</label>
                                <input type="number" id="defaultSeed">
                            </div>
                            <div class="form-group">
                                <label for="defaultBatchSize">生成数量:</label>
                                <input type="number" id="defaultBatchSize" min="1" max="10">
                            </div>
                            <div class="form-group">
                                <label for="defaultDenoise">去噪强度:</label>
                                <input type="number" id="defaultDenoise" min="0" max="1" step="0.01">
                            </div>
                        </div>
                    </details>
                </div>

                <div class="config-tab-content ${ (options.defaultTab||'connection')==='connection' ? 'active' : '' }" id="connectionTab">
                    <div class="config-section">
                        <h3>ComfyUI 连接配置</h3>
                        <div class="connection-status" id="comfyUIConnectionStatus">
                            <span class="status-indicator offline"></span>
                            <span class="status-text">未连接</span>
                            <button id="testConnectionBtn" class="small-button">测试连接</button>
                        </div>
                        <div class="form-group">
                            <label for="comfyUIServerUrl">ComfyUI 服务器地址:</label>
                            <input type="url" id="comfyUIServerUrl" placeholder="http://localhost:8188">
                        </div>
                        <div class="form-group">
                            <label for="comfyUIApiKey">API Key (可选):</label>
                            <input type="password" id="comfyUIApiKey" placeholder="留空则不使用认证">
                        </div>
                    </div>
                </div>

                <div class="config-tab-content ${ (options.defaultTab||'connection')==='prompt' ? 'active' : '' }" id="promptTab">
                    <details class="config-section-collapsible open">
                        <summary>LoRA 管理</summary>
                        <p class="section-description">管理LoRA模型...</p>
                        <div id="loraList" class="lora-list"></div>
                        <div class="lora-add-section">
                            <button id="addLoraBtn" class="sidebar-button">+ 添加 LoRA</button>
                        </div>
                    </details>
                    <details class="config-section-collapsible open">
                        <summary>提示词</summary>
                        <div class="form-group">
                            <label for="qualityTags">质量增强词:</label>
                            <textarea id="qualityTags" rows="3"></textarea>
                        </div>
                        <div class="form-group">
                            <label for="negativePrompt">默认负面提示词:</label>
                            <textarea id="negativePrompt" rows="4"></textarea>
                        </div>
                    </details>
                </div>
                
                <div class="config-tab-content ${ (options.defaultTab||'connection')==='workflows' ? 'active' : '' }" id="workflowsTab">
                     <div class="config-section">
                        <h3>工作流模板</h3>
                        <div class="workflow-list" id="workflowList">
                            <div class="workflow-loading">正在加载工作流...</div>
                        </div>
                        <button id="addWorkflowBtn" class="sidebar-button">添加新工作流</button>
                    </div>
                </div>
                <div class="config-tab-content ${ (options.defaultTab||'connection')==='import' ? 'active' : '' }" id="importTab">
                    <div class="config-section">
                        <h3>导入ComfyUI工作流</h3>
                        <div class="form-group">
                            <label for="workflowName">工作流名称:</label>
                            <input type="text" id="workflowName" placeholder="例如: 人物肖像-高清">
                        </div>
                        <div class="form-group">
                            <label for="workflowJson">工作流JSON:</label>
                            <textarea id="workflowJson" rows="10"></textarea>
                        </div>
                        <div class="import-actions">
                            <button id="validateWorkflowBtn" class="sidebar-button">验证格式</button>
                            <button id="convertWorkflowBtn" class="sidebar-button">转换并保存</button>
                        </div>
                        <div id="importResult" class="import-result" style="display: none;"></div>
                    </div>
                </div>

                <div class="drawer-footer">
                    <button type="button" id="saveComfyUIConfigBtn" class="sidebar-button primary">保存配置</button>
                    <button type="button" id="cancelComfyUIConfigBtn" class="sidebar-button">取消</button>
                </div>
            `;

            // Bind general events
            this.register('drawer-close-btn', 'click', () => coordinator.close());
            this.registerAll('.config-tab-button', 'click', (e) => this.switchTab(e.target.dataset.tab));
            this.register('saveComfyUIConfigBtn', 'click', () => coordinator.saveConfig());
            this.register('cancelComfyUIConfigBtn', 'click', () => coordinator.close());
            this.registerAll('#sizePresetButtons .preset-btn', 'click', (e) => {
                const { width, height } = e.target.dataset;
                if (width) this.getElement('defaultWidth').value = width;
                if (height) this.getElement('defaultHeight').value = height;
            });

            // Prompt tab: LoRA add button
            this.register('addLoraBtn', 'click', () => {
                const loras = coordinator.stateManager.get('loras') || [];
                const newItem = { name: '', strength: 1.0, clipStrength: 1.0, enabled: true };
                loras.push(newItem);
                coordinator.stateManager.set('loras', loras);
                this.updateLoraList(loras, coordinator);
            });

            // Workflows tab: actions
            this.register('addWorkflowBtn', 'click', () => {
                this.switchTab('import');
                const nameInput = this.getElement('workflowName');
                if (nameInput) nameInput.focus();
            });
            
            // Import tab actions
            this.register('validateWorkflowBtn', 'click', () => {
                const jsonText = this.getElement('workflowJson')?.value || '';
                try {
                    JSON.parse(jsonText);
                    this.showToast('JSON 格式有效', 'success');
                    const result = this.getElement('importResult');
                    if (result) {
                        result.style.display = 'block';
                        result.textContent = '校验通过';
                    }
                } catch (e) {
                    this.showToast(`JSON 格式错误: ${e.message}`, 'error');
                }
            });

            this.register('convertWorkflowBtn', 'click', async () => {
                try {
                    const name = (this.getElement('workflowName')?.value || '').trim();
                    const jsonText = this.getElement('workflowJson')?.value || '';
                    if (!name) {
                        this.showToast('请输入工作流名称', 'error');
                        return;
                    }
                    let parsed;
                    try {
                        parsed = JSON.parse(jsonText);
                    } catch (e) {
                        this.showToast(`JSON 格式错误: ${e.message}`, 'error');
                        return;
                    }
                    if (!window.electronAPI?.invoke) {
                        this.showToast('IPC未就绪，无法保存工作流', 'error');
                        return;
                    }

                    // 显示转换状态
                    const result = this.getElement('importResult');
                    if (result) {
                        result.style.display = 'block';
                        result.innerHTML = '<div style="color: #007cba;">🔄 正在转换并保存工作流...</div>';
                    }

                    console.log('[VCPHumanToolBox] 调用模板转换接口');
                    console.log('[VCPHumanToolBox] name:', name);
                    console.log('[VCPHumanToolBox] workflowData type:', typeof parsed);

                    // 使用新的模板转换接口
                    const resp = await window.electronAPI.invoke('import-and-convert-workflow', parsed, name);
                    
                    if (resp?.success) {
                        this.showToast('工作流转换并保存成功！', 'success');
                        setTimeout(() => coordinator.populateWorkflowSelect(), 300);
                        setTimeout(() => coordinator.loadAvailableWorkflows(), 300);
                        
                        // 显示成功结果
                        if (result) {
                            result.innerHTML = `<div style="color: #28a745;">✅ ${resp.message || '转换并保存成功！'}<br>保存位置: ${resp.path || '未知'}</div>`;
                        }

                        // 清空输入框
                        this.getElement('workflowName').value = '';
                        this.getElement('workflowJson').value = '';

                        console.log('[VCPHumanToolBox] 转换保存成功:', resp);
                    } else {
                        throw new Error(resp?.error || '模板转换失败');
                    }
                } catch (e) {
                    console.error('[VCPHumanToolBox] 转换保存失败:', e);
                    this.showToast(`转换保存失败: ${e.message}`, 'error');
                    
                    const result = this.getElement('importResult');
                    if (result) {
                        result.innerHTML = `<div style="color: #dc3545;">❌ 转换失败: ${e.message}</div>`;
                    }
                }
            });
        }

        switchTab(tabName) {
            document.querySelectorAll('.config-tab-button').forEach(btn => btn.classList.remove('active'));
            const targetBtn = document.querySelector(`[data-tab="${tabName}"]`);
            if (targetBtn) targetBtn.classList.add('active');
            document.querySelectorAll('.config-tab-content').forEach(content => content.classList.remove('active'));
            const targetTab = this.getElement(`${tabName}Tab`);
            if (targetTab) targetTab.classList.add('active');
        }

        populateForm(config) {
            const elements = {
                'comfyUIServerUrl': config.serverUrl,
                'comfyUIApiKey': config.apiKey,
                'workflowSelect': config.workflow,
                'defaultModel': config.defaultModel,
                'defaultWidth': config.defaultWidth,
                'defaultHeight': config.defaultHeight,
                'defaultSteps': config.defaultSteps,
                'defaultCfg': config.defaultCfg,
                'defaultSampler': config.defaultSampler,
                'defaultScheduler': config.defaultScheduler,
                'defaultSeed': config.defaultSeed,
                'defaultBatchSize': config.defaultBatchSize,
                'defaultDenoise': config.defaultDenoise,
                'qualityTags': config.qualityTags || '',
                'negativePrompt': config.negativePrompt
            };

            for (const [id, value] of Object.entries(elements)) {
                const el = this.getElement(id);
                if (el && String(el.value) !== String(value)) {
                    el.value = value;
                }
            }
        }
        
        updateWorkflowList(workflows, coordinator) {
            const workflowList = this.getElement('workflowList');
            if (!workflowList) return;

            if (!workflows || workflows.length === 0) {
                workflowList.innerHTML = '<div class="workflow-empty">暂无工作流</div>';
                return;
            }

            workflowList.innerHTML = '';
            workflows.forEach(workflow => {
                const item = document.createElement('div');
                item.className = 'workflow-item';
                item.innerHTML = `
                    <span class="workflow-name">${workflow.displayName || workflow.name}</span>
                    <div class="workflow-actions">
                        <button class="small-button view-workflow">查看</button>
                        <button class="small-button edit-workflow">编辑</button>
                        <button class="small-button danger delete-workflow">删除</button>
                    </div>
                `;

                const viewOrEdit = async () => {
                    try {
                        if (!window.electronAPI?.invoke) {
                            this.showToast('IPC未就绪', 'error');
                            return;
                        }
                        const resp = await window.electronAPI.invoke('comfyui:read-workflow', { name: workflow.name });
                        if (resp?.success) {
                            this.switchTab('import');
                            const nameInput = this.getElement('workflowName');
                            const jsonInput = this.getElement('workflowJson');
                            if (nameInput) nameInput.value = workflow.name;
                            if (jsonInput) jsonInput.value = JSON.stringify(resp.data, null, 2);
                            this.showToast('已加载工作流内容', 'info');
                        } else {
                            throw new Error(resp?.error || '读取失败');
                        }
                    } catch (e) {
                        this.showToast(`读取工作流失败: ${e.message}`, 'error');
                    }
                };

                this.register(item.querySelector('.view-workflow'), 'click', viewOrEdit);
                this.register(item.querySelector('.edit-workflow'), 'click', viewOrEdit);
                
                this.register(item.querySelector('.delete-workflow'), 'click', async () => {
                    try {
                        if (!confirm(`确定要删除工作流 "${workflow.displayName || workflow.name}" 吗？`)) return;
                        if (!window.electronAPI?.invoke) {
                            this.showToast('IPC未就绪', 'error');
                            return;
                        }
                        const resp = await window.electronAPI.invoke('comfyui:delete-workflow', { name: workflow.name });
                        if (resp?.success) {
                            this.showToast('工作流已删除', 'success');
                            coordinator.loadAvailableWorkflows();
                            coordinator.populateWorkflowSelect();
                        } else {
                            throw new Error(resp?.error || '删除失败');
                        }
                    } catch (e) {
                        this.showToast(`删除工作流失败: ${e.message}`, 'error');
                    }
                });

                workflowList.appendChild(item);
            });
        }
        
        updateModelOptions(models, currentModel) {
            const modelSelect = this.getElement('defaultModel');
            if (!modelSelect) return;

            modelSelect.innerHTML = '';
            models.forEach(model => {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                if (model === currentModel) {
                    option.selected = true;
                }
                modelSelect.appendChild(option);
            });
        }

        updateLoraList(loras, coordinator) {
            const loraList = this.getElement('loraList');
            if (!loraList) return;

            const availableLoras = coordinator.stateManager.getAvailableLoRAs
                ? coordinator.stateManager.getAvailableLoRAs()
                : (coordinator.stateManager.get && coordinator.stateManager.get('availableLoRAs')) || [];

            if (!Array.isArray(loras) || loras.length === 0) {
                loraList.innerHTML = '<div class="lora-empty">暂无 LoRA</div>';
                return;
            }

            loraList.innerHTML = '';
            loras.forEach((lora, idx) => {
                const row = document.createElement('div');
                row.className = 'lora-row';

                // Create select for LoRA name
                const select = document.createElement('select');
                select.className = 'lora-name';

                // Add a disabled placeholder option
                const placeholder = document.createElement('option');
                placeholder.value = '';
                placeholder.textContent = '选择一个LoRA模型...';
                placeholder.disabled = true;
                if (!lora.name) placeholder.selected = true;
                select.appendChild(placeholder);

                // Populate with available LoRAs
                availableLoras.forEach(loraName => {
                    const option = document.createElement('option');
                    option.value = loraName;
                    option.textContent = loraName;
                    if (loraName === lora.name) {
                        option.selected = true;
                    }
                    select.appendChild(option);
                });

                row.innerHTML = `
                    <input class="lora-enabled" type="checkbox" ${lora.enabled ? 'checked' : ''} title="启用">
                    <div class="lora-select-wrapper"></div>
                    <input class="lora-strength" type="number" step="0.05" min="0" max="2" value="${lora.strength ?? 1.0}" title="模型强度">
                    <input class="lora-clip" type="number" step="0.05" min="0" max="2" value="${lora.clipStrength ?? lora.strength ?? 1.0}" title="CLIP强度">
                    <button class="small-button danger lora-remove">移除</button>
                `;
                row.querySelector('.lora-select-wrapper').appendChild(select);

                const updateState = (key, value) => {
                    const currentLoras = coordinator.stateManager.get('loras') || [];
                    currentLoras[idx] = { ...currentLoras[idx], [key]: value };
                    coordinator.stateManager.set('loras', currentLoras);
                };
                
                this.register(row.querySelector('.lora-enabled'), 'change', (e) => updateState('enabled', e.target.checked));
                this.register(select, 'change', (e) => updateState('name', e.target.value));
                this.register(row.querySelector('.lora-strength'), 'input', (e) => updateState('strength', parseFloat(e.target.value) || 1.0));
                this.register(row.querySelector('.lora-clip'), 'input', (e) => updateState('clipStrength', parseFloat(e.target.value) || 1.0));
                
                this.register(row.querySelector('.lora-remove'), 'click', () => {
                    const currentLoras = (coordinator.stateManager.get('loras') || []).slice();
                    currentLoras.splice(idx, 1);
                    coordinator.stateManager.set('loras', currentLoras);
                    this.updateLoraList(currentLoras, coordinator); // Re-render the list
                });

                loraList.appendChild(row);
            });
        }

        updateSamplerOptions(samplers, currentSampler) {
            const samplerSelect = this.getElement('defaultSampler');
            if (!samplerSelect) return;
            this.populateSelect(samplerSelect, samplers, currentSampler);
        }

        updateSchedulerOptions(schedulers, currentScheduler) {
            const schedulerSelect = this.getElement('defaultScheduler');
            if (!schedulerSelect) return;
            this.populateSelect(schedulerSelect, schedulers, currentScheduler);
        }

        populateSelect(selectElement, options, currentValue) {
            if (!selectElement) return;
            selectElement.innerHTML = '';
            options.forEach(opt => {
                const option = document.createElement('option');
                option.value = opt;
                option.textContent = opt;
                if (opt === currentValue) {
                    option.selected = true;
                }
                selectElement.appendChild(option);
            });
        }
        
    }

    window.ComfyUI_UIManager = ComfyUI_UIManager.getInstance();
})();