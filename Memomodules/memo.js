/**
 * Memomodules/memo.js
 * VCP Agent 记忆管理中心逻辑
 */

// ========== 全局状态 ==========
const api = window.utilityAPI || window.electronAPI;

let apiAuthHeader = null;
let serverBaseUrl = '';
let forumConfig = null;
let currentFolder = '';
let allMemos = [];
let currentMemo = null; // 当前正在编辑的日记 { folder, file, content }
let searchScope = 'folder'; // 'folder', 'global', or 'semantic'
let searchAbortController = null; // 搜索请求控制器
let isBatchMode = false;
let selectedMemos = new Set(); // Set of "folder:::name" strings
let hiddenFolders = new Set(); // Set of hidden folder names
let collapsedCategories = new Set(); // Set of collapsed category IDs
let folderOrder = []; // Array of folder names for UI sorting
let visibleFolderNames = []; // 批量移动菜单的候选文件夹
let draggedFolder = null; // Currently dragged folder name
let memoStartupBlocked = false;

// ========== DOM 元素 ==========
const folderListEl = document.getElementById('folder-list');
const memoGridEl = document.getElementById('memo-grid');
const currentFolderNameEl = document.getElementById('current-folder-name');
const memoIntroEl = document.getElementById('memo-intro');
const searchInput = document.getElementById('search-memos');
const contextMenuEl = document.getElementById('context-menu');

// 编辑器相关
const editorOverlay = document.getElementById('editor-overlay');
const editorContainer = document.querySelector('.editor-container');
const editorTitleInput = document.getElementById('editor-title');
const editorHeadingEl = document.getElementById('editor-heading');
const editorTextarea = document.getElementById('editor-textarea');
const editorPreview = document.getElementById('editor-preview');
const editorStatus = document.getElementById('editor-status');

// 弹窗相关
const createModal = document.getElementById('create-modal');
const newMemoDateInput = document.getElementById('new-memo-date');
const newMemoMaidInput = document.getElementById('new-memo-maid');
const newMemoFilenameInput = document.getElementById('new-memo-filename');
const newMemoTagsInput = document.getElementById('new-memo-tags');
const newMemoContentInput = document.getElementById('new-memo-content');

function blockStartup(message) {
    memoStartupBlocked = true;
    currentFolder = '';
    currentFolderNameEl.textContent = '初始化未完成';
    setMemoIntro([]);
    folderListEl.innerHTML = `
        <div class="folder-item folder-item-static">
            <span class="nav-label">初始化未完成</span>
        </div>
    `;
    memoGridEl.innerHTML = renderEmptyState(message, 'error');
}

function renderEmptyState(message, tone = '') {
    const toneAttr = tone ? ` data-tone="${tone}"` : '';
    return `<div class="empty-state"${toneAttr}>${escapeHtml(message)}</div>`;
}

function setMemoIntro(items) {
    if (!memoIntroEl) return;
    memoIntroEl.innerHTML = items
        .filter(Boolean)
        .map(item => `<span class="intro-item">${escapeHtml(item)}</span>`)
        .join('');
}

// ========== 弹出层（菜单 / 参数面板） ==========
const openPopovers = new Set();
const popoverTriggers = new WeakMap();

function openPopover(trigger, popover) {
    openPopovers.forEach(p => { if (p !== popover) closePopover(p); });
    popover.hidden = false;
    fitPopoverInDialog(popover);
    trigger.setAttribute('aria-expanded', 'true');
    popoverTriggers.set(popover, trigger);
    openPopovers.add(popover);
}

// 弹窗里的面板不越过底栏：高度限制在面板顶边与底栏之间，放不下时面板内滚动
function fitPopoverInDialog(popover) {
    popover.style.maxHeight = '';
    const dialog = popover.closest('.modal-content, .editor-container, .workbench-container');
    if (!dialog) return;
    const footer = dialog.querySelector('.modal-footer, .editor-footer');
    const limit = footer ? footer.getBoundingClientRect().top : dialog.getBoundingClientRect().bottom;
    const room = Math.floor(limit - popover.getBoundingClientRect().top - 8);
    if (room < popover.scrollHeight) popover.style.maxHeight = `${Math.max(room, 96)}px`;
}

function closePopover(popover) {
    if (!popover || popover.hidden) return;
    popover.hidden = true;
    popoverTriggers.get(popover)?.setAttribute('aria-expanded', 'false');
    openPopovers.delete(popover);
}

function closeAllPopovers() {
    Array.from(openPopovers).forEach(closePopover);
}

function bindPopover(trigger, popover, { onOpen } = {}) {
    if (!trigger || !popover) return;
    trigger.setAttribute('aria-expanded', 'false');
    popoverTriggers.set(popover, trigger);
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!popover.hidden) {
            closePopover(popover);
            return;
        }
        onOpen?.();
        openPopover(trigger, popover);
        popover.querySelector('input, button:not([disabled]), [role="menuitem"]')?.focus();
    });
}

document.addEventListener('click', (e) => {
    const path = e.composedPath();
    Array.from(openPopovers).forEach(popover => {
        const trigger = popoverTriggers.get(popover);
        if (!path.includes(popover) && !path.includes(trigger)) closePopover(popover);
    });
});

// Esc 先关闭最上层的弹出层；返回 true 表示已处理
function closeTopPopover() {
    const last = Array.from(openPopovers).pop();
    if (!last) return false;
    closePopover(last);
    popoverTriggers.get(last)?.focus();
    return true;
}

function formatMemoTime(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

window.alert = (message) => {
    console.warn('[Memo] Replaced blocking alert:', message);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => blockStartup(message), { once: true });
        return;
    }
    blockStartup(message);
};

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', async () => {
    // 窗口控制
    document.getElementById('minimize-memo-btn').onclick = () => api.minimizeWindow();
    document.getElementById('maximize-memo-btn').onclick = () => api.maximizeWindow();
    document.getElementById('close-memo-btn').onclick = () => api.closeWindow();

    // 初始主题
    if (api?.getCurrentTheme) {
        const theme = await api.getCurrentTheme();
        document.body.classList.toggle('light-theme', theme === 'light');
    }

    // 监听主题更新
    api?.onThemeUpdated((theme) => {
        document.body.classList.toggle('light-theme', theme === 'light');
    });

    // 加载配置并初始化数据
    await initApp();

    // 绑定事件
    setupEventListeners();

    // 监听窗口尺寸变化以更新 Pretext
    const debouncedRecalculatePretext = debounce(() => {
        if (window.pretextBridge && window.pretextBridge.isReady()) {
            window.pretextBridge.recalculateAll(window.innerWidth);
        }
    }, 180);

    window.addEventListener('resize', debouncedRecalculatePretext);

    // 初始化工作台
    if (window.DiaryWorkbench) {
        window.DiaryWorkbench.init();
    }
});

async function initApp() {
    try {
        // 1. 获取服务器地址
        const settings = await api.loadSettings();
        if (!settings?.vcpServerUrl) {
            alert('请先在主设置中配置 VCP 服务器 URL');
            return;
        }
        serverBaseUrl = settings.vcpServerUrl.replace(/\/v1\/chat\/completions\/?$/, '');
        if (!serverBaseUrl.endsWith('/')) serverBaseUrl += '/';

        // 2. 读取论坛配置获取 Auth
        forumConfig = await api.loadForumConfig();
        if (forumConfig && forumConfig.username && forumConfig.password) {
            apiAuthHeader = `Basic ${btoa(`${forumConfig.username}:${forumConfig.password}`)}`;
        } else {
            alert('未找到论坛模块的登录配置，请先在论坛模块登录。');
            return;
        }

        // 3. 加载配置
        const memoConfig = await api.loadMemoConfig();
        if (memoConfig) {
            if (memoConfig.hiddenFolders) {
                hiddenFolders = new Set(memoConfig.hiddenFolders);
            }
            if (memoConfig.collapsedCategories) {
                collapsedCategories = new Set(memoConfig.collapsedCategories);
            }
            if (memoConfig.folderOrder) {
                folderOrder = memoConfig.folderOrder;
            }
        }

        // 4. 加载文件夹列表
        await loadFolders();

    } catch (error) {
        console.error('初始化失败:', error);
    }
}

