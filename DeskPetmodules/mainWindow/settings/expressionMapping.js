// 表情映射：选中的那套是 Live2D 时出现，回复里的情绪对应模型的哪个表情、哪个动作。
// 规则本身在 DeskPetmodules/expressionMap.js（桌宠页面共用），存在模型旁边的 deskpet.json。

import { el, button, option as makeOption } from './dom.js';

const AUTO = '\u0000auto';

export function buildMapping(doc) {
    const mapSection = el(doc, 'section', 'dps-map');
    mapSection.hidden = true;
    const mapHead = el(doc, 'div', 'dps-head');
    const mapTitle = el(doc, 'h4', 'dps-subtitle', '表情映射');
    const mapToggle = button(doc, 'dps-btn', '调整', { 'aria-expanded': 'false' });
    mapHead.append(mapTitle, el(doc, 'span', 'dps-spacer'), mapToggle);
    const mapCard = el(doc, 'div', 'dps-card');
    mapCard.hidden = true;
    const mapHint = el(doc, 'p', 'dps-row-hint dps-card-hint');
    const mapList = el(doc, 'div', 'dps-map-list');
    const mapActions = el(doc, 'div', 'dps-card-actions');
    const mapResetBtn = button(doc, 'dps-btn', '全部改回自动');
    const mapSaveBtn = button(doc, 'dps-btn dps-btn-primary', '保存');
    mapActions.append(mapResetBtn, mapSaveBtn);
    mapCard.append(mapHint, mapList, mapActions);
    mapSection.append(mapHead, mapCard);
    return { mapSection, mapTitle, mapToggle, mapCard, mapHint, mapList, mapResetBtn, mapSaveBtn };
}

