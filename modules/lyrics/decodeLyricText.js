'use strict';

// 本地 .lrc 不一定是 UTF-8：老歌词站下的多是 GBK，Windows 记事本「Unicode」存的是 UTF-16。
// 按 BOM → 严格 UTF-8 → GB18030 的顺序解码，并去掉开头的 BOM（不然第一行时间标签认不出）。
function decodeLyricText(buffer) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return bytes.subarray(3).toString('utf8');
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
        try {
            return new TextDecoder('gb18030').decode(bytes);
        } catch (error) {
            return bytes.toString('utf8');
        }
    }
}

module.exports = { decodeLyricText };
