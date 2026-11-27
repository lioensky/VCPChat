// 上次 VCPChat 被强行结束留下的音频引擎：确认是它才结束，主进程还活着或 PID 被别的程序重用了都不动。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const orphan = require('../modules/services/audioEngineOrphan');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-pid-')), 'audio-engine.pid.json');
const DEAD_OWNER = 2 ** 22 + 12345; // 不会存在的 PID

test('a leftover engine whose owner is gone is ended, and the record removed', async () => {
    const file = tmpFile();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 200));
    orphan.writeRecord(file, { pid: child.pid, ownerPid: DEAD_OWNER, binary: process.execPath });
    const exited = new Promise((r) => child.once('exit', r));
    const result = await orphan.reapOrphan(file, { binaryPath: process.execPath, log: { warn() {} } });
    assert.equal(result.reaped, true);
    await exited;
    assert.equal(fs.existsSync(file), false);
});

test('nothing is ended when the owner is still running, the pid is gone, or the pid belongs to another program', async () => {
    const killed = [];
    const kill = (pid) => killed.push(pid);
    const file = tmpFile();

    orphan.writeRecord(file, { pid: 4242, ownerPid: 7, binary: 'C:\\VCPChat\\audio_engine\\audio_server.exe' });
    assert.equal((await orphan.reapOrphan(file, { alive: () => true, image: async () => 'audio_server.exe', kill })).reason, 'owner-alive');
    assert.equal(fs.existsSync(file), true, 'the record stays for the instance that owns it');

    assert.equal((await orphan.reapOrphan(file, { alive: (pid) => pid !== 4242 && pid !== 7, image: async () => 'audio_server.exe', kill })).reason, 'gone');
    assert.equal(fs.existsSync(file), false);

    orphan.writeRecord(file, { pid: 4242, ownerPid: DEAD_OWNER, binary: 'C:\\VCPChat\\audio_engine\\audio_server.exe' });
    const r = await orphan.reapOrphan(file, { binaryPath: 'C:\\VCPChat\\audio_engine\\audio_server.exe', alive: (pid) => pid === 4242, image: async () => 'chrome.exe', kill });
    assert.equal(r.reason, 'pid-reused');
    assert.deepEqual(killed, []);

    orphan.writeRecord(file, { pid: 4242, ownerPid: DEAD_OWNER });
    const ok = await orphan.reapOrphan(file, { binaryPath: 'C:\\VCPChat\\audio_engine\\audio_server.exe', alive: (pid) => pid === 4242, image: async () => 'audio_server.exe', kill, log: { warn() {} } });
    assert.equal(ok.reaped, true);
    assert.deepEqual(killed, [4242]);
});

test('clearRecord leaves a newer engine\'s record alone', () => {
    const file = tmpFile();
    orphan.writeRecord(file, { pid: 2, ownerPid: 1 });
    orphan.clearRecord(file, 1);
    assert.equal(orphan.readRecord(file).pid, 2);
    orphan.clearRecord(file, 2);
    assert.equal(orphan.readRecord(file), null);
});

test('Windows image name is read from tasklist CSV', async () => {
    const run = (cmd, args, opts, cb) => cb(null, '"audio_server.exe","4242","Console","1","231,004 K"\r\n');
    assert.equal(await orphan.imageName(4242, { platform: 'win32', run }), 'audio_server.exe');
    const none = (cmd, args, opts, cb) => cb(null, 'INFO: No tasks are running which match the specified criteria.\r\n');
    assert.equal(await orphan.imageName(4242, { platform: 'win32', run: none }), null);
});

test('macOS image name is read from ps comm output', async () => {
    const run = (cmd, args, opts, cb) => {
        assert.equal(cmd, 'ps');
        assert.deepEqual(args, ['-p', '4242', '-o', 'comm=']);
        cb(null, '/Applications/VCPChat.app/Contents/Resources/Audio_Server\n');
    };
    assert.equal(await orphan.imageName(4242, { platform: 'darwin', run }), 'audio_server');
    const empty = (cmd, args, opts, cb) => cb(null, '   \n');
    assert.equal(await orphan.imageName(4242, { platform: 'darwin', run: empty }), null);
    const err = (cmd, args, opts, cb) => cb(new Error('ps failed'));
    assert.equal(await orphan.imageName(4242, { platform: 'darwin', run: err }), null);
});
