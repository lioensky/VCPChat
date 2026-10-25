const api = window.utilityAPI || window.electronAPI;

const STORAGE_KEYS = {
    lineLimit: 'vcp-log-center-line-limit',
    reverseOrder: 'vcp-log-center-reverse-order'
};

const PRESET_FILTERS = ['IP', 'TOOL', 'RAG', 'POST', 'PLUGIN', 'ERROR'];
const POLL_INTERVAL_MS = 1800;

let serverBaseUrl = '';
let apiAuthHeader = '';
let allLines = [];
let currentOffset = 0;
let baseEmptyMessage = '暂无日志内容';
let currentLogPath = '';
let isReverseOrder = false;
let lineLimit = 500;
let pollTimer = null;
let isLoading = false;
// '' is "all logs", a preset name selects that sidebar item, null is free text typed into the filter.
let activePreset = '';
let currentFilter = '';
// The file part of the summary line, e.g. "文件 5.9 KB"; empty until the first read.
let fileSizeText = '';
let visibleLineCount = 0;

const elements = {
    status: document.getElementById('log-status'),
    path: document.getElementById('log-path'),
    meta: document.getElementById('log-meta'),
    lines: document.getElementById('log-lines'),
    empty: document.getElementById('empty-state'),
    toast: document.getElementById('toast'),
    confirmModal: document.getElementById('confirm-modal'),
    confirmMessage: document.getElementById('confirm-message'),
    confirmOkBtn: document.getElementById('confirm-ok-btn'),
    confirmCancelBtn: document.getElementById('confirm-cancel-btn'),
    refreshBtn: document.getElementById('refresh-log-btn'),
    clearBtn: document.getElementById('clear-log-btn'),
    orderToggle: document.getElementById('order-toggle-btn'),
    copyBtn: document.getElementById('copy-visible-btn'),
    settingsBtn: document.getElementById('log-settings-btn'),
    settingsPopover: document.getElementById('log-settings-popover'),
    pageTitle: document.getElementById('log-page-title'),
    lineLimitInput: document.getElementById('line-limit-input'),
    filterInput: document.getElementById('log-filter-input'),
    scrollTopBtn: document.getElementById('scroll-top-btn'),
    scrollBottomBtn: document.getElementById('scroll-bottom-btn')
};

document.addEventListener('DOMContentLoaded', async () => {
    setupWindowControls();
    setupTheme();
    setupSettings();
    setupEvents();

    await initAuthAndServer();
    if (serverBaseUrl && apiAuthHeader) {
        await fetchLog({ incremental: false, silent: false });
        startPolling();
    }
});

window.addEventListener('beforeunload', () => {
    if (pollTimer) clearInterval(pollTimer);
});

function setupWindowControls() {
    document.getElementById('minimize-log-btn')?.addEventListener('click', () => api?.minimizeWindow?.());
    document.getElementById('maximize-log-btn')?.addEventListener('click', () => api?.maximizeWindow?.());
    document.getElementById('close-log-btn')?.addEventListener('click', () => {
        if (api?.closeWindow) {
            api.closeWindow();
            return;
        }
        window.close();
    });
}

async function setupTheme() {
    try {
        if (api?.getCurrentTheme) {
            const theme = await api.getCurrentTheme();
            document.body.classList.toggle('light-theme', theme === 'light');
        } else {
            const settings = await api?.loadSettings?.();
            if (settings?.currentThemeMode) {
                document.body.classList.toggle('light-theme', settings.currentThemeMode === 'light');
            }
        }
        api?.onThemeUpdated?.((theme) => {
            document.body.classList.toggle('light-theme', theme === 'light');
        });
    } catch (error) {
        console.warn('[LogCenter] Theme setup failed:', error);
    }
}

function setupSettings() {
    const savedLimit = parseInt(localStorage.getItem(STORAGE_KEYS.lineLimit) || '500', 10);
    lineLimit = normalizeLineLimit(savedLimit);
    elements.lineLimitInput.value = String(lineLimit);

    isReverseOrder = localStorage.getItem(STORAGE_KEYS.reverseOrder) === 'true';
    updateOrderButton();
    updatePresetButtons();
}

