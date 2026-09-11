// modules/lyrics/krcDecrypt.js
// Kugou Music KRC lyric decryption and embedded language decoder

const zlib = require('zlib');

const KRC_KEY = [
  0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x6e, 0x2d,
  0x41, 0x70, 0x66, 0x21, 0x5a, 0x53, 0x64, 0x32
];

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

  const decrypted = Buffer.alloc(buffer.length - dataStart);
  for (let i = dataStart; i < buffer.length; i++) {
    decrypted[i - dataStart] = buffer[i] ^ KRC_KEY[(i - dataStart) % KRC_KEY.length];
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
  const match = krcString.match(/\[language:([^\]]*)\]/);
  if (!match) return { translations: [], romanizations: [] };

  try {
    let cleanB64 = match[1].trim();
    while (cleanB64.length % 4 !== 0) {
      cleanB64 += '=';
    }
    const decoded = Buffer.from(cleanB64, 'base64').toString('utf8');
    const obj = JSON.parse(decoded);

    const readEmbeddedTrack = (type) => {
      const track = obj.content?.find(item => item.type === type);
      if (!track || !Array.isArray(track.lyricContent)) return [];
      return track.lyricContent.map(lines => {
        if (Array.isArray(lines)) {
          return lines.join('').trim();
        }
        return String(lines || '').trim();
      });
    };

    return {
      romanizations: readEmbeddedTrack(0),
      translations: readEmbeddedTrack(1)
    };
  } catch (err) {
    return { translations: [], romanizations: [] };
  }
}

module.exports = {
  krcDecrypt,
  decodeKrcLanguageTag
};