// 全局设置「桌宠」分区的面板（自包含 DOM + 行为）。
//
//   上面：当前桌宠的大预览，脚边是和桌面上一样的小胶囊（DeskPetmodules/dock.css 同一份样式），
//         点打字展开成输入条、点说话变成录音按钮；在这里打的字由桌宠发出去，回复显示在桌宠头上。
//   中间：我的桌宠——选助手，再从它的几套形象里挑一张卡片（「无」是收起这个助手的桌宠），
//         卡片上是离屏渲染的快照（主进程 modules/deskpet/petPreviews.js），渲染好一张换一张。
//   下面：免打扰、启动恢复、全局快捷键。
//
// 这里只拼装：每块的结构和行为在 ./settings/ 下（dock、stage、catalog、cubismCore、
// expressionMapping、options、shortcuts），共用的 state / note / 刷新回调由 ctx 传进去。
// 主进程：modules/deskpet/settingsPage.js、petControls.js（deskpet-settings:*）。不进表单 collect/自动保存。
// 编译期（JSDOM 契约检查）没有 electronAPI，只产出结构。

import { el } from './settings/dom.js';
import { buildDock, wireDock } from './settings/dock.js';
import { buildStage, wireStage } from './settings/stage.js';
import { buildCatalog, wireCatalog } from './settings/catalog.js';
import { buildCore, wireCore } from './settings/cubismCore.js';
import { buildMapping, wireMapping } from './settings/expressionMapping.js';
import { buildOptions, wireOptions } from './settings/options.js';
import { buildShortcuts, wireShortcuts } from './settings/shortcuts.js';

const CATALOG_DEBOUNCE_MS = 150;

function getApi(doc) {
    const win = doc?.defaultView;
    const api = win?.chatAPI || win?.electronAPI;
    return api && typeof api.getDeskPetCatalog === 'function' ? api : null;
}

