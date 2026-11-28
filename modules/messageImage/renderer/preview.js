// 消息图片导出前的预览面板（renderer/index.js 打开）。面板里显示的就是将要复制或保存的那张 PNG：
// 改一项设置就按真实管线重画，画好之前旧图留在原处（变暗），导出按钮停用，画好后整张换上。
const STYLESHEET = new URL('./preview.css', import.meta.url).href;
const WIDTH_MIN = 320;
const WIDTH_MAX = 1920;
const PAD_MAX = 64;
const RENDER_DELAY = 160;
const CANCELLED = { canceled: true };
const PREFERENCE_KEY = 'message-image.exportPreferences.v1';
const CONTENT_KEYS = ['tools', 'thoughts', 'timestamps'];

const ACTION_LABEL = { copy: '复制为图片', save: '保存为图片' };
const widthInRange = (width) => Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(width)));
const megabytes = (bytes) => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 2 : 1)} MB`;
const scaleLabel = (scale) => `${Number(scale.toFixed(2))}×`;

function readPreferences(defaults) {
    try {
        const saved = JSON.parse(window.localStorage.getItem(PREFERENCE_KEY));
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
        const bounded = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
        return {
            width: bounded(saved.width, WIDTH_MIN, WIDTH_MAX) ? widthInRange(saved.width) : defaults.width,
            pad: bounded(saved.pad, 0, PAD_MAX) ? Math.round(saved.pad) : defaults.pad,
            scale: bounded(saved.scale, 1, 2) ? saved.scale : defaults.scale,
            ...Object.fromEntries(CONTENT_KEYS.map(key => [key, typeof saved[key] === 'boolean' ? saved[key] : defaults[key]])),
        };
    } catch {
        return null;
    }
}

function rememberPreferences(settings) {
    try {
        window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(settings));
    } catch {
        // 存储不可用不影响已经成功的复制或保存。
    }
}

// 关闭时允许立即离开，但截图还可能在清理临时布局。下一面板也等它清理完再开画。
let renderTail = Promise.resolve();
function serializeRender(render) {
    const next = renderTail.then(render);
    renderTail = next.catch(() => {});
    return next;
}

function loadStyle() {
    if ([...document.querySelectorAll('link[rel="stylesheet"]')].some((link) => link.href === STYLESHEET)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = STYLESHEET;
    document.head.append(link);
}

function buildPanel({ primaryAction, scales, count, available }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'message-image-preview';
    dialog.tabIndex = -1;
    dialog.setAttribute('aria-label', '消息图片预览');
    const toggle = (key, label, none) => `
        <label class="message-image-preview-toggle"${available[key] ? '' : ' data-empty'}>
            <span>${label}${available[key] ? '' : `<small>${none}</small>`}</span>
            <input type="checkbox" data-setting="${key}" checked${available[key] ? '' : ' disabled'}>
        </label>`;
    dialog.innerHTML = `
        <div class="message-image-preview-frame">
            <header class="message-image-preview-header">
                <h2>消息图片预览<small>${count} 条消息</small></h2>
            </header>
            <div class="message-image-preview-body">
                <section class="message-image-preview-view" aria-label="图片预览">
                    <div class="message-image-preview-bar">
                        <span class="message-image-preview-size" data-value="size"></span>
                        <span class="message-image-preview-busy" hidden><span data-value="busy"></span></span>
                        <div class="message-image-preview-group" role="group" aria-label="预览缩放">
                            <button type="button" data-zoom="fit">适应窗口</button>
                            <button type="button" data-zoom="actual">实际大小</button>
                        </div>
                    </div>
                    <div class="message-image-preview-stage" data-zoom="fit">
                        <img alt="待导出的消息图片" hidden>
                    </div>
                </section>
                <fieldset class="message-image-preview-options" aria-label="导出设置">
                    <div class="message-image-preview-preferences">
                        <p class="message-image-preview-note" data-value="preferences">成功导出后记住设置</p>
                        <button type="button" class="message-image-preview-button" data-action="reset">恢复默认</button>
                    </div>
                    <div class="message-image-preview-setting">
                        <span class="message-image-preview-label">排版宽度</span>
                        <div class="message-image-preview-group" role="group" aria-label="宽度模式">
                            <button type="button" data-mode="original">原宽</button>
                            <button type="button" data-mode="custom">自定义</button>
                        </div>
                        <div class="message-image-preview-range">
                            <input type="range" min="${WIDTH_MIN}" max="${WIDTH_MAX}" step="1"
                                   aria-label="排版宽度（像素）" data-setting="width">
                            <output data-value="width"></output>
                        </div>
                        <p class="message-image-preview-note">文字按此宽度换行，高度随内容变化。</p>
                    </div>
                    <div class="message-image-preview-setting">
                        <span class="message-image-preview-label">消息内容</span>
                        ${toggle('tools', '保留工具调用', '所选消息不含工具调用')}
                        ${toggle('thoughts', '保留思考过程', '所选消息不含思考过程')}
                        ${toggle('timestamps', '保留消息时间', '所选消息不含时间')}
                    </div>
                    <div class="message-image-preview-setting">
                        <span class="message-image-preview-label">图片四周留白</span>
                        <div class="message-image-preview-range">
                            <input type="range" min="0" max="${PAD_MAX}" step="1" aria-label="图片四周留白（像素）" data-setting="pad">
                            <output data-value="pad"></output>
                        </div>
                    </div>
                    <div class="message-image-preview-setting">
                        <span class="message-image-preview-label">清晰度</span>
                        <div class="message-image-preview-group" role="group" aria-label="清晰度"></div>
                    </div>
                </fieldset>
            </div>
            <footer class="message-image-preview-footer">
                <span role="status" class="message-image-preview-status"></span>
                <div class="message-image-preview-actions">
                    <button type="button" class="message-image-preview-button" data-action="retry" hidden>重试预览</button>
                    <button type="button" class="message-image-preview-button" data-action="cancel">取消</button>
                </div>
            </footer>
        </div>`;
    const scaleGroup = dialog.querySelector('[aria-label="清晰度"]');
    for (const scale of scales) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.scale = scale;
        button.textContent = scaleLabel(scale);
        scaleGroup.append(button);
    }
    const actions = dialog.querySelector('.message-image-preview-actions');
    for (const action of Object.keys(ACTION_LABEL).sort((a, b) => Number(a === primaryAction) - Number(b === primaryAction))) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = action;
        button.className = `message-image-preview-button${action === primaryAction ? ' is-primary' : ''}`;
        button.textContent = ACTION_LABEL[action];
        button.disabled = true;
        actions.append(button);
    }
    return dialog;
}

export async function openPreview({ initialWidth, initialScale, primaryAction, count = 1, available = {}, render, output, isCurrent }) {
    if (!isCurrent()) return CANCELLED;
    const scale = Number.isFinite(initialScale) && initialScale > 0 ? initialScale : 1;
    const originalWidth = Number.isFinite(initialWidth) && initialWidth > 0 ? initialWidth : WIDTH_MIN;
    const defaultAction = primaryAction === 'save' ? 'save' : 'copy';
    const has = Object.fromEntries(CONTENT_KEYS.map(key => [key, available[key] !== false]));
    // 原宽仍由当前消息决定，不把上次聊天的尺寸写进偏好。
    const defaults = { width: null, tools: true, thoughts: true, timestamps: true, pad: 16, scale };
    const remembered = readPreferences(defaults);
    const settings = { ...(remembered ?? defaults) };
    let preferenceHint = remembered ? '已沿用上次导出设置' : '成功导出后记住设置';
    let customWidth = settings.width ?? widthInRange(originalWidth);
    let zoom = 'fit';
    loadStyle();

    const dialog = buildPanel({
        primaryAction: defaultAction, count, available: has,
        scales: [...new Set([1, scale, settings.scale, 2])].sort((a, b) => a - b),
    });
    const $ = (selector) => dialog.querySelector(selector);
    const previousFocus = document.activeElement;
    const image = $('img');
    const status = $('[role="status"]');
    const stage = $('.message-image-preview-stage');
    const busy = $('.message-image-preview-busy');
    const options = $('fieldset');
    const retry = $('[data-action="retry"]');
    const cancel = $('[data-action="cancel"]');
    const buttons = [...dialog.querySelectorAll('[data-action="copy"], [data-action="save"]')];
    const width = $('[data-setting="width"]');
    const pad = $('[data-setting="pad"]');
    let closed = false;
    let rendering = false;
    let writing = false;
    let revision = 0;
    let shown = -1; // 当前显示的图对应的设置版本；不等于 revision 时图已过时，不能导出
    let waiting = false;
    let delay;
    let watcher;
    let png;
    let imageUrl;
    let imageScale = scale;
    let settle;
    const result = new Promise((resolve) => { settle = resolve; });
    const current = () => Boolean(png) && shown === revision;

    function clearImage() {
        png = undefined;
        shown = -1;
        image.hidden = true;
        image.removeAttribute('src');
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        imageUrl = undefined;
        $('[data-value="size"]').textContent = '';
    }

    function close(value) {
        if (closed) return;
        closed = true;
        clearTimeout(delay);
        clearInterval(watcher);
        window.removeEventListener('keydown', onKey, true);
        dialog.removeEventListener('cancel', onCancel);
        dialog.removeEventListener('close', onClose);
        dialog.removeEventListener('click', onClick);
        dialog.removeEventListener('input', onInput);
        dialog.removeEventListener('change', onChange);
        clearImage();
        if (dialog.open) dialog.close();
        dialog.remove();
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        settle(value);
    }

    function checkCurrent() {
        if (!closed && !isCurrent()) close(CANCELLED);
        return !closed;
    }

    function say(message, state = '') {
        status.textContent = message;
        status.dataset.state = state;
    }

    function syncSettings() {
        width.value = settings.width ?? widthInRange(originalWidth);
        $('[data-value="width"]').textContent = `${Math.round(settings.width ?? originalWidth)} px`;
        pad.value = settings.pad;
        $('[data-value="pad"]').textContent = `${settings.pad} px`;
        for (const button of dialog.querySelectorAll('[data-mode], [data-scale], [data-zoom]')) {
            let pressed;
            if (button.dataset.mode) pressed = button.dataset.mode === (settings.width === null ? 'original' : 'custom');
            else if (button.dataset.zoom) pressed = button.dataset.zoom === zoom;
            else pressed = Number(button.dataset.scale) === settings.scale;
            button.setAttribute('aria-pressed', String(pressed));
        }
        for (const key of CONTENT_KEYS) $(`[data-setting="${key}"]`).checked = has[key] && settings[key];
        $('[data-value="preferences"]').textContent = preferenceHint;
    }

    function syncView() {
        stage.dataset.zoom = zoom;
        if (!image.hidden && image.naturalWidth) image.style.width = `${image.naturalWidth / imageScale}px`;
    }

    function syncOutput() {
        const updating = !closed && (waiting || rendering) && Boolean(png);
        stage.dataset.state = !png ? 'empty' : updating ? 'updating' : 'ready';
        busy.hidden = !(waiting || rendering);
        $('[data-value="busy"]').textContent = png ? '正在更新预览' : '正在生成预览';
        for (const button of buttons) button.disabled = !current() || writing;
        cancel.disabled = writing;
        options.disabled = writing;
    }

    function changeSettings(immediate = true) {
        preferenceHint = '成功导出后记住设置';
        requestRender(immediate);
    }

    function resetSettings() {
        const changed = Object.keys(defaults).some(key => settings[key] !== defaults[key]);
        Object.assign(settings, defaults);
        customWidth = widthInRange(originalWidth);
        preferenceHint = '已恢复默认 · 成功导出后记住';
        if (changed) requestRender(true);
        else syncSettings();
    }

    function requestRender(immediate = false) {
        if (!checkCurrent()) return;
        revision++;
        clearTimeout(delay);
        delay = undefined;
        waiting = true;
        retry.hidden = true;
        syncSettings();
        stage.setAttribute('aria-busy', 'true');
        say(png ? '' : '正在生成预览');
        syncOutput();
        if (immediate) void paint();
        else delay = setTimeout(() => {
            delay = undefined;
            void paint();
        }, RENDER_DELAY);
    }

    // 拖动滑块时只在停顿后重画；松开（change）就不再等。
    function flush() {
        if (!delay) return;
        clearTimeout(delay);
        delay = undefined;
        void paint();
    }

    async function paint() {
        if (!checkCurrent() || !waiting || rendering || delay) return;
        waiting = false;
        rendering = true;
        syncOutput();
        const version = revision;
        const snapshot = { ...settings };
        const valid = () => checkCurrent() && version === revision;
        try {
            const bytes = await serializeRender(() => valid() ? render(snapshot) : undefined);
            if (!valid()) return;
            if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new Error('未收到 PNG 图片。');
            const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
            const next = new Image();
            next.src = url;
            try {
                await next.decode();
            } catch {
                URL.revokeObjectURL(url);
                throw new Error('收到的 PNG 图片无法打开。');
            }
            if (!valid()) {
                URL.revokeObjectURL(url);
                return;
            }
            // 新图解码好才换上，换图时没有空白的一帧。
            if (imageUrl) URL.revokeObjectURL(imageUrl);
            imageUrl = url;
            image.src = url;
            png = bytes;
            shown = version;
            imageScale = snapshot.scale;
            image.hidden = false;
            syncView();
            $('[data-value="size"]').textContent = `${next.naturalWidth} × ${next.naturalHeight} 像素 · ${megabytes(bytes.byteLength)}`;
            say('');
        } catch (error) {
            if (!valid()) return;
            clearImage();
            say(`无法生成预览。${error?.message || '请调整参数后重试。'}`, 'error');
            retry.hidden = false;
        } finally {
            rendering = false;
            if (valid()) stage.setAttribute('aria-busy', 'false');
            if (!closed) syncOutput();
            if (!closed && waiting && !delay) void paint();
        }
    }

    async function write(action) {
        if (!checkCurrent() || !current() || writing) return;
        writing = true;
        syncOutput();
        say(action === 'save' ? '正在保存图片' : '正在复制图片');
        try {
            const response = await output(action, png);
            if (!checkCurrent()) return;
            if (response?.canceled) {
                say('已取消保存，可继续调整或导出。');
            } else if (response?.ok) {
                rememberPreferences(settings);
                close({ ...response, action });
            } else {
                throw new Error(response?.error || '请重试。');
            }
        } catch (error) {
            if (checkCurrent()) say(`${ACTION_LABEL[action]}失败。${error?.message || '请重试。'}`, 'error');
        } finally {
            writing = false;
            if (checkCurrent()) syncOutput();
        }
    }

    function onClick(event) {
        const button = event.target.closest('button');
        if (!button || button.disabled || !checkCurrent() || writing) return;
        const { action, mode, zoom: nextZoom, scale: nextScale } = button.dataset;
        if (action === 'cancel') close(CANCELLED);
        else if (action === 'retry') requestRender(true);
        else if (action === 'reset') resetSettings();
        else if (action) void write(action);
        else if (nextZoom) {
            zoom = nextZoom;
            syncSettings();
            syncView();
        } else if (mode && button.getAttribute('aria-pressed') !== 'true') {
            settings.width = mode === 'custom' ? customWidth : null;
            changeSettings();
        } else if (nextScale && Number(nextScale) !== settings.scale) {
            settings.scale = Number(nextScale);
            changeSettings();
        }
    }

    function onInput(event) {
        if (!checkCurrent() || writing || event.target.disabled) return;
        const input = event.target;
        const key = input.dataset.setting;
        // 拖宽度滑块就是自定义宽度，不用先点“自定义”。
        if (key === 'width') settings.width = customWidth = widthInRange(Number(input.value));
        else if (key === 'pad') settings.pad = Math.min(PAD_MAX, Math.max(0, Math.round(Number(input.value))));
        else if (CONTENT_KEYS.includes(key) && has[key]) settings[key] = input.checked;
        else return;
        changeSettings(CONTENT_KEYS.includes(key));
    }

    function onChange(event) {
        if (event.target.type === 'range') flush();
    }

    function onCancel(event) {
        event.preventDefault();
        if (!writing) close(CANCELLED);
    }

    function onClose() {
        close(CANCELLED);
    }

    // Esc 取消；Enter 执行主操作（焦点在按钮上时按按钮本身）；Ctrl+C 复制、Ctrl+S 保存。
    function onKey(event) {
        if (event.isComposing || closed) return;
        const ctrl = event.ctrlKey || event.metaKey;
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        let act = null;
        if (key === 'Escape' && !ctrl) act = 'cancel';
        else if (key === 'Enter' && !ctrl && !event.altKey) {
            if (event.target?.closest?.('button') && dialog.contains(event.target)) return;
            act = defaultAction;
        } else if (ctrl && !event.altKey && !event.shiftKey && key === 's') act = 'save';
        else if (ctrl && !event.altKey && !event.shiftKey && key === 'c' && !String(window.getSelection?.() || '')) act = 'copy';
        if (!act || !checkCurrent()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat) return;
        if (act === 'cancel') onCancel(event);
        else void write(act);
    }

    document.body.append(dialog);
    syncSettings();
    syncView();
    syncOutput();
    try {
        dialog.showModal();
    } catch (error) {
        close(CANCELLED);
        throw error;
    }
    dialog.focus({ preventScroll: true });
    dialog.addEventListener('click', onClick);
    dialog.addEventListener('input', onInput);
    dialog.addEventListener('change', onChange);
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onClose);
    window.addEventListener('keydown', onKey, true);
    watcher = setInterval(checkCurrent, 100);
    requestRender(true);
    return result;
}
