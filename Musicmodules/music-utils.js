// Musicmodules/music-utils.js
// 通用辅助函数，挂载到 app 上下文

function setupUtils(app) {
    app.formatTime = (seconds) => {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    };

    app.normalizePathForCompare = (inputPath) => {
        if (!inputPath) return null;
        let normalized = inputPath.replace(/\\/g, '/');
        if (normalized.startsWith('//?/')) {
            normalized = normalized.substring(4);
        }
        return normalized;
    };

    app.hexToRgb = (hex) => {
        if (!hex) return null;
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    };
}
