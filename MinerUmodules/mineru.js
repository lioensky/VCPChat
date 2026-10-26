// MinerUmodules/mineru.js
// MinerU 论文工作台：论文库、导入查重、解析队列、全库重复检索与双栏阅读。
import { createMinerUReader } from './mineru-reader.js';

const api = window.utilityAPI || window.electronAPI;
const $ = id => document.getElementById(id);

const VIEW_KEY = 'vcp-mineru-view';
const OUTLINE_KEY = 'vcp-mineru-outline';
const WRAP_KEY = 'vcp-mineru-md-wrap';
const TAB_KEY = 'vcp-mineru-tab';
const MAX_PAPER_ROWS = 500;
const MAX_JOB_ROWS = 200;
const MAX_DEDUPE_MEMBERS = 100;

const STATUS_LABEL = {
    indexed: '已完成',
    running: '进行中',
    timeout: '待续查',
    failed: '失败',
    unknown: '未知',
    new: '新文件',
    duplicate: '本次重复',
    invalid: '无效',
};

const JOB_LABEL = {
    queued: '排队',
    starting: '启动中',
    running: '解析中',
    done: '完成',
    timeout: '待续查',
    failed: '失败',
    cancelled: '已停止',
};

const state = {
    status: null,
    papers: [],
    paperMap: new Map(),
    currentId: '',
    detail: null,
    detailSeq: 0,
    jobs: [],
    libraryTimer: null,
    reloadTimer: null,
    import: {
        paths: [],
        items: [],
        data: null,
        busy: false,
        seq: 0,
        checked: new Set(),
    },
    dedupe: {
        busy: false,
        data: null,
        error: '',
    },
    view: localStorage.getItem(VIEW_KEY) || 'split',
    outline: localStorage.getItem(OUTLINE_KEY) !== '0',
    wrap: localStorage.getItem(WRAP_KEY) === '1',
    tab: 'library',
    settingsOpen: false,
    lastFocus: null,
};

const notifyKeys = new Set();

function el(tag, { className = '', text = '', attrs = {} } = {}) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined) continue;
        node.setAttribute(key, String(value));
    }
    return node;
}

function clearNode(node) {
    while (node?.firstChild) node.removeChild(node.firstChild);
}

function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function formatNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '0';
}

function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
}

function formatTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function baseName(value) {
    return String(value || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || value;
}

function mineruImageUrl(paperId, rel) {
    const pathPart = String(rel || '')
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/');
    return `vcp-mineru://image/${encodeURIComponent(paperId)}/${pathPart}`;
}

async function call(promise) {
    const result = await promise;
    if (!result?.success) throw new Error(result?.error || '调用失败');
    return result.data;
}

let toastTimer = null;
function toast(message, type = 'info') {
    const node = $('toast');
    if (!node) return;
    node.textContent = message;
    node.className = `toast ${type}`;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, type === 'error' ? 5200 : 2800);
}

function statusBadge(group, label) {
    const text = label || STATUS_LABEL[group] || group;
    return el('span', { className: `badge ${group}`, text });
}

let reader = null;
let confirmResolve = null;

const openLightbox = (src, caption) => {
    const box = $('lightbox');
    const img = $('lightbox-img');
    if (!box || !img || !src) return;
    img.src = src;
    $('lightbox-caption').textContent = caption || '';
    box.hidden = false;
    $('lightbox-close')?.focus();
};

function closeLightbox() {
    const box = $('lightbox');
    if (!box) return;
    box.hidden = true;
    $('lightbox-img').removeAttribute('src');
    $('lightbox-caption').textContent = '';
}

function confirmAction(title, body, okText = '确定') {
    return new Promise(resolve => {
        state.lastFocus = document.activeElement;
        $('confirm-title').textContent = title;
        $('confirm-body').textContent = body || '';
        $('confirm-ok').textContent = okText;
        $('confirm-modal').hidden = false;
        confirmResolve = value => {
            confirmResolve = null;
            $('confirm-modal').hidden = true;
            state.lastFocus?.focus?.();
            resolve(value);
        };
        $('confirm-ok').focus();
    });
}

function finishConfirm(value) {
    if (typeof confirmResolve === 'function') confirmResolve(value);
}

function applyTheme(mode) {
    document.body.classList.toggle('light-theme', mode === 'light');
}

function renderStatusChip() {
    const chip = $('status-chip');
    const text = $('status-chip-text');
    if (!chip || !text) return;
    chip.classList.remove('ok', 'warn', 'error');
    const status = state.status;
    if (!status) {
        chip.classList.add('error');
        text.textContent = '状态未知';
        return;
    }
    if (!status.ok) {
        chip.classList.add('error');
        text.textContent = '未连接 VCPToolBox';
        chip.title = status.error || '';
        return;
    }
    if (!status.tokenConfigured) {
        chip.classList.add('warn');
        text.textContent = `v${status.version || '?'} · 未配置 Token`;
        chip.title = `VCPToolBox: ${status.toolboxRoot}\n二进制: ${status.binary}\nMINERU_TOKEN 未在 Plugin/MinerUParser/config.env 中配置`;
        return;
    }
    chip.classList.add('ok');
    text.textContent = `v${status.version || '?'} · 已连接`;
    chip.title = `VCPToolBox: ${status.toolboxRoot}\n二进制: ${status.binary}`;
}

function applyConfigToControls() {
    const config = state.status?.config || {};
    if ($('opt-model')) $('opt-model').value = config.modelVersion === 'pipeline' ? 'pipeline' : 'vlm';
    if ($('opt-workers')) $('opt-workers').value = String(Math.min(5, Math.max(1, Number(config.workers) || 3)));
    if ($('opt-language')) $('opt-language').value = config.language || 'en';
    if ($('opt-ocr')) $('opt-ocr').checked = Boolean(config.isOcr);
    if ($('opt-formula')) $('opt-formula').checked = config.enableFormula !== false;
    if ($('opt-table')) $('opt-table').checked = config.enableTable !== false;
    if ($('opt-recursive')) $('opt-recursive').checked = config.recursive !== false;
}

function readParseOptions() {
    return {
        workers: Number($('opt-workers')?.value) || 3,
        modelVersion: $('opt-model')?.value === 'pipeline' ? 'pipeline' : 'vlm',
        language: ($('opt-language')?.value || 'en').trim() || 'en',
        isOcr: Boolean($('opt-ocr')?.checked),
        enableFormula: $('opt-formula')?.checked !== false,
        enableTable: $('opt-table')?.checked !== false,
    };
}

