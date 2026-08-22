import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commands = [
    ['scripts/check-chat-contracts.mjs'],
    ['scripts/run-chat-contract-invariants.mjs'],
    ['scripts/test-chat-contract-invalid.mjs'],
    ['scripts/test-facade-registry-invalid.mjs'],
    ['scripts/test-artifact-plane-invalid.mjs'],
    ['scripts/test-packaged-artifact-invalid.mjs'],
    ['scripts/check-artifact-plane.mjs'],
    ['scripts/test-built-artifact-smoke.mjs'],
    ['scripts/test-packaged-artifact-smoke.mjs'],
    ['scripts/test-chat-transcript-snapshot.mjs'],
    ['scripts/test-chat-evidence-manifest.mjs'],
    ['scripts/test-chat-release-evidence-invalid.mjs'],
];
for (const args of commands) {
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
}
console.log('Chat evidence gate passed (contracts, invariants, invalid runner, artifact plane and transcript snapshot).');
