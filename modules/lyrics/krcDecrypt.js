// modules/lyrics/krcDecrypt.js
// Kugou Music KRC lyric decryption and embedded language decoder

const zlib = require('zlib');

const KRC_KEY = Uint8Array.from([
  0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x6e, 0x2d,
  0x41, 0x70, 0x66, 0x21, 0x5a, 0x53, 0x64, 0x32
]);
const KRC_LANG_TAG_RE = /\[language:([^\]]*)\]/;

/**
 * Decrypts Kugou KRC buffer.
 * Header 'krc1' (4 bytes) followed by XOR encrypted zlib deflate stream.
 */
function decryptKrcBuffer(buffer) {
  if (!buffer || buffer.length < 4) {
    throw new Error('Buffer too small for KRC');
  }

  // Check magic header 'krc1'
  const isKrcMagic = buffer[0] === 0x6b && buffer[1] === 0x72 && buffer[2] === 0x63 && buffer[3] === 0x31;
  const dataStart = isKrcMagic ? 4 : 0;

  const len = buffer.length - dataStart;
  const decrypted = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) {
    decrypted[i] = buffer[dataStart + i] ^ KRC_KEY[i & 15];
  }

  try {
    const uncompressed = zlib.inflateSync(decrypted);
    return uncompressed.toString('utf8');
  } catch (err) {
    // Try raw inflate
    const uncompressedRaw = zlib.inflateRawSync(decrypted);
    return uncompressedRaw.toString('utf8');
  }
}

/**
 * Decrypts base64 or Buffer KRC payload.
 */
function krcDecrypt(content) {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    // If it's already plain text KRC with line brackets, return directly
    if (trimmed.startsWith('[') && trimmed.includes('<')) {
      return trimmed;
    }
    const buf = Buffer.from(trimmed, 'base64');
    return decryptKrcBuffer(buf);
  } else if (Buffer.isBuffer(content)) {
    return decryptKrcBuffer(content);
  }
  throw new Error('Unsupported KRC input type');
}

/**
 * Decodes the embedded [language:base64...] tag in KRC lyrics,
 * which carries translations and romanization.
 */
function decodeKrcLanguageTag(krcString) {
  if (typeof krcString !== 'string' || !krcString || krcString.indexOf('[language:') === -1) return { translations: [], romanizations: [] };
  const match = KRC_LANG_TAG_RE.exec(krcString);
  if (!match) return { translations: [], romanizations: [] };

  try {
    let cleanB64 = match[1].trim();
    while (cleanB64.length % 4 !== 0) {
      cleanB64 += '=';
    }
    const decoded = Buffer.from(cleanB64, 'base64').toString('utf8');
    const obj = JSON.parse(decoded);
    const content = Array.isArray(obj?.content) ? obj.content : [];

    const extractLines = (lyricContent) => {
      if (!Array.isArray(lyricContent)) return [];
      const out = new Array(lyricContent.length);
      for (let i = 0; i < lyricContent.length; i += 1) {
        const lines = lyricContent[i];
        out[i] = Array.isArray(lines) ? lines.join('').trim() : String(lines || '').trim();
      }
      return out;
    };

    let romanTrack = null;
    let transTrack = null;
    for (let i = 0; i < content.length; i += 1) {
      const item = content[i];
      if (!item) continue;
      if (!romanTrack && item.type === 0) romanTrack = item;
      else if (!transTrack && item.type === 1) transTrack = item;
      if (romanTrack && transTrack) break;
    }

    return {
      romanizations: romanTrack ? extractLines(romanTrack.lyricContent) : [],
      translations: transTrack ? extractLines(transTrack.lyricContent) : []
    };
  } catch (err) {
    return { translations: [], romanizations: [] };
  }
}

module.exports = {
  krcDecrypt,
  decodeKrcLanguageTag
};