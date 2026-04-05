
// Promptmodules/modular-prompt-module.js
// 模块化系统提示词模块 - 积木块功能

class ModularPromptModule {
    constructor(options) {
        this.electronAPI = options.electronAPI;
        this.agentId = null;
        this.config = null;
        
        // 积木块数据
        this.blocks = [];
        this.hiddenBlocks = {}; // 按仓库分类存储隐藏的积木块
        this.warehouseOrder = ['default']; // 仓库顺序
        this.currentWarehouse = 'default'; // 当前仓库
        
        // UI元素
        this.container = null;
        this.blocksContainer = null;
        this.warehouseContainer = null;
        
        // 状态
        this.tileMode = true; // 瓦片模式（显示\n块）
        this.viewMode = false; // 预览模式
        
        // 拖拽状态
        this.draggedBlock = null;
        this.draggedIndex = null;
        this.dropIndicator = null;
        this.draggedHiddenBlock = null; // 从小仓拖拽的积木块
        this.draggedWarehouse = null; // 拖拽的仓库
    }

    /**
     * 更新上下文并加载数据
     * @param {string} agentId 
     * @param {Object} config 
     */
    async updateContext(agentId, config) {
        this.agentId = agentId;
        this.config = config;
        await this.loadData();
    }

      /**
     * [修改后] 加载保存的数据（包括私有和全局）
     */
    async loadData() {
        // 1. 加载Agent私有数据（逻辑不变）
        const savedData = this.config.advancedSystemPrompt;
        if (savedData && typeof savedData === 'object') {
            this.blocks = savedData.blocks || [];
            this.hiddenBlocks = savedData.hiddenBlocks || { default: [] };
            this.warehouseOrder = savedData.warehouseOrder || ['default'];
            // 从配置中加载预览模式状态
            if (typeof savedData.viewMode === 'boolean') {
                this.viewMode = savedData.viewMode;
            }
        } else if (typeof savedData === 'string') {
            this.blocks = savedData ? [{ id: this.generateId(), type: 'text', content: savedData, disabled: false }] : [];
        }

        // 2. [新增] 加载全局仓库数据
        try {
            const response = await this.electronAPI.getGlobalWarehouse();
            if (response.success) {
                this.hiddenBlocks['global'] = response.data || [];
            } else {
                console.error('Failed to load global warehouse:', response.error);
                this.hiddenBlocks['global'] = [];
            }
        } catch (error) {
            console.error('Error invoking get-global-warehouse:', error);
            this.hiddenBlocks['global'] = [];
        }

        // 3. [新增] 强制重排仓库顺序，确保 global 和 default 在最前
        // 从已加载的顺序中移除 global 和 default，防止重复
        let privateOrder = this.warehouseOrder.filter(w => w !== 'global' && w !== 'default');
        // 以固定的顺序重建
        this.warehouseOrder = ['global', 'default', ...privateOrder];
        
        // 确保 default 仓库存在
        if (!this.hiddenBlocks.default) {
            this.hiddenBlocks.default = [];
        }
    }
    /**
     * 生成唯一ID
     */
    generateId() {
        return 'block_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    /**
     * 渲染模块UI
     */
    render(container) {
        this.container = container;
        container.innerHTML = '';
        container.classList.add('modular-prompt-container');

        // 顶部工具栏
        const toolbar = this.createToolbar();
        container.appendChild(toolbar);

        // 积木块容器
        this.blocksContainer = document.createElement('div');
        this.blocksContainer.className = 'blocks-container';
        
        // 为容器添加拖拽事件监听，支持从小仓拖入空容器
        this.blocksContainer.addEventListener('dragover', (e) => {
            e.preventDefault();
            // 根据拖拽源设置效果
            if (this.draggedHiddenBlock) {
                e.dataTransfer.dropEffect = 'copy';
            } else if (this.draggedIndex !== null) {
                e.dataTransfer.dropEffect = 'move';
            }
        });
        
        this.blocksContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            // 只处理从小仓拖入到空容器的情况（容器内没有积木块）
            if (this.draggedHiddenBlock && this.blocks.length === 0) {
                const { block } = this.draggedHiddenBlock;
                const newBlock = {
                    ...block,
                    id: this.generateId(),
                    variants: block.variants ? [...block.variants] : undefined,
                    selectedVariant: block.selectedVariant
                };
                this.blocks.push(newBlock);
                this.save();
                this.renderBlocks();
                this.draggedHiddenBlock = null;
            }
        });
        
        container.appendChild(this.blocksContainer);

        // 底部小仓（隐藏块）
        this.warehouseContainer = document.createElement('div');
        this.warehouseContainer.className = 'warehouse-container';
        container.appendChild(this.warehouseContainer);

