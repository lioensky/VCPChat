// 浮动主面板：标签页切换、拖动、尺寸记忆
import { h, clear, button } from './dom.js';
import { renderBattleTab, newBattleUi } from './battle.js';
import { renderUnitsTab, renderTypesTab, renderTerrainsTab, renderMapsTab, newEditorUi } from './editors.js';
import { renderSettingsTab } from './settings.js';
import { renderProfilesTab } from './profiles-tab.js';
import { renderDesignerTab } from './designer-tab.js';
import { getProfile } from '../profiles.js';
import { toast } from './dom.js';
import { buildBattleContext } from '../context.js';
import { alive } from '../engine.js';
import { unitLoreList, buildUnitLore } from '../unit-lore.js';
import { resumeStory, readyStoryCount, syncStory, syncInfo } from './story-flow.js';
import * as ST from '../st.js';

const TABS = [
    ['battle', '战场', 'fa-chess-board', renderBattleTab],
    ['profiles', '资料卡', 'fa-address-card', renderProfilesTab],
    ['units', '单位', 'fa-users', renderUnitsTab],
    ['types', '兵种', 'fa-chess', renderTypesTab],
    ['terrains', '地形', 'fa-mountain-sun', renderTerrainsTab],
    ['maps', '地图', 'fa-map', renderMapsTab],
    ['design', 'AI 设计', 'fa-wand-magic-sparkles', renderDesignerTab],
    ['settings', '设置', 'fa-gear', renderSettingsTab],
];

export class App {
    constructor() {
        this.bs = newBattleUi();
        this.ed = newEditorUi();
        this.panel = null;
        this.body = null;
        this.tabBar = null;
        this.injectSeq = 0;
        this.wbCache = {}; // uid -> 世界书条目内容（供宏和工具同步读取）
    }

    get settings() {
        return ST.getSettings();
    }

    save() {
        ST.saveSettings();
    }

    /** 当前使用的资料卡（单位、地形、地图、战斗规则） */
    get data() {
        const s = this.settings;
        let p = getProfile(s, s.activeProfile);
        if (!p) {
            p = s.profiles[0];
            s.activeProfile = p.id;
        }
        return p;
    }

    /** 切换资料卡 */
    switchProfile(id, { quiet = false } = {}) {
        const s = this.settings;
        const p = getProfile(s, id);
        if (!p || s.activeProfile === id) return false;
        s.activeProfile = id;
        this.save();
        this.ed = newEditorUi();
        this.bs.setupMap = null;
        if (!quiet) toast('info', `已切换到资料卡「${p.name}」`);
        this.render();
        return true;
    }

    /** 当前角色 / 群组必须显式绑定；不从默认卡或角色卡内附带数据自动启用。 */
    async syncProfileWithChat() {
        const owner = ST.currentOwner();
        const s = this.settings;
        const target = ST.boundProfile(s, owner);
        const stamp = target ? `${owner.key}:${target.id}` : '';
        if (stamp !== this.lastBindingKey) {
            this.bs.cancelReaction?.();
            this.bs = newBattleUi();
            this.wbCache = {}; ++this.injectSeq; ST.setInjection('');
            this.lastBindingKey = stamp;
        }
        if (!target) {
            this._open = false;
            if (this.panel) this.panel.hidden = true;
            this.wbCache = {};
        } else if (target.id !== s.activeProfile) {
            this.switchProfile(target.id, { quiet: true });
        }
        this.placeFab();
        this.refreshMessageFolding?.();
        await this.updateInjection();
    }

    get isOpen() {
        return !!this.panel && !!this._open;
    }

