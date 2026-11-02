'use strict';
// 文本文件的编码识别，文本、代码、Markdown、表格共用。
// 中文 Windows 上的旧文件常为 GBK，记事本另存的可能为 UTF-16。识别后打开，保存时还原原来的编码和 BOM，其余字节不变。
// 规则：有 BOM 时以 BOM 为准；没有 BOM 时按 UTF-8 严格解码，失败则按 GB18030（GBK 的超集）解码。含 NUL 的视为二进制。
// GB18030 解码后重新编码与原文不一致（文件中有非法字节）的也视为二进制，避免保存时损坏文件。
const iconv = require('iconv-lite');

function notText() {
    return new Error('这个文件不是文本。');
}

function decodeText(bytes) {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8', bom: true };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: iconv.decode(bytes.subarray(2), 'utf-16le'), encoding: 'utf-16le', bom: true };
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: iconv.decode(bytes.subarray(2), 'utf-16be'), encoding: 'utf-16be', bom: true };
    if (bytes.includes(0)) throw notText();
    try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', bom: false };
    } catch (_) { /* 改按 GB18030 解码 */ }
    const text = iconv.decode(bytes, 'gb18030');
    if (!iconv.encode(text, 'gb18030').equals(bytes)) throw notText();
    return { text, encoding: 'gb18030', bom: false };
}

function encodeText(text, { encoding = 'utf-8', bom = false } = {}) {
    const body = encoding === 'utf-8' ? Buffer.from(text, 'utf8') : iconv.encode(text, encoding);
    if (!bom) return body;
    const mark = { 'utf-8': [0xef, 0xbb, 0xbf], 'utf-16le': [0xff, 0xfe], 'utf-16be': [0xfe, 0xff] }[encoding] || [];
    return Buffer.concat([Buffer.from(mark), body]);
}

// 界面上显示的编码名称；UTF-8 不显示。
const encodingLabel = (encoding) => ({ gb18030: 'GB18030', 'utf-16le': 'UTF-16', 'utf-16be': 'UTF-16' }[encoding] || '');

module.exports = { decodeText, encodeText, encodingLabel };
