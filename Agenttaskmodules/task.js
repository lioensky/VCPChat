// Agenttaskmodules/task.js

const api = window.utilityAPI || window.electronAPI;

// ========== Global State ==========
let apiAuthHeader = null;
let serverBaseUrl = '';
let agentsList = []; // Local agents list for avatars
let avatarCache = {};
let avatarPendingCache = new Map();

// API Data Caches
let currentAAConfig = null;
let currentFAConfig = null;
let currentStatus = null; // Store full status object
let currentDelegations = { active: [], recent: [] };
let delegationPollingTimer = null;
let currentViewingDelegationId = null;

const AA_DEFAULT_CONFIG = {
    maxHistoryRounds: 7,
    contextTtlHours: 24,
    delegationMaxRounds: 15,
    delegationTimeout: 300000,
    delegationSystemPrompt: '',
    delegationHeartbeatPrompt: '',
    globalSystemPrompt: '',
    agents: []
};

const AA_GLOBAL_FIELD_DEFS = [
    { key: 'maxHistoryRounds', label: '历史保留轮数', type: 'number', description: '每个 Agent 的持久会话历史保留轮数；当前插件按 轮数 × 20 条消息作为上限。' },
    { key: 'contextTtlHours', label: '上下文存活时间（小时）', type: 'number', description: '超过该时间没有更新的 Agent 会话上下文会被清理。' },
    { key: 'delegationMaxRounds', label: '异步委托最大轮数', type: 'number', description: '目标 Agent 未输出 [[TaskComplete]] 或 [[TaskFailed]] 时，最多继续唤醒的轮数。' },
    { key: 'delegationTimeout', label: '异步委托超时（分钟）', type: 'number', unit: 'minutes', storageType: 'milliseconds', step: '0.1', description: '界面按分钟填写，保存到配置时会自动转换为毫秒；默认 5 分钟，即 300000 毫秒。' },
    { key: 'delegationSystemPrompt', label: '委托系统提示词', type: 'textarea', description: '异步委托启动时追加到目标 Agent 系统提示词后；留空使用插件内置默认值。建议保留 {{SenderName}} 与 {{TaskPrompt}}。' },
    { key: 'delegationHeartbeatPrompt', label: '委托心跳提示词', type: 'textarea', description: '异步委托每轮未完成时追加给 Agent 的 user 提示词；留空使用插件内置默认值。' },
    { key: 'globalSystemPrompt', label: '全局系统提示词', type: 'textarea', description: '追加到每个 Agent 专属 systemPrompt 后的共享补充提示词。' }
];

const AGENT_FIELD_DEFS = [
    { key: 'chineseName', label: '显示名称', type: 'text', placeholder: '例如：诺娃' },
    { key: 'baseName', label: '基础标识', type: 'text', placeholder: '例如：nova' },
    { key: 'modelId', label: '模型 ID', type: 'text', placeholder: 'default / gpt-4o / claude-3' },
    { key: 'maxOutputTokens', label: '最大输出 Token', type: 'number', placeholder: '40000' },
    { key: 'temperature', label: '温度', type: 'number', placeholder: '0.7', step: '0.1' },
    { key: 'description', label: '角色描述', type: 'textarea', placeholder: '描述该 Agent 的角色和能力...' },
    { key: 'systemPrompt', label: '系统提示词', type: 'textarea', placeholder: '支持 {{MaidName}} 替换为显示名称' }
];

function ensureAAConfigShape(config = {}) {
    const normalized = { ...AA_DEFAULT_CONFIG, ...config };
    normalized.agents = Array.isArray(config.agents) ? config.agents : [];
    return normalized;
}

function getValueType(value, fallbackType = 'text') {
    if (fallbackType === 'number') return 'number';
    return typeof value;
}

function getGlobalFieldDisplayValue(field, value) {
    if (field.storageType === 'milliseconds' && field.unit === 'minutes') {
        const numericValue = Number(value || 0);
        return Number.isFinite(numericValue) ? numericValue / 60000 : '';
    }
    return value;
}

// ========== DOM Elements ==========
const connectionStatus = document.getElementById('connection-status');
const tabBtns = document.querySelectorAll('.tab-btn');
const views = document.querySelectorAll('.view-container');

// AA UI Elements
const aaGlobalSettings = document.getElementById('aa-global-settings');
const agentListContainer = document.getElementById('agent-list-container');
const refreshAgentsBtn = document.getElementById('refresh-agents-btn');
const saveAgentsBtn = document.getElementById('save-agents-btn');

// FA UI Elements
const taskListContainer = document.getElementById('task-list-container');
const faStatusDashboard = document.getElementById('fa-status-dashboard');
const refreshTasksBtn = document.getElementById('refresh-tasks-btn');

const activeDelegationsContainer = document.getElementById('active-delegations-container');
const recentDelegationsContainer = document.getElementById('recent-delegations-container');
const delegationSummary = document.getElementById('delegation-summary');
const delegationStatusMessage = document.getElementById('delegation-status-message');
const refreshDelegationsBtn = document.getElementById('refresh-delegations-btn');
const delegationModal = document.getElementById('delegation-modal');
const delegationModalTitle = document.getElementById('delegation-modal-title');
const delegationModalSubtitle = document.getElementById('delegation-modal-subtitle');
const delegationModalBody = document.getElementById('delegation-modal-body');
const delegationModalCancelBtn = document.getElementById('delegation-modal-cancel');
const delegationModalCloseBtn = document.getElementById('delegation-modal-close');

// Models
const agentModal = document.getElementById('agent-modal');
const taskModal = document.getElementById('task-modal');
let currentEditingAgentIndex = -1;
let currentEditingTask = null;

// ========== Window Controls ==========
document.getElementById('minimize-btn')?.addEventListener('click', () => api?.minimizeWindow());
document.getElementById('maximize-btn')?.addEventListener('click', () => api?.maximizeWindow());
document.getElementById('close-btn')?.addEventListener('click', () => {
    if (api?.closeWindow) {
        api.closeWindow();
    } else {
        window.close();
    }
});

// ========== Theme Management ==========
function applyTheme(theme) {
    document.body.classList.toggle('light-theme', theme === 'light');
}

// ========== Initialization ==========
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const settings = await api?.loadSettings();
        if (settings?.currentThemeMode) applyTheme(settings.currentThemeMode);
        api?.onThemeUpdated(applyTheme);

        setupTabs();
        setupModals();
        
        await loadLocalAgentsList();
        await initializeApi();

        if (apiAuthHeader) {
            refreshAllData();
            // Start auto-refresh for status
            setInterval(fetchFAStatus, 15000);
            startDelegationPolling();
        }

    } catch (e) {
        console.error('[Task UI] Initialization error:', e);
        connectionStatus.textContent = '初始化异常';
        connectionStatus.className = 'status-indicator error';
    }
});

