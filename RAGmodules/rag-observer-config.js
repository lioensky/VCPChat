// RAG Observer Configuration Script
// 从全局变量VCP_SETTINGS读取配置并应用主题

class RAGObserverConfig {
    constructor() {
        this.settings = null;
        this.wsConnection = null;
        this.logConnection = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 3000; // 3秒
        this.isConnecting = false;
        this.logReconnectAttempts = 0;
        this.maxLogReconnectAttempts = 10;
        this.logReconnectDelay = 3000;
        this.isLogConnecting = false;
    }

    // 从URL查询参数读取settings
    loadSettings() {
        const params = new URLSearchParams(window.location.search);
        const settings = {
            vcpLogUrl: params.get('vcpLogUrl') || 'ws://127.0.0.1:5890',
            vcpLogKey: params.get('vcpLogKey') || ''
        };
        this.settings = settings;
        console.log('Loaded settings from URL:', this.settings);
        return this.settings;
    }

    // 应用主题
    applyTheme(themeMode) {
        const body = document.body;
        if (themeMode === 'light') {
            body.classList.add('light-theme');
        } else {
            body.classList.remove('light-theme');
        }
    }

    // 自动连接WebSocket
    autoConnect(isReconnect = false) {
        if (this.isConnecting) return;
        this.isConnecting = true;

        const settings = this.loadSettings();
        
        // Theme is now handled by the async DOMContentLoaded listener.
        
        // 获取连接信息
        const wsUrl = settings.vcpLogUrl || 'ws://127.0.0.1:5890';
        const vcpKey = settings.vcpLogKey || '';

        if (!vcpKey) {
            console.warn('警告: VCP Key 未设置');
            updateStatus('error', '配置错误：VCP Key 未设置');
            this.isConnecting = false;
            return;
        }

        // 连接WebSocket
        const wsUrlInfo = `${wsUrl}/vcpinfo/VCP_Key=${vcpKey}`;
        
        if (!isReconnect) {
            updateStatus('connecting', `连接中: ${wsUrl}`);
        } else {
            updateStatus('connecting', `重连中 (${this.reconnectAttempts}/${this.maxReconnectAttempts}): ${wsUrl}`);
        }

        this.wsConnection = new WebSocket(wsUrlInfo);
        
        this.wsConnection.onopen = (event) => {
            console.log('WebSocket 连接已建立:', event);
            updateStatus('open', 'VCPInfo 已连接！');
            this.reconnectAttempts = 0; // 连接成功，重置重连计数
            this.isConnecting = false;
        };

        this.wsConnection.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                console.log('DEBUG: [RAG Observer] Received WebSocket Data:', data);
                
                // 检查是否为RAG、元思考链或Agent私聊预览的详细信息
                if (data.type === 'RAG_RETRIEVAL_DETAILS' || data.type === 'META_THINKING_CHAIN' || data.type === 'AGENT_PRIVATE_CHAT_PREVIEW' || data.type === 'AI_MEMO_RETRIEVAL') {
                    if (window.startSpectrumAnimation) {
                        window.startSpectrumAnimation(3000); // 动画持续3秒
                    }
                    displayRagInfo(data); // displayRagInfo内部会处理这两种类型
                }
            } catch (e) {
                console.error('解析消息失败:', e);
            }
        };

        this.wsConnection.onclose = (event) => {
            this.isConnecting = false;
            console.log('WebSocket 连接已关闭:', event);
            updateStatus('closed', '连接已断开。尝试重连...');
            this.reconnect(); // 尝试重连
        };

        this.wsConnection.onerror = (error) => {
            this.isConnecting = false;
            console.error('WebSocket 错误:', error);
            // 错误处理：在 onclose 中处理重连，这里只更新状态
            updateStatus('error', '连接发生错误！请检查服务器或配置。');
        };

        this.connectVcpLog(wsUrl, vcpKey);
    }

    connectVcpLog(wsUrl, vcpKey, isReconnect = false) {
        if (this.isLogConnecting) return;
        this.isLogConnecting = true;

        if (!wsUrl || !vcpKey) {
            this.isLogConnecting = false;
            return;
        }

        const wsUrlLog = `${wsUrl}/VCPlog/VCP_Key=${vcpKey}`;
        this.logConnection = new WebSocket(wsUrlLog);

        this.logConnection.onopen = () => {
            this.logReconnectAttempts = 0;
            this.isLogConnecting = false;
        };

        this.logConnection.onmessage = (event) => {
            const rawMessage = typeof event.data === 'string' ? event.data : String(event.data);
            let data = rawMessage;
            try {
                data = JSON.parse(rawMessage);
            } catch (e) {
            }
            if (typeof displayNotification === 'function') {
                displayNotification(data, rawMessage);
            }
        };

        this.logConnection.onclose = () => {
            this.isLogConnecting = false;
            this.reconnectLog(wsUrl, vcpKey);
        };

        this.logConnection.onerror = () => {
            this.isLogConnecting = false;
        };
    }

    // 尝试重新连接
    reconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`尝试在 ${this.reconnectDelay / 1000} 秒后重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => {
                this.autoConnect(true);
            }, this.reconnectDelay);
        } else {
            updateStatus('error', '连接失败，已达到最大重连次数。请检查配置或服务器状态。');
            console.error('已达到最大重连次数，停止重连。');
        }
    }

    reconnectLog(wsUrl, vcpKey) {
        if (this.logReconnectAttempts < this.maxLogReconnectAttempts) {
            this.logReconnectAttempts++;
            setTimeout(() => {
                this.connectVcpLog(wsUrl, vcpKey, true);
            }, this.logReconnectDelay);
        }
    }

    // watchSettings is deprecated in favor of the onThemeUpdated IPC listener
    /*
    watchSettings(interval = 5000) {
        setInterval(() => {
            const newSettings = this.loadSettings();
            if (newSettings.currentThemeMode !== this.settings?.currentThemeMode) {
                this.applyTheme(newSettings.currentThemeMode);
                this.settings = newSettings;
                console.log('主题已更新:', newSettings.currentThemeMode);
            }
        }, interval);
    }
    */
}

// 页面加载时自动初始化
window.addEventListener('DOMContentLoaded', async () => {
    const config = new RAGObserverConfig();

    // Initialize and apply theme first
    if (window.electronAPI) {
        // Listen for subsequent theme updates from the main process
        window.electronAPI.onThemeUpdated((theme) => {
            console.log(`RAG Observer: Theme updated to ${theme}`);
            config.applyTheme(theme);
        });
        
        // Get and apply the initial theme
        try {
            const theme = await window.electronAPI.getCurrentTheme();
            console.log(`RAG Observer: Initial theme set to ${theme}`);
            config.applyTheme(theme || 'dark');
        } catch (error) {
            console.error('RAG Observer: Failed to get initial theme, falling back to dark.', error);
            config.applyTheme('dark');
        }
    } else {
        // Fallback for non-electron environments if needed
        const params = new URLSearchParams(window.location.search);
        const theme = params.get('currentThemeMode') || 'dark';
        config.applyTheme(theme);
    }

    // Now connect to WebSocket
    config.autoConnect();

    // --- Platform Detection ---
    if (window.electronAPI) {
        window.electronAPI.getPlatform().then(platform => {
            // platform is 'win32', 'darwin' (macOS), or 'linux'
            if (platform === 'darwin') {
                document.body.classList.add('platform-mac');
            } else { // Default to Windows style for win32, linux, etc.
                document.body.classList.add('platform-win');
            }
        });
    } else {
        // Fallback for browser testing
        const platform = navigator.platform.toLowerCase();
        if (platform.includes('mac')) {
            document.body.classList.add('platform-mac');
        } else {
            document.body.classList.add('platform-win');
        }
    }

    // --- Custom Title Bar Listeners ---
    const minimize = () => window.electronAPI?.minimizeWindow();
    let isPinned = false;
    const togglePin = () => {
        isPinned = !isPinned;
        window.electronAPI?.setAlwaysOnTop?.(isPinned);
        const macPinBtn = document.getElementById('mac-pin-btn');
        const winPinBtn = document.getElementById('win-pin-btn');
        if (macPinBtn) macPinBtn.classList.toggle('pin-active', isPinned);
        if (winPinBtn) winPinBtn.classList.toggle('pin-active', isPinned);
    };
    const close = () => window.close();

    // Mac Controls
    document.getElementById('mac-minimize-btn').addEventListener('click', minimize);
    document.getElementById('mac-pin-btn').addEventListener('click', togglePin);
    document.getElementById('mac-close-btn').addEventListener('click', close);

    // Windows Controls
    document.getElementById('win-minimize-btn').addEventListener('click', minimize);
    document.getElementById('win-pin-btn').addEventListener('click', togglePin);
    document.getElementById('win-close-btn').addEventListener('click', close);
});
