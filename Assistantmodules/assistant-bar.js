// Assistantmodules/assistant-bar.js

document.addEventListener('DOMContentLoaded', () => {
    const assistantAvatar = document.getElementById('assistantAvatar');
    const buttons = document.querySelectorAll('.assistant-button');
    let closeOnLeaveTimer = null;

    // 1. 主动从主进程获取初始数据
    const initialize = async () => {
        try {
            const data = await window.electronAPI.getAssistantBarInitialData();
            console.log('Assistant bar received initial data on request:', data);
            if (data && data.agentAvatarUrl) {
                assistantAvatar.src = data.agentAvatarUrl;
            }
            if (data && data.theme) {
                // 应用主题
                document.body.classList.toggle('light-theme', data.theme === 'light');
                document.body.classList.toggle('dark-theme', data.theme === 'dark');
            }
        } catch (error) {
            console.error('Failed to get initial data for assistant bar:', error);
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
        document.body.classList.toggle('light-theme', data.theme === 'light');
        document.body.classList.toggle('dark-theme', data.theme === 'dark');
    });

    // Listen for theme updates from the main process
    window.electronAPI.onThemeUpdated((theme) => {
        console.log(`[Assistant Bar] Theme updated to: ${theme}`);
        document.body.classList.toggle('light-theme', theme === 'light');
        document.body.classList.toggle('dark-theme', theme !== 'light');
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

    // 当鼠标离开窗口时，延迟关闭，避免快速划词时的误触发闪烁
    document.body.addEventListener('mouseleave', () => {
        if (closeOnLeaveTimer) {
            clearTimeout(closeOnLeaveTimer);
        }
        closeOnLeaveTimer = setTimeout(() => {
            window.electronAPI.closeAssistantBar();
            closeOnLeaveTimer = null;
        }, 180);
    });

    document.body.addEventListener('mouseenter', () => {
        if (closeOnLeaveTimer) {
            clearTimeout(closeOnLeaveTimer);
            closeOnLeaveTimer = null;
        }
    });
});