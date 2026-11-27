// 消息图片在主窗口这一侧（feature.json 的 renderer，由 modules/renderer/appFeatures.js 载入）。
// 右键消息“复制为图片”“多选”：两项登记在上游的命令表里（window.VCPContributions.commands，id 以 message-menu. 开头），
// 消息右键菜单按这个前缀列出来。多选时每条消息左边一个勾选框（控件库的 .message-image-chk），点消息任意处勾上或取消，
// 选中的整块提亮一档；输入框换成操作条。每条消息用 modern-screenshot（上游阅读模式截图用的同一个库）画成 PNG，
// 主进程竖着拼成一张（../index.js），复制到剪贴板或存成文件。
import { domToForeignObjectSvg } from '../../../vendor/modern-screenshot.js';

import { THOUGHT_BLOCKS, TIMESTAMP_SELECTOR, TOOL_BLOCKS, contentWidth, withExportLayout } from './layout.js';
import { SLICE, codePoints, fontCssFor, layoutZoom, sliceHeight, snap, snapBoxes } from './exportMath.js';

const STYLESHEET = new URL('./shareImage.css', import.meta.url).href;

const GAP = 8; // 消息之间
const MAX_PIXELS = 80_000_000; // 和 ../stitch.js 一致
const MAX_SCALE = 2;
const ITEMS = ':scope > .message-item[data-message-id]';

let chatAPI = null;
let messageRenderer = null;
let refs = null;
let picking = null;

const toast = (text, type) => window.uiHelperFunctions?.showToastNotification?.(text, type);
const topicKey = () => `${refs?.currentSelectedItem?.get?.()?.id || ''}|${refs?.currentTopicId?.get?.() || ''}`;

// ---- 画图 ----

// 计算样式里的颜色可能是 rgb()、color(srgb r g b) 等任何写法，画到 1×1 的画布上读回来最稳。
function rgbaOf(color) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a };
}

// 图的底色：从对话列表往外找第一层不透明的底色。
function backgroundOf(element) {
    for (let node = element; node; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor;
        if (!color || color === 'transparent') continue;
        const rgba = rgbaOf(color);
        if (rgba.a > 200) return rgba;
    }
    return { r: 20, g: 17, b: 14, a: 255 };
}

// 图里要用和屏幕上一样的字体。截图库自己只跟一层 @import，Chat 的 MiSans 在两层之下（style.css → 主题 → misans.css），
// 图里就退回别的字体，宽度不同，紧凑的按钮会把最后一个字挤到下一行（管理员 2026-11-11 实测）。
// 这里把页面实际载入了的字体分片（document.fonts 里 status 为 loaded 的）找到对应的 @font-face，读成 data URL 一起交给截图库。
function fontFaceRules() {
    const rules = [];
    const walk = (sheet) => {
        let list;
        try { list = sheet.cssRules; } catch { return; }
        for (const rule of list) {
            if (rule.styleSheet) walk(rule.styleSheet);
            else if (rule.constructor.name === 'CSSFontFaceRule') rules.push(rule);
            else if (rule.cssRules) walk(rule);
        }
    };
    for (const sheet of document.styleSheets) walk(sheet);
    return rules;
}

