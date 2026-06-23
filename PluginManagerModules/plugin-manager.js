const api = window.utilityAPI || window.electronAPI;

const PLUGIN_TYPES = ['static', 'messagePreprocessor', 'synchronous', 'asynchronous', 'service', 'hybridservice'];
const TYPE_LABELS = {
    static: 'Static 自动注入',
    messagePreprocessor: 'Message Preprocessor 请求预处理',
    synchronous: 'Synchronous 同步工具',
    asynchronous: 'Asynchronous 异步任务',
    service: 'Service 常驻服务',
    hybridservice: 'Hybrid Service 混合服务',
    unknown: 'Unknown 未分类'
};

let allPlugins = [];
let currentSettings = {};
let currentEditingPlugin = null;
let currentEditingManifest = null;

const els = {
    refreshBtn: document.getElementById('refresh-btn'),
    minimizeBtn: document.getElementById('minimize-btn'),
    maximizeBtn: document.getElementById('maximize-btn'),
    closeBtn: document.getElementById('close-btn'),
    serverToggle: document.getElementById('distributed-server-toggle'),
    serverStatus: document.getElementById('distributed-server-status'),
    saveServerToggleBtn: document.getElementById('save-server-toggle-btn'),
    searchInput: document.getElementById('plugin-search-input'),
    typeFilter: document.getElementById('plugin-type-filter'),
    stateFilter: document.getElementById('plugin-state-filter'),
    summaryDashboard: document.getElementById('summary-dashboard'),
    pluginGroups: document.getElementById('plugin-groups'),
    modal: document.getElementById('plugin-modal'),
    modalTitle: document.getElementById('plugin-modal-title'),
    modalSubtitle: document.getElementById('plugin-modal-subtitle'),
    manifestEditor: document.getElementById('manifest-editor'),
    commandsList: document.getElementById('commands-editor-list'),
    envEditor: document.getElementById('env-editor'),
    togglePluginBtn: document.getElementById('toggle-plugin-btn'),
    openPluginFolderBtn: document.getElementById('open-plugin-folder-btn'),
    saveManifestBtn: document.getElementById('save-manifest-btn'),
    saveEnvBtn: document.getElementById('save-env-btn'),
    toastContainer: document.getElementById('toast-container')
};

document.addEventListener('DOMContentLoaded', async () => {
    wireEvents();
    await initializeThemeAndSettings();
    await refreshPlugins();
});

function wireEvents() {
    els.minimizeBtn?.addEventListener('click', () => api?.minimizeWindow?.());
    els.maximizeBtn?.addEventListener('click', () => api?.maximizeWindow?.());
    els.closeBtn?.addEventListener('click', () => api?.closeWindow ? api.closeWindow() : window.close());

    els.refreshBtn?.addEventListener('click', refreshPlugins);
    els.searchInput?.addEventListener('input', renderPlugins);
    els.typeFilter?.addEventListener('change', renderPlugins);
    els.stateFilter?.addEventListener('change', renderPlugins);

    els.saveServerToggleBtn?.addEventListener('click', saveDistributedServerToggle);
    els.serverToggle?.addEventListener('change', updateServerStatusText);

    document.querySelectorAll('.modal-close-btn').forEach(btn => {
        btn.addEventListener('click', closeModal);
    });

    els.modal?.addEventListener('click', event => {
        if (event.target === els.modal) closeModal();
    });

    document.querySelectorAll('.modal-tab').forEach(tab => {
        tab.addEventListener('click', () => activateModalTab(tab.dataset.target));
    });

    els.saveManifestBtn?.addEventListener('click', saveCurrentManifest);
    els.saveEnvBtn?.addEventListener('click', saveCurrentEnv);
    els.togglePluginBtn?.addEventListener('click', toggleCurrentPlugin);
    els.openPluginFolderBtn?.addEventListener('click', openCurrentPluginFolder);

    els.manifestEditor?.addEventListener('input', () => {
        try {
            currentEditingManifest = JSON.parse(els.manifestEditor.value);
            renderCommandEditors();
        } catch (error) {
            // 编辑过程中允许临时 JSON 不完整。
        }
    });
}

async function initializeThemeAndSettings() {
    try {
        currentSettings = await api?.loadSettings?.() || {};
        applyTheme(currentSettings.currentThemeMode);
        api?.onThemeUpdated?.(applyTheme);
        els.serverToggle.checked = Boolean(currentSettings.enableDistributedServer);
        updateServerStatusText();
    } catch (error) {
        showToast(`读取主设置失败：${error.message}`, 'error');
        updateServerStatusText();
    }
}

