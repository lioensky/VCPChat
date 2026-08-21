// Web Awesome's standard ESM build contains bare Lit imports. VCPChat's
// no-bundler renderer uses the package's equivalent self-contained build.
// The dist-cdn runtime closure is generated into vendor/webawesome-runtime so the installer
// never depends on node_modules layout for a third-party runtime.
//
// The components are NOT imported at module-eval time. Registering them is a
// side effect (customElements.define + Lit engine init), so it only happens
// when the showcase actually mounts the comparison section, and only in
// html[data-ui-mode="next"]. Classic mode and normal app boot never fetch a
// byte of the Web Awesome runtime.
const VENDOR_WEB_AWESOME_BASE = new URL(
    '../../vendor/webawesome-runtime/dist-cdn/components/',
    import.meta.url
).href;

const THEME_URL = new URL(
    '../../vendor/webawesome-runtime/dist-cdn/styles/themes/default.css',
    import.meta.url
).href;

const WEB_AWESOME_COMPONENTS = ['button', 'dialog', 'input', 'option', 'select', 'tooltip'];

async function loadWebAwesomeComponents() {
    await Promise.all(
        WEB_AWESOME_COMPONENTS.map(tag =>
            import(`${VENDOR_WEB_AWESOME_BASE}${tag}/${tag}.js`)
        )
    );
}

function createElement(tagName, attributes = {}, text = '') {
    const element = document.createElement(tagName);
    Object.entries(attributes).forEach(([name, value]) => {
        if (value === false || value === null || value === undefined) return;
        if (value === true) element.setAttribute(name, '');
        else element.setAttribute(name, String(value));
    });
    if (text) element.textContent = text;
    return element;
}

function loadTheme() {
    let link = document.querySelector('link[data-webawesome-showcase-theme]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = THEME_URL;
        link.dataset.webawesomeShowcaseTheme = 'true';
        document.head.append(link);
    }
    const owners = Number(link.dataset.ownerCount || 0) + 1;
    link.dataset.ownerCount = String(owners);
    return () => {
        const remaining = Number(link.dataset.ownerCount || 1) - 1;
        if (remaining <= 0) link.remove();
        else link.dataset.ownerCount = String(remaining);
    };
}

function sample(title, description) {
    const card = createElement('article', { class: 'vcp-ui-wa-sample' });
    const header = createElement('header');
    header.append(
        createElement('h4', {}, title),
        createElement('p', {}, description)
    );
    const body = createElement('div', { class: 'vcp-ui-wa-sample-body' });
    card.append(header, body);
    return { card, body };
}

function column(label, engine) {
    const element = createElement('section', { class: 'vcp-ui-wa-column' });
    const header = createElement('header', { class: 'vcp-ui-wa-column-header' });
    header.append(
        createElement('div', {}, label),
        createElement('span', {}, engine)
    );
    element.append(header);
    return element;
}

function createWebAwesomeButton(label, attributes = {}) {
    return createElement('wa-button', { size: 'small', ...attributes }, label);
}

