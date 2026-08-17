import VCPUI from './vcp-ui.js';
import { register } from './next-ui-apps.js';
import { mountWebAwesomeComparison } from './webawesome-comparison.js';

const CATEGORIES = [
    { id: 'foundation', label: '基础', icon: 'foundation' },
    { id: 'actions', label: '操作', icon: 'ads_click' },
    { id: 'forms', label: '表单', icon: 'edit_note' },
    { id: 'navigation', label: '导航', icon: 'tab' },
    { id: 'data', label: '数据', icon: 'table' },
    { id: 'feedback', label: '反馈', icon: 'notifications' },
    { id: 'application', label: '应用页面', icon: 'web' },
    { id: 'webawesome', label: 'WA 对照', icon: 'compare' }
];

function mountShowcase(container, context = {}) {
    const LifecycleScope = window.VCPLifecycle?.LifecycleScope;
    const scope = context.scope?.child?.('next:component-showcase')
        || (LifecycleScope ? new LifecycleScope('next:component-showcase') : null);
    const feedback = VCPUI.feedback.owner(scope);
    const controllers = [];
    const disposers = [];
    const create = (name, options) => {
        const controller = VCPUI.create(name, options);
        controllers.push(controller);
        return controller;
    };
    const on = (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        disposers.push(() => target.removeEventListener(type, handler, options));
    };

    container.classList.add('vcp-ui-showcase-root');
    container.innerHTML = `
        <aside class="vcp-ui-showcase-sidebar" aria-label="组件分类">
            <div class="vcp-ui-showcase-brand">
                <span class="vcp-ui-icon" aria-hidden="true">widgets</span>
                <span><strong>UI 组件库</strong><small>VCPChat Design System</small></span>
            </div>
            <nav class="vcp-ui-showcase-nav"></nav>
        </aside>
        <div class="vcp-ui-showcase-shell">
            <header class="vcp-ui-showcase-header">
                <div>
                    <h1>UI 组件库</h1>
                    <p>新版界面的原生组件、状态与交互基线</p>
                </div>
                <div class="vcp-ui-showcase-tools">
                    <label class="vcp-ui-showcase-search">
                        <span class="vcp-ui-icon" aria-hidden="true">search</span>
                        <input type="search" placeholder="搜索组件" aria-label="搜索组件">
                    </label>
                    <div class="vcp-ui-density-control"></div>
                    <span class="vcp-ui-theme-status"><span class="vcp-ui-theme-dot"></span><span>当前主题</span></span>
                </div>
            </header>
            <main class="vcp-ui-showcase-content"></main>
        </div>`;

    const nav = container.querySelector('.vcp-ui-showcase-nav');
    const content = container.querySelector('.vcp-ui-showcase-content');
    const search = container.querySelector('.vcp-ui-showcase-search input');
    const densityHost = container.querySelector('.vcp-ui-density-control');
    const themeStatus = container.querySelector('.vcp-ui-theme-status > span:last-child');
    const sections = [];
    const designScope = container.closest('.vcp-ui-scope');
    const initialDensity = localStorage.getItem('vcpchat.uiDensity') === 'compact' ? 'compact' : 'comfortable';
    VCPUI.setDensity(designScope, initialDensity);
    const densityControl = create('SegmentedControl', {
        label: '界面密度',
        value: initialDensity,
        size: 'sm',
        items: [
            { label: '舒适', value: 'comfortable' },
            { label: '紧凑', value: 'compact' }
        ]
    });
    densityHost.append(densityControl.element);
    on(densityControl.element, 'change', () => {
        const density = densityControl.element.querySelector('[aria-checked="true"]')?.dataset.value || 'comfortable';
        VCPUI.setDensity(designScope, density);
        localStorage.setItem('vcpchat.uiDensity', density);
    });

    CATEGORIES.forEach((category, index) => {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'vcp-ui-showcase-nav-item';
        link.dataset.category = category.id;
        link.classList.toggle('is-active', index === 0);
        link.append(Object.assign(document.createElement('span'), { className: 'vcp-ui-icon', textContent: category.icon }));
        link.append(document.createTextNode(category.label));
        on(link, 'click', () => {
            container.querySelectorAll('.vcp-ui-showcase-nav-item').forEach(item => item.classList.toggle('is-active', item === link));
            container.querySelector(`[data-category-heading="${category.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        nav.append(link);
    });

    function categoryHeading(id, title, description) {
        const heading = document.createElement('header');
        heading.className = 'vcp-ui-showcase-category';
        heading.dataset.categoryHeading = id;
        const h2 = document.createElement('h2');
        h2.textContent = title;
        const p = document.createElement('p');
        p.textContent = description;
        heading.append(h2, p);
        content.append(heading);
    }

    function section(name, title, description) {
        const element = document.createElement('section');
        element.className = 'vcp-ui-showcase-section';
        element.dataset.component = name.toLowerCase();
        const header = document.createElement('header');
        const titleRow = document.createElement('div');
        titleRow.className = 'vcp-ui-showcase-section-title';
        const h3 = document.createElement('h3');
        h3.textContent = title;
        const meta = VCPUI.getComponentMeta(name);
        const status = create('Badge', {
            label: meta?.status === 'stable' ? 'Stable' : 'Candidate',
            variant: meta?.status === 'stable' ? 'neutral' : 'warning'
        });
        titleRow.append(h3, status.element);
        const p = document.createElement('p');
        p.textContent = description;
        header.append(titleRow, p);
        const demo = document.createElement('div');
        demo.className = 'vcp-ui-showcase-demo';
        element.append(header, demo);
        content.append(element);
        sections.push(element);
        return demo;
    }

    function row(host, label) {
        const group = document.createElement('div');
        group.className = 'vcp-ui-showcase-row';
        if (label) {
            const caption = document.createElement('span');
            caption.className = 'vcp-ui-showcase-caption';
            caption.textContent = label;
            group.append(caption);
        }
        host.append(group);
        return group;
    }

    categoryHeading('foundation', '基础', '语义状态、内容容器与空态表达。');

    let demo = section('Badge', 'Badge', '轻量标记用于状态、数量与分类。');
    let group = row(demo, 'Variants');
    ['neutral', 'accent', 'success', 'warning', 'danger'].forEach(variant => group.append(create('Badge', { label: variant, variant }).element));

    demo = section('Alert', 'Alert', '在内容流中表达信息、成功、警告和错误。');
    const alertGrid = document.createElement('div');
    alertGrid.className = 'vcp-ui-showcase-stack';
    ['info', 'success', 'warning', 'danger'].forEach(variant => alertGrid.append(create('Alert', { variant, title: `${variant} 状态`, message: '这是一条可被快速扫描的系统提示。', dismissible: variant === 'info' }).element));
    demo.append(alertGrid);

    demo = section('Card', 'Card', '用于单个可复用对象，支持描边、交互和选中态。');
    group = row(demo, 'States');
    ['default', 'outlined', 'interactive', 'selected'].forEach(variant => group.append(create('Card', { title: variant, description: '保持清晰的信息层级', variant, interactive: variant === 'interactive' }).element));

    demo = section('EmptyState', 'EmptyState', '为暂无内容或未完成配置提供下一步动作。');
    const emptyAction = create('Button', { label: '创建项目', icon: 'add', size: 'sm' });
    demo.append(create('EmptyState', { icon: 'inventory_2', title: '还没有项目', description: '创建第一个项目后，它会显示在这里。', actions: [emptyAction] }).element);

    demo = section('Divider', 'Divider', '建立内容节奏，支持纯分割线、带标题分割线和垂直分组。');
    const dividerToolbar = document.createElement('div');
    dividerToolbar.className = 'vcp-ui-showcase-inline-sample';
    dividerToolbar.append(document.createTextNode('左侧工具'), create('Divider', { orientation: 'vertical' }).element, document.createTextNode('右侧工具'));
    demo.append(create('Divider').element, create('Divider', { label: '高级设置' }).element, dividerToolbar);

    demo = section('Skeleton', 'Skeleton', '加载时维持稳定布局，减少内容突然跳动。');
    group = row(demo, 'Variants');
    group.append(create('Skeleton', { variant: 'circle' }).element, create('Skeleton', { lines: 3 }).element, create('Skeleton', { variant: 'rect' }).element);

    demo = section('Tooltip', 'Tooltip', '为图标按钮和被截断内容提供键盘可访问的补充说明。');
    const tooltipTrigger = create('IconButton', { icon: 'content_copy', label: '复制链接', variant: 'outline' });
    group = row(demo, 'Hover or focus');
    group.append(create('Tooltip', { trigger: tooltipTrigger, content: '复制当前页面链接', placement: 'right' }).element);

    categoryHeading('actions', '操作', '清晰的命令、工具与快捷操作。');

    demo = section('Button', 'Button', '六种视觉层级、四种尺寸以及加载和禁用状态。');
    group = row(demo, 'Variants');
    ['primary', 'secondary', 'outline', 'ghost', 'danger', 'link'].forEach(variant => group.append(create('Button', { label: variant, variant }).element));
    group = row(demo, 'Sizes & states');
    ['sm', 'md', 'lg', 'xl'].forEach(size => group.append(create('Button', { label: size, size, variant: 'secondary' }).element));
    group.append(create('Button', { label: '处理中', loading: true }).element, create('Button', { label: '不可用', disabled: true }).element);

    demo = section('IconButton', 'IconButton', '仅使用图标的紧凑命令，始终包含可访问名称。');
    group = row(demo, 'States');
    group.append(
        create('IconButton', { icon: 'add', label: '添加' }).element,
        create('IconButton', { icon: 'favorite', label: '收藏', active: true }).element,
        create('IconButton', { icon: 'delete', label: '删除', variant: 'danger' }).element,
        create('IconButton', { icon: 'settings', label: '设置', disabled: true }).element
    );

    demo = section('Toolbar', 'Toolbar', '将相关工具分组，并保持左右操作区域稳定。');
    const undo = create('IconButton', { icon: 'undo', label: '撤销' });
    const redo = create('IconButton', { icon: 'redo', label: '重做' });
    const bold = create('IconButton', { icon: 'format_bold', label: '粗体', active: true });
    const save = create('Button', { label: '保存', icon: 'save', size: 'sm' });
    demo.append(create('Toolbar', { label: '编辑工具', start: [undo, redo, 'separator', bold], end: [save] }).element);

    demo = section('SegmentedControl', 'SegmentedControl', '适合少量互斥模式，选中态使用弱强调色而不是重色块。');
    const viewMode = create('SegmentedControl', {
        label: '内容视图',
        value: 'list',
        items: [
            { label: '列表', value: 'list', icon: 'view_list' },
            { label: '表格', value: 'table', icon: 'table_rows' },
            { label: '卡片', value: 'card', icon: 'grid_view' }
        ]
    });
    const viewModeResult = document.createElement('span');
    viewModeResult.className = 'vcp-ui-showcase-result';
    viewModeResult.textContent = '当前：列表';
    on(viewMode.element, 'change', () => {
        const label = viewMode.element.querySelector('[aria-checked="true"] span:last-child')?.textContent || '';
        viewModeResult.textContent = `当前：${label}`;
    });
    group = row(demo, 'Interactive');
    group.append(viewMode.element, viewModeResult);

    categoryHeading('forms', '表单', '输入、选择、校验与组合字段。');

    demo = section('Input', 'Input', '支持尺寸、只读、禁用、校验状态和前后图标。');
    group = row(demo, 'States');
    group.append(
        create('Input', { placeholder: '搜索内容', leadingIcon: 'search' }).element,
        create('Input', { value: '只读内容', readonly: true }).element,
        create('Input', { value: '格式不正确', invalid: true, trailingIcon: 'error' }).element,
        create('Input', { placeholder: '不可用', disabled: true }).element
    );

    demo = section('Textarea', 'Textarea', '适合较长内容，支持行数、缩放与错误状态。');
    group = row(demo, 'States');
    group.append(create('Textarea', { placeholder: '输入说明...', rows: 4 }).element, create('Textarea', { value: '需要补充更多细节', invalid: true, resize: 'none' }).element);

    demo = section('Select', 'Select', 'Web Awesome 驱动的选择器，支持占位、禁用选项、动态选项和校验状态。');
    group = row(demo, 'States');
    const selectOptions = [{ label: '自动', value: 'auto' }, { label: '浅色', value: 'light' }, { label: '深色', value: 'dark' }];
    group.append(create('Select', { placeholder: '选择主题', options: selectOptions, value: 'auto' }).element, create('Select', { options: selectOptions, invalid: true }).element, create('Select', { options: selectOptions, disabled: true }).element);

    demo = section('Range', 'Range', '原生滑动输入的渐进增强组件，适合语速、温度和阈值设置。');
    group = row(demo, 'Candidate');
    group.append(create('Range', { min: 0, max: 100, step: 1, value: 50, label: '示例范围' }).element);

    demo = section('Checkbox', 'Checkbox', '支持选中、未选、混合与禁用状态。');
    group = row(demo, 'States');
    group.append(
        create('Checkbox', { label: '同步设置' }).element,
        create('Checkbox', { label: '已启用', checked: true }).element,
        create('Checkbox', { label: '部分选择', indeterminate: true }).element,
        create('Checkbox', { label: '不可修改', checked: true, disabled: true }).element
    );

    demo = section('Switch', 'Switch', '适合立即生效的二元设置，支持鼠标和键盘操作。');
    group = row(demo, 'Interactive');
    group.append(create('Switch', { label: '自动保存', checked: true }).element, create('Switch', { label: '桌面通知' }).element, create('Switch', { label: '不可修改', disabled: true }).element);

    demo = section('Field', 'Field', '统一标签、必填标记、帮助文字和错误信息。');
    group = row(demo, 'Composed fields');
    const accountInput = create('Input', { placeholder: 'name@example.com', leadingIcon: 'mail' });
    const invalidInput = create('Input', { value: 'invalid-address', invalid: true });
    group.append(create('Field', { label: '账号', required: true, helper: '用于登录和接收通知', control: accountInput }).element, create('Field', { label: '备用邮箱', error: '请输入有效的邮箱地址', control: invalidInput }).element);

    demo = section('SettingsSection', 'SettingsSection', '设置页的统一折叠分区，可创建新分区，也可增强已有业务 DOM。');
    const sectionContent = document.createElement('p');
    sectionContent.textContent = '分区内部继续组合 Field、Input、Select、Switch 等表单组件。';
    group = row(demo, 'Interactive');
    group.append(create('SettingsSection', {
        title: '高级设置',
        summary: '3 项配置',
        content: sectionContent,
        collapsed: true
    }).element);

    demo = section('SettingsActionBar', 'SettingsActionBar', '统一设置表单的未保存、保存中、成功和失败状态。');
    const actionDemoForm = document.createElement('form');
    const actionDemoInput = document.createElement('input');
    actionDemoInput.type = 'text';
    actionDemoInput.placeholder = '修改内容以触发未保存状态';
    const actionDemoBar = create('SettingsActionBar', {
        form: actionDemoForm,
        saveLabel: '保存设置',
        dangerLabel: '删除配置'
    });
    actionDemoForm.append(actionDemoInput, actionDemoBar.element);
    demo.append(actionDemoForm);

    categoryHeading('navigation', '导航', '在同一视图中切换上下文和扫描对象。');

    demo = section('Tabs', 'Tabs', 'ARIA 标签组，支持方向键、Home 和 End。');
    demo.append(create('Tabs', { value: 'overview', items: [{ label: '概览', value: 'overview' }, { label: '活动', value: 'activity' }, { label: '设置', value: 'settings' }, { label: '禁用项', value: 'disabled', disabled: true }] }).element);

    demo = section('ListItem', 'List / ListItem', '图标、主副文本、选中、禁用和尾部信息。');
    demo.append(create('List', { items: [
        { icon: 'person', label: '默认助手', description: '通用对话与任务处理', trailing: '在线', selected: true },
        { icon: 'code', label: '开发助手', description: '代码分析与项目维护', trailing: '12 个话题' },
        { icon: 'lock', label: '归档助手', description: '暂时不可选择', disabled: true }
    ] }).element);

    categoryHeading('data', '数据', '为结构化数据提供清晰、稳定的阅读区域。');

    demo = section('TableFrame', 'TableFrame', '表头、横向滚动、加载和空态共用同一容器。');
    const table = create('TableFrame', {
        columns: [{ key: 'name', label: '名称' }, { key: 'status', label: '状态' }, { key: 'updated', label: '更新时间' }],
        rows: [{ name: '聊天界面', status: '稳定', updated: '刚刚' }, { name: '主题系统', status: '测试中', updated: '10 分钟前' }, { name: '组件库', status: '开发中', updated: '今天' }]
    });
    const tableToggle = create('Button', { label: '切换加载状态', variant: 'outline', size: 'sm' });
    let tableLoading = false;
    on(tableToggle.element, 'click', () => {
        tableLoading = !tableLoading;
        table.update({ loading: tableLoading });
    });
    demo.append(table.element, tableToggle.element);

    demo = section('Pagination', 'Pagination', '紧凑页码、当前页状态和前后翻页命令。');
    const pagination = create('Pagination', { page: 3, total: 128, pageSize: 10 });
    const paginationResult = document.createElement('span');
    paginationResult.className = 'vcp-ui-showcase-result';
    paginationResult.textContent = '当前第 3 页';
    on(pagination.element, 'change', () => {
        const current = pagination.element.querySelector('[aria-current="page"]')?.textContent || '1';
        paginationResult.textContent = `当前第 ${current} 页`;
    });
    group = row(demo, 'Interactive');
    group.append(pagination.element, paginationResult);

    demo = section('ScrollArea', 'ScrollArea', '统一滚动条，并在内容未到底部时显示柔和的末端提示。');
    const scrollList = create('List', { items: Array.from({ length: 9 }, (_, index) => ({
        icon: index % 2 ? 'extension' : 'widgets',
        label: `组件规范 ${index + 1}`,
        description: index < 3 ? '已稳定，可用于新版 UI' : '等待后续业务迁移验证',
        trailing: index < 3 ? 'Stable' : 'Draft',
        interactive: false
    })) });
    const scrollArea = create('ScrollArea', { content: scrollList.element, label: '组件规范列表', size: 'sm' });
    const scrollTopButton = create('Button', { label: '回到顶部', variant: 'outline', size: 'sm' });
    const scrollBottomButton = create('Button', { label: '滚动到底部', variant: 'secondary', size: 'sm' });
    on(scrollTopButton.element, 'click', () => scrollArea.scrollToTop());
    on(scrollBottomButton.element, 'click', () => scrollArea.scrollToBottom());
    demo.append(scrollArea.element);
    group = row(demo, 'Commands');
    group.append(scrollTopButton.element, scrollBottomButton.element);

    categoryHeading('feedback', '反馈', '通知、确认、输入与阻塞状态。');

    demo = section('Modal', 'Modal', '支持三种尺寸、焦点陷阱、Escape 和焦点恢复。');
    group = row(demo, 'Open dialogs');
    ['sm', 'md', 'lg'].forEach(size => {
        const trigger = create('Button', { label: `${size} 弹窗`, variant: 'outline' });
        on(trigger.element, 'click', () => {
            const body = document.createElement('p');
            body.textContent = '这是一个拥有完整键盘焦点管理的原生对话框。';
            const close = create('Button', { label: '完成' });
            const modal = create('Modal', { title: `${size.toUpperCase()} 弹窗`, size, content: body, actions: [close] });
            close.element.addEventListener('click', () => modal.close(true), { once: true });
            container.append(modal.element);
        });
        group.append(trigger.element);
    });

    demo = section('Toast', 'Toast', '每条通知独立计时，可手动关闭。');
    group = row(demo, 'Variants');
    ['info', 'success', 'warning', 'error'].forEach(variant => {
        const trigger = create('Button', { label: variant, variant: 'secondary', size: 'sm' });
        on(trigger.element, 'click', () => feedback.toast(`${variant} 通知已触发`, { variant }));
        group.append(trigger.element);
    });

    demo = section('ConfirmDialog', 'ConfirmDialog', 'Promise API、危险操作样式和 FIFO 请求队列。');
    const confirmResult = document.createElement('span');
    confirmResult.className = 'vcp-ui-showcase-result';
    const confirmTrigger = create('Button', { label: '删除项目', variant: 'danger', icon: 'delete' });
    on(confirmTrigger.element, 'click', async () => {
        const accepted = await feedback.confirm({ title: '删除项目', message: '此操作无法撤销，确定继续吗？', danger: true, confirmLabel: '删除' });
        if (feedback.disposed) return;
        confirmResult.textContent = accepted ? '已确认删除' : '已取消';
    });
    group = row(demo, 'Interactive');
    group.append(confirmTrigger.element, confirmResult);

    demo = section('InputDialog', 'InputDialog', '单行、多行、必填和自定义验证。');
    const promptResult = document.createElement('span');
    promptResult.className = 'vcp-ui-showcase-result';
    const promptTrigger = create('Button', { label: '输入项目名', icon: 'edit' });
    const multilineTrigger = create('Button', { label: '输入说明', variant: 'outline' });
    on(promptTrigger.element, 'click', async () => {
        const value = await feedback.prompt({ title: '新项目', placeholder: '至少 3 个字符', required: true, validate: input => input.length < 3 ? '至少输入 3 个字符' : '' });
        if (feedback.disposed) return;
        promptResult.textContent = value ? `结果：${value}` : '已取消';
    });
    on(multilineTrigger.element, 'click', () => feedback.prompt({ title: '项目说明', multiline: true, rows: 5, placeholder: '输入详细说明' }));
    group = row(demo, 'Interactive');
    group.append(promptTrigger.element, multilineTrigger.element, promptResult);

    const loadingTrigger = create('Button', { label: '模拟加载 1.2 秒', variant: 'secondary', icon: 'hourglass_top' });
    on(loadingTrigger.element, 'click', () => {
        feedback.setLoading(true, '正在同步组件状态');
        if (scope) scope.timeout(() => feedback.setLoading(false), 1200, 'showcase-loading-demo');
    });
    group.append(loadingTrigger.element);

    categoryHeading('application', '应用页面', '独立页面与内嵌页面共用的壳层、窗口控制和异步状态边界。');

    demo = section('AppPageShell', 'AppPageShell', '标题栏、动作区、滚动区与窗口控制；内嵌模式自动隐藏窗口按钮。');
    const shell = create('AppPageShell', {
        title: '应用标题',
        actions: [
            create('Button', { label: '刷新', variant: 'ghost', size: 'sm', icon: 'refresh' }),
            create('Button', { label: '保存', size: 'sm', icon: 'check' })
        ],
        content: document.createTextNode('页面内容区随窗口缩放滚动。')
    });
    demo.append(shell.element);
    const embeddedToggle = create('Button', { label: '切换内嵌模式', variant: 'outline', size: 'sm' });
    on(embeddedToggle.element, 'click', () => shell.update({ embedded: !shell.element.dataset.embedded }));
    group = row(demo, 'Mode');
    group.append(embeddedToggle.element);

    demo = section('WindowControls', 'WindowControls', '仅独立窗口渲染的最小化 / 最大化 / 关闭，内嵌态由外壳隐藏。');
    demo.append(create('WindowControls', { onMinimize: () => feedback.toast('最小化'), onMaximize: () => feedback.toast('最大化'), onClose: () => feedback.toast('关闭') }).element);

    demo = section('AsyncBoundary', 'AsyncBoundary', '统一的 loading / error / empty / 内容四态，避免内容区跳变。');
    const boundary = create('AsyncBoundary', { status: 'idle', content: document.createTextNode('数据已就绪。') });
    demo.append(boundary.element);
    group = row(demo, 'States');
    ['idle', 'loading', 'error', 'empty'].forEach(state => {
        const trigger = create('Button', { label: state, variant: 'secondary', size: 'sm' });
        on(trigger.element, 'click', () => {
            boundary.update({ status: state, error: '服务器连接失败', empty: '没有可用数据' });
        });
        group.append(trigger.element);
    });

    categoryHeading('webawesome', 'Web Awesome 对照', '验证成熟 Web Components 能否保留 VCPChat 的视觉身份，同时接管基础交互与无障碍细节。');
    const comparisonHost = document.createElement('section');
    comparisonHost.className = 'vcp-ui-showcase-section vcp-ui-wa-section';
    comparisonHost.dataset.component = 'web awesome comparison button input select tooltip dialog';
    content.append(comparisonHost);
    sections.push(comparisonHost);
    disposers.push(mountWebAwesomeComparison(comparisonHost, { create, on }));

    function updateThemeStatus() {
        const isLight = document.body.classList.contains('light-theme');
        const wallpaper = getComputedStyle(document.documentElement).getPropertyValue('--custom-background-image').trim();
        themeStatus.textContent = `${isLight ? '浅色' : '深色'}${wallpaper && wallpaper !== 'none' ? ' · 壁纸' : ''}`;
    }
    updateThemeStatus();
    const observer = new MutationObserver(updateThemeStatus);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-ui-mode'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

    on(search, 'input', () => {
        const query = search.value.trim().toLowerCase();
        sections.forEach(item => {
            item.hidden = Boolean(query) && !item.textContent.toLowerCase().includes(query) && !item.dataset.component.includes(query);
        });
        container.querySelectorAll('.vcp-ui-showcase-category').forEach(heading => {
            let sibling = heading.nextElementSibling;
            let hasVisible = false;
            while (sibling && !sibling.classList.contains('vcp-ui-showcase-category')) {
                if (!sibling.hidden) hasVisible = true;
                sibling = sibling.nextElementSibling;
            }
            heading.hidden = !hasVisible;
        });
    });

    return async () => {
        observer.disconnect();
        disposers.splice(0).forEach(dispose => dispose());
        controllers.splice(0).reverse().forEach(controller => controller.destroy());
        await feedback.dispose();
        if (scope?.active) await scope.dispose('component-showcase-unmounted');
        container.replaceChildren();
        container.classList.remove('vcp-ui-showcase-root');
    };
}

register({
    id: 'ui-component-library',
    title: 'UI 组件库',
    icon: 'widgets',
    kind: 'internal',
    mount: mountShowcase
});