function setupEventListeners() {
    // 文件夹搜索
    const folderSearchInput = document.getElementById('folder-search-input');
    folderSearchInput.oninput = () => {
        const term = folderSearchInput.value.trim().toLowerCase();
        const items = folderListEl.querySelectorAll('.folder-item');
        items.forEach(item => {
            const name = item.querySelector('span')?.textContent?.toLowerCase() || '';
            item.style.display = name.includes(term) ? '' : 'none';
        });
    };

    // 刷新文件夹
    const refreshBtn = document.getElementById('refresh-folders-btn');
    refreshBtn.onclick = async () => {
        refreshBtn.classList.add('spinning');
        try {
            await loadFolders();
            await refreshMemoList();
            // 确保动画至少持续一秒，增加交互感
            await new Promise(resolve => setTimeout(resolve, 800));
        } finally {
            refreshBtn.classList.remove('spinning');
        }
    };

    // 搜索范围切换：范围本身就是当前视图，没有搜索词时也切换列表、标题和侧边栏选中
    document.querySelectorAll('#search-scope-tabs .memo-tab').forEach(tab => {
        tab.onclick = () => {
            if (searchScope === tab.dataset.scope) return;
            setSearchScope(tab.dataset.scope);

            const term = searchInput.value.trim();
            if (term) {
                debouncedSearch(term);
            } else {
                refreshMemoList();
            }
        };
    });

    // 搜索 (增加防抖保护)
    const debouncedSearch = debounce((term) => {
        searchMemos(term);
    }, 300);

    searchInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
            const term = searchInput.value.trim();
            if (term) {
                debouncedSearch(term);
            } else {
                refreshMemoList();
            }
        }
    };

    // 批量管理
    const batchEditBtn = document.getElementById('batch-edit-btn');
    const cancelBatchBtn = document.getElementById('cancel-batch-btn');

    // 批量模式下工具条替换页头按钮，由 body 类切换显示
    const setBatchMode = (enabled) => {
        isBatchMode = enabled;
        document.body.classList.toggle('memo-batch-mode', enabled);
        closeAllPopovers();
        selectedMemos.clear();
        updateBatchUI();
        renderMemos(allMemos); // 重新渲染以显示选择状态
        (enabled ? cancelBatchBtn : batchEditBtn).focus();
    };

    batchEditBtn.onclick = () => setBatchMode(true);
    cancelBatchBtn.onclick = () => setBatchMode(false);

    document.getElementById('batch-delete-btn').onclick = handleBatchDelete;
    bindPopover(
        document.getElementById('batch-move-btn'),
        document.getElementById('batch-move-menu'),
        { onOpen: renderBatchMoveMenu }
    );
    bindPopover(
        document.getElementById('selected-count'),
        document.getElementById('batch-selection-popover')
    );
    document.getElementById('batch-workbench-btn').onclick = () => {
        const selected = allMemos.filter(m => {
            const memoId = `${m.folderName || currentFolder}:::${m.name}`;
            return selectedMemos.has(memoId);
        });
        if (window.DiaryWorkbench) {
            window.DiaryWorkbench.open(selected);
        }
    };

    // 已选列表中的清空
    document.getElementById('batch-bar-clear').onclick = () => {
        selectedMemos.clear();
        closeAllPopovers();
        updateBatchUI();
        renderMemos(allMemos);
    };

    // 新建日记弹窗：署名、日期、文件名收进参数面板，标题下只显示摘要
    document.getElementById('create-memo-btn').onclick = () => {
        const now = new Date();
        newMemoDateInput.value = now.toISOString().split('T')[0];
        newMemoMaidInput.value = forumConfig.replyUsername || forumConfig.username || '';
        setCreateNotice('');
        closeAllPopovers();
        updateCreateSummary();
        createModal.style.display = 'flex';
    };

    document.getElementById('close-create-modal-btn').onclick = () => {
        closeAllPopovers();
        createModal.style.display = 'none';
    };

    bindPopover(
        document.getElementById('create-options-btn'),
        document.getElementById('create-options-popover')
    );
    [newMemoMaidInput, newMemoDateInput, newMemoFilenameInput].forEach(input => {
        input.addEventListener('input', updateCreateSummary);
    });

    // 校验失败时需要打开参数面板，阻止冒泡以免被外部点击立即关闭
    document.getElementById('submit-new-memo-btn').onclick = (e) => {
        e.stopPropagation();
        handleCreateMemo();
    };

    // 隐藏文件夹管理
    document.getElementById('manage-hidden-btn').onclick = openHiddenFoldersModal;
    document.getElementById('close-hidden-modal-btn').onclick = () => {
        document.getElementById('hidden-folders-modal').style.display = 'none';
    };
    document.getElementById('hidden-modal-ok-btn').onclick = () => {
        document.getElementById('hidden-folders-modal').style.display = 'none';
    };

    // 联想弹窗事件
    const kInput = document.getElementById('input-assoc-k');
    const kValueLabel = document.getElementById('label-k-value');

    if (kInput) {
        kInput.oninput = () => {
            kValueLabel.textContent = kInput.value;
            updateAssocSummary();
        };
    }
    document.getElementById('input-assoc-boost')?.addEventListener('input', updateAssocSummary);

    bindPopover(
        document.getElementById('assoc-options-btn'),
        document.getElementById('assoc-options-popover')
    );

    document.getElementById('close-assoc-config-btn').onclick = () => {
        closeAllPopovers();
        document.getElementById('assoc-config-modal').style.display = 'none';
    };

    document.getElementById('start-assoc-btn').onclick = startAssociation;

    // 联想视图事件
    document.getElementById('close-graph-btn').onclick = closeNeuralGraph;
    document.getElementById('close-panel-btn').onclick = () => {
        document.getElementById('node-detail-panel').classList.add('hidden');
        graphState.selectedNode = null;
    };

    document.getElementById('reset-graph-btn').onclick = () => {
        graphState.transform = { x: 0, y: 0, scale: 1 };
    };

    document.getElementById('zoom-in-btn').onclick = () => {
        graphState.transform.scale *= 1.2;
    };

    document.getElementById('zoom-out-btn').onclick = () => {
        graphState.transform.scale /= 1.2;
    };

    document.getElementById('node-edit-btn').onclick = () => {
        if (graphState.selectedNode) {
            const node = graphState.selectedNode;
            // 不再关闭图谱，直接打开编辑器（编辑器将通过 z-index 覆盖在上方）
            openMemo({ name: node.name, folderName: node.folder });
        }
    };
    
    document.getElementById('node-relink-btn').onclick = () => {
        if (graphState.selectedNode) {
            const node = graphState.selectedNode;
            openAssociationConfig({
                name: node.name,
                folderName: node.folder,
                path: node.path,
                id: node.id // 传递 ID 以便追加
            }, true);
        }
    };

    document.getElementById('node-delete-btn').onclick = async () => {
        if (graphState.selectedNode) {
            const node = graphState.selectedNode;
            const confirmed = await customConfirm(`确定要删除日记 "${node.name}" 吗？`, '⚠️ 删除确认');
            if (confirmed) {
                try {
                    await apiFetch('/delete-batch', {
                        method: 'POST',
                        body: JSON.stringify({
                            notesToDelete: [{ folder: node.folder, file: node.name }]
                        })
                    });
                    // 从图谱中移除节点及其连接
                    graphState.nodes = graphState.nodes.filter(n => n.id !== node.id);
                    graphState.links = graphState.links.filter(l => l.source.id !== node.id && l.target.id !== node.id);
                    
                    // 清除状态并关闭详情面板
                    graphState.selectedNode = null;
                    graphState.hoveredNode = null;
                    document.getElementById('node-detail-panel').classList.add('hidden');
                } catch (e) {
                    alert('删除失败: ' + e.message);
                }
            }
        }
    };

    // 编辑器控制
    document.getElementById('close-editor-btn').onclick = () => {
        editorOverlay.classList.remove('active');
    };

    // 编辑 / 分栏 / 预览 分段切换
    const viewSwitch = document.getElementById('editor-view-switch');
    const viewSegments = Array.from(viewSwitch.querySelectorAll('.memo-segment'));
    viewSegments.forEach(segment => {
        segment.onclick = () => setEditorView(segment.dataset.view);
    });
    viewSwitch.addEventListener('keydown', (e) => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!step) return;
        e.preventDefault();
        const index = viewSegments.findIndex(s => s.getAttribute('aria-checked') === 'true');
        const next = viewSegments[(index + step + viewSegments.length) % viewSegments.length];
        setEditorView(next.dataset.view);
        next.focus();
    });
    setEditorView('split');

    editorTextarea.oninput = () => {
        renderPreview(editorTextarea.value);
    };
    editorTitleInput.oninput = updateEditorHeading;

    document.getElementById('save-memo-btn').onclick = handleSaveMemo;
    document.getElementById('delete-memo-btn').onclick = handleDeleteMemo;

    // 编辑器右键菜单
    editorTextarea.oncontextmenu = (e) => {
        showContextMenu(e, [
            {
                label: '撤销',
                icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14L4 9l5-5"></path><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg>',
                onClick: () => document.execCommand('undo')
            },
            {
                label: '剪切',
                icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line></svg>',
                onClick: () => {
                    editorTextarea.focus();
                    document.execCommand('cut');
                }
            },
            {
                label: '复制',
                icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
                onClick: () => {
                    editorTextarea.focus();
                    document.execCommand('copy');
                }
            },
            {
                label: '粘贴',
                icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>',
                onClick: async () => {
                    editorTextarea.focus();
                    try {
                        const text = await navigator.clipboard.readText();
                        const start = editorTextarea.selectionStart;
                        const end = editorTextarea.selectionEnd;
                        const val = editorTextarea.value;
                        editorTextarea.value = val.substring(0, start) + text + val.substring(end);
                        editorTextarea.selectionStart = editorTextarea.selectionEnd = start + text.length;
                        // 触发 input 事件以更新预览
                        editorTextarea.dispatchEvent(new Event('input'));
                    } catch (err) {
                        console.error('无法粘贴: ', err);
                        // 回退到 execCommand
                        document.execCommand('paste');
                    }
                }
            }
        ]);
    };

    // 全局 Esc 键监听
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            // 优先级：弹出层 > 确认弹窗 > 编辑器 > 新建弹窗
            const confirmModal = document.getElementById('custom-confirm-modal');
            const alertModal = document.getElementById('custom-alert-modal');

            if (closeTopPopover()) {
                return;
            } else if (confirmModal && confirmModal.style.display === 'flex') {
                document.getElementById('confirm-cancel-btn').click();
            } else if (alertModal && alertModal.style.display === 'flex') {
                document.getElementById('alert-ok-btn').click();
            } else if (document.getElementById('hidden-folders-modal').style.display === 'flex') {
                document.getElementById('close-hidden-modal-btn').click();
            } else if (document.getElementById('assoc-config-modal').style.display === 'flex') {
                document.getElementById('close-assoc-config-btn').click();
            } else if (document.getElementById('neural-graph-overlay').style.display === 'flex') {
                document.getElementById('close-graph-btn').click();
            } else if (editorOverlay.classList.contains('active')) {
                document.getElementById('close-editor-btn').click();
            } else if (createModal.style.display === 'flex') {
                document.getElementById('close-create-modal-btn').click();
            } else if (isBatchMode) {
                document.getElementById('cancel-batch-btn').click();
            }
        }
    });

    // 点击页面其他地方隐藏右键菜单
    document.addEventListener('click', () => {
        contextMenuEl.style.display = 'none';
    });
}

