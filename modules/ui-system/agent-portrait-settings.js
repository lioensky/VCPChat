/* Agent settings: the side pane home portrait (default and light images, focus point and height).
 * A portrait can be a still or animated image, or a short muted video. */
import {
    PORTRAIT_DISPLAY_DEFAULTS,
    PORTRAIT_HEIGHT_RANGE,
    applyPortraitDisplay,
    isDefaultPortraitDisplay,
    normalizePortraitDisplay,
    portraitFocus
} from './side-pane/portrait-display.js';
import {
    PORTRAIT_ACCEPT,
    createPortraitMediaLike,
    isPortraitType,
    isPortraitVideo,
    isVideoElement,
    portraitMaxBytes,
    releasePortraitMedia
} from './side-pane/portrait-media.js';

const FOCUS_STEP = 2;

/**
 * 助手设置「首页立绘」一栏。DOM 由设置页 schema 渲染，这里只管行为：
 *   load(agentId, config)  切到某个助手时读它的立绘和显示参数（显示参数来自表单草稿或配置）
 *   getDisplay()           表单保存时收进配置的 portraitDisplay
 *   commit(agentId)        表单保存时把选好的图写进 Agent 目录、把要移除的删掉
 *   summary()              折叠时标题旁的摘要
 * 换图、移除都和头像一样先暂存，点「保存」才落盘；暂存按助手分开记，切走再切回来还在。
 * 立绘有两个版本：default（深色主题和没有浅色版时用）和 light（浅色主题用）。
 */