// ========== Tab Logic ==========
function setupTabs() {
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            views.forEach(v => v.classList.remove('active'));
            
            btn.classList.add('active');
            const target = btn.dataset.target;
            document.getElementById(target).classList.add('active');
        });
    });
}

// ========== Modal Logic ==========
function setupModals() {
    document.querySelectorAll('.modal-close-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            agentModal.classList.remove('active');
            taskModal.classList.remove('active');
            delegationModal?.classList.remove('active');
        });
    });

    delegationModalCloseBtn?.addEventListener('click', () => {
        delegationModal?.classList.remove('active');
    });

    delegationModalCancelBtn?.addEventListener('click', () => {
        if (currentViewingDelegationId) {
            cancelDelegation(currentViewingDelegationId);
        }
    });
    
    // Save Editing Agent (supports both edit and create)
    document.getElementById('agent-modal-confirm').addEventListener('click', () => {
        if (!currentAAConfig) return;
        if (!currentAAConfig.agents) currentAAConfig.agents = [];

        const body = document.getElementById('agent-modal-body');
        const inputs = body.querySelectorAll('input, textarea');

        if (currentEditingAgentIndex === -1) {
            // Creating new agent
            const newAgent = {};
            inputs.forEach(input => {
                const key = input.dataset.key;
                if (!key) return;
                let val = input.value;
                if (input.type === 'number') val = Number(val);
                newAgent[key] = val;
            });

            // Validate required fields
            if (!newAgent.chineseName && !newAgent.baseName) {
                alert('请至少填写"显示名称"或"基础标识"。');
                return;
            }

            currentAAConfig.agents.push(newAgent);
            agentModal.classList.remove('active');
            renderAAConfig();
        } else if (currentEditingAgentIndex >= 0) {
            // Editing existing agent
            inputs.forEach(input => {
                const key = input.dataset.key;
                if (!key) return;
                let val = input.value;
                if (input.type === 'number') val = Number(val);
                currentAAConfig.agents[currentEditingAgentIndex][key] = val;
            });
            agentModal.classList.remove('active');
            renderAAConfig();
        }
    });
}

// ========== Networking Setup ==========
async function initializeApi() {
    try {
        const settings = await api.loadSettings();
        if (!settings?.vcpServerUrl) {
            connectionStatus.textContent = '❌ 未配置 URL';
            connectionStatus.className = 'status-indicator error';
            return;
        }

        serverBaseUrl = settings.vcpServerUrl.replace(/\/v1\/chat\/completions\/?$/, '');
        if (!serverBaseUrl.endsWith('/')) serverBaseUrl += '/';
        
        // Use the same Basic Auth as the forum module since they all share /admin_api
        const forumConfig = await api?.loadForumConfig();
        if (forumConfig && forumConfig.username && forumConfig.password) {
            apiAuthHeader = `Basic ${btoa(`${forumConfig.username}:${forumConfig.password}`)}`;
            connectionStatus.textContent = '● 已连接 (Admin)';
            connectionStatus.className = 'status-indicator connected';
        } else {
            connectionStatus.textContent = '⚠️ 凭证缺失 (需在Forum页登录)';
            connectionStatus.className = 'status-indicator warning';
        }
    } catch (error) {
        connectionStatus.textContent = '❌ 初始化失败';
        connectionStatus.className = 'status-indicator error';
    }
}

