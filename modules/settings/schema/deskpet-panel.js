// schema/deskpet-panel — 全局设置「桌宠」分区的面板（自包含 DOM + 行为）。
//
//   上面：当前桌宠的大预览，脚边是和桌面上一样的小胶囊（DeskPetmodules/dock.css 同一份样式），
//         点打字展开成输入条、点说话变成录音按钮；在这里打的字由桌宠发出去，回复显示在桌宠头上。
//   中间：我的桌宠——选助手，再从它的几套形象里挑一张卡片（「无」是收起这个助手的桌宠），
//         卡片上是离屏渲染的快照（主进程 modules/deskpet/petPreviews.js），渲染好一张换一张。
//   下面：免打扰、启动恢复、全局快捷键。
//
// 主进程：modules/deskpet/settingsPage.js、petControls.js（deskpet-settings:*）。不进表单 collect/自动保存。
// 编译期（JSDOM 契约检查）没有 electronAPI，只产出结构。

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || '');
const CATALOG_DEBOUNCE_MS = 150;

function getApi(doc) {
    const win = doc?.defaultView;
    const api = win?.chatAPI || win?.electronAPI;
    return api && typeof api.getDeskPetCatalog === 'function' ? api : null;
}

function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(doc, className, text, attrs = {}) {
    const node = el(doc, 'button', className, text);
    node.type = 'button';
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
    edit: ['M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7', 'M18.4 2.6a2.1 2.1 0 0 1 3 3l-9 9a2 2 0 0 1-.9.5l-2.9.8.8-2.9a2 2 0 0 1 .5-.8Z'],
    voice: ['M4 10v4', 'M8 7v10', 'M12 4v16', 'M16 7v10', 'M20 10v4'],
    plus: ['M12 5v14', 'M5 12h14'],
    collapse: ['m6 9 6 6 6-6'],
    send: ['M12 19V5', 'm5 12 7-7 7 7'],
    refresh: ['M21 12a9 9 0 1 1-2.6-6.4', 'M21 4v5h-5'],
    none: ['M5 5l14 14', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z'],
};

function icon(doc, name) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) {
        const path = doc.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        svg.append(path);
    }
    return svg;
}

function formatAccelerator(accelerator) {
    if (!accelerator) return '';
    return accelerator
        .replace('CommandOrControl', IS_MAC ? 'Cmd' : 'Ctrl')
        .replace('Super', IS_MAC ? 'Cmd' : 'Win')
        .split('+').join(' + ');
}

