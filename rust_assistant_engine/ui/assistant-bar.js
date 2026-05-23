// Assistantmodules/assistant-bar.js

document.addEventListener('DOMContentLoaded', () => {
    const assistantAvatar = document.getElementById('assistantAvatar');
    const buttons = document.querySelectorAll('.assistant-button');
    let closeOnLeaveTimer = null;
    let barShownAt = Date.now();
    const BAR_LEAVE_GRACE_MS = 500;
    const BAR_VISIBLE_MIN_MS = 500;

    // 应用主题函数
    const applyTheme = (theme) => {
        console.log(`[Assistant Bar] Applying theme: ${theme}`);
        if (theme === 'light') {
            document.body.classList.remove('dark-theme');
            document.body.classList.add('light-theme');
        } else {
            document.body.classList.remove('light-theme');
            document.body.classList.add('dark-theme');
        }
    };

    const markBarShown = () => {
        barShownAt = Date.now();
    };

    // 1. 主动从主进程获取初始数据
    const initialize = async () => {
        try {
            const data = await window.electronAPI.getAssistantBarInitialData();
            console.log('Assistant bar received initial data on request:', data);
            if (data && data.agentAvatarUrl) {
                assistantAvatar.src = data.agentAvatarUrl;
            }
            if (data && data.theme) {
                applyTheme(data.theme);
            }
            markBarShown();
        } catch (error) {
            console.error('Failed to get initial data for assistant bar:', error);
            // 默认使用深色主题
            applyTheme('dark');
        }
    };

    initialize(); // Call initialization function

    // 2. (可选但推荐) 保留监听，以防未来有需要动态更新 bar 的场景
    window.electronAPI.onAssistantBarData((data) => {
        console.log('Assistant bar received pushed data:', data);
        if (data.agentAvatarUrl) {
            assistantAvatar.src = data.agentAvatarUrl;
        }
        // 应用主题
        if (data.theme) {
            applyTheme(data.theme);
        }
        markBarShown();
    });

    // Listen for theme updates from the main process
    window.electronAPI.onThemeUpdated((theme) => {
        console.log(`[Assistant Bar] Theme updated to: ${theme}`);
        applyTheme(theme);
    });

    // 3. 为所有按钮添加点击事件
    buttons.forEach(button => {
        button.addEventListener('click', () => {
            const action = button.getAttribute('data-action');
            console.log(`Action button clicked: ${action}`);
            // 4. 通知主进程执行操作
            window.electronAPI.assistantAction(action);
        });
    });

    // 由主进程统一判断“是否点到 bar 外”并关闭；
    // renderer 侧不再基于 mouseleave 自动关闭，避免圈选松开鼠标后立即误关。
    document.body.addEventListener('mouseenter', () => {
        if (closeOnLeaveTimer) {
            clearTimeout(closeOnLeaveTimer);
            closeOnLeaveTimer = null;
        }
        markBarShown();
    });
});