// ========== 右键菜单逻辑 ==========
function showContextMenu(e, items) {
    e.preventDefault();
    contextMenuEl.innerHTML = '';

    items.forEach(item => {
        const menuItem = document.createElement('div');
        menuItem.className = `context-menu-item ${item.className || ''}`;
        menuItem.innerHTML = `
            ${item.icon || ''}
            <span>${item.label}</span>
        `;
        menuItem.onclick = (event) => {
            event.stopPropagation();
            contextMenuEl.style.display = 'none';
            item.onClick();
        };
        contextMenuEl.appendChild(menuItem);
    });

    contextMenuEl.style.display = 'block';

    // 调整位置防止溢出
    let x = e.clientX;
    let y = e.clientY;

    const menuWidth = contextMenuEl.offsetWidth || 150;
    const menuHeight = contextMenuEl.offsetHeight || 100;

    if (x + menuWidth > window.innerWidth) x -= menuWidth;
    if (y + menuHeight > window.innerHeight) y -= menuHeight;

    contextMenuEl.style.left = `${x}px`;
    contextMenuEl.style.top = `${y}px`;
}

// ========== API 调用 ==========
async function apiFetch(endpoint, options = {}) {
    if (!apiAuthHeader) throw new Error('未认证');

    const response = await fetch(`${serverBaseUrl}admin_api/dailynotes${endpoint}`, {
        ...options,
        headers: {
            'Authorization': apiAuthHeader,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        let msg = err.error || `API 错误: ${response.status}`;
        if (err.details) msg += ` - ${err.details}`;
        throw new Error(msg);
    }
    return response.json();
}

// ========== 业务逻辑 ==========

async function loadFolders() {
    try {
        const data = await apiFetch('/folders');
        renderFolders(data.folders);
        if (!currentFolder) {
            if (folderOrder.length > 0) {
                // 找到排序后的第一个文件夹
                selectFolder(folderOrder[0]);
            } else {
                // 如果所有文件夹都被隐藏了或暂无文件夹
                currentFolder = '';
                currentFolderNameEl.textContent = '暂无可用文件夹';
                setMemoIntro([]);
                memoGridEl.innerHTML = renderEmptyState('所有文件夹均已隐藏或暂无文件夹');
            }
        }
    } catch (error) {
        console.error('加载文件夹失败:', error);
    }
}

function renderFolders(folders) {
    folderListEl.innerHTML = '';

    // 过滤掉 MusicDiary 和隐藏文件夹
    const visibleFolders = folders.filter(f => f !== 'MusicDiary' && !hiddenFolders.has(f));

    // 根据 folderOrder 排序
    visibleFolders.sort((a, b) => {
        const indexA = folderOrder.indexOf(a);
        const indexB = folderOrder.indexOf(b);
        if (indexA === -1 && indexB === -1) return 0;
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
    });

    // 更新 folderOrder 以包含新发现的文件夹
    folderOrder = visibleFolders;
    visibleFolderNames = visibleFolders;

    // 分类逻辑
    const clusters = visibleFolders.filter(f => f.endsWith('簇'));
    const diaries = visibleFolders.filter(f => !f.endsWith('簇'));

    const categories = [
        { id: 'diary', name: '日记 / 知识库', folders: diaries },
        { id: 'cluster', name: '思维簇', folders: clusters }
    ];

    categories.forEach(cat => {
        if (cat.folders.length === 0) return;

        const catEl = document.createElement('div');
        catEl.className = `folder-category ${collapsedCategories.has(cat.id) ? 'collapsed' : ''}`;
        catEl.id = `cat-${cat.id}`;

        const header = document.createElement('div');
        header.className = 'category-header';
        header.setAttribute('role', 'button');
        header.tabIndex = 0;
        header.innerHTML = `
            <span>${cat.name}</span>
            <svg class="category-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
        `;
        header.onclick = () => toggleCategory(cat.id);
        header.onkeydown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleCategory(cat.id);
            }
        };

        const content = document.createElement('div');
        content.className = 'category-content';

        cat.folders.forEach(folder => {
            const item = document.createElement('div');
            item.className = `folder-item ${searchScope === 'folder' && folder === currentFolder ? 'active' : ''}`;
            item.setAttribute('draggable', 'true');
            item.innerHTML = `
                <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                <span class="nav-label">${escapeHtml(folder)}</span>
            `;
            item.onclick = () => selectFolder(folder);

            // 拖拽事件
            item.ondragstart = (e) => {
                draggedFolder = folder;
                item.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            };

            item.ondragover = (e) => {
                e.preventDefault();
                if (draggedFolder !== folder) {
                    item.classList.add('drag-over');
                }
                return false;
            };

            item.ondragleave = () => {
                item.classList.remove('drag-over');
            };

            item.ondrop = async (e) => {
                e.preventDefault();
                item.classList.remove('drag-over');
                if (draggedFolder && draggedFolder !== folder) {
                    const fromIndex = folderOrder.indexOf(draggedFolder);
                    const toIndex = folderOrder.indexOf(folder);
                    folderOrder.splice(fromIndex, 1);
                    folderOrder.splice(toIndex, 0, draggedFolder);
                    renderFolders(folders);
                    await saveMemoConfig();
                }
                return false;
            };

            item.ondragend = () => {
                item.classList.remove('dragging');
                draggedFolder = null;
            };

            // 文件夹右键菜单
            item.oncontextmenu = (e) => {
                showContextMenu(e, [
                    {
                        label: '删除文件夹',
                        className: 'danger',
                        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
                        onClick: () => handleDeleteFolder(folder)
                    },
                    {
                        label: '隐藏文件夹',
                        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>',
                        onClick: () => handleHideFolder(folder)
                    }
                ]);
            };

            content.appendChild(item);
        });

        catEl.appendChild(header);
        catEl.appendChild(content);
        folderListEl.appendChild(catEl);
    });
}

