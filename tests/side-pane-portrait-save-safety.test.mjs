// 立绘保存的数据安全：写盘失败时原来的立绘还在；换扩展名、只差大小写的文件名都只留新的一张
import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const handlers = new Map();
const originalLoad = Module._load;
Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === 'electron') {
        return { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: () => {} } };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const agentHandlers = require('../modules/ipc/agentHandlers.js');
Module._load = originalLoad;
const fsExtra = require('fs-extra');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-portrait-save-'));
const agentDir = path.join(root, 'Agents');
fs.mkdirSync(agentDir);
agentHandlers.initialize({ AGENT_DIR: agentDir, USER_DATA_DIR: path.join(root, 'UserData'), settingsManager: {} });
const save = (id, variant, type, bytes) => handlers.get('save-agent-portrait')({}, id, variant, { type, buffer: Buffer.from(bytes) });

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('a failed write keeps the portrait that was there and leaves no temp file', async () => {
    const dir = path.join(agentDir, 'Nova');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'portrait.png'), 'old portrait');

    const originalWriteFile = fsExtra.writeFile;
    fsExtra.writeFile = async () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); };
    try {
        const result = await save('Nova', 'default', 'image/jpeg', 'new portrait');
        assert.match(result.error, /no space left/);
    } finally {
        fsExtra.writeFile = originalWriteFile;
    }
    assert.deepEqual(fs.readdirSync(dir), ['portrait.png']);
    assert.equal(fs.readFileSync(path.join(dir, 'portrait.png'), 'utf8'), 'old portrait');
});

test('a new image replaces the other extensions and case spellings of the same version', async () => {
    const dir = path.join(agentDir, 'Coco');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'portrait.light.webp'), 'old webp');
    fs.writeFileSync(path.join(dir, 'Portrait.Light.PNG'), 'old upper');
    fs.writeFileSync(path.join(dir, 'portrait.png'), 'default stays');

    const result = await save('Coco', 'light', 'image/png', 'new light');
    assert.equal(result.success, true);
    const names = fs.readdirSync(dir).sort();
    const light = names.filter(name => /^portrait\.light\./i.test(name));
    assert.equal(light.length, 1, names.join(', '));
    assert.equal(fs.readFileSync(path.join(dir, light[0]), 'utf8'), 'new light');
    assert.equal(fs.readFileSync(path.join(dir, 'portrait.png'), 'utf8'), 'default stays');
    assert.ok(!names.some(name => name.endsWith('.tmp')));
    assert.match(result.portraits.light, /portrait\.light\.png\?v=\d+$/i);
});
