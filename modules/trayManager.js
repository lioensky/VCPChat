/**
 * TrayManager - VChat 主界面右下角应用托盘管理器
 * 负责：
 *  1. 渲染底部 4 个常用应用按钮
 *  2. 渲染点击 "更多" 后出现的抽屉，包含所有系统级 App
 *  3. 提供设置界面，允许用户自定义优先显示的 4 个应用
 *  4. 持久化用户选择
 */

'use strict';

const trayManager = (function () {
    const desktopApi = window.chatAPI || window.electronAPI;

    // 常用应用 ID 列表（默认 4 个）
    let pinnedAppIds = ['vchat-app-translator', 'vchat-app-notes', 'vchat-app-music', 'vchat-app-canvas'];

    // VChat 系统应用注册表 (从 vchatApps.js 复制的核心定义)
    const VCHAT_APPS = [
        { id: 'vchat-app-notes', name: '笔记', icon: 'notes', action: 'open-notes-window' },
        { id: 'vchat-app-translator', name: '翻译', icon: 'translator', action: 'open-translator-window' },
        { id: 'vchat-app-music', name: '音乐', icon: 'music', action: 'open-music-window' },
        { id: 'vchat-app-canvas', name: '协同', icon: 'canvas', action: 'open-canvas-window' },
        { id: 'vchat-app-main', name: 'VChat', icon: 'chat', action: 'show-main-window' },
        { id: 'vchat-app-memo', name: '记忆', icon: 'memo', action: 'open-memo-window' },
        { id: 'vchat-app-forum', name: '论坛', icon: 'forum', action: 'open-forum-window' },
        { id: 'vchat-app-dice', name: '骰子', icon: 'dice', action: 'open-dice-window' },
        { id: 'vchat-app-rag-observer', name: '监听', icon: 'rag', action: 'open-rag-observer-window' },
        { id: 'vchat-app-themes', name: '主题', icon: 'themes', action: 'open-themes-window' },
        { id: 'vchat-app-toolbox', name: '工具箱', icon: 'toolbox', action: 'launch-human-toolbox' },
        { id: 'vchat-app-dbmanager', name: '数据', icon: 'database', action: 'launch-vchat-manager' },
        { id: 'vchat-app-task', name: '任务', icon: 'task', action: 'open-task-window' }
    ];

    // SVG 图标定义 (Lucide 风格)
    const SVG_ICONS = {
        chat: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-message-square"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
        notes: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-notebook-pen"><path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/></svg>`,
        memo: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-brain"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .52 8.208 4 4 0 0 0 6.503 2.046 4 4 0 0 0 6.503-2.046 4 4 0 0 0 .52-8.208 4 4 0 0 0-2.526-5.77A3 3 0 1 0 12 5Z"/><path d="M9 13a4.5 4.5 0 0 0 3 4"/><path d="M15 13a4.5 4.5 0 0 1-3 4"/><path d="M12 17v4"/></svg>`,
        forum: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-layout-grid"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>`,
        rag: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-activity"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`,
        dice: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-dice-5"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M8 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/><path d="M12 12h.01"/></svg>`,
        canvas: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-code-xml"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>`,
        translator: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-languages"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>`,
        music: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-list-music"><path d="M16 5H3"/><path d="M11 12H3"/><path d="M11 19H3"/><path d="M21 16V5"/><circle cx="18" cy="16" r="3"/></svg>`,
        themes: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-palette"><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.5-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H17c2.8 0 5-2.2 5-5 0-3.9-4.5-7-10-7Z"/></svg>`,
        toolbox: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-wrench"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a2 2 0 0 1 2.8 2.8l-3.7 3.7a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a2 2 0 0 1 2.8 2.8l-3.7 3.7a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a2 2 0 0 1 2.8 2.8l-3.7 3.7a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a2 2 0 0 1 2.8 2.8l-3.7 3.7a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a2 2 0 0 1 2.8 2.8l-3.7 3.7a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a2 2 0 0 1 2.8 2.8l-3.7 3.7a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a2 2 0 0 1 2.8 2.8l-3.7 3.7a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a2 2 0 0 1 2.8 2.8l-3.7 3.7a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a2 2 0 0 1 2.8 2.8l-3.7 3.7"/></svg>`,
        database: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-database"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></svg>`,
        task: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clipboard-list"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>`
    };

    /**
     * 初始化托盘
     */
    function init() {
        console.log('[TrayManager] Initializing...');
        loadSettings();
        renderPinnedApps();
        renderDrawerGrid();
        setupEventListeners();
    }

    /**
     * 加载持久化设置
     */
    function loadSettings() {
        const saved = localStorage.getItem('vcp-tray-pinned-apps');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    pinnedAppIds = parsed;
                }
            } catch (e) {
                console.warn('[TrayManager] Failed to load saved tray settings:', e);
            }
        }
    }

    /**
     * 保存设置
     */
    function saveSettings() {
        localStorage.setItem('vcp-tray-pinned-apps', JSON.stringify(pinnedAppIds));
    }

    /**
     * 渲染底部固定按钮
     */
    function renderPinnedApps() {
        const container = document.getElementById('appTrayPinnedApps');
        if (!container) return;

        container.innerHTML = '';
        pinnedAppIds.forEach(id => {
            const app = VCHAT_APPS.find(a => a.id === id);
            // 过滤掉主界面图标 (原地 TP 问题)
            if (!app || app.id === 'vchat-app-main') return;

            const btn = document.createElement('button');
            btn.className = 'header-button capsule-button';
            btn.title = app.name;
            btn.innerHTML = `
                ${SVG_ICONS[app.icon] || ''}
                <span class="notes-button-label">${app.name}</span>
            `;
            btn.onclick = () => launchApp(app);
            container.appendChild(btn);
        });
    }

    /**
     * 渲染抽屉内的所有应用
     */
    function renderDrawerGrid() {
        const grid = document.getElementById('appTrayDrawerGrid');
        if (!grid) return;

        grid.innerHTML = '';
        // 过滤逻辑：1. 去掉主界面 2. 去掉已经固定在底栏的图标
        const drawerApps = VCHAT_APPS.filter(app => 
            app.id !== 'vchat-app-main' && !pinnedAppIds.includes(app.id)
        );

        drawerApps.forEach(app => {
            const item = document.createElement('button');
            item.className = 'header-button capsule-button app-tray-drawer-item';
            item.title = app.name;
            item.innerHTML = `
                ${SVG_ICONS[app.icon] || ''}
                <span class="notes-button-label">${app.name}</span>
            `;
            item.onclick = (e) => {
                e.stopPropagation();
                launchApp(app);
                toggleDrawer(false);
            };
            grid.appendChild(item);
        });
    }

    /**
     * 启动应用
     */
    async function launchApp(app) {
        console.log(`[TrayManager] Launching app: ${app.name} (${app.action})`);
        
        // 动态获取最新的 API 引用
        const currentApi = window.chatAPI || window.electronAPI;

        if (currentApi?.desktopLaunchVchatApp) {
            try {
                const result = await currentApi.desktopLaunchVchatApp(app.action);
                if (!result?.success) {
                    console.error('[TrayManager] Launch failed:', result?.error);
                }
            } catch (err) {
                console.error('[TrayManager] IPC Error:', err);
            }
        } else {
            console.warn('[TrayManager] chatAPI.desktopLaunchVchatApp not available');
            // 回流方案：尝试直接在 window 上找
            if (window.electronAPI?.desktopLaunchVchatApp) {
                window.electronAPI.desktopLaunchVchatApp(app.action);
            }
        }
    }

    /**
     * 切换抽屉显示状态
     */
    function toggleDrawer(force) {
        const drawer = document.getElementById('appTrayDrawer');
        const btn = document.getElementById('appTrayMoreBtn');
        if (!drawer || !btn) return;

        const isActive = force !== undefined ? force : !drawer.classList.contains('active');
        
        if (isActive) {
            drawer.classList.add('active');
            btn.classList.add('active');
            // 添加一次性点击监听用于关闭
            setTimeout(() => {
                document.addEventListener('click', closeOnOutsideClick);
            }, 0);
        } else {
            drawer.classList.remove('active');
            btn.classList.remove('active');
            document.removeEventListener('click', closeOnOutsideClick);
        }
    }

    function closeOnOutsideClick(e) {
        const drawer = document.getElementById('appTrayDrawer');
        const btn = document.getElementById('appTrayMoreBtn');
        if (drawer && !drawer.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
            toggleDrawer(false);
        }
    }

    /**
     * 事件监听初始化
     */
    function setupEventListeners() {
        const moreBtn = document.getElementById('appTrayMoreBtn');
        if (moreBtn) {
            moreBtn.onclick = (e) => {
                e.stopPropagation();
                toggleDrawer();
            };
        }

        const settingsBtn = document.getElementById('appTraySettingsBtn');
        if (settingsBtn) {
            // 使用捕获阶段 (true) 确保事件优先被捕获，不被其他层拦截
            settingsBtn.addEventListener('click', (e) => {
                console.log('[TrayManager] Settings button clicked (Capture Phase)');
                e.stopPropagation();
                e.preventDefault();
                showSettingsModal();
            }, true);
        }
    }

    /**
     * 显示设置模态窗
     */
    function showSettingsModal() {
        const modalId = 'appTraySettingsModal';
        if (document.getElementById(modalId)) return;

        const modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'modal active';
        modal.style.zIndex = '20001'; 
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 400px;">
                <span class="close-button" onclick="this.closest('.modal').remove()">×</span>
                <h2 style="margin-top: 0; font-size: 1.2em;">优先显示的按钮</h2>
                <p style="font-size: 0.85em; opacity: 0.7; margin-bottom: 15px;">请选择 4 个要在底栏直接显示的应用：</p>
                <div class="settings-app-list" style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; max-height: 400px; overflow-y: auto; padding: 5px;">
                    ${VCHAT_APPS.map(app => `
                        <label class="tray-settings-item" style="display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.05); padding: 8px; border-radius: 8px; cursor: pointer;">
                            <input type="checkbox" name="tray-app" value="${app.id}" ${pinnedAppIds.includes(app.id) ? 'checked' : ''} style="width: 16px; height: 16px;">
                            <span style="font-size: 0.9em; display: flex; align-items: center; gap: 5px;">${SVG_ICONS[app.icon] || ''} ${app.name}</span>
                        </label>
                    `).join('')}
                </div>
                <div class="modal-actions" style="margin-top: 20px; display: flex; justify-content: flex-end; gap: 10px;">
                    <button class="vcp-btn" onclick="this.closest('.modal').remove()" style="background: rgba(255,255,255,0.1); color: var(--primary-text);">取消</button>
                    <button id="saveTraySettingsBtn" class="vcp-btn vcp-btn-success">保存修改</button>
                </div>
            </div>
        `;
        const container = document.getElementById('modal-container') || document.body;
        container.appendChild(modal);

        // 限制选择数量为 4
        const checkboxes = modal.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(cb => {
            cb.onchange = () => {
                const checked = modal.querySelectorAll('input[name="tray-app"]:checked');
                if (checked.length > 4) {
                    cb.checked = false;
                    if (window.uiHelperFunctions?.showToastNotification) {
                        window.uiHelperFunctions.showToastNotification('最多只能选择 4 个常用应用', 'warning');
                    } else {
                        alert('最多只能选择 4 个常用应用');
                    }
                }
            };
        });

        modal.querySelector('#saveTraySettingsBtn').onclick = () => {
            const checked = modal.querySelectorAll('input[name="tray-app"]:checked');
            if (checked.length === 0) {
                if (window.uiHelperFunctions?.showToastNotification) {
                    window.uiHelperFunctions.showToastNotification('请至少选择一个应用', 'warning');
                }
                return;
            }
            pinnedAppIds = Array.from(checked).map(c => c.value);
            saveSettings();
            renderPinnedApps();
            renderDrawerGrid();
            modal.remove();
            if (window.uiHelperFunctions?.showToastNotification) {
                window.uiHelperFunctions.showToastNotification('常用应用设置已保存', 'success');
            }
        };
    }

    return {
        init: init
    };
})();

// 导出到全局
window.trayManager = trayManager;