        // 渲染内容
        if (this.viewMode) {
            this.renderPreview();
        } else {
            this.renderBlocks();
            this.renderWarehouse();
        }
    }

    /**
     * 创建工具栏
     */
    createToolbar() {
        const toolbar = document.createElement('div');
        toolbar.className = 'modular-toolbar';

        // 添加积木块按钮
        const addBtn = document.createElement('button');
        addBtn.className = 'toolbar-btn';
        addBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> 添加积木块';
        addBtn.onclick = () => this.addBlock('text');
        toolbar.appendChild(addBtn);

        // 添加换行块按钮
        const addNewlineBtn = document.createElement('button');
        addNewlineBtn.className = 'toolbar-btn';
        addNewlineBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 3h10M3 8h10M3 13h10" stroke="currentColor" stroke-width="2"/></svg> 添加换行';
        addNewlineBtn.onclick = () => this.addBlock('newline');
        toolbar.appendChild(addNewlineBtn);

        // 创建右侧控制组
        const controlsGroup = document.createElement('div');
        controlsGroup.className = 'toolbar-controls-group';

        // View 模式开关
        const viewModeToggle = document.createElement('label');
        viewModeToggle.className = 'toolbar-toggle';
        viewModeToggle.innerHTML = `
            <input type="checkbox" ${this.viewMode ? 'checked' : ''} id="viewModeCheckbox">
            <span>预览模式</span>
        `;
        viewModeToggle.querySelector('input').onchange = (e) => this.toggleViewMode(e.target.checked);
        controlsGroup.appendChild(viewModeToggle);

        toolbar.appendChild(controlsGroup);

        return toolbar;
    }

    /**
     * 渲染积木块
     */
    renderBlocks() {
        this.blocksContainer.innerHTML = '';

        if (this.blocks.length === 0) {
            const hint = document.createElement('div');
            hint.className = 'blocks-hint';
            hint.textContent = '点击上方按钮添加积木块';
            this.blocksContainer.appendChild(hint);
            return;
        }

        this.blocks.forEach((block, index) => {
            const blockEl = this.createBlockElement(block, index);
            this.blocksContainer.appendChild(blockEl);
            
            // 如果是换行块，在其后插入一个换行标记
            if (block.type === 'newline') {
                const lineBreak = document.createElement('div');
                lineBreak.className = 'line-break-marker';
                this.blocksContainer.appendChild(lineBreak);
            }
        });
    }

    /**
     * 创建积木块元素
     */
    createBlockElement(block, index) {
        const blockEl = document.createElement('div');
        blockEl.className = 'prompt-block';
        blockEl.dataset.index = index;
        blockEl.dataset.id = block.id;

        if (block.type === 'newline') {
            blockEl.classList.add('newline-block');
            blockEl.innerHTML = '<span class="newline-label">换行</span>';
        } else {
            blockEl.classList.add('text-block');
            if (block.disabled) {
                blockEl.classList.add('disabled');
            }
            
            // 如果有名称，添加标识类
            if (block.name && block.name.trim()) {
                blockEl.classList.add('has-custom-name');
            }

            // 如果有多个内容条目，显示当前选中的内容
            const currentContent = this.getCurrentContent(block);
            
            // 内容编辑区
            const contentEl = document.createElement('div');
            contentEl.className = 'block-content';
            contentEl.contentEditable = false; // 默认不可编辑
            // 如果有自定义名称，显示名称；否则显示内容
            const displayText = block.name && block.name.trim() ? block.name : currentContent;
            contentEl.textContent = displayText;
            
            // 双击进入编辑模式
            contentEl.addEventListener('dblclick', () => {
                if (!block.disabled) {
                    contentEl.contentEditable = true;
                    // 如果有名称，显示实际内容用于编辑
                    if (block.name && block.name.trim()) {
                        contentEl.textContent = currentContent;
                    }
                    contentEl.focus();
                    // 选中所有文本
                    const range = document.createRange();
                    range.selectNodeContents(contentEl);
                    const selection = window.getSelection();
                    selection.removeAllRanges();
                    selection.addRange(range);
                }
            });
            
            contentEl.addEventListener('blur', () => {
                // 退出编辑模式
                contentEl.contentEditable = false;
                // 更新当前选中的内容条目
                if (block.variants && block.variants.length > 0) {
                    const selectedIndex = block.selectedVariant || 0;
                    block.variants[selectedIndex] = contentEl.textContent;
                } else {
                    block.content = contentEl.textContent;
                }
                // 恢复显示名称（如果有的话）
                if (block.name && block.name.trim()) {
                    contentEl.textContent = block.name;
                }
                this.save();
            });
            
            contentEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    if (e.shiftKey) {
                        // Shift + Enter: 积木块内换行（默认行为，不阻止）
                        // 不需要做任何处理，让浏览器处理换行
                    } else {
                        // Enter: 结束编辑
                        e.preventDefault();
                        contentEl.blur();
                    }
                } else if (e.key === 'Escape') {
                    // ESC: 退出编辑
                    contentEl.blur();
                }
            });
            
            blockEl.appendChild(contentEl);

            // 如果有多个内容条目，显示指示器（圆点）
            if (block.variants && block.variants.length > 1) {
                const indicator = document.createElement('div');
                indicator.className = 'variant-indicator';
                indicator.title = `此积木块有 ${block.variants.length} 个内容条目，当前为第 ${(block.selectedVariant || 0) + 1} 个`;
                blockEl.appendChild(indicator);
            }
        }

        // 拖拽功能（始终启用）
        blockEl.draggable = true;
        blockEl.addEventListener('dragstart', (e) => this.handleDragStart(e, block, index));
        blockEl.addEventListener('dragover', (e) => this.handleDragOver(e, blockEl, index));
        blockEl.addEventListener('dragleave', (e) => this.handleDragLeave(e, blockEl));
        blockEl.addEventListener('drop', (e) => this.handleDrop(e, index));
        blockEl.addEventListener('dragend', () => this.handleDragEnd());

        // 右键菜单
        blockEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showBlockContextMenu(e, block, index);
        });

        return blockEl;
    }

    /**
     * 获取积木块当前显示的内容
     */
    getCurrentContent(block) {
        if (block.variants && block.variants.length > 0) {
            const selectedIndex = block.selectedVariant || 0;
            return block.variants[selectedIndex] || '';
        }
        return block.content || '';
    }

    /**
     * 显示积木块右键菜单
     */
    showBlockContextMenu(e, block, index) {
        // 移除已存在的菜单
        const existingMenu = document.querySelector('.block-context-menu');
        if (existingMenu) {
            existingMenu.remove();
        }

        const menu = document.createElement('div');
        menu.className = 'block-context-menu';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';

        const menuItems = [];

        // 如果有多个内容条目，置顶显示为可选项
        if (block.variants && block.variants.length > 1 && block.type !== 'newline') {
            block.variants.forEach((variant, variantIndex) => {
                const preview = variant.substring(0, 30) + (variant.length > 30 ? '...' : '');
                menuItems.push({
                    label: `${variantIndex === (block.selectedVariant || 0) ? '✓ ' : ''}${preview}`,
                    action: () => {
                        block.selectedVariant = variantIndex;
                        this.save();
                        this.renderBlocks();
                    },
                    isVariant: true
                });
            });

            // 添加分隔线
            menuItems.push({ separator: true });
        }

        // 常规菜单项
        menuItems.push(
            {
                label: block.disabled ? '启用' : '禁用',
                action: () => this.toggleBlockDisabled(index)
            },
            {
                label: '编辑内容',
                action: () => this.editBlock(block, index),
                hidden: block.type === 'newline'
            },
            {
                label: '移到小仓',
                action: () => this.moveBlockToWarehouse(index)
            },
            {
                label: '删除',
                action: () => this.deleteBlock(index),
                danger: true
            }
        );

        menuItems.forEach(item => {
            if (item.hidden) return;
            
            if (item.separator) {
                const separator = document.createElement('div');
                separator.className = 'context-menu-separator';
                menu.appendChild(separator);
                return;
            }
            
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item';
            if (item.danger) {
                menuItem.classList.add('danger');
            }
            if (item.isVariant) {
                menuItem.classList.add('variant-item');
            }
            menuItem.textContent = item.label;
            menuItem.onclick = () => {
                item.action();
                menu.remove();
            };
            menu.appendChild(menuItem);
        });

        document.body.appendChild(menu);

        // 点击外部关闭菜单
        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeMenu);
        }, 0);
    }

    /**
     * 编辑积木块内容（包括多内容条目）
     */
    editBlock(block, index) {
        // 创建编辑对话框
        const dialog = document.createElement('div');
        dialog.className = 'edit-hidden-block-dialog';
        
        // 初始化 variants 数组
        if (!block.variants || block.variants.length === 0) {
            block.variants = [block.content || ''];
            block.selectedVariant = 0;
        }

        let dialogHTML = `
            <div class="dialog-overlay"></div>
            <div class="dialog-content">
                <h3>编辑积木块</h3>
                <div class="dialog-field">
                    <label>名称（可选）:</label>
                    <input type="text" class="block-name-input" value="${block.name || ''}" placeholder="为积木块命名...">
                </div>
                <div class="variants-edit-container">
                    <label>内容条目:</label>
                    <div class="variants-list">`;

        block.variants.forEach((variant, idx) => {
            dialogHTML += `
                        <div class="variant-item-edit" data-index="${idx}">
                            <textarea class="variant-content-input" rows="3" placeholder="内容条目 ${idx + 1}">${variant}</textarea>
                            ${block.variants.length > 1 ? `<button class="remove-variant-btn" data-index="${idx}">×</button>` : ''}
                        </div>`;
        });

        dialogHTML += `
                    </div>
                    <button class="add-variant-btn">+ 添加内容条目</button>
                </div>
                <div class="dialog-buttons">
                    <button class="dialog-btn dialog-btn-cancel">取消</button>
                    <button class="dialog-btn dialog-btn-save">保存</button>
                </div>
            </div>
        `;

        dialog.innerHTML = dialogHTML;
        document.body.appendChild(dialog);

        const nameInput = dialog.querySelector('.block-name-input');
        const variantsList = dialog.querySelector('.variants-list');
        const addVariantBtn = dialog.querySelector('.add-variant-btn');
        const saveBtn = dialog.querySelector('.dialog-btn-save');
        const cancelBtn = dialog.querySelector('.dialog-btn-cancel');

        // 添加内容条目
        addVariantBtn.onclick = () => {
            const newIndex = variantsList.children.length;
            const variantItem = document.createElement('div');
            variantItem.className = 'variant-item-edit';
            variantItem.dataset.index = newIndex;
            variantItem.innerHTML = `
                <textarea class="variant-content-input" rows="3" placeholder="内容条目 ${newIndex + 1}"></textarea>
                <button class="remove-variant-btn" data-index="${newIndex}">×</button>
            `;
            variantsList.appendChild(variantItem);
            
            // 更新删除按钮显示
            updateRemoveButtons();
        };

        // 删除内容条目
        const updateRemoveButtons = () => {
            const items = variantsList.querySelectorAll('.variant-item-edit');
            items.forEach(item => {
                const removeBtn = item.querySelector('.remove-variant-btn');
                if (removeBtn) {
                    removeBtn.style.display = items.length > 1 ? 'block' : 'none';
                }
            });
        };

        variantsList.addEventListener('click', (e) => {
            if (e.target.classList.contains('remove-variant-btn')) {
                const item = e.target.closest('.variant-item-edit');
                item.remove();
                updateRemoveButtons();
            }
        });

        const closeDialog = () => {
            dialog.remove();
        };

        saveBtn.onclick = () => {
            block.name = nameInput.value.trim();
            
            // 收集所有内容条目
            const variantInputs = variantsList.querySelectorAll('.variant-content-input');
            block.variants = Array.from(variantInputs).map(input => input.value);
            
            // 确保 selectedVariant 在有效范围内
            if (!block.selectedVariant || block.selectedVariant >= block.variants.length) {
                block.selectedVariant = 0;
            }
            
            this.save();
            this.renderBlocks();
            closeDialog();
        };

        cancelBtn.onclick = closeDialog;
        dialog.querySelector('.dialog-overlay').onclick = closeDialog;

        nameInput.focus();
    }

    /**
     * 添加积木块
     */
    addBlock(type, position = null) {
        const newBlock = {
            id: this.generateId(),
            type: type,
            content: type === 'text' ? '' : '',
            disabled: false
        };

        if (position !== null) {
            this.blocks.splice(position, 0, newBlock);
        } else {
            this.blocks.push(newBlock);
        }

        this.save();
        this.renderBlocks();
    }

    /**
     * 删除积木块
     */
    deleteBlock(index) {
        this.blocks.splice(index, 1);
        this.save();
        this.renderBlocks();
    }

    /**
     * 切换积木块禁用状态
     */
    toggleBlockDisabled(index) {
        this.blocks[index].disabled = !this.blocks[index].disabled;
        this.save();
        this.renderBlocks();
    }

    /**
     * 移动积木块到小仓（检查重复）
     */
    moveBlockToWarehouse(index) {
        const block = this.blocks[index];
        if (!this.hiddenBlocks[this.currentWarehouse]) {
            this.hiddenBlocks[this.currentWarehouse] = [];
        }
        
        // 检查是否已存在相同内容的积木块
        const isDuplicate = this.hiddenBlocks[this.currentWarehouse].some(hiddenBlock => {
            return this.areBlocksEqual(hiddenBlock, block);
        });
        
        if (isDuplicate) {
            // 直接删除，不添加到小仓
            this.blocks.splice(index, 1);
        } else {
            // 移动到小仓
            const removedBlock = this.blocks.splice(index, 1)[0];
            this.hiddenBlocks[this.currentWarehouse].push(removedBlock);
        }
        
        this.save();
        this.renderBlocks();
        this.renderWarehouse();
    }
    
    /**
     * 检查两个积木块是否相同
     */
    areBlocksEqual(block1, block2) {
        if (block1.type !== block2.type) return false;
        if (block1.type === 'newline') return true; // 换行块都视为相同
        
        // 比较名称
        if (block1.name !== block2.name) return false;
        
        // 比较内容条目
        if (block1.variants && block2.variants) {
            if (block1.variants.length !== block2.variants.length) return false;
            for (let i = 0; i < block1.variants.length; i++) {
                if (block1.variants[i] !== block2.variants[i]) return false;
            }
            return true;
        } else if (block1.variants || block2.variants) {
            return false; // 一个有variants一个没有
        } else {
            // 都没有variants，比较content
            return block1.content === block2.content;
        }
    }


    /**
     * 渲染小仓
     */
    renderWarehouse() {
        this.warehouseContainer.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'warehouse-header';
        header.innerHTML = '<h4>隐藏积木块小仓</h4>';
        
        // 添加新建仓库按钮
        const addWarehouseBtn = document.createElement('button');
        addWarehouseBtn.className = 'add-warehouse-btn';
        addWarehouseBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>新建小仓</span>';
        addWarehouseBtn.title = '新建仓库';
        addWarehouseBtn.onclick = () => this.createWarehouse();
        header.appendChild(addWarehouseBtn);
        
        this.warehouseContainer.appendChild(header);

        // 仓库选择
        const warehouseSelector = document.createElement('div');
        warehouseSelector.className = 'warehouse-selector';
        
        // 按照warehouseOrder顺序显示仓库
        this.warehouseOrder.forEach((name, index) => {
            if (!this.hiddenBlocks[name]) {
                this.hiddenBlocks[name] = [];
            }
            
            const warehouseItem = document.createElement('div');
            warehouseItem.className = 'warehouse-item';
            if (name === this.currentWarehouse) {
                warehouseItem.classList.add('active');
            }
            
            // 仓库名称按钮
            const btn = document.createElement('button');
            btn.className = 'warehouse-btn';
            // [修改] 为 global 仓库添加图标
            if (name === 'global') {
                btn.innerHTML = '🌐 全局';
            } else {
                btn.textContent = name;
            }
            btn.onclick = () => {
                this.currentWarehouse = name;
                this.renderWarehouse();
            };
            
            // [修改] 仓库拖拽（default和global除外）
            if (name !== 'default' && name !== 'global') {
                warehouseItem.draggable = true;
                warehouseItem.dataset.warehouseName = name;
                warehouseItem.addEventListener('dragstart', (e) => this.handleWarehouseDragStart(e, name, index));
                warehouseItem.addEventListener('dragover', (e) => this.handleWarehouseDragOver(e, index));
                warehouseItem.addEventListener('drop', (e) => this.handleWarehouseDrop(e, index));
                warehouseItem.addEventListener('dragend', () => this.handleWarehouseDragEnd());
            }
            
            warehouseItem.appendChild(btn);
            
            // [修改] 右键菜单（default和global除外）
            if (name !== 'default' && name !== 'global') {
                warehouseItem.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.showWarehouseContextMenu(e, name);
                });
            }
            
            warehouseSelector.appendChild(warehouseItem);
        });

        this.warehouseContainer.appendChild(warehouseSelector);

        // 隐藏的积木块列表
        const hiddenBlocksList = document.createElement('div');
        hiddenBlocksList.className = 'hidden-blocks-list';
        
        // 为列表添加拖拽接收事件（从编辑区拖入）
        hiddenBlocksList.addEventListener('dragover', (e) => {
            if (this.draggedBlock && this.draggedIndex !== null) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                hiddenBlocksList.classList.add('warehouse-drag-over');
            }
        });
        
        hiddenBlocksList.addEventListener('dragleave', (e) => {
            if (!hiddenBlocksList.contains(e.relatedTarget)) {
                hiddenBlocksList.classList.remove('warehouse-drag-over');
            }
        });
        
        hiddenBlocksList.addEventListener('drop', (e) => {
            e.preventDefault();
            hiddenBlocksList.classList.remove('warehouse-drag-over');
            // 从编辑区拖入小仓
            if (this.draggedBlock && this.draggedIndex !== null) {
                this.moveBlockToWarehouseByDrag(this.draggedIndex);
            }
        });

        const currentHidden = this.hiddenBlocks[this.currentWarehouse] || [];
        if (currentHidden.length === 0) {
            hiddenBlocksList.innerHTML = '<div class="warehouse-empty">此仓库为空<br><small style="font-size:0.85em;opacity:0.7;">拖拽积木块到这里</small></div>';
        } else {
            currentHidden.forEach((block, index) => {
                const blockEl = this.createHiddenBlockElement(block, index);
                hiddenBlocksList.appendChild(blockEl);
            });
        }

        this.warehouseContainer.appendChild(hiddenBlocksList);
    }
    
    /**
     * 通过拖拽将积木块移到小仓（防止重复）
     */
    moveBlockToWarehouseByDrag(index) {
        const block = this.blocks[index];
        if (!this.hiddenBlocks[this.currentWarehouse]) {
            this.hiddenBlocks[this.currentWarehouse] = [];
        }
        
        // 检查是否已存在相同内容的积木块
        const isDuplicate = this.hiddenBlocks[this.currentWarehouse].some(hiddenBlock => {
            return this.areBlocksEqual(hiddenBlock, block);
        });
        
        if (isDuplicate) {
            // 直接删除，不添加到小仓
            this.blocks.splice(index, 1);
        } else {
            // 移动到小仓
            const removedBlock = this.blocks.splice(index, 1)[0];
            this.hiddenBlocks[this.currentWarehouse].push(removedBlock);
        }
        
        this.draggedBlock = null;
        this.draggedIndex = null;
        this.save();
        this.renderBlocks();
        this.renderWarehouse();
    }

    /**
     * 创建隐藏积木块元素
     */
    createHiddenBlockElement(block, index) {
        const blockEl = document.createElement('div');
        blockEl.className = 'hidden-block';
        blockEl.dataset.index = index;
        
        // 如果有自定义名称，添加标识类
        if (block.name && block.name.trim()) {
            blockEl.classList.add('has-custom-name');
        }
        
        // 显示名称或内容预览
        const displayText = block.name || (block.content ? block.content : '[空积木块]');
        const previewText = displayText.split('\n')[0]; // 只显示第一行
        blockEl.textContent = previewText.length > 30 ? previewText.substring(0, 30) + '...' : previewText;
        
        // 悬浮提示显示完整内容
        blockEl.title = block.content || '[空积木块]';
        
        // 如果有多个内容条目，显示指示器（圆点）
        if (block.variants && block.variants.length > 1) {
            const indicator = document.createElement('div');
            indicator.className = 'variant-indicator';
            indicator.title = `此积木块有 ${block.variants.length} 个内容条目，当前为第 ${(block.selectedVariant || 0) + 1} 个`;
            blockEl.appendChild(indicator);
        }
        
        // 小仓积木块始终可拖拽
        blockEl.draggable = true;
        blockEl.addEventListener('dragstart', (e) => {
            this.draggedHiddenBlock = { block, index, warehouse: this.currentWarehouse };
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('text/plain', 'hidden-block');
            blockEl.classList.add('dragging');
        });
        
        blockEl.addEventListener('dragend', () => {
            blockEl.classList.remove('dragging');
            this.draggedHiddenBlock = null;
        });

        // 右键菜单
        blockEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showHiddenBlockMenu(e, block, index);
        });

        return blockEl;
    }

    /**
     * 显示隐藏积木块菜单
     */
    showHiddenBlockMenu(e, block, index) {
        const existingMenu = document.querySelector('.block-context-menu');
        if (existingMenu) {
            existingMenu.remove();
        }

        const menu = document.createElement('div');
        menu.className = 'block-context-menu';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';

        const menuItems = [
            {
                label: '编辑',
                action: () => this.editHiddenBlock(block, index)
            },
            {
                label: '恢复到编辑区',
                action: () => this.restoreBlock(index)
            },
            {
                label: '删除',
                action: () => this.deleteHiddenBlock(index),
                danger: true
            }
        ];

        menuItems.forEach(item => {
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item';
            if (item.danger) {
                menuItem.classList.add('danger');
            }
            menuItem.textContent = item.label;
            menuItem.onclick = () => {
                item.action();
                menu.remove();
            };
            menu.appendChild(menuItem);
        });

        document.body.appendChild(menu);

        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeMenu);
        }, 0);
    }

    /**
     * 编辑隐藏积木块
     */
    editHiddenBlock(block, index) {
        // 创建编辑对话框
        const dialog = document.createElement('div');
        dialog.className = 'edit-hidden-block-dialog';
        
        // 初始化 variants 数组
        if (!block.variants || block.variants.length === 0) {
            block.variants = [block.content || ''];
            block.selectedVariant = 0;
        }

        let dialogHTML = `
            <div class="dialog-overlay"></div>
            <div class="dialog-content">
                <h3>编辑积木块</h3>
                <div class="dialog-field">
                    <label>名称（可选）:</label>
                    <input type="text" class="block-name-input" value="${block.name || ''}" placeholder="为积木块命名...">
                </div>
                <div class="variants-edit-container">
                    <label>内容条目:</label>
                    <div class="variants-list">`;

        block.variants.forEach((variant, idx) => {
            dialogHTML += `
                        <div class="variant-item-edit" data-index="${idx}">
                            <textarea class="variant-content-input" rows="3" placeholder="内容条目 ${idx + 1}">${variant}</textarea>
                            ${block.variants.length > 1 ? `<button class="remove-variant-btn" data-index="${idx}">×</button>` : ''}
                        </div>`;
        });

        dialogHTML += `
                    </div>
                    <button class="add-variant-btn">+ 添加内容条目</button>
                </div>
                <div class="dialog-buttons">
                    <button class="dialog-btn dialog-btn-cancel">取消</button>
                    <button class="dialog-btn dialog-btn-save">保存</button>
                </div>
            </div>
        `;

        dialog.innerHTML = dialogHTML;
        document.body.appendChild(dialog);

        const nameInput = dialog.querySelector('.block-name-input');
        const variantsList = dialog.querySelector('.variants-list');
        const addVariantBtn = dialog.querySelector('.add-variant-btn');
        const saveBtn = dialog.querySelector('.dialog-btn-save');
        const cancelBtn = dialog.querySelector('.dialog-btn-cancel');

        // 添加内容条目
        addVariantBtn.onclick = () => {
            const newIndex = variantsList.children.length;
            const variantItem = document.createElement('div');
            variantItem.className = 'variant-item-edit';
            variantItem.dataset.index = newIndex;
            variantItem.innerHTML = `
                <textarea class="variant-content-input" rows="3" placeholder="内容条目 ${newIndex + 1}"></textarea>
                <button class="remove-variant-btn" data-index="${newIndex}">×</button>
            `;
            variantsList.appendChild(variantItem);
            
            // 更新删除按钮显示
            updateRemoveButtons();
        };

        // 删除内容条目
        const updateRemoveButtons = () => {
            const items = variantsList.querySelectorAll('.variant-item-edit');
            items.forEach(item => {
                const removeBtn = item.querySelector('.remove-variant-btn');
                if (removeBtn) {
                    removeBtn.style.display = items.length > 1 ? 'block' : 'none';
                }
            });
        };

        variantsList.addEventListener('click', (e) => {
            if (e.target.classList.contains('remove-variant-btn')) {
                const item = e.target.closest('.variant-item-edit');
                item.remove();
                updateRemoveButtons();
            }
        });

        const closeDialog = () => {
            dialog.remove();
        };

        saveBtn.onclick = () => {
            block.name = nameInput.value.trim();
            
            // 收集所有内容条目
            const variantInputs = variantsList.querySelectorAll('.variant-content-input');
            block.variants = Array.from(variantInputs).map(input => input.value);
            
            // 确保 selectedVariant 在有效范围内
            if (!block.selectedVariant || block.selectedVariant >= block.variants.length) {
                block.selectedVariant = 0;
            }
            
            // 更新 content 字段以保持兼容性
            block.content = block.variants[block.selectedVariant || 0];
            
            this.save();
            this.renderWarehouse();
            closeDialog();
        };

        cancelBtn.onclick = closeDialog;
        dialog.querySelector('.dialog-overlay').onclick = closeDialog;

        nameInput.focus();
    }

    /**
     * 恢复积木块
     */
    restoreBlock(index) {
        const block = this.hiddenBlocks[this.currentWarehouse].splice(index, 1)[0];
        this.blocks.push(block);
        this.save();
        this.renderBlocks();
        this.renderWarehouse();
    }

    /**
     * 删除隐藏积木块
     */
    deleteHiddenBlock(index) {
        this.hiddenBlocks[this.currentWarehouse].splice(index, 1);
        this.save();
        this.renderWarehouse();
    }

    /**
     * 拖拽开始（编辑区积木块）
     */
    handleDragStart(e, block, index) {
        this.draggedBlock = block;
        this.draggedIndex = index;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'edit-block');
        e.target.classList.add('dragging');
    }

    /**
     * 拖拽经过
     */
    handleDragOver(e, targetElement, targetIndex) {
        e.preventDefault();
        
        // 根据拖拽源设置效果
        if (this.draggedHiddenBlock) {
            e.dataTransfer.dropEffect = 'copy';
        } else {
            e.dataTransfer.dropEffect = 'move';
        }
        
        // 如果拖拽的是自己，不显示指示器
        if (this.draggedIndex === targetIndex && !this.draggedHiddenBlock) {
            this.removeDropIndicator();
            return;
        }
        
        // 计算鼠标位置，判断是在左侧还是右侧
        const rect = targetElement.getBoundingClientRect();
        const midPoint = rect.left + rect.width / 2;
        const isLeftSide = e.clientX < midPoint;
        
        // 移除所有指示器
        this.removeDropIndicator();
        
        // 根据位置添加对应的指示器
        if (isLeftSide) {
            targetElement.classList.add('drop-target-left');
        } else {
            targetElement.classList.add('drop-target-right');
        }
    }

    /**
     * 拖拽离开
     */
    handleDragLeave(e, targetElement) {
        // 只有当真正离开元素时才移除样式
        if (!targetElement.contains(e.relatedTarget)) {
            targetElement.classList.remove('drop-target');
        }
    }

    /**
     * 移除所有drop指示器
     */
    removeDropIndicator() {
        const targets = this.blocksContainer.querySelectorAll('.drop-target, .drop-target-left, .drop-target-right');
        targets.forEach(el => {
            el.classList.remove('drop-target');
            el.classList.remove('drop-target-left');
            el.classList.remove('drop-target-right');
        });
    }

    /**
     * 放置（编辑区）
     */
    handleDrop(e, targetIndex) {
        e.preventDefault();
        e.stopPropagation();
        this.removeDropIndicator();
        
        // 从小仓拖拽到编辑区（复制模式）
        if (this.draggedHiddenBlock) {
            const { block } = this.draggedHiddenBlock;
            const newBlock = {
                ...block,
                id: this.generateId(),
                variants: block.variants ? [...block.variants] : undefined,
                selectedVariant: block.selectedVariant
            };
            
            const rect = e.target.getBoundingClientRect();
            const midPoint = rect.left + rect.width / 2;
            const insertIndex = e.clientX < midPoint ? targetIndex : targetIndex + 1;
            
            this.blocks.splice(insertIndex, 0, newBlock);
            this.save();
            this.renderBlocks();
            this.draggedHiddenBlock = null;
            return;
        }
        
        // 编辑区内部拖拽
        if (this.draggedIndex !== null && this.draggedIndex !== targetIndex) {
            const [movedBlock] = this.blocks.splice(this.draggedIndex, 1);
            if (this.draggedIndex < targetIndex) {
                this.blocks.splice(targetIndex - 1, 0, movedBlock);
            } else {
                this.blocks.splice(targetIndex, 0, movedBlock);
            }
            this.save();
            this.renderBlocks();
        }
    }

    /**
     * 拖拽结束
     */
    handleDragEnd() {
        this.draggedBlock = null;
        this.draggedIndex = null;
        this.draggedHiddenBlock = null;
        this.removeDropIndicator();
        const draggingEl = this.blocksContainer.querySelector('.dragging');
        if (draggingEl) {
            draggingEl.classList.remove('dragging');
        }
    }
    

    /**
     * 切换预览模式
     */
    toggleViewMode(enabled) {
        this.viewMode = enabled;
        this.render(this.container);
    }

    /**
     * 渲染预览
     */
    renderPreview() {
        this.blocksContainer.innerHTML = '';
        this.warehouseContainer.style.display = 'none';

        const previewContainer = document.createElement('div');
        previewContainer.className = 'preview-container';

        const label = document.createElement('div');
        label.className = 'preview-label';
        label.textContent = '格式化预览:';
        previewContainer.appendChild(label);

        const previewText = document.createElement('pre');
        previewText.className = 'preview-text';
        previewText.textContent = this.getFormattedPrompt();
        previewContainer.appendChild(previewText);

        this.blocksContainer.appendChild(previewContainer);
    }

    /**
     * 格式化积木块为文本
     */
    formatBlocks() {
        return this.blocks
            .filter(block => !block.disabled)
            .map(block => {
                if (block.type === 'newline') {
                    return '\n';
                } else {
                    let content = block.content || '';
                    // 如果有轮换文本，使用选中的版本
                    if (block.variants && block.variants.length > 0) {
                        const selectedIndex = block.selectedVariant || 0;
                        content = block.variants[selectedIndex] || content;
                    }
                    return content;
                }
            })
            .join('');
    }

    /**
     * 获取格式化后的提示词内容
     * 兼容 PromptManager 中对 `getFormattedPrompt` 的调用
     * @returns {string}
     */
    getFormattedPrompt() {
        return this.formatBlocks();
    }

    /**
     * 获取提示词内容
     */
    async getPrompt() {
        return this.getFormattedPrompt();
    }

    /**
     * 销毁模块，释放资源
     */
    destroy() {
        // 1. 移除可能存在的全局右键菜单
        const existingMenu = document.querySelector('.block-context-menu');
        if (existingMenu) {
            existingMenu.remove();
        }

        // 2. 清理 DOM 引用
        this.container = null;
        this.blocksContainer = null;
        this.warehouseContainer = null;
        this.dropIndicator = null;

        // 3. 清理状态和数据引用
        this.blocks = [];
        this.hiddenBlocks = {};
        this.draggedBlock = null;
        this.draggedHiddenBlock = null;
        this.draggedWarehouse = null;

        // 4. 清理定时器（如果有）
        if (this.pushTimer) {
            clearInterval(this.pushTimer);
            this.pushTimer = null;
        }

        console.debug(`[ModularPromptModule] Destroyed for agent: ${this.agentId}`);
    }

    /**
     * [修改后] 保存数据（分流保存私有和全局数据）
     */
    async save() {
        // 1. [新增] 提取全局仓库数据并独立保存
        const globalBlocksToSave = this.hiddenBlocks['global'] || [];
        try {
            await this.electronAPI.saveGlobalWarehouse(globalBlocksToSave);
        } catch (error) {
            console.error('Error saving global warehouse:', error);
        }

        // 2. [修改] 准备要保存到Agent配置的私有数据
        const privateDataToSave = {
            blocks: this.blocks,
            hiddenBlocks: { ...this.hiddenBlocks }, // 创建一个副本进行操作
            warehouseOrder: this.warehouseOrder,
            viewMode: this.viewMode // 保存预览模式状态
        };

        // 3. [新增] 从私有数据副本中移除全局仓库，避免冗余存储
        delete privateDataToSave.hiddenBlocks['global'];

        // 4. 保存私有数据到Agent配置文件（逻辑不变）
        await this.electronAPI.updateAgentConfig(this.agentId, {
            advancedSystemPrompt: privateDataToSave
        });
    }
    
    /**
     * 新建仓库
     */
    createWarehouse() {
        // 创建对话框
        const dialog = document.createElement('div');
        dialog.className = 'edit-hidden-block-dialog';
        dialog.innerHTML = `
            <div class="dialog-overlay"></div>
            <div class="dialog-content">
                <h3>新建仓库</h3>
                <div class="dialog-field">
                    <label>仓库名称:</label>
                    <input type="text" class="block-name-input" placeholder="请输入仓库名称..." autofocus>
                </div>
                <div class="dialog-buttons">
                    <button class="dialog-btn dialog-btn-cancel">取消</button>
                    <button class="dialog-btn dialog-btn-save">创建</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(dialog);
        
        const nameInput = dialog.querySelector('.block-name-input');
        const saveBtn = dialog.querySelector('.dialog-btn-save');
        const cancelBtn = dialog.querySelector('.dialog-btn-cancel');
        
        const closeDialog = () => {
            dialog.remove();
        };
        
        const createAction = () => {
            const name = nameInput.value.trim();
            
            if (!name) {
                alert('请输入仓库名称');
                return;
            }
            
            if (name === 'default') {
                alert('不能使用 "default" 作为仓库名称');
                return;
            }
            
            if (this.hiddenBlocks[name]) {
                alert('仓库名称已存在');
                return;
            }
            
            this.hiddenBlocks[name] = [];
            this.warehouseOrder.push(name);
            this.currentWarehouse = name;
            this.save();
            this.renderWarehouse();
            closeDialog();
        };
        
        saveBtn.onclick = createAction;
        cancelBtn.onclick = closeDialog;
        dialog.querySelector('.dialog-overlay').onclick = closeDialog;
        
        // 支持回车创建
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                createAction();
            } else if (e.key === 'Escape') {
                closeDialog();
            }
        });
        
        // 聚焦到输入框
        setTimeout(() => nameInput.focus(), 0);
    }

    /**
     * 显示仓库右键菜单
     */
    showWarehouseContextMenu(e, warehouseName) {
        const existingMenu = document.querySelector('.block-context-menu');
        if (existingMenu) {
            existingMenu.remove();
        }

        const menu = document.createElement('div');
        menu.className = 'block-context-menu';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';

        const menuItems = [
            {
                label: '重命名',
                action: () => this.renameWarehouse(warehouseName)
            },
            {
                label: '删除',
                action: () => this.deleteWarehouse(warehouseName),
                danger: true
            }
        ];

        menuItems.forEach(item => {
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item';
            if (item.danger) {
                menuItem.classList.add('danger');
            }
            menuItem.textContent = item.label;
            menuItem.onclick = () => {
                item.action();
                menu.remove();
            };
            menu.appendChild(menuItem);
        });

        document.body.appendChild(menu);

        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeMenu);
        }, 0);
    }

    /**
     * 重命名仓库
     */
    renameWarehouse(oldName) {
        // 创建对话框
        const dialog = document.createElement('div');
        dialog.className = 'edit-hidden-block-dialog';
        dialog.innerHTML = `
            <div class="dialog-overlay"></div>
            <div class="dialog-content">
                <h3>重命名仓库</h3>
                <div class="dialog-field">
                    <label>仓库名称:</label>
                    <input type="text" class="block-name-input" value="${oldName}" autofocus>
                </div>
                <div class="dialog-buttons">
                    <button class="dialog-btn dialog-btn-cancel">取消</button>
                    <button class="dialog-btn dialog-btn-save">确定</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(dialog);
        
        const nameInput = dialog.querySelector('.block-name-input');
        const saveBtn = dialog.querySelector('.dialog-btn-save');
        const cancelBtn = dialog.querySelector('.dialog-btn-cancel');
        
        const closeDialog = () => {
            dialog.remove();
        };
        
        const renameAction = () => {
            const newName = nameInput.value.trim();
            
            if (!newName || newName === oldName) {
                closeDialog();
                return;
            }
            
            if (newName === 'default') {
                alert('不能使用 "default" 作为仓库名称');
                return;
            }
            
            if (this.hiddenBlocks[newName]) {
                alert('仓库名称已存在');
                return;
            }
            
            // 重命名
            this.hiddenBlocks[newName] = this.hiddenBlocks[oldName];
            delete this.hiddenBlocks[oldName];
            
            const index = this.warehouseOrder.indexOf(oldName);
            if (index !== -1) {
                this.warehouseOrder[index] = newName;
            }
            
            if (this.currentWarehouse === oldName) {
                this.currentWarehouse = newName;
            }
            
            this.save();
            this.renderWarehouse();
            closeDialog();
        };
        
        saveBtn.onclick = renameAction;
        cancelBtn.onclick = closeDialog;
        dialog.querySelector('.dialog-overlay').onclick = closeDialog;
        
        // 支持回车确认
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                renameAction();
            } else if (e.key === 'Escape') {
                closeDialog();
            }
        });
        
        // 聚焦并选中文本
        setTimeout(() => {
            nameInput.focus();
            nameInput.select();
        }, 0);
    }

    /**
     * 删除仓库
     */
    deleteWarehouse(warehouseName) {
        if (!confirm(`确定要删除仓库 "${warehouseName}" 吗？其中的积木块也会被删除。`)) {
            return;
        }
        
        delete this.hiddenBlocks[warehouseName];
        this.warehouseOrder = this.warehouseOrder.filter(w => w !== warehouseName);
        
        if (this.currentWarehouse === warehouseName) {
            this.currentWarehouse = 'default';
        }
        
        this.save();
        this.renderWarehouse();
    }

    /**
     * 仓库拖拽开始
     */
    handleWarehouseDragStart(e, warehouseName, index) {
        this.draggedWarehouse = { name: warehouseName, index: index };
        e.dataTransfer.effectAllowed = 'move';
        e.target.classList.add('dragging');
    }

    /**
     * 仓库拖拽经过
     */
    handleWarehouseDragOver(e, targetIndex) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    }

    /**
     * 仓库放置
     */
    handleWarehouseDrop(e, targetIndex) {
        e.preventDefault();
        
        if (!this.draggedWarehouse || this.draggedWarehouse.index === targetIndex) {
            return;
        }
        
        // 移动仓库（跳过default）
        const sourceIndex = this.draggedWarehouse.index;
        const [movedWarehouse] = this.warehouseOrder.splice(sourceIndex, 1);
        
        // 调整目标索引
        const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
        this.warehouseOrder.splice(adjustedTargetIndex, 0, movedWarehouse);
        
        // 确保default始终在第一位
        this.warehouseOrder = this.warehouseOrder.filter(w => w !== 'default');
        this.warehouseOrder.unshift('default');
        
        this.save();
        this.renderWarehouse();
    }

    /**
     * 仓库拖拽结束
     */
    handleWarehouseDragEnd() {
        this.draggedWarehouse = null;
        const draggingEls = document.querySelectorAll('.warehouse-item.dragging');
        draggingEls.forEach(el => el.classList.remove('dragging'));
    }
}

// 导出到全局
window.ModularPromptModule = ModularPromptModule;
