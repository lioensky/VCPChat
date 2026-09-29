'use strict';

// 提示词：全局提示词仓库、预设提示词、当前生效的系统提示、正则规则导入。
// 主进程：modules/ipc/promptHandlers.js、modules/ipc/regexHandlers.js
const { invoke } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/promptHandlers.js', 'modules/ipc/regexHandlers.js'],
    roles: ['chat'],
    api: {
        getGlobalWarehouse: invoke('get-global-warehouse'),
        saveGlobalWarehouse: invoke('save-global-warehouse', 'data'),
        loadPresetPrompts: invoke('load-preset-prompts', 'presetPath'),
        loadPresetContent: invoke('load-preset-content', 'filePath'),
        selectDirectory: invoke('select-directory'),
        getActiveSystemPrompt: invoke('get-active-system-prompt', 'agentId'),
        importRegexRules: invoke('import-regex-rules', 'agentId'),
    },
};