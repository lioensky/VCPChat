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

    // 初始化工作台
    if (window.DiaryWorkbench) {
        window.DiaryWorkbench.init();
    }
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
    document.getElementById('batch-workbench-btn').onclick = () => {
        const selected = allMemos.filter(m => {
            const memoId = `${m.folderName || currentFolder}:::${m.name}`;
            return selectedMemos.has(memoId);
        });
        if (window.DiaryWorkbench) {
            window.DiaryWorkbench.open(selected);
        }
    };

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
        allMemos = memos; // 更新全局变量，修复批量管理模式显示为空的问题
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
