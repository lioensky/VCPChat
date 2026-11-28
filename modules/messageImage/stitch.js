'use strict';

// 把几张位图竖着拼成一张。位图是 nativeImage.toBitmap() 的格式（每像素 4 字节，B、G、R、A），
// 拼好的交给 nativeImage.createFromBitmap。不依赖 Electron，测试直接用。
// 拼在主进程而不是页面的画布上：画布单边上限约 32767 像素，几条长回复就超了。

const MAX_PIXELS = 80_000_000; // 约 320 MB；页面按这个上限算缩放（renderer/index.js 的 MAX_PIXELS 同值）

// gaps：可选，逐个接缝的间隔（长消息分段画时，同一条消息的段与段之间是 0）；不给就都用 gap。
function stitchBitmaps(parts, { gap = 0, gaps = null, pad = 0, background = [0, 0, 0] } = {}) {
    const list = (Array.isArray(parts) ? parts : []).filter((part) => part && part.width > 0 && part.height > 0);
    if (!list.length) throw new Error('没有可拼的图。');
    for (const part of list) {
        if (part.data.length < part.width * part.height * 4) throw new Error('位图数据不完整。');
    }
    const between = (index) => (Array.isArray(gaps) && Number.isFinite(gaps[index]) ? gaps[index] : gap);
    const width = Math.max(...list.map((part) => part.width)) + pad * 2;
    let height = list.reduce((sum, part) => sum + part.height, 0) + pad * 2;
    for (let index = 0; index < list.length - 1; index += 1) height += between(index);
    if (width * height > MAX_PIXELS) throw new Error('图太大了，少选几条再试。');

    const [red, green, blue] = background.map((value) => Math.max(0, Math.min(255, Math.round(Number(value) || 0))));
    const data = Buffer.alloc(width * height * 4);
    data.fill(Buffer.from([blue, green, red, 255]));
    let top = pad;
    for (const [index, part] of list.entries()) {
        const rowBytes = part.width * 4;
        for (let row = 0; row < part.height; row += 1) {
            part.data.copy(data, ((top + row) * width + pad) * 4, row * rowBytes, (row + 1) * rowBytes);
        }
        top += part.height + between(index);
    }
    return { width, height, data };
}

module.exports = { stitchBitmaps, MAX_PIXELS };