async function toggleCategory(catId) {
    const catEl = document.getElementById(`cat-${catId}`);
    if (!catEl) return;

    const isCollapsed = catEl.classList.toggle('collapsed');
    if (isCollapsed) {
        collapsedCategories.add(catId);
    } else {
        collapsedCategories.delete(catId);
    }
    await saveMemoConfig();
}

const SEARCH_PLACEHOLDERS = {
    folder: '在当前文件夹中搜索，回车确认',
    global: '在全部日记中搜索，回车确认',
    semantic: '描述想找的内容，回车进行语义检索'
};

function setSearchScope(scope) {
    searchScope = scope;
    document.querySelectorAll('#search-scope-tabs .memo-tab').forEach(tab => {
        tab.setAttribute('aria-selected', String(tab.dataset.scope === scope));
    });
    searchInput.placeholder = SEARCH_PLACEHOLDERS[scope];
    syncFolderHighlight();
}

// 只有“当前文件夹”范围才在侧边栏标出文件夹；全部日记和语义检索不属于任何一个文件夹
function syncFolderHighlight() {
    const activeFolder = searchScope === 'folder' ? currentFolder : null;
    document.querySelectorAll('.folder-item').forEach(el => {
        el.classList.toggle('active', el.querySelector('span')?.textContent === activeFolder);
    });
}

async function selectFolder(folderName) {
    if (memoStartupBlocked) return;
    currentFolder = folderName;
    // 点侧边栏文件夹即回到“当前文件夹”范围
    if (searchScope !== 'folder') setSearchScope('folder');
    currentFolderNameEl.textContent = folderName;
    syncFolderHighlight();

    await loadMemos(folderName);
}

// 全部日记：并行读取所有可见文件夹，按修改时间倒序合成一个列表
async function loadAllMemos() {
    const folders = visibleFolderNames.slice();
    try {
        memoGridEl.innerHTML = renderEmptyState('加载中...');
        const lists = await Promise.all(folders.map(async folder => {
            const data = await apiFetch(`/folder/${encodeURIComponent(folder)}`);
            return (data.memos || data.notes || []).map(memo => ({ ...memo, folderName: memo.folderName || folder }));
        }));
        // 加载期间换了范围或输入了搜索词，就不再覆盖列表
        if (searchScope !== 'global' || searchInput.value.trim()) return;
        const timeOf = memo => new Date(memo.lastModified).getTime() || 0;
        allMemos = lists.flat().sort((a, b) => timeOf(b) - timeOf(a));
        renderMemos(allMemos);
    } catch (error) {
        setMemoIntro([]);
        memoGridEl.innerHTML = renderEmptyState(`加载失败: ${error.message}`, 'error');
    }
}

async function loadMemos(folderName) {
    try {
        memoGridEl.innerHTML = renderEmptyState('加载中...');
        const data = await apiFetch(`/folder/${encodeURIComponent(folderName)}`);
        const memos = data.memos || data.notes || [];
        console.log('[MemoCenter] Raw data from folder API:', memos);
        allMemos = memos; // 更新全局变量，修复批量管理模式显示为空的问题
        renderMemos(memos);
    } catch (error) {
        setMemoIntro([]);
        memoGridEl.innerHTML = renderEmptyState(`加载失败: ${error.message}`, 'error');
    }
}

function renderMemos(memos) {
    memoGridEl.innerHTML = '';
    // 全部日记视图（无搜索词）：每行都写所在文件夹，简介里补一句文件夹数
    const isAllView = searchScope === 'global' && !searchInput.value.trim();
    if (memos.length === 0) {
        setMemoIntro(['0 篇日记']);
        memoGridEl.innerHTML = renderEmptyState(isAllView ? '还没有日记' : '该文件夹下暂无日记');
        return;
    }
    const folderCount = isAllView ? new Set(memos.map(memo => memo.folderName)).size : 0;
    setMemoIntro([
        `${memos.length} 篇日记`,
        folderCount ? `${folderCount} 个文件夹` : '',
        isBatchMode ? '点击行选择或取消选择' : ''
    ]);

    const gridWidth = memoGridEl.offsetWidth;
    const columns = window.innerWidth > 1200 ? 3 : (window.innerWidth > 800 ? 2 : 1);
    const estimatedCardWidth = (gridWidth ? (gridWidth / columns) - 32 : 300);

    memos.forEach(memo => {
        const card = document.createElement('div');
        const memoFolder = memo.folderName || currentFolder;
        const memoId = `${memoFolder}:::${memo.name}`;
        const isSelected = selectedMemos.has(memoId);
        card.className = `memo-card ${isBatchMode ? 'selectable' : ''} ${isSelected ? 'selected' : ''}`;

        const previewText = memo.preview || '无预览内容';

        card.dataset.memoId = memoId;
        card.dataset.pretextWidth = String(Math.max(estimatedCardWidth, 240));

        // 每行只显示一次时间：文件名里的时间优先，否则用修改时间
        const titleParts = parseStructuredMemoName(memo.name);
        const timeText = titleParts?.readableTime || formatMemoTime(memo.lastModified);
        const crossFolder = memo.folderName && (searchScope !== 'folder' || memo.folderName !== currentFolder);
        const metaText = [crossFolder ? memo.folderName : '', timeText].filter(Boolean).join(' · ');
        const modifiedText = formatMemoTime(memo.lastModified);

        card.innerHTML = `
            <div class="memo-card-copy">
                <div class="memo-card-head">
                    <h3 class="memo-title" title="${escapeHtml(memo.name)}">${escapeHtml(getMemoDisplayTitle(memo.name))}</h3>
                    <span class="memo-card-meta"${modifiedText ? ` title="修改于 ${modifiedText}"` : ''}>${escapeHtml(metaText)}</span>
                </div>
                <p class="preview">${escapeHtml(previewText)}</p>
            </div>
            <button type="button" class="memo-icon-btn association-btn" title="记忆联想" aria-label="记忆联想">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .52 8.125A5.002 5.002 0 0 0 14 18a5 5 0 0 0 5-5A3 3 0 0 0 12 5Z"/><path d="M12 18v-2a2 2 0 0 0-2-2H8"/><path d="M16 8a2 2 0 0 0-2 2v2"/></svg>
            </button>
        `;

        card.onclick = (e) => {
            if (e.target.closest('.association-btn')) {
                e.stopPropagation();
                openAssociationConfig(memo);
                return;
            }
            if (isBatchMode) {
                if (selectedMemos.has(memoId)) {
                    selectedMemos.delete(memoId);
                } else {
                    selectedMemos.add(memoId);
                }
                updateBatchUI();
                card.classList.toggle('selected', selectedMemos.has(memoId));
            } else {
                openMemo(memo);
            }
        };
        memoGridEl.appendChild(card);
    });

    scheduleVisibleMemoPretextEstimation();
}

