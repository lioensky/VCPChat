// 顶上那块：介绍那行字、当前桌宠的大预览（换形象时的进退场）、
// 以及「自定义」抽屉里的大小滑块和形象文件夹。提示语 note() 也在这里。

import { el, button } from './dom.js';
import { IS_MAC, formatAccelerator } from './accelerators.js';

export function buildStage(doc, dockNode) {
    const intro = el(doc, 'div', 'dps-intro');
    const lead = el(doc, 'p', 'dps-lead');
    const visibleBtn = button(doc, 'dps-btn', '隐藏桌宠');
    intro.append(lead, visibleBtn);

    const stage = el(doc, 'section', 'dps-stage');
    stage.dataset.state = 'empty';
    const figure = el(doc, 'div', 'dps-stage-figure');
    const floor = el(doc, 'div', 'dps-stage-floor');
    const stageNote = el(doc, 'p', 'dps-stage-note');
    stageNote.setAttribute('aria-live', 'polite');
    const dockHost = el(doc, 'div', 'dps-stage-dock');
    dockHost.append(dockNode);
    const customBtn = button(doc, 'dps-btn dps-stage-custom', '自定义', { 'aria-expanded': 'false' });
    const hiddenTag = el(doc, 'span', 'dps-stage-tag', '已隐藏');
    stage.append(floor, figure, hiddenTag, dockHost, stageNote, customBtn);

    // 自定义：大小、形象文件夹（展开收起有高度过渡）
    const drawer = el(doc, 'div', 'dps-drawer');
    const drawerInner = el(doc, 'div', 'dps-drawer-inner');
    const sizeRow = el(doc, 'div', 'dps-row');
    const sizeCopy = el(doc, 'span', 'dps-row-copy');
    const sizeTitle = el(doc, 'span', 'dps-row-title', '大小');
    sizeCopy.append(sizeTitle, el(doc, 'span', 'dps-row-hint', `也可以把鼠标放在角色上，按住 ${IS_MAC ? 'Cmd' : 'Ctrl'} 滚动滚轮。每个助手的大小分别记住。`));
    const sizeControl = el(doc, 'span', 'dps-size');
    const slider = el(doc, 'input', 'dps-slider');
    slider.type = 'range';
    slider.step = '0.05';
    slider.setAttribute('aria-label', '桌宠大小');
    const sizeValue = el(doc, 'span', 'dps-size-value');
    sizeControl.append(slider, sizeValue);
    sizeRow.append(sizeCopy, sizeControl);
    const folderRow = el(doc, 'div', 'dps-row');
    const folderCopy = el(doc, 'span', 'dps-row-copy');
    const folderHint = el(doc, 'span', 'dps-row-hint');
    folderCopy.append(el(doc, 'span', 'dps-row-title', '形象文件夹'), folderHint);
    const folderBtn = button(doc, 'dps-btn', '打开文件夹');
    folderRow.append(folderCopy, folderBtn);
    drawerInner.append(sizeRow, folderRow);
    drawer.append(drawerInner);

    return { intro, lead, visibleBtn, stage, figure, stageNote, customBtn, drawer, sizeTitle, slider, sizeValue, folderHint, folderBtn };
}

