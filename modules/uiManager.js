/**
 * uiManager.js
 * 
 * Manages general UI functionalities like the title bar, resizers, theme, and clock.
 */
const uiManager = (() => {
    // --- Private Variables ---
    let globalSettingsRef = { get: () => ({}) }; // Reference to global settings
    let electronAPI = null;

    // DOM Elements (will be initialized in init)
    let leftSidebar, rightNotificationsSidebar, resizerLeft, resizerRight;
    let minimizeBtn, maximizeBtn, restoreBtn, closeBtn, settingsBtn;
    let themeToggleBtn;
    let digitalClockElement, dateDisplayElement, notificationTitleElement;
    let sidebarTabButtons, sidebarTabContents;


    // --- Private Functions ---

    /**
     * Sets up the custom title bar controls (minimize, maximize, close).
     */
    function setupTitleBarControls() {
        if (minimizeBtn) minimizeBtn.addEventListener('click', () => electronAPI.minimizeWindow());
        if (maximizeBtn) maximizeBtn.addEventListener('click', () => electronAPI.maximizeWindow());
        if (restoreBtn) restoreBtn.addEventListener('click', () => electronAPI.unmaximizeWindow());
        if (closeBtn) closeBtn.addEventListener('click', () => electronAPI.closeWindow());
        // if (settingsBtn) settingsBtn.addEventListener('click', () => electronAPI.openDevTools()); // This is now handled by the theme module

        if (electronAPI && typeof electronAPI.onWindowMaximized === 'function') {
            electronAPI.onWindowMaximized(() => {
                if (maximizeBtn) maximizeBtn.style.display = 'none';
                if (restoreBtn) restoreBtn.style.display = 'flex';
            });
        }
        if (electronAPI && typeof electronAPI.onWindowUnmaximized === 'function') {
            electronAPI.onWindowUnmaximized(() => {
                if (maximizeBtn) maximizeBtn.style.display = 'flex';
                if (restoreBtn) restoreBtn.style.display = 'none';
            });
        }
    }

    /**
     * Initializes the resizable sidebars.
     */
    function initializeResizers() {
        let isResizingLeft = false;
        let isResizingRight = false;
        let startX = 0;

        if (resizerLeft && leftSidebar) {
            resizerLeft.addEventListener('mousedown', (e) => {
                isResizingLeft = true;
                startX = e.clientX;
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                if (leftSidebar) leftSidebar.style.transition = 'none';
            });
        }

        if (resizerRight && rightNotificationsSidebar) {
            resizerRight.addEventListener('mousedown', (e) => {
                if (!rightNotificationsSidebar.classList.contains('active')) {
                    electronAPI.sendToggleNotificationsSidebar();
                    requestAnimationFrame(() => {
                        isResizingRight = true;
                        startX = e.clientX;
                        document.body.style.cursor = 'col-resize';
                        document.body.style.userSelect = 'none';
                        rightNotificationsSidebar.style.transition = 'none';
                    });
                } else {
                    isResizingRight = true;
                    startX = e.clientX;
                    document.body.style.cursor = 'col-resize';
                    document.body.style.userSelect = 'none';
                    rightNotificationsSidebar.style.transition = 'none';
                }
            });
        }

        document.addEventListener('mousemove', (e) => {
            if (isResizingLeft && leftSidebar) {
                const deltaX = e.clientX - startX;
                const currentWidth = leftSidebar.offsetWidth;
                let newWidth = currentWidth + deltaX;
                newWidth = Math.max(parseInt(getComputedStyle(leftSidebar).minWidth, 10) || 180, Math.min(newWidth, parseInt(getComputedStyle(leftSidebar).maxWidth, 10) || 600));
                leftSidebar.style.width = `${newWidth}px`;
                startX = e.clientX;
            }
            if (isResizingRight && rightNotificationsSidebar && rightNotificationsSidebar.classList.contains('active')) {
                const deltaX = e.clientX - startX;
                const currentWidth = rightNotificationsSidebar.offsetWidth;
                let newWidth = currentWidth - deltaX;
                newWidth = Math.max(parseInt(getComputedStyle(rightNotificationsSidebar).minWidth, 10) || 220, Math.min(newWidth, parseInt(getComputedStyle(rightNotificationsSidebar).maxWidth, 10) || 600));
                rightNotificationsSidebar.style.width = `${newWidth}px`;
                startX = e.clientX;
            }
        });

        document.addEventListener('mouseup', async () => {
            let settingsChanged = false;
            const currentSettings = globalSettingsRef.get();

            if (isResizingLeft && leftSidebar) {
                leftSidebar.style.transition = '';
                const newSidebarWidth = leftSidebar.offsetWidth;
                if (currentSettings.sidebarWidth !== newSidebarWidth) {
                    currentSettings.sidebarWidth = newSidebarWidth;
                    settingsChanged = true;
                }
            }
            if (isResizingRight && rightNotificationsSidebar && rightNotificationsSidebar.classList.contains('active')) {
                rightNotificationsSidebar.style.transition = '';
                const newNotificationsWidth = rightNotificationsSidebar.offsetWidth;
                if (currentSettings.notificationsSidebarWidth !== newNotificationsWidth) {
                    currentSettings.notificationsSidebarWidth = newNotificationsWidth;
                    settingsChanged = true;
                }
            }

            isResizingLeft = false;
            isResizingRight = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';

            if (settingsChanged) {
                try {
                    await electronAPI.saveSettings(currentSettings);
                    console.log('Sidebar widths saved to settings.');
                } catch (error) {
                    console.error('Failed to save sidebar widths:', error);
                }
            }
        });
    }

    /**
     * Applies the specified theme (light/dark) to the document body and updates the toggle button.
     * @param {string} theme - The theme to apply ('light' or 'dark').
     */
    function applyTheme(theme) {
        if (!theme || (theme !== 'light' && theme !== 'dark')) {
            console.warn(`[UIManager] Invalid theme specified: ${theme}. Defaulting to system or light.`);
            // As a fallback, we'll default to light, but the initial theme should come from the main process.
            theme = 'light';
        }
        
        // Apply class to body for CSS styling
        document.body.classList.remove('light-theme', 'dark-theme');
        document.body.classList.add(`${theme}-theme`);

        // Update the toggle button icon
        if (themeToggleBtn) {
            const themeIcon = themeToggleBtn.querySelector('i');
            if (themeIcon) {
                // Assuming sun for light theme, moon for dark theme
                themeIcon.className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
            }
        }
        console.log(`[UIManager] Theme applied: ${theme}`);
    }

    /**
     * Initializes theme handling by getting the current theme and listening for updates.
     */
    async function initializeTheme() {
        // Listen for theme updates broadcast from the main process
        if (electronAPI && electronAPI.onThemeUpdated) {
            electronAPI.onThemeUpdated((theme) => {
                const themeName = typeof theme === 'object' && theme !== null ? theme.theme : theme;
                if (themeName) {
                    applyTheme(themeName);
                }
            });
        }

        // Apply the initial theme based on the settings loaded in the renderer process.
        // This ensures the UI matches the settings file immediately on load.
        const settings = globalSettingsRef.get();
        if (settings && settings.currentThemeMode && electronAPI.setTheme) {
            console.log(`[UIManager] Applying initial theme from settings: ${settings.currentThemeMode}`);
            // We tell the main process to set the theme. The onThemeUpdated listener
            // above will then catch the broadcast and call applyTheme(), ensuring a single
            // consistent flow for all theme changes.
            electronAPI.setTheme(settings.currentThemeMode);
        } else {
            // Fallback if the setting is not present for some reason.
            console.warn('[UIManager] currentThemeMode not found in settings, falling back to requesting from main process.');
            if (electronAPI && electronAPI.getCurrentTheme) {
                try {
                    const currentTheme = await electronAPI.getCurrentTheme();
                    applyTheme(currentTheme);
                } catch (error) {
                    console.error('[UIManager] Fallback failed to get initial theme:', error);
                    applyTheme('light'); // Final fallback
                }
            }
        }
    }

    /**
     * Updates the digital clock and date display.
     */
    function updateDateTimeDisplay() {
        const now = new Date();
        if (digitalClockElement) {
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            if (!digitalClockElement.querySelector('.colon')) {
                digitalClockElement.innerHTML = `<span class="hours">${hours}</span><span class="colon">:</span><span class="minutes">${minutes}</span>`;
            } else {
                const hoursSpan = digitalClockElement.querySelector('.hours');
                const minutesSpan = digitalClockElement.querySelector('.minutes');
                if (hoursSpan) hoursSpan.textContent = hours;
                if (minutesSpan) minutesSpan.textContent = minutes;
            }
        }
        if (dateDisplayElement) {
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const dayOfWeek = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
            dateDisplayElement.textContent = `${month}-${day} ${dayOfWeek}`;
        }
    }

    /**
     * Initializes the digital clock display.
     */
    function initializeDigitalClock() {
        if (digitalClockElement && notificationTitleElement && dateDisplayElement) {
            notificationTitleElement.style.display = 'none';
            updateDateTimeDisplay();
            // 每分钟更新一次时间显示，减少不必要的每秒刷新
            setInterval(updateDateTimeDisplay, 60000);
        } else {
            console.error('Digital clock, notification title, or date display element not found.');
        }
    }

    /**
     * Sets up the sidebar tabs functionality.
     */
    function setupSidebarTabs() {
        if (sidebarTabButtons) {
            const tabIdsByName = {
                agents: 'sidebarTabAgents',
                topics: 'sidebarTabTopics',
                settings: 'sidebarTabSettings'
            };

            sidebarTabButtons.forEach(button => {
                const targetTab = button.dataset.tab;
                const panelId = `tabContent${targetTab.charAt(0).toUpperCase() + targetTab.slice(1)}`;
                const tabId = tabIdsByName[targetTab] || `sidebarTab${targetTab.charAt(0).toUpperCase() + targetTab.slice(1)}`;

                button.id = button.id || tabId;
                button.setAttribute('role', 'tab');
                button.setAttribute('aria-controls', panelId);

                const panel = document.getElementById(panelId);
                if (panel) {
                    panel.setAttribute('aria-labelledby', button.id);
                }
                // 左键点击 - 切换标签
                button.addEventListener('click', () => {
                    switchToTab(button.dataset.tab);
                });

                button.addEventListener('keydown', (e) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;

                    e.preventDefault();

                    const buttons = Array.from(sidebarTabButtons);
                    const currentIndex = buttons.indexOf(button);
                    let nextIndex = currentIndex;

                    if (e.key === 'ArrowRight') {
                        nextIndex = (currentIndex + 1) % buttons.length;
                    } else if (e.key === 'ArrowLeft') {
                        nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
                    } else if (e.key === 'Home') {
                        nextIndex = 0;
                    } else if (e.key === 'End') {
                        nextIndex = buttons.length - 1;
                    }

                    const nextButton = buttons[nextIndex];
                    if (!nextButton) return;

                    switchToTab(nextButton.dataset.tab);
                    nextButton.focus();
                });
                
                // 中键点击 - 如果是设置标签，直接打开全局设置
                button.addEventListener('mousedown', (e) => {
                    if (e.button === 1 && button.dataset.tab === 'settings') {
                        e.preventDefault();
                        e.stopPropagation();
                        
                        // 打开全局设置模态框
                        if (window.uiHelperFunctions && window.uiHelperFunctions.openModal) {
                            console.log('[UIManager] Middle click on settings tab - opening global settings modal');
                            window.uiHelperFunctions.openModal('globalSettingsModal');
                        } else {
                            console.warn('[UIManager] uiHelperFunctions.openModal not available');
                        }
                    }
                });
            });
            // Default to 'agents' tab (or your preferred default)
            switchToTab('agents');
        }
    }

    /**
     * Switches to the specified tab.
     * @param {string} targetTab - The tab to switch to.
     */
    function switchToTab(targetTab) {
        if (sidebarTabButtons) {
            sidebarTabButtons.forEach(btn => {
                const isActive = btn.dataset.tab === targetTab;
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
                btn.tabIndex = isActive ? 0 : -1;
            });
        }
        if (sidebarTabContents) {
            sidebarTabContents.forEach(content => {
                const isActive = content.id === `tabContent${targetTab.charAt(0).toUpperCase() + targetTab.slice(1)}`;
                content.classList.toggle('active', isActive);
                content.setAttribute('aria-hidden', isActive ? 'false' : 'true');
                if (isActive) {
                    if (targetTab === 'topics') {
                        if (window.topicListManager) {
                            window.topicListManager.loadTopicList(); // This might create/re-render the topic list and search input
                            window.topicListManager.setupTopicSearch(); // Explicitly set up search listeners after the tab is active and list loaded
                        }
                        // 刷新计数
                        refreshUnreadCounts();
                    } else if (targetTab === 'settings') {
                        if (window.settingsManager) {
                            // 检查是否有待刷新的 Agent
                            const pendingAgentId = sessionStorage.getItem('pendingAgentReload');
                            if (pendingAgentId) {
                                console.log('[UIManager] Detected pending agent reload, reloading:', pendingAgentId);
                                sessionStorage.removeItem('pendingAgentReload');
                                // 延迟执行以确保标签页切换完成
                                setTimeout(() => {
                                    if (window.settingsManager && typeof window.settingsManager.reloadAgentSettings === 'function') {
                                        window.settingsManager.reloadAgentSettings(pendingAgentId);
                                    }
                                }, 50);
                            } else {
                                window.settingsManager.displaySettingsForItem();
                            }
                        }
                    } else if (targetTab === 'agents') { // Assuming 'agents' is the ID for the items list tab content
                        // 重置鼠标事件状态，确保双击功能正常工作
                        if (window.itemListManager && typeof window.itemListManager.resetMouseEventStates === 'function') {
                            window.itemListManager.resetMouseEventStates();
                        }
                        // 刷新计数
                        refreshUnreadCounts();
                        // The items list (agents & groups) is always visible in a way,
                        // but this ensures other tab contents are hidden.
                        // loadItems() is usually called on init or after create/delete.
                    }
                }
            });
        }
    }

    /**
     * 刷新未读计数
     */
    async function refreshUnreadCounts() {
        try {
            const result = await electronAPI.getUnreadTopicCounts();
            if (result && result.success) {
                if (window.itemListManager && typeof window.itemListManager.updateUnreadBadges === 'function') {
                    window.itemListManager.updateUnreadBadges(result.counts);
                }
            }
        } catch (error) {
            console.error('[UIManager][refreshUnreadCounts] Error:', error);
        }
    }


    // --- Public API ---
    return {
        init: async (options) => {
            electronAPI = options.electronAPI;
            globalSettingsRef = options.refs.globalSettingsRef;

            // Assign DOM elements from options.elements
            leftSidebar = options.elements.leftSidebar;
            rightNotificationsSidebar = options.elements.rightNotificationsSidebar;
            resizerLeft = options.elements.resizerLeft;
            resizerRight = options.elements.resizerRight;
            minimizeBtn = options.elements.minimizeBtn;
            maximizeBtn = options.elements.maximizeBtn;
            restoreBtn = options.elements.restoreBtn;
            closeBtn = options.elements.closeBtn;
            settingsBtn = options.elements.settingsBtn;
            themeToggleBtn = options.elements.themeToggleBtn;
            digitalClockElement = options.elements.digitalClockElement;
            dateDisplayElement = options.elements.dateDisplayElement;
            notificationTitleElement = options.elements.notificationTitleElement;
            sidebarTabButtons = options.elements.sidebarTabButtons;
            sidebarTabContents = options.elements.sidebarTabContents;

            // Initialize all features
            setupTitleBarControls();
            initializeResizers();
            await initializeTheme(); // Replaces loadAndApplyThemePreference
            initializeDigitalClock();
            setupSidebarTabs();

            // Setup theme toggle button listener
            if (themeToggleBtn) {
                themeToggleBtn.addEventListener('click', () => {
                    // Determine the new theme based on the current one
                    const isCurrentlyDark = document.body.classList.contains('dark-theme');
                    const newTheme = isCurrentlyDark ? 'light' : 'dark';
                    
                    // Just tell the main process to set the theme.
                    // The UI update will happen automatically when we receive the 'theme-updated' event.
                    electronAPI.setTheme(newTheme);
                });
            }

            console.log('uiManager initialized.');
        },
        applyTheme: applyTheme, // Expose applyTheme if needed externally
        switchToTab: switchToTab // Expose switchToTab for external use
    };
})();

// Expose to window
window.uiManager = uiManager;
