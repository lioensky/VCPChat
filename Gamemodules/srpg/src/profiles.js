// 资料卡：打包、导入、绑定（纯逻辑，便于测试）
import { makeProfile, uid, PROFILE_KEYS } from './defaults.js';

export const PROFILE_FORMAT = 'tavern-srpg-profile';
export const ALL_FORMAT = 'tavern-srpg';
/** 全局设置（不属于资料卡） */
export const GLOBAL_KEYS = ['narration', 'send', 'inject', 'tool', 'llm', 'ui'];

/** 单张资料卡的导出内容（也是写入角色卡的内容） */
export function profilePayload(p) {
    return { format: PROFILE_FORMAT, version: 1, profile: structuredClone({ ...p, updatedAt: p.updatedAt || Date.now() }) };
}

/** 所有资料卡 + 全局设置 */
export function allPayload(settings) {
    const data = { format: ALL_FORMAT, version: 4, profiles: structuredClone(settings.profiles) };
    for (const k of GLOBAL_KEYS) data[k] = structuredClone(settings[k]);
    return data;
}

/** 从导出文件里取出资料卡，兼容 v1–v3 的旧导出（单位 / 地形 / 地图直接在顶层） */
export function profilesFromPayload(data, fallbackName = '导入的资料卡') {
    if (!data || typeof data !== 'object') throw new Error('文件内容不是 JSON 对象');
    if (data.format === PROFILE_FORMAT && data.profile) return [data.profile];
    if (data.format === ALL_FORMAT && Array.isArray(data.profiles)) return data.profiles;
    if (data.format === ALL_FORMAT && (data.units || data.maps)) {
        const legacy = {};
        for (const k of PROFILE_KEYS) if (k in data) legacy[k] = data[k];
        return [makeProfile({ name: fallbackName, desc: '由旧版导出文件转换', ...legacy })];
    }
    throw new Error('不是 Tavern-SRPG 的导出文件');
}

/**
 * 把资料卡加入列表。同 id 时：replace=true 覆盖，否则作为新的副本加入。
 * @returns {object[]} 实际加入 / 更新后的资料卡
 */
export function addProfiles(settings, profiles, { replace = false, normalize = p => p } = {}) {
    const out = [];
    for (const raw of profiles) {
        const p = normalize(structuredClone(raw));
        const idx = settings.profiles.findIndex(x => x.id === p.id);
        if (idx >= 0 && replace) {
            settings.profiles[idx] = p;
        } else {
            if (idx >= 0 || !p.id) {
                p.id = uid('profile');
                if (idx >= 0) p.name = `${p.name}（导入）`;
            }
            settings.profiles.push(p);
        }
        out.push(p);
    }
    return out;
}

export function getProfile(settings, id) {
    return settings.profiles.find(p => p.id === id) || null;
}

/** 某个聊天（角色 / 群组）应该使用的资料卡 */
export function profileFor(settings, ownerKey) {
    const id = ownerKey && settings.bindings?.[ownerKey];
    return typeof id === 'string' && id ? getProfile(settings, id) : null;
}

/** 绑定到某张资料卡的角色 / 群组 */
export function boundOwners(settings, profileId) {
    return Object.entries(settings.bindings || {}).filter(([, id]) => id === profileId).map(([key]) => key);
}

/** 删除资料卡，同时清理绑定和默认值；至少保留一张 */
export function removeProfile(settings, id) {
    if (settings.profiles.length <= 1) throw new Error('至少保留一张资料卡');
    settings.profiles = settings.profiles.filter(p => p.id !== id);
    for (const [k, v] of Object.entries(settings.bindings || {})) if (v === id) delete settings.bindings[k];
    if (settings.defaultProfile === id) settings.defaultProfile = settings.profiles[0].id;
    if (settings.activeProfile === id) settings.activeProfile = settings.defaultProfile;
}

export function profileStats(p) {
    return `${p.units.length} 个单位 · ${p.maps.length} 张地图 · ${p.terrains.length} 种地形`;
}
