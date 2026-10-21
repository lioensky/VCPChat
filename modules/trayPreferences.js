// modules/trayPreferences.js
//
// 托盘关闭行为偏好的读取入口。
//
// 关主窗口时是「最小化到托盘」还是「真正退出」，由 AppData/tray-settings.json
// 的 closeToTray 决定（缺省 true）。每次判断都重新读盘：用户在设置面板里改完
// 立刻生效，不需要重启。
//
// 这里刻意用同步读 —— 主窗口 close 事件是同步路径，不能等 Promise。

const fs = require('fs');
const path = require('path');

const TRAY_SETTINGS_FILENAME = 'tray-settings.json';

let appDataRoot = null;

/**
 * 由主进程在解析出 AppData 实际路径后调用一次（兼容 VCPCHAT_APP_DATA_DIR 隔离目录）。
 * @param {{ appDataRoot?: string }} options
 */
function configure(options = {}) {
    if (typeof options.appDataRoot === 'string' && options.appDataRoot.trim()) {
        appDataRoot = options.appDataRoot.trim();
    }
}

function getSettingsPath() {
    return appDataRoot ? path.join(appDataRoot, TRAY_SETTINGS_FILENAME) : null;
}

/**
 * 读取 closeToTray 偏好。
 * 设置文件缺失、内容损坏、字段类型不对，都回退到 fallback，不打断关闭流程。
 * @param {boolean} [fallback=true]
 * @returns {boolean}
 */
function readCloseToTray(fallback = true) {
    const settingsPath = getSettingsPath();
    if (!settingsPath) return fallback;

    try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (parsed && typeof parsed.closeToTray === 'boolean') {
            return parsed.closeToTray;
        }
    } catch (error) {
        // 文件不存在 / JSON 损坏：走默认值
    }
    return fallback;
}

module.exports = { configure, readCloseToTray, getSettingsPath };
