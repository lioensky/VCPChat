// 剧情同步：由「AI 设计」页配置的模型（不是聊天 AI）读取聊天记录，找出角色成长、即将开始的战斗和战场变化；
// 聊天 AI 不需要写任何标记，插件与聊天互不干扰。这里还负责生成剧情关卡、应用与撤销成长。
import * as ST from '../st.js';
import { toast } from './dom.js';
import { uid } from '../defaults.js';
import { buildGrowthPrompt, buildSyncPrompt, normalizeSync, normalizeGrowth, applyGrowth, revertGrowth, growthIds, countReplies, syncWindow, STORY_KINDS } from '../story.js';
import { buildDesignPrompt, parseDesignReply } from '../designer.js';
import { designerGenerate } from '../ai-api.js';
import { commandGuide, parseCommands } from '../commands.js';
import { proposeCommands } from './llm-flow.js';

const ACTIVE = ['queued', 'working', 'ready', 'error'];

/** 设计助手需要的资料：世界书、角色卡、最近的剧情 */
export async function designContext(app, { chat = false, upTo = null } = {}) {
    const cfg = app.settings.designer;
    const books = cfg.books ?? await ST.chatLoreBooks().catch(() => []);
    const lore = await ST.loreForDesign(books, cfg.loreChars);
    return {
        books, lore: lore.text, entries: lore.entries, truncated: lore.truncated,
        character: cfg.includeChar ? ST.characterBrief() : '',
        chat: chat ? ST.recentChat(Math.max(1, Number(cfg.story?.chatDepth) || 20), upTo) : '',
    };
}

// ---------------------------------------------------------------- 剧情同步

/** 正在进行的同步（只在内存里；切换聊天、楼层被重新生成时作废） */
let job = null;

function cancelJob() {
    if (!job) return;
    job.cancelled = true;
    job.abort.abort();
    job = null;
}

/** 剧情同步的状态（界面用） */
export function syncInfo() {
    const store = ST.getStory();
    const chat = ST.ctx().chat || [];
    const last = chat.length - 1;
    const syncedTo = store?.syncedTo == null ? null : Math.min(store.syncedTo, last);
    return { syncedTo, last, fresh: syncedTo == null ? 0 : countReplies(chat, syncedTo, last), sync: store?.sync || null, working: job && job.chatId === ST.currentChatId() ? job : null };
}

/**
 * 第 mesId 楼被重新生成、滑动或删除：覆盖到这一楼的同步作废，从那次同步的起点重新读取；
 * 这些楼层上尚未处理的提议也作废（已经应用的成长保留，可以在列表中撤销）
 */
function invalidateFrom(store, mesId) {
    let changed = false;
    if (job && job.chatId === ST.currentChatId() && job.to >= mesId) { cancelJob(); changed = true; }
    for (const s of (store.syncs || []).filter(x => x.to >= mesId)) {
        if ((store.syncedTo ?? -1) >= s.from) store.syncedTo = s.from - 1;
        changed = true;
    }
    store.syncs = (store.syncs || []).filter(x => x.to < mesId);
    if (store.syncedTo != null && store.syncedTo >= mesId) { store.syncedTo = mesId - 1; changed = true; }
    for (const it of store.items) if (it.mesId >= mesId && ACTIVE.includes(it.status)) { it.status = 'dismissed'; changed = true; }
    return changed;
}

/** 收到 AI 回复：到了设定的轮数就在后台同步（不等待，不阻塞 SillyTavern 处理消息） */
export function handleStoryMessage(app, mesId, type) {
    const cfg = app.settings.designer.story;
    if (!cfg.enabled || !ST.isEnabledForChat() || type === 'first_message') return;
    const msg = ST.getMessage(mesId);
    if (!msg || msg.is_user || msg.is_system) return;
    const store = ST.getStory(true);
    if (!store) return;
    if (type !== 'continue') invalidateFrom(store, mesId);
    // 第一次在这个聊天里同步：从开启后的新回复开始数（更早的楼层可以手动同步）
    if (store.syncedTo == null) store.syncedTo = mesId - 1;
    ST.saveStory();
    if (cfg.trigger !== 'manual' && countReplies(ST.ctx().chat || [], store.syncedTo, mesId) >= Math.max(1, Number(cfg.every) || 3)) {
        syncStory(app, { to: mesId }).catch(err => console.error('[Tavern-SRPG] 剧情同步失败', err));
    }
    app.render();
}

/** 滑动到另一条回复：这一楼的内容变了 */
export function handleStorySwiped(app, mesId) {
    const store = ST.getStory();
    if (store && invalidateFrom(store, mesId)) { ST.saveStory(); app.render(); }
}

/** 消息被删除：被删楼层上的同步与提议作废 */
export function handleStoryDeleted(app) {
    const store = ST.getStory();
    if (store && invalidateFrom(store, ST.chatLength())) { ST.saveStory(); app.render(); }
}

