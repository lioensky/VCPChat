'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const PROJECT_ROOT = path.resolve(__dirname, '../..');

function isApplicationPageUrl(raw, pages = ['main.html'], projectRoot = PROJECT_ROOT) {
    try {
        const url = new URL(raw);
        if (url.protocol !== 'file:') return false;
        const normalize = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
        const actual = normalize(fileURLToPath(url));
        return pages.some(page => actual === normalize(path.join(projectRoot, page)));
    } catch { return false; }
}

function createApplicationSenderGuard({ pages = ['main.html'], projectRoot = PROJECT_ROOT, getWebContents = null, getMainWebContents = null } = {}) {
    return event => {
        try {
            const sender = event?.sender;
            const frame = event?.senderFrame;
            // 文件名后缀和 frame 自报 URL 都不能证明权限：必须是应用页面的真实顶层窗口。
            if (!sender || sender.isDestroyed() || !frame || frame !== sender.mainFrame || frame.detached) return false;
            if (sender.getType() !== 'window') return false;
            if (getWebContents && sender !== getWebContents()) return false;
            if (getMainWebContents && isApplicationPageUrl(frame.url, ['main.html'], projectRoot)) {
                const main = getMainWebContents();
                if (main && sender !== main) return false;
            }
            return isApplicationPageUrl(frame.url, pages, projectRoot) && isApplicationPageUrl(sender.getURL(), pages, projectRoot);
        } catch { return false; }
    };
}

module.exports = { isApplicationPageUrl, createApplicationSenderGuard };