async function apiFetch(endpoint, options = {}) {
    if (!apiAuthHeader) throw new Error('Auth Missing: 请前往内网论坛页面完成管理员登录以继承凭证');
    
    const response = await fetch(`${serverBaseUrl}admin_api${endpoint}`, {
        ...options,
        headers: {
            'Authorization': apiAuthHeader,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || `API Error: ${response.status}`);
    }
    return response.json();
}

function refreshAllData() {
    fetchAAConfig();
    fetchFAConfig();
    fetchFAStatus();
    fetchDelegations();
}

// ========== Avatar Logic (Ported from Forum) ==========
async function loadLocalAgentsList() {
    try {
        const data = await api?.loadAgentsList();
        if (data && Array.isArray(data)) {
            agentsList = data;
        }
    } catch (e) {
        console.error('Local agents list err', e);
    }
}

async function getAvatarForUser(username) {
    if (!username) return null;
    if (avatarCache.hasOwnProperty(username)) return avatarCache[username];
    if (avatarPendingCache.has(username)) return avatarPendingCache.get(username);

    const avatarPromise = (async () => {
        try {
            for (const agent of agentsList) {
                const agentNameLower = agent.name.toLowerCase();
                const usernameLower = username.toLowerCase();
                
                if (agentNameLower.includes(usernameLower) || usernameLower.includes(agentNameLower)) {
                    const agentAvatar = await api?.loadAgentAvatar(agent.folder);
                    if (agentAvatar) {
                        avatarCache[username] = agentAvatar;
                        return agentAvatar;
                    }
                }
            }
            avatarCache[username] = null;
            return null;
        } catch (error) {
            avatarCache[username] = null;
            return null;
        } finally {
            avatarPendingCache.delete(username);
        }
    })();

    avatarPendingCache.set(username, avatarPromise);
    return avatarPromise;
}

// ========== AgentAssistant (AA) Logic ==========
refreshAgentsBtn.addEventListener('click', fetchAAConfig);
saveAgentsBtn.addEventListener('click', saveAAConfig);

// Create New Agent Button
document.getElementById('create-agent-btn')?.addEventListener('click', () => {
    currentAAConfig = ensureAAConfigShape(currentAAConfig || {});
    openAgentModal(-1); // -1 means new agent
});

async function fetchAAConfig() {
    try {
        refreshAgentsBtn.classList.add('spinning'); // Assume a spinner CSS is added or opacity drops
        const data = await apiFetch('/agent-assistant/config');
        currentAAConfig = ensureAAConfigShape(data);
        renderAAConfig();
    } catch (e) {
        console.error('Fetch AA config err:', e);
        aaGlobalSettings.innerHTML = `<div style="color:var(--danger-color)">加载 Agent 配置失败: ${e.message}</div>`;
    } finally {
        refreshAgentsBtn.classList.remove('spinning');
    }
}

async function saveAAConfig() {
    if (!currentAAConfig) return;
    try {
        saveAgentsBtn.textContent = '保存中...';
        await apiFetch('/agent-assistant/config', {
            method: 'POST',
            body: JSON.stringify(currentAAConfig)
        });
        saveAgentsBtn.textContent = '✅ 保存成功';
        setTimeout(() => saveAgentsBtn.textContent = '保存所有更改', 2000);
    } catch (e) {
        saveAgentsBtn.textContent = '❌ 保存失败';
        console.error(e);
        setTimeout(() => saveAgentsBtn.textContent = '保存所有更改', 3000);
    }
}

function renderAAConfig() {
    if (!currentAAConfig) return;
    currentAAConfig = ensureAAConfigShape(currentAAConfig);
    
    // Render Globals
    const knownGlobalKeys = new Set([...AA_GLOBAL_FIELD_DEFS.map(f => f.key), 'agents']);
    const extraGlobalFields = Object.keys(currentAAConfig)
        .filter(key => !knownGlobalKeys.has(key))
        .map(key => ({
            key,
            label: key,
            type: typeof currentAAConfig[key] === 'number' ? 'number' : (key.toLowerCase().includes('prompt') ? 'textarea' : 'text'),
            description: '未识别的扩展配置字段，将按原样保存。'
        }));

    aaGlobalSettings.innerHTML = `
        <div class="settings-section-title">
            <div>
                <h3>全局运行参数</h3>
                <p>这些字段会直接写入 AgentAssistant 配置 JSON，留空的委托提示词将沿用插件内置默认值。</p>
            </div>
        </div>
        <div class="settings-grid">
            ${[...AA_GLOBAL_FIELD_DEFS, ...extraGlobalFields].map(field => {
                const val = currentAAConfig[field.key] ?? '';
                const displayVal = getGlobalFieldDisplayValue(field, val);
                const isTextarea = field.type === 'textarea';
                const valueType = field.storageType === 'milliseconds' ? field.storageType : getValueType(val, field.type);
                return `
                    <label class="setting-row ${isTextarea ? 'setting-row-wide' : ''}">
                        <span class="setting-copy">
                            <span class="setting-label">${escapeHtml(field.label)}</span>
                            <span class="setting-key">${escapeHtml(field.key)}</span>
                            <span class="setting-desc">${escapeHtml(field.description || '')}</span>
                        </span>
                        ${isTextarea
                            ? `<textarea class="setting-input" data-key="${field.key}" placeholder="留空则使用默认行为" onchange="updateAAGlobal('${field.key}', this.value, '${valueType}')">${escapeHtml(String(displayVal))}</textarea>`
                            : `<input class="setting-input" type="${field.type === 'number' ? 'number' : 'text'}" value="${escapeHtml(String(displayVal))}" data-key="${field.key}" ${field.step ? `step="${field.step}"` : ''} onchange="updateAAGlobal('${field.key}', this.value, '${valueType}')">`
                        }
                    </label>
                `;
            }).join('')}
        </div>
    `;

    // Render Agents Grid
    agentListContainer.innerHTML = '';
    const agents = currentAAConfig.agents || [];
    
    agents.forEach((agent, index) => {
        const card = document.createElement('div');
        card.className = 'card-item glass-hover';
        
        card.innerHTML = `
            <div class="agent-card-header">
                <div class="agent-avatar" data-name="${escapeHtml(agent.chineseName || agent.baseName)}">
                    ${(agent.chineseName || agent.baseName || '?').slice(0,1)}
                </div>
                <div class="agent-info">
                    <h3>${escapeHtml(agent.chineseName || agent.baseName || '未命名')}</h3>
                    <div class="model-id">${escapeHtml(agent.modelId || 'default')}</div>
                </div>
                <div class="agent-card-actions" style="margin-left:auto; display:flex; gap:6px;">
                    <button class="action-btn" title="编辑" onclick="event.stopPropagation(); openAgentModalByIndex(${index})">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                    <button class="action-btn delete-btn" title="删除" onclick="event.stopPropagation(); deleteAgentByIndex(${index})">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                </div>
            </div>
            <div class="agent-description">${escapeHtml(agent.description || '无介绍...')}</div>
            <div class="agent-inline-fields" onclick="event.stopPropagation()">
                <div class="agent-field-row two-col">
                    <label class="quick-edit-field">
                        <span>模型 ID</span>
                        <input
                            type="text"
                            value="${escapeHtml(agent.modelId || '')}"
                            placeholder="default / gpt-4o / claude-3"
                            oninput="updateAgentQuickField(${index}, 'modelId', this.value)"
                            onchange="syncAgentQuickSummary(${index}, this.value)"
                        >
                    </label>
                    <label class="quick-edit-field">
                        <span>基础标识</span>
                        <input
                            type="text"
                            value="${escapeHtml(agent.baseName || '')}"
                            placeholder="baseName"
                            oninput="updateAgentQuickField(${index}, 'baseName', this.value)"
                        >
                    </label>
                </div>
                <div class="agent-field-row two-col">
                    <label class="quick-edit-field">
                        <span>最大输出 Token</span>
                        <input
                            type="number"
                            value="${escapeHtml(String(agent.maxOutputTokens ?? 40000))}"
                            placeholder="40000"
                            oninput="updateAgentQuickField(${index}, 'maxOutputTokens', Number(this.value))"
                        >
                    </label>
                    <label class="quick-edit-field">
                        <span>温度</span>
                        <input
                            type="number"
                            step="0.1"
                            value="${escapeHtml(String(agent.temperature ?? 0.7))}"
                            placeholder="0.7"
                            oninput="updateAgentQuickField(${index}, 'temperature', Number(this.value))"
                        >
                    </label>
                </div>
                <label class="quick-edit-field">
                    <span>系统提示词</span>
                    <textarea
                        placeholder="支持 {{MaidName}} 替换为显示名称"
                        oninput="updateAgentQuickField(${index}, 'systemPrompt', this.value)"
                    >${escapeHtml(agent.systemPrompt || '')}</textarea>
                </label>
            </div>
        `;

        card.addEventListener('click', () => openAgentModal(index));
        agentListContainer.appendChild(card);

        // Async render avatar
        const avatarEl = card.querySelector('.agent-avatar');
        getAvatarForUser(agent.chineseName || agent.baseName).then(src => {
            if (src) {
                avatarEl.style.backgroundImage = `url("${src}")`;
                avatarEl.textContent = '';
            }
        });
    });
}

// ========== Agent Add/Delete Helpers ==========
window.openAgentModalByIndex = (index) => {
    openAgentModal(index);
};

window.deleteAgentByIndex = (index) => {
    if (!currentAAConfig || !currentAAConfig.agents) return;
    const agent = currentAAConfig.agents[index];
    const agentName = agent?.chineseName || agent?.baseName || '未命名';
    if (confirm(`确定要删除 Agent "${agentName}" 吗？`)) {
        currentAAConfig.agents.splice(index, 1);
        renderAAConfig();
    }
};

window.updateAAGlobal = (key, val, type) => {
    if (currentAAConfig) {
        if (type === 'milliseconds') {
            currentAAConfig[key] = Math.round(Number(val) * 60000);
            return;
        }
        currentAAConfig[key] = type === 'number' ? Number(val) : val;
    }
};

window.updateAgentQuickField = (index, key, val) => {
    if (!currentAAConfig?.agents?.[index]) return;
    currentAAConfig.agents[index][key] = val;
};

window.syncAgentQuickSummary = (index, val) => {
    const card = agentListContainer.children[index];
    const modelIdEl = card?.querySelector('.agent-info .model-id');
    if (modelIdEl) {
        modelIdEl.textContent = val || 'default';
    }
};

function openAgentModal(index) {
    const isNew = index === -1;
    const agent = isNew
        ? { chineseName: '', baseName: '', modelId: '', description: '', systemPrompt: '', maxOutputTokens: 40000, temperature: 0.7 }
        : currentAAConfig.agents[index];

    currentEditingAgentIndex = index;
    
    const agentName = agent.chineseName || agent.baseName || '新 Agent';
    document.getElementById('agent-modal-title').textContent = isNew ? '新建 Agent' : `编辑 ${agentName}`;

    // Show/hide the modal delete button
    const deleteBtn = document.getElementById('agent-modal-delete');
    if (deleteBtn) {
        deleteBtn.style.display = isNew ? 'none' : 'inline-flex';
        deleteBtn.onclick = () => {
            if (confirm(`确定要删除 Agent "${agentName}" 吗？`)) {
                currentAAConfig.agents.splice(index, 1);
                agentModal.classList.remove('active');
                renderAAConfig();
            }
        };
    }

    // Define the fields we want to display with friendly labels
    const fieldDefs = AGENT_FIELD_DEFS;

    const body = document.getElementById('agent-modal-body');
    
    // Build fields from definition, also include any extra unknown keys from the agent
    const knownKeys = new Set(fieldDefs.map(f => f.key));
    const extraKeys = Object.keys(agent).filter(k => !knownKeys.has(k));

    let fieldsHtml = fieldDefs.map(fd => {
        const val = agent[fd.key] ?? '';
        if (fd.type === 'textarea') {
            return `
                <div class="form-group">
                    <label>${fd.label}</label>
                    <textarea data-key="${fd.key}" placeholder="${fd.placeholder || ''}">${escapeHtml(String(val))}</textarea>
                </div>
            `;
        } else {
            return `
                <div class="form-group">
                    <label>${fd.label}</label>
                    <input type="${fd.type}" data-key="${fd.key}" value="${escapeHtml(String(val))}" placeholder="${fd.placeholder || ''}" ${fd.type === 'number' ? `step="${fd.step || 'any'}"` : ''}>
                </div>
            `;
        }
    }).join('');

    // Render any extra/unknown fields from the agent object
    fieldsHtml += extraKeys.map(key => {
        const val = agent[key];
        const isLongText = typeof val === 'string' && val.length > 50;
        if (isLongText) {
            return `
                <div class="form-group">
                    <label>${key}</label>
                    <textarea data-key="${key}">${escapeHtml(String(val))}</textarea>
                </div>
            `;
        } else {
            return `
                <div class="form-group">
                    <label>${key}</label>
                    <input type="${typeof val === 'number' ? 'number' : 'text'}" data-key="${key}" value="${escapeHtml(String(val))}">
                </div>
            `;
        }
    }).join('');

    body.innerHTML = fieldsHtml;
    agentModal.classList.add('active');
}

// ========== TaskAssistant (FA) Logic ==========
refreshTasksBtn.addEventListener('click', () => { fetchFAConfig(); fetchFAStatus(); fetchDelegations(); });
refreshDelegationsBtn?.addEventListener('click', () => fetchDelegations());

async function fetchFAConfig() {
    try {
        const data = await apiFetch('/task-assistant/config');
        // The backend returns { config: { tasks: [...] }, availableTaskTypes: [...] }
        currentFAConfig = data.config?.tasks || data.tasks || [];
        renderFAConfig();
    } catch (e) {
        taskListContainer.innerHTML = `<div style="color:var(--danger-color)">加载 Task 配置失败</div>`;
    }
}

async function fetchFAStatus() {
    try {
        const status = await apiFetch('/task-assistant/status');
        currentStatus = status;
        renderFAStatus(status);
        // Also re-render task config to update "last run" indicators if visible
        if (currentFAConfig) renderFAConfig(); 
    } catch (e) {
        faStatusDashboard.innerHTML = `读取失败...`;
    }
}

async function fetchDelegations() {
    if (!activeDelegationsContainer || !recentDelegationsContainer) return;
    try {
        refreshDelegationsBtn?.classList.add('spinning');
        setDelegationStatus('读取中...', 'loading');
        const result = await apiFetch('/agent-assistant/delegations');
        currentDelegations = {
            active: Array.isArray(result?.data?.active) ? result.data.active : [],
            recent: Array.isArray(result?.data?.recent) ? result.data.recent : []
        };
        renderDelegations();
        setDelegationStatus(`已更新 ${new Date().toLocaleTimeString()}`, 'ok');
    } catch (e) {
        console.error('Fetch delegations err:', e);
        setDelegationStatus(`读取失败: ${e.message}`, 'error');
        activeDelegationsContainer.innerHTML = `<div class="empty-state error">读取异步委托失败：${escapeHtml(e.message)}</div>`;
    } finally {
        refreshDelegationsBtn?.classList.remove('spinning');
    }
}

function startDelegationPolling() {
    if (delegationPollingTimer) clearInterval(delegationPollingTimer);
    delegationPollingTimer = setInterval(fetchDelegations, 5000);
}

function setDelegationStatus(message, type = 'ok') {
    if (!delegationStatusMessage) return;
    delegationStatusMessage.textContent = message;
    delegationStatusMessage.className = `delegation-status-message ${type}`;
}

function renderDelegations() {
    const active = currentDelegations.active || [];
    const recent = currentDelegations.recent || [];

    if (delegationSummary) {
        delegationSummary.innerHTML = `
            <div class="delegation-summary-item">
                <span class="stat-value">${active.length}</span>
                <span class="stat-label">运行中</span>
            </div>
            <div class="delegation-summary-item">
                <span class="stat-value">${recent.length}</span>
                <span class="stat-label">最近记录</span>
            </div>
            <div class="delegation-summary-item">
                <span class="stat-value">${active.filter(task => task.cancelRequested).length}</span>
                <span class="stat-label">取消中</span>
            </div>
        `;
    }

    activeDelegationsContainer.innerHTML = active.length
        ? active.map(task => renderDelegationCard(task, true)).join('')
        : '<div class="empty-state">暂无运行中的异步委托。</div>';

    recentDelegationsContainer.innerHTML = recent.length
        ? recent.map(task => renderDelegationCard(task, false)).join('')
        : '<div class="empty-state">暂无最近委托记录。</div>';
}

function renderDelegationCard(task, isActive) {
    const status = task.status || 'unknown';
    const statusLabel = getDelegationStatusLabel(status);
    const canCancel = isActive && !task.cancelRequested && !['completed', 'failed', 'cancelled'].includes(status);
    const agentName = task.agentName || task.agentBaseName || 'Unknown Agent';
    const elapsed = formatDuration(task.elapsedMs);
    const updatedAt = task.updatedAt ? new Date(task.updatedAt).toLocaleTimeString() : 'N/A';
    const roundText = `${Number(task.currentRound || 0)} / ${Number(task.maxRounds || 0) || '-'}`;
    const archiveHtml = task.archivePath
        ? `<div class="delegation-archive" title="${escapeHtml(task.archivePath)}">归档：${escapeHtml(task.archivePath)}</div>`
        : '';

    return `
        <article class="delegation-card status-${escapeHtml(status)}" onclick="openDelegationModal('${escapeHtml(task.id || '')}')">
            <div class="delegation-card-head">
                <div>
                    <h4>${escapeHtml(agentName)}</h4>
                    <div class="delegation-id" title="${escapeHtml(task.id || '')}">${escapeHtml(task.id || '无 ID')}</div>
                </div>
                <span class="delegation-badge status-${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
            </div>
            <div class="delegation-meta-grid">
                <div><span>轮数</span><strong>${escapeHtml(roundText)}</strong></div>
                <div><span>耗时</span><strong>${escapeHtml(elapsed)}</strong></div>
                <div><span>更新</span><strong>${escapeHtml(updatedAt)}</strong></div>
                <div><span>取消</span><strong>${task.cancelRequested ? '已请求' : '否'}</strong></div>
            </div>
            <div class="delegation-preview">
                <label>初始任务</label>
                <p>${escapeHtml(task.taskPromptPreview || '无预览')}</p>
            </div>
            <div class="delegation-preview">
                <label>最近回复</label>
                <p>${escapeHtml(task.lastResponsePreview || '尚无回复')}</p>
            </div>
            ${task.finalReportPreview ? `
                <div class="delegation-preview final">
                    <label>最终报告</label>
                    <p>${escapeHtml(task.finalReportPreview)}</p>
                </div>
            ` : ''}
            ${archiveHtml}
            ${canCancel ? `
                <button class="glass-btn warning block delegation-cancel-btn" onclick="event.stopPropagation(); cancelDelegation('${escapeHtml(task.id)}')">
                    请求取消任务
                </button>
            ` : ''}
        </article>
    `;
}

function findDelegationById(delegationId) {
    return [...(currentDelegations.active || []), ...(currentDelegations.recent || [])]
        .find(task => task.id === delegationId);
}

window.openDelegationModal = async (delegationId) => {
    if (!delegationId || !delegationModal || !delegationModalBody) return;

    currentViewingDelegationId = delegationId;
    const cachedTask = findDelegationById(delegationId);

    if (cachedTask) {
        renderDelegationModal(cachedTask);
    } else {
        delegationModalTitle.textContent = '异步委托详情';
        delegationModalSubtitle.textContent = delegationId;
        delegationModalBody.innerHTML = '<div class="empty-state">正在读取任务详情...</div>';
    }

    delegationModal.classList.add('active');

    try {
        const result = await apiFetch(`/agent-assistant/delegations/${encodeURIComponent(delegationId)}`);
        const detail = result?.data || cachedTask;
        if (detail) renderDelegationModal(detail);
    } catch (e) {
        console.error('Fetch delegation detail err:', e);
        if (!cachedTask) {
            delegationModalBody.innerHTML = `<div class="empty-state error">读取任务详情失败：${escapeHtml(e.message)}</div>`;
        }
    }
};

function renderDelegationModal(task) {
    const status = task.status || 'unknown';
    const agentName = task.agentName || task.agentBaseName || 'Unknown Agent';
    const canCancel = !task.cancelRequested && !['completed', 'failed', 'cancelled'].includes(status);
    const startTime = task.startTime ? new Date(task.startTime).toLocaleString() : 'N/A';
    const updatedAt = task.updatedAt ? new Date(task.updatedAt).toLocaleString() : 'N/A';
    const endTime = task.endTime ? new Date(task.endTime).toLocaleString() : '未结束';

    delegationModalTitle.textContent = `${agentName} · ${getDelegationStatusLabel(status)}`;
    delegationModalSubtitle.textContent = task.id || '无 ID';
    delegationModalCancelBtn.style.display = canCancel ? 'inline-flex' : 'none';

    delegationModalBody.innerHTML = `
        <div class="delegation-detail-meta">
            <div><span>状态</span><strong>${escapeHtml(getDelegationStatusLabel(status))}</strong></div>
            <div><span>轮数</span><strong>${escapeHtml(`${Number(task.currentRound || 0)} / ${Number(task.maxRounds || 0) || '-'}`)}</strong></div>
            <div><span>耗时</span><strong>${escapeHtml(formatDuration(task.elapsedMs))}</strong></div>
            <div><span>取消请求</span><strong>${task.cancelRequested ? '已请求' : '否'}</strong></div>
            <div><span>开始时间</span><strong>${escapeHtml(startTime)}</strong></div>
            <div><span>更新时间</span><strong>${escapeHtml(updatedAt)}</strong></div>
            <div><span>结束时间</span><strong>${escapeHtml(endTime)}</strong></div>
            <div><span>归档路径</span><strong title="${escapeHtml(task.archivePath || '')}">${escapeHtml(task.archivePath || '无')}</strong></div>
        </div>
        <div class="delegation-detail-section">
            <label>初始任务内容</label>
            <pre>${escapeHtml(task.taskPromptPreview || '无预览')}</pre>
        </div>
        <div class="delegation-detail-section">
            <label>最近一次 Agent 回复</label>
            <pre>${escapeHtml(task.lastResponsePreview || '尚无回复')}</pre>
        </div>
        <div class="delegation-detail-section">
            <label>最终报告</label>
            <pre>${escapeHtml(task.finalReportPreview || '暂无最终报告')}</pre>
        </div>
    `;
}

function getDelegationStatusLabel(status) {
    const labels = {
        running: '运行中',
        waiting: '等待心跳',
        cancelling: '取消中',
        completed: '已完成',
        failed: '失败',
        cancelled: '已取消'
    };
    return labels[status] || status || '未知';
}

function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) return `${hours}小时${minutes}分`;
    if (minutes > 0) return `${minutes}分${seconds}秒`;
    return `${seconds}秒`;
}