/** 切换聊天：放弃上一个聊天的同步，继续处理没做完的关卡 */
export function resumeStory(app) {
    if (job && job.chatId !== ST.currentChatId()) cancelJob();
    const store = ST.getStory();
    if (!store) return;
    for (const it of store.items) if (it.status === 'working') it.status = 'queued';
    if (store.items.some(it => it.status === 'queued')) processQueue(app);
}

/** 进行中、属于这张资料卡的战斗 */
function activeBattle(profile) {
    const b = ST.getBattle();
    return b?.active && !b.paused && b.profileId === profile.id ? b : null;
}

/**
 * 同步剧情：读取第 from–to 楼（默认从上次同步之后到最新一楼），交给插件配置的模型分析
 * @param {{from?:number|null, to?:number|null, manual?:boolean}} o
 * @returns {Promise<boolean>} 是否完成了一次同步
 */
export async function syncStory(app, { from = null, to = null, manual = false } = {}) {
    const cfg = app.settings.designer;
    const say = (type, text) => { if (manual) toast(type, text); };
    if (job) { say('info', '正在同步剧情，请稍候。'); return false; }
    const store = ST.getStory(true);
    const profile = ST.boundProfile();
    if (!store || !profile) { say('warning', '当前聊天没有绑定资料卡。'); return false; }
    const last = ST.chatLength() - 1;
    const end = Math.min(last, to ?? last);
    const w = syncWindow({ syncedTo: store.syncedTo ?? -1, to: end, depth: Number(cfg.story.chatDepth) || 20, from });
    if (end < 0 || w.from > end) { say('info', '没有新的剧情需要同步。'); return false; }
    const chatId = ST.currentChatId();
    const battle = activeBattle(profile);
    const me = job = { id: uid('sync'), chatId, from: w.from, to: end, abort: new AbortController(), cancelled: false };
    app.render();
    try {
        const ctx = await designContext(app);
        if (me.cancelled) return false;
        const prompt = buildSyncPrompt(profile, {
            before: w.start < w.from ? ST.chatSlice(w.start, w.from - 1, 6000) : '',
            fresh: ST.chatSlice(w.from, end),
            lore: ctx.lore, character: ctx.character,
            allowBattle: !!cfg.story.battle && !ST.getBattle()?.active,
            battle: battle ? app.battleContext() : '',
            commands: battle && app.settings.llm.commands ? commandGuide(app.settings.llm) : '',
        });
        const { text, truncated } = await designerGenerate(cfg, prompt, { signal: me.abort.signal });
        if (me.cancelled || ST.currentChatId() !== chatId) return false;
        const res = normalizeSync(parseDesignReply(text));
        store.syncedTo = Math.max(store.syncedTo ?? -1, end);
        store.syncs = [...(store.syncs || []), { from: w.from, to: end }].slice(-20);
        const found = deliverSync(app, store, res, { from: w.from, to: end, entries: ctx.entries, truncated, profile, battle });
        store.sync = { status: 'done', from: w.from, to: end, at: Date.now(), summary: res.summary, found, skipped: w.skipped };
        ST.saveStory();
        if (!found.length) say('info', `已同步到第 ${end} 楼：没有需要更新的内容。`);
        return true;
    } catch (err) {
        if (me.cancelled || ST.currentChatId() !== chatId) return false;
        store.sync = { status: 'error', from: w.from, to: end, at: Date.now(), error: err.message || String(err) };
        ST.saveStory();
        toast('warning', `剧情同步失败：${store.sync.error}`);
        return false;
    } finally {
        if (job === me) job = null;
        app.render();
    }
}

/** 把同步结果变成提议：成长（确认或自动应用）、剧情关卡（排队生成）、战场变化（确认或自动应用） */
function deliverSync(app, store, res, { from, to, entries, truncated, profile, battle }) {
    const cfg = app.settings.designer.story;
    const found = [];
    if (res.growth) {
        const g = normalizeGrowth(res.growth, profile, { entries });
        if (g.updates.length || g.design.units.length) {
            const names = [...g.updates.map(u => u.unitName), ...g.design.units.map(u => u.name)];
            const item = { id: uid('story'), kind: 'grow', subject: names.join('、'), text: res.summary, from, mesId: to, status: 'ready', at: Date.now(),
                json: res.growth, entries, truncated: !!truncated, profileId: profile.id };
            store.items.push(item);
            found.push(STORY_KINDS.grow);
            if (cfg.grow === 'auto') applyStoryGrowth(app, item);
            else toast('info', `剧情同步：${item.subject}有新的变化，打开「AI 设计」页查看并确认。`);
        }
    }
    if (res.battle && cfg.battle && !ST.getBattle()?.active) {
        store.items.push({ id: uid('story'), kind: 'battle', ...res.battle, from, mesId: to, status: 'queued', at: Date.now() });
        found.push(STORY_KINDS.battle);
    }
    if (res.commands.length && battle && app.settings.llm.commands && ST.getBattle() === battle && !battle.paused) {
        proposeCommands(app, battle, parseCommands(res.commands.join('\n')), to);
        found.push('战场变化');
    }
    store.items = store.items.slice(-30);
    if (store.items.some(x => x.status === 'queued')) processQueue(app);
    return found;
}

