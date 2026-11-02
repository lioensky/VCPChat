'use strict';
// 把文坊里对 PDF 的改动写进 PDF（pdf-lib，chat/vendor/pdf-lib）。页面送来一份“计划”，坐标都已经换成 PDF 自己的（左下角是原点、单位是点）：
//   pages：输出的每一页从哪来 [{ src: 'main' | 来源 id, index, rotate（最后的角度）} | { blank: { w, h }, rotate, image? }]；
//     image：整页换成这张图（涂黑过的页由页面画成图片交过来，被覆盖的文字确实被移除）；
//   sources：{ 来源 id: 另一个 PDF 的路径 }（“并进来”的页）；
//   objects：[{ page: 输出第几页, type: 'text' | 'rect' | 'image' | 'line', ... }]，rotate 是逆时针的角度（和页面转的方向相反，让东西在屏幕上是正的）；
//   fields：[{ name, value }] 表单里填的值；
//   stamps：每一页都加的 { pageNumbers: { format, size }, watermark: { text, size, opacity, color } }，按页面显示的方向摆正。
// 做法：在原文档上直接改（书签、元数据、表单都留着）——先填表，再把页面按计划摘下来重新排（删掉的不再放回去，同一页用两次就复制一份），
// 再画东西。中文用 fonts.js 找到的系统字体按用到的字嵌进去；页面已经把没字体时的中文画成了图片。
const { PDFDocument, rgb, degrees, StandardFonts, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList } = require('../../../vendor/pdf-lib/pdf-lib.min.js');
const fontkit = require('../../../vendor/pdf-lib/fontkit.umd.min.js');
const { cjkFont } = require('./fonts');

const color = (value, fallback = [0, 0, 0]) => {
    const [r, g, b] = Array.isArray(value) && value.length === 3 ? value : fallback;
    return rgb(Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, g)), Math.min(1, Math.max(0, b)));
};
const needsCjk = (text) => /[^\u0000-ÿ]/.test(String(text || ''));

