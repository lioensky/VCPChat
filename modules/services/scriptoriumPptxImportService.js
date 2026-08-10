'use strict';

const path = require('path');
const JSZip = require('jszip');

const EMU_PER_INCH = 914400;
const DEFAULT_SLIDE_WIDTH = 12192000;
const DEFAULT_SLIDE_HEIGHT = 6858000;

function decodeXml(value) {
    // XML 基础实体必须最后解码 &，否则像 &lt; 这样的文本会被
    // 意外二次解释为标签字符。数字实体同样常见于 Office 生成的文本。
    return String(value || '')
        .replace(/&#x([0-9a-f]+);/gi, (_match, hex) =>
            String.fromCodePoint(Number.parseInt(hex, 16))
        )
        .replace(/&#(\d+);/g, (_match, decimal) =>
            String.fromCodePoint(Number.parseInt(decimal, 10))
        )
        .replace(/</gi, '<')
        .replace(/>/gi, '>')
        .replace(/"/gi, '"')
        .replace(/'/gi, "'")
        .replace(/&/gi, '&');
}

function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (character) =>
        `&#${character.charCodeAt(0)};`
    );
}

function xmlAttribute(source, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(source || '').match(
        new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]*)"|'([^']*)')`, 'i')
    );
    return decodeXml(match?.[1] ?? match?.[2] ?? '');
}

function numberAttribute(source, name, fallback = 0) {
    const value = Number(xmlAttribute(source, name));
    return Number.isFinite(value) ? value : fallback;
}

function normalizeZipPath(baseFile, target) {
    const base = path.posix.dirname(baseFile);
    return path.posix.normalize(path.posix.join(base, String(target || '')))
        .replace(/^\/+/, '');
}

function parseRelationships(xml, ownerFile) {
    const relationships = new Map();
    const pattern = /<Relationship\b([^>]*?)\/?>/gi;
    let match;
    while ((match = pattern.exec(String(xml || '')))) {
        const id = xmlAttribute(match[1], 'Id');
        const target = xmlAttribute(match[1], 'Target');
        if (!id || !target) continue;
        relationships.set(id, {
            id,
            type: xmlAttribute(match[1], 'Type'),
            target: normalizeZipPath(ownerFile, target),
        });
    }
    return relationships;
}

function relationshipFileFor(ownerFile) {
    return path.posix.join(
        path.posix.dirname(ownerFile),
        '_rels',
        `${path.posix.basename(ownerFile)}.rels`
    );
}

function parsePresentationSize(xml) {
    const match = String(xml || '').match(/<p:sldSz\b([^>]*)\/?>/i);
    const width = numberAttribute(match?.[1], 'cx', DEFAULT_SLIDE_WIDTH);
    const height = numberAttribute(match?.[1], 'cy', DEFAULT_SLIDE_HEIGHT);
    return {
        width,
        height,
        cssWidth: `${width / EMU_PER_INCH}in`,
        cssHeight: `${height / EMU_PER_INCH}in`,
    };
}

function parseSlideOrder(presentationXml, relationships) {
    const ordered = [];
    const pattern = /<p:sldId\b([^>]*)\/?>/gi;
    let match;
    while ((match = pattern.exec(String(presentationXml || '')))) {
        const relationId = xmlAttribute(match[1], 'r:id');
        const relation = relationships.get(relationId);
        if (relation?.target) ordered.push(relation.target);
    }
    return ordered;
}

function transformFromXml(xml) {
    const xfrm = String(xml || '').match(/<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm>/i)
        || String(xml || '').match(/<p:xfrm\b[^>]*>([\s\S]*?)<\/p:xfrm>/i);
    const body = xfrm?.[1] || '';
    const offset = body.match(/<a:off\b([^>]*)\/?>/i);
    const extent = body.match(/<a:ext\b([^>]*)\/?>/i);
    const attributes = xfrm?.[0]?.match(/<(?:a|p):xfrm\b([^>]*)>/i)?.[1] || '';
    return {
        x: numberAttribute(offset?.[1], 'x'),
        y: numberAttribute(offset?.[1], 'y'),
        width: numberAttribute(extent?.[1], 'cx'),
        height: numberAttribute(extent?.[1], 'cy'),
        rotation: numberAttribute(attributes, 'rot') / 60000,
        flipH: xmlAttribute(attributes, 'flipH') === '1',
        flipV: xmlAttribute(attributes, 'flipV') === '1',
    };
}