export function mountWebAwesomeComparison(host, { create, on }) {
    if (document.documentElement.dataset.uiMode !== 'next') {
        host.append(createElement('p', { class: 'vcp-ui-wa-error' }, 'Web Awesome 对照仅在 新版 UI 模式下可用。'));
        return () => host.replaceChildren();
    }

    const disposers = [];
    const root = createElement('div', { class: 'vcp-ui-wa-comparison wa-dark' });
    const intro = createElement('div', { class: 'vcp-ui-wa-intro' });
    intro.append(
        createElement('div', { class: 'vcp-ui-wa-intro-copy' }),
        createElement('span', { class: 'vcp-ui-wa-version' }, 'Web Awesome Core 3.11.0 · MIT')
    );
    intro.firstElementChild.append(
        createElement('strong', {}, '同一套 VCPChat 视觉，两种组件内核'),
        createElement('p', {}, '左侧是现有 VCPUI，右侧使用 Web Awesome 的交互与无障碍能力，并通过 VCP token 与 Shadow Parts 重新着色。')
    );
    root.append(intro);

    const syncTheme = () => {
        const isLight = document.body.classList.contains('light-theme');
        root.classList.toggle('wa-light', isLight);
        root.classList.toggle('wa-dark', !isLight);
    };
    syncTheme();
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    disposers.push(() => themeObserver.disconnect());

    const grid = createElement('div', { class: 'vcp-ui-wa-grid' });
    const vcpColumn = column('现有 VCPUI', 'Native DOM + VCP runtime');
    const waColumn = column('Web Awesome + VCP Token', 'Lit Web Components + adapter');
    grid.append(vcpColumn, waColumn);
    root.append(grid);

    let current = sample('Button', '主要操作、次要操作、加载与禁用状态。');
    const vcpButtonRow = createElement('div', { class: 'vcp-ui-wa-control-row' });
    vcpButtonRow.append(
        create('Button', { label: '保存更改', size: 'sm' }).element,
        create('Button', { label: '稍后处理', size: 'sm', variant: 'outline' }).element,
        create('Button', { label: '处理中', size: 'sm', loading: true }).element,
        create('Button', { label: '不可用', size: 'sm', disabled: true }).element
    );
    current.body.append(vcpButtonRow);
    vcpColumn.append(current.card);

    current = sample('Input', '默认、校验失败和禁用状态。');
    const vcpInputStack = createElement('div', { class: 'vcp-ui-wa-control-stack' });
    vcpInputStack.append(
        create('Input', { placeholder: '搜索组件', leadingIcon: 'search' }).element,
        create('Input', { value: '格式不正确', invalid: true, trailingIcon: 'error' }).element,
        create('Input', { placeholder: '不可用', disabled: true }).element
    );
    current.body.append(vcpInputStack);
    vcpColumn.append(current.card);

    const options = [
        { label: '自动', value: 'auto' },
        { label: '浅色', value: 'light' },
        { label: '深色', value: 'dark' }
    ];
    current = sample('Select', '紧凑选择器和禁用状态。');
    const vcpSelectStack = createElement('div', { class: 'vcp-ui-wa-control-stack' });
    vcpSelectStack.append(
        create('Select', { value: 'auto', options }).element,
        create('Select', { value: 'auto', options, disabled: true }).element
    );
    current.body.append(vcpSelectStack);
    vcpColumn.append(current.card);

    current = sample('Tooltip', '悬停或键盘聚焦图标按钮。');
    const vcpTooltipTrigger = create('IconButton', { icon: 'content_copy', label: '复制链接', variant: 'outline' });
    current.body.append(create('Tooltip', { trigger: vcpTooltipTrigger, content: '复制当前页面链接', placement: 'right' }).element);
    vcpColumn.append(current.card);

    current = sample('Dialog', 'VCPUI Modal 保持当前产品的焦点和动作语义。');
    const vcpDialogTrigger = create('Button', { label: '打开对话框', size: 'sm', variant: 'outline' });
    on(vcpDialogTrigger.element, 'click', () => {
        const body = createElement('p', {}, '这是现有 VCPUI 的对话框，完全遵循当前产品样式。');
        const close = create('Button', { label: '完成', size: 'sm' });
        const modal = create('Modal', { title: '确认设置', size: 'sm', content: body, actions: [close] });
        close.element.addEventListener('click', () => modal.close(true), { once: true });
        host.append(modal.element);
    });
    current.body.append(vcpDialogTrigger.element);
    vcpColumn.append(current.card);

    host.append(root);

    const disposeTheme = loadTheme();
    disposers.push(disposeTheme);

    let disposed = false;
    const teardown = () => {
        if (disposed) return;
        disposed = true;
        disposers.reverse().forEach(dispose => dispose());
        root.remove();
    };

    loadWebAwesomeComponents()
        .then(() => {
            if (disposed) return;

            current = sample('Button', '相同状态由 Web Awesome 管理，视觉由 VCPChat 覆盖。');
            const waButtonRow = createElement('div', { class: 'vcp-ui-wa-control-row' });
            waButtonRow.append(
                createWebAwesomeButton('保存更改', { variant: 'brand', appearance: 'accent' }),
                createWebAwesomeButton('稍后处理', { appearance: 'outlined' }),
                createWebAwesomeButton('处理中', { variant: 'brand', loading: true }),
                createWebAwesomeButton('不可用', { disabled: true })
            );
            current.body.append(waButtonRow);
            waColumn.append(current.card);

            current = sample('Input', '保留原生表单关联、焦点与校验行为。');
            const waInputStack = createElement('div', { class: 'vcp-ui-wa-control-stack' });
            waInputStack.append(
                createElement('wa-input', { placeholder: '搜索组件', size: 'small', appearance: 'outlined' }),
                createElement('wa-input', { value: '格式不正确', size: 'small', appearance: 'outlined', 'data-invalid-demo': true }),
                createElement('wa-input', { placeholder: '不可用', size: 'small', appearance: 'outlined', disabled: true })
            );
            current.body.append(waInputStack);
            waColumn.append(current.card);

            current = sample('Select', '下拉定位、键盘导航和表单值由组件内核处理。');
            const waSelectStack = createElement('div', { class: 'vcp-ui-wa-control-stack' });
            const waSelect = createElement('wa-select', { value: 'auto', size: 'small', appearance: 'outlined' });
            const waSelectDisabled = createElement('wa-select', { value: 'auto', size: 'small', appearance: 'outlined', disabled: true });
            options.forEach(option => {
                waSelect.append(createElement('wa-option', { value: option.value }, option.label));
                waSelectDisabled.append(createElement('wa-option', { value: option.value }, option.label));
            });
            waSelectStack.append(waSelect, waSelectDisabled);
            current.body.append(waSelectStack);
            waColumn.append(current.card);

            current = sample('Tooltip', '浮层定位和 aria 关联由 Web Awesome 管理。');
            const waTooltipTrigger = createWebAwesomeButton('复制链接', { appearance: 'outlined' });
            const waTooltip = createElement('wa-tooltip', { placement: 'right', 'show-delay': 120 }, '复制当前页面链接');
            const tooltipId = `wa-tooltip-trigger-${crypto.randomUUID()}`;
            waTooltipTrigger.id = tooltipId;
            waTooltip.setAttribute('for', tooltipId);
            current.body.append(waTooltipTrigger, waTooltip);
            waColumn.append(current.card);

            current = sample('Dialog', 'Web Awesome 提供原生 dialog、焦点陷阱与 Escape 行为。');
            const waDialogTrigger = createWebAwesomeButton('打开对话框', { appearance: 'outlined' });
            const waDialog = createElement('wa-dialog', { label: '确认设置', 'light-dismiss': true, 'with-footer': true });
            waDialog.append(
                createElement('p', {}, '这是 Web Awesome 的交互内核，外观已经映射到 VCPChat token。'),
                createWebAwesomeButton('取消', { slot: 'footer', appearance: 'plain', 'data-dialog-close': true }),
                createWebAwesomeButton('完成', { slot: 'footer', variant: 'brand', appearance: 'accent', 'data-dialog-close': true })
            );
            on(waDialogTrigger, 'click', () => { waDialog.open = true; });
            waDialog.querySelectorAll('[data-dialog-close]').forEach(button => {
                on(button, 'click', () => { waDialog.open = false; });
            });
            current.body.append(waDialogTrigger, waDialog);
            waColumn.append(current.card);

            Promise.all(['wa-button', 'wa-input', 'wa-select', 'wa-tooltip', 'wa-dialog'].map(tag => customElements.whenDefined(tag)))
                .then(() => root.dataset.ready = 'true');
        })
        .catch(() => {
            if (disposed) return;
            root.dataset.ready = 'error';
            const errorNote = createElement('p', { class: 'vcp-ui-wa-error' }, 'Web Awesome 资源加载失败，请检查生成的离线运行闭包是否完整。');
            root.append(errorNote);
        });

    return teardown;
}
