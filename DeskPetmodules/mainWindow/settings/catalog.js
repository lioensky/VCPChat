// 我的桌宠：选助手的下拉、刷新、导入形象，和下面那排形象卡片（「无」是收起这个助手的桌宠）。
// 卡片上的图是主进程离屏渲染的快照（modules/deskpet/petPreviews.js），渲染好一张换一张。

import { el, button, icon } from './dom.js';

export function buildCatalog(doc) {
    const head = el(doc, 'div', 'dps-head');
    const headTitle = el(doc, 'h4', 'dps-subtitle', '我的桌宠');
    const agentSelect = el(doc, 'select', 'dps-agent');
    agentSelect.setAttribute('aria-label', '选择助手');
    // 自己管样式和行为：设置页的下拉投影不接管它
    agentSelect.dataset.vcpTypedPrimitiveMounted = 'true';
    const spacer = el(doc, 'span', 'dps-spacer');
    const refreshBtn = button(doc, 'dps-icon-btn', undefined, { title: '重新扫描形象、重画预览', 'aria-label': '刷新' });
    refreshBtn.append(icon(doc, 'refresh'));
    const importBtn = button(doc, 'dps-btn', '导入形象', { title: '选择 Live2D、网格立绘、Codex 桌宠的 pet.json、ZIP 或立绘；也可以直接拖入文件夹' });
    head.append(headTitle, agentSelect, spacer, refreshBtn, importBtn);
    const grid = el(doc, 'div', 'dps-grid');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', '桌宠形象');
    return { head, agentSelect, refreshBtn, importBtn, grid };
}