window.cancelDelegation = async (delegationId) => {
    if (!delegationId) return;
    if (!confirm(`确定请求取消异步委托任务 ${delegationId} 吗？`)) return;

    try {
        setDelegationStatus('正在提交取消请求...', 'loading');
        await apiFetch(`/agent-assistant/delegations/${encodeURIComponent(delegationId)}/cancel`, {
            method: 'POST',
            body: JSON.stringify({ reason: '用户从桌面任务面板请求取消。' })
        });
        setDelegationStatus('取消请求已提交', 'ok');
        await fetchDelegations();
    } catch (e) {
        console.error('Cancel delegation err:', e);
        setDelegationStatus(`取消失败: ${e.message}`, 'error');
        alert('取消失败: ' + e.message);
    }
};

function renderFAStatus(status) {
    const isGlobalRunning = status.globalEnabled;
    faStatusDashboard.innerHTML = `
        <div class="dashboard-stat" style="min-width: 120px;">
            <label class="switch-container">
                <input type="checkbox" ${isGlobalRunning ? 'checked' : ''} onchange="toggleGlobalScheduler(this.checked)">
                <span class="switch-slider"></span>
                <span class="stat-label">全局调度器</span>
            </label>
            <span style="font-size:0.8rem; color:${isGlobalRunning ? '#81c784' : '#e57373'}; margin-top:5px; font-weight:bold;">
                ${isGlobalRunning ? '运行中' : '已停止'}
            </span>
        </div>
        <div class="dashboard-stat">
            <span class="stat-value">${status.activeTimerCount || 0}</span>
            <span class="stat-label">活跃定时器</span>
        </div>
         <div class="dashboard-stat">
            <span class="stat-value">${Array.isArray(status.tasks) ? status.tasks.length : 0}</span>
            <span class="stat-label">任务总数</span>
        </div>
        <div class="dashboard-stat" style="flex:1">
            <div class="stat-label">历史状态</div>
            <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:5px; max-height: 80px; overflow-y:auto;">
                 ${(status.history || []).slice(0, 5).map(h => {
                     const date = h.startedAt || h.finishedAt || h.time;
                     const timeStr = date ? new Date(date).toLocaleTimeString() : 'N/A';
                     const isSuccess = h.status === 'success' || h.success;
                     const targetName = h.taskName || h.taskId || 'Unknown';
                     return `<div style="margin-bottom:4px;">${timeStr} - ${escapeHtml(targetName)} (<span style="color:${isSuccess ? '#4caf50' : '#e57373'}">${isSuccess ? '成功' : '失败'}</span>)</div>`;
                 }).join('') || '尚无记录'}
            </div>
        </div>
    `;
}

