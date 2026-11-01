// SillyTavern 适配层：设置、聊天元数据、世界书、发送消息、提示词注入
import { MODULE_NAME, META_KEY, defaultSettings, makeProfile, uid, sampleProfile, SAMPLE_PROFILE_ID, PROFILE_KEYS, DEFAULT_TERRAINS } from './defaults.js';
import { normalizeSkill } from './engine.js';
import { profileFor } from './profiles.js';

export const ctx = () => SillyTavern.getContext();

// ---------------------------------------------------------------- 设置（全局）

function mergeDefaults(target, defs) {
    for (const [k, v] of Object.entries(defs)) {
        if (!(k in target)) target[k] = structuredClone(v);
        else if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
            mergeDefaults(target[k], v);
        }
    }
    return target;
}

export function getSettings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE_NAME]) all[MODULE_NAME] = defaultSettings();
    else if (!all[MODULE_NAME]._merged) {
        const st = all[MODULE_NAME];
        const previousVersion = Number(st.version) || 0;
        migrateToProfiles(st);
        mergeDefaults(st, defaultSettings());
        for (const p of st.profiles) normalizeProfile(p);
        if (previousVersion < 5) upgradeCombatRules(st);
        // v0.24：棋盘会按可用高度缩放，旧默认的格子上限 40 提高到新默认 48
        if (previousVersion < 6 && Number(st.ui?.cell) === 40) st.ui.cell = 48;
        // v0.26：剧情联动改为插件 LLM 读取聊天，聊天 AI 不再写标记 / 指令块
        if (previousVersion < 7) { delete st.designer?.story?.hideTag; delete st.llm?.hideBlock; }
        st.version = 7;
        Object.defineProperty(st, '_merged', { value: true, enumerable: false });
    }
    return all[MODULE_NAME];
}

/** 旧默认减法公式升级；已经选择比例公式的资料卡保留。 */
export function upgradeCombatRules(st) {
    for (const p of st.profiles || []) {
        if (p.rules?.formula === 'subtract') p.rules.formula = 'diminishing';
        if (p.rules && p.rules.defenseScale == null) p.rules.defenseScale = 12;
    }
}

/** v4 之前，单位 / 地形 / 地图 / 规则直接存在设置里：把它们打包成一张资料卡 */
export function migrateToProfiles(st) {
    if (Array.isArray(st.profiles)) return;
    const legacy = {};
    for (const k of PROFILE_KEYS) if (k in st) { legacy[k] = st[k]; delete st[k]; }
    st.profiles = [];
    if (legacy.units || legacy.maps) {
        const mine = makeProfile({ name: '我的资料卡', desc: '由旧版数据自动转换', ...legacy });
        st.profiles.push(mine);
        st.activeProfile = mine.id;
        st.defaultProfile = mine.id;
    }
    // 旧用户也能拿到新的示例
    st.profiles.push(sampleProfile());
    st.activeProfile ||= SAMPLE_PROFILE_ID;
    st.defaultProfile ||= SAMPLE_PROFILE_ID;
}

/** 补齐资料卡字段，升级旧格式的技能 / 单位 / 地形 */
export function normalizeProfile(p) {
    const fresh = makeProfile();
    for (const k of ['terrains', 'unitTypes', 'units', 'maps']) if (!Array.isArray(p[k])) p[k] = fresh[k];
    p.unitTypes = p.unitTypes.filter(t => t && typeof t === 'object');
    for (const t of p.unitTypes) {
        t.id ||= uid('type');
        t.name ||= '未命名兵种';
        if (!t.vs || typeof t.vs !== 'object') t.vs = {};
    }
    p.rules = { ...fresh.rules, ...(p.rules || {}) };
    p.name ||= '未命名资料卡';
    for (const u of p.units) {
        if (!Array.isArray(u.traits)) u.traits = [];
        u.traits = u.traits.filter(t => t && typeof t === 'object');
        for (const t of u.traits) {
            t.id ||= uid('trait');
            t.name ||= '未命名特质';
            if (!Array.isArray(t.effects)) t.effects = [];
        }
        (u.skills || []).forEach(normalizeSkill); // 旧版技能（kind: 'heal'、无冷却 / 效果字段）
        if (u.agi == null) u.agi = u.kind === 'object' ? 0 : 5; // v3 新增敏捷
        if (u.tough == null) u.tough = 2; // v0.17 新增韧性
        if (u.typeId == null) u.typeId = ''; // v0.20 新增兵种与视野
        if (u.vision == null) u.vision = u.kind === 'object' ? 0 : 4;
    }
    for (const m of p.maps) if (!m.fog || typeof m.fog !== 'object') m.fog = { enabled: false, ai: true };
    for (const t of p.terrains) {
        if (t.avoid == null) t.avoid = 0;
        // 内置地形补上视野相关字段（森林隐蔽、山地 / 堡垒视野加成、城墙遮挡视线）
        const base = DEFAULT_TERRAINS.find(d => d.id === t.id);
        for (const k of ['conceal', 'visionBonus', 'blockSight']) if (t[k] == null && base?.[k] != null) t[k] = base[k];
    }
    return p;
}

