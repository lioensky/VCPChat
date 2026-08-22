import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
    'VCPCHAT_SEQUENCE_EVIDENCE_OUTPUT',
    'VCPCHAT_UI_APPS_EVIDENCE_OUTPUT',
    'VCPCHAT_WINDOWS_MATRIX_EVIDENCE_INPUT',
    'VCPCHAT_MANUAL_SOAK_EVIDENCE_INPUT',
    'VCPCHAT_PACKAGED_ARTIFACT_EVIDENCE_INPUT',
];
const missing = required.filter(name => !process.env[name]);
if (missing.length) {
    console.error(`Chat release evidence gate failed: missing ${missing.join(', ')}`);
    process.exit(1);
}
const output = process.argv[2] || path.join('artifacts', 'contracts', 'chat-release-evidence-manifest.json');
const result = spawnSync(process.execPath, ['scripts/write-chat-evidence-manifest.mjs', output], {
    cwd: root,
    env: { ...process.env, VCPCHAT_REAL_ELECTRON_STATUS: 'pass' },
    encoding: 'utf8',
    stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status || 1);
console.log(`Chat release evidence gate passed (${output}).`);