function renderFAConfig() {
    taskListContainer.innerHTML = '';
    const tasks = currentFAConfig || [];
    
    tasks.forEach((task, index) => {
        const card = document.createElement('div');
        card.className = 'card-item glass-hover';
        const isEnabled = task.enabled;
        
        // Find last history for this task
        const lastHistory = currentStatus?.history?.find(h => (h.taskId === task.id || h.taskName === task.name));
        let statusHtml = '';
        if (lastHistory) {
            const time = new Date(lastHistory.finishedAt || lastHistory.time).toLocaleTimeString();
            const success = lastHistory.status === 'success' || lastHistory.success;
            statusHtml = `
                <div class="task-last-run">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${success ? '#81c784' : '#e57373'}" stroke-width="3"><circle cx="12" cy="12" r="10"></circle></svg>
                    <span>上次运行: ${time} (${success ? '成功' : '失败'})</span>
                </div>
            `;
        }

        card.innerHTML = `
            <div class="task-card-header">
                <h3>${escapeHtml(task.name || task.id)}</h3>
                <div class="task-card-actions">
                    <button class="action-btn run-btn" title="立即执行" onclick="event.stopPropagation(); triggerTaskDirect('${task.id}')">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>
                    </button>
                    <button class="action-btn" title="编辑" onclick="event.stopPropagation(); openTaskModalByIndex(${index})">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                    <button class="action-btn delete-btn" title="删除" onclick="event.stopPropagation(); deleteTaskByIndex(${index})">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                </div>
            </div>
            <div class="task-meta">
                <div class="task-meta-item">
                    <label class="switch-container" onclick="event.stopPropagation()">
                        <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="toggleTaskEnabled(${index}, this.checked)">
                        <span class="switch-slider"></span>
                        <span class="task-badge ${isEnabled ? 'enabled' : 'disabled'}">${isEnabled ? '正在运行' : '已停用'}</span>
                    </label>
                </div>
                <div class="task-meta-item">
                    <label class="switch-container" onclick="event.stopPropagation()">
                        <input type="checkbox" ${!!task.dispatch?.taskDelegation ? 'checked' : ''} onchange="toggleTaskDelegation(${index}, this.checked)">
                        <span class="switch-slider"></span>
                        <span class="stat-label" style="font-size:0.75rem; margin-left:5px;">异步委托</span>
                    </label>
                </div>
                <div class="task-meta-item">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                    <span>
                        ${escapeHtml(task.schedule?.mode === 'cron' ? `cron | ${task.schedule.cronValue || '未设置'}` : 
                          task.schedule?.mode === 'once' ? `once | ${task.schedule.runAt ? new Date(task.schedule.runAt).toLocaleString() : '未设置'}` :
                          task.schedule?.mode === 'manual' ? 'manual | 手动触发' :
                          `${task.schedule?.mode || '未知'} | ${task.schedule?.intervalMinutes || '-'} min`)}
                    </span>
                </div>
            </div>
            <div class="task-targets">
                ${(task.targets?.agents || []).map(a => `<span class="target-tag">${escapeHtml(a)}</span>`).join('') || '<span class="target-tag" style="opacity:0.5">无指派</span>'}
            </div>
            ${statusHtml}
        `;
        
        card.addEventListener('click', () => {
            openTaskModal(task, index);
        });

        taskListContainer.appendChild(card);
    });
}