// ctx：{ doc, api, state, note, loadExpressionMap }
export function wireMapping(ctx, parts) {
    const { doc, api, state } = ctx;
    const { mapSection, mapTitle, mapToggle, mapCard, mapHint, mapList, mapResetBtn, mapSaveBtn } = parts;
    const option = (value, text) => makeOption(doc, value, text);

    let mapModule = null;
    const mapping = { open: false, key: null, data: null, draft: null, dirty: false, seq: 0 };

    function mappingOutfit() {
        const c = state.catalog;
        const id = c?.outfit || c?.lastOutfit;
        return c?.outfits?.find((o) => o.id === id && o.hasModel) || null;
    }

    function renderMapSection() {
        const item = mappingOutfit();
        mapSection.hidden = !item;
        if (!item) return;
        mapTitle.textContent = `表情映射 · ${item.name}`;
        const key = `${state.catalog.agentId}\n${item.id}`;
        if (mapping.open && mapping.key !== key) loadMapping();
    }

    function setMapOpen(open) {
        mapping.open = open;
        mapCard.hidden = !open;
        mapToggle.textContent = open ? '收起' : '调整';
        mapToggle.setAttribute('aria-expanded', String(open));
        if (open) loadMapping();
    }
    mapToggle.addEventListener('click', () => setMapOpen(!mapping.open));

    function draftFrom(data) {
        const draft = { expressions: {}, motions: {}, taps: {} };
        for (const row of mapModule.describeMapping({ names: data.names, groups: data.groups, profile: data.profile, modelName: mapModule.modelNameOf(data.modelFile) })) {
            if (row.expressionSet) draft.expressions[row.emotion] = row.expression;
            if (row.motionSet) draft.motions[row.emotion] = row.motion ?? '';
        }
        for (const tap of mapModule.describeTaps({ names: data.names, groups: data.groups, profile: data.profile })) {
            if (tap.expression || tap.motion) draft.taps[tap.zone] = { expression: tap.expression, motion: tap.motion };
        }
        return draft;
    }

    async function loadMapping() {
        const item = mappingOutfit();
        if (!item) return;
        const seq = ++mapping.seq;
        mapping.key = `${state.catalog.agentId}\n${item.id}`;
        mapList.replaceChildren(el(doc, 'p', 'dps-row-hint', '正在读模型…'));
        mapModule = mapModule || await ctx.loadExpressionMap();
        const data = await api.getDeskPetMapping(state.catalog.agentId, item.id);
        if (seq !== mapping.seq) return;
        if (!data?.success) {
            mapping.data = null;
            mapList.replaceChildren(el(doc, 'p', 'dps-row-hint', data?.error || '读不了这个模型'));
            mapSaveBtn.disabled = true;
            mapResetBtn.disabled = true;
            return;
        }
        mapping.data = data;
        mapping.draft = draftFrom(data);
        mapping.dirty = false;
        renderMapping();
    }

    function renderMapping() {
        const data = mapping.data;
        if (!data) return;
        const modelName = mapModule.modelNameOf(data.modelFile);
        const rows = mapModule.describeMapping({ names: data.names, groups: data.groups, profile: mapping.draft, modelName });
        mapHint.textContent = data.editable
            ? `回复里的情绪换成这个模型的哪个表情、顺带放哪个动作；最下面两行是点头、点身体时的反应。「自动」按表情名猜。点 ▶ 在桌面上的桌宠身上试一下${data.showing ? '' : '（桌宠要先穿上这一套）'}，满意了再保存，存在模型旁边的 deskpet.json。`
            : '内置形象的映射已经调好，这里只能看；点 ▶ 可以在桌宠身上试。';
        if (!data.names.length && !data.groups.length) {
            mapList.replaceChildren(el(doc, 'p', 'dps-row-hint', '这个模型没有自带表情和动作，情绪只靠参数微调脸部（眉毛、眼睛、嘴角）。'));
            mapSaveBtn.disabled = true;
            mapResetBtn.disabled = true;
            return;
        }
        const head = el(doc, 'div', 'dps-map-row dps-map-head');
        head.append(el(doc, 'span', '', '情绪'), el(doc, 'span', '', '表情'), el(doc, 'span', '', '动作'), el(doc, 'span'));
        const list = [head];
        for (const row of rows) {
            const line = el(doc, 'div', 'dps-map-row');
            const expr = el(doc, 'select', 'dps-map-select');
            expr.dataset.vcpTypedPrimitiveMounted = 'true';
            expr.setAttribute('aria-label', `${row.label}的表情`);
            expr.append(option(AUTO, `自动（${row.autoExpression || '不换'}）`), ...data.names.map((name) => option(name, name)));
            expr.value = row.emotion in mapping.draft.expressions ? mapping.draft.expressions[row.emotion] : AUTO;
            const motion = el(doc, 'select', 'dps-map-select');
            motion.dataset.vcpTypedPrimitiveMounted = 'true';
            motion.setAttribute('aria-label', `${row.label}的动作`);
            motion.append(option(AUTO, `自动（${row.autoMotion || '不放'}）`), option('', '不放动作'), ...data.groups.map((group) => option(group, group)));
            motion.value = row.emotion in mapping.draft.motions ? mapping.draft.motions[row.emotion] : AUTO;
            expr.disabled = !data.editable;
            motion.disabled = !data.editable;
            const tryBtn = button(doc, 'dps-icon-btn dps-map-try', '▶', { title: `在桌宠身上试试「${row.label}」`, 'aria-label': `试试${row.label}` });
            const update = () => {
                if (expr.value === AUTO) delete mapping.draft.expressions[row.emotion];
                else mapping.draft.expressions[row.emotion] = expr.value;
                if (motion.value === AUTO) delete mapping.draft.motions[row.emotion];
                else mapping.draft.motions[row.emotion] = motion.value;
                mapping.dirty = true;
                mapSaveBtn.disabled = false;
                tryMapping(row.emotion, row.label);
            };
            expr.addEventListener('change', update);
            motion.addEventListener('change', update);
            tryBtn.addEventListener('click', () => tryMapping(row.emotion, row.label));
            line.append(el(doc, 'span', 'dps-map-label', row.label), expr, motion, tryBtn);
            list.push(line);
        }
        // 点头、点身体：默认是原来的反应（点头害羞、点身体开心），也可以自己挑一个表情 / 动作
        const tapHead = el(doc, 'div', 'dps-map-row dps-map-head');
        tapHead.append(el(doc, 'span', '', '被点到'), el(doc, 'span', '', '表情'), el(doc, 'span', '', '动作'), el(doc, 'span'));
        list.push(tapHead);
        const DEFAULT_TAP = { head: '害羞', body: '开心' };
        for (const row of mapModule.describeTaps({ names: data.names, groups: data.groups, profile: mapping.draft })) {
            const line = el(doc, 'div', 'dps-map-row');
            const expr = el(doc, 'select', 'dps-map-select');
            expr.dataset.vcpTypedPrimitiveMounted = 'true';
            expr.setAttribute('aria-label', `${row.label}时的表情`);
            expr.append(option(AUTO, `默认（${DEFAULT_TAP[row.zone]}）`), ...data.names.map((name) => option(name, name)));
            expr.value = row.expression ?? AUTO;
            const motion = el(doc, 'select', 'dps-map-select');
            motion.dataset.vcpTypedPrimitiveMounted = 'true';
            motion.setAttribute('aria-label', `${row.label}时的动作`);
            motion.append(option(AUTO, '默认'), ...data.groups.map((group) => option(group, group)));
            motion.value = row.motion ?? AUTO;
            expr.disabled = !data.editable;
            motion.disabled = !data.editable;
            const tryBtn = button(doc, 'dps-icon-btn dps-map-try', '▶', { title: `在桌宠身上试试「${row.label}」`, 'aria-label': `试试${row.label}` });
            const update = () => {
                const bound = { expression: expr.value === AUTO ? null : expr.value, motion: motion.value === AUTO ? null : motion.value };
                if (bound.expression || bound.motion) mapping.draft.taps[row.zone] = bound;
                else delete mapping.draft.taps[row.zone];
                mapping.dirty = true;
                mapSaveBtn.disabled = false;
                tryMapping(`tap:${row.zone}`, row.label);
            };
            expr.addEventListener('change', update);
            motion.addEventListener('change', update);
            tryBtn.addEventListener('click', () => tryMapping(`tap:${row.zone}`, row.label));
            line.append(el(doc, 'span', 'dps-map-label', row.label), expr, motion, tryBtn);
            list.push(line);
        }
        mapList.replaceChildren(...list);
        mapSaveBtn.disabled = !data.editable || !mapping.dirty;
        mapResetBtn.disabled = !data.editable;
        mapResetBtn.hidden = !data.editable;
        mapSaveBtn.hidden = !data.editable;
    }

    async function tryMapping(emotion, label) {
        const data = mapping.data;
        if (!data) return;
        const result = await api.applyDeskPetMapping(state.catalog.agentId, data.outfitId, mapping.draft, { emotion });
        if (result?.success && !result.showing) ctx.note(`桌宠现在没穿「${data.name}」，先在上面选中这一套再试`, { ms: 4200 });
        else if (result?.success) ctx.note(`桌宠在演「${label}」`, { ms: 2000 });
        else if (result?.error) ctx.note(result.error, { error: true });
    }

    mapResetBtn.addEventListener('click', () => {
        if (!mapping.data) return;
        mapping.draft = { expressions: {}, motions: {}, taps: {} };
        mapping.dirty = true;
        renderMapping();
    });
    mapSaveBtn.addEventListener('click', async () => {
        const data = mapping.data;
        if (!data?.editable) return;
        mapSaveBtn.disabled = true;
        const result = await api.applyDeskPetMapping(state.catalog.agentId, data.outfitId, mapping.draft, { save: true });
        if (result?.success) {
            mapping.dirty = false;
            data.profile = result.profile;
            ctx.note(`「${data.name}」的表情映射存好了${result.showing ? '，桌宠已经换上' : ''}`);
        } else {
            mapSaveBtn.disabled = false;
            ctx.note(result?.error || '没存上', { error: true });
        }
    });

    return { renderMapSection };
}
