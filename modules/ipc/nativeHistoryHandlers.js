'use strict';
const { mergeTerminal } = require('../services/nativeSync/mergeTerminal');
function initialize({ ipcMain, historyMutationQueue: queue }) {
    ipcMain.handle('native-history:status', () => queue.syncPolicy?.diagnostics() || { enabled: false });
    ipcMain.handle('native-history:snapshot', async (_event, itemId, itemType, topicId) => {
        try {
            const d = { itemId, itemType, topicId };
            if (!queue.isSyncEnabled(d)) return { syncEnabled: false };
            return await queue.readSnapshot(d);
        }
        catch (error) { return { success: false, error: error.code || error.message }; }
    });
    ipcMain.handle('native-history:terminal', async (_event, projected) => {
        const context = projected?.context;
        const d = { itemId: context?.groupId || context?.agentId, itemType: context?.isGroupMessage ? 'group' : 'agent', topicId: context?.topicId };
        if (!queue.isSyncEnabled(d)) return { handled: false };
        try {
            const result = await queue.mutate(d, current => mergeTerminal(current, projected, queue.syncPolicy.deletedMessageIds?.(d) || []));
            return { ...result, handled: true };
        } catch (error) { return { handled: true, success: false, error: error.code || error.message }; }
    });
}
module.exports = { initialize };
