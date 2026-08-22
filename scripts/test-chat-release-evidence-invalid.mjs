import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['scripts/check-chat-release-evidence.mjs'], {
    cwd: root,
    env: { ...process.env },
    encoding: 'utf8',
});
assert.notEqual(result.status, 0, 'release evidence gate unexpectedly passed without evidence inputs');
assert.match(`${result.stderr}\n${result.stdout}`, /missing .*VCPCHAT_SEQUENCE_EVIDENCE_OUTPUT/);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpchat-release-evidence-'));
const write = (name, value) => { const filename = path.join(temp, name); fs.writeFileSync(filename, JSON.stringify(value)); return filename; };
const output = path.join(temp, 'manifest.json');
const env = {
    VCPCHAT_SEQUENCE_EVIDENCE_OUTPUT: write('main.json', { kind: 'electron-main-chat-sequence', requiredEdges: '1/1', coverage: { missingRequiredEdges: [] } }),
    VCPCHAT_UI_APPS_EVIDENCE_OUTPUT: write('apps.json', { kind: 'electron-ui-apps-smoke', passed: 2, total: 2 }),
    VCPCHAT_WINDOWS_MATRIX_EVIDENCE_INPUT: write('matrix.json', { rows: [{ id: 'main', status: 'passed' }] }),
    VCPCHAT_MANUAL_SOAK_EVIDENCE_INPUT: write('soak.json', { status: 'passed' }),
    VCPCHAT_PACKAGED_ARTIFACT_EVIDENCE_INPUT: write('packaged.json', { status: 'passed' }),
};
const passing = spawnSync(process.execPath, ['scripts/check-chat-release-evidence.mjs', output], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
});
assert.equal(passing.status, 0, passing.stderr);
assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).status, 'pass');
console.log('Chat release evidence runner passed (missing evidence rejected and complete evidence accepted).');