function scheduleVisibleMemoPretextEstimation() {
    if (!window.pretextBridge || !window.pretextBridge.isReady()) return;

    const cards = Array.from(memoGridEl.querySelectorAll('.memo-card'));
    if (cards.length === 0) return;

    const run = () => {
        const visibleCards = cards.filter(card => {
            const rect = card.getBoundingClientRect();
            return rect.bottom >= -200 && rect.top <= window.innerHeight + 200;
        });

        visibleCards.forEach(card => {
            const previewEl = card.querySelector('.preview');
            const memoId = card.dataset.memoId;
            const width = Number(card.dataset.pretextWidth) || 300;
            const text = previewEl?.textContent || '';

            if (memoId && text) {
                window.pretextBridge.estimateHeight(memoId, text, 'memo', width);
            }
        });
    };

    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 300 });
    } else {
        setTimeout(run, 0);
    }
}

// 选择数只在工具条上显示一次；点开计数按钮查看或移除已选项
function updateBatchUI() {
    const count = selectedMemos.size;
    document.getElementById('selected-count-label').textContent = `已选 ${count} 项`;
    ['selected-count', 'batch-move-btn', 'batch-delete-btn', 'batch-workbench-btn'].forEach(id => {
        document.getElementById(id).disabled = count === 0;
    });
    if (count === 0) {
        closePopover(document.getElementById('batch-selection-popover'));
        closePopover(document.getElementById('batch-move-menu'));
    }

    const barItems = document.getElementById('batch-bar-items');
    barItems.innerHTML = '';
    selectedMemos.forEach(memoId => {
        const [folder, name] = memoId.split(':::');
        const item = document.createElement('div');
        item.className = 'batch-item-row';
        item.innerHTML = `
            <div class="batch-item-copy">
                <div class="item-name" title="${escapeHtml(name)}">${escapeHtml(getMemoDisplayTitle(name))}</div>
                <div class="item-folder">${escapeHtml(folder)}</div>
            </div>
            <button type="button" class="memo-icon-btn memo-icon-btn-sm batch-item-remove" title="移出选择" aria-label="移出选择">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
        `;
        item.querySelector('.batch-item-remove').onclick = () => {
            selectedMemos.delete(memoId);
            updateBatchUI();
            renderMemos(allMemos);
        };
        barItems.appendChild(item);
    });
}

function renderBatchMoveMenu() {
    const menu = document.getElementById('batch-move-menu');
    const targets = visibleFolderNames.filter(folder => folder !== currentFolder);
    menu.innerHTML = '<div class="memo-menu-label">移动到</div>';
    if (targets.length === 0) {
        menu.insertAdjacentHTML('beforeend', '<div class="memo-menu-empty">没有可移动到的文件夹</div>');
        return;
    }
    targets.forEach(folder => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'memo-menu-item';
        item.setAttribute('role', 'menuitem');
        item.textContent = folder;
        item.onclick = () => {
            closeAllPopovers();
            handleBatchMove(folder);
        };
        menu.appendChild(item);
    });
}

function getMemoDisplayTitle(name) {
    return parseStructuredMemoName(name)?.title || String(name).replace(/\.[^.]+$/, '');
}

async function openMemo(memo) {
    try {
        const memoFolder = memo.folderName || currentFolder;

        // 跳转逻辑：如果点击的是非当前文件夹的日记，更新当前文件夹状态
        if (memoFolder !== currentFolder) {
            currentFolder = memoFolder;
            // 更新侧边栏 UI 选中状态（全部日记 / 语义检索范围下不标文件夹）
            syncFolderHighlight();
        }

        editorStatus.textContent = '正在加载内容...';
        editorOverlay.classList.add('active');
        editorTitleInput.value = memo.name;
        updateEditorHeading();
        editorTextarea.value = '';
        editorPreview.innerHTML = '';

        const data = await apiFetch(`/note/${encodeURIComponent(memoFolder)}/${encodeURIComponent(memo.name)}`);

        currentMemo = {
            folder: memoFolder,
            file: memo.name,
            content: data.content
        };

        editorTextarea.value = data.content;
        updateEditorHeading();
        renderPreview(data.content);
        editorStatus.textContent = memo.lastModified ? `修改于 ${formatMemoTime(memo.lastModified)}` : '';
    } catch (error) {
        alert('读取日记失败: ' + error.message);
        editorOverlay.classList.remove('active');
    }
}

// 编辑器标题与列表一致：结构化文件名取其中的标题；
// 普通文件名先看正文开头的 Markdown 标题，没有再用去掉扩展名的文件名
function getEditorHeading(fileName, content) {
    if (parseStructuredMemoName(fileName)?.title) return getMemoDisplayTitle(fileName);
    const heading = String(content || '').split(/\r?\n/, 20)
        .map(line => line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/))
        .find(Boolean);
    return heading ? heading[1] : getMemoDisplayTitle(fileName);
}

function updateEditorHeading() {
    const fileName = editorTitleInput.value.trim();
    editorHeadingEl.textContent = fileName ? getEditorHeading(fileName, editorTextarea.value) : '未命名日记';
}

// view: 'edit' 只看源码，'split' 分栏，'preview' 只看渲染
function setEditorView(view) {
    editorContainer.classList.toggle('preview-collapsed', view === 'edit');
    editorContainer.classList.toggle('preview-only', view === 'preview');
    document.querySelectorAll('#editor-view-switch .memo-segment').forEach(segment => {
        const checked = segment.dataset.view === view;
        segment.setAttribute('aria-checked', String(checked));
        segment.tabIndex = checked ? 0 : -1;
    });
}

function renderPreview(content) {
    if (window.marked) {
        editorPreview.innerHTML = marked.parse(content);

        // Pretext 高度测算
        if (window.pretextBridge && window.pretextBridge.isReady() && currentMemo) {
            const previewWidth = editorPreview.offsetWidth || 600;
            const estimatePreviewHeight = () => {
                window.pretextBridge.estimateHeight('memo-preview-' + currentMemo.file, content, 'memo', previewWidth);
            };

            if (typeof window.requestIdleCallback === 'function') {
                window.requestIdleCallback(estimatePreviewHeight, { timeout: 250 });
            } else {
                setTimeout(estimatePreviewHeight, 0);
            }
        }

        // KaTeX 渲染
        if (window.renderMathInElement) {
            renderMathInElement(editorPreview, {
                delimiters: [
                    {left: "$$", right: "$$", display: true},
                    {left: "$", right: "$", display: false},
                    {left: "\\(", right: "\\)", display: false},
                    {left: "\\[", right: "\\]", display: true}
                ]
            });
        }
    } else {
        editorPreview.textContent = content;
    }
}

