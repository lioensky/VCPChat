'use strict';
// 文本文件的编码。文本、代码、Markdown、表格共用。
// 中文 Windows 上老文件常是 GBK，记事本另存的可能是 UTF-16。认出来打开，存回原来的编码和 BOM，别的字节不变。
// 认法：BOM 说了算；没有 BOM 时按 UTF-8 严格解，解不开当 GB18030（GBK 的超集）。带 NUL 的当二进制。
// GB18030 解完再编一遍和原文对不上（文件里有不合法的字节）的也当二进制：这种存回去会改坏。
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
    } catch (_) { /* 往下试 GB18030 */ }
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

// 栏头上写的名字：UTF-8 不写。
const encodingLabel = (encoding) => ({ gb18030: 'GB18030', 'utf-16le': 'UTF-16', 'utf-16be': 'UTF-16' }[encoding] || '');

module.exports = { decodeText, encodeText, encodingLabel };
