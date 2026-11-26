// GBK 字节被当成 Latin-1 读出来的标签（「ÖÜ½ÜÂ×」）修回汉字；正常的西文重音名字不动。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repairTagText, repairTrackTags } = require('../modules/musicTagText');
const { scanFolder } = require('../modules/musicLibraryScanner');

const asLatin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const JAY = asLatin1([0xd6, 0xdc, 0xbd, 0xdc, 0xc2, 0xd7]); // GBK「周杰伦」
const SUNNY = asLatin1(new TextEncoder().encode('晴天')); // 标成 Latin-1 的 UTF-8

test('GBK or UTF-8 bytes read as Latin-1 are repaired; real Latin-1 names are left alone', () => {
    assert.equal(repairTagText(JAY), '周杰伦');
    assert.equal(repairTagText(SUNNY), '晴天');
    for (const name of ['Beyoncé', 'Sigur Rós', 'Mötley Crüe', 'Ångström', 'Café del Mar', 'naïve', 'plain', '周杰伦', '', undefined]) {
        assert.equal(repairTagText(name), name);
    }
    const track = { path: 'a.mp3', title: 'ok', artist: JAY };
    const fixed = repairTrackTags(track);
    assert.notEqual(fixed, track);
    assert.equal(fixed.artist, '周杰伦');
    assert.equal(track.artist, JAY, 'input not mutated');
    const clean = { path: 'b.mp3', title: 'ok' };
    assert.equal(repairTrackTags(clean), clean);
});

test('an unchanged file from an older scan gets its garbled tags repaired without being read again', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'music-tags-'));
    const music = path.join(root, 'music');
    fs.mkdirSync(music);
    const file = path.join(music, '1.mp3');
    fs.writeFileSync(file, 'x'.repeat(16));
    const stat = fs.statSync(file);
    const worker = path.join(root, 'w.js');
    fs.writeFileSync(worker, "require('worker_threads').parentPort.on('message', ({ id, filePath }) => { throw new Error('should not parse ' + filePath); });");
    const known = [{ path: file, title: '1', artist: JAY, size: stat.size, mtimeMs: stat.mtimeMs }];
    const result = await scanFolder({ folderPath: music, coverCachePath: path.join(root, 'c'), workerFile: worker, knownTracks: known });
    assert.equal(result.stats.reused, 1);
    assert.equal(result.tracks[0].artist, '周杰伦');
});

test('the real scanner worker repairs a GBK ID3 tag marked as Latin-1', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'music-id3-'));
    const music = path.join(root, 'music');
    fs.mkdirSync(music);
    const frame = (id, text) => {
        const body = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]); // 编码字节 0 = ISO-8859-1
        const head = Buffer.alloc(10);
        head.write(id, 0, 'latin1');
        head.writeUInt32BE(body.length, 4);
        return Buffer.concat([head, body]);
    };
    const frames = Buffer.concat([frame('TPE1', JAY), frame('TIT2', asLatin1([0xc7, 0xe7, 0xcc, 0xec]))]); // 晴天
    const size = frames.length;
    const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
    const mpegFrame = Buffer.alloc(417); mpegFrame.set([0xff, 0xfb, 0x90, 0x00]);
    fs.writeFileSync(path.join(music, 'a.mp3'), Buffer.concat([header, frames, mpegFrame, mpegFrame, mpegFrame]));
    const result = await scanFolder({ folderPath: music, coverCachePath: path.join(root, 'covers') });
    assert.equal(result.tracks.length, 1, JSON.stringify(result.stats));
    assert.equal(result.tracks[0].artist, '周杰伦');
    assert.equal(result.tracks[0].title, '晴天');
});