const persistParseDefaults = debounce(async () => {
    try {
        const result = await call(api.mineruSaveConfig(readParseOptions()));
        state.status = result.status || state.status;
        renderStatusChip();
    } catch (error) {
        toast(`保存解析默认值失败：${error.message}`, 'error');
    }
}, 700);

function setTab(name, { persist = true } = {}) {
    const pages = ['library', 'import', 'dedupe'];
    const target = pages.includes(name) ? name : 'library';
    state.tab = target;
    const sidebar = $('paper-sidebar');
    if (sidebar) {
        sidebar.dataset.sideActive = target;
        sidebar.style.setProperty('--side-index', String(pages.indexOf(target)));
    }
    document.querySelectorAll('.side-tab').forEach(tab => {
        const active = tab.dataset.sideTab === target;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('.side-page').forEach(page => {
        const active = page.dataset.sidePage === target;
        page.inert = !active;
        page.setAttribute('aria-hidden', String(!active));
    });
    if (persist) {
        try { localStorage.setItem(TAB_KEY, target); } catch { /* ignore */ }
    }
}

function renderLibraryStats() {
    const box = $('library-stats');
    if (!box) return;
    clearNode(box);
    const counts = { indexed: 0, running: 0, timeout: 0, failed: 0 };
    for (const paper of state.papers) {
        if (counts[paper.group] !== undefined) counts[paper.group] += 1;
    }
    const add = (label, value, muted = false) => {
        const span = el('span', { className: muted ? 'stat muted' : 'stat' });
        if (!muted) {
            span.append(el('b', { text: formatNum(value) }), document.createTextNode(` ${label}`));
        } else {
            span.textContent = label;
        }
        box.appendChild(span);
    };
    add('篇', state.papers.length);
    add('已完成', counts.indexed);
    if (counts.running) add('进行中', counts.running);
    if (counts.timeout) add('待续查', counts.timeout);
    if (counts.failed) add('失败', counts.failed);
    if (!state.papers.length) add('本地还没有已解析论文', 0, true);
    const countBadge = $('library-count');
    if (countBadge) {
        countBadge.textContent = state.papers.length ? String(state.papers.length) : '';
    }
}

function filteredPapers() {
    const query = ($('library-search')?.value || '').trim().toLowerCase();
    const status = $('library-status')?.value || 'all';
    return state.papers.filter(paper => {
        if (status !== 'all' && paper.group !== status) return false;
        if (!query) return true;
        const hay = [
            paper.title,
            paper.paperId,
            paper.fileName,
            paper.assetDir,
            paper.sourcePath,
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(query);
    });
}

function renderPaperList() {
    const list = $('paper-list');
    if (!list) return;
    clearNode(list);
    const papers = filteredPapers();
    if (!papers.length) {
        list.appendChild(el('li', {
            className: 'empty-list',
            text: state.papers.length ? '没有匹配的论文，试试清空搜索或切换状态。' : '论文库为空。去「导入解析」选择 PDF 或文件夹。',
        }));
        return;
    }
    const visible = papers.slice(0, MAX_PAPER_ROWS);
    for (const paper of visible) {
        const item = el('li', {
            className: `paper-item${paper.paperId === state.currentId ? ' active' : ''}`,
            attrs: { 'data-id': paper.paperId, tabindex: '0', title: paper.title },
        });
        const row = el('div', { className: 'row' });
        row.append(el('div', { className: 'name', text: paper.title }));
        row.appendChild(statusBadge(paper.group, paper.status));
        const sub = el('div', { className: 'sub' });
        sub.append(
            el('span', { text: `${formatNum(paper.pages)} 页` }),
            el('span', { text: `${formatNum(paper.textChars)} 字符` }),
            el('span', { text: `${formatNum(paper.imageCount)} 图` }),
        );
        if (paper.duplicateDirs?.length) {
            sub.appendChild(el('span', { text: `${paper.duplicateDirs.length} 份重复目录` }));
        }
        const pid = el('div', { className: 'pid', text: paper.paperId });
        item.append(row, sub, pid);
        item.addEventListener('click', () => { void selectPaper(paper.paperId); });
        item.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                void selectPaper(paper.paperId);
            }
        });
        list.appendChild(item);
    }
    if (visible.length < papers.length) {
        list.appendChild(el('li', {
            className: 'empty-list',
            text: `仅显示前 ${MAX_PAPER_ROWS} 篇（共 ${papers.length} 篇），请用搜索缩小范围。`,
        }));
    }
}

async function loadLibrary({ silent = false } = {}) {
    try {
        const papers = await call(api.mineruScan());
        state.papers = Array.isArray(papers) ? papers : [];
        state.paperMap = new Map(state.papers.map(paper => [paper.paperId, paper]));
        renderLibraryStats();
        renderPaperList();
        if (state.currentId && !state.paperMap.has(state.currentId)) {
            clearPaperView('该论文已不在论文库中。');
        }
    } catch (error) {
        if (!silent) toast(`读取论文库失败：${error.message}`, 'error');
    }
}

function clearPaperView(message = '') {
    state.currentId = '';
    state.detail = null;
    reader?.close();
    $('paper-view').hidden = true;
    const empty = $('empty-state');
    empty.hidden = false;
    const text = empty.querySelector('p');
    if (text) text.textContent = message || '选择左侧论文开始阅读，或在「导入解析」中批量导入 PDF';
    renderPaperList();
}

