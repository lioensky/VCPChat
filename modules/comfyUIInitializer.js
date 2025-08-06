// ComfyUI Initializer Module
(function() {
    'use strict';

    // ComfyUI initialization and button handler
    async function initializeComfyUI() {
        console.log('[ComfyUI Initializer] Starting initialization...');
        
        // Get the button element
        const openComfyUIConfigBtn = document.getElementById('openComfyUIConfigBtn');
        if (!openComfyUIConfigBtn) {
            console.error('[ComfyUI Initializer] Button #openComfyUIConfigBtn not found!');
            return;
        }

        // Function to dynamically load CSS
        function loadComfyUIStyles() {
            return new Promise((resolve, reject) => {
                const cssPath = './ComfyUImodules/comfyui.css';
                // Check if the stylesheet is already loaded
                if (document.querySelector(`link[href="${cssPath}"]`)) {
                    resolve();
                    return;
                }
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = cssPath;
                link.onload = resolve;
                link.onerror = () => reject(new Error(`Failed to load ${cssPath}`));
                document.head.appendChild(link);
            });
        }

        // Function to dynamically load a script module once
        function loadScript(src) {
            return new Promise((resolve, reject) => {
                if (document.querySelector(`script[src="${src}"]`)) {
                    resolve();
                    return;
                }
                const script = document.createElement('script');
                script.src = src;
                script.type = 'text/javascript';
                script.async = true;
                script.onload = resolve;
                script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
                document.head.appendChild(script);
            });
        }

        // Add click event listener
        openComfyUIConfigBtn.addEventListener('click', async () => {
            console.log('[ComfyUI Initializer] Button clicked, initializing ComfyUI...');
            
            try {
                // Step 1: Load CSS and config script on demand
                await loadComfyUIStyles();
                await loadScript('./ComfyUImodules/comfyUIConfig.js');
                console.log('[ComfyUI Initializer] Resources loaded successfully');

                // Step 2: Ensure ComfyUI handlers are ready in main process
                if (window.electronAPI && window.electronAPI.ensureComfyUIHandlersReady) {
                    const handlerResult = await window.electronAPI.ensureComfyUIHandlersReady();
                    if (!handlerResult.success) {
                        console.error('[ComfyUI Initializer] Failed to initialize handlers:', handlerResult.error);
                        if (window.uiHelperFunctions && window.uiHelperFunctions.showToastNotification) {
                            window.uiHelperFunctions.showToastNotification('ComfyUI 初始化失败: ' + handlerResult.error, 'error');
                        }
                        return;
                    }
                    console.log('[ComfyUI Initializer] Handlers initialized successfully');
                }

                // Step 3: Ensure ComfyUI API is available
                if (!window.comfyUI) {
                    console.error('[ComfyUI Initializer] window.comfyUI API not found!');
                    if (window.uiHelperFunctions && window.uiHelperFunctions.showToastNotification) {
                        window.uiHelperFunctions.showToastNotification('ComfyUI API 未加载', 'error');
                    }
                    return;
                }

                // Step 4: Create UI using the new API into Drawer host
                const overlay = document.getElementById('comfyuiDrawerOverlay');
                const panel = document.getElementById('comfyuiDrawerPanel');
                const content = document.getElementById('comfyuiDrawerContent');

                if (!overlay || !panel || !content) {
                    console.error('[ComfyUI Initializer] Drawer host not found! Check main.html injection.');
                    return;
                }
                // 防重复打开
                if (panel.classList.contains('open')) {
                    console.log('[ComfyUI Initializer] Drawer already open');
                    return;
                }

                // Ensure clean content
                content.innerHTML = '';

                const openDrawer = () => {
                    // Make overlay visible before removing hidden for transition
                    overlay.style.display = 'block';
                    requestAnimationFrame(() => {
                        overlay.classList.remove('hidden');
                        overlay.style.opacity = '1';
                        panel.classList.add('open');
                    });
                };

                const closeDrawer = () => {
                    // animate out
                    overlay.classList.add('hidden');
                    overlay.style.opacity = '0';
                    panel.classList.remove('open');
                    // after transition, fully hide overlay to avoid click capture
                    setTimeout(() => {
                        overlay.style.display = 'none';
                    }, 220);
                };

                // Bind overlay click to close
                overlay.onclick = () => {
                    if (window.comfyUI && window.comfyUI.destroyUI) {
                        try { window.comfyUI.destroyUI(); } catch(e) { /* no-op */ }
                    }
                    closeDrawer();
                };

                // Create UI in drawer content
                await window.comfyUI.createUI(content, {
                    onClose: () => {
                        closeDrawer();
                    }
                });

                // Open drawer
                openDrawer();
                console.log('[ComfyUI Initializer] Drawer opened');

            } catch (error) {
                console.error('[ComfyUI Initializer] Error during initialization:', error);
                if (window.uiHelperFunctions && window.uiHelperFunctions.showToastNotification) {
                    window.uiHelperFunctions.showToastNotification('打开 ComfyUI 配置失败: ' + error.message, 'error');
                }
            }
        });

        console.log('[ComfyUI Initializer] Button event listener attached');
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeComfyUI);
    } else {
        // DOM is already loaded
        initializeComfyUI();
    }

    // Export for debugging
    window.comfyUIInitializer = {
        initialize: initializeComfyUI
    };
})();