function setupEvents() {
    elements.refreshBtn?.addEventListener('click', async () => {
        await fetchLog({ incremental: false, silent: false });
    });

    elements.clearBtn?.addEventListener('click', openClearConfirmModal);

    elements.orderToggle?.addEventListener('click', () => {
        isReverseOrder = !isReverseOrder;
        localStorage.setItem(STORAGE_KEYS.reverseOrder, String(isReverseOrder));
        updateOrderButton();
        render();
    });

    elements.copyBtn?.addEventListener('click', copyVisibleLogs);

    elements.settingsBtn?.addEventListener('click', () => {
        setSettingsOpen(elements.settingsPopover.hidden);
    });

    document.addEventListener('pointerdown', (event) => {
        if (elements.settingsPopover.hidden) return;
        if (event.target.closest('.settings-anchor')) return;
        setSettingsOpen(false);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || elements.settingsPopover.hidden) return;
        setSettingsOpen(false);
        elements.settingsBtn.focus();
    });

    elements.lineLimitInput?.addEventListener('change', () => {
        lineLimit = normalizeLineLimit(parseInt(elements.lineLimitInput.value || '500', 10));
        elements.lineLimitInput.value = String(lineLimit);
        localStorage.setItem(STORAGE_KEYS.lineLimit, String(lineLimit));
        trimLines();
        render();
    });

    elements.filterInput?.addEventListener('input', debounce(() => {
        currentFilter = elements.filterInput.value.trim();
        activePreset = currentFilter === '' || PRESET_FILTERS.includes(currentFilter) ? currentFilter : null;
        updatePresetButtons();
        render();
    }, 120));

    document.querySelectorAll('.preset-chip').forEach((button) => {
        button.addEventListener('click', () => {
            activePreset = button.dataset.filter || '';
            if (activePreset) {
                elements.filterInput.value = activePreset;
                currentFilter = activePreset;
            } else {
                elements.filterInput.value = '';
                currentFilter = '';
            }
            updatePresetButtons();
            render();
        });
    });

    elements.scrollTopBtn?.addEventListener('click', () => {
        elements.lines.scrollTo({ top: 0, behavior: 'smooth' });
    });

    elements.scrollBottomBtn?.addEventListener('click', () => {
        elements.lines.scrollTo({ top: elements.lines.scrollHeight, behavior: 'smooth' });
    });
}

async function initAuthAndServer() {
    setStatus('正在读取 VCP 设置...');
    try {
        const settings = await api?.loadSettings?.();
        if (!settings?.vcpServerUrl) {
            setStatus('未配置服务器', 'error');
            setEmptyMessage('未配置 VCP 服务器地址：请在全局设置中配置后点击刷新');
            showToast('请先在全局设置中配置 VCP 服务器地址');
            return;
        }

        serverBaseUrl = settings.vcpServerUrl.replace(/\/v1\/chat\/completions\/?$/, '');
        if (!serverBaseUrl.endsWith('/')) serverBaseUrl += '/';

        const forumConfig = await api?.loadForumConfig?.();
        if (!forumConfig?.username || !forumConfig?.password) {
            setStatus('未登录论坛', 'error');
            setEmptyMessage('未找到论坛登录凭据：请先在「论坛」应用中登录后点击刷新');
            showToast('请先在「论坛」应用中登录，日志中心使用同一凭据');
            return;
        }

        apiAuthHeader = `Basic ${btoa(`${forumConfig.username}:${forumConfig.password}`)}`;
        setStatus('正在连接服务器...');
    } catch (error) {
        console.error('[LogCenter] Init failed:', error);
        setStatus('初始化失败', 'error');
        setEmptyMessage(`初始化失败：${error.message}`);
        showToast(`初始化失败: ${error.message}`);
    }
}

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
        fetchLog({ incremental: true, silent: true }).catch((error) => {
            console.warn('[LogCenter] Poll failed:', error);
        });
    }, POLL_INTERVAL_MS);
}