function renderHeader(detail) {
    const header = $('paper-header');
    if (!header) return;
    clearNode(header);
    const paper = detail.paper;
    const title = el('h2');
    title.append(document.createTextNode(paper.title || paper.paperId));
    title.appendChild(statusBadge(paper.group, paper.status));
    if (paper.legacyDir) title.appendChild(statusBadge('unknown', '旧目录'));
    if (paper.duplicateDirs?.length) {
        title.appendChild(statusBadge('timeout', `${paper.duplicateDirs.length} 份重复目录`));
    }
    header.appendChild(title);

    const meta = el('div', { className: 'header-meta' });
    const metaItem = (label, value, titleText = '') => {
        if (value === null || value === undefined || value === '') return;
        const span = el('span', { attrs: titleText ? { title: titleText } : {} });
        span.append(document.createTextNode(`${label} `));
        if (label === 'paper_id') {
            span.appendChild(el('code', { text: value }));
        } else {
            span.appendChild(el('strong', { text: value }));
        }
        meta.appendChild(span);
    };
    metaItem('paper_id', paper.paperId);
    metaItem('页数', formatNum(paper.pages));
    metaItem('字符', formatNum(paper.textChars));
    metaItem('图片', formatNum(paper.imageCount));
    if (paper.tableCount) metaItem('表格', formatNum(paper.tableCount));
    if (paper.formulaCount) metaItem('公式', formatNum(paper.formulaCount));
    metaItem('更新', formatTime(paper.updatedAt));
    metaItem('资产目录', paper.assetDir, paper.fileDir);
    if (paper.sourcePath) metaItem('源文件', baseName(paper.sourcePath), paper.sourcePath);
    if (paper.pdfAvailable) metaItem('PDF', paper.pdfName || '已关联', paper.pdfPath);
    header.appendChild(meta);

    if (paper.error) {
        header.appendChild(el('div', { className: 'warn-line', text: `最近错误：${paper.error}` }));
    }
    const issues = (paper.errors?.length || 0) + (paper.warnings?.length || 0);
    if (issues) {
        const summary = [
            ...(paper.errors || []).map(text => `错误：${text}`),
            ...(paper.warnings || []).map(text => `复核：${text}`),
        ].join('\n');
        header.appendChild(el('div', {
            className: 'warn-line',
            text: `质检：${paper.errors?.length || 0} 项错误，${paper.warnings?.length || 0} 项复核（详见左侧大纲下方）`,
            attrs: { title: summary },
        }));
    }

    const actions = el('div', { className: 'header-actions' });
    const addAction = (label, handler, { primary = false } = {}) => {
        const button = el('button', { className: `btn small${primary ? ' primary' : ''}`, text: label, attrs: { type: 'button' } });
        button.addEventListener('click', handler);
        actions.appendChild(button);
    };
    if (!paper.pdfAvailable) {
        addAction('关联本地 PDF', () => { void linkPdf(paper.paperId); }, { primary: true });
    } else {
        addAction('打开 PDF', () => { void openPdf(paper.paperId); });
        addAction('更换 PDF', () => { void linkPdf(paper.paperId); });
    }
    addAction('在文件夹中显示', () => { void revealPaper(paper.paperId); });
    if (['running', 'timeout', 'failed'].includes(paper.group)) {
        addAction('续查进度', () => { void continuePaper(paper.paperId); }, { primary: paper.group !== 'failed' });
    }
    if (paper.group === 'failed' && paper.sourcePath && !/^https?:/i.test(paper.sourcePath)) {
        addAction('重试解析', () => { void retryPaper(paper); });
    }
    addAction('刷新详情', () => { void selectPaper(paper.paperId, { reload: true }); });
    header.appendChild(actions);
}

async function selectPaper(paperId, { reload = false } = {}) {
    if (!paperId) return;
    if (!reload && state.currentId === paperId && state.detail) {
        setTab('library');
        return;
    }
    state.currentId = paperId;
    state.detail = null;
    setTab('library');
    renderPaperList();

    const seq = ++state.detailSeq;
    const view = $('paper-view');
    const empty = $('empty-state');
    empty.hidden = true;
    view.hidden = false;
    const header = $('paper-header');
    clearNode(header);
    header.appendChild(el('div', { className: 'muted', text: '正在加载论文...' }));
    reader?.close();

    try {
        const detail = await call(api.mineruGetPaper(paperId));
        if (seq !== state.detailSeq) return;
        state.detail = detail;
        renderHeader(detail);
        await reader.open(detail);
    } catch (error) {
        if (seq !== state.detailSeq) return;
        clearNode(header);
        header.appendChild(el('h2', { text: '加载失败' }));
        header.appendChild(el('div', { className: 'warn-line', text: error.message }));
        const retry = el('button', { className: 'btn small', text: '重试', attrs: { type: 'button' } });
        retry.addEventListener('click', () => { void selectPaper(paperId, { reload: true }); });
        header.appendChild(retry);
        reader?.close();
    }
}

async function linkPdf(paperId) {
    try {
        const result = await call(api.mineruPickPdfForPaper(paperId));
        if (!result) return;
        toast(`已关联 PDF：${result.pdfName}`, 'success');
        await loadLibrary({ silent: true });
        await selectPaper(paperId, { reload: true });
    } catch (error) {
        toast(error.message, 'error');
    }
}

async function openPdf(paperId) {
    try {
        await call(api.mineruOpenPdf(paperId));
    } catch (error) {
        toast(error.message, 'error');
    }
}

async function revealPaper(paperId) {
    try {
        await call(api.mineruReveal(paperId));
    } catch (error) {
        toast(error.message, 'error');
    }
}

async function continuePaper(paperId) {
    try {
        const created = await call(api.mineruContinue([paperId]));
        mergeJobs(created);
        toast('已加入续查队列', 'success');
    } catch (error) {
        toast(error.message, 'error');
    }
}

async function retryPaper(paper) {
    const ok = await confirmAction('重试解析', `将重新上传并解析：\n${paper.sourcePath}\n\n这会消耗 MinerU API 配额。`, '开始重试');
    if (!ok) return;
    try {
        const created = await call(api.mineruParse({
            items: [{ path: paper.sourcePath, paperId: paper.paperId, title: paper.title }],
            options: readParseOptions(),
        }));
        mergeJobs(created);
        toast('已加入解析队列', 'success');
    } catch (error) {
        toast(error.message, 'error');
    }
}

// ---------------- 导入与查重 ----------------

function renderImportSelection() {
    const box = $('import-selection');
    if (!box) return;
    if (!state.import.paths.length) {
        box.textContent = '尚未选择文件';
        box.title = '';
    } else {
        const names = state.import.paths.map(baseName);
        const preview = names.slice(0, 4).join('、');
        box.textContent = `已选择 ${state.import.paths.length} 个路径：${preview}${names.length > 4 ? ' …' : ''}`;
        box.title = state.import.paths.join('\n');
    }
    const count = state.import.checked.size;
    const badge = $('import-count');
    if (badge) {
        badge.textContent = count ? String(count) : '';
        badge.hidden = !count;
    }
    updateParseButton();
}

function updateParseButton() {
    const button = $('parse-btn');
    const label = $('parse-selected-count');
    const count = selectedImportItems().length;
    if (button) button.disabled = state.import.busy || count === 0;
    if (label) label.textContent = `已选 ${count} 项`;
}