window.triggerTaskDirect = async (taskId) => {
    try {
        await apiFetch(`/task-assistant/trigger`, { 
            method: 'POST', 
            body: JSON.stringify({ taskId }) 
        });
        fetchFAStatus(); 
    } catch(e) {
        alert('触发失败: ' + e.message);
    }
};

window.openTaskModalByIndex = (index) => {
    openTaskModal(currentFAConfig[index], index);
};

window.deleteTaskByIndex = (index) => {
    if (confirm(`确定要删除任务 "${currentFAConfig[index].name}" 吗？`)) {
        currentFAConfig.splice(index, 1);
        renderFAConfig();
    }
};

window.toggleTaskEnabled = async (index, enabled) => {
    currentFAConfig[index].enabled = enabled;
    renderFAConfig(); // UI immediate feedback
    saveFAConfig(true); // Auto save to server silently
};

window.toggleTaskDelegation = async (index, delegated) => {
    if (!currentFAConfig[index].dispatch) currentFAConfig[index].dispatch = {};
    currentFAConfig[index].dispatch.taskDelegation = delegated;
    renderFAConfig(); 
    saveFAConfig(true); 
};

// Temporary debug utility to trigger task


// ========== Task Editing Modal Logic ==========
// const taskModal already declared at top
const taskModalBody = document.getElementById('task-modal-body');
const taskModalSaveBtn = document.getElementById('task-modal-save');
const taskModalTriggerBtn = document.getElementById('task-modal-trigger');

