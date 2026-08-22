// modules/ipc/tavernHandlers.js
// VCPChatTarven 高级回复 - 主进程 IPC 处理 + 给主进程其他模块（如 groupchat）使用的辅助函数

const { ipcMain } = require('electron');
const fs = require('fs-extra');
const path = require('path');
const tavernEngine = require('../tavernRulesEngine');

let TAVERN_USER_CONFIG_FILE = null;
let TAVERN_OFFICIAL_CONFIG_FILE = null;
let ipcHandlersRegistered = false;
let cachedStore = null;
let cachedUserMtime = 0;
let cachedOfficialMtime = 0;

function ensureFiles() {
    if (!TAVERN_USER_CONFIG_FILE || !TAVERN_OFFICIAL_CONFIG_FILE) return;
    fs.ensureDirSync(path.dirname(TAVERN_USER_CONFIG_FILE));
    if (!fs.existsSync(TAVERN_USER_CONFIG_FILE)) {
        fs.writeJsonSync(TAVERN_USER_CONFIG_FILE, { version: 3, rules: [] }, { spaces: 2 });
    }
    if (!fs.existsSync(TAVERN_OFFICIAL_CONFIG_FILE)) {
        fs.writeJsonSync(TAVERN_OFFICIAL_CONFIG_FILE, { version: 3, rules: [] }, { spaces: 2 });
    }
}

function readBothStoresSync() {
    ensureFiles();
    return {
        userStore: fs.readJsonSync(TAVERN_USER_CONFIG_FILE),
        officialStore: fs.readJsonSync(TAVERN_OFFICIAL_CONFIG_FILE)
    };
}

async function readStore() {
    if (!TAVERN_USER_CONFIG_FILE || !TAVERN_OFFICIAL_CONFIG_FILE) {
        return tavernEngine.combineRuleStores({ version: 3, rules: [] }, { version: 3, rules: [] });
    }
    try {
        ensureFiles();
        const [userStat, officialStat] = await Promise.all([
            fs.stat(TAVERN_USER_CONFIG_FILE),
            fs.stat(TAVERN_OFFICIAL_CONFIG_FILE)
        ]);
        if (!cachedStore ||
            userStat.mtimeMs !== cachedUserMtime ||
            officialStat.mtimeMs !== cachedOfficialMtime) {
            const [userStore, officialStore] = await Promise.all([
                fs.readJson(TAVERN_USER_CONFIG_FILE),
                fs.readJson(TAVERN_OFFICIAL_CONFIG_FILE)
            ]);
            cachedStore = tavernEngine.combineRuleStores(officialStore, userStore);
            cachedUserMtime = userStat.mtimeMs;
            cachedOfficialMtime = officialStat.mtimeMs;
        }
        return cachedStore;
    } catch (error) {
        console.error('[TavernHandlers] Failed to read tavern stores:', error);
        return tavernEngine.combineRuleStores({ version: 3, rules: [] }, { version: 3, rules: [] });
    }
}

function readStoreSync() {
    if (!TAVERN_USER_CONFIG_FILE || !TAVERN_OFFICIAL_CONFIG_FILE) {
        return tavernEngine.combineRuleStores({ version: 3, rules: [] }, { version: 3, rules: [] });
    }
    try {
        ensureFiles();
        const userStat = fs.statSync(TAVERN_USER_CONFIG_FILE);
        const officialStat = fs.statSync(TAVERN_OFFICIAL_CONFIG_FILE);
        if (!cachedStore ||
            userStat.mtimeMs !== cachedUserMtime ||
            officialStat.mtimeMs !== cachedOfficialMtime) {
            const stores = readBothStoresSync();
            cachedStore = tavernEngine.combineRuleStores(stores.officialStore, stores.userStore);
            cachedUserMtime = userStat.mtimeMs;
            cachedOfficialMtime = officialStat.mtimeMs;
        }
        return cachedStore;
    } catch (error) {
        console.error('[TavernHandlers] Failed to read tavern stores (sync):', error);
        return tavernEngine.combineRuleStores({ version: 3, rules: [] }, { version: 3, rules: [] });
    }
}

async function writeStore(store) {
    if (!TAVERN_USER_CONFIG_FILE || !TAVERN_OFFICIAL_CONFIG_FILE) {
        return { success: false, error: 'Tavern config paths not initialized.' };
    }
    try {
        const split = tavernEngine.splitRuleStore(store);
        await fs.ensureDir(path.dirname(TAVERN_USER_CONFIG_FILE));
        await Promise.all([
            fs.writeJson(TAVERN_USER_CONFIG_FILE, split.userStore, { spaces: 2 }),
            fs.writeJson(TAVERN_OFFICIAL_CONFIG_FILE, split.officialStore, { spaces: 2 })
        ]);
        const [userStat, officialStat] = await Promise.all([
            fs.stat(TAVERN_USER_CONFIG_FILE),
            fs.stat(TAVERN_OFFICIAL_CONFIG_FILE)
        ]);
        cachedUserMtime = userStat.mtimeMs;
        cachedOfficialMtime = officialStat.mtimeMs;
        cachedStore = tavernEngine.combineRuleStores(split.officialStore, split.userStore);
        return { success: true, store: cachedStore };
    } catch (error) {
        console.error('[TavernHandlers] Failed to write tavern stores:', error);
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
    TAVERN_USER_CONFIG_FILE = path.join(context.APP_DATA_ROOT_IN_PROJECT, 'VCPChatTarven.json');
    TAVERN_OFFICIAL_CONFIG_FILE = path.join(context.APP_DATA_ROOT_IN_PROJECT, 'VCPChatTarven.official.json');
    ensureFiles();
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
    console.log('[TavernHandlers] Initialized. Config files:', {
        user: TAVERN_USER_CONFIG_FILE,
        official: TAVERN_OFFICIAL_CONFIG_FILE
    });
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