function applyTheme(theme) {
    document.body.classList.toggle('light-theme', theme === 'light');
}

function updateServerStatusText() {
    if (!els.serverStatus || !els.serverToggle) return;
    els.serverStatus.textContent = els.serverToggle.checked ? '已在主设置中开启' : '当前处于关闭状态';
}

async function saveDistributedServerToggle() {
    if (!api?.saveSettings) {
        showToast('当前预加载 API 不支持保存设置', 'error');
        return;
    }

    try {
        const latestSettings = await api.loadSettings();
        const updatedSettings = {
            ...(latestSettings || {}),
            enableDistributedServer: Boolean(els.serverToggle.checked)
        };
        const result = await api.saveSettings(updatedSettings);
        if (result?.success === false) {
            throw new Error(result.error || '保存失败');
        }
        currentSettings = updatedSettings;
        updateServerStatusText();
        showToast('分布式服务器开关已保存。重启或重新启动相关服务后生效。', 'success');
    } catch (error) {
        showToast(`保存分布式服务器开关失败：${error.message}`, 'error');
    }
}

async function refreshPlugins() {
    if (!api?.pluginManagerListPlugins) {
        els.pluginGroups.innerHTML = '<div class="empty-state glass">插件管理 IPC 尚未注入，请确认主进程与预加载脚本已更新。</div>';
        return;
    }

    try {
        setLoading(true);
        const result = await api.pluginManagerListPlugins();
        if (!result?.success) {
            throw new Error(result?.error || '扫描失败');
        }
        allPlugins = Array.isArray(result.plugins) ? result.plugins : [];
        renderPlugins();
        showToast(`已扫描 ${allPlugins.length} 个插件`, 'success');
    } catch (error) {
        els.pluginGroups.innerHTML = `<div class="empty-state glass">扫描插件失败：${escapeHtml(error.message)}</div>`;
        showToast(`扫描插件失败：${error.message}`, 'error');
    } finally {
        setLoading(false);
    }
}

function setLoading(isLoading) {
    if (!els.refreshBtn) return;
    els.refreshBtn.style.opacity = isLoading ? '0.45' : '';
    els.refreshBtn.disabled = isLoading;
}

function getPluginTypes(plugin) {
    const manifest = plugin.manifest || {};
    const raw = manifest.pluginType || plugin.pluginType || 'unknown';
    if (Array.isArray(raw)) return raw.length ? raw : ['unknown'];
    if (typeof raw === 'string' && raw.trim()) {
        return raw.split(/[,+/|]/).map(v => v.trim()).filter(Boolean);
    }
    return ['unknown'];
}

function getPrimaryType(plugin) {
    const types = getPluginTypes(plugin);
    return types.find(type => PLUGIN_TYPES.includes(type)) || types[0] || 'unknown';
}

function getCommands(plugin) {
    return plugin?.manifest?.capabilities?.invocationCommands || [];
}

function getFilteredPlugins() {
    const q = (els.searchInput?.value || '').trim().toLowerCase();
    const typeFilter = els.typeFilter?.value || 'all';
    const stateFilter = els.stateFilter?.value || 'all';

    return allPlugins.filter(plugin => {
        const types = getPluginTypes(plugin);
        const state = plugin.parseError ? 'invalid' : (plugin.enabled ? 'enabled' : 'disabled');

        if (typeFilter !== 'all') {
            if (typeFilter === 'unknown') {
                if (types.some(type => PLUGIN_TYPES.includes(type))) return false;
            } else if (!types.includes(typeFilter)) {
                return false;
            }
        }

        if (stateFilter !== 'all' && state !== stateFilter) return false;

        if (!q) return true;

        const manifest = plugin.manifest || {};
        const commands = getCommands(plugin);
        const haystack = [
            plugin.folderName,
            plugin.relativePath,
            manifest.name,
            manifest.displayName,
            manifest.description,
            manifest.author,
            manifest.version,
            manifest.pluginType,
            plugin.configEnvContent,
            ...commands.flatMap(cmd => [cmd.commandIdentifier, cmd.description, cmd.example])
        ].filter(Boolean).join('\n').toLowerCase();

        return haystack.includes(q);
    });
}

