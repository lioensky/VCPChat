import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['scripts/test-packaged-artifact-smoke.mjs'], {
    cwd: root,
    env: { ...process.env, VCPCHAT_PACKAGED_ROOT: path.join(root, 'artifacts', 'missing-packaged-root') },
    encoding: 'utf8',
});
assert.notEqual(result.status, 0, 'missing packaged root unexpectedly passed');
assert.match(`${result.stderr}\n${result.stdout}`, /packaged root is missing/);
const sourceResult = spawnSync(process.execPath, ['scripts/test-packaged-artifact-smoke.mjs'], {
    cwd: root,
    env: { ...process.env, VCPCHAT_PACKAGED_ROOT: root },
    encoding: 'utf8',
});
assert.notEqual(sourceResult.status, 0, 'workspace source root was accepted as packaged artifact');
assert.match(`${sourceResult.stderr}\n${sourceResult.stdout}`, /must be separate from the workspace source root/);
console.log('Packaged artifact deliberate invalid runner passed (missing unpacked directory rejected).');
