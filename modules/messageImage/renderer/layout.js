// 只在用户要求重排或过滤时创建排版页；原会话不随预览调整。
export const TOOL_BLOCKS = [
    '.vcp-tool-run-line', '.vcp-tool-use-bubble', '.vcp-tool-result-bubble',
    '.vcp-tool-call-summary-bubble', '.vcp-tool-run-calls', '[data-vcp-tool-run]',
    '[data-vcp-block-type="tool-batch"]',
];
export const THOUGHT_BLOCKS = ['.vcp-thought-chain-bubble', '.thinking-indicator'];

export const TIMESTAMP_SELECTOR = '.message-timestamp';

export function contentWidth(item) {
    const style = getComputedStyle(item);
    return item.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}

function copyAttributes(from, to) {
    for (const attr of from.attributes) {
        if (!attr.name.toLowerCase().startsWith('on')) to.setAttribute(attr.name, attr.value);
    }
}

function staticItem(doc, source, settings) {
    const copy = doc.importNode(source, true);
    const omit = ['script', 'object', 'embed', 'iframe', '.message-image-pick-box'];
    if (!settings.tools) omit.push(...TOOL_BLOCKS);
    if (!settings.thoughts) omit.push(...THOUGHT_BLOCKS);
    if (settings.timestamps === false) omit.push(TIMESTAMP_SELECTOR);
    const canvases = source.querySelectorAll('canvas');
    copy.querySelectorAll('canvas').forEach((canvas, i) => {
        if (canvases[i].width && canvases[i].height) canvas.getContext('2d')?.drawImage(canvases[i], 0, 0);
    });
    copy.querySelectorAll(omit.join(',')).forEach(node => node.remove());
    copy.removeAttribute('data-message-image-picked');
    copy.dataset.messageImageDrawing = '';
    const width = settings.width ?? contentWidth(source);
    for (const [key, value] of Object.entries({
        width: `${width}px`, 'max-width': 'none', 'min-width': '0', height: 'auto',
        padding: '0', 'box-sizing': 'border-box', 'content-visibility': 'visible',
    })) copy.style.setProperty(key, value, 'important');
    return copy;
}

export async function withExportLayout(items, settings, draw) {
    if (settings.width == null && settings.tools && settings.thoughts && settings.timestamps !== false) return draw(items);
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = `position:fixed;pointer-events:none;left:-100000px;top:0;border:0;width:${innerWidth}px;height:${innerHeight}px`;
    document.body.append(frame);
    try {
        const doc = frame.contentDocument;
        copyAttributes(document.documentElement, doc.documentElement);
        copyAttributes(document.body, doc.body);
        const base = doc.createElement('base');
        base.href = document.baseURI;
        doc.head.append(base);
        await Promise.all([...document.querySelectorAll('head style, head link[rel="stylesheet"]')].map(node => new Promise(resolve => {
            const clone = doc.importNode(node, true);
            const wait = clone.localName === 'link' && !node.disabled;
            if (wait) clone.onload = clone.onerror = resolve;
            doc.head.append(clone);
            if (!wait) resolve();
        })));
        const ancestors = [];
        for (let p = items[0].parentElement; p && p !== document.body; p = p.parentElement) ancestors.unshift(p);
        let parent = doc.body;
        for (const ancestor of ancestors) {
            const clone = doc.importNode(ancestor, false);
            parent.append(clone);
            parent = clone;
        }
        const copies = items.map(item => staticItem(doc, item, settings));
        parent.append(...copies);
        copies[0].getBoundingClientRect();
        await Promise.all([doc.fonts.ready, ...copies.flatMap(copy => [...copy.querySelectorAll('img')].map(img => {
            img.loading = 'eager';
            return img.decode().catch(() => {});
        }))]);
        return await draw(copies);
    } finally {
        frame.remove();
    }
}