function renderPlugins() {
    renderSummary();

    const filtered = getFilteredPlugins();
    if (!filtered.length) {
        els.pluginGroups.innerHTML = '<div class="empty-state glass">没有匹配当前筛选条件的插件。</div>';
        return;
    }

    const grouped = new Map();
    for (const plugin of filtered) {
        const primaryType = getPrimaryType(plugin);
        const key = PLUGIN_TYPES.includes(primaryType) ? primaryType : 'unknown';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(plugin);
    }

    const groupOrder = [...PLUGIN_TYPES, 'unknown'].filter(type => grouped.has(type));
    els.pluginGroups.innerHTML = groupOrder.map(type => renderPluginGroup(type, grouped.get(type))).join('');
}

function renderSummary() {
    const enabled = allPlugins.filter(p => p.enabled && !p.parseError).length;
    const disabled = allPlugins.filter(p => !p.enabled && !p.parseError).length;
    const invalid = allPlugins.filter(p => p.parseError).length;
    const commands = allPlugins.reduce((sum, p) => sum + getCommands(p).length, 0);
    const withEnv = allPlugins.filter(p => p.hasConfigEnv).length;

    els.summaryDashboard.innerHTML = [
        ['总插件', allPlugins.length],
        ['已启用', enabled],
        ['已禁用', disabled],
        ['异常', invalid],
        ['命令数', commands],
        ['含 config.env', withEnv]
    ].map(([label, value]) => `
        <div class="summary-card">
            <strong>${value}</strong>
            <span>${label}</span>
        </div>
    `).join('');
}

function renderPluginGroup(type, plugins) {
    const label = TYPE_LABELS[type] || type;
    return `
        <section class="plugin-group glass">
            <div class="plugin-group-header">
                <h2>${escapeHtml(label)}</h2>
                <span>${plugins.length} 个插件</span>
            </div>
            <div class="plugin-grid">
                ${plugins.map(renderPluginCard).join('')}
            </div>
        </section>
    `;
}

function renderPluginCard(plugin) {
    const manifest = plugin.manifest || {};
    const name = manifest.displayName || manifest.name || plugin.folderName;
    const types = getPluginTypes(plugin);
    const commands = getCommands(plugin);
    const stateBadge = plugin.parseError
        ? '<span class="badge invalid">异常</span>'
        : `<span class="badge ${plugin.enabled ? 'enabled' : 'disabled'}">${plugin.enabled ? '已启用' : '已禁用'}</span>`;

    const description = plugin.parseError
        ? `Manifest 解析失败：${plugin.parseError}`
        : (manifest.description || '该插件没有描述。');

    return `
        <article class="plugin-card ${plugin.enabled ? '' : 'disabled'} ${plugin.parseError ? 'invalid' : ''}" onclick="openPluginModal('${escapeAttr(plugin.folderName)}')">
            <div class="plugin-card-head">
                <div class="plugin-title">
                    <h3 title="${escapeAttr(name)}">${escapeHtml(name)}</h3>
                    <small>${escapeHtml(plugin.folderName)}</small>
                </div>
                <div class="badges">
                    ${stateBadge}
                    ${types.map(type => `<span class="badge">${escapeHtml(type)}</span>`).join('')}
                </div>
            </div>
            <div class="plugin-description">${escapeHtml(description)}</div>
            <div class="plugin-meta-grid">
                <div><span>版本</span><strong>${escapeHtml(manifest.version || '-')}</strong></div>
                <div><span>作者</span><strong>${escapeHtml(manifest.author || '-')}</strong></div>
                <div><span>配置</span><strong>${plugin.hasConfigEnv ? 'config.env' : '无'}</strong></div>
            </div>
            <div class="command-preview">
                ${commands.length
                    ? commands.slice(0, 5).map(cmd => `<span class="command-chip">${escapeHtml(cmd.commandIdentifier || 'command')}</span>`).join('')
                    : '<span class="command-chip">无 invocationCommands</span>'
                }
                ${commands.length > 5 ? `<span class="command-chip">+${commands.length - 5}</span>` : ''}
            </div>
        </article>
    `;
}

window.openPluginModal = function openPluginModal(folderName) {
    const plugin = allPlugins.find(item => item.folderName === folderName);
    if (!plugin) return;

    currentEditingPlugin = plugin;
    currentEditingManifest = clone(plugin.manifest || {});

    const manifest = currentEditingManifest;
    const title = manifest.displayName || manifest.name || plugin.folderName;
    els.modalTitle.textContent = title;
    els.modalSubtitle.textContent = `${plugin.relativePath} · ${plugin.enabled ? '已启用' : '已禁用'}`;
    els.manifestEditor.value = JSON.stringify(manifest, null, 2);
    els.envEditor.value = plugin.configEnvContent || '';
    els.togglePluginBtn.textContent = plugin.enabled ? '禁用插件' : '启用插件';

    renderCommandEditors();
    activateModalTab('manifest-panel');
    els.modal.classList.add('active');
};