async function handleSaveMemo() {
    if (!currentMemo) return;

    const newTitle = editorTitleInput.value.trim();
    if (!newTitle) {
        await customAlert('日记文件名/标题不能为空！', '提示');
        editorTitleInput.focus();
        return;
    }

    const newContent = editorTextarea.value;
    const saveBtn = document.getElementById('save-memo-btn');
    const originalText = saveBtn.textContent;

    try {
        saveBtn.disabled = true;
        saveBtn.textContent = '正在保存...';

        const data = await apiFetch(`/note/${encodeURIComponent(currentMemo.folder)}/${encodeURIComponent(currentMemo.file)}`, {
            method: 'POST',
            body: JSON.stringify({
                content: newContent,
                newFileName: newTitle
            })
        });

        const savedFileName = data.savedFileName || newTitle;
        currentMemo.file = savedFileName;
        currentMemo.content = newContent;
        editorTitleInput.value = savedFileName;
        updateEditorHeading();

        editorStatus.textContent = '保存成功 ' + new Date().toLocaleTimeString();

        // 刷新列表预览
        await refreshMemoList();
    } catch (error) {
        await customAlert(error.message, '保存失败');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = originalText;
    }
}

async function handleDeleteFolder(folderName) {
    const confirmed = await customConfirm(`确定要删除文件夹 "${folderName}" 吗？\n注意：仅限空文件夹可以被删除。`, '⚠️ 删除文件夹');
    if (!confirmed) return;

    try {
        const response = await fetch(`${serverBaseUrl}admin_api/dailynotes/folder/delete`, {
            method: 'POST',
            headers: {
                'Authorization': apiAuthHeader,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ folderName })
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || data.message || '删除失败');
        }

        await customAlert('文件夹已成功删除', '成功');
        if (currentFolder === folderName) {
            currentFolder = '';
        }
        await loadFolders();
    } catch (error) {
        customAlert(error.message, '删除失败');
    }
}

async function handleDeleteMemo() {
    if (!currentMemo) return;
    const confirmed = await customConfirm(`确定要删除日记 "${currentMemo.file}" 吗？\n此操作不可撤销。`, '⚠️ 删除确认');
    if (!confirmed) return;

    try {
        await apiFetch('/delete-batch', {
            method: 'POST',
            body: JSON.stringify({
                notesToDelete: [{ folder: currentMemo.folder, file: currentMemo.file }]
            })
        });

        editorOverlay.classList.remove('active');
        await refreshMemoList();
    } catch (error) {
        alert('删除失败: ' + error.message);
    }
}

async function handleCreateMemo() {
    const date = newMemoDateInput.value;
    const maid = newMemoMaidInput.value.trim();
    const folder = document.getElementById('new-memo-folder')?.value.trim() || '';
    const fileName = newMemoFilenameInput.value.trim();
    const tags = newMemoTagsInput.value.trim();
    const content = newMemoContentInput.value.trim();

    // 缺项时就地提示；署名和日期在参数面板里，需要先打开面板
    const optionsBtn = document.getElementById('create-options-btn');
    const optionsPopover = document.getElementById('create-options-popover');
    if (!maid || !date) {
        setCreateNotice(!maid ? '请填写署名' : '请选择日期', 'error');
        openPopover(optionsBtn, optionsPopover);
        (!maid ? newMemoMaidInput : newMemoDateInput).focus();
        return;
    }
    if (!content) {
        setCreateNotice('请填写内容', 'error');
        newMemoContentInput.focus();
        return;
    }
    setCreateNotice('');
    closeAllPopovers();

    const submitBtn = document.getElementById('submit-new-memo-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = '正在发布...';

    try {
        const settings = await api.loadSettings();
        if (!settings?.vcpApiKey) throw new Error('API Key 未配置');

        // 构造 TOOL_REQUEST（可选字段仅在有值时加入）
        let toolFields = `maid:「始」${maid}「末」,
tool_name:「始」DailyNote「末」,
command:「始」create「末」,
Date:「始」${date}「末」,`;

        if (folder) {
            toolFields += `\nfolder:「始」${folder}「末」,`;
        }
        if (fileName) {
            toolFields += `\nfileName:「始」${fileName}「末」,`;
        }
        if (tags) {
            toolFields += `\nTag:「始」${tags}「末」,`;
        }

        toolFields += `\nContent:「始」${content}「末」`;

        const toolRequest = `<<<[TOOL_REQUEST]>>>\n${toolFields}\n<<<[END_TOOL_REQUEST]>>>`;

        const res = await fetch(`${serverBaseUrl}v1/human/tool`, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain;charset=UTF-8',
                'Authorization': `Bearer ${settings.vcpApiKey}`
            },
            body: toolRequest
        });

        if (!res.ok) throw new Error(await res.text());

        // 成功后处理
        createModal.style.display = 'none';
        newMemoContentInput.value = '';
        newMemoFilenameInput.value = '';
        newMemoTagsInput.value = '';

        // 延迟刷新，给后端一点处理时间
        setTimeout(async () => {
            await loadFolders();
            await refreshMemoList();
        }, 1000);

    } catch (error) {
        setCreateNotice('发布失败: ' + error.message, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '发布';
    }
}

function setCreateNotice(message, tone = '') {
    const notice = document.getElementById('create-form-notice');
    if (!notice) return;
    notice.textContent = message;
    if (tone) notice.dataset.tone = tone;
    else delete notice.dataset.tone;
}

// 参数面板收起时，标题下的摘要说明当前署名、日期和文件名
function updateCreateSummary() {
    const summary = document.getElementById('create-summary');
    if (!summary) return;
    const maid = newMemoMaidInput.value.trim();
    const fileName = newMemoFilenameInput.value.trim();
    summary.textContent = [
        maid ? `署名 ${maid}` : '未署名',
        newMemoDateInput.value || '未选日期',
        fileName ? `文件名 ${fileName}` : '文件名自动生成'
    ].join(' · ');
}

async function searchMemos(term) {
    // 如果有正在进行的搜索，立即取消它
    if (searchAbortController) {
        searchAbortController.abort();
    }
    searchAbortController = new AbortController();

    try {
        memoGridEl.innerHTML = renderEmptyState('搜索中...');

        if (searchScope === 'semantic') {
            await performSemanticSearch(term);
            return;
        }

        let url = `/search?term=${encodeURIComponent(term)}`;

        // 根据搜索范围决定是否添加 folder 参数
        if (searchScope === 'folder' && currentFolder) {
            url += `&folder=${encodeURIComponent(currentFolder)}`;
        }

        const data = await apiFetch(url, { signal: searchAbortController.signal });

        // 过滤掉来自 MusicDiary 和隐藏文件夹的搜索结果
        const filteredNotes = data.notes.filter(note =>
            note.folderName !== 'MusicDiary' && !hiddenFolders.has(note.folderName)
        );

        allMemos = filteredNotes; // 更新全局变量，确保后续操作（如批量管理）针对的是搜索结果
        const scopeText = (searchScope === 'folder' && currentFolder) ? `${currentFolder} 内搜索` : `全局搜索`;
        currentFolderNameEl.textContent = `${scopeText}: ${term}`;
        renderMemos(filteredNotes);
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('搜索请求已取消:', term);
            return;
        }
        setMemoIntro([]);
        memoGridEl.innerHTML = renderEmptyState(`搜索失败: ${error.message}`, 'error');
    } finally {
        // 如果当前 controller 还是自己，则清空
        if (searchAbortController && !searchAbortController.signal.aborted) {
            // 这里不直接置空，因为可能已经有新的搜索发起了
        }
    }
}