export function saveSettings() {
    ctx().saveSettingsDebounced();
}

// ---------------------------------------------------------------- 战斗状态（按聊天保存）

export function getBattle() {
    const bound = boundProfile();
    if (!bound) return null;
    const meta = ctx().chatMetadata;
    const battle = meta?.[META_KEY];
    return battle && (!battle.profileId || battle.profileId === bound.id) ? battle : null;
}

/** 暂停的数据仍可用于继续界面，但不参与聊天与生成。 */
export function isBattleRunning() {
    const b = getBattle();
    return !!b?.active && !b.paused;
}

export function setBattle(battle) {
    const bound = boundProfile();
    if (!bound || (battle?.profileId && battle.profileId !== bound.id)) return false;
    const c = ctx();
    if (!c.chatMetadata) return;
    if (!battle && c.chatMetadata[META_KEY]?.profileId && c.chatMetadata[META_KEY].profileId !== bound.id) return false;
    if (battle) c.chatMetadata[META_KEY] = battle;
    else delete c.chatMetadata[META_KEY];
    saveBattle();
}

export function saveBattle() {
    if (!boundProfile()) return;
    const c = ctx();
    const b = getBattle();
    if (c.chatMetadata?.[META_KEY] && !b) return;
    if (b) b.rev = (b.rev || 0) + 1; // 版本号：用来判断某次改动之后棋盘是否又变过
    if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
    else if (typeof c.saveMetadata === 'function') c.saveMetadata();
}

export function hasChat() {
    const c = ctx();
    return !!(c.getCurrentChatId?.() ?? c.chatId);
}

/** 仅当前角色 / 群组的显式绑定启用插件，不继承默认卡或群组成员的绑定。 */
export function boundProfile(settings = null, owner = currentOwner()) {
    if (!owner || !hasChat()) return null;
    return profileFor(settings || getSettings(), owner.key);
}

export function isEnabledForChat() {
    return !!boundProfile();
}

// ---------------------------------------------------------------- 世界书

let wiModule = null;
async function worldInfoModule() {
    if (!wiModule) {
        wiModule = import('/scripts/world-info.js').catch(() => import('../../../../world-info.js')).catch(() => null);
    }
    return wiModule;
}

export async function listWorldBooks() {
    const mod = await worldInfoModule();
    let names = Array.isArray(mod?.world_names) ? [...mod.world_names] : [];
    if (!names.length) {
        // 退路：从世界书编辑器的下拉框里读
        names = [...document.querySelectorAll('#world_editor_select option')]
            .map(o => o.textContent.trim()).filter(n => n && !n.startsWith('---'));
    }
    return names.sort((a, b) => a.localeCompare(b));
}

const bookCache = new Map();

/** @returns {Promise<{uid:number,label:string,keys:string[],content:string}[]>} */
export async function loadBookEntries(name, force = false) {
    if (!name) return [];
    if (!force && bookCache.has(name)) return bookCache.get(name);
    const c = ctx();
    let data = null;
    if (typeof c.loadWorldInfo === 'function') data = await c.loadWorldInfo(name);
    else data = (await worldInfoModule())?.loadWorldInfo?.(name);
    data = await data;
    const entries = Object.values(data?.entries || {}).map(e => ({
        uid: e.uid,
        label: e.comment || (e.key || [])[0] || `#${e.uid}`,
        keys: Array.isArray(e.key) ? e.key.filter(Boolean) : [],
        content: e.content || '',
        disabled: !!e.disable,
    })).sort((a, b) => a.uid - b.uid);
    bookCache.set(name, entries);
    setTimeout(() => bookCache.delete(name), 30_000);
    return entries;
}