function selectedImportItems() {
    if (!state.import.items.length) return [];
    return state.import.items.filter(item => (
        item.status === 'new'
        && !item.duplicate_in_selection
        && !item._queued
        && state.import.checked.has(item.path)
    ));
}

function importItemEligible(item) {
    return item.status === 'new' && !item.duplicate_in_selection && !item._queued;
}

function addPaths(paths) {
    let added = 0;
    const seen = new Set(state.import.paths.map(item => item.toLowerCase()));
    for (const item of Array.isArray(paths) ? paths : []) {
        if (typeof item !== 'string' || !item.trim()) continue;
        const resolved = item.trim();
        if (seen.has(resolved.toLowerCase())) continue;
        seen.add(resolved.toLowerCase());
        state.import.paths.push(resolved);
        added += 1;
    }
    if (!added) return;
    renderImportSelection();
    void runPreflight();
}

function renderPreflightBusy() {
    const box = $('preflight-summary');
    if (!box) return;
    box.hidden = false;
    clearNode(box);
    box.appendChild(el('div', { className: 'muted', text: '正在计算 SHA-256 并比对论文库，文件较多时需要一些时间...' }));
}

function preflightActionLink(label, handler) {
    const button = el('button', { className: 'mini-link', text: label, attrs: { type: 'button' } });
    button.addEventListener('click', handler);
    return button;
}

function renderPreflightSummary() {
    const box = $('preflight-summary');
    if (!box) return;
    const data = state.import.data;
    if (!data) {
        box.hidden = true;
        return;
    }
    const counts = data.counts || {};
    box.hidden = false;
    clearNode(box);
    const line = el('div');
    line.append(
        document.createTextNode('共 '),
        el('b', { text: String(data.items?.length || 0) }),
        document.createTextNode(' 项：新文件 '),
        el('b', { text: String(counts.new || 0) }),
        document.createTextNode('，已解析 '),
        el('b', { text: String(counts.indexed || 0) }),
        document.createTextNode('，进行中 '),
        el('b', { text: String((counts.running || 0) + (counts.timeout || 0)) }),
        document.createTextNode('，本次重复 '),
        el('b', { text: String(counts.duplicate || 0) }),
        document.createTextNode('，无效 '),
        el('b', { text: String(counts.invalid || 0) }),
    );
    box.appendChild(line);
    if (data.truncated) {
        box.appendChild(el('div', { className: 'warn-line', text: '文件数超过 500 个上限，只检查了前 500 个；请拆分目录。' }));
    }
    const actions = el('div', { className: 'import-row' });
    const selectAll = preflightActionLink('全选新文件', () => {
        state.import.checked = new Set(state.import.items.filter(importItemEligible).map(item => item.path));
        renderImportList();
    });
    const selectNone = preflightActionLink('取消全选', () => {
        state.import.checked.clear();
        renderImportList();
    });
    actions.append(selectAll, selectNone);
    box.appendChild(actions);
}

function renderImportList() {
    const list = $('import-list');
    if (!list) return;
    clearNode(list);
    if (state.import.busy && !state.import.items.length) {
        list.appendChild(el('li', { className: 'empty-list', text: '正在检查...' }));
        return;
    }
    if (!state.import.items.length) {
        list.appendChild(el('li', {
            className: 'empty-list',
            text: state.import.paths.length ? '没有可解析的 PDF。' : '选择 PDF 或文件夹后，这里会显示查重结果。',
        }));
        return;
    }
    for (const item of state.import.items) {
        const eligible = importItemEligible(item);
        const duplicate = Boolean(item.duplicate_in_selection);
        const shownStatus = item.status === 'invalid'
            ? 'invalid'
            : duplicate
                ? 'duplicate'
                : item.status;
        const row = el('li', {
            className: `import-item${eligible ? '' : ' disabled'}`,
            attrs: { title: item.path || '' },
        });
        if (eligible) {
            const checkbox = el('input', {
                attrs: {
                    type: 'checkbox',
                    'aria-label': `选择 ${item.file_name || item.path}`,
                },
            });
            checkbox.checked = state.import.checked.has(item.path);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) state.import.checked.add(item.path);
                else state.import.checked.delete(item.path);
                renderImportSelection();
            });
            row.appendChild(checkbox);
        } else {
            row.appendChild(el('span', { attrs: { style: 'width:15px;flex:0 0 auto' } }));
        }
        const body = el('div', { className: 'body' });
        const top = el('div', { className: 'top' });
        top.append(
            el('div', { className: 'fname', text: item.file_name || baseName(item.path) }),
            statusBadge(shownStatus, item._queued ? '已入队' : undefined),
        );
        body.appendChild(top);
        const meta = el('div', { className: 'meta' });
        meta.textContent = [
            item.size_text,
            item.paper_id,
            item.is_url ? 'URL' : '',
        ].filter(Boolean).join(' · ');
        body.appendChild(meta);
        if (duplicate && item.duplicate_of) {
            body.appendChild(el('div', { className: 'note', text: `与本次选择的「${baseName(item.duplicate_of)}」内容相同` }));
        }
        if (item.name_duplicate_of) {
            body.appendChild(el('div', { className: 'note', text: `同名文件：${baseName(item.name_duplicate_of)}` }));
        }
        if (item.error) {
            body.appendChild(el('div', { className: 'note', text: item.error }));
        }
        if (item.existing?.paper_id) {
            const note = el('div', { className: 'note' });
            note.append(document.createTextNode(`论文库已有：${item.existing.title || item.existing.paper_id} `));
            if (item.existing.status === 'indexed') {
                note.appendChild(preflightActionLink('打开', () => { void selectPaper(item.existing.paper_id); }));
            } else {
                note.appendChild(preflightActionLink('查看进度', () => { void selectPaper(item.existing.paper_id); }));
                note.appendChild(preflightActionLink('续查', () => { void continuePaper(item.existing.paper_id); }));
            }
            body.appendChild(note);
        }
        if (item._queued) {
            body.appendChild(el('div', { className: 'note', text: '已加入解析队列，可在下方任务队列查看进度。' }));
        }
        row.appendChild(body);
        list.appendChild(row);
    }
}