async function performSemanticSearch(query) {
    // 捕获当前的 abort controller 本地引用，防止竞态
    const myAbortController = searchAbortController;
    try {
        const settings = await api.loadSettings();
        if (!settings?.vcpApiKey) throw new Error('API Key 未配置');

        // 竞态检查：如果在 await 期间有新搜索发起，放弃当前搜索
        if (myAbortController.signal.aborted || myAbortController !== searchAbortController) return;

        let serverBaseUrl = settings.vcpServerUrl.replace(/\/v1\/chat\/completions\/?$/, '');
        if (!serverBaseUrl.endsWith('/')) serverBaseUrl += '/';

        const toolRequest = `<<<[TOOL_REQUEST]>>>
maid:「始」Memo「末」,
tool_name:「始」LightMemo「末」,
query:「始」${query}「末」,
k:「始」10「末」,
tag_boost:「始」0.6「末」,
search_all_knowledge_bases:「始」true「末」
<<<[END_TOOL_REQUEST]>>>`;

        const res = await fetch(`${serverBaseUrl}v1/human/tool`, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain;charset=UTF-8',
                'Authorization': `Bearer ${settings.vcpApiKey}`
            },
            body: toolRequest,
            signal: myAbortController.signal
        });

        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        
        // 竞态检查：fetch 返回后确认当前搜索未被取代
        if (myAbortController !== searchAbortController) return;

        const data = await res.json();
        console.log('[Memo] Semantic search result:', data);
        
        // 竞态检查：解析完成后再次确认
        if (myAbortController !== searchAbortController) return;

        const output = extractLightMemoOutput(data);

        if (output) {
            processSemanticSearchResults(output, query);
        } else {
            setMemoIntro([]);
            memoGridEl.innerHTML = renderEmptyState('语义搜索未返回结果');
        }
    } catch (err) {
        if (err.name === 'AbortError') return;
        // 竞态检查：如果已被新搜索取代，静默退出
        if (myAbortController !== searchAbortController) return;
        console.error('[Memo] Semantic search error:', err);
        setMemoIntro([]);
        memoGridEl.innerHTML = renderEmptyState(`语义搜索失败: ${err.message}`, 'error');
    }
}

function extractLightMemoOutput(payload) {
    if (!payload) return '';
    if (typeof payload === 'string') return payload;

    if (typeof payload.original_plugin_output !== 'undefined') {
        return normalizeLightMemoContent(payload.original_plugin_output);
    }

    if (payload.result) {
        const resultOutput = extractLightMemoOutput(payload.result);
        if (resultOutput) return resultOutput;
    }

    if (typeof payload.content !== 'undefined') {
        return normalizeLightMemoContent(payload.content);
    }

    if (typeof payload.text === 'string') {
        return payload.text;
    }

    return '';
}

function normalizeLightMemoContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') {
        try {
            const parsedContent = JSON.parse(content);
            const nestedOutput = extractLightMemoOutput(parsedContent);
            return nestedOutput || content;
        } catch (e) {
            return content;
        }
    }

    if (Array.isArray(content)) {
        return content
            .map(item => {
                if (typeof item === 'string') return item;
                if (item && typeof item.text === 'string') return item.text;
                return extractLightMemoOutput(item);
            })
            .filter(Boolean)
            .join('\n');
    }

    if (typeof content === 'object') {
        return extractLightMemoOutput(content);
    }

    return String(content);
}

