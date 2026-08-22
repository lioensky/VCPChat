import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['scripts/check-artifact-plane.mjs'], {
    cwd: root,
    env: {
        ...process.env,
        VCPCHAT_NATIVE_RUNTIME_INPUT: path.join(root, 'artifacts', 'deliberately-missing-runtime.exe'),
        VCPCHAT_REQUIRE_NATIVE_ARTIFACT: '1',
    },
    encoding: 'utf8',
});
assert.notEqual(result.status, 0, 'missing artifact unexpectedly passed artifact-plane gate');
assert.match(`${result.stderr}\n${result.stdout}`, /required native artifact is missing/);
console.log('Artifact-plane deliberate invalid runner passed (missing runtime rejected).');
