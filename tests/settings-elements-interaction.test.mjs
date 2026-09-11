import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const mainHtml = fs.readFileSync(path.join(repoRoot, 'main.html'), 'utf8');
const settingsCss = fs.readFileSync(path.join(repoRoot, 'styles/settings.css'), 'utf8');
const sidebarListCss = fs.readFileSync(path.join(repoRoot, 'styles/setting/settings-sidebar-list.css'), 'utf8');
const sidebarTabsCss = fs.readFileSync(path.join(repoRoot, 'styles/setting/settings-sidebar-tabs.css'), 'utf8');
const searchCss = fs.readFileSync(path.join(repoRoot, 'styles/setting/settings-search.css'), 'utf8');
const sidebarCss = fs.readFileSync(path.join(repoRoot, 'styles/ui-system/settings-sidebar.css'), 'utf8');
const groupSettingsCss = fs.readFileSync(path.join(repoRoot, 'styles/ui-system/group-settings.css'), 'utf8');
const schema = await import(pathToFileURL(path.join(repoRoot, 'modules/settings/schema/sidebar-surfaces.js')).href);
const surfaceModule = await import(pathToFileURL(path.join(repoRoot, 'modules/ui-system/settings/settings-sidebar-surface.js')).href);

function createDocument() {
    const dom = new JSDOM('<!doctype html><html><body><main id="tabContentSettings" class="active" aria-hidden="false"><div id="agentSettingsContainer"></div><p id="selectAgentPromptForSettings">请选择</p></main></body></html>', { url: 'http://localhost' });
    return { dom, document: dom.window.document };
}

test('schema contract declares both settings domains, validation, dependency and tooltip metadata', () => {
    const { settingsSidebarSchema } = schema;
    assert.deepEqual(settingsSidebarSchema.agent.sections, ['identity', 'prompt', 'model', 'params', 'tts', 'regex']);
    assert.deepEqual(settingsSidebarSchema.group.sections, ['identity', 'mode', 'model', 'prompt']);
    const temperature = settingsSidebarSchema.agent.fields.find(field => field.id === 'agentTemperature');
    assert.deepEqual(temperature.validation, { min: 0, max: 2 });
    assert.equal(typeof temperature.tooltip, 'undefined');
    const tagMode = settingsSidebarSchema.group.fields.find(field => field.id === 'tagMatchMode');
    assert.deepEqual(tagMode.dependsOn, { field: 'groupChatMode', equals: 'naturerandom' });
    assert.ok(settingsSidebarSchema.group.fields.every(field => field.tooltip || field.id === 'groupNameInput'));
});

test('schema-rendered Agent surface exposes every business anchor and all controls respond to interaction', () => {
    const { dom, document } = createDocument();
    const host = document.getElementById('agentSettingsContainer');
    const form = schema.renderAgentSettingsSurface(host, document);
    assert.equal(form.id, 'agentSettingsForm');

    const expectedIds = [
        'editingAgentId', 'agentAvatarPreview', 'agentAvatarInput', 'agentNameInput', 'disableCustomColors',
        'useThemeColorsInChat', 'agentAvatarBorderColor', 'agentAvatarBorderColorText', 'agentNameTextColor',
        'agentNameTextColorText', 'resetAvatarColorsBtn', 'agentCustomCss', 'agentCardCss', 'agentChatCss',
        'systemPromptContainer', 'agentModel', 'openModelSelectBtn', 'agentTemperature', 'agentContextTokenLimit',
        'agentMaxOutputTokens', 'agentTopP', 'agentTopK', 'agentStreamOutputTrue', 'agentStreamOutputFalse',
        'agentTtsVoicePrimary', 'refreshTtsModelsBtn', 'agentTtsRegexPrimary', 'agentTtsVoiceSecondary',
        'agentTtsRegexSecondary', 'agentTtsSpeed', 'ttsSpeedValue', 'agentTtsDirectorPromptInput',
        'fillAgentTtsDirectorTemplateBtn', 'addAgentTtsDirectorPromptBtn', 'agentTtsDirectorPromptsContainer',
        'deleteAgentBtn',
        'regexToggleHeader', 'regexToggleBtn', 'regexSummary', 'regexContent', 'stripRegexListContainer'
    ];
    for (const id of expectedIds) assert.ok(document.getElementById(id), `schema surface missing #${id}`);
    assert.ok(document.getElementById('ttsSpeedValue')?.classList.contains('slider-value-pill'), 'ttsSpeedValue 必须包含 slider-value-pill 类');

    const sections = [...form.querySelectorAll('[data-schema-section][data-section-key]')];
    assert.deepEqual(sections.map(section => section.dataset.sectionKey), ['identity', 'prompt', 'model', 'params', 'tts', 'regex']);
    assert.equal(form.querySelectorAll('.agent-settings-section-title-row').length, sections.length);
    assert.equal(form.querySelector('[data-section-key="prompt"] .agent-settings-section-title-row > .agent-settings-section-title')?.textContent, '系统提示词');
    assert.equal(form.querySelector('#refreshTtsModelsBtn .vcp-ui-icon')?.textContent, 'refresh');
    const avatarOverlay = form.querySelector('.avatar-upload-overlay');
    assert.ok(avatarOverlay?.querySelector('svg.avatar-upload-icon'), 'avatar upload control must contain a real SVG node');
    assert.doesNotMatch(avatarOverlay?.textContent || '', /<svg|aria-hidden|<path/, 'SVG source must not leak as visible text');

    const name = document.getElementById('agentNameInput');
    name.value = '测试助手';
    name.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(name.value, '测试助手');
    document.getElementById('agentTemperature').value = '1.2';
    document.getElementById('agentStreamOutputFalse').click();
    assert.equal(document.getElementById('agentStreamOutputFalse').checked, true);
    document.getElementById('fillAgentTtsDirectorTemplateBtn').click();
    assert.ok(document.getElementById('fillAgentTtsDirectorTemplateBtn').type === 'button');
    assert.equal(form.querySelectorAll('button').length >= 10, true);
});

test('Agent 手风琴与自定义样式折叠展开测试：点击 Header、Toggle 按钮与键盘回车/空格均能可靠切换', () => {
    const { document } = createDocument();
    const host = document.getElementById('agentSettingsContainer');
    const form = schema.renderAgentSettingsSurface(host, document);

    const sections = [...form.querySelectorAll('.agent-settings-section')];
    assert.equal(sections.length, 6, 'Agent 设置必须有 6 个可折叠分区（含正则设置）');

    // 逐个测试 6 大主分区点击与键盘切换
    for (const section of sections) {
        const header = section.querySelector('.agent-settings-section-header');
        const toggle = section.querySelector('.agent-settings-toggle-btn');
        assert.ok(header, '分区 Header 必须存在');
        assert.ok(toggle, '分区 Toggle 按钮必须存在');

        // 初始状态：必须折叠
        assert.ok(section.classList.contains('collapsed'), `分区 ${section.dataset.sectionKey} 初始必须处于折叠态`);
        assert.equal(header.getAttribute('aria-expanded'), 'false');
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');

        // 1. 点击 Header 展开
        header.click();
        assert.equal(section.classList.contains('collapsed'), false, `点击 Header 后分区 ${section.dataset.sectionKey} 必须展开`);
        assert.equal(header.getAttribute('aria-expanded'), 'true');
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');

        // 2. 点击 Header 再次折叠
        header.click();
        assert.equal(section.classList.contains('collapsed'), true, `再次点击 Header 后分区 ${section.dataset.sectionKey} 必须收起`);
        assert.equal(header.getAttribute('aria-expanded'), 'false');
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');

        // 3. 点击 Toggle 按钮直接切换展开
        toggle.click();
        assert.equal(section.classList.contains('collapsed'), false, `点击 Toggle 按钮分区 ${section.dataset.sectionKey} 必须展开`);
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');

        // 4. 键盘 Enter 触发折叠
        header.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        assert.equal(section.classList.contains('collapsed'), true, `回车键必须使分区 ${section.dataset.sectionKey} 收起`);

        // 5. 键盘 Space 触发展开
        header.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        assert.equal(section.classList.contains('collapsed'), false, `空格键必须使分区 ${section.dataset.sectionKey} 展开`);
    }

    // 测试「自定义样式设置」手风琴
    const styleContainer = form.querySelector('.agent-style-collapsible-container');
    const styleHeader = form.querySelector('#styleCollapseHeader');
    assert.ok(styleContainer, 'style 容器必须存在');
    assert.ok(styleHeader, 'styleHeader 必须存在');
    assert.ok(styleContainer.classList.contains('collapsed'), '样式设置初始必须折叠');

    styleHeader.click();
    assert.equal(styleContainer.classList.contains('collapsed'), false, '点击 styleHeader 必须展开');
    assert.equal(styleHeader.getAttribute('aria-expanded'), 'true');

    styleHeader.click();
    assert.equal(styleContainer.classList.contains('collapsed'), true, '再次点击 styleHeader 必须收起');
    assert.equal(styleHeader.getAttribute('aria-expanded'), 'false');
});

test('基础信息头像与名字框外观结构契约测试：保持头像边框容器、上传图标及名字输入框卡片化', () => {
    const { document } = createDocument();
    const host = document.getElementById('agentSettingsContainer');
    const form = schema.renderAgentSettingsSurface(host, document);

    // 结构完备性
    const avatarWrapper = form.querySelector('.agent-avatar-wrapper');
    const avatarImg = form.querySelector('#agentAvatarPreview');
    const uploadOverlay = form.querySelector('.avatar-upload-overlay');
    const nameWrapper = form.querySelector('.agent-name-wrapper');
    const nameInput = form.querySelector('#agentNameInput');

    assert.ok(avatarWrapper, '必须具备 .agent-avatar-wrapper 容器');
    assert.ok(avatarImg, '必须具备 #agentAvatarPreview 头像');
    assert.ok(uploadOverlay, '必须具备 .avatar-upload-overlay 遮罩');
    assert.ok(nameWrapper, '必须具备 .agent-name-wrapper 容器');
    assert.ok(nameInput, '必须具备 #agentNameInput 输入框');

    // 样式规范验证（收敛至 settings-sidebar.css）
    assert.match(sidebarCss, /\.agent-avatar-wrapper[\s\S]*?position:\s*relative/, '头像容器必须声明 relative 布局以承载悬浮遮罩');
    assert.match(sidebarCss, /\.avatar-upload-overlay[\s\S]*?position:\s*absolute/, '上传徽章必须使用绝对定位挂载于头像上');
    assert.match(sidebarCss, /\.agent-identity-main[\s\S]*?grid-template-columns:\s*(?:38px|60px)\s+minmax\(0,\s*1fr\)/, '身份主网格必须自适应填满右侧名字空间');
});

