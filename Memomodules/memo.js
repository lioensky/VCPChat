/**
 * Memomodules/memo.js
 * VCP Agent 记忆管理中心逻辑
 */

// ========== 全局状态 ==========
let apiAuthHeader = null;
let serverBaseUrl = '';
let forumConfig = null;
let currentFolder = '';
let allMemos = [];
let currentMemo = null; // 当前正在编辑的日记 { folder, file, content }
let searchScope = 'folder'; // 'folder' or 'global'
let searchAbortController = null; // 搜索请求控制器
let isBatchMode = false;
let selectedMemos = new Set(); // Set of "folder:::name" strings
let hiddenFolders = new Set(); // Set of hidden folder names
let folderOrder = []; // Array of folder names for UI sorting
let draggedFolder = null; // Currently dragged folder name

// ========== 神经联想网络状态 ==========
let graphState = {
    sourceMemo: null,
    nodes: [],
    links: [],
    transform: { x: 0, y: 0, scale: 1 },
    selectedNode: null,
    hoveredNode: null,
    isDragging: false,
    dragNode: null,
    lastMousePos: { x: 0, y: 0 },
    animationId: null,
    config: {
        k: 10,
        boost: 0.15,
        range: []
    }
};

// ========== DOM 元素 ==========
const folderListEl = document.getElementById('folder-list');
const memoGridEl = document.getElementById('memo-grid');
const currentFolderNameEl = document.getElementById('current-folder-name');
const searchInput = document.getElementById('search-memos');
const contextMenuEl = document.getElementById('context-menu');

// 编辑器相关
const editorOverlay = document.getElementById('editor-overlay');
const editorTitleInput = document.getElementById('editor-title');
const editorTextarea = document.getElementById('editor-textarea');
const editorPreview = document.getElementById('editor-preview');
const editorStatus = document.getElementById('editor-status');

// 弹窗相关
const createModal = document.getElementById('create-modal');
const newMemoDateInput = document.getElementById('new-memo-date');
const newMemoMaidInput = document.getElementById('new-memo-maid');
const newMemoContentInput = document.getElementById('new-memo-content');

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', async () => {
    // 窗口控制
    document.getElementById('minimize-memo-btn').onclick = () => window.electronAPI.minimizeWindow();
    document.getElementById('maximize-memo-btn').onclick = () => window.electronAPI.maximizeWindow();
    document.getElementById('close-memo-btn').onclick = () => window.electronAPI.closeWindow();

    // 初始主题
    if (window.electronAPI && window.electronAPI.getCurrentTheme) {
        const theme = await window.electronAPI.getCurrentTheme();
        document.body.classList.toggle('light-theme', theme === 'light');
    }

    // 监听主题更新
    window.electronAPI?.onThemeUpdated((theme) => {
        document.body.classList.toggle('light-theme', theme === 'light');
    });

    // 加载配置并初始化数据
    await initApp();

    // 绑定事件
    setupEventListeners();
});