export function buildDeskPetPanel(doc) {
    const root = el(doc, 'div', 'dps');
    root.id = 'deskPetSettingsPanel';

    // ---- 结构 ----
    const dockParts = buildDock(doc);
    const stageParts = buildStage(doc, dockParts.dock);
    const catalogParts = buildCatalog(doc);
    const mapParts = buildMapping(doc);
    const coreParts = buildCore(doc);
    const optionParts = buildOptions(doc);
    const shortcutParts = buildShortcuts(doc);

    root.append(
        stageParts.intro, stageParts.stage, stageParts.drawer,
        catalogParts.head, catalogParts.grid, mapParts.mapSection,
        coreParts.coreTitle, coreParts.coreCard,
        optionParts.optionsTitle, optionParts.options,
        shortcutParts.shortcutsTitle, shortcutParts.shortcuts,
    );

    // 设置表单的自动保存不碰这里的控件
    const keepInside = (e) => e.stopPropagation();
    root.addEventListener('input', keepInside);
    root.addEventListener('change', keepInside);
    root.addEventListener('submit', keepInside);

    const api = getApi(doc);
    if (!api) {
        stageParts.lead.textContent = '桌宠设置只能在 VCPChat 里打开。';
        return root;
    }
    const win = doc.defaultView;

    // ---- 状态 ----
    const state = {
        snapshot: null,
        catalog: null,
        agentId: null,
        recording: null, // 正在录快捷键的动作 id
        errors: {},
        drawerOpen: false,
        voice: null,
        fresh: false, // 输入条上的「+」按下了：下一句开新话题
        placeholder: '',
        visible: false,
        loadSeq: 0,
        shownOutfit: undefined,
    };

    // 各块共用的上下文：文档、IPC、状态，和互相叫一声的回调（都在下面填齐）
    const ctx = {
        doc,
        win,
        api,
        state,
        stage: stageParts.stage,
        applyCatalog: (catalog, options) => applyCatalog(catalog, options),
        applySnapshot: (snapshot) => applySnapshot(snapshot),
        loadCatalog: (agentId, options) => loadCatalog(agentId, options),
        scheduleReload: () => scheduleReload(),
        renderStage: () => stageApi.renderStage(),
        // 懒加载的两份桌宠代码：路径按本文件算
        loadDictation: () => import('../dictation.js'),
        loadExpressionMap: () => import('../expressionMap.js'),
    };

    const stageApi = wireStage(ctx, stageParts);
    ctx.note = stageApi.note;
    ctx.dock = wireDock(ctx, dockParts);
    const catalogApi = wireCatalog(ctx, catalogParts);
    ctx.catalog = catalogApi;
    const coreApi = wireCore(ctx, coreParts);
    const mapApi = wireMapping(ctx, mapParts);
    const optionsApi = wireOptions(ctx, optionParts);
    const shortcutsApi = wireShortcuts(ctx, shortcutParts);

    // ---- 拉数据、把快照和目录摊到各块上 ----

    function applyCatalog(catalog, { fresh = false } = {}) {
        const switched = state.catalog?.agentId !== catalog?.agentId;
        state.catalog = catalog;
        state.agentId = catalog?.agentId || null;
        // 装好 Cubism Core 以后同一套的种类和介绍会变，卡片也要重建
        const rebuild = fresh || switched || catalogApi.stampOutfits(catalog);
        catalogApi.renderAgents();
        stageApi.renderIntro();
        stageApi.renderStage();
        stageApi.renderDrawer();
        catalogApi.renderGrid(rebuild);
        coreApi.renderCore();
        mapApi.renderMapSection();
    }

    async function loadCatalog(agentId = state.agentId, { refresh = false } = {}) {
        const seq = ++state.loadSeq;
        root.classList.toggle('is-busy', true);
        try {
            const catalog = await (refresh ? api.refreshDeskPetCatalog(agentId) : api.getDeskPetCatalog(agentId));
            if (seq !== state.loadSeq || !catalog) return;
            applyCatalog(catalog, { fresh: refresh });
        } finally {
            if (seq === state.loadSeq) root.classList.toggle('is-busy', false);
        }
    }

    let reloadTimer = 0;
    function scheduleReload() {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
            if (!state.visible) return;
            // 正在换卡片：等它换完再刷新（桌宠刚显示出来的推送常常落在这时候，丢了的话会一直显示「已隐藏」）
            if (state.choosing) state.reloadPending = true;
            else loadCatalog();
        }, CATALOG_DEBOUNCE_MS);
    }

    function applySnapshot(snapshot) {
        if (!snapshot) return;
        const before = JSON.stringify(state.snapshot?.pets || null);
        state.snapshot = snapshot;
        optionsApi.renderSwitches();
        shortcutsApi.renderShortcuts();
        stageApi.renderIntro();
        // 桌宠开了、关了、换了装、改了大小（右键菜单、托盘、快捷键）：卡片和预览跟着变
        if (before !== JSON.stringify(snapshot.pets || null)) scheduleReload();
    }

    // ---- 生命周期：分区显示出来才拉数据、才渲染快照 ----

    const unsubscribe = [
        api.onDeskPetSettingsChanged?.((snapshot) => {
            if (!root.isConnected) return;
            applySnapshot(snapshot);
        }),
        api.onDeskPetCoreProgress?.((progress) => {
            if (!root.isConnected) return;
            coreApi.onProgress(progress);
        }),
        api.onDeskPetPreview?.(({ agentId, outfitId, url } = {}) => {
            if (!root.isConnected || agentId !== state.agentId || !state.catalog) return;
            if (!catalogApi.setOutfitPreview(outfitId, url)) return;
            if (state.catalog.outfit === outfitId) stageApi.renderStage();
        }),
    ].filter(Boolean);

    function onShown() {
        state.visible = true;
        api.getDeskPetSettings().then(applySnapshot).catch(() => {});
        loadCatalog().catch((error) => ctx.note(`读不到桌宠：${error.message}`, { error: true }));
    }

    function onHidden() {
        state.visible = false;
        ctx.dock.cancelVoice();
        if (ctx.dock.mode() !== 'bar' || !ctx.dock.hasText()) ctx.dock.setDock('pill');
        if (state.recording) shortcutsApi.stopRecording();
    }

    if (typeof win.IntersectionObserver === 'function') {
        const observer = new win.IntersectionObserver((entries) => {
            if (!root.isConnected) {
                observer.disconnect();
                for (const off of unsubscribe) off?.();
                return;
            }
            const shown = entries.some((entry) => entry.isIntersecting);
            if (shown && !state.visible) onShown();
            else if (!shown && state.visible) onHidden();
        });
        observer.observe(root);
    } else {
        onShown();
    }

    // 切到别的窗口时停止录快捷键，也把暂停的快捷键恢复
    win.addEventListener('blur', () => { if (state.recording) shortcutsApi.stopRecording(); });
    stageApi.renderStage();
    stageApi.renderIntro();
    return root;
}
