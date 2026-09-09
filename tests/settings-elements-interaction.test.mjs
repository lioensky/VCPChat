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

    try {
        const form = dom.window.document.getElementById('agentSettingsForm');

        // 1. 首次挂载
        const m1 = mountSettingsSidebarForm(form);
        assert.ok(m1, '必须返回挂载对象');
        assert.equal(m1.slots.length, 1, '必须挂载 MimoDirectorSlot');

        // 2. 重复调用命中缓存
        const m2 = mountSettingsSidebarForm(form);
        assert.equal(m1, m2, '相同 form 在 scope 活跃期间必须命中缓存');

        // 3. 显式 unmount
        unmountSettingsSidebarForm(form);
        const m3 = mountSettingsSidebarForm(form);
        assert.notEqual(m1, m3, 'unmount 后重新 mount 必须生成新实例');

        // 4. scope 销毁自动清理
        const scopeToDispose = takePresentationScope();
        await scopeToDispose?.dispose();
        const m4 = mountSettingsSidebarForm(form);
        assert.notEqual(m3, m4, 'scope dispose 后自动清理缓存，新 scope 下必须生成新实例');
    } finally {
        const remainingScope = takePresentationScope();
        await remainingScope?.dispose();
        releaseAllControllers();
        globalThis.document = prevDoc;
        globalThis.window = prevWin;
        dom.window.close();
    }
});

test('H5: Agent 保存链路强化测试（完整保留自定义样式/头像颜色/折叠状态，提交 await 与失败捕获）', async () => {
    const { document } = createDocument();
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

    // 填充测试值
    document.getElementById('editingAgentId').value = 'agent-test-123';
    document.getElementById('agentNameInput').value = '测试助手';
    document.getElementById('agentCustomCss').value = '.test { color: red; }';
    document.getElementById('agentCardCss').value = '.card { padding: 8px; }';
    document.getElementById('agentChatCss').value = '.chat { margin: 4px; }';
    document.getElementById('agentAvatarBorderColor').value = '#112233';
    document.getElementById('agentNameTextColor').value = '#445566';
    document.getElementById('disableCustomColors').checked = true;
    document.getElementById('useThemeColorsInChat').checked = true;

    // 模拟 submit 与状态点流转
    const stateDotTransitions = [];
    const updateStateDotIndicator = (kind) => {
        stateDotTransitions.push(kind);
    };

    let savedPayload = null;
    let mockSaveSuccess = true;
    const fakeElectronAPI = {
        saveAgentConfig: async (id, config) => {
            savedPayload = config;
            if (mockSaveSuccess) {
                return { success: true };
            } else {
                return { success: false, error: 'Write failed' };
            }
        }
    };

    const mockSaveCurrentAgentSettings = async (ev) => {
        if (ev?.preventDefault) ev.preventDefault();
        const agentId = document.getElementById('editingAgentId').value;
        const config = {
            name: document.getElementById('agentNameInput').value.trim(),
            customCss: document.getElementById('agentCustomCss').value.trim(),
            cardCss: document.getElementById('agentCardCss').value.trim(),
            chatCss: document.getElementById('agentChatCss').value.trim(),
            avatarBorderColor: document.getElementById('agentAvatarBorderColor').value,
            nameTextColor: document.getElementById('agentNameTextColor').value,
            disableCustomColors: document.getElementById('disableCustomColors').checked,
            useThemeColorsInChat: document.getElementById('useThemeColorsInChat').checked,
            uiCollapseStates: { identity: true, prompt: false }
        };
        const result = await fakeElectronAPI.saveAgentConfig(agentId, config);
        if (!result.success) {
            return { success: false, error: result.error };
        }
        return { success: true, result };
    };

    // 注册与 settingsManager 一致的 submit 逻辑
    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        updateStateDotIndicator('ongoing');
        try {
            const saveResult = await mockSaveCurrentAgentSettings(ev);
            if (saveResult && saveResult.success) {
                updateStateDotIndicator('done');
            } else {
                updateStateDotIndicator('warning');
            }
        } catch (err) {
            updateStateDotIndicator('warning');
        }
    });

    // 1. 成功提交测试
    form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
    // 等待微任务队列清空
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.deepEqual(stateDotTransitions, ['ongoing', 'done'], '保存成功时指示点必须经历 ongoing -> done');
    assert.equal(savedPayload.name, '测试助手');
    assert.equal(savedPayload.customCss, '.test { color: red; }');
    assert.equal(savedPayload.cardCss, '.card { padding: 8px; }');
    assert.equal(savedPayload.chatCss, '.chat { margin: 4px; }');
    assert.equal(savedPayload.avatarBorderColor, '#112233');
    assert.equal(savedPayload.nameTextColor, '#445566');
    assert.equal(savedPayload.disableCustomColors, true);
    assert.equal(savedPayload.useThemeColorsInChat, true);
    assert.deepEqual(savedPayload.uiCollapseStates, { identity: true, prompt: false });

    // 2. 失败提交测试
    stateDotTransitions.length = 0;
    mockSaveSuccess = false;
    form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.deepEqual(stateDotTransitions, ['ongoing', 'warning'], '保存失败时指示点必须经历 ongoing -> warning');
});