function processSemanticSearchResults(output, query) {
    // LightMemo 的 sourceFile 可能是绝对路径、相对路径或 file URL。
    // 日记 API 只接受 <folder>/<file>，因此优先采用“来源”作为文件夹，
    // 仅在来源缺失时使用路径的直接父目录兜底。
    const resultByMemo = new Map();
    const normalizedOutput = String(output || '').replace(/\r\n?/g, '\n');
    const sections = normalizedOutput.split(/(?=^---\s*\(来源\s*[:：])/gm);

    sections.forEach(section => {
        const sourceMatch = section.match(
            /^---\s*\(来源\s*[:：]\s*(.+?)(?:[,，]\s*相关(?:性)?\s*[:：]|\)\s*$)/m
        );
        const pathMatch = section.match(/^\s*\[路径\s*[:：]\s*(.+?)\]\s*$/m);
        if (!pathMatch) return;

        const pathInfo = parseSemanticMemoPath(pathMatch[1]);
        if (!pathInfo.fileName) return;

        const sourceFolder = sourceMatch ? sourceMatch[1].trim() : '';
        const folderName = sourceFolder || pathInfo.parentFolder;
        if (
            !folderName ||
            folderName === 'MusicDiary' ||
            hiddenFolders.has(folderName)
        ) {
            return;
        }

        const contentLines = [];
        for (const rawLine of section.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;

            // 过滤 LightMemo 标题及其可选引擎元数据，避免元信息进入卡片预览。
            if (/^---\s*\(来源\s*[:：]/.test(line)) continue;
            if (/^\[路径\s*[:：]/.test(line)) continue;
            if (/^\[(?:TagMemo|RiverMemo)\b/i.test(line)) continue;
            if (/^Tag\s*[：:]/i.test(line)) continue;
            if (/^\[---/.test(line) || /^---+$/.test(line)) continue;

            contentLines.push(line);
            if (contentLines.join(' ').length >= 150) break;
        }

        const memoKey = `${folderName}:::${pathInfo.fileName}`;
        const preview = contentLines.join(' ').substring(0, 150);
        const existing = resultByMemo.get(memoKey);

        // LightMemo 可能从同一文件召回多个 chunk。卡片按文件去重，并保留更长的片段。
        if (!existing || preview.length > existing.preview.length) {
            resultByMemo.set(memoKey, {
                name: pathInfo.fileName,
                folderName,
                preview: preview || existing?.preview || '语义匹配片段...',
                lastModified: Date.now(),
                path: pathInfo.normalizedPath
            });
        }
    });

    const results = Array.from(resultByMemo.values());
    allMemos = results;
    currentFolderNameEl.textContent = `语义级全局检索: ${query}`;

    if (results.length === 0) {
        setMemoIntro([]);
        memoGridEl.innerHTML = renderEmptyState('语义搜索返回了内容，但未识别到可打开的日记路径');
        return;
    }

    renderMemos(results);
}

function parseSemanticMemoPath(rawPath) {
    let normalizedPath = String(rawPath || '').trim();

    // URL 构造器不能稳定处理所有 Windows 相对路径，这里只剥离 LightMemo 添加的协议。
    normalizedPath = normalizedPath
        .replace(/^file:(?:\/\/\/|\/\/)?/i, '')
        .replace(/[?#].*$/, '');

    try {
        normalizedPath = decodeURIComponent(normalizedPath);
    } catch (error) {
        console.warn('[Memo] Semantic result contains an invalid encoded path:', rawPath);
    }

    normalizedPath = normalizedPath
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\/(?=[A-Za-z]:\/)/, '')
        .replace(/\/$/, '');

    const parts = normalizedPath.split('/').filter(Boolean);
    const fileName = parts.pop() || '';
    const parentFolder = parts.pop() || '';

    return {
        normalizedPath,
        fileName,
        parentFolder
    };
}

async function handleBatchDelete() {
    if (selectedMemos.size === 0) return;
    const confirmed = await customConfirm(`确定要批量删除选中的 ${selectedMemos.size} 项日记吗？\n此操作不可撤销！`, '⚠️ 批量删除确认');
    if (!confirmed) return;

    try {
        const notesToDelete = Array.from(selectedMemos).map(memoId => {
            const [folder, file] = memoId.split(':::');
            return { folder, file };
        });

        await apiFetch('/delete-batch', {
            method: 'POST',
            body: JSON.stringify({ notesToDelete })
        });

        selectedMemos.clear();
        document.getElementById('cancel-batch-btn').click();
        await refreshMemoList();
    } catch (error) {
        alert('批量删除失败: ' + error.message);
    }
}

async function handleBatchMove(targetFolder) {
    if (!targetFolder || selectedMemos.size === 0) return;

    const confirmed = await customConfirm(`确定要将选中的 ${selectedMemos.size} 项日记移动到 "${targetFolder}" 吗？`, '📦 批量移动确认');
    if (!confirmed) return;

    try {
        const sourceNotes = Array.from(selectedMemos).map(memoId => {
            const [folder, file] = memoId.split(':::');
            return { folder, file };
        });

        await apiFetch('/move', {
            method: 'POST',
            body: JSON.stringify({
                sourceNotes,
                targetFolder
            })
        });

        selectedMemos.clear();
        document.getElementById('cancel-batch-btn').click();
        await refreshMemoList();
        await loadFolders();
    } catch (error) {
        alert('批量移动失败: ' + error.message);
    }
}

async function handleHideFolder(folderName) {
    const confirmed = await customConfirm(`确定要隐藏文件夹 "${folderName}" 吗？\n隐藏后将不会在列表中显示，也不会被检索到。`, '🙈 隐藏文件夹');
    if (!confirmed) return;

    hiddenFolders.add(folderName);
    await saveMemoConfig();

    if (currentFolder === folderName) {
        currentFolder = '';
        memoGridEl.innerHTML = '';
        currentFolderNameEl.textContent = '请选择文件夹';
    }
    await loadFolders();
}

async function saveMemoConfig() {
    try {
        await api.saveMemoConfig({
            hiddenFolders: Array.from(hiddenFolders),
            collapsedCategories: Array.from(collapsedCategories),
            folderOrder: folderOrder
        });
    } catch (error) {
        console.error('保存记忆中心配置失败:', error);
    }
}

function openHiddenFoldersModal() {
    const modal = document.getElementById('hidden-folders-modal');
    const listEl = document.getElementById('hidden-folders-list');
    listEl.innerHTML = '';

    if (hiddenFolders.size === 0) {
        listEl.innerHTML = renderEmptyState('暂无隐藏的文件夹');
    } else {
        hiddenFolders.forEach(folder => {
            const item = document.createElement('div');
            item.className = 'hidden-folder-row';
            item.innerHTML = `
                <svg class="hidden-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                <span class="hidden-folder-name">${escapeHtml(folder)}</span>
                <button type="button" class="memo-icon-btn" title="取消隐藏「${escapeHtml(folder)}」" aria-label="取消隐藏「${escapeHtml(folder)}」">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
            `;
            item.querySelector('button').onclick = async () => {
                hiddenFolders.delete(folder);
                await saveMemoConfig();
                openHiddenFoldersModal(); // 刷新列表
                await loadFolders(); // 刷新侧边栏
            };
            listEl.appendChild(item);
        });
    }

    modal.style.display = 'flex';
}

// 按当前范围重载列表：有搜索词就重新搜索；否则文件夹范围读当前文件夹，
// 全部日记读所有可见文件夹，语义检索等用户输入描述
async function refreshMemoList() {
    if (memoStartupBlocked) return;
    const term = searchInput.value.trim();
    if (term) {
        await searchMemos(term);
    } else if (searchScope === 'global') {
        currentFolderNameEl.textContent = '全部日记';
        await loadAllMemos();
    } else if (searchScope === 'semantic') {
        currentFolderNameEl.textContent = '语义检索';
        allMemos = [];
        setMemoIntro([]);
        memoGridEl.innerHTML = renderEmptyState('描述想找的内容，回车进行语义检索');
    } else if (currentFolder) {
        currentFolderNameEl.textContent = currentFolder;
        await loadMemos(currentFolder);
    }
}

// ========== 自定义弹窗函数 ==========
function customConfirm(message, title = '确认操作') {
    return new Promise((resolve) => {
        const modal = document.getElementById('custom-confirm-modal');
        const titleEl = document.getElementById('confirm-title');
        const messageEl = document.getElementById('confirm-message');
        const okBtn = document.getElementById('confirm-ok-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');

        titleEl.textContent = title;
        messageEl.textContent = message;
        modal.style.display = 'flex';

        const handleOk = () => {
            modal.style.display = 'none';
            cleanup();
            resolve(true);
        };

        const handleCancel = () => {
            modal.style.display = 'none';
            cleanup();
            resolve(false);
        };

        const cleanup = () => {
            okBtn.removeEventListener('click', handleOk);
            cancelBtn.removeEventListener('click', handleCancel);
            modal.removeEventListener('click', handleModalClick);
        };

        const handleModalClick = (e) => {
            if (e.target === modal) handleCancel();
        };

        okBtn.addEventListener('click', handleOk);
        cancelBtn.addEventListener('click', handleCancel);
        modal.addEventListener('click', handleModalClick);
    });
}

function customAlert(message, title = '提示') {
    return new Promise((resolve) => {
        const modal = document.getElementById('custom-alert-modal');
        const titleEl = document.getElementById('alert-title');
        const messageEl = document.getElementById('alert-message');
        const okBtn = document.getElementById('alert-ok-btn');

        titleEl.textContent = title;
        messageEl.textContent = message;
        modal.style.display = 'flex';

        const handleOk = () => {
            modal.style.display = 'none';
            cleanup();
            resolve();
        };

        const cleanup = () => {
            okBtn.removeEventListener('click', handleOk);
            modal.removeEventListener('click', handleModalClick);
        };

        const handleModalClick = (e) => {
            if (e.target === modal) handleOk();
        };

        okBtn.addEventListener('click', handleOk);
        modal.addEventListener('click', handleModalClick);
    });
}

// ========== 工具函数 ==========
function parseStructuredMemoName(fileName) {
    if (typeof fileName !== 'string') return null;

    const extMatch = fileName.match(/\.([^.]+)$/);
    const formatFromExt = extMatch?.[1] || '';
    const withoutExt = fileName.replace(/\.[^.]+$/, '');

    // 支持：2026-06-01-06_21_33-六一晨间的温柔拥抱.txt
    // 也兼容：2026-06-01-06_21_33-标题-md.txt 这类带额外格式尾缀的旧命名
    const match = withoutExt.match(/^(\d{4})[-_](\d{2})[-_](\d{2})[-_](\d{2})[-_](\d{2})[-_](\d{2})[-_]+(.+)$/);
    if (!match) return null;

    const [, year, month, day, hour, minute, second, rawRest] = match;
    const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    if (
        Number.isNaN(date.getTime()) ||
        date.getFullYear() !== Number(year) ||
        date.getMonth() !== Number(month) - 1 ||
        date.getDate() !== Number(day) ||
        date.getHours() !== Number(hour) ||
        date.getMinutes() !== Number(minute) ||
        date.getSeconds() !== Number(second)
    ) {
        return null;
    }

    let rawTitle = rawRest;
    let format = formatFromExt;

    const titleTailMatch = rawRest.match(/^(.+)[-_]([A-Za-z0-9]{2,8})$/);
    if (titleTailMatch && !formatFromExt) {
        rawTitle = titleTailMatch[1];
        format = titleTailMatch[2];
    } else if (titleTailMatch && /^(md|txt|markdown)$/i.test(titleTailMatch[2])) {
        // 旧命名“标题-md.txt”：尾缀只是格式标记，不进标题
        rawTitle = titleTailMatch[1];
    }

    if (!format) return null;

    const title = rawTitle.replace(/[-_]+/g, ' ').trim();
    if (!title) return null;

    return {
        format: format.toUpperCase(),
        title,
        readableTime: `${year}-${month}-${day} ${hour}:${minute}`
    };
}

function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}