async function initApp() {
    try {
        // 1. 获取服务器地址
        const settings = await window.electronAPI.loadSettings();
        if (!settings?.vcpServerUrl) {
            alert('请先在主设置中配置 VCP 服务器 URL');
            return;
        }
        serverBaseUrl = settings.vcpServerUrl.replace(/\/v1\/chat\/completions\/?$/, '');
        if (!serverBaseUrl.endsWith('/')) serverBaseUrl += '/';

        // 2. 读取论坛配置获取 Auth
        forumConfig = await window.electronAPI.loadForumConfig();
        if (forumConfig && forumConfig.username && forumConfig.password) {
            apiAuthHeader = `Basic ${btoa(`${forumConfig.username}:${forumConfig.password}`)}`;
        } else {
            alert('未找到论坛模块的登录配置，请先在论坛模块登录。');
            return;
        }

        // 3. 加载配置
        const memoConfig = await window.electronAPI.loadMemoConfig();
        if (memoConfig) {
            if (memoConfig.hiddenFolders) {
                hiddenFolders = new Set(memoConfig.hiddenFolders);
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
    // 刷新文件夹
    const refreshBtn = document.getElementById('refresh-folders-btn');
    refreshBtn.onclick = async () => {
        refreshBtn.classList.add('spinning');
        try {
            await loadFolders();
            if (currentFolder) await loadMemos(currentFolder);
            // 确保动画至少持续一秒，增加交互感
            await new Promise(resolve => setTimeout(resolve, 800));
        } finally {
            refreshBtn.classList.remove('spinning');
        }
    };

    // 搜索范围切换
    const searchScopeBtn = document.getElementById('search-scope-btn');
    searchScopeBtn.onclick = () => {
        searchScope = searchScope === 'folder' ? 'global' : 'folder';
        
        // 更新按钮 UI
        searchScopeBtn.classList.toggle('active', searchScope === 'global');
        searchScopeBtn.title = searchScope === 'folder' ? '当前范围：文件夹内' : '当前范围：全局搜索';
        
        // 切换图标
        if (searchScope === 'global') {
            searchScopeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`;
        } else {
            searchScopeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
        }
        
        // 如果搜索框有内容，立即重新搜索
        const term = searchInput.value.trim();
        if (term) searchMemos(term);
    };

    // 搜索 (增加防抖保护)
    const debouncedSearch = debounce((term) => {
        searchMemos(term);
    }, 300);

    searchInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
            const term = searchInput.value.trim();
            if (term) {
                debouncedSearch(term);
            } else if (currentFolder) {
                loadMemos(currentFolder);
            }
        }
    };

    // 批量管理
    const batchEditBtn = document.getElementById('batch-edit-btn');
    const batchActions = document.getElementById('batch-actions');
    const cancelBatchBtn = document.getElementById('cancel-batch-btn');

    batchEditBtn.onclick = () => {
        isBatchMode = true;
        batchEditBtn.style.display = 'none';
        batchActions.style.display = 'flex';
        selectedMemos.clear();
        updateBatchUI();
        renderMemos(allMemos); // 重新渲染以显示选择状态
    };

    cancelBatchBtn.onclick = () => {
        isBatchMode = false;
        batchEditBtn.style.display = 'flex';
        batchActions.style.display = 'none';
        selectedMemos.clear();
        updateBatchUI();
        renderMemos(allMemos);
    };

    document.getElementById('batch-delete-btn').onclick = handleBatchDelete;
    document.getElementById('batch-move-select').onchange = handleBatchMove;

    // 悬浮条清空
    document.getElementById('batch-bar-clear').onclick = () => {
        selectedMemos.clear();
        updateBatchUI();
        renderMemos(allMemos);
    };

    // 新建日记弹窗
    document.getElementById('create-memo-btn').onclick = () => {
        const now = new Date();
        newMemoDateInput.value = now.toISOString().split('T')[0];
        newMemoMaidInput.value = forumConfig.replyUsername || forumConfig.username || '';
        createModal.style.display = 'flex';
    };

    document.getElementById('close-create-modal-btn').onclick = () => {
        createModal.style.display = 'none';
    };

    document.getElementById('submit-new-memo-btn').onclick = handleCreateMemo;

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
    const boostInput = document.getElementById('input-assoc-boost');
    const kValueLabel = document.getElementById('label-k-value');
    const boostValueLabel = document.getElementById('label-boost-value');

    if (kInput) kInput.oninput = () => kValueLabel.textContent = kInput.value;
    if (boostInput) boostInput.oninput = () => boostValueLabel.textContent = boostInput.value;

    document.getElementById('close-assoc-config-btn').onclick = () => {
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

    editorTextarea.oninput = () => {
        renderPreview(editorTextarea.value);
    };

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
            // 优先级：确认弹窗 > 编辑器 > 新建弹窗
            const confirmModal = document.getElementById('custom-confirm-modal');
            const alertModal = document.getElementById('custom-alert-modal');

            if (confirmModal && confirmModal.style.display === 'flex') {
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
                memoGridEl.innerHTML = '<div style="padding: 20px; color: var(--text-secondary);">所有文件夹均已隐藏或暂无文件夹</div>';
            }
        }
    } catch (error) {
        console.error('加载文件夹失败:', error);
    }
}

function renderFolders(folders) {
    folderListEl.innerHTML = '';
    const moveSelect = document.getElementById('batch-move-select');
    moveSelect.innerHTML = '<option value="">-- 移动到文件夹 --</option>';

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

    visibleFolders.forEach(folder => {
        // 侧边栏列表
        const item = document.createElement('div');
        item.className = `folder-item ${folder === currentFolder ? 'active' : ''}`;
        item.setAttribute('draggable', 'true');
        item.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
            <span>${folder}</span>
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
                // 重新排序
                const fromIndex = folderOrder.indexOf(draggedFolder);
                const toIndex = folderOrder.indexOf(folder);

                folderOrder.splice(fromIndex, 1);
                folderOrder.splice(toIndex, 0, draggedFolder);

                renderFolders(folders); // 重新渲染
                await saveMemoConfig(); // 持久化
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

        folderListEl.appendChild(item);

        // 批量移动下拉框
        if (folder !== currentFolder) {
            const opt = document.createElement('option');
            opt.value = folder;
            opt.textContent = folder;
            moveSelect.appendChild(opt);
        }
    });
}

async function selectFolder(folderName) {
    currentFolder = folderName;
    currentFolderNameEl.textContent = folderName;

    // 更新 UI 选中状态
    document.querySelectorAll('.folder-item').forEach(el => {
        el.classList.toggle('active', el.querySelector('span').textContent === folderName);
    });

    await loadMemos(folderName);
}

async function loadMemos(folderName) {
    try {
        memoGridEl.innerHTML = '<div style="padding: 20px;">加载中...</div>';
        const data = await apiFetch(`/folder/${encodeURIComponent(folderName)}`);
        const memos = data.memos || data.notes || [];
        console.log('[MemoCenter] Raw data from folder API:', memos);
        renderMemos(memos);
    } catch (error) {
        memoGridEl.innerHTML = `<div style="padding: 20px; color: var(--danger-color);">加载失败: ${error.message}</div>`;
    }
}

function renderMemos(memos) {
    memoGridEl.innerHTML = '';
    if (memos.length === 0) {
        memoGridEl.innerHTML = '<div style="padding: 20px; color: var(--text-secondary);">该文件夹下暂无日记</div>';
        return;
    }

    memos.forEach(memo => {
        const card = document.createElement('div');
        const memoFolder = memo.folderName || currentFolder;
        const memoId = `${memoFolder}:::${memo.name}`;
        const isSelected = selectedMemos.has(memoId);
        card.className = `memo-card glass glass-hover ${isBatchMode ? 'selectable' : ''} ${isSelected ? 'selected' : ''}`;

        const dateStr = new Date(memo.lastModified).toLocaleString();

        card.innerHTML = `
            <div>
                <h3>${memo.name}</h3>
                <p class="preview">${memo.preview || '无预览内容'}</p>
            </div>
            <div class="meta">
                <span>📅 ${dateStr}</span>
                <div style="display: flex; align-items: center; gap: 8px;">
                    ${memo.folderName && memo.folderName !== currentFolder ? `<span style="opacity:0.6; font-size:0.7rem;">📁 ${memo.folderName}</span>` : ''}
                    <button class="association-btn" title="记忆联想">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .52 8.125A5.002 5.002 0 0 0 14 18a5 5 0 0 0 5-5A3 3 0 0 0 12 5Z"/><path d="M12 18v-2a2 2 0 0 0-2-2H8"/><path d="M16 8a2 2 0 0 0-2 2v2"/></svg>
                    联想
                </button>
                </div>
            </div>
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
}

function updateBatchUI() {
    const count = selectedMemos.size;
    document.getElementById('selected-count').textContent = `已选 ${count} 项`;

    const floatingBar = document.getElementById('batch-floating-bar');
    const barCount = document.getElementById('batch-bar-count');
    const barItems = document.getElementById('batch-bar-items');

    if (count > 0 && isBatchMode) {
        floatingBar.style.display = 'flex';
        barCount.textContent = `已选择 ${count} 项`;

        // 渲染选中项列表
        barItems.innerHTML = '';
        selectedMemos.forEach(memoId => {
            const [folder, name] = memoId.split(':::');
            const item = document.createElement('div');
            item.className = 'batch-item-tag';
            item.innerHTML = `
                <div class="item-name" title="${name}">${name}</div>
                <div class="item-folder">📁 ${folder}</div>
                <div class="batch-item-remove" title="移除">×</div>
            `;
            item.querySelector('.batch-item-remove').onclick = (e) => {
                e.stopPropagation();
                selectedMemos.delete(memoId);
                updateBatchUI();
                renderMemos(allMemos);
            };
            barItems.appendChild(item);
        });
    } else {
        floatingBar.style.display = 'none';
    }
}

async function openMemo(memo) {
    try {
        const memoFolder = memo.folderName || currentFolder;

        // 跳转逻辑：如果点击的是非当前文件夹的日记，更新当前文件夹状态
        if (memoFolder !== currentFolder) {
            currentFolder = memoFolder;
            // 更新侧边栏 UI 选中状态
            document.querySelectorAll('.folder-item').forEach(el => {
                const span = el.querySelector('span');
                if (span && span.textContent === memoFolder) {
                    el.classList.add('active');
                } else {
                    el.classList.remove('active');
                }
            });
        }

        editorStatus.textContent = '正在加载内容...';
        editorOverlay.classList.add('active');
        editorTitleInput.value = memo.name;
        editorTextarea.value = '';
        editorPreview.innerHTML = '';

        const data = await apiFetch(`/note/${encodeURIComponent(memoFolder)}/${encodeURIComponent(memo.name)}`);

        currentMemo = {
            folder: memoFolder,
            file: memo.name,
            content: data.content
        };

        editorTextarea.value = data.content;
        renderPreview(data.content);
        editorStatus.textContent = `最后修改: ${new Date(memo.lastModified).toLocaleString()}`;
    } catch (error) {
        alert('读取日记失败: ' + error.message);
        editorOverlay.classList.remove('active');
    }
}

function renderPreview(content) {
    if (window.marked) {
        editorPreview.innerHTML = marked.parse(content);
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

    const newContent = editorTextarea.value;
    const saveBtn = document.getElementById('save-memo-btn');
    const originalText = saveBtn.textContent;

    try {
        saveBtn.disabled = true;
        saveBtn.textContent = '正在保存...';

        await apiFetch(`/note/${encodeURIComponent(currentMemo.folder)}/${encodeURIComponent(currentMemo.file)}`, {
            method: 'POST',
            body: JSON.stringify({ content: newContent })
        });

        currentMemo.content = newContent;
        editorStatus.textContent = '保存成功 ' + new Date().toLocaleTimeString();

        // 刷新列表预览
        await refreshMemoList();
    } catch (error) {
        alert('保存失败: ' + error.message);
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
    const content = newMemoContentInput.value.trim();

    if (!date || !maid || !content) {
        alert('请填写完整信息');
        return;
    }

    const submitBtn = document.getElementById('submit-new-memo-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = '正在发布...';

    try {
        const settings = await window.electronAPI.loadSettings();
        if (!settings?.vcpApiKey) throw new Error('API Key 未配置');

        // 构造 TOOL_REQUEST
        const toolRequest = `<<<[TOOL_REQUEST]>>>
maid:「始」${maid}「末」,
tool_name:「始」DailyNote「末」,
command:「始」create「末」,
Date:「始」${date}「末」,
Content:「始」${content}「末」
<<<[END_TOOL_REQUEST]>>>`;

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

        // 延迟刷新，给后端一点处理时间
        setTimeout(async () => {
            await loadFolders();
            if (currentFolder) await loadMemos(currentFolder);
        }, 1000);

    } catch (error) {
        alert('发布失败: ' + error.message);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '🚀 发布';
    }
}

async function searchMemos(term) {
    // 如果有正在进行的搜索，立即取消它
    if (searchAbortController) {
        searchAbortController.abort();
    }
    searchAbortController = new AbortController();

    try {
        memoGridEl.innerHTML = '<div style="padding: 20px;">搜索中...</div>';
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
        memoGridEl.innerHTML = `<div style="padding: 20px; color: var(--danger-color);">搜索失败: ${error.message}</div>`;
    } finally {
        // 如果当前 controller 还是自己，则清空
        if (searchAbortController && !searchAbortController.signal.aborted) {
            // 这里不直接置空，因为可能已经有新的搜索发起了
        }
    }
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

async function handleBatchMove(e) {
    const targetFolder = e.target.value;
    if (!targetFolder || selectedMemos.size === 0) return;

    const confirmed = await customConfirm(`确定要将选中的 ${selectedMemos.size} 项日记移动到 "${targetFolder}" 吗？`, '📦 批量移动确认');
    if (!confirmed) {
        e.target.value = ''; // 重置下拉框
        return;
    }

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
    } finally {
        e.target.value = ''; // 重置下拉框
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
        await window.electronAPI.saveMemoConfig({
            hiddenFolders: Array.from(hiddenFolders),
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
        listEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-secondary);">暂无隐藏的文件夹</div>';
    } else {
        hiddenFolders.forEach(folder => {
            const item = document.createElement('div');
            item.className = 'folder-item';
            item.style.justifyContent = 'space-between';
            item.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 18px; height: 18px;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                    <span>${folder}</span>
                </div>
                <button class="glass-btn" style="padding: 4px 10px; font-size: 0.8rem;">取消隐藏</button>
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

async function refreshMemoList() {
    const term = searchInput.value.trim();
    if (term) {
        await searchMemos(term);
    } else if (currentFolder) {
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
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// ========== 联想逻辑 & 神经图谱引擎 ==========

async function openAssociationConfig(memo, isAppend = false) {
    graphState.sourceMemo = memo;
    graphState.isAppend = isAppend;
    graphState.targetNodeId = isAppend ? memo.id : null;
    const modal = document.getElementById('assoc-config-modal');
    const tagCloud = document.getElementById('assoc-folder-tags');
    const searchInput = document.getElementById('assoc-folder-search');
    tagCloud.innerHTML = '';

    if (searchInput) searchInput.value = '';

    try {
        const data = await apiFetch('/folders');
        const folders = data.folders.filter(f => f !== 'MusicDiary' && !hiddenFolders.has(f));

        const folderTags = folders.map(folder => {
            const tag = document.createElement('div');
            tag.className = 'folder-tag';
            tag.textContent = folder;
            tag.onclick = () => {
                tag.classList.toggle('active');
            };
            tagCloud.appendChild(tag);
            return tag;
        });

        // 绑定搜索过滤
        if (searchInput) {
            searchInput.oninput = (e) => {
                const term = e.target.value.toLowerCase().trim();
                folderTags.forEach(tag => {
                    const visible = tag.textContent.toLowerCase().includes(term);
                    tag.style.display = visible ? 'block' : 'none';
                });
            };
        }

        modal.style.display = 'flex';
    } catch (e) {
        alert('加载文件夹列表失败: ' + e.message);
    }
}

async function startAssociation() {
    const k = parseInt(document.getElementById('input-assoc-k').value);
    const boost = parseFloat(document.getElementById('input-assoc-boost').value);
    let selectedTags = Array.from(document.querySelectorAll('.folder-tag.active')).map(t => t.textContent);
    
    // 保底逻辑：如果用户没有选择任何文件夹，则默认使用当前日记所在的文件夹
    if (selectedTags.length === 0 && graphState.sourceMemo) {
        const sourceFolder = graphState.sourceMemo.folderName || currentFolder;
        if (sourceFolder) {
            selectedTags = [sourceFolder];
            console.log(`[Association] No folders selected, falling back to source folder: ${sourceFolder}`);
        }
    }
    
    document.getElementById('assoc-config-modal').style.display = 'none';
    
    // 显示视图并初始化 Canvas
    const overlay = document.getElementById('neural-graph-overlay');
    overlay.style.display = 'flex';
    const canvas = document.getElementById('neural-canvas');
    const ctx = canvas.getContext('2d');
    
    const sourceTitle = graphState.sourceMemo.name;
    document.getElementById('graph-source-title').textContent = sourceTitle;
    document.getElementById('node-count-stat').textContent = '正在联想中...';
    
    // 恢复被误删的变量定义
    const sourceMemo = graphState.sourceMemo;
    const folder = (sourceMemo.folderName || (sourceMemo.path ? '' : currentFolder)).trim();
    const sourceFilePath = (sourceMemo.path || (folder ? `${folder}/${sourceMemo.name}` : sourceMemo.name)).trim().replace(/\\/g, '/');

    // 显示高大上的加载动画
    const loader = document.getElementById('neural-loading-overlay');
    const loaderText = document.getElementById('loader-source-name');
    if (loader) {
        loader.style.display = 'flex';
        loader.style.opacity = '1';
        if (loaderText) loaderText.textContent = `神经网络正在遍历 "${sourceMemo.name}" 的记忆星图`;
    }

    console.log('[Association] Request Path:', `'${sourceFilePath}'`);

    try {
        const payload = {
            sourceFilePath: sourceFilePath,
            k: k,
            range: selectedTags,
            tagBoost: boost
        };
        
        const data = await apiFetch('/associative-discovery', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        // 这里的延迟是为了让神经网络的“算力感”表现出来，营造深层溯源的精品感
        await new Promise(resolve => setTimeout(resolve, 800));
        
        if (loader) {
            loader.style.opacity = '0';
            setTimeout(() => { if (loader) loader.style.display = 'none'; }, 500);
        }

        if (data.warning) {
            console.warn(data.warning);
        }

        console.log('[Association] Results from backend:', data.results);

        // 构造图谱数据
        initGraphData(data.results, graphState.isAppend);
        
        if (!graphState.animationId) {
            startGraphEngine(canvas, ctx);
        }

    } catch (e) {
        if (loader) loader.style.display = 'none';
        console.error('[Association Error]', e);
        // 如果后端返回了 details，补充显示
        let msg = e.message;
        alert(`联想失败: ${msg}\n请求路径: [${sourceFilePath}]`);
        if (!graphState.isAppend) overlay.style.display = 'none';
    }
}

function initGraphData(results, isAppend = false) {
    const source = graphState.sourceMemo;
    let centerNode;

    if (!isAppend) {
        let path = (source.folderName || currentFolder) ? 
                   `${source.folderName || currentFolder}/${source.name}` : 
                   source.name;
        path = path.trim();

        centerNode = {
            id: 'SOURCE',
            path: path,
            name: source.name,
            folder: source.folderName || currentFolder,
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
            fx: 0, // 固定中心
            fy: 0,
            isSource: true,
            score: 1.0,
            chunks: [source.preview || '核心源节点内容加载中...'],
            tags: []
        };
        graphState.nodes = [centerNode];
        graphState.links = [];
        graphState.transform = { x: 0, y: 0, scale: 1 };
    } else {
        // 寻找图中现有的该节点作为父节点
        centerNode = graphState.nodes.find(n => n.id === graphState.targetNodeId);
        
        if (!centerNode) {
            // 路径兜底方案
            let currentPath = source.path || (
                (source.folderName || currentFolder) ? 
                `${source.folderName || currentFolder}/${source.name}` : 
                source.name
            );
            currentPath = currentPath.trim().replace(/\\/g, '/');
            centerNode = graphState.nodes.find(n => n.path === currentPath);
        }

        if (!centerNode) {
             // 降级处理: 如果没找到，退回到非追加模式
             console.warn('[Association] Target node not found, falling back to reset mode');
             return initGraphData(results, false);
        }
    }

    results.forEach((res, i) => {
        // 保持原始路径，仅修剪
        let resPath = res.path ? res.path.trim() : '';

        // 检查节点是否已存在
        let existingNode = graphState.nodes.find(n => n.path === resPath);
        
        if (!existingNode) {
            const angle = (i / results.length) * Math.PI * 2;
            const dist = 300 + Math.random() * 100;
            const newNode = {
                id: `node-${Date.now()}-${i}`,
                name: res.name,
                folder: resPath.includes('/') ? resPath.split('/')[0] : (resPath.includes('\\') ? resPath.split('\\')[0] : ''),
                path: resPath,
                score: res.score,
                chunks: res.chunks,
                tags: res.matchedTags,
                x: centerNode.x + Math.cos(angle) * dist,
                y: centerNode.y + Math.sin(angle) * dist,
                vx: 0,
                vy: 0
            };
            graphState.nodes.push(newNode);
            existingNode = newNode;
        }

        // 添加连线
        const alreadyLinked = graphState.links.find(l => 
            (l.source === centerNode && l.target === existingNode) ||
            (l.source === existingNode && l.target === centerNode)
        );

        if (!alreadyLinked) {
            graphState.links.push({
                source: centerNode,
                target: existingNode,
                score: res.score
            });
        }
    });

    document.getElementById('node-count-stat').textContent = `${graphState.nodes.length} 节点 / ${graphState.links.length} 连线`;
    document.getElementById('node-detail-panel').classList.add('hidden');
}

function startGraphEngine(canvas, ctx) {
    if (graphState.animationId) cancelAnimationFrame(graphState.animationId);

    // 设置 Canvas 大小
    const resize = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', resize);
    resize();

    // 交互逻辑
    canvas.onmousedown = (e) => {
        graphState.lastMousePos = { x: e.clientX, y: e.clientY };
        
        // 检查是否点击了节点
        const pos = getGraphCoords(e.clientX, e.clientY);
        const node = findNodeAt(pos.x, pos.y);
        
        if (node) {
            graphState.dragNode = node;
            graphState.isDragging = true;
            selectGraphNode(node);
        } else {
            graphState.isDragging = false;
        }
    };

    window.onmousemove = (e) => {
        const dx = e.clientX - graphState.lastMousePos.x;
        const dy = e.clientY - graphState.lastMousePos.y;
        
        if (graphState.isDragging && graphState.dragNode) {
            const worldPos = getGraphCoords(e.clientX, e.clientY);
            graphState.dragNode.fx = worldPos.x;
            graphState.dragNode.fy = worldPos.y;
        } else if (e.buttons === 1) {
            // 平移
            graphState.transform.x += dx;
            graphState.transform.y += dy;
        }

        // 悬停检测
        const pos = getGraphCoords(e.clientX, e.clientY);
        graphState.hoveredNode = findNodeAt(pos.x, pos.y);
        canvas.style.cursor = graphState.hoveredNode ? 'pointer' : (e.buttons === 1 ? 'grabbing' : 'grab');

        graphState.lastMousePos = { x: e.clientX, y: e.clientY };
    };

    window.onmouseup = () => {
        if (graphState.dragNode && !graphState.dragNode.isSource) {
            graphState.dragNode.fx = undefined;
            graphState.dragNode.fy = undefined;
        }
        graphState.dragNode = null;
        graphState.isDragging = false;
    };

    canvas.onwheel = (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        
        // 以鼠标为中心缩放
        const mouseX = e.clientX;
        const mouseY = e.clientY;
        
        const beforeX = (mouseX - graphState.transform.x) / graphState.transform.scale;
        const beforeY = (mouseY - graphState.transform.y) / graphState.transform.scale;
        
        graphState.transform.scale *= factor;
        graphState.transform.scale = Math.max(0.1, Math.min(5, graphState.transform.scale));

        const afterX = (mouseX - graphState.transform.x) / graphState.transform.scale;
        const afterY = (mouseY - graphState.transform.y) / graphState.transform.scale;

        graphState.transform.x += (afterX - beforeX) * graphState.transform.scale;
        graphState.transform.y += (afterY - beforeY) * graphState.transform.scale;
    };

    function update() {
        const strength = 0.5; // 连接强度
        
        // 1. 斥力 (所有节点之间)
        for (let i = 0; i < graphState.nodes.length; i++) {
            for (let j = i + 1; j < graphState.nodes.length; j++) {
                const n1 = graphState.nodes[i];
                const n2 = graphState.nodes[j];
                const dx = n2.x - n1.x;
                const dy = n2.y - n1.y;
                const distSq = dx*dx + dy*dy || 1;
                const force = 12000 / distSq; // 增大斥力防止重叠
                
                const fx = (dx / Math.sqrt(distSq)) * force;
                const fy = (dy / Math.sqrt(distSq)) * force;
                
                n1.vx -= fx; n1.vy -= fy;
                n2.vx += fx; n2.vy += fy;
            }
        }

        // 2. 引力 (连线)
        graphState.links.forEach(link => {
            const s = link.source;
            const t = link.target;
            const dx = t.x - s.x;
            const dy = t.y - s.y;
            const dist = Math.sqrt(dx*dx + dy*dy) || 1;
            
            // 目标距离取决于得分
            const targetDist = 200 + (1 - link.score) * 400;
            const force = (dist - targetDist) * strength * 0.1;
            
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            
            s.vx += fx; s.vy += fy;
            t.vx -= fx; t.vy -= fy;
        });

        // 3. 更新位置
        graphState.nodes.forEach(node => {
            if (node.fx !== undefined) {
                node.x = node.fx;
                node.y = node.fy;
                node.vx = 0;
                node.vy = 0;
            } else {
                node.vx *= 0.9; // 摩擦力
                node.vy *= 0.9;
                node.x += node.vx;
                node.y += node.vy;
            }
        });
    }

    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        ctx.save();
        ctx.translate(canvas.width / 2 + graphState.transform.x, canvas.height / 2 + graphState.transform.y);
        ctx.scale(graphState.transform.scale, graphState.transform.scale);

        // 绘制连线
        graphState.links.forEach(link => {
            const grad = ctx.createLinearGradient(link.source.x, link.source.y, link.target.x, link.target.y);
            const intensity = 0.1 + link.score * 0.8;
            grad.addColorStop(0, `rgba(74, 144, 226, ${intensity * 0.5})`);
            grad.addColorStop(1, `rgba(74, 144, 226, ${intensity})`);
            
            ctx.beginPath();
            ctx.moveTo(link.source.x, link.source.y);
            ctx.lineTo(link.target.x, link.target.y);
            ctx.lineWidth = 1 + link.score * 3;
            ctx.strokeStyle = grad;
            ctx.stroke();

            // 绘制流动光点 (脉冲)
            const time = Date.now() / 1000;
            const progress = (time % 2) / 2;
            const lx = link.source.x + (link.target.x - link.source.x) * progress;
            const ly = link.source.y + (link.target.y - link.source.y) * progress;
            
            ctx.beginPath();
            ctx.arc(lx, ly, 2, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.shadowBlur = 10;
            ctx.shadowColor = '#4a90e2';
            ctx.fill();
        });

        // 绘制节点
        graphState.nodes.forEach(node => {
            const isHovered = graphState.hoveredNode === node;
            const isSelected = graphState.selectedNode === node;
            
            // 计算卡片尺寸
            const width = node.isSource ? 220 : 200;
            const height = node.isSource ? 110 : 100;
            const x = node.x - width / 2;
            const y = node.y - height / 2;
            const radius = 10;

            // 1. 外部发光
            if (isHovered || isSelected || node.isSource) {
                ctx.beginPath();
                ctx.roundRect(x - 5, y - 5, width + 10, height + 10, radius + 5);
                ctx.fillStyle = node.isSource ? 'rgba(255, 215, 0, 0.15)' : 'rgba(74, 144, 226, 0.2)';
                ctx.fill();
            }

            // 2. 玻璃背景
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(x, y, width, height, radius);
            } else {
                // 回退方案: 绘制圆角矩形
                ctx.moveTo(x + radius, y);
                ctx.lineTo(x + width - radius, y);
                ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
                ctx.lineTo(x + width, y + height - radius);
                ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
                ctx.lineTo(x + radius, y + height);
                ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
                ctx.lineTo(x, y + radius);
                ctx.quadraticCurveTo(x, y, x + radius, y);
                ctx.closePath();
            }
            ctx.fillStyle = isSelected ? 'rgba(255, 255, 255, 0.15)' : 'rgba(20, 22, 25, 0.85)';
            ctx.shadowBlur = (isHovered || isSelected) ? 20 : 0;
            ctx.shadowColor = node.isSource ? '#ffd700' : '#4a90e2';
            ctx.fill();
            ctx.shadowBlur = 0;

            // 3. 边框
            ctx.lineWidth = (isSelected || node.isSource) ? 2 : 1;
            ctx.strokeStyle = node.isSource ? '#ffd700' : (isSelected ? '#fff' : 'rgba(255,255,255,0.1)');
            ctx.stroke();

            // 4. 文字内容
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            
            // 标题
            ctx.fillStyle = node.isSource ? '#ffd700' : '#fff';
            ctx.font = `bold ${node.isSource ? '13px' : '11px'} 'Segoe UI', system-ui`;
            const title = node.name.length > 18 ? node.name.slice(0, 16) + '...' : node.name;
            ctx.fillText(title, x + 12, y + 12);

            // 摘要 (从 chunks 中取一小段)
            ctx.fillStyle = node.isSource ? 'rgba(255,215,0,0.7)' : 'rgba(255,255,255,0.6)';
            ctx.font = "9px 'Segoe UI', system-ui";
            const summary = (node.chunks && node.chunks[0])
                ? node.chunks[0].slice(0, 160).replace(/\n/g, ' ') + '...'
                : (node.isSource ? '核心源节点内容加载中...' : '暂无摘要内容...');
            
            // 简单的两行自动换行
            const words = summary.split('');
            let line = '';
            let lineCount = 0;
            let textY = y + 32;
            for (let n = 0; n < words.length; n++) {
                let testLine = line + words[n];
                let metrics = ctx.measureText(testLine);
                if (metrics.width > width - 24 && n > 0) {
                    ctx.fillText(line, x + 12, textY);
                    line = words[n];
                    textY += 13;
                    lineCount++;
                    if (lineCount >= 4) break;
                } else {
                    line = testLine;
                }
            }
            if (lineCount < 4) ctx.fillText(line, x + 12, textY);

            if (node.isSource) {
                ctx.fillStyle = 'rgba(255,215,0,0.5)';
                ctx.font = "italic 8px 'Segoe UI', system-ui";
                ctx.fillText(`[核心源] 文件夹: ${node.folder || '根目录'}`, x + 12, y + height - 12);
            }

            // 5. 分数标签 (右下角)
            if (!node.isSource) {
                ctx.fillStyle = 'rgba(74, 144, 226, 0.8)';
                ctx.font = "bold 9px 'Segoe UI'";
                ctx.textAlign = 'right';
                ctx.fillText(node.score.toFixed(2), x + width - 10, y + height - 12);
            }
        });

        ctx.restore();
        
        update();
        graphState.animationId = requestAnimationFrame(draw);
    }

    draw();
}

function getGraphCoords(clientX, clientY) {
    return {
        x: (clientX - (window.innerWidth / 2 + graphState.transform.x)) / graphState.transform.scale,
        y: (clientY - (window.innerHeight / 2 + graphState.transform.y)) / graphState.transform.scale
    };
}

function findNodeAt(x, y) {
    return graphState.nodes.find(node => {
        const width = node.isSource ? 220 : 200;
        const height = node.isSource ? 110 : 100;
        return (x >= node.x - width / 2 && x <= node.x + width / 2 &&
                y >= node.y - height / 2 && y <= node.y + height / 2);
    });
}

async function selectGraphNode(node) {
    graphState.selectedNode = node;
    
    document.getElementById('detail-title').textContent = node.name;
    document.getElementById('detail-path').textContent = node.path;
    document.getElementById('detail-score').textContent = node.isSource ? "1.000 (源)" : node.score.toFixed(3);
    
    const tagList = document.getElementById('detail-tags');
    tagList.innerHTML = '';
    if (node.tags && node.tags.length > 0) {
        const maxVisibleTags = 15;
        const showAll = node.tags.length <= maxVisibleTags;
        
        node.tags.forEach((t, index) => {
            const span = document.createElement('span');
            span.className = 'tag-item';
            span.textContent = t;
            if (!showAll && index >= maxVisibleTags) {
                span.style.display = 'none';
                span.classList.add('hidden-tag');
            }
            tagList.appendChild(span);
        });

        if (!showAll) {
            const moreBtn = document.createElement('span');
            moreBtn.className = 'tag-item more-tags-btn';
            moreBtn.style.cursor = 'pointer';
            moreBtn.style.background = 'var(--accent-color)';
            moreBtn.style.color = '#fff';
            moreBtn.textContent = `+ 展开更多 (${node.tags.length - maxVisibleTags})`;
            moreBtn.onclick = () => {
                tagList.querySelectorAll('.hidden-tag').forEach(el => el.style.display = 'inline-block');
                moreBtn.style.display = 'none';
            };
            tagList.appendChild(moreBtn);
        }
    } else {
        tagList.innerHTML = `<span class="small-text">${node.isSource ? '核心源节点' : '无标签匹配'}</span>`;
    }

    const chunkList = document.getElementById('detail-chunks');
    chunkList.innerHTML = '<div class="loading-spinner">加载中...</div>';
    
    document.getElementById('node-detail-panel').classList.remove('hidden');

    try {
        // 如果是源节点或者没有 chunks，尝试加载完整内容
        if (node.isSource || !node.chunks || node.chunks.length === 0 || (node.chunks.length === 1 && node.chunks[0].endsWith('...'))) {
            const folder = node.folder || '';
            const data = await apiFetch(`/note/${encodeURIComponent(folder)}/${encodeURIComponent(node.name)}`);
            node.chunks = [data.content]; // 将完整内容存入 chunks 以便预览
        }

        chunkList.innerHTML = '';
        if (node.chunks && node.chunks.length > 0) {
            node.chunks.forEach(c => {
                const div = document.createElement('div');
                div.className = 'chunk-item';
                // 如果是 Markdown，可以考虑渲染，但这里先保持纯文本以符合原 UI
                div.textContent = c;
                chunkList.appendChild(div);
            });
        } else {
            chunkList.innerHTML = '<span class="small-text">无关联文本片段</span>';
        }
    } catch (e) {
        console.error('加载节点详情失败:', e);
        chunkList.innerHTML = `<span class="small-text" style="color:var(--danger-color)">加载失败: ${e.message}</span>`;
    }
}

function closeNeuralGraph() {
    document.getElementById('neural-graph-overlay').style.display = 'none';
    if (graphState.animationId) cancelAnimationFrame(graphState.animationId);
    graphState.animationId = null;
}