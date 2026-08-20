import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findPackagedExecutable } from '../scripts/vcpchat-packed-smoke.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveProjectStateRoot } = require('../modules/bootstrap/launch-protocol');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vcpchat-platform-')); }
function touch(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'); }

test('H4 packaged executable discovery preserves spaces, unicode and nested helper exclusion', () => {
    const root = tempDir();
    touch(path.join(root, 'mac-arm64', 'VCP 聊天客户端.app', 'Contents', 'Frameworks', 'Electron Helper'));
    const app = path.join(root, 'mac-arm64', 'VCP 聊天客户端.app', 'Contents', 'MacOS', 'VCP聊天客户端');
    touch(app);
    assert.equal(findPackagedExecutable(root, 'darwin'), app);
});

test('H4 packaged executable discovery handles Windows and Linux bundle layouts', () => {
    const root = tempDir();
    const win = path.join(root, 'win-unpacked', 'VCP Chat 长路径.exe');
    const linux = path.join(root, 'linux-unpacked', 'vcp-chat');
    touch(win); touch(linux);
    assert.equal(findPackagedExecutable(root, 'win32'), win);
    assert.equal(findPackagedExecutable(root, 'linux'), linux);
});

test('H4 project profiles remain isolated for long unicode roots across platform policies', () => {
    const longRoot = `/Users/test/${'中文与空格/'.repeat(30)}project`;
    const mac = resolveProjectStateRoot({ projectRoot: longRoot, platform: 'darwin', homeDirectory: '/Users/test', env: {} });
    const win = resolveProjectStateRoot({ projectRoot: longRoot, platform: 'win32', homeDirectory: 'C:/Users/test', env: {} });
    assert.notEqual(mac, win);
    assert.match(mac, /bootstrap-[a-f0-9]{16}$/);
    assert.match(win, /bootstrap-[a-f0-9]{16}$/);
});
