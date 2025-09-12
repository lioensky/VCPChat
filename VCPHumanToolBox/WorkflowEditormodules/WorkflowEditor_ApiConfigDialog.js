// WorkflowEditor API Configuration Dialog Module
(function() {
    'use strict';

    class WorkflowEditor_ApiConfigDialog {
        constructor() {
            this.dialog = null;
            this.pluginManager = null;
            this.isVisible = false;
        }

        // 初始化配置对话框
        init(pluginManager) {
            this.pluginManager = pluginManager;
            this.createDialog();
            this.bindEvents();
            console.log('[ApiConfigDialog] Initialized');
        }

        // 创建对话框HTML结构
        createDialog() {
            const dialogHTML = `
                <div id="api-config-dialog" class="workflow-dialog" style="display: none;">
                    <div class="dialog-overlay"></div>
                    <div class="dialog-content">
                        <div class="dialog-header">
                            <h3>插件API配置</h3>
                            <button class="dialog-close-btn" id="api-config-close-btn">×</button>
                        </div>
                        <div class="dialog-body">
                            <form id="api-config-form">
                                <div class="form-group">
                                    <label for="api-host">服务器地址:</label>
                                    <input type="text" id="api-host" name="host" placeholder="例如: 49.235.138.100" required>
                                    <small class="form-help">输入插件服务器的IP地址或域名</small>
                                </div>
                                
                                <div class="form-group">
                                    <label for="api-port">端口:</label>
                                    <input type="number" id="api-port" name="port" placeholder="6005" min="1" max="65535" required>
                                    <small class="form-help">服务器端口号，通常为6005</small>
                                </div>
                                
                                <div class="form-group">
                                    <label for="api-username">用户名:</label>
                                    <input type="text" id="api-username" name="username" placeholder="可选">
                                    <small class="form-help">如果服务器需要认证，请输入用户名</small>
                                </div>
                                
                                <div class="form-group">
                                    <label for="api-password">密码:</label>
                                    <input type="password" id="api-password" name="password" placeholder="可选">
                                    <small class="form-help">如果服务器需要认证，请输入密码</small>
                                </div>
                                
                                <div class="form-group">
                                    <div class="connection-status" id="connection-status">
                                        <span class="status-indicator" id="status-indicator">●</span>
                                        <span class="status-text" id="status-text">未连接</span>
                                    </div>
                                </div>
                            </form>
                        </div>
                        <div class="dialog-footer">
                            <button type="button" class="btn btn-secondary" id="test-connection-btn">测试连接</button>
                            <button type="button" class="btn btn-secondary" id="cancel-config-btn">取消</button>
                            <button type="button" class="btn btn-primary" id="save-config-btn">保存配置</button>
                        </div>
                    </div>
                </div>
            `;

            // 添加到页面
            document.body.insertAdjacentHTML('beforeend', dialogHTML);
            this.dialog = document.getElementById('api-config-dialog');
        }

        // 绑定事件
        bindEvents() {
            const closeBtn = document.getElementById('api-config-close-btn');
            const cancelBtn = document.getElementById('cancel-config-btn');
            const saveBtn = document.getElementById('save-config-btn');
            const testBtn = document.getElementById('test-connection-btn');
            const overlay = this.dialog.querySelector('.dialog-overlay');

            // 关闭对话框事件
            [closeBtn, cancelBtn, overlay].forEach(element => {
                element.addEventListener('click', () => this.hide());
            });

            // 保存配置
            saveBtn.addEventListener('click', () => this.saveConfig());

            // 测试连接
            testBtn.addEventListener('click', () => this.testConnection());

            // ESC键关闭
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.isVisible) {
                    this.hide();
                }
            });

            // 表单输入变化时清除状态
            const form = document.getElementById('api-config-form');
            form.addEventListener('input', () => {
                this.updateConnectionStatus('unknown', '配置已更改，请重新测试连接');
            });

            // 监听插件管理器的保存状态事件
            document.addEventListener('pluginManagerSaving', (e) => {
                this.showSaveStatus('loading', e.detail.message);
            });

            document.addEventListener('pluginManagerSaveSuccess', (e) => {
                this.showSaveStatus('success', e.detail.message);
            });

            document.addEventListener('pluginManagerSaveError', (e) => {
                this.showSaveStatus('error', e.detail.message);
            });

            document.addEventListener('pluginManagerSaveStateHide', (e) => {
                this.hideSaveStatus();
            });
        }

        // 显示对话框
        show() {
            if (!this.dialog) return;
            
            // 加载当前配置
            this.loadCurrentConfig();
            
            this.dialog.style.display = 'block';
            this.isVisible = true;
            
            // 聚焦到第一个输入框
            const firstInput = this.dialog.querySelector('input');
            if (firstInput) {
                setTimeout(() => firstInput.focus(), 100);
            }
        }

        // 隐藏对话框
        hide() {
            if (!this.dialog) return;
            
            this.dialog.style.display = 'none';
            this.isVisible = false;
        }

        // 加载当前配置
        loadCurrentConfig() {
            if (!this.pluginManager) return;

            const config = this.pluginManager.getApiConfig();
            
            document.getElementById('api-host').value = config.host || '';
            document.getElementById('api-port').value = config.port || '';
            document.getElementById('api-username').value = config.username || '';
            document.getElementById('api-password').value = config.password || '';

            // 如果有配置，显示连接状态
            if (config.host && config.port) {
                this.updateConnectionStatus('unknown', '点击"测试连接"验证配置');
            } else {
                this.updateConnectionStatus('disconnected', '请填写服务器配置');
            }
        }

        // 保存配置
        async saveConfig() {
            const form = document.getElementById('api-config-form');
            const formData = new FormData(form);
            
            const config = {
                host: formData.get('host').trim(),
                port: formData.get('port').trim(),
                username: formData.get('username').trim(),
                password: formData.get('password').trim()
            };

            // 验证必填字段
            if (!config.host || !config.port) {
                this.showMessage('请填写服务器地址和端口', 'error');
                return;
            }

            try {
                // 保存配置
                this.pluginManager.setApiConfig(config);
                
                // 显示成功消息
                this.showMessage('配置已保存', 'success');
                
                // 自动刷新插件列表
                if (this.pluginManager) {
                    try {
                        await this.pluginManager.refreshPlugins();
                        this.showMessage('插件列表已更新', 'success');
                    } catch (error) {
                        console.warn('[ApiConfigDialog] Failed to refresh plugins after config save:', error);
                    }
                }
                
                // 延迟关闭对话框
                setTimeout(() => this.hide(), 1500);
                
            } catch (error) {
                console.error('[ApiConfigDialog] Failed to save config:', error);
                this.showMessage('保存配置失败: ' + error.message, 'error');
            }
        }

        // 测试连接
        async testConnection() {
            const form = document.getElementById('api-config-form');
            const formData = new FormData(form);
            
            const config = {
                host: formData.get('host').trim(),
                port: formData.get('port').trim(),
                username: formData.get('username').trim(),
                password: formData.get('password').trim()
            };

            // 验证必填字段
            if (!config.host || !config.port) {
                this.updateConnectionStatus('error', '请填写服务器地址和端口');
                return;
            }

            // 显示测试中状态
            this.updateConnectionStatus('testing', '正在测试连接...');
            
            const testBtn = document.getElementById('test-connection-btn');
            testBtn.disabled = true;
            testBtn.textContent = '测试中...';

            try {
                const apiUrl = `http://${config.host}:${config.port}/admin_api/plugins`;
                
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);

                const response = await fetch(apiUrl, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(config.username && config.password ? {
                            'Authorization': 'Basic ' + btoa(`${config.username}:${config.password}`)
                        } : {})
                    },
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (response.ok) {
                    const data = await response.json();
                    const pluginCount = Array.isArray(data) ? data.length : 0;
                    this.updateConnectionStatus('connected', `连接成功！发现 ${pluginCount} 个插件`);
                } else {
                    this.updateConnectionStatus('error', `连接失败: HTTP ${response.status}`);
                }

            } catch (error) {
                let errorMessage = '连接失败';
                if (error.name === 'AbortError') {
                    errorMessage = '连接超时';
                } else if (error.message.includes('Failed to fetch')) {
                    errorMessage = '无法连接到服务器，请检查地址和端口';
                } else {
                    errorMessage = `连接错误: ${error.message}`;
                }
                this.updateConnectionStatus('error', errorMessage);
            } finally {
                testBtn.disabled = false;
                testBtn.textContent = '测试连接';
            }
        }

        // 更新连接状态显示
        updateConnectionStatus(status, message) {
            const indicator = document.getElementById('status-indicator');
            const text = document.getElementById('status-text');
            
            if (!indicator || !text) return;

            // 移除所有状态类
            indicator.className = 'status-indicator';
            
            // 添加对应状态类
            switch (status) {
                case 'connected':
                    indicator.classList.add('status-connected');
                    break;
                case 'error':
                    indicator.classList.add('status-error');
                    break;
                case 'testing':
                    indicator.classList.add('status-testing');
                    break;
                case 'disconnected':
                    indicator.classList.add('status-disconnected');
                    break;
                default:
                    indicator.classList.add('status-unknown');
            }
            
            text.textContent = message;
        }

        // 显示消息提示
        showMessage(message, type = 'info') {
            // 创建消息元素
            const messageEl = document.createElement('div');
            messageEl.className = `config-message config-message-${type}`;
            messageEl.textContent = message;
            
            // 添加到对话框
            const dialogBody = this.dialog.querySelector('.dialog-body');
            dialogBody.insertBefore(messageEl, dialogBody.firstChild);
            
            // 自动移除
            setTimeout(() => {
                if (messageEl.parentNode) {
                    messageEl.parentNode.removeChild(messageEl);
                }
            }, 3000);
        }

        // 显示保存状态
        showSaveStatus(type, message) {
            const saveBtn = document.getElementById('save-config-btn');
            if (!saveBtn) return;

            // 移除现有的保存状态元素
            this.hideSaveStatus();

            // 创建保存状态元素
            const statusEl = document.createElement('div');
            statusEl.id = 'save-status-indicator';
            statusEl.className = `save-status save-status-${type}`;
            
            // 根据类型添加图标和文本
            let iconHtml = '';
            switch (type) {
                case 'loading':
                    iconHtml = '<span class="spinner">⟳</span>';
                    saveBtn.disabled = true;
                    break;
                case 'success':
                    iconHtml = '<span class="checkmark">✓</span>';
                    saveBtn.disabled = false;
                    break;
                case 'error':
                    iconHtml = '<span class="error-icon">✗</span>';
                    saveBtn.disabled = false;
                    break;
            }
            
            statusEl.innerHTML = `${iconHtml} <span class="status-message">${message}</span>`;
            
            // 插入到保存按钮旁边
            saveBtn.parentNode.insertBefore(statusEl, saveBtn.nextSibling);
        }

        // 隐藏保存状态
        hideSaveStatus() {
            const statusEl = document.getElementById('save-status-indicator');
            if (statusEl) {
                statusEl.remove();
            }
            
            // 恢复保存按钮状态
            const saveBtn = document.getElementById('save-config-btn');
            if (saveBtn) {
                saveBtn.disabled = false;
            }
        }

        // 获取当前配置
        getCurrentConfig() {
            if (!this.pluginManager) return null;
            return this.pluginManager.getApiConfig();
        }

        // 检查是否已配置
        isConfigured() {
            const config = this.getCurrentConfig();
            return config && config.host && config.port;
        }
    }

    // 导出为全局单例
    window.WorkflowEditor_ApiConfigDialog = new WorkflowEditor_ApiConfigDialog();
})();