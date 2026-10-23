/**
 * modelUsageTracker.js
 * 
 * 轻量级模块：追踪用户聊天中各模型的使用频率。
 * 数据持久化到 AppData/model_usage_stats.json。
 * 使用内存缓存 + 防抖写入策略，避免频繁磁盘 IO。
 */
const fs = require('fs-extra');
const path = require('path');

const APP_DATA_ROOT = process.env.VCPCHAT_APP_DATA_DIR ? path.resolve(process.env.VCPCHAT_APP_DATA_DIR) : path.join(__dirname, '..', 'AppData');
const STATS_FILE = path.join(APP_DATA_ROOT, 'model_usage_stats.json');

let usageCache = null; // 内存缓存: { "model-id": count, ... }
let isDirty = false;   // 是否有未写入的变更
let writeTimer = null; // 防抖写入定时器
const DEBOUNCE_MS = 2000; // 2秒防抖

/**
 * 加载统计数据到内存缓存
 */
async function loadStats() {
    if (usageCache !== null) return usageCache;
    try {
        if (await fs.pathExists(STATS_FILE)) {
            usageCache = await fs.readJson(STATS_FILE);
        } else {
            usageCache = {};
        }
    } catch (error) {
        console.error('[ModelUsageTracker] Failed to load stats file, starting fresh:', error);
        usageCache = {};
    }
    return usageCache;
}

/**
 * 防抖写入统计数据到磁盘
 */
function scheduleSave() {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(async () => {
        if (!isDirty || !usageCache) return;
        try {
            await fs.ensureDir(APP_DATA_ROOT);
            await fs.writeJson(STATS_FILE, usageCache, { spaces: 2 });
            isDirty = false;
            console.log('[ModelUsageTracker] Stats saved to disk.');
        } catch (error) {
            console.error('[ModelUsageTracker] Failed to save stats:', error);
        }
    }, DEBOUNCE_MS);
}

/**
 * 记录一次模型使用
 * @param {string} modelId - 模型 ID
 */
async function recordModelUsage(modelId) {
    if (!modelId || typeof modelId !== 'string') return;
    const stats = await loadStats();
    stats[modelId] = (stats[modelId] || 0) + 1;
    isDirty = true;
    scheduleSave();
    console.log(`[ModelUsageTracker] Recorded usage for "${modelId}", total: ${stats[modelId]}`);
}

/**
 * 获取热门模型列表（按使用次数降序）
 * @param {number} topN - 返回前 N 个，默认 10
 * @returns {Promise<string[]>} 模型 ID 数组
 */
async function getHotModels(topN = 10) {
    const stats = await loadStats();
    const entries = Object.entries(stats);
    if (entries.length === 0) return [];

    return entries
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([modelId]) => modelId);
}

/**
 * 获取完整的模型使用统计
 * @returns {Promise<Object>} { "model-id": count, ... }
 */
async function getModelUsageStats() {
    return await loadStats();
}

// ========================================
// ⭐ Favorite Models（收藏模型）
// ========================================
const FAVORITES_FILE = path.join(APP_DATA_ROOT, 'model_favorites.json');
let favoritesCache = null; // 内存缓存: ["model-id", ...]

/**
 * 加载收藏数据
 */
async function loadFavorites() {
    if (favoritesCache !== null) return favoritesCache;
    try {
        if (await fs.pathExists(FAVORITES_FILE)) {
            favoritesCache = await fs.readJson(FAVORITES_FILE);
            if (!Array.isArray(favoritesCache)) favoritesCache = [];
        } else {
            favoritesCache = [];
        }
    } catch (error) {
        console.error('[ModelUsageTracker] Failed to load favorites, starting fresh:', error);
        favoritesCache = [];
    }
    return favoritesCache;
}

/**
 * 保存收藏数据到磁盘（即时写入，因为操作频率低）
 */
async function saveFavorites() {
    try {
        await fs.ensureDir(APP_DATA_ROOT);
        await fs.writeJson(FAVORITES_FILE, favoritesCache || [], { spaces: 2 });
        console.log('[ModelUsageTracker] Favorites saved to disk.');
    } catch (error) {
        console.error('[ModelUsageTracker] Failed to save favorites:', error);
    }
}

/**
 * 切换模型收藏状态
 * @param {string} modelId - 模型 ID
 * @returns {Promise<{favorited: boolean}>} 新的收藏状态
 */
async function toggleFavoriteModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return { favorited: false };
    const favorites = await loadFavorites();
    const index = favorites.indexOf(modelId);
    if (index === -1) {
        favorites.push(modelId);
        console.log(`[ModelUsageTracker] Favorited model: "${modelId}"`);
    } else {
        favorites.splice(index, 1);
        console.log(`[ModelUsageTracker] Unfavorited model: "${modelId}"`);
    }
    await saveFavorites();
    return { favorited: index === -1 };
}

/**
 * 获取收藏模型列表
 * @returns {Promise<string[]>} 收藏的模型 ID 数组
 */
async function getFavoriteModels() {
    return await loadFavorites();
}

module.exports = {
    recordModelUsage,
    getHotModels,
    getModelUsageStats,
    toggleFavoriteModel,
    getFavoriteModels
};