async function runPreflight() {
    if (!state.import.paths.length) {
        state.import.items = [];
        state.import.data = null;
        state.import.checked.clear();
        renderPreflightSummary();
        renderImportList();
        renderImportSelection();
        return;
    }
    const seq = ++state.import.seq;
    state.import.busy = true;
    state.import.items = [];
    state.import.data = null;
    state.import.checked.clear();
    renderPreflightBusy();
    renderImportList();
    renderImportSelection();
    try {
        const result = await call(api.mineruPreflight({
            paths: state.import.paths,
            recursive: $('opt-recursive')?.checked !== false,
        }));
        if (seq !== state.import.seq) return;
        state.import.data = result?.data || null;
        state.import.items = Array.isArray(result?.data?.items) ? result.data.items : [];
        for (const item of state.import.items) {
            if (importItemEligible(item)) state.import.checked.add(item.path);
        }
    } catch (error) {
        if (seq !== state.import.seq) return;
        const box = $('preflight-summary');
        box.hidden = false;
        clearNode(box);
        box.appendChild(el('div', { className: 'warn-line', text: `查重失败：${error.message}` }));
        const settings = el('button', { className: 'btn small', text: '打开设置', attrs: { type: 'button' } });
        settings.addEventListener('click', openSettings);
        box.appendChild(settings);
    } finally {
        if (seq === state.import.seq) {
            state.import.busy = false;
            renderPreflightSummary();
            renderImportList();
            renderImportSelection();
        }
    }
}

function clearImport() {
    state.import.seq += 1;
    state.import.paths = [];
    state.import.items = [];
    state.import.data = null;
    state.import.checked.clear();
    state.import.busy = false;
    renderPreflightSummary();
    renderImportList();
    renderImportSelection();
}

async function startParse() {
    const items = selectedImportItems();
    if (!items.length) {
        toast('请先勾选要解析的新文件。', 'error');
        return;
    }
    if (state.status && !state.status.tokenConfigured) {
        toast('未在 MinerUParser/config.env 中检测到 MINERU_TOKEN，解析可能失败。', 'error');
    }
    try {
        const created = await call(api.mineruParse({
            items: items.map(item => ({
                path: item.path,
                paperId: item.paper_id,
                title: item.existing?.title || item.file_name,
            })),
            options: readParseOptions(),
        }));
        const paths = new Set(items.map(item => item.path));
        for (const item of state.import.items) {
            if (paths.has(item.path)) item._queued = true;
        }
        state.import.checked.clear();
        mergeJobs(created);
        renderImportList();
        renderImportSelection();
        toast(`已加入解析队列：${created.length} 个文件`, 'success');
    } catch (error) {
        toast(error.message, 'error');
    }
}

// ---------------- 任务队列 ----------------

function mergeJobs(created) {
    for (const job of Array.isArray(created) ? created : []) upsertJob(job, { notify: false });
}

function jobPercent(job) {
    if (job.state === 'done') return 100;
    const total = Number(job.progress?.total) || 0;
    const extracted = Number(job.progress?.extracted) || 0;
    if (total > 0) return Math.min(100, Math.max(2, Math.round((extracted / total) * 100)));
    if (['starting', 'running'].includes(job.state)) return 12;
    return 0;
}

function jobTitle(job) {
    return job.title || job.paperId || baseName(job.path) || '未命名任务';
}

function renderJobs() {
    const list = $('job-list');
    if (!list) return;
    clearNode(list);
    const active = state.jobs.filter(job => ['queued', 'starting', 'running'].includes(job.state)).length;
    const done = state.jobs.filter(job => job.state === 'done').length;
    const summary = $('job-summary');
    if (summary) {
        summary.textContent = state.jobs.length
            ? `${active} 进行中 · ${done} 完成`
            : '无任务';
    }
    const jobs = state.jobs.slice(0, 24);
    if (!jobs.length) {
        list.appendChild(el('li', { className: 'empty-list', text: '暂无解析任务' }));
        return;
    }
    for (const job of jobs) {
        const item = el('li', {
            className: `job-item ${job.state}`,
            attrs: { 'data-job-id': job.id },
        });
        const row = el('div', { className: 'row' });
        const title = el('span', { className: 'title', text: jobTitle(job), attrs: { title: job.path || job.paperId || '' } });
        row.appendChild(title);
        const right = el('span', { attrs: { style: 'display:inline-flex;align-items:center;gap:4px' } });
        right.appendChild(statusBadge(
            job.state === 'done' ? 'indexed'
                : job.state === 'failed' ? 'failed'
                    : job.state === 'timeout' ? 'timeout'
                        : job.state === 'cancelled' ? 'unknown'
                            : 'running',
            JOB_LABEL[job.state] || job.state,
        ));
        if (['queued', 'starting', 'running'].includes(job.state)) {
            const cancel = el('button', { className: 'job-cancel', text: '停止', attrs: { type: 'button', title: '停止本地等待' } });
            cancel.addEventListener('click', event => {
                event.stopPropagation();
                void cancelJob(job.id);
            });
            right.appendChild(cancel);
        }
        row.appendChild(right);
        const msg = el('div', { className: 'msg', text: job.error || job.message || '' });
        const progress = el('div', { className: 'progress' });
        const fill = el('span');
        fill.style.width = `${jobPercent(job)}%`;
        progress.appendChild(fill);
        item.append(row, msg, progress);
        if (job.paperId) {
            item.addEventListener('click', () => { void selectPaper(job.paperId); });
        }
        list.appendChild(item);
    }
}

function upsertJob(job, { notify = false } = {}) {
    if (!job?.id) return;
    const index = state.jobs.findIndex(item => item.id === job.id);
    const previous = index >= 0 ? state.jobs[index] : null;
    if (index >= 0) state.jobs[index] = { ...state.jobs[index], ...job };
    else state.jobs.unshift(job);
    state.jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (state.jobs.length > MAX_JOB_ROWS) state.jobs.length = MAX_JOB_ROWS;
    renderJobs();

    const terminal = ['done', 'timeout', 'failed', 'cancelled'].includes(job.state);
    if (notify && terminal && previous?.state !== job.state) {
        const key = `${job.id}:${job.state}`;
        if (!notifyKeys.has(key)) {
            notifyKeys.add(key);
            if (job.state === 'done') toast(`解析完成：${jobTitle(job)}`, 'success');
            else if (job.state === 'failed') toast(`解析失败：${jobTitle(job)}${job.error ? ` · ${job.error}` : ''}`, 'error');
            else if (job.state === 'timeout') toast(`等待超时：${jobTitle(job)}，可稍后续查`, 'info');
            else if (job.state === 'cancelled') toast(`已停止：${jobTitle(job)}`, 'info');
        }
    }
    if (notify && terminal) {
        for (const item of state.import.items) {
            if (job.paperId && item.paper_id === job.paperId) {
                item._queued = false;
                if (job.state === 'done') item.status = 'indexed';
                if (job.state === 'failed') item.status = 'failed';
                if (job.state === 'timeout') item.status = 'timeout';
            }
        }
        renderImportList();
        renderImportSelection();
        scheduleLibraryReload();
        if (state.currentId && job.paperId === state.currentId && job.state === 'done') {
            scheduleCurrentReload();
        }
    }
}

