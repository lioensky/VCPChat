'use strict';
// 往 PDF 里写中文要嵌一个中文字体（按用到的字嵌，文件不会大多少）。仓库里的 MiSans 是网页分包（188 个 woff2），嵌不进去，
// 所以找系统里的：Windows 微软雅黑（msyh.ttc）、等线（Deng.ttf）、黑体（simhei.ttf）、宋体（simsun.ttc）；Linux 文泉驿、思源；macOS 苹方。
// .ttc 是字体集（几个字体打包在一个文件里），pdf-lib 只认单个字体，这里把第一个字体拆出来（表照抄，重算偏移）。
// 都找不到时回 null，页面会把中文字画成图片嵌进去（看得见、选不中）。
const fs = require('fs');
const path = require('path');

let cached;

function candidates() {
    if (process.platform === 'win32') {
        const fonts = path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'Fonts');
        return ['msyh.ttc', 'Deng.ttf', 'simhei.ttf', 'msyh.ttf', 'simsun.ttc'].map((name) => path.join(fonts, name));
    }
    if (process.platform === 'darwin') return ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Light.ttc', '/Library/Fonts/Arial Unicode.ttf'];
    return [
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
        '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
        '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
    ];
}

// 从 .ttc 里拆出第 index 个字体，拼成一个单独的 .ttf / .otf。
function fromCollection(bytes, index = 0) {
    if (bytes.toString('ascii', 0, 4) !== 'ttcf') return bytes;
    const count = bytes.readUInt32BE(8);
    if (index >= count) throw new Error('字体集里没有这个字体。');
    const start = bytes.readUInt32BE(12 + index * 4);
    const tables = bytes.readUInt16BE(start + 4);
    const records = [];
    for (let k = 0; k < tables; k += 1) {
        const at = start + 12 + k * 16;
        records.push({ tag: bytes.subarray(at, at + 4), checksum: bytes.readUInt32BE(at + 4), offset: bytes.readUInt32BE(at + 8), length: bytes.readUInt32BE(at + 12) });
    }
    const headerSize = 12 + tables * 16;
    let size = headerSize;
    for (const record of records) size += (record.length + 3) & ~3;
    const out = Buffer.alloc(size);
    bytes.copy(out, 0, start, start + 12); // sfnt 版本和表的数目照抄
    let cursor = headerSize;
    records.forEach((record, k) => {
        const at = 12 + k * 16;
        record.tag.copy(out, at);
        out.writeUInt32BE(record.checksum, at + 4);
        out.writeUInt32BE(cursor, at + 8);
        out.writeUInt32BE(record.length, at + 12);
        bytes.copy(out, cursor, record.offset, record.offset + record.length);
        cursor += (record.length + 3) & ~3;
    });
    return out;
}

// { bytes, file } 或 null。只找一次。
function cjkFont() {
    if (cached !== undefined) return cached;
    cached = null;
    for (const file of candidates()) {
        try {
            if (!fs.existsSync(file)) continue;
            cached = { bytes: fromCollection(fs.readFileSync(file)), file };
            break;
        } catch (_) { /* 下一个 */ }
    }
    return cached;
}

module.exports = { cjkFont, fromCollection, _reset: () => { cached = undefined; } };
