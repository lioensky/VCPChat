const api = window.utilityAPI || window.electronAPI;

const PLUGIN_TYPES = ['feature', 'renderer', 'static', 'messagePreprocessor', 'synchronous', 'asynchronous', 'service', 'hybridservice'];
const TYPE_LABELS = {
    feature: 'Feature 应用功能模块',
    renderer: 'Renderer 渲染层插件',
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
let activeType = 'all';
let activeState = 'all';
let activeView = 'plugins';
const TYPE_SHORT_LABELS = {
    feature: '应用功能',
    renderer: '渲染层',
    static: '自动注入',
    messagePreprocessor: '请求预处理',
    synchronous: '同步工具',
    asynchronous: '异步任务',
    service: '常驻服务',
    hybridservice: '混合服务',
    unknown: '未分类'
};
const expandedPlugins = new Set();

// 16px line glyphs for the navigation rail; each entry is the inner markup of a 24x24 svg.
const NAV_ICONS = {
    all: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    feature: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
    renderer: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    static: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    messagePreprocessor: '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
    synchronous: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
    asynchronous: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    service: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
    hybridservice: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
    unknown: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>'
};

const els = {
    refreshBtn: document.getElementById('refresh-btn'),
    toolbarRefreshBtn: document.getElementById('toolbar-refresh-btn'),
    notice: document.getElementById('plugin-notice'),
    minimizeBtn: document.getElementById('minimize-btn'),
    maximizeBtn: document.getElementById('maximize-btn'),
    closeBtn: document.getElementById('close-btn'),
    serverToggle: document.getElementById('distributed-server-toggle'),
    serverStatus: document.getElementById('distributed-server-status'),
    saveServerToggleBtn: document.getElementById('save-server-toggle-btn'),
    searchInput: document.getElementById('plugin-search-input'),
    typeTabs: document.getElementById('plugin-type-tabs'),
    stateFilter: document.getElementById('plugin-state-filter'),
    summaryDashboard: document.getElementById('summary-dashboard'),
    navServer: document.getElementById('nav-server'),
    pageTitle: document.getElementById('page-title'),
    viewPlugins: document.getElementById('view-plugins'),
    viewServer: document.getElementById('view-server'),
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
    els.toolbarRefreshBtn?.addEventListener('click', refreshPlugins);
    els.searchInput?.addEventListener('input', renderPlugins);
    els.stateFilter?.addEventListener('click', event => {
        const option = event.target.closest('[data-state]');
        if (!option) return;
        activeState = option.dataset.state;
        renderPlugins();
    });
    els.typeTabs?.addEventListener('click', event => {
        const tab = event.target.closest('[data-type]');
        if (!tab) return;
        activeType = tab.dataset.type;
        activeView = 'plugins';
        renderPlugins();
    });
    els.navServer?.addEventListener('click', () => {
        activeView = 'server';
        renderPlugins();
    });
    els.typeTabs?.addEventListener('keydown', handleTabKeydown);
    els.pluginGroups?.addEventListener('click', handlePluginListClick);

    els.saveServerToggleBtn?.addEventListener('click', saveDistributedServerToggle);
    els.serverToggle?.addEventListener('change', updateServerStatusText);

    document.querySelectorAll('.modal-close-btn').forEach(btn => {
        btn.addEventListener('click', closeModal);
    });

    els.modal?.addEventListener('click', event => {
        if (event.target === els.modal) closeModal();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && els.modal?.classList.contains('active')) closeModal();
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
        setNotice('');
        els.pluginGroups.innerHTML = '<div class="empty-state">插件管理 IPC 尚未注入，请确认主进程与预加载脚本已更新。</div>';
        return;
    }

    try {
        setLoading(true);
        const result = await api.pluginManagerListPlugins();
        if (!result?.success) {
            throw new Error(result?.error || '扫描失败');
        }
        allPlugins = Array.isArray(result.plugins) ? result.plugins : [];
        setNotice('');
        renderPlugins();
        showToast(`已扫描 ${allPlugins.length} 个插件`, 'success');
    } catch (error) {
        setNotice(`扫描插件失败：${error.message}`, true);
        els.pluginGroups.innerHTML = `<div class="empty-state">扫描插件失败：${escapeHtml(error.message)}</div>`;
        showToast(`扫描插件失败：${error.message}`, 'error');
    } finally {
        setLoading(false);
    }
}

function setLoading(isLoading) {
    for (const button of [els.refreshBtn, els.toolbarRefreshBtn]) {
        if (button) button.disabled = isLoading;
    }
    if (isLoading) {
        setNotice('正在读取插件状态…');
        els.pluginGroups.setAttribute('aria-busy', 'true');
    } else {
        els.pluginGroups.removeAttribute('aria-busy');
    }
}

function setNotice(text, isError = false) {
    if (!els.notice) return;
    els.notice.textContent = text;
    els.notice.dataset.tone = isError ? 'error' : 'neutral';
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
    const typeFilter = activeType;
    const stateFilter = activeState;

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

function renderView() {
    const onServer = activeView === 'server';
    const title = onServer ? '分布式服务器' : (activeType === 'all' ? '全部插件' : (TYPE_SHORT_LABELS[activeType] || activeType));
    els.viewPlugins.hidden = onServer;
    els.viewServer.hidden = !onServer;
    if (!onServer) els.pageTitle.textContent = title;
    els.navServer.toggleAttribute('aria-current', onServer);
    if (onServer) els.navServer.setAttribute('aria-current', 'page');
}

function renderPlugins() {
    renderSummary();
    renderTypeTabs();
    renderView();
    for (const option of els.stateFilter.querySelectorAll('[data-state]')) {
        option.setAttribute('aria-checked', String(option.dataset.state === activeState));
    }

    const filtered = getFilteredPlugins();
    if (!filtered.length) {
        const narrowed = Boolean((els.searchInput?.value || '').trim()) || activeType !== 'all' || activeState !== 'all';
        els.pluginGroups.innerHTML = `<div class="empty-state">${narrowed ? '无搜索结果' : '暂无插件'}</div>`;
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

function countByType() {
    const counts = new Map([['all', allPlugins.length]]);
    for (const plugin of allPlugins) {
        const keys = new Set(getPluginTypes(plugin).map(type => PLUGIN_TYPES.includes(type) ? type : 'unknown'));
        for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
}

function renderTypeTabs() {
    const counts = countByType();
    const visible = ['all', ...PLUGIN_TYPES, 'unknown'].filter(type => type === 'all' || counts.has(type));
    if (!visible.includes(activeType)) activeType = 'all';
    els.typeTabs.innerHTML = visible.map(type => {
        const label = type === 'all' ? '全部插件' : (TYPE_SHORT_LABELS[type] || type);
        const selected = activeView === 'plugins' && type === activeType;
        return `
        <button type="button" class="nav-item" role="tab" data-type="${escapeAttr(type)}" aria-selected="${selected}" tabindex="${type === activeType ? 0 : -1}" title="${escapeAttr(label)}">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_ICONS[type] || NAV_ICONS.unknown}</svg>
            <span class="nav-label">${escapeHtml(label)}</span>
            <span class="nav-count">${counts.get(type) || 0}</span>
        </button>`;
    }).join('');
}

function handleTabKeydown(event) {
    const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, Home: 'first', End: 'last' };
    if (!(event.key in keys)) return;
    const tabs = [...els.typeTabs.querySelectorAll('[data-type]')];
    const index = tabs.findIndex(tab => tab.dataset.type === activeType);
    const step = keys[event.key];
    const next = step === 'first' ? 0 : step === 'last' ? tabs.length - 1 : (index + step + tabs.length) % tabs.length;
    event.preventDefault();
    activeType = tabs[next].dataset.type;
    activeView = 'plugins';
    renderPlugins();
    els.typeTabs.querySelector(`[data-type="${CSS.escape(activeType)}"]`)?.focus();
}

function renderSummary() {
    const enabled = allPlugins.filter(p => p.enabled && !p.parseError).length;
    const disabled = allPlugins.filter(p => !p.enabled && !p.parseError).length;
    const invalid = allPlugins.filter(p => p.parseError).length;
    const commands = allPlugins.reduce((sum, p) => sum + getCommands(p).length, 0);
    const withEnv = allPlugins.filter(p => p.hasConfigEnv).length;

    const items = [
        [`共 ${allPlugins.length} 个插件`, ''],
        [`${enabled} 已启用`, 'on'],
        [`${disabled} 已禁用`, 'off'],
        [`${invalid} 异常`, invalid ? 'error' : 'off'],
        [`${commands} 个命令`, ''],
        [`${withEnv} 个含 config.env`, '']
    ];
    els.summaryDashboard.innerHTML = items.map(([text, tone]) =>
        `<span class="intro-item"${tone ? ` data-tone="${tone}"` : ''}>${tone ? '<i aria-hidden="true"></i>' : ''}${escapeHtml(text)}</span>`
    ).join('');
}

function renderPluginGroup(type, plugins) {
    const label = TYPE_LABELS[type] || type;
    return `
        <section class="plugin-group">
            <div class="plugin-group-header">
                <h2>${escapeHtml(label)}</h2>
                <span>${plugins.length}</span>
            </div>
            <div class="plugin-list">
                ${plugins.map(renderPluginCard).join('')}
            </div>
        </section>
    `;
}

// Settled enabled rows carry no marker; the switch already says enabled/disabled.
function getStateTag(plugin) {
    if (plugin.parseError) return { text: '加载异常', tone: 'error' };
    if (plugin.source === 'feature' && plugin.enabled !== plugin.active) return { text: '待重启', tone: 'pending' };
    if (plugin.source === 'feature') return { text: '只读', tone: 'neutral' };
    return null;
}

function getStateLabel(plugin) {
    if (plugin.parseError) return '加载异常';
    if (plugin.source === 'feature' && plugin.enabled !== plugin.active) return '重启后生效';
    return plugin.enabled ? '已启用' : '已停用';
}

function renderPluginCard(plugin) {
    const manifest = plugin.manifest || {};
    const name = manifest.displayName || manifest.name || plugin.folderName;
    const types = getPluginTypes(plugin);
    const commands = getCommands(plugin);
    const tag = getStateTag(plugin);
    const stateLabel = getStateLabel(plugin);
    const expanded = expandedPlugins.has(plugin.folderName);
    const folder = escapeAttr(plugin.folderName);
    const idSuffix = encodeURIComponent(plugin.folderName).replace(/[^\w-]/g, '_');
    const detailsId = `plugin-details-${idSuffix}`;
    const descriptionId = `plugin-description-${idSuffix}`;

    const description = plugin.parseError
        ? `Manifest 解析失败：${plugin.parseError}`
        : (manifest.description || '');

    return `
        <article class="plugins-card" data-plugin-id="${folder}">
            <div class="plugins-card-header">
                <button type="button" class="plugins-card-expand" data-action="expand" data-folder="${folder}" aria-expanded="${expanded}" aria-controls="${detailsId}" aria-label="${escapeAttr(`${name}，${stateLabel}`)}"${description ? ` aria-describedby="${descriptionId}"` : ''}>
                    <span class="plugins-card-copy">
                        <span class="plugins-card-line"><strong class="plugins-card-title" title="${escapeAttr(name)}">${escapeHtml(name)}</strong>${manifest.version ? `<span class="plugins-version">v${escapeHtml(String(manifest.version).replace(/^v/i, ''))}</span>` : ''}${tag ? `<span class="plugins-runtime" data-tone="${tag.tone}">${escapeHtml(tag.text)}</span>` : ''}</span>
                        ${description ? `<span class="plugins-card-description" id="${descriptionId}" title="${escapeAttr(description)}">${escapeHtml(description)}</span>` : ''}
                    </span>
                    <svg class="plugins-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
                </button>
                <div class="plugins-card-tools">
                    <button type="button" class="plugins-switch" role="switch" data-action="toggle" data-folder="${folder}" aria-checked="${plugin.enabled ? 'true' : 'false'}" aria-label="${escapeAttr(`启用 ${name}`)}" title="${escapeAttr(stateLabel)}"></button>
                </div>
            </div>
            <div class="plugins-card-details" id="${detailsId}"${expanded ? '' : ' hidden'}>
                <dl class="plugins-meta">
                    <dt>目录</dt><dd>${escapeHtml(plugin.relativePath || plugin.folderName)}</dd>
                    <dt>版本</dt><dd>${escapeHtml(manifest.version || '-')}</dd>
                    <dt>类型</dt><dd>${types.map(type => escapeHtml(type)).join(' · ')}</dd>
                    <dt>作者</dt><dd>${escapeHtml(manifest.author || '-')}</dd>
                    <dt>配置</dt><dd>${plugin.hasConfigEnv ? 'config.env' : '无'}</dd>
                    <dt>状态</dt><dd>${escapeHtml(stateLabel)}</dd>
                </dl>
                <div class="command-preview">
                    ${commands.length
                        ? commands.slice(0, 8).map(cmd => `<span class="command-chip">${escapeHtml(cmd.commandIdentifier || 'command')}</span>`).join('')
                        : '<span class="command-chip">无 invocationCommands</span>'
                    }
                    ${commands.length > 8 ? `<span class="command-chip">+${commands.length - 8}</span>` : ''}
                </div>
                <div class="plugins-config-actions">
                    <button type="button" class="plugins-button plugins-button-primary" data-action="edit" data-folder="${folder}">编辑配置</button>
                    <button type="button" class="plugins-button" data-action="folder" data-folder="${folder}">打开目录</button>
                </div>
            </div>
        </article>
    `;
}

function handlePluginListClick(event) {
    const control = event.target.closest('[data-action]');
    if (!control) return;
    const folderName = control.dataset.folder;
    switch (control.dataset.action) {
        case 'expand': {
            const open = control.getAttribute('aria-expanded') !== 'true';
            if (open) expandedPlugins.add(folderName); else expandedPlugins.delete(folderName);
            control.setAttribute('aria-expanded', String(open));
            document.getElementById(control.getAttribute('aria-controls'))?.toggleAttribute('hidden', !open);
            break;
        }
        case 'toggle': {
            if (control.disabled) break;
            const card = control.closest('.plugins-card');
            control.disabled = true;
            card?.setAttribute('aria-busy', 'true');
            setPluginEnabled(folderName, control.getAttribute('aria-checked') !== 'true').finally(() => {
                if (!control.isConnected) return;
                control.disabled = false;
                card?.removeAttribute('aria-busy');
            });
            break;
        }
        case 'edit':
            openPluginModal(folderName);
            break;
        case 'folder':
            openPluginFolder(folderName);
            break;
    }
}

function openPluginModal(folderName) {
    const plugin = allPlugins.find(item => item.folderName === folderName);
    if (!plugin) return;

    currentEditingPlugin = plugin;
    currentEditingManifest = clone(plugin.manifest || {});

    const manifest = currentEditingManifest;
    const title = manifest.displayName || manifest.name || plugin.folderName;
    els.modalTitle.textContent = title;
    const pendingRestart = plugin.source === 'feature' && !plugin.parseError && plugin.enabled !== plugin.active;
    els.modalSubtitle.textContent = `${plugin.relativePath} · ${plugin.enabled ? '已启用' : '已禁用'}${pendingRestart ? ' · 重启后生效' : ''}`;
    els.manifestEditor.value = JSON.stringify(manifest, null, 2);
    els.envEditor.value = plugin.configEnvContent || '';
    els.togglePluginBtn.textContent = plugin.enabled ? '禁用插件' : '启用插件';
    // 应用功能模块的清单随应用发布，只能启停
    const isFeature = plugin.source === 'feature';
    els.manifestEditor.readOnly = isFeature;
    els.envEditor.readOnly = isFeature;
    if (els.saveManifestBtn) els.saveManifestBtn.disabled = isFeature;
    if (els.saveEnvBtn) els.saveEnvBtn.disabled = isFeature;

    renderCommandEditors();
    activateModalTab('manifest-panel');
    els.modal.classList.add('active');
}
window.openPluginModal = openPluginModal;

function closeModal() {
    els.modal.classList.remove('active');
    currentEditingPlugin = null;
    currentEditingManifest = null;
}

function activateModalTab(targetId) {
    document.querySelectorAll('.modal-tab').forEach(tab => {
        const selected = tab.dataset.target === targetId;
        tab.classList.toggle('active', selected);
        tab.setAttribute('aria-selected', String(selected));
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
        if (reopened) openPluginModal(reopened.folderName);
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

async function setPluginEnabled(folderName, targetEnabled) {
    try {
        if (!api?.pluginManagerSetPluginEnabled) {
            throw new Error('插件启停 API 不可用');
        }

        const result = await api.pluginManagerSetPluginEnabled({
            folderName,
            enabled: targetEnabled
        });

        if (!result?.success) {
            throw new Error(result?.error || '切换失败');
        }

        const restartNote = result.restartRequired ? '，重启后生效' : '';
        showToast(`${targetEnabled ? '插件已启用' : '插件已禁用'}${restartNote}`, 'success');
        await refreshPlugins();
        if (currentEditingPlugin?.folderName === folderName) {
            const reopened = allPlugins.find(item => item.folderName === folderName);
            if (reopened) openPluginModal(reopened.folderName);
        }
    } catch (error) {
        showToast(`切换插件状态失败：${error.message}`, 'error');
    }
}

function toggleCurrentPlugin() {
    if (!currentEditingPlugin) return;
    return setPluginEnabled(currentEditingPlugin.folderName, !currentEditingPlugin.enabled);
}

async function openPluginFolder(folderName) {
    try {
        if (!api?.pluginManagerOpenPluginFolder) {
            throw new Error('打开目录 API 不可用');
        }

        const result = await api.pluginManagerOpenPluginFolder({ folderName });

        if (!result?.success) {
            throw new Error(result?.error || '打开失败');
        }
    } catch (error) {
        showToast(`打开插件目录失败：${error.message}`, 'error');
    }
}

function openCurrentPluginFolder() {
    if (!currentEditingPlugin) return;
    return openPluginFolder(currentEditingPlugin.folderName);
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