async function apply(bytes, plan = {}, deps = {}) {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
    doc.registerFontkit(fontkit);
    let cjk = null;
    let latin = null;
    const fontFor = async (text) => {
        if (needsCjk(text)) {
            if (!cjk) {
                const found = cjkFont();
                if (!found) throw new Error('未在本机找到可写入中文的字体。');
                cjk = await doc.embedFont(found.bytes, { subset: true });
            }
            return cjk;
        }
        if (!latin) latin = await doc.embedFont(StandardFonts.Helvetica);
        return latin;
    };

    // 1. 表单：先填（页面挪动之前，表单还完整）。
    const values = Array.isArray(plan.fields) ? plan.fields : [];
    if (values.length) {
        const form = doc.getForm();
        let formFont = null;
        for (const { name, value } of values) {
            const field = form.getFieldMaybe?.(name) || form.getFields().find((item) => item.getName() === name);
            if (!field) continue;
            if (field instanceof PDFTextField) {
                field.setText(String(value ?? ''));
                if (needsCjk(value)) formFont = formFont || await fontFor('中');
            } else if (field instanceof PDFCheckBox) {
                if (value) field.check(); else field.uncheck();
            } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
                if (value) field.select(String(value)); else field.clear();
            } else if (field instanceof PDFRadioGroup) {
                if (value) field.select(String(value));
            }
        }
        form.updateFieldAppearances(formFont || await fontFor('a'));
    }

    // 2. 页面：按计划重新排。
    const original = doc.getPages();
    const used = new Set();
    const loaded = new Map();
    const target = [];
    for (const entry of Array.isArray(plan.pages) ? plan.pages : original.map((_page, index) => ({ src: 'main', index }))) {
        let page;
        if (entry.blank) {
            page = doc.addPage([Number(entry.blank.w) || 595.28, Number(entry.blank.h) || 841.89]);
            doc.removePage(doc.getPageCount() - 1);
        } else if (entry.src === 'main' || !entry.src) {
            const source = original[entry.index];
            if (!source) throw new Error(`原文件里没有第 ${Number(entry.index) + 1} 页。`);
            if (used.has(entry.index)) [page] = await doc.copyPages(doc, [entry.index]);
            else page = source;
            used.add(entry.index);
        } else {
            const file = plan.sources?.[entry.src];
            if (!file) throw new Error('要合并的 PDF 已找不到。');
            if (!loaded.has(entry.src)) loaded.set(entry.src, await PDFDocument.load(await deps.readSource(file), { ignoreEncryption: false }));
            [page] = await doc.copyPages(loaded.get(entry.src), [entry.index]);
        }
        if (entry.rotate !== undefined) page.setRotation(degrees(((Number(entry.rotate) % 360) + 360) % 360));
        if (entry.blank && entry.image) {
            const data = Buffer.from(String(entry.image).replace(/^data:image\/\w+;base64,/, ''), 'base64');
            const image = /^data:image\/jpe?g/i.test(entry.image) ? await doc.embedJpg(data) : await doc.embedPng(data);
            page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
        }
        target.push(page);
    }
    for (let index = doc.getPageCount() - 1; index >= 0; index -= 1) doc.removePage(index);
    target.forEach((page, index) => doc.insertPage(index, page));

    // 3. 画东西。
    for (const item of Array.isArray(plan.objects) ? plan.objects : []) {
        const page = target[item.page];
        if (!page) continue;
        const rotate = degrees(Number(item.rotate) || 0);
        if (item.type === 'rect') {
            page.drawRectangle({
                x: item.x, y: item.y, width: item.w, height: item.h, rotate,
                ...(item.fill ? { color: color(item.fill) } : {}),
                ...(item.stroke ? { borderColor: color(item.stroke), borderWidth: Number(item.width) || 1 } : { borderWidth: 0 }),
                opacity: item.opacity ?? 1, borderOpacity: item.opacity ?? 1,
            });
        } else if (item.type === 'line') {
            page.drawLine({ start: { x: item.x1, y: item.y1 }, end: { x: item.x2, y: item.y2 }, thickness: Number(item.width) || 1.5, color: color(item.color), opacity: item.opacity ?? 1 });
        } else if (item.type === 'image') {
            const data = Buffer.from(String(item.data || '').replace(/^data:image\/\w+;base64,/, ''), 'base64');
            const image = /^data:image\/jpe?g/i.test(item.data || '') ? await doc.embedJpg(data) : await doc.embedPng(data);
            page.drawImage(image, { x: item.x, y: item.y, width: item.w, height: item.h, rotate, opacity: item.opacity ?? 1 });
        } else if (item.type === 'text') {
            const lines = String(item.text || '').split('\n');
            const size = Number(item.size) || 12;
            const font = await fontFor(item.text);
            const lineHeight = size * 1.25;
            // 多行：一行一行往“下”排（下是相对文字的方向，页面转过也一样）。
            const angle = (Number(item.rotate) || 0) * Math.PI / 180;
            lines.forEach((line, k) => {
                if (!line) return;
                const dx = Math.sin(angle) * lineHeight * k;
                const dy = -Math.cos(angle) * lineHeight * k;
                page.drawText(line, { x: item.x + dx, y: item.y + dy, size, font, color: color(item.color), rotate });
            });
        }
    }
    // 4. 每页都加的：页码、水印。
    const stamps = plan.stamps || {};
    if (stamps.pageNumbers || stamps.watermark?.text) {
        const total = target.length;
        for (const [index, page] of target.entries()) {
            const frame = uprightFrame(page);
            if (stamps.watermark?.text) {
                const mark = stamps.watermark;
                const text = String(mark.text).slice(0, 80);
                const font = await fontFor(text);
                const size = Number(mark.size) || Math.min(frame.w, frame.h) / Math.max(4, text.length * 0.9);
                const width = font.widthOfTextAtSize(text, size);
                const angle = 30 * Math.PI / 180; // 斜着往右上
                const cx = frame.w / 2 - Math.cos(angle) * width / 2 + Math.sin(angle) * size * 0.35;
                const cy = frame.h / 2 - Math.sin(angle) * width / 2 - Math.cos(angle) * size * 0.35;
                const at = frame.toPdf(cx, cy);
                page.drawText(text, { x: at.x, y: at.y, size, font, color: color(mark.color, [0.5, 0.5, 0.5]), opacity: mark.opacity ?? 0.18, rotate: degrees(frame.rot + 30) });
            }
            if (stamps.pageNumbers) {
                const format = String(stamps.pageNumbers.format || '{n} / {total}');
                const text = format.replace('{n}', String(index + 1)).replace('{total}', String(total));
                const font = await fontFor(text);
                const size = Number(stamps.pageNumbers.size) || 10;
                const width = font.widthOfTextAtSize(text, size);
                const at = frame.toPdf(frame.w / 2 - width / 2, 22);
                page.drawText(text, { x: at.x, y: at.y, size, font, color: color(stamps.pageNumbers.color, [0.35, 0.35, 0.35]), rotate: degrees(frame.rot) });
            }
        }
    }
    return doc.save();
}