function percentage(value, total) {
    if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return '0%';
    return `${(value / total * 100).toFixed(5)}%`;
}

function transformStyle(transform, size, zIndex) {
    const transforms = [];
    if (transform.rotation) transforms.push(`rotate(${transform.rotation}deg)`);
    if (transform.flipH) transforms.push('scaleX(-1)');
    if (transform.flipV) transforms.push('scaleY(-1)');
    return [
        'position:absolute',
        `left:${percentage(transform.x, size.width)}`,
        `top:${percentage(transform.y, size.height)}`,
        `width:${percentage(transform.width, size.width)}`,
        `height:${percentage(transform.height, size.height)}`,
        `z-index:${zIndex}`,
        'box-sizing:border-box',
        'transform-origin:center',
        transforms.length ? `transform:${transforms.join(' ')}` : '',
    ].filter(Boolean).join(';');
}

function colorFromXml(xml, fallback = '') {
    const srgb = String(xml || '').match(/<a:srgbClr\b([^>]*)\/?>/i);
    if (srgb) {
        const value = xmlAttribute(srgb[1], 'val');
        if (/^[0-9a-f]{6}$/i.test(value)) return `#${value}`;
    }
    const scheme = String(xml || '').match(/<a:schemeClr\b([^>]*)\/?>/i);
    const schemeName = xmlAttribute(scheme?.[1], 'val');
    const schemeFallbacks = {
        dk1: '#1d2421',
        lt1: '#ffffff',
        dk2: '#44504b',
        lt2: '#f2efe7',
        accent1: '#4472c4',
        accent2: '#ed7d31',
        accent3: '#a5a5a5',
        accent4: '#ffc000',
        accent5: '#5b9bd5',
        accent6: '#70ad47',
        tx1: '#1d2421',
        bg1: '#ffffff',
    };
    return schemeFallbacks[schemeName] || fallback;
}

function shapeVisualStyle(xml) {
    const fillBlock = String(xml || '').match(/<a:solidFill\b[^>]*>([\s\S]*?)<\/a:solidFill>/i);
    const lineBlock = String(xml || '').match(/<a:ln\b([^>]*)>([\s\S]*?)<\/a:ln>/i);
    const fill = colorFromXml(fillBlock?.[1], '');
    const stroke = colorFromXml(lineBlock?.[2], '');
    const lineWidth = numberAttribute(lineBlock?.[1], 'w') / 12700;
    const noFill = /<a:noFill\b/i.test(String(xml || ''));
    const styles = [];
    if (noFill) styles.push('background:transparent');
    else if (fill) styles.push(`background:${fill}`);
    if (stroke) styles.push(`border:${Math.max(.5, lineWidth || 1)}pt solid ${stroke}`);
    return styles.join(';');
}

function paragraphAlignment(xml) {
    const paragraph = String(xml || '').match(/<a:pPr\b([^>]*)\/?>/i);
    const alignment = xmlAttribute(paragraph?.[1], 'algn');
    return {
        l: 'left',
        ctr: 'center',
        r: 'right',
        just: 'justify',
        dist: 'justify',
    }[alignment] || '';
}

function textRunHtml(runXml) {
    const text = decodeXml(runXml.match(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/i)?.[1] || '');
    if (!text) return '';
    const properties = runXml.match(/<a:rPr\b([^>]*)\/?>/i)?.[1] || '';
    const size = numberAttribute(properties, 'sz') / 100;
    const bold = xmlAttribute(properties, 'b') === '1';
    const italic = xmlAttribute(properties, 'i') === '1';
    const underline = xmlAttribute(properties, 'u');
    const colorBlock = runXml.match(/<a:solidFill\b[^>]*>([\s\S]*?)<\/a:solidFill>/i);
    const color = colorFromXml(colorBlock?.[1], '');
    const typeface = runXml.match(/<a:(?:latin|ea)\b([^>]*)\/?>/i);
    const family = xmlAttribute(typeface?.[1], 'typeface');
    const styles = [
        size ? `font-size:${size}pt` : '',
        bold ? 'font-weight:700' : '',
        italic ? 'font-style:italic' : '',
        underline && underline !== 'none' ? 'text-decoration:underline' : '',
        color ? `color:${color}` : '',
        family ? `font-family:${JSON.stringify(family)}` : '',
    ].filter(Boolean).join(';');
    return `<span${styles ? ` style="${escapeHtml(styles)}"` : ''}>${escapeHtml(text)}</span>`;
}

