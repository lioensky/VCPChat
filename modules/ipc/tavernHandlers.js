// modules/ipc/tavernHandlers.js
// VCPChatTarven 高级回复 - 主进程 IPC 处理 + 给主进程其他模块（如 groupchat）使用的辅助函数

const { ipcMain } = require('electron');
const fs = require('fs-extra');
const path = require('path');
const tavernEngine = require('../tavernRulesEngine');

let TAVERN_CONFIG_FILE = null;
let ipcHandlersRegistered = false;
let cachedStore = null;
let cachedMtime = 0;

function ensureFile() {
    if (!TAVERN_CONFIG_FILE) return;
    fs.ensureDirSync(path.dirname(TAVERN_CONFIG_FILE));
    if (!fs.existsSync(TAVERN_CONFIG_FILE)) {
        fs.writeJsonSync(TAVERN_CONFIG_FILE, { version: 1, rules: [] }, { spaces: 2 });
    }
}

async function readStore() {
    if (!TAVERN_CONFIG_FILE) return { version: 1, rules: [] };
    try {
        ensureFile();
        const stat = await fs.stat(TAVERN_CONFIG_FILE);
        if (cachedStore && stat.mtimeMs === cachedMtime) {
            return cachedStore;
        }
        const raw = await fs.readJson(TAVERN_CONFIG_FILE);
        cachedStore = tavernEngine.normalizeRuleStore(raw);
        cachedMtime = stat.mtimeMs;
        return cachedStore;
    } catch (error) {
        console.error('[TavernHandlers] Failed to read tavern store:', error);
        return { version: 1, rules: [] };
    }
}

function readStoreSync() {
    if (!TAVERN_CONFIG_FILE) return { version: 1, rules: [] };
    try {
        ensureFile();
        const stat = fs.statSync(TAVERN_CONFIG_FILE);
        if (cachedStore && stat.mtimeMs === cachedMtime) {
            return cachedStore;
        }
        const raw = fs.readJsonSync(TAVERN_CONFIG_FILE);
        cachedStore = tavernEngine.normalizeRuleStore(raw);
        cachedMtime = stat.mtimeMs;
        return cachedStore;
    } catch (error) {
        console.error('[TavernHandlers] Failed to read tavern store (sync):', error);
        return { version: 1, rules: [] };
    }
}

async function writeStore(store) {
    if (!TAVERN_CONFIG_FILE) {
        return { success: false, error: 'Tavern config path not initialized.' };
    }
    try {
        const normalized = tavernEngine.normalizeRuleStore(store);
        await fs.ensureDir(path.dirname(TAVERN_CONFIG_FILE));
        await fs.writeJson(TAVERN_CONFIG_FILE, normalized, { spaces: 2 });
        cachedStore = normalized;
        try {
            const stat = await fs.stat(TAVERN_CONFIG_FILE);
            cachedMtime = stat.mtimeMs;
        } catch (_) { /* ignore */ }
        return { success: true, store: normalized };
    } catch (error) {
        console.error('[TavernHandlers] Failed to write tavern store:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 初始化 IPC handlers
 * @param {object} context
 * @param {string} context.APP_DATA_ROOT_IN_PROJECT
 */
function initialize(context) {
    if (!context || !context.APP_DATA_ROOT_IN_PROJECT) {
        console.error('[TavernHandlers] APP_DATA_ROOT_IN_PROJECT is required.');
        return;
    }
    TAVERN_CONFIG_FILE = path.join(context.APP_DATA_ROOT_IN_PROJECT, 'VCPChatTarven.json');
    ensureFile();
    // 预热缓存
    readStoreSync();

    if (ipcHandlersRegistered) return;

    ipcMain.handle('tavern:get-rules', async () => {
        const store = await readStore();
        return { success: true, store };
    });

    ipcMain.handle('tavern:save-rules', async (_event, store) => {
        return await writeStore(store);
    });

    ipcMain.handle('tavern:set-rule-enabled', async (_event, ruleId, enabled) => {
        const store = await readStore();
        const target = (store.rules || []).find(r => r.id === ruleId);
        if (!target) {
            return { success: false, error: 'Rule not found.' };
        }
        target.enabled = !!enabled;
        return await writeStore(store);
    });

    ipcHandlersRegistered = true;
    console.log('[TavernHandlers] Initialized. Config file:', TAVERN_CONFIG_FILE);
}

/**
 * 给主进程其它模块使用：取规则列表
 * @returns {Array}
 */
function getActiveRules() {
    const store = readStoreSync();
    return Array.isArray(store.rules) ? store.rules : [];
}

module.exports = {
    initialize,
    getActiveRules,
    // 重新导出引擎方法，方便其他主进程模块直接用
    engine: tavernEngine
};