async function fetchLog({ incremental, silent }) {
    if (!serverBaseUrl || !apiAuthHeader || isLoading) return;
    isLoading = true;
    elements.refreshBtn?.classList.add('spinning');

    try {
        if (!silent) setStatus(incremental ? '正在增量刷新...' : '正在读取日志...');

        const endpoint = new URL(`${serverBaseUrl}admin_api/server-log`);
        if (incremental) {
            endpoint.searchParams.set('incremental', 'true');
            endpoint.searchParams.set('offset', String(currentOffset || 0));
        }

        const response = await fetch(endpoint.toString(), {
            method: 'GET',
            headers: {
                Authorization: apiAuthHeader,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || data.details || `HTTP ${response.status}`);
        }

        if (data.needFullReload) {
            currentOffset = 0;
            await fetchLog({ incremental: false, silent: true });
            return;
        }

        currentOffset = Number(data.offset || 0);
        currentLogPath = data.path || currentLogPath;

        if (!incremental) {
            allLines = splitLogLines(data.content || '');
        } else if (data.content) {
            allLines.push(...splitLogLines(data.content));
        }

        fileSizeText = `文件 ${data.fileSize ? formatBytes(data.fileSize) : '--'}`;
        trimLines();
        baseEmptyMessage = '暂无日志内容';
        setStatus('');
        setLogPath(currentLogPath);
        render();
    } catch (error) {
        console.error('[LogCenter] Fetch log failed:', error);
        setStatus(`读取失败: ${error.message}`, 'error');
        if (!silent) {
            if (allLines.length === 0) setEmptyMessage(`读取日志失败：${error.message}`);
            showToast(`读取日志失败: ${error.message}`);
        }
    } finally {
        isLoading = false;
        elements.refreshBtn?.classList.remove('spinning');
    }
}

function openClearConfirmModal() {
    if (!elements.confirmModal) {
        clearServerLog();
        return;
    }

    elements.confirmMessage.textContent = '确定要清空后端服务器日志吗？此操作不可撤销。';
    elements.confirmModal.classList.add('active');
    elements.confirmModal.setAttribute('aria-hidden', 'false');
}

function closeClearConfirmModal() {
    if (!elements.confirmModal) return;
    elements.confirmModal.classList.remove('active');
    elements.confirmModal.setAttribute('aria-hidden', 'true');
}

async function clearServerLog() {
    if (!serverBaseUrl || !apiAuthHeader) return;

    try {
        setStatus('正在清空日志...');
        const response = await fetch(`${serverBaseUrl}admin_api/server-log/clear`, {
            method: 'POST',
            headers: {
                Authorization: apiAuthHeader,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || data.details || `HTTP ${response.status}`);
        }

        allLines = [];
        currentOffset = 0;
        fileSizeText = '文件已清空';
        setStatus('');
        render();
        showToast(data.message || '日志已清空');
    } catch (error) {
        console.error('[LogCenter] Clear failed:', error);
        setStatus(`清空失败: ${error.message}`, 'error');
        showToast(`清空失败: ${error.message}`);
    } finally {
        closeClearConfirmModal();
    }
}

function render() {
    const shouldStickBottom = isNearBottom();
    const visibleLines = getVisibleLines();
    const fragment = document.createDocumentFragment();

    visibleLines.forEach((line) => {
        const row = document.createElement('div');
        row.className = 'log-row';

        const content = document.createElement('div');
        content.className = 'log-content';
        content.innerHTML = decorateLogLine(line);

        row.appendChild(content);
        fragment.appendChild(row);
    });

    elements.lines.innerHTML = '';
    elements.lines.appendChild(fragment);
    if (visibleLines.length === 0) {
        elements.empty.textContent = allLines.length > 0 ? '没有匹配的日志行' : baseEmptyMessage;
    }
    elements.empty.classList.toggle('active', visibleLines.length === 0);
    visibleLineCount = visibleLines.length;
    renderCounts();
    renderMeta();

    if (!isReverseOrder && shouldStickBottom) {
        requestAnimationFrame(() => {
            elements.lines.scrollTop = elements.lines.scrollHeight;
        });
    }
}

function getVisibleLines() {
    const filter = currentFilter.toLowerCase();
    let lines = allLines;

    if (filter) {
        lines = lines.filter((line) => line.toLowerCase().includes(filter));
    }

    if (isReverseOrder) {
        lines = [...lines].reverse();
    }

    return lines;
}

function decorateLogLine(line) {
    const escaped = escapeHtml(line);
    const levelMatch = escaped.match(/\[(LOG|INFO|WARN|WARNING|ERROR|FATAL|DEBUG)\]/i);
    let result = escaped;

    if (levelMatch) {
        const level = levelMatch[1].toLowerCase();
        result = result.replace(levelMatch[0], `<span class="log-level level-${level}">${levelMatch[0]}</span>`);
    }

    if (currentFilter) {
        result = highlightTerm(result, currentFilter);
    }

    return result;
}

// Highlights only the text between tags, so a term such as "error" or "class"
// never rewrites the level span's markup. Each text part is matched in its
// decoded form, so a term cannot split an entity like "&amp;" either.
function highlightTerm(html, term) {
    if (!term) return html;
    const pattern = new RegExp(`(${escapeRegExp(term)})`, 'i');
    return html.split(/(<[^>]*>)/).map((part) => {
        if (part.startsWith('<')) return part;
        return unescapeHtml(part).split(pattern).map((piece, index) => (
            index % 2 ? `<span class="keyword-hit">${escapeHtml(piece)}</span>` : escapeHtml(piece)
        )).join('');
    }).join('');
}

function splitLogLines(content) {
    return content
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .filter((line, index, arr) => line.length > 0 || index < arr.length - 1);
}

function trimLines() {
    if (allLines.length > lineLimit) {
        allLines = allLines.slice(allLines.length - lineLimit);
    }
}

async function copyVisibleLogs() {
    const text = getVisibleLines().join('\n');
    if (!text) {
        showToast('没有可复制的可见日志');
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        showToast(`已复制 ${getVisibleLines().length} 行可见日志`);
    } catch (error) {
        console.error('[LogCenter] Clipboard failed:', error);
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
        showToast('已复制可见日志');
    } catch (error) {
        showToast(`复制失败: ${error.message}`);
    } finally {
        textarea.remove();
    }
}

function updateOrderButton() {
    if (!elements.orderToggle) return;
    elements.orderToggle.setAttribute('aria-pressed', String(isReverseOrder));
    elements.orderToggle.title = isReverseOrder ? '最新的行在上（再点一次改回最早在上）' : '最新的行在上';
}

function setSettingsOpen(open) {
    elements.settingsPopover.hidden = !open;
    elements.settingsBtn.setAttribute('aria-expanded', String(open));
    if (open) elements.lineLimitInput.focus();
}

function updatePresetButtons() {
    document.querySelectorAll('.preset-chip').forEach((button) => {
        const selected = (button.dataset.filter || '') === activePreset;
        button.classList.toggle('active', selected);
        if (selected) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    });
    if (elements.pageTitle) {
        elements.pageTitle.textContent = activePreset === '' ? '全部日志' : (activePreset ? `${activePreset} 日志` : '筛选结果');
    }
}

// Sidebar counts are lines matching each preset among the retained lines.
function renderCounts() {
    const lowered = allLines.map((line) => line.toLowerCase());
    document.querySelectorAll('[data-count-for]').forEach((count) => {
        const term = count.dataset.countFor.toLowerCase();
        count.textContent = String(term ? lowered.filter((line) => line.includes(term)).length : lowered.length);
    });
}

// The counters and the display order, as one "·"-separated run after the path.
function renderMeta() {
    if (!fileSizeText) {
        elements.meta.textContent = '';
        return;
    }
    const lineText = visibleLineCount === allLines.length
        ? `${allLines.length} 行`
        : `${visibleLineCount} / ${allLines.length} 行`;
    const parts = [lineText, `偏移 ${currentOffset}`, fileSizeText];
    if (isReverseOrder) parts.push('最新在上');
    elements.meta.textContent = parts.join(' · ');
}

// The folder part can ellipsize on its own so the file name stays readable.
function setLogPath(fullPath) {
    elements.path.replaceChildren();
    elements.path.title = fullPath || '';
    if (!fullPath) return;
    const cut = Math.max(fullPath.lastIndexOf('\\'), fullPath.lastIndexOf('/')) + 1;
    const dir = document.createElement('span');
    dir.className = 'log-path-dir';
    dir.textContent = fullPath.slice(0, cut);
    const file = document.createElement('span');
    file.className = 'log-path-file';
    file.textContent = fullPath.slice(cut);
    elements.path.append(dir, file);
}

function setStatus(message, tone = '') {
    elements.status.textContent = message;
    elements.status.dataset.tone = tone;
}

function setEmptyMessage(message) {
    baseEmptyMessage = message;
    if (elements.empty) {
        elements.empty.textContent = message;
        elements.empty.classList.add('active');
    }
}

function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add('active');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
        elements.toast.classList.remove('active');
    }, 2200);
}

elements.confirmOkBtn?.addEventListener('click', clearServerLog);
elements.confirmCancelBtn?.addEventListener('click', closeClearConfirmModal);
elements.confirmModal?.addEventListener('click', (event) => {
    if (event.target === elements.confirmModal) {
        closeClearConfirmModal();
    }
});

function isNearBottom() {
    return elements.lines.scrollHeight - elements.lines.scrollTop - elements.lines.clientHeight < 80;
}

function normalizeLineLimit(value) {
    if (!Number.isFinite(value)) return 500;
    return Math.min(20000, Math.max(50, value));
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function unescapeHtml(value) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&');
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
}