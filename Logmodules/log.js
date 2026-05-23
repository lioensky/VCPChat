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
let currentLogPath = '';
let isReverseOrder = false;
let lineLimit = 500;
let pollTimer = null;
let isLoading = false;
let activePreset = '';
let currentFilter = '';
let scrollHideTimer = null;
let suppressScrollReveal = false;

const elements = {
    status: document.getElementById('log-status'),
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
    orderBtn: document.getElementById('order-toggle-btn'),
    copyBtn: document.getElementById('copy-visible-btn'),
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

    elements.orderBtn?.addEventListener('click', () => {
        isReverseOrder = !isReverseOrder;
        localStorage.setItem(STORAGE_KEYS.reverseOrder, String(isReverseOrder));
        updateOrderButton();
        render();
    });

    elements.copyBtn?.addEventListener('click', copyVisibleLogs);

    elements.lineLimitInput?.addEventListener('change', () => {
        lineLimit = normalizeLineLimit(parseInt(elements.lineLimitInput.value || '500', 10));
        elements.lineLimitInput.value = String(lineLimit);
        localStorage.setItem(STORAGE_KEYS.lineLimit, String(lineLimit));
        trimLines();
        render();
    });

    elements.filterInput?.addEventListener('input', debounce(() => {
        currentFilter = elements.filterInput.value.trim();
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
        revealFloatingActions();
        scheduleFloatingActionsHide();
        suppressScrollReveal = true;
        elements.lines.scrollTo({ top: 0, behavior: 'smooth' });
    });

    elements.scrollBottomBtn?.addEventListener('click', () => {
        revealFloatingActions();
        scheduleFloatingActionsHide();
        suppressScrollReveal = true;
        elements.lines.scrollTo({ top: elements.lines.scrollHeight, behavior: 'smooth' });
    });

    elements.lines?.addEventListener('scroll', () => {
        if (suppressScrollReveal) {
            suppressScrollReveal = false;
            return;
        }
        revealFloatingActions();
        scheduleFloatingActionsHide();
    }, { passive: true });

    hideFloatingActions();
}

async function initAuthAndServer() {
    setStatus('正在读取 VCP 设置...');
    try {
        const settings = await api?.loadSettings?.();
        if (!settings?.vcpServerUrl) {
            setStatus('未配置 VCP 服务器 URL');
            showToast('请先在主设置中配置 VCP 服务器 URL');
            return;
        }

        serverBaseUrl = settings.vcpServerUrl.replace(/\/v1\/chat\/completions\/?$/, '');
        if (!serverBaseUrl.endsWith('/')) serverBaseUrl += '/';

        const forumConfig = await api?.loadForumConfig?.();
        if (!forumConfig?.username || !forumConfig?.password) {
            setStatus('缺少论坛管理员凭据');
            showToast('未找到论坛模块登录配置，请先在论坛模块登录并保存凭据');
            return;
        }

        apiAuthHeader = `Basic ${btoa(`${forumConfig.username}:${forumConfig.password}`)}`;
        setStatus('已连接配置，准备读取日志');
    } catch (error) {
        console.error('[LogCenter] Init failed:', error);
        setStatus(`初始化失败: ${error.message}`);
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

        trimLines();
        render();

        const sizeText = data.fileSize ? formatBytes(data.fileSize) : '--';
        setStatus(currentLogPath ? `监听: ${currentLogPath}` : '日志已载入');
        setMeta(`总行 ${allLines.length} · 偏移 ${currentOffset} · 文件 ${sizeText}`);
    } catch (error) {
        console.error('[LogCenter] Fetch log failed:', error);
        setStatus(`读取失败: ${error.message}`);
        if (!silent) showToast(`读取日志失败: ${error.message}`);
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
        render();
        setMeta('总行 0 · 偏移 0 · 文件已清空');
        setStatus('日志已清空');
        showToast(data.message || '日志已清空');
    } catch (error) {
        console.error('[LogCenter] Clear failed:', error);
        setStatus(`清空失败: ${error.message}`);
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
    elements.empty.classList.toggle('active', visibleLines.length === 0);

    if (!isReverseOrder && shouldStickBottom) {
        requestAnimationFrame(() => {
            suppressScrollReveal = true;
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

function highlightTerm(html, term) {
    const safeTerm = escapeRegExp(escapeHtml(term));
    if (!safeTerm) return html;
    return html.replace(new RegExp(safeTerm, 'ig'), (match) => `<span class="keyword-hit">${match}</span>`);
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
    elements.orderBtn.textContent = isReverseOrder ? '正序显示' : '倒序显示';
    elements.orderBtn.title = isReverseOrder ? '当前为倒序，点击切换为正序' : '当前为正序，点击切换为倒序';
}

function updatePresetButtons() {
    document.querySelectorAll('.preset-chip').forEach((button) => {
        button.classList.toggle('active', (button.dataset.filter || '') === activePreset);
    });
}

function setStatus(message) {
    elements.status.textContent = message;
}

function setMeta(message) {
    elements.meta.textContent = message;
}

function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add('active');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
        elements.toast.classList.remove('active');
    }, 2200);
}

function revealFloatingActions() {
    elements.scrollTopBtn?.closest('.floating-actions')?.classList.add('visible');
}

function hideFloatingActions() {
    elements.scrollTopBtn?.closest('.floating-actions')?.classList.remove('visible');
}

function scheduleFloatingActionsHide() {
    clearTimeout(scrollHideTimer);
    scrollHideTimer = setTimeout(() => {
        hideFloatingActions();
    }, 2000);
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