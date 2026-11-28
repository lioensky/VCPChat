'use strict';

// 很多中文 MP3 的 ID3 标签其实是 GBK 字节，却标成了 Latin-1，读出来是「ÖÜ½ÜÂ×」这样的乱码。
// 只在看得出是这种情况时才改：字符全在 0x00–0xFF 之内，高位字节全部两两成对且落在 GBK 区间，
// 按 GB18030 解出来有汉字、没有替换符。像「Beyoncé」「Sigur Rós」这种单个重音字母不会被误改。
const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿]/;
const TAG_KEYS = ['title', 'artist', 'album'];

function looksLikeGbkAsLatin1(text) {
    if (typeof text !== 'string') return false;
    const len = text.length;
    let hasHigh = false;
    for (let i = 0; i < len; i += 1) {
        const lead = text.charCodeAt(i);
        if (lead < 0x80) continue;
        if (lead > 0xff) return false;
        hasHigh = true;
        const trail = text.charCodeAt(i + 1);
        if (!(lead >= 0x81 && lead <= 0xfe && trail >= 0x80 && trail <= 0xfe)) return false;
        i += 1;
    }
    return hasHigh;
}

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
let gb18030Fatal = null;
function getGb18030Fatal() {
    if (gb18030Fatal === null) {
        try { gb18030Fatal = new TextDecoder('gb18030', { fatal: true }); } catch (_) { gb18030Fatal = false; }
    }
    return gb18030Fatal;
}

function repairTagText(text) {
    if (!looksLikeGbkAsLatin1(text)) return text;
    const bytes = Buffer.from(text, 'latin1');
    let decoded;
    try {
        decoded = UTF8_FATAL.decode(bytes); // 也可能是标成 Latin-1 的 UTF-8
    } catch (_) {
        const gb = getGb18030Fatal();
        if (!gb) return text;
        try { decoded = gb.decode(bytes); } catch (error) { return text; }
    }
    return CJK.test(decoded) && !decoded.includes('�') ? decoded : text;
}

// 返回修过的新对象；没什么可修就原样返回同一个对象。
function repairTrackTags(track) {
    if (!track || typeof track !== 'object') return track;
    let out = track;
    for (let i = 0; i < TAG_KEYS.length; i += 1) {
        const key = TAG_KEYS[i];
        const fixed = repairTagText(track[key]);
        if (fixed !== track[key]) {
            if (out === track) out = { ...track };
            out[key] = fixed;
        }
    }
    return out;
}

module.exports = { repairTagText, repairTrackTags, looksLikeGbkAsLatin1 };