function paragraphHtml(paragraphXml) {
    const parts = [];
    const runPattern = /<a:(r|fld)\b[^>]*>([\s\S]*?)<\/a:\1>|<a:br\b[^>]*\/?>/gi;
    let match;
    while ((match = runPattern.exec(String(paragraphXml || '')))) {
        if (/^<a:br/i.test(match[0])) parts.push('<br>');
        else parts.push(textRunHtml(match[0]));
    }
    if (!parts.length) {
        const plainText = [...String(paragraphXml || '').matchAll(
            /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi
        )].map((item) => escapeHtml(decodeXml(item[1]))).join('');
        if (plainText) parts.push(plainText);
    }
    const alignment = paragraphAlignment(paragraphXml);
    return `<p${alignment ? ` style="text-align:${alignment}"` : ''}>${parts.join('') || '<br>'}</p>`;
}

function textBodyHtml(xml) {
    const body = String(xml || '').match(/<p:txBody\b[^>]*>([\s\S]*?)<\/p:txBody>/i)
        || String(xml || '').match(/<a:txBody\b[^>]*>([\s\S]*?)<\/a:txBody>/i);
    if (!body) return '';
    return [...body[1].matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi)]
        .map((match) => paragraphHtml(match[1]))
        .join('');
}

function shapeName(xml, fallback) {
    const properties = String(xml || '').match(/<p:cNvPr\b([^>]*)\/?>/i);
    return xmlAttribute(properties?.[1], 'name') || fallback;
}

function mimeTypeForFile(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    return {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.emf': 'image/emf',
        '.wmf': 'image/wmf',
    }[extension] || 'application/octet-stream';
}

async function imageDataUrl(zip, target) {
    const file = zip.file(target);
    if (!file) return '';
    const bytes = await file.async('nodebuffer');
    return `data:${mimeTypeForFile(target)};base64,${bytes.toString('base64')}`;
}

async function parsePicture(xml, context) {
    const relationId = xmlAttribute(
        String(xml || '').match(/<a:blip\b([^>]*)\/?>/i)?.[1],
        'r:embed'
    );
    const relation = context.relationships.get(relationId);
    const dataUrl = relation?.target
        ? await imageDataUrl(context.zip, relation.target)
        : '';
    const transform = transformFromXml(xml);
    const alt = shapeName(xml, `图片 ${context.zIndex}`);
    return `<figure class="pptx-picture" data-pptx-kind="picture" data-pptx-name="${escapeHtml(alt)}" style="${transformStyle(transform, context.size, context.zIndex)}">
    ${dataUrl
        ? `<img src="${dataUrl}" alt="${escapeHtml(alt)}" style="width:100%;height:100%;display:block;object-fit:fill">`
        : `<div class="pptx-missing-media">缺失图片</div>`}
</figure>`;
}

function parseShape(xml, context) {
    const transform = transformFromXml(xml);
    const text = textBodyHtml(xml);
    const name = shapeName(xml, `元素 ${context.zIndex}`);
    const visualStyle = shapeVisualStyle(xml);
    const style = [
        transformStyle(transform, context.size, context.zIndex),
        visualStyle,
        'overflow:hidden',
    ].filter(Boolean).join(';');
    return `<div class="pptx-shape" data-pptx-kind="${text ? 'text' : 'shape'}" data-pptx-name="${escapeHtml(name)}" style="${style}">
    ${text ? `<div class="pptx-text-frame">${text}</div>` : ''}
</div>`;
}

function topLevelSlideObjects(slideXml) {
    const tree = String(slideXml || '').match(/<p:spTree\b[^>]*>([\s\S]*?)<\/p:spTree>/i)?.[1] || '';
    const objects = [];
    const tokenPattern = /<p:(sp|pic|graphicFrame|grpSp|cxnSp)\b/g;
    let token;
    while ((token = tokenPattern.exec(tree))) {
        const tag = token[1];
        const start = token.index;
        const openEnd = tree.indexOf('>', start);
        if (openEnd < 0) break;
        if (tree[openEnd - 1] === '/') {
            objects.push({ tag, xml: tree.slice(start, openEnd + 1) });
            tokenPattern.lastIndex = openEnd + 1;
            continue;
        }
        const closeTag = `</p:${tag}>`;
        const close = tree.indexOf(closeTag, openEnd + 1);
        if (close < 0) continue;
        objects.push({
            tag,
            xml: tree.slice(start, close + closeTag.length),
        });
        tokenPattern.lastIndex = close + closeTag.length;
    }
    return objects;
}

