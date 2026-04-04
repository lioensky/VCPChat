/**
 * Memomodules/memo-workbench.js
 * 日记工作台逻辑模块 - 负责多日记整合与参考阅读
 */

const memoWorkbenchApi = window.utilityAPI || window.electronAPI;

function escapeHtmlWb(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

const DiaryWorkbench = {
    selectedMemos: [], // 存储选中的日记对象 { name, folder, preview, lastModified, content? }
    
    // 初始化工作台
    init() {
        this.overlay = document.getElementById('workbench-overlay');
        this.referenceGrid = document.getElementById('workbench-reference-grid');
        this.countTag = document.getElementById('workbench-count-tag');
        
        // 编辑器元素
        this.newDateInput = document.getElementById('workbench-new-date');
        this.newFolderInput = document.getElementById('workbench-new-folder');
        this.newContentInput = document.getElementById('workbench-new-content');
        
        // 绑定关闭按钮
        const closeBtn = document.getElementById('close-workbench-btn');
        if (closeBtn) closeBtn.onclick = () => this.close();
        
        // 绑定发布按钮
        const submitBtn = document.getElementById('workbench-submit-btn');
        if (submitBtn) submitBtn.onclick = () => this.handleCreateIntegratedMemo();
        
        console.log('[Workbench] Module initialized');
    },

    // 打开工作台并加载日记 (覆盖模式)
    async open(memos) {
        if (!memos || memos.length === 0) {
            alert('请先选择至少一篇日记');
            return;
        }
        this.selectedMemos = [];
        await this.addMemos(memos);
        this.overlay.style.display = 'flex';
    },

    // 追加日记到工作台 (不重复添加)
    async addMemos(memos) {
        if (!memos || memos.length === 0) return;

        const newMemos = memos.map(m => ({
            name: m.name,
            folder: m.folderName || m.folder || currentFolder,
            preview: m.preview || (m.chunks ? m.chunks[0] : ''),
            lastModified: m.lastModified || Date.now()
        }));

        newMemos.forEach(newMemo => {
            const exists = this.selectedMemos.some(m => m.name === newMemo.name && m.folder === newMemo.folder);
            if (!exists) {
                this.selectedMemos.push(newMemo);
            }
        });

        // 初始化新建日记的默认值 (仅在工作台未打开时初始化)
        if (this.overlay && this.overlay.style.display !== 'flex') {
            const now = new Date();
            this.newDateInput.value = now.toISOString().split('T')[0];
            
            if (forumConfig) {
                this.newFolderInput.value = forumConfig.replyUsername || forumConfig.username || '整合记忆';
            } else {
                this.newFolderInput.value = '整合记忆';
            }
            this.newContentInput.value = '';
        }

        if (this.overlay && (this.overlay.style.display === 'flex' || this.selectedMemos.length > 0)) {
            await this.renderReferences();
        }
    },

    // 关闭工作台
    close() {
        this.overlay.style.display = 'none';
    },

    // 渲染参考日记卡片
    async renderReferences() {
        this.referenceGrid.innerHTML = '';
        this.countTag.textContent = `共引用 ${this.selectedMemos.length} 篇日记`;

        for (const memo of this.selectedMemos) {
            const card = document.createElement('div');
            card.className = 'workbench-memo-card glass';
            
            const dateStr = new Date(memo.lastModified).toLocaleString();
            
            card.innerHTML = `
                <div class="card-header">
                    <span class="folder-tag">📁 ${escapeHtmlWb(memo.folder)}</span>
                    <div class="card-actions">
                        <button class="icon-btn edit-ref-btn" title="编辑此日记">✏️</button>
                        <button class="icon-btn remove-ref-btn" title="从工作台移除">×</button>
                    </div>
                </div>
                <div class="card-body">
                    <h4>${escapeHtmlWb(memo.name)}</h4>
                    <p class="preview">${escapeHtmlWb(memo.preview || '加载中...')}</p>
                </div>
                <div class="card-footer">
                    <span>📅 ${dateStr}</span>
                </div>
            `;

            // 移除引用
            card.querySelector('.remove-ref-btn').onclick = (e) => {
                e.stopPropagation();
                this.selectedMemos = this.selectedMemos.filter(m => !(m.name === memo.name && m.folder === memo.folder));
                this.renderReferences();
            };

            // 编辑引用（调用主程序的 openMemo）
            card.querySelector('.edit-ref-btn').onclick = (e) => {
                e.stopPropagation();
                if (typeof openMemo === 'function') {
                    openMemo({ name: memo.name, folderName: memo.folder, lastModified: memo.lastModified });
                }
            };

            // 点击卡片查看详情（不关闭工作台，直接打开编辑器）
            card.onclick = () => {
                if (typeof openMemo === 'function') {
                    openMemo({ name: memo.name, folderName: memo.folder, lastModified: memo.lastModified });
                }
            };

            this.referenceGrid.appendChild(card);
        }
    },

    // 发布整合后的新日记
    async handleCreateIntegratedMemo() {
        const date = this.newDateInput.value;
        const folder = this.newFolderInput.value.trim();
        const content = this.newContentInput.value.trim();

        if (!date || !folder || !content) {
            alert('请填写完整信息');
            return;
        }

        const submitBtn = document.getElementById('workbench-submit-btn');
        const originalText = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = '正在发布...';

        try {
            const settings = await memoWorkbenchApi.loadSettings();
            if (!settings?.vcpApiKey) throw new Error('API Key 未配置');

            // 构造 TOOL_REQUEST
            const toolRequest = `<<<[TOOL_REQUEST]>>>
maid:「始」${folder}「末」,
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
            alert('整合日记发布成功！');
            this.close();
            
            // 刷新主界面列表
            if (typeof loadFolders === 'function') {
                setTimeout(async () => {
                    await loadFolders();
                    if (currentFolder) await loadMemos(currentFolder);
                }, 1000);
            }

        } catch (error) {
            alert('发布失败: ' + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    }
};

// 暴露给全局
window.DiaryWorkbench = DiaryWorkbench;
