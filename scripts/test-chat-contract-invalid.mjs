import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'scripts/fixtures/chat-contract-invalid.mjs');
const result = spawnSync(process.execPath, [fixture], { cwd: root, encoding: 'utf8' });
assert.notEqual(result.status, 0, 'deliberately invalid contract unexpectedly passed');
assert.match(`${result.stderr}\n${result.stdout}`, /terminal declaration mismatch/);
const tempContracts = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vcpchat-contract-invalid-')), 'contracts.json');
const validContracts = JSON.parse(fs.readFileSync(path.join(root, 'docs/contracts/chat-contracts.json'), 'utf8'));
validContracts[0] = { ...validContracts[0], evidence: ['controlled skipped evidence'] };
fs.writeFileSync(tempContracts, JSON.stringify(validContracts));
const statusResult = spawnSync(process.execPath, ['scripts/check-chat-contracts.mjs'], {
    cwd: root,
    env: { ...process.env, VCPCHAT_CONTRACTS_INPUT: tempContracts },
    encoding: 'utf8',
});
assert.notEqual(statusResult.status, 0, 'pass contract with skipped evidence unexpectedly passed');
assert.match(`${statusResult.stderr}\n${statusResult.stdout}`, /cannot declare pass/);
const malformed = validContracts.map(entry => entry.id === 'facade.main-chat-commands'
    ? { ...entry, id: 'INVALID ID', owner: '' }
    : entry);
fs.writeFileSync(tempContracts, JSON.stringify(malformed));
const malformedResult = spawnSync(process.execPath, ['scripts/check-chat-contracts.mjs'], {
    cwd: root,
    env: { ...process.env, VCPCHAT_CONTRACTS_INPUT: tempContracts },
    encoding: 'utf8',
});
assert.notEqual(malformedResult.status, 0, 'malformed contract unexpectedly passed');
assert.match(`${malformedResult.stderr}\n${malformedResult.stdout}`, /has invalid id|requires a non-empty owner/);
console.log('Chat contract deliberate invalid runner passed (invalid contract failed through a real Node entry).');