const faceKey = (family, weight, style, range) => [family, weight, style, range]
    .map((part) => String(part || '').replace(/["']/g, '').replace(/\s+/g, '').toLowerCase()).join('|');

async function asDataUrl(url) {
    const blob = await (await fetch(url)).blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

let fontCache = { key: '', cssText: '' };
async function loadedFontCss() {
    const loaded = new Set([...document.fonts].filter((face) => face.status === 'loaded')
        .map((face) => faceKey(face.family, face.weight, face.style, face.unicodeRange)));
    const picked = fontFaceRules().filter((rule) => loaded.has(faceKey(rule.style.getPropertyValue('font-family'),
        rule.style.getPropertyValue('font-weight') || '400', rule.style.getPropertyValue('font-style') || 'normal',
        rule.style.getPropertyValue('unicode-range') || 'U+0-10FFFF')));
    const key = picked.map((rule) => rule.cssText).join('\n');
    if (key === fontCache.key) return fontCache.cssText;
    const texts = await Promise.all(picked.map(async (rule) => {
        const base = rule.parentStyleSheet?.href || document.baseURI;
        const urls = [...rule.style.getPropertyValue('src').matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((match) => match[1]);
        let cssText = rule.cssText;
        for (const url of urls) {
            if (url.startsWith('data:')) continue;
            try {
                cssText = cssText.split(url).join(await asDataUrl(new URL(url, base).href));
            } catch (error) {
                console.warn('[MessageImage] 字体读不到，图里会用别的字体:', url, error);
            }
        }
        return cssText;
    }));
    fontCache = { key, cssText: texts.join('\n') };
    return fontCache.cssText;
}

function checkSize(items, pad, scale) {
    if (!items.length || items.length > 500) throw new Error('一次请选择 1 至 500 条消息。');
    let width = 0;
    let height = 0;
    for (const item of items) {
        const w = Math.ceil(Math.ceil(contentWidth(item)) * scale);
        const h = Math.ceil(Math.ceil(item.getBoundingClientRect().height) * scale);
        if (!w || !h) throw new Error('有一条消息没有内容可画。');
        if (w > 32767) throw new Error('图片过宽，请减小排版宽度或降低清晰度。');
        width = Math.max(width, w);
        height += h;
    }
    const border = 2 * Math.round(pad * scale);
    if ((width + border) * (height + border + (items.length - 1) * Math.round(GAP * scale)) > MAX_PIXELS) {
        throw new Error('图片超过像素上限，请降低清晰度、减小排版宽度或减少消息。');
    }
}

// 折起来的工具详情、隐藏的思考原文这类 display: none 的子树不进克隆：图里本来就没有，克隆它们占了大半画图时间。
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const EMPTY_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
function keepNode(node) {
    if (node.nodeType !== 1) return true;
    if (node.classList?.contains('message-image-pick-box')) return false;
    if (node.namespaceURI !== HTML_NS || node.localName === 'style') return true;
    return getComputedStyle(node).display !== 'none';
}

let sliceLimit = SLICE; // 测试可调小，验证分段接缝

// zoom：克隆按屏幕的缩放（devicePixelRatio）排版，和 Chromium 在高分屏上按设备像素排版一致；
// 否则细边框（0.667px）在图里变成 1px，标签、按钮这类刚好装下字的框就会把最后一个字挤到下一行。
async function rasterize(svg, { width, height, top, full, zoom, scale, background, redraws }) {
    svg.setAttribute('width', String(width * zoom));
    svg.setAttribute('height', String(height * zoom));
    svg.setAttribute('viewBox', `0 ${top * zoom} ${width * zoom} ${height * zoom}`);
    // 截图库把 foreignObject 设成 100%，按视框算只有一段高；分段时要盖住整条消息。
    const object = svg.querySelector('foreignObject');
    object.setAttribute('width', String(width * zoom));
    object.setAttribute('height', String(full * zoom));
    const xml = new XMLSerializer().serializeToString(svg)
        .replace(/[\u0000-\u0008\v\f\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu, '');
    const image = new Image();
    image.decoding = 'sync';
    // 先等 load 再 decode（截图库同样如此）：SVG 里内嵌的字体要到 load 才就绪，只等 decode 第一次画会用后备字体。
    await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('有一条消息没画出来。'));
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
    });
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale - 1e-6);
    canvas.height = Math.ceil(height * scale - 1e-6);
    if (Math.max(canvas.width, canvas.height) > 32767) throw new Error('图片过宽，请减小排版宽度或降低清晰度。');
    const context = canvas.getContext('2d');
    const draw = () => {
        context.fillStyle = `rgb(${background.r}, ${background.g}, ${background.b})`;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
    };
    draw();
    // Chromium 第一次画含内嵌图片的 SVG 时偶尔漏图（截图库的 fixSvgXmlDecode 也这么补）：隔一会儿再画一遍。
    for (let i = 0; i < Math.min(redraws, 3); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 + i));
        draw();
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('有一条消息没画出来。');
    return new Uint8Array(await blob.arrayBuffer());
}

// 只画消息本身：去掉多选时加的左边一列、提亮和勾选框。返回一段或几段 PNG（长消息分段）。
async function drawItem(item, scale, background, fontCss) {
    item.dataset.messageImageDrawing = ''; // 离屏的消息也要排版（shareImage.css）
    try {
        const style = getComputedStyle(item);
        const box = item.getBoundingClientRect();
        // 只移除根元素的内边距；克隆仍画边框，宽高按边框盒保留屏幕的亚像素精度。
        const width = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const height = box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        let images = 0;
        const zoom = layoutZoom();
        const broken = new Set([...item.querySelectorAll('img')].filter((img) => img.complete && !img.naturalWidth).map((img) => img.currentSrc || img.src));
        const svg = await domToForeignObjectSvg(item, {
            scale,
            width: Math.ceil(width),
            height: Math.ceil(height),
            backgroundColor: `rgb(${background.r}, ${background.g}, ${background.b})`,
            style: { padding: '0', margin: '0', boxShadow: 'none' },
            font: fontCss ? { cssText: fontCss } : false,
            filter: keepNode,
            // 屏幕上已经裂掉的图（文件不在了、后端拒绝）不再去取：每张要等请求失败，长的几秒。图里同样留空。
            fetchFn: async (url) => (broken.has(url) ? EMPTY_IMAGE : false),
            // 图里的代码块、表格不画滚动条：画出来的滚动条占地方，把最后一行挤掉。
            onCloneNode: (clone) => {
                snapBoxes(clone, zoom);
                clone.style.setProperty('zoom', String(zoom));
                clone.style.setProperty('width', `${snap(width, zoom)}px`, 'important');
                clone.style.setProperty('height', `${height}px`, 'important');
                const hide = document.createElement('style');
                hide.textContent = '* { scrollbar-width: none !important; } *::-webkit-scrollbar { display: none !important; }';
                clone.prepend(hide);
            },
            onEmbedNode: (clone) => { images = clone.querySelectorAll('img, image').length; },
        });
        const full = Math.ceil(height);
        const step = sliceHeight(scale, sliceLimit);
        const parts = [];
        for (let top = 0; top < full; top += step) {
            parts.push(await rasterize(svg, {
                width: Math.ceil(width), height: Math.min(step, full - top), top, full, zoom, scale, background, redraws: images,
            }));
        }
        return parts;
    } finally {
        delete item.dataset.messageImageDrawing;
    }
}

async function renderPreview(items, settings) {
    const background = backgroundOf(document.getElementById('chatMessages'));
    const fontCss = fontCssFor(await loadedFontCss(), codePoints(items));
    return withExportLayout(items, settings, async nodes => {
        checkSize(nodes, settings.pad, settings.scale);
        const parts = [];
        const gaps = [];
        for (const node of nodes) {
            const pieces = await drawItem(node, settings.scale, background, fontCss);
            pieces.forEach((piece, index) => {
                if (parts.length) gaps.push(index ? 0 : Math.round(GAP * settings.scale));
                parts.push(piece);
            });
        }
        return chatAPI.messageImagePrepare(parts, {
            pad: Math.round(settings.pad * settings.scale), gap: Math.round(GAP * settings.scale), gaps,
            background: [background.r, background.g, background.b],
        });
    });
}

// 消息离开视口太远时，正文会被回收（offscreenDomWindow），公式、图表也要滚到附近才补画。
// 画图前先把选中的消息恢复完整并锁住，关掉预览再放开。
async function holdItems(items) {
    const release = await messageRenderer?.holdMessagesForCapture?.(items) || (() => {});
    if (items.some((item) => item.dataset.vcpDomEvicted === 'true')) {
        release();
        throw new Error('有消息的正文尚未载入，请滚动到该消息附近后重试。');
    }
    return release;
}

// 所选消息里有没有工具调用、思考过程：没有的开关在面板里不可用。
function contentKinds(items) {
    return {
        tools: items.some((item) => item.querySelector(TOOL_BLOCKS.join(','))),
        thoughts: items.some((item) => item.querySelector(THOUGHT_BLOCKS.join(','))),
        timestamps: items.some((item) => item.querySelector(TIMESTAMP_SELECTOR)),
    };
}

let previewActive = false;
async function exportItems(items, how) {
    if (previewActive) return { canceled: true };
    if (!chatAPI?.messageImagePrepare || !chatAPI?.messageImageOutput) throw new Error('请完整退出并重新打开 Chat 以加载预览接口。');
    const topic = topicKey();
    previewActive = true;
    let release = () => {};
    try {
        release = await holdItems(items);
        const { openPreview } = await import('./preview.js');
        return await openPreview({
            initialWidth: Math.max(...items.map(contentWidth)),
            initialScale: Math.min(MAX_SCALE, Math.max(1, window.devicePixelRatio || 1)),
            primaryAction: how,
            count: items.length,
            available: contentKinds(items),
            render: settings => renderPreview(items, settings),
            output: (action, bytes) => chatAPI.messageImageOutput(action, bytes),
            isCurrent: () => topic === topicKey() && items.every(node => node.isConnected),
        });
    } finally {
        release();
        previewActive = false;
    }
}

async function copyOne(messageItem) {
    const id = messageItem?.dataset?.messageId;
    const item = messageItem?.isConnected ? messageItem
        : [...(document.getElementById('chatMessages')?.querySelectorAll(ITEMS) || [])].find((node) => node.dataset.messageId === id);
    if (!item) return;
    try {
        const result = await exportItems([item], 'copy');
        if (result.ok) toast(result.action === 'save' ? `已保存：${result.filePath}` : '已复制为图片', 'success');
    } catch (error) {
        toast(`复制为图片没成功：${error.message}`, 'error');
    }
}

// ---- 多选 ----

function addBox(item) {
    if (item.querySelector(':scope > .message-image-pick-box')) return;
    const box = document.createElement('span');
    box.className = 'message-image-chk message-image-pick-box';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', 'false');
    box.innerHTML = '<span class="box" aria-hidden="true">✓</span>';
    item.prepend(box);
}

function mark(item) {
    const on = picking.picked.has(item.dataset.messageId);
    if (on) item.dataset.messageImagePicked = '';
    else delete item.dataset.messageImagePicked;
    item.querySelector(':scope > .message-image-pick-box')?.setAttribute('aria-checked', String(on));
}

const pickedItems = () => [...picking.list.querySelectorAll(ITEMS)].filter((item) => picking.picked.has(item.dataset.messageId));

function update() {
    if (!picking) return;
    const count = pickedItems().length;
    picking.bar.querySelector('.message-image-pickbar-count b').textContent = String(count);
    for (const button of picking.bar.querySelectorAll('[data-act="copy"], [data-act="save"]')) button.disabled = picking.busy || !count;
    picking.bar.querySelector('[data-act="cancel"]').disabled = picking.busy;
}

const say = (text) => { if (picking) picking.bar.querySelector('.message-image-pickbar-say').textContent = text; };

function toggle(item) {
    const id = item?.dataset?.messageId;
    if (!picking || !id) return;
    if (picking.picked.has(id)) picking.picked.delete(id);
    else picking.picked.add(id);
    mark(item);
    update();
}

// 消息重画、流式追加、切话题都会动列表：补上勾选框；换了话题就退出多选。
function refresh() {
    if (!picking) return;
    picking.frame = 0;
    if (topicKey() !== picking.topic || !picking.list.isConnected) {
        stopPicking();
        return;
    }
    for (const item of picking.list.querySelectorAll(ITEMS)) {
        addBox(item);
        mark(item);
    }
    update();
}

function onClick(event) {
    const item = event.target.closest?.('.message-item');
    if (!picking || !item || item.parentElement !== picking.list) return;
    event.preventDefault();
    event.stopPropagation();
    if (!picking.busy) toggle(item);
}

function onKey(event) {
    if (!picking || previewActive || event.key !== 'Escape') return;
    event.preventDefault(); // 不然 Esc 还会打开 ESC 菜单
    event.stopPropagation();
    if (!picking.busy) stopPicking();
}

async function runPicked(how) {
    const items = pickedItems();
    if (!picking || picking.busy || !items.length) return;
    picking.busy = true;
    say('正在生成图片');
    update();
    try {
        const result = await exportItems(items, how);
        if (result.canceled) {
            say('');
            return;
        }
        stopPicking();
        toast(result.action === 'save' ? `已保存：${result.filePath}` : `已复制 ${items.length} 条消息的图片`, 'success');
    } catch (error) {
        say(error.message);
    } finally {
        if (picking) {
            picking.busy = false;
            update();
        }
    }
}

function buildBar() {
    const bar = document.createElement('div');
    bar.className = 'message-image-pickbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '多选消息');
    bar.innerHTML = '<span class="message-image-pickbar-count">已选 <b>0</b> 条</span><span class="message-image-pickbar-say" aria-live="polite"></span>'
        + '<button type="button" class="message-image-btn ghost small" data-act="cancel">取消</button>'
        + '<button type="button" class="message-image-btn ghost small" data-act="save">保存为图片</button>'
        + '<button type="button" class="message-image-btn primary small" data-act="copy">复制为图片</button>';
    bar.addEventListener('click', (event) => {
        const act = event.target.closest('[data-act]')?.dataset.act;
        if (act === 'cancel') stopPicking();
        else if (act) void runPicked(act);
    });
    return bar;
}

function startPicking(first) {
    if (picking) {
        if (first) toggle(first);
        return;
    }
    const list = document.getElementById('chatMessages');
    const card = document.querySelector('.chat-input-area .chat-input-card');
    if (!list || !card) return;
    picking = { list, card, bar: buildBar(), picked: new Set(), busy: false, topic: topicKey(), observer: null, frame: 0 };
    list.classList.add('message-image-picking');
    card.classList.add('message-image-picking');
    card.append(picking.bar);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    // 定时器而不是 requestAnimationFrame：窗口藏着时（托盘、最小化）动画帧不来，切话题也要能退出。
    picking.observer = new MutationObserver(() => {
        if (picking && !picking.frame) picking.frame = setTimeout(refresh, 50);
    });
    picking.observer.observe(list, { childList: true, subtree: true });
    if (first?.dataset?.messageId) picking.picked.add(first.dataset.messageId);
    refresh();
}

function stopPicking() {
    if (!picking) return;
    const { list, card, bar, observer, frame } = picking;
    picking = null;
    observer.disconnect();
    if (frame) clearTimeout(frame);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    list.classList.remove('message-image-picking');
    list.querySelectorAll('.message-image-pick-box').forEach((box) => box.remove());
    list.querySelectorAll('[data-message-image-picked]').forEach((item) => delete item.dataset.messageImagePicked);
    card.classList.remove('message-image-picking');
    bar.remove();
}

// ---- 入口 ----

function registerCommands() {
    const commands = window.VCPContributions?.commands;
    if (!commands) {
        window.addEventListener('vcp-contributions-ready', registerCommands, { once: true });
        return;
    }
    if (commands.get('message-menu.message-image-copy-image')) return;
    const owner = { ownerId: 'MessageImage' };
    commands.register({ id: 'message-menu.message-image-copy-image', label: '复制为图片', icon: 'fas fa-image', handler: ({ messageItem } = {}) => copyOne(messageItem) }, owner);
    commands.register({ id: 'message-menu.message-image-pick', label: '多选', icon: 'fas fa-check-double', handler: ({ messageItem } = {}) => startPicking(messageItem) }, owner);
}

export function install(context = {}) {
    chatAPI = context.chatAPI || window.chatAPI || null;
    messageRenderer = context.messageRenderer || null;
    refs = context.refs || null;
    if (![...document.querySelectorAll('link[rel="stylesheet"]')].some((link) => link.href === STYLESHEET)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = STYLESHEET;
        document.head.append(link);
    }
    registerCommands();
}

// 测试用
export const _test = { setSliceLimit: (value) => { sliceLimit = value || SLICE; }, startPicking, stopPicking, exportItems, renderPreview, loadedFontCss, holdItems, pickedItems: () => (picking ? pickedItems() : []), isPicking: () => Boolean(picking) };