// 一页“看上去”的坐标：左下角是原点、往右往上（页面转过也是看上去的方向），换成 PDF 自己的坐标。
function uprightFrame(page) {
    const box = page.getMediaBox();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const [W, H] = [box.width, box.height];
    const w = rot % 180 ? H : W;
    const h = rot % 180 ? W : H;
    const toPdf = (ux, uy) => {
        const vx = ux;
        const vy = h - uy; // 看上去的左上角原点、往下
        if (rot === 90) return { x: box.x + vy, y: box.y + vx };
        if (rot === 180) return { x: box.x + W - vx, y: box.y + vy };
        if (rot === 270) return { x: box.x + W - vy, y: box.y + H - vx };
        return { x: box.x + vx, y: box.y + H - vy };
    };
    return { w, h, rot, toPdf };
}

// 表单里有哪些可以填的：名字、种类、现在的值、选项、在哪一页的哪个位置（PDF 坐标）。
async function fieldsOf(bytes) {
    let doc;
    try { doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }); } catch (_) { return []; }
    let form;
    try { form = doc.getForm(); } catch (_) { return []; }
    const pages = doc.getPages();
    const out = [];
    for (const field of form.getFields()) {
        let type = '';
        let value = '';
        let options = [];
        if (field instanceof PDFTextField) { type = 'text'; value = field.getText() || ''; }
        else if (field instanceof PDFCheckBox) { type = 'check'; value = field.isChecked(); }
        else if (field instanceof PDFDropdown || field instanceof PDFOptionList) { type = 'choice'; options = field.getOptions(); value = field.getSelected()[0] || ''; }
        else if (field instanceof PDFRadioGroup) { type = 'radio'; options = field.getOptions(); value = field.getSelected() || ''; }
        else continue;
        const widgets = field.acroField.getWidgets().map((widget) => {
            const rect = widget.getRectangle();
            const ref = widget.P?.();
            let page = ref ? pages.findIndex((item) => item.ref === ref) : -1;
            if (page < 0) {
                const own = doc.context.getObjectRef?.(widget.dict);
                page = pages.findIndex((item) => (item.node.Annots()?.asArray?.() || []).some((annot) => annot === own));
            }
            return { page, x: rect.x, y: rect.y, w: rect.width, h: rect.height };
        }).filter((widget) => widget.page >= 0);
        if (widgets.length) out.push({ name: field.getName(), type, value, options, widgets, readOnly: field.isReadOnly() });
    }
    return out;
}

module.exports = { apply, fieldsOf };