// ---------------------------------------------------------------- 剧情关卡（以及旧版留下的成长请求）

let running = false;

export async function processQueue(app) {
    if (running) return;
    running = true;
    try {
        for (;;) {
            const item = ST.getStory()?.items.find(x => x.status === 'queued');
            if (!item) break;
            await runItem(app, item);
        }
    } finally {
        running = false;
        app.render();
    }
}

/** 为一条提议生成内容（关卡或成长） */
async function runItem(app, item) {
    const cfg = app.settings.designer;
    const chatId = ST.currentChatId();
    item.status = 'working'; item.error = '';
    app.render();
    try {
        const ctx = await designContext(app, { chat: true, upTo: item.mesId });
        const hint = `${item.subject}${item.text ? `：${item.text}` : ''}`;
        const prompt = item.kind === 'grow'
            ? buildGrowthPrompt(app.data, { hint, chat: ctx.chat, lore: ctx.lore, character: ctx.character })
            : buildDesignPrompt(app.data, { task: 'story', request: hint, size: { w: 12, h: 8 }, chat: ctx.chat, lore: ctx.lore, character: ctx.character });
        const { text, truncated } = await designerGenerate(cfg, prompt);
        if (ST.currentChatId() !== chatId) return; // 聊天已切换：回到那个聊天时会重新处理
        if (item.status !== 'working') return; // 生成期间楼层被重新生成、删除或提议被忽略：结果作废
        Object.assign(item, { json: parseDesignReply(text), truncated: !!truncated, entries: ctx.entries, status: 'ready', profileId: app.data.id });
        if (item.kind === 'grow' && cfg.story.grow === 'auto') {
            applyStoryGrowth(app, item);
        } else {
            toast('info', `「${item.subject}」的${STORY_KINDS[item.kind]}已生成，打开「AI 设计」页查看并确认。`);
        }
    } catch (err) {
        if (ST.currentChatId() !== chatId || item.status !== 'working') return;
        item.status = 'error';
        item.error = err.message || String(err);
        toast('warning', `「${item.subject}」的${STORY_KINDS[item.kind]}生成失败：${item.error}`);
    }
    ST.saveStory();
    app.render();
}

// ---------------------------------------------------------------- 应用与撤销成长

/** 进行中的战斗（需要同步成长时） */
function liveBattle(app) {
    const b = ST.getBattle();
    return app.settings.designer.story.syncBattle && b?.active && !b.paused && b.profileId === app.data.id ? b : null;
}

/**
 * 应用一条剧情成长；chosen 为空时全部应用
 * @returns {object|null} applyGrowth 的结果
 */
export function applyStoryGrowth(app, item, chosen = null, growth = null) {
    if (item.profileId && item.profileId !== app.data.id) { toast('warning', '这条成长是为另一张资料卡生成的，请先切换回那张资料卡。'); return null; }
    const g = growth || normalizeGrowth(item.json, app.data, { entries: item.entries || [] });
    const battle = liveBattle(app);
    const res = applyGrowth(app.data, g, chosen || new Set(growthIds(g)), battle);
    if (!res.lines.length) { toast('info', '没有可应用的变化。'); return res; }
    app.save();
    if (battle) {
        battle.pending.push({ type: 'growth', turn: battle.turn, text: res.lines.join('；') });
        ST.saveBattle();
        app.updateInjection();
    }
    Object.assign(item, { status: 'applied', applied: { before: res.before, newIds: res.newIds, lines: res.lines, profileId: app.data.id } });
    ST.saveStory();
    toast('success', `剧情成长：${res.lines.join('；')}${battle && res.synced ? '（已同步到当前战斗）' : ''}`);
    app.render();
    return res;
}

/** 撤销已应用的成长（只恢复资料卡；进行中战斗里的变化不回退） */
export function undoStoryGrowth(app, item) {
    const a = item.applied;
    if (!a) return;
    if (a.profileId !== app.data.id) return toast('warning', '这条成长属于另一张资料卡，请先切换回那张资料卡。');
    revertGrowth(app.data, a.before, a.newIds);
    app.save();
    item.status = 'ready';
    delete item.applied;
    ST.saveStory();
    toast('info', `已撤销「${item.subject}」的成长（进行中战斗里的变化需要用「撤销」或手动修改恢复）。`);
    app.render();
}

export function retryStory(app, item) {
    item.status = 'queued';
    ST.saveStory();
    processQueue(app);
}

export function dismissStory(app, item) {
    item.status = 'dismissed';
    ST.saveStory();
    app.render();
}

/** 已生成待确认的提议数量，用于悬浮按钮角标 */
export function readyStoryCount() {
    return (ST.getStory()?.items || []).filter(x => x.status === 'ready').length;
}
