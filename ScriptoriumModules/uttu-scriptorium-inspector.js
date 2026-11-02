// 文坊右侧检查器四页：格式、文档、批注、文脉（
// - 格式：只改选中的文字或光标所在的一段，走上游格式命令（对齐按钮带 data-command，在上游初始化前建好由它绑定）。
// - 文档：换样式、版式，编辑这份文档的 CSS，看存在哪里。
// - 批注：选中文字后浮条上点“批注”；批注存在文档里（manifest.uttu.comments），文档上用高亮标出；没解决的可以一起交给 Agent。
// - 文脉：上游文脉面板（刻点、待审、自动允许），外壳里已经搬进来。顶栏左边的 Agent 状态也在这里管。
(() => {
    'use strict';

    const UI = window.UTTUScriptoriumUI;
    if (!UI || !UI.rightPage?.('format')) return;
    const { $, icon, make, button, escapeHtml, session } = UI;
    const page = (key) => UI.rightPage(key);

    function field(label, ...content) {
        const wrap = make('div', 'uttu-field', `<span class="lab">${label}</span>`);
        wrap.append(...content);
        return wrap;
    }
    function fsel(label, itemsFn, menuOptions = {}) {
        const element = button('uttu-fsel', label, `<span></span>${icon('i-chevron')}`);
        element.setAttribute('aria-expanded', 'false');
        // 不能让编辑面的选区丢掉。
        element.addEventListener('mousedown', (event) => event.preventDefault());
        element.addEventListener('click', () => {
            keepSelection();
            UI.toggleMenu(element, itemsFn, menuOptions);
        });
        return element;
    }
    function seg(label, entries, className = 'uttu-seg full sm') {
        const group = make('div', className);
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', label);
        for (const entry of entries) group.append(entry);
        return group;
    }
    const format = (command, value) => session()?.format?.(command, value);

    // ---------- 格式 ----------
    const fmt = {};
    // 段落在工具条上，这里只放工具条没有的。
    fmt.font = fsel('字体', () => fontItems(), { search: '搜索字体' });
    fmt.size = fsel('字号', () => optionItems($('font-size-select'), 'font-size'));
    // 字体、字号从上游的下拉框取选项（字体列表由上游按系统字体填）；“跟随文档”是 inherit。
    function optionItems(select, command) {
        if (!select) return [];
        const current = select.value;
        const items = [{ label: '跟随文档', check: !current, act: () => format(command, 'inherit') }];
        for (const option of select.options) {
            if (!option.value) continue;
            items.push({ label: option.textContent.trim(), check: option.value === current, act: () => format(command, option.value) });
        }
        return items;
    }
    // 字体：跟随文档、最近用过的几个、全部。搜索框要拿焦点，先记下编辑面的选区，选好再放回去。
    const RECENT_FONTS = 'uttu.scriptorium.recentFonts';
    const recentFonts = () => {
        try { return JSON.parse(localStorage.getItem(RECENT_FONTS) || '[]'); } catch (_) { return []; }
    };
    let keptRange = null;
    function keepSelection() {
        const selection = session()?.editRoot?.()?.getSelection?.();
        keptRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    }
    function restoreSelection() {
        const selection = session()?.editRoot?.()?.getSelection?.();
        if (!keptRange || !selection) return;
        selection.removeAllRanges();
        selection.addRange(keptRange);
    }
    function chooseFont(value) {
        restoreSelection();
        format('font-family', value);
        try {
            const next = [value, ...recentFonts().filter((item) => item !== value)].slice(0, 5);
            localStorage.setItem(RECENT_FONTS, JSON.stringify(next));
        } catch (_) { /* 只在这次用 */ }
    }
    function fontItems() {
        const select = $('font-family-select');
        if (!select) return [];
        const current = select.value;
        const options = [...select.options].filter((option) => option.value);
        const entry = (option, again = false) => ({ label: option.textContent.trim(), check: option.value === current, again, act: () => chooseFont(option.value) });
        const recent = recentFonts().map((value) => options.find((option) => option.value === value)).filter(Boolean);
        return [
            { label: '跟随文档', check: !current, act: () => chooseFont('inherit') },
            ...(recent.length ? [{ grp: '最近用过' }, ...recent.map((option) => entry(option, true)), { grp: '全部' }] : []),
            ...options.map((option) => entry(option)),
        ];
    }
    function optionLabel(select) {
        if (!select || !select.value) return '跟随文档';
        return select.selectedOptions[0]?.textContent.trim() || select.value;
    }
    const COLORS = [['跟随文档', 'inherit', 'A'], ['赤陶', '#db7a43'], ['苔绿', '#93ad6b'], ['灰蓝', '#6d8fa6'], ['朱红', '#d4553e']];
    const MARKS = [['不高亮', 'transparent', '–'], ['铜', 'rgba(222, 160, 108, .45)'], ['绿', 'rgba(147, 173, 107, .45)'], ['蓝', 'rgba(109, 143, 166, .45)']];
    function swatches(label, list, command) {
        const row = make('div', 'uttu-swatches');
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', label);
        for (const [name, value, glyph] of list) {
            const swatch = button('', name, glyph || '', () => format(command, value));
            swatch.dataset.v = value;
            if (!glyph) swatch.style.setProperty('--c', value);
            swatch.addEventListener('mousedown', (event) => event.preventDefault());
            row.append(swatch);
        }
        return row;
    }
    fmt.color = swatches('文字颜色', COLORS, 'text-color');
    fmt.mark = swatches('高亮', MARKS, 'highlight-color');
    fmt.align = seg('对齐', [['left', '左'], ['center', '中'], ['right', '右'], ['justify', '两端']].map(([value, label]) => {
        const option = button('', '', label);
        option.dataset.command = 'text-align';
        option.dataset.value = value;
        return option;
    }));
    const LINE_HEIGHTS = [['tight', '紧', '1.4'], ['normal', '标准', 'inherit'], ['loose', '松', '2']];
    fmt.lineHeight = seg('行距', LINE_HEIGHTS.map(([key, label, value]) => {
        const option = button('', '', label, () => format('line-height', value));
        option.dataset.v = key;
        option.addEventListener('mousedown', (event) => event.preventDefault());
        return option;
    }));
    fmt.off = make('p', 'note', '');
    const sizes = make('div', 'uttu-field-row fit');
    sizes.append(field('字体', fmt.font), field('字号', fmt.size));
    fmt.controls = make('div', 'uttu-insp-group');
    fmt.controls.append(sizes, field('文字颜色', fmt.color), field('高亮', fmt.mark), field('对齐', fmt.align), field('行距', fmt.lineHeight));
    page('format').append(fmt.off, fmt.controls);

    // 光标所在那一段的样子：对齐、行距看算出来的样式，颜色看上游同步到颜色框里的值。
    function caretElement() {
        const root = session()?.editRoot?.();
        const selection = root?.getSelection?.() || document.getSelection();
        if (!root || !selection?.rangeCount) return null;
        const node = selection.getRangeAt(0).startContainer;
        if (!root.contains(node)) return null;
        return node.nodeType === 1 ? node : node.parentElement;
    }
    function renderFormat() {
        const current = UI.doc();
        const wysiwyg = UI.editorKind() === 'wysiwyg' && UI.view() !== 'preview';
        const usable = Boolean(current) && wysiwyg;
        fmt.controls.hidden = !usable;
        fmt.off.hidden = usable;
        UI.setText(fmt.off, !current ? '没有打开的文档。' : '切到“编辑”后改格式。');
        if (!usable) return;
        UI.setText(fmt.font.querySelector('span'), optionLabel($('font-family-select')));
        UI.setText(fmt.size.querySelector('span'), optionLabel($('font-size-select')));
        const color = String($('text-color-input')?.value || '').toLowerCase();
        const known = COLORS.some(([, value]) => value === color);
        fmt.color.querySelectorAll('button').forEach((swatch) => swatch.setAttribute('aria-pressed', String(known ? swatch.dataset.v === color : swatch.dataset.v === 'inherit')));
        const element = caretElement();
        const style = element ? getComputedStyle(element.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, div') || element) : null;
        const align = style ? ({ start: 'left', left: 'left', '-webkit-left': 'left', center: 'center', '-webkit-center': 'center', right: 'right', end: 'right', '-webkit-right': 'right', justify: 'justify' }[style.textAlign] || 'left') : '';
        fmt.align.querySelectorAll('button').forEach((option) => option.setAttribute('aria-pressed', String(option.dataset.value === align)));
        let spacing = '';
        if (style) {
            const ratio = parseFloat(style.lineHeight) / parseFloat(style.fontSize);
            spacing = !Number.isFinite(ratio) ? 'normal' : ratio < 1.55 ? 'tight' : ratio > 1.95 ? 'loose' : 'normal';
        }
        fmt.lineHeight.querySelectorAll('button').forEach((option) => option.setAttribute('aria-pressed', String(option.dataset.v === spacing)));
    }

    // ---------- 文档 ----------
    const themes = window.UTTUDocThemes;
    const docp = {};
    docp.tiles = make('div', 'uttu-tiles');
    for (const item of themes?.THEMES || []) {
        const tile = button('uttu-tile', '', `<span class="pv" style="background:${item.swatch.paper};color:${item.swatch.ink}"><i></i><i></i><i></i></span><span>${escapeHtml(item.name)}</span>`, () => applyTheme(item.id));
        tile.dataset.v = item.id;
        docp.tiles.append(tile);
    }
    docp.themeField = field('样式', docp.tiles);
    docp.layout = seg('版式', [['continuous', '长页'], ['flow', 'A4 分页']].map(([mode, label]) => {
        const option = button('', '', label, () => applyLayout(mode));
        option.dataset.v = mode;
        return option;
    }));
    docp.editCss = button('uttu-link-btn', '', '编辑这份文档的 CSS', () => {
        if (UI.view() === 'preview') UI.setView('split');
        UI.setEditor('css');
    });
    page('format').append(make('hr', 'uttu-insp-rule'), docp.themeField, field('版式', docp.layout), docp.editCss); // “文档”页并到这里

    function reloadSourceSurface() {
        const api = session();
        const mode = api?.surface?.();
        if (mode === 'source-css' || mode === 'source-html') api.switchSurface(mode, { force: true });
    }
    function applyTheme(id) {
        const current = UI.doc();
        if (!current || !themes || current.kind === 'slide-deck') return;
        if (themes.themeOf(current.documentCss) === id) return;
        const documentCss = themes.restyleCss(current.documentCss, id, current.defaultCss);
        if (session().restyle({ documentCss })) {
            reloadSourceSurface();
            UI.toast(`换成了“${themes.theme(id)?.name || id}”。按 Ctrl Z 撤销。`);
        }
    }
    function applyLayout(mode) {
        const current = UI.doc();
        if (!current || current.kind === 'slide-deck' || current.paginationMode === mode) return;
        session().restyle({ paginationMode: mode });
    }
    // CSS 栏的“恢复内置样式”：用了样式库的回到那套样式本来的样子，没用的回到上游默认样式；文档里自己加的规则去掉。
    UI.on('reset-css', () => {
        const current = UI.doc();
        if (!current || current.kind === 'slide-deck' || !themes) return;
        const theme = themes.themeOf(current.documentCss);
        const documentCss = theme ? themes.cssFor(theme) : current.defaultCss;
        if (documentCss === current.documentCss) {
            UI.toast('已经是内置样式。');
            return;
        }
        if (session().restyle({ documentCss })) {
            reloadSourceSurface();
            UI.toast('恢复了内置样式，自己加的规则去掉了。按 Ctrl Z 撤销。');
        }
    });
    function renderDoc() {
        const current = UI.doc();
        const deck = current?.kind === 'slide-deck';
        const theme = current && themes ? themes.themeOf(current.documentCss) : null;
        docp.themeField.hidden = !current || deck;
        docp.tiles.querySelectorAll('button').forEach((tile) => tile.setAttribute('aria-pressed', String(tile.dataset.v === theme)));
        docp.layout.querySelectorAll('button').forEach((option) => {
            option.disabled = !current || deck;
            option.setAttribute('aria-pressed', String(Boolean(current) && !deck && option.dataset.v === (current.paginationMode === 'continuous' ? 'continuous' : 'flow')));
        });
        docp.editCss.hidden = !current || deck;
        UI.setCssLabel?.(!current || deck ? '' : theme ? `样式库：${themes.theme(theme)?.name || theme}` : '自写样式');
    }

    // ---------- 批注 ----------
    const cm = { list: [], draft: null, active: null, ranges: new Map() };
    const cmHead = make('div', 'uttu-cmt-head');
    const cmSummary = make('span');
    const sendButton = button('uttu-btn primary small', '', '交给 Agent 改', sendComments);
    cmHead.append(cmSummary, make('span', 'grow'), sendButton);
    const cmList = make('div', 'uttu-cmts');
    page('comments').append(cmHead, cmList);

    const now = () => new Date().toISOString();
    function stamp(iso) {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return '';
        const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
        if (minutes < 1) return '刚刚';
        if (minutes < 60) return `${minutes} 分钟前`;
        const pad = (n) => String(n).padStart(2, '0');
        const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
        return date.toDateString() === new Date().toDateString() ? time : `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`;
    }
    // 网页、图片、PDF、表格、文本没有文稿工程，批注存在旁存文件里（modules/uttu/viewFiles），文件本身不动。
    const overlayDoc = () => UI.overlay?.()?.doc?.() || null;
    function loadComments() {
        cm.draft = null;
        cm.active = null;
        const doc = overlayDoc();
        if (!doc) {
            cm.list = session()?.comments?.() || [];
            return;
        }
        cm.list = [];
        const file = doc.filePath;
        void window.scriptoriumAPI?.view?.('picks-read', { file }).then((result) => {
            if (overlayDoc()?.filePath !== file) return;
            cm.list = result?.list || [];
            renderComments();
            UI.emit('picks-changed', cm.list);
        }).catch(() => {});
    }
    function saveComments() {
        const doc = overlayDoc();
        if (!doc) {
            session()?.setComments?.(cm.list);
            return;
        }
        void window.scriptoriumAPI?.view?.('picks-write', { file: doc.filePath, list: cm.list }).catch(() => {});
        UI.emit('picks-changed', cm.list);
    }
    const fileUrl = (file) => `file:///${String(file).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([a-zA-Z])%3A/, '$1:')}`;
    function card(comment, draft = false) {
        const element = make('div', `uttu-cmt${comment.state === 'done' ? ' done' : ''}${comment.id === cm.active ? ' on' : ''}`);
        element.dataset.cm = comment.id;
        if (comment.label) element.append(make('div', 'target', escapeHtml(comment.label)));
        if (comment.crop?.path) {
            const crop = make('img', 'crop');
            crop.src = fileUrl(comment.crop.path);
            crop.alt = '';
            element.append(crop);
        }
        if (comment.quote) element.append(make('q', '', escapeHtml(comment.quote)));
        const foot = make('div', 'foot');
        if (draft) {
            const box = make('textarea');
            box.setAttribute('aria-label', '批注内容');
            box.placeholder = '写下要改什么';
            element.append(box);
            foot.append(make('span', '', '你 · 刚刚'), make('span', 'grow'),
                button('uttu-link-btn', '', '保存', () => saveDraft(box.value)),
                button('uttu-link-btn', '', '取消', () => { cm.draft = null; renderComments(); paintMarks(); }));
            box.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    saveDraft(box.value);
                } else if (event.key === 'Escape') {
                    event.stopPropagation();
                    cm.draft = null;
                    renderComments();
                    paintMarks();
                }
            });
            setTimeout(() => box.focus(), 0);
        } else {
            element.append(make('p', '', escapeHtml(comment.text)));
            foot.append(make('span', '', `你 · ${escapeHtml(stamp(comment.at))}`));
            if (comment.state === 'sent') foot.append(make('span', 'tag', '已交给 Agent'));
            if (!comment.place && !cm.ranges.get(comment.id)?.length && comment.state !== 'done') foot.append(make('span', 'tag', '原文已改'));
            foot.append(make('span', 'grow'));
            if (comment.state === 'done') {
                foot.append(make('span', '', '已解决'), button('uttu-link-btn', '', '删掉', () => removeComment(comment.id)));
            } else {
                foot.append(button('uttu-link-btn', '', '解决', () => resolveComment(comment.id)));
            }
        }
        element.append(foot);
        element.addEventListener('click', (event) => {
            if (draft || event.target.closest('button, textarea')) return;
            setActive(comment.id, true);
        });
        return element;
    }
    function renderComments() {
        const open = cm.list.filter((comment) => comment.state !== 'done');
        const ready = cm.list.filter((comment) => comment.state === 'open' && comment.text);
        UI.setRightBadge('comments', open.length ? String(open.length) : '');
        UI.setText(cmSummary, !UI.doc() ? '没有打开的文档' : open.length ? `${open.length} 条没解决` : '没有要处理的批注');
        sendButton.disabled = !ready.length;
        sendButton.hidden = !UI.doc();
        const cards = [];
        if (cm.draft) cards.push(card(cm.draft, true));
        cards.push(...[...cm.list].reverse().map((comment) => card(comment)));
        if (!cards.length) cards.push(make('p', 'note', !UI.doc() ? '' : overlayDoc() ? '工具切到“批注”，再选中对象。' : '选中一段文字，点浮条上的“批注”。'));
        cmList.replaceChildren(...cards);
    }
    function saveDraft(text) {
        const value = String(text || '').trim();
        if (!cm.draft) return;
        if (!value) {
            UI.toast('批注是空的。');
            return;
        }
        cm.list.push({ ...cm.draft, text: value, state: 'open', at: now() });
        cm.active = cm.draft.id;
        cm.draft = null;
        saveComments();
        renderComments();
        paintMarks();
    }
    function resolveComment(id) {
        const comment = cm.list.find((item) => item.id === id);
        if (!comment) return;
        comment.state = 'done';
        saveComments();
        renderComments();
        paintMarks();
    }
    function removeComment(id) {
        cm.list = cm.list.filter((item) => item.id !== id);
        saveComments();
        renderComments();
        paintMarks();
    }
    // 交给 Agent：把没解决的批注合成一段，放进对话输入框（和浮条上的“问”一样，由人看过再发）。
    async function sendComments() {
        const ready = cm.list.filter((comment) => comment.state === 'open' && comment.text);
        if (!ready.length) return;
        if (typeof window.scriptoriumAPI?.askAgent !== 'function') {
            UI.toast('这里连不到对话，在主窗口里打开文坊再交给 Agent。', 'error');
            return;
        }
        const located = ready.some((comment) => comment.place);
        const docName = ($('document-title')?.textContent || '').trim();
        const lines = ready.map((comment, k) => `${k + 1}. 「${comment.quote}」${comment.section ? `（${comment.section}）` : ''}：${comment.text}`);
        const text = `请按这些批注修改《${docName || '这份文档'}》，改完逐条说明：\n${lines.join('\n')}`;
        const result = located ? await window.UTTUScriptoriumPick.hand(ready)
            : await window.scriptoriumAPI.askAgent({ text, docName, section: '' }).catch(() => null);
        if (!result?.success) {
            UI.toast(result?.message || '没放进对话。', 'error');
            return;
        }
        ready.forEach((comment) => { comment.state = 'sent'; });
        saveComments();
        renderComments();
        UI.toast(result.copied ? `${ready.length} 条批注复制好了，贴给任何 AI 都行。` : `${ready.length} 条批注放进了对话输入框，发出去 Agent 就开始改。`);
    }
    // 交给 Agent 的批注（已交给 Agent），等 Agent 的修改合入就标成已解决。
    // 合入时文档以 agent-source-pr 改动。之后要删掉还是留着，用户在卡片上点。
    UI.on('doc-event', (event) => {
        if (event?.type !== 'document-mutated' || event.reason !== 'agent-source-pr') return;
        const sent = cm.list.filter((comment) => comment.state === 'sent');
        if (!sent.length) return;
        sent.forEach((comment) => { comment.state = 'done'; comment.doneAt = now(); });
        saveComments();
        renderComments();
        paintMarks();
        UI.toast?.(`Agent 改完了，交给它的 ${sent.length} 条批注标成已解决。`);
    });
    UI.on('comment-create', ({ quote, section, range }) => {
        if (!UI.doc()) return;
        const text = String(quote || '').replace(/\s+/g, ' ').trim();
        if (!text) return;
        let prefix = '';
        const start = range?.startContainer;
        if (start?.nodeType === 3) prefix = start.nodeValue.slice(Math.max(0, range.startOffset - 16), range.startOffset);
        cm.draft = { id: `c${Date.now().toString(36)}`, quote: text.length > 80 ? text.slice(0, 80) : text, prefix, section: section || '' };
        cm.active = cm.draft.id;
        UI.openRight('comments');
        renderComments();
        paintMarks();
    });

    // 各类型统一的批注（uttu-scriptorium-pick.js）：选中对象点“批注”，到这里写要求。
    UI.on('pick-comment', (target) => {
        cm.draft = { id: `c${Date.now().toString(36)}`, quote: target.text || '', label: target.label, place: target.place,
            locator: target.locator, crop: target.crop, kind: UI.doc()?.kind };
        cm.active = cm.draft.id;
        UI.openRight('comments');
        renderComments();
    });
    // 外面改了文件（Agent 直接改的）：交给 Agent 的批注算处理过了。
    UI.on('view-file-changed', () => {
        if (!cm.list.some((comment) => comment.state === 'sent')) return;
        cm.list.forEach((comment) => { if (comment.state === 'sent') comment.state = 'done'; });
        saveComments();
        renderComments();
    });

    // 文档上的批注标记：CSS 高亮（不改文档 DOM）。高亮的样式要放进编辑面、阅读面的影子根里才生效。
    const markSheet = (() => {
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(`::highlight(uttu-comment) { background-color: rgba(222, 160, 108, .28); text-decoration: underline; text-decoration-color: rgba(219, 122, 67, .8); text-underline-offset: 3px; }
::highlight(uttu-comment-on) { background-color: rgba(222, 160, 108, .5); }
::highlight(uttu-change) { background-color: rgba(147, 173, 107, .22); }`);
            return sheet;
        } catch (_) {
            return null;
        }
    })();
    function ensureSheet(root) {
        if (!markSheet || !root || !('adoptedStyleSheets' in root)) return;
        if (!root.adoptedStyleSheets.includes(markSheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, markSheet];
    }
    function rangesFor(root, comment) {
        const { text, segments } = UI.textSegments?.(root) || { text: '', segments: [] };
        if (!text) return null;
        const quote = comment.quote;
        let best = -1;
        for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
            if (best < 0) best = at;
            if (comment.prefix && text.slice(Math.max(0, at - comment.prefix.length), at) === comment.prefix) {
                best = at;
                break;
            }
        }
        if (best < 0) return null;
        const end = best + quote.length;
        const startSeg = segments.find((segment) => best >= segment.start && best < segment.end);
        const endSeg = [...segments].reverse().find((segment) => end > segment.start && end <= segment.end);
        if (!startSeg || !endSeg) return null;
        const range = document.createRange();
        range.setStart(startSeg.node, best - startSeg.start);
        range.setEnd(endSeg.node, end - endSeg.start);
        return range;
    }
    function paintMarks() {
        if (overlayDoc()) return; // 这些类型各画各的（uttu-scriptorium-pick.js）
        cm.ranges = new Map();
        if (!window.CSS?.highlights || typeof window.Highlight !== 'function') return;
        const api = session();
        const roots = UI.doc() ? [api?.editRoot?.(), api?.readRoot?.()].filter(Boolean) : [];
        const all = [];
        const on = [];
        const list = cm.list.filter((comment) => comment.state !== 'done');
        if (cm.draft) list.push(cm.draft);
        for (const root of roots) {
            ensureSheet(root);
            for (const comment of list) {
                const range = rangesFor(root, comment);
                if (!range) continue;
                const bucket = cm.ranges.get(comment.id) || [];
                bucket.push({ root, range });
                cm.ranges.set(comment.id, bucket);
                (comment.id === cm.active ? on : all).push(range);
            }
        }
        CSS.highlights.set('uttu-comment', new Highlight(...all));
        CSS.highlights.set('uttu-comment-on', new Highlight(...on));
        paintChanges(roots);
    }
    function setActive(id, scroll) {
        cm.active = id;
        cmList.querySelectorAll('.uttu-cmt').forEach((element) => element.classList.toggle('on', element.dataset.cm === id));
        paintMarks();
        if (scroll) {
            for (const { range } of cm.ranges.get(id) || []) {
                range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }
    let markTimer = 0;
    const schedulePaint = (delay = 350) => {
        clearTimeout(markTimer);
        markTimer = setTimeout(() => {
            paintMarks();
            // 原文找不到的批注要标出来。
            if (document.body.classList.contains('uttu-right-open') && UI.layout.rtab === 'comments') renderComments();
        }, delay);
    };

    // ---------- Agent 改动的标记：合入后，新出现或改过的段落淡绿底，用户自己动手改文档或换文档时消失 ----------
    const change = { before: null, probes: [], timer: 0 };
    const blocksOf = (source) => String(source || '').split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
    // 每段取开头一小截排好后的字（去掉 Markdown 记号和标签），用它在编辑面、预览里找到那一段。
    function probeOf(block) {
        if (/^(```|~~~|<|\|)/.test(block)) return '';
        return block.replace(/^(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
            .replace(/<[^>]+>/g, '')
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/[*_`~]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 24);
    }
    function markChanges() {
        const after = session()?.source?.();
        if (typeof change.before !== 'string' || typeof after !== 'string') {
            change.before = null;
            return;
        }
        const old = new Set(blocksOf(change.before));
        change.probes = blocksOf(after).filter((block) => !old.has(block)).map(probeOf).filter((probe) => probe.length >= 2).slice(0, 40);
        change.before = null;
        clearTimeout(change.timer);
        change.timer = setTimeout(clearChanges, 3 * 60 * 1000);
        schedulePaint(300);
    }
    function clearChanges() {
        if (!change.probes.length) return;
        change.probes = [];
        try {
            CSS.highlights?.delete('uttu-change');
        } catch (_) { /* 不支持高亮 */ }
    }
    function paintChanges(roots) {
        if (!change.probes.length || !window.CSS?.highlights || typeof window.Highlight !== 'function') return;
        const ranges = [];
        for (const root of roots) {
            const { text, segments } = UI.textSegments?.(root) || { text: '', segments: [] };
            for (const probe of change.probes) {
                const at = text.indexOf(probe);
                if (at < 0) continue;
                const segment = segments.find((item) => at >= item.start && at < item.end);
                const block = segment?.node.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th');
                if (!block) continue;
                const range = document.createRange();
                range.selectNodeContents(block);
                ranges.push(range);
            }
        }
        CSS.highlights.set('uttu-change', new Highlight(...ranges));
    }

    // ---------- 文脉：上游面板顶上加一个“建保存点”（上游按钮在藏起的面板头里）----------
    const lineageBar = make('div', 'uttu-lineage-bar');
    const checkpointButton = button('uttu-btn ghost small', '', '建保存点', () => UI.forward('create-checkpoint-btn'));
    lineageBar.append(checkpointButton);
    page('lineage').prepend(lineageBar);
    function renderLineageBar() {
        checkpointButton.disabled = !UI.doc() || $('create-checkpoint-btn')?.disabled !== false;
    }

    // ---------- 顶栏的 Agent 状态：Agent 在读、在改；改完可以点开看改动 ----------
    const READ_METHODS = /^(get|search|list|selectSlide|buildProjectArtifact)/;
    const agent = { writing: 0, readTimer: 0, doneTimer: 0, waitTimer: 0 };
    function agentState(state) {
        clearTimeout(agent.doneTimer);
        if (state === 'reading') UI.setAgent?.('Agent 在看这份文档', { busy: true });
        else if (state === 'writing') UI.setAgent?.('Agent 正在改', { busy: true });
        else if (state === 'done') {
            UI.setAgent?.('Agent 改好了 · 看改动');
            agent.doneTimer = setTimeout(() => UI.setAgent?.(''), 9000);
        } else UI.setAgent?.('');
    }
    UI.on('agent-status-click', () => {
        UI.showChange?.('');
        agentState('');
    });
    function onAgentRequest(request) {
        const method = String(request?.method || '');
        if (!method) return;
        if (READ_METHODS.test(method)) {
            if (agent.writing) return;
            agentState('reading');
            clearTimeout(agent.readTimer);
            agent.readTimer = setTimeout(() => { if (!agent.writing) agentState(''); }, 1600);
            return;
        }
        clearTimeout(agent.readTimer);
        agent.writing = Date.now();
        // 记下改之前的源码，合入后比出哪些段落是新的。
        if (change.before === null) change.before = session()?.source?.() ?? null;
        agentState('writing');
        // 自动合入时文档马上就变；要审批的话一直没变化，过一会儿收起（待审在文脉里）。
        clearTimeout(agent.waitTimer);
        agent.waitTimer = setTimeout(() => {
            if (!agent.writing) return;
            agent.writing = 0;
            agentState('');
            if (Number($('pending-pr-count')?.textContent) > 0) {
                UI.setRightBadge('lineage', '待审');
                UI.toast('Agent 交了一处修改，等你在文脉里看过再合入。');
            }
        }, 20000);
    }
    function onAgentChanged() {
        if (!agent.writing) return;
        agent.writing = 0;
        clearTimeout(agent.waitTimer);
        agentState('done');
        markChanges();
        const visible = document.body.classList.contains('uttu-right-open') && UI.layout.rtab === 'lineage';
        if (!visible) UI.setRightBadge('lineage', '新');
    }

    // ---------- 跟着状态走 ----------
    function renderAll() {
        renderFormat();
        renderDoc();
        renderComments();
        renderLineageBar();
    }
    // 文本和网页的改动记录：外面改了文件时记一笔（viewFiles 的 history-*）。别的类型没有。
    const history = make('div', 'uttu-file-history');
    page('lineage').append(history);
    const whenOf = (at) => { const d = new Date(at); return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    function changedLines(before, after) {
        const a = before.split('\n');
        const b = after.split('\n');
        let head = 0;
        while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
        let tail = 0;
        while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
        return { line: head + 1, old: a.slice(head, a.length - tail), new: b.slice(head, b.length - tail) };
    }
    async function renderHistory() {
        const doc = overlayDoc();
        if (!doc || UI.layout?.rtab !== 'lineage') return;
        if (!['web-page', 'text', 'board'].includes(doc.kind)) {
            history.replaceChildren(make('p', 'note', '这类文件没有改动记录。'));
            return;
        }
        const result = await window.scriptoriumAPI?.view?.('history-list', { file: doc.filePath }).catch(() => null);
        if (overlayDoc()?.filePath !== doc.filePath) return;
        const list = result?.list || [];
        if (!list.length) {
            history.replaceChildren(make('p', 'note', '外面改过这份文件后记在这里。'));
            return;
        }
        history.replaceChildren(...list.map((entry) => {
            const diff = changedLines(entry.before, entry.after);
            const card = make('div', 'uttu-cmt');
            card.append(make('div', 'target', `第 ${diff.line} 行起，删 ${diff.old.length} 行，加 ${diff.new.length} 行`));
            const lines = make('div', 'uttu-file-diff');
            lines.hidden = true;
            for (const text of diff.old.slice(0, 12)) lines.append(make('div', 'old', escapeHtml(text) || ' '));
            for (const text of diff.new.slice(0, 12)) lines.append(make('div', 'new', escapeHtml(text) || ' '));
            const foot = make('div', 'foot');
            foot.append(make('span', '', whenOf(entry.at)), make('span', 'grow'),
                button('uttu-link-btn', '', '看改动', () => { lines.hidden = !lines.hidden; }),
                button('uttu-link-btn', '', '退回', async () => {
                    const restored = await window.scriptoriumAPI.view('history-restore', { file: doc.filePath, id: entry.id }).catch((error) => ({ error: error.message }));
                    if (!restored?.success) UI.toast(restored?.error || '没退回去。', 'error', 5000);
                    else void UI.overlay()?.reload?.();
                }));
            card.append(lines, foot);
            return card;
        }));
    }
    UI.on('view-file-changed', () => void renderHistory());
    UI.on('document', () => {
        document.body.classList.toggle('uttu-overlay', Boolean(UI.overlay?.()));
        if (UI.overlay?.() && !['comments', 'lineage'].includes(UI.layout?.rtab)) UI.setRightTab('comments');
        if (UI.doc()?.kind === 'board' && UI.layout?.rtab === 'comments') UI.setRightTab('lineage'); // 白板没有批注
        void renderHistory();
        loadComments();
        agentState('');
        clearChanges();
        change.before = null;
        renderAll();
        schedulePaint(600);
    });
    UI.on('right-tab', (key) => {
        if (key === 'comments' && UI.doc()?.kind === 'board') { UI.setRightTab('lineage'); return; }
        if (key === 'lineage') UI.setRightBadge('lineage', '');
        void renderHistory();
        renderAll();
    });
    UI.on('view', () => {
        renderFormat();
        schedulePaint(300);
    });
    UI.on('caret', () => {
        if (document.body.classList.contains('uttu-right-open') && UI.layout.rtab === 'format') renderFormat();
    });
    UI.on('preview-rendered', () => schedulePaint(200));
    UI.on('doc-event', (event) => {
        if (event.type === 'document-replaced') return;
        if (event.type === 'document-mutated') {
            const reason = String(event.reason || '');
            // Agent 的修改合入时 reason 是 agent-…（agent-source-pr、agent-pr-applied、agent-slide-…）。
            if (reason.startsWith('agent-')) onAgentChanged();
            // 用户自己动手改了，Agent 改动的标记就不留了（派生状态、批注、文脉同步不算）。
            else if (!event.derived && !/^(uttu-comments|derived-state|lineage-|programmable-|flow-compiled)/.test(reason)) clearChanges();
            // 撤销、重做会把批注一起带回某个版本：照文档里的重新读。
            if (!reason.startsWith('uttu-comments')) {
                const stored = session()?.comments?.() || [];
                if (JSON.stringify(stored) !== JSON.stringify(cm.list)) {
                    cm.list = stored;
                    renderComments();
                }
            }
            schedulePaint();
        }
        renderDoc();
        renderLineageBar();
    });
    UI.on('start', () => {
        window.scriptoriumAPI?.onAgentRequest?.(onAgentRequest);
        // 在编辑面里点到批注过的字：右侧批注页开着时，对应的那张卡片亮起来。
        document.addEventListener('click', (event) => {
            const root = session()?.editRoot?.();
            const target = event.composedPath?.()[0];
            if (!root || !target || !root.contains(target) || !cm.ranges.size) return;
            setTimeout(() => {
                const selection = root.getSelection?.() || document.getSelection();
                if (!selection?.rangeCount || !selection.isCollapsed) return;
                const { startContainer, startOffset } = selection.getRangeAt(0);
                for (const [id, entries] of cm.ranges) {
                    if (entries.some(({ range }) => {
                        try {
                            return range.isPointInRange(startContainer, startOffset);
                        } catch (_) {
                            return false;
                        }
                    })) {
                        if (document.body.classList.contains('uttu-right-open') && UI.layout.rtab === 'comments') setActive(id, false);
                        return;
                    }
                }
            }, 0);
        }, true);
        const checkpoint = $('create-checkpoint-btn');
        if (checkpoint) new MutationObserver(renderLineageBar).observe(checkpoint, { attributes: true, attributeFilter: ['disabled'] });
        // 上游同步字体、字号、颜色框以后跟着刷新格式页。
        for (const id of ['font-family-select', 'font-size-select', 'text-color-input']) {
            $(id)?.addEventListener('change', renderFormat);
        }
        loadComments();
        renderAll();
    });
})();