// KeyboardEvent → Electron accelerator 写法；只按了修饰键时返回 null
function acceleratorFromEvent(e) {
    const code = e.code || '';
    let key = null;
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit\d$/.test(code)) key = code.slice(5);
    else if (/^Numpad\d$/.test(code)) key = code.slice(6);
    else if (/^F\d{1,2}$/.test(code)) key = code;
    else {
        key = {
            Space: 'Space', Tab: 'Tab', Enter: 'Enter', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End',
            PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
            Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
            Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`',
        }[code] || null;
    }
    if (!key) return null;
    const parts = [];
    if (IS_MAC ? e.metaKey : e.ctrlKey) parts.push('CommandOrControl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (!IS_MAC && e.metaKey) parts.push('Super');
    parts.push(key);
    return parts.join('+');
}

// 和桌宠页面同样的小胶囊结构（样式见 DeskPetmodules/dock.css）
function buildDock(doc) {
    const dock = el(doc, 'div', 'pet-dock dps-dock');
    dock.dataset.mode = 'pill';
    const pill = el(doc, 'div', 'dock-layer dock-pill');
    const edit = button(doc, 'dock-btn', undefined, { title: '打字和 TA 说', 'aria-label': '打字' });
    edit.append(icon(doc, 'edit'));
    const voice = button(doc, 'dock-btn', undefined, { title: '说话（本地语音识别）', 'aria-label': '说话' });
    voice.append(icon(doc, 'voice'));
    // 预览里多一个收起钮：点了收成脚边的小横条，光标再进来又撑开（桌面上光标离开就自己收）
    const collapse = button(doc, 'dock-btn', undefined, { title: '收起', 'aria-label': '收起' });
    collapse.append(icon(doc, 'collapse'));
    pill.append(edit, el(doc, 'i', 'dock-sep'), voice, el(doc, 'i', 'dock-sep'), collapse);
    const bar = el(doc, 'form', 'dock-layer dock-bar');
    const fresh = button(doc, 'dock-btn dock-round', undefined, { title: '开新话题', 'aria-label': '开新话题', 'aria-pressed': 'false' });
    fresh.append(icon(doc, 'plus'));
    const input = el(doc, 'textarea', 'dock-input');
    input.rows = 1;
    input.maxLength = 8000;
    input.setAttribute('aria-label', '和桌宠说的话');
    const send = button(doc, 'dock-send is-empty', undefined, { title: '发送（Enter）', 'aria-label': '发送' });
    send.append(icon(doc, 'send'));
    bar.append(fresh, input, send);
    const rec = el(doc, 'div', 'dock-layer dock-rec');
    const recEdit = button(doc, 'dock-btn', undefined, { title: '改成打字', 'aria-label': '打字' });
    recEdit.append(icon(doc, 'edit'));
    const stop = button(doc, 'rec-stop', undefined, { title: '说完了（Esc 取消）', 'aria-label': '说完了' });
    stop.append(el(doc, 'span', 'rec-dot'));
    rec.append(recEdit, stop);
    dock.append(pill, bar, rec);
    return { dock, edit, voice, collapse, bar, fresh, input, send, recEdit, stop };
}

function buildSwitchRow(doc, title, hint) {
    const row = el(doc, 'label', 'dps-row');
    const copy = el(doc, 'span', 'dps-row-copy');
    copy.append(el(doc, 'span', 'dps-row-title', title), el(doc, 'span', 'dps-row-hint', hint));
    const toggle = el(doc, 'span', 'dps-switch');
    const input = el(doc, 'input');
    input.type = 'checkbox';
    toggle.append(input, el(doc, 'span', 'dps-switch-knob'));
    row.append(copy, toggle);
    return { row, input };
}

export function buildDeskPetPanel(doc) {
    const root = el(doc, 'div', 'dps');
    root.id = 'deskPetSettingsPanel';

    // ---- 结构 ----
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
    const dockParts = buildDock(doc);
    const dockHost = el(doc, 'div', 'dps-stage-dock');
    dockHost.append(dockParts.dock);
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

    const head = el(doc, 'div', 'dps-head');
    const headTitle = el(doc, 'h4', 'dps-subtitle', '我的桌宠');
    const agentSelect = el(doc, 'select', 'dps-agent');
    agentSelect.setAttribute('aria-label', '选择助手');
    // 自己管样式和行为：设置页的下拉投影不接管它
    agentSelect.dataset.vcpTypedPrimitiveMounted = 'true';
    const spacer = el(doc, 'span', 'dps-spacer');
    const refreshBtn = button(doc, 'dps-icon-btn', undefined, { title: '重新扫描形象、重画预览', 'aria-label': '刷新' });
    refreshBtn.append(icon(doc, 'refresh'));
    const importBtn = button(doc, 'dps-btn', '导入形象', { title: '选 Live2D 模型（.model3.json 或压缩包 .zip）、网格立绘（.puppet.json），或者一张/几张立绘图片；也可以直接拖到下面的形象列表上' });
    head.append(headTitle, agentSelect, spacer, refreshBtn, importBtn);
    const grid = el(doc, 'div', 'dps-grid');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', '桌宠形象');

    // Live2D 支持：Cubism Core 是 Live2D 的专有组件，不随应用附带，在这里一键装好
    const coreTitle = el(doc, 'h4', 'dps-subtitle', 'Live2D 支持');
    const coreCard = el(doc, 'div', 'dps-card dps-core');
    const coreRow = el(doc, 'div', 'dps-row');
    const coreCopy = el(doc, 'span', 'dps-row-copy');
    const coreState = el(doc, 'span', 'dps-row-title');
    const coreHint = el(doc, 'span', 'dps-row-hint');
    coreHint.setAttribute('aria-live', 'polite');
    coreCopy.append(coreState, coreHint);
    coreRow.append(coreCopy);
    const coreActions = el(doc, 'div', 'dps-card-actions');
    const coreDownloadBtn = button(doc, 'dps-btn dps-btn-primary', '同意并下载');
    const coreFileBtn = button(doc, 'dps-btn', '选择本地文件…', { title: '已经从 Live2D 官网下好了 Cubism SDK for Web：选压缩包或其中的 live2dcubismcore.min.js' });
    const coreLicenseBtn = button(doc, 'dps-link', '许可协议');
    coreActions.append(coreLicenseBtn, coreFileBtn, coreDownloadBtn);
    coreCard.append(coreRow, coreActions);
    // 表情映射：选中的那套是 Live2D 时出现，回复里的情绪对应模型的哪个表情、哪个动作
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

    const optionsTitle = el(doc, 'h4', 'dps-subtitle', '选项');
    const options = el(doc, 'div', 'dps-card');
    const dnd = buildSwitchRow(doc, '免打扰', '不主动说话、不出声，主窗口里聊天的回复也不在桌宠头上冒出来。在桌宠上跟 TA 说的话照常回。');
    const restore = buildSwitchRow(doc, '启动时恢复桌宠', '打开 VCPChat 时，把上次开着的桌宠放回原来的位置。');
    const yieldFs = buildSwitchRow(doc, '全屏时让开', '看视频、玩游戏、放幻灯片时桌宠先躲起来，退出全屏再回来。只在 Windows 上有效。');
    yieldFs.row.hidden = true;
    const through = buildSwitchRow(doc, '只看不点', '鼠标直接穿过桌宠，点不到也拖不动，适合专心工作时。用托盘菜单或快捷键关掉；「和桌宠说话」的快捷键照常能用。');
    const follow = buildSwitchRow(doc, '视线跟随光标', '光标在屏幕上移动时 TA 跟着看过去。关掉后只自己四处看看，不会一直盯着光标。');
    const wander = buildSwitchRow(doc, '在桌面上溜达', '站在任务栏上闲了一阵，会沿着任务栏走一小段。');
    const hideCapture = buildSwitchRow(doc, '截图、录屏时隐藏', '截图、录屏、开会共享屏幕时画面里不出现桌宠，自己屏幕上照常看得到。');
    hideCapture.row.hidden = true;
    const opacityRow = el(doc, 'div', 'dps-row');
    const opacityCopy = el(doc, 'span', 'dps-row-copy');
    opacityCopy.append(el(doc, 'span', 'dps-row-title', '不透明度'), el(doc, 'span', 'dps-row-hint', '角色淡一点，后面的字能透出来；气泡和输入框不变。'));
    const opacityControl = el(doc, 'span', 'dps-size');
    const opacitySlider = el(doc, 'input', 'dps-slider');
    opacitySlider.type = 'range';
    opacitySlider.min = '0.3';
    opacitySlider.max = '1';
    opacitySlider.step = '0.05';
    opacitySlider.setAttribute('aria-label', '桌宠不透明度');
    const opacityValue = el(doc, 'span', 'dps-size-value');
    opacityControl.append(opacitySlider, opacityValue);
    opacityRow.append(opacityCopy, opacityControl);
    const idleRow = el(doc, 'div', 'dps-row');
    const idleCopy = el(doc, 'span', 'dps-row-copy');
    idleCopy.append(
        el(doc, 'span', 'dps-row-title', '闲着时主动搭话'),
        el(doc, 'span', 'dps-row-hint', '你在电脑前、但这么久没和 TA 说话时，TA 会主动说一句（记在「桌宠闲聊」话题里，点气泡接着聊）。每次会调用一次模型；离开电脑、深夜、免打扰时不说。'),
    );
    const idleSelect = el(doc, 'select', 'dps-agent');
    idleSelect.id = 'deskPetIdleChat';
    idleSelect.setAttribute('aria-label', '闲着时主动搭话');
    idleSelect.dataset.vcpTypedPrimitiveMounted = 'true';
    for (const [value, label] of [['off', '不主动说'], ['10', '每 10 分钟'], ['30', '每 30 分钟'], ['60', '每 60 分钟']]) {
        const option = el(doc, 'option', '', label);
        option.value = value;
        idleSelect.append(option);
    }
    idleRow.append(idleCopy, idleSelect);
    options.append(dnd.row, idleRow, through.row, follow.row, wander.row, opacityRow, hideCapture.row, restore.row, yieldFs.row);

    const shortcutsTitle = el(doc, 'h4', 'dps-subtitle', '快捷键');
    const shortcuts = el(doc, 'div', 'dps-card');
    const shortcutHint = el(doc, 'p', 'dps-row-hint dps-card-hint', '在任何程序里都能用。点一下按钮，再按下想要的组合键；Esc 取消，Backspace 清除。');
    const shortcutList = el(doc, 'div', 'dps-shortcuts');
    const resetRow = el(doc, 'div', 'dps-card-actions');
    const resetBtn = button(doc, 'dps-btn', '恢复默认快捷键');
    resetRow.append(resetBtn);
    shortcuts.append(shortcutHint, shortcutList, resetRow);

    root.append(intro, stage, drawer, head, grid, mapSection, coreTitle, coreCard, optionsTitle, options, shortcutsTitle, shortcuts);

    // 设置表单的自动保存不碰这里的控件
    const keepInside = (e) => e.stopPropagation();
    root.addEventListener('input', keepInside);
    root.addEventListener('change', keepInside);
    root.addEventListener('submit', keepInside);

    const api = getApi(doc);
    if (!api) {
        lead.textContent = '桌宠设置只能在 VCPChat 里打开。';
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

    // ---- 大预览 ----

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
        state.placeholder = `和 ${name} 说点什么…`;
        if (!state.fresh) dockParts.input.placeholder = state.placeholder;
        customBtn.hidden = !c?.agentId;
    }

    function note(text, { error = false, ms = 3200 } = {}) {
        stageNote.textContent = text;
        stageNote.classList.toggle('is-error', error);
        stageNote.classList.add('is-shown');
        clearTimeout(note.timer);
        note.timer = setTimeout(() => stageNote.classList.remove('is-shown'), ms);
    }

    // ---- 预览里的小胶囊：和桌面上一样的三态 ----

    function setDock(mode) {
        dockParts.dock.dataset.mode = mode;
        stage.dataset.dock = mode;
        if (mode === 'bar') {
            fitInput();
            setTimeout(() => dockParts.input.focus({ preventScroll: true }), 80);
        }
    }

    // 输入条左边的「+」：这一句开个新话题再发
    function setFresh(on) {
        state.fresh = on;
        dockParts.fresh.setAttribute('aria-pressed', String(on));
        dockParts.fresh.title = on ? '取消，接着原来的话题说' : '开新话题';
        dockParts.input.placeholder = on ? '开始新聊天' : state.placeholder || '';
    }

    function fitInput() {
        const input = dockParts.input;
        input.style.height = 'auto';
        const height = Math.min(96, Math.max(40, input.scrollHeight || 40));
        input.style.height = `${height}px`;
        dockParts.dock.style.setProperty('--dock-bar-h', `${height + 12}px`);
        dockParts.send.classList.toggle('is-empty', !input.value.trim());
    }

    async function sendFromStage() {
        const text = dockParts.input.value.trim();
        if (!text || !state.catalog?.agentId) return;
        dockParts.send.disabled = true;
        try {
            const result = await api.talkToDeskPet(state.catalog.agentId, text, { newTopic: state.fresh });
            if (result?.success) {
                dockParts.input.value = '';
                setFresh(false);
                fitInput();
                setDock('pill');
                note(`发给桌面上的 ${state.catalog.name} 了，回复显示在 TA 头上`);
            } else {
                note(`没发出去：${result?.error || '未知原因'}`, { error: true });
            }
        } finally {
            dockParts.send.disabled = false;
        }
    }

    async function voice() {
        if (!state.voice) {
            const { createDictation } = await import('../../../DeskPetmodules/dictation.js');
            state.voice = createDictation({
                status: () => api.getLocalSttStatus(),
                transcribe: (wav, language) => api.transcribeLocalStt({ wav, language }),
                onLevel: (level) => dockParts.stop.style.setProperty('--level', level.toFixed(2)),
            });
        }
        return state.voice;
    }

    async function startVoice() {
        const dictation = await voice().catch(() => null);
        if (!dictation || dictation.active || dictation.starting || dockParts.stop.classList.contains('is-busy')) return;
        const from = dockParts.dock.dataset.mode;
        setDock('rec');
        try {
            await dictation.start();
            dictation.onLimit(() => finishVoice());
        } catch (error) {
            if (error.code === 'cancelled') return; // 打开麦克风前就被收起：界面已经是别的状态了
            note(error.message, { error: true, ms: 6000 });
            setDock(from === 'bar' ? 'bar' : 'pill');
        }
    }

    async function finishVoice() {
        const dictation = state.voice;
        // 麦克风还没打开就点了停：当作取消
        if (dictation?.starting) {
            dictation.cancel();
            setDock(dockParts.input.value.trim() ? 'bar' : 'pill');
            return;
        }
        if (!dictation?.active || dockParts.stop.classList.contains('is-busy')) return;
        dockParts.stop.classList.add('is-busy');
        let text = '';
        try {
            text = await dictation.stop();
        } catch (error) {
            note(error.message, { error: true });
        } finally {
            dockParts.stop.classList.remove('is-busy');
        }
        if (dockParts.dock.dataset.mode !== 'rec') return;
        const input = dockParts.input;
        if (text) input.value = input.value.trim() ? `${input.value.trimEnd()} ${text}` : text;
        else if (!input.value.trim()) note('没听到说话');
        setDock(input.value.trim() ? 'bar' : 'pill');
    }

    function cancelVoice() {
        state.voice?.cancel();
    }

    dockParts.edit.addEventListener('click', () => setDock('bar'));
    dockParts.recEdit.addEventListener('click', () => { cancelVoice(); setDock('bar'); });
    dockParts.voice.addEventListener('click', startVoice);
    dockParts.fresh.addEventListener('click', () => { setFresh(!state.fresh); dockParts.input.focus({ preventScroll: true }); });
    dockParts.collapse.addEventListener('click', () => setDock('hidden'));
    // 收起后光标回到预览里：停一下再撑开，和桌面上一样
    let reopenTimer = 0;
    stage.addEventListener('pointerenter', () => {
        clearTimeout(reopenTimer);
        if (dockParts.dock.dataset.mode === 'hidden') reopenTimer = setTimeout(() => { if (dockParts.dock.dataset.mode === 'hidden') setDock('pill'); }, 220);
    });
    stage.addEventListener('pointerleave', () => clearTimeout(reopenTimer));
    dockParts.stop.addEventListener('click', finishVoice);
    dockParts.send.addEventListener('click', sendFromStage);
    dockParts.bar.addEventListener('submit', (e) => { e.preventDefault(); sendFromStage(); });
    dockParts.input.addEventListener('input', fitInput);
    dockParts.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            sendFromStage();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation(); // 别把整个设置关了
            setDock('pill');
        }
    });
    dockParts.dock.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dockParts.dock.dataset.mode === 'rec') {
            e.preventDefault();
            e.stopPropagation();
            cancelVoice();
            setDock('pill');
        }
    });
    // 设置页的 Esc 在 document 捕获阶段就把整个设置关了；输入条 / 录音条展开时，
    // 先在 window 捕获阶段标记掉，Esc 只收回胶囊（上面两个 keydown 照常处理）
    win?.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || dockParts.dock.dataset.mode === 'pill' || !dockParts.dock.contains(e.target)) return;
        e.preventDefault();
    }, true);
    // 点到预览外面、输入条是空的：收回小胶囊
    doc.addEventListener('pointerdown', (e) => {
        if (dockParts.dock.dataset.mode === 'bar' && !dockParts.input.value.trim() && !dockParts.dock.contains(e.target)) setDock('pill');
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
        folderHint.textContent = `往里面放 Live2D 模型、网格立绘或立绘图片，每个子文件夹是一套形象：${c.folder}`;
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
                const empty = el(doc, 'p', 'dps-empty', '这个助手还没有形象：现在显示的是头像。点「导入形象」放一个 Live2D 模型或一张立绘进来。');
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
        renderStage();
        try {
            const result = await api.chooseDeskPetOutfit(c.agentId, outfitId);
            if (result?.success === false) note(result.error || '没换成', { error: true });
            if (result?.catalog && result.catalog.agentId === state.agentId) applyCatalog(result.catalog);
        } finally {
            state.choosing = false;
            renderGrid(false);
            if (state.reloadPending) {
                state.reloadPending = false;
                scheduleReload();
            }
        }
    }

    // ---- 助手、显示隐藏、导入、刷新 ----

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
        importBtn.disabled = !state.catalog?.agentId;
    }

    function applyCatalog(catalog, { fresh = false } = {}) {
        const switched = state.catalog?.agentId !== catalog?.agentId;
        state.catalog = catalog;
        state.agentId = catalog?.agentId || null;
        // 装好 Cubism Core 以后同一套的种类和介绍会变，卡片也要重建
        const ids = JSON.stringify((catalog?.outfits || []).map((o) => [o.id, o.kind, o.description]));
        const rebuild = fresh || switched || grid.dataset.ids !== ids;
        grid.dataset.ids = ids;
        renderAgents();
        renderIntro();
        renderStage();
        renderDrawer();
        renderGrid(rebuild);
        renderCore();
        renderMapSection();
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

    agentSelect.addEventListener('change', () => {
        cancelVoice();
        setDock('pill');
        state.shownOutfit = undefined;
        loadCatalog(agentSelect.value);
    });
    visibleBtn.addEventListener('click', async () => {
        visibleBtn.disabled = true;
        try {
            const catalog = await api.setDeskPetsVisible(!state.catalog?.anyVisible, state.agentId);
            if (catalog) applyCatalog(catalog);
        } finally {
            visibleBtn.disabled = false;
        }
    });
    refreshBtn.addEventListener('click', async () => {
        refreshBtn.classList.add('is-spinning');
        try { await loadCatalog(state.agentId, { refresh: true }); } finally { setTimeout(() => refreshBtn.classList.remove('is-spinning'), 500); }
    });
    async function runImport(files) {
        if (!state.agentId || importBtn.disabled) return;
        importBtn.disabled = true;
        try {
            const result = await api.importDeskPetOutfit(state.agentId, files);
            if (result?.catalog) applyCatalog(result.catalog);
            if (result?.success) note(`导入好了，${state.catalog?.name || 'TA'} 已经换上「${result.outfitId}」`);
            else if (!result?.canceled && result?.error) note(result.error, { error: true, ms: 6000 });
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
        if (!files.length) note('只能导入本机上的文件', { error: true });
        else runImport(files);
    });

    // ---- Live2D 支持（Cubism Core）----

    function size(bytes) {
        return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function renderCore() {
        const status = state.catalog?.core;
        const installing = Boolean(state.coreProgress) || status?.busy === true;
        const wanted = Boolean(state.catalog?.outfits?.some((o) => o.needsCore));
        coreCard.classList.toggle('is-wanted', wanted && !status?.installed);
        coreDownloadBtn.disabled = installing;
        coreFileBtn.disabled = installing;
        const p = state.coreProgress;
        if (p) {
            coreState.textContent = '正在安装 Cubism Core…';
            coreHint.textContent = p.phase === 'verify'
                ? '下载好了，正在取出 Core 并试加载一遍'
                : p.total > 0
                    ? `正在从 Live2D 官网下载 SDK ${size(p.received)} / ${size(p.total)}`
                    : `正在从 Live2D 官网下载 SDK${p.received ? ` ${size(p.received)}` : '…'}`;
            return;
        }
        if (status?.installed) {
            coreState.textContent = status.version ? `Cubism Core ${status.version} 已装好` : 'Cubism Core 已装好';
            coreHint.textContent = 'Live2D 形象可以直接用。想换一份 Core 时选本地文件（只支持 5.x）。';
            coreDownloadBtn.hidden = true;
            coreFileBtn.textContent = '更换…';
            return;
        }
        coreState.textContent = wanted ? `${state.catalog?.name || 'TA'} 的 Live2D 形象还缺 Cubism Core` : '还没装 Cubism Core';
        coreHint.textContent = `Live2D 形象要用 Live2D 官方的 Cubism Core，它是 Live2D 的专有组件，VCPChat 不附带。点「同意并下载」表示你同意 Live2D 的许可协议，会从 Live2D 官网下载 Cubism SDK for Web ${status?.release || ''}，只取出 Core 放进 VCPChat 的数据目录。没装之前，Live2D 形象先用立绘代替。`;
        coreDownloadBtn.hidden = false;
        coreFileBtn.textContent = '选择本地文件…';
    }

    async function installCore(source) {
        if (state.coreProgress) return;
        if (source === 'official') state.coreProgress = { phase: 'download', received: 0, total: 0 };
        renderCore();
        try {
            const result = await api.installDeskPetCore(source, state.agentId);
            state.coreProgress = null;
            if (result?.catalog && result.catalog.agentId === state.agentId) applyCatalog(result.catalog);
            if (result?.success) note(`Cubism Core ${result.version || ''} 装好了，Live2D 形象已经换上`, { ms: 5000 });
            else if (!result?.canceled && result?.error) {
                note(result.error, { error: true, ms: 8000 });
                coreHint.textContent = source === 'official'
                    ? `${result.error}。也可以去 Live2D 官网手动下载 Cubism SDK for Web（5.x），再点「选择本地文件…」。`
                    : `${result.error}。原来的设置没有变。`;
            }
        } finally {
            state.coreProgress = null;
            coreDownloadBtn.disabled = false;
            coreFileBtn.disabled = false;
        }
    }

    coreDownloadBtn.addEventListener('click', () => installCore('official'));
    coreFileBtn.addEventListener('click', () => installCore('file'));
    coreLicenseBtn.addEventListener('click', () => api.openDeskPetCoreLink?.('license'));
    // ---- 表情映射 ----

    const AUTO = '\u0000auto';
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
        mapModule = mapModule || await import('../../../DeskPetmodules/expressionMap.js');
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

    function option(value, text) {
        const node = el(doc, 'option', '', text);
        node.value = value;
        return node;
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
        if (result?.success && !result.showing) note(`桌宠现在没穿「${data.name}」，先在上面选中这一套再试`, { ms: 4200 });
        else if (result?.success) note(`桌宠在演「${label}」`, { ms: 2000 });
        else if (result?.error) note(result.error, { error: true });
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
            note(`「${data.name}」的表情映射存好了${result.showing ? '，桌宠已经换上' : ''}`);
        } else {
            mapSaveBtn.disabled = false;
            note(result?.error || '没存上', { error: true });
        }
    });

    // ---- 选项和快捷键 ----

    function renderSwitches() {
        const settings = state.snapshot?.settings;
        if (!settings) return;
        dnd.input.checked = settings.doNotDisturb === true;
        restore.input.checked = settings.restoreOnLaunch === true;
        yieldFs.input.checked = settings.yieldToFullscreen === true;
        yieldFs.row.hidden = state.snapshot.platform !== 'win32';
        through.input.checked = settings.clickThrough === true;
        follow.input.checked = settings.followCursor !== false;
        wander.input.checked = settings.wander === true;
        hideCapture.input.checked = settings.hideFromCapture === true;
        // Linux 上 Electron 做不到「截图时不出现」
        hideCapture.row.hidden = state.snapshot.platform !== 'win32' && state.snapshot.platform !== 'darwin';
        idleSelect.value = settings.idleChat === true ? String(settings.idleChatMinutes || 30) : 'off';
        const opacity = Number(settings.opacity ?? 1);
        if (doc.activeElement !== opacitySlider) opacitySlider.value = String(opacity);
        opacityValue.textContent = `${Math.round(Number(opacitySlider.value) * 100)}%`;
    }

    async function update(patch) {
        const snapshot = await api.updateDeskPetSettings(patch);
        if (snapshot) applySnapshot(snapshot);
    }
    dnd.input.addEventListener('change', () => update({ doNotDisturb: dnd.input.checked }));
    restore.input.addEventListener('change', () => update({ restoreOnLaunch: restore.input.checked }));
    yieldFs.input.addEventListener('change', () => update({ yieldToFullscreen: yieldFs.input.checked }));
    through.input.addEventListener('change', () => update({ clickThrough: through.input.checked }));
    follow.input.addEventListener('change', () => update({ followCursor: follow.input.checked }));
    idleSelect.addEventListener('change', () => {
        const value = idleSelect.value;
        update(value === 'off' ? { idleChat: false } : { idleChat: true, idleChatMinutes: Number(value) });
    });
    wander.input.addEventListener('change', () => update({ wander: wander.input.checked }));
    hideCapture.input.addEventListener('change', () => update({ hideFromCapture: hideCapture.input.checked }));
    // 拖动时先只改数字，松手再存（拖的过程中桌宠不跟着一下下闪）
    opacitySlider.addEventListener('input', () => { opacityValue.textContent = `${Math.round(Number(opacitySlider.value) * 100)}%`; });
    opacitySlider.addEventListener('change', () => update({ opacity: Number(opacitySlider.value) }));

    function renderShortcuts() {
        const snapshot = state.snapshot;
        if (!snapshot) return;
        shortcutList.replaceChildren();
        for (const [actionId, action] of Object.entries(snapshot.actions)) {
            const row = el(doc, 'div', 'dps-row dps-shortcut');
            const label = el(doc, 'span', 'dps-row-title', action.label);
            const accelerator = snapshot.settings.shortcuts[actionId];
            const recording = state.recording === actionId;
            const key = button(doc, 'dps-key', recording ? '请按下组合键…' : (formatAccelerator(accelerator) || '未设置'));
            key.classList.toggle('is-recording', recording);
            key.classList.toggle('is-empty', !accelerator && !recording);
            key.addEventListener('click', () => (recording ? stopRecording() : startRecording(actionId)));
            key.addEventListener('keydown', (e) => onRecordKey(e, actionId));
            const error = el(doc, 'span', 'dps-key-error', state.errors[actionId] || (snapshot.paused ? '' : snapshot.failures?.[actionId] || ''));
            row.append(label, error, key);
            shortcutList.append(row);
            if (recording) key.focus({ preventScroll: true });
        }
    }

    async function startRecording(actionId) {
        state.recording = actionId;
        delete state.errors[actionId];
        // 录的时候先停掉现有的全局快捷键，否则按下去直接触发了
        applySnapshot(await api.pauseDeskPetShortcuts(true));
    }

    async function stopRecording() {
        if (!state.recording) return;
        state.recording = null;
        applySnapshot(await api.pauseDeskPetShortcuts(false));
    }

    async function onRecordKey(e, actionId) {
        if (state.recording !== actionId) return;
        e.preventDefault();
        e.stopPropagation();
        const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
        if (plain && e.key === 'Escape') return stopRecording();
        let accelerator;
        if (plain && (e.key === 'Backspace' || e.key === 'Delete')) accelerator = '';
        else {
            accelerator = acceleratorFromEvent(e);
            if (accelerator === null) return; // 只按了修饰键，继续等
        }
        state.recording = null;
        await api.pauseDeskPetShortcuts(false);
        const result = await api.setDeskPetShortcut(actionId, accelerator);
        if (result?.success) delete state.errors[actionId];
        else state.errors[actionId] = result?.error || '设置失败';
        applySnapshot(result?.snapshot || (await api.getDeskPetSettings()));
    }

    resetBtn.addEventListener('click', async () => {
        state.errors = {};
        state.recording = null;
        await api.pauseDeskPetShortcuts(false);
        applySnapshot(await api.resetDeskPetShortcuts());
    });

    function applySnapshot(snapshot) {
        if (!snapshot) return;
        const before = JSON.stringify(state.snapshot?.pets || null);
        state.snapshot = snapshot;
        renderSwitches();
        renderShortcuts();
        renderIntro();
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
            if (!root.isConnected || !state.coreProgress || !progress) return;
            state.coreProgress = progress;
            renderCore();
        }),
        api.onDeskPetPreview?.(({ agentId, outfitId, url } = {}) => {
            if (!root.isConnected || agentId !== state.agentId || !state.catalog) return;
            const item = state.catalog.outfits.find((o) => o.id === outfitId);
            if (!item) return;
            item.preview = url || null;
            const card = [...grid.querySelectorAll('.dps-pet-card')].find((node) => node.dataset.outfit === outfitId);
            if (card) setCardPreview(card, url);
            if (state.catalog.outfit === outfitId) renderStage();
        }),
    ].filter(Boolean);

    function onShown() {
        state.visible = true;
        api.getDeskPetSettings().then(applySnapshot).catch(() => {});
        loadCatalog().catch((error) => note(`读不到桌宠：${error.message}`, { error: true }));
    }

    function onHidden() {
        state.visible = false;
        cancelVoice();
        if (dockParts.dock.dataset.mode !== 'bar' || !dockParts.input.value.trim()) setDock('pill');
        if (state.recording) stopRecording();
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
    win.addEventListener('blur', () => { if (state.recording) stopRecording(); });
    renderStage();
    renderIntro();
    return root;
}