function closeModal() {
    els.modal.classList.remove('active');
    currentEditingPlugin = null;
    currentEditingManifest = null;
}

function activateModalTab(targetId) {
    document.querySelectorAll('.modal-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.target === targetId);
    });
    document.querySelectorAll('.modal-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === targetId);
    });
}

function renderCommandEditors() {
    if (!currentEditingManifest) return;
    const commands = currentEditingManifest?.capabilities?.invocationCommands || [];

    if (!Array.isArray(commands) || commands.length === 0) {
        els.commandsList.innerHTML = '<div class="empty-state">该插件没有 invocationCommands。</div>';
        return;
    }

    els.commandsList.innerHTML = commands.map((cmd, index) => `
        <div class="command-editor-card">
            <h4>${escapeHtml(cmd.commandIdentifier || `Command #${index + 1}`)}</h4>
            <textarea class="command-description" data-command-index="${index}" placeholder="命令描述">${escapeHtml(cmd.description || '')}</textarea>
        </div>
    `).join('');

    els.commandsList.querySelectorAll('.command-description').forEach(textarea => {
        textarea.addEventListener('input', () => {
            const index = Number(textarea.dataset.commandIndex);
            if (currentEditingManifest?.capabilities?.invocationCommands?.[index]) {
                currentEditingManifest.capabilities.invocationCommands[index].description = textarea.value;
                els.manifestEditor.value = JSON.stringify(currentEditingManifest, null, 2);
            }
        });
    });
}

async function saveCurrentManifest() {
    if (!currentEditingPlugin) return;

    try {
        const parsed = JSON.parse(els.manifestEditor.value);
        if (!api?.pluginManagerSaveManifest) {
            throw new Error('插件 Manifest 保存 API 不可用');
        }

        const result = await api.pluginManagerSaveManifest({
            folderName: currentEditingPlugin.folderName,
            manifest: parsed
        });

        if (!result?.success) {
            throw new Error(result?.error || '保存失败');
        }

        showToast('Manifest 已保存', 'success');
        await refreshPlugins();
        const reopened = allPlugins.find(item => item.folderName === currentEditingPlugin.folderName);
        if (reopened) window.openPluginModal(reopened.folderName);
    } catch (error) {
        showToast(`保存 Manifest 失败：${error.message}`, 'error');
    }
}

async function saveCurrentEnv() {
    if (!currentEditingPlugin) return;

    try {
        if (!api?.pluginManagerSaveConfigEnv) {
            throw new Error('config.env 保存 API 不可用');
        }

        const result = await api.pluginManagerSaveConfigEnv({
            folderName: currentEditingPlugin.folderName,
            content: els.envEditor.value
        });

        if (!result?.success) {
            throw new Error(result?.error || '保存失败');
        }

        showToast('config.env 已保存', 'success');
        await refreshPlugins();
    } catch (error) {
        showToast(`保存 config.env 失败：${error.message}`, 'error');
    }
}

async function toggleCurrentPlugin() {
    if (!currentEditingPlugin) return;

    try {
        if (!api?.pluginManagerSetPluginEnabled) {
            throw new Error('插件启停 API 不可用');
        }

        const targetEnabled = !currentEditingPlugin.enabled;
        const result = await api.pluginManagerSetPluginEnabled({
            folderName: currentEditingPlugin.folderName,
            enabled: targetEnabled
        });

        if (!result?.success) {
            throw new Error(result?.error || '切换失败');
        }

        showToast(targetEnabled ? '插件已启用' : '插件已禁用', 'success');
        await refreshPlugins();
        const reopened = allPlugins.find(item => item.folderName === currentEditingPlugin.folderName);
        if (reopened) window.openPluginModal(reopened.folderName);
    } catch (error) {
        showToast(`切换插件状态失败：${error.message}`, 'error');
    }
}

async function openCurrentPluginFolder() {
    if (!currentEditingPlugin) return;

    try {
        if (!api?.pluginManagerOpenPluginFolder) {
            throw new Error('打开目录 API 不可用');
        }

        const result = await api.pluginManagerOpenPluginFolder({
            folderName: currentEditingPlugin.folderName
        });

        if (!result?.success) {
            throw new Error(result?.error || '打开失败');
        }
    } catch (error) {
        showToast(`打开插件目录失败：${error.message}`, 'error');
    }
}

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    els.toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(6px)';
        setTimeout(() => toast.remove(), 260);
    }, 3000);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value || {}));
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#096;');
}