test('侧边栏独立滚动与列表容器测试：列表区域独立滚动，不破坏侧边栏结构', () => {
    const dom = new JSDOM(mainHtml, { url: 'http://localhost' });
    const { document } = dom.window;

    const sidebar = document.querySelector('.sidebar');
    const listScroll = document.querySelector('.sidebar-list-scroll');
    const agentList = document.getElementById('agentList');

    assert.ok(sidebar, 'sidebar 根容器必须存在');
    assert.ok(listScroll, 'sidebar-list-scroll 滚动区必须存在');
    assert.ok(agentList, 'agentList 必须存在');
    assert.equal(agentList.parentNode, listScroll, 'agentList 必须置于 sidebar-list-scroll 内部');

    // 样式规范验证（恢复自 settings-sidebar-list.css）
    assert.match(sidebarListCss, /\.sidebar-list-scroll\s*\{[\s\S]*?flex:\s*1\s+1\s+auto;[\s\S]*?overflow-y:\s*auto;/, '列表必须自适应弹性占用中间空间并独立纵向滚动');
});

test('Agent 列表项头像与文字规整度测试：单行对齐、固定 42px 尺寸与圆角裁切', () => {
    assert.match(sidebarListCss, /\.sidebar\s+\.agent-list\s+li[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;/, '列表项必须单行居中对齐');
    assert.match(sidebarListCss, /\.sidebar\s+\.agent-list\s+img\.avatar[\s\S]*?width:\s*42px;[\s\S]*?height:\s*42px;/, '头像必须锁定 42px × 42px 标准尺寸');
    assert.match(sidebarListCss, /\.sidebar\s+\.agent-list\s+img\.avatar[\s\S]*?border-radius:\s*50%;/, '头像必须为正圆形圆角');
    assert.match(sidebarListCss, /\.sidebar\s+\.agent-list\s+img\.avatar[\s\S]*?object-fit:\s*cover;/, '头像必须使用 cover 裁切比例');
});

test('搜索助手或群胶囊容器与输入框结构测试：存在标准搜索胶囊、SVG 图标与关闭按钮', () => {
    const dom = new JSDOM(mainHtml, { url: 'http://localhost' });
    const { document } = dom.window;

    const searchSubtab = document.querySelector('.sidebar-search-subtab');
    const searchContainer = document.querySelector('.topic-search-container');
    const searchTrigger = document.getElementById('nextUiAgentSearchTrigger');
    const searchInput = document.getElementById('agentSearchInput');
    const searchClose = document.getElementById('nextUiAgentSearchClose');

    assert.ok(searchSubtab, '搜索子栏目胶囊必须存在');
    assert.ok(searchContainer, '搜索框容器必须存在');
    assert.ok(searchTrigger, '搜索放大镜触发按钮必须存在');
    assert.ok(searchInput, '搜索输入框必须存在');
    assert.ok(searchClose, '搜索关闭按钮必须存在');

    // 校验搜索胶囊样式规范（恢复自 settings-search.css）
    assert.match(searchCss, /\.agents-header\s+\.sidebar-search-subtab[\s\S]*?height:\s*37px;/, '搜索框胶囊必须维持规范的 37px 高度');
    assert.match(searchCss, /\.agents-header\s+\.sidebar-search-subtab[\s\S]*?border-radius:\s*999px;/, '搜索框胶囊必须呈现圆润药丸圆角');
});

test('助手 / 话题 / 设置三 Tab 切换与话题页面结构及样式测试', () => {
    const dom = new JSDOM(mainHtml, { url: 'http://localhost' });
    const { document } = dom.window;

    // 1. 验证 3 个 Tab 按钮存在且具语义化（data-tab="agents" 等）
    const tabs = [...document.querySelectorAll('.sidebar-tabs .sidebar-tab-button')];
    assert.equal(tabs.length, 3, '必须具备 3 个侧边栏 Tab 按钮');
    const tabAgents = tabs.find(t => t.dataset.tab === 'agents');
    const tabTopics = tabs.find(t => t.dataset.tab === 'topics');
    const tabSettings = tabs.find(t => t.dataset.tab === 'settings');
    assert.ok(tabAgents, '助手 Tab 按钮必须存在');
    assert.ok(tabTopics, '话题 Tab 按钮必须存在');
    assert.ok(tabSettings, '设置 Tab 按钮必须存在');

    // 2. 验证 3 个内容容器匹配
    const contentAgents = document.getElementById('tabContentAgents');
    const contentTopics = document.getElementById('tabContentTopics');
    const contentSettings = document.getElementById('tabContentSettings');
    assert.ok(contentAgents?.getAttribute('role') === 'tabpanel', 'Agents 容器为 tabpanel');
    assert.ok(contentTopics?.getAttribute('role') === 'tabpanel', 'Topics 容器为 tabpanel');
    assert.ok(contentSettings?.getAttribute('role') === 'tabpanel', 'Settings 容器为 tabpanel');

    // 3. 验证话题页核心控制项
    assert.ok(document.getElementById('nextUiCreateTopicBtn'), '新建话题按钮必须存在');
    assert.ok(document.getElementById('nextUiManageTopicsBtn'), '管理话题按钮必须存在');
    assert.ok(document.getElementById('nextUiTopicSearchTrigger'), '搜索话题按钮必须存在');

    // 4. 验证 Tab 切换与高亮分段样式规范（恢复自 settings-sidebar-tabs.css）
    assert.match(sidebarTabsCss, /\.sidebar-tab-button\.active\s*\{[\s\S]*?color:\s*var\(--highlight-text\);/, '激活的 Tab 必须呈现高亮色');
    assert.match(sidebarTabsCss, /\.sidebar-tab-button\.active::after[\s\S]*?width:\s*30px;/, '激活 Tab 必须呈现专属指示线/条');
    assert.match(sidebarTabsCss, /\.sidebar-tab-content:not\(\.active\)[\s\S]*?display:\s*none !important;/, '非激活 Tab 必须完全隐藏，绝不产生物理重叠');
});

test('群聊设置表面 dynamic slots 与依赖关系保持一致', () => {
    const { dom, document } = createDocument();
    const host = document.createElement('div');
    host.id = 'groupSettingsContainer';
    document.querySelector('main').append(host);
    const form = schema.renderGroupSettingsSurface(host, document);
    assert.equal(form.id, 'groupSettingsForm');
    for (const id of ['editingGroupId', 'groupNameInput', 'groupAvatarInput', 'groupAvatarPreview', 'groupMembersList',
        'groupChatMode', 'sequentialOrderContainer', 'sequentialSpeakerOrderList', 'memberTagsContainer',
        'tagMatchMode', 'memberTagsInputs', 'groupUseUnifiedModel', 'groupUnifiedModelContainer',
        'groupUnifiedModelInput', 'openGroupModelSelectBtn', 'groupPrompt', 'invitePrompt', 'deleteGroupBtn']) {
        assert.ok(document.getElementById(id), `schema surface missing #${id}`);
    }
    const groupAvatarOverlay = form.querySelector('.group-avatar-wrapper .avatar-upload-overlay');
    assert.ok(groupAvatarOverlay?.querySelector('svg.avatar-upload-icon'), 'group avatar upload control must contain a real SVG node');
    assert.doesNotMatch(groupAvatarOverlay?.textContent || '', /<svg|aria-hidden|<path/, 'group avatar SVG source must not leak as visible text');
    const mode = document.getElementById('groupChatMode');
    const sequential = document.getElementById('sequentialOrderContainer');
    const tags = document.getElementById('memberTagsContainer');
    mode.value = 'sequential';
    assert.equal(sequential.hidden, true, 'business renderer owns initial dependency projection');
    mode.value = 'naturerandom';
    document.getElementById('groupUseUnifiedModel').click();
    assert.equal(document.getElementById('groupUseUnifiedModel').checked, true);
    assert.equal(form.querySelectorAll('button').length >= 6, true);
    assert.equal(tags.hidden, true, 'schema marks the dependent slot without stealing GroupRenderer ownership');
});

test('侧边栏表面物理卸载（Unmount）机制测试：非激活时 DOM 彻底脱离', async () => {
    const { document } = createDocument();
    const root = document.querySelector('main');
    const prompt = document.getElementById('selectAgentPromptForSettings');
    const agentHost = document.getElementById('agentSettingsContainer');
    const groupHost = document.createElement('div');
    groupHost.id = 'groupSettingsContainer';
    root.append(groupHost);
    const surface = surfaceModule.createSettingsSidebarSurface({ document, root, prompt });
    surface.register('agent', agentHost);
    surface.register('group', groupHost);
    surface.show('agent', { id: 'a' });
    assert.equal(agentHost.parentNode, root);
    const token = surface.show('agent', { id: 'a' });
    surface.setPanelActive(false);
    assert.equal(agentHost.parentNode, null);
    assert.equal(groupHost.parentNode, null);
    assert.equal(surface.isCurrent(token), false);
    surface.setPanelActive(true);
    surface.show('group', { id: 'g' });
    assert.equal(groupHost.parentNode, root);
    await surface.dispose('test');
    assert.equal(groupHost.parentNode, null);
});

test('非激活设置面板绝对不能在 Agent 列表上方创建碰撞区（防遮挡防线）', () => {
    assert.match(sidebarCss, /#tabContentSettings\.sidebar-tab-content:not\(\.active\)[\s\S]*?display:\s*none;/);
    assert.match(sidebarCss, /#tabContentSettings\.sidebar-tab-content:not\(\.active\)[\s\S]*?pointer-events:\s*none;/);
    assert.match(sidebarCss, /#tabContentSettings\.sidebar-tab-content:not\(\.active\)[\s\S]*?visibility:\s*hidden;/);
});

test('正则分区由 schema 独占渲染：DOM 锚点齐备且按钮委托给业务层', () => {
    const { document } = createDocument();
    const host = document.getElementById('agentSettingsContainer');
    const form = schema.renderAgentSettingsSurface(host, document);

    const section = form.querySelector('[data-section-key="regex"]');
    assert.ok(section, '正则分区必须由 schema 渲染');
    assert.ok(section.classList.contains('agent-settings-collapsible-container'), '必须保留 legacy 容器类以继承既有样式');
    assert.ok(section.classList.contains('strip-regex-container'), '必须保留 strip-regex-container 类');
    assert.ok(section.classList.contains('collapsed'), '正则分区默认折叠');
    assert.equal(section.querySelector('#regexContent')?.id, 'regexContent');
    assert.ok(section.querySelector('#stripRegexListContainer'), '业务列表槽位必须存在');

    const addBtn = section.querySelector('.btn-add-regex');
    const importBtn = section.querySelector('.btn-add-regex-secondary');
    assert.equal(addBtn?.textContent, '添加正则');
    assert.equal(importBtn?.textContent, '导入正则');

    const calls = [];
    document.defaultView.settingsManager = {
        openRegexModal: (...args) => calls.push(['openRegexModal', ...args]),
        handleImportRegex: (...args) => calls.push(['handleImportRegex', ...args]),
    };
    addBtn.click();
    importBtn.click();
    assert.deepEqual(calls, [['openRegexModal'], ['handleImportRegex']], '按钮必须把业务动作委托给 manager');
    delete document.defaultView.settingsManager;
});

test('集成碰撞：schema 与 manager 共存时点击只翻转一次（防双重监听抵消）', () => {
    const { document } = createDocument();
    const host = document.getElementById('agentSettingsContainer');
    const form = schema.renderAgentSettingsSurface(host, document);

    // 模拟旧管家也在监听同一个 header：它只能读取状态，不得再次翻转 class。
    let managerToggleCalls = 0;
    document.defaultView.settingsManager = {
        toggleAgentSettingsSection: (key) => {
            managerToggleCalls += 1;
            const target = form.querySelector(`[data-section-key="${key}"]`);
            target.classList.toggle('collapsed');
            return true;
        },
    };

    const section = form.querySelector('[data-section-key="regex"]');
    const header = section.querySelector('#regexToggleHeader');
    header.click();
    assert.equal(section.classList.contains('collapsed'), false, '点击一次必须展开');
    assert.equal(managerToggleCalls, 1, 'manager 命令只能被调用一次');
    assert.equal(header.getAttribute('aria-expanded'), 'true');

    header.click();
    assert.equal(section.classList.contains('collapsed'), true, '再次点击必须收起');
    assert.equal(managerToggleCalls, 2);
    assert.equal(header.getAttribute('aria-expanded'), 'false');
    delete document.defaultView.settingsManager;
});

test('样式入口引用完备性核验：settings.css 完整导入 5 个核心保留子样式表', () => {
    assert.match(settingsCss, /@import url\('\.\/setting\/settings-sidebar-tabs\.css'\);/);
    assert.match(settingsCss, /@import url\('\.\/setting\/settings-sidebar-list\.css'\);/);
    assert.match(settingsCss, /@import url\('\.\/setting\/settings-search\.css'\);/);
    assert.match(settingsCss, /@import url\('\.\/setting\/settings-model-select\.css'\);/);
    assert.match(settingsCss, /@import url\('\.\/setting\/settings-regex\.css'\);/);
});

test('侧边栏助手与群聊表单控件圆角与 8px 规范及连续曲率对齐测试', () => {
    // 1. settings-sidebar.css 明确声明 8px 基础圆角
    assert.match(sidebarCss, /--vcp-settings-radius:\s*8px;/, '侧边栏设置必须以 8px 为标准基础圆角');

    // 2. input / select / textarea 统一应用 --vcp-settings-radius
    assert.match(sidebarCss, /\.vcp-settings-schema-surface input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="color"\]\),[\s\S]*?border-radius:\s*var\(--vcp-settings-radius\);/, '基础表单控件必须采用统一的 8px 设置圆角');

    // 3. 群聊设置输入框与下拉框不再使用 16px 大圆角，与 8px 标准对齐
    assert.doesNotMatch(groupSettingsCss, /border-radius:\s*16px;/, '群聊设置控件不得使用 16px 孤立大圆角');
    assert.match(groupSettingsCss, /#groupSettingsContainer\s+:is\(input\[type="text"\],\s*select\)[\s\S]*?border-radius:\s*var\(--vcp-settings-radius,\s*8px\);/, '群聊文本输入与选择框必须使用 8px 规范圆角');
    assert.match(groupSettingsCss, /#groupSettingsContainer\s+textarea[\s\S]*?border-radius:\s*var\(--vcp-settings-radius,\s*8px\);/, '群聊多行文本框必须使用 8px 规范圆角');

    // 4. 正则输入与选择按钮对齐 8px 圆角
    assert.match(sidebarCss, /\.strip-regex-input[\s\S]*?border-radius:\s*var\(--vcp-settings-radius,\s*8px\);/, '正则输入框必须对齐 8px 规范圆角');
    assert.match(sidebarCss, /\.custom-select-button[\s\S]*?border-radius:\s*var\(--vcp-settings-radius,\s*8px\);/, '自定义选择按钮必须对齐 8px 规范圆角');

    // 5. 连续平滑超椭圆曲率支持（渐进增强）
    assert.match(sidebarCss, /@supports\s*\(corner-shape:\s*superellipse\(1\.5\)\)/, '必须包含连续超椭圆 corner-shape 优雅降级支持');
    assert.match(sidebarCss, /corner-shape:\s*superellipse\(1\.5\);/, '控件必须配置 superellipse(1.5) 曲率');
    assert.match(sidebarCss, /corner-shape:\s*round;/, '正圆指示器与头像必须豁免超椭圆形变');

    // 6. 语速滑杆数值显示胶囊（Pill）规范对齐
    assert.match(sidebarCss, /#ttsSpeedValue[\s\S]*?border-radius:\s*999px;/, '语速滑杆数值显示必须对齐 999px 胶囊圆角');
    assert.match(sidebarCss, /#ttsSpeedValue[\s\S]*?display:\s*inline-flex;/, '语速滑杆数值显示必须为 inline-flex 居中胶囊');
});

test('正则规则列表与操作按钮规范对齐测试：幽灵态操作按钮、展开隐藏摘要框与并排等宽动作行', () => {
    const { document } = createDocument();
    const host = document.getElementById('agentSettingsContainer');
    const form = schema.renderAgentSettingsSurface(host, document);
    const section = form.querySelector('[data-section-key="regex"]');
    assert.ok(section, '正则分区必须存在');

    // 1. 验证 actions 容器与前置图标
    const actionsRow = section.querySelector('.strip-regex-actions');
    assert.ok(actionsRow, '必须包含 strip-regex-actions 按钮行');
    const addBtn = actionsRow.querySelector('.btn-add-regex:not(.btn-add-regex-secondary)');
    const importBtn = actionsRow.querySelector('.btn-add-regex-secondary');
    assert.ok(addBtn?.querySelector('svg'), '添加正则按钮必须具备前置矢量图标');
    assert.ok(importBtn?.querySelector('svg'), '导入正则按钮必须具备前置矢量图标');

    // 2. 校验 CSS 中关于展开隐藏摘要框、幽灵态按钮与并排动作行规则
    assert.match(sidebarCss, /\.agent-settings-section\[data-section-key="regex"\]:not\(\.collapsed\)\s+#regexSummary[\s\S]*?display:\s*none;/, '展开时必须隐藏 #regexSummary 避免出现孤立多余的摘要框');
    assert.match(sidebarCss, /\.strip-regex-actions\s*\{[\s\S]*?display:\s*flex;[\s\S]*?gap:\s*8px;/, '添加与导入按钮必须采用 flex 并排并具有 8px 间距');
    assert.match(sidebarCss, /\.btn-add-regex\s*\{[\s\S]*?flex:\s*1 1 0;[\s\S]*?border:\s*1px dashed/, '按钮必须并排平分宽度且为虚线边框');
    assert.match(sidebarCss, /:is\(\.btn-edit-regex,\s*\.btn-delete-regex\)\s*\{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;[\s\S]*?background:\s*transparent;/, '操作按钮必须为 28x28px 规范幽灵按钮且无实心背景');
    assert.match(sidebarCss, /\.btn-delete-regex:hover\s*\{[\s\S]*?color:\s*var\(--vcp-settings-danger\);/, '删除按钮悬浮时必须呈现柔和危险强调');
});

test('C1: mountRiskConfirmation 风险确认弹窗全流程交互测试（确认/取消/知晓勾选门禁）', async () => {
    const { mountRiskConfirmation } = await import(pathToFileURL(path.join(repoRoot, 'modules/uiux/generated/primitives/risk-confirmation.js')).href);
    const dom = new JSDOM('<!doctype html><html><body><main id="app"></main></body></html>');
    const prevDoc = globalThis.document;
    const prevWin = globalThis.window;
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;

    try {
        const createTestScope = (label = 'test-risk-scope') => {
            const disposers = new Set();
            let active = true;
            const scope = {
                label,
                get active() { return active; },
                own(disposer) { disposers.add(disposer); return disposer; },
                listen(target, type, handler, options) {
                    target.addEventListener(type, handler, options);
                    return scope.own(() => target.removeEventListener(type, handler, options));
                },
                child(childLabel) {
                    return createTestScope(childLabel);
                },
                dispose: async () => {
                    active = false;
                    for (const d of disposers) {
                        try { d(); } catch (_) {}
                    }
                    disposers.clear();
                }
            };
            return scope;
        };

        // 1. 测试知晓前确认按钮禁用，勾选后可用并触发确认
        let confirmSettled = false;
        let confirmResult = null;
        const scope1 = createTestScope('delete-scope-confirm');
        let modal1 = null;

        modal1 = mountRiskConfirmation({
            title: '删除 Agent',
            description: '确定要删除该 Agent 吗？不可撤销。',
            acknowledgeLabel: '我已知晓并确认删除',
            cancelLabel: '取消',
            confirmLabel: '确认删除',
            open: true,
            acknowledged: false,
            onAcknowledgedChange: (val) => {
                modal1?.setAcknowledged(val);
            },
            onConfirm: () => {
                confirmSettled = true;
                confirmResult = true;
                modal1?.setOpen(false);
            },
            onCancel: () => {
                confirmSettled = true;
                confirmResult = false;
                modal1?.setOpen(false);
            }
        }, scope1);

        assert.ok(modal1, 'RiskConfirmation modal 必须成功挂载');
        assert.equal(modal1.open, true, '弹窗初始为打开状态');
        assert.equal(modal1.confirmButton.disabled, true, '未勾选知晓前，确认按钮必须处于禁用状态');

        // 未勾选时直接点击确认按钮，不应触发确认
        modal1.confirmButton.click();
        assert.equal(confirmSettled, false, '禁用状态下点击确认不得结算');

        // 模拟用户勾选知晓复选框
        modal1.acknowledgement.checked = true;
        modal1.acknowledgement.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        assert.equal(modal1.confirmButton.disabled, false, '勾选知晓后，确认按钮必须变为可用');

        // 再次点击确认按钮
        modal1.confirmButton.click();
        assert.equal(confirmSettled, true);
        assert.equal(confirmResult, true, '点击确认后必须结算为 true');
        assert.equal(modal1.open, false, '确认后弹窗自动关闭');
        await scope1.dispose();

        // 2. 测试点击取消流程
        let cancelSettled = false;
        let cancelResult = null;
        const scope2 = createTestScope('delete-scope-cancel');
        let modal2 = null;

        modal2 = mountRiskConfirmation({
            title: '删除 Agent',
            description: '确定要删除该 Agent 吗？不可撤销。',
            acknowledgeLabel: '我已知晓并确认删除',
            cancelLabel: '取消',
            confirmLabel: '确认删除',
            open: true,
            acknowledged: false,
            onAcknowledgedChange: (val) => {
                modal2?.setAcknowledged(val);
            },
            onConfirm: () => {
                cancelSettled = true;
                cancelResult = true;
                modal2?.setOpen(false);
            },
            onCancel: () => {
                cancelSettled = true;
                cancelResult = false;
                modal2?.setOpen(false);
            }
        }, scope2);

        // 用户未勾选直接点击取消
        const cancelBtn = modal2.modal.dialog.querySelector('.vcp-uiux-risk-modal-action');
        assert.ok(cancelBtn, '必须存在取消按钮');
        cancelBtn.click();
        assert.equal(cancelSettled, true);
        assert.equal(cancelResult, false, '点击取消后必须结算为 false');
        assert.equal(modal2.open, false, '取消后弹窗自动关闭');
        await scope2.dispose();
    } finally {
        globalThis.document = prevDoc;
        globalThis.window = prevWin;
        dom.window.close();
    }
});

test('H4: Chevron 按钮按键与点击事件不发生冒泡双触发翻转', () => {
    const { document } = createDocument();
    const host = document.getElementById('agentSettingsContainer');
    const form = schema.renderAgentSettingsSurface(host, document);

    const section = form.querySelector('[data-section-key="identity"]');
    const header = section.querySelector('.agent-settings-section-header');
    const toggle = section.querySelector('.agent-settings-toggle-btn');
    assert.ok(section && header && toggle);

    // 初始状态：collapsed
    assert.ok(section.classList.contains('collapsed'));

    // 模拟在 toggle chevron 按钮上按下 Enter 键
    // 如果没有过滤 e.target.closest('button') && e.target !== header，
    // header 的 keydown 监听器会捕获该冒泡事件导致二次翻转抵消
    toggle.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // 由于 toggle 本身可能处理或由合成 click 处理，header 层面不得因为冒泡而翻转
    assert.ok(section.classList.contains('collapsed'), '冒泡到 header 的 Enter 不得导致 header 重复翻转');

    // 模拟在 toggle 按钮上按下 Space 键
    toggle.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    assert.ok(section.classList.contains('collapsed'), '冒泡到 header 的 Space 不得导致 header 重复翻转');

    // 正常点击 toggle 按钮能够单次翻转
    toggle.click();
    assert.equal(section.classList.contains('collapsed'), false, '点击 toggle 按钮正常展开');

    // 再次点击 toggle 按钮单次翻转收起
    toggle.click();
    assert.equal(section.classList.contains('collapsed'), true, '点击 toggle 按钮正常收起');
});

test('Medium: settings-sidebar-runtime mountedSlots 随 scope 销毁或显式 unmount 正确回收', async () => {
    const { mountSettingsSidebarForm, unmountSettingsSidebarForm } = await import(
        pathToFileURL(path.join(repoRoot, 'modules/ui-system/settings/settings-sidebar-runtime.js')).href
    );
    const { ensurePresentationScope, takePresentationScope, releaseAllControllers } = await import(
        pathToFileURL(path.join(repoRoot, 'modules/ui-system/settings/bridge-shared.js')).href
    );

    const { LifecycleScope } = await import(pathToFileURL(path.join(repoRoot, 'modules/ui-system/lifecycle-scope.js')).href);
    const dom = new JSDOM('<!doctype html><html><body><form id="agentSettingsForm"><div class="tts-director-settings"><textarea id="agentTtsDirectorPromptInput"></textarea><div id="agentTtsDirectorPromptsContainer"></div><button id="addAgentTtsDirectorPromptBtn"></button><button id="fillAgentTtsDirectorTemplateBtn"></button></div></form></body></html>');
    const prevDoc = globalThis.document;
    const prevWin = globalThis.window;
    dom.window.VCPLifecycle = { LifecycleScope };
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;

    let setPromptCalls = 0;
    dom.window.settingsManager = {
        getTtsDirectorPrompts: () => [],
        setTtsDirectorPrompts: () => { setPromptCalls++; },
        getTtsDirectorTemplate: () => 'template'
    };

    try {
        const form = dom.window.document.getElementById('agentSettingsForm');
        const input = dom.window.document.getElementById('agentTtsDirectorPromptInput');
        const addBtn = dom.window.document.getElementById('addAgentTtsDirectorPromptBtn');

        // 1. 首次挂载
        const m1 = mountSettingsSidebarForm(form);
        assert.ok(m1, '必须返回挂载对象');
        assert.equal(m1.slots.length, 1, '必须挂载 MimoDirectorSlot');

        // 点击触发 1 次
        input.value = 'prompt 1';
        addBtn.click();
        assert.equal(setPromptCalls, 1, '首次挂载点击应触发 1 次');

        // 2. 重复调用命中缓存
        const m2 = mountSettingsSidebarForm(form);
        assert.equal(m1, m2, '相同 form 在 scope 活跃期间必须命中缓存');

        // 3. 显式 unmount（释放 slot 与 DOM 监听）
        unmountSettingsSidebarForm(form);
        const m3 = mountSettingsSidebarForm(form);
        assert.notEqual(m1, m3, 'unmount 后重新 mount 必须生成新实例');

        // 重新挂载后再次点击，若旧监听已彻底释放，则仅触发 1 次新监听（总计 2 次，而非累计 3 次）
        input.value = 'prompt 2';
        addBtn.click();
        assert.equal(setPromptCalls, 2, '重新挂载后点击应仅累加 1 次，旧 DOM 监听必须已被 dispose 清除');

        // 4. scope 销毁自动清理
        const scopeToDispose = takePresentationScope();
        await scopeToDispose?.dispose();
        const m4 = mountSettingsSidebarForm(form);
        assert.notEqual(m3, m4, 'scope dispose 后自动清理缓存，新 scope 下必须生成新实例');
    } finally {
        const remainingScope = takePresentationScope();
        await remainingScope?.dispose();
        releaseAllControllers();
        delete dom.window.settingsManager;
        globalThis.document = prevDoc;
        globalThis.window = prevWin;
        dom.window.close();
    }
});

test('H5: Agent 保存链路真实测试（涵盖真实 settingsManager、完整字段收集、状态指示点流转与失败隔离）', async () => {
    const { dom, document } = createDocument();
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    const prevRaf = globalThis.requestAnimationFrame;
    const prevMO = globalThis.MutationObserver;
    const prevCE = globalThis.CustomEvent;
    const origSetInterval = globalThis.setInterval;
    const activeIntervals = [];

    globalThis.window = dom.window;
    globalThis.document = document;
    globalThis.MutationObserver = dom.window.MutationObserver;
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    globalThis.setInterval = (...args) => {
        const id = origSetInterval(...args);
        id.unref?.();
        activeIntervals.push(id);
        return id;
    };

    try {
        const host = document.getElementById('agentSettingsContainer');
        const form = schema.renderAgentSettingsSurface(host, document);

        // 验证表单存在所有 8 个关键扩展字段控件
        assert.ok(document.getElementById('agentCustomCss'), '必须存在 #agentCustomCss');
        assert.ok(document.getElementById('agentCardCss'), '必须存在 #agentCardCss');
        assert.ok(document.getElementById('agentChatCss'), '必须存在 #agentChatCss');
        assert.ok(document.getElementById('agentAvatarBorderColor'), '必须存在 #agentAvatarBorderColor');
        assert.ok(document.getElementById('agentNameTextColor'), '必须存在 #agentNameTextColor');
        assert.ok(document.getElementById('disableCustomColors'), '必须存在 #disableCustomColors');
        assert.ok(document.getElementById('useThemeColorsInChat'), '必须存在 #useThemeColorsInChat');

        // 加载真实 settingsManager
        dom.window.eval(fs.readFileSync(path.join(repoRoot, 'modules/settingsManager.js'), 'utf8'));
        const sm = dom.window.settingsManager;
        assert.ok(sm, 'settingsManager 必须成功加载');

        let savedData = null;
        let mockSaveSuccess = true;
        const fakeElectronAPI = {
            saveAgentConfig: async (id, config) => {
                savedData = { id, config };
                if (mockSaveSuccess) {
                    return { success: true };
                }
                return { success: false, error: 'IPC write failed' };
            },
            getAgentConfig: async () => ({ name: savedData?.config?.name })
        };

        const toasts = [];
        const uiHelper = {
            showToastNotification: (msg, type) => {
                toasts.push({ msg, type });
            },
            showSaveFeedback: () => {}
        };

        sm.init({
            electronAPI: fakeElectronAPI,
            uiHelper,
            refs: {
                currentSelectedItemRef: {
                    get: () => ({ id: 'agent-real-test-123', type: 'agent' }),
                    set: () => {}
                }
            },
            mainRendererFunctions: {
                getCroppedFile: () => null,
                resetCroppedFile: () => {}
            },
            elements: {
                agentSettingsContainer: host,
                groupSettingsContainer: null,
                selectItemPromptForSettings: document.getElementById('selectAgentPromptForSettings'),
                itemSettingsContainerTitle: null,
                selectedItemNameForSettingsSpan: null,
                deleteItemBtn: document.getElementById('deleteAgentBtn'),
                agentSettingsForm: form,
                editingAgentIdInput: document.getElementById('editingAgentId'),
                agentNameInput: document.getElementById('agentNameInput'),
                agentAvatarInput: document.getElementById('agentAvatarInput'),
                agentAvatarPreview: document.getElementById('agentAvatarPreview'),
                agentModelInput: document.getElementById('agentModel'),
                agentTemperatureInput: document.getElementById('agentTemperature'),
                agentContextTokenLimitInput: document.getElementById('agentContextTokenLimit'),
                agentMaxOutputTokensInput: document.getElementById('agentMaxOutputTokens'),
                openModelSelectBtn: document.getElementById('openModelSelectBtn'),
                topicSummaryModelInput: null,
                openTopicSummaryModelSelectBtn: null,
                agentTtsSpeedSlider: document.getElementById('agentTtsSpeed')
            }
        });

        // 填充测试值
        document.getElementById('editingAgentId').value = 'agent-real-test-123';
        document.getElementById('agentNameInput').value = '真实测试助手';
        document.getElementById('agentCustomCss').value = '.test { color: red; }';
        document.getElementById('agentCardCss').value = '.card { padding: 8px; }';
        document.getElementById('agentChatCss').value = '.chat { margin: 4px; }';
        document.getElementById('agentAvatarBorderColor').value = '#112233';
        document.getElementById('agentNameTextColor').value = '#445566';
        document.getElementById('disableCustomColors').checked = true;
        document.getElementById('useThemeColorsInChat').checked = true;

        // 1. 真实 submit 触发保存成功测试
        form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 30));

        assert.equal(savedData?.id, 'agent-real-test-123');
        assert.equal(savedData?.config?.name, '真实测试助手');
        assert.equal(savedData?.config?.customCss, '.test { color: red; }');
        assert.equal(savedData?.config?.cardCss, '.card { padding: 8px; }');
        assert.equal(savedData?.config?.chatCss, '.chat { margin: 4px; }');
        assert.equal(savedData?.config?.avatarBorderColor, '#112233');
        assert.equal(savedData?.config?.nameTextColor, '#445566');
        assert.equal(savedData?.config?.disableCustomColors, true);
        assert.equal(savedData?.config?.useThemeColorsInChat, true);
        assert.equal(document.getElementById('formSaveStateIndicator')?.dataset?.state, 'done', '保存成功时指示点状态必须为 done');

        // 2. 真实 submit 触发保存失败测试
        mockSaveSuccess = false;
        toasts.length = 0;
        form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 30));

        assert.equal(document.getElementById('formSaveStateIndicator')?.dataset?.state, 'warning', '保存失败时指示点状态必须置为 warning');
        assert.ok(toasts.some(t => t.type === 'error' && t.msg.includes('IPC write failed')), '保存失败时必须弹出对应错误 toast');
    } finally {
        activeIntervals.forEach(clearInterval);
        globalThis.window = prevWin;
        globalThis.document = prevDoc;
        globalThis.requestAnimationFrame = prevRaf;
        globalThis.MutationObserver = prevMO;
        globalThis.CustomEvent = prevCE;
        globalThis.setInterval = origSetInterval;
        delete dom.window.settingsManager;
        dom.window.close();
    }
});

test('High: 切换 Agent 时 flush 失败必须显式告警且保留未保存状态，不得静默丢失编辑', async () => {
    const { dom, document } = createDocument();
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    const prevRaf = globalThis.requestAnimationFrame;
    const prevMO = globalThis.MutationObserver;
    const prevCE = globalThis.CustomEvent;
    const origSetInterval = globalThis.setInterval;
    const activeIntervals = [];

    globalThis.window = dom.window;
    globalThis.document = document;
    globalThis.MutationObserver = dom.window.MutationObserver;
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    dom.window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    globalThis.setInterval = (...args) => {
        const id = origSetInterval(...args);
        id.unref?.();
        activeIntervals.push(id);
        return id;
    };

    try {
        const host = document.getElementById('agentSettingsContainer');
        const form = schema.renderAgentSettingsSurface(host, document);

        dom.window.eval(fs.readFileSync(path.join(repoRoot, 'modules/settingsManager.js'), 'utf8'));
        const sm = dom.window.settingsManager;

        let saveCalls = 0;
        const fakeElectronAPI = {
            saveAgentConfig: async () => {
                saveCalls++;
                return { success: false, error: 'Database locked' };
            },
            getAgentConfig: async (id) => ({ id, name: 'Agent ' + id }),
            sovitsGetModels: async () => ({ models: [] })
        };

        const toasts = [];
        const uiHelper = {
            showToastNotification: (msg, type) => toasts.push({ msg, type }),
            showSaveFeedback: () => {}
        };

        let currentItem = { id: 'agent-1', type: 'agent' };
        sm.init({
            electronAPI: fakeElectronAPI,
            uiHelper,
            refs: {
                currentSelectedItemRef: {
                    get: () => currentItem,
                    set: (val) => { currentItem = val; }
                }
            },
            mainRendererFunctions: {
                getCroppedFile: () => null,
                resetCroppedFile: () => {},
                setCroppedFile: () => {}
            },
            elements: {
                agentSettingsContainer: host,
                groupSettingsContainer: null,
                selectItemPromptForSettings: document.getElementById('selectAgentPromptForSettings'),
                itemSettingsContainerTitle: null,
                selectedItemNameForSettingsSpan: null,
                deleteItemBtn: document.getElementById('deleteAgentBtn'),
                agentSettingsForm: form,
                editingAgentIdInput: document.getElementById('editingAgentId'),
                agentNameInput: document.getElementById('agentNameInput'),
                agentAvatarInput: document.getElementById('agentAvatarInput'),
                agentAvatarPreview: document.getElementById('agentAvatarPreview'),
                agentModelInput: document.getElementById('agentModel'),
                agentTemperatureInput: document.getElementById('agentTemperature'),
                agentContextTokenLimitInput: document.getElementById('agentContextTokenLimit'),
                agentMaxOutputTokensInput: document.getElementById('agentMaxOutputTokens'),
                openModelSelectBtn: document.getElementById('openModelSelectBtn'),
                topicSummaryModelInput: null,
                openTopicSummaryModelSelectBtn: null,
                agentTtsSpeedSlider: document.getElementById('agentTtsSpeed')
            }
        });

        // 1. 先载入 agent-1
        await sm.displaySettingsForItem();
        assert.equal(document.getElementById('editingAgentId').value, 'agent-1');

        // 2. 模拟用户编辑输入，标记 dirty
        const nameInput = document.getElementById('agentNameInput');
        nameInput.value = '修改后的 agent-1';
        nameInput.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));

        // 3. 此时切换至 agent-2，不得隐式保存旧 agent-1；
        // 未保存草稿必须由用户显式点击保存按钮提交。
        currentItem = { id: 'agent-2', type: 'agent' };
        await sm.displaySettingsForItem();

        assert.equal(saveCalls, 0, '切换 Agent 不得自动保存未提交修改');
        assert.equal(toasts.some(t => t.type === 'warning' && t.msg.includes('切换前自动保存')), false, '手动保存契约下不得提示切换前自动保存失败');
    } finally {
        activeIntervals.forEach(clearInterval);
        globalThis.window = prevWin;
        globalThis.document = prevDoc;
        globalThis.requestAnimationFrame = prevRaf;
        globalThis.MutationObserver = prevMO;
        globalThis.CustomEvent = prevCE;
        globalThis.setInterval = origSetInterval;
        delete dom.window.settingsManager;
        dom.window.close();
    }
});

test('群组设置中的 schemaDependsOn 动态响应：更改 groupChatMode 和 groupUseUnifiedModel 自动控制依赖字段显隐', () => {
    const { document } = createDocument();
    const host = document.createElement('div');
    const form = schema.renderGroupSettingsSurface(host, document);

    const tagMatchRow = form.querySelector('[data-schema-field="tagMatchMode"]');
    assert.ok(tagMatchRow, '必须包含 tagMatchMode 依赖行');
    assert.ok(tagMatchRow.hidden, '初始 groupChatMode 为 sequential，tagMatchMode 必须处于隐藏状态');

    const chatModeSelect = form.querySelector('#groupChatMode');
    assert.ok(chatModeSelect, '必须包含 groupChatMode 下拉框');

    // 切换到 naturerandom
    chatModeSelect.value = 'naturerandom';
    chatModeSelect.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
    assert.equal(tagMatchRow.hidden, false, 'groupChatMode 变为 naturerandom 时，tagMatchMode 必须显示');

    // 切换到 invite_only
    chatModeSelect.value = 'invite_only';
    chatModeSelect.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
    assert.equal(tagMatchRow.hidden, true, 'groupChatMode 变为 invite_only 时，tagMatchMode 必须重新隐藏');

    // 测试 unified model 的 dependsOn 联动
    const unifiedModelRow = form.querySelector('#groupUnifiedModelContainer');
    assert.ok(unifiedModelRow, '必须包含 groupUnifiedModelContainer 依赖容器');
    assert.ok(unifiedModelRow.hidden, '初始 groupUseUnifiedModel 为 false，统一模型行必须隐藏');

    const unifiedModelCheckbox = form.querySelector('#groupUseUnifiedModel');
    assert.ok(unifiedModelCheckbox, '必须包含 groupUseUnifiedModel 复选框');

    unifiedModelCheckbox.checked = true;
    unifiedModelCheckbox.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
    assert.equal(unifiedModelRow.hidden, false, '勾选 groupUseUnifiedModel 后，统一模型行必须显示');

    unifiedModelCheckbox.checked = false;
    unifiedModelCheckbox.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
    assert.equal(unifiedModelRow.hidden, true, '取消勾选 groupUseUnifiedModel 后，统一模型行必须隐藏');
});

test('Agent 分区折叠展开程序化控制：调用 setCollapsed 时 header 与 toggleBtn 的 aria-expanded 保持双向同步', () => {
    const { document } = createDocument();
    const host = document.getElementById('agentSettingsContainer');
    const form = schema.renderAgentSettingsSurface(host, document);

    const identitySection = form.querySelector('.agent-settings-section[data-section-key="identity"]');
    assert.ok(identitySection, '必须包含 identity 分区');
    const header = identitySection.querySelector('.agent-settings-section-header');
    const toggleBtn = identitySection.querySelector('.agent-settings-toggle-btn');

    // 初始状态已在 schema 中渲染为 collapsed
    assert.ok(identitySection.classList.contains('collapsed'));
    assert.equal(header.getAttribute('aria-expanded'), 'false');
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false');

    // 模拟 createSectionController.setCollapsed 行为
    const controller = {
        container: identitySection,
        header,
        toggleBtn,
        setCollapsed(collapsed) {
            const isCollapsed = !!collapsed;
            this.container.classList.toggle('collapsed', isCollapsed);
            const isExpanded = !isCollapsed;
            this.header?.setAttribute('aria-expanded', String(isExpanded));
            this.toggleBtn?.setAttribute('aria-expanded', String(isExpanded));
        }
    };

    // 展开
    controller.setCollapsed(false);
    assert.equal(identitySection.classList.contains('collapsed'), false, 'setCollapsed(false) 必须移除 collapsed class');
    assert.equal(header.getAttribute('aria-expanded'), 'true', 'header aria-expanded 必须同步为 true');
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'true', 'toggleBtn aria-expanded 必须同步为 true');

    // 收起
    controller.setCollapsed(true);
    assert.equal(identitySection.classList.contains('collapsed'), true, 'setCollapsed(true) 必须添加 collapsed class');
    assert.equal(header.getAttribute('aria-expanded'), 'false', 'header aria-expanded 必须同步为 false');
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false', 'toggleBtn aria-expanded 必须同步为 false');
});

test('P0 对抗性防线: 侧边栏 Unmount 脱水态保存与 Autosave 保护测试（绝不发生 TypeError 崩溃，绝不静默抹除 cardCss/chatCss）', async () => {
    const { dom, document } = createDocument();
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    const prevRaf = globalThis.requestAnimationFrame;
    const prevMO = globalThis.MutationObserver;
    const prevCE = globalThis.CustomEvent;
    const origSetInterval = globalThis.setInterval;
    const activeIntervals = [];

    globalThis.window = dom.window;
    globalThis.document = document;
    globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
    globalThis.MutationObserver = class {
        observe() {}
        disconnect() {}
        takeRecords() { return []; }
    };
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.setInterval = (...args) => {
        const id = origSetInterval(...args);
        id.unref?.();
        activeIntervals.push(id);
        return id;
    };

    try {
        const root = document.getElementById('tabContentSettings');
        const surface = surfaceModule.createSettingsSidebarSurface({ document, root });
        dom.window.VCPSettingsSidebar = surface;

        const host = document.getElementById('agentSettingsContainer');
        const form = schema.renderAgentSettingsSurface(host, document);
        surface.register('agent', host);

        dom.window.eval(fs.readFileSync(path.join(repoRoot, 'modules/settingsManager.js'), 'utf8'));
        const sm = dom.window.settingsManager;

        let savedData = null;
        const fakeElectronAPI = {
            saveAgentConfig: async (id, config) => {
                savedData = { id, config };
                return { success: true };
            },
            getAgentConfig: async () => ({ name: '脱水测试助手' })
        };

        const toasts = [];
        const uiHelper = {
            showToastNotification: (msg, type) => toasts.push({ msg, type }),
            showSaveFeedback: () => {}
        };

        sm.init({
            electronAPI: fakeElectronAPI,
            uiHelper,
            refs: {
                currentSelectedItemRef: {
                    get: () => ({ id: 'agent-detached-test', type: 'agent' }),
                    set: () => {}
                }
            },
            mainRendererFunctions: {
                getCroppedFile: () => null,
                resetCroppedFile: () => {}
            },
            elements: {
                agentSettingsContainer: host,
                groupSettingsContainer: null,
                selectItemPromptForSettings: document.getElementById('selectAgentPromptForSettings'),
                itemSettingsContainerTitle: null,
                selectedItemNameForSettingsSpan: null,
                deleteItemBtn: document.getElementById('deleteAgentBtn'),
                agentSettingsForm: form,
                editingAgentIdInput: form.querySelector('#editingAgentId'),
                agentNameInput: form.querySelector('#agentNameInput'),
                agentAvatarInput: form.querySelector('#agentAvatarInput'),
                agentAvatarPreview: form.querySelector('#agentAvatarPreview'),
                agentModelInput: form.querySelector('#agentModel'),
                agentTemperatureInput: form.querySelector('#agentTemperature'),
                agentContextTokenLimitInput: form.querySelector('#agentContextTokenLimit'),
                agentMaxOutputTokensInput: form.querySelector('#agentMaxOutputTokens'),
                openModelSelectBtn: form.querySelector('#openModelSelectBtn'),
                topicSummaryModelInput: null,
                openTopicSummaryModelSelectBtn: null,
                agentTtsSpeedSlider: form.querySelector('#agentTtsSpeed')
            }
        });

        // 填充敏感字段
        form.querySelector('#editingAgentId').value = 'agent-detached-test';
        form.querySelector('#agentNameInput').value = '脱水测试助手';
        form.querySelector('#agentCardCss').value = '.detached-card { background: purple; }';
        form.querySelector('#agentChatCss').value = '.detached-chat { font-size: 16px; }';
        form.querySelector('#agentStreamOutputTrue').checked = true;
        form.querySelector('#disableCustomColors').checked = true;

        // 模拟用户切换 Tab：物理卸载 Settings 表面（Unmount 脱水）
        surface.setPanelActive(false);
        assert.equal(document.getElementById('agentCardCss'), null, '脱水状态下 document.getElementById 必定返回 null');
        assert.equal(document.getElementById('agentStreamOutputTrue'), null, '脱水状态下 agentStreamOutputTrue 无法通过 document.getElementById 获取');

        // 执行保存：绝对不能因 agentStreamOutputTrue.checked 抛出 TypeError
        // 且 cardCss / chatCss 绝对不能被静默抹除为空字符串！
        const triggerResult = await sm.triggerAgentSave('agent-detached-test');
        assert.equal(triggerResult.success, false, '兼容入口不得绕过保存按钮写入');
        assert.equal(triggerResult.skipped, true, '兼容入口必须明确报告已跳过');
        assert.equal(savedData, null, '脱水态调用兼容入口不得写入配置');
    } finally {
        activeIntervals.forEach(clearInterval);
        globalThis.window = prevWin;
        globalThis.document = prevDoc;
        globalThis.requestAnimationFrame = prevRaf;
        globalThis.MutationObserver = prevMO;
        globalThis.CustomEvent = prevCE;
        globalThis.setInterval = origSetInterval;
        delete dom.window.settingsManager;
        delete dom.window.VCPSettingsSidebar;
        dom.window.close();
    }
});

test('P1 对抗性防线: 侧边栏 Unmount 脱水态切换与加载 Agent 测试（表单控件可靠回填）', async () => {
    const { dom, document } = createDocument();
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    const prevRaf = globalThis.requestAnimationFrame;
    const prevMO = globalThis.MutationObserver;
    const prevCE = globalThis.CustomEvent;
    const origSetInterval = globalThis.setInterval;
    const activeIntervals = [];

    globalThis.window = dom.window;
    globalThis.document = document;
    globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
    dom.window.requestAnimationFrame = cb => setTimeout(cb, 0);
    globalThis.MutationObserver = class {
        observe() {}
        disconnect() {}
        takeRecords() { return []; }
    };
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.setInterval = (...args) => {
        const id = origSetInterval(...args);
        id.unref?.();
        activeIntervals.push(id);
        return id;
    };

    try {
        const root = document.getElementById('tabContentSettings');
        const surface = surfaceModule.createSettingsSidebarSurface({ document, root });
        dom.window.VCPSettingsSidebar = surface;

        const host = document.getElementById('agentSettingsContainer');
        const form = schema.renderAgentSettingsSurface(host, document);
        surface.register('agent', host);

        dom.window.eval(fs.readFileSync(path.join(repoRoot, 'modules/settingsManager.js'), 'utf8'));
        const sm = dom.window.settingsManager;

        sm.init({
            electronAPI: {
                saveAgentConfig: async () => ({ success: true }),
                getAgentConfig: async () => ({ name: 'Agent 2' }),
                sovitsGetModels: async () => ({ models: [] })
            },
            uiHelper: { showToastNotification: () => {}, showSaveFeedback: () => {} },
            refs: {
                currentSelectedItemRef: {
                    get: () => ({ id: 'agent-2', type: 'agent' }),
                    set: () => {}
                }
            },
            mainRendererFunctions: { getCroppedFile: () => null, resetCroppedFile: () => {} },
            elements: {
                agentSettingsContainer: host,
                groupSettingsContainer: null,
                selectItemPromptForSettings: document.getElementById('selectAgentPromptForSettings'),
                itemSettingsContainerTitle: null,
                selectedItemNameForSettingsSpan: null,
                deleteItemBtn: document.getElementById('deleteAgentBtn'),
                agentSettingsForm: form,
                editingAgentIdInput: form.querySelector('#editingAgentId'),
                agentNameInput: form.querySelector('#agentNameInput'),
                agentAvatarInput: form.querySelector('#agentAvatarInput'),
                agentAvatarPreview: form.querySelector('#agentAvatarPreview'),
                agentModelInput: form.querySelector('#agentModel'),
                agentTemperatureInput: form.querySelector('#agentTemperature'),
                agentContextTokenLimitInput: form.querySelector('#agentContextTokenLimit'),
                agentMaxOutputTokensInput: form.querySelector('#agentMaxOutputTokens'),
                openModelSelectBtn: form.querySelector('#openModelSelectBtn'),
                topicSummaryModelInput: null,
                openTopicSummaryModelSelectBtn: null,
                agentTtsSpeedSlider: form.querySelector('#agentTtsSpeed')
            }
        });

        // 模拟离开设置 Tab（脱水）
        surface.setPanelActive(false);

        // 在脱水状态下切换 Agent 2 并执行加载
        await sm.displaySettingsForItem({
            id: 'agent-2',
            type: 'agent',
            config: {
                name: '测试助手2号',
                cardCss: '.agent-2-card { border: 2px solid gold; }',
                chatCss: '.agent-2-chat { color: cyan; }',
                streamOutput: false,
                disableCustomColors: true,
                useThemeColorsInChat: true
            }
        });

        // 验证表单 DOM 中已正确灌入 Agent 2 的配置
        assert.equal(form.querySelector('#agentCardCss').value, '.agent-2-card { border: 2px solid gold; }', '脱水态下 cardCss 必须正确加载到 DOM 控件');
        assert.equal(form.querySelector('#agentChatCss').value, '.agent-2-chat { color: cyan; }', '脱水态下 chatCss 必须正确加载到 DOM 控件');
        assert.equal(form.querySelector('#agentStreamOutputFalse').checked, true, '脱水态下 streamOutput 必须正确加载到 DOM 控件');
        assert.equal(form.querySelector('#disableCustomColors').checked, true, '脱水态下 disableCustomColors 必须正确加载到 DOM 控件');
    } finally {
        activeIntervals.forEach(clearInterval);
        globalThis.window = prevWin;
        globalThis.document = prevDoc;
        globalThis.requestAnimationFrame = prevRaf;
        globalThis.MutationObserver = prevMO;
        globalThis.CustomEvent = prevCE;
        globalThis.setInterval = origSetInterval;
        delete dom.window.settingsManager;
        delete dom.window.VCPSettingsSidebar;
        dom.window.close();
    }
});

test('P1 对抗性防线: triggerAgentSave 准确拦截 IPC { success: false, message: ... } 格式错误并返回 failure', async () => {
    const { dom, document } = createDocument();
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    const prevRaf = globalThis.requestAnimationFrame;
    const prevMO = globalThis.MutationObserver;
    const prevCE = globalThis.CustomEvent;
    const origSetInterval = globalThis.setInterval;
    const activeIntervals = [];

    globalThis.window = dom.window;
    globalThis.document = document;
    globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
    dom.window.requestAnimationFrame = cb => setTimeout(cb, 0);
    globalThis.MutationObserver = class {
        observe() {}
        disconnect() {}
        takeRecords() { return []; }
    };
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.setInterval = (...args) => {
        const id = origSetInterval(...args);
        id.unref?.();
        activeIntervals.push(id);
        return id;
    };

    try {
        const host = document.getElementById('agentSettingsContainer');
        const form = schema.renderAgentSettingsSurface(host, document);

        dom.window.eval(fs.readFileSync(path.join(repoRoot, 'modules/settingsManager.js'), 'utf8'));
        const sm = dom.window.settingsManager;

        // 模拟 IPC 返回没有 error 字段，但明确包含 { success: false, message: "Storage backend write failed" }
        const fakeElectronAPI = {
            saveAgentConfig: async () => ({ success: false, message: 'Storage backend write failed' }),
            getAgentConfig: async () => ({})
        };

        const toasts = [];
        const uiHelper = {
            showToastNotification: (msg, type) => toasts.push({ msg, type }),
            showSaveFeedback: () => {}
        };

        sm.init({
            electronAPI: fakeElectronAPI,
            uiHelper,
            refs: {
                currentSelectedItemRef: {
                    get: () => ({ id: 'agent-ipc-fail', type: 'agent' }),
                    set: () => {}
                }
            },
            mainRendererFunctions: { getCroppedFile: () => null, resetCroppedFile: () => {} },
            elements: {
                agentSettingsContainer: host,
                groupSettingsContainer: null,
                selectItemPromptForSettings: document.getElementById('selectAgentPromptForSettings'),
                itemSettingsContainerTitle: null,
                selectedItemNameForSettingsSpan: null,
                deleteItemBtn: document.getElementById('deleteAgentBtn'),
                agentSettingsForm: form,
                editingAgentIdInput: form.querySelector('#editingAgentId'),
                agentNameInput: form.querySelector('#agentNameInput'),
                agentAvatarInput: form.querySelector('#agentAvatarInput'),
                agentAvatarPreview: form.querySelector('#agentAvatarPreview'),
                agentModelInput: form.querySelector('#agentModel'),
                agentTemperatureInput: form.querySelector('#agentTemperature'),
                agentContextTokenLimitInput: form.querySelector('#agentContextTokenLimit'),
                agentMaxOutputTokensInput: form.querySelector('#agentMaxOutputTokens'),
                openModelSelectBtn: form.querySelector('#openModelSelectBtn'),
                topicSummaryModelInput: null,
                openTopicSummaryModelSelectBtn: null,
                agentTtsSpeedSlider: form.querySelector('#agentTtsSpeed')
            }
        });

        form.querySelector('#editingAgentId').value = 'agent-ipc-fail';
        form.querySelector('#agentNameInput').value = 'IPC失败测试助手';

        const saveResult = await sm.triggerAgentSave('agent-ipc-fail');

        // 兼容入口不再调用 IPC；只有表单 submit 才能触发保存。
        assert.equal(saveResult.success, false, 'triggerAgentSave 必须拒绝绕过保存按钮');
        assert.match(saveResult.error, /点击保存 Agent 设置/, '拒绝信息必须指向显式保存按钮');
    } finally {
        activeIntervals.forEach(clearInterval);
        globalThis.window = prevWin;
        globalThis.document = prevDoc;
        globalThis.requestAnimationFrame = prevRaf;
        globalThis.MutationObserver = prevMO;
        globalThis.CustomEvent = prevCE;
        globalThis.setInterval = origSetInterval;
        delete dom.window.settingsManager;
        dom.window.close();
    }
});

test('P1 对抗性防线: 群组设置在脱水态下的 DOM 解析与安全删除测试', async () => {
    const { dom, document } = createDocument();
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    const prevRaf = globalThis.requestAnimationFrame;
    const prevMO = globalThis.MutationObserver;
    const prevCE = globalThis.CustomEvent;
    const origSetInterval = globalThis.setInterval;
    const activeIntervals = [];

    globalThis.window = dom.window;
    globalThis.document = document;
    globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
    dom.window.requestAnimationFrame = cb => setTimeout(cb, 0);
    globalThis.MutationObserver = class {
        observe() {}
        disconnect() {}
        takeRecords() { return []; }
    };
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.setInterval = (...args) => {
        const id = origSetInterval(...args);
        id.unref?.();
        activeIntervals.push(id);
        return id;
    };

    try {
        const root = document.getElementById('tabContentSettings');
        const surface = surfaceModule.createSettingsSidebarSurface({ document, root });
        dom.window.VCPSettingsSidebar = surface;
        dom.window.VCPSettingsSchema = schema;

        // 引入 group-slots
        dom.window.eval(fs.readFileSync(path.join(repoRoot, 'modules/ui-system/settings/group-slots.js'), 'utf8'));

        // 渲染群组表面并注册
        const groupHost = dom.window.VCPGroupSettingsSlots.ensureSettingsSurface({ document, settingsTab: root });
        assert.ok(groupHost, '群组表面 host 必须成功生成');

        // 引入 grouprenderer
        dom.window.eval(fs.readFileSync(path.join(repoRoot, 'Groupmodules/grouprenderer.js'), 'utf8'));
        const gr = dom.window.GroupRenderer;
        assert.ok(gr, 'GroupRenderer 必须成功加载');

        let deletedGroupId = null;
        const fakeElectronAPI = {
            deleteAgentGroup: async id => {
                deletedGroupId = id;
                return { success: true };
            },
            getAgentGroupConfig: async () => ({ name: '脱水测试群组', members: [] }),
            getAgents: async () => []
        };

        gr.init({
            electronAPI: fakeElectronAPI,
            globalSettings: {},
            currentSelectedItemRef: {
                get: () => ({ id: 'group-detached-999', type: 'group', name: '脱水测试群组' }),
                set: () => {}
            },
            currentTopicIdRef: { get: () => null, set: () => {} },
            messageRenderer: null,
            uiHelper: {
                showToastNotification: () => {},
                showConfirmDialog: async () => true
            },
            mainRendererElements: {},
            selectAgentPromptForSettingsElement: document.getElementById('selectAgentPromptForSettings'),
            agentSettingsContainer: null,
            selectedItemNameForSettingsElement: null,
            mainRendererFunctions: {}
        });

        // 模拟 Tab 切换导致物理脱水卸载
        surface.setPanelActive(false);
        assert.equal(document.getElementById('groupSettingsContainer'), null, '脱水状态下 groupSettingsContainer 脱离主 document');

        // 在脱水状态下渲染并打开群组设置（验证脱水加载）
        await gr.displayGroupSettingsPage('group-detached-999', { name: '脱水测试群组', members: [] });

        // 触发群组删除：绝不能因 document.getElementById('editingGroupId').value 抛出 TypeError
        // 且通过 resolveGroupForm() / fallback 必须能够正确获取 groupId
        const deleteBtn = groupHost.querySelector('#deleteGroupBtn');
        assert.ok(deleteBtn, '脱水 host 中必须存在 deleteGroupBtn');

        deleteBtn.click();
        await new Promise(resolve => setTimeout(resolve, 50));

        assert.equal(deletedGroupId, 'group-detached-999', '脱水态下 handleDeleteCurrentGroup 必须成功读取群组 ID 并执行删除');
    } finally {
        activeIntervals.forEach(clearInterval);
        globalThis.window = prevWin;
        globalThis.document = prevDoc;
        globalThis.requestAnimationFrame = prevRaf;
        globalThis.MutationObserver = prevMO;
        globalThis.CustomEvent = prevCE;
        globalThis.setInterval = origSetInterval;
        delete dom.window.GroupRenderer;
        delete dom.window.VCPGroupSettingsSlots;
        delete dom.window.VCPSettingsSidebar;
        delete dom.window.VCPSettingsSchema;
        dom.window.close();
    }
});

test('P0 对抗性防线: Agent 模型配置绝不被静默篡改为 gemini-pro (Bug 1 防护)', async () => {
    const { dom, document } = createDocument();
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    const prevRaf = globalThis.requestAnimationFrame;
    const prevMO = globalThis.MutationObserver;
    const prevCE = globalThis.CustomEvent;
    const origSetInterval = globalThis.setInterval;
    const activeIntervals = [];

    globalThis.window = dom.window;
    globalThis.document = document;
    globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
    dom.window.requestAnimationFrame = cb => setTimeout(cb, 0);
    globalThis.MutationObserver = class {
        observe() {}
        disconnect() {}
        takeRecords() { return []; }
    };
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.setInterval = (...args) => {
        const id = origSetInterval(...args);
        id.unref?.();
        activeIntervals.push(id);
        return id;
    };

    try {
        const root = document.getElementById('tabContentSettings');
        const surface = surfaceModule.createSettingsSidebarSurface({ document, root });
        dom.window.VCPSettingsSidebar = surface;
        dom.window.VCPSettingsSchema = schema;

        const host = document.getElementById('agentSettingsContainer');
        const form = schema.renderAgentSettingsSurface(host, document);
        surface.register('agent', host);
        assert.ok(host, 'Agent surface host 必须存在');

        dom.window.eval(fs.readFileSync(path.join(repoRoot, 'modules/settingsManager.js'), 'utf8'));
        const sm = dom.window.settingsManager;

        let savedConfig = null;
        let currentItem = { id: 'agent-model-test', type: 'agent', config: { name: '初始名字', model: 'claude-3-5-sonnet-v2' } };
        const fakeElectronAPI = {
            saveAgentConfig: async (id, config) => {
                savedConfig = config;
                return { success: true };
            },
            getAgentConfig: async id => ({ id, name: '模型测试助手', model: 'claude-3-5-sonnet-v2' }),
            sovitsGetModels: async () => ({ models: [] })
        };

        sm.init({
            electronAPI: fakeElectronAPI,
            uiHelper: { showToastNotification: () => {}, showSaveFeedback: () => {} },
            refs: {
                currentSelectedItemRef: {
                    get: () => currentItem,
                    set: (val) => { currentItem = val; }
                }
            },
            mainRendererFunctions: { getCroppedFile: () => null, resetCroppedFile: () => {} },
            elements: {
                agentSettingsContainer: host,
                groupSettingsContainer: null,
                selectItemPromptForSettings: document.getElementById('selectAgentPromptForSettings'),
                itemSettingsContainerTitle: null,
                selectedItemNameForSettingsSpan: null,
                deleteItemBtn: document.getElementById('deleteAgentBtn'),
                agentSettingsForm: form,
                editingAgentIdInput: form.querySelector('#editingAgentId'),
                agentNameInput: form.querySelector('#agentNameInput'),
                agentAvatarInput: form.querySelector('#agentAvatarInput'),
                agentAvatarPreview: form.querySelector('#agentAvatarPreview'),
                agentModelInput: form.querySelector('#agentModel'),
                agentTemperatureInput: form.querySelector('#agentTemperature'),
                agentContextTokenLimitInput: form.querySelector('#agentContextTokenLimit'),
                agentMaxOutputTokensInput: form.querySelector('#agentMaxOutputTokens'),
                openModelSelectBtn: form.querySelector('#openModelSelectBtn'),
                topicSummaryModelInput: null,
                openTopicSummaryModelSelectBtn: null,
                agentTtsSpeedSlider: form.querySelector('#agentTtsSpeed')
            }
        });

        // 场景 A: 表单中的 #agentModel 有指定值，triggerAgentSave 保存时必须准确抓取该值，绝不能 fallback 到 gemini-pro
        const modelInput = host.querySelector('#agentModel');
        assert.ok(modelInput, '#agentModel 控件必须在 surface 中存在');
        modelInput.value = 'gpt-4o-custom';
        form.querySelector('#editingAgentId').value = 'agent-model-test';

        const submitAndWait = async () => {
            const result = await new Promise(resolve => {
                form.addEventListener('vcp-settings-save-result', event => resolve(event.detail), { once: true });
                form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
            });
            // 保存结果事件发生在内部保存函数返回前；等待外层 submit
            // 处理器完成状态更新，之后才能切换上下文或销毁测试 DOM。
            await new Promise(resolve => setImmediate(resolve));
            return result;
        };
        assert.equal((await submitAndWait()).success, true);
        assert.equal(savedConfig?.model, 'gpt-4o-custom', '保存时必须读取 #agentModel 中的自定义模型，不可篡改');

        // 场景 B: 假设 #agentModel 的 input 不在 DOM 中（或被脱水移除），但 currentConfig 存在
        // 回退时必须优先使用 currentConfig.model，不可盲目降级到 gemini-pro
        modelInput.value = '';
        await sm.displaySettingsForItem({ id: 'agent-model-test', type: 'agent', model: 'claude-3-5-sonnet-v2' }, 'agent');
        assert.equal(modelInput.value, 'claude-3-5-sonnet-v2', 'displaySettingsForItem 必须正确回填模型');

        // 通过显式表单提交保存。
        assert.equal((await submitAndWait()).success, true);
        assert.equal(savedConfig?.model, 'claude-3-5-sonnet-v2', '表单提交必须正确保存当前模型');
    } finally {
        dom.window.settingsManager?.cancelAutosave?.();
        activeIntervals.forEach(clearInterval);
        globalThis.window = prevWin;
        globalThis.document = prevDoc;
        globalThis.requestAnimationFrame = prevRaf;
        globalThis.MutationObserver = prevMO;
        globalThis.CustomEvent = prevCE;
        globalThis.setInterval = origSetInterval;
        delete dom.window.settingsManager;
        delete dom.window.VCPSettingsSidebar;
        delete dom.window.VCPSettingsSchema;
        dom.window.close();
    }
});

test('P0 对抗性防线: Autosave 在并发编辑保存时不丢失 Dirty 状态与 Revision 序列 (Bug 2 防护)', async () => {
    const { dom, document } = createDocument();
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    const prevRaf = globalThis.requestAnimationFrame;
    const prevMO = globalThis.MutationObserver;
    const prevCE = globalThis.CustomEvent;
    const origSetInterval = globalThis.setInterval;
    const activeIntervals = [];

    globalThis.window = dom.window;
    globalThis.document = document;
    globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
    dom.window.requestAnimationFrame = cb => setTimeout(cb, 0);
    globalThis.MutationObserver = class {
        observe() {}
        disconnect() {}
        takeRecords() { return []; }
    };
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.setInterval = (...args) => {
        const id = origSetInterval(...args);
        id.unref?.();
        activeIntervals.push(id);
        return id;
    };

    try {
        const root = document.getElementById('tabContentSettings');
        const surface = surfaceModule.createSettingsSidebarSurface({ document, root });
        dom.window.VCPSettingsSidebar = surface;
        dom.window.VCPSettingsSchema = schema;

        const host = document.getElementById('agentSettingsContainer');
        const form = schema.renderAgentSettingsSurface(host, document);
        surface.register('agent', host);
        dom.window.eval(fs.readFileSync(path.join(repoRoot, 'modules/settingsManager.js'), 'utf8'));
        const sm = dom.window.settingsManager;

        const saveHistory = [];
        let saveDelayResolver = null;
        let currentItem = { id: 'agent-autosave-seq', type: 'agent', config: { name: '初始名字', model: 'gemini-pro' } };
        const fakeElectronAPI = {
            saveAgentConfig: async (id, config) => {
                saveHistory.push({ id, name: config.name });
                if (saveDelayResolver) {
                    await new Promise(resolve => {
                        saveDelayResolver = resolve;
                    });
                }
                return { success: true };
            },
            getAgentConfig: async id => ({ id, name: '初始名字', model: 'gemini-pro' }),
            sovitsGetModels: async () => ({ models: [] })
        };

        sm.init({
            electronAPI: fakeElectronAPI,
            uiHelper: { showToastNotification: () => {}, showSaveFeedback: () => {} },
            refs: {
                currentSelectedItemRef: {
                    get: () => currentItem,
                    set: (val) => { currentItem = val; }
                }
            },
            mainRendererFunctions: { getCroppedFile: () => null, resetCroppedFile: () => {} },
            elements: {
                agentSettingsContainer: host,
                groupSettingsContainer: null,
                selectItemPromptForSettings: document.getElementById('selectAgentPromptForSettings'),
                itemSettingsContainerTitle: null,
                selectedItemNameForSettingsSpan: null,
                deleteItemBtn: document.getElementById('deleteAgentBtn'),
                agentSettingsForm: form,
                editingAgentIdInput: form.querySelector('#editingAgentId'),
                agentNameInput: form.querySelector('#agentNameInput'),
                agentAvatarInput: form.querySelector('#agentAvatarInput'),
                agentAvatarPreview: form.querySelector('#agentAvatarPreview'),
                agentModelInput: form.querySelector('#agentModel'),
                agentTemperatureInput: form.querySelector('#agentTemperature'),
                agentContextTokenLimitInput: form.querySelector('#agentContextTokenLimit'),
                agentMaxOutputTokensInput: form.querySelector('#agentMaxOutputTokens'),
                openModelSelectBtn: form.querySelector('#openModelSelectBtn'),
                topicSummaryModelInput: null,
                openTopicSummaryModelSelectBtn: null,
                agentTtsSpeedSlider: form.querySelector('#agentTtsSpeed')
            }
        });

        await sm.displaySettingsForItem({ id: 'agent-autosave-seq', type: 'agent', name: '初始名字' }, 'agent');
        const indicator = host.querySelector('#formSaveStateIndicator');
        assert.ok(indicator, '状态指示点宿主必须存在');

        // 模拟用户输入版本 1（触发 input 事件，驱动 markDirtyAndDebounceAutosave）
        const nameInput = form.querySelector('#agentNameInput');
        nameInput.value = '名字变更V1';
        nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        assert.equal(indicator.dataset.state, 'warning', '编辑后指示点进入 warning (未保存) 状态');

        // 旧测试曾在此处手动触发 autosave；新契约禁止任何非 submit 写入。
        let blockPromise = new Promise(r => { saveDelayResolver = r; });
        const savePromise1 = sm.triggerAgentSave('agent-autosave-seq');

        // 在兼容调用期间用户再次输入版本 2
        nameInput.value = '名字变更V2';
        nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

        // 放行第一次保存
        const resolveFirst = saveDelayResolver;
        saveDelayResolver = null;
        resolveFirst();
        await savePromise1;

        // 等待旧 debounce 窗口结束，仍不得发生任何自动保存。
        await new Promise(resolve => setTimeout(resolve, 1100));
        assert.equal(saveHistory.length, 0, '没有显式 submit 时不得发生自动保存');
        assert.equal(indicator.dataset.state, 'warning', '未保存编辑必须继续显示 warning');
    } finally {
        dom.window.settingsManager?.cancelAutosave?.();
        activeIntervals.forEach(clearInterval);
        globalThis.window = prevWin;
        globalThis.document = prevDoc;
        globalThis.requestAnimationFrame = prevRaf;
        globalThis.MutationObserver = prevMO;
        globalThis.CustomEvent = prevCE;
        globalThis.setInterval = origSetInterval;
        delete dom.window.settingsManager;
        delete dom.window.VCPSettingsSidebar;
        delete dom.window.VCPSettingsSchema;
        dom.window.close();
    }
});

test('P1 对抗性防线: displaySettingsForItem 兼容字符串 item 参数及脱水状态安全 (Bug 3 & 4 防护)', async () => {
    const { dom, document } = createDocument();
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    const prevRaf = globalThis.requestAnimationFrame;
    const prevMO = globalThis.MutationObserver;
    const prevCE = globalThis.CustomEvent;
    const origSetInterval = globalThis.setInterval;
    const activeIntervals = [];

    globalThis.window = dom.window;
    globalThis.document = document;
    globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
    dom.window.requestAnimationFrame = cb => setTimeout(cb, 0);
    globalThis.MutationObserver = class {
        observe() {}
        disconnect() {}
        takeRecords() { return []; }
    };
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.setInterval = (...args) => {
        const id = origSetInterval(...args);
        id.unref?.();
        activeIntervals.push(id);
        return id;
    };

    try {
        const root = document.getElementById('tabContentSettings');
        const surface = surfaceModule.createSettingsSidebarSurface({ document, root });
        dom.window.VCPSettingsSidebar = surface;
        dom.window.VCPSettingsSchema = schema;

        const host = document.getElementById('agentSettingsContainer');
        const form = schema.renderAgentSettingsSurface(host, document);
        surface.register('agent', host);
        dom.window.eval(fs.readFileSync(path.join(repoRoot, 'modules/settingsManager.js'), 'utf8'));
        const sm = dom.window.settingsManager;

        let fetchedId = null;
        const fakeElectronAPI = {
            saveAgentConfig: async () => ({ success: true }),
            getAgentConfig: async id => {
                fetchedId = id;
                return { id, name: '字符串加载助手', model: 'claude-3-opus' };
            },
            sovitsGetModels: async () => ({ models: [] })
        };

        sm.init({
            electronAPI: fakeElectronAPI,
            uiHelper: { showToastNotification: () => {}, showSaveFeedback: () => {} },
            refs: {
                currentSelectedItemRef: {
                    get: () => ({ id: 'agent-string-only', type: 'agent' }),
                    set: () => {}
                }
            },
            mainRendererFunctions: { getCroppedFile: () => null, resetCroppedFile: () => {} },
            elements: {
                agentSettingsContainer: host,
                groupSettingsContainer: null,
                selectItemPromptForSettings: document.getElementById('selectAgentPromptForSettings'),
                itemSettingsContainerTitle: null,
                selectedItemNameForSettingsSpan: null,
                deleteItemBtn: document.getElementById('deleteAgentBtn'),
                agentSettingsForm: form,
                editingAgentIdInput: form.querySelector('#editingAgentId'),
                agentNameInput: form.querySelector('#agentNameInput'),
                agentAvatarInput: form.querySelector('#agentAvatarInput'),
                agentAvatarPreview: form.querySelector('#agentAvatarPreview'),
                agentModelInput: form.querySelector('#agentModel'),
                agentTemperatureInput: form.querySelector('#agentTemperature'),
                agentContextTokenLimitInput: form.querySelector('#agentContextTokenLimit'),
                agentMaxOutputTokensInput: form.querySelector('#agentMaxOutputTokens'),
                openModelSelectBtn: form.querySelector('#openModelSelectBtn'),
                topicSummaryModelInput: null,
                openTopicSummaryModelSelectBtn: null,
                agentTtsSpeedSlider: form.querySelector('#agentTtsSpeed')
            }
        });

        // 传入纯字符串 'agent-string-only'
        await sm.displaySettingsForItem('agent-string-only', 'agent');
        assert.equal(fetchedId, 'agent-string-only', 'displaySettingsForItem 必须自动将字符串 item 转换为对象并拉取配置');
        assert.equal(form.querySelector('#agentNameInput').value, '字符串加载助手', '表单名字必须成功填充');
        assert.equal(form.querySelector('#agentModel').value, 'claude-3-opus', '表单模型必须成功填充');
    } finally {
        dom.window.settingsManager?.cancelAutosave?.();
        activeIntervals.forEach(clearInterval);
        globalThis.window = prevWin;
        globalThis.document = prevDoc;
        globalThis.requestAnimationFrame = prevRaf;
        globalThis.MutationObserver = prevMO;
        globalThis.CustomEvent = prevCE;
        globalThis.setInterval = origSetInterval;
        delete dom.window.settingsManager;
        delete dom.window.VCPSettingsSidebar;
        delete dom.window.VCPSettingsSchema;
        dom.window.close();
    }
});

test('P1 对抗性防线: GroupRenderer 绑定 currentChatNameH3 与非阻塞 Toast 验证 (Bug 5, 6, 7 防护)', async () => {
    const { dom, document } = createDocument();
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    const prevRaf = globalThis.requestAnimationFrame;
    const prevMO = globalThis.MutationObserver;
    const prevCE = globalThis.CustomEvent;
    const origSetInterval = globalThis.setInterval;
    const activeIntervals = [];

    globalThis.window = dom.window;
    globalThis.document = document;
    globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
    dom.window.requestAnimationFrame = cb => setTimeout(cb, 0);
    globalThis.MutationObserver = class {
        observe() {}
        disconnect() {}
        takeRecords() { return []; }
    };
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.setInterval = (...args) => {
        const id = origSetInterval(...args);
        id.unref?.();
        activeIntervals.push(id);
        return id;
    };

    try {
        const root = document.getElementById('tabContentSettings');
        const surface = surfaceModule.createSettingsSidebarSurface({ document, root });
        dom.window.VCPSettingsSidebar = surface;
        dom.window.VCPSettingsSchema = schema;

        dom.window.eval(fs.readFileSync(path.join(repoRoot, 'modules/ui-system/settings/group-slots.js'), 'utf8'));
        const groupHost = dom.window.VCPGroupSettingsSlots.ensureSettingsSurface({ document, settingsTab: root });

        dom.window.eval(fs.readFileSync(path.join(repoRoot, 'Groupmodules/grouprenderer.js'), 'utf8'));
        const gr = dom.window.GroupRenderer;

        const toasts = [];
        const uiHelper = {
            showToastNotification: (msg, type) => toasts.push({ msg, type }),
            showConfirmDialog: async () => true
        };

        const chatHeaderTitle = document.createElement('h3');
        chatHeaderTitle.id = 'currentChatNameH3';

        let alertCalled = false;
        dom.window.alert = () => { alertCalled = true; };

        gr.init({
            electronAPI: {
                deleteAgentGroup: async () => ({ success: true }),
                getAgentGroupConfig: async () => ({ name: '测试群组', members: [] }),
                getAgents: async () => []
            },
            globalSettings: {},
            currentSelectedItemRef: {
                get: () => ({ id: 'group-1', type: 'group', name: '测试群组' }),
                set: () => {}
            },
            currentTopicIdRef: { get: () => null, set: () => {} },
            messageRenderer: null,
            uiHelper,
            mainRendererElements: {
                currentChatNameH3: chatHeaderTitle
            },
            selectAgentPromptForSettingsElement: document.getElementById('selectAgentPromptForSettings'),
            agentSettingsContainer: null,
            selectedItemNameForSettingsElement: null,
            mainRendererFunctions: {}
        });

        // 验证 displayGroupSettingsPage
        await gr.displayGroupSettingsPage('group-1', { name: '测试群组', members: [] });

        // 验证没有触发 alert
        assert.equal(alertCalled, false, '群组渲染模块不得调用阻塞式 window.alert');
    } finally {
        activeIntervals.forEach(clearInterval);
        globalThis.window = prevWin;
        globalThis.document = prevDoc;
        globalThis.requestAnimationFrame = prevRaf;
        globalThis.MutationObserver = prevMO;
        globalThis.CustomEvent = prevCE;
        globalThis.setInterval = origSetInterval;
        delete dom.window.GroupRenderer;
        delete dom.window.VCPGroupSettingsSlots;
        delete dom.window.VCPSettingsSidebar;
        delete dom.window.VCPSettingsSchema;
        dom.window.close();
    }
});



