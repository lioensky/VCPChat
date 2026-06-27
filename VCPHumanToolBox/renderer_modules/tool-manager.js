// renderer_modules/tool-manager.js
// VCPHumanToolBox 插件管理模块
// 负责从后端导入插件、保存为用户工具定义、CRUD用户工具
// 最后更新: 2026-06-25 by 程宸Cod v0.3-final

/**
 * 工具管理器 - 核心模块
 * 功能：
 * 1. 从后端 /admin_api/plugins 获取插件列表
 * 2. 解析 manifest.invocationCommands 转换为 config.js 兼容格式
 * 3. 从description文本自动解析参数（三层fallback）
 * 4. 保存/读取用户自定义工具到 settings.vcpht_userTools
 * 5. 提供管理面板UI：导入、编辑、删除、Raw JSON编辑
 */

export class ToolManager {
    constructor() {
        this.adminConfig = this.loadAdminConfig();
        this.userTools = {}; // 从settings.vcpht_userTools加载
    }

    // ========================================
    // 配置管理
    // ========================================

    loadAdminConfig() {
        const stored = localStorage.getItem('vcpht_adminConfig');
        if (stored) {
            try {
                return JSON.parse(stored);
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    saveAdminConfig(config) {
        localStorage.setItem('vcpht_adminConfig', JSON.stringify(config));
        this.adminConfig = config;
    }

    // ========================================
    // 用户工具的持久化（settings.vcpht_userTools）
    // ========================================

    async loadUserTools() {
        try {
            const settings = await window.electronAPI.invoke('vcp-ht-get-settings');
            this.userTools = settings.vcpht_userTools || {};
            return this.userTools;
        } catch (error) {
            console.error('[ToolManager] 加载用户工具失败:', error);
            this.userTools = {};
            return {};
        }
    }

    async saveUserTools() {
        try {
            const settings = await window.electronAPI.invoke('vcp-ht-get-settings');
            settings.vcpht_userTools = this.userTools;
            const result = await window.electronAPI.invoke('vcp-ht-save-settings', settings);
            if (!result.success) {
                throw new Error(result.error || '保存失败');
            }
            console.log('[ToolManager] 用户工具已保存');
            return true;
        } catch (error) {
            console.error('[ToolManager] 保存用户工具失败:', error);
            throw error;
        }
    }

    // ========================================
    // 后端插件获取
    // ========================================

    async fetchPlugins() {
        if (!this.adminConfig) {
            throw new Error('请先配置后端连接信息');
        }

        const { host, port, username, password } = this.adminConfig;
        const url = `http://${host}:${port}/admin_api/plugins`;
        const auth = 'Basic ' + btoa(`${username}:${password}`);

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': auth,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            const plugins = await response.json();
            return plugins; // Array<{name, manifest, isDistributed, enabled, ...}>
        } catch (error) {
            console.error('[ToolManager] 获取插件列表失败:', error);
            throw error;
        }
    }

    // ========================================
    // Description文本解析（三格式兼容）
    // ========================================

    parseDescription(description, commandName = '') {
        const params = [];
        if (!description) return params;

        // 找参数区域起始位置
        const paramSection = description.match(/(?:参数[说明]*[:：]|Parameters[:：]|参数\s*\(|参数说明\s*\()([\s\S]+?)(?=调用格式|示例|Example|$)/i);
        if (!paramSection) return params;

        const text = paramSection[1];

        // 格式A/C：- 参数名 (类型, 必填): 描述  或  - 参数名/别名: 描述
        const lineRegex = /^[-*]\s*`?([^`:\n(]+(?:\/[^`:\n(]+)*)`?\s*(?:\(([^)]+)\))?\s*[:：]\s*(.+)/gm;
        let match;
        const foundParams = [];

        while ((match = lineRegex.exec(text)) !== null) {
            const [, nameRaw, typeHint, desc] = match;
            const names = nameRaw.trim().split('/').map(n => n.trim()).filter(Boolean);
            const primaryName = names[0];

            // 跳过固定参数
            if (['tool_name', 'command', 'maid'].includes(primaryName)) continue;

            const required = /必需|required|必填/i.test(desc + (typeHint || ''));
            const type = this.inferTypeFromHint(typeHint || '', desc);
            const options = this.extractOptions(desc);

            foundParams.push({
                name: primaryName,
                type: options.length > 0 ? 'select' : type,
                required,
                placeholder: desc.replace(/必需|可选|必填|字符串|整数|数字|可选值[:：]/gi, '').trim().slice(0, 60),
                description: desc.trim().slice(0, 100),
                options: options.length > 0 ? options : undefined
            });
        }

        // 格式B：数字列表 N. `param`: 描述
        if (foundParams.length === 0) {
            const numberedRegex = /^\d+\.\s+`?([^`:\n(]+)`?\s*[:：]\s*[「「]?始[」」]?[^」」]*[「「]?末[」」]?\s*(?:\(([^)]+)\))?\s*(.+)/gm;
            while ((match = numberedRegex.exec(text)) !== null) {
                const [, nameRaw, typeHint, desc] = match;
                if (['tool_name', 'command', 'maid'].includes(nameRaw.trim())) continue;

                const required = /必需|required|必填/i.test((typeHint || '') + desc);
                foundParams.push({
                    name: nameRaw.trim(),
                    type: this.inferTypeFromHint(typeHint || '', desc),
                    required,
                    placeholder: desc.replace(/必需|可选|字符串|必填/gi, '').trim().slice(0, 60),
                    description: desc.trim().slice(0, 100)
                });
            }
        }

        // 格式D：VCP调用格式 参数名:「始」(必需/可选) 描述「末」
        if (foundParams.length === 0) {
            const vcpFormatRegex = /(\w+)[:：]\s*[「「]始[」」]\s*\(([^)]+)\)\s*([^「」]+)[「「]末[」」]/g;
            while ((match = vcpFormatRegex.exec(description)) !== null) {
                const [, nameRaw, hint, desc] = match;
                if (['tool_name', 'command', 'maid'].includes(nameRaw.trim())) continue;

                const required = /必需|required|必填/i.test(hint);
                const type = this.inferTypeFromHint(hint, desc);
                const options = this.extractOptions(desc);

                foundParams.push({
                    name: nameRaw.trim(),
                    type: options.length > 0 ? 'select' : type,
                    required,
                    placeholder: desc.replace(/必需|可选|必填|字符串/gi, '').trim().slice(0, 60),
                    description: desc.trim().slice(0, 100),
                    options: options.length > 0 ? options : undefined
                });
            }
        }

        // 🔧 新增：格式F - VCP TOOL_REQUEST 嵌入式示例格式
        // 适配 AgnesGen/DoubaoGen 等插件：参数在 <<<[TOOL_REQUEST]>>> 示例中定义
        // 格式：参数名:__VCP_STYLE_PROTECT_5__,
        if (foundParams.length === 0 && /<<<\[TOOL_REQUEST\]>>>/i.test(description)) {
            const toolRequestBlock = description.match(/<<<\[TOOL_REQUEST\]>>>([\s\S]+?)<<<\[END_TOOL_REQUEST\]>>>/i);
            if (toolRequestBlock) {
                const blockText = toolRequestBlock[1];
                // 正则：参数名:__VCP_STYLE_PROTECT_6__
                const embeddedParamRegex = /(\w+)\s*[:：]\s*[「「]始[」」]\s*\(([^)]+)\)\s*([^「」]+?)[「「]末[」」]/g;
                let embedMatch;
                while ((embedMatch = embeddedParamRegex.exec(blockText)) !== null) {
                    const [, nameRaw, hint, desc] = embedMatch;
                    if (['tool_name', 'command', 'maid'].includes(nameRaw.trim())) continue;

                    const required = /必需|required|必填/i.test(hint);
                    const type = this.inferTypeFromHint(hint, desc);
                    const options = this.extractOptions(desc);

                    foundParams.push({
                        name: nameRaw.trim(),
                        type: options.length > 0 ? 'select' : type,
                        required,
                        placeholder: desc.replace(/必需|可选|必填|字符串|也兼容|统一尺寸字段/gi, '').trim().slice(0, 60),
                        description: desc.trim().slice(0, 100),
                        options: options.length > 0 ? options : undefined
                    });
                }
            }
        }

        // 始终注入maid参数到第一位
        if (!foundParams.find(p => p.name === 'maid')) {
            foundParams.unshift({ name: 'maid', type: 'text', required: true, placeholder: '你的名字' });
        }

        return foundParams;
    }

    inferTypeFromHint(hint, desc) {
        const combined = (hint + ' ' + desc).toLowerCase();
        if (/bool|true.*false|false.*true|true\/false|是\/否/i.test(combined)) return 'checkbox';
        if (/int|integer|number|数字|整数|数量/i.test(combined)) return 'number';
        if (/text|长文本|详细|内容|正文|textarea/i.test(combined)) return 'textarea';
        if (/url|路径|链接|file:|http/i.test(combined)) return 'text';
        return 'text';
    }

    extractOptions(desc) {
        // 提取 mail1/mail2/mail3/mail4 这类斜杠分隔枚举
        const slashMatch = desc.match(/\b(\w+(?:\/\w+){2,})\b/);
        if (slashMatch) {
            const opts = slashMatch[1].split('/').filter(s => s.length > 0 && s.length < 30);
            if (opts.length >= 2) return opts;
        }

        // 提取 'value1', 'value2' 引号枚举
        const quoteMatches = desc.match(/'([^']+)'/g);
        if (quoteMatches && quoteMatches.length >= 2) {
            return quoteMatches.map(s => s.replace(/'/g, ''));
        }

        // 提取可选值：xxx、xxx、xxx
        const colonMatch = desc.match(/可选值?[:：]\s*([^\n。]+)/i);
        if (colonMatch) {
            const opts = colonMatch[1].split(/[,、，|]/).map(s => s.trim()).filter(Boolean);
            if (opts.length >= 2) return opts;
        }

        return [];
    }

    // ========================================
    // 插件适配：manifest → config.js格式
    // ========================================

    adaptPlugin(apiPlugin) {
        const { name, manifest } = apiPlugin;
        if (!manifest || !manifest.capabilities || !manifest.capabilities.invocationCommands) {
            return null;
        }

        let invocationCommands = manifest.capabilities.invocationCommands;

        // 兼容数组格式（分布式插件）和对象格式（后端插件）
        if (Array.isArray(invocationCommands)) {
            const commandsObj = {};
            invocationCommands.forEach(cmd => {
                const cmdName = cmd.command || cmd.commandIdentifier || 'default';
                commandsObj[cmdName] = cmd;
            });
            invocationCommands = commandsObj;
        }

        const commandNames = Object.keys(invocationCommands);

        // 单命令工具
        if (commandNames.length === 1) {
            const cmdName = commandNames[0];
            const singleCmd = invocationCommands[cmdName];
            let params = this.parseParams(singleCmd.parameters || {});

            // 三层fallback：parameters为空时尝试parseDescription
            if (params.length === 0 && singleCmd.description) {
                params = this.parseDescription(singleCmd.description, cmdName);
            }

            // 仍为空，只放maid
            if (params.length === 0) {
                params = [{ name: 'maid', type: 'text', required: true, placeholder: '你的名字' }];
            }

            return {
                displayName: manifest.displayName || name,
                description: manifest.description || '',
                params
            };
        }

        // 多命令工具
        const adapted = {
            displayName: manifest.displayName || name,
            description: manifest.description || '',
            commands: {}
        };

        for (const cmdName in invocationCommands) {
            const cmd = invocationCommands[cmdName];
            let params = this.parseParams(cmd.parameters || {});

            // 三层fallback
            if (params.length === 0 && cmd.description) {
                params = this.parseDescription(cmd.description, cmdName);
            }

            if (params.length === 0) {
                params = [{ name: 'maid', type: 'text', required: true, placeholder: '你的名字' }];
            }

            adapted.commands[cmdName] = {
                description: cmd.description || '',
                params
            };
        }

        return adapted;
    }

    parseParams(parameters) {
        const params = [];
        for (const paramName in parameters) {
            const param = parameters[paramName];
            const parsed = {
                name: paramName,
                type: this.inferType(param),
                required: param.required || false,
                placeholder: param.description || '',
                description: param.description || ''
            };

            // 提取默认值
            if (param.default !== undefined) {
                parsed.default = param.default;
            }

            // 提取枚举选项
            if (param.enum && Array.isArray(param.enum)) {
                parsed.options = param.enum;
                parsed.type = 'select';
            }

            params.push(parsed);
        }
        return params;
    }

    inferType(param) {
        if (param.type === 'number' || param.type === 'integer') return 'number';
        if (param.type === 'boolean') return 'checkbox';
        if (param.enum && Array.isArray(param.enum)) return 'select';
        if (param.type === 'array') return 'textarea';

        const desc = (param.description || '').toLowerCase();
        if (desc.includes('url') || desc.includes('路径') || desc.includes('长文本') || desc.includes('详细')) {
            return 'textarea';
        }

        return 'text';
    }

    // ========================================
    // 用户工具CRUD
    // ========================================

    addUserTool(toolName, toolDefinition) {
        this.userTools[toolName] = toolDefinition;
    }

    updateUserTool(toolName, toolDefinition) {
        if (!this.userTools[toolName]) {
            throw new Error(`工具 ${toolName} 不存在`);
        }
        this.userTools[toolName] = toolDefinition;
    }

    deleteUserTool(toolName) {
        if (!this.userTools[toolName]) {
            throw new Error(`工具 ${toolName} 不存在`);
        }
        delete this.userTools[toolName];
    }

    getUserTool(toolName) {
        return this.userTools[toolName];
    }

    listUserTools() {
        return Object.keys(this.userTools).map(name => ({
            name,
            ...this.userTools[name]
        }));
    }
}

// ========================================
// UI 渲染模块
// ========================================

export class ToolManagerUI {
    constructor(toolManager) {
        this.manager = toolManager;
        this.container = null;
        this.deleteMode = false; // 删除模式开关
        this.selectedForDelete = new Set(); // 删除模式选中项
    }

    async init(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            throw new Error(`容器 ${containerId} 不存在`);
        }

        await this.manager.loadUserTools();
        this.render();
    }

    render() {
        this.container.innerHTML = `
            <div class="tool-manager-panel">
                <div class="tm-header">
                    <h3>插件管理</h3>
                    <div class="tm-actions">
                        <input type="text" id="tm-global-search" placeholder="🔍 搜索工具..." style="width:200px;padding:8px 12px;background:var(--input-bg);border:1px solid var(--border-color);border-radius:6px;color:var(--primary-text);font-size:14px;margin-right:10px;">
                        <button class="tm-btn tm-btn-danger" id="tm-delete-mode-btn" style="margin-right:10px">删除模式</button>
                        <button class="tm-btn tm-btn-primary" id="tm-import-btn" style="border:2px solid rgba(59,130,246,0.5)">导入插件</button>
                    </div>
                </div>
                <div class="tm-content">
                    <div class="tm-user-tools-list" id="tm-user-tools-list">
                        <!-- 用户工具列表 -->
                    </div>
                </div>
            </div>
        `;

        this.renderUserToolsList();
        this.attachEventListeners();
    }

    renderUserToolsList() {
        const listContainer = document.getElementById('tm-user-tools-list');
        const tools = this.manager.listUserTools();

        if (tools.length === 0) {
            listContainer.innerHTML = `
                <div class="tm-empty-state">
                    <p>还没有导入任何工具</p>
                    <p style="font-size: 12px; color: var(--secondary-text);">点击"导入插件"开始</p>
                </div>
            `;
            return;
        }

        const searchQuery = document.getElementById('tm-global-search')?.value.toLowerCase() || '';
        const filtered = tools.filter(tool => {
            if (!searchQuery) return true;
            const searchable = (tool.displayName + ' ' + tool.description + ' ' + tool.name).toLowerCase();
            return searchable.includes(searchQuery);
        });

        if (filtered.length === 0) {
            listContainer.innerHTML = `<p style="color:var(--secondary-text);text-align:center;padding:30px">没有匹配的工具</p>`;
            return;
        }

        listContainer.innerHTML = filtered.map(tool => {
            const isSelected = this.selectedForDelete.has(tool.name);
            const cardClass = this.deleteMode ? 'tm-tool-card tm-tool-card-delete-mode' : 'tm-tool-card tm-tool-card-clickable';
            const selectedClass = isSelected ? 'tm-tool-card-selected' : '';

            return `
        <div class="${cardClass} ${selectedClass}" data-tool-name="${tool.name}" data-clickable="${!this.deleteMode}">
            <div class="tm-tool-info">
                <h4>${tool.displayName}</h4>
                <p>${tool.description}</p>
                <span class="tm-tool-badge">${Object.keys(tool.commands || {}).length || 1} 个命令</span>
            </div>
        </div>
    `;
        }).join('');
    }

    attachEventListeners() {
        // 🔧 修复：移除旧监听器，防止重复绑定
        const oldSearchInput = document.getElementById('tm-global-search');
        if (oldSearchInput) {
            oldSearchInput.replaceWith(oldSearchInput.cloneNode(true)); // 克隆新元素，清除所有旧事件
        }
        
        // 全局搜索
        const searchInput = document.getElementById('tm-global-search');
        if (searchInput) {
            searchInput.addEventListener('input', () => this.renderUserToolsList());
        }

        // 导入按钮
        const importBtn = document.getElementById('tm-import-btn');
        if (importBtn) {
            importBtn.addEventListener('click', () => this.showImportDialog());
        }

        // 删除模式按钮
        const deleteModeBtn = document.getElementById('tm-delete-mode-btn');
        if (deleteModeBtn) {
            deleteModeBtn.addEventListener('click', () => {
                this.deleteMode = !this.deleteMode;
                deleteModeBtn.textContent = this.deleteMode ? '确认删除' : '删除模式';
                deleteModeBtn.className = this.deleteMode ? 'tm-btn tm-btn-primary' : 'tm-btn tm-btn-danger';
                if (this.deleteMode) {
                    this.renderUserToolsList();
                } else {
                    this.confirmBatchDelete();
                }
            });
        }

        // 卡片点击事件（编辑或删除）——必须在listContainer获取之后
        const listContainer = document.getElementById('tm-user-tools-list');
        if (listContainer) {
            listContainer.addEventListener('click', (e) => {
                const card = e.target.closest('.tm-tool-card');
                if (!card) return;

                const toolName = card.dataset.toolName;

                if (this.deleteMode) {
                    // 删除模式：切换选中状态
                    if (this.selectedForDelete.has(toolName)) {
                        this.selectedForDelete.delete(toolName);
                    } else {
                        this.selectedForDelete.add(toolName);
                    }
                    this.renderUserToolsList();
                } else {
                    // 默认编辑模式：直接打开编辑
                    this.showEditDialog(toolName);
                }
            });
        }
    }

    async confirmBatchDelete() {
        if (this.selectedForDelete.size === 0) {
            this.renderUserToolsList();
            return;
        }

        const names = Array.from(this.selectedForDelete);
        if (!confirm(`确定删除 ${names.length} 个工具吗？\n${names.join(', ')}\n\n此操作不可恢复。`)) {
            this.selectedForDelete.clear();
            this.renderUserToolsList();
            return;
        }

        try {
            for (const name of names) {
                this.manager.deleteUserTool(name);
            }
            await this.manager.saveUserTools();
            if (window.refreshToolGrid) await window.refreshToolGrid();
            this.showToast(`已删除 ${names.length} 个工具`);
            this.selectedForDelete.clear();
            this.deleteMode = false; // 删除完成后退出删除模式
            this.render();
        } catch (error) {
            alert(`批量删除失败: ${error.message}`);
        }
    }

    // ========================================
    // 对话框：导入
    // ========================================

    async showImportDialog() {
        if (!this.manager.adminConfig) {
            this.showCredentialDialog();
            return;
        }

        const overlay = this.createOverlay();
        const dialog = document.createElement('div');
        dialog.className = 'tm-dialog tm-dialog-large';
        dialog.innerHTML = `
            <div class="tm-dialog-header">
                <h3>导入插件</h3>
                <button class="tm-dialog-close">&times;</button>
            </div>
            <div class="tm-dialog-body">
                <p style="text-align: center; color: var(--secondary-text);">正在加载插件列表...</p>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const closeBtn = dialog.querySelector('.tm-dialog-close');
        closeBtn.addEventListener('click', () => document.body.removeChild(overlay));

        try {
            const plugins = await this.manager.fetchPlugins();
            const adapted = plugins
                .map(p => ({ raw: p, adapted: this.manager.adaptPlugin(p) }))
                .filter(p => p.adapted !== null);

            if (adapted.length === 0) {
                dialog.querySelector('.tm-dialog-body').innerHTML = `
                    <p style="color: var(--warning-color);">后端没有可用的插件（无invocationCommands）</p>
                `;
                return;
            }

            this.renderImportList(dialog.querySelector('.tm-dialog-body'), adapted);
        } catch (error) {
            dialog.querySelector('.tm-dialog-body').innerHTML = `
                <p style="color: var(--danger-color);">加载失败: ${error.message}</p>
                <button class="tm-btn tm-btn-secondary" id="tm-reconfig-btn">重新配置</button>
            `;
            const reconfigBtn = dialog.querySelector('#tm-reconfig-btn');
            if (reconfigBtn) {
                reconfigBtn.addEventListener('click', () => {
                    document.body.removeChild(overlay);
                    this.showCredentialDialog();
                });
            }
        }
    }
    renderImportList(container, adapted) {
        const selectedTools = new Set();

        container.innerHTML = `
        <div style="margin-bottom: 12px;">
            <input type="text" id="tm-plugin-search" placeholder="🔍 搜索插件..." style="
                width: 100%; padding: 8px 12px; background: var(--input-bg);
                border: 1px solid var(--border-color); border-radius: 6px;
                color: var(--primary-text); font-size: 14px; box-sizing: border-box;">
        </div>
        <div class="tm-import-list" id="tm-plugin-list" style="max-height:50vh;overflow-y:auto;">
            ${adapted.map((p, idx) => {
            const shortDesc = p.adapted.description.slice(0, 120);
            const needsExpand = p.adapted.description.length > 120;
            return `
                    <div class="tm-import-item" data-idx="${idx}" data-search="${(p.adapted.displayName + ' ' + p.adapted.description + ' ' + p.raw.name).toLowerCase()}" style="padding:12px;margin-bottom:8px;border:1px solid var(--border-color);border-radius:6px;background:rgba(255,255,255,0.02);">
                        <label class="tm-import-checkbox" style="display:flex;align-items:start;cursor:pointer;">
                            <input type="checkbox" data-idx="${idx}" style="margin-right:12px;margin-top:4px;">
                            <div style="flex:1;">
                                <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                                    <strong style="font-size:14px;">${p.adapted.displayName}</strong>
                                    <span style="font-size:11px;padding:2px 6px;border-radius:3px;background:${p.raw.isDistributed ? 'rgba(59,130,246,0.2)' : 'rgba(16,185,129,0.2)'};color:${p.raw.isDistributed ? '#60a5fa' : '#34d399'}">${p.raw.isDistributed ? '[分布式]' : '[后端]'}</span>
                                </div>
                                <div style="font-size:12px;color:var(--secondary-text);line-height:1.5;">
                                    <span class="tm-desc-short">${shortDesc}${needsExpand ? '...' : ''}</span>
                                    ${needsExpand ? `<span class="tm-desc-full" style="display:none;">${p.adapted.description}</span>` : ''}
                                    ${needsExpand ? `<button class="tm-btn tm-btn-sm" onclick="this.previousElementSibling.style.display='inline';this.previousElementSibling.previousElementSibling.style.display='none';this.style.display='none'" style="margin-left:6px;font-size:11px;padding:2px 6px">展开</button>` : ''}
                                </div>
                            </div>
                        </label>
                    </div>
                `;
        }).join('')}
        </div>
        <div class="tm-dialog-footer">
            <button class="tm-btn tm-btn-secondary" id="tm-import-cancel">取消</button>
            <button class="tm-btn tm-btn-primary" id="tm-import-confirm" disabled>导入选中(0)</button>
        </div>
    `;

        const searchInput = container.querySelector('#tm-plugin-search');
        const checkboxes = container.querySelectorAll('input[type="checkbox"]');
        const confirmBtn = container.querySelector('#tm-import-confirm');
        const cancelBtn = container.querySelector('#tm-import-cancel');

        // 搜索过滤
        searchInput.addEventListener('input', () => {
            const query = searchInput.value.toLowerCase().trim();
            container.querySelectorAll('.tm-import-item').forEach(item => {
                item.style.display = (!query || item.dataset.search.includes(query)) ? '' : 'none';
            });
        });

        checkboxes.forEach(cb => {
            cb.addEventListener('change', () => {
                const idx = parseInt(cb.dataset.idx, 10);
                cb.checked ? selectedTools.add(idx) : selectedTools.delete(idx);
                confirmBtn.disabled = selectedTools.size === 0;
                confirmBtn.textContent = `导入选中 (${selectedTools.size})`;
            });
        });

        cancelBtn.addEventListener('click', () => {
            const overlay = container.closest('.tm-overlay');
            document.body.removeChild(overlay);
        });

        confirmBtn.addEventListener('click', async () => {
            const toImport = Array.from(selectedTools).map(idx => adapted[idx]);
            await this.importTools(toImport);
            const overlay = container.closest('.tm-overlay');
            document.body.removeChild(overlay);
            this.render();
        });
    }

    async importTools(tools) {
        const distributedCount = tools.filter(t => t.raw.isDistributed).length;

        for (const { raw, adapted } of tools) {
            const toolName = raw.name;
            this.manager.addUserTool(toolName, adapted);
        }
        await this.manager.saveUserTools();

        let message = `成功导入 ${tools.length} 个工具`;
        if (distributedCount > 0) {
            message += `\n\n⚠️ 其中 ${distributedCount} 个为分布式插件，参数已从description自动解析。建议导入后检查参数是否正确。`;
        }

        this.showToast(message);

        // 触发工具网格刷新
        if (window.refreshToolGrid) {
            await window.refreshToolGrid();
        }
    }

    // ========================================
    // 对话框：凭据配置
    // ========================================

    showCredentialDialog() {
        const overlay = this.createOverlay();
        const dialog = document.createElement('div');
        dialog.className = 'tm-dialog';

        const existing = this.manager.adminConfig || {};
        dialog.innerHTML = `
            <div class="tm-dialog-header">
                <h3>配置后端连接</h3>
                <button class="tm-dialog-close">&times;</button>
            </div>
            <div class="tm-dialog-body">
                <div class="tm-form-group">
                    <label>主机地址</label>
                    <input type="text" id="tm-host" value="${existing.host || 'localhost'}" placeholder="localhost">
                </div>
                <div class="tm-form-group">
                    <label>端口</label>
                    <input type="number" id="tm-port" value="${existing.port || '6005'}" placeholder="6005">
                </div>
                <div class="tm-form-group">
                    <label>用户名</label>
                    <input type="text" id="tm-username" value="${existing.username || ''}" placeholder="admin">
                </div>
                <div class="tm-form-group">
                    <label>密码</label>
                    <input type="password" id="tm-password" value="${existing.password || ''}" placeholder="密码">
                </div>
            </div>
            <div class="tm-dialog-footer">
                <button class="tm-btn tm-btn-secondary" id="tm-cred-cancel">取消</button>
                <button class="tm-btn tm-btn-primary" id="tm-cred-save">保存</button>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const closeBtn = dialog.querySelector('.tm-dialog-close');
        const cancelBtn = dialog.querySelector('#tm-cred-cancel');
        const saveBtn = dialog.querySelector('#tm-cred-save');

        const close = () => document.body.removeChild(overlay);

        closeBtn.addEventListener('click', close);
        cancelBtn.addEventListener('click', close);

        saveBtn.addEventListener('click', () => {
            const config = {
                host: document.getElementById('tm-host').value.trim(),
                port: document.getElementById('tm-port').value.trim(),
                username: document.getElementById('tm-username').value.trim(),
                password: document.getElementById('tm-password').value.trim()
            };

            if (!config.host || !config.port || !config.username || !config.password) {
                alert('请填写完整信息');
                return;
            }

            this.manager.saveAdminConfig(config);
            this.showToast('连接配置已保存');
            close();
        });
    }

    // ========================================
    // 对话框：编辑
    // ========================================

    showEditDialog(toolName) {
        const tool = this.manager.getUserTool(toolName);
        if (!tool) return;

        const overlay = this.createOverlay();
        const dialog = document.createElement('div');
        dialog.className = 'tm-dialog tm-dialog-large';
        dialog.innerHTML = `
        <div class="tm-dialog-header">
            <h3>编辑工具: ${tool.displayName}</h3>
            <button class="tm-dialog-close">&times;</button>
        </div>
        <div class="tm-dialog-body">
            <div class="tm-tabs" style="padding: 15px 20px 0; border-bottom: 1px solid var(--border-color);">
                <button class="tm-tab tm-tab-active" data-tab="form">表单编辑</button>
                <button class="tm-tab" data-tab="json">Raw JSON</button>
            </div>
            <div id="tm-tab-form" style="padding: 20px; max-height: 60vh; overflow-y: auto;"></div>
            <div id="tm-tab-json" style="padding: 20px; max-height: 60vh; overflow-y: auto; display: none;">
                <textarea id="tm-json-editor" style="width: 100%; min-height: 400px; font-family: 'Cascadia Code', monospace; font-size: 12px; background: var(--input-bg); color: var(--primary-text); border: 1px solid var(--border-color); border-radius: 4px; padding: 10px; box-sizing: border-box; resize: vertical;">${JSON.stringify(tool, null, 2)}</textarea>
            </div>
        </div>
        <div class="tm-dialog-footer">
            <button class="tm-btn tm-btn-secondary" id="tm-edit-cancel">取消</button>
            <button class="tm-btn tm-btn-primary" id="tm-edit-save">保存</button>
        </div>
    `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // 构建工作副本
        let workingCopy = JSON.parse(JSON.stringify(tool));
        const formTab = dialog.querySelector('#tm-tab-form');
        const jsonEditor = dialog.querySelector('#tm-json-editor');

        // 收集所有现有参数名作为候选
        const allParamNames = new Set();
        const collectNames = (params) => {
            if (Array.isArray(params)) params.forEach(p => allParamNames.add(p.name));
        };
        if (workingCopy.params) collectNames(workingCopy.params);
        if (workingCopy.commands) {
            Object.values(workingCopy.commands).forEach(cmd => collectNames(cmd.params || []));
        }

        // 渲染表单编辑器
        const renderFormEditor = () => {
            formTab.innerHTML = '';

            // 基本信息
            formTab.innerHTML = `
            <div class="tm-form-group">
                <label>显示名称</label>
                <input type="text" id="tm-edit-displayName" value="${workingCopy.displayName || ''}" style="width:100%;padding:8px 12px;background:var(--input-bg);border:1px solid var(--border-color);border-radius:6px;color:var(--primary-text);font-size:14px;box-sizing:border-box;">
            </div>
            <div class="tm-form-group">
                <label>描述</label>
                <input type="text" id="tm-edit-description" value="${workingCopy.description || ''}" style="width:100%;padding:8px 12px;background:var(--input-bg);border:1px solid var(--border-color);border-radius:6px;color:var(--primary-text);font-size:14px;box-sizing:border-box;">
            </div>
        `;

            // 基本信息变动同步
            formTab.querySelector('#tm-edit-displayName').addEventListener('input', e => { workingCopy.displayName = e.target.value; });
            formTab.querySelector('#tm-edit-description').addEventListener('input', e => { workingCopy.description = e.target.value; });

            // 参数编辑器
            const renderParamsEditor = (params, onUpdate) => {
                const wrap = document.createElement('div');
                wrap.className = 'tm-params-editor';

                const header = document.createElement('div');
                header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';
                header.innerHTML = `<span style="font-size:13px;color:var(--secondary-text);">参数列表 (${params.length})</span>`;
                const addBtn = document.createElement('button');
                addBtn.className = 'tm-btn tm-btn-sm tm-btn-secondary';
                addBtn.textContent = '+ 新增参数';
                addBtn.addEventListener('click', () => {
                    params.push({ name: 'new_param', type: 'text', required: false, placeholder: '' });
                    onUpdate(params);
                    refreshTable();
                });
                header.appendChild(addBtn);
                wrap.appendChild(header);

                const table = document.createElement('div');
                table.className = 'tm-params-table';

                const refreshTable = () => {
                    table.innerHTML = `
                    <div style="display:grid;grid-template-columns:1fr 100px 60px 1fr 80px 40px;gap:6px;margin-bottom:6px;padding:0 4px;">
                        <span style="font-size:11px;color:var(--secondary-text);">参数名</span>
                        <span style="font-size:11px;color:var(--secondary-text);">类型</span>
                        <span style="font-size:11px;color:var(--secondary-text);">必填</span>
                        <span style="font-size:11px;color:var(--secondary-text);">占位符/默认值</span>
                        <span style="font-size:11px;color:var(--secondary-text);">选项</span>
                        <span></span>
                    </div>
                `;

                    params.forEach((param, i) => {
                        const row = document.createElement('div');
                        row.style.cssText = 'display:grid;grid-template-columns:1fr 100px 60px 1fr 80px 40px;gap:6px;margin-bottom:6px;align-items:center;';

                        const inputStyle = 'width:100%;padding:6px 8px;background:var(--input-bg);border:1px solid var(--border-color);border-radius:4px;color:var(--primary-text);font-size:12px;box-sizing:border-box;';

                        // datalist for param names
                        const datalistId = `tm-param-names-${i}`;
                        const optionsHtml = [...allParamNames].map(n => `<option value="${n}">`).join('');

                        row.innerHTML = `
                            <div style="position:relative;min-width:0;">
                                <input type="text" value="${param.name || ''}" placeholder="参数名" list="${datalistId}" style="${inputStyle}">
                            </div>
                            <select style="${inputStyle}">
                                ${['text', 'textarea', 'number', 'select', 'checkbox', 'radio', 'dragdrop_image'].map(t =>
                            `<option value="${t}" ${param.type === t ? 'selected' : ''}>${t}</option>`
                        ).join('')}
                            </select>
                            <div style="text-align:center;"><input type="checkbox" ${param.required ? 'checked' : ''}></div>
                            <input type="text" value="${param.placeholder || param.default || ''}" placeholder="占位符/默认值" style="${inputStyle}">
                            ${(param.type === 'select' || param.type === 'radio') ? `<button style="background:rgba(59,130,246,0.2);color:#93c5fd;border:none;border-radius:4px;cursor:pointer;padding:4px 6px;font-size:11px;">编辑</button>` : '<div></div>'}
                            <button style="background:var(--danger-color);color:white;border:none;border-radius:4px;cursor:pointer;padding:4px 8px;font-size:12px;">✕</button>
                            <datalist id="${datalistId}">${optionsHtml}</datalist>
                        `;

                        const nameInput = row.children[0].querySelector('input'); // 从wrapper取input
                        const [, typeSelect, , placeholderInput, optionsBtn, deleteBtn] = row.children;
                        const reqCb = row.querySelector('input[type="checkbox"]');

                        nameInput.addEventListener('input', e => { params[i].name = e.target.value; onUpdate(params); });
                        typeSelect.addEventListener('change', e => {
                            params[i].type = e.target.value;
                            onUpdate(params);
                            refreshTable();
                        });
                        reqCb.addEventListener('change', e => { params[i].required = e.target.checked; onUpdate(params); });
                        placeholderInput.addEventListener('input', e => { params[i].placeholder = e.target.value; params[i].default = e.target.value; onUpdate(params); });
                        if (param.type === 'select' || param.type === 'radio') {
                            optionsBtn.addEventListener('click', () => {
                                const current = param.options ? param.options.join(', ') : '';
                                const input = prompt('编辑选项（逗号分隔）:', current);
                                if (input !== null) {
                                    params[i].options = input.split(',').map(s => s.trim()).filter(Boolean);
                                    onUpdate(params);
                                }
                            });
                        }
                        deleteBtn.addEventListener('click', () => {
                            params.splice(i, 1);
                            onUpdate(params);
                            refreshTable();
                        });

                        table.appendChild(row);
                    });
                };

                refreshTable();
                wrap.appendChild(table);
                return wrap;
            };

            // 单命令工具（有params）
            if (workingCopy.params) {
                const section = document.createElement('div');
                section.style.marginTop = '15px';
                const label = document.createElement('div');
                label.style.cssText = 'font-size:13px;font-weight:600;color:var(--primary-text);margin-bottom:8px;';
                label.textContent = '参数编辑';
                section.appendChild(label);
                section.appendChild(renderParamsEditor(workingCopy.params, params => { workingCopy.params = params; }));
                formTab.appendChild(section);
            }

            // 多命令工具（有commands）
            if (workingCopy.commands) {
                const section = document.createElement('div');
                section.style.marginTop = '15px';

                const cmdNames = Object.keys(workingCopy.commands);
                if (cmdNames.length > 1) {
                    // 多命令：用accordion
                    cmdNames.forEach(cmdName => {
                        const cmdBlock = document.createElement('details');
                        cmdBlock.style.cssText = 'border:1px solid var(--border-color);border-radius:6px;margin-bottom:8px;overflow:hidden;';
                        const summary = document.createElement('summary');
                        summary.style.cssText = 'padding:10px 14px;cursor:pointer;background:rgba(255,255,255,0.03);font-weight:500;';
                        summary.textContent = `${cmdName} — ${workingCopy.commands[cmdName].description || ''}`;
                        cmdBlock.appendChild(summary);
                        const inner = document.createElement('div');
                        inner.style.padding = '12px';
                        inner.appendChild(renderParamsEditor(workingCopy.commands[cmdName].params || [], params => { workingCopy.commands[cmdName].params = params; }));
                        cmdBlock.appendChild(inner);
                        section.appendChild(cmdBlock);
                    });
                } else {
                    // 单命令的commands格式
                    const [cmdName] = cmdNames;
                    const label = document.createElement('div');
                    label.style.cssText = 'font-size:13px;font-weight:600;color:var(--primary-text);margin-bottom:8px;';
                    label.textContent = `参数编辑 (${cmdName})`;
                    section.appendChild(label);
                    section.appendChild(renderParamsEditor(workingCopy.commands[cmdName].params || [], params => { workingCopy.commands[cmdName].params = params; }));
                }

                formTab.appendChild(section);
            }
        };

        renderFormEditor();

        // Tab切换（表单 ↔ JSON双向同步）
        const tabs = dialog.querySelectorAll('.tm-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('tm-tab-active'));
                tab.classList.add('tm-tab-active');

                if (tab.dataset.tab === 'form') {
                    dialog.querySelector('#tm-tab-json').style.display = 'none';
                    dialog.querySelector('#tm-tab-form').style.display = 'block';
                    // 从JSON同步回来
                    try {
                        workingCopy = JSON.parse(jsonEditor.value);
                        renderFormEditor();
                    } catch (e) { /* JSON有误时不同步 */ }
                } else {
                    dialog.querySelector('#tm-tab-form').style.display = 'none';
                    dialog.querySelector('#tm-tab-json').style.display = 'block';
                    jsonEditor.value = JSON.stringify(workingCopy, null, 2);
                }
            });
        });

        const closeBtn = dialog.querySelector('.tm-dialog-close');
        const cancelBtn = dialog.querySelector('#tm-edit-cancel');
        const saveBtn = dialog.querySelector('#tm-edit-save');

        const close = () => document.body.removeChild(overlay);
        closeBtn.addEventListener('click', close);
        cancelBtn.addEventListener('click', close);

        saveBtn.addEventListener('click', async () => {
            // 如果当前在JSON tab，从JSON读取
            if (dialog.querySelector('#tm-tab-json').style.display !== 'none') {
                try {
                    workingCopy = JSON.parse(jsonEditor.value);
                } catch (error) {
                    alert(`JSON格式错误: ${error.message}`);
                    return;
                }
            }
            try {
                this.manager.updateUserTool(toolName, workingCopy);
                await this.manager.saveUserTools();
                if (window.refreshToolGrid) await window.refreshToolGrid();
                this.showToast('保存成功');
                close();
                this.render();
            } catch (error) {
                alert(`保存失败: ${error.message}`);
            }
        });
    }

    // ========================================
    // 工具函数
    // ========================================

    createOverlay() {
        const overlay = document.createElement('div');
        overlay.className = 'tm-overlay';
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        });
        return overlay;
    }

    showToast(message) {
        const toast = document.createElement('div');
        toast.className = 'tm-toast';
        toast.style.cssText = `
            position: fixed; top: 20px; right: 20px;
            background: var(--success-color); color: white;
            padding: 12px 20px; border-radius: 6px;
            z-index: 10001; font-size: 14px; font-weight: 500;
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
            max-width: 400px; white-space: pre-wrap;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 4000);
    }
}