    mount() {
        this.tabBar = h('div.tsrpg-tabs');
        this.body = h('div.tsrpg-body');
        this.layoutBtn = button('', () => this.setLayout(this.settings.ui.layout === 'compact' ? 'float' : 'compact'), { cls: 'tsrpg-icon-btn' });
        // 剧情同步：开启后在标题栏显示，点击立即读取到最新一楼
        this.syncBadge = h('span.tsrpg-sync-badge', { hidden: true });
        this.syncBtn = button('', () => syncStory(this, { manual: true }), { icon: 'fa-book-open-reader', cls: 'tsrpg-icon-btn tsrpg-sync-btn' });
        this.syncBtn.append(this.syncBadge);
        const header = h('div.tsrpg-header',
            h('div.tsrpg-title', h('i.fa-solid.fa-chess-knight'), h('span', ' Tavern-SRPG')),
            this.tabBar,
            this.syncBtn,
            this.layoutBtn,
            button('', () => this.toggle(false), { icon: 'fa-xmark', cls: 'tsrpg-icon-btn', title: '收起（点击悬浮按钮可再次打开）' }),
        );
        this.panel = h('div#tsrpg-panel.tsrpg-panel', { hidden: true }, header, this.body);
        document.body.append(this.panel);
        this.mountFab();
        this.applyLayout();
        this.enableDrag(header);

        // 记住浮动窗口的尺寸；宽度变化时切换紧凑布局并重新适配棋盘
        let t = null, lastW = 0;
        new ResizeObserver(() => {
            if (!this.isOpen) return;
            const w = this.panel.getBoundingClientRect().width;
            this.panel.classList.toggle('narrow', w < 640);
            clearTimeout(t);
            t = setTimeout(() => {
                const r = this.panel.getBoundingClientRect();
                if (this.settings.ui.layout === 'float' && window.innerWidth >= 700) {
                    Object.assign(this.settings.ui, { width: Math.round(r.width), height: Math.round(r.height) });
                    this.save();
                }
                if (this.settings.ui.layout === 'compact' && r.bottom > window.innerHeight) {
                    this.panel.style.top = `${Math.max(0, window.innerHeight - r.height)}px`;
                }
                if (Math.abs(r.width - lastW) > 8) { lastW = r.width; this.render(); }
            }, 200);
        }).observe(this.panel);
        window.addEventListener('resize', () => { this.applyLayout(); this.render(); });
    }

    /** 完整窗口与仅保留战斗操作的小窗。旧停靠设置迁移为小窗。 */
    applyLayout() {
        const { ui } = this.settings;
        if (ui.layout === 'dock') { ui.layout = 'compact'; this.save(); }
        const compact = ui.layout === 'compact';
        const p = this.panel;
        p.classList.remove('dock');
        p.classList.toggle('float', !compact);
        p.classList.toggle('compact', compact);
        p.style.cssText = '';
        if (!compact) {
            if (ui.width) p.style.width = `${ui.width}px`;
            if (ui.height) p.style.height = `${ui.height}px`;
        }
        const pos = compact ? ui.compactPos : ui;
        if (pos?.left != null && pos?.top != null) {
            p.style.left = `${Math.max(0, Math.min(pos.left, window.innerWidth - (compact ? Math.min(460, window.innerWidth - 20) : 120)))}px`;
            p.style.right = 'auto';
            p.style.top = `${Math.max(0, Math.min(pos.top, window.innerHeight - (compact ? this.panel.getBoundingClientRect().height || 60 : 60)))}px`;
        }
        p.hidden = !this.isOpenState;
        clear(this.layoutBtn).append(h(`i.fa-solid.${compact ? 'fa-expand' : 'fa-compress'}`));
        this.layoutBtn.title = compact ? '恢复完整窗口' : '缩小为战斗小窗';
        this.placeFab();
    }

    setLayout(layout) {
        this.settings.ui.layout = layout;
        this.save();
        this.applyLayout();
        this.render();
    }