// ctx：{ doc, api, state, note, dock, applyCatalog, loadCatalog, scheduleReload }
export function wireCatalog(ctx, parts) {
    const { doc, api, state } = ctx;
    const { agentSelect, refreshBtn, importBtn, grid } = parts;

    // ---- 卡片 ----

    function cardFor(item) {
        const card = button(doc, 'dps-pet-card', undefined, { role: 'radio' });
        card.dataset.outfit = item ? item.id : '';
        const art = el(doc, 'span', 'dps-pet-art');
        if (!item) {
            // 「无」：只有一个小胶囊，和桌面上什么都不放时一样
            const mini = el(doc, 'span', 'dps-mini-pill');
            mini.append(icon(doc, 'edit'), el(doc, 'i'), icon(doc, 'voice'), el(doc, 'i'), icon(doc, 'collapse'));
            art.append(mini);
        } else {
            art.classList.add('is-loading');
            const img = el(doc, 'img');
            img.alt = '';
            img.draggable = false;
            img.decoding = 'async';
            img.addEventListener('load', () => art.classList.remove('is-loading'));
            art.append(img);
        }
        const name = el(doc, 'span', 'dps-pet-name', item ? item.name : '无');
        const desc = el(doc, 'span', 'dps-pet-desc', item ? item.description : '不放桌宠，只用主窗口');
        card.append(art, name, desc);
        if (item?.kindLabel && item.kindLabel !== item.name) card.append(el(doc, 'span', 'dps-pet-kind', item.kindLabel));
        card.addEventListener('click', () => choose(item ? item.id : ''));
        return card;
    }

    function setCardPreview(card, url) {
        const img = card.querySelector('.dps-pet-art img');
        if (!img) return;
        const art = card.querySelector('.dps-pet-art');
        if (!url) {
            art.classList.remove('is-loading');
            art.classList.add('is-failed');
            return;
        }
        if (img.getAttribute('src') === url) return;
        art.classList.add('is-loading');
        img.src = url;
    }

    function renderGrid(fresh) {
        const c = state.catalog;
        if (fresh) {
            grid.replaceChildren();
            if (!c?.agentId) {
                grid.append(el(doc, 'p', 'dps-empty', '还没有助手。关掉设置，在「助手」页点「创建助手或群组」建一个；起名叫 Nova 会直接用上内置的 Nova 形象。'));
                return;
            }
            const cards = [cardFor(null), ...c.outfits.map(cardFor)];
            cards.forEach((card, i) => {
                card.style.setProperty('--i', String(i));
                grid.append(card);
            });
            if (!c.outfits.length) {
                const empty = el(doc, 'p', 'dps-empty', '这个助手还没有形象：现在显示的是头像。可以导入 Live2D、Codex 桌宠或立绘。');
                grid.append(empty);
            }
        }
        // 没选形象、桌宠却开着（显示桌宠、快捷键打开的）：桌面上是头像，「无」那张卡照实说
        const none = grid.querySelector('.dps-pet-card[data-outfit=""]');
        if (none) {
            const avatarShown = Boolean(c?.open && !c?.outfit);
            none.querySelector('.dps-pet-name').textContent = avatarShown ? '头像' : '无';
            none.querySelector('.dps-pet-desc').textContent = avatarShown ? '没选形象，桌面上显示的是头像。点这里收起' : '不放桌宠，只用主窗口';
        }
        for (const card of grid.querySelectorAll('.dps-pet-card')) {
            const id = card.dataset.outfit;
            const selected = (c?.outfit || '') === id;
            card.classList.toggle('is-selected', selected);
            card.setAttribute('aria-checked', String(selected));
            card.disabled = state.choosing === true;
            const item = c?.outfits?.find((o) => o.id === id);
            if (item?.preview) setCardPreview(card, item.preview);
        }
    }

    async function choose(outfitId) {
        const c = state.catalog;
        if (!c?.agentId || state.choosing) return;
        // 「无」只在桌宠真的关着时算已选；开着头像时点它是收起
        if ((c.outfit || '') === outfitId && (outfitId === '' ? !c.open : c.visible)) return;
        state.choosing = true;
        // 先在界面上换过去（卡片选中、大预览换图），主进程那边慢慢开窗口
        c.outfit = outfitId || null;
        c.visible = Boolean(outfitId);
        c.open = Boolean(outfitId);
        renderGrid(false);
        ctx.renderStage();
        try {
            const result = await api.chooseDeskPetOutfit(c.agentId, outfitId);
            if (result?.success === false) ctx.note(result.error || '没换成', { error: true });
            if (result?.catalog && result.catalog.agentId === state.agentId) ctx.applyCatalog(result.catalog);
        } finally {
            state.choosing = false;
            renderGrid(false);
            if (state.reloadPending) {
                state.reloadPending = false;
                ctx.scheduleReload();
            }
        }
    }

    // 装好 Cubism Core 以后同一套的种类和介绍会变，卡片也要重建：记下这一轮的形象清单
    function stampOutfits(catalog) {
        const ids = JSON.stringify((catalog?.outfits || []).map((o) => [o.id, o.kind, o.description]));
        const changed = grid.dataset.ids !== ids;
        grid.dataset.ids = ids;
        return changed;
    }

    // 主进程画好一张快照：换到对应的卡片上（没有这一套就不用管）
    function setOutfitPreview(outfitId, url) {
        const item = state.catalog.outfits.find((o) => o.id === outfitId);
        if (!item) return false;
        item.preview = url || null;
        const card = [...grid.querySelectorAll('.dps-pet-card')].find((node) => node.dataset.outfit === outfitId);
        if (card) setCardPreview(card, url);
        return true;
    }

    // ---- 助手、导入、刷新 ----

    function renderAgents() {
        const c = state.catalog;
        const agents = c?.agents || [];
        const key = JSON.stringify(agents.map((a) => [a.id, a.label || a.name]));
        if (agentSelect.dataset.options !== key) {
            agentSelect.dataset.options = key;
            agentSelect.replaceChildren(...agents.map((agent) => {
                const option = el(doc, 'option', '', agent.label || agent.name);
                option.value = agent.id;
                return option;
            }));
        }
        agentSelect.value = c?.agentId || '';
        agentSelect.hidden = agents.length < 2;
    }

    agentSelect.addEventListener('change', () => {
        ctx.dock.cancelVoice();
        ctx.dock.setDock('pill');
        state.shownOutfit = undefined;
        ctx.loadCatalog(agentSelect.value);
    });
    refreshBtn.addEventListener('click', async () => {
        refreshBtn.classList.add('is-spinning');
        try { await ctx.loadCatalog(state.agentId, { refresh: true }); } finally { setTimeout(() => refreshBtn.classList.remove('is-spinning'), 500); }
    });
    async function runImport(files) {
        if (!state.agentId || importBtn.disabled) return;
        importBtn.disabled = true;
        try {
            const result = await api.importDeskPetOutfit(state.agentId, files);
            if (result?.catalog) ctx.applyCatalog(result.catalog);
            if (result?.success) ctx.note(`导入好了，${state.catalog?.name || 'TA'} 已经换上「${result.outfitId}」`);
            else if (!result?.canceled && result?.error) ctx.note(result.error, { error: true, ms: 6000 });
        } finally {
            importBtn.disabled = false;
        }
    }
    importBtn.addEventListener('click', () => runImport());
    // 把模型文件夹、.zip、.model3.json 或图片直接拖到形象列表上导入
    const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
    let dragDepth = 0;
    grid.addEventListener('dragenter', (event) => {
        if (!hasFiles(event) || !state.agentId) return;
        event.preventDefault();
        dragDepth += 1;
        grid.classList.add('is-drop');
    });
    grid.addEventListener('dragover', (event) => {
        if (!hasFiles(event) || !state.agentId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    });
    grid.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) grid.classList.remove('is-drop');
    });
    grid.addEventListener('drop', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth = 0;
        grid.classList.remove('is-drop');
        const files = Array.from(event.dataTransfer.files || []).map((file) => {
            try { return api.getPathForFile?.(file) || ''; } catch { return ''; }
        }).filter(Boolean);
        if (!files.length) ctx.note('只能导入本机上的文件', { error: true });
        else runImport(files);
    });

    return {
        renderAgents,
        renderGrid,
        stampOutfits,
        setOutfitPreview,
        setImportEnabled: (on) => { importBtn.disabled = !on; },
    };
}
