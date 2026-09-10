// modules/ipc/regexHandlers.js
const { ipcMain, dialog } = require('electron');
const fs = require('fs-extra');

/**
 * Initializes regex management related IPC handlers.
 * @param {object} context - An object containing necessary context.
 * @param {string} context.AGENT_DIR - The path to the agents directory.
 */
function initialize(context) {

    ipcMain.handle('import-regex-rules', async (event, agentId) => {
        if (!agentId) {
            return { success: false, error: '没有提供Agent ID。' };
        }

        try {
            const { canceled, filePaths } = await dialog.showOpenDialog({
                title: '选择要导入的正则规则文件',
                filters: [{ name: 'JSON Files', extensions: ['json'] }],
                properties: ['openFile']
            });

            if (canceled || filePaths.length === 0) {
                return { success: false, error: '用户取消了文件选择。', canceled: true };
            }

            const filePath = filePaths[0];
            let importedRules;
            const importedData = await fs.readJson(filePath);

            // Check if it's SillyTavern format (single object with scriptName)
            if (importedData && typeof importedData === 'object' && !Array.isArray(importedData) && importedData.scriptName) {
                const st = importedData;
                const vcpRule = {
                    id: `rule_${Date.now()}`,
                    title: st.scriptName,
                    findPattern: st.findRegex,
                    replaceWith: st.replaceString,
                    applyToRoles: (st.placement || []).map(p => {
                        if (p === 1) return 'user';
                        if (p === 2) return 'assistant';
                        return null;
                    }).filter(Boolean),
                    applyToFrontend: st.markdownOnly !== undefined ? st.markdownOnly : true, // Default to true if undefined
                    applyToContext: st.promptOnly !== undefined ? st.promptOnly : false, // Default to false if undefined
                    minDepth: st.minDepth === null || st.minDepth === undefined ? 0 : st.minDepth,
                    maxDepth: st.maxDepth === null || st.maxDepth === undefined ? -1 : st.maxDepth,
                };
                importedRules = [vcpRule];
            }
            // Check if it's VCPChat native format (single object)
            else if (importedData && typeof importedData === 'object' && !Array.isArray(importedData) && importedData.title) {
                importedRules = [importedData];
            }
            // Check if it's a VCPChat rules array (for backward compatibility or other uses)
            else if (Array.isArray(importedData)) {
                 return { success: false, error: '不支持导入VCPChat正则数组，请导入单个正则文件。' };
            }
            else {
                return { success: false, error: '无法识别的正则文件格式。' };
            }

            if (importedRules.some(rule => typeof rule.findPattern !== 'string'
                || !rule.findPattern.trim())) {
                return { success: false, error: '导入规则缺少有效的查找表达式。' };
            }

            // Return candidates only. The owning renderer merges them into
            // its current draft, which may contain unsaved edits/deletions.
            // Parsing a file neither stages an edit nor acknowledges a save.
            return { success: true, importedRules, agentId };

        } catch (error) {
            console.error(`为 Agent ${agentId} 导入正则规则失败:`, error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    initialize
};