const scheduleLibraryReload = debounce(() => { void loadLibrary({ silent: true }); }, 420);
const scheduleCurrentReload = debounce(() => {
    if (state.currentId) void selectPaper(state.currentId, { reload: true });
}, 620);

async function cancelJob(jobId) {
    try {
        const job = await call(api.mineruCancelJob(jobId));
        upsertJob(job, { notify: true });
    } catch (error) {
        toast(error.message, 'error');
    }
}

async function loadJobs() {
    try {
        const jobs = await call(api.mineruListJobs());
        state.jobs = (Array.isArray(jobs) ? jobs : [])
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .slice(0, MAX_JOB_ROWS);
        renderJobs();
    } catch {
        // 服务尚未就绪时静默
    }
}

// ---------------- 全库重复检索 ----------------

function renderDedupeSummary() {
    const box = $('dedupe-summary');
    if (!box) return;
    if (state.dedupe.error) {
        box.hidden = false;
        clearNode(box);
        box.appendChild(el('div', { className: 'warn-line', text: state.dedupe.error }));
        return;
    }
    const data = state.dedupe.data;
    if (!data) {
        box.hidden = true;
        return;
    }
    const counts = data.counts || {};
    box.hidden = false;
    clearNode(box);
    const line = el('div');
    line.append(
        document.createTextNode('扫描 '),
        el('b', { text: formatNum(counts.papers) }),
        document.createTextNode(' 篇：发现 '),
        el('b', { text: formatNum(counts.groups) }),
        document.createTextNode(' 组重复，涉及 '),
        el('b', { text: formatNum(counts.papers_involved) }),
        document.createTextNode(' 篇，可回收约 '),
        el('b', { text: formatBytes(counts.reclaim_bytes) }),
    );
    box.appendChild(line);
    const detail = el('div', { className: 'muted' });
    detail.textContent = `资产 ${counts.asset || 0} · 正文 ${counts.text || 0} · 标题 ${counts.title || 0} · 源文件 ${counts.source || 0}`;
    box.appendChild(detail);
    if (data.truncated) {
        box.appendChild(el('div', { className: 'warn-line', text: `仅显示前 ${data.groups?.length || 0} 组，可加关键词缩小范围。` }));
    }
}

function renderDedupeGroups() {
    const box = $('dedupe-groups');
    if (!box) return;
    clearNode(box);
    const groups = state.dedupe.data?.groups || [];
    if (!groups.length) {
        box.appendChild(el('div', {
            className: 'empty-list',
            text: state.dedupe.data ? '未发现重复项。' : '点击「扫描全库重复」开始只读检索。',
        }));
        return;
    }
    for (const group of groups) {
        const card = el('div', { className: 'dedupe-group' });
        const head = el('div', { className: 'dedupe-group-head' });
        const headText = el('div');
        headText.append(
            el('strong', { text: `${group.kind_label || group.kind} · ${group.label || ''}` }),
        );
        const badges = el('div', { className: 'muted', text: `${group.member_count} 份 · 可回收 ${group.reclaim_text || formatBytes(group.reclaim_bytes)}` });
        head.append(headText, badges);
        card.appendChild(head);
        const members = Array.isArray(group.members) ? group.members : [];
        for (const member of members.slice(0, MAX_DEDUPE_MEMBERS)) {
            const row = el('div', { className: 'dedupe-member' });
            const mark = el('span', {
                className: member.recommended ? 'recommend-mark' : 'muted',
                text: member.recommended ? '建议保留' : '可清理',
            });
            const body = el('div', { className: 'body' });
            body.appendChild(el('div', { className: 'name', text: member.title || member.paper_id }));
            const meta = el('div', { className: 'meta' });
            meta.textContent = [
                member.paper_id,
                `${formatNum(member.pages)} 页`,
                member.asset_dir,
                `zip ${formatBytes(member.source_zip_bytes)}`,
            ].filter(Boolean).join(' · ');
            body.appendChild(meta);
            const actions = el('div');
            if (state.paperMap.has(member.paper_id)) {
                actions.appendChild(preflightActionLink('查看', () => { void selectPaper(member.paper_id); }));
            }
            actions.appendChild(preflightActionLink('定位', () => {
                void call(api.mineruRevealAsset(member.paper_id, member.asset_dir))
                    .catch(error => toast(error.message, 'error'));
            }));
            body.appendChild(actions);
            row.append(mark, body);
            card.appendChild(row);
        }
        if (members.length > MAX_DEDUPE_MEMBERS) {
            card.appendChild(el('div', {
                className: 'muted',
                text: `仅显示前 ${MAX_DEDUPE_MEMBERS} 份，共 ${members.length} 份。`,
            }));
        }
        box.appendChild(card);
    }
}

async function runDedupe() {
    if (state.dedupe.busy) return;
    state.dedupe.busy = true;
    state.dedupe.error = '';
    const button = $('dedupe-scan-btn');
    if (button) {
        button.disabled = true;
        button.textContent = '扫描中...';
    }
    try {
        const result = await call(api.mineruDuplicates({
            groupBy: $('dedupe-group-by')?.value || 'all',
            query: ($('dedupe-query')?.value || '').trim(),
            limit: 200,
        }));
        state.dedupe.data = result?.data || null;
    } catch (error) {
        state.dedupe.data = null;
        state.dedupe.error = `扫描失败：${error.message}`;
        toast(state.dedupe.error, 'error');
    } finally {
        state.dedupe.busy = false;
        if (button) {
            button.disabled = false;
            button.textContent = '扫描全库重复';
        }
        renderDedupeSummary();
        renderDedupeGroups();
    }
}

// ---------------- 设置 ----------------