export async function getEntryContent(wb) {
    if (!wb?.book) return '';
    try {
        const entries = await loadBookEntries(wb.book);
        return entries.find(e => e.uid === wb.uid)?.content || '';
    } catch {
        return '';
    }
}

/** 当前聊天会用到的世界书：角色卡（含附加世界书）、群组成员、聊天绑定和全局启用的世界书 */
export async function chatLoreBooks() {
    const c = ctx();
    const mod = await worldInfoModule();
    const names = new Set();
    const addChar = ch => {
        if (!ch) return;
        if (ch.data?.extensions?.world) names.add(ch.data.extensions.world);
        const extra = (mod?.world_info?.charLore || []).find(x => x.name === ch.avatar)?.extraBooks;
        (extra || []).forEach(n => names.add(n));
    };
    const owner = currentOwner();
    if (owner?.kind === 'char') addChar(owner.character);
    if (owner?.kind === 'group') {
        const g = (c.groups || []).find(x => String(x.id) === String(c.groupId));
        (g?.members || []).forEach(m => addChar((c.characters || []).find(ch => ch.avatar === m)));
    }
    if (c.chatMetadata?.world_info) names.add(c.chatMetadata.world_info);
    (Array.isArray(mod?.selected_world_info) ? mod.selected_world_info : []).forEach(n => names.add(n));
    return [...names].filter(Boolean);
}

/**
 * 把世界书整理成给 AI 设计助手看的文字（只含启用的条目），超出字数上限时截断。
 * @returns {Promise<{text:string, entries:{book:string,uid:number,label:string,keys:string[]}[], truncated:boolean}>}
 */
export async function loreForDesign(books, maxChars = 24000) {
    const parts = [], entries = [];
    let used = 0, truncated = false;
    for (const book of books || []) {
        let list = [];
        try { list = await loadBookEntries(book, true); } catch { continue; }
        for (const e of list) {
            if (e.disabled || !e.content.trim()) continue;
            entries.push({ book, uid: e.uid, label: e.label, keys: e.keys });
            const block = `【${book}｜${e.label}】${e.keys.length ? `（关键词：${e.keys.slice(0, 5).join('、')}）` : ''}\n${substitute(e.content.trim())}`;
            if (used + block.length > maxChars) { truncated = true; continue; }
            parts.push(block);
            used += block.length;
        }
    }
    return { text: parts.join('\n\n'), entries, truncated };
}

/** 角色卡（或群组成员）的设定：名字、描述、性格、场景 */
export function characterBrief(maxChars = 6000) {
    const c = ctx();
    const owner = currentOwner();
    let chars = [];
    if (owner?.kind === 'char') chars = [owner.character];
    else if (owner?.kind === 'group') {
        const g = (c.groups || []).find(x => String(x.id) === String(c.groupId));
        chars = (g?.members || []).map(m => (c.characters || []).find(ch => ch.avatar === m)).filter(Boolean);
    }
    const text = chars.map(ch => {
        const d = ch.data || ch;
        return [`名字：${ch.name}`, d.description && `描述：${d.description}`, d.personality && `性格：${d.personality}`, d.scenario && `场景：${d.scenario}`]
            .filter(Boolean).join('\n');
    }).join('\n\n');
    const user = c.name1 ? `\n\n用户扮演的角色：${c.name1}` : '';
    return substitute(text + user).slice(0, maxChars);
}

