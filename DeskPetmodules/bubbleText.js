/* 桌宠气泡里显示的文字。回复原文是 Markdown（有时夹着 HTML），气泡只有几行高，
 * 记号原样显示既占地方又难读，这里整理成纯文字。不依赖 DOM，测试里可以直接载入。 */

/**
 * 去掉标题、引用、强调、链接这些 Markdown 记号和 HTML 标签，列表换成圆点，图片写成 [图片]。
 * 流式时没写完的记号先原样留着，写完那一刻就整理掉。
 */
export function toBubbleText(markdown) {
    return String(markdown || '')
        .replace(/<img\b[^>]*>/gi, '[图片]')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?[a-z][\w-]*(?:\s[^<>]*)?>/gi, '')
        .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '[图片]')
        .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
        .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
        .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
        .replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
        .replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ')
        .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
        .replace(/~~(?=\S)([^\n]*?\S)~~/g, '$1')
        .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1$2')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
}
