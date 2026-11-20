'use strict';
const fs = require('node:fs');
const path = require('node:path');

// External processes cannot read Electron's ASAR virtual filesystem.
function resolveConfirmationScript(pluginDirectory) {
    const script = path.join(pluginDirectory, 'AdminConfirm.py');
    const physical = script.replace(/\.asar(?=[\\/]|$)/i, '.asar.unpacked');
    if (!fs.existsSync(physical) || !fs.statSync(physical).isFile()) {
        throw new Error('确认脚本缺失，请修复应用安装后重试。');
    }
    return physical;
}

module.exports = { resolveConfirmationScript };
