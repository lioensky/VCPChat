// 统一批注。
// 指认不是新概念：就是批注，把定位方式从文字扩到所有类型。各类型的交互一样：选中对象，出浮条，点“批注”或“问”。
// 这里是各视图共用的部分：工具切换、拖选区域、浮条、裁切截图、写成交给 Agent 的文字。各视图只管“这里是什么”，产出一个 target：
//   { type, label, place, text, locator, capture }   label 给人看的一句；place 给 Agent 看的位置；capture 是要截的窗口矩形（没有就不截）。
// 存放和列表在检查器的批注页（uttu-scriptorium-inspector.js），这里只发 pick-comment 事件。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;
    const { make, button } = UI;
    const api = () => window.scriptoriumAPI;
    const nextFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const adapters = new Map(); // 文件类型 → { paint(list) }：把存着的批注画回文件上

    // 工具切换：first 是平时的样子（浏览、编辑），后一个是批注。
    function toolSeg(first, onChange, more = []) {
        const seg = make('div', 'uttu-seg sm uttu-pick-tool');
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', '工具');
        let mode = 'browse';
        const paint = () => seg.querySelectorAll('button').forEach((option) => option.setAttribute('aria-pressed', String(option.dataset.v === mode)));
        const set = (value) => {
            if (value === mode) return;
            mode = value;
            paint();
            hide();
            onChange(mode);
        };
        for (const [value, label] of [['browse', first], ['pick', '批注'], ...more]) {
            const option = button('', '', label, () => set(value));
            option.dataset.v = value;
            seg.append(option);
        }
        paint();
        seg.setMode = set;
        return seg;
    }

    // 在 area 里拖出一块，done(相对 area 的矩形)。不到 4 像素算点击，clicked(相对 area 的点)。
    function dragRegion(area, event, done, clicked) {
        event.preventDefault();
        const origin = area.getBoundingClientRect();
        const start = { x: event.clientX - origin.left, y: event.clientY - origin.top };
        const band = make('div', 'uttu-pick-mark region');
        let rect = null;
        const layout = (moveEvent) => {
            const box = area.getBoundingClientRect();
            const x = Math.max(0, Math.min(box.width, moveEvent.clientX - box.left));
            const y = Math.max(0, Math.min(box.height, moveEvent.clientY - box.top));
            rect = { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(start.x - x), height: Math.abs(start.y - y) };
        };
        const move = (moveEvent) => {
            layout(moveEvent);
            if (rect.width < 4 && rect.height < 4) return;
            if (!band.isConnected) area.append(band);
            Object.assign(band.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        };
        const up = (upEvent) => {
            window.removeEventListener('pointermove', move, true);
            window.removeEventListener('pointerup', up, true);
            layout(upEvent);
            band.remove();
            if (rect.width >= 4 || rect.height >= 4) done(rect);
            else clicked?.(start);
        };
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
    }

    // 相对 area 的矩形换成窗口矩形。
    function windowRect(area, rect) {
        const box = area.getBoundingClientRect();
        return { x: box.left + rect.x, y: box.top + rect.y, width: rect.width, height: rect.height };
    }

    // 截这一块：色块和浮条先藏起来，截的是文件本身的样子。
    async function capture(rect) {
        document.body.classList.add('uttu-pick-shooting');
        await nextFrames();
        try {
            const result = await api().view('crop', { rect });
            return result?.success ? { path: result.path, width: result.width, height: result.height } : null;
        } catch (_) {
            return null;
        } finally {
            document.body.classList.remove('uttu-pick-shooting');
        }
    }

    // ---------- 浮条 ----------
    const bubble = make('div', 'uttu-bubble uttu-ctl uttu-pick-bubble');
    bubble.hidden = true;
    bubble.setAttribute('role', 'toolbar');
    bubble.setAttribute('aria-label', '批注');
    let pending = null;
    const tools = make('div', 'uttu-tbar');
    tools.append(button('uttu-tb-drop plain', '', '批注', () => void commit()), button('uttu-tb-drop plain', '', '引用', () => void reference()), button('uttu-tb-drop plain', '', '问', () => void ask()));
    bubble.append(tools);
    document.body.append(bubble);
    const focusBox = make('div', 'uttu-pick-focus');
    focusBox.hidden = true;
    document.body.append(focusBox);
    function showFocus(rect) {
        Object.assign(focusBox.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        focusBox.hidden = false;
    }
    document.addEventListener('pointerdown', () => { focusBox.hidden = true; }, true);
    function hide() {
        bubble.hidden = true;
        pending = null;
        UI.emit('pick-cleared');
    }
    // 把 target 交给浮条，box 是窗口坐标里对象的位置。
    function offer(target, box) {
        pending = target;
        bubble.hidden = false;
        const width = bubble.offsetWidth;
        const height = bubble.offsetHeight;
        const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
        const below = box.bottom + 6;
        bubble.style.left = `${Math.round(left)}px`;
        bubble.style.top = `${Math.round(below + height > window.innerHeight - 8 ? Math.max(8, box.top - height - 6) : below)}px`;
    }
    document.addEventListener('pointerdown', (event) => {
        if (!bubble.hidden && !bubble.contains(event.target)) hide();
    }, true);
    async function take() {
        const target = pending;
        bubble.hidden = true;
        if (!target) return null;
        const crop = target.capture ? await capture(target.capture) : null;
        pending = null;
        return { ...target, crop };
    }
    async function commit() {
        const target = await take();
        if (target) UI.emit('pick-comment', target);
        UI.emit('pick-cleared');
    }
    async function ask() {
        const target = await take();
        UI.emit('pick-cleared');
        if (!target) return;
        const comment = { quote: target.text, place: target.place, crop: target.crop, text: '' };
        const result = await hand([comment]);
        if (!result?.success) UI.toast(result?.message || '没放进对话。', 'error');
        else if (result.copied) UI.toast('复制好了，贴给任何 AI 都行。');
    }

    // 登记表按扩展名认；上游的 kind 分不出 .md 和文稿。
    const kindName = (doc) => window.UTTUScriptoriumTypes?.typeOf(doc?.filePath)?.name || window.UTTUScriptoriumTypes?.nameOfKind(doc?.kind) || '文件';

    // ---------- 引用----------
    // 不用先切工具：右键文件里的东西，或者选中后的浮条。复制的是一段写清文件和位置的文字，粘到 Chat 里 Agent 就知道是哪；贴给别的 AI 也看得懂。
    function referenceText(target) {
        const doc = UI.doc();
        const kind = kindName(doc);
        const lines = [`> ${kind} ${doc?.filePath || doc?.name || ''}`, `> 位置：${target.place}`];
        if (target.text) lines.push(`> 原文：${target.text}`);
        return lines.join('\n');
    }
    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
        } catch (_) {
            const area = document.createElement('textarea');
            area.value = text;
            document.body.append(area);
            area.select();
            document.execCommand('copy');
            area.remove();
        }
    }
    async function reference() {
        const target = pending;
        bubble.hidden = true;
        pending = null;
        UI.emit('pick-cleared');
        if (target) await copyText(referenceText(target));
    }
    // 右键菜单：framed 是文件里那一块的窗口矩形，先亮起来，看得出引用的是哪。
    function menu(target, point, { comment = true, items = [] } = {}) {
        pending = target;
        if (target.capture) showFocus(target.capture);
        UI.openMenu([
            { grp: target.label },
            { label: '复制引用', act: () => void reference() },
            { label: '交给 Agent', act: () => void ask() },
            ...(comment ? [{ label: '批注', act: () => void commit() }] : []),
            ...(items.length ? [{ sep: true }, ...items] : []),
        ], { left: point.x, right: point.x, top: point.y, bottom: point.y });
    }

    // ---------- 交给 Agent：文字加附件，用户看过再发 ----------
    function blockOf(comment, n) {
        const doc = UI.doc();
        const kind = kindName(doc);
        const lines = [`> 批注 ${n} · ${kind} ${doc?.filePath || doc?.name || ''}`, `> 位置：${comment.place}`];
        if (comment.quote) lines.push(`> 原文：${comment.quote}`);
        if (comment.text) lines.push(`> 要求：${comment.text}`);
        return lines.join('\n');
    }
    function hand(list) {
        const text = list.map((comment, index) => blockOf(comment, index + 1)).join('\n\n');
        const images = list.map((comment) => comment.crop?.path).filter(Boolean);
        return api().askAgent({ text, raw: true, images, docName: UI.doc()?.name || '', section: '' }).catch(() => null);
    }

    UI.on('picks-changed', (list) => {
        const kind = UI.doc()?.kind;
        adapters.get(kind)?.paint(list || []);
    });

    window.UTTUScriptoriumPick = Object.freeze({
        register: (kind, adapter) => adapters.set(kind, adapter),
        toolSeg,
        dragRegion,
        windowRect,
        offer,
        hide,
        blockOf,
        hand,
        menu,
        referenceText,
        reference: (target) => { pending = target; return reference(); },
        ask: (target) => { pending = target; return ask(); },
    });
})();
