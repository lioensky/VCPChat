// Tavernmodules/tavern-manager.js
// 高级回复 (VCPChatTarven) - 渲染端管理器
// 提供两个 UI:
//   1. 高级回复浮窗（依附在发送按钮附近）：开关每条规则
//   2. 规则管理模态窗：增删改查规则

(function () {
    'use strict';

    const TYPE_LABELS = {
        system_suffix: '系统提示词',
        user_suffix: '用户消息',
        context_inject: '上下文注入'
    };

    const SCOPE_LABELS = {
        global: '全局',
        agent: '单聊',
        group: '群聊'
    };

    function getApi() {
        return window.chatAPI || window.electronAPI;
    }

    function escapeHtml(s) {
        if (s == null) return '';
        return String(s).replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[ch]);
    }

    function makeIconBtn(svgPath, title) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tavern-icon-btn';
        btn.title = title || '';
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgPath}</svg>`;
        return btn;
    }

    const TavernManager = {
        store: { version: 1, rules: [] },
        popoverEl: null,
        modalEl: null,
        selectedRuleId: null,
        _outsideClickHandler: null,

        async init() {
            await this.loadStore();
            // 监听全局点击关闭浮窗
            this._outsideClickHandler = (e) => {
                if (!this.popoverEl) return;
                if (this.popoverEl.contains(e.target)) return;
                // 点击发送按钮自身（右键触发）不算外部点击 - 由 contextmenu 处理
                this.hidePopover();
            };
            console.log('[TavernManager] Initialized.');
        },

        async loadStore() {
            const api = getApi();
            if (!api?.tavernGetRules) {
                console.warn('[TavernManager] tavernGetRules API not available.');
                this.store = { version: 1, rules: [] };
                return;
            }
            try {
                const result = await api.tavernGetRules();
                if (result && result.success && result.store) {
                    this.store = result.store;
                } else {
                    this.store = { version: 1, rules: [] };
                }
            } catch (error) {
                console.error('[TavernManager] Failed to load tavern rules:', error);
                this.store = { version: 1, rules: [] };
            }
        },

        async saveStore() {
            const api = getApi();
            if (!api?.tavernSaveRules) return { success: false, error: 'API unavailable' };
            try {
                const result = await api.tavernSaveRules(this.store);
                if (result && result.success && result.store) {
                    this.store = result.store;
                }
                return result;
            } catch (error) {
                console.error('[TavernManager] Failed to save tavern rules:', error);
                return { success: false, error: error.message };
            }
        },

        // ====================== Popover ======================
        async togglePopover(anchorEl) {
            if (this.popoverEl) {
                this.hidePopover();
                return;
            }
            await this.loadStore();
            this.showPopover(anchorEl);
        },

        showPopover(anchorEl) {
            this.hidePopover();
            const popover = document.createElement('div');
            popover.className = 'tavern-popover';
            popover.innerHTML = `
                <div class="tavern-popover-header">
                    <span class="tavern-popover-title">高级回复</span>
                    <div class="tavern-popover-actions">
                        <button type="button" class="tavern-icon-btn" data-action="manage" title="管理规则">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                        </button>
                        <button type="button" class="tavern-icon-btn" data-action="close" title="关闭">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>
                </div>
                <div class="tavern-popover-body"></div>
            `;
            document.body.appendChild(popover);
            this.popoverEl = popover;

            this._renderPopoverList();

            // 定位：尽量出现在按钮上方
            this._positionPopover(anchorEl);

            // 事件
            popover.querySelector('[data-action="close"]').addEventListener('click', () => this.hidePopover());
            popover.querySelector('[data-action="manage"]').addEventListener('click', () => {
                this.hidePopover();
                this.openManagerModal();
            });

            // 延迟挂载外部点击监听，避免立刻被自己触发
            setTimeout(() => {
                document.addEventListener('mousedown', this._outsideClickHandler, true);
            }, 0);
        },

        hidePopover() {
            if (this.popoverEl) {
                this.popoverEl.remove();
                this.popoverEl = null;
            }
            document.removeEventListener('mousedown', this._outsideClickHandler, true);
        },

        _positionPopover(anchorEl) {
            if (!this.popoverEl) return;
            const popover = this.popoverEl;
            const margin = 8;
            const rect = anchorEl ? anchorEl.getBoundingClientRect() : null;
            if (rect) {
                // 优先在按钮上方
                const popH = popover.offsetHeight || 320;
                const popW = popover.offsetWidth || 360;
                let top = rect.top - popH - margin;
                if (top < margin) {
                    top = rect.bottom + margin;
                }
                let left = rect.right - popW;
                if (left < margin) left = margin;
                if (left + popW > window.innerWidth - margin) {
                    left = window.innerWidth - popW - margin;
                }
                popover.style.top = `${top}px`;
                popover.style.left = `${left}px`;
            } else {
                popover.style.right = '20px';
                popover.style.bottom = '80px';
            }
        },

        _renderPopoverList() {
            if (!this.popoverEl) return;
            const body = this.popoverEl.querySelector('.tavern-popover-body');
            const rules = this.store.rules || [];
            if (rules.length === 0) {
                body.innerHTML = `
                    <div class="tavern-popover-empty">
                        <div>还没有任何规则</div>
                        <button type="button" data-action="open-manage">添加第一条规则</button>
                    </div>
                `;
                const openBtn = body.querySelector('[data-action="open-manage"]');
                if (openBtn) openBtn.addEventListener('click', () => {
                    this.hidePopover();
                    this.openManagerModal();
                });
                return;
            }
            body.innerHTML = '';
            rules.forEach(rule => {
                // 仅捕获 ID;saveStore 后 this.store 会被整体替换,
                // 闭包里直接持有 rule 引用会指向"游魂对象",改了也不会被持久化
                const ruleId = rule.id;
                const row = document.createElement('div');
                row.className = 'tavern-rule-row';
                const typeTagClass = rule.type === 'system_suffix' ? 'tag-system'
                                    : rule.type === 'user_suffix' ? 'tag-user' : 'tag-context';
                const scopeTagClass = `tag-scope-${rule.scope || 'global'}`;
                row.innerHTML = `
                    <div class="tavern-rule-info">
                        <div class="tavern-rule-name">${escapeHtml(rule.name || '未命名规则')}</div>
                        <div class="tavern-rule-meta">
                            <span class="tavern-rule-tag ${typeTagClass}">${TYPE_LABELS[rule.type] || rule.type}</span>
                            <span class="tavern-rule-tag ${scopeTagClass}">${SCOPE_LABELS[rule.scope || 'global']}</span>
                            ${rule.type === 'context_inject' ? `<span class="tavern-rule-tag">${rule.role === 'assistant' ? 'AI' : '用户'} · 深度 ${rule.depth || 0}</span>` : ''}
                        </div>
                    </div>
                    <label class="tavern-switch">
                        <input type="checkbox" ${rule.enabled !== false ? 'checked' : ''}>
                        <span class="tavern-slider"></span>
                    </label>
                `;
                const checkbox = row.querySelector('input[type="checkbox"]');
                checkbox.addEventListener('change', async () => {
                    // 防止快速连点引发的并发保存
                    if (checkbox.disabled) return;
                    checkbox.disabled = true;
                    const desired = checkbox.checked;
                    try {
                        const latestRule = (this.store.rules || []).find(r => r.id === ruleId);
                        if (!latestRule) {
                            // 规则已被外部删除,直接刷新一次列表
                            this._renderPopoverList();
                            return;
                        }
                        latestRule.enabled = desired;
                        const result = await this.saveStore();
                        if (!result || !result.success) {
                            // 保存失败时把开关回滚
                            checkbox.checked = !desired;
                            if (window.uiHelperFunctions?.showToastNotification) {
                                window.uiHelperFunctions.showToastNotification(
                                    `保存失败: ${result?.error || '未知错误'}`,
                                    'error'
                                );
                            }
                        }
                    } catch (err) {
                        checkbox.checked = !desired;
                        console.error('[TavernManager] toggle save failed:', err);
                    } finally {
                        checkbox.disabled = false;
                    }
                });
                body.appendChild(row);
            });
        },

        // ====================== Manager Modal ======================
        async openManagerModal() {
            await this.loadStore();
            this.selectedRuleId = (this.store.rules && this.store.rules[0]) ? this.store.rules[0].id : null;
            this._buildManagerModal();
        },

        _buildManagerModal() {
            // 移除旧的
            const existing = document.getElementById('tavernManagerModal');
            if (existing) existing.remove();

            const modal = document.createElement('div');
            modal.className = 'modal active';
            modal.id = 'tavernManagerModal';
            modal.innerHTML = `
                <div class="modal-content tavern-modal-content">
                    <span class="close-button" data-action="close">×</span>
                    <h2>高级回复 - 规则管理</h2>
                    <div class="tavern-manager-layout">
                        <div class="tavern-manager-list-panel">
                            <div class="tavern-manager-list-toolbar">
                                <select data-role="new-type">
                                    <option value="system_suffix">系统提示词注入</option>
                                    <option value="user_suffix">用户消息注入</option>
                                    <option value="context_inject">上下文注入</option>
                                </select>
                                <button type="button" data-action="add">新建</button>
                            </div>
                            <div class="tavern-manager-list" data-role="list"></div>
                        </div>
                        <div class="tavern-manager-edit-panel" data-role="edit"></div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            this.modalEl = modal;

            modal.querySelector('[data-action="close"]').addEventListener('click', () => this.closeManagerModal());
            modal.addEventListener('click', (e) => {
                if (e.target === modal) this.closeManagerModal();
            });
            modal.querySelector('[data-action="add"]').addEventListener('click', () => {
                const select = modal.querySelector('[data-role="new-type"]');
                this._addNewRule(select.value);
            });

            this._renderManagerList();
            this._renderManagerEditPanel();
        },

        closeManagerModal() {
            if (this.sortableInstance) {
                this.sortableInstance.destroy();
                this.sortableInstance = null;
            }
            if (this.modalEl) {
                this.modalEl.remove();
                this.modalEl = null;
            }
        },

        _renderManagerList() {
            if (!this.modalEl) return;
            const list = this.modalEl.querySelector('[data-role="list"]');
            
            // 销毁旧的 Sortable 实例以防内存泄漏和事件重复绑定
            if (this.sortableInstance) {
                this.sortableInstance.destroy();
                this.sortableInstance = null;
            }

            const rules = this.store.rules || [];
            list.innerHTML = '';
            if (rules.length === 0) {
                list.innerHTML = `<div style="padding:14px;color:var(--secondary-text);text-align:center;font-size:12px;">尚无规则</div>`;
                return;
            }
            rules.forEach(rule => {
                const item = document.createElement('div');
                item.className = 'tavern-manager-list-item';
                item.setAttribute('data-id', rule.id);
                if (rule.id === this.selectedRuleId) item.classList.add('selected');
                if (rule.enabled === false) item.classList.add('disabled');
                const typeTagClass = rule.type === 'system_suffix' ? 'tag-system'
                                    : rule.type === 'user_suffix' ? 'tag-user' : 'tag-context';
                item.innerHTML = `
                    <span class="tavern-rule-tag ${typeTagClass}" style="flex-shrink:0;">${TYPE_LABELS[rule.type] || rule.type}</span>
                    <span class="item-name">${escapeHtml(rule.name || '未命名规则')}</span>
                    <div class="tavern-drag-handle" title="长按整行或拖拽手柄排序">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="9" cy="12" r="1"></circle>
                            <circle cx="9" cy="5" r="1"></circle>
                            <circle cx="9" cy="19" r="1"></circle>
                            <circle cx="15" cy="12" r="1"></circle>
                            <circle cx="15" cy="5" r="1"></circle>
                            <circle cx="15" cy="19" r="1"></circle>
                        </svg>
                    </div>
                `;
                item.addEventListener('click', (e) => {
                    // 如果点击的是拖拽手柄，不触发选中
                    if (e.target.closest('.tavern-drag-handle')) return;
                    this.selectedRuleId = rule.id;
                    this._renderManagerList();
                    this._renderManagerEditPanel();
                });
                list.appendChild(item);
            });

            // 初始化 Sortable
            if (window.Sortable) {
                this.sortableInstance = window.Sortable.create(list, {
                    delay: 300, // 长按 300ms 触发拖拽
                    delayOnTouchOnly: false, // 桌面端也支持长按
                    touchStartThreshold: 5,
                    animation: 150,
                    ghostClass: 'tavern-sortable-ghost',
                    chosenClass: 'tavern-sortable-chosen',
                    dragClass: 'tavern-sortable-drag',
                    fallbackTolerance: 3,
                    onEnd: async () => {
                        const items = list.querySelectorAll('.tavern-manager-list-item');
                        const newOrderIds = Array.from(items).map(el => el.getAttribute('data-id'));
                        
                        const ruleMap = new Map(this.store.rules.map(r => [r.id, r]));
                        const sortedRules = [];
                        newOrderIds.forEach(id => {
                            if (ruleMap.has(id)) {
                                sortedRules.push(ruleMap.get(id));
                            }
                        });
                        
                        this.store.rules.forEach(r => {
                            if (!newOrderIds.includes(r.id)) {
                                sortedRules.push(r);
                            }
                        });
                        
                        this.store.rules = sortedRules;
                        
                        const result = await this.saveStore();
                        if (result && result.success) {
                            if (window.uiHelperFunctions?.showToastNotification) {
                                window.uiHelperFunctions.showToastNotification('顺序已更新并保存', 'success');
                            }
                            this._renderManagerList();
                        } else {
                            if (window.uiHelperFunctions?.showToastNotification) {
                                window.uiHelperFunctions.showToastNotification(`保存顺序失败: ${result?.error || '未知错误'}`, 'error');
                            }
                            this._renderManagerList();
                        }
                    }
                });
            } else {
                console.warn('[TavernManager] Sortable.js is not loaded.');
            }
        },

        _renderManagerEditPanel() {
            if (!this.modalEl) return;
            const panel = this.modalEl.querySelector('[data-role="edit"]');
            const rule = (this.store.rules || []).find(r => r.id === this.selectedRuleId);
            if (!rule) {
                panel.innerHTML = `<div class="tavern-manager-edit-empty">在左侧选择或新建一条规则</div>`;
                return;
            }
            const isContext = rule.type === 'context_inject';
            const wrapEnabled = rule.wrap !== false;
            panel.innerHTML = `
                <div class="tavern-form-row">
                    <label>规则名称</label>
                    <input type="text" data-field="name" value="${escapeHtml(rule.name || '')}">
                </div>
                <div class="tavern-form-row-inline">
                    <div>
                        <label>规则类型</label>
                        <select data-field="type">
                            <option value="system_suffix" ${rule.type === 'system_suffix' ? 'selected' : ''}>系统提示词尾部</option>
                            <option value="user_suffix" ${rule.type === 'user_suffix' ? 'selected' : ''}>用户消息尾部</option>
                            <option value="context_inject" ${rule.type === 'context_inject' ? 'selected' : ''}>上下文注入</option>
                        </select>
                    </div>
                    <div>
                        <label>作用范围</label>
                        <select data-field="scope">
                            <option value="global" ${rule.scope === 'global' ? 'selected' : ''}>全局（单聊+群聊）</option>
                            <option value="agent"  ${rule.scope === 'agent' ? 'selected' : ''}>仅单聊</option>
                            <option value="group"  ${rule.scope === 'group' ? 'selected' : ''}>仅群聊</option>
                        </select>
                    </div>
                    <div class="tavern-form-toggle-cell">
                        <label>启用</label>
                        <label class="tavern-switch tavern-switch-large">
                            <input type="checkbox" data-field="enabled" ${rule.enabled !== false ? 'checked' : ''}>
                            <span class="tavern-slider"></span>
                        </label>
                    </div>
                </div>
                ${isContext ? `
                <div class="tavern-form-row-inline">
                    <div>
                        <label>注入角色</label>
                        <select data-field="role">
                            <option value="user"      ${rule.role === 'user' ? 'selected' : ''}>用户 (user)</option>
                            <option value="assistant" ${rule.role === 'assistant' ? 'selected' : ''}>AI (assistant)</option>
                        </select>
                    </div>
                    <div>
                        <label>深度</label>
                        <input type="number" data-field="depth" min="0" step="1" value="${Number(rule.depth) || 0}">
                        <div class="tavern-help-text">0 = 插入在最后一条消息之后；N = 倒数第 N+1 条之前</div>
                    </div>
                </div>
                ` : ''}
                <div class="tavern-form-row tavern-form-toggle-row">
                    <div class="tavern-form-toggle-line">
                        <div class="tavern-form-toggle-info">
                            <div class="tavern-form-toggle-title">使用 VCPChat 包裹标记</div>
                            <div class="tavern-help-text">关闭后将进行裸注入，不再添加 [本信息由VCPChat客户端注入] / [临时注入结束] 包裹</div>
                        </div>
                        <label class="tavern-switch tavern-switch-large">
                            <input type="checkbox" data-field="wrap" ${wrapEnabled ? 'checked' : ''}>
                            <span class="tavern-slider"></span>
                        </label>
                    </div>
                </div>
                <div class="tavern-form-row">
                    <label>注入内容</label>
                    <textarea data-field="content" placeholder="${wrapEnabled ? '将以 [本信息由VCPChat客户端注入] ... [临时注入结束] 包裹后注入' : '裸注入：将原样发送给模型'}">${escapeHtml(rule.content || '')}</textarea>
                </div>
                <div class="tavern-edit-actions">
                    <button type="button" class="save-button" data-action="save">保存</button>
                    <button type="button" class="secondary-button" data-action="cancel">取消</button>
                    <button type="button" class="danger-button" data-action="delete">删除</button>
                </div>
            `;

            panel.querySelector('[data-action="save"]').addEventListener('click', async () => {
                await this._saveCurrentEdit();
            });
            panel.querySelector('[data-action="cancel"]').addEventListener('click', () => {
                this._renderManagerEditPanel();
            });
            panel.querySelector('[data-action="delete"]').addEventListener('click', async () => {
                await this._deleteCurrentRule();
            });
        },

        _addNewRule(type) {
            const engine = window.TavernRulesEngine;
            const newRule = engine
                ? engine.createDefaultRule(type)
                : {
                    id: 'rule_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                    name: '新规则',
                    type: type || 'system_suffix',
                    enabled: true,
                    content: '',
                    scope: 'global',
                    ...(type === 'context_inject' ? { role: 'user', depth: 0 } : {})
                };
            if (!Array.isArray(this.store.rules)) this.store.rules = [];
            this.store.rules.push(newRule);
            this.selectedRuleId = newRule.id;
            this.saveStore().then(() => {
                this._renderManagerList();
                this._renderManagerEditPanel();
            });
        },

        async _saveCurrentEdit() {
            if (!this.modalEl) return;
            const rule = (this.store.rules || []).find(r => r.id === this.selectedRuleId);
            if (!rule) return;
            const panel = this.modalEl.querySelector('[data-role="edit"]');
            const get = (field) => panel.querySelector(`[data-field="${field}"]`);

            const newType = get('type').value;
            const switchedToContext = newType === 'context_inject' && rule.type !== 'context_inject';
            const switchedFromContext = rule.type === 'context_inject' && newType !== 'context_inject';

            rule.name = (get('name').value || '').trim() || '未命名规则';
            rule.type = newType;
            rule.scope = get('scope').value || 'global';
            rule.enabled = !!get('enabled').checked;
            const wrapEl = get('wrap');
            rule.wrap = wrapEl ? !!wrapEl.checked : true;
            rule.content = get('content').value || '';

            if (newType === 'context_inject') {
                if (switchedToContext) {
                    rule.role = 'user';
                    rule.depth = 0;
                }
                const roleEl = get('role');
                const depthEl = get('depth');
                if (roleEl) rule.role = roleEl.value === 'assistant' ? 'assistant' : 'user';
                if (depthEl) rule.depth = Math.max(0, parseInt(depthEl.value, 10) || 0);
            } else if (switchedFromContext) {
                delete rule.role;
                delete rule.depth;
            }

            const result = await this.saveStore();
            if (result && result.success) {
                if (window.uiHelperFunctions?.showToastNotification) {
                    window.uiHelperFunctions.showToastNotification('规则已保存', 'success');
                }
                this._renderManagerList();
                this._renderManagerEditPanel();
            } else {
                if (window.uiHelperFunctions?.showToastNotification) {
                    window.uiHelperFunctions.showToastNotification(`保存失败: ${result?.error || '未知错误'}`, 'error');
                }
            }
        },

        async _deleteCurrentRule() {
            const rule = (this.store.rules || []).find(r => r.id === this.selectedRuleId);
            if (!rule) return;

            const confirmFn = (window.uiHelperFunctions && typeof window.uiHelperFunctions.showConfirmDialog === 'function')
                ? window.uiHelperFunctions.showConfirmDialog.bind(window.uiHelperFunctions)
                : null;
            let confirmed;
            if (confirmFn) {
                confirmed = await confirmFn(`确定要删除规则 "${rule.name}" 吗？`, '删除规则', '删除', '取消', true);
            } else {
                confirmed = window.confirm(`确定要删除规则 "${rule.name}" 吗？`);
            }
            if (!confirmed) return;

            this.store.rules = (this.store.rules || []).filter(r => r.id !== rule.id);
            this.selectedRuleId = (this.store.rules[0] && this.store.rules[0].id) || null;
            await this.saveStore();
            this._renderManagerList();
            this._renderManagerEditPanel();
        },

        // ====================== 给主聊天流程使用的注入辅助 ======================
        /**
         * 渲染端用：返回符合作用域的活跃规则
         */
        getActiveRulesForScope(scope) {
            return (this.store.rules || []).filter(r => {
                if (!r || r.enabled === false) return false;
                const ruleScope = r.scope || 'global';
                return ruleScope === 'global' || ruleScope === scope;
            });
        }
    };

    window.TavernManager = TavernManager;

    // 自动初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            TavernManager.init().catch(err => console.error('[TavernManager] init error:', err));
        });
    } else {
        TavernManager.init().catch(err => console.error('[TavernManager] init error:', err));
    }
})();