function fillSettings() {
    const status = state.status;
    const config = status?.config || {};
    if ($('set-toolbox-root')) $('set-toolbox-root').value = status?.toolboxRoot || '';
    if ($('set-model')) $('set-model').value = config.modelVersion === 'pipeline' ? 'pipeline' : 'vlm';
    if ($('set-language')) $('set-language').value = config.language || 'en';
    if ($('set-workers')) $('set-workers').value = String(Math.min(5, Math.max(1, Number(config.workers) || 3)));
    if ($('set-ocr')) $('set-ocr').checked = Boolean(config.isOcr);
    if ($('set-formula')) $('set-formula').checked = config.enableFormula !== false;
    if ($('set-table')) $('set-table').checked = config.enableTable !== false;
    if ($('set-recursive')) $('set-recursive').checked = config.recursive !== false;
    const statusBox = $('settings-status');
    if (statusBox) {
        statusBox.classList.toggle('error', Boolean(status && !status.ok));
        statusBox.textContent = status
            ? [
                status.ok ? '环境已就绪' : status.error,
                `VCPToolBox：${status.toolboxRoot || '-'}`,
                `二进制：${status.binary || '-'}`,
                `Token：${status.tokenConfigured ? '已配置' : '未配置（请在 Plugin/MinerUParser/config.env 填写）'}`,
            ].filter(Boolean).join('\n')
            : '尚未读取到环境状态。';
    }
}

function openSettings() {
    state.lastFocus = document.activeElement;
    fillSettings();
    $('settings-modal').hidden = false;
    state.settingsOpen = true;
    $('set-toolbox-pick')?.focus();
}

function closeSettings() {
    $('settings-modal').hidden = true;
    state.settingsOpen = false;
    state.lastFocus?.focus?.();
}

async function saveSettings() {
    const patch = {
        modelVersion: $('set-model')?.value === 'pipeline' ? 'pipeline' : 'vlm',
        language: ($('set-language')?.value || 'en').trim() || 'en',
        workers: Number($('set-workers')?.value) || 3,
        isOcr: Boolean($('set-ocr')?.checked),
        enableFormula: $('set-formula')?.checked !== false,
        enableTable: $('set-table')?.checked !== false,
        recursive: $('set-recursive')?.checked !== false,
    };
    try {
        const result = await call(api.mineruSaveConfig(patch));
        state.status = result.status || state.status;
        applyConfigToControls();
        renderStatusChip();
        closeSettings();
        toast('设置已保存', 'success');
        await loadLibrary({ silent: true });
    } catch (error) {
        const box = $('settings-status');
        if (box) {
            box.classList.add('error');
            box.textContent = error.message;
        }
    }
}

async function pickToolboxRoot() {
    try {
        const result = await call(api.mineruPickToolboxRoot());
        if (!result) return;
        state.status = result.status || state.status;
        fillSettings();
        applyConfigToControls();
        renderStatusChip();
        toast('已更新 VCPToolBox 路径', 'success');
        await loadLibrary({ silent: true });
    } catch (error) {
        toast(error.message, 'error');
    }
}

// ---------------- 阅读器交互 ----------------

function setView(mode, { persist = true } = {}) {
    const target = ['split', 'md', 'pdf'].includes(mode) ? mode : 'split';
    state.view = target;
    const body = $('reader-body');
    if (body) body.dataset.view = target;
    document.querySelectorAll('[data-view-mode]').forEach(button => {
        button.classList.toggle('active', button.dataset.viewMode === target);
    });
    if (persist) {
        try { localStorage.setItem(VIEW_KEY, target); } catch { /* ignore */ }
    }
}

function setOutline(open, { persist = true } = {}) {
    state.outline = Boolean(open);
    const body = $('reader-body');
    if (body) body.dataset.outline = state.outline ? 'visible' : 'hidden';
    const button = $('outline-toggle');
    if (button) {
        button.classList.toggle('active', state.outline);
        button.setAttribute('aria-pressed', String(state.outline));
    }
    if (persist) {
        try { localStorage.setItem(OUTLINE_KEY, state.outline ? '1' : '0'); } catch { /* ignore */ }
    }
}

function setWrap(enabled, { persist = true } = {}) {
    state.wrap = Boolean(enabled);
    const button = $('md-wrap-toggle');
    if (button) {
        button.classList.toggle('active', state.wrap);
        button.setAttribute('aria-pressed', String(state.wrap));
    }
    reader?.setWrap(state.wrap);
    if (persist) {
        try { localStorage.setItem(WRAP_KEY, state.wrap ? '1' : '0'); } catch { /* ignore */ }
    }
}

const runFind = debounce(() => {
    const query = ($('md-find-input')?.value || '').trim();
    reader?.setFind(query);
}, 280);

