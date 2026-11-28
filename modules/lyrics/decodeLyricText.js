'use strict';

// 本地 .lrc 不一定是 UTF-8：老歌词站下的多是 GBK，Windows 记事本「Unicode」存的是 UTF-16。
// 按 BOM → 严格 UTF-8 → GB18030 的顺序解码，并去掉开头的 BOM（不然第一行时间标签认不出）。
const UTF16LE = new TextDecoder('utf-16le');
const UTF16BE = new TextDecoder('utf-16be');
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
let gb18030Decoder = null;
function getGb18030() {
    if (gb18030Decoder === null) {
        try { gb18030Decoder = new TextDecoder('gb18030'); } catch (_) { gb18030Decoder = false; }
    }
    return gb18030Decoder;
}

function decodeLyricText(buffer) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return bytes.subarray(3).toString('utf8');
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return UTF16LE.decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return UTF16BE.decode(bytes.subarray(2));
    }
    try {
        return UTF8_FATAL.decode(bytes);
    } catch (_) {
        const gb = getGb18030();
        if (gb) {
            try { return gb.decode(bytes); } catch (_) { /* fall through */ }
        }
        return bytes.toString('utf8');
    }
}

module.exports = { decodeLyricText };