// ctx：{ doc, api, state, dock, catalog, applyCatalog }
export function wireStage(ctx, parts) {
    const { doc, api, state } = ctx;
    const { stage, figure, stageNote, customBtn, drawer, slider, sizeValue, sizeTitle, folderHint, folderBtn, lead, visibleBtn } = parts;

    // 换形象时旧图下沉淡出、新图从脚下弹起来；同一张不重播
    function showFigure(url, key) {
        if (state.shownOutfit === key && figure.querySelector('.dps-figure:not(.is-leaving)')?.dataset.src === (url || '')) return;
        state.shownOutfit = key;
        for (const old of figure.querySelectorAll('.dps-figure:not(.is-leaving)')) {
            old.classList.add('is-leaving');
            setTimeout(() => old.remove(), 420);
        }
        if (!key) return;
        const node = el(doc, 'div', 'dps-figure is-entering');
        node.dataset.src = url || '';
        if (url) {
            const img = el(doc, 'img');
            img.alt = '';
            img.draggable = false;
            img.decoding = 'async';
            img.src = url;
            node.append(img);
        } else {
            node.classList.add('is-loading');
        }
        figure.append(node);
        requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove('is-entering')));
    }

    function currentItem() {
        const c = state.catalog;
        return c?.outfits?.find((o) => o.id === c.outfit) || null;
    }

    function renderStage() {
        const c = state.catalog;
        const item = currentItem();
        stage.dataset.state = !c?.agentId ? 'empty' : item ? (c.visible ? 'shown' : 'hidden') : 'none';
        showFigure(item?.preview || null, item ? `${c.agentId}\n${item.id}` : null);
        const name = c?.name || 'TA';
        ctx.dock.setPlaceholder(`和 ${name} 说点什么…`);
        customBtn.hidden = !c?.agentId;
    }

    function note(text, { error = false, ms = 3200 } = {}) {
        stageNote.textContent = text;
        stageNote.classList.toggle('is-error', error);
        stageNote.classList.add('is-shown');
        clearTimeout(note.timer);
        note.timer = setTimeout(() => stageNote.classList.remove('is-shown'), ms);
    }

    function renderIntro() {
        const shortcutsNow = state.snapshot?.settings?.shortcuts || {};
        const toggleKey = formatAccelerator(shortcutsNow.toggle);
        const talkKey = formatAccelerator(shortcutsNow.talk);
        const parts = ['桌宠让助手待在桌面上，光标停在 TA 身上就能打字或说话。'];
        if (toggleKey) parts.push(`按下 ${toggleKey} 显示或隐藏桌宠`);
        if (talkKey) parts.push(`${toggleKey ? '，' : '按下 '}${talkKey} 叫出 TA 并打开输入框`);
        lead.textContent = `${parts.join('')}${toggleKey || talkKey ? '。' : ''}`;
        const anyVisible = Boolean(state.catalog?.anyVisible);
        visibleBtn.textContent = anyVisible ? '隐藏桌宠' : '显示桌宠';
        visibleBtn.disabled = !state.catalog?.agentId;
        ctx.catalog.setImportEnabled(Boolean(state.catalog?.agentId));
    }

    visibleBtn.addEventListener('click', async () => {
        visibleBtn.disabled = true;
        try {
            const catalog = await api.setDeskPetsVisible(!state.catalog?.anyVisible, state.agentId);
            if (catalog) ctx.applyCatalog(catalog);
        } finally {
            visibleBtn.disabled = false;
        }
    });

    // ---- 自定义抽屉 ----

    function setDrawer(open) {
        state.drawerOpen = open;
        drawer.classList.toggle('is-open', open);
        customBtn.setAttribute('aria-expanded', String(open));
        customBtn.classList.toggle('is-active', open);
    }
    customBtn.addEventListener('click', () => setDrawer(!state.drawerOpen));

    function percent(scale) {
        return `${Math.round(scale * 100)}%`;
    }

    function renderDrawer() {
        const c = state.catalog;
        if (!c?.agentId) return;
        const range = state.snapshot?.scale || { min: 0.5, max: 2 };
        slider.min = String(range.min);
        slider.max = String(c.maxScale ?? range.max);
        if (doc.activeElement !== slider) {
            slider.value = String(c.scale);
            sizeValue.textContent = percent(c.scale);
        }
        sizeTitle.textContent = `${c.name} 的大小`;
        folderHint.textContent = `放入 Live2D、网格立绘、Codex 桌宠或立绘，每个子文件夹是一套形象：${c.folder}`;
    }

    let pendingScale = null;
    let pushingScale = false;
    async function pushScale() {
        if (pushingScale || pendingScale === null || !state.catalog?.agentId) return;
        pushingScale = true;
        const scale = pendingScale;
        pendingScale = null;
        try { await api.setDeskPetScale(state.catalog.agentId, scale); } finally { pushingScale = false; }
        pushScale();
    }
    slider.addEventListener('input', () => {
        sizeValue.textContent = percent(Number(slider.value));
        pendingScale = Number(slider.value);
        pushScale();
    });
    folderBtn.addEventListener('click', () => state.catalog?.agentId && api.openDeskPetFolder(state.catalog.agentId));

    return { note, renderStage, renderIntro, renderDrawer };
}