/** 用 SillyTavern 当前选择的 API 生成（不带聊天记录），兼容新旧两种 generateRaw 签名 */
export async function generateRawST(system, prompt, maxTokens) {
    const fn = ctx().generateRaw;
    if (typeof fn !== 'function') throw new Error('当前 SillyTavern 版本不支持 generateRaw，请改用连接配置或自定义 API');
    // 新版是 generateRaw({ prompt, systemPrompt, responseLength, … })，旧版是 generateRaw(prompt, api, instructOverride, quietToLoud, systemPrompt, responseLength)
    const objectStyle = fn.length === 0 || /^[^(]*\(\s*\{/.test(Function.prototype.toString.call(fn));
    const res = objectStyle
        ? await fn({ prompt, systemPrompt: system, responseLength: maxTokens })
        : await fn(prompt, null, false, false, system, maxTokens);
    return String(res ?? '');
}

/** SillyTavern「连接配置」扩展中保存的配置（不包含密钥） */
export function connectionProfiles() {
    const list = ctx().extensionSettings?.connectionManager?.profiles;
    return Array.isArray(list) ? list.filter(p => p?.id).map(p => ({ id: p.id, name: p.name || p.id, api: p.api || '', model: p.model || '' })) : [];
}

/** 用指定的连接配置生成，请求经由 SillyTavern 后端（密钥留在 SillyTavern 里） */
export async function generateWithProfile(profileId, system, prompt, maxTokens) {
    const svc = ctx().ConnectionManagerRequestService;
    if (!svc?.sendRequest) throw new Error('当前 SillyTavern 版本没有连接配置请求服务，请更新 SillyTavern 或改用其他方式');
    const res = await svc.sendRequest(profileId, [{ role: 'system', content: system }, { role: 'user', content: prompt }], maxTokens);
    return typeof res === 'string' ? res : String(res?.content ?? '');
}

// ---------------------------------------------------------------- 注入 & 发送

const INJECT_KEY = 'tavern_srpg_state';

const POSITIONS = { after: 0, chat: 1, before: 2 }; // extension_prompt_types: IN_PROMPT / IN_CHAT / BEFORE_PROMPT
const ROLES = { system: 0, user: 1, assistant: 2 };

/** 替换 {{user}} {{char}} 等宏 */
export function substitute(text) {
    const c = ctx();
    try {
        return typeof c.substituteParams === 'function' ? c.substituteParams(text) : text;
    } catch {
        return text;
    }
}

/**
 * 注入战场信息。scan=true 让世界书能扫描到单位名和别名。
 * @param {{position?:string, depth?:number, role?:string}} opt
 */
export function setInjection(text, opt = {}) {
    if (text && !isBattleRunning()) text = '';
    const c = ctx();
    if (typeof c.setExtensionPrompt !== 'function') return;
    c.setExtensionPrompt(INJECT_KEY, text ? substitute(text) : '', POSITIONS[opt.position] ?? 1, Number(opt.depth) || 0, true, ROLES[opt.role] ?? 0);
}

export function isGenerating() {
    const stop = document.getElementById('mes_stop');
    return !!stop && getComputedStyle(stop).display !== 'none';
}

export function readMainInput() {
    return document.getElementById('send_textarea')?.value || '';
}

export function writeMainInput(text) {
    if (!isBattleRunning()) return false;
    const ta = document.getElementById('send_textarea');
    if (!ta) return;
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 以用户身份发送消息并触发生成 */
export function sendAsUser(text) {
    if (!isBattleRunning()) return false;
    writeMainInput(text);
    const btn = document.getElementById('send_but');
    if (btn) btn.click();
}

// ---------------------------------------------------------------- 聊天消息 & 后台生成

export function currentChatId() {
    const c = ctx();
    return c.getCurrentChatId?.() ?? c.chatId ?? null;
}

export function getMessage(id) {
    return ctx().chat?.[id] || null;
}

export function chatLength() {
    return ctx().chat?.length ?? 0;
}

/**
 * 聊天记录第 from–to 楼（含，楼层号就是消息上的 # 编号），去掉旧版插件标记；超长时只保留较新的部分
 */
export function chatSlice(from, to, maxChars = 16000) {
    const chat = ctx().chat || [];
    const lines = [];
    for (let i = Math.max(0, from); i <= Math.min(to, chat.length - 1); i++) {
        const m = chat[i];
        if (!m || m.is_system || !m.mes) continue;
        const text = String(m.mes).replace(/<srpg(-story)?>[\s\S]*?<\/srpg(-story)?>/gi, '').trim();
        lines.push(`#${i} ${m.name || (m.is_user ? '用户' : '角色')}：${text.length > 3000 ? `${text.slice(0, 3000)}……` : text}`);
    }
    let out = lines.join('\n\n');
    if (out.length > maxChars) out = `……${out.slice(-maxChars)}`;
    return substitute(out);
}

/** 最近的剧情：聊天记录到 upTo 楼（含）为止的最近 count 条 */
export function recentChat(count = 20, upTo = null, maxChars = 16000) {
    const end = upTo == null ? chatLength() - 1 : Math.min(chatLength() - 1, upTo);
    return chatSlice(end - count + 1, end, maxChars);
}

const UNITS_INJECT_KEY = 'tavern_srpg_units';

/** 单位资料（类似世界书条目，放在角色设定之后）；不需要进行中的战斗 */
export function setUnitLoreInjection(text) {
    const c = ctx();
    if (typeof c.setExtensionPrompt !== 'function') return;
    if (text && !isEnabledForChat()) text = '';
    c.setExtensionPrompt(UNITS_INJECT_KEY, text ? substitute(text) : '', POSITIONS.after, 0, false, ROLES.system);
}

/** 关键词扫描用的文字：最近几条消息加上输入框里尚未发送的文字 */
export function scanText(depth = 4) {
    const chat = ctx().chat || [];
    const recent = chat.slice(-Math.max(1, depth)).filter(m => m && !m.is_system).map(m => String(m.mes || ''));
    return [...recent, readMainInput()].join('\n');
}
const STORY_META = 'tavern_srpg_story';

/** 当前聊天的剧情同步记录与提议（保存在聊天元数据里） */
export function getStory(create = false) {
    if (!isEnabledForChat()) return null;
    const meta = ctx().chatMetadata;
    if (!meta) return null;
    if (!meta[STORY_META] && create) meta[STORY_META] = { items: [] };
    return meta[STORY_META] || null;
}

export function saveStory() {
    if (!isEnabledForChat()) return;
    const c = ctx();
    if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
    else c.saveMetadata?.();
}

// ---------------------------------------------------------------- 当前角色 / 群组（用于绑定资料卡）

/**
 * 当前聊天对应的角色卡或群组
 * @returns {{key:string, kind:'char'|'group', name:string, characterId?:number, character?:object}|null}
 */
export function currentOwner() {
    const c = ctx();
    if (c.groupId != null && c.groupId !== '') {
        const g = (c.groups || []).find(x => String(x.id) === String(c.groupId));
        return { key: `group:${c.groupId}`, kind: 'group', name: g?.name || '群组' };
    }
    const id = c.characterId;
    const ch = id != null ? c.characters?.[id] : null;
    if (!ch) return null;
    return { key: `char:${ch.avatar}`, kind: 'char', name: ch.name, characterId: Number(id), character: ch };
}

/** 根据绑定键找角色 / 群组名（用于资料卡列表） */
export function ownerName(key) {
    const c = ctx();
    const [kind, ...rest] = key.split(':');
    const id = rest.join(':');
    if (kind === 'group') return (c.groups || []).find(g => String(g.id) === id)?.name || null;
    return (c.characters || []).find(ch => ch.avatar === id)?.name || null;
}

/** 写入角色卡的 data.extensions（会随角色卡导出） */
export async function writeCardExtension(characterId, value) {
    const c = ctx();
    if (typeof c.writeExtensionField !== 'function') throw new Error('当前 SillyTavern 版本不支持写入角色卡扩展字段');
    await c.writeExtensionField(characterId, MODULE_NAME, value);
}

export function readCardExtension(character) {
    return character?.data?.extensions?.[MODULE_NAME] || null;
}

/** 确认对话框：优先使用 SillyTavern 的弹窗 */
export async function confirmPopup(html, text) {
    const c = ctx();
    try {
        if (typeof c.callGenericPopup === 'function' && c.POPUP_TYPE) {
            return !!(await c.callGenericPopup(html, c.POPUP_TYPE.CONFIRM));
        }
    } catch (err) {
        console.warn('[Tavern-SRPG] 弹窗失败', err);
    }
    return window.confirm(text);
}