document.getElementById('create-task-btn')?.addEventListener('click', () => {
    openTaskModal({
        id: `draft_${Date.now()}`,
        name: '新建草稿任务',
        type: 'custom_prompt',
        enabled: false,
        schedule: { mode: 'manual' },
        targets: { agents: [] },
        dispatch: {},
        payload: { promptTemplate: '' }
    }, -1);
});

document.getElementById('save-tasks-btn')?.addEventListener('click', saveFAConfig);

async function saveFAConfig(silent = false) {
    if (!currentFAConfig) return;
    const btn = document.getElementById('save-tasks-btn');
    if(btn && !silent) btn.textContent = '保存中...';
    try {
        const payload = {
            globalEnabled: currentStatus?.globalEnabled ?? true,
            tasks: currentFAConfig,
            settings: { maxHistory: 200 }
        };
        await apiFetch('/task-assistant/config', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        if(btn && !silent) {
            btn.textContent = '✅ 保存成功';
            setTimeout(() => { if(btn) btn.textContent = '保存所有配置'; }, 2000);
        }
        fetchFAConfig(); // Refresh
        fetchFAStatus(); // Refresh status
    } catch(e) {
        if(btn && !silent) {
            btn.textContent = '❌ 保存失败';
            setTimeout(() => { if(btn) btn.textContent = '保存所有配置'; }, 3000);
        }
        console.error(e);
    }
}

function openTaskModal(task, index) {
    // Generate a structured dynamic form
    currentEditingTask = JSON.parse(JSON.stringify(task)); 
    
    let fieldsHtml = `
        <div class="form-group">
            <label>任务名称</label>
            <input type="text" data-keypath="name" value="${escapeHtml(task.name || '')}" placeholder="例如：每日巡航">
        </div>
        <div class="aa-row" style="display:flex; gap:15px; margin-bottom:10px;">
            <div class="form-group" style="flex:1">
                <label>任务类型</label>
                <select data-keypath="type" onchange="updateModalType(this.value)">
                    <option value="forum_patrol" ${task.type === 'forum_patrol' ? 'selected' : ''}>论坛巡航 (Forum Patrol)</option>
                    <option value="custom_prompt" ${task.type === 'custom_prompt' ? 'selected' : ''}>通用指令 (Custom Prompt)</option>
                </select>
            </div>
            <div class="form-group" style="flex:1">
                <label>调度模式</label>
                <select data-keypath="schedule.mode" onchange="updateModalSchedule(this.value)">
                    <option value="interval" ${task.schedule?.mode === 'interval' ? 'selected' : ''}>循环执行</option>
                    <option value="cron" ${task.schedule?.mode === 'cron' ? 'selected' : ''}>CRON 定时</option>
                    <option value="manual" ${task.schedule?.mode === 'manual' ? 'selected' : ''}>手动触发</option>
                    <option value="once" ${task.schedule?.mode === 'once' ? 'selected' : ''}>一次性执行</option>
                </select>
            </div>
            <div class="form-group" style="flex:1; display:flex; align-items:flex-end; padding-bottom:5px;">
                <label class="switch-container">
                    <span style="margin-right:10px;">异步高级委托</span>
                    <input type="checkbox" data-keypath="dispatch.taskDelegation" ${!!task.dispatch?.taskDelegation ? 'checked' : ''}>
                    <span class="switch-slider"></span>
                </label>
            </div>
        </div>

        <div id="modal-schedule-fields">
            <div class="form-group" data-mode="interval" style="display:${task.schedule?.mode === 'interval' ? 'block' : 'none'}">
                <label>循环间隔 (分钟)</label>
                <input type="number" data-keypath="schedule.intervalMinutes" value="${task.schedule?.intervalMinutes || 60}">
            </div>
            <div class="form-group" data-mode="cron" style="display:${task.schedule?.mode === 'cron' ? 'block' : 'none'}">
                <label>CRON 表达式</label>
                <input type="text" data-keypath="schedule.cronValue" value="${escapeHtml(task.schedule?.cronValue || '')}" placeholder="例如: 0 8 * * *">
            </div>
            <div class="form-group" data-mode="once" style="display:${task.schedule?.mode === 'once' ? 'block' : 'none'}">
                <label>执行时间</label>
                <input type="datetime-local" data-keypath="schedule.runAt" value="${task.schedule?.runAt ? new Date(task.schedule.runAt).toISOString().slice(0, 16) : ''}">
            </div>
        </div>

        <div class="form-group">
            <label>指派 Agent (可多选，支持随机逻辑)</label>
            <div class="input-with-select" style="display:flex; flex-direction:column; gap:8px;">
                <div style="display:flex; gap:10px;">
                    <input type="text" data-keypath="targets.agents" value="${(task.targets?.agents || []).join(', ')}" placeholder="例如：诺娃, 可可" style="flex:1">
                    <select class="agent-quick-select" style="width:100px;" onchange="updateModalAgent(this.value)">
                        <option value="">+ 选择</option>
                        ${(currentAAConfig?.agents || []).map(a => `<option value="${escapeHtml(a.chineseName || a.baseName)}">${escapeHtml(a.chineseName || a.baseName)}</option>`).join('')}
                    </select>
                </div>
                <div class="random-tags-group" style="display:flex; gap:8px; align-items:center;">
                    <span style="font-size:0.8rem; opacity:0.8;">🎲 随机逻辑:</span>
                    <input type="number" id="random-count-input" value="1" min="1" style="width:50px; padding:4px 8px; font-size:0.8rem; text-align:center;">
                    <button class="glass-btn" style="padding:4px 10px; font-size:0.75rem; border-color:var(--accent-color); color:var(--accent-color);" onclick="event.preventDefault(); const val = document.getElementById('random-count-input').value || 1; appendAgentTag('random' + val)">添加随机规则</button>
                    <span style="font-size:0.7rem; opacity:0.5;">(从前文列表中选择 N 个)</span>
                </div>
            </div>
        </div>

        <div class="form-group">
            <label>提示词模板</label>
            <textarea data-keypath="payload.promptTemplate" style="min-height:120px;">${escapeHtml(task.payload?.promptTemplate || '')}</textarea>
        </div>

        <div id="modal-forum-fields" style="display:${task.type === 'forum_patrol' ? 'block' : 'none'}">
             <div class="form-group checkbox-group" style="flex-direction:row; align-items:center; gap:12px; margin-bottom:15px; background:rgba(255,255,255,0.03); padding:10px; border-radius:12px; border:1px solid var(--glass-border);">
                <label class="switch-container">
                    <input type="checkbox" data-keypath="payload.includeForumPostList" ${task.payload?.includeForumPostList !== false ? 'checked' : ''}>
                    <span class="switch-slider"></span>
                </label>
                <div style="display:flex; flex-direction:column;">
                    <span style="font-weight:600; font-size:0.95rem;">预读取论坛帖子列表</span>
                    <span style="font-size:0.75rem; opacity:0.6;">开启后，系统将自动拉取最新的论坛帖子。</span>
                </div>
            </div>

            <div class="form-group">
                <label>论坛列表占位符</label>
                <input type="text" data-keypath="payload.forumListPlaceholder" value="${escapeHtml(task.payload?.forumListPlaceholder || '{{forum_post_list}}')}">
                <span style="font-size:0.75rem; opacity:0.6; margin-top:2px;">提示词中出现该占位符时，会自动替换为论坛帖子列表。</span>
            </div>

            <div class="form-group">
                <label>最大读取帖子数</label>
                <input type="number" data-keypath="payload.maxPosts" value="${task.payload?.maxPosts || 200}">
                <span style="font-size:0.75rem; opacity:0.6; margin-top:2px;">用于控制注入到提示词中的帖子条目数量。</span>
            </div>
        </div>
    `;

    taskModalBody.innerHTML = fieldsHtml;
    
    // Helper visibility togglers
    window.updateModalType = (val) => {
        document.getElementById('modal-forum-fields').style.display = (val === 'forum_patrol' ? 'block' : 'none');
        
        // Auto-template for Forum Patrol
        const promptArea = taskModalBody.querySelector('textarea[data-keypath="payload.promptTemplate"]');
        if (val === 'forum_patrol' && (!promptArea.value || promptArea.value.trim() === '')) {
            const defaultTemplate = `[论坛小助手:]现在是论坛时间~ 你可以选择分享一个感兴趣的话题/趣味性话题/亦或者分享一些互联网新鲜事/或者发起一个最近几天想要讨论的话题作为新帖子；或者单纯只是先阅读一些别人的你感兴趣帖子，然后做出你的回复(先读帖再回复是好习惯)~\n\n以下是完整的论坛帖子列表:\n{{forum_post_list}}`;
            promptArea.value = defaultTemplate;
        }
    };
    window.updateModalAgent = (val) => {
        if (!val) return;
        appendAgentTag(val);
        // Reset select
        taskModalBody.querySelector('.agent-quick-select').value = '';
    };
    window.appendAgentTag = (val) => {
        const input = taskModalBody.querySelector('input[data-keypath="targets.agents"]');
        let current = input.value.trim();
        if (current) {
            const agents = current.split(',').map(s => s.trim()).filter(Boolean);
            if (!agents.includes(val)) {
                agents.push(val);
                input.value = agents.join(', ');
            }
        } else {
            input.value = val;
        }
    };
    window.updateModalSchedule = (val) => {
        const fields = document.getElementById('modal-schedule-fields').querySelectorAll('.form-group');
        fields.forEach(f => f.style.display = 'none');
        const target = document.getElementById('modal-schedule-fields').querySelector(`[data-mode="${val}"]`);
        if (target) target.style.display = 'block';
    };

    taskModalSaveBtn.onclick = () => {
        const updatedTask = JSON.parse(JSON.stringify(task));
        taskModalBody.querySelectorAll('input, select, textarea').forEach(el => {
            const keyPath = el.getAttribute('data-keypath');
            if(!keyPath) return;

            let val = el.type === 'checkbox' ? el.checked : el.value;
            if (el.type === 'number') val = Number(val);
            if (keyPath === 'targets.agents') {
                val = val.split(',').map(s=>s.trim()).filter(Boolean);
            }

            const pathObj = keyPath.split('.');
            let current = updatedTask;
            for(let i=0; i<pathObj.length - 1; i++) {
                if(!current[pathObj[i]]) current[pathObj[i]] = {};
                current = current[pathObj[i]];
            }
            current[pathObj[pathObj.length-1]] = val;
        });

        // Cleanup draft ID if saving
        if (updatedTask.id && updatedTask.id.startsWith('draft_')) {
             updatedTask.id = 'fa_' + Date.now();
        }

        if (index === -1) {
            currentFAConfig.push(updatedTask);
        } else {
            currentFAConfig[index] = updatedTask;
        }

        renderFAConfig();
        taskModal.classList.remove('active');
        saveFAConfig(); // Auto save to server on modal confirm
    };

    taskModalTriggerBtn.onclick = () => {
        if (task.id) triggerTaskDirect(task.id);
        taskModal.classList.remove('active');
    };

    taskModal.classList.add('active');
}

window.toggleGlobalScheduler = async (enabled) => {
    try {
        const data = await apiFetch('/task-assistant/config');
        const payload = {
            ...data,
            globalEnabled: enabled,
            tasks: data.config?.tasks || data.tasks || [], // Support both structures
            settings: data.settings || { maxHistory: 200 }
        };
        // Clean up redundant nesting if exists
        delete payload.config; 

        await apiFetch('/task-assistant/config', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        fetchFAStatus(); 
    } catch(e) {
        console.error('Global switch failed', e);
        fetchFAStatus(); 
    }
};

// Utilities
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return unsafe;
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