export function createAgentPortraitSettings({ host, api, win = globalThis.window, onChange = () => {}, notify = () => {} }) {
    const doc = host?.ownerDocument || win?.document;
    const find = selector => host?.querySelector?.(selector) || null;
    const preview = find('.agent-portrait-preview');
    // 预览和缩略图在图片和视频之间换的时候会换成另一种元素
    let previewImage = find('.agent-portrait-preview-image');
    const focusMarker = find('.agent-portrait-focus-marker');
    const themeButtons = [...(host?.querySelectorAll?.('[data-portrait-preview-theme]') || [])];
    const headerButtons = [...(host?.querySelectorAll?.('[data-portrait-header]') || [])];
    const heightInput = find('#agentPortraitHeight');
    const heightValue = find('#agentPortraitHeightValue');
    const resetButton = find('#agentPortraitResetBtn');
    const slots = new Map();
    host?.querySelectorAll?.('[data-portrait-variant]').forEach(row => {
        const variant = row.getAttribute('data-portrait-variant');
        slots.set(variant, {
            row,
            thumb: row.querySelector('.agent-portrait-slot-thumb > :is(img, video)'),
            status: row.querySelector('.agent-portrait-slot-status'),
            input: row.querySelector('input[type="file"]'),
            pick: row.querySelector('[data-portrait-action="pick"]'),
            remove: row.querySelector('[data-portrait-action="remove"]')
        });
    });

    const cleanups = [];
    const on = (target, type, handler, options) => {
        if (!target) return;
        target.addEventListener(type, handler, options);
        cleanups.push(() => target.removeEventListener(type, handler, options));
    };

    let agentId = '';
    let saved = {};            // 磁盘上的立绘 { default, light, ... }（file URL）
    let display = normalizePortraitDisplay(null);
    let previewTheme = 'default';
    let loadToken = 0;
    // agentId -> Map(variant -> { file, url } | { remove: true })
    const pendingByAgent = new Map();
    const pending = () => pendingByAgent.get(agentId) || new Map();

    function effectiveUrl(variant) {
        const change = pending().get(variant);
        if (change?.remove) return '';
        if (change?.url) return change.url;
        return typeof saved[variant] === 'string' ? saved[variant] : '';
    }

    // 暂存的是 blob 地址，看不出扩展名，按选中文件的类型判断
    function isVideo(variant) {
        const change = pending().get(variant);
        if (change?.file) return isPortraitVideo('', change.file.type);
        return isPortraitVideo(effectiveUrl(variant));
    }

    // 把 node 换成能放这个地址的元素（img 或 video），返回现在在页面上的那个。
    // 缩略图只显示第一帧，视频只读到第一帧为止（preload=metadata），不把整段视频读进内存
    function showMedia(node, url, video, { thumbnail = false } = {}) {
        if (!node) return node;
        let current = node;
        if (url && isVideoElement(node) !== video) {
            current = createPortraitMediaLike(node, video);
            if (thumbnail && video) current.preload = 'metadata';
            node.replaceWith(current);
            releasePortraitMedia(node);
        }
        current.hidden = !url;
        if (!url) releasePortraitMedia(current);
        else if (current.getAttribute('src') !== url) current.setAttribute('src', url);
        return current;
    }

    // 预览里的视频只在设置页看得见、窗口没最小化、系统没要求减少动态时播放；缩略图只显示第一帧
    const reducedMotion = win?.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
    let previewInView = typeof win?.IntersectionObserver !== 'function';
    function syncPreviewPlayback() {
        if (!isVideoElement(previewImage)) return;
        const play = previewInView && !previewImage.hidden && previewImage.getAttribute('src')
            && doc?.visibilityState !== 'hidden' && !reducedMotion?.matches;
        if (play && previewImage.paused) Promise.resolve(previewImage.play?.()).catch(() => {});
        else if (!play && !previewImage.paused) previewImage.pause?.();
    }

    function hasPortrait() {
        return Boolean(effectiveUrl('default'));
    }

    function render() {
        if (!host) return;
        const defaultUrl = effectiveUrl('default');
        slots.forEach((slot, variant) => {
            const url = effectiveUrl(variant);
            const change = pending().get(variant);
            slot.thumb = showMedia(slot.thumb, url, isVideo(variant), { thumbnail: true });
            slot.row.dataset.state = change ? (change.remove ? 'removing' : 'staged') : (url ? 'set' : 'empty');
            if (slot.status) {
                slot.status.textContent = change
                    ? (change.remove ? '保存后移除' : '保存后生效')
                    : (url ? '已设置' : (variant === 'default' ? '未设置' : '未设置，沿用默认'));
            }
            if (slot.pick) slot.pick.textContent = url ? '更换' : '上传';
            if (slot.remove) {
                slot.remove.hidden = !url && !change;
                slot.remove.textContent = change ? '撤销' : '移除';
            }
            // 没有默认立绘时其他版本不会显示，先让人传默认那张
            if (variant !== 'default' && slot.pick) slot.pick.disabled = !defaultUrl && !url;
        });

        // 没有立绘时只留上传入口，预览主题、位置和高度都用不上
        host.dataset.hasPortrait = String(Boolean(defaultUrl));
        // 首页顶部显示什么：没有立绘时只能是头像
        const header = defaultUrl ? display.header : 'avatar';
        host.dataset.header = header;
        headerButtons.forEach(button => {
            const mode = button.getAttribute('data-portrait-header');
            button.setAttribute('aria-pressed', String(mode === header));
            button.disabled = mode === 'portrait' && !defaultUrl;
        });
        const shownVariant = previewTheme === 'light' && effectiveUrl('light') ? 'light' : 'default';
        const shownUrl = effectiveUrl(shownVariant);
        if (preview) {
            preview.dataset.empty = String(!shownUrl);
            const focus = portraitFocus(display, previewTheme);
            applyPortraitDisplay(preview, display, previewTheme);
            preview.setAttribute('aria-valuetext', `${previewTheme === 'light' ? '浅色' : '深色'}焦点 左右 ${focus.focusX}%，上下 ${focus.focusY}%`);
            preview.tabIndex = shownUrl ? 0 : -1;
        }
        previewImage = showMedia(previewImage, shownUrl, isVideo(shownVariant));
        syncPreviewPlayback();
        if (focusMarker) focusMarker.hidden = !shownUrl;
        themeButtons.forEach(button => {
            button.setAttribute('aria-pressed', String(button.getAttribute('data-portrait-preview-theme') === previewTheme));
        });
        if (heightInput) {
            heightInput.min = String(PORTRAIT_HEIGHT_RANGE.min);
            heightInput.max = String(PORTRAIT_HEIGHT_RANGE.max);
            heightInput.value = String(display.height);
            heightInput.disabled = !defaultUrl;
        }
        if (heightValue) heightValue.textContent = `${display.height}px`;
        if (resetButton) resetButton.disabled = !defaultUrl || isDefaultPortraitDisplay(display, previewTheme);
    }

    // 表单里的改动都通过一次冒泡的 change 让设置页标记「未保存」并刷新摘要
    function changed() {
        render();
        onChange();
        host?.dispatchEvent?.(new win.Event('change', { bubbles: true }));
    }

    function setDisplay(next) {
        const value = normalizePortraitDisplay({ ...display, ...next });
        if (Object.keys(value).every(key => value[key] === display[key])) return;
        display = value;
        changed();
    }

    // 主题切换只切换正在编辑的焦点，高度和首页显示模式仍然共用。
    function setFocus(next) {
        setDisplay(previewTheme === 'light'
            ? { lightFocusX: next.focusX, lightFocusY: next.focusY }
            : next);
    }

    function stage(variant, file) {
        if (!agentId || !slots.has(variant) || !file) return;
        if (!isPortraitType(file.type)) {
            notify('立绘只支持 PNG、JPEG、WebP、GIF 图片或 MP4、WebM 视频。', 'error');
            return;
        }
        // 和主进程的上限一致；选文件时先挡一次，不用等保存才报错
        const maxBytes = portraitMaxBytes(file.type);
        if (file.size > maxBytes) {
            notify(`立绘${isPortraitVideo('', file.type) ? '视频' : '图片'}不能超过 ${maxBytes / 1024 / 1024}MB。`, 'error');
            return;
        }
        const map = pendingByAgent.get(agentId) || new Map();
        releaseChange(map.get(variant));
        map.set(variant, { file, url: win.URL.createObjectURL(file) });
        pendingByAgent.set(agentId, map);
        if (variant === 'light') previewTheme = 'light';
        else if (variant === 'default' && previewTheme === 'light' && !effectiveUrl('light')) previewTheme = 'default';
        changed();
    }

    // 有暂存的改动（新图或移除）就撤销回磁盘上的状态；没有就把已保存的图标记为移除
    function unstageOrRemove(variant) {
        if (!agentId || !slots.has(variant)) return;
        const map = pendingByAgent.get(agentId) || new Map();
        const change = map.get(variant);
        if (change) {
            releaseChange(change);
            map.delete(variant);
            // 撤销移除默认立绘时，跟着它一起标记移除的浅色版也恢复
            if (variant === 'default' && change.remove && map.get('light')?.remove) map.delete('light');
        } else if (saved[variant]) {
            map.set(variant, { remove: true });
            // 移除默认立绘时浅色版也一起移除，不然留下一张不会显示的图
            if (variant === 'default' && (saved.light || map.get('light'))) {
                releaseChange(map.get('light'));
                if (saved.light) map.set('light', { remove: true });
                else map.delete('light');
            }
        }
        if (map.size) pendingByAgent.set(agentId, map);
        else pendingByAgent.delete(agentId);
        if (variant === 'light' && !effectiveUrl('light')) previewTheme = 'default';
        changed();
    }

    function releaseChange(change) {
        if (change?.url) win.URL.revokeObjectURL(change.url);
    }

    function clearPending(id) {
        const map = pendingByAgent.get(id);
        map?.forEach(releaseChange);
        pendingByAgent.delete(id);
    }

    // ---- 事件 ----
    slots.forEach((slot, variant) => {
        if (slot.input) slot.input.accept = PORTRAIT_ACCEPT;
        on(slot.pick, 'click', () => slot.input?.click());
        on(slot.input, 'change', (event) => {
            // 文件框本身的 change 不算表单改动，暂存成功后由 changed() 统一通知
            event.stopPropagation();
            const file = slot.input.files?.[0];
            slot.input.value = '';
            stage(variant, file);
        });
        on(slot.remove, 'click', () => unstageOrRemove(variant));
    });

    if (preview && typeof win?.IntersectionObserver === 'function') {
        const observer = new win.IntersectionObserver((entries) => {
            previewInView = Boolean(entries[entries.length - 1]?.isIntersecting);
            syncPreviewPlayback();
        });
        observer.observe(preview);
        cleanups.push(() => observer.disconnect());
    }
    on(doc, 'visibilitychange', syncPreviewPlayback);
    on(reducedMotion, 'change', syncPreviewPlayback);

    headerButtons.forEach(button => on(button, 'click', () => {
        setDisplay({ header: button.getAttribute('data-portrait-header') });
    }));

    themeButtons.forEach(button => on(button, 'click', () => {
        previewTheme = button.getAttribute('data-portrait-preview-theme') === 'light' ? 'light' : 'default';
        render();
    }));

    on(heightInput, 'input', (event) => {
        event.stopPropagation();
        setDisplay({ height: heightInput.value });
    });
    on(heightInput, 'change', event => event.stopPropagation());
    on(resetButton, 'click', () => {
        const { focusX, focusY, height } = PORTRAIT_DISPLAY_DEFAULTS;
        setDisplay(previewTheme === 'light'
            ? { lightFocusX: focusX, lightFocusY: focusY, height }
            : { focusX, focusY, height });
    });

    // 在预览上点或拖：把这一点设成焦点；方向键每次挪 2%
    let dragging = null;
    const focusFromPointer = (event) => {
        const rect = preview.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        setFocus({
            focusX: ((event.clientX - rect.left) / rect.width) * 100,
            focusY: ((event.clientY - rect.top) / rect.height) * 100
        });
    };
    on(preview, 'pointerdown', (event) => {
        if (event.button !== 0 || preview.dataset.empty === 'true') return;
        event.preventDefault();
        dragging = event.pointerId;
        preview.setPointerCapture?.(event.pointerId);
        preview.focus?.({ preventScroll: true });
        focusFromPointer(event);
    });
    on(preview, 'pointermove', (event) => {
        if (dragging === event.pointerId) focusFromPointer(event);
    });
    const endDrag = (event) => {
        if (dragging !== event.pointerId) return;
        dragging = null;
        preview.releasePointerCapture?.(event.pointerId);
    };
    on(preview, 'pointerup', endDrag);
    on(preview, 'pointercancel', endDrag);
    on(preview, 'keydown', (event) => {
        if (preview.dataset.empty === 'true') return;
        const moves = { ArrowLeft: [-FOCUS_STEP, 0], ArrowRight: [FOCUS_STEP, 0], ArrowUp: [0, -FOCUS_STEP], ArrowDown: [0, FOCUS_STEP] };
        const move = moves[event.key];
        if (!move) return;
        event.preventDefault();
        const focus = portraitFocus(display, previewTheme);
        setFocus({ focusX: focus.focusX + move[0], focusY: focus.focusY + move[1] });
    });

    return Object.freeze({
        async load(nextAgentId, config = {}) {
            const token = ++loadToken;
            agentId = typeof nextAgentId === 'string' ? nextAgentId : '';
            display = normalizePortraitDisplay(config?.portraitDisplay);
            const theme = doc?.body?.dataset?.vcpTheme;
            previewTheme = theme === 'light' ? 'light' : 'default';
            saved = {};
            render();
            if (!agentId || typeof api?.getAgentPortraits !== 'function') return;
            try {
                const portraits = await api.getAgentPortraits(agentId);
                if (token !== loadToken) return;
                saved = portraits && typeof portraits === 'object' ? { ...portraits } : {};
            } catch (error) {
                console.warn('[AgentPortraitSettings] Failed to read portraits:', error);
            }
            if (token !== loadToken) return;
            render();
            // 读完以后让折叠栏摘要跟着刷新（只刷新摘要，不发 change：读盘不是改动，不能标成未保存）
            onChange();
        },

        getDisplay() {
            return { ...display };
        },

        hasPendingFiles(id = agentId) {
            return (pendingByAgent.get(id)?.size || 0) > 0;
        },

        /** 先删后写，逐个处理；中途失败就停下报错，已经成功的那几张保留，没处理的继续暂存 */
        async commit(id = agentId) {
            const map = pendingByAgent.get(id);
            if (!map?.size) return { success: true, changed: false };
            if (typeof api?.saveAgentPortrait !== 'function' || typeof api?.removeAgentPortrait !== 'function') {
                return { success: false, error: '当前版本不支持保存立绘。' };
            }
            const order = [...map.keys()].sort((a, b) => (a === 'default') - (b === 'default'));
            const removals = order.filter(variant => map.get(variant).remove);
            const writes = order.filter(variant => !map.get(variant).remove);
            let portraits = null;
            for (const variant of [...removals.reverse(), ...writes]) {
                const change = map.get(variant);
                const result = change.remove
                    ? await api.removeAgentPortrait(id, variant)
                    : await api.saveAgentPortrait(id, variant, {
                        name: change.file.name,
                        type: change.file.type,
                        buffer: await change.file.arrayBuffer()
                    });
                if (!result?.success) return { success: false, error: result?.error || '保存立绘失败' };
                portraits = result.portraits || null;
                releaseChange(change);
                map.delete(variant);
            }
            pendingByAgent.delete(id);
            if (id === agentId) {
                saved = portraits ? { ...portraits } : {};
                render();
            }
            return { success: true, changed: true, portraits };
        },

        summary() {
            if (!hasPortrait()) return '未设置，首页显示头像';
            const parts = ['已设置'];
            if (display.header === 'avatar') parts.push('首页显示头像');
            if (effectiveUrl('light')) parts.push('含浅色版');
            if (pendingByAgent.get(agentId)?.size) parts.push('有未保存的图片');
            return parts.join(' · ');
        },

        dispose() {
            cleanups.splice(0).forEach(cleanup => cleanup());
            if (isVideoElement(previewImage)) previewImage.pause?.();
            [...pendingByAgent.keys()].forEach(clearPending);
        }
    });
}

if (typeof window !== 'undefined') {
    window.VCPAgentPortraitSettings = Object.freeze({ create: createAgentPortraitSettings });
}
