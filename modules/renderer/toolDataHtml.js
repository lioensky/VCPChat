/** 工具数据专用 HTML 投影；不授予脚本、样式、嵌入或交互能力。 */
export function sanitizeToolDataHtml(html, document) {
    if (!document?.createElement) {
        return String(html).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
    }
    const template = document.createElement('template');
    template.innerHTML = String(html);
    const allowed = new Set('p br hr div span pre code blockquote ul ol li table thead tbody tfoot tr th td strong b em i del s h1 h2 h3 h4 h5 h6 a img'.split(' '));
    const discard = new Set('script style iframe object embed link meta base form input button textarea select option svg math canvas video audio source track template'.split(' '));
    for (const element of [...template.content.querySelectorAll('*')]) {
        const tag = element.localName;
        if (!allowed.has(tag)) {
            if (discard.has(tag)) element.remove();
            else element.replaceWith(...element.childNodes);
            continue;
        }
        for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase();
            const value = attribute.value.trim();
            const safeUrl = /^(?:https?:\/\/|file:\/\/)/i.test(value)
                && !/[\u0000-\u0020"'<>`]/.test(value);
            const permitted = name === 'class' && /^[\w -]*$/.test(value)
                || ['title', 'alt'].includes(name)
                || ['colspan', 'rowspan', 'start'].includes(name) && /^\d{1,4}$/.test(value)
                || tag === 'a' && name === 'href' && (safeUrl || /^#[\w-]+$/.test(value))
                || tag === 'img' && name === 'src' && safeUrl;
            if (!permitted) element.removeAttribute(attribute.name);
        }
        if (tag === 'a') {
            element.setAttribute('target', '_blank');
            element.setAttribute('rel', 'noopener noreferrer');
        }
    }
    return template.innerHTML;
}