    enableDrag(handle) {
        let start = null;
        handle.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.target.closest('button, .tsrpg-tab') || (this.settings.ui.layout !== 'compact' && window.innerWidth < 700)) return;
            const r = this.panel.getBoundingClientRect();
            start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
            e.preventDefault();
        });
        window.addEventListener('pointermove', e => {
            if (!start) return;
            const compact = this.settings.ui.layout === 'compact';
            const r = this.panel.getBoundingClientRect();
            const left = Math.max(0, Math.min(window.innerWidth - (compact ? r.width : 80), start.left + e.clientX - start.x));
            const top = Math.max(0, Math.min(window.innerHeight - (compact ? r.height : 40), start.top + e.clientY - start.y));
            this.panel.style.left = `${left}px`;
            this.panel.style.top = `${top}px`;
        });
        window.addEventListener('pointerup', () => {
            if (!start) return;
            start = null;
            const r = this.panel.getBoundingClientRect();
            const pos = { left: Math.round(r.left), top: Math.round(r.top) };
            if (this.settings.ui.layout === 'compact') this.settings.ui.compactPos = pos;
            else Object.assign(this.settings.ui, pos);
            this.save();
        });
        window.addEventListener('pointercancel', () => { start = null; });
    }

    // ---------------------------------------------------------------- 悬浮按钮

    mountFab() {
        this.fabBadge = h('span.tsrpg-fab-badge', { hidden: true });
        this.fab = h('div#tsrpg-fab.tsrpg-fab', { title: 'Tavern-SRPG 战棋（可拖动）' }, h('i.fa-solid.fa-chess-knight'), this.fabBadge);
        document.body.append(this.fab);
        let start = null;
        const onMove = e => {
            if (!start) return;
            const dx = e.clientX - start.x, dy = e.clientY - start.y;
            if (!start.moved && Math.hypot(dx, dy) < 5) return;
            start.moved = true;
            const right = Math.max(4, Math.min(window.innerWidth - 52, start.right - dx));
            const bottom = Math.max(4, Math.min(window.innerHeight - 52, start.bottom - dy));
            Object.assign(this.fab.style, { right: `${right}px`, bottom: `${bottom}px` });
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            if (!start) return;
            const moved = start.moved;
            start = null;
            if (moved) {
                const r = this.fab.getBoundingClientRect();
                this.settings.ui.fabPos = { right: Math.round(window.innerWidth - r.right), bottom: Math.round(window.innerHeight - r.bottom) };
                this.save();
            } else {
                this.toggle();
            }
        };
        this.fab.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            const r = this.fab.getBoundingClientRect();
            start = { x: e.clientX, y: e.clientY, right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom, moved: false };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            e.preventDefault();
        });
        this.placeFab();
    }

    placeFab() {
        if (!this.fab) return;
        const { ui } = this.settings;
        const pos = ui.fabPos || { right: 20, bottom: 140 };
        Object.assign(this.fab.style, {
            right: `${Math.max(4, Math.min(window.innerWidth - 52, pos.right))}px`,
            bottom: `${Math.max(4, Math.min(window.innerHeight - 52, pos.bottom))}px`,
        });
        // 窗口打开时隐藏悬浮按钮，避免遮挡地图和操作。
        const hide = ui.fab === false || this.isOpen || !ST.isEnabledForChat();
        this.fab.hidden = hide;
        this.fab.classList.toggle('open', this.isOpen);
        this.updateSqueeze();
    }

    /** 清理旧停靠模式留下的聊天区域偏移。 */
    updateSqueeze() {
        document.body.classList.remove('tsrpg-squeeze');
        document.body.style.removeProperty('--tsrpg-dock-width');
    }

    /** 标题栏的剧情同步按钮：同步中显示动画，角标是上次同步之后的新回复数 */
    updateSyncButton() {
        if (!this.syncBtn) return;
        const on = !!this.settings.designer?.story?.enabled && ST.isEnabledForChat();
        this.syncBtn.hidden = !on;
        if (!on) return;
        const info = syncInfo();
        const working = !!info.working;
        this.syncBtn.classList.toggle('working', working);
        this.syncBtn.querySelector('i')?.classList.toggle('fa-fade', working);
        this.syncBadge.hidden = working || !info.fresh;
        this.syncBadge.textContent = info.fresh ? String(info.fresh) : '';
        this.syncBtn.title = working ? `正在同步第 ${info.working.from}–${info.working.to} 楼的剧情……`
            : `同步剧情：由插件模型读取${info.syncedTo == null ? '最近的聊天' : `第 ${info.syncedTo} 楼之后的 ${info.fresh} 轮新回复`}，更新角色成长、关卡和战场`;
    }

    /** 悬浮按钮上的提示：LLM 提议的战场变化数量 */
    updateFab() {
        this.updateSyncButton();
        if (!this.fabBadge) return;
        const n = (ST.getBattle()?.llm?.proposals?.cmds?.length || 0) + readyStoryCount();
        this.fabBadge.hidden = !n;
        this.fabBadge.textContent = n ? String(n) : '';
        this.fab.classList.toggle('active', !!ST.getBattle()?.active);
    }

    /**
     * 根据面板大小决定格子大小（不超过设置中的上限）
     * @param {number} w 地图宽度（格）
     * @param {number} reserve 宽面板时棋盘旁边信息栏 / 列表占用的宽度
     * @param {number} [rows] 地图高度（格）：给出时棋盘高度也不超过可用高度
     */
    cellFor(w, reserve = 0, rows = 0) {
        const compact = this.settings.ui.layout === 'compact';
        const max = compact ? Math.min(36, Number(this.settings.ui.cell) || 48) : Number(this.settings.ui.cell) || 48;
        const avail = (this.body?.clientWidth || 600) - 36;
        const narrow = compact || this.panel?.classList.contains('narrow');
        const room = narrow ? avail : avail - reserve;
        let cell = Math.floor(room / Math.max(1, w)) - 1;
        if (rows && !compact) {
            // 宽面板：棋盘与信息栏并排，棋盘尽量占满高度；窄面板：棋盘上方还有标题和任务栏
            const height = (this.body?.clientHeight || 600) - (narrow ? 150 : 120);
            cell = Math.min(cell, Math.floor(height / Math.max(1, rows)) - 1);
        }
        return Math.max(18, Math.min(max, cell));
    }

    get isOpenState() {
        return !!this._open;
    }

    toggle(force) {
        if (!this.panel) return;
        const open = force ?? !this._open;
        if (open && !ST.isEnabledForChat()) {
            this.settings.ui.layout = 'float'; this.settings.ui.tab = 'profiles';
            this.save(); this.applyLayout();
        }
        if (!open) this.bs.cancelReaction?.();
        this._open = open;
        this.panel.hidden = !open;
        this.placeFab();
        if (open) this.render();
    }

    setTab(id) {
        this.settings.ui.tab = id;
        this.save();
        this.render();
    }

    render() {
        if (!this.isOpen) { this.updateFab(); return; }
        // 先按当前宽度决定布局，棋盘格子大小依赖它
        this.panel.classList.toggle('narrow', this.panel.getBoundingClientRect().width < 640);
        this.updateSqueeze();
        const s = this.settings;
        if (!TABS.some(t => t[0] === s.ui.tab)) s.ui.tab = 'battle';
        clear(this.tabBar).append(...TABS.map(([id, label, icon]) =>
            h(`div.tsrpg-tab${id === s.ui.tab ? '.active' : ''}`, { onclick: () => this.setTab(id), title: label },
                h(`i.fa-solid.${icon}`), h('span', label))));
        const scroll = this.body.scrollTop;
        // 编辑器左右两栏各自滚动：重新渲染后恢复同一列表 / 同一条目的滚动位置
        const inner = new Map([...this.body.querySelectorAll?.('[data-scroll]') || []].map(el => [el.dataset.scroll, el.scrollTop]));
        const renderer = s.ui.layout === 'compact' ? renderBattleTab : TABS.find(t => t[0] === s.ui.tab)[3];
        const bound = ST.boundProfile(s);
        if (renderer === renderBattleTab && bound && s.activeProfile !== bound.id) {
            s.activeProfile = bound.id; this.ed = newEditorUi(); this.bs.setupMap = null; this.save();
        }
        try {
            renderer(this, this.body);
        } catch (err) {
            console.error('[Tavern-SRPG]', err);
            clear(this.body).append(h('div.tsrpg-empty', `界面渲染出错：${err.message || err}`));
        }
        this.body.scrollTop = scroll;
        this.body.querySelectorAll?.('[data-scroll]').forEach(el => { if (inner.has(el.dataset.scroll)) el.scrollTop = inner.get(el.dataset.scroll); });
        this.updateFab();
    }

    async onChatChanged() {
        this.bs.cancelReaction?.();
        this.wbCache = {}; ++this.injectSeq; ST.setInjection('');
        this.endBattleDialog?.remove(); this.endBattleDialog = null;
        this.panel?.querySelectorAll('.tsrpg-overlay').forEach(el => el.remove());
        this.bs = newBattleUi();
        try {
            await this.syncProfileWithChat();
            resumeStory(this);
        } catch (err) {
            console.warn('[Tavern-SRPG] 同步资料卡失败', err);
        }
        this.render();
    }

    /**
     * 给 LLM 看的战场信息
     * @param {string[]} [sections] 只输出某些部分：mission / map / units / log
     */
    battleContext(sections) {
        const b = ST.getBattle();
        if (!b?.active || b.paused) return '';
        const { inject: inj } = this.settings;
        const opts = { ...inj, sections, rules: this.data.rules };
        if (sections) Object.assign(opts, { map: true, legend: true, stats: true, skills: true, nearest: true });
        const text = buildBattleContext(b, opts, inj.includeWb ? this.wbCache : {});
        // 替换别名、世界书内容里的 {{user}} {{char}}，让宏、工具、注入看到的都是真实名字
        return ST.substitute(text);
    }

    /**
     * 单位资料：资料卡中的单位按关键词（或总是）提供给聊天 AI
     * @returns {{text:string, used:string[], list:object[]}}
     */
    unitLore() {
        const cfg = this.settings.inject.units;
        const profile = ST.boundProfile();
        if (!cfg?.enabled || !profile) return { text: '', used: [], list: [] };
        // 战场信息已经注入时，场上单位以战场状态为准，不重复提供
        const b = ST.getBattle();
        const exclude = new Set(b?.active && !b.paused && this.settings.inject.enabled ? alive(b).map(u => u.defId) : []);
        const list = unitLoreList(profile, { scope: cfg.scope, exclude, subst: ST.substitute, skills: cfg.skills !== false });
        return { ...buildUnitLore(list, { trigger: cfg.trigger, scanText: ST.scanText(Number(cfg.scanDepth) || 4) }), list };
    }

    /** 开关关闭时的预览：按当前设置列出全部单位 */
    unitLorePreview() {
        const cfg = this.settings.inject.units;
        const list = unitLoreList(ST.boundProfile() || this.data, { scope: cfg.scope, subst: ST.substitute, skills: cfg.skills !== false });
        return buildUnitLore(list, { trigger: 'constant' }).text;
    }

    updateUnitLore() {
        ST.setUnitLoreInjection(this.unitLore().text);
    }

    /** 把战场信息与单位资料注入到提示词中（只提供资料，不要求聊天 AI 输出任何标记） */
    async updateInjection() {
        this.updateUnitLore();
        const seq = ++this.injectSeq;
        const s = this.settings;
        const b = ST.getBattle();
        if (!b?.active || b.paused) {
            this.wbCache = {};
            ST.setInjection('');
            return;
        }
        if (s.inject.includeWb) {
            const wb = {};
            for (const u of alive(b)) {
                if (!u.wb) continue;
                const text = await ST.getEntryContent(u.wb);
                if (text) wb[u.uid] = text;
            }
            if (seq !== this.injectSeq) return; // 已有更新的调用
            if (ST.getBattle() !== b || b.paused) { this.wbCache = {}; ST.setInjection(''); return; }
            this.wbCache = wb;
        }
        ST.setInjection(s.inject.enabled ? this.battleContext() : '', s.inject);
    }
}
