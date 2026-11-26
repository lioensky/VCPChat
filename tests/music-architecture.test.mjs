// VMusic 结构守卫：npm run check:music 必须通过（规则见 Musicmodules/AGENTS.md）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (...args) => spawnSync(process.execPath, ['scripts/music-arch.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });

test('music architecture check passes', () => {
    const r = run('check');
    assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('context package resolves modules and files', () => {
    const byModule = run('context', 'dock');
    assert.equal(byModule.status, 0, byModule.stderr);
    assert.match(byModule.stdout, /music-dock\.js/);
    const byFile = run('context', 'music-stage-host.js');
    assert.equal(byFile.status, 0, byFile.stderr);
    assert.match(byFile.stdout, /stage-host/);
    assert.notEqual(run('context', 'no-such-module').status, 0);
});
