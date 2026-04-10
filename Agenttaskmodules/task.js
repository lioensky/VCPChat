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
        });
    });
    
    // Save Editing Agent
    document.getElementById('agent-modal-confirm').addEventListener('click', () => {
        if (currentEditingAgentIndex >= 0 && currentAAConfig) {
            const body = document.getElementById('agent-modal-body');
            const inputs = body.querySelectorAll('input, textarea');
            inputs.forEach(input => {
                const key = input.dataset.key;
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

async function fetchAAConfig() {
    try {
        refreshAgentsBtn.classList.add('spinning'); // Assume a spinner CSS is added or opacity drops
        const data = await apiFetch('/agent-assistant/config');
        currentAAConfig = data;
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
    
    // Render Globals
    aaGlobalSettings.innerHTML = Object.keys(currentAAConfig)
        .filter(k => k !== 'agents')
        .map(key => {
            const val = currentAAConfig[key];
            const isPrompt = key.toLowerCase().includes('prompt');
            return `
            <div class="setting-row" ${isPrompt ? 'style="align-items:flex-start; flex-direction:column; gap:8px;"' : ''}>
                <div ${isPrompt ? 'style="width: 100%;"' : ''}>
                    <div class="setting-label">${key}</div>
                </div>
                ${isPrompt 
                    ? `<textarea class="setting-input" style="width:100%; min-height:80px; resize:vertical; background:rgba(0,0,0,0.4);" data-key="${key}" onchange="updateAAGlobal('${key}', this.value, '${typeof val}')">${escapeHtml(String(val))}</textarea>`
                    : `<input class="setting-input" type="${typeof val === 'number' ? 'number' : 'text'}" 
                       value="${escapeHtml(String(val))}" 
                       data-key="${key}" onchange="updateAAGlobal('${key}', this.value, '${typeof val}')">`
                }
            </div>`;
        }).join('');

    // Render Agents Grid
    agentListContainer.innerHTML = '';
    const agents = currentAAConfig.agents || [];
    
    agents.forEach((agent, index) => {
        const card = document.createElement('div');
        card.className = 'card-item glass-hover';
        
        card.innerHTML = `
            <div class="agent-card-header">
                <div class="agent-avatar" data-name="${escapeHtml(agent.chineseName || agent.baseName)}">
                    ${(agent.chineseName || agent.baseName).slice(0,1)}
                </div>
                <div class="agent-info">
                    <h3>${escapeHtml(agent.chineseName || agent.baseName)}</h3>
                    <div class="model-id">${escapeHtml(agent.modelId || 'default')}</div>
                </div>
            </div>
            <div class="agent-description">${escapeHtml(agent.description || '无介绍...')}</div>
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

window.updateAAGlobal = (key, val, type) => {
    if (currentAAConfig) {
        currentAAConfig[key] = type === 'number' ? Number(val) : val;
    }
};

function openAgentModal(index) {
    const agent = currentAAConfig.agents[index];
    currentEditingAgentIndex = index;
    document.getElementById('agent-modal-title').textContent = `编辑 ${agent.chineseName || agent.baseName}`;
    
    const body = document.getElementById('agent-modal-body');
    const fieldsHtml = Object.keys(agent).map(key => {
        const val = agent[key];
        const isLongText = typeof val === 'string' && val.length > 50;
        
        if (isLongText) {
            return `
                <div class="form-group">
                    <label>${key}</label>
                    <textarea data-key="${key}">${escapeHtml(val)}</textarea>
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
refreshTasksBtn.addEventListener('click', () => { fetchFAConfig(); fetchFAStatus(); });

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
                <input type="text" data-keypath="payload.forumPostListPlaceholder" value="${escapeHtml(task.payload?.forumPostListPlaceholder || '{{forum_post_list}}')}">
                <span style="font-size:0.75rem; opacity:0.6; margin-top:2px;">提示词中出现该占位符时，会自动替换为论坛帖子列表。</span>
            </div>

            <div class="form-group">
                <label>最大读取帖子数</label>
                <input type="number" data-keypath="payload.forumPostMaxCount" value="${task.payload?.forumPostMaxCount || 100}">
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
