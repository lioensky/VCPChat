// Agenttaskmodules/task.js

const api = window.utilityAPI || window.electronAPI;

// ========== Global State ==========
let apiAuthHeader = null;
let serverBaseUrl = '';

// ========== DOM Elements ==========
const apiStatus = document.getElementById('api-status');

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

        await initializeApi();
    } catch (e) {
        console.error('[Task] Initialization error:', e);
    }
});

async function initializeApi() {
    try {
        apiStatus.textContent = '正在获取服务器配置...';
        
        const settings = await api.loadSettings();
        if (!settings?.vcpServerUrl) {
            apiStatus.textContent = '❌ 未配置 VCP 服务器 URL';
            apiStatus.className = 'api-status-badge error';
            return;
        }

        serverBaseUrl = settings.vcpServerUrl.replace(/\/v1\/chat\/completions\/?$/, '');
        if (!serverBaseUrl.endsWith('/')) serverBaseUrl += '/';
        
        // Use the API Key as auth if provided, or reuse user/pass logic if needed
        if (settings.vcpApiKey) {
            apiAuthHeader = `Bearer ${settings.vcpApiKey}`;
            apiStatus.textContent = '✅ API 已连接 (Key Mode)';
            apiStatus.className = 'api-status-badge success';
        } else {
            apiStatus.textContent = '⚠️ 未配置 API Key';
            apiStatus.className = 'api-status-badge warning';
        }
        
    } catch (error) {
        apiStatus.textContent = '❌ API 初始化失败: ' + error.message;
        apiStatus.className = 'api-status-badge error';
    }
}
