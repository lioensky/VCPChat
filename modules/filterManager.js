window.filterManager = (() => {
    // --- Private Variables ---
    let _electronAPI;
    let _uiHelper;
    let _globalSettingsRef;

    // --- Helper Functions to access refs ---
    const getGlobalSettings = () => _globalSettingsRef.get();
    const setGlobalSettings = (newSettings) => _globalSettingsRef.set(newSettings);

    /**
     * 过滤规则数据结构
     * @typedef {Object} FilterRule
     * @property {string} id - 规则唯一标识符
     * @property {string} name - 规则名称
     * @property {string} type - 规则类型：'whitelist'
     * @property {string} pattern - 匹配模式（正则表达式字符串）
     * @property {string[]} matchPositions - 匹配位置：['start', 'end', 'contain']
     * @property {number} duration - 消息停留时间（秒），0表示立即消失
     * @property {boolean} durationInfinite - 是否永久显示
     * @property {boolean} enabled - 是否启用此规则
     * @property {number} order - 规则顺序（数字越小优先级越高）
     */

    /**
     * 自定义正则替换样式规则数据结构
     * @typedef {Object} RegexReplaceRule
     * @property {string} id - 规则唯一标识符
     * @property {string} name - 规则名称
     * @property {string} type - 规则类型：'regex_replace'
     * @property {string} sourcePattern - 源正则表达式模式
     * @property {string} replacement - 替换内容
     * @property {boolean} enabled - 是否启用此规则
     * @property {number} order - 规则顺序（数字越小优先级越高）
     * @property {string} description - 规则描述
     */

     /**
      * 打开过滤规则设置模态框
      */
     function openFilterRulesModal() {
         console.log('=== 打开模态框开始 ===');
         const modal = document.getElementById('filterRulesModal');

         if (!modal) {
             console.error("[FilterManager] Modal elements not found!");
             return;
         }

         console.log('模态框元素找到，开始初始化');

         // 初始化选项卡显示状态
         initializeTabDisplay();

         // 更新过滤状态显示
         updateFilterStatusDisplay();

         // 渲染规则列表
         renderFilterRulesList();

         _uiHelper.openModal('filterRulesModal');
         console.log('模态框已打开');
         console.log('=== 打开模态框结束 ===');
     }

    /**
     * 更新过滤状态显示
     */
    function updateFilterStatusDisplay() {
        console.log('=== 更新状态显示开始 ===');
        const statusElement = document.getElementById('filterStatus');
        if (!statusElement) {
            console.error('filterStatus元素未找到');
            return;
        }

        const settings = getGlobalSettings();
        const isEnabled = settings.filterEnabled;
        const ruleCount = settings.filterRules.filter(rule => rule.enabled).length;
        const regexRuleCount = settings.regexReplaceRules ? settings.regexReplaceRules.filter(rule => rule.enabled).length : 0;

        console.log('过滤状态:', isEnabled, '过滤规则数量:', ruleCount, '样式规则数量:', regexRuleCount);

        if (isEnabled) {
            statusElement.textContent = `已启用 - ${ruleCount}条活跃规则`;
            statusElement.style.background = 'var(--success-color)';
            statusElement.style.color = 'white';
        } else {
            statusElement.textContent = '已禁用';
            statusElement.style.background = 'var(--text-secondary)';
            statusElement.style.color = 'white';
        }

        console.log('状态显示更新完成');
        console.log('=== 更新状态显示结束 ===');
    }

    /**
     * 渲染过滤规则列表
     */
    function renderFilterRulesList() {
        const rulesList = document.getElementById('filterRulesList');
        if (!rulesList) return;
        
        rulesList.innerHTML = '';
        const settings = getGlobalSettings();

        if (settings.filterRules.length === 0) {
            rulesList.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 20px;">暂无过滤规则，点击上方按钮添加规则</div>';
            return;
        }

        // 按顺序排序规则
        const sortedRules = [...settings.filterRules].sort((a, b) => a.order - b.order);

        sortedRules.forEach(rule => {
            const ruleElement = createFilterRuleElement(rule);
            rulesList.appendChild(ruleElement);
        });
    }

    /**
     * 创建过滤规则元素
     * @param {FilterRule} rule
     */
    function createFilterRuleElement(rule) {
        const ruleDiv = document.createElement('div');
        ruleDiv.className = `filter-rule-item ${rule.enabled ? 'enabled' : 'disabled'}`;
        ruleDiv.dataset.ruleId = rule.id;

        const ruleHeader = document.createElement('div');
        ruleHeader.className = 'filter-rule-header';

        const ruleTitle = document.createElement('div');
        ruleTitle.className = 'filter-rule-title';
        ruleTitle.innerHTML = `
            <strong>${rule.name}</strong>
            <span class="rule-type ${rule.type}">白名单</span>
        `;

        const ruleActions = document.createElement('div');
        ruleActions.className = 'filter-rule-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'small-button';
        editBtn.textContent = '编辑';
        editBtn.onclick = () => editFilterRule(rule.id);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'small-button danger-button';
        deleteBtn.textContent = '删除';
        deleteBtn.onclick = () => deleteFilterRule(rule.id);

        const toggleBtn = document.createElement('button');
        toggleBtn.className = `small-button ${rule.enabled ? 'success-button' : 'secondary-button'}`;
        toggleBtn.textContent = rule.enabled ? '启用' : '禁用';
        toggleBtn.onclick = () => toggleFilterRule(rule.id);

        ruleActions.appendChild(editBtn);
        ruleActions.appendChild(deleteBtn);
        ruleActions.appendChild(toggleBtn);

        ruleHeader.appendChild(ruleTitle);
        ruleHeader.appendChild(ruleActions);

        const ruleDetails = document.createElement('div');
        ruleDetails.className = 'filter-rule-details';
        ruleDetails.innerHTML = `
            <div class="rule-pattern">匹配模式: ${rule.pattern}</div>
            <div class="rule-positions">匹配位置: ${rule.matchPositions.join(', ')}</div>
            <div class="rule-duration">停留时间: ${rule.durationInfinite ? '永久' : rule.duration + '秒'}</div>
        `;

        ruleDiv.appendChild(ruleHeader);
        ruleDiv.appendChild(ruleDetails);

        return ruleDiv;
    }

    /**
     * 添加新的过滤规则
     */
    function addFilterRule() {
        openFilterRuleEditor();
    }

    /**
     * 编辑过滤规则
     * @param {string} ruleId
     */
    function editFilterRule(ruleId) {
        const rule = getGlobalSettings().filterRules.find(r => r.id === ruleId);
        if (rule) {
            openFilterRuleEditor(rule);
        }
    }

    /**
     * 删除过滤规则
     * @param {string} ruleId
     */
    async function deleteFilterRule(ruleId) {
        if (confirm('确定要删除这条过滤规则吗？')) {
            const settings = getGlobalSettings();
            settings.filterRules = settings.filterRules.filter(r => r.id !== ruleId);
            setGlobalSettings(settings);
            await saveFilterSettings();
            renderFilterRulesList();
            updateFilterStatusDisplay();
        }
    }

    /**
     * 切换过滤规则启用状态
     * @param {string} ruleId
     */
    async function toggleFilterRule(ruleId) {
        const settings = getGlobalSettings();
        const rule = settings.filterRules.find(r => r.id === ruleId);
        if (rule) {
            rule.enabled = !rule.enabled;
            setGlobalSettings(settings);
            await saveFilterSettings();
            renderFilterRulesList();
            updateFilterStatusDisplay();
        }
    }

    /**
     * 打开过滤规则编辑器
     * @param {FilterRule|null} ruleToEdit
     */
    function openFilterRuleEditor(ruleToEdit = null) {
        const modal = document.getElementById('filterRuleEditorModal');
        const form = document.getElementById('filterRuleEditorForm');
        const title = document.getElementById('filterRuleEditorTitle');

        if (ruleToEdit) {
            title.textContent = '编辑过滤规则';
            document.getElementById('editingFilterRuleId').value = ruleToEdit.id;
            document.getElementById('filterRuleName').value = ruleToEdit.name;
            document.querySelector(`input[name="ruleType"][value="whitelist"]`).checked = true;
            document.getElementById('filterRulePattern').value = ruleToEdit.pattern;

            document.querySelectorAll('input[name="matchPosition"]').forEach(checkbox => {
                checkbox.checked = ruleToEdit.matchPositions.includes(checkbox.value);
            });

            document.getElementById('filterRuleDuration').value = ruleToEdit.duration;
            document.getElementById('filterRuleDurationInfinite').checked = ruleToEdit.durationInfinite;
            document.getElementById('filterRuleEnabled').checked = ruleToEdit.enabled;
        } else {
            title.textContent = '添加过滤规则';
            document.getElementById('editingFilterRuleId').value = '';
            form.reset();
            document.querySelector('input[name="ruleType"][value="whitelist"]').checked = true;
            document.getElementById('filterRuleDuration').value = 7;
            document.getElementById('filterRuleDurationInfinite').checked = false;
            document.getElementById('filterRuleEnabled').checked = true;
        }

        _uiHelper.openModal('filterRuleEditorModal');
    }

    /**
     * 保存过滤规则
     */
    async function saveFilterRule() {
        const form = document.getElementById('filterRuleEditorForm');
        const ruleId = document.getElementById('editingFilterRuleId').value;
        const settings = getGlobalSettings();

        const ruleData = {
            name: document.getElementById('filterRuleName').value.trim(),
            type: 'whitelist',
            pattern: document.getElementById('filterRulePattern').value.trim(),
            matchPositions: Array.from(document.querySelectorAll('input[name="matchPosition"]:checked')).map(cb => cb.value),
            duration: parseInt(document.getElementById('filterRuleDuration').value) || 0,
            durationInfinite: document.getElementById('filterRuleDurationInfinite').checked,
            enabled: document.getElementById('filterRuleEnabled').checked,
            order: ruleId ? settings.filterRules.find(r => r.id === ruleId)?.order : Date.now()
        };

        if (!ruleData.name || !ruleData.pattern || ruleData.matchPositions.length === 0) {
            _uiHelper.showToastNotification('请填写所有必填字段', 'error');
            return;
        }
        if (ruleData.duration < 0 || ruleData.duration > 300) {
            _uiHelper.showToastNotification('停留时间必须在0到300秒之间', 'error');
            return;
        }

        if (ruleId) {
            const ruleIndex = settings.filterRules.findIndex(r => r.id === ruleId);
            if (ruleIndex !== -1) {
                settings.filterRules[ruleIndex] = { ...settings.filterRules[ruleIndex], ...ruleData };
            }
        } else {
            const newRule = {
                id: `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                ...ruleData
            };
            settings.filterRules.push(newRule);
        }
        
        setGlobalSettings(settings);
        await saveFilterSettings();
        _uiHelper.closeModal('filterRuleEditorModal');
        renderFilterRulesList();
        updateFilterStatusDisplay();
    }

    /**
     * 保存过滤设置到文件
     */
    async function saveFilterSettings() {
        console.log('=== 保存设置开始 ===');
        const currentSettings = getGlobalSettings();
        console.log('保存前regexReplaceRules:', currentSettings.regexReplaceRules);

        const result = await _electronAPI.saveSettings({
            ...currentSettings,
            filterRules: currentSettings.filterRules,
            regexReplaceRules: currentSettings.regexReplaceRules
        });

        if (!result.success) {
            _uiHelper.showToastNotification(`保存过滤设置失败: ${result.error}`, 'error');
        } else {
            console.log('设置保存成功');
        }

        console.log('=== 保存设置结束 ===');
    }

    /**
     * 渲染自定义正则替换规则列表
     */
    function renderRegexReplaceRulesList() {
        console.log('=== 渲染规则列表开始 ===');
        const rulesList = document.getElementById('regexReplaceRulesList');
        if (!rulesList) {
            console.error('regexReplaceRulesList元素未找到');
            return;
        }

        rulesList.innerHTML = '';
        const settings = getGlobalSettings();
        console.log('当前设置:', settings);
        console.log('规则列表:', settings.regexReplaceRules);

        if (settings.regexReplaceRules.length === 0) {
            console.log('规则列表为空');
            rulesList.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 20px;">暂无自定义正则替换规则，点击上方按钮添加规则</div>';
            return;
        }

        // 按顺序排序规则
        const sortedRules = [...settings.regexReplaceRules].sort((a, b) => a.order - b.order);
        console.log('排序后的规则:', sortedRules);

        sortedRules.forEach((rule, index) => {
            console.log(`渲染规则 ${index + 1}:`, rule);
            const ruleElement = createRegexReplaceRuleElement(rule);
            rulesList.appendChild(ruleElement);
        });

        console.log('=== 渲染规则列表结束 ===');
    }

    /**
     * 创建自定义正则替换规则元素
     * @param {RegexReplaceRule} rule
     */
    function createRegexReplaceRuleElement(rule) {
        console.log('=== 创建规则元素开始 ===');
        console.log('创建规则:', rule);

        const ruleDiv = document.createElement('div');
        ruleDiv.className = `filter-rule-item ${rule.enabled ? 'enabled' : 'disabled'}`;
        ruleDiv.dataset.ruleId = rule.id;
        console.log('规则元素class:', ruleDiv.className);

        const ruleHeader = document.createElement('div');
        ruleHeader.className = 'filter-rule-header';

        const ruleTitle = document.createElement('div');
        ruleTitle.className = 'filter-rule-title';
        ruleTitle.innerHTML = `
            <strong>${rule.name}</strong>
            <span class="rule-type ${rule.type}">正则替换</span>
        `;

        const ruleActions = document.createElement('div');
        ruleActions.className = 'filter-rule-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'small-button';
        editBtn.textContent = '编辑';
        editBtn.onclick = () => {
            console.log('点击编辑按钮，规则ID:', rule.id);
            editRegexReplaceRule(rule.id);
        };

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'small-button danger-button';
        deleteBtn.textContent = '删除';
        deleteBtn.onclick = () => {
            console.log('点击删除按钮，规则ID:', rule.id);
            deleteRegexReplaceRule(rule.id);
        };

        const toggleBtn = document.createElement('button');
        toggleBtn.className = `small-button ${rule.enabled ? 'success-button' : 'secondary-button'}`;
        toggleBtn.textContent = rule.enabled ? '启用' : '禁用';
        toggleBtn.onclick = () => {
            console.log('点击切换按钮，规则ID:', rule.id, '当前状态:', rule.enabled);
            toggleRegexReplaceRule(rule.id);
        };

        ruleActions.appendChild(editBtn);
        ruleActions.appendChild(deleteBtn);
        ruleActions.appendChild(toggleBtn);

        ruleHeader.appendChild(ruleTitle);
        ruleHeader.appendChild(ruleActions);

        const ruleDetails = document.createElement('div');
        ruleDetails.className = 'filter-rule-details';
        ruleDetails.innerHTML = `
            <div class="rule-pattern">源模式: ${rule.sourcePattern}</div>
            <div class="rule-replacement">替换为: ${rule.replacement || '（空）'}</div>
            <div class="rule-description">描述: ${rule.description || '无描述'}</div>
        `;

        ruleDiv.appendChild(ruleHeader);
        ruleDiv.appendChild(ruleDetails);

        console.log('规则元素创建完成');
        console.log('=== 创建规则元素结束 ===');
        return ruleDiv;
    }

    /**
     * 添加新的自定义正则替换规则
     */
    function addRegexReplaceRule() {
        console.log('=== 添加新规则开始 ===');
        openRegexReplaceRuleEditor();
        console.log('=== 添加新规则结束 ===');
    }

    /**
     * 编辑自定义正则替换规则
     * @param {string} ruleId
     */
    function editRegexReplaceRule(ruleId) {
        console.log('=== 编辑规则开始 ===');
        console.log('编辑规则ID:', ruleId);

        const settings = getGlobalSettings();
        const rule = settings.regexReplaceRules.find(r => r.id === ruleId);
        if (rule) {
            console.log('找到规则:', rule);
            openRegexReplaceRuleEditor(rule);
        } else {
            console.error('未找到规则:', ruleId);
            console.log('可用规则:', settings.regexReplaceRules);
        }

        console.log('=== 编辑规则结束 ===');
    }

    /**
     * 删除自定义正则替换规则
     * @param {string} ruleId
     */
    async function deleteRegexReplaceRule(ruleId) {
        console.log('=== 删除规则开始 ===');
        console.log('删除规则ID:', ruleId);

        if (confirm('确定要删除这条自定义正则替换规则吗？')) {
            const settings = getGlobalSettings();
            const originalLength = settings.regexReplaceRules.length;
            console.log('删除前规则数量:', originalLength);

            settings.regexReplaceRules = settings.regexReplaceRules.filter(r => r.id !== ruleId);
            console.log('删除后规则数量:', settings.regexReplaceRules.length);

            setGlobalSettings(settings);
            await saveFilterSettings();
            renderRegexReplaceRulesList();
            updateFilterStatusDisplay();

            console.log('=== 删除规则结束 ===');
        }
    }

    /**
     * 切换自定义正则替换规则启用状态
     * @param {string} ruleId
     */
    async function toggleRegexReplaceRule(ruleId) {
        console.log('=== 切换规则状态开始 ===');
        console.log('规则ID:', ruleId);

        const settings = getGlobalSettings();
        console.log('切换前规则列表:', settings.regexReplaceRules);

        const rule = settings.regexReplaceRules.find(r => r.id === ruleId);
        if (rule) {
            const oldState = rule.enabled;
            rule.enabled = !rule.enabled;
            console.log(`切换规则 "${rule.name}": ${oldState} -> ${rule.enabled}`);

            setGlobalSettings(settings);
            await saveFilterSettings();
            renderRegexReplaceRulesList();
            updateFilterStatusDisplay();

            console.log('切换后规则列表:', settings.regexReplaceRules);
        } else {
            console.error('未找到规则:', ruleId);
        }

        console.log('=== 切换规则状态结束 ===');
    }

    /**
     * 打开自定义正则替换规则编辑器
     * @param {RegexReplaceRule|null} ruleToEdit
     */
    function openRegexReplaceRuleEditor(ruleToEdit = null) {
        console.log('=== 打开编辑器开始 ===');
        console.log('编辑规则:', ruleToEdit);

        const modal = document.getElementById('regexReplaceRuleEditorModal');
        const form = document.getElementById('regexReplaceRuleEditorForm');
        const title = document.getElementById('regexReplaceRuleEditorTitle');

        if (ruleToEdit) {
            console.log('编辑模式，填充表单');
            title.textContent = '编辑自定义正则替换规则';
            document.getElementById('editingRegexReplaceRuleId').value = ruleToEdit.id;
            document.getElementById('regexReplaceRuleName').value = ruleToEdit.name;
            document.getElementById('regexReplaceRuleSourcePattern').value = ruleToEdit.sourcePattern || '';
            document.getElementById('regexReplaceRuleReplacement').value = ruleToEdit.replacement || '';
            document.getElementById('regexReplaceRuleDescription').value = ruleToEdit.description || '';
            document.getElementById('regexReplaceRuleEnabled').checked = ruleToEdit.enabled;

            console.log('表单填充完成:', {
                id: ruleToEdit.id,
                name: ruleToEdit.name,
                sourcePattern: ruleToEdit.sourcePattern,
                replacement: ruleToEdit.replacement,
                enabled: ruleToEdit.enabled
            });
        } else {
            console.log('新增模式，重置表单');
            title.textContent = '添加自定义正则替换规则';
            document.getElementById('editingRegexReplaceRuleId').value = '';
            form.reset();
            document.getElementById('regexReplaceRuleEnabled').checked = true;
        }

        _uiHelper.openModal('regexReplaceRuleEditorModal');
        console.log('=== 打开编辑器结束 ===');
    }

    /**
     * 保存自定义正则替换规则
     */
    async function saveRegexReplaceRule() {
        console.log('=== 保存规则开始 ===');
        const form = document.getElementById('regexReplaceRuleEditorForm');
        const ruleId = document.getElementById('editingRegexReplaceRuleId').value;
        const settings = getGlobalSettings();

        const ruleData = {
            name: document.getElementById('regexReplaceRuleName').value.trim(),
            type: 'regex_replace',
            sourcePattern: document.getElementById('regexReplaceRuleSourcePattern').value,
            replacement: document.getElementById('regexReplaceRuleReplacement').value,
            description: document.getElementById('regexReplaceRuleDescription').value.trim(),
            enabled: document.getElementById('regexReplaceRuleEnabled').checked,
            order: ruleId ? settings.regexReplaceRules.find(r => r.id === ruleId)?.order : Date.now()
        };

        console.log('表单数据:', {
            ruleId,
            ruleName: ruleData.name,
            sourcePattern: ruleData.sourcePattern,
            replacement: ruleData.replacement,
            enabled: ruleData.enabled
        });

        if (!ruleData.name || !ruleData.sourcePattern) {
            _uiHelper.showToastNotification('请填写规则名称和源正则表达式', 'error');
            return;
        }

        // 验证正则表达式是否有效
        try {
            const testRegex = new RegExp(ruleData.sourcePattern);
            console.log('正则表达式验证通过:', testRegex);
        } catch (e) {
            _uiHelper.showToastNotification(`正则表达式无效: ${e.message}`, 'error');
            return;
        }

        if (ruleId) {
            const ruleIndex = settings.regexReplaceRules.findIndex(r => r.id === ruleId);
            console.log('编辑模式，规则索引:', ruleIndex);
            if (ruleIndex !== -1) {
                settings.regexReplaceRules[ruleIndex] = { ...settings.regexReplaceRules[ruleIndex], ...ruleData };
                console.log('更新后的规则:', settings.regexReplaceRules[ruleIndex]);
            }
        } else {
            const newRule = {
                id: `regex_rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                ...ruleData
            };
            console.log('新增规则:', newRule);
            settings.regexReplaceRules.push(newRule);
        }

        console.log('保存前规则列表:', settings.regexReplaceRules);
        setGlobalSettings(settings);
        await saveFilterSettings();
        console.log('保存完成');
        _uiHelper.closeModal('regexReplaceRuleEditorModal');
        renderRegexReplaceRulesList();
        updateFilterStatusDisplay();
        console.log('=== 保存规则结束 ===');
    }

    /**
     * 应用自定义正则替换规则到消息内容
     * @param {string} content - 原始消息内容
     * @returns {string} - 替换后的消息内容
     */
    function applyRegexReplaceRules(content) {
        const settings = getGlobalSettings();
        if (!settings.regexReplaceRules) return content;

        let processedContent = content;

        // 只处理明确启用的规则，确保禁用的规则不会生效
        const enabledRules = settings.regexReplaceRules
            .filter(rule => rule.enabled === true && rule.sourcePattern && (rule.replacement !== undefined && rule.replacement !== null))
            .sort((a, b) => a.order - b.order);

        enabledRules.forEach(rule => {
            try {
                const regex = new RegExp(rule.sourcePattern, 'g');
                processedContent = processedContent.replace(regex, rule.replacement);
            } catch (e) {
                console.warn(`正则替换规则 "${rule.name}" 应用失败:`, e);
            }
        });

        return processedContent;
    }

    /**
     * 应用VCPLog样式规则（简化版）
     * @param {string} content - 原始消息内容
     * @returns {string} - 替换后的消息内容
     */
    function applyVCPLogStyleRules(content) {
        console.log('=== VCPLog样式规则调试开始 ===');
        console.log('输入内容:', content);

        const settings = getGlobalSettings();
        console.log('全局设置:', settings);
        console.log('regexReplaceRules:', settings.regexReplaceRules);

        if (!settings.regexReplaceRules) {
            console.log('没有找到regexReplaceRules，返回原内容');
            return content;
        }

        let processedContent = content;
        console.log('开始处理，规则数量:', settings.regexReplaceRules.length);

        // 只处理明确启用的规则
        const enabledRules = settings.regexReplaceRules
            .filter(rule => rule.enabled === true && rule.sourcePattern && (rule.replacement !== undefined && rule.replacement !== null))
            .sort((a, b) => a.order - b.order);

        console.log('启用的规则:', enabledRules);

        if (enabledRules.length === 0) {
            console.log('没有启用的规则，返回原内容');
            return content;
        }

        enabledRules.forEach((rule, index) => {
            console.log(`应用规则 ${index + 1}:`, rule.name);
            console.log('源模式:', rule.sourcePattern);
            console.log('替换为:', rule.replacement);

            try {
                const regex = new RegExp(rule.sourcePattern, 'g');
                console.log('正则对象创建成功:', regex);
                const oldContent = processedContent;
                processedContent = processedContent.replace(regex, rule.replacement);
                console.log(`替换结果: "${oldContent}" -> "${processedContent}"`);
            } catch (e) {
                console.warn(`VCPLog样式规则 "${rule.name}" 应用失败:`, e);
            }
        });

        console.log('最终结果:', processedContent);
        console.log('=== VCPLog样式规则调试结束 ===');
        return processedContent;
    }

    /**
     * 检查消息是否匹配过滤规则
     * @param {string} messageTitle - 消息标题
     * @returns {Object|null} 匹配的规则，如果过滤未启用则返回null，如果匹配白名单则返回show，否则返回hide
     */
    function checkMessageFilter(messageTitle) {
        const settings = getGlobalSettings();
        if (!settings.filterEnabled) {
            return null;
        }

        for (const rule of settings.filterRules) {
            if (!rule.enabled) continue;

            let matches = false;
            for (const position of rule.matchPositions) {
                if (position === 'contain' && messageTitle.includes(rule.pattern)) {
                    matches = true; break;
                } else if (position === 'start' && messageTitle.startsWith(rule.pattern)) {
                    matches = true; break;
                } else if (position === 'end' && messageTitle.endsWith(rule.pattern)) {
                    matches = true; break;
                }
            }

            if (matches) {
                return {
                    rule: rule,
                    action: 'show',
                    duration: rule.durationInfinite ? 0 : rule.duration
                };
            }
        }

        return {
            rule: null,
            action: 'hide',
            duration: 0
        };
    }

    function init(dependencies) {
        _electronAPI = dependencies.electronAPI;
        _uiHelper = dependencies.uiHelper;
        _globalSettingsRef = dependencies.refs.globalSettingsRef;

        const doNotDisturbBtn = document.getElementById('doNotDisturbBtn');

        if (doNotDisturbBtn) {
            // 左键点击：切换过滤总开关
            doNotDisturbBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                const isActive = doNotDisturbBtn.classList.toggle('active');
                const settings = getGlobalSettings();
                settings.filterEnabled = isActive;
                setGlobalSettings(settings);

                // Also save to localStorage as backup
                localStorage.setItem('filterEnabled', isActive.toString());

                // Save the setting immediately
                const result = await _electronAPI.saveSettings({
                    ...settings, // Send all settings to avoid overwriting
                    filterEnabled: isActive
                });

                if (result.success) {
                    updateFilterStatusDisplay();
                    _uiHelper.showToastNotification(`过滤模式已${isActive ? '开启' : '关闭'}`, 'info');
                } else {
                    _uiHelper.showToastNotification(`设置过滤模式失败: ${result.error}`, 'error');
                    // Revert UI on failure
                    doNotDisturbBtn.classList.toggle('active', !isActive);
                    settings.filterEnabled = !isActive;
                    setGlobalSettings(settings);
                    localStorage.setItem('filterEnabled', (!isActive).toString());
                }
            });

            // 右键点击：打开过滤规则设置页面
            doNotDisturbBtn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                openFilterRulesModal();
            });
        }

        // Setup event listeners that were previously in renderer.js
        const addFilterRuleBtn = document.getElementById('addFilterRuleBtn');
        if (addFilterRuleBtn) {
            addFilterRuleBtn.addEventListener('click', addFilterRule);
        }

        const filterRuleEditorForm = document.getElementById('filterRuleEditorForm');
        if (filterRuleEditorForm) {
            filterRuleEditorForm.addEventListener('submit', (e) => {
                e.preventDefault();
                saveFilterRule();
            });
        }

        const cancelFilterRuleEditorBtn = document.getElementById('cancelFilterRuleEditor');
        if (cancelFilterRuleEditorBtn) {
            cancelFilterRuleEditorBtn.addEventListener('click', () => {
                _uiHelper.closeModal('filterRuleEditorModal');
            });
        }

        const closeFilterRuleEditorBtn = document.getElementById('closeFilterRuleEditorModal');
        if (closeFilterRuleEditorBtn) {
            closeFilterRuleEditorBtn.addEventListener('click', () => {
                _uiHelper.closeModal('filterRuleEditorModal');
            });
        }

        const closeFilterRulesBtn = document.getElementById('closeFilterRulesModal');
        if (closeFilterRulesBtn) {
            closeFilterRulesBtn.addEventListener('click', () => {
                _uiHelper.closeModal('filterRulesModal');
            });
        }

        // 手动过滤总开关已被移除，不再需要相关事件监听器

        // Setup event listeners for regex replace rules
        const addRegexReplaceRuleBtn = document.getElementById('addRegexReplaceRuleBtn');
        if (addRegexReplaceRuleBtn) {
            addRegexReplaceRuleBtn.addEventListener('click', addRegexReplaceRule);
        }

        const regexReplaceRuleEditorForm = document.getElementById('regexReplaceRuleEditorForm');
        if (regexReplaceRuleEditorForm) {
            regexReplaceRuleEditorForm.addEventListener('submit', (e) => {
                e.preventDefault();
                saveRegexReplaceRule();
            });
        }

        const cancelRegexReplaceRuleEditorBtn = document.getElementById('cancelRegexReplaceRuleEditor');
        if (cancelRegexReplaceRuleEditorBtn) {
            cancelRegexReplaceRuleEditorBtn.addEventListener('click', () => {
                _uiHelper.closeModal('regexReplaceRuleEditorModal');
            });
        }

        const closeRegexReplaceRuleEditorBtn = document.getElementById('closeRegexReplaceRuleEditorModal');
        if (closeRegexReplaceRuleEditorBtn) {
            closeRegexReplaceRuleEditorBtn.addEventListener('click', () => {
                _uiHelper.closeModal('regexReplaceRuleEditorModal');
            });
        }

        // Setup tab switching for filter rules modal
        const filterTabBtns = document.querySelectorAll('.filter-tab-btn');
        filterTabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const tabType = btn.dataset.tab;
                switchFilterRulesTab(tabType);
            });
        });
    }

    /**
     * 切换过滤规则选项卡
     * @param {string} tabType - 'filter' 或 'regex_replace'
     */
    function switchFilterRulesTab(tabType) {
        console.log('=== 切换选项卡开始 ===');
        console.log('切换到选项卡:', tabType);

        // 更新按钮状态 - 添加视觉突出显示
        document.querySelectorAll('.filter-tab-btn').forEach(btn => {
            if (btn.dataset.tab === tabType) {
                btn.classList.add('active');
                btn.style.background = 'var(--success-color)';
                btn.style.color = 'white';
                btn.style.fontWeight = 'bold';
                console.log('激活选项卡:', btn.dataset.tab);
            } else {
                btn.classList.remove('active');
                btn.style.background = 'var(--button-secondary-bg)';
                btn.style.color = 'var(--secondary-text)';
                btn.style.fontWeight = 'normal';
                console.log('取消激活选项卡:', btn.dataset.tab);
            }
        });

        // 更新内容显示
        const filterTabContent = document.getElementById('filterTabContent');
        const regexReplaceTabContent = document.getElementById('regexReplaceTabContent');

        if (tabType === 'regex_replace') {
            console.log('显示VCPLog样式选项卡');
            filterTabContent.style.display = 'none';
            regexReplaceTabContent.style.display = 'block';
            renderRegexReplaceRulesList();
        } else {
            console.log('显示过滤规则选项卡');
            filterTabContent.style.display = 'block';
            regexReplaceTabContent.style.display = 'none';
            renderFilterRulesList();
        }

        console.log('=== 切换选项卡结束 ===');
    }

    /**
     * 初始化选项卡显示状态
     */
    function initializeTabDisplay() {
        console.log('=== 初始化选项卡显示 ===');
        // 确保默认显示过滤规则选项卡
        const filterTabBtn = document.querySelector('.filter-tab-btn[data-tab="filter"]');
        const regexReplaceTabBtn = document.querySelector('.filter-tab-btn[data-tab="regex_replace"]');

        console.log('找到选项卡按钮:', { filterTabBtn, regexReplaceTabBtn });

        if (filterTabBtn && regexReplaceTabBtn) {
            // 设置过滤规则选项卡为激活状态
            filterTabBtn.classList.add('active');
            filterTabBtn.style.background = 'var(--success-color)';
            filterTabBtn.style.color = 'white';
            filterTabBtn.style.fontWeight = 'bold';

            // 设置VCPLog样式选项卡为非激活状态
            regexReplaceTabBtn.classList.remove('active');
            regexReplaceTabBtn.style.background = 'var(--button-secondary-bg)';
            regexReplaceTabBtn.style.color = 'var(--secondary-text)';
            regexReplaceTabBtn.style.fontWeight = 'normal';

            console.log('选项卡样式设置完成');
        }

        // 确保内容显示正确
        const filterTabContent = document.getElementById('filterTabContent');
        const regexReplaceTabContent = document.getElementById('regexReplaceTabContent');

        console.log('找到内容容器:', { filterTabContent, regexReplaceTabContent });

        if (filterTabContent) {
            filterTabContent.style.display = 'block';
        }
        if (regexReplaceTabContent) {
            regexReplaceTabContent.style.display = 'none';
        }

        console.log('=== 初始化选项卡显示结束 ===');
    }

    // --- Public API ---
    return {
        init,
        openFilterRulesModal,
        checkMessageFilter,
        applyRegexReplaceRules,
        applyVCPLogStyleRules,
        switchFilterRulesTab,
        initializeTabDisplay
    };
})();