function bindEvents() {
    $('minimize-btn')?.addEventListener('click', () => { api.minimizeWindow?.(); });
    $('maximize-btn')?.addEventListener('click', () => { api.maximizeWindow?.(); });
    $('close-btn')?.addEventListener('click', () => { api.closeWindow?.(); });
    $('refresh-btn')?.addEventListener('click', () => {
        void loadLibrary();
        void loadJobs();
        if (state.currentId) void selectPaper(state.currentId, { reload: true });
    });
    $('settings-btn')?.addEventListener('click', openSettings);
    $('status-chip')?.addEventListener('click', openSettings);
    $('empty-import-btn')?.addEventListener('click', () => setTab('import'));

    document.querySelectorAll('.side-tab').forEach(tab => {
        tab.addEventListener('click', () => setTab(tab.dataset.sideTab));
        tab.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            const tabs = [...document.querySelectorAll('.side-tab')];
            const index = tabs.indexOf(tab);
            const next = event.key === 'ArrowRight'
                ? (index + 1) % tabs.length
                : (index - 1 + tabs.length) % tabs.length;
            event.preventDefault();
            tabs[next].focus();
            setTab(tabs[next].dataset.sideTab);
        });
    });

    $('library-search')?.addEventListener('input', renderPaperList);
    $('library-status')?.addEventListener('change', renderPaperList);

    $('pick-pdfs-btn')?.addEventListener('click', async () => {
        try {
            const files = await call(api.mineruPickPdfs());
            if (files?.length) addPaths(files);
        } catch (error) {
            toast(error.message, 'error');
        }
    });
    $('pick-folder-btn')?.addEventListener('click', async () => {
        try {
            const folder = await call(api.mineruPickFolder());
            if (folder) addPaths([folder]);
        } catch (error) {
            toast(error.message, 'error');
        }
    });
    $('preflight-btn')?.addEventListener('click', () => { void runPreflight(); });
    $('clear-import-btn')?.addEventListener('click', clearImport);
    $('parse-btn')?.addEventListener('click', () => { void startParse(); });
    $('opt-recursive')?.addEventListener('change', () => {
        persistParseDefaults();
        if (state.import.paths.length) void runPreflight();
    });
    for (const id of ['opt-model', 'opt-workers', 'opt-language', 'opt-ocr', 'opt-formula', 'opt-table']) {
        $(id)?.addEventListener('change', persistParseDefaults);
    }

    $('dedupe-scan-btn')?.addEventListener('click', () => { void runDedupe(); });
    $('dedupe-query')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') void runDedupe();
    });

    document.querySelectorAll('[data-view-mode]').forEach(button => {
        button.addEventListener('click', () => setView(button.dataset.viewMode));
    });
    $('outline-toggle')?.addEventListener('click', () => setOutline(!state.outline));
    $('md-wrap-toggle')?.addEventListener('click', () => setWrap(!state.wrap));
    $('md-find-input')?.addEventListener('input', runFind);
    $('md-find-input')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            if (event.shiftKey) reader?.findPrev();
            else reader?.findNext();
        }
    });
    $('md-find-next')?.addEventListener('click', () => reader?.findNext());
    $('md-find-prev')?.addEventListener('click', () => reader?.findPrev());

    $('pdf-prev')?.addEventListener('click', () => reader?.prevPage());
    $('pdf-next')?.addEventListener('click', () => reader?.nextPage());
    $('pdf-page-input')?.addEventListener('change', () => {
        const page = Number($('pdf-page-input')?.value) || 1;
        void reader?.goToPage(page);
    });
    $('pdf-page-input')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            const page = Number($('pdf-page-input')?.value) || 1;
            void reader?.goToPage(page);
            $('pdf-page-input')?.blur();
        }
    });
    $('pdf-zoom-in')?.addEventListener('click', () => reader?.zoomIn());
    $('pdf-zoom-out')?.addEventListener('click', () => reader?.zoomOut());
    $('pdf-fit')?.addEventListener('click', () => reader?.fitWidth());

    $('settings-save-btn')?.addEventListener('click', () => { void saveSettings(); });
    $('set-toolbox-pick')?.addEventListener('click', () => { void pickToolboxRoot(); });
    document.querySelectorAll('[data-close-settings]').forEach(button => {
        button.addEventListener('click', closeSettings);
    });

    $('confirm-cancel')?.addEventListener('click', () => finishConfirm(false));
    $('confirm-ok')?.addEventListener('click', () => finishConfirm(true));
    $('confirm-modal')?.addEventListener('click', event => {
        if (event.target === $('confirm-modal')) finishConfirm(false);
    });
    $('settings-modal')?.addEventListener('click', event => {
        if (event.target === $('settings-modal')) closeSettings();
    });

    $('lightbox-close')?.addEventListener('click', closeLightbox);
    $('lightbox')?.addEventListener('click', event => {
        if (event.target === $('lightbox')) closeLightbox();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            if (!$('lightbox')?.hidden) {
                closeLightbox();
                return;
            }
            if (typeof confirmResolve === 'function') {
                finishConfirm(false);
                return;
            }
            if (state.settingsOpen) {
                closeSettings();
                return;
            }
            const findInput = $('md-find-input');
            if (document.activeElement === findInput && findInput.value) {
                findInput.value = '';
                reader?.setFind('');
            }
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
            if (!$('paper-view')?.hidden) {
                event.preventDefault();
                $('md-find-input')?.focus();
                $('md-find-input')?.select();
            }
            return;
        }
        const target = event.target;
        if (target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
        if ($('paper-view')?.hidden) return;
        if (event.key === 'PageDown') {
            event.preventDefault();
            reader?.nextPage();
        } else if (event.key === 'PageUp') {
            event.preventDefault();
            reader?.prevPage();
        }
    });
}

async function initTheme() {
    try {
        const settings = await api.loadSettings?.();
        if (settings?.currentThemeMode) applyTheme(settings.currentThemeMode);
        api.onThemeUpdated?.(applyTheme);
    } catch {
        // 主题读取失败不影响工作台
    }
}

async function init() {
    if (!api?.mineruStatus) {
        const empty = $('empty-state');
        if (empty) {
            empty.hidden = false;
            empty.querySelector('p').textContent = '当前窗口没有 MinerU API，请从 VChat 应用托盘打开「论文」。';
        }
        return;
    }
    reader = createMinerUReader({
        api,
        elements: {
            mdContent: $('md-content'),
            mdScroll: $('md-scroll'),
            mdPlaceholder: $('md-placeholder'),
            mdSourceLabel: $('md-source-label'),
            pdfCanvas: $('pdf-canvas'),
            pdfScroll: $('pdf-scroll'),
            pdfPlaceholder: $('pdf-placeholder'),
            pdfPageInput: $('pdf-page-input'),
            pdfPageTotal: $('pdf-page-total'),
            pdfZoomLabel: $('pdf-zoom-label'),
            pdfFit: $('pdf-fit'),
            outlineList: $('outline-list'),
            qualityBox: $('quality-box'),
            mdFindInput: $('md-find-input'),
            mdFindCount: $('md-find-count'),
        },
        toast,
        imageUrlOf: mineruImageUrl,
        onOpenLink: url => { void call(api.mineruOpenExternal(url)).catch(error => toast(error.message, 'error')); },
        onPdfUnavailable: () => { if (state.currentId) void linkPdf(state.currentId); },
        onImageOpen: openLightbox,
    });

    bindEvents();
    await initTheme();
    setView(state.view, { persist: false });
    setOutline(state.outline, { persist: false });
    setWrap(state.wrap, { persist: false });
    const savedTab = localStorage.getItem(TAB_KEY);
    setTab(['library', 'import', 'dedupe'].includes(savedTab) ? savedTab : 'library', { persist: false });

    try {
        state.status = await call(api.mineruStatus());
        applyConfigToControls();
        renderStatusChip();
        if (!state.status?.ok) {
            toast(state.status?.error || 'MinerU 环境未就绪，请打开设置。', 'error');
        }
    } catch (error) {
        toast(`检查 MinerU 环境失败：${error.message}`, 'error');
    }

    await loadJobs();
    await loadLibrary({ silent: true });
    renderImportList();
    renderImportSelection();
    renderPreflightSummary();
    renderDedupeSummary();
    renderDedupeGroups();

    api.onMineruJob?.(job => upsertJob(job, { notify: true }));
    api.onMineruLibraryChanged?.(() => scheduleLibraryReload());
    api.windowReady?.('mineru-workbench');
    window.addEventListener('beforeunload', () => reader?.destroy());
}

document.addEventListener('DOMContentLoaded', () => { void init(); });