async function parseSlide(zip, slideFile, size, index) {
    const slideXml = await zip.file(slideFile)?.async('string');
    if (!slideXml) {
        return {
            name: `第 ${index + 1} 页`,
            source: '<section class="vdoc-slide-scene"><p>无法读取此幻灯片。</p></section>',
            warnings: [{ type: 'missing-slide', message: `缺失 ${slideFile}` }],
        };
    }
    const relationFile = relationshipFileFor(slideFile);
    const relationshipXml = await zip.file(relationFile)?.async('string') || '';
    const relationships = parseRelationships(relationshipXml, slideFile);
    const objects = topLevelSlideObjects(slideXml);
    const elements = [];
    for (let objectIndex = 0; objectIndex < objects.length; objectIndex += 1) {
        const object = objects[objectIndex];
        const context = {
            zip,
            relationships,
            size,
            zIndex: objectIndex + 1,
        };
        if (object.tag === 'pic') elements.push(await parsePicture(object.xml, context));
        else if (object.tag === 'sp' || object.tag === 'cxnSp') {
            elements.push(parseShape(object.xml, context));
        } else {
            elements.push(`<div class="pptx-unsupported-object" data-pptx-kind="${object.tag}" style="${transformStyle(transformFromXml(object.xml), size, objectIndex + 1)}"></div>`);
        }
    }

    const hasAnimation = /<p:timing\b|<p:transition\b/i.test(slideXml);
    const titleText = decodeXml(
        slideXml.match(/<p:ph\b[^>]*\btype=(?:"title"|'title')[^>]*>[\s\S]*?<a:t\b[^>]*>([\s\S]*?)<\/a:t>/i)?.[1]
        || ''
    );
    const slideCss = `.pptx-imported-slide{position:relative;width:100%;height:100%;overflow:hidden;background:#fff;color:#1d2421}
.pptx-shape,.pptx-picture{margin:0}
.pptx-text-frame{width:100%;height:100%;padding:.08in;overflow:hidden;box-sizing:border-box}
.pptx-text-frame p{margin:0;line-height:1.15;white-space:pre-wrap}
.pptx-missing-media{display:grid;width:100%;height:100%;place-items:center;background:#eee;color:#777;font:12px sans-serif}`;
    return {
        name: titleText.trim() || `第 ${index + 1} 页`,
        source: `<style data-vdoc-slide-style>
${slideCss}
</style>
<section class="vdoc-slide-scene pptx-imported-slide" data-pptx-slide="${index + 1}">
${elements.join('\n')}
</section>`,
        transition: /<p:transition\b/i.test(slideXml) ? 'pptx-imported' : 'none',
        import: {
            sourceSlide: slideFile,
            hadNativeAnimation: hasAnimation,
        },
        warnings: hasAnimation ? [{
            type: 'animation-not-translated',
            message: `第 ${index + 1} 页包含原生转场或动画，已保留静态版式。`,
        }] : [],
    };
}

async function convertPptx(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const presentationFile = 'ppt/presentation.xml';
    const presentationXml = await zip.file(presentationFile)?.async('string');
    if (!presentationXml) throw new Error('PPTX 中缺少 ppt/presentation.xml。');

    const relationshipXml = await zip.file(
        relationshipFileFor(presentationFile)
    )?.async('string') || '';
    const relationships = parseRelationships(relationshipXml, presentationFile);
    const size = parsePresentationSize(presentationXml);
    const slideFiles = parseSlideOrder(presentationXml, relationships);
    if (!slideFiles.length) throw new Error('PPTX 中没有可导入的幻灯片。');

    const slides = [];
    const warnings = [];
    for (let index = 0; index < slideFiles.length; index += 1) {
        const slide = await parseSlide(zip, slideFiles[index], size, index);
        warnings.push(...slide.warnings);
        slides.push({
            name: slide.name,
            source: slide.source,
            transition: slide.transition,
            duration: null,
            notes: '',
            resources: [],
            import: slide.import,
        });
    }

    return {
        kind: 'pptx',
        slides,
        page: {
            width: size.cssWidth,
            height: size.cssHeight,
        },
        warnings,
    };
}

module.exports = {
    EMU_PER_INCH,
    parseRelationships,
    parsePresentationSize,
    parseSlideOrder,
    transformFromXml,
    textBodyHtml,
    topLevelSlideObjects